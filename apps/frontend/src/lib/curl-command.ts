import type { RequestDetails } from '@webhook-inspector/shared';
import { binaryString, decodeUtf8 } from './bytes.ts';
import { receivedBody } from './received-body.ts';

/**
 * `Copy as cURL`: a captured request as a command that re-sends it (D167).
 *
 * The command is for POSIX shells - sh, bash and zsh - and nothing else:
 * Windows `cmd` and PowerShell quote differently and are out of scope. It is
 * built from the detail the panel already holds, so there is no API for it,
 * and it is a pure function of that detail and of where the page is, which is
 * what lets every rule below be unit-tested and every command be run through
 * real shells and real curl in `curl-command.roundtrip.test.ts`.
 */

/** What the command is built from: the fields of the detail response it reads. */
export type CurlSource = Pick<
  RequestDetails,
  'method' | 'path' | 'queryString' | 'headers' | 'body' | 'bodyBase64' | 'isBinary' | 'bodySize'
>;

export interface CurlTarget {
  /**
   * The origin of the session's receive URL, `https://hook.qa-tools.ru` in
   * production (D187): pasted unchanged, the command re-captures into the
   * same session on the same path. Retargeting it is editing the host.
   */
  origin: string;
  /** The page's session, for a request captured before its path was stored (D102). */
  sessionId: string;
}

/**
 * Header names never written into the command, lower-cased and compared with
 * a captured name lower-cased (D167):
 *
 * - `Host` and `Content-Length`, which curl computes for the URL and the body
 *   it actually sends;
 * - the hop-by-hop headers, which describe the sender's connection rather than
 *   the request, and `Expect`, which curl manages itself.
 *
 * Nothing else is left out. The eleven names the in-cluster proxy managed
 * (`X-Forwarded-*`, `X-Real-Ip`, D144) and an `Accept-Encoding: gzip` are
 * written like any other header, for every capture: since v0.36.0 nothing is
 * added to a capture, so a new capture's are the sender's own (D187), and a
 * capture stored earlier is not told apart (#114). The relay script keeps
 * leaving them out (D202).
 */
export const EXCLUDED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'expect',
]);

/**
 * The largest body passed to curl as an argument, in UTF-8 bytes. A single
 * argument over 128 KiB fails on Linux (`MAX_ARG_STRLEN`), and the arguments
 * together are limited to 1 MiB on macOS (`ARG_MAX`, environment included), so
 * a larger body goes through stdin from the shell's built-in `printf`, which
 * is not subject to either.
 */
export const INLINE_BODY_MAX_BYTES = 64 * 1024;

/**
 * Whether text holds a character that does not survive being pasted into a
 * terminal: a C0 control other than tab (and line feed, where one may be),
 * DEL or a C1 control. A carriage return is turned into a line feed on the way
 * in - by the terminal, and by zsh's bracketed paste - and the others are read
 * by the line editor as keys. A body holding one goes through Base64 instead,
 * whose alphabet is plain ASCII, and a header or the URL through `printf`
 * (D167).
 */
function holdsUnpasteable(text: string, { lineFeed }: { lineFeed: boolean }): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code === 0x09 || (code === 0x0a && lineFeed)) {
      continue;
    }

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }

  return false;
}

/** Whether a string is bytes, one character per byte, as Node reads header bytes (D145). */
function isByteString(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0xff) {
      return false;
    }
  }

  return true;
}

/**
 * Whether a captured header is left out of the command (D167): by its name
 * alone, whatever its value. An `Accept-Encoding: gzip` is kept, so a replay
 * may get a gzip answer, which curl prints undecoded (#114).
 */
export function isExcludedHeader([name]: readonly [string, string]): boolean {
  return EXCLUDED_HEADER_NAMES.has(name.toLowerCase());
}

/** How the body reaches curl. */
type BodyPlan =
  | { kind: 'none' }
  | { kind: 'inline'; text: string }
  | { kind: 'text-stdin'; text: string }
  | { kind: 'base64-stdin'; base64: string };

/**
 * The command, one option per line, joined by ` \`.
 *
 * - **URL**: the receive URL's origin, the stored `path` exactly as stored and `?` +
 *   the query string when there is one. A request captured before `path` was
 *   stored uses `/s/<session-id>`. `--globoff` keeps curl from reading `[`,
 *   `]`, `{` or `}` as a glob, and `--path-as-is` from resolving a `.` or `..`
 *   segment of the path.
 * - **Method**: `HEAD` is `--head`, never `-X HEAD`, which would make curl wait
 *   for a body. `GET` without a body and `POST` with one are what curl sends
 *   anyway; every other method, `GET` with a body included, gets `-X`.
 * - **Headers**: in captured order and case, duplicates kept, one `-H` each,
 *   less `isExcludedHeader`. An empty value is written `Name;`, because
 *   `Name:` makes curl remove the header. curl's own `User-Agent` and `Accept`
 *   are removed when none was captured, and its form `Content-Type` when a
 *   body is sent without one.
 * - **Body**: byte for byte (D007). Text that pastes safely is inline up to
 *   `INLINE_BODY_MAX_BYTES` with `--data-raw`, which never reads a file named
 *   by a body starting with `@`; larger text is piped from `printf`; anything
 *   else is piped as Base64 through `base64 --decode`.
 */
export function buildCurlCommand(request: CurlSource, target: CurlTarget): string {
  const path = request.path ?? `/s/${target.sessionId}`;
  const url = `${target.origin}${path}${request.queryString === '' ? '' : `?${request.queryString}`}`;
  const body = planBody(request);
  const hasBody = body.kind !== 'none';
  const options: string[] = [];

  if (/[[\]{}]/.test(url)) {
    options.push('--globoff');
  }

  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    options.push('--path-as-is');
  }

  if (request.method === 'HEAD') {
    options.push('--head');
  } else if (!(request.method === 'GET' && !hasBody) && !(request.method === 'POST' && hasBody)) {
    options.push(
      `-X ${/^[A-Z][A-Z0-9-]*$/.test(request.method) ? request.method : quote(request.method)}`,
    );
  }

  const headers = request.headers.filter((pair) => !isExcludedHeader(pair));
  const captured = new Set(headers.map(([name]) => name.toLowerCase()));

  for (const [name, value] of headers) {
    options.push(`-H ${byteWord(value === '' ? `${name};` : `${name}: ${value}`)}`);
  }

  if (!captured.has('user-agent')) {
    options.push(`-H 'User-Agent:'`);
  }

  if (!captured.has('accept')) {
    options.push(`-H 'Accept:'`);
  }

  if (hasBody && !captured.has('content-type')) {
    options.push(`-H 'Content-Type:'`);
  }

  if (body.kind === 'inline') {
    options.push(`--data-raw ${quote(body.text)}`);
  } else if (hasBody) {
    options.push('--data-binary @-');
  }

  const command = [`curl ${byteWord(url)}`, ...options].join(' \\\n  ');

  switch (body.kind) {
    case 'text-stdin':
      return `printf '%s' ${quote(body.text)} | ${command}`;
    case 'base64-stdin':
      return `printf '%s' '${body.base64}' | base64 --decode | ${command}`;
    default:
      return command;
  }
}

/**
 * Which of the three body forms the command uses, if any, for the bytes that
 * arrived as `receivedBody` rebuilds them - the same bytes `Check signature…`
 * signs (D197).
 *
 * A `HEAD` never has a body: the receiver stores none for it (D139), and curl
 * refuses `--head` together with data. A byte-order mark the backend removed
 * (D043) is put back, through Base64: it is invisible, so it does not belong
 * inline.
 */
function planBody(request: CurlSource): BodyPlan {
  const body = receivedBody(request);

  switch (body.kind) {
    case 'empty':
      return { kind: 'none' };
    case 'binary':
      return { kind: 'base64-stdin', base64: body.base64 };
    case 'text':
      if (body.byteOrderMark || holdsUnpasteable(body.text, { lineFeed: true })) {
        return { kind: 'base64-stdin', base64: btoa(binaryString(body.bytes)) };
      }

      return body.bytes.length <= INLINE_BODY_MAX_BYTES
        ? { kind: 'inline', text: body.text }
        : { kind: 'text-stdin', text: body.text };
  }
}

/** POSIX single quotes: everything literal, and `'` written as `'\''`. */
export function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * A header or the URL as a shell word yielding exactly its bytes.
 *
 * Header values arrive one character per byte, the way Node decodes them
 * (D145), so a UTF-8 value such as `Иван` reads as `Ð\u0098Ð²Ð°Ð½`. Written as
 * that text, a paste would send each of those characters as UTF-8 again. So a
 * value that is valid UTF-8 is written as the text it encodes, which a paste
 * turns back into the same bytes, and anything else - a byte that is not
 * UTF-8, or a character a paste would not keep - is produced by `printf` from
 * a format that is letters, digits and a few inert characters, with every
 * other byte an octal escape.
 */
function byteWord(binary: string): string {
  const text = isByteString(binary) ? decodeUtf8(binary) : binary;

  if (text !== null && !holdsUnpasteable(text, { lineFeed: false })) {
    return quote(text);
  }

  return `"$(printf '${printfFormat(binary)}')"`;
}

/**
 * Characters a `printf` format inside `"$(printf '…')"` writes as themselves.
 * Every other byte is an octal escape, which POSIX `printf` prints literally,
 * so the format holds no `'` to end its quotes, no `%` or backslash for
 * `printf` to read, and no `!`, which interactive bash 3.2 history-expands
 * inside double quotes even within single quotes there (D167).
 */
const PRINTF_LITERAL = /^[A-Za-z0-9 ,./:;=_+@-]$/;

/**
 * A `printf` format that prints exactly these bytes. A leading `-` is an
 * escape too, so `printf` never takes the format for an option.
 */
function printfFormat(binary: string): string {
  const bytes = isByteString(binary)
    ? Uint8Array.from(binary, (character) => character.charCodeAt(0))
    : new TextEncoder().encode(binary);
  let format = '';

  for (const [index, byte] of bytes.entries()) {
    const character = String.fromCharCode(byte);

    format +=
      PRINTF_LITERAL.test(character) && !(index === 0 && character === '-')
        ? character
        : `\\${byte.toString(8).padStart(3, '0')}`;
  }

  return format;
}
