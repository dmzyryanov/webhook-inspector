/**
 * The `field` of a `1005` refusal (D257, issue #232), without a server: every
 * check of a creation and of a response change names the refused place in the
 * notation its message begins with, a header pair's name `[0]` and its value
 * `[1]`; a key of the body itself gets none; no field ever holds a key or a
 * value the client sent; and no other refusal carries one. The rules' and the
 * queue's own places are in `rules-body.test.ts` and `queue-body.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AppError,
  answersNotWritten,
  capturesBusy,
  invalidListQuery,
  invalidResponseConfig,
  invalidSearchWords,
  invalidSessionIds,
  largeBodiesBusy,
  listBodiesBusy,
  malformedRequestBody,
  rateLimitExceeded,
  receiveUrlMoved,
  requestNotFound,
  routeNotFound,
  searchBusy,
  searchTimedOut,
  sessionExpired,
  sessionNotFound,
  tooManyConcurrentCalls,
  tooManyRealtimeConnections,
  unsupportedMediaType,
} from '../../errors/app-error.ts';
import { INVALID_RESPONSES } from '../../testing/invalid-responses.ts';
import { assertFieldLeadsMessage, fieldLead } from '../../testing/refusal-field.ts';
import {
  parseCreateSessionBody,
  parseResponse,
  parseResponseChangeBody,
  UNKNOWN_CREATE_KEY_RULE,
} from './response-config.ts';

/** The `1005` refusal of `parse`, its message checked against its field. */
function refusal(parse: () => unknown): AppError {
  try {
    parse();
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
    assert.equal(error.statusCode, 400, error.message);
    assert.equal(error.errorCode, 1005, error.message);
    assertFieldLeadsMessage(error, error.message);

    return error;
  }

  assert.fail('nothing was refused');
}

function fieldOf(parse: () => unknown): string | undefined {
  return refusal(parse).field;
}

/** Keys a client might send to have them echoed: long, with a newline, with a quote. */
const HOSTILE_KEYS = ['k'.repeat(10_000), 'a\nb', 'a"b', '__proto__', 'response.status'];

describe('fieldLead', () => {
  it('reads a header pair’s [0] as name and [1] as value, anything else as it stands', () => {
    assert.equal(fieldLead('rules[2].response.headers[3][0]'), 'rules[2].response.headers[3] name');
    assert.equal(fieldLead('steps[0].headers[1][1]'), 'steps[0].headers[1] value');
    assert.equal(fieldLead('response.headers[0]'), 'response.headers[0]');
    assert.equal(fieldLead('steps[0]'), 'steps[0]');
    assert.equal(fieldLead('expiresInSeconds'), 'expiresInSeconds');
  });
});

describe('the field of a refused response (D257, criterion 1)', () => {
  it('names every check of a creation’s response by its place', () => {
    for (const [name, response, place] of INVALID_RESPONSES) {
      assert.equal(
        fieldOf(() => parseCreateSessionBody(JSON.stringify({ response }))),
        `response${place}`,
        name,
      );
    }

    assert.equal(
      fieldOf(() => parseCreateSessionBody('{"response":null}')),
      'response',
    );
  });

  it('names every check of a change’s response by its place, and its mode', () => {
    for (const [name, response, place] of INVALID_RESPONSES) {
      assert.equal(
        fieldOf(() => parseResponseChangeBody(JSON.stringify({ mode: 'custom', response }))),
        `response${place}`,
        name,
      );
    }

    assert.equal(
      fieldOf(() => parseResponseChangeBody('{"mode":"custom"}')),
      'response',
    );
    assert.equal(
      fieldOf(() => parseResponseChangeBody('{"mode":"custom","response":null}')),
      'response',
    );
    assert.equal(
      fieldOf(() => parseResponseChangeBody('{"mode":"default","response":{"status":200}}')),
      'response',
    );

    for (const mode of [undefined, null, 'Custom', 1, 'm'.repeat(10_000)]) {
      assert.equal(
        fieldOf(() => parseResponseChangeBody(JSON.stringify({ mode }))),
        'mode',
      );
    }
  });

  it('names a step’s and a rule’s response by the place it is given', () => {
    assert.equal(
      fieldOf(() => parseResponse({ status: 1 }, 'steps[4]')),
      'steps[4].status',
    );
    assert.equal(
      fieldOf(() =>
        parseResponse({ status: 200, headers: [['Set-Cookie', 'a']] }, 'rules[3].response'),
      ),
      'rules[3].response.headers[0][0]',
    );
    assert.equal(
      fieldOf(() =>
        parseResponse(
          {
            status: 200,
            headers: [
              ['x', 'v'],
              ['y', '\r'],
            ],
          },
          'response',
        ),
      ),
      'response.headers[1][1]',
    );
  });

  it('names a response holding an unknown key by the response, never by the key', () => {
    for (const key of HOSTILE_KEYS) {
      const error = refusal(() =>
        parseCreateSessionBody(`{"response":{"status":200,${JSON.stringify(key)}:1}}`),
      );

      assert.equal(error.field, 'response', key.slice(0, 20));
      assert.equal(error.message.includes(key), false, key.slice(0, 20));
    }
  });
});

describe('the field of a creation’s own keys (D257, criterion 1)', () => {
  it('names each key by itself, and the two expiry keys given together by the first', () => {
    const cases: [object, string][] = [
      [{ expiresInSeconds: 59 }, 'expiresInSeconds'],
      [{ expiresInSeconds: null }, 'expiresInSeconds'],
      [{ expiresInSeconds: '600' }, 'expiresInSeconds'],
      [{ expiresAfterIdleSeconds: 5 }, 'expiresAfterIdleSeconds'],
      [{ expiresAfterIdleSeconds: null }, 'expiresAfterIdleSeconds'],
      [{ expiresInSeconds: 600, expiresAfterIdleSeconds: 3600 }, 'expiresInSeconds'],
      [{ storeSourceIp: 'false' }, 'storeSourceIp'],
      [{ storeSourceIp: null }, 'storeSourceIp'],
      [{ private: 1 }, 'private'],
      [{ private: null }, 'private'],
      [{ rules: null }, 'rules'],
      [{ queue: 1 }, 'queue'],
    ];

    for (const [body, field] of cases) {
      assert.equal(
        fieldOf(() => parseCreateSessionBody(JSON.stringify(body))),
        field,
        JSON.stringify(body),
      );
    }
  });

  it('keeps the order of the checks: the first key broken in it names the field, every time', () => {
    const body = JSON.stringify({
      other: 1,
      private: 1,
      rules: 1,
      storeSourceIp: 1,
      expiresInSeconds: 1,
      queue: 1,
      response: 1,
    });
    const fields = ['response', 'queue', 'expiresInSeconds', 'storeSourceIp', 'rules', 'private'];
    let current = JSON.parse(body) as Record<string, unknown>;

    // Each key put right in turn: the next in the order of the checks names the field.

    for (const field of fields) {
      for (let run = 0; run < 3; run += 1) {
        assert.equal(
          fieldOf(() => parseCreateSessionBody(JSON.stringify(current))),
          field,
        );
      }

      current = Object.fromEntries(Object.entries(current).filter(([key]) => key !== field));
    }

    assert.equal(
      fieldOf(() => parseCreateSessionBody(JSON.stringify(current))),
      undefined,
    );
  });

  it('gives a key of the body itself no field, on a creation and a change, never the key', () => {
    for (const key of HOSTILE_KEYS) {
      const created = refusal(() => parseCreateSessionBody(`{${JSON.stringify(key)}:1}`));
      const changed = refusal(() =>
        parseResponseChangeBody(`{"mode":"default",${JSON.stringify(key)}:1}`),
      );

      assert.equal(created.field, undefined, key.slice(0, 20));
      assert.equal(created.message, UNKNOWN_CREATE_KEY_RULE);
      assert.equal(changed.field, undefined, key.slice(0, 20));
      assert.equal(
        changed.message,
        'The request body may contain no key other than "mode" and "response"',
      );
    }
  });
});

describe('the errors other than 1005 (D257, criterion 2)', () => {
  it('carry no field, and a 1005 carries one only when given', () => {
    const others = [
      sessionNotFound(),
      routeNotFound(),
      requestNotFound(),
      sessionExpired(),
      receiveUrlMoved('moved'),
      malformedRequestBody(),
      invalidSearchWords('words'),
      invalidListQuery('query'),
      invalidSessionIds('ids'),
      searchTimedOut(),
      searchBusy(),
      rateLimitExceeded('60 session creations per minute', 5),
      listBodiesBusy(),
      largeBodiesBusy(),
      tooManyConcurrentCalls(128),
      answersNotWritten('address', 1024 * 1024),
      tooManyRealtimeConnections(16),
      capturesBusy(),
      unsupportedMediaType(),
    ];

    for (const error of others) {
      assert.equal(error.field, undefined, error.message);
    }

    assert.equal(invalidResponseConfig('x').field, undefined);
    assert.equal(invalidResponseConfig('rules must', 'rules').field, 'rules');
  });
});
