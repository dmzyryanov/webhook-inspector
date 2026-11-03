/**
 * `Download JSON` (issue #73, D185): the file name and the file text. That the
 * menu item really saves this file, and that it equals the detail API's
 * answer, is E2E-01's step.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REQUEST_ID_DISPLAY_LENGTH, type RequestDetails } from '@webhook-inspector/shared';
import { requestDownloadFileName, requestDownloadText } from './request-download.ts';

const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
const REQUEST = '2b906b8e-9d4a-4e7b-a1c6-5e8f0d2b7a94';
const BODY = '{"event":"order.paid","amount":4200}';

/** A captured text request with a sent response, as the detail endpoint returns it. */
function textRequest(): RequestDetails {
  return {
    id: REQUEST,
    method: 'POST',
    receivedAt: '2026-09-26T08:41:55.123Z',
    bodySize: BODY.length,
    sourceIp: '54.187.174.169',
    path: `/s/${SESSION}/hooks`,
    queryString: 'attempt=1',
    headers: [
      ['Host', 'qa-tools.ru'],
      ['Content-Type', 'application/json'],
      ['X-Dup', 'a'],
      ['X-Dup', 'b'],
    ],
    body: BODY,
    bodyBase64: null,
    isBinary: false,
    raw: `POST /s/${SESSION}/hooks?attempt=1 HTTP/1.1\r\nHost: qa-tools.ru\r\n\r\n${BODY}`,
    rawBase64: null,
    isRawBinary: false,
    httpVersion: '1.1',
    response: {
      state: 'sent',
      status: 200,
      queueStep: null,
      rule: null,
      headers: [['Content-Type', 'application/json']],
      body: '{"ok":true}',
      bodyBase64: null,
      isBinary: false,
      bodySize: 11,
      bodySuppressed: false,
      raw: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}',
      rawBase64: null,
      isRawBinary: false,
      delayMs: 0,
      startedAt: '2026-09-26T08:41:55.130Z',
      completedAt: '2026-09-26T08:41:55.134Z',
      durationMs: 4,
    },
  };
}

/** Bytes that are not UTF-8, so the API carries them as Base64 (D043). */
const BINARY_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a];

function binaryRequest(): RequestDetails {
  const base64 = Buffer.from(BINARY_BYTES).toString('base64');

  return {
    ...textRequest(),
    bodySize: BINARY_BYTES.length,
    body: null,
    bodyBase64: base64,
    isBinary: true,
    raw: null,
    rawBase64: Buffer.concat([
      Buffer.from('POST / HTTP/1.1\r\n\r\n'),
      Buffer.from(BINARY_BYTES),
    ]).toString('base64'),
    isRawBinary: true,
    response: null,
  };
}

describe('requestDownloadFileName', () => {
  it('names the file after the service and the short id the list row shows', () => {
    assert.equal(requestDownloadFileName(REQUEST), 'webhook-inspector-request-2b906b8.json');
  });

  it('takes the same characters of any id as the list row does', () => {
    const other = 'f0e1d2c3-b4a5-4968-8776-655443322110';

    assert.equal(requestDownloadFileName(other), 'webhook-inspector-request-f0e1d2c.json');
    assert.equal(
      requestDownloadFileName(other),
      `webhook-inspector-request-${other.slice(0, REQUEST_ID_DISPLAY_LENGTH)}.json`,
    );
  });
});

describe('requestDownloadText', () => {
  it('is the object indented by two spaces', () => {
    const text = requestDownloadText(textRequest());

    assert.equal(text, JSON.stringify(textRequest(), null, 2));
    assert.ok(text.startsWith(`{\n  "id": "${REQUEST}",\n  "method": "POST",`));
    assert.match(text, /\n {2}"response": \{\n {4}"state": "sent",/);
    assert.ok(!text.endsWith('\n'));
  });

  it('reads back as the object it was made from, response included', () => {
    const details = textRequest();

    assert.deepEqual(JSON.parse(requestDownloadText(details)), details);
  });

  it('keeps a binary body lossless: its Base64 decodes to the original bytes', () => {
    const details = binaryRequest();
    const parsed = JSON.parse(requestDownloadText(details)) as RequestDetails;

    assert.deepEqual(parsed, details);
    assert.equal(parsed.body, null);
    assert.equal(parsed.isBinary, true);
    assert.deepEqual([...Buffer.from(parsed.bodyBase64 ?? '', 'base64')], BINARY_BYTES);
  });

  it('writes a missing response as null, not as an absent key', () => {
    assert.match(requestDownloadText(binaryRequest()), /\n {2}"response": null\n\}$/);
  });
});
