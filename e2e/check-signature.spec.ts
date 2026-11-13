import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createSessionViaApi, receiveUrlOf, requestRow, storedRequestId } from './helpers.ts';

/**
 * E2E-12 — checking a webhook's signature in the browser (issue #74, D197;
 * Figma page `Webhook Inspector · Check signature`, direction B, whose frames
 * B1-B5 and states S1, S2 and S4 name the steps below).
 *
 * `Check signature…` in the request actions checks a header against the HMAC
 * of the body as it arrived, under a secret typed in the page. What only a
 * browser shows, watched on the network log of the whole context as E2E-04
 * watches it (D155): that checking sends no request at all, that no request
 * and no WebSocket frame ever carries the secret, and that `localStorage`,
 * `sessionStorage` and the address never hold it. Around that, the journey a
 * tester takes through the real backend: GitHub's two headers matching with
 * nothing changed, the switch to the other header, a wrong secret's `No
 * match` with the computed value and its copy, a binary body, a body with a
 * leading byte-order mark, an empty one, a request with no signature header,
 * the secret remembered on another request and gone after a reload, how the
 * popover and the phone's sheet close and where focus goes, that the verdict
 * is a live region with no other nested in it, and that a header's name of one
 * long unbroken run wraps inside the result instead of making the popover or
 * the sheet scroll sideways. The HMAC, the
 * reading of the header and the bytes signed are unit-tested
 * (`signature.test.ts`, `received-body.test.ts`); here it is the page.
 */

/** Distinctive, so that finding it anywhere it must not be is unambiguous. */
const SECRET = 'e2e-signing-secret-5c1f9d';
const WRONG = 'e2e-another-secret-77ab0e';

const GITHUB_BODY = Buffer.from(
  '{"ref":"refs/heads/main","repository":{"full_name":"acme/payments"},"pusher":{"name":"octo-bot"}}',
);
/** 2048 bytes that are not UTF-8, stored and served as Base64 (D043). */
const BINARY_BODY = Buffer.from(Array.from({ length: 2048 }, (_, index) => (index * 37) % 256));
/** A JSON body after a byte-order mark, which the detail's `body` drops (D043). */
const BOM_BODY = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);

/**
 * What the result says, found case-insensitively: a header's name is shown as
 * it arrived (D187), and the case a client writes it in is the client's.
 */
function says(text: string, { ending = false } = {}): RegExp {
  return new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${ending ? '$' : ''}`, 'i');
}

function hmac(algorithm: 'sha1' | 'sha256' | 'sha512', body: Buffer, secret = SECRET): Buffer {
  return createHmac(algorithm, secret).update(body).digest();
}

/** Captures one request and returns its id. */
async function send(
  request: APIRequestContext,
  sessionId: string,
  {
    method = 'POST',
    headers,
    body,
  }: { method?: string; headers: Record<string, string>; body?: Buffer },
): Promise<string> {
  const sent = await request.fetch(await receiveUrlOf(request, sessionId), {
    method,
    headers,
    ...(body === undefined ? {} : { data: body }),
  });

  expect(sent.status()).toBe(200);

  return storedRequestId(sent);
}

/**
 * Every request and WebSocket frame the context sends, and any of them that
 * carries the secret anywhere: address, headers, body or frame.
 */
function watchNetwork(page: Page): { sent: string[]; leaks: string[] } {
  const sent: string[] = [];
  const leaks: string[] = [];
  const carries = (text: string) => text.includes(SECRET) || text.includes(WRONG);

  page.context().on('request', (request) => {
    sent.push(`${request.method()} ${request.url()}`);

    if (
      carries(`${request.url()} ${JSON.stringify(request.headers())} ${request.postData() ?? ''}`)
    ) {
      leaks.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      sent.push(`WebSocket ${socket.url()}`);

      if (carries(String(frame.payload))) {
        leaks.push(`WebSocket ${socket.url()}`);
      }
    });
  });

  return { sent, leaks };
}

/** Whether the secret is in either storage or in the address. */
async function secretKept(page: Page): Promise<boolean> {
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }]),
  );

  return [stored, page.url(), decodeURIComponent(page.url())].some(
    (text) => text.includes(SECRET) || text.includes(WRONG),
  );
}

async function noSidewaysScroll(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

/**
 * That each box's content is no wider than the box, by how many pixels it
 * overflows: the popover or the sheet, which scroll inside (their
 * `overflow-y: auto` makes them scroll sideways too), and the result box in
 * it. The caller waits for the content first, so it cannot pass early.
 */
async function noInnerSidewaysScroll(...boxes: Locator[]): Promise<void> {
  for (const box of boxes) {
    await expect
      .poll(() => box.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(0);
  }
}

test.describe('E2E-12 — checking a signature', () => {
  test('checks at 1440 px with nothing sent or kept: GitHub, a wrong secret, binary, BOM, empty, no header, another request, a reload', async ({
    page,
    request,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    const sessionId = await createSessionViaApi(request);
    const github = await send(request, sessionId, {
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature': `sha1=${hmac('sha1', GITHUB_BODY).toString('hex')}`,
        'X-Hub-Signature-256': `sha256=${hmac('sha256', GITHUB_BODY).toString('hex')}`,
      },
      body: GITHUB_BODY,
    });
    const binary = await send(request, sessionId, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Signature': hmac('sha256', BINARY_BODY).toString('base64'),
      },
      body: BINARY_BODY,
    });
    const bom = await send(request, sessionId, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Hmac': hmac('sha512', BOM_BODY).toString('hex').toUpperCase(),
      },
      body: BOM_BODY,
    });
    const empty = await send(request, sessionId, {
      method: 'GET',
      headers: { 'X-Signature': `sha256=${hmac('sha256', Buffer.alloc(0)).toString('hex')}` },
    });
    const unsigned = await send(request, sessionId, {
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('no signature here'),
    });

    const network = watchNetwork(page);

    await page.goto(`/v/${sessionId}`);
    await requestRow(page, github).click();
    await expect(page.getByTestId('detail-method')).toHaveText('POST');

    const actions = page.getByRole('button', { name: 'Actions', exact: true });
    const menu = page.getByRole('menu', { name: 'Actions' });
    const popover = page.getByRole('dialog', { name: 'Check signature' });
    const header = popover.getByLabel('Signature header');
    const secret = popover.getByLabel('Secret', { exact: true });
    const result = popover.getByTestId('signature-result');
    const radio = (name: string) => popover.getByRole('radio', { name, exact: true });

    async function open(): Promise<void> {
      await actions.click();
      await menu.getByRole('menuitem', { name: 'Check signature…', exact: true }).click();
      await expect(popover).toBeVisible();
    }

    // The item follows `Download JSON`, before `Compare with…`.
    await actions.click();
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Copy link',
      'Copy as cURL',
      'Download JSON',
      'Check signature…',
      'Compare with…',
    ]);
    await page.keyboard.press('Escape');
    await open();

    // Figma frames B1 and S2: the secret field takes focus while it is empty,
    // masked; the first header named `signature` is preselected, and its
    // `sha1=` picks SHA-1.
    await expect(secret).toBeFocused();
    await expect(secret).toHaveAttribute('type', 'password');
    await expect(popover).toContainText(
      'Computed in your browser. Not sent or stored. Use a test secret.',
    );
    await expect(result).toHaveText('Type the secret to check.');
    await expect(header).toHaveValue('x-hub-signature');
    await expect(radio('SHA-1')).toHaveAttribute('aria-checked', 'true');

    // Nothing is sent from here until the popover closes.
    const sentBeforeChecking = network.sent.length;

    await page.keyboard.type(SECRET);
    await expect(result).toContainText('Match');
    await expect(result).toContainText(
      says(`HMAC-SHA1 of the body, ${GITHUB_BODY.length} bytes · hex · X-Hub-Signature`, {
        ending: true,
      }),
    );

    await header.selectOption('x-hub-signature-256');
    await expect(radio('SHA-256')).toHaveAttribute('aria-checked', 'true');
    await expect(result).toContainText(
      says(`HMAC-SHA256 of the body, ${GITHUB_BODY.length} bytes · hex · X-Hub-Signature-256`),
    );

    // Figma frame S4: the eye shows the secret and hides it again.
    await popover.getByRole('button', { name: 'Show secret' }).click();
    await expect(secret).toHaveAttribute('type', 'text');
    await popover.getByRole('button', { name: 'Hide secret' }).click();
    await expect(secret).toHaveAttribute('type', 'password');

    // Figma frame B2: another secret - the computed value in the header's
    // form, which the copy icon writes, and the hint naming the providers it
    // misses.
    await secret.fill(WRONG);

    const computed = `sha256=${hmac('sha256', GITHUB_BODY, WRONG).toString('hex')}`;

    await expect(result).toContainText('No match');
    await expect(popover.getByTestId('signature-computed')).toHaveText(computed);
    await expect(result).toContainText('Stripe, Slack and Standard Webhooks');
    await popover.getByRole('button', { name: 'Copy computed signature' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(computed);

    // The verdict and the line under it are a live region; the computed value
    // and its copy icon, whose `Copied` is a live region of its own, are
    // outside it, so no live region is nested in another to be said twice.
    const verdict = popover.getByRole('status').filter({ hasText: 'No match' });

    await expect(verdict).toHaveCount(1);
    await expect(verdict).toContainText(says('X-Hub-Signature-256'));
    await expect(verdict).not.toContainText(computed);
    await expect(popover.getByRole('status').filter({ hasText: 'Copied' })).toHaveCount(1);
    await expect(popover.locator('[role="status"] [role="status"]')).toHaveCount(0);

    await secret.fill(SECRET);
    await expect(result).toContainText('Match');
    expect(network.sent.slice(sentBeforeChecking), 'checking sent a request').toEqual([]);

    // Escape closes it, focus back on `Actions`.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(actions).toBeFocused();

    // Reopened, the result is there at once with the same secret, header and
    // algorithm, and focus is on the header; `×` closes it.
    await open();
    await expect(header).toBeFocused();
    await expect(header).toHaveValue('x-hub-signature-256');
    await expect(result).toContainText('Match');
    await popover.getByRole('button', { name: 'Close' }).click();
    await expect(popover).toBeHidden();
    await expect(actions).toBeFocused();

    // A click outside closes it too.
    await open();
    await page.getByTestId('request-facts').click();
    await expect(popover).toBeHidden();
    await expect(actions).toBeFocused();

    // Chosen on the Response half, it checks the request.
    await page.getByRole('tab', { name: 'Response', exact: true }).click();
    await open();
    await expect(result).toContainText('Match');

    // A click on another request closes it; opened there, its result is
    // there at once with the same secret: a binary body, signed in Base64.
    await requestRow(page, binary).click();
    await expect(popover).toBeHidden();
    await expect(page.getByTestId('detail-method')).toBeVisible();
    await open();
    await expect(result).toContainText('Match');
    await expect(result).toContainText(
      says(
        `HMAC-SHA256 of the body, ${BINARY_BODY.length.toLocaleString('en-US')} bytes · Base64 · X-Signature`,
      ),
    );
    await page.keyboard.press('Escape');

    // A body after a byte-order mark is signed with the mark, upper-case hex.
    await requestRow(page, bom).click();
    await open();
    await expect(radio('SHA-512')).toHaveAttribute('aria-checked', 'true');
    await expect(result).toContainText(
      says(`HMAC-SHA512 of the body, ${BOM_BODY.length} bytes · hex · X-Webhook-Hmac`),
    );
    await page.keyboard.press('Escape');

    // An empty body is zero bytes.
    await requestRow(page, empty).click();
    await open();
    await expect(result).toContainText(
      says('HMAC-SHA256 of the body, 0 bytes · hex · X-Signature'),
    );
    await page.keyboard.press('Escape');

    // Figma frame S1: no header named signature or hmac - none is chosen.
    await requestRow(page, unsigned).click();
    await open();
    await expect(header).toHaveValue('');
    await expect(result).toHaveText('Choose the header that holds the signature.');
    await page.keyboard.press('Escape');

    // The secret was never sent, stored or put in the address.
    expect(network.leaks, 'a request or frame carried the secret').toEqual([]);
    expect(await secretKept(page)).toBe(false);

    // A reload forgets it.
    await page.reload();
    await requestRow(page, github).click();
    await open();
    await expect(secret).toHaveValue('');
    await expect(result).toHaveText('Type the secret to check.');
    expect(network.leaks).toEqual([]);
  });

  test('checks in the phone sheet at 375 px, which closes on the scrim and on Escape, and fits 320 px', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);
    const github = await send(request, sessionId, {
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${hmac('sha256', GITHUB_BODY).toString('hex')}`,
      },
      body: GITHUB_BODY,
    });
    const network = watchNetwork(page);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/v/${sessionId}`);
    await requestRow(page, github).click();

    const more = page.getByRole('button', { name: 'Request actions' });
    const actionsSheet = page.getByRole('dialog', { name: 'Request actions' });
    const sheet = page.getByRole('dialog', { name: 'Check signature' });
    const result = sheet.getByTestId('signature-result');

    // Figma frame B3: `⋯` lists the item before `Compare with…`; it turns the
    // sheet into `Check signature`.
    await more.click();
    await expect(actionsSheet.getByRole('button')).toHaveText([
      'Copy link',
      'Copy as cURL',
      'Download JSON',
      'Check signature…',
      'Compare with…',
    ]);
    await actionsSheet.getByRole('button', { name: 'Check signature…', exact: true }).click();
    await expect(sheet).toBeVisible();

    const secret = sheet.getByLabel('Secret', { exact: true });

    await expect(secret).toBeFocused();
    await secret.fill(SECRET);
    await expect(result).toContainText('Match');
    await expect(result).toContainText(says('hex · X-Hub-Signature-256'));

    // Figma frame B5: a wrong secret.
    await secret.fill(WRONG);
    await expect(result).toContainText('No match');
    await expect(sheet.getByTestId('signature-computed')).toHaveText(
      `sha256=${hmac('sha256', GITHUB_BODY, WRONG).toString('hex')}`,
    );
    await noSidewaysScroll(page);

    // A tap on the scrim closes it, and so does Escape, focus back on `⋯`.
    await page.mouse.click(187, 40);
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
    await more.click();
    await actionsSheet.getByRole('button', { name: 'Check signature…', exact: true }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel('Secret', { exact: true })).toHaveValue(WRONG);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();

    // 320 px: nothing scrolls sideways, the sheet open.
    await page.setViewportSize({ width: 320, height: 640 });
    await more.click();
    await actionsSheet.getByRole('button', { name: 'Check signature…', exact: true }).click();
    await expect(sheet).toBeVisible();
    await expect(result).toContainText('No match');
    await noSidewaysScroll(page);
    await page.keyboard.press('Escape');

    expect(network.leaks, 'a request or frame carried the secret').toEqual([]);
    expect(await secretKept(page)).toBe(false);
  });

  test('wraps a header name of one long unbroken run inside the result: no sideways scroll in the popover at 1440 px or in the sheet at 320 px', async ({
    page,
    request,
  }) => {
    const sessionId = await createSessionViaApi(request);
    // Names whose only break opportunity is the hyphen after `X`: a run of 73
    // characters, past what one line of the result holds, and a hostile one
    // of 10,009, inside the 16 KB the receiver takes for the request line and
    // the headers. Each name contains `signature`, so it is preselected.
    const names = [
      `X-Signature${'0123456789abcdef'.repeat(4)}`,
      `X-Signature${'0123456789abcdef'.repeat(625)}`,
    ];
    const sent: { name: string; id: string }[] = [];

    for (const name of names) {
      sent.push({
        name,
        id: await send(request, sessionId, {
          headers: {
            'Content-Type': 'application/json',
            [name]: hmac('sha256', GITHUB_BODY).toString('hex'),
          },
          body: GITHUB_BODY,
        }),
      });
    }

    const sheetOrPopover = page.getByRole('dialog', { name: 'Check signature' });
    const result = sheetOrPopover.getByTestId('signature-result');

    for (const viewport of [
      { width: 1440, height: 1024 },
      { width: 320, height: 640 },
    ]) {
      for (const { name, id } of sent) {
        const label = `${viewport.width} px, a run of ${name.length - 2} characters`;

        await page.setViewportSize(viewport);
        // A fresh page each time, which forgets the secret (D197).
        await page.goto(`/v/${sessionId}`);
        await requestRow(page, id).click();

        if (viewport.width >= 768) {
          await page.getByRole('button', { name: 'Actions', exact: true }).click();
          await page
            .getByRole('menu', { name: 'Actions' })
            .getByRole('menuitem', { name: 'Check signature…', exact: true })
            .click();
        } else {
          await page.getByRole('button', { name: 'Request actions' }).click();
          await page
            .getByRole('dialog', { name: 'Request actions' })
            .getByRole('button', { name: 'Check signature…', exact: true })
            .click();
        }

        await expect(sheetOrPopover, label).toBeVisible();

        const secret = sheetOrPopover.getByLabel('Secret', { exact: true });

        // `Match`, the line naming the header.
        await secret.fill(SECRET);
        await expect(result, label).toContainText('Match');
        await expect(result, label).toContainText(says(`hex · ${name}`, { ending: true }));
        await noInnerSidewaysScroll(sheetOrPopover, result);
        await noSidewaysScroll(page);

        // `No match`, the same line less the encoding, then the computed value.
        await secret.fill(WRONG);
        await expect(result, label).toContainText('No match');
        await expect(
          sheetOrPopover.getByRole('status').filter({ hasText: 'No match' }),
          label,
        ).toContainText(says(` · ${name}`, { ending: true }));
        await noInnerSidewaysScroll(sheetOrPopover, result);
        await noSidewaysScroll(page);

        await page.keyboard.press('Escape');
        await expect(sheetOrPopover, label).toBeHidden();
      }
    }
  });
});
