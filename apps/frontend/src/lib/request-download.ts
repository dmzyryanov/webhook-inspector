/**
 * `Download JSON` (issue #73, D185): one captured request as a `.json` file.
 *
 * The file is the `RequestDetails` the detail panel holds - the answer of
 * `GET /api/sessions/:sessionId/requests/:requestId`, unchanged but for the
 * address read as the page reads it (`withSourceIp`, issue #245: a
 * `sourceIp` that is neither a string nor `null` is `null` here), `response`
 * included - written with two-space indentation. Nothing is masked and
 * nothing is sent to the server: the panel already has every byte, binary
 * bodies included as `bodyBase64` / `rawBase64` (D043).
 *
 * The name and the text are pure; `downloadRequestJson` is the browser side.
 */

import { REQUEST_ID_DISPLAY_LENGTH, type RequestDetails } from '@webhook-inspector/shared';

/** How long the object URL outlives the click (FileSaver.js uses 40 s). */
export const REVOKE_DELAY_MS = 40_000;

/** `qa-tools-request-<the list row's short id>.json`. */
export function requestDownloadFileName(requestId: string): string {
  return `qa-tools-request-${requestId.slice(0, REQUEST_ID_DISPLAY_LENGTH)}.json`;
}

/**
 * The file's text: the detail object as the API returned it, the address read
 * as the page reads it (`withSourceIp`), indented by two spaces.
 */
export function requestDownloadText(details: RequestDetails): string {
  return JSON.stringify(details, null, 2);
}

/**
 * Saves the file through an `<a download>` click on an object URL, revoked
 * afterwards. The browser's own download indicator is the only confirmation:
 * the page cannot observe that the file was saved, so it claims nothing.
 */
export function downloadRequestJson(details: RequestDetails): void {
  const blob = new Blob([requestDownloadText(details)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = requestDownloadFileName(details.id);
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked well after the click, as FileSaver.js does: Safari reads the
  // object URL after the click returns, and an early revocation can fail the
  // download or save an empty file.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
