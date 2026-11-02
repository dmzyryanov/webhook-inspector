import { ErrorCode } from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { en, type Messages } from '../i18n/en.ts';

/**
 * What the home page says under `Generate URL` when the session could not be
 * created (issue #128), from whatever the creation rejected with.
 *
 * Only the address's limit on creations has words of its own: a `429` with
 * `errorCode` `1015 RATE_LIMIT_EXCEEDED` and a usable `Retry-After` names the
 * seconds to wait, one number from the refusal and no countdown. Everything
 * else - no answer at all, any other status, any other `429` code, a `1015`
 * without a usable `Retry-After`, or something that is not an `ApiError` -
 * asks to try again. A refused creation is not counted toward the limit, so
 * the tile stays clickable either way (`docs/API.md`, Limits). The page keeps
 * the error and asks for its text on every render, so the line follows the
 * interface's language (D222).
 */
export function createSessionFailureText(error: unknown, m: Messages = en): string {
  if (
    error instanceof ApiError &&
    error.status === 429 &&
    error.errorCode === ErrorCode.RATE_LIMIT_EXCEEDED &&
    error.retryAfterSeconds !== undefined
  ) {
    return m.landing.tooManySessions(error.retryAfterSeconds);
  }

  return m.landing.notCreated;
}
