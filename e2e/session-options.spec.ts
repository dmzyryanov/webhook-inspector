import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test';
import {
  collectRealtimeFrames,
  createSessionViaApi,
  readReceiveUrl,
  requestRow,
  sessionIdFromPage,
  storedRequestId,
} from './helpers.ts';

/**
 * E2E-20 — the new session's options on the home page (issue #216, D249;
 * Figma `Webhook Inspector · New session options`, direction A, page
 * `819:23`, whose frames A1–A3 and S1 at 1440 px and P1–P5 on a phone name
 * the steps below).
 *
 * What a creation sends with each choice, the trigger's wording and the line
 * on the session card are unit-tested (`session-options.test.ts`,
 * `session-lifetime.test.ts`, `address.test.ts`); here they are checked
 * leaving and reaching a real page: the request each choice sends, read off
 * the wire; the trigger, the menu and the phone's sheet by role and name,
 * from the keyboard too, staying open while a choice is made and closing on
 * Escape, outside and a swipe down; the session page of a 1-hour session
 * without the sender's IP; hostile session answers; and the 10-minute read
 * of an open tab, under Playwright's clock. From 768 px the divider is the
 * trigger's first 1.5 px, the tile's full height, and each part's hover ends
 * at it; the tile and the trigger show the hand, as every enabled button
 * does, and a disabled one and a menu item keep the arrow (issue #246). The
 * divider is dashed as the tile's border is, read off its SVG lines' stroke
 * (issue #248).
 */

const NBSP = ' ';
/** `--color-ink-muted` and `--color-brand`: the trigger's two tones. */
const MUTED = 'rgb(95, 105, 125)';
const INK = 'rgb(31, 46, 82)';
const TODAY = 'SESSION EXPIRES 7 DAYS AFTER LAST USE';
const TEN_MINUTES = 10 * 60 * 1000;
/** `--color-tile-dash`, the dashed border's and the divider's colour. */
const TILE_DASH = 'rgb(169, 182, 204)';
/** `--color-row-pick-hover`, a hovered part of the tile. */
const PICK_HOVER = 'rgb(243, 247, 255)';
/** `--color-canvas`, the trigger at rest. */
const CANVAS = 'rgb(249, 250, 252)';
/** The home page's list of sessions, as `session-list.ts` stores it. */
const SESSIONS_KEY = 'qa-tools:sessions';

const tile = (page: Page) => page.getByRole('button', { name: /^Generate URL/ });
const trigger = (page: Page) => page.getByRole('button', { name: /^New session options/ });
const menu = (page: Page) => page.getByRole('menu');
/** The dashed line that splits the tile (#246, #248): from 768 px, the trigger's first child. */
const divider = (page: Page) => trigger(page).locator(':scope > span[aria-hidden="true"]');
/** The trigger's values and caret, after the divider. */
const values = (page: Page) => trigger(page).locator(':scope > span:not([aria-hidden])');

/** One of the divider's SVG lines, as drawn: where it runs and its stroke. */
interface DividerLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: string;
  dashArray: string;
  dashArrayAttribute: string | null;
  dashOffset: string;
}

/** The divider's SVG lines: their ends in the divider's own pixels and their computed stroke. */
function dividerLines(page: Page): Promise<DividerLine[]> {
  return divider(page).evaluate((element) =>
    Array.from(element.querySelectorAll('svg > line'), (line) => {
      const svgLine = line as SVGLineElement;
      const style = getComputedStyle(svgLine);

      return {
        x1: svgLine.x1.baseVal.value,
        y1: svgLine.y1.baseVal.value,
        x2: svgLine.x2.baseVal.value,
        y2: svgLine.y2.baseVal.value,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        dashArray: style.strokeDasharray,
        dashArrayAttribute: svgLine.getAttribute('stroke-dasharray'),
        dashOffset: style.strokeDashoffset,
      };
    }),
  );
}

/** Every `POST /api/sessions` the page sends, as it left. */
function watchCreations(page: Page): Request[] {
  const sent: Request[] = [];

  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions') {
      sent.push(request);
    }
  });

  return sent;
}

/** Errors a visitor's console would show as uncaught. */
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

/** The colour and weight a trigger value is drawn in. */
function tone(value: Locator): Promise<{ color: string; weight: string }> {
  return value.evaluate((element) => {
    const style = getComputedStyle(element);

    return { color: style.color, weight: style.fontWeight };
  });
}

/** Creates a session from the tile and answers the request that created it. */
async function generate(page: Page, sent: Request[]): Promise<Request> {
  const before = sent.length;

  await tile(page).click();
  await expect.poll(() => sent.length).toBe(before + 1);
  await sessionIdFromPage(page);

  return sent[before] as Request;
}

test.describe('E2E-20 — the new session’s options', () => {
  test('the defaults send no body; 1 hour without the IP sends its keys, and the session page states them', async ({
    page,
  }) => {
    const uncaught = watchUncaught(page);
    const sent = watchCreations(page);

    await page.goto('/');

    // Figma frame A1: both values in sight, muted, and the tile's own hint.
    await expect(trigger(page)).toHaveAccessibleName('New session options: 7 days · IP stored');
    expect(await tone(trigger(page).getByText('7 days', { exact: true }))).toEqual({
      color: MUTED,
      weight: '400',
    });
    await expect(tile(page)).toContainText('— your temporary endpoint, ready in a second');

    // With the defaults, the request that creates the session carries no body
    // and no Content-Type at all (D104).
    const plain = await generate(page, sent);

    expect(plain.postData()).toBeNull();
    expect(plain.headers()['content-type']).toBeUndefined();
    await expect(page.getByText(TODAY, { exact: true })).toBeVisible();
    await expect(page.getByText('IP NOT STORED')).toHaveCount(0);

    // Figma frame A2: the menu, its choices by role and name; choosing does
    // not close it.
    await page.goto('/');
    await trigger(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(page.getByRole('group', { name: /expires after last use/i })).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: '7 days' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByRole('menuitemradio', { name: '1 hour' }).click();
    await expect(menu(page)).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: '1 hour' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    const storeIp = page.getByRole('menuitemcheckbox', { name: "Store the sender's IP" });

    await expect(storeIp).toHaveAttribute('aria-checked', 'true');
    await expect(storeIp).toHaveAccessibleDescription(`Off: requests show “IP not stored”`);
    await storeIp.click();
    await expect(menu(page)).toBeVisible();
    await expect(storeIp).toHaveAttribute('aria-checked', 'false');

    // Figma frame A3: Escape closes it and focus returns; the values in ink,
    // the hint replaced.
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAccessibleName('New session options: 1 hour · IP not stored');
    expect(await tone(trigger(page).getByText('1 hour', { exact: true }))).toEqual({
      color: INK,
      weight: '500',
    });
    await expect(tile(page)).toContainText('— expires 1 hour after last use');
    await expect(tile(page)).not.toContainText('ready in a second');

    const chosen = await generate(page, sent);

    expect(chosen.postData()).toBe('{"expiresAfterIdleSeconds":3600,"storeSourceIp":false}');
    expect(chosen.headers()['content-type']).toBe('application/json');

    // Figma frame S1: the card states the rule and the marker, on one line
    // from 768 px.
    const sessionId = await sessionIdFromPage(page);
    const read = await page.request.get(`/api/sessions/${sessionId}`);
    const session = (await read.json()) as Record<string, unknown>;

    expect([
      session.expiresAfterIdleSeconds,
      session.lifetimeEndsAt,
      session.storeSourceIp,
    ]).toEqual([3600, null, false]);

    const line = page.getByText('SESSION EXPIRES 1 HOUR AFTER LAST USE · IP NOT STORED', {
      exact: true,
    });

    await expect(line).toBeVisible();
    expect(Math.round((await line.boundingBox())?.height ?? 0)).toBeLessThan(20);

    // A webhook: its row and the detail read `IP not stored` where the address was.
    const receiveUrl = await readReceiveUrl(page);
    const captured = await page.request.post(receiveUrl, { data: '{"ip":"kept out"}' });

    expect(captured.status()).toBe(200);

    const row = requestRow(page, storedRequestId(captured));

    await expect(row).toBeVisible();
    await expect(page.getByTestId('row-address')).toHaveText('IP not stored');
    await row.click();
    await expect(page.getByTestId('request-facts')).toContainText(' · IP not stored · ');
    expect(uncaught).toEqual([]);
  });

  test('each choice sends only its own key; 7 days and the IP again send no body; a click outside closes the menu', async ({
    page,
  }) => {
    const sent = watchCreations(page);

    async function choose(window: string | null, toggleIp: boolean): Promise<Request> {
      await page.goto('/');
      await trigger(page).click();

      if (window !== null) {
        await page.getByRole('menuitemradio', { name: window }).click();
      }

      if (toggleIp) {
        await page.getByRole('menuitemcheckbox', { name: "Store the sender's IP" }).click();
      }

      await page.keyboard.press('Escape');

      return generate(page, sent);
    }

    expect((await choose('1 day', false)).postData()).toBe('{"expiresAfterIdleSeconds":86400}');
    expect((await choose(null, true)).postData()).toBe('{"storeSourceIp":false}');
    await expect(
      page.getByText('SESSION EXPIRES 7 DAYS AFTER LAST USE · IP NOT STORED'),
    ).toBeVisible();

    // A choice made and taken back: 7 days, the IP on again, no body at all.
    await page.goto('/');
    await trigger(page).click();
    await page.getByRole('menuitemradio', { name: '1 hour' }).click();
    await page.getByRole('menuitemcheckbox', { name: "Store the sender's IP" }).click();
    await page.getByRole('menuitemradio', { name: '7 days' }).click();
    await page.getByRole('menuitemcheckbox', { name: "Store the sender's IP" }).click();
    await expect(menu(page)).toBeVisible();

    // Outside closes it.
    await page.mouse.click(20, 900);
    await expect(menu(page)).toBeHidden();
    await expect(trigger(page)).toHaveAccessibleName('New session options: 7 days · IP stored');

    const back = await generate(page, sent);

    expect(back.postData()).toBeNull();
    expect(back.headers()['content-type']).toBeUndefined();
  });

  test('from the keyboard: Tab reaches the trigger, Enter opens, arrows and Enter choose, Escape closes; a reload starts at the defaults', async ({
    page,
  }) => {
    await page.goto('/');
    await tile(page).focus();
    await page.keyboard.press('Tab');
    await expect(trigger(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: '7 days' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: '1 day' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: '1 day' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAccessibleName('New session options: 1 day · IP stored');
    await expect(tile(page)).toContainText('— expires 1 day after last use');

    await page.reload();
    await expect(trigger(page)).toHaveAccessibleName('New session options: 7 days · IP stored');
    await expect(tile(page)).toContainText('— your temporary endpoint, ready in a second');
  });

  test('while a creation is in flight the tile and the trigger are disabled, and a double click creates one session', async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;

    await page.route(
      (url) => url.pathname === '/api/sessions',
      async (route: Route) => {
        if (route.request().method() === 'POST') {
          posts += 1;
          await released;
        }

        await route.continue();
      },
    );
    await page.goto('/');
    await trigger(page).click();
    await page.getByRole('menuitemradio', { name: '1 hour' }).click();
    await page.keyboard.press('Escape');
    await tile(page).dblclick();
    await expect(tile(page)).toBeDisabled();
    await expect(trigger(page)).toBeDisabled();
    // Disabled, both keep the arrow (#246).
    await expect(tile(page)).toHaveCSS('cursor', 'default');
    await expect(trigger(page)).toHaveCSS('cursor', 'default');
    release();
    await sessionIdFromPage(page);
    expect(posts).toBe(1);
    await expect(
      page.getByText('SESSION EXPIRES 1 HOUR AFTER LAST USE', { exact: true }),
    ).toBeVisible();
  });

  test('the tile split, its divider and the menu as drawn at 1440 and 768 px, on the first visit and a returning visitor’s', async ({
    page,
    request,
  }) => {
    const id = await createSessionViaApi(request);

    for (const returning of [false, true]) {
      if (returning) {
        // A session in the list makes the page a returning visitor's.
        await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
          key: SESSIONS_KEY,
          value: JSON.stringify({ v: 1, items: [{ id, openedAt: Date.now() }] }),
        });
      }

      for (const width of [1440, 768]) {
        const at = `${returning ? 'returning' : 'first visit'}, ${width} px`;

        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await expect(
          returning
            ? page.getByText('1 session in this browser')
            : page.getByRole('heading', { name: 'How it works' }),
        ).toBeVisible();

        const [tileBox, triggerBox, dividerBox, valuesBox] = await Promise.all([
          tile(page).boundingBox(),
          trigger(page).boundingBox(),
          divider(page).boundingBox(),
          values(page).boundingBox(),
        ]);

        if (tileBox === null || triggerBox === null || dividerBox === null || valuesBox === null) {
          throw new Error(`${at}: the tile, the trigger or its divider is not drawn`);
        }

        // The trigger is the tile's right end, its height, inside its edge.
        expect(
          Math.abs(triggerBox.x + triggerBox.width - (tileBox.x + tileBox.width)),
          at,
        ).toBeLessThanOrEqual(1);
        expect(Math.abs(triggerBox.height - tileBox.height), at).toBeLessThanOrEqual(0.5);

        // The divider is the trigger's first 1.5 px, the tile's full height,
        // meeting the dashed border top and bottom.
        expect(Math.abs(dividerBox.x - triggerBox.x), at).toBeLessThanOrEqual(0.5);
        expect(Math.abs(dividerBox.width - 1.5), at).toBeLessThanOrEqual(0.01);
        expect(Math.abs(dividerBox.y - tileBox.y), at).toBeLessThanOrEqual(0.5);
        expect(Math.abs(dividerBox.height - tileBox.height), at).toBeLessThanOrEqual(0.5);

        // Dashed as the border is (#248): two SVG lines down the middle of
        // those 1.5 px, one from each end of the tile to its middle, each
        // starting on a whole dash, in the border's stroke, dashes and colour.
        const lines = await dividerLines(page);

        expect(lines, at).toHaveLength(2);
        for (const line of lines) {
          expect(line.x1, at).toBe(0.75);
          expect(line.x2, at).toBe(0.75);
          expect(Math.abs(line.y2 - dividerBox.height / 2), at).toBeLessThanOrEqual(0.5);
          expect(line.stroke, at).toBe(TILE_DASH);
          expect(line.strokeWidth, at).toBe('1.5px');
          expect(line.dashArray, at).toBe('6px, 4px');
          expect(line.dashArrayAttribute, at).toBe('6 4');
          expect(line.dashOffset, at).toBe('0px');
        }
        // The SVG does not clip its stroke: a clip of its 1.5 px box, snapped
        // to whole pixels, cut the line to 1 px wherever the trigger's left
        // edge fell at half a pixel or more (#248).
        await expect(divider(page).locator('svg'), at).toHaveCSS('overflow', 'visible');
        // One starts at the top, the other at the bottom, of the SVG that
        // fills the divider: the tile's full height is drawn.
        const [down, up] = lines as [DividerLine, DividerLine];

        expect(down.y1, at).toBe(0);
        expect(Math.abs(up.y1 - dividerBox.height), at).toBeLessThanOrEqual(0.5);
        // 16 px from the line to the values, and 16 px from them to the end.
        expect(
          Math.abs(valuesBox.x - (dividerBox.x + dividerBox.width) - 16),
          at,
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(tileBox.x + tileBox.width - (valuesBox.x + valuesBox.width) - 16),
          at,
        ).toBeLessThanOrEqual(0.5);

        if (width === 1440) {
          // Each part's hover ends at the line: the trigger's fills its box,
          // which starts at the divider; the tile's stops under the opaque
          // trigger.
          await trigger(page).hover();
          await expect(trigger(page), at).toHaveCSS('background-color', PICK_HOVER);
          await expect(tile(page), at).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await tile(page).hover({ position: { x: 24, y: tileBox.height / 2 } });
          await expect(tile(page), at).toHaveCSS('background-color', PICK_HOVER);
          await expect(trigger(page), at).toHaveCSS('background-color', CANVAS);
        }

        await trigger(page).click();

        const menuBox = await menu(page).boundingBox();

        if (menuBox === null) {
          throw new Error(`${at}: the menu is not drawn`);
        }

        // Under the tile, right-aligned with it, 268 px wide.
        expect(Math.round(menuBox.width), at).toBe(268);
        expect(
          Math.abs(menuBox.x + menuBox.width - (tileBox.x + tileBox.width)),
          at,
        ).toBeLessThanOrEqual(1);
        expect(Math.abs(menuBox.y - (tileBox.y + tileBox.height) - 6), at).toBeLessThanOrEqual(1);
        await page.keyboard.press('Escape');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
          at,
        ).toBe(false);
      }
    }
  });

  test('every enabled button shows the hand: the tile, the trigger and its phone line; a menu item keeps the arrow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(tile(page)).toHaveCSS('cursor', 'pointer');
    await expect(trigger(page)).toHaveCSS('cursor', 'pointer');

    // A menu item is not a button, so the base rule never reaches it: it keeps
    // the arrow by its own `cursor-default`.
    await trigger(page).click();
    await expect(page.getByRole('menuitemradio', { name: '1 hour' })).toHaveCSS(
      'cursor',
      'default',
    );
    await expect(page.getByRole('menuitemcheckbox', { name: "Store the sender's IP" })).toHaveCSS(
      'cursor',
      'default',
    );
    await page.keyboard.press('Escape');

    // The phone's line under the tile, and the tile above it.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(divider(page)).toHaveCount(0);
    await expect(trigger(page)).toHaveCSS('cursor', 'pointer');
    await expect(tile(page)).toHaveCSS('cursor', 'pointer');
  });

  test('on a phone: the line under the tile and its sheet, closed by Escape, the scrim and a swipe down; nothing sideways at 320 px', async ({
    page,
  }) => {
    const sent = watchCreations(page);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const [tileBox, triggerBox] = await Promise.all([
      tile(page).boundingBox(),
      trigger(page).boundingBox(),
    ]);

    if (tileBox === null || triggerBox === null) {
      throw new Error('375 px: the tile or the trigger is not drawn');
    }

    // Figma frame P1: a line 8 px under the whole tile, right-aligned with it.
    expect(Math.abs(triggerBox.y - (tileBox.y + tileBox.height) - 8)).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(triggerBox.x + triggerBox.width - (tileBox.x + tileBox.width)),
    ).toBeLessThanOrEqual(0.5);
    expect(Math.round(triggerBox.height)).toBe(18);
    await expect(tile(page)).toHaveAccessibleName('Generate URL');

    // Figma frame P2: the sheet; choosing does not close it.
    await trigger(page).click();

    const sheet = page.getByRole('dialog', { name: 'New session options' });

    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('radiogroup', { name: 'Expires after last use' })).toBeVisible();
    // A person taps the row: the radio itself is drawn as its row (sr-only).
    await sheet.locator('label', { hasText: '1 hour' }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('radio', { name: '1 hour' })).toBeChecked();

    const storeIp = sheet.getByRole('checkbox', { name: "Store the sender's IP" });

    await expect(storeIp).toBeChecked();
    await sheet.locator('label', { hasText: "Store the sender's IP" }).click();
    await expect(storeIp).not.toBeChecked();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAccessibleName('New session options: 1 hour · IP not stored');

    // The scrim closes it.
    await trigger(page).click();
    await expect(sheet).toBeVisible();
    // Radix listens for a tap outside from the task after it opened; a tap
    // in that first instant, which no person makes, is tried again.
    await expect(async () => {
      await page.mouse.click(187, 40);
      await expect(sheet).toBeHidden({ timeout: 500 });
    }).toPass();

    // A swipe down from the sheet's top closes it.
    await trigger(page).click();
    await expect(sheet).toBeVisible();
    await sheet.evaluate((element) => {
      const touch = (clientY: number) =>
        new Touch({ identifier: 1, target: element, clientX: 180, clientY });

      element.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          touches: [touch(560)],
          changedTouches: [touch(560)],
        }),
      );
      element.dispatchEvent(
        new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(700)] }),
      );
    });
    await expect(sheet).toBeHidden();

    // Figma frame P3: the card's marker is a line of its own below 768 px.
    await generate(page, sent);

    const marker = page.getByText('IP NOT STORED', { exact: true });
    const lineText = page.getByText('SESSION EXPIRES 1 HOUR AFTER LAST USE', { exact: false });

    await expect(marker).toBeVisible();

    const [markerBox, lineBox] = await Promise.all([marker.boundingBox(), lineText.boundingBox()]);

    if (markerBox === null || lineBox === null) {
      throw new Error('375 px: the card line is not drawn');
    }

    expect(Math.abs(markerBox.x - lineBox.x)).toBeLessThanOrEqual(0.5);
    expect(markerBox.y).toBeGreaterThan(lineBox.y + 5);

    // Figma frame P5: the longest values, in Russian, at 320 px.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/ru/');

    const russian = page.getByRole('button', { name: /^Параметры новой сессии/ });

    await russian.click();

    const sheetRu = page.getByRole('dialog', { name: 'Параметры новой сессии' });

    await sheetRu.locator('label', { hasText: /^1\sчас$/ }).click();
    await expect(sheetRu.getByRole('radio', { name: `1${NBSP}час` })).toBeChecked();
    await sheetRu.locator('label', { hasText: 'Сохранять IP отправителя' }).click();
    await expect(
      sheetRu.getByRole('checkbox', { name: 'Сохранять IP отправителя' }),
    ).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(russian).toHaveAccessibleName(
      `Параметры новой сессии: 1${NBSP}час · IP не сохраняется`,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
  });

  test('a session answer outside the contract leaves today’s line and no error', async ({
    page,
    request,
  }) => {
    const uncaught = watchUncaught(page);
    const sessionId = await createSessionViaApi(request);
    const deep = `${'['.repeat(10_000)}${']'.repeat(10_000)}`;
    const raw: [string, string][] = [
      ['absent', ''],
      ['null', 'null'],
      ['empty', '""'],
      ['a string number', '"3600"'],
      ['a negative', '-3600'],
      ['1e400', '1e400'],
      ['an object', '{"seconds":3600}'],
      ['an array 10,000 deep', deep],
      ['a megabyte string', JSON.stringify('9'.repeat(1_000_000))],
    ];

    let value = '';

    await page.route(
      (url) => url.pathname === `/api/sessions/${sessionId}`,
      async (route) => {
        const original = await route.fetch();
        const body = (await original.json()) as Record<string, unknown>;

        delete body.expiresAfterIdleSeconds;
        delete body.lifetimeEndsAt;
        delete body.storeSourceIp;

        const fields =
          value === ''
            ? ''
            : `,"expiresAfterIdleSeconds":${value},"lifetimeEndsAt":${value},"storeSourceIp":${value}`;

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: `${JSON.stringify(body).slice(0, -1)}${fields}}`,
        });
      },
    );

    for (const [name, text] of raw) {
      value = text;
      await page.goto(`/v/${sessionId}`);
      await expect(page.getByText(TODAY, { exact: true }), name).toBeVisible();
      await expect(page.getByText('IP NOT STORED'), name).toHaveCount(0);
      // Leaves the page before the next answer changes under its reads.
      await page.goto('about:blank');
    }

    expect(uncaught).toEqual([]);
  });

  test('an open tab reads its session every 10 minutes, hidden or refused, and a 410 to that read shows Session not found', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);
    const reads: string[] = [];
    let answer: ((route: Route) => Promise<void>) | null = null;

    page.on('request', (sent) => {
      if (
        sent.method() === 'GET' &&
        new URL(sent.url()).pathname === `/api/sessions/${sessionId}`
      ) {
        reads.push(sent.url());
      }
    });
    await page.route(
      (url) => url.pathname === `/api/sessions/${sessionId}`,
      async (route) => {
        if (answer === null) {
          await route.continue();
        } else {
          await answer(route);
        }
      },
    );

    const sockets: unknown[] = [];

    page.on('websocket', (socket) => sockets.push(socket));

    const frames = collectRealtimeFrames(page);

    await page.clock.install();
    await page.goto(`/v/${sessionId}`);
    await expect(page.getByText(TODAY, { exact: true })).toBeVisible();
    await expect.poll(() => frames.some((frame) => frame.includes('"type":"ready"'))).toBe(true);

    // The load's reads and the connection's, however many the dev build's
    // strict mode makes, are over once the count holds still.
    let settled = -1;

    await expect
      .poll(
        () => {
          const now = reads.length;
          const still = now === settled;

          settled = now;

          return still;
        },
        { intervals: [500] },
      )
      .toBe(true);

    const loaded = reads.length;
    const connections = sockets.length;

    // A quiet tab: one read every 10 minutes, on no new connection.
    await page.clock.runFor(TEN_MINUTES);
    await expect.poll(() => reads.length).toBe(loaded + 1);
    await page.clock.runFor(TEN_MINUTES);
    await expect.poll(() => reads.length).toBe(loaded + 2);

    // Hidden: still a use.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(TEN_MINUTES);
    await expect.poll(() => reads.length).toBe(loaded + 3);
    expect(sockets).toHaveLength(connections);

    // Refused with 429: the page stays as it is.
    answer = (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'Retry-After': '30' },
        body: JSON.stringify({ errorCode: 1015, message: 'Too many requests' }),
      });
    await page.clock.runFor(TEN_MINUTES);
    await expect.poll(() => reads.length).toBe(loaded + 4);
    await expect(page.getByText(TODAY, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Session not found' })).toHaveCount(0);

    // A 410 to the timer's read takes the page over, as a reconnect's does.
    answer = (route) =>
      route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 1002, message: 'Session expired' }),
      });

    const before = reads.length;

    await page.clock.runFor(TEN_MINUTES);
    await expect.poll(() => reads.length).toBe(before + 1);
    await expect(page.getByRole('heading', { name: 'Session not found', level: 1 })).toBeVisible();
    // The timer's read, not a reconnection's: no socket opened since the load.
    expect(sockets).toHaveLength(connections);
  });

  test('an open tab that goes offline keeps its session on screen through the 10-minute read', async ({
    page,
    request,
    context,
  }) => {
    const uncaught = watchUncaught(page);
    const sessionId = await createSessionViaApi(request);

    await page.clock.install();
    await page.goto(`/v/${sessionId}`);
    await expect(page.getByText(TODAY, { exact: true })).toBeVisible();
    await context.setOffline(true);
    await page.clock.runFor(TEN_MINUTES);
    await page.clock.runFor(TEN_MINUTES);
    await expect(page.getByText(TODAY, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Session not found' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
    await context.setOffline(false);
    expect(uncaught).toEqual([]);
  });
});
