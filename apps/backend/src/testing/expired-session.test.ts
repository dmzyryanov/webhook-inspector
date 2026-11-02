/**
 * Tests for the expired sessions the integration tests share
 * (`expired-session.ts`): what each helper keeps from the cleanup sweep, and
 * what it does when it cannot.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { whileExpired, withExpiredSession } from './expired-session.ts';

let pool: pg.Pool;
const createdSessionIds: string[] = [];

before(() => {
  pool = createPool(loadConfig().databaseUrl);
});

after(async () => {
  await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  await pool.end();
});

/** A live session row; these tests are about the row alone. */
async function newSession(): Promise<string> {
  const id = `expired-helper-${randomUUID().replaceAll('-', '')}`.slice(0, 43);

  await pool.query("INSERT INTO sessions (id, expires_at) VALUES ($1, now() + interval '1 hour')", [
    id,
  ]);
  createdSessionIds.push(id);

  return id;
}

async function sessionExists(sessionId: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);

  return rowCount === 1;
}

/** The cleanup job's statement, limited to this session. */
const SWEEP = 'DELETE FROM sessions WHERE expires_at < now() AND id = $1';

/**
 * Runs `statement` for `sessionId` on a connection of its own, giving up with
 * `55P03` after `wait` of waiting for a lock.
 */
async function waitingAtMost(wait: string, statement: string, sessionId: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${wait}'`);
    await client.query(statement, [sessionId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** A stand-in for the test context, recording its diagnostics. */
function recorder(): { notes: string[]; diagnostic(message: string): void } {
  const notes: string[] = [];

  return { notes, diagnostic: (message) => void notes.push(message) };
}

describe('whileExpired', () => {
  it('runs on the expired session and keeps it from a sweep until the run has ended', async () => {
    const sessionId = await newSession();

    const answer = await whileExpired(pool, sessionId, async () => {
      const { rows } = await pool.query<{ expired: boolean }>(
        'SELECT expires_at < now() AS expired FROM sessions WHERE id = $1',
        [sessionId],
      );

      assert.equal(rows[0]?.expired, true);
      await assert.rejects(waitingAtMost('200ms', SWEEP, sessionId), { code: '55P03' });
      assert.equal(await sessionExists(sessionId), true);

      return 'answered';
    });

    assert.equal(answer, 'answered');
    await waitingAtMost('5s', SWEEP, sessionId);
    assert.equal(await sessionExists(sessionId), false, 'the released session was not swept');
  });

  it('lets the run move the expiry ahead, and a sweep that waited for the hold leaves it', async () => {
    const sessionId = await newSession();
    const sweeper = await pool.connect();
    const sweep: { done?: Promise<unknown> } = {};

    try {
      await whileExpired(pool, sessionId, async () => {
        const { rows } = await sweeper.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const pid = rows[0]?.pid;

        sweep.done = sweeper.query(SWEEP, [sessionId]);

        // Revived only once the sweep is waiting for the hold, as one that
        // started just before the revival would be.
        for (let waited = 0; ; waited += 50) {
          const activity = await pool.query<{ wait_event_type: string | null }>(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
            [pid],
          );

          if (activity.rows[0]?.wait_event_type === 'Lock') {
            break;
          }

          assert.ok(waited < 5_000, 'the sweep never waited for the hold');
          await delay(50);
        }

        await pool.query(
          "UPDATE sessions SET expires_at = now() + interval '1 day' WHERE id = $1",
          [sessionId],
        );
      });

      await sweep.done;
    } finally {
      // Ended before the client goes back to the pool, whatever happened above.
      await sweep.done?.catch(() => undefined);
      sweeper.release();
    }

    assert.equal(await sessionExists(sessionId), true, 'the sweep removed a revived session');
  });

  it('keeps the row from a capture as well, which is why a capture takes withExpiredSession', async () => {
    const sessionId = await newSession();

    await whileExpired(pool, sessionId, async () => {
      // The lock a capture takes before it reads the session (D065).
      await assert.rejects(
        waitingAtMost('200ms', 'SELECT id FROM sessions WHERE id = $1 FOR UPDATE', sessionId),
        { code: '55P03' },
      );
    });
  });
});

describe('withExpiredSession', () => {
  it('runs once on an expired session and answers what the run answers', async () => {
    const t = recorder();
    const seen: string[] = [];

    const answer = await withExpiredSession(t, pool, newSession, async (sessionId) => {
      const { rows } = await pool.query<{ expired: boolean }>(
        'SELECT expires_at < now() AS expired FROM sessions WHERE id = $1',
        [sessionId],
      );

      seen.push(sessionId);
      assert.equal(rows[0]?.expired, true);

      return 'answered';
    });

    assert.equal(answer, 'answered');
    assert.equal(seen.length, 1);
    assert.deepEqual(t.notes, []);
  });

  it('lets a failure stand at once while its session is still there', async () => {
    const t = recorder();
    let runs = 0;

    await assert.rejects(
      withExpiredSession(t, pool, newSession, async () => {
        runs += 1;
        throw new Error('the run itself');
      }),
      /the run itself/,
    );
    assert.equal(runs, 1);
    assert.deepEqual(t.notes, []);
  });

  it('runs again on a new session when the one that failed was swept, and says so', async () => {
    const t = recorder();
    const seen: string[] = [];

    await withExpiredSession(t, pool, newSession, async (sessionId) => {
      seen.push(sessionId);

      if (seen.length === 1) {
        await pool.query(SWEEP, [sessionId]);
        throw new Error('404 where 410 was asserted');
      }
    });

    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
    assert.equal(t.notes.length, 1);
    assert.match(t.notes[0] ?? '', /removed during the run/);
  });

  it('lets the failure on the third session stand, swept as it was', async () => {
    const t = recorder();
    let runs = 0;

    await assert.rejects(
      withExpiredSession(t, pool, newSession, async (sessionId) => {
        runs += 1;
        await pool.query(SWEEP, [sessionId]);
        throw new Error(`failure ${runs}`);
      }),
      /failure 3/,
    );
    assert.equal(runs, 3);
    assert.equal(t.notes.length, 2);
  });
});
