/**
 * A link to one captured request: `<origin>/v/<session-id>#<request-id>`
 * (issue #71, D182), and a link with access to a private session (issue
 * #228, D259): `<origin>/v/<session-id>#key=<key>`, or
 * `#key=<key>&request=<request-id>` for one of its requests.
 *
 * Both live in the fragment, which a browser never sends, so the link reaches
 * the API, nginx and the logs as the session's own address, and no `Referer`
 * carries it. The page reads a key at once, before its first load, and again
 * whenever only the fragment changes under it (`takeKeyFromAddress`), holds
 * it and takes it out of the address, leaving only the request id, if any; it
 * reads a request id once, after its first list load, removes the fragment
 * from the address whatever it held but a move link (D276, issue #362), and
 * opens the request it names. The selection is still never written into the
 * address (D157).
 *
 * Everything here is pure but `takeKeyFromAddress`, which holds the key it
 * reads and replaces the address it is given. `SessionPage` carries the
 * outcomes out, and `usePushFlowHistory` makes the `replaceState` that removes
 * a request id once the first list load has read it.
 */

import { buildInspectorUrl } from '@webhook-inspector/shared';
import { en } from '../i18n/en.ts';
import { accessKeyFor, holdAccessKey, isAccessKey, type AccessKeyStorage } from './access-keys.ts';
import { classifyAddress } from './not-found.ts';
import type { SessionLayout } from './push-flow.ts';

/**
 * The full request id the API returns: a UUID, in any letter case. Nothing
 * before or after it, so a UUID with extra characters is not one.
 */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The toast a link to a request the session no longer holds shows (frames S1
 * and S2 of the Figma page `Webhook Inspector · Request actions`), in English;
 * the page shows the dictionary's `staleLink` (D222).
 */
export const STALE_LINK_TOAST = en.staleLink;

/**
 * The link `Copy link` copies: the shared builder's, the same link `/mcp`'s
 * `get_request` and a default session's reply give as `inspectorUrl` (D223).
 */
export function buildRequestLink(origin: string, sessionId: string, requestId: string): string {
  return buildInspectorUrl(origin, sessionId, requestId);
}

/**
 * What the address's fragment holds:
 *
 * - `none`: no `#` at all, the session's own address;
 * - `request`: a request id, lower-cased, as the API writes it;
 * - `malformed`: anything else, an empty fragment (`…#`) included.
 */
export type RequestLinkFragment =
  { kind: 'none' } | { kind: 'malformed' } | { kind: 'request'; requestId: string };

/**
 * The link with access `Copy link with access` copies, and in a private
 * session `Copy link`: the session's page, or one of its requests, with the
 * key in the fragment (D259). The page part is the shared builder's (D223),
 * which never carries a key.
 */
export function buildAccessLink(
  origin: string,
  sessionId: string,
  key: string,
  requestId?: string,
): string {
  const page = buildInspectorUrl(origin, sessionId);

  return requestId === undefined ? `${page}#key=${key}` : `${page}#key=${key}&request=${requestId}`;
}

/**
 * The longest fragment read for a key: a link with access writes at most 92
 * characters, `key=` and a key, then `&request=` and a request id, so this
 * leaves room for a request part cut or typed wrong, which drops the request
 * and keeps the key. Anything longer is no link, read without being split.
 */
export const MAX_ACCESS_FRAGMENT_LENGTH = 256;

/**
 * What the address's fragment holds, read before the page's first load:
 *
 * - `none`: no `#` at all;
 * - `request`: a request id alone, D182's link, read after the first list
 *   load by `readRequestLink` as before;
 * - `access`: a key, from `key=<key>`, and the request id of
 *   `&request=<id>` when that part is one, lower-cased; a part that is no
 *   request id leaves `requestId` `null` and the key still opens the session;
 * - `malformed`: anything else - an empty fragment, `key=` with no key or a
 *   value of another shape, two keys, an unknown part, a fragment longer than
 *   any link writes.
 *
 * Bounded whatever the fragment's size: one search for `#`, then a length
 * check before anything is split.
 */
export type SessionLinkFragment =
  | { kind: 'none' }
  | { kind: 'malformed' }
  | { kind: 'request'; requestId: string }
  | { kind: 'access'; key: string; requestId: string | null };

export function readSessionLink(href: string): SessionLinkFragment {
  const hash = href.indexOf('#');

  if (hash === -1) {
    return { kind: 'none' };
  }

  const fragment = href.slice(hash + 1);

  if (REQUEST_ID.test(fragment)) {
    return { kind: 'request', requestId: fragment.toLowerCase() };
  }

  if (fragment.length > MAX_ACCESS_FRAGMENT_LENGTH) {
    return { kind: 'malformed' };
  }

  const keys: string[] = [];
  const requests: string[] = [];

  for (const part of fragment.split('&')) {
    if (part.startsWith('key=')) {
      keys.push(part.slice('key='.length));
    } else if (part.startsWith('request=')) {
      requests.push(part.slice('request='.length));
    } else {
      return { kind: 'malformed' };
    }
  }

  const [key] = keys;

  if (keys.length !== 1 || !isAccessKey(key) || requests.length > 1) {
    return { kind: 'malformed' };
  }

  const [requestId] = requests;

  return {
    kind: 'access',
    key,
    requestId:
      requestId !== undefined && REQUEST_ID.test(requestId) ? requestId.toLowerCase() : null,
  };
}

/**
 * What the address's fragment becomes once a key was read from it, before the
 * first load: the request id alone, as D182's link writes it, for the reading
 * after the list load, or nothing. `null` leaves the address as it is: no
 * fragment, or D182's link. A malformed fragment is removed at once too, so
 * no part of a key mistyped or cut short stays in the address or the history.
 */
export function fragmentAfterKeyRead(link: SessionLinkFragment): string | null {
  switch (link.kind) {
    case 'none':
    case 'request':
      return null;
    case 'malformed':
      return '';
    case 'access':
      return link.requestId === null ? '' : `#${link.requestId}`;
  }
}

/** The tab's address as `takeKeyFromAddress` reads and replaces it; a fake in the tests. */
export interface AddressBar {
  /** The address, whole (`location.href`). */
  readonly href: string;
  /** Replaces the current history entry's address, adding no entry (`history.replaceState`). */
  replace(href: string): void;
}

/**
 * Reads a key from the address's fragment and takes it out (D259), before a
 * page's first load and again whenever the fragment changes under a page
 * already shown - a link pasted into the address bar of that session's tab,
 * which loads no new document and mounts no new page (D080). The address
 * becomes `fragmentAfterKeyRead`'s, in place, so no history entry keeps the
 * key; the key is held in this tab unless the browser already holds one for
 * the session: a session has one key, and the one held has opened it, so
 * another link's cannot take its place (the field of `Session not found` can,
 * once checked). Answers what the fragment held: `access` asks a page already
 * shown to open afresh, so its first load presents the key.
 */
export function takeKeyFromAddress(
  sessionId: string,
  storage: AccessKeyStorage | null | undefined,
  address: AddressBar,
): SessionLinkFragment {
  const href = address.href;
  const link = readSessionLink(href);
  const fragment = fragmentAfterKeyRead(link);

  if (fragment !== null) {
    address.replace(`${withoutFragment(href)}${fragment}`);
  }

  if (link.kind === 'access' && accessKeyFor(sessionId, storage) === null) {
    holdAccessKey(sessionId, link.key);
  }

  return link;
}

/**
 * The longest value the field of `Session not found` reads: a link with
 * access is under 200 characters. Anything longer is refused unread.
 */
export const MAX_PASTED_LENGTH = 2_048;

/**
 * What a value pasted into the field of `Session not found` asks to open
 * (frames R7 and R8 of the Figma page `Webhook Inspector · Private sessions
 * (#228)`; #228's Decision 10):
 *
 * - `empty`: nothing but spaces, which does nothing;
 * - `open`: the key alone, for the page's own session, or a link with access
 *   of this site - its origin the page's, its path a session's - with the
 *   session, the key and the request it names;
 * - `invalid`: anything else - a key of the wrong shape, a link without a
 *   key, a public session's link, another origin's link, an address that is
 *   no session's, a value longer than `MAX_PASTED_LENGTH`.
 *
 * Whether the key opens its session is the server's answer, asked next.
 */
export type PastedAccess =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'open'; sessionId: string; key: string; requestId: string | null };

export function readPastedAccess(
  value: string,
  pageSessionId: string,
  origin: string,
): PastedAccess {
  if (value.length > MAX_PASTED_LENGTH) {
    return { kind: 'invalid' };
  }

  const text = value.trim();

  if (text === '') {
    return { kind: 'empty' };
  }

  if (isAccessKey(text)) {
    return { kind: 'open', sessionId: pageSessionId, key: text, requestId: null };
  }

  let url: URL;

  try {
    url = new URL(text);
  } catch {
    return { kind: 'invalid' };
  }

  if (url.origin !== origin) {
    return { kind: 'invalid' };
  }

  const address = classifyAddress(url.pathname);
  const link = readSessionLink(url.href);

  if (address.screen !== 'session' || link.kind !== 'access') {
    return { kind: 'invalid' };
  }

  return { kind: 'open', sessionId: address.sessionId, key: link.key, requestId: link.requestId };
}

/** Reads the fragment of an address, given whole (`location.href`). */
export function readRequestLink(href: string): RequestLinkFragment {
  const hash = href.indexOf('#');

  if (hash === -1) {
    return { kind: 'none' };
  }

  const fragment = href.slice(hash + 1);

  return REQUEST_ID.test(fragment)
    ? { kind: 'request', requestId: fragment.toLowerCase() }
    : { kind: 'malformed' };
}

/**
 * The same address with its fragment, and the `#` itself, removed: what the
 * address bar reads once the link has been read.
 */
export function withoutFragment(href: string): string {
  const hash = href.indexOf('#');

  return hash === -1 ? href : href.slice(0, hash);
}

/**
 * What the page does with a link after its first list load:
 *
 * - `none`: nothing, the address had no fragment;
 * - `ignore`: remove a malformed fragment and open the session as usual;
 * - `open`: remove the fragment and open the request, as a click does;
 * - `stale`: remove the fragment, open nothing and say the request is gone -
 *   deleted, or pushed out of the newest 1000 (D006);
 * - `move`: nothing, a move link's fragment (D276) stays in the address for
 *   `main.tsx`'s reload to read (issue #362). `resolveRequestLink` never
 *   answers it: `resolveRequestLinkUnlessMove` (`lib/move-link.ts`) does,
 *   before it reads the fragment as a request link.
 *
 * The list is the whole session, newest first, with no paging, so a request
 * it does not hold is not in the session. One that it holds and the server
 * answers `REQUEST_NOT_FOUND` for is found stale only by opening it.
 */
export type RequestLinkOutcome =
  | { kind: 'none' }
  | { kind: 'ignore' }
  | { kind: 'open'; requestId: string }
  | { kind: 'stale' }
  | { kind: 'move' };

export function resolveRequestLink(
  fragment: RequestLinkFragment,
  listed: readonly { id: string }[],
): RequestLinkOutcome {
  switch (fragment.kind) {
    case 'none':
      return { kind: 'none' };
    case 'malformed':
      return { kind: 'ignore' };
    case 'request':
      return listed.some((item) => item.id === fragment.requestId)
        ? { kind: 'open', requestId: fragment.requestId }
        : { kind: 'stale' };
  }
}

/**
 * Whether the page removes the address's fragment for an outcome: every
 * fragment it read, but a move link's, left for the reading on arrival.
 */
export function removesFragment(outcome: RequestLinkOutcome): boolean {
  return outcome.kind !== 'none' && outcome.kind !== 'move';
}

/**
 * How opening a request ended - the page's `select()`: its details on screen,
 * the server no longer holding it, another failure, or something the viewer
 * did before the details arrived - another row, `‹ Requests`, Back - taking
 * over.
 */
export type OpeningOutcome = 'shown' | 'not-found' | 'failed' | 'superseded';

/**
 * What follows the opening of a linked request, once it has ended:
 *
 * - `stale-toast`: the server no longer has it, so the toast says the linked
 *   request is gone, at every width;
 * - `reveal-row`: its row is scrolled into the list's view - only on the
 *   desktop, where the list is beside the request, and only when the request
 *   is what the panel now shows. A request the viewer left before it arrived
 *   moves nothing: the list stays on the row they chose, or, below 1024 px,
 *   where they returned to it;
 * - `none`: anything else.
 */
export function afterLinkedOpening(
  outcome: OpeningOutcome,
  layout: SessionLayout,
): 'stale-toast' | 'reveal-row' | 'none' {
  if (outcome === 'not-found') {
    return 'stale-toast';
  }

  return outcome === 'shown' && layout === 'split' ? 'reveal-row' : 'none';
}
