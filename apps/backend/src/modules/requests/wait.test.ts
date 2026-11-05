/**
 * Unit tests for the long-poll's waiting (D200), with the real realtime hub
 * and reads the test answers by hand. No database, no sockets: every order of
 * events a wait can meet is forced here - announcements during a read, a
 * clear, a deletion, the time running out, the client leaving, the shutdown -
 * and `request-wait.test.ts` runs the same against the database.
 */
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { WsCloseCode, type ServerEvent } from '@webhook-inspector/shared';
import { AppError, requestNotFound, sessionExpired } from '../../errors/app-error.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { withinBound } from '../../testing/timing.ts';
import { PendingWaits, waitForList } from './wait.ts';

const SESSION = 'session-a';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });

  return { promise, resolve, reject };
}

/** A read the test answers: every call is kept, to be resolved or rejected by hand. */
function scripted(): { calls: Deferred<string[]>[]; read: () => Promise<string[]> } {
  const calls: Deferred<string[]>[] = [];

  return {
    calls,
    read: () => {
      const call = deferred<string[]>();

      calls.push(call);

      return call.promise;
    },
  };
}

function captured(id: string): ServerEvent {
  return {
    type: 'request.received',
    data: {
      id,
      method: 'POST',
      receivedAt: '2026-10-04T09:00:00.000Z',
      bodySize: 0,
      sourceIp: null,
      path: '/s/x',
      response: null,
    },
  };
}

/** Timers this process holds, which a wait adds one to while it waits. */
function timeouts(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
}

/** Lets every promise already settled run its reactions. */
async function settle(): Promise<void> {
  await nextTurn();
  await nextTurn();
}

/** A wait's outcome as a value, so that a test can look at it before it has one. */
function observe<T>(promise: Promise<T>): { readonly outcome: { value?: T; error?: unknown } } {
  const outcome: { value?: T; error?: unknown } = {};

  promise.then(
    (value) => {
      outcome.value = value;
    },
    (error: unknown) => {
      outcome.error = error;
    },
  );

  return { outcome };
}

interface Started {
  hub: RealtimeHub;
  waits: PendingWaits;
  controller: AbortController;
  first: ReturnType<typeof scripted>;
  again: ReturnType<typeof scripted>;
  result: Promise<string[] | null>;
}

function start(
  options: {
    hub?: RealtimeHub;
    waits?: PendingWaits;
    sessionId?: string;
    waitMs?: number;
    controller?: AbortController;
  } = {},
): Started {
  const hub = options.hub ?? new RealtimeHub();
  const waits = options.waits ?? new PendingWaits();
  const controller = options.controller ?? new AbortController();
  const first = scripted();
  const again = scripted();
  const result = waitForList<string>({
    hub,
    waits,
    sessionId: options.sessionId ?? SESSION,
    waitMs: options.waitMs ?? 30_000,
    signal: controller.signal,
    first: first.read,
    again: again.read,
  });

  return { hub, waits, controller, first, again, result };
}

/** Asserts that nothing of a wait is left: subscription, place among the waits, timer. */
function assertLeft(hub: RealtimeHub, waits: PendingWaits, timersBefore: number): void {
  assert.equal(hub.countFor(SESSION), 0, 'a subscriber is left in the hub');
  assert.equal(waits.size, 0, 'a wait is left pending');
  assert.equal(timeouts(), timersBefore, 'a timer is left');
}

describe('waitForList', () => {
  it('answers a first read that is not empty at once, and leaves nothing behind', async () => {
    const timersBefore = timeouts();
    const { hub, waits, first, again, result } = start();

    first.calls[0]?.resolve(['r1']);

    assert.deepEqual(await result, ['r1']);
    assert.equal(again.calls.length, 0);
    assertLeft(hub, waits, timersBefore);
  });

  it('subscribes before the first read, so a capture after it began is announced', async () => {
    const hub = new RealtimeHub();
    let subscribedAtFirstRead = -1;
    const again = scripted();
    const result = waitForList<string>({
      hub,
      waits: new PendingWaits(),
      sessionId: SESSION,
      waitMs: 30_000,
      signal: new AbortController().signal,
      first: async () => {
        subscribedAtFirstRead = hub.countFor(SESSION);
        // Captured and announced while the first read is under way, after
        // its snapshot: it read nothing.
        hub.publish(SESSION, captured('r1'));

        return [];
      },
      again: again.read,
    });

    assert.equal(subscribedAtFirstRead, 1);
    await settle();
    assert.equal(again.calls.length, 1, 'the announcement made during the first read was lost');
    again.calls[0]?.resolve(['r1']);
    assert.deepEqual(await result, ['r1']);
  });

  it('holds an empty answer until a capture is announced, then reads again', async () => {
    const timersBefore = timeouts();
    const { hub, waits, first, again, result } = start();
    const { outcome } = observe(result);

    first.calls[0]?.resolve([]);
    await settle();
    assert.equal(again.calls.length, 0);
    assert.deepEqual(outcome, {});
    assert.equal(hub.countFor(SESSION), 1);
    assert.equal(waits.size, 1);
    assert.equal(timeouts(), timersBefore + 1);

    hub.publish(SESSION, captured('r1'));
    assert.equal(again.calls.length, 1);
    again.calls[0]?.resolve(['r1']);

    assert.deepEqual(await result, ['r1']);
    assertLeft(hub, waits, timersBefore);
  });

  it('keeps waiting when a read after an announcement is still empty', async () => {
    const { hub, first, again, result } = start();
    const { outcome } = observe(result);

    first.calls[0]?.resolve([]);
    await settle();
    hub.publish(SESSION, captured('r1'));
    again.calls[0]?.resolve([]);
    await settle();
    assert.deepEqual(outcome, {});

    hub.publish(SESSION, captured('r2'));
    assert.equal(again.calls.length, 2);
    again.calls[1]?.resolve(['r2']);
    assert.deepEqual(await result, ['r2']);
  });

  it('folds announcements during a read into one more read, and answers once', async () => {
    const { hub, first, again, result } = start();

    first.calls[0]?.resolve([]);
    await settle();
    hub.publish(SESSION, captured('r1'));

    for (let index = 0; index < 1000; index += 1) {
      hub.publish(SESSION, captured(`burst-${index}`));
    }

    assert.equal(again.calls.length, 1, 'a read was started while one was under way');
    again.calls[0]?.resolve([]);
    await settle();
    assert.equal(again.calls.length, 2, 'the announcements during the read were not read');

    hub.publish(SESSION, captured('r2'));
    again.calls[1]?.resolve(['r1', 'r2']);
    assert.deepEqual(await result, ['r1', 'r2']);

    hub.publish(SESSION, captured('r3'));
    await settle();
    assert.equal(again.calls.length, 2, 'a settled wait read again');
  });

  /**
   * Milliseconds a burst may take to be announced to a wait whose read is
   * under way, the fastest of up to five runs (`withinBound`, D203): 1500,
   * at every size. Until #412 one run decided, held to 1000 ms, and a loaded
   * run of the backend suite once took the burst of 100,000 over it with
   * nothing wrong (F-31). The 100,000 take 212 to 229 ms at best of five
   * alone and up to 762 ms beside the full backend suite and eight busy
   * loops, where one run took up to 1816 ms: 1500 is about twice that
   * fastest of five. A hub or a wait quadratic in the announcements took
   * 3.3 s and more for them alone, 2.2 times the bound and more - the
   * cheapest form measured sums, on every event, the bytes of all the hub
   * delivered: over the bound on every run. At 1,000 and 10,000 the bound
   * tells no quadratic form apart; 100,000 does.
   *
   * Every run is announced to the same wait, during the same read: the first
   * run's first announcement starts that read, which nothing settles before
   * the runs end, so each run after it finds the wait reading, as the first
   * leaves it, and all of them together are still one more read.
   */
  const BURST_BOUND_MS = 1_500;

  for (const count of [1_000, 10_000, 100_000]) {
    it(`takes a burst of ${count} announcements during one read as one more read, within 1.5 s`, async () => {
      const { hub, first, again, result } = start();

      first.calls[0]?.resolve([]);
      await settle();

      withinBound(BURST_BOUND_MS, () => {
        for (let index = 0; index < count; index += 1) {
          hub.publish(SESSION, captured(`r${index}`));
        }
      });

      assert.equal(again.calls.length, 1);
      again.calls[0]?.resolve([]);
      await settle();
      assert.equal(again.calls.length, 2);
      again.calls[1]?.resolve(['r0']);
      assert.deepEqual(await result, ['r0']);
    });
  }

  it('ends with [] at once on a clear, without a read', async () => {
    const timersBefore = timeouts();
    const { hub, waits, first, again, result } = start();

    first.calls[0]?.resolve([]);
    await settle();
    hub.publish(SESSION, { type: 'requests.cleared' });

    assert.deepEqual(await result, []);
    assert.equal(again.calls.length, 0);
    assertLeft(hub, waits, timersBefore);
  });

  it('ends with [] on a clear during a read, and drops what that read returns later', async () => {
    const { hub, first, again, result } = start();

    first.calls[0]?.resolve([]);
    await settle();
    hub.publish(SESSION, captured('r1'));
    hub.publish(SESSION, { type: 'requests.cleared' });

    assert.deepEqual(await result, []);
    again.calls[0]?.resolve(['r1']);
    await settle();
    assert.equal(again.calls.length, 1);
  });

  it('ends with [] on a clear during the first read', async () => {
    const { hub, first, result } = start();

    hub.publish(SESSION, { type: 'requests.cleared' });
    assert.deepEqual(await result, []);
    first.calls[0]?.resolve(['gone by now']);
    await settle();
  });

  it('is not ended by a deleted request, nor by events of other types or other sessions', async () => {
    const { hub, first, again, result, controller } = start();
    const { outcome } = observe(result);

    first.calls[0]?.resolve([]);
    await settle();
    hub.publish(SESSION, { type: 'request.deleted', data: { id: 'r0' } });
    hub.publish(SESSION, {
      type: 'response.recorded',
      data: { id: 'r0', response: { state: 'sent', status: 200, queueStep: null, rule: null } },
    });
    hub.publish(SESSION, {
      type: 'session.updated',
      data: { response: null, customResponse: null, queue: null, rules: [] },
    });
    hub.publish('session-b', captured('elsewhere'));
    hub.publish('session-b', { type: 'requests.cleared' });
    await settle();

    assert.equal(again.calls.length, 0);
    assert.deepEqual(outcome, {});
    controller.abort();
    assert.equal(await result, null);
  });

  it('rejects with 404 / 1001 at once when the session is deleted, and leaves nothing', async () => {
    const timersBefore = timeouts();
    const { hub, waits, first, result } = start();

    first.calls[0]?.resolve([]);
    await settle();
    hub.closeSession(SESSION, WsCloseCode.SESSION_NOT_FOUND, 'Session not found');

    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.errorCode, 1001);

      return true;
    });
    assertLeft(hub, waits, timersBefore);
  });

  it('when the hub asks it to read again, reads a last time and answers what that read finds (D221)', async () => {
    const timersBefore = timeouts();
    const { hub, waits, first, again, result } = start();

    first.calls[0]?.resolve([]);
    await settle();
    hub.reload(SESSION, hub.snapshot(SESSION));
    assert.equal(again.calls.length, 1);
    again.calls[0]?.resolve([]);
    assert.deepEqual(await result, []);
    assertLeft(hub, waits, timersBefore);
  });

  it('when the time runs out, reads a last time and answers what that read finds', async () => {
    for (const found of [[], ['late']]) {
      const timersBefore = timeouts();
      const { hub, waits, first, again, result } = start({ waitMs: 30 });

      first.calls[0]?.resolve([]);

      while (again.calls.length === 0) {
        await nextTurn();
      }

      again.calls[0]?.resolve(found);
      assert.deepEqual(await result, found);
      assertLeft(hub, waits, timersBefore);
    }
  });

  it('when the time runs out, answers the last read refusal: an expired session is 410 / 1002', async () => {
    const { first, again, result } = start({ waitMs: 10 });

    first.calls[0]?.resolve([]);

    while (again.calls.length === 0) {
      await nextTurn();
    }

    again.calls[0]?.reject(sessionExpired());
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.errorCode, 1002);

      return true;
    });
  });

  it('follows a read the time ran out during with one last read', async () => {
    const { hub, first, again, result } = start({ waitMs: 20 });
    const { outcome } = observe(result);

    first.calls[0]?.resolve([]);
    await settle();
    hub.publish(SESSION, captured('r1'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(again.calls.length, 1, 'a read was started while one was under way');

    again.calls[0]?.resolve([]);
    await settle();
    assert.deepEqual(outcome, {});
    assert.equal(again.calls.length, 2);

    // The last read answers, empty or not, whatever is announced meanwhile.
    hub.publish(SESSION, captured('r2'));
    again.calls[1]?.resolve([]);
    assert.deepEqual(await result, []);
    assert.equal(again.calls.length, 2);
  });

  it('ends with null at once when the client leaves, with its subscription and timer gone', async () => {
    const timersBefore = timeouts();
    const { hub, waits, controller, first, again, result } = start();

    first.calls[0]?.resolve([]);
    await settle();
    assert.equal(timeouts(), timersBefore + 1);
    controller.abort();

    assert.equal(await result, null);
    assert.equal(again.calls.length, 0);
    assertLeft(hub, waits, timersBefore);
  });

  it('ends with null when the client leaves during a read, and drops that read', async () => {
    const timersBefore = timeouts();
    const { hub, waits, controller, first, again, result } = start();

    first.calls[0]?.resolve([]);
    await settle();
    hub.publish(SESSION, captured('r1'));
    controller.abort();

    assert.equal(await result, null);
    assertLeft(hub, waits, timersBefore);
    again.calls[0]?.resolve(['r1']);
    await settle();
    hub.publish(SESSION, captured('r2'));
    await settle();
    assert.equal(again.calls.length, 1);
  });

  it('ends with null when the client leaves during the first read', async () => {
    const timersBefore = timeouts();
    const { hub, waits, controller, first, result } = start();

    controller.abort();
    assert.equal(await result, null);
    assertLeft(hub, waits, timersBefore);
    first.calls[0]?.resolve(['r1']);
    await settle();
  });

  it('reads nothing and registers nothing for a client already gone', async () => {
    const timersBefore = timeouts();
    const controller = new AbortController();

    controller.abort();

    const { hub, waits, first, result } = start({ controller });

    assert.equal(await result, null);
    assert.equal(first.calls.length, 0);
    assertLeft(hub, waits, timersBefore);
  });

  it('rejects with what the first read refuses, and leaves nothing', async () => {
    const timersBefore = timeouts();
    const { hub, waits, first, result } = start();

    first.calls[0]?.reject(requestNotFound());
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.errorCode, 1003);

      return true;
    });
    assertLeft(hub, waits, timersBefore);
  });

  it('rejects with what a later read fails with', async () => {
    const timersBefore = timeouts();
    const { hub, waits, first, again, result } = start();

    first.calls[0]?.resolve([]);
    await settle();
    hub.publish(SESSION, captured('r1'));
    again.calls[0]?.reject(new Error('connection lost'));

    await assert.rejects(result, /connection lost/);
    assertLeft(hub, waits, timersBefore);
  });
});

describe('PendingWaits', () => {
  it('runs every pending wait out at once on close, each after one last read', async () => {
    const hub = new RealtimeHub();
    const waits = new PendingWaits();
    const timersBefore = timeouts();
    const started = [
      start({ hub, waits }),
      start({ hub, waits }),
      start({ hub, waits, sessionId: 'session-b' }),
    ];

    for (const wait of started) {
      wait.first.calls[0]?.resolve([]);
    }

    await settle();
    assert.equal(waits.size, 3);
    assert.equal(timeouts(), timersBefore + 3);

    const closedAt = performance.now();

    waits.close();

    for (const wait of started) {
      assert.equal(wait.again.calls.length, 1);
      wait.again.calls[0]?.resolve([]);
    }

    for (const wait of started) {
      assert.deepEqual(await wait.result, []);
    }

    assert.ok(performance.now() - closedAt < 1000);
    assert.equal(waits.size, 0);
    assert.equal(hub.countFor('session-b'), 0);
    assertLeft(hub, waits, timersBefore);
  });

  it('runs a wait out during its first read, which a last read then follows', async () => {
    const { waits, first, again, result } = start();

    waits.close();
    assert.equal(again.calls.length, 0, 'a read was started before the first ended');
    first.calls[0]?.resolve([]);
    await settle();
    assert.equal(again.calls.length, 1);
    again.calls[0]?.resolve([]);
    assert.deepEqual(await result, []);
  });

  it('runs out a wait that starts once it is closed: the first read is its answer', async () => {
    const waits = new PendingWaits();

    waits.close();

    for (const found of [[], ['r1']]) {
      const timersBefore = timeouts();
      const { hub, first, again, result } = start({ waits });

      first.calls[0]?.resolve(found);
      assert.deepEqual(await result, found);
      assert.equal(again.calls.length, 0);
      assertLeft(hub, waits, timersBefore);
    }
  });
});

describe('many waits at once', () => {
  it('answers 200 waits on one session and 200 across sessions from one announcement each, and leaves nothing', async () => {
    const hub = new RealtimeHub();
    const waits = new PendingWaits();
    const timersBefore = timeouts();
    const same = Array.from({ length: 200 }, () => start({ hub, waits }));
    const across = Array.from({ length: 200 }, (_, index) =>
      start({ hub, waits, sessionId: `session-${index}` }),
    );
    const all = [...same, ...across];

    for (const wait of all) {
      wait.first.calls[0]?.resolve([]);
    }

    await settle();
    assert.equal(hub.countFor(SESSION), 200);
    assert.equal(waits.size, 400);
    assert.equal(timeouts(), timersBefore + 400);

    // A quarter of the clients leave before anything arrives.
    const leaving = all.filter((_, index) => index % 4 === 0);

    for (const wait of leaving) {
      wait.controller.abort();
    }

    hub.publish(SESSION, captured('r-a'));

    for (let index = 0; index < 200; index += 1) {
      hub.publish(`session-${index}`, captured(`r-${index}`));
    }

    for (const [index, wait] of all.entries()) {
      if (index % 4 === 0) {
        assert.equal(wait.again.calls.length, 0);
        assert.equal(await wait.result, null);
      } else {
        assert.equal(wait.again.calls.length, 1);
        wait.again.calls[0]?.resolve(['found']);
        assert.deepEqual(await wait.result, ['found']);
      }
    }

    assert.equal(waits.size, 0);

    for (let index = 0; index < 200; index += 1) {
      assert.equal(hub.countFor(`session-${index}`), 0);
    }

    assertLeft(hub, waits, timersBefore);
  });
});
