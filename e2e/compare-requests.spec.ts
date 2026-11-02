import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { REQUEST_ID_DISPLAY_LENGTH } from '@webhook-inspector/shared';
import { createSessionViaApi, receiveUrlOf, requestRow, storedRequestId } from './helpers.ts';

/**
 * E2E-11 — comparing the open request with another request of the session
 * (issue #75, D186; Figma `Webhook Inspector · Compare requests`, direction
 * A): `Compare with…` turns the list into the picker, `Cancel`, Escape and a
 * phone's Back leave it with nothing changed, the filter narrows the
 * candidates, a chosen row shows the comparison with the open request `−` and
 * the chosen one `+`, `Change` picks again, `Close` returns to the open
 * request, a deleted chosen request says it is gone, and identical requests say
 * so — at 1440 px and at 375 px, with nothing scrolling sideways at 320 px.
 */

interface Sent {
  amount: string;
  attempt: string;
}

/** A JSON webhook whose amount, `X-Attempt` header and `attempt` query vary. */
async function send(
  request: APIRequestContext,
  sessionId: string,
  { amount, attempt }: Sent,
): Promise<string> {
  const receiveUrl = await receiveUrlOf(request, sessionId);
  const sent = await request.post(`${receiveUrl}/stripe?livemode=false&attempt=${attempt}`, {
    headers: { 'content-type': 'application/json', 'x-attempt': attempt },
    data: `{"id":"evt_1","data":{"amount":${amount},"currency":"eur","status":"succeeded"}}`,
  });

  expect(sent.status()).toBe(200);

  return storedRequestId(sent);
}

function short(id: string): string {
  return id.slice(0, REQUEST_ID_DISPLAY_LENGTH);
}

async function noSidewaysScroll(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test.describe('E2E-11 — comparing two requests', () => {
  test('picks in the list and compares at 1440 px: Cancel, Escape, the filter, Change, Close, gone, identical', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);
    const first = await send(request, sessionId, { amount: '4200', attempt: '3' });
    const second = await send(request, sessionId, { amount: '"42.00"', attempt: '2' });

    await page.goto(`/v/${sessionId}`);
    await requestRow(page, first).click();
    await expect(page.getByTestId('detail-method')).toHaveText('POST');

    const actions = page.getByRole('button', { name: 'Actions', exact: true });
    const menu = page.getByRole('menu', { name: 'Actions' });
    const compareItem = menu.getByRole('menuitem', { name: 'Compare with…', exact: true });
    const picker = page.getByTestId('list-picking');
    const deleteAll = page.getByRole('button', { name: 'Delete all' });
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });

    // The item follows `Download JSON`, after the divider.
    await actions.click();
    await expect(menu.getByRole('menuitem').last()).toHaveText('Compare with…');
    await compareItem.click();

    // A1: the header, `Cancel` in place of Delete all, no `×` on any row, and
    // the open row cannot be chosen.
    await expect(picker).toContainText('Compare with…');
    // What the page shows, not its text: the phone's wording is display: none.
    await expect(picker).toContainText(`Choose a request for POST ${short(first)}`, {
      useInnerText: true,
    });
    await expect(picker).not.toContainText('Tap a request for', { useInnerText: true });
    await expect(deleteAll).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete request' })).toHaveCount(0);
    await expect(requestRow(page, first)).toHaveAttribute('aria-disabled', 'true');
    await expect(requestRow(page, first)).toHaveAccessibleName(/open request, cannot be chosen/);
    // Marked disabled by `aria-disabled`, the open row keeps the arrow; a
    // candidate shows the hand (issue #246).
    await expect(requestRow(page, first)).toHaveCSS('cursor', 'default');
    await expect(requestRow(page, second)).toHaveCSS('cursor', 'pointer');
    // Forced: Playwright will not click a control marked disabled, a person can.
    await requestRow(page, first).click({ force: true });
    await expect(picker).toBeVisible();
    await expect(page.getByTestId('compare-bar')).toHaveCount(0);

    // Escape leaves picking with nothing changed.
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(deleteAll).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Request', exact: true })).toBeVisible();

    // So does Cancel.
    await actions.click();
    await compareItem.click();
    await expect(picker).toBeVisible();
    await cancel.click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete request' })).toHaveCount(2);

    // The filter narrows the candidates.
    await actions.click();
    await compareItem.click();
    await page.getByRole('button', { name: 'Filter requests' }).click();
    await page.getByRole('searchbox', { name: 'Filter requests' }).fill(short(second));
    await expect(requestRow(page, first)).toHaveCount(0);
    await expect(picker).toBeVisible();

    // Choosing asks the server for the chosen request's details and nothing else.
    const apiCalls: string[] = [];

    page.on('request', (sent) => {
      const path = new URL(sent.url()).pathname;

      if (path.startsWith('/api/')) {
        apiCalls.push(`${sent.method()} ${path}`);
      }
    });

    await requestRow(page, second).click();
    await expect(page.getByTestId('compare-bar')).toBeVisible();
    await expect
      .poll(() => apiCalls)
      .toEqual([`GET /api/sessions/${sessionId}/requests/${second}`]);
    await page.getByRole('button', { name: 'Clear filter' }).first().click();

    // A2: the open request `−` and `open`, the chosen one `+`, each with its
    // method, short id and size; both rows marked in the list.
    const openLine = page.getByTestId('compared-open');
    const chosenLine = page.getByTestId('compared-chosen');

    await expect(openLine).toContainText(`POST${short(first)}`);
    await expect(openLine).toContainText('open');
    await expect(chosenLine).toContainText(`POST${short(second)}`);
    await expect(chosenLine).not.toContainText('open');
    await expect(requestRow(page, first).getByTestId('mark-removed')).toBeVisible();
    await expect(requestRow(page, second).getByTestId('mark-added')).toBeVisible();

    // Opens on Body, every view differs, and Body shows exactly the changed
    // line with the changed value underlined.
    const panel = page.getByTestId('compare-view');
    const view = (name: string) => panel.getByRole('tab', { name: new RegExp(`^${name}`) });

    await expect(view('Body')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByTestId('differs-dot')).toHaveCount(4);

    const shown = panel.getByRole('tabpanel');

    await expect(shown.locator('[data-diff="removed"]')).toHaveCount(1);
    await expect(shown.locator('[data-diff="added"]')).toHaveCount(1);
    await expect(shown.locator('[data-diff="removed"]')).toContainText('"amount": 4200,');
    await expect(shown.locator('[data-diff="added"]')).toContainText('"amount": "42.00",');
    await expect(shown.getByTestId('diff-changed')).toHaveText(['4200', '"42.00"']);

    // Headers: exactly the changed pairs, whatever order and case the client
    // sent them in.
    await view('Headers').click();

    const removedLines = shown.locator('[data-diff="removed"]');
    const addedLines = shown.locator('[data-diff="added"]');

    await expect(removedLines).toHaveCount(2);
    await expect(addedLines).toHaveCount(2);
    await expect(removedLines.filter({ hasText: /Removed: content-length: 75$/i })).toHaveCount(1);
    await expect(removedLines.filter({ hasText: /Removed: x-attempt: 3$/i })).toHaveCount(1);
    await expect(addedLines.filter({ hasText: /Added: content-length: 78$/i })).toHaveCount(1);
    await expect(addedLines.filter({ hasText: /Added: x-attempt: 2$/i })).toHaveCount(1);

    // Query and Raw show their own differences.
    await view('Query').click();
    await expect(removedLines).toHaveCount(1);
    await expect(removedLines).toContainText('Removed: attempt=3');
    await expect(addedLines).toHaveCount(1);
    await expect(addedLines).toContainText('Added: attempt=2');
    await view('Raw').click();
    await expect(shown.locator('[data-diff="removed"]').first()).toContainText(
      'livemode=false&attempt=3',
    );

    // The blank line between the head and the body keeps a line's height, as
    // in the plain `Raw` view (A3): every row is at least 20 px tall.
    const rowHeights = await shown.locator('[data-diff]').evaluateAll((rows) =>
      rows.map((row) => ({
        empty: row.querySelector('[data-testid="diff-text"]')?.textContent === '',
        height: row.getBoundingClientRect().height,
      })),
    );

    expect(rowHeights.filter((row) => row.empty).length).toBeGreaterThan(0);
    expect(rowHeights.filter((row) => row.height < 20)).toEqual([]);

    // Change picks again for the same open request. Escape and Cancel leave
    // picking with nothing changed: the comparison is back, on `Raw`.
    for (const leave of ['Escape', 'Cancel'] as const) {
      await page.getByRole('button', { name: 'Change', exact: true }).click();
      await expect(picker).toContainText(`Choose a request for POST ${short(first)}`, {
        useInnerText: true,
      });

      if (leave === 'Escape') {
        await page.keyboard.press('Escape');
      } else {
        await cancel.click();
      }

      await expect(picker).toHaveCount(0);
      await expect(page.getByTestId('compare-bar')).toBeVisible();
      await expect(chosenLine).toContainText(short(second));
      await expect(view('Raw')).toHaveAttribute('aria-selected', 'true');
    }

    // Close returns to the open request; the marks go with the comparison.
    await page.getByRole('button', { name: 'Close comparison' }).click();
    await expect(page.getByTestId('compare-bar')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Request', exact: true })).toBeVisible();
    await expect(page.getByTestId('mark-removed')).toHaveCount(0);

    // The chosen request older than the open one: the open one is still `−`.
    await requestRow(page, second).click();
    await actions.click();
    await compareItem.click();
    await requestRow(page, first).click();
    await expect(openLine).toContainText(short(second));
    await expect(chosenLine).toContainText(short(first));

    // A click on another row opens it normally and ends the comparison.
    await requestRow(page, first).click();
    await expect(page.getByTestId('compare-bar')).toHaveCount(0);
    await expect(page.getByTestId('mark-added')).toHaveCount(0);

    // D4: the chosen request deleted while compared.
    await actions.click();
    await compareItem.click();
    await requestRow(page, second).click();
    await expect(page.getByTestId('compare-bar')).toBeVisible();

    const deleted = await request.delete(`/api/sessions/${sessionId}/requests/${second}`);

    expect(deleted.status()).toBe(204);
    await expect(page.getByTestId('compare-gone')).toHaveText(
      `POST ${short(second)} is no longer in this session.Choose another`,
    );
    await expect(requestRow(page, second)).toHaveCount(0);
    await page.getByRole('button', { name: 'Choose another' }).click();
    await expect(picker).toBeVisible();

    // D1: an identical request.
    const third = await send(request, sessionId, { amount: '4200', attempt: '3' });

    await requestRow(page, third).click();
    await expect(page.getByTestId('compared-chosen')).toContainText(short(third));
    await expect(panel.getByTestId('differs-dot')).toHaveCount(0);
    await expect(view('Body')).toHaveAttribute('aria-selected', 'true');
    await expect(shown.getByTestId('compare-headline')).toHaveText(
      'The two requests are identical in every view.',
    );
    await expect(shown.locator('[data-diff="fold"]')).toContainText('unchanged lines');
    await shown.getByRole('button', { name: 'Show' }).click();
    await expect(shown.locator('[data-diff="same"]').first()).toBeVisible();
  });

  test('picks on the list screen and compares at 375 px, with Back, Cancel and no sideways scroll', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);
    const first = await send(request, sessionId, { amount: '4200', attempt: '3' });
    const second = await send(request, sessionId, { amount: '"42.00"', attempt: '2' });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/v/${sessionId}`);
    await requestRow(page, first).click();

    const backBar = page.getByRole('button', { name: /^Back to Requests/ });
    const more = page.getByRole('button', { name: 'Request actions' });
    const sheet = page.getByRole('dialog', { name: 'Request actions' });
    const picker = page.getByTestId('list-picking');

    await expect(backBar).toBeVisible();
    await more.click();
    await expect(sheet.getByRole('button').last()).toHaveText('Compare with…');
    await sheet.getByRole('button', { name: 'Compare with…', exact: true }).click();

    // A4: the list screen in picking mode.
    await expect(picker).toBeVisible();
    await expect(picker).toContainText(`Tap a request for ${short(first)}`, { useInnerText: true });
    await expect(picker).not.toContainText('Choose a request for', { useInnerText: true });
    await expect(backBar).toBeHidden();
    await noSidewaysScroll(page);

    // The browser's Back returns to the open request, and so does Cancel.
    await page.goBack();
    await expect(picker).toHaveCount(0);
    await expect(backBar).toBeVisible();
    await expect(page.getByTestId('detail-method')).toBeVisible();

    await more.click();
    await sheet.getByRole('button', { name: 'Compare with…', exact: true }).click();
    await expect(picker).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(backBar).toBeVisible();
    await expect(page.getByTestId('detail-method')).toBeVisible();

    // A5: a tapped row shows the comparison in the detail screen.
    await more.click();
    await sheet.getByRole('button', { name: 'Compare with…', exact: true }).click();
    await requestRow(page, second).click();
    await expect(page.getByTestId('compare-bar')).toBeVisible();
    await expect(backBar).toBeVisible();
    await expect(page.getByTestId('compared-open')).toContainText(short(first));
    await expect(page.getByTestId('compared-chosen')).toContainText(short(second));

    const panel = page.getByTestId('compare-view');

    await expect(panel.getByRole('tab', { name: /^Body/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(panel.getByRole('tabpanel').getByTestId('diff-changed')).toHaveText([
      '4200',
      '"42.00"',
    ]);
    await noSidewaysScroll(page);

    await page.setViewportSize({ width: 320, height: 640 });
    await panel.getByRole('tab', { name: /^Raw/ }).click();
    await noSidewaysScroll(page);
    await page.setViewportSize({ width: 375, height: 812 });

    // Back from the comparison returns to the list, as from any request.
    await page.goBack();
    await expect(page.getByTestId('compare-bar')).toBeHidden();
    await expect(backBar).toBeHidden();
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete all' })).toBeVisible();
  });
});
