import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { requestRow, storedRequestId } from './helpers.ts';

/**
 * E2E-21 — a private session in the interface (issue #228, D259; Figma page
 * `Webhook Inspector · Private sessions (#228) — L chosen 2026-10-22,
 * review`, R1-R8).
 *
 * The key store, the fragment's builder and parser, the field's reading, the
 * list's push-out, the calls' headers and the socket's subprotocols are
 * unit-tested (`access-keys.test.ts`, `request-link.test.ts`,
 * `session-list.test.ts`, `client.test.ts`, `realtime.test.ts`); here it is a
 * real browser against a backend that checks keys (D245): a session created
 * private on the home page, working as a public one does with the key on every
 * call and never in a URL, its link with access opened in a fresh context and
 * leaving no fragment or history entry behind, the page without the key the
 * page of a session that does not exist, the field that opens it, a request's
 * link with access, the list's lock and its warning before `Remove from
 * list`, a link with access pasted into the address bar of its keyless page,
 * a move link (D276, #345) pasted into the address bar of the home page and
 * of that keyless page, read there with the key it carries, a removal in one tab taking the key from another, whose page keeps its mark
 * and its links with access until its next call, and hostile storage and
 * fragments with no page error and the key in no console line, error or
 * title.
 */

const KEY_FILE = 'qa-tools:access-keys';
const LIST_FILE = 'qa-tools:sessions';

/** A well-formed id that names no session. */
const UNKNOWN_ID = 'Unknown0000000000000000000000000000000000ab';

interface PrivateSession {
  id: string;
  key: string;
  receiveUrl: string;
}

/** Creates a private session over the API: the server draws its key (D253). */
async function createPrivateSession(request: APIRequestContext): Promise<PrivateSession> {
  const created = await request.post('/api/sessions', { data: { private: true } });

  expect(created.status()).toBe(201);

  const body = (await created.json()) as {
    id: string;
    receiveUrl: string;
    accessKey: string;
    private: boolean;
  };

  expect(body.private).toBe(true);
  expect(body.accessKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

  return { id: body.id, key: body.accessKey, receiveUrl: body.receiveUrl };
}

/** Captures one webhook in the session and answers its request id. */
async function send(request: APIRequestContext, receiveUrl: string, path = '/hook') {
  const sent = await request.post(`${receiveUrl}${path}`, {
    headers: { 'content-type': 'application/json' },
    data: `{"path":"${path}"}`,
  });

  expect(sent.status()).toBe(200);

  return storedRequestId(sent);
}

/** The link with access, as the page writes it. */
function accessLink(origin: string, id: string, key: string, requestId?: string): string {
  return requestId === undefined
    ? `${origin}/v/${id}#key=${key}`
    : `${origin}/v/${id}#key=${key}&request=${requestId}`;
}

/**
 * A move link's value (D276), as the old address writes it: base64url with no
 * padding of the versioned JSON, the sessions opened now and the keys given.
 */
function moveValue(sessions: { id: string; key?: string }[]): string {
  const value = {
    v: 1,
    sessions: sessions.map(({ id }) => ({ id, openedAt: Date.now() })),
    keys: sessions.flatMap(({ id, key }) => (key === undefined ? [] : [{ id, key }])),
  };

  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * What a page leaks, if anything: every request URL it sends, every socket
 * URL, every console line and every page error, kept for the checks that the
 * key appears in none of them.
 */
function watch(page: Page) {
  const urls: string[] = [];
  const console: string[] = [];
  const errors: string[] = [];

  page.on('request', (sent) => urls.push(sent.url()));
  page.on('websocket', (socket) => urls.push(socket.url()));
  page.on('console', (line) => console.push(line.text()));
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));

  return { urls, console, errors };
}

/** Asserts the key is in none of what the page sent, logged or titled. */
async function expectNoLeak(page: Page, seen: ReturnType<typeof watch>, key: string) {
  for (const url of seen.urls) {
    expect(url, 'a request URL holds the key').not.toContain(key);
  }

  for (const line of [...seen.console, ...seen.errors]) {
    expect(line, 'a console line or error holds the key').not.toContain(key);
  }

  expect(await page.title()).not.toContain(key);
  expect(page.url()).not.toContain(key);
}

/** Records the subprotocols each socket offers, before the page's scripts run. */
async function recordSocketProtocols(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const offered: unknown[] = [];

    (window as unknown as { offeredProtocols: unknown[] }).offeredProtocols = offered;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        offered.push(protocols ?? null);
        super(url, protocols);
      }
    } as typeof WebSocket;
  });
}

function storedKeys(page: Page): Promise<Record<string, string>> {
  return page.evaluate((file) => {
    const raw = window.localStorage.getItem(file);
    const items =
      raw === null ? [] : (JSON.parse(raw) as { items: { id: string; key: string }[] }).items;

    return Object.fromEntries(items.map((item) => [item.id, item.key]));
  }, KEY_FILE);
}

function storedIds(page: Page): Promise<string[]> {
  return page.evaluate((file) => {
    const raw = window.localStorage.getItem(file);

    return raw === null
      ? []
      : (JSON.parse(raw) as { items: { id: string }[] }).items.map((item) => item.id);
  }, LIST_FILE);
}

async function freshContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  return context;
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const tile = (page: Page) => page.getByRole('button', { name: /^Generate URL/ });
const optionsTrigger = (page: Page) => page.getByRole('button', { name: /^New session options/ });
const lock = (page: Page) => page.getByRole('img', { name: 'Private session' });
const requestsHeading = (page: Page) => page.getByRole('heading', { name: 'Requests' });
const notFound = (page: Page) => page.getByRole('heading', { name: 'Session not found', level: 1 });
/** The toast a move link's arrival shows, naming the old host where the build moves (D276). */
const movedToast = (page: Page) => page.getByTestId('toast').filter({ hasText: /^Moved / });

test.describe('E2E-21 — a private session', () => {
  test('is created on the home page and works as a public one, its key on every call and in no URL', async ({
    page,
    context,
    request,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await recordSocketProtocols(page);

    const seen = watch(page);

    // R1: the last checkbox of the menu, the lock in the trigger once ticked.
    await page.goto('/');
    await optionsTrigger(page).click();

    const box = page.getByRole('menuitemcheckbox', { name: 'Private session' });

    await expect(box).toHaveAttribute('aria-checked', 'false');
    await expect(box).toHaveAccessibleDescription('Opens only with its link with access');
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(optionsTrigger(page)).toHaveAccessibleName(
      'New session options: 7 days · IP stored · Private session',
    );

    // Created with "private": true, with no Authorization; the key it answers
    // is stored, and never shown.
    const creation = page.waitForRequest(
      (sent) => sent.method() === 'POST' && new URL(sent.url()).pathname === '/api/sessions',
    );
    const answered = page.waitForResponse(
      (got) => got.request().method() === 'POST' && new URL(got.url()).pathname === '/api/sessions',
    );

    await tile(page).click();

    const sent = await creation;
    const { id, accessKey: key } = (await (await answered).json()) as {
      id: string;
      accessKey: string;
    };

    expect(sent.postData()).toBe('{"private":true}');
    expect(sent.headers()['authorization']).toBeUndefined();
    await expect(page).toHaveURL(new RegExp(`/v/${id}$`));
    await expect(requestsHeading(page)).toBeVisible();
    expect(await storedKeys(page)).toEqual({ [id]: key });
    await expect(page.locator('body')).not.toContainText(key);

    // R4: the card says PRIVATE, its Copy is split.
    await expect(page.getByText(/· PRIVATE$/)).toBeVisible();
    await expect(lock(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy options' })).toBeVisible();

    // The socket offered the key under both prefixes beside webhook-inspector
    // (D279), and works: a webhook arrives live.
    expect(
      await page.evaluate(
        () => (window as unknown as { offeredProtocols: unknown[] }).offeredProtocols,
      ),
    ).toContainEqual([
      'webhook-inspector',
      `webhook-inspector.access-key.${key}`,
      `qa-tools.access-key.${key}`,
    ]);

    const read = await request.get(`/api/sessions/${id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const { receiveUrl } = (await read.json()) as { receiveUrl: string };
    const first = await send(request, receiveUrl, '/live');

    await expect(requestRow(page, first)).toBeVisible();

    // A request opens.
    await requestRow(page, first).click();
    await expect(page.getByText('/live').first()).toBeVisible();

    // The response, the queue and the rules save, each call with the key.
    const authorized: string[] = [];

    page.on('request', (call) => {
      if (
        call.url().includes(`/api/sessions/${id}`) &&
        call.headers()['authorization'] === `Bearer ${key}`
      ) {
        authorized.push(`${call.method()} ${new URL(call.url()).pathname}`);
      }
    });

    const settings = page.getByRole('button', { name: /Response settings/ });
    const quick = page.getByRole('dialog', { name: 'Session response', exact: true });

    await settings.click();
    await quick.getByRole('radio', { name: 'Custom' }).click();
    await quick.getByRole('button', { name: '201', exact: true }).click();
    await quick.getByRole('button', { name: 'Apply' }).click();
    await expect(settings).toHaveText(/^Custom · 201/);

    await settings.click();
    await quick.getByRole('button', { name: /^Response queue/ }).click();
    await quick.getByRole('button', { name: 'Set up a queue…' }).click();

    const queue = page.getByRole('dialog', { name: 'Response queue' });

    await queue.getByRole('button', { name: '+ Add step' }).click();
    await queue.getByLabel('HTTP status').fill('503');
    await queue.getByRole('button', { name: 'Save queue' }).click();
    await expect(queue).toBeHidden();
    await expect(settings).toHaveText(/1 queued/);

    await settings.click();
    await quick.getByRole('button', { name: /^Response rules/ }).click();
    await quick.getByRole('button', { name: 'Set up rules…' }).click();

    const rules = page.getByRole('dialog', { name: 'Response rules' });

    await rules.getByRole('button', { name: '+ Add rule' }).click();
    await rules.getByRole('button', { name: 'POST', exact: true }).click();
    await rules.getByLabel('Path').fill('orders');
    await rules.getByLabel('HTTP status').fill('201');
    await rules.getByRole('button', { name: 'Save rules' }).click();
    await expect(rules).toBeHidden();

    expect(authorized).toEqual(
      expect.arrayContaining([
        `PUT /api/sessions/${id}/response`,
        `PUT /api/sessions/${id}/queue`,
        `PUT /api/sessions/${id}/rules`,
      ]),
    );

    // The home page: the row's lock, the status read with accessKeys in its
    // body, the session kept; the box unticked again.
    const reads: { body: unknown; url: string }[] = [];

    page.on('request', (call) => {
      if (new URL(call.url()).pathname === '/api/sessions/status') {
        reads.push({ body: call.postDataJSON(), url: call.url() });
      }
    });
    await page.goto('/');
    await expect(page.getByText('1 session in this browser')).toBeVisible();
    await expect(
      page.locator('main li').getByRole('img', { name: 'Private session' }),
    ).toBeVisible();
    expect(reads.at(-1)?.body).toEqual({ ids: [id], accessKeys: { [id]: key } });
    await expect(optionsTrigger(page)).toHaveAccessibleName(
      'New session options: 7 days · IP stored',
    );
    await page.reload();
    await expect(page.getByText('1 session in this browser')).toBeVisible();
    await optionsTrigger(page).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Private session' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await page.keyboard.press('Escape');

    // The session deletes, with its key, and the key leaves with the entry.
    await page.getByRole('button', { name: `Actions for session ${id.slice(0, 7)}` }).click();
    await page.getByRole('menuitem', { name: 'Delete session…' }).click();
    await page
      .getByRole('dialog', { name: 'Delete this session?' })
      .getByRole('button', { name: 'Delete session', exact: true })
      .click();
    await expect(page.getByTestId('toast')).toHaveText(`Session ${id.slice(0, 7)} deleted`);
    expect(await storedKeys(page)).toEqual({});
    expect(await storedIds(page)).toEqual([]);
    expect((await request.post(receiveUrl, { data: 'gone' })).status()).toBe(404);

    await expectNoLeak(page, seen, key);
    expect(seen.errors).toEqual([]);
  });

  test('opens by its link with access in a fresh context, and without the key is the page of a missing session', async ({
    browser,
    request,
  }) => {
    const session = await createPrivateSession(request);
    const owner = await freshContext(browser);
    const page = await owner.newPage();
    const seen = watch(page);

    // The link with access: the key read, stored and taken out of the
    // address, with no history entry holding it.
    await page.goto('/');
    await page.goto(accessLink(new URL(page.url()).origin, session.id, session.key));
    await expect(requestsHeading(page)).toBeVisible();

    const origin = new URL(page.url()).origin;

    await expect(page).toHaveURL(`${origin}/v/${session.id}`);
    expect(await storedKeys(page)).toEqual({ [session.id]: session.key });
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/`);
    await page.goForward();
    await expect(page).toHaveURL(`${origin}/v/${session.id}`);
    await expect(requestsHeading(page)).toBeVisible();

    // R4: Copy's main part copies the receive URL; ▾ holds the link with access.
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => clipboard(page)).toBe(session.receiveUrl);
    await page.getByRole('button', { name: 'Copy options' }).click();
    await expect(page.getByRole('menuitem', { name: /^Copy receive URL/ })).toContainText(
      'For the sender: it only receives requests',
    );
    await page.getByRole('menuitem', { name: /^Copy link with access/ }).click();
    await expect(page.getByTestId('toast')).toHaveText('Link with access copied');
    await expect(page.getByTestId('toast')).toHaveAttribute('data-icon', 'lock');
    await expect.poll(() => clipboard(page)).toBe(accessLink(origin, session.id, session.key));

    const copied = await clipboard(page);

    // A colleague opens it in a browser of their own.
    const colleague = await freshContext(browser);
    const theirs = await colleague.newPage();
    const theirSeen = watch(theirs);

    await theirs.goto(copied);
    await expect(requestsHeading(theirs)).toBeVisible();
    await expect(theirs).toHaveURL(`${origin}/v/${session.id}`);
    expect(await storedKeys(theirs)).toEqual({ [session.id]: session.key });
    expect(await theirs.evaluate(() => window.history.length)).toBe(2);

    // Without the key: the very page of an id that names no session, in its
    // text, its structure and its title, while it loads and once it has.
    const stranger = await freshContext(browser);
    const strange = await stranger.newPage();
    const strangeSeen = watch(strange);

    /**
     * The page of `id` without its key: while it loads - its session and
     * list reads held and its socket answered by nothing, so neither a read
     * nor the socket's `4404` ends the loading frame first - and once it has.
     */
    async function snapshot(id: string) {
      const probe = await stranger.newPage();
      let release = () => undefined as void;
      const loading = new Promise<void>((resolve) => {
        release = resolve;
      });

      await probe.route(
        (url) => url.pathname.startsWith(`/api/sessions/${id}`),
        async (route) => {
          await loading;
          await route.continue();
        },
      );
      await probe.routeWebSocket(new RegExp(`/ws/${id}`), () => undefined);
      await probe.goto(`/v/${id}`);

      const whileLoading = await probe.locator('body').innerText();

      release();
      await probe.close();

      await strange.goto(`/v/${id}`);
      await expect(notFound(strange)).toBeVisible();
      await expect(
        strange.getByRole('button', { name: 'Open with a link with access or a key…' }),
      ).toBeVisible();

      const shown = await strange.evaluate(
        ({ full, short }) => {
          const main = document.querySelector('main');
          const text = (main?.innerText ?? '').replaceAll(full, '<id>').replaceAll(short, '<id>');
          const shape = [...(main?.querySelectorAll('*') ?? [])].map(
            (element) => `${element.tagName}.${element.getAttribute('class') ?? ''}`,
          );

          return { text, shape, title: document.title };
        },
        { full: id, short: `${id.slice(0, 4)}…${id.slice(-4)}` },
      );

      return { ...shown, whileLoading };
    }

    const missing = await snapshot(UNKNOWN_ID);
    const keyless = await snapshot(session.id);

    expect(keyless).toEqual(missing);
    expect(keyless.whileLoading).not.toContain('Session not found');

    // The field: a wrong key and a malformed link change nothing and say so.
    await strange.getByRole('button', { name: 'Open with a link with access or a key…' }).click();

    const field = strange.getByRole('textbox', {
      name: 'Have a link with access or a key? Paste either one to open the session.',
    });

    await expect(field).toBeFocused();

    for (const wrong of [
      'Zq81aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_-',
      'Zq81…not-a-key',
      `${origin}/v/${session.id}#key=`,
      `${origin}/v/${session.id}#${'0'.repeat(8)}-0000-4000-8000-000000000000`,
      `https://elsewhere.example/v/${session.id}#key=${session.key}`,
    ]) {
      await field.fill(wrong);
      await strange.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(strange.getByRole('alert')).toHaveText(
        'Nothing opened: this is not a link with access or a key of a session that exists.',
      );
      await expect(notFound(strange)).toBeVisible();
      expect(await storedKeys(strange)).toEqual({});
    }

    // The key alone opens this very session and keeps it.
    await field.fill(session.key);
    await strange.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(requestsHeading(strange)).toBeVisible();
    await expect(strange).toHaveURL(`${origin}/v/${session.id}`);
    expect(await storedKeys(strange)).toEqual({ [session.id]: session.key });

    // R8: a link with access pasted on another session's page opens its own.
    const pasting = await freshContext(browser);
    const paster = await pasting.newPage();

    await paster.goto(`/v/${UNKNOWN_ID}`);
    await expect(notFound(paster)).toBeVisible();
    await paster.getByRole('button', { name: 'Open with a link with access or a key…' }).click();
    await paster.getByRole('textbox').fill(copied);
    await paster.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(requestsHeading(paster)).toBeVisible();
    await expect(paster).toHaveURL(`${origin}/v/${session.id}`);
    expect(await storedKeys(paster)).toEqual({ [session.id]: session.key });

    for (const [where, watched] of [
      [page, seen],
      [theirs, theirSeen],
      [strange, strangeSeen],
    ] as const) {
      await expectNoLeak(where, watched, session.key);
      expect(watched.errors).toEqual([]);
    }

    await Promise.all([owner.close(), colleague.close(), stranger.close(), pasting.close()]);
  });

  test('a request’s Copy link carries the key; a public session’s card and links are as before', async ({
    browser,
    page,
    context,
    request,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const session = await createPrivateSession(request);
    const requestId = await send(request, session.receiveUrl, '/orders');

    await page.goto('/');
    await page.goto(accessLink(new URL(page.url()).origin, session.id, session.key));
    await requestRow(page, requestId).click();
    await page.getByRole('button', { name: 'Actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Copy link' }).click();
    await expect(page.getByTestId('toast')).toHaveText('Link with access copied');

    const origin = new URL(page.url()).origin;

    await expect
      .poll(() => clipboard(page))
      .toBe(accessLink(origin, session.id, session.key, requestId));

    // Opened in a fresh context: that request, open, and no fragment left.
    const colleague = await freshContext(browser);
    const theirs = await colleague.newPage();

    await theirs.goto('/');
    await theirs.goto(await clipboard(page));
    await expect(theirs).toHaveURL(`${origin}/v/${session.id}`);
    await expect(requestRow(theirs, requestId).locator('xpath=..')).toHaveClass(/bg-row-selected/);
    await colleague.close();

    // A public session: the plain Copy, no PRIVATE, and D182's link.
    const created = await request.post('/api/sessions');
    const { id: publicId, receiveUrl } = (await created.json()) as {
      id: string;
      receiveUrl: string;
    };
    const publicRequest = await send(request, receiveUrl, '/public');

    await page.goto(`/v/${publicId}`);
    await expect(requestsHeading(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy options' })).toHaveCount(0);
    await expect(lock(page)).toHaveCount(0);
    await expect(page.getByText(/PRIVATE/)).toHaveCount(0);
    await requestRow(page, publicRequest).click();
    await page.getByRole('button', { name: 'Actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Copy link' }).click();
    await expect(page.getByTestId('toast')).toHaveText('Link copied');
    await expect.poll(() => clipboard(page)).toBe(`${origin}/v/${publicId}#${publicRequest}`);
  });

  test('Remove from list warns, offers the link, and takes the key with the entry', async ({
    page,
    context,
    request,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const session = await createPrivateSession(request);

    await page.goto('/');
    await page.goto(accessLink(new URL(page.url()).origin, session.id, session.key));
    await expect(requestsHeading(page)).toBeVisible();

    const origin = new URL(page.url()).origin;

    await page.goto('/');

    const actions = page.getByRole('button', {
      name: `Actions for session ${session.id.slice(0, 7)}`,
    });
    const warning = page.getByRole('dialog', {
      name: 'Remove this private session from the list?',
    });

    // R3: cancelled, nothing changes.
    await actions.click();
    await page.getByRole('menuitem', { name: 'Remove from list' }).click();
    await expect(warning).toContainText('Only this browser holds its key.');
    await expect(warning).toContainText(session.receiveUrl);
    await expect(warning.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await warning.getByRole('button', { name: 'Cancel' }).click();
    await expect(warning).toHaveCount(0);
    expect(await storedIds(page)).toEqual([session.id]);
    expect(await storedKeys(page)).toEqual({ [session.id]: session.key });

    // Copy link with access copies and keeps the dialog open; confirmed, the
    // entry and the key are gone.
    await actions.click();
    await page.getByRole('menuitem', { name: 'Remove from list' }).click();
    await warning.getByRole('button', { name: 'Copy link with access' }).click();
    await expect.poll(() => clipboard(page)).toBe(accessLink(origin, session.id, session.key));
    await expect(warning).toBeVisible();
    await warning.getByRole('button', { name: 'Remove from list' }).click();
    await expect(warning).toHaveCount(0);
    expect(await storedIds(page)).toEqual([]);
    expect(await storedKeys(page)).toEqual({});
    expect(
      (
        await request.get(`/api/sessions/${session.id}`, {
          headers: { authorization: `Bearer ${session.key}` },
        })
      ).status(),
    ).toBe(200);
  });

  /**
   * Finding 1 of the outside review of !252: a link put into the address bar
   * of the session's own tab changes only the fragment - no new document, the
   * same page - and is read all the same, its key out of the address at once.
   */
  test('a link with access pasted into the address bar of its keyless page opens it there, no history entry holding the key', async ({
    browser,
    request,
  }) => {
    const session = await createPrivateSession(request);
    const requestId = await send(request, session.receiveUrl, '/pasted');
    const context = await freshContext(browser);
    const page = await context.newPage();
    const seen = watch(page);

    await page.goto(`/v/${session.id}`);
    await expect(notFound(page)).toBeVisible();

    const origin = new URL(page.url()).origin;
    const bare = `${origin}/v/${session.id}`;

    // Set on this document: a new one would not have it.
    await page.evaluate(() => {
      (window as unknown as { sameDocument: boolean }).sameDocument = true;
    });

    /** As typing `href` into the address bar and Enter: a fragment navigation. */
    const paste = (href: string) =>
      page.evaluate((next) => {
        window.location.href = next;
      }, href);

    // A wrong key: taken out at once, and nothing opens or is kept.
    await paste(accessLink(origin, session.id, 'Zq81aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_-'));
    await expect(page).toHaveURL(bare);
    await expect(notFound(page)).toBeVisible();
    expect(await storedKeys(page)).toEqual({});

    // The right one, naming a request: the session opens in place, at that
    // request, and keeps the key.
    await paste(accessLink(origin, session.id, session.key, requestId));
    await expect(requestsHeading(page)).toBeVisible();
    await expect(requestRow(page, requestId).locator('xpath=..')).toHaveClass(/bg-row-selected/);
    await expect(page).toHaveURL(bare);
    expect(await storedKeys(page)).toEqual({ [session.id]: session.key });
    expect(
      await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument),
    ).toBe(true);

    // Each paste added an entry; Back through them finds no key.
    expect(await page.evaluate(() => window.history.length)).toBe(4);

    for (let step = 0; step < 2; step += 1) {
      await page.goBack();
      await expect(page).toHaveURL(bare);
    }

    await expectNoLeak(page, seen, session.key);
    expect(seen.errors).toEqual([]);
    await context.close();
  });

  /**
   * Issue #345: a move link (D276) pasted into the address bar of a page
   * already shown, only its fragment changing, is read there as on a fresh
   * load - over the home page, and over a session page, whose own reading of
   * the fragment leaves a move link's alone. The page loads again to read it:
   * the address holds no fragment, the toast says what came, and the key it
   * carried opens its private session.
   */
  test('a move link pasted into the address bar of the home page or a session page is read there', async ({
    browser,
    request,
  }) => {
    const moved = await createPrivateSession(request);
    const publicId = ((await (await request.post('/api/sessions')).json()) as { id: string }).id;
    const context = await freshContext(browser);

    // Who takes the move link out of the address: for every `replaceState`
    // that removes it, whether the document making it was loaded with the
    // link - the reading on arrival - or had it pasted over it, kept in the
    // tab's sessionStorage across the reload. Chromium's reload loads the
    // address it had when it was called, so a page taking the link out after
    // that call would lose nothing here, and only this record shows it.
    await context.addInitScript(() => {
      const loadedWithMove = window.location.href.includes('#move=');
      const replace = History.prototype.replaceState;

      History.prototype.replaceState = function (
        this: History,
        state: unknown,
        unused: string,
        url?: string | URL | null,
      ) {
        if (
          window.location.href.includes('#move=') &&
          url !== undefined &&
          url !== null &&
          !String(url).includes('#move=')
        ) {
          const taken = JSON.parse(
            window.sessionStorage.getItem('moveTakenOut') ?? '[]',
          ) as boolean[];

          window.sessionStorage.setItem('moveTakenOut', JSON.stringify([...taken, loadedWithMove]));
        }

        replace.call(this, state, unused, url);
      };
    });

    const page = await context.newPage();
    const seen = watch(page);
    const takenOut = () =>
      page.evaluate(() => JSON.parse(window.sessionStorage.getItem('moveTakenOut') ?? '[]'));

    /** As typing `href` into the address bar and Enter: a fragment navigation. */
    const paste = (href: string) =>
      page.evaluate((next) => {
        window.location.href = next;
      }, href);

    // Over the home page: the public session comes, as before #345.
    await page.goto('/');

    const origin = new URL(page.url()).origin;
    const toPublic = moveValue([{ id: publicId }]);

    await paste(`${origin}/#move=${toPublic}`);
    await expect(movedToast(page)).toHaveText(/^Moved 1 session( from \S+)?$/);
    await expect(page.getByText('1 session in this browser')).toBeVisible();
    await expect(page).toHaveURL(`${origin}/`);
    expect(await storedIds(page)).toEqual([publicId]);
    expect(await takenOut()).toEqual([true]);

    // Over the page of a private session this browser has no key for: the
    // key comes, and the session opens with it in place of `Session not found`.
    const bare = `${origin}/v/${moved.id}`;
    const toPrivate = moveValue([moved]);

    await page.goto(bare);
    await expect(notFound(page)).toBeVisible();
    await paste(`${bare}#move=${toPrivate}`);
    await expect(movedToast(page)).toHaveText(/^Moved 1 private session( from \S+)?$/);
    await expect(requestsHeading(page)).toBeVisible();
    await expect(page).toHaveURL(bare);
    expect(await storedKeys(page)).toEqual({ [moved.id]: moved.key });
    expect((await storedIds(page)).sort()).toEqual([moved.id, publicId].sort());
    // Taken out once more, on arrival: the session page left it to that reading.
    expect(await takenOut()).toEqual([true, true]);

    for (const url of seen.urls) {
      expect(url, 'a request URL holds the move link').not.toContain(toPrivate);
    }

    await expectNoLeak(page, seen, moved.key);
    expect(seen.errors).toEqual([]);
    await context.close();
  });

  /**
   * Finding 2 of the outside review of !252: `Remove from list` confirmed in
   * one tab takes the key out of every tab of the browser. The tab that opened
   * the session with it goes home within the page and Back - the same
   * document, whose memory a reload would have cleared - and finds `Session
   * not found`, storing nothing again.
   */
  test('Remove from list in one tab takes the key from every tab of the browser', async ({
    browser,
    request,
  }) => {
    const session = await createPrivateSession(request);
    const context = await freshContext(browser);
    const first = await context.newPage();

    await first.goto('/');

    const origin = new URL(first.url()).origin;

    await first.goto(accessLink(origin, session.id, session.key));
    await expect(requestsHeading(first)).toBeVisible();
    expect(await storedKeys(first)).toEqual({ [session.id]: session.key });

    // A webhook arrives live and its request is opened.
    const opened = await send(request, session.receiveUrl, '/first');

    await requestRow(first, opened).click();
    await expect(requestRow(first, opened).locator('xpath=..')).toHaveClass(/bg-row-selected/);
    await expect(first.getByRole('button', { name: 'Actions' }).first()).toBeVisible();

    const second = await context.newPage();
    const warning = second.getByRole('dialog', {
      name: 'Remove this private session from the list?',
    });

    await second.goto('/');
    await second
      .getByRole('button', { name: `Actions for session ${session.id.slice(0, 7)}` })
      .click();
    await second.getByRole('menuitem', { name: 'Remove from list' }).click();
    await warning.getByRole('button', { name: 'Remove from list' }).click();
    await expect(warning).toHaveCount(0);
    expect(await storedKeys(second)).toEqual({});

    // A second webhook redraws the first tab, which makes no call: the page
    // keeps the key it opened with for as long as it shows the session
    // (#264) - the card's PRIVATE, its split Copy and links with access.
    await first.bringToFront();

    const later = await send(request, session.receiveUrl, '/second');

    await expect(requestRow(first, later)).toBeVisible();
    await expect(first.getByText(/· PRIVATE$/)).toBeVisible();
    await expect(lock(first)).toBeVisible();
    await expect(first.getByRole('button', { name: 'Copy options' })).toBeVisible();
    await first.getByRole('button', { name: 'Actions' }).first().click();
    await first.getByRole('menuitem', { name: 'Copy link' }).click();
    await expect(first.getByTestId('toast')).toHaveText('Link with access copied');
    await expect
      .poll(() => clipboard(first))
      .toBe(accessLink(origin, session.id, session.key, opened));
    await first.getByRole('button', { name: 'Copy options' }).click();
    await first.getByRole('menuitem', { name: /^Copy link with access/ }).click();
    await expect(first.getByTestId('toast')).toHaveText('Link with access copied');
    await expect.poll(() => clipboard(first)).toBe(accessLink(origin, session.id, session.key));
    // Kept on the page, not stored again.
    expect(await storedKeys(first)).toEqual({});

    await first
      .getByRole('banner')
      .getByRole('link', { name: 'Webhook Inspector', exact: true })
      .click();
    await expect(first).toHaveURL(`${origin}/`);
    // The home page drawn, so the session's page has gone and Back mounts a new one.
    await expect(tile(first)).toBeVisible();
    await first.goBack();
    await expect(first).toHaveURL(`${origin}/v/${session.id}`);
    await expect(notFound(first)).toBeVisible();
    expect(await storedKeys(first)).toEqual({});
    expect(await storedIds(first)).toEqual([]);
    await context.close();
  });

  test('hostile storage and fragments: no page error, and a link still opens its session in the tab', async ({
    browser,
    request,
  }) => {
    const session = await createPrivateSession(request);
    const other = await createPrivateSession(request);
    const publicId = ((await (await request.post('/api/sessions')).json()) as { id: string }).id;

    // Blocked storage: the link with access opens the session in that tab.
    const blocked = await freshContext(browser);

    await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    });

    const tab = await blocked.newPage();
    const seen = watch(tab);

    await tab.goto('/');
    await tab.goto(accessLink(new URL(tab.url()).origin, session.id, session.key));
    await expect(requestsHeading(tab)).toBeVisible();
    await expect(tab).toHaveURL(new RegExp(`/v/${session.id}$`));
    await expectNoLeak(tab, seen, session.key);
    expect(seen.errors).toEqual([]);
    await blocked.close();

    // A stored key of the wrong shape is never sent: the status read of the
    // rest of the list still succeeds, the private one with its key.
    const seeded = await freshContext(browser);

    await seeded.addInitScript(
      ({ list, keys, ids }) => {
        if (window.sessionStorage.getItem('seeded') === null) {
          window.localStorage.setItem(list, ids.list);
          window.localStorage.setItem(keys, ids.keys);
          window.sessionStorage.setItem('seeded', '1');
        }
      },
      {
        list: LIST_FILE,
        keys: KEY_FILE,
        ids: {
          list: JSON.stringify({
            v: 1,
            items: [session.id, other.id, publicId].map((id, index) => ({
              id,
              openedAt: Date.now() - index,
            })),
          }),
          keys: JSON.stringify({
            v: 1,
            items: [
              { id: session.id, key: session.key },
              { id: other.id, key: `${other.key}x` },
              { id: publicId, key: 'short' },
            ],
          }),
        },
      },
    );

    const home = await seeded.newPage();
    const homeSeen = watch(home);
    const statusRead = home.waitForResponse(
      (got) => new URL(got.url()).pathname === '/api/sessions/status',
    );

    await home.goto('/');

    const answer = await statusRead;

    expect(answer.status()).toBe(200);
    expect(answer.request().postDataJSON()).toEqual({
      ids: [session.id, other.id, publicId],
      accessKeys: { [session.id]: session.key },
    });
    await expect(home.getByText('2 sessions in this browser')).toBeVisible();
    expect(homeSeen.errors).toEqual([]);
    await seeded.close();

    // Fragments: each read with no page error, the key taken only when whole
    // and alone, and nothing left in the address.
    const fragments = await freshContext(browser);
    const page = await fragments.newPage();
    const fragmentSeen = watch(page);
    const origin = new URL(`${(await request.get('/')).url()}`).origin;

    for (const [fragment, opens] of [
      ['key=', false],
      [`key=${session.key.slice(1)}`, false],
      [`key=${session.key}x`, false],
      [`key=${session.key}&key=${other.key}`, false],
      [`key=${other.key}`, false],
      [`key=${session.key}&request=not-a-request`, true],
      [`key=${session.key}${'a'.repeat(1024 * 1024)}`, false],
    ] as const) {
      await page.goto('/');
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${origin}/v/${session.id}#${fragment}`);
      await expect(opens ? requestsHeading(page) : notFound(page)).toBeVisible();
      await expect(page).toHaveURL(`${origin}/v/${session.id}`);
    }

    await expectNoLeak(page, fragmentSeen, session.key);
    expect(fragmentSeen.errors).toEqual([]);
    await fragments.close();
  });

  test('nothing scrolls sideways at 320 px: the options sheet, the card, its sheet, the warning and the field', async ({
    page,
    request,
  }) => {
    const session = await createPrivateSession(request);
    const wide = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );

    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    await optionsTrigger(page).click();

    const sheet = page.getByRole('dialog', { name: 'New session options' });

    await sheet.locator('label', { hasText: 'Private session' }).click();
    await expect(sheet.getByRole('checkbox', { name: 'Private session' })).toBeChecked();
    await expect(
      sheet.getByRole('checkbox', { name: 'Private session' }),
    ).toHaveAccessibleDescription('Opens only with its link with access');
    expect(await wide()).toBe(false);
    await page.keyboard.press('Escape');
    await expect(optionsTrigger(page)).toHaveAccessibleName(/· Private session$/);

    await page.goto(accessLink(new URL(page.url()).origin, session.id, session.key));
    await expect(page.getByRole('button', { name: 'Copy options' })).toBeVisible();
    await expect(page.getByText('PRIVATE', { exact: false })).toBeVisible();
    expect(await wide()).toBe(false);
    await page.getByRole('button', { name: 'Copy options' }).click();
    await expect(page.getByRole('dialog', { name: 'Copy options' })).toContainText(
      'For a colleague: opens this session',
    );
    expect(await wide()).toBe(false);
    await page.keyboard.press('Escape');

    await page.goto('/');
    await page
      .getByRole('button', { name: `Actions for session ${session.id.slice(0, 7)}` })
      .click();
    await page.getByRole('button', { name: 'Remove from list' }).click();

    const warning = page.getByRole('dialog', {
      name: 'Remove this private session from the list?',
    });
    const buttons = await warning.getByRole('button').allInnerTexts();

    expect(buttons.map((text) => text.trim())).toEqual([
      'Remove from list',
      'Cancel',
      'Copy link with access',
    ]);
    expect(await wide()).toBe(false);
    await warning.getByRole('button', { name: 'Cancel' }).click();

    await page.goto(`/v/${UNKNOWN_ID}`);
    await page.getByRole('button', { name: 'Open with a link with access or a key…' }).click();
    await page.getByRole('textbox').fill('Zq81…not-a-key');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await wide()).toBe(false);
  });
});
