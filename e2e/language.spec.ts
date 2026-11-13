import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { REQUEST_ID_DISPLAY_LENGTH } from '@webhook-inspector/shared';
import { en } from '../apps/frontend/src/i18n/en.ts';
import { LATIN_IN_RUSSIAN } from '../apps/frontend/src/i18n/latin.ts';
import { ru } from '../apps/frontend/src/i18n/ru.ts';
import { CONTACT_ADDRESS } from '../apps/frontend/src/lib/contact.ts';
import { TYPING_PAUSE_MS } from '../apps/frontend/src/lib/raw-search.ts';
import { REMOVE_SETTLE_MS } from '../apps/frontend/src/lib/response-queue.ts';
import { createSessionViaApi, receiveUrlOf, requestRow, storedRequestId } from './helpers.ts';

/**
 * E2E-17 — the Russian interface and its `EN | RU` switch (issue #108, D222;
 * Figma page `Webhook Inspector · Language switch (#108)`, direction A).
 *
 * A browser asking for Russian first sees Russian from the first render, with
 * `<html lang="ru">` and no English drawn before it; one asking for neither
 * language sees English. The switch changes the language at once - no reload,
 * no API call, no new address - keeping the open request, its tab, the filter
 * and the quick switch, whose failures it says again in the new language; the
 * choice survives a reload and a new tab, and a stored value this version did
 * not write counts as no choice, with no page error. Every screen reads in
 * Russian with no Latin word but those that stay English, captured data aside.
 * The switch is in the header from 768 px and in the footer band below, both
 * its buttons showing the hand as links do (issue #246), and nothing scrolls
 * sideways at 320 px.
 */

const NBSP = ' ';

/**
 * The Latin words the Russian interface keeps (Decision 7): the dictionary's,
 * the one list `i18n.test.ts` holds the dictionary to, and what the screens
 * draw outside it - the methods this spec sends, the reason phrases of the
 * statuses it configures, the algorithms the signature check names and the
 * switch's `EN`, `English` and `RU`; and the methods the response rules'
 * chips offer, `PATCH` and `DELETE` among them (#226).
 */
const LATIN_KEPT = new Set([
  ...LATIN_IN_RUSSIAN,
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'Created',
  'Service',
  'Unavailable',
  'SHA',
  'EN',
  'English',
  'RU',
]);

/**
 * Where captured data is drawn - the receive URL, addresses, the request's
 * target and facts, code boxes, multipart parts, the comparison's lines, the
 * computed signature, the home page's URLs, a select's options and the
 * not-found screens' stylised exchange - left out of the scan: it is the
 * sender's, not the interface's. A session row's link, `a[href^="/v/"]`,
 * holds its URL alone: the count and time under it lie outside the link and
 * are read. Fields are read like any other element:
 * their names, titles and placeholders are the interface's. What is typed in
 * them is not: an input's is a value, never a text node, and a text area's
 * text is skipped (`latinWords`).
 */
const CAPTURED = [
  '[data-testid="receive-url"]',
  '[data-testid="row-address"]',
  '[data-testid="detail-target"]',
  '[data-testid="request-facts"]',
  '[data-testid="block-content"]',
  '[data-testid="body-parts"]',
  '[data-testid="diff-box"]',
  '[data-testid="signature-computed"]',
  '[data-testid="rule-path-prefix"]',
  'a[href^="/v/"]',
  'a[href^="mailto:"]',
  'noscript',
  'script',
  'style',
  'pre',
  'option',
].join(', ');

/**
 * Every Latin word the page shows or says - text drawn on screen, and the
 * names, titles and placeholders assistive technology reads - outside
 * captured data, with the session's and the requests' ids taken out first.
 */
async function latinWords(page: Page, ids: readonly string[]): Promise<string[]> {
  const said = await page.evaluate((captured) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const element = node as HTMLElement;

      if (element.closest(captured) !== null) {
        continue;
      }

      const style = getComputedStyle(element);
      const shown = style.display !== 'none' && style.visibility !== 'hidden';

      for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = element.getAttribute(name);

        if (value !== null && shown) {
          out.push(value);
        }
      }

      // A text area's text is what was typed in it, not the interface's.
      if (element.tagName === 'TEXTAREA') {
        continue;
      }

      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && shown) {
          out.push(child.textContent ?? '');
        }
      }
    }

    return out;
  }, CAPTURED);
  let text = said.join('\n');

  for (const id of ids) {
    text = text.replaceAll(id, ' ').replaceAll(id.slice(0, REQUEST_ID_DISPLAY_LENGTH), ' ');
  }

  return [...new Set(text.match(/[A-Za-z]+/g) ?? [])];
}

/** The screen reads in Russian: no Latin word but the kept ones. */
async function expectRussian(page: Page, ids: readonly string[], screen: string): Promise<void> {
  const foreign = (await latinWords(page, ids)).filter((word) => !LATIN_KEPT.has(word));

  expect(foreign, `${screen}: English left in the Russian interface`).toEqual([]);
}

async function noSidewaysScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

/** A JSON webhook, a form and a GET with a query: the shapes the panel draws. */
async function sendRequests(request: APIRequestContext, sessionId: string): Promise<string[]> {
  const receiveUrl = await receiveUrlOf(request, sessionId);
  const json = await request.post(`${receiveUrl}/hooks/github?attempt=1`, {
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' },
    data: '{"ref":"refs/heads/main","amount":4200}',
  });
  const form = await request.post(`${receiveUrl}/form`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: 'name=Ann&city=Moscow',
  });
  const get = await request.get(`${receiveUrl}/ping?x=1&y=2`);

  for (const sent of [json, form, get]) {
    expect(sent.status()).toBeLessThan(600);
  }

  return [storedRequestId(json), storedRequestId(form), storedRequestId(get)];
}

/**
 * A custom response, a queue of two steps and a response rule, so the
 * switch, the editor, the queue and the rules have words to say. The rule's
 * path holds no letter: it is the user's, drawn as typed (#226).
 */
async function configureResponses(request: APIRequestContext, sessionId: string): Promise<void> {
  const custom = await request.put(`/api/sessions/${sessionId}/response`, {
    data: { mode: 'custom', response: { status: 201, delayMs: 0 } },
  });

  expect(custom.status()).toBe(200);

  const queue = await request.put(`/api/sessions/${sessionId}/queue`, {
    data: { steps: [{ status: 503, delayMs: 2000 }, { status: 200 }] },
  });

  expect(queue.status()).toBe(200);

  const rules = await request.put(`/api/sessions/${sessionId}/rules`, {
    data: { rules: [{ method: 'GET', path: '/42', response: { status: 201 } }] },
  });

  expect(rules.status()).toBe(200);
}

const switchGroup = (page: Page, name: string) => page.getByRole('group', { name, exact: true });

test.describe('E2E-17 — a browser that asks for Russian', () => {
  test.use({ locale: 'ru-RU' });

  test('sees Russian from the first render, with <html lang="ru">, the switch in the header and the band on one line', async ({
    page,
  }) => {
    const errors: string[] = [];

    page.on('pageerror', (error) => errors.push(error.message));
    // Every text the application root holds as it is built, and the page's
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

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ru.landing.heading);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    // The home page's title in Russian, that of the Russian home page's head
    // (D226); every other screen has `ru.title.base`.
    await expect(page).toHaveTitle(ru.title.home);

    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);

    expect(seen.length).toBeGreaterThan(0);

    for (const snapshot of seen) {
      expect(snapshot.startsWith('ru|'), snapshot.slice(0, 60)).toBe(true);
      expect(snapshot).not.toContain(en.landing.heading);
      expect(snapshot).not.toContain(en.landing.generate);
      expect(snapshot).not.toContain(en.footer.about);
    }

    // The header: Изменения | Статус ↗ | API docs ↗ | EN | RU, RU the current one.
    const banner = page.getByRole('banner');

    await expect(banner.getByRole('link', { name: 'Изменения', exact: true })).toBeVisible();
    await expect(
      banner.getByRole('link', { name: `Статус ${ru.header.newTab}`, exact: true }),
    ).toBeVisible();
    await expect(
      banner.getByRole('link', { name: `API docs ${ru.header.newTab}`, exact: true }),
    ).toBeVisible();

    const language = switchGroup(page, ru.language.label);

    await expect(language.getByRole('button', { name: 'RU Русский' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(language.getByRole('button', { name: 'EN English' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // Both show the hand, the current one too, as the links beside them do (#246).
    await expect(banner.getByRole('link', { name: 'Изменения', exact: true })).toHaveCSS(
      'cursor',
      'pointer',
    );

    for (const name of ['RU Русский', 'EN English']) {
      await expect(language.getByRole('button', { name }), name).toHaveCSS('cursor', 'pointer');
    }

    // The band: the shorter Russian line and the Russian links, one 34 px line
    // at 1440 px (frame A-R1 of the Figma page `Webhook Inspector · Language
    // switch (#108)`).
    const footer = page.getByRole('contentinfo');

    expect(await footer.evaluate((element) => element.textContent)).toBe(
      `${ru.footer.line} ${ru.footer.about} · ${ru.footer.terms} · ${ru.footer.privacy} · ${ru.footer.contact}${NBSP}${CONTACT_ADDRESS}`,
    );
    expect(await footer.evaluate((element) => element.getBoundingClientRect().height)).toBe(34);

    // The first visit, read whole.
    await expectRussian(page, [], 'the home page, first visit');
    expect(errors).toEqual([]);
  });

  test('switches at once, with no reload, API call or new address, keeping the open request, its tab, the filter and the quick switch', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);
    const [first] = await sendRequests(request, sessionId);

    await page.goto(`/v/${sessionId}`);
    await requestRow(page, first as string).click();
    await page.getByRole('tab', { name: 'Body', exact: true }).first().click();
    await page.getByRole('button', { name: ru.list.filterLabel }).click();

    // The filter searches the raw requests a typing pause after the last
    // keystroke: that search is the filter's, answered before the switch is
    // watched, so it cannot be taken for a call the switch made.
    const searched = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/sessions/${sessionId}/requests/search`,
    );

    await page.getByRole('searchbox', { name: ru.list.filterLabel }).fill('POST');
    await searched;
    await page.getByRole('button', { name: /^По умолчанию · 200/ }).click();
    await expect(page.getByRole('dialog', { name: ru.quick.title })).toBeVisible();

    const address = page.url();
    const calls: string[] = [];

    await page.evaluate(() => {
      (window as unknown as { __kept: boolean }).__kept = true;
    });
    page.on('request', (call) => {
      if (new URL(call.url()).pathname.startsWith('/api/')) {
        calls.push(`${call.method()} ${call.url()}`);
      }
    });

    await switchGroup(page, ru.language.label).getByRole('button', { name: 'EN English' }).click();

    // English at once: the header, the open quick switch, the list, the tab.
    await expect(page.getByRole('dialog', { name: en.quick.title })).toBeVisible();
    await expect(page.getByRole('link', { name: en.header.changelog, exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // The unread count stays, before the English title.
    await expect(page).toHaveTitle(/^\(\d+\) Webhook Inspector$/);
    await expect(page.getByRole('searchbox', { name: en.list.filterLabel })).toHaveValue('POST');
    await expect(page.getByRole('tab', { name: 'Body', exact: true }).first()).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('detail-method')).toHaveText('POST');
    await expect(
      switchGroup(page, en.language.label).getByRole('button', { name: 'EN English' }),
    ).toHaveAttribute('aria-pressed', 'true');

    // And back.
    await switchGroup(page, en.language.label).getByRole('button', { name: 'RU Русский' }).click();
    await expect(page.getByRole('dialog', { name: ru.quick.title })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: ru.list.filterLabel })).toHaveValue('POST');

    // Still watched for longer than a typing pause after the last click: a
    // search the switch planned would have been sent by now.
    await page.waitForTimeout(TYPING_PAUSE_MS + 400);

    expect(page.url()).toBe(address);
    expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(
      true,
    );
    expect(calls, 'the switch called the API').toEqual([]);
  });

  test('says a failure in the open quick switch in the language shown, after a switch too: Apply, Run again and Remove', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);
    const receiveUrl = await receiveUrlOf(request, sessionId);
    const custom = await request.put(`/api/sessions/${sessionId}/response`, {
      data: { mode: 'custom', response: { status: 201, delayMs: 0 } },
    });

    expect(custom.status()).toBe(200);

    // A one-step queue the first request uses up, so the section offers Run again.
    const queue = await request.put(`/api/sessions/${sessionId}/queue`, {
      data: { steps: [{ status: 503 }] },
    });

    expect(queue.status()).toBe(200);
    expect((await request.post(`${receiveUrl}/used-up`)).status()).toBe(503);

    // The page's change, restart and removal fail: the change refused with
    // the server's own message (1005), the other two as a server fault.
    const refusal = 'response.status must be an integer between 100 and 599';
    const fault = {
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ errorCode: 1500, message: 'Internal server error' }),
    };

    await page.route(`**/api/sessions/${sessionId}/response`, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ errorCode: 1005, message: refusal }),
          })
        : route.fallback(),
    );
    await page.route(`**/api/sessions/${sessionId}/queue/restart`, (route) => route.fulfill(fault));
    await page.route(`**/api/sessions/${sessionId}/queue`, (route) =>
      route.request().method() === 'DELETE' ? route.fulfill(fault) : route.fallback(),
    );

    await page.goto(`/v/${sessionId}`);
    await page.getByRole('button', { name: /^Свой · 201/ }).click();

    // The one dialog open, whatever language names it.
    const quick = page.getByRole('dialog');

    await expect(quick).toHaveAccessibleName(ru.quick.title);

    const toEnglish = () =>
      switchGroup(page, ru.language.label).getByRole('button', { name: 'EN English' }).click();
    const toRussian = () =>
      switchGroup(page, en.language.label).getByRole('button', { name: 'RU Русский' }).click();

    // Apply, refused: the title and the lead-in follow the switch, the
    // server's message stays as it came.
    await quick.getByRole('button', { name: '500', exact: true }).click();
    await quick.getByRole('button', { name: ru.quick.apply, exact: true }).click();

    const applyFailure = quick.getByRole('alert').filter({ hasText: refusal });

    await expect(applyFailure).toHaveText(`${ru.editor.applyFailed}${ru.editor.rejected(refusal)}`);
    await toEnglish();
    await expect(quick).toHaveAccessibleName(en.quick.title);
    await expect(applyFailure).toHaveText(`${en.editor.applyFailed}${en.editor.rejected(refusal)}`);
    await expect(quick.getByRole('button', { name: en.queue.tryAgain, exact: true })).toBeVisible();
    await toRussian();
    await expect(applyFailure).toHaveText(`${ru.editor.applyFailed}${ru.editor.rejected(refusal)}`);

    // Run again, failed, said under the section's links.
    const toggle = quick.getByRole('button', { name: new RegExp(`^${ru.queue.title}`) });

    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }

    await quick.getByRole('button', { name: ru.queue.runAgain, exact: true }).click();
    await expect(quick.getByText(ru.queue.restartFailed, { exact: true })).toBeVisible();
    await toEnglish();
    await expect(quick.getByText(en.queue.restartFailed, { exact: true })).toBeVisible();
    await expect(quick.getByText(ru.queue.restartFailed, { exact: true })).toHaveCount(0);
    await toRussian();
    await expect(quick.getByText(ru.queue.restartFailed, { exact: true })).toBeVisible();

    // Remove, failed, said in place of the question with Try again.
    await quick.getByRole('button', { name: ru.queue.removeQueue, exact: true }).click();
    await expect(quick.getByText(ru.queue.removeShort(1), { exact: true })).toBeVisible();
    // A click on Remove too soon after the question is set aside (D206).
    await page.waitForTimeout(REMOVE_SETTLE_MS + 100);
    await quick.getByRole('button', { name: ru.queue.remove, exact: true }).click();
    await expect(quick.getByText(ru.queue.removeFailed, { exact: true })).toBeVisible();
    await toEnglish();
    await expect(quick.getByText(en.queue.removeFailed, { exact: true })).toBeVisible();
    await expect(quick.getByText(ru.queue.removeFailed, { exact: true })).toHaveCount(0);
    await expect(quick.getByRole('button', { name: en.queue.keep, exact: true })).toBeVisible();
    await toRussian();
    await expect(quick.getByText(ru.queue.removeFailed, { exact: true })).toBeVisible();
    await expect(quick.getByText(en.queue.removeFailed, { exact: true })).toHaveCount(0);
  });

  test('keeps the choice across a reload and a new tab, and reads a stored value it did not write as no choice', async ({
    page,
    context,
  }) => {
    const errors: string[] = [];

    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ru.landing.heading);
    await switchGroup(page, ru.language.label).getByRole('button', { name: 'EN English' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.landing.heading);
    expect(await page.evaluate(() => localStorage.getItem('qa-tools:language'))).toBe(
      '{"v":1,"lang":"en"}',
    );

    // The choice wins over the browser's Russian, after a reload and in a new tab.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.landing.heading);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const second = await context.newPage();

    second.on('pageerror', (error) => errors.push(error.message));
    await second.goto('/');
    await expect(second.getByRole('heading', { level: 1 })).toHaveText(en.landing.heading);
    await second.close();

    for (const stored of [
      'xx',
      '',
      '__proto__',
      'constructor',
      'toString',
      '{"v":1,"lang":"de"}',
      '{"v":2,"lang":"en"}',
      '{"__proto__":{"v":1,"lang":"en"}}',
      '{"v":1,"lang":"en"',
      'e'.repeat(1024 * 1024),
    ]) {
      await page.evaluate((value) => localStorage.setItem('qa-tools:language', value), stored);
      await page.reload();
      await expect(
        page.getByRole('heading', { level: 1 }),
        `stored ${stored.slice(0, 30)}`,
      ).toHaveText(ru.landing.heading);
    }

    expect(errors).toEqual([]);
  });

  test('reads every screen in Russian: no Latin word but those that stay English, captured data aside', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);

    const sessionId = await createSessionViaApi(request);

    await configureResponses(request, sessionId);

    const requestIds = await sendRequests(request, sessionId);
    const ids = [sessionId, ...requestIds];

    // The session page: the list, then each tab of both halves.
    await page.goto(`/v/${sessionId}`);
    await expect(page.getByRole('heading', { name: ru.list.heading })).toBeAttached();
    await expect(page.getByText(sessionRetention())).toBeVisible();
    await expectRussian(page, ids, 'the session page');

    await requestRow(page, requestIds[0] as string).click();
    await expect(page.getByTestId('detail-method')).toHaveText('POST');

    for (const tab of ['Raw', 'Body', 'Headers', 'Query']) {
      await page.getByRole('tab', { name: tab, exact: true }).first().click();
      await expectRussian(page, ids, `Request ${tab}`);
    }

    await page.getByRole('tab', { name: 'Response', exact: true }).click();

    for (const tab of ['Body', 'Raw', 'Headers']) {
      await page.getByRole('tab', { name: tab, exact: true }).last().click();
      await expectRussian(page, ids, `Response ${tab}`);
    }

    // The request actions, and Check signature.
    await page.getByRole('button', { name: ru.actions.menu, exact: true }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expectRussian(page, ids, 'Actions');
    await page.getByRole('menuitem', { name: ru.actions.checkSignature }).click();
    await expect(page.getByRole('heading', { name: ru.signature.title })).toBeVisible();
    await page.getByPlaceholder(ru.signature.secretPlaceholder).fill('test-secret');
    await expect(page.getByTestId('signature-result')).toContainText(ru.signature.noMatch);
    // The header the check names is the sender's.
    await expectRussian(page, [...ids, 'x-hub-signature-256'], 'Check signature');
    await page.keyboard.press('Escape');

    // Compare with another request.
    await page.getByRole('button', { name: ru.actions.menu, exact: true }).click();
    await page.getByRole('menuitem', { name: ru.actions.compare }).click();
    await expect(page.getByTestId('list-picking')).toContainText(ru.list.compareWith);
    await expectRussian(page, ids, 'picking');
    await requestRow(page, requestIds[1] as string).click();
    await expect(page.getByTestId('compare-view')).toContainText(ru.compare.comparing);
    await expectRussian(page, ids, 'the comparison');
    await page.getByRole('button', { name: ru.compare.closeComparison }).click();

    // The quick switch with its queue section, the editor and the queue dialog.
    await page.getByRole('button', { name: /^Свой · 201/ }).click();
    await expect(page.getByRole('dialog', { name: ru.quick.title })).toBeVisible();
    await expectRussian(page, ids, 'the quick switch');
    await page.getByRole('button', { name: ru.quick.editHeadersAndBody }).click();
    await expect(page.getByRole('dialog', { name: ru.editor.title })).toBeVisible();
    await page.getByRole('button', { name: ru.fields.addHeader }).click();
    await page.getByRole('textbox', { name: ru.fields.headerField(1, 'name') }).fill('bad name');
    await expectRussian(page, ids, 'the response editor');
    await page.getByRole('button', { name: ru.common.cancel }).click();
    await page.getByRole('button', { name: /^Свой · 201/ }).click();
    // The queue's section opens collapsed the first time (D206).
    await page.getByRole('button', { name: new RegExp(`^${ru.queue.title}`) }).click();
    await expect(page.getByRole('button', { name: ru.queue.edit })).toBeVisible();
    await expectRussian(page, ids, 'the queue section');
    await page.getByRole('button', { name: ru.queue.edit }).click();
    await expect(page.getByRole('dialog', { name: ru.queue.title })).toBeVisible();
    await expectRussian(page, ids, 'the response queue');
    await page.getByRole('button', { name: ru.common.cancel }).click();

    // The rules' section, collapsed the first time, the dialog, and the tag
    // of a request a rule answered (#226).
    await page.getByRole('button', { name: /^Свой · 201/ }).click();
    await page.getByRole('button', { name: new RegExp(`^${ru.rules.title}`) }).click();
    await expect(page.getByRole('button', { name: ru.rules.edit })).toBeVisible();
    await expectRussian(page, ids, 'the rules section');
    await page.getByRole('button', { name: ru.rules.edit }).click();
    await expect(page.getByRole('dialog', { name: ru.rules.title })).toBeVisible();
    await expect(page.getByText(ru.rules.checked(1), { exact: true })).toBeVisible();
    await expectRussian(page, ids, 'the response rules');
    await page.getByRole('button', { name: ru.common.cancel }).click();

    const ruled = await request.get(`${await receiveUrlOf(request, sessionId)}/42`);

    expect(ruled.status()).toBe(201);
    // Its id is drawn in the list from now on, on every screen after this one.
    ids.push(storedRequestId(ruled));

    // Its row marks the rule, `П1`, titled and named in Russian (#233).
    const ruledRow = requestRow(page, storedRequestId(ruled));

    await expect(ruledRow.getByTestId('row-rule')).toHaveText(ru.list.ruleMarker(1));
    await expect(ruledRow.getByTestId('row-rule')).toHaveText('П1');
    await expect(ruledRow.getByTestId('row-rule')).toHaveAttribute('title', 'Ответило правило 1');
    await expect(ruledRow).toHaveAccessibleName(/Ответило правило 1(?!\d)/);
    await expect(ruledRow).not.toHaveAccessibleName(/П1/);
    await expectRussian(page, ids, 'a rule’s marker');
    await ruledRow.click();
    await page.getByRole('tab', { name: 'Response', exact: true }).click();
    await expect(page.getByTestId('response-rule')).toHaveText('Правило 1 · GET /42');
    await expectRussian(page, ids, 'a rule’s tag');

    // Delete all, and a filter that matches nothing.
    await page.getByRole('button', { name: ru.deleteAll.button }).click();
    await expect(page.getByRole('dialog', { name: ru.deleteAll.title })).toBeVisible();
    await expectRussian(page, ids, 'Delete all');
    await page.getByRole('button', { name: ru.common.cancel }).click();
    await page.getByRole('button', { name: ru.list.filterLabel }).click();
    await page.getByRole('searchbox', { name: ru.list.filterLabel }).fill('zzzz-nothing');
    await expect(page.getByText(ru.list.noMatch('zzzz-nothing'))).toBeVisible();
    await expectRussian(page, [...ids, 'zzzz', 'nothing'], 'no match');
    await page.getByRole('button', { name: ru.list.clearFilter }).last().click();

    // A phone: the Back bar, the sheet, and the switch in the band.
    // The open request covers the list there, under the Back bar.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('button', { name: /^Назад к запросам/ })).toBeVisible();
    await expectRussian(page, ids, 'a request on a phone');
    await page.getByRole('button', { name: ru.actions.title }).click();
    await expect(page.getByRole('dialog', { name: ru.actions.title })).toBeVisible();
    await expectRussian(page, ids, 'the request actions sheet');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Назад к запросам/ }).click();
    await expect(requestRow(page, requestIds[2] as string)).toBeVisible();
    await expectRussian(page, ids, 'the list on a phone');
    await page.setViewportSize({ width: 1440, height: 1024 });

    // The home page as a returning visitor sees it, with a row's ⋯ and the deletion's question.
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: ru.sessions.actions(sessionId.slice(0, 7)) }),
    ).toBeVisible();
    await expectRussian(page, ids, 'the home page, returning');
    await page.getByRole('button', { name: ru.sessions.actions(sessionId.slice(0, 7)) }).click();
    await page.getByRole('menuitem', { name: ru.sessions.deleteSession }).click();
    await expect(page.getByRole('dialog', { name: ru.home.deleteTitle })).toBeVisible();
    await expectRussian(page, ids, 'Delete session');
    await page.getByRole('button', { name: ru.common.cancel }).click();

    // Both not-found screens.
    await page.goto('/nowhere');
    await expect(page.getByRole('heading', { name: ru.notFound.pageTitle })).toBeVisible();
    await expectRussian(page, ids, 'Page not found');
    await page.goto(`/v/${'A'.repeat(43)}`);
    await expect(page.getByRole('heading', { name: ru.notFound.sessionTitle })).toBeVisible();
    await expect(page.locator('main pre')).toContainText(ru.notFound.sessionAnswer);
    await expectRussian(page, [...ids, 'A'.repeat(43)], 'Session not found');
  });

  test('fits the session page in Russian at 1440, 768, 375 and 320 px: nothing clipped, nothing sideways', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);

    await sendRequests(request, sessionId);

    for (const { width, height } of [
      { width: 1440, height: 1024 },
      { width: 768, height: 1024 },
      { width: 375, height: 812 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(`/v/${sessionId}`);
      await expect(page.getByText(ru.endpoint.receiveUrl, { exact: true })).toBeVisible();
      await expect(page.getByText(sessionRetention(), { exact: true })).toBeVisible();

      // The card's two caption lines, the list's header and the band: each
      // inside its box, and the page no wider than the window.
      const clipped = await page.evaluate(
        ({ captions }) => {
          const wider = (element: Element | null) =>
            element !== null && element.scrollWidth > element.clientWidth + 1;
          const caption = Array.from(document.querySelectorAll('p')).filter((p) =>
            captions.includes(p.textContent ?? ''),
          );
          const list = document.querySelector('section');
          const listHeader = list?.firstElementChild ?? null;

          return {
            captions: caption.length,
            captionClipped: caption.some(
              (p) => p.getBoundingClientRect().right > window.innerWidth || wider(p),
            ),
            listHeaderClipped:
              listHeader !== null &&
              Array.from(listHeader.querySelectorAll('h2, p, button')).some(
                (element) =>
                  getComputedStyle(element).position !== 'absolute' &&
                  element.getBoundingClientRect().right >
                    (list as Element).getBoundingClientRect().right + 0.5,
              ),
            sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        },
        { captions: [ru.endpoint.receiveUrl, sessionRetention()] },
      );

      expect(clipped, `${width} px`).toEqual({
        captions: 2,
        captionClipped: false,
        listHeaderClipped: false,
        sideways: false,
      });
    }
  });

  test('puts the switch in the header from 768 px and in the band below, with nothing sideways at 320 px', async ({
    page,
  }) => {
    // `bandHeight`: the Russian band's height with the switch in it, 102 px at
    // 375 px and 119 at 320 (D222). Measured on 2026-10-25 with the words of
    // 1.15.16 (D265), it is 102 from 498 down to 359 px and 119 from 358 to
    // 303, so each is at least 16 px from the width where it changes; 360 px,
    // 102 px but closer than 9 px to that width, is held only to fitting
    // (on 2026-10-10 the change was at 341 px, and 360 px was held to 102).
    for (const { width, height, inHeader, bandHeight } of [
      { width: 1440, height: 1024, inHeader: true },
      { width: 768, height: 1024, inHeader: true },
      { width: 375, height: 812, inHeader: false, bandHeight: 102 },
      { width: 360, height: 700, inHeader: false, bandHeight: null },
      { width: 320, height: 700, inHeader: false, bandHeight: 119 },
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto('/');

      const header = page.getByRole('banner').getByTestId('language-switch');
      const footer = page.getByRole('contentinfo').getByTestId('language-switch');

      await expect(header, `${width} px`).toHaveCount(inHeader ? 1 : 0);
      await expect(footer, `${width} px`).toHaveCount(inHeader ? 0 : 1);
      expect(await noSidewaysScroll(page), `${width} px scrolls sideways`).toBe(true);

      if (inHeader) {
        // After API docs ↗ and a 1 × 16 divider, 16 px apart, RU in ink.
        const row = await header.evaluate((group) => {
          const divider = group.previousElementSibling as HTMLElement;
          const apiDocs = divider.previousElementSibling as HTMLElement;

          return {
            divider: divider.getBoundingClientRect().toJSON() as DOMRect,
            apiDocs: apiDocs.getBoundingClientRect().toJSON() as DOMRect,
            group: group.getBoundingClientRect().toJSON() as DOMRect,
            weights: Array.from(
              group.querySelectorAll('button'),
              (button) => getComputedStyle(button).fontWeight,
            ),
          };
        });

        expect(row.divider.width).toBe(1);
        expect(row.divider.height).toBe(16);
        expect(row.divider.left - row.apiDocs.right).toBeCloseTo(16, 0);
        expect(row.group.left - row.divider.right).toBeCloseTo(16, 0);
        expect(row.group.right).toBeLessThanOrEqual(width);
        expect(row.weights).toEqual(['500', '600']);
      } else {
        // Before the contact, after Конфиденциальность ·, kept whole.
        const text = await page.getByRole('contentinfo').evaluate((band) => band.textContent ?? '');

        if (bandHeight !== null) {
          expect(
            await page
              .getByRole('contentinfo')
              .evaluate((element) => element.getBoundingClientRect().height),
            `${width} px, the band`,
          ).toBe(bandHeight);
        }

        expect(text).toContain(
          `${ru.footer.privacy} · EN English|RU Русский · ${ru.footer.contact}${NBSP}${CONTACT_ADDRESS}`,
        );
        // The header stays as it was: no switch, three links.
        await expect(page.getByRole('banner').getByRole('link')).toHaveCount(4);
        await footer.getByRole('button', { name: 'EN English' }).click();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.landing.heading);
        await page.getByRole('contentinfo').getByRole('button', { name: 'RU Русский' }).click();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(ru.landing.heading);
      }
    }
  });
});

test.describe('E2E-17 — a browser that asks for neither language', () => {
  test.use({ locale: 'de-DE' });

  test('sees the English interface, unchanged, until it chooses Russian', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.landing.heading);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // The home page's own title, the service's and the platform's (D226, D277).
    await expect(page).toHaveTitle(en.title.home);
    await expect(
      switchGroup(page, en.language.label).getByRole('button', { name: 'EN English' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await switchGroup(page, en.language.label).getByRole('button', { name: 'RU Русский' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ru.landing.heading);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ru.landing.heading);
  });
});

/** The endpoint card's retention line in Russian, as the page writes it. */
function sessionRetention(): string {
  return ru.lifetime.retention(7);
}
