/**
 * Proves, before a single test runs, that the browser and the suite are talking
 * to the **same** backend (D108).
 *
 * `app-address.ts` removes the drift between the two addresses; this removes
 * the assumption. Single-sourcing guarantees that the proxy target and the
 * readiness check were computed from one value, and nothing more: it cannot
 * know whether the dev server actually forwarded to the backend Playwright
 * started, or to something else that happened to be listening there and to
 * answer `/readyz` just as convincingly. That is the failure this file exists
 * to make impossible, because its symptom is a **passing** run against the
 * wrong system - and the wrong system is, in practice, a developer's own
 * backend and the database behind it.
 *
 * The proof is one value that only this backend can know: a session created
 * **directly** on it, asked for **through** the proxy. Same id, same backend.
 * Anything else aborts the run and names both addresses, because the whole
 * point is to say which two things disagree.
 *
 * It needs no fixture beyond the database the suite already migrated, and the
 * session it creates is an ordinary one that expires on its own.
 *
 * **Why this file is here and not in `e2e/`.** `e2e/package.json` declares
 * `"type": "module"`, so everything under that directory is loaded as ESM, while
 * `playwright.config.ts` at the root is loaded as CommonJS. Playwright caches one
 * transform per file, so a module imported from **both** sides - which
 * `app-address.ts` would be - is loaded once in the wrong mode and fails with
 * `does not provide an export named …`. Sitting beside the config keeps both
 * importers in one mode. It belongs to the runner's configuration rather than to
 * the journeys anyway, and it is named to say so.
 */
import { request } from '@playwright/test';
import { BACKEND_URL, BASE_URL, RECEIVE_URL } from './e2e/app-address.ts';

const DOCUMENTATION = 'docs/testing/browser-smoke.md';

/** Said the same way whichever step failed, so both addresses are always named. */
function wrongSystem(detail: string): Error {
  return new Error(
    `The browser smoke suite is not pointed at its own backend.\n` +
      `  backend, directly:   ${BACKEND_URL}\n` +
      `  through the proxy:   ${BASE_URL}\n` +
      `${detail}\n` +
      `The dev server's proxy target and the suite's backend come from one value ` +
      `(e2e/app-address.ts), so this means something else is answering on one of those ` +
      `addresses. See ${DOCUMENTATION}.`,
  );
}

export default async function proxyIdentity(): Promise<void> {
  const api = await request.newContext();

  try {
    const created = await api.post(`${BACKEND_URL}/api/sessions`);

    if (created.status() !== 201) {
      throw wrongSystem(
        `Creating a session directly on the backend answered ${created.status()}, not 201.`,
      );
    }

    const { id } = (await created.json()) as { id: string };

    // The same session, asked for over the origin the browser uses. Only the
    // backend that stored it a moment ago can answer with it.
    const seen = await api.get(`${BASE_URL}/api/sessions/${id}`);

    if (seen.status() !== 200) {
      throw wrongSystem(
        `The session created directly on the backend answered ${seen.status()} through the proxy. ` +
          `A backend holding a different database answers 404 here.`,
      );
    }

    const echoed = (await seen.json()) as { id: string; receiveUrl?: string };

    if (echoed.id !== id) {
      throw wrongSystem(`The proxy returned session "${echoed.id}" for a request for "${id}".`);
    }

    // The receive listener (D187): the backend names it as `receiveUrl`, and a
    // webhook sent there is captured into this very session, which only the
    // same backend's receive listener can do.
    const receiveUrl = `${RECEIVE_URL}/s/${id}`;

    if (echoed.receiveUrl !== receiveUrl) {
      throw wrongSystem(
        `The session's receiveUrl is "${String(echoed.receiveUrl)}", not "${receiveUrl}".`,
      );
    }

    const captured = await api.post(receiveUrl, { data: 'playwright.setup' });

    if (captured.status() !== 200) {
      throw wrongSystem(`A webhook to ${receiveUrl} answered ${captured.status()}, not 200.`);
    }

    const counted = (await (await api.get(`${BASE_URL}/api/sessions/${id}`)).json()) as {
      requestsCount: number;
    };

    if (counted.requestsCount !== 1) {
      throw wrongSystem(
        `A webhook to ${receiveUrl} was answered, but the session holds ` +
          `${counted.requestsCount} requests: the receive port is another backend's.`,
      );
    }

    // And `/s/` through the browser's origin is production's qa-tools.ru: it
    // receives nothing and answers 410 / 1009.
    const moved = await api.post(`${BASE_URL}/s/${id}`, { data: 'playwright.setup' });
    const movedBody = (await moved.json().catch(() => ({}))) as { errorCode?: number };

    if (moved.status() !== 410 || movedBody.errorCode !== 1009) {
      throw wrongSystem(
        `/s/ through the proxy answered ${moved.status()} with errorCode ` +
          `${String(movedBody.errorCode)}, not 410 with 1009.`,
      );
    }
  } finally {
    await api.dispose();
  }
}
