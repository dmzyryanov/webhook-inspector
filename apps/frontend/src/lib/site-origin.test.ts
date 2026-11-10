import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- a plain ES module with no declarations; the build runs it.
import * as buildCheck from '../../scripts/check-build.mjs';
import {
  openApiText,
  productionRelayScriptText,
  relayScriptText,
  siteFiles,
} from '../../scripts/build-site-files.mjs';
import {
  CHANGELOG_SOURCE,
  changelogFeed,
  changelogMarkdown,
  type ChangelogEntry,
  feedEntryId,
  hasNotice,
  isNoticeParagraph,
  pageText,
  parseChangelog,
  readChangelog,
  readFeedEntries,
  renderChangelogBody,
  siteEntries,
} from '../../scripts/changelog.mjs';
import { MOVE_DAY_SENTENCE, moveDay, moveSetting } from '../../scripts/move-setting.mjs';
import { sha256Hex } from '../../scripts/relay-script.mjs';
import {
  ADDRESS_BULLET,
  MOVE_BULLET,
  OLD_NAME_BULLET,
  RELAY_HEADING,
} from '../../scripts/site-operator.mjs';
import {
  isProduction,
  nameSite,
  namesSecondOrigin,
  parseSiteOrigin,
  PRODUCTION_ORIGINS,
  relayApiOrigin,
  renameProduction,
  type SiteOrigins,
  siteOriginPlugin,
  siteOrigins,
} from '../../scripts/site-origin.mjs';

/**
 * The inspector's address as build configuration (issue #320, D274): the
 * build reads `APP_ORIGIN` and `RECEIVE_ORIGIN`, production's when unset, and
 * `APP_ALIAS_ORIGIN` (#319, D275), the site's second origin, production's
 * when unset while the site is production's and none for any other site, and
 * names them wherever the site names itself. Built for production, every
 * file is the one it was; built for another address, no `qa-tools.ru` is
 * left but the names kept: `contact@qa-tools.ru`, `status.qa-tools.ru` and
 * the feeds' `tag:qa-tools.ru` ids.
 */

const {
  checkBuild,
  doubledPortProblems,
  doubledPorts,
  productionNameProblems,
  productionNamesLeft,
  KEPT_PRODUCTION_NAMES,
} = buildCheck as {
  checkBuild: (dist: string, now: Date, entries: unknown[], origins: SiteOrigins) => string[];
  doubledPortProblems: (dist: string, origins?: SiteOrigins) => string[];
  doubledPorts: (text: string, origins?: SiteOrigins) => string[];
  productionNameProblems: (dist: string, origins?: SiteOrigins) => string[];
  productionNamesLeft: (text: string, origins?: SiteOrigins) => string[];
  KEPT_PRODUCTION_NAMES: RegExp;
};

/** A copy at another address with no second origin of its own, as it builds by default. */
const OTHER = {
  app: 'https://inspector.example',
  receive: 'https://hook.inspector.example',
  alias: null,
};
/** The same copy with a second origin of its own (D275). */
const OTHER_ALIAS = { ...OTHER, alias: 'https://next.inspector.example' };
const LOCAL = { app: 'http://localhost:5173', receive: 'http://127.0.0.1:3001', alias: null };
/** Day X's site (#324): a host whose name ends in production's, with no second. */
const DAY_X = {
  app: 'https://webhook.qa-tools.ru',
  receive: 'https://hook.qa-tools.ru',
  alias: null,
};
/** A copy on production's host with a port of its own (#339), as the issue built it. */
const PORTED = {
  app: 'https://qa-tools.ru:8443',
  receive: 'https://hook.qa-tools.ru',
  alias: null,
};
/** Each of production's three hosts with a port of its own (#339). */
const PORTED_ALL = {
  app: 'https://qa-tools.ru:8443',
  receive: 'https://hook.qa-tools.ru:8444',
  alias: 'https://webhook.qa-tools.ru:8445',
};
/** The same hosts over http, whose WebSocket scheme is `ws:` (#339). */
const PORTED_HTTP = {
  app: 'http://qa-tools.ru:8080',
  receive: 'http://hook.qa-tools.ru:8081',
  alias: 'http://webhook.qa-tools.ru:8082',
};

const FRONTEND = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Every source the build names the site from, by its path from this file. */
const SOURCES = [
  '../../index.html',
  '../../ru/index.html',
  '../../about/index.html',
  '../../ru/about/index.html',
  '../../terms/index.html',
  '../../privacy/index.html',
  '../../changelog/index.html',
  '../../docs/index.html',
  '../../public/robots.txt',
  '../../public/sitemap.xml',
  '../../public/webhook-inspector-relay.mjs',
  '../../llms/llms.txt',
  '../../llms/agent-section.md',
  '../../../../packages/shared/openapi.json',
  '../../../../CHANGELOG.md',
];

/** What is left of `text` that names production, outside the names kept. */
const leftOver = (text: string) => text.replace(KEPT_PRODUCTION_NAMES, '').match(/qa-tools\.ru/gi);

/** An origin as a changelog names it, ending where `nameSite()` reads a name to end. */
const MOVED_ORIGIN = String.raw`(https?:\/\/[\w.:[\]-]+)`;
const ORIGIN_END = String.raw`(?![\w:-]|\.[\w-])`;

/**
 * The ways a changelog's notice of a move says where from and where to,
 * matched where both sides are one origin: as 1.16.0's came out in a build
 * with no second origin before #343, `on <origin> and redirect to <origin>`
 * and `<origin> instead of <origin>`, and `from <origin> to <origin>`.
 */
const SAME_ORIGIN_MOVES = [
  new RegExp(String.raw`\bon ${MOVED_ORIGIN} and redirect to \1${ORIGIN_END}`, 'g'),
  new RegExp(String.raw`${MOVED_ORIGIN} instead of \1${ORIGIN_END}`, 'g'),
  new RegExp(String.raw`\bfrom ${MOVED_ORIGIN} to \1${ORIGIN_END}`, 'gi'),
];

/** Every place `text` names one origin on both sides of a move. */
const sameOriginMoves = (text: string) =>
  SAME_ORIGIN_MOVES.flatMap((pattern) => [...text.matchAll(pattern)].map(([found]) => found));

/**
 * The time, 5 s, each size of a hostile-text loop below is held to. Every
 * loop stops where its largest text is about 4 MB or less (#342): its last
 * size takes well under a second, while a scan going back over the text
 * from each position, quadratic in its length, takes seconds at 100 KB.
 */
const SIZE_BOUND_NS = 5_000_000_000n;

/** Fails unless less than `SIZE_BOUND_NS` has passed since `started`. */
const withinBound = (started: bigint, size: number) => {
  const elapsed = process.hrtime.bigint() - started;

  assert.ok(elapsed < SIZE_BOUND_NS, `size ${size}: ${elapsed / 1_000_000n} ms`);
};

describe('parseSiteOrigin', () => {
  it('keeps an http or https origin as URL.origin, and production’s when unset or blank', () => {
    const fallback = PRODUCTION_ORIGINS.app;

    assert.equal(parseSiteOrigin('APP_ORIGIN', undefined, fallback), fallback);
    assert.equal(parseSiteOrigin('APP_ORIGIN', '', fallback), fallback);
    assert.equal(parseSiteOrigin('APP_ORIGIN', ' \t\n', fallback), fallback);
    assert.equal(
      parseSiteOrigin('APP_ORIGIN', ' https://Inspector.Example:443 ', fallback),
      'https://inspector.example',
    );
    assert.equal(
      parseSiteOrigin('APP_ORIGIN', 'https://inspector.example/', fallback),
      'https://inspector.example',
    );
    assert.equal(
      parseSiteOrigin('APP_ORIGIN', 'http://127.0.0.1:43201', fallback),
      'http://127.0.0.1:43201',
    );
  });

  it('refuses anything but an origin alone, never quoting the value back', () => {
    for (const value of [
      'inspector.example',
      'ftp://inspector.example',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://',
      'https://inspector.example/path',
      'https://inspector.example/?',
      'https://inspector.example?x=1',
      'https://inspector.example#top',
      'https://user:secret-value@inspector.example',
      'https://secret-value@inspector.example',
      'https://inspector example',
    ]) {
      assert.throws(
        () => parseSiteOrigin('APP_ORIGIN', value, PRODUCTION_ORIGINS.app),
        (error: Error) =>
          error.message.startsWith('APP_ORIGIN ') && !error.message.includes('secret'),
        value,
      );
    }
  });

  it('refuses a host of any character the pages could not carry as it is, %22 decoded among them', () => {
    const refused = (value: string) =>
      assert.throws(
        () => parseSiteOrigin('RECEIVE_ORIGIN', value, PRODUCTION_ORIGINS.receive),
        (error: Error) =>
          error.message.startsWith('RECEIVE_ORIGIN ') &&
          !error.message.includes('evil') &&
          !error.message.includes('%'),
        JSON.stringify(value),
      );

    for (const character of [...'"\'`{}$&();!*,=+~_^|<>\\']) {
      refused(`https://a${character}evil.example`);
      refused(`https://a%${character.charCodeAt(0).toString(16).padStart(2, '0')}evil.example`);
    }
    for (const value of [
      'https://a%22evil.example',
      'https://a%27evil.example',
      'https://a%60evil.example',
      'https://%22onmouseover=evil()%22.example',
      'https://a%2522evil.example',
      'https://a%00evil.example',
      'https://a%0aevil.example',
      'http://evil"example:5173',
      'https://[evil]',
    ]) {
      refused(value);
    }

    // A host name of letters, digits and inner hyphens, an IPv6 address in
    // brackets, a port.
    assert.equal(parseSiteOrigin('X', 'http://[::1]:5173', ''), 'http://[::1]:5173');
    assert.equal(parseSiteOrigin('X', 'https://a-b.c-d.example', ''), 'https://a-b.c-d.example');
    assert.equal(
      parseSiteOrigin('X', 'https://xn--e1afmkfd.example', ''),
      'https://xn--e1afmkfd.example',
    );
    assert.equal(
      parseSiteOrigin('X', 'https://пример.example', ''),
      'https://xn--e1afmkfd.example',
    );

    // The largest text, at the last size: about 3 MB, `%22` a million times.
    for (const size of [10, 1000, 100_000, 1_000_000]) {
      const started = process.hrtime.bigint();

      refused(`https://${'a'.repeat(size)}"evil.example`);
      refused(`https://${'"'.repeat(size)}evil.example`);
      refused(`https://a${'%22'.repeat(size)}evil.example`);
      refused(`https://evil.${"'".repeat(size)}`);
      withinBound(started, size);
    }
  });

  it('refuses a host that is no host name, or port 0, never quoting the value, and keeps every host name, an IPv6 address and a port (#340)', () => {
    const hostRefusal =
      'APP_ORIGIN must name its host as dot-separated labels of letters, digits and inner hyphens, or as an IPv6 address in brackets';
    const portRefusal = 'APP_ORIGIN must not name port 0';
    // The refusal is fixed text, so it carries nothing of the value; a value
    // with a word of its own shows it once more.
    const refused = (value: string, message: string) =>
      assert.throws(
        () => parseSiteOrigin('APP_ORIGIN', value, PRODUCTION_ORIGINS.app),
        (error: Error) => error.message === message && !error.message.includes('secret'),
        JSON.stringify(value),
      );

    // An empty label, a trailing dot, a hyphen at either end of a label, and
    // a label of more than 63 characters.
    for (const value of [
      'https://-',
      'https://.',
      'https://a..b',
      'https://a.b.',
      'https://-a.example',
      'https://a-.example',
      'https://..',
      'https://.a',
      'https://a.-b',
      'https://a.b-',
      'https://A.Example.',
      'https://a.example.:8443',
      'http://-:5173',
      `https://${'a'.repeat(64)}.example`,
      `https://a.${'b'.repeat(64)}`,
      'https://-secret.example',
      'https://secret-.example',
      'https://secret..example',
      'https://secret.example.',
      `https://${'secret'.repeat(11)}.example`,
    ]) {
      refused(value, hostRefusal);
    }
    for (const value of [
      'https://a.example:0',
      'https://a.example:00',
      'http://localhost:0',
      'https://[::1]:0',
      'https://secret.example:0',
    ]) {
      refused(value, portRefusal);
    }

    for (const [value, origin = value] of [
      ['https://qa-tools.ru'],
      ['https://hook.qa-tools.ru'],
      ['https://webhook.qa-tools.ru'],
      ['https://hook.inspector.example'],
      ['http://localhost:5173'],
      ['https://[::1]:8080'],
      ['https://a.example:1'],
      ['https://a.example:65535'],
      ['https://a--b.0.example'],
      ['https://127.0.0.1'],
      ['https://Hook.Inspector.Example', 'https://hook.inspector.example'],
      ['https://пример.рф', 'https://xn--e1afmkfd.xn--p1ai'],
      [`https://${'a'.repeat(63)}.${'b'.repeat(63)}`],
    ]) {
      assert.equal(parseSiteOrigin('APP_ORIGIN', value, ''), origin, value);
    }

    // At growing sizes, hosts built to break the rule: one long label, a run
    // of dots or of hyphens, a million labels with a trailing dot, an empty
    // label or a hyphen at the end of each, and port 0 after a million labels.
    // The largest text, at the last size: 3 MB, `a-.` a million times.
    for (const size of [10, 1000, 100_000, 1_000_000]) {
      const started = process.hrtime.bigint();

      refused(`https://${'a'.repeat(64 + size)}.example`, hostRefusal);
      refused(`https://${'.'.repeat(size)}`, hostRefusal);
      refused(`https://${'-'.repeat(size)}`, hostRefusal);
      refused(`https://${'a.'.repeat(size)}`, hostRefusal);
      refused(`https://${'a.'.repeat(size)}.a`, hostRefusal);
      refused(`https://${'a-.'.repeat(size)}example`, hostRefusal);
      refused(`https://${'-a.'.repeat(size)}example`, hostRefusal);
      refused(`https://${'a.'.repeat(size)}example:0`, portRefusal);
      withinBound(started, size);
    }
  });

  it('reads long values at growing sizes, accepting a long host and refusing a long path', () => {
    // The largest text, at the last size: 2 MB, a host of a million labels,
    // and a million spaces and as many letters.
    for (const size of [10, 1000, 100_000, 1_000_000]) {
      const started = process.hrtime.bigint();
      const host = `${'a.'.repeat(size)}example`;

      assert.equal(parseSiteOrigin('X', `https://${host}`, ''), `https://${host}`);
      assert.throws(() =>
        parseSiteOrigin('X', `https://inspector.example/${'a'.repeat(size)}`, ''),
      );
      assert.throws(() => parseSiteOrigin('X', `https://inspector.example${'?'.repeat(size)}`, ''));
      assert.throws(() => parseSiteOrigin('X', ' '.repeat(size) + 'x'.repeat(size), ''));
      withinBound(started, size);
    }
  });

  it('reads both from an environment, each production’s when unset', () => {
    assert.deepEqual(siteOrigins({}), PRODUCTION_ORIGINS);
    assert.deepEqual(siteOrigins({ APP_ORIGIN: OTHER.app, RECEIVE_ORIGIN: OTHER.receive }), OTHER);
    assert.deepEqual(siteOrigins({ APP_ORIGIN: OTHER.app }), {
      app: OTHER.app,
      receive: PRODUCTION_ORIGINS.receive,
      alias: null,
    });
    assert.throws(
      () => siteOrigins({ RECEIVE_ORIGIN: 'https://hook.example/s' }),
      /^Error: RECEIVE_ORIGIN /,
    );
  });

  it('reads a production host with a port of its own as another site’s, which the build names as it is (#339)', () => {
    assert.deepEqual(siteOrigins({ APP_ORIGIN: PORTED.app }), PORTED);
    for (const origins of [PORTED_ALL, PORTED_HTTP]) {
      assert.deepEqual(
        siteOrigins({
          APP_ORIGIN: origins.app,
          RECEIVE_ORIGIN: origins.receive,
          APP_ALIAS_ORIGIN: origins.alias,
        }),
        origins,
      );
    }
    assert.equal(isProduction(PORTED), false);
    assert.equal(isProduction(PORTED_ALL), false);
  });

  it('reads the second origin: production’s for production’s site, none for another unless given (#319, D275)', () => {
    assert.deepEqual(PRODUCTION_ORIGINS, {
      app: 'https://qa-tools.ru',
      receive: 'https://hook.qa-tools.ru',
      alias: 'https://webhook.qa-tools.ru',
    });
    assert.equal(siteOrigins({ APP_ALIAS_ORIGIN: '' }).alias, PRODUCTION_ORIGINS.alias);
    assert.equal(siteOrigins({ RECEIVE_ORIGIN: OTHER.receive }).alias, PRODUCTION_ORIGINS.alias);
    assert.equal(siteOrigins({ APP_ORIGIN: OTHER.app }).alias, null);
    assert.deepEqual(
      siteOrigins({
        APP_ORIGIN: OTHER.app,
        RECEIVE_ORIGIN: OTHER.receive,
        APP_ALIAS_ORIGIN: ' https://NEXT.inspector.example:443/ ',
      }),
      OTHER_ALIAS,
    );
    // Day X's: the second host the site, with no second of its own.
    assert.deepEqual(siteOrigins({ APP_ORIGIN: DAY_X.app, RECEIVE_ORIGIN: DAY_X.receive }), DAY_X);
    assert.equal(
      siteOrigins({ APP_ORIGIN: OTHER.app, APP_ALIAS_ORIGIN: PRODUCTION_ORIGINS.alias }).alias,
      PRODUCTION_ORIGINS.alias,
    );
    assert.equal(relayApiOrigin(PRODUCTION_ORIGINS), 'https://webhook.qa-tools.ru');
    assert.equal(relayApiOrigin(OTHER), OTHER.app);
    assert.equal(relayApiOrigin(OTHER_ALIAS), OTHER_ALIAS.alias);
    assert.equal(relayApiOrigin({ app: OTHER.app, receive: OTHER.receive }), OTHER.app);
  });

  it('refuses a second origin that is not an origin, is the site’s or the receive host’s, or swaps production’s names, never quoting it', () => {
    for (const value of [
      'next.inspector.example',
      'https://next.inspector.example/path',
      'https://user:secret-value@next.inspector.example',
      'https://next"evil.example',
    ]) {
      assert.throws(
        () => siteOrigins({ APP_ORIGIN: OTHER.app, APP_ALIAS_ORIGIN: value }),
        (error: Error) =>
          error.message.startsWith('APP_ALIAS_ORIGIN ') &&
          !error.message.includes('secret') &&
          !error.message.includes('evil'),
        value,
      );
    }
    for (const env of [
      { APP_ORIGIN: OTHER.app, RECEIVE_ORIGIN: OTHER.receive, APP_ALIAS_ORIGIN: OTHER.app },
      { APP_ORIGIN: OTHER.app, RECEIVE_ORIGIN: OTHER.receive, APP_ALIAS_ORIGIN: OTHER.receive },
      { APP_ALIAS_ORIGIN: PRODUCTION_ORIGINS.app },
    ]) {
      assert.throws(
        () => siteOrigins(env),
        /^Error: APP_ALIAS_ORIGIN must name a host other than the site and the receive host$/,
      );
    }
    // A site on the second host with the first as its second would come out
    // with the two swapped; so would any production name given to another.
    for (const [env, name] of [
      [{ APP_ORIGIN: DAY_X.app, APP_ALIAS_ORIGIN: PRODUCTION_ORIGINS.app }, 'APP_ORIGIN'],
      [{ APP_ORIGIN: PRODUCTION_ORIGINS.receive, RECEIVE_ORIGIN: OTHER.receive }, 'APP_ORIGIN'],
      [{ APP_ORIGIN: OTHER.app, RECEIVE_ORIGIN: PRODUCTION_ORIGINS.app }, 'RECEIVE_ORIGIN'],
      [
        {
          APP_ORIGIN: OTHER.app,
          RECEIVE_ORIGIN: OTHER.receive,
          APP_ALIAS_ORIGIN: 'https://qa-tools.ru',
        },
        'APP_ALIAS_ORIGIN',
      ],
    ] as const) {
      assert.throws(
        () => siteOrigins(env),
        new RegExp(
          `^Error: ${name} names an address of production's that the build would name otherwise`,
        ),
        JSON.stringify(env),
      );
    }
  });
});

describe('nameSite', () => {
  it('returns every source as it is under production’s origins, and so does the rename itself', () => {
    for (const path of SOURCES) {
      const text = read(path);

      assert.equal(nameSite(text, PRODUCTION_ORIGINS), text, path);
      assert.equal(renameProduction(text, PRODUCTION_ORIGINS), text, path);
    }
    // Production's three origins, and nothing less: a set with production's
    // two and no second is another site's (D275).
    assert.equal(isProduction(PRODUCTION_ORIGINS), true);
    assert.equal(isProduction({ ...PRODUCTION_ORIGINS, alias: null }), false);
    assert.equal(
      isProduction({ app: PRODUCTION_ORIGINS.app, receive: PRODUCTION_ORIGINS.receive }),
      false,
    );
    assert.equal(isProduction({ ...PRODUCTION_ORIGINS, alias: OTHER_ALIAS.alias }), false);
  });

  it('names the second origin where production’s is, or the site’s where there is none (#319, D275)', () => {
    const text = [
      'https://webhook.qa-tools.ru/webhook-inspector-relay.mjs',
      'wss://webhook.qa-tools.ru/ws/G4t',
      'on `webhook.qa-tools.ru` too',
      "export const DEFAULT_API = 'https://webhook.qa-tools.ru';",
      'https://qa-tools.ru/ and https://hook.qa-tools.ru/s/G4t',
    ].join('\n');

    assert.equal(
      nameSite(text, OTHER_ALIAS),
      [
        'https://next.inspector.example/webhook-inspector-relay.mjs',
        'wss://next.inspector.example/ws/G4t',
        'on `next.inspector.example` too',
        "export const DEFAULT_API = 'https://next.inspector.example';",
        'https://inspector.example/ and https://hook.inspector.example/s/G4t',
      ].join('\n'),
    );
    assert.equal(
      nameSite(text, OTHER),
      [
        'https://inspector.example/webhook-inspector-relay.mjs',
        'wss://inspector.example/ws/G4t',
        'on `inspector.example` too',
        "export const DEFAULT_API = 'https://inspector.example';",
        'https://inspector.example/ and https://hook.inspector.example/s/G4t',
      ].join('\n'),
    );
    // Production's two and no second: the second's name is the site's.
    assert.equal(
      nameSite('https://webhook.qa-tools.ru/x', { ...PRODUCTION_ORIGINS, alias: null }),
      'https://qa-tools.ru/x',
    );
    // Day X's site keeps its own name.
    assert.equal(
      nameSite(text, DAY_X).split('\n')[0],
      'https://webhook.qa-tools.ru/webhook-inspector-relay.mjs',
    );
    // Every source, with a second origin of the copy's own, names production nowhere.
    assert.equal(leftOver(nameSite(SOURCES.map(read).join('\n'), OTHER_ALIAS)), null);
  });

  it('names the configured origins in place of production’s, as origins and as hosts', () => {
    assert.equal(
      nameSite(
        [
          'https://qa-tools.ru/',
          'https://hook.qa-tools.ru/s/G4t',
          'wss://qa-tools.ru/ws/G4t',
          'Host: hook.qa-tools.ru',
          'on `qa-tools.ru` alone.',
          'the proxy of qa-tools.ru.',
          '(https://qa-tools.ru)',
          '\\"inspectorUrl\\":\\"https://qa-tools.ru/v/G4t\\"',
          '//qa-tools.ru/x',
          'http://qa-tools.ru',
          '<loc>https://qa-tools.ru/docs</loc>',
        ].join('\n'),
        OTHER,
      ),
      [
        'https://inspector.example/',
        'https://hook.inspector.example/s/G4t',
        'wss://inspector.example/ws/G4t',
        'Host: hook.inspector.example',
        'on `inspector.example` alone.',
        'the proxy of inspector.example.',
        '(https://inspector.example)',
        '\\"inspectorUrl\\":\\"https://inspector.example/v/G4t\\"',
        '//inspector.example/x',
        'http://inspector.example',
        '<loc>https://inspector.example/docs</loc>',
      ].join('\n'),
    );
    assert.equal(
      nameSite('wss://qa-tools.ru/ws/1 https://hook.qa-tools.ru/s/1 hook.qa-tools.ru', LOCAL),
      'ws://localhost:5173/ws/1 http://127.0.0.1:3001/s/1 127.0.0.1:3001',
    );
  });

  it('keeps the platform’s names, the feeds’ ids and every longer host', () => {
    for (const kept of [
      'contact@qa-tools.ru',
      'mailto:contact@qa-tools.ru',
      'https://status.qa-tools.ru/',
      'status.qa-tools.ru,',
      'tag:qa-tools.ru,2026:changelog/0.51.0',
      'xqa-tools.ru',
      'my-qa-tools.ru',
      '_qa-tools.ru',
      'qa-tools.ruby',
      'qa-tools.ru-x',
      'qa-tools.ru.example',
      'qa-tools.ru_x',
      'sub.hook.qa-tools.ru',
      'sub.webhook.qa-tools.ru',
      'xwebhook.qa-tools.ru',
      'web-hook.qa-tools.ru',
      'webhook.qa-tools.rux',
      'webhook.qa-tools.ru.example',
      'hook.qa-tools.rux',
      'qa-tools.rus',
      'QA-TOOLS.RU',
      'x-qa-tools-request-id',
      'qa-tools-relay.mjs',
      '@qa-tools/shared',
      'qa-tools.ruqa-tools.ru',
      // A host with a port is another origin than production's (#339), the
      // default one written out too: no source names one, and a copy's build
      // that kept one would fail the build check, which finds it left.
      'https://qa-tools.ru:443/',
      'https://qa-tools.ru:8443/about',
      'wss://qa-tools.ru:8443/ws/G4t',
      'qa-tools.ru:8443',
      'https://hook.qa-tools.ru:8444/s/G4t',
      'webhook.qa-tools.ru:8445',
      'http://qa-tools.ru:8080',
      'qa-tools.ru:1',
    ]) {
      assert.equal(nameSite(kept, OTHER), kept, kept);
    }
    // A `:` and no digit is no port: the name before it is renamed.
    assert.equal(
      nameSite('qa-tools.ru: hook.qa-tools.ru:x qa-tools.ru:', OTHER),
      'inspector.example: hook.inspector.example:x inspector.example:',
    );
  });

  it('names a production host with a port of its own where production’s name is, once (#339)', () => {
    const text = [
      'https://qa-tools.ru/about',
      'wss://qa-tools.ru/ws/G4t',
      'on `qa-tools.ru` alone.',
      'https://hook.qa-tools.ru/s/G4t',
      'Host: hook.qa-tools.ru',
      'https://webhook.qa-tools.ru/webhook-inspector-relay.mjs',
      'contact@qa-tools.ru https://status.qa-tools.ru/ tag:qa-tools.ru,2026:changelog/1.0.0',
    ].join('\n');

    assert.equal(
      renameProduction(text, PORTED),
      [
        'https://qa-tools.ru:8443/about',
        'wss://qa-tools.ru:8443/ws/G4t',
        'on `qa-tools.ru:8443` alone.',
        'https://hook.qa-tools.ru/s/G4t',
        'Host: hook.qa-tools.ru',
        'https://qa-tools.ru:8443/webhook-inspector-relay.mjs',
        'contact@qa-tools.ru https://status.qa-tools.ru/ tag:qa-tools.ru,2026:changelog/1.0.0',
      ].join('\n'),
    );
    assert.equal(
      renameProduction(text, PORTED_ALL),
      [
        'https://qa-tools.ru:8443/about',
        'wss://qa-tools.ru:8443/ws/G4t',
        'on `qa-tools.ru:8443` alone.',
        'https://hook.qa-tools.ru:8444/s/G4t',
        'Host: hook.qa-tools.ru:8444',
        'https://webhook.qa-tools.ru:8445/webhook-inspector-relay.mjs',
        'contact@qa-tools.ru https://status.qa-tools.ru/ tag:qa-tools.ru,2026:changelog/1.0.0',
      ].join('\n'),
    );
    assert.equal(
      renameProduction(text, PORTED_HTTP).split('\n').slice(0, 2).join('\n'),
      'http://qa-tools.ru:8080/about\nws://qa-tools.ru:8080/ws/G4t',
    );
  });

  it('may pass a text through twice: what names the configured origins comes back unchanged', () => {
    const text = SOURCES.map(read).join('\n');

    for (const origins of [OTHER, OTHER_ALIAS, LOCAL, DAY_X, PORTED, PORTED_ALL, PORTED_HTTP]) {
      const once = renameProduction(text, origins);

      assert.equal(renameProduction(once, origins), once, origins.app);
      assert.equal(nameSite(nameSite(text, origins), origins), once, origins.app);
      assert.deepEqual(doubledPorts(once, origins), [], origins.app);
    }
    assert.equal(leftOver(nameSite(text, OTHER)), null);
    // A production host with a port of its own: every source names it once,
    // and no production name is left but the names kept and its own hosts.
    for (const origins of [PORTED, PORTED_ALL, PORTED_HTTP]) {
      const once = renameProduction(text, origins);

      assert.equal(/qa-tools\.ru:\d+:\d/i.exec(once), null, origins.app);
      assert.deepEqual(productionNamesLeft(once, origins), [], origins.app);
    }
  });

  it('scans hostile text at growing sizes in time linear in its length', () => {
    // The largest text, at the last size: 3.1 MB, the hook origin 100 000 times.
    for (const size of [1000, 10_000, 100_000]) {
      const started = process.hrtime.bigint();

      assert.equal(nameSite('qa-tools.ru '.repeat(size), OTHER), 'inspector.example '.repeat(size));
      assert.equal(
        nameSite('https://hook.qa-tools.ru/'.repeat(size), OTHER),
        'https://hook.inspector.example/'.repeat(size),
      );
      assert.equal(
        nameSite('webhook.qa-tools.ru '.repeat(size), OTHER_ALIAS),
        'next.inspector.example '.repeat(size),
      );
      // A longer host ending in the second's name is kept, as any is.
      assert.equal(
        nameSite(`${'webhook.'.repeat(size)}qa-tools.ru`, OTHER_ALIAS),
        `${'webhook.'.repeat(size)}qa-tools.ru`,
      );
      assert.equal(
        nameSite(`${'web'.repeat(size)}hook.qa-tools.ru`, OTHER_ALIAS),
        `${'web'.repeat(size)}hook.qa-tools.ru`,
      );
      for (const kept of [
        `${'.'.repeat(size)}qa-tools.ru`,
        `${'@'.repeat(size)}qa-tools.ru`,
        `${'hook.'.repeat(size)}qa-tools.ru`,
        'qa-tools.ru'.repeat(size),
        `${'-'.repeat(size)}qa-tools.ru`,
        `qa-tools.ru${'-'.repeat(size)}`,
        `tag:qa-tools.ru,${'a'.repeat(size)}`,
        'q'.repeat(size),
        'qa-tools.r'.repeat(size),
        `https:/${'/'.repeat(size)}`,
      ]) {
        assert.equal(nameSite(kept, OTHER), kept);
      }
      assert.equal(
        nameSite(`${'https://'.repeat(size)}qa-tools.ru`, OTHER),
        `${'https://'.repeat(size - 1)}https://inspector.example`,
      );
      // A production host with a port of its own, named and named again (#339).
      for (const named of [
        'https://qa-tools.ru:8443/ '.repeat(size),
        'qa-tools.ru:8443'.repeat(size),
        `qa-tools.ru${':8443'.repeat(size)}`,
        `qa-tools.ru:${'8'.repeat(size)}`,
        'wss://qa-tools.ru:8443:'.repeat(size),
      ]) {
        assert.equal(renameProduction(named, PORTED), named);
      }
      assert.equal(
        renameProduction('https://qa-tools.ru/ '.repeat(size), PORTED),
        'https://qa-tools.ru:8443/ '.repeat(size),
      );
      const colons = renameProduction('qa-tools.ru:'.repeat(size), PORTED);

      assert.equal(colons, `qa-tools.ru:8443:${'qa-tools.ru:'.repeat(size - 1)}`);
      assert.equal(renameProduction(colons, PORTED), colons);
      withinBound(started, size);
    }
  });

  it('runs last on every page of every build, naming what the other plugins wrote', () => {
    const plugin = siteOriginPlugin(OTHER);

    assert.equal(plugin.transformIndexHtml.order, 'post');
    assert.equal(
      plugin.transformIndexHtml.handler('<link rel="canonical" href="https://qa-tools.ru/ru/" />'),
      '<link rel="canonical" href="https://inspector.example/ru/" />',
    );

    for (const config of [
      'vite.config.ts',
      'vite.about.config.ts',
      'vite.legal.config.ts',
      'vite.changelog.config.ts',
    ]) {
      assert.match(read(`../../${config}`), /\bsiteOriginPlugin\(\),?\n? *\]/, config);
    }
    // The API reference's page names no address of its own.
    assert.equal(leftOver(read('../../docs/index.html')), null);
  });
});

describe('the files the build writes from public/ and the description', () => {
  it('are their sources byte for byte under production’s origins', () => {
    const files = siteFiles(PRODUCTION_ORIGINS);

    assert.deepEqual(Object.keys(files), [
      'robots.txt',
      'sitemap.xml',
      'webhook-inspector-relay.mjs',
      'qa-tools-relay.mjs',
      'openapi.json',
    ]);
    assert.equal(files['robots.txt'], read('../../public/robots.txt'));
    assert.equal(files['sitemap.xml'], read('../../public/sitemap.xml'));
    // One relay script under both names (D279).
    assert.equal(
      files['webhook-inspector-relay.mjs'],
      read('../../public/webhook-inspector-relay.mjs'),
    );
    assert.equal(files['qa-tools-relay.mjs'], read('../../public/webhook-inspector-relay.mjs'));
    assert.equal(files['openapi.json'], read('../../../../packages/shared/openapi.json'));
  });

  it('give the relay script’s SHA-256 in the description as the built script’s (D275)', () => {
    const production = sha256Hex(productionRelayScriptText());

    assert.ok(read('../../../../packages/shared/openapi.json').includes(production));
    assert.equal(sha256Hex(relayScriptText(PRODUCTION_ORIGINS)), production);

    for (const origins of [OTHER, OTHER_ALIAS]) {
      const built = sha256Hex(relayScriptText(origins));
      const description = openApiText(origins);

      assert.notEqual(built, production);
      assert.ok(description.includes(built));
      assert.ok(!description.includes(production));
    }
  });

  it('write the relay script under both names reading the second origin, or the site’s where there is none (D275, D279)', () => {
    for (const [origins, api] of [
      [PRODUCTION_ORIGINS, 'https://webhook.qa-tools.ru'],
      [OTHER_ALIAS, OTHER_ALIAS.alias],
      [OTHER, OTHER.app],
    ] as const) {
      const files = siteFiles(origins);
      const script = relayScriptText(origins);

      assert.equal(files['webhook-inspector-relay.mjs'], script, api);
      assert.equal(files['qa-tools-relay.mjs'], script, api);
      assert.ok(script.includes(`export const DEFAULT_API = '${api}';`), api);
      assert.ok(script.includes(`(default ${api})`), api);
      assert.ok(script.includes('Usage: node webhook-inspector-relay.mjs <session id'), api);
      assert.ok(script.includes(`${origins.receive}/s/<session id>`), api);
    }
  });

  it('write the description’s Network section as before with a second origin, and without the bullet on production’s move with none (#386), nor the relay section’s bullet on the old name, the one host named once (#431)', () => {
    const source = read('../../../../packages/shared/openapi.json');
    // What the build wrote before #386 with production's operator settings,
    // which this suite's environment gives: named, with the built relay
    // script's SHA-256.
    const before = (origins: SiteOrigins) =>
      nameSite(source, origins).replaceAll(
        sha256Hex(productionRelayScriptText()),
        sha256Hex(relayScriptText(origins)),
      );
    const description = (text: string) =>
      (JSON.parse(text) as { info: { description: string } }).info.description;

    // Production's, and a copy with a second origin of its own: byte for byte.
    assert.equal(openApiText(PRODUCTION_ORIGINS), source);
    assert.equal(openApiText(OTHER_ALIAS), before(OTHER_ALIAS));
    assert.ok(
      description(openApiText(OTHER_ALIAS)).includes(
        `${MOVE_BULLET}\`next.inspector.example\`.** Since 1.16.0`,
      ),
    );

    // No second origin: the bullet would move the site from its origin to
    // the same one, and goes; so does the relay section's bullet on the old
    // name, which tells only production's rename and move, and the address
    // bullet names the one host once (#431); every other byte is as before.
    for (const origins of [OTHER, LOCAL, DAY_X, PORTED]) {
      const named = description(before(origins));
      const host = new URL(origins.app).host;
      const receive = new URL(origins.receive).host;
      const lineOf = (start: string) =>
        named.split('\n').find((each) => each.startsWith(start)) as string;
      const line = lineOf(MOVE_BULLET);
      const oldName = lineOf(OLD_NAME_BULLET);
      const address = lineOf(ADDRESS_BULLET);
      const json = (text: string) => JSON.stringify(text).slice(1, -1);

      assert.ok(line.startsWith(`${MOVE_BULLET}\`${host}\`.** Since 1.16.0`), host);
      assert.ok(line.includes(`The ones on \`${host}\` keep working`), host);
      assert.ok(oldName.startsWith(`${OLD_NAME_BULLET} Until 1.16.0`), host);
      assert.ok(address.includes(`\`${host}\` and \`${host}\` — each the site`), host);
      assert.equal(
        openApiText(origins),
        before(origins)
          .replace(json(`${line}\n`), '')
          .replace(json(`${oldName}\n`), '')
          .replace(
            json(address),
            json(
              `- **One address: \`80.87.198.166\`.** \`${host}\` — the site, the API, the WebSocket and the MCP server — and \`${receive}\`, which receives webhooks, all answer on it.`,
            ),
          ),
        host,
      );
      assert.ok(!description(openApiText(origins)).includes('**Moving to '), host);
      assert.ok(!description(openApiText(origins)).includes(OLD_NAME_BULLET), host);
      assert.ok(description(openApiText(origins)).includes('\n\n## Network\n\n'), host);
    }
  });
});

/**
 * The changelog of a build with no second origin (#343). Such a build names
 * the site's own origin where `CHANGELOG.md` names production's second
 * (D275), so 1.16.0's notice of the move came out saying that the site's
 * addresses stop answering on its origin and redirect to the same one.
 * `readChangelog()`, which every output built from the changelog reads - the
 * page, `changelog.md`, both feeds and the dev server's copies of them -
 * leaves out of such a build every Breaking, Deprecated or Notice paragraph
 * that names production's second origin, and nothing else; a build with a
 * second origin, or production's, reads the source as it did before.
 */
describe('the changelog of a build with no second origin (#343)', () => {
  const source = readFileSync(CHANGELOG_SOURCE, 'utf8');
  const written = parseChangelog(source);

  /** Builds with no second origin: a copy, a local one, one on a port of production's host, and day X's site. */
  const NO_SECOND = [OTHER, LOCAL, PORTED, DAY_X];

  /** Whether `text` names production's second origin: whether a second origin of a copy's own would change it. */
  const namesTheSecond = (text: string) =>
    renameProduction(text, OTHER) !== renameProduction(text, OTHER_ALIAS);

  /** Whether a paragraph, as written, is one a build with no second origin leaves out. */
  const leftOut = (paragraph: string) => isNoticeParagraph(paragraph) && namesTheSecond(paragraph);

  /** The changelog as a build for `origins` read it before #343: the whole source named, then read. */
  const readBefore = (origins: SiteOrigins) => parseChangelog(nameSite(source, origins));

  /** An entry with only the paragraphs `keep` keeps, marked by what is left. */
  const keeping = (entry: ChangelogEntry, keep: (paragraph: string, at: number) => boolean) => {
    const paragraphs = entry.paragraphs.filter(keep);

    return {
      ...entry,
      paragraphs,
      breaking: paragraphs.some((paragraph) => paragraph.startsWith('**Breaking:**')),
      deprecated: paragraphs.some((paragraph) => paragraph.startsWith('**Deprecated:**')),
      notice: paragraphs.some((paragraph) => paragraph.startsWith('**Notice:**')),
    };
  };

  const notices = (entries: ChangelogEntry[]) =>
    entries.flatMap((entry) => entry.paragraphs.filter(isNoticeParagraph));

  it('leaves out every notice that names production’s second origin, 1.16.0’s among them, and changes nothing else', () => {
    const dropped = written.flatMap((entry) =>
      entry.paragraphs.filter(leftOut).map((paragraph) => `${entry.version} ${paragraph}`),
    );

    assert.ok(
      dropped.some((line) =>
        line.startsWith(
          "1.16.0 **Deprecated:** Webhook Inspector's addresses on https://qa-tools.ru — the API",
        ),
      ),
      dropped.join('\n'),
    );

    for (const origins of NO_SECOND) {
      const before = readBefore(origins);
      const expected = before.map((entry, index) =>
        keeping(entry, (_, at) => !leftOut(written[index]?.paragraphs[at] ?? '')),
      );

      assert.equal(before.length, written.length);
      assert.deepEqual(readChangelog(CHANGELOG_SOURCE, origins), expected, origins.app);
    }
  });

  it('publishes no notice naming one origin on both sides of a move, in the text, the page or either feed', () => {
    for (const origins of NO_SECOND) {
      const entries = readChangelog(CHANGELOG_SOURCE, origins);
      const move = entries.find((entry) => entry.version === '1.16.0');
      const ids = (kind: 'all' | 'breaking') =>
        readFeedEntries(changelogFeed(entries, kind)).map((entry) => entry.id);

      // Before #343 the notice moved the site to itself twice over.
      assert.deepEqual(
        sameOriginMoves(notices(readBefore(origins)).join('\n')),
        [
          `on ${origins.app} and redirect to ${origins.app}`,
          `${origins.app} instead of ${origins.app}`,
        ],
        origins.app,
      );
      assert.deepEqual(sameOriginMoves(notices(entries).join('\n')), [], origins.app);
      for (const text of [
        changelogMarkdown(entries),
        pageText(renderChangelogBody(entries)),
        changelogFeed(entries, 'all'),
        changelogFeed(entries, 'breaking'),
      ]) {
        assert.deepEqual(sameOriginMoves(text), [], origins.app);
        assert.ok(!MOVE_DAY_SENTENCE.test(text), origins.app);
      }

      // 1.16.0 is no longer marked, so the breaking feed leaves it out;
      // 1.19.0's notice of the old names, which names no host, stays.
      assert.ok(move);
      assert.equal(hasNotice(move), false);
      assert.equal(entries.find((entry) => entry.version === '1.19.0')?.deprecated, true);
      assert.ok(!ids('breaking').includes(feedEntryId('1.16.0')), origins.app);
      assert.ok(ids('breaking').includes(feedEntryId('1.19.0')), origins.app);
      assert.ok(ids('all').includes(feedEntryId('1.16.0')), origins.app);
      // A build with no second origin has no move, so nothing reads day X from it (D276).
      assert.equal(moveSetting(origins), null);
    }
  });

  it('keeps every notice in a build with a second origin of its own, naming the two apart', () => {
    for (const origins of [OTHER_ALIAS, PORTED_ALL, PORTED_HTTP]) {
      const entries = readChangelog(CHANGELOG_SOURCE, origins);

      assert.deepEqual(entries, readBefore(origins), origins.app);
      assert.deepEqual(sameOriginMoves(notices(entries).join('\n')), [], origins.app);
    }

    const move = readChangelog(CHANGELOG_SOURCE, OTHER_ALIAS).find(
      (entry) => entry.version === '1.16.0',
    );

    assert.ok(move);
    assert.equal(move.deprecated, true);
    assert.ok(
      move.paragraphs.some((paragraph) =>
        paragraph.includes(
          `they stop answering on ${OTHER.app} and redirect to ${OTHER_ALIAS.alias},`,
        ),
      ),
    );
    // The move banner still reads day X from the notice there.
    assert.equal(moveSetting(OTHER_ALIAS)?.day, moveDay(written));
  });

  it('gives production’s entries as written, so a production build is byte for byte what it was', () => {
    const entries = readChangelog(CHANGELOG_SOURCE, PRODUCTION_ORIGINS);

    assert.deepEqual(entries, written);
    assert.deepEqual(entries, readBefore(PRODUCTION_ORIGINS));
    assert.equal(siteEntries(written, PRODUCTION_ORIGINS), written);
    // Unset, the origins are production's.
    assert.equal(siteEntries(written, siteOrigins({})), written);
    assert.equal(entries.find((entry) => entry.version === '1.16.0')?.deprecated, true);
    assert.ok(notices(entries).some((paragraph) => MOVE_DAY_SENTENCE.test(paragraph)));
    // Every output is written from the entries alone.
    const before = readBefore(PRODUCTION_ORIGINS);

    assert.equal(changelogMarkdown(entries), changelogMarkdown(before));
    assert.equal(renderChangelogBody(entries), renderChangelogBody(before));
    for (const kind of ['all', 'breaking'] as const) {
      assert.equal(changelogFeed(entries, kind), changelogFeed(before, kind), kind);
    }
  });

  it('reads production’s second origin as the rename reads a name, and nothing longer, shorter or with a port', () => {
    const named = [
      'https://webhook.qa-tools.ru',
      'https://webhook.qa-tools.ru/webhook-inspector-relay.mjs',
      'wss://webhook.qa-tools.ru/ws/G4t',
      'http://webhook.qa-tools.ru/',
      'on `webhook.qa-tools.ru` too',
      'they redirect to webhook.qa-tools.ru.',
      '(https://webhook.qa-tools.ru)',
      'https://qa-tools.ru and https://webhook.qa-tools.ru',
    ];
    const notNamed = [
      '',
      'https://qa-tools.ru',
      'https://hook.qa-tools.ru/s/G4t',
      'webhook.qa-tools.ru:8445',
      'https://webhook.qa-tools.ru:8445/',
      'my-webhook.qa-tools.ru',
      'status.webhook.qa-tools.ru',
      'contact@webhook.qa-tools.ru',
      'tag:webhook.qa-tools.ru,2026:changelog/1.0.0',
      'webhook.qa-tools.run',
      'webhook.qa-tools.ru-next',
      'webhook.qa-tools.ru.example',
      'webhook.qa-tools-ru',
      'webhook-qa-tools.ru',
      // Not renamed either: the rename reads production's names as written.
      'HTTPS://WEBHOOK.QA-TOOLS.RU',
    ];

    for (const text of named) {
      assert.equal(namesSecondOrigin(text), true, text);
      assert.equal(namesTheSecond(text), true, text);
    }
    for (const text of notNamed) {
      assert.equal(namesSecondOrigin(text), false, text);
      assert.equal(namesTheSecond(text), false, text);
    }
  });

  it('scans hostile text at growing sizes in time linear in its length', () => {
    // The largest text, at the last size: 2.9 MB, the second origin's address 100 000 times.
    for (const size of [1000, 10_000, 100_000]) {
      const started = process.hrtime.bigint();

      for (const kept of [
        'webhook.qa-tools.r'.repeat(size),
        `${'webhook.'.repeat(size)}qa-tools.ru`,
        `${'-'.repeat(size)}webhook.qa-tools.ru`,
        `${'w'.repeat(size)}ebhook.qa-tools.ru`,
        'webhook.qa-tools.ru:8445 '.repeat(size),
        `webhook.qa-tools.ru${':8'.repeat(size)}`,
        `webhook.qa-tools.ru${'-'.repeat(size)}`,
        'qa-tools.ru hook.qa-tools.ru '.repeat(size),
        `${'https://'.repeat(size)}qa-tools.ru`,
      ]) {
        assert.equal(namesSecondOrigin(kept), false, kept.slice(0, 40));
      }
      for (const found of [
        `${'x '.repeat(size)}https://webhook.qa-tools.ru`,
        'https://webhook.qa-tools.ru/ '.repeat(size),
        `${'webhook.qa-tools.r'.repeat(size)} webhook.qa-tools.ru`,
        `${'webhook.qa-tools.ru:8445 '.repeat(size)}wss://webhook.qa-tools.ru`,
      ]) {
        assert.equal(namesSecondOrigin(found), true, found.slice(0, 40));
      }
      withinBound(started, size);
    }
  });

  for (const count of [10, 5_000]) {
    it(`leaves the notices out of a changelog of ${count.toLocaleString('en')} versions, each with hostile names`, () => {
      const nearMisses = 'webhook.qa-tools.r webhook.qa-tools.ru:8445 my-webhook.qa-tools.ru';
      const versions = Array.from({ length: count }, (_, index) =>
        [
          `## 1.${count - index}.0`,
          '2026-09-21',
          `**Version ${count - index} at https://webhook.qa-tools.ru.** Also https://qa-tools.ru.`,
          `**Deprecated:** ${nearMisses} and, from 2026-12-01, https://webhook.qa-tools.ru.`,
          `**Notice:** ${nearMisses} on 2026-12-01.`,
          `**Breaking:** on https://qa-tools.ru and \`wss://webhook.qa-tools.ru\`.`,
          `Webhooks stay on https://hook.qa-tools.ru; ${nearMisses}; webhook.qa-tools.ru.`,
        ].join('\n\n'),
      );
      const many = parseChangelog(`# Header\n\n${versions.join('\n\n')}\n`);
      const started = process.hrtime.bigint();
      const entries = siteEntries(many, OTHER);

      withinBound(started, count);
      assert.equal(entries.length, count);
      for (const entry of entries) {
        assert.equal(
          entry.headline,
          `Version ${entry.version.split('.')[1]} at https://inspector.example.`,
        );
        assert.equal(entry.lead, 'Also https://inspector.example.');
        assert.deepEqual(entry.paragraphs, [
          `**Notice:** ${nearMisses} on 2026-12-01.`,
          `Webhooks stay on https://hook.inspector.example; ${nearMisses}; inspector.example.`,
        ]);
        assert.deepEqual([entry.breaking, entry.deprecated, entry.notice], [false, false, true]);
      }
      // With a second origin of the copy's own, every paragraph stays, named.
      assert.deepEqual(
        siteEntries(many, OTHER_ALIAS).map((entry) => entry.paragraphs.length),
        many.map(() => 4),
      );
      assert.equal(readFeedEntries(changelogFeed(entries, 'breaking')).length, count);
    });
  }
});

/**
 * The build check's refusal of a build for another address that still names
 * production (issue #320), on trees written here: the configured
 * hosts are names the build may carry, even where they end in production's,
 * as day X's do (#324), and every other `qa-tools.ru` is reported.
 */
describe('the build check of a build for another address', () => {
  const trees: string[] = [];

  /** A directory holding `files`, by their paths in it. */
  const tree = (files: Record<string, string>) => {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-name-check-'));

    trees.push(dist);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dist, path, '..'), { recursive: true });
      writeFileSync(join(dist, path), text);
    }

    return dist;
  };

  after(() => {
    for (const dist of trees) {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  /** What day X's build names: its two origins, as origins and hosts, and the names kept. */
  const DAY_X_TEXT = [
    '<link rel="canonical" href="https://webhook.qa-tools.ru/" />',
    'https://hook.qa-tools.ru/s/G4t',
    'wss://webhook.qa-tools.ru/ws/G4t',
    'Host: hook.qa-tools.ru',
    'on `webhook.qa-tools.ru` alone.',
    '"servers": [{ "url": "https://webhook.qa-tools.ru" }]',
    'mailto:contact@qa-tools.ru https://status.qa-tools.ru/ tag:qa-tools.ru,2026:changelog/1.0.0',
  ].join('\n');

  it('passes a tree naming day X’s origins, which end in production’s', () => {
    const dist = tree({
      'index.html': DAY_X_TEXT,
      'llms.txt': DAY_X_TEXT,
      'docs/openapi.json': DAY_X_TEXT,
      'logo-512.png': 'https://qa-tools.ru/',
    });

    assert.deepEqual(productionNameProblems(dist, DAY_X), []);
    assert.deepEqual(productionNamesLeft(DAY_X_TEXT, DAY_X), []);
  });

  it('reports each text file still naming production outside its own hosts', () => {
    const dist = tree({
      'index.html': `${DAY_X_TEXT}\n<link rel="canonical" href="https://qa-tools.ru/" />`,
      'llms.txt': `${DAY_X_TEXT}\nthe proxy of qa-tools.ru.`,
      'robots.txt': DAY_X_TEXT,
      'ru/index.html': 'https://sub.hook.qa-tools.ru/ https://www.qa-tools.ru/',
      'sitemap.xml': '<loc>https://QA-Tools.ru/docs</loc>',
      'assets/app.js': 'webhook.qa-tools.ru-x hook.qa-tools.ru.example',
    });

    assert.deepEqual(productionNameProblems(dist, DAY_X).sort(), [
      'assets/app.js names qa-tools.ru, though the build is for https://webhook.qa-tools.ru',
      'index.html names qa-tools.ru, though the build is for https://webhook.qa-tools.ru',
      'llms.txt names qa-tools.ru, though the build is for https://webhook.qa-tools.ru',
      'ru/index.html names qa-tools.ru, though the build is for https://webhook.qa-tools.ru',
      'sitemap.xml names qa-tools.ru, though the build is for https://webhook.qa-tools.ru',
    ]);
    assert.deepEqual(productionNamesLeft('https://qa-tools.ru/ https://hook.qa-tools.ru/', DAY_X), [
      'qa-tools.ru',
    ]);
  });

  it('passes the site’s own host and reports the receive host’s when only that one moves', () => {
    const moved = { app: PRODUCTION_ORIGINS.app, receive: 'https://hook.inspector.example' };

    assert.deepEqual(
      productionNamesLeft('https://qa-tools.ru/ wss://qa-tools.ru/ws/1 qa-tools.ru', moved),
      [],
    );
    assert.deepEqual(productionNamesLeft('https://hook.qa-tools.ru/s/1', moved), ['qa-tools.ru']);
    assert.deepEqual(
      productionNamesLeft('https://qa-tools.ru:8443/', {
        ...moved,
        app: 'https://qa-tools.ru:8443',
      }),
      [],
    );
    assert.deepEqual(
      productionNamesLeft('https://qa-tools.ru/', { ...moved, app: 'https://qa-tools.ru:8443' }),
      ['qa-tools.ru'],
    );
    // A second port after the site's own is no name of the site's (#339).
    assert.deepEqual(productionNamesLeft('https://qa-tools.ru:8443:8443/about', PORTED), [
      'qa-tools.ru',
    ]);
    assert.deepEqual(productionNamesLeft('https://webhook.qa-tools.ru:8443/', DAY_X), [
      'qa-tools.ru',
    ]);
  });

  it('reports each text file naming a configured host with a second port after its own (#339)', () => {
    const named = [
      '<link rel="canonical" href="https://qa-tools.ru:8443/about" />',
      'wss://qa-tools.ru:8443/ws/G4t https://hook.qa-tools.ru/s/G4t',
      'on `qa-tools.ru:8443`: alone.',
      'contact@qa-tools.ru tag:qa-tools.ru,2026:changelog/1.0.0',
    ].join('\n');
    const dist = tree({
      'index.html': named,
      'about/index.html': `${named}\nhttps://qa-tools.ru:8443:8443/mcp`,
      'ru/about/index.html': 'qa-tools.ru:8443:1',
      'changelog/index.html': 'HTTPS://QA-TOOLS.RU:8443:8443/changelog',
      'assets/app.js': 'status.qa-tools.ru:8443:8443 xqa-tools.ru:8443:1',
      'logo-512.png': 'https://qa-tools.ru:8443:8443/',
    });

    assert.deepEqual(doubledPorts(named, PORTED), []);
    assert.deepEqual(doubledPortProblems(dist, PORTED).sort(), [
      'about/index.html names qa-tools.ru:8443 with a second port after it',
      'changelog/index.html names qa-tools.ru:8443 with a second port after it',
      'ru/about/index.html names qa-tools.ru:8443 with a second port after it',
    ]);
    // The same files name production's host outside the site's own.
    assert.deepEqual(productionNameProblems(dist, PORTED).sort(), [
      'about/index.html names qa-tools.ru, though the build is for https://qa-tools.ru:8443',
      'assets/app.js names qa-tools.ru, though the build is for https://qa-tools.ru:8443',
      'changelog/index.html names qa-tools.ru, though the build is for https://qa-tools.ru:8443',
      'ru/about/index.html names qa-tools.ru, though the build is for https://qa-tools.ru:8443',
    ]);
    // Any configured host with a port, and only such a one.
    assert.deepEqual(doubledPorts('http://localhost:5173:5173/ http://127.0.0.1:3001/s/1', LOCAL), [
      'localhost:5173',
    ]);
    assert.deepEqual(
      doubledPorts('https://hook.qa-tools.ru:8444:1 webhook.qa-tools.ru:8445:2', PORTED_ALL),
      ['hook.qa-tools.ru:8444', 'webhook.qa-tools.ru:8445'],
    );
    assert.deepEqual(
      doubledPorts('http://[::1]:5173:5173/', { app: 'http://[::1]:5173', receive: OTHER.receive }),
      ['[::1]:5173'],
    );
    assert.deepEqual(doubledPorts('https://qa-tools.ru:443:443/', PRODUCTION_ORIGINS), []);
    assert.deepEqual(doubledPortProblems(dist, PRODUCTION_ORIGINS), []);
    assert.deepEqual(doubledPortProblems(dist, OTHER), []);
  });

  it('passes a copy’s second host and reports production’s second where the copy has another or none (D275)', () => {
    const text =
      'https://next.inspector.example/ https://inspector.example/ https://hook.inspector.example/s/1';

    assert.deepEqual(productionNamesLeft(text, OTHER_ALIAS), []);
    assert.deepEqual(productionNamesLeft('https://webhook.qa-tools.ru/', OTHER_ALIAS), [
      'qa-tools.ru',
    ]);
    assert.deepEqual(productionNamesLeft('https://webhook.qa-tools.ru/', OTHER), ['qa-tools.ru']);
    // Production's second host in a copy that names it as its own second.
    assert.deepEqual(
      productionNamesLeft('https://webhook.qa-tools.ru/ webhook.qa-tools.ru', {
        ...OTHER,
        alias: PRODUCTION_ORIGINS.alias,
      }),
      [],
    );
  });

  it('is what the build check runs for a build for another address, and not for production', () => {
    const dist = tree({ 'notes.txt': 'https://qa-tools.ru/' });
    const named = (problems: string[]) =>
      problems.filter((problem) => problem.startsWith('notes.txt '));

    assert.deepEqual(named(checkBuild(dist, new Date(), [], DAY_X)), [
      'notes.txt names qa-tools.ru, though the build is for https://webhook.qa-tools.ru',
    ]);
    assert.deepEqual(named(checkBuild(dist, new Date(), [], OTHER)), [
      'notes.txt names qa-tools.ru, though the build is for https://inspector.example',
    ]);
    assert.deepEqual(named(checkBuild(dist, new Date(), [], PRODUCTION_ORIGINS)), []);
    // Production's two with no second are another site's: checked.
    assert.deepEqual(
      named(checkBuild(dist, new Date(), [], { ...PRODUCTION_ORIGINS, alias: null })),
      [],
    );
    assert.deepEqual(
      named(
        checkBuild(tree({ 'notes.txt': 'https://webhook.qa-tools.ru/' }), new Date(), [], {
          ...PRODUCTION_ORIGINS,
          alias: null,
        }),
      ),
      ['notes.txt names qa-tools.ru, though the build is for https://qa-tools.ru'],
    );
    // A second port, for any origins with a port of their own (#339).
    assert.deepEqual(
      named(
        checkBuild(tree({ 'notes.txt': 'https://qa-tools.ru:8443:8443/' }), new Date(), [], PORTED),
      ),
      [
        'notes.txt names qa-tools.ru, though the build is for https://qa-tools.ru:8443',
        'notes.txt names qa-tools.ru:8443 with a second port after it',
      ],
    );
    assert.deepEqual(
      named(
        checkBuild(tree({ 'notes.txt': 'http://localhost:5173:5173/' }), new Date(), [], LOCAL),
      ),
      ['notes.txt names localhost:5173 with a second port after it'],
    );
    assert.deepEqual(
      named(checkBuild(tree({ 'notes.txt': 'https://qa-tools.ru:8443/' }), new Date(), [], PORTED)),
      [],
    );
  });

  it('scans hostile text at growing sizes in time linear in its length', () => {
    // The largest text, at the last size: 3.9 MB, two hosts 100 000 times.
    for (const size of [1000, 10_000, 100_000]) {
      const started = process.hrtime.bigint();

      for (const clean of [
        'https://webhook.qa-tools.ru/ '.repeat(size),
        'hook.qa-tools.ru '.repeat(size),
        'contact@qa-tools.ru'.repeat(size),
        'tag:qa-tools.ru,'.repeat(size),
        `${'https://'.repeat(size)}webhook.qa-tools.ru`,
        'w'.repeat(size),
      ]) {
        assert.deepEqual(productionNamesLeft(clean, DAY_X), []);
      }
      for (const [text, left] of [
        ['https://qa-tools.ru/ '.repeat(size), size],
        ['qa-tools.ru'.repeat(size), size],
        ['webhook.qa-tools.ruwebhook.qa-tools.ru '.repeat(size), 2 * size],
        [`${'webhook.'.repeat(size)}qa-tools.ru`, 1],
        [`${'.'.repeat(size)}hook.qa-tools.ru`, 1],
        [`${'-'.repeat(size)}webhook.qa-tools.ru`, 1],
        [`webhook.qa-tools.ru${'-'.repeat(size)}`, 1],
        [`hook.qa-tools.ru${'.x'.repeat(size)}`, 1],
      ] as const) {
        assert.equal(productionNamesLeft(text, DAY_X).length, left);
      }
      // A second port after a configured host's own (#339).
      for (const [text, found] of [
        ['https://qa-tools.ru:8443/ '.repeat(size), []],
        ['qa-tools.ru:8443'.repeat(size), []],
        ['qa-tools.ru:8443:'.repeat(size), []],
        [`${'.'.repeat(size)}qa-tools.ru:8443:8443`, []],
        [`qa-tools.ru:8443${':8443'.repeat(size)}`, ['qa-tools.ru:8443']],
        [`qa-tools.ru:8443:${'8'.repeat(size)}`, ['qa-tools.ru:8443']],
        [`${'qa-tools.ru:8443 '.repeat(size)}qa-tools.ru:8443:1`, ['qa-tools.ru:8443']],
      ] as const) {
        assert.deepEqual(doubledPorts(text, PORTED), found);
      }
      assert.equal(
        productionNamesLeft('https://qa-tools.ru:8443:8443/ '.repeat(size), PORTED).length,
        size,
      );
      withinBound(started, size);
    }
  });
});

/**
 * The frontend built as `npm run build` builds it, for `origins` and into
 * `dist`, a directory of its own: each step of the build script, the Vite
 * builds given that directory, the scripts given it as their argument, the
 * build check last among them. The type check is the suite's own job.
 */
const buildInto = (dist: string, origins: SiteOrigins) => {
  const script = (JSON.parse(read('../../package.json')) as { scripts: { build: string } }).scripts
    .build;
  const env = {
    ...process.env,
    APP_ORIGIN: origins.app,
    RECEIVE_ORIGIN: origins.receive,
    APP_ALIAS_ORIGIN: origins.alias ?? '',
    PATH: [
      join(FRONTEND, 'node_modules/.bin'),
      join(ROOT, 'node_modules/.bin'),
      process.env.PATH,
    ].join(delimiter),
  };

  for (const step of script.split(' && ')) {
    const [command, ...rest] = step.split(' ');
    let args: string[];

    if (command === 'tsc') {
      continue;
    } else if (command === 'vite') {
      args = [...rest, '--outDir', dist, '--logLevel', 'warn'];
    } else {
      assert.equal(command, 'node', step);
      args = [...rest, dist];
    }

    const run = spawnSync(command, args, { cwd: FRONTEND, env, encoding: 'utf8' });

    assert.equal(run.status, 0, `${step}\n${run.stdout}\n${run.stderr}`);
  }
};

/** Every file under `dist` but images and fonts, by its path in it. */
const builtTextFiles = (dist: string) => {
  const files = (prefix: string): string[] =>
    readdirSync(join(dist, prefix), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(prefix, entry.name)) : [join(prefix, entry.name)],
    );

  return files('').filter((path) => !/\.(?:png|ico|woff2?)$/.test(path));
};

const canonical = (html: string) => /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];

describe('a build for another address (issue #320, criterion 2)', () => {
  let dist = '';

  // Five Vite builds and five scripts: 5.9 s alone and 5.7 s inside the whole
  // frontend suite on an 8-core machine on 2026-11-01. The limit is its own,
  // not the suite's per-test one, with room for a runner many times slower.
  before(
    () => {
      dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-other-origin-'));
      buildInto(dist, OTHER);
    },
    { timeout: 180_000 },
  );

  after(() => {
    if (dist !== '') {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  const built = (path: string) => readFileSync(join(dist, path), 'utf8');

  it('names qa-tools.ru nowhere but in the names kept', () => {
    const text = builtTextFiles(dist);

    assert.ok(text.length > 20);
    for (const path of text) {
      assert.equal(leftOver(built(path)), null, path);
    }
    assert.deepEqual(productionNameProblems(dist, OTHER), []);
    // The check the build runs would have said so.
    assert.ok(built('changelog.xml').includes('tag:qa-tools.ru,2026:changelog/'));
  });

  it('names the address in every canonical link, og:url, and the files for search engines', () => {
    for (const [page, address] of [
      ['index.html', `${OTHER.app}/`] as const,
      ['ru/index.html', `${OTHER.app}/ru/`],
      ['about/index.html', `${OTHER.app}/about`],
      ['ru/about/index.html', `${OTHER.app}/ru/about`],
      ['terms/index.html', `${OTHER.app}/terms`],
      ['privacy/index.html', `${OTHER.app}/privacy`],
      ['changelog/index.html', `${OTHER.app}/changelog`],
    ]) {
      assert.equal(canonical(built(page)), address, page);
    }
    assert.ok(built('index.html').includes(`<meta property="og:url" content="${OTHER.app}/" />`));
    assert.ok(
      built('ru/index.html').includes(`<meta property="og:url" content="${OTHER.app}/ru/" />`),
    );
    assert.ok(built('index.html').includes(`content="${OTHER.app}/logo-512.png"`));

    const locations = [...built('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map(
      ([, location]) => location ?? '',
    );

    assert.equal(locations.length, 8);
    assert.ok(locations.every((location) => location.startsWith(`${OTHER.app}/`)));
    assert.ok(built('robots.txt').split('\n').includes(`Sitemap: ${OTHER.app}/sitemap.xml`));
    assert.ok(
      built('.well-known/security.txt')
        .split('\n')
        .includes(`Canonical: ${OTHER.app}/.well-known/security.txt`),
    );
  });

  it('keeps production’s title, description and How it’s built on both about pages, built with production’s operator settings (issue #380)', () => {
    for (const [path, template, line] of [
      [
        'about/index.html',
        '../../about/index.html',
        'I decide what to build and approve every design, drawn\u00a0in\u00a0Figma\u00a0first.',
      ],
      [
        'ru/about/index.html',
        '../../ru/about/index.html',
        'Я\u00a0решаю, что делать, и\u00a0утверждаю каждый экран\u00a0— сначала его рисуют\u00a0в\u00a0Figma.',
      ],
    ] as const) {
      const head = (html: string) =>
        (/<head>[\s\S]*?<\/head>/.exec(html)?.[0] ?? '')
          .replace(/<link[^>]*>\n/g, '')
          .replace(/<script[^>]*><\/script>\n/g, '');
      const fact = /<div class="fact"><dt>[^<]*<\/dt><dd>(.*?)<\/dd><\/div>/.exec(built(path))?.[1];

      // Its title and its meta description as the template writes them,
      // whatever links the build adds or names under the address.
      assert.equal(head(built(path)), head(read(template)), path);
      assert.match(built(path), /<title>(?:About QA Tools|О QA Tools)<\/title>/, path);
      assert.equal(fact?.split('<p>').length, 4, path);
      assert.ok(fact?.includes(`<p>${line}</p>`), path);
    }
  });

  it('names it in the agent documentation, the feeds, the relay script and the API description', () => {
    assert.ok(built('llms.txt').includes(`(${OTHER.app}/openapi.json)`));
    assert.ok(built('llms-full.txt').includes(`${OTHER.receive}/s/`));
    for (const feed of ['changelog.xml', 'changelog-breaking.xml']) {
      assert.ok(
        built(feed).includes(
          `<link rel="self" type="application/atom+xml" href="${OTHER.app}/${feed}"/>`,
        ),
        feed,
      );
    }
    assert.ok(built('changelog.md').includes(`${OTHER.app}/changelog`));

    // The relay script reads the copy's site, which has no second origin,
    // and is the same file under both names, the one the description gives
    // (D275, D279).
    const relay = built('webhook-inspector-relay.mjs');

    assert.equal(built('qa-tools-relay.mjs'), relay);
    assert.ok(relay.includes(`export const DEFAULT_API = '${OTHER.app}';`));
    assert.ok(relay.includes(`(default ${OTHER.app})`));
    assert.ok(relay.includes(`${OTHER.receive}/s/<session id>`));
    assert.ok(relay.includes('Usage: node webhook-inspector-relay.mjs '));
    assert.ok(built('llms-full.txt').includes(`curl -fO ${OTHER.app}/webhook-inspector-relay.mjs`));
    assert.ok(built('changelog.md').includes(`${OTHER.app}/webhook-inspector-relay.mjs`));

    const description = JSON.parse(built('openapi.json')) as {
      servers: { url: string }[];
      paths: Record<string, { servers?: { url: string }[] }>;
      info: { description: string };
    };
    const receiveServers = Object.values(description.paths).flatMap(
      (item) => item.servers?.map((server) => server.url) ?? [],
    );

    assert.deepEqual(description.servers, [{ url: OTHER.app }]);
    assert.ok(receiveServers.length > 0);
    assert.ok(receiveServers.every((url) => url === OTHER.receive));
    assert.ok(
      built('openapi.json').includes(
        `"receiveUrl": "${OTHER.receive}/s/G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA"`,
      ),
    );
    assert.ok(description.info.description.includes(sha256Hex(relay)));
  });

  it('publishes no notice of production’s move in the changelog page, its text or either feed (#343)', () => {
    for (const [path, text] of [
      ['changelog.md', built('changelog.md')],
      ['changelog/index.html', pageText(built('changelog/index.html'))],
      ['changelog.xml', built('changelog.xml')],
      ['changelog-breaking.xml', built('changelog-breaking.xml')],
    ] as const) {
      assert.ok(text.includes(OTHER.app), path);
      assert.ok(!MOVE_DAY_SENTENCE.test(text), path);
      assert.deepEqual(sameOriginMoves(text), [], path);
    }

    const ids = (feed: string) => readFeedEntries(built(feed)).map((entry) => entry.id);

    // 1.16.0 stays, unmarked: the breaking feed leaves it out, 1.19.0's notice in.
    assert.ok(ids('changelog.xml').includes(feedEntryId('1.16.0')));
    assert.ok(!ids('changelog-breaking.xml').includes(feedEntryId('1.16.0')));
    assert.ok(ids('changelog-breaking.xml').includes(feedEntryId('1.19.0')));
    assert.ok(built('changelog/index.html').includes('<details class="version" id="v1.16.0">'));
  });

  it('serves the API description’s Network section without the bullet on production’s move, every other bullet as written (#386, criterion 2)', () => {
    const description = (JSON.parse(built('openapi.json')) as { info: { description: string } })
      .info.description;

    // /docs shows openapi.json as it is served; llms-full.txt carries it.
    for (const [path, text] of [
      ['openapi.json', description],
      ['llms-full.txt', built('llms-full.txt')],
    ] as const) {
      const start = text.indexOf('\n\n## Network\n\n');
      const section = text.slice(start, text.indexOf('\n\n## Security\n\n', start));
      const titles = section
        .split('\n')
        .filter((line) => line.startsWith('- **'))
        .map((line) => /^- \*\*([^*]*)\*\*/.exec(line)?.[1]);

      assert.ok(start > 0, path);
      assert.ok(section.includes('For a CI runner or a network that may reach only'), path);
      assert.deepEqual(
        titles,
        [
          'One address: `80.87.198.166`.',
          'HTTPS on TCP port 443.',
          'IPv4 only.',
          'No CDN or proxy service in front.',
          'Outgoing connections only.',
          'A change of address is announced at least 14 days ahead',
        ],
        path,
      );
      assert.doesNotMatch(section, /Moving to|1\.16\.0/, path);
      assert.ok(section.includes(`${OTHER.app}/changelog`), path);
      // The sentence pointing at it stays with it.
      assert.ok(text.includes('has a notice of its own, under Network above.'), path);
    }
    // The build check passed it: the operator's texts, which this build
    // shows, name the server's address.
    assert.ok(built('openapi.json').includes('80.87.198.166'));
  });

  it('serves the API description with no bullet on the relay script’s old name, and the address bullet naming its one host once (#431)', () => {
    const description = (text: string) =>
      (JSON.parse(text) as { info: { description: string } }).info.description;
    // What the build wrote before #386 and #431: the source named, with the
    // built relay script's SHA-256.
    const before = description(
      nameSite(read('../../../../packages/shared/openapi.json'), OTHER).replaceAll(
        sha256Hex(productionRelayScriptText()),
        sha256Hex(relayScriptText(OTHER)),
      ),
    );
    // The bullets of the section headed `heading`, up to the next `##` heading.
    const bullets = (text: string, heading: string) => {
      const start = text.indexOf(`\n\n${heading}\n\n`);

      assert.ok(start > 0, heading);

      return text
        .slice(start, text.indexOf('\n\n## ', start + 2))
        .split('\n')
        .filter((line) => line.startsWith('- **'));
    };
    const address = bullets(before, '## Network').find((line) =>
      line.startsWith(ADDRESS_BULLET),
    ) as string;
    const oneHost =
      '- **One address: `80.87.198.166`.** `inspector.example` — the site, the API, the WebSocket and the MCP server — and `hook.inspector.example`, which receives webhooks, all answer on it.';

    assert.ok(address.includes('`inspector.example` and `inspector.example` — each the site'));
    assert.equal(
      bullets(before, RELAY_HEADING).filter((line) => line.startsWith(OLD_NAME_BULLET)).length,
      1,
    );
    // /docs shows openapi.json as it is served; llms-full.txt carries it.
    for (const [path, text] of [
      ['openapi.json', description(built('openapi.json'))],
      ['llms-full.txt', built('llms-full.txt')],
    ] as const) {
      const network = bullets(text, '## Network');
      const line = network.find((each) => each.startsWith(ADDRESS_BULLET));

      assert.ok(!text.includes(OLD_NAME_BULLET), path);
      assert.deepEqual(
        bullets(text, RELAY_HEADING),
        bullets(before, RELAY_HEADING).filter((each) => !each.startsWith(OLD_NAME_BULLET)),
        path,
      );
      assert.equal(line, oneHost, path);
      assert.equal(line?.split('`inspector.example`').length, 2, path);
      assert.deepEqual(
        network,
        bullets(before, '## Network')
          .filter((each) => !each.startsWith(MOVE_BULLET))
          .map((each) => (each === address ? oneHost : each)),
        path,
      );
    }
  });
});

/**
 * The frontend built for a copy on production's host with a port of its own
 * (issue #339): its pages compose the site's address from `APP_ORIGIN`, and
 * `CHANGELOG.md` is named once on its way into the changelog page and again
 * with the page, so a rename that named the configured origin again would
 * write the port twice. The build check, its last step, would refuse that.
 */
describe('a build for a production host with a port of its own (issue #339)', () => {
  let dist = '';

  // As long as the build above, from a directory of its own.
  before(
    () => {
      dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-ported-origin-'));
      buildInto(dist, PORTED);
    },
    { timeout: 180_000 },
  );

  after(() => {
    if (dist !== '') {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  const built = (path: string) => readFileSync(join(dist, path), 'utf8');

  it('names the port once in every file, and qa-tools.ru nowhere but in its own hosts and the names kept', () => {
    const text = builtTextFiles(dist);

    assert.ok(text.length > 20);
    for (const path of text) {
      assert.ok(!/:8443:\d/.test(built(path)), path);
      assert.deepEqual(productionNamesLeft(built(path), PORTED), [], path);
    }
    assert.deepEqual(doubledPortProblems(dist, PORTED), []);
    assert.deepEqual(productionNameProblems(dist, PORTED), []);
  });

  it('names the site with its port on the about pages and the changelog, where production’s name its own', () => {
    for (const [page, path] of [
      ['about/index.html', '/about'],
      ['ru/about/index.html', '/ru/about'],
      ['changelog/index.html', '/changelog'],
    ] as const) {
      const html = built(page);

      assert.equal(canonical(html), `${PORTED.app}${path}`, page);
      // Every address of the site's carries its port, exactly once.
      assert.equal(/https:\/\/qa-tools\.ru(?!:8443[^:\d])/.exec(html), null, page);
      assert.ok(html.split(`${PORTED.app}/`).length > 2, page);
    }
    assert.ok(built('about/index.html').includes(`${PORTED.app}/mcp`));
    assert.ok(built('ru/about/index.html').includes(`${PORTED.app}/mcp`));
    assert.ok(built('changelog/index.html').includes(`${PORTED.app}/webhook-inspector-relay.mjs`));
    assert.ok(built('changelog.md').includes(`${PORTED.app}/changelog`));
  });
});
