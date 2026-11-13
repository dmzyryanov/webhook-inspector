/**
 * What the panel and the list row say about one request's recorded response
 * (D109, D119, D120, D124), and how each draws its status (D207).
 *
 * Kept away from the DOM because every difference between the states is a
 * decision about text, and because `failed` is unreachable from production and
 * from the browser suite: the unit test beside this file is the only place its
 * strings can be proven at all (D114).
 *
 * The vocabulary rule these strings obey is D113's: per-request surfaces say
 * *returned / sent / for this request*, and **no surface may be worded as a
 * delivery confirmation** (D103). `sent` means the backend finished writing the
 * response into the connection, and never that the sender received it. Its
 * state line, `Sent by server · …`, says exactly that much and no more, so a
 * normally finished write has no third line: the sentence that used to repeat
 * it - `Server finished writing the response. Client delivery is not
 * confirmed.` - was on nearly every response and said nothing (issue #51,
 * D158). A HEAD response keeps its note, and so does every other state.
 */
import {
  STATUSES_WITHOUT_BODY,
  type QueueStep,
  type RecordedRule,
  type ResponseRecord,
  type ResponseSummary,
  type RuleSummary,
} from '@webhook-inspector/shared';
import {
  formatBytesCompact,
  formatDetailTimestamp,
  formatReasonPhrase,
  formatResponseStatus,
  isFailureStatus,
} from './format.ts';
import { en, type Messages } from '../i18n/en.ts';

/** The separator the design uses between the segments of a line: U+00B7. */
const SEPARATOR = ' · ';

/*
 * Every text takes the interface's words, `m`, English by default (D222); the
 * constants are the English ones.
 */

/** Said in the narrow list-row slot where there is no response record (D119). */
export const LIST_ROW_NOT_RECORDED = en.record.notRecorded;

/** The fuller detail-panel form of the same condition. */
export const NO_RECORD_HEADING = en.record.noRecordHeading;
export const NO_RECORD_NOTE = en.record.noRecordNote;

/** The lines of the response header, top to bottom. */
export interface ResponseHeaderLines {
  /** `200 OK`, or `null` where the write threw before a status was composed. */
  statusLabel: string | null;
  /**
   * How the heading draws the status, by the record's state (D207): the code
   * in its class's pill, the reason phrase beside it in ink, for an answer the
   * session gave; otherwise the whole label, in ink or in red.
   */
  statusTone: HeadingStatusTone;
  /**
   * The reason phrase alone, `Internal Server Error`, drawn beside the pill;
   * `null` for a code that has none, `299`, which shows the pill alone, and
   * where there is no status.
   */
  reasonPhrase: string | null;
  /** How writing ended, and what of the response that leaves to show. */
  stateLine: string;
  /**
   * What that means, stated as a fact rather than as a label (D113), or `null`
   * for a finished write other than a HEAD's, whose state line says all there
   * is (D158).
   */
  note: string | null;
  /**
   * The step of the response queue that answered, `Queue step 2 of 7`, or
   * `null` when the session response did (D205, frames U7 and M5 of the Figma
   * page `Webhook Inspector · Response queue (#106) — chosen, review 2`). It is
   * drawn as a tag inside the state line, before its time.
   */
  queueStep: string | null;
  /**
   * The response rule that answered, as it was when it answered, `Rule 1 · POST
   * /orders`, or `null` when none did (D246, frames R8 and RP4 of the Figma
   * page `Webhook Inspector · Response rules (#134) — A APPROVED 2026-10-19`).
   * Drawn where the queue's step is, as a tag inside the state line, before its
   * time: a rule and a step never answer the same request.
   */
  rule: string | null;
  /**
   * The state line cut where the tag goes: everything before the time, and
   * the time, or `null` for a line without one. Joined by the separator they
   * are `stateLine`.
   */
  stateParts: { lead: string; time: string | null };
}

/**
 * `Queue step 2 of 7` (frame U7 of the Figma page `Webhook Inspector · Response
 * queue (#106) — chosen, review 2`).
 */
export function formatQueueStep(
  step: QueueStep | null | undefined,
  m: Messages = en,
): string | null {
  return step === null || step === undefined ? null : m.record.queueStep(step.index, step.total);
}

/**
 * `Rule 1 · POST /orders`, `Rule 3 · Any /items/*` (frame R8 of the Figma page
 * `Webhook Inspector · Response rules (#134) — A APPROVED 2026-10-19`): the
 * rule a request recorded, with what it matched on then, which a later change
 * of the rules leaves as it was. `null` for none, and for a record from a
 * backend before 1.3.0, which has no `rule` at all.
 */
export function formatRecordedRule(
  rule: RecordedRule | null | undefined,
  m: Messages = en,
): string | null {
  return rule === null || rule === undefined
    ? null
    : m.record.rule(rule.index, rule.method, rule.path);
}

/**
 * The status cell of a list row.
 *
 * It is never derived from the session configuration: a derived status beside
 * real ones stops reading as configuration and starts reading as an observation
 * the backend never made (D119). The configured status stays visible on the
 * endpoint card, where it is unambiguously configuration.
 */
export function formatListStatus(response: ResponseSummary | null, m: Messages = en): string {
  if (response === null) {
    return m.record.notRecorded;
  }

  // Read for up to 30 seconds where a configured delay holds the reply. That is
  // visible to the user, and it is intended: nothing has been written yet.
  if (response.state === 'pending') {
    return m.record.pending;
  }

  // Only `failed` can lack a status, and only by an injected write failure.
  return response.status === null ? m.record.failed : `${response.status}`;
}

/**
 * How the list row's status cell is drawn: `answered`, the code in the pill
 * of its class (D207); `failure`, red text; `neutral`, muted text.
 */
export type ListStatusTone = 'answered' | 'failure' | 'neutral';

/**
 * The look of the status cell, which follows the recorded **state** and not the
 * status alone (D207).
 *
 * The pill says "the session answered this, and this is what it answered", and
 * only a completed write can say that. A status is what the user configured,
 * so no class of it is an alarm or a reassurance: a `500` set on purpose to
 * check a retry is drawn in its class's tint rather than in red, and a `200`
 * is no longer green text. Deriving the look from the status alone would draw
 * two other cells as answers: `Failed`, where our own write threw, and
 * `Pending`, where nothing has been written at all - reachable in production
 * for as long as a configured delay holds the reply.
 *
 * `aborted` and `unknown` show the bare code, muted, whatever its class:
 * neither is an outcome the backend saw complete, and a tinted pill would claim
 * an answer the sender may never have received. The Response half's state line
 * says how the send ended. `failed` stays red, the one failure here that is
 * ours.
 */
export function listStatusTone(response: ResponseSummary | null): ListStatusTone {
  if (response === null) {
    return 'neutral';
  }

  switch (response.state) {
    // Nothing has been written yet, so nothing has been answered yet.
    case 'pending':
      return 'neutral';

    // Our own write threw, with or without a composed status (D109).
    case 'failed':
      return 'failure';

    case 'aborted':
    case 'unknown':
      return 'neutral';

    // Only `failed` can lack a status; the pill needs one to hold.
    case 'sent':
      return response.status === null ? 'neutral' : 'answered';
  }
}

/**
 * The marker a list row draws after its status for the response rule that
 * answered the request (issue #233; Figma page `Webhook Inspector · Rule
 * marker in the request list (#233) — approved A`): `R2` on screen, `П2` in
 * Russian, and `Answered by rule 2` as its title and in the row's accessible
 * name.
 */
export interface ListRuleMarker {
  text: string;
  title: string;
}

/**
 * The row's rule marker, or `null` where no rule answered: no response record,
 * a record the queue or the session response answered (`rule: null`), and a
 * record from a backend before 1.3.0, which has no `rule` at all. The summary
 * carries the rule's position alone, as it was when it answered (D246 point
 * 8): the rules saved since may put another rule in that place, so the row
 * names no method and no path, which the Response tab gives from the record.
 */
export function listRuleMarker(
  response: ResponseSummary | null,
  m: Messages = en,
): ListRuleMarker | null {
  // Typed as the summary says, but absent in a record an older backend sent.
  const rule: RuleSummary | null | undefined = response?.rule;

  return rule === null || rule === undefined
    ? null
    : { text: m.list.ruleMarker(rule.index), title: m.list.answeredByRule(rule.index) };
}

/**
 * How the Response half's heading draws the status: `answered`, the code in
 * the pill of its class with the reason phrase beside it in ink (D207);
 * `failure`, the whole label in red; `ink`, the whole label in ink.
 */
export type HeadingStatusTone = 'answered' | 'failure' | 'ink';

/**
 * The look of the heading's status, by state (D207).
 *
 * A completed write is an answer the session gave, and is drawn as one: the
 * pill, whatever its class, and never red or green text. `aborted` and
 * `unknown` keep the label in ink, uncoloured, for the reason the list keeps
 * them muted; their state line, just below, says the answer was not finished.
 * `pending` and `failed` are drawn as they were before the pill, red where the
 * prepared status is 400 or more and ink otherwise: neither is an answer the
 * session gave.
 */
export function headingStatusTone(
  record: Pick<ResponseRecord, 'state' | 'status'>,
): HeadingStatusTone {
  switch (record.state) {
    case 'sent':
      return record.status === null ? 'ink' : 'answered';

    case 'aborted':
    case 'unknown':
      return 'ink';

    case 'pending':
    case 'failed':
      return record.status !== null && isFailureStatus(record.status) ? 'failure' : 'ink';
  }
}

/**
 * The header lines for one recorded response: three, or two for a finished
 * write other than a HEAD's.
 *
 * The `HEAD` wording is driven by `bodySuppressed` rather than by the request
 * method: the flag is what the backend actually recorded about whether the
 * representation reached the wire (D064, D109), and the method is only the
 * usual reason for it.
 *
 * `timeZone` exists for tests, exactly as it does on `formatDetailTimestamp`.
 */
export function describeResponse(
  record: ResponseRecord,
  timeZone?: string,
  m: Messages = en,
): ResponseHeaderLines {
  const lines = describeStateLines(record, timeZone, m);
  const time =
    record.state === 'sent' && lines.stateLine.endsWith(timeOf(record, timeZone, m))
      ? timeOf(record, timeZone, m)
      : null;

  return {
    ...lines,
    statusTone: headingStatusTone(record),
    reasonPhrase: record.status === null ? null : formatReasonPhrase(record.status),
    queueStep: formatQueueStep(record.queueStep, m),
    rule: formatRecordedRule(record.rule, m),
    stateParts: {
      lead:
        time === null
          ? lines.stateLine
          : lines.stateLine.slice(0, -(SEPARATOR.length + time.length)),
      time,
    },
  };
}

/** The time a sent record's state line ends with. */
function timeOf(record: ResponseRecord, timeZone: string | undefined, m: Messages): string {
  return formatDetailTimestamp(record.completedAt ?? record.startedAt, timeZone, m);
}

function describeStateLines(
  record: ResponseRecord,
  timeZone: string | undefined,
  m: Messages,
): Omit<ResponseHeaderLines, 'statusTone' | 'reasonPhrase' | 'queueStep' | 'rule' | 'stateParts'> {
  const prepared =
    record.status === null ? m.record.noStatusComposed : m.record.prepared(record.status);

  switch (record.state) {
    case 'pending':
      return {
        statusLabel: statusLabel(record),
        stateLine: `${m.record.pending}${SEPARATOR}${m.record.configuredDelay(record.delayMs)}`,
        note: m.record.pendingNote,
      };

    case 'aborted':
      return {
        statusLabel: statusLabel(record),
        stateLine: `${m.record.aborted}${SEPARATOR}${prepared}`,
        note: m.record.abortedNote,
      };

    case 'unknown':
      return {
        statusLabel: statusLabel(record),
        stateLine: `${m.record.unknown}${SEPARATOR}${prepared}`,
        note: m.record.unknownNote,
      };

    /**
     * Not `Recording failed`, which is what the design frame draws and what
     * D120 and D124 both replace. D109 defines `failed` as the response having
     * been *formed* while our own *write* threw; telling a user of an inspector
     * that the recording failed says the tool lost their data, while the
     * prepared response is visible directly beneath the sentence.
     */
    case 'failed':
      return {
        statusLabel: statusLabel(record),
        stateLine: `${m.record.sendingFailed}${SEPARATOR}${prepared}`,
        note: m.record.sendingFailedNote,
      };

    case 'sent':
      return {
        statusLabel: statusLabel(record),
        stateLine: [m.record.sentByServer, ...sentSegments(record, timeZone, m)].join(SEPARATOR),
        note: record.bodySuppressed ? m.record.headNote : null,
      };
  }
}

/**
 * What a completed write leaves worth saying after `Sent by server`.
 *
 * The order matters: a suppressed body and a binary record are facts about the
 * whole record, while the size and the time only describe a body that exists
 * and is readable as text. This is the one state line that carries a time, and
 * it is written the way the detail panel writes one (D148).
 */
function sentSegments(record: ResponseRecord, timeZone: string | undefined, m: Messages): string[] {
  if (record.bodySuppressed) {
    return ['HEAD', m.record.bodyNotSent];
  }

  if (record.isBinary) {
    return [m.record.binaryRecord];
  }

  if (record.status !== null && STATUSES_WITHOUT_BODY.includes(record.status)) {
    return ['0 B'];
  }

  if (record.body === null) {
    return [m.record.customResponse];
  }

  return [
    formatBytesCompact(record.bodySize),
    formatDetailTimestamp(record.completedAt ?? record.startedAt, timeZone, m),
  ];
}

function statusLabel(record: ResponseRecord): string | null {
  return record.status === null ? null : formatResponseStatus(record.status);
}
