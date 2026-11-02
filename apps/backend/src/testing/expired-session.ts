/**
 * An expired session for a test that asserts what an expired session is
 * answered, kept from the cleanup sweep while it does (D019, D041).
 *
 * Other test files remove every expired session from the shared database as
 * the cleanup job does, `DELETE FROM sessions WHERE expires_at < now()`:
 * `src/db/cleanup.test.ts` has pg_cron run it every 5 s until it has run, and
 * `webhook.test.ts` runs it once. A session removed after a test expired it
 * answers `404` / `1001` where `410` / `1002` is asserted, and nothing of the
 * test's own decides when that happens.
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type pg from 'pg';

/** Moves the session's expiry a minute into the past. */
export async function expireSession(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
    sessionId,
  ]);
}

/**
 * Expires `sessionId` and runs `run` while it stays expired and cannot be
 * deleted, then lets it go.
 *
 * A transaction of its own holds the row `FOR KEY SHARE` from before it expires
 * until `run` has ended: an update of `expires_at` does not wait for that lock,
 * and a delete does, so a sweep in between waits for `run` instead of removing
 * the row. Keep `run` short, since a sweep waits as long as it lasts;
 * afterwards the session may go, unless `run` has moved its expiry back ahead.
 *
 * Only for a run that reads the session or its requests, or deletes requests.
 * A capture and a response change take the row `FOR UPDATE` (D065, D150), which
 * waits for this hold, and so for `run` itself, until the test times out: such
 * a run takes `withExpiredSession`.
 */
export async function whileExpired<T>(
  pool: pg.Pool,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const holder = await pool.connect();

  try {
    await holder.query('BEGIN');

    const held = await holder.query('SELECT 1 FROM sessions WHERE id = $1 FOR KEY SHARE', [
      sessionId,
    ]);

    assert.equal(held.rowCount, 1, 'the session to expire is not there');
    await expireSession(pool, sessionId);

    return await run();
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
}

/** How many sessions `withExpiredSession` gives a run before its failure stands. */
const SESSIONS_TRIED = 3;

/**
 * Runs `run` on a session `create` makes and this expires, for a run that sends
 * the session a capture or a response change.
 *
 * Both take the session row `FOR UPDATE`, so the row cannot be held against the
 * sweep as `whileExpired` holds it, and a sweep may remove the session while
 * `run` is under way. Whether it did is plain afterwards, since a removed
 * session does not come back: a run that failed while its session is still
 * there failed on its own, and that failure stands at once. One that failed
 * with its session gone is run again on a new session, said in the test's
 * diagnostics, and the failure on the last session stands whatever removed it.
 */
export async function withExpiredSession<T>(
  t: Pick<TestContext, 'diagnostic'>,
  pool: pg.Pool,
  create: () => Promise<string>,
  run: (sessionId: string) => Promise<T>,
): Promise<T> {
  for (let tried = 1; ; tried += 1) {
    const sessionId = await create();

    await expireSession(pool, sessionId);

    try {
      return await run(sessionId);
    } catch (error) {
      const { rowCount } = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);

      if (rowCount !== 0 || tried === SESSIONS_TRIED) {
        throw error;
      }

      t.diagnostic(
        `the expired session ${sessionId.slice(0, 8)} was removed during the run, ` +
          `which failed; run again on a new session (${tried} of ${SESSIONS_TRIED})`,
      );
    }
  }
}
