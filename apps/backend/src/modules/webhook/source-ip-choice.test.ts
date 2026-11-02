/**
 * A session that keeps no sender address (D243, issue #166), at the database
 * and the capture's own function: migration 014's trigger holds every writer
 * of a request to the session's choice, the previous image's literal insert
 * included; migration 015's holds the record of a default answer to the row
 * it answers, the previous image's record included, and since migration 019
 * (D251) never touches the record of a step's, a rule's or the session's
 * custom response, a template's included; and `storeRequest` writes
 * `NULL` itself and builds its answer and its event from the row it wrote,
 * never from the address it was given.
 *
 * The base image, 1.1.0 (`f3f797e`), keeps running on this schema after a
 * `helm rollback`, which never undoes a migration (D055), and beside this
 * image during a rolling update (D221). Its capture's two inserts, copied from
 * `apps/backend/src/modules/webhook/repository.ts` as it stood there, write
 * the address it read without knowing `store_source_ip`: into the request,
 * and into the default answer it composes and records. It composes that
 * answer with `response.ts` and `raw-response.ts`, which this image keeps
 * unchanged, so the record replayed here is the one it writes.
 *
 * What the API answers about such a session is in `sessions.test.ts`,
 * `webhook.test.ts`, `trust-boundary.test.ts` and `mcp.test.ts`.
 *
 * Start the database and apply migrations first:
 *   npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  buildInspectorUrl,
  type ResponseConfig,
  type WebhookDefaultAnswer,
} from '@webhook-inspector/shared';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { getRequestDetails } from '../requests/service.ts';
import { changeSessionResponse, createSession } from '../sessions/service.ts';
import {
  INSERT_REQUEST_SQL,
  INSERT_RESPONSE_SQL,
  storeRequest,
  type CapturedRequest,
} from './repository.ts';
import {
  composeWebhookResponse,
  NOTHING_CARRIED,
  type ComposedResponse,
  type RequestFacts,
} from './response.ts';

/** The capture's insert of the base image, 1.1.0, as it stood there. */
const BASE_IMAGE_REQUEST_INSERT = `INSERT INTO requests
         (session_id, method, path, http_version, query_string, headers, body, body_size,
          raw_request, source_ip, received_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bytea, $8, $9::bytea || $7::bytea, $10,
               clock_timestamp())
       RETURNING id, received_at`;

/** Its capture's lock, stripped to what it selects: no column of this release. */
const BASE_IMAGE_CAPTURE_LOCK = 'SELECT id FROM sessions WHERE id = $1 FOR UPDATE';

/** Its insert of its answer's record, as it stood there. */
const BASE_IMAGE_RESPONSE_INSERT = `INSERT INTO request_responses
         (request_id, state, status, headers, body, body_size, body_suppressed, raw_response,
          delay_ms, started_at, queue_step_index, queue_step_total)
       VALUES ($1, 'pending', $2, $3::jsonb, $4, $5, $6, $7, $8, clock_timestamp(), $9, $10)`;

const SENDER = '203.0.113.7';
const SENDER_V6 = '2001:db8::7';
const ORIGIN = 'https://qa-tools.example';

let pool: pg.Pool;
const createdSessionIds: string[] = [];

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    await pool.query('SELECT 1');
  })();
  await startup;
});

after(async () => {
  await startup?.catch(() => undefined);

  if (createdSessionIds.length > 0) {
    await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [createdSessionIds]);
  }

  await pool?.end();
});

/** A session created as the API creates one, keeping the address or not. */
async function newSession(storeSourceIp: boolean): Promise<string> {
  const { id } = await createSession(pool, null, null, null, null, storeSourceIp);

  createdSessionIds.push(id);

  return id;
}

/** The parameters of the base image's insert for one small capture from `address`. */
function baseInsertValues(sessionId: string, address: string | null): unknown[] {
  const body = Buffer.from('captured by the base image');

  return [
    sessionId,
    'POST',
    `/s/${sessionId}`,
    '1.1',
    '',
    JSON.stringify([
      ['content-type', 'text/plain'],
      ['x-forwarded-for', '192.0.2.5'],
    ]),
    body,
    body.byteLength,
    Buffer.from(`POST /s/${sessionId} HTTP/1.1\r\n\r\n`),
    address,
  ];
}

/** One capture as the base image makes it: its lock, then its insert, in its transaction. */
async function captureAsBaseImage(sessionId: string, address: string | null): Promise<string> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    assert.equal((await client.query(BASE_IMAGE_CAPTURE_LOCK, [sessionId])).rowCount, 1);

    const inserted = await client.query<{ id: string }>(
      BASE_IMAGE_REQUEST_INSERT,
      baseInsertValues(sessionId, address),
    );

    await client.query('COMMIT');

    return inserted.rows[0]?.id as string;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function storedAddress(requestId: string): Promise<string | null> {
  const result = await pool.query<{ source_ip: string | null }>(
    'SELECT source_ip FROM requests WHERE id = $1',
    [requestId],
  );

  assert.equal(result.rowCount, 1, `request ${requestId} is not stored`);

  return result.rows[0]?.source_ip ?? null;
}

describe('the base image on the new schema (criterion 5, D243)', () => {
  it('runs the insert this image runs, but for the address it returns', () => {
    assert.equal(
      INSERT_REQUEST_SQL,
      BASE_IMAGE_REQUEST_INSERT.replace(
        'RETURNING id, received_at',
        'RETURNING id, received_at, source_ip',
      ),
    );
  });

  for (const address of [SENDER, SENDER_V6]) {
    it(`stores no address for an opted-out session when its insert writes ${address}, and keeps it for a default one`, async () => {
      const opted = await newSession(false);
      const kept = await newSession(true);

      assert.equal(await storedAddress(await captureAsBaseImage(opted, address)), null);
      assert.equal(await storedAddress(await captureAsBaseImage(kept, address)), address);
    });
  }

  it('keeps the headers it writes, forwarding headers included, as sent (Decision 6)', async () => {
    const opted = await newSession(false);
    const requestId = await captureAsBaseImage(opted, SENDER);
    const stored = await pool.query<{ headers: [string, string][] }>(
      'SELECT headers FROM requests WHERE id = $1',
      [requestId],
    );

    assert.deepEqual(stored.rows[0]?.headers, [
      ['content-type', 'text/plain'],
      ['x-forwarded-for', '192.0.2.5'],
    ]);
  });

  it('writes a request without an address into either session as it is', async () => {
    for (const storeSourceIp of [false, true]) {
      const sessionId = await newSession(storeSourceIp);

      assert.equal(await storedAddress(await captureAsBaseImage(sessionId, null)), null);
    }
  });
});

describe('every writer of a request is held to the choice (criterion 5, D243)', () => {
  it('turns an update that writes an address into an opted-out session’s request into NULL', async () => {
    const opted = await newSession(false);
    const kept = await newSession(true);
    const optedRequest = await captureAsBaseImage(opted, null);
    const keptRequest = await captureAsBaseImage(kept, null);

    await pool.query('UPDATE requests SET source_ip = $2 WHERE id = $1', [optedRequest, SENDER]);
    await pool.query('UPDATE requests SET source_ip = $2 WHERE id = $1', [keptRequest, SENDER]);

    assert.equal(await storedAddress(optedRequest), null);
    assert.equal(await storedAddress(keptRequest), SENDER);
  });

  it('drops the address of a request moved into an opted-out session', async () => {
    const opted = await newSession(false);
    const kept = await newSession(true);
    const requestId = await captureAsBaseImage(kept, SENDER);

    assert.equal(await storedAddress(requestId), SENDER);

    await pool.query('UPDATE requests SET session_id = $2 WHERE id = $1', [requestId, opted]);

    assert.equal(await storedAddress(requestId), null);
  });

  it('leaves an update of anything else alone', async () => {
    const kept = await newSession(true);
    const requestId = await captureAsBaseImage(kept, SENDER);

    await pool.query("UPDATE requests SET method = 'PUT' WHERE id = $1", [requestId]);

    assert.equal(await storedAddress(requestId), SENDER);
  });

  it('defaults every session to keeping the address, NOT NULL', async () => {
    const column = await pool.query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'store_source_ip'`,
    );

    assert.deepEqual(column.rows, [{ column_default: 'true', is_nullable: 'NO' }]);
  });

  it('fixes the function’s search_path and grants PUBLIC no EXECUTE, as for record_usage_days', async () => {
    const fn = await pool.query<{ config: string[] | null; public_execute: boolean }>(
      `SELECT p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'requests_source_ip_choice'`,
    );

    assert.deepEqual(fn.rows, [
      { config: ['search_path=pg_catalog, pg_temp'], public_execute: false },
    ]);

    const trigger = await pool.query<{ definition: string }>(
      `SELECT pg_get_triggerdef(t.oid) AS definition
         FROM pg_trigger t
        WHERE t.tgrelid = 'public.requests'::regclass AND t.tgname = 'requests_source_ip_choice'`,
    );

    assert.equal(
      trigger.rows[0]?.definition,
      'CREATE TRIGGER requests_source_ip_choice BEFORE INSERT OR UPDATE OF source_ip, session_id ON public.requests FOR EACH ROW WHEN ((new.source_ip IS NOT NULL)) EXECUTE FUNCTION requests_source_ip_choice()',
    );
  });
});

describe('this image’s capture answers from the row it wrote (criterion 3, D243)', () => {
  for (const [storeSourceIp, expected] of [
    [false, null],
    [true, SENDER],
  ] as const) {
    it(`gives the event, the default answer and its record ${String(expected)} for a session with storeSourceIp ${String(storeSourceIp)}`, async () => {
      const sessionId = await newSession(storeSourceIp);
      const body = Buffer.from('{"event":"order.paid"}');
      const result = await storeRequest(
        pool,
        {
          sessionId,
          method: 'POST',
          path: `/s/${sessionId}`,
          httpVersion: '1.1',
          queryString: '',
          headers: [['content-type', 'application/json']],
          body,
          rawRequestHead: Buffer.from(`POST /s/${sessionId} HTTP/1.1\r\n\r\n`),
          sourceIp: SENDER,
        },
        'https://qa-tools.example',
      );

      assert.equal(result.outcome, 'stored');
      assert.ok(result.outcome === 'stored');
      assert.equal(result.request.sourceIp, expected);
      assert.equal(await storedAddress(result.request.id), expected);

      const answer = JSON.parse(
        result.composed.body?.toString('utf8') ?? '',
      ) as WebhookDefaultAnswer;

      assert.equal(answer.sourceIp, expected);

      const recorded = await pool.query<{ body: Buffer; raw_response: Buffer }>(
        'SELECT body, raw_response FROM request_responses WHERE request_id = $1',
        [result.request.id],
      );
      const event = await pool.query<{ payload: string }>(
        `SELECT payload FROM realtime_events WHERE request_id = $1 AND kind = 'request.received'`,
        [result.request.id],
      );

      assert.equal(event.rowCount, 1);

      const announced = JSON.parse(event.rows[0]?.payload ?? '') as {
        data: { sourceIp: string | null };
      };

      assert.equal(announced.data.sourceIp, expected);

      for (const text of [
        recorded.rows[0]?.body.toString('latin1') ?? '',
        recorded.rows[0]?.raw_response.toString('latin1') ?? '',
        event.rows[0]?.payload ?? '',
        JSON.stringify(result),
      ]) {
        assert.equal(text.includes(SENDER), storeSourceIp, text);
      }
    });
  }
});

/** What a capture of the base image sent and recorded, and what it knew. */
interface BaseAnswer {
  requestId: string;
  /** The facts it composed its answer from, the address it read among them. */
  facts: RequestFacts;
  /** The answer it sent, and the record it wrote of it. */
  sent: ComposedResponse;
}

/**
 * One capture as the base image makes it, its answer's record included: its
 * lock, its insert, then the answer it composes from the address it read, and
 * its insert of that answer's record, in its transaction.
 */
async function answerAsBaseImage(
  sessionId: string,
  address: string | null,
  options: { method?: string; path?: string; response?: ResponseConfig } = {},
): Promise<BaseAnswer> {
  const method = options.method ?? 'POST';
  const path = options.path ?? `/s/${sessionId}`;
  const values = baseInsertValues(sessionId, address);

  values[1] = method;
  values[2] = path;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    assert.equal((await client.query(BASE_IMAGE_CAPTURE_LOCK, [sessionId])).rowCount, 1);

    const inserted = await client.query<{ id: string; received_at: Date }>(
      BASE_IMAGE_REQUEST_INSERT,
      values,
    );
    const row = inserted.rows[0];

    assert.ok(row);

    const facts: RequestFacts = {
      requestId: row.id,
      inspectorUrl: buildInspectorUrl(ORIGIN, sessionId, row.id),
      receivedAt: row.received_at.toISOString(),
      method,
      path,
      bodySize: values[7] as number,
      sourceIp: address,
    };
    const response = options.response ?? null;
    const sent = composeWebhookResponse(response, facts, NOTHING_CARRIED);

    await client.query(BASE_IMAGE_RESPONSE_INSERT, [
      row.id,
      sent.status,
      JSON.stringify(sent.headers),
      sent.body,
      sent.body?.byteLength ?? 0,
      sent.bodySuppressed,
      sent.raw,
      response?.delayMs ?? 0,
      null,
      null,
    ]);

    await client.query('COMMIT');

    return { requestId: row.id, facts, sent };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** A response record's content columns, as a test writes or reads them. */
interface RecordContent {
  headers: [string, string][];
  body: Buffer | null;
  bodySize: number;
  bodySuppressed: boolean;
  raw: Buffer | null;
}

function contentOf(composed: ComposedResponse): RecordContent {
  return {
    headers: composed.headers,
    body: composed.body,
    bodySize: composed.body?.byteLength ?? 0,
    bodySuppressed: composed.bodySuppressed,
    raw: composed.raw,
  };
}

async function storedRecord(requestId: string): Promise<RecordContent> {
  const result = await pool.query<{
    headers: [string, string][];
    body: Buffer | null;
    body_size: number;
    body_suppressed: boolean;
    raw_response: Buffer | null;
  }>(
    `SELECT headers, body, body_size, body_suppressed, raw_response
       FROM request_responses WHERE request_id = $1`,
    [requestId],
  );
  const row = result.rows[0];

  assert.ok(row, `request ${requestId} has no response record`);

  return {
    headers: row.headers,
    body: row.body,
    bodySize: row.body_size,
    bodySuppressed: row.body_suppressed,
    raw: row.raw_response,
  };
}

/** Every byte and every header of a record, as one searchable text. */
function recordText(record: RecordContent): string {
  return [
    record.body?.toString('latin1') ?? '',
    record.raw?.toString('latin1') ?? '',
    JSON.stringify(record.headers),
  ].join('\n');
}

/** The record this image writes for the same capture: the answer from the row. */
function answerFromRow(facts: RequestFacts): RecordContent {
  return contentOf(composeWebhookResponse(null, { ...facts, sourceIp: null }, NOTHING_CARRIED));
}

describe('the base image’s record of its default answer (criterion 5, D243, migration 015)', () => {
  it('is written by the statement this image writes its record with, but for the rule that answered', () => {
    // This image's insert is the base's with the three columns of the rule
    // that answered after its own (D246, migration 017), and nothing else
    // changed: the trigger sees the same row from either image.
    assert.equal(
      INSERT_RESPONSE_SQL,
      BASE_IMAGE_RESPONSE_INSERT.replace(
        'queue_step_index, queue_step_total)',
        'queue_step_index, queue_step_total,\n          rule_index, rule_method, rule_path)',
      ).replace('$9, $10)', '$9, $10,\n               $11, $12, $13)'),
    );
  });

  for (const address of [SENDER, SENDER_V6]) {
    for (const method of ['POST', 'GET', 'HEAD']) {
      it(`is stored as this image stores it for an opted-out session, a ${method} from ${address}, and as the base wrote it for a default one`, async () => {
        const opted = await answerAsBaseImage(await newSession(false), address, { method });
        const kept = await answerAsBaseImage(await newSession(true), address, { method });

        // The base image sent the address in both answers.
        assert.ok(opted.sent.body?.toString('utf8').endsWith(`"sourceIp":"${address}"}`));
        assert.ok(kept.sent.body?.toString('utf8').endsWith(`"sourceIp":"${address}"}`));

        const optedRecord = await storedRecord(opted.requestId);

        assert.deepEqual(optedRecord, answerFromRow(opted.facts));
        assert.equal(optedRecord.bodySuppressed, method === 'HEAD');
        assert.equal(recordText(optedRecord).includes(address), false, recordText(optedRecord));
        assert.equal(await storedAddress(opted.requestId), null);

        assert.deepEqual(await storedRecord(kept.requestId), contentOf(kept.sent));
        assert.equal(await storedAddress(kept.requestId), address);
      });
    }
  }

  it('gives a detail of such a capture that names no address', async () => {
    const sessionId = await newSession(false);
    const captured = await answerAsBaseImage(sessionId, SENDER);
    const detail = await getRequestDetails(pool, sessionId, captured.requestId);

    assert.equal(JSON.stringify(detail).includes(SENDER), false, JSON.stringify(detail));
    assert.equal(detail.sourceIp, null);

    const answer = JSON.parse(detail.response?.body ?? '') as WebhookDefaultAnswer;

    assert.equal(answer.sourceIp, null);
    assert.equal(answer.requestId, captured.requestId);
    assert.equal(detail.response?.bodySize, Buffer.byteLength(detail.response?.body ?? ''));
  });

  it('leaves the answer of an address that did not parse as written, in either session', async () => {
    for (const storeSourceIp of [false, true]) {
      const captured = await answerAsBaseImage(await newSession(storeSourceIp), null);

      assert.ok(captured.sent.body?.toString('utf8').endsWith('"sourceIp":null}'));
      assert.deepEqual(await storedRecord(captured.requestId), contentOf(captured.sent));
    }
  });

  it('leaves a custom response alone, one that names the address or copies the answer’s shape included', async () => {
    const sessionId = await newSession(false);
    const bodies = [
      `{"ok":true,"requestId":"${randomUUID()}","message":"Captured by QA Tools","sourceIp":"${SENDER}"}`,
      `{"ok":true,"requestId":"","sourceIp":"${SENDER}"}`,
      `sent from ${SENDER}`,
    ];

    for (const body of bodies) {
      const captured = await answerAsBaseImage(sessionId, SENDER, {
        response: { status: 200, headers: [], body, delayMs: 0, template: false },
      });

      assert.deepEqual(await storedRecord(captured.requestId), contentOf(captured.sent));
      assert.equal(await storedAddress(captured.requestId), null);
    }
  });

  it('finds the member after a path written to look like it, at 1 KiB, 64 KiB and 1 MiB, within a bound', async () => {
    const sessionId = await newSession(false);
    const pieces = [
      `,"sourceIp":"${SENDER}"}`,
      '"',
      '\\',
      '\\"',
      ' ',
      '\u0001\u001f',
      'é',
      '{"ok":true,"requestId":"',
      '%22%5C',
    ];

    for (const size of [1024, 64 * 1024, 1024 * 1024]) {
      let filler = '';

      while (filler.length < size) {
        filler += pieces[filler.length % pieces.length] ?? '';
      }

      const started = performance.now();
      const captured = await answerAsBaseImage(sessionId, SENDER, {
        path: `/s/${sessionId}/${filler.slice(0, size)}`,
      });
      const elapsed = performance.now() - started;
      const record = await storedRecord(captured.requestId);

      assert.deepEqual(record, answerFromRow(captured.facts));
      assert.ok(elapsed < 5000, `${String(size)}: ${String(elapsed)} ms`);
      assert.ok(
        record.body?.toString('utf8').endsWith(',"sourceIp":null}'),
        `${String(size)}: the member was not the one rewritten`,
      );
    }
  });
});

describe('a record the trigger does not recognise is stored as written, never refused (D243, migration 015)', () => {
  /**
   * A request of an opted-out session - a new one answering the default, or
   * `into` - its row without an address, and no record yet.
   */
  async function bareRequest(into?: string): Promise<{
    sessionId: string;
    requestId: string;
    facts: RequestFacts;
  }> {
    const sessionId = into ?? (await newSession(false));
    const requestId = await captureAsBaseImage(sessionId, SENDER);
    const received = await pool.query<{ received_at: Date }>(
      'SELECT received_at FROM requests WHERE id = $1',
      [requestId],
    );

    return {
      sessionId,
      requestId,
      facts: {
        requestId,
        inspectorUrl: buildInspectorUrl(ORIGIN, sessionId, requestId),
        receivedAt: received.rows[0]?.received_at.toISOString() ?? '',
        method: 'POST',
        path: `/s/${sessionId}`,
        bodySize: 26,
        sourceIp: SENDER,
      },
    };
  }

  async function insertRecord(requestId: string, record: RecordContent): Promise<void> {
    await pool.query(BASE_IMAGE_RESPONSE_INSERT, [
      requestId,
      200,
      JSON.stringify(record.headers),
      record.body,
      record.bodySize,
      record.bodySuppressed,
      record.raw,
      0,
      null,
      null,
    ]);
  }

  /** The base image's record of its answer, then `alter` applied to it. */
  function altered(
    facts: RequestFacts,
    alter: (record: RecordContent, body: string) => RecordContent,
  ): RecordContent {
    const record = contentOf(composeWebhookResponse(null, facts, NOTHING_CARRIED));

    return alter(record, record.body?.toString('utf8') ?? '');
  }

  /**
   * `record` with another body, and a content length and a raw response that
   * agree with it: a record of the answer's shape, but for what the body holds.
   */
  function withBody(record: RecordContent, body: Buffer): RecordContent {
    const size = String(body.byteLength);
    const head = (record.raw?.toString('latin1') ?? '').split('\r\n\r\n')[0] ?? '';

    return {
      headers: record.headers.map(([name, value]): [string, string] =>
        name === 'content-length' ? [name, size] : [name, value],
      ),
      body,
      bodySize: body.byteLength,
      bodySuppressed: record.bodySuppressed,
      raw: Buffer.concat([
        Buffer.from(
          `${head.replace(/content-length: \d+$/, `content-length: ${size}`)}\r\n\r\n`,
          'latin1',
        ),
        body,
      ]),
    };
  }

  const unrecognised: [string, (record: RecordContent, body: string) => RecordContent][] = [
    [
      'a last header that is not the content length',
      (record) => ({ ...record, headers: [...record.headers, ['x-extra', '1']] }),
    ],
    [
      'a content length that is not the body’s',
      (record) => ({
        ...record,
        headers: record.headers.map(([name, value]) =>
          name === 'content-length' ? [name, String(Number(value) + 1)] : [name, value],
        ),
      }),
    ],
    [
      'a raw response that does not end with the body',
      (record) => ({
        ...record,
        raw: Buffer.concat([record.raw ?? Buffer.alloc(0), Buffer.from('x')]),
      }),
    ],
    [
      'a raw response whose body is not the body',
      (record) => {
        const raw = Buffer.from(record.raw ?? Buffer.alloc(0));

        raw[raw.byteLength - 1] = 0x5d;

        return { ...record, raw };
      },
    ],
    ['no raw response', (record) => ({ ...record, raw: null })],
    ['a raw response that is the body alone', (record) => ({ ...record, raw: record.body })],
    [
      'a raw head without the content-length line',
      (record) => ({
        ...record,
        raw: Buffer.from(
          (record.raw?.toString('latin1') ?? '').replace(/\r\ncontent-length: \d+/, ''),
          'latin1',
        ),
      }),
    ],
    [
      'an address holding a quote',
      (record, body) =>
        withBody(record, Buffer.from(body.replace(`"${SENDER}"}`, '"203.0".113.7"}'))),
    ],
    [
      'an address holding a backslash',
      (record, body) =>
        withBody(record, Buffer.from(body.replace(`"${SENDER}"}`, `"203.0\\\\113.7"}`))),
    ],
    [
      'an empty address',
      (record, body) => withBody(record, Buffer.from(body.replace(`"${SENDER}"}`, '""}'))),
    ],
    [
      'a member whose value is the closing quote alone',
      (record, body) => withBody(record, Buffer.from(body.replace(`"${SENDER}"}`, '"}'))),
    ],
    [
      'no sourceIp member',
      (record, body) =>
        withBody(record, Buffer.from(body.replace(`,"sourceIp":"${SENDER}"}`, ',"x":"y"}'))),
    ],
    [
      'the member right after the id',
      (record, body) =>
        withBody(record, Buffer.from(`${body.slice(0, 62)}"sourceIp":"${SENDER}"}`)),
    ],
  ];

  it('rewrites the answer’s shape as this test builds it, the control for every case below', async () => {
    const { requestId, facts } = await bareRequest();
    const record = altered(facts, (same, body) => withBody(same, Buffer.from(body)));

    assert.deepEqual(record, contentOf(composeWebhookResponse(null, facts, NOTHING_CARRIED)));

    await insertRecord(requestId, record);

    assert.deepEqual(await storedRecord(requestId), answerFromRow(facts));
  });

  for (const [name, alter] of unrecognised) {
    it(`stores ${name} as written`, async () => {
      const { requestId, facts } = await bareRequest();
      const record = altered(facts, alter);

      await insertRecord(requestId, record);

      assert.deepEqual(await storedRecord(requestId), record);
    });
  }

  it('stores the answer of another request as written', async () => {
    const { requestId, facts } = await bareRequest();
    const record = altered({ ...facts, requestId: randomUUID() }, (same) => same);

    await insertRecord(requestId, record);

    assert.deepEqual(await storedRecord(requestId), record);
  });

  it('rewrites a recognised answer whatever bytes its other members hold, UTF-8 or not', async () => {
    const { requestId, facts } = await bareRequest();
    const record = altered(facts, (same, body) =>
      withBody(
        same,
        Buffer.concat([
          Buffer.from(body.slice(0, 63)),
          Buffer.from([0xff, 0xfe, 0x00, 0xc3]),
          Buffer.from(body.slice(63)),
        ]),
      ),
    );

    await insertRecord(requestId, record);

    const stored = await storedRecord(requestId);
    const body = stored.body ?? Buffer.alloc(0);

    assert.equal(recordText(stored).includes(SENDER), false);
    assert.deepEqual(body.subarray(63, 67), Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
    assert.ok(body.toString('latin1').endsWith(',"sourceIp":null}'));
    assert.equal(stored.bodySize, body.byteLength);
    assert.deepEqual(stored.headers.at(-1), ['content-length', String(body.byteLength)]);
    assert.ok(
      stored.raw
        ?.toString('latin1')
        .endsWith(`content-length: ${String(body.byteLength)}\r\n\r\n${body.toString('latin1')}`),
    );
  });

  // A template (D251) can write the default answer's shape - this request's
  // id where the default answer has it, a last "sourceIp" member from the
  // query string - so since migration 019 the function asks which response
  // answered before it looks at the shape: a queue's step, a rule or the
  // session's custom response is the user's own, stored as written.

  /** `record` inserted with this image's statement, answered by a step, a rule or neither. */
  async function insertAnswered(
    requestId: string,
    record: RecordContent,
    answeredBy: unknown[] = [null, null, null, null, null],
  ): Promise<void> {
    await pool.query(INSERT_RESPONSE_SQL, [
      requestId,
      200,
      JSON.stringify(record.headers),
      record.body,
      record.bodySize,
      record.bodySuppressed,
      record.raw,
      0,
      ...answeredBy,
    ]);
  }

  it('stores as written the answer’s shape when a queue’s step or a rule answered (migration 019)', async () => {
    for (const method of ['POST', 'HEAD']) {
      for (const answeredBy of [
        [1, 2, null, null, null],
        [10, 10, null, null, null],
        [null, null, 1, 'POST', '/'],
        [null, null, 20, null, '/*'],
      ]) {
        const { requestId, facts } = await bareRequest();
        const record = altered({ ...facts, method }, (same) => same);

        await insertAnswered(requestId, record, answeredBy);

        assert.deepEqual(await storedRecord(requestId), record, `${method} ${String(answeredBy)}`);
      }

      // The control: the same record, answered by neither, is rewritten.
      const { requestId, facts } = await bareRequest();

      await insertAnswered(
        requestId,
        altered({ ...facts, method }, (same) => same),
      );

      assert.deepEqual(await storedRecord(requestId), answerFromRow({ ...facts, method }), method);
    }
  });

  it('stores as written the answer’s shape while the session answers its custom response, and rewrites it once it answers the default (migration 019)', async () => {
    const custom: ResponseConfig = {
      status: 200,
      headers: [],
      body: '{"ok":true,"requestId":"{{request.id}}","sourceIp":"{{request.query.ip}}"}',
      delayMs: 0,
      template: true,
    };
    const { id: sessionId } = await createSession(pool, custom, null, null, null, false);

    createdSessionIds.push(sessionId);

    /** A record of the answer's shape, naming the address, for a new request of the session. */
    async function shapedRecord(method: string): Promise<{
      requestId: string;
      facts: RequestFacts;
      record: RecordContent;
    }> {
      const { requestId, facts } = await bareRequest(sessionId);

      return {
        requestId,
        facts: { ...facts, method },
        record: altered({ ...facts, method }, (same) => same),
      };
    }

    for (const method of ['GET', 'HEAD']) {
      const { requestId, record } = await shapedRecord(method);

      assert.equal(record.bodySuppressed, method === 'HEAD');

      await insertRecord(requestId, record);

      assert.deepEqual(await storedRecord(requestId), record, method);
    }

    // Picking the default keeps the custom response and answers the default
    // (D151): the base image then answers it with the address it read, and
    // its record is rewritten as for a session that never had one.
    await changeSessionResponse(pool, sessionId, { mode: 'default' });

    for (const method of ['GET', 'HEAD']) {
      const captured = await answerAsBaseImage(sessionId, SENDER, { method });
      const record = await storedRecord(captured.requestId);

      assert.ok(captured.sent.body?.toString('utf8').endsWith(`"sourceIp":"${SENDER}"}`));
      assert.deepEqual(record, answerFromRow(captured.facts), method);
      assert.equal(recordText(record).includes(SENDER), false, method);

      const shaped = await shapedRecord(method);

      await insertRecord(shaped.requestId, shaped.record);

      assert.deepEqual(await storedRecord(shaped.requestId), answerFromRow(shaped.facts), method);
    }

    // Back to the custom response: the shape is stored as written again.
    await changeSessionResponse(pool, sessionId, { mode: 'custom', response: custom });

    const { requestId, record } = await shapedRecord('POST');

    await insertRecord(requestId, record);

    assert.deepEqual(await storedRecord(requestId), record);
  });

  it('fixes the function’s search_path, grants PUBLIC no EXECUTE, and fires only on a default answer’s shape', async () => {
    const fn = await pool.query<{ config: string[] | null; public_execute: boolean }>(
      `SELECT p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'request_responses_source_ip_choice'`,
    );

    assert.deepEqual(fn.rows, [
      { config: ['search_path=pg_catalog, pg_temp'], public_execute: false },
    ]);

    const trigger = await pool.query<{ definition: string }>(
      `SELECT pg_get_triggerdef(t.oid) AS definition
         FROM pg_trigger t
        WHERE t.tgrelid = 'public.request_responses'::regclass
          AND t.tgname = 'request_responses_source_ip_choice'`,
    );

    // The two constants are '{"ok":true,"requestId":"' and '"}'.
    assert.equal(
      trigger.rows[0]?.definition,
      `CREATE TRIGGER request_responses_source_ip_choice BEFORE INSERT ON public.request_responses FOR EACH ROW WHEN (((SUBSTRING(new.body FROM 1 FOR 24) = '\\x${Buffer.from('{"ok":true,"requestId":"').toString('hex')}'::bytea) AND (SUBSTRING(new.body FROM (octet_length(new.body) - 1)) = '\\x${Buffer.from('"}').toString('hex')}'::bytea))) EXECUTE FUNCTION request_responses_source_ip_choice()`,
    );
  });
});

describe('this image writes NULL itself, not leaving it to the trigger (D243)', () => {
  for (const [storeSourceIp, expected] of [
    [false, null],
    [true, SENDER],
  ] as const) {
    it(`sends ${String(expected)} as the address of a capture into a session with storeSourceIp ${String(storeSourceIp)}`, async () => {
      const sessionId = await newSession(storeSourceIp);
      const sent: unknown[][] = [];
      // A pool whose clients pass every statement on to the real ones, writing
      // down the parameters of each.
      const recording = {
        connect: async () => {
          const client = await pool.connect();

          return new Proxy(client, {
            get(target, property) {
              if (property === 'query') {
                return (text: unknown, values?: unknown[]) => {
                  if (text === INSERT_REQUEST_SQL) {
                    sent.push(values ?? []);
                  }

                  return (
                    target as unknown as { query: (t: unknown, v?: unknown[]) => unknown }
                  ).query(text, values);
                };
              }

              const value: unknown = Reflect.get(target, property);

              return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
            },
          });
        },
      } as unknown as pg.Pool;
      const captured: CapturedRequest = {
        sessionId,
        method: 'POST',
        path: `/s/${sessionId}`,
        httpVersion: '1.1',
        queryString: '',
        headers: [],
        body: Buffer.alloc(0),
        rawRequestHead: Buffer.from(`POST /s/${sessionId} HTTP/1.1\r\n\r\n`),
        sourceIp: SENDER,
      };

      const result = await storeRequest(recording, captured, ORIGIN);

      assert.equal(result.outcome, 'stored');
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.[9], expected);
    });
  }
});
