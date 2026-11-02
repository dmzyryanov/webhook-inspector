import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  createSessionViaApi,
  readReceiveUrl,
  receiveUrlOf,
  requestRow,
  storedRequestId,
} from './helpers.ts';

/** The owner's wording for the depth limit (issue #59, D169). */
const JSON_TOO_DEEP =
  'Formatting unavailable: JSON nested more than 100 levels deep is shown as stored.';

/** The panel's error state, as a failed load has always drawn it (D072). */
const LOAD_FAILED = 'Could not load request details';
const LOAD_FAILED_NOTE = 'Your selected request is still in the list.';

/**
 * How React reports an error that `RenderBoundary` caught, in the development
 * build the dev server serves: the console error ends `React will try to
 * recreate this component tree from scratch using the error boundary you
 * provided, RenderBoundary.`
 *
 * A drawing failure and a failed load draw the same state, so the state on
 * screen cannot say which one happened. This can: a failed load is never
 * caught by the boundary. Without it, an answer that stopped loading would
 * keep this spec green with the boundary gone.
 */
const CAUGHT_BY_BOUNDARY = /error boundary you provided, RenderBoundary\./;

/** How many of those reports the page has written so far. */
function countBoundaryCatches(page: Page): () => number {
  let count = 0;

  page.on('console', (message) => {
    if (message.type() === 'error' && CAUGHT_BY_BOUNDARY.test(message.text())) {
      count += 1;
    }
  });

  return () => count;
}

/**
 * The panel shows its error state because `RenderBoundary` caught a drawing
 * error, reported after `before` - not because the load failed.
 */
async function expectDrawingFailed(
  page: Page,
  catches: () => number,
  before: number,
): Promise<void> {
  await expect(page.getByText(LOAD_FAILED)).toBeVisible();
  await expect.poll(catches, { message: 'RenderBoundary caught nothing' }).toBeGreaterThan(before);
}

/** Sends `body` to the session with `?marker=<marker>`, and answers the stored id. */
async function send(
  request: APIRequestContext,
  sessionId: string,
  marker: string,
  body: string,
): Promise<string> {
  const sent = await request.post(`${await receiveUrlOf(request, sessionId)}?marker=${marker}`, {
    headers: { 'content-type': 'application/json' },
    data: body,
  });

  expect(sent.status()).toBe(200);

  return storedRequestId(sent);
}

/** A value that only survives while the page is never reloaded. */
async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __notReloaded?: boolean }).__notReloaded = true;
  });
}

async function expectNotReloaded(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded),
  ).toBe(true);
}

/** The panel is showing the request sent with `?marker=<marker>`. */
async function expectShowing(page: Page, sessionId: string, marker: string): Promise<void> {
  await expect(page.getByTestId('detail-target')).toHaveText(`/s/${sessionId}?marker=${marker}`);
  await expect(page.getByRole('tabpanel', { name: 'Raw' })).toContainText(`{"marker":"${marker}"}`);
  await expect(page.getByText(LOAD_FAILED)).toHaveCount(0);
}

/** Everything around the panel is still on screen, the rows included. */
async function expectPageAround(page: Page, rowIds: string[]): Promise<void> {
  await expect(page.getByRole('banner')).toContainText('Changelog');
  await expect(page.getByTestId('receive-url')).toBeVisible();

  for (const id of rowIds) {
    await expect(requestRow(page, id)).toBeVisible();
  }
}

/**
 * E2E-06 — a request the detail panel cannot draw costs the panel, never the
 * page (issue #59, D169).
 *
 * First the issue's own body: 20 000 nested arrays, 40 KB, which used to throw
 * `RangeError: Invalid string length` in the JSON formatter and blank the page
 * as soon as the request was selected. It is now shown as stored, with its line.
 *
 * Then the boundary itself, which needs a request whose drawing throws. After
 * this change no body is known to do that, so the API answer is changed on its
 * way to the page: one request's detail arrives with `headers: null`, which
 * throws while its blocks are built - an exception in rendering, as the deep
 * JSON was. The panel must show its `Could not load request details` state,
 * with the header, the endpoint card and the list still there; another request
 * must open normally; and `Retry` must draw the same request again from a
 * fresh copy, back to the error state while it still throws and to its details
 * once it does not. Each time the state appears, the boundary must have
 * reported catching the error (`CAUGHT_BY_BOUNDARY`).
 */
test('A request the panel cannot draw leaves the rest of the page working', async ({
  page,
  request,
}) => {
  const sessionId = await createSessionViaApi(request);
  const deepBody = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
  const deepId = await send(request, sessionId, 'deep', deepBody);
  const brokenId = await send(request, sessionId, 'broken', '{"marker":"broken"}');
  const otherId = await send(request, sessionId, 'other', '{"marker":"other"}');
  const rowIds = [deepId, brokenId, otherId];

  // Each answer for `broken` is fetched from the real backend and, while
  // `drawable` is false, handed to the page with its headers taken away.
  let drawable = false;
  let brokenLoads = 0;

  await page.route(`**/api/sessions/${sessionId}/requests/${brokenId}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();

      return;
    }

    brokenLoads += 1;

    const response = await route.fetch();
    const details = (await response.json()) as Record<string, unknown>;

    await route.fulfill({ response, json: drawable ? details : { ...details, headers: null } });
  });

  const pageErrors: Error[] = [];

  page.on('pageerror', (error) => pageErrors.push(error));

  const catches = countBoundaryCatches(page);

  await page.goto(`/v/${sessionId}`);
  await readReceiveUrl(page);
  await expectPageAround(page, rowIds);
  await markPage(page);

  // The issue's body: shown as stored under its own line, not re-indented, and
  // the page is still whole.
  await requestRow(page, deepId).click();
  await expect(page.getByTestId('detail-target')).toHaveText(`/s/${sessionId}?marker=deep`);
  await page.getByRole('tab', { name: 'Body' }).click();

  const bodyPanel = page.getByRole('tabpanel', { name: 'Body' });

  await expect(bodyPanel.getByText(JSON_TOO_DEEP)).toBeVisible();
  await expect(bodyPanel.getByTestId('block-content')).toHaveText(deepBody);
  await expectPageAround(page, rowIds);
  // Shown as stored, so nothing was caught on the way.
  expect(catches()).toBe(0);

  // A request whose drawing throws: the panel's error state, and nothing else
  // on the page goes with it.
  await requestRow(page, brokenId).click();
  await expectDrawingFailed(page, catches, 0);
  await expect(page.getByText(LOAD_FAILED_NOTE)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByTestId('detail-target')).toHaveCount(0);
  await expectPageAround(page, rowIds);
  await expect(requestRow(page, brokenId).locator('xpath=..')).toHaveClass(/bg-row-selected/);
  expect(brokenLoads).toBe(1);

  // Another request opens normally.
  await requestRow(page, otherId).click();
  await expectShowing(page, sessionId, 'other');

  // `Retry` draws the same request again from a fresh copy: back to the error
  // state while it still throws...
  let before = catches();

  await requestRow(page, brokenId).click();
  await expectDrawingFailed(page, catches, before);
  expect(brokenLoads).toBe(2);

  before = catches();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => brokenLoads).toBe(3);
  await expectDrawingFailed(page, catches, before);

  // ...and to its details once it does not.
  drawable = true;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expectShowing(page, sessionId, 'broken');
  expect(brokenLoads).toBe(4);
  await expectPageAround(page, rowIds);

  await expectNotReloaded(page);
  // Caught by the panel, so never an uncaught error of the page.
  expect(pageErrors).toEqual([]);
});

/**
 * The same on a phone, where the panel is the whole screen under the Back bar
 * (frame 3I): the error state sits under `‹ Requests`, which still returns to
 * the list, and the next request opens normally (D157).
 */
test('On a phone the error state keeps the Back bar and the list', async ({ page, request }) => {
  const sessionId = await createSessionViaApi(request);
  const brokenId = await send(request, sessionId, 'broken', '{"marker":"broken"}');
  const otherId = await send(request, sessionId, 'other', '{"marker":"other"}');

  await page.route(`**/api/sessions/${sessionId}/requests/${brokenId}`, async (route) => {
    const response = await route.fetch();
    const details = (await response.json()) as Record<string, unknown>;

    await route.fulfill({ response, json: { ...details, headers: null } });
  });

  const pageErrors: Error[] = [];

  page.on('pageerror', (error) => pageErrors.push(error));

  const catches = countBoundaryCatches(page);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/v/${sessionId}`);
  await markPage(page);

  await requestRow(page, brokenId).click();

  const back = page.getByRole('button', { name: 'Back to Requests' });

  await expect(back).toBeVisible();
  await expectDrawingFailed(page, catches, 0);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

  await back.click();
  await expect(requestRow(page, otherId)).toBeVisible();
  await expect(page.getByText(LOAD_FAILED)).toBeHidden();

  await requestRow(page, otherId).click();
  await expectShowing(page, sessionId, 'other');

  await expectNotReloaded(page);
  expect(pageErrors).toEqual([]);
});

/**
 * E2E-06, issue #245: an address the answers give in a shape the contract
 * does not allow reads as a missing one does, `IP unavailable`, and costs
 * nothing else. The list answer is changed on its way to the page so three
 * requests' `sourceIp` are `123`, `{}` and `[]`, and so is each one's detail
 * answer. Before the fix each blanked the page as the list drew: the number
 * and the object with `sourceIp.slice is not a function`, the array with
 * `text.toLowerCase is not a function` in the filter's row texts; in the
 * panel the number and the object failed to draw.
 * The fourth request, its answers untouched, keeps its real address: the
 * control that shows the route changed only what it names.
 */
test('An address of another shape in the answers reads IP unavailable', async ({
  page,
  request,
}) => {
  const sessionId = await createSessionViaApi(request);
  const shapes: { marker: string; sourceIp: unknown; id: string }[] = [];

  for (const [marker, sourceIp] of [
    ['number', 123],
    ['object', {}],
    ['array', []],
  ] as const) {
    shapes.push({
      marker,
      sourceIp,
      id: await send(request, sessionId, marker, `{"marker":"${marker}"}`),
    });
  }

  const keptId = await send(request, sessionId, 'kept', '{"marker":"kept"}');
  const sourceIpOf = new Map(shapes.map((shape) => [shape.id, shape.sourceIp]));
  let listLoads = 0;
  let detailLoads = 0;

  await page.route(`**/api/sessions/${sessionId}/requests`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();

      return;
    }

    listLoads += 1;

    const response = await route.fetch();
    const items = (await response.json()) as Record<string, unknown>[];

    await route.fulfill({
      response,
      json: items.map((item) =>
        sourceIpOf.has(String(item.id))
          ? { ...item, sourceIp: sourceIpOf.get(String(item.id)) }
          : item,
      ),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/requests/*`, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';

    if (route.request().method() !== 'GET' || !sourceIpOf.has(id)) {
      await route.continue();

      return;
    }

    detailLoads += 1;

    const response = await route.fetch();
    const details = (await response.json()) as Record<string, unknown>;

    await route.fulfill({ response, json: { ...details, sourceIp: sourceIpOf.get(id) } });
  });

  const pageErrors: Error[] = [];

  page.on('pageerror', (error) => pageErrors.push(error));

  const catches = countBoundaryCatches(page);
  const rowIds = [...shapes.map((shape) => shape.id), keptId];

  await page.goto(`/v/${sessionId}`);
  await readReceiveUrl(page);
  await expectPageAround(page, rowIds);
  await markPage(page);
  expect(listLoads).toBeGreaterThan(0);

  // Each row reads `IP unavailable`; the untouched one keeps its address.
  for (const { id } of shapes) {
    await expect(requestRow(page, id).getByTestId('row-address')).toHaveText('IP unavailable');
  }

  await expect(requestRow(page, keptId).getByTestId('row-address')).not.toHaveText(
    'IP unavailable',
  );
  await expect(requestRow(page, keptId).getByTestId('row-address')).not.toBeEmpty();

  // The filter matches the rows by what they show, and by their id.
  await page.getByRole('button', { name: 'Filter requests' }).click();

  const filter = page.getByRole('searchbox', { name: 'Filter requests' });
  const [, , arrayShape] = shapes;

  await filter.fill('unavailable');

  for (const { id } of shapes) {
    await expect(requestRow(page, id)).toBeVisible();
  }

  await expect(requestRow(page, keptId)).toHaveCount(0);

  await filter.fill(arrayShape?.id ?? '');
  await expect(requestRow(page, arrayShape?.id ?? '')).toBeVisible();

  for (const id of rowIds.filter((rowId) => rowId !== arrayShape?.id)) {
    await expect(requestRow(page, id)).toHaveCount(0);
  }

  await filter.fill('');
  await expectPageAround(page, rowIds);

  // Each one opens, its facts line reading `IP unavailable` where the address
  // stands, and the panel never reaches its error state.
  for (const { id, marker } of shapes) {
    await requestRow(page, id).click();
    await expect(page.getByTestId('detail-target')).toHaveText(`/s/${sessionId}?marker=${marker}`);
    await expect(page.getByTestId('request-facts')).toContainText(' · IP unavailable · ');
    await expect(page.getByRole('tabpanel', { name: 'Raw' })).toContainText(
      `{"marker":"${marker}"}`,
    );
    await expect(page.getByText(LOAD_FAILED)).toHaveCount(0);
  }

  expect(detailLoads).toBe(shapes.length);
  await expectPageAround(page, rowIds);
  await expectNotReloaded(page);
  expect(catches()).toBe(0);
  expect(pageErrors).toEqual([]);
});
