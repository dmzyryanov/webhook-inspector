/**
 * The HTTP servers' timeouts, as `buildServer` and `buildReceiver` build them
 * (D172, D187), and their limits on header lines (D187, D213).
 *
 * Read off the Node servers rather than measured: a stalled request is answered
 * only 90 to 120 s after it began, which a suite should not wait for. What the
 * values do was measured once, with the bounds scaled down, and D172 records it.
 *
 * The receive listener carries the same values as the application listener,
 * and on it they matter more: Traefik's TCP route has no HTTP timeout of its
 * own, so these are the bounds a sender meets (D187).
 *
 * Needs no database: the pool is never queried, because no request is sent.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { MAX_API_HEADER_LINES, MAX_PIPELINED_REQUESTS } from '@webhook-inspector/shared';
import { DEFAULT_PREFACE_TIMEOUT_MS } from './modules/webhook/http2-preface.ts';
import {
  HTTP2_MAX_CONCURRENT_STREAMS,
  HTTP2_MAX_CONNECTIONS_PER_ADDRESS,
  HTTP2_MAX_HEADER_LIST_PAIRS,
  HTTP2_MAX_HEADER_LIST_SIZE,
  HTTP2_MAX_PSEUDO_HEADER_BYTES,
  HTTP2_MAX_SESSION_MEMORY_MB,
  HTTP2_REQUEST_TIMEOUT_MS,
  HTTP2_SESSION_IDLE_TIMEOUT_MS,
  HTTP2_STREAM_RESET_BURST,
  HTTP2_STREAM_RESET_RATE,
  receiveHttp2ServerOptions,
} from './modules/webhook/http2-server.ts';
import { buildReceiver, buildServer, receiverHttp2 } from './server.ts';

function assertTimeouts(app: FastifyInstance): void {
  // Longer than Traefik's pinned readTimeout of 60 s, so that on the
  // application listener Traefik answers first; the bound itself on the
  // receive listener and wherever there is no Traefik.
  assert.equal(app.server.requestTimeout, 90_000);

  // Unset: an inactivity timeout would cut a response held by a delay.
  assert.equal(app.initialConfig.connectionTimeout, 0);
  assert.equal(app.server.timeout, 0);

  // Fastify assigns requestTimeout after Node constructed the server, so
  // Node's own check of this order never runs; with the order reversed,
  // Node swaps the two and the larger bounds the whole request.
  assert.ok(app.server.headersTimeout > 0);
  assert.ok(app.server.headersTimeout <= app.server.requestTimeout);

  // Node's default, which docs/API.md states as this server's.
  assert.equal(app.server.headersTimeout, 60_000);

  // Fastify's default, how long an idle kept-alive connection stays open.
  assert.equal(app.server.keepAliveTimeout, 72_000);

  // No size limit of its own: Node's default of 16 KiB of request target and
  // header names and values, which docs/API.md states, applies to both.
  assert.equal((app.server as { maxHeaderSize?: number }).maxHeaderSize, undefined);
  assert.equal(http.maxHeaderSize, 16_384);
}

describe('server timeouts (D172)', () => {
  it('bounds a request at 90 s, sets no connection timeout, and keeps headersTimeout within it', async () => {
    const pool = new pg.Pool();
    const app = buildServer(pool);

    try {
      assertTimeouts(app);
      // At most 100 header lines, the `Host` line included (D213); Node
      // refuses more with 431. `limits/calls-in-flight-routes.test.ts`
      // sends 100 and 101.
      assert.equal(app.server.maxHeadersCount, MAX_API_HEADER_LINES);
      assert.equal(MAX_API_HEADER_LINES, 100);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('gives the receive listener the same bounds, with and without PROXY protocol (D187)', async () => {
    const pool = new pg.Pool();
    const plain = buildReceiver(pool);
    const proxied = buildReceiver(pool, {
      proxyProtocol: 'v2',
      trustedProxyCidrs: ['10.42.0.0/24'],
    });

    try {
      assertTimeouts(plain);
      assertTimeouts(proxied);

      // No limit on the number of header lines; Node's 16 KiB of request
      // target and header names and values bounds them
      // (receiver.test.ts sends 2500).
      assert.equal(plain.server.maxHeadersCount, 0);
      assert.equal(proxied.server.maxHeadersCount, 0);
    } finally {
      await plain.close();
      await proxied.close();
      await pool.end();
    }
  });

  it('gives the receive listener’s HTTP/2 path its bounds, with RECEIVE_HTTP2 on alone (D263)', async () => {
    // D229's 32, and the header bound: 4,096 lines and the four
    // pseudo-header fields, which hold a header block left open to under
    // 1 MiB (D266, amending D263's 16,388); 16 KiB of names and values,
    // 1 KiB for what HTTP/2 counts and HTTP/1.1 does not, and 32 bytes a
    // field.
    assert.equal(HTTP2_MAX_CONCURRENT_STREAMS, MAX_PIPELINED_REQUESTS);
    assert.equal(HTTP2_MAX_CONCURRENT_STREAMS, 32);
    assert.equal(HTTP2_MAX_HEADER_LIST_PAIRS, 4_100);
    assert.equal(HTTP2_MAX_HEADER_LIST_PAIRS, 4_096 + 4);
    assert.equal(HTTP2_MAX_HEADER_LIST_SIZE, 148_608);
    assert.equal(HTTP2_MAX_HEADER_LIST_SIZE, 16_384 + 1_024 + 32 * 4_100);
    assert.equal(HTTP2_MAX_SESSION_MEMORY_MB, 10);
    // Rapid reset's bound: 64 streams reset in a burst and 33 a second
    // after it, past which nghttp2 ends the connection (D266; Node's
    // defaults are 1,000 and 33).
    assert.equal(HTTP2_STREAM_RESET_BURST, 64);
    assert.equal(HTTP2_STREAM_RESET_RATE, 33);
    // At most 32 HTTP/2 connections from one sender address, counted among
    // D227's 512 with PROXY protocol on (D266).
    assert.equal(HTTP2_MAX_CONNECTIONS_PER_ADDRESS, 32);
    // A `:path` or `:authority` within the list is bounded to HTTP/1.1's
    // 16 KiB request head, so neither reaches the HTTP/1.1-sized consumers
    // (D266, #208); a longer one is refused ENHANCE_YOUR_CALM.
    assert.equal(HTTP2_MAX_PSEUDO_HEADER_BYTES, 16_384);
    // D172's 90 s for a request to arrive, and Fastify's 72 s of an idle
    // connection, as on HTTP/1.1.
    assert.equal(HTTP2_REQUEST_TIMEOUT_MS, 90_000);
    assert.equal(HTTP2_SESSION_IDLE_TIMEOUT_MS, 72_000);
    // The preface's own deadline.
    assert.equal(DEFAULT_PREFACE_TIMEOUT_MS, 10_000);
    assert.deepEqual(receiveHttp2ServerOptions(), {
      maxHeaderListPairs: 4_100,
      maxSessionMemory: 10,
      streamResetBurst: 64,
      streamResetRate: 33,
      strictFieldWhitespaceValidation: false,
      settings: { maxConcurrentStreams: 32, maxHeaderListSize: 148_608 },
    });

    const pool = new pg.Pool();
    const off = buildReceiver(pool);
    const on = buildReceiver(pool, { http2: 'on' });
    const proxied = buildReceiver(pool, {
      http2: 'on',
      proxyProtocol: 'v2',
      trustedProxyCidrs: ['10.42.0.0/24'],
    });
    // D227's one-line recovery, `0`, turns the HTTP/2 count off with it.
    const recovered = buildReceiver(pool, {
      http2: 'on',
      proxyProtocol: 'v2',
      trustedProxyCidrs: ['10.42.0.0/24'],
      connectionsPerAddress: 0,
    });

    try {
      // Off, the default, builds nothing of it.
      assert.equal(receiverHttp2(off), undefined);
      // The HTTP/2 connections of an address are counted with PROXY protocol
      // alone, where D227 counts (D266).
      assert.equal(receiverHttp2(on)?.connections, null);
      assert.equal(receiverHttp2(proxied)?.connections?.limit, 32);
      assert.equal(receiverHttp2(recovered)?.connections, null);

      for (const receiver of [on, proxied]) {
        const part = receiverHttp2(receiver);

        assert.ok(part !== undefined);
        // Node's HTTP/2 server, h2c, listening on nothing.
        assert.equal(part.server.constructor.name, 'Http2Server');
        assert.equal(part.server.listening, false);
        // The HTTP/1.1 server keeps its own bounds.
        assertTimeouts(receiver);
        assert.equal(receiver.server.maxHeadersCount, 0);
      }
    } finally {
      await off.close();
      await on.close();
      await proxied.close();
      await recovered.close();
      await pool.end();
    }
  });
});
