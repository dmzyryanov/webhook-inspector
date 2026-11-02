import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { RequestDetails } from '@webhook-inspector/shared';
import { buildCurlCommand } from '../apps/frontend/src/lib/curl-command.ts';
import { JSON_FORMAT_MAX_BYTES } from '../apps/frontend/src/lib/json-format.ts';
import { PRIVACY_FOOTER, PRIVACY_FOOTER_TEXT } from '../apps/frontend/src/lib/privacy-footer.ts';
import {
  collectRealtimeFrames,
  collectSessionReadTimeline,
  expectHeaderLayout,
  expectLanguageSwitchPlaced,
  readReceiveUrl,
  receiveUrlOf,
  requestRow,
  sessionIdFromPage,
  storedRequestId,
} from './helpers.ts';

/**
 * An integer beyond `Number.MAX_SAFE_INTEGER`: 2^53 + 1, the smallest one a
 * double cannot represent. Rendering it through `JSON.parse`/`JSON.stringify`
 * would print `9007199254740992`, one less than what was sent (D112).
 */
const UNSAFE_INTEGER = '9007199254740993';

/** The public status page the header links to (D209), typed out rather than imported. */
const STATUS_PAGE_URL = 'https://status.qa-tools.ru/';

const FIRST_BODY = `{"marker":"alpha","runId":${UNSAFE_INTEGER}}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The detail panel's time: `17 Sep 2026, 14:32:06`, `5 Sep 2026, 09:04:05` (D148). */
const DETAIL_TIME = new RegExp(
  `^([1-9]|[12]\\d|3[01]) (${MONTHS.join('|')}) (\\d{4}), (\\d{2}:\\d{2}:\\d{2})$`,
);

/** A list row's time: `2026-09-17 14:32:06`. */
const ROW_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * The detail panel's time rewritten as a list row writes it, so that the two
 * can be shown to name one instant rather than merely to have two shapes.
 */
function detailTimeAsRowTime(detailTime: string): string {
  const [, day = '', month = '', year = '', clock = ''] = DETAIL_TIME.exec(detailTime) ?? [];
  const monthNumber = String(MONTHS.indexOf(month) + 1).padStart(2, '0');

  return `${year}-${monthNumber}-${day.padStart(2, '0')} ${clock}`;
}

/**
 * E2E-01 — the journey the product exists for: generate a URL, send a request
 * to it, and see it arrive and be readable without touching the browser.
 *
 * It also pins the navigation rules most likely to regress: every newly
 * selected request opens on Request → `Raw`, the first switch into `Response`
 * lands on `Body`, and each half then keeps the tab last chosen on it (D107).
 * And it is the only place in the project where the shipped bundle is observed
 * declaring `response.recorded` support end to end (D114, D115).
 *
 * The last section of it measures the inspector's code blocks (D134, D149).
 * That the model says every block wraps is unit-tested; that the rendering
 * therefore leaves one vertical scroll in the panel - no box that scrolls, no
 * sideways scroll anywhere, a box as tall as its lines - is a property of a
 * laid-out page, and no unit test in the project can fail for it. It is
 * asserted here rather than in a fourth journey, exactly as D125's addition to
 * E2E-02 was (D108).
 *
 * It starts on an address the application does not serve, and reaches the
 * landing page through that screen's `Go to home page` (D146, D147).
 */
test('a standard session captures a request and opens each selection on Request → Raw', async ({
  page,
  request,
}) => {
  // Attached before the page exists, so no frame can be missed.
  const frames = collectRealtimeFrames(page);
  const sessionReads = collectSessionReadTimeline(page);

  // Every API call and session socket the page opens, from the start.
  const apiCalls: string[] = [];
  const sessionSockets: string[] = [];

  page.on('request', (sent) => {
    const { pathname } = new URL(sent.url());

    if (pathname.startsWith('/api/')) {
      apiCalls.push(pathname);
    }
  });
  page.on('websocket', (socket) => {
    // Vite's HMR channel is a WebSocket too, and is not the page's.
    if (new URL(socket.url()).pathname.startsWith('/ws/')) {
      sessionSockets.push(socket.url());
    }
  });

  // `Page not found` is decided from the address alone (D146). The dev server
  // answers this address `200`; the `404` is nginx's and is checked against the
  // image, not here. What is pinned here is the page: the screen, a request
  // line with the query and without the fragment, and nothing asked of the API
  // and no session socket - the page never reaches the session view.
  await page.goto('/anything?from=e2e#fragment');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

  const exchange = page.locator('main pre');

  await expect(exchange).toContainText('GET /anything?from=e2e HTTP/1.1');
  await expect(exchange).toContainText('HTTP/1.1 404 Not Found');
  await expect(exchange).not.toContainText('fragment');
  // Settled, so a call the page made would have been seen by now. The control
  // is further down: the same two lists fill once the session page is open.
  await page.waitForLoadState('networkidle');
  expect(apiCalls, 'Page not found called the API').toEqual([]);
  expect(sessionSockets, 'Page not found opened a session socket').toEqual([]);
  // Every page's header carries the links to the changelog, the status page
  // and the API reference (D158, D184, D209), and every page closes with the
  // privacy footer (D177).
  await expectHeaderLinks(page);
  await expectPrivacyFooter(page);

  // Both not-found screens lead home, and home is the landing page (D147).
  await page.getByRole('link', { name: 'Go to home page' }).click();
  await expect(page).toHaveURL(/^http:\/\/[^/]+\/$/);
  // The address changes before the landing page replaces `Page not found`, so
  // the header and footer checks wait for what only the landing page draws:
  // run earlier, they could find the not-found page's header link and see it
  // removed while focusing it.
  const generate = page.getByRole('button', { name: 'Generate URL' });

  await expect(generate).toBeVisible();
  await expectHeaderLinks(page);
  await expectPrivacyFooter(page);
  // One action: the landing page no longer offers a custom response (D158).
  await expect(page.getByRole('button', { name: 'Custom response' })).toHaveCount(0);
  await generate.click();

  const sessionId = await sessionIdFromPage(page);

  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  await expect(page.getByText('Waiting for the first request')).toBeVisible();

  const receiveUrl = await readReceiveUrl(page);

  // The endpoint card's metadata slot states the retention rule where the
  // countdown used to tick (D133), naming the session as what expires (D158).
  // Asserted in a browser because nothing else in the project renders a
  // component: the string is unit-tested, its being on screen is not.
  await expect(page.getByText('SESSION EXPIRES 7 DAYS AFTER LAST USE')).toBeVisible();
  await expect(page.getByText(/KEPT FOR/)).toHaveCount(0);

  // The session page's blocks, 12 px apart (issue #96, direction B): the list
  // and the detail panel at the suite's 1440 x 1024; then at 1440, 768 and
  // 375 px the header, the endpoint card, the panes and the footer band
  // (D177), which sits under the panes on the desktop and after the list on a
  // tablet and a phone. The card is 85, 93 and 154 px: B's padding and gaps
  // as the page renders them, 12 px shorter than before #96 on the desktop and
  // the tablet and 8 px on a phone. The phone's two caption lines take the
  // face's normal line height, so the heights are held to half a pixel, as
  // E2E-03 holds a phone row. The band is the approved frames' 34 and 51 px;
  // at 375 px, where the frames' 102 px - `EN | RU` joining the links, a line
  // more than the 85 px before it (A-P1, D222) - is a line more again with the
  // words of 1.15.16 (D265), only its fit is asserted: measured in Chromium on
  // 2026-10-25 it is 119 px from 376 px down and 102 px at 377, closer than
  // 9 px. Nothing scrolls sideways down to 320 px.
  await expectPrivacyFooter(page);
  expect((await measureSessionBlocks(page)).listToDetail).toBe(12);

  for (const { width, height, band, card } of [
    { width: 1440, height: 1024, band: 34, card: 85 },
    { width: 768, height: 1024, band: 51, card: 93 },
    { width: 375, height: 812, band: null, card: 154 },
  ]) {
    await page.setViewportSize({ width, height });
    // Below 768 px the band is a line taller only once the page has
    // re-rendered with `EN | RU` in it (D222): measured at once after the
    // resize, it was sometimes 85 px, the band without the switch.
    await expectLanguageSwitchPlaced(page);

    const footer = await measureFooter(page);
    const blocks = await measureSessionBlocks(page);

    expect(blocks.headerToCard, `${width} px`).toBe(12);
    expect(blocks.cardHeight, `${width} px`).toBeCloseTo(card, 0);
    expect(blocks.cardToPanes, `${width} px`).toBe(12);
    if (band !== null) {
      expect(footer.height, `${width} px`).toBe(band);
    }

    expect(footer.top - footer.contentBottom, `${width} px`).toBe(12);
    expect(footer.pageScrollsSideways, `${width} px`).toBe(false);
    // The header keeps all three links at every width (D184, D209).
    await expectHeaderLayout(page);
  }

  // Below 375 px the Q mark stands in for the wordmark, and the three links,
  // both dividers and both arrows still fit (D209). At 360 and 320 px the
  // band is 119 px (D222, D265): with the words of 1.15.16 it keeps that
  // height from 376 down to 295 px, 16 px and more from either width.
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 640 });
    await expectLanguageSwitchPlaced(page);

    const footer = await measureFooter(page);

    expect(footer.height, `${width} px`).toBe(119);

    expect(footer.pageScrollsSideways, `${width} px`).toBe(false);
    await expectHeaderLayout(page);
  }

  await page.setViewportSize({ width: 1440, height: 1024 });

  // The API reference opens in a tab of its own, and the session page stays
  // where it was: that is why the link does not open in place (D158).
  const docsLink = await expectHeaderLinks(page);
  const [reference] = await Promise.all([page.context().waitForEvent('page'), docsLink.click()]);

  await expect(reference).toHaveURL(/\/docs$/);
  await reference.close();
  await expect(page).toHaveURL(new RegExp(`/v/${sessionId}$`));

  // So does the status page (D209), here a stand-in, since the suite reaches
  // no other site. It is a third party's, so the link sends no `Referer` at
  // all (`noreferrer`): not the session page's address, whose id is the access
  // key (D004), and not even the site's origin.
  const statusReferers: (string | undefined)[] = [];

  await page.context().route(STATUS_PAGE_URL, async (route) => {
    statusReferers.push((await route.request().allHeaders())['referer']);
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Status</title>' });
  });

  const statusLink = page
    .getByRole('banner')
    .getByRole('link', { name: 'Status (opens in a new tab)', exact: true });
  const [statusPage] = await Promise.all([page.context().waitForEvent('page'), statusLink.click()]);

  await expect(statusPage).toHaveURL(STATUS_PAGE_URL);
  await statusPage.close();
  await page.context().unroute(STATUS_PAGE_URL);
  await expect(page).toHaveURL(new RegExp(`/v/${sessionId}$`));
  expect(statusReferers).toEqual([undefined]);

  // The page reads its session on every realtime connection, not only on mount
  // (D133). That read is what makes a tab left open a continuing use of its
  // session, and it is the single line the sliding window depends on from the
  // client: delete it and nothing else in the project fails.
  //
  // Counted after the first `ready` frame and not in total. The mount issues
  // this request twice here - a dev server plus `StrictMode` - so a total would
  // stay above any threshold with the connection handler's read deleted, and
  // the assertion would pin nothing. See docs/testing/browser-smoke.md.
  await expect
    .poll(() => sessionReads.afterReady.filter((id) => id === sessionId).length, {
      message: 'the page never re-read its session after the socket reported ready',
    })
    .toBeGreaterThanOrEqual(1);

  // The mount's own read, kept as the control: if this ever reached zero the
  // assertion above would be measuring something other than what it names.
  expect(sessionReads.beforeReady).toContain(sessionId);

  // And the control for `Page not found`'s empty lists: they are filled by a
  // page that does call the API and open its socket.
  expect(apiCalls).toContain(`/api/sessions/${sessionId}`);
  expect(sessionSockets.length).toBeGreaterThanOrEqual(1);

  // A value this page cannot survive losing: a reload wipes it. Read again at
  // the end, it is the proof that the rows below arrived over the socket rather
  // than through a page load.
  await page.evaluate(() => {
    (window as unknown as { __e2eMark?: number }).__e2eMark = 1;
  });

  // Sent from Node, not from the page: a fetch issued by the page under test
  // would prove nothing about a request arriving from outside the browser.
  const first = await request.post(`${receiveUrl}?marker=alpha&attempt=1`, {
    headers: { 'content-type': 'application/json', 'X-E2E-Marker': 'alpha' },
    data: FIRST_BODY,
  });

  // The documented answer of a default session (D100, D102).
  expect(first.status()).toBe(200);

  const firstId = storedRequestId(first);
  const firstBody = (await first.json()) as { ok: boolean; requestId: string };

  expect(firstBody.ok).toBe(true);
  expect(firstBody.requestId).toBe(firstId);

  // Nothing is clicked between sending and this assertion, and the page is
  // never reloaded: the row can only come from the realtime path.
  const firstRow = requestRow(page, firstId);

  await expect(firstRow).toBeVisible();
  await expect(page.getByText('1 / 1000 requests')).toBeVisible();

  await firstRow.click();

  // Each panel is found by the tab that labels it, because both levels are
  // force-mounted now: the exchange panel and the view panel inside it are both
  // `tabpanel`s, and only the name tells them apart.
  const exchangeRequest = page.getByRole('tab', { name: 'Request' });
  const exchangeResponse = page.getByRole('tab', { name: 'Response' });
  const rawTab = page.getByRole('tab', { name: 'Raw' });
  const bodyTab = page.getByRole('tab', { name: 'Body' });
  const rawPanel = page.getByRole('tabpanel', { name: 'Raw' });
  const bodyPanel = page.getByRole('tabpanel', { name: 'Body' });

  // Asserted before any tab is clicked: both levels open where D107 says.
  await expect(exchangeRequest).toHaveAttribute('aria-selected', 'true');
  await expect(rawTab).toHaveAttribute('aria-selected', 'true');

  // What the panel holds, not merely which tab looks selected: the request line
  // is composed at capture time (D049) and no other tab can produce it. It
  // carries the query string as it was received.
  await expect(rawPanel).toContainText(`POST /s/${sessionId}?marker=alpha&attempt=1 HTTP/1.1`);
  // The header name is matched case-insensitively: an intermediary proxy may
  // change the case of forwarded header names. The production proxy's
  // specifics are described in D091.
  await expect(rawPanel).toContainText(/x-e2e-marker: alpha/i);
  // `Raw` is the stored representation and is never re-indented (D112), so the
  // body appears in it exactly as it was sent.
  await expect(rawPanel).toContainText(FIRST_BODY);

  // The sender's address is a segment of the facts line, between the size and
  // the time, with no line of its own and no country (D140, D141). What this
  // environment records is a loopback peer, so the address is asserted by its
  // position and against the row's full address rather than by value.
  const facts = (await page.getByTestId('request-facts').innerText()).split(' · ');

  expect(facts).toHaveLength(4);
  expect(facts[0]).toBe('HTTP/1.1');
  expect(facts[1]).toBe(`${Buffer.byteLength(FIRST_BODY)} B`);

  // The panel writes the time as the design draws it, and the row keeps its
  // compact form: two shapes on one screen, deliberately, for one instant in one
  // zone (D148).
  const receivedTime = facts[3] ?? '';

  expect(receivedTime).toMatch(DETAIL_TIME);

  // The row's time sits beside its button rather than inside it, so it is found
  // on the page; this is the only row so far.
  const rowTimes = page.getByTestId('row-time');

  await expect(rowTimes).toHaveCount(1);

  const rowTime = await rowTimes.innerText();

  expect(rowTime).toMatch(ROW_TIME);
  expect(detailTimeAsRowTime(receivedTime)).toBe(rowTime);

  const address = facts[2] ?? '';

  expect(address).not.toBe('');
  expect(address).not.toBe('IP unavailable');

  // Written in full: the row carries the whole stored address as its title,
  // whatever it had to shorten on screen.
  const rowAddress = firstRow.getByTestId('row-address');

  await expect(rowAddress).not.toBeEmpty();
  await expect(rowAddress).toHaveAttribute('title', address);

  // No sender line and no country anywhere, the row included.
  await expect(page.getByTestId('sender-line')).toHaveCount(0);
  await expect(page.getByText(/country/i)).toHaveCount(0);
  await expect(firstRow).not.toContainText(/country/i);

  // The Body view, as it opens: there is no Formatted/Original toggle to drive
  // any more (D112), so the digits are asserted on the only rendering there is.
  await bodyTab.click();
  await expect(bodyTab).toHaveAttribute('aria-selected', 'true');
  await expect(bodyPanel).toContainText(`"runId": ${UNSAFE_INTEGER}`);
  // Character for character: the double that `JSON.parse` would produce prints
  // a different number, and printing a different number is the failure this
  // whole mechanism exists to prevent.
  expect(await bodyPanel.innerText()).toContain(UNSAFE_INTEGER);
  expect(await bodyPanel.innerText()).not.toContain('9007199254740992');

  // `Download JSON` from the request actions saves the detail API's answer
  // (D185). Before `Copy as cURL`, so that no copy's toast is up yet and the
  // absence of one is the item's own.
  await expectDownloadJson(page, request, { sessionId, requestId: firstId });

  await expect(bodyTab).toHaveAttribute('aria-selected', 'true');

  // `Copy as cURL` from the request actions, from `Body` (D167, D182).
  await expectCopyAsCurl(page, request, { sessionId, requestId: firstId });

  await expect(bodyTab).toHaveAttribute('aria-selected', 'true');

  // The first switch into the Response half lands on `Body`, not on `Raw`.
  await exchangeResponse.click();
  // The request actions are on this half too, and its strip has none (D182).
  await expect(
    page.getByRole('tabpanel', { name: 'Response' }).getByRole('button', { name: /cURL/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Actions' }).getByRole('menuitem')).toHaveText([
    'Copy link',
    'Copy as cURL',
    'Download JSON',
    'Check signature…',
    'Compare with…',
  ]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(bodyTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'false');

  // A real recorded response for *this* exchange, not the `<request ID>`
  // illustration the session settings dialog shows.
  await expect(bodyPanel).toContainText(`"requestId": "${firstId}"`);
  // A finished write reads two lines: the status, then `Sent by server · …`.
  // The sentence that followed on nearly every response is gone (D158).
  await expect(page.getByText('Client delivery is not confirmed.')).toHaveCount(0);
  await expect(page.getByTestId('response-note')).toHaveCount(0);

  // The state line carries the time the write completed, in the panel's format.
  const stateLine = (await page.getByTestId('response-state').innerText()).split(' · ');

  expect(stateLine).toHaveLength(3);
  expect(stateLine[0]).toBe('Sent by server');
  expect(stateLine[1]).toMatch(/^\d+ B$/);
  expect(stateLine[2]).toMatch(DETAIL_TIME);

  // Each half keeps the tab last chosen on it while the other half is on screen.
  await page.getByRole('tab', { name: 'Raw' }).click();
  await expect(rawPanel).toContainText('HTTP/1.1 200 OK');

  await exchangeRequest.click();
  await expect(bodyTab).toHaveAttribute('aria-selected', 'true');

  await exchangeResponse.click();
  await expect(page.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');

  const second = await request.post(`${receiveUrl}?marker=beta&attempt=2`, {
    headers: { 'content-type': 'application/json', 'X-E2E-Marker': 'beta' },
    data: '{"marker":"beta"}',
  });

  expect(second.status()).toBe(200);

  const secondId = storedRequestId(second);
  const secondRow = requestRow(page, secondId);

  await expect(secondRow).toBeVisible();
  await expect(page.getByText('2 / 1000 requests')).toBeVisible();

  await secondRow.click();

  // Both levels reset on a new selection although the last tabs touched were
  // Response and Raw, and the panel shows the request just selected (D107).
  await expect(exchangeRequest).toHaveAttribute('aria-selected', 'true');
  await expect(rawTab).toHaveAttribute('aria-selected', 'true');
  await expect(rawPanel).toContainText(`POST /s/${sessionId}?marker=beta&attempt=2 HTTP/1.1`);
  await expect(rawPanel).toContainText('{"marker":"beta"}');
  await expect(rawPanel).not.toContainText('alpha');

  /*
   * The row reaches its final response state with no reload, and never shows a
   * status derived from the session configuration (D119). This is the only
   * end-to-end evidence that the shipped bundle declares `response.recorded`
   * support: the backend sends that event to declaring connections only, so a
   * frame arriving at all proves the declaration went out on the socket URL,
   * and the cell settling on the recorded status proves the handler ran.
   */
  await expect(requestRow(page, firstId).getByTestId('row-status')).toHaveText('200');
  await expect(requestRow(page, secondId).getByTestId('row-status')).toHaveText('200');
  await expect
    .poll(() => frames.filter((frame) => frame.includes('response.recorded')).length)
    .toBeGreaterThanOrEqual(1);

  // The page was never reloaded, so everything above happened live.
  const mark = await page.evaluate(() => (window as unknown as { __e2eMark?: number }).__e2eMark);

  expect(mark).toBe(1);

  // And the rows were announced over the socket. The list is also reloaded over
  // HTTP on every `ready` by design (D077, D081), which is why the socket frame
  // is asserted directly instead of blocking that endpoint.
  await expect
    .poll(() => frames.filter((frame) => frame.includes('request.received')).length)
    .toBeGreaterThanOrEqual(2);

  /*
   * The blocks, measured (D134, D149). Every block wraps, no box has a scroll of
   * its own, and the tab area under the view strip is the one scroll in the
   * panel, vertical only. Deleting `wrap-anywhere` from `CodeBlock`, giving the
   * box a height limit or an overflow again, or letting a line out of it leaves
   * every unit test in the project green; each fails something below.
   *
   * Sent last so that the request counts asserted above are undisturbed, and as
   * small as the cases allow: one byte past the ceiling is as good as a
   * megabyte, and 8 KiB of Base64 is already many screens of the block.
   */
  const overCeiling = await request.post(receiveUrl, {
    headers: { 'content-type': 'application/json' },
    data: `{"a":"${'x'.repeat(JSON_FORMAT_MAX_BYTES)}"}`,
  });

  expect(overCeiling.status()).toBe(200);

  const overCeilingRow = requestRow(page, storedRequestId(overCeiling));

  await expect(overCeilingRow).toBeVisible();
  await overCeilingRow.click();
  await expect(rawTab).toHaveAttribute('aria-selected', 'true');

  // `Raw` holds that same body on the one line it was stored as, and wraps too.
  await expectOnlyTheTabAreaScrolls(rawPanel, { deep: true, caption: true });

  await bodyTab.click();
  // The block being measured is the one that could not be re-indented, and its
  // caption is how the test knows that rather than assuming it from the size.
  await expect(bodyPanel).toContainText('Formatting unavailable above 256 KiB.');
  await expect(bodyPanel).toContainText('Long lines wrap;');
  await expectOnlyTheTabAreaScrolls(bodyPanel, { deep: true, caption: true });

  // A body that is not valid UTF-8 at all, so `Body` is a Base64 rendering: one
  // unbroken run with no space anywhere to break at, which is the case that
  // wrapping alone does not handle.
  const binary = await request.post(receiveUrl, {
    headers: { 'content-type': 'application/octet-stream' },
    // 8 KiB of it, which renders as about 11 000 Base64 characters: several
    // screens of the block, which is what makes the depth half of the
    // measurement mean something here.
    data: Buffer.alloc(8 * 1024, 0xff),
  });

  expect(binary.status()).toBe(200);

  const binaryRow = requestRow(page, storedRequestId(binary));

  await expect(binaryRow).toBeVisible();
  await binaryRow.click();
  await expect(rawTab).toHaveAttribute('aria-selected', 'true');
  // `Raw`, which opens first, keeps the request line and the headers as text
  // and renders only the body as Base64, in the browser's own decoders (D145).
  await expect(rawPanel).toContainText(`POST /s/${sessionId} HTTP/1.1`);
  await expect(rawPanel).toContainText(/content-type: application\/octet-stream/i);
  await expect(rawPanel).toContainText('Body shown as Base64 because it contains non-UTF-8 bytes.');
  await expect(rawPanel).not.toContainText('Raw request shown as Base64');
  await expectOnlyTheTabAreaScrolls(rawPanel, { deep: true, caption: true });
  await bodyTab.click();
  await expect(bodyPanel).toContainText('Binary body shown as Base64.');
  await expectOnlyTheTabAreaScrolls(bodyPanel, { deep: true, caption: true });

  /*
   * Re-indented JSON, a long header value and a long query string, in one
   * request. The body wraps too now, with its continuation hanging two columns
   * under its own line; the header value and the query value wrap inside their
   * value column. The header holds the whole target as its text, the query
   * string cut to one line on screen only (D173); `Query` shows it in full.
   */
  const longQuery = `callback=${'q'.repeat(3800)}`;
  const signature = `v1=${'5257a869e7ecebed'.repeat(19)}`.slice(0, 300);
  const items = Array.from({ length: 60 }, (_unused, index) => `{"sku":"SKU-${index}","qty":1}`);
  // Sixty levels of nesting, each with a long member of its own: nested that
  // deep, a line cannot hang two columns under itself in a narrow window, and
  // a frame drawn from the width before a resize once ran it out of the box.
  let deep = `"${'5257a869e7ecebed'.repeat(6)}"`;

  for (let level = 0; level < 60; level += 1) {
    deep = `{"k${level}":"${'abcdef0123456789'.repeat(5)}","next":${deep}}`;
  }

  const formatted = await request.post(`${receiveUrl}?${longQuery}`, {
    headers: { 'content-type': 'application/json', 'X-E2E-Signature': signature },
    data: `{"callback":"${'a'.repeat(400)}","items":[${items.join(',')}],"deep":${deep}}`,
  });

  expect(formatted.status()).toBe(200);

  const formattedRow = requestRow(page, storedRequestId(formatted));

  await expect(formattedRow).toBeVisible();

  // The blocks of this request never hear that their box was resized: a
  // `ResizeObserver` that reports nothing is in place while they mount, so
  // after the narrowing below they keep drawing what they measured at 1440 px.
  // That is the frame between a resize and the redraw it causes, held still
  // long enough to measure (D149).
  await page.evaluate(() => {
    const target = window as unknown as Record<string, unknown>;

    target.__realResizeObserver = target.ResizeObserver;
    target.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });
  await formattedRow.click();
  await expect(page.getByTestId('detail-target')).toHaveText(`/s/${sessionId}?${longQuery}`);

  await bodyTab.click();
  await expect(bodyPanel).toContainText('Long lines wrap;');
  await expectOnlyTheTabAreaScrolls(bodyPanel, { deep: true, caption: true });

  // Neither sideways caption is said any more, by this block or any other.
  await expect(page.getByText(/scroll/i)).toHaveCount(0);

  // A continuation starts two characters deeper than its own line, measured in
  // the width of the face's own characters rather than in pixels.
  const hanging = await measureHangingIndent(bodyPanel, '"callback"');

  expect(hanging.valueOnKeyRow).toBe(true);
  expect(hanging.continuations.length).toBeGreaterThanOrEqual(2);

  for (const depth of hanging.continuations) {
    expect(depth).toBeCloseTo(2, 1);
  }

  // The copy control stays at the top of the part of the box still on screen,
  // no text ever runs under it, and nothing above the tab area moves.
  const scrolled = await scrollIntoTheMiddle(bodyPanel);

  expect(scrolled.scrollTop).toBeGreaterThan(0);
  expect(scrolled.controlBelowAreaTop).toBeGreaterThanOrEqual(0);
  expect(scrolled.controlBelowAreaTop).toBeLessThanOrEqual(16);
  expect(scrolled.textClearOfControl).toBe(true);
  expect(scrolled.stripsAfter).toEqual(scrolled.stripsBefore);

  // A laptop's window: the tab area is the one vertical scroll in the panel,
  // and the page itself does not scroll.
  await page.setViewportSize({ width: 1440, height: 780 });
  expect(await verticalScrolls(bodyPanel)).toEqual({ inPanel: ['tab-area'], page: false });
  await expectOnlyTheTabAreaScrolls(bodyPanel, { deep: true, caption: true });

  // A tall one: the box runs on past the bottom of the tab area rather than
  // stopping at a ceiling with empty panel under it.
  await page.setViewportSize({ width: 1440, height: 1300 });
  expect(await boxEndsBelowTheTabArea(bodyPanel)).toBe(true);

  // Narrowed windows, with the lines sixty levels deep, drawn as they were
  // measured at 1440 px: the CSS still keeps every line in the box. Without
  // the clamp on the hanging padding the 1024 px frame ran 289 px out of the
  // box; 900 px, about 40 columns, is narrower than the widest key start drawn
  // unbroken, which only the container query lets break again.
  for (const width of [1024, 900]) {
    await page.setViewportSize({ width, height: 1024 });
    await expectOnlyTheTabAreaScrolls(bodyPanel, { deep: true, caption: true });
  }

  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.evaluate(() => {
    const target = window as unknown as Record<string, unknown>;

    target.ResizeObserver = target.__realResizeObserver;
  });

  // The 300-character header value wraps in the value column, and its name keeps
  // its one row.
  await page.getByRole('tab', { name: 'Headers' }).click();

  const headersPanel = page.getByRole('tabpanel', { name: 'Headers' });

  await expect(headersPanel).toContainText(
    'Headers as received by the server. Long lines wrap; the breaks on screen are not in the content.',
  );
  await expectOnlyTheTabAreaScrolls(headersPanel, { deep: false, caption: true });

  const row = await measureRow(headersPanel.getByText(signature, { exact: true }));

  expect(row.nameRows).toBe(1);
  expect(row.valueRows).toBeGreaterThan(1);
  expect(row.valueRightOfName).toBe(true);
  expect(row.valueInsideBox).toBe(true);

  // The query string of about 3.8 KB, decoded into its one row, which wraps in
  // its value column as the header did.
  await page.getByRole('tab', { name: 'Query' }).click();

  const queryPanel = page.getByRole('tabpanel', { name: 'Query' });

  await expect(queryPanel).toContainText('Long lines wrap;');
  await expectOnlyTheTabAreaScrolls(queryPanel, { deep: false, caption: true });

  const queryRow = await measureRow(queryPanel.getByText('q'.repeat(3800), { exact: true }));

  expect(queryRow.nameRows).toBe(1);
  expect(queryRow.valueRows).toBeGreaterThan(20);
  expect(queryRow.valueInsideBox).toBe(true);

  // The Response half, whose blocks are short: the same rules hold there.
  await exchangeResponse.click();

  // `Raw` and `Headers` say what they are. The default body re-indents one key
  // a line, and its `inspectorUrl` line - the key, the origin, `/v/` and two
  // ids, 118 columns on this suite's origin and 116 on `https://qa-tools.ru` -
  // is wider than the 110 a line is taken to fit, so `Body` says that its long
  // lines wrap, and says only that (D149, D223).
  for (const view of ['Raw', 'Body', 'Headers'] as const) {
    const panel = page.getByRole('tabpanel', { name: view });

    await page.getByRole('tab', { name: view }).click();
    await expectOnlyTheTabAreaScrolls(panel, { deep: false, caption: true });

    if (view === 'Body') {
      await expect(panel).toContainText('"inspectorUrl": ');
      await expect(
        panel.getByText('Long lines wrap; the breaks on screen are not in the content.', {
          exact: true,
        }),
      ).toBeVisible();
    }
  }

  // A short block ends under its last row, and the panel below it stays empty:
  // two query parameters.
  await secondRow.click();
  await page.getByRole('tab', { name: 'Query' }).click();
  await expect(queryPanel).toContainText('marker');

  const short = await measureShortBlock(queryPanel);

  expect(Math.abs(short.spaceUnderLastRow)).toBeLessThanOrEqual(1);
  expect(short.emptyPanelBelow).toBeGreaterThan(0);
  await expectOnlyTheTabAreaScrolls(queryPanel, { deep: false, caption: true });

  /*
   * A non-standard method arrives and its name stays on one line in the header
   * (D139). `M-SEARCH` is the one accepted name with a break opportunity in it,
   * and beside a target long enough to be truncated the header folded it into
   * `M-` over `SEARCH`. Sent last, like the blocks, and through the same proxy
   * as every other request here.
   */
  const mSearch = await request.fetch(`${receiveUrl}?${longQuery}`, { method: 'M-SEARCH' });

  expect(mSearch.status()).toBe(200);

  const mSearchRow = requestRow(page, storedRequestId(mSearch));

  await expect(mSearchRow).toBeVisible();
  await mSearchRow.click();

  const method = page.getByTestId('detail-method');

  await expect(method).toHaveText('M-SEARCH');
  expect(
    await method.evaluate(
      (element) =>
        element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight),
    ),
  ).toBe(true);

  await expectPathsUnderTheEndpoint(page, request, { sessionId, receiveUrl });
});

/**
 * A path under the endpoint (D173), sent to the receive listener directly as
 * every webhook here is (D187), the path and its percent-encoding untouched on
 * the way. Each request is captured, arrives over realtime, gets a row that names no
 * path, and is drawn in the detail header as the session part, the path and
 * the query in one flow - measured, because the flow is a property of a laid
 * out page that no unit test can see:
 *
 * - everything on one line when it fits (1440 px);
 * - the path and the query each continue the current line if they fit there
 *   whole and start a line of their own only if they do not, at 1440, 768 and
 *   375 px;
 * - a path longer than a line wraps for three lines and is cut, a query longer
 *   than a line keeps one line and is cut;
 * - the text is the stored target exactly, percent-encoding intact, with no
 *   `title`;
 * - at 320 px nothing scrolls sideways.
 *
 * The request list is not asserted beyond its rows' text: no row changed.
 * Leaves the window at 1440x1024.
 */
async function expectPathsUnderTheEndpoint(
  page: Page,
  request: APIRequestContext,
  { sessionId, receiveUrl }: { sessionId: string; receiveUrl: string },
): Promise<void> {
  const longPath = '/api/v2/integrations/stripe/webhooks/events/charge.succeeded';
  const longQuery = 'livemode=false&attempt=3&idempotency_key=8d3f1c2a-5b7e-4e9a-9c1d-2f6a7b8c9d0e';
  const cases: { name: string; method: string; rest: string; query: string; body?: string }[] = [
    {
      name: 'short path, short query',
      method: 'POST',
      rest: '/stripe/events',
      query: 'livemode=false',
    },
    { name: 'long path, short query', method: 'POST', rest: longPath, query: 'livemode=false' },
    { name: 'short path, long query', method: 'POST', rest: '/stripe/events', query: longQuery },
    { name: 'long path, long query', method: 'POST', rest: longPath, query: longQuery },
    // Longer than three lines at any width the panel has.
    {
      name: 'a path over three lines',
      method: 'POST',
      rest: `/${'segment-'.repeat(60)}`,
      query: 'q=1',
    },
    // Longer than a line at any width.
    {
      name: 'a query over a line',
      method: 'GET',
      rest: '',
      query: `code=${'4%2F0AeanS0ZqT3xY8vB2nK7mP1'.repeat(20)}`,
    },
    { name: 'a one-character path', method: 'POST', rest: '/h', query: '' },
    { name: 'a trailing slash', method: 'POST', rest: '/', query: 'a=1' },
    {
      name: 'a WebDAV folder',
      method: 'PROPFIND',
      rest: '/folder/',
      query: '',
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/></prop></propfind>',
    },
    {
      name: 'a percent-encoded path',
      method: 'POST',
      rest: '/%D0%BF%D0%BB%D0%B0%D1%82%D0%B5%D0%B6%D0%B8/new',
      query: '',
    },
  ];
  const rawPanel = page.getByRole('tabpanel', { name: 'Raw' });

  for (const { name, method, rest, query, body } of cases) {
    const path = `/s/${sessionId}${rest}`;
    const target = `${path}${query === '' ? '' : `?${query}`}`;
    const sent = await request.fetch(`${receiveUrl}${rest}${query === '' ? '' : `?${query}`}`, {
      method,
      headers: { 'content-type': body === undefined ? 'application/json' : 'application/xml' },
      data: body ?? (method === 'GET' ? undefined : '{"event":"charge.succeeded"}'),
    });

    expect(sent.status(), name).toBe(200);

    // Over realtime, with nothing reloaded: a row that shows no path.
    const row = requestRow(page, storedRequestId(sent));

    await expect(row).toBeVisible();
    await expect(row).not.toContainText('/');
    await row.click();

    // Stored as sent, and shown whole in `Raw`.
    await expect(rawPanel).toContainText(`${method} ${target} HTTP/1.1`);
    await expect(page.getByTestId('detail-target')).toHaveText(target);

    const wide = await measureTarget(page);

    expect(wide.title, name).toBeNull();
    expectTargetFlow(wide, name, '1440');

    // The session part stays whole with a lone `/`, and a one-character path
    // is a path: the frames' two edge cases.
    if (rest === '/') {
      expect(wide.session, name).toBe(`${path}`);
      expect(wide.path, name).toBeNull();
    } else if (rest !== '') {
      expect(wide.path?.text, name).toBe(rest);
    }

    // What fits on one line at 1440 is one line.
    if (name === 'short path, short query' || rest === '/h' || rest === '/folder/') {
      expect(wide.lines, name).toBe(1);
    }

    if (name === 'a path over three lines') {
      expect(wide.path?.lines, name).toBe(3);
      expect(wide.path?.cut, name).toBe(true);
    }

    if (name === 'a query over a line') {
      expect(wide.query?.lines, name).toBe(1);
      expect(wide.query?.cut, name).toBe(true);
    }

    // The same rule at a tablet's and a phone's width, where `/s/<id>` itself
    // takes two lines; at 320 px nothing scrolls sideways.
    for (const [width, height] of [
      [768, 1024],
      [375, 812],
    ] as const) {
      await page.setViewportSize({ width, height });

      const narrow = await measureTarget(page);

      expectTargetFlow(narrow, name, String(width));

      if (width === 375) {
        expect(narrow.sessionLines, name).toBe(2);
      }
    }

    await page.setViewportSize({ width: 320, height: 700 });
    expect((await measureTarget(page)).pageScrollsSideways, name).toBe(false);
    await page.setViewportSize({ width: 1440, height: 1024 });
  }
}

/** The three parts of the detail header's target, as laid out (D173). */
interface TargetPart {
  text: string;
  /** Lines of its own line height. */
  lines: number;
  /** It begins at the target's left edge, that is, on a line of its own. */
  startsLine: boolean;
  /** Its width fits in what the line before it left free. */
  fitsAfterPrevious: boolean;
  /** Its width fits in a whole line. */
  fitsALine: boolean;
  /** Its content is longer than what it shows. */
  cut: boolean;
  /** Its right edge is inside the target. */
  inside: boolean;
}

async function measureTarget(page: Page) {
  return page.getByTestId('detail-target').evaluate((target) => {
    const box = target.getBoundingClientRect();
    const session = target.querySelector('[data-testid="detail-target-session"]') as HTMLElement;
    const sessionRects = [...session.getClientRects()];
    let previousRight = sessionRects[sessionRects.length - 1]?.right ?? box.left;

    const part = (name: string): TargetPart | null => {
      const element = target.querySelector<HTMLElement>(`[data-testid="detail-target-${name}"]`);

      if (element === null) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      // The width the part would take on one line, unbroken and uncut: a copy
      // of it, out of the flow and unseen, that neither wraps nor clamps.
      const probe = element.cloneNode(true) as HTMLElement;

      probe.style.cssText =
        'position:absolute;visibility:hidden;display:inline-block;white-space:nowrap;max-width:none;width:auto;';
      target.append(probe);

      const natural = probe.getBoundingClientRect().width;

      probe.remove();

      const measured: TargetPart = {
        text: element.textContent ?? '',
        lines: Math.round(rect.height / lineHeight),
        startsLine: Math.abs(rect.left - box.left) < 1,
        fitsAfterPrevious: natural <= box.right - previousRight + 0.5,
        fitsALine: natural <= box.width + 0.5,
        cut:
          element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1,
        inside: rect.right <= box.right + 0.5,
      };

      previousRight = rect.right;

      return measured;
    };

    const path = part('path');
    const query = part('query');

    return {
      title: target.getAttribute('title'),
      session: session.textContent,
      sessionLines: sessionRects.length,
      // Lines of the id's 20 px: the height of a target that is one line.
      lines: Math.round(box.height / 20),
      path,
      query,
      pageScrollsSideways:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

/**
 * The flow rule of D173 for one measured target: each of the path and the
 * query continues the current line exactly when it fits there whole, and one
 * longer than a line is the only part that breaks - the path for three lines at
 * most, the query not at all.
 */
function expectTargetFlow(
  measured: Awaited<ReturnType<typeof measureTarget>>,
  name: string,
  width: string,
): void {
  const label = `${name} at ${width}`;

  for (const part of [measured.path, measured.query]) {
    if (part === null) {
      continue;
    }

    expect(part.inside, label).toBe(true);
    expect(part.startsLine, `${label}: ${part.text.slice(0, 24)}`).toBe(!part.fitsAfterPrevious);
  }

  if (measured.path !== null) {
    expect(measured.path.lines, label).toBeLessThanOrEqual(3);
    expect(measured.path.lines === 1, label).toBe(measured.path.fitsALine);
  }

  if (measured.query !== null) {
    expect(measured.query.lines, label).toBe(1);
    expect(measured.query.cut, label).toBe(!measured.query.fitsALine);
  }

  expect(measured.pageScrollsSideways, label).toBe(false);
}

/**
 * `Download JSON` from the request actions (issue #73, D185; Figma
 * `Webhook Inspector · Request actions`, C2, C5):
 *
 * - it is the first item after the menu's divider, and choosing it closes the
 *   menu;
 * - the browser's download event carries `qa-tools-request-<short id>.json`,
 *   and the file, parsed, deep-equals the detail API's answer for the
 *   request, `response` included;
 * - choosing it sends nothing to `/api/` and shows no toast;
 * - on a phone, the `Request actions` sheet offers it after its divider too,
 *   and closes as it saves the same file.
 *
 * Leaves the window at 1440x1024 with the menu closed.
 */
async function expectDownloadJson(
  page: Page,
  request: APIRequestContext,
  { sessionId, requestId }: { sessionId: string; requestId: string },
): Promise<void> {
  const actions = page.getByRole('button', { name: 'Actions', exact: true });
  const menu = page.getByRole('menu', { name: 'Actions' });
  const toast = page.getByTestId('toast');
  const fileName = `qa-tools-request-${requestId.slice(0, 7)}.json`;

  const detail = await request.get(`/api/sessions/${sessionId}/requests/${requestId}`);

  expect(detail.status()).toBe(200);

  const expected = (await detail.json()) as RequestDetails;

  expect(expected.response, 'the first request has a recorded response').not.toBeNull();

  // Any call the page makes to the API while the item is chosen.
  const apiCalls: string[] = [];
  const recordApiCall = (sent: { url: () => string }) => {
    if (new URL(sent.url()).pathname.startsWith('/api/')) {
      apiCalls.push(sent.url());
    }
  };

  // No toast is up before the item is chosen, so none after it is its own.
  await expect(toast).toHaveCount(0);

  await actions.click();
  await expect(menu).toBeVisible();
  // First after the divider (C2).
  await expect(menu.getByRole('separator')).toHaveCount(1);
  await expect(menu.locator('[role="separator"] + [role="menuitem"]')).toHaveText('Download JSON');

  page.on('request', recordApiCall);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    menu.getByRole('menuitem', { name: 'Download JSON', exact: true }).click(),
  ]);

  await expect(menu).toBeHidden();
  expect(download.suggestedFilename()).toBe(fileName);
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(expected);
  // No confirmation of its own, and nothing asked of the server.
  await expect(toast).toHaveCount(0);
  expect(apiCalls, 'Download JSON called the API from the menu').toEqual([]);

  // The phone's sheet: the same item after its divider, the same file. The
  // listener stays attached; what the page may load as the layout changes is
  // not the item's, so the count restarts once the sheet is open.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Request actions' }).click();

  const sheet = page.getByRole('dialog', { name: 'Request actions' });

  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[role="separator"] + button')).toHaveText('Download JSON');
  apiCalls.length = 0;

  const [phoneDownload] = await Promise.all([
    page.waitForEvent('download'),
    sheet.getByRole('button', { name: 'Download JSON', exact: true }).click(),
  ]);

  await expect(sheet).toBeHidden();
  expect(phoneDownload.suggestedFilename()).toBe(fileName);
  expect(JSON.parse(await readFile(await phoneDownload.path(), 'utf8'))).toEqual(expected);
  await expect(toast).toHaveCount(0);
  page.off('request', recordApiCall);
  expect(apiCalls, 'Download JSON called the API from the sheet').toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 1440, height: 1024 });
  await expect(actions).toBeVisible();
}

/**
 * `Copy as cURL` from the request actions (D167, moved there by D182; Figma
 * `Webhook Inspector · Request actions`, C1-C4), with the clipboard stubbed as
 * everywhere in this suite (see `readReceiveUrl`), so that both outcomes can
 * be driven:
 *
 * - the view strip holds its four views and nothing else: no `Copy as cURL`
 *   on it, as a tab or beside the tabs;
 * - `Actions ▾` opens the menu, whose `Copy as cURL` writes exactly what the
 *   builder makes of this request's detail - the builder's rules are
 *   unit-tested and run through real curl in `curl-command.roundtrip.test.ts`;
 *   here it is the wiring that is pinned - closes the menu, and only then
 *   shows the toast `cURL command copied`, with the view tab chosen before
 *   still selected;
 * - a refused write shows the toast with the info icon, saying the command
 *   was not copied, and never the success;
 * - by width: `Actions ▾` at 800 px, the Back bar's `⋯` and its sheet at 375
 *   and 320 px, each copying the same command, and nothing scrolls sideways.
 *
 * Leaves the window at 1440x1024, the menu closed and the tab that was
 * selected still selected.
 */
async function expectCopyAsCurl(
  page: Page,
  request: APIRequestContext,
  { sessionId, requestId }: { sessionId: string; requestId: string },
): Promise<void> {
  const actions = page.getByRole('button', { name: 'Actions', exact: true });
  const menu = page.getByRole('menu', { name: 'Actions' });
  const toast = page.getByTestId('toast');
  const selectedBefore = await page.getByRole('tab', { selected: true }).allInnerTexts();

  // The strip holds its four views only (D182).
  await expect(page.getByRole('tab', { name: /cURL/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /cURL/ })).toHaveCount(0);
  await expect(actions).toBeVisible();

  // Every write lands here, or is refused, depending on the flag.
  await page.evaluate(() => {
    const state = window as unknown as { __copied: string[]; __refuse: boolean };

    state.__copied = [];
    state.__refuse = false;
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: (text: string) => {
        if (state.__refuse) {
          return Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
        }

        state.__copied.push(text);

        return Promise.resolve();
      },
    });
  });

  const copiedTexts = () =>
    page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  const refuse = (value: boolean) =>
    page.evaluate((flag) => {
      (window as unknown as { __refuse: boolean }).__refuse = flag;
    }, value);

  await actions.click();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Copy as cURL', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(toast).toHaveText('cURL command copied');
  await expect(toast).toHaveAttribute('data-icon', 'check');
  // The view tab chosen before is still the one selected.
  expect(await page.getByRole('tab', { selected: true }).allInnerTexts()).toEqual(selectedBefore);

  // Exactly the builder's command for this request, as the API returns it.
  const detail = await request.get(`/api/sessions/${sessionId}/requests/${requestId}`);

  expect(detail.status()).toBe(200);

  // The receive URL's origin, not the page's: the command re-captures where
  // webhooks are received (D187).
  const origin = new URL(await receiveUrlOf(request, sessionId)).origin;
  const command = buildCurlCommand((await detail.json()) as RequestDetails, { origin, sessionId });

  expect(origin).not.toBe(new URL(page.url()).origin);
  expect(await copiedTexts()).toEqual([command]);
  expect(command.split('\n')[0]).toBe(`curl '${origin}/s/${sessionId}?marker=alpha&attempt=1' \\`);
  expect(command).toMatch(/\n {2}-H 'x-e2e-marker: alpha' \\\n/i);
  expect(command.endsWith(`\n  --data-raw '${FIRST_BODY}'`)).toBe(true);

  // A refused write: the info toast says what was not copied, and nothing
  // is claimed.
  await refuse(true);
  await actions.click();
  await menu.getByRole('menuitem', { name: 'Copy as cURL', exact: true }).click();
  await expect(toast).toHaveText('The browser refused the copy. The cURL command was not copied.');
  await expect(toast).toHaveAttribute('data-icon', 'info');
  expect(await copiedTexts()).toHaveLength(1);
  await refuse(false);

  for (const { width, height } of [
    { width: 800, height: 1024 },
    { width: 375, height: 812 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize({ width, height });
    // A request opened below 1024 px is shown without the footer band, as it
    // is without the endpoint card (D177).
    await expect(page.getByRole('contentinfo')).toBeHidden();

    // Counted per width: the toast and the last command written are still
    // there from the width before, so only one more write shows this one's.
    const writtenBefore = (await copiedTexts()).length;

    if (width >= 768) {
      // The tablet keeps `Actions ▾` on the `Request` · `Response` row.
      await expect(page.getByRole('button', { name: 'Request actions' })).toHaveCount(0);
      await actions.click();
      await menu.getByRole('menuitem', { name: 'Copy as cURL', exact: true }).click();
    } else {
      // A phone has the Back bar's `⋯` and its sheet instead.
      await expect(actions).toHaveCount(0);
      // The toast of the width before is still up, and would cover the
      // sheet's last row: the sheet takes it away as it opens, well inside
      // the 5 s the toast would otherwise stay.
      await expect(toast).toBeVisible();
      await page.getByRole('button', { name: 'Request actions' }).click();

      const sheet = page.getByRole('dialog', { name: 'Request actions' });

      await expect(sheet).toBeVisible();
      await expect(toast).toHaveCount(0, { timeout: 1_000 });
      await sheet.getByRole('button', { name: 'Copy as cURL', exact: true }).click();
      await expect(sheet).toBeHidden();
    }

    await expect.poll(async () => (await copiedTexts()).length).toBe(writtenBefore + 1);
    expect((await copiedTexts()).at(-1)).toBe(command);
    await expect(toast).toHaveText('cURL command copied');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }

  await page.setViewportSize({ width: 1440, height: 1024 });
  await expect(actions).toBeVisible();
}

/**
 * The header's links, as every page draws them (issue #51, D158; issue #97,
 * D184; issue #99, D209): `Changelog`, a plain link to `/changelog` in the
 * same tab; `Status ↗`, to the public status page in a new tab; and
 * `API docs ↗`, pointing at `/docs` in a new tab and reachable by keyboard;
 * the two named for the new tab they open; the service's name only in the
 * wordmark (D277), no tool name beside it (D184). Returns the link to the API
 * reference.
 */
async function expectHeaderLinks(page: Page): Promise<Locator> {
  const banner = page.getByRole('banner');
  const link = banner.getByRole('link', { name: 'API docs (opens in a new tab)', exact: true });
  const status = banner.getByRole('link', { name: 'Status (opens in a new tab)', exact: true });

  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/docs');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute('href', STATUS_PAGE_URL);
  await expect(status).toHaveAttribute('target', '_blank');
  await expect(status).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(status).not.toHaveAttribute('aria-current', /.*/);
  await expect(banner.getByText('Webhook Inspector')).toHaveCount(1);
  await expect(
    banner.getByRole('link', { name: 'Webhook Inspector', exact: true }),
  ).toHaveAttribute('href', '/');

  const changelog = banner.getByRole('link', { name: 'Changelog', exact: true });

  await expect(changelog).toBeVisible();
  await expect(changelog).toHaveAttribute('href', '/changelog');
  await expect(changelog).not.toHaveAttribute('target', /.*/);
  await expect(changelog).not.toHaveAttribute('aria-current', /.*/);
  await link.focus();
  await expect(link).toBeFocused();

  return link;
}

/**
 * The footer every page closes with (issue #88, D177): the approved text byte
 * for byte, `About`, `Terms` and `Privacy` links to `/about`, `/terms` and
 * `/privacy` in the same tab (D211, D217) and the address a `mailto:` link;
 * at the suite's 1440 x 1024, one 34 px line at the bottom of the window, the
 * links and the contact on the right at the header's 28 px.
 * The text is read as `textContent`, because Playwright's text matchers fold
 * a no-break space into a plain one and could not tell them apart.
 */
async function expectPrivacyFooter(page: Page): Promise<void> {
  const footer = page.getByRole('contentinfo');

  await expect(footer).toBeVisible();
  expect(await footer.evaluate((element) => element.textContent)).toBe(PRIVACY_FOOTER_TEXT);
  await expect(
    footer.getByRole('link', { name: PRIVACY_FOOTER.address, exact: true }),
  ).toHaveAttribute('href', PRIVACY_FOOTER.href);

  for (const [label, href] of [
    ['About', '/about'],
    ['Terms', '/terms'],
    ['Privacy', '/privacy'],
  ] as const) {
    const link = footer.getByRole('link', { name: label, exact: true });

    await expect(link).toHaveAttribute('href', href);
    await expect(link).not.toHaveAttribute('target', /.*/);
    await expect(link).not.toHaveAttribute('aria-current', /.*/);
  }

  const band = await measureFooter(page);

  expect(band.height).toBe(34);
  expect(band.bottom).toBe(band.viewportHeight);
  expect(band.contactTop).toBe(band.lineTop);
  expect(band.right - band.contactRight).toBe(28);
}

/**
 * The footer band as laid out: its box, its two parts - the line, and `About`
 * with the contact - and what is above it.
 */
async function measureFooter(page: Page) {
  return page.getByRole('contentinfo').evaluate((footer) => {
    const band = footer.getBoundingClientRect();
    const [line, contact] = Array.from(footer.querySelectorAll('p > span'), (span) =>
      span.getBoundingClientRect(),
    );
    const main = document.querySelector('main') as HTMLElement;
    const content = (main.lastElementChild as HTMLElement).getBoundingClientRect();

    return {
      height: band.height,
      top: band.top,
      bottom: band.bottom,
      right: band.right,
      lineTop: line?.top,
      contactTop: contact?.top,
      contactRight: contact?.right ?? 0,
      contentBottom: content.bottom,
      viewportHeight: window.innerHeight,
      pageScrollsSideways:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

/**
 * The session page's blocks, as laid out (issue #96): the header, the endpoint
 * card - `main`'s first child - and the panes' row - its last - whose first and
 * last children are the list and the detail panel. `listToDetail` means
 * something on the desktop only: below 1024 px the detail panel is hidden.
 */
async function measureSessionBlocks(page: Page) {
  return page.getByRole('main').evaluate((main) => {
    const header = (document.querySelector('header') as HTMLElement).getBoundingClientRect();
    const card = (main.firstElementChild as HTMLElement).getBoundingClientRect();
    const panes = main.lastElementChild as HTMLElement;
    const list = (panes.firstElementChild as HTMLElement).getBoundingClientRect();
    const detail = (panes.lastElementChild as HTMLElement).getBoundingClientRect();

    return {
      headerToCard: card.top - header.bottom,
      cardHeight: card.height,
      cardToPanes: panes.getBoundingClientRect().top - card.bottom,
      listToDetail: detail.left - list.right,
    };
  });
}

/** The one scroll of a half: the area its view panels sit in (D149). */
function tabArea(panel: Locator): Locator {
  return panel.locator('xpath=..');
}

/** An element's scroll geometry, as the browser laid it out. */
async function scrollGeometry(locator: Locator) {
  return locator.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
}

/**
 * Criteria 1, 2 and 8 of issue #26, on the view that is showing: its box
 * scrolls in neither direction, the tab area around it never scrolls sideways,
 * and the block has exactly the caption it is expected to have, ending above
 * the box.
 *
 * With `deep`, the tab area also scrolls down through several screens, without
 * which a box that had rendered nothing at all would satisfy the rest.
 *
 * The caption is found as the block's own paragraph wherever it is in the
 * block, before the box or after it, and never by its position next to the
 * box: a caption rendered after the box, as the layout before D149 did, has to
 * fail here rather than go unfound.
 */
async function expectOnlyTheTabAreaScrolls(
  panel: Locator,
  { deep, caption }: { deep: boolean; caption: boolean },
) {
  const area = tabArea(panel);

  await expect(area).toHaveAttribute('data-testid', 'tab-area');

  const box = await scrollGeometry(panel.getByTestId('block-content'));
  const scroll = await scrollGeometry(area);

  expect(box.scrollWidth).toBe(box.clientWidth);
  expect(box.scrollHeight).toBe(box.clientHeight);
  expect(scroll.scrollWidth).toBe(scroll.clientWidth);

  if (deep) {
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight * 2);
  }

  const captions = await panel.getByTestId('block-content').evaluate((content) => {
    const box = content.parentElement as HTMLElement;
    const block = box.parentElement as HTMLElement;
    const top = box.getBoundingClientRect().top;

    return [...block.querySelectorAll(':scope > p')].map(
      (paragraph) => paragraph.getBoundingClientRect().bottom <= top,
    );
  });

  expect(captions).toEqual(caption ? [true] : []);
}

/**
 * Every element of the detail panel that scrolls down, by its test id or tag,
 * and whether the page itself does.
 */
async function verticalScrolls(panel: Locator) {
  return tabArea(panel).evaluate((area) => {
    const section = area.closest('section') as HTMLElement;
    const scrolling = [...section.querySelectorAll<HTMLElement>('*')].filter((element) => {
      const { overflowY } = getComputedStyle(element);

      return (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        element.scrollHeight > element.clientHeight
      );
    });
    const root = document.documentElement;

    return {
      inPanel: scrolling.map((element) => element.dataset.testid ?? element.tagName),
      page: root.scrollHeight > root.clientHeight,
    };
  });
}

/** Whether the showing box runs on past the bottom of the tab area. */
async function boxEndsBelowTheTabArea(panel: Locator) {
  return tabArea(panel).evaluate((area) => {
    const box = area.querySelector('[data-testid="block-content"]') as HTMLElement;

    return box.getBoundingClientRect().bottom > area.getBoundingClientRect().bottom;
  });
}

/**
 * Scrolls the tab area into the middle of the showing box and reads where its
 * copy control is, whether the text stays clear of it, and where everything
 * above the tab area is before and after (criteria 4 and 7).
 */
async function scrollIntoTheMiddle(panel: Locator) {
  const page = panel.page();
  const fixedTops = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[role="tablist"], [data-testid="request-facts"]')]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.getBoundingClientRect().top),
    );
  const stripsBefore = await fixedTops();
  const area = tabArea(panel);

  await area.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  });

  const measured = await area.evaluate((element) => {
    const content = element.querySelector('[data-testid="block-content"]') as HTMLElement;
    const control = (content.parentElement as HTMLElement).querySelector('button') as HTMLElement;
    const controlRect = control.getBoundingClientRect();

    return {
      scrollTop: element.scrollTop,
      controlBelowAreaTop: controlRect.top - element.getBoundingClientRect().top,
      textClearOfControl: content.getBoundingClientRect().right <= controlRect.left,
    };
  });
  const stripsAfter = await fixedTops();

  await area.evaluate((element) => {
    element.scrollTop = 0;
  });

  return { ...measured, stripsBefore, stripsAfter };
}

/**
 * The stored line holding `needle` in a re-indented body: whether its value
 * starts on the key's own row, and where each continuation row starts relative
 * to the key's first character, in characters of the face itself.
 */
async function measureHangingIndent(panel: Locator, needle: string) {
  return panel.getByTestId('block-content').evaluate((content, wanted) => {
    const line = [...content.querySelectorAll('pre > span')].find((span) =>
      span.textContent?.includes(wanted),
    ) as HTMLElement;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      nodes.push(node as Text);
    }

    const range = document.createRange();
    const box = (offset: number) => {
      let rest = offset;

      for (const node of nodes) {
        if (rest < node.length) {
          range.setStart(node, rest);
          range.setEnd(node, rest + 1);

          return range.getBoundingClientRect();
        }

        rest -= node.length;
      }

      throw new Error(`offset ${offset} is outside the line`);
    };
    const text = line.textContent ?? '';
    const indent = text.length - text.trimStart().length;
    const key = box(indent);
    const continuations: number[] = [];
    let row = key.top;

    for (let offset = indent + 1; offset < text.length; offset += 1) {
      const character = box(offset);

      if (character.top > row + 1) {
        continuations.push((character.left - key.left) / key.width);
        row = character.top;
      }
    }

    return {
      valueOnKeyRow: Math.abs(box(text.indexOf('": ', indent) + 3).top - key.top) < 1,
      continuations,
    };
  }, needle);
}

/** One `Headers` or `Query` row, found by its value cell (criterion 6). */
async function measureRow(value: Locator) {
  return value.evaluate((cell) => {
    const name = cell.previousElementSibling as HTMLElement;
    const lineHeight = parseFloat(getComputedStyle(cell).lineHeight);
    const nameRect = name.getBoundingClientRect();
    const valueRect = cell.getBoundingClientRect();
    const content = cell.closest('[data-testid="block-content"]') as HTMLElement;

    return {
      nameRows: Math.round(nameRect.height / lineHeight),
      valueRows: Math.round(valueRect.height / lineHeight),
      valueRightOfName: valueRect.left >= nameRect.right,
      valueInsideBox: valueRect.right <= content.getBoundingClientRect().right,
    };
  });
}

/**
 * A short block: the space between its last row and the box's bottom edge
 * beyond the box's own padding, and the empty panel under the box.
 */
async function measureShortBlock(panel: Locator) {
  return panel.getByTestId('block-content').evaluate((content) => {
    const rows = content.firstElementChild as HTMLElement;
    const padding = parseFloat(getComputedStyle(content).paddingBottom);
    const bottom = content.getBoundingClientRect().bottom;
    const area = content.closest('[data-testid="tab-area"]') as HTMLElement;

    return {
      spaceUnderLastRow: bottom - rows.getBoundingClientRect().bottom - padding,
      emptyPanelBelow: area.getBoundingClientRect().bottom - bottom,
    };
  });
}
