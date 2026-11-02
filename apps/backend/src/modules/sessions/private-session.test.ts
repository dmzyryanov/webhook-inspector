/**
 * Creating a private session through the API (D253, issue #227, criteria 1 to
 * 4): `POST /api/sessions` with `"private": true` draws a key and answers it
 * once, or creates the session under the key `Authorization: Bearer` carries,
 * or refuses a header that carries no key; without `private` the header is
 * ignored as it always was. Beside `access-key.test.ts`, which tests the check
 * itself (D245), and `access-key-paths.test.ts`, which walks every path
 * against a keyed session, one of them created here.
 *
 * And, without a server, what `parseCreateSessionBody` takes for `private`,
 * where its refusal stands among the create body's checks, and made-up bodies
 * built to break it at 1 KiB, 64 KiB and 1 MiB.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { MAX_BODY_BYTES, SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { AppError } from '../../errors/app-error.ts';
import { buildTestServers, LIMITS_OUT_OF_REACH, type TestServers } from '../../testing/servers.ts';
import { withinBound } from '../../testing/timing.ts';
import { MAX_AUTHORIZATION_LENGTH } from './access-key.ts';
import {
  CREATION_KEY_RULE,
  parseCreateSessionBody,
  parsePrivate,
  PRIVATE_RULE,
  STORE_SOURCE_IP_RULE,
  UNKNOWN_CREATE_KEY_RULE,
  type CreateSessionRequest,
} from './response-config.ts';
import { KEYS_RULE } from './status-body.ts';

/** A key the server never drew, which a creation takes all the same (D253, decision 3). */
const KEY = 'Pv4Kq8Zx2Wm6Nb1Lc7Hj3Rt9Fd5Sg0Ya2Ue7Io4TmNq';
const OTHER = 'Wr5Tn2Bv8Cx1Zl6Kj9Hg3Fd7Sa0Qp4Ow2Ie8Uy5Rt1M';
/** A key of the shape ids had before D161, with `_` and `-`. */
const OLDER_SHAPE = 'Au6JqVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2m_-MKss';

const NOT_FOUND = { errorCode: 1001, message: 'Session not found' };
const NO_KEY = { errorCode: 1005, message: CREATION_KEY_RULE };

const SIZES = [1024, 64 * 1024, MAX_BODY_BYTES];

/** Generous for a body the size of the limit; a regression to quadratic time is seconds. */
const BOUND_MS = 500;

let pool: pg.Pool;
let servers: TestServers;
let app: FastifyInstance;
let receiver: FastifyInstance;
const logLines: string[] = [];
const createdSessionIds: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(pool, {
      rateLimits: LIMITS_OUT_OF_REACH,
      logDestination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          logLines.push(chunk.toString('utf8'));
          callback();
        },
      }),
    });
    ({ api: app, receiver } = servers);
    await servers.ready();
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await servers?.close();
  await pool?.end();
});

interface Answer {
  status: number;
  body: string;
  headers: Record<string, unknown>;
  json: Record<string, unknown>;
}

/**
 * `POST /api/sessions` with `body` as JSON - none at all when `undefined` -
 * and `authorization` when given. A created session is deleted after the file.
 */
async function create(body: unknown, authorization?: string): Promise<Answer> {
  const headers: Record<string, string> = {};

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (authorization !== undefined) {
    headers.authorization = authorization;
  }

  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  const json = response.json<Record<string, unknown>>();

  if (response.statusCode === 201) {
    createdSessionIds.push(json.id as string);
  }

  return { status: response.statusCode, body: response.body, headers: response.headers, json };
}

/** `GET /api/sessions/:sessionId` with `key` as `Authorization: Bearer`, when given. */
async function read(sessionId: string, key?: string): Promise<Answer> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}`,
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
  });

  return {
    status: response.statusCode,
    body: response.body,
    headers: response.headers,
    json: response.json<Record<string, unknown>>(),
  };
}

/** The fingerprint the row of `sessionId` holds, `null` for a public session. */
async function fingerprint(sessionId: string): Promise<Buffer | null> {
  const result = await pool.query<{ access_key_hash: Buffer | null }>(
    'SELECT access_key_hash FROM sessions WHERE id = $1',
    [sessionId],
  );

  assert.equal(result.rowCount, 1, 'no such session');

  return result.rows[0]?.access_key_hash ?? null;
}

function sha256(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/** A body whose one rule carries `marker` in its path: what a creation would have stored. */
function markedBody(marker: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    private: true,
    rules: [{ method: 'POST', path: `/${marker}`, response: { status: 200 } }],
    ...extra,
  };
}

/** How many sessions hold a rule whose path carries `marker`: how many such creations stored one. */
async function storedWith(marker: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM sessions WHERE response_rules::text LIKE '%' || $1 || '%'",
    [marker],
  );

  return result.rows[0]?.count as number;
}

/** Every place a key could have been written: the session's row, its requests and its events. */
async function storedText(sessionId: string): Promise<string> {
  const result = await pool.query<{ text: string }>(
    `SELECT concat_ws(' ',
              (SELECT to_jsonb(s)::text FROM sessions s WHERE s.id = $1),
              (SELECT jsonb_agg(to_jsonb(r))::text FROM requests r WHERE r.session_id = $1),
              (SELECT jsonb_agg(to_jsonb(e))::text FROM realtime_events e WHERE e.session_id = $1)
            ) AS text`,
    [sessionId],
  );

  return result.rows[0]?.text ?? '';
}

describe('the keys these tests use', () => {
  it('have a key’s shape, a session id’s', () => {
    for (const value of [KEY, OTHER, OLDER_SHAPE]) {
      assert.match(value, SESSION_ID_PATTERN);
    }
  });
});

describe('a private session with a key the server draws (D253, criterion 1)', () => {
  it('answers 201 with private: true and an accessKey of 43 letters and digits, which opens it and nothing else does', async () => {
    const created = await create({ private: true });

    assert.equal(created.status, 201, created.body);
    assert.deepEqual(Object.keys(created.json), [
      'id',
      'expiresAt',
      'receiveUrl',
      'private',
      'accessKey',
    ]);
    assert.equal(created.json.private, true);

    const id = created.json.id as string;
    const key = created.json.accessKey as string;

    assert.match(key, /^[A-Za-z0-9]{43}$/);
    assert.notEqual(key, id);
    // The row keeps the key's SHA-256 fingerprint and never the key.
    assert.deepEqual(await fingerprint(id), sha256(key));

    // Opened by its key, answered `private: true`, and never with the key again.
    const opened = await read(id, key);

    assert.equal(opened.status, 200, opened.body);
    assert.equal(opened.json.private, true);
    assert.equal(opened.json.id, id);
    assert.ok(!Object.hasOwn(opened.json, 'accessKey'));
    assert.ok(!opened.body.includes(key));

    // Without a key, with another, or with its id, as a session that does not exist.
    for (const presented of [undefined, OTHER, id, key.toLowerCase()]) {
      const refused = await read(id, presented);

      assert.equal(refused.status, 404, `${presented ?? 'no key'}: ${refused.body}`);
      assert.deepEqual(refused.json, NOT_FOUND);
    }
  });

  it('draws a new key for each session', async () => {
    const first = await create({ private: true });
    const second = await create({ private: true });

    assert.equal(first.status, 201, first.body);
    assert.equal(second.status, 201, second.body);
    assert.notEqual(first.json.accessKey, second.json.accessKey);
    assert.equal(
      (await read(first.json.id as string, second.json.accessKey as string)).status,
      404,
    );
  });

  it('writes the key in no row, no log line, no event and no header', async () => {
    const logFrom = logLines.length;
    const created = await create({ private: true, response: { status: 202 } });
    const id = created.json.id as string;
    const key = created.json.accessKey as string;

    for (const [name, value] of Object.entries(created.headers)) {
      assert.ok(!String(value).includes(key), `the ${name} header holds the key`);
    }

    // A capture, a read and a change with the key, each writing to the row,
    // the requests or the outbox.
    const captured = await receiver.inject({
      method: 'POST',
      url: `/s/${id}/orders`,
      headers: { 'content-type': 'application/json' },
      payload: '{"order":1}',
    });

    assert.equal(captured.statusCode, 202, captured.body);
    await servers.writes.settled();

    const changed = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/response`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      payload: JSON.stringify({ mode: 'default' }),
    });

    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await read(id, key)).status, 200);
    await servers.flush();

    const stored = await storedText(id);

    assert.ok(stored.includes(id), 'the stored text was not read');
    assert.ok(!stored.includes(key), 'the key was stored');
    // The calls above wrote log lines, so the two checks below read them.
    assert.ok(logLines.length > logFrom, 'the calls above wrote no log line');
    assert.ok(!logLines.join('').includes(key), 'the key was logged');
    // The log keeps an 8-character prefix of an id (D059): no prefix of the
    // key either, since nothing writes the key to the log at all.
    assert.ok(!logLines.join('').includes(key.slice(0, 8)), 'a prefix of the key was logged');
  });
});

describe('a private session under a key the caller sends (D253, criterion 2)', () => {
  it('answers 201 with private: true and no accessKey; the one key opens both sessions, and nothing else does', async () => {
    // The scheme in any letter case and one or more spaces, as on every path (D245).
    const first = await create({ private: true }, `Bearer ${KEY}`);
    const second = await create({ private: true, storeSourceIp: false }, `bearer   ${KEY}`);

    for (const created of [first, second]) {
      assert.equal(created.status, 201, created.body);
      assert.equal(created.json.private, true);
      assert.ok(!Object.hasOwn(created.json, 'accessKey'));
      assert.ok(!created.body.includes(KEY));

      for (const value of Object.values(created.headers)) {
        assert.ok(!String(value).includes(KEY));
      }

      assert.deepEqual(await fingerprint(created.json.id as string), sha256(KEY));
    }

    const ids = [first.json.id as string, second.json.id as string];

    for (const id of ids) {
      const opened = await read(id, KEY);

      assert.equal(opened.status, 200, opened.body);
      assert.equal(opened.json.private, true);

      for (const presented of [undefined, OTHER, OLDER_SHAPE]) {
        assert.deepEqual((await read(id, presented)).json, NOT_FOUND);
      }
    }

    // The status read reports both with the key beside each id, and neither without.
    const status = async (body: unknown) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/sessions/status',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify(body),
        })
      ).json<{ sessions: { id: string; state: string }[] }>().sessions;

    assert.deepEqual(
      (await status({ ids, accessKeys: { [ids[0] as string]: KEY, [ids[1] as string]: KEY } })).map(
        (entry) => [entry.id, entry.state],
      ),
      [
        [ids[0], 'active'],
        [ids[1], 'active'],
      ],
    );
    assert.deepEqual(
      (await status({ ids })).map((entry) => entry.state),
      ['not_found', 'not_found'],
    );
    assert.deepEqual(
      (await status({ ids, accessKeys: { [ids[0] as string]: OTHER } })).map(
        (entry) => entry.state,
      ),
      ['not_found', 'not_found'],
    );
  });

  it('takes a key of the older shape and a key at the 256-character bound, and many creations under one key at once', async () => {
    const older = await create({ private: true }, `Bearer ${OLDER_SHAPE}`);

    assert.equal(older.status, 201, older.body);
    assert.equal((await read(older.json.id as string, OLDER_SHAPE)).status, 200);

    // `Bearer`, spaces and the key, 256 characters in all: D245's bound.
    const padded = `Bearer${' '.repeat(MAX_AUTHORIZATION_LENGTH - 6 - KEY.length)}${KEY}`;

    assert.equal(padded.length, MAX_AUTHORIZATION_LENGTH);

    const atBound = await create({ private: true }, padded);

    assert.equal(atBound.status, 201, atBound.body);
    assert.equal((await read(atBound.json.id as string, KEY)).status, 200);

    const many = await Promise.all(
      Array.from({ length: 20 }, () => create({ private: true }, `Bearer ${OTHER}`)),
    );

    assert.equal(new Set(many.map((created) => created.json.id)).size, 20);

    for (const created of many) {
      assert.equal(created.status, 201, created.body);
      assert.equal((await read(created.json.id as string, OTHER)).status, 200);
    }
  });
});

describe('an Authorization that carries no key (D253, criterion 3)', () => {
  /** Every header a private creation is refused for, each beside what it is. */
  const NO_KEY_HEADERS: [string, string][] = [
    ['another scheme', `Basic ${KEY}`],
    ['another scheme of a key’s length', `Token ${KEY}`],
    ['the key with no scheme', KEY],
    ['Bearer alone', 'Bearer'],
    ['Bearer and a space', 'Bearer '],
    ['an empty header', ''],
    ['42 characters', `Bearer ${KEY.slice(1)}`],
    ['44 characters', `Bearer ${KEY}x`],
    ['a +', `Bearer ${KEY.slice(1)}+`],
    ['a .', `Bearer ${KEY.slice(1)}.`],
    ['a =', `Bearer ${KEY.slice(2)}==`],
    ['a non-ASCII letter', `Bearer ${KEY.slice(1)}é`],
    ['a tab for the space', `Bearer\t${KEY}`],
    ['two keys', `Bearer ${KEY} ${OTHER}`],
    ['a comma and a second credential', `Bearer ${KEY}, Bearer ${OTHER}`],
    [
      '257 characters, a key behind spaces',
      `Bearer${' '.repeat(MAX_AUTHORIZATION_LENGTH + 1 - 6 - KEY.length)}${KEY}`,
    ],
    ['257 characters of a key’s alphabet', `Bearer ${'A'.repeat(250)}`],
  ];

  it('refuses a private creation 400 / 1005 with one message, creates nothing, and quotes nothing', async () => {
    for (const [what, header] of NO_KEY_HEADERS) {
      const marker = randomBytes(8).toString('hex');
      const refused = await create(markedBody(marker), header);

      assert.equal(refused.status, 400, `${what}: ${refused.body}`);
      // One fixed message, so no value of the header can be in it (D106).
      assert.deepEqual(refused.json, NO_KEY, what);
      assert.equal(await storedWith(marker), 0, `${what} created a session`);
    }

    assert.equal(
      CREATION_KEY_RULE,
      'With "private": true, Authorization must be Bearer and an access key of 43 characters of A-Z, a-z, 0-9, _ and -, or be left out for the server to draw one',
    );
  });

  it('refuses headers of growing size within a bound, and creates nothing', async () => {
    // Node's own limit on a request's headers is 16 KiB, which the proxy and
    // the listener answer before any route; within it, each is refused alike.
    for (const size of [1024, 8 * 1024, 15 * 1024]) {
      for (const header of [
        `Bearer ${'A'.repeat(size)}`,
        `Bearer${' '.repeat(size)}${KEY}`,
        `${'Bearer '.repeat(Math.floor(size / 7))}${KEY}`,
      ]) {
        const marker = randomBytes(8).toString('hex');
        const started = performance.now();
        const refused = await create(markedBody(marker), header);

        assert.ok(performance.now() - started < 2_000, `${size}: too slow`);
        assert.deepEqual(refused.json, NO_KEY, `${size}`);
        assert.equal(await storedWith(marker), 0);
      }
    }
  });

  it('is checked after every rule of the body, so a body breaking one is told about that', async () => {
    const bad = `Basic ${KEY}`;

    assert.deepEqual((await create({ private: true, storeSourceIp: 'no' }, bad)).json, {
      errorCode: 1005,
      message: STORE_SOURCE_IP_RULE,
      field: 'storeSourceIp',
    });
    assert.deepEqual((await create({ private: true, other: 1 }, bad)).json, {
      errorCode: 1005,
      message: UNKNOWN_CREATE_KEY_RULE,
    });
    assert.deepEqual((await create({ private: 'yes' }, bad)).json, {
      errorCode: 1005,
      message: PRIVATE_RULE,
      field: 'private',
    });
  });
});

describe('a creation without private (D253, criterion 4)', () => {
  it('ignores Authorization without private and with private: false, a valid key included', async () => {
    for (const body of [undefined, {}, { private: false }, { response: { status: 201 } }]) {
      for (const header of [undefined, `Bearer ${KEY}`, `Basic ${KEY}`, 'Bearer', '']) {
        const what = `${JSON.stringify(body) ?? 'no body'} with ${header ?? 'no Authorization'}`;
        const created = await create(body, header);

        assert.equal(created.status, 201, `${what}: ${created.body}`);
        assert.deepEqual(Object.keys(created.json), ['id', 'expiresAt', 'receiveUrl', 'private']);
        assert.equal(created.json.private, false, what);

        const id = created.json.id as string;

        assert.equal(await fingerprint(id), null, what);

        // A public session, opened by its id alone, whatever key is sent.
        for (const presented of [undefined, KEY, OTHER]) {
          const opened = await read(id, presented);

          assert.equal(opened.status, 200, what);
          assert.equal(opened.json.private, false, what);
        }
      }
    }
  });

  it('refuses a private that is not a boolean 400 / 1005, naming the field and quoting nothing', async () => {
    for (const value of ['true', 'false', 1, 0, {}, [], [true], { private: true }]) {
      const marker = randomBytes(8).toString('hex');
      const refused = await create(markedBody(marker, { private: value }), `Bearer ${KEY}`);

      assert.equal(refused.status, 400, JSON.stringify(value));
      assert.deepEqual(refused.json, { errorCode: 1005, message: PRIVATE_RULE, field: 'private' });
      assert.equal(await storedWith(marker), 0);
    }

    assert.deepEqual((await create({ private: null })).json, {
      errorCode: 1005,
      message: `${PRIVATE_RULE}; omit it for a public session`,
      field: 'private',
    });
  });

  it('keeps every other answer of the status read: its unknown key names ids and accessKeys', async () => {
    const answer = await app.inject({
      method: 'POST',
      url: '/api/sessions/status',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ids: [KEY], private: true }),
    });

    assert.equal(answer.statusCode, 400);
    assert.deepEqual(answer.json(), { errorCode: 1014, message: KEYS_RULE });
    assert.equal(
      KEYS_RULE,
      'The request body may contain no key other than "ids" and "accessKeys"',
    );
  });
});

/** The refusal `parse` throws, or a failure when it throws none. */
function refusal(parse: () => unknown): AppError {
  try {
    parse();
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
    assert.equal(error.statusCode, 400, error.message);

    return error;
  }

  assert.fail('nothing was refused');
}

/** What the create parser answers for `body`: what it read, or its refusal. */
function outcome(body: string): CreateSessionRequest | AppError {
  try {
    return parseCreateSessionBody(body);
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
    assert.equal(error.statusCode, 400, error.message);

    return error;
  }
}

describe('parseCreateSessionBody: private (D253)', () => {
  it('is false with no body, with {} and with the key left out, and the JSON boolean otherwise', () => {
    assert.equal(parseCreateSessionBody(undefined).private, false);
    assert.equal(parseCreateSessionBody('{}').private, false);
    assert.equal(parseCreateSessionBody('{"storeSourceIp":false}').private, false);
    assert.equal(parseCreateSessionBody('{"private":true}').private, true);
    assert.equal(parseCreateSessionBody('{"private":false}').private, false);
    // Of duplicate keys the last is taken, as JSON.parse does.
    assert.equal(parseCreateSessionBody('{"private":false,"private":true}').private, true);
    assert.equal(parsePrivate(true), true);
    assert.equal(parsePrivate(false), false);
  });

  it('stands beside every other key of a creation', () => {
    const read = parseCreateSessionBody(
      JSON.stringify({
        response: { status: 201 },
        queue: { steps: [{ status: 503 }] },
        expiresAfterIdleSeconds: 3600,
        storeSourceIp: false,
        rules: [{ method: 'GET', path: '/a', response: { status: 200 } }],
        private: true,
      }),
    );

    assert.equal(read.private, true);
    assert.equal(read.storeSourceIp, false);
    assert.equal(read.expiresAfterIdleSeconds, 3600);
    assert.equal(read.rules.length, 1);
    assert.equal(read.queue?.length, 1);
  });

  it('is checked after every other key and before an unknown one', () => {
    for (const [body, message] of [
      ['{"response":{"status":99},"private":"x"}', /^response\.status /],
      ['{"expiresInSeconds":5,"private":"x"}', /^expiresInSeconds /],
      ['{"storeSourceIp":"x","private":"x"}', new RegExp(`^${STORE_SOURCE_IP_RULE}$`)],
      ['{"rules":null,"private":"x"}', /^rules /],
      ['{"private":"x","other":1}', new RegExp(`^${PRIVATE_RULE}$`)],
      ['{"private":true,"other":1}', /^The request body may contain no key other than /],
      ['{"Private":true}', /^The request body may contain no key other than /],
      ['{"response":{"status":200,"private":true}}', /^response may contain no key other than /],
    ] as const) {
      const error = refusal(() => parseCreateSessionBody(body));

      assert.equal(error.errorCode, 1005, body);
      assert.match(error.message, message, body);
    }

    assert.equal(
      UNKNOWN_CREATE_KEY_RULE,
      'The request body may contain no key other than "response", "queue", "expiresInSeconds", "expiresAfterIdleSeconds", "storeSourceIp", "rules" and "private"',
    );
  });

  it('refuses made-up bodies of growing size within a bound, quoting none of them', () => {
    for (const size of SIZES) {
      const text = 'x'.repeat(size - 20);
      const depth = Math.floor((size - 20) / 2);

      for (const body of [
        `{"private":"${text}"}`,
        `{"private":${'['.repeat(depth)}${']'.repeat(depth)}}`,
        `{"private":{"${text.slice(0, size / 2)}":true}}`,
        `{"private":true,"${text}":1}`,
        `{"private":${'1'.repeat(size - 20)}}`,
      ]) {
        const answer = withinBound(BOUND_MS, () => outcome(body));

        assert.ok(answer instanceof AppError, `${size}: ${body.slice(0, 40)} was taken`);
        assert.ok(answer.message.length < 300, answer.message);
        assert.ok(!answer.message.includes('xxxxxxxx'), 'the value was quoted');
      }
    }
  });
});
