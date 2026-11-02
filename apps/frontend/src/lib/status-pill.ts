/**
 * The pill a response status is drawn in where it is an answer the session
 * gave, state `sent` (issue #138, D207; Figma page `Webhook Inspector ·
 * Response status colour`, sub-variant C1): fully rounded, no border, tinted
 * by the status class. The status reads as a fact about the configured answer,
 * not as an alarm of ours, and a list of mixed answers can still be scanned by
 * class.
 *
 * Which states get the pill is decided in `response-summary.ts`; this module
 * only says how one looks.
 */

/** A status class: the first digit of the code. */
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

/**
 * The class of a status, by its first digit. A recorded status is 200 to 599
 * (`RESPONSE_STATUS_MIN`, `RESPONSE_STATUS_MAX`); a value outside that range
 * takes the nearest class rather than failing the render.
 */
export function statusClass(status: number): StatusClass {
  if (status < 300) {
    return '2xx';
  }

  if (status < 400) {
    return '3xx';
  }

  return status < 500 ? '4xx' : '5xx';
}

/**
 * Each class's tint and code colour, `index.css` tokens that
 * `contrast.test.ts` holds at AA pair by pair. Whole class names, so Tailwind
 * finds them in this file.
 */
export const STATUS_PILL_COLOURS: Readonly<Record<StatusClass, string>> = {
  '2xx': 'bg-status-2xx text-status-2xx-ink',
  '3xx': 'bg-status-3xx text-status-3xx-ink',
  '4xx': 'bg-status-4xx text-status-4xx-ink',
  '5xx': 'bg-status-5xx text-status-5xx-ink',
};

/** Where a pill is drawn: the Response half's heading, or a list row's status cell. */
export type StatusPillPlace = 'heading' | 'row';

/**
 * The pill's size in each place: in the heading the code is Semi Bold 14/17,
 * padded 2 × 8; in a row 11/14, padded 0 × 6. It never wraps and never
 * shrinks, so a long reason phrase beside it wraps instead.
 */
const STATUS_PILL_SIZE: Readonly<Record<StatusPillPlace, string>> = {
  heading: 'px-2 py-0.5 text-[14px] leading-[17px]',
  row: 'px-1.5 text-[11px] leading-[14px]',
};

/** The classes of the pill holding `status`'s code in `place`. */
export function statusPillClassName(status: number, place: StatusPillPlace): string {
  return [
    'shrink-0 whitespace-nowrap rounded-full font-semibold',
    STATUS_PILL_SIZE[place],
    STATUS_PILL_COLOURS[statusClass(status)],
  ].join(' ');
}
