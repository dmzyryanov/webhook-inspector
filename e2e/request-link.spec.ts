import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { formatDocumentTitle } from '../apps/frontend/src/lib/format.ts';
import { createSessionViaApi, receiveUrlOf, requestRow, storedRequestId } from './helpers.ts';

/**
 * E2E-09 — a link to one captured request (issue #71, D182; Figma `Webhook
 * Inspector · Request actions`, direction C).
 *
 * `Copy link` in the request actions writes `<origin>/v/<session>#<request>`;
 * opening it shows that request open and read, with the fragment gone from the
 * address, at the desktop's, the tablet's and the phone's width, and Back
 * behaves as the layout's own Back does (D157). A link to a request that is
 * gone shows the list and a toast, and a malformed fragment is dropped. That
 * the fragment is parsed, and that the push flow pushes its entry only below
 * 1024 px, is unit-tested (`request-link.test.ts`, `push-flow.test.ts`); here
 * it is the page, the address bar and the history of a real browser.
 *
 * The clipboard is the browser's own, with the permission granted to the
 * context, except where a refusal has to be driven.
 */

const STALE = 'The linked request is no longer in this session.';

/** The router's fields a link's entry is given at 375 px, to see none is dropped. */
const ROUTER_STATE = { usr: null, key: 'e2e-router-key', idx: 0 };

/** Captures one request under `path`, and returns its id. */
async function send(request: APIRequestContext, sessionId: string, path: string): Promise<string> {
  const sent = await request.post(`${await receiveUrlOf(request, sessionId)}${path}`, {
    headers: { 'content-type': 'application/json' },
    data: `{"path":"${path}"}`,
  });

  expect(sent.status()).toBe(200);

  return storedRequestId(sent);
}

/** The row's container, which carries its shading (E2E-05). */
function rowShell(page: Page, requestId: string) {
  return requestRow(page, requestId).locator('xpath=..');
}

/** The session page's own address: no fragment, no `#`. */
function sessionAddress(page: Page, sessionId: string): string {
  return `${new URL(page.url()).origin}/v/${sessionId}`;
}

/**
 * Opens `address` as a new document, with the landing page as the entry
 * before it, so that a Back that leaves the session has somewhere to land.
 * Going through `/` also makes every link a real page load: from the session
 * page itself, an address that differs only in its fragment would be a
 * same-document navigation, which the page does not read (D182).
 */
async function openFresh(page: Page, address: string): Promise<void> {
  await page.goto('/');
  await page.goto(address);
}

test.describe('E2E-09 — a link to one request', () => {
  test('Copy link, Copy as cURL and Download JSON are one menu, worked by keyboard, and one sheet on a phone', async ({
    page,
    context,
    request,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const sessionId = await createSessionViaApi(request);
    const first = await send(request, sessionId, '/first');
    const second = await send(request, sessionId, '/second');

    await page.goto(`/v/${sessionId}`);
    await requestRow(page, first).click();

    const actions = page.getByRole('button', { name: 'Actions', exact: true });
    const menu = page.getByRole('menu', { name: 'Actions' });
    const copyLink = menu.getByRole('menuitem', { name: 'Copy link', exact: true });
    const copyCurl = menu.getByRole('menuitem', { name: 'Copy as cURL', exact: true });
    const downloadJson = menu.getByRole('menuitem', { name: 'Download JSON', exact: true });
    const toast = page.getByTestId('toast');

    // The WAI-ARIA menu button: Enter opens on the first item, the arrows
    // move, Escape closes with focus back on the trigger.
    await actions.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Copy link',
      'Copy as cURL',
      'Download JSON',
      'Check signature…',
      'Compare with…',
    ]);
    await expect(copyLink).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(copyCurl).toBeFocused();
    // The divider is passed over: the next stop is `Download JSON` (D185).
    await page.keyboard.press('ArrowDown');
    await expect(downloadJson).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(copyCurl).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(copyLink).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(actions).toBeFocused();

    // Space opens it too, and Enter chooses: the menu closes, focus is back
    // on the trigger, and the toast confirms once the write has happened.
    await page.keyboard.press(' ');
    await expect(copyLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(actions).toBeFocused();
    await expect(toast).toHaveText('Link copied');
    await expect(toast).toHaveAttribute('data-icon', 'check');

    const link = await page.evaluate(() => navigator.clipboard.readText());

    expect(link).toBe(`${sessionAddress(page, sessionId)}#${first}`);

    // The actions are on the Response half as well.
    await page.getByRole('tab', { name: 'Response' }).click();
    await actions.click();
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Copy link',
      'Copy as cURL',
      'Download JSON',
      'Check signature…',
      'Compare with…',
    ]);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // A refused write: the info toast says what was not copied, and the
    // clipboard keeps what it held.
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () =>
          Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')),
      });
    });
    await requestRow(page, second).click();
    await actions.click();
    await copyLink.click();
    await expect(toast).toHaveText('The browser refused the copy. The link was not copied.');
    await expect(toast).toHaveAttribute('data-icon', 'info');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    // A phone: `⋯` in the Back bar opens the `Request actions` sheet. A tap on
    // the scrim closes it, and so does Escape, each with focus back on `⋯`.
    await page.reload();
    await page.setViewportSize({ width: 375, height: 812 });
    await requestRow(page, second).click();

    const more = page.getByRole('button', { name: 'Request actions' });
    const sheet = page.getByRole('dialog', { name: 'Request actions' });

    await expect(actions).toHaveCount(0);
    await more.click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button')).toHaveText([
      'Copy link',
      'Copy as cURL',
      'Download JSON',
      'Check signature…',
      'Compare with…',
    ]);
    await page.mouse.click(187, 200);
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
    await more.click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();

    // Choosing closes it, and the toast confirms the copy.
    await more.click();
    await sheet.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(toast).toHaveText('Link copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${sessionAddress(page, sessionId)}#${second}`,
    );

    // At 320 px the Back bar holds `‹ Requests`, `N of M` and `⋯`, and nothing
    // scrolls sideways, the sheet open or not.
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(page.getByTestId('open-position')).toHaveText('1 of 2');
    await expect(more).toBeInViewport({ ratio: 1 });
    await more.click();
    await expect(sheet).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test('A link opens its request, read, at every width, and leaves no fragment behind', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);
    const older = await send(request, sessionId, '/older');

    // The desktop: the request opens beside the list, and Back leaves the
    // session, as it always has.
    const desktop = await send(request, sessionId, '/desktop');

    await openFresh(page, `/v/${sessionId}#${desktop}`);
    await expect(page).toHaveURL(sessionAddress(page, sessionId));
    await expect(page.getByTestId('detail-target-path')).toHaveText('/desktop');
    await expect(rowShell(page, desktop)).toHaveClass(/bg-row-selected/);
    // Read: one of the two requests is unread, and it is not the linked one.
    await expect(page).toHaveTitle(formatDocumentTitle(1));
    await expect(rowShell(page, older)).toHaveClass(/bg-row-unread/);

    // Selecting another request leaves the address as it is.
    await requestRow(page, older).click();
    await expect(page.getByTestId('detail-target-path')).toHaveText('/older');
    await expect(page).toHaveURL(sessionAddress(page, sessionId));
    await expect(rowShell(page, desktop)).not.toHaveClass(/bg-row-unread/);

    // A reload shows the list with nothing open.
    await page.reload();
    await expect(page.getByText('No request selected')).toBeVisible();
    await expect(page).toHaveURL(sessionAddress(page, sessionId));

    await page.goBack();
    await expect(page).toHaveURL('/');

    // Opened again, with no other step, Back still leaves: no entry was pushed.
    await openFresh(page, `/v/${sessionId}#${desktop}`);
    await expect(page.getByTestId('detail-target-path')).toHaveText('/desktop');
    await page.goBack();
    await expect(page).toHaveURL('/');

    // The tablet and the phone: the push flow's opening, so Back returns to
    // the list and the next Back leaves the session.
    for (const { width, height } of [
      { width: 768, height: 1024 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize({ width, height });

      // A document opened at an address carries only the router's `idx`, which
      // the router writes as it starts. At 375 px the link's entry is given all
      // three of the router's fields before the application runs, as an entry
      // the router pushed would carry them, so that the fragment's removal is
      // seen keeping every one of them (D182).
      const routerState = width < 768 ? ROUTER_STATE : { idx: 0 };

      if (width < 768) {
        await page.addInitScript((state) => {
          if (window.location.hash.length > 1 && window.history.state === null) {
            window.history.replaceState(state, '');
          }
        }, ROUTER_STATE);
      }

      const linked = await send(request, sessionId, `/w${width}`);

      await openFresh(page, `/v/${sessionId}#${linked}`);
      await expect(page).toHaveURL(sessionAddress(page, sessionId));
      await expect(page.getByTestId('detail-target-path')).toHaveText(`/w${width}`);
      await expect(page.getByRole('button', { name: 'Back to Requests' })).toBeVisible();
      await expect(page.getByTestId('open-position')).toHaveText(`1 of ${width === 768 ? 3 : 4}`);
      // The push flow's entry: the router's fields, kept through the
      // fragment's removal, and the page's marker on top of them.
      expect(await page.evaluate(() => window.history.state as unknown)).toEqual({
        ...routerState,
        webhookInspectorOpenRequest: true,
      });

      await page.goBack();
      await expect(page).toHaveURL(sessionAddress(page, sessionId));
      await expect(page.getByRole('button', { name: 'Back to Requests' })).toHaveCount(0);
      await expect(rowShell(page, linked)).toBeVisible();
      await expect(rowShell(page, linked)).not.toHaveClass(/bg-row-unread/);
      // The entry beneath, whose address lost the fragment, kept them too.
      expect(await page.evaluate(() => window.history.state as unknown)).toEqual(routerState);

      await page.goBack();
      await expect(page).toHaveURL('/');
    }
  });

  test('A stale link shows the list and a toast, a malformed one is dropped, a filter is kept', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);
    const gone = await send(request, sessionId, '/gone');
    const kept = await send(request, sessionId, '/kept');
    const stripe = await send(request, sessionId, '/stripe/events');

    const deleted = await request.delete(`/api/sessions/${sessionId}/requests/${gone}`);

    expect(deleted.status()).toBe(204);

    const toast = page.getByTestId('toast');

    // Deleted, or pushed out of the newest 1000: the list, nothing open, and
    // the toast with the info icon, at every width (S1, S2).
    for (const { width, height } of [
      { width: 1440, height: 1024 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize({ width, height });
      await openFresh(page, `/v/${sessionId}#${gone}`);
      await expect(toast).toHaveText(STALE);
      await expect(toast).toHaveAttribute('data-icon', 'info');
      await expect(page).toHaveURL(sessionAddress(page, sessionId));
      await expect(requestRow(page, kept)).toBeVisible();
      await expect(requestRow(page, stripe)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Back to Requests' })).toHaveCount(0);

      if (width >= 1024) {
        await expect(page.getByText('No request selected')).toBeVisible();
      }
    }

    await page.setViewportSize({ width: 1440, height: 1024 });

    // Malformed - not a request id, empty, an id with more after it - is
    // dropped from the address, and the session opens as it would without it.
    for (const fragment of ['not-a-request', '', `${kept}x`]) {
      await openFresh(page, `/v/${sessionId}#${fragment}`);
      await expect(requestRow(page, kept)).toBeVisible();
      await expect(page).toHaveURL(sessionAddress(page, sessionId));
      expect(page.url()).not.toContain('#');
      await expect(page.getByText('No request selected')).toBeVisible();
      await expect(toast).toHaveCount(0);
    }

    // A stored filter that hides the linked request: it opens, and the
    // filter is kept (D180).
    await page.getByRole('button', { name: 'Filter requests' }).click();
    await page.getByRole('searchbox', { name: 'Filter requests' }).fill('stripe');
    await expect(requestRow(page, kept)).toHaveCount(0);

    await openFresh(page, `/v/${sessionId}#${kept}`);
    await expect(page.getByTestId('detail-target-path')).toHaveText('/kept');
    await expect(page.getByRole('searchbox', { name: 'Filter requests' })).toHaveValue('stripe');
    await expect(requestRow(page, kept)).toHaveCount(0);
    await expect(requestRow(page, stripe)).toBeVisible();
    await expect(page).toHaveURL(sessionAddress(page, sessionId));
  });
});
