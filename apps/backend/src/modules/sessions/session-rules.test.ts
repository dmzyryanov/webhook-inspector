/**
 * Integration tests for the response rules (D246, issue #134): the route, the
 * rules given at creation, what a capture is answered and records, the
 * matching of method and path - over real sockets, so a path reaches the
 * receiver exactly as written - a session without rules answered byte for
 * byte as before, a save racing a capture, and the previous image's
 * statements replayed on the new schema.
 *
 * They run against the local PostgreSQL, with real routing, real handlers and
 * real SQL, because the rule is chosen by the statement that locks the
 * session row.
 *
 * Start the database and apply migrations first:
 *   npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  MAX_BODY_BYTES,
  MAX_RESPONSE_RULES,
  MAX_RULE_PATH_BYTES,
  RESPONSE_RULE_METHODS,
  SESSION_IDLE_DAYS,
  type RequestDetails,
  type RequestListItem,
  type ResponseConfig,
  type ResponseRule,
  type SessionDetails,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { defaultAnswerText } from '../../testing/default-answer.ts';
import { withExpiredSession } from '../../testing/expired-session.ts';
import { ordinaryFullRules, ordinaryRules } from '../../testing/full-rules.ts';
import { awaitBlockedBy, poolPausingFirstCommit } from '../../testing/locks.ts';
import { closeSockets, watch } from '../../testing/realtime.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { MATCHED_RULE_SQL, ruleTarget } from '../webhook/repository.ts';
import { toResponseRule } from './repository.ts';

const UNKNOWN_SESSION_ID = 'z'.repeat(43);
const JSON_TYPE = { 'content-type': 'application/json' };

let pool: pg.Pool;
let servers: TestServers;
/** The application listener. */
let app: FastifyInstance;
/** The receive listener, where webhooks are sent (D187). */
let receiver: FastifyInstance;
/** The receive listener's port, which the raw requests address. */
let port: number;
/** The application listener's port, for realtime. */
let apiPort: number;
const createdSessionIds: string[] = [];

// after() waits for before() to finish. Node's runner does not when a name
// pattern leaves this file no test, and what before() opens would outlive the
// run (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = start();
  await startup;
});

async function start(): Promise<void> {
  pool = createPool(loadConfig().databaseUrl);
  // Dozens of sessions created within a minute, from one address (D201).
  servers = buildTestServers(pool, { rateLimits: LIMITS_OUT_OF_REACH });
  ({ api: app, receiver } = servers);
  app.log.level = 'silent';
  receiver.log.level = 'silent';
  await receiver.listen({ host: '127.0.0.1', port: 0 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (receiver.server.address() as net.AddressInfo).port;
  apiPort = (app.server.address() as net.AddressInfo).port;
}

after(async () => {
  await startup;
  closeSockets();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers.close();
  await pool.end();
});

/** What `app.inject` resolves to; its own return type is the chainable form. */
type InjectedResponse = Awaited<ReturnType<typeof app.inject>>;

/** A response at its effective values (D101). */
function response(status: number, rest: Partial<ResponseConfig> = {}): ResponseConfig {
  return { status, headers: [], body: null, delayMs: 0, template: false, ...rest };
}

/** A rule at its effective values. */
function rule(method: string | null, path: string, answer: ResponseConfig): ResponseRule {
  return { method, path, response: answer };
}

/** Three rules: two of a method and an exact path, one of any method and a prefix. */
const ORDERS = rule('POST', '/orders', response(201, { body: '{"rule":1}' }));
const STATUS = rule('GET', '/status', response(202, { body: '{"rule":2}' }));
const ITEMS = rule(null, '/items/*', response(203, { body: '{"rule":3}' }));
const CRITERION_3 = [ORDERS, STATUS, ITEMS];

/** The session response of the sessions below, which no rule answers with. */
const CUSTOM_200 = response(200, { headers: [['x-session', 'custom']], body: '{"session":true}' });

/** Creates a session: a default one with no body, or the body given. */
async function create(body?: object): Promise<string> {
  const created =
    body === undefined
      ? await app.inject({ method: 'POST', url: '/api/sessions' })
      : await app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: JSON_TYPE,
          payload: JSON.stringify(body),
        });

  assert.equal(created.statusCode, 201, created.body);

  const { id } = created.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** Saves rules; an object is sent as `{"rules":…}`, a string as it stands. */
function putRules(
  sessionId: string,
  rules: unknown[] | string,
  headers: Record<string, string> = JSON_TYPE,
): Promise<InjectedResponse> {
  return app.inject({
    method: 'PUT',
    url: `/api/sessions/${sessionId}/rules`,
    headers,
    payload: typeof rules === 'string' ? rules : JSON.stringify({ rules }),
  });
}

async function saveRules(sessionId: string, rules: unknown[]): Promise<SessionResponseState> {
  const saved = await putRules(sessionId, rules);

  assert.equal(saved.statusCode, 200, saved.body);

  return saved.json<SessionResponseState>();
}

async function read(sessionId: string): Promise<SessionDetails> {
  const answer = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });

  assert.equal(answer.statusCode, 200, answer.body);

  return answer.json<SessionDetails>();
}

async function list(sessionId: string): Promise<RequestListItem[]> {
  const answer = await app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/requests?order=asc`,
  });

  assert.equal(answer.statusCode, 200, answer.body);

  return answer.json<RequestListItem[]>();
}

async function detail(sessionId: string, requestId: string): Promise<RequestDetails> {
  const answer = await app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/requests/${requestId}`,
  });

  assert.equal(answer.statusCode, 200, answer.body);

  return answer.json<RequestDetails>();
}

function assertError(answer: InjectedResponse, statusCode: number, errorCode: number): void {
  assert.equal(answer.statusCode, statusCode, answer.body);
  assert.equal(answer.json<{ errorCode: number }>().errorCode, errorCode, answer.body);
}

/** The rules column as stored. */
async function storedRules(sessionId: string): Promise<unknown> {
  const result = await pool.query<{ response_rules: unknown }>(
    'SELECT response_rules FROM sessions WHERE id = $1',
    [sessionId],
  );

  return result.rows[0]?.response_rules;
}

async function expiresAt(sessionId: string): Promise<Date> {
  const result = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM sessions WHERE id = $1',
    [sessionId],
  );

  return (result.rows[0] as { expires_at: Date }).expires_at;
}

/** One answer as it came off the socket. */
interface WireAnswer {
  status: number;
  /** The head's lines after the status line, `Date` and the connection's left out. */
  lines: string[];
  headers: Map<string, string>;
  body: string;
  /** The whole status line. */
  statusLine: string;
}

/** A request as written on the wire, with a body unless `body` is `null`. */
function requestText(
  method: string,
  target: string,
  body: string | null = 'captured',
  close = true,
): string {
  const framing =
    body === null
      ? ''
      : `Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;

  return `${method} ${target} HTTP/1.1\r\nHost: hook.test\r\n${close ? 'Connection: close\r\n' : ''}${framing}\r\n${body ?? ''}`;
}

/**
 * Writes `raw` to the receive listener, which closes the connection after
 * the last answer, and reads everything it wrote. `heads` names the requests
 * whose answers carry no body, in order: a `HEAD`'s.
 */
function exchange(raw: string, heads: boolean[] = []): Promise<WireAnswer[]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
    const chunks: Buffer[] = [];

    socket.setTimeout(15_000, () => {
      socket.destroy();
      reject(new Error('no complete answer in time'));
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('latin1');
      const answers: WireAnswer[] = [];
      let rest = text;

      while (rest.length > 0) {
        const end = rest.indexOf('\r\n\r\n');

        assert.ok(end !== -1, `an answer without a head: ${rest.slice(0, 200)}`);

        const [statusLine = '', ...headLines] = rest.slice(0, end).split('\r\n');
        const headers = new Map<string, string>();

        for (const line of headLines) {
          const colon = line.indexOf(':');

          headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
        }

        const length = heads[answers.length] ? 0 : Number(headers.get('content-length') ?? 0);
        const body = Buffer.from(rest.slice(end + 4), 'latin1').subarray(0, length);

        answers.push({
          status: Number(statusLine.split(' ')[1]),
          statusLine,
          lines: headLines.filter((line) => !/^(date|connection|keep-alive):/i.test(line)),
          headers,
          body: body.toString('utf8'),
        });
        rest = rest.slice(end + 4 + Buffer.from(body).toString('latin1').length);
      }

      resolve(answers);
    });
  });
}

/** Sends one request over a socket of its own and reads its answer. */
async function send(
  sessionId: string,
  method: string,
  path: string,
  body: string | null = method === 'GET' || method === 'HEAD' ? null : 'captured',
): Promise<WireAnswer> {
  const [answer] = await exchange(requestText(method, `/s/${sessionId}${path}`, body), [
    method === 'HEAD',
  ]);

  assert.ok(answer, 'no answer');

  return answer;
}

/** The rule the API's detail records for the request an answer names. */
async function recordedRule(sessionId: string, answer: WireAnswer): Promise<unknown> {
  const requestId = answer.headers.get('x-qa-tools-request-id');

  assert.ok(requestId, 'the answer names no request');

  return (await detail(sessionId, requestId)).response?.rule;
}

/** Which of `rules` the model says answers `method` to `target`, 1-based, or `null`. */
function modelMatch(
  rules: readonly ResponseRule[],
  method: string,
  target: string | null,
): number | null {
  if (target === null) {
    return null;
  }

  for (const [index, candidate] of rules.entries()) {
    const methodMatches = candidate.method === null || candidate.method === method;
    const pathMatches = candidate.path.endsWith('*')
      ? target.startsWith(candidate.path.slice(0, -1))
      : target === candidate.path;

    if (methodMatches && pathMatches) {
      return index + 1;
    }
  }

  return null;
}

/** What the capture's matching statement answers for `method` and `target`, run alone. */
async function sqlMatch(
  sessionId: string,
  method: string,
  target: string | null,
): Promise<number | null> {
  const result = await pool.query<{ matched_rule: [number, unknown] | null }>(
    `SELECT ${MATCHED_RULE_SQL} AS matched_rule FROM sessions WHERE id = $1`,
    [sessionId, method, target],
  );

  return result.rows[0]?.matched_rule?.[0] ?? null;
}

describe('PUT /api/sessions/:sessionId/rules (criterion 1)', () => {
  it('saves up to twenty rules in the order sent, answers the state, and GET reads the same', async () => {
    const id = await create({ response: CUSTOM_200 });
    const rules = ordinaryRules();

    assert.equal(rules.length, MAX_RESPONSE_RULES);

    const saved = await saveRules(id, rules);
    const expected: SessionResponseState = {
      response: CUSTOM_200,
      customResponse: CUSTOM_200,
      queue: null,
      rules,
    };

    assert.deepEqual(saved, expected);

    const session = await read(id);

    assert.deepEqual(
      {
        response: session.response,
        customResponse: session.customResponse,
        queue: session.queue,
        rules: session.rules,
      },
      expected,
    );
  });

  it('saves each field at its effective value, a response given as its status alone', async () => {
    const id = await create();
    const saved = await saveRules(id, [{ method: null, path: '/x', response: { status: 204 } }]);

    assert.deepEqual(saved.rules, [rule(null, '/x', response(204))]);
  });

  it('replaces every rule, and {"rules":[]} removes them all, stored as none', async () => {
    const id = await create();

    await saveRules(id, CRITERION_3);
    assert.deepEqual((await saveRules(id, [STATUS])).rules, [STATUS]);
    assert.deepEqual((await saveRules(id, [])).rules, []);
    assert.deepEqual((await read(id)).rules, []);
    assert.equal(await storedRules(id), null);
  });

  it('sends a second viewer session.updated carrying them, and the one that saved them', async () => {
    const id = await create();
    const [saving, other] = await Promise.all([watch(apiPort, id), watch(apiPort, id)]);
    const saved = await saveRules(id, CRITERION_3);

    for (const viewer of [saving, other]) {
      assert.deepEqual(await viewer.next(), { type: 'session.updated', data: saved });
    }

    const removed = await saveRules(id, []);

    for (const viewer of [saving, other]) {
      const event = await viewer.next();

      assert.deepEqual(event, { type: 'session.updated', data: removed });
      assert.ok(event.type === 'session.updated');
      assert.deepEqual(event.data.rules, []);
    }

    saving.close();
    other.close();
  });

  it('carries the rules in the answers of the response and queue calls too', async () => {
    const id = await create();

    await saveRules(id, [ORDERS]);

    const changed = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/response`,
      headers: JSON_TYPE,
      payload: '{"mode":"default"}',
    });
    const queued = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/queue`,
      headers: JSON_TYPE,
      payload: '{"steps":[{"status":503}]}',
    });
    const restarted = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/queue/restart`,
    });
    const removed = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/queue` });

    for (const answer of [changed, queued, restarted, removed]) {
      assert.equal(answer.statusCode, 200, answer.body);
      assert.deepEqual(answer.json<SessionResponseState>().rules, [ORDERS]);
    }
  });
});

describe('POST /api/sessions with rules (criterion 2)', () => {
  it('creates the session holding them, beside every other key', async () => {
    const id = await create({
      response: CUSTOM_200,
      queue: { steps: [{ status: 503 }] },
      expiresAfterIdleSeconds: 3600,
      storeSourceIp: false,
      rules: CRITERION_3,
    });
    const session = await read(id);

    assert.deepEqual(session.rules, CRITERION_3);
    assert.equal(session.queue?.next, 1);
    assert.equal(session.storeSourceIp, false);
  });

  it('reports rules: [] for a session created without them, or with none', async () => {
    for (const id of [
      await create(),
      await create({ response: CUSTOM_200 }),
      await create({ rules: [] }),
    ]) {
      assert.deepEqual((await read(id)).rules, []);
      assert.equal(await storedRules(id), null);
    }
  });

  it('refuses rules that break a check 400 / 1005', async () => {
    const refused = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: JSON_TYPE,
      payload: JSON.stringify({
        rules: [{ method: 'CONNECT', path: '/', response: { status: 200 } }],
      }),
    });

    assertError(refused, 400, 1005);
    assert.match(refused.json<{ message: string }>().message, /^rules\[0\]\.method/);
  });
});

describe('a rule answering with Location (D247)', () => {
  it('saves a rule whose 3xx carries Location to a path under /s/, and answers its requests with it', async () => {
    const id = await create();
    const redirect = rule(
      'POST',
      '/old',
      response(308, { headers: [['Location', `/s/${id}/new`]] }),
    );

    assert.deepEqual((await saveRules(id, [redirect])).rules, [redirect]);

    const answer = await send(id, 'POST', '/old');

    assert.equal(answer.status, 308);
    assert.equal(answer.headers.get('location'), `/s/${id}/new`);
    assert.equal((await send(id, 'POST', '/new')).headers.get('location'), undefined);
  });

  it('creates a session whose rule carries Location', async () => {
    const redirect = rule(null, '/*', response(303, { headers: [['location', '/s/x/done']] }));
    const id = await create({ rules: [redirect] });

    assert.deepEqual((await read(id)).rules, [redirect]);
    assert.equal((await send(id, 'GET', '/any')).headers.get('location'), '/s/x/done');
  });

  it('refuses a rule whose Location breaks the rule, naming it, and writes nothing', async () => {
    const id = await create();

    for (const [answer, message] of [
      [
        { status: 200, headers: [['Location', '/s/x']] },
        'rules[0].response.headers[0] Location is allowed only when rules[0].response.status is from 300 to 399',
      ],
      [
        { status: 302, headers: [['Location', '//evil.example/']] },
        'rules[0].response.headers[0] value of Location must be a path beginning with /s/',
      ],
    ] as const) {
      const refused = await putRules(id, [{ method: null, path: '/', response: answer }]);

      assertError(refused, 400, 1005);
      assert.equal(refused.json<{ message: string }>().message, message);
      assert.equal(await storedRules(id), null);
    }
  });
});

describe('a rule’s response as a template (D251)', () => {
  it('saves it, reads it back and answers a matched request with its values', async () => {
    const id = await create();
    const templated = response(201, {
      body: '{"path":"{{request.path}}","q":"{{request.query.q}}"}',
      template: true,
    });
    const saved = await saveRules(id, [rule('GET', '/orders/*', templated), ORDERS]);

    assert.deepEqual(saved.rules[0]?.response, templated);
    assert.equal(saved.rules[1]?.response.template, false);
    assert.deepEqual((await read(id)).rules[0]?.response, templated);

    const answer = await send(id, 'GET', '/orders/7?q=x');

    assert.equal(answer.status, 201);
    assert.deepEqual(JSON.parse(answer.body), { path: `/s/${id}/orders/7`, q: 'x' });
  });

  it('refuses a rule whose template breaks the grammar, naming the rule and quoting nothing', async () => {
    const id = await create();
    const refused = await putRules(id, [
      ORDERS,
      {
        method: null,
        path: '/x',
        response: { status: 200, body: '{{request.MARKER}}', template: true },
      },
    ]);

    assertError(refused, 400, 1005);

    const { message } = refused.json<{ message: string }>();

    assert.ok(message.startsWith('rules[1].response.body placeholder 1 must be one of'), message);
    assert.equal(message.includes('MARKER'), false);
    assert.deepEqual((await read(id)).rules, []);
  });
});

describe('matching a request (criterion 3, D173)', () => {
  let id: string;

  before(async () => {
    id = await create({ response: CUSTOM_200, rules: CRITERION_3 });
  });

  /** The matching cases and the attack list: [method, path, rule]. */
  const CASES: [string, string, number | null][] = [
    ['POST', '/orders', 1],
    ['POST', '/orders?x=1', 1],
    ['POST', '/orders?', 1],
    ['GET', '/orders', null],
    ['HEAD', '/orders', null],
    ['POST', '/Orders', null],
    ['POST', '/orders/', null],
    ['POST', '/%6Frders', null],
    ['POST', '//orders', null],
    ['POST', '/a/../orders', null],
    ['POST', '/orders%3Fx', null],
    ['POST', '/orders;v=1', null],
    ['POST', '/orders/x', null],
    ['POST', '/ordersx', null],
    ['POST', '', null],
    ['POST', '/', null],
    ['GET', '/status', 2],
    ['GET', '/status?verbose', 2],
    ['HEAD', '/status', null],
    ['POST', '/status', null],
    ['GET', '/status/', null],
    ['DELETE', '/items/1', 3],
    ['PUT', '/items/a/b', 3],
    ['GET', '/items/', 3],
    ['PROPFIND', '/items/x/', 3],
    ['HEAD', '/items/1', 3],
    ['GET', '/items', null],
    ['GET', '/items*', null],
    ['GET', '/Items/1', null],
    ['GET', '/%69tems/1', null],
  ];

  for (const [method, path, expected] of CASES) {
    it(`answers ${method} /s/<id>${path} by ${expected === null ? 'no rule' : `rule ${expected}`}`, async () => {
      const answer = await send(id, method, path);
      const recorded = await recordedRule(id, answer);

      if (expected === null) {
        assert.equal(answer.status, 200);
        assert.equal(answer.headers.get('x-session'), 'custom');
        assert.equal(recorded, null);
      } else {
        const matched = CRITERION_3[expected - 1] as ResponseRule;

        assert.equal(answer.status, matched.response.status);
        assert.equal(answer.headers.get('x-session'), undefined);
        assert.equal(answer.body, method === 'HEAD' ? '' : matched.response.body);
        assert.deepEqual(recorded, { index: expected, method: matched.method, path: matched.path });
      }
    });
  }

  it('answers by the earlier of two rules a request matches', async () => {
    const both = await create({
      rules: [
        rule(null, '/items/*', response(210)),
        rule('POST', '/items/1', response(211)),
        rule('POST', '/items/1', response(212)),
      ],
    });

    assert.equal((await send(both, 'POST', '/items/1')).status, 210);

    await saveRules(both, [
      rule('POST', '/items/1', response(211)),
      rule(null, '/items/*', response(210)),
    ]);
    assert.equal((await send(both, 'POST', '/items/1')).status, 211);
    assert.equal((await send(both, 'GET', '/items/1')).status, 210);
  });

  it('reads the session’s own URL as /, with and without its trailing slash', async () => {
    const root = await create({ rules: [rule(null, '/', response(220))] });

    assert.equal((await send(root, 'POST', '')).status, 220);
    assert.equal((await send(root, 'POST', '/')).status, 220);
    assert.equal((await send(root, 'POST', '?x=1')).status, 220);
    assert.equal((await send(root, 'POST', '//')).status, 200);
    assert.equal((await send(root, 'POST', '/x')).status, 200);

    const everything = await create({ rules: [rule(null, '/*', response(221))] });

    for (const path of ['', '/', '//', '/x', '/a/../b', '/%zz', '/*']) {
      assert.equal((await send(everything, 'POST', path)).status, 221, path);
    }
  });

  it('matches LIKE and regular-expression characters in a pattern only as themselves', async () => {
    const literal = await create({
      rules: [
        rule(null, '/a_c', response(231)),
        rule(null, '/a.c', response(232)),
        rule(null, '/a%c', response(233)),
        rule(null, '/p%*', response(234)),
        rule(null, '/(x|y)', response(235)),
        rule(null, '/^$', response(236)),
        rule(null, '/b\\c', response(237)),
        rule(null, '/[ab]', response(238)),
      ],
    });

    for (const [path, status] of [
      ['/a_c', 231],
      ['/abc', 200],
      ['/a.c', 232],
      ['/aXc', 200],
      ['/a%c', 233],
      ['/aZZc', 200],
      ['/p%41', 234],
      ['/p%', 234],
      ['/pq', 200],
      ['/(x|y)', 235],
      ['/x', 200],
      ['/^$', 236],
      ['/', 200],
      ['/b\\c', 237],
      ['/bc', 200],
      ['/[ab]', 238],
      ['/a', 200],
    ] as const) {
      assert.equal((await send(literal, 'POST', path)).status, status, path);
    }
  });

  it('matches every method the receiver captures, each only itself, and null any of them', async () => {
    const methods = await create({
      rules: [
        ...RESPONSE_RULE_METHODS.slice(0, MAX_RESPONSE_RULES - 1).map((method, index) =>
          rule(method, '/m', response(240 + index)),
        ),
        rule(null, '/m', response(299)),
      ],
    });

    for (const [index, method] of RESPONSE_RULE_METHODS.entries()) {
      const answer = await send(methods, method, '/m');
      const expected = index < MAX_RESPONSE_RULES - 1 ? 240 + index : 299;

      assert.equal(answer.status, expected, method);
    }
  });

  it('agrees with the model of the rule for made-up methods and paths, run as the capture runs it', async () => {
    const rules = [
      rule('POST', '/orders', response(201)),
      rule(null, '/orders/*', response(202)),
      rule('GET', '/', response(203)),
      rule(null, '/a%_*', response(204)),
      rule('DELETE', '/%C3%A9/*', response(205)),
      rule(null, '/x\\*', response(206)),
      rule('PUT', '/%F0%9F%98%80', response(207)),
    ];
    const modelled = await create({ rules });
    const targets = [
      null,
      '/',
      '/orders',
      '/orders/',
      '/orders/1',
      '/Orders',
      '/orders?x',
      '/a%_',
      '/a%_b',
      '/a%b',
      '/aX_b',
      '/%C3%A9/',
      '/%C3%A9/x',
      '/%c3%a9/x',
      '/e/x',
      '/x\\',
      '/x\\y',
      '/x',
      '/%F0%9F%98%80',
      '/%F0%9F%98%80/',
      '//',
    ];

    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) {
      for (const target of targets) {
        assert.equal(
          await sqlMatch(modelled, method, target),
          modelMatch(rules, method, target),
          `${method} ${String(target)}`,
        );
      }
    }
  });

  it('cuts the path under the session after its id segment, whatever it holds', () => {
    const sessionId = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

    assert.equal(ruleTarget(`/s/${sessionId}`), '/');
    assert.equal(ruleTarget(`/s/${sessionId}/`), '/');
    assert.equal(ruleTarget(`/s/${sessionId}/orders`), '/orders');
    assert.equal(ruleTarget(`/s/${sessionId}//orders/`), '//orders/');
    assert.equal(ruleTarget(`/s/%47${sessionId.slice(1)}/orders`), '/orders');
    assert.equal(ruleTarget('/v/x/orders'), null);
    assert.equal(ruleTarget('http://host/s/x/orders'), null);
  });

  it('answers a request sent in absolute form as one no rule matches: the queue’s step, then the session response', async () => {
    const absolute = await create({
      response: CUSTOM_200,
      queue: { steps: [{ status: 503 }] },
      rules: [rule(null, '/*', response(231)), ORDERS],
    });
    const target = `http://hook.test/s/${absolute}/orders`;
    const [first] = await exchange(requestText('POST', target));
    const [second] = await exchange(requestText('POST', target));

    assert.ok(first && second, 'no answer');
    assert.equal(first.status, 503);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-session'), 'custom');
    assert.equal(await recordedRule(absolute, first), null);
    assert.equal(await recordedRule(absolute, second), null);
    assert.deepEqual(
      (await list(absolute)).map((item) => [item.path, item.response?.rule]),
      [
        [target, null],
        [target, null],
      ],
    );

    // The same request in origin form is the first rule's.
    assert.equal((await send(absolute, 'POST', '/orders')).status, 231);
  });

  it('answers each of pipelined requests to different paths on one connection by its own rule (D210)', async () => {
    const target = (path: string) => `/s/${id}${path}`;
    const answers = await exchange(
      [
        requestText('POST', target('/orders'), 'one', false),
        requestText('GET', target('/status'), null, false),
        requestText('HEAD', target('/items/1'), null, false),
        requestText('GET', target('/nothing'), null, false),
        requestText('DELETE', target('/items/2'), 'five', true),
      ].join(''),
      [false, false, true, false, false],
    );

    assert.deepEqual(
      answers.map((answer) => answer.status),
      [201, 202, 203, 200, 203],
    );
  });
});

describe('what a rule answers (criterion 4)', () => {
  it('answers with the rule’s status, headers, body and delay, and leaves the queue’s next step where it was', async () => {
    const delayed = response(207, {
      headers: [
        ['X-Rule', 'one'],
        ['x-rule', 'two'],
        ['Content-Type', 'text/plain'],
      ],
      body: 'ruled',
      delayMs: 400,
    });
    const id = await create({
      response: CUSTOM_200,
      queue: { steps: [{ status: 503 }, { status: 502 }] },
      rules: [rule('POST', '/orders', delayed)],
    });
    const started = performance.now();
    const answer = await send(id, 'POST', '/orders');

    assert.ok(performance.now() - started >= 400, 'answered before the rule’s delay');
    assert.equal(answer.status, 207);
    assert.deepEqual(answer.lines.slice(0, 3), [
      'x-rule: one',
      'x-rule: two',
      'content-type: text/plain',
    ]);
    assert.equal(answer.body, 'ruled');
    assert.equal((await read(id)).queue?.next, 1);

    // Requests no rule matches take the steps, then the session response.
    assert.equal((await send(id, 'POST', '/other')).status, 503);
    assert.equal((await send(id, 'POST', '/orders')).status, 207);
    assert.equal((await read(id)).queue?.next, 2);
    assert.equal((await send(id, 'GET', '/orders')).status, 502);
    assert.equal((await read(id)).queue?.next, null);
    assert.equal((await send(id, 'POST', '/other')).status, 200);
    assert.equal((await send(id, 'POST', '/orders')).status, 207);

    const rows = await list(id);

    assert.deepEqual(
      rows.map((row) => [
        row.response?.queueStep?.index ?? null,
        row.response?.rule?.index ?? null,
      ]),
      [
        [null, 1],
        [1, null],
        [null, 1],
        [2, null],
        [null, null],
        [null, 1],
      ],
    );
  });

  it('answers a HEAD a rule matches with the rule’s head and no body (D064)', async () => {
    const id = await create({ rules: [rule('HEAD', '/h', response(208, { body: 'not sent' }))] });
    const answer = await send(id, 'HEAD', '/h');
    const requestId = answer.headers.get('x-qa-tools-request-id') as string;

    assert.equal(answer.status, 208);
    assert.equal(answer.headers.get('content-length'), '8');
    assert.equal(answer.body, '');
    assert.equal((await detail(id, requestId)).response?.bodySuppressed, true);
  });

  it('answers a default session’s unmatched request with the default answer, and a matched one with its rule', async () => {
    const id = await create({ rules: [ORDERS] });
    const unmatched = await send(id, 'POST', '/other');
    const requestId = unmatched.headers.get('x-qa-tools-request-id') as string;

    assert.equal(unmatched.status, 200);
    assert.equal(unmatched.body, await defaultAnswerText(app, id, requestId));
    assert.equal((await send(id, 'POST', '/orders')).body, '{"rule":1}');
  });
});

/**
 * The request id under both its names (#334, D279): every kind of stored
 * answer - the default, a custom response, a rule's and a queue step's, a
 * `HEAD` among them - carries the request id under its new name and its old
 * one, the same value, after the configured pairs, the new name first; and the
 * id is the stored request's.
 */
describe('the request id under both names on every kind of answer (#334, D279)', () => {
  const ID_LINE = /^x-(?:webhook-inspector|qa-tools)-request-id: /;

  async function assertBoth(sessionId: string, method: string, path: string, where: string) {
    const answer = await send(sessionId, method, path);
    const lines = answer.lines.filter((line) => ID_LINE.test(line));
    const id = answer.headers.get('x-webhook-inspector-request-id') ?? '';

    assert.deepEqual(
      lines,
      [`x-webhook-inspector-request-id: ${id}`, `x-qa-tools-request-id: ${id}`],
      where,
    );
    assert.match(id, /^[0-9a-f-]{36}$/, where);
    // Right after the configured pairs, before the receiver's other headers.
    assert.equal(
      answer.lines[answer.lines.indexOf(lines[1] ?? '') + 1],
      'x-content-type-options: nosniff',
      where,
    );
    assert.equal((await detail(sessionId, id)).id, id, where);

    return answer;
  }

  it('carries both on the default, a custom response, a rule’s and a queue step’s answer, HEAD included', async () => {
    const plain = await create();
    const custom = await create({ response: CUSTOM_200 });
    const queued = await create({
      response: CUSTOM_200,
      rules: [ORDERS, ITEMS],
      queue: { steps: [{ status: 503, headers: [['x-step', '1']] }, { status: 502 }] },
    });

    for (const method of ['POST', 'HEAD']) {
      await assertBoth(plain, method, '/x', `default ${method}`);
      await assertBoth(custom, method, '/x', `custom ${method}`);
    }

    const step = await assertBoth(queued, 'POST', '/x', 'queue step');

    assert.equal(step.status, 503);
    assert.ok(step.lines.indexOf('x-step: 1') < step.lines.findIndex((line) => ID_LINE.test(line)));
    assert.equal((await assertBoth(queued, 'HEAD', '/x', 'queue step HEAD')).status, 502);

    const ruled = await assertBoth(queued, 'POST', '/orders', 'rule');

    assert.equal(ruled.status, 201);
    assert.equal(ruled.body, '{"rule":1}');
    assert.equal((await assertBoth(queued, 'HEAD', '/items/1', 'rule HEAD')).status, 203);
  });
});

describe('the rule each request records (criterion 5)', () => {
  it('records the rule’s position, method and path as they were when it answered, and null otherwise', async () => {
    const id = await create({ rules: [ITEMS, ORDERS] });
    const first = await send(id, 'POST', '/orders');
    const second = await send(id, 'GET', '/items/9');
    const third = await send(id, 'GET', '/other');

    // Changed afterwards: what was recorded stays as it was.
    await saveRules(id, [rule('PATCH', '/elsewhere', response(299))]);

    assert.deepEqual(await recordedRule(id, first), { index: 2, method: 'POST', path: '/orders' });
    assert.deepEqual(await recordedRule(id, second), { index: 1, method: null, path: '/items/*' });
    assert.equal(await recordedRule(id, third), null);

    // The list row carries the position alone (D110).
    assert.deepEqual(
      (await list(id)).map((row) => row.response?.rule ?? null),
      [{ index: 2 }, { index: 1 }, null],
    );
  });

  it('names the rule in request.received and response.recorded', async () => {
    const id = await create({ rules: [ORDERS] });
    const viewer = await watch(apiPort, id);

    await send(id, 'POST', '/orders');
    await send(id, 'POST', '/other');

    const events = await viewer.received(4);
    const received = events.filter((event) => event.type === 'request.received');
    const recorded = events.filter((event) => event.type === 'response.recorded');

    assert.deepEqual(
      received.map((event) => event.data.response?.rule ?? null),
      [{ index: 1 }, null],
    );
    assert.deepEqual(
      recorded.map((event) => event.data.response.rule),
      [{ index: 1 }, null],
    );
    viewer.close();
  });
});

describe('refusals (criterion 6)', () => {
  it('refuses more than twenty rules, a method or a path that breaks a check, and an invalid response, 400 / 1005 naming the field and quoting nothing', async () => {
    const id = await create();

    await saveRules(id, [ORDERS]);

    const cases: [unknown[], string][] = [
      [Array.from({ length: 21 }, () => ORDERS), 'rules must contain at most 20 rules'],
      [[{ ...ORDERS, method: 'CONNECT' }], 'rules[0].method is required'],
      [[ORDERS, { ...ORDERS, method: 'post' }], 'rules[1].method is required'],
      [[{ ...ORDERS, method: 'TEAPOT' }], 'rules[0].method is required'],
      [
        [{ ...ORDERS, path: 'orders' }],
        'rules[0].path is required and must be a string starting with /',
      ],
      [[{ ...ORDERS, path: '/or*ders' }], 'rules[0].path may contain * only as its last character'],
      [
        [{ ...ORDERS, path: `/${'q'.repeat(MAX_RULE_PATH_BYTES)}` }],
        'rules[0].path must be at most 1024 characters',
      ],
      [[{ ...ORDERS, path: '/orders?x=1' }], 'rules[0].path must contain no ?'],
      [[{ ...ORDERS, response: { status: 600 } }], 'rules[0].response.status is required'],
      [
        [{ ...ORDERS, response: { status: 200, headers: [['Set-Cookie', 'x']] } }],
        'rules[0].response.headers[0] name is reserved',
      ],
    ];

    for (const [rules, start] of cases) {
      const refused = await putRules(id, rules);
      const { message } = refused.json<{ message: string }>();

      assertError(refused, 400, 1005);
      assert.ok(message.startsWith(start), message);
      assert.ok(
        !message.includes('qqqq') && !message.includes('TEAPOT') && !message.includes('post'),
        message,
      );
    }

    // Nothing written by any of them.
    assert.deepEqual((await read(id)).rules, [ORDERS]);
  });

  it('refuses a body over 1 MiB 413 / 1004, a malformed one 400 / 1006, another media type 415 / 1007', async () => {
    const id = await create();

    assertError(await putRules(id, `{"rules":[],"x":"${'a'.repeat(MAX_BODY_BYTES)}"}`), 413, 1004);
    assertError(await putRules(id, JSON.stringify({ rules: ordinaryFullRules(15) })), 413, 1004);
    assertError(await putRules(id, 'not json'), 400, 1006);
    assertError(await putRules(id, '[]'), 400, 1006);
    assertError(await putRules(id, '{"rules":[]}', { 'content-type': 'text/plain' }), 415, 1007);
    assert.deepEqual((await saveRules(id, ordinaryFullRules())).rules, ordinaryFullRules());
  });

  it('answers an unknown session 404 / 1001 and an expired one 410 / 1002, writing nothing', async (t) => {
    assertError(await putRules(UNKNOWN_SESSION_ID, [ORDERS]), 404, 1001);
    assertError(await putRules('not-a-session', [ORDERS]), 404, 1001);

    await withExpiredSession(
      t,
      pool,
      () => create(),
      async (expiredId) => {
        const expiry = await expiresAt(expiredId);

        assertError(await putRules(expiredId, [ORDERS]), 410, 1002);
        assert.equal(await storedRules(expiredId), null);
        assert.equal((await expiresAt(expiredId)).getTime(), expiry.getTime());
      },
    );
  });

  it('checks the body before the session', async () => {
    assertError(await putRules(UNKNOWN_SESSION_ID, [{ ...ORDERS, method: 'CONNECT' }]), 400, 1005);
    assertError(await putRules(UNKNOWN_SESSION_ID, 'not json'), 400, 1006);
  });
});

describe('a save of the rules (criterion 7)', () => {
  it('is a use of the session: the expiry moves a full window ahead', async () => {
    const id = await create();

    await pool.query(
      `UPDATE sessions SET expires_at = clock_timestamp() + interval '2 days' WHERE id = $1`,
      [id],
    );
    await saveRules(id, [ORDERS]);

    const daysAhead = ((await expiresAt(id)).getTime() - Date.now()) / 86_400_000;

    assert.ok(Math.abs(daysAhead - SESSION_IDLE_DAYS) < 0.01, `${daysAhead} days ahead`);
  });

  it('never moves the end of a session created with a lifetime (D220)', async () => {
    const id = await create({ expiresInSeconds: 600 });
    const end = await expiresAt(id);

    await saveRules(id, [ORDERS]);
    await saveRules(id, []);

    assert.equal((await expiresAt(id)).getTime(), end.getTime());
  });

  it('does not start the queue again', async () => {
    const id = await create({
      queue: { steps: [{ status: 501 }, { status: 502 }, { status: 503 }] },
    });

    await send(id, 'POST', '/x');
    assert.equal((await read(id)).queue?.next, 2);
    assert.equal((await saveRules(id, [ORDERS])).queue?.next, 2);
    assert.equal((await saveRules(id, [])).queue?.next, 2);
    assert.equal((await send(id, 'POST', '/x')).status, 502);
  });
});

/**
 * A session with no rules answers every request byte for byte as before this
 * change: the head, its lines in their order - the configured
 * headers, the receiver's three, the content type, the length - and the body,
 * pinned here as the receiver wrote them before rules existed, for a default
 * session, a custom one and a queue's step, on every kind of path, a `HEAD`
 * included. A session holding rules none of which matches, and one whose
 * rules were removed, answer the same.
 */
describe('a session with no rules (criterion 8)', () => {
  const CUSTOM = response(201, {
    headers: [
      ['X-Trace', 'abc'],
      ['x-trace', 'def'],
    ],
    body: '{"received":true}',
  });
  const PATHS = ['', '/', '/orders', '/a/../b?x=1', '//x/', '/%6Frders'];

  /**
   * The head lines a custom response or a step answers with, as before, for a
   * status that permits a body and a configuration naming no content type.
   */
  function customLines(config: ResponseConfig, requestId: string): string[] {
    const body = config.body ?? '';

    return [
      ...config.headers.map(([name, value]) => `${name.toLowerCase()}: ${value}`),
      `x-webhook-inspector-request-id: ${requestId}`,
      `x-qa-tools-request-id: ${requestId}`,
      'x-content-type-options: nosniff',
      "content-security-policy: sandbox; default-src 'none'",
      // A response with no body announces no representation (D101): Node
      // frames it chunked, with nothing in it.
      ...(config.body === null
        ? ['Transfer-Encoding: chunked']
        : [
            'content-type: application/json; charset=utf-8',
            `content-length: ${Buffer.byteLength(body)}`,
          ]),
    ];
  }

  async function assertAsBefore(
    sessionId: string,
    method: string,
    path: string,
    expected: ResponseConfig | null,
  ): Promise<void> {
    const answer = await send(sessionId, method, path);
    const requestId = answer.headers.get('x-qa-tools-request-id') as string;
    const where = `${method} ${path}`;

    if (expected === null) {
      const body = await defaultAnswerText(app, sessionId, requestId);

      assert.equal(answer.statusLine, 'HTTP/1.1 200 OK', where);
      assert.deepEqual(
        answer.lines,
        [
          `x-webhook-inspector-request-id: ${requestId}`,
          `x-qa-tools-request-id: ${requestId}`,
          'x-content-type-options: nosniff',
          "content-security-policy: sandbox; default-src 'none'",
          'content-type: application/json; charset=utf-8',
          `content-length: ${Buffer.byteLength(body)}`,
        ],
        where,
      );
      assert.equal(answer.body, method === 'HEAD' ? '' : body, where);
    } else {
      assert.equal(answer.status, expected.status, where);
      assert.deepEqual(answer.lines, customLines(expected, requestId), where);
      assert.equal(answer.body, method === 'HEAD' ? '' : (expected.body ?? ''), where);
    }

    const recorded = (await detail(sessionId, requestId)).response;

    assert.equal(recorded?.rule, null, where);
  }

  for (const kind of [
    'without rules',
    'with rules none of which matches',
    'whose rules were removed',
  ]) {
    it(`answers a default, a custom and a queue’s step ${kind} as before`, async () => {
      const ofKind = async (body: object): Promise<string> => {
        const sessionId = await create(body);

        if (kind === 'with rules none of which matches') {
          await saveRules(sessionId, [
            rule('POST', '/nowhere', response(500)),
            rule(null, '/never/*', response(500)),
            rule('PATCH', '/orders', response(500)),
          ]);
        }

        if (kind === 'whose rules were removed') {
          await saveRules(sessionId, CRITERION_3);
          await saveRules(sessionId, []);
        }

        return sessionId;
      };

      const defaultId = await ofKind({});
      const customId = await ofKind({ response: CUSTOM });
      const queuedId = await ofKind({
        response: CUSTOM,
        queue: {
          steps: [
            { status: 503, headers: [['retry-after', '1']] },
            { status: 202, body: 'b' },
          ],
        },
      });

      for (const method of ['POST', 'GET', 'HEAD', 'PUT']) {
        for (const path of PATHS) {
          await assertAsBefore(defaultId, method, path, null);
          await assertAsBefore(customId, method, path, CUSTOM);
        }
      }

      await assertAsBefore(
        queuedId,
        'POST',
        '/orders',
        response(503, { headers: [['retry-after', '1']] }),
      );
      await assertAsBefore(queuedId, 'GET', '/status', response(202, { body: 'b' }));
      await assertAsBefore(queuedId, 'POST', '/orders', CUSTOM);
    });
  }
});

/**
 * Saving the rules takes the session row's lock every capture takes (D065):
 * a capture that waits for a save is matched against the rules it saved, and
 * one that holds the lock is answered wholly by the rules before it - the
 * capture's statement reads the rules of the row its lock returns, never an
 * older one. The second call of each test goes to this file's own listeners,
 * whose hub is not the gated pair's, so it reaches the database at once.
 */
describe('a save and a capture serialise on the session row', () => {
  it('matches a capture that waited for a save against the rules saved', async () => {
    const id = await create({ response: CUSTOM_200, rules: [rule('POST', '/x', response(251))] });
    const holder = await pool.connect();

    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE sessions SET response_rules = $2::jsonb WHERE id = $1`, [
        id,
        JSON.stringify([rule('POST', '/x', response(252))]),
      ]);

      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid as number;
      const capturing = send(id, 'POST', '/x');

      await awaitBlockedBy(pool, pid);
      await holder.query('COMMIT');

      const answer = await capturing;

      assert.equal(answer.status, 252);
      assert.deepEqual(await recordedRule(id, answer), { index: 1, method: 'POST', path: '/x' });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('makes a save wait for a capture holding the session, which the old rules answer', async () => {
    const id = await create({ response: CUSTOM_200, rules: [rule('POST', '/x', response(253))] });
    const gated = poolPausingFirstCommit(pool);
    const gatedServers = buildTestServers(gated.pool);

    gatedServers.api.log.level = 'silent';
    gatedServers.receiver.log.level = 'silent';

    try {
      const capturing = gatedServers.receiver.inject({
        method: 'POST',
        url: `/s/${id}/x`,
        payload: 'x',
      });
      const holderPid = await gated.holder;
      let settled = false;
      const saving = putRules(id, [rule('POST', '/x', response(254))]).then((answer) => {
        settled = true;

        return answer;
      });

      await awaitBlockedBy(pool, holderPid);
      assert.equal(settled, false, 'the save completed while a capture held the session');
      gated.release();

      assert.equal((await capturing).statusCode, 253);
      assert.equal((await saving).statusCode, 200);
      assert.equal((await send(id, 'POST', '/x')).status, 254);
    } finally {
      gated.release();
      await gatedServers.close();
    }
  });
});

describe('the cost of matching (D246)', () => {
  /** The fastest of five runs of `run`, in milliseconds. */
  async function fastest(run: () => Promise<unknown>): Promise<number> {
    let best = Number.POSITIVE_INFINITY;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = performance.now();

      await run();
      best = Math.min(best, performance.now() - started);
    }

    return best;
  }

  it('matches a 16 KB path against twenty patterns at the bound in a few milliseconds, linearly', async (t) => {
    // Each pattern agrees with the path for its first 1022 characters and
    // fails on its last before the star, the longest comparison one can cost.
    const patterns = Array.from({ length: MAX_RESPONSE_RULES }, () =>
      rule(null, `/${'a'.repeat(MAX_RULE_PATH_BYTES - 3)}b*`, response(299)),
    );
    const id = await create({ rules: patterns });
    const target = `/${'a'.repeat(16_000)}`;
    const baseline = await create();

    assert.equal(await sqlMatch(id, 'POST', target), null);

    const withRules = await fastest(() => sqlMatch(id, 'POST', target));
    const without = await fastest(() => sqlMatch(baseline, 'POST', target));

    t.diagnostic(`${withRules.toFixed(2)} ms with the rules, ${without.toFixed(2)} ms without`);
    assert.ok(
      withRules < 50,
      `${withRules.toFixed(2)} ms with the rules, ${without.toFixed(2)} ms without`,
    );

    // A capture with a path of 15,000 bytes, Node's head limit allowing, is
    // answered by the session response, and one the last rule matches by it.
    const longPath = `/${'a'.repeat(15_000)}`;

    assert.equal((await send(id, 'POST', longPath)).status, 200);

    await saveRules(id, [...patterns.slice(1), rule(null, `/${'a'.repeat(1000)}*`, response(298))]);
    assert.equal((await send(id, 'POST', longPath)).status, 298);
  });

  it('costs no more for a longer path: 1,000, 4,000 and 16,000 bytes against the same twenty patterns', async (t) => {
    const patterns = Array.from({ length: MAX_RESPONSE_RULES }, (_unused, index) =>
      rule(
        index % 2 === 0 ? null : 'POST',
        `/${'a'.repeat(MAX_RULE_PATH_BYTES - 3)}b*`,
        response(299),
      ),
    );
    const id = await create({ rules: patterns });
    const times: string[] = [];

    for (const size of [1_000, 4_000, 16_000]) {
      const target = `/${'a'.repeat(size)}`;
      const ms = await fastest(() => sqlMatch(id, 'POST', target));

      times.push(`${size} bytes ${ms.toFixed(2)} ms`);
      assert.ok(ms < 50, times.join(', '));
    }

    t.diagnostic(times.join(', '));
  });

  it('reads the matched rule alone out of the database, whatever the others hold', async () => {
    // Fourteen rules at every limit of D101: about 1 MiB stored.
    const rules = ordinaryFullRules();
    const id = await create();

    await saveRules(id, rules);

    const result = await pool.query<{ matched_rule: [number, unknown]; stored: number }>(
      `SELECT ${MATCHED_RULE_SQL} AS matched_rule,
              octet_length(response_rules::text) AS stored
         FROM sessions WHERE id = $1`,
      [id, 'POST', '/full/7'],
    );
    const row = result.rows[0];

    assert.ok(row);
    assert.equal(row.matched_rule[0], 7);
    assert.deepEqual(toResponseRule(row.matched_rule[1]), rules[6]);
    assert.ok(row.stored > 900_000, `${row.stored} bytes stored`);
    // One rule's response, about 72 KiB, is all the capture is handed.
    assert.ok(Buffer.byteLength(JSON.stringify(row.matched_rule)) < 100_000);
  });
});

/**
 * The previous image on the new schema (migration 017): beside this one
 * during a rolling update (D221), alone after a `helm rollback` (D055). Its
 * statements, copied from `apps/backend/src/modules/sessions/repository.ts`
 * and `webhook/repository.ts` at 1.2.1 (`f9c7c61`), name no column of 017:
 * a session it creates reads `rules: []`, a record it writes reads
 * `rule: null`, and its capture of a session with rules answers by the queue
 * and the session response, leaving the rules as saved - ignored, not lost.
 */
describe('the previous image on the new schema (criteria 2 and 5)', () => {
  const BASE_IMAGE_SESSION_INSERT = `INSERT INTO sessions
       (id, expires_at, lifetime_ends_at, idle_seconds, response_status, response_headers,
        response_body, response_delay_ms, response_queue, response_queue_answered,
        store_source_ip)
     VALUES ($1,
             COALESCE(now() + make_interval(secs => $9), now() + make_interval(secs => $2::integer)),
             now() + make_interval(secs => $9),
             $2::integer,
             $3, $4::jsonb, $5, $6, $7::jsonb, $8, $10)
     RETURNING id, expires_at, store_source_ip, response_queue, response_queue_answered`;
  const BASE_IMAGE_CAPTURE_LOCK = `SELECT id, response_status,
            COALESCE(response_headers, '[]'::jsonb) AS response_headers,
            response_body,
            COALESCE(response_delay_ms, 0) AS response_delay_ms,
            COALESCE(response_custom_disabled, false) AS response_custom_disabled,
              response_queue -> response_queue_answered AS queue_step,
              jsonb_array_length(response_queue) AS queue_total,
              response_queue_answered AS queue_answered,
              store_source_ip
       FROM sessions WHERE id = $1 FOR UPDATE`;
  const BASE_IMAGE_RESPONSE_INSERT = `INSERT INTO request_responses
         (request_id, state, status, headers, body, body_size, body_suppressed, raw_response,
          delay_ms, started_at, queue_step_index, queue_step_total)
       VALUES ($1, 'pending', $2, $3::jsonb, $4, $5, $6, $7, $8, clock_timestamp(), $9, $10)`;

  it('reads a session the previous image created as one with no rules', async () => {
    const id = `${'P'.repeat(20)}${Date.now().toString(36).padStart(23, 'p')}`.slice(0, 43);

    await pool.query(BASE_IMAGE_SESSION_INSERT, [
      id,
      604_800,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      true,
    ]);
    createdSessionIds.push(id);

    assert.deepEqual((await read(id)).rules, []);
    assert.equal((await send(id, 'POST', '/orders')).status, 200);
  });

  it('reads a record the previous image wrote as answered by no rule, and leaves saved rules as they are', async () => {
    const id = await create({ response: CUSTOM_200, rules: CRITERION_3 });
    const client = await pool.connect();
    let requestId: string;

    try {
      await client.query('BEGIN');

      const locked = await client.query<{ queue_step: unknown }>(BASE_IMAGE_CAPTURE_LOCK, [id]);

      assert.equal(locked.rows[0]?.queue_step, null);

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO requests (session_id, method, path, http_version, query_string, headers,
                               body, body_size, raw_request, source_ip, received_at)
         VALUES ($1, 'POST', $2, '1.1', '', '[]'::jsonb, ''::bytea, 0, ''::bytea, NULL,
                 clock_timestamp())
         RETURNING id`,
        [id, `/s/${id}/orders`],
      );

      requestId = inserted.rows[0]?.id as string;
      await client.query(BASE_IMAGE_RESPONSE_INSERT, [
        requestId,
        200,
        JSON.stringify([['x-session', 'custom']]),
        Buffer.from('{"session":true}'),
        16,
        false,
        Buffer.from('HTTP/1.1 200 OK\r\n\r\n{"session":true}'),
        0,
        null,
        null,
      ]);
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    assert.equal((await detail(id, requestId)).response?.rule, null);
    assert.deepEqual(
      (await list(id)).map((row) => row.response?.rule),
      [null],
    );
    assert.deepEqual((await read(id)).rules, CRITERION_3);
    assert.equal((await send(id, 'POST', '/orders')).status, 201);
  });
});
