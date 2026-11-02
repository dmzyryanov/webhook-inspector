/**
 * What the Request half's header says about one captured request (D141).
 *
 * The header is the method and target, then the facts line. The target is
 * split here into the three parts the header draws (D173), and the facts line
 * is composed here. Both are kept away from the DOM so that the splitting, the
 * order of the segments, the address written in full and the absent cases are
 * asserted by a unit test rather than described (D070).
 */
import type { RequestDetails } from '@webhook-inspector/shared';
import { en, type Messages } from '../i18n/en.ts';
import { missingAddressText } from './address.ts';
import { formatBytesCompact, formatDetailTimestamp } from './format.ts';

/**
 * The request target in the three parts the detail header draws as one run of
 * text (D173, Figma `Webhook Inspector · Request path in the details`, 3.2+).
 * Joined, they are exactly the stored path and query string: nothing is
 * decoded, normalised or dropped.
 */
export interface RequestTarget {
  /**
   * `/s/<id>`, with the trailing slash the request arrived with, if any
   * (D063): a lone `/` after the id is not a path of its own.
   */
  session: string;
  /** Everything the sender added after the session part, from its `/`; empty when nothing was. */
  path: string;
  /** `?` and the stored query string, or empty when there is none. */
  query: string;
}

/** `/s/` and the segment after it, which names the session, whatever it holds. */
const SESSION_PART = /^\/s\/[^/]*/;

/**
 * The target of a captured request, split for the header, or `null` for a
 * request stored before paths were recorded: the header then shows the method
 * alone (D110).
 *
 * The session part is `/s/` and the segment after it; the path is the rest,
 * unless the rest is a lone `/`, which stays with the session part. A path that
 * does not start with `/s/` is drawn whole as the session part rather than cut
 * somewhere arbitrary. The receiver stores one when a request line names an
 * absolute URL, `POST http://host/s/<id>/x HTTP/1.1`: it is routed by its path
 * and stored as it arrived, `http://` included. That predates D173. Behind
 * the HTTP proxy of qa-tools.ru, which forwarded the path alone, it did not
 * occur; on the receive host, whose TCP route passes the request line through
 * as sent, it can (D187).
 */
export function splitRequestTarget(
  details: Pick<RequestDetails, 'path' | 'queryString'>,
): RequestTarget | null {
  if (details.path === null) {
    return null;
  }

  const cut = SESSION_PART.exec(details.path)?.[0].length ?? details.path.length;
  const rest = details.path.slice(cut);
  const query = details.queryString === '' ? '' : `?${details.queryString}`;

  return rest === '/'
    ? { session: details.path, path: '', query }
    : { session: details.path.slice(0, cut), path: rest, query };
}

/** The separator the design uses between the segments of a line: U+00B7. */
const SEPARATOR = ' · ';

/** The fields the facts line is made of, and nothing else. */
export type RequestFacts = Pick<
  RequestDetails,
  'httpVersion' | 'bodySize' | 'sourceIp' | 'receivedAt'
>;

/**
 * `HTTP/1.1 · 61 B · 145.40.74.12 · 17 Sep 2026, 14:32:06`.
 *
 * - The address sits between the size and the time, in the same face as the
 *   rest of the line, with no label, flag or country beside it (D123, D140).
 * - It is written in full, IPv6 included. The detail panel never shortens it;
 *   only a list row does, and the `Raw` caption points up here where one has.
 * - No address: `IP unavailable` in the same position, between separators
 *   (D120b, as amended by D141), or `IP not stored` for a session created to
 *   keep none (`keepsNoAddress`, D249).
 * - No HTTP version - a request captured before the column existed - drops
 *   that one segment and nothing else (D110).
 * - The time is written the way the detail panel writes one, not the way the
 *   list row does (D148).
 *
 * `timeZone` exists for tests, exactly as it does on `formatDetailTimestamp`.
 */
export function formatRequestFacts(
  details: RequestFacts,
  timeZone?: string,
  m: Messages = en,
  keepsNoAddress = false,
): string {
  return [
    details.httpVersion === null ? null : `HTTP/${details.httpVersion}`,
    formatBytesCompact(details.bodySize),
    details.sourceIp ?? missingAddressText(keepsNoAddress, m),
    formatDetailTimestamp(details.receivedAt, timeZone, m),
  ]
    .filter((segment): segment is string => segment !== null)
    .join(SEPARATOR);
}
