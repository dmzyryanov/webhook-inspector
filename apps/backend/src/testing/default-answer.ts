/**
 * The default answer a stored request was given (D100, D223), as a test
 * expects it: built from what the API's detail says of the request, so a
 * reply compared with it, byte for byte, has its nine keys in their order and
 * each value equal to the stored request's.
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  buildInspectorUrl,
  type RequestDetails,
  type WebhookDefaultAnswer,
} from '@webhook-inspector/shared';
import { DEFAULT_APP_ORIGIN } from '../config.ts';
import { DEFAULT_REPLY_MESSAGE } from '../modules/webhook/response.ts';

/** The default answer's keys, in the order they are sent (D223). */
export const DEFAULT_ANSWER_KEYS = [
  'ok',
  'requestId',
  'message',
  'inspectorUrl',
  'receivedAt',
  'method',
  'path',
  'bodySize',
  'sourceIp',
] as const;

/** The default answer of a request the detail describes, on a receiver with `appOrigin`. */
export function defaultAnswerFor(
  sessionId: string,
  details: RequestDetails,
  appOrigin = DEFAULT_APP_ORIGIN,
): WebhookDefaultAnswer {
  assert.ok(details.path !== null, 'a request stored before paths were stored has no answer here');

  return {
    ok: true,
    requestId: details.id,
    message: DEFAULT_REPLY_MESSAGE,
    inspectorUrl: buildInspectorUrl(appOrigin, sessionId, details.id),
    receivedAt: details.receivedAt,
    method: details.method,
    path: details.path,
    bodySize: details.bodySize,
    sourceIp: details.sourceIp,
  };
}

/**
 * The exact text of the default answer request `requestId` of session
 * `sessionId` was given, read through `api`'s detail route.
 */
export async function defaultAnswerText(
  api: FastifyInstance,
  sessionId: string,
  requestId: string,
  appOrigin = DEFAULT_APP_ORIGIN,
): Promise<string> {
  const detail = await api.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/requests/${requestId}`,
  });

  assert.equal(detail.statusCode, 200, detail.body);

  return JSON.stringify(defaultAnswerFor(sessionId, detail.json<RequestDetails>(), appOrigin));
}
