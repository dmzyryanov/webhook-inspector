import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { describe, it } from 'node:test';
import { act, createElement } from 'react';
import { installFakeBrowser } from './render-in-node.ts';

/**
 * The render harness itself (#366): a page started in its fake browser sees
 * an English browser, whatever language the machine running the suite is set
 * to, so a test that reads what such a page draws gets the same text on any
 * machine; and React draws into it with no warning, told that it renders
 * under `act` (#391).
 */

const HARNESS = new URL('./render-in-node.ts', import.meta.url).href;
const I18N = new URL('../i18n/index.ts', import.meta.url).href;

/**
 * How long the child Node of `underLocale` may run, in milliseconds; it ends
 * in about a second. `spawnSync` blocks this file's event loop until the
 * child ends, so neither the runner's `--test-timeout` nor the exit guard can
 * end a child that hangs: it is killed at this time instead, and the test
 * fails (#391).
 */
const CHILD_TIMEOUT_MS = 30_000;

/**
 * What a process whose locale is `locale` sees: Node's own browser
 * languages, then, once the fake browser is installed, the page's and the
 * language a first visit decides from them, as `main.tsx` does.
 */
function underLocale(locale: string): { machine: unknown; page: unknown; language: unknown } {
  const env: NodeJS.ProcessEnv = { ...process.env, LANG: locale, LC_ALL: locale };

  // A process that carries it reports to a test runner, not to its stdout.
  delete env.NODE_TEST_CONTEXT;

  const script = `
    const machine = navigator.languages;
    const { installFakeBrowser } = await import(${JSON.stringify(HARNESS)});
    const { initialLanguage } = await import(${JSON.stringify(I18N)});
    installFakeBrowser('https://qa-tools.ru/no/such/page');
    console.log(JSON.stringify({
      machine,
      page: navigator.languages,
      language: initialLanguage(null, navigator),
    }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    // A signal the child cannot catch, so the kill ends it.
    killSignal: 'SIGKILL',
  });

  // A child killed at the timeout has no status, and this error, `ETIMEDOUT`.
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);

  return JSON.parse(run.stdout);
}

describe('the fake browser', () => {
  it('is an English browser on a machine set to Russian (#366)', () => {
    const seen = underLocale('ru_RU.UTF-8');

    // Node's own navigator follows the machine: the page would be Russian with it.
    assert.deepEqual(seen.machine, ['ru-RU'], 'this Node does not follow LC_ALL');
    assert.deepEqual(seen.page, ['en-US']);
    assert.equal(seen.language, 'en');
  });

  it('tells React it renders under act, so React draws into it with no warning (#391)', async (t) => {
    const browser = installFakeBrowser('https://qa-tools.ru/');
    // Imported once the fake browser is in place: React DOM looks for a DOM as it loads.
    const { createRoot } = await import('react-dom/client');
    const container = browser.document.getElementById('root');

    assert.ok(container, 'the page has no #root');

    // React writes its warnings with `console.error`; outside an act
    // environment, one for every update an `act` wraps.
    const errors = t.mock.method(console, 'error', () => {});
    const root = createRoot(container as unknown as HTMLElement);

    await act(async () => root.render(createElement('p', null, 'Drawn')));
    assert.equal(container.textContent, 'Drawn');
    await act(async () => root.unmount());

    assert.deepEqual(
      errors.mock.calls.map((call) => call.arguments),
      [],
    );
  });
});
