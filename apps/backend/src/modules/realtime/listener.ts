/**
 * The read side of the realtime outbox (D221): one connection per process,
 * outside the pool, reading the events every process on the database has
 * committed and delivering them to this process's viewers and waits through
 * the hub.
 *
 * **When it reads.** When this process has committed an event (`committed`
 * pokes it), at the end of a window of `COALESCE_MS`, 20 ms, that the first
 * poke opens and every poke until its end joins, so that the commits inside
 * one window cause one read (#260); when a notification arrives on
 * `REALTIME_CHANNEL` from another process (whatever it carries: a
 * notification means "read"), at once; and once a second whatever happens.
 * One read at a time; a read asked for during a read makes one more after
 * it.
 *
 * **What a read is** (`READ_SQL`): one statement, so one snapshot, returning
 * the snapshot's horizon - every transaction below it has committed or rolled
 * back - and every row whose transaction is at or above the horizon the
 * previous read returned, in id order, without payloads. A row not read
 * before is marked seen; a `close` closes the session's connections here
 * (D198); a row someone on this process wants (`RealtimeHub.wants`) has its
 * payload fetched, by id, in batches; any other row is passed over, since
 * whoever registers from now on registers after its commit and reads that
 * commit's effect itself - a viewer's reload, a wait's first read. Who wants
 * a row is judged on the session's registrations as the read returned
 * (`RealtimeHub.snapshot`), and what was fetched is delivered to those of
 * them still registered, in id order, closes in their place. A wanted
 * `request.received` a deletion purged meanwhile makes them read the session
 * again (`RealtimeHub.reload`). The floor becomes the horizon, and the seen
 * marks below it are forgotten.
 *
 * Every committed row is returned by the first read whose snapshot sees it: a
 * transaction still in progress holds the horizon below its own id, so its
 * rows are never under the floor when they appear, and a transaction that
 * rolled back leaves nothing to wait for. Ids order the events: an event that
 * must follow another is inserted after that other committed (`events.ts`).
 *
 * **A channel that may have missed something is never used as if it had
 * not.** There is no catch-up: when the connection errors or ends, when any
 * statement on it is not answered within 5 s, when no read has completed for
 * more than 5 s at a tick, when a wanted row is gone at its fetch, or when
 * more than `MAX_SEEN_EVENTS` rows are marked seen or more than
 * `MAX_WANTED_EVENTS` wanted events wait in one read, the hub is deafened:
 * every connection of the process is cut, and its viewer reconnects and
 * reloads (D077), and every wait is answered as at shutdown (D200). The
 * listener connects again after 250 ms, doubling to 5 s while attempts fail,
 * listens, and reads once with no floor, marking every row seen and
 * delivering none, before the hub hears again. The viewer's reload is the
 * catch-up.
 *
 * It also wakes the other processes after this one commits (`wake`), on
 * either of its pools (D244), at the end of a window of its own, as a poke
 * reads, so that the commits inside one window cause one wake-up (#260); the
 * process woken reads at once, so an event of any process reaches every
 * viewer at most one window later than it did without one. And it deletes
 * the outbox rows nobody can need any more, every 5 s, through the API's
 * pool, vacuuming the table after a prune that deleted much.
 */
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { WsCloseCode } from '@webhook-inspector/shared';
import { applicationConnectionSettings } from '../../db/pool.ts';
import {
  observeCommits,
  PRUNE_REALTIME_EVENTS_SQL,
  REALTIME_CHANNEL,
  REALTIME_EVENT_RETENTION_SECONDS,
  REALTIME_VACUUM_AFTER_BYTES,
  VACUUM_REALTIME_EVENTS_SQL,
  type CommitObserver,
} from './events.ts';
import type { RealtimeHub, SessionSnapshot } from './hub.ts';

/**
 * The read: the horizon of its own snapshot, and every row at or above the
 * floor `$1`, in id order. The `LEFT JOIN` returns the horizon when there is
 * no row.
 */
export const READ_SQL = `WITH snap AS (SELECT pg_current_snapshot() AS s)
       SELECT pg_snapshot_xmin(snap.s)::text AS horizon,
              e.id::text AS id, e.tx::text AS tx, e.kind, e.session_id, e.created_at
         FROM snap LEFT JOIN realtime_events AS e ON e.tx >= $1::xid8
        ORDER BY e.id`;

/** The payloads of the wanted rows of one batch. */
export const FETCH_SQL =
  'SELECT id::text AS id, payload FROM realtime_events WHERE id = ANY($1::bigint[])';

/**
 * The wake-up: a notification in a transaction of its own that writes no WAL
 * before its commit, and with `synchronous_commit` off, so it waits for no
 * flush and holds PostgreSQL's notify lock for no flush either (D221).
 */
export const WAKE_SQL = `SELECT set_config('synchronous_commit', 'off', true), pg_notify('${REALTIME_CHANNEL}', '')`;

/**
 * What the listening connection is opened with: keep-alive, a deadline for
 * connecting, and the idle-in-transaction timeout every application
 * connection asks for (`applicationConnectionSettings`, D221). Each of its
 * statements is a transaction of its own, so the timeout never ends it; it is
 * there so that no connection of the application can hold a transaction open
 * without bound.
 */
export function listenerClientConfig(
  connectionString: string,
  connectionTimeoutMillis: number,
): pg.ClientConfig {
  return {
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis,
    ...applicationConnectionSettings(),
  };
}

/** At most this many rows are marked seen; more is a lost channel (D221). */
export const MAX_SEEN_EVENTS = 100_000;
/** At most this many wanted events wait to be delivered in one read; more is a lost channel. */
export const MAX_WANTED_EVENTS = 10_000;

/** How often a read runs whatever happens. */
const TICK_MS = 1_000;
/**
 * How long a poke waits before its read, and a wake-up before it is sent,
 * for the commits after it to join them: the commits inside one window cause
 * one read and one wake-up (#260). The issue's bound is 20 ms, well under
 * what a person sees in the request list.
 */
export const COALESCE_MS = 20;
/** How long any statement on the connection may take before the channel counts as lost. */
export const QUERY_DEADLINE_MS = 5_000;
/** How long the process may go without a completed read before the channel counts as lost. */
const READ_STALE_MS = 5_000;
/** A row first seen this long after it was written is reported. */
const LATE_ROW_MS = 10_000;
/** Payloads fetched in one statement. */
const FETCH_BATCH = 32;
/** The first wait before connecting again, and the longest. */
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;
/** How often outbox rows nobody can need are deleted. */
const PRUNE_INTERVAL_MS = 5_000;
/** At most one warning a minute of each kind. */
const WARNING_INTERVAL_MS = 60_000;

/** What the listener reports to: the application listener's log. */
export interface ListenerLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface ListenerOptions {
  connectionString: string;
  hub: RealtimeHub;
  log: ListenerLog;
  /**
   * The process's pool, the API's: `committed` finds this listener through
   * it, and the prune runs on it.
   */
  pool: Pick<pg.Pool, 'query'>;
  /**
   * The process's other pools, capture's own (D244): `committed` finds this
   * listener through each of them too, so that a capture's commit wakes it.
   */
  otherPools?: readonly object[];
  /** The limits above, smaller in a test that reaches them. */
  tickMs?: number;
  /** `COALESCE_MS`, longer in a test that commits many times inside one window. */
  coalesceMs?: number;
  queryDeadlineMs?: number;
  readStaleMs?: number;
  lateRowMs?: number;
  maxSeen?: number;
  maxWanted?: number;
  fetchBatch?: number;
  firstRetryMs?: number;
  maxRetryMs?: number;
  pruneEveryMs?: number;
  /** `REALTIME_EVENT_RETENTION_SECONDS`, shorter in a test of the prune. */
  retentionSeconds?: number;
  /** Awaited before each new connection after a loss: a test holds it. */
  beforeReconnect?: () => Promise<void>;
  /** Awaited between a read and the fetch of its wanted payloads: a test acts there. */
  beforeFetch?: (ids: string[]) => Promise<void>;
  /**
   * Awaited inside each statement's deadline, before the statement is sent: a
   * test delays it, as a connection that stops answering would.
   */
  beforeStatement?: (text: string) => Promise<void>;
}

/** One row of a read, as it waits to be delivered. */
interface Unseen {
  id: string;
  kind: string;
  session: string;
}

/** The part of a pg client a lost channel destroys; not in pg's types. */
interface WithStream {
  connection?: { stream?: { destroy(): void } };
}

/** A read the channel was lost under; the loss is reported where it was found. */
class LostChannel extends Error {}

/** A `flush` waiting for the read numbered `target` to complete. */
interface Flush {
  target: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class RealtimeListener implements CommitObserver {
  readonly #options: ListenerOptions;
  readonly #hub: RealtimeHub;
  readonly #queryDeadlineMs: number;
  readonly #coalesceMs: number;

  /** Moves on every connection attempt and every loss: what an older one does afterwards is ignored. */
  #generation = 0;
  #state: 'idle' | 'connecting' | 'listening' | 'lost' | 'stopped' = 'idle';
  #client: pg.Client | null = null;
  /** The horizon the last read returned: the next read's floor. */
  #floor = '0';
  /** Rows read since the floor's transaction, by id, with their transaction. */
  #seen = new Map<string, bigint>();
  /** The generation whose read is under way, if any, and whether it is to run once more. */
  #reading: number | null = null;
  #again = false;
  #readsStarted = 0;
  #readsCompleted = 0;
  #fetches = 0;
  #lastReadAt = 0;
  #flushes: Flush[] = [];
  #waking = false;
  #wakeAgain = false;
  /** The window a poke opened, until its read is asked for (`COALESCE_MS`). */
  #pokeWindow: NodeJS.Timeout | undefined;
  /** The windows of pokes that ended and asked for a read (`windowsEnded`). */
  #windowsEnded = 0;
  /** The window a wake-up asked for opened, until it is sent. */
  #wakeWindow: NodeJS.Timeout | undefined;
  #retryDelay = 0;
  #retryTimer: NodeJS.Timeout | undefined;
  #tickTimer: NodeJS.Timeout | undefined;
  #pruneTimer: NodeJS.Timeout | undefined;
  #pruning: Promise<void> | null = null;
  /** The floor at each of the last prunes: a prune uses the one of two prunes earlier. */
  #pruneHorizons: (string | null)[] = [];
  /** Whether the last prune deleted `REALTIME_VACUUM_AFTER_BYTES` of payload or more. */
  #lastPruneLarge = false;
  #lastWarnings = new Map<string, number>();
  /** While set, a read waits for it before it starts (`holdReads`, for tests). */
  #readHold: Promise<void> | null = null;
  #listenedOnce = false;
  #reportListened: () => void = () => undefined;
  readonly #firstListen = new Promise<void>((resolve) => {
    this.#reportListened = resolve;
  });

  constructor(options: ListenerOptions) {
    this.#options = options;
    this.#hub = options.hub;
    this.#queryDeadlineMs = options.queryDeadlineMs ?? QUERY_DEADLINE_MS;
    this.#coalesceMs = options.coalesceMs ?? COALESCE_MS;
  }

  /**
   * Starts reading, waking and pruning. The hub is deaf until the first read:
   * nothing could be delivered to a connection registered before it.
   */
  start(): void {
    if (this.#state !== 'idle') {
      return;
    }

    this.#hub.deafen();

    for (const pool of this.#pools()) {
      observeCommits(pool, this);
    }

    this.#startPruning();
    void this.#connect();
  }

  /** Whether the connection is listening and reading now. */
  get listening(): boolean {
    return this.#state === 'listening';
  }

  /**
   * Whether it has listened at least once since `start`. `/readyz` answers
   * `503` until it has, and ignores it afterwards, so a lost channel never
   * takes the pod out of the Service (D086, D221).
   */
  get listenedOnce(): boolean {
    return this.#listenedOnce;
  }

  /** Resolves once the first baseline read has completed. */
  whenListening(): Promise<void> {
    return this.#firstListen;
  }

  /** The server process of the listening connection, which a test terminates; `null` while there is none. */
  get processId(): number | null {
    return (this.#client as { processID?: number | null } | null)?.processID ?? null;
  }

  /** The floor the next read uses. Exists for tests and diagnostics. */
  get floor(): string {
    return this.#floor;
  }

  /** Rows marked seen. Exists for tests and diagnostics. */
  get seenCount(): number {
    return this.#seen.size;
  }

  /** Payload fetches run since `start`. Exists for tests and diagnostics. */
  get fetches(): number {
    return this.#fetches;
  }

  /** Reads completed since `start`, the baselines not counted. Exists for tests and diagnostics. */
  get reads(): number {
    return this.#readsCompleted;
  }

  /**
   * Whether a window a poke or a wake-up opened has yet to end
   * (`COALESCE_MS`). Exists for tests and diagnostics.
   */
  get windowOpen(): boolean {
    return this.#pokeWindow !== undefined || this.#wakeWindow !== undefined;
  }

  /**
   * The windows of this process's commits that have ended since `start`,
   * each asking for one read: the reads its commits caused, apart from those
   * a notification or a tick asked for. Exists for tests and diagnostics.
   */
  get windowsEnded(): number {
    return this.#windowsEnded;
  }

  /**
   * Holds every read until the returned function is called, the reads asked
   * for meanwhile then running as one. For tests that need something to
   * happen before what has committed is delivered; the tick's staleness check
   * still runs, so a hold must stay well under 5 s.
   */
  holdReads(): () => void {
    let release: () => void = () => undefined;

    this.#readHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    return () => {
      this.#readHold = null;
      release();
    };
  }

  /**
   * Reads at the end of the window this poke opens, or the one already open
   * (`committed`, `COALESCE_MS`): every poke inside one window is answered
   * by one read, which starts after each of them - or once more after the
   * read under way, when the window ends during one.
   */
  poke(): void {
    if (this.#state !== 'listening' || this.#pokeWindow !== undefined) {
      return;
    }

    const generation = this.#generation;

    this.#pokeWindow = setTimeout(() => {
      this.#pokeWindow = undefined;

      if (generation === this.#generation && this.#state === 'listening') {
        this.#windowsEnded += 1;
        void this.#read(generation);
      }
    }, this.#coalesceMs);
    this.#pokeWindow.unref();
  }

  /**
   * Wakes the other processes (`committed`) at the end of the window this
   * call opens, or the one already open, as `poke` reads: one wake-up for
   * every commit inside one window. One wake-up at a time on this
   * connection, and one more after it when a window ended meanwhile, so a
   * wake-up always starts after every commit that asked for one.
   */
  wake(): void {
    if (this.#state !== 'listening' || this.#wakeWindow !== undefined) {
      return;
    }

    const generation = this.#generation;

    this.#wakeWindow = setTimeout(() => {
      this.#wakeWindow = undefined;

      if (generation !== this.#generation || this.#state !== 'listening') {
        return;
      }

      if (this.#waking) {
        this.#wakeAgain = true;

        return;
      }

      this.#waking = true;
      void this.#sendWakeUps(generation);
    }, this.#coalesceMs);
    this.#wakeWindow.unref();
  }

  /** Reads now, or once more after the read under way: no window. */
  #readNow(): void {
    if (this.#state === 'listening') {
      void this.#read(this.#generation);
    }
  }

  /** Ends the windows open, asking for nothing: a loss or a stop. */
  #closeWindows(): void {
    clearTimeout(this.#pokeWindow);
    clearTimeout(this.#wakeWindow);
    this.#pokeWindow = undefined;
    this.#wakeWindow = undefined;
  }

  /**
   * Resolves once a read whose snapshot was taken after the call has
   * delivered what it found, so everything committed before the call has
   * been delivered. Rejects when the channel is lost first, or is not
   * listening. For tests: a test that asserts nothing was delivered must
   * flush first, or it passes before anything could have been (D221).
   */
  flush(): Promise<void> {
    if (this.#state !== 'listening') {
      return Promise.reject(new Error('The realtime listener is not listening'));
    }

    // Reads run one after another and count as they start, so the next one
    // to start is one whose snapshot comes after this call.
    const target = this.#readsStarted + 1;
    const done = new Promise<void>((resolve, reject) => {
      this.#flushes.push({ target, resolve, reject });
    });

    this.#readNow();

    return done;
  }

  /**
   * Stops for good: the connection is ended, and a prune under way is
   * awaited, so that the pool can be ended afterwards.
   */
  async stop(): Promise<void> {
    if (this.#state === 'stopped') {
      return;
    }

    this.#state = 'stopped';
    this.#generation += 1;
    clearTimeout(this.#retryTimer);
    clearInterval(this.#tickTimer);
    clearInterval(this.#pruneTimer);
    this.#closeWindows();

    for (const pool of this.#pools()) {
      observeCommits(pool, this, false);
    }

    this.#rejectFlushes('The realtime listener stopped');

    const client = this.#client;

    this.#client = null;

    if (client !== null) {
      const deadline = setTimeout(
        () => (client as WithStream).connection?.stream?.destroy(),
        1_000,
      );

      await client.end().catch(() => undefined);
      clearTimeout(deadline);
    }

    await this.#pruning;
  }

  async #connect(): Promise<void> {
    this.#generation += 1;

    const generation = this.#generation;
    const client = new pg.Client(
      listenerClientConfig(this.#options.connectionString, this.#queryDeadlineMs),
    );

    this.#state = 'connecting';
    this.#client = client;
    this.#floor = '0';
    this.#seen = new Map();
    // Kept for the life of the client: an `error` with no listener would end
    // the process, and one from a connection given up already is ignored.
    client.on('error', (error) => this.#lose(generation, 'connection error', error));
    client.on('end', () => this.#lose(generation, 'connection ended'));
    client.on('notification', (message) => {
      // Another process committed: read, at once - its window was taken
      // before it woke this one. This process's own wake-ups come back here
      // too, after the poke that already read.
      if (message.channel === REALTIME_CHANNEL && message.processId !== this.processId) {
        this.#readNow();
      }
    });

    try {
      await client.connect();

      if (generation !== this.#generation) {
        return;
      }

      // The channel is this module's constant, never anything from a request.
      await this.#query(generation, `LISTEN ${REALTIME_CHANNEL}`);
      // The baseline: everything committed up to now is marked seen and
      // delivered to nobody, since nobody is registered while the hub is
      // deaf; whoever registers once it hears reads that itself.
      await this.#readOnce(generation, false);
    } catch (error) {
      this.#lose(generation, 'could not listen', error);

      return;
    }

    if (generation !== this.#generation) {
      return;
    }

    this.#state = 'listening';
    this.#retryDelay = 0;
    this.#lastReadAt = performance.now();
    this.#hub.hear();

    if (!this.#listenedOnce) {
      this.#listenedOnce = true;
      this.#reportListened();
    } else {
      this.#options.log.info({}, 'Realtime listener is listening again');
    }

    clearInterval(this.#tickTimer);
    this.#tickTimer = setInterval(() => this.#tick(generation), this.#options.tickMs ?? TICK_MS);
    this.#tickTimer.unref();
  }

  /**
   * The channel is lost (see the module's comment): the hub is deafened, what
   * the reads kept dropped, the connection destroyed, and a new one attempted
   * after the backoff. Only for the current connection: a loss reported by an
   * older one, or after `stop`, changes nothing.
   */
  #lose(generation: number, reason: string, error?: unknown): void {
    if (generation !== this.#generation || this.#state === 'stopped') {
      return;
    }

    this.#generation += 1;
    this.#state = 'lost';
    this.#hub.deafen();
    this.#seen = new Map();
    this.#floor = '0';
    this.#reading = null;
    this.#again = false;
    this.#waking = false;
    this.#wakeAgain = false;
    this.#closeWindows();
    this.#rejectFlushes(`The realtime listener lost its channel: ${reason}`);
    clearInterval(this.#tickTimer);

    const client = this.#client;

    this.#client = null;

    if (client !== null) {
      // Destroyed rather than ended: a half-open connection would never
      // answer the end either.
      (client as WithStream).connection?.stream?.destroy();
      void client.end().catch(() => undefined);
    }

    this.#options.log.warn(
      { reason, err: error },
      'Realtime listener lost its channel; every realtime connection of this process was cut',
    );

    this.#retryDelay =
      this.#retryDelay === 0
        ? (this.#options.firstRetryMs ?? FIRST_RETRY_MS)
        : Math.min(this.#retryDelay * 2, this.#options.maxRetryMs ?? MAX_RETRY_MS);

    const lost = this.#generation;

    this.#retryTimer = setTimeout(() => {
      void (async () => {
        await this.#options.beforeReconnect?.();

        if (this.#generation === lost && this.#state === 'lost') {
          await this.#connect();
        }
      })();
    }, this.#retryDelay);
    this.#retryTimer.unref();
  }

  /** The tick of `generation`: a read that has not completed for too long is a lost channel; otherwise read. */
  #tick(generation: number): void {
    if (generation !== this.#generation || this.#state !== 'listening') {
      return;
    }

    const stale = this.#options.readStaleMs ?? READ_STALE_MS;

    if (performance.now() - this.#lastReadAt > stale) {
      this.#lose(generation, `no read completed for more than ${stale} ms`);

      return;
    }

    this.#readNow();
  }

  /** Reads until nothing asked for another read meanwhile; one read at a time. */
  async #read(generation: number): Promise<void> {
    if (this.#reading === generation) {
      this.#again = true;

      return;
    }

    this.#reading = generation;

    try {
      do {
        while (this.#readHold !== null) {
          await this.#readHold;
        }

        if (generation !== this.#generation) {
          return;
        }

        this.#again = false;
        this.#readsStarted += 1;

        const number = this.#readsStarted;

        await this.#readOnce(generation, true);

        if (generation !== this.#generation) {
          return;
        }

        this.#readsCompleted = number;
        this.#lastReadAt = performance.now();
        this.#settleFlushes();
      } while (this.#again && generation === this.#generation);
    } catch (error) {
      if (!(error instanceof LostChannel)) {
        this.#lose(generation, 'reading the outbox failed', error);
      }
    } finally {
      if (this.#reading === generation) {
        this.#reading = null;
      }
    }
  }

  /** One read (see the module's comment); `deliver` is false for the baseline. */
  async #readOnce(generation: number, deliver: boolean): Promise<void> {
    const read = await this.#query<{
      horizon: string;
      id: string | null;
      tx: string | null;
      kind: string | null;
      session_id: string | null;
      created_at: Date | null;
    }>(generation, READ_SQL, [this.#floor]);

    const horizon = read.rows[0]?.horizon ?? this.#floor;
    const floor = BigInt(horizon);
    const unseen: Unseen[] = [];
    // Each session's registrations as the read returned, taken in this loop,
    // with nothing awaited before it: what the read wants and whom it
    // delivers to are judged on them alone (D221 point 5). Everything the
    // read returned committed before its snapshot, so whoever registers
    // later reads all of it after registering - a viewer's reload, a wait's
    // first read - and is sent none of it; taken before the read, they would
    // miss one who registered, and reloaded, before rows the read returns.
    const snapshots = new Map<string, SessionSnapshot>();
    const lateRowMs = this.#options.lateRowMs ?? LATE_ROW_MS;
    let wanted = 0;
    let late = 0;

    for (const row of read.rows) {
      if (row.id === null || row.tx === null || row.kind === null || row.session_id === null) {
        continue;
      }

      if (this.#seen.has(row.id)) {
        continue;
      }

      const tx = BigInt(row.tx);

      // A row below the new floor is never returned again, so only the rows
      // at or above it need remembering.
      if (tx >= floor) {
        this.#seen.set(row.id, tx);
      }

      if (!deliver) {
        continue;
      }

      if (row.created_at !== null && Date.now() - row.created_at.getTime() > lateRowMs) {
        late += 1;
      }

      if (row.kind === 'close') {
        unseen.push({ id: row.id, kind: row.kind, session: row.session_id });

        continue;
      }

      let among = snapshots.get(row.session_id);

      if (among === undefined) {
        among = this.#hub.snapshot(row.session_id);
        snapshots.set(row.session_id, among);
      }

      if (this.#hub.wants(row.session_id, row.kind, among)) {
        unseen.push({ id: row.id, kind: row.kind, session: row.session_id });
        wanted += 1;
      }
    }

    const maxSeen = this.#options.maxSeen ?? MAX_SEEN_EVENTS;
    const maxWanted = this.#options.maxWanted ?? MAX_WANTED_EVENTS;

    if (this.#seen.size > maxSeen) {
      this.#lose(generation, `more than ${maxSeen} events marked seen`);
      throw new LostChannel();
    }

    if (wanted > maxWanted) {
      this.#lose(generation, `more than ${maxWanted} events waiting to be delivered`);
      throw new LostChannel();
    }

    if (late > 0) {
      // Delivering it is correct; that it came this late says a transaction
      // took that long to commit, or the process fell behind.
      this.#warn('late', { rows: late, afterMs: lateRowMs }, 'Realtime events were read late');
    }

    await this.#deliver(generation, unseen, snapshots);

    if (generation !== this.#generation) {
      throw new LostChannel();
    }

    this.#floor = horizon;

    for (const [id, tx] of this.#seen) {
      if (tx < floor) {
        this.#seen.delete(id);
      }
    }
  }

  /**
   * Fetches the wanted payloads in batches and delivers everything in id
   * order, each event to its session's registrations of `snapshots` still
   * registered, and each `close` to every registration of its session (D198).
   */
  async #deliver(
    generation: number,
    unseen: Unseen[],
    snapshots: ReadonlyMap<string, SessionSnapshot>,
  ): Promise<void> {
    const batch = this.#options.fetchBatch ?? FETCH_BATCH;
    let start = 0;

    while (start < unseen.length) {
      // A chunk ends with its `batch`-th wanted row, closes included in place.
      let end = start;
      let wanted = 0;

      while (end < unseen.length && wanted < batch) {
        if (unseen[end]?.kind !== 'close') {
          wanted += 1;
        }

        end += 1;
      }

      const chunk = unseen.slice(start, end);
      const ids = chunk.filter((entry) => entry.kind !== 'close').map((entry) => entry.id);
      const payloads = new Map<string, string | null>();

      if (ids.length > 0) {
        await this.#options.beforeFetch?.(ids);
        this.#fetches += 1;

        const fetched = await this.#query<{ id: string; payload: string | null }>(
          generation,
          FETCH_SQL,
          [ids],
        );

        for (const row of fetched.rows) {
          payloads.set(row.id, row.payload);
        }
      }

      if (generation !== this.#generation) {
        throw new LostChannel();
      }

      for (const entry of chunk) {
        if (entry.kind === 'close') {
          this.#hub.closeSession(entry.session, WsCloseCode.SESSION_NOT_FOUND, 'Session not found');

          continue;
        }

        if (!payloads.has(entry.id)) {
          // Gone altogether, which no deletion does: something may be missing.
          this.#lose(generation, 'a wanted event was gone before it was read');
          throw new LostChannel();
        }

        const payload = payloads.get(entry.id);
        const among = snapshots.get(entry.session);

        // Purged by a deletion, whose own event follows. A capture's
        // `request.received` also carried the queue step it took, which no
        // later event repeats (D205 point 6): those it was for read the
        // session again instead (D221 point 8).
        if (payload === null || payload === undefined) {
          if (entry.kind === 'request.received' && among !== undefined) {
            this.#hub.reload(entry.session, among);
          }

          continue;
        }

        this.#hub.deliver(entry.session, entry.kind, payload, among);
      }

      start = end;
    }
  }

  async #sendWakeUps(generation: number): Promise<void> {
    try {
      do {
        this.#wakeAgain = false;
        await this.#query(generation, WAKE_SQL);
      } while (this.#wakeAgain && generation === this.#generation);
    } catch (error) {
      this.#lose(generation, 'a wake-up failed', error);
    } finally {
      if (generation === this.#generation) {
        this.#waking = false;
      }
    }
  }

  /** One statement on the connection of `generation`, failed if it does not answer within the deadline. */
  async #query<T extends pg.QueryResultRow>(
    generation: number,
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    const client = this.#client;

    if (client === null || generation !== this.#generation) {
      throw new LostChannel('The realtime listener has no connection');
    }

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`No answer within ${this.#queryDeadlineMs} ms`)),
        this.#queryDeadlineMs,
      );
      // The statement itself keeps the process alive while it runs.
      timer.unref();
    });
    const before = this.#options.beforeStatement;
    const running =
      before === undefined
        ? client.query<T>(text, values)
        : before(text).then(() => client.query<T>(text, values));

    // A statement the deadline gave up on may still fail later, on a
    // connection destroyed by then; nobody awaits it any more.
    running.catch(() => undefined);

    try {
      return await Promise.race([running, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  #settleFlushes(): void {
    const pending: Flush[] = [];

    for (const flush of this.#flushes) {
      if (flush.target <= this.#readsCompleted) {
        flush.resolve();
      } else {
        pending.push(flush);
      }
    }

    this.#flushes = pending;
  }

  #rejectFlushes(reason: string): void {
    for (const { reject } of this.#flushes) {
      reject(new Error(reason));
    }

    this.#flushes = [];
  }

  /** At most one warning a minute of each kind. */
  #warn(kind: string, details: object, message: string): void {
    const now = Date.now();

    if (now - (this.#lastWarnings.get(kind) ?? Number.NEGATIVE_INFINITY) >= WARNING_INTERVAL_MS) {
      this.#lastWarnings.set(kind, now);
      this.#options.log.warn(details, message);
    }
  }

  /** Every pool whose commits `committed` reports to this listener. */
  #pools(): readonly object[] {
    return [this.#options.pool, ...(this.#options.otherPools ?? [])];
  }

  /**
   * Every 5 s, the rows older than the retention whose transaction is below
   * the floor this process had two prunes earlier, at least 10 s ago: every
   * transaction below it had ended by then, and a process still listening
   * reads at least once a second, so every such process has read those rows
   * (D221 point 9). A floor is recorded at a prune only while the process
   * listens, and a prune that has none from two prunes earlier is skipped:
   * so the process prunes nothing from the third prune after its channel is
   * lost, 10 to 15 s after the loss, and prunes again from the third prune
   * after it listens again, or after it starts, 10 to 15 s after; pg_cron's
   * job is the backstop meanwhile. Skipped too while the last prune and its
   * vacuum are still under way.
   */
  #startPruning(): void {
    this.#pruneTimer = setInterval(() => {
      this.#pruneHorizons.push(this.#state === 'listening' ? this.#floor : null);

      if (this.#pruneHorizons.length > 3) {
        this.#pruneHorizons.shift();
      }

      const horizon = this.#pruneHorizons.length === 3 ? this.#pruneHorizons[0] : null;

      if (horizon === null || horizon === undefined || horizon === '0' || this.#pruning !== null) {
        return;
      }

      this.#pruning = this.#prune(horizon).finally(() => {
        this.#pruning = null;
      });
    }, this.#options.pruneEveryMs ?? PRUNE_INTERVAL_MS);
    this.#pruneTimer.unref();
  }

  /**
   * One prune below `horizon`, followed by a vacuum of the table when it, or
   * the prune before it, deleted at least `REALTIME_VACUUM_AFTER_BYTES` of
   * payload, so that the space is written again rather than the table grown
   * (D221 point 9). The second vacuum is for what the first could not
   * remove: it skips a vacuum another process has under way, and that one,
   * begun before this prune's deletion committed, leaves the rows it deleted
   * - which, at the end of a flood, would keep the table at its size until
   * autovacuum came. Each a statement of its own on the pool, outside any
   * transaction. Never fails: a failure is reported, and the next prune
   * comes 5 s later.
   */
  async #prune(horizon: string): Promise<void> {
    const pool = this.#options.pool;
    let bytes: number;

    try {
      const pruned = await pool.query<{ rows: number; bytes: string }>(PRUNE_REALTIME_EVENTS_SQL, [
        horizon,
        this.#options.retentionSeconds ?? REALTIME_EVENT_RETENTION_SECONDS,
      ]);

      bytes = Number(pruned.rows[0]?.bytes ?? 0);
    } catch (error) {
      this.#warn(
        'prune',
        { err: error },
        'Deleting realtime events nobody can need any more failed',
      );

      return;
    }

    const large = bytes >= REALTIME_VACUUM_AFTER_BYTES;
    const vacuum = large || this.#lastPruneLarge;

    this.#lastPruneLarge = large;

    if (!vacuum) {
      return;
    }

    try {
      await pool.query(VACUUM_REALTIME_EVENTS_SQL);
    } catch (error) {
      this.#warn('vacuum', { err: error }, 'Vacuuming the realtime events failed');
    }
  }
}
