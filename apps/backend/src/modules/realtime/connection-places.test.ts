/**
 * The realtime connections of each address (D227), without a server: 16 by
 * default, the next refused `429` / `1020` with `Retry-After: 1`; the place
 * given back exactly once, when the upgraded socket closes or, for a
 * connection never upgraded, when the reply's response closes; at once for a
 * response or a socket already closed; an IPv6 address counted by its `/64`
 * and an IPv4-mapped one as its IPv4; an address kept only while it holds a
 * place. `connection-cap.test.ts` holds the same over real sockets.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ErrorCode,
  MAX_REALTIME_CONNECTIONS_PER_ADDRESS,
  REALTIME_CONNECTIONS_RETRY_AFTER_SECONDS,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { createRealtimePlaces, realtimeConnections } from './connection-places.ts';

const OPEN = 1;
const CLOSED = 3;

/** What the cap reads of a connection: the address, and its response's `close`. */
function fakeConnection(ip: string): {
  request: FastifyRequest;
  reply: FastifyReply;
  response: EventEmitter & { destroyed: boolean };
} {
  const response = Object.assign(new EventEmitter(), { destroyed: false });

  return {
    request: { ip } as FastifyRequest,
    reply: { raw: response } as unknown as FastifyReply,
    response,
  };
}

/** What the cap reads of an upgraded socket: its state and its `close`. */
function fakeSocket(readyState = OPEN): EventEmitter & { readyState: number; CLOSED: number } {
  return Object.assign(new EventEmitter(), { readyState, CLOSED });
}

function isTooMany(limit: number) {
  return (error: unknown) =>
    error instanceof AppError &&
    error.statusCode === 429 &&
    error.errorCode === ErrorCode.TOO_MANY_REALTIME_CONNECTIONS &&
    error.errorCode === 1020 &&
    error.headers['retry-after'] === '1' &&
    error.message ===
      `Too many realtime connections: ${limit} open at once per address; close one and try again`;
}

describe('the realtime connections of an address (D227)', () => {
  it('are 16 by default, the 17th refused 429 / 1020 with Retry-After: 1, another address unaffected', () => {
    assert.equal(MAX_REALTIME_CONNECTIONS_PER_ADDRESS, 16);
    assert.equal(REALTIME_CONNECTIONS_RETRY_AFTER_SECONDS, 1);

    const places = createRealtimePlaces();
    const connections = realtimeConnections(places);

    assert.equal(places.limit, 16);

    for (let index = 0; index < 16; index += 1) {
      const { request, reply } = fakeConnection('203.0.113.10');

      connections.take(request, reply);
    }

    assert.equal(places.takenBy('203.0.113.10'), 16);

    const refused = fakeConnection('203.0.113.10');

    assert.throws(() => connections.take(refused.request, refused.reply), isTooMany(16));
    assert.equal(places.takenBy('203.0.113.10'), 16);
    // A refused connection holds nothing, so its close gives nothing back.
    refused.response.emit('close');
    assert.equal(places.takenBy('203.0.113.10'), 16);

    const other = fakeConnection('203.0.113.11');

    connections.take(other.request, other.reply);
    assert.equal(places.takenBy('203.0.113.11'), 1);
    assert.equal(places.taken, 17);
  });

  it('gives the place back when the reply closes, for a connection never upgraded, once', () => {
    const places = createRealtimePlaces(1);
    const connections = realtimeConnections(places);
    const first = fakeConnection('203.0.113.10');

    connections.take(first.request, first.reply);
    assert.equal(places.takenBy('203.0.113.10'), 1);

    first.response.emit('close');
    assert.equal(places.taken, 0);
    assert.equal(places.keys, 0, 'the address is kept after its last place');

    // A second close gives nothing more back: another connection's place stays.
    const second = fakeConnection('203.0.113.10');

    connections.take(second.request, second.reply);
    first.response.emit('close');
    assert.equal(places.takenBy('203.0.113.10'), 1);
  });

  it('gives the place back when the upgraded socket closes, once, whichever close comes first', () => {
    const places = createRealtimePlaces(2);
    const connections = realtimeConnections(places);
    const socketFirst = fakeConnection('203.0.113.10');
    const responseFirst = fakeConnection('203.0.113.10');
    const one = fakeSocket();
    const two = fakeSocket();

    connections.take(socketFirst.request, socketFirst.reply);
    connections.take(responseFirst.request, responseFirst.reply);
    connections.hold(socketFirst.request, one);
    connections.hold(responseFirst.request, two);
    assert.equal(places.takenBy('203.0.113.10'), 2);

    // The socket's close first, then its response's: one place back.
    one.emit('close');
    assert.equal(places.takenBy('203.0.113.10'), 1);
    socketFirst.response.emit('close');
    assert.equal(places.takenBy('203.0.113.10'), 1);

    // The response's close first, then the socket's: the other one.
    responseFirst.response.emit('close');
    assert.equal(places.taken, 0);
    two.emit('close');
    assert.equal(places.taken, 0);

    // The places are free for two more.
    for (let index = 0; index < 2; index += 1) {
      const { request, reply } = fakeConnection('203.0.113.10');

      connections.take(request, reply);
    }

    assert.equal(places.takenBy('203.0.113.10'), 2);
  });

  it('gives the place back at once for a response or a socket already closed', () => {
    const places = createRealtimePlaces(1);
    const connections = realtimeConnections(places);
    const gone = fakeConnection('203.0.113.10');

    gone.response.destroyed = true;
    connections.take(gone.request, gone.reply);
    assert.equal(places.taken, 0);

    const upgraded = fakeConnection('203.0.113.10');

    connections.take(upgraded.request, upgraded.reply);
    connections.hold(upgraded.request, fakeSocket(CLOSED));
    assert.equal(places.taken, 0);
  });

  it('holds nothing for a request that took no place', () => {
    const places = createRealtimePlaces(1);
    const connections = realtimeConnections(places);
    const socket = fakeSocket();

    connections.hold(fakeConnection('203.0.113.10').request, socket);
    assert.equal(socket.listenerCount('close'), 0);
    assert.equal(places.taken, 0);
  });

  it('counts two IPv6 addresses of one /64 together, an IPv4-mapped one as its IPv4, others apart', () => {
    const places = createRealtimePlaces(2);
    const connections = realtimeConnections(places);
    const take = (ip: string): void => {
      const { request, reply } = fakeConnection(ip);

      connections.take(request, reply);
    };

    take('2001:db8:1:2::1');
    take('2001:db8:1:2:ffff:ffff:ffff:fffe');
    assert.throws(() => take('2001:DB8:1:2::3%eth0'), isTooMany(2));
    take('2001:db8:1:3::1');
    assert.equal(places.takenBy('2001:db8:1:2::/64'), 2);
    assert.equal(places.takenBy('2001:db8:1:3::/64'), 1);

    take('::ffff:198.51.100.7');
    take('198.51.100.7');
    assert.throws(() => take('::ffff:c633:6407'), isTooMany(2));
    assert.equal(places.takenBy('198.51.100.7'), 2);
    assert.equal(places.keys, 3);
  });
});
