import { randomBytes } from 'node:crypto';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { pathToFileURL, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

/**
 * The operator's details a deployment's frontend image was built with
 * (#369), which the smoke checks the site against (#381): `statusPageUrl`,
 * the image's `STATUS_PAGE_URL`; `contactEmail`, its `CONTACT_EMAIL`; and
 * `texts`, its `OPERATOR_TEXTS` (`apps/frontend/src/lib/operator.ts`). Each is
 * `undefined` when not given, and is then not checked; `null`, or `false` for
 * the texts, when given as none; and otherwise the value, read as the image
 * build reads it. Not one of them has a default: the smoke names no
 * operator's status page, address or texts unless it is given them.
 */
export const OPERATOR_NOT_GIVEN = Object.freeze({
  statusPageUrl: undefined,
  contactEmail: undefined,
  texts: undefined,
});

/** A label of a host name: letters, digits and inner hyphens (as `operator.ts`). */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * Whether `host` is a host name: dot-separated labels of 1 to 63 letters,
 * digits and inner hyphens, at most 253 characters (as `operator.ts`).
 */
function isHostName(host) {
  return (
    host.length <= 253 &&
    host.split('.').every((label) => label.length <= 63 && HOST_LABEL.test(label))
  );
}

/** The path a status page's address may have (as `operator.ts`). */
const STATUS_PATH = /^\/(?:[A-Za-z0-9._~/-]|%[0-9A-Fa-f]{2})*$/;

/**
 * `--status-page`, the image's `STATUS_PAGE_URL`, read as the image build
 * reads it (`parseStatusPageUrl` of `operator.ts`): the address as `URL`
 * writes it, which is what nginx redirects to, or `null` for none when blank.
 * What the build refuses is refused, and the value is never quoted back.
 * `scripts/delivery.test.mjs` holds the two readings equal.
 */
export function readStatusPage(raw) {
  const value = raw.trim();

  if (value === '') {
    return null;
  }

  const refusal =
    '--status-page must be an http or https address, such as https://status.example.com/, or empty for none';
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error(refusal);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(refusal);
  }

  if (url.username !== '' || url.password !== '') {
    throw new Error('--status-page must not carry credentials');
  }

  if (/[?#]/.test(value)) {
    throw new Error('--status-page must have no query or fragment');
  }

  if (!isHostName(url.hostname) || url.port === '0') {
    throw new Error(
      '--status-page must name its host as dot-separated labels of letters, digits and inner hyphens, with any port but 0',
    );
  }

  if (!STATUS_PATH.test(url.pathname)) {
    throw new Error(
      '--status-page must have a path of letters, digits, ".", "_", "~", "-", "/" and percent escapes only',
    );
  }

  return url.href;
}

/** The part of a contact address before its `@` (as `operator.ts`). */
const LOCAL_PART = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*$/;

/**
 * `--contact-email`, the image's `CONTACT_EMAIL`, read as the image build
 * reads it (`parseContactEmail` of `operator.ts`): the address trimmed, or
 * `null` for none when blank. What the build refuses is refused, and the
 * value is never quoted back. `scripts/delivery.test.mjs` holds the two
 * readings equal.
 */
export function readContactEmail(raw) {
  const value = raw.trim();

  if (value === '') {
    return null;
  }

  const at = value.lastIndexOf('@');
  const local = value.slice(0, Math.max(at, 0));
  const domain = value.slice(at + 1);

  if (
    at <= 0 ||
    value.length > 254 ||
    local.length > 64 ||
    !LOCAL_PART.test(local) ||
    !isHostName(domain)
  ) {
    throw new Error(
      '--contact-email must be one mail address of letters, digits, ".", "_", "%", "+" and "-" before its "@" and a host name after it, such as contact@example.com, or empty for none',
    );
  }

  return value;
}

/**
 * `--operator-texts`, the image's `OPERATOR_TEXTS`, read as the image build
 * reads it (`parseOperatorTexts` of `operator.ts`): `true`, or `false` for
 * `false` and blank; anything else is refused.
 */
export function readOperatorTexts(raw) {
  const value = raw.trim();

  if (value === '' || value === 'false') {
    return false;
  }

  if (value === 'true') {
    return true;
  }

  throw new Error('--operator-texts must be true or false, or empty for false');
}

/**
 * The operator's details from the options given, as strings, each
 * `undefined` when not given. Refused, as the image build refuses it: the
 * operator's texts with the status page or the contact address given as
 * none, which the texts name.
 */
export function operatorSettings({ statusPage, contactEmail, operatorTexts } = {}) {
  const operator = {
    statusPageUrl: statusPage === undefined ? undefined : readStatusPage(statusPage),
    contactEmail: contactEmail === undefined ? undefined : readContactEmail(contactEmail),
    texts: operatorTexts === undefined ? undefined : readOperatorTexts(operatorTexts),
  };

  if (
    operator.texts === true &&
    (operator.statusPageUrl === null || operator.contactEmail === null)
  ) {
    throw new Error(
      "--operator-texts=true needs a status page and a contact address: the operator's texts name both, and an image built with them and without either is refused",
    );
  }

  return Object.freeze(operator);
}

/** The `Contact` line a `security.txt` of the image built with `CONTACT_EMAIL=<address>` carries (D177). */
export function securityContact(address) {
  return `Contact: mailto:${address}`;
}

/**
 * Whether a `security.txt` gives the contact address `address`, as its one
 * `Contact` field, and has exactly one `Expires` in RFC 3339 UTC form, later
 * than `now` and less than a year after it.
 */
export function securityTxtIsCurrent(text, address, now = new Date()) {
  const lines = text.split(/\r?\n/);
  const contacts = lines.filter((line) => /^contact:/i.test(line));
  const expires = lines.filter((line) => line.startsWith('Expires:'));

  if (contacts.length !== 1 || contacts[0] !== securityContact(address) || expires.length !== 1) {
    return false;
  }

  const value = expires[0].slice('Expires:'.length).trim();
  const time = Date.parse(value);
  const yearAhead = new Date(now);

  yearAhead.setUTCFullYear(yearAhead.getUTCFullYear() + 1);

  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    time > now.getTime() &&
    time < yearAhead.getTime()
  );
}

/**
 * What tells the about page from the application shell (D211). The smoke keeps
 * its own copy, so that it loads nothing from `apps/frontend/src`;
 * `scripts/delivery.test.mjs` keeps it equal.
 */
export const ABOUT_TITLE_TAG = '<title>About QA Tools</title>';

/**
 * What tells the Russian about page (D255) from the English one and from the
 * application shell: its language and its title. The smoke keeps its own
 * copy, as it does of the English title; `scripts/delivery.test.mjs` keeps
 * it equal to the page's template.
 */
export const RUSSIAN_ABOUT_PATH = '/ru/about';
export const RUSSIAN_ABOUT_MARKS = {
  lang: '<html lang="ru">',
  titleTag: '<title>О QA Tools</title>',
};

/**
 * The Terms of Use and the Privacy Policy (D217), each by its address, what it
 * is called in a failure and the title that tells it from the application
 * shell, in an image built with the operator's texts (#369). The smoke keeps
 * its own copy, as it does of the about page's title;
 * `scripts/delivery.test.mjs` keeps it equal to the pages' templates.
 */
export const LEGAL_PAGE_CHECKS = [
  { path: '/terms', name: 'the Terms of Use', titleTag: '<title>Terms of Use — QA Tools</title>' },
  {
    path: '/privacy',
    name: 'the Privacy Policy',
    titleTag: '<title>Privacy Policy — QA Tools</title>',
  },
];

/**
 * The two addresses that send a reader to the status page (D209), each a
 * 301 in an image built with a `STATUS_PAGE_URL` (#369,
 * `apps/frontend/scripts/nginx-conf.mjs`); `scripts/delivery.test.mjs` keeps
 * them equal to the locations that script writes.
 */
export const STATUS_PATHS = ['/status', '/status/'];

/**
 * What tells the Russian home page from the English shell (D226): its
 * language, its title and its one canonical address, on the site checked
 * (D274). The smoke keeps its own copy, as it does of the about page's title;
 * `scripts/delivery.test.mjs` keeps it equal to the page's template.
 */
export const RUSSIAN_HOME_PATH = '/ru/';
export function russianHomeMarks(origin) {
  return {
    lang: '<html lang="ru">',
    titleTag: '<title>Webhook Inspector — проверка вебхуков</title>',
    canonical: `<link rel="canonical" href="${origin}/ru/" />`,
  };
}

/** How many times `part` occurs in `text`. */
function occurrences(text, part) {
  return text.split(part).length - 1;
}

/**
 * The changelog's two Atom feeds (D212): every version, and the versions with
 * a Breaking, Deprecated or Notice paragraph (D224). Each is answered as
 * UTF-8 Atom, revalidated on every use, and opens a feed in Atom's
 * namespace; the first holds at least one entry, the second may hold none.
 * The smoke keeps its own copy of the paths; `scripts/delivery.test.mjs`
 * keeps them equal to the frontend's.
 */
export const CHANGELOG_FEEDS = ['/changelog.xml', '/changelog-breaking.xml'];
export const ATOM_CONTENT_TYPE = 'application/atom+xml; charset=utf-8';
export const ATOM_FEED_ROOT = '<feed xmlns="http://www.w3.org/2005/Atom"';

/**
 * The changelog's four addresses (D184, D212): the page, its text and the
 * two feeds, which an image built without the operator's texts serves none
 * of (#396), each then the site's `Page not found`. The smoke keeps its own
 * copy; `scripts/delivery.test.mjs` keeps it equal to the frontend's.
 */
export const CHANGELOG_PATHS = ['/changelog', '/changelog.md', ...CHANGELOG_FEEDS];

/** The line `/robots.txt` must carry (D183): the sitemap on the site checked (D274). */
export function sitemapLine(origin) {
  return `Sitemap: ${origin}/sitemap.xml`;
}

/** What the receive host answers at `/robots.txt`: nothing there is to be indexed (D187). */
export const RECEIVE_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/** A random id with a session id's shape: 32 random bytes in base64url, 43 characters. */
function sessionShapedId() {
  return randomBytes(32).toString('base64url');
}

/**
 * The errors Node's TLS gives for a certificate that is not yet the host's:
 * the proxy's own default, self-signed, which it presents for a name until
 * the name's certificate is issued, or one issued for another name. An
 * expired certificate is not among them: waiting would not mend it.
 */
export const CERTIFICATE_PENDING_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * The code of a certificate error among `CERTIFICATE_PENDING_CODES` that a
 * failed fetch carries, `fetch failed` with the TLS error as its cause, or
 * `undefined`. At most a few causes deep, so a cause that refers back to its
 * error ends the walk.
 */
export function pendingCertificateCode(error) {
  let current = error;

  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    if (CERTIFICATE_PENDING_CODES.has(current.code)) {
      return current.code;
    }

    current = current.cause;
  }

  return undefined;
}

/**
 * How long the smoke waits for a host's certificate (#319, D275): the second
 * site's is issued by cert-manager only once the deployment has created that
 * host's Ingress, through Let's Encrypt's HTTP-01 challenge, which issued a
 * production certificate for the receive host in 25 s on this cluster (D187,
 * Step 0), and the proxy presents its own self-signed certificate until then.
 * 30 tries 10 s apart, about 5 minutes, twelve times that: a certificate not
 * issued by then has met a fault, such as its DNS record or the challenge's
 * route, that more waiting does not mend, cert-manager retrying a failed
 * order only after an hour, and the smoke fails as it should.
 */
export const CERTIFICATE_WAIT = Object.freeze({ tries: 30, intervalMs: 10_000 });

/**
 * Waits until `base` answers over TLS with a certificate Node trusts for its
 * name, asking `/` once every `intervalMs` for at most `tries` times while
 * the answer is one of the certificate errors above. Any answer ends the
 * wait, whatever its status, and so does any other error, thrown at once:
 * the check that follows judges the answers. The last certificate error is
 * thrown once the tries are spent. Returns how many tries it took.
 */
export async function waitForCertificate(
  base,
  fetcher = globalThis.fetch,
  { tries, intervalMs } = CERTIFICATE_WAIT,
  sleep = sleepFor,
  log = console.log,
) {
  const root = new URL(base);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetcher(new URL('/', root), {
        redirect: 'error',
        signal: globalThis.AbortSignal.timeout(15000),
      });

      // Read in full, so the answer holds no connection open.
      await response.text();
      return attempt;
    } catch (error) {
      const code = pendingCertificateCode(error);

      if (code === undefined) {
        throw error;
      }

      if (attempt >= tries) {
        throw new Error(
          `${root.host} still has no valid certificate after ${tries} tries ${intervalMs / 1000} s apart (${code})`,
          { cause: error },
        );
      }

      log(
        `${root.host} has no valid certificate yet (${code}); trying again in ${intervalMs / 1000} s`,
      );
      await sleep(intervalMs);
    }
  }
}

/** The `content` of the home page's `og:image` meta tag, if it has one. */
export function ogImage(html) {
  const tag = /<meta\s[^>]*property="og:image"[^>]*>/i.exec(html)?.[0];

  return tag === undefined ? undefined : /\scontent="([^"]*)"/i.exec(tag)?.[1];
}

/**
 * Checks the deployed site at `base` and the receive host at `receiveBase`.
 * `site` describes the site checked, by default the site's own origin, open
 * to search:
 *
 * - `canonical`, the origin its pages name as theirs: the site's own, or for
 *   the site's second host (#319, D275) the first's, `https://qa-tools.ru`,
 *   whose pages it serves as they are;
 * - `closedToSearch`, set for that second host: every answer of the site
 *   carries `X-Robots-Tag: noindex`, where the first host's pages carry
 *   none;
 * - `operator`, the operator's details its image was built with
 *   (`OPERATOR_NOT_GIVEN`, by default none of them given): the legal pages,
 *   `security.txt` and the status page's redirect are each checked as the
 *   detail says, and not asked for when it is not given (#381); the
 *   changelog's feeds are checked as served unless the operator's texts are
 *   given as none, and the changelog's four addresses are then checked as
 *   `Page not found` (#396).
 */
export async function checkDeployment(
  base,
  fetcher = globalThis.fetch,
  now = new Date(),
  receiveBase = undefined,
  site = {},
) {
  const root = new URL(base);
  if (root.protocol !== 'https:') throw new Error('Deployment check requires HTTPS');
  if (root.username || root.password) throw new Error('Do not put credentials in the URL');
  const canonical = new URL(site.canonical ?? root.origin).origin;
  const closedToSearch = site.closedToSearch === true;
  const operator = { ...OPERATOR_NOT_GIVEN, ...site.operator };
  // What a page offered to search engines carries: no X-Robots-Tag on the
  // first host, and on a host closed to search what every answer carries.
  const indexable = closedToSearch ? 'noindex' : null;
  // Webhooks are received on a host of their own since 0.36.0 (D187).
  if (receiveBase === undefined) throw new Error('Deployment check requires the receive host');
  const receiveRoot = new URL(receiveBase);
  if (receiveRoot.protocol !== 'https:') throw new Error('Deployment check requires HTTPS');
  if (receiveRoot.username || receiveRoot.password) {
    throw new Error('Do not put credentials in the URL');
  }
  // Every request is a GET that follows no redirect, with 15 s of its own for
  // the answer and its body: a redirect is an error, but where the answer
  // checked is a redirect, which is then the answer itself (`manual`). Every
  // body is read in full, whether or not a check looks at it, so no answer
  // is left holding its connection open.
  const get = async (address, redirect = 'error') => {
    const url = new URL(address, root);
    const response = await fetcher(url, {
      redirect,
      signal: globalThis.AbortSignal.timeout(15000),
    });
    const answer = {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
    // A host closed to search says so on every answer, the API's and the
    // MCP server's included (D275); the receive host is not that host.
    if (
      closedToSearch &&
      url.origin === root.origin &&
      answer.headers.get('x-robots-tag') !== 'noindex'
    ) {
      throw new Error(`${url.pathname} on ${root.host} did not carry X-Robots-Tag: noindex`);
    }
    return answer;
  };
  const page = await get('/');
  if (
    page.status !== 200 ||
    !page.headers.get('content-type')?.includes('text/html') ||
    !/<html[\s>]/i.test(page.text)
  ) {
    throw new Error('Frontend did not return its HTML document');
  }
  // Only a session page is kept out of the index (D183), on the first host.
  if (page.headers.get('x-robots-tag') !== indexable) {
    throw new Error('The home page carries X-Robots-Tag');
  }
  // The site's `Page not found`, which an address the image does not serve
  // answers: the frontend's 404 with the application as its page (D146),
  // the very document the home page is, which renders `Page not found`.
  const isPageNotFound = (answer) =>
    answer.status === 404 &&
    answer.headers.get('content-type')?.includes('text/html') === true &&
    answer.headers.get('x-robots-tag') === indexable &&
    answer.text === page.text;
  // Read-only lookup: reaches the backend and database, without creating a session.
  // The id has a session id's shape, 32 random bytes in base64url (43 characters),
  // because the backend answers an id of any other shape without reading the
  // database (D181). /readyz is not publicly routed and would incorrectly test the
  // SPA instead.
  const response = await get(`/api/sessions/${sessionShapedId()}`);
  if (
    response.status !== 404 ||
    !response.headers.get('content-type')?.includes('application/json')
  ) {
    throw new Error('API lookup did not return the expected JSON 404');
  }
  const body = JSON.parse(response.text);
  if (body.errorCode !== 1001 || body.message !== 'Session not found') {
    throw new Error('API lookup did not return SESSION_NOT_FOUND');
  }
  // The API reference (D155): its own page, never the application shell, and
  // revalidated on every use, as is the description it renders (D154).
  const docs = await get('/docs');
  if (
    docs.status !== 200 ||
    !docs.headers.get('content-type')?.includes('text/html') ||
    docs.headers.get('cache-control') !== 'no-cache' ||
    !docs.text.includes('id="api-reference"')
  ) {
    throw new Error('/docs did not return the API reference page, uncached');
  }
  const description = await get('/openapi.json');
  if (
    description.status !== 200 ||
    !description.headers.get('content-type')?.includes('application/json') ||
    description.headers.get('cache-control') !== 'no-cache' ||
    JSON.parse(description.text).openapi !== '3.1.0'
  ) {
    throw new Error('/openapi.json did not return the OpenAPI description, uncached');
  }
  // The about page (D211): its own static page, never the application shell,
  // revalidated on every use and offered to search engines (D183).
  const about = await get('/about');
  if (
    about.status !== 200 ||
    !about.headers.get('content-type')?.includes('text/html') ||
    about.headers.get('cache-control') !== 'no-cache' ||
    about.headers.get('x-robots-tag') !== indexable ||
    !about.text.includes(ABOUT_TITLE_TAG)
  ) {
    throw new Error('/about did not return the about page, uncached and indexable');
  }
  // The about page in Russian (D255), sixth: a static page like /about,
  // checked as it is, in Russian.
  const russianAbout = await get(RUSSIAN_ABOUT_PATH);
  if (
    russianAbout.status !== 200 ||
    !russianAbout.headers.get('content-type')?.includes('text/html') ||
    russianAbout.headers.get('cache-control') !== 'no-cache' ||
    russianAbout.headers.get('x-robots-tag') !== indexable ||
    !russianAbout.text.includes(RUSSIAN_ABOUT_MARKS.lang) ||
    !russianAbout.text.includes(RUSSIAN_ABOUT_MARKS.titleTag)
  ) {
    throw new Error('/ru/about did not return the Russian about page, uncached and indexable');
  }
  // The Terms of Use and the Privacy Policy (D217), seventh and eighth, as the
  // image's OPERATOR_TEXTS says (#369): with the operator's texts, static
  // pages like /about, checked as it is; without them, the site's Page not
  // found. Not asked for when the setting is not given (#381).
  if (operator.texts !== undefined) {
    for (const { path, name, titleTag } of LEGAL_PAGE_CHECKS) {
      const legal = await get(path);
      if (!operator.texts) {
        if (!isPageNotFound(legal)) {
          throw new Error(
            `${path} did not answer the site's Page not found, as an image without the operator's texts does`,
          );
        }
        continue;
      }
      if (
        legal.status !== 200 ||
        !legal.headers.get('content-type')?.includes('text/html') ||
        legal.headers.get('cache-control') !== 'no-cache' ||
        legal.headers.get('x-robots-tag') !== indexable ||
        !legal.text.includes(titleTag)
      ) {
        throw new Error(`${path} did not return ${name}, uncached and indexable`);
      }
    }
  }
  // The Russian home page (D226): the application under a head of its own,
  // never the English shell, revalidated on every use and offered to search
  // engines (D183).
  const russian = await get(RUSSIAN_HOME_PATH);
  const russianMarks = russianHomeMarks(canonical);
  if (
    russian.status !== 200 ||
    !russian.headers.get('content-type')?.includes('text/html') ||
    russian.headers.get('cache-control') !== 'no-cache' ||
    russian.headers.get('x-robots-tag') !== indexable ||
    !russian.text.includes(russianMarks.lang) ||
    occurrences(russian.text, russianMarks.titleTag) !== 1 ||
    occurrences(russian.text, 'rel="canonical"') !== 1 ||
    !russian.text.includes(russianMarks.canonical)
  ) {
    throw new Error('/ru/ did not return the Russian home page, uncached and indexable');
  }
  // The changelog (D184, D212), as the image's OPERATOR_TEXTS says (#396):
  // without the operator's texts, its four addresses the site's Page not
  // found; with them, or when the setting is not given, as before #396, the
  // two Atom feeds, files of their own, never the application shell,
  // revalidated on every use.
  if (operator.texts === false) {
    for (const path of CHANGELOG_PATHS) {
      const answer = await get(path);
      if (!isPageNotFound(answer)) {
        throw new Error(
          `${path} did not answer the site's Page not found, as an image without the operator's texts does`,
        );
      }
    }
  }
  for (const path of operator.texts === false ? [] : CHANGELOG_FEEDS) {
    const feed = await get(path);
    if (
      feed.status !== 200 ||
      feed.headers.get('content-type') !== ATOM_CONTENT_TYPE ||
      feed.headers.get('cache-control') !== 'no-cache' ||
      !feed.text.includes(ATOM_FEED_ROOT) ||
      (path === CHANGELOG_FEEDS[0] && !feed.text.includes('<entry>'))
    ) {
      throw new Error(`${path} did not return the changelog's Atom feed, uncached`);
    }
  }
  // security.txt (RFC 9116, D177), as the image's CONTACT_EMAIL says (#369):
  // with a contact address, plain text, never the application shell, giving
  // that address alone and an Expires that has not passed; without one, a
  // 404. Not asked for when the setting is not given (#381).
  if (operator.contactEmail !== undefined) {
    const security = await get('/.well-known/security.txt');
    if (operator.contactEmail === null) {
      if (security.status !== 404) {
        throw new Error(
          '/.well-known/security.txt did not answer 404, as an image without a contact address does',
        );
      }
    } else if (
      security.status !== 200 ||
      !security.headers.get('content-type')?.startsWith('text/plain') ||
      !securityTxtIsCurrent(security.text, operator.contactEmail, now)
    ) {
      throw new Error(
        '/.well-known/security.txt did not return a current security.txt giving the contact address given',
      );
    }
  }
  // The files for search engines (D183), served by the frontend now that the
  // Ingress sends only /api/, /ws/ and /s/ to the backend: before, the backend
  // answered /sitemap.xml.
  const robots = await get('/robots.txt');
  const sitemapAt = sitemapLine(canonical);
  if (
    robots.status !== 200 ||
    !robots.headers.get('content-type')?.startsWith('text/plain') ||
    !robots.text.split(/\r?\n/).includes(sitemapAt)
  ) {
    throw new Error(`/robots.txt did not return the robots file with "${sitemapAt}"`);
  }
  const sitemap = await get('/sitemap.xml');
  if (
    sitemap.status !== 200 ||
    !/^(?:text|application)\/xml\b/.test(sitemap.headers.get('content-type') ?? '') ||
    !/<urlset[\s>]/.test(sitemap.text)
  ) {
    throw new Error('/sitemap.xml did not return the sitemap as XML');
  }
  // The link preview's image, at the address the home page names; only one on
  // this site is fetched, from the host checked.
  const imageAddress = ogImage(page.text);
  const image = imageAddress === undefined ? undefined : new URL(imageAddress, root);
  if (image?.origin !== canonical) {
    throw new Error('The home page names no og:image on this site');
  }
  const logo = await get(`${image.pathname}${image.search}`);
  if (logo.status !== 200 || logo.headers.get('content-type') !== 'image/png') {
    throw new Error(`${image.pathname}, the og:image, did not return a PNG`);
  }
  // A session page is never indexed. The id is random and has a session id's
  // shape, which is all nginx looks at: whether such a session exists is the
  // page's question, not nginx's (D146).
  const view = await get(`/v/${sessionShapedId()}`);
  if (
    view.status !== 200 ||
    !view.headers.get('content-type')?.includes('text/html') ||
    view.headers.get('x-robots-tag') !== 'noindex'
  ) {
    throw new Error('A session page did not answer 200 with X-Robots-Tag: noindex');
  }
  // The old receive URL is still the backend's, and receives nothing: it
  // answers 410 / 1009 naming the receive host (D187). Nothing is stored.
  const moved = await get(`/s/${sessionShapedId()}`);
  if (
    moved.status !== 410 ||
    !moved.headers.get('content-type')?.includes('application/json') ||
    JSON.parse(moved.text).errorCode !== 1009
  ) {
    throw new Error('/s/ on the site did not answer the JSON 410 (1009) naming the receive host');
  }
  // A path that starts with "s" outside /s/ is the frontend's, answered with
  // its 404 page (D146), no longer the backend's JSON (D183). A bare /s is not
  // asked: whether it reaches the backend depends on a Traefik option.
  const outside = await get('/sxyz');
  if (
    outside.status !== 404 ||
    !outside.headers.get('content-type')?.includes('text/html') ||
    outside.headers.get('x-robots-tag') !== indexable
  ) {
    throw new Error("/sxyz did not answer the frontend's 404 page");
  }
  // The MCP endpoint is the backend's (D203): a GET there is its JSON-RPC
  // 405 with Allow: POST, which reads nothing, stores nothing and opens no
  // stream. 0.45.0 passed this smoke while the proxy sent /mcp to the
  // frontend's 404 page.
  const mcp = await get('/mcp');
  if (
    mcp.status !== 405 ||
    mcp.headers.get('allow') !== 'POST' ||
    !mcp.headers.get('content-type')?.includes('application/json') ||
    JSON.parse(mcp.text).jsonrpc !== '2.0'
  ) {
    throw new Error("/mcp did not answer the MCP server's JSON-RPC 405");
  }
  // The status page (D209), another site, as the image's STATUS_PAGE_URL
  // says (#369): /status and /status/ each a 301 to it, its address exactly,
  // or without one the site's Page not found. Asked without following the
  // redirect, which is the answer checked. Not asked for when the setting is
  // not given (#381).
  if (operator.statusPageUrl !== undefined) {
    for (const path of STATUS_PATHS) {
      const status = await get(path, 'manual');
      if (operator.statusPageUrl === null) {
        if (!isPageNotFound(status)) {
          throw new Error(
            `${path} did not answer the site's Page not found, as an image without a status page does`,
          );
        }
      } else if (
        status.status !== 301 ||
        status.headers.get('location') !== operator.statusPageUrl
      ) {
        throw new Error(`${path} did not answer a 301 to the status page given`);
      }
    }
  }
  // The receive host (D187), through its own TCP route: an unknown session
  // answers the receiver's JSON 404, and nothing is stored.
  const receiver = await get(new URL(`/s/${sessionShapedId()}`, receiveRoot).href);
  if (
    receiver.status !== 404 ||
    !receiver.headers.get('content-type')?.includes('application/json') ||
    JSON.parse(receiver.text).errorCode !== 1001
  ) {
    throw new Error('The receive host did not answer an unknown session with the JSON 404 (1001)');
  }
  // It serves `/s/` alone: its root is the not-found route's 404 (1000).
  const receiveRootPage = await get(new URL('/', receiveRoot).href);
  if (
    receiveRootPage.status !== 404 ||
    !receiveRootPage.headers.get('content-type')?.includes('application/json') ||
    JSON.parse(receiveRootPage.text).errorCode !== 1000
  ) {
    throw new Error('The receive host did not answer / with the JSON 404 (1000)');
  }
  // And keeps crawlers out: only its own robots.txt can (D183, D187).
  const receiveRobots = await get(new URL('/robots.txt', receiveRoot).href);
  if (
    receiveRobots.status !== 200 ||
    !receiveRobots.headers.get('content-type')?.startsWith('text/plain') ||
    receiveRobots.text !== RECEIVE_ROBOTS_TXT
  ) {
    throw new Error('The receive host did not answer /robots.txt with "Disallow: /"');
  }
}

/**
 * How the smoke is run (D187, #381): the site, the receive host and the
 * site's second host, the last optional, as positional arguments, and the
 * operator's details the deployment's image was built with as options,
 * before, between or after them.
 */
export const USAGE =
  'Usage: node scripts/check-deployment.mjs <https-site-url> <https-receive-url> [<https-second-site-url>] [--status-page=<url>] [--contact-email=<address>] [--operator-texts=<true|false>] (an option empty for none, not checked when not given)';

/** Each option, as written, and what it gives `operatorSettings`. */
const OPTIONS = new Map([
  ['--status-page', 'statusPage'],
  ['--contact-email', 'contactEmail'],
  ['--operator-texts', 'operatorTexts'],
]);

/**
 * The command line, read: `base`, `receiveBase` and `aliasBase`, empty for
 * no second host, and `operator`, the details given (`operatorSettings`). An
 * option is `--name=<value>` or `--name <value>`, the second form taking no
 * value that starts with `-`; an option given twice, an option the smoke
 * does not know, a fourth positional argument, or a missing site or receive
 * host is refused. Nothing given is quoted back in a refusal.
 */
export function parseCommandLine(argv) {
  const positionals = [];
  const given = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const key = OPTIONS.get(name);

    if (key === undefined) {
      throw new Error(
        `The smoke takes the options --status-page, --contact-email and --operator-texts alone\n${USAGE}`,
      );
    }

    if (Object.hasOwn(given, key)) {
      throw new Error(`${name} is given more than once`);
    }

    if (equals !== -1) {
      given[key] = arg.slice(equals + 1);
      continue;
    }

    const value = argv[index + 1];

    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${name} needs its value: ${name}=<value>, empty for none`);
    }

    given[key] = value;
    index += 1;
  }

  const [base, receiveBase, aliasBase = ''] = positionals;

  if (!base || !receiveBase || positionals.length > 3) {
    throw new Error(USAGE);
  }

  return { base, receiveBase, aliasBase, operator: operatorSettings(given) };
}

/** What the smoke checks on a host, as the line that says it passed names it. */
export function checkedList(operator) {
  const parts = [
    'frontend',
    'API/database lookup',
    'API reference',
    'the about page in English and in Russian',
  ];

  if (operator.texts === true) parts.push('the Terms of Use and the Privacy Policy');
  if (operator.texts === false) parts.push('no Terms of Use or Privacy Policy (Page not found)');
  parts.push(
    'the Russian home page',
    operator.texts === false
      ? 'no changelog, changelog text or feeds (Page not found)'
      : 'the two changelog feeds',
  );
  if (typeof operator.contactEmail === 'string') {
    parts.push('security.txt with the contact address given');
  }
  if (operator.contactEmail === null) parts.push('no security.txt (404)');
  parts.push(
    'the files for search engines',
    'a session page',
    'the old receive URL (410)',
    'a path outside /s/',
    'the MCP endpoint (405)',
  );
  if (typeof operator.statusPageUrl === 'string') {
    parts.push("the status page's redirect (301)");
  }
  if (operator.statusPageUrl === null) parts.push('no status page (Page not found)');
  parts.push('the receive host');

  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** The line naming what the smoke does not check, its setting not given; `undefined` when each is given. */
export function notCheckedLine(operator) {
  const left = [];

  if (operator.texts === undefined) {
    left.push('the Terms of Use and the Privacy Policy (--operator-texts)');
  }
  if (operator.contactEmail === undefined) left.push('security.txt (--contact-email)');
  if (operator.statusPageUrl === undefined) left.push('/status (--status-page)');
  if (left.length === 0) return undefined;

  const named = left.length === 1 ? left[0] : `${left.slice(0, -1).join(', ')} and ${left.at(-1)}`;

  return `Not checked, as their setting is not given: ${named}`;
}

/**
 * The command line (`parseCommandLine`): the site and the receive host, then,
 * when one is given and not empty, the site's second host (#319, D275),
 * which is checked after the first once its certificate is there, as a host
 * closed to search whose pages name the first; both with the operator's
 * details given (#381), and first a line naming what is not checked.
 */
export async function main(
  argv,
  fetcher = globalThis.fetch,
  now = new Date(),
  sleep = sleepFor,
  log = console.log,
) {
  const { base, receiveBase, aliasBase, operator } = parseCommandLine(argv);
  const notChecked = notCheckedLine(operator);
  if (notChecked !== undefined) {
    log(notChecked);
  }
  const checked = checkedList(operator);
  await checkDeployment(base, fetcher, now, receiveBase, { operator });
  log(`Deployed ${checked} passed on ${new URL(base).host} (read-only)`);
  if (aliasBase === '') {
    return;
  }
  const alias = new URL(aliasBase);
  if (alias.protocol !== 'https:') throw new Error('Deployment check requires HTTPS');
  if (alias.username || alias.password) throw new Error('Do not put credentials in the URL');
  await waitForCertificate(alias.href, fetcher, CERTIFICATE_WAIT, sleep, log);
  await checkDeployment(alias.href, fetcher, now, receiveBase, {
    canonical: new URL(base).origin,
    closedToSearch: true,
    operator,
  });
  log(
    `Deployed ${checked} passed on ${alias.host}, every answer of its own with X-Robots-Tag: noindex (read-only)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
