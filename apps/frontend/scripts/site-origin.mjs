import process from 'node:process';
import { URL } from 'node:url';

/**
 * The inspector's addresses at build time (issue #320, D274): the site's
 * origin, `APP_ORIGIN`, and the receive host's, `RECEIVE_ORIGIN`, the names
 * the backend reads for the same two values; and since #319 (D275) the
 * site's second origin, `APP_ALIAS_ORIGIN`, the host the same site also
 * answers on, closed to search, where it moves on day X:
 * `https://webhook.qa-tools.ru` in production. An image is built for one
 * address: `.gitlab-ci.yml` sets all three once and passes them to the image
 * build as build arguments of `apps/frontend/Dockerfile`, and to the chart.
 * Unset or empty, the first two are production's, and the third is
 * production's while the site is production's and none for any other site,
 * so a plain local build is what it was before they existed and a copy that
 * sets only its two addresses names no host of production's.
 *
 * The files the site serves are written for production: the pages' heads,
 * `public/robots.txt`, `public/sitemap.xml`, the relay script, the OpenAPI
 * description, the agent documentation and `CHANGELOG.md` name
 * `https://qa-tools.ru` and `https://hook.qa-tools.ru`. The build passes each
 * through `nameSite()` on its way into `dist/`, which names the configured
 * origins in their place; built for production, every file is byte for byte
 * the one it was. The places the code composes an address itself, such as the
 * feeds' links or the about page's MCP address, take `APP_ORIGIN` from here.
 *
 * This module is read by the build and its tests only. Nothing the browser
 * loads imports it: it reads `process.env`.
 */

/** Production's three origins, the defaults and the names the sources are written with. */
export const PRODUCTION_ORIGINS = Object.freeze({
  app: 'https://qa-tools.ru',
  receive: 'https://hook.qa-tools.ru',
  alias: 'https://webhook.qa-tools.ru',
});

/**
 * A host as the build may name it: a host name, or an IPv6 address in
 * brackets, either with a port other than 0. A host name is dot-separated
 * labels, each 1 to 63 letters, digits and hyphens that neither starts nor
 * ends with a hyphen, with no empty label and no trailing dot (#340), the
 * rule the deploy job's check in `.gitlab-ci.yml` applies to the same values.
 * `URL` lets a host hold `"`, `'`, a backtick, braces, `$`, `&`, `;` and
 * more, `%22` decoded to `"` among them, and the build pastes the origin into
 * the pages' attributes, JSON and the relay script's string; it also lets
 * through `-`, `.`, `a..b` and `a.b.`, which are no host names and which the
 * chart's Ingress would refuse only at deployment. By the time the host is
 * read here, `URL` has lowered its letters and written a non-ASCII one in
 * punycode, `xn--…`.
 */
const SITE_IPV6_HOST = /^\[[0-9a-f:]+\]$/;

/** A label of a host name, its length aside: no hyphen at either end. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Whether `hostname`, `URL`'s, is a host the build may name. */
function isSiteHost(hostname) {
  return (
    SITE_IPV6_HOST.test(hostname) ||
    hostname.split('.').every((label) => label.length <= 63 && HOST_LABEL.test(label))
  );
}

/**
 * An origin from the environment: an http or https origin, nothing more, as
 * the backend's `APP_ORIGIN` and `RECEIVE_ORIGIN` are (D187, D203). What is
 * kept is `URL.origin`, so `https://Inspector.Example:443` is
 * `https://inspector.example`. A path, query, fragment or credentials fail
 * the build rather than being dropped, since every page would print the
 * shortened value, and so do a host `isSiteHost()` refuses and port 0.
 */
export function parseSiteOrigin(name, raw, fallback, example = fallback) {
  const value = (raw ?? '').trim();

  if (value === '') {
    return fallback;
  }

  // The value is never quoted back, in case credentials were pasted in it.
  const refusal = `${name} must be an http or https origin, such as ${example}`;
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
    throw new Error(`${name} must not carry credentials`);
  }

  if (url.pathname !== '/' || /[?#]/.test(value)) {
    throw new Error(`${name} must be an origin alone, with no path, query or fragment`);
  }

  if (!isSiteHost(url.hostname)) {
    throw new Error(
      `${name} must name its host as dot-separated labels of letters, digits and inner hyphens, or as an IPv6 address in brackets`,
    );
  }

  if (url.port === '0') {
    throw new Error(`${name} must not name port 0`);
  }

  return url.origin;
}

/**
 * The origins from an environment: the site's and the receive host's,
 * production's when unset, and the site's second, `APP_ALIAS_ORIGIN` (D275),
 * production's when unset while the site is production's and `null`, none,
 * for any other site. Refused: a second origin that is the site's or the
 * receive host's, and origins the build could not name as they are - one
 * that `renameProduction()` would turn into another, such as a site on
 * `https://webhook.qa-tools.ru` with `https://qa-tools.ru` as its second,
 * whose pages would come out with the two swapped.
 */
export function siteOrigins(env = process.env) {
  const app = parseSiteOrigin('APP_ORIGIN', env.APP_ORIGIN, PRODUCTION_ORIGINS.app);
  const receive = parseSiteOrigin('RECEIVE_ORIGIN', env.RECEIVE_ORIGIN, PRODUCTION_ORIGINS.receive);
  const alias = parseSiteOrigin(
    'APP_ALIAS_ORIGIN',
    env.APP_ALIAS_ORIGIN,
    app === PRODUCTION_ORIGINS.app ? PRODUCTION_ORIGINS.alias : null,
    PRODUCTION_ORIGINS.alias,
  );
  const origins = Object.freeze({ app, receive, alias });

  if (alias === app || alias === receive) {
    throw new Error('APP_ALIAS_ORIGIN must name a host other than the site and the receive host');
  }

  for (const [name, origin] of [
    ['APP_ORIGIN', app],
    ['RECEIVE_ORIGIN', receive],
    ['APP_ALIAS_ORIGIN', alias],
  ]) {
    if (origin !== null && renameProduction(origin, origins) !== origin) {
      throw new Error(
        `${name} names an address of production's that the build would name otherwise; set the three origins so that each keeps its own`,
      );
    }
  }

  return origins;
}

/**
 * The origin the renamed relay script reads by default (D275): the site's
 * second, `https://webhook.qa-tools.ru` in production, or the site's own when
 * there is none.
 */
export function relayApiOrigin(origins = SITE_ORIGINS) {
  return origins.alias ?? origins.app;
}

/**
 * Whether a set of origins is production's. Text built for production is
 * returned as it is, so the production build cannot differ by a byte. A set
 * that gives no second origin has none.
 */
export function isProduction(origins) {
  return (
    origins.app === PRODUCTION_ORIGINS.app &&
    origins.receive === PRODUCTION_ORIGINS.receive &&
    (origins.alias ?? null) === PRODUCTION_ORIGINS.alias
  );
}

/**
 * A production name: `https://` or `wss://` and a host, or the host alone,
 * `qa-tools.ru`, `hook.qa-tools.ru` or, since D275, `webhook.qa-tools.ru`.
 * Not one inside a longer name: a letter, digit, `@`, `.`, `:` or `-` before
 * it keeps `contact@qa-tools.ru`, `status.qa-tools.ru` and the feeds'
 * `tag:qa-tools.ru,2026:` ids as they are, the platform's and permanent; a
 * letter, digit or `-` after it, or a `.` and one of them, keeps a longer
 * host; and a `:` and a digit after it, a port, keeps the host with its port,
 * another origin than production's (#339). So a configured origin on a
 * production host with a port of its own, `https://qa-tools.ru:8443`, is no
 * production name, and naming it again leaves it as it is rather than adding
 * the port a second time. Every part is fixed text or a fixed choice, so a
 * scan is linear in the text's length.
 */
const PRODUCTION_NAME =
  /(?<![\w@.:-])(?:(https|wss):\/\/)?(hook\.|webhook\.)?qa-tools\.ru(?![\w-]|\.[\w-]|:\d)/g;

/** An origin under the WebSocket scheme of the same security: `wss:` for `https:`. */
function webSocketOrigin(origin) {
  const url = new URL(origin);

  return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
}

/**
 * `text`, written for production, with every production name replaced by the
 * configured one: `https://qa-tools.ru` by the site's origin,
 * `https://hook.qa-tools.ru` by the receive host's,
 * `https://webhook.qa-tools.ru` by the site's second (D275), or by the site's
 * own where there is none, a `wss://` name by its origin under the WebSocket
 * scheme, and a bare host by the host. The names kept above stay, a host with
 * a port among them. Text that names the configured origins already comes
 * back unchanged, so a file may pass through twice, as `CHANGELOG.md` does on
 * its way into the changelog page: `siteOrigins()` refuses origins of which
 * that would not hold.
 */
export function renameProduction(text, origins) {
  // Each name's three spellings, worked out once rather than at every match.
  const spellings = (origin) => ({
    https: origin,
    wss: webSocketOrigin(origin),
    host: new URL(origin).host,
  });
  const named = {
    '': spellings(origins.app),
    'hook.': spellings(origins.receive),
    'webhook.': spellings(origins.alias ?? origins.app),
  };

  return text.replace(PRODUCTION_NAME, (_name, scheme, sub = '') => named[sub][scheme ?? 'host']);
}

// Below the rename, which `siteOrigins()` runs, so that its pattern is set.
/** The origins this build names. */
export const SITE_ORIGINS = siteOrigins();

/** The site's origin this build names, `https://qa-tools.ru` in production. */
export const APP_ORIGIN = SITE_ORIGINS.app;

/** The receive host's origin this build names, `https://hook.qa-tools.ru` in production. */
export const RECEIVE_ORIGIN = SITE_ORIGINS.receive;

/** `renameProduction()`, returning production's own text untouched. */
export function nameSite(text, origins = SITE_ORIGINS) {
  return isProduction(origins) ? text : renameProduction(text, origins);
}

/**
 * A Vite plugin that names the configured origins in every page a build or
 * the dev server writes: the templates' canonical, hreflang, `og:url` and
 * `og:image` addresses, and what the page plugins put in their bodies. Last
 * of the page transforms, so the bodies are in by then.
 */
export function siteOriginPlugin(origins = SITE_ORIGINS) {
  return {
    name: 'webhook-inspector-site-origin',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => nameSite(html, origins),
    },
  };
}
