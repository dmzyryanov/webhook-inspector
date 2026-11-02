/**
 * The one transaction the outbox's writers end alike (`inTransaction`, D221):
 * each way it ends, on a fake connection and pool whose every statement can
 * be made to fail, with the readers' wake-up observed in its place among the
 * statements. Then the session deletion's own paths on it, against the
 * database (D198).
 *
 * The second part requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { withExpiredSession } from '../../testing/expired-session.ts';
import { deleteSession } from '../sessions/repository.ts';
import { APPEND_EVENT_SQL, observeCommits } from './events.ts';
import { inTransaction } from './transaction.ts';

/** The statement a fake work sends, standing for its event's append. */
const APPEND = 'INSERT the event';

/**
 * A pool of one fake connection. Every statement answers a turn later, as a
 * real one does, and the log records it sent, returned or failed; the
 * readers' wake-up (`committed`) and the connection's release are logged in
 * their place. A statement named in `failing` fails with its errors in turn,
 * one a time it is sent, and returns once they run out.
 */
function fakePool(failing: Partial<Record<string, Error[]>> = {}): {
  pool: pg.Pool;
  log: string[];
  releasedWith: () => Error | boolean | undefined;
} {
  const log: string[] = [];
  let releasedWith: Error | boolean | undefined;
  const client = {
    async query(text: string) {
      log.push(`sent ${text}`);
      await Promise.resolve();

      const failure = failing[text]?.shift();

      if (failure !== undefined) {
        log.push(`failed ${text}`);
        throw failure;
      }

      log.push(`returned ${text}`);

      return { rows: [], rowCount: 0 };
    },
    release(error?: Error | boolean) {
      releasedWith = error;
      log.push(error === undefined ? 'released' : 'released, discarded');
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  };

  observeCommits(pool, {
    poke: () => log.push('read'),
    wake: () => log.push('woken'),
  });

  return { pool: pool as unknown as pg.Pool, log, releasedWith: () => releasedWith };
}

describe('the outbox writers’ transaction (D221)', () => {
  it('commits, then wakes the readers once, only after COMMIT has returned', async () => {
    const { pool, log, releasedWith } = fakePool();

    const value = await inTransaction(pool, async (client) => {
      await client.query(APPEND);

      return { commit: true, value: 'done' };
    });

    assert.equal(value, 'done');
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      `sent ${APPEND}`,
      `returned ${APPEND}`,
      'sent COMMIT',
      'returned COMMIT',
      'read',
      'woken',
      'released',
    ]);
    assert.equal(releasedWith(), undefined);
  });

  it('commits a work that says it appended no event and wakes nobody (#209)', async () => {
    const { pool, log, releasedWith } = fakePool();

    const value = await inTransaction(pool, async () => ({
      commit: true,
      wake: false,
      value: 'unannounced',
    }));

    assert.equal(value, 'unannounced');
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      'sent COMMIT',
      'returned COMMIT',
      'released',
    ]);
    assert.equal(releasedWith(), undefined);
  });

  it('wakes the readers once after COMMIT for a work that says it appended an event (#209)', async () => {
    const { pool, log } = fakePool();

    const value = await inTransaction(pool, async (client) => {
      await client.query(APPEND);

      return { commit: true, wake: true, value: 'announced' };
    });

    assert.equal(value, 'announced');
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      `sent ${APPEND}`,
      `returned ${APPEND}`,
      'sent COMMIT',
      'returned COMMIT',
      'read',
      'woken',
      'released',
    ]);
  });

  it('wakes nobody when COMMIT fails on a work that appended no event, and its error reaches the caller (#209)', async () => {
    const commitFailure = new Error('the commit failed');
    const { pool, log, releasedWith } = fakePool({ COMMIT: [commitFailure] });

    await assert.rejects(
      inTransaction(pool, async () => ({ commit: true, wake: false, value: 'unannounced' })),
      (error) => error === commitFailure,
    );
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      'sent COMMIT',
      'failed COMMIT',
      'sent ROLLBACK',
      'returned ROLLBACK',
      'released',
    ]);
    assert.equal(releasedWith(), undefined);
  });

  it('rolls a refused outcome back and wakes nobody', async () => {
    const { pool, log } = fakePool();

    const value = await inTransaction(pool, async () => ({ commit: false, value: 'refused' }));

    assert.equal(value, 'refused');
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      'sent ROLLBACK',
      'returned ROLLBACK',
      'released',
    ]);
  });

  it('runs the step a refused outcome asks for once ROLLBACK has returned, then wakes the readers once', async () => {
    const { pool, log } = fakePool();

    const value = await inTransaction(pool, async () => ({
      commit: false,
      value: 'not found',
      afterRollback: async (client) => {
        await client.query(APPEND);
      },
    }));

    assert.equal(value, 'not found');
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      'sent ROLLBACK',
      'returned ROLLBACK',
      `sent ${APPEND}`,
      `returned ${APPEND}`,
      'read',
      'woken',
      'released',
    ]);
  });

  it('rolls back on a throw, rethrows the original error and returns the connection to the pool', async () => {
    const { pool, log, releasedWith } = fakePool();
    const thrown = new Error('the work failed');

    await assert.rejects(
      inTransaction(pool, async (client) => {
        await client.query(APPEND);
        throw thrown;
      }),
      (error) => error === thrown,
    );
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      `sent ${APPEND}`,
      `returned ${APPEND}`,
      'sent ROLLBACK',
      'returned ROLLBACK',
      'released',
    ]);
    assert.equal(releasedWith(), undefined);
  });

  it('discards a connection whose ROLLBACK fails as well, releasing it with that failure, and still rethrows the original error', async () => {
    const rollbackFailure = new Error('the rollback failed');
    const { pool, log, releasedWith } = fakePool({ ROLLBACK: [rollbackFailure] });
    const thrown = new Error('the work failed');

    await assert.rejects(
      inTransaction(pool, async () => {
        throw thrown;
      }),
      (error) => error === thrown,
    );
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      'sent ROLLBACK',
      'failed ROLLBACK',
      'released, discarded',
    ]);
    assert.equal(releasedWith(), rollbackFailure);
  });

  it('wakes nobody when COMMIT fails, and its error reaches the caller', async () => {
    const commitFailure = new Error('the commit failed');
    const { pool, log, releasedWith } = fakePool({ COMMIT: [commitFailure] });

    await assert.rejects(
      inTransaction(pool, async (client) => {
        await client.query(APPEND);

        return { commit: true, value: 'done' };
      }),
      (error) => error === commitFailure,
    );
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      `sent ${APPEND}`,
      `returned ${APPEND}`,
      'sent COMMIT',
      'failed COMMIT',
      'sent ROLLBACK',
      'returned ROLLBACK',
      'released',
    ]);
    assert.equal(releasedWith(), undefined);
  });

  it('tries the ROLLBACK of a refused outcome once more when it fails, discards the connection when that fails too, and wakes nobody', async () => {
    const first = new Error('the rollback failed');
    const second = new Error('the rollback failed again');
    const { pool, log, releasedWith } = fakePool({ ROLLBACK: [first, second] });

    await assert.rejects(
      inTransaction(pool, async () => ({
        commit: false,
        value: 'refused',
        afterRollback: async () => undefined,
      })),
      (error) => error === first,
    );
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      'sent ROLLBACK',
      'failed ROLLBACK',
      'sent ROLLBACK',
      'failed ROLLBACK',
      'released, discarded',
    ]);
    assert.equal(releasedWith(), second);
  });

  it('wakes nobody when the step after the rollback fails, and its error reaches the caller', async () => {
    const appendFailure = new Error('the append failed');
    const { pool, log, releasedWith } = fakePool({ [APPEND]: [appendFailure] });

    await assert.rejects(
      inTransaction(pool, async () => ({
        commit: false,
        value: 'not found',
        afterRollback: async (client) => {
          await client.query(APPEND);
        },
      })),
      (error) => error === appendFailure,
    );
    assert.deepEqual(log, [
      'sent BEGIN',
      'returned BEGIN',
      'sent ROLLBACK',
      'returned ROLLBACK',
      `sent ${APPEND}`,
      `failed ${APPEND}`,
      'sent ROLLBACK',
      'returned ROLLBACK',
      'released',
    ]);
    assert.equal(releasedWith(), undefined);
  });
});

describe('a session’s deletion on it, against the database (D198, D221)', () => {
  let base: pg.Pool;
  const sessions: string[] = [];

  before(() => {
    base = createPool(loadConfig().databaseUrl);
  });

  after(async () => {
    if (sessions.length > 0) {
      await base.query('DELETE FROM realtime_events WHERE session_id = ANY($1)', [sessions]);
      await base.query('DELETE FROM sessions WHERE id = ANY($1)', [sessions]);
    }

    await base.end();
  });

  /** A session of this run that expires in an hour. */
  async function newSession(): Promise<string> {
    const id = randomBytes(32).toString('base64url');

    sessions.push(id);
    await base.query(
      "INSERT INTO sessions (id, expires_at) VALUES ($1, now() + interval '1 hour')",
      [id],
    );

    return id;
  }

  /**
   * Runs `run` on `base`, its connections' transaction statements and event
   * appends logged as they return, and the readers' wake-up in its place among
   * them. The observer is forgotten afterwards; no listener runs in this file,
   * so it is the pool's only one meanwhile.
   */
  async function recording<T>(run: (pool: pg.Pool, log: string[]) => Promise<T>): Promise<T> {
    const log: string[] = [];
    const named = (text: unknown): string | null =>
      text === APPEND_EVENT_SQL
        ? 'append'
        : text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK'
          ? text
          : null;
    const forward = <O extends object>(target: O, property: string | symbol): unknown => {
      const value = Reflect.get(target, property, target);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    };
    const pool = new Proxy(base, {
      get(target, property) {
        if (property !== 'connect') {
          return forward(target, property);
        }

        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;

          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty !== 'query') {
                return forward(clientTarget, clientProperty);
              }

              return async (...args: unknown[]) => {
                const answer = await query(...args);
                const name = named(args[0]);

                if (name !== null) {
                  log.push(name);
                }

                return answer;
              };
            },
          });
        };
      },
    });
    const observer = { poke: () => undefined, wake: () => log.push('woken') };

    observeCommits(pool, observer);

    try {
      return await run(pool, log);
    } finally {
      observeCommits(pool, observer, false);
    }
  }

  it('commits a deletion with its close and wakes the readers', async () => {
    const sessionId = await newSession();

    await recording(async (pool, log) => {
      assert.deepEqual(await deleteSession(pool, sessionId), {
        outcome: 'deleted',
        requestsHeld: 0,
      });
      assert.deepEqual(log, ['BEGIN', 'append', 'COMMIT', 'woken']);
    });
  });

  it('rolls back for a session not found, then writes its close on its own and wakes the readers', async () => {
    const sessionId = await newSession();

    await base.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    await recording(async (pool, log) => {
      assert.deepEqual(await deleteSession(pool, sessionId), { outcome: 'session-not-found' });
      assert.deepEqual(log, ['BEGIN', 'ROLLBACK', 'append', 'woken']);
    });

    const closes = await base.query(
      "SELECT 1 FROM realtime_events WHERE session_id = $1 AND kind = 'close'",
      [sessionId],
    );

    assert.equal(closes.rowCount, 1);
  });

  it('rolls back for an expired session and does nothing else', async (t) => {
    await withExpiredSession(t, base, newSession, (sessionId) =>
      recording(async (pool, log) => {
        assert.deepEqual(await deleteSession(pool, sessionId), { outcome: 'session-expired' });
        assert.deepEqual(log, ['BEGIN', 'ROLLBACK']);
      }),
    );
  });
});
