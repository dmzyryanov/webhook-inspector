/** Unit tests for the connection registry. No database, no sockets. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BODY_BYTES,
  NEGOTIABLE_EVENT_TYPES,
  type ServerEvent,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { parseQueueBody, parseResponse, parseRulesBody } from '../sessions/response-config.ts';
import {
  escapedFullResponse,
  largestQueueBody,
  ordinaryFullQueue,
} from '../../testing/full-queue.ts';
import { largestRulesBody, ordinaryFullRules } from '../../testing/full-rules.ts';
import {
  MAX_SUBSCRIBER_BACKLOG_BYTES,
  RealtimeHub,
  RELOAD_CLOSE_CODE,
  type Subscriber,
} from './hub.ts';

/** A connection that declared nothing, which is every pre-v0.5.0 client. */
const DECLARES_NOTHING: ReadonlySet<string> = new Set();

/** A connection that declared every optional event type there is (D115). */
const DECLARES_EVERYTHING: ReadonlySet<string> = new Set(NEGOTIABLE_EVENT_TYPES);

function captured(id: string, method = 'POST'): ServerEvent {
  return {
    type: 'request.received',
    data: {
      id,
      method,
      receivedAt: '2026-08-24T00:00:00.000Z',
      bodySize: 0,
      sourceIp: null,
      path: '/s/abc/x',
      response: { state: 'pending', status: 200, queueStep: null, rule: null },
    },
  };
}

/**
 * A stand-in connection recording what it is sent, how it is closed and how
 * often it is terminated. `bufferedAmount` is what a test sets: the bytes the
 * connection has not yet written to the network.
 */
function recorder(): Subscriber & {
  received: string[];
  closed: [number, string][];
  terminated: number;
  bufferedAmount: number;
} {
  const received: string[] = [];
  const closed: [number, string][] = [];

  return {
    received,
    closed,
    terminated: 0,
    bufferedAmount: 0,
    send(data: string) {
      received.push(data);
    },
    close(code: number, reason: string) {
      closed.push([code, reason]);
    },
    terminate() {
      this.terminated += 1;
    },
  };
}

describe('RealtimeHub', () => {
  it('delivers an event to every subscriber of that session only', () => {
    const hub = new RealtimeHub();
    const first = recorder();
    const second = recorder();
    const other = recorder();

    hub.add('session-a', first, DECLARES_NOTHING);
    hub.add('session-a', second, DECLARES_NOTHING);
    hub.add('session-b', other, DECLARES_NOTHING);

    hub.publish('session-a', captured('r1'));

    const expected = [
      '{"type":"request.received","data":{"id":"r1","method":"POST","receivedAt":"2026-08-24T00:00:00.000Z","bodySize":0,"sourceIp":null,"path":"/s/abc/x","response":{"state":"pending","status":200,"queueStep":null,"rule":null}}}',
    ];

    assert.deepEqual(first.received, expected);
    assert.deepEqual(second.received, expected);
    assert.deepEqual(other.received, []);
  });

  it('publishing to a session nobody watches does nothing', () => {
    const hub = new RealtimeHub();

    assert.doesNotThrow(() => hub.publish('session-a', captured('r1', 'GET')));
  });

  it('forgets a removed subscriber and the session it was the last of', () => {
    const hub = new RealtimeHub();
    const subscriber = recorder();

    hub.add('session-a', subscriber, DECLARES_NOTHING);
    hub.remove('session-a', subscriber);

    assert.equal(hub.countFor('session-a'), 0);

    hub.publish('session-a', captured('r1', 'GET'));

    assert.deepEqual(subscriber.received, []);
  });

  /**
   * A capture must not fail because a viewer's socket did. The request is
   * already stored, and the viewer will see it when it reloads.
   */
  it('keeps going when a subscriber throws, and drops it', () => {
    const hub = new RealtimeHub();
    const broken: Subscriber = {
      send() {
        throw new Error('socket is gone');
      },
      close() {},
      bufferedAmount: 0,
      terminate() {},
    };
    const healthy = recorder();

    hub.add('session-a', broken, DECLARES_NOTHING);
    hub.add('session-a', healthy, DECLARES_NOTHING);

    assert.doesNotThrow(() => hub.publish('session-a', captured('r1', 'GET')));
    assert.equal(healthy.received.length, 1);
    assert.equal(hub.countFor('session-a'), 1);
  });

  /**
   * The two halves of D115's gate, which is a positive allow-list of negotiable
   * types rather than "send only what was declared". Asserting only the first
   * would pass just as well under the inverted rule, which silences `ready` and
   * `request.received` for every existing client.
   */
  it('sends a negotiable event only to the subscribers that declared it', () => {
    const hub = new RealtimeHub();
    const declaring = recorder();
    const silent = recorder();

    hub.add('session-a', declaring, DECLARES_EVERYTHING);
    hub.add('session-a', silent, DECLARES_NOTHING);

    hub.publish('session-a', {
      type: 'response.recorded',
      data: { id: 'r1', response: { state: 'sent', status: 200, queueStep: null, rule: null } },
    });

    assert.deepEqual(declaring.received, [
      '{"type":"response.recorded","data":{"id":"r1","response":{"state":"sent","status":200,"queueStep":null,"rule":null}}}',
    ]);
    assert.deepEqual(silent.received, []);
  });

  it('sends an event that is not negotiable to every subscriber, declared or not', () => {
    const hub = new RealtimeHub();
    const declaring = recorder();
    const silent = recorder();

    hub.add('session-a', declaring, DECLARES_EVERYTHING);
    hub.add('session-a', silent, DECLARES_NOTHING);

    hub.publish('session-a', captured('r1'));

    assert.equal(declaring.received.length, 1);
    assert.deepEqual(silent.received, declaring.received);
  });

  it('treats request.deleted and requests.cleared as negotiable (D135)', () => {
    const hub = new RealtimeHub();
    const declaring = recorder();
    const silent = recorder();

    hub.add('session-a', declaring, DECLARES_EVERYTHING);
    hub.add('session-a', silent, DECLARES_NOTHING);

    hub.publish('session-a', { type: 'request.deleted', data: { id: 'r1' } });
    hub.publish('session-a', { type: 'requests.cleared' });

    assert.deepEqual(declaring.received, [
      '{"type":"request.deleted","data":{"id":"r1"}}',
      '{"type":"requests.cleared"}',
    ]);
    assert.deepEqual(silent.received, []);
  });

  it('sends a deletion only to the subscribers that declared that type', () => {
    const hub = new RealtimeHub();
    const deletedOnly = recorder();

    hub.add('session-a', deletedOnly, new Set(['request.deleted']));

    hub.publish('session-a', { type: 'requests.cleared' });
    hub.publish('session-a', { type: 'request.deleted', data: { id: 'r1' } });

    assert.deepEqual(deletedOnly.received, ['{"type":"request.deleted","data":{"id":"r1"}}']);
  });
});

/**
 * A session deleted through the API closes its viewers (D198). The socket-level
 * behaviour - the close frame a real client receives - is pinned in
 * `session-delete.test.ts`; these pin the registry's part of it.
 */
describe('RealtimeHub.closeSession', () => {
  it('closes every subscriber of that session with the code and reason, and no other', () => {
    const hub = new RealtimeHub();
    const first = recorder();
    const second = recorder();
    const other = recorder();

    hub.add('session-a', first, DECLARES_EVERYTHING);
    hub.add('session-a', second, DECLARES_NOTHING);
    hub.add('session-b', other, DECLARES_NOTHING);

    hub.closeSession('session-a', 4404, 'Session not found');

    assert.deepEqual(first.closed, [[4404, 'Session not found']]);
    assert.deepEqual(second.closed, [[4404, 'Session not found']]);
    assert.deepEqual(other.closed, []);
    assert.equal(hub.countFor('session-b'), 1);
  });

  it('forgets the closed subscribers at once, so nothing published afterwards reaches them', () => {
    const hub = new RealtimeHub();
    const subscriber = recorder();

    hub.add('session-a', subscriber, DECLARES_EVERYTHING);
    hub.closeSession('session-a', 4404, 'Session not found');

    assert.equal(hub.countFor('session-a'), 0);

    hub.publish('session-a', captured('r1'));
    hub.publish('session-a', {
      type: 'response.recorded',
      data: { id: 'r1', response: { state: 'sent', status: 200, queueStep: null, rule: null } },
    });

    assert.deepEqual(subscriber.received, []);
  });

  it('closes the others when one subscriber throws on close', () => {
    const hub = new RealtimeHub();
    const broken: Subscriber = {
      send() {},
      close() {
        throw new Error('socket is gone');
      },
      bufferedAmount: 0,
      terminate() {},
    };
    const healthy = recorder();

    hub.add('session-a', broken, DECLARES_NOTHING);
    hub.add('session-a', healthy, DECLARES_NOTHING);

    assert.doesNotThrow(() => hub.closeSession('session-a', 4404, 'Session not found'));
    assert.deepEqual(healthy.closed, [[4404, 'Session not found']]);
    assert.equal(hub.countFor('session-a'), 0);
  });

  it('counts every call, a session nobody watches included', () => {
    const hub = new RealtimeHub();

    assert.equal(hub.closedSessions, 0);

    hub.closeSession('session-a', 4404, 'Session not found');
    hub.add('session-b', recorder(), DECLARES_NOTHING);
    hub.closeSession('session-b', 4404, 'Session not found');

    assert.equal(hub.closedSessions, 2);
  });

  it('leaves a removal after the close harmless', () => {
    const hub = new RealtimeHub();
    const subscriber = recorder();

    hub.add('session-a', subscriber, DECLARES_NOTHING);
    hub.closeSession('session-a', 4404, 'Session not found');

    // What the socket's own `close` listener does once the handshake ends.
    assert.doesNotThrow(() => hub.remove('session-a', subscriber));
    assert.equal(hub.countFor('session-a'), 0);
  });
});

/**
 * What one read of the listener delivers to: the session's registrations as
 * the read returned (D221 point 5).
 */
describe('RealtimeHub.snapshot', () => {
  it('delivers among a snapshot only to its registrations still registered, and judges wants on it', () => {
    const hub = new RealtimeHub();
    const before = recorder();
    const leaving = recorder();
    const legacy = recorder();
    const later = recorder();

    hub.add('session-a', before, DECLARES_NOTHING);
    hub.add('session-a', leaving, DECLARES_NOTHING);

    const among = hub.snapshot('session-a');

    hub.remove('session-a', leaving);
    hub.add('session-a', later, DECLARES_EVERYTHING);
    hub.deliver('session-a', 'request.received', JSON.stringify(captured('r1')), among);

    assert.equal(before.received.length, 1);
    assert.equal(leaving.received.length, 0);
    assert.equal(later.received.length, 0);
    assert.equal(hub.wants('session-a', 'response.recorded', among), false);
    assert.equal(hub.wants('session-a', 'response.recorded'), true);
    assert.equal(hub.wants('session-b', 'request.received', hub.snapshot('session-b')), false);

    hub.add('session-c', legacy, DECLARES_NOTHING);
    assert.equal(hub.wants('session-c', 'request.received', hub.snapshot('session-c')), true);
  });

  it('closes a snapshot’s registrations still registered with 1013 on reload, and no one else', () => {
    const hub = new RealtimeHub();
    const first = recorder();
    const second = recorder();
    const later = recorder();
    const other = recorder();

    hub.add('session-a', first, DECLARES_NOTHING);
    hub.hold('session-a', second, DECLARES_EVERYTHING);
    hub.add('session-b', other, DECLARES_NOTHING);

    const among = hub.snapshot('session-a');

    hub.add('session-a', later, DECLARES_NOTHING);
    hub.reload('session-a', among);
    hub.reload('session-a', among);

    assert.equal(RELOAD_CLOSE_CODE, 1013);
    assert.deepEqual(first.closed, [[1013, 'Try again later']]);
    assert.deepEqual(second.closed, [[1013, 'Try again later']]);
    assert.deepEqual(later.closed, []);
    assert.deepEqual(other.closed, []);
    assert.equal(hub.countFor('session-a'), 1);
    assert.equal(hub.countFor('session-b'), 1);
    assert.equal(hub.release('session-a', second, '{"type":"ready"}'), false);
  });
});

/**
 * A connection the realtime route registers before it may look its session up
 * again, and announces with `ready` only afterwards (D081, D198). Its `ready`
 * stays the first message, and nothing published in between is lost. The
 * route's part - a publish during the second lookup, over a real socket - is
 * pinned in `session-delete.test.ts`.
 */
describe('RealtimeHub.hold and release', () => {
  const READY = '{"type":"ready"}';

  it('sends a held subscriber nothing until it is released, then the first message and what it held, in order', () => {
    const hub = new RealtimeHub();
    const held = recorder();
    const live = recorder();

    hub.hold('session-a', held, DECLARES_EVERYTHING);
    hub.add('session-a', live, DECLARES_EVERYTHING);

    hub.publish('session-a', captured('r1'));
    hub.publish('session-a', { type: 'request.deleted', data: { id: 'r0' } });
    hub.publish('session-a', captured('r2'));

    assert.deepEqual(held.received, []);
    assert.equal(live.received.length, 3);
    assert.equal(hub.countFor('session-a'), 2);

    assert.equal(hub.release('session-a', held, READY), true);
    assert.deepEqual(held.received, [READY, ...live.received]);

    // Released: from now on it is sent each event as it is published.
    hub.publish('session-a', captured('r3'));

    assert.deepEqual(held.received.slice(4), live.received.slice(3));
    assert.equal(held.received.length, 5);
  });

  it('holds only what the subscriber declared, as it sends a live one only that (D115)', () => {
    const hub = new RealtimeHub();
    const silent = recorder();

    hub.hold('session-a', silent, DECLARES_NOTHING);
    hub.publish('session-a', {
      type: 'response.recorded',
      data: { id: 'r1', response: { state: 'sent', status: 200, queueStep: null, rule: null } },
    });
    hub.publish('session-a', captured('r1'));
    hub.release('session-a', silent, READY);

    assert.equal(silent.received.length, 2);
    assert.equal(silent.received[0], READY);
    assert.ok(silent.received[1]?.startsWith('{"type":"request.received"'));
  });

  it('sends nothing it held to a subscriber closed with its session, and does not release it', () => {
    const hub = new RealtimeHub();
    const held = recorder();

    hub.hold('session-a', held, DECLARES_EVERYTHING);
    hub.publish('session-a', captured('r1'));
    hub.closeSession('session-a', 4404, 'Session not found');

    assert.equal(hub.release('session-a', held, READY), false);
    assert.deepEqual(held.received, []);
    assert.deepEqual(held.closed, [[4404, 'Session not found']]);
  });

  it('sends nothing to a subscriber removed before its release', () => {
    const hub = new RealtimeHub();
    const held = recorder();

    hub.hold('session-a', held, DECLARES_EVERYTHING);
    hub.publish('session-a', captured('r1'));
    hub.remove('session-a', held);

    assert.equal(hub.release('session-a', held, READY), false);
    assert.deepEqual(held.received, []);
    assert.equal(hub.countFor('session-a'), 0);
  });

  it('drops a subscriber that fails to accept what it is released with, as publish drops one', () => {
    const hub = new RealtimeHub();
    const broken: Subscriber = {
      send() {
        throw new Error('socket is gone');
      },
      close() {},
      bufferedAmount: 0,
      terminate() {},
    };

    hub.hold('session-a', broken, DECLARES_EVERYTHING);
    hub.publish('session-a', captured('r1'));

    assert.equal(hub.release('session-a', broken, READY), false);
    assert.equal(hub.countFor('session-a'), 0);
  });
});

/** A promise and the function that settles it, so a test decides when a change ends. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

/** Lets every callback already due run: the microtasks, then one turn of the event loop. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The ids of the `request.received` events a recorder was sent, in order. */
function receivedIds(subscriber: { received: string[] }): string[] {
  return subscriber.received.map((payload) => {
    const event = JSON.parse(payload) as ServerEvent;

    return event.type === 'request.received' ? event.data.id : event.type;
  });
}

/**
 * The session's line of calls (D205): the turns of one session follow the
 * order the calls were made, one at a time, and a call for another session
 * waits for none of them. The events are no longer the line's: a change
 * writes its own in its transaction (D221).
 */
describe('RealtimeHub.inOrder', () => {
  it('runs the calls of one session one at a time in call order, a throw included', async () => {
    const hub = new RealtimeHub();
    const log: string[] = [];
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];

    const calls = gates.map((gate, index) =>
      hub.inOrder('session-a', async () => {
        log.push(`start ${index}`);

        const id = await gate.promise;

        if (id === 'refused') {
          throw new Error('refused');
        }

        log.push(`end ${index}`);

        return id;
      }),
    );

    await settle();
    assert.deepEqual(log, ['start 0']);

    // Settled out of order: the last first, then the second, which throws.
    // Neither starts before the first has ended.
    gates[3]?.resolve('r3');
    gates[1]?.resolve('refused');
    await settle();
    assert.deepEqual(log, ['start 0']);

    gates[0]?.resolve('r0');
    gates[2]?.resolve('r2');

    const results = await Promise.allSettled(calls);

    assert.deepEqual(log, ['start 0', 'end 0', 'start 1', 'start 2', 'end 2', 'start 3', 'end 3']);
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'rejected', 'fulfilled', 'fulfilled'],
    );
    assert.equal(hub.sessionsInLine, 0);
  });

  it('answers what the change answered, and delivers nothing itself', async () => {
    const hub = new RealtimeHub();
    const viewer = recorder();

    hub.add('session-a', viewer, DECLARES_NOTHING);

    assert.equal(await hub.inOrder('session-a', async () => 'r1'), 'r1');
    assert.deepEqual(viewer.received, []);
  });

  it('holds no session behind another session’s call', async () => {
    const hub = new RealtimeHub();
    const held = deferred<string>();
    const first = hub.inOrder('session-a', () => held.promise);
    let ran = false;

    assert.equal(
      await hub.inOrder('session-b', async () => {
        ran = true;

        return 'b';
      }),
      'b',
    );
    assert.equal(ran, true);
    // The first session's call is still running, the only line left.
    assert.equal(hub.sessionsInLine, 1);

    held.resolve('a');

    assert.equal(await first, 'a');
    assert.equal(hub.sessionsInLine, 0);
  });

  it('keeps nothing of a session once its line is empty, after 10,000 sessions', async () => {
    const hub = new RealtimeHub();
    const calls: Promise<unknown>[] = [];

    for (let index = 0; index < 10_000; index += 1) {
      const id = `session-${index}`;

      calls.push(hub.inOrder(id, async () => index));

      // Every tenth session has a second call behind the first, which throws.
      if (index % 10 === 0) {
        calls.push(
          hub
            .inOrder(id, async () => {
              throw new Error('refused');
            })
            .catch(() => undefined),
        );
      }
    }

    assert.equal(hub.sessionsInLine, 10_000);

    await Promise.all(calls);

    assert.equal(hub.sessionsInLine, 0);
  });
});

/**
 * How far behind a connection may fall (D205): an event that would take what a
 * connection has not yet written, or what is held for it, over
 * `MAX_SUBSCRIBER_BACKLOG_BYTES` terminates it and drops it, and is never
 * skipped for a connection kept.
 */
describe('RealtimeHub’s bound on a connection’s backlog', () => {
  const READY = '{"type":"ready"}';
  const EVENT = captured('r1');
  const EVENT_BYTES = Buffer.byteLength(JSON.stringify(EVENT));

  it('terminates and drops a connection the event would put over the bound, and sends the others', () => {
    const hub = new RealtimeHub();
    const behind = recorder();
    const healthy = recorder();

    behind.bufferedAmount = MAX_SUBSCRIBER_BACKLOG_BYTES - EVENT_BYTES + 1;
    healthy.bufferedAmount = MAX_SUBSCRIBER_BACKLOG_BYTES - EVENT_BYTES;
    hub.add('session-a', behind, DECLARES_NOTHING);
    hub.add('session-a', healthy, DECLARES_NOTHING);

    hub.publish('session-a', EVENT);

    assert.deepEqual(behind.received, []);
    assert.equal(behind.terminated, 1);
    // Never a closing handshake, which would queue behind the backlog.
    assert.deepEqual(behind.closed, []);
    assert.equal(healthy.received.length, 1);
    assert.equal(healthy.terminated, 0);
    assert.equal(hub.countFor('session-a'), 1);
  });

  it('sends nothing more to a connection it cut, even once its buffer has drained', () => {
    const hub = new RealtimeHub();
    const viewer = recorder();

    hub.add('session-a', viewer, DECLARES_NOTHING);
    hub.publish('session-a', captured('r1'));

    viewer.bufferedAmount = MAX_SUBSCRIBER_BACKLOG_BYTES;
    hub.publish('session-a', captured('r2'));

    viewer.bufferedAmount = 0;
    hub.publish('session-a', captured('r3'));

    // No event after a skipped one: the connection is gone after `r1`.
    assert.deepEqual(receivedIds(viewer), ['r1']);
    assert.equal(viewer.terminated, 1);
    assert.equal(hub.countFor('session-a'), 0);
  });

  it('cuts a held connection whose held events would pass the bound, and never releases it', () => {
    const hub = new RealtimeHub();
    const held = recorder();
    const big = updatedOf(stateOfBytes(MAX_SUBSCRIBER_BACKLOG_BYTES / 2 - 1_000));
    const bigBytes = Buffer.byteLength(JSON.stringify(big));

    hub.hold('session-a', held, DECLARES_EVERYTHING);
    hub.publish('session-a', big);
    hub.publish('session-a', big);
    assert.equal(held.terminated, 0, `${2 * bigBytes} bytes held cut the connection`);

    hub.publish('session-a', big);

    assert.equal(held.terminated, 1);
    assert.equal(hub.release('session-a', held, READY), false);
    assert.deepEqual(held.received, []);
    assert.equal(hub.countFor('session-a'), 0);
  });

  it('releases a held connection with everything held under the bound', () => {
    const hub = new RealtimeHub();
    const held = recorder();
    const big = updatedOf(stateOfBytes(MAX_SUBSCRIBER_BACKLOG_BYTES / 2 - 1_000));

    hub.hold('session-a', held, DECLARES_EVERYTHING);
    hub.publish('session-a', big);
    hub.publish('session-a', big);

    assert.equal(hub.release('session-a', held, READY), true);
    assert.equal(held.received.length, 3);
    assert.equal(held.terminated, 0);

    // Released, it is bounded by what it has not written, not by what it was held.
    hub.publish('session-a', big);
    assert.equal(held.received.length, 4);
  });

  it('reports cut connections at most once a minute, with their count and no session id', (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

    const hub = new RealtimeHub();
    const lines: [object, string][] = [];

    hub.reportTo({
      warn(details, message) {
        lines.push([details, message]);
      },
    });

    const cutOne = (): void => {
      const viewer = recorder();

      viewer.bufferedAmount = MAX_SUBSCRIBER_BACKLOG_BYTES;
      hub.add('session-secret-id', viewer, DECLARES_NOTHING);
      hub.publish('session-secret-id', EVENT);
      assert.equal(viewer.terminated, 1);
    };

    cutOne();
    cutOne();
    context.mock.timers.tick(59_999);
    cutOne();

    assert.equal(lines.length, 1);

    context.mock.timers.tick(1);
    cutOne();

    assert.deepEqual(
      lines.map(([details]) => details),
      [
        { terminated: 1, backlogLimitBytes: MAX_SUBSCRIBER_BACKLOG_BYTES },
        { terminated: 3, backlogLimitBytes: MAX_SUBSCRIBER_BACKLOG_BYTES },
      ],
    );
    assert.ok(!JSON.stringify(lines).includes('session-secret-id'));
  });

  it('cuts all the same with no log named, and a log that throws does not fail the publish', () => {
    const hub = new RealtimeHub();
    const first = recorder();

    first.bufferedAmount = MAX_SUBSCRIBER_BACKLOG_BYTES;
    hub.add('session-a', first, DECLARES_NOTHING);
    hub.publish('session-a', EVENT);
    assert.equal(first.terminated, 1);

    const throwing = new RealtimeHub();
    const second = recorder();
    const healthy = recorder();

    throwing.reportTo({
      warn() {
        throw new Error('the log is gone');
      },
    });
    second.bufferedAmount = MAX_SUBSCRIBER_BACKLOG_BYTES;
    throwing.add('session-a', second, DECLARES_NOTHING);
    throwing.add('session-a', healthy, DECLARES_NOTHING);

    assert.doesNotThrow(() => throwing.publish('session-a', EVENT));
    assert.equal(second.terminated, 1);
    assert.equal(healthy.received.length, 1);
  });

  /**
   * The largest `session.updated` a valid session with no response rules
   * can publish fits twice under the bound, so a viewer that has read
   * everything is never cut by one, and one on a slow link survives a save
   * followed by `Run again`. It is a response at every limit of D101 whose body
   * JSON writes six bytes a character, kept as the custom response and answered
   * as the response, and a queue as large as the 1 MiB body of `PUT .../queue`
   * admits written the same way; and beside it the ordinary full queue of
   * `testing/full-queue.ts`. A change of those limits that breaks this fails
   * here.
   */
  it('fits the largest valid session.updated of a session without rules twice under the bound', () => {
    const response = parseResponse(escapedFullResponse());
    const queueBody = largestQueueBody();

    assert.ok(Buffer.byteLength(queueBody) <= MAX_BODY_BYTES);

    const steps = parseQueueBody(queueBody);

    for (const queue of [steps, ordinaryFullQueue()]) {
      const bytes = Buffer.byteLength(
        JSON.stringify(
          updatedOf({
            response,
            customResponse: response,
            queue: { steps: queue, next: 1, total: queue.length },
            rules: [],
          }),
        ),
      );

      assert.ok(2 * bytes <= MAX_SUBSCRIBER_BACKLOG_BYTES, `${bytes} bytes`);

      if (queue === steps) {
        // The case the bound is chosen for: 1,867,866 bytes, about 1.8 MiB, each
        // of its twelve responses carrying `"template":false` (D251).
        assert.ok(bytes > 1.7 * 1024 * 1024, `${bytes} bytes`);
      }
    }
  });

  /**
   * With response rules as large as the 1 MiB body of `PUT .../rules` admits,
   * written the same way, beside that response and that queue, the largest
   * valid `session.updated` is about 2.8 MiB, 2,916,765 bytes: it fits once
   * under the bound, so a viewer that has read everything is still never cut
   * by one, and two of them in a row cut a viewer that has read neither,
   * which reconnects and reads the session again (D246, restating D205 point
   * 13), each of its 32 responses carrying `"template":false` (D251). So
   * does the ordinary case of fourteen rules at every limit of D101 in
   * ordinary text. A change of those limits that breaks this fails here.
   */
  it('fits the largest valid session.updated with rules once under the bound', () => {
    const response = parseResponse(escapedFullResponse());
    const steps = parseQueueBody(largestQueueBody());
    const rulesBody = largestRulesBody();

    assert.ok(Buffer.byteLength(rulesBody) <= MAX_BODY_BYTES);

    for (const rules of [parseRulesBody(rulesBody), ordinaryFullRules()]) {
      const bytes = Buffer.byteLength(
        JSON.stringify(
          updatedOf({
            response,
            customResponse: response,
            queue: { steps, next: 1, total: steps.length },
            rules,
          }),
        ),
      );

      assert.ok(bytes <= MAX_SUBSCRIBER_BACKLOG_BYTES, `${bytes} bytes`);
      // The case the restatement describes: about 2.8 MiB, two over the bound.
      assert.ok(bytes > 2.7 * 1024 * 1024, `${bytes} bytes`);
      assert.ok(2 * bytes > MAX_SUBSCRIBER_BACKLOG_BYTES, `${bytes} bytes`);
    }
  });
});

/** A `session.updated` carrying `state`. */
function updatedOf(state: SessionResponseState): ServerEvent {
  return { type: 'session.updated', data: state };
}

/** A response state whose custom body is a run of `a` about `bytes` long. */
function stateOfBytes(bytes: number): SessionResponseState {
  const custom = { status: 200, headers: [], body: 'a'.repeat(bytes), delayMs: 0, template: false };

  return { response: null, customResponse: custom, queue: null, rules: [] };
}
