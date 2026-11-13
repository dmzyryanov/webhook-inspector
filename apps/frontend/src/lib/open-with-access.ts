/**
 * The check behind `Open` in the field of `Session not found` (frames R6-R8 of
 * the Figma page `Webhook Inspector · Private sessions (#228)`, issue #228,
 * D259 point 6), kept here rather than in the component because this is the
 * part of the frontend that is unit-tested (D025, D061).
 *
 * The field asks the server once, `GET /api/sessions/<id>` with the key, and
 * only the answer that the session is missing or gone - `404` / `1001` or
 * `410` / `1002`, which the page itself shows as `Session not found` (D133) -
 * says the paste opened nothing. Any other failure - `429`, a server error, no
 * connection - says nothing about the key, which may well be right, so it is
 * told apart. An answer that arrives once the field has left the page is
 * ignored, and so is a submit while a check is in flight.
 */
import type { SessionDetails } from '@webhook-inspector/shared';
import type { PastedAccess } from './request-link.ts';
import { classifySessionError } from './session-lifetime.ts';

/** What a submit of the field comes to. */
export type PasteOutcome =
  /** Nothing but spaces: the field takes focus again, and nothing is said. */
  | { kind: 'empty' }
  /**
   * The sentence of frame R7: a value that is no key or link with access, or
   * one whose session the server says is missing or gone - a wrong key
   * included.
   */
  | { kind: 'refused' }
  /** The server was not reached or failed to answer: the key may be right. */
  | { kind: 'unreachable' }
  /** The session opened with the key; `private` says whether to keep it. */
  | {
      kind: 'opened';
      sessionId: string;
      key: string;
      requestId: string | null;
      private: boolean;
    };

/** Reads a session with an explicit key, as `api.getSession` does. */
export type ReadSession = (sessionId: string, key: string) => Promise<SessionDetails>;

export interface AccessPaste {
  /**
   * The outcome of one submit, or `null` when it is to be ignored: a check
   * was already in flight, or the field left the page before the answer came.
   * Once a session has opened, every later submit is ignored too: the page
   * that follows replaces the field.
   */
  check(pasted: PastedAccess): Promise<PasteOutcome | null>;
  /** The field has left the page: any answer still on its way is ignored. */
  dispose(): void;
}

export function createAccessPaste(read: ReadSession): AccessPaste {
  let busy = false;
  let live = true;

  return {
    async check(pasted) {
      if (!live || busy) {
        return null;
      }

      if (pasted.kind === 'empty') {
        return { kind: 'empty' };
      }

      if (pasted.kind === 'invalid') {
        return { kind: 'refused' };
      }

      busy = true;

      let session: SessionDetails;

      try {
        session = await read(pasted.sessionId, pasted.key);
      } catch (error) {
        busy = false;

        if (!live) {
          return null;
        }

        return classifySessionError(error) === 'unavailable'
          ? { kind: 'refused' }
          : { kind: 'unreachable' };
      }

      if (!live) {
        busy = false;

        return null;
      }

      // `busy` stays set: the session opens, and the field is done.
      return {
        kind: 'opened',
        sessionId: pasted.sessionId,
        key: pasted.key,
        requestId: pasted.requestId,
        private: session.private === true,
      };
    },

    dispose() {
      live = false;
    },
  };
}
