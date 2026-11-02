import { expect, test, type Page, type Request } from '@playwright/test';
import { NEW_SESSION_ID } from './helpers.ts';

/**
 * E2E-04 — the API reference at /docs (issue #34, D155).
 *
 * The page is Scalar rendering `/openapi.json`. What only a browser can show:
 * that it renders at both addresses and is never the application; that every
 * operation of the description is on it with the description's version, and
 * its contact as a mail link (D177); that
 * none of Scalar's hosted-service entry points and no dark mode survive the
 * configuration; that the code samples are curl, JavaScript fetch and Python
 * requests with curl first; and — watched on the network log of the whole
 * browser context — that loading the page, opening an operation, switching
 * its code sample and running `Test Request` never reach an origin other than
 * the page's own. A request anywhere else is recorded, refused before it leaves
 * the machine, and fails the test.
 *
 * The dev server stands in for nginx here, as it does for the application
 * (D108): `apps/frontend/vite.config.ts` serves `/docs`, `/docs/` and
 * `/openapi.json` as `nginx.conf` does, and `src/lib/docs-serving.test.ts`
 * reads `nginx.conf` itself.
 */

interface Description {
  info: { title: string; version: string; contact: { name: string; email: string } };
  tags: { name: string }[];
  paths: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Every request and WebSocket of the context that leaves the page's origin. */
function watchOrigins(page: Page, origin: string): string[] {
  const foreign: string[] = [];
  const context = page.context();
  const elsewhere = (url: string) => {
    const parsed = new URL(url);

    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
      return false;
    }

    const scheme = parsed.protocol.replace(/^ws/, 'http');

    return `${scheme}//${parsed.host}` !== origin;
  };

  // Refused, not only recorded: a third-party call must not leave the machine
  // because a test happened to run.
  void context.route(
    (url) => elsewhere(url.href),
    (route) => route.abort('blockedbyclient'),
  );
  context.on('request', (request: Request) => {
    if (elsewhere(request.url())) {
      foreign.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('websocket', (socket) => {
    if (elsewhere(socket.url())) {
      foreign.push(`WebSocket ${socket.url()}`);
    }
  });

  return foreign;
}

test('the API reference renders openapi.json at /docs with nothing but the page origin', async ({
  page,
  request,
  baseURL,
}) => {
  const origin = new URL(baseURL as string).origin;

  // Both addresses answer the reference page itself, not the application.
  for (const address of ['/docs', '/docs/']) {
    const answer = await request.get(address);

    expect(answer.status()).toBe(200);
    expect(answer.headers()['content-type']).toContain('text/html');
    expect(answer.headers()['cache-control']).toBe('no-cache');

    const html = await answer.text();

    expect(html).toContain('id="api-reference"');
    expect(html).not.toContain('id="root"');
  }

  const described = await request.get('/openapi.json');

  expect(described.status()).toBe(200);
  expect(described.headers()['content-type']).toContain('application/json');
  expect(described.headers()['cache-control']).toBe('no-cache');

  const description = (await described.json()) as Description;

  const foreign = watchOrigins(page, origin);

  // A reader whose system prefers dark still gets the light page.
  await page.emulateMedia({ colorScheme: 'dark' });

  const loaded = page.waitForResponse(
    (response) => response.url() === `${origin}/openapi.json` && response.status() === 200,
  );

  await page.goto('/docs');
  await loaded;

  await expect(page.getByRole('heading', { name: description.info.title })).toBeVisible();
  await expect(page.getByText(`v${description.info.version}`, { exact: true })).toBeVisible();
  await expect(page.locator('#root')).toHaveCount(0);

  // The introduction is info.description, with its download link.
  await expect(page.getByRole('heading', { name: 'Quickstart' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download openapi.json' })).toHaveAttribute(
    'href',
    '/openapi.json',
  );

  // info.contact, the address the application's footer shows (D177).
  expect(description.info.contact).toEqual({ name: 'QA Tools', email: 'contact@qa-tools.ru' });
  await expect(
    page.getByRole('link', { name: description.info.contact.name, exact: true }),
  ).toHaveAttribute('href', `mailto:${description.info.contact.email}`);

  // The introduction points to the about page, a link /docs draws from the
  // bare address (D211).
  await expect(
    page.getByRole('link', { name: 'https://qa-tools.ru/about', exact: true }),
  ).toHaveAttribute('href', 'https://qa-tools.ru/about');

  // And to the Terms of Use and the Privacy Policy, each a link drawn from
  // its bare address, the comma after the first left out of it (D217).
  for (const address of ['https://qa-tools.ru/terms', 'https://qa-tools.ru/privacy']) {
    await expect(page.getByRole('link', { name: address, exact: true })).toHaveAttribute(
      'href',
      address,
    );
  }

  // The head names the changelog's two Atom feeds for a feed reader (D212).
  expect(
    await page
      .locator('head link[rel="alternate"][type="application/atom+xml"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
  ).toEqual(['/changelog.xml', '/changelog-breaking.xml']);

  // Every operation, found in the sidebar under its tag.
  const sidebar = page.getByRole('complementary', {
    name: `Sidebar for ${description.info.title}`,
  });

  for (const { name } of description.tags) {
    const open = sidebar.getByRole('button', { name: `Open Group - ${name}` });

    if ((await open.count()) > 0) {
      await open.click();
    }

    await expect(sidebar.getByRole('button', { name: `Close Group - ${name}` })).toBeVisible();
  }

  let operations = 0;

  for (const item of Object.values(description.paths)) {
    for (const method of METHODS) {
      const summary = item[method]?.summary;

      if (summary === undefined) {
        continue;
      }

      operations += 1;
      await expect(
        sidebar.getByRole('link', { name: new RegExp(`^${escapeRegExp(summary)}\\b`) }),
      ).toBeVisible();
    }
  }

  expect(operations).toBe(23);

  // Light only, and nothing that leads to Scalar's hosted services.
  await expect(page.locator('body')).toHaveClass(/\blight-mode\b/);
  await expect(page.locator('.dark-mode')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /set (dark|light) mode/i })).toHaveCount(0);

  for (const label of [/ask ai/i, /generate mcp/i, /connect mcp/i, /open api client/i]) {
    await expect(page.getByText(label)).toHaveCount(0);
  }

  for (const label of ['Deploy', 'Share', 'Configure', 'Developer Tools']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0);
  }

  // Open an operation. Its code sample starts on curl, against this origin.
  await sidebar.getByRole('link', { name: /^Create a session\b/ }).click();

  const operation = page.locator('section', {
    has: page.getByRole('heading', { name: 'Create a session', exact: true }),
  });
  const sample = operation.getByRole('button', { name: 'Shell Curl' });

  await expect(sample).toBeVisible();
  await expect(operation.getByText(`curl ${origin}/api/sessions`)).toBeVisible();

  // The three clients and no other, curl first in selection.
  await sample.click();
  await expect(page.getByRole('option')).toHaveText(['Fetch', 'Requests', 'Curl']);
  await page.getByRole('option', { name: 'Fetch' }).click();
  await expect(operation.getByRole('button', { name: 'JavaScript Fetch' })).toBeVisible();
  await expect(operation.getByText(`fetch('${origin}/api/sessions'`)).toBeVisible();

  await operation.getByRole('button', { name: 'JavaScript Fetch' }).click();
  await page.getByRole('option', { name: 'Requests' }).click();
  await expect(operation.getByRole('button', { name: 'Python Requests' })).toBeVisible();
  await expect(operation.getByText(`requests.post("${origin}/api/sessions"`)).toBeVisible();

  // Test Request: straight to this origin, no proxy, and it succeeds.
  await operation.getByRole('button', { name: /^Test Request/ }).click();

  const client = page.getByRole('dialog');

  await expect(client).toBeVisible();
  await expect(client.getByRole('button', { name: /^Open API Client/ })).toHaveCount(0);
  await expect(client.getByRole('link', { name: /Open API Client/ })).toHaveCount(0);

  const sent = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/sessions` && response.request().method() === 'POST',
  );

  await client.getByRole('button', { name: `Send post request to ${origin}/api/sessions` }).click();

  const answer = await sent;

  expect(answer.status()).toBe(201);
  expect(((await answer.json()) as { id: string }).id).toMatch(NEW_SESSION_ID);
  await expect(client.getByText('201', { exact: false }).first()).toBeVisible();

  expect(foreign).toEqual([]);
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
