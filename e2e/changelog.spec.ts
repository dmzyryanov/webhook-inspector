import { expect, test, type Page, type Request } from '@playwright/test';
import { expectHeaderLayout } from './helpers.ts';

/**
 * E2E-10 — the changelog at /changelog (issue #97, D184).
 *
 * The page is static HTML the build writes from `CHANGELOG.md`; what only a
 * browser can show: that it is served at both addresses and is never the
 * application; that it lists every version of `/changelog.md`, newest first,
 * the newest open; that `Breaking only` and `Expand all` do what they say;
 * that the two Atom feeds are served beside it, carry the versions the text
 * does, and are named in its head and in its subscribe line (D212);
 * that with JavaScript off every line still opens and the toolbar is gone;
 * that its header marks `Changelog` as the current page and carries
 * `Status ↗` and `API docs ↗` beside it, the Q mark in place of the wordmark
 * below 375 px (D209); that nothing scrolls sideways at 320 px; and, on the
 * network log of the whole browser context, that the page reaches no origin
 * but its own.
 *
 * The dev server stands in for nginx here (D108): `apps/frontend/vite.config.ts`
 * serves `/changelog`, `/changelog/`, `/changelog.md`, `/changelog.xml` and
 * `/changelog-breaking.xml` as `nginx.conf` does,
 * and `apps/frontend/src/lib/changelog.test.ts` reads `nginx.conf` itself.
 */

/** Every request of the context that leaves the page's origin, refused before it leaves. */
function watchOrigins(page: Page, origin: string): string[] {
  const foreign: string[] = [];
  const elsewhere = (url: string) => {
    const parsed = new URL(url);

    return !['data:', 'blob:'].includes(parsed.protocol) && parsed.origin !== origin;
  };

  void page.context().route(
    (url) => elsewhere(url.href),
    (route) => route.abort('blockedbyclient'),
  );
  page.context().on('request', (request: Request) => {
    if (elsewhere(request.url())) {
      foreign.push(`${request.method()} ${request.url()}`);
    }
  });

  return foreign;
}

/**
 * The versions `/changelog.md` lists, in its order, and those with a
 * Breaking, Deprecated or Notice paragraph, which `Breaking only` shows (D212,
 * D224).
 */
async function publishedVersions(page: Page) {
  const answer = await page.request.get('/changelog.md');

  expect(answer.status()).toBe(200);
  expect(answer.headers()['content-type']).toBe('text/markdown; charset=utf-8');
  expect(answer.headers()['cache-control']).toBe('no-cache');

  const text = await answer.text();
  const sections = text.split(/^## /m).slice(1);

  return {
    all: sections.map((section) => section.split('\n')[0] as string),
    breaking: sections
      .filter((section) => /^\*\*(?:Breaking|Deprecated|Notice):\*\*/m.test(section))
      .map((section) => section.split('\n')[0] as string),
  };
}

const versionLines = (page: Page) => page.locator('details.version:visible');

test('the changelog lists every version, filters the breaking ones and opens without a script', async ({
  page,
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL as string).origin;
  const foreign = watchOrigins(page, origin);
  const versions = await publishedVersions(page);

  expect(versions.all.length).toBeGreaterThan(50);
  expect(versions.breaking.length).toBeGreaterThan(0);

  for (const address of ['/changelog', '/changelog/']) {
    const answer = await page.request.get(address);

    expect(answer.status()).toBe(200);
    expect(answer.headers()['content-type']).toMatch(/^text\/html/);
    expect(answer.headers()['cache-control']).toBe('no-cache');
    expect(answer.headers()['x-robots-tag']).toBeUndefined();
    // The page itself, not the application shell.
    expect(await answer.text()).toContain('<title>Changelog — Webhook Inspector</title>');
  }

  // The two Atom feeds (D212): one entry per version the text lists, in its
  // order, and only the breaking or deprecating ones in the second.
  for (const [address, carried] of [
    ['/changelog.xml', versions.all],
    ['/changelog-breaking.xml', versions.breaking],
  ] as const) {
    const answer = await page.request.get(address);

    expect(answer.status()).toBe(200);
    expect(answer.headers()['content-type']).toBe('application/atom+xml; charset=utf-8');
    expect(answer.headers()['cache-control']).toBe('no-cache');

    const feed = await answer.text();

    expect(feed).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(
      [...feed.matchAll(/<id>tag:qa-tools\.ru,2026:changelog\/([^<]+)<\/id>/g)].map(
        (match) => match[1],
      ),
    ).toEqual(carried);
  }

  await page.goto('/changelog');
  await expect(page).toHaveTitle('Changelog — Webhook Inspector');
  await expect(page.getByRole('heading', { level: 1, name: 'Changelog' })).toBeVisible();

  // The header: Changelog as the current page, then Status and API docs, each
  // opening a new tab; the service's name only in the wordmark, which leads
  // home (D277), and no tool name beside it (D184).
  const banner = page.getByRole('banner');
  const current = banner.getByRole('link', { name: 'Changelog', exact: true });
  const status = banner.getByRole('link', { name: 'Status (opens in a new tab)', exact: true });

  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(current).toHaveAttribute('href', '/changelog');
  await expect(status).toHaveAttribute('href', 'https://status.qa-tools.ru/');
  await expect(status).toHaveAttribute('target', '_blank');
  await expect(status).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(status).not.toHaveAttribute('aria-current', /.*/);
  await expect(
    banner.getByRole('link', { name: 'API docs (opens in a new tab)', exact: true }),
  ).toHaveAttribute('target', '_blank');
  await expect(
    banner.getByRole('link', { name: 'Webhook Inspector', exact: true }),
  ).toHaveAttribute('href', '/');
  await expect(banner.getByText('Webhook Inspector')).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toContainText('contact@qa-tools.ru');

  // The feeds: in the head for a feed reader, and in a line under the text's
  // link for a reader (D212).
  expect(
    await page
      .locator('head link[rel="alternate"][type="application/atom+xml"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
  ).toEqual(['/changelog.xml', '/changelog-breaking.xml']);
  const subscribe = page.locator('p.plain', { hasText: 'Subscribe' });

  await expect(subscribe).toBeVisible();
  await expect(
    subscribe.getByRole('link', { name: '/changelog.xml', exact: true }),
  ).toHaveAttribute('href', '/changelog.xml');
  await expect(
    subscribe.getByRole('link', { name: '/changelog-breaking.xml', exact: true }),
  ).toHaveAttribute('href', '/changelog-breaking.xml');

  // Every version, newest first, the newest open and no other.
  const lines = versionLines(page);

  await expect(lines).toHaveCount(versions.all.length);
  expect(await lines.locator('.number').allTextContents()).toEqual(versions.all);
  await expect(page.locator('details.version[open]')).toHaveCount(1);
  await expect(lines.first()).toHaveAttribute('open', '');

  // Opening a line shows the rest of its entry.
  const second = lines.nth(1);

  await expect(second.locator('.entry')).toBeHidden();
  await second.locator('summary').click();
  await expect(second.locator('.entry')).toBeVisible();
  await second.locator('summary').click();

  // Breaking only leaves the breaking versions, and hides the days left empty.
  await page.getByRole('button', { name: 'Breaking only' }).click();
  await expect(page.getByRole('button', { name: 'Breaking only' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(lines).toHaveCount(versions.breaking.length);
  expect(await lines.locator('.number').allTextContents()).toEqual(versions.breaking);
  expect(
    await page
      .locator('.day:visible')
      .evaluateAll((days) =>
        days.every((day) => day.querySelector('details.version:not([hidden])') !== null),
      ),
  ).toBe(true);
  await expect(lines.locator('.badge')).toHaveCount(versions.breaking.length);

  // Expand all opens every line and then reads Collapse all.
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(page.locator('details.version:not([open])')).toHaveCount(0);
  await page.getByRole('button', { name: 'All versions' }).click();
  await expect(lines).toHaveCount(versions.all.length);
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.locator('details.version[open]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand all' })).toBeVisible();

  // Nothing scrolls sideways, at any width down to 320 px, every line open;
  // the header keeps its three links, the Q mark in place of the wordmark
  // below 375 px (D209).
  await page.getByRole('button', { name: 'Expand all' }).click();

  for (const width of [1440, 768, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(current, `${width} px`).toBeVisible();
    await expectHeaderLayout(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      `${width} px`,
    ).toBe(true);
  }

  expect(foreign, 'the changelog reached another origin').toEqual([]);

  // Without JavaScript every line still opens, and the toolbar is not shown.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();

  try {
    await plain.goto(`${origin}/changelog`);
    await expect(plain.locator('[data-toolbar]')).toBeHidden();

    const line = plain.locator('details.version').nth(2);

    await expect(line).not.toHaveAttribute('open', '');
    await line.locator('summary').click();
    await expect(line.locator('.entry')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the header of the application leads to the changelog in the same tab', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('banner').getByRole('link', { name: 'Changelog', exact: true }).click();
  await expect(page).toHaveURL(/\/changelog$/);
  await expect(page).toHaveTitle('Changelog — Webhook Inspector');
});
