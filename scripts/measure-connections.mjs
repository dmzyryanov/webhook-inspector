#!/usr/bin/env node
/**
 * The connection measurement of issue #145 (D227): what connections cost the
 * backend, behind Traefik as production has it, before the numbers of the
 * connection bounds were fixed - the receive host's 512 connections an
 * address, counted by the backend's PROXY protocol layer, and the 16 realtime
 * connections an address, counted by its `/ws` route.
 *
 * Run from the repository's root on a machine with Docker, nothing else
 * listening on its behalf:
 *
 *   node scripts/measure-connections.mjs [series ...] [--runs N] [--keep]
 *     [--image <backend image>]
 *
 * It starts `scripts/measure-connections.compose.yml` - the backend image
 * built from this checkout, run with 0.5 CPU and 512 MiB and no swap,
 * PostgreSQL, Traefik 3.7.8 in front of it and a client container on two
 * networks - runs each series against a backend container of its own, reads
 * that container's memory from outside every 200 ms (`SAMPLE_MS`), prints
 * one JSON line a series, and removes every container and network it
 * started, its last line, `{"down":…}`, naming any of them still there
 * (`leftovers`); `--keep` leaves them for another run. The built image,
 * `dev145-measure-backend` unless `MEASURE_BACKEND_IMAGE` names another, is
 * left for the next run and removed by hand; `COMPOSE_PROJECT_NAME` renames
 * the project (its networks' fixed subnets still allow one run at a time). `--image`
 * runs a backend image built beforehand instead, a base commit's for
 * comparison, and builds nothing. Nothing is pulled.
 *
 * Series, every one by default:
 * - `stall-plain`, `stall-heavy`, `stall-lines`: 512 TLS connections from
 *   one address to the receive host, each stalled in its headers - after a
 *   request line and one header line, after 14,980 bytes in 140 lines, or
 *   after 16,000 lines of `a:` - held 20 s; then the 513th from the same
 *   address, a webhook from it while the 512 are open, a webhook from another
 *   address, and once one of the 512 has closed a webhook from the first
 *   address again. `stall-none` is the same with no connection stalled, for
 *   the cost of the rest of the series.
 * - `idle`: the same with 512 connections each answered a `GET /robots.txt`
 *   and then kept alive with nothing more sent.
 * - `handshake`: the same with 512 connections each stalled in its TLS
 *   handshake, after a ClientHello naming the receive host and nothing more.
 * - `ws-16`: 16 realtime connections from one address, on a session whose
 *   every event is about 1.8 MiB (a custom response and a queue at every
 *   limit, D205 point 13), each reading until its `ready` and then nothing,
 *   while the session's queue is started again 16 times a second apart -
 *   enough to fill the kernel's buffers on the way, Traefik's and the
 *   client's, and then the backend's 4 MiB a connection; one more connection
 *   from the address, the 17th, is opened before the first event.
 * - `burst`: D210's series, 500 webhooks of 1 MiB at once from one address,
 *   `scripts/measure-capture-bursts.mjs`, straight to the receive listener
 *   as D210 measured it, each with a PROXY header naming that address, so
 *   the backend counts them as it counts the connections Traefik passes on.
 * - `edge-burst`: the same 500 through Traefik, each on a TLS connection of
 *   its own.
 * - `oversize-413` (#238, D227 point 4): 20 webhooks at once (`COUNT`) to a
 *   valid session, sent as `edge-burst` sends them, each declaring a body
 *   over the receive listener's 1 MiB by `Content-Length` and sending it
 *   whole: `oversize-413-1mib` 1 MiB and 1 byte, `oversize-413-4mib` 4 MiB,
 *   D143's drain bound; `oversize-413` names both. The line counts the
 *   clients that read the `413` / `1004`, those whose connection was reset
 *   with no answer read and the others, which `statuses` names
 *   (`oversizeSeries`).
 * - `burst-200`: the same with 200 webhooks; `burst-4`: D210's 500 from four
 *   addresses in turn, 125 each (#157, D228).
 * - `ci`: #139's 50 CI-style waits, `scripts/measure-calls-in-flight.mjs`
 *   with `SERIES=ci`, on a backend whose receive listener takes no PROXY
 *   header, since that script sends its webhooks without one.
 * - `limits-load`: D201's load run, `scripts/measure-limits-load.mjs`, 120 s,
 *   on a backend whose receive listener takes no PROXY header, as `ci`.
 * - `s1` to `s9`: the hostile series of issue #157 (D228), behind Traefik,
 *   from the first `--addresses N` attacking addresses at once, one unless
 *   given (below, "The hostile series"); `s8` calls the application listener
 *   straight, each call naming its attacking address in `X-Forwarded-For`
 *   (#183, `apiHostileSeries`). `s9-big` and `s9-padded`, variants of `s9`
 *   (#182, D238): each address's first 4 connections stall as S9's do, and
 *   the other 508 send 256,000 bytes of a head Node's parser keeps nothing
 *   of and stall (`s9Rest`). Their line's small captures count each status
 *   with its `errorCode`, `503/1018` for a refusal of the capture budget,
 *   and give the p50, p95 and slowest answer (#262).
 * - `abandon-get`, `abandon-mid`, `abandon-query`, `abandon-pipelined`,
 *   `abandon-control`: issue #141 (D201 point 8's note), the five shapes of
 *   a list answer with bodies whose client leaves at once, straight to the
 *   application listener as `s8` is. `--addresses N` spreads each over the
 *   first N attacking addresses; `COUNT` is the lists one address fires at
 *   once (the pipeline's depth for `abandon-pipelined`), and `SUSTAIN_S` with
 *   `RATE_PER_MIN` fires at that rate per address for that many seconds
 *   instead of all at once. The orchestrator reads PostgreSQL's active
 *   connections and list statements beside the backend's memory
 *   (`abandonedListSeries`, `pgActivity`), and since #213 PostgreSQL's CPU
 *   and the probe inside the backend (`measure-backend-probe.mjs`):
 *   `PROBE_LINES_DIR` keeps its lines, a file a series, and
 *   `CPU_PROFILE_DIR` copies out V8's CPU profile of the backend's process,
 *   written as the backend is stopped after the series.
 * - `create-flood` (#189, D201's note): the incident of 2026-10-15 at about
 *   twice its rate, straight to the application listener as `s8` is, with no
 *   edge limit in front. One address, the first attacking one by its
 *   `X-Forwarded-For`, sends `POST /api/sessions` with no body and
 *   `Content-Length: 0`, `RATE` (1,000) a second over `CONNECTIONS` (64)
 *   connections kept alive, every `429` ignored, for `FLOOD_S` (120) seconds,
 *   so that a default run spends those 120 s on it; meanwhile another address
 *   sends `SMALL_PER_SECOND` (5) small captures a second to its own session
 *   and a viewer's call every 500 ms, and `/healthz` is asked every 250 ms on
 *   a connection of its own. Its line carries `bars`: `/healthz` within 1 s
 *   throughout, every capture answered `200` within 5 s and stored, every
 *   viewer's call `200` (`createFloodSeries`).
 * - `edge-flood` (#205, D264): the same flood through
 *   Traefik, as production receives it, with the edge rate limit the chart
 *   sets on `/api/` and `/mcp` (`measure-connections.traefik.yml`): from the
 *   client's edge address over TLS, every `429` ignored, Traefik's own told
 *   from the backend's by its missing `errorCode`; the other address's small
 *   captures through the receive host and its viewer's calls through the
 *   edge; `/healthz` straight every 250 ms in a child process, as the
 *   kubelet asks it; and a quarter of the way in, `edgePathProbes`: what the
 *   edge does with `/api/...`, `/mcp`, `/`, `/api`, `/apix`, `/s/...` and
 *   `/ws/...` from the flooding address. Its line carries how many of the
 *   flood's calls Traefik refused and how many reached the backend, and
 *   `bars`. `edge-flood-pulsed`: the same in pulses, `PULSE_ON_S` (7) on and
 *   `PULSE_OFF_S` (3) off (`edgeFloodSeries`). `edge-flood-probed` and
 *   `create-flood-probed`: the two floods with the probe inside the backend
 *   (`measure-backend-probe.mjs`), which counts the application listener's
 *   connections beside its requests.
 * - `edge-d201` (#205): D201's limits used whole at a window's
 *   edge through Traefik - the rest of one window's 60 creations and 1200
 *   reads `LEAD_S` (10) seconds before it ends and the next window's at once
 *   as it begins, `CONNECTIONS` (64) at once - every answer to be the
 *   backend's, never Traefik's `429` (`edgeD201Series`).
 * - `rules-saves` (#231, D246 point 11): 16 savers (`SAVERS`), each to a
 *   session of its own holding the largest state of D246 point 11 - a
 *   response at every limit, the largest queue and twenty rules as large as
 *   1 MiB admits - each sending `PUT .../rules` with such rules again as soon
 *   as it is answered, after `Retry-After` when refused `429` (`1017` while
 *   the eight places of large bodies are taken), for 30 s (`LOAD_S`), with a
 *   viewer reading each session's events through the edge, so that the
 *   realtime listener fetches every `session.updated`. Two series, one a
 *   shape of the rules' text: `rules-saves-escaped`, control characters,
 *   six bytes each in JSON, as `hub.test.ts` builds its largest, and
 *   `rules-saves-two-byte`, one Cyrillic letter and ASCII, which V8 holds two
 *   bytes a character; `rules-saves` names both (`rulesSavesSeries`).
 * - `republish-flood` (#231, D221 point 9): 32 sessions (`SESSIONS`) holding
 *   the same state, a viewer reading each, and bodyless
 *   `POST .../queue/restart` in bursts of one per session at once, a burst
 *   once the last is answered and at most one every `BURST_EVERY_MS`
 *   (1,000), for 30 s (`LOAD_S`), so that the listener's batches of 32 carry
 *   many of the largest payloads at once; `republish-flood-escaped` and
 *   `republish-flood-two-byte`, the same two shapes of the rules, and
 *   `republish-flood` names both (`republishFloodSeries`).
 *   In both, the calls go straight to the application listener counted
 *   under the first `CALL_ADDRESSES` (8) attacking addresses in turn by their
 *   `X-Forwarded-For`, and the viewers come from them through Traefik, a
 *   viewer the server cuts connecting again a second later; beside them, 10
 *   small captures a second (`SMALL_PER_SECOND`) to another session and
 *   `/healthz` every 250 ms, each in a child process, and 5 s (`SETTLE_S`)
 *   after the load for the listener to deliver the rest. Each line carries
 *   `bar`, D229's: the backend running, no `error` line, `memory.peak` at or
 *   under 400 MiB and every small capture stored.
 * - `row-lock`, `row-lock-refused`, `row-lock-control` (#244, Scope 5, D244
 *   point 7): the row-lock variant of #243's line stall - changes waiting in
 *   a session's line behind its captures - its repeatable shape and that stall
 *   itself as a control, made as series of this harness rather than an ad-hoc
 *   script. `row-lock`: `CALL_ADDRESSES` (3)
 *   addresses within `RATE_PER_MIN` (1200) send, round robin, a session
 *   `GET`, a single-request `DELETE`, and every `SESSION_DELETE_EVERY`-th (30)
 *   a session `DELETE` of a throwaway session sent amid `THROWAWAY_CAPTURES`
 *   (10) captures to it, on a target session receiving a burst of
 *   `CAPTURE_PER_SECOND` (100) captures for `LOAD_S` (30) seconds. Of these
 *   only the session `DELETE` takes the session row's lock a capture holds
 *   (`FOR UPDATE`, outside the session's line); the `GET`'s expiry refresh
 *   writes nothing to a session its captures keep refreshing, and a request's
 *   `DELETE` takes no session lock. `row-lock-refused`: the same addresses
 *   send `DELETE` of a private target with no key, which takes the row and
 *   is refused as a missing session, again and again. In both, two
 *   bystanders stay for their answers, `API_PER_SECOND` (5) a second each from
 *   an address of its own, one reading the contended target and one a quiet
 *   session, their read p50 / p99 / max and refusals reported
 *   (`rowLockReport`), and PostgreSQL logs its lock waits of 1 ms or more
 *   for the series (`lockWaits`): which calls waited, on what, how long.
 *   `row-lock-control`: `CHANGES` (3) `PUT .../response` kept in flight in one
 *   session's line behind its captures, the quiet bystander reading an
 *   untouched session. The probe (`probe`) reads each pool's longest
 *   connection hold, checkout to release: the capture pool's is an upper
 *   bound of a capture's hold of the session row, `BEGIN`, `COMMIT` and any
 *   lock wait included. The side load's small captures are the bar
 *   (`rowLockSeries`, `rowLockRefusedSeries`, `rowLockControlSeries`).
 *
 * `LOGS_DIR` names a directory to keep the backend's log of each series in, a
 * file a series (#262).
 *
 * Every series' line counts, in `backend.proxyTimeouts`, the connections the
 * backend's PROXY layer closed because their header had not come within its
 * 5 s, by the peer that opened them: Traefik, `10.145.1.2`, for what passed
 * through it, and the client, `10.145.1.10`, for what it sends straight, the
 * small captures among them (#262).
 *
 * A memory reading that fails - the backend container gone, or `docker exec`
 * too slow under the load - is counted in the series' `sampling`, not thrown,
 * and the series' line says how the backend ended (`backend.state`: running,
 * or its exit code, 133 or 137 for memory), so a backend killed by a series
 * is reported and the project is still taken down (#157).
 *
 * `MEASURE_RECEIVE_CONNECTIONS` sets the backend's
 * `RECEIVE_CONNECTIONS_PER_ADDRESS`, 512 by default; `0` turns the bound off,
 * for a run without it. `MEASURE_TCP_RMEM` sets the backend container's
 * `net.ipv4.tcp_rmem`, the chart's `backend.tcpRmem` by default (#217);
 * `4096 131072 6291456`, Linux's default, runs it as the pod ran before
 * 1.14.1. Each series' line gives the value the backend ran with
 * (`backend.tcpRmem`).
 *
 * Memory: the backend process's `VmRSS`, `VmHWM` and `RssAnon`, and its
 * container's `memory.current`, `memory.peak` and `memory.stat`, read once the
 * series reports itself warm (the baseline) and every 200 ms until it is done.
 * Growth is the largest sample less the baseline, and `VmHWM` at the end less
 * `VmRSS` at the baseline; the peaks are `VmHWM`, `memory.peak` and the
 * largest `RssAnon` read. `own` is what the backend itself holds: its
 * process's `RssAnon` and the kernel's memory for its sockets (`kernel` and
 * `sock`); the cgroup's own figures carry the reading's processes besides.
 * Beside it Traefik's (#217): its container's `memory.current`,
 * `memory.peak`, `anon`, `kernel` and `sock`, at the series' start, at warm
 * and every second (`TRAEFIK_SAMPLE_MS`) until it is done (`traefik`).
 * Traefik is not started afresh for each series, so its `memory.peak` is a
 * series' own only when the series runs first or reads above
 * `peakMiB.beforeSeries`; run one series an invocation to compare peaks.
 * Since #205 Traefik's line also gives its CPU over the series (`cpu`,
 * cores from `warm` to the end and the busiest 5 s) and its log over the
 * series at INFO, production's level (`log`: the lines and the first five,
 * and beside them the lines since Traefik started and the first five of
 * those that are warnings or errors).
 *
 * Inside the client container the same file is the client:
 * `node /scripts/measure-connections.mjs client <stall|ws|burst|edge-burst|oversize-413|ci>`
 * (`stall` with `SHAPE` `plain`, `heavy`, `lines`, `idle` or `handshake`),
 * printing `{"phase":"warm"}`, `{"phase":"held"}` and `{"phase":"done"}` as it
 * goes and one `{"report":…}` line at its end.
 *
 * Dependency-free, Node 24.
 */
import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import console from 'node:console';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import readline from 'node:readline';
import { Duplex } from 'node:stream';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import tls from 'node:tls';
import { URL, fileURLToPath } from 'node:url';

const MIB = 1024 * 1024;

/** The 12-byte PROXY protocol v2 signature (D187), as `measure-capture-bursts.mjs` has it. */
const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

/* ------------------------------------------------------------------------ */
/* The client, inside the client container.                                 */
/* ------------------------------------------------------------------------ */

/** The backend's application listener, straight: the series' own setup calls. */
const API = 'http://10.145.1.3:3000';
/** Traefik as the address the series come from sees it, and as another address does. */
const EDGE = '10.145.1.2';
const OTHER = '10.145.2.2';
const EDGE_PORT = 8443;
const RECEIVE_HOST = 'hook.qa-tools.test';
const APP_HOST = 'qa-tools.test';

function emit(line) {
  console.log(JSON.stringify(line));
}

/**
 * One call to the application listener, straight, read to its end.
 * `extraHeaders` adds header lines: an `X-Forwarded-For` naming the address
 * the call is counted under (S8, #183).
 */
function api(path, method = 'GET', payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      ...extraHeaders,
      ...(payload === undefined
        ? {}
        : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
    };
    const call = http.request(`${API}${path}`, { method, headers, agent: false }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });

    call.on('error', reject);
    call.end(payload);
  });
}

/**
 * How many requests a session holds; `null` when the read is refused. With
 * `forwardedFor` the read is counted under that address rather than the
 * client's edge address (S8, #183); `key` opens a private session (D253).
 */
async function requestsCount(sessionId, forwardedFor, key) {
  const answer = await api(`/api/sessions/${sessionId}`, 'GET', undefined, {
    ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
  });

  return answer.status === 200 ? JSON.parse(answer.text).requestsCount : null;
}

async function createSession(delayMs = 0) {
  const answer = await api(
    '/api/sessions',
    'POST',
    delayMs > 0
      ? JSON.stringify({ response: { status: 200, body: '{"held":true}', delayMs } })
      : undefined,
  );

  if (answer.status !== 201) {
    throw new Error(`creating a session answered ${answer.status}: ${answer.text}`);
  }

  return JSON.parse(answer.text).id;
}

/** A TLS connection to Traefik at `address` for `servername`; resolves once it is secure, or with its failure. */
function secure(address, servername) {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: address,
      port: EDGE_PORT,
      servername,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });
    const state = { socket, closed: false, ended: false, error: null, received: 0 };

    socket.on('data', (chunk) => {
      state.received += chunk.length;
    });
    socket.on('error', (error) => {
      state.error = error.code ?? String(error);
    });
    socket.on('end', () => {
      state.ended = true;
    });
    socket.on('close', () => {
      state.closed = true;
      resolve({ ...state, secured: false });
    });
    socket.once('secureConnect', () => {
      resolve(Object.assign(state, { secured: true }));
    });
  });
}

/**
 * A webhook on a connection of its own through the edge from `address`:
 * answers the status of its answer, 0 when the connection ended without one,
 * and how long it took. With `timeoutMs` the connection is destroyed once it
 * has been open that long, its `error` then `timeout` when no answer was read
 * (#238).
 */
async function edgeWebhook(address, sessionId, body, timeoutMs = 0) {
  const started = performance.now();
  const connection = await secure(address, RECEIVE_HOST);

  if (!connection.secured) {
    return { status: 0, error: connection.error ?? 'closed', ms: performance.now() - started };
  }

  return new Promise((resolve) => {
    const chunks = [];
    const { socket } = connection;
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            socket.destroy();
          }, timeoutMs)
        : null;

    socket.removeAllListeners('data');
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => {
      clearTimeout(timer);

      const text = Buffer.concat(chunks).toString('latin1');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
      const errorCode = /"errorCode":(\d+)/.exec(text)?.[1];

      resolve({
        status,
        ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
        ...(status === 0 ? { error: timedOut ? 'timeout' : (connection.error ?? 'closed') } : {}),
        ms: performance.now() - started,
      });
    });
    socket.write(
      `POST /s/${sessionId} HTTP/1.1\r\nHost: ${RECEIVE_HOST}\r\nConnection: close\r\n` +
        `Content-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n\r\n`,
    );
    socket.write(body);
  });
}

/* ------------------------------------------------------------------------ */
/* The hostile series of issue #157 (D228), behind Traefik.                 */
/*                                                                          */
/* Each attacking address is one of the client container's own network     */
/* interfaces, bound as the connection's local address, so Traefik writes   */
/* it into the PROXY v2 header to the backend; the small captures come from */
/* an address of their own. The backend mirrors the chart as it stands at   */
/* the base (D227): 512 connections an address in its PROXY layer, no edge  */
/* `inFlightConn`. A series spreads its connections evenly over the first   */
/* `ADDR_COUNT` addresses.                                                  */
/* ------------------------------------------------------------------------ */

/** Traefik, as each attacking address reaches it, and the address bound locally. */
const ATTACK = Array.from({ length: 8 }, (_, index) => ({
  host: `10.145.${index + 1}.2`,
  local: `10.145.${index + 1}.10`,
}));
/** The small captures' address, never one of `ATTACK`. */
const SMALL_ADDRESS = '198.51.100.77';

/** A TLS connection to Traefik from `address` (`{host, local}`) for the receive host. */
function secureFrom(address, servername = RECEIVE_HOST) {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: address.host,
      port: EDGE_PORT,
      localAddress: address.local,
      servername,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });
    const state = { socket, closed: false, ended: false, error: null, received: 0 };

    socket.on('data', (chunk) => {
      state.received += chunk.length;
    });
    socket.on('error', (error) => {
      state.error = error.code ?? String(error);
    });
    socket.on('end', () => {
      state.ended = true;
    });
    socket.on('close', () => {
      state.closed = true;
      resolve({ ...state, secured: false });
    });
    socket.once('secureConnect', () => {
      resolve(Object.assign(state, { secured: true }));
    });
  });
}

/** `count` header lines of `a:`, one counted byte each, under Node's 16 KiB limit. */
function oneByteLines(count) {
  return 'a:\r\n'.repeat(count);
}

/**
 * What the connections of an address send after its first `S9_HOLDERS` in
 * the variants of S9 (#182, D238), by `S9_REST`; `null` for S9 itself.
 * `big`: 64,000 lines of `a:`, 256,000 bytes, a head Node's parser refuses
 * `431` once it has counted 16 KiB of it. `padded`: one header line, `x:`
 * and 256,000 spaces, which Node's parser skips before a value without
 * keeping them. Neither ends its head.
 */
function s9Rest(kind) {
  if (kind === undefined || kind === '') {
    return null;
  }

  if (kind === 'big') {
    return oneByteLines(64_000);
  }

  if (kind === 'padded') {
    return `x:${' '.repeat(256_000)}`;
  }

  throw new Error(`no such S9_REST: ${kind}`);
}

/**
 * One attacking request on a TLS connection of its own from `address`, read to
 * its close: `method /s/<session>` with `headerLines` and, when `bodyBytes`,
 * a declared body sent whole. `slowBytesPerSecond` trickles the body instead,
 * for a slow sender. Answers the status, any `errorCode` and the milliseconds.
 */
async function attackRequest(
  address,
  sessionId,
  { method = 'POST', headerLines = '', bodyBytes = 0, slowBytesPerSecond = 0 } = {},
) {
  const started = performance.now();
  const connection = await secureFrom(address);

  if (!connection.secured) {
    return { status: 0, error: connection.error ?? 'closed', ms: performance.now() - started };
  }

  const { socket } = connection;

  socket.removeAllListeners('data');

  const chunks = [];

  socket.on('data', (chunk) => chunks.push(chunk));

  const framing =
    bodyBytes > 0
      ? `Content-Type: application/octet-stream\r\nContent-Length: ${bodyBytes}\r\n`
      : '';

  socket.write(
    `${method} /s/${sessionId} HTTP/1.1\r\nHost: ${RECEIVE_HOST}\r\nConnection: close\r\n` +
      `${headerLines}${framing}\r\n`,
  );

  if (bodyBytes > 0) {
    const body = Buffer.alloc(bodyBytes, 0x61);

    if (slowBytesPerSecond > 0) {
      void (async () => {
        for (let sent = 0; sent < bodyBytes && !socket.destroyed; sent += slowBytesPerSecond) {
          socket.write(body.subarray(sent, Math.min(bodyBytes, sent + slowBytesPerSecond)));
          await sleep(1_000);
        }
      })();
    } else {
      socket.write(body);
    }
  }

  return new Promise((resolve) => {
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('latin1');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
      const errorCode = /"errorCode":(\d+)/.exec(text)?.[1];

      resolve({
        status,
        ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
        ...(status === 0 ? { error: connection.error ?? 'closed' } : {}),
        ms: performance.now() - started,
      });
    });
  });
}

/** A connection stalled in its headers from `address`, left open; its state. */
async function stalledFrom(address, headerLines) {
  const connection = await secureFrom(address);

  if (connection.secured) {
    connection.socket.write(`POST /s/x HTTP/1.1\r\nHost: ${RECEIVE_HOST}\r\n${headerLines}`);
  }

  return connection;
}

/** How a set of answers came out, by status (and errorCode), with the slowest. */
function tally(answers) {
  const statuses = {};

  for (const answer of answers) {
    const key =
      answer.errorCode === undefined
        ? String(answer.status)
        : `${answer.status}/${answer.errorCode}`;

    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  const ms = answers.map((answer) => answer.ms).sort((a, b) => a - b);
  // The answers' p50 and p95 beside the slowest (#262): latency read beside
  // main's, the slowest alone being one answer's.
  const at = (fraction) =>
    ms.length === 0
      ? 0
      : Math.round(ms[Math.min(ms.length - 1, Math.ceil(fraction * ms.length) - 1)]);

  return {
    count: answers.length,
    statuses,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: Math.round(ms.at(-1) ?? 0),
  };
}

/** A PROXY protocol v2 header for TCP over IPv4 naming `source`, as Traefik writes one (D187). */
function smallProxyHeader(source) {
  const addresses = Buffer.concat([
    Buffer.from(source.split('.').map(Number)),
    Buffer.from([10, 42, 0, 24]),
    Buffer.from([0xc3, 0x50, 0x20, 0xfb]),
  ]);
  const fixed = Buffer.from([0x21, 0x11, 0, addresses.length]);

  return Buffer.concat([PROXY_V2_SIGNATURE, fixed, addresses]);
}

/**
 * One small capture straight to the backend's receive listener with a PROXY
 * header naming the small-captures address, as `measure-capture-bursts.mjs`
 * sends one and as D210 and D227 measured the legitimate traffic beside a
 * burst: no Traefik and no TLS handshake on the small captures, so what is
 * read is the capture path's own latency, not the proxy's at 0.5 CPU (#157).
 */
function smallCapture(sessionId, source = SMALL_ADDRESS) {
  const started = performance.now();

  return new Promise((resolve) => {
    const socket = net.connect(3001, '10.145.1.3');
    const chunks = [];
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }

      settled = true;

      const text = Buffer.concat(chunks).toString('latin1');
      // The refusal's `errorCode`, so that a `503` / `1018` is told apart
      // from any other `503` (#262).
      const errorCode = /"errorCode":(\d+)/.exec(text)?.[1];

      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0),
        ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
        ms: performance.now() - started,
      });
    };

    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', settle);
    socket.on('close', settle);
    socket.on('connect', () => {
      socket.write(smallProxyHeader(source));
      socket.write(
        `POST /s/${sessionId} HTTP/1.1\r\nHost: ${RECEIVE_HOST}\r\nConnection: close\r\n` +
          'Content-Type: application/json\r\nContent-Length: 17\r\n\r\n{"event":"small"}',
      );
    });
  });
}

/**
 * The small-captures loop, run in a child process of its own (`small-worker`):
 * `perSecond` small captures a second to `sessionId` until SIGTERM, then its
 * answers written to `outFile`. A separate process so that the attack's own
 * event loop - thousands of TLS connections at once - cannot starve the
 * legitimate traffic the bar measures; what is then read is the backend's
 * latency, not the client's (#157).
 */
async function smallWorker(sessionId, perSecond, outFile, source = SMALL_ADDRESS) {
  const fired = [];
  let running = true;

  process.on('SIGTERM', () => {
    running = false;
  });

  let next = performance.now();

  while (running) {
    // `edge` (#205): through the receive host from the client's other
    // address, which Traefik names in its PROXY header, rather than straight.
    fired.push(
      source === 'edge'
        ? edgeWebhook(OTHER, sessionId, SMALL_BODY)
        : smallCapture(sessionId, source),
    );
    next += 1_000 / perSecond;

    const wait = next - performance.now();

    if (wait > 0) {
      await sleep(wait);
    }
  }

  const answers = await Promise.all(fired);

  writeFileSync(
    outFile,
    JSON.stringify(
      answers.map((answer) => ({
        status: answer.status,
        ...(answer.errorCode === undefined ? {} : { errorCode: answer.errorCode }),
        ms: answer.ms,
      })),
    ),
  );
}

/**
 * 10 small captures a second from the small-captures address to its own
 * session, in a child process, from now until `stop()`; every one must be
 * stored, the slowest within 5 s (#157). `stop()` answers their
 * statuses and timings.
 */
function smallCaptures(sessionId, perSecond, source = SMALL_ADDRESS) {
  const outFile = `/tmp/small-${process.pid}-${sessionId}.json`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'small-worker', sessionId, String(perSecond), outFile, source],
    { stdio: 'ignore' },
  );

  return {
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));

      try {
        return JSON.parse(readFileSync(outFile, 'utf8'));
      } catch {
        return [];
      }
    },
  };
}

/** The hostile series of #157, behind Traefik, spread over `ADDR_COUNT` addresses. */
async function hostileSeries(shape) {
  const addrCount = Number(process.env.ADDR_COUNT ?? 1);
  const addresses = ATTACK.slice(0, addrCount);
  const delayMs = Number(process.env.DELAY_MS ?? 30_000);
  const smallPerSecond = Number(process.env.SMALL_PER_SECOND ?? 10);
  const defaults = { s1: 10_000, s2: 2_000, s3: 400, s4: 256, s5: 500, s6: 500, s9: 512 };
  const perAddress = Number(process.env.COUNT ?? defaults[shape] ?? 0);

  // A session each per address, since a session keeps its newest 1000
  // requests; the small captures their own.
  const sessions = await Promise.all(
    addresses.map(() =>
      ['s1', 's9'].includes(shape) ? Promise.resolve('x') : createSession(delayMs),
    ),
  );
  const smallSessionId = await createSession(0);

  const small = smallCaptures(smallSessionId, smallPerSecond);

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const held = [];
  const answers = [];
  const startedAt = performance.now();

  await Promise.all(
    addresses.map(async (address, addressIndex) => {
      const sessionId = sessions[addressIndex];
      const tasks = [];

      if (shape === 's1' || shape === 's9') {
        const lines = shape === 's9' ? oneByteLines(16_000) : 'x-stall: 1\r\n';
        // A variant of S9 (#182): the address's first connections stall as
        // S9's do, filling its header lines in flight, and the rest, 2 s
        // later, send what `s9Rest` gives them instead.
        const rest = shape === 's9' ? s9Rest(process.env.S9_REST) : null;
        const holders = Number(process.env.S9_HOLDERS ?? 4);

        for (let index = 0; index < perAddress; index += 1) {
          if (rest !== null && index === holders) {
            await sleep(2_000);
          }

          const sent = rest !== null && index >= holders ? rest : lines;

          tasks.push(stalledFrom(address, sent).then((connection) => held.push(connection)));
        }
      } else if (shape === 's2') {
        // 2,500 header lines of one counted byte each, so the request fits
        // Node's 16 KiB header limit (a fat line would be refused 431 before
        // capture); what each waiting webhook keeps is 2,500 parsed headers.
        for (let index = 0; index < perAddress; index += 1) {
          tasks.push(
            attackRequest(address, sessionId, {
              method: 'POST',
              headerLines: oneByteLines(2_500),
              bodyBytes: 2,
            }).then((answer) => answers.push(answer)),
          );
        }
      } else if (shape === 's3') {
        for (let index = 0; index < perAddress; index += 1) {
          tasks.push(
            attackRequest(address, sessionId, {
              method: 'GET',
              headerLines: oneByteLines(15_000),
            }).then((answer) => answers.push(answer)),
          );
        }
      } else if (shape === 's4') {
        // One 64 KiB write of minimal pipelined GETs on each connection.
        const get = `GET /s/${sessionId} HTTP/1.1\r\nHost: ${RECEIVE_HOST}\r\n\r\n`;
        const pipeline = get.repeat(Math.floor((64 * 1024) / get.length));

        for (let index = 0; index < perAddress; index += 1) {
          tasks.push(
            secureFrom(address).then((connection) => {
              if (connection.secured) {
                connection.socket.write(pipeline);
              }

              held.push(connection);
            }),
          );
        }
      } else if (shape === 's5') {
        for (let index = 0; index < perAddress; index += 1) {
          tasks.push(
            attackRequest(address, sessionId, { method: 'GET', bodyBytes: MIB }).then((answer) =>
              answers.push(answer),
            ),
          );
        }
      } else if (shape === 's6') {
        // 15 slow senders of 1 MiB at 16 KiB/s, then the rest refused behind them.
        const slow = Math.min(15, perAddress);

        for (let index = 0; index < slow; index += 1) {
          tasks.push(
            attackRequest(address, sessionId, {
              method: 'POST',
              bodyBytes: MIB,
              slowBytesPerSecond: 16 * 1024,
            }).then((answer) => answers.push(answer)),
          );
        }

        await sleep(500);

        for (let index = slow; index < perAddress; index += 1) {
          tasks.push(
            attackRequest(address, sessionId, { method: 'POST', bodyBytes: MIB }).then((answer) =>
              answers.push(answer),
            ),
          );
        }
      }

      await Promise.all(tasks);
    }),
  );

  const burstMs = Math.round(performance.now() - startedAt);

  // Hold the stalls their 20 s so the sampler sees their cost.
  if (shape === 's1' || shape === 's9' || shape === 's4') {
    await sleep(Number(process.env.HOLD_S ?? 20) * 1_000);
  }

  emit({ phase: 'done' });

  for (const connection of held) {
    connection.socket?.destroy();
  }

  const smallAnswers = await small.stop();
  const smallStored = await requestsCount(smallSessionId);
  const storedPerSession = await Promise.all(
    sessions.map((sessionId) => (sessionId === 'x' ? 0 : requestsCount(sessionId))),
  );

  return {
    shape,
    ...(process.env.S9_REST ? { rest: process.env.S9_REST } : {}),
    addresses: addrCount,
    perAddress,
    burstMs,
    heldOpen: held.filter((connection) => !connection.closed).length,
    attack: answers.length > 0 ? tally(answers) : undefined,
    storedPerSession,
    small: {
      sent: smallAnswers.length,
      // `503/1018` apart from any other status (#262).
      ...tally(smallAnswers),
      stored: smallStored,
    },
  };
}

/**
 * S7 (#157): 64 non-reading WebSockets from one address on a session whose
 * every event is about 1.8 MiB (D205 point 13), `Run again` fired every
 * second. The realtime cap is 16 an address (D227), so 16 subscribe and the
 * rest are refused; a one-run regression check that neither the events nor
 * the refusals exhaust the backend. Small captures run alongside.
 */
async function wsHostileSeries() {
  const count = Number(process.env.COUNT ?? 64);
  const events = Number(process.env.EVENTS ?? 16);
  const sessionId = await createSession(0);
  const response = await api(
    `/api/sessions/${sessionId}/response`,
    'PUT',
    JSON.stringify({ mode: 'custom', response: escapedResponse('\u0001'.repeat(65_536)) }),
  );
  const queue = await api(`/api/sessions/${sessionId}/queue`, 'PUT', largestQueueBody());

  if (response.status !== 200 || queue.status !== 200) {
    throw new Error(`the session's state answered ${response.status} and ${queue.status}`);
  }

  const smallSessionId = await createSession(0);
  const small = smallCaptures(smallSessionId, Number(process.env.SMALL_PER_SECOND ?? 10));

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const connections = [];

  for (let index = 0; index < count; index += 1) {
    connections.push(await realtime(sessionId));
  }

  const subscribed = connections.filter((connection) => connection.status === 101).length;

  for (let index = 0; index < events; index += 1) {
    await api(`/api/sessions/${sessionId}/queue/restart`, 'POST');
    await sleep(1_000);
  }

  await sleep(Number(process.env.SETTLE_S ?? 5) * 1_000);
  emit({ phase: 'done' });

  for (const connection of connections) {
    connection.socket.destroy();
  }

  const smallAnswers = await small.stop();

  return {
    shape: 's7',
    addresses: 1,
    count,
    subscribed,
    small: {
      sent: smallAnswers.length,
      ...tally(smallAnswers.map((answer) => ({ status: answer.status, ms: answer.ms }))),
      stored: await requestsCount(smallSessionId),
    },
  };
}

/**
 * The address S8 reads the small captures' stored count as: the client's
 * small-captures address, which no count of attacking addresses includes, so
 * the attack's 128 calls in flight cannot refuse the read (#183).
 */
const S8_READ_ADDRESS = '10.145.9.10';

/**
 * One `GET` of S8 on a connection of its own, straight to the application
 * listener, counted under `forwardedFor` (D213 keys an address by
 * `request.ip`, which the trusted client's `X-Forwarded-For` sets). Resolves
 * with the status of its answer once the head has arrived, 0 when the
 * connection ended or `timeoutMs` ran out without one.
 *
 * `leaveUnread`: an answer `200` is left unread from its head on - the socket
 * paused and its `data` listener removed, so nothing consumes the rest of the
 * body, as a slow client leaves it (#183) - and its socket kept in `held`. A
 * refusal, or any answer when not `leaveUnread`, is read to its end for its
 * `errorCode` and its connection closed: those are not the load.
 */
function s8Get(forwardedFor, path, { leaveUnread, held, timeoutMs }) {
  const started = performance.now();

  return new Promise((resolve) => {
    const socket = net.connect(3000, '10.145.1.3');
    const state = { closed: false };
    let buffered = Buffer.alloc(0);
    let head = null;
    let settled = false;
    const settle = (answer) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({ ...answer, ms: performance.now() - started });
    };
    const timer = setTimeout(() => {
      settle({ status: head?.status ?? 0, error: 'timeout' });
      socket.destroy();
    }, timeoutMs);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);

      if (head === null) {
        const end = buffered.indexOf('\r\n\r\n');

        if (end === -1) {
          return;
        }

        const text = buffered.subarray(0, end).toString('latin1');

        head = {
          end: end + 4,
          status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0),
          length: Number(/\r\ncontent-length: *(\d+)/i.exec(text)?.[1] ?? NaN),
        };

        if (leaveUnread && head.status === 200) {
          socket.pause();
          socket.removeListener('data', onData);
          held.push({ socket, state });
          settle({ status: 200, bytes: head.length, readBeforePause: buffered.length });

          return;
        }
      }

      if (Number.isFinite(head.length) && buffered.length >= head.end + head.length) {
        const errorCode = /"errorCode":(\d+)/.exec(
          buffered.subarray(head.end).toString('utf8'),
        )?.[1];

        settle({
          status: head.status,
          ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
        });
        socket.destroy();
      }
    };

    socket.on('error', (error) => {
      state.error = error.code ?? String(error);
    });
    socket.on('close', () => {
      state.closed = true;
      settle(
        head === null
          ? { status: 0, error: state.error ?? 'closed' }
          : { status: head.status, error: state.error ?? 'closed before its end' },
      );
    });
    socket.on('data', onData);
    socket.once('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${APP_HOST}\r\nX-Forwarded-For: ${forwardedFor}\r\n\r\n`,
      );
    });
  });
}

/**
 * S8 (#157, corrected by #183): from each of the first `ADDR_COUNT`
 * attacking addresses, 128 `GET /api/sessions/:id` of a session with a full
 * queue, about 1 MiB of JSON each, sent first, each on a connection of its
 * own, read only until its head shows `200` and then left unread, as a slow
 * client leaves it (`s8Get`). D213 holds a call's place until its answer has
 * been written, so these hold the address's 128 calls in flight with their
 * answers in the backend: that is the load. Since #184 the answers' byte
 * budget lets an address have about 16 MiB of answers not yet written, so
 * most of the 128 are refused `429` / `1019` as each is ready: the run is
 * valid when every large answer of every address is answered, admitted `200`
 * or refused `1019`, none left without a head (before #184, only with all
 * 128 admitted). Only then #139's 1,200 waits
 * (`?wait=30`) from each address, each read to its answer and closed: they
 * check the cap - expected refused `429`, `1019` for the calls in flight, or
 * `1015` once the address's 1,200 calls a minute are spent (D201) - and are
 * not the load. Straight to the application listener, as #157 measured it;
 * since it trusts the client's edge address as a proxy, each call's
 * `X-Forwarded-For` names its attacking address, which `request.ip` then is.
 * Small captures to the receive host run alongside; their stored count is
 * read as `S8_READ_ADDRESS`, which attacks nothing.
 */
async function apiHostileSeries() {
  const addrCount = Number(process.env.ADDR_COUNT ?? 1);
  const addresses = ATTACK.slice(0, addrCount).map((address) => address.local);
  const unread = Number(process.env.UNREAD ?? 128);
  const waits = Number(process.env.WAITS ?? 1_200);
  const sessionId = await createSession(0);
  const queue = await api(`/api/sessions/${sessionId}/queue`, 'PUT', largestQueueBody());

  if (queue.status !== 200) {
    throw new Error(`saving the queue answered ${queue.status}: ${queue.text.slice(0, 300)}`);
  }

  const smallSessionId = await createSession(0);
  const small = smallCaptures(smallSessionId, Number(process.env.SMALL_PER_SECOND ?? 10));

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const held = [];
  const startedAt = performance.now();

  // The large answers first, every address at once, each awaited to its head.
  const large = await Promise.all(
    addresses.map((address) =>
      Promise.all(
        Array.from({ length: unread }, () =>
          s8Get(address, `/api/sessions/${sessionId}`, {
            leaveUnread: true,
            held,
            timeoutMs: Number(process.env.LARGE_ANSWER_S ?? 120) * 1_000,
          }),
        ),
      ),
    ),
  );
  const largeMs = Math.round(performance.now() - startedAt);
  const largeAll = large.flat();
  const largeAdmitted = largeAll.filter((answer) => answer.status === 200).length;
  const largeRefused = tally(largeAll.filter((answer) => answer.status !== 200));

  // Only then the waits, while the large answers hold every place.
  const waitAnswers = await Promise.all(
    addresses.map((address) =>
      Promise.all(
        Array.from({ length: waits }, () =>
          s8Get(address, `/api/sessions/${sessionId}/requests?wait=30`, {
            leaveUnread: false,
            held,
            timeoutMs: Number(process.env.WAIT_ANSWER_S ?? 40) * 1_000,
          }),
        ),
      ),
    ),
  );
  const waitsMs = Math.round(performance.now() - startedAt) - largeMs;

  await sleep(Number(process.env.HOLD_S ?? 10) * 1_000);

  // The large answers' connections not seen closed: a paused socket reads
  // nothing, so it may not notice its peer's close until it is read again.
  const heldOpen = held.filter((connection) => !connection.state.closed).length;

  emit({ phase: 'done' });

  for (const connection of held) {
    connection.socket.destroy();
  }

  const smallAnswers = await small.stop();
  // A backend that died meanwhile fails the read rather than answering it:
  // the report still arrives, its count `null` with the read's error (#183).
  const smallRead = await requestsCount(smallSessionId, S8_READ_ADDRESS).then(
    (stored) => ({ stored }),
    (error) => ({ stored: null, readError: error?.code ?? String(error) }),
  );

  return {
    shape: 's8',
    addresses: addrCount,
    unread,
    waits,
    // Every large answer admitted `200` or refused by the answers' byte
    // budget, `429` / `1019` (#184): none unanswered, none otherwise refused.
    valid: largeAll.every(
      (answer) =>
        answer.status === 200 ||
        (answer.status === 429 && answer.errorCode === 1019 && answer.error === undefined),
    ),
    largeAdmitted,
    largeRefused: largeRefused.statuses,
    largeAdmittedPerAddress: large.map(
      (answers) => answers.filter((answer) => answer.status === 200).length,
    ),
    largeRefusedPerAddress: large.map(
      (answers) => answers.filter((answer) => answer.status !== 200).length,
    ),
    largeBytes: Math.max(0, ...largeAll.map((answer) => answer.bytes ?? 0)),
    largeReadBeforePauseMax: Math.max(0, ...largeAll.map((answer) => answer.readBeforePause ?? 0)),
    largeMs,
    waitsAnswered: tally(waitAnswers.flat()),
    waitsMs,
    heldOpen,
    small: {
      sent: smallAnswers.length,
      ...tally(smallAnswers.map((answer) => ({ status: answer.status, ms: answer.ms }))),
      ...smallRead,
      readFrom: S8_READ_ADDRESS,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* #189: a flood of refused session creations from one address.             */
/*                                                                          */
/* The incident of 2026-10-15 in miniature, at twice its rate: one address  */
/* sends `POST /api/sessions` with no body far over its 60 a minute (D201), */
/* every `429` ignored, while another address captures webhooks and makes   */
/* the calls a viewer makes, and `/healthz` is asked as the liveness probe  */
/* asks it. The backend alone, called straight as S8 calls it, with no edge */
/* limit in front (#205's is Traefik's). Bars (#189): `/healthz` answers    */
/* within 1 s throughout, the backend never exits, every capture of the     */
/* other address is stored and answered within 5 s, none refused, and its   */
/* calls are answered `200`.                                                */
/* ------------------------------------------------------------------------ */

/** The address the flood is counted under, by its `X-Forwarded-For`: the first attacking one, as S8's. */
const FLOOD_ADDRESS = ATTACK[0].local;

/**
 * The flood, in a child process of its own (`flood-worker`), as the small
 * captures are, so that the client's own event loop at 1,000 calls a second
 * cannot delay the probes the bars read: `POST /api/sessions` with no body,
 * `Content-Length: 0` as Traefik forwards one, counted under `FLOOD_ADDRESS`;
 * `rate` a second spread over `connections` connections kept alive, each
 * sending its next call once its last is answered and its turn has come -
 * at once when it is behind, never more than a second's calls behind - every
 * answer read to its end and none acted on: a `429` is not waited out. Until
 * SIGTERM; its tally is then written to `outFile`.
 *
 * `via` `edge` (#205, D264) sends the same calls through Traefik instead, as
 * production receives them: over TLS to `qa-tools.test` from the client's
 * edge address, the first attacking one, which Traefik sees and names in its
 * `X-Forwarded-For`, so that the edge rate limit meets them before the
 * backend does. A `429` with no `errorCode` is Traefik's own refusal, which
 * the tally keys `429` beside the backend's `429/1015`; `edgeRefusal` keeps
 * the first one's headers and body. `pulseOnMs` and `pulseOffMs`, both above
 * 0, send only during the first `pulseOnMs` of every `pulseOnMs + pulseOffMs`
 * and nothing in the rest, a pause not made up afterwards.
 */
async function floodWorker(
  rate,
  connections,
  outFile,
  via = 'backend',
  pulseOnMs = 0,
  pulseOffMs = 0,
) {
  const edge = via === 'edge';
  const agent = edge
    ? new https.Agent({
        keepAlive: true,
        maxSockets: connections,
        servername: APP_HOST,
        rejectUnauthorized: false,
      })
    : new http.Agent({ keepAlive: true, maxSockets: connections });
  const statuses = {};
  const ms = [];
  let sent = 0;
  let running = true;
  let edgeRefusal = null;
  const pulsed = pulseOnMs > 0 && pulseOffMs > 0;

  process.on('SIGTERM', () => {
    running = false;
  });

  const call = () =>
    new Promise((resolve) => {
      const started = performance.now();
      const request = (edge ? https : http).request(
        edge ? `https://${EDGE}:${EDGE_PORT}/api/sessions` : `${API}/api/sessions`,
        {
          method: 'POST',
          agent,
          headers: edge
            ? { host: APP_HOST, 'content-length': 0 }
            : { 'x-forwarded-for': FLOOD_ADDRESS, 'content-length': 0 },
          timeout: 30_000,
        },
        (response) => {
          const chunks = [];

          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const errorCode = /"errorCode":(\d+)/.exec(text)?.[1];

            if (edgeRefusal === null && response.statusCode === 429 && errorCode === undefined) {
              // Its headers but the date, which says nothing of the refusal.
              const headers = { ...response.headers };

              delete headers.date;
              edgeRefusal = { headers, body: text.slice(0, 200) };
            }

            resolve({
              key:
                errorCode === undefined
                  ? String(response.statusCode)
                  : `${response.statusCode}/${errorCode}`,
              ms: performance.now() - started,
            });
          });
        },
      );

      // A call with no answer in 30 s is given up, so that SIGTERM ends the
      // loops even with the backend gone.
      request.on('timeout', () => request.destroy());
      request.on('error', (error) => resolve({ key: `0/${error.code ?? 'error'}`, ms: 0 }));
      request.end();
    });

  const startedAt = performance.now();
  const spacing = (1_000 * connections) / rate;
  const cycle = pulseOnMs + pulseOffMs;
  const loop = async (index) => {
    const offset = (spacing * index) / connections;
    let next = startedAt + offset;

    while (running) {
      if (pulsed) {
        const into = (next - startedAt) % cycle;

        // A call planned in a pause moves to the start of the next pulse.
        if (into >= pulseOnMs) {
          next += cycle - into + offset;
        }
      }

      const wait = next - performance.now();

      if (wait > 0) {
        await sleep(wait);
      }

      if (!running) {
        break;
      }

      sent += 1;

      const answer = await call();

      statuses[answer.key] = (statuses[answer.key] ?? 0) + 1;

      if (!answer.key.startsWith('0/')) {
        ms.push(answer.ms);
      }

      next = Math.max(next + spacing, performance.now() - 1_000);
    }
  };

  await Promise.all(Array.from({ length: connections }, (_, index) => loop(index)));

  const elapsedS = (performance.now() - startedAt) / 1_000;
  const answered = ms.length;

  agent.destroy();
  writeFileSync(
    outFile,
    JSON.stringify({
      via,
      ...(pulsed ? { pulseOnMs, pulseOffMs } : {}),
      sent,
      answered,
      statuses,
      elapsedS: Math.round(elapsedS * 10) / 10,
      perSecond: Math.round(answered / elapsedS),
      ...percentiles(ms),
      maxMs: Math.round(Math.max(0, ...ms)),
      ...(edgeRefusal === null ? {} : { edgeRefusal }),
    }),
  );
}

/**
 * The flood in its child process from now until `stop()`, which answers its
 * tally; `via`, `pulseOnMs` and `pulseOffMs` as `floodWorker` takes them.
 */
function flood(rate, connections, via = 'backend', pulseOnMs = 0, pulseOffMs = 0) {
  const outFile = `/tmp/flood-${process.pid}.json`;
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      'flood-worker',
      String(rate),
      String(connections),
      outFile,
      via,
      String(pulseOnMs),
      String(pulseOffMs),
    ],
    { stdio: 'ignore' },
  );

  return {
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));

      try {
        return JSON.parse(readFileSync(outFile, 'utf8'));
      } catch {
        return null;
      }
    },
  };
}

/**
 * Asks `/healthz` on a connection of its own every `everyMs`, as the kubelet
 * asks it, until `stop()`, which answers how long the slowest took and how
 * many took over 1 s, the liveness probe's timeout (#189). A probe waits up to
 * 10 s, so that a slow answer is measured rather than cut at the second.
 */
function healthzProbes(everyMs) {
  const answers = [];
  const startedAt = performance.now();
  let running = true;
  const probe = () =>
    new Promise((resolve) => {
      const started = performance.now();
      const settle = (status) =>
        resolve({ status, ms: performance.now() - started, at: started - startedAt });
      const call = http.get(`${API}/healthz`, { agent: false, timeout: 10_000 }, (response) => {
        response.resume();
        response.on('end', () => settle(response.statusCode ?? 0));
      });

      call.on('timeout', () => call.destroy());
      call.on('error', () => settle(0));
    });
  const done = (async () => {
    while (running) {
      const next = performance.now() + everyMs;

      answers.push(await probe());
      await sleep(Math.max(0, next - performance.now()));
    }
  })();

  return {
    async stop() {
      running = false;
      await done;

      return {
        ...tally(answers),
        ...percentiles(answers.map((answer) => answer.ms)),
        over1s: answers.filter((answer) => answer.status !== 200 || answer.ms > 1_000).length,
        // When the slowest ten were asked, in seconds from the first probe,
        // with how long each took (#205).
        slowest: [...answers]
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 10)
          .map((answer) => ({ atS: Math.round(answer.at / 100) / 10, ms: Math.round(answer.ms) })),
      };
    },
  };
}

/**
 * The calls a viewer of the other address makes, one every `everyMs` until
 * `stop()`: its session and its list in turn, counted under `SMALL_ADDRESS`,
 * the address its captures' PROXY header names. Each must be answered `200`.
 */
function viewerCalls(sessionId, everyMs) {
  const answers = [];
  let running = true;
  const from = { 'x-forwarded-for': SMALL_ADDRESS };
  const done = (async () => {
    for (let index = 0; running; index += 1) {
      const next = performance.now() + everyMs;
      const started = performance.now();
      const path =
        index % 2 === 0 ? `/api/sessions/${sessionId}` : `/api/sessions/${sessionId}/requests`;
      const answer = await api(path, 'GET', undefined, from).catch(() => ({ status: 0 }));

      answers.push({ status: answer.status, ms: performance.now() - started });
      await sleep(Math.max(0, next - performance.now()));
    }
  })();

  return {
    async stop() {
      running = false;
      await done;

      return tally(answers);
    },
  };
}

/**
 * The flood series of #189: `RATE` (1,000) creations a second from one
 * address over `CONNECTIONS` (64) connections for `FLOOD_S` (120) seconds,
 * with `SMALL_PER_SECOND` (5) small captures a second, a viewer's call every
 * 500 ms and a `/healthz` probe every 250 ms from elsewhere throughout.
 */
async function createFloodSeries() {
  const rate = Number(process.env.RATE ?? 1_000);
  const connections = Number(process.env.CONNECTIONS ?? 64);
  const floodMs = Number(process.env.FLOOD_S ?? 120) * 1_000;
  const created = await api('/api/sessions', 'POST', undefined, {
    'x-forwarded-for': SMALL_ADDRESS,
  });

  if (created.status !== 201) {
    throw new Error(`creating the other address's session answered ${created.status}`);
  }

  const sessionId = JSON.parse(created.text).id;
  // 5 a second, so that a run of two minutes stays under the 1,000 requests
  // a session keeps and every capture can be found stored.
  const small = smallCaptures(sessionId, Number(process.env.SMALL_PER_SECOND ?? 5));

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const probes = healthzProbes(250);
  const viewer = viewerCalls(sessionId, 500);
  const flooding = flood(rate, connections);

  await sleep(floodMs);

  const floodReport = await flooding.stop();
  const viewerReport = await viewer.stop();
  const healthz = await probes.stop();

  emit({ phase: 'done' });

  const smallAnswers = await small.stop();
  const smallRead = await requestsCount(sessionId, SMALL_ADDRESS).then(
    (stored) => ({ stored }),
    (error) => ({ stored: null, readError: error?.code ?? String(error) }),
  );
  const smallTally = tally(
    smallAnswers.map((answer) => ({ status: answer.status, ms: answer.ms })),
  );

  return {
    shape: 'create-flood',
    rate,
    connections,
    floodS: floodMs / 1_000,
    flood: floodReport,
    healthz,
    viewer: viewerReport,
    small: { sent: smallAnswers.length, ...smallTally, ...smallRead },
    // The bars a client can read; that the backend never exited is the
    // series line's `backend.state`.
    bars: {
      healthzWithin1s: healthz.over1s === 0,
      capturesStoredWithin5s:
        smallAnswers.length > 0 &&
        smallAnswers.every((answer) => answer.status === 200) &&
        smallTally.maxMs <= 5_000 &&
        smallRead.stored === smallAnswers.length,
      viewerAll200: viewerReport.count > 0 && viewerReport.statuses['200'] === viewerReport.count,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* #205: the edge rate limit in front of the API (D264).                    */
/*                                                                          */
/* The flood of #189 again, now through Traefik as production receives it, */
/* with the edge rate limit the chart sets on `/api/` and `/mcp`            */
/* (`measure-connections.traefik.yml`): one address, the client's edge one, */
/* sends `POST /api/sessions` with no body at `RATE` a second, every `429`  */
/* ignored, while another address - the client's `other` one - captures     */
/* webhooks through the receive host and makes a viewer's calls through the */
/* edge, and `/healthz` is asked straight, as the kubelet asks it. And D201 */
/* at its edge: one address making its 60 creations and 1200 other calls at */
/* the end of a window and again at the start of the next, through Traefik, */
/* every answer the backend's, never Traefik's own `429`.                   */
/* ------------------------------------------------------------------------ */

/** The small captures' body through the edge, as `smallCapture`'s. */
const SMALL_BODY = Buffer.from('{"event":"small"}');

/** The address the edge series read their own results under, straight: none of the series' own. */
const EDGE_READ_ADDRESS = '198.51.100.79';

/** D201's window, `RATE_LIMIT_WINDOW_SECONDS` of packages/shared, which this container does not mount. */
const RATE_WINDOW_MS = 60_000;

/** An agent for calls through Traefik to `qa-tools.test`, kept alive, at most `maxSockets` at once. */
function edgeAgent(maxSockets) {
  return new https.Agent({
    keepAlive: true,
    maxSockets,
    servername: APP_HOST,
    rejectUnauthorized: false,
  });
}

/**
 * One call through Traefik at `host` - `EDGE` for the client's edge address,
 * `OTHER` for its other one, the address Traefik then sees - to `qa-tools.test`,
 * read to its end: its status, any `errorCode`, and `edge`, whether Traefik
 * refused it itself, a `429` with no `errorCode`: every refusal of the
 * backend's carries one, and Traefik's carries `Retry-After`, `X-Retry-In` and
 * `Too Many Requests` alone. A `POST` sends no body, `Content-Length: 0`.
 */
function edgeCall(agent, host, method, path) {
  const started = performance.now();

  return new Promise((resolve) => {
    const request = https.request(
      {
        host,
        port: EDGE_PORT,
        method,
        path,
        agent,
        servername: APP_HOST,
        headers: { host: APP_HOST, ...(method === 'POST' ? { 'content-length': 0 } : {}) },
        timeout: 30_000,
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const errorCode = /"errorCode":(\d+)/.exec(text)?.[1];
          const status = response.statusCode ?? 0;

          resolve({
            status,
            ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
            edge: status === 429 && errorCode === undefined,
            ms: performance.now() - started,
            text,
          });
        });
      },
    );

    request.on('timeout', () => request.destroy());
    request.on('error', (error) =>
      resolve({
        status: 0,
        error: error.code ?? String(error),
        edge: false,
        ms: performance.now() - started,
        text: '',
      }),
    );
    request.end();
  });
}

/** Answers tallied as `tally` does, with how many Traefik refused itself. */
function edgeTally(answers) {
  return { ...tally(answers), refusedAtEdge: answers.filter((answer) => answer.edge).length };
}

/**
 * The calls a viewer of the other address makes through the edge, one every
 * `everyMs` until `stop()`: its session and its list in turn. Each must be
 * answered `200`.
 */
function edgeViewerCalls(sessionId, everyMs) {
  const agent = edgeAgent(1);
  const answers = [];
  let running = true;
  const done = (async () => {
    for (let index = 0; running; index += 1) {
      const next = performance.now() + everyMs;
      const path =
        index % 2 === 0 ? `/api/sessions/${sessionId}` : `/api/sessions/${sessionId}/requests`;

      answers.push(await edgeCall(agent, OTHER, 'GET', path));
      await sleep(Math.max(0, next - performance.now()));
    }
  })();

  return {
    async stop() {
      running = false;
      await done;
      agent.destroy();

      return edgeTally(answers);
    },
  };
}

/**
 * What the edge does with each path from the flooding address while its
 * bucket on `/api/` is empty, which checks at run time that the chart limits
 * `/api/` and `/mcp` alone (#205): `COUNT_EACH` (5) calls
 * a path, 100 ms apart, through Traefik from the edge address. `/api/...`
 * should meet Traefik's own `429`; `/mcp` has a router and so a bucket of its
 * own, untouched by the flood; every other path - the frontend's `/` and bare
 * `/api` and `/apix`, which the harness's application router sends to the
 * backend, `/s/`, `/ws/` - has none.
 */
async function edgePathProbes() {
  const agent = edgeAgent(1);
  const id = randomBytes(32).toString('base64url');
  const paths = {
    api: `/api/sessions/${id}`,
    mcp: '/mcp',
    root: '/',
    bareApi: '/api',
    apix: '/apix',
    s: `/s/${id}`,
    ws: `/ws/${id}`,
  };
  const report = {};

  for (const [name, path] of Object.entries(paths)) {
    const answers = [];

    for (let index = 0; index < 5; index += 1) {
      answers.push(await edgeCall(agent, EDGE, 'GET', path));
      await sleep(100);
    }

    report[name] = edgeTally(answers);
  }

  agent.destroy();

  return report;
}

/**
 * The flood series of #205: `RATE` (1,000) creations a
 * second through Traefik from the edge address over `CONNECTIONS` (64)
 * connections for `FLOOD_S` (120) seconds - or in pulses, `PULSE_ON_S` on and
 * `PULSE_OFF_S` off - with `SMALL_PER_SECOND` (5) small captures a second
 * through the receive host and a viewer's call every 500 ms through the edge
 * from the other address, and `/healthz` straight every 250 ms in a child
 * process; the path probes a quarter of the way in. The orchestrator reads
 * the backend's CPU and Traefik's log over the series.
 */
async function edgeFloodSeries() {
  const rate = Number(process.env.RATE ?? 1_000);
  const connections = Number(process.env.CONNECTIONS ?? 64);
  const floodMs = Number(process.env.FLOOD_S ?? 120) * 1_000;
  const pulseOnMs = Number(process.env.PULSE_ON_S ?? 0) * 1_000;
  const pulseOffMs = Number(process.env.PULSE_OFF_S ?? 0) * 1_000;
  const setup = edgeAgent(1);
  const created = await edgeCall(setup, OTHER, 'POST', '/api/sessions');

  setup.destroy();

  if (created.status !== 201) {
    throw new Error(`creating the other address's session answered ${created.status}`);
  }

  const sessionId = JSON.parse(created.text).id;
  const small = smallCaptures(sessionId, Number(process.env.SMALL_PER_SECOND ?? 5), 'edge');

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const probes = healthzInChild(250);
  const viewer = edgeViewerCalls(sessionId, 500);
  const floodStartedAt = performance.now();
  const flooding = flood(rate, connections, 'edge', pulseOnMs, pulseOffMs);

  await sleep(Math.round(floodMs / 4));

  const paths = await edgePathProbes();

  await sleep(Math.max(0, floodStartedAt + floodMs - performance.now()));

  const floodReport = await flooding.stop();
  const viewerReport = await viewer.stop();
  const healthz = await probes.stop();

  emit({ phase: 'done' });

  const smallAnswers = await small.stop();
  const smallRead = await requestsCount(sessionId, EDGE_READ_ADDRESS).then(
    (stored) => ({ stored }),
    (error) => ({ stored: null, readError: error?.code ?? String(error) }),
  );
  const smallTally = tally(
    smallAnswers.map((answer) => ({ status: answer.status, ms: answer.ms })),
  );
  const statuses = floodReport?.statuses ?? {};
  const refusedAtEdge = statuses['429'] ?? 0;
  const failed = Object.entries(statuses)
    .filter(([key]) => key.startsWith('0/'))
    .reduce((sum, [, count]) => sum + count, 0);
  const reachedBackend = (floodReport?.answered ?? 0) - refusedAtEdge;

  return {
    shape: 'edge-flood',
    rate,
    connections,
    floodS: floodMs / 1_000,
    ...(pulseOnMs > 0 && pulseOffMs > 0
      ? { pulse: { onS: pulseOnMs / 1_000, offS: pulseOffMs / 1_000 } }
      : {}),
    flood: floodReport,
    // Of the flood's answered calls, those Traefik refused itself and those
    // the backend answered, and the backend's per second of the flood.
    refusedAtEdge,
    reachedBackend,
    reachedBackendPerSecond:
      floodReport === null ? null : Math.round((reachedBackend / floodReport.elapsedS) * 10) / 10,
    failed,
    healthz,
    viewer: viewerReport,
    small: { sent: smallAnswers.length, ...smallTally, ...smallRead },
    paths,
    bars: {
      healthzWithin1s: healthz !== null && healthz.over1s === 0,
      capturesStoredWithin5s:
        smallAnswers.length > 0 &&
        smallAnswers.every((answer) => answer.status === 200) &&
        smallTally.maxMs <= 5_000 &&
        smallRead.stored === smallAnswers.length,
      viewerAll200: viewerReport.count > 0 && viewerReport.statuses['200'] === viewerReport.count,
      floodRefusedAtEdge: refusedAtEdge > 0,
      onlyApiPathsLimited: Object.entries(paths)
        .filter(([name]) => name !== 'api')
        .every(([, each]) => each.refusedAtEdge === 0),
    },
  };
}

/**
 * Up to `concurrency` calls at once through Traefik from the edge address,
 * `calls` being `[method, path]` pairs sent in order as places come free;
 * answers each call, the burst's span and when it ended.
 */
async function edgeBurst(agent, calls, concurrency) {
  const answers = [];
  const startedAt = performance.now();
  let next = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < calls.length) {
        const [method, path] = calls[next];

        next += 1;
        answers.push(await edgeCall(agent, EDGE, method, path));
      }
    }),
  );

  return { answers, startedAt, endedAt: performance.now() };
}

/** `creations` session creations and `reads` reads of `sessionId`, interleaved evenly. */
function d201Calls(creations, reads, sessionId) {
  const calls = [];
  const total = creations + reads;

  for (let index = 0, made = 0; index < total; index += 1) {
    if (made < creations && Math.floor(((index + 1) * creations) / total) > made) {
      calls.push(['POST', '/api/sessions']);
      made += 1;
    } else {
      calls.push(['GET', `/api/sessions/${sessionId}`]);
    }
  }

  return calls;
}

/**
 * #205: D201 at its edge, through Traefik. One address - the
 * edge one - starts both of its windows with a creation and a read, and
 * `LEAD_S` (10) seconds before they end sends the rest of both limits, 59
 * creations and 1199 reads interleaved, `CONNECTIONS` (64) at once, as fast
 * as the backend answers; then, until both windows have ended, a read every
 * 500 ms, over its limit, so that Traefik never forgets the address between
 * the two bursts (it forgets one idle about 2 s, and a bucket forgotten
 * would be full again); then, the moment the windows have ended, all of the next
 * windows' 60 and 1200 at once; then 3 creations and 3 reads more, past both
 * limits. Every answer must be the backend's - `201` / `200` within the
 * limits, its own `429` / `1015` past them - and none Traefik's `429`.
 */
async function edgeD201Series() {
  const concurrency = Number(process.env.CONNECTIONS ?? 64);
  const leadMs = Number(process.env.LEAD_S ?? 10) * 1_000;
  const agent = edgeAgent(concurrency);

  emit({ phase: 'warm' });
  emit({ phase: 'held' });

  const first = await edgeCall(agent, EDGE, 'POST', '/api/sessions');

  if (first.status !== 201) {
    throw new Error(`the first creation answered ${first.status}`);
  }

  const sessionId = JSON.parse(first.text).id;
  const firstRead = await edgeCall(agent, EDGE, 'GET', `/api/sessions/${sessionId}`);
  // Both windows started no later than the read's answer, and have ended a
  // minute after it; 300 ms more for the backend's timer.
  const windowsEnd = performance.now() + RATE_WINDOW_MS + 300;

  await sleep(Math.max(0, windowsEnd - 300 - leadMs - performance.now()));

  const before = await edgeBurst(agent, d201Calls(59, 1199, sessionId), concurrency);
  const gap = [];

  while (performance.now() < windowsEnd) {
    gap.push(await edgeCall(agent, EDGE, 'GET', `/api/sessions/${sessionId}`));
    await sleep(Math.min(500, Math.max(0, windowsEnd - performance.now())));
  }

  const after = await edgeBurst(agent, d201Calls(60, 1200, sessionId), concurrency);
  const past = await edgeBurst(agent, d201Calls(3, 3, sessionId), 1);

  agent.destroy();

  const all = [first, firstRead, ...before.answers, ...gap, ...after.answers, ...past.answers];
  const withinLimits = [first, firstRead, ...before.answers, ...after.answers];
  const ms = (value) => Math.round(value);

  return {
    shape: 'edge-d201',
    concurrency,
    firstWindow: {
      ...edgeTally([first, firstRead, ...before.answers]),
      burstMs: ms(before.endedAt - before.startedAt),
      burstEndedBeforeWindowsEndMs: ms(windowsEnd - 300 - before.endedAt),
    },
    gap: edgeTally(gap),
    nextWindow: {
      ...edgeTally(after.answers),
      burstMs: ms(after.endedAt - after.startedAt),
      startedAfterWindowsEndMs: ms(after.startedAt - windowsEnd),
    },
    pastLimits: edgeTally(past.answers),
    // From the first call of the first burst to the last of the second.
    spanMs: ms(after.endedAt - before.startedAt),
    calls: all.length,
    bars: {
      noEdgeRefusal: all.every((answer) => !answer.edge),
      // A `200` or `201`, or an error carrying the backend's `errorCode`:
      // none of Traefik's own answers - its `429`, a `502` - carries one.
      everyAnswerTheBackends: all.every(
        (answer) =>
          answer.status === 200 || answer.status === 201 || answer.errorCode !== undefined,
      ),
      withinLimitsLetThrough: withinLimits.every(
        (answer) =>
          answer.status === 200 ||
          answer.status === 201 ||
          (answer.status === 429 && answer.errorCode === 1015),
      ),
      pastLimitsRefusedByTheBackend: past.answers.every(
        (answer) => answer.status === 429 && answer.errorCode === 1015,
      ),
    },
  };
}

/* ------------------------------------------------------------------------ */
/* #141: what a list answer with bodies left by its client still holds.     */
/*                                                                          */
/* The measurement of issue #141 (D201 point 8's note). A list answer with  */
/* bodies gives its place back as soon as the client goes, even while its   */
/* list statement is still running (D201 point 8); the statement goes on    */
/* until it settles, holding a pool connection and, since D213, its         */
/* address's call place. This series fires lists whose clients leave at     */
/* once and measures what the abandoned statements cost: the backend's      */
/* memory, the connections active in PostgreSQL, how long until no list     */
/* statement is active (both read by the orchestrator, `series.pgActivity`),*/
/* and the capture latency of 10 captures a second from another address     */
/* throughout. Straight to the application listener, as S8 does, each call  */
/* naming its attacking address in `X-Forwarded-For`.                       */
/* ------------------------------------------------------------------------ */

/** The address whose captures fill the target session; never one of `ATTACK`. */
const FILL_ADDRESS = '198.51.100.141';

/**
 * One capture straight to the receive listener with a PROXY header, a path of
 * `pathBytes` after the session id - near Node's 16 KiB request-line limit for
 * the worst metadata a list chooses - and a body of `bodyBytes` U+0001 bytes,
 * the most a stored body is (D008). Read to its close; answers its status.
 */
function bigCapture(sessionId, pathBytes, bodyBytes) {
  const path = `/s/${sessionId}/${'a'.repeat(pathBytes)}`;
  const body = Buffer.alloc(bodyBytes, 0x01);

  return new Promise((resolve) => {
    const socket = net.connect(3001, '10.145.1.3');
    const chunks = [];
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(
        Number(/^HTTP\/1\.1 (\d{3})/.exec(Buffer.concat(chunks).toString('latin1'))?.[1] ?? 0),
      );
    };

    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', settle);
    socket.on('close', settle);
    socket.on('connect', () => {
      socket.write(smallProxyHeader(FILL_ADDRESS));
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: ${RECEIVE_HOST}\r\nConnection: close\r\n` +
          `Content-Type: application/octet-stream\r\nContent-Length: ${bodyBytes}\r\n\r\n`,
      );
      socket.write(body);
    });
  });
}

/**
 * One list on a connection of its own to the application listener, counted
 * under `forwardedFor`, whose client leaves the instant it is written
 * (`mode: 'at-once'`, shapes 1, 3 and 5) or once the answer's head has arrived
 * while a content read is in flight (`mode: 'mid'`, shape 2). `payload` makes
 * it the `POST .../requests/query` of shape 3. Answers what was seen: the
 * status for `mid`, nothing to see for `at-once` - the socket is gone before
 * the backend answers, which is the point. `sent` means the whole request was
 * handed to the client's kernel before the close; a write that failed is
 * counted by its error instead, never as `sent` (#141).
 */
function abandonList(forwardedFor, path, mode, { method = 'GET', payload } = {}) {
  const started = performance.now();

  return new Promise((resolve) => {
    const socket = net.connect(3000, '10.145.1.3');
    let buffered = Buffer.alloc(0);
    let settled = false;
    const settle = (answer) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({ ...answer, ms: performance.now() - started });
    };

    socket.on('error', (error) => settle({ status: 0, error: error.code ?? String(error) }));

    if (mode === 'mid') {
      socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);

        if (buffered.indexOf('\r\n\r\n') !== -1) {
          const text = buffered.toString('latin1');

          socket.destroy();
          settle({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0) });
        }
      });
      socket.on('close', () => settle({ status: 0, error: 'closed before its head' }));
    }

    socket.once('connect', () => {
      const headers =
        `${method} ${path} HTTP/1.1\r\nHost: ${APP_HOST}\r\n` +
        `X-Forwarded-For: ${forwardedFor}\r\n` +
        (payload === undefined
          ? ''
          : `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`) +
        '\r\n';

      // The whole request is flushed to the kernel before the socket is
      // destroyed, so the backend reads it whole, runs its statement, and only
      // then finds the client gone: a GET's short head and a query's body
      // alike, which an immediate destroy would truncate into an error.
      // A failed write calls back with its error before the socket's `error`
      // event, so the callback, not the event, is where it is counted.
      socket.write(headers + (payload ?? ''), (error) => {
        if (mode === 'at-once') {
          socket.destroy();
          settle(error ? { status: 0, error: error.code ?? String(error) } : { status: 'sent' });
        }
      });
    });
  });
}

/**
 * `count` lists of shape 1 pipelined on one connection per address, written
 * whole and the connection then closed (shape 4). Node's HTTP server hands
 * each pipelined request to its handler as soon as it is parsed and queues
 * only the answers behind the first (`calls-in-flight-routes.test.ts`,
 * "pipelined behind a pending wait"), so up to `count` handlers run at once
 * on one connection, each holding one of its address's calls in flight
 * (D213); at most four hold a list place at a time, one finding all four
 * taken is refused `429` / `1016`, and the client's close reaches them all.
 * The connection is destroyed only once the write has been handed to the
 * kernel whole, as `abandonList` does, so no request is cut off by the close
 * (#141). Answers how many bytes came back before the close, or
 * the write's or the socket's error.
 */
function pipelinedLists(forwardedFor, path, count) {
  return new Promise((resolve) => {
    const socket = net.connect(3000, '10.145.1.3');
    let received = 0;
    let settled = false;
    const settle = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({ received, ...(error === undefined ? {} : { error }) });
    };

    socket.on('data', (chunk) => {
      received += chunk.length;
    });
    socket.on('error', (error) => settle(error.code ?? String(error)));
    socket.on('close', () => settle());
    socket.once('connect', () => {
      const one = `GET ${path} HTTP/1.1\r\nHost: ${APP_HOST}\r\nX-Forwarded-For: ${forwardedFor}\r\n\r\n`;

      socket.write(one.repeat(count), (error) => {
        if (error) {
          settle(error.code ?? String(error));
        }

        socket.destroy();
      });
    });
  });
}

/** The address the API probe's calls are counted under (#213): never one of `ATTACK`. */
const API_PROBE_ADDRESS = '198.51.100.213';

/** How long the API probe waits for an answer before it counts the call timed out. */
const API_PROBE_TIMEOUT_MS = Number(process.env.API_PROBE_TIMEOUT_MS ?? 60_000);

/**
 * One call of the API probe: a `GET` of `path` straight to the application
 * listener, counted under `API_PROBE_ADDRESS`, read to its end, with `key` as
 * `Authorization: Bearer` when given (a private session, D253). Answers its
 * status, the `errorCode` of a refusal, and how long it took; status 0 with
 * `timeout` once `API_PROBE_TIMEOUT_MS` has passed without its end.
 */
function apiProbeCall(path, source = API_PROBE_ADDRESS, key = undefined) {
  const started = performance.now();

  return new Promise((resolve) => {
    const call = http.request(
      `${API}${path}`,
      {
        headers: {
          'x-forwarded-for': source,
          ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
        },
        agent: false,
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => {
          if (response.statusCode !== 200) {
            chunks.push(chunk);
          }
        });
        response.on('end', () => {
          const errorCode = /"errorCode":(\d+)/.exec(Buffer.concat(chunks).toString('utf8'))?.[1];

          resolve({
            status: response.statusCode,
            ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
            ms: performance.now() - started,
          });
        });
        response.on('error', (error) =>
          resolve({
            status: 0,
            error: error.code ?? String(error),
            ms: performance.now() - started,
          }),
        );
      },
    );

    call.setTimeout(API_PROBE_TIMEOUT_MS, () => call.destroy(new Error('timeout')));
    call.on('error', (error) =>
      resolve({
        status: 0,
        error: error.message === 'timeout' ? 'timeout' : (error.code ?? String(error)),
        ms: performance.now() - started,
      }),
    );
    call.end();
  });
}

/**
 * The API probe's loop, in a child process of its own (`api-worker`), as the
 * small captures' is: `perSecond` calls of `path` a second until SIGTERM,
 * then their answers written to `outFile`. A session's key comes in
 * `API_PROBE_KEY`, kept off the command line.
 */
async function apiWorker(path, perSecond, outFile, source = API_PROBE_ADDRESS) {
  const key = process.env.API_PROBE_KEY;
  const fired = [];
  let running = true;

  process.on('SIGTERM', () => {
    running = false;
  });

  let next = performance.now();

  while (running) {
    fired.push(apiProbeCall(path, source, key));
    next += 1_000 / perSecond;

    const wait = next - performance.now();

    if (wait > 0) {
      await sleep(wait);
    }
  }

  writeFileSync(outFile, JSON.stringify(await Promise.all(fired)));
}

/** How many API probes this process has started, which names each one's file. */
let apiProbesStarted = 0;

/**
 * The API probe (#213): a client that stays for its answers, `perSecond`
 * calls of `path` a second from `source`, `API_PROBE_ADDRESS` unless given,
 * from now until `stop()`, which answers their statuses and timings; `key`
 * reads a private session (D253). What the API answers someone else while
 * the attacking addresses flood it: every call `200` or an existing `429`,
 * none `5xx` or timed out, and how late.
 */
function apiProbe(path, perSecond, source = API_PROBE_ADDRESS, key = undefined) {
  apiProbesStarted += 1;

  // Named by its reader's address and a count of this process's probes, so
  // that two started in the same millisecond - Scope 5's two bystanders -
  // never write one file (#244).
  const outFile = `/tmp/api-${process.pid}-${source}-${apiProbesStarted}.json`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'api-worker', path, String(perSecond), outFile, source],
    {
      stdio: 'ignore',
      env: { ...process.env, ...(key === undefined ? {} : { API_PROBE_KEY: key }) },
    },
  );

  return {
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));

      try {
        return JSON.parse(readFileSync(outFile, 'utf8'));
      } catch {
        return [];
      }
    },
  };
}

/**
 * The series of issue #141 (D201 point 8's note), from the first `ADDR_COUNT`
 * attacking addresses: lists with bodies whose clients leave at once, so the
 * list place comes back at once and the statement settles with no one to
 * answer. `SHAPE` chooses one of the five shapes C1 lists; `COUNT` is the
 * lists one address fires at once, or the pipeline's depth for `pipelined`.
 * `SUSTAIN_S` with `RATE_PER_MIN` fires at that rate per address for that many
 * seconds instead of all at once - #139's 1,200 a minute at the largest
 * spread; `pipelined` has no such form. `FILL` is the session's captures, 20
 * a list with bodies shows at most, 100 for the query. The orchestrator reads what the backend and PostgreSQL hold
 * (`series.pgActivity`); the client reports what it could see and the small
 * captures, whose every one must be stored within 5 s. Since #213 a client
 * that stays for its answers, the API probe (`apiProbe`), lists the session
 * without bodies `API_PER_SECOND` times a second, 2 unless given, throughout,
 * and the attacking calls' slowest answer seen is reported (`attackMaxMs`).
 */
async function abandonedListSeries(shape) {
  const addrCount = Number(process.env.ADDR_COUNT ?? 1);
  const addresses = ATTACK.slice(0, addrCount).map((address) => address.local);
  const count = Number(process.env.COUNT ?? 128);
  const sustainS = Number(process.env.SUSTAIN_S ?? 0);
  const ratePerMin = Number(process.env.RATE_PER_MIN ?? 1_200);
  const pathBytes = Number(process.env.PATH_BYTES ?? 15_000);
  const fill = Number(process.env.FILL ?? (shape === 'query' ? 100 : 20));

  // Shape 4 has no sustained form: a pipeline is written at once and its
  // connection closed, so a minute of it at `RATE_PER_MIN` would be either one
  // pipeline of 1,200, past the 128 calls an address may hold at once and so
  // a burst again, or lists each on a connection of its own, which is shape
  // 1's minute (#141).
  if (shape === 'pipelined' && sustainS > 0) {
    throw new Error('abandon-pipelined has no sustained form; run it without SUSTAIN_S');
  }

  const sessionId = await createSession(0);
  const fillStartedAt = performance.now();

  for (let index = 0; index < fill; index += 1) {
    const status = await bigCapture(sessionId, pathBytes, MIB);

    if (status !== 200) {
      throw new Error(`filling the session answered ${status} on capture ${index}`);
    }
  }

  const fillMs = Math.round(performance.now() - fillStartedAt);
  const smallSessionId = await createSession(0);
  const small = smallCaptures(smallSessionId, Number(process.env.SMALL_PER_SECOND ?? 10));

  const listPath = `/api/sessions/${sessionId}/requests?include=body`;
  const controlPath = `/api/sessions/${sessionId}/requests`;
  const probe = apiProbe(controlPath, Number(process.env.API_PER_SECOND ?? 2));
  // A body condition of 200 bytes present in no body: the slowest statement
  // the query runs, a scan of every stored body (D196).
  const queryBody = JSON.stringify({ include: ['body'], body: ['\u0002'.repeat(200)] });

  const oneCall = (forwardedFor) => {
    if (shape === 'get') {
      return abandonList(forwardedFor, listPath, 'at-once');
    }

    if (shape === 'mid') {
      return abandonList(forwardedFor, listPath, 'mid');
    }

    if (shape === 'query') {
      return abandonList(forwardedFor, `/api/sessions/${sessionId}/requests/query`, 'at-once', {
        method: 'POST',
        payload: queryBody,
      });
    }

    if (shape === 'control') {
      return abandonList(forwardedFor, controlPath, 'at-once');
    }

    throw new Error(`no such abandon shape: ${shape}`);
  };

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const answers = [];
  const startedAt = performance.now();

  if (shape === 'pipelined') {
    answers.push(
      ...(await Promise.all(addresses.map((address) => pipelinedLists(address, listPath, count)))),
    );
  } else if (sustainS > 0) {
    // Each address keeps to `ratePerMin` a minute for `sustainS` seconds.
    const intervalMs = 60_000 / ratePerMin;

    await Promise.all(
      addresses.map(async (address) => {
        const fired = [];
        const endAt = performance.now() + sustainS * 1_000;
        let next = performance.now();

        while (performance.now() < endAt) {
          fired.push(oneCall(address));
          next += intervalMs;

          const wait = next - performance.now();

          if (wait > 0) {
            await sleep(wait);
          }
        }

        answers.push(...(await Promise.all(fired)));
      }),
    );
  } else {
    await Promise.all(
      addresses.map((address) =>
        Promise.all(Array.from({ length: count }, () => oneCall(address))).then((results) =>
          answers.push(...results),
        ),
      ),
    );
  }

  const burstMs = Math.round(performance.now() - startedAt);

  // Let the abandoned statements settle so the orchestrator's PostgreSQL
  // sampler sees the drain: a list of metadata is quick, a query bounded by
  // the two search slots and the 2 s statement timeout.
  await sleep(Number(process.env.HOLD_S ?? 15) * 1_000);
  emit({ phase: 'done' });

  const [smallAnswers, probeAnswers] = await Promise.all([small.stop(), probe.stop()]);
  const smallRead = await requestsCount(smallSessionId, S8_READ_ADDRESS).then(
    (stored) => ({ stored }),
    (error) => ({ stored: null, readError: error?.code ?? String(error) }),
  );
  const targetStored = await requestsCount(sessionId, S8_READ_ADDRESS).then(
    (stored) => stored,
    () => null,
  );
  // The attacking calls whose clients saw an answer: the head of shape 2.
  const answeredMs = answers
    .filter((answer) => typeof answer.status === 'number' && answer.status > 0)
    .map((answer) => answer.ms);

  const statuses = {};

  for (const answer of answers) {
    const key =
      answer.status === 0 && answer.error !== undefined
        ? `0 ${answer.error}`
        : String(answer.status ?? answer.error ?? (answer.received !== undefined ? 'piped' : '?'));

    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  return {
    shape,
    addresses: addrCount,
    perAddress: shape === 'pipelined' ? undefined : sustainS > 0 ? undefined : count,
    pipelineDepth: shape === 'pipelined' ? count : undefined,
    sustainS: sustainS > 0 ? sustainS : undefined,
    ratePerMin: sustainS > 0 ? ratePerMin : undefined,
    fill,
    fillMs,
    sent: answers.length,
    statuses,
    burstMs,
    midStatuses: shape === 'mid' ? statuses : undefined,
    pipelinedBytesMax:
      shape === 'pipelined'
        ? Math.max(0, ...answers.map((answer) => answer.received ?? 0))
        : undefined,
    targetStored,
    attackMaxMs: answeredMs.length === 0 ? null : Math.round(Math.max(...answeredMs)),
    api: {
      path: 'GET /api/sessions/:id/requests',
      readFrom: API_PROBE_ADDRESS,
      timeoutMs: API_PROBE_TIMEOUT_MS,
      ...tally(
        probeAnswers.map((answer) => ({ ...answer, status: answer.status || answer.error })),
      ),
      ...percentiles(probeAnswers.map((answer) => answer.ms)),
    },
    small: {
      sent: smallAnswers.length,
      ...tally(smallAnswers.map((answer) => ({ status: answer.status, ms: answer.ms }))),
      ...percentiles(smallAnswers.map((answer) => answer.ms)),
      ...smallRead,
      // Every capture answered `200` is stored; a session keeps its newest
      // 1000 (D006), so a run of more reads 1000 at most.
      storedAll:
        smallRead.stored ===
          Math.min(smallAnswers.filter((answer) => answer.status === 200).length, 1_000) &&
        smallAnswers.every((answer) => answer.status === 200),
      readFrom: S8_READ_ADDRESS,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Scope 5 (#244, D244 point 7): the row-lock variant of #243's line stall. */
/* ------------------------------------------------------------------------ */

/** The address the target session's capture burst is counted under, never one of `ATTACK` or a reader's. */
const ROW_LOCK_BURST_ADDRESS = '198.51.100.90';
/** The bystander reading the contended session, never one of `ATTACK`, the probe's, or the burst's. */
const ROW_LOCK_CONTENDED_READER = '198.51.100.214';
/** The bystander reading a quiet session nothing touches. */
const ROW_LOCK_QUIET_READER = '198.51.100.215';
/** The address the throwaway sessions' captures are counted under, apart from the burst's. */
const ROW_LOCK_THROWAWAY_ADDRESS = '198.51.100.91';

/**
 * The 50th and 99th percentiles and the largest of `values` in milliseconds,
 * and how many there were: the bystanders' read timings of Scope 5, reported
 * as p50 / p99 / max, the figures the choice among #244's levers rests on.
 * Rounded to the millisecond, 0 for none.
 */
export function summarizePercentiles(values) {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const at = (fraction) =>
    sorted.length === 0
      ? 0
      : Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]);

  return { count: sorted.length, p50Ms: at(0.5), p99Ms: at(0.99), maxMs: at(1) };
}

/**
 * A set of answers reported for the choice among #244's levers: how many were
 * answered a `2xx` (a read `200`, a `DELETE` `204`), how many refused `429`
 * (with the `errorCode`s seen) and how many were anything else - a `404` for a
 * request already gone, a reset or a timeout, status 0 - beside their p50 /
 * p99 / max. Within an address's published rate nothing should refuse a read
 * (D201), so `refused` is the number that answers "does the row lock leave
 * another address's API unusable".
 */
export function rowLockReport(answers) {
  const ok = answers.filter((answer) => answer.status >= 200 && answer.status < 300).length;
  const refused = answers.filter((answer) => answer.status === 429).length;
  const refusedCodes = {};

  for (const answer of answers) {
    if (answer.status === 429 && answer.errorCode !== undefined) {
      refusedCodes[String(answer.errorCode)] = (refusedCodes[String(answer.errorCode)] ?? 0) + 1;
    }
  }

  return {
    sent: answers.length,
    ok,
    refused,
    ...(Object.keys(refusedCodes).length === 0 ? {} : { refusedCodes }),
    other: answers.length - ok - refused,
    ...summarizePercentiles(answers.map((answer) => answer.ms)),
  };
}

/** A session created counted under `forwardedFor`; null when its creation was refused. */
async function createSessionAs(forwardedFor) {
  const answer = await api('/api/sessions', 'POST', undefined, { 'x-forwarded-for': forwardedFor });

  return answer.status === 201 ? JSON.parse(answer.text).id : null;
}

/** The ids of up to `limit` of a session's requests, newest first, counted under `forwardedFor`. */
async function listRequestIds(sessionId, forwardedFor, limit = 200) {
  const answer = await api(`/api/sessions/${sessionId}/requests?limit=${limit}`, 'GET', undefined, {
    'x-forwarded-for': forwardedFor,
  });

  if (answer.status !== 200) {
    return [];
  }

  try {
    return JSON.parse(answer.text).map((entry) => entry.id);
  } catch {
    return [];
  }
}

/**
 * A capture stream's report, capped at the newest 1000 a session keeps (D006):
 * how many were answered `200` and accepted beside their timings. `allAccepted`
 * is the criterion-2 claim - every capture stored, nothing refused - for a
 * stream nothing deletes from, as the side load is. The row-lock target has
 * requests deleted out from under it, so its `stored` is below its `ok` by
 * design and `storedAll` is false; `allAccepted` still holds, since a deletion
 * is not a refusal.
 */
function burstReport(answers, stored) {
  const ok = answers.filter((answer) => answer.status === 200).length;
  const allAccepted = answers.length > 0 && answers.every((answer) => answer.status === 200);

  return {
    sent: answers.length,
    ok,
    ...summarizePercentiles(answers.map((answer) => answer.ms)),
    stored,
    allAccepted,
    storedAll: allAccepted && stored === Math.min(ok, 1_000),
  };
}

/**
 * A session `DELETE` that meets captures on the row it deletes (#244):
 * `count` captures to `sessionId` fired at once and not
 * awaited, and the `DELETE`, from `forwardedFor`, sent once the first of them
 * has answered, so that the rest are in the session's line or in their
 * transaction, one of them holding the row's `FOR UPDATE`, as the `DELETE`
 * asks for it; then every capture read to its answer. Answers the
 * `DELETE`'s answer and, of the captures not yet answered when it was sent,
 * how many were stored (`200`) and how many found the session gone (`404`):
 * both above 0 shows the deletion landed among the captures of that row.
 * Whether it waited on the row lock, and how long, PostgreSQL's log of lock
 * waits says (`lockWaits`); a `200` read after the send may have committed
 * just before the `DELETE` reached the database.
 */
async function deleteAmidCaptures(sessionId, count, forwardedFor) {
  const answers = Array.from({ length: count }, () => null);
  const captures = answers.map((_, index) =>
    smallCapture(sessionId, ROW_LOCK_THROWAWAY_ADDRESS).then((answer) => {
      answers[index] = answer;

      return answer;
    }),
  );

  await Promise.race(captures);

  const inFlight = answers.flatMap((answer, index) => (answer === null ? [index] : []));
  const deletion = await countedCall(
    `/api/sessions/${sessionId}`,
    'DELETE',
    undefined,
    forwardedFor,
  );

  await Promise.all(captures);

  return {
    deletion,
    inFlightAtSend: inFlight.length,
    storedAfterSend: inFlight.filter((index) => answers[index].status === 200).length,
    goneAfterSend: inFlight.filter((index) => answers[index].status === 404).length,
    statuses: answers.map((answer) => answer.status),
  };
}

/**
 * The throwaway deletions of `row-lock` tallied (#244): how many met captures
 * still unanswered when sent, how many of those captures were stored and how
 * many found the session gone, and every throwaway capture's status.
 */
export function throwawayReport(deletions, capturesEach) {
  const statuses = {};

  for (const deletion of deletions) {
    for (const status of deletion.statuses) {
      statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
    }
  }

  const sum = (field) => deletions.reduce((total, deletion) => total + deletion[field], 0);

  return {
    deletions: deletions.length,
    capturesEach,
    withCapturesInFlight: deletions.filter((deletion) => deletion.inFlightAtSend > 0).length,
    landedAmongCaptures: deletions.filter(
      (deletion) => deletion.storedAfterSend > 0 && deletion.goneAfterSend > 0,
    ).length,
    inFlightAtSend: sum('inFlightAtSend'),
    storedAfterSend: sum('storedAfterSend'),
    goneAfterSend: sum('goneAfterSend'),
    captureStatuses: statuses,
  };
}

/**
 * Scope 5 of #244 (D244 point 7): the row-lock variant of #243's line stall,
 * made as a series of this harness rather than an ad-hoc script.
 * `CALL_ADDRESSES` (3) addresses within their rate (`RATE_PER_MIN`,
 * 1200) send, round robin, on a target session receiving a burst of
 * `CAPTURE_PER_SECOND` (100) captures for `LOAD_S` (30) seconds, a session
 * `GET` of the target, a `DELETE` of one of its requests, and every
 * `SESSION_DELETE_EVERY`-th op (30) a session `DELETE` of a throwaway session
 * sent amid `THROWAWAY_CAPTURES` (10) captures to it (`deleteAmidCaptures`).
 *
 * Which of them take the session row's lock, which a capture holds
 * `FOR UPDATE` from its first statement to its `COMMIT`, one capture of a
 * session at a time in its line (D065, D205):
 * - the session `DELETE` does, `FOR UPDATE`, outside the session's line
 *   (`deleteSessionInTransaction`): while a capture holds the row it waits,
 *   holding one of the gate's three slots and a connection of the API's pool
 *   (D244), and the captures behind it in the line wait for it in turn and
 *   then find the session gone. It is the one call here that waits on a
 *   capture's row lock;
 * - the session `GET` does not: its expiry refresh is an `UPDATE` whose
 *   condition (`REFRESH_DUE_SQL`, D242) is false for a session its captures
 *   keep refreshing, and PostgreSQL locks no row its condition leaves out,
 *   so it writes nothing and waits for nothing (inferred);
 * - the single-request `DELETE` does not: it deletes a request row, reading
 *   the session row unlocked (`deleteRequest`), and could wait only on a
 *   request a capture is evicting - the oldest, never the newest the series
 *   deletes.
 * PostgreSQL's log of lock waits over the series (`lockWaits`, a wait of
 * 1 ms or more) says which calls waited, on which relation, and how long.
 *
 * Beside the attack, two bystanders stay for their answers, each
 * `API_PER_SECOND` (5) reads a second from an address of its own: one reads
 * the contended target, one a quiet session nothing else touches (the
 * API's availability for an untouched session at 0.5 CPU). Each bystander's
 * read p50 / p99 / max and refusals are reported (`rowLockReport`), and the
 * attacking calls' own. The probe inside the backend reads each pool's
 * longest connection hold, from checkout to release: the capture pool's is
 * an upper bound of a capture's hold of the row, `BEGIN`, `COMMIT` and any
 * wait for a lock included; the API pool's includes a `DELETE`'s wait. The
 * side load's 10 small captures a second to their own session are the bar.
 */
async function rowLockSeries() {
  const addrCount = Math.max(1, Math.min(ATTACK.length, Number(process.env.CALL_ADDRESSES ?? 3)));
  const addresses = ATTACK.slice(0, addrCount).map((address) => address.local);
  const ratePerMin = Number(process.env.RATE_PER_MIN ?? 1_200);
  const capturePerSecond = Number(process.env.CAPTURE_PER_SECOND ?? 100);
  const loadS = Number(process.env.LOAD_S ?? 30);
  const sessionDeleteEvery = Number(process.env.SESSION_DELETE_EVERY ?? 30);
  const throwawayCaptures = Math.max(2, Number(process.env.THROWAWAY_CAPTURES ?? 10));
  const fill = Number(process.env.FILL ?? 100);
  const apiPerSecond = Number(process.env.API_PER_SECOND ?? 5);

  const target = await createSession();
  const quiet = await createSession();

  for (let index = 0; index < fill; index += 1) {
    const { status } = await smallCapture(target, ROW_LOCK_BURST_ADDRESS);

    if (status !== 200) {
      throw new Error(`filling the target answered ${status} on capture ${index}`);
    }
  }

  // A shared queue of request ids to delete, refilled by listing the target;
  // a delete that races another address's finds the row gone and is `404`.
  let idQueue = await listRequestIds(target, addresses[0]);
  let listing = false;
  const nextId = async (forwardedFor) => {
    if (idQueue.length === 0 && !listing) {
      listing = true;

      try {
        idQueue = await listRequestIds(target, forwardedFor);
      } finally {
        listing = false;
      }
    }

    return idQueue.shift();
  };

  const smallSessionId = await createSession();
  const small = smallCaptures(smallSessionId, Number(process.env.SMALL_PER_SECOND ?? 10));
  const burst = smallCaptures(target, capturePerSecond, ROW_LOCK_BURST_ADDRESS);
  const contendedReads = apiProbe(
    `/api/sessions/${target}`,
    apiPerSecond,
    ROW_LOCK_CONTENDED_READER,
  );
  const quietReads = apiProbe(`/api/sessions/${quiet}`, apiPerSecond, ROW_LOCK_QUIET_READER);

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const ops = { get: [], requestDelete: [], sessionDelete: [], throwaway: [], create429: 0 };
  const intervalMs = 60_000 / ratePerMin;
  const endAt = performance.now() + loadS * 1_000;

  await Promise.all(
    addresses.map(async (address) => {
      let count = 0;
      let next = performance.now();

      while (performance.now() < endAt) {
        count += 1;

        if (count % sessionDeleteEvery === 0) {
          const throwaway = await createSessionAs(address);

          if (throwaway === null) {
            ops.create429 += 1;
          } else {
            const deletion = await deleteAmidCaptures(throwaway, throwawayCaptures, address);

            ops.sessionDelete.push(deletion.deletion);
            ops.throwaway.push(deletion);
          }
        } else if (count % 2 === 0) {
          const id = await nextId(address);

          if (id !== undefined) {
            ops.requestDelete.push(
              await countedCall(
                `/api/sessions/${target}/requests/${id}`,
                'DELETE',
                undefined,
                address,
              ),
            );
          } else {
            ops.get.push(await countedCall(`/api/sessions/${target}`, 'GET', undefined, address));
          }
        } else {
          ops.get.push(await countedCall(`/api/sessions/${target}`, 'GET', undefined, address));
        }

        next += intervalMs;

        const wait = next - performance.now();

        if (wait > 0) {
          await sleep(wait);
        }
      }
    }),
  );

  await sleep(Number(process.env.HOLD_S ?? 5) * 1_000);
  emit({ phase: 'done' });

  const [smallAnswers, contended, quietAnswers, burstAnswers] = await Promise.all([
    small.stop(),
    contendedReads.stop(),
    quietReads.stop(),
    burst.stop(),
  ]);
  const smallRead = await requestsCount(smallSessionId).then(
    (stored) => stored,
    () => null,
  );
  const targetStored = await requestsCount(target).then(
    (stored) => stored,
    () => null,
  );

  return {
    shape: 'row-lock',
    addresses: addrCount,
    ratePerMin,
    capturePerSecond,
    loadS,
    attack: {
      get: rowLockReport(ops.get),
      requestDelete: rowLockReport(ops.requestDelete),
      sessionDelete: rowLockReport(ops.sessionDelete),
      throwaway: throwawayReport(ops.throwaway, throwawayCaptures),
      create429: ops.create429,
    },
    contendedRead: {
      path: 'GET /api/sessions/:id (contended)',
      readFrom: ROW_LOCK_CONTENDED_READER,
      ...rowLockReport(contended),
    },
    quietRead: {
      path: 'GET /api/sessions/:id (quiet)',
      readFrom: ROW_LOCK_QUIET_READER,
      ...rowLockReport(quietAnswers),
    },
    targetBurst: {
      readFrom: ROW_LOCK_BURST_ADDRESS,
      ...burstReport(burstAnswers, targetStored),
    },
    small: {
      readFrom: SMALL_ADDRESS,
      ...burstReport(smallAnswers, smallRead),
    },
  };
}

/**
 * Scope 5's control (#244): #243's line stall itself - `CHANGES` (3) changes
 * (`PUT .../response`) kept in flight at once in one session's line behind its
 * captures, which before #243's fix held every one of the gate's slots and
 * stalled the API of every address (D244 point 4). On the head and on main
 * alike since that fix, a bystander reading a quiet session stays fast, which
 * is what this control shows: the fix holds. The target
 * takes the capture burst, one address keeps `CHANGES` `PUT .../response` in
 * flight for `LOAD_S` seconds - each waiting its turn in the target's line
 * behind the captures, holding no slot of the gate - and the quiet bystander
 * reads a session nothing else touches.
 */
async function rowLockControlSeries() {
  const changeCount = Number(process.env.CHANGES ?? 3);
  const changeAddress = ATTACK[1].local;
  const capturePerSecond = Number(process.env.CAPTURE_PER_SECOND ?? 100);
  const loadS = Number(process.env.LOAD_S ?? 30);
  const apiPerSecond = Number(process.env.API_PER_SECOND ?? 5);
  // One change from each worker at a time, replaced when it answers but no
  // sooner than this - so the address keeps `changeCount` changes in flight, as
  // #243's line stall had three, without, when the line is not backed up and
  // each change answers at once, firing thousands a second and meeting its own
  // address's 1200-a-minute limit (D201). `changeCount` × 1000 / this stays
  // under that; uncontended each change still waits its turn in the line behind
  // the captures, the shape of #243's line stall (D244 point 4).
  const changeIntervalMs = Number(process.env.CHANGE_INTERVAL_MS ?? 250);

  const target = await createSession();
  const quiet = await createSession();
  const smallSessionId = await createSession();
  const changeBody = JSON.stringify({
    mode: 'custom',
    response: { status: 200, headers: [], body: '{"ok":true}', delayMs: 0 },
  });

  const small = smallCaptures(smallSessionId, Number(process.env.SMALL_PER_SECOND ?? 10));
  const burst = smallCaptures(target, capturePerSecond, ROW_LOCK_BURST_ADDRESS);
  const quietReads = apiProbe(`/api/sessions/${quiet}`, apiPerSecond, ROW_LOCK_QUIET_READER);

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const changes = [];
  const endAt = performance.now() + loadS * 1_000;

  await Promise.all(
    Array.from({ length: changeCount }, async () => {
      while (performance.now() < endAt) {
        const started = performance.now();

        changes.push(
          await countedCall(`/api/sessions/${target}/response`, 'PUT', changeBody, changeAddress),
        );

        const wait = changeIntervalMs - (performance.now() - started);

        if (wait > 0) {
          await sleep(Math.min(wait, Math.max(0, endAt - performance.now())));
        }
      }
    }),
  );

  await sleep(Number(process.env.HOLD_S ?? 5) * 1_000);
  emit({ phase: 'done' });

  const [smallAnswers, quietAnswers, burstAnswers] = await Promise.all([
    small.stop(),
    quietReads.stop(),
    burst.stop(),
  ]);
  const smallRead = await requestsCount(smallSessionId).then(
    (stored) => stored,
    () => null,
  );
  const targetStored = await requestsCount(target).then(
    (stored) => stored,
    () => null,
  );

  return {
    shape: 'row-lock-control',
    changeCount,
    changeAddress,
    capturePerSecond,
    loadS,
    changes: rowLockReport(changes),
    quietRead: {
      path: 'GET /api/sessions/:id (quiet)',
      readFrom: ROW_LOCK_QUIET_READER,
      ...rowLockReport(quietAnswers),
    },
    targetBurst: {
      readFrom: ROW_LOCK_BURST_ADDRESS,
      ...burstReport(burstAnswers, targetStored),
    },
    small: {
      readFrom: SMALL_ADDRESS,
      ...burstReport(smallAnswers, smallRead),
    },
  };
}

/**
 * Scope 5's repeatable shape (#244): a session `DELETE`
 * refused once it holds the row. A private session's `DELETE` without its
 * key takes the row `FOR UPDATE` first and is refused next, the lock held,
 * as a session that does not exist (`404` / `1001`, D245): it deletes
 * nothing, so whoever knows the session's id - every sender of its webhooks
 * does - can send it again and again. `CALL_ADDRESSES` (3) addresses send it,
 * each one at a time within `RATE_PER_MIN` (1200), to a private target
 * receiving `CAPTURE_PER_SECOND` (100) captures a second for `LOAD_S` (30)
 * seconds: each waits for the capture holding the row, holding one of the
 * gate's three slots and an API connection meanwhile, and the next capture
 * in the line waits for it in turn, so three at once can hold every slot of
 * the gate. The bystanders read as in `row-lock`, the contended one with the
 * target's key; every capture to the target must be answered `200` and
 * stored, nothing deleting from it.
 */
async function rowLockRefusedSeries() {
  const addrCount = Math.max(1, Math.min(ATTACK.length, Number(process.env.CALL_ADDRESSES ?? 3)));
  const addresses = ATTACK.slice(0, addrCount).map((address) => address.local);
  const ratePerMin = Number(process.env.RATE_PER_MIN ?? 1_200);
  const capturePerSecond = Number(process.env.CAPTURE_PER_SECOND ?? 100);
  const loadS = Number(process.env.LOAD_S ?? 30);
  const apiPerSecond = Number(process.env.API_PER_SECOND ?? 5);

  // No `Authorization`, so the server draws the key and answers it once (D253).
  const created = await api('/api/sessions', 'POST', JSON.stringify({ private: true }));

  if (created.status !== 201) {
    throw new Error(`creating the private target answered ${created.status}: ${created.text}`);
  }

  const { id: target, accessKey } = JSON.parse(created.text);
  const quiet = await createSession();
  const smallSessionId = await createSession();
  const small = smallCaptures(smallSessionId, Number(process.env.SMALL_PER_SECOND ?? 10));
  const burst = smallCaptures(target, capturePerSecond, ROW_LOCK_BURST_ADDRESS);
  const contendedReads = apiProbe(
    `/api/sessions/${target}`,
    apiPerSecond,
    ROW_LOCK_CONTENDED_READER,
    accessKey,
  );
  const quietReads = apiProbe(`/api/sessions/${quiet}`, apiPerSecond, ROW_LOCK_QUIET_READER);

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const deletes = [];
  const intervalMs = 60_000 / ratePerMin;
  const endAt = performance.now() + loadS * 1_000;

  await Promise.all(
    addresses.map(async (address) => {
      let next = performance.now();

      while (performance.now() < endAt) {
        deletes.push(await countedCall(`/api/sessions/${target}`, 'DELETE', undefined, address));
        next += intervalMs;

        const wait = next - performance.now();

        if (wait > 0) {
          await sleep(wait);
        }
      }
    }),
  );

  await sleep(Number(process.env.HOLD_S ?? 5) * 1_000);
  emit({ phase: 'done' });

  const [smallAnswers, contended, quietAnswers, burstAnswers] = await Promise.all([
    small.stop(),
    contendedReads.stop(),
    quietReads.stop(),
    burst.stop(),
  ]);
  const smallRead = await requestsCount(smallSessionId).then(
    (stored) => stored,
    () => null,
  );
  const targetStored = await requestsCount(target, undefined, accessKey).then(
    (stored) => stored,
    () => null,
  );

  return {
    shape: 'row-lock-refused',
    addresses: addrCount,
    ratePerMin,
    capturePerSecond,
    loadS,
    attack: {
      sessionDelete: rowLockReport(deletes),
      // Each refused as a session that does not exist, the lock taken first.
      notFound: deletes.filter((answer) => answer.status === 404 && answer.errorCode === 1001)
        .length,
    },
    contendedRead: {
      path: 'GET /api/sessions/:id (contended, private, with its key)',
      readFrom: ROW_LOCK_CONTENDED_READER,
      ...rowLockReport(contended),
    },
    quietRead: {
      path: 'GET /api/sessions/:id (quiet)',
      readFrom: ROW_LOCK_QUIET_READER,
      ...rowLockReport(quietAnswers),
    },
    targetBurst: {
      readFrom: ROW_LOCK_BURST_ADDRESS,
      ...burstReport(burstAnswers, targetStored),
    },
    small: {
      readFrom: SMALL_ADDRESS,
      ...burstReport(smallAnswers, smallRead),
    },
  };
}

/** The median and the 95th percentile of `values`, rounded to the millisecond. */
function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) =>
    sorted.length === 0
      ? 0
      : Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]);

  return { medianMs: at(0.5), p95Ms: at(0.95) };
}

/** The header lines a connection stalled in its headers sends, its blank line never. */
function stalledHead(shape, sessionId) {
  const start = `POST /s/${sessionId} HTTP/1.1\r\nHost: ${RECEIVE_HOST}\r\n`;

  if (shape === 'heavy') {
    // 140 lines of 107 counted bytes: 14,980 of Node's 16 KiB.
    return (
      start +
      Array.from(
        { length: 140 },
        (_, index) => `x-h-${String(index).padStart(3, '0')}: ${'v'.repeat(100)}\r\n`,
      ).join('')
    );
  }

  if (shape === 'lines') {
    // 16,000 lines of one counted byte: as many lines as Node's 16 KiB allows.
    return start + 'a:\r\n'.repeat(16_000);
  }

  return `${start}X-Stall: 1\r\n`;
}

/** The first bytes of a TLS handshake to the receive host: a ClientHello naming it. */
function clientHello() {
  return new Promise((resolve) => {
    const written = [];
    const wire = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        written.push(chunk);
        resolve(Buffer.concat(written));
        callback();
      },
    });
    const socket = tls.connect({
      socket: wire,
      servername: RECEIVE_HOST,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });

    socket.on('error', () => undefined);
  });
}

/**
 * A TCP connection to Traefik at `address` that sends `hello` and nothing
 * more, its handshake never finished; resolves once connected, or with its
 * failure.
 */
function stalledHandshake(address, hello) {
  return new Promise((resolve) => {
    const socket = net.connect(EDGE_PORT, address);
    const state = {
      socket,
      secured: false,
      connected: false,
      closed: false,
      error: null,
      received: 0,
    };

    socket.on('data', (chunk) => {
      state.received += chunk.length;
    });
    socket.on('error', (error) => {
      state.error = error.code ?? String(error);
    });
    socket.on('close', () => {
      state.closed = true;
      resolve(state);
    });
    socket.once('connect', () => {
      state.connected = true;
      socket.write(hello);
      resolve(state);
    });
  });
}

/** Resolves once `connection` has received something or closed, or after `ms`. */
async function answered(connection, ms = 5_000) {
  const deadline = Date.now() + ms;

  while (connection.received === 0 && !connection.closed && Date.now() < deadline) {
    await sleep(20);
  }
}

/** A connection of `shape` from `address`, opened and left as the shape leaves it. */
async function heldConnection(shape, address, head, hello) {
  if (shape === 'handshake') {
    return stalledHandshake(address, hello);
  }

  const connection = await secure(address, RECEIVE_HOST);

  if (connection.secured) {
    if (shape === 'idle') {
      // Answered, then kept alive with nothing more sent.
      connection.socket.write(`GET /robots.txt HTTP/1.1\r\nHost: ${RECEIVE_HOST}\r\n\r\n`);
      await answered(connection);
    } else {
      connection.socket.write(head);
    }
  }

  return connection;
}

async function stallSeries() {
  const shape = process.env.SHAPE ?? 'plain';
  const count = Number(process.env.COUNT ?? 512);
  const holdMs = Number(process.env.HOLD_S ?? 20) * 1000;
  const sessionId = await createSession();
  const body = Buffer.alloc(1024, 0x61);
  const hello = await clientHello();

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1000);

  const head = stalledHead(shape, sessionId);
  const stalled = await Promise.all(
    Array.from({ length: count }, () => heldConnection(shape, EDGE, head, hello)),
  );
  const securedCount = stalled.filter((connection) => connection.secured).length;
  const connectedCount = stalled.filter(
    (connection) => (connection.secured || connection.connected) && !connection.closed,
  ).length;
  // What the idle ones were answered: everything after it is news.
  const receivedBefore = stalled.map((connection) => connection.received);

  // Time for Traefik to open each one's connection to the backend.
  await sleep(2_000);
  emit({ phase: 'held', secured: securedCount, connected: connectedCount });

  const overStarted = performance.now();
  const over = await heldConnection(shape, EDGE, head, hello);
  const overReceivedBefore = shape === 'idle' || shape === 'handshake' ? 0 : over.received;

  // Closed, or ended by the proxy, within 5 s, or still open then.
  while (!over.closed && !over.ended && performance.now() - overStarted < 5_000) {
    await sleep(20);
  }

  const overAnswer = {
    secured: over.secured,
    closed: over.closed,
    ended: over.ended ?? false,
    endedWithinMs: over.closed || over.ended ? Math.round(performance.now() - overStarted) : null,
    error: over.error,
    bytesReceived: over.received - overReceivedBefore,
  };

  // Then one more write, as a sender still sending would: the proxy, finding
  // the server gone, ends the connection.
  if (!over.closed && over.secured) {
    over.socket.write('x-more: 1\r\n');

    const wrote = performance.now();

    while (!over.closed && !over.ended && performance.now() - wrote < 5_000) {
      await sleep(20);
    }

    overAnswer.afterOneMoreWrite = {
      closed: over.closed,
      ended: over.ended,
      withinMs: over.closed || over.ended ? Math.round(performance.now() - wrote) : null,
      bytesReceived: over.received - overReceivedBefore,
    };
  }

  over.socket.destroy();

  const other = await edgeWebhook(OTHER, sessionId, body);
  const refusedWebhook = await edgeWebhook(EDGE, sessionId, body);

  await sleep(Math.max(0, holdMs - 1_500));

  const stillOpen = stalled.filter(
    (connection) => (connection.secured || connection.connected) && !connection.closed,
  );
  const answeredMeanwhile = stalled.filter(
    (connection, index) => connection.received > receivedBefore[index],
  ).length;

  // One closes; the next from the same address is served.
  stillOpen[0]?.socket.destroy();
  await sleep(500);

  const afterOneClosed = await edgeWebhook(EDGE, sessionId, body);

  emit({ phase: 'done' });

  for (const connection of stalled) {
    connection.socket.destroy();
  }

  const stored = await requestsCount(sessionId);

  return {
    shape,
    headBytes:
      shape === 'plain' || shape === 'heavy' || shape === 'lines' ? Buffer.byteLength(head) : 0,
    count,
    secured: securedCount,
    connected: connectedCount,
    openAfterHold: stillOpen.length,
    answeredWhileStalled: answeredMeanwhile,
    over: overAnswer,
    webhookFromOtherAddress: other,
    webhookFromSameAddressWhileFull: refusedWebhook,
    webhookFromSameAddressOnceOneClosed: afterOneClosed,
    stored,
  };
}

/** The response and the queue a session can publish its largest event with (D205 point 13). */
function escapedResponse(body) {
  const names = Array.from({ length: 20 }, (_, index) => `x-h-${String(index).padStart(2, '0')}`);
  const valueBytes = 8192 - names.reduce((sum, name) => sum + name.length + 4, 0);
  const each = Math.min(1024, Math.floor(valueBytes / names.length));

  return {
    status: 599,
    headers: names.map((name) => [name, '"'.repeat(each)]),
    body,
    delayMs: 30_000,
  };
}

function largestQueueBody() {
  const empty = JSON.stringify({ steps: Array.from({ length: 10 }, () => escapedResponse('')) });
  const characters = Math.min(65_536, Math.floor((MIB - Buffer.byteLength(empty)) / (6 * 10)));

  return JSON.stringify({
    steps: Array.from({ length: 10 }, () => escapedResponse('\u0001'.repeat(characters))),
  });
}

/**
 * A realtime connection through the edge, upgraded by hand: resolves once it
 * is subscribed (`ready`) or refused, and stops reading after `ready` - unless
 * `keepReading`, which reads every event as it comes and counts its bytes in
 * `received` (#231). `from`, one of `ATTACK`, connects from that address, so
 * that more viewers than an address's 16 (D227) can be open at once; by
 * default the client's edge address, the kernel's choice.
 */
function realtime(sessionId, { from, keepReading = false } = {}) {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: from?.host ?? EDGE,
      port: EDGE_PORT,
      ...(from === undefined ? {} : { localAddress: from.local }),
      servername: APP_HOST,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });
    const state = { socket, status: 0, closed: false, received: 0, body: '' };
    let buffered = Buffer.alloc(0);
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve(state);
      }
    };

    socket.on('error', () => undefined);
    socket.on('close', () => {
      state.closed = true;
      settle();
    });
    socket.on('data', (chunk) => {
      state.received += chunk.length;

      if (settled) {
        return;
      }

      buffered = Buffer.concat([buffered, chunk]);

      const headEnd = buffered.indexOf('\r\n\r\n');

      if (headEnd === -1) {
        return;
      }

      state.status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffered.toString('latin1'))?.[1] ?? 0);

      if (state.status !== 101) {
        const length = Number(/\r\ncontent-length: (\d+)/i.exec(buffered.toString('latin1'))?.[1]);

        if (buffered.length >= headEnd + 4 + length) {
          state.body = buffered.subarray(headEnd + 4).toString('utf8');
          settle();
        }

        return;
      }

      if (buffered.includes('{"type":"ready"}')) {
        // Subscribed: from now on nothing is read, or everything is.
        if (!keepReading) {
          socket.pause();
        }

        buffered = Buffer.alloc(0);
        settle();
      }
    });
    socket.once('secureConnect', () => {
      socket.write(
        `GET /ws/${sessionId}?events=session.updated HTTP/1.1\r\nHost: ${APP_HOST}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
      );
    });
  });
}

async function wsSeries() {
  const count = Number(process.env.COUNT ?? 16);
  const events = Number(process.env.EVENTS ?? 16);
  const sessionId = await createSession();
  const response = await api(
    `/api/sessions/${sessionId}/response`,
    'PUT',
    JSON.stringify({ mode: 'custom', response: escapedResponse('\u0001'.repeat(65_536)) }),
  );
  const queue = await api(`/api/sessions/${sessionId}/queue`, 'PUT', largestQueueBody());

  if (response.status !== 200 || queue.status !== 200) {
    throw new Error(`the session's state answered ${response.status} and ${queue.status}`);
  }

  const restartAnswer = await api(`/api/sessions/${sessionId}/queue/restart`, 'POST');
  const eventBytes = Buffer.byteLength(
    JSON.stringify({ type: 'session.updated', data: JSON.parse(restartAnswer.text) }),
  );

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1000);

  const connections = [];

  for (let index = 0; index < count; index += 1) {
    connections.push(await realtime(sessionId));
  }

  const subscribed = connections.filter((connection) => connection.status === 101).length;
  const next = await realtime(sessionId);
  const nextAnswer = { status: next.status, body: next.body };

  next.socket.destroy();
  emit({ phase: 'held', subscribed });

  const restarts = [];

  for (let index = 0; index < events; index += 1) {
    restarts.push((await api(`/api/sessions/${sessionId}/queue/restart`, 'POST')).status);
    await sleep(1_000);
  }

  await sleep(Number(process.env.SETTLE_S ?? 5) * 1000);
  emit({ phase: 'done' });

  // Read again: a connection the server cut for falling behind ends.
  for (const connection of connections) {
    connection.socket.resume();
  }

  await sleep(2_000);

  const cut = connections.filter((connection) => connection.closed).length;

  for (const connection of connections) {
    connection.socket.destroy();
  }

  return {
    count,
    eventBytes,
    subscribed,
    nextFromSameAddress: nextAnswer,
    restarts,
    cutByTheServer: cut,
    bytesReceivedAtMost: Math.max(...connections.map((connection) => connection.received)),
  };
}

async function edgeBurstSeries() {
  const count = Number(process.env.COUNT ?? 500);
  const sessionId = await createSession();
  const body = Buffer.from(Array.from({ length: MIB }, (_, index) => index % 256));

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1000);
  emit({ phase: 'held' });

  const answers = await Promise.all(
    Array.from({ length: count }, () => edgeWebhook(EDGE, sessionId, body)),
  );

  emit({ phase: 'done' });

  const statuses = {};

  for (const answer of answers) {
    const key =
      answer.errorCode === undefined ? answer.status : `${answer.status}/${answer.errorCode}`;

    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  const stored = await requestsCount(sessionId);

  return { count, statuses, stored };
}

/* ------------------------------------------------------------------------ */
/* #238: whether the `413` / `1004` for a webhook declared over 1 MiB and   */
/* sent whole reaches its sender through Traefik as often as before the     */
/* close rule of 0.57.1 (D227 point 4).                                     */
/* ------------------------------------------------------------------------ */

/** How a connection ended with no answer read when its peer reset it: read, or written to. */
const RESETS = new Set(['ECONNRESET', 'EPIPE']);

/**
 * `COUNT` (20) webhooks at once to one valid session, each on a TLS
 * connection of its own through Traefik from the edge address, as
 * `edge-burst` sends them, each declaring `BODY_BYTES` by `Content-Length`
 * and sending them whole with its head. Each client is counted once:
 * `read413` when it read the `413` / `1004`, `reset` when its connection
 * ended in `ECONNRESET` or `EPIPE` with no answer read, `other` for anything
 * else - another answer, a close with none, or none within `TIMEOUT_S` (30) -
 * which `statuses` names, an answer by its status and code, a connection
 * with none by `0/` and how it ended. `stored`, the session's requests
 * afterwards, should be 0.
 */
async function oversizeSeries() {
  const count = Number(process.env.COUNT ?? 20);
  const bodyBytes = Number(process.env.BODY_BYTES);
  const timeoutMs = Number(process.env.TIMEOUT_S ?? 30) * 1000;

  if (!Number.isSafeInteger(bodyBytes) || bodyBytes <= 0) {
    throw new Error(`BODY_BYTES must be a positive whole number, not ${process.env.BODY_BYTES}`);
  }

  const sessionId = await createSession();
  // Bytes 0 to 255 over and over, as `edge-burst`'s body has them.
  const body = Buffer.alloc(
    bodyBytes,
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
  );

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1000);
  emit({ phase: 'held' });

  const answers = await Promise.all(
    Array.from({ length: count }, () => edgeWebhook(EDGE, sessionId, body, timeoutMs)),
  );

  emit({ phase: 'done' });

  const outcomes = { read413: 0, reset: 0, other: 0 };
  const statuses = {};

  for (const answer of answers) {
    const key =
      answer.status === 0
        ? `0/${answer.error}`
        : answer.errorCode === undefined
          ? String(answer.status)
          : `${answer.status}/${answer.errorCode}`;

    statuses[key] = (statuses[key] ?? 0) + 1;

    if (answer.status === 413 && answer.errorCode === 1004) {
      outcomes.read413 += 1;
    } else if (answer.status === 0 && RESETS.has(answer.error)) {
      outcomes.reset += 1;
    } else {
      outcomes.other += 1;
    }
  }

  const stored = await requestsCount(sessionId);

  return {
    count,
    bodyBytes,
    ...outcomes,
    statuses,
    ...percentiles(answers.map((answer) => answer.ms)),
    stored,
  };
}

/* ------------------------------------------------------------------------ */
/* #231: what the largest session state costs the backend's memory while    */
/* it is saved and republished (D246 point 11, D221 point 9).               */
/*                                                                          */
/* Both series run on sessions each holding the largest state of D246      */
/* point 11 - a response at every limit, the largest queue and rules as     */
/* large as 1 MiB admits - each read by one viewer through the edge that    */
/* reads every event, so that the realtime listener fetches every           */
/* `session.updated` (it fetches payloads only for sessions with a          */
/* registration, in batches of 32). The calls go straight to the            */
/* application listener, as S8's do, each counted by its `X-Forwarded-For`  */
/* under one of the first `CALL_ADDRESSES` (8) attacking addresses in turn, */
/* so that no address nears its 1200 calls a minute (D201) or its 16 MiB of */
/* answers not yet written (D228): the bounds the load meets are the        */
/* process's own. Beside them, 10 small captures a second to another        */
/* session and `/healthz` every 250 ms, each in a child process. The bar is */
/* D229's, which the orchestrator's line reads (`bar`).                     */
/* ------------------------------------------------------------------------ */

/**
 * The body of `PUT .../rules` with twenty rules for any method on `/*`, each
 * response escapedResponse's, as large as 1 MiB allows, in one of two shapes
 * of text (D205 point 8 measured both on queues): `escaped`, bodies of
 * control characters, six bytes each in JSON and one in V8, as `hub.test.ts`
 * builds its largest (`largestRulesBody` of `testing/full-rules.ts`); and
 * `two-byte`, bodies of one Cyrillic letter and the rest ASCII, one byte a
 * character in JSON, which V8 holds two bytes a character - the parsed
 * rules, and every string the state is written into, the event among them.
 */
function largestRulesBody(shape) {
  const rulesOf = (body) => ({
    rules: Array.from({ length: 20 }, () => ({
      method: null,
      path: '/*',
      response: escapedResponse(body),
    })),
  });
  const empty = Buffer.byteLength(JSON.stringify(rulesOf('')));

  if (shape === 'escaped') {
    const characters = Math.min(65_536, Math.floor((MIB - empty) / (6 * 20)));

    return JSON.stringify(rulesOf('\u0001'.repeat(characters)));
  }

  if (shape === 'two-byte') {
    // The letter is two bytes in UTF-8, as JSON writes it.
    const ascii = Math.min(65_536 - 2, Math.floor((MIB - empty) / 20) - 2);

    return JSON.stringify(rulesOf(`я${'a'.repeat(ascii)}`));
  }

  throw new Error(`no such rules body: ${shape}`);
}

/** The attacking addresses the calls and viewers of #231's series are spread over. */
function callAddresses() {
  return ATTACK.slice(
    0,
    Math.max(1, Math.min(ATTACK.length, Number(process.env.CALL_ADDRESSES ?? 8))),
  );
}

/**
 * A new session given the largest state of D246 point 11, `rulesBody` its
 * rules, from the client's own address: its id, and the bytes of the
 * `session.updated` that state is published as.
 */
async function largestSession(rulesBody) {
  const id = await createSession();
  const response = await api(
    `/api/sessions/${id}/response`,
    'PUT',
    JSON.stringify({ mode: 'custom', response: escapedResponse('\u0001'.repeat(65_536)) }),
  );
  const queue = await api(`/api/sessions/${id}/queue`, 'PUT', largestQueueBody());
  const rules = await api(`/api/sessions/${id}/rules`, 'PUT', rulesBody);

  if (response.status !== 200 || queue.status !== 200 || rules.status !== 200) {
    throw new Error(
      `the session's state answered ${response.status}, ${queue.status} and ${rules.status}`,
    );
  }

  return {
    id,
    eventBytes: Buffer.byteLength(
      JSON.stringify({ type: 'session.updated', data: JSON.parse(rules.text) }),
    ),
  };
}

/**
 * One call straight to the application listener, counted under
 * `forwardedFor`, on a connection of its own, its answer read to its end and
 * only its first KiB kept: its status, the `errorCode` of a refusal, its
 * `Retry-After` and how long it took; status 0 when it failed or had no
 * answer within 60 s. A call with no payload says `Content-Length: 0`, as
 * Traefik forwards one, so that it takes no place of a large body.
 */
function countedCall(path, method, payload, forwardedFor) {
  return new Promise((resolve) => {
    const started = performance.now();
    const headers = {
      'x-forwarded-for': forwardedFor,
      ...(payload === undefined
        ? { 'content-length': 0 }
        : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
    };
    const call = http.request(
      `${API}${path}`,
      { method, headers, agent: false, timeout: 60_000 },
      (response) => {
        const head = [];
        let kept = 0;

        response.on('data', (chunk) => {
          if (kept < 1024) {
            head.push(chunk.subarray(0, 1024 - kept));
            kept += Math.min(chunk.length, 1024 - kept);
          }
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const errorCode =
            status >= 400
              ? /"errorCode":(\d+)/.exec(Buffer.concat(head).toString('utf8'))?.[1]
              : undefined;

          resolve({
            status,
            ...(errorCode === undefined ? {} : { errorCode: Number(errorCode) }),
            retryAfterS: Number(response.headers['retry-after'] ?? 0),
            ms: performance.now() - started,
          });
        });
        response.on('error', () => resolve({ status: 0, ms: performance.now() - started }));
      },
    );

    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve({ status: 0, ms: performance.now() - started }));
    call.end(payload);
  });
}

/** A tally of answers with the four counts #231 reads: `200`, `1017`, `1019` and the rest. */
function answersTally(answers) {
  const all = tally(answers);
  const of = (key) => all.statuses[key] ?? 0;
  const ok = of('200');
  const busy = of('429/1017');
  const unwritten = of('429/1019');

  return { 200: ok, 1017: busy, 1019: unwritten, other: all.count - ok - busy - unwritten, ...all };
}

/**
 * A viewer of `sessionId` through the edge from `from`, reading every event
 * as it comes and connecting again a second after it is cut, as the
 * frontend's viewer does (without its reload), so that its session keeps a
 * registration; until `stop()`, which answers how often the server cut it,
 * how often it was refused and the bytes it read. `ready` resolves with the
 * status of its first connection.
 */
function viewer(sessionId, from) {
  let running = true;
  let current = null;
  let cut = 0;
  let refused = 0;
  let received = 0;
  let firstStatus;
  const first = Promise.withResolvers();
  const done = (async () => {
    while (running) {
      current = await realtime(sessionId, { from, keepReading: true });

      if (firstStatus === undefined) {
        firstStatus = current.status;
        first.resolve(current.status);
      }

      if (current.status === 101) {
        const connection = current;

        await new Promise((resolve) => {
          if (connection.closed) {
            resolve();
          } else {
            connection.socket.once('close', resolve);
          }
        });

        if (running) {
          cut += 1;
        }
      } else {
        refused += 1;
        current.socket.destroy();
      }

      received += current.received;

      if (running) {
        await sleep(1_000);
      }
    }
  })();

  return {
    ready: first.promise,
    async stop() {
      running = false;
      current?.socket.destroy();
      await done;

      return { firstStatus, cut, refused, received };
    },
  };
}

/** What the viewers of a series saw, `eventBytes` the size of one event. */
function viewersReport(reports, eventBytes) {
  const received = reports.reduce((sum, report) => sum + report.received, 0);

  return {
    count: reports.length,
    subscribed: reports.filter((report) => report.firstStatus === 101).length,
    cut: reports.reduce((sum, report) => sum + report.cut, 0),
    viewersCut: reports.filter((report) => report.cut > 0).length,
    refused: reports.reduce((sum, report) => sum + report.refused, 0),
    bytesRead: received,
    eventsReadAbout: Math.round(received / eventBytes),
  };
}

/** `/healthz` asked every `everyMs` in a child process (`healthz-worker`) until `stop()`. */
function healthzInChild(everyMs) {
  const outFile = `/tmp/healthz-${process.pid}.json`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'healthz-worker', String(everyMs), outFile],
    { stdio: 'ignore' },
  );

  return {
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));

      try {
        return JSON.parse(readFileSync(outFile, 'utf8'));
      } catch {
        return null;
      }
    },
  };
}

/**
 * The `healthz-worker` child: `healthzProbes` until SIGTERM, its answer then
 * written to `outFile`. A process of its own, as the small captures are, so
 * that the viewers' reading - megabytes of TLS a second in the client - does
 * not delay the probes it times.
 */
async function healthzWorker(everyMs, outFile) {
  const probes = healthzProbes(everyMs);

  await new Promise((resolve) => process.once('SIGTERM', resolve));
  writeFileSync(outFile, JSON.stringify(await probes.stop()));
}

/**
 * The small captures' report once they are stopped: sent, answered, stored,
 * the slowest, the median and the 95th percentile, and how many took over
 * 5 s.
 */
async function sideLoadReport(small, sessionId) {
  const answers = await small.stop();
  const read = await requestsCount(sessionId).then(
    (stored) => ({ stored }),
    (error) => ({ stored: null, readError: error?.code ?? String(error) }),
  );
  const all = tally(answers);

  return {
    sent: answers.length,
    answered: answers.filter((answer) => answer.status === 200).length,
    ...all,
    ...percentiles(answers.map((answer) => answer.ms)),
    over5s: answers.filter((answer) => answer.ms > 5_000).length,
    ...read,
    stored200: answers.length > 0 && answers.every((answer) => answer.status === 200),
  };
}

/**
 * The common frame of #231's series: `count` sessions holding the largest
 * state with `shape`'s rules and a viewer each, the side load, the phases,
 * `load(sessions, addresses, until)` for `LOAD_S` (30) seconds, `SETTLE_S`
 * (5) more for the listener to deliver what is left, and the report.
 */
async function largestStateSeries(name, shape, count, load) {
  const loadMs = Number(process.env.LOAD_S ?? 30) * 1_000;
  const addresses = callAddresses();
  const rulesBody = largestRulesBody(shape);
  const sessions = [];

  for (let index = 0; index < count; index += 1) {
    sessions.push(await largestSession(rulesBody));
  }

  const viewers = sessions.map((session, index) =>
    viewer(session.id, addresses[index % addresses.length]),
  );

  await Promise.all(viewers.map((each) => each.ready));

  const smallSessionId = await createSession();
  const small = smallCaptures(smallSessionId, Number(process.env.SMALL_PER_SECOND ?? 10));

  emit({ phase: 'warm' });
  await sleep(Number(process.env.BASELINE_S ?? 3) * 1_000);
  emit({ phase: 'held' });

  const probes = healthzInChild(250);
  const until = performance.now() + loadMs;
  const loadReport = await load(sessions, addresses, until);

  await sleep(Number(process.env.SETTLE_S ?? 5) * 1_000);

  const healthz = await probes.stop();

  emit({ phase: 'done' });

  const side = await sideLoadReport(small, smallSessionId);
  const viewerReports = await Promise.all(viewers.map((each) => each.stop()));

  return {
    shape: name,
    rules: shape,
    sessions: count,
    callAddresses: addresses.length,
    loadS: loadMs / 1_000,
    rulesBodyBytes: Buffer.byteLength(rulesBody),
    eventBytes: sessions[0].eventBytes,
    ...loadReport,
    small: side,
    healthz,
    viewers: viewersReport(viewerReports, sessions[0].eventBytes),
    bars: {
      capturesStored: side.stored200 && side.stored === side.sent,
      healthzWithin1s: healthz !== null && healthz.over1s === 0,
    },
  };
}

/**
 * `rules-saves` (#231): `SAVERS` (16) savers, each to a session of its own
 * holding the largest state, each sending `PUT .../rules` with `shape`'s
 * body of about 1 MiB again as soon as it is answered - after `Retry-After`
 * when refused `429`, `1017` while the eight places of large bodies are
 * taken (D205 point 8, D246 point 10) - so that the eight stay taken.
 */
function rulesSavesSeries(shape) {
  const savers = Number(process.env.SAVERS ?? 16);

  return largestStateSeries(
    `rules-saves-${shape}`,
    shape,
    savers,
    async (sessions, addresses, until) => {
      const rulesBody = largestRulesBody(shape);
      const answers = [];

      await Promise.all(
        sessions.map(async (session, index) => {
          const forwardedFor = addresses[index % addresses.length].local;

          while (performance.now() < until) {
            const answer = await countedCall(
              `/api/sessions/${session.id}/rules`,
              'PUT',
              rulesBody,
              forwardedFor,
            );

            answers.push(answer);

            const wait =
              answer.status === 429
                ? Math.max(1, answer.retryAfterS) * 1_000
                : answer.status === 0
                  ? 250
                  : 0;

            if (wait > 0) {
              await sleep(Math.max(0, Math.min(wait, until - performance.now())));
            }
          }
        }),
      );

      return { savers, saves: answersTally(answers) };
    },
  );
}

/**
 * `republish-flood` (#231): `SESSIONS` (32) sessions holding the largest
 * state and bodyless `POST .../queue/restart`, which republishes it whole,
 * in bursts of one per session at once, a burst once the last is answered
 * and at most one every `BURST_EVERY_MS` (1,000): so that the listener's
 * reads find many of the largest payloads committed at once and fetch them
 * in its batches of 32. At most 32 calls a second over 8 addresses is 240 a
 * minute an address, within D201's 1200. The batch the listener actually
 * forms is not visible from outside: the burst makes large ones likely, not
 * certain.
 */
function republishFloodSeries(shape) {
  const count = Number(process.env.SESSIONS ?? 32);
  const everyMs = Number(process.env.BURST_EVERY_MS ?? 1_000);

  return largestStateSeries(
    `republish-flood-${shape}`,
    shape,
    count,
    async (sessions, addresses, until) => {
      const answers = [];
      let bursts = 0;

      while (performance.now() < until) {
        const started = performance.now();

        bursts += 1;
        answers.push(
          ...(await Promise.all(
            sessions.map((session, index) =>
              countedCall(
                `/api/sessions/${session.id}/queue/restart`,
                'POST',
                undefined,
                addresses[index % addresses.length].local,
              ),
            ),
          )),
        );
        await sleep(Math.max(0, Math.min(started + everyMs, until) - performance.now()));
      }

      return { bursts, burstEveryMs: everyMs, restarts: answersTally(answers) };
    },
  );
}

/** Runs another measurement script beside this one, its lines passed on and its report taken. */
function wrapped(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`/scripts/${script}`], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines = readline.createInterface({ input: child.stdout });
    // The report may span several lines: everything that is not a phase.
    const reportLines = [];

    lines.on('line', (line) => {
      if (line.startsWith('{"phase"')) {
        console.log(line);
      } else if (line.trim() !== '') {
        reportLines.push(line);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({
          exitCode: code,
          report: reportLines.length === 0 ? null : JSON.parse(reportLines.join('\n')),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * The client's series by the name the orchestrator passes (`SERIES[...].client`):
 * the exact names, then the prefixes, each followed by a shape.
 */
const CLIENT_SERIES = {
  stall: () => stallSeries(),
  ws: () => wsSeries(),
  'edge-burst': () => edgeBurstSeries(),
  'oversize-413': () => oversizeSeries(),
  burst: async () => {
    emit({ phase: 'warm' });
    await sleep(3_000);
    emit({ phase: 'held' });

    return wrapped('measure-capture-bursts.mjs', {
      API_URL: API,
      RECEIVE_HOST: '10.145.1.3',
      RECEIVE_PORT: '3001',
      COUNT: process.env.COUNT ?? '500',
      BODY: process.env.BODY ?? 'binary',
      ADDRESSES: process.env.ADDRESSES ?? '203.0.113.7',
    });
  },
  'limits-load': async () => {
    // D201's load run, which prints no phases of its own.
    emit({ phase: 'warm' });
    await sleep(3_000);
    emit({ phase: 'held' });

    return wrapped('measure-limits-load.mjs', {
      API_URL: API,
      RECEIVE_URL: 'http://10.145.1.3:3001',
    });
  },
  ci: () =>
    wrapped('measure-calls-in-flight.mjs', {
      API_URL: API,
      RECEIVE_URL: 'http://10.145.1.3:3001',
      SERIES: 'ci',
    }),
  'hostile:s7': () => wsHostileSeries(),
  'hostile:s8': () => apiHostileSeries(),
  'create-flood': () => createFloodSeries(),
  'edge-flood': () => edgeFloodSeries(),
  'edge-d201': () => edgeD201Series(),
  'row-lock': () => rowLockSeries(),
  'row-lock-control': () => rowLockControlSeries(),
  'row-lock-refused': () => rowLockRefusedSeries(),
};

/** The prefixes of `CLIENT_SERIES`'s names that carry a shape after them. */
const CLIENT_SERIES_BY_PREFIX = {
  'rules-saves:': (shape) => rulesSavesSeries(shape),
  'republish-flood:': (shape) => republishFloodSeries(shape),
  'abandon:': (shape) => abandonedListSeries(shape),
  'hostile:': (shape) => hostileSeries(shape),
};

/**
 * What runs the client's series `name`, or `undefined` for none: an exact name
 * first, so that `hostile:s7` is not `hostile:` with the shape `s7`.
 */
export function clientSeries(name) {
  if (Object.hasOwn(CLIENT_SERIES, name)) {
    return CLIENT_SERIES[name];
  }

  const prefix = Object.keys(CLIENT_SERIES_BY_PREFIX).find(
    (each) => name.startsWith(each) && name.length > each.length,
  );

  return prefix === undefined
    ? undefined
    : () => CLIENT_SERIES_BY_PREFIX[prefix](name.slice(prefix.length));
}

async function client(series) {
  const run = clientSeries(series);

  if (run === undefined) {
    throw new Error(`no such series: ${series}`);
  }

  const report = await run();

  emit({ phase: 'done' });
  emit({ report });
}

/* ------------------------------------------------------------------------ */
/* The orchestration, on the operator's machine.                            */
/* ------------------------------------------------------------------------ */

const COMPOSE_FILE = fileURLToPath(new URL('measure-connections.compose.yml', import.meta.url));

/**
 * The senders the backend is told of: the client as Traefik sees it on each
 * network, and the address `measure-capture-bursts.mjs` names.
 */
const SENDERS = [
  '203.0.113.7',
  '203.0.113.8',
  '203.0.113.9',
  '203.0.113.10',
  ...Array.from({ length: 8 }, (_, index) => `10.145.${index + 1}.10`),
  '10.145.9.10',
];

/** The four addresses of D210's burst from four addresses, 125 webhooks each (#157). */
const BURST_FOUR_ADDRESSES = '203.0.113.7,203.0.113.8,203.0.113.9,203.0.113.10';

export const SERIES = {
  'stall-plain': { client: 'stall', env: { SHAPE: 'plain' } },
  'stall-heavy': { client: 'stall', env: { SHAPE: 'heavy' } },
  'stall-lines': { client: 'stall', env: { SHAPE: 'lines' } },
  'stall-none': { client: 'stall', env: { SHAPE: 'plain', COUNT: '0' } },
  idle: { client: 'stall', env: { SHAPE: 'idle' } },
  handshake: { client: 'stall', env: { SHAPE: 'handshake' } },
  'ws-16': { client: 'ws', env: { COUNT: '16' } },
  burst: { client: 'burst', env: {} },
  // #157 (D228): 200 at once from one address, and D210's 500
  // from four addresses in turn.
  'burst-200': { client: 'burst', env: { COUNT: '200' } },
  'burst-4': { client: 'burst', env: { ADDRESSES: BURST_FOUR_ADDRESSES } },
  'edge-burst': { client: 'edge-burst', env: {} },
  // #238 (D227 point 4): 20 webhooks through Traefik, each declaring a body
  // over the receive listener's 1 MiB and sending it whole, by 1 byte and at
  // D143's drain bound of 4 MiB; `oversize-413` names both.
  'oversize-413-1mib': { client: 'oversize-413', env: { BODY_BYTES: String(MIB + 1) } },
  'oversize-413-4mib': { client: 'oversize-413', env: { BODY_BYTES: String(4 * MIB) } },
  ci: { client: 'ci', env: {}, backend: { MEASURE_RECEIVE_PROXY_PROTOCOL: 'off' } },
  // D201's load run, which sends its captures without a PROXY header.
  'limits-load': {
    client: 'limits-load',
    env: {},
    backend: { MEASURE_RECEIVE_PROXY_PROTOCOL: 'off' },
  },
  // The hostile series of issue #157 (D228), behind Traefik. `--addresses N`
  // spreads one over the first N attacking addresses; the
  // default is one. S1 and S7 are one-address regression checks; S8 is
  // measured for N too since #183.
  s1: { client: 'hostile:s1', env: {} },
  s2: { client: 'hostile:s2', env: {} },
  s3: { client: 'hostile:s3', env: {} },
  s4: { client: 'hostile:s4', env: {} },
  s5: { client: 'hostile:s5', env: {} },
  s6: { client: 'hostile:s6', env: {} },
  s7: { client: 'hostile:s7', env: {} },
  s8: { client: 'hostile:s8', env: {} },
  s9: { client: 'hostile:s9', env: {} },
  // Two variants of S9 (#182, D238): of each address's 512 connections, the
  // first 4 stall after 16,000 lines as S9's do, filling the address's header
  // lines in flight, and the other 508 each send 256,000 bytes Node's parser
  // keeps nothing of - a head it refuses `431`, or one header line padded
  // with spaces it skips - and stall: what connections held unread cost.
  's9-big': { client: 'hostile:s9', env: { S9_REST: 'big' } },
  's9-padded': { client: 'hostile:s9', env: { S9_REST: 'padded' } },
  // The abandoned list series of issue #141 (D201 point 8's note). Five
  // shapes, `--addresses N` spreading each over the first N attacking
  // addresses; `COUNT` the lists one address fires at once, `SUSTAIN_S` with
  // `RATE_PER_MIN` a sustained minute instead. The orchestrator reads
  // PostgreSQL's active connections and list statements beside the backend's
  // memory (`pgActivity`), and since #213 the probe inside the backend reads
  // its pools' waiting callers and its event loop's delay (`probe`).
  'abandon-get': { client: 'abandon:get', env: {}, pgActivity: true, probe: true },
  'abandon-mid': { client: 'abandon:mid', env: {}, pgActivity: true, probe: true },
  'abandon-query': { client: 'abandon:query', env: {}, pgActivity: true, probe: true },
  'abandon-pipelined': { client: 'abandon:pipelined', env: {}, pgActivity: true, probe: true },
  'abandon-control': { client: 'abandon:control', env: {}, pgActivity: true, probe: true },
  // The flood of #189 (D201's note): one address far over its session
  // creations, the backend alone; `RATE`, `CONNECTIONS` and `FLOOD_S` tune it.
  'create-flood': { client: 'create-flood', env: {} },
  // #205 (D264): the same flood through Traefik with the edge rate limit, as
  // production receives it; in pulses of 7 s with 3 s between, longer than
  // the about 2 s after which Traefik forgets an idle address (its in-memory
  // limiter's expiry, which ignores the burst); and D201's limits
  // used whole at a window's edge, through the edge.
  'edge-flood': { client: 'edge-flood', env: {} },
  'edge-flood-pulsed': { client: 'edge-flood', env: { PULSE_ON_S: '7', PULSE_OFF_S: '3' } },
  'edge-d201': { client: 'edge-d201', env: {} },
  // The two floods with the probe inside the backend, which counts the
  // application listener's connections beside its requests: what a call
  // through Traefik costs the backend against one sent straight.
  'edge-flood-probed': { client: 'edge-flood', env: {}, probe: true },
  'create-flood-probed': { client: 'create-flood', env: {}, probe: true },
  // #231 (D246 point 11, D221 point 9): the largest state saved and
  // republished, each in the two shapes of text, one byte and two bytes a
  // character in V8; `bar` reads D229's bar into the line.
  // Since #244 the probe runs for these too, so `--cpu-prof` can profile them
  // and the pool and event-loop readings join their line; it changes nothing
  // the backend does (`measure-backend-probe.mjs`).
  'rules-saves-escaped': { client: 'rules-saves:escaped', env: {}, bar: true, probe: true },
  'rules-saves-two-byte': { client: 'rules-saves:two-byte', env: {}, bar: true, probe: true },
  'republish-flood-escaped': { client: 'republish-flood:escaped', env: {}, bar: true, probe: true },
  'republish-flood-two-byte': {
    client: 'republish-flood:two-byte',
    env: {},
    bar: true,
    probe: true,
  },
  // Scope 5 of #244 (D244 point 7): the row-lock variant of #243's line stall,
  // its repeatable shape, a private session's `DELETE` refused with the row
  // held, and that stall itself as a control. `CALL_ADDRESSES` (3) spreads the
  // attacking calls over that many addresses; the probe inside the backend
  // reads each pool's longest connection hold, the capture pool's an upper
  // bound of a capture's hold of the session row, and `lockWaits` logs
  // PostgreSQL's lock waits over the first two (`lockWaitsOf`).
  'row-lock': { client: 'row-lock', env: {}, probe: true, lockWaits: true },
  'row-lock-refused': { client: 'row-lock-refused', env: {}, probe: true, lockWaits: true },
  'row-lock-control': { client: 'row-lock-control', env: {}, probe: true },
};

/** Names that stand for several series, each run in turn (#231). */
const GROUPS = {
  'oversize-413': ['oversize-413-1mib', 'oversize-413-4mib'],
  'rules-saves': ['rules-saves-escaped', 'rules-saves-two-byte'],
  'republish-flood': ['republish-flood-escaped', 'republish-flood-two-byte'],
};

/** How often the backend's memory is read, in milliseconds; 0.2 s (#157, D228). */
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 200);

/** The backend image `--image` names instead of building this checkout's. */
let backendImage = null;

/** How many attacking addresses a hostile series spreads over; `--addresses N` (#157). */
let addressCount = 1;

/**
 * `docker compose` on the measurement's project; rejects on a non-zero exit.
 * `maxBuffer` bounds what it may print, 64 MiB unless the call says more.
 */
function compose(args, { env = {}, timeoutMs = 600_000, maxBuffer = 64 * MIB } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['compose', '-f', COMPOSE_FILE, ...args],
      {
        env: {
          ...process.env,
          ...(backendImage === null ? {} : { MEASURE_BACKEND_IMAGE: backendImage }),
          ...env,
        },
        timeout: timeoutMs,
        maxBuffer,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`docker compose ${args.join(' ')}: ${error.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * The backend's memory, read from inside its container, in bytes: the
 * process's `VmRSS`, `VmHWM` and `RssAnon` - its own memory, which `VmRSS`
 * adds the file pages of its binary to, which the kernel may drop and read
 * again at any time - and its cgroup's `memory.current`,
 * `memory.peak` and, of `memory.stat`, `anon` (the process's own memory),
 * `file` (page cache), `kernel` (socket structures and other kernel memory)
 * and `sock` (socket buffers). The reading itself runs in the container, so
 * `file` and `kernel` carry a little of it. Beside them, of the cgroup's
 * `cpu.stat`, the CPU time it has used and been throttled for, in
 * microseconds, read at `t` (#189).
 */
async function memory() {
  const text = await compose([
    'exec',
    '-T',
    'backend',
    'sh',
    '-c',
    'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak; ' +
      'grep -E "^(VmRSS|VmHWM|RssAnon):" /proc/1/status; ' +
      'grep -E "^(anon|file|kernel|sock) " /sys/fs/cgroup/memory.stat; ' +
      'grep -E "^(usage_usec|throttled_usec) " /sys/fs/cgroup/cpu.stat',
  ]);
  const t = performance.now();
  const lines = text.trim().split('\n');
  const kb = (name) =>
    Number(/(\d+) kB/.exec(lines.find((line) => line.startsWith(name)) ?? '')?.[1]) * 1024;
  const stat = (name) => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(text)?.[1] ?? 0);

  const reading = {
    current: Number(lines[0]),
    peak: Number(lines[1]),
    rss: kb('VmRSS'),
    hwm: kb('VmHWM'),
    rssAnon: kb('RssAnon'),
    anon: stat('anon'),
    file: stat('file'),
    kernel: stat('kernel'),
    sock: stat('sock'),
    t,
    usageUsec: stat('usage_usec'),
    throttledUsec: stat('throttled_usec'),
  };

  // What the backend itself holds at this moment: its process's own memory,
  // and the kernel's for its sockets and their buffers, both charged to its
  // 512 MiB. The cgroup's `memory.current` carries the reading's own
  // processes besides, some 15 MiB while one runs.
  return { ...reading, own: reading.rssAnon + reading.kernel + reading.sock };
}

/** How often Traefik's memory is read, in milliseconds; 1 s, its peak kept by the kernel (#217). */
const TRAEFIK_SAMPLE_MS = Number(process.env.TRAEFIK_SAMPLE_MS ?? 1_000);

/**
 * Traefik's memory, read from inside its container, in bytes (#217): its
 * cgroup's `memory.current` and `memory.peak` and, of `memory.stat`, `anon`,
 * `kernel` and `sock`; and since #205 its `cpu.stat` `usage_usec`, timed. The bytes a backend leaves unread wait in Traefik's
 * sockets and buffers instead, which production does not limit (D228 point
 * 5), so the measurement reads them beside the backend's. Its container
 * lives from `up` to `down`, not a series, so its `memory.peak` is the
 * highest since `up`: a series' own when it is the first, or when it reads
 * higher than at the series' start (`peakBeforeMiB`).
 */
async function traefikMemory() {
  const text = await compose([
    'exec',
    '-T',
    'traefik',
    'sh',
    '-c',
    'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak; ' +
      'grep -E "^(anon|kernel|sock) " /sys/fs/cgroup/memory.stat; ' +
      'grep -E "^usage_usec " /sys/fs/cgroup/cpu.stat',
  ]);
  const t = performance.now();
  const lines = text.trim().split('\n');
  const stat = (name) => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(text)?.[1] ?? 0);

  return {
    current: Number(lines[0]),
    peak: Number(lines[1]),
    anon: stat('anon'),
    kernel: stat('kernel'),
    sock: stat('sock'),
    // Its CPU time, so that a series reads what Traefik spent (#205).
    t,
    usageUsec: stat('usage_usec'),
  };
}

/** The backend container's `net.ipv4.tcp_rmem`, as the kernel has it, so each line says which it ran with (#217). */
async function backendTcpRmem() {
  try {
    const text = await compose(['exec', '-T', 'backend', 'cat', '/proc/sys/net/ipv4/tcp_rmem']);

    return text.trim().split(/\s+/).join(' ');
  } catch (error) {
    return `unread: ${String(error?.message ?? error).slice(0, 200)}`;
  }
}

/**
 * The least wait PostgreSQL logs while a series asks for its lock waits
 * (`lockWaits`, #244): `deadlock_timeout`, after which a waiting process
 * checks for a deadlock and, with `log_lock_waits`, logs that it still waits
 * and, once it has the lock, how long it waited. 1 ms, its least, so that
 * nearly every wait is seen; the check it adds to each wait is PostgreSQL's
 * own, cheap beside its core.
 */
const LOCK_WAIT_LOGGED_MS = 1;

/** The marker PostgreSQL's log carries at each end of a series' lock waits. */
const LOCK_WAIT_MARK = 'qa-measure lock waits';

/** Each of `statements` in `psql` in the PostgreSQL container, one `-c` each. */
function psql(statements) {
  return compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'webhook_inspector',
    '-d',
    'webhook_inspector',
    '-v',
    'ON_ERROR_STOP=1',
    '-tA',
    ...statements.flatMap((statement) => ['-c', statement]),
  ]);
}

/**
 * A statement for `psql` that logs `mark` and then, a line each, every
 * connection to `webhook_inspector` with its process and `application_name`, so that
 * a wait's holder - a process that logs nothing of its own - is named by its
 * pool (`summarizeLockWaits`).
 */
function markAndConnections(mark) {
  return (
    `DO $$DECLARE r record; BEGIN RAISE LOG '${mark}'; ` +
    "FOR r IN SELECT pid, application_name FROM pg_stat_activity WHERE datname = 'webhook_inspector' " +
    "LOOP RAISE LOG 'qa-measure connection % app=%', r.pid, r.application_name; END LOOP; END$$"
  );
}

/**
 * The settings `startLockWaits` changes for a series' log of lock waits, by
 * name and value, and the ones `lockWaitsOf` resets, one list for both so
 * that none is set and left: `log_lock_waits` on, `deadlock_timeout` at
 * `LOCK_WAIT_LOGGED_MS`, each line prefixed with its time, process and
 * connection's `application_name` (`LOG_LINE`), and each new connection
 * logged with its `application_name`.
 */
const LOCK_WAIT_SETTINGS = [
  ['log_lock_waits', 'on'],
  ['deadlock_timeout', `'${LOCK_WAIT_LOGGED_MS}ms'`],
  ['log_line_prefix', "'%m [%p] app=%a '"],
  ['log_connections', 'on'],
];

/** PostgreSQL's log since its container started, as `docker compose logs` prints it. */
function postgresLog() {
  return compose(['logs', '--no-color', '--no-log-prefix', 'postgres'], { maxBuffer: 512 * MIB });
}

/**
 * Starts PostgreSQL's log of lock waits for a series whose `SERIES` entry
 * asks for it (`lockWaits`, #244): `LOCK_WAIT_SETTINGS` - each line prefixed
 * with its process and its connection's `application_name`,
 * `webhook-inspector-capture` or `webhook-inspector-api` (D244, D278) - then a marker line naming
 * `token` and the connections open. Reloaded, not restarted; `lockWaitsOf`
 * puts every setting back. `run` sends a call's statements, `psql` unless a
 * test gives another.
 */
export async function startLockWaits(token, { run = psql, settleMs = 500 } = {}) {
  await run([
    ...LOCK_WAIT_SETTINGS.map(([name, value]) => `ALTER SYSTEM SET ${name} = ${value}`),
    'SELECT pg_reload_conf()',
  ]);
  // Every connection rereads its settings before its next statement; the
  // series' own setup and its 3 s of baseline come before the attack.
  await sleep(settleMs);
  await run([markAndConnections(`${LOCK_WAIT_MARK} from ${token}`)]);
}

/**
 * Ends the log `startLockWaits` began - the connections open and a marker
 * line, then every setting reset and the configuration reloaded - and reads
 * PostgreSQL's log between the two markers (`summarizeLockWaits`). The resets
 * are a call of their own, sent whether or not the markers' failed (#272):
 * `ON_ERROR_STOP` ends a call at its first failing statement, and in one call
 * with the markers a failed marker left `deadlock_timeout` at 1 ms and the
 * verbose log on for the run's later series. A failed marker or log read is
 * reported, not thrown, as the memory reading's is; a failed reset is thrown,
 * so that the run ends - taken down unless `--keep` - rather than measure its
 * later series under these settings. `run` and `readLog` are `psql` and
 * `postgresLog` unless a test gives others.
 */
export async function lockWaitsOf(token, { run = psql, readLog = postgresLog } = {}) {
  let marked = null;

  try {
    await run([
      markAndConnections('qa-measure connections at the end'),
      `DO $$BEGIN RAISE LOG '${LOCK_WAIT_MARK} to ${token}'; END$$`,
    ]);
  } catch (error) {
    marked = error;
  }

  try {
    await run([
      ...LOCK_WAIT_SETTINGS.map(([name]) => `ALTER SYSTEM RESET ${name}`),
      'SELECT pg_reload_conf()',
    ]);
  } catch (error) {
    throw new Error(
      `PostgreSQL's lock-wait settings were not reset, deadlock_timeout left at ` +
        `${LOCK_WAIT_LOGGED_MS} ms: ${String(error?.message ?? error).slice(0, 300)}`,
      { cause: error },
    );
  }

  if (marked !== null) {
    return { read: false, error: String(marked?.message ?? marked).slice(0, 300) };
  }

  try {
    return summarizeLockWaits(await readLog(), token);
  } catch (error) {
    return { read: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

/**
 * A line of PostgreSQL's log under `startLockWaits`' prefix, `%m [%p] app=%a `,
 * read from its first character: its time to the millisecond and its zone,
 * then its process, application, level and message. Anchored at the line's
 * start (#272), so that a line PostgreSQL continues - the next line of a
 * message or a statement, which it begins with a tab - is never read as one
 * of its own, whatever prefix its text carries.
 */
const LOG_LINE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [\w+-]{1,10} \[(\d{1,10})\] app=(\S{0,64}) ([A-Z]{1,10}):\s{1,4}(.*)$/s;
/** A lock wait's message: still waiting or acquired, the lock's kind, and after how long. */
const LOCK_WAIT_LINE =
  /^process \d{1,10} (still waiting for|acquired) \w{1,40} on (\w{1,20})\b.{0,200}? after (\d{1,12}(?:\.\d{1,6})?) ms/s;
/** The relation a lock wait's `CONTEXT` names, as `while locking tuple (0,5) in relation "sessions"`. */
const WAIT_RELATION = / relation "([^"]{1,64})"/;
/** A wait's `DETAIL`: the process holding the lock, the first of several. */
const WAIT_HOLDER = /^Process(?:es)? holding the lock: (\d{1,10})[.,]/;
/** A connection named with its application: the marker's listing, or `log_connections`'. */
const CONNECTION_APP =
  /^(?:qa-measure connection (\d{1,10}) app=|connection authorized: .{0,200}?application_name=)(\S{0,64})/s;
/** Longer than any line `startLockWaits`' log writes for a wait; such a line is not parsed. */
const MAX_LOG_LINE = 64 * 1024;

/**
 * PostgreSQL's lock waits between the two markers naming `token` in `text`,
 * its log (#244): each wait PostgreSQL logged - one of `LOCK_WAIT_LOGGED_MS`
 * or more - grouped by the waiting connection's application, the first line
 * of its statement (cut at 80 characters), the lock's kind - `transaction`,
 * waiting for the transaction holding the row to end, or `tuple`, queued
 * behind another waiter for the same row - the application of the process
 * holding it (`unknown` when no line names that process's) and the relation
 * its `CONTEXT` names, with how many and their p50 / p99 / max ms. A wait
 * logged as still waiting and never as acquired is `unfinished`; `deadlocks`
 * counts `deadlock detected`. `read` is false when the first marker is
 * missing. Lines longer than `MAX_LOG_LINE` are skipped and every pattern is
 * bounded, so a long or hostile line costs its length at most.
 */
export function summarizeLockWaits(text, token) {
  const lines = String(text).split('\n');
  const fromMark = `${LOCK_WAIT_MARK} from ${token}`;
  const toMark = `${LOCK_WAIT_MARK} to ${token}`;
  const start = lines.findIndex((line) => line.length <= MAX_LOG_LINE && line.endsWith(fromMark));

  if (start === -1) {
    return { read: false, error: 'no marker' };
  }

  const waits = [];
  // Each process's application, from any line of its own or naming it.
  const apps = new Map();
  // The wait each process logged last, until its `DETAIL`, `CONTEXT` and
  // `STATEMENT` lines - which follow the message - have been read, and the
  // one it still waits in, whose holder its acquisition keeps.
  const latest = new Map();
  const pending = new Map();
  let deadlocks = 0;
  let skipped = 0;
  let ended = false;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.length > MAX_LOG_LINE) {
      skipped += 1;
      continue;
    }

    if (line.endsWith(toMark)) {
      ended = true;
      break;
    }

    const parsed = LOG_LINE.exec(line);

    if (parsed === null) {
      continue;
    }

    const [, pid, app, level, message] = parsed;

    if (app !== '') {
      apps.set(pid, app);
    }

    if (level === 'LOG') {
      const named = CONNECTION_APP.exec(message);

      if (named !== null && named[2] !== '') {
        apps.set(named[1] ?? pid, named[2]);
      }

      const wait = LOCK_WAIT_LINE.exec(message);

      if (wait === null) {
        latest.delete(pid);
        continue;
      }

      const event = {
        app,
        statement: null,
        lock: wait[2],
        holder: wait[1] === 'acquired' ? (pending.get(pid)?.holder ?? null) : null,
        relation: null,
        ms: Number(wait[3]),
      };

      latest.set(pid, event);

      if (wait[1] === 'acquired') {
        pending.delete(pid);
        waits.push(event);
      } else {
        pending.set(pid, event);
      }
    } else if (level === 'ERROR') {
      latest.delete(pid);

      if (message.startsWith('deadlock detected')) {
        deadlocks += 1;
      }
    } else {
      const event = latest.get(pid);

      if (event === undefined) {
        continue;
      }

      if (level === 'STATEMENT' && event.statement === null) {
        event.statement = message.split('\n')[0].trim().slice(0, 80);
      } else if (level === 'CONTEXT' && event.relation === null) {
        event.relation = WAIT_RELATION.exec(message.slice(0, 1024))?.[1] ?? null;
      } else if (level === 'DETAIL' && event.holder === null) {
        event.holder = WAIT_HOLDER.exec(message)?.[1] ?? null;
      }
    }
  }

  const groups = new Map();

  for (const wait of waits) {
    const heldBy = wait.holder === null ? null : (apps.get(wait.holder) ?? 'unknown');
    const key = JSON.stringify([wait.app, wait.statement, wait.lock, heldBy, wait.relation]);
    const group = groups.get(key) ?? {
      app: wait.app,
      statement: wait.statement,
      lock: wait.lock,
      heldBy,
      relation: wait.relation,
      ms: [],
    };

    group.ms.push(wait.ms);
    groups.set(key, group);
  }

  return {
    read: true,
    ended,
    loggedFromMs: LOCK_WAIT_LOGGED_MS,
    waits: waits.length,
    unfinished: pending.size,
    deadlocks,
    ...(skipped === 0 ? {} : { skippedLines: skipped }),
    by: [...groups.values()]
      .map(({ ms, ...group }) => ({ ...group, ...summarizePercentiles(ms) }))
      .sort((a, b) => b.count - a.count || b.maxMs - a.maxMs),
  };
}

/**
 * What PostgreSQL holds at this moment, from `pg_stat_activity` in its own
 * container (#141): the connections open to `webhook_inspector`, how many are running a
 * statement, and how many of those are running a list statement (the
 * `LEFT JOIN LATERAL` a list and a query share, `repository.listRequests`).
 * The sampler's own backend is left out by its pid. A failure is reported, not
 * thrown, as the memory reading's is.
 */
async function pgActivity() {
  const sql =
    "SELECT count(*) FILTER (WHERE state = 'active'), count(*), " +
    "count(*) FILTER (WHERE state = 'active' AND query LIKE '%LEFT JOIN LATERAL%') " +
    "FROM pg_stat_activity WHERE datname = 'webhook_inspector' AND pid <> pg_backend_pid()";
  // And the CPU time PostgreSQL's cgroup has used, in microseconds, for its
  // cores of its 1 (#213).
  const text = await compose([
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    `psql -U webhook_inspector -d webhook_inspector -tAF, -c "${sql}"; ` +
      'grep -E "^usage_usec " /sys/fs/cgroup/cpu.stat',
  ]);
  const [first, usage] = text.trim().split('\n');
  const [active, total, lists] = first.split(',').map(Number);

  return {
    t: performance.now(),
    active,
    total,
    lists,
    usageUsec: Number(/usage_usec (\d+)/.exec(usage ?? '')?.[1] ?? Number.NaN),
  };
}

/**
 * The backend container's state once a series has ended, from
 * `docker compose ps`: `running`, or `exited` with its exit code - 133 when
 * V8 ran out of heap (its fatal error ends the process with `SIGTRAP`), 137
 * when the kernel's OOM killer or anything else sent `SIGKILL` - so that a
 * backend that died is reported in the series' line (#157). Compose prints
 * one JSON object a line, or an array in older versions; a failure to read
 * it is reported, not thrown.
 */
async function backendState() {
  let text;

  try {
    text = (await compose(['ps', '-a', '--format', 'json', 'backend'])).trim();
  } catch (error) {
    return { read: false, error: String(error?.message ?? error).slice(0, 300) };
  }

  try {
    const entries = text.startsWith('[')
      ? JSON.parse(text)
      : text
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
    const entry = entries[0];

    if (entry === undefined) {
      return { read: false, error: 'no backend container' };
    }

    const exitCode = Number(entry.ExitCode ?? 0);
    const running = entry.State === 'running';

    return {
      read: true,
      state: entry.State,
      exitCode: running ? null : exitCode,
      outOfMemory: !running && (exitCode === 133 || exitCode === 137),
    };
  } catch (error) {
    return { read: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

const mib = (bytes) => Math.round((bytes / MIB) * 10) / 10;

/** What a series with `probe` starts the backend with: the probe, before the backend (#213). */
const PROBE_NODE_OPTIONS = '--import /probe/measure-backend-probe.mjs';

/**
 * The probe's lines (`measure-backend-probe.mjs`), read from the backend's
 * container once the series is done, summed up over two stretches of wall
 * time: `baseline`, from the series' warm-up to its first attacking call,
 * and `series`, from then to its end. For each, the event loop's largest
 * 99th percentile of a 250 ms window and its largest delay, and each pool's
 * most callers waiting for a connection and most connections open. `null`
 * when the lines could not be read - the backend gone.
 */
async function probeSummary(stretches, name) {
  let text;

  try {
    text = await compose(['exec', '-T', 'backend', 'cat', '/tmp/qa-probe.jsonl'], {
      maxBuffer: 64 * MIB,
    });
  } catch (error) {
    return { read: false, error: String(error?.message ?? error).slice(0, 300) };
  }

  // The probe's lines themselves, for a look at the series over time, when
  // `PROBE_LINES_DIR` names a directory: one file a series, with the
  // series' moments on the wall clock first.
  if (process.env.PROBE_LINES_DIR !== undefined) {
    writeFileSync(
      `${process.env.PROBE_LINES_DIR}/${name}-${Date.now()}.jsonl`,
      `${JSON.stringify({ stretches })}\n${text}`,
    );
  }

  const lines = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const summed = (from, to) => {
    const window = lines.filter((line) => line.t >= from && line.t <= to);
    const pools = {};

    for (const line of window) {
      for (const [pool, reading] of Object.entries(line.pools)) {
        const kept = (pools[pool] ??= {
          maxWaiting: 0,
          maxTotal: 0,
          acquireMaxMs: 0,
          holdMaxMs: 0,
          holdP99Ms: 0,
        });

        kept.maxWaiting = Math.max(kept.maxWaiting, reading.maxWaiting);
        kept.maxTotal = Math.max(kept.maxTotal, reading.maxTotal);
        // A checkout's wait for its connection and its hold of it, where
        // the probe reads them: a checkout without a callback, a capture's.
        kept.acquireMaxMs = Math.max(kept.acquireMaxMs, reading.acquireMs?.max ?? 0);
        kept.holdMaxMs = Math.max(kept.holdMaxMs, reading.holdMs?.max ?? 0);
        kept.holdP99Ms = Math.max(kept.holdP99Ms, reading.holdMs?.p99 ?? 0);
      }
    }

    // Each listener's requests and the largest of its windows' timings:
    // accept to the request's head, and the head to the response's close.
    const listeners = {};

    for (const line of window) {
      for (const [listener, reading] of Object.entries(line.listeners ?? {})) {
        const kept = (listeners[listener] ??= {
          connections: 0,
          requests: 0,
          toRequestMaxMs: 0,
          toRequestP99Ms: 0,
          toCloseMaxMs: 0,
          toCloseP99Ms: 0,
        });

        kept.connections += reading.connections ?? 0;
        kept.requests += reading.requests;
        kept.toRequestMaxMs = Math.max(kept.toRequestMaxMs, reading.toRequestMs?.max ?? 0);
        kept.toRequestP99Ms = Math.max(kept.toRequestP99Ms, reading.toRequestMs?.p99 ?? 0);
        kept.toCloseMaxMs = Math.max(kept.toCloseMaxMs, reading.toCloseMs?.max ?? 0);
        kept.toCloseP99Ms = Math.max(kept.toCloseP99Ms, reading.toCloseMs?.p99 ?? 0);
      }
    }

    return {
      lines: window.length,
      eventLoopDelayMs: {
        p99: Math.max(0, ...window.map((line) => line.eventLoopDelayMs.p99)),
        max: Math.max(0, ...window.map((line) => line.eventLoopDelayMs.max)),
      },
      pools,
      listeners,
    };
  };

  return {
    read: true,
    baseline: summed(stretches.warm, stretches.held),
    series: summed(stretches.held, stretches.done),
  };
}

/**
 * The cores `readings` - each a `t` in ms and a cgroup's `usageUsec` - show
 * used on average from the first to the last, and over the busiest stretch
 * of at least 5 s between two of them; `null` with fewer than two (#213).
 */
function busiestCores(readings) {
  if (readings.length < 2 || readings.at(-1).t <= readings[0].t) {
    return null;
  }

  const cores = (from, to) => (to.usageUsec - from.usageUsec) / 1_000 / (to.t - from.t);
  let busiest = null;

  for (let from = 0, to = 0; from < readings.length; from += 1) {
    while (to < readings.length && readings[to].t - readings[from].t < 5_000) {
      to += 1;
    }

    if (to === readings.length) {
      break;
    }

    busiest = Math.max(busiest ?? 0, cores(readings[from], readings[to]));
  }

  const round2 = (value) => Math.round(value * 100) / 100;

  return {
    averageCores: round2(cores(readings[0], readings.at(-1))),
    busiest5sCores: busiest === null ? null : round2(busiest),
  };
}

async function runSeries(name) {
  const series = SERIES[name];

  // A backend container of its own for every series, as D210 and D213 had.
  await compose(['up', '-d', '--force-recreate', '--no-deps', '--wait', 'backend'], {
    env: {
      ...(series.probe
        ? {
            // `CPU_PROFILE_DIR` adds V8's CPU profile of the backend's
            // process, written as it ends and copied out after the series.
            MEASURE_NODE_OPTIONS:
              process.env.CPU_PROFILE_DIR === undefined
                ? PROBE_NODE_OPTIONS
                : `${PROBE_NODE_OPTIONS} --cpu-prof --cpu-prof-dir=/tmp/qa-prof`,
          }
        : {}),
      ...series.backend,
    },
  });

  const restartsBefore = (
    await compose(['ps', '--format', '{{.Name}} {{.Status}}', 'backend'])
  ).trim();
  const tcpRmem = await backendTcpRmem();
  // Traefik's memory, read as the backend's is but every `TRAEFIK_SAMPLE_MS`
  // (#217); a failed reading counted, not thrown, as the backend's is.
  const traefikSamples = [];
  const traefikFailures = [];
  const tryTraefik = async () => {
    try {
      return await traefikMemory();
    } catch (error) {
      traefikFailures.push(String(error?.message ?? error).slice(0, 300));

      return null;
    }
  };
  const traefikBefore = await tryTraefik();
  let traefikBaseline = null;
  let traefikSampler = Promise.resolve();
  const args = ['exec', '-T'];
  // Tuning the orchestrator was given on its own command line, forwarded to
  // the client in the container, where `docker compose exec` sets only what
  // `-e` names: so `COUNT=64 node scripts/measure-connections.mjs abandon-get`
  // runs that count, and the series' growing counts and sustained minute are
  // driven from the command line rather than by editing the series (#141). A
  // series' own `env` wins over a forwarded value.
  const forwarded = {};

  for (const key of [
    'COUNT',
    'SUSTAIN_S',
    'RATE_PER_MIN',
    'FILL',
    'PATH_BYTES',
    'HOLD_S',
    'BASELINE_S',
    'SMALL_PER_SECOND',
    'DELAY_MS',
    'UNREAD',
    'WAITS',
    'RATE',
    'CONNECTIONS',
    'FLOOD_S',
    'PULSE_ON_S',
    'PULSE_OFF_S',
    'LEAD_S',
    'SAVERS',
    'SESSIONS',
    'LOAD_S',
    'SETTLE_S',
    'BURST_EVERY_MS',
    'CALL_ADDRESSES',
    'TIMEOUT_S',
    'API_PER_SECOND',
    'API_PROBE_TIMEOUT_MS',
    'CAPTURE_PER_SECOND',
    'SESSION_DELETE_EVERY',
    'THROWAWAY_CAPTURES',
    'CHANGES',
    'CHANGE_INTERVAL_MS',
  ]) {
    if (process.env[key] !== undefined) {
      forwarded[key] = process.env[key];
    }
  }

  const env = {
    ...forwarded,
    ...series.env,
    ...(series.client.startsWith('hostile:') || series.client.startsWith('abandon:')
      ? { ADDR_COUNT: String(addressCount) }
      : {}),
  };

  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }

  args.push('client', 'node', '/scripts/measure-connections.mjs', 'client', series.client);

  // Traefik's log from here on, read once the series is done (#205).
  const traefikLogSince = new Date().toISOString();

  // PostgreSQL's lock waits over the series, for those that ask (#244).
  const lockToken = `${name}-${Date.now()}`;

  if (series.lockWaits) {
    await startLockWaits(lockToken);
  }

  const child = spawn('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    env: {
      ...process.env,
      ...(backendImage === null ? {} : { MEASURE_BACKEND_IMAGE: backendImage }),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const samples = [];
  // PostgreSQL's activity, sampled beside the memory for the abandoned-list
  // series (#141): what the abandoned statements hold in the database.
  const pgSamples = [];
  const pgFailures = [];
  let heldAt = null;
  // The same moments on the wall clock, which the probe's lines carry (#213).
  const wall = { warm: null, held: null, done: null };
  let baseline = null;
  let sampling = false;
  let report = null;
  let sampler = Promise.resolve();
  let pgSampler = Promise.resolve();
  // A reading that failed - a `docker exec` refused once the backend has
  // died, or timed out under the load - is counted, not thrown: an
  // unhandled rejection here ended the whole run before its line was
  // printed or the project taken down (#157).
  const sampleFailures = [];
  const tryMemory = async () => {
    try {
      return await memory();
    } catch (error) {
      sampleFailures.push(String(error?.message ?? error).slice(0, 300));

      return null;
    }
  };

  const sample = async () => {
    while (sampling) {
      const reading = await tryMemory();

      if (reading !== null) {
        samples.push(reading);
      }

      await sleep(SAMPLE_MS);
    }
  };

  const samplePg = async () => {
    while (sampling) {
      try {
        pgSamples.push(await pgActivity());
      } catch (error) {
        pgFailures.push(String(error?.message ?? error).slice(0, 200));
      }

      await sleep(SAMPLE_MS);
    }
  };

  const sampleTraefik = async () => {
    while (sampling) {
      const reading = await tryTraefik();

      if (reading !== null) {
        traefikSamples.push(reading);
      }

      await sleep(TRAEFIK_SAMPLE_MS);
    }
  };

  for await (const line of lines) {
    let parsed;

    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.phase === 'warm' && baseline === null) {
      wall.warm = Date.now();
      [baseline, traefikBaseline] = await Promise.all([tryMemory(), tryTraefik()]);
      sampling = true;
      sampler = sample();
      traefikSampler = sampleTraefik();

      if (series.pgActivity) {
        pgSampler = samplePg();
      }
    } else if (parsed.phase === 'held') {
      heldAt = performance.now();
      wall.held = Date.now();
    } else if (parsed.phase === 'done') {
      wall.done = Date.now();
      sampling = false;
    } else if (parsed.report !== undefined) {
      report = parsed.report;
    }
  }

  sampling = false;
  await Promise.all([sampler, pgSampler, traefikSampler]);

  const lockWaits = series.lockWaits ? await lockWaitsOf(lockToken) : undefined;

  const final = (await tryMemory()) ?? samples.at(-1) ?? baseline;
  const traefikFinal = (await tryTraefik()) ?? traefikSamples.at(-1) ?? traefikBaseline;
  const probe =
    series.probe && wall.warm !== null && wall.held !== null
      ? await probeSummary({ ...wall, done: wall.done ?? Date.now() }, name)
      : undefined;
  const state = await backendState();
  const status = (
    await compose(['ps', '-a', '--format', '{{.Name}} {{.Status}}', 'backend'])
  ).trim();
  // A flood before #189 logged two lines a refusal, some 50 MiB in two
  // minutes at 1,000 a second.
  const logs = await compose(['logs', '--no-color', 'backend'], { maxBuffer: 512 * MIB });
  const logLines = logs.split('\n');

  // `LOGS_DIR` keeps the backend's log of each series, a file a series (#262).
  if (process.env.LOGS_DIR !== undefined) {
    writeFileSync(`${process.env.LOGS_DIR}/${name}-${Date.now()}.log`, logs);
  }

  // Traefik's log over the series, at the level production runs, INFO
  // (#205): a line for each call its edge rate limit refuses
  // would be thousands here. Read, not thrown, when it fails.
  let traefikLog;

  try {
    const lines = (
      await compose(['logs', '--no-color', '--since', traefikLogSince, 'traefik'], {
        maxBuffer: 256 * MIB,
      })
    )
      .split('\n')
      .filter((line) => line.trim() !== '');

    // Beside them, every line since Traefik started - its start-up lines at
    // least - so that a series' count of none is not a reading that misses
    // them all.
    const sinceUp = (await compose(['logs', '--no-color', 'traefik'], { maxBuffer: 256 * MIB }))
      .split('\n')
      .filter((line) => line.trim() !== '');

    traefikLog = {
      lines: lines.length,
      sample: lines.slice(0, 5).map((line) => line.slice(0, 300)),
      linesSinceUp: sinceUp.length,
      // Its warnings and errors since it started, a configuration it could
      // not load among them.
      warningsSinceUp: sinceUp
        .filter((line) => /\b(WRN|ERR|FTL|level=(warn|error|fatal))\b/i.test(line))
        .slice(0, 5)
        .map((line) => line.slice(0, 300)),
    };
  } catch (error) {
    traefikLog = { error: String(error?.message ?? error).slice(0, 300) };
  }
  // Fastify's two lines of the request log (#189).
  const requestLogLines = logLines.filter((line) =>
    /"msg":"(incoming request|request completed)"/.test(line),
  ).length;
  const errorLogLines = logLines.filter((line) => /"level":(50|60)/.test(line));
  const errorLines = errorLogLines.length;
  // The client's two addresses, which the PROXY headers carry as the
  // senders: no backend line may name one because of a limit (D227). A
  // request line's `remoteAddress` is the peer the backend talks to (D117):
  // Traefik, or the client itself where a series calls the backend straight,
  // as its setup calls and `burst` do, so that field is left out.
  const senderLines = logLines
    .map((line) => line.replace(/"remoteAddress":"[^"]*"/g, ''))
    .filter((line) => SENDERS.some((address) => line.includes(address)));
  const refusalLines = logLines.filter((line) => line.includes('every connection place taken'));
  const refusedLogged = refusalLines.reduce(
    (sum, line) => sum + Number(/"refused":(\d+)/.exec(line)?.[1] ?? 0),
    0,
  );
  // The connections the PROXY layer closed because their header had not come
  // within its 5 s (#262), by the peer that sent them: Traefik for the
  // attack's, the client itself for the small captures and the series it
  // sends straight. A small capture lost so never reached capture.
  const proxyTimeouts = {};

  for (const line of logLines) {
    if (line.includes('no complete header within')) {
      const peer = /"peer":"([^"]*)"/.exec(line)?.[1] ?? 'unknown';

      proxyTimeouts[peer] = (proxyTimeouts[peer] ?? 0) + 1;
    }
  }
  // The largest reading of `field`, final one included, leaving out a part a
  // reading could not parse - `/proc/1/status` gone while the container was
  // dying - so that a backend killed by a series still reports its peaks.
  const top = (field) =>
    Math.max(...[...samples, final].map((each) => each[field]).filter(Number.isFinite));

  // PostgreSQL's activity over the run (#141): the most connections open and
  // running at once, the most list statements running at once, and how long
  // after the burst began the last list statement was still active - how long
  // an abandoned statement held the database. Each reading is a `docker
  // compose exec` of `psql` followed by a pause of `SAMPLE_MS`, so readings
  // come further apart than `SAMPLE_MS`: `meanIntervalMs` is their real mean
  // spacing, the resolution of everything here (#141). The last
  // list statement ended between `settleMs` and `settledByMs`, the next
  // reading, which saw none. `settleMs` is null when no reading saw one - a
  // statement shorter than the spacing can fall between two readings - and
  // `censored` is true when the series' last reading still saw one, so that
  // `settleMs` is a lower bound and `settledByMs` null.
  const listActiveAt = pgSamples.findLastIndex((each) => each.lists > 0);
  const censored = listActiveAt !== -1 && listActiveAt === pgSamples.length - 1;
  const sinceHeld = (sample) =>
    sample === undefined || heldAt === null ? null : Math.round(sample.t - heldAt);
  const pg =
    series.pgActivity && pgSamples.length > 0
      ? {
          samples: pgSamples.length,
          meanIntervalMs:
            pgSamples.length > 1
              ? Math.round((pgSamples.at(-1).t - pgSamples[0].t) / (pgSamples.length - 1))
              : null,
          sampledUntilMs: sinceHeld(pgSamples.at(-1)),
          failures: pgFailures.length,
          firstFailure: pgFailures[0] ?? null,
          maxActive: Math.max(...pgSamples.map((each) => each.active)),
          maxTotal: Math.max(...pgSamples.map((each) => each.total)),
          maxListsActive: Math.max(...pgSamples.map((each) => each.lists)),
          // Its CPU over the samples and in its busiest 5 s, in cores of its 1 (#213).
          cpu: busiestCores(pgSamples.filter((each) => Number.isFinite(each.usageUsec))),
          settleMs: listActiveAt === -1 ? null : sinceHeld(pgSamples[listActiveAt]),
          settledByMs:
            listActiveAt === -1 || censored ? null : sinceHeld(pgSamples[listActiveAt + 1]),
          censored,
        }
      : undefined;

  // The backend's CPU (#189): its average from the baseline's reading to the
  // last, and the busiest stretch of at least 5 s between two readings, in
  // cores of its 0.5, with the time the cgroup throttled it.
  const cores = (from, to) => (to.usageUsec - from.usageUsec) / 1_000 / (to.t - from.t);
  const readings = baseline === null ? [] : [baseline, ...samples, ...(final ? [final] : [])];
  let busiest = null;

  for (let from = 0, to = 0; from < readings.length; from += 1) {
    while (to < readings.length && readings[to].t - readings[from].t < 5_000) {
      to += 1;
    }

    if (to === readings.length) {
      break;
    }

    busiest = Math.max(busiest ?? 0, cores(readings[from], readings[to]));
  }

  // D229's bar, for the series that ask for it (#231): the backend neither
  // killed nor restarted, no `error` line, `memory.peak` at or under 400 MiB
  // - the end's reading, or the largest sampled when the end's is lost - and
  // every small capture stored, which the client reports. `final` is the last
  // sample, or the baseline, when the end's reading failed.
  const peakForBar = final === null ? null : mib(top('peak'));
  const bar = series.bar
    ? {
        running: state.state === 'running',
        noErrorLine: errorLines === 0,
        peakWithin400MiB: peakForBar !== null && peakForBar <= 400,
        capturesStored: report?.bars?.capturesStored === true,
      }
    : undefined;

  if (bar !== undefined) {
    bar.met = bar.running && bar.noErrorLine && bar.peakWithin400MiB && bar.capturesStored;
  }

  // The largest reading of `field` of Traefik's, the final one included.
  const traefikTop = (field) =>
    Math.max(
      ...[...traefikSamples, traefikFinal]
        .filter((each) => each !== null)
        .map((each) => each[field])
        .filter(Number.isFinite),
    );
  const round2 = (value) => Math.round(value * 100) / 100;
  const cpu =
    readings.length < 2 || readings.at(-1).t <= readings[0].t
      ? null
      : {
          overS: Math.round((readings.at(-1).t - readings[0].t) / 100) / 10,
          averageCores: round2(cores(readings[0], readings.at(-1))),
          busiest5sCores: busiest === null ? null : round2(busiest),
          throttledS:
            Math.round((readings.at(-1).throttledUsec - readings[0].throttledUsec) / 100_000) / 10,
        };

  // The CPU profile, when asked for: the backend stopped as a rollout stops
  // it, so that V8 writes the profile as the process ends, and the
  // directory copied out of the stopped container. The container's health
  // checks write small profiles of their own beside it.
  if (series.probe && process.env.CPU_PROFILE_DIR !== undefined) {
    try {
      await compose(['stop', '-t', '60', 'backend'], { timeoutMs: 120_000 });
      await compose([
        'cp',
        'backend:/tmp/qa-prof',
        `${process.env.CPU_PROFILE_DIR}/${name}-${Date.now()}`,
      ]);
    } catch (error) {
      console.error(
        `the CPU profile was not copied: ${String(error?.message ?? error).slice(0, 300)}`,
      );
    }
  }

  return {
    series: name,
    ...(bar === undefined ? {} : { bar }),
    report,
    ...(pg === undefined ? {} : { pg }),
    ...(probe === undefined ? {} : { probe }),
    ...(lockWaits === undefined ? {} : { lockWaits }),
    cpu,
    memory:
      baseline === null || final === null
        ? null
        : {
            baselineMiB: {
              rss: mib(baseline.rss),
              rssAnon: mib(baseline.rssAnon),
              current: mib(baseline.current),
              anon: mib(baseline.anon),
              kernel: mib(baseline.kernel),
              sock: mib(baseline.sock),
            },
            growthMiB: {
              ownSampled: mib(top('own') - baseline.own),
              rssAnonSampled: mib(top('rssAnon') - baseline.rssAnon),
              rssSampled: mib(top('rss') - baseline.rss),
              hwmLessBaselineRss: mib(top('hwm') - baseline.rss),
              currentSampled: mib(top('current') - baseline.current),
              anonSampled: mib(top('anon') - baseline.anon),
              fileSampled: mib(top('file') - baseline.file),
              kernelSampled: mib(top('kernel') - baseline.kernel),
              sockSampled: mib(top('sock') - baseline.sock),
            },
            peakMiB: {
              hwm: mib(top('hwm')),
              cgroupPeak: mib(top('peak')),
              rssAnon: mib(top('rssAnon')),
            },
            samples: samples.length,
          },
    // Traefik's memory over the same series (#217): its baseline at `warm`,
    // its largest readings less that baseline, and its cgroup's
    // `memory.peak` at the end and at the series' start - the series' own
    // peak when the two differ or the series ran first.
    traefik:
      traefikBaseline === null || traefikFinal === null
        ? {
            failures: traefikFailures.length,
            firstFailure: traefikFailures[0] ?? null,
            log: traefikLog,
          }
        : {
            baselineMiB: {
              current: mib(traefikBaseline.current),
              anon: mib(traefikBaseline.anon),
              kernel: mib(traefikBaseline.kernel),
              sock: mib(traefikBaseline.sock),
            },
            growthMiB: {
              currentSampled: mib(traefikTop('current') - traefikBaseline.current),
              anonSampled: mib(traefikTop('anon') - traefikBaseline.anon),
              kernelSampled: mib(traefikTop('kernel') - traefikBaseline.kernel),
              sockSampled: mib(traefikTop('sock') - traefikBaseline.sock),
              peakLessBaseline: mib(traefikTop('peak') - traefikBaseline.current),
            },
            peakMiB: {
              cgroupPeak: mib(traefikTop('peak')),
              beforeSeries: traefikBefore === null ? null : mib(traefikBefore.peak),
            },
            // Its CPU from `warm` to the end, in cores, and its busiest 5 s (#205).
            cpu: busiestCores([traefikBaseline, ...traefikSamples, traefikFinal]),
            log: traefikLog,
            samples: traefikSamples.length,
            failures: traefikFailures.length,
            firstFailure: traefikFailures[0] ?? null,
          },
    sampling: {
      failures: sampleFailures.length,
      firstFailure: sampleFailures[0] ?? null,
      // The largest `memory.peak` read before a failure, when the end's
      // reading is lost with the container.
      peakSampledMiB:
        samples.length === 0 ? null : mib(Math.max(...samples.map((each) => each.peak))),
    },
    backend: {
      tcpRmem,
      before: restartsBefore,
      after: status,
      state,
      errorLines,
      errorLinesSample: errorLogLines.slice(0, 3).map((line) => line.slice(0, 300)),
      linesNamingASender: senderLines.length,
      linesNamingASenderSample: senderLines.slice(0, 3),
      refusalLines: refusalLines.length,
      refusedLogged,
      proxyTimeouts,
      logLines: logLines.filter((line) => line.trim() !== '').length,
      requestLogLines,
    },
  };
}

async function orchestrate(argv) {
  const keep = argv.includes('--keep');
  const runsIndex = argv.indexOf('--runs');
  const runs = runsIndex === -1 ? 1 : Number(argv[runsIndex + 1]);
  const imageIndex = argv.indexOf('--image');
  const addressesIndex = argv.indexOf('--addresses');

  backendImage = imageIndex === -1 ? null : argv[imageIndex + 1];
  addressCount = addressesIndex === -1 ? 1 : Number(argv[addressesIndex + 1]);

  const takesValue = new Set(
    [runsIndex, imageIndex, addressesIndex]
      .filter((index) => index !== -1)
      .map((index) => index + 1),
  );
  const names = argv
    .filter((arg, index) => !arg.startsWith('--') && !takesValue.has(index))
    .flatMap((name) => GROUPS[name] ?? [name]);
  const chosen = names.length === 0 ? Object.keys(SERIES) : names;

  for (const name of chosen) {
    if (SERIES[name] === undefined) {
      throw new Error(
        `no such series: ${name}; the series are ${Object.keys(SERIES).join(', ')}, ` +
          `and ${Object.keys(GROUPS).join(' and ')} name several`,
      );
    }
  }

  if (backendImage === null) {
    await compose(['build', 'migrate'], { timeoutMs: 900_000 });
  }

  try {
    // Within the `try`, so that what `up` created before it failed - a
    // network whose fixed subnet another run on the machine holds stops it
    // halfway - is taken down too, and cannot block that run in turn (#183).
    await compose(['up', '-d', '--wait', 'postgres', 'traefik', 'client']);
    await compose(['up', 'migrate'], { timeoutMs: 120_000 });

    for (let run = 1; run <= runs; run += 1) {
      for (const name of chosen) {
        console.log(JSON.stringify({ run, ...(await runSeries(name)) }));
      }
    }
  } finally {
    if (!keep) {
      await compose(['down', '--volumes', '--remove-orphans'], { timeoutMs: 120_000 });
      console.log(JSON.stringify({ down: await leftovers() }));
    }
  }
}

/**
 * What is left of the project once it is down (#231): its
 * containers, by `docker compose ps -a`, and its networks, by Compose's
 * project label; both empty when everything the run started is removed. A
 * failure to read them is reported, not thrown.
 */
async function leftovers() {
  let project = null;

  try {
    project = JSON.parse(await compose(['config', '--format', 'json'])).name;

    const containers = (await compose(['ps', '-a', '--format', '{{.Name}}']))
      .split('\n')
      .filter((line) => line.trim() !== '');
    const networks = await new Promise((resolve, reject) => {
      execFile(
        'docker',
        [
          'network',
          'ls',
          '--filter',
          `label=com.docker.compose.project=${project}`,
          '--format',
          '{{.Name}}',
        ],
        { timeout: 60_000 },
        (error, stdout) =>
          error ? reject(error) : resolve(stdout.split('\n').filter((line) => line.trim() !== '')),
      );
    });

    return { project, containers, networks };
  } catch (error) {
    return { project, error: String(error?.message ?? error).slice(0, 300) };
  }
}

/**
 * Run only as a script, never on import: `measure-connections.test.ts` imports
 * the pure helpers above (`summarizePercentiles`, `rowLockReport`,
 * `throwawayReport`, `summarizeLockWaits`, `clientSeries`, `SERIES`), and
 * `startLockWaits` and `lockWaitsOf` with a stand-in for `psql`, and must
 * not start the orchestration or a worker when it does, as
 * `measure-ordinary-load.mjs` guards its own `main` (#244).
 */
const isMain = (() => {
  if (process.argv[1] === undefined) {
    return false;
  }

  // Real paths, so that a script reached through a symbolic link still runs.
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  if (process.argv[2] === 'client') {
    await client(process.argv[3]);
  } else if (process.argv[2] === 'small-worker') {
    await smallWorker(process.argv[3], Number(process.argv[4]), process.argv[5], process.argv[6]);
  } else if (process.argv[2] === 'api-worker') {
    await apiWorker(process.argv[3], Number(process.argv[4]), process.argv[5], process.argv[6]);
  } else if (process.argv[2] === 'flood-worker') {
    await floodWorker(
      Number(process.argv[3]),
      Number(process.argv[4]),
      process.argv[5],
      process.argv[6],
      Number(process.argv[7] ?? 0),
      Number(process.argv[8] ?? 0),
    );
  } else if (process.argv[2] === 'healthz-worker') {
    await healthzWorker(Number(process.argv[3]), process.argv[4]);
  } else {
    await orchestrate(process.argv.slice(2));
  }
}
