/**
 * The production probe of #132, `scripts/measure-rollout.mjs` (D221), run
 * as a child process against both listeners on the task's database and a
 * stand-in for the frontend's home page, for a few seconds: what it
 * reports when nothing goes wrong, that it deletes its sessions, and that a
 * viewer cut while it runs - the process's realtime listener losing
 * its channel - reconnects, reloads and loses nothing in its report. And
 * that nothing it could not check passes: a failed wait call, a failed
 * reload and a `request.received` sent twice on one connection each fail the
 * report; a second session that cannot be created leaves the first deleted.
 *
 * Requires the local database: npm run db:up && npm run db:migrate
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { buildTestServers, type TestServers } from './testing/servers.ts';

const SCRIPT = fileURLToPath(new URL('../../../scripts/measure-rollout.mjs', import.meta.url));

interface Calls {
  count: number;
  statuses: Record<string, number>;
  failures: Record<string, number>;
}

interface Report {
  ok: boolean;
  failures: number;
  missing: number;
  streams: Record<string, Calls>;
  sessions: Record<
    string,
    {
      sent: number;
      viewer: {
        missing: string[];
        duplicates: string[];
        repeatedAfterReconnection: string[];
        readies: number;
        reconnections: number;
        closes: number[];
        reloads: Calls;
      };
      wait: { missing: string[]; twice: string[]; calls: Calls };
    }
  >;
}

let pool: pg.Pool;
let servers: TestServers;
let home: http.Server;
let appOrigin: string;
let receiveOrigin: string;
let homeOrigin: string;
/** The sessions the probe deleted, as the API answered the deletions. */
const deletions: number[] = [];
/** The ids of the sessions the probe created, in order. */
const created: string[] = [];
/**
 * Calls the stand-in API refuses `503` before any route, each a count that
 * goes down as it refuses: the nth session creation from now (`creation`),
 * and the next wait calls and reloads of the list.
 */
const refuse = { creation: 0, waits: 0, reloads: 0 };
let creations = 0;

// after() waits for before() to finish (#31, src/test-files-exit.test.ts).
let startup: Promise<void> | undefined;

async function listening(server: FastifyInstance): Promise<string> {
  await server.listen({ host: '127.0.0.1', port: 0 });

  return `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
}

before(async () => {
  startup = (async () => {
    pool = createPool(loadConfig().databaseUrl);
    servers = buildTestServers(pool);
    servers.api.log.level = 'silent';
    servers.receiver.log.level = 'silent';
    servers.api.addHook('onResponse', async (request, reply) => {
      if (request.method === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(request.url)) {
        deletions.push(reply.statusCode);
      }
    });
    servers.api.addHook('onSend', async (request, reply, payload) => {
      if (
        request.method === 'POST' &&
        request.url === '/api/sessions' &&
        reply.statusCode === 201
      ) {
        created.push((JSON.parse(String(payload)) as { id: string }).id);
      }

      return payload;
    });
    servers.api.addHook('onRequest', async (request, reply) => {
      const list =
        request.method === 'GET' && /^\/api\/sessions\/[^/]+\/requests\?/.test(request.url);
      let refused = false;

      if (request.method === 'POST' && request.url === '/api/sessions') {
        creations += 1;
        refused = creations === refuse.creation;
      } else if (list && request.url.includes('wait=') && refuse.waits > 0) {
        refuse.waits -= 1;
        refused = true;
      } else if (list && !request.url.includes('wait=') && refuse.reloads > 0) {
        refuse.reloads -= 1;
        refused = true;
      }

      if (refused) {
        return reply.code(503).send({ errorCode: 1500, message: 'Refused by the test' });
      }

      return undefined;
    });
    appOrigin = await listening(servers.api);
    receiveOrigin = await listening(servers.receiver);
    home = http.createServer((_request, response) => {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html>');
    });
    await new Promise<void>((resolve) => home.listen(0, '127.0.0.1', resolve));
    homeOrigin = `http://127.0.0.1:${(home.address() as AddressInfo).port}`;
  })();
  await startup;
});

after(async () => {
  await startup;
  await new Promise<void>((resolve) => home?.close(() => resolve()));
  await servers?.close();
  await pool?.end();
});

/** Runs the probe for `seconds` and answers its exit code and what it printed. */
function run(
  seconds: number,
  whileRunning?: () => Promise<void>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      APP_ORIGIN: appOrigin,
      RECEIVE_ORIGIN: receiveOrigin,
      HOME_ORIGIN: homeOrigin,
      DURATION_S: String(seconds),
      INTERVAL_MS: '100',
      SETTLE_S: '8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  void whileRunning?.();

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Runs the probe for `seconds` and answers its exit code and its report. */
async function probe(
  seconds: number,
  whileRunning?: () => Promise<void>,
): Promise<{ code: number | null; report: Report; stderr: string }> {
  const { code, stdout, stderr } = await run(seconds, whileRunning);

  try {
    return { code, report: JSON.parse(stdout) as Report, stderr };
  } catch (error) {
    throw new Error(`the probe printed no report (exit ${code}): ${stderr}`, { cause: error });
  }
}

/** The failed calls of `calls`, whatever their message. */
function failed(calls: Calls): number {
  return Object.values(calls.failures).reduce((sum, n) => sum + n, 0);
}

describe('scripts/measure-rollout.mjs (D221)', () => {
  it('reports every stream answered and every webhook reaching the viewer and the wait loop once, and deletes its two sessions', async () => {
    deletions.length = 0;

    const { code, report, stderr } = await probe(2);

    assert.equal(stderr, '');
    assert.equal(code, 0, JSON.stringify(report));
    assert.equal(report.ok, true);
    assert.equal(report.failures, 0);
    assert.equal(report.missing, 0);

    for (const name of ['webhookKeptAlive', 'webhookNewConnection', 'api', 'home']) {
      const of = report.streams[name];

      assert.ok(of && of.count >= 10, `${name} made ${of?.count} calls`);
      assert.deepEqual(
        Object.keys(of.statuses),
        ['200'],
        `${name}: ${JSON.stringify(of.statuses)}`,
      );
    }

    for (const name of ['keptAlive', 'newConnection']) {
      const session = report.sessions[name];

      assert.ok(session && session.sent >= 10);
      assert.deepEqual(session.viewer.missing, []);
      assert.deepEqual(session.viewer.duplicates, []);
      assert.deepEqual(session.viewer.repeatedAfterReconnection, []);
      assert.deepEqual(session.wait.missing, []);
      assert.deepEqual(session.wait.twice, []);
      assert.equal(session.viewer.readies, 1);
      assert.deepEqual(Object.keys(session.viewer.reloads.statuses), ['200']);
      assert.ok(session.wait.calls.count >= 1);
      assert.equal(failed(session.wait.calls), 0);
    }

    assert.deepEqual(deletions, [204, 204]);
  });

  it('keeps a viewer cut while it runs whole: it reconnects, reloads, and nothing is missing', async () => {
    const { code, report } = await probe(4, async () => {
      await delay(1500);
      // The listener loses its channel: every viewer of the process is cut
      // (D221), and the probe's viewers reconnect as the frontend's do.
      await pool.query('SELECT pg_terminate_backend($1)', [servers.listener.processId]);
    });

    assert.equal(code, 0, JSON.stringify(report.sessions));
    assert.equal(report.ok, true);

    for (const name of ['keptAlive', 'newConnection']) {
      const session = report.sessions[name];

      assert.ok(session);
      assert.ok(session.viewer.reconnections >= 1, `${name}: ${JSON.stringify(session.viewer)}`);
      assert.ok(session.viewer.closes.includes(1006), `${name}: ${JSON.stringify(session.viewer)}`);
      assert.deepEqual(session.viewer.missing, []);
      assert.deepEqual(session.wait.missing, []);
      assert.deepEqual(session.wait.twice, []);
    }
  });

  it('fails the report on a failed wait call, a failed reload and a request.received sent twice on one connection, counting each', async () => {
    created.length = 0;
    refuse.waits = 1;
    refuse.reloads = 1;

    let duplicated: string | undefined;
    const { code, report } = await probe(3, async () => {
      // The outbox delivering a row twice: a copy of one of the first
      // session's captures, once its viewer is surely registered.
      const deadline = Date.now() + 10_000;

      while (duplicated === undefined && Date.now() < deadline) {
        const session = created[0];
        const count = session
          ? await pool.query(
              "SELECT 1 FROM realtime_events WHERE session_id = $1 AND kind = 'request.received'",
              [session],
            )
          : null;

        if (session && count && count.rows.length >= 5) {
          const copy = await pool.query<{ request_id: string }>(
            `INSERT INTO realtime_events (session_id, request_id, kind, payload)
             SELECT session_id, request_id, kind, payload FROM realtime_events
              WHERE session_id = $1 AND kind = 'request.received'
              ORDER BY id DESC LIMIT 1
             RETURNING request_id::text`,
            [session],
          );

          duplicated = copy.rows[0]?.request_id;
        } else {
          await delay(50);
        }
      }
    });

    assert.equal(refuse.waits, 0, 'no wait call was refused');
    assert.equal(refuse.reloads, 0, 'no reload was refused');
    assert.ok(duplicated, 'no capture was duplicated');

    const sessions = Object.values(report.sessions);
    const waitFailures = sessions.reduce((sum, each) => sum + failed(each.wait.calls), 0);
    const reloadFailures = sessions.reduce((sum, each) => sum + failed(each.viewer.reloads), 0);
    const duplicates = sessions.flatMap((each) => each.viewer.duplicates);

    assert.equal(code, 1, JSON.stringify(report.sessions));
    assert.equal(report.ok, false);
    assert.equal(waitFailures, 1);
    assert.equal(reloadFailures, 1);
    assert.deepEqual(duplicates, [duplicated]);
    assert.deepEqual(report.sessions.keptAlive?.viewer.duplicates, [duplicated]);

    for (const name of ['webhookKeptAlive', 'webhookNewConnection', 'api', 'home']) {
      const of = report.streams[name];

      assert.ok(of);
      assert.equal(failed(of), 0, `${name}: ${JSON.stringify(of.failures)}`);
    }

    assert.equal(report.failures, waitFailures + reloadFailures + duplicates.length);
  });

  it('deletes the first session when the second cannot be created', async () => {
    deletions.length = 0;
    created.length = 0;
    creations = 0;
    refuse.creation = 2;

    try {
      const { code, stdout, stderr } = await run(1);

      assert.notEqual(code, 0);
      assert.equal(stdout, '');
      assert.match(stderr, /creating a session answered 503/);
      assert.equal(created.length, 1);
      assert.deepEqual(deletions, [204]);
    } finally {
      refuse.creation = 0;
    }
  });
});
