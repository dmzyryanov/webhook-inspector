/**
 * The request id's header under the service's name beside its old one (#334,
 * D279, criterion 1), without a server: both names are refused as reserved
 * in every body that carries a response - creation's response, a queue's
 * step and a rule's, a change, a queue and the rules - in any letter case,
 * as `X-QA-Tools-` names are; names that only look alike are taken; and both
 * headers sit outside the configured header budget, so a block of exactly
 * 8192 bytes is still taken and answered with both, one value, after it.
 * Made-up names built near the reserved one are tried at growing sizes up to
 * the name's limit, each answered within a bound.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_HEADER_BLOCK_BYTES,
  MAX_HEADER_NAME_BYTES,
  MAX_RESPONSE_HEADERS,
  OLD_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  RESERVED_RESPONSE_HEADERS,
  type ResponseConfig,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { withinBound } from '../../testing/timing.ts';
import { composeWebhookResponse, NOTHING_CARRIED } from '../webhook/response.ts';
import {
  parseCreateSessionBody,
  parseQueueBody,
  parseResponse,
  parseResponseChangeBody,
  parseRulesBody,
} from './response-config.ts';

const RESERVED = 'name is reserved by the receiver and cannot be configured';
const REQUEST = '3f8a1b20-0000-4000-8000-000000000000';

/** The `1005` refusal `parse` throws, its message returned. */
function refused(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
    assert.equal(error.statusCode, 400, error.message);
    assert.equal(error.errorCode, 1005, error.message);

    return error.message;
  }

  assert.fail('not refused');
}

/** Every place a response is checked, each with the field its refusal names. */
const PLACES: [string, (response: unknown) => unknown][] = [
  ['response', (each) => parseCreateSessionBody(JSON.stringify({ response: each }))],
  [
    'queue.steps[1]',
    (each) => parseCreateSessionBody(JSON.stringify({ queue: { steps: [{ status: 503 }, each] } })),
  ],
  [
    'rules[0].response',
    (each) =>
      parseCreateSessionBody(
        JSON.stringify({ rules: [{ method: null, path: '/', response: each }] }),
      ),
  ],
  [
    'response',
    (each) => parseResponseChangeBody(JSON.stringify({ mode: 'custom', response: each })),
  ],
  ['steps[1]', (each) => parseQueueBody(JSON.stringify({ steps: [{ status: 503 }, each] }))],
  [
    'rules[0].response',
    (each) =>
      parseRulesBody(JSON.stringify({ rules: [{ method: 'GET', path: '/', response: each }] })),
  ],
];

/** Both names in the letter cases a configuration may write them in. */
const SPELLINGS = [
  REQUEST_ID_HEADER,
  REQUEST_ID_HEADER.toUpperCase(),
  'X-Webhook-Inspector-Request-Id',
  'X-WEBHOOK-inspector-REQUEST-id',
  'x-Webhook-Inspector-Request-ID',
  OLD_REQUEST_ID_HEADER,
  OLD_REQUEST_ID_HEADER.toUpperCase(),
  'X-QA-Tools-Request-Id',
  'x-Qa-tOOls-request-ID',
];

describe('the request id’s two names, as configured headers (D279)', () => {
  it('are the service’s name and the old one, the new one on the reserved list', () => {
    assert.equal(REQUEST_ID_HEADER, 'x-webhook-inspector-request-id');
    assert.equal(OLD_REQUEST_ID_HEADER, 'x-qa-tools-request-id');
    assert.ok(RESERVED_RESPONSE_HEADERS.includes(REQUEST_ID_HEADER));
  });

  for (const [place, parse] of PLACES) {
    it(`are refused in ${place}, in any letter case, as the first pair or after others`, () => {
      for (const spelling of SPELLINGS) {
        assert.equal(
          refused(() => parse({ status: 200, headers: [[spelling, REQUEST]] })),
          `${place}.headers[0] ${RESERVED}`,
          spelling,
        );
        assert.equal(
          refused(() =>
            parse({
              status: 201,
              headers: [
                ['x-before', '1'],
                ['x-trace', '2'],
                [spelling, ''],
              ],
              body: 'x',
            }),
          ),
          `${place}.headers[2] ${RESERVED}`,
          spelling,
        );
      }
    });
  }

  it('leave names that only look alike configurable', () => {
    for (const name of [
      'X-Webhook-Inspector',
      'X-Webhook-Inspector-Request',
      'X-Webhook-Inspector-Request-Ids',
      'X-Webhook-Inspector-RequestId',
      'X-Webhook-Inspector-Request_Id',
      'Webhook-Inspector-Request-Id',
      'X-Webhook-Inspector-Session-Id',
      'XX-Webhook-Inspector-Request-Id',
      'X-Request-Id',
    ]) {
      assert.deepEqual(parseResponse({ status: 200, headers: [[name, 'v']] }).headers, [
        [name, 'v'],
      ]);
    }
  });

  it('refuse names near the reserved ones of growing size up to the name’s limit, within a bound', () => {
    for (const size of [64, MAX_HEADER_NAME_BYTES, MAX_HEADER_NAME_BYTES + 1]) {
      const near = `x-webhook-inspector-request-id${'x'.repeat(size)}`.slice(0, size);
      const old = `X-QA-Tools-${'a'.repeat(size)}`.slice(0, size);
      const tooLong = size > MAX_HEADER_NAME_BYTES;

      const nearAnswer = withinBound(50, () => {
        try {
          return parseResponse({ status: 200, headers: [[near, 'v']] }).headers;
        } catch (error) {
          return (error as Error).message;
        }
      });

      assert.deepEqual(
        nearAnswer,
        tooLong ? 'response.headers[0] name must be at most 128 bytes' : [[near, 'v']],
        `${size}`,
      );
      assert.ok(
        withinBound(50, () => refused(() => parseResponse({ status: 200, headers: [[old, 'v']] })))
          .length > 0,
      );
    }

    // As many pairs as a response takes, every one reserved: the first is named.
    const many = Array.from({ length: MAX_RESPONSE_HEADERS }, (_, n): [string, string] => [
      n % 2 === 0 ? REQUEST_ID_HEADER : OLD_REQUEST_ID_HEADER.toUpperCase(),
      String(n),
    ]);

    assert.equal(
      withinBound(50, () => refused(() => parseResponse({ status: 200, headers: many }))),
      `response.headers[0] ${RESERVED}`,
    );
  });
});

describe('the request id’s two headers on the answer, outside the header budget (D279)', () => {
  /** Configured pairs whose `name: value\r\n` lines add up to exactly `bytes`. */
  function blockOf(bytes: number): [string, string][] {
    const pairs: [string, string][] = [];
    let left = bytes;

    while (left > 0) {
      // `x-fill-NN: ` and `\r\n` around a value of up to 1000 bytes.
      const name = `x-fill-${String(pairs.length).padStart(2, '0')}`;
      const overhead = name.length + 4;
      const value = 'v'.repeat(Math.min(1000, left - overhead));

      pairs.push([name, value]);
      left -= overhead + value.length;
    }

    return pairs;
  }

  it('takes a configured block of exactly 8192 bytes, and answers it with both headers, one value, after it', () => {
    const headers = blockOf(MAX_HEADER_BLOCK_BYTES);
    const lines = headers.map(([name, value]) => `${name}: ${value}\r\n`).join('');

    assert.equal(Buffer.byteLength(lines), MAX_HEADER_BLOCK_BYTES);
    assert.match(
      refused(() =>
        parseResponse({
          status: 200,
          headers: [
            ...headers.slice(0, -1),
            [headers.at(-1)?.[0] ?? '', `${headers.at(-1)?.[1]}v`],
          ],
        }),
      ),
      /must serialise to at most 8192 bytes/,
    );

    const config: ResponseConfig = parseResponse({ status: 200, headers, body: 'ok' });
    const composed = composeWebhookResponse(
      config,
      {
        requestId: REQUEST,
        inspectorUrl: 'https://qa-tools.ru/v/x#y',
        receivedAt: '2026-11-02T00:00:00.000Z',
        method: 'POST',
        path: '/s/x',
        bodySize: 0,
        sourceIp: null,
      },
      NOTHING_CARRIED,
    );

    assert.deepEqual(composed.headers.slice(0, headers.length), headers);
    assert.deepEqual(composed.headers.slice(headers.length, headers.length + 2), [
      [REQUEST_ID_HEADER, REQUEST],
      [OLD_REQUEST_ID_HEADER, REQUEST],
    ]);
    assert.ok(
      composed.raw
        .toString('latin1')
        .includes(
          `\r\n${REQUEST_ID_HEADER}: ${REQUEST}\r\n${OLD_REQUEST_ID_HEADER}: ${REQUEST}\r\n`,
        ),
    );
  });

  it('sends both over HTTP/2 too, in the same place', () => {
    const composed = composeWebhookResponse(
      { status: 202, headers: [['x-a', '1']], body: null, delayMs: 0, template: false },
      {
        requestId: REQUEST,
        inspectorUrl: 'https://qa-tools.ru/v/x#y',
        receivedAt: '2026-11-02T00:00:00.000Z',
        method: 'PUT',
        path: '/s/x',
        bodySize: 0,
        sourceIp: null,
      },
      NOTHING_CARRIED,
      true,
    );

    assert.deepEqual(composed.headers.slice(0, 3), [
      ['x-a', '1'],
      [REQUEST_ID_HEADER, REQUEST],
      [OLD_REQUEST_ID_HEADER, REQUEST],
    ]);
  });
});
