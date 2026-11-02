/**
 * Integration tests for the probe endpoints (D086).
 *
 * These run against the local PostgreSQL from Docker Compose. The unreachable
 * case uses a pool pointed at a closed port rather than stopping the database,
 * so both behaviours can be proved in one run.
 *
 * Start the database and apply migrations first:
 *   npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { buildServer } from '../../server.ts';

function discardLogs(): Writable {
  return new Writable({
    write(_chunk: Buffer | string, _encoding, callback) {
      callback();
    },
  });
}

let pool: pg.Pool;
let app: FastifyInstance;

let brokenPool: pg.Pool;
let brokenApp: FastifyInstance;

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
  app = buildServer(pool, { logDestination: discardLogs() });
  await app.ready();

  // Port 1 is not listening, so a query fails quickly instead of waiting for a
  // connection timeout.
  brokenPool = new pg.Pool({
    connectionString:
      'postgres://webhook_inspector:webhook_inspector@127.0.0.1:1/webhook_inspector',
    connectionTimeoutMillis: 1000,
  });
  // A pool with no reachable server also reports failures through this event;
  // without a listener Node would treat one as an unhandled error.
  brokenPool.on('error', () => {});
  brokenApp = buildServer(brokenPool, { logDestination: discardLogs() });
  await brokenApp.ready();
}

after(async () => {
  // A failed start is before()'s to report; close what it did open.
  await startup?.catch(() => undefined);

  await app.close();
  await pool.end();
  await brokenApp.close();
  await brokenPool.end();
});

describe('GET /healthz', () => {
  it('reports the process as alive', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });

  it('stays alive when the database is unreachable, so a blip does not kill the pod', async () => {
    const response = await brokenApp.inject({ method: 'GET', url: '/healthz' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('reports ready when the database answers', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });

  it('reports unavailable when the database cannot be queried', async () => {
    const response = await brokenApp.inject({ method: 'GET', url: '/readyz' });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: 'unavailable' });
  });
});

/**
 * Readiness waits for the realtime listener's first read (D221): a process
 * that has never read the outbox would refuse every viewer with `1013`. Once
 * it has, a lost channel no longer counts, so a blip of realtime never takes
 * the pod out of the Service (D086).
 */
describe('GET /readyz and the realtime listener (D221)', () => {
  it('answers 503 until the listener has listened once, and 200 from then on', async () => {
    let listenedOnce = false;
    const own = buildServer(pool, {
      logDestination: discardLogs(),
      realtimeReady: () => listenedOnce,
    });

    try {
      await own.ready();

      const before = await own.inject({ method: 'GET', url: '/readyz' });

      assert.equal(before.statusCode, 503);
      assert.deepEqual(before.json(), { status: 'unavailable' });

      listenedOnce = true;

      const after = await own.inject({ method: 'GET', url: '/readyz' });

      assert.equal(after.statusCode, 200);
      assert.deepEqual(after.json(), { status: 'ok' });
    } finally {
      await own.close();
    }
  });

  it('logs neither probe at info, since readiness is asked every 2 s', async () => {
    const lines: string[] = [];
    const own = buildServer(pool, {
      logDestination: new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          lines.push(...chunk.toString().split('\n').filter(Boolean));
          callback();
        },
      }),
    });

    try {
      await own.ready();
      await own.inject({ method: 'GET', url: '/healthz' });
      await own.inject({ method: 'GET', url: '/readyz' });
      assert.equal(lines.length, 0, lines.join('\n'));

      // Another route still logs its request.
      await own.inject({ method: 'GET', url: '/no-such-route' });
      assert.ok(lines.some((line) => line.includes('"url":"/no-such-route"')));
    } finally {
      await own.close();
    }
  });
});
