/**
 * The quickstart in `info.description` of `packages/shared/openapi.json`, run
 * as written against a real server (issue #34, D155).
 *
 * The quickstart is what a reader of https://qa-tools.ru/docs copies first, so
 * its commands are not paraphrased here: they are read out of the description
 * and replayed. Each `bash` block is a list of `curl` commands and shell
 * assignments; each `json` or `http` block after a `curl` is the answer the
 * page promises for it. A changed route, field, status or header therefore
 * fails this test instead of leaving a wrong example online.
 *
 * How an example is compared with the real answer:
 * - every key the example shows must be in the answer, with the same JSON type;
 *   the answer may carry more (an example may be abridged, and clients ignore
 *   unknown fields, D154);
 * - numbers, booleans and `null` must be equal, and so must strings, except the
 *   ones that differ on every run by nature — ids, timestamps, addresses — which
 *   need only be strings. A value the quickstart put in a shell variable
 *   (`SESSION=…`) is replaced by the real one before comparing. An inspector
 *   link, `https://qa-tools.ru/v/<session>#<request>` (D223), is compared as
 *   substituted up to its `#`, and its request id by shape; the webhook's
 *   answer is checked separately to link the session and the request it
 *   stored;
 * - the captured request's own `headers` are compared by shape: which ones a
 *   request arrives with depends on the client that sends it;
 * - an `http` block pins the status line, each header it lists and the body
 *   byte for byte.
 *
 * A shell assignment `NAME=<value>` takes `<value>` from the example answer
 * before it, finds where in that example it stands, and reads the same place
 * of the real answer — so the variable holds what the reader's own call would
 * have returned.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { buildTestServers, type TestServers } from './testing/servers.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const spec = JSON.parse(
  readFileSync(new URL('../../../packages/shared/openapi.json', import.meta.url), 'utf8'),
) as {
  info: { description: string };
  servers: { url: string }[];
  paths: Record<string, { servers?: { url: string }[] }>;
};

const PRODUCTION = spec.servers[0]?.url ?? '';

/** The webhook host, the receive operation's own server (D187). */
const RECEIVE_HOST = spec.paths['/s/{sessionId}']?.servers?.[0]?.url ?? '';

/** The quickstart: from its heading to the next second-level heading. */
function quickstartSection(description: string): string {
  const start = description.indexOf('\n## Quickstart\n');

  assert.ok(start >= 0, 'info.description has no "## Quickstart" section');

  const end = description.indexOf('\n## ', start + 1);

  return description.slice(start, end < 0 ? undefined : end);
}

interface Block {
  language: string;
  text: string;
}

function fencedBlocks(markdown: string): Block[] {
  return [...markdown.matchAll(/^```(\w*)\n([\s\S]*?)\n```$/gm)].map((match) => ({
    language: match[1] ?? '',
    text: match[2] ?? '',
  }));
}

/**
 * Splits a command line into words as a POSIX shell would for the forms the
 * quickstart uses: single quotes are literal, double quotes expand `$NAME`,
 * and a bare word expands it too.
 */
function shellWords(line: string, variables: Map<string, string>): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let index = 0;

  const expand = (text: string) =>
    text.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_whole, name: string) => {
      const value = variables.get(name);

      assert.ok(value !== undefined, `$${name} is used before the quickstart sets it`);

      return value;
    });

  while (index < line.length) {
    const character = line[index] as string;

    if (character === ' ' || character === '\t') {
      if (word !== undefined) {
        words.push(word);
        word = undefined;
      }
      index += 1;
    } else if (character === "'") {
      const close = line.indexOf("'", index + 1);

      assert.ok(close > index, `unterminated single quote in: ${line}`);
      word = (word ?? '') + line.slice(index + 1, close);
      index = close + 1;
    } else if (character === '"') {
      const close = line.indexOf('"', index + 1);

      assert.ok(close > index, `unterminated double quote in: ${line}`);
      word = (word ?? '') + expand(line.slice(index + 1, close));
      index = close + 1;
    } else {
      const bare = /^[^\s'"]+/.exec(line.slice(index))?.[0] ?? character;

      word = (word ?? '') + expand(bare);
      index += bare.length;
    }
  }

  if (word !== undefined) {
    words.push(word);
  }

  return words;
}

interface Curl {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | undefined;
  includeHeaders: boolean;
}

/** The subset of curl the quickstart uses: -X, -H, -d, -i and one URL. */
function parseCurl(words: string[]): Curl {
  assert.equal(words[0], 'curl');

  let method: string | undefined;
  let url: string | undefined;
  let body: string | undefined;
  let includeHeaders = false;
  const headers: [string, string][] = [];

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] as string;
    const next = () => {
      index += 1;
      const value = words[index];

      assert.ok(value !== undefined, `${word} needs a value`);

      return value;
    };

    if (word === '-X') {
      method = next();
    } else if (word === '-H') {
      const header = next();
      const colon = header.indexOf(':');

      headers.push([header.slice(0, colon).trim(), header.slice(colon + 1).trim()]);
    } else if (word === '-d') {
      body = next();
    } else if (word === '-i') {
      includeHeaders = true;
    } else {
      assert.ok(url === undefined, `unexpected curl argument: ${word}`);
      url = word;
    }
  }

  assert.ok(url !== undefined, 'curl without a URL');

  // curl's own defaults: -d makes a POST and declares a form body.
  if (body !== undefined && !headers.some(([name]) => name.toLowerCase() === 'content-type')) {
    headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  }

  return {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    url,
    headers,
    body,
    includeHeaders,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ADDRESS = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;
/** A session's `receiveUrl`; the test checks separately that it names the session. */
const RECEIVE_URL = /^https:\/\/hook\.qa-tools\.ru\/s\/[A-Za-z0-9_-]{43}$/;
/**
 * A request's `inspectorUrl` in a default answer (D182, D223); the test checks
 * separately that it names the session and the request.
 */
const INSPECTOR_URL =
  /^https:\/\/qa-tools\.ru\/v\/[A-Za-z0-9_-]{43}#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A value that differs on every run: only its type is compared. */
function variesByNature(value: string): boolean {
  return [UUID, SESSION_ID, TIMESTAMP, ADDRESS, RECEIVE_URL, INSPECTOR_URL].some((pattern) =>
    pattern.test(value),
  );
}

/**
 * Two inspector links to the same session: the request id after `#` is the
 * one the answer reports, which the example cannot know.
 */
function sameInspectorPage(expected: string, real: Json | undefined): boolean {
  return (
    typeof real === 'string' &&
    INSPECTOR_URL.test(expected) &&
    INSPECTOR_URL.test(real) &&
    expected.slice(0, expected.indexOf('#')) === real.slice(0, real.indexOf('#'))
  );
}

/** The headers a captured request arrived with, at the top of its detail. */
const ARRIVED_HEADERS = '$.headers';

/** Where `needle` stands in `example`, as a list of keys and indexes. */
function locate(example: Json, needle: string): (string | number)[] | undefined {
  if (example === needle) {
    return [];
  }

  if (Array.isArray(example)) {
    for (const [index, item] of example.entries()) {
      const path = locate(item, needle);

      if (path) {
        return [index, ...path];
      }
    }
  } else if (example !== null && typeof example === 'object') {
    for (const [key, item] of Object.entries(example)) {
      const path = locate(item, needle);

      if (path) {
        return [key, ...path];
      }
    }
  }

  return undefined;
}

function at(value: Json, path: (string | number)[]): Json | undefined {
  let current: Json | undefined = value;

  for (const step of path) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }

    current = Array.isArray(current)
      ? current[step as number]
      : (current as Record<string, Json>)[step as string];
  }

  return current;
}

/** Every difference between an example and a real answer, by the rules above. */
function differences(
  example: Json,
  real: Json | undefined,
  substitute: (text: string) => string,
  where = '$',
): string[] {
  const kind = (value: Json | undefined) =>
    value === undefined
      ? 'absent'
      : value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : typeof value;

  if (kind(example) !== kind(real)) {
    return [`${where}: the example shows ${kind(example)}, the answer has ${kind(real)}`];
  }

  if (Array.isArray(example)) {
    const answer = real as Json[];

    if (example.length === 0 || where === ARRIVED_HEADERS) {
      return [];
    }

    if (answer.length < example.length) {
      return [`${where}: the example shows ${example.length} items, the answer ${answer.length}`];
    }

    return example.flatMap((item, index) =>
      differences(item, answer[index], substitute, `${where}[${index}]`),
    );
  }

  if (example !== null && typeof example === 'object') {
    const answer = real as Record<string, Json>;

    return Object.entries(example).flatMap(([key, item]) =>
      differences(item, answer[key], substitute, `${where}.${key}`),
    );
  }

  if (typeof example === 'string') {
    const expected = substitute(example);

    if (
      expected === real ||
      (expected === example && variesByNature(example)) ||
      sameInspectorPage(expected, real)
    ) {
      return [];
    }

    return [
      `${where}: the example shows ${JSON.stringify(expected)}, the answer ${JSON.stringify(real)}`,
    ];
  }

  return example === real
    ? []
    : [
        `${where}: the example shows ${JSON.stringify(example)}, the answer ${JSON.stringify(real)}`,
      ];
}

interface Answer {
  status: number;
  statusText: string;
  headers: Headers;
  text: string;
  /** Milliseconds from sending the request to reading the whole answer. */
  elapsedMs: number;
}

/** The status line, headers and body an `http` example block shows. */
function parseHttpExample(text: string) {
  const [head = '', body = ''] = text.split(/\n\n/, 2);
  const [statusLine = '', ...headerLines] = head.split('\n');
  const status = /^HTTP\/1\.1 (\d{3}) (.*)$/.exec(statusLine);

  assert.ok(status, `not a status line: ${statusLine}`);

  return {
    status: Number(status[1]),
    reason: status[2] ?? '',
    headers: headerLines.map((line) => {
      const colon = line.indexOf(':');

      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as [string, string];
    }),
    body,
  };
}

describe('the quickstart in info.description', () => {
  let pool: pg.Pool;
  let servers: TestServers;
  /** Where the quickstart's `https://qa-tools.ru` calls go: the application listener. */
  let base: string;
  /** Where its `https://hook.qa-tools.ru` calls go: the receive listener (D187). */
  let receiveBase: string;
  const createdSessionIds: string[] = [];

  const listening = async (server: FastifyInstance): Promise<string> => {
    await server.listen({ host: '127.0.0.1', port: 0 });

    return `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  };

  before(async () => {
    pool = createPool(loadConfig().databaseUrl);
    // `receiveUrl` as production gives it, so the quickstart's own example
    // can be compared with it.
    servers = buildTestServers(pool, {
      receiveOrigin: RECEIVE_HOST,
      // The inspector links of the default answer as production gives them (D223).
      appOrigin: PRODUCTION,
      logDestination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });
    base = await listening(servers.api);
    receiveBase = await listening(servers.receiver);
  });

  after(async () => {
    if (createdSessionIds.length > 0) {
      await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
    }

    await servers?.close();
    await pool.end();
  });

  it('names production as the host its commands call, and the webhook host for webhooks', () => {
    const quickstart = quickstartSection(spec.info.description);

    assert.equal(PRODUCTION, 'https://qa-tools.ru');
    assert.equal(RECEIVE_HOST, 'https://hook.qa-tools.ru');
    assert.ok(quickstart.includes(`${PRODUCTION}/api/sessions`));
    assert.ok(quickstart.includes(`${RECEIVE_HOST}/s/$SESSION`));
    assert.equal(quickstart.includes(`${PRODUCTION}/s/`), false);
  });

  it('works as written, step by step', async () => {
    const blocks = fencedBlocks(quickstartSection(spec.info.description));
    const variables = new Map<string, string>();
    /** Each shell variable's value in the examples, and its value here. */
    const literals = new Map<string, string>();
    const performed: string[] = [];
    let lastExample: Json | undefined;
    let lastAnswer: Json | undefined;
    let pending: { curl: Curl; answer: Answer } | undefined;
    /** The quickstart's `DELETE` of a session (D198), which shows no answer of its own. */
    let deleted: { curl: Curl; answer: Answer } | undefined;
    /** The `delayMs` of the last custom session the quickstart created. */
    let configuredDelayMs = 0;

    const substitute = (text: string) => {
      let result = text;

      for (const [literal, value] of literals) {
        result = result.split(literal).join(value);
      }

      return result;
    };

    const send = async (curl: Curl): Promise<Answer> => {
      // Webhooks to the webhook host and everything else to production, and
      // nothing to any other host.
      const [host, target] = curl.url.startsWith(`${RECEIVE_HOST}/`)
        ? [RECEIVE_HOST, receiveBase]
        : [PRODUCTION, base];

      assert.ok(curl.url.startsWith(`${host}/`), `${curl.url} is not on ${PRODUCTION}`);
      assert.equal(
        host === RECEIVE_HOST,
        new URL(curl.url).pathname.startsWith('/s/'),
        `${curl.url}: webhooks go to ${RECEIVE_HOST}, everything else to ${PRODUCTION}`,
      );

      const url = new URL(curl.url.slice(host.length), target);
      const started = performance.now();
      const response = await fetch(url, {
        method: curl.method,
        headers: curl.headers,
        body: curl.body,
      });
      const answer = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        text: await response.text(),
        elapsedMs: performance.now() - started,
      };

      if (curl.method === 'POST' && url.pathname === '/api/sessions' && answer.status === 201) {
        const created = JSON.parse(answer.text) as { id: string; receiveUrl: string };

        createdSessionIds.push(created.id);
        // The pattern above only shapes the comparison; the URL names this session.
        assert.equal(created.receiveUrl, `${RECEIVE_HOST}/s/${created.id}`);

        const configured = curl.body
          ? (JSON.parse(curl.body) as { response?: { delayMs?: number } }).response
          : undefined;

        configuredDelayMs = configured?.delayMs ?? 0;
      }

      // A default session's answer links the request it stored, on the site.
      // The pattern above only shapes the comparison; the link names both.
      if (host === RECEIVE_HOST && answer.status === 200 && answer.text.startsWith('{"ok":true,')) {
        const { inspectorUrl } = JSON.parse(answer.text) as { inspectorUrl?: string };

        assert.equal(
          inspectorUrl,
          `${PRODUCTION}/v/${url.pathname.split('/')[2]}#${answer.headers.get('x-qa-tools-request-id')}`,
        );
      }

      return answer;
    };

    const checkJson = (curl: Curl, answer: Answer, example: Json) => {
      assert.ok(
        answer.status >= 200 && answer.status < 300,
        `${curl.method} ${curl.url} answered ${answer.status}: ${answer.text}`,
      );

      const real = JSON.parse(answer.text) as Json;

      return { real, found: differences(example, real, substitute) };
    };

    for (const block of blocks) {
      if (block.language === 'bash') {
        pending = undefined;

        const lines = block.text
          .replace(/\\\n\s*/g, ' ')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#'));

        for (const line of lines) {
          const assignment = /^([A-Z_][A-Z0-9_]*)=(\S+)$/.exec(line);

          if (assignment) {
            const [, name = '', literal = ''] = assignment;

            assert.ok(
              lastExample !== undefined && lastAnswer !== undefined,
              `${name} has no answer to come from`,
            );

            const path = locate(lastExample, literal);

            assert.ok(path, `${name}=${literal}: the example before it does not show that value`);

            const value = at(lastAnswer, path);

            assert.equal(typeof value, 'string', `${name}: the real answer has no value there`);
            variables.set(name, value as string);
            literals.set(literal, value as string);
            continue;
          }

          const curl = parseCurl(shellWords(line, variables));
          const path = new URL(curl.url).pathname
            .replace(/\/[A-Za-z0-9_-]{43}(?=\/|$)/, '/{sessionId}')
            .replace(/\/[0-9a-f-]{36}$/i, '/{requestId}');

          performed.push(`${curl.method} ${path}`);
          pending = { curl, answer: await send(curl) };

          if (curl.method === 'DELETE') {
            deleted = pending;
          }
        }
      } else if (block.language === 'json' && pending) {
        const example = JSON.parse(block.text) as Json;
        const { curl } = pending;
        let { answer } = pending;
        let { real, found } = checkJson(curl, answer, example);

        // A response record is written once its answer has been sent, so a
        // read that follows at once may still see it pending. Reads are
        // repeated for a short while; a mismatch that lasts is a failure.
        for (
          let attempt = 0;
          found.length > 0 && curl.method === 'GET' && attempt < 20;
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          answer = await send(curl);
          ({ real, found } = checkJson(curl, answer, example));
        }

        assert.deepEqual(
          found,
          [],
          `${curl.method} ${curl.url} does not answer as the quickstart shows`,
        );
        lastExample = example;
        lastAnswer = real;
        pending = undefined;
      } else if (block.language === 'http' && pending) {
        const { curl, answer } = pending;
        const example = parseHttpExample(block.text);

        assert.ok(curl.includeHeaders, 'an http example follows a curl without -i');
        assert.equal(answer.status, example.status);
        assert.equal(answer.statusText, example.reason);

        for (const [name, value] of example.headers) {
          const real = answer.headers.get(name);

          assert.ok(real !== null, `the answer carries no ${name} header`);
          assert.ok(value === real || (UUID.test(value) && UUID.test(real)), `${name}: ${real}`);
        }

        assert.equal(answer.text, example.body);
        // The quickstart promises the sender waits out the configured delay.
        assert.ok(configuredDelayMs > 0, 'the http example follows no delayed session');
        assert.ok(
          answer.elapsedMs >= configuredDelayMs,
          `answered after ${Math.round(answer.elapsedMs)} ms, before the ${configuredDelayMs} ms delay`,
        );
        pending = undefined;
      }
    }

    // The four calls the page promises, the custom response after them, its
    // response queue (D205), its response rules and a webhook one of them
    // answers (D246), and the deletion that ends it (D198).
    assert.deepEqual(performed, [
      'POST /api/sessions',
      'POST /s/{sessionId}',
      'GET /api/sessions/{sessionId}/requests',
      'GET /api/sessions/{sessionId}/requests/{requestId}',
      'POST /api/sessions',
      'POST /s/{sessionId}',
      'PUT /api/sessions/{sessionId}/response',
      'PUT /api/sessions/{sessionId}/queue',
      'PUT /api/sessions/{sessionId}/rules',
      'POST /s/{sessionId}/orders',
      'DELETE /api/sessions/{sessionId}',
    ]);

    // Step 9 shows no answer to compare: it promises `204` with no body, and
    // a session gone, so a second deletion and a webhook answer `404` / `1001`.
    assert.ok(deleted, 'the quickstart deleted no session');
    assert.equal(deleted.answer.status, 204, deleted.answer.text);
    assert.equal(deleted.answer.text, '');

    const again = await send(deleted.curl);

    assert.equal(again.status, 404);
    assert.deepEqual(JSON.parse(again.text), { errorCode: 1001, message: 'Session not found' });

    const webhook = await send({
      method: 'POST',
      url: `${RECEIVE_HOST}${new URL(deleted.curl.url).pathname.replace('/api/sessions/', '/s/')}`,
      headers: [],
      body: 'x',
      includeHeaders: false,
    });

    assert.equal(webhook.status, 404);
    assert.deepEqual(JSON.parse(webhook.text), { errorCode: 1001, message: 'Session not found' });
  });
});
