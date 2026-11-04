import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeElement, installFakeBrowser, type FakeWindow } from '../testing/render-in-node.ts';
import type { BuiltMove, MoveData } from './move-link.ts';

/**
 * The move banner and the arrival toast as they are drawn (issue #346, D276),
 * in a bundle built with production's move: the components rendered in Node,
 * so where the banner shows and what the toast says are read from what React
 * draws, not from the source text.
 *
 * The move is set where the build sets it, as `__WEBHOOK_INSPECTOR_MOVE__`,
 * before `move-link.ts` is loaded, so `BUILT_MOVE` holds it; every module
 * that reads it is imported below that line. `move-link.test.ts` renders the
 * banner of a bundle built with no move.
 *
 * The page those tests open, `Page not found`, is read here too (#391): its
 * request names the host of the address it was opened on, as in a browser.
 */

/** Production's move, as `vite.config.ts` defines it; its day is a sample. */
const PRODUCTION: BuiltMove = {
  from: 'https://qa-tools.ru',
  to: 'https://webhook.qa-tools.ru',
  day: '2027-03-09',
};

Object.assign(globalThis, { __WEBHOOK_INSPECTOR_MOVE__: PRODUCTION });

const { BUILT_MOVE, buildMoveLink } = await import('./move-link.ts');
const { MoveBanner } = await import('../components/MoveBanner.tsx');
const { LanguageProvider } = await import('../i18n/LanguageProvider.tsx');

/** Origins that are neither of the move's, each a near miss of the old one or a copy's. */
const OTHER_ORIGINS = [
  'http://qa-tools.ru',
  'https://www.qa-tools.ru',
  'https://qa-tools.ru:8443',
  'https://qa-tools.ru.example',
  'https://inspector.example',
  'http://localhost:5173',
];

/** The banner as a page of `origin` draws it, in the interface's language, server-rendered. */
function bannerAt(origin: string, language: 'en' | 'ru' = 'en'): string {
  installFakeBrowser(`${origin}/`);

  return renderToStaticMarkup(
    createElement(LanguageProvider, {
      initial: language,
      storage: null,
      children: createElement(MoveBanner),
    }),
  );
}

/** What a page's markup reads as, its tags left out. */
function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, '');
}

describe('the move banner, rendered in a bundle built with the move', () => {
  it('has the build’s move', () => {
    assert.deepEqual(BUILT_MOVE, PRODUCTION);
  });

  it('draws on the old origin: the new host, day X and the one action, in both languages', () => {
    const banner = bannerAt('https://qa-tools.ru');

    assert.match(banner, /^<div data-testid="move-banner"/);
    assert.equal(
      text(banner),
      'Webhook Inspector is moving to webhook.qa-tools.ru on 9\u00a0Mar\u00a02027' +
        'Move with my sessions\u00a0→',
    );
    // The action's address is the new origin alone: the link is built as it is clicked.
    assert.match(banner, /<a href="https:\/\/webhook\.qa-tools\.ru\/"/);
    assert.doesNotMatch(banner, /move=/);

    assert.equal(
      text(bannerAt('https://qa-tools.ru', 'ru')),
      'Webhook Inspector переезжает на webhook.qa-tools.ru 9\u00a0мар.\u00a02027' +
        'Перейти со своими сессиями\u00a0→',
    );
  });

  it('keeps the host one piece, which no line breaks at its hyphen or its dots, in both languages (#347)', () => {
    for (const [language, before, after] of [
      ['en', 'Webhook Inspector is moving to ', ' on 9\u00a0Mar\u00a02027'],
      ['ru', 'Webhook Inspector переезжает на ', ' 9\u00a0мар.\u00a02027'],
    ] as const) {
      const banner = bannerAt('https://qa-tools.ru', language);

      // The host alone is in a span that does not wrap; the words around it
      // wrap as the browser wraps them, and the text reads as one sentence.
      assert.ok(
        banner.includes(
          `<p class="text-brand">${before}<span class="whitespace-nowrap">webhook.qa-tools.ru</span>${after}</p>`,
        ),
        language,
      );
      assert.equal(banner.match(/whitespace-nowrap/g)?.length, 1, language);
      assert.doesNotMatch(banner, /aria-hidden="true">webhook|role=|aria-label=/, language);
    }
  });

  it('draws nothing on the new origin', () => {
    assert.equal(bannerAt('https://webhook.qa-tools.ru'), '');
    assert.equal(bannerAt('https://webhook.qa-tools.ru', 'ru'), '');
  });

  it('draws nothing on any other origin', () => {
    for (const origin of OTHER_ORIGINS) {
      assert.equal(bannerAt(origin), '', origin);
    }
  });
});

/** A well-formed session id, different for every `n`. */
function id(n: number): string {
  return `S${String(n).padStart(6, '0')}${'k'.repeat(36)}`;
}

/** A well-formed access key, different for every `n`. */
function key(n: number): string {
  return `K${String(n).padStart(6, '0')}${'q'.repeat(36)}`;
}

/** Two sessions, one of them private, as the old address's banner carries them. */
const MOVED: MoveData = {
  sessions: [
    { id: id(1), openedAt: 1_700_000_000_000 },
    { id: id(2), openedAt: 1_700_000_100_000 },
  ],
  keys: [[id(1), key(1)]],
  language: 'en',
  queueSection: null,
  rulesSection: null,
};

/**
 * Starts the application at `href` as the browser does - `main.tsx`, a fresh
 * evaluation each time, into a fake browser's `#root` - and lets React draw
 * the page and run its effects. A page that asks the API nothing is opened,
 * `Page not found`, since Node has no server to answer.
 */
async function start(
  href: string,
  run: string,
): Promise<{ browser: FakeWindow; root: FakeElement }> {
  const browser = installFakeBrowser(href);
  const main = new URL(`../main.tsx?${run}`, import.meta.url).href;

  await act(async () => {
    await import(main);
  });

  const root = browser.document.getElementById('root');

  assert.ok(root, 'the page has no #root');

  return { browser, root };
}

/** The toasts on the page, by what they say. */
function toasts(root: FakeElement): string[] {
  return root.findAll('data-testid', 'toast').map((toast) => toast.textContent);
}

describe('the arrival toast, rendered from main.tsx in a bundle built with the move', () => {
  it('says what a move link brought, over the page it opened, on the new origin', async () => {
    const link = buildMoveLink(PRODUCTION.to, MOVED).replace('/#', '/no/such/page#');
    const { browser, root } = await start(link, 'arrival');
    const [toast] = root.findAll('data-testid', 'toast');

    // main.tsx read the link and gave App what came; App showed it.
    assert.deepEqual(toasts(root), ['Moved 2 sessions from qa-tools.ru, 1 of them private']);
    assert.equal(toast?.getAttribute('data-icon'), 'dot');
    assert.match(root.textContent, /Page not found/);
    // The link left the address, and the new origin draws no banner.
    assert.equal(browser.location.href, 'https://webhook.qa-tools.ru/no/such/page');
    assert.equal(root.findAll('data-testid', 'move-banner').length, 0);
  });

  it('shows no toast with no move link, and on the old origin draws the banner above the header', async () => {
    const { root } = await start('https://qa-tools.ru/no/such/page', 'no-link');
    const [banner, ...more] = root.findAll('data-testid', 'move-banner');

    assert.deepEqual(toasts(root), []);
    assert.equal(more.length, 0);
    assert.ok(banner, 'the old origin draws no banner');
    assert.equal(
      banner.textContent,
      'Webhook Inspector is moving to webhook.qa-tools.ru on 9\u00a0Mar\u00a02027' +
        'Move with my sessions\u00a0→',
    );
    assert.ok(
      banner.nextSibling instanceof FakeElement && banner.nextSibling.tagName === 'HEADER',
      'the banner is not drawn directly above the header',
    );
  });
});

/** The elements below `node` whose tag is `tagName`, in document order. */
function byTag(node: FakeElement, tagName: string): FakeElement[] {
  return node.childNodes.flatMap((child) =>
    child instanceof FakeElement
      ? [...(child.tagName === tagName ? [child] : []), ...byTag(child, tagName)]
      : [],
  );
}

describe('the page-not-found screen, rendered from main.tsx', () => {
  it('draws the request it was opened with, as a browser does: its line and the address bar’s host (#391)', async () => {
    const { root } = await start('https://qa-tools.ru/no/such/page', 'not-found');
    const [title] = byTag(root, 'H1');
    const [request, ...more] = byTag(root, 'PRE');

    assert.equal(title?.textContent, 'Page not found');
    assert.equal(more.length, 0);
    // The `Host:` line is the fake location's `host`, read by the page.
    assert.equal(
      request?.textContent,
      'GET /no/such/page HTTP/1.1\nHost: qa-tools.ru\n\nHTTP/1.1 404 Not Found',
    );
  });
});
