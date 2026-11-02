/**
 * Runtime configuration.
 *
 * Values come from the environment. Missing or invalid values fail here, at
 * startup, rather than surfacing as a confusing failure on the first request.
 */
import {
  API_CALL_LIMIT,
  MAX_RECEIVE_CONNECTIONS_PER_ADDRESS,
  SESSION_CREATE_LIMIT,
} from '@webhook-inspector/shared';
import { isAddressOrCidr, isEveryAddressCidr } from './lib/ip.ts';

/** Whether the receive listener expects a PROXY protocol header (D187). */
export type ReceiveProxyProtocol = 'off' | 'v2';

/**
 * Whether the receive listener serves a connection that opens with the
 * HTTP/2 connection preface as HTTP/2 (D263). `off`, the default and
 * production's value until #115, gives the preface to the HTTP/1.1 parser as
 * before.
 */
export type ReceiveHttp2 = 'off' | 'on';

/** The receive listener's port when `RECEIVE_PORT` is unset (D187). */
export const DEFAULT_RECEIVE_PORT = 3001;

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  /**
   * The trust boundary (D111). On the receive listener these are the only
   * peers whose PROXY protocol header is accepted, and with `v2` on a
   * connection from anybody else is refused (D187). On the application
   * listener they are the peers whose `X-Forwarded-For` decides `request.ip`,
   * which nothing stored reads any more. Empty means none, and empty is the
   * default, which is local development.
   */
  trustedProxyCidrs: string[];
  /**
   * The port of the second listener, which receives webhooks and nothing else
   * (D187). The same process, so a capture reaches the realtime hub directly.
   */
  receivePort: number;
  /**
   * The public origin of the receive listener, `https://hook.qa-tools.ru` in
   * production: what `receiveUrl` and the application listener's `410` name.
   * Locally the listener itself, `http://127.0.0.1:<receivePort>`.
   */
  receiveOrigin: string;
  /**
   * The application's public origin, `https://qa-tools.ru` in production:
   * what the inspector links `/mcp` gives compose, and an `Origin` a browser
   * may send to `/mcp` (D203), beside `appAliasOrigin`. Locally the dev
   * server's, `http://localhost:5173`.
   */
  appOrigin: string;
  /**
   * The application's second public origin, `https://webhook.qa-tools.ru` in
   * production (D275): the host the same site also answers on, where it
   * moves on day X, and the other `Origin` a browser may send to `/mcp`. It
   * builds no link: `appOrigin` does. `null`, none, when `APP_ALIAS_ORIGIN`
   * is unset or empty, as it is locally and in the tests.
   */
  appAliasOrigin: string | null;
  /**
   * `v2` in production, where every connection to the receive listener comes
   * from Traefik's TCP route with a PROXY protocol v2 header carrying the
   * sender's address; `off` locally and in the tests, where the socket peer is
   * the sender (D187).
   */
  receiveProxyProtocol: ReceiveProxyProtocol;
  /**
   * `on` serves a receive connection that opens with the HTTP/2 connection
   * preface, after its PROXY header when there is one, as HTTP/2 (D263);
   * `off`, the default and production's value, leaves every connection to
   * the HTTP/1.1 parser, as before. `RECEIVE_HTTP2`.
   */
  receiveHttp2: ReceiveHttp2;
  /**
   * How many connections one sender address may have open at once to the
   * receive listener, counted by its PROXY protocol layer, so only with `v2`
   * (D227): 512 unless `RECEIVE_CONNECTIONS_PER_ADDRESS` says otherwise, and
   * `0` turns the bound off, the one-line recovery. The chart sets it from
   * `receive.connectionsPerAddress`.
   */
  receiveConnectionsPerAddress: number;
  /**
   * The per-address limits of the API, per minute (D201): the production
   * numbers, 60 session creations and 1200 other calls, unless
   * `RATE_LIMIT_SESSION_CREATES_PER_MINUTE` or `RATE_LIMIT_API_CALLS_PER_MINUTE`
   * says otherwise. The browser suite raises them, since it calls the API
   * from one address for minutes on end; production sets neither.
   */
  rateLimits: { sessionCreates: number; apiCalls: number };
}

/**
 * Reads the trust boundary from the environment.
 *
 * Only literal addresses and CIDR ranges are accepted, under the strict rule in
 * `lib/ip.ts`. A hop count is refused - `1` is not an address here, even though
 * `ipaddr.parse` would happily read it as `0.0.0.1` - because a hop count is
 * believed by whoever happens to be talking to the process, which is the
 * failure mode the boundary exists to prevent (D111). The named presets
 * `@fastify/proxy-addr` also understands (`loopback`, `linklocal`,
 * `uniquelocal`) are refused too, so that whatever is trusted is written out in
 * full and can be read off the deployment values.
 *
 * An unparseable entry fails startup. A trust boundary that silently dropped
 * the entry it could not read would be a boundary nobody knows the shape of.
 *
 * `/0` gets its own message. It is the one refusal where the generic wording
 * would be untrue - `0.0.0.0/0` is a perfectly well-formed CIDR range, and it is
 * refused for what it means, not for how it is spelled. It is a guard against a
 * typo rather than a boundary: `0.0.0.0/1` and `128.0.0.0/1` together cover the
 * same space and both pass, so an allow-list can still be widened to everything
 * by somebody who means to.
 */
function parseTrustedProxyCidrs(raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (isEveryAddressCidr(entry)) {
      throw new Error(
        `TRUSTED_PROXY_CIDRS does not accept "${entry}": a /0 prefix trusts every address. ` +
          "List the proxy's range explicitly.",
      );
    }

    if (!isAddressOrCidr(entry)) {
      throw new Error(
        'TRUSTED_PROXY_CIDRS must be a comma-separated list of IP addresses or CIDR ranges, ' +
          `received "${entry}".`,
      );
    }
  }

  return entries;
}

/** `off`, the default, or `v2`; nothing else, so a typo fails startup. */
function parseReceiveProxyProtocol(raw: string | undefined): ReceiveProxyProtocol {
  const value = (raw ?? '').trim();

  if (value === '' || value === 'off') {
    return 'off';
  }

  if (value === 'v2') {
    return 'v2';
  }

  throw new Error(`RECEIVE_PROXY_PROTOCOL must be "off" or "v2", received "${value}".`);
}

/**
 * `off`, the default, or `on`; nothing else, so that a mistyped value never
 * switches the HTTP/2 path on by accident (D263).
 */
function parseReceiveHttp2(raw: string | undefined): ReceiveHttp2 {
  const value = (raw ?? '').trim();

  if (value === '' || value === 'off') {
    return 'off';
  }

  if (value === 'on') {
    return 'on';
  }

  throw new Error(`RECEIVE_HTTP2 must be "on" or "off", received "${value}".`);
}

/** The application's public origin locally: the dev server's (D203). */
export const DEFAULT_APP_ORIGIN = 'http://localhost:5173';

/**
 * A public origin from the environment (D187, D203): an http or https
 * origin, nothing more. What is kept is `URL.origin`, so
 * `https://HOOK.qa-tools.ru:443` is `https://hook.qa-tools.ru`. A path,
 * query, fragment or credentials are refused rather than dropped: the value
 * is printed into every `receiveUrl` or inspector link and into the old
 * host's `410`, and a URL quietly cut short would send somebody somewhere
 * nobody chose.
 */
function parseOrigin(
  name: string,
  raw: string | undefined,
  fallback: string,
  example: string,
): string {
  const value = (raw ?? '').trim();

  if (value === '') {
    return fallback;
  }

  // The value is never quoted back: a URL pasted with credentials in it would
  // otherwise land in the log of a pod that failed to start.
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http or https origin, such as ${example}.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an http or https origin, such as ${example}.`);
  }

  if (url.username !== '' || url.password !== '') {
    throw new Error(`${name} must not carry credentials.`);
  }

  if (url.pathname !== '/' || /[?#]/.test(value)) {
    throw new Error(`${name} must be an origin alone, with no path, query or fragment.`);
  }

  return url.origin;
}

/**
 * A limit per minute: a positive whole number in decimal digits, or the
 * default when the variable is unset or empty. Anything else fails startup,
 * so a typo never leaves the API without the limit somebody meant.
 */
function parseRateLimit(name: string, raw: string | undefined, fallback: number): number {
  const value = (raw ?? '').trim();

  if (value === '') {
    return fallback;
  }

  if (!/^[1-9]\d{0,8}$/.test(value)) {
    throw new Error(`${name} must be a whole number from 1 to 999999999, received "${value}".`);
  }

  return Number(value);
}

/**
 * The receive host's connections per address (D227): a whole number in
 * decimal digits, `0` turning the bound off, or the default when the variable
 * is unset or empty. Anything else fails startup, so a typo never turns the
 * bound off unnoticed or leaves it at a number nobody meant.
 */
function parseConnectionLimit(name: string, raw: string | undefined, fallback: number): number {
  const value = (raw ?? '').trim();

  if (value === '') {
    return fallback;
  }

  if (!/^(?:0|[1-9]\d{0,8})$/.test(value)) {
    throw new Error(
      `${name} must be 0 (no limit) or a whole number from 1 to 999999999, received "${value}".`,
    );
  }

  return Number(value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and start the database.');
  }

  const port = Number(env.BACKEND_PORT ?? 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BACKEND_PORT must be a valid port number, received "${env.BACKEND_PORT}".`);
  }

  const receivePort = Number(env.RECEIVE_PORT ?? DEFAULT_RECEIVE_PORT);

  if (!Number.isInteger(receivePort) || receivePort < 1 || receivePort > 65535) {
    throw new Error(`RECEIVE_PORT must be a valid port number, received "${env.RECEIVE_PORT}".`);
  }

  if (receivePort === port) {
    throw new Error(
      `RECEIVE_PORT and BACKEND_PORT must differ: the receive listener is a server of its own (D187).`,
    );
  }

  // Containers must listen on every interface; local development should not
  // expose the backend to the surrounding network.
  const host = env.BACKEND_HOST ?? '127.0.0.1';
  const trustedProxyCidrs = parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS);
  const receiveProxyProtocol = parseReceiveProxyProtocol(env.RECEIVE_PROXY_PROTOCOL);
  const receiveHttp2 = parseReceiveHttp2(env.RECEIVE_HTTP2);

  if (receiveProxyProtocol === 'v2') {
    // With nobody trusted, every connection would be refused: a receive host
    // that answers nothing. Refused here rather than discovered in production.
    if (trustedProxyCidrs.length === 0) {
      throw new Error(
        'RECEIVE_PROXY_PROTOCOL=v2 needs TRUSTED_PROXY_CIDRS: the PROXY header is accepted ' +
          'only from a peer inside the trust boundary (D111, D187).',
      );
    }

    // Fastify answers `localhost` with a second server for the other address
    // family, and that server would accept connections without the PROXY
    // layer, which is installed on the first one only.
    if (host === 'localhost') {
      throw new Error(
        'RECEIVE_PROXY_PROTOCOL=v2 cannot listen on BACKEND_HOST=localhost: name one address, ' +
          'such as 0.0.0.0 or 127.0.0.1 (D187).',
      );
    }
  }

  const appOrigin = parseOrigin(
    'APP_ORIGIN',
    env.APP_ORIGIN,
    DEFAULT_APP_ORIGIN,
    'https://qa-tools.ru',
  );
  const appAliasOrigin =
    parseOrigin('APP_ALIAS_ORIGIN', env.APP_ALIAS_ORIGIN, '', 'https://webhook.qa-tools.ru') ||
    null;

  // The same origin twice would let in nothing more, and says the
  // configuration was not the one meant.
  if (appAliasOrigin === appOrigin) {
    throw new Error('APP_ALIAS_ORIGIN must be an origin other than APP_ORIGIN.');
  }

  return {
    databaseUrl,
    host,
    port,
    trustedProxyCidrs,
    receivePort,
    receiveOrigin: parseOrigin(
      'RECEIVE_ORIGIN',
      env.RECEIVE_ORIGIN,
      `http://127.0.0.1:${receivePort}`,
      'https://hook.qa-tools.ru',
    ),
    appOrigin,
    appAliasOrigin,
    receiveProxyProtocol,
    receiveHttp2,
    receiveConnectionsPerAddress: parseConnectionLimit(
      'RECEIVE_CONNECTIONS_PER_ADDRESS',
      env.RECEIVE_CONNECTIONS_PER_ADDRESS,
      MAX_RECEIVE_CONNECTIONS_PER_ADDRESS,
    ),
    rateLimits: {
      sessionCreates: parseRateLimit(
        'RATE_LIMIT_SESSION_CREATES_PER_MINUTE',
        env.RATE_LIMIT_SESSION_CREATES_PER_MINUTE,
        SESSION_CREATE_LIMIT,
      ),
      apiCalls: parseRateLimit(
        'RATE_LIMIT_API_CALLS_PER_MINUTE',
        env.RATE_LIMIT_API_CALLS_PER_MINUTE,
        API_CALL_LIMIT,
      ),
    },
  };
}
