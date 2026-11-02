/**
 * Applies pending SQL migrations: the files in `apps/backend/migrations`, in
 * filename order, each in a transaction of its own and with a lock timeout
 * (`migrations.ts`, D055, D221). `npm run db:migrate` and the backend's init
 * container run it.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from './migrations.ts';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and start the database.');
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await applyMigrations(client, migrationsDirectory, (line) => console.log(line));
} finally {
  await client.end();
}
