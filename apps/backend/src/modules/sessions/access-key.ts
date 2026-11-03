/**
 * A session's access key (D245, issue #98): the one check every path that
 * reads or changes a session makes, and how each transport hands it the key.
 *
 * A session may carry the SHA-256 fingerprint of a key, `sessions.access_key_hash`;
 * `NULL` is a public session. A creation with `"private": true` sets one
 * (D253, `creationKey`): of a key the server draws, or of the one the call's
 * `Authorization` carries. A keyed - private - session answers only a caller
 * that presents its key, and anyone else exactly as a session that does not
 * exist: `404` / `1001`, the socket closed `4404`, the MCP tools' not-found
 * error. A public session ignores whatever key is sent. The capture on the
 * receive host never asks.
 *
 * The key arrives as `Authorization: Bearer <key>` on the API and `/mcp`, as
 * a subprotocol of the socket's handshake (`REALTIME_ACCESS_KEY_PROTOCOL_PREFIX`,
 * or its old name until the day the changelog's 1.19.0 entry gives, D279),
 * and beside each id in the body of `POST /api/sessions/status` - never in a
 * URL, whose path and query the log keeps (D168). Nothing here logs it, puts
 * it in an error, or publishes it.
 *
 * A key has a session id's shape (D161): 43 characters of `A-Z a-z 0-9 _ -`,
 * about 256 bits when drawn at random, so one SHA-256 suffices and no slow
 * hash is needed. A value of any other shape is no key: it opens no keyed
 * session, and is never hashed.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import {
  OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  SESSION_ID_PATTERN,
} from '@webhook-inspector/shared';
import { sessionNotFound } from '../../errors/app-error.ts';

/** The key a call presented, or `null` for none: absent, empty, or not of a key's shape. */
export type PresentedKey = string | null;

/** The bytes of a fingerprint: SHA-256's. The column's constraint holds every row to it. */
export const FINGERPRINT_BYTES = 32;

/**
 * The longest `Authorization` value read for a key. `Bearer`, a space and 43
 * characters are 50; a longer value carries no key and is not matched at all.
 */
export const MAX_AUTHORIZATION_LENGTH = 256;

/** `Bearer`, in any letter case (RFC 9110 11.1), one or more spaces, and the key. */
const BEARER = /^Bearer +([A-Za-z0-9_-]{43})$/i;

/** Whether `value` has a key's shape, which is a session id's (D161). */
export function isKeyShaped(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/** The fingerprint stored for `key`: its SHA-256 digest, never the key. */
export function fingerprintOf(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * The one check: whether `key` opens a session whose fingerprint is
 * `fingerprint`. A public session, `null`, is open to every caller whatever
 * it sends. A keyed one is open only to the key whose digest it holds,
 * compared in constant time with `timingSafeEqual`; no key, a value of any
 * shape but a key's, which is not hashed, and a stored value of any length
 * but SHA-256's, which no writer can store, open nothing.
 */
export function opens(fingerprint: Buffer | null, key: PresentedKey): boolean {
  if (fingerprint === null) {
    return true;
  }

  if (key === null || !isKeyShaped(key) || fingerprint.length !== FINGERPRINT_BYTES) {
    return false;
  }

  return timingSafeEqual(fingerprintOf(key), fingerprint);
}

/**
 * The key an `Authorization` header carries: `Bearer <key>`, the scheme in any
 * letter case, or `null`. Anything else - another scheme, an empty `Bearer`,
 * a value of the wrong shape, a second value - carries none, and is not an
 * error: a public session answers as it always has, whatever the header says.
 * Node keeps the first of repeated `Authorization` headers and drops the rest.
 */
export function bearerKey(header: string | string[] | undefined): PresentedKey {
  if (typeof header !== 'string' || header.length > MAX_AUTHORIZATION_LENGTH) {
    return null;
  }

  return BEARER.exec(header)?.[1] ?? null;
}

/**
 * What a private creation's `Authorization` asks for (D253): `draw`, a key the
 * server draws and answers once, when there is no header; `given`, the key
 * the header carries, which the session is created under and which is never
 * answered back; `none`, a header that carries no key - another scheme, an
 * empty `Bearer`, a value not of a key's shape, one over
 * `MAX_AUTHORIZATION_LENGTH` - which the creation refuses rather than reading
 * as either, so a mistyped secret is learnt at once.
 *
 * Read only beside `"private": true`; every other creation ignores the header,
 * as it always has. A key of a key's shape is taken whether or not the server
 * ever drew it: a stored key must keep working after its sessions are gone,
 * and asking whether one exists would make creation an oracle for keys.
 */
export type CreationKey = { kind: 'draw' } | { kind: 'given'; key: string } | { kind: 'none' };

/** `CreationKey` of an `Authorization` header as Node gives it. */
export function creationKey(header: string | string[] | undefined): CreationKey {
  if (header === undefined) {
    return { kind: 'draw' };
  }

  const key = bearerKey(header);

  return key === null ? { kind: 'none' } : { kind: 'given', key };
}

/** The key a request's headers carry for the API and `/mcp`: `bearerKey` of `Authorization`. */
export function requestKey(request: {
  headers: { authorization?: string | string[] };
}): PresentedKey {
  return bearerKey(request.headers.authorization);
}

/**
 * The prefixes a subprotocol carrying a key starts with, compared exactly, as
 * subprotocol names are: the service's name, and the old one until the day
 * the changelog's 1.19.0 entry gives (D245, D279).
 */
export const KEY_PROTOCOL_PREFIXES: readonly string[] = [
  REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
  OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX,
];

/** The prefix `protocol` starts with, exactly, out of `KEY_PROTOCOL_PREFIXES`; `undefined` for none. */
function keyPrefixOf(protocol: string): string | undefined {
  return KEY_PROTOCOL_PREFIXES.find((prefix) => protocol.startsWith(prefix));
}

/**
 * Whether a subprotocol the handshake offered carries a key - starts with
 * either prefix, exactly - and so is never echoed.
 */
export function isKeyProtocol(protocol: string): boolean {
  return keyPrefixOf(protocol) !== undefined;
}

/**
 * The key the socket's handshake offered: carried by a subprotocol that
 * starts with `REALTIME_ACCESS_KEY_PROTOCOL_PREFIX`, by one that starts with
 * the old `OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX`, or by one of each
 * carrying the same key - what the page offers until the old names stop, so
 * that a backend of either release reads it (D279) - its remainder of a
 * key's shape. None, two under one prefix, one under each carrying different
 * keys, or a remainder of another shape, carry none. `header` is
 * `Sec-WebSocket-Protocol` as Node joined it, with `, ` between repeated
 * headers; `ws` has refused the handshake already when it is not a list of
 * distinct tokens.
 */
export function protocolKey(header: string | string[] | undefined): PresentedKey {
  if (typeof header !== 'string') {
    return null;
  }

  const found = new Map<string, string>();

  for (const offered of header.split(',')) {
    const protocol = offered.trim();
    const prefix = keyPrefixOf(protocol);

    if (prefix === undefined) {
      continue;
    }

    if (found.has(prefix)) {
      return null;
    }

    found.set(prefix, protocol.slice(prefix.length));
  }

  const keys = new Set(found.values());
  const [key] = keys;

  return keys.size === 1 && key !== undefined && isKeyShaped(key) ? key : null;
}

/**
 * The subprotocol the socket's handshake answers with (`ws`'s
 * `handleProtocols`): the first one offered that carries no key, as `ws`
 * chose the first before keys existed, or none - the protocol the client
 * offered, under either name (D279). A browser fails a handshake that offered
 * subprotocols and was answered none, so one that sends its key offers
 * `REALTIME_PROTOCOL` beside it, first, which this echoes; the key itself is
 * never written back, under either prefix. The prefixes are compared exactly
 * here as in `protocolKey` (D245), so a name that starts with either in
 * another letter case carries no key and is answered as any other name is,
 * as before 1.19.0 (#356). `offered` is what `ws` parsed: distinct tokens,
 * never an empty name, since `ws` refuses any other header `400` first.
 * Decided before the session is looked up, so it says nothing about the
 * session.
 */
export function chooseProtocol(offered: ReadonlySet<string>): string | false {
  for (const protocol of offered) {
    if (!isKeyProtocol(protocol)) {
      return protocol;
    }
  }

  return false;
}

/** Whatever runs one statement: the pool, or a client inside a transaction. */
type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/**
 * The check as the paths that act in a statement of their own make it, before
 * that statement: the session's fingerprint read by its id, and `404` / `1001`
 * - `sessionNotFound`, the answer of a session that does not exist - when no
 * session has the id or `key` does not open it. Nothing is written and the
 * session is not used (D133), so a refused call moves no expiry.
 *
 * Checked apart from the statement it guards, which is sound because a
 * session's fingerprint is set when it is created and never changed (D245):
 * a session found open here is the same session, keyed the same way, when
 * that statement runs, or one gone meanwhile, which it answers as gone.
 *
 * A missing session is answered here too, so that it costs the one statement
 * a refused keyed session costs, and the two cannot be told apart by it.
 */
export async function requireAccess(
  executor: Queryable,
  sessionId: string,
  key: PresentedKey,
): Promise<void> {
  const result = await executor.query<{ access_key_hash: Buffer | null }>(
    'SELECT access_key_hash FROM sessions WHERE id = $1',
    [sessionId],
  );
  const row = result.rows[0];

  if (row === undefined || !opens(row.access_key_hash, key)) {
    throw sessionNotFound();
  }
}

/**
 * The statement `sessionAccess` sends: a session's fingerprint and the verdict
 * on its expiry, judged against `clock_timestamp()` (D065), and nothing else
 * of it. Exported so that a test recognises it exactly (D133).
 */
export const SESSION_ACCESS_SQL = `SELECT access_key_hash, expires_at <= clock_timestamp() AS expired
     FROM sessions
    WHERE id = $1`;

/**
 * What `sessionAccess` finds: a session `key` opens, active or expired, or
 * `missing` - no session has the id, or `key` does not open it, which are one
 * answer (D245), expired or not.
 */
export type SessionAccess = 'active' | 'expired' | 'missing';

/**
 * The check as the session's read and the socket make it, before anything
 * else of the session is read: its fingerprint and its expiry, one statement
 * whose answer has the same two small columns whatever the session stores
 * (`SESSION_ACCESS_SQL`). What the session answers with - its response, its
 * queue of up to ten 64 KiB bodies - is read only once `key` has opened it,
 * so a refused keyed session costs what a missing one costs, the same
 * statement answered by one such row or by none, and the two cannot be told
 * apart by the time their refusal takes (criterion 8).
 *
 * A caller that reads more of the session after this answered `active` or
 * `expired` finds the same session, keyed the same way, since a fingerprint
 * is set at creation and never changed, or none, when it was deleted
 * meanwhile, which it answers as missing.
 */
export async function sessionAccess(
  executor: Queryable,
  sessionId: string,
  key: PresentedKey,
): Promise<SessionAccess> {
  const result = await executor.query<{ access_key_hash: Buffer | null; expired: boolean }>(
    SESSION_ACCESS_SQL,
    [sessionId],
  );
  const row = result.rows[0];

  if (row === undefined || !opens(row.access_key_hash, key)) {
    return 'missing';
  }

  return row.expired ? 'expired' : 'active';
}

/**
 * The check for many sessions at once, for the status read (D199, D245): the
 * ids among `ids` that name a session the key `keyFor` gives for it opens -
 * every public one, and each keyed one whose key was sent with its id. One
 * statement reads the fingerprints; an id left out is answered `not_found`
 * and read no further, whether no session has it or its key was not sent, so
 * the two cost the same and answer the same.
 */
export async function openSessions(
  executor: Queryable,
  ids: readonly string[],
  keyFor: (id: string) => PresentedKey,
): Promise<Set<string>> {
  const result = await executor.query<{ id: string; access_key_hash: Buffer | null }>(
    'SELECT id, access_key_hash FROM sessions WHERE id = ANY($1::text[])',
    [ids],
  );

  return new Set(
    result.rows.filter((row) => opens(row.access_key_hash, keyFor(row.id))).map((row) => row.id),
  );
}
