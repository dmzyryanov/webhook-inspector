/**
 * What the session page's hook tests hold around the hook they render
 * (issue #443): the session they show, a browser's `localStorage` in memory,
 * a request as the list and the detail panel receive it, a response state as
 * `session.updated` carries it, the API's answers, and a `fetch` that holds
 * each call until the test answers it. Every `hooks/use*.test.ts` that needs
 * one imports it from here, so a change to what the API answers is made once
 * and a new hook test copies none of it.
 *
 * Like the rest of `src/testing/`, this module is imported by tests alone,
 * never by the bundle, and its name keeps it out of the runner's discovery
 * (`../exit-guard.ts` lists the patterns). It imports `react` for `act` and
 * nothing of `react-dom`, which a test file loads only once its fake browser
 * (`render-in-node.ts`) is in place.
 */
import type { TestContext } from 'node:test';
import { setImmediate } from 'node:timers';
import { act } from 'react';
import type {
  QueueStep,
  RequestDetails,
  RequestListItem,
  SessionResponseState,
} from '@webhook-inspector/shared';
import type { ReadStateStorage } from '../lib/read-state.ts';

/** The session the hook tests' pages show, a well-formed id (D161). */
export const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

/** A `localStorage` of one browser, in memory, holding `initial` to begin with. */
export function memoryStorage(initial: Record<string, string> = {}): ReadStateStorage {
  const items = new Map(Object.entries(initial));

  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => {
      items.set(name, String(value));
    },
    removeItem: (name) => {
      items.delete(name);
    },
  };
}

/** A request of `SESSION` as the list holds it, its response sent, at `queueStep` of a queue if any. */
export function row(id: string, queueStep: QueueStep | null = null): RequestListItem {
  return {
    id,
    method: 'POST',
    receivedAt: '2026-09-17T14:32:06.000Z',
    bodySize: 19,
    sourceIp: '145.40.74.12',
    path: `/s/${SESSION}/stripe/events`,
    response: { state: 'sent', status: 200, queueStep, rule: null },
  };
}

/** A request's details as the API answers them, its body `body`, with no response recorded. */
export function detail(id: string, body = '{"type":"charge"}'): RequestDetails {
  return {
    ...row(id),
    queryString: '',
    headers: [['Content-Type', 'application/json']],
    body,
    bodyBase64: null,
    isBinary: false,
    raw: null,
    rawBase64: null,
    isRawBinary: false,
    httpVersion: '1.1',
    response: null,
  };
}

/** The session's response changed to answer `status`, as `session.updated` carries it. */
export function answering(status: number): SessionResponseState {
  const response = { status, headers: [], body: null, delayMs: 0, template: false };

  return { response, customResponse: response, queue: null, rules: [] };
}

/** The address `getRequestDetails` asks for request `id` of `SESSION`. */
export function detailUrl(id: string): string {
  return `/api/sessions/${SESSION}/requests/${id}`;
}

/** An answer of the API, as much of one as `api/client.ts` reads. */
export function answer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

/** Lets an answer, a chain of promises, reach the page. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/** One call `fetch` was asked for, held until the test answers it. */
export interface HeldCall {
  url: string;
  /** Answers the call with `status` and `body`, and lets the answer reach the page. */
  answer: (status: number, body: unknown) => Promise<void>;
}

/**
 * `fetch`, for the rest of test `t`, holding every call until the test
 * answers it, in whatever order it chooses; the calls in the order they were
 * made.
 */
export function holdFetch(t: TestContext): HeldCall[] {
  const calls: HeldCall[] = [];

  t.mock.method(
    globalThis,
    'fetch',
    (url: string) =>
      new Promise<Response>((resolve) => {
        calls.push({
          url,
          answer: async (status, body) => {
            resolve(answer(status, body));
            await settle();
          },
        });
      }),
  );

  return calls;
}
