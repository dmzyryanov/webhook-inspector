/**
 * The addresses the browser smoke suite runs on (D108).
 *
 * A sibling of `database-url.ts`, and for the same reason: the suite drives a
 * whole stack, and every value that decides **which** stack it drives is
 * declared in one place rather than repeated wherever it happens to be needed.
 *
 * The addresses used to live in two files that knew nothing of each other.
 * `playwright.config.ts` started the suite's backend on a port and health-checked
 * it there, while `apps/frontend/vite.config.ts` separately named
 * `http://127.0.0.1:3000` as its proxy target. Nothing tied them, so changing
 * one and not the other produced a run in which Playwright verified its own
 * backend on one port while the browser was proxied into whatever else held the
 * other - a dev backend and the development database behind it. The run is
 * green and has tested the wrong system. Here there is one value, so the two
 * cannot disagree.
 *
 * The frontend must not import this module: it builds in its own Docker context
 * and cannot reach outside the workspace. The seam is the environment, and the
 * names of those variables are exported below so the two ends cannot drift
 * either.
 */

const DOCUMENTATION = 'docs/testing/browser-smoke.md';

/**
 * The environment variables `apps/frontend/vite.config.ts` reads. They have the
 * suite's defaults baked in over there, so `npm run dev:frontend` behaves
 * exactly as it did before they existed.
 */
export const BACKEND_ORIGIN_VARIABLE = 'WEBHOOK_INSPECTOR_BACKEND_ORIGIN';
export const FRONTEND_PORT_VARIABLE = 'WEBHOOK_INSPECTOR_FRONTEND_PORT';

/**
 * Both ports may be moved, but only **together**: each is read once here and
 * reaches the backend, the proxy, both readiness checks and `baseURL` from this
 * one value. Overriding one half of a pair, which is what made the old
 * arrangement dangerous, is no longer expressible.
 */
function port(variable: string, fallback: number): number {
  const value = process.env[variable];

  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `${variable} is "${value}", which is not a TCP port. Unset it to use ${fallback}. ` +
        `See ${DOCUMENTATION}.`,
    );
  }

  return parsed;
}

/** The port the suite's own backend listens on. */
export const BACKEND_PORT = port('E2E_BACKEND_PORT', 3000);

/** The port the suite's own Vite dev server listens on. */
export const FRONTEND_PORT = port('E2E_FRONTEND_PORT', 5173);

/**
 * The port the suite's own backend receives webhooks on: its second listener,
 * which serves `/s/` alone (D187). Webhooks are sent there directly, never
 * through the dev server: a proxy in front of a capture would rewrite the
 * headers the capture exists to show, which is why production's receive host
 * is a TCP route.
 */
export const RECEIVE_PORT = port('E2E_RECEIVE_PORT', 3001);

/*
 * Not `localhost`: it may resolve to ::1 while the servers are bound to
 * 127.0.0.1, and the suite would then wait for a server that is already
 * listening.
 */

/** The backend, reached directly - which no test does, only the setup check. */
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

/** The single origin the browser sees, exactly as in production (D047, D060). */
export const BASE_URL = `http://127.0.0.1:${FRONTEND_PORT}`;

/**
 * The receive listener's origin, which the backend is told is its public
 * receive origin, so every `receiveUrl` it gives names it (D187). The specs do
 * not import this module (see `playwright.setup.ts`); they read a session's
 * `receiveUrl` from the API, and the setup checks that it is this origin.
 */
export const RECEIVE_URL = `http://127.0.0.1:${RECEIVE_PORT}`;
