import { NEGOTIABLE_EVENT_TYPES, type ServerEvent } from '@webhook-inspector/shared';

/** The part of a WebSocket the hub needs, so that tests can stand in for one. */
export interface Subscriber {
  send(data: string): void;
  /** Starts the closing handshake with a close code and a reason (D198). */
  close(code: number, reason: string): void;
  /**
   * The bytes sent to the connection and not yet handed to the network: what
   * `ws` reports, its socket's write buffer and what its sender still holds.
   * It grows while the peer does not read.
   */
  readonly bufferedAmount: number;
  /** Destroys the connection at once, without a closing handshake (D079). */
  terminate(): void;
}

/**
 * How far behind one connection may fall: the bytes it has not yet written
 * to the network, and while it is held the bytes held for it, together with
 * the event being published (D205). Without rules two of the largest events
 * fit - a `session.updated` of a session with a full queue is about 1.8 MiB -
 * so a viewer on a slow link survives a save followed by `Run again`, and a
 * third cuts it. With the largest rules as well one such event, about
 * 2.8 MiB, fits and two in a row do not: a viewer that has read everything
 * is never cut by one, and one sent two before it read the first is cut and
 * recovers on its reconnection's `ready` (D246 point 11).
 */
export const MAX_SUBSCRIBER_BACKLOG_BYTES = 4 * 1024 * 1024;

/** How often, at most, the hub reports connections it cut. */
const CUT_REPORT_INTERVAL_MS = 60_000;

/** Where the hub reports what it cut: the application listener's log. */
export interface HubLog {
  warn(details: object, message: string): void;
}

/**
 * The close code of a connection asked to read its session again
 * (`RealtimeHub.reload`): `1013`, Try Again Later, which a viewer retries as
 * any interruption and reloads on the `ready` that follows (D077, D079), and
 * which a wait takes as its time running out (D200, D221).
 */
export const RELOAD_CLOSE_CODE = 1013;

/** What the hub keeps for one registered connection. */
export interface Registration {
  /** The optional event types the connection declared it can handle (D115). */
  accepts: ReadonlySet<string>;
  /**
   * What was published to the connection while it was held, in the order it
   * was published, or `null` once it is sent events as they are published
   * (`hold` and `release`, D198).
   */
  held: string[] | null;
  /** The bytes of `held`. */
  heldBytes: number;
}

/**
 * One session's registrations at one moment (`RealtimeHub.snapshot`): what
 * one read of the listener judges `wants` on and delivers to (D221 point 5).
 */
export type SessionSnapshot = ReadonlyMap<Subscriber, Registration>;

const NOBODY: SessionSnapshot = new Map();

function isNegotiable(type: string): boolean {
  return (NEGOTIABLE_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * The registry of open session sockets, and of the list calls held by `wait`
 * (D200), in one backend process.
 *
 * Nothing calls it to announce a change any more: every change is written to
 * the outbox in its own transaction and announced through PostgreSQL, and the
 * process's `RealtimeListener` delivers what it hears here (`deliver`), for
 * the changes of every process on the database, its own included (D221). The
 * registry itself stays in the process: what it holds is the connections open
 * on this process, and nothing in it survives a restart, nor needs to - a
 * reconnecting viewer reloads the list over HTTP (D077).
 *
 * It is deaf while the listener is not listening (`deafen`, `hear`): it then
 * holds nobody, since nothing would reach them, and the realtime route and the
 * waits read `deaf` before they register (D221).
 *
 * It also keeps each session's line of calls (`inOrder`, D205), so that calls
 * waiting for one session's row lock wait here, holding nothing of the
 * database, nor a slot of the gate in front of the API's work (D244). The
 * order of their events no longer depends on it: the outbox announces them
 * in commit order (D221).
 */
export class RealtimeHub {
  /**
   * Session id to its open sockets, each held against the optional event types
   * that socket declared it can handle (D115) and what is held for it. The
   * socket itself is the key, so `add`, `hold`, `release` and `remove` cannot
   * drift apart on a wrapper object.
   */
  readonly #sessions = new Map<string, Map<Subscriber, Registration>>();

  /**
   * Registers a connection that is sent every event as it is published.
   *
   * `accepts` is required rather than defaulted on purpose: every call site and
   * every test then has to state what the connection declared, which is the
   * property under test (D115). An empty set is a connection that declared
   * nothing, which is every client built before this release.
   */
  add(sessionId: string, subscriber: Subscriber, accepts: ReadonlySet<string>): void {
    this.#register(sessionId, subscriber, { accepts, held: null, heldBytes: 0 });
  }

  /**
   * Registers a connection that is sent nothing yet: what is published to it
   * is held, in the order it is published, until `release` sends it.
   *
   * It is how the realtime route registers a connection, because its `ready`
   * must be the first message (D081) and the route may still look the session
   * up again before sending it (D198). A connection registered only then could
   * miss what is published meanwhile; one sent it at once would receive it
   * before its `ready`. A held connection is registered all the same: `publish`
   * holds for it what it declared, and `closeSession` closes and forgets it with
   * whatever it held.
   *
   * What is held is bounded as a connection's backlog is: an event that would
   * take it over `MAX_SUBSCRIBER_BACKLOG_BYTES` cuts the connection, which is
   * then never released (D205). It is otherwise bounded by the time until
   * `release`, the route's lookup of the session: every event is published
   * after a statement of the same database has committed, so a database too
   * slow to answer the lookup commits little meanwhile.
   */
  hold(sessionId: string, subscriber: Subscriber, accepts: ReadonlySet<string>): void {
    this.#register(sessionId, subscriber, { accepts, held: [], heldBytes: 0 });
  }

  /**
   * Sends `first` to a held connection, then everything held for it in the
   * order it was published, and from then on every event as it is published
   * (D081, D198). Nothing can be published in between: this runs to the end
   * before anything else does.
   *
   * Answers `false` and sends nothing when the connection is no longer
   * registered - removed, or closed with its session by `closeSession` - and
   * `false` when it fails to accept a message, in which case it is dropped as
   * `publish` drops one.
   */
  release(sessionId: string, subscriber: Subscriber, first: string): boolean {
    const registration = this.#sessions.get(sessionId)?.get(subscriber);

    if (!registration) {
      return false;
    }

    const held = registration.held ?? [];

    registration.held = null;
    registration.heldBytes = 0;

    try {
      subscriber.send(first);

      for (const payload of held) {
        subscriber.send(payload);
      }
    } catch {
      this.remove(sessionId, subscriber);

      return false;
    }

    return true;
  }

  #register(sessionId: string, subscriber: Subscriber, registration: Registration): void {
    const existing = this.#sessions.get(sessionId);

    if (existing) {
      existing.set(subscriber, registration);

      return;
    }

    this.#sessions.set(sessionId, new Map([[subscriber, registration]]));
  }

  /** Drops the empty map too, so an idle session leaves nothing behind. */
  remove(sessionId: string, subscriber: Subscriber): void {
    const subscribers = this.#sessions.get(sessionId);

    if (!subscribers) {
      return;
    }

    subscribers.delete(subscriber);

    if (subscribers.size === 0) {
      this.#sessions.delete(sessionId);
    }
  }

  /**
   * Sends one event to every viewer of one session, and only that session:
   * `payload` is the event as it goes on the wire, `type` its `type`. The
   * listener calls it with what the outbox row holds, exactly as the change
   * wrote it in its transaction (D221); a type this image does not know - the
   * next image's, during a rollout - is delivered like any type that is not
   * negotiable.
   *
   * The gate is a **positive allow-list of negotiable types**, never "send only
   * what was declared": a type absent from `NEGOTIABLE_EVENT_TYPES` reaches
   * everyone, exactly as before this release. The inverted rule would silence
   * `ready` and `request.received` for every existing client at once, which is
   * the easiest mistake in this design (D115). The negotiable set is imported
   * rather than restated here, so it cannot fall out of step with the client's.
   *
   * A held connection is not sent the event: it is kept for it, in order, and
   * sent once the connection is released (`hold`, D198).
   *
   * A socket that fails to accept the event is dropped rather than allowed to
   * stop the delivery to the others: the change is already committed, and a
   * notification lost to one viewer is recovered by its reload. Deleting from
   * a `Map` while iterating it is defined, so dropping it here is safe.
   *
   * A connection the event would put more than `MAX_SUBSCRIBER_BACKLOG_BYTES`
   * behind - what it has not yet written to the network, or what is held for
   * it, with the event - is terminated and dropped rather than sent it (D205):
   * a peer that does not read would otherwise keep every event published to
   * it in this process's memory until the heartbeat noticed, 30 to 60 s later
   * (D079). Never closed, whose closing frame would queue behind the backlog
   * and free nothing, and never sent the next event with this one skipped,
   * which nothing would ever replay: cut, the viewer reconnects as after any
   * interruption and reads the list and the session again (D077, D133).
   *
   * With `among`, the session's registrations when the listener's read
   * returned (`snapshot`), only those of them still registered are sent it:
   * one registered since reads, after registering, everything that read
   * returned - its reload, its first read - and is sent none of it (D221
   * point 5).
   */
  deliver(sessionId: string, type: string, payload: string, among?: SessionSnapshot): void {
    const subscribers = this.#sessions.get(sessionId);

    if (!subscribers) {
      return;
    }

    const negotiable = isNegotiable(type);
    const bytes = Buffer.byteLength(payload);

    for (const [subscriber, registration] of subscribers) {
      if (among !== undefined && among.get(subscriber) !== registration) {
        continue;
      }

      if (negotiable && !registration.accepts.has(type)) {
        continue;
      }

      if (registration.held !== null) {
        if (registration.heldBytes + bytes > MAX_SUBSCRIBER_BACKLOG_BYTES) {
          this.#cut(sessionId, subscriber);
        } else {
          registration.held.push(payload);
          registration.heldBytes += bytes;
        }

        continue;
      }

      try {
        if (subscriber.bufferedAmount + bytes > MAX_SUBSCRIBER_BACKLOG_BYTES) {
          this.#cut(sessionId, subscriber);
        } else {
          subscriber.send(payload);
        }
      } catch {
        this.remove(sessionId, subscriber);
      }
    }
  }

  /** `deliver` for an event built in this process: what the tests publish. */
  publish(sessionId: string, event: ServerEvent): void {
    this.deliver(sessionId, event.type, JSON.stringify(event));
  }

  /**
   * Whether an event of `type` would reach anybody registered for the
   * session - or, with `among`, anybody of that `snapshot`: a registration at
   * all, and for a negotiable type one that declared it (D115). The listener
   * reads no payload for an event nobody here wants (D221).
   */
  wants(sessionId: string, type: string, among?: SessionSnapshot): boolean {
    const subscribers = among ?? this.#sessions.get(sessionId);

    if (subscribers === undefined || subscribers.size === 0) {
      return false;
    }

    if (!isNegotiable(type)) {
      return true;
    }

    for (const registration of subscribers.values()) {
      if (registration.accepts.has(type)) {
        return true;
      }
    }

    return false;
  }

  /**
   * The session's registrations now, which nothing done to the hub later
   * changes. The listener takes one per session once a read has returned,
   * and judges `wants` and delivers that read's events on it (D221 point 5).
   */
  snapshot(sessionId: string): SessionSnapshot {
    const subscribers = this.#sessions.get(sessionId);

    return subscribers === undefined ? NOBODY : new Map(subscribers);
  }

  /**
   * Asks the registrations of `among` still registered for the session to
   * read it again: each is forgotten and closed with `RELOAD_CLOSE_CODE`, so
   * a viewer reconnects and reloads on its `ready` (D077, D079), and a wait
   * reads the list a last time and answers, as when its time runs out (D200).
   * The listener calls it when an event it was to deliver to them carried
   * what no later event repeats - a capture's `request.received`, its queue
   * step (D205 point 6) - and a deletion purged it before the payload was
   * fetched (D221 point 8). Registrations of other sessions, and of this one
   * registered since, are untouched: those read the session after the
   * capture committed.
   */
  reload(sessionId: string, among: SessionSnapshot): void {
    const subscribers = this.#sessions.get(sessionId);

    if (!subscribers) {
      return;
    }

    for (const [subscriber, registration] of among) {
      if (subscribers.get(subscriber) !== registration) {
        continue;
      }

      this.remove(sessionId, subscriber);

      try {
        subscriber.close(RELOAD_CLOSE_CODE, 'Try again later');
      } catch {
        // Already forgotten above; a peer that stops answering is terminated
        // by the heartbeat (D079).
      }
    }
  }

  /** Where connections cut are reported, once `reportTo` has named it. */
  #log: HubLog | null = null;
  /** Connections cut since the last report, and when that report was made. */
  #cutsUnreported = 0;
  #lastCutReportAt = Number.NEGATIVE_INFINITY;

  /** Names the log connections cut are reported to: the application listener's. */
  reportTo(log: HubLog): void {
    this.#log = log;
  }

  /**
   * Drops a connection that fell too far behind and destroys it (D205), and
   * reports it at most once a minute with how many were cut since the last
   * report. The report names no session: whoever knows a session's id can
   * read and change it (D153).
   */
  #cut(sessionId: string, subscriber: Subscriber): void {
    this.remove(sessionId, subscriber);

    try {
      subscriber.terminate();
    } catch {
      // Already forgotten above; a socket that cannot be destroyed is gone.
    }

    this.#cutsUnreported += 1;

    const now = Date.now();

    if (this.#log === null || now - this.#lastCutReportAt < CUT_REPORT_INTERVAL_MS) {
      return;
    }

    const terminated = this.#cutsUnreported;

    this.#lastCutReportAt = now;
    this.#cutsUnreported = 0;

    try {
      this.#log.warn(
        { terminated, backlogLimitBytes: MAX_SUBSCRIBER_BACKLOG_BYTES },
        'Realtime connections that fell too far behind were terminated',
      );
    } catch {
      // Reporting may not become a failure of the publish.
    }
  }

  /**
   * How many times `closeSession` or `deafen` has run since the process
   * started.
   *
   * It is what lets a connection that was being set up while its session was
   * deleted notice the deletion (D198): the realtime route reads it before it
   * looks the session up and again once the connection is registered, and
   * looks the session up a second time only when it changed. One number for
   * every session, so a deleted session leaves nothing behind in the registry;
   * the price is a second lookup for a connection set up while any session was
   * deleted, or while a deletion found no session to delete.
   *
   * `closeSession` runs when the listener hears a deletion's `close`, after
   * that deletion has committed, so a connection registered once it has run is
   * closed by it and one looked up after the commit finds no session (D221).
   * `deafen` counts too: a deletion committed while the process was deaf is
   * never heard, so a connection whose lookup began before the deafness looks
   * its session up again.
   */
  #closedSessions = 0;

  get closedSessions(): number {
    return this.#closedSessions;
  }

  /**
   * Closes every open connection of one session with `code`, and forgets them
   * at once, so nothing delivered after this call reaches them (D198); a held
   * one is forgotten with what it held, which is never sent. Called once no
   * session of that id is left - by the listener, on the `close` a deletion
   * wrote (D221); connections of other sessions are untouched.
   *
   * A connection that fails to start its closing handshake is dropped all the
   * same, as `deliver` drops one that fails to accept an event: the session is
   * already gone, and a peer that stops answering is terminated by the
   * heartbeat (D079).
   */
  closeSession(sessionId: string, code: number, reason: string): void {
    this.#closedSessions += 1;

    const subscribers = this.#sessions.get(sessionId);

    if (!subscribers) {
      return;
    }

    this.#sessions.delete(sessionId);

    for (const subscriber of subscribers.keys()) {
      try {
        subscriber.close(code, reason);
      } catch {
        // Already forgotten above; there is nothing more to do for it.
      }
    }
  }

  /** Whether the process is not listening: see `deafen`. */
  #deaf = false;

  get deaf(): boolean {
    return this.#deaf;
  }

  /**
   * The process stopped hearing what the other processes - and its own calls -
   * announce: its listening connection was lost, or fell too far behind, or
   * has not listened yet (D221). Every registration is cut, a socket
   * terminated (`1006`, so its viewer reconnects and reloads, D077, D079) and a
   * wait run out (`terminate`, which answers it after one last read, as at
   * shutdown, D200), and forgotten, so nobody stays registered on a channel
   * that may have missed an event. Until `hear`, the realtime route refuses a
   * new connection with `1013` and a new wait answers its first read.
   */
  deafen(): void {
    this.#deaf = true;
    this.#closedSessions += 1;

    const sessions = [...this.#sessions.values()];

    this.#sessions.clear();

    for (const subscribers of sessions) {
      for (const subscriber of subscribers.keys()) {
        try {
          subscriber.terminate();
        } catch {
          // Already forgotten above; a socket that cannot be destroyed is gone.
        }
      }
    }
  }

  /**
   * The process listens again (D221): what commits from now on is heard, and
   * whoever registers from now on reads, after registering, everything that
   * committed before - the viewer's reload, the wait's first read.
   */
  hear(): void {
    this.#deaf = false;
  }

  /** Open connections for one session. Exists for tests and diagnostics. */
  countFor(sessionId: string): number {
    return this.#sessions.get(sessionId)?.size ?? 0;
  }

  /**
   * Session id to the end of its line of calls (`inOrder`): a promise settled
   * once the last call that joined the line has run. The entry is deleted when
   * that call settles with nobody behind it, so an idle session leaves nothing
   * behind.
   */
  readonly #lines = new Map<string, Promise<void>>();

  /**
   * Runs `change` once every earlier call of `inOrder` for the same session
   * in this process has run, and only then lets the next call for that session
   * run (D205). Calls for different sessions do not wait for each other.
   *
   * Every call that moves a session's response queue - a capture, a response
   * change, a queue saved, started again or removed, a clear - takes the
   * session row's lock in its transaction (D065) and writes its event there,
   * so the lock orders the changes and the outbox announces them in that
   * order, whichever process made them (D221). What the line adds is where a
   * call waits: `change` must take its connection of the pool inside the turn,
   * never before it, so calls waiting for one session hold nothing of the
   * database here and never hold the connections the call they wait for
   * needs. Nor a slot of the gate in front of the API's work (D244): a call
   * of the API gives its slot back before it joins the line and runs its turn
   * without one (`inSessionLine`), so that calls waiting here hold nothing
   * the API's other calls need, and a session's captures, which hold no
   * slot, never wait for the API's other work behind a change in their line.
   * A throw ends the turn too, and the next call runs. What a call does after
   * its change - a response's delay, the reply - is the caller's, outside the
   * turn.
   *
   * The line is this process's: calls of one session on two processes wait
   * for each other on the row lock itself, each holding a connection of its
   * own process's pool, at most one per process and session.
   */
  async inOrder<T>(sessionId: string, change: () => Promise<T>): Promise<T> {
    const before = this.#lines.get(sessionId);
    let done: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => {
      done = resolve;
    });

    // Joined before anything is awaited, so calls take their turns in the
    // order they were made.
    this.#lines.set(sessionId, turn);

    try {
      if (before !== undefined) {
        await before;
      }

      return await change();
    } finally {
      if (this.#lines.get(sessionId) === turn) {
        this.#lines.delete(sessionId);
      }

      done();
    }
  }

  /** Sessions with a call running or waiting in `inOrder`. Exists for tests and diagnostics. */
  get sessionsInLine(): number {
    return this.#lines.size;
  }
}
