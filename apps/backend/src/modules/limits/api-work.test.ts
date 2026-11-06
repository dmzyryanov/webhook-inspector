/**
 * The gate in front of the work of `/api` and `/mcp` (D244), without a
 * server: three handlers at work at once by default, the next waiting, never
 * refused; the waiting served round robin by address; a call whose client
 * goes while it waits dropped, its handler never run; the slot given back
 * once on every path - the answer begun, the handler thrown, the client gone
 * before or while it works, a hijack; and a wait's slot given back while it
 * waits and taken again, in turn, for its reads; a read under way - a
 * wait's, with the real `waitForList`, or a streamed answer's - keeping its
 * slot until it settles, whatever ends the call meanwhile, and no other call
 * let past the bound before; and a change's slot given back before it joins
 * its session's line, its turn run without one. `api-work-routes.test.ts`
 * holds the same over the listeners.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { WsCloseCode, type ServerEvent } from '@webhook-inspector/shared';
import { sessionNotFound } from '../../errors/app-error.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { PendingWaits, waitForList } from '../requests/wait.ts';
import {
  API_WORK_SLOTS,
  createApiWork,
  createApiWorkSlots,
  inSessionLine,
  NO_WAIT_SLOT,
} from './api-work.ts';

interface FakeCall {
  request: FastifyRequest;
  reply: FastifyReply & { hijacked: boolean };
  response: EventEmitter & { destroyed: boolean; writableEnded: boolean };
  logged: string[];
}

/** What the gate reads of a call: its address, its log, its response's `close`, and the reply's `sent`. */
function fakeCall(ip = '192.0.2.1'): FakeCall {
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  const logged: string[] = [];
  const reply = {
    raw: response,
    hijacked: false,
    get sent() {
      return this.hijacked || response.writableEnded;
    },
    hijack() {
      this.hijacked = true;

      return this;
    },
  };

  return {
    request: { ip, log: { info: (message: string) => logged.push(message) } } as never,
    reply: reply as never,
    response,
    logged,
  };
}

/** Its client leaves: the response closes before it has ended. */
function leave(call: FakeCall): void {
  call.response.destroyed = true;
  call.response.emit('close');
}

/** Its answer begins and is written whole, as Fastify answers a handler's value or error. */
function answered(work: ReturnType<typeof gate>, call: FakeCall): void {
  work.answerBegins(call.request);
  call.response.writableEnded = true;
  call.response.emit('close');
}

/** A capture announced to `sessionId`'s subscribers, as the realtime listener delivers it. */
function capturedIn(id: string): ServerEvent {
  return {
    type: 'request.received',
    data: {
      id,
      method: 'POST',
      receivedAt: '2026-10-23T09:00:00.000Z',
      bodySize: 0,
      sourceIp: null,
      path: '/s/x',
      response: null,
    },
  };
}

/** A promise settled from outside, as a handler waiting for the database is. */
function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

/** Runs a wrapped handler as Fastify runs a route's, with the instance as `this`. */
function run(handler: RouteHandlerMethod, call: FakeCall): Promise<unknown> {
  return (
    handler as unknown as (
      this: FastifyInstance,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>
  ).call({} as FastifyInstance, call.request, call.reply);
}

/** Lets every promise job queued so far run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function gate(limit?: number) {
  return createApiWork(createApiWorkSlots(limit), (request) => request.ip);
}

/** A handler that records its start and waits until the test lets it settle. */
function heldHandler(started: string[], name: string) {
  const done = deferred();
  const handler = (async () => {
    started.push(name);

    return done.promise;
  }) as unknown as RouteHandlerMethod;

  return { handler, finish: () => done.resolve(name) };
}

describe('the gate in front of the API’s work (D244)', () => {
  it('lets three handlers work at once by default and makes the fourth wait, never refusing it', async () => {
    assert.equal(API_WORK_SLOTS, 3);

    const work = gate();
    const started: string[] = [];
    const names = Array.from({ length: API_WORK_SLOTS + 1 }, (_, index) => `h${index}`);
    const held = names.map((name) => heldHandler(started, name));
    const calls = held.map(() => fakeCall());
    const answers = held.map((each, index) =>
      run(work.gated(each.handler), calls[index] as FakeCall),
    );

    await settle();
    assert.deepEqual(started, names.slice(0, API_WORK_SLOTS));
    assert.equal(work.slots.taken, API_WORK_SLOTS);
    assert.equal(work.slots.waiting, 1);

    // The first answer begins: its slot goes to the one waiting.
    work.answerBegins((calls[0] as FakeCall).request);
    await settle();
    assert.deepEqual(started.at(-1), names.at(-1));
    assert.equal(work.slots.taken, API_WORK_SLOTS);
    assert.equal(work.slots.waiting, 0);

    for (const [index, each] of held.entries()) {
      each.finish();
      work.answerBegins((calls[index] as FakeCall).request);
    }

    assert.deepEqual(await Promise.all(answers), names);
    assert.equal(work.slots.taken, 0);
  });

  it('serves the waiting round robin by address, in order within one', async () => {
    const work = gate(1);
    const started: string[] = [];
    const order = [
      ['a0', '192.0.2.1'],
      ['a1', '192.0.2.1'],
      ['a2', '192.0.2.1'],
      ['a3', '192.0.2.1'],
      ['b1', '192.0.2.2'],
      ['c1', '192.0.2.3'],
      ['b2', '192.0.2.2'],
    ] as const;
    const held = new Map(
      order.map(([name, ip]) => [name, { ...heldHandler(started, name), call: fakeCall(ip) }]),
    );
    const answers = [...held.values()].map((each) => run(work.gated(each.handler), each.call));

    await settle();
    assert.deepEqual(started, ['a0']);
    assert.equal(work.slots.waiting, 6);
    assert.equal(work.slots.keys, 3);

    // One slot: each answer begun lets exactly the next in turn start.
    for (let turn = 1; turn <= order.length; turn += 1) {
      const current = held.get(started.at(-1) as (typeof order)[number][0]);

      current?.finish();
      work.answerBegins(current?.call.request as FastifyRequest);
      await settle();
      assert.equal(started.length, Math.min(turn + 1, order.length));
    }

    await Promise.all(answers);
    assert.deepEqual(started, ['a0', 'a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
    assert.equal(work.slots.taken, 0);
  });

  it('drops a call whose client goes while it waits: its handler never runs and nothing is written', async () => {
    const work = gate(1);
    const started: string[] = [];
    const first = { ...heldHandler(started, 'first'), call: fakeCall() };
    const gone = { ...heldHandler(started, 'gone'), call: fakeCall('192.0.2.2') };
    const next = { ...heldHandler(started, 'next'), call: fakeCall('192.0.2.3') };
    const answers = [first, gone, next].map((each) => run(work.gated(each.handler), each.call));

    await settle();
    assert.equal(work.slots.waiting, 2);

    leave(gone.call);
    assert.equal(await answers[1], gone.call.reply, 'the dropped call was not hijacked');
    assert.equal(gone.call.reply.hijacked, true);
    assert.deepEqual(gone.call.logged, ['Request aborted by the client']);
    assert.equal(work.slots.waiting, 1);

    // The slot it never took goes to the call after it.
    first.finish();
    work.answerBegins(first.call.request);
    await settle();
    assert.deepEqual(started, ['first', 'next']);

    next.finish();
    work.answerBegins(next.call.request);
    await Promise.all(answers);
    assert.equal(work.slots.taken, 0);
    assert.equal(work.slots.waiting, 0);
  });

  it('never runs the handler of a call whose client went before it started, with every slot free', async () => {
    const work = gate();
    const started: string[] = [];
    const gone = { ...heldHandler(started, 'gone'), call: fakeCall() };

    gone.call.response.destroyed = true;
    await run(work.gated(gone.handler), gone.call);
    assert.deepEqual(started, []);
    assert.equal(gone.call.reply.hijacked, true);
    assert.equal(work.slots.taken, 0);
  });

  it('gives the slot back once when the answer begins, the handler settles and the response closes', async () => {
    const work = gate(1);
    const call = fakeCall();
    const answer = run(work.gated((async () => 'answer') as unknown as RouteHandlerMethod), call);

    assert.equal(await answer, 'answer');
    // The handler settled with a value Fastify has yet to send: still held.
    assert.equal(work.slots.taken, 1);

    work.answerBegins(call.request);
    assert.equal(work.slots.taken, 0);

    // A second call takes it; nothing that happens to the first gives it back again.
    const other = fakeCall('192.0.2.2');
    const started: string[] = [];
    const held = heldHandler(started, 'other');
    const otherAnswer = run(work.gated(held.handler), other);

    await settle();
    assert.equal(work.slots.taken, 1);
    work.answerBegins(call.request);
    call.response.emit('close');
    assert.equal(work.slots.taken, 1);

    held.finish();
    work.answerBegins(other.request);
    await otherAnswer;
    assert.equal(work.slots.taken, 0);
  });

  it('gives the slot back once when the handler throws and the error is answered', async () => {
    const work = gate(1);
    const call = fakeCall();

    await assert.rejects(
      run(
        work.gated((async () => {
          throw new Error('the statement failed');
        }) as unknown as RouteHandlerMethod),
        call,
      ),
      /the statement failed/,
    );
    assert.equal(work.slots.taken, 1, 'given back before the error was answered');

    work.answerBegins(call.request);
    work.answerBegins(call.request);
    call.response.emit('close');
    assert.equal(work.slots.taken, 0);

    // The slot is whole again: one call takes it, the next waits.
    const started: string[] = [];
    const first = heldHandler(started, 'first');
    const second = heldHandler(started, 'second');
    const a = fakeCall();
    const b = fakeCall();
    const answers = [run(work.gated(first.handler), a), run(work.gated(second.handler), b)];

    await settle();
    assert.deepEqual(started, ['first']);
    first.finish();
    work.answerBegins(a.request);
    await settle();
    second.finish();
    work.answerBegins(b.request);
    await Promise.all(answers);
    assert.equal(work.slots.taken, 0);
  });

  it('keeps the slot of a handler working for a client gone until it settles, then gives it back once', async () => {
    const work = gate(1);
    const started: string[] = [];
    const working = heldHandler(started, 'working');
    const call = fakeCall();
    const answer = run(work.gated(working.handler), call);

    await settle();
    leave(call);
    // Its statement still runs: the slot is not free for another's.
    assert.equal(work.slots.taken, 1);

    const next = { ...heldHandler(started, 'next'), call: fakeCall('192.0.2.2') };
    const nextAnswer = run(work.gated(next.handler), next.call);

    await settle();
    assert.deepEqual(started, ['working']);

    working.finish();
    await answer;
    await settle();
    assert.deepEqual(started, ['working', 'next']);
    assert.equal(work.slots.taken, 1);

    next.finish();
    work.answerBegins(next.call.request);
    await nextAnswer;
    assert.equal(work.slots.taken, 0);
  });

  it('gives the slot back once a handler hijacks its reply', async () => {
    const work = gate(1);
    const call = fakeCall();

    await run(
      work.gated((async (_request: FastifyRequest, reply: FastifyReply) =>
        reply.hijack()) as unknown as RouteHandlerMethod),
      call,
    );
    assert.equal(work.slots.taken, 0);
    call.response.emit('close');
    assert.equal(work.slots.taken, 0);
  });

  it('lets a wait give its slot back while it waits and take one again, in turn, for its next read', async () => {
    const work = gate(1);
    const started: string[] = [];
    const call = fakeCall();
    const waited = deferred();
    let reads = 0;
    const answer = run(
      work.gated((async (request: FastifyRequest) => {
        const slot = work.waitSlot(request);

        // The first read, in the handler's own slot.
        assert.equal(await slot.enter(), true);
        reads += 1;
        slot.leave();
        await waited.promise;
        // The next read, in turn.
        assert.equal(await slot.enter(), true);
        reads += 1;

        return 'listed';
      }) as unknown as RouteHandlerMethod),
      call,
    );

    await settle();
    assert.equal(reads, 1);
    assert.equal(work.slots.taken, 0, 'the wait kept its slot while it waited');

    // Another call works meanwhile, and the wait's read waits for its slot.
    const other = { ...heldHandler(started, 'other'), call: fakeCall('192.0.2.2') };
    const otherAnswer = run(work.gated(other.handler), other.call);

    await settle();
    assert.deepEqual(started, ['other']);
    waited.resolve('captured');
    await settle();
    assert.equal(reads, 1);
    assert.equal(work.slots.waiting, 1);

    other.finish();
    work.answerBegins(other.call.request);
    await otherAnswer;
    assert.equal(await answer, 'listed');
    assert.equal(reads, 2);
    assert.equal(work.slots.taken, 1, 'the answer after the last read is begun in the slot');

    work.answerBegins(call.request);
    assert.equal(work.slots.taken, 0);
  });

  it('tells a wait whose client went while it waited for a read that nothing more is read', async () => {
    const work = gate(1);
    const started: string[] = [];
    const call = fakeCall();
    const turn: boolean[] = [];
    const left = deferred();
    const goOn = deferred();
    const answer = run(
      work.gated((async (request: FastifyRequest) => {
        const slot = work.waitSlot(request);

        slot.leave();
        left.resolve('left');
        await goOn.promise;
        turn.push(await slot.enter());

        return null;
      }) as unknown as RouteHandlerMethod),
      call,
    );

    await left.promise;

    // It gave its slot back; another takes it, and the wait's next read waits.
    const other = { ...heldHandler(started, 'other'), call: fakeCall('192.0.2.2') };
    const otherAnswer = run(work.gated(other.handler), other.call);

    await settle();
    assert.deepEqual(started, ['other']);
    goOn.resolve('announced');
    await settle();
    assert.equal(work.slots.waiting, 1);

    leave(call);
    await answer;
    assert.deepEqual(turn, [false]);
    assert.equal(work.slots.waiting, 0);

    other.finish();
    work.answerBegins(other.call.request);
    await otherAnswer;
    assert.equal(work.slots.taken, 0);
  });

  // A wait's read under way when its wait ended - and its handler with it -
  // keeps its slot until its statement settles: freed sooner, the slot let
  // another call in past the bound while the statement went on (#243). Each
  // ending, during the first read, in the handler's own slot, and during a
  // later one, in a slot taken in turn; the real `waitForList`, as the list's
  // `wait` and `wait_for_request` run it.
  const endings = [
    { name: 'its client leaving', end: (call: FakeCall) => leave(call) },
    {
      name: 'a clear',
      end: (_call: FakeCall, hub: RealtimeHub) =>
        hub.publish('session', { type: 'requests.cleared' }),
    },
    {
      name: 'the session’s deletion',
      end: (_call: FakeCall, hub: RealtimeHub) =>
        hub.closeSession('session', WsCloseCode.SESSION_NOT_FOUND, 'Session not found'),
    },
  ];

  for (const ending of endings) {
    for (const later of [false, true]) {
      const which = later
        ? 'a later read, in a slot taken in turn'
        : 'the first read, in the handler’s slot';

      it(`keeps the slot of a wait’s read under way until it settles, ${ending.name} ending the wait during ${which}, and lets no other call past the bound meanwhile`, async () => {
        const work = gate(1);
        const hub = new RealtimeHub();
        const waits = new PendingWaits();
        const call = fakeCall();
        const reads: { resolve: (list: string[]) => void; reject: (error: unknown) => void }[] = [];
        const reader = (): Promise<string[]> =>
          new Promise<string[]>((resolve, reject) => {
            reads.push({ resolve, reject });
          });
        const handler = run(
          work.gated((async (request: FastifyRequest, reply: FastifyReply) => {
            // The client's going, as `clientGone` reads it.
            const gone = new AbortController();

            call.response.once('close', () => {
              if (!call.response.writableEnded) {
                gone.abort();
              }
            });

            const list = await waitForList({
              hub,
              waits,
              sessionId: 'session',
              waitMs: 60_000,
              signal: gone.signal,
              first: reader,
              again: reader,
              slot: work.waitSlot(request),
            });

            return list === null ? reply.hijack() : list;
          }) as unknown as RouteHandlerMethod),
          call,
        );
        const settled = handler.then(
          () => 'answered',
          () => 'refused',
        );

        await settle();
        assert.equal(reads.length, 1);

        if (later) {
          // Nothing yet: the wait goes on holding no slot, until a capture is
          // announced and its next read takes one.
          reads[0]?.resolve([]);
          await settle();
          assert.equal(work.slots.taken, 0);
          hub.publish('session', capturedIn('r1'));
          await settle();
          assert.equal(reads.length, 2);
        }

        assert.equal(work.slots.taken, 1);

        // The wait ends with its read under way, and its handler settles.
        ending.end(call, hub);

        const outcome = await settled;

        assert.equal(outcome, ending.name === 'the session’s deletion' ? 'refused' : 'answered');

        if (!call.response.destroyed) {
          answered(work, call);
        }

        await settle();
        assert.equal(work.slots.taken, 1, 'the slot went back while the read was under way');

        // Another address's call waits for its turn, its handler not started.
        const started: string[] = [];
        const other = heldHandler(started, 'other');
        const otherCall = fakeCall('192.0.2.2');
        const otherAnswer = run(work.gated(other.handler), otherCall);

        await settle();
        assert.deepEqual(started, [], 'another call was let past the bound');
        assert.equal(work.slots.waiting, 1);

        // The read settles - its list dropped, or the deleted session's
        // refusal - and the slot goes to the next call, once.
        const last = reads.at(-1);

        if (ending.name === 'the session’s deletion') {
          last?.reject(sessionNotFound());
        } else {
          last?.resolve(['late']);
        }

        await settle();
        assert.deepEqual(started, ['other']);
        assert.equal(work.slots.taken, 1);
        assert.equal(work.slots.waiting, 0);

        other.finish();
        await otherAnswer;
        answered(work, otherCall);
        assert.equal(work.slots.taken, 0);
        assert.equal(waits.size, 0);
        assert.equal(reads.length, later ? 2 : 1, 'the wait read again after it ended');
      });
    }
  }

  it('keeps the handler’s slot for a read begun in it until the read settles, its answer begun and its response closed meanwhile', async () => {
    const work = gate(1);
    const call = fakeCall();
    const content = deferred();
    let reading: Promise<string> | undefined;

    await run(
      work.gated((async (request: FastifyRequest) => {
        reading = work.inSlot(request, () => content.promise, 'gone');

        return 'head';
      }) as unknown as RouteHandlerMethod),
      call,
    );
    work.answerBegins(call.request);
    leave(call);
    await settle();
    assert.equal(work.slots.taken, 1, 'the slot went back while its read was under way');

    const started: string[] = [];
    const other = heldHandler(started, 'other');
    const otherCall = fakeCall('192.0.2.2');
    const otherAnswer = run(work.gated(other.handler), otherCall);

    await settle();
    assert.deepEqual(started, []);

    content.resolve('content');
    assert.equal(await reading, 'content');
    await settle();
    assert.deepEqual(started, ['other']);

    other.finish();
    await otherAnswer;
    answered(work, otherCall);
    assert.equal(work.slots.taken, 0);
    assert.equal(work.slots.waiting, 0);
  });

  it('takes a slot for each read of an answer streamed after its head, in turn, and reads nothing once its response has closed', async () => {
    const work = gate(1);
    const call = fakeCall();
    const reads: string[] = [];
    let readsFor: ((id: string) => Promise<string>) | undefined;

    // The handler begins its answer and hands its reads to the stream.
    await run(
      work.gated((async (request: FastifyRequest) => {
        readsFor = (id) =>
          work.inSlot(
            request,
            async () => {
              reads.push(id);

              return id;
            },
            'gone',
          );

        return 'head';
      }) as unknown as RouteHandlerMethod),
      call,
    );
    work.answerBegins(call.request);
    assert.equal(work.slots.taken, 0, 'the answer kept its slot past its head');

    // A read takes a slot of its own and gives it back.
    assert.equal(await readsFor?.('first'), 'first');
    assert.equal(work.slots.taken, 0);

    // Another call works: the next read waits its turn.
    const started: string[] = [];
    const other = { ...heldHandler(started, 'other'), call: fakeCall('192.0.2.2') };
    const otherAnswer = run(work.gated(other.handler), other.call);

    await settle();

    const second = readsFor?.('second');

    await settle();
    assert.deepEqual(reads, ['first']);
    assert.equal(work.slots.waiting, 1);

    other.finish();
    work.answerBegins(other.call.request);
    await otherAnswer;
    assert.equal(await second, 'second');
    assert.equal(work.slots.taken, 0);

    // Its client gone, a read waiting for its turn reads nothing.
    const holder = await work.slots.take('the test', new AbortController().signal);
    const third = readsFor?.('third');

    await settle();
    leave(call);
    assert.equal(await third, 'gone');
    assert.deepEqual(reads, ['first', 'second']);
    holder?.();
    assert.equal(await readsFor?.('fourth'), 'gone');
    assert.equal(work.slots.taken, 0);
    assert.equal(work.slots.waiting, 0);
  });

  it('gives a change’s slot back before it joins its session’s line, and runs its turn without one', async () => {
    const work = gate(1);
    const hub = new RealtimeHub();
    const line = deferred();
    // The session's line is held, as a capture in its turn holds it.
    const before = hub.inOrder('session', () => line.promise);
    const turns: string[] = [];
    const change = fakeCall('192.0.2.1');
    const changed = run(
      work.gated((async (request: FastifyRequest) =>
        inSessionLine(hub, 'session', work.waitSlot(request), async () => {
          turns.push('change');

          // Its turn needs no slot: one is held by another call meanwhile.
          return work.slots.taken;
        })) as unknown as RouteHandlerMethod),
      change,
    );

    await settle();
    assert.equal(work.slots.taken, 0, 'a change waiting in its session’s line holds its slot');
    assert.deepEqual(turns, []);

    // Another address's call takes the one slot while the change waits.
    const started: string[] = [];
    const other = heldHandler(started, 'other');
    const otherCall = fakeCall('192.0.2.2');
    const answered = run(work.gated(other.handler), otherCall);

    await settle();
    assert.deepEqual(started, ['other']);
    assert.equal(work.slots.taken, 1);

    // The line drains: the change's turn runs at once, the slot still held.
    line.resolve('capture');
    assert.equal(await before, 'capture');
    assert.equal(await changed, 1);
    assert.deepEqual(turns, ['change']);
    assert.equal(work.slots.waiting, 0);

    work.answerBegins(change.request);
    other.finish();
    await answered;
    work.answerBegins(otherCall.request);
    assert.equal(work.slots.taken, 0);
  });

  it('gives a call outside the gate a wait slot that holds nothing', async () => {
    const work = gate(1);

    assert.equal(work.waitSlot(fakeCall().request), NO_WAIT_SLOT);
    assert.equal(await NO_WAIT_SLOT.enter(), true);
    NO_WAIT_SLOT.leave();
    assert.equal(work.slots.taken, 0);
  });
});
