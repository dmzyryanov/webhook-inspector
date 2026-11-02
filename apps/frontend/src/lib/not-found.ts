/**
 * Which screen an address gets, and what the two not-found screens say
 * (D146, D147).
 *
 * The classification is the client's half of a rule nginx applies first: the
 * frontend container answers `200` only for `/`, for the Russian home page
 * `/ru/` (and `/ru`, issue #109, D226) and for an address shaped like a
 * session, and `404` for everything else while still serving the application
 * (`apps/frontend/nginx.conf`). The two halves must agree, or a
 * page answered `404` would render a session, or one answered `200` would say
 * it does not exist. Both read the same session-id shape, `SESSION_ID_PATTERN`,
 * and the unit tests hold this function against the regular expression in
 * `nginx.conf` itself.
 *
 * The wording is composed here rather than in the components, beside the other
 * presentation logic, because that is the part of the frontend that is
 * unit-tested; components are not (D025, D061).
 */
import { SESSION_ID_PATTERN } from '@webhook-inspector/shared';
import { en, type Messages } from '../i18n/en.ts';
import { HOME_ADDRESSES, homeAddress, type Language } from '../i18n/index.ts';

/**
 * What `App` renders for the address it was opened on. A landing page carries
 * the language its address fixes: `ru` on the Russian home page, `null` on
 * `/`, which follows the visitor's language (D222).
 */
export type AddressScreen =
  | { screen: 'landing'; language: Language | null }
  | { screen: 'session'; sessionId: string }
  | { screen: 'not-found' };

/** `/v/` and one segment, with an optional trailing slash and nothing after it. */
const SESSION_ADDRESS = /^\/v\/([^/]*)\/?$/;

/**
 * Reads a pathname the way nginx matches it: percent-escapes decoded and
 * repeated slashes merged into one (nginx's `merge_slashes`, on by default).
 * A browser has already resolved `.` and `..` segments before sending.
 *
 * `null` when the escapes are malformed. nginx refuses such a request with its
 * own `400` before this page is served, so the answer only has to be safe.
 */
function normalisePath(pathname: string): string | null {
  let decoded: string;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  return decoded.replace(/\/{2,}/g, '/');
}

/**
 * The Russian home page as nginx matches it: `/ru/`, and `/ru` without the
 * slash, which nginx serves the same page for, as it does `/about` (D226).
 * Exactly these two, in lower case: `/RU/`, `/ru/index.html`, `/ru/x` and
 * `/ru/v/<id>` are addresses like any other.
 */
const RUSSIAN_HOME = [HOME_ADDRESSES.ru, HOME_ADDRESSES.ru.slice(0, -1)];

/**
 * Decides the screen for a pathname, with no request to the API (D146).
 *
 * - `/` is the landing page, in the visitor's language.
 * - `/ru/` and `/ru` are the landing page in Russian (issue #109, D226).
 * - `/v/<id>`, with or without a trailing slash, is the session page when the
 *   id could be a session id. Whether that session exists is the API's answer,
 *   so the page asks, and renders `Session not found` if it is not available.
 * - Anything else is `Page not found`, rendered at once: `/v/`, `/v/<value
 *   that cannot be a session id>`, `/v/<id>/<more>`, and every other path.
 *
 * Linear in the length of the address, however its slashes and escapes run.
 */
export function classifyAddress(pathname: string): AddressScreen {
  const path = normalisePath(pathname);

  if (path === '/') {
    return { screen: 'landing', language: null };
  }

  if (path !== null && RUSSIAN_HOME.includes(path)) {
    return { screen: 'landing', language: 'ru' };
  }

  const sessionId = path === null ? undefined : SESSION_ADDRESS.exec(path)?.[1];

  if (sessionId !== undefined && SESSION_ID_PATTERN.test(sessionId)) {
    return { screen: 'session', sessionId };
  }

  return { screen: 'not-found' };
}

/** The language an address fixes, whatever was chosen before: Russian on `/ru/`, else none. */
export function fixedLanguage(pathname: string): Language | null {
  const address = classifyAddress(pathname);

  return address.screen === 'landing' ? address.language : null;
}

/**
 * Where the `EN | RU` switch leads when `chosen` is pressed on `pathname`
 * (issue #109, D226): on either home page, to the home page of the language
 * chosen - `RU` to `/ru/`, `EN` to `/` - and `null` everywhere else, where
 * the switch changes the language in place (D222). `null` too where the
 * page is already at that address, so a press there changes no address.
 */
export function switchAddress(pathname: string, chosen: Language): string | null {
  if (classifyAddress(pathname).screen !== 'landing') {
    return null;
  }

  const target = HOME_ADDRESSES[chosen];

  return pathname === target ? null : target;
}

/**
 * A session id reduced to its first and last four characters, `Au6J…MKss`, as
 * frame `2A` draws it. Enough to recognise which session the address named;
 * the whole id is still in the browser's address bar.
 */
export function shortenSessionId(sessionId: string): string {
  return `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}`;
}

/** The parts of the page's address the request line is made from. */
export interface OpenedAddress {
  /** `location.pathname`, as the browser holds it: percent-encoded. */
  pathname: string;
  /** `location.search`, `?` included, or empty. */
  search: string;
}

/**
 * The request target of the address that was opened: path and query.
 *
 * The fragment is never part of it. A browser does not send it, so the server
 * never saw it, and the block illustrates what the server was asked.
 */
export function requestTarget({ pathname, search }: OpenedAddress): string {
  return `${pathname}${search}`;
}

/** Where both screens lead in English, and what the button says there (D147). */
export const GO_HOME = { label: en.notFound.goHome, href: HOME_ADDRESSES.en } as const;

/**
 * The button in the interface's language, leading to that language's home
 * page: `/ru/` in Russian, so a visitor who came from there goes back to it
 * (issue #109, D226), `/` in English.
 */
function goHome(m: Messages): NotFoundView['action'] {
  return { label: m.notFound.goHome, href: homeAddress(m.lang) };
}

/**
 * Everything one not-found screen shows.
 *
 * The code block is a stylised request and its answer, not a capture, and it
 * carries no copy control: a named exception to D122 (D147).
 */
export interface NotFoundView {
  title: string;
  /** The request line and the `Host` line, shown muted. */
  request: [requestLine: string, hostLine: string];
  /** The answer, shown in ink after a blank line. */
  answer: string;
  /** One line of body text under the block. */
  body: string;
  action: { label: string; href: string };
}

function requestLines(target: string, host: string): NotFoundView['request'] {
  return [`GET ${target} HTTP/1.1`, `Host: ${host}`];
}

/**
 * Screen A: an address shaped like a session, whose session the API says is
 * not available (`404` or `410`, which the client no longer tells apart,
 * D133).
 *
 * The body names the two causes, hedged: a session-shaped address loses its
 * session when someone deletes it through the API or when it goes unused for
 * the idle window (D147, amended by D198, which made the first possible). The
 * client tells neither apart from the other, nor from a mistyped id. It names
 * no number: the window was chosen when the session was created, and the API
 * answers a session that no longer exists `404`, so the page cannot know it
 * (D265).
 *
 * The id is shortened where the path carries it. A path that spells it with
 * percent-escapes is shown as it was opened, which is still the truth.
 */
export function sessionNotFoundView(
  address: OpenedAddress & { sessionId: string; host: string },
  m: Messages = en,
): NotFoundView {
  const target = requestTarget(address).replace(
    address.sessionId,
    shortenSessionId(address.sessionId),
  );

  return {
    title: m.notFound.sessionTitle,
    request: requestLines(target, address.host),
    answer: m.notFound.sessionAnswer,
    body: m.notFound.sessionBody,
    action: goHome(m),
  };
}

/** Screen B: any address the application does not serve (D146). */
export function pageNotFoundView(
  address: OpenedAddress & { host: string },
  m: Messages = en,
): NotFoundView {
  return {
    title: m.notFound.pageTitle,
    request: requestLines(requestTarget(address), address.host),
    answer: 'HTTP/1.1 404 Not Found',
    body: m.notFound.pageBody,
    action: goHome(m),
  };
}
