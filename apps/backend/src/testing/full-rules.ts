/**
 * Response rules at the limits (D246), for the tests that hold them within
 * the 1 MiB body of the JSON routes: rules whose responses are at every limit
 * of D101 in ordinary text - fourteen fit in a save and fifteen
 * do not - twenty of ordinary size, and rules as large as 1 MiB admits written
 * with text JSON escapes, which is as large in an event as in the call.
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import {
  MAX_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_RULES,
  type ResponseRule,
} from '@webhook-inspector/shared';
import { escapedResponse, ordinaryFullResponse } from './full-queue.ts';

/** How many rules at every limit of D101, in ordinary text, 1 MiB holds. */
export const FULL_RULES_IN_A_BODY = 14;

/** `count` rules, each `POST /full/<n>` answered by a response at every limit. */
export function ordinaryFullRules(count: number = FULL_RULES_IN_A_BODY): ResponseRule[] {
  return Array.from({ length: count }, (_unused, index) => ({
    method: 'POST',
    path: `/full/${index + 1}`,
    response: ordinaryFullResponse(),
  }));
}

/**
 * `MAX_RESPONSE_RULES` rules of an ordinary size: a JSON body of 2 KiB, a few
 * headers, each on a path of its own and every fourth for any method.
 */
export function ordinaryRules(): ResponseRule[] {
  return Array.from({ length: MAX_RESPONSE_RULES }, (_unused, index) => ({
    method: index % 4 === 3 ? null : 'GET',
    path: index % 5 === 4 ? `/api/v1/items/${index}/*` : `/api/v1/items/${index}`,
    response: {
      status: 210 + index,
      headers: [
        ['content-type', 'application/json'],
        ['x-rule', String(index + 1)],
      ],
      body: JSON.stringify({ rule: index + 1, filler: 'x'.repeat(2048) }),
      delayMs: index * 10,
      template: false,
    },
  }));
}

/**
 * The body of `PUT .../rules` with twenty rules whose responses are
 * escapedResponse's - header values of quotes - and bodies of control
 * characters, six bytes each in JSON, as long as 1 MiB allows.
 */
export function largestRulesBody(): string {
  const rulesOf = (characters: number) => ({
    rules: Array.from({ length: MAX_RESPONSE_RULES }, () => ({
      method: null,
      path: '/*',
      response: escapedResponse('\u0001'.repeat(characters)),
    })),
  });
  const empty = Buffer.byteLength(JSON.stringify(rulesOf(0)));
  const characters = Math.min(
    MAX_RESPONSE_BODY_BYTES,
    Math.floor((MAX_BODY_BYTES - empty) / (6 * MAX_RESPONSE_RULES)),
  );

  return JSON.stringify(rulesOf(characters));
}
