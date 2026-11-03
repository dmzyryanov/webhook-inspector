// First: production's operator settings (#369), which the suite's processes
// and the dev server it starts read from the environment, before any module
// of the frontend is loaded.
import './apps/frontend/src/testing/production-operator-env.ts';
import { defineConfig, devices } from '@playwright/test';
import {
  BACKEND_ORIGIN_VARIABLE,
  BACKEND_PORT,
  BACKEND_URL,
  BASE_URL,
  FRONTEND_PORT,
  FRONTEND_PORT_VARIABLE,
  RECEIVE_PORT,
  RECEIVE_URL,
} from './e2e/app-address.ts';
import { e2eDatabaseUrl } from './e2e/database-url.ts';

/**
 * The browser smoke suite: three journeys through a real browser, a real
 * backend and a real database (D108), and E2E-04, the API reference at /docs
 * (D155), E2E-05, read state across the tabs of one browser (D156), and
 * E2E-06, a request the detail panel cannot draw (D169), E2E-07, a
 * receive URL answering HTML, SVG or XML that runs no script (D179),
 * E2E-08, the request list's filter (D180, D191), E2E-09, a link to one
 * request (D182), E2E-10, the changelog page (D184), E2E-11, comparing
 * two requests (D186), E2E-12, checking a signature in the browser
 * (D197), E2E-13, the home page's list of sessions (D199), E2E-14,
 * `Generate URL` that creates nothing (issue #128), E2E-15, the about
 * page (D211), E2E-16, the Terms of Use and the Privacy Policy (D217),
 * E2E-17, the Russian interface and its `EN | RU` switch (D222),
 * E2E-18, the Russian home page at `/ru/` (D226), E2E-19, the View
 * pages of one address within its realtime connections (D227), and
 * E2E-20, the new session's options on the home page (D249).
 * `docs/testing/browser-smoke.md` describes
 * how to run it and where to look when it fails.
 *
 * The backend is started from TypeScript source on Node 24, exactly as
 * production starts it (D051, D052), and the frontend by the Vite dev server,
 * whose proxy is the documented reproduction of production's single origin
 * (D047, D060). The production bundle is therefore not exercised here; the
 * image build already proves it builds (D094).
 *
 * **Every address in this file comes from `e2e/app-address.ts`** — the port the
 * backend is started on, both readiness URLs, the dev server's port and proxy
 * target, and `baseURL`. `globalSetup` then proves that the origin the browser
 * uses really reaches the backend started here. Together those are what stop a
 * green run against a system that is not this one.
 */

const databaseUrl = e2eDatabaseUrl();

export default defineConfig({
  testDir: './e2e',
  // One browser at a time, in order, with no retries. A retry would turn the
  // realtime race this suite exists to catch into an intermittent pass, and two
  // workers would share one backend, one database and one pair of ports.
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  globalTimeout: 10 * 60_000,
  outputDir: 'test-results',
  // Runs after both servers above are up and before any test: it proves the
  // proxy actually reaches the backend this file started, which single-sourcing
  // the addresses alone cannot.
  globalSetup: './playwright.setup.ts',
  reporter: [
    ['list'],
    // Read by GitLab's Tests tab; the HTML report is the artifact a human opens.
    ['junit', { outputFile: 'e2e-results/junit.xml' }],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    // Diagnostics for a failure, never a pass/fail criterion: nothing in this
    // suite compares pixels.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ...(process.env.CI ? { launchOptions: { args: ['--no-sandbox'] } } : {}),
  },
  // Chromium alone. Cross-browser coverage is an explicit non-goal.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The size the design is drawn at, and the measurements are taken at.
        // The request list is a fixed 430 px column, so the default 1280x720 is
        // a different layout rather than the same one scaled.
        viewport: { width: 1440, height: 1024 },
        // The interface follows the browser's languages on a first visit
        // (D222), so the suite pins the one it is written in: every journey
        // reads the English interface, whatever the machine's locale.
        // E2E-17 opens contexts of its own in `ru-RU` and `de-DE`, and
        // E2E-18 one in `ru-RU`.
        locale: 'en-US',
      },
    },
  ],
  webServer: [
    {
      // A bare `node`, not `npm start -w @webhook-inspector/backend` and not
      // `npm run dev:backend`: both run `node --env-file-if-exists=../../.env`,
      // which would re-read the developer's `.env` and could point this backend
      // at the database the application is being developed against.
      command: 'node apps/backend/src/index.ts',
      env: {
        DATABASE_URL: databaseUrl,
        BACKEND_HOST: '127.0.0.1',
        BACKEND_PORT: String(BACKEND_PORT),
        // The receive listener, reached directly as production's receive
        // host is, without PROXY protocol, which only Traefik's TCP route
        // speaks (D187). Its origin is what every `receiveUrl` names.
        RECEIVE_PORT: String(RECEIVE_PORT),
        RECEIVE_ORIGIN: RECEIVE_URL,
        RECEIVE_PROXY_PROTOCOL: 'off',
        // Ten times the production limits per address (D201). Every call of
        // the suite comes from one address, faster than any person makes
        // them: on 2026-10-05 a run at the production numbers created 35
        // sessions and made 470 other calls within one minute, with no
        // refusal, so the margin to 60 is the suite's growth. The production
        // numbers are tested where they are enforced, in the backend suite.
        RATE_LIMIT_SESSION_CREATES_PER_MINUTE: '600',
        RATE_LIMIT_API_CALLS_PER_MINUTE: '12000',
      },
      // Readiness, not liveness: `/readyz` answers 503 until `SELECT 1`
      // succeeds, so the suite starts only once the database is actually
      // reachable (D086). The backend opens its receive listener before this
      // one, so the receive port is open by then too (D187).
      url: `${BACKEND_URL}/readyz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npm run dev -w @webhook-inspector/frontend -- --host 127.0.0.1 --port ${FRONTEND_PORT} --strictPort`,
      // The proxy target, from the same value that started the backend above.
      // `vite.config.ts` must not import from `e2e/` - the frontend workspace
      // builds in its own Docker context and cannot reach outside it - so the
      // environment is the seam, and both ends read its name from one module.
      env: {
        [BACKEND_ORIGIN_VARIABLE]: BACKEND_URL,
        [FRONTEND_PORT_VARIABLE]: String(FRONTEND_PORT),
      },
      url: BASE_URL,
      // Never reused, in CI or locally. A dev server already on this port is
      // proxying to a backend holding a different database, and the suite would
      // silently test that instead.
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
