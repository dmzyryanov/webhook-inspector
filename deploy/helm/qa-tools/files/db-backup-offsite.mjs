// Uploads the nightly backup's encrypted copy to object storage and prunes the
// bucket (D190, issue #89).
//
// Runs beside the backup in its pod (templates/db-backup.yaml), on the backend
// image as uid 1000, because the PostgreSQL image has no HTTPS client and
// stays unchanged. Like the notifier it is a native sidecar, an init container
// with `restartPolicy: Always`. It holds the storage credential and never sees
// the dump: db-backup.sh encrypts the dump it has saved and checked to the
// owner's public key and renames the ciphertext into OFFSITE_DIR, an emptyDir
// the two containers share, as `<database>-<UTC timestamp>.dump.gpg`. The
// backup container then waits for this script's answer before it ends, so the
// upload runs while the pod is alive and is never cut off by the 30 seconds a
// sidecar has once the backup container is gone.
//
// One copy handed over, in this order; a step that fails ends the run:
//
//   1. Versioning guard. `GET /<bucket>?versioning` must not answer `Enabled`:
//      a delete in a versioned bucket leaves the old versions in place, so
//      nothing is uploaded there. `Suspended` is logged and passes, since
//      objects written while it is suspended are deleted for good. Skipped
//      when OFFSITE_CHECK_VERSIONING is `false`, for a credential that may not
//      read the setting; the owner then checks it by hand (runbook).
//   2. Upload. One `PUT /<bucket>/<name>` of the file, signed with AWS
//      Signature Version 4 over its sha256, which the storage checks. The
//      file is hashed and sent through one buffer of 128 KiB, a piece written
//      out before the next is read, so the process stays the same size
//      whatever the copy's.
//   3. Listing. `GET /<bucket>?list-type=2&prefix=<database>-`, every page.
//      The copy just uploaded must be listed with the size sent. What is read
//      of a listing is bounded: a page of at most 2 MiB and 1,000 entries, the
//      most the API returns, at most 5 pages, and 1,000 copies in all; beyond
//      any of these the run fails and deletes nothing. So at most 10 MiB of
//      listing are read for one copy, a page at a time, and of each page only
//      the names of copies are kept, as strings of their own, before the next
//      is read. What is not bounded is when the runtime frees a page that is
//      no longer held, and the time a slow storage takes, which the run's
//      limit below bounds.
//   4. Pruning. All but the OFFSITE_KEEP newest objects named exactly
//      `<database>-<8 digits>T<6 digits>Z.dump.gpg` are deleted, sorted by
//      name as db-backup.sh sorts dumps. Nothing else in the bucket is touched
//      and the new copy is never deleted: an object whose name sorts after it
//      fails the run instead, deleting nothing.
//
// The answer is `<name>.result` beside the ciphertext, written under a
// temporary name and renamed: `ok` and a summary on the next line, or `fail`
// and what failed. db-backup.sh logs the one and fails with the other as
// `Off-server copy failed: …`, which the notifier sends as `backup/fail`. A
// wrong setting or a missing credential is such a failure too, reported when
// the copy is handed over.
//
// Two limits, of different kinds. A request may go OFFSITE_TIMEOUT_SECONDS
// without a byte moving in either direction: one that gets no answer, or
// whose upload stalls, is cut then, whatever its size, while an upload that
// keeps moving is not. And the whole run for one copy has
// OFFSITE_DEADLINE_SECONDS, less than db-backup.sh waits for the answer: an
// upload still moving when they run out is cut with a message of its own,
// `… was cut off by the run's 240 s after N of M bytes: the copy is too large
// for the time allowed at this speed`. So the largest copy is what the uplink
// carries in that time, about 29 MB for each Mbit/s with the defaults. A
// request that gets no answer or stalls, or a 429 or 5xx, is tried again, up
// to OFFSITE_ATTEMPTS times; any other refusal fails at once, and an attempt
// that fails with less of the run's time left than the pause is the last.
// When an attempt before the one cut by the run's limit failed, the time may
// have gone to that failure rather than to the copy's size, so the message is
// never "too large" then: it names the latest earlier problem first and the
// cut after it, `… stalled: no byte moved for 60 s after K of M bytes, and
// the run's 240 s ran out during attempt 3 after N of M bytes`.
//
// A failure after the upload — the listing, the pruning — leaves the new copy
// in the bucket and deletes nothing, so the bucket then holds one copy more
// than before; the next run that succeeds prunes it back to OFFSITE_KEEP. A
// failed upload usually leaves the bucket as it was, but not always: one
// whose whole copy had been sent and that got no answer, or an error, may
// have been kept by the storage, and the bucket then holds that copy, whole,
// with nothing deleted, as after a failure that came after the upload.
//
// After answering it waits to be stopped rather than exit: a sidecar that
// exits while the backup container is still running is started again; started
// again, it leaves a copy that already has its answer alone. It always exits
// 0. The log carries the object's name and size, the names deleted and the
// copies kept. Never the credential, a signed header, a signature or a
// response body: a refusal is described by its status and the storage's error
// code, taken only when it is shaped like one — a capitalised word of letters
// and digits without a long run of hexadecimal, which a signature or a hash
// is — an error by its code or name, and every line is scrubbed of both
// halves of the credential and of the signatures of the latest requests.
//
// Environment:
//   OFFSITE_DIR                the directory db-backup.sh hands the copy over in
//   OFFSITE_ENDPOINT           the storage endpoint, https://storage.yandexcloud.net
//   OFFSITE_REGION             its region, ru-central1
//   OFFSITE_BUCKET             the bucket
//   OFFSITE_DATABASE           the database's name, the start of every copy's name
//   OFFSITE_ACCESS_KEY_ID      the static key's id
//   OFFSITE_SECRET_ACCESS_KEY  the static key's secret
//   OFFSITE_KEEP               how many copies to keep, default 3
//   OFFSITE_CHECK_VERSIONING   `false` skips the versioning guard, default true
//   OFFSITE_POLL_SECONDS       how often to look for a copy, default 1
//   OFFSITE_TIMEOUT_SECONDS    how long a request may go without a byte moving,
//                              default 60
//   OFFSITE_ATTEMPTS           attempts for one request, default 3
//   OFFSITE_RETRY_SECONDS      pause before another attempt, default 5
//   OFFSITE_DEADLINE_SECONDS   limit for the whole run, default 240

import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { chmod, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import process from 'node:process';

export const DEFAULTS = {
  keep: 3,
  pollSeconds: 1,
  timeoutSeconds: 60,
  attempts: 3,
  retrySeconds: 5,
  deadlineSeconds: 240,
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// A copy as db-backup.sh names it: the database, then a UTC timestamp.
const HANDED_OVER = /^([A-Za-z0-9_]{1,63})-\d{8}T\d{6}Z\.dump\.gpg$/;
const DATABASE = /^[A-Za-z0-9_]{1,63}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;
const ACCESS_KEY_ID = /^[A-Za-z0-9_-]{4,128}$/;
// Printable ASCII without a space: nothing that could break a header.
const SECRET_ACCESS_KEY = /^[\x21-\x7e]{8,256}$/;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
// What is read of the storage's answers, in all. A listing page of 1,000
// objects with keys of the longest kind, 1,024 bytes, is about 1.3 MB, so a
// page has 2 MiB; every other answer is a few hundred bytes and has 64 KiB.
// The API returns at most 1,000 entries a page; this job leaves `keep`
// copies, a handful more after failed nights, so 5 pages and 1,000 copies are
// far more than it needs. At most MAX_PAGES x MAX_LIST_PAGE_BYTES, 10 MiB, of
// listing are therefore read for one copy: the first bounds, 20 pages of
// 4 MiB, let a storage that padded its pages fill the chart's 128Mi with
// pages the collector had not yet freed.
export const MAX_LIST_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PAGES = 5;
export const MAX_PAGE_ENTRIES = 1000;
export const MAX_COPIES = 1000;
const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
// The signatures of this many latest requests are scrubbed from every line.
const SIGNATURES_HIDDEN = 4;
const MAX_TOKEN_LENGTH = 4096;
// A failure's message becomes part of the heartbeat's one line; a success's
// summary is only logged, and names up to a few copies.
export const MAX_FAILURE_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 600;

/** A failure whose message is safe to log and to send: it quotes no answer. */
export class Failure extends Error {}

/**
 * What an upload still sending when the run's time ran out is reported as:
 * `what`, `uploading <name>`; `ranOut`, `the run's 240 s`; `sent` of `size`
 * bytes gone in attempt `attempt`. With no attempt of it failed before, the
 * copy was moving all along and is too large for the time allowed at this
 * speed. After one, the time may have gone to that failure — a storage that
 * stalled, said nothing or refused — so `earlier`, the latest earlier
 * attempt's problem, comes first and the cut after it: the cut to
 * MAX_FAILURE_LENGTH drops the end, never the cause, and one problem is named
 * however many attempts there were.
 */
export function cutOffMessage({ what, earlier, ranOut, attempt, sent, size }) {
  const part = `after ${sent} of ${size} bytes`;
  return earlier === null
    ? `${what} was cut off by ${ranOut} ${part}: the copy is too large for the time allowed at this speed`
    : `${what} ${earlier}, and ${ranOut} ran out during attempt ${attempt} ${part}`;
}

const stamp = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ASCII letters lowercased and nothing else, so every position stays where it was.
const lowerAscii = (text) => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * Replaces every occurrence of each secret, in any ASCII letter case, by its
 * stand-in. A literal scan rather than a regular expression, so a value of any
 * length is scrubbed and scrubbing never throws.
 */
export const scrubber = (secrets) => (line) => {
  let text = String(line);
  for (const [secret, stand] of secrets) {
    if (!secret) continue;
    const needle = lowerAscii(secret);
    const hay = lowerAscii(text);
    let scrubbed = '';
    let from = 0;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, from)) {
      scrubbed += text.slice(from, at) + stand;
      from = at + needle.length;
    }
    text = scrubbed + text.slice(from);
  }
  return text;
};

/**
 * Percent-encodes everything but RFC 3986's unreserved characters, byte by
 * byte in UTF-8, as Signature Version 4 requires. It never throws: a lone
 * surrogate becomes U+FFFD, where `encodeURIComponent` would raise.
 */
export function uriEncode(text) {
  const parts = [];
  for (const byte of Buffer.from(String(text), 'utf8')) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    parts.push(
      unreserved
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    );
  }
  return parts.join('');
}

const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest();

/**
 * Signs one request with AWS Signature Version 4. `path` is the request's
 * path, already percent-encoded once, as S3 canonicalises it; `query` is the
 * decoded parameters; `headers` are the request's own headers to sign besides
 * `host`, `x-amz-content-sha256` and `x-amz-date`, which are added. Returns the
 * headers to send, `authorization` among them, the canonical query string,
 * the query string to send, and the signature alone. The two query strings
 * differ only for a parameter without a value, signed as `versioning=` and
 * sent as `versioning`, the way the AWS SDKs and CLI send it.
 */
export function signRequest({
  method,
  host,
  path,
  query = {},
  headers = {},
  payloadHash,
  accessKeyId,
  secretAccessKey,
  region,
  service = 's3',
  date = new Date(),
}) {
  const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const signed = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  for (const [name, value] of Object.entries(headers)) {
    signed[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  }
  const names = Object.keys(signed).sort();
  const canonicalQuery = Object.entries(query)
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    names.map((name) => `${name}:${signed[name]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return {
    headers: {
      ...signed,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
    canonicalQuery,
    sentQuery: canonicalQuery
      .split('&')
      .map((pair) => (pair.endsWith('=') ? pair.slice(0, -1) : pair))
      .join('&'),
    signature,
  };
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** An XML element's text with its character references resolved. */
export function xmlText(raw) {
  return String(raw).replace(
    /&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g,
    (whole, name) => {
      if (name in NAMED_ENTITIES) return NAMED_ENTITIES[name];
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    },
  );
}

// The raw text of the first <name>…</name> in `xml`, or null. A plain scan:
// the storage's answers are flat, and a scan cannot backtrack.
function element(xml, name) {
  const open = xml.indexOf(`<${name}>`);
  if (open === -1) return null;
  const from = open + name.length + 2;
  const close = xml.indexOf(`</${name}>`, from);
  return close === -1 ? null : xml.slice(from, close);
}

/**
 * One page of a ListObjectsV2 answer: `{ objects: [{ key, size }], next }`,
 * `next` being the continuation token of a truncated page, or null. Throws a
 * Failure for anything that is not such a listing, a page cut off inside an
 * entry included: pruning never works from half a list.
 */
export function parseListing(xml) {
  const text = String(xml);
  if (!text.includes('<ListBucketResult')) throw new Failure('the listing was not understood');
  const objects = [];
  // What lies outside the entries, where the page's own elements are.
  const outside = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf('<Contents>', at);
    if (open === -1) break;
    const close = text.indexOf('</Contents>', open);
    if (close === -1) throw new Failure('the listing was cut off inside an entry');
    const entry = text.slice(open + '<Contents>'.length, close);
    const key = element(entry, 'Key');
    if (key === null) throw new Failure('the listing holds an entry without a key');
    if (objects.length >= MAX_PAGE_ENTRIES) {
      throw new Failure(`the listing holds more than ${MAX_PAGE_ENTRIES} entries on one page`);
    }
    const size = element(entry, 'Size');
    objects.push({
      key: xmlText(key),
      size: size !== null && /^\d{1,15}$/.test(size) ? Number(size) : null,
    });
    outside.push(text.slice(at, open));
    at = close + '</Contents>'.length;
  }
  outside.push(text.slice(at));
  const page = outside.join('');
  if (!page.includes('</ListBucketResult>')) throw new Failure('the listing was cut off');
  const truncated = element(page, 'IsTruncated');
  if (truncated !== 'true') return { objects, next: null };
  const token = element(page, 'NextContinuationToken');
  if (token === null || token === '' || token.length > MAX_TOKEN_LENGTH) {
    throw new Failure('the listing is truncated without a usable continuation token');
  }
  return { objects, next: xmlText(token) };
}

// A versioning answer's root tag at the very start of the answer, after an
// XML declaration at most: its name, then attributes whose values are quoted
// and closed, then `>` or `/>`.
const VERSIONING_ROOT =
  /^\uFEFF?\s*(?:<\?xml(?:\s[^?<>]*)?\?>\s*)?<VersioningConfiguration((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/;
// One child of that root: `<Name>text</Name>` or `<Name/>`, no attributes and
// nothing nested.
const VERSIONING_CHILD = /\s*<([A-Za-z][A-Za-z0-9]*)(?:\s*\/>|>([^<]*)<\/\1\s*>)/y;
const VERSIONING_END = /\s*<\/VersioningConfiguration\s*>/y;

/**
 * The bucket's versioning from a GetBucketVersioning answer: `Off`, `Enabled`
 * or `Suspended`. The answer must be exactly one well-formed root element of
 * plain children and nothing after it; `Off` is read only from such an answer
 * with no status in it. Anything else is a Failure, never `Off` — an answer
 * that is not closed, a root tag with an unclosed attribute, a second document
 * after the first, a comment, a status that is empty, unknown or given twice
 * — since this is the guard that keeps copies out of a versioned bucket.
 */
export function parseVersioning(xml) {
  const text = String(xml);
  const unclear = () => new Failure("the bucket's versioning answer was not understood");
  const root = VERSIONING_ROOT.exec(text);
  if (!root) throw unclear();
  let at = root[0].length;
  let status = null;
  if (root[2] !== '/') {
    for (;;) {
      VERSIONING_CHILD.lastIndex = at;
      const child = VERSIONING_CHILD.exec(text);
      if (!child) break;
      at = VERSIONING_CHILD.lastIndex;
      if (!/^status$/i.test(child[1])) continue;
      if (child[1] !== 'Status' || status !== null) throw unclear();
      if (child[2] !== 'Enabled' && child[2] !== 'Suspended') throw unclear();
      status = child[2];
    }
    VERSIONING_END.lastIndex = at;
    if (!VERSIONING_END.test(text)) throw unclear();
    at = VERSIONING_END.lastIndex;
  }
  if (text.slice(at).trim() !== '') throw unclear();
  return status ?? 'Off';
}

/**
 * The storage's error code from an error answer, when it is shaped like one:
 * `AccessDenied`, `XAmzContentSHA256Mismatch` — a capitalised word of letters
 * and digits. Anything else is dropped, a run of sixteen hexadecimal digits
 * included: an answer that echoes the request's signature or a hash where the
 * code belongs must not carry it into the log, the status and the heartbeat.
 */
export function errorCode(xml) {
  const code = element(String(xml).slice(0, MAX_ERROR_BYTES), 'Code');
  return code !== null && /^[A-Z][A-Za-z0-9]{1,63}$/.test(code) && !/[0-9A-Fa-f]{16}/.test(code)
    ? code
    : '';
}

/**
 * Which copies to delete: all but the `keep` newest of `names`, the copy just
 * uploaded among them, sorted by name. Throws a Failure, deleting nothing,
 * when a name sorts after the new copy, which would push it out of the newest.
 */
export function planPruning({ names, uploaded, keep }) {
  const copies = [...new Set([...names, uploaded])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const later = copies.find((name) => name > uploaded);
  if (later !== undefined) {
    throw new Failure(
      `${later} in the bucket sorts after the new copy ${uploaded}: the clock may have gone back, or the object was copied in. Nothing was deleted.`,
    );
  }
  const excess = Math.max(0, copies.length - keep);
  return { remove: copies.slice(0, excess), kept: copies.slice(excess) };
}

function endpointOrigin(value) {
  let url;
  try {
    url = new URL(value ?? '');
  } catch {
    return null;
  }
  const scheme =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  const bare = !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  return scheme && bare ? url : null;
}

function describeError(error, timeoutMs) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `no answer within ${timeoutMs / 1000} s`;
  }
  // A system error's code, `ECONNREFUSED`; never a long run of hexadecimal.
  for (const code of [error?.cause?.code, error?.code]) {
    if (
      typeof code === 'string' &&
      /^[A-Z][A-Z0-9_]{1,59}$/.test(code) &&
      !/[0-9A-F]{16}/.test(code)
    ) {
      return code;
    }
  }
  // fetch's own reasons are a few lowercase words: `bad port`. Anything longer,
  // or with a host or a path in it, is not used.
  const reason = error?.cause?.message;
  if (typeof reason === 'string' && /^[a-z][a-z ]{0,39}$/.test(reason)) return reason;
  return typeof error?.name === 'string' && /^\w{1,40}$/.test(error.name)
    ? error.name
    : 'an unknown error';
}

// An error's name for the log, never its message, which could quote a value.
function errorName(error) {
  try {
    const name = error?.name;
    return typeof name === 'string' && /^\w{1,40}$/.test(name) ? name : 'an unknown error';
  } catch {
    return 'an unknown error';
  }
}

const number = (value, fallback, min, max) => {
  const parsed = Number(value);
  return value !== undefined &&
    value !== '' &&
    Number.isFinite(parsed) &&
    parsed >= min &&
    parsed <= max
    ? parsed
    : fallback;
};

// How much of a file is in memory at a time, when it is hashed and when it is
// sent.
const FILE_CHUNK_BYTES = 128 * 1024;

/**
 * Reads a file from start to end through one buffer, handing each piece to
 * `take` and waiting for it before reading the next into the same buffer. The
 * file is never in memory beyond that buffer, whatever its size, and no piece
 * is left behind for the garbage collector to find: a stream's fresh buffer
 * for every read made the process grow with the file until one was run.
 */
async function eachChunk(path, take) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      await take(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

/**
 * One HTTP exchange with the storage: resolves `{ status, text, over }`, where
 * `text` is the answer's body up to `maxBytes` and `over` says that it went
 * on beyond them. Rejects when the request fails, is aborted by `signal`, the
 * answer ends early, or no byte has moved in either direction for `idleMs`:
 * then with an error whose `code` is `ESTALLED`. The limit is on silence, not
 * on the whole exchange, so a large body that keeps moving is not cut by it.
 * `progress.sent` and `progress.received` count the body bytes written out and
 * the answer's bytes read, for whoever describes a failure. With `file`,
 * `{ path }`, the file is the body, sent a piece at a time, each written out
 * before the next is read, so the body is never in memory whole; the caller
 * sets `content-length`. A redirect is an answer like any other and is not
 * followed. One connection a request, closed with it, so nothing idle keeps
 * the process from ending.
 */
export function exchange({
  url,
  method,
  headers,
  file = null,
  signal,
  idleMs,
  maxBytes,
  progress = { sent: 0, received: 0 },
}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let settled = false;
    let idle = null;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      finish(value);
    };
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      method,
      headers,
      signal,
      agent: false,
    });
    // Started with the request and again with every byte that moves.
    const moved = () => {
      clearTimeout(idle);
      if (settled || !(idleMs > 0)) return;
      idle = setTimeout(() => {
        request.destroy(Object.assign(new Error('no byte moved'), { code: 'ESTALLED' }));
      }, idleMs);
    };
    moved();
    request.on('error', (error) => settle(reject, error));
    request.on('response', (response) => {
      moved();
      const chunks = [];
      let size = 0;
      const text = () => Buffer.concat(chunks).toString('utf8');
      response.on('data', (chunk) => {
        moved();
        progress.received += chunk.length;
        const room = maxBytes - size;
        size += chunk.length;
        if (chunk.length <= room) {
          chunks.push(chunk);
          return;
        }
        if (room > 0) chunks.push(chunk.subarray(0, room));
        settle(resolve, { status: response.statusCode, text: text(), over: true });
        request.destroy();
      });
      response.on('end', () => {
        settle(resolve, { status: response.statusCode, text: text(), over: false });
        // An answer that came before the body was sent whole ends the sending.
        if (!request.writableFinished) request.destroy();
      });
      response.on('error', (error) => settle(reject, error));
      response.on('close', () =>
        settle(reject, Object.assign(new Error('the answer ended early'), { code: 'ECONNRESET' })),
      );
    });
    if (!file) {
      request.end();
      return;
    }
    // The write's callback comes once the piece has left for the socket; only
    // then is the buffer it sits in read into again, and only then has it
    // moved: a peer that stops taking the body stops the callbacks.
    const send = (piece) =>
      new Promise((sent, failed) => {
        const bytes = piece.length;
        request.write(piece, (error) => {
          if (error) return failed(error);
          progress.sent += bytes;
          moved();
          return sent();
        });
      });
    eachChunk(file.path, send).then(
      () => request.end(),
      (error) => {
        settle(reject, error);
        request.destroy();
      },
    );
  });
}

const sha256OfFile = async (path) => {
  const hash = createHash('sha256');
  await eachChunk(path, (piece) => hash.update(piece));
  return hash.digest('hex');
};

/**
 * The settings from the environment, with every problem found in them. The
 * first problem is what a hand-over is answered with.
 */
export function readSettings(env) {
  const text = (name) => String(env[name] ?? '').trim();
  const problems = [];
  const dir = text('OFFSITE_DIR');
  const origin = endpointOrigin(text('OFFSITE_ENDPOINT'));
  const region = text('OFFSITE_REGION');
  const bucket = text('OFFSITE_BUCKET');
  const database = text('OFFSITE_DATABASE');
  const accessKeyId = text('OFFSITE_ACCESS_KEY_ID');
  const secretAccessKey = text('OFFSITE_SECRET_ACCESS_KEY');
  const keepText = text('OFFSITE_KEEP');
  const versioningText = text('OFFSITE_CHECK_VERSIONING');

  if (!bucket) problems.push('OFFSITE_BUCKET is not set');
  else if (!BUCKET.test(bucket) || bucket.includes('..')) {
    problems.push('OFFSITE_BUCKET is not a bucket name');
  }
  if (!origin) problems.push('OFFSITE_ENDPOINT is not an https URL without a path');
  if (!REGION.test(region)) problems.push('OFFSITE_REGION is not a region name');
  if (!DATABASE.test(database)) problems.push('OFFSITE_DATABASE is not a database name');
  if (keepText !== '' && !/^[1-9][0-9]{0,3}$/.test(keepText)) {
    problems.push('OFFSITE_KEEP must be a whole number from 1');
  }
  if (!['', 'true', 'false'].includes(versioningText)) {
    problems.push('OFFSITE_CHECK_VERSIONING must be true or false');
  }
  if (!accessKeyId) problems.push('OFFSITE_ACCESS_KEY_ID is not set (Secret or key missing)');
  else if (!ACCESS_KEY_ID.test(accessKeyId)) {
    problems.push('OFFSITE_ACCESS_KEY_ID does not look like a key id');
  }
  if (!secretAccessKey) {
    problems.push('OFFSITE_SECRET_ACCESS_KEY is not set (Secret or key missing)');
  } else if (!SECRET_ACCESS_KEY.test(secretAccessKey)) {
    problems.push('OFFSITE_SECRET_ACCESS_KEY does not look like a secret key');
  }

  return {
    problems,
    dir,
    origin,
    region,
    bucket,
    database,
    accessKeyId,
    secretAccessKey,
    keep: keepText === '' ? DEFAULTS.keep : Number(keepText),
    checkVersioning: versioningText !== 'false',
    pollMs: number(env.OFFSITE_POLL_SECONDS, DEFAULTS.pollSeconds, 0.01, 60) * 1000,
    timeoutMs: number(env.OFFSITE_TIMEOUT_SECONDS, DEFAULTS.timeoutSeconds, 0.1, 600) * 1000,
    attempts: number(env.OFFSITE_ATTEMPTS, DEFAULTS.attempts, 1, 10),
    retryMs: number(env.OFFSITE_RETRY_SECONDS, DEFAULTS.retrySeconds, 0, 60) * 1000,
    deadlineMs: number(env.OFFSITE_DEADLINE_SECONDS, DEFAULTS.deadlineSeconds, 0.1, 1500) * 1000,
  };
}

/**
 * One run, to the stop signal. Returns the exit status, which is always 0;
 * the process, its pause and the exchange with the storage can be replaced
 * for the tests. Whatever
 * fails after the stop signal is set up is logged by its name alone, and the
 * script still waits to be stopped rather than exit and be restarted.
 */
export async function main({
  env = process.env,
  transport = exchange,
  signals = process,
  out = process.stdout,
  pause = sleep,
} = {}) {
  // `plain` is for lines of fixed text and an error's name; every other line
  // goes through the scrub.
  const plain = (line) => out.write(`${stamp()} ${line}\n`);
  let scrub = (line) => line;
  const log = (line) => plain(scrub(line));

  // The stop signal ends whatever wait or request is running.
  let stoppedBy = null;
  const halt = new globalThis.AbortController();
  const stop = (name) => {
    if (stoppedBy === null) {
      stoppedBy = name;
      plain(`Stopped by ${name}`);
    }
    halt.abort();
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  signals.on('SIGTERM', onTerm);
  signals.on('SIGINT', onInt);
  const nap = async (ms) => {
    if (stoppedBy !== null) return;
    await pause(ms, undefined, { signal: halt.signal }).catch(() => {});
  };

  try {
    const settings = readSettings(env);
    // Read anew for every line: the latest requests' signatures join the two
    // halves of the credential as they are made.
    const hidden = [
      [settings.secretAccessKey, '<secret access key>'],
      [settings.accessKeyId, '<access key id>'],
    ];
    scrub = scrubber(hidden);
    const hide = (signature) => {
      hidden.push([signature, '<signature>']);
      if (hidden.length > 2 + SIGNATURES_HIDDEN) hidden.splice(2, 1);
    };
    const { dir, origin, region, bucket, database, keep } = settings;
    for (const problem of settings.problems) log(`${problem}: no copy can be uploaded`);
    if (!dir.startsWith('/'))
      log('OFFSITE_DIR is not an absolute path: no copy can be handed over');
    log(
      `Off-server copy to bucket ${bucket || '(not set)'} at ${origin ? origin.origin : '(not set)'}, region ${region || '(not set)'}: keep ${keep} copies; waiting for a copy in ${dir || '(not set)'}`,
    );

    // One request to the storage, tried again while that can help. Returns the
    // answer's body; throws a Failure that says what was refused. Two limits:
    // a request is cut when no byte has moved for the request's time, and when
    // the run's time is up. Only the second depends on how much there is to
    // send, and it says so when no attempt before it failed.
    let deadlineAt = 0;
    const ranOut = `the run's ${settings.deadlineMs / 1000} s`;
    const silence = settings.timeoutMs / 1000;
    const call = async (
      what,
      { method, path, query = {}, file = null, maxBytes = MAX_ANSWER_BYTES },
    ) => {
      // The problem of the latest attempt of this request that failed and was
      // tried again; null while none has.
      let earlier = null;
      for (let attempt = 1; ; attempt += 1) {
        const left = deadlineAt - Date.now();
        if (left <= 0) {
          throw new Failure(`${what} did not start within ${ranOut} from the hand-over`);
        }
        const deadline = globalThis.AbortSignal.timeout(left);
        const progress = { sent: 0, received: 0 };
        let problem;
        let again = true;
        try {
          const signed = signRequest({
            method,
            host: origin.host,
            path,
            query,
            headers: file ? { 'content-type': 'application/octet-stream' } : {},
            payloadHash: file ? file.sha256 : EMPTY_SHA256,
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
            region,
          });
          hide(signed.signature);
          const headers = { ...signed.headers, 'user-agent': 'qa-tools-backup' };
          if (file) headers['content-length'] = String(file.size);
          const answer = await transport({
            url: `${origin.origin}${path}${signed.sentQuery ? `?${signed.sentQuery}` : ''}`,
            method,
            headers,
            file,
            signal: globalThis.AbortSignal.any([deadline, halt.signal]),
            idleMs: settings.timeoutMs,
            maxBytes,
            progress,
          });
          if (answer.status >= 200 && answer.status < 300) {
            if (answer.over) throw new Failure(`answered with more than ${maxBytes} bytes`);
            return answer.text;
          }
          const code = errorCode(answer.text);
          problem = `answered ${answer.status}${code ? ` ${code}` : ''}`;
          again = answer.status === 429 || answer.status >= 500;
        } catch (error) {
          if (stoppedBy !== null) throw new Failure(`${what} was stopped by ${stoppedBy}`);
          if (error instanceof Failure) throw new Failure(`${what} ${error.message}`);
          // An upload under way: some of the copy has left, not yet all of it.
          const under = file && progress.sent > 0 && progress.sent < file.size;
          const part = under ? ` after ${progress.sent} of ${file.size} bytes` : '';
          if (deadline.aborted && under) {
            // Still sending when the run's time ran out: a copy too large for
            // the time allowed, unless an attempt before this one failed,
            // whose problem then comes first (cutOffMessage).
            throw new Failure(
              cutOffMessage({
                what,
                earlier,
                ranOut,
                attempt,
                sent: progress.sent,
                size: file.size,
              }),
            );
          }
          if (deadline.aborted) problem = `failed: no answer within ${left / 1000} s`;
          else if (error?.code === 'ESTALLED' && under) {
            problem = `stalled: no byte moved for ${silence} s${part}`;
          } else if (error?.code === 'ESTALLED') problem = `failed: no answer within ${silence} s`;
          else problem = `failed: ${describeError(error, settings.timeoutMs)}`;
        }
        if (!again || attempt >= settings.attempts) throw new Failure(`${what} ${problem}`);
        // The limit is looked at before the pause, not after it: an attempt
        // that could not start is not waited for.
        if (deadlineAt - Date.now() <= settings.retryMs) {
          throw new Failure(`${what} ${problem}, and ${ranOut} leave no time for another attempt`);
        }
        log(`${what}: attempt ${attempt} of ${settings.attempts} ${problem}`);
        earlier = problem;
        await nap(settings.retryMs);
        if (stoppedBy !== null) throw new Failure(`${what} was stopped by ${stoppedBy}`);
      }
    };

    // The four steps for one copy; returns the summary of a success.
    const copy = async (name) => {
      if (settings.problems.length > 0) throw new Failure(settings.problems[0]);
      const prefix = HANDED_OVER.exec(name)[1];
      if (prefix !== database) {
        throw new Failure(`${name} is not a copy of ${database}, the database this job backs up`);
      }
      const path = join(dir, name);
      const info = await stat(path);
      if (!info.isFile() || info.size === 0) throw new Failure(`${name} is empty or not a file`);
      const file = { path, size: info.size, sha256: await sha256OfFile(path) };
      log(`Found ${name}, ${info.size} bytes`);
      deadlineAt = Date.now() + settings.deadlineMs;
      const bucketPath = `/${uriEncode(bucket)}`;

      if (settings.checkVersioning) {
        const versioning = parseVersioning(
          await call("reading the bucket's versioning", {
            method: 'GET',
            path: bucketPath,
            query: { versioning: '' },
          }),
        );
        if (versioning === 'Enabled') {
          throw new Failure(
            "the bucket's versioning is Enabled, so a delete would leave the old versions in place. Nothing was uploaded.",
          );
        }
        log(
          versioning === 'Suspended'
            ? "The bucket's versioning is Suspended: versions made while it was on are not this job's to delete"
            : "The bucket's versioning is off",
        );
      } else {
        log("The bucket's versioning is not read (OFFSITE_CHECK_VERSIONING is false)");
      }

      await call(`uploading ${name}`, {
        method: 'PUT',
        path: `${bucketPath}/${uriEncode(name)}`,
        file,
      });
      log(`Uploaded ${name}, ${info.size} bytes`);

      const copyName = new RegExp(`^${database}-\\d{8}T\\d{6}Z\\.dump\\.gpg$`);
      const listed = new Map();
      let token = null;
      for (let page = 1; ; page += 1) {
        if (page > MAX_PAGES) {
          throw new Failure(
            `the bucket's listing did not end within ${MAX_PAGES} pages. Nothing was deleted.`,
          );
        }
        const query = { 'list-type': '2', prefix: `${database}-` };
        if (token !== null) query['continuation-token'] = token;
        // Of a page only the copies' names and sizes and the next page's token
        // go on, each as a string of its own. As parsed they are slices of the
        // page's text, and a slice keeps the whole text it was cut from alive:
        // one copy's name on each page held every page in memory.
        const own = (text) => Buffer.from(text, 'utf8').toString('utf8');
        const reduce = (text) => {
          const page = parseListing(text);
          return {
            copies: page.objects
              .filter(({ key }) => copyName.test(key))
              .map(({ key, size }) => [own(key), size]),
            next: page.next === null ? null : own(page.next),
          };
        };
        let answer;
        try {
          answer = reduce(
            await call('listing the bucket', {
              method: 'GET',
              path: bucketPath,
              query,
              maxBytes: MAX_LIST_PAGE_BYTES,
            }),
          );
        } catch (error) {
          if (error instanceof Failure) {
            throw new Failure(`${error.message}; ${name} was uploaded and nothing was deleted`);
          }
          throw error;
        }
        for (const [key, size] of answer.copies) listed.set(key, size);
        if (listed.size > MAX_COPIES) {
          throw new Failure(
            `the bucket lists more than ${MAX_COPIES} copies of ${database}, far more than this job leaves. ${name} was uploaded and nothing was deleted.`,
          );
        }
        if (answer.next === null) break;
        token = answer.next;
      }
      if (!listed.has(name)) {
        throw new Failure(
          `the bucket's listing does not show ${name}, which was uploaded. Nothing was deleted.`,
        );
      }
      if (listed.get(name) !== info.size) {
        throw new Failure(
          `the bucket lists ${name} with ${listed.get(name) ?? 'an unknown number of'} bytes, not the ${info.size} uploaded. Nothing was deleted.`,
        );
      }

      const { remove, kept } = planPruning({ names: [...listed.keys()], uploaded: name, keep });
      for (const old of remove) {
        if (old === name) throw new Failure(`refusing to delete the new copy ${name}`);
        await call(`deleting ${old}`, {
          method: 'DELETE',
          path: `${bucketPath}/${uriEncode(old)}`,
        });
        log(`Deleted ${old}`);
      }
      log(`Copies kept: ${kept.join(' ')}`);
      return `uploaded ${name}, ${info.size} bytes; deleted ${remove.length > 0 ? remove.join(' ') : 'nothing'}; kept ${kept.join(' ')}`;
    };

    // The answer for db-backup.sh, renamed into place so it is never read half
    // written, and readable by the backup container's uid.
    const answer = async (name, ok, message) => {
      const line = scrub(message)
        .replace(/[^\x20-\x7e]+/g, ' ')
        .slice(0, ok ? MAX_SUMMARY_LENGTH : MAX_FAILURE_LENGTH);
      const target = join(dir, `${name}.result`);
      const tmp = join(dir, `.${name}.result.tmp`);
      try {
        await writeFile(tmp, `${ok ? 'ok' : 'fail'}\n${line}\n`, { mode: 0o644 });
        await chmod(tmp, 0o644);
        await rename(tmp, target);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        log(`The result for ${name} could not be written: ${describeError(error, 0)}`);
      }
    };

    // A copy is answered once: one that has its answer beside it, from this
    // run or from before a restart, is left alone, and so is one whose answer
    // could not be written. A read error is logged once, not at every look.
    const answered = new Set();
    let readError = null;
    while (stoppedBy === null && dir.startsWith('/')) {
      let names = new Set();
      try {
        names = new Set(await readdir(dir));
      } catch (error) {
        const reason = describeError(error, 0);
        if (reason !== readError) log(`The hand-over directory could not be read: ${reason}`);
        readError = reason;
      }
      const name = [...names]
        .filter(
          (entry) =>
            HANDED_OVER.test(entry) && !names.has(`${entry}.result`) && !answered.has(entry),
        )
        .sort()[0];
      if (name === undefined) {
        await nap(settings.pollMs);
        continue;
      }
      answered.add(name);
      try {
        const summary = await copy(name);
        log('Off-server copy succeeded');
        await answer(name, true, summary);
      } catch (error) {
        const message =
          error instanceof Failure
            ? error.message
            : `the uploader failed: ${describeError(error, 0)}`;
        log(`Off-server copy failed: ${message}`);
        await answer(name, false, message);
      }
    }
  } catch (error) {
    plain(`The uploader stopped on an error: ${errorName(error)}`);
  }

  try {
    // Until the kubelet stops the sidecar: one that exits is started again.
    while (stoppedBy === null) await nap(60_000);
  } finally {
    signals.off('SIGTERM', onTerm);
    signals.off('SIGINT', onInt);
  }
  return 0;
}

// Until a stop signal, for the one failure `main` cannot catch itself.
const untilStopped = () =>
  new Promise((resolve) => {
    const keep = setInterval(() => {}, 60_000);
    const done = () => {
      clearInterval(keep);
      resolve();
    };
    process.once('SIGTERM', done);
    process.once('SIGINT', done);
  });

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // Not expected: `main` catches what fails inside it. The name alone, and
    // exit 0 on the stop signal, as ever.
    process.stdout.write(`${stamp()} The uploader stopped on an error: ${errorName(error)}\n`);
    process.exitCode = 0;
    await untilStopped();
  }
}
