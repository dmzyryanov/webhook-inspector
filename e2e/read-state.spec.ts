import { expect, test, type Page } from '@playwright/test';
import { formatDocumentTitle } from '../apps/frontend/src/lib/format.ts';
import { createSessionViaApi, receiveUrlOf, requestRow, storedRequestId } from './helpers.ts';

/** The row's container, which carries its shading. */
function rowShell(page: Page, requestId: string) {
  return requestRow(page, requestId).locator('xpath=..');
}

async function expectUnread(page: Page, requestId: string, unread: boolean): Promise<void> {
  const shell = rowShell(page, requestId);

  await expect(shell).toBeVisible();

  if (unread) {
    await expect(shell).toHaveClass(/bg-row-unread/);
  } else {
    await expect(shell).not.toHaveClass(/bg-row-unread/);
  }
}

/**
 * E2E-05 — opening a request marks it read in the session's other tabs of the
 * same browser, and only there (issue #46, D156).
 *
 * Tabs are pages of **one** browser context, which is what shares
 * `localStorage`; a second context stands for another browser, profile or
 * private window and must stay untouched, because nothing goes through the
 * server.
 */
test('Opening a request marks it read in the other tabs of the same browser only', async ({
  browser,
  context,
  request,
  baseURL,
  viewport,
}) => {
  const sessionId = await createSessionViaApi(request);
  const otherSessionId = await createSessionViaApi(request);
  const receiveUrl = await receiveUrlOf(request, sessionId);
  const ids: string[] = [];

  for (const marker of ['one', 'two', 'three']) {
    const sent = await request.post(`${receiveUrl}?marker=${marker}`, {
      headers: { 'content-type': 'application/json' },
      data: `{"marker":"${marker}"}`,
    });

    expect(sent.status()).toBe(200);
    ids.push(storedRequestId(sent));
  }

  const sentOther = await request.post(await receiveUrlOf(request, otherSessionId), {
    headers: { 'content-type': 'application/json' },
    data: '{"marker":"other"}',
  });

  expect(sentOther.status()).toBe(200);

  const otherId = storedRequestId(sentOther);
  const [one, two, three] = ids as [string, string, string];

  const tabA = await context.newPage();
  const tabB = await context.newPage();
  const tabOther = await context.newPage();
  const pageErrors: Error[] = [];

  for (const page of [tabA, tabB, tabOther]) {
    page.on('pageerror', (error) => pageErrors.push(error));
  }

  await tabA.goto(`/v/${sessionId}`);
  await tabB.goto(`/v/${sessionId}`);
  await tabOther.goto(`/v/${otherSessionId}`);

  for (const page of [tabA, tabB]) {
    for (const id of ids) {
      await expectUnread(page, id, true);
    }

    await expect(page).toHaveTitle(formatDocumentTitle(3));
  }

  await expectUnread(tabOther, otherId, true);
  await expect(tabOther).toHaveTitle(formatDocumentTitle(1));

  // B inspects a request of its own; that selection must survive A's click.
  await requestRow(tabB, three).click();
  await expect(tabB.getByTestId('detail-target')).toHaveText(`/s/${sessionId}?marker=three`);
  await expect(tabB).toHaveTitle(formatDocumentTitle(2));

  // A value that only survives if B is never reloaded.
  await tabB.evaluate(() => {
    (window as unknown as { __notReloaded?: boolean }).__notReloaded = true;
  });

  // A opens `one`; B loses its shading and count with no reload,
  // and keeps its own selection and panel.
  await requestRow(tabA, one).click();

  await expectUnread(tabB, one, false);
  await expectUnread(tabB, two, true);
  await expect(tabB).toHaveTitle(formatDocumentTitle(1));
  await expect(rowShell(tabB, three)).toHaveClass(/bg-row-selected/);
  await expect(rowShell(tabB, one)).not.toHaveClass(/bg-row-selected/);
  await expect(tabB.getByTestId('detail-target')).toHaveText(`/s/${sessionId}?marker=three`);
  expect(
    await tabB.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded),
  ).toBe(true);

  // The same path the other way: B's earlier opening reached A.
  await expectUnread(tabA, three, false);
  await expect(tabA).toHaveTitle(formatDocumentTitle(1));

  // A tab on another session is unaffected.
  await expectUnread(tabOther, otherId, true);
  await expect(tabOther).toHaveTitle(formatDocumentTitle(1));

  // Another browser context shares nothing.
  const separateContext = await browser.newContext({ baseURL, viewport });

  try {
    const separate = await separateContext.newPage();

    await separate.goto(`/v/${sessionId}`);

    for (const id of ids) {
      await expectUnread(separate, id, true);
    }

    await expect(separate).toHaveTitle(formatDocumentTitle(3));
  } finally {
    await separateContext.close();
  }

  // A reload, and a tab opened later, start from what was opened.
  await tabB.reload();

  const tabLater = await context.newPage();

  await tabLater.goto(`/v/${sessionId}`);

  for (const page of [tabB, tabLater]) {
    await expectUnread(page, one, false);
    await expectUnread(page, two, true);
    await expectUnread(page, three, false);
    await expect(page).toHaveTitle(formatDocumentTitle(1));
  }

  expect(pageErrors).toEqual([]);
});
