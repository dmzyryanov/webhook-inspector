import { expect, test, type Page } from '@playwright/test';
import { MAX_REALTIME_CONNECTIONS_PER_ADDRESS } from '@webhook-inspector/shared';
import { createSessionViaApi, receiveUrlOf, requestRow, storedRequestId } from './helpers.ts';

/**
 * E2E-19 — the View pages of one address within the realtime connections it
 * may hold (issue #145, D227).
 *
 * One address may have 16 realtime connections open at once; the 17th is
 * refused `429` / `1020` before its upgrade, which a browser sees as a failed
 * connection and the page retries as any interruption, with its growing
 * delay (D079). Every tab here comes from one address, the dev server's
 * proxy, as tabs behind one NAT come from one address in production.
 *
 * So: 16 tabs of one session are each subscribed, reconnect after their
 * sockets are cut all at once, and receive a capture live; a 17th tab is not
 * subscribed while the 16 are open, and gets in once one of them closes,
 * with no reload. The refusal's status and code are the backend suite's
 * (`modules/realtime/connection-cap.test.ts`); here it is the page's
 * behaviour around it.
 */

/** The session socket alone: Vite's HMR channel is a WebSocket too. */
const SESSION_SOCKET = /^\/ws\/[A-Za-z0-9_-]{43}$/;

/** How many `ready` frames each page has received on its session socket. */
function countReadies(page: Page, readies: Map<Page, number>): void {
  readies.set(page, 0);
  page.on('websocket', (socket) => {
    if (!SESSION_SOCKET.test(new URL(socket.url()).pathname)) {
      return;
    }

    socket.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string' && frame.payload.includes('"type":"ready"')) {
        readies.set(page, (readies.get(page) ?? 0) + 1);
      }
    });
  });
}

test('E2E-19 — 16 tabs of one address stay subscribed and reconnect, and a 17th gets in once one closes', async ({
  context,
  request,
}) => {
  test.setTimeout(150_000);
  expect(MAX_REALTIME_CONNECTIONS_PER_ADDRESS).toBe(16);

  const sessionId = await createSessionViaApi(request);
  const receiveUrl = await receiveUrlOf(request, sessionId);
  const readies = new Map<Page, number>();
  const pageErrors: Error[] = [];

  // Every WebSocket a page opens, so that the test can cut its session
  // socket as a network interruption would; the page's own code is untouched.
  await context.addInitScript(() => {
    const Native = window.WebSocket;
    const opened: WebSocket[] = [];

    (window as unknown as { __sessionSockets: WebSocket[] }).__sessionSockets = opened;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        opened.push(this);
      }
    };
  });

  const tabs: Page[] = [];

  for (let index = 0; index < MAX_REALTIME_CONNECTIONS_PER_ADDRESS; index += 1) {
    const page = await context.newPage();

    page.on('pageerror', (error) => pageErrors.push(error));
    countReadies(page, readies);
    await page.goto(`/v/${sessionId}`);
    tabs.push(page);
  }

  const subscribed = (pages: Page[], atLeast: (page: Page) => number) =>
    pages.filter((page) => (readies.get(page) ?? 0) >= atLeast(page)).length;

  // Each subscribed: a tab whose first attempt met a moment over the limit -
  // the development build opens and closes its socket once on mount - is
  // simply retried.
  await expect
    .poll(() => subscribed(tabs, () => 1), { timeout: 45_000, intervals: [250] })
    .toBe(16);

  // An interruption: every tab's session socket is cut at once, and every tab
  // reconnects and is subscribed again.
  const before = new Map(tabs.map((page) => [page, readies.get(page) ?? 0]));

  await Promise.all(
    tabs.map((page) =>
      page.evaluate(() => {
        for (const socket of (window as unknown as { __sessionSockets: WebSocket[] })
          .__sessionSockets) {
          if (new URL(socket.url).pathname.startsWith('/ws/') && socket.readyState === 1) {
            socket.close();
          }
        }
      }),
    ),
  );
  await expect
    .poll(() => subscribed(tabs, (page) => (before.get(page) ?? 0) + 1), {
      timeout: 45_000,
      intervals: [250],
    })
    .toBe(16);

  // Live again: a capture reaches every tab with no reload.
  const sent = await request.post(`${receiveUrl}?marker=tabs`, {
    headers: { 'content-type': 'application/json' },
    data: '{"marker":"tabs"}',
  });

  expect(sent.status()).toBe(200);

  const requestId = storedRequestId(sent);

  for (const page of tabs) {
    await expect(requestRow(page, requestId)).toBeVisible();
  }

  // A 17th tab is refused while the 16 are open: it shows the session and
  // its list, but is not subscribed.
  const extra = await context.newPage();

  extra.on('pageerror', (error) => pageErrors.push(error));
  countReadies(extra, readies);
  await extra.goto(`/v/${sessionId}`);
  await expect(requestRow(extra, requestId)).toBeVisible();
  await extra.waitForTimeout(3_000);
  expect(readies.get(extra)).toBe(0);

  // One of the 16 closes; the 17th gets in on one of its retries.
  await tabs[0]?.close();
  await expect
    .poll(() => readies.get(extra) ?? 0, { timeout: 45_000, intervals: [250] })
    .toBeGreaterThanOrEqual(1);

  expect(pageErrors).toEqual([]);
});
