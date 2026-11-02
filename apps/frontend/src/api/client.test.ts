import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { holdAccessKey, releaseAllAccessKeys } from '../lib/access-keys.ts';
import * as api from './client.ts';

/**
 * Criterion 2 of #228 (D245 point 5, D259): every call the page makes for a
 * private session carries its key as `Authorization: Bearer`, the status read
 * as `accessKeys` beside the ids it applies to, and no request URL holds the
 * key; a public session's calls go out exactly as before. `fetch` is stubbed
 * and records what each call sent.
 */

const PRIVATE_ID = 'Pr1vate000000000000000000000000000000000abc';
const PUBLIC_ID = 'Pub1ic0000000000000000000000000000000000abc';
const KEY = 'Kf8sQ2xLm9Wq4Tz7Hc1Ny6Bd3Rv5Gs0Jx2Ve7Up4RtE';
const REQUEST = '3f2b8c1e-9d4a-4e7b-a1c6-5e8f0d2b7a94';

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

const realFetch = globalThis.fetch;
let sent: Sent[] = [];

function answer(url: string, init: RequestInit | undefined): Response {
  if (url === '/api/sessions/status') {
    const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };

    return Response.json({ sessions: ids.map((id) => ({ id, state: 'not_found' })) });
  }

  if (init?.method === 'DELETE' && !url.endsWith('/queue')) {
    return new Response(null, { status: 204 });
  }

  if (url.endsWith('/requests')) {
    return Response.json([]);
  }

  if (url.endsWith('/search')) {
    return Response.json({ matches: [] });
  }

  return Response.json({ id: PRIVATE_ID });
}

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), init });

    return answer(String(input), init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  releaseAllAccessKeys();
});

/** Every per-session call the page makes, for one session. */
async function everyCall(sessionId: string): Promise<void> {
  const response = { status: 200, headers: [], body: '', delayMs: 0, template: false };

  await api.getSession(sessionId);
  await api.listRequests(sessionId);
  await api.getRequestDetails(sessionId, REQUEST);
  await api.searchRequests(sessionId, ['needle']);
  await api.changeSessionResponse(sessionId, { mode: 'default' } as never);
  await api.setSessionQueue(sessionId, [response as never]);
  await api.restartSessionQueue(sessionId);
  await api.removeSessionQueue(sessionId);
  await api.setSessionRules(sessionId, [{ method: null, path: '/x', response: response as never }]);
  await api.deleteRequest(sessionId, REQUEST);
  await api.clearRequests(sessionId);
  await api.deleteSession(sessionId);
}

const CALLS = 12;

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;

  return headers[name];
}

describe('the calls of a private session', () => {
  it('each carry Authorization: Bearer <key>, beside their own headers', async () => {
    holdAccessKey(PRIVATE_ID, KEY);
    await everyCall(PRIVATE_ID);

    assert.equal(sent.length, CALLS);

    for (const call of sent) {
      assert.equal(headerOf(call.init, 'Authorization'), `Bearer ${KEY}`, call.url);
      assert.ok(call.url.startsWith(`/api/sessions/${PRIVATE_ID}`), call.url);
    }

    const search = sent.find((call) => call.url.endsWith('/search'));

    assert.equal(headerOf(search?.init, 'Content-Type'), 'application/json');
  });

  it('never put the key in a URL', async () => {
    holdAccessKey(PRIVATE_ID, KEY);
    await everyCall(PRIVATE_ID);
    await api.readSessionStatuses([PRIVATE_ID]);

    for (const call of sent) {
      assert.equal(call.url.includes(KEY), false, call.url);
    }
  });

  it('send nothing new for a body-less call: no body, no Content-Type (D104)', async () => {
    holdAccessKey(PRIVATE_ID, KEY);
    await api.deleteSession(PRIVATE_ID);
    await api.restartSessionQueue(PRIVATE_ID);

    for (const call of sent) {
      assert.equal(call.init?.body, undefined);
      assert.deepEqual(Object.keys((call.init?.headers ?? {}) as object), ['Authorization']);
    }
  });

  it('getSession presents the key it is given over the one held: the paste field’s check', async () => {
    holdAccessKey(PRIVATE_ID, KEY);
    await api.getSession(PRIVATE_ID, 'Other0000000000000000000000000000000000_-ab');

    assert.equal(
      headerOf(sent[0]?.init, 'Authorization'),
      'Bearer Other0000000000000000000000000000000000_-ab',
    );
  });
});

describe('the calls of a public session', () => {
  it('go out exactly as before: no Authorization, init untouched', async () => {
    holdAccessKey(PRIVATE_ID, KEY);
    await everyCall(PUBLIC_ID);

    assert.equal(sent.length, CALLS);

    for (const call of sent) {
      assert.equal(headerOf(call.init, 'Authorization'), undefined, call.url);
    }

    assert.equal(sent[0]?.init, undefined, 'getSession sent an init');
    assert.equal(sent[1]?.init, undefined, 'listRequests sent an init');
    assert.deepEqual(sent.at(-1)?.init, { method: 'DELETE' });
  });

  it('never present a key of the wrong shape given to getSession', async () => {
    await api.getSession(PUBLIC_ID, 'short');

    assert.equal(sent[0]?.init, undefined);
  });
});

describe('the status read', () => {
  it('sends { ids } alone, byte for byte as before, when the browser holds no key', async () => {
    await api.readSessionStatuses([PUBLIC_ID]);

    assert.equal(sent[0]?.init?.body, JSON.stringify({ ids: [PUBLIC_ID] }));
    assert.equal(headerOf(sent[0]?.init, 'Authorization'), undefined);
  });

  it('sends accessKeys for the listed ids it holds keys of, and no other', async () => {
    const elsewhere = 'E1sewhere00000000000000000000000000000000ab';

    holdAccessKey(PRIVATE_ID, KEY);
    holdAccessKey(elsewhere, 'Zq81aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_-');
    await api.readSessionStatuses([PUBLIC_ID, PRIVATE_ID]);

    assert.deepEqual(JSON.parse(String(sent[0]?.init?.body)), {
      ids: [PUBLIC_ID, PRIVATE_ID],
      accessKeys: { [PRIVATE_ID]: KEY },
    });
    assert.equal(headerOf(sent[0]?.init, 'Authorization'), undefined);
  });

  it('sends exactly the keys it is given as accessKeys, not the ones held now', async () => {
    // The home page's keys, taken as the read was sent (`sentKeys`, D259):
    // the browser has since let go of that key and holds another listed one.
    const listed = 'L1sted00000000000000000000000000000000000ab';

    holdAccessKey(listed, 'Zq81aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_-');
    await api.readSessionStatuses([PUBLIC_ID, PRIVATE_ID, listed], { [PRIVATE_ID]: KEY });

    assert.equal(
      sent[0]?.init?.body,
      JSON.stringify({ ids: [PUBLIC_ID, PRIVATE_ID, listed], accessKeys: { [PRIVATE_ID]: KEY } }),
    );
    assert.equal(headerOf(sent[0]?.init, 'Authorization'), undefined);
  });

  it('sends { ids } alone when it is given null, though the browser holds their keys', async () => {
    holdAccessKey(PRIVATE_ID, KEY);
    await api.readSessionStatuses([PUBLIC_ID, PRIVATE_ID], null);

    assert.equal(sent[0]?.init?.body, JSON.stringify({ ids: [PUBLIC_ID, PRIVATE_ID] }));
    assert.equal(headerOf(sent[0]?.init, 'Authorization'), undefined);
  });
});

describe('createSession', () => {
  it('sends no Authorization, so the server draws a private session’s key', async () => {
    holdAccessKey(PRIVATE_ID, KEY);
    await api.createSession({ idleSeconds: 604_800, storeSourceIp: true, private: true });

    assert.equal(headerOf(sent[0]?.init, 'Authorization'), undefined);
    assert.equal(sent[0]?.init?.body, '{"private":true}');
  });
});

/**
 * Issue #245: a `sourceIp` the contract does not allow, in the list answer or
 * in the detail answer, reaches the page as `null` - read once, in the call
 * that took it in - so the row and the panel read `IP unavailable` rather than
 * blanking the page or the panel. A string and `null` are kept.
 */
describe('a sourceIp outside the contract', () => {
  const NOT_AN_ADDRESS: unknown[] = [123, 0, {}, { length: 3 }, [], ['1.2.3.4'], true, false];

  function row(id: string, sourceIp: unknown): Record<string, unknown> {
    return {
      id,
      method: 'POST',
      receivedAt: '2026-10-23T10:00:00.000Z',
      bodySize: 2,
      sourceIp,
      path: `/s/${PUBLIC_ID}`,
      response: null,
    };
  }

  function answerWith(body: unknown): void {
    globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
  }

  it('is read as null in every row of the list answer, a missing one included', async () => {
    const missing = row('missing', null);

    delete missing.sourceIp;
    answerWith([
      ...NOT_AN_ADDRESS.map((sourceIp, index) => row(`r${index}`, sourceIp)),
      missing,
      row('string', '203.0.113.7'),
      row('null', null),
    ]);

    const items = await api.listRequests(PUBLIC_ID);

    assert.deepEqual(
      items.map((item) => item.sourceIp),
      [...NOT_AN_ADDRESS.map(() => null), null, '203.0.113.7', null],
    );
  });

  it('is read as null in the detail answer, and a string is kept', async () => {
    for (const sourceIp of [...NOT_AN_ADDRESS, undefined]) {
      answerWith({ ...row(REQUEST, sourceIp), headers: [], body: '{}', httpVersion: '1.1' });

      const details = await api.getRequestDetails(PUBLIC_ID, REQUEST);

      assert.equal(details.sourceIp, null, JSON.stringify(sourceIp));
      assert.deepEqual(details.headers, []);
    }

    answerWith({ ...row(REQUEST, '2001:db8::1'), headers: [] });

    assert.equal((await api.getRequestDetails(PUBLIC_ID, REQUEST)).sourceIp, '2001:db8::1');
  });
});
