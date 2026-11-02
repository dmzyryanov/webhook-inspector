/**
 * Holding a session row's lock for real, for the tests that show two writers
 * of a session serialising on it (D065, D150, D205): a pool that pauses one
 * transaction at its `COMMIT`, and a wait until PostgreSQL reports another
 * backend blocked behind it. And a pool that lets one `COMMIT` run and holds
 * back only its answer, for the tests of the order the writers publish in
 * (`RealtimeHub.inOrder`, D205). And every connection of a pool held at
 * once, for the tests that show capture and readiness served while the API's
 * pool has none to lend (D244).
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';

/**
 * A pool that stops the first transaction to reach `COMMIT` until the test
 * lets it go, with its row lock still held, and reports the backend that holds
 * it. Everything else runs normally.
 */
export function poolPausingFirstCommit(base: pg.Pool): {
  pool: pg.Pool;
  holder: Promise<number>;
  release: () => void;
} {
  let paused = false;
  let reportHolder: (pid: number) => void = () => undefined;
  let release: () => void = () => undefined;
  const holder = new Promise<number>((resolve) => {
    reportHolder = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const forward = <T extends object>(target: T, property: string | symbol): unknown => {
    const value = Reflect.get(target, property, target);

    return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
  };

  const proxied = new Proxy(base, {
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
              if (args[0] === 'COMMIT' && !paused) {
                paused = true;

                const pid = (await query('SELECT pg_backend_pid() AS pid')) as {
                  rows: { pid: number }[];
                };

                reportHolder((pid.rows[0] as { pid: number }).pid);
                await released;
              }

              return query(...args);
            };
          },
        });
      };
    },
  });

  return { pool: proxied, holder, release };
}

/**
 * A pool that lets the first transaction to reach `COMMIT` commit, and holds
 * back the answer to that `COMMIT` until the test lets it go: the change is in
 * the database and the session row's lock is free, while the call that made
 * it has not yet seen it commit, so has not yet published. That is the moment
 * between a capture's commit and its publish (D205). `committed` resolves once
 * the `COMMIT` has run. Everything else runs normally.
 */
export function poolHoldingFirstCommitAnswer(base: pg.Pool): {
  pool: pg.Pool;
  committed: Promise<void>;
  release: () => void;
} {
  let holding = false;
  let reportCommitted: () => void = () => undefined;
  let release: () => void = () => undefined;
  const committed = new Promise<void>((resolve) => {
    reportCommitted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const forward = <T extends object>(target: T, property: string | symbol): unknown => {
    const value = Reflect.get(target, property, target);

    return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
  };

  const proxied = new Proxy(base, {
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
              if (args[0] === 'COMMIT' && !holding) {
                holding = true;

                const answer = await query(...args);

                reportCommitted();
                await released;

                return answer;
              }

              return query(...args);
            };
          },
        });
      };
    },
  });

  return { pool: proxied, committed, release };
}

/** Waits until some backend is blocked on a lock the given backend holds. */
export async function awaitBlockedBy(pool: pg.Pool, holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const result = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );

    if ((result.rows[0]?.waiting ?? 0) > 0) {
      return;
    }

    await delay(2);
  }

  throw new Error('nothing ever waited on the held session row');
}

/**
 * Takes every connection `pool` may open (`max`) and keeps them until
 * `release`, so that anything else asking the pool for one waits (D244).
 */
export async function holdEveryConnection(pool: pg.Pool): Promise<{ release: () => void }> {
  const clients = await Promise.all(
    Array.from({ length: pool.options.max ?? 10 }, () => pool.connect()),
  );

  return {
    release: () => {
      for (const client of clients.splice(0)) {
        client.release();
      }
    },
  };
}
