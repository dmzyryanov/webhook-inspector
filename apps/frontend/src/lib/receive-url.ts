/**
 * Where a session receives webhooks (D187).
 *
 * Since 0.36.0 webhooks are received on a host of their own,
 * `https://hook.qa-tools.ru`, and the API gives each session's URL as
 * `receiveUrl`; the page shows and copies that, never an address of its own
 * origin. An answer from a backend older than 0.36.0 has no `receiveUrl`, and
 * that backend still receives on the page's origin, so for the moments of a
 * rollout in which a new page meets an old backend the page's own address is
 * the right one.
 */
export function sessionReceiveUrl(
  session: { id: string; receiveUrl?: string },
  pageOrigin: string,
): string {
  return session.receiveUrl ?? `${pageOrigin}/s/${session.id}`;
}

/**
 * The origin of a receive URL, which `Copy as cURL` sends its command to: the
 * stored path follows it, so the command re-captures into the same session on
 * the same path (D167, D187).
 */
export function receiveOrigin(receiveUrl: string): string {
  return new URL(receiveUrl).origin;
}
