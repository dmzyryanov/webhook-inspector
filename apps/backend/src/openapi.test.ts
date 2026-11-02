/**
 * The published OpenAPI description (`packages/shared/openapi.json`) against the
 * server it describes (D154).
 *
 * `docs/API.md` is the contract and the description is its public projection,
 * so drift is caught here rather than left to care:
 * - the file is valid OpenAPI 3.1, and every schema in it compiles as strict
 *   JSON Schema 2020-12 and accepts its own examples;
 * - `info.version` is `VERSION`;
 * - every route the server registers, probes and `/ws` aside, is described,
 *   and every described path is a registered route;
 * - real answers from the app, one call per operation and per documented
 *   error code that a client can provoke, validate against the schema the
 *   description gives for their status, with every object closed so that a
 *   field the server returns and the description lacks fails too;
 * - the pattern a response rule's path is described with takes and refuses
 *   what the server's own check does (D246);
 * - the Network section of `info.description` publishes the server address
 *   the Network section of `docs/API.md` does, and no other (D204).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { Validator } from '@seriousme/openapi-schema-validator';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  API_ANSWER_BYTES,
  API_ANSWER_PER_ADDRESS_BYTES,
  MAX_BODY_BYTES,
  MAX_HEADER_LINES_IN_FLIGHT,
  MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS,
  MAX_PIPELINED_REQUESTS,
  MAX_REALTIME_CONNECTIONS_PER_ADDRESS,
  MAX_RECEIVE_CONNECTIONS_PER_ADDRESS,
  MAX_REQUESTS_PER_SESSION,
  MAX_RULE_PATH_BYTES,
  NEGOTIABLE_EVENT_TYPES,
  REQUEST_LIST_MAX_WAIT_SECONDS,
  SESSION_IDLE_DAYS,
  WsCloseCode,
} from '@webhook-inspector/shared';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { AppError } from './errors/app-error.ts';
import { createCallPlaces } from './modules/limits/calls-in-flight.ts';
import { createBodyListPlaces } from './modules/requests/body-lists.ts';
import { createQuerySlots, createSearchSlots } from './modules/requests/search.ts';
import { createLargeBodyPlaces } from './modules/sessions/large-bodies.ts';
import { CREATION_KEY_RULE, parseRules } from './modules/sessions/response-config.ts';
import { KEYS_RULE } from './modules/sessions/status-body.ts';
import { createCaptureBudget, inFlightBound } from './modules/webhook/capture-budget.ts';
import { buildReceiver, buildServer } from './server.ts';
import { buildTestServers, type TestServers } from './testing/servers.ts';
import { withinBound } from './testing/timing.ts';

// Both packages are CommonJS: the default import is `module.exports`, and its
// `default` property is the export the type declarations describe.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const SPEC_URL = new URL('../../../packages/shared/openapi.json', import.meta.url);
const VERSION_URL = new URL('../../../VERSION', import.meta.url);
const API_CONTRACT_URL = new URL('../../../docs/API.md', import.meta.url);
const CHART_VALUES_URL = new URL('../../../deploy/helm/qa-tools/values.yaml', import.meta.url);
const PRODUCT_URL = new URL('../../../docs/PRODUCT.md', import.meta.url);

const spec = JSON.parse(readFileSync(SPEC_URL, 'utf8')) as JsonObject;

/** What the relay does with a private session's key and `--api` (#256). */
const RELAY_API_SENTENCE =
  'With `--api`, the key goes to that API as well: give it an `https:` address, or `http:` only for a QA Tools running on your own machine.';

/** The methods an OpenAPI 3.1 path item can hold. */
const OPENAPI_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * Not public (D086), not expressible in OpenAPI, or not part of the API: the
 * application listener's `410` for every `/s/...` URL, which the receive
 * operation describes as one of its answers, the receive host's own
 * `robots.txt` (D187), and the MCP endpoint, a JSON-RPC protocol of its own
 * that `tools/list` describes (D203).
 */
const UNDESCRIBED = [
  /^\/healthz$/,
  /^\/readyz$/,
  /^\/ws\//,
  /^\/s\/\*$/,
  /^\/robots\.txt$/,
  /^\/mcp$/,
];

function asObject(value: Json | undefined, where: string): JsonObject {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${where} is not an object`,
  );

  return value;
}

/** Resolves a local `$ref` such as `#/components/responses/SessionExpired`. */
function deref(value: Json | undefined, where: string): JsonObject {
  const object = asObject(value, where);
  const target = object.$ref;

  if (typeof target !== 'string') {
    return object;
  }

  assert.ok(target.startsWith('#/'), `${where}: only local references are used`);

  let current: Json | undefined = spec;

  for (const part of target.slice(2).split('/')) {
    current = asObject(current, target)[part];
  }

  return deref(current, target);
}

const SCHEMA_ROOT = 'https://qa-tools.ru/openapi.json';

/**
 * A copy of a schema whose references point into the root added to Ajv below,
 * and, when `closed`, whose every object schema listing its properties refuses
 * any other. The published schemas stay open, because clients must ignore
 * unknown fields (D154); the test closes them so that a field the server sends
 * and the description does not name is a failure.
 */
function prepare(schema: Json, closed: boolean): Json {
  if (Array.isArray(schema)) {
    return schema.map((item) => prepare(item, closed));
  }

  if (schema === null || typeof schema !== 'object') {
    return schema;
  }

  const copy: JsonObject = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string') {
      copy.$ref = value.replace('#/components/schemas/', `${SCHEMA_ROOT}#/$defs/`);
    } else if (key === 'examples' || key === 'default' || key === 'const') {
      copy[key] = value;
    } else {
      copy[key] = prepare(value, closed);
    }
  }

  if (
    closed &&
    'properties' in copy &&
    !('additionalProperties' in copy) &&
    !('unevaluatedProperties' in copy)
  ) {
    copy.additionalProperties = false;
  }

  return copy;
}

function schemaCompiler(closed: boolean) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });

  addFormats(ajv);

  const schemas = asObject(asObject(spec.components, 'components').schemas, 'schemas');
  const defs: JsonObject = {};

  for (const [name, schema] of Object.entries(schemas)) {
    defs[name] = prepare(schema, closed);
  }

  ajv.addSchema({ $id: SCHEMA_ROOT, $defs: defs });

  return (schema: Json) => ajv.compile(prepare(schema, closed) as object);
}

const compileClosed = schemaCompiler(true);

interface Operation {
  path: string;
  method: string;
  operation: JsonObject;
}

function operations(): Operation[] {
  const found: Operation[] = [];

  for (const [path, item] of Object.entries(asObject(spec.paths, 'paths'))) {
    for (const method of OPENAPI_METHODS) {
      const operation = asObject(item, path)[method];

      if (operation !== undefined) {
        found.push({ path, method, operation: asObject(operation, `${method} ${path}`) });
      }
    }
  }

  return found;
}

describe('the OpenAPI description', () => {
  it('is valid OpenAPI 3.1', async () => {
    const validator = new Validator();
    const result = await validator.validate(spec as Record<string, unknown>);

    assert.equal(validator.version, '3.1');
    assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
  });

  it('carries the product version from VERSION', () => {
    const version = readFileSync(VERSION_URL, 'utf8').trim();

    assert.equal(
      asObject(spec.info, 'info').version,
      version,
      'Set info.version in packages/shared/openapi.json to VERSION',
    );
  });

  it('is titled with the service, its contact the project (D277)', () => {
    const info = asObject(spec.info, 'info');
    const description = String(info.description);

    // `/docs` shows the title as its heading.
    assert.equal(info.title, 'Webhook Inspector API');
    assert.equal(asObject(info.contact, 'info.contact').name, 'QA Tools');
    assert.ok(description.startsWith('The public HTTP API of Webhook Inspector: '));
    // The service's own sentences no longer call it QA Tools; the project's
    // and the relay's still do, and the default answer's message is unchanged.
    for (const sentence of [
      'whether QA Tools is up',
      'QA Tools sends no requests',
      'the address QA Tools answers on',
      'QA Tools Webhook Inspector',
    ]) {
      assert.ok(!description.includes(sentence), sentence);
    }
    assert.ok(description.includes("QA Tools is a tester's personal project"));
    assert.ok(description.includes('"message": "Captured by QA Tools"'));
  });

  it('names the production server, no security and what the description must say', () => {
    assert.deepEqual(spec.servers, [{ url: 'https://qa-tools.ru' }]);
    assert.deepEqual(spec.security, []);

    const description = asObject(spec.info, 'info').description;

    assert.equal(typeof description, 'string');
    // No accounts, and a private session's key in a header (D253).
    assert.match(description as string, /No accounts/);
    assert.doesNotMatch(description as string, /No authentication/);
    assert.match(
      description as string,
      /session id is the access key, unless the session is private/,
    );
    assert.match(description as string, /Do not send production secrets/);
    assert.match(description as string, /\/ws\/\{sessionId\}/);
    // /docs is public and the repository is not: the description must stand on
    // its own rather than send a reader to docs/API.md (D155).
    assert.doesNotMatch(description as string, /docs\/API\.md|project repository/);

    // The realtime summary names every optional event and both refusals, so a
    // new event or close code cannot leave it behind.
    for (const event of NEGOTIABLE_EVENT_TYPES) {
      assert.ok((description as string).includes(`\`${event}\``), `${event} is not named`);
    }

    for (const code of Object.values(WsCloseCode)) {
      assert.ok((description as string).includes(`\`${code}\``), `close code ${code} is not named`);
    }
  });

  it('describes a private session: the create key, the key drawn once, the optional bearer scheme, private and accessKeys (D253)', () => {
    const components = asObject(spec.components, 'components');
    const schemas = asObject(components.schemas, 'schemas') as Record<
      string,
      { required?: string[]; properties?: Record<string, { type?: string }>; description?: string }
    >;

    // An optional bearer scheme, never required: `{}` beside it on every
    // operation that takes a session id, and on the creation.
    assert.deepEqual(asObject(components.securitySchemes, 'securitySchemes').accessKey, {
      type: 'http',
      scheme: 'bearer',
      description: (
        asObject(components.securitySchemes, 'securitySchemes').accessKey as {
          description: string;
        }
      ).description,
    });
    assert.deepEqual(spec.security, []);

    const paths = asObject(spec.paths, 'paths');

    for (const [path, item] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(asObject(item, path))) {
        if (typeof operation !== 'object' || operation === null || !('operationId' in operation)) {
          continue;
        }

        const keyed =
          path.startsWith('/api/sessions/{sessionId}') ||
          (path === '/api/sessions' && method === 'post');

        assert.deepEqual(
          (operation as { security?: unknown }).security,
          keyed ? [{}, { accessKey: [] }] : undefined,
          `${method.toUpperCase()} ${path}`,
        );
      }
    }

    // `private` on the create body and on both answers; the key on the
    // creation's answer alone, and never required.
    assert.equal(schemas.CreateSessionRequest?.properties?.private?.type, 'boolean');
    assert.equal(schemas.CreatedSession?.properties?.private?.type, 'boolean');
    assert.ok(schemas.CreatedSession?.required?.includes('private'));
    assert.equal(schemas.CreatedSession?.properties?.accessKey?.type, 'string');
    assert.ok(!schemas.CreatedSession?.required?.includes('accessKey'));
    assert.equal(schemas.SessionDetails?.properties?.private?.type, 'boolean');
    assert.ok(schemas.SessionDetails?.required?.includes('private'));
    assert.equal(schemas.SessionDetails?.properties?.accessKey, undefined);
    assert.doesNotMatch(schemas.SessionId?.description ?? '', /only access key/);

    // The status read documents `accessKeys` and quotes its unknown-key message.
    assert.equal(schemas.SessionStatusRequest?.properties?.accessKeys?.type, 'object');
    assert.match(schemas.SessionStatusRequest?.description ?? '', /`ids` and `accessKeys`/);

    const operation = (path: string, method: string) =>
      asObject(asObject(paths[path], path)[method], `${method} ${path}`) as { description: string };

    assert.ok(operation('/api/sessions/status', 'post').description.includes(`\`${KEYS_RULE}\``));
    assert.ok(
      JSON.stringify(operation('/api/sessions', 'post')).includes(
        JSON.stringify(CREATION_KEY_RULE),
      ),
    );

    // The introduction's section: how to create one, keep its key and present it.
    const description = asObject(spec.info, 'info').description as string;
    const start = description.indexOf('\n## Private sessions\n');
    const section = description.slice(start, description.indexOf('\n## ', start + 1));

    assert.ok(start > description.indexOf('\n## Concepts\n'), 'no Private sessions after Concepts');
    assert.ok(start < description.indexOf('\n## Custom response rules\n'));

    for (const phrase of [
      '"private": true',
      '`accessKey`',
      'answers it once',
      'Authorization: Bearer',
      '`accessKeys`',
      '`webhook-inspector.access-key.<key>`',
      '`webhook-inspector`',
      // The old names beside them until the date the changelog gives (D279).
      '`qa-tools.access-key.<key>`',
      '`qa-tools`',
      '`404` with `errorCode` `1001`',
      '`400` / `1005`',
      'SHA-256 fingerprint',
    ]) {
      assert.ok(section.includes(phrase), `the section does not say ${phrase}`);
    }

    assert.ok(
      description.includes('`WEBHOOK_INSPECTOR_ACCESS_KEY`'),
      'the relay section does not name its key',
    );
    assert.ok(
      description.includes(
        'in its old name `QA_TOOLS_ACCESS_KEY`, read when the new one is not set',
      ),
      'the relay section does not name the old variable',
    );

    // `--api` gets the key too: the relay's private-session bullet, and
    // PRODUCT.md's, say to give it `https:` (#256).
    const relay = markdownSection(description, '## Forward to a local service') ?? '';
    const bullet = relay.split('\n').find((line) => line.startsWith('- **A private session.**'));
    const product = readFileSync(PRODUCT_URL, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('- **The access key.** The session id is an argument'));

    assert.ok(bullet, 'the relay section has no private-session bullet');
    assert.ok(
      bullet.includes(RELAY_API_SENTENCE),
      'the relay section does not say where --api sends the key',
    );
    assert.ok(product, 'docs/PRODUCT.md has no relay access-key bullet');
    assert.ok(
      product.includes(RELAY_API_SENTENCE),
      'docs/PRODUCT.md does not say where --api sends the key',
    );
  });

  it('sends the webhook operations to the webhook host, and nothing else there (D187)', () => {
    // What `/docs`, `llms.txt` and `llms-full.txt` give as the webhook URL:
    // the receive operation's own server, not the description's.
    const paths = asObject(spec.paths, 'paths');

    assert.deepEqual(asObject(paths['/s/{sessionId}'], '/s/{sessionId}').servers, [
      { url: 'https://hook.qa-tools.ru' },
    ]);

    for (const [path, item] of Object.entries(paths)) {
      if (path !== '/s/{sessionId}') {
        assert.equal(asObject(item, path).servers, undefined, `${path} names a server of its own`);
      }
    }

    // The quickstart and the concepts send webhooks there and only there.
    const description = asObject(spec.info, 'info').description as string;

    assert.match(description, /https:\/\/hook\.qa-tools\.ru\/s\/\$SESSION/);
    assert.doesNotMatch(description, /https:\/\/qa-tools\.ru\/s\/\$/);
  });

  it('describes both request-id headers on every stored answer of every webhook method, and neither on an error (D279)', () => {
    const webhook = asObject(asObject(spec.paths, 'paths')['/s/{sessionId}'], '/s/{sessionId}');

    for (const method of OPENAPI_METHODS) {
      const responses = asObject(
        asObject(webhook[method], method).responses,
        `${method} responses`,
      );

      for (const [status, response] of Object.entries(responses)) {
        const headers = asObject(deref(response, status).headers ?? {}, `${method} ${status}`);
        const names = Object.keys(headers).filter((name) => /request-id/i.test(name));
        const stored = status === '200' || status === 'default';

        assert.deepEqual(
          names,
          stored ? ['X-Webhook-Inspector-Request-Id', 'X-QA-Tools-Request-Id'] : [],
          `${method} ${status}`,
        );

        if (stored) {
          assert.deepEqual(headers['X-Webhook-Inspector-Request-Id'], {
            $ref: '#/components/headers/RequestIdHeader',
          });
          assert.deepEqual(headers['X-QA-Tools-Request-Id'], {
            $ref: '#/components/headers/OldRequestIdHeader',
          });
        }
      }
    }

    const components = asObject(asObject(spec.components, 'components').headers, 'headers');

    assert.deepEqual(
      asObject(components.RequestIdHeader, 'RequestIdHeader').schema,
      asObject(components.OldRequestIdHeader, 'OldRequestIdHeader').schema,
    );
    assert.match(
      String(asObject(components.OldRequestIdHeader, 'OldRequestIdHeader').description),
      /until the date the changelog's 1\.19\.0 entry gives/,
    );
  });

  it('opens with the introduction /docs renders (issue #34)', async () => {
    const { ErrorCode } = await import('@webhook-inspector/shared');
    const description = asObject(spec.info, 'info').description as string;

    // The sections the page must carry, in this order. The quickstart's calls
    // are replayed by quickstart.test.ts.
    const headings = [
      '## Quickstart',
      '## Concepts',
      '## Custom response rules',
      '## Realtime: WebSocket `/ws/{sessionId}`',
      '## Errors',
      '## Network',
      '## Security',
      // Its policy points, in force since 1.0.0, the beta sentence's absence
      // and the two feeds are pinned with docs/API.md's and the changelog's
      // by apps/frontend/src/lib/stability-policy.test.ts (D212, D233).
      '## Stability',
    ].map((heading) => description.indexOf(`\n${heading}\n`));

    assert.ok(
      headings.every((position, index) => position > (headings[index - 1] ?? 0)),
      `the introduction's sections are missing or out of order: ${headings.join(', ')}`,
    );

    // A visible link to the file itself, same-origin wherever the page runs.
    assert.match(description, /\[Download openapi\.json\]\(\/openapi\.json\)/);

    // The concepts quote the limits the backend enforces.
    assert.match(description, new RegExp(`${SESSION_IDLE_DAYS} days after last use`));
    assert.match(description, new RegExp(`newest ${MAX_REQUESTS_PER_SESSION} requests are kept`));
    assert.equal(MAX_BODY_BYTES, 1024 * 1024);
    assert.match(description, /Payload limit: 1 MiB\*\* \(1,048,576 bytes\)/);

    // Every errorCode, with what to do about it.
    for (const [name, code] of Object.entries(ErrorCode)) {
      assert.match(
        description,
        new RegExp(`\\| \`${code}\` \\| \`${name}\` \\| \`\\d{3}\` \\| [^|]+ \\|`),
        `${code} ${name} is missing from the introduction's error table`,
      );
    }

    // The response of a running session can be changed (D150); the page must
    // not say otherwise.
    assert.match(description, /The response can be changed afterwards/);
    assert.match(description, /PUT \/api\/sessions\/\{sessionId\}\/response/);
  });

  it('names the status page before the quickstart, in the sentence docs/API.md carries (D209)', () => {
    const description = asObject(spec.info, 'info').description as string;
    const sentence = description
      .split('\n')
      .find((line) => line.includes('https://status.qa-tools.ru'));

    assert.ok(sentence !== undefined, 'the introduction does not name the status page');
    assert.ok(
      description.indexOf(sentence) < description.indexOf('\n## Quickstart\n'),
      'the status page is named after the quickstart',
    );

    for (const [what, pattern] of [
      ['whether Webhook Inspector is up', /^To check whether Webhook Inspector is up\b/],
      ['the address', /\bhttps:\/\/status\.qa-tools\.ru(?=[:/\s])/],
      ['the three services', /the site, the API and webhook receiving/],
      ['every minute', /checked every minute from outside/],
      ['the uptime history', /uptime history/],
      ['the reports', /reports of outages/],
    ] as const) {
      assert.match(sentence, pattern, `the status sentence does not state ${what}`);
    }

    // API.md wraps its lines; the description does not.
    const conventions = (
      markdownSection(readFileSync(API_CONTRACT_URL, 'utf8'), '## Conventions') ?? ''
    ).replace(/\s+/g, ' ');

    assert.ok(conventions.includes(sentence), 'docs/API.md, Conventions, has another sentence');
  });

  it('points to the about page before the quickstart, in the sentence docs/API.md carries (D211)', () => {
    const description = asObject(spec.info, 'info').description as string;
    const sentence = description
      .split('\n')
      .find((line) => line.includes('https://qa-tools.ru/about'));

    assert.ok(sentence !== undefined, 'the introduction does not point to the about page');
    assert.equal(
      sentence,
      "QA Tools is a tester's personal project, written by AI agents; who runs it, who pays for it and what happens to your data are set out at https://qa-tools.ru/about.",
    );
    assert.ok(
      description.indexOf(sentence) < description.indexOf('\n## Quickstart\n'),
      'the about page is named after the quickstart',
    );
    // A bare address, which /docs renders as a link, as it does the status page's.
    assert.match(sentence, /\bhttps:\/\/qa-tools\.ru\/about\.$/);

    // API.md wraps its lines; the description does not.
    const conventions = (
      markdownSection(readFileSync(API_CONTRACT_URL, 'utf8'), '## Conventions') ?? ''
    ).replace(/\s+/g, ' ');

    assert.ok(conventions.includes(sentence), 'docs/API.md, Conventions, has another sentence');
  });

  it('links the Terms of Use and the Privacy Policy after the about page, before the quickstart, in the sentence docs/API.md carries (D217)', () => {
    const description = asObject(spec.info, 'info').description as string;
    const sentence = description
      .split('\n')
      .find((line) => line.includes('https://qa-tools.ru/terms'));

    assert.ok(sentence !== undefined, 'the introduction does not link the Terms of Use');
    assert.equal(
      sentence,
      'By using the API or the MCP server, you agree to the Terms of Use at https://qa-tools.ru/terms, and the Privacy Policy at https://qa-tools.ru/privacy says what QA Tools stores and for how long.',
    );
    // A paragraph of its own, after the about page's and before the quickstart.
    assert.ok(description.includes(`https://qa-tools.ru/about.\n\n${sentence}\n\n## Quickstart\n`));
    // Bare addresses, which /docs renders as links: each ends before a comma
    // or a space, which a link never takes with it.
    assert.match(sentence, /\bhttps:\/\/qa-tools\.ru\/terms, /);
    assert.match(sentence, /\bhttps:\/\/qa-tools\.ru\/privacy /);

    // API.md wraps its lines; the description does not.
    const conventions = (
      markdownSection(readFileSync(API_CONTRACT_URL, 'utf8'), '## Conventions') ?? ''
    ).replace(/\s+/g, ' ');

    assert.ok(conventions.includes(sentence), 'docs/API.md, Conventions, has another sentence');
  });

  it('documents every errorCode in the error table', async () => {
    const { ErrorCode } = await import('@webhook-inspector/shared');
    const description = asObject(asObject(spec.components, 'components').schemas, 'schemas')
      .ApiError as JsonObject;

    for (const [name, code] of Object.entries(ErrorCode)) {
      assert.ok(
        (description.description as string).includes(`| \`${code}\` | \`${name}\` |`),
        `${code} ${name} is missing from the ApiError table`,
      );
    }
  });

  it('says in the introduction’s error table what a private session changed in 1001, 1005 and 1014 (D253, #256)', () => {
    const description = asObject(spec.info, 'info').description as string;

    for (const [code, phrase] of [
      [1001, 'presented another'],
      [1005, '`private`'],
      [1014, '`accessKeys`'],
    ] as const) {
      const row = description.split('\n').find((line) => line.startsWith(`| \`${code}\` |`));

      assert.ok(row, `the error table has no ${code} row`);
      assert.ok(row.includes(phrase), `the ${code} row does not say ${phrase}: ${row}`);
    }
  });

  it('tells a client to fall back to the HTTP status when errorCode is missing, in the words of ApiError (#256)', () => {
    const description = asObject(spec.info, 'info').description as string;
    const errors = markdownSection(description, '## Errors');
    const apiError = asObject(asObject(spec.components, 'components').schemas, 'schemas')
      .ApiError as JsonObject;
    // docs/API.md wraps its lines.
    const contract = readFileSync(API_CONTRACT_URL, 'utf8').replace(/\s+/g, ' ');

    assert.ok(errors, 'the introduction has no Errors section');
    assert.ok(errors.includes('fall back to the HTTP status when `errorCode` is missing.'));
    assert.ok(!errors.includes('when the field is missing'), 'the stale wording is back');
    assert.ok(
      (apiError.description as string).includes(
        'falls back to the HTTP status when `errorCode` is missing.',
      ),
    );
    assert.ok(contract.includes('fall back to the HTTP status when `errorCode` is missing.'));
    assert.ok(!contract.includes('when the field is missing'), 'docs/API.md has the stale wording');
  });

  it('describes field as an optional string, answered by a 1005 that names a place (D257)', () => {
    const description = asObject(asObject(spec.components, 'components').schemas, 'schemas')
      .ApiError as JsonObject;
    const field = asObject(asObject(description.properties, 'properties').field, 'field');

    assert.deepEqual(description.required, ['errorCode', 'message']);
    assert.equal(field.type, 'string');
    assert.deepEqual(field.examples, ['rules[1].path']);
    assert.match(description.description as string, /A `1005` that names a place/);

    // The page /docs renders says so too: the Errors section's opening
    // sentence and its 1005 row.
    const introduction = asObject(spec.info, 'info').description as string;
    const errors = markdownSection(introduction, '## Errors') ?? '';

    assert.ok(
      errors.includes(
        '\n\nEvery error the API answers is `{ "errorCode": …, "message": "…" }`, and a `1005` that names a place in the request body also carries `field`, the refused place in the notation its message begins with, such as `rules[1].path`. Branch on `errorCode`, which never changes meaning, and find the refused value by `field`; `message` is for people and its wording may change.\n\n',
      ),
      'the Errors section of the introduction opens with another sentence',
    );
    assert.match(
      errors,
      /\n\| `1005` \| `INVALID_RESPONSE_CONFIG` \| `400` \| [^|\n]*; `field` names the same place, `rules\[1\]\.path` — none for a key the body itself may not hold or for the header\. \|\n/,
    );

    // Every 1005 example carries the field the backend answers with its
    // message, which begins with it (the parsers' tests pin that), but the
    // refusal of a private creation's Authorization, which names no place.
    const examples: JsonObject[] = [];
    const collect = (value: Json | undefined): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (value !== null && typeof value === 'object') {
        const example = value.value;

        if (
          example !== null &&
          typeof example === 'object' &&
          !Array.isArray(example) &&
          example.errorCode === 1005
        ) {
          examples.push(example);
        }

        Object.values(value).forEach(collect);
      }
    };

    collect(spec.paths);

    const placed = examples.filter((example) => 'field' in example);

    assert.deepEqual(
      placed.map((example) => example.field),
      ['response.delayMs', 'response.delayMs', 'steps[1].status', 'rules[1].path'],
    );

    for (const example of examples) {
      const message = example.message as string;

      if (typeof example.field === 'string') {
        assert.ok(
          message.startsWith(`${example.field} `),
          `the example ${message} does not begin with ${example.field}`,
        );
      } else {
        assert.match(message, /^With "private": true, Authorization must be Bearer/);
      }
    }
  });

  it('states the connection bounds the server sets: the WebSocket and the webhook host, each per address (D227), and what one connection reads ahead of its answers (D229)', () => {
    const description = asObject(spec.info, 'info').description as string;
    const receive = asObject(spec.paths, 'paths')['/s/{sessionId}'] as JsonObject;
    // The receive host's bound is the backend's default, which the chart's
    // `receive.connectionsPerAddress` sets in production: the documented
    // number, or 0 while the bound is turned off - the one-line recovery
    // (runbook section 7), which changes nothing else, the contract's number
    // included, and must pass this test as it is.
    const configured = /^ {2}connectionsPerAddress: (\d+)$/m.exec(
      readFileSync(CHART_VALUES_URL, 'utf8'),
    );

    assert.ok(configured, 'the chart sets no receive.connectionsPerAddress');
    assert.ok(
      [String(MAX_RECEIVE_CONNECTIONS_PER_ADDRESS), '0'].includes(configured[1] ?? ''),
      `the chart sets receive.connectionsPerAddress ${configured[1]}, the contract ${MAX_RECEIVE_CONNECTIONS_PER_ADDRESS}`,
    );

    const perAddress = String(MAX_RECEIVE_CONNECTIONS_PER_ADDRESS);
    const next = String(MAX_RECEIVE_CONNECTIONS_PER_ADDRESS + 1);
    const nextSocket = String(MAX_REALTIME_CONNECTIONS_PER_ADDRESS + 1);

    assert.ok(
      description.includes(
        `**${perAddress} connections open at a time to \`https://hook.qa-tools.ru\`**, an IPv6 address counted by its \`/64\``,
      ),
    );
    assert.ok(description.includes(`The ${next}th is closed at once with no HTTP answer`));
    assert.ok(
      (receive.description as string).includes(
        `One address may have ${perAddress} connections open at a time to the webhook host, an IPv6 address counted by its \`/64\`; the ${next}th is closed with no HTTP answer`,
      ),
    );
    // What one connection may have read ahead of its answers (D229).
    assert.ok(
      description.includes(
        `On one connection the server reads at most **${MAX_PIPELINED_REQUESTS} requests ahead of their answers**`,
      ),
    );
    assert.ok(
      (receive.description as string).includes(
        `One connection has at most ${MAX_PIPELINED_REQUESTS} requests read and not yet answered`,
      ),
    );
    // The header lines in flight, per address and in all (D238).
    const lines = (count: number): string => count.toLocaleString('en-US');

    assert.ok(
      description.includes(
        `the server holds at most **${lines(MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS)} from one address** and ${lines(MAX_HEADER_LINES_IN_FLIGHT)} in all, an IPv6 address counted by its \`/64\`: a connection whose next line does not fit waits, unread, until lines are given back`,
      ),
    );
    assert.ok(
      (receive.description as string).includes(
        `The connections of one address have at most ${lines(MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS)} header lines read of heads not yet ended, the server ${lines(MAX_HEADER_LINES_IN_FLIGHT)}; a connection past them waits unread`,
      ),
    );
    assert.doesNotMatch(description, /pipelined burst aside/);
    // Counted by the server, not by the proxy in front of it.
    assert.doesNotMatch(description, /counted by the proxy/);
    assert.doesNotMatch(receive.description as string, /closed by the proxy/);

    for (const sentence of [
      `One address may have **${MAX_REALTIME_CONNECTIONS_PER_ADDRESS} connections open at a time**`,
      `**${MAX_REALTIME_CONNECTIONS_PER_ADDRESS} WebSocket connections open at a time**`,
      `this address already had ${MAX_REALTIME_CONNECTIONS_PER_ADDRESS} WebSocket connections open`,
    ]) {
      assert.ok(description.includes(sentence), sentence);
    }

    assert.equal(
      description.split(
        `the ${nextSocket}th is refused before it opens, \`429\` with \`errorCode\` \`1020\` and \`Retry-After: 1\``,
      ).length,
      3,
    );
    assert.doesNotMatch(description, /The WebSocket is not limited/);
  });

  it("states the answers' byte budget from the shared numbers, both reasons of 1019, and the number of attacking addresses PRODUCT.md states (#184)", () => {
    const description = asObject(spec.info, 'info').description as string;
    const mib = (bytes: number): string => `${bytes / (1024 * 1024)} MiB`;
    const perAddress = mib(API_ANSWER_PER_ADDRESS_BYTES);
    const inAll = mib(API_ANSWER_BYTES);

    assert.ok(Number.isInteger(API_ANSWER_PER_ADDRESS_BYTES / (1024 * 1024)));
    assert.ok(Number.isInteger(API_ANSWER_BYTES / (1024 * 1024)));
    assert.ok(
      description.includes(
        `The answers not yet written are bounded too, on the API and the MCP server together: **${perAddress} from one address and ${inAll} on the server**, an IPv6 address counted by its \`/64\``,
      ),
    );
    assert.ok(
      description.includes(
        'its call is answered `429`, `errorCode` `1019`, `Retry-After: 1`, in place of the answer. The call itself has been carried out',
      ),
    );

    // The error table's row: nothing done for 128 calls in flight, the call
    // carried out for an answer refused.
    const row = description.split('\n').find((line) => line.startsWith('| `1019` |'));

    assert.ok(row, 'the error table has no 1019 row');
    assert.match(
      row,
      /128 calls in flight on the API and the MCP server together, waits included: nothing was done\./,
    );
    assert.ok(
      row.includes(
        `would pass ${perAddress} of this address's answers not yet written, or ${inAll} of the server's: the call was carried out, only its answer is refused`,
      ),
      row,
    );

    // The number of attacking addresses stated is PRODUCT.md's: inferred
    // from 1.0.8, measured again since 1.14.1 (#242).
    const stated =
      /The number of attacking addresses it is stated to hold against is (\d+), the smallest measured: /.exec(
        description,
      );
    const product =
      /it is stated to survive the hostile bursts of D228 from \*\*(\d+) addresses\*\*, the smallest number measured /.exec(
        readFileSync(PRODUCT_URL, 'utf8'),
      );

    assert.ok(stated, 'the description states no number of attacking addresses');
    assert.ok(product, 'docs/PRODUCT.md states no number of attacking addresses');
    assert.equal(stated[1], product[1]);
    assert.doesNotMatch(description, /from 1 address only/);
  });

  it('compiles every schema strictly and accepts every example it gives', () => {
    const compileOpen = schemaCompiler(false);
    const schemas = asObject(asObject(spec.components, 'components').schemas, 'schemas');

    for (const [name, schema] of Object.entries(schemas)) {
      const validate = compileOpen(schema);

      for (const example of (asObject(schema, name).examples as Json[] | undefined) ?? []) {
        assert.ok(validate(example), `${name} example: ${JSON.stringify(validate.errors)}`);
      }
    }

    let checked = 0;

    for (const { path, method, operation } of operations()) {
      const media: [string, JsonObject][] = [];
      const body = operation.requestBody;

      if (body !== undefined) {
        for (const [type, content] of Object.entries(
          asObject(deref(body, 'requestBody').content, 'content'),
        )) {
          media.push([`${method} ${path} request ${type}`, asObject(content, type)]);
        }
      }

      for (const [status, response] of Object.entries(asObject(operation.responses, 'responses'))) {
        const content = deref(response, status).content;

        for (const [type, value] of Object.entries(content ? asObject(content, status) : {})) {
          media.push([`${method} ${path} ${status} ${type}`, asObject(value, type)]);
        }
      }

      for (const [where, content] of media) {
        const examples = Object.values(asObject(content.examples, `${where} examples`));

        assert.ok(examples.length > 0, `${where} has no example`);

        // Answers are checked closed, as real ones are below; requests as
        // published.
        const validate = where.includes(' request ')
          ? compileOpen(content.schema ?? {})
          : compileClosed(content.schema ?? {});

        for (const example of examples) {
          const { value } = asObject(example, where);

          assert.ok(validate(value ?? null), `${where}: ${JSON.stringify(validate.errors)}`);
          checked += 1;
        }
      }
    }

    assert.ok(checked > 0);
  });

  it('gives every operation an id and a success answer', () => {
    for (const { path, method, operation } of operations()) {
      const responses = Object.entries(asObject(operation.responses, 'responses'));
      const withExample = responses.some(([status, response]) => {
        const content = deref(response, status).content;

        return status.startsWith('2') && content !== undefined;
      });
      const bodiless = responses.some(
        ([status, response]) =>
          status.startsWith('2') && deref(response, status).content === undefined,
      );

      assert.ok(withExample || bodiless, `${method} ${path} has no success answer`);
      assert.ok(typeof operation.operationId === 'string', `${method} ${path} has no operationId`);
    }
  });

  it('describes after as a request id on both routes that take it (D196)', () => {
    const schemas = asObject(asObject(spec.components, 'components').schemas, 'schemas');
    const query = asObject(schemas.RequestQueryRequest, 'RequestQueryRequest');
    const queryAfter = asObject(asObject(query.properties, 'properties').after, 'after');
    const list = asObject(
      asObject(asObject(spec.paths, 'paths')['/api/sessions/{sessionId}/requests'], 'list').get,
      'get',
    );
    const listAfter = (list.parameters as Json[])
      .map((parameter) => deref(parameter, 'parameter'))
      .find((parameter) => parameter.name === 'after');

    for (const [where, schema] of [
      ['the query body', queryAfter],
      ['the list parameter', asObject(listAfter?.schema, 'after schema')],
    ] as const) {
      assert.equal(schema.$ref, '#/components/schemas/RequestId', where);
    }
  });

  it('describes wait as an integer of seconds from 1 to the cap, on the list alone (D200)', () => {
    const paths = asObject(spec.paths, 'paths');
    const list = asObject(asObject(paths['/api/sessions/{sessionId}/requests'], 'list').get, 'get');
    const wait = (list.parameters as Json[])
      .map((parameter) => deref(parameter, 'parameter'))
      .find((parameter) => parameter.name === 'wait');

    assert.deepEqual(asObject(wait?.schema, 'wait schema'), {
      type: 'integer',
      minimum: 1,
      maximum: REQUEST_LIST_MAX_WAIT_SECONDS,
    });
    assert.equal(wait?.in, 'query');

    const schemas = asObject(asObject(spec.components, 'components').schemas, 'schemas');
    const queryBody = asObject(schemas.RequestQueryRequest, 'RequestQueryRequest');

    assert.ok(!Object.hasOwn(asObject(queryBody.properties, 'properties'), 'wait'));
  });

  it('describes a rule’s path as the server takes it: visible ASCII, 1024 characters, no ?, * only last (D246)', () => {
    const schemas = asObject(asObject(spec.components, 'components').schemas, 'schemas');
    const rule = asObject(schemas.ResponseRuleInput, 'ResponseRuleInput');
    const validate = compileClosed(asObject(asObject(rule.properties, 'properties').path, 'path'));
    const taken = (path: string): boolean => {
      try {
        parseRules([{ method: null, path, response: { status: 200 } }]);

        return true;
      } catch (error) {
        if (error instanceof AppError) {
          return false;
        }

        throw error;
      }
    };
    const accepted = [
      '/',
      '/*',
      '/orders',
      '/items/*',
      '/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%D1%8B',
      "/!$&'()+,;=:@~-._",
      '/"#<>[\\]^`{|}%_',
      `/${'a'.repeat(MAX_RULE_PATH_BYTES - 1)}`,
      `/${'a'.repeat(MAX_RULE_PATH_BYTES - 2)}*`,
    ];
    const refused = [
      '',
      'orders',
      '*',
      '/**',
      '/*/x',
      '/a*b',
      '/?',
      '/orders?x=1',
      '/a b',
      '/a\tb',
      '/a\r\nb',
      '/a\u0000',
      '/a\u007f',
      '/café',
      '/заказы',
      '/😀',
      '/\ud800',
      '/a b',
      `/${'a'.repeat(MAX_RULE_PATH_BYTES)}`,
      `/${'a'.repeat(MAX_RULE_PATH_BYTES - 1)}*`,
    ];

    for (const path of accepted) {
      assert.equal(taken(path), true, `the server refuses ${JSON.stringify(path)}`);
      assert.equal(validate(path), true, `the description refuses ${JSON.stringify(path)}`);
    }

    for (const path of refused) {
      assert.equal(taken(path), false, `the server takes ${JSON.stringify(path.slice(0, 40))}`);
      assert.equal(
        validate(path),
        false,
        `the description takes ${JSON.stringify(path.slice(0, 40))}`,
      );
    }

    // Made-up paths at growing sizes, each ending in a different reason to
    // refuse or none: the description reads them in linear time and refuses
    // them, as the server does.
    for (const size of [MAX_RULE_PATH_BYTES, 64 * 1024, MAX_BODY_BYTES]) {
      for (const unit of ['a', '%_.', '*']) {
        for (const tail of ['', '?', '*x', ' ', 'é', '\u007f']) {
          const path = `/${unit.repeat(Math.ceil(size / unit.length))}${tail}`;
          const name = `${size} × ${JSON.stringify(unit)} + ${JSON.stringify(tail)}`;

          assert.equal(
            withinBound(500, () => validate(path)),
            false,
            name,
          );
          assert.equal(taken(path), false, name);
        }
      }
    }
  });
});

/**
 * Every IPv4 address written in a text, each once, sorted: four numbers of one
 * to three digits joined by dots, not part of a longer word or dotted number
 * such as a version `0.45.2`, a `1.2.3.4.5` or a name `1.2.3.4.example`, and
 * valid by `isIPv4`. Every quantifier is bounded, so it is linear in the text.
 */
function ipv4Addresses(text: string): string[] {
  const found = new Set<string>();

  for (const [candidate] of text.matchAll(/(?<![\w.-])\d{1,3}(?:\.\d{1,3}){3}(?![\w-]|\.\w)/g)) {
    if (isIPv4(candidate)) {
      found.add(candidate);
    }
  }

  return [...found].sort();
}

/** One `## ` section of a Markdown text, up to the next `## `; `undefined` without one. */
function markdownSection(text: string, heading: string): string | undefined {
  const start = text.indexOf(`\n${heading}\n`);

  if (start < 0) {
    return undefined;
  }

  const end = text.indexOf('\n## ', start + 1);

  return text.slice(start, end < 0 ? undefined : end);
}

describe('the published server address (D204)', () => {
  const description = asObject(spec.info, 'info').description as string;
  const published = [
    ['info.description', description],
    ['docs/API.md', readFileSync(API_CONTRACT_URL, 'utf8')],
  ] as const;

  /**
   * The server's address as the contract, `docs/API.md`, publishes it in its
   * Network section: one IPv4 address, or two while a move is announced. The
   * record of the server itself is kept with its operations, outside this
   * repository; a move to another server changes it and both places checked
   * here.
   */
  function recorded(): string[] {
    const section = markdownSection(readFileSync(API_CONTRACT_URL, 'utf8'), '## Network');

    assert.ok(section !== undefined, 'docs/API.md has no "## Network" section');

    const addresses = ipv4Addresses(section);

    assert.ok(addresses.length > 0, 'the Network section of docs/API.md names no IPv4 address');
    assert.ok(
      addresses.length <= 2,
      `the Network section of docs/API.md names ${addresses.join(', ')}: one address, ` +
        'or two while a move is announced (D204)',
    );

    return addresses;
  }

  it('is the address docs/API.md publishes for the server, and no other', () => {
    const server = recorded();
    const section = markdownSection(description, '## Network');

    assert.ok(section !== undefined, 'info.description has no "## Network" section');

    const named = ipv4Addresses(section);

    assert.deepEqual(
      named,
      server,
      `the Network section of info.description names ${named.join(', ') || 'no address'}, and ` +
        `docs/API.md publishes ${server.join(', ')} for the server: change both (D204)`,
    );
  });

  it('states the hosts, the port, IPv4 only, no CDN, no requests to users and the notice', () => {
    for (const [where, text] of published) {
      // API.md wraps its lines; the description does not.
      const section = (markdownSection(text, '## Network') ?? '').replace(/\s+/g, ' ');

      for (const [what, pattern] of [
        ['the site host', /`qa-tools\.ru`/],
        ['the webhook host', /`hook\.qa-tools\.ru`/],
        // The site's second host, where it moves (#319, D275).
        ['the second site host', /`webhook\.qa-tools\.ru`/],
        ['the move and the changelog entry that dates it', /Moving to `webhook\.qa-tools\.ru`/],
        ['HTTPS on TCP port 443', /HTTPS on TCP port 443/],
        ["port 80's redirect", /Port 80 only redirects plain HTTP to HTTPS, with a `301`/],
        ['IPv4 only', /IPv4 only\.\*\* No host has an IPv6\b/],
        ['no CDN', /No CDN or proxy service in front/],
        ['no requests to users', /Webhook Inspector sends no requests to your systems/],
        ['14 days of notice', /announced at least 14 days ahead/],
        ['the emergency exception', /emergency recovery after losing the server/],
        ['the changelog', /https:\/\/qa-tools\.ru\/changelog\b/],
      ] as const) {
        assert.match(section, pattern, `the Network section of ${where} does not state ${what}`);
      }
    }
  });

  it('reads addresses as written, nothing longer and nothing invalid, in linear time', () => {
    assert.deepEqual(ipv4Addresses('on `80.87.198.166`, then 10.0.0.1. And 10.0.0.1'), [
      '10.0.0.1',
      '80.87.198.166',
    ]);

    for (const text of [
      '0.45.2',
      '1.2.3.4.5',
      'v1.2.3.4',
      '1.2.3.4.example',
      '1.2.3.4-rc',
      '256.1.1.1',
      '1234.1.1.1',
      '1.2.3',
      '1..2.3.4',
    ]) {
      assert.deepEqual(ipv4Addresses(text), [], text);
    }

    // Long runs of what an address is made of, at growing sizes.
    for (const size of [1_000, 100_000, 1_000_000]) {
      assert.deepEqual(ipv4Addresses(`${'1.'.repeat(size)}1`), []);
      assert.deepEqual(ipv4Addresses('9'.repeat(size)), []);
      assert.deepEqual(ipv4Addresses(`${'.'.repeat(size)}1.2.3.4`), []);
      assert.deepEqual(ipv4Addresses('1.2.3.4 '.repeat(size / 10)), ['1.2.3.4']);
    }
  });
});

describe('the OpenAPI description against the server', () => {
  let pool: pg.Pool;
  let servers: TestServers;
  /** The application listener. */
  let app: FastifyInstance;
  /** The receive listener, which serves the webhook operations (D187). */
  let receiver: FastifyInstance;
  const registered: { url: string; methods: string[] }[] = [];
  const createdSessionIds: string[] = [];
  const exercised = new Set<string>();

  before(async () => {
    pool = createPool(loadConfig().databaseUrl);
    // Both listeners, so that the routes of the two together are what is
    // compared with the description.
    servers = buildTestServers(pool, {
      logDestination: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      onRoute: (route) => {
        registered.push({
          url: route.url,
          methods: ([] as string[]).concat(route.method).map((method) => method.toUpperCase()),
        });
      },
    });
    ({ api: app, receiver } = servers);
    await servers.ready();
  });

  after(async () => {
    if (createdSessionIds.length > 0) {
      await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
    }

    await servers?.close();
    await pool.end();
  });

  it('describes exactly the routes the server registers', () => {
    // `/s/:sessionId/` is the same endpoint as `/s/:sessionId` (D063), and so
    // is `/s/:sessionId/*`, any path under it (D173): neither a trailing slash
    // nor a sub-path is a path of its own, and `/s/{sessionId}` describes all
    // three. OpenAPI has no wildcard path to describe the third with.
    const normalise = (url: string) =>
      url
        .replace(/:([A-Za-z]+)/g, '{$1}')
        .replace(/\/\*$/, '')
        .replace(/(.)\/$/, '$1');
    const server = new Map<string, Set<string>>();

    for (const { url, methods } of registered) {
      if (UNDESCRIBED.some((pattern) => pattern.test(url))) {
        continue;
      }

      const path = normalise(url);
      const known = server.get(path) ?? new Set<string>();

      methods.forEach((method) => known.add(method));
      server.set(path, known);
    }

    const described = asObject(spec.paths, 'paths');

    assert.deepEqual(
      Object.keys(described).sort(),
      [...server.keys()].sort(),
      'the described paths and the registered routes differ',
    );

    for (const [path, methods] of server) {
      const item = asObject(described[path], path);
      const itemMethods = OPENAPI_METHODS.filter((method) => item[method] !== undefined).map(
        (method) => method.toUpperCase(),
      );
      const text = `${String(item.description ?? '')}`;

      for (const method of itemMethods) {
        assert.ok(methods.has(method), `${method} ${path} is described but not registered`);
      }

      for (const method of methods) {
        if (OPENAPI_METHODS.includes(method.toLowerCase())) {
          // Fastify answers HEAD for every GET route on its own.
          const implicitHead = method === 'HEAD' && itemMethods.includes('GET');

          assert.ok(
            itemMethods.includes(method) || implicitHead,
            `${method} ${path} is registered but not described`,
          );
        } else {
          // OpenAPI 3.1 has no field for this method, so the path names it.
          assert.ok(text.includes(`\`${method}\``), `${method} ${path} is not named`);
        }
      }
    }

    for (const pattern of ['/healthz', '/readyz']) {
      assert.equal(described[pattern], undefined, `${pattern} must not be described`);
    }
  });

  it('matches every real answer against the schema described for its status', async () => {
    type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

    /**
     * Checks one answer against the operation that describes it: the status is
     * described (or `default` covers it), its body validates, the declared
     * headers validate, and an error's `errorCode` is one the description gives
     * as an example for that status.
     */
    const check = (response: Injected, path: string, method: string) => {
      const item = asObject(asObject(spec.paths, 'paths')[path], path);
      const operation = asObject(item[method], `${method} ${path}`);
      const responses = asObject(operation.responses, `${method} ${path} responses`);
      const status = String(response.statusCode);
      const where = `${method.toUpperCase()} ${path} answered ${status}`;
      const described = responses[status] ?? responses.default;

      assert.ok(described !== undefined, `${where}, which is not described`);

      const answer = deref(described, where);

      exercised.add(`${method} ${path}`);

      // Every answer of a limited route carries the limit's three headers,
      // errors included, and the description says so (D201).
      if (path.startsWith('/api/')) {
        for (const name of ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']) {
          assert.ok(response.headers[name.toLowerCase()] !== undefined, `${where} without ${name}`);
          assert.ok(
            answer.headers !== undefined && asObject(answer.headers, where)[name] !== undefined,
            `${where}: ${name} is not described`,
          );
        }
      }

      for (const [name, header] of Object.entries(
        answer.headers ? asObject(answer.headers, `${where} headers`) : {},
      )) {
        const value = response.headers[name.toLowerCase()];
        const schema = deref(header, name).schema ?? {};

        if (
          name === 'X-Webhook-Inspector-Request-Id' ||
          name === 'X-QA-Tools-Request-Id' ||
          name === 'X-Content-Type-Options' ||
          name === 'Content-Security-Policy'
        ) {
          assert.ok(value !== undefined, `${where} without ${name}`);
        }

        if (value !== undefined) {
          const validate = compileClosed(schema);
          // A header is text on the wire: one described as an integer is
          // compared as the number its decimal digits spell, and anything
          // else is compared as the text it is, which such a schema refuses.
          const typed =
            asObject(schema, name).type === 'integer' && /^\d+$/.test(String(value))
              ? Number(value)
              : value;

          assert.ok(validate(typed), `${where}, ${name}: ${JSON.stringify(validate.errors)}`);
        }
      }

      // An injected HEAD answer still holds the body Node leaves off the wire,
      // so there is nothing to compare it with.
      if (method === 'head') {
        return;
      }

      if (answer.content === undefined) {
        assert.equal(response.body, '', `${where} with a body the description does not give`);

        return;
      }

      // A custom session with no configured body, or with 204, 205 or 304,
      // sends none: `default` says so.
      if (responses[status] === undefined && response.body === '') {
        assert.equal(response.body, '', `${where} with a body`);

        return;
      }

      const content = asObject(answer.content, where)['application/json'];

      assert.ok(content !== undefined, `${where}: no application/json content described`);
      assert.match(String(response.headers['content-type']), /^application\/json/);

      const body = response.json() as Json;
      const described_ = asObject(content, where);
      const validate = compileClosed(described_.schema ?? {});

      assert.ok(validate(body), `${where}: ${JSON.stringify(validate.errors)} in ${response.body}`);

      const schemaRef = asObject(described_.schema ?? {}, where).$ref;

      if (schemaRef === '#/components/schemas/ApiError') {
        const codes = Object.values(asObject(described_.examples, `${where} examples`)).map(
          (example) => asObject(asObject(example, where).value, where).errorCode,
        );
        const { errorCode } = asObject(body, where);

        assert.ok(
          codes.includes(errorCode),
          `${where} with errorCode ${JSON.stringify(body)}, which it does not document`,
        );

        // A refusal by a limit says when to call again (D201, D213), and so
        // does a search or a query refused for a place (D250).
        if ([1012, 1015, 1016, 1017, 1018, 1019].includes(errorCode as number)) {
          assert.ok(response.headers['retry-after'] !== undefined, `${where} without Retry-After`);
        }
      }
    };

    const json = { 'content-type': 'application/json' };
    const create = async (payload?: Json) => {
      const response =
        payload === undefined
          ? await app.inject({ method: 'POST', url: '/api/sessions' })
          : await app.inject({
              method: 'POST',
              url: '/api/sessions',
              headers: json,
              payload: JSON.stringify(payload),
            });

      check(response, '/api/sessions', 'post');
      assert.equal(response.statusCode, 201);

      const { id } = response.json() as { id: string };

      createdSessionIds.push(id);

      return id;
    };

    const defaultId = await create();
    const customId = await create({
      response: { status: 201, headers: [['x-trace-id', 'abc']], body: '{"a":1}', delayMs: 0 },
    });
    const emptyId = await create({ response: { status: 204 } });
    const expiredId = await create({});
    // A lifetime alone, and beside a response and a queue (D220).
    const lifetimeId = await create({ expiresInSeconds: 3600 });
    const fullId = await create({
      response: { status: 200 },
      queue: { steps: [{ status: 503 }] },
      expiresInSeconds: 60,
    });
    // A private session, its key drawn and answered once, and one under a
    // key sent (D253): both answers against the schema.
    const drawn = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: json,
      payload: '{"private":true}',
    });

    check(drawn, '/api/sessions', 'post');
    assert.equal(typeof drawn.json<{ accessKey?: string }>().accessKey, 'string');
    createdSessionIds.push(drawn.json<{ id: string }>().id);

    const privateKey = drawn.json<{ accessKey: string }>().accessKey;
    const underKey = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { ...json, authorization: `Bearer ${privateKey}` },
      payload: '{"private":true}',
    });

    check(underKey, '/api/sessions', 'post');
    assert.equal(underKey.statusCode, 201);
    createdSessionIds.push(underKey.json<{ id: string }>().id);
    check(
      await app.inject({
        method: 'GET',
        url: `/api/sessions/${underKey.json<{ id: string }>().id}`,
        headers: { authorization: `Bearer ${privateKey}` },
      }),
      '/api/sessions/{sessionId}',
      'get',
    );
    const unknownId = 'z'.repeat(43);
    const tooLarge = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);

    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      expiredId,
    ]);

    // Create: every refusal a client can provoke.
    for (const [headers, payload] of [
      [{ 'content-type': 'text/plain' }, 'x'],
      [json, '[]'],
      [json, '{"response":{"status":100}}'],
      [json, '{"queue":{"steps":[]}}'],
      [json, '{"expiresInSeconds":59}'],
      [json, '{"expiresInSeconds":null}'],
      [json, '{"private":"true"}'],
      [{ ...json, authorization: 'Basic x' }, '{"private":true}'],
      [json, tooLarge],
    ] as const) {
      check(
        await app.inject({ method: 'POST', url: '/api/sessions', headers, payload }),
        '/api/sessions',
        'post',
      );
    }

    // Read a session.
    for (const id of [defaultId, customId, lifetimeId, fullId, unknownId, expiredId]) {
      check(
        await app.inject({ method: 'GET', url: `/api/sessions/${id}` }),
        '/api/sessions/{sessionId}',
        'get',
      );
    }

    // Read the status of sessions (D199), every state, and every refusal.
    const statusPath = '/api/sessions/status';
    const statusOf = (payload: string | Buffer, headers: Record<string, string> = json) =>
      app.inject({ method: 'POST', url: statusPath, headers, payload });
    const statuses = await statusOf(JSON.stringify({ ids: [defaultId, expiredId, unknownId] }));

    check(statuses, statusPath, 'post');
    assert.equal(statuses.statusCode, 200);
    // The expired session is `not_found` instead once another test file's
    // sweep of the cleanup has removed it; both entries are described.
    const [active, expired, unknown] = (
      statuses.json() as { sessions: { state: string }[] }
    ).sessions.map((entry) => entry.state);

    assert.deepEqual([active, unknown], ['active', 'not_found']);
    assert.ok(expired === 'expired' || expired === 'not_found', expired);
    // A session with a lifetime, whose lastUsedAt is read another way (D220).
    check(await statusOf(JSON.stringify({ ids: [lifetimeId, fullId] })), statusPath, 'post');
    check(await statusOf('{"ids":[]}'), statusPath, 'post');
    check(await statusOf(JSON.stringify({ ids: [defaultId, defaultId] })), statusPath, 'post');
    check(await statusOf('not json'), statusPath, 'post');
    check(await statusOf('x', { 'content-type': 'text/plain' }), statusPath, 'post');
    check(await statusOf(tooLarge), statusPath, 'post');

    // Change its response, and every refusal.
    const change = (id: string, payload: string | Buffer, headers: Record<string, string> = json) =>
      app.inject({ method: 'PUT', url: `/api/sessions/${id}/response`, headers, payload });
    const changePath = '/api/sessions/{sessionId}/response';
    const changed = await change(customId, '{"mode":"default"}');

    check(changed, changePath, 'put');
    assert.equal(changed.statusCode, 200);
    check(
      await change(
        customId,
        '{"mode":"custom","response":{"status":201,"headers":[["x-trace-id","abc"]],"body":"{\\"a\\":1}"}}',
      ),
      changePath,
      'put',
    );
    check(await change(defaultId, '{"mode":"sideways"}'), changePath, 'put');
    check(await change(defaultId, 'not json'), changePath, 'put');
    check(await change(defaultId, 'x', { 'content-type': 'text/plain' }), changePath, 'put');
    check(await change(defaultId, tooLarge), changePath, 'put');
    check(await change(unknownId, '{"mode":"default"}'), changePath, 'put');
    check(await change(expiredId, '{"mode":"default"}'), changePath, 'put');

    // The response queue (D205): set, restart and remove, and every refusal.
    const queuePath = '/api/sessions/{sessionId}/queue';
    const restartPath = '/api/sessions/{sessionId}/queue/restart';
    const setQueue = (
      id: string,
      payload: string | Buffer,
      headers: Record<string, string> = json,
    ) => app.inject({ method: 'PUT', url: `/api/sessions/${id}/queue`, headers, payload });
    const queueId = await create({
      response: { status: 200 },
      queue: { steps: [{ status: 503, headers: [['retry-after', '1']] }, { status: 202 }] },
    });
    // Steps of 2xx, so the receiver's answers below stay under 300.
    const saved = await setQueue(
      customId,
      '{"steps":[{"status":202,"headers":[["retry-after","1"]]},{"status":201,"body":"{\\"step\\":2}"}]}',
    );

    check(saved, queuePath, 'put');
    assert.equal(saved.statusCode, 200);
    check(await setQueue(customId, '{"steps":[]}'), queuePath, 'put');
    check(await setQueue(customId, '{"steps":[{"status":600}]}'), queuePath, 'put');
    check(await setQueue(customId, 'not json'), queuePath, 'put');
    check(await setQueue(customId, 'x', { 'content-type': 'text/plain' }), queuePath, 'put');
    check(await setQueue(customId, tooLarge), queuePath, 'put');
    check(await setQueue(unknownId, '{"steps":[{"status":503}]}'), queuePath, 'put');
    check(await setQueue(expiredId, '{"steps":[{"status":503}]}'), queuePath, 'put');

    for (const [method, url, path] of [
      ['POST', 'queue/restart', restartPath],
      ['DELETE', 'queue', queuePath],
    ] as const) {
      const call = (id: string, extra = {}) =>
        app.inject({ method, url: `/api/sessions/${id}/${url}`, ...extra });
      const verb = method === 'POST' ? 'post' : 'delete';

      check(await call(queueId), path, verb);
      check(await call(unknownId), path, verb);
      check(await call(expiredId), path, verb);
      check(await call(queueId, { headers: json, payload: '{' }), path, verb);
      check(
        await call(queueId, { headers: { 'content-type': 'application/xml' }, payload: '<x/>' }),
        path,
        verb,
      );
      check(
        await call(queueId, { headers: { 'content-type': 'text/plain' }, payload: tooLarge }),
        path,
        verb,
      );
    }

    // A session with a queue, read back with it.
    check(
      await app.inject({ method: 'GET', url: `/api/sessions/${customId}` }),
      '/api/sessions/{sessionId}',
      'get',
    );

    // The receiver, with every method OpenAPI can name, on each kind of session.
    const receiverPath = '/s/{sessionId}';
    const receive = (method: string, id: string, suffix = '', payload?: string | Buffer) =>
      receiver.inject({
        method: method as 'GET',
        url: `/s/${id}${suffix}`,
        ...(payload === undefined ? {} : { payload, headers: { 'content-type': 'text/plain' } }),
      });

    for (const method of OPENAPI_METHODS) {
      const payload = method === 'get' || method === 'head' ? undefined : '{"event":"x"}';

      for (const id of [defaultId, customId, emptyId]) {
        const answer = await receive(method.toUpperCase(), id, '', payload);

        check(answer, receiverPath, method);
        assert.ok(answer.statusCode < 300, `${method} /s/ answered ${answer.statusCode}`);
      }
    }

    // A method OpenAPI 3.1 cannot name is answered as POST is.
    check(await receive('PROPFIND', defaultId, '', '<x/>'), receiverPath, 'post');
    check(await receive('POST', defaultId, '/'), receiverPath, 'post');
    check(await receive('POST', defaultId, '/extra'), receiverPath, 'post');
    check(await receive('PROPFIND', customId, '/folder/', '<x/>'), receiverPath, 'post');
    check(await receive('POST', unknownId), receiverPath, 'post');
    check(await receive('POST', unknownId, '/extra'), receiverPath, 'post');
    check(await receive('POST', expiredId, '/extra'), receiverPath, 'post');
    check(await receive('POST', expiredId), receiverPath, 'post');
    check(await receive('POST', defaultId, '', tooLarge), receiverPath, 'post');

    // The same path on the application listener, which stopped receiving in
    // 0.36.0: its `410` / `1009` is one of the receive operation's answers.
    for (const method of ['POST', 'GET', 'PROPFIND']) {
      const moved = await app.inject({ method: method as 'GET', url: `/s/${defaultId}/extra` });

      assert.equal(moved.statusCode, 410);
      check(moved, receiverPath, method === 'GET' ? 'get' : 'post');
    }

    // The response rules (D246): set, and every refusal one call can
    // provoke; a session created with them, read back with them; webhooks the
    // rules answer, listed and read with the rule that answered.
    const rulesPath = '/api/sessions/{sessionId}/rules';
    const setRules = (
      id: string,
      payload: string | Buffer,
      headers: Record<string, string> = json,
    ) => app.inject({ method: 'PUT', url: `/api/sessions/${id}/rules`, headers, payload });
    const rulesId = await create({
      rules: [{ method: 'POST', path: '/orders', response: { status: 201, body: '{"id":42}' } }],
    });
    const savedRules = await setRules(
      rulesId,
      JSON.stringify({
        rules: [
          {
            method: 'POST',
            path: '/orders',
            response: { status: 201, headers: [['x-rule', '1']], body: '{"id":42}' },
          },
          { method: null, path: '/items/*', response: { status: 202 } },
        ],
      }),
    );

    check(savedRules, rulesPath, 'put');
    assert.equal(savedRules.statusCode, 200);
    check(
      await setRules(
        rulesId,
        JSON.stringify({ rules: Array.from({ length: 21 }, () => ({ method: null, path: '/' })) }),
      ),
      rulesPath,
      'put',
    );
    check(
      await setRules(
        rulesId,
        '{"rules":[{"method":"CONNECT","path":"/","response":{"status":200}}]}',
      ),
      rulesPath,
      'put',
    );
    check(await setRules(rulesId, 'not json'), rulesPath, 'put');
    check(await setRules(rulesId, 'x', { 'content-type': 'text/plain' }), rulesPath, 'put');
    check(await setRules(rulesId, tooLarge), rulesPath, 'put');
    check(await setRules(unknownId, '{"rules":[]}'), rulesPath, 'put');
    check(await setRules(expiredId, '{"rules":[]}'), rulesPath, 'put');
    check(
      await app.inject({ method: 'GET', url: `/api/sessions/${rulesId}` }),
      '/api/sessions/{sessionId}',
      'get',
    );

    const ruled = await receive('POST', rulesId, '/orders', '{"item":1}');

    check(ruled, receiverPath, 'post');
    assert.equal(ruled.statusCode, 201);
    check(await receive('DELETE', rulesId, '/items/1'), receiverPath, 'delete');
    check(await receive('GET', rulesId, '/orders'), receiverPath, 'get');

    // Requests: list, read, delete one, clear, and the refusals.
    const listPath = '/api/sessions/{sessionId}/requests';
    const onePath = '/api/sessions/{sessionId}/requests/{requestId}';

    check(
      await app.inject({ method: 'GET', url: `/api/sessions/${rulesId}/requests` }),
      listPath,
      'get',
    );

    const ruledDetail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${rulesId}/requests/${String(ruled.headers['x-qa-tools-request-id'])}`,
    });

    check(ruledDetail, onePath, 'get');
    assert.deepEqual((ruledDetail.json() as { response: { rule: unknown } }).response.rule, {
      index: 1,
      method: 'POST',
      path: '/orders',
    });

    for (const id of [defaultId, customId, unknownId, expiredId]) {
      check(
        await app.inject({ method: 'GET', url: `/api/sessions/${id}/requests` }),
        listPath,
        'get',
      );
    }

    // Search the raw requests (D191), and every refusal one call can provoke.
    // `429` / `1012` takes three searches at once and `503` / `1011` a search
    // slower than its timeout: `request-search.test.ts` provokes both and pins
    // their bodies, which are the examples the description gives.
    const searchPath = '/api/sessions/{sessionId}/requests/search';
    const searchFor = (
      id: string,
      payload: string | Buffer,
      headers: Record<string, string> = json,
    ) =>
      app.inject({ method: 'POST', url: `/api/sessions/${id}/requests/search`, headers, payload });
    const searched = await searchFor(customId, '{"words":["event","no such text"]}');

    check(searched, searchPath, 'post');
    assert.equal(searched.statusCode, 200);
    // Every request captured above holds the first word, none the second.
    assert.ok((searched.json() as { matches: string[][] }).matches[0]?.length);
    assert.deepEqual((searched.json() as { matches: string[][] }).matches[1], []);
    check(await searchFor(customId, '{"words":["ab"]}'), searchPath, 'post');
    check(await searchFor(customId, '{"words":["abc"],"other":1}'), searchPath, 'post');
    check(await searchFor(customId, 'not json'), searchPath, 'post');
    check(await searchFor(customId, '["abc"]'), searchPath, 'post');
    check(await searchFor(customId, 'x', { 'content-type': 'text/plain' }), searchPath, 'post');
    check(await searchFor(customId, tooLarge), searchPath, 'post');
    check(await searchFor(unknownId, '{"words":["abc"]}'), searchPath, 'post');
    check(await searchFor(expiredId, '{"words":["abc"]}'), searchPath, 'post');

    // The list's parameters (D196): every field `include` adds is described,
    // and so is every refusal. The closed schema fails a field it does not name.
    const listWith = (id: string, parameters: string) =>
      app.inject({ method: 'GET', url: `/api/sessions/${id}/requests?${parameters}` });
    const withContent = await listWith(customId, 'include=headers,body&order=asc&limit=3');

    check(withContent, listPath, 'get');
    assert.equal(withContent.statusCode, 200);
    assert.ok((withContent.json() as { headers?: unknown; body?: unknown }[]).length > 0);

    for (const parameters of [
      'include=headers',
      'include=body',
      'since=2026-01-01T00:00:00Z',
      'limit=0',
      'unknown=1',
      'limit=5&limit=5',
      'include=body&limit=21',
      `after=${'00000000-0000-4000-8000-000000000000'}`,
      'after=not-a-uuid',
      // `wait` (D200): answered at once, since the session holds requests,
      // and refused when invalid or with `since`.
      'wait=1',
      'wait=30&include=headers,body&order=asc&limit=1',
      'wait=0',
      'wait=31',
      'wait=1&since=2026-01-01T00:00:00Z',
      `wait=1&after=${'00000000-0000-4000-8000-000000000000'}`,
    ]) {
      check(await listWith(customId, parameters), listPath, 'get');
    }

    // A wait whose time runs out answers `[]`.
    const waited = await listWith(await create(), 'wait=1');

    check(waited, listPath, 'get');
    assert.deepEqual(waited.json(), []);

    check(await listWith(unknownId, 'include=body'), listPath, 'get');
    check(await listWith(expiredId, 'include=body'), listPath, 'get');

    // The query of requests (D196), and every refusal one call can provoke;
    // `request-list.test.ts` provokes its `429` and `503`.
    const queryPath = '/api/sessions/{sessionId}/requests/query';
    const queryFor = (
      id: string,
      payload: string | Buffer,
      headers: Record<string, string> = json,
    ) =>
      app.inject({ method: 'POST', url: `/api/sessions/${id}/requests/query`, headers, payload });
    const queried = await queryFor(
      customId,
      '{"headers":[{"name":"Content-Type","value":"text/plain"}],"body":["event"],"include":["headers","body"]}',
    );

    check(queried, queryPath, 'post');
    assert.equal(queried.statusCode, 200);
    assert.ok((queried.json() as unknown[]).length > 0);
    check(await queryFor(customId, '{}'), queryPath, 'post');
    check(await queryFor(customId, '{"body":["ab"]}'), queryPath, 'post');
    check(await queryFor(customId, '{"other":1}'), queryPath, 'post');
    check(await queryFor(customId, 'not json'), queryPath, 'post');
    check(await queryFor(customId, '[]'), queryPath, 'post');
    check(await queryFor(customId, '{"after":"not-a-uuid"}'), queryPath, 'post');
    check(await queryFor(customId, 'x', { 'content-type': 'text/plain' }), queryPath, 'post');
    check(await queryFor(customId, tooLarge), queryPath, 'post');
    check(await queryFor(unknownId, '{}'), queryPath, 'post');
    check(await queryFor(expiredId, '{}'), queryPath, 'post');

    const listed = (
      await app.inject({ method: 'GET', url: `/api/sessions/${customId}/requests` })
    ).json() as { id: string }[];
    const [first, second] = listed;

    assert.ok(first !== undefined && second !== undefined);

    for (const requestId of [first.id, 'not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      check(
        await app.inject({ method: 'GET', url: `/api/sessions/${customId}/requests/${requestId}` }),
        onePath,
        'get',
      );
    }

    check(
      await app.inject({ method: 'GET', url: `/api/sessions/${unknownId}/requests/${first.id}` }),
      onePath,
      'get',
    );
    check(
      await app.inject({ method: 'GET', url: `/api/sessions/${expiredId}/requests/${first.id}` }),
      onePath,
      'get',
    );

    const deleteOne = (id: string, requestId: string, extra = {}) =>
      app.inject({ method: 'DELETE', url: `/api/sessions/${id}/requests/${requestId}`, ...extra });

    check(await deleteOne(customId, first.id), onePath, 'delete');
    check(await deleteOne(customId, first.id), onePath, 'delete');
    check(await deleteOne(unknownId, second.id), onePath, 'delete');
    check(await deleteOne(expiredId, second.id), onePath, 'delete');
    check(await deleteOne(customId, second.id, { headers: json, payload: '{' }), onePath, 'delete');
    check(
      await deleteOne(customId, second.id, {
        headers: { 'content-type': 'application/xml' },
        payload: '<x/>',
      }),
      onePath,
      'delete',
    );

    const tooLargeDelete = await deleteOne(customId, second.id, {
      headers: { 'content-type': 'text/plain' },
      payload: tooLarge,
    });

    check(tooLargeDelete, onePath, 'delete');
    assert.equal(tooLargeDelete.statusCode, 413);

    const clear = (id: string, extra = {}) =>
      app.inject({ method: 'DELETE', url: `/api/sessions/${id}/requests`, ...extra });

    check(await clear(customId, { headers: json, payload: '{' }), listPath, 'delete');
    check(
      await clear(customId, { headers: { 'content-type': 'application/xml' }, payload: '<x/>' }),
      listPath,
      'delete',
    );
    check(
      await clear(customId, { headers: { 'content-type': 'text/plain' }, payload: tooLarge }),
      listPath,
      'delete',
    );
    check(await clear(customId), listPath, 'delete');
    check(await clear(unknownId), listPath, 'delete');
    check(await clear(expiredId), listPath, 'delete');

    // Delete a whole session (D198), and every refusal: a body sent anyway,
    // an expired session, an unknown one and the same one a second time.
    const sessionPath = '/api/sessions/{sessionId}';
    const removeSession = (id: string, extra = {}) =>
      app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, ...extra });

    check(await removeSession(defaultId, { headers: json, payload: '{' }), sessionPath, 'delete');
    check(
      await removeSession(defaultId, {
        headers: { 'content-type': 'application/xml' },
        payload: '<x/>',
      }),
      sessionPath,
      'delete',
    );
    check(
      await removeSession(defaultId, {
        headers: { 'content-type': 'text/plain' },
        payload: tooLarge,
      }),
      sessionPath,
      'delete',
    );
    check(await removeSession(expiredId), sessionPath, 'delete');
    check(await removeSession(unknownId), sessionPath, 'delete');

    const removed = await removeSession(defaultId);

    check(removed, sessionPath, 'delete');
    assert.equal(removed.statusCode, 204);
    check(await removeSession(defaultId), sessionPath, 'delete');

    // The limits (D201). On a listener allowing one session creation and one
    // other call a minute, every operation under `/api` is refused `429` /
    // `1015` once its kind is used up; on one with no place for a list with
    // bodies, both lists with bodies are `429` / `1016`, and with no place for
    // a large body, a large body of each of the six routes that read one is
    // `429` / `1017` (D205, D213); on one with no place for a call in flight,
    // every operation under `/api` is `429` / `1019` (D213).
    const quiet = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
    const limited = buildServer(pool, {
      logDestination: quiet(),
      rateLimits: { sessionCreates: 1, apiCalls: 1 },
    });
    const busy = buildServer(pool, {
      logDestination: quiet(),
      bodyListPlaces: createBodyListPlaces(0),
      largeBodyPlaces: createLargeBodyPlaces(0),
    });
    const inFlight = buildServer(pool, {
      logDestination: quiet(),
      callPlaces: createCallPlaces(0),
    });
    // No place for a search, nor for a query of either kind (D191, D250).
    const searchesBusy = buildServer(pool, {
      logDestination: quiet(),
      querySlots: createQuerySlots(createSearchSlots(0), 0),
    });

    try {
      const firstCreate = await limited.inject({ method: 'POST', url: '/api/sessions' });

      assert.equal(firstCreate.statusCode, 201);
      createdSessionIds.push((firstCreate.json() as { id: string }).id);
      assert.equal(
        (await limited.inject({ method: 'GET', url: `/api/sessions/${unknownId}` })).statusCode,
        404,
      );

      for (const { path, method } of operations()) {
        if (!path.startsWith('/api/')) {
          continue;
        }

        const url = path
          .replace('{sessionId}', customId)
          .replace('{requestId}', '00000000-0000-4000-8000-000000000000');
        const refused = await limited.inject({
          method: method.toUpperCase() as 'GET',
          url,
          ...(method === 'post' || method === 'put' ? { headers: json, payload: '{}' } : {}),
        });

        assert.equal(refused.statusCode, 429, `${method} ${path}`);
        check(refused, path, method);
      }

      const listBusy = await busy.inject({
        method: 'GET',
        url: `/api/sessions/${customId}/requests?include=body`,
      });

      assert.equal(listBusy.statusCode, 429);
      check(listBusy, listPath, 'get');

      const queryBusy = await busy.inject({
        method: 'POST',
        url: `/api/sessions/${customId}/requests/query`,
        headers: json,
        payload: '{"include":["headers","body"]}',
      });

      assert.equal(queryBusy.statusCode, 429);
      check(queryBusy, queryPath, 'post');

      // Every place of the search's and of the header-only queries' taken:
      // `429` / `1012` with `Retry-After: 1`, from both counts (D250).
      for (const [path, payload] of [
        [searchPath, '{"words":["abc"]}'],
        [queryPath, '{"body":["abc"]}'],
        [queryPath, '{"headers":[{"name":"x-merchant-id","value":"123"}],"body":["abc"]}'],
        [queryPath, '{"headers":[{"name":"x-merchant-id","value":"123"}]}'],
        [queryPath, '{"headers":[]}'],
        [queryPath, '{}'],
      ] as const) {
        const placeBusy = await searchesBusy.inject({
          method: 'POST',
          url: path.replace('{sessionId}', customId),
          headers: json,
          payload,
        });

        assert.equal(placeBusy.statusCode, 429, `${path} ${payload}`);
        assert.equal((placeBusy.json() as { errorCode: number }).errorCode, 1012);
        assert.equal(placeBusy.headers['retry-after'], '1', `${path} ${payload}`);
        check(placeBusy, path, 'post');
      }

      const large = JSON.stringify({
        steps: Array.from({ length: 10 }, () => ({ status: 503, body: 'q'.repeat(20_000) })),
      });
      const saveBusy = await busy.inject({
        method: 'PUT',
        url: `/api/sessions/${customId}/queue`,
        headers: json,
        payload: large,
      });

      assert.equal(saveBusy.statusCode, 429);
      check(saveBusy, queuePath, 'put');

      const createBusy = await busy.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: json,
        payload: `{"queue":${large}}`,
      });

      assert.equal(createBusy.statusCode, 429);
      check(createBusy, '/api/sessions', 'post');

      // The four routes that take a large body's place since D213.
      for (const [method, path, payload] of [
        ['put', '/api/sessions/{sessionId}/response', '{"mode":"default"}'],
        ['post', '/api/sessions/status', `{"ids":["${customId}"]}`],
        ['post', '/api/sessions/{sessionId}/requests/search', '{"words":["abc"]}'],
        ['post', queryPath, '{}'],
      ] as const) {
        const largeBusy = await busy.inject({
          method: method.toUpperCase() as 'PUT',
          url: path.replace('{sessionId}', customId),
          headers: json,
          payload: payload + ' '.repeat(200_000),
        });

        assert.equal(largeBusy.statusCode, 429, `${method} ${path}`);
        assert.equal((largeBusy.json() as { errorCode: number }).errorCode, 1017);
        check(largeBusy, path, method);
      }

      // No place for a call in flight: every operation under `/api` is
      // refused before anything else of it is done.
      for (const { path, method } of operations()) {
        if (!path.startsWith('/api/')) {
          continue;
        }

        const url = path
          .replace('{sessionId}', customId)
          .replace('{requestId}', '00000000-0000-4000-8000-000000000000');
        const refused = await inFlight.inject({
          method: method.toUpperCase() as 'GET',
          url,
          ...(method === 'post' || method === 'put' ? { headers: json, payload: '{}' } : {}),
        });

        assert.equal(refused.statusCode, 429, `${method} ${path}`);

        if (method !== 'head') {
          assert.equal((refused.json() as { errorCode: number }).errorCode, 1019);
        }

        check(refused, path, method);
      }

      // A webhook that waited its wait for a place in the capture budget,
      // every place taken, is `503` / `1018` (D210), on every method.
      const fullBudget = createCaptureBudget({ waitMs: 50 });
      const filler = fullBudget.take('filler', inFlightBound(fullBudget.settings));
      const crowded = buildReceiver(pool, { logDestination: quiet(), captureBudget: fullBudget });

      try {
        for (const method of OPENAPI_METHODS) {
          const capturesBusy = await crowded.inject({
            method: method.toUpperCase() as 'GET',
            url: `/s/${defaultId}`,
            ...(method === 'get' || method === 'head'
              ? {}
              : { payload: '{"event":"x"}', headers: { 'content-type': 'text/plain' } }),
          });

          assert.equal(capturesBusy.statusCode, 503, `${method} /s/`);
          check(capturesBusy, receiverPath, method);
        }
      } finally {
        filler.release();
        await crowded.close();
      }
    } finally {
      await Promise.all([limited.close(), busy.close(), inFlight.close(), searchesBusy.close()]);
    }

    // Every described operation was answered at least once.
    for (const { path, method } of operations()) {
      assert.ok(exercised.has(`${method} ${path}`), `${method} ${path} was never exercised`);
    }
  });
});
