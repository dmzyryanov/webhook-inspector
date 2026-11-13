import { expect, test } from '@playwright/test';
import { createSessionViaApi, receiveUrlOf, requestRow, storedRequestId } from './helpers.ts';

/** A token only one request's body holds: no list field of any row shows it. */
const BODY_TOKEN = 'tok-48213-zq';

/**
 * E2E-08 — the request list's filter (issue #70, D180; issue #78, D191): the
 * search icon opens the field in the header, typing narrows the list in the
 * browser at once, a path the rows do not show is matched, Escape on an empty
 * field and `×` bring the heading back, and the filter of a session is
 * restored on reload while another session starts unfiltered. A word of three
 * bytes or more is also searched in headers and bodies on the server, its
 * words in the request's body and never in its URL: a webhook whose body
 * holds a token is found by typing it, with nothing highlighted, and a
 * shorter word asks the server nothing.
 *
 * The Figma frames the search's steps cite, A1, A4.3, A4.5 and A4.6, are
 * frames of the Figma page `Webhook Inspector · Body and header search`.
 */
test('The list filter narrows the rows, finds a body on the server, and clears again', async ({
  page,
  request,
}) => {
  const sessionId = await createSessionViaApi(request);
  const otherSessionId = await createSessionViaApi(request);
  const receiveUrl = await receiveUrlOf(request, sessionId);
  const send = async (path: string, data = '{"event":"x"}'): Promise<string> => {
    const sent = await request.post(`${receiveUrl}${path}`, {
      headers: { 'content-type': 'application/json' },
      data,
    });

    expect(sent.status()).toBe(200);

    return storedRequestId(sent);
  };
  const root = await send('');
  const stripeOne = await send('/stripe/events');
  const stripeTwo = await send('/stripe/events?livemode=false');
  const withToken = await send('', `{"order":"${BODY_TOKEN}"}`);
  const all = [root, stripeOne, stripeTwo, withToken];

  await page.goto(`/v/${sessionId}`);

  const heading = page.getByRole('heading', { name: 'Requests', exact: true });

  for (const id of all) {
    await expect(requestRow(page, id)).toBeVisible();
  }

  await expect(heading).toBeVisible();

  // The icon opens an empty, focused field in place of the heading (2F).
  await page.getByRole('button', { name: 'Filter requests' }).click();

  const field = page.getByRole('searchbox', { name: 'Filter requests' });

  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('placeholder', 'Search the list, headers and bodies');
  // Hidden visually, kept for assistive technology.
  await expect(heading).toHaveClass(/sr-only/);

  // Escape on the empty field brings the heading back.
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(heading).not.toHaveClass(/sr-only/);

  // Every call to the API from here on: the only one a filter makes is the
  // search, a POST whose words are in its body (D191).
  const apiCalls: { method: string; path: string; search: string; body: string | null }[] = [];

  page.on('request', (sent) => {
    const url = new URL(sent.url());

    if (url.pathname.startsWith('/api/')) {
      apiCalls.push({
        method: sent.method(),
        path: url.pathname,
        search: url.search,
        body: sent.postData(),
      });
    }
  });

  const searchPath = `/api/sessions/${sessionId}/requests/search`;
  /** The words of each search the page has sent, in order. */
  const searchedWords = (): string[][] =>
    apiCalls
      .filter((call) => call.path === searchPath)
      .map((call) => (JSON.parse(call.body ?? '{}') as { words: string[] }).words);

  // A word under three bytes filters the list and asks the server nothing:
  // `ev` is in the path of the two requests to `/stripe/events` and in no
  // other list field.
  await page.getByRole('button', { name: 'Filter requests' }).click();
  await field.fill('ev');
  await expect(page.getByTestId('filter-count')).toHaveText('2 of 4 / 1000');
  // Longer than the pause after which a search would have started.
  await page.waitForTimeout(700);
  expect(apiCalls).toEqual([]);

  // Typing filters at once, by a path the rows do not show.
  await field.fill('stripe');

  await expect(requestRow(page, root)).toHaveCount(0);
  await expect(requestRow(page, withToken)).toHaveCount(0);
  await expect(requestRow(page, stripeOne)).toBeVisible();
  await expect(requestRow(page, stripeTwo)).toBeVisible();
  await expect(page.getByTestId('filter-count')).toHaveText('2 of 4 / 1000');
  // A path the rows do not show has nothing to highlight (2B).
  await expect(page.locator('mark')).toHaveCount(0);

  // The server is asked by itself, once typing has stopped: one POST, the
  // word in its body and nowhere in its URL.
  await expect.poll(searchedWords).toEqual([['stripe']]);
  expect(apiCalls.map((call) => `${call.method} ${call.path}${call.search}`)).toEqual([
    `POST ${searchPath}`,
  ]);
  // A fast search shows neither a spinner nor a notice (Figma frame A1).
  await expect(page.getByTestId('filter-spinner')).toHaveCount(0);
  await expect(page.getByTestId('search-notice')).toHaveCount(0);
  await expect(page.getByTestId('filter-count')).toHaveText('2 of 4 / 1000');

  // Delete all names the total and what the filter hides (2J); cancelled here.
  await page.getByRole('button', { name: 'Delete all' }).click();

  const dialog = page.getByRole('dialog', { name: 'Delete all requests?' });

  await expect(dialog).toContainText(
    'This will permanently delete all 4 requests from this session, including 2 hidden by the filter.',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // A token only a body holds: the request is found on the server, and
  // nothing in its row is highlighted (Figma frame A1, D191).
  await field.fill(BODY_TOKEN);
  await expect(requestRow(page, withToken)).toBeVisible();

  for (const id of [root, stripeOne, stripeTwo]) {
    await expect(requestRow(page, id)).toHaveCount(0);
  }

  await expect(page.getByTestId('filter-count')).toHaveText('1 of 4 / 1000');
  await expect(page.locator('mark')).toHaveCount(0);
  await expect(page.getByTestId('search-notice')).toHaveCount(0);
  expect(searchedWords().at(-1)).toEqual([BODY_TOKEN]);

  // Each word in a list field or in Raw: the method from the row, where it
  // is highlighted, the token from the body.
  await field.fill(`POST ${BODY_TOKEN}`);
  await expect.poll(() => searchedWords().at(-1)).toEqual(['POST', BODY_TOKEN]);
  await expect(requestRow(page, withToken)).toBeVisible();
  await expect(page.getByTestId('filter-count')).toHaveText('1 of 4 / 1000');
  await expect(page.locator('mark')).toHaveText(['POST']);

  // Raw is matched case-sensitively: the same token in capitals is nowhere,
  // and the empty result says that headers and bodies were searched (Figma
  // frame A4.5).
  await field.fill(BODY_TOKEN.toUpperCase());
  await expect(page.getByText(`No requests match “${BODY_TOKEN.toUpperCase()}”`)).toBeVisible();
  await expect(page.getByText('Headers and bodies were searched too.')).toBeVisible();

  // No word of any search reached a URL.
  for (const call of apiCalls) {
    expect(`${call.path}${call.search}`).not.toContain('stripe');
    expect(`${call.path}${call.search}`.toLowerCase()).not.toContain(BODY_TOKEN);
  }

  // Nothing matches: never `Waiting for the first request` (2G).
  await field.fill('stripe DELETE');
  await expect(page.getByText('No requests match “stripe DELETE”')).toBeVisible();
  await expect(page.getByText('Waiting for the first request')).toHaveCount(0);

  // The filter of this session survives a reload, the field showing it.
  await field.fill('POST stripe');
  await page.reload();
  await expect(field).toHaveValue('POST stripe');
  await expect(requestRow(page, root)).toHaveCount(0);
  await expect(requestRow(page, stripeOne)).toBeVisible();
  // Matches in what the row shows are highlighted: the method (2C).
  await expect(page.locator('mark', { hasText: 'POST' })).toHaveCount(2);

  // And the status, inside the pill of an answer the session gave (D207).
  await field.fill('200');

  const rootStatus = requestRow(page, root).getByTestId('row-status');

  await expect(requestRow(page, root)).toBeVisible();
  await expect(rootStatus.locator('mark')).toHaveText('200');
  await expect(rootStatus).toHaveCSS('background-color', 'rgb(225, 242, 232)');

  // A restored filter is searched too, with no typing: the body's token is
  // found again after a reload.
  await field.fill(BODY_TOKEN);
  await expect(requestRow(page, withToken)).toBeVisible();
  await page.reload();
  await expect(field).toHaveValue(BODY_TOKEN);
  await expect(requestRow(page, withToken)).toBeVisible();
  await expect(page.getByTestId('filter-count')).toHaveText('1 of 4 / 1000');

  // A request arriving under the filter appears once its body is searched.
  const late = await send('/late', `{"order":"${BODY_TOKEN}","late":true}`);

  await expect(requestRow(page, late)).toBeVisible();
  await expect(page.getByTestId('filter-count')).toHaveText('2 of 5 / 1000');
  await expect(page.locator('mark')).toHaveCount(0);
  all.push(late);

  // Another session starts unfiltered.
  await page.goto(`/v/${otherSessionId}`);
  await expect(page.getByRole('searchbox', { name: 'Filter requests' })).toHaveCount(0);
  await page.goto(`/v/${sessionId}`);

  // `×` restores the full list and the heading.
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(field).toHaveCount(0);
  await expect(heading).not.toHaveClass(/sr-only/);

  for (const id of all) {
    await expect(requestRow(page, id)).toBeVisible();
  }

  await page.reload();
  await expect(field).toHaveCount(0);
  await expect(requestRow(page, root)).toBeVisible();

  // Headers and bodies not searched: the notice says why and offers Retry,
  // and the rows the list fields match stay under it (Figma frame A4.3). The
  // route is answered here as a backend without it answers, during a rollout.
  await page.route(`**${searchPath}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"errorCode":1000,"message":"Not found"}',
    }),
  );
  await page.getByRole('button', { name: 'Filter requests' }).click();
  await field.fill('stripe');

  const notice = page.getByTestId('search-notice');

  await expect(notice).toContainText('Headers and bodies not searched: the search failed.');
  await expect(requestRow(page, stripeOne)).toBeVisible();
  await expect(requestRow(page, stripeTwo)).toBeVisible();
  await expect(page.getByTestId('filter-count')).toHaveText('2 of 5 / 1000');

  // With no list-field match the reason and Retry are in the empty result
  // (Figma frame A4.6).
  await field.fill(BODY_TOKEN);
  await expect(page.getByText(`No requests match “${BODY_TOKEN}”`)).toBeVisible();
  await expect(page.getByText('Headers and bodies not searched: the search failed.')).toBeVisible();
  await expect(notice).toHaveCount(0);

  // Retry, with the server answering again, finds the body.
  await page.unroute(`**${searchPath}`);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(requestRow(page, withToken)).toBeVisible();
  await expect(requestRow(page, late)).toBeVisible();
  await expect(page.getByText('Headers and bodies not searched')).toHaveCount(0);

  // More than 8 searchable words: not sent, said without Retry. Nine pieces
  // of one path, so the two rows holding it stay under the notice.
  const sentBefore = searchedWords().length;

  await field.fill('stripe strip tripe ripe /stripe stripe/ events event vents');
  await expect(notice).toContainText('Headers and bodies not searched: more than 8 words.');
  await expect(requestRow(page, stripeOne)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  expect(searchedWords().length).toBe(sentBefore);

  // The phone's placeholder, and nothing scrolls sideways at 320 px: with the
  // field open, under the notice, and with a query wider than the field.
  const fits = (): Promise<boolean> =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(field).toHaveAttribute('placeholder', 'Search, bodies too');
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await fits()).toBe(true);
  await field.fill('a long filter text that is wider than the field');
  expect(await fits()).toBe(true);
  await field.fill(`POST ${'a'.repeat(201)}`);
  await expect(page.getByText('a word is over 200 bytes.')).toBeVisible();
  expect(await fits()).toBe(true);
});
