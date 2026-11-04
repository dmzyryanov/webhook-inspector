import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { buildInspectorUrl, type WebhookDefaultAnswer } from '@webhook-inspector/shared';
import {
  accessKeyFor,
  holdAccessKey,
  releaseAllAccessKeys,
  storeAccessKey,
  type AccessKeyStorage,
} from './access-keys.ts';
import {
  afterLinkedOpening,
  buildAccessLink,
  buildRequestLink,
  fragmentAfterKeyRead,
  MAX_ACCESS_FRAGMENT_LENGTH,
  MAX_PASTED_LENGTH,
  readPastedAccess,
  readRequestLink,
  readSessionLink,
  removesFragment,
  resolveRequestLink,
  STALE_LINK_TOAST,
  takeKeyFromAddress,
  withoutFragment,
  type AddressBar,
} from './request-link.ts';

const ORIGIN = 'https://qa-tools.ru';
const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
const REQUEST = '3f2b8c1e-9d4a-4e7b-a1c6-5e8f0d2b7a94';
const PAGE = `${ORIGIN}/v/${SESSION}`;

describe('buildRequestLink', () => {
  it('is the session page with the full request id as the fragment (D182)', () => {
    assert.equal(buildRequestLink(ORIGIN, SESSION, REQUEST), `${PAGE}#${REQUEST}`);
  });

  it('keeps the origin it is given, a local one included', () => {
    assert.equal(
      buildRequestLink('http://127.0.0.1:5173', SESSION, REQUEST),
      `http://127.0.0.1:5173/v/${SESSION}#${REQUEST}`,
    );
  });

  it('is read back as the request it names', () => {
    assert.deepEqual(readRequestLink(buildRequestLink(ORIGIN, SESSION, REQUEST)), {
      kind: 'request',
      requestId: REQUEST,
    });
  });
});

/**
 * A default session's reply links the request it stored as `inspectorUrl`
 * (D223), built by the same function as `Copy link`'s, so the page opens it as
 * it opens a copied link.
 */
describe('the inspectorUrl of a default reply (D223)', () => {
  it('is the link Copy link copies, and opens the request it names', () => {
    const inspectorUrl = buildInspectorUrl(ORIGIN, SESSION, REQUEST);
    const fragment = readRequestLink(inspectorUrl);

    assert.equal(inspectorUrl, buildRequestLink(ORIGIN, SESSION, REQUEST));
    assert.deepEqual(fragment, { kind: 'request', requestId: REQUEST });
    assert.deepEqual(
      resolveRequestLink(fragment, [
        { id: '00000000-0000-4000-8000-000000000000' },
        { id: REQUEST },
      ]),
      { kind: 'open', requestId: REQUEST },
    );
    assert.equal(withoutFragment(inspectorUrl), PAGE);
  });

  it('opens the request the published example of the reply names, on its session’s page', () => {
    const spec = JSON.parse(
      readFileSync(new URL('../../../../packages/shared/openapi.json', import.meta.url), 'utf8'),
    ) as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses: Record<
              string,
              { content?: Record<string, { examples: Record<string, { value: unknown }> }> }
            >;
          }
        >
      >;
    };
    const example = spec.paths['/s/{sessionId}']?.post?.responses['200']?.content?.[
      'application/json'
    ]?.examples.default?.value as WebhookDefaultAnswer;
    const sessionId = example.path.split('/')[2] ?? '';
    const fragment = readRequestLink(example.inspectorUrl);

    assert.deepEqual(fragment, { kind: 'request', requestId: example.requestId });
    assert.deepEqual(resolveRequestLink(fragment, [{ id: example.requestId }]), {
      kind: 'open',
      requestId: example.requestId,
    });
    assert.equal(withoutFragment(example.inspectorUrl), `https://qa-tools.ru/v/${sessionId}`);
  });
});

describe('readRequestLink', () => {
  it('reads a request id', () => {
    assert.deepEqual(readRequestLink(`${PAGE}#${REQUEST}`), {
      kind: 'request',
      requestId: REQUEST,
    });
  });

  it('reads an id in capitals as the lower-case one the API writes', () => {
    assert.deepEqual(readRequestLink(`${PAGE}#${REQUEST.toUpperCase()}`), {
      kind: 'request',
      requestId: REQUEST,
    });
  });

  it('finds nothing to read in an address without a fragment', () => {
    assert.deepEqual(readRequestLink(PAGE), { kind: 'none' });
    assert.deepEqual(readRequestLink(`${PAGE}?from=chat`), { kind: 'none' });
  });

  it('calls an empty fragment malformed', () => {
    assert.deepEqual(readRequestLink(`${PAGE}#`), { kind: 'malformed' });
  });

  it('calls anything but a whole request id malformed', () => {
    for (const fragment of [
      'not-a-request',
      '3f2b8c1e',
      // A UUID with extra characters, before, after or inside it.
      `${REQUEST}x`,
      `x${REQUEST}`,
      `${REQUEST}/`,
      ` ${REQUEST}`,
      `${REQUEST}#${REQUEST}`,
      `${REQUEST}?a=1`,
      // The same 32 digits without the hyphens, or with them elsewhere.
      REQUEST.replaceAll('-', ''),
      '3f2b8c1e9-d4a-4e7b-a1c6-5e8f0d2b7a94',
      // Not hexadecimal.
      '3f2b8c1e-9d4a-4e7b-a1c6-5e8f0d2b7a9g',
      // Percent-encoded: a link this page builds never is.
      encodeURIComponent(`{${REQUEST}}`),
      // The session id, or the short id a row shows.
      SESSION,
      REQUEST.slice(0, 7),
    ]) {
      assert.deepEqual(readRequestLink(`${PAGE}#${fragment}`), { kind: 'malformed' }, fragment);
    }
  });

  it('reads the fragment after a query string', () => {
    assert.deepEqual(readRequestLink(`${PAGE}?from=chat#${REQUEST}`), {
      kind: 'request',
      requestId: REQUEST,
    });
  });
});

describe('withoutFragment', () => {
  it('removes the fragment and its #, whatever it holds', () => {
    assert.equal(withoutFragment(`${PAGE}#${REQUEST}`), PAGE);
    assert.equal(withoutFragment(`${PAGE}#`), PAGE);
    assert.equal(withoutFragment(`${PAGE}#not-a-request`), PAGE);
  });

  it('keeps a query string and leaves an address without a fragment alone', () => {
    assert.equal(withoutFragment(`${PAGE}?from=chat#${REQUEST}`), `${PAGE}?from=chat`);
    assert.equal(withoutFragment(PAGE), PAGE);
  });
});

describe('resolveRequestLink', () => {
  const listed = [{ id: 'b8f1c2d3-0000-4000-8000-000000000000' }, { id: REQUEST }];

  it('opens a request the list holds', () => {
    assert.deepEqual(resolveRequestLink({ kind: 'request', requestId: REQUEST }, listed), {
      kind: 'open',
      requestId: REQUEST,
    });
  });

  it('calls a request the list does not hold stale: deleted, or pushed out of the newest 1000', () => {
    assert.deepEqual(
      resolveRequestLink({ kind: 'request', requestId: REQUEST }, listed.slice(0, 1)),
      {
        kind: 'stale',
      },
    );
    assert.deepEqual(resolveRequestLink({ kind: 'request', requestId: REQUEST }, []), {
      kind: 'stale',
    });
  });

  it('ignores a malformed fragment, and does nothing without one', () => {
    assert.deepEqual(resolveRequestLink({ kind: 'malformed' }, listed), { kind: 'ignore' });
    assert.deepEqual(resolveRequestLink({ kind: 'none' }, listed), { kind: 'none' });
  });

  it('removes the fragment whatever it held, and only when there is one', () => {
    assert.equal(removesFragment({ kind: 'open', requestId: REQUEST }), true);
    assert.equal(removesFragment({ kind: 'stale' }), true);
    assert.equal(removesFragment({ kind: 'ignore' }), true);
    assert.equal(removesFragment({ kind: 'none' }), false);
  });

  it('leaves a move link for the reading on arrival (#362), an outcome it never answers itself', () => {
    assert.equal(removesFragment({ kind: 'move' }), false);
    assert.deepEqual(resolveRequestLink(readRequestLink(`${PAGE}#move=e30`), listed), {
      kind: 'ignore',
    });
  });
});

describe('afterLinkedOpening', () => {
  it('scrolls the row into view only when the request is shown on the desktop', () => {
    assert.equal(afterLinkedOpening('shown', 'split'), 'reveal-row');
  });

  it('scrolls nothing below 1024 px, where the list is hidden under the request', () => {
    assert.equal(afterLinkedOpening('shown', 'push'), 'none');
  });

  it('scrolls nothing when the viewer left the request before it arrived', () => {
    // Another row clicked on the desktop, or `‹ Requests` or Back below 1024 px:
    // the list stays where the viewer is, at every width.
    assert.equal(afterLinkedOpening('superseded', 'split'), 'none');
    assert.equal(afterLinkedOpening('superseded', 'push'), 'none');
  });

  it('scrolls nothing when the details failed to load', () => {
    assert.equal(afterLinkedOpening('failed', 'split'), 'none');
    assert.equal(afterLinkedOpening('failed', 'push'), 'none');
  });

  it('says the request is gone when the server no longer has it, at every width', () => {
    assert.equal(afterLinkedOpening('not-found', 'split'), 'stale-toast');
    assert.equal(afterLinkedOpening('not-found', 'push'), 'stale-toast');
  });
});

describe('STALE_LINK_TOAST', () => {
  it('is the wording the approved frames S1 and S2 draw', () => {
    assert.equal(STALE_LINK_TOAST, 'The linked request is no longer in this session.');
  });
});

/*
 * The link with access (issue #228, D259): `#key=<key>`, and
 * `#key=<key>&request=<id>` for one request of a private session. Read before
 * the first load, its key held and taken out of the address; every D182 link,
 * `#<request>`, read as before.
 */

const KEY = 'Kf8sQ2xLm9Wq4Tz7Hc1Ny6Bd3Rv5Gs0Jx2Ve7Up4RtE';
const OTHER_KEY = 'Zq81aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_-';

describe('buildAccessLink', () => {
  it('is the session page with the key in the fragment', () => {
    assert.equal(buildAccessLink(ORIGIN, SESSION, KEY), `${PAGE}#key=${KEY}`);
  });

  it('carries a request after the key', () => {
    assert.equal(
      buildAccessLink(ORIGIN, SESSION, KEY, REQUEST),
      `${PAGE}#key=${KEY}&request=${REQUEST}`,
    );
  });

  it('never puts the key in the path or the query string (D168)', () => {
    for (const link of [
      buildAccessLink(ORIGIN, SESSION, KEY),
      buildAccessLink(ORIGIN, SESSION, KEY, REQUEST),
    ]) {
      const url = new URL(link);

      assert.equal(url.pathname, `/v/${SESSION}`);
      assert.equal(url.search, '');
      assert.equal(withoutFragment(link).includes(KEY), false);
    }
  });

  it('is read back as the key and the request it names', () => {
    assert.deepEqual(readSessionLink(buildAccessLink(ORIGIN, SESSION, KEY)), {
      kind: 'access',
      key: KEY,
      requestId: null,
    });
    assert.deepEqual(readSessionLink(buildAccessLink(ORIGIN, SESSION, KEY, REQUEST)), {
      kind: 'access',
      key: KEY,
      requestId: REQUEST,
    });
  });

  it('is never longer than the parser reads', () => {
    assert.equal(buildAccessLink(ORIGIN, SESSION, KEY, REQUEST).length - PAGE.length - 1, 92);
    assert.ok(MAX_ACCESS_FRAGMENT_LENGTH >= 92);
  });
});

describe('readSessionLink', () => {
  it('finds nothing in an address without a fragment', () => {
    assert.deepEqual(readSessionLink(PAGE), { kind: 'none' });
  });

  /** Criterion 6: every existing `#<request>` link keeps working. */
  it('reads a D182 link as the request it names, as readRequestLink does', () => {
    for (const href of [`${PAGE}#${REQUEST}`, `${PAGE}#${REQUEST.toUpperCase()}`]) {
      assert.deepEqual(readSessionLink(href), { kind: 'request', requestId: REQUEST });
      assert.deepEqual(readRequestLink(href), { kind: 'request', requestId: REQUEST });
      assert.equal(fragmentAfterKeyRead(readSessionLink(href)), null);
    }
  });

  it('reads the request of a link with access in any letter case as the API writes it', () => {
    assert.deepEqual(readSessionLink(`${PAGE}#key=${KEY}&request=${REQUEST.toUpperCase()}`), {
      kind: 'access',
      key: KEY,
      requestId: REQUEST,
    });
  });

  it('reads the parts in either order', () => {
    assert.deepEqual(readSessionLink(`${PAGE}#request=${REQUEST}&key=${KEY}`), {
      kind: 'access',
      key: KEY,
      requestId: REQUEST,
    });
  });

  /** Criterion 11's fragments, and the attack list's. */
  it('takes no key from #key=, a wrong-shaped key, two keys or an unknown part', () => {
    for (const fragment of [
      '',
      'key',
      'key=',
      'key=&request=' + REQUEST,
      `key=${KEY.slice(1)}`,
      `key=${KEY}x`,
      `key=${KEY.slice(1)}=`,
      `key=${KEY.slice(1)}%`,
      `key=%20${KEY.slice(3)}`,
      `key=${KEY}&key=${OTHER_KEY}`,
      `key=${KEY}&key=${KEY}`,
      `key=${KEY}&request=${REQUEST}&request=${REQUEST}`,
      `key=${KEY}&other=1`,
      `KEY=${KEY}`,
      `${KEY}`,
      `key=${KEY}&`,
      `&key=${KEY}`,
      `request=${REQUEST}`,
      `key=${KEY}#key=${OTHER_KEY}`,
      'not-a-request',
    ]) {
      const link = readSessionLink(`${PAGE}#${fragment}`);

      assert.deepEqual(link, { kind: 'malformed' }, fragment);
      assert.equal(fragmentAfterKeyRead(link), '', fragment);
    }
  });

  it('keeps the key of a link whose request part is malformed, and drops the request', () => {
    for (const request of ['', 'nope', `${REQUEST}x`, REQUEST.slice(1), 'a'.repeat(36)]) {
      const link = readSessionLink(`${PAGE}#key=${KEY}&request=${request}`);

      assert.deepEqual(link, { kind: 'access', key: KEY, requestId: null }, request);
      assert.equal(fragmentAfterKeyRead(link), '');
    }
  });

  it('leaves the request alone in the address once the key is read', () => {
    assert.equal(fragmentAfterKeyRead(readSessionLink(`${PAGE}#key=${KEY}`)), '');
    assert.equal(
      fragmentAfterKeyRead(readSessionLink(`${PAGE}#key=${KEY}&request=${REQUEST}`)),
      `#${REQUEST}`,
    );
    assert.equal(fragmentAfterKeyRead(readSessionLink(PAGE)), null);
  });

  it('reads the fragment after a query string, and only from the first #', () => {
    assert.deepEqual(readSessionLink(`${PAGE}?x=1#key=${KEY}`), {
      kind: 'access',
      key: KEY,
      requestId: null,
    });
  });

  describe('hostile fragments at growing sizes', () => {
    const SIZES = [1024, 64 * 1024, 1024 * 1024, 5 * 1024 * 1024];
    const LIMIT_MS = 500;

    function timed(href: string) {
      const started = performance.now();
      const link = readSessionLink(href);
      const elapsed = performance.now() - started;

      assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(1)} ms for ${href.length} characters`);

      return link;
    }

    for (const size of SIZES) {
      it(`reads ${size} characters of fragment as malformed, with no key`, () => {
        for (const fragment of [
          'a'.repeat(size),
          `key=${KEY}${'a'.repeat(size)}`,
          `key=${KEY}&request=${REQUEST}${'&'.repeat(size)}`,
          `key=${'k'.repeat(size)}`,
          '&'.repeat(size),
          `${'key='.repeat(size / 4)}`,
          `key=${KEY}${'&key='.repeat(size / 5)}`,
          '#'.repeat(size),
        ]) {
          const link = timed(`${PAGE}#${fragment}`);

          assert.deepEqual(link, { kind: 'malformed' });
          assert.equal(fragmentAfterKeyRead(link), '');
        }
      });
    }
  });
});

describe('readPastedAccess: the field of Session not found (R7, R8)', () => {
  const HERE = 'pR7vX2aLq9Wm4Tz8Hc1Ny68d3Kf5Gs0Jx2Ve7Up4RtE';

  it('does nothing for an empty value or spaces', () => {
    assert.deepEqual(readPastedAccess('', HERE, ORIGIN), { kind: 'empty' });
    assert.deepEqual(readPastedAccess('  \n\t ', HERE, ORIGIN), { kind: 'empty' });
  });

  it('tries the key alone on the page’s own session, spaces around it ignored', () => {
    for (const value of [KEY, ` ${KEY} `, `${KEY}\n`]) {
      assert.deepEqual(readPastedAccess(value, HERE, ORIGIN), {
        kind: 'open',
        sessionId: HERE,
        key: KEY,
        requestId: null,
      });
    }
  });

  it('opens a link with access on the session it names, at its request', () => {
    assert.deepEqual(readPastedAccess(buildAccessLink(ORIGIN, SESSION, KEY), HERE, ORIGIN), {
      kind: 'open',
      sessionId: SESSION,
      key: KEY,
      requestId: null,
    });
    assert.deepEqual(
      readPastedAccess(buildAccessLink(ORIGIN, SESSION, KEY, REQUEST), HERE, ORIGIN),
      { kind: 'open', sessionId: SESSION, key: KEY, requestId: REQUEST },
    );
    assert.deepEqual(readPastedAccess(`${PAGE}/#key=${KEY}`, HERE, ORIGIN), {
      kind: 'open',
      sessionId: SESSION,
      key: KEY,
      requestId: null,
    });
  });

  it('opens nothing for anything else', () => {
    for (const value of [
      KEY.slice(1),
      `${KEY}x`,
      'Zq81…not-a-key',
      PAGE,
      `${PAGE}#${REQUEST}`,
      `${PAGE}#key=`,
      `${PAGE}#key=${KEY.slice(1)}`,
      `${PAGE}#key=${KEY}&key=${OTHER_KEY}`,
      buildAccessLink('https://evil.example', SESSION, KEY),
      buildAccessLink('http://qa-tools.ru', SESSION, KEY),
      buildAccessLink('https://www.qa-tools.ru', SESSION, KEY),
      `${ORIGIN}/#key=${KEY}`,
      `${ORIGIN}/v/short#key=${KEY}`,
      `${ORIGIN}/v/${SESSION}/more#key=${KEY}`,
      `${ORIGIN}/s/${SESSION}#key=${KEY}`,
      `https://hook.qa-tools.ru/s/${SESSION}`,
      `javascript:alert(1)//#key=${KEY}`,
      `data:text/html,x#key=${KEY}`,
      `/v/${SESSION}#key=${KEY}`,
      'not a link',
    ]) {
      assert.deepEqual(readPastedAccess(value, HERE, ORIGIN), { kind: 'invalid' }, value);
    }
  });

  it('refuses a value longer than it reads, unread, whatever its size', () => {
    for (const size of [MAX_PASTED_LENGTH + 1, 64 * 1024, 1024 * 1024, 5 * 1024 * 1024]) {
      const started = performance.now();

      assert.deepEqual(
        readPastedAccess(
          `${buildAccessLink(ORIGIN, SESSION, KEY)}${'a'.repeat(size)}`,
          HERE,
          ORIGIN,
        ),
        { kind: 'invalid' },
      );
      assert.deepEqual(readPastedAccess(' '.repeat(size), HERE, ORIGIN), { kind: 'invalid' });
      assert.ok(performance.now() - started < 500);
    }
  });
});

/**
 * Finding 1 of the outside review of !252: the key is read from the address
 * before a page's first load, and again when only the fragment changes under
 * a page already shown - a link with access pasted into the address bar of
 * that session's `Session not found`, which loads no new document and mounts
 * no new page. `SessionPage` calls this on `hashchange` and opens afresh on
 * `access`; E2E-21 walks it in a browser.
 */
describe('takeKeyFromAddress: the key taken out of the address, on load and on a fragment change', () => {
  afterEach(() => {
    releaseAllAccessKeys();
  });

  /** The tab's address bar: what it reads, and each address that replaced it. */
  function addressBar(href: string): { href: string; replaced: string[] } & AddressBar {
    const replaced: string[] = [];
    const bar = {
      href,
      replaced,
      replace(next: string) {
        replaced.push(next);
        bar.href = next;
      },
    };

    return bar;
  }

  function memoryStorage(): AccessKeyStorage {
    const items = new Map<string, string>();

    return {
      getItem: (name) => items.get(name) ?? null,
      setItem: (name, value) => {
        items.set(name, value);
      },
    };
  }

  it('takes a link with access pasted on the page shown out of the address at once, holds its key, and asks to open afresh', () => {
    const bar = addressBar(PAGE);

    // The page's first load: no fragment, nothing held - `Session not found`.
    assert.deepEqual(takeKeyFromAddress(SESSION, null, bar), { kind: 'none' });
    assert.deepEqual(bar.replaced, []);
    assert.equal(accessKeyFor(SESSION, null), null);

    // The link pasted into the address bar: the same document, a new fragment.
    bar.href = buildAccessLink(ORIGIN, SESSION, KEY);

    assert.deepEqual(takeKeyFromAddress(SESSION, null, bar), {
      kind: 'access',
      key: KEY,
      requestId: null,
    });
    assert.deepEqual(bar.replaced, [PAGE]);
    assert.equal(accessKeyFor(SESSION, null), KEY);
  });

  it('leaves the request a link with access names, for the reading after the first list load', () => {
    const bar = addressBar(PAGE);

    bar.href = buildAccessLink(ORIGIN, SESSION, KEY, REQUEST);

    assert.equal(takeKeyFromAddress(SESSION, null, bar).kind, 'access');
    assert.deepEqual(bar.replaced, [`${PAGE}#${REQUEST}`]);
    assert.deepEqual(readRequestLink(bar.href), { kind: 'request', requestId: REQUEST });
    assert.equal(bar.href.includes(KEY), false);
  });

  it('takes a malformed fragment out without holding anything or asking to open afresh', () => {
    for (const fragment of [
      '',
      'key=',
      `key=${KEY.slice(1)}`,
      `key=${KEY}&key=${OTHER_KEY}`,
      'x',
    ]) {
      const bar = addressBar(`${PAGE}#${fragment}`);

      assert.equal(takeKeyFromAddress(SESSION, null, bar).kind, 'malformed');
      assert.deepEqual(bar.replaced, [PAGE]);
      assert.equal(accessKeyFor(SESSION, null), null);
    }
  });

  /** Criterion 6: every `#<request>` link keeps working, read after the first list load. */
  it('leaves D182’s request link and an address without a fragment as they are', () => {
    for (const href of [PAGE, `${PAGE}#${REQUEST}`]) {
      const bar = addressBar(href);

      assert.notEqual(takeKeyFromAddress(SESSION, null, bar).kind, 'access');
      assert.deepEqual(bar.replaced, []);
    }
  });

  it('keeps a key the browser already holds for the session, and still takes the link’s out', () => {
    const storage = memoryStorage();

    storeAccessKey(storage, SESSION, KEY);

    const stored = addressBar(buildAccessLink(ORIGIN, SESSION, OTHER_KEY));

    assert.equal(takeKeyFromAddress(SESSION, storage, stored).kind, 'access');
    assert.deepEqual(stored.replaced, [PAGE]);
    assert.equal(accessKeyFor(SESSION, storage), KEY);

    holdAccessKey(SESSION, KEY);

    const held = addressBar(buildAccessLink(ORIGIN, SESSION, OTHER_KEY));

    takeKeyFromAddress(SESSION, null, held);
    assert.equal(accessKeyFor(SESSION, null), KEY);
  });

  for (const size of [1024, 1024 * 1024, 5 * 1024 * 1024]) {
    it(`takes a fragment of ${size} characters out as malformed, in bounded time`, () => {
      const bar = addressBar(`${PAGE}#key=${KEY}${'&'.repeat(size)}`);
      const started = performance.now();

      assert.equal(takeKeyFromAddress(SESSION, null, bar).kind, 'malformed');
      assert.ok(performance.now() - started < 500);
      assert.deepEqual(bar.replaced, [PAGE]);
      assert.equal(accessKeyFor(SESSION, null), null);
    });
  }
});

/**
 * Structural guards over the source text, not tests of behaviour: they fail on
 * a harmless rename, and are kept because the wiring they check has no unit
 * test of its own - E2E-21 walks a link pasted on the page shown, and a key
 * removed in another tab, in a browser.
 */
describe('where the key is taken from the address (structural guard)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('the session page takes it before its first load and on every hashchange, opening afresh on a key', () => {
    const page = read('../pages/SessionPage.tsx');

    assert.ok(page.includes('takeKeyFromAddress(sessionId, storage, addressBar);'));
    assert.ok(page.includes("window.addEventListener('hashchange', onHashChange);"));
    // Through `takeKeyUnlessMove`, which reads every fragment as
    // `takeKeyFromAddress` but a move link's (#345, `move-link.test.ts`).
    assert.ok(
      page.includes(
        "if (takeKeyUnlessMove(sessionId, browserStorage(), addressBar).kind === 'access') {\n        reopen();",
      ),
    );
    assert.equal(page.match(/history\.replaceState\(/g)?.length, 1);
  });

  it('every tab watches for keys another tab removed, from the start', () => {
    assert.ok(read('../main.tsx').includes('watchAccessKeyRemovals(window, storage);'));
  });
});
