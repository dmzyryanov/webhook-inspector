import { expect, test, type Page } from '@playwright/test';
import { en } from '../apps/frontend/src/i18n/en.ts';
import { ru } from '../apps/frontend/src/i18n/ru.ts';
import { expectHeaderLayout } from './helpers.ts';

/**
 * E2E-18 — the Russian home page at /ru/ (issue #109, D226).
 *
 * `/ru/` is the application under a Russian head: always Russian, and opening
 * it stores Russian as the choice, so `Создать адрес` there and every page
 * after it are Russian; `/` follows #108's rule, the stored choice, else the
 * browser's languages, with no redirect. On the two home pages the `EN | RU`
 * switch also leads to the paired address, and in Russian the ways home -
 * the wordmark, `На главную` on the not-found screens - lead to `/ru/`.
 *
 * The rules are unit-tested (`not-found.test.ts`, `i18n.test.ts`), and the
 * head, the `<noscript>` and nginx's locations without a browser
 * (`search-engines.test.ts`). The dev server stands in for nginx here
 * (D108): `apps/frontend/vite.config.ts` serves `/ru` and `/ru/` as
 * `nginx.conf` does. It still answers every other address `200` (D146), so
 * the statuses of the addresses around `/ru/` are checked with curl on the
 * built image, not here.
 *
 * The suite's contexts are `en-US` (`playwright.config.ts`); the tests that
 * need a Russian browser open one of their own.
 */

const LANGUAGE_KEY = 'qa-tools:language';
const STORED_RU = '{"v":1,"lang":"ru"}';
const STORED_EN = '{"v":1,"lang":"en"}';

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const pathname = (page: Page) => new URL(page.url()).pathname;
const stored = (page: Page) =>
  page.evaluate((key) => window.localStorage.getItem(key), LANGUAGE_KEY);
const switchButton = (page: Page, group: string, name: 'EN English' | 'RU Русский') =>
  page.getByRole('group', { name: group, exact: true }).getByRole('button', { name });
const wordmark = (page: Page) =>
  page.getByRole('banner').getByRole('link', { name: 'Webhook Inspector', exact: true });

/** The page reads in Russian: its heading, `<html lang>` and the tab's title. */
async function expectRussianHome(page: Page): Promise<void> {
  await expect(heading(page)).toHaveText(ru.landing.heading);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page).toHaveTitle(ru.title.home);
}

async function expectEnglishHome(page: Page): Promise<void> {
  await expect(heading(page)).toHaveText(en.landing.heading);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle(en.title.home);
}

test('E2E-18 — /ru/ and /ru answer the Russian page of their own, uncached and indexable', async ({
  request,
}) => {
  for (const address of ['/ru/', '/ru']) {
    const answer = await request.get(address);

    expect(answer.status(), address).toBe(200);
    expect(answer.headers()['content-type']).toMatch(/^text\/html/);
    expect(answer.headers()['cache-control']).toBe('no-cache');
    expect(answer.headers()['x-robots-tag']).toBeUndefined();

    const html = await answer.text();

    expect(html).toMatch(/<html lang="ru">/);
    expect(html.match(/<title>[^<]*<\/title>/g)).toEqual([`<title>${ru.title.home}</title>`]);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('<link rel="canonical" href="https://qa-tools.ru/ru/" />');
    expect(html).not.toMatch(/noindex/i);
  }
});

test('E2E-18 — /ru/ opens in Russian in an English browser with nothing stored, from the first render, and remembers it', async ({
  page,
  context,
}) => {
  const errors: string[] = [];

  page.on('pageerror', (error) => errors.push(error.message));
  // Every text the application root holds as it is built, with the page's
  // language each time: nothing English may be drawn before Russian.
  await page.addInitScript(() => {
    const seen: string[] = [];

    (window as unknown as { __seen: string[] }).__seen = seen;
    new MutationObserver(() => {
      const root = document.getElementById('root');

      if (root !== null && root.textContent !== '') {
        seen.push(`${document.documentElement.lang}|${root.textContent}`);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });

  await page.goto('/ru/');
  await expectRussianHome(page);
  expect(await stored(page)).toBe(STORED_RU);

  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);

  expect(seen.length).toBeGreaterThan(0);

  for (const snapshot of seen) {
    expect(snapshot.startsWith('ru|'), snapshot.slice(0, 60)).toBe(true);
    expect(snapshot).not.toContain(en.landing.heading);
    expect(snapshot).not.toContain(en.landing.generate);
  }

  // RU is the one pressed, in the header at this width.
  await expect(switchButton(page, ru.language.label, 'RU Русский')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // The choice is remembered: / is Russian now, in this tab and a new one,
  // and stays at its address.
  await page.goto('/');
  await expectRussianHome(page);
  expect(pathname(page)).toBe('/');

  const second = await context.newPage();

  await second.goto('/');
  await expect(heading(second)).toHaveText(ru.landing.heading);
  await second.close();

  // /ru without its slash is the same page.
  await page.goto('/ru');
  await expectRussianHome(page);
  expect(errors).toEqual([]);
});

test('E2E-18 — / stays English for an English browser with no choice, and is Russian for a Russian one, with no redirect', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await expectEnglishHome(page);
  expect(pathname(page)).toBe('/');
  expect(await stored(page)).toBeNull();

  const russianBrowser = await browser.newContext({ locale: 'ru-RU' });
  const russian = await russianBrowser.newPage();

  try {
    await russian.goto('/');
    await expectRussianHome(russian);
    expect(pathname(russian)).toBe('/');
    // / decides by the browser, and stores nothing until a choice is made.
    expect(await stored(russian)).toBeNull();
  } finally {
    await russianBrowser.close();
  }
});

test('E2E-18 — from /ru/, Создать адрес opens a Russian session page, whose wordmark leads back to /ru/ in Russian', async ({
  page,
  request,
}) => {
  await page.goto('/ru/');
  await expectRussianHome(page);
  await page.getByRole('button', { name: ru.landing.generate }).click();
  await expect(page).toHaveURL(/\/v\/[A-Za-z0-9]{43}$/);

  const sessionId = pathname(page).slice('/v/'.length);

  try {
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(
      page.getByRole('banner').getByRole('link', { name: ru.header.changelog, exact: true }),
    ).toBeVisible();
    await expect(wordmark(page)).toHaveAttribute('href', '/ru/');

    await wordmark(page).click();
    await expect.poll(() => pathname(page)).toBe('/ru/');
    await expectRussianHome(page);
    expect(await stored(page)).toBe(STORED_RU);
  } finally {
    // The session this test created, deleted as the page's own Delete would.
    expect((await request.delete(`/api/sessions/${sessionId}`)).status()).toBe(204);
  }
});

test('E2E-18 — on /ru/ EN leads to / in English and remembers it, on / RU leads to /ru/, and Back to /ru/ is Russian again', async ({
  page,
}) => {
  await page.goto('/ru/');
  await expectRussianHome(page);
  // No reload on the way: a marker set now survives every step below.
  await page.evaluate(() => {
    (window as unknown as { __kept: boolean }).__kept = true;
  });

  await switchButton(page, ru.language.label, 'EN English').click();
  await expect.poll(() => pathname(page)).toBe('/');
  await expectEnglishHome(page);
  expect(await stored(page)).toBe(STORED_EN);

  await switchButton(page, en.language.label, 'RU Русский').click();
  await expect.poll(() => pathname(page)).toBe('/ru/');
  await expectRussianHome(page);
  expect(await stored(page)).toBe(STORED_RU);

  await switchButton(page, ru.language.label, 'EN English').click();
  await expect.poll(() => pathname(page)).toBe('/');
  await expectEnglishHome(page);

  // The browser's Back returns to /ru/, which is always Russian and stores it.
  await page.goBack();
  await expect.poll(() => pathname(page)).toBe('/ru/');
  await expectRussianHome(page);
  expect(await stored(page)).toBe(STORED_RU);

  // EN on / itself changes the language in place, at the same address.
  await page.goto('/');
  await expectRussianHome(page);
  await switchButton(page, ru.language.label, 'EN English').click();
  await expectEnglishHome(page);
  expect(pathname(page)).toBe('/');
  expect(await stored(page)).toBe(STORED_EN);
});

test('E2E-18 — with English or anything else stored, /ru/ shows Russian and stores it, and / follows the stored choice or the browser', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];

  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');

  for (const [value, home] of [
    [STORED_EN, 'en'],
    [STORED_RU, 'ru'],
    ['ru', 'en'],
    ['en', 'en'],
    ['RU', 'en'],
    ['"ru"', 'en'],
    ['de', 'en'],
    ['{"v":1,"lang":"de"}', 'en'],
    ['', 'en'],
    ['e'.repeat(1024 * 1024), 'en'],
  ] as const) {
    const label = `stored ${value.slice(0, 24)}`;

    await page.evaluate(({ key, raw }) => window.localStorage.setItem(key, raw), {
      key: LANGUAGE_KEY,
      raw: value,
    });
    await page.goto('/');
    await expect(heading(page), label).toHaveText(
      home === 'ru' ? ru.landing.heading : en.landing.heading,
    );

    await page.evaluate(({ key, raw }) => window.localStorage.setItem(key, raw), {
      key: LANGUAGE_KEY,
      raw: value,
    });
    await page.goto('/ru/');
    await expect(heading(page), label).toHaveText(ru.landing.heading);
    await expect(page.locator('html'), label).toHaveAttribute('lang', 'ru');
    expect(await stored(page), label).toBe(STORED_RU);
  }

  expect(errors).toEqual([]);

  // Storage that throws on every read and write: /ru/ is Russian and / is the
  // browser's, with no page error.
  const blocked = await browser.newContext({ locale: 'en-US' });
  const blockedPage = await blocked.newPage();
  const blockedErrors: string[] = [];

  blockedPage.on('pageerror', (error) => blockedErrors.push(error.message));
  await blockedPage.addInitScript(() => {
    const refuse = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };

    Storage.prototype.getItem = refuse;
    Storage.prototype.setItem = refuse;
  });

  try {
    await blockedPage.goto('/ru/');
    await expect(heading(blockedPage)).toHaveText(ru.landing.heading);
    await blockedPage.goto('/');
    await expect(heading(blockedPage)).toHaveText(en.landing.heading);
    expect(blockedErrors).toEqual([]);
  } finally {
    await blocked.close();
  }
});

test('E2E-18 — in Russian the not-found screens lead home to /ru/, in English to /, and the addresses beside /ru/ are not found', async ({
  page,
}) => {
  // English, nothing stored: home is /.
  await page.goto('/nowhere');
  await expect(heading(page)).toHaveText(en.notFound.pageTitle);
  await expect(page.getByRole('link', { name: en.notFound.goHome })).toHaveAttribute('href', '/');
  await expect(wordmark(page)).toHaveAttribute('href', '/');

  // Beside /ru/: the application's Page not found, never the landing page.
  for (const address of ['/RU/', '/Ru/', '/ru/x', '/ru/ru/', '/rus']) {
    await page.goto(address);
    await expect(heading(page), address).toHaveText(en.notFound.pageTitle);
  }

  // Russian chosen on /ru/: every way home leads back there.
  await page.goto('/ru/');
  await expectRussianHome(page);
  await page.goto('/nowhere');
  await expect(heading(page)).toHaveText(ru.notFound.pageTitle);

  const goHome = page.getByRole('link', { name: ru.notFound.goHome });

  await expect(goHome).toHaveAttribute('href', '/ru/');
  await expect(wordmark(page)).toHaveAttribute('href', '/ru/');
  await goHome.click();
  await expect.poll(() => pathname(page)).toBe('/ru/');
  await expectRussianHome(page);

  // A session-shaped address the API does not know: Session not found.
  await page.goto(`/v/${'A'.repeat(43)}`);
  await expect(heading(page)).toHaveText(ru.notFound.sessionTitle);
  await expect(page.getByRole('link', { name: ru.notFound.goHome })).toHaveAttribute(
    'href',
    '/ru/',
  );
});

test('E2E-18 — the header names Webhook Inspector on both home pages and Page not found, in either language, at every width', async ({
  page,
}) => {
  // The service's name (issue #322, D277): one line from 768 px, two below,
  // the Q mark below 375 px, the link named the same at every width and
  // leading to the home page of the language shown.
  for (const [address, home] of [
    ['/', '/'],
    ['/nowhere', '/'],
    ['/ru/', '/ru/'],
    ['/nowhere', '/ru/'],
  ] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(address);
    await expect(page.locator('html')).toHaveAttribute('lang', home === '/' ? 'en' : 'ru');

    for (const width of [1440, 768, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expectHeaderLayout(page);
      await expect(wordmark(page), `${address} at ${width} px`).toHaveAttribute('href', home);
    }
  }
});

test('E2E-18 — the switch in the phone footer leads between the home pages too', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/ru/');
  await expectRussianHome(page);

  const footer = page.getByRole('contentinfo');

  await expect(page.getByRole('banner').getByTestId('language-switch')).toHaveCount(0);
  await footer.getByRole('button', { name: 'EN English' }).click();
  await expect.poll(() => pathname(page)).toBe('/');
  await expectEnglishHome(page);
  await footer.getByRole('button', { name: 'RU Русский' }).click();
  await expect.poll(() => pathname(page)).toBe('/ru/');
  await expectRussianHome(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test('E2E-18 — without a script, /ru/ reads the Russian landing page and / the English one', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto('/ru/');
    await expect(heading(page)).toHaveText(ru.landing.heading);
    await expect(page.getByText(ru.landing.lead, { exact: true })).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveText(
      ru.landing.steps.map((step) => `${step.title} — ${step.description}`),
    );
    await expect(page.getByRole('link', { name: '/llms.txt', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

    await page.goto('/');
    await expect(heading(page)).toHaveText(en.landing.heading);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  } finally {
    await context.close();
  }
});
