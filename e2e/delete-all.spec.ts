import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  collectRealtimeFrames,
  createSessionViaApi,
  measureTouchRow,
  receiveUrlOf,
  requestRow,
  storedRequestId,
} from './helpers.ts';
import type { RequestListItem } from '@webhook-inspector/shared';

/**
 * E2E-03 — `Delete all` empties the list, the confirmation is required, and the
 * deletion reaches the server rather than only the screen.
 */
test('Delete all clears the session on the server and the emptiness survives a reload', async ({
  page,
  request,
}) => {
  // Set up over the API: this journey starts from a session that already holds
  // requests, and creating them through the UI would repeat E2E-01.
  const sessionId = await createSessionViaApi(request);
  const receiveUrl = await receiveUrlOf(request, sessionId);
  const requestIds: string[] = [];

  for (const marker of ['one', 'two', 'three']) {
    const sent = await request.post(`${receiveUrl}?marker=${marker}`, {
      headers: { 'content-type': 'application/json' },
      data: `{"marker":"${marker}"}`,
    });

    expect(sent.status()).toBe(200);
    requestIds.push(storedRequestId(sent));
  }

  await page.goto(`/v/${sessionId}`);

  for (const id of requestIds) {
    await expect(requestRow(page, id)).toBeVisible();
  }

  await expect(page.getByText('3 / 1000 requests')).toBeVisible();

  // The row at phone, tablet and desktop widths, and a single request deleted
  // with the phone's `×` (issue #55, D157). It leaves the three rows above.
  await expectTouchRowsAndDeleteOnAPhone(page, request, receiveUrl, requestIds);
  await expect(page.getByText('3 / 1000 requests')).toBeVisible();

  // Asserted before the deletion as well as after it. Without this, the "the
  // server is empty" assertion at the end has never been shown capable of
  // failing: a mistyped id answering 404, or a shape that makes a length check
  // read `undefined`, would pass just as quietly.
  const before = await request.get(`/api/sessions/${sessionId}/requests`);

  expect(before.status()).toBe(200);

  const listedBefore = (await before.json()) as RequestListItem[];

  expect(Array.isArray(listedBefore)).toBe(true);
  expect(listedBefore).toHaveLength(3);

  // The trigger, resolved while it is the only `Delete all` on the page.
  await page.getByRole('button', { name: 'Delete all' }).click();

  const dialog = page.getByRole('dialog', { name: 'Delete all requests?' });

  await expect(dialog).toBeVisible();

  // Scoped to the dialog: the trigger stays in the DOM while the dialog is
  // open, and the two buttons share an accessible name.
  await dialog.getByRole('button', { name: 'Delete all' }).click();

  for (const id of requestIds) {
    await expect(requestRow(page, id)).toHaveCount(0);
  }

  await expect(page.getByText('0 / 1000 requests')).toBeVisible();
  await expect(page.getByText('Waiting for the first request')).toBeVisible();

  // Present and disabled rather than removed at zero requests. This differs
  // from the design file and is the approved behaviour (D071).
  const trigger = page.getByRole('button', { name: 'Delete all' });

  await expect(trigger).toBeVisible();
  await expect(trigger).toBeDisabled();

  // The only reload in the suite, and the point of this test: a list emptied on
  // screen would survive nothing.
  await page.reload();

  await expect(page.getByText('Waiting for the first request')).toBeVisible();
  await expect(page.getByText('0 / 1000 requests')).toBeVisible();

  for (const id of requestIds) {
    await expect(requestRow(page, id)).toHaveCount(0);
  }

  const after = await request.get(`/api/sessions/${sessionId}/requests`);

  expect(after.status()).toBe(200);

  const listedAfter = (await after.json()) as RequestListItem[];

  expect(Array.isArray(listedAfter)).toBe(true);
  expect(listedAfter).toHaveLength(0);
});

/**
 * Issue #55, D157, frame 2A″: on a phone (375 and 393 px) a row is 76 px, line
 * 1 holds the method, the short id and the full time, line 2 the status,
 * address and size, and the `×` is a 44 × 44 target in the row's bottom-right
 * corner, starting below line 1, its glyph ending where the time ends, 16 px
 * from the row's edge. A tap on the row outside it opens the request; a tap on
 * it deletes at once (D029). 320 px does not scroll sideways, 768 px keeps the
 * tablet's 64 px row with the `×` in a column of its own (7B), and 1440 px the
 * desktop's 57 px row with its 30 px mark over the top-right corner (D030).
 * Nothing here compares pixels; the desktop's identity with the previous
 * version is checked by screenshot when the row changes.
 */
async function expectTouchRowsAndDeleteOnAPhone(
  page: Page,
  request: APIRequestContext,
  receiveUrl: string,
  shownIds: string[],
): Promise<void> {
  const sent = await request.post(`${receiveUrl}?marker=phone`, {
    headers: { 'content-type': 'application/json' },
    data: '{"marker":"phone"}',
  });

  expect(sent.status()).toBe(200);

  const phoneId = storedRequestId(sent);

  await expect(requestRow(page, phoneId)).toBeVisible();

  for (const width of [375, 393]) {
    await page.setViewportSize({ width, height: 812 });

    for (const id of [phoneId, ...shownIds]) {
      const row = await measureTouchRow(page, id);

      expect(row.rowHeight).toBeCloseTo(76, 0);
      expect(row.deleteWidth).toBe(44);
      expect(row.deleteHeight).toBe(44);
      expect(row.deleteRight).toBeCloseTo(row.rowRight, 0);
      expect(row.deleteBottom).toBeCloseTo(row.rowBottom, 0);
      // Line 1: the method, the id and the full time, which ends 16 px from
      // the row's edge; line 2 lies 16 px under it.
      expect(row.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(row.rowRight - row.timeRight).toBeCloseTo(16, 0);
      expect(row.idRight).toBeLessThanOrEqual(row.timeLeft);
      expect(row.line2Top - row.line1Bottom).toBeCloseTo(16, 0);
      // The glyph ends where the time ends.
      expect(Math.abs(row.glyphRight - row.timeRight)).toBeLessThanOrEqual(1);
      // The target starts below line 1 and covers none of the row's text.
      expect(row.deleteTop).toBeGreaterThanOrEqual(row.line1Bottom);
      expect(row.line2Right).toBeLessThanOrEqual(row.deleteLeft);
      expect(row.clipped).toEqual([]);
      expect(row.pageScrollsSideways).toBe(false);
    }
  }

  await page.setViewportSize({ width: 320, height: 640 });
  expect((await measureTouchRow(page, phoneId)).pageScrollsSideways).toBe(false);

  await page.setViewportSize({ width: 768, height: 1024 });

  const tablet = await measureTouchRow(page, phoneId);

  expect(tablet.rowHeight).toBeCloseTo(65, 0);
  expect(tablet.deleteWidth).toBe(44);
  expect(tablet.deleteLeft).toBeGreaterThanOrEqual(tablet.timeRight);
  expect(tablet.pageScrollsSideways).toBe(false);

  await page.setViewportSize({ width: 1440, height: 1024 });

  const desktop = await measureTouchRow(page, phoneId);

  expect(desktop.rowHeight).toBeCloseTo(58, 0);
  expect(desktop.deleteWidth).toBe(30);
  expect(desktop.deleteTop).toBeCloseTo(desktop.rowTop, 0);
  expect(desktop.deleteRight).toBeCloseTo(desktop.rowRight, 0);

  // Back on a phone: a tap on line 2 just left of the `×` opens the request,
  // and a tap on the `×` deletes it at once.
  await page.setViewportSize({ width: 375, height: 812 });

  const phone = await measureTouchRow(page, phoneId);

  await page.mouse.click(phone.deleteLeft - 4, phone.deleteTop + 22);

  const back = page.getByRole('button', { name: /^Back to Requests/ });

  await expect(back).toBeVisible();
  await back.click();
  await expect(requestRow(page, phoneId)).toBeVisible();

  const target = await measureTouchRow(page, phoneId);

  await page.mouse.click(target.deleteLeft + 22, target.deleteTop + 22);
  await expect(requestRow(page, phoneId)).toHaveCount(0);
  await expect(back).toHaveCount(0);

  for (const id of shownIds) {
    await expect(requestRow(page, id)).toBeVisible();
  }

  await page.setViewportSize({ width: 1440, height: 1024 });
}

/** The `×` of one row: a sibling of the row button, inside the same row. */
function deleteButton(page: Page, requestId: string) {
  return requestRow(page, requestId)
    .locator('xpath=..')
    .getByRole('button', { name: 'Delete request' });
}

/**
 * E2E-03, second half — deletions reach **every** open viewer of the session
 * (issue #7, D135-D137).
 *
 * Two viewers in **two independent browser contexts**, not two pages of one:
 * nothing is shared between them but the server, so a row disappearing in the
 * observer can only have been carried by its own socket. Two pages of one
 * context would share storage and could be satisfied by a same-browser path
 * deletions do not have and must not be measured by (only read state travels
 * that way, D156).
 */
test('Deleting in one viewer removes the row, closes the open panel and clears the list in another', async ({
  browser,
  request,
  baseURL,
  viewport,
}) => {
  const sessionId = await createSessionViaApi(request);
  const receiveUrl = await receiveUrlOf(request, sessionId);
  const ids: Record<string, string> = {};

  for (const marker of ['one', 'two', 'three']) {
    const sent = await request.post(`${receiveUrl}?marker=${marker}`, {
      headers: { 'content-type': 'application/json' },
      data: `{"marker":"${marker}"}`,
    });

    expect(sent.status()).toBe(200);
    ids[marker] = storedRequestId(sent);
  }

  const one = ids.one as string;
  const two = ids.two as string;
  const three = ids.three as string;

  // `browser.newContext` does not inherit the project's `use` block, so the
  // address and the viewport are passed on explicitly.
  const actingContext = await browser.newContext({ baseURL, viewport });
  const observingContext = await browser.newContext({ baseURL, viewport });

  try {
    const acting = await actingContext.newPage();
    const observer = await observingContext.newPage();
    const pageErrors: Error[] = [];

    acting.on('pageerror', (error) => pageErrors.push(error));
    observer.on('pageerror', (error) => pageErrors.push(error));

    const observerFrames = collectRealtimeFrames(observer);

    await acting.goto(`/v/${sessionId}`);
    await observer.goto(`/v/${sessionId}`);

    for (const page of [acting, observer]) {
      for (const id of [one, two, three]) {
        await expect(requestRow(page, id)).toBeVisible();
      }
    }

    // The observer's socket is subscribed before anything is deleted, so what
    // follows is the realtime path and not the reload that `ready` triggers.
    await expect
      .poll(() => observerFrames.some((frame) => frame.includes('"type":"ready"')))
      .toBe(true);

    // A value that only survives if the observer is never reloaded.
    await observer.evaluate(() => {
      (window as unknown as { __notReloaded?: boolean }).__notReloaded = true;
    });

    // The observer opens the request the acting viewer is about to delete.
    await requestRow(observer, two).click();
    await expect(observer.getByText('No request selected')).toHaveCount(0);
    await expect(observer.getByText('Loading request details…')).toHaveCount(0);

    // One deletion in the acting viewer.
    await deleteButton(acting, two).click();

    await expect(requestRow(acting, two)).toHaveCount(0);
    await expect(requestRow(observer, two)).toHaveCount(0);
    await expect(observer.getByText('No request selected')).toBeVisible();
    await expect.poll(() => observerFrames.some((f) => f.includes('"request.deleted"'))).toBe(true);

    for (const page of [acting, observer]) {
      await expect(requestRow(page, one)).toHaveCount(1);
      await expect(requestRow(page, three)).toHaveCount(1);
      await expect(page.getByText('2 / 1000 requests')).toBeVisible();
    }

    // The acting viewer received its own event too, and shows no
    // duplicate row and no error for it.
    await expect(acting.getByText('This request could not be deleted.')).toHaveCount(0);

    // Delete all in the acting viewer.
    await acting.getByRole('button', { name: 'Delete all' }).click();

    const dialog = acting.getByRole('dialog', { name: 'Delete all requests?' });

    await dialog.getByRole('button', { name: 'Delete all' }).click();

    for (const page of [acting, observer]) {
      for (const id of [one, two, three]) {
        await expect(requestRow(page, id)).toHaveCount(0);
      }

      await expect(page.getByText('0 / 1000 requests')).toBeVisible();
      await expect(page.getByText('Waiting for the first request')).toBeVisible();
    }

    await expect(acting.getByText('These requests could not be deleted.')).toHaveCount(0);
    expect(
      await observer.evaluate(
        () => (window as unknown as { __notReloaded?: boolean }).__notReloaded,
      ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);

    // The observer still receives new captures after both deletions.
    const after = await request.post(`${receiveUrl}?marker=after`, {
      headers: { 'content-type': 'application/json' },
      data: '{"marker":"after"}',
    });

    expect(after.status()).toBe(200);
    await expect(requestRow(observer, storedRequestId(after))).toBeVisible();
  } finally {
    await actingContext.close();
    await observingContext.close();
  }
});

/**
 * E2E-03, third part — a `Delete all` a viewer missed while its socket was
 * down (issue #39). The reload on reconnection replaces the list rather than
 * merging into it, so the deleted rows do not survive, the open request among
 * them closes as on a received deletion (D137), and a request captured after
 * the clear is listed.
 *
 * The socket is routed through Playwright, which is what lets the test cut it
 * and refuse reconnections for as long as the deletion takes, with no change to
 * the application. It counts and forwards only the frames of connections whose
 * page side is still open, for the reason given in the handler. The deletion is
 * made over the API: to this viewer that is the same as another viewer's
 * `Delete all`, and the previous test already drives the button.
 */
test('A Delete all missed while disconnected empties the list on reconnection', async ({
  page,
  request,
}) => {
  const sessionId = await createSessionViaApi(request);
  const receiveUrl = await receiveUrlOf(request, sessionId);
  const before: string[] = [];

  for (const marker of ['one', 'two']) {
    const sent = await request.post(`${receiveUrl}?marker=${marker}`, {
      headers: { 'content-type': 'application/json' },
      data: `{"marker":"${marker}"}`,
    });

    expect(sent.status()).toBe(200);
    before.push(storedRequestId(sent));
  }

  const [one, two] = before as [string, string];
  const frames: string[] = [];
  let down = false;
  let cut: (() => Promise<void>) | null = null;

  await page.routeWebSocket(/\/ws\//, (ws) => {
    if (down) {
      // Not a refusal code: the page keeps retrying, as after a network drop.
      void ws.close();

      return;
    }

    const server = ws.connectToServer();
    let closed = false;

    // Drops frames arriving after the page side closed, such as the `ready`
    // of the socket `StrictMode` discards (F-03 in `docs/testing/flakes.md`).
    // That close precedes them on one ordered channel, so timing does not
    // matter as long as `onClose` is set before this handler yields; otherwise
    // Playwright forwards the close itself, and `closed` turns on only after
    // the frames it should have dropped.
    ws.onClose((code, reason) => {
      closed = true;
      // Setting `onClose` turned Playwright's own forwarding off.
      void server.close({ code, reason });
    });
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (closed) {
        return;
      }

      if (typeof message === 'string') {
        frames.push(message);
      }

      ws.send(message);
    });
    // Both sides, the server's first and awaited: once it is closed, no frame
    // the backend publishes afterwards can reach `frames` or the page.
    cut = async () => {
      await server.close();
      await ws.close();
    };
  });

  const readyFrames = () => frames.filter((frame) => frame.includes('"type":"ready"')).length;

  await page.goto(`/v/${sessionId}`);

  for (const id of before) {
    await expect(requestRow(page, id)).toBeVisible();
  }

  await expect.poll(readyFrames).toBe(1);

  await page.evaluate(() => {
    (window as unknown as { __notReloaded?: boolean }).__notReloaded = true;
  });

  await requestRow(page, two).click();
  await expect(page.getByText('No request selected')).toHaveCount(0);

  // The socket goes down, and the session is emptied while it is.
  down = true;
  await (cut as (() => Promise<void>) | null)?.();

  const cleared = await request.delete(`/api/sessions/${sessionId}/requests`);

  expect(cleared.status()).toBe(204);

  const after = await request.post(`${receiveUrl}?marker=after`, {
    headers: { 'content-type': 'application/json' },
    data: '{"marker":"after"}',
  });

  expect(after.status()).toBe(200);

  // Nothing reached the page while the socket was down.
  expect(frames.some((frame) => frame.includes('"requests.cleared"'))).toBe(false);
  await expect(requestRow(page, one)).toHaveCount(1);

  down = false;

  // The retry delay grows while connections are refused, so this waits longer
  // than a plain expectation does.
  await expect.poll(readyFrames, { timeout: 30_000 }).toBe(2);

  await expect(requestRow(page, storedRequestId(after))).toBeVisible();

  for (const id of before) {
    await expect(requestRow(page, id)).toHaveCount(0);
  }

  await expect(page.getByText('1 / 1000 requests')).toBeVisible();
  await expect(page.getByText('No request selected')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded),
  ).toBe(true);
});

/**
 * E2E-03, fourth part — a session deleted through the API while a tab is open
 * on it (issue #102, D198). The backend closes every connection of the session
 * with `4404` once the deletion commits, and the page reads a `4404` at any
 * moment as the end of the session (D076): it shows `Session not found`, with
 * the sentence that names deletion on purpose, without a reload. A tab on
 * another session in the same browser keeps receiving.
 *
 * There is no delete control in the interface (issue #102, Decision 6), so the
 * deletion is made over the API, as a CI run would make it.
 */
test('A tab open on a session deleted through the API shows Session not found without a reload', async ({
  browser,
  request,
  baseURL,
  viewport,
}) => {
  const deletedId = await createSessionViaApi(request);
  const otherId = await createSessionViaApi(request);
  const deletedReceiveUrl = await receiveUrlOf(request, deletedId);
  const otherReceiveUrl = await receiveUrlOf(request, otherId);
  const captured = await request.post(deletedReceiveUrl, {
    headers: { 'content-type': 'application/json' },
    data: '{"marker":"before"}',
  });

  expect(captured.status()).toBe(200);

  const context = await browser.newContext({ baseURL, viewport });

  try {
    const page = await context.newPage();
    const bystander = await context.newPage();
    const pageErrors: Error[] = [];

    page.on('pageerror', (error) => pageErrors.push(error));
    bystander.on('pageerror', (error) => pageErrors.push(error));

    const frames = collectRealtimeFrames(page);
    const bystanderFrames = collectRealtimeFrames(bystander);

    await page.goto(`/v/${deletedId}`);
    await bystander.goto(`/v/${otherId}`);
    await expect(requestRow(page, storedRequestId(captured))).toBeVisible();

    // Both sockets subscribed before the deletion, so what follows is the
    // close the deletion sends and not a refusal of a late connection.
    await expect.poll(() => frames.some((frame) => frame.includes('"type":"ready"'))).toBe(true);
    await expect
      .poll(() => bystanderFrames.some((frame) => frame.includes('"type":"ready"')))
      .toBe(true);

    // A value that only survives if the page is never reloaded.
    await page.evaluate(() => {
      (window as unknown as { __notReloaded?: boolean }).__notReloaded = true;
    });

    const deleted = await request.delete(`/api/sessions/${deletedId}`);

    expect(deleted.status()).toBe(204);
    expect(await deleted.text()).toBe('');

    await expect(page.getByRole('heading', { name: 'Session not found', level: 1 })).toBeVisible();
    // No number: the page cannot know the window of a session that is gone
    // (D265).
    const body = page.getByText(
      'It was most likely deleted, on purpose or after going unused for the time chosen when it was created, together with its requests and response settings.',
      { exact: true },
    );

    await expect(body).toBeVisible();
    expect(await body.textContent()).not.toMatch(/\d/);
    await expect(page).toHaveURL(new RegExp(`/v/${deletedId}$`));
    expect(
      await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded),
    ).toBe(true);

    // The session is gone on the server too.
    const listed = await request.get(`/api/sessions/${deletedId}/requests`);

    expect(listed.status()).toBe(404);
    expect(((await listed.json()) as { errorCode: number }).errorCode).toBe(1001);

    // The other session's tab is still live.
    const later = await request.post(otherReceiveUrl, {
      headers: { 'content-type': 'application/json' },
      data: '{"marker":"after"}',
    });

    expect(later.status()).toBe(200);
    await expect(requestRow(bystander, storedRequestId(later))).toBeVisible();
    await expect(bystander.getByRole('heading', { name: 'Session not found' })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
