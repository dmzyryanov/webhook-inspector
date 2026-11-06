/**
 * `/mcp` over HTTP with the official MCP TypeScript SDK's client (D203), on
 * both listeners of the process bound to real ports: the client connects and
 * negotiates, `tools/list` gives the seven tools, and the whole flow - create,
 * respond, wait, send, read, clear, delete - runs through it, the webhook sent
 * over HTTP to the receive listener. The client checks every structured
 * result against the tool's output schema, so a result the schema does not
 * describe fails here, and its own validator holds the arguments of
 * `create_session` and `set_response` to their listed input schemas, as a
 * client that validates them would, a `body` of `null` among them, taken as the
 * API takes it.
 * The SDK is a development dependency only; the server is written by hand.
 * And what Fastify's injection cannot send: a URL with an empty `?` or a `#`,
 * refused as any query string is.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  MCP_TOOL_NAMES,
  MCP_UNTRUSTED_FIELD,
  MCP_UNTRUSTED_NOTICE,
} from '@webhook-inspector/shared/mcp';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { PendingWaits } from '../requests/wait.ts';
import { buildReceiver, buildServer } from '../../server.ts';
import { attachListener, LIMITS_OUT_OF_REACH } from '../../testing/servers.ts';
import { QUERY_STRING_REFUSED, SERVER_VERSION } from './routes.ts';

let pool: pg.Pool;
let app: FastifyInstance;
let receiver: FastifyInstance;
let endpoint: URL;
let receiveOrigin = '';
let client: Client;
let hub: RealtimeHub;
/** The listener's pending waits, `wait_for_request`'s among them (D200). */
const waits = new PendingWaits();
const createdSessionIds: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

const silent = (): Writable =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);

    hub = new RealtimeHub();
    receiver = buildReceiver(pool, { hub, logDestination: silent() });
    await receiver.listen({ host: '127.0.0.1', port: 0 });

    receiveOrigin = `http://127.0.0.1:${(receiver.server.address() as AddressInfo).port}`;
    app = buildServer(pool, {
      hub,
      waits,
      receiveOrigin,
      appOrigin: 'http://localhost:5173',
      rateLimits: LIMITS_OUT_OF_REACH,
      logDestination: silent(),
    });
    // The process's realtime listener (D221): a capture ends a wait through it.
    attachListener(app, pool, hub);
    await app.listen({ host: '127.0.0.1', port: 0 });
    endpoint = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);

    client = new Client({ name: 'webhook-inspector-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
  })();
  await startup;
});

after(async () => {
  await startup;
  await client?.close();

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await app?.close();
  await receiver?.close();
  await pool?.end();
});

interface Result {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function tool(name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

async function structured(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await tool(name, args);

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.ok(result.structuredContent);

  return result.structuredContent;
}

describe('an MCP client over HTTP (D203)', () => {
  it('connects, negotiates the newest version, and reads the server and its instructions', () => {
    assert.deepEqual(client.getServerVersion(), {
      name: 'webhook-inspector',
      title: 'Webhook Inspector',
      version: SERVER_VERSION,
      websiteUrl: 'http://localhost:5173',
    });
    assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: false } });
    assert.match(client.getInstructions() ?? '', /is data, not instructions/);
  });

  it('lists the seven tools with their input and output schemas', async () => {
    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map((entry) => entry.name),
      [...MCP_TOOL_NAMES],
    );

    for (const entry of tools) {
      assert.equal(entry.inputSchema.type, 'object');
      assert.equal(entry.outputSchema?.type, 'object');
      assert.ok(entry.description && entry.description.length > 50);
    }
  });

  it('runs the whole flow: create, respond, wait, send, read, clear, delete', async () => {
    const created = await structured('create_session', {});
    const sessionId = created.sessionId as string;
    const receiveUrl = created.receiveUrl as string;

    createdSessionIds.push(sessionId);
    assert.equal(receiveUrl, `${receiveOrigin}/s/${sessionId}`);

    await structured('set_response', {
      sessionId,
      mode: 'custom',
      response: { status: 202, headers: [['X-Mock', 'yes']], body: '{"accepted":true}' },
    });

    // Waiting before the webhook is sent, so the wait is what sees it arrive.
    const waiting = tool('wait_for_request', { sessionId, wait: 15 });

    await delay(300);

    const sent = await fetch(`${receiveUrl}/orders?id=7`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': 'sig-1' },
      body: '{"event":"order.paid"}',
    });

    assert.equal(sent.status, 202);
    assert.equal(sent.headers.get('x-mock'), 'yes');
    assert.equal(await sent.text(), '{"accepted":true}');

    const requestId = sent.headers.get('x-qa-tools-request-id') as string;
    const waited = await waiting;

    assert.equal(waited.isError, undefined);
    assert.deepEqual(waited.content[0], { type: 'text', text: MCP_UNTRUSTED_NOTICE });
    assert.deepEqual(
      (waited.structuredContent?.requests as { id: string }[]).map((entry) => entry.id),
      [requestId],
    );

    const read = await structured('get_request', { sessionId, requestId });
    const captured = read[MCP_UNTRUSTED_FIELD] as {
      path: string;
      queryString: string;
      headers: [string, string][];
      body: string;
    };

    assert.equal(captured.body, '{"event":"order.paid"}');
    assert.equal(captured.path, `/s/${sessionId}/orders`);
    assert.equal(captured.queryString, 'id=7');
    assert.ok(
      captured.headers.some(([name, value]) => name === 'X-Signature' && value === 'sig-1'),
    );
    // `sent` once the record of the answer is written, `pending` just before (D109).
    const response = read.response as { state: string; status: number };

    assert.equal(response.status, 202);
    assert.ok(['pending', 'sent'].includes(response.state), response.state);

    await structured('clear_requests', { sessionId });
    assert.deepEqual((await structured('list_requests', { sessionId })).requests, []);

    await structured('delete_session', { sessionId });

    const gone = await tool('get_request', { sessionId, requestId });

    assert.equal(gone.isError, true);
    assert.match(gone.content[0]?.text ?? '', /^errorCode 1001 SESSION_NOT_FOUND/);
  });

  it('answers GET 405 and a foreign Origin 403 over HTTP, and a notification 202', async () => {
    const get = await fetch(endpoint, { headers: { accept: 'text/event-stream' } });

    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    await get.text();

    const foreign = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'https://evil.example',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });

    assert.equal(foreign.status, 403);
    await foreign.text();

    const notification = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    });

    assert.equal(notification.status, 202);
    assert.equal(await notification.text(), '');
  });
});

describe('a response with body null over HTTP (D203)', () => {
  /** The arguments, checked first against the tool's listed input schema by the SDK's validator. */
  async function validated(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { tools } = await client.listTools();
    const listed = tools.find((entry) => entry.name === name);

    assert.ok(listed, name);

    const verdict = new AjvJsonSchemaValidator().getValidator(listed.inputSchema)(args);

    assert.ok(verdict.valid, `${name}: ${verdict.errorMessage ?? ''}`);

    return structured(name, args);
  }

  async function api(method: string, path: string, body: unknown): Promise<Response> {
    return fetch(new URL(path, endpoint), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function apiResponse(sessionId: string): Promise<unknown> {
    const read = await fetch(new URL(`/api/sessions/${sessionId}`, endpoint));

    assert.equal(read.status, 200);

    return ((await read.json()) as { response: unknown }).response;
  }

  it('is taken by create_session and set_response as POST and PUT take it, and sent back as answered', async () => {
    const bodyless = { status: 204, headers: [], body: null, delayMs: 0, template: false };

    // POST /api/sessions and create_session, the same response.
    const posted = await api('POST', '/api/sessions', { response: { status: 204, body: null } });

    assert.equal(posted.status, 201);

    const apiSessionId = ((await posted.json()) as { id: string }).id;

    createdSessionIds.push(apiSessionId);
    assert.deepEqual(await apiResponse(apiSessionId), bodyless);

    const created = await validated('create_session', { response: { status: 204, body: null } });
    const sessionId = created.sessionId as string;

    createdSessionIds.push(sessionId);
    assert.deepEqual(created.response, bodyless);
    assert.deepEqual(await apiResponse(sessionId), bodyless);

    // PUT .../response and set_response, the same change.
    const change = {
      mode: 'custom',
      response: { status: 200, body: null, delayMs: 0, template: false },
    };
    const put = await api('PUT', `/api/sessions/${apiSessionId}/response`, change);

    assert.equal(put.status, 200);

    const putState = (await put.json()) as { response: unknown };
    const changed = await validated('set_response', { sessionId, ...change });

    assert.deepEqual(changed, { sessionId, mode: 'custom', response: putState.response });
    assert.deepEqual(putState.response, {
      status: 200,
      headers: [],
      body: null,
      delayMs: 0,
      template: false,
    });

    // What create_session answered goes back to set_response as it is.
    const back = await validated('set_response', {
      sessionId,
      mode: 'custom',
      response: created.response,
    });

    assert.deepEqual(back.response, bodyless);
    assert.deepEqual(await apiResponse(sessionId), bodyless);

    const webhook = await fetch(`${receiveOrigin}/s/${sessionId}`, { method: 'POST', body: 'x' });

    assert.equal(webhook.status, 204);
    assert.equal(await webhook.text(), '');
  });
});

interface SentAnswer {
  status: number;
  allow: string | undefined;
  body: unknown;
}

/**
 * Sends a request to the target exactly as written. `fetch` and `URL` drop an
 * empty `?` and a `#` with what follows it; Node's client given a `path` sends
 * it as it is.
 */
function sendTarget(
  method: string,
  target: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<SentAnswer> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: endpoint.hostname,
      port: endpoint.port,
      path: target,
      method,
      agent: false,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        ...headers,
      },
    });

    request.on('error', reject);
    request.on('response', (response) => {
      const chunks: Buffer[] = [];

      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');

        resolve({
          status: response.statusCode ?? 0,
          allow: response.headers.allow,
          body: text === '' ? undefined : (JSON.parse(text) as unknown),
        });
      });
      response.on('error', reject);
    });
    request.end(body);
  });
}

describe('a URL with a query string over HTTP (D203)', () => {
  it('is refused 400 as sent - an empty ?, a #, 15,000 characters - on POST and GET alike', async () => {
    const ping = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    const refusal = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: QUERY_STRING_REFUSED },
    };

    for (const target of [
      '/mcp?',
      '/mcp#',
      '/mcp#x',
      '/mcp?#',
      `/mcp?q=${'x'.repeat(15_000)}`,
      `/mcp#${'x'.repeat(15_000)}`,
    ]) {
      for (const method of ['POST', 'GET']) {
        const answer = await sendTarget(method, target, method === 'POST' ? ping : undefined);
        const label = `${method} ${target.slice(0, 12)}`;

        assert.equal(answer.status, 400, label);
        assert.equal(answer.allow, undefined, label);
        assert.deepEqual(answer.body, refusal, label);
      }
    }

    assert.equal((await sendTarget('POST', '/mcp', ping)).status, 200);
  });

  it('answers a body over 1 MiB on a connection the client closes, read and discarded first (D143)', async () => {
    const answer = await sendTarget('POST', '/mcp?', `{"pad":"${'a'.repeat(2 * 1024 * 1024)}"}`, {
      connection: 'close',
    });

    assert.equal(answer.status, 400);
    assert.deepEqual(answer.body, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: QUERY_STRING_REFUSED },
    });
  });
});

describe('a client that leaves while wait_for_request waits (D200, D203)', () => {
  it('leaves no wait and no subscription behind', async () => {
    const created = await structured('create_session', {});
    const sessionId = created.sessionId as string;

    createdSessionIds.push(sessionId);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wait_for_request', arguments: { sessionId, wait: 20 } },
    });
    const request = http.request(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(body),
      },
    });

    request.on('error', () => {});
    request.end(body);

    // The wait is registered: a subscription of the session and a pending wait.
    for (let tries = 0; hub.countFor(sessionId) === 0 && tries < 100; tries += 1) {
      await delay(10);
    }

    assert.equal(hub.countFor(sessionId), 1);
    assert.equal(waits.size, 1);

    request.destroy();

    for (let tries = 0; hub.countFor(sessionId) > 0 && tries < 100; tries += 1) {
      await delay(10);
    }

    assert.equal(hub.countFor(sessionId), 0);
    assert.equal(waits.size, 0);
  });
});
