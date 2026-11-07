/**
 * Integration tests for the status read, `POST /api/sessions/status` (D199,
 * issue #92): what it answers for active, expired and unknown sessions, in
 * request order; that it moves no session's expiry; the order of its body
 * checks; and that no session id reaches a log line or an error body.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  MAX_BODY_BYTES,
  SESSION_IDLE_DAYS,
  type ApiError,
  type RequestListItem,
  type SessionStatusResult,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { whileExpired } from '../../testing/expired-session.ts';
import { buildTestServers, type TestServers } from '../../testing/servers.ts';
import { ID_RULE, IDS_RULE, KEYS_RULE, REPEATED_ID_RULE } from './status-body.ts';

const RECEIVE_ORIGIN = 'https://hook.example.test';
const JSON_HEADERS = { 'content-type': 'application/json' };
const DAY_MS = 24 * 60 * 60 * 1000;

let pool: pg.Pool;
let servers: TestServers;
/** The application listener, which serves the API. */
let app: FastifyInstance;
/** The receive listener, where captures are sent (D187). */
let receiver: FastifyInstance;
/** Every log line both listeners wrote, as text. */
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
  pool = createPool(loadConfig().databaseUrl);
  servers = buildTestServers(pool, {
    receiveOrigin: RECEIVE_ORIGIN,
    logDestination: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logChunks.push(chunk.toString('utf8'));
        callback();
      },
    }),
  });
  ({ api: app, receiver } = servers);
  await servers.ready();
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool?.end();
});

async function newSession(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions' });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

/** A session created with a lifetime of `seconds` (D220). */
async function newSessionWithLifetime(seconds: number): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: JSON_HEADERS,
    payload: JSON.stringify({ expiresInSeconds: seconds }),
  });

  assert.equal(response.statusCode, 201, response.body);

  const { id } = response.json<{ id: string }>();

  createdSessionIds.push(id);

  return id;
}

async function createdAt(sessionId: string): Promise<Date> {
  const { rows } = await pool.query<{ created_at: Date }>(
    'SELECT created_at FROM sessions WHERE id = $1',
    [sessionId],
  );

  return rows[0]?.created_at as Date;
}

async function capture(sessionId: string, payload = 'ping'): Promise<void> {
  const response = await receiver.inject({
    method: 'POST',
    url: `/s/${sessionId}`,
    headers: { 'content-type': 'text/plain' },
    payload,
  });

  assert.equal(response.statusCode, 200, response.body);
}

/** An id of the right shape that names no session; `n` tells them apart. */
function unknownId(n: number): string {
  return `U${String(n).padStart(4, '0')}${'z'.repeat(38)}`;
}

function post(payload: string | Buffer, headers: Record<string, string> = JSON_HEADERS) {
  return app.inject({ method: 'POST', url: '/api/sessions/status', headers, payload });
}

/** The answer for `ids`, which must be `200`. */
async function statusOf(ids: string[]): Promise<SessionStatusResult['sessions']> {
  const response = await post(JSON.stringify({ ids }));

  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers['content-type']), /^application\/json/);

  const result = response.json<SessionStatusResult>();

  assert.deepEqual(Object.keys(result), ['sessions']);

  return result.sessions;
}

async function expiresAt(sessionId: string): Promise<number> {
  const { rows } = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM sessions WHERE id = $1',
    [sessionId],
  );

  return rows[0]?.expires_at.getTime() ?? Number.NaN;
}

/** Moves the expiry two hours back, so a refresh - at most once an hour (D150) - would show. */
async function ageByTwoHours(sessionId: string): Promise<void> {
  await pool.query(
    "UPDATE sessions SET expires_at = expires_at - interval '2 hours' WHERE id = $1",
    [sessionId],
  );
}

async function newestReceivedAt(sessionId: string): Promise<string | undefined> {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` });

  return response.json<RequestListItem[]>()[0]?.receivedAt;
}

describe('what the status read answers (D199)', () => {
  it('answers active, expired and not_found entries in request order, with what the list shows', async () => {
    const busy = await newSession();
    const quiet = await newSession();
    const expired = await newSession();
    const deleted = await newSession();
    const never = unknownId(1);

    await capture(busy, 'first');
    await capture(busy, 'second');
    await capture(busy, 'third');
    await capture(expired, 'kept by the cleanup');
    await ageByTwoHours(busy);
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/api/sessions/${deleted}` })).statusCode,
      204,
    );

    const busyExpiry = await expiresAt(busy);
    const quietExpiry = await expiresAt(quiet);
    const lastRequest = await newestReceivedAt(busy);

    assert.ok(lastRequest !== undefined);

    const answer = await whileExpired(pool, expired, () =>
      statusOf([never, busy, expired, quiet, deleted]),
    );

    assert.deepEqual(answer, [
      { id: never, state: 'not_found' },
      {
        id: busy,
        state: 'active',
        receiveUrl: `${RECEIVE_ORIGIN}/s/${busy}`,
        requestsCount: 3,
        lastRequestAt: lastRequest,
        lastUsedAt: new Date(busyExpiry - SESSION_IDLE_DAYS * DAY_MS).toISOString(),
      },
      { id: expired, state: 'expired' },
      {
        id: quiet,
        state: 'active',
        receiveUrl: `${RECEIVE_ORIGIN}/s/${quiet}`,
        requestsCount: 0,
        lastRequestAt: null,
        lastUsedAt: new Date(quietExpiry - SESSION_IDLE_DAYS * DAY_MS).toISOString(),
      },
      { id: deleted, state: 'not_found' },
    ]);
  });

  it('gives the fields of each state and no others, in a stable order', async () => {
    const active = await newSession();
    const [entry] = await statusOf([active]);

    assert.deepEqual(Object.keys(entry ?? {}), [
      'id',
      'state',
      'receiveUrl',
      'requestsCount',
      'lastRequestAt',
      'lastUsedAt',
    ]);
    assert.deepEqual(Object.keys((await statusOf([unknownId(2)]))[0] ?? {}), ['id', 'state']);
  });

  it('counts the requests the session holds now, after one is deleted', async () => {
    const sessionId = await newSession();

    await capture(sessionId, 'one');
    await capture(sessionId, 'two');

    const [newest] = (
      await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/requests` })
    ).json<RequestListItem[]>();

    assert.ok(newest !== undefined);
    await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}/requests/${newest.id}`,
    });

    const [entry] = await statusOf([sessionId]);

    assert.equal(entry?.state, 'active');
    assert.ok(entry?.state === 'active');
    assert.equal(entry.requestsCount, 1);
    assert.equal(entry.lastRequestAt, await newestReceivedAt(sessionId));
  });

  it('answers 1 id and 50 ids, one entry each in request order', async () => {
    const real = await newSession();
    const fifty = [...Array.from({ length: 49 }, (_, n) => unknownId(100 + n)), real];

    assert.equal((await statusOf([real])).length, 1);

    const answer = await statusOf(fifty);

    assert.deepEqual(
      answer.map((entry) => entry.id),
      fifty,
    );
    assert.deepEqual(
      answer.map((entry) => entry.state),
      [...Array.from({ length: 49 }, () => 'not_found'), 'active'],
    );
  });

  it('answers an id of the older Base64URL shape that names no session as not_found', async () => {
    const older = 'Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss';

    assert.deepEqual(await statusOf([older]), [{ id: older, state: 'not_found' }]);
  });

  /**
   * A fixed lifetime (#129, D220): no use moves the expiry of a session
   * created with a lifetime, so its expiry minus 7 days says nothing about its
   * last use. Its `lastUsedAt` is the later of its creation and its newest
   * request; a read or a response change, which this read cannot see, does
   * not count.
   */
  it('gives a session with a lifetime the later of its creation and its newest request as lastUsedAt (D220)', async () => {
    const quiet = await newSessionWithLifetime(600);
    const busy = await newSessionWithLifetime(3600);
    const plain = await newSession();

    await capture(busy, 'first');
    await capture(busy, 'second');
    // A read and a response change are uses the read cannot see, and change nothing here.
    await app.inject({ method: 'GET', url: `/api/sessions/${quiet}` });
    await app.inject({
      method: 'PUT',
      url: `/api/sessions/${busy}/response`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mode: 'custom', response: { status: 202 } }),
    });

    const lastRequest = await newestReceivedAt(busy);
    const plainExpiry = await expiresAt(plain);

    assert.ok(lastRequest !== undefined);
    assert.deepEqual(await statusOf([quiet, busy, plain]), [
      {
        id: quiet,
        state: 'active',
        receiveUrl: `${RECEIVE_ORIGIN}/s/${quiet}`,
        requestsCount: 0,
        lastRequestAt: null,
        lastUsedAt: (await createdAt(quiet)).toISOString(),
      },
      {
        id: busy,
        state: 'active',
        receiveUrl: `${RECEIVE_ORIGIN}/s/${busy}`,
        requestsCount: 2,
        lastRequestAt: lastRequest,
        lastUsedAt: lastRequest,
      },
      // A session without one keeps the rule of D199, as the control.
      {
        id: plain,
        state: 'active',
        receiveUrl: `${RECEIVE_ORIGIN}/s/${plain}`,
        requestsCount: 0,
        lastRequestAt: null,
        lastUsedAt: new Date(plainExpiry - SESSION_IDLE_DAYS * DAY_MS).toISOString(),
      },
    ]);

    // Not its expiry minus 7 days, which is before it was created.
    assert.ok(
      (await expiresAt(busy)) - SESSION_IDLE_DAYS * DAY_MS < (await createdAt(busy)).getTime(),
    );
  });

  /**
   * An idle window (D242): `lastUsedAt` is the expiry minus the session's own
   * window. Each session is last moved `ago` before the read - its expiry set
   * as a use that long ago would have left it - then used once more after
   * its throttle, which moves it; the read gives that use, within 2 s.
   */
  for (const [window, ago] of [
    [3600, '10 minutes'],
    [86_400, '2 hours'],
    [604_800, '2 hours'],
  ] as const) {
    it(`gives a ${window}-second session its last use as lastUsedAt, within 2 s (D242)`, async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ expiresAfterIdleSeconds: window }),
      });

      assert.equal(response.statusCode, 201, response.body);

      const { id } = response.json<{ id: string }>();

      createdSessionIds.push(id);
      await pool.query(
        `UPDATE sessions
            SET expires_at = clock_timestamp() + make_interval(secs => $2) - $3::interval
          WHERE id = $1`,
        [id, window, ago],
      );

      // Before the use: the last move, `ago` back - not the expiry minus 7 days.
      const before = await statusOf([id]);
      const agoMs = (
        await pool.query<{ ms: number }>(
          'SELECT extract(epoch FROM $1::interval)::float8 * 1000 AS ms',
          [ago],
        )
      ).rows[0]?.ms as number;

      assert.equal(before[0]?.state, 'active');
      assert.ok(
        Math.abs(
          Date.parse((before[0] as { lastUsedAt: string }).lastUsedAt) - (Date.now() - agoMs),
        ) < 2_000,
        JSON.stringify(before),
      );

      const usedAt = Date.now();

      await capture(id);

      const after = await statusOf([id]);
      const lastUsedAt = Date.parse((after[0] as { lastUsedAt: string }).lastUsedAt);

      assert.ok(Math.abs(lastUsedAt - usedAt) < 2_000, `${lastUsedAt - usedAt} ms from the use`);
      // Exactly the expiry minus the window.
      assert.equal(lastUsedAt, (await expiresAt(id)) - window * 1000);
    });
  }

  it('answers a session whose lifetime has passed expired (D220)', async () => {
    const sessionId = await newSessionWithLifetime(60);

    await whileExpired(pool, sessionId, async () => {
      await pool.query(
        `UPDATE sessions
            SET expires_at = expires_at - interval '61 seconds',
                lifetime_ends_at = lifetime_ends_at - interval '61 seconds'
          WHERE id = $1`,
        [sessionId],
      );

      assert.deepEqual(await statusOf([sessionId]), [{ id: sessionId, state: 'expired' }]);
    });
  });
});

describe('the status read is not a use of a session (D133, D199)', () => {
  it('moves no expiry: of an active session, a busy one or an expired one', async () => {
    const quiet = await newSession();
    const busy = await newSession();
    const expired = await newSession();

    await capture(busy);
    await ageByTwoHours(quiet);
    await ageByTwoHours(busy);

    const before = [await expiresAt(quiet), await expiresAt(busy)];

    await statusOf([quiet, busy]);
    await statusOf([busy, quiet]);
    assert.deepEqual([await expiresAt(quiet), await expiresAt(busy)], before);

    await whileExpired(pool, expired, async () => {
      const expiredAt = await expiresAt(expired);

      assert.deepEqual(await statusOf([expired]), [{ id: expired, state: 'expired' }]);
      assert.equal(await expiresAt(expired), expiredAt);
    });
  });

  it('while a read of the session itself does move it, as the control', async () => {
    const sessionId = await newSession();

    await ageByTwoHours(sessionId);

    const aged = await expiresAt(sessionId);

    await statusOf([sessionId]);
    assert.equal(await expiresAt(sessionId), aged);
    await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    assert.ok((await expiresAt(sessionId)) > aged);
  });
});

describe('the body of a status read (D104, D199)', () => {
  const id = unknownId(9);
  const valid = JSON.stringify({ ids: [id] });
  const tooLarge = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);

  const refusals: [string, Record<string, string>, string | Buffer, number, ApiError][] = [
    [
      'a body with no Content-Type',
      {},
      valid,
      415,
      { errorCode: 1007, message: 'Content-Type must be application/json' },
    ],
    [
      'a text/plain body',
      { 'content-type': 'text/plain' },
      valid,
      415,
      { errorCode: 1007, message: 'Content-Type must be application/json' },
    ],
    [
      'a Content-Type naming two media types',
      { 'content-type': 'application/json, application/json' },
      valid,
      415,
      { errorCode: 1007, message: 'Content-Type must be application/json' },
    ],
    [
      'a text/plain body over 1 MiB, by its media type before its size',
      { 'content-type': 'text/plain' },
      tooLarge,
      415,
      { errorCode: 1007, message: 'Content-Type must be application/json' },
    ],
    [
      'a JSON body over 1 MiB',
      JSON_HEADERS,
      tooLarge,
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
      '{"ids":',
      400,
      { errorCode: 1006, message: 'Request body must be a JSON object' },
    ],
    [
      'a JSON array',
      JSON_HEADERS,
      `["${id}"]`,
      400,
      { errorCode: 1006, message: 'Request body must be a JSON object' },
    ],
    [
      'bytes that are not UTF-8',
      JSON_HEADERS,
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
      400,
      { errorCode: 1006, message: 'Request body must be a JSON object' },
    ],
    ['no ids key', JSON_HEADERS, '{}', 400, { errorCode: 1014, message: IDS_RULE }],
    ['no ids at all', JSON_HEADERS, '{"ids":[]}', 400, { errorCode: 1014, message: IDS_RULE }],
    [
      '51 ids',
      JSON_HEADERS,
      JSON.stringify({ ids: Array.from({ length: 51 }, (_, n) => unknownId(200 + n)) }),
      400,
      { errorCode: 1014, message: IDS_RULE },
    ],
    [
      'a malformed id',
      JSON_HEADERS,
      JSON.stringify({ ids: [id.slice(1)] }),
      400,
      { errorCode: 1014, message: ID_RULE },
    ],
    [
      'an id that is not a string',
      JSON_HEADERS,
      '{"ids":[43]}',
      400,
      { errorCode: 1014, message: ID_RULE },
    ],
    [
      'a repeated id',
      JSON_HEADERS,
      JSON.stringify({ ids: [id, unknownId(10), id] }),
      400,
      { errorCode: 1014, message: REPEATED_ID_RULE },
    ],
    [
      'a key other than ids',
      JSON_HEADERS,
      JSON.stringify({ ids: [id], extend: false }),
      400,
      { errorCode: 1014, message: KEYS_RULE },
    ],
  ];

  for (const [description, headers, payload, status, expected] of refusals) {
    it(`answers ${status} / ${expected.errorCode} for ${description}`, async () => {
      const response = await post(payload, headers);

      assert.equal(response.statusCode, status, response.body);
      // The whole body, so that a divergent message or an extra field fails.
      assert.deepEqual(response.json(), expected);
    });
  }

  it('accepts a Content-Type with parameters and in any letter case', async () => {
    const response = await post(valid, { 'content-type': 'Application/JSON; charset=utf-8' });

    assert.equal(response.statusCode, 200, response.body);
  });

  it('leaves GET and DELETE on the same path a session id that cannot be one', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/api/sessions/status' });

      assert.equal(response.statusCode, 404, method);
      assert.deepEqual(response.json(), { errorCode: 1001, message: 'Session not found' });
    }
  });

  it('is not served by the receive listener', async () => {
    const response = await receiver.inject({
      method: 'POST',
      url: '/api/sessions/status',
      headers: JSON_HEADERS,
      payload: valid,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json<ApiError>().errorCode, 1000);
  });
});

describe('what a status read leaves in the log (D059, D199)', () => {
  /** Every run of 8 characters of `id`: a piece the redaction would keep, or more. */
  function pieces(id: string): string[] {
    return Array.from({ length: id.length - 7 }, (_, at) => id.slice(at, at + 8));
  }

  it('holds no piece of any id: successful, refused and wrongly sent', async () => {
    // Made and fed before the log is read from: their creation and captures
    // log URLs of their own, shortened to 8 characters (D059).
    const active = await newSession();
    const expired = await newSession();

    await capture(active);

    const unknown = 'Lg4Pw9Rk2Ns7Tq1Vx5Zb8Cd3Fh6Jm0Wy4Ea9Gu2Io7K';
    const ids = [active, expired, unknown];
    const from = logChunks.length;

    const answers = [
      await whileExpired(pool, expired, () => post(JSON.stringify({ ids }))),
      await post(JSON.stringify({ ids: [active, active] })),
      await post(JSON.stringify({ ids: [`${unknown}x`, active] })),
      await post(JSON.stringify({ ids, [active]: unknown })),
      await post(JSON.stringify({ ids: [...ids, ...Array.from({ length: 48 }, () => unknown)] })),
      await post(`{"ids":["${active}"`),
      await post(JSON.stringify({ ids }), { 'content-type': 'text/plain' }),
      await post(JSON.stringify({ ids, padding: 'x'.repeat(MAX_BODY_BYTES) })),
    ];

    assert.deepEqual(
      answers.map((answer) => answer.statusCode),
      [200, 400, 400, 400, 400, 400, 415, 413],
    );

    const log = logChunks.slice(from).join('');

    // The log is the real one: it has a line for each of these requests.
    assert.ok((log.match(/\/api\/sessions\/status/g)?.length ?? 0) >= answers.length, log);
    assert.ok(log.includes('"statusCode":200'), 'the log holds no successful read');
    assert.ok(log.includes('"statusCode":400'), 'the log holds no refused read');

    for (const id of ids) {
      for (const piece of pieces(id)) {
        assert.ok(!log.includes(piece), `the log holds "${piece}", a piece of a session id`);
      }
    }

    // Nor does an error body quote one (D106).
    for (const answer of answers.slice(1)) {
      for (const id of ids) {
        assert.ok(!answer.body.includes(id.slice(0, 8)), answer.body);
      }
    }
  });
});
