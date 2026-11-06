/**
 * Presentation helpers.
 *
 * These hold the only real logic on the frontend, so they are the only part
 * covered by tests (D025, D061).
 */
import { en, type Messages } from '../i18n/en.ts';

/**
 * The one way a size is written anywhere in the application: `61 B`, `1.4 KB`,
 * `1.0 MB`.
 *
 * There used to be a second, long form - `61 bytes` - for the list rows, and
 * the two were a documented split between a row and a summary (D014). It was
 * closed in favour of the compact form everywhere, so `formatBytes` is gone
 * rather than left beside this one: two functions differing only in their units
 * are an invitation for the split to come back (D014, D071).
 */
export function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Absolute time in the viewer's own timezone (D042), as a list row writes it:
 * `2026-09-17 14:32:06`. The backend sends UTC; the timeZone argument exists so
 * tests can pin a zone instead of depending on the machine running them.
 *
 * The detail panel writes the same instant with `formatDetailTimestamp` below
 * (D148): a row is a compact column to scan, the panel is read.
 */
export function formatTimestamp(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

/**
 * Absolute time in the viewer's own timezone (D042), as the detail panel writes
 * it: `17 Sep 2026, 14:32:06`, and `5 Sep 2026, 00:02:06` - the day without a
 * leading zero, a 24-hour clock whose midnight is `00`, seconds always (D148).
 * In Russian the same order with the dictionary's genitive month,
 * `17 сент. 2026, 14:32:06` (D222).
 *
 * Only the numbers come from `Intl`, which is what applies the timezone; the
 * month name and the order are assembled here, the month from a fixed table in
 * the dictionary rather than from a locale: `en-GB` spells September `Sept` in
 * current ICU, and `en-US` puts the month before the day, so no locale's own
 * pattern gives the design's string (D148). `timeZone` exists for tests, as it
 * does on `formatTimestamp`.
 */
export function formatDetailTimestamp(iso: string, timeZone?: string, m: Messages = en): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // Not `hour12: false`, which some engines render as `24` at midnight.
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const month = m.months[Number(value('month')) - 1] ?? '';

  return `${value('day')} ${month} ${value('year')}, ${value('hour')}:${value('minute')}:${value('second')}`;
}

/**
 * The reason phrases of the registered status codes, used only for display.
 *
 * A status is accepted anywhere in 200-599, registered or not (D101), so this
 * is a lookup for a nicer label and never a check: an unregistered code in
 * range is rendered as the bare number.
 */
const STATUS_REASON_PHRASES = new Map<number, string>([
  [200, 'OK'],
  [201, 'Created'],
  [202, 'Accepted'],
  [203, 'Non-Authoritative Information'],
  [204, 'No Content'],
  [205, 'Reset Content'],
  [206, 'Partial Content'],
  [207, 'Multi-Status'],
  [208, 'Already Reported'],
  [226, 'IM Used'],
  [300, 'Multiple Choices'],
  [301, 'Moved Permanently'],
  [302, 'Found'],
  [303, 'See Other'],
  [304, 'Not Modified'],
  [305, 'Use Proxy'],
  [307, 'Temporary Redirect'],
  [308, 'Permanent Redirect'],
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [402, 'Payment Required'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [405, 'Method Not Allowed'],
  [406, 'Not Acceptable'],
  [407, 'Proxy Authentication Required'],
  [408, 'Request Timeout'],
  [409, 'Conflict'],
  [410, 'Gone'],
  [411, 'Length Required'],
  [412, 'Precondition Failed'],
  [413, 'Content Too Large'],
  [414, 'URI Too Long'],
  [415, 'Unsupported Media Type'],
  [416, 'Range Not Satisfiable'],
  [417, 'Expectation Failed'],
  [418, "I'm a Teapot"],
  [421, 'Misdirected Request'],
  [422, 'Unprocessable Content'],
  [423, 'Locked'],
  [424, 'Failed Dependency'],
  [425, 'Too Early'],
  [426, 'Upgrade Required'],
  [428, 'Precondition Required'],
  [429, 'Too Many Requests'],
  [431, 'Request Header Fields Too Large'],
  [451, 'Unavailable For Legal Reasons'],
  [500, 'Internal Server Error'],
  [501, 'Not Implemented'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
  [504, 'Gateway Timeout'],
  [505, 'HTTP Version Not Supported'],
  [506, 'Variant Also Negotiates'],
  [507, 'Insufficient Storage'],
  [508, 'Loop Detected'],
  [510, 'Not Extended'],
  [511, 'Network Authentication Required'],
]);

/**
 * The session's configured response status, as the request list and the detail
 * summary show it: `201 Created` where there is a reason phrase to show, `299`
 * where there is not.
 */
export function formatResponseStatus(status: number): string {
  const phrase = STATUS_REASON_PHRASES.get(status);

  return phrase === undefined ? `${status}` : `${status} ${phrase}`;
}

/** The reason phrase of a registered status, `Service Unavailable`, or `null`. */
export function formatReasonPhrase(status: number): string | null {
  return STATUS_REASON_PHRASES.get(status) ?? null;
}

/**
 * Whether a prepared status is drawn in red in the Response half's heading
 * while it is not an answer the session gave: `pending`, and `failed`, where
 * our own write threw (`headingStatusTone`). A status the session gave is never
 * red or green text: it is drawn in the pill of its class, a configured `500`
 * as a fact rather than as an alarm of ours (D207).
 */
export function isFailureStatus(status: number): boolean {
  return status >= 400;
}

/** The title the page carries when nothing is waiting to be read, in English. */
export const BASE_DOCUMENT_TITLE = en.title.base;

/**
 * The browser tab title, which is the only place an unread count appears
 * (D014): `(5) Webhook Inspector`.
 */
export function formatDocumentTitle(unreadCount: number, m: Messages = en): string {
  return unreadCount > 0 ? m.title.unread(unreadCount) : m.title.base;
}

/**
 * How many characters of the receive URL stay after the ellipsis where it is
 * too long for its field (D157): the end of the session id, `…mQxA`, as the
 * phone frames draw it and as the not-found screens shorten an id.
 */
export const RECEIVE_URL_TAIL = 4;

/**
 * A text cut in two for a middle ellipsis that CSS draws, at any width and
 * with no measuring: `head` truncates with an ellipsis at its end and `tail` is
 * always shown after it. Where the whole text fits, the two halves simply sit
 * side by side and read as the text (D157).
 *
 * Counted in code points, so a character outside the Basic Multilingual Plane
 * is never cut in half. A text no longer than `tailLength` is all tail.
 */
export function splitForMiddleEllipsis(
  text: string,
  tailLength: number,
): { head: string; tail: string } {
  const characters = Array.from(text);
  const cut = Math.max(0, characters.length - Math.max(0, tailLength));

  return { head: characters.slice(0, cut).join(''), tail: characters.slice(cut).join('') };
}
