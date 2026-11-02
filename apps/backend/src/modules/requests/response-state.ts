import {
  RESPONSE_UNKNOWN_GRACE_MS,
  type QueueStep,
  type RecordedRule,
  type ResponseState,
  type RuleSummary,
} from '@webhook-inspector/shared';

/**
 * The state a stored record reads as.
 *
 * `pending`, `sent`, `aborted` and `failed` are stored and read back unchanged.
 * `unknown` is **derived here and never stored** (D109): a record still
 * `pending` past its own configured delay plus the shared grace has aged out,
 * which is what a process restart inside the delay window leaves behind. The
 * grace comes from `packages/shared` so the list endpoint, the detail endpoint
 * and the WebSocket payload cannot disagree about when that happens.
 *
 * Nothing is published when a record crosses this line: there is no write to
 * hang an event on, and the reading is observed on reload or reselect (D110).
 */
export function readResponseState(
  stored: string,
  delayMs: number,
  startedAt: Date,
  now: number = Date.now(),
): ResponseState {
  if (stored !== 'pending') {
    return stored as ResponseState;
  }

  return now - startedAt.getTime() > delayMs + RESPONSE_UNKNOWN_GRACE_MS ? 'unknown' : 'pending';
}

/**
 * The step a response record names, or `null` when the session response
 * answered (D205). The two columns are `NULL` together, which a constraint of
 * migration 010 holds; one alone reads as no step rather than half of one.
 */
export function toRecordedQueueStep(index: number | null, total: number | null): QueueStep | null {
  return index === null || total === null ? null : { index, total };
}

/**
 * The response rule a record names, by its position, or `null` when no rule
 * answered (D246) - every record written before migration 017, or by the
 * previous image, included.
 */
export function toRecordedRuleSummary(index: number | null): RuleSummary | null {
  return index === null ? null : { index };
}

/**
 * The rule a record names with what it matched on as it was then, for the
 * detail (D246). A constraint of migration 017 keeps the path present beside
 * the position; one missing reads as no rule rather than half of one.
 */
export function toRecordedRule(
  index: number | null,
  method: string | null,
  path: string | null,
): RecordedRule | null {
  return index === null || path === null ? null : { index, method, path };
}
