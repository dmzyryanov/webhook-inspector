/**
 * The migration runner (`migrations.ts`, D055): each migration in a
 * transaction of its own, recorded only once it has committed, and - since
 * #132, when a migration may run while the previous image still serves - with
 * a lock timeout, so that a statement that cannot have its lock within 5 s
 * fails and is rolled back rather than holding every query queued behind it
 * (D221).
 *
 * Runs migrations of its own, from a temporary directory, against a table of
 * its own on the task's database; they are recorded under names no real
 * migration has, and removed afterwards.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { loadConfig } from '../config.ts';
import { applyMigrations, MIGRATION_LOCK_TIMEOUT } from './migrations.ts';

const runId = randomUUID().replaceAll('-', '');
const TABLE = `migration_probe_${runId}`;
const NAME = `999_migration_probe_${runId}.sql`;

let directory: string;
let holder: pg.Client;
let runner: pg.Client;

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    directory = await mkdtemp(join(tmpdir(), 'webhook-inspector-migrations-'));
    holder = new pg.Client({ connectionString: loadConfig().databaseUrl });
    runner = new pg.Client({ connectionString: loadConfig().databaseUrl });
    await holder.connect();
    await runner.connect();
    await holder.query(`CREATE TABLE ${TABLE} (id int)`);
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);
  await holder?.query('ROLLBACK').catch(() => undefined);
  await holder?.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await holder?.query('DELETE FROM schema_migrations WHERE name = $1', [NAME]);
  await holder?.end();
  await runner?.end();
  await rm(directory, { recursive: true, force: true });
});

async function recorded(): Promise<boolean> {
  const { rowCount } = await holder.query('SELECT 1 FROM schema_migrations WHERE name = $1', [
    NAME,
  ]);

  return rowCount === 1;
}

describe('the migration runner (D055, D221)', () => {
  it('waits at most 5 s for a lock: a migration held off longer fails, is rolled back and is not recorded', async () => {
    assert.equal(MIGRATION_LOCK_TIMEOUT, '5s');
    await writeFile(join(directory, NAME), `ALTER TABLE ${TABLE} ADD COLUMN probe int;`);

    // What the previous image's queries would hold: a lock the ALTER waits for.
    await holder.query('BEGIN');
    await holder.query(`LOCK TABLE ${TABLE} IN ACCESS SHARE MODE`);

    const started = Date.now();
    const running = applyMigrations(runner, directory, () => undefined);
    // Without a lock timeout the ALTER would wait for as long as the lock is
    // held: past 15 s the test fails with a message instead, and lets it go.
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const held = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('The migration was still waiting for its lock after 15 s'));
      }, 15_000);
    });

    try {
      await assert.rejects(Promise.race([running, held]), (error: Error) => {
        assert.match(error.message, new RegExp(`Migration ${NAME} failed and was rolled back`));
        assert.match(String((error.cause as Error | undefined)?.message), /lock timeout/);

        return true;
      });
    } finally {
      clearTimeout(timer);

      if (timedOut) {
        const waiting = (runner as { processID?: number | null }).processID;

        await holder.query('SELECT pg_cancel_backend($1)', [waiting]);
      }

      await running.catch(() => undefined);
      await holder.query('ROLLBACK');
    }

    const took = Date.now() - started;

    assert.ok(took >= 4_500 && took < 15_000, `failed after ${took} ms`);
    assert.equal(await recorded(), false);

    const { rows } = await holder.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'probe'`,
      [TABLE],
    );

    assert.equal(rows[0]?.count, 0, 'the failed migration left its column');
  });

  it('applies it once the lock is free, and records it', async () => {
    const lines: string[] = [];

    await applyMigrations(runner, directory, (line) => lines.push(line));
    assert.ok(lines.includes(`Applied ${NAME}`), lines.join('\n'));
    assert.equal(await recorded(), true);

    // Run again, it applies nothing.
    lines.length = 0;
    await applyMigrations(runner, directory, (line) => lines.push(line));
    assert.deepEqual(lines, ['Schema is up to date (1 migrations applied).']);
  });
});
