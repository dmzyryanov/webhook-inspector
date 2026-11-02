import { expect, test, type Page, type Request } from '@playwright/test';
import { createSessionViaApi, receiveUrlOf } from './helpers.ts';

/**
 * E2E-13 — the home page's list of the sessions used in this browser (issue
 * #92, D199; Figma page `Webhook Inspector · My sessions`, G3′ and F).
 *
 * The list's rules - joining, the cap, leaving, storage that cannot be used -
 * and every string are unit-tested (`session-list.test.ts`,
 * `home-view.test.ts`), and the status read against the database
 * (`session-status.test.ts`); here it is the page a tester walks through: the
 * first visit, a session created and one opened by link joining the list, the
 * status read carrying the ids in its body only, a copy, a row opening its
 * session, a removal surviving a reload, a deletion asked, cancelled and made,
 * the cut after five and `Show all`, an unknown entry dropping out, the
 * loading and failure states - an answer outside the contract read as a
 * failure - the phone's sheet and dialog, a URL that wraps rather than
 * scrolling sideways, and blocked storage.
 */

const STORAGE_KEY = 'qa-tools:sessions';

/** A well-formed id that names no session. */
const UNKNOWN_ID = 'Unknown0000000000000000000000000000000000ab';

/** Puts `ids` in the list before the page's own scripts run, the first opened first. */
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

function storedIds(page: Page): Promise<string[]> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);

    return raw === null
      ? []
      : (JSON.parse(raw) as { items: { id: string }[] }).items.map((item) => item.id);
  }, STORAGE_KEY);
}

/** The status reads the page sends. */
function watchStatusReads(page: Page): Request[] {
  const reads: Request[] = [];

  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/sessions/status')) {
      reads.push(request);
    }
  });

  return reads;
}

const firstVisit = (page: Page) => page.getByRole('heading', { name: 'How it works' });
const tile = (page: Page) => page.getByRole('button', { name: /^Generate URL/ });
const actionsOf = (page: Page, id: string) =>
  page.getByRole('button', { name: `Actions for session ${id.slice(0, 7)}` });

test.describe('E2E-13 — the sessions used in this browser', () => {
  test('a session joins, is copied, opened, removed and deleted from the home page', async ({
    page,
    context,
    request,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const reads = watchStatusReads(page);

    // The first visit: the tile, How it works with the warning in step 01,
    // no separate note, and no status read for an empty list.
    await page.goto('/');
    await expect(firstVisit(page)).toBeVisible();
    await expect(page.getByText('3 steps')).toBeVisible();
    await expect(page.getByText(/so do not send sensitive production data\.$/)).toBeVisible();
    await expect(page.getByText('Temporary and anonymous')).toHaveCount(0);
    // The first visit's eyebrow, exactly: the header's wordmark reads
    // `Webhook Inspector` too since D277.
    await expect(page.getByText('WEBHOOK INSPECTOR', { exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(reads).toHaveLength(0);

    // Created on the home page, it is listed when the visitor comes back.
    await tile(page).click();
    await expect(page).toHaveURL(/\/v\/[A-Za-z0-9]{43}$/);

    const created = new URL(page.url()).pathname.slice(3);
    const createdUrl = await receiveUrlOf(request, created);

    await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByText('1 session in this browser')).toBeVisible();
    await expect(page.getByRole('link', { name: createdUrl })).toBeVisible();
    await expect(page.getByText('0 requests')).toBeVisible();
    await expect(page.getByText('no requests yet')).toBeVisible();
    await expect(firstVisit(page)).toHaveCount(0);
    await expect(page.getByText('WEBHOOK INSPECTOR', { exact: true })).toHaveCount(0);

    // The ids travel in the body of a POST, never in its URL.
    expect(reads.length).toBeGreaterThan(0);

    for (const read of reads) {
      expect(read.method()).toBe('POST');
      expect(read.url()).not.toContain(created.slice(0, 8));
      expect(read.postDataJSON()).toEqual({ ids: [created] });
    }

    // Opened by its link in another tab, a session joins at the top.
    const opened = await createSessionViaApi(request);
    const openedUrl = await receiveUrlOf(request, opened);
    const other = await context.newPage();

    await other.goto(`/v/${opened}`);
    await expect(other.getByRole('heading', { name: 'Requests' })).toBeVisible();
    await other.close();
    await page.reload();
    await expect(page.getByText('2 sessions in this browser')).toBeVisible();
    await expect(page.locator('main li a').first()).toHaveText(openedUrl);

    // The copy icon copies the exact receive URL and opens nothing.
    await page
      .getByRole('button', { name: `Copy the receive URL of session ${opened.slice(0, 7)}` })
      .click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(openedUrl);
    await expect(page).toHaveURL(/\/$/);

    // `⋯` opens its menu and nothing else.
    await actionsOf(page, opened).click();
    await expect(page.getByRole('menuitem', { name: 'Remove from list' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete session…' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press('Escape');

    // A click on the row, away from its URL, opens the session in this tab.
    // The URL's link covers the row, so the click lands on it wherever it is.
    const row = page.locator('main li').first();
    const counts = await row.getByText('0 requests').boundingBox();
    const box = await row.boundingBox();

    await row.click({
      position: {
        x: (counts?.x ?? 0) - (box?.x ?? 0) + 5,
        y: (counts?.y ?? 0) - (box?.y ?? 0) + 5,
      },
    });
    await expect(page).toHaveURL(new RegExp(`/v/${opened}$`));
    await page.goto('/');
    await expect(page.getByText('2 sessions in this browser')).toBeVisible();

    // Remove from list: no confirmation, gone after a reload, and the session
    // still opens by its URL.
    await actionsOf(page, opened).click();
    await page.getByRole('menuitem', { name: 'Remove from list' }).click();
    await expect(page.getByText('1 session in this browser')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('1 session in this browser')).toBeVisible();
    expect(await storedIds(page)).toEqual([created]);
    expect((await request.get(`/api/sessions/${opened}`)).status()).toBe(200);

    // Delete session… asks; Cancel changes nothing.
    await actionsOf(page, created).click();
    await page.getByRole('menuitem', { name: 'Delete session…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Delete this session?' });

    await expect(dialog).toContainText(
      `This will permanently delete the session ${created.slice(0, 7)} with its response settings.`,
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(actionsOf(page, created)).toBeFocused();
    expect((await request.get(`/api/sessions/${created}`)).status()).toBe(200);

    // Confirmed, it deletes the session, the row goes, the toast says so,
    // and with no session left the page is the first visit.
    await actionsOf(page, created).click();
    await page.getByRole('menuitem', { name: 'Delete session…' }).click();
    await dialog.getByRole('button', { name: 'Delete session', exact: true }).click();
    await expect(page.getByTestId('toast')).toHaveText(`Session ${created.slice(0, 7)} deleted`);
    await expect(firstVisit(page)).toBeVisible();
    expect(await storedIds(page)).toEqual([]);

    const gone = await request.post(createdUrl, { data: 'after the deletion' });

    expect(gone.status()).toBe(404);
    expect(await gone.json()).toEqual({ errorCode: 1001, message: 'Session not found' });
  });

  test('five show, Show all shows the rest, an unknown entry drops out, and loading and failure read as drawn', async ({
    page,
    request,
  }) => {
    const ids: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      ids.push(await createSessionViaApi(request));
    }

    await seedList(page, [...ids, UNKNOWN_ID]);

    // Loading: the returning visitor's page at once, never the first visit.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    await page.route('**/api/sessions/status', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/');
    await expect(page.getByText('Loading sessions…')).toBeVisible();
    await expect(tile(page)).toBeVisible();
    await expect(firstVisit(page)).toHaveCount(0);
    release();

    // The unknown id leaves the stored list; five of six show.
    await expect(page.getByText('5 of 6 sessions in this browser')).toBeVisible();
    await expect(page.locator('main li')).toHaveCount(5);
    expect(await storedIds(page)).toEqual(ids);

    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(page.locator('main li')).toHaveCount(6);
    await expect(page.getByText('6 sessions in this browser')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show all' })).toHaveCount(0);
    // Focus moves to the first row Show all revealed.
    await expect(page.locator('main li a').nth(5)).toBeFocused();

    // Failure: the rows by the day last opened here, ids and no counts.
    await page.unroute('**/api/sessions/status');
    await page.route('**/api/sessions/status', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 1500, message: 'Internal server error' }),
      }),
    );
    await page.reload();
    await expect(page.getByText('Session details could not be loaded.')).toBeVisible();
    await expect(page.locator('main li a').first()).toHaveText(ids[0] as string);
    await expect(page.getByText(/requests? ·/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Copy the receive URL/ })).toHaveCount(0);
    expect(await storedIds(page)).toEqual(ids);

    // An answer outside the contract is a failed read too: the same rows, no
    // page error, and nothing taken off the stored list - an unknown state
    // included.
    const errors: string[] = [];
    const entry = (id: string, fields: Record<string, unknown> = {}) => ({
      id,
      state: 'active',
      receiveUrl: `https://hook.example/s/${id}`,
      requestsCount: 0,
      lastRequestAt: null,
      lastUsedAt: new Date().toISOString(),
      ...fields,
    });
    const answer = (first: Record<string, unknown>) =>
      JSON.stringify({ sessions: [first, ...ids.slice(1).map((id) => entry(id))] });
    const deep = `${'['.repeat(10_000)}${']'.repeat(10_000)}`;
    const malformed = [
      '[]',
      '{"sessions":null}',
      '{"sessions":[null]}',
      answer(entry(ids[0] as string, { receiveUrl: 1 })),
      answer({ id: ids[0], state: 'archived' }),
      answer(entry(ids[0] as string)).replace(/"lastUsedAt":"[^"]+"/, `"lastUsedAt":${deep}`),
      answer(entry(ids[0] as string)).replace('"lastRequestAt":null', `"lastRequestAt":${deep}`),
    ];
    let body = '';

    page.on('pageerror', (error) => errors.push(error.message));
    await page.unroute('**/api/sessions/status');
    await page.route('**/api/sessions/status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body }),
    );

    for (const [index, next] of malformed.entries()) {
      body = next;
      await page.reload();
      await expect(
        page.getByText('Session details could not be loaded.'),
        `answer ${index}`,
      ).toBeVisible();
      await expect(page.locator('main li a').first()).toHaveText(ids[0] as string);
      expect(await storedIds(page), `answer ${index}`).toEqual(ids);
    }

    expect(errors).toEqual([]);
  });

  test('on a phone: the sheet, the dialog, a URL that wraps, and nothing sideways at 320 px', async ({
    page,
    request,
  }) => {
    const id = await createSessionViaApi(request);

    await seedList(page, [id]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.getByText('1 session in this browser')).toBeVisible();

    // The URL is whole, and wraps inside the row.
    const link = page.locator('main li a').first();

    await expect(link).toHaveText(await receiveUrlOf(request, id));
    expect(
      await link.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThan(30);

    await actionsOf(page, id).click();

    const sheet = page.getByRole('dialog', { name: `Session ${id.slice(0, 7)}` });

    await expect(sheet.getByRole('button', { name: 'Remove from list' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Delete session…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Delete this session?' });

    await expect(dialog).toBeVisible();

    const [cancel, remove] = await Promise.all([
      dialog.getByRole('button', { name: 'Cancel' }).boundingBox(),
      dialog.getByRole('button', { name: 'Delete session', exact: true }).boundingBox(),
    ]);

    // Two half-width buttons, side by side: the same share of the row, the
    // bordered Cancel 2 px wider for its border, as in `Delete all` (D157).
    expect(Math.abs((cancel?.width ?? 0) - (remove?.width ?? 10))).toBeLessThanOrEqual(2);
    expect(cancel?.y).toBe(remove?.y);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 700 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        `${width} px`,
      ).toBe(false);
    }
  });

  test('with storage blocked the page is the first visit, with no error', async ({ page }) => {
    const errors: string[] = [];

    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
    await page.goto('/');
    await expect(firstVisit(page)).toBeVisible();
    await expect(tile(page)).toBeEnabled();
    expect(errors).toEqual([]);
  });
});
