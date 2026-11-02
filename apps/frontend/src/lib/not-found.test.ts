import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import { en } from '../i18n/en.ts';
import { HOME_ADDRESSES, homeAddress, LANGUAGES } from '../i18n/index.ts';
import { ru } from '../i18n/ru.ts';
import {
  classifyAddress,
  fixedLanguage,
  GO_HOME,
  pageNotFoundView,
  requestTarget,
  sessionNotFoundView,
  shortenSessionId,
  switchAddress,
} from './not-found.ts';

/** A well-formed session id of the older shape: 43 Base64URL characters (D004). */
const VALID_ID = 'Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss';

/** A well-formed session id as it is generated now: 43 letters and digits (D161). */
const NEW_ID = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

const HOST = 'qa-tools.ru';

const ENGLISH_LANDING = { screen: 'landing', language: null } as const;
const RUSSIAN_LANDING = { screen: 'landing', language: 'ru' } as const;

describe('classifyAddress', () => {
  it('reads / as the landing page, in the visitor’s language', () => {
    assert.deepEqual(classifyAddress('/'), ENGLISH_LANDING);
  });

  /** The Russian home page (issue #109, D226): nginx serves both with 200. */
  it('reads /ru/ and /ru as the landing page in Russian', () => {
    for (const path of ['/ru/', '/ru']) {
      assert.deepEqual(classifyAddress(path), RUSSIAN_LANDING, `misread ${path}`);
    }
  });

  /**
   * Nothing near /ru/ is it, and none of them is the English landing page
   * either: every one is `Page not found`, which nginx answers `404`.
   */
  it('reads every other address under or beside /ru/ as not found', () => {
    for (const path of [
      '/RU/',
      '/RU',
      '/Ru/',
      '/rU',
      '/ru/index.html',
      '/ru/index.htm',
      '/ru/x',
      '/ru/x/',
      '/ru/ru/',
      `/ru/v/${VALID_ID}`,
      `/ru/v/${NEW_ID}/`,
      '/ru/%0A',
      '/ru%0A',
      '/ru%20',
      '/ru/%',
      '/ru/%zz',
      '/ru%',
      '/rus',
      '/ru-RU/',
      '/en/',
      '/r',
      '/u',
      // A browser resolves dot segments, `%2E` ones included, before it
      // sends the address; read as they stand, they are no page.
      '/ru/.',
      '/ru/..',
    ]) {
      assert.deepEqual(classifyAddress(path), { screen: 'not-found' }, `misread ${path}`);
    }
  });

  it('reads /v/<well-formed id> as a session, with or without a trailing slash', () => {
    for (const id of [VALID_ID, NEW_ID]) {
      assert.match(id, SESSION_ID_PATTERN);

      for (const path of [`/v/${id}`, `/v/${id}/`]) {
        assert.deepEqual(
          classifyAddress(path),
          { screen: 'session', sessionId: id },
          `misread ${path}`,
        );
      }
    }
  });

  /**
   * B is decided from the address alone, before anything is asked of the API
   * (D146): none of these can be a session, so none of them reaches the
   * session page.
   */
  it('reads every other address as not found', () => {
    for (const path of [
      '/anything',
      '/v',
      '/v/',
      '/v/xxx',
      `/v/${VALID_ID.slice(0, 42)}`,
      `/v/${VALID_ID}x`,
      `/v/${VALID_ID.slice(0, 42)}!`,
      `/v/${VALID_ID}/extra`,
      `/v/${VALID_ID}/extra/`,
      `/v/${VALID_ID}//extra`,
      `/s/${VALID_ID}`,
      `/${VALID_ID}`,
      '/index.html',
      '/favicon.ico',
      '/robots.txt',
      '/v/%zz',
    ]) {
      assert.deepEqual(classifyAddress(path), { screen: 'not-found' }, `misread ${path}`);
    }
  });

  /**
   * nginx matches the decoded, slash-merged path, so the client does too:
   * otherwise an address nginx answered `200` could render B, or one it
   * answered `404` could render a session.
   */
  it('reads the path the way nginx does', () => {
    assert.deepEqual(classifyAddress(`/v/%41${VALID_ID.slice(1)}`), {
      screen: 'session',
      sessionId: VALID_ID,
    });
    assert.deepEqual(classifyAddress(`//v//${VALID_ID}//`), {
      screen: 'session',
      sessionId: VALID_ID,
    });
    assert.deepEqual(classifyAddress('//'), ENGLISH_LANDING);
    // The Russian home page read as nginx reads it: escapes decoded, `%2F`
    // included, repeated slashes merged. nginx serves each of these the
    // Russian page with 200 (checked with curl on the image, D226).
    for (const path of [
      '//ru//',
      '//ru',
      '/ru//',
      '/%72u/',
      '/r%75/',
      '/%72%75',
      '/ru%2F',
      '/%2Fru',
      '/%2Fru%2F',
      '/%2F%2Fru%2F%2F',
    ]) {
      assert.deepEqual(classifyAddress(path), RUSSIAN_LANDING, `misread ${path}`);
    }
    assert.deepEqual(classifyAddress(`/v/${VALID_ID}%2Fextra`), { screen: 'not-found' });
    // nginx decodes `%0A` too, and its session location is anchored with `\z`
    // so that it answers this `404` as well (D146).
    assert.deepEqual(classifyAddress(`/v/${VALID_ID}%0A`), { screen: 'not-found' });
    assert.deepEqual(classifyAddress(`/v/${VALID_ID}/%0A`), { screen: 'not-found' });
  });
});

/**
 * The regular expression nginx serves the application with `200` for, read out
 * of `apps/frontend/nginx.conf` itself, exactly as written there. The two are
 * kept in step by hand, with a comment on both sides (D146); this is what fails
 * when only one side moves.
 */
function nginxSessionPattern(): string {
  const config = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
  const pattern = /^\s*location ~ "(\^\/v\/.+)" \{$/m.exec(config)?.[1];

  assert.ok(pattern !== undefined, 'nginx.conf has no quoted regex location for /v/');

  return pattern;
}

/**
 * The addresses nginx serves the Russian home page for (D226): its exact
 * locations whose only directive hands the request to `/ru/index.html`, read
 * out of `nginx.conf` itself.
 */
function nginxRussianHomeAddresses(): string[] {
  const config = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');

  return [
    ...config.matchAll(/^\s*location = (\S+) \{\n\s*rewrite \^ \/ru\/index\.html last;\n\s*\}$/gm),
  ].map((match) => match[1] as string);
}

/**
 * That pattern as a JavaScript expression. PCRE's `\z` is the very end of the
 * subject, which is what `$` means in JavaScript without the `m` flag; PCRE's
 * own `$` also matches before a final newline, which is why nginx does not use
 * it. Any other ending is refused here rather than translated.
 */
function nginxSessionLocation(): RegExp {
  const pattern = nginxSessionPattern();

  assert.ok(pattern.endsWith('\\z'), `nginx's session location must end in \\z: ${pattern}`);

  return new RegExp(`${pattern.slice(0, -2)}$`);
}

describe('the session location in nginx.conf', () => {
  it('uses the character class and length of SESSION_ID_PATTERN, anchored with \\z', () => {
    assert.equal(nginxSessionPattern(), `^/v/${SESSION_ID_PATTERN.source.slice(1, -1)}/?\\z`);
  });

  it('serves the Russian home page at /ru/ and /ru alone', () => {
    assert.deepEqual(nginxRussianHomeAddresses(), ['/ru', '/ru/']);

    for (const path of nginxRussianHomeAddresses()) {
      assert.deepEqual(classifyAddress(path), RUSSIAN_LANDING, path);
    }
  });

  it('serves the application with 200 exactly where the client expects a page', () => {
    const location = nginxSessionLocation();
    const russian = nginxRussianHomeAddresses();

    for (const path of [
      '/',
      '/ru',
      '/ru/',
      '/RU/',
      '/ru/x',
      '/ru/index.html',
      `/ru/v/${VALID_ID}`,
      // As nginx sees `/ru/%0A` and `/ru%0A` once it has decoded them.
      '/ru/\n',
      '/ru\n',
      '/anything',
      '/v/',
      '/v/xxx',
      `/v/${VALID_ID}`,
      `/v/${VALID_ID}/`,
      `/v/${NEW_ID}`,
      `/v/${NEW_ID}/`,
      `/v/${VALID_ID}x`,
      `/v/${VALID_ID.slice(0, 42)}`,
      `/v/${VALID_ID}/extra`,
      '/index.html',
      // As nginx sees `/v/<id>%0A` and `/v/<id>/%0A` once it has decoded them.
      `/v/${VALID_ID}\n`,
      `/v/${VALID_ID}/\n`,
    ]) {
      const served = path === '/' || russian.includes(path) || location.test(path);

      assert.equal(
        classifyAddress(path).screen !== 'not-found',
        served,
        `nginx and the client disagree about ${path}`,
      );
    }
  });
});

/** Made-up addresses grow to these sizes, in characters. */
const SIZES = [1024, 64 * 1024, 1024 * 1024];

/** How long one hostile address may take; a linear pass over 1 MiB takes milliseconds. */
const HOSTILE_MS = 1_000;

function timed<T>(what: string, run: () => T): T {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;

  assert.ok(elapsed < HOSTILE_MS, `${what} took ${Math.round(elapsed)} ms`);

  return result;
}

describe('classifyAddress on made-up addresses near /ru/', () => {
  it('stays linear on long runs of slashes and escapes, and reads them as nginx does', () => {
    for (const size of SIZES) {
      const cases: [string, ReturnType<typeof classifyAddress>][] = [
        [`/ru${'/'.repeat(size)}`, RUSSIAN_LANDING],
        [`/ru${'%2F'.repeat(size)}`, RUSSIAN_LANDING],
        [`/ru${'%2f'.repeat(size)}`, RUSSIAN_LANDING],
        [`${'/'.repeat(size)}ru/`, RUSSIAN_LANDING],
        [`${'%2F'.repeat(size)}ru${'/%2F'.repeat(size)}`, RUSSIAN_LANDING],
        [`/ru/${'x'.repeat(size)}`, { screen: 'not-found' }],
        [`/ru/${'%0A'.repeat(size)}`, { screen: 'not-found' }],
        [`/ru/${'%'.repeat(size)}`, { screen: 'not-found' }],
        [`/ru/${'%zz'.repeat(size)}`, { screen: 'not-found' }],
        [`/r${'u'.repeat(size)}`, { screen: 'not-found' }],
        [`/ru${'/.'.repeat(size)}`, { screen: 'not-found' }],
        [`/ru/v/${'A'.repeat(size)}`, { screen: 'not-found' }],
        [`/${'%72u/'.repeat(size)}`, { screen: 'not-found' }],
      ];

      for (const [path, expected] of cases) {
        const label = `${path.slice(0, 12)}… (${path.length})`;

        assert.deepEqual(
          timed(label, () => classifyAddress(path)),
          expected,
          label,
        );
        timed(label, () => fixedLanguage(path));
        timed(label, () => switchAddress(path, 'ru'));
      }
    }
  });
});

describe('fixedLanguage', () => {
  it('is Russian on the Russian home page, however nginx reads it there', () => {
    for (const path of ['/ru/', '/ru', '//ru//', '/%72u/', '/ru%2F']) {
      assert.equal(fixedLanguage(path), 'ru', path);
    }
  });

  it('is none on /, on a session page and on every unknown address', () => {
    for (const path of [
      '/',
      '//',
      `/v/${NEW_ID}`,
      '/RU/',
      '/ru/x',
      '/ru/index.html',
      '/about',
      '/ru/%zz',
    ]) {
      assert.equal(fixedLanguage(path), null, path);
    }
  });
});

describe('switchAddress', () => {
  /** Acceptance 7: `RU` on `/` leads to `/ru/`, `EN` on `/ru/` to `/`. */
  it('leads from either home page to the home page of the language chosen', () => {
    assert.equal(switchAddress('/', 'ru'), '/ru/');
    assert.equal(switchAddress('/ru/', 'en'), '/');
    assert.equal(switchAddress('/ru', 'en'), '/');
    // From the same page read another way, to its own address.
    assert.equal(switchAddress('//', 'ru'), '/ru/');
    assert.equal(switchAddress('/ru', 'ru'), '/ru/');
    assert.equal(switchAddress('/%72u/', 'en'), '/');
  });

  it('changes no address where the page already is', () => {
    assert.equal(switchAddress('/', 'en'), null);
    assert.equal(switchAddress('/ru/', 'ru'), null);
  });

  /** Everywhere else the switch changes the language in place (D222). */
  it('changes no address on a session page or any other screen', () => {
    for (const path of [
      `/v/${NEW_ID}`,
      `/v/${VALID_ID}/`,
      '/anything',
      '/RU/',
      '/ru/x',
      '/ru/index.html',
      `/ru/v/${NEW_ID}`,
    ]) {
      for (const language of LANGUAGES) {
        assert.equal(switchAddress(path, language), null, `${path} ${language}`);
      }
    }
  });
});

describe('shortenSessionId', () => {
  it('keeps the first and last four characters', () => {
    assert.equal(shortenSessionId(VALID_ID), 'Au6J…MKss');
  });
});

describe('requestTarget', () => {
  it('is the path and the query', () => {
    assert.equal(requestTarget({ pathname: '/pricing', search: '' }), '/pricing');
    assert.equal(
      requestTarget({ pathname: '/pricing/plans', search: '?tier=pro&x=%20y' }),
      '/pricing/plans?tier=pro&x=%20y',
    );
  });

  /** Only a location's pathname and search are read, never its hash. */
  it('never carries the fragment', () => {
    const location = { pathname: '/pricing', search: '?a=1', hash: '#plans' };

    assert.equal(requestTarget(location), '/pricing?a=1');
    assert.doesNotMatch(requestTarget(location), /#/);
  });

  it('keeps the path as the browser encoded it', () => {
    assert.equal(requestTarget({ pathname: '/a%20b/%D1%8F', search: '' }), '/a%20b/%D1%8F');
  });
});

describe('sessionNotFoundView', () => {
  it('matches frame 2A', () => {
    assert.deepEqual(
      sessionNotFoundView({
        pathname: `/v/${VALID_ID}`,
        search: '',
        sessionId: VALID_ID,
        host: HOST,
      }),
      {
        title: 'Session not found',
        request: ['GET /v/Au6J…MKss HTTP/1.1', 'Host: qa-tools.ru'],
        answer: 'Session not available',
        body: 'It was most likely deleted, on purpose or after going unused for the time chosen when it was created, together with its requests and response settings.',
        action: { label: 'Go to home page', href: '/' },
      },
    );
  });

  /**
   * Since #216 a session's window is chosen when it is created, so the
   * sentence names the window chosen, beside deletion on purpose (D198), in
   * the owner's words (Decision 6 of 2026-10-18, D249; the number dropped by
   * Decision 2 of 2026-10-25, D265): the page cannot know the window of a
   * session the API answers `404`.
   */
  it('names deletion on purpose beside the window chosen at creation, in the words the owner approved', () => {
    const address = {
      pathname: `/v/${VALID_ID}`,
      search: '',
      sessionId: VALID_ID,
      host: HOST,
    };

    assert.equal(
      sessionNotFoundView(address).body,
      'It was most likely deleted, on purpose or after going unused for the time chosen when it was created, together with its requests and response settings.',
    );
    assert.equal(
      sessionNotFoundView(address, ru).body,
      'Скорее всего, её удалили — намеренно или после простоя, заданного при создании, — вместе с запросами и настройками ответа.',
    );
    assert.doesNotMatch(sessionNotFoundView(address).body, /without use/);
  });

  /**
   * A session that no longer exists is answered `404`, so its window is
   * unknown here: a number in the body would be wrong for every session
   * created with another one (D265).
   */
  it('names no number, in either language', () => {
    const address = {
      pathname: `/v/${VALID_ID}`,
      search: '',
      sessionId: VALID_ID,
      host: HOST,
    };

    for (const m of [en, ru]) {
      assert.doesNotMatch(sessionNotFoundView(address, m).body, /\d/);
    }
  });

  it('shortens the id and keeps the rest of the address that was opened', () => {
    const view = sessionNotFoundView({
      pathname: `/v/${VALID_ID}/`,
      search: '?from=mail',
      sessionId: VALID_ID,
      host: 'localhost:5173',
    });

    assert.deepEqual(view.request, [
      'GET /v/Au6J…MKss/?from=mail HTTP/1.1',
      'Host: localhost:5173',
    ]);
  });

  /** One unavailable screen that names no cause it cannot know (D133). */
  it('never says the session expired', () => {
    const view = sessionNotFoundView({
      pathname: `/v/${VALID_ID}`,
      search: '',
      sessionId: VALID_ID,
      host: HOST,
    });

    for (const text of [view.title, ...view.request, view.answer, view.body]) {
      assert.doesNotMatch(text, /expired/i);
    }
  });
});

describe('pageNotFoundView', () => {
  it('matches frame 2B', () => {
    assert.deepEqual(pageNotFoundView({ pathname: '/pricing', search: '', host: HOST }), {
      title: 'Page not found',
      request: ['GET /pricing HTTP/1.1', 'Host: qa-tools.ru'],
      answer: 'HTTP/1.1 404 Not Found',
      body: 'There is nothing at this address. Check the URL, or go back to the home page.',
      action: { label: 'Go to home page', href: '/' },
    });
  });

  /** Acceptance 7: in Russian the way home is the Russian home page (D226). */
  it('leads home to the home page of the language shown', () => {
    const address = { pathname: '/pricing', search: '', host: HOST };

    assert.deepEqual(pageNotFoundView(address, ru).action, {
      label: ru.notFound.goHome,
      href: '/ru/',
    });
    assert.deepEqual(pageNotFoundView(address, en).action, {
      label: en.notFound.goHome,
      href: '/',
    });
    assert.deepEqual(
      sessionNotFoundView({ ...address, pathname: `/v/${NEW_ID}`, sessionId: NEW_ID }, ru).action,
      { label: 'На главную', href: '/ru/' },
    );
  });

  it('shows the whole address that was opened, a malformed session id included', () => {
    const view = pageNotFoundView({ pathname: '/v/xxx/extra', search: '?q=1', host: HOST });

    assert.equal(view.request[0], 'GET /v/xxx/extra?q=1 HTTP/1.1');
  });
});

/**
 * Both screens lead home, not to `Generate new URL`: the home page is where a
 * new session is created, and a screen reporting a missing session creates
 * none by itself (D147, as amended by D158).
 */
describe('GO_HOME', () => {
  it('goes to the home page', () => {
    assert.deepEqual(GO_HOME, { label: 'Go to home page', href: '/' });
  });
});

/** Each language's home page (issue #109, D226), where the wordmark and `Go to home page` lead. */
describe('homeAddress', () => {
  it('is / in English and /ru/ in Russian', () => {
    assert.deepEqual(HOME_ADDRESSES, { en: '/', ru: '/ru/' });
    assert.equal(homeAddress(en.lang), '/');
    assert.equal(homeAddress(ru.lang), '/ru/');
  });

  it('is English’s for a tag that is no language of the interface', () => {
    for (const tag of [
      '',
      'RU',
      'ru-RU',
      'de',
      '__proto__',
      'constructor',
      'toString',
      'x'.repeat(1024 * 1024),
    ]) {
      assert.equal(homeAddress(tag), '/', tag.slice(0, 20));
    }
  });

  it('is what every Russian home address reads as', () => {
    assert.deepEqual(classifyAddress(homeAddress('ru')), RUSSIAN_LANDING);
    assert.deepEqual(classifyAddress(homeAddress('en')), ENGLISH_LANDING);
  });
});
