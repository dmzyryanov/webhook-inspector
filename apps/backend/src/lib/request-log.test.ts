/**
 * The request log's verdicts on their own (#189): what it writes of a request
 * it holds, admits or refuses, with a stand-in for each request and its
 * logger. Over a listener, `modules/limits/rate-limit-log.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RequestLog } from './request-log.ts';

const DEBUG = 20;
const INFO = 30;
const WARN = 40;
const ERROR = 50;

/** A request whose logger records the messages written through it directly. */
function request(written: string[]): { request: FastifyRequest; reply: FastifyReply } {
  const log = {
    info: (_details: unknown, message: string) => {
      written.push(message);
    },
  };

  return {
    request: { log } as unknown as FastifyRequest,
    reply: { log } as unknown as FastifyReply,
  };
}

describe('the request log (#189)', () => {
  it('holds nothing until told to, and writes every line of a logger it never saw', () => {
    const log = new RequestLog();
    const written: string[] = [];
    const { request: call, reply } = request(written);

    log.incomingRequest(call, reply);
    assert.deepEqual(written, ['incoming request']);

    for (const level of [DEBUG, INFO, WARN, ERROR]) {
      assert.equal(log.writes(call.log, level), true);
      assert.equal(log.writes({}, level), true);
    }
  });

  it("writes a held line once: on admit, or before the request's next line", () => {
    const log = new RequestLog();

    log.holdFor(() => true);

    const admitted: string[] = [];
    const first = request(admitted);

    log.incomingRequest(first.request, first.reply);
    assert.deepEqual(admitted, []);
    log.admit(first.request);
    log.admit(first.request);
    assert.equal(log.writes(first.request.log, INFO), true);
    assert.deepEqual(admitted, ['incoming request']);

    const unjudged: string[] = [];
    const second = request(unjudged);

    log.incomingRequest(second.request, second.reply);
    assert.equal(log.writes(second.request.log, INFO), true);
    assert.equal(log.writes(second.request.log, ERROR), true);
    assert.deepEqual(unjudged, ['incoming request']);
  });

  it("drops a refused call's held line and its lines below warn, and writes those at warn and above", () => {
    const log = new RequestLog();

    log.holdFor(() => true);

    const written: string[] = [];
    const refused = request(written);

    log.incomingRequest(refused.request, refused.reply);
    log.refuse(refused.request);
    log.admit(refused.request);

    assert.equal(log.writes(refused.request.log, DEBUG), false);
    assert.equal(log.writes(refused.request.log, INFO), false);
    assert.equal(log.writes(refused.request.log, WARN), true);
    assert.equal(log.writes(refused.request.log, ERROR), true);
    assert.deepEqual(written, [], 'the held line of a refused call was written');

    // A call refused once its line has been written - something was logged
    // of it before its verdict - keeps that line, and writes nothing more
    // below `warn`.
    const late: string[] = [];
    const after = request(late);

    log.incomingRequest(after.request, after.reply);
    log.admit(after.request);
    log.refuse(after.request);
    assert.equal(log.writes(after.request.log, INFO), false);
    assert.deepEqual(late, ['incoming request']);
  });

  it('holds only what its predicate names: 100,000 calls of each kind', () => {
    const log = new RequestLog();
    const held = new WeakSet<object>();

    log.holdFor((call) => held.has(call));

    let written = 0;
    const count = { info: () => (written += 1) };

    for (let index = 0; index < 100_000; index += 1) {
      const plain = { log: { ...count } } as unknown as FastifyRequest;
      const limited = { log: { ...count } } as unknown as FastifyRequest;

      held.add(limited);
      log.incomingRequest(plain, {} as FastifyReply);
      log.incomingRequest(limited, {} as FastifyReply);

      if (index % 2 === 0) {
        log.refuse(limited);
      } else {
        log.admit(limited);
      }
    }

    // Each plain call written at once, each admitted one once, no refused one.
    assert.equal(written, 150_000);
  });
});
