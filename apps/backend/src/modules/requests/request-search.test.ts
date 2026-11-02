/**
 * Integration tests for the search of raw requests,
 * `POST /api/sessions/:sessionId/requests/search` (D191).
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  MAX_BODY_BYTES,
  MAX_CONCURRENT_HEADER_QUERIES,
  type ApiError,
  type RequestListItem,
  type RequestSearchResult,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer } from '../../server.ts';
import { whileExpired } from '../../testing/expired-session.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { REQUEST_ID_HEADER } from '../webhook/response.ts';
import { searchRawRequests } from './repository.ts';
import { createQuerySlots } from './search.ts';

let pool: pg.Pool;
let servers: TestServers;
/** The places of searches and queries on `app` (D191, D250), which a test holds. */
const querySlots = createQuerySlots();
/** The application listener, with the documented 2 s timeout. */
let app: FastifyInstance;
/** The receive listener, where captures are sent (D187). */
let receiver: FastifyInstance;
/** An application listener whose searches are cancelled after 1 ms. */
let impatient: FastifyInstance;
/** A pool of one connection, so what a search leaves on its connection can be read. */
let singlePool: pg.Pool;
/** An application listener on `singlePool`, cancelling searches after 1 ms. */
let impatientSingle: FastifyInstance;
/** Every log line the three listeners wrote, as text. */
const logChunks: string[] = [];
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
  const { databaseUrl } = loadConfig();
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logChunks.push(chunk.toString('utf8'));
      callback();
    },
  });

  pool = createPool(databaseUrl);
  singlePool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  servers = buildTestServers(pool, { logDestination, querySlots });
  ({ api: app, receiver } = servers);
  impatient = buildServer(pool, { logDestination, searchTimeoutMs: 1 });
  impatientSingle = buildServer(singlePool, { logDestination, searchTimeoutMs: 1 });
  await Promise.all([servers.ready(), impatient.ready(), impatientSingle.ready()]);
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await Promise.all([servers?.close(), impatient?.close(), impatientSingle?.close()]);
  await singlePool?.end();
  await pool.end();
});

async function newSession(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions' });
  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

interface Sent {
  method?: 'POST' | 'GET' | 'PUT' | 'DELETE';
  /** What follows `/s/<id>`: a path, a query, or both. */
  target?: string;
  headers?: Record<string, string>;
  payload?: string | Buffer;
}

/** Captures one request and answers with its id, from the receiver's own answer (D100). */
async function capture(sessionId: string, sent: Sent = {}): Promise<string> {
  const response = await receiver.inject({
    method: sent.method ?? 'POST',
    url: `/s/${sessionId}${sent.target ?? ''}`,
    headers: { 'content-type': 'text/plain', ...sent.headers },
    payload: sent.payload,
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.headers[REQUEST_ID_HEADER] as string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function searchOn(server: FastifyInstance, sessionId: string, words: unknown) {
  return server.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/requests/search`,
    headers: JSON_HEADERS,
    payload: JSON.stringify({ words }),
  });
}

/** The ids found for each word, in the order of the words. */
async function search(sessionId: string, words: string[]): Promise<string[][]> {
  const response = await searchOn(app, sessionId, words);

  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers['content-type']), /^application\/json/);

  const result = response.json<RequestSearchResult>();

  assert.deepEqual(Object.keys(result), ['matches']);

  return result.matches;
}

async function expire(sessionId: string): Promise<void> {
  await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
    sessionId,
  ]);
}

/** How many requests the heavy session holds. */
const HEAVY_REQUESTS = 6;

let heavy: Promise<string> | undefined;

/**
 * A session whose search takes long enough to be caught running: raw requests
 * of 1 MiB each that do not compress, read once per word. Made once and only
 * read afterwards, so every test that needs it finds it as it was made.
 */
function heavySession(): Promise<string> {
  heavy ??= (async () => {
    const sessionId = await newSession();

    for (let index = 0; index < HEAVY_REQUESTS; index += 1) {
      await capture(sessionId, {
        headers: { 'content-type': 'application/octet-stream' },
        payload: randomBytes(MAX_BODY_BYTES),
      });
    }

    return sessionId;
  })();

  return heavy;
}

/** Eight words no random megabyte holds, so every one is read to its end. */
const HEAVY_WORDS = Array.from({ length: 8 }, (_, index) => `no-such-text-anywhere-${index}`);

describe('what a word finds (D191)', () => {
  it('finds a word only in a body, a header value, a header name, the path or the query, and only there', async () => {
    const sessionId = await newSession();
    const inBody = await capture(sessionId, { payload: '{"order":"tokBody48213"}' });
    const inHeaderValue = await capture(sessionId, {
      headers: { 'x-signature': 'sha256=tokValue77aa' },
      payload: 'a',
    });
    const inHeaderName = await capture(sessionId, {
      headers: { 'x-tokname-trace': '1' },
      payload: 'b',
    });
    const inPath = await capture(sessionId, { target: '/tokPath/events', payload: 'c' });
    const inQuery = await capture(sessionId, { target: '?source=tokQuery9', payload: 'd' });
    const none = await capture(sessionId, { payload: 'nothing to find' });

    const words = ['tokBody48213', 'tokValue77aa', 'x-tokname-trace', 'tokPath', 'tokQuery9'];

    assert.deepEqual(await search(sessionId, words), [
      [inBody],
      [inHeaderValue],
      [inHeaderName],
      [inPath],
      [inQuery],
    ]);

    // Each word on its own finds the same one request.
    assert.deepEqual(await search(sessionId, ['tokBody48213']), [[inBody]]);
    // A header is searched as `Name: value`, as Raw shows it.
    assert.deepEqual(await search(sessionId, ['x-tokname-trace: 1']), [[inHeaderName]]);
    assert.deepEqual(await search(sessionId, ['x-signature: sha256=tokValue77aa']), [
      [inHeaderValue],
    ]);
    // The request line: path and query as received.
    assert.deepEqual(await search(sessionId, [`/s/${sessionId}/tokPath/events HTTP/1.1`]), [
      [inPath],
    ]);
    assert.deepEqual(await search(sessionId, ['?source=tokQuery9 HTTP/']), [[inQuery]]);
    // Something every request holds finds every request, the control included.
    assert.equal((await search(sessionId, ['HTTP/1.1']))[0]?.length, 6);
    assert.ok((await search(sessionId, ['nothing to find']))[0]?.includes(none));
  });

  it('finds nothing for the same words in a different letter case', async () => {
    const sessionId = await newSession();

    await capture(sessionId, { payload: '{"order":"tokBody48213"}' });
    await capture(sessionId, { headers: { 'x-signature': 'sha256=tokValue77aa' }, payload: 'a' });
    await capture(sessionId, { headers: { 'x-tokname-trace': '1' }, payload: 'b' });
    await capture(sessionId, { target: '/tokPath/events', payload: 'c' });
    await capture(sessionId, { target: '?source=tokQuery9', payload: 'd' });

    assert.deepEqual(
      await search(sessionId, [
        'TOKBODY48213',
        'tokbody48213',
        'TokValue77aa',
        'X-Tokname-Trace',
        'tokpath',
        'TOKQUERY9',
        'post /s/',
        'http/1.1',
      ]),
      [[], [], [], [], [], [], [], []],
    );
  });

  it('finds the bytes of a word in a body that is not UTF-8', async () => {
    const sessionId = await newSession();
    const binary = await capture(sessionId, {
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0x80]),
        Buffer.from('tokBinary'),
        Buffer.from([0x00, 0xff, 0xc3]),
      ]),
    });

    await capture(sessionId, { payload: 'plain text' });

    assert.deepEqual(await search(sessionId, ['tokBinary']), [[binary]]);
    // A NUL is a byte like any other, in the word and in the body.
    assert.deepEqual(await search(sessionId, ['tokBinary\u0000']), [[binary]]);
  });

  it('matches a word as the bytes of its UTF-8 encoding, and no other encoding of it', async () => {
    const sessionId = await newSession();
    const utf8 = await capture(sessionId, { payload: 'имя=Иван' });
    // "Иван" in windows-1251: the same characters, other bytes.
    const cp1251 = await capture(sessionId, {
      headers: { 'content-type': 'text/plain; charset=windows-1251' },
      payload: Buffer.from([0xc8, 0xe2, 0xe0, 0xed]),
    });

    // The windows-1251 request holds the same characters and is not found.
    assert.deepEqual(await search(sessionId, ['Иван']), [[utf8]]);
    assert.deepEqual(await search(sessionId, ['windows-1251']), [[cp1251]]);
  });

  it('reads a pattern character as itself: %, _, \\, *, a quote', async () => {
    const sessionId = await newSession();
    const literal = await capture(sessionId, { payload: `100%_\\*'"; DROP` });

    await capture(sessionId, { payload: '100 percent and nothing else' });

    for (const word of ['100%', '%_\\', `*'"`, `'"; DROP`]) {
      assert.deepEqual(await search(sessionId, [word]), [[literal]], word);
    }

    assert.deepEqual(await search(sessionId, ['1__%', '10%%']), [[], []]);
  });

  it('answers one list per word in the order of the words, newest request first', async () => {
    const sessionId = await newSession();
    const first = await capture(sessionId, { payload: 'order 48213' });
    const second = await capture(sessionId, { method: 'PUT', payload: 'order 48213 again' });
    const third = await capture(sessionId, { payload: 'another order' });

    // `POST 48213`: the frontend shows a row when each word is in a list field
    // or in Raw, so it needs each word's list (D191).
    assert.deepEqual(await search(sessionId, ['POST', '48213']), [
      [third, first],
      [second, first],
    ]);
    assert.deepEqual(await search(sessionId, ['48213', 'POST', '48213']), [
      [second, first],
      [third, first],
      [second, first],
    ]);
  });

  it('answers an empty list for every word in a session with no requests', async () => {
    const sessionId = await newSession();

    assert.deepEqual(await search(sessionId, ['abc', 'def']), [[], []]);
  });

  it('never finds a request of another session', async () => {
    const sessionId = await newSession();
    const otherSessionId = await newSession();
    const mine = await capture(sessionId, { payload: 'tokShared' });

    await capture(otherSessionId, { payload: 'tokShared' });

    assert.deepEqual(await search(sessionId, ['tokShared']), [[mine]]);
  });

  it('no longer finds a deleted request', async () => {
    const sessionId = await newSession();
    const kept = await capture(sessionId, { payload: 'tokKept one' });
    const removed = await capture(sessionId, { payload: 'tokKept two' });

    await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/requests/${removed}` });

    assert.deepEqual(await search(sessionId, ['tokKept']), [[kept]]);
  });

  it('finds a word at the very end of a 1 MiB body', async () => {
    const sessionId = await newSession();
    const large = await capture(sessionId, {
      payload: `${'x'.repeat(MAX_BODY_BYTES - 'tokTail'.length)}tokTail`,
    });

    assert.deepEqual(await search(sessionId, ['tokTail']), [[large]]);
  });

  it('answers ids and nothing of a body or a header (D037)', async () => {
    const sessionId = await newSession();

    await capture(sessionId, { payload: 'tokSecret-payload-text' });

    const response = await searchOn(app, sessionId, ['tokSecret']);

    assert.match(response.body, /^\{"matches":\[\["[0-9a-f-]{36}"\]\]\}$/);
  });

  it('leaves the session unused: a search does not move the expiry', async () => {
    const sessionId = await newSession();
    const expiry = async (): Promise<number> => {
      const { rows } = await pool.query<{ expires_at: Date }>(
        'SELECT expires_at FROM sessions WHERE id = $1',
        [sessionId],
      );

      return rows[0]?.expires_at.getTime() ?? 0;
    };

    // Two hours back, so a refresh, which moves it at most once an hour (D133),
    // would show.
    await pool.query(
      "UPDATE sessions SET expires_at = expires_at - interval '2 hours' WHERE id = $1",
      [sessionId],
    );

    const moved = await expiry();

    await search(sessionId, ['abc']);

    assert.equal(await expiry(), moved);
  });
});

describe('the body of a search (D104, D191)', () => {
  const post = (sessionId: string, headers: Record<string, string>, payload: string | Buffer) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/requests/search`,
      headers,
      payload,
    });

  const refusals: [string, Record<string, string>, string | Buffer, number, ApiError][] = [
    [
      'a body with no Content-Type',
      {},
      '{"words":["abc"]}',
      415,
      { errorCode: 1007, message: 'Content-Type must be application/json' },
    ],
    [
      'a text/plain body',
      { 'content-type': 'text/plain' },
      '{"words":["abc"]}',
      415,
      { errorCode: 1007, message: 'Content-Type must be application/json' },
    ],
    [
      'a form body',
      { 'content-type': 'application/x-www-form-urlencoded' },
      'words=abc',
      415,
      { errorCode: 1007, message: 'Content-Type must be application/json' },
    ],
    [
      'a JSON body over 1 MiB',
      JSON_HEADERS,
      Buffer.alloc(MAX_BODY_BYTES + 1, 0x61),
      413,
      { errorCode: 1004, message: 'Payload too large' },
    ],
    [
      'an empty JSON body',
      JSON_HEADERS,
      '',
      400,
      { errorCode: 1006, message: 'Request body must be a JSON object' },
    ],
    [
      'an unparseable JSON body',
      JSON_HEADERS,
      '{"words":',
      400,
      { errorCode: 1006, message: 'Request body must be a JSON object' },
    ],
    [
      'a JSON array',
      JSON_HEADERS,
      '["abc"]',
      400,
      { errorCode: 1006, message: 'Request body must be a JSON object' },
    ],
    [
      'no words',
      JSON_HEADERS,
      '{"words":[]}',
      400,
      { errorCode: 1010, message: 'words must be an array of 1 to 8 strings' },
    ],
    [
      'a missing words key',
      JSON_HEADERS,
      '{"query":"abc"}',
      400,
      { errorCode: 1010, message: 'words must be an array of 1 to 8 strings' },
    ],
    [
      '9 words',
      JSON_HEADERS,
      JSON.stringify({ words: Array.from({ length: 9 }, (_, n) => `word${n}`) }),
      400,
      { errorCode: 1010, message: 'words must be an array of 1 to 8 strings' },
    ],
    [
      'a word that is not a string',
      JSON_HEADERS,
      '{"words":[48213]}',
      400,
      { errorCode: 1010, message: 'words must be an array of 1 to 8 strings' },
    ],
    [
      'a word of 2 bytes',
      JSON_HEADERS,
      '{"words":["ab"]}',
      400,
      { errorCode: 1010, message: 'Each word must be 3 to 200 bytes of UTF-8' },
    ],
    [
      'a word of 201 bytes',
      JSON_HEADERS,
      JSON.stringify({ words: ['a'.repeat(201)] }),
      400,
      { errorCode: 1010, message: 'Each word must be 3 to 200 bytes of UTF-8' },
    ],
    [
      'a key other than words',
      JSON_HEADERS,
      '{"words":["abc"],"caseSensitive":false}',
      400,
      { errorCode: 1010, message: 'The request body may contain no key other than "words"' },
    ],
  ];

  for (const [description, headers, payload, status, expected] of refusals) {
    it(`answers ${status} / ${expected.errorCode} for ${description}`, async () => {
      const sessionId = await newSession();
      const response = await post(sessionId, headers, payload);

      assert.equal(response.statusCode, status, response.body);
      // The whole body, so that a divergent message or an extra field fails.
      assert.deepEqual(response.json(), expected);
    });
  }

  it('accepts words at both limits: 3 and 200 bytes, 8 of them', async () => {
    const sessionId = await newSession();
    const long = 'a'.repeat(200);
    const found = await capture(sessionId, { payload: `abc ${long}` });

    assert.deepEqual(await search(sessionId, ['abc', long, 'ж'.repeat(100)]), [
      [found],
      [found],
      [],
    ]);
    assert.equal(
      (
        await search(
          sessionId,
          Array.from({ length: 8 }, () => 'abc'),
        )
      ).length,
      8,
    );
  });

  it('accepts a Content-Type with parameters and in any letter case', async () => {
    const sessionId = await newSession();
    const response = await post(
      sessionId,
      { 'content-type': 'Application/JSON; charset=utf-8' },
      '{"words":["abc"]}',
    );

    assert.equal(response.statusCode, 200, response.body);
  });

  it('checks the body before the session: an invalid body is 400 whatever the session', async () => {
    const expiredId = await newSession();

    await expire(expiredId);

    for (const sessionId of ['z'.repeat(43), 'not-a-session-id', expiredId]) {
      const response = await searchOn(app, sessionId, ['ab']);

      assert.equal(response.statusCode, 400, sessionId);
      assert.equal(response.json<ApiError>().errorCode, 1010);
    }
  });
});

describe('the session of a search (D068)', () => {
  it('answers 404 / 1001 for an unknown session and for an id that cannot be one', async () => {
    for (const sessionId of ['z'.repeat(43), 'short', `${'z'.repeat(42)}.`]) {
      const response = await searchOn(app, sessionId, ['abc']);

      assert.equal(response.statusCode, 404, sessionId);
      assert.deepEqual(response.json(), { errorCode: 1001, message: 'Session not found' });
    }
  });

  it('answers 410 / 1002 for an expired session, whatever its requests hold', async () => {
    const sessionId = await newSession();

    await capture(sessionId, { payload: 'tokExpired' });
    await expire(sessionId);

    const response = await searchOn(app, sessionId, ['tokExpired']);

    assert.equal(response.statusCode, 410);
    assert.deepEqual(response.json(), { errorCode: 1002, message: 'Session expired' });
  });

  it('reads nothing of an expired session: the statement itself joins no request', async () => {
    const sessionId = await newSession();
    const held = await capture(sessionId, { payload: 'tokExpiredRow' });
    const words = [Buffer.from('tokExpiredRow'), Buffer.from('no such text')];

    // While the session is valid the statement answers its request, flagged.
    assert.deepEqual(await searchRawRequests(pool, sessionId, words, 2000), {
      expired: false,
      value: [{ id: held, found: [true, false] }],
    });

    await expire(sessionId);

    // The service answers `410` whatever the statement returns, so the route
    // cannot show this: asked directly, the statement returns the verdict and
    // no request of the session, matching or not.
    assert.deepEqual(await searchRawRequests(pool, sessionId, words, 2000), {
      expired: true,
      value: [],
    });
    // And for a session that does not exist, no verdict at all.
    assert.deepEqual(await searchRawRequests(pool, 'z'.repeat(43), words, 2000), {
      expired: null,
      value: [],
    });
  });

  it('answers 404 / 1001 once the session row is gone, as cleanup leaves it', async () => {
    const sessionId = await newSession();

    await capture(sessionId, { payload: 'tokGone' });
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    const response = await searchOn(app, sessionId, ['tokGone']);

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { errorCode: 1001, message: 'Session not found' });
  });

  it('leaves GET and DELETE on the same path a request id that cannot be one', async () => {
    const sessionId = await newSession();
    const kept = await capture(sessionId, { payload: 'kept' });

    for (const method of ['GET', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: `/api/sessions/${sessionId}/requests/search`,
      });

      assert.equal(response.statusCode, 404, method);
      assert.deepEqual(response.json(), { errorCode: 1003, message: 'Request not found' });
    }

    const list = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` });

    assert.deepEqual(
      list.json<RequestListItem[]>().map((item) => item.id),
      [kept],
    );
  });
});

describe('a search that runs out of time (D191)', () => {
  it('answers 503 / 1011, and the same search succeeds where it is given its 2 s', async () => {
    const sessionId = await heavySession();
    const cancelled = await searchOn(impatient, sessionId, HEAVY_WORDS);

    assert.equal(cancelled.statusCode, 503, cancelled.body);
    assert.deepEqual(cancelled.json(), {
      errorCode: 1011,
      message: 'The search took too long and was cancelled',
    });

    assert.deepEqual(
      await search(sessionId, HEAVY_WORDS),
      HEAVY_WORDS.map(() => []),
    );
  });

  it('leaves the probes, the list and a capture answering, on the listener that timed out', async () => {
    const sessionId = await heavySession();
    const otherSessionId = await newSession();
    const cancelled = await searchOn(impatient, sessionId, HEAVY_WORDS);

    assert.equal(cancelled.statusCode, 503, cancelled.body);

    const health = await impatient.inject({ method: 'GET', url: '/healthz' });
    const ready = await impatient.inject({ method: 'GET', url: '/readyz' });
    const list = await impatient.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests`,
    });
    const captured = await capture(otherSessionId, { payload: 'after the timeout' });

    assert.equal(health.statusCode, 200);
    assert.equal(ready.statusCode, 200);
    assert.equal(list.statusCode, 200);
    assert.equal(list.json<RequestListItem[]>().length, HEAVY_REQUESTS);
    assert.match(captured, /^[0-9a-f-]{36}$/);
  });

  it('gives its slot back: timed-out searches never add up to a refusal', async () => {
    const sessionId = await heavySession();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const cancelled = await searchOn(impatient, sessionId, HEAVY_WORDS);

      assert.equal(cancelled.statusCode, 503, `attempt ${attempt}: ${cancelled.body}`);
    }
  });

  it('changes no other query’s timeout: the connection it used has none afterwards', async () => {
    const sessionId = await heavySession();
    const cancelled = await searchOn(impatientSingle, sessionId, HEAVY_WORDS);

    assert.equal(cancelled.statusCode, 503, cancelled.body);

    // The pool holds one connection, so this is the one the search used: the
    // timeout ended with its transaction, which was rolled back.
    const timeout = await singlePool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    const transaction = await singlePool.query<{ open: boolean }>(
      'SELECT now() <> statement_timestamp() AS open',
    );

    assert.equal(timeout.rows[0]?.statement_timeout, '0');
    assert.equal(transaction.rows[0]?.open, false, 'the transaction was left open');

    // And a list far slower than 1 ms still answers on it.
    const list = await impatientSingle.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/requests`,
    });

    assert.equal(list.statusCode, 200);
    assert.equal(list.json<RequestListItem[]>().length, HEAVY_REQUESTS);
  });

  it('leaves the connection of a successful search without a timeout too', async () => {
    const patient = buildServer(singlePool);

    patient.log.level = 'silent';
    await patient.ready();

    try {
      const sessionId = await newSession();
      const response = await searchOn(patient, sessionId, ['abc']);

      assert.equal(response.statusCode, 200, response.body);

      const timeout = await singlePool.query<{ statement_timeout: string }>(
        'SHOW statement_timeout',
      );

      assert.equal(timeout.rows[0]?.statement_timeout, '0');
    } finally {
      await patient.close();
    }
  });
});

describe('searches at once (D191)', () => {
  it('runs two, refuses the third with 429 / 1012, and everything else keeps answering', async () => {
    const sessionId = await heavySession();
    const otherSessionId = await newSession();

    // Three at once: none has answered when the third arrives.
    const searches = [
      searchOn(app, sessionId, HEAVY_WORDS),
      searchOn(app, sessionId, HEAVY_WORDS),
      searchOn(app, sessionId, HEAVY_WORDS),
    ];
    // Meanwhile: the probes, the list and a capture.
    const [health, ready, list, captured] = await Promise.all([
      app.inject({ method: 'GET', url: '/healthz' }),
      app.inject({ method: 'GET', url: '/readyz' }),
      app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` }),
      capture(otherSessionId, { payload: 'captured during the searches' }),
    ]);
    const answers = await Promise.all(searches);

    assert.deepEqual(answers.map((answer) => answer.statusCode).sort(), [200, 200, 429]);

    const refused = answers.find((answer) => answer.statusCode === 429);

    assert.deepEqual(refused?.json(), {
      errorCode: 1012,
      message: 'Too many searches are running; try again in a moment',
    });
    // When to call again (D250).
    assert.equal(refused?.headers['retry-after'], '1');
    assert.equal(health.statusCode, 200);
    assert.equal(ready.statusCode, 200);
    assert.equal(list.statusCode, 200);
    assert.equal(list.json<RequestListItem[]>().length, HEAVY_REQUESTS);
    assert.match(captured, /^[0-9a-f-]{36}$/);

    // The slots came back with the answers.
    assert.deepEqual(await search(otherSessionId, ['captured during']), [[captured]]);
  });

  it('runs two with every place of the header-only queries taken, and refuses the third with Retry-After: 1 (D250)', async () => {
    const sessionId = await newSession();
    const captured = await capture(sessionId, { payload: 'order 48213' });
    const held = Array.from({ length: MAX_CONCURRENT_HEADER_QUERIES }, () =>
      querySlots.headerOnly.tryTake(),
    );

    try {
      assert.equal(querySlots.headerOnly.tryTake(), null);
      // A header-only query has no place left...
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/requests/query`,
            headers: JSON_HEADERS,
            payload: '{"headers":[{"name":"x-merchant-id","value":"123"}]}',
          })
        ).statusCode,
        429,
      );
      // ...and the search's two are its own.
      assert.deepEqual(await search(sessionId, ['48213']), [[captured]]);

      const searchHeld = [querySlots.search.tryTake()];
      const second = await searchOn(app, sessionId, ['48213']);

      assert.equal(second.statusCode, 200, second.body);
      searchHeld.push(querySlots.search.tryTake());

      const third = await searchOn(app, sessionId, ['48213']);

      assert.equal(third.statusCode, 429);
      assert.equal(third.json<{ errorCode: number }>().errorCode, 1012);
      assert.equal(third.headers['retry-after'], '1');

      for (const release of searchHeld) {
        release?.();
      }
    } finally {
      for (const release of held) {
        release?.();
      }
    }

    assert.deepEqual([querySlots.search.taken, querySlots.headerOnly.taken], [0, 0]);
  });

  it('counts the searches of every session together', async () => {
    const sessionId = await heavySession();
    const small = await newSession();
    const answers = await Promise.all([
      searchOn(app, sessionId, HEAVY_WORDS),
      searchOn(app, small, HEAVY_WORDS),
      searchOn(app, sessionId, HEAVY_WORDS),
      searchOn(app, small, HEAVY_WORDS),
    ]);

    // Four at once, two sessions: two run, and it is not one per session.
    assert.deepEqual(answers.map((answer) => answer.statusCode).sort(), [200, 200, 429, 429]);
  });

  it('takes no slot for a body or an id it refuses', async () => {
    const sessionId = await heavySession();
    const running = searchOn(app, sessionId, HEAVY_WORDS);
    // One slot is taken. Refusals that need no search do not take the other.
    const refusals = await Promise.all([
      searchOn(app, sessionId, ['ab']),
      searchOn(app, 'not-a-session-id', ['abc']),
      searchOn(app, sessionId, []),
    ]);
    const second = await searchOn(app, sessionId, ['abc']);

    assert.deepEqual(
      refusals.map((answer) => answer.statusCode),
      [400, 404, 400],
    );
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((await running).statusCode, 200);
  });
});

describe('what a search leaves in the log (D191)', () => {
  /** Words made only for this test, so any piece of one in the log came from a search. */
  const WORDS = ['Qx7Zv9Kp2Wj4Ym8', 'Hb3Nf6Rt1Lc5Dg0', 'Uw8Ej2Sa7Io4Pz6'];
  const PIECE = 5;

  function pieces(word: string): string[] {
    return Array.from({ length: word.length - PIECE + 1 }, (_, at) => word.slice(at, at + PIECE));
  }

  it('holds no piece of any word: successful, invalid, timed out and refused', async () => {
    const sessionId = await newSession();
    const heavyId = await heavySession();
    const from = logChunks.length;

    await capture(sessionId, { payload: `order ${WORDS[0]}` });

    // Successful, with and without a match.
    assert.equal((await search(sessionId, WORDS))[0]?.length, 1);

    // Invalid, in every way a word can reach a refusal.
    const invalid = await Promise.all([
      searchOn(app, sessionId, [(WORDS[0] as string).repeat(20)]),
      searchOn(app, sessionId, [...WORDS, 'ab']),
      searchOn(
        app,
        sessionId,
        Array.from({ length: 9 }, () => WORDS[1]),
      ),
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/search`,
        headers: JSON_HEADERS,
        payload: `{"words":["${WORDS[2]}"],"${WORDS[1]}":"${WORDS[0]}"}`,
      }),
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/search`,
        headers: JSON_HEADERS,
        payload: `{"words":["${WORDS[2]}"`,
      }),
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/search`,
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify({ words: WORDS }),
      }),
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/requests/search`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ words: WORDS, padding: 'x'.repeat(MAX_BODY_BYTES) }),
      }),
    ]);

    assert.deepEqual(
      invalid.map((answer) => answer.statusCode),
      [400, 400, 400, 400, 400, 415, 413],
    );

    // Unknown and expired sessions.
    const expired = await newSession();

    await whileExpired(pool, expired, async () => {
      assert.equal((await searchOn(app, 'z'.repeat(43), WORDS)).statusCode, 404);
      assert.equal((await searchOn(app, expired, WORDS)).statusCode, 410);
    });

    // Timed out.
    const cancelled = await searchOn(impatient, heavyId, [...WORDS, ...HEAVY_WORDS.slice(0, 5)]);

    assert.equal(cancelled.statusCode, 503, cancelled.body);

    // Refused: the third of three at once.
    const atOnce = await Promise.all(
      [0, 1, 2].map(() => searchOn(app, heavyId, [...WORDS, ...HEAVY_WORDS.slice(0, 5)])),
    );

    assert.deepEqual(atOnce.map((answer) => answer.statusCode).sort(), [200, 200, 429]);

    const log = logChunks.slice(from).join('');

    // The log is the real one: it has a line for each of these requests.
    assert.ok(log.includes('/requests/search'), 'the log holds no search request');
    assert.ok(log.includes('"statusCode":503'), 'the log holds no timed-out search');
    assert.ok(log.includes('"statusCode":429'), 'the log holds no refused search');
    assert.ok(log.includes('"statusCode":400'), 'the log holds no invalid search');

    for (const word of WORDS) {
      for (const piece of pieces(word)) {
        assert.ok(!log.includes(piece), `the log holds "${piece}", a piece of a searched word`);
      }
    }

    // Nor any answer: an error body repeats no word either.
    for (const answer of [
      ...invalid,
      cancelled,
      ...atOnce.filter((one) => one.statusCode !== 200),
    ]) {
      for (const word of WORDS) {
        assert.ok(!answer.body.includes(word.slice(0, PIECE)), answer.body);
      }
    }
  });
});
