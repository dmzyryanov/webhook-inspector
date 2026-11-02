import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { after, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
// @ts-expect-error -- a plain ES module with no declarations; people run it with node.
import * as relayModule from '../../public/webhook-inspector-relay.mjs';
// @ts-expect-error -- a plain ES module with no declarations; the build runs it.
import * as buildCheck from '../../scripts/check-build.mjs';
import { productionRelayScriptText, siteFiles } from '../../scripts/build-site-files.mjs';
import {
  documentedRelayHashes,
  OLD_RELAY_SCRIPT_NAME,
  RELAY_SCRIPT_API,
  RELAY_SCRIPT_FILE,
  RELAY_SCRIPT_NAME,
  relaySection,
  sha256Hex,
} from '../../scripts/relay-script.mjs';
import { EXCLUDED_HEADER_NAMES, isExcludedHeader } from './curl-command.ts';
import { receivedBodyBytes } from './received-body.ts';

/**
 * The relay script, `public/webhook-inspector-relay.mjs` (issue #77, D202):
 * the file the site serves for forwarding a session's webhooks to a local
 * service, named so since #319 (D275) and reading `https://webhook.qa-tools.ru`
 * by default, the one `/docs` offers; and, since #334 (D279), the same file
 * under its old name, `qa-tools-relay.mjs`, reading the key from
 * `WEBHOOK_INSPECTOR_ACCESS_KEY`, else from `QA_TOOLS_ACCESS_KEY`.
 *
 * - Its pure parts, imported: arguments, the path sent to, headers, body,
 *   `Retry-After`, console text, and one exchange with a target - each also
 *   with made-up input built to break it, at growing sizes.
 * - That it leaves out exactly the headers `Copy as cURL` leaves out, plus
 *   the eleven forwarding names and an `Accept-Encoding: gzip`, which the
 *   command keeps since #114 and the relay still drops (D167, D202).
 * - That `/docs` gives the served file's SHA-256, how nginx serves it, and
 *   what the build checks.
 * - The script as a child process against a stub API that fails, limits or
 *   cannot be reached, and with invalid arguments.
 *
 * `apps/backend/src/relay-script.test.ts` runs it against a real backend.
 */

type Pair = [string, string];

interface Detail {
  method: string;
  path: string | null;
  queryString: string;
  headers: Pair[];
  body: string | null;
  bodyBase64: string | null;
  isBinary: boolean;
  bodySize: number;
}

interface Parsed {
  sessionId?: string;
  target?: URL;
  fromStart?: boolean;
  api?: URL;
  help?: true;
  error?: string;
}

const relay = relayModule as {
  USAGE: string;
  DEFAULT_API: string;
  RETRY_AFTER_MAX_SECONDS: number;
  DROPPED_HEADER_NAMES: Set<string>;
  isDroppedHeader(pair: Pair): boolean;
  printable(text: string, max?: number): string;
  sessionIdFrom(text: string): string | null;
  baseUrlFrom(text: string): URL | string;
  parseArguments(argv: string[]): Parsed;
  ACCESS_KEY_VARIABLE: string;
  OLD_ACCESS_KEY_VARIABLE: string;
  accessKeyVariable(env: Record<string, string | undefined>): string;
  accessKeyFrom(
    value: string | undefined,
    variable?: string,
  ): { accessKey?: string | null; error?: string };
  targetPath(
    target: URL,
    sessionId: string,
    storedPath: string | null,
    queryString: string,
  ): string;
  bodyBytes(
    detail: Pick<Detail, 'method' | 'body' | 'bodyBase64' | 'isBinary' | 'bodySize'>,
  ): Buffer;
  forwardedHeaders(target: URL, method: string, captured: Pair[], body: Buffer): string[];
  retryAfterSeconds(value: string | null): number | null;
  describeError(error: unknown): string;
  sendToTarget(options: {
    target: URL;
    method: string;
    path: string;
    headers: string[];
    body: Buffer;
    timeoutMs?: number;
  }): Promise<{ status?: number; error?: string }>;
};

const { relayScriptProblems } = buildCheck as {
  relayScriptProblems: (dist: string, description: string) => string[];
};

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const description = (
  JSON.parse(read('../../../../packages/shared/openapi.json')) as { info: { description: string } }
).info.description;

/** The source, `public/webhook-inspector-relay.mjs`, written for production. */
const sourceBytes = readFileSync(RELAY_SCRIPT_FILE);
/**
 * The script `/docs` offers, as production's build writes it under both its
 * names (D275, D279): its source, byte for byte.
 */
const scriptBytes = Buffer.from(productionRelayScriptText());
const scriptHash = sha256Hex(scriptBytes);

const ID = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh3';
const OLD_ID = 'a_b-C_d-E_f-G_h-I_j-K_l-M_n-O_p-Q_r-S_t-U_v';
/** Ids of the shape made before D161 that look like options. */
const DASH_ID = `-${OLD_ID.slice(1)}`;
const DOUBLE_DASH_ID = `--${OLD_ID.slice(2)}`;

/** Made-up input grows to these sizes, in characters. */
const SIZES = [1024, 64 * 1024, 1024 * 1024];

/** How long one hostile input may take; a linear pass over 1 MiB takes milliseconds. */
const HOSTILE_MS = 1_000;

function timed<T>(what: string, run: () => T): T {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;

  assert.ok(elapsed < HOSTILE_MS, `${what} took ${Math.round(elapsed)} ms`);

  return result;
}

/**
 * The eleven names the in-cluster proxy managed until 0.36.0 (D144). `Copy as
 * cURL` writes them since #114; the relay keeps leaving them out (D202).
 */
const PROXY_HEADER_NAMES = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-forwarded-server',
  'x-forwarded-uri',
  'x-forwarded-method',
  'x-forwarded-prefix',
  'x-forwarded-tls-client-cert',
  'x-forwarded-tls-client-cert-info',
  'x-real-ip',
];

describe('the headers the relay leaves out', () => {
  it('are exactly the names Copy as cURL leaves out, plus the eleven proxy names it keeps', () => {
    assert.deepEqual(
      [...relay.DROPPED_HEADER_NAMES].sort(),
      [...EXCLUDED_HEADER_NAMES, ...PROXY_HEADER_NAMES].sort(),
    );
    assert.equal(relay.DROPPED_HEADER_NAMES.size, 21);

    for (const name of PROXY_HEADER_NAMES) {
      assert.ok(!EXCLUDED_HEADER_NAMES.has(name), `Copy as cURL leaves out ${name}`);
    }
  });

  it("are Copy as cURL's verdict, or a proxy name, or an Accept-Encoding of exactly gzip", () => {
    const names = [
      ...EXCLUDED_HEADER_NAMES,
      ...relay.DROPPED_HEADER_NAMES,
      'accept-encoding',
      'forwarded',
      'x-forwarded',
      'x-forwarded-by',
      'x_forwarded_for',
      'content-type',
      'authorization',
      'x-trace-id',
    ];
    const values = ['gzip', 'GZIP', 'gzip, br', ' gzip', 'gzip ', 'br', '', 'x'];

    for (const lower of names) {
      const spellings = [
        lower,
        lower.toUpperCase(),
        lower.replace(
          /(^|-)([a-z])/g,
          (_, dash: string, letter: string) => dash + letter.toUpperCase(),
        ),
      ];

      for (const name of spellings) {
        for (const value of values) {
          assert.equal(
            relay.isDroppedHeader([name, value]),
            isExcludedHeader([name, value]) ||
              PROXY_HEADER_NAMES.includes(lower) ||
              (lower === 'accept-encoding' && value === 'gzip'),
            `${name}: ${value}`,
          );
        }
      }
    }
  });

  it('drop an Accept-Encoding of exactly gzip, in any case of the name, and keep every other value', () => {
    for (const name of ['Accept-Encoding', 'accept-encoding', 'ACCEPT-ENCODING']) {
      assert.equal(relay.isDroppedHeader([name, 'gzip']), true, name);
      assert.equal(isExcludedHeader([name, 'gzip']), false, name);

      for (const value of [
        'GZIP',
        'gzip, br',
        ' gzip',
        'gzip ',
        'gzip;q=1.0',
        'br',
        'identity',
        '',
      ]) {
        assert.equal(relay.isDroppedHeader([name, value]), false, `${name}: ${value}`);
      }
    }
  });
});

describe('/docs and the served file', () => {
  const section = relaySection(description) ?? '';

  it('gives the SHA-256 of the file the site serves, and no other', () => {
    assert.notEqual(section, '', 'info.description has no "## Forward to a local service"');
    assert.deepEqual(documentedRelayHashes(description), [scriptHash]);
    assert.ok(
      section.includes(`echo '${scriptHash}  ${RELAY_SCRIPT_NAME}' | shasum -a 256 -c`),
      'the check command does not carry the hash',
    );
  });

  it('gives the download and run commands, the Node version, and says to read it rather than pipe it', () => {
    assert.ok(section.includes(`curl -fO https://webhook.qa-tools.ru/${RELAY_SCRIPT_NAME}`));
    assert.ok(section.includes(`node ${RELAY_SCRIPT_NAME} "$SESSION" http://localhost:3000`));
    assert.match(section, /Node\.js 22 or later/);
    assert.match(section, /never pipe it into `node`/i);
    assert.doesNotMatch(section, /\|\s*node\b/);
  });

  it('says what the sender receives, that the id lands in shell history, and that it keeps no session alive', () => {
    assert.match(section, /sender receives the session's configured response/);
    assert.match(section, /not your service's/);
    assert.match(section, /shell history/);
    assert.match(section, /do not keep the session alive/);
  });

  it('is named, with its SHA-256, in the changelog', () => {
    const changelog = read('../../../../CHANGELOG.md');

    assert.ok(changelog.includes(scriptHash), 'no changelog entry names the current SHA-256');
    assert.ok(changelog.includes(RELAY_SCRIPT_NAME));
  });

  it('says the old name serves the same file until the date the changelog gives, and names no date itself (D275, D279)', () => {
    assert.ok(section.includes(`\`${OLD_RELAY_SCRIPT_NAME}\``));
    assert.match(section, /until the date the changelog's 1\.19\.0 entry gives/);
    assert.match(section, /on `https:\/\/qa-tools\.ru` until the date its 1\.16\.0 entry gives/);
    assert.match(
      section,
      /the same file, with the same SHA-256, as `webhook-inspector-relay\.mjs`/,
    );
    assert.match(section, /reading `https:\/\/webhook\.qa-tools\.ru` by default/);
    assert.doesNotMatch(section, /\b20\d\d-\d\d-\d\d\b/);
  });

  it('is a dependency-free ES module that imports only Node built-ins, under either name', () => {
    for (const bytes of [scriptBytes, sourceBytes]) {
      const text = bytes.toString('utf8');
      const imports = [...text.matchAll(/^import\s(?:[^;']*?\sfrom\s)?'([^']+)';/gm)].map(
        (match) => match[1],
      );

      assert.ok(imports.length > 0);
      assert.deepEqual(
        imports.filter((name) => !name?.startsWith('node:')),
        [],
      );
      assert.doesNotMatch(text, /\brequire\(|\bimport\(/);
      assert.ok(text.startsWith('#!/usr/bin/env node\n'));
      assert.ok(!text.includes('\r'), 'the file has a carriage return, which changes its hash');
    }
  });
});

describe('one script under both names, webhook-inspector-relay.mjs and qa-tools-relay.mjs (#334, D279)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'webhook-inspector-relay-names-'));
  const oldFile = join(directory, OLD_RELAY_SCRIPT_NAME);

  writeFileSync(oldFile, siteFiles()[OLD_RELAY_SCRIPT_NAME] ?? '');
  after(() => rmSync(directory, { recursive: true, force: true }));

  it('is written by production’s build as its source, byte for byte, under either name, with the SHA-256 /docs gives', () => {
    const files = siteFiles();

    assert.equal(RELAY_SCRIPT_NAME, 'webhook-inspector-relay.mjs');
    assert.equal(OLD_RELAY_SCRIPT_NAME, 'qa-tools-relay.mjs');
    assert.ok(scriptBytes.equals(sourceBytes));

    for (const name of [RELAY_SCRIPT_NAME, OLD_RELAY_SCRIPT_NAME]) {
      const bytes = Buffer.from(files[name] ?? '');

      assert.ok(bytes.equals(sourceBytes), name);
      assert.equal(sha256Hex(bytes), scriptHash, name);
    }
  });

  it('names itself, its variable and the second origin, and no old name but the variable it still reads', () => {
    const text = sourceBytes.toString('utf8');

    assert.equal(RELAY_SCRIPT_API, 'https://webhook.qa-tools.ru');
    assert.equal(relay.DEFAULT_API, RELAY_SCRIPT_API);
    assert.ok(relay.USAGE.startsWith('Usage: node webhook-inspector-relay.mjs <session id'));
    assert.ok(relay.USAGE.includes('(default https://webhook.qa-tools.ru)'));
    assert.ok(text.includes("const USER_AGENT = 'webhook-inspector-relay';"));
    assert.ok(text.includes('`webhook-inspector-relay: ${error}'));
    assert.ok(text.includes('`webhook-inspector-relay stopped: '));
    assert.doesNotMatch(text, /qa-tools-relay|QA Tools|https:\/\/qa-tools\.ru/);
    // The old variable is named only as the old name it is.
    assert.deepEqual(
      text
        .split('\n')
        .filter((line) => line.includes('QA_TOOLS_ACCESS_KEY'))
        .map((line) => line.trim()),
      [
        '*   QA_TOOLS_ACCESS_KEY, is read when WEBHOOK_INSPECTOR_ACCESS_KEY is not set,',
        'QA_TOOLS_ACCESS_KEY          its old name, read when the one above is not',
        "export const OLD_ACCESS_KEY_VARIABLE = 'QA_TOOLS_ACCESS_KEY';",
      ],
    );
  });

  it('reads the second origin by default under its old name too, imported', async () => {
    const old = (await import(pathToFileURL(oldFile).href)) as typeof relay;

    assert.equal(old.DEFAULT_API, 'https://webhook.qa-tools.ru');
    assert.equal(old.USAGE, relay.USAGE);
    assert.equal(old.ACCESS_KEY_VARIABLE, 'WEBHOOK_INSPECTOR_ACCESS_KEY');
    assert.equal(
      old.parseArguments([ID, 'http://localhost:3000']).api?.href,
      'https://webhook.qa-tools.ru/',
    );
    assert.equal(
      old.parseArguments([ID, 'http://localhost:3000', '--api', 'http://127.0.0.1:3000']).api?.href,
      'http://127.0.0.1:3000/',
    );
  });

  it('prints its usage, run under either name, for --help and for an invalid argument', async () => {
    for (const script of [RELAY_SCRIPT_FILE, oldFile]) {
      const help = run(['--help'], undefined, script);

      assert.equal(await help.exited, 0);
      assert.ok(help.stdout.startsWith('Usage: node webhook-inspector-relay.mjs <session id'));

      const wrong = run([], undefined, script);

      assert.equal(await wrong.exited, 2);
      assert.match(
        wrong.stderr,
        /^webhook-inspector-relay: .+\n\nUsage: node webhook-inspector-relay\.mjs /,
      );
    }
  });
});

for (const name of [RELAY_SCRIPT_NAME, OLD_RELAY_SCRIPT_NAME]) {
  describe(`the /${name} location in nginx.conf`, () => {
    function location(): string {
      const config = read('../../nginx.conf');
      const escaped = name.replace(/[.-]/g, '\\$&');
      const block = new RegExp(
        `^\\s*location = \\/${escaped} \\{\\n([\\s\\S]*?)^\\s*\\}$`,
        'm',
      ).exec(config)?.[1];

      assert.ok(block !== undefined, `nginx.conf has no exact location for /${name}`);

      return block
        .split('\n')
        .map((line) => line.replace(/#.*$/, '').trim())
        .filter((line) => line.length > 0)
        .join('\n');
    }

    it('answers UTF-8 JavaScript whatever the mime table says', () => {
      const block = location();

      assert.match(block, /^types \{ \}$/m);
      assert.match(block, /^default_type text\/javascript;$/m);
      assert.match(block, /^charset utf-8;$/m);
      assert.match(block, /^charset_types text\/javascript;$/m);
    });

    it('is revalidated on every use, so a release and the hash /docs gives arrive together', () => {
      assert.match(location(), /^add_header Cache-Control 'no-cache' always;$/m);
    });

    it('serves the file or a plain 404, never the application shell', () => {
      const block = location();

      assert.match(block, /^try_files \$uri =404;$/m);
      assert.doesNotMatch(block, /index\.html|error_page|rewrite/);
    });
  });
}

describe('the build check of the relay script', () => {
  function check(
    file: Buffer | undefined,
    text = description,
    old: Buffer | null = scriptBytes,
  ): string[] {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-relay-dist-'));

    try {
      if (file !== undefined) {
        writeFileSync(join(dist, RELAY_SCRIPT_NAME), file);
      }

      if (old !== null) {
        writeFileSync(join(dist, OLD_RELAY_SCRIPT_NAME), old);
      }

      return relayScriptProblems(dist, text);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }

  it('passes the file whose SHA-256 the description gives, under both names', () => {
    assert.deepEqual(check(scriptBytes), []);
  });

  it('fails the old file missing, empty or not the same bytes, whatever the new one (D275, D279)', () => {
    for (const old of [null, Buffer.alloc(0)]) {
      assert.deepEqual(check(scriptBytes, description, old), [
        `${OLD_RELAY_SCRIPT_NAME} is not in the build`,
      ]);
      assert.deepEqual(check(undefined, description, old), [
        `${RELAY_SCRIPT_NAME} is not in the build`,
        `${OLD_RELAY_SCRIPT_NAME} is not in the build`,
      ]);
    }

    const changed = Buffer.concat([scriptBytes, Buffer.from('\n')]);
    const problems = check(scriptBytes, description, changed);

    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.startsWith(`${OLD_RELAY_SCRIPT_NAME} has the SHA-256 `), problems[0]);
  });

  it('fails a missing or empty file, a changed byte, and a description with another hash or two', () => {
    assert.deepEqual(check(undefined), [`${RELAY_SCRIPT_NAME} is not in the build`]);
    assert.deepEqual(check(Buffer.alloc(0)), [`${RELAY_SCRIPT_NAME} is not in the build`]);

    const changed = Buffer.from(scriptBytes);

    changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
    assert.equal(check(changed).length, 1);
    // Another hash fails both names.
    assert.equal(check(scriptBytes, description.replaceAll(scriptHash, 'f'.repeat(64))).length, 2);
    assert.equal(
      check(scriptBytes, `${description}\n\n## Forward to a local service\n\n${'0'.repeat(64)}\n`)
        .length,
      0,
      'only the first relay section is read',
    );
    assert.equal(
      check(scriptBytes, description.replace(scriptHash, `${scriptHash} ${'0'.repeat(64)}`)).length,
      2,
    );
    assert.equal(check(scriptBytes, 'no relay section').length, 2);
  });
});

describe('the command line', () => {
  it('takes the session id or its webhook URL, and a target base URL', () => {
    for (const first of [
      ID,
      `https://hook.qa-tools.ru/s/${ID}`,
      `https://hook.qa-tools.ru/s/${ID}/`,
      `https://hook.qa-tools.ru/s/${ID}/stripe/events?x=1#top`,
      `http://127.0.0.1:3001/s/${ID}`,
    ]) {
      const parsed = relay.parseArguments([first, 'http://localhost:3000']);

      assert.equal(parsed.error, undefined, first);
      assert.equal(parsed.sessionId, ID, first);
      assert.equal(parsed.target?.href, 'http://localhost:3000/');
      assert.equal(parsed.fromStart, false);
      assert.equal(parsed.api?.href, `${relay.DEFAULT_API}/`);
    }

    assert.equal(relay.parseArguments([OLD_ID, 'http://x']).sessionId, OLD_ID);
    assert.equal(relay.parseArguments([`https://h/s/${OLD_ID}/a`, 'http://x']).sessionId, OLD_ID);
  });

  it('takes --from-start and --api anywhere, and --help', () => {
    const parsed = relay.parseArguments([
      '--from-start',
      ID,
      '--api',
      'http://127.0.0.1:3000',
      'https://staging.internal/hooks',
    ]);

    assert.equal(parsed.sessionId, ID);
    assert.equal(parsed.target?.href, 'https://staging.internal/hooks');
    assert.equal(parsed.fromStart, true);
    assert.equal(parsed.api?.href, 'http://127.0.0.1:3000/');
    assert.equal(
      relay.parseArguments([ID, 'http://x', '--api=http://[::1]:3000/prefix']).api?.href,
      'http://[::1]:3000/prefix',
    );
    assert.deepEqual(relay.parseArguments(['--help']), { help: true });
    assert.deepEqual(relay.parseArguments([ID, '-h']), { help: true });
  });

  it('takes an id from before D161 that starts with - as the session, and every word after -- as an argument', () => {
    // About 1 in 64 ids made before D161 start with `-`, and 1 in 4096 with `--`.
    for (const old of [DASH_ID, DOUBLE_DASH_ID]) {
      for (const argv of [
        [old, 'http://x'],
        ['--from-start', old, 'http://x'],
        ['--api', 'http://127.0.0.1:3000', old, 'http://x', '--from-start'],
        ['--', old, 'http://x'],
        ['--from-start', '--', old, 'http://x'],
        ['--api=http://127.0.0.1:3000', '--from-start', '--', old, 'http://x'],
        [`https://hook.qa-tools.ru/s/${old}/a`, 'http://x'],
      ]) {
        const parsed = relay.parseArguments(argv);

        assert.equal(parsed.error, undefined, JSON.stringify(argv));
        assert.equal(parsed.sessionId, old, JSON.stringify(argv));
        assert.equal(parsed.target?.href, 'http://x/');
        assert.equal(parsed.fromStart, argv.includes('--from-start'));
      }
    }

    assert.equal(relay.parseArguments(['--', ID, 'http://x']).sessionId, ID);
    // An id is the first argument only: a later word that starts with `-` is an option.
    assert.equal(relay.parseArguments([ID, DASH_ID]).error, 'unknown option');
    assert.equal(relay.parseArguments(['http://x', DASH_ID]).error, 'unknown option');
    assert.match(
      relay.parseArguments([ID, '--', DASH_ID]).error ?? '',
      /target base URL is not a URL/,
    );
  });

  it('refuses everything else, naming the rule and quoting nothing', () => {
    const refused: [string[], RegExp][] = [
      [[], /both needed/],
      [[ID], /both needed/],
      [[ID, 'http://x', 'http://y'], /more than two/],
      [[ID, 'http://x', '--from'], /unknown option/],
      [[ID, 'http://x', '-x'], /unknown option/],
      [[ID, '-', 'http://x'], /unknown option/],
      [['--bogus', ID, 'http://x'], /unknown option/],
      [['-x', ID, 'http://x'], /unknown option/],
      [[`-${ID.slice(2)}`, 'http://x'], /unknown option/],
      [[`-${ID}`, 'http://x'], /unknown option/],
      [[`${DASH_ID}=`, 'http://x'], /unknown option/],
      [['--', ID, 'http://x', '--from-start'], /more than two/],
      [['--', ID, '--api', 'http://a'], /more than two/],
      [['--', '--help'], /both needed/],
      [[ID, 'http://x', '--from-start', '--from-start'], /given twice/],
      [[ID, 'http://x', '--api', 'http://a', '--api=http://b'], /given twice/],
      [[ID, 'http://x', '--api'], /needs a base URL/],
      [[ID.slice(1), 'http://x'], /neither a session id/],
      [[`${ID}A`, 'http://x'], /neither a session id/],
      [[`${ID.slice(1)}.`, 'http://x'], /neither a session id/],
      [[`https://qa-tools.ru/v/${ID}`, 'http://x'], /neither a session id/],
      [[`https://hook.qa-tools.ru/s/${ID}x/`, 'http://x'], /neither a session id/],
      [[`https://hook.qa-tools.ru/s/${ID.slice(1)}`, 'http://x'], /neither a session id/],
      [[`https://hook.qa-tools.ru/x/s/${ID}`, 'http://x'], /neither a session id/],
      [[`ftp://hook.qa-tools.ru/s/${ID}`, 'http://x'], /neither a session id/],
      [[`/s/${ID}`, 'http://x'], /neither a session id/],
      [[`https://hook.qa-tools.ru/s/%41${ID.slice(1)}`, 'http://x'], /neither a session id/],
      [['', 'http://x'], /neither a session id/],
      [[ID, 'localhost:3000'], /target base URL must be an http: or https: URL/],
      [[ID, 'ftp://x'], /target base URL must be an http: or https: URL/],
      [[ID, 'x'], /target base URL is not a URL/],
      [[ID, 'http://'], /target base URL is not a URL/],
      [[ID, 'http://user:secret@x'], /must not carry a user name or a password/],
      [[ID, 'http://x/?token=1'], /must not carry a query string or a fragment/],
      [[ID, 'http://x/#top'], /must not carry a query string or a fragment/],
      [[ID, 'http://x', '--api', 'file:///etc'], /--api base URL must be an http: or https: URL/],
      [
        [ID, 'http://x', '--api', 'https://qa-tools.ru/?a'],
        /--api base URL must not carry a query/,
      ],
    ];

    for (const [argv, pattern] of refused) {
      const { error } = relay.parseArguments(argv);

      assert.match(error ?? '', pattern, JSON.stringify(argv));

      for (const word of argv) {
        if (word.length > 3 && !word.startsWith('-')) {
          assert.ok(!(error ?? '').includes(word), `the error quotes ${word}`);
        }
      }
    }
  });

  it('refuses made-up arguments of growing size quickly, quoting none of them', () => {
    for (const size of SIZES) {
      // Refused wherever they stand.
      const neverValid = [
        'A'.repeat(size),
        '/'.repeat(size),
        '%'.repeat(size),
        '\u0000'.repeat(size),
        `${ID}${' '.repeat(size)}`,
        `http://x/${'?'.repeat(size)}`,
        `http://u:p@x/${'a'.repeat(size)}`,
        `ftp://x/s/${ID}/${'a'.repeat(size)}`,
        `-${'-'.repeat(size)}`,
        `-${'A'.repeat(size)}`,
        `${DASH_ID}${'_-'.repeat(size / 2)}`,
        `--api=${'h'.repeat(size)}`,
      ];
      // URLs, but not of a session.
      const notSessions = [
        `https://h/s/${'A'.repeat(size)}`,
        `https://h/${'s/'.repeat(size / 2)}`,
        `https://h/s/${'/'.repeat(size)}`,
        `https://h/s/${ID.slice(1)}${'/'.repeat(size)}`,
        `https://${'a.'.repeat(size / 2)}/s/${ID}x`,
      ];
      const refuse = (argv: string[]) => {
        const parsed = timed(`parseArguments of ${size} characters`, () =>
          relay.parseArguments(argv),
        );

        assert.ok(parsed.error !== undefined, `accepted ${argv.join(' ').slice(0, 60)}… (${size})`);
        assert.ok(parsed.error.length < 200, 'the error is not bounded');
      };

      for (const shape of neverValid) {
        refuse([shape, 'http://x']);
        refuse([ID, shape]);
        refuse([ID, 'http://x', '--api', shape]);
        refuse([shape, shape, shape]);
      }

      for (const shape of notSessions) {
        refuse([shape, 'http://x']);
        timed('a long target', () => relay.parseArguments([ID, shape]));
      }

      // Long but valid: a webhook URL with a long path, a target with a long path.
      assert.equal(
        timed('a long webhook URL', () =>
          relay.sessionIdFrom(`https://h/s/${ID}/${'a/'.repeat(size / 2)}?${'q'.repeat(size)}`),
        ),
        ID,
      );
      assert.equal(
        timed('a webhook URL with many slashes', () =>
          relay.sessionIdFrom(`https://h/s/${ID}${'/'.repeat(size)}`),
        ),
        ID,
      );
      assert.ok(
        timed('a long target', () =>
          relay.baseUrlFrom(`http://x/${'p/'.repeat(size / 2)}`),
        ) instanceof URL,
      );
    }
  });
});

describe('the path a request is sent to', () => {
  const at = (base: string) => new URL(base);

  it('is the target path, then the stored path after /s/<id>, without a doubled slash, then the query', () => {
    const cases: [string, string | null, string, string][] = [
      ['http://h:1', `/s/${ID}`, '', '/'],
      ['http://h:1', `/s/${ID}/`, '', '/'],
      ['http://h:1', `/s/${ID}/a/b`, 'x=1', '/a/b?x=1'],
      ['http://h:1', `/s/${ID}//dbl`, '', '//dbl'],
      ['http://h:1', `/s/${ID}/a/../b`, '', '/a/../b'],
      ['http://h:1', `/s/${ID}/%zz/%7euser`, 'a=%20&b', '/%zz/%7euser?a=%20&b'],
      ['http://h:1/hooks', `/s/${ID}`, '', '/hooks'],
      ['http://h:1/hooks', `/s/${ID}/`, '', '/hooks/'],
      ['http://h:1/hooks', `/s/${ID}/a`, '', '/hooks/a'],
      ['http://h:1/hooks', `/s/${ID}//a`, 'q', '/hooks//a?q'],
      ['http://h:1/hooks/', `/s/${ID}`, '', '/hooks/'],
      ['http://h:1/hooks/', `/s/${ID}/`, '', '/hooks/'],
      ['http://h:1/hooks/', `/s/${ID}/a`, '', '/hooks/a'],
      ['http://h:1/hooks', null, 'x=1', '/hooks?x=1'],
      ['http://h:1', null, '', '/'],
      // A stored path of another session, or that only starts like this one.
      ['http://h:1/hooks', `/s/${OLD_ID}/a`, '', '/hooks'],
      ['http://h:1/hooks', `/s/${ID}x/a`, '', '/hooks'],
      ['http://h:1/a b', `/s/${ID}/c`, '', '/a%20b/c'],
    ];

    for (const [base, stored, query, expected] of cases) {
      assert.equal(relay.targetPath(at(base), ID, stored, query), expected, `${base} ${stored}`);
    }
  });

  it('is built in linear time from long paths and queries', () => {
    for (const size of SIZES) {
      const path = timed('a long path', () =>
        relay.targetPath(
          at('http://h/hooks/'),
          ID,
          `/s/${ID}${'/'.repeat(size)}`,
          'q'.repeat(size),
        ),
      );

      assert.equal(path.length, '/hooks/'.length + size - 1 + 1 + size);
    }
  });
});

describe('the body sent', () => {
  const detail = (fields: Partial<Detail>) => ({
    method: 'POST',
    body: '',
    bodyBase64: null,
    isBinary: false,
    bodySize: 0,
    ...fields,
  });

  it('is the bytes that arrived, as Copy as cURL and Check signature rebuild them', () => {
    const cases = [
      detail({}),
      detail({ body: 'hello', bodySize: 5 }),
      detail({ body: 'Иван 🙂', bodySize: Buffer.byteLength('Иван 🙂') }),
      detail({ body: '{"a":1}', bodySize: 10 }),
      detail({ body: '', bodySize: 3 }),
      detail({ body: null, bodyBase64: 'AAEC//4=', isBinary: true, bodySize: 5 }),
      detail({ body: null, bodyBase64: null, isBinary: true, bodySize: 0 }),
      detail({ method: 'HEAD', body: 'ignored', bodySize: 7 }),
      detail({ method: 'GET', body: 'with a body', bodySize: 11 }),
    ];

    for (const fields of cases) {
      assert.deepEqual(
        [...relay.bodyBytes(fields)],
        [...receivedBodyBytes(fields)],
        JSON.stringify(fields),
      );
    }

    assert.deepEqual(
      [...relay.bodyBytes(detail({ body: '{"a":1}', bodySize: 10 }))],
      [0xef, 0xbb, 0xbf, ...Buffer.from('{"a":1}')],
    );
  });
});

describe('the headers sent', () => {
  it('are Host, the captured pairs in order and case less the dropped ones, then Content-Length', () => {
    const captured: Pair[] = [
      ['Host', 'hook.qa-tools.ru'],
      ['X-Dup', 'a'],
      ['content-type', 'application/json'],
      ['X-Forwarded-For', '203.0.113.9'],
      ['x-dup', 'b'],
      ['Accept-Encoding', 'gzip'],
      ['Accept-Encoding', 'br'],
      ['Content-Length', '7'],
      ['Connection', 'close'],
      ['X-Empty', ''],
    ];

    assert.deepEqual(
      relay.forwardedHeaders(
        new URL('http://localhost:3000/x'),
        'POST',
        captured,
        Buffer.from('{"a":1}'),
      ),
      [
        'Host',
        'localhost:3000',
        'X-Dup',
        'a',
        'content-type',
        'application/json',
        'x-dup',
        'b',
        'Accept-Encoding',
        'br',
        'X-Empty',
        '',
        'Content-Length',
        '7',
      ],
    );
  });

  it('carry Content-Length for a body, for a body the sender framed, and for a method Node would otherwise send chunked', () => {
    const headers = (target: string, method: string, captured: Pair[], body: string) =>
      relay.forwardedHeaders(new URL(target), method, captured, Buffer.from(body));

    // No body and no framing: nothing for the methods Node sends unframed...
    for (const method of ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE']) {
      assert.deepEqual(headers('https://staging.internal/hooks', method, [], ''), [
        'Host',
        'staging.internal',
      ]);
    }

    // ...and `Content-Length: 0` for the others, which Node would send chunked.
    for (const method of ['POST', 'PUT', 'PATCH', 'PROPFIND', 'QUERY', 'M-SEARCH']) {
      assert.deepEqual(headers('http://h', method, [], ''), ['Host', 'h', 'Content-Length', '0']);
    }

    assert.deepEqual(headers('http://[::1]:8080', 'GET', [['content-length', '0']], ''), [
      'Host',
      '[::1]:8080',
      'Content-Length',
      '0',
    ]);
    assert.deepEqual(headers('http://h', 'GET', [['Transfer-Encoding', 'chunked']], 'abc'), [
      'Host',
      'h',
      'Content-Length',
      '3',
    ]);
    assert.deepEqual(headers('http://h:80', 'GET', [['X-A', '1']], 'body'), [
      'Host',
      'h',
      'X-A',
      '1',
      'Content-Length',
      '4',
    ]);
  });
});

describe('Retry-After', () => {
  it('is waited out in whole seconds from 1 to the cap, and anything else uses the growing delay', () => {
    const cases: [string | null, number | null][] = [
      ['1', 1],
      ['0', 1],
      ['30', 30],
      [' 5 ', 5],
      [String(relay.RETRY_AFTER_MAX_SECONDS), relay.RETRY_AFTER_MAX_SECONDS],
      [String(relay.RETRY_AFTER_MAX_SECONDS + 1), relay.RETRY_AFTER_MAX_SECONDS],
      ['9999999999', relay.RETRY_AFTER_MAX_SECONDS],
      ['99999999999', null],
      [null, null],
      ['', null],
      ['1.5', null],
      ['-1', null],
      ['+5', null],
      ['1e3', null],
      ['0x10', null],
      ['５', null],
      ['Wed, 21 Oct 2015 07:28:00 GMT', null],
      ['5, 6', null],
    ];

    for (const [value, seconds] of cases) {
      assert.equal(relay.retryAfterSeconds(value), seconds, JSON.stringify(value));
    }
  });

  it('is read quickly whatever its size', () => {
    for (const size of SIZES) {
      const cases: [string, number | null][] = [
        ['9'.repeat(size), null],
        [' '.repeat(size), null],
        [`${'1'.repeat(size)}x`, null],
        [`${'0'.repeat(size)}5`, null],
        [`${' '.repeat(size)}5${' '.repeat(size)}`, 5],
        ['\t'.repeat(size), null],
      ];

      for (const [value, seconds] of cases) {
        assert.equal(
          timed('a long Retry-After', () => relay.retryAfterSeconds(value)),
          seconds,
        );
      }
    }
  });
});

describe('text printed to the console', () => {
  it('shows control characters and the characters that reorder text as escapes', () => {
    assert.equal(
      relay.printable('/a\u001b[31m\r\n\u0085‮​﻿b'),
      '/a\\u{1b}[31m\\u{d}\\u{a}\\u{85}\\u{202e}\\u{200b}\\u{feff}b',
    );
    assert.equal(relay.printable('/Иван/🙂?x=1'), '/Иван/🙂?x=1');
  });

  it('is cut at its limit whatever the input and its size', () => {
    for (const size of SIZES) {
      for (const text of ['a'.repeat(size), '\u001b'.repeat(size), '🙂'.repeat(size)]) {
        const shown = timed('printable', () => relay.printable(text, 200));

        assert.ok(shown.endsWith('...'));
        assert.ok(shown.length <= 200 * '\\u{1b}'.length + 3);
      }
    }

    assert.equal(relay.printable('abc', 3), 'abc');
    assert.equal(relay.printable('abcd', 3), 'abc...');
  });

  it('describes an error by its cause, or by the errors it gathers', () => {
    assert.equal(relay.describeError(new Error('plain')), 'plain');
    assert.equal(
      relay.describeError(
        new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }),
      ),
      'connect ECONNREFUSED',
    );
    assert.equal(
      relay.describeError(new AggregateError([new Error('one'), new Error('two')], '')),
      'one, two',
    );
    assert.equal(
      relay.describeError(Object.assign(new Error(''), { code: 'ECONNRESET' })),
      'ECONNRESET',
    );
    assert.equal(relay.describeError(new Error('a\nb')), 'a\\u{a}b');
  });
});

/** Servers and processes the tests below start, closed and killed after the file. */
const servers = new Set<http.Server>();
const children = new Set<ChildProcess>();

after(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
  }

  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});

async function listen(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ server: http.Server; base: string; port: number }> {
  const server = http.createServer(handler);

  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  return { server, base: `http://127.0.0.1:${port}`, port };
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  servers.delete(server);
}

describe('one exchange with the target', () => {
  it('ends with the status, an error, or the timeout, and never throws', async () => {
    const answering = await listen((request, response) => {
      if (request.url === '/silent') {
        return;
      }

      if (request.url === '/head-only') {
        response.writeHead(202);
        response.write('part of a body');
        return;
      }

      response.writeHead(201).end('done');
    });
    const target = new URL(answering.base);
    const send = (fields: Partial<Parameters<typeof relay.sendToTarget>[0]>) =>
      relay.sendToTarget({
        target,
        method: 'POST',
        path: '/',
        headers: ['Host', target.host],
        body: Buffer.alloc(0),
        timeoutMs: 300,
        ...fields,
      });

    assert.deepEqual(await send({}), { status: 201 });
    assert.deepEqual(await send({ path: '/silent' }), { error: 'no answer within 0.3 s' });
    assert.deepEqual(await send({ path: '/head-only' }), { status: 202 });
    assert.match((await send({ path: '/a b' })).error ?? '', /unescaped characters/i);
    assert.match((await send({ headers: ['X-Bad', 'a\r\nb'] })).error ?? '', /invalid character/i);
    assert.match((await send({ headers: ['X-Bad', 'Иван'] })).error ?? '', /invalid character/i);
    assert.match((await send({ headers: ['Bad Name', 'x'] })).error ?? '', /header name/i);
    assert.match((await send({ method: 'BAD METHOD' })).error ?? '', /method/i);

    await close(answering.server);
    assert.match((await send({})).error ?? '', /ECONNREFUSED/);
  });
});

const SESSION = 'Stub0relay0session0id0for0the0child0tests00';

type Planned =
  { status: number; headers?: Record<string, string>; body: unknown } | 'destroy' | 'hold';

/**
 * An API that answers the relay's calls from a plan: the list calls take the
 * next planned answer, and hold their answer once the plan is used up; each
 * detail call takes the next planned answer for its request.
 */
async function stubApi(lists: Planned[], details: Record<string, Planned[]> = {}) {
  const calls: {
    kind: 'list' | 'detail' | 'other';
    url: string;
    at: number;
    authorization: string | undefined;
    userAgent: string | undefined;
  }[] = [];
  const stub = await listen((request, response) => {
    const url = request.url ?? '';
    const path = url.split('?')[0] ?? '';
    const prefix = `/api/sessions/${SESSION}/requests`;
    const kind = path === prefix ? 'list' : path.startsWith(`${prefix}/`) ? 'detail' : 'other';
    let planned: Planned | undefined;

    calls.push({
      kind,
      url,
      at: performance.now(),
      authorization: request.headers.authorization,
      userAgent: request.headers['user-agent'],
    });

    if (kind === 'list') {
      planned = lists.shift() ?? 'hold';
    } else if (kind === 'detail') {
      planned = details[path.slice(prefix.length + 1)]?.shift();
    }

    if (planned === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ errorCode: 1000, message: 'Route not found' }));
    } else if (planned === 'destroy') {
      request.socket.destroy();
    } else if (planned !== 'hold') {
      response.writeHead(planned.status, {
        'content-type': 'application/json',
        ...planned.headers,
      });
      response.end(JSON.stringify(planned.body));
    }
  });

  return { ...stub, calls };
}

const listItem = {
  id: '3f8a1b20-0000-4000-8000-000000000001',
  method: 'POST',
  path: `/s/${SESSION}/hook`,
};

const stubDetail = {
  ...listItem,
  queryString: 'a=1',
  headers: [
    ['Content-Type', 'text/plain'],
    ['X-A', '1'],
  ],
  body: 'hello',
  bodyBase64: null,
  isBinary: false,
  bodySize: 5,
};

const ok = (body: unknown): Planned => ({ status: 200, body });

interface Run {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exited: Promise<number | null>;
}

/**
 * Runs the script with `args`. Its environment is this process's without
 * either access-key variable, plus `accessKey` as `WEBHOOK_INSPECTOR_ACCESS_KEY`
 * when given, and `variables` (D279).
 */
function run(
  args: string[],
  accessKey?: string,
  script = RELAY_SCRIPT_FILE,
  variables: Record<string, string> = {},
): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.WEBHOOK_INSPECTOR_ACCESS_KEY;
  delete env.QA_TOOLS_ACCESS_KEY;

  if (accessKey !== undefined) {
    env.WEBHOOK_INSPECTOR_ACCESS_KEY = accessKey;
  }

  Object.assign(env, variables);

  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const result: Run = {
    child,
    stdout: '',
    stderr: '',
    exited: new Promise((resolve) => {
      child.on('close', (code) => {
        children.delete(child);
        resolve(code);
      });
    }),
  };

  children.add(child);
  child.stdout?.on('data', (chunk: Buffer) => {
    result.stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    result.stderr += chunk.toString('utf8');
  });

  return result;
}

async function until(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await delay(20);
  }
}

async function stop(running: Run): Promise<number | null> {
  running.child.kill('SIGTERM');

  return running.exited;
}

describe('the script against an API that fails, limits or cannot be reached', () => {
  it('waits out a 429 for its Retry-After, prints one line, and goes on', async () => {
    const target = await listen((_request, response) => response.writeHead(200).end());
    const api = await stubApi(
      [
        ok([]),
        {
          status: 429,
          headers: { 'retry-after': '1' },
          body: {
            errorCode: 1015,
            message: 'Rate limit exceeded: 1200 API calls per minute per address; try again in 1 s',
          },
        },
        ok([listItem]),
      ],
      { [listItem.id]: [ok(stubDetail)] },
    );
    const running = run([SESSION, target.base, '--api', api.base]);

    await until('the request to reach the target', () =>
      /POST \/hook\?a=1 -> 200/.test(running.stdout),
    );

    const lists = api.calls.filter((call) => call.kind === 'list');

    assert.match(
      running.stderr,
      /API rate limit reached \(429, errorCode 1015\); trying again in 1 s/,
    );
    assert.equal(running.stderr.trim().split('\n').length, 1, running.stderr);
    assert.ok((lists[2]?.at ?? 0) - (lists[1]?.at ?? 0) >= 950, 'the 429 was not waited out');
    assert.equal(await stop(running), 0);
    assert.match(running.stdout, /Stopped\.$/m);
  });

  it('uses the growing delay for a 429 without a usable Retry-After', async () => {
    const target = await listen((_request, response) => response.writeHead(204).end());
    const api = await stubApi(
      [
        ok([]),
        { status: 429, body: {} },
        { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }, body: {} },
        ok([listItem]),
      ],
      { [listItem.id]: [ok(stubDetail)] },
    );
    const running = run([SESSION, target.base, '--api', api.base]);

    await until('the request to reach the target', () => /-> 204/.test(running.stdout));

    const lists = api.calls.filter((call) => call.kind === 'list');

    assert.match(running.stderr, /429\); trying again in 1 s\n.*429\); trying again in 2 s\n/);
    assert.ok((lists[2]?.at ?? 0) - (lists[1]?.at ?? 0) >= 950);
    assert.ok((lists[3]?.at ?? 0) - (lists[2]?.at ?? 0) >= 1_950);
    await stop(running);
  });

  it('prints a line for a 5xx, a broken connection and an unexpected answer, tries again, and keeps running', async () => {
    const target = await listen((_request, response) => response.writeHead(200).end());
    const api = await stubApi(
      [{ status: 503, body: { errorCode: 1500 } }, 'destroy', ok([]), ok([listItem])],
      {
        [listItem.id]: [ok('not a request'), ok(stubDetail)],
      },
    );
    const running = run([SESSION, target.base, '--api', api.base]);

    await until('the request to reach the target', () => /-> 200/.test(running.stdout));

    const lines = running.stderr.trim().split('\n');

    assert.match(lines[0] ?? '', /API answered 503, errorCode 1500; trying again in 1 s$/);
    assert.match(lines[1] ?? '', /API not reachable: .*; trying again in 2 s$/);
    // An answer resets the delay: the detail's unexpected body waits 1 s again.
    assert.match(lines[2] ?? '', /API answered 200 with an unexpected body; trying again in 1 s$/);
    assert.equal(lines.length, 3, running.stderr);
    assert.equal(running.child.exitCode, null);
    await stop(running);
  });

  it('skips a request no longer in the session when its details are read, and one whose details it cannot use', async () => {
    const reached: string[] = [];
    const target = await listen((request, response) => {
      reached.push(request.url ?? '');
      response.writeHead(200).end();
    });
    const gone = {
      ...listItem,
      id: '3f8a1b20-0000-4000-8000-000000000002',
      path: `/s/${SESSION}/gone`,
    };
    const odd = {
      ...listItem,
      id: '3f8a1b20-0000-4000-8000-000000000003',
      path: `/s/${SESSION}/odd`,
    };
    const api = await stubApi([ok([]), ok([gone, odd, listItem])], {
      [gone.id]: [{ status: 404, body: { errorCode: 1003, message: 'Request not found' } }],
      [odd.id]: [ok({ method: 'POST', headers: 'not pairs' })],
      [listItem.id]: [ok(stubDetail)],
    });
    const running = run([SESSION, target.base, '--api', api.base]);

    await until('the last request to reach the target', () =>
      /\/hook\?a=1 -> 200/.test(running.stdout),
    );

    // A 404 / 1003 comes alike for a request deleted, cleared or pushed out by
    // the newest 1000, so the line names none of the three.
    assert.match(running.stdout, /POST \/gone -> skipped: no longer in the session\n/);
    assert.doesNotMatch(running.stdout, /deleted|cleared|pushed out/);
    assert.match(running.stdout, /POST \/odd -> skipped: the API did not answer with a request\n/);
    assert.deepEqual(reached, ['/hook?a=1']);
    assert.equal(running.stderr, '');
    await stop(running);
  });

  it('ends with status 1 when the session is not found or has expired', async () => {
    for (const [answer, message] of [
      [{ status: 404, body: { errorCode: 1001 } }, /not found \(404, errorCode 1001\)/],
      [{ status: 410, body: { errorCode: 1002 } }, /expired \(410, errorCode 1002\)/],
    ] as const) {
      const api = await stubApi([answer]);
      const running = run([SESSION, 'http://127.0.0.1:9', '--api', api.base]);

      assert.equal(await running.exited, 1);
      assert.match(running.stderr, message);
      await close(api.server);
    }
  });

  /**
   * A session expires when its idle window, 7 days or a shorter one chosen at
   * creation, or its lifetime runs out (D242, D220), and the API's `410` does
   * not say which: the message names no number but the status and the code
   * (D265).
   */
  it('says an expired session ran out of its idle window or lifetime, naming no number of days', async () => {
    const api = await stubApi([{ status: 410, body: { errorCode: 1002 } }]);
    const running = run([SESSION, 'http://127.0.0.1:9', '--api', api.base]);

    assert.equal(await running.exited, 1);
    assert.equal(
      running.stderr,
      'The session has expired (410, errorCode 1002): its idle window or lifetime ran out. Create a new one.\n',
    );
    assert.doesNotMatch(running.stderr.replace('(410, errorCode 1002)', ''), /\d/);
    await close(api.server);

    // The header comment says the same, the default window named as such.
    const header = (/^\/\*\*[\s\S]*?\*\//m.exec(scriptBytes.toString('utf8'))?.[0] ?? '')
      .replace(/\n \*\s*/g, ' ')
      .replace(/ {2,}/g, ' ');

    assert.ok(
      header.includes(
        'A session expires once its idle window (7 days unless it was created with a shorter one) or its lifetime runs out, and the relay then stops with a message.',
      ),
      header,
    );
    assert.doesNotMatch(header, /unused for 7 days/);
  });

  it('prints the usage and exits with status 2 before any call for an invalid argument', async () => {
    const api = await stubApi([]);

    for (const args of [
      [],
      [SESSION],
      ['not-an-id', 'http://localhost:3000'],
      [SESSION, 'localhost:3000'],
      [SESSION, 'http://localhost:3000', '--from'],
      [`-${SESSION.slice(2)}`, 'http://localhost:3000'],
      // The local API goes before `--`, where it is still an option.
      ['--api', api.base, '--', SESSION, 'http://localhost:3000', '--from-start'],
      [SESSION, 'http://localhost:3000', '--api'],
    ]) {
      const running = run([...args, ...(args.includes('--api') ? [] : ['--api', api.base])]);

      assert.equal(await running.exited, 2, args.join(' '));
      assert.match(
        running.stderr,
        /^webhook-inspector-relay: .+\n\nUsage: node webhook-inspector-relay\.mjs /,
      );
      assert.equal(running.stdout, '');
    }

    assert.equal(api.calls.length, 0);

    const help = run(['--help']);

    assert.equal(await help.exited, 0);
    assert.ok(help.stdout.startsWith(relay.USAGE));
  });
});

/** A private session's access key, as the server draws one (D253). */
const ACCESS_KEY = 'Rk3Xq9Lm2Vb7Nc4Hj8Wt1Pz6Fd0Sg5Ya2Ue7Io4TmNq';

describe('the access key of a private session, WEBHOOK_INSPECTOR_ACCESS_KEY (D253, D279)', () => {
  it('is read from that variable alone: unset is no key, a key of either shape is taken', () => {
    assert.equal(relay.ACCESS_KEY_VARIABLE, 'WEBHOOK_INSPECTOR_ACCESS_KEY');
    assert.deepEqual(relay.accessKeyFrom(undefined), { accessKey: null });
    assert.deepEqual(relay.accessKeyFrom(ACCESS_KEY), { accessKey: ACCESS_KEY });
    assert.deepEqual(relay.accessKeyFrom(OLD_ID), { accessKey: OLD_ID });
    // Never from an argument: an option of that name is unknown.
    assert.deepEqual(
      relay.parseArguments([ID, 'http://localhost:3000', '--access-key', ACCESS_KEY]),
      {
        error: 'unknown option',
      },
    );
  });

  it('refuses any other value, empty and white space included, naming the variable and quoting none of it', () => {
    for (const variable of [undefined, 'WEBHOOK_INSPECTOR_ACCESS_KEY', 'QA_TOOLS_ACCESS_KEY']) {
      for (const value of [
        '',
        ' ',
        '\n',
        ACCESS_KEY.slice(1),
        `${ACCESS_KEY}x`,
        ` ${ACCESS_KEY}`,
        `${ACCESS_KEY}\n`,
        `${ACCESS_KEY.slice(1)}=`,
        `${ACCESS_KEY.slice(1)}ж`,
        `Bearer ${ACCESS_KEY}`,
      ]) {
        const answer = relay.accessKeyFrom(value, variable);

        assert.equal(
          answer.error,
          `${variable ?? 'WEBHOOK_INSPECTOR_ACCESS_KEY'} is set and is not an access key: 43 characters of A-Z, a-z, 0-9, _ and -`,
          JSON.stringify(value),
        );
        assert.equal(answer.accessKey, undefined);
      }
    }
  });

  it('refuses made-up values of growing size quickly', () => {
    for (const size of SIZES) {
      for (const value of [
        'a'.repeat(size),
        `${ACCESS_KEY} `.repeat(size / 44),
        'ж'.repeat(size),
      ]) {
        assert.ok(timed(`a value of ${size}`, () => relay.accessKeyFrom(value)).error);
      }
    }
  });

  it('is read from the new variable when it is set, an empty value included, else from QA_TOOLS_ACCESS_KEY (D279)', () => {
    const NEW = 'WEBHOOK_INSPECTOR_ACCESS_KEY';
    const OLD = 'QA_TOOLS_ACCESS_KEY';

    assert.equal(relay.OLD_ACCESS_KEY_VARIABLE, OLD);
    assert.equal(relay.accessKeyVariable({}), NEW);
    assert.equal(relay.accessKeyVariable({ [NEW]: ACCESS_KEY }), NEW);
    assert.equal(relay.accessKeyVariable({ [OLD]: ACCESS_KEY }), OLD);
    assert.equal(relay.accessKeyVariable({ [OLD]: '' }), OLD);
    // Both set: the new one wins, whatever either holds.
    assert.equal(relay.accessKeyVariable({ [NEW]: ACCESS_KEY, [OLD]: OLD_ID }), NEW);
    assert.equal(relay.accessKeyVariable({ [NEW]: '', [OLD]: ACCESS_KEY }), NEW);
    assert.equal(relay.accessKeyVariable({ [NEW]: 'x', [OLD]: ACCESS_KEY }), NEW);
    // Another letter case is another variable.
    assert.equal(relay.accessKeyVariable({ webhook_inspector_access_key: ACCESS_KEY }), NEW);
    assert.equal(relay.accessKeyVariable({ qa_tools_access_key: ACCESS_KEY }), NEW);
  });

  it('is sent as Authorization: Bearer on every API call, never to the service, and printed nowhere', async () => {
    const reached: (string | undefined)[] = [];
    const target = await listen((request, response) => {
      reached.push(request.headers.authorization);
      response.writeHead(200).end();
    });
    const api = await stubApi([ok([]), ok([listItem])], { [listItem.id]: [ok(stubDetail)] });
    const running = run([SESSION, target.base, '--api', api.base], ACCESS_KEY);

    await until('the request to reach the target', () => /-> 200/.test(running.stdout));
    assert.equal(await stop(running), 0);

    assert.ok(api.calls.length >= 3, `${api.calls.length} calls`);

    for (const call of api.calls) {
      assert.equal(call.authorization, `Bearer ${ACCESS_KEY}`, call.url);
      assert.equal(call.userAgent, 'webhook-inspector-relay', call.url);
      assert.ok(!call.url.includes(ACCESS_KEY), 'the key went into a URL');
    }

    assert.deepEqual(reached, [undefined]);
    assert.ok(!running.stdout.includes(ACCESS_KEY));
    assert.ok(!running.stderr.includes(ACCESS_KEY));
    assert.doesNotMatch(running.stderr, /QA_TOOLS_ACCESS_KEY/);
  });

  it('is read from QA_TOOLS_ACCESS_KEY alone, with one line naming the new variable, and printed nowhere (D279)', async () => {
    const target = await listen((_request, response) => response.writeHead(200).end());
    const api = await stubApi([ok([]), ok([listItem])], { [listItem.id]: [ok(stubDetail)] });
    const running = run([SESSION, target.base, '--api', api.base], undefined, RELAY_SCRIPT_FILE, {
      QA_TOOLS_ACCESS_KEY: ACCESS_KEY,
    });

    await until('the request to reach the target', () => /-> 200/.test(running.stdout));
    assert.equal(await stop(running), 0);

    assert.ok(api.calls.length >= 3, `${api.calls.length} calls`);

    for (const call of api.calls) {
      assert.equal(call.authorization, `Bearer ${ACCESS_KEY}`, call.url);
    }

    assert.equal(
      running.stderr,
      'QA_TOOLS_ACCESS_KEY is the old name of WEBHOOK_INSPECTOR_ACCESS_KEY, read until the date the changelog gives; set WEBHOOK_INSPECTOR_ACCESS_KEY instead.\n',
    );
    assert.ok(!running.stdout.includes(ACCESS_KEY));
  });

  it('sends the new variable’s key when both are set, and refuses an invalid new one whatever the old one holds (D279)', async () => {
    const target = await listen((_request, response) => response.writeHead(200).end());
    const api = await stubApi([ok([]), ok([listItem])], { [listItem.id]: [ok(stubDetail)] });
    const running = run([SESSION, target.base, '--api', api.base], ACCESS_KEY, RELAY_SCRIPT_FILE, {
      QA_TOOLS_ACCESS_KEY: OLD_ID,
    });

    await until('the request to reach the target', () => /-> 200/.test(running.stdout));
    assert.equal(await stop(running), 0);

    for (const call of api.calls) {
      assert.equal(call.authorization, `Bearer ${ACCESS_KEY}`, call.url);
    }

    assert.ok(!running.stderr.includes(OLD_ID));
    assert.doesNotMatch(running.stderr, /old name/);

    const refused = await stubApi([]);

    for (const value of ['', `${ACCESS_KEY}x`]) {
      const invalid = run(
        [SESSION, 'http://localhost:3000', '--api', refused.base],
        value,
        RELAY_SCRIPT_FILE,
        { QA_TOOLS_ACCESS_KEY: ACCESS_KEY },
      );

      assert.equal(await invalid.exited, 2, JSON.stringify(value));
      assert.match(
        invalid.stderr,
        /^webhook-inspector-relay: WEBHOOK_INSPECTOR_ACCESS_KEY is set and is not an access key: /,
      );
      assert.ok(!invalid.stderr.includes(ACCESS_KEY));
    }

    assert.equal(refused.calls.length, 0);
  });

  it('is not sent at all when neither variable is set, so a public session is read as before', async () => {
    const target = await listen((_request, response) => response.writeHead(200).end());
    const api = await stubApi([ok([]), ok([listItem])], { [listItem.id]: [ok(stubDetail)] });
    const running = run([SESSION, target.base, '--api', api.base]);

    await until('the request to reach the target', () => /-> 200/.test(running.stdout));
    await stop(running);

    assert.ok(api.calls.length >= 3);
    assert.deepEqual(
      api.calls.map((call) => call.authorization),
      api.calls.map(() => undefined),
    );
    assert.equal(running.stderr, '');
  });

  it('prints the usage and exits with status 2 before any call for a value that is not a key, quoting none of it', async () => {
    const api = await stubApi([]);

    for (const [variable, value] of [
      ['WEBHOOK_INSPECTOR_ACCESS_KEY', ''],
      ['WEBHOOK_INSPECTOR_ACCESS_KEY', ' '],
      ['WEBHOOK_INSPECTOR_ACCESS_KEY', `${ACCESS_KEY}x`],
      ['WEBHOOK_INSPECTOR_ACCESS_KEY', `${ACCESS_KEY}\n`],
      ['WEBHOOK_INSPECTOR_ACCESS_KEY', `Bearer ${ACCESS_KEY}`],
      ['QA_TOOLS_ACCESS_KEY', ''],
      ['QA_TOOLS_ACCESS_KEY', `${ACCESS_KEY}x`],
      ['QA_TOOLS_ACCESS_KEY', `Bearer ${ACCESS_KEY}`],
    ] as const) {
      const running = run(
        [SESSION, 'http://localhost:3000', '--api', api.base],
        undefined,
        RELAY_SCRIPT_FILE,
        { [variable]: value },
      );

      assert.equal(await running.exited, 2, JSON.stringify(value));
      assert.ok(
        running.stderr.startsWith(
          `webhook-inspector-relay: ${variable} is set and is not an access key: `,
        ),
        running.stderr,
      );
      assert.match(running.stderr, /\n\nUsage: node webhook-inspector-relay\.mjs /);
      assert.ok(!running.stderr.includes(ACCESS_KEY), 'the value was quoted');
      assert.equal(running.stdout, '');
    }

    // An invalid argument is reported first, the key unread.
    const both = run(['not-an-id', 'http://localhost:3000', '--api', api.base], 'x');

    assert.equal(await both.exited, 2);
    assert.match(both.stderr, /^webhook-inspector-relay: the first argument /);
    assert.equal(api.calls.length, 0);
  });

  it('names both variables in the usage, and the one read when a session that may be private is not found', async () => {
    assert.match(
      relay.USAGE,
      /^ {2}WEBHOOK_INSPECTOR_ACCESS_KEY the access key of a private session/m,
    );
    assert.match(relay.USAGE, /^ {2}QA_TOOLS_ACCESS_KEY {10}its old name/m);

    for (const [variables, named] of [
      [{ WEBHOOK_INSPECTOR_ACCESS_KEY: ACCESS_KEY }, 'WEBHOOK_INSPECTOR_ACCESS_KEY'],
      [{ QA_TOOLS_ACCESS_KEY: ACCESS_KEY }, 'QA_TOOLS_ACCESS_KEY'],
      [{}, 'WEBHOOK_INSPECTOR_ACCESS_KEY'],
    ] as const) {
      const api = await stubApi([{ status: 404, body: { errorCode: 1001 } }]);
      const running = run(
        [SESSION, 'http://127.0.0.1:9', '--api', api.base],
        undefined,
        RELAY_SCRIPT_FILE,
        variables,
      );

      assert.equal(await running.exited, 1);
      assert.ok(
        running.stderr.includes(`it is private and ${named} does not hold its access key`),
        running.stderr,
      );
      assert.ok(!running.stderr.includes(ACCESS_KEY));
      await close(api.server);
    }
  });
});

describe('/docs on a private session for the relay (D253)', () => {
  const section = relaySection(description) ?? '';

  it('says the key is read from WEBHOOK_INSPECTOR_ACCESS_KEY, else from its old name, sent to the API alone, printed nowhere, and kept out of the shell history', () => {
    assert.match(section, /`WEBHOOK_INSPECTOR_ACCESS_KEY`/);
    assert.match(section, /`QA_TOOLS_ACCESS_KEY`/);
    assert.match(section, /`Authorization: Bearer` on every API call, never to your service/);
    assert.match(section, /exits with status 2 before any call/);
    assert.match(section, /never from an argument/);
  });
});
