/**
 * The operator's details a build names (issue #369): the status page, the
 * contact address, and whether the operator's own texts are shown. Each is
 * a setting of the frontend build, passed like `APP_ORIGIN` (D274): a build
 * argument of `apps/frontend/Dockerfile`, which `.gitlab-ci.yml` sets for
 * production's image from the project's CI/CD variables
 * `DEPLOY_STATUS_PAGE_URL`, `DEPLOY_CONTACT_EMAIL` and `DEPLOY_OPERATOR_TEXTS`
 * (#367). Unset or empty, the detail is left out; nothing here
 * falls back to production's values, so a copy built from the repository
 * names nobody's status page, address or terms unless it gives its own.
 *
 * - `STATUS_PAGE_URL`: the public status page, an http or https address with
 *   no query, fragment or credentials. The header's `Status ↗` link, the
 *   `/status` redirect (`scripts/nginx-conf.mjs`), the agent index and the API
 *   description's sentence name it; unset, none of them is there, and
 *   `/status` is the application's 404.
 * - `CONTACT_EMAIL`: the contact address. The footer, the about pages,
 *   `security.txt`, the legal pages and the API description's `info.contact`
 *   name it; unset, no address is shown and no `security.txt` is served.
 * - `OPERATOR_TEXTS`: `true` shows the operator's texts, in both languages:
 *   the about pages' lines on who runs the service and who pays for it, the
 *   Terms of Use and the Privacy Policy with the footer's links to them, and
 *   the API description's sentences pointing at them. `false` or unset leaves
 *   them out, and `/terms` and `/privacy` answer the application's 404. The
 *   texts name the contact address and the status page, so `true` needs both.
 *
 * The module has no imports, so the browser bundle, the build's scripts and
 * the tests all load it. A Vite build hands the bundle the settings it read
 * as `__WEBHOOK_INSPECTOR_OPERATOR__` (`vite.config.ts`); outside one - the
 * build's scripts, the Vite configuration itself and the tests - it reads
 * them from the process's environment.
 */

/** The operator's details as one build names them. */
export interface Operator {
  /** The status page's address as `URL` writes it, `https://status.example.com/`, or `null` for none. */
  readonly statusPageUrl: string | null;
  /** The contact address, `contact@example.com`, or `null` for none. */
  readonly contactEmail: string | null;
  /** Whether the operator's texts are shown: the about pages' lines, the Terms and the Privacy Policy. */
  readonly texts: boolean;
}

/** An operator whose texts are shown: both details are set (`parseOperator` refuses anything else). */
export interface OperatorWithTexts extends Operator {
  readonly statusPageUrl: string;
  readonly contactEmail: string;
  readonly texts: true;
}

/** The three settings, by the names the build reads. */
export const OPERATOR_SETTINGS = ['STATUS_PAGE_URL', 'CONTACT_EMAIL', 'OPERATOR_TEXTS'] as const;

/** A build with none of the settings: no status page, no contact, no operator's texts. */
export const NO_OPERATOR: Operator = Object.freeze({
  statusPageUrl: null,
  contactEmail: null,
  texts: false,
});

/** A label of a host name: letters, digits and inner hyphens. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * Whether `host` is a host name: dot-separated labels of 1 to 63 letters,
 * digits and inner hyphens, at most 253 characters, no empty label and no
 * trailing dot - the rule `site-origin.mjs` and the deploy job apply to the
 * inspector's own hosts (#340).
 */
function isHostName(host: string): boolean {
  return (
    host.length <= 253 &&
    host.split('.').every((label) => label.length <= 63 && HOST_LABEL.test(label))
  );
}

/**
 * The path a status page's address may have: `/` and the characters of a
 * URL's path that need no quoting anywhere the build writes it - an nginx
 * `return`, an HTML attribute, a Markdown link, JSON - with every `%` the
 * start of an escape. `URL` has already escaped spaces, quotes, `<`, `>`,
 * braces and backticks by then; `$`, `;`, `'`, `(`, `)` and the like it
 * keeps, and they are refused here.
 */
const STATUS_PATH = /^\/(?:[A-Za-z0-9._~/-]|%[0-9A-Fa-f]{2})*$/;

/**
 * `STATUS_PAGE_URL`: the address as `URL` writes it, its host lowered and
 * its path at least `/`, or `null` when unset or blank. Refused: anything but
 * an http or https address of a host name with any port but 0 and a path of
 * `STATUS_PATH`, and a query, a fragment or credentials. The value is never
 * quoted back, in case something else was pasted in it.
 */
export function parseStatusPageUrl(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();

  if (value === '') {
    return null;
  }

  const refusal =
    'STATUS_PAGE_URL must be an http or https address, such as https://status.example.com/';
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(refusal);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(refusal);
  }

  if (url.username !== '' || url.password !== '') {
    throw new Error('STATUS_PAGE_URL must not carry credentials');
  }

  if (/[?#]/.test(value)) {
    throw new Error('STATUS_PAGE_URL must have no query or fragment');
  }

  if (!isHostName(url.hostname) || url.port === '0') {
    throw new Error(
      'STATUS_PAGE_URL must name its host as dot-separated labels of letters, digits and inner hyphens, with any port but 0',
    );
  }

  if (!STATUS_PATH.test(url.pathname)) {
    throw new Error(
      'STATUS_PAGE_URL must have a path of letters, digits, ".", "_", "~", "-", "/" and percent escapes only',
    );
  }

  return url.href;
}

/**
 * The part of a contact address before its `@`: dot-separated runs of
 * letters, digits and `_`, `%`, `+` and `-`, which no page, file or mail link
 * the build writes needs to quote.
 */
const LOCAL_PART = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*$/;

/**
 * `CONTACT_EMAIL`: the address as given, trimmed, or `null` when unset or
 * blank. Refused: anything but `LOCAL_PART`, an `@` and a host name, at most
 * 64 characters before the `@` and 254 in all. Never quoted back.
 */
export function parseContactEmail(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();

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
      'CONTACT_EMAIL must be one mail address of letters, digits, ".", "_", "%", "+" and "-" before its "@" and a host name after it, such as contact@example.com',
    );
  }

  return value;
}

/** `OPERATOR_TEXTS`: `true` or `false`, `false` when unset or blank; anything else is refused. */
export function parseOperatorTexts(raw: string | undefined): boolean {
  const value = (raw ?? '').trim();

  if (value === '' || value === 'false') {
    return false;
  }

  if (value === 'true') {
    return true;
  }

  throw new Error('OPERATOR_TEXTS must be true or false');
}

/**
 * The operator's details from an environment, each left out when unset.
 * Refused: a value of the wrong form, and the operator's texts without both
 * the contact address and the status page, which they name.
 */
export function parseOperator(env: Readonly<Record<string, string | undefined>>): Operator {
  const operator = {
    statusPageUrl: parseStatusPageUrl(env.STATUS_PAGE_URL),
    contactEmail: parseContactEmail(env.CONTACT_EMAIL),
    texts: parseOperatorTexts(env.OPERATOR_TEXTS),
  };

  if (operator.texts && (operator.statusPageUrl === null || operator.contactEmail === null)) {
    throw new Error(
      "OPERATOR_TEXTS=true needs CONTACT_EMAIL and STATUS_PAGE_URL: the operator's texts name the contact address and the status page",
    );
  }

  return Object.freeze(operator);
}

/** `operator` when its texts are shown, with both details then set; `null` otherwise. */
export function operatorWithTexts(operator: Operator): OperatorWithTexts | null {
  return operator.texts && operator.statusPageUrl !== null && operator.contactEmail !== null
    ? (operator as OperatorWithTexts)
    : null;
}

/** A contact address as a link: `mailto:` and the address. */
export function mailtoOf(address: string): string {
  return `mailto:${address}`;
}

/**
 * A status page's address the way a sentence names it: with no slash after
 * the host when its path is `/` alone, as `https://status.example.com`.
 */
export function statusPageInProse(url: string): string {
  const parsed = new URL(url);

  return parsed.pathname === '/' ? parsed.origin : url;
}

/** The build's settings, as `vite.config.ts` defines them; undefined outside a Vite build. */
declare const __WEBHOOK_INSPECTOR_OPERATOR__: unknown;

/** The defined settings as given, or none for anything of another shape. */
export function parseBuiltOperator(value: unknown): Operator {
  if (typeof value !== 'object' || value === null) {
    return NO_OPERATOR;
  }

  const record = value as Record<string, unknown>;
  const text = (name: string) => {
    const item = Object.hasOwn(record, name) ? record[name] : null;

    return typeof item === 'string' && item !== '' ? item : null;
  };
  const operator = {
    statusPageUrl: text('statusPageUrl'),
    contactEmail: text('contactEmail'),
    texts: Object.hasOwn(record, 'texts') && record.texts === true,
  };

  return Object.freeze({
    ...operator,
    texts: operator.texts && operator.statusPageUrl !== null && operator.contactEmail !== null,
  });
}

/** The process's environment where there is one, Node's; an empty one in a browser. */
function environment(): Readonly<Record<string, string | undefined>> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/** The operator's details this build names. */
export const OPERATOR: Operator =
  typeof __WEBHOOK_INSPECTOR_OPERATOR__ === 'undefined'
    ? parseOperator(environment())
    : parseBuiltOperator(__WEBHOOK_INSPECTOR_OPERATOR__);

/** `OPERATOR` when its texts are shown, `null` otherwise. */
export const OPERATOR_TEXTS: OperatorWithTexts | null = operatorWithTexts(OPERATOR);
