import type pg from 'pg';
import {
  SESSION_ID_PATTERN,
  type CreatedSession,
  type ResponseConfig,
  type ResponseRule,
  type SessionDetails,
  type SessionResponseState,
  type SessionStatus,
} from '@webhook-inspector/shared';
import { sessionExpired, sessionNotFound } from '../../errors/app-error.ts';
import {
  fingerprintOf,
  openSessions,
  sessionAccess,
  type CreationKey,
  type PresentedKey,
} from './access-key.ts';
import {
  countRequests,
  deleteSession as deleteSessionRow,
  findSession,
  generateSessionId,
  insertSession,
  readSessionStatuses,
  refreshSessionExpiry,
  reportRefreshFailure,
  updateSessionQueue,
  updateSessionResponse,
  updateSessionRules,
  type QueueChange,
  type RefreshLogger,
  type ResponseChange,
  type ResponseChangeResult,
  type SessionStatusRow,
} from './repository.ts';

/**
 * `response` is `null` for a default session, which is the one-click path,
 * `queue` the steps of a response queue the session starts with, `null` for
 * none (D205), `lifetimeSeconds` the lifetime it is created with, `null` for
 * a session that slides (D220): with one, `expiresAt` is the fixed end of
 * that lifetime; and `idleSeconds` the idle window it slides by, `null` for
 * `SESSION_IDLE_DAYS` (D242). The parser never gives both. `storeSourceIp`
 * is whether its captures keep the sender's address, `true` unless the
 * creation said `false` (D243). `rules` are the response rules it starts
 * with, `[]` for none (D246). `receiveUrl` is the route's to add: it comes
 * from configuration, not from the session (D187).
 *
 * `access` makes the session private (D253): `null` for a public one; a key
 * to draw, which is drawn as an id is (D161) and answered this once as
 * `accessKey`; or the key the call sent, which is never answered back. Only
 * the key's fingerprint is stored (D245); the key is held here no longer than
 * the answer, and nothing logs it.
 */
export async function createSession(
  pool: pg.Pool,
  response: ResponseConfig | null,
  queue: ResponseConfig[] | null = null,
  lifetimeSeconds: number | null = null,
  idleSeconds: number | null = null,
  storeSourceIp = true,
  rules: ResponseRule[] = [],
  access: Exclude<CreationKey, { kind: 'none' }> | null = null,
): Promise<Omit<CreatedSession, 'receiveUrl'>> {
  const accessKey =
    access === null ? null : access.kind === 'draw' ? generateSessionId() : access.key;
  const session = await insertSession(
    pool,
    generateSessionId(),
    response,
    queue,
    lifetimeSeconds,
    idleSeconds ?? undefined,
    storeSourceIp,
    rules,
    accessKey === null ? null : fingerprintOf(accessKey),
  );

  return {
    id: session.id,
    expiresAt: session.expiresAt.toISOString(),
    private: session.private,
    // Answered only when drawn here: a key the caller sent is never written
    // back to it (D253).
    ...(access?.kind === 'draw' && accessKey !== null ? { accessKey } : {}),
  };
}

/**
 * Loads a session for the View page, which is one of the two things that count
 * as using it (D133): the load moves the expiry a full window of the session's
 * ahead (D242), unless the throttle in the statement decides nothing needs
 * writing, or the session was created with a lifetime, whose end no use moves
 * (D220). The answer says which of the two rules the session follows.
 *
 * An id that cannot be a session is answered exactly like a session that does
 * not exist, so the response reveals nothing about which of the two it was
 * (D058), and so is a keyed session `key` does not open (D245), expired or
 * not, which is not used either.
 */
export async function getSessionDetails(
  pool: pg.Pool,
  id: string,
  logger?: RefreshLogger,
  key: PresentedKey = null,
): Promise<Omit<SessionDetails, 'receiveUrl'>> {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw sessionNotFound();
  }

  // The fingerprint and the expiry, and nothing else of the session: a keyed
  // session `key` does not open is refused at a missing session's cost, before
  // its response and queue are read (D245).
  const access = await sessionAccess(pool, id, key);

  if (access === 'missing') {
    throw sessionNotFound();
  }

  if (access === 'expired') {
    throw sessionExpired();
  }

  // Read whole only now that the key has opened it. A session deleted since is
  // answered as missing and one expired since as expired, as a single read a
  // moment later would have answered them.
  const session = await findSession(pool, id);

  if (!session) {
    throw sessionNotFound();
  }

  if (session.expired) {
    throw sessionExpired();
  }

  // After the two refusals, so that neither a missing nor an expired session is
  // ever written to. The statement refuses an expired row on its own as well: a
  // session that expires between the read above and this write stays expired.
  //
  // Protected exactly as the capture path is, and for the same reason: sliding
  // the expiry is a convenience, and it may not decide whether the page loads.
  // Failing the read would turn a working session into a 500 over a write
  // nobody asked for, and the session simply keeps the expiry it had.
  let refreshed: Date | undefined;

  try {
    refreshed = await refreshSessionExpiry(pool, session.id);
  } catch (error) {
    reportRefreshFailure(error, session.id, logger);
  }

  return {
    id: session.id,
    // What the row holds now, which is the refreshed value whenever one was
    // written; reporting the timestamp read a statement earlier would describe
    // a session that no longer exists in that state.
    expiresAt: (refreshed ?? session.expiresAt).toISOString(),
    requestsCount: await countRequests(pool, session.id),
    // Which rule the session expires by, both always present (D242): its
    // window for one that slides, or the fixed end of its lifetime (D220).
    expiresAfterIdleSeconds: session.idleSeconds,
    lifetimeEndsAt: session.lifetimeEndsAt?.toISOString() ?? null,
    // Whether its captures keep the sender's address, always present: `true`
    // for every session created without `storeSourceIp: false` (D243).
    storeSourceIp: session.storeSourceIp,
    // Whether the session is private, always present, never its key (D253).
    private: session.private,
    // Every optional field is present at its effective value, so a consumer
    // never has to tell "absent" apart from "default" (D101). `response` keeps
    // its meaning - what the session answers with - and `customResponse` is
    // added beside it, so a client built before either existed reads a
    // session switched to the default as the default it is (D151).
    response: session.response,
    customResponse: session.customResponse,
    queue: session.queue,
    // Always an array, `[]` for a session with no rules, those created before
    // they existed included (D246).
    rules: session.rules,
  };
}

/**
 * Changes what a session answers with (D150). The change is refused exactly as
 * every session-scoped route refuses: `404` for an id that cannot be a session
 * or names none, or a keyed session `key` does not open (D245), `410` for an
 * expired one, which is never written to.
 */
export async function changeSessionResponse(
  pool: pg.Pool,
  id: string,
  change: ResponseChange,
  logger?: RefreshLogger,
  key: PresentedKey = null,
): Promise<SessionResponseState> {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw sessionNotFound();
  }

  return changedState(await updateSessionResponse(pool, id, change, logger, key));
}

/**
 * What a call on a session's response queue answers, `state`, and whether it
 * acted on a queue: a save always does, and a restart or a removal only on a
 * session that held one (D205). A call that did not changes nothing a viewer
 * shows and announces nothing (`updateSessionQueue`).
 */
export interface QueueChangeAnswer {
  state: SessionResponseState;
  acted: boolean;
}

/**
 * Sets, restarts or removes a session's response queue (D205), refused as
 * every session-scoped route refuses: `404` for an id that cannot be a
 * session or names none, or a keyed session `key` does not open (D245), `410`
 * for an expired one, which is never written to.
 */
export async function changeSessionQueue(
  pool: pg.Pool,
  id: string,
  change: QueueChange,
  logger?: RefreshLogger,
  key: PresentedKey = null,
): Promise<QueueChangeAnswer> {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw sessionNotFound();
  }

  const result = await updateSessionQueue(pool, id, change, logger, key);

  return {
    state: changedState(result),
    acted: change.action === 'set' || (result.outcome === 'updated' && result.hadQueue),
  };
}

/**
 * Saves a session's response rules (D246), `[]` removing them all, refused as
 * every session-scoped route refuses: `404` for an id that cannot be a
 * session or names none, or a keyed session `key` does not open (D245), `410`
 * for an expired one, which is never written to.
 */
export async function changeSessionRules(
  pool: pg.Pool,
  id: string,
  rules: ResponseRule[],
  logger?: RefreshLogger,
  key: PresentedKey = null,
): Promise<SessionResponseState> {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw sessionNotFound();
  }

  return changedState(await updateSessionRules(pool, id, rules, logger, key));
}

/** The state a change left the session in, or the refusal it was answered with. */
function changedState(result: ResponseChangeResult): SessionResponseState {
  if (result.outcome === 'session-not-found') {
    throw sessionNotFound();
  }

  if (result.outcome === 'session-expired') {
    throw sessionExpired();
  }

  return result.state;
}

/**
 * Deletes a session with its requests and their responses (D198), and answers
 * as every session-scoped route does: `404` for an id that cannot be a session
 * or names none - a session already deleted included - and `410` for an
 * expired one, which is left for the scheduled cleanup and not deleted.
 *
 * Its viewers are closed through the outbox (D221): the deletion writes the
 * session's `close` in its transaction, and a well-formed id that names no
 * session writes one before its `404`, which is what repairs a deletion that
 * committed while its acknowledgement was lost - that call failed, and its
 * retry finds no session. Nothing is written when the deletion fails, since
 * the session may still exist, nor for an expired session, whose open
 * connections are left alone (D076), nor for an id no connection can have
 * been opened on, nor for a keyed session `key` does not open, which is
 * answered `404` as one that does not exist: nothing of it is deleted, and
 * none of its viewers is closed (D245).
 */
export async function deleteSession(
  pool: pg.Pool,
  id: string,
  key: PresentedKey = null,
): Promise<void> {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw sessionNotFound();
  }

  const result = await deleteSessionRow(pool, id, key);

  if (result.outcome === 'session-expired') {
    throw sessionExpired();
  }

  if (result.outcome === 'session-not-found' || result.outcome === 'session-refused') {
    throw sessionNotFound();
  }
}

/**
 * One entry of the status read before the route adds `receiveUrl`, which comes
 * from configuration rather than from the session (D187).
 */
export type SessionStatusEntry =
  | Omit<Extract<SessionStatus, { state: 'active' }>, 'receiveUrl'>
  | Extract<SessionStatus, { state: 'expired' | 'not_found' }>;

/**
 * The status of each session `ids` names, in the order given (D199): active
 * with what the home page's list shows of it, expired, or not found.
 *
 * `ids` has been checked by `parseStatusBody`: well-formed and distinct, and
 * so has `accessKeys`, the key sent beside an id. A keyed session is reported
 * only when its own key was sent with its id, and is otherwise `not_found`,
 * expired or not, as a session that does not exist (D245): the first
 * statement reads the fingerprints, and the status is read only for the ids
 * it found open. The read is not a use of any of them (D133): two statements
 * that only read, so no expiry moves and an expired session stays as the
 * cleanup will find it.
 */
export async function getSessionStatuses(
  pool: pg.Pool,
  ids: string[],
  accessKeys: ReadonlyMap<string, string> = new Map(),
): Promise<SessionStatusEntry[]> {
  const open = await openSessions(pool, ids, (id) => accessKeys.get(id) ?? null);
  const rows =
    open.size === 0
      ? new Map<string, SessionStatusRow>()
      : await readSessionStatuses(
          pool,
          ids.filter((id) => open.has(id)),
        );

  return ids.map((id): SessionStatusEntry => {
    const row = rows.get(id);

    if (row === undefined) {
      return { id, state: 'not_found' };
    }

    if (row.expired) {
      return { id, state: 'expired' };
    }

    return {
      id,
      state: 'active',
      requestsCount: row.requestsCount ?? 0,
      lastRequestAt: row.lastRequestAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt.toISOString(),
    };
  });
}
