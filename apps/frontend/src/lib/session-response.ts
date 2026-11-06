/**
 * How the session's response is named and summarised wherever it is not being
 * edited: the endpoint-card button, the toast after a change, the default
 * response's description and the summary of a kept custom response (D150,
 * D151).
 *
 * Every one of these is a decision about text rather than about layout, so it
 * lives here, away from the DOM, where a unit test reaches it (D070, D114).
 * The session-level vocabulary is *configured / settings*, and nothing here may
 * read as a delivery confirmation (D103, D113).
 */
import type {
  QueueStep,
  ResponseConfig,
  ResponseQueue,
  ResponseRule,
  SessionResponseState,
} from '@webhook-inspector/shared';
import { en, type Messages } from '../i18n/en.ts';
import { applyQueueCleared, applyQueueStep, formatQueuedSuffix } from './response-queue.ts';
import { formatRulesSuffix } from './response-rules.ts';

/** What a session answering the default responds with (D102). */
export const DEFAULT_STATUS = 200;

/** The separator the design uses between the segments of a label: U+00B7. */
const SEPARATOR = ' · ';

export type ResponseMode = 'default' | 'custom';

/** Which of the two a session answers with. */
export function responseMode(state: Pick<SessionResponseState, 'response'>): ResponseMode {
  return state.response === null ? 'default' : 'custom';
}

/**
 * The custom response the session keeps, active or not.
 *
 * A backend from before D151 sends no `customResponse` at all; there the
 * active response is the only custom one there is, so it is read instead. That
 * is what keeps this bundle working while the backend it talks to is the
 * previous image - during a rollout, or after a rollback.
 */
export function keptCustomResponse(state: {
  response: ResponseConfig | null;
  customResponse?: ResponseConfig | null;
}): ResponseConfig | null {
  return state.customResponse ?? state.response;
}

/**
 * The label of the endpoint-card button: the mode, the bare status and the
 * delay only when there is one - `Default · 200`, `Custom · 201 · 500 ms`
 * (D107, D150) - and the steps of the response queue still to answer,
 * `Custom · 200 · 6 queued`, dropped once none is left (D205, U6, U7) - and
 * the response rules the session holds after it, `Custom · 200 · 6 queued ·
 * 3 rules` (D246, issue #226). A custom session answering `200`
 * is never presented as a default one.
 *
 * The status is the number alone. A reason phrase would push the button wide
 * enough to squeeze the receive URL it shares a row with.
 */
export function formatResponseButtonLabel(
  response: ResponseConfig | null,
  queue: ResponseQueue | null = null,
  m: Messages = en,
  rules: readonly ResponseRule[] = [],
): string {
  const segments =
    response === null
      ? [m.response.default, `${DEFAULT_STATUS}`]
      : [m.response.custom, `${response.status}`];

  if (response !== null && response.delayMs > 0) {
    segments.push(`${response.delayMs} ms`);
  }

  const queued = formatQueuedSuffix(queue, m);

  if (queued !== null) {
    segments.push(queued);
  }

  const ruled = formatRulesSuffix(rules, m);

  if (ruled !== null) {
    segments.push(ruled);
  }

  return segments.join(SEPARATOR);
}

/**
 * The button's accessible name: its visible label first, so a person naming
 * what they see reaches it, then what it opens, which the caret only draws.
 */
export function formatResponseButtonName(
  response: ResponseConfig | null,
  queue: ResponseQueue | null = null,
  m: Messages = en,
  rules: readonly ResponseRule[] = [],
): string {
  return `${formatResponseButtonLabel(response, queue, m, rules)}${SEPARATOR}${m.response.settings}`;
}

/** A delay as a summary line writes it: `none`, `500 ms`. */
export function formatDelaySummary(delayMs: number, m: Messages = en): string {
  return delayMs === 0 ? m.response.delayNone : `${delayMs} ms`;
}

/**
 * What the default answers, in the design's words (C4, D6), in English; the
 * switch says the dictionary's `response.defaultSummary`.
 */
export const DEFAULT_RESPONSE_SUMMARY = en.response.defaultSummary;

/**
 * A kept custom response in one line: `201 · 500 ms · 1 header · body`.
 * Every part is said, absent ones included, so a missing segment is never left
 * to mean either "none" or "not shown".
 */
export function describeKeptResponse(custom: ResponseConfig, m: Messages = en): string {
  const headers = custom.headers.length;

  return [
    `${custom.status}`,
    custom.delayMs > 0 ? `${custom.delayMs} ms` : m.response.noDelay,
    headers === 0 ? m.response.noHeaders : m.response.headers(headers),
    custom.body === null ? m.response.noBody : m.response.body,
  ].join(SEPARATOR);
}

/**
 * The quick switch's line under the default when a custom response is kept
 * (C4): picking the default keeps the custom response (D151).
 */
export function formatKeptNote(custom: ResponseConfig, m: Messages = en): string {
  return m.response.keptNote(describeKeptResponse(custom, m));
}

/**
 * The full editor's line under the default when a custom response is kept
 * (D6), in English; the editor says the dictionary's.
 */
export const EDITOR_KEPT_NOTE = en.response.editorKeptNote;

/**
 * The toast after the quick switch applied a change (C3): what the session now
 * answers, and that only requests captured from now on get it. It says what is
 * configured, never what a sender received (D103).
 */
export function formatAppliedToast(response: ResponseConfig | null, m: Messages = en): string {
  return response === null
    ? m.response.appliedDefault(DEFAULT_STATUS)
    : m.response.applied(response.status, response.delayMs);
}

/** The toast after the full editor saved (D3), in English. */
export const SAVED_TOAST = en.response.saved;

/**
 * A session with its response state replaced: by a state the page took -
 * `session.updated` from any viewer, the answer to this viewer's own change,
 * a capture or a clear that moved the queue, a session read - (D152). The
 * whole state is replaced rather than merged, so applying the same one twice
 * changes nothing, and a page that holds no session yet keeps holding none.
 */
export function applyResponseState<T extends SessionResponseState>(
  session: T | null,
  state: SessionResponseState,
): T | null {
  if (session === null) {
    return null;
  }

  return {
    ...session,
    response: state.response,
    customResponse: state.customResponse,
    // A backend from before 0.46.0 sends no queue (D205).
    queue: state.queue ?? null,
    // A backend from before 1.3.0 sends no rules - during a rolling update
    // too - which says nothing about the rules the session holds: they are
    // saved, ignored by that image and answering again after it (D246), so
    // the page keeps the rules it holds rather than reading none.
    rules: state.rules ?? (session.rules as SessionResponseState['rules'] | undefined) ?? [],
  };
}

/** The rules a state says, or `undefined` for a state from a backend before 1.3.0, which says none (D246). */
function saidRules(state: SessionResponseState | null): ResponseRule[] | undefined {
  return state?.rules as ResponseRule[] | undefined;
}

/**
 * The response state of a session: its response, its kept custom one, its
 * queue and its rules.
 *
 * A state without `rules` - from a backend before 1.3.0, the previous image
 * during a rolling update or after a rollback - says nothing about the rules
 * (D246), so the state answered has no `rules` either rather than `[]`:
 * spread over the state the page holds (`applyResponseEvent`), it leaves the
 * rules shown as they are, where `[]` cleared them although they stayed
 * saved (#134, fixed with #226). Every reader of the rules
 * reads an absent list as none (`heldRules`).
 */
export function responseStateOf(session: SessionResponseState): SessionResponseState {
  const state = {
    response: session.response,
    customResponse: session.customResponse,
    // A backend from before 0.46.0 sends no queue (D205).
    queue: session.queue ?? null,
  };
  const rules = saidRules(session);

  return (rules === undefined ? state : { ...state, rules }) as SessionResponseState;
}

/**
 * A state with the rules `held` says where it says none itself: a read or an
 * answer from a backend before 1.3.0 keeps the rules the page shows, as an
 * event from one does (D246).
 */
function keepingHeldRules<T extends SessionResponseState>(
  state: T,
  held: SessionResponseState | null,
): T {
  const rules = saidRules(held);

  return saidRules(state) !== undefined || rules === undefined ? state : { ...state, rules };
}

/**
 * What the socket says about the session's response state (D152, D205):
 * `session.updated`, which carries the whole state, a capture that took a
 * step of the response queue, which its `request.received` names, and a
 * clear, which starts the queue from step 1.
 *
 * Each is absolute rather than a difference: the state it carries, the step
 * after the one taken of a queue of that step's length, step 1. So a
 * `session.updated` or a clear taken over a state that already holds it
 * changes nothing, and one taken over a state from before it brings that
 * state forward; a step sets `next` to the one after it, which moves a state
 * that already holds a later step back until that step's own event arrives
 * (D205, Accepted consequences). That is what lets a session read be
 * answered with the events taken while it was in flight applied on top
 * (`settleSessionRead`).
 */
export type ResponseEvent =
  | { type: 'updated'; state: SessionResponseState }
  | { type: 'step'; step: QueueStep }
  | { type: 'cleared' };

/** A state with an event taken: the same object when the event changes nothing in it. */
export function applyResponseEvent<T extends SessionResponseState>(
  state: T,
  event: ResponseEvent,
): T {
  switch (event.type) {
    case 'updated':
      return { ...state, ...responseStateOf(event.state) };
    case 'step':
      return applyQueueStep(state, event.step);
    case 'cleared':
      return applyQueueCleared(state);
  }
}

/**
 * The events a read in flight has taken, newest first: each event taken
 * points at the log before it, which it shares rather than copies, so taking
 * one costs the same however many came before (a copy of the whole log on
 * every event would make a long burst quadratic). `null` is a log of none.
 */
export interface EventLog {
  event: ResponseEvent;
  earlier: EventLog | null;
}

/** The events of a log, oldest first: the order they arrived in. */
export function eventsOf(log: EventLog | null): ResponseEvent[] {
  const events: ResponseEvent[] = [];

  for (let at = log; at !== null; at = at.earlier) {
    events.push(at.event);
  }

  return events.reverse();
}

/**
 * A session read in flight: the order it began in, the events taken since,
 * and the newest `rules` a `session.updated` among them said, `undefined`
 * while none said any.
 *
 * The rules are kept apart from the log because a `session.updated` starts
 * the log afresh (`withEvent`), and one from a backend before 1.3.0 says no
 * rules: it would drop the rules an event before it said, and the read's own
 * rules - older than them - would be shown in their place.
 */
export interface SessionReadInFlight {
  order: number;
  log: EventLog | null;
  rules: ResponseRule[] | undefined;
}

/**
 * The last `session.updated` the page took, and the `revision` taking it
 * moved the page to: what tells the answer to the viewer's own call whether
 * the page has taken the call's own event since it started (`ownChangeState`).
 */
export interface UpdatedTaken {
  state: SessionResponseState;
  revision: number;
}

/**
 * The response state the page shows, and what it needs to take what comes
 * next (D152, D205).
 *
 * `state` is what the page shows of the response, `null` until it has
 * applied a session read. Every change to it goes through here first: an
 * event (`recordResponseEvent`), a read (`settleSessionRead`) and the answer
 * to the viewer's own call (`recordOwnAnswer`).
 *
 * `reads` are the session reads in flight, each with the events taken since
 * it began, in the order they arrived; `begun` counts the reads begun and
 * `newestApplied` is the order of the newest one applied, so a read that
 * began before it is older than what the page shows (`settleSessionRead`).
 *
 * `revision` moves with everything the page takes - an event that changes
 * what it shows or carries a whole state, a read applied, an answer taken -
 * and is what the answer to the viewer's own call compares against.
 * `lastUpdated` is the last `session.updated` taken, or `null` for none.
 * `queueStartedAt` is the `revision` taking the last `session.updated` whose
 * queue is at step 1 moved the page to, or `null` for none
 * (`queueStartedSince`).
 */
export interface HeldResponseState {
  state: SessionResponseState | null;
  revision: number;
  reads: readonly SessionReadInFlight[];
  begun: number;
  newestApplied: number;
  lastUpdated: UpdatedTaken | null;
  queueStartedAt: number | null;
}

export const NO_RESPONSE_STATE: HeldResponseState = {
  state: null,
  revision: 0,
  reads: [],
  begun: 0,
  newestApplied: 0,
  lastUpdated: null,
  queueStartedAt: null,
};

/**
 * A read's log with one more event, the log before it shared, not copied: a
 * `session.updated` replaces the whole state, so nothing taken before it
 * changes what a replay ends with, and the log keeps it alone - but for the
 * rules, which one from a backend before 1.3.0 does not say, and which the
 * read keeps apart for that reason (`withRead`).
 */
function withEvent(log: EventLog | null, event: ResponseEvent): EventLog {
  return { event, earlier: event.type === 'updated' ? null : log };
}

/** A read in flight with one more event taken: its log, and the newest rules said. */
function withRead(read: SessionReadInFlight, event: ResponseEvent): SessionReadInFlight {
  const said = event.type === 'updated' ? saidRules(event.state) : undefined;

  return {
    order: read.order,
    log: withEvent(read.log, event),
    rules: said ?? read.rules,
  };
}

/**
 * An event from the socket: applied at once to what the page shows, and kept
 * by every read in flight, to be applied again on top of what the read
 * answers. Answers `held` itself when it changes nothing and no read is in
 * flight. A page that shows no state yet has nothing to apply it to; its
 * reads in flight keep it all the same.
 */
export function recordResponseEvent(
  held: HeldResponseState,
  event: ResponseEvent,
): HeldResponseState {
  const state = held.state === null ? null : applyResponseEvent(held.state, event);
  const moved = event.type === 'updated' || state !== held.state;

  if (!moved && held.reads.length === 0) {
    return held;
  }

  const revision = moved ? held.revision + 1 : held.revision;

  return {
    ...held,
    state,
    revision,
    reads: held.reads.map((read) => withRead(read, event)),
    lastUpdated:
      event.type === 'updated'
        ? { state: responseStateOf(event.state), revision }
        : held.lastUpdated,
    queueStartedAt:
      event.type === 'updated' && event.state.queue?.next === 1 ? revision : held.queueStartedAt,
  };
}

/** A session read begun: on mount or on a socket's `ready` (D133). */
export function beginSessionRead(held: HeldResponseState): {
  held: HeldResponseState;
  order: number;
} {
  const order = held.begun + 1;

  return {
    held: { ...held, begun: order, reads: [...held.reads, { order, log: null, rules: undefined }] },
    order,
  };
}

/** A session read that will not be applied: it failed, or its page left. */
export function abandonSessionRead(held: HeldResponseState, order: number): HeldResponseState {
  return { ...held, reads: held.reads.filter((read) => read.order !== order) };
}

/**
 * A session read answered (D152, D205), and what the page then shows:
 * `shown` is the session to show, or `null` when the read is not applied.
 *
 * The page reads its session on mount and on every `ready` (D133). The read
 * may have been taken by the server before or after any event that arrived
 * while it was in flight, so neither the read nor the page's own state is
 * newer as a whole: a `session.updated`, a capture that took a step or a
 * clear can land between the read's query and its answer, and a change made
 * while the socket was down reaches the page only through the read. So the
 * read is applied with every event taken since it began applied on top, in
 * the order they arrived, and with the newest rules any of them said, which
 * a later `session.updated` from a backend before 1.3.0 does not undo
 * (D246). A `session.updated` or a clear the read already
 * holds changes nothing, and one it does not hold brings it forward; a step
 * sets `next` to the one after it, which the next event sets right when the
 * read already held a later one (D205, Accepted consequences). An event that
 * arrives after the answer is applied to it as it arrives.
 *
 * A read that began before the newest read applied is older than what the
 * page shows - that read holds whatever this one could, and the events since
 * - so it is not applied at all, as a list load answering after a later one
 * is not (#39). Of two reads in flight, then, neither undoes the other.
 */
export function settleSessionRead<T extends SessionResponseState>(
  held: HeldResponseState,
  order: number,
  read: T,
): { held: HeldResponseState; shown: T | null } {
  const inFlight = held.reads.find((candidate) => candidate.order === order);
  const reads = held.reads.filter((candidate) => candidate.order !== order);

  if (inFlight === undefined || order < held.newestApplied) {
    return { held: { ...held, reads }, shown: null };
  }

  // A read from a backend before 1.3.0 says no rules: the page keeps its own (D246).
  const replayed = eventsOf(inFlight.log).reduce<T>(
    (state, event) => applyResponseEvent(state, event),
    keepingHeldRules(read, held.state),
  );
  // The newest rules an event in the read's window said are newer than the
  // read's, though a later event from an older image dropped that event from
  // the log (`SessionReadInFlight`).
  const shown = inFlight.rules === undefined ? replayed : { ...replayed, rules: inFlight.rules };

  return {
    held: {
      state: responseStateOf(shown),
      revision: held.revision + 1,
      reads,
      begun: held.begun,
      newestApplied: order,
      lastUpdated: held.lastUpdated,
      queueStartedAt: held.queueStartedAt,
    },
    shown,
  };
}

/**
 * The answer to this viewer's own call - a response changed, a queue saved,
 * restarted or removed - started when the page's `revision` was `startedAt`
 * (D152, D205). Taken only when the page has taken nothing since the call
 * started - no event, no read, no other answer; otherwise answers `held`
 * itself.
 *
 * The change's own `session.updated` is published before its answer is
 * written, on another connection, and a capture that takes a step of the
 * queue can follow it: an answer arriving after them would put the queue back
 * a step, `Done` back to `1 queued`, and nothing after it would set that
 * right, since later requests carry no step. The state shown never needs an
 * answer set aside: its own
 * event, published before the answer, reaches a page whose socket is
 * connected - usually before the answer, at times after it - and a read the
 * page took meanwhile was started on a `ready`, so either after that
 * publish, holding the change, or on a socket that then received it; a page
 * whose socket is down reads the session on its next `ready` (D133). The
 * toast about the change may need it, when its own event has not arrived yet
 * (`ownChangeState`).
 *
 * For the same reason an answer is not kept by the reads in flight: the
 * change's event, which a read in flight does keep, says the same and comes
 * in its place among the events, so a capture after it is not undone.
 */
export function recordOwnAnswer(
  held: HeldResponseState,
  state: SessionResponseState,
  startedAt: number,
): HeldResponseState {
  return held.revision === startedAt
    ? {
        ...held,
        state: keepingHeldRules(responseStateOf(state), held.state),
        revision: held.revision + 1,
      }
    : held;
}

function sameResponseConfig(left: ResponseConfig | null, right: ResponseConfig | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  // A state from a backend before 1.9.0 carries no `template`: no template.
  return (
    left.status === right.status &&
    left.delayMs === right.delayMs &&
    left.body === right.body &&
    (left.template === true) === (right.template === true) &&
    left.headers.length === right.headers.length &&
    left.headers.every(
      ([name, value], index) =>
        name === right.headers[index]?.[0] && value === right.headers[index]?.[1],
    )
  );
}

/**
 * Whether two response states say the same: response, kept custom response,
 * queue and rules. A state without `rules`, from a backend before 1.3.0, says
 * nothing about them, so two states are not told apart by them when either
 * lacks them (D246).
 */
export function sameResponseState(
  left: SessionResponseState,
  right: SessionResponseState,
): boolean {
  const leftQueue = left.queue ?? null;
  const rightQueue = right.queue ?? null;
  const leftRules = left.rules as SessionResponseState['rules'] | undefined;
  const rightRules = right.rules as SessionResponseState['rules'] | undefined;

  return (
    sameResponseConfig(left.response, right.response) &&
    sameResponseConfig(left.customResponse ?? null, right.customResponse ?? null) &&
    (leftQueue === null || rightQueue === null
      ? leftQueue === rightQueue
      : leftQueue.next === rightQueue.next &&
        leftQueue.total === rightQueue.total &&
        leftQueue.steps.length === rightQueue.steps.length &&
        leftQueue.steps.every((step, index) =>
          sameResponseConfig(step, rightQueue.steps[index] ?? null),
        )) &&
    (leftRules === undefined ||
      rightRules === undefined ||
      (leftRules.length === rightRules.length &&
        leftRules.every((rule, index) => {
          const other = rightRules[index];

          return (
            other !== undefined &&
            rule.method === other.method &&
            rule.path === other.path &&
            sameResponseConfig(rule.response, other.response)
          );
        })))
  );
}

/**
 * The response state a toast about this viewer's own change describes (U6,
 * U9), from the page as it was when the answer to a call started at
 * `startedAt` arrived, and that answer's `state` (D205).
 *
 * - The answer taken: the answer, which is then what the page shows.
 * - Set aside, and the last `session.updated` the page took, taken since the
 *   call started, says what the answer says - the change's own event: what
 *   the page shows, which holds the change and whatever a capture or a clear
 *   did after it. A capture may already have taken step 1 of the queue saved
 *   or started again.
 * - Set aside for anything else: the answer. The page then shows the state
 *   from before the change - a capture of the queue being replaced or
 *   another viewer's change arrived during the call, and the change's own
 *   event comes after its answer, which happens though it usually comes
 *   first - or the state after another viewer's later change. The toast says
 *   what this viewer's call did, and the label follows the events.
 *
 * A read applied during the call that already holds the change, on a socket
 * that came back after the change's event was published, is not told from
 * one that does not: the toast then says the answer.
 */
export function ownChangeState(
  held: HeldResponseState,
  state: SessionResponseState,
  startedAt: number,
): SessionResponseState {
  const taken = held.lastUpdated;

  if (
    held.revision !== startedAt &&
    held.state !== null &&
    taken !== null &&
    taken.revision > startedAt &&
    sameResponseState(taken.state, state)
  ) {
    return held.state;
  }

  return responseStateOf(state);
}

/**
 * Whether the page has taken, since a call started when its `revision` was
 * `startedAt`, a `session.updated` whose queue is at step 1 (D205): the
 * session's queue was started from step 1 meanwhile - saved, or started
 * again, by this viewer's call or another's - whatever captures did after
 * it.
 *
 * It is what a failed `Run again` asks before it says so. `Run again` is
 * offered on a used-up queue only, and a restart whose answer was lost
 * usually has its own event arrive first: with a queue of one step, a capture
 * can then take that step and show `Done` again before the failure is known,
 * and `Could not start the queue again. Try again.` beside it would be
 * untrue. A read
 * applied during the call that already holds the restart, with no event, is
 * not told apart, as `ownChangeState` does not tell it apart.
 */
export function queueStartedSince(held: HeldResponseState, startedAt: number): boolean {
  return held.queueStartedAt !== null && held.queueStartedAt > startedAt;
}

/**
 * What a surface hands the page when its own call is answered: the state the
 * answer carries and the page's `revision` when the call started, which the
 * surface reads from the page just before calling (`recordOwnAnswer`).
 */
export type OwnAnswerHandler = (state: SessionResponseState, startedAt: number) => void;

/**
 * What the page does with such an answer: takes it or sets it aside, and
 * answers the response state a toast about the change describes
 * (`ownChangeState`).
 */
export type OwnAnswerTaker = (
  state: SessionResponseState,
  startedAt: number,
) => SessionResponseState;

/**
 * Whether a settings surface stays open when something asks it to close
 * (C7-C8, D7-D8). While a change is being saved it does: Escape, a click
 * outside and the button that opened it are all ignored, so the answer - and a
 * failure in particular, with the choices it keeps - still has a surface to be
 * shown on. Cancel is disabled for the same reason.
 */
export function staysOpen(requestedOpen: boolean, saving: boolean): boolean {
  return requestedOpen || saving;
}
