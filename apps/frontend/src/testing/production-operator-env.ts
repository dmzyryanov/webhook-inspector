import process from 'node:process';

/**
 * Production's operator settings (issue #369), as `.gitlab-ci.yml` gives
 * them to production's image build, put into this process's environment.
 * The repository's sources fall back to none of them (`src/lib/operator.ts`):
 * a build without them leaves the status page, the contact address and the
 * operator's texts out. The frontend suite and the browser suite test
 * production's pages, so both supply them, the way the image build does,
 * through the environment:
 *
 * - the frontend suite loads this module first, with `--import`, in every
 *   test file's process (`package.json`'s `test`), so the environment holds
 *   them before any module reads `OPERATOR`; a test of a build without them,
 *   or with others, gives that build an environment of its own;
 * - `playwright.config.ts` imports it before anything else, so the suite's
 *   processes and the dev server it starts, which inherits their
 *   environment, have them too.
 *
 * It imports nothing of the application, which would read the environment
 * before this has set it. Every value replaces whatever the environment
 * held, so a developer's shell cannot change what the suites test.
 */
export const PRODUCTION_OPERATOR_ENV = Object.freeze({
  STATUS_PAGE_URL: 'https://status.qa-tools.ru/',
  CONTACT_EMAIL: 'contact@qa-tools.ru',
  OPERATOR_TEXTS: 'true',
});

Object.assign(process.env, PRODUCTION_OPERATOR_ENV);
