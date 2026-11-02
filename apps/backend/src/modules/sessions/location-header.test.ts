/**
 * The `Location` rule (D247), without a server. A configured `Location`,
 * whatever the case of its name, is accepted only with a status from 300 to
 * 399 and a value beginning with the literal `/s/`, beside the rules every
 * value is held to; anything else is `400` / `1005`, its message naming the
 * field and the pair's index and quoting nothing of the value (D106). The
 * same function checks every body that carries a response - creation's, a
 * change's, a queue's step and a rule's - so each is tried here under its own
 * place. Made-up targets built to leave the host - schemes, protocol-relative
 * and backslash forms, userinfo, host spellings, controls, encoded line breaks
 * - are tried at 64, 256 and 1024 bytes and just past the value's limit, each
 * answered within a bound.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LOCATION_STATUS_MAX,
  LOCATION_STATUS_MIN,
  LOCATION_TARGET_PREFIX,
  locationHeaderProblem,
  MAX_HEADER_VALUE_BYTES,
  RESERVED_RESPONSE_HEADERS,
} from '@webhook-inspector/shared';
import { AppError } from '../../errors/app-error.ts';
import { withinBound } from '../../testing/timing.ts';
import {
  parseCreateSessionBody,
  parseQueueBody,
  parseResponse,
  parseResponseChangeBody,
  parseRulesBody,
} from './response-config.ts';

/** Placed in every refused value, so an echo of it in a message is caught. */
const MARKER = 'MARKER247';

/** Longer than any message: a refusal that quotes what it refused grows past it. */
const SHORT_MESSAGE = 240;

/** Generous for a value of 1 KiB; the rule is a prefix comparison. */
const BOUND_MS = 50;

/** The value sizes the made-up targets are tried at, the last one past the limit. */
const SIZES = [64, 256, MAX_HEADER_VALUE_BYTES, MAX_HEADER_VALUE_BYTES + 1];

const STATUS_RULE =
  'response.headers[0] Location is allowed only when response.status is from 300 to 399';
const TARGET_RULE = 'response.headers[0] value of Location must be a path beginning with /s/';

/** The `1005` refusal `parse` throws, its message returned. */
function refused(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
    assert.equal(error.statusCode, 400, error.message);
    assert.equal(error.errorCode, 1005, error.message);
    assert.ok(error.message.length <= SHORT_MESSAGE, error.message);
    assert.equal(error.message.includes(MARKER), false, `echoed: ${error.message}`);

    return error.message;
  }

  assert.fail('nothing was refused');
}

function response(status: number, ...headers: [string, string][]): Record<string, unknown> {
  return { status, headers };
}

/** `start`, then `MARKER`, then `fill` to exactly `size` characters. */
function sized(start: string, size: number, fill = 'a'): string {
  const head = `${start}${MARKER}`;

  return `${head}${fill.repeat(Math.max(0, size - head.length))}`.slice(0, Math.max(size, 0));
}

/**
 * Targets that leave the host, or that a careless check would read as a path:
 * every one refused with `302`. `start` is the target's own beginning; the
 * marker and padding follow it.
 */
const FOREIGN_TARGETS: readonly string[] = [
  'https://evil.example/',
  'http://evil.example/',
  'HTTPS://evil.example/',
  '//evil.example/',
  '/\\evil.example/',
  '\\\\evil.example/',
  '\\/evil.example/',
  '/\t/evil.example/',
  '\t/s/',
  ' /s/',
  '/s /',
  '/S/',
  's/',
  './s/',
  '../s/',
  '/s',
  '/ss/',
  '%2Fs%2F',
  '/%73/',
  'javascript:alert(1)//',
  'java\tscript:alert(1)//',
  'JavaScript:',
  'data:text/html,',
  'file:///etc/',
  'vbscript:',
  'blob:https://evil.example/',
  'ftp://evil.example/',
  'ws://evil.example/',
  'mailto:a@evil.example?',
  'http:evil.example/',
  'https:/evil.example/',
  'https:\\\\evil.example/',
  'https://hook.qa-tools.ru@evil.example/',
  'https://hook.qa-tools.ru.evil.example/',
  'https://hook.qa-tools.ru./s/',
  'https://xn--hok-qa-tools-ru.example/',
  'https://0x7f000001/',
  'https://2130706433/',
  'https://[::1]/',
  'https://hook.qa-tools.ru:0/s/',
  'https://hook.qa-tools.ru/s/',
  '@evil.example/',
  '#/s/',
  '?/s/',
  '',
];

describe('locationHeaderProblem, the shared rule (D247)', () => {
  it('judges only the name Location, in any case', () => {
    for (const name of ['Location', 'location', 'LOCATION', 'LoCaTiOn']) {
      assert.equal(locationHeaderProblem(name, '/s/x', 302), null, name);
      assert.equal(locationHeaderProblem(name, '/s/x', 200), 'status', name);
      assert.equal(locationHeaderProblem(name, '//x', 302), 'target', name);
    }

    for (const name of ['Content-Location', 'X-Location', 'Locations', 'Location-', 'Refresh']) {
      assert.equal(locationHeaderProblem(name, 'https://evil.example/', 200), null, name);
    }
  });

  it('takes every status from 300 to 399 and none outside, and names the status first', () => {
    assert.equal(LOCATION_STATUS_MIN, 300);
    assert.equal(LOCATION_STATUS_MAX, 399);
    assert.equal(LOCATION_TARGET_PREFIX, '/s/');

    for (let status = 200; status <= 599; status += 1) {
      assert.equal(
        locationHeaderProblem('Location', '/s/x', status),
        status >= 300 && status <= 399 ? null : 'status',
        String(status),
      );
    }

    assert.equal(locationHeaderProblem('Location', 'https://evil.example/', 200), 'status');
  });

  it('judges only the target when the status is not known', () => {
    assert.equal(locationHeaderProblem('Location', '/s/x', null), null);
    assert.equal(locationHeaderProblem('Location', 'https://evil.example/', null), 'target');
  });
});

describe('a Location in a response (D247)', () => {
  it('is accepted with 300, 301, 302, 303, 304, 305, 306, 307, 308 and 399, its name in any case, kept as sent', () => {
    for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
      for (const name of ['Location', 'location', 'LOCATION', 'lOcAtIoN']) {
        const parsed = parseResponse(response(status, [name, '/s/abc/after']));

        assert.equal(parsed.status, status);
        assert.deepEqual(parsed.headers, [[name, '/s/abc/after']]);
      }
    }
  });

  it('is refused with 200, 201, 204, 299, 400, 500 and 599, naming the field and quoting nothing', () => {
    for (const status of [200, 201, 204, 299, 400, 404, 500, 599]) {
      assert.equal(
        refused(() => parseResponse(response(status, ['Location', `/s/${MARKER}`]))),
        STATUS_RULE,
        String(status),
      );
    }
  });

  it('is refused with a target that does not begin with the literal /s/', () => {
    for (const target of FOREIGN_TARGETS) {
      const value = target === '' ? '' : `${target}${MARKER}`;

      assert.equal(
        refused(() => parseResponse(response(302, ['Location', value]))),
        TARGET_RULE,
        JSON.stringify(target),
      );
    }
  });

  it('keeps every target that begins with /s/ as sent, odd ones included: they stay on the host', () => {
    for (const target of [
      '/s/',
      '/s/abc/after',
      '/s/abc/after?x=1#y',
      '/s//evil.example/',
      '/s/\\evil.example/',
      '/s/@evil.example/',
      '/s/../../evil',
      '/s/https://evil.example/',
      '/s/%0d%0aSet-Cookie:%20a=1',
      '/s/\tx',
      '/s/x ',
    ]) {
      assert.deepEqual(parseResponse(response(307, ['Location', target])).headers, [
        ['Location', target],
      ]);
    }
  });

  it('refuses raw line breaks, NUL, other controls and non-ASCII by the value rule, quoting nothing', () => {
    for (const bad of ['\r\nSet-Cookie: a=1', '\n', '\r', '\u0000', '\u007f', '\u0085', 'é', ' ']) {
      const message = refused(() =>
        parseResponse(response(302, ['Location', `/s/${MARKER}${bad}`])),
      );

      assert.equal(
        message,
        'response.headers[0] value must contain only visible ASCII, space and tab',
        JSON.stringify(bad),
      );
    }
  });

  it('takes several Location pairs, in order, and names the first that breaks the rule by its index', () => {
    const pairs: [string, string][] = [
      ['Location', '/s/a/1'],
      ['x-trace', 'abc'],
      ['location', '/s/a/2'],
    ];

    assert.deepEqual(parseResponse(response(302, ...pairs)).headers, pairs);
    assert.equal(
      refused(() =>
        parseResponse(response(302, ...pairs, ['LOCATION', `https://${MARKER}.example/`])),
      ),
      'response.headers[3] value of Location must be a path beginning with /s/',
    );
  });

  it('checks the pair rules and the block first, then reserved names and Location pair by pair', () => {
    // A value over 1024 bytes is refused for its length, whatever it starts with.
    assert.equal(
      refused(() => parseResponse(response(200, ['Location', sized('https://', 1025)]))),
      'response.headers[0] value must be at most 1024 bytes',
    );
    // Nine targets of 1000 bytes fit every pair rule and not the block.
    assert.equal(
      refused(() =>
        parseResponse(
          response(
            302,
            ...Array.from({ length: 9 }, (): [string, string] => ['Location', sized('/s/', 1000)]),
          ),
        ),
      ),
      'response.headers must serialise to at most 8192 bytes as "name: value" lines',
    );
    // The first pair breaking either rule is named, whichever rule it breaks.
    assert.equal(
      refused(() =>
        parseResponse(response(200, ['Location', `/s/${MARKER}`], ['Set-Cookie', MARKER])),
      ),
      STATUS_RULE,
    );
    assert.equal(
      refused(() =>
        parseResponse(response(302, ['Set-Cookie', MARKER], ['Location', `//${MARKER}`])),
      ),
      'response.headers[0] name is reserved by the receiver and cannot be configured',
    );
  });

  it('takes a target of exactly 1024 bytes', () => {
    const target = sized('/s/', MAX_HEADER_VALUE_BYTES);

    assert.equal(target.length, 1024);
    assert.deepEqual(parseResponse(response(308, ['Location', target])).headers, [
      ['Location', target],
    ]);
  });

  it('keeps Refresh and every reserved name refused with 302 as with 200, and Content-Location allowed', () => {
    assert.equal(RESERVED_RESPONSE_HEADERS.includes('location'), false);
    assert.ok(RESERVED_RESPONSE_HEADERS.includes('refresh'));

    for (const status of [302, 200]) {
      for (const name of [...RESERVED_RESPONSE_HEADERS, 'X-QA-Tools-Anything']) {
        for (const spelling of [name, name.toUpperCase()]) {
          assert.equal(
            refused(() => parseResponse(response(status, [spelling, `/s/${MARKER}`]))),
            'response.headers[0] name is reserved by the receiver and cannot be configured',
            `${spelling} with ${status}`,
          );
        }
      }

      // Refresh named literally: the loop above cannot fail if it leaves the list.
      refused(() => parseResponse(response(status, ['Refresh', `0; url=/s/${MARKER}`])));

      for (const value of ['https://evil.example/', '/anything', '']) {
        assert.deepEqual(parseResponse(response(status, ['Content-Location', value])).headers, [
          ['Content-Location', value],
        ]);
      }
    }
  });
});

describe('a Location in every body that carries a response (D247)', () => {
  const good = { status: 307, headers: [['Location', '/s/abc/after']] };
  const onA200 = {
    status: 200,
    headers: [
      ['x-a', '1'],
      ['Location', `/s/${MARKER}`],
    ],
  };
  const foreign = { status: 302, headers: [['Location', `https://${MARKER}.example/`]] };

  it('is taken at creation, as the response, a queue step and a rule', () => {
    const created = parseCreateSessionBody(
      JSON.stringify({
        response: good,
        queue: { steps: [good, { status: 200 }] },
        rules: [{ method: null, path: '/*', response: good }],
      }),
    );

    assert.deepEqual(created.response?.headers, [['Location', '/s/abc/after']]);
    assert.deepEqual(created.queue?.[0]?.headers, [['Location', '/s/abc/after']]);
    assert.deepEqual(created.rules?.[0]?.response.headers, [['Location', '/s/abc/after']]);
  });

  it('is taken by a change, a queue and the rules', () => {
    assert.deepEqual(parseResponseChangeBody(JSON.stringify({ mode: 'custom', response: good })), {
      mode: 'custom',
      response: { ...good, body: null, delayMs: 0, template: false },
    });
    assert.deepEqual(parseQueueBody(JSON.stringify({ steps: [good] }))[0]?.headers, good.headers);
    assert.deepEqual(
      parseRulesBody(JSON.stringify({ rules: [{ method: 'POST', path: '/x', response: good }] }))[0]
        ?.response.headers,
      good.headers,
    );
  });

  it('is refused under its own place in each, naming the field and quoting nothing', () => {
    const places: [string, (refusedResponse: unknown) => unknown][] = [
      ['response', (each) => parseCreateSessionBody(JSON.stringify({ response: each }))],
      [
        'queue.steps[1]',
        (each) =>
          parseCreateSessionBody(JSON.stringify({ queue: { steps: [{ status: 503 }, each] } })),
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

    for (const [field, parse] of places) {
      assert.equal(
        refused(() => parse(onA200)),
        `${field}.headers[1] Location is allowed only when ${field}.status is from 300 to 399`,
      );
      assert.equal(
        refused(() => parse(foreign)),
        `${field}.headers[0] value of Location must be a path beginning with /s/`,
      );
    }
  });
});

describe('made-up Location targets at growing sizes (D247)', () => {
  for (const size of SIZES) {
    it(`answers every one of ${size} bytes within a bound, refused or kept, quoting nothing`, () => {
      for (const target of FOREIGN_TARGETS.filter((each) => each !== '')) {
        for (const status of [302, 200]) {
          const value = sized(target, size, target.includes('\t') ? '\t' : 'a');
          const message = withinBound(BOUND_MS, () =>
            refused(() => parseResponse(response(status, ['Location', value]))),
          );

          if (size > MAX_HEADER_VALUE_BYTES) {
            assert.equal(message, 'response.headers[0] value must be at most 1024 bytes');
          } else {
            assert.equal(message, status === 302 ? TARGET_RULE : STATUS_RULE, target);
          }
        }
      }

      // Runs of what a parser of URLs or of the header could stumble on, after
      // a good prefix: kept as sent while within the limit.
      for (const fill of ['/', '\\', '%0d%0a', '@', '#', '?', '\t', ' ', '..', '//']) {
        const value = sized('/s/', size, fill);
        const parse = (): unknown => parseResponse(response(307, ['Location', value]));

        if (size > MAX_HEADER_VALUE_BYTES) {
          withinBound(BOUND_MS, () => refused(parse));
        } else {
          assert.deepEqual(
            (withinBound(BOUND_MS, parse) as { headers: unknown }).headers,
            [['Location', value]],
            JSON.stringify(fill),
          );
        }
      }
    });
  }

  it('answers twenty Location pairs at the value limit for the block, within a bound', () => {
    const pairs = Array.from({ length: 20 }, (): [string, string] => [
      'Location',
      sized('/s/', MAX_HEADER_VALUE_BYTES),
    ]);

    assert.equal(
      withinBound(BOUND_MS, () => refused(() => parseResponse(response(302, ...pairs)))),
      'response.headers must serialise to at most 8192 bytes as "name: value" lines',
    );
  });
});
