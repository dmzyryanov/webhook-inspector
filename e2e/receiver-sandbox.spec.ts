import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { NEW_SESSION_ID, receiveUrlOf } from './helpers.ts';

/**
 * E2E-07 — a receive URL opened in a browser runs nothing (issue #91, D179).
 *
 * A custom response may carry any body under any `Content-Type`, so a session
 * can answer HTML, SVG, XHTML or XML from the receive host. What protects
 * whoever opens it is the `Content-Security-Policy: sandbox; default-src
 * 'none'` the receiver puts on every answer: only a browser can show that it
 * does. For each document type the spec creates a session over the API whose
 * body carries a script that logs a marker and writes to `localStorage`, opens
 * the receive URL in the page and checks that the content is shown, that no
 * marker was logged, that the document has no storage of its own to write to,
 * and that nothing was written to `localStorage` on the application's origin.
 *
 * Since 0.36.0 the receive URL is on an origin of its own, the backend's
 * receive listener here and `hook.qa-tools.ru` in production (D187), so the
 * application's origin is out of the document's reach even without the
 * policy; the policy still keeps the receive host's own origin out of reach.
 *
 * **The control.** The same answer, fetched from the receiver and handed to
 * the page with the policy removed and nothing else changed (`page.route`),
 * must log the marker and write the key, on the receive origin. Without it, a
 * document the browser refused for another reason - a malformed body, a type
 * it does not render - would pass the check with the policy gone.
 */

const POLICY = "sandbox; default-src 'none'";
const SHOWN = 'QA Tools sandbox probe';
const STORAGE_KEY = 'webhook-inspector-sandbox-probe';

/** The script every document carries: nothing in it needs XML escaping. */
function probeScript(marker: string): string {
  return `console.log('${marker}'); localStorage.setItem('${STORAGE_KEY}', '${marker}');`;
}

function xhtml(marker: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    `<head><title>${SHOWN}</title></head>`,
    `<body><p>${SHOWN}</p><script>${probeScript(marker)}</script></body>`,
    '</html>',
  ].join('\n');
}

const DOCUMENTS: { contentType: string; body: (marker: string) => string }[] = [
  {
    contentType: 'text/html',
    body: (marker) =>
      `<!doctype html><html><head><title>${SHOWN}</title></head>` +
      `<body><p>${SHOWN}</p><script>${probeScript(marker)}</script></body></html>`,
  },
  {
    contentType: 'image/svg+xml',
    body: (marker) =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="60">' +
      `<text x="10" y="30">${SHOWN}</text><script>${probeScript(marker)}</script></svg>`,
  },
  { contentType: 'application/xhtml+xml', body: xhtml },
  // XML whose root is in the XHTML namespace is rendered as XHTML, scripts
  // included, whatever its media type says.
  { contentType: 'text/xml', body: xhtml },
];

/** A session answering `body` under `contentType`, created as a sender's tester would. */
async function createSession(
  request: APIRequestContext,
  contentType: string,
  body: string,
): Promise<string> {
  const created = await request.post('/api/sessions', {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({
      response: { status: 200, headers: [['Content-Type', contentType]], body },
    }),
  });

  expect(created.status(), await created.text()).toBe(201);

  const { id } = (await created.json()) as { id: string };

  expect(id).toMatch(NEW_SESSION_ID);

  return id;
}

/** Every console message the page logs from now on. */
function collectConsole(page: Page): string[] {
  const messages: string[] = [];

  page.on('console', (message) => messages.push(message.text()));

  return messages;
}

/** The key as the application's origin holds it, read from a page of that origin. */
async function storedOnAppOrigin(page: Page): Promise<string | null> {
  await page.goto('/');

  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
}

/**
 * The key as the open document's origin holds it, or `sandboxed` when the
 * document has no storage: a document sandboxed without `allow-same-origin`
 * has an opaque origin, and touching its `localStorage` throws.
 */
function storedOnOpenDocument(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return 'sandboxed';
    }
  }, STORAGE_KEY);
}

for (const { contentType, body } of DOCUMENTS) {
  test(`an answer under ${contentType} is shown and runs no script (E2E-07)`, async ({
    page,
    request,
  }) => {
    const marker = `webhook-inspector-sandbox-marker-${contentType.replace(/\W/g, '-')}`;
    const document = body(marker);
    const sessionId = await createSession(request, contentType, document);
    const receiveUrl = await receiveUrlOf(request, sessionId);
    const messages = collectConsole(page);

    // Protected: the answer as the receiver sends it.
    const answer = await page.goto(receiveUrl);

    expect(answer?.status()).toBe(200);
    expect(await answer?.headerValue('content-type')).toBe(contentType);
    expect(await answer?.headerValue('content-security-policy')).toBe(POLICY);
    expect(await answer?.headerValue('x-content-type-options')).toBe('nosniff');
    await expect(page.getByText(SHOWN, { exact: true }).last()).toBeVisible();
    expect(await storedOnOpenDocument(page), 'the answer had storage of its own').toBe('sandboxed');
    expect(await storedOnAppOrigin(page), 'the answer wrote to localStorage').toBeNull();
    // Read once the page has moved on: a script parsed with the document runs
    // before its load event, so its message would have arrived by now. The
    // control below shows it does.
    expect(messages, `the ${contentType} answer ran its script`).not.toContain(marker);

    // Control: the same bytes and the same Content-Type, with the policy removed.
    await page.route(receiveUrl, async (route) => {
      const fetched = await route.fetch();
      const headers = { ...fetched.headers() };

      expect(headers['content-security-policy']).toBe(POLICY);
      expect(headers['content-type']).toBe(contentType);
      delete headers['content-security-policy'];

      await route.fulfill({ response: fetched, headers });
    });

    const unprotected = await page.goto(receiveUrl);

    expect(unprotected?.status()).toBe(200);
    expect(await unprotected?.headerValue('content-security-policy')).toBeNull();
    await expect(page.getByText(SHOWN, { exact: true }).last()).toBeVisible();
    await expect
      .poll(() => messages, { message: `without the policy the ${contentType} script did not run` })
      .toContain(marker);
    // Written on the receive origin, which the unprotected document has.
    expect(await storedOnOpenDocument(page)).toBe(marker);
  });
}
