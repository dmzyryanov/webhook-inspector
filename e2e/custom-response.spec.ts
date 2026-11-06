import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import type { RequestListItem } from '@webhook-inspector/shared';
import { en } from '../apps/frontend/src/i18n/en.ts';
import { ru } from '../apps/frontend/src/i18n/ru.ts';
import {
  collectRealtimeFrames,
  headerValue,
  measureTouchRow,
  readReceiveUrl,
  requestRow,
  sessionIdFromPage,
  storedRequestId,
} from './helpers.ts';

const BODY = '{"source":"e2e","ok":true}';

/**
 * The configured delay, in milliseconds.
 *
 * Small on purpose - the suite runs one worker with no retries (D108), so a
 * long delay is time every run pays. It only has to be long enough to open the
 * panel on the request while its response is still `pending`, and two seconds
 * is many times the handful of clicks that takes.
 */
const DELAY_MS = 2000;

/**
 * E2E-02 — a session's response, configured on its page: a default session
 * made with **Generate URL** is given a custom response from the endpoint card,
 * a real webhook is answered with exactly the status, header and body that were
 * configured (D099, D101, D150), and that response is then changed while the
 * session runs, with no new session.
 *
 * Until v0.20.0 the journey created the session through the landing page's
 * `Custom response` dialog. The dialog is gone (issue #51, D158): the landing
 * page has one action, and the session page is where a response is set, so
 * that is where the journey configures it - through the quick switch, whose
 * choice is carried into the full editor, which alone sets headers and a body.
 * It is the same journey rewritten, not a fourth one (D108).
 *
 * It is also the only journey that can hold a response open long enough to
 * watch it land, so the **open detail panel following `response.recorded`
 * without being reselected** (D125) is checked here. E2E-01 covers the same
 * transition for the list row, on a session with no delay.
 */
test('a session configured on its page answers with the configured status, header and body, and can be changed', async ({
  page,
  request,
  browser,
  baseURL,
  viewport,
}) => {
  await page.goto('/');

  // One action on the landing page, and it is one click to a default session.
  await expect(page.getByRole('button', { name: 'Custom response' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate URL' }).click();

  const receiveUrl = await readReceiveUrl(page);
  const button = page.getByRole('button', { name: /Response settings/ });

  await expect(button).toHaveText('Default · 200');

  // Before anything is configured, the typed fields at three widths (#61).
  // Nothing is applied there: the session still answers the default.
  await checkTypedFields(page, button, viewport);
  await expect(button).toHaveText('Default · 200');

  // The quick switch: Custom, 201 and the 2 s delay chip...
  await button.click();

  const quick = page.getByRole('dialog', { name: 'Session response', exact: true });

  await quick.getByRole('radio', { name: 'Custom' }).click();
  await quick.getByRole('button', { name: '201', exact: true }).click();
  await quick.getByRole('button', { name: '2 s', exact: true }).click();

  // ...carried into the full editor, which alone sets headers and a body (D2).
  await quick.getByRole('button', { name: 'Edit headers and body…' }).click();

  const editor = page.getByRole('dialog', { name: 'Session response settings' });

  await expect(editor).toBeVisible();
  await expect(editor.getByRole('radio', { name: 'Custom' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(editor.getByLabel('HTTP status')).toHaveValue('201');
  await expect(editor.getByLabel('Delay (ms)')).toHaveValue(String(DELAY_MS));

  await editor.getByRole('button', { name: '+ Add header' }).click();
  await editor.getByRole('textbox', { name: 'Header 1 name' }).fill('X-E2E-Test');
  await editor.getByRole('textbox', { name: 'Header 1 value' }).fill('custom-response');
  await editor.getByLabel('Body · Optional').fill(BODY);
  await editor.getByRole('button', { name: 'Save response' }).click();

  await expect(editor).toBeHidden();
  await expect(page.getByTestId('toast')).toHaveText(
    'Saved. Requests captured from now on get this response.',
  );
  await expect(button).toHaveText(`Custom · 201 · ${DELAY_MS} ms`);

  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();

  /*
   * Sent but deliberately **not** awaited yet: the configured delay holds the
   * reply, and everything below happens while it is still being held. The
   * request is stored and announced before the delay is waited out (D105), so
   * the row is on screen long before this promise settles.
   */
  const answering = request.post(receiveUrl);

  // Found by its status cell rather than by the request id: the id arrives in a
  // header of the response that has not been written yet.
  const rowStatus = page.getByTestId('row-status');

  await expect(rowStatus).toHaveText('Pending');
  // Nothing answered yet: muted text and no pill, as before the pill (D207).
  await expect(rowStatus).toHaveCSS('background-color', NO_BACKGROUND);
  await expect(rowStatus).toHaveCSS('color', INK_MUTED);

  await rowStatus.click();

  const responsePanel = page.getByRole('tabpanel', { name: 'Response' });

  await page.getByRole('tab', { name: 'Response' }).click();
  await expect(responsePanel).toContainText(`Pending · configured delay: ${DELAY_MS} ms`);
  await expect(responsePanel).toContainText('Waiting to send.');

  /*
   * Nothing is clicked from here to the assertion below. The panel is open on
   * this request, the response completes, `response.recorded` arrives, and the
   * panel moves to the recorded response on its own - which is the whole of
   * D125. Before it, the panel kept `Pending` until the request was selected
   * again, while the row beside it had already settled.
   */
  await expect(responsePanel).toContainText('201 Created');
  await expect(responsePanel).toContainText('Sent by server');
  // Two lines for a finished write: no third one, and never a delivery (D158).
  await expect(responsePanel.getByTestId('response-note')).toHaveCount(0);
  await expect(responsePanel).not.toContainText('Client delivery is not confirmed.');
  await expect(responsePanel).not.toContainText('Waiting to send.');
  await expect(rowStatus).toHaveText('201');

  /*
   * An answer the session gave: the code in the pill of its class, the 2xx
   * green tint, in the row and in the heading, where the reason phrase beside
   * it stays in ink (issue #138, D207).
   */
  const headingStatus = responsePanel.getByTestId('response-status');
  const headingPill = headingStatus.locator('span').first();

  await expect(headingStatus).toHaveText('201 Created');
  await expect(headingPill).toHaveText('201');
  for (const pill of [rowStatus, headingPill]) {
    await expect(pill).toHaveCSS('background-color', STATUS_2XX_TINT);
    await expect(pill).toHaveCSS('color', STATUS_2XX_CODE);
  }
  await expect(headingStatus.locator('span').nth(1)).toHaveText('Created');
  await expect(headingStatus.locator('span').nth(1)).toHaveCSS('color', INK);

  // The response a sender actually receives, at the URL the page displays.
  const response = await answering;

  expect(response.status()).toBe(201);
  // Looked up case-insensitively because HTTP field names are case-insensitive
  // (RFC 9110, section 5.1) and an intermediary may re-case them. What the
  // configuration promises is the name and the value (D101), and that is what
  // is asserted.
  expect(headerValue(response, 'X-E2E-Test')).toBe('custom-response');
  // Byte for byte as it was typed, with no `requestId` folded into it (D100).
  expect(await response.text()).toBe(BODY);

  const row = requestRow(page, storedRequestId(response));

  await expect(row).toBeVisible();

  await changeTheRunningResponse(page, request, browser, receiveUrl, baseURL, viewport);
});

/**
 * The 2xx status pill's tint and code, `--color-status-2xx` and
 * `--color-status-2xx-ink` (D207); `--color-ink`, `--color-ink-muted` and no
 * background, as a browser computes them.
 */
const STATUS_2XX_TINT = 'rgb(225, 242, 232)';
const STATUS_2XX_CODE = 'rgb(22, 107, 65)';
const INK = 'rgb(31, 36, 46)';
const INK_MUTED = 'rgb(95, 105, 125)';
const NO_BACKGROUND = 'rgba(0, 0, 0, 0)';

/** `--color-line-strong`, `--color-line` and `--color-danger`, as a browser computes them. */
const LINE_STRONG = 'rgb(154, 162, 177)';
const LINE = 'rgb(222, 227, 237)';
const DANGER = 'rgb(184, 46, 46)';
/** `--color-line-section`, the line above the Response queue section (D206). */
const LINE_SECTION = 'rgb(184, 191, 204)';
/** The id of the section's title, which names the section and its heading row. */
const QUEUE_TITLE_ID = 'response-queue-section-title';

/**
 * The desktop, a tablet and a phone, each with the size, font size and
 * horizontal padding D157 gives a typed field there, which #61 leaves as they
 * were.
 */
const TYPED_FIELD_LAYOUTS = [
  { width: 1440, height: 1024, field: { width: 60, height: 32 }, font: '13px', padding: '10px' },
  { width: 768, height: 1024, field: { width: 72, height: 44 }, font: '13px', padding: '12px' },
  { width: 375, height: 812, field: { width: 80, height: 44 }, font: '16px', padding: '12px' },
] as const;

/**
 * The quick switch's typed status and delay (issue #61, D158), at each of the
 * widths above: the text, the placeholder while empty, is centred; the border
 * is `--color-line` while the field is untouched, `--color-line-strong` while
 * it holds a valid value, and `--color-danger` while it holds an invalid one or
 * has been typed into and then cleared; the field's size, padding, weight and
 * font size are D157's. The response button is outlined in
 * `--color-line-strong` at each width too, and the Response queue section
 * sits below its own `--color-line-section` line, collapsed the first time to
 * its heading row, which is a 44 px touch target below 1024 px (issue #142,
 * D206).
 *
 * Nothing is applied: each opening is closed with Escape, which drops what was
 * typed, and the button's label is checked unchanged after it. The window is
 * then set back to the test's own viewport.
 */
async function checkTypedFields(
  page: Page,
  button: Locator,
  viewport: { width: number; height: number } | null,
): Promise<void> {
  if (viewport === null) {
    throw new Error('E2E-02 runs at the project viewport, which it restores here');
  }

  const quick = page.getByRole('dialog', { name: 'Session response', exact: true });
  const label = (await button.textContent()) ?? '';
  const fields = [
    { name: 'Other status', placeholder: 'Other', valid: '202', invalid: '700' },
    { name: 'Delay in milliseconds', placeholder: 'ms', valid: '1500', invalid: '40000' },
  ] as const;

  for (const layout of TYPED_FIELD_LAYOUTS) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await expect(button, `response button at ${layout.width} px`).toHaveCSS(
      'border-color',
      LINE_STRONG,
    );
    await expect(button, `response button at ${layout.width} px`).toHaveText(label);

    await button.click();
    await expect(quick).toBeVisible();

    const section = quick.getByRole('region', { name: 'Response queue' });
    const toggle = section.getByRole('button', { name: /^Response queue/ });
    const sectionAt = `the Response queue section at ${layout.width} px`;

    await expect(section, sectionAt).toHaveCSS('border-top-color', LINE_SECTION);
    await expect(section, sectionAt).toHaveCSS('border-top-width', '1px');
    await expect(toggle, sectionAt).toHaveAttribute('aria-expanded', 'false');
    // Named by its title alone, by reference, so that no browser reads the
    // example chips beside it, which only illustrate, into its name.
    await expect(toggle, sectionAt).toHaveAccessibleName('Response queue');
    await expect(toggle, sectionAt).toHaveAttribute('aria-labelledby', QUEUE_TITLE_ID);
    await expect(section.getByRole('button', { name: 'Set up a queue…' })).toHaveCount(0);

    if (layout.width < 1024) {
      expect((await toggle.boundingBox())?.height, sectionAt).toBe(44);
    }

    // The Response rules section under it, drawn as it is (issue #226, R2,
    // RT1, RP1): its own line, collapsed the first time, named by its title.
    const rulesSection = quick.getByRole('region', { name: 'Response rules' });
    const rulesToggle = rulesSection.getByRole('button', { name: /^Response rules/ });
    const rulesAt = `the Response rules section at ${layout.width} px`;

    await expect(rulesSection, rulesAt).toHaveCSS('border-top-color', LINE_SECTION);
    await expect(rulesSection, rulesAt).toHaveCSS('border-top-width', '1px');
    await expect(rulesToggle, rulesAt).toHaveAttribute('aria-expanded', 'false');
    await expect(rulesToggle, rulesAt).toHaveAccessibleName('Response rules');
    await expect(rulesSection.getByRole('button', { name: 'Set up rules…' })).toHaveCount(0);

    if (layout.width < 1024) {
      expect((await rulesToggle.boundingBox())?.height, rulesAt).toBe(44);
    }

    await quick.getByRole('radio', { name: 'Custom' }).click();

    for (const { name, placeholder, valid, invalid } of fields) {
      const field = quick.getByRole('textbox', { name });
      const at = `${name} at ${layout.width} px`;

      // Untouched: the placeholder shows, centred, inside the container line.
      await expect(field, at).toHaveValue('');
      await expect(field, at).toHaveAttribute('placeholder', placeholder);
      await expect(field, at).toHaveCSS('text-align', 'center');
      expect(
        await field.evaluate((element) => getComputedStyle(element, '::placeholder').textAlign),
        at,
      ).toBe('center');
      await expect(field, at).toHaveCSS('border-color', LINE);

      // Unchanged by #61: the size, the padding, the weight and the font size.
      const box = await field.boundingBox();

      expect(box && { width: Math.round(box.width), height: Math.round(box.height) }, at).toEqual(
        layout.field,
      );
      await expect(field, at).toHaveCSS('font-size', layout.font);
      await expect(field, at).toHaveCSS('font-weight', '400');
      await expect(field, at).toHaveCSS('padding-left', layout.padding);
      await expect(field, at).toHaveCSS('padding-right', layout.padding);

      // A valid value: the controls' line, centred.
      await field.fill(valid);
      await expect(field, at).toHaveAttribute('aria-invalid', 'false');
      await expect(field, at).toHaveCSS('border-color', LINE_STRONG);
      await expect(field, at).toHaveCSS('text-align', 'center');

      // An invalid one: the danger colour, as before.
      await field.fill(invalid);
      await expect(field, at).toHaveAttribute('aria-invalid', 'true');
      await expect(field, at).toHaveCSS('border-color', DANGER);
      await expect(field, at).toHaveCSS('text-align', 'center');

      // Typed into and then cleared: invalid too, so red, not the untouched line.
      await field.fill('');
      await expect(field, at).toHaveAttribute('aria-invalid', 'true');
      await expect(field, at).toHaveCSS('border-color', DANGER);

      await field.fill(valid);
      await expect(field, at).toHaveCSS('border-color', LINE_STRONG);
    }

    await page.keyboard.press('Escape');
    await expect(quick).toBeHidden();
    await expect(button, `response button at ${layout.width} px`).toHaveText(label);
  }

  await page.setViewportSize(viewport);
}

const EDITED_BODY = '{"source":"e2e","edited":true}';
const UNSAVED_BODY = '{"source":"e2e","unsaved":true}';

/**
 * How far the top of the last word of `words`, at the end of the element's
 * text, sits below the top of its first word, in whole pixels: 0 while they
 * share a line. Run in the page.
 */
function lastWordsTopOffset(element: Element, words: string): number {
  const text = element.firstChild;
  const content = text?.textContent ?? '';

  if (text === null || !content.endsWith(words)) {
    throw new Error(`the text does not end with ${words}`);
  }

  const range = document.createRange();
  const topOf = (start: number, end: number): number => {
    range.setStart(text, start);
    range.setEnd(text, end);

    return range.getBoundingClientRect().top;
  };
  const first = content.length - words.length;
  const last = content.lastIndexOf(' ') + 1;

  return Math.round(topOf(last, content.length) - topOf(first, first + 1));
}

/**
 * Runs `whileHeld` with every response change held in flight, then lets the
 * held change fail with a `500`, as a server fault would. What it checks runs
 * while the change is still unanswered, which is the window in which a surface
 * must not close.
 */
async function failWhileHeld(page: Page, whileHeld: () => Promise<void>): Promise<void> {
  const pattern = '**/api/sessions/*/response';
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const answered: Promise<void>[] = [];

  await page.route(pattern, (route) => {
    const answer = (async () => {
      await released;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 1500, message: 'Internal server error' }),
      });
    })();

    answered.push(answer);

    return answer;
  });

  try {
    await whileHeld();
  } finally {
    release();
  }

  // Exactly one change was held; it is answered before the route is removed.
  await Promise.all(answered);
  expect(answered).toHaveLength(1);
  await page.unroute(pattern);
}

/**
 * Holds the page's next `Run again` (`POST /api/sessions/:id/queue/restart`)
 * in flight until `release`, which fails it with a `500`, as a server fault
 * would, and removes the route once it is answered. A restart sent through
 * the `request` fixture goes to the backend directly and is not held.
 */
async function holdRestart(page: Page): Promise<{ release: () => Promise<void> }> {
  const pattern = '**/api/sessions/*/queue/restart';
  let open: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  const answered: Promise<void>[] = [];

  await page.route(pattern, (route) => {
    const answer = (async () => {
      await released;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 1500, message: 'Internal server error' }),
      });
    })();

    answered.push(answer);

    return answer;
  });

  return {
    async release() {
      open();
      await expect.poll(() => answered.length).toBe(1);
      await Promise.all(answered);
      await page.unroute(pattern);
    },
  };
}

/**
 * Holds the page's next `Save queue` or `Save rules` (`PUT
 * /api/sessions/:id/queue` or `…/rules`) in flight until `release`, which
 * lets it through to the server (`pass`) or fails it with a `500`, as a
 * server fault would (`fail`), and removes the route once it is answered;
 * exactly one save must have been held. A queue's removal (`DELETE`) is not
 * held.
 */
async function holdSave(
  page: Page,
  list: 'queue' | 'rules',
): Promise<{ release: (outcome: 'pass' | 'fail') => Promise<void> }> {
  const pattern = `**/api/sessions/*/${list}`;
  let open: (outcome: 'pass' | 'fail') => void = () => undefined;
  const released = new Promise<'pass' | 'fail'>((resolve) => {
    open = resolve;
  });
  const answered: Promise<void>[] = [];

  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();

      return;
    }

    const answer = (async () => {
      if ((await released) === 'pass') {
        await route.fallback();

        return;
      }

      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 1500, message: 'Internal server error' }),
      });
    })();

    answered.push(answer);
    await answer;
  });

  return {
    async release(outcome) {
      open(outcome);
      await expect.poll(() => answered.length).toBe(1);
      await Promise.all(answered);
      expect(answered).toHaveLength(1);
      await page.unroute(pattern);
    },
  };
}

/**
 * Each text field's own computed `opacity` (issue #250): `0.6` while a save
 * in flight locks it, as the dialog's other locked controls are drawn, and
 * `1` otherwise. Read on the element that carries the class: an ancestor's
 * opacity dims what it holds without changing the holder's computed value.
 */
async function expectOpacity(fields: readonly Locator[], opacity: '0.6' | '1'): Promise<void> {
  for (const field of fields) {
    await expect(field).toHaveCSS('opacity', opacity);
  }
}

/**
 * The Response queue dialog's save, held in flight, leaves nothing to edit
 * (issue #234, as the Response rules dialog since #226): what the dialog
 * shows is what it sends. Entered with step 1 at `503`, the session's header
 * and body copied into it, and left with the dialog closing on that one step.
 *
 * A second step, `404`, is added, and `Save queue`, double-clicked, is held
 * by a route - one `PUT`: the selected step's fields, `Duplicate`, `Remove
 * step`, `+ Add step`, `Cancel` and the close control are disabled, and a
 * click into the status, a key typed and Enter and Space, and clicks on the
 * two links change nothing; step 1 can still be selected, its fields
 * disabled too. The status, the delay, header 1's name and value and the
 * body are drawn at 60 % while disabled, at 100 % again once the save is
 * answered (issue #250). Failed with a `500`, the dialog says so with `Try
 * again` and gives every control back, both steps kept. Step 2 removed, `Try
 * again` is held the same way, and at 375 px step 1 opens as a screen of its
 * own with its fields, drawn at 60 %, `Duplicate step` and `Remove step`
 * disabled, `‹` and `Done` still going back to the list. Failed there too,
 * the step's screen gives its fields back at 100 %. Back at the project size,
 * `Try again`, held once more, is let through to the server.
 */
async function saveQueueWhileLocked(
  page: Page,
  queue: Locator,
  viewport: { width: number; height: number },
): Promise<void> {
  const rows = queue
    .getByRole('list', { name: 'Steps' })
    .getByRole('button', { name: /^Step \d+:/ });
  const status = queue.getByLabel('HTTP status');
  const duplicate = queue.getByRole('button', { name: 'Duplicate', exact: true });
  const removeStep = queue.getByRole('button', { name: 'Remove step', exact: true });
  // The step's text fields, drawn at 60 % while disabled (issue #250).
  const textFields = [
    status,
    queue.getByLabel('Delay (ms)'),
    queue.getByRole('textbox', { name: 'Header 1 name' }),
    queue.getByRole('textbox', { name: 'Header 1 value' }),
    queue.getByLabel('Body · Optional'),
  ];
  // The step's own fields, on the editor beside the list and on a phone's
  // step screen alike.
  const fields = [
    ...textFields,
    queue.getByRole('button', { name: '+ Add header' }),
    queue.getByRole('button', { name: 'Remove header 1', exact: true }),
  ];
  // Every control of the dialog from 768 px up that changes the steps or
  // leaves them.
  const controls = [
    ...fields,
    duplicate,
    removeStep,
    queue.getByRole('button', { name: '+ Add step' }),
    queue.getByRole('button', { name: 'Cancel', exact: true }),
    queue.getByRole('button', { name: 'Close', exact: true }),
  ];
  const expectControls = async (state: 'disabled' | 'enabled') => {
    for (const control of controls) {
      if (state === 'disabled') {
        await expect(control).toBeDisabled();
      } else {
        await expect(control).toBeEnabled();
      }
    }

    await expectOpacity(textFields, state === 'disabled' ? '0.6' : '1');
  };
  // What a viewer might do while the save waits: a disabled field takes no
  // focus, so nothing typed reaches it, and a disabled link takes no click.
  const tryToEdit = async () => {
    await status.click({ force: true });
    await page.keyboard.type('9');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await duplicate.click({ force: true });
    await removeStep.click({ force: true });
  };

  await queue.getByRole('button', { name: '+ Add step' }).click();
  await expect(queue.getByRole('heading', { name: 'Step 2', exact: true })).toBeVisible();
  await status.fill('404');
  await expect(rows).toHaveCount(2);

  let save = await holdSave(page, 'queue');

  // A double click is one save: the first click disables the button.
  await queue.getByRole('button', { name: 'Save queue' }).dblclick();
  await expect(queue.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  // The fields are in a group named by the step's heading.
  await expect(queue.getByRole('group', { name: 'Step 2', exact: true })).toBeVisible();
  await expectControls('disabled');
  await tryToEdit();
  await expect(rows).toHaveCount(2);
  await expect(status).toHaveValue('404');

  // Another step can still be selected, and shows read only too.
  await rows.first().click();
  await expect(queue.getByRole('group', { name: 'Step 1', exact: true })).toBeVisible();
  await expect(status).toHaveValue('503');
  await expectControls('disabled');

  // Failed, every control is given back, with every step as it was.
  await save.release('fail');
  await expect(
    queue.getByText('Could not save the queue. Your steps are kept — try again.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Try again' })).toBeEnabled();
  await expectControls('enabled');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAccessibleName(/^Step 1: 503 /);
  await expect(rows.nth(1)).toHaveAccessibleName(/^Step 2: 404 /);
  await expect(status).toHaveValue('503');

  await rows.nth(1).click();
  await expect(status).toHaveValue('404');
  await removeStep.click();
  await expect(rows).toHaveCount(1);
  await expect(status).toHaveValue('503');

  save = await holdSave(page, 'queue');
  await queue.getByRole('button', { name: 'Try again' }).click();
  await expect(queue.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await expectControls('disabled');
  await tryToEdit();
  await expect(rows).toHaveCount(1);
  await expect(status).toHaveValue('503');

  // On a phone the step opens as a screen of its own, read only, and `‹`
  // and `Done` still go back to the list.
  await page.setViewportSize({ width: 375, height: 812 });
  await rows.first().click();
  await expect(queue.getByRole('group', { name: 'Step 1 of 1', exact: true })).toBeVisible();

  for (const control of [
    ...fields,
    queue.getByRole('button', { name: 'Duplicate step', exact: true }),
    queue.getByRole('button', { name: 'Remove step', exact: true }),
  ]) {
    await expect(control).toBeDisabled();
  }

  await expectOpacity(textFields, '0.6');
  await queue.getByRole('button', { name: 'Back to the steps' }).click();
  await expect(status).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(status).toBeDisabled();
  await expect(status).toHaveValue('503');
  await queue.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(status).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(queue.getByRole('button', { name: 'Saving…' })).toBeDisabled();

  // Failed on the phone, the step's screen gives its fields back, drawn as
  // before the save (issue #250).
  await save.release('fail');
  await expect(
    queue.getByText('Could not save the queue. Your steps are kept — try again.', {
      exact: true,
    }),
  ).toBeVisible();
  await rows.first().click();
  await expect(queue.getByRole('group', { name: 'Step 1 of 1', exact: true })).toBeVisible();

  for (const field of fields) {
    await expect(field).toBeEnabled();
  }

  await expectOpacity(textFields, '1');
  await queue.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(status).toHaveCount(0);

  await page.setViewportSize(viewport);
  save = await holdSave(page, 'queue');
  await queue.getByRole('button', { name: 'Try again' }).click();
  await expect(queue.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await save.release('pass');
}

/**
 * The second half of E2E-02 (issue #36, D150-D153): the response of the running
 * session is changed from the endpoint card, with no new session, and every
 * change is observed where it matters - in what the sender receives next, and
 * in a second viewer that only its own socket can have told (D152).
 *
 * Inside this journey rather than a fourth one (D108): its subject is the
 * configured response, and it continues from the session this journey created.
 */
async function changeTheRunningResponse(
  page: Page,
  request: APIRequestContext,
  browser: Browser,
  receiveUrl: string,
  baseURL: string | undefined,
  viewport: { width: number; height: number } | null,
): Promise<void> {
  // A second viewer in an independent context: nothing is shared with the
  // acting page but the server, so its label can only follow over its socket.
  const observingContext = await browser.newContext({ baseURL, viewport });

  try {
    const observer = await observingContext.newPage();
    const observerFrames = collectRealtimeFrames(observer);

    await observer.goto(new URL(page.url()).pathname);
    await expect
      .poll(() => observerFrames.some((frame) => frame.includes('"type":"ready"')))
      .toBe(true);
    await observer.evaluate(() => {
      (window as unknown as { __notReloaded?: boolean }).__notReloaded = true;
    });

    const button = page.getByRole('button', { name: /Response settings/ });

    await expect(button).toHaveText(`Custom · 201 · ${DELAY_MS} ms`);

    // C1-C3: the quick switch. 500 and no delay, applied.
    await button.click();

    const quick = page.getByRole('dialog', { name: 'Session response', exact: true });

    await expect(quick).toBeVisible();
    // C6: 204 is unavailable while a body is set, and says why.
    await expect(quick.getByRole('button', { name: '204', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await quick.getByRole('button', { name: '204', exact: true }).hover();
    await expect(quick.getByRole('tooltip')).toHaveText(
      '204 needs an empty body — clear the body first.',
    );

    await quick.getByRole('button', { name: '500', exact: true }).click();
    await quick.getByRole('button', { name: 'None', exact: true }).click();
    await expect(quick).toContainText(`201 → 500 · ${DELAY_MS} ms → none`);
    await quick.getByRole('button', { name: 'Apply' }).click();

    await expect(quick).toBeHidden();
    await expect(page.getByTestId('toast')).toHaveText(
      'Response is now 500, no delay. Requests captured from now on get it.',
    );
    await expect(button).toHaveText('Custom · 500');

    // The other viewer follows without a reload (D152).
    const observerButton = observer.getByRole('button', { name: /Response settings/ });
    const updatesSeen = () =>
      observerFrames.filter((frame) => frame.includes('"type":"session.updated"')).length;

    await expect(observerButton).toHaveText('Custom · 500');
    expect(updatesSeen()).toBe(1);

    // What the sender gets next: the new status, the kept header and body.
    const failed = await request.post(receiveUrl);

    expect(failed.status()).toBe(500);
    expect(headerValue(failed, 'X-E2E-Test')).toBe('custom-response');
    expect(await failed.text()).toBe(BODY);
    await expect(requestRow(page, storedRequestId(failed))).toBeVisible();

    // D1-D3: the full editor, reached from the quick switch's link.
    await button.click();
    await quick.getByRole('button', { name: 'Edit headers and body…' }).click();

    const editor = page.getByRole('dialog', { name: 'Session response settings' });

    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('HTTP status')).toHaveValue('500');
    await expect(editor.getByRole('textbox', { name: 'Header 1 name' })).toHaveValue('X-E2E-Test');
    await editor.getByRole('textbox', { name: 'Header 1 value' }).fill('edited');
    await editor.getByLabel('Body · Optional').fill(EDITED_BODY);
    await editor.getByRole('button', { name: 'Save response' }).click();

    await expect(editor).toBeHidden();
    await expect(page.getByTestId('toast')).toHaveText(
      'Saved. Requests captured from now on get this response.',
    );

    const edited = await request.post(receiveUrl);

    expect(edited.status()).toBe(500);
    expect(headerValue(edited, 'X-E2E-Test')).toBe('edited');
    expect(await edited.text()).toBe(EDITED_BODY);
    // The label reads the same, so the observer's second change is its frame.
    await expect.poll(updatesSeen).toBe(2);
    await expect(observerButton).toHaveText('Custom · 500');

    // C7/C8 and D7/D8: nothing closes a surface while its change is in flight,
    // so a failure is shown with the choice and the edits still in place.
    await failWhileHeld(page, async () => {
      await button.click();
      await quick.getByRole('button', { name: '404', exact: true }).click();
      await quick.getByRole('button', { name: 'Apply' }).click();
      await expect(quick.getByRole('button', { name: 'Applying…' })).toBeDisabled();
      await page.keyboard.press('Escape');
      await page.mouse.click(200, 900);
      await expect(quick).toBeVisible();
    });
    await expect(quick.getByRole('alert')).toContainText('Could not apply the change');
    // Apply, disabled in flight, dropped its focus to the page's body, where
    // the click outside left it; it comes back on Apply, now Try again
    // (issue #143, D206).
    await expect(quick.getByRole('button', { name: 'Try again' })).toBeFocused();
    await expect(quick.getByRole('button', { name: '404', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press('Escape');
    await expect(quick).toBeHidden();

    await failWhileHeld(page, async () => {
      await button.click();
      await quick.getByRole('button', { name: 'Edit headers and body…' }).click();
      await editor.getByLabel('Body · Optional').fill(UNSAVED_BODY);
      await editor.getByRole('button', { name: 'Save response' }).click();
      await expect(editor.getByRole('button', { name: 'Saving…' })).toBeDisabled();

      // Only the editor's buttons wait for the save: its fields are drawn as
      // before, neither dimmed nor filled (issue #250).
      const editorInputs = [
        editor.getByLabel('HTTP status'),
        editor.getByLabel('Delay (ms)'),
        editor.getByRole('textbox', { name: 'Header 1 name' }),
        editor.getByRole('textbox', { name: 'Header 1 value' }),
      ];

      await expectOpacity([...editorInputs, editor.getByLabel('Body · Optional')], '1');

      for (const field of editorInputs) {
        await expect(field).toBeEnabled();
        await expect(field).toHaveCSS('background-color', WHITE);
      }

      await page.keyboard.press('Escape');
      // The overlay, beside the modal.
      await page.mouse.click(20, 500);
      await expect(editor).toBeVisible();
    });
    await expect(editor.getByRole('alert')).toContainText('Could not save the response');
    await expect(editor.getByLabel('Body · Optional')).toHaveValue(UNSAVED_BODY);
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toBeHidden();
    await expect(button).toHaveText('Custom · 500');

    // C4: Default keeps the custom response...
    await button.click();
    await quick.getByRole('radio', { name: 'Default' }).click();
    await expect(quick).toContainText(
      'Your custom response stays saved — 500 · no delay · 1 header · body — and comes back when you switch to Custom.',
    );
    await quick.getByRole('button', { name: 'Apply' }).click();
    await expect(button).toHaveText('Default · 200');
    await expect(observerButton).toHaveText('Default · 200');
    await expect.poll(updatesSeen).toBe(3);

    const answeredDefault = await request.post(receiveUrl);
    const defaultId = storedRequestId(answeredDefault);

    expect(answeredDefault.status()).toBe(200);
    expect(headerValue(answeredDefault, 'X-E2E-Test')).toBeUndefined();

    // Today's default: `ok` and `requestId`, then what was stored, and its
    // link in the inspector (D223).
    const defaultAnswer = (await answeredDefault.json()) as Record<string, unknown>;
    const receivePath = new URL(receiveUrl).pathname;

    expect(Object.keys(defaultAnswer)).toEqual([
      'ok',
      'requestId',
      'message',
      'inspectorUrl',
      'receivedAt',
      'method',
      'path',
      'bodySize',
      'sourceIp',
    ]);
    expect(defaultAnswer).toMatchObject({
      ok: true,
      requestId: defaultId,
      message: 'Captured by QA Tools',
      method: 'POST',
      path: receivePath,
      bodySize: 0,
    });
    expect(String(defaultAnswer.inspectorUrl)).toMatch(
      new RegExp(`/v/${receivePath.split('/')[2]}#${defaultId}$`),
    );

    // ...and switching back to Custom restores it.
    await button.click();
    await quick.getByRole('radio', { name: 'Custom' }).click();
    await quick.getByRole('button', { name: 'Apply' }).click();
    await expect(button).toHaveText('Custom · 500');
    await expect(observerButton).toHaveText('Custom · 500');
    // Four changes saved, four frames: the two refused saves published nothing.
    await expect.poll(updatesSeen).toBe(4);

    const restored = await request.post(receiveUrl);

    expect(restored.status()).toBe(500);
    expect(headerValue(restored, 'X-E2E-Test')).toBe('edited');
    expect(await restored.text()).toBe(EDITED_BODY);

    // The response queue's happy path (issue #106, D205): from the quick
    // switch's section, a queue of one step - a copy of the session response
    // with 503 - answers the next request, then the session response again.
    // The label, the other viewer and the Response tab follow with no reload.
    // The section starts collapsed to its heading row, which opens it, and
    // is remembered open or closed in this browser (issue #142, D206).
    await button.click();

    const queueToggle = quick.getByRole('button', { name: /^Response queue/ });

    await expect(queueToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(quick.getByRole('button', { name: 'Set up a queue…' })).toBeHidden();
    await queueToggle.click();
    await expect(queueToggle).toHaveAttribute('aria-expanded', 'true');
    await quick.getByRole('button', { name: 'Set up a queue…' }).click();

    const queue = page.getByRole('dialog', { name: 'Response queue' });

    await expect(queue).toBeVisible();
    await expect(queue.getByRole('button', { name: 'Save queue' })).toBeDisabled();
    await queue.getByRole('button', { name: '+ Add step' }).click();
    await expect(queue.getByLabel('HTTP status')).toHaveValue('500');
    await queue.getByLabel('HTTP status').fill('503');

    if (viewport === null) {
      throw new Error('E2E-02 runs at the project viewport, which it restores here');
    }

    // Saved through three held saves, the first two failed, the steps read
    // only while each waits (issue #234) and drawn so (issue #250); the
    // third, let through, closes it.
    await saveQueueWhileLocked(page, queue, viewport);

    await expect(queue).toBeHidden();
    await expect(page.getByTestId('toast')).toHaveText(
      'Queue saved. The next request gets 503, then the custom response.',
    );
    await expect(button).toHaveText('Custom · 500 · 1 queued');
    await expect(observerButton).toHaveText('Custom · 500 · 1 queued');
    await expect.poll(updatesSeen).toBe(5);

    const queued = await request.post(receiveUrl);

    expect(queued.status()).toBe(503);
    expect(headerValue(queued, 'X-E2E-Test')).toBe('edited');
    expect(await queued.text()).toBe(EDITED_BODY);
    await expect(button).toHaveText('Custom · 500');
    await expect(observerButton).toHaveText('Custom · 500');

    await requestRow(page, storedRequestId(queued)).click();
    await page.getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByTestId('response-queue-step')).toHaveText('Queue step 1 of 1');

    const afterQueue = await request.post(receiveUrl);

    expect(afterQueue.status()).toBe(500);
    // A capture that took a step publishes no session.updated (D205).
    expect(updatesSeen()).toBe(5);

    // The used-up queue removed from the quick switch's section (issue #142,
    // D206): the section opens as it was left, asks once in place of its
    // links, and once removed shows no queue with the quick switch still open.
    await button.click();
    await expect(queueToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(queueToggle).toHaveAccessibleName('Response queue Done');

    // Focus that went with a control disabled in flight or gone stays in the
    // quick switch (issue #143, D206). A failed Run again: Run again, which
    // Chromium's disabling dropped it from, has it again, beside its message.
    const sessionId = await sessionIdFromPage(page);
    const restartElsewhere = async () => {
      const restarted = await request.post(`/api/sessions/${sessionId}/queue/restart`);

      expect(restarted.status()).toBe(200);
    };
    const runAgain = quick.getByRole('button', { name: 'Run again' });
    const starting = quick.getByRole('button', { name: 'Starting…' });
    const restartFailed = quick.getByText('Could not start the queue again. Try again.', {
      exact: true,
    });
    const english = page
      .getByRole('banner')
      .getByTestId('language-switch')
      .getByRole('button', { name: /^EN/ });
    let restart = await holdRestart(page);

    await runAgain.click();
    await expect(starting).toBeDisabled();
    await restart.release();
    await expect(restartFailed).toBeVisible();
    await expect(runAgain).toBeFocused();

    // Run again from the keyboard, the viewer then focusing the language
    // switch while it is in flight: focus the viewer put on a control stays.
    restart = await holdRestart(page);
    await page.keyboard.press('Enter');
    await expect(starting).toBeDisabled();
    await english.focus();
    await restart.release();
    await expect(restartFailed).toBeVisible();
    await expect(english).toBeFocused();
    // Neither failed restart reached the server.
    expect(updatesSeen()).toBe(5);

    // Run again gone with the focus: another viewer's restart starts the
    // used-up queue from step 1 (D205), and focus goes to the heading row.
    await runAgain.focus();
    await restartElsewhere();
    await expect(queueToggle).toHaveAccessibleName('Response queue Step 1 of 1');
    await expect(runAgain).toHaveCount(0);
    await expect(restartFailed).toHaveCount(0);
    await expect(queueToggle).toBeFocused();
    await expect.poll(updatesSeen).toBe(6);
    expect((await request.post(receiveUrl)).status()).toBe(503);
    await expect(queueToggle).toHaveAccessibleName('Response queue Done');

    // Run again failing after another viewer's restart arrived during the
    // call: no message, Run again gone, the queue running, focus on the
    // heading row. Held, a click on the popover's background focuses the
    // popover itself, its content carrying tabindex="-1" (D206).
    restart = await holdRestart(page);
    await runAgain.click();
    await expect(starting).toBeDisabled();
    await quick.getByRole('heading', { name: 'Session response', exact: true }).click();
    await expect(quick).toBeFocused();
    await restartElsewhere();
    await expect(queueToggle).toHaveAccessibleName('Response queue Step 1 of 1');
    await expect(queueToggle).toBeFocused();
    await restart.release();
    await expect(quick.getByRole('button', { name: 'Edit queue…' })).toBeEnabled();
    await expect(restartFailed).toHaveCount(0);
    await expect(runAgain).toHaveCount(0);
    await expect(queueToggle).toBeFocused();
    await expect.poll(updatesSeen).toBe(7);
    expect((await request.post(receiveUrl)).status()).toBe(503);
    await expect(queueToggle).toHaveAccessibleName('Response queue Done');
    // A capture that took a step publishes no session.updated (D205).
    expect(updatesSeen()).toBe(7);

    const removeQueue = quick.getByRole('button', { name: 'Remove queue' });
    const keepQueue = quick.getByRole('button', { name: 'Keep queue' });
    const question = quick.getByText('Remove the step?', { exact: true });
    const remove = quick.getByRole('button', { name: 'Remove', exact: true });
    // Every removal this page sends, the failed one included.
    const removals: string[] = [];
    const countRemoval = (sent: Request) => {
      if (sent.method() === 'DELETE' && sent.url().endsWith('/queue')) {
        removals.push(sent.url());
      }
    };

    page.on('request', countRemoval);

    await removeQueue.click();
    await expect(question).toBeVisible();
    await expect(keepQueue).toBeFocused();
    // Keep queue puts the links back, focus on the Remove queue that asked.
    await keepQueue.click();
    await expect(question).toHaveCount(0);
    await expect(quick.getByRole('button', { name: 'Run again' })).toBeVisible();
    await expect(removeQueue).toBeFocused();

    // The question's Remove appears under the pointer that clicked Remove
    // queue (716:383), so neither a double-click on Remove queue nor a second
    // click 300 ms after the first removes the queue: both leave it asked.
    // 300 ms, not 400, keeps about 200 ms of margin under the guard's 500 ms
    // for the input to reach a busy page.
    const at = await removeQueue.boundingBox();

    if (at === null) {
      throw new Error('Remove queue is not drawn');
    }

    const x = at.x + at.width - 8;
    const y = at.y + at.height / 2;

    await page.mouse.dblclick(x, y);
    await expect(question).toBeVisible();
    await expect(remove).toBeEnabled();
    // The second click did land on Remove: the guard, not the layout, kept it.
    expect(
      await page.evaluate(({ px, py }) => document.elementFromPoint(px, py)?.textContent, {
        px: x,
        py: y,
      }),
    ).toBe('Remove');
    await keepQueue.click();
    await expect(question).toHaveCount(0);
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
    await page.mouse.click(x, y);
    await expect(question).toBeVisible();
    await expect(remove).toBeEnabled();
    expect(removals).toHaveLength(0);

    // A deliberate Remove, once the question has been there half a second,
    // does remove; the server failing it once, the row says so in place of
    // the question with Try again, which removes once it answers again.
    const queueRoute = '**/api/sessions/*/queue';
    let answerRemoval: () => void = () => undefined;
    const removalAnswered = new Promise<void>((resolve) => {
      answerRemoval = resolve;
    });
    let failedRemovals = 0;

    await page.route(queueRoute, async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.fallback();

        return;
      }

      failedRemovals += 1;
      await removalAnswered;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 1500, message: 'Internal server error' }),
      });
    });
    await page.waitForTimeout(500);
    await remove.click();
    // Held in flight: Chromium drops the focus of the button it disables to
    // the page's body.
    await expect(quick.getByRole('button', { name: 'Removing…' })).toBeDisabled();
    answerRemoval();

    const tryAgain = quick.getByRole('button', { name: 'Try again' });
    const removalFailed = quick.getByText('Could not remove the queue. Try again.', {
      exact: true,
    });

    await expect(removalFailed).toBeVisible();
    // Where it wraps, `Try again.` keeps together rather than leave `again.`
    // alone on the second line.
    expect(await removalFailed.evaluate(lastWordsTopOffset, 'Try again.')).toBe(0);
    await expect(tryAgain).toBeVisible();
    await expect(keepQueue).toBeVisible();
    // Focus lost while the removal was in flight comes back on Try again.
    await expect(tryAgain).toBeFocused();
    await page.unroute(queueRoute);
    expect(failedRemovals).toBe(1);
    await tryAgain.click();
    await expect(quick.getByRole('button', { name: 'Set up a queue…' })).toBeVisible();
    await expect(removeQueue).toHaveCount(0);
    await expect(quick).toBeVisible();
    await expect(queueToggle).toBeFocused();
    await expect(button).toHaveText('Custom · 500');
    // The failed removal never reached the server: one session.updated.
    await expect.poll(updatesSeen).toBe(8);
    expect(removals).toHaveLength(2);
    page.off('request', countRemoval);

    // Expanded, it is still expanded after a reload, read back from
    // localStorage rather than the page's memory (issue #143)...
    const stored = () => page.evaluate(() => localStorage.getItem('qa-tools:queue-section'));

    await expect.poll(stored).toBe('{"v":1,"open":true}');
    await page.keyboard.press('Escape');
    await expect(quick).toBeHidden();
    await page.reload();
    await button.click();
    await expect(queueToggle).toHaveAttribute('aria-expanded', 'true');

    // ...and collapsed, it stays collapsed after a reload.
    await queueToggle.click();
    await expect(queueToggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(stored).toBe('{"v":1,"open":false}');
    await page.keyboard.press('Escape');
    await expect(quick).toBeHidden();
    await page.reload();
    await button.click();
    await expect(queueToggle).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');

    await setUpResponseRules(page, request, receiveUrl, observerButton, updatesSeen, viewport);

    // Every change reached the observer on the socket it opened at the start.
    expect(
      await observer.evaluate(
        () => (window as unknown as { __notReloaded?: boolean }).__notReloaded,
      ),
    ).toBe(true);
  } finally {
    await observingContext.close();
  }
}

const ORDER_BODY = '{"id":"ord_1"}';
const STATUS_BODY = '{"ok":true}';

/** The rule marker's fill on an unread row, and elsewhere `--color-panel-note` (#233). */
const WHITE = 'rgb(255, 255, 255)';
const NOTE_FILL = 'rgb(238, 241, 246)';

/**
 * The row of a request the rule in `place` answered: `R<place>` drawn after
 * its status, `Answered by rule <place>` as the marker's title and in the
 * row's accessible name, which reads no `R<place>` (issue #233).
 */
async function expectRuleMarker(viewer: Page, requestId: string, place: number): Promise<void> {
  const row = requestRow(viewer, requestId);
  const marker = row.getByTestId('row-rule');

  await expect(marker).toHaveText(`R${place}`);
  await expect(marker).toHaveAttribute('title', `Answered by rule ${place}`);
  await expect(row).toHaveAccessibleName(new RegExp(`\\bAnswered by rule ${place}\\b`));
  await expect(row).not.toHaveAccessibleName(new RegExp(`\\bR${place}\\b`));
}

/**
 * The response rules' happy path (issue #226 over D246), the last part of
 * E2E-02 rather than a journey of its own (D108): from the quick switch's
 * `Response rules` section, collapsed the first time, the Response rules
 * dialog sets up two rules - `POST /orders` → 201 and `GET /status` → 200 -
 * a path with `?` refused at its field first; their order is changed with
 * the arrow keys on `⋮⋮` and back by dragging it; rule 2's GET typed under
 * `Other`, `Save rules`, held and failed once, locks every field and draws
 * each text field at 60 % while it waits (issue #250), then sends the
 * whole list, the label and the other viewer count the rules, a matching
 * request gets its rule's answer and an unmatched one the session response,
 * its list row marks the rule, `R1`, in both viewers (issue #233), the
 * Response tab names the rule or none, and `Remove rules` in the section
 * asks once and removes them.
 */
async function setUpResponseRules(
  page: Page,
  request: APIRequestContext,
  receiveUrl: string,
  observerButton: Locator,
  updatesSeen: () => number,
  viewport: { width: number; height: number } | null,
): Promise<void> {
  if (viewport === null) {
    throw new Error('E2E-02 runs at the project viewport, which it restores here');
  }

  const button = page.getByRole('button', { name: /Response settings/ });
  const quick = page.getByRole('dialog', { name: 'Session response', exact: true });

  await expect(button).toHaveText('Custom · 500');
  expect(updatesSeen()).toBe(8);

  await button.click();

  const rulesToggle = quick.getByRole('button', { name: /^Response rules/ });

  await expect(rulesToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rulesToggle).toHaveAccessibleName('Response rules');
  await rulesToggle.click();
  await expect(rulesToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(quick).toContainText(
    'No rules yet. A request whose method and path match a rule gets its response, before the queue and the session response.',
  );
  await quick.getByRole('button', { name: 'Set up rules…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Response rules' });

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('No rules yet');
  await expect(dialog).toContainText('0 / 20');
  await expect(dialog).toContainText('→ the session response, Custom 500');

  // Rule 1: POST /orders → 201, its body.
  await dialog.getByRole('button', { name: '+ Add rule' }).click();
  await dialog.getByRole('button', { name: 'POST', exact: true }).click();
  await dialog.getByLabel('Path').fill('orders');
  await dialog.getByLabel('HTTP status').fill('201');
  await dialog.getByLabel('Body · Optional').fill(ORDER_BODY);

  // Rule 2: GET, first with a path the API would refuse, said at its field.
  await dialog.getByRole('button', { name: '+ Add rule' }).click();
  await expect(dialog).toContainText('2 / 20');
  await expect(dialog.getByRole('heading', { name: 'Rule 2' })).toBeVisible();
  await expect(dialog).toContainText('checked second');
  await dialog.getByRole('button', { name: 'GET', exact: true }).click();
  await dialog.getByLabel('Path').fill('status?x=1');
  await expect(dialog.getByLabel('Path')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog).toContainText(
    'Leave out ? and what follows it: the query is never matched.',
  );
  await expect(dialog.getByText('Fix rule 2 to save the rules.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save rules' })).toBeDisabled();
  // A / typed first is a path the API takes, //status, so it is said, not refused.
  await dialog.getByLabel('Path').fill('/status');
  await expect(dialog.getByLabel('Path')).toHaveAttribute('aria-invalid', 'false');
  await expect(dialog.getByTestId('rule-path-warning')).toHaveText(
    'The receive URL before the field already ends in /, so this matches only a path that starts with //. Leave out the first / unless you mean two.',
  );
  await dialog.getByLabel('Path').fill('status');
  await expect(dialog.getByTestId('rule-path-warning')).toHaveCount(0);
  await dialog.getByLabel('HTTP status').fill('200');
  await dialog.getByLabel('Body · Optional').fill(STATUS_BODY);
  await expect(dialog.getByRole('button', { name: 'Save rules' })).toBeEnabled();

  const rows = dialog
    .getByRole('list', { name: 'Rules' })
    .getByRole('button', { name: /^Rule \d:/ });

  await expect(rows).toHaveText([/POST\s*\/orders/, /GET\s*\/status/]);

  // The order: Rule 2 a place up from the keyboard, then dragged back down.
  await dialog.getByRole('button', { name: 'Move rule 2' }).focus();
  await page.keyboard.press('ArrowUp');
  await expect(rows).toHaveText([/GET\s*\/status/, /POST\s*\/orders/]);
  await expect(dialog.getByRole('button', { name: 'Move rule 1' })).toBeFocused();
  // The handle's own `cursor-grab` wins over the base rule's hand, which the
  // rule's row beside it shows (issue #246).
  await expect(dialog.getByRole('button', { name: 'Move rule 1' })).toHaveCSS('cursor', 'grab');
  await expect(rows.first()).toHaveCSS('cursor', 'pointer');

  const handle = await dialog.getByRole('button', { name: 'Move rule 1' }).boundingBox();
  const below = await rows.nth(1).boundingBox();

  if (handle === null || below === null) {
    throw new Error('The rules are not drawn');
  }

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, below.y + below.height - 4, { steps: 8 });
  await page.mouse.up();
  await expect(rows).toHaveText([/POST\s*\/orders/, /GET\s*\/status/]);

  // Rule 2's method typed under `Other` this time: GET, the method its chip
  // sends, so the rules saved are the same, with the typed field on screen
  // while the save waits (issue #250).
  const typedMethod = dialog.getByLabel('Other method', { exact: true });

  await dialog.getByRole('button', { name: 'Other', exact: true }).click();
  await typedMethod.fill('GET');
  await expect(rows).toHaveText([/POST\s*\/orders/, /GET\s*\/status/]);

  // Held in flight, the save leaves nothing to edit: what the dialog shows is
  // what it sent, which the saved list closes it on. Every text field is
  // drawn at 60 % while it waits (issue #250): the path's box, the session's
  // URL in it and all, since its input is borderless. The first save fails,
  // giving them back as they were; the second is let through.
  const ruleTextFields = [
    typedMethod,
    dialog.getByLabel('Path').locator('..'),
    dialog.getByLabel('HTTP status'),
    dialog.getByLabel('Delay (ms)'),
    dialog.getByRole('textbox', { name: 'Header 1 name' }),
    dialog.getByRole('textbox', { name: 'Header 1 value' }),
    dialog.getByLabel('Body · Optional'),
  ];
  const lockedControls = [
    dialog.getByRole('button', { name: 'Any', exact: true }),
    dialog.getByRole('button', { name: 'POST', exact: true }),
    typedMethod,
    dialog.getByLabel('Path'),
    dialog.getByLabel('HTTP status'),
    dialog.getByLabel('Body · Optional'),
    dialog.getByRole('button', { name: '+ Add header' }),
    dialog.getByRole('button', { name: 'Duplicate', exact: true }),
    dialog.getByRole('button', { name: 'Remove rule', exact: true }),
    dialog.getByRole('button', { name: '+ Add rule' }),
    dialog.getByRole('button', { name: 'Move rule 1' }),
    dialog.getByRole('button', { name: 'Move rule 2' }),
    dialog.getByRole('button', { name: 'Cancel' }),
  ];
  let save = await holdSave(page, 'rules');

  await dialog.getByRole('button', { name: 'Save rules' }).click();
  await expect(dialog.getByRole('button', { name: 'Saving…' })).toBeDisabled();

  for (const field of lockedControls) {
    await expect(field).toBeDisabled();
  }

  await expectOpacity(ruleTextFields, '0.6');

  // A drag on `⋮⋮` moves nothing either.
  const held = await dialog.getByRole('button', { name: 'Move rule 1' }).boundingBox();

  if (held === null) {
    throw new Error('The rules are not drawn');
  }

  await page.mouse.move(held.x + held.width / 2, held.y + held.height / 2);
  await page.mouse.down();
  await page.mouse.move(held.x + held.width / 2, below.y + below.height - 4, { steps: 8 });
  await page.mouse.up();
  await expect(rows).toHaveText([/POST\s*\/orders/, /GET\s*\/status/]);
  await save.release('fail');
  await expect(
    dialog.getByText('Could not save the rules. Your rules are kept — try again.', {
      exact: true,
    }),
  ).toBeVisible();

  for (const field of lockedControls) {
    await expect(field).toBeEnabled();
  }

  await expectOpacity(ruleTextFields, '1');
  save = await holdSave(page, 'rules');
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await expectOpacity(ruleTextFields, '0.6');
  await save.release('pass');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('toast')).toHaveText(
    '2 rules saved. Requests captured from now on are checked against them first.',
  );
  await expect(button).toHaveText('Custom · 500 · 2 rules');
  // Another tab on the session follows with no reload.
  await expect(observerButton).toHaveText('Custom · 500 · 2 rules');
  await expect.poll(updatesSeen).toBe(9);

  // A matching request gets its rule's answer; an unmatched one the session response.
  const ordered = await request.post(`${receiveUrl}/orders?attempt=1`, { data: '{}' });
  const status = await request.get(`${receiveUrl}/status`);
  const other = await request.post(`${receiveUrl}/other`, { data: '{}' });

  expect(ordered.status()).toBe(201);
  expect(await ordered.text()).toBe(ORDER_BODY);
  expect(status.status()).toBe(200);
  expect(await status.text()).toBe(STATUS_BODY);
  expect(other.status()).toBe(500);
  expect(await other.text()).toBe(EDITED_BODY);
  // A capture publishes no session.updated.
  expect(updatesSeen()).toBe(9);

  // The list marks the rows a rule answered with its place, `R1` and `R2`,
  // here and, with no reload, in the other viewer; the third row, and every
  // row the queue or the session response answered before, show none. Unread,
  // the tag is white on the row's shading (issue #233).
  const observer = observerButton.page();
  const orderedId = storedRequestId(ordered);
  const statusId = storedRequestId(status);
  const otherId = storedRequestId(other);
  const ruleMarker = (viewer: Page, id: string) => requestRow(viewer, id).getByTestId('row-rule');

  for (const viewer of [page, observer]) {
    await expectRuleMarker(viewer, orderedId, 1);
    await expectRuleMarker(viewer, statusId, 2);
    await expect(requestRow(viewer, otherId)).toBeVisible();
    await expect(ruleMarker(viewer, otherId)).toHaveCount(0);
    await expect(requestRow(viewer, otherId)).not.toHaveAccessibleName(/Answered by rule/);
    await expect(viewer.getByTestId('row-rule')).toHaveCount(2);
    await expect(ruleMarker(viewer, orderedId)).toHaveCSS('background-color', WHITE);
  }

  // On the desktop the tag sits 4 px after the pill, 8 px before the address,
  // as tall as the pill, and the row stays 57 px and its rule.
  const desktopRow = await measureTouchRow(page, orderedId);

  expect(desktopRow.rowHeight).toBeCloseTo(58, 0);
  expect(desktopRow.rule?.height).toBeCloseTo(14, 0);
  expect(desktopRow.rule?.top).toBeCloseTo(desktopRow.statusTop, 0);
  expect((desktopRow.rule?.left ?? 0) - desktopRow.statusRight).toBeCloseTo(4, 0);
  expect(desktopRow.addressLeft - (desktopRow.rule?.right ?? 0)).toBeCloseTo(8, 0);
  expect(desktopRow.clipped).toEqual([]);

  // The Response tab names the rule that answered, and none for the other.
  await requestRow(page, orderedId).click();
  await page.getByRole('tab', { name: 'Response' }).click();
  await expect(page.getByTestId('response-rule')).toHaveText('Rule 1 · POST /orders');
  await requestRow(page, statusId).click();
  await page.getByRole('tab', { name: 'Response' }).click();
  await expect(page.getByTestId('response-rule')).toHaveText('Rule 2 · GET /status');
  // Selected, and once read, the tag keeps its own fill (#233).
  await expect(ruleMarker(page, statusId)).toHaveCSS('background-color', NOTE_FILL);
  await expect(ruleMarker(page, orderedId)).toHaveCSS('background-color', NOTE_FILL);
  await requestRow(page, otherId).click();
  await page.getByRole('tab', { name: 'Response' }).click();
  await expect(page.getByTestId('response-status')).toHaveText('500 Internal Server Error');
  await expect(page.getByTestId('response-rule')).toHaveCount(0);
  await expect(page.getByTestId('response-queue-step')).toHaveCount(0);
  await expect(ruleMarker(page, statusId)).toHaveCSS('background-color', NOTE_FILL);
  // Opened here, the requests are still unread in the other viewer.
  await expect(ruleMarker(observer, statusId)).toHaveCSS('background-color', WHITE);

  // At 320 px nothing scrolls sideways: the sheet's section and the rules
  // full screen (issue #226). The page opened on the list, no request open.
  const noSidewaysScroll = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
  const sessionPath = new URL(page.url()).pathname;

  // First the list's worst case at 320 px (#233, frame N1): rule 20 and a
  // long IPv6 sender beside a 404 and 1018.4 KB, the list's answer rewritten
  // for that one row. Only the address may be cut; the marker, the size, the
  // time and the `×` keep theirs (D157).
  const listRoute = '**/api/sessions/*/requests';

  await page.route(listRoute, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();

      return;
    }

    const response = await route.fetch();
    const items = (await response.json()) as RequestListItem[];

    await route.fulfill({
      response,
      json: items.map((item) =>
        item.id === orderedId && item.response !== null
          ? {
              ...item,
              sourceIp: '2a02:6b8:b010:a4fc::1f5',
              bodySize: 1_042_841,
              response: { ...item.response, status: 404, rule: { index: 20 } },
            }
          : item,
      ),
    });
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(sessionPath);
  await expect(ruleMarker(page, orderedId)).toHaveText('R20');
  await expect(requestRow(page, orderedId)).toContainText('1018.4 KB');

  for (const id of [orderedId, statusId]) {
    const phoneRow = await measureTouchRow(page, id);

    expect(phoneRow.rowHeight).toBeCloseTo(76, 0);
    expect(phoneRow.rowRight - phoneRow.timeRight).toBeCloseTo(16, 0);
    expect(Math.abs(phoneRow.glyphRight - phoneRow.timeRight)).toBeLessThanOrEqual(1);
    expect(phoneRow.deleteTop).toBeGreaterThanOrEqual(phoneRow.line1Bottom);
    expect(phoneRow.line2Right).toBeLessThanOrEqual(phoneRow.deleteLeft);
    expect(phoneRow.rule?.height).toBeCloseTo(14, 0);
    expect(phoneRow.rule?.top).toBeCloseTo(phoneRow.statusTop, 0);
    expect((phoneRow.rule?.left ?? 0) - phoneRow.statusRight).toBeCloseTo(4, 0);
    expect(phoneRow.addressLeft - (phoneRow.rule?.right ?? 0)).toBeCloseTo(8, 0);
    // Nothing is cut but the address, which truncates first.
    expect(phoneRow.clipped.filter((text) => !text?.startsWith('2a02:'))).toEqual([]);
    expect(phoneRow.pageScrollsSideways).toBe(false);
  }

  await page.unroute(listRoute);
  await page.goto(sessionPath);
  await expect(ruleMarker(page, orderedId)).toHaveText('R1');
  await button.click();
  await expect(rulesToggle).toHaveAccessibleName('Response rules 2 rules');
  await rulesToggle.scrollIntoViewIfNeeded();
  expect(await noSidewaysScroll()).toBe(true);
  await quick.getByRole('button', { name: 'Edit rules…' }).click();
  await expect(dialog).toBeVisible();
  await expect(rows).toHaveCount(2);
  expect(await noSidewaysScroll()).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize(viewport);

  // The section, remembered open, lists them; Remove rules asks once and removes.
  await button.click();
  await expect(rulesToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(rulesToggle).toHaveAccessibleName('Response rules 2 rules');
  await expect(quick.getByRole('list', { name: 'Rules' })).toHaveText(
    /1\s*POST\s*\/orders\s*→ 201.*2\s*GET\s*\/status\s*→ 200/,
  );
  await expect(quick).toContainText('Every other request → the session response.');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('qa-tools:rules-section')))
    .toBe('{"v":1,"open":true}');
  await quick.getByRole('button', { name: 'Remove rules' }).click();
  await expect(quick.getByText('Remove all 2 rules?', { exact: true })).toBeVisible();
  await expect(quick.getByRole('button', { name: 'Keep rules' })).toBeFocused();
  // Taken once the question has been there half a second (D206).
  await page.waitForTimeout(500);
  await quick.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(quick.getByRole('button', { name: 'Set up rules…' })).toBeVisible();
  await expect(button).toHaveText('Custom · 500');
  await expect(observerButton).toHaveText('Custom · 500');
  await expect.poll(updatesSeen).toBe(10);
  await page.keyboard.press('Escape');
  await expect(quick).toBeHidden();
  expect((await request.post(`${receiveUrl}/orders`, { data: '{}' })).status()).toBe(500);
}

/** The body built in the editor by typing and `Insert placeholder ▾` (#236). */
const TEMPLATE_BODY =
  '{"id":"{{request.id}}","method":"{{request.method}}","page":"{{request.query.page}}",' +
  '"trace":"{{request.header.X-Trace-Id}}","order":"{{request.body.order.id}}"}';

/**
 * Chooses an item of `Insert placeholder ▾`: the dropdown from 768 px, the
 * bottom sheet below (T6, T7).
 */
async function insertPlaceholder(scope: Locator, page: Page, item: string): Promise<void> {
  await scope.getByRole('button', { name: 'Insert placeholder' }).click();

  const menu = page.getByRole('menu', { name: 'Insert placeholder' });

  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click();
  await expect(menu).toBeHidden();
}

/**
 * E2E-02's response templates (issue #236 over D251): the opt-in under the
 * body, in the session response editor, a queue step and a rule's response.
 *
 * In the editor the box is unticked, with no menu and no hint; ticked, the
 * body is built by typing and `Insert placeholder ▾` - each item inserted at
 * the caret, a selection replaced, focus back in the body with the caret after
 * a whole placeholder and before the `}}` of a stub - and an unfinished stub
 * or an unknown placeholder is said under the body with `Save response`
 * unavailable. At 375 px the list is a bottom sheet. Saved, the quick switch
 * marks the response `Template`, a webhook gets the body filled in from it,
 * and the detail's Response half shows that body; reopened, the editor shows
 * the box ticked. A queue step and a rule, each a template, are saved with
 * the flag, marked in the quick switch's sections - `201 · Template`, and
 * the rule's `Template` tag - reopened ticked, and answer filled in. Cleared
 * and saved, the session response is sent as typed again, `{{` and all.
 */
test('a response made a template in the editor, a queue step and a rule fills in the request it answers', async ({
  page,
  request,
  viewport,
}) => {
  if (viewport === null) {
    throw new Error('E2E-02 runs at the project viewport, which it restores here');
  }

  await page.goto('/');
  await page.getByRole('button', { name: 'Generate URL' }).click();

  const receiveUrl = await readReceiveUrl(page);
  const sessionId = await sessionIdFromPage(page);
  const button = page.getByRole('button', { name: /Response settings/ });
  const quick = page.getByRole('dialog', { name: 'Session response', exact: true });

  await button.click();
  await quick.getByRole('radio', { name: 'Custom' }).click();
  await quick.getByRole('button', { name: 'Edit headers and body…' }).click();

  const editor = page.getByRole('dialog', { name: 'Session response settings' });
  const box = editor.getByRole('checkbox', { name: 'Fill in placeholders from the request' });
  const body = editor.getByLabel('Body · Optional');
  const save = editor.getByRole('button', { name: 'Save response' });
  const hint = 'Placeholders like {{request.id}} are replaced with values of the captured request.';

  // Off by default: no menu, no hint, no check - `{{` is text (T1). The box
  // took the line of `Returned exactly as entered`.
  await expect(box).not.toBeChecked();
  await expect(editor.getByRole('button', { name: 'Insert placeholder' })).toHaveCount(0);
  await expect(editor).not.toContainText(hint);
  await expect(editor).not.toContainText('Returned exactly as entered');
  await body.fill('{{request.foo}}');
  await expect(body).toHaveAttribute('aria-invalid', 'false');
  await expect(save).toBeEnabled();

  // Ticked, the menu and the hint appear (T2), and the same text is checked.
  await box.check();
  await expect(editor.getByTestId('template-hint')).toHaveText(hint);
  await expect(body).toHaveAttribute('aria-invalid', 'true');
  await expect(editor).toContainText('Unknown placeholder {{request.foo}}.');
  await expect(save).toBeDisabled();

  // Built at the caret: whole placeholders leave it after them.
  await body.fill('{"id":"');
  await expect(save).toBeEnabled();
  await insertPlaceholder(editor, page, 'Request id');
  await expect(body).toBeFocused();
  await expect(body).toHaveValue('{"id":"{{request.id}}');
  await page.keyboard.type('","method":"');
  await insertPlaceholder(editor, page, 'Method');
  await expect(body).toBeFocused();
  await page.keyboard.type('","page":"');

  // A stub leaves the caret before its `}}`, where the name is typed.
  await insertPlaceholder(editor, page, 'Query parameter…');
  await expect(body).toBeFocused();
  await expect(editor).toContainText('Finish {{request.query.}}: type the name before }}.');
  await expect(save).toBeDisabled();
  await page.keyboard.type('page');
  await expect(editor).not.toContainText('Finish {{request.query.}}');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  // A selection is replaced.
  await page.keyboard.type('","trace":"XX');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await insertPlaceholder(editor, page, 'Header…');
  await expect(body).toBeFocused();
  await page.keyboard.type('X-Trace-Id');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('","order":"');
  await insertPlaceholder(editor, page, 'JSON body field…');
  await expect(body).toBeFocused();
  await expect(editor).toContainText('Finish {{request.body.}}: type the field path before }}.');
  await page.keyboard.type('order.id');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('"}');
  await expect(body).toHaveValue(TEMPLATE_BODY);
  await expect(body).toHaveAttribute('aria-invalid', 'false');
  await expect(save).toBeEnabled();

  // Escape closes the list and gives focus back to its button, not the body.
  await editor.getByRole('button', { name: 'Insert placeholder' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Insert placeholder' })).toBeHidden();
  await expect(editor.getByRole('button', { name: 'Insert placeholder' })).toBeFocused();
  await expect(editor).toBeVisible();

  // On a phone the list is a bottom sheet (T7), inserting where the caret was.
  await page.setViewportSize({ width: 375, height: 812 });
  await editor.getByRole('button', { name: 'Insert placeholder' }).click();

  const sheet = page.getByRole('dialog', { name: 'Insert placeholder' });

  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button')).toHaveText([
    /^Request id/,
    /^Method/,
    /^Path/,
    /^Query parameter…/,
    /^Header…/,
    /^JSON body field…/,
  ]);
  await sheet.getByRole('button', { name: /^Path/ }).click();
  await expect(sheet).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(body).toBeFocused();
  await expect(body).toHaveValue(`${TEMPLATE_BODY}{{request.path}}`);
  await body.fill(TEMPLATE_BODY);
  await page.setViewportSize(viewport);

  await save.click();
  await expect(editor).toBeHidden();
  await expect(page.getByTestId('toast')).toHaveText(
    'Saved. Requests captured from now on get this response.',
  );

  // The quick switch marks it, right of `Edit headers and body…` (T13).
  const summaryTag = quick
    .getByRole('button', { name: 'Edit headers and body…' })
    .locator('xpath=..')
    .getByTestId('template-tag');

  await button.click();
  await expect(summaryTag).toHaveText('Template');
  await page.keyboard.press('Escape');
  await expect(quick).toBeHidden();

  // A webhook gets the body filled in from it.
  const answered = await request.post(`${receiveUrl}/orders?page=7`, {
    headers: { 'content-type': 'application/json', 'x-trace-id': 't-1' },
    data: '{"order":{"id":"ord_1"}}',
  });
  const answeredId = storedRequestId(answered);

  expect(answered.status()).toBe(200);
  expect(await answered.text()).toBe(
    `{"id":"${answeredId}","method":"POST","page":"7","trace":"t-1","order":"ord_1"}`,
  );

  // The detail's Response half shows the body that was sent.
  await requestRow(page, answeredId).click();
  await page.getByRole('tab', { name: 'Response' }).click();

  const responsePanel = page.getByRole('tabpanel', { name: 'Response' });

  await expect(responsePanel).toContainText('Sent by server');
  await expect(responsePanel).toContainText(answeredId);
  await expect(responsePanel).toContainText('ord_1');
  await expect(responsePanel).toContainText('t-1');
  await expect(responsePanel).not.toContainText('{{request.');

  // Reopened, the editor shows it as saved.
  await button.click();
  await quick.getByRole('button', { name: 'Edit headers and body…' }).click();
  await expect(box).toBeChecked();
  await expect(body).toHaveValue(TEMPLATE_BODY);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();

  // A queue step: a copy of the session response, a template too, saved with
  // the flag and drawn `201 · Template` in the section.
  await button.click();
  await quick.getByRole('button', { name: /^Response queue/ }).click();
  await quick.getByRole('button', { name: 'Set up a queue…' }).click();

  const queue = page.getByRole('dialog', { name: 'Response queue' });
  const stepBox = queue.getByRole('checkbox', { name: 'Fill in placeholders from the request' });

  await queue.getByRole('button', { name: '+ Add step' }).click();
  await expect(stepBox).toBeChecked();
  await queue.getByLabel('HTTP status').fill('201');
  await stepBox.uncheck();
  await queue.getByLabel('Body · Optional').fill('{"step":"');
  await stepBox.check();
  await insertPlaceholder(queue, page, 'Method');
  await expect(queue.getByLabel('Body · Optional')).toBeFocused();
  await page.keyboard.type('"}');
  await expect(queue.getByLabel('Body · Optional')).toHaveValue('{"step":"{{request.method}}"}');

  const queueSave = page.waitForRequest(
    (sent) => sent.method() === 'PUT' && sent.url().endsWith(`/api/sessions/${sessionId}/queue`),
  );

  await queue.getByRole('button', { name: 'Save queue' }).click();
  expect((await queueSave).postDataJSON()).toEqual({
    steps: [{ status: 201, body: '{"step":"{{request.method}}"}', template: true }],
  });
  await expect(queue).toBeHidden();
  await button.click();
  await expect(quick.locator('[data-chip]').first()).toHaveText('201 · Template');
  await quick.getByRole('button', { name: 'Edit queue…' }).click();
  await expect(stepBox).toBeChecked();
  await queue.getByRole('button', { name: 'Cancel' }).click();
  await expect(queue).toBeHidden();

  const stepAnswer = await request.get(`${receiveUrl}/ping`);

  expect(stepAnswer.status()).toBe(201);
  expect(await stepAnswer.text()).toBe('{"step":"GET"}');

  // A rule's response, the same: saved with the flag, the section's tag.
  await button.click();
  await quick.getByRole('button', { name: /^Response rules/ }).click();
  await quick.getByRole('button', { name: 'Set up rules…' }).click();

  const rules = page.getByRole('dialog', { name: 'Response rules' });
  const ruleBox = rules.getByRole('checkbox', { name: 'Fill in placeholders from the request' });

  await rules.getByRole('button', { name: '+ Add rule' }).click();
  await rules.getByRole('button', { name: 'POST', exact: true }).click();
  await rules.getByLabel('Path').fill('orders');
  await rules.getByLabel('HTTP status').fill('202');
  await expect(ruleBox).toBeChecked();
  await rules.getByLabel('Body · Optional').fill('{"path":"');
  await insertPlaceholder(rules, page, 'Path');
  await expect(rules.getByLabel('Body · Optional')).toBeFocused();
  await page.keyboard.type('"}');

  const rulesSave = page.waitForRequest(
    (sent) => sent.method() === 'PUT' && sent.url().endsWith(`/api/sessions/${sessionId}/rules`),
  );

  await rules.getByRole('button', { name: 'Save rules' }).click();
  expect((await rulesSave).postDataJSON()).toEqual({
    rules: [
      {
        method: 'POST',
        path: '/orders',
        response: { status: 202, body: '{"path":"{{request.path}}"}', template: true },
      },
    ],
  });
  await expect(rules).toBeHidden();
  await button.click();
  await expect(quick.getByRole('list', { name: 'Rules' })).toHaveText(
    /1\s*POST\s*\/orders\s*→ 202\s*Template/,
  );
  await quick.getByRole('button', { name: 'Edit rules…' }).click();
  await expect(ruleBox).toBeChecked();
  await rules.getByRole('button', { name: 'Cancel' }).click();
  await expect(rules).toBeHidden();

  const ruleAnswer = await request.post(`${receiveUrl}/orders`, { data: '{}' });

  expect(ruleAnswer.status()).toBe(202);
  expect(await ruleAnswer.text()).toBe(`{"path":"/s/${sessionId}/orders"}`);

  // Cleared and saved, the session response is no template: sent as typed.
  await button.click();
  await quick.getByRole('button', { name: 'Edit headers and body…' }).click();
  await box.uncheck();
  await expect(editor.getByRole('button', { name: 'Insert placeholder' })).toHaveCount(0);
  await save.click();
  await expect(editor).toBeHidden();
  await button.click();
  await expect(summaryTag).toHaveCount(0);
  await page.keyboard.press('Escape');

  const plain = await request.get(`${receiveUrl}/other`);

  expect(plain.status()).toBe(200);
  expect(await plain.text()).toBe(TEMPLATE_BODY);
});

/** A refusal naming the second rule's path, as a server would place it (D257). */
const PATH_REFUSAL = {
  errorCode: 1005,
  message: 'rules[1].path must contain no ?: the query of a request is never matched',
  field: 'rules[1].path',
};

/** A refusal naming the second step's delay. */
const DELAY_REFUSAL = {
  errorCode: 1005,
  message: 'steps[1].delayMs must be an integer between 0 and 30000',
  field: 'steps[1].delayMs',
};

/**
 * Answers every save of `list` with `refusal`, `400`, as a server whose checks
 * differ from the page's would - during a rollout, or after a limit changed -
 * and counts the saves; reads are passed through.
 */
async function refuseSaves(
  page: Page,
  list: 'rules' | 'queue',
  refusal: object,
): Promise<{ saves: () => number; unroute: () => Promise<void> }> {
  const pattern = `**/api/sessions/*/${list}`;
  let saves = 0;

  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();

      return;
    }

    saves += 1;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify(refusal),
    });
  });

  return { saves: () => saves, unroute: () => page.unroute(pattern) };
}

/**
 * Issue #232 (D257): a save the server refuses with a
 * `field` naming a rule or a step marks it - selected, its row in error, the
 * server's message at the field - and the footer names it counted from 1, in
 * the language shown; the first edit takes both away. On a phone the row is
 * marked and nothing opens; its screen shows the mark. The refusals are
 * answered by `page.route`, since the page's own checks refuse what the
 * server would.
 */
test('a save the server refuses at a rule or a step marks it at its field, in both languages and on a phone', async ({
  page,
  request,
  viewport,
}) => {
  if (viewport === null) {
    throw new Error('The journey runs at the project viewport, which it restores here');
  }

  const pageErrors: string[] = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));

  const created = await request.post('/api/sessions', {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({
      queue: { steps: [{ status: 500 }, { status: 503, delayMs: 2000 }] },
      rules: [
        { method: 'POST', path: '/orders', response: { status: 201 } },
        { method: 'GET', path: '/status', response: { status: 200 } },
      ],
    }),
  });

  expect(created.status(), await created.text()).toBe(201);

  const { id } = (await created.json()) as { id: string };

  await page.goto(`/v/${id}`);

  /** The rules dialog, opened from the quick switch in the language `m` speaks. */
  async function openRules(m: typeof en, expand: boolean): Promise<Locator> {
    await page.getByRole('button', { name: new RegExp(m.response.settings) }).click();

    const quick = page.getByRole('dialog', { name: m.quick.title, exact: true });

    if (expand) {
      await quick.getByRole('button', { name: new RegExp(`^${m.rules.title}`) }).click();
    }

    await quick.getByRole('button', { name: m.rules.edit }).click();

    const dialog = page.getByRole('dialog', { name: m.rules.title });

    await expect(dialog).toBeVisible();

    return dialog;
  }

  /** The queue dialog, the same way. */
  async function openQueue(m: typeof en, expand: boolean): Promise<Locator> {
    await page.getByRole('button', { name: new RegExp(m.response.settings) }).click();

    const quick = page.getByRole('dialog', { name: m.quick.title, exact: true });

    if (expand) {
      await quick.getByRole('button', { name: new RegExp(`^${m.queue.title}`) }).click();
    }

    await quick.getByRole('button', { name: m.queue.edit }).click();

    const dialog = page.getByRole('dialog', { name: m.queue.title });

    await expect(dialog).toBeVisible();

    return dialog;
  }

  const ruleRow = (dialog: Locator, m: typeof en, place: number) =>
    dialog
      .getByRole('list', { name: m.rules.list })
      .getByRole('button', { name: new RegExp(`^${m.rules.rule(place)}:`) });
  const stepRow = (dialog: Locator, m: typeof en, place: number) =>
    dialog
      .getByRole('list', { name: m.queue.steps })
      .getByRole('button', { name: new RegExp(`^${m.queue.step(place)}:`) });

  // Rule 1 selected, the save refused at rule 2's path.
  let rules = await openRules(en, true);
  let refused = await refuseSaves(page, 'rules', PATH_REFUSAL);

  await expect(ruleRow(rules, en, 1)).toHaveAttribute('aria-current', 'true');
  await expect(ruleRow(rules, en, 2)).not.toHaveAccessibleName(/has an error/);

  const sent = page.waitForRequest((sentRequest) => sentRequest.method() === 'PUT');

  await rules.getByRole('button', { name: en.rules.save }).click();
  expect(((await sent).postDataJSON() as { rules: unknown[] }).rules).toHaveLength(2);
  await expect(ruleRow(rules, en, 2)).toHaveAttribute('aria-current', 'true');
  await expect(ruleRow(rules, en, 2)).toHaveAccessibleName(/has an error/);
  await expect(ruleRow(rules, en, 1)).not.toHaveAccessibleName(/has an error/);
  await expect(rules.getByLabel(en.rules.path)).toHaveValue('status');
  await expect(rules.getByLabel(en.rules.path)).toHaveAttribute('aria-invalid', 'true');
  await expect(rules.getByLabel(en.rules.path)).toHaveAccessibleDescription(
    new RegExp(PATH_REFUSAL.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  await expect(rules.getByRole('alert')).toHaveText(
    'The server rejected rule 2. Fix the marked field and save again.',
  );
  // The mark holds nothing back: the save can be sent again as it stands.
  await expect(rules.getByRole('button', { name: en.queue.tryAgain })).toBeEnabled();

  // The first edit takes the mark and the footer's text away.
  await rules.getByLabel(en.rules.path).fill('status2');
  await expect(rules.getByLabel(en.rules.path)).toHaveAttribute('aria-invalid', 'false');
  await expect(rules).not.toContainText(PATH_REFUSAL.message);
  await expect(rules.getByRole('alert')).toHaveCount(0);
  await expect(ruleRow(rules, en, 2)).not.toHaveAccessibleName(/has an error/);
  await expect(rules.getByRole('button', { name: en.rules.save })).toBeEnabled();
  await rules.getByRole('button', { name: en.common.cancel }).click();
  await expect(rules).toBeHidden();
  expect(refused.saves()).toBe(1);
  await refused.unroute();

  // The queue's step 2, its delay.
  let queue = await openQueue(en, true);

  refused = await refuseSaves(page, 'queue', DELAY_REFUSAL);
  await expect(stepRow(queue, en, 1)).toHaveAttribute('aria-current', 'true');
  await queue.getByRole('button', { name: en.queue.save }).click();
  await expect(stepRow(queue, en, 2)).toHaveAttribute('aria-current', 'true');
  await expect(stepRow(queue, en, 2)).toHaveAccessibleName(/has an error/);
  await expect(stepRow(queue, en, 1)).not.toHaveAccessibleName(/has an error/);
  await expect(queue.getByLabel(en.fields.delay)).toHaveValue('2000');
  await expect(queue.getByLabel(en.fields.delay)).toHaveAttribute('aria-invalid', 'true');
  await expect(queue).toContainText(DELAY_REFUSAL.message);
  await expect(queue.getByRole('alert')).toHaveText(
    'The server rejected step 2. Fix the marked field and save again.',
  );
  await expect(queue.getByRole('button', { name: en.queue.tryAgain })).toBeEnabled();
  await queue.getByLabel(en.fields.delay).fill('100');
  await expect(queue.getByLabel(en.fields.delay)).toHaveAttribute('aria-invalid', 'false');
  await expect(queue).not.toContainText(DELAY_REFUSAL.message);
  await expect(queue.getByRole('alert')).toHaveCount(0);
  await queue.getByRole('button', { name: en.common.cancel }).click();
  await expect(queue).toBeHidden();
  expect(refused.saves()).toBe(1);
  await refused.unroute();

  // In Russian the footer is Russian and the server's message as it came.
  await page.evaluate(() => localStorage.setItem('qa-tools:language', '{"v":1,"lang":"ru"}'));
  await page.reload();
  rules = await openRules(ru, false);
  refused = await refuseSaves(page, 'rules', PATH_REFUSAL);
  await rules.getByRole('button', { name: ru.rules.save }).click();
  await expect(ruleRow(rules, ru, 2)).toHaveAttribute('aria-current', 'true');
  await expect(ruleRow(rules, ru, 2)).toHaveAccessibleName(new RegExp(ru.queue.hasError));
  await expect(rules.getByLabel(ru.rules.path)).toHaveAttribute('aria-invalid', 'true');
  await expect(rules).toContainText(PATH_REFUSAL.message);
  await expect(rules.getByRole('alert')).toHaveText(
    'Сервер отклонил правило 2. Исправьте отмеченное поле и сохраните снова.',
  );
  await rules.getByRole('button', { name: ru.common.cancel }).click();
  await expect(rules).toBeHidden();
  await refused.unroute();

  queue = await openQueue(ru, false);
  refused = await refuseSaves(page, 'queue', DELAY_REFUSAL);
  await queue.getByRole('button', { name: ru.queue.save }).click();
  await expect(stepRow(queue, ru, 2)).toHaveAttribute('aria-current', 'true');
  await expect(queue.getByLabel(ru.fields.delay)).toHaveAttribute('aria-invalid', 'true');
  await expect(queue).toContainText(DELAY_REFUSAL.message);
  await expect(queue.getByRole('alert')).toHaveText(
    'Сервер отклонил шаг 2. Исправьте отмеченное поле и сохраните снова.',
  );
  await queue.getByRole('button', { name: ru.common.cancel }).click();
  await expect(queue).toBeHidden();
  await refused.unroute();

  // On a phone the refused rule's row is marked and nothing
  // opens; opened, its screen shows the mark.
  await page.evaluate(() => localStorage.setItem('qa-tools:language', '{"v":1,"lang":"en"}'));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  rules = await openRules(en, false);
  refused = await refuseSaves(page, 'rules', PATH_REFUSAL);
  await rules.getByRole('button', { name: en.rules.save }).click();
  await expect(ruleRow(rules, en, 2)).toHaveAccessibleName(/has an error/);
  await expect(ruleRow(rules, en, 1)).not.toHaveAccessibleName(/has an error/);
  await expect(rules.getByRole('alert')).toHaveText(
    'The server rejected rule 2. Fix the marked field and save again.',
  );
  await expect(rules.getByLabel(en.rules.path)).toHaveCount(0);
  await ruleRow(rules, en, 2).click();
  await expect(rules.getByLabel(en.rules.path)).toHaveAttribute('aria-invalid', 'true');
  await expect(rules).toContainText(PATH_REFUSAL.message);
  await rules.getByRole('button', { name: en.rules.backToRules }).click();
  await expect(rules.getByRole('alert')).toHaveText(
    'The server rejected rule 2. Fix the marked field and save again.',
  );
  await rules.getByRole('button', { name: en.common.cancel }).click();
  await expect(rules).toBeHidden();
  expect(refused.saves()).toBe(1);
  await refused.unroute();
  await page.setViewportSize(viewport);

  expect(pageErrors).toEqual([]);
});
