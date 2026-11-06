/**
 * Applies the schema to the browser smoke suite's own database (D108).
 *
 * This exists instead of `npm run db:migrate` because that script loads
 * `.env`, which carries the connection URL of the database the application
 * is being developed against. Here the URL is taken from
 * `E2E_DATABASE_URL`, checked, and handed to the ordinary migration runner as
 * the only `DATABASE_URL` it can see.
 */
import { e2eDatabaseUrl } from './database-url.ts';

process.env.DATABASE_URL = e2eDatabaseUrl();

// The migration runner is a top-level script: importing it applies the pending
// migrations and closes its connection.
await import('../apps/backend/src/db/migrate.ts');
