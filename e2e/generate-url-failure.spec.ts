import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { createSessionViaApi, receiveUrlOf } from './helpers.ts';

/**
 * E2E-14 — `Generate URL` that creates nothing (issue #128; Figma page
 * `Webhook Inspector · Session could not be created (#128) — approved`,
 * frames A1-A3 and B1-B3).
 *
 * The texts and which failure gets which are unit-tested
 * (`create-session-failure.test.ts`, `retry-after.test.ts`); here
 * `POST /api/sessions` is answered by `page.route`, never by the backend's
 * limit, and the page a visitor sees is checked: the line under the tile on
 * the first visit and for a returning visitor, its words byte for byte, the
 * address staying `/`, the tile clickable with focus on it, the line gone
 * while the next creation is pending, a creation that then succeeds, no
 * unhandled rejection, and the line's place, gap, size and colour at 1440,
 * 768 and 375 px, with nothing scrolling sideways at 320 px and the second
 * sentence never split.
 *
 * Since #216 (D249) a phone's tile carries the new session's options as a
 * line 8 px under it, which the approved frames count as the tile's own 26 px:
 * below 768 px the line is measured 12 px under that options line, and from
 * 768 px, where the options sit inside the tile, under the tile as before.
 */

const STORAGE_KEY = 'qa-tools:sessions';
const NBSP = '\u00a0';
const GENERAL = `This session could not be created. Please${NBSP}try${NBSP}again.`;
const LIMIT_40 = `Too many sessions created from your address. Try${NBSP}again${NBSP}in${NBSP}40${NBSP}s.`;

/** The danger colour, `--color-danger` (`#b82e2e`). */
const DANGER = 'rgb(184, 46, 46)';

const tile = (page: Page) => page.getByRole('button', { name: /^Generate URL/ });
const options = (page: Page) => page.getByRole('button', { name: /^New session options/ });
/** Below 768 px, the new session's options as a line under the tile, opening a sheet (#216). */
const phoneOptions = (page: Page) => options(page).and(page.locator('[aria-haspopup="dialog"]'));
/** From 768 px, the new session's options inside the tile, opening a menu (#216). */
const tileOptions = (page: Page) => options(page).and(page.locator('[aria-haspopup="menu"]'));
const failureLine = (page: Page) => page.getByRole('alert');
const firstVisit = (page: Page) => page.getByRole('heading', { name: 'How it works' });

/** Puts `ids` in the list before the page's own scripts run. */
async function seedList(page: Page, ids: string[]): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem('seeded') === null) {
        window.localStorage.setItem(key, value);
        window.sessionStorage.setItem('seeded', '1');
      }
    },
    {
      key: STORAGE_KEY,
      value: JSON.stringify({
        v: 1,
        items: ids.map((id, index) => ({ id, openedAt: Date.now() - index * 1000 })),
      }),
    },
  );
}

type Answer = (route: Route) => Promise<void>;

/**
 * Answers every `POST /api/sessions` with what `answer` holds when it
 * arrives, and counts them; the status read, `POST /api/sessions/status`,
 * goes through untouched.
 */
async function interceptCreation(page: Page): Promise<{
  answerWith: (next: Answer) => void;
  count: () => number;
}> {
  let answer: Answer = (route) => route.continue();
  let count = 0;

  await page.route(
    (url) => url.pathname === '/api/sessions',
    async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();

        return;
      }

      count += 1;
      await answer(route);
    },
  );

  return {
    answerWith: (next) => {
      answer = next;
    },
    count: () => count,
  };
}

/** A refusal as the API gives it: JSON, with `Retry-After` when there is one. */
function refusal(status: number, errorCode: number, retryAfter?: string): Answer {
  return (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
      body: JSON.stringify({ errorCode, message: 'Refused' }),
    });
}

/** An answer held until `release` is called, then given by `then`. */
function held(then: Answer): { answer: Answer; release: () => void } {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    answer: async (route) => {
      await released;
      await then(route);
    },
    release,
  };
}

/** Errors a visitor's console would show as uncaught, a rejection left unhandled included. */
function watchUncaught(page: Page): string[] {
  const uncaught: string[] = [];

  page.on('pageerror', (error) => uncaught.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /uncaught|unhandled/i.test(message.text())) {
      uncaught.push(message.text());
    }
  });

  return uncaught;
}

/** The line's exact text; Playwright's text matchers would fold a no-break space. */
async function exactText(line: Locator): Promise<string | null> {
  await expect(line).toBeVisible();

  return line.textContent();
}

/**
 * The line as the frames draw it: 12 px under the tile - below 768 px under
 * the tile's options line (#216) - as wide as the tile and aligned with it,
 * Inter 13 px on a 19.5 px line in the danger colour, left-aligned; `next`
 * follows `gap` px below it.
 */
async function expectDrawnUnderTile(page: Page, next: Locator, gap: number, where: string) {
  const line = failureLine(page);
  const phone = (page.viewportSize()?.width ?? 0) < 768;

  // Which options the tile carries follows the width through a media-query
  // listener, a render after `setViewportSize` returns: until that render the
  // other layout's trigger is still drawn, so it is waited for before measuring.
  await expect(phone ? phoneOptions(page) : tileOptions(page), where).toBeVisible();
  await expect(phone ? tileOptions(page) : phoneOptions(page), where).toHaveCount(0);

  const [tileBox, lineBox, nextBox, optionsBox] = await Promise.all([
    tile(page).boundingBox(),
    line.boundingBox(),
    next.boundingBox(),
    phone ? phoneOptions(page).boundingBox() : Promise.resolve(null),
  ]);

  if (tileBox === null || lineBox === null || nextBox === null) {
    throw new Error(`${where}: the tile, the line or what follows it is not drawn`);
  }

  if (phone && optionsBox === null) {
    throw new Error(`${where}: the options line under the tile is not drawn`);
  }

  const above = optionsBox === null ? tileBox.y + tileBox.height : optionsBox.y + optionsBox.height;

  if (optionsBox !== null) {
    expect(Math.abs(optionsBox.y - (tileBox.y + tileBox.height) - 8), where).toBeLessThanOrEqual(
      0.5,
    );
  }

  expect(Math.abs(lineBox.y - above - 12), where).toBeLessThanOrEqual(0.5);
  expect(Math.abs(lineBox.x - tileBox.x), where).toBeLessThanOrEqual(0.5);
  expect(Math.abs(lineBox.width - tileBox.width), where).toBeLessThanOrEqual(0.5);
  expect(Math.abs(nextBox.y - (lineBox.y + lineBox.height) - gap), where).toBeLessThanOrEqual(0.5);

  const style = await line.evaluate((element) => {
    const computed = getComputedStyle(element);

    return {
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      lineHeight: computed.lineHeight,
      color: computed.color,
      textAlign: computed.textAlign,
    };
  });

  expect(style.fontFamily, where).toMatch(/^"?Inter/);
  expect(style.fontSize, where).toBe('13px');
  expect(style.lineHeight, where).toBe('19.5px');
  expect(style.color, where).toBe(DANGER);
  expect(['start', 'left'], where).toContain(style.textAlign);
}

/**
 * How many lines the line's second sentence is drawn on: the client rects of
 * a range over it, one per line it occupies.
 */
function linesOfSecondSentence(line: Locator): Promise<number> {
  return line.evaluate((element) => {
    const text = element.firstChild;

    if (text === null || text.nodeType !== Node.TEXT_NODE) {
      throw new Error('the line is not one text node');
    }

    const range = document.createRange();

    range.setStart(text, (text.textContent ?? '').indexOf('. ') + 2);
    range.setEnd(text, (text.textContent ?? '').length);

    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
}

async function expectNothingSideways(page: Page, where: string): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    where,
  ).toBe(false);
}

test.describe('E2E-14 — Generate URL that creates nothing', () => {
  test('the first visit: a 503 and no answer say so under the tile, and the next click creates the session', async ({
    page,
  }) => {
    const uncaught = watchUncaught(page);
    const creation = await interceptCreation(page);

    await page.goto('/');
    await expect(firstVisit(page)).toBeVisible();
    await expect(failureLine(page)).toHaveCount(0);

    // A 503 from the proxy while the backend restarts: the general sentence,
    // the address stays `/`, and the tile is clickable with focus on it.
    creation.answerWith((route) =>
      route.fulfill({ status: 503, contentType: 'text/html', body: '<html>503</html>' }),
    );
    await tile(page).click();
    expect(await exactText(failureLine(page))).toBe(GENERAL);
    await expect(page).toHaveURL(/\/$/);
    await expect(tile(page)).toBeEnabled();
    await expect(tile(page)).toBeFocused();
    expect(creation.count()).toBe(1);

    // No answer at all: the line goes at once while the creation is pending,
    // the tile busy, and comes back with the same sentence.
    const noAnswer = held((route) => route.abort('connectionrefused'));

    creation.answerWith(noAnswer.answer);
    await tile(page).click();
    await expect(failureLine(page)).toHaveCount(0);
    await expect(tile(page)).toBeDisabled();
    noAnswer.release();
    expect(await exactText(failureLine(page))).toBe(GENERAL);
    await expect(page).toHaveURL(/\/$/);
    await expect(tile(page)).toBeEnabled();
    await expect(tile(page)).toBeFocused();
    expect(creation.count()).toBe(2);

    // The next click clears it while pending, and once the backend creates
    // the session the browser opens it and the list holds it, as before.
    const created = held((route) => route.continue());

    creation.answerWith(created.answer);
    await tile(page).click();
    await expect(failureLine(page)).toHaveCount(0);
    created.release();
    await expect(page).toHaveURL(/\/v\/[A-Za-z0-9]{43}$/);

    const id = new URL(page.url()).pathname.slice(3);

    await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByText('1 session in this browser')).toBeVisible();
    await expect(
      page.getByRole('link', { name: await receiveUrlOf(page.request, id) }),
    ).toBeVisible();
    await expect(failureLine(page)).toHaveCount(0);
    expect(creation.count()).toBe(3);
    expect(uncaught).toEqual([]);
  });

  test('a returning visitor: 429 / 1015 with Retry-After names the seconds between the tile and the days; other refusals do not', async ({
    page,
    request,
  }) => {
    const uncaught = watchUncaught(page);
    const id = await createSessionViaApi(request);

    await seedList(page, [id]);

    const creation = await interceptCreation(page);

    await page.goto('/');
    await expect(page.getByText('1 session in this browser')).toBeVisible();

    const days = page.locator('main section[aria-label]').first();

    creation.answerWith(refusal(429, 1015, '40'));
    await tile(page).click();
    expect(await exactText(failureLine(page))).toBe(LIMIT_40);
    await expectDrawnUnderTile(page, days, 12, 'B1, 1440 px');
    await expect(page).toHaveURL(/\/$/);
    await expect(tile(page)).toBeEnabled();
    await expect(tile(page)).toBeFocused();

    // Another 429 code, and 1015 without Retry-After, get the general sentence.
    for (const answer of [refusal(429, 1019, '1'), refusal(429, 1015)]) {
      creation.answerWith(answer);
      await tile(page).click();
      expect(await exactText(failureLine(page))).toBe(GENERAL);
      await expectDrawnUnderTile(page, days, 12, 'returning, 1440 px');
    }

    // With the session details failing, the line still comes first, before
    // `Session details could not be loaded.`
    await page.route('**/api/sessions/status', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );
    await page.reload();

    const detailsFailed = page.getByText('Session details could not be loaded.');

    await expect(detailsFailed).toBeVisible();
    creation.answerWith(refusal(429, 1015, '40'));
    await tile(page).click();
    expect(await exactText(failureLine(page))).toBe(LIMIT_40);
    await expectDrawnUnderTile(page, detailsFailed, 12, 'details failed, 1440 px');
    expect(uncaught).toEqual([]);
  });

  test('as drawn at 1440, 768 and 375 px, the second sentence whole, and nothing sideways at 320 px', async ({
    page,
    request,
  }) => {
    const creation = await interceptCreation(page);

    // The first visit, A1-A3: How it works follows 32 px below, 24 on a phone.
    creation.answerWith((route) => route.abort('connectionrefused'));
    await page.goto('/');
    await expect(firstVisit(page)).toBeVisible();
    await tile(page).click();
    expect(await exactText(failureLine(page))).toBe(GENERAL);

    const steps = page.locator('main section[aria-labelledby="how-it-works"]');

    const firstVisitGaps: [number, number][] = [
      [1440, 32],
      [768, 32],
      [375, 24],
      [320, 24],
    ];

    for (const [width, gap] of firstVisitGaps) {
      await page.setViewportSize({ width, height: 900 });
      await expectDrawnUnderTile(page, steps, gap, `first visit, ${width} px`);
      expect(await linesOfSecondSentence(failureLine(page)), `${width} px`).toBe(1);
      await expectNothingSideways(page, `first visit, ${width} px`);
    }

    // A returning visitor, B1-B3: the days follow 12 px below; on a phone the
    // second sentence moves to a line of its own, whole.
    const id = await createSessionViaApi(request);

    await seedList(page, [id]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByText('1 session in this browser')).toBeVisible();
    creation.answerWith(refusal(429, 1015, '40'));
    await tile(page).click();
    expect(await exactText(failureLine(page))).toBe(LIMIT_40);

    const days = page.locator('main section[aria-label]').first();

    for (const width of [1440, 768, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expectDrawnUnderTile(page, days, 12, `returning, ${width} px`);
      expect(await linesOfSecondSentence(failureLine(page)), `${width} px`).toBe(1);
      await expectNothingSideways(page, `returning, ${width} px`);
    }

    await page.setViewportSize({ width: 375, height: 900 });

    const lineBox = await failureLine(page).boundingBox();

    // B3: two lines, the second holding `Try again in 40 s.` alone.
    expect(Math.round(lineBox?.height ?? 0)).toBe(39);
  });
});
