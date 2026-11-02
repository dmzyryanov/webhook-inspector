/**
 * What a `1005` refusal's `field` promises about its message (D257), for the
 * tests of the parsers and the routes: the message begins with the field and
 * a space, a header pair's name `[0]` and its value `[1]` read `name` and
 * `value` in it; a refusal of the body as a whole - a key the body may not
 * hold - carries no field.
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import assert from 'node:assert/strict';

/** The message's opening for `field`: `rules[0].response.headers[3] value` for `…headers[3][1]`. */
export function fieldLead(field: string): string {
  if (field.endsWith('][0]')) {
    return `${field.slice(0, -3)} name`;
  }

  if (field.endsWith('][1]')) {
    return `${field.slice(0, -3)} value`;
  }

  return field;
}

/** The one opening a `1005` without a field has: a key the body itself may not hold. */
export const BODY_KEY_REFUSAL = 'The request body may contain no key other than ';

/**
 * Asserts what a `1005`'s message and field say together: with a field, the
 * message begins with it; without one, the refusal is of a key the body may
 * not hold. `what` names the case in a failure.
 */
export function assertFieldLeadsMessage(
  refusal: { message: string; field?: string | undefined },
  what = '',
): void {
  if (refusal.field === undefined) {
    assert.ok(
      refusal.message.startsWith(BODY_KEY_REFUSAL),
      `${what}: no field for ${refusal.message}`,
    );

    return;
  }

  assert.ok(
    refusal.message.startsWith(`${fieldLead(refusal.field)} `),
    `${what}: ${refusal.field} does not lead ${refusal.message}`,
  );
}
