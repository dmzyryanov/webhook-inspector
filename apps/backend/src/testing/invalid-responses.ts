/**
 * Responses that break a rule of D101 each, with what they break, for the
 * tests that hold every route checking a response to the same rules:
 * creation, a response change (D150), each step of a response queue (D205)
 * and each rule's response (D246). Every one is `400` / `1005` wherever a
 * response is checked, its `field` the response's place followed by the
 * third element: `.status`, `.headers[0][1]`, or nothing for the response
 * as a whole (D257).
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
export const INVALID_RESPONSES: readonly [string, unknown, string][] = [
  ['status below 200', { status: 199 }, '.status'],
  ['status 101', { status: 101 }, '.status'],
  ['status above 599', { status: 600 }, '.status'],
  ['a non-integer status', { status: 200.5 }, '.status'],
  ['a status that is not a number', { status: '200' }, '.status'],
  ['a null status', { status: null }, '.status'],
  ['no status at all', {}, '.status'],
  ['a body with 204', { status: 204, body: '{"a":1}' }, '.body'],
  ['a body with 205', { status: 205, body: '{"a":1}' }, '.body'],
  ['a body with 304', { status: 304, body: '{"a":1}' }, '.body'],
  [
    '21 headers',
    {
      status: 200,
      headers: Array.from({ length: 21 }, (_unused, index) => ['x-pad', String(index)]),
    },
    '.headers',
  ],
  [
    'a header name over 128 bytes',
    { status: 200, headers: [['x'.repeat(129), 'v']] },
    '.headers[0][0]',
  ],
  [
    'a header name outside the token charset',
    { status: 200, headers: [['x trace', 'v']] },
    '.headers[0][0]',
  ],
  [
    'a header value over 1024 bytes',
    { status: 200, headers: [['x-trace', 'v'.repeat(1025)]] },
    '.headers[0][1]',
  ],
  [
    'a header value containing CR',
    { status: 200, headers: [['x-trace', 'a\rb']] },
    '.headers[0][1]',
  ],
  [
    'a header value containing LF',
    { status: 200, headers: [['x-trace', 'a\nb']] },
    '.headers[0][1]',
  ],
  [
    'a header block over 8192 bytes',
    { status: 200, headers: Array.from({ length: 9 }, () => ['x-pad-01', 'v'.repeat(1000)]) },
    '.headers',
  ],
  ['a reserved header', { status: 200, headers: [['Set-Cookie', 'a=1']] }, '.headers[0][0]'],
  [
    'Refresh, reserved on a 3xx too',
    { status: 302, headers: [['Refresh', '0; url=/s/x']] },
    '.headers[0][0]',
  ],
  [
    'a Location with a status outside 300 to 399',
    { status: 200, headers: [['Location', '/s/x/after']] },
    '.headers[0]',
  ],
  [
    'a Location whose target is not under /s/',
    { status: 302, headers: [['Location', 'https://evil.example/']] },
    '.headers[0][1]',
  ],
  [
    'a header in the receiver namespace',
    { status: 200, headers: [['X-QA-Tools-Id', 'x']] },
    '.headers[0][0]',
  ],
  ['headers that are not an array', { status: 200, headers: {} }, '.headers'],
  ['a null headers', { status: 200, headers: null }, '.headers'],
  ['a header pair that is not two strings', { status: 200, headers: [['x-a', 1]] }, '.headers[0]'],
  ['a body over 65536 bytes', { status: 200, body: JSON.stringify('a'.repeat(65536)) }, '.body'],
  ['a body containing U+0000', { status: 200, body: 'a\u0000b' }, '.body'],
  ['a JSON body containing U+0000', { status: 200, body: '{"a":"\u0000"}' }, '.body'],
  ['a whitespace body with 204', { status: 204, body: ' ' }, '.body'],
  [
    'a Content-Security-Policy header',
    { status: 200, headers: [['Content-Security-Policy', 'sandbox allow-scripts']] },
    '.headers[0][0]',
  ],
  ['a body that is not a string', { status: 200, body: 123 }, '.body'],
  ['a negative delayMs', { status: 200, delayMs: -1 }, '.delayMs'],
  ['a delayMs over 30000', { status: 200, delayMs: 30001 }, '.delayMs'],
  ['a non-integer delayMs', { status: 200, delayMs: 1.5 }, '.delayMs'],
  ['a null delayMs', { status: 200, delayMs: null }, '.delayMs'],
  ['an unknown key inside response', { status: 200, delay: 500 }, ''],
  ['a response that is not an object', 'abc', ''],
  ['a response that is an array', [], ''],
  // Templates (D251): the flag a boolean, and with it on every `{{` a
  // placeholder of the set.
  ['a template that is a string', { status: 200, body: 'x', template: 'true' }, '.template'],
  ['a null template', { status: 200, body: 'x', template: null }, '.template'],
  ['a template that is a number', { status: 200, body: 'x', template: 1 }, '.template'],
  [
    'an unknown placeholder',
    { status: 200, body: '{"ip":"{{request.ip}}"}', template: true },
    '.body',
  ],
  [
    'an unclosed placeholder',
    { status: 200, body: '{"id":"{{request.id"}', template: true },
    '.body',
  ],
  [
    'a space inside a placeholder',
    { status: 200, body: '{{ request.id }}', template: true },
    '.body',
  ],
  ['an expression as a placeholder', { status: 200, body: '{{1+1}}', template: true }, '.body'],
  ['an empty placeholder', { status: 200, body: '{{}}', template: true }, '.body'],
  [
    'a header placeholder naming no token',
    { status: 200, body: '{{request.header.a:b}}', template: true },
    '.body',
  ],
  [
    'a query placeholder naming nothing',
    { status: 200, body: '{{request.query.}}', template: true },
    '.body',
  ],
  [
    'a body placeholder with an empty key',
    { status: 200, body: '{{request.body.a..b}}', template: true },
    '.body',
  ],
  [
    'a body placeholder with no path',
    { status: 200, body: '{{request.body}}', template: true },
    '.body',
  ],
];
