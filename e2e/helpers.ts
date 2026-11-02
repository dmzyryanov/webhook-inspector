/**
 * Shared steps for the three browser smoke journeys (D108).
 *
 * Deliberately not a page-object layer: three tests do not need one, and an
 * indirection between the test and the locator is one more place for the suite
 * to disagree with the application without failing.
 */
import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Request,
} from '@playwright/test';
import {
  OLD_REQUEST_ID_HEADER,
  REQUEST_ID_DISPLAY_LENGTH,
  REQUEST_ID_HEADER,
  SESSION_ID_PATTERN,
} from '@webhook-inspector/shared';
import { en } from '../apps/frontend/src/i18n/en.ts';
import { ru } from '../apps/frontend/src/i18n/ru.ts';

/**
 * Carries the id of the stored request back to the sender (D044, D100), beside
 * its old name, with the same value, until the old names stop (D279).
 */
export { REQUEST_ID_HEADER };

/**
 * A session id as the backend generates it: 43 letters and digits (D161).
 * `SESSION_ID_PATTERN` is wider, because it also accepts older ids with `_`
 * and `-`; every session this suite sees is created by the backend under test.
 */
export const NEW_SESSION_ID = /^[A-Za-z0-9]{43}$/;

/**
 * Creates a default session over the API, for setting a test up.
 *
 * No body and no `Content-Type` at all: that conjunction is the single
 * exemption from the media-type rule, and adding either one turns the
 * documented `201` into a `415` (D104).
 */
export async function createSessionViaApi(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/sessions');

  expect(response.status()).toBe(201);

  const session = (await response.json()) as { id: string };

  expect(session.id).toMatch(SESSION_ID_PATTERN);
  expect(session.id).toMatch(NEW_SESSION_ID);

  return session.id;
}

/** The session the page is showing, from its own URL. */
export async function sessionIdFromPage(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/v\/[A-Za-z0-9]{43}$/);

  return new URL(page.url()).pathname.replace('/v/', '');
}

/**
 * Where a session receives webhooks, as the API gives it (D187): the backend's
 * receive listener, which `playwright.setup.ts` has checked is the suite's own
 * (`e2e/app-address.ts`, which the specs do not import). Webhooks are sent
 * there directly, as production's are sent to the receive host, and never
 * through the dev server.
 */
export async function receiveUrlOf(request: APIRequestContext, sessionId: string): Promise<string> {
  const response = await request.get(`/api/sessions/${sessionId}`);

  expect(response.status()).toBe(200);

  const { receiveUrl } = (await response.json()) as { receiveUrl: string };

  expect(receiveUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/s/${sessionId}$`));

  return receiveUrl;
}

/**
 * The receive URL as the page prints it.
 *
 * Read from the DOM rather than composed here, and never through `Copy`:
 * `navigator.clipboard` needs a permission grant and would add a failure mode
 * that has nothing to do with what these tests are about. It is the session's
 * `receiveUrl`, on the receive listener's origin rather than the page's
 * (D187).
 */
export async function readReceiveUrl(page: Page): Promise<string> {
  const sessionId = await sessionIdFromPage(page);
  const shown = (await page.getByTestId('receive-url').innerText()).trim();

  expect(shown).toBe(await receiveUrlOf(page.request, sessionId));
  expect(new URL(shown).origin).not.toBe(new URL(page.url()).origin);

  return shown;
}

/**
 * A response header, looked up case-insensitively: HTTP field names are
 * case-insensitive (RFC 9110, section 5.1), so this lookup holds whatever an
 * intermediary on the way out does to the case.
 */
export function headerValue(response: APIResponse, name: string): string | undefined {
  const wanted = name.toLowerCase();

  for (const [key, value] of Object.entries(response.headers())) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }

  return undefined;
}

/**
 * The id the backend stored for a request it has just answered (D100), which
 * both request-id headers carry (D279).
 */
export function storedRequestId(response: APIResponse): string {
  const id = headerValue(response, REQUEST_ID_HEADER);

  expect(id, `${REQUEST_ID_HEADER} is missing from the webhook response`).toBeTruthy();
  expect(headerValue(response, OLD_REQUEST_ID_HEADER), OLD_REQUEST_ID_HEADER).toBe(id);

  return id as string;
}

/**
 * The row of one captured request, found by the id prefix the list shows. This
 * is what makes the tests independent of the order rows arrive in.
 */
export function requestRow(page: Page, requestId: string) {
  return page.getByRole('button', {
    name: new RegExp(requestId.slice(0, REQUEST_ID_DISPLAY_LENGTH)),
  });
}

/**
 * The geometry of one row, its time, its second line and its `×` (D157), and
 * of the status, the rule marker (issue #233) and the address on that line.
 * `clipped` is the text of every leaf drawn narrower than its text, the
 * screen-reader-only words aside, which are 1 px wide by design.
 */
export async function measureTouchRow(page: Page, requestId: string) {
  const rowButton = requestRow(page, requestId);

  await rowButton.scrollIntoViewIfNeeded();

  return rowButton.evaluate((button) => {
    const row = button.parentElement as HTMLElement;
    const line1 = button.children[0] as HTMLElement;
    const line2 = button.children[1] as HTMLElement;
    const id = line1.children[1] as HTMLElement;
    const lineTime = line1.lastElementChild as HTMLElement;
    const shownTime =
      getComputedStyle(lineTime).display === 'none'
        ? (row.querySelector('[data-testid="row-time"]') as HTMLElement)
        : lineTime;
    const remove = row.querySelector('button[aria-label="Delete request"]') as HTMLElement;
    const status = row.querySelector('[data-testid="row-status"]') as HTMLElement;
    const rule = row.querySelector<HTMLElement>('[data-testid="row-rule"]');
    const address = row.querySelector('[data-testid="row-address"]') as HTMLElement;
    const glyph = document.createRange();

    glyph.selectNodeContents(remove);

    const rect = (element: Element) => element.getBoundingClientRect();
    const rowRect = rect(row);
    const timeRect = rect(shownTime);
    const removeRect = rect(remove);
    const clipped = Array.from(button.querySelectorAll('span'))
      .filter((span) => span.childElementCount === 0 && getComputedStyle(span).display !== 'none')
      .filter((span) => !span.classList.contains('sr-only'))
      .filter((span) => span.scrollWidth > span.clientWidth + 1)
      .map((span) => span.textContent);
    const ruleRect = rule === null ? null : rect(rule);

    return {
      rowTop: rowRect.top,
      rowHeight: rowRect.height,
      rowRight: rowRect.right,
      rowBottom: rowRect.bottom,
      time: shownTime.textContent,
      timeLeft: timeRect.left,
      timeRight: timeRect.right,
      idRight: rect(id).right,
      line1Bottom: rect(line1).bottom,
      line2Top: rect(line2).top,
      line2Right: Math.max(...Array.from(line2.children).map((child) => rect(child).right)),
      glyphRight: glyph.getBoundingClientRect().right,
      deleteLeft: removeRect.left,
      deleteTop: removeRect.top,
      deleteRight: removeRect.right,
      deleteBottom: removeRect.bottom,
      deleteWidth: removeRect.width,
      deleteHeight: removeRect.height,
      statusTop: rect(status).top,
      statusRight: rect(status).right,
      rule:
        rule === null || ruleRect === null
          ? null
          : {
              text: rule.textContent,
              left: ruleRect.left,
              right: ruleRect.right,
              top: ruleRect.top,
              height: ruleRect.height,
              background: getComputedStyle(rule).backgroundColor,
            },
      addressLeft: rect(address).left,
      addressTruncated: address.scrollWidth > address.clientWidth + 1,
      clipped,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

/** The session reads the page issued, split by the first `ready` frame. */
export interface SessionReadTimeline {
  /** Issued before the socket was ready: the mount fetch, however many times. */
  beforeReady: string[];
  /** Issued after it: the page reading its session on a live connection. */
  afterReady: string[];
}

/**
 * Every `GET /api/sessions/<id>` the page issues, ordered against the first
 * `ready` frame of its session socket. Call it before navigating, for the same
 * reason as the frame collector below.
 *
 * Only that exact route counts: the path is matched to its end, so the list,
 * detail and delete routes under the same prefix are not mistaken for it. It is
 * the one API call that slides a session's expiry (D133), which is why the
 * suite counts it rather than merely watching the page work.
 *
 * **The split is the point.** A count alone cannot say anything here: this
 * suite runs a Vite dev server and the app is wrapped in `StrictMode`, so React
 * double-invokes the mount effect and the mount alone issues this request
 * twice. An assertion on the total passes whether or not the page ever reads
 * its session again, which is precisely the behaviour worth pinning. Ordering
 * against the socket is immune to that: a read that arrives after `ready` can
 * only have come from the connection handler.
 */
export function collectSessionReadTimeline(page: Page): SessionReadTimeline {
  const timeline: SessionReadTimeline = { beforeReady: [], afterReady: [] };
  let ready = false;

  page.on('websocket', (socket) => {
    // The session socket alone: Vite's HMR channel is a WebSocket too, and it
    // is open before this one. Matching the event object exactly rather than
    // the bare word keeps any other payload from flipping the split early.
    if (!/^\/ws\/[A-Za-z0-9_-]{43}$/.test(new URL(socket.url()).pathname)) {
      return;
    }

    socket.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string' && frame.payload.includes('"type":"ready"')) {
        ready = true;
      }
    });
  });

  page.on('request', (request) => {
    const match = /^\/api\/sessions\/([A-Za-z0-9_-]{43})$/.exec(new URL(request.url()).pathname);
    const sessionId = match?.[1];

    if (request.method() === 'GET' && sessionId !== undefined) {
      (ready ? timeline.afterReady : timeline.beforeReady).push(sessionId);
    }
  });

  return timeline;
}

/**
 * Every frame the page received over its session WebSocket, collected from the
 * moment this is called. Call it before navigating: a frame that arrives before
 * the listener is attached is not recorded.
 */
export function collectRealtimeFrames(page: Page): string[] {
  const frames: string[] = [];

  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string') {
        frames.push(frame.payload);
      }
    });
  });

  return frames;
}

/**
 * The pages the application does not render: HTML built with no script, with
 * no `EN | RU` switch (D184, D211, D217, D222), in English but for
 * `/ru/about` (D255).
 */
const STATIC_PAGES = ['/changelog', '/about', '/terms', '/privacy', '/ru/about'];

/**
 * Waits until the `EN | RU` switch is where the window's width puts it (issue
 * #108, D222): on the application's pages in the header from 768 px and in
 * the footer band below it, and on the static pages nowhere.
 *
 * Call it after a resize, before measuring the header or the band. The switch
 * is placed by script, which follows the width only when React re-renders
 * after the media query's change, a frame or more after `setViewportSize`
 * returns; until then the page is the width before's - at 375 px the band
 * read 85 px, the line `EN | RU` adds still missing. `toHaveCount` retries
 * until the page has re-rendered, with no fixed wait. The switch is counted,
 * not looked at, since each one is also hidden by CSS on the other side of
 * 768 px the moment the width changes (D222 item 6): what is shown follows
 * the width at once, and only the count follows React's re-render.
 *
 * Do not call it with a request open below 768 px: a phone's open request
 * renders the band hidden (D177), and `getByRole('contentinfo')` leaves a
 * hidden band out, so the switch it holds there would not be counted. No
 * caller has a request open.
 */
export async function expectLanguageSwitchPlaced(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const pathname = new URL(page.url()).pathname.replace(/\/$/, '');
  const application = !STATIC_PAGES.includes(pathname);

  await expect(
    page.getByRole('banner').getByTestId('language-switch'),
    `${width} px, the switch in the header`,
  ).toHaveCount(application && width >= 768 ? 1 : 0);
  await expect(
    page.getByRole('contentinfo').getByTestId('language-switch'),
    `${width} px, the switch in the band`,
  ).toHaveCount(application && width < 768 ? 1 : 0);
}

/**
 * The header as laid out at the current width (issue #99, D209; Figma page
 * `Webhook Inspector · Status page link (#99)`, direction B′), on the
 * application's pages and on `/changelog` alike: the link home named
 * `Webhook Inspector`, its words shown from 375 px and the 24 px Q mark below
 * — on one line at 17 px from 768 px, on two at 15/17 px below, the header
 * 64 px high from 1024 px and 56 px below (issue #322, D277); then
 * `Changelog`, a 1 × 16 px divider, `Status ↗`, a divider and `API docs ↗`,
 * left to right, 16 px apart from 768 px and 12 px below, both arrows drawn,
 * all inside the window; and nothing scrolling sideways. On the application's
 * pages, from 768 px, a third divider and the `EN | RU` switch close the row,
 * 16 px apart as the links are (issue #108, D222); a phone has the switch in
 * the footer band, and the static pages, `/changelog`, `/about`, `/terms`,
 * `/privacy` and `/ru/about`, have none. The words are those of the page's
 * `<html lang>`: `Изменения`, `Статус ↗` and `API docs ↗` on `/ru/about`
 * (D255). It waits first for the switch to be in its place, so a header read
 * just after a resize is the new width's.
 */
export async function expectHeaderLayout(page: Page): Promise<void> {
  await expectLanguageSwitchPlaced(page);

  const m = (await page.evaluate(() => document.documentElement.lang)) === 'ru' ? ru : en;
  const statusName = `${m.header.status} ${m.header.newTab}`;
  const apiDocsName = `${m.header.apiDocs} ${m.header.newTab}`;
  const banner = page.getByRole('banner');
  const home = banner.getByRole('link', { name: 'Webhook Inspector', exact: true });
  const changelog = banner.getByRole('link', { name: m.header.changelog, exact: true });
  const status = banner.getByRole('link', { name: statusName, exact: true });
  const apiDocs = banner.getByRole('link', { name: apiDocsName, exact: true });

  for (const link of [home, changelog, status, apiDocs]) {
    await expect(link).toBeVisible();
  }

  const width = page.viewportSize()?.width ?? 0;
  const layout = await changelog.evaluate((link) => {
    const row = link.parentElement as HTMLElement;
    const brand = (row.parentElement as HTMLElement).querySelector('a') as HTMLAnchorElement;
    // `drawn`: laid out and visible at more than `.sr-only`'s 1 x 1 px.
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
        drawn:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          (rect.width > 1 || rect.height > 1),
      };
    };
    const image = brand.querySelector('img');
    const words = Array.from(brand.children).find((child) => child.tagName === 'SPAN');

    return {
      children: Array.from(row.children, (child) => ({
        tag: child.tagName,
        text: child.textContent,
        language: child.getAttribute('data-testid') === 'language-switch',
        box: box(child),
        arrow:
          child.querySelector('svg') === null ? null : box(child.querySelector('svg') as Element),
      })),
      mark: image === null ? null : box(image),
      words: words === undefined ? null : box(words),
      wordsText: words?.textContent?.trim() ?? null,
      wordsFont:
        words === undefined
          ? null
          : {
              size: getComputedStyle(words).fontSize,
              lineHeight: getComputedStyle(words).lineHeight,
              weight: getComputedStyle(words).fontWeight,
            },
      headerHeight: (row.parentElement as HTMLElement).getBoundingClientRect().height,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });

  expect(layout.scrollWidth, `${width} px scrolls sideways`).toBeLessThanOrEqual(
    layout.clientWidth,
  );

  // The wordmark from 375 px, the Q mark below, never both.
  if (width < 375) {
    expect(layout.mark, `${width} px`).toMatchObject({ drawn: true, width: 24, height: 24 });
    expect(layout.words?.drawn, `${width} px shows the wordmark`).toBe(false);
  } else {
    expect(layout.words?.drawn, `${width} px hides the wordmark`).toBe(true);
    expect(layout.mark?.drawn, `${width} px shows the Q mark`).toBe(false);
  }

  // The service's name (D277): one line of 17 px Semi Bold from 768 px, and
  // `Webhook` over `Inspector`, 15 px on 17 px lines, from 375 to 767 px; the
  // header 64 px high from 1024 px and 56 px below, whatever the lines.
  expect(layout.wordsText, `${width} px`).toBe('Webhook Inspector');
  expect(layout.headerHeight, `${width} px, the header`).toBe(width >= 1024 ? 64 : 56);

  if (width >= 768) {
    expect(layout.wordsFont, `${width} px`).toMatchObject({ size: '17px', weight: '600' });
    expect(layout.words?.height ?? 0, `${width} px, one line`).toBeLessThan(26);
  } else if (width >= 375) {
    expect(layout.wordsFont, `${width} px`).toEqual({
      size: '15px',
      lineHeight: '17px',
      weight: '600',
    });
    expect(layout.words?.height, `${width} px, two lines`).toBe(34);
  }

  // The application's pages carry the language switch from 768 px (D222).
  const pathname = new URL(page.url()).pathname.replace(/\/$/, '');
  const switchShown = width >= 768 && !STATIC_PAGES.includes(pathname);

  // Changelog | Status ↗ | API docs ↗: three links, two dividers, two arrows;
  // then | EN | RU where the switch is.
  expect(layout.children.map((child) => child.tag)).toEqual(
    switchShown ? ['A', 'SPAN', 'A', 'SPAN', 'A', 'SPAN', 'SPAN'] : ['A', 'SPAN', 'A', 'SPAN', 'A'],
  );
  expect(layout.children.map((child) => child.text)).toEqual([
    m.header.changelog,
    '',
    statusName,
    '',
    apiDocsName,
    ...(switchShown ? ['', 'EN English|RU Русский'] : []),
  ]);
  expect(layout.children.map((child) => child.language)).toEqual(
    layout.children.map((_child, index) => switchShown && index === 6),
  );

  const [, firstDivider, statusLink, secondDivider, apiDocsLink, thirdDivider, language] =
    layout.children;

  for (const divider of switchShown
    ? [firstDivider, secondDivider, thirdDivider]
    : [firstDivider, secondDivider]) {
    expect(divider?.box, `${width} px`).toMatchObject({ drawn: true, width: 1, height: 16 });
  }

  for (const link of [statusLink, apiDocsLink]) {
    expect(link?.arrow, `${width} px`).toMatchObject({ drawn: true, width: 10, height: 10 });
  }

  const gap = width >= 768 ? 16 : 12;

  for (let index = 1; index < layout.children.length; index += 1) {
    const before = layout.children[index - 1]?.box;
    const after = layout.children[index]?.box;

    expect((after?.left ?? 0) - (before?.right ?? 0), `${width} px, gap ${index}`).toBeCloseTo(
      gap,
      1,
    );
  }

  expect((language ?? apiDocsLink)?.box.right ?? Infinity, `${width} px`).toBeLessThanOrEqual(
    layout.clientWidth,
  );
}

/**
 * Every request of the context that leaves the page's origin, refused before
 * it leaves: what a static page must never make (D211, D217).
 */
export function watchOrigins(page: Page, origin: string): string[] {
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
 * The lines of a static page's blocks as laid out, each as its words: the
 * title, the story and the facts of `/about` (D211), or the title, the
 * introduction and the sections of `/terms` and `/privacy` (D217), named by
 * `selector`. A word is a run of characters between white space, no-break
 * spaces included, read across the page's inline elements, so `mcp.` after
 * the address is part of the address's word; a word starts a new line when it
 * sits lower than half a line below the line's first word.
 */
export async function laidOutLines(page: Page, selector: string): Promise<string[][]> {
  return page.evaluate((blocks) => {
    const lines: string[][] = [];

    for (const block of document.querySelectorAll(blocks)) {
      const characters: { node: Text; offset: number; text: string }[] = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;

        for (let offset = 0; offset < text.data.length; offset += 1) {
          characters.push({ node: text, offset, text: text.data[offset] as string });
        }
      }

      const half = parseFloat(getComputedStyle(block).lineHeight) / 2;
      let top = Number.NEGATIVE_INFINITY;
      let start = -1;

      for (let index = 0; index <= characters.length; index += 1) {
        const space = index === characters.length || /\s/.test(characters[index]?.text ?? ' ');

        if (!space && start < 0) {
          start = index;
        } else if (space && start >= 0) {
          const first = characters[start] as (typeof characters)[number];
          const last = characters[index - 1] as (typeof characters)[number];
          const range = document.createRange();

          range.setStart(first.node, first.offset);
          range.setEnd(last.node, last.offset + 1);

          const word = characters
            .slice(start, index)
            .map((character) => character.text)
            .join('');
          const wordTop = range.getClientRects()[0]?.top ?? top;

          if (wordTop > top + half) {
            top = wordTop;
            lines.push([]);
          }

          lines.at(-1)?.push(word);
          start = -1;
        }
      }
    }

    return lines;
  }, selector);
}
