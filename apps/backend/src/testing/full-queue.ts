/**
 * A response at every limit of D101 written in ordinary text, for the tests
 * that hold a full response queue, and a creation carrying one beside a
 * response, within the 1 MiB body limit of the JSON routes (D205).
 *
 * Ordinary text is what `JSON.stringify` writes as its own UTF-8 bytes:
 * letters - Cyrillic ones, two bytes each, among them - digits, spaces and
 * punctuation other than `"` and `\`, and no control character. A body is
 * 65,536 bytes of it and a header block the whole 8 KiB in 20 pairs, so ten
 * steps are about 720 KiB of JSON and a creation with a response about
 * 795 KiB. Text that JSON escapes - quotes, backslashes, control characters,
 * or non-ASCII letters a serializer writes as `\uXXXX` - writes larger, and a
 * queue of it can pass 1 MiB.
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import {
  MAX_BODY_BYTES,
  MAX_HEADER_BLOCK_BYTES,
  MAX_HEADER_VALUE_BYTES,
  MAX_QUEUE_STEPS,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_DELAY_MS,
  MAX_RESPONSE_HEADERS,
  type ResponseConfig,
} from '@webhook-inspector/shared';

const SENTENCE = 'Ответ сервиса: order 42 accepted, retry later; ok. ';
const HEADER_TEXT = 'trace-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ;';

/** `SENTENCE` repeated to exactly `bytes` bytes of UTF-8, ASCII at the end. */
function ordinaryText(bytes: number): string {
  let text = '';
  let size = 0;

  while (size + Buffer.byteLength(SENTENCE) <= bytes) {
    text += SENTENCE;
    size += Buffer.byteLength(SENTENCE);
  }

  return text + 'a'.repeat(bytes - size);
}

/** `HEADER_TEXT` repeated to `length` characters, all visible ASCII. */
function headerValue(length: number): string {
  return HEADER_TEXT.repeat(Math.ceil(length / HEADER_TEXT.length)).slice(0, length);
}

/**
 * 20 pairs whose `name: value\r\n` lines fill the header block exactly: names
 * of six characters, values of 399 or 400.
 */
function fullHeaders(): [string, string][] {
  const names = Array.from(
    { length: MAX_RESPONSE_HEADERS },
    (_unused, index) => `x-h-${String(index).padStart(2, '0')}`,
  );
  const lineOverhead = names.reduce((sum, name) => sum + name.length + 4, 0);
  const valueBytes = MAX_HEADER_BLOCK_BYTES - lineOverhead;
  const base = Math.floor(valueBytes / names.length);
  const longer = valueBytes - base * names.length;

  return names.map((name, index) => [name, headerValue(base + (index < longer ? 1 : 0))]);
}

/** One response at every limit of D101, in ordinary text. */
export function ordinaryFullResponse(): ResponseConfig {
  return {
    status: 500,
    headers: fullHeaders(),
    body: ordinaryText(MAX_RESPONSE_BODY_BYTES),
    delayMs: MAX_RESPONSE_DELAY_MS,
    template: false,
  };
}

/** `MAX_QUEUE_STEPS` such responses. */
export function ordinaryFullQueue(): ResponseConfig[] {
  return Array.from({ length: MAX_QUEUE_STEPS }, ordinaryFullResponse);
}

/**
 * Twenty header pairs filling D101's block of 8 KiB, their values `"`, which
 * JSON writes as two bytes, and the given body.
 */
export function escapedResponse(body: string): Record<string, unknown> {
  const names = Array.from(
    { length: MAX_RESPONSE_HEADERS },
    (_unused, index) => `x-h-${String(index).padStart(2, '0')}`,
  );
  const valueBytes = MAX_HEADER_BLOCK_BYTES - names.reduce((sum, name) => sum + name.length + 4, 0);
  const each = Math.min(MAX_HEADER_VALUE_BYTES, Math.floor(valueBytes / names.length));

  return {
    status: 599,
    headers: names.map((name) => [name, '"'.repeat(each)]),
    body,
    delayMs: MAX_RESPONSE_DELAY_MS,
  };
}

/** A response at every limit of D101 whose body is control characters, six bytes each in JSON. */
export function escapedFullResponse(): Record<string, unknown> {
  return escapedResponse('\u0001'.repeat(MAX_RESPONSE_BODY_BYTES));
}

/**
 * The body of `PUT .../queue` with ten steps of control characters, as long
 * as 1 MiB allows: what JSON writes them as is as long as what a client sends,
 * so the queue is as large in the event as in the call.
 */
export function largestQueueBody(): string {
  const empty = JSON.stringify({
    steps: Array.from({ length: MAX_QUEUE_STEPS }, () => escapedResponse('')),
  });
  const characters = Math.min(
    MAX_RESPONSE_BODY_BYTES,
    Math.floor((MAX_BODY_BYTES - Buffer.byteLength(empty)) / (6 * MAX_QUEUE_STEPS)),
  );

  return JSON.stringify({
    steps: Array.from({ length: MAX_QUEUE_STEPS }, () =>
      escapedResponse('\u0001'.repeat(characters)),
    ),
  });
}
