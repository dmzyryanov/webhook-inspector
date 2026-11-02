/**
 * The migration runner's work, apart from its command line (`migrate.ts`), so
 * that a test can run it against a directory of its own.
 *
 * Migrations are plain `.sql` files, applied in filename order. Applied names
 * are recorded in `schema_migrations` so that running this repeatedly is safe:
 * only new files execute (D055).
 *
 * Each migration runs inside its own transaction. A failing migration is rolled
 * back completely and is not recorded, so it will be retried on the next run.
 *
 * Each also waits at most `MIGRATION_LOCK_TIMEOUT` for a lock (D221): a
 * migration runs in the new pod's init container, since 0.54.1 while the
 * previous image still serves, and a statement queued behind that image's
 * transactions would hold every query queued behind it in turn. One that
 * cannot have its lock within 5 s fails, is rolled back, and the init
 * container is run again.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/** How long a migration's statement may wait for a lock before the migration fails (D221). */
export const MIGRATION_LOCK_TIMEOUT = '5s';

/** Applies the pending migrations of `directory`, and reports each name it applies. */
export async function applyMigrations(
  client: pg.Client,
  directory: string,
  report: (line: string) => void,
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
  const alreadyApplied = new Set(applied.rows.map((row) => row.name));

  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

  const pending = files.filter((name) => !alreadyApplied.has(name));

  if (pending.length === 0) {
    report(`Schema is up to date (${files.length} migrations applied).`);
  }

  for (const name of pending) {
    const sql = await readFile(join(directory, name), 'utf8');

    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${name} failed and was rolled back.`, { cause: error });
    }

    report(`Applied ${name}`);
  }
}
