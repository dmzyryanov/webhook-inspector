import { expect, test } from '@playwright/test';
import {
  LEGAL_PAGES,
  legalLineText,
  STABILITY_POLICY_HREF,
} from '../apps/frontend/src/lib/legal-copy.ts';
import { FOOTER_LINKS, PRIVACY_FOOTER_TEXT } from '../apps/frontend/src/lib/privacy-footer.ts';
import { expectHeaderLayout, laidOutLines, watchOrigins } from './helpers.ts';

/**
 * The Terms of Use as the build writes it: the first of `LEGAL_PAGES`, which
 * the suite's build has, its operator settings production's
 * (`playwright.config.ts`, #369).
 */
const [TERMS_PAGE] = LEGAL_PAGES;

if (TERMS_PAGE === undefined) {
  throw new Error(
    "the suite's build has no Terms of Use: its operator settings are not production's",
  );
}

/**
 * E2E-16 — the Terms of Use at /terms and the Privacy Policy at /privacy
 * (issue #112, D217).
 *
 * The pages are static HTML the build writes from `legal-copy.ts`, with no
 * script; what only a browser can show: that each is served at both its
 * addresses and is never the application; that with JavaScript off it reads
 * in full; that its header is every page's, with no current page, and its
 * footer marks its own link as the current page; that at 1440, 768, 375 and
 * 320 px nothing scrolls sideways and no line of the title, the introduction
 * or the sections' lines holds a single word, and at the approved frames'
 * widths (T1–T3 and P1–P3 of the Figma page `Webhook Inspector · Terms and
 * Privacy (#112)`) the column, its padding, the label rail and the footer band
 * are the frames'; that it reaches no origin but its own; that `stability
 * policy` lands on the Stability section of /docs; and that the application's
 * footer leads to both in the same tab. Where each line wraps is not held
 * here: it rests on the platform's glyph advances, and the frames' whole
 * heights were matched in Chromium when the pages were built (D217).
 *
 * The dev server stands in for nginx here (D108): `apps/frontend/vite.config.ts`
 * serves `/terms`, `/terms/`, `/privacy` and `/privacy/` as `nginx.conf` does,
 * and `apps/frontend/src/lib/legal-page.test.ts` reads `nginx.conf` itself.
 */

/**
 * The blocks whose lines are laid out: the title, the introduction and the
 * sections' lines. The labels are not among them: `Limits`, `Logs`,
 * `Liability` and `Contact` are labels of one word, as approved.
 */
const BLOCKS = 'h1, .lead p:not(.updated), .fact dd p';

/**
 * The frames' measures at 1440, 768 and 375 px (T1–T3, P1–P3 of `Webhook
 * Inspector · Terms and Privacy (#112)`): the column's left edge and width,
 * the space above and below it, where a section's lines start against its
 * label (beside it on a 160 px rail, or under it on a phone), and the footer
 * band's height (D177). The frames' 85 px band at 375 px is a line more with
 * the words of 1.15.16 (D265), and 375 px is closer than 9 px to the width
 * where it changes - measured in Chromium on 2026-10-25, 102 px from 376 px
 * down to 346 and 85 px at 377 - so there only its fit is asserted; at 320 px
 * it is 119 px, which it is from 345 down to 295 px (D217).
 */
const FRAMES: Record<
  number,
  { left: number; width: number; above: number; below: number; lines: number; band?: number }
> = {
  1440: { left: 240, width: 960, above: 56, below: 72, lines: 192, band: 34 },
  768: { left: 40, width: 688, above: 56, below: 40, lines: 192, band: 51 },
  375: { left: 16, width: 343, above: 28, below: 40, lines: 0 },
};

/** The band's height at 320 px, which no frame draws. */
const BAND_AT_320 = 119;

for (const legal of LEGAL_PAGES) {
  test(`${legal.path} reads without a script, as approved, and fits every width`, async ({
    page,
    browser,
    baseURL,
  }) => {
    const origin = new URL(baseURL as string).origin;
    const foreign = watchOrigins(page, origin);

    for (const address of [legal.path, `${legal.path}/`]) {
      const answer = await page.request.get(address);

      expect(answer.status()).toBe(200);
      expect(answer.headers()['content-type']).toMatch(/^text\/html/);
      expect(answer.headers()['cache-control']).toBe('no-cache');
      expect(answer.headers()['x-robots-tag']).toBeUndefined();

      const html = await answer.text();

      // The page itself, not the application shell, and offered to search engines.
      expect(html).toContain(`<title>${legal.title}</title>`);
      expect(html).toContain(`<link rel="canonical" href="${legal.url}" />`);
      expect(html).not.toMatch(/noindex/i);
    }

    await page.goto(legal.path);
    await expect(page).toHaveTitle(legal.title);

    // The texts as `textContent`, which keeps their no-break spaces.
    const main = page.getByRole('main');

    expect(await main.locator('.eyebrow').evaluate((element) => element.textContent)).toBe(
      legal.eyebrow,
    );
    expect(await main.locator('h1').evaluate((element) => element.textContent)).toBe(legal.heading);
    expect(
      await main.locator('.lead p').evaluateAll((all) => all.map((p) => p.textContent)),
    ).toEqual([legal.introduction, legal.updated]);
    expect(
      await main
        .locator('.fact dd')
        .evaluateAll((all) =>
          all.map((dd) => Array.from(dd.querySelectorAll('p'), (p) => p.textContent)),
        ),
    ).toEqual(legal.sections.map((section) => section.lines.map(legalLineText)));
    await expect(main.locator('dt')).toHaveText(legal.sections.map((section) => section.label));

    // Every contact address is mail; `stability policy` is the one other link.
    const links = main.getByRole('link');

    for (const href of await links.evaluateAll((all) =>
      all.map((link) => link.getAttribute('href')),
    )) {
      expect(['mailto:contact@qa-tools.ru', STABILITY_POLICY_HREF]).toContain(href);
    }

    await expect(main.getByRole('link', { name: 'contact@qa-tools.ru', exact: true })).toHaveCount(
      legal === TERMS_PAGE ? 1 : 3,
    );

    // The header is every page's, none of its links the current page; the
    // footer is every page's, this page's link its current page.
    const banner = page.getByRole('banner');

    await expect(banner.locator('[aria-current]')).toHaveCount(0);

    const footer = page.getByRole('contentinfo');

    expect(await footer.evaluate((element) => element.textContent?.trim())).toBe(
      PRIVACY_FOOTER_TEXT,
    );

    for (const link of FOOTER_LINKS) {
      const item = footer.getByRole('link', { name: link.label, exact: true });

      await expect(item).toHaveAttribute('href', link.href);

      if (link.href === legal.path) {
        await expect(item).toHaveAttribute('aria-current', 'page');
      } else {
        await expect(item).not.toHaveAttribute('aria-current', /.*/);
      }
    }

    // No sideways scroll and no line of a single word, at the approved
    // frames' widths and at 320 px; the header keeps its three links (D209);
    // at the frames' widths the column, its padding, the rail and the band
    // are the frames', and the date line is 12 px under the introduction.
    for (const width of [1440, 768, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expectHeaderLayout(page);

      const layout = await page.evaluate(() => {
        const box = (selector: string) =>
          (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
        const main = getComputedStyle(document.querySelector('main') as HTMLElement);
        const container = document.querySelector('.container') as HTMLElement;
        const padding = getComputedStyle(container);
        const column = container.getBoundingClientRect();

        return {
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          left: column.left + parseFloat(padding.paddingLeft),
          width: column.width - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight),
          above: parseFloat(main.paddingTop),
          below: parseFloat(main.paddingBottom),
          lines: box('.fact dd').left - box('.fact dt').left,
          rail: box('.fact dt').width,
          dateGap: box('.lead .updated').top - box('.lead p').bottom,
          band: box('footer').height,
        };
      });

      expect(layout.sideways, `${width} px`).toBe(false);

      if (width === 320) {
        expect(layout.band, `${width} px`).toBe(BAND_AT_320);
      }

      const frame = FRAMES[width];

      if (frame !== undefined) {
        expect(
          {
            left: layout.left,
            width: layout.width,
            above: layout.above,
            below: layout.below,
            lines: layout.lines,
            ...(frame.band === undefined ? {} : { band: layout.band }),
          },
          `${width} px`,
        ).toEqual(frame);
        expect(layout.dateGap, `${width} px`).toBe(12);

        if (frame.lines > 0) {
          expect(layout.rail, `${width} px`).toBe(160);
        }
      }

      const lines = await laidOutLines(page, BLOCKS);

      expect(lines.length, `${width} px`).toBeGreaterThanOrEqual(
        legal.sections.reduce((sum, section) => sum + section.lines.length, 2),
      );
      expect(
        lines.filter((words) => words.length < 2).map((words) => words.join(' ')),
        `${width} px: lines of a single word`,
      ).toEqual([]);
    }

    expect(foreign, `${legal.path} reached another origin`).toEqual([]);

    // Without JavaScript the page is the same: it has no script of its own
    // (legal-page.test.ts reads the template; the dev server adds its client).
    const context = await browser.newContext({ javaScriptEnabled: false });
    const plain = await context.newPage();

    try {
      await plain.goto(`${origin}${legal.path}`);
      await expect(plain.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await plain.locator('h1').evaluate((element) => element.textContent)).toBe(
        legal.heading,
      );
      await expect(plain.locator('.fact')).toHaveCount(legal.sections.length);
    } finally {
      await context.close();
    }
  });
}

test('`stability policy` on /terms lands on the Stability section of /docs', async ({ page }) => {
  await page.goto(TERMS_PAGE.path);
  await page.getByRole('main').getByRole('link', { name: 'stability policy', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/docs');
  expect(new URL(page.url()).hash).toBe(STABILITY_POLICY_HREF.slice('/docs'.length));

  const heading = page.getByRole('heading', { name: 'Stability', exact: true });

  await expect(heading).toBeInViewport();
});

test('the footer of the application leads to both pages in the same tab', async ({ page }) => {
  for (const legal of LEGAL_PAGES) {
    const label = FOOTER_LINKS.find((link) => link.href === legal.path)?.label as string;

    await page.goto('/');
    await page.getByRole('contentinfo').getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${legal.path}$`));
    await expect(page).toHaveTitle(legal.title);
  }
});
