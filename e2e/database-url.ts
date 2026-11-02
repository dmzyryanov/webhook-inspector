/**
 * The database the browser smoke suite is allowed to touch (D108).
 *
 * The suite deletes requests and creates sessions, so it must never run against
 * the database a developer is working in. Two rules make that hard to get wrong
 * by accident:
 *
 * - the URL comes from `E2E_DATABASE_URL` and from nowhere else. `DATABASE_URL`
 *   is deliberately not read and not fallen back to: an exported value meant for
 *   the running application is not consent to run a destructive suite against
 *   it;
 * - the database it names must be `webhook_inspector_e2e`. Pointing the variable at the
 *   development database is refused rather than obeyed.
 */

/** The only database name the suite accepts. */
const REQUIRED_DATABASE = 'webhook_inspector_e2e';

const DOCUMENTATION = 'docs/testing/browser-smoke.md';

export function e2eDatabaseUrl(): string {
  const value = process.env.E2E_DATABASE_URL;

  if (!value) {
    throw new Error(
      `E2E_DATABASE_URL is not set. The browser smoke suite runs against its own ${REQUIRED_DATABASE} ` +
        `database and never reads DATABASE_URL. See ${DOCUMENTATION} for the one-liner that creates it.`,
    );
  }

  let database: string;

  try {
    database = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`E2E_DATABASE_URL is not a valid connection URL. See ${DOCUMENTATION}.`);
  }

  if (database !== REQUIRED_DATABASE) {
    throw new Error(
      `E2E_DATABASE_URL names the database "${database}", and the browser smoke suite only runs ` +
        `against "${REQUIRED_DATABASE}". The suite deletes requests, so it must not be pointed at a ` +
        `database anything else is using. See ${DOCUMENTATION}.`,
    );
  }

  return value;
}
