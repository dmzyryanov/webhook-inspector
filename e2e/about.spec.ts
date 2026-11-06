import { expect, test, type Page } from '@playwright/test';
import { ru } from '../apps/frontend/src/i18n/ru.ts';
import { ABOUT_RU } from '../apps/frontend/src/lib/about-copy-ru.ts';
import {
  ABOUT_FACTS,
  ABOUT_HEADING,
  ABOUT_STORY,
  ABOUT_TITLE,
  aboutParagraphText,
} from '../apps/frontend/src/lib/about-copy.ts';
import {
  FOOTER_SEPARATOR,
  PRIVACY_FOOTER,
  PRIVACY_FOOTER_TEXT,
} from '../apps/frontend/src/lib/privacy-footer.ts';
import { expectHeaderLayout, laidOutLines, watchOrigins } from './helpers.ts';

/**
 * E2E-15 — the about page at /about (issue #131, D211).
 *
 * The page is static HTML the build writes from `about-copy.ts`, with no
 * script; what only a browser can show: that it is served at both addresses
 * and is never the application; that with JavaScript off it reads in full;
 * that its header is every page's, with no current page, and its footer
 * marks `About` as the current page; that at 1440, 768, 375 and 320 px
 * nothing scrolls sideways and no line of the title, the story or the facts
 * holds a single word; that it reaches no origin but its own; and that the
 * application's footer leads to it in the same tab.
 *
 * The dev server stands in for nginx here (D108): `apps/frontend/vite.config.ts`
 * serves `/about` and `/about/` as `nginx.conf` does, and
 * `apps/frontend/src/lib/about-page.test.ts` reads `nginx.conf` itself.
 *
 * Its Russian twin, `/ru/about` (issue #170, D255), is checked the same way,
 * its header and band in Russian and its Cyrillic drawn in Inter, and at five
 * more widths against the Russian rules of where a line may end (issue
 * #258); and the Russian interface's `О сервисе` leads to it.
 */

const EM_DASH = '—';

/** A word of one letter, which no line of the Russian page may end with (issue #258). */
const ONE_LETTER = /^\p{L}$/u;

/**
 * The Inter faces the page has loaded for Cyrillic: `@fontsource/inter`
 * gives each weight a face of its own per subset, the Cyrillic one by its
 * `unicode-range`, and a browser loads a face only when the page draws a
 * character of its range.
 */
async function cyrillicInterLoaded(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    await document.fonts.ready;

    return Array.from(document.fonts)
      .filter(
        (face) =>
          face.family.replaceAll('"', '') === 'Inter' &&
          /U\+0?400-0?45F/i.test(face.unicodeRange) &&
          face.status === 'loaded',
      )
      .map((face) => face.weight)
      .sort();
  });
}

test('the about page says who runs QA Tools, reads without a script and fits every width', async ({
  page,
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL as string).origin;
  const foreign = watchOrigins(page, origin);

  for (const address of ['/about', '/about/']) {
    const answer = await page.request.get(address);

    expect(answer.status()).toBe(200);
    expect(answer.headers()['content-type']).toMatch(/^text\/html/);
    expect(answer.headers()['cache-control']).toBe('no-cache');
    expect(answer.headers()['x-robots-tag']).toBeUndefined();

    const html = await answer.text();

    // The page itself, not the application shell, and offered to search engines.
    expect(html).toContain(`<title>${ABOUT_TITLE}</title>`);
    expect(html).not.toMatch(/noindex/i);
  }

  await page.goto('/about');
  await expect(page).toHaveTitle(ABOUT_TITLE);

  // The texts as `textContent`, which keeps their no-break spaces.
  const main = page.getByRole('main');

  expect(await main.locator('h1').evaluate((element) => element.textContent)).toBe(ABOUT_HEADING);
  expect(
    await main.locator('.story p').evaluateAll((all) => all.map((p) => p.textContent)),
  ).toEqual(ABOUT_STORY.map(aboutParagraphText));
  expect(
    await main
      .locator('.fact dd')
      .evaluateAll((all) =>
        all.map((dd) => Array.from(dd.querySelectorAll('p'), (p) => p.textContent)),
      ),
  ).toEqual(ABOUT_FACTS.map((fact) => fact.lines));
  await expect(main.locator('dt')).toHaveText(ABOUT_FACTS.map((fact) => fact.label));
  // The MCP address is shown, not linked; the contact address is mail.
  await expect(main.getByRole('link')).toHaveCount(1);
  await expect(
    main.getByRole('link', { name: 'contact@qa-tools.ru', exact: true }),
  ).toHaveAttribute('href', 'mailto:contact@qa-tools.ru');

  // The header is every page's, none of its links the current page; the
  // footer is every page's, About its current page.
  const banner = page.getByRole('banner');

  await expect(banner.locator('[aria-current]')).toHaveCount(0);
  await expect(banner.getByRole('link', { name: 'Changelog', exact: true })).toHaveAttribute(
    'href',
    '/changelog',
  );

  const footer = page.getByRole('contentinfo');
  const about = footer.getByRole('link', { name: 'About', exact: true });

  expect(await footer.evaluate((element) => element.textContent?.trim())).toBe(PRIVACY_FOOTER_TEXT);
  await expect(about).toHaveAttribute('href', '/about');
  await expect(about).toHaveAttribute('aria-current', 'page');

  // No sideways scroll and no line of a single word, at the approved frames'
  // widths and at 320 px; the header keeps its three links (D209).
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectHeaderLayout(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      `${width} px`,
    ).toBe(true);

    const lines = await laidOutLines(page, 'h1, .story p, .fact dt, .fact dd p');

    expect(lines.length, `${width} px`).toBeGreaterThanOrEqual(17);
    expect(
      lines.filter((words) => words.length < 2).map((words) => words.join(' ')),
      `${width} px: lines of a single word`,
    ).toEqual([]);
  }

  expect(foreign, 'the about page reached another origin').toEqual([]);

  // Without JavaScript the page is the same: it has no script of its own
  // (about-page.test.ts reads the template; the dev server adds its client).
  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();

  try {
    await plain.goto(`${origin}/about`);
    await expect(plain.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await plain.locator('h1').evaluate((element) => element.textContent)).toBe(
      ABOUT_HEADING,
    );
    await expect(plain.locator('.fact')).toHaveCount(ABOUT_FACTS.length);
  } finally {
    await context.close();
  }
});

test('the footer of the application leads to the about page in the same tab', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('contentinfo').getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page).toHaveTitle(ABOUT_TITLE);
});

test('the about page in Russian says the same in Russian, reads without a script and fits every width', async ({
  page,
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL as string).origin;
  const foreign = watchOrigins(page, origin);

  for (const address of ['/ru/about', '/ru/about/', '/ru/about?x=1']) {
    const answer = await page.request.get(address, { maxRedirects: 0 });

    expect(answer.status(), address).toBe(200);
    expect(answer.headers()['content-type']).toMatch(/^text\/html/);
    expect(answer.headers()['cache-control']).toBe('no-cache');
    expect(answer.headers()['x-robots-tag']).toBeUndefined();

    const html = await answer.text();

    expect(html).toContain('<html lang="ru">');
    expect(html).toContain(`<title>${ABOUT_RU.title}</title>`);
    expect(html).not.toMatch(/noindex/i);
  }

  // /about stays English whatever the browser asks for: no negotiation, no redirect.
  const english = await page.request.get('/about', {
    headers: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
    maxRedirects: 0,
  });

  expect(english.status()).toBe(200);
  expect(await english.text()).toContain(`<title>${ABOUT_TITLE}</title>`);

  await page.goto('/ru/about');
  await expect(page).toHaveTitle(ABOUT_RU.title);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ru');

  const main = page.getByRole('main');

  expect(await main.locator('h1').evaluate((element) => element.textContent)).toBe(
    ABOUT_RU.heading,
  );
  expect(
    await main.locator('.story p').evaluateAll((all) => all.map((p) => p.textContent)),
  ).toEqual(ABOUT_RU.story.map(aboutParagraphText));
  expect(
    await main
      .locator('.fact dd')
      .evaluateAll((all) =>
        all.map((dd) => Array.from(dd.querySelectorAll('p'), (p) => p.textContent)),
      ),
  ).toEqual(ABOUT_RU.facts.map((fact) => fact.lines));
  await expect(main.locator('dt')).toHaveText(ABOUT_RU.facts.map((fact) => fact.label));
  await expect(main.getByRole('link')).toHaveCount(1);
  await expect(
    main.getByRole('link', { name: 'contact@qa-tools.ru', exact: true }),
  ).toHaveAttribute('href', 'mailto:contact@qa-tools.ru');

  // The header in Russian, Webhook Inspector leading to the Russian home page, no
  // current page; the band in Russian, О сервисе its current page.
  const banner = page.getByRole('banner');

  await expect(banner.locator('[aria-current]')).toHaveCount(0);
  await expect(
    banner.getByRole('link', { name: 'Webhook Inspector', exact: true }),
  ).toHaveAttribute('href', '/ru/');
  await expect(
    banner.getByRole('link', { name: ru.header.changelog, exact: true }),
  ).toHaveAttribute('href', '/changelog');

  const footer = page.getByRole('contentinfo');
  const about = footer.getByRole('link', { name: ru.footer.about, exact: true });

  expect(await footer.evaluate((element) => element.textContent?.trim())).toBe(
    `${ru.footer.line} ${ru.footer.about}${FOOTER_SEPARATOR}${ru.footer.terms}${FOOTER_SEPARATOR}${ru.footer.privacy}${FOOTER_SEPARATOR}${ru.footer.contact}\u00a0${PRIVACY_FOOTER.address}`,
  );
  await expect(about).toHaveAttribute('href', '/ru/about');
  await expect(about).toHaveAttribute('aria-current', 'page');
  await expect(footer.getByRole('link', { name: ru.footer.terms, exact: true })).toHaveAttribute(
    'href',
    '/terms',
  );
  await expect(footer.getByRole('link', { name: ru.footer.privacy, exact: true })).toHaveAttribute(
    'href',
    '/privacy',
  );

  // The Cyrillic is drawn in Inter, at each weight the page uses.
  expect(await cyrillicInterLoaded(page)).toEqual(['400', '500', '600']);

  // The Russian rules of where a line may end (issue #258), at the four
  // widths above and at five where 1.15.5's joints broke one of them: no line
  // starts with a dash or ends with a one-letter word or `QA`, and no line
  // holds a single word but the heading's second on a phone — the dash ends
  // its first line, `От тестировщика —` over `тестировщикам` (option B of
  // issue #258). `laidOutLines` splits words at no-break spaces too, so a
  // joined run's words are counted one by one.
  for (const width of [1440, 768, 540, 510, 420, 384, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectHeaderLayout(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      `${width} px`,
    ).toBe(true);

    const heading = await laidOutLines(page, 'h1');
    const body = await laidOutLines(page, '.story p, .fact dt, .fact dd p');
    const lines = [...heading, ...body];
    const shown = (some: string[][]) => some.map((words) => words.join(' '));

    expect(lines.length, `${width} px`).toBeGreaterThanOrEqual(17);
    expect(
      shown(lines.filter((words) => words[0] === EM_DASH)),
      `${width} px: lines starting with a dash`,
    ).toEqual([]);
    expect(
      shown(lines.filter((words) => ONE_LETTER.test(words.at(-1) ?? '') || words.at(-1) === 'QA')),
      `${width} px: lines ending with a one-letter word or QA`,
    ).toEqual([]);
    expect(shown(heading), `${width} px: the heading`).toEqual(
      width < 500 ? ['От тестировщика —', 'тестировщикам'] : ['От тестировщика — тестировщикам'],
    );
    expect(
      shown(body.filter((words) => words.length < 2)),
      `${width} px: lines of a single word`,
    ).toEqual([]);

    // The band keeps each link with its dot, and the contact, whole on one
    // line at every width, and at 1440 px it is one 34 px line, as /about's
    // is (D217 item 10): the Russian words fit from about 1,425 px.
    const band = await footer.evaluate((element) => ({
      height: Math.round(element.getBoundingClientRect().height),
      // Each item's height: one 17 px line, or two and more.
      items: Array.from(element.querySelectorAll('.footer-item, .contact'), (item) =>
        Math.round(item.getBoundingClientRect().height),
      ),
    }));

    expect(
      band.items.map((height) => height <= 25),
      `${width} px: ${band.items.join(', ')}`,
    ).toEqual([true, true, true, true]);

    if (width === 1440) {
      expect(band.height, `${width} px`).toBe(34);
    }
  }

  expect(foreign, 'the Russian about page reached another origin').toEqual([]);

  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();

  try {
    await plain.goto(`${origin}/ru/about`);
    await expect(plain.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await plain.locator('h1').evaluate((element) => element.textContent)).toBe(
      ABOUT_RU.heading,
    );
    await expect(plain.locator('.fact')).toHaveCount(ABOUT_RU.facts.length);
  } finally {
    await context.close();
  }
});

test('the Russian interface leads О сервисе to the Russian about page, the legal pages staying English', async ({
  page,
}) => {
  await page.goto('/ru/');

  const footer = page.getByRole('contentinfo');

  await expect(footer.getByRole('link', { name: ru.footer.terms, exact: true })).toHaveAttribute(
    'href',
    '/terms',
  );
  await expect(footer.getByRole('link', { name: ru.footer.privacy, exact: true })).toHaveAttribute(
    'href',
    '/privacy',
  );
  await footer.getByRole('link', { name: ru.footer.about, exact: true }).click();
  await expect(page).toHaveURL(/\/ru\/about$/);
  await expect(page).toHaveTitle(ABOUT_RU.title);

  // And back to English: the switch on the home page, then About to /about.
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'EN English', exact: true }).click();
  await page.getByRole('contentinfo').getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page).toHaveTitle(ABOUT_TITLE);
});
