import { Writable } from 'node:stream';
import { SESSION_ID_LENGTH } from '@webhook-inspector/shared';

const VISIBLE_CHARACTERS = 8;

/**
 * A path segment in a session-id position of a URL: whatever follows `/s/`,
 * `/v/`, `/api/sessions/` or `/ws/`, and any further slashes after them, up to
 * the next `/`, `?`, `#`, whitespace, `"` or backslash (D168).
 *
 * The segment is taken whatever its length and whatever characters it holds,
 * because a near miss of a real id - one character short, one too many, a
 * stray `.`, `'` or a percent-encoded character - is all but the whole access
 * key. `"` and the backslash end it so that a JSON string around the URL is
 * never cut into; `'` does not, because Node accepts it in a request target
 * and ending there would leave the rest of the key to a rule that needs 43
 * characters in one run.
 *
 * The prefix is a lookbehind rather than part of the match, so that a segment
 * which is itself a prefix does not hide the one after it (`/s/s/<id>`). Each
 * prefix begins with its own `/`, so `/api/sessions/` is not read as `/s/`,
 * nor `/news/` as `/ws/`. Further slashes after the prefix are matched, and
 * put back unchanged, so that `/api/sessions//<id>` is read as
 * `/api/sessions/<id>` is.
 *
 * It runs in time linear in the line, which matters because a client decides
 * what is logged: the URL, and `accept-version` through the `req` serializer,
 * each up to Node's 16 KiB header limit. The engine tries the pattern at every
 * position. The lookbehind has a fixed length of at most 15 characters, so
 * checking it costs a bounded number of steps at any position, and it holds
 * only at a position directly after a prefix. From there `\/*` walks the run
 * of slashes that starts at that position, and gives it back if no segment
 * follows; a run of slashes starts at one position only, so no slash is walked
 * from two tries. A lookbehind of variable length, `\/+` inside it, walked back
 * over every slash before each position of a run: k²/2 steps for a run of k,
 * seconds for a line of 64 KiB of slashes.
 */
const SESSION_ID_SEGMENT = /(?<=\/(?:s|v|ws|api\/sessions)\/)(\/*)([^/?#\s"\\]+)/g;

/**
 * A run of one id's length of id characters or more, anywhere in the line,
 * taken whole.
 *
 * Whole, because an id glued to other id characters - `x<id>`, `session-<id>`,
 * `<uuid>_<id>` - has no edge of its own to be found by. Cut into windows of
 * 43 counted from the left of the run, as this rule once was, such an id was
 * cut where the windows fell rather than where it starts, and up to 42 of its
 * 43 characters were logged (issue #176). Shortened whole, the run keeps its
 * first 8 characters, so an id keeps at most its own first 8, and none of
 * them when 8 or more id characters stand before it.
 *
 * Linear too: one greedy class with nothing after it never backtracks. A try
 * that matches takes the whole run and the search resumes after it, at a
 * character that ends the run, so no character of a match is read again. A try
 * that fails stands in a run shorter than 43 and reads at most 42 characters
 * and the one that ends it, so no character is read by more than 43 tries.
 */
const SESSION_ID = new RegExp(`[A-Za-z0-9_-]{${SESSION_ID_LENGTH},}`, 'g');

/** The first eight characters followed by `...`; eight or fewer are left alone. */
function shorten(token: string): string {
  // Counted in code points, so that a character outside the BMP is never split.
  const characters = Array.from(token);

  if (characters.length <= VISIBLE_CHARACTERS) {
    return token;
  }

  return `${characters.slice(0, VISIBLE_CHARACTERS).join('')}...`;
}

/**
 * Shortens every session id in a string.
 *
 * A session id is the access key to everything the session captured (D004), so
 * logs must not carry a usable one. Eight characters are enough to correlate
 * log lines while remaining useless to anyone reading them (D059).
 *
 * Two rules, applied in this order. In a session-id position of a URL the
 * segment is shortened whatever it is (D168). Anywhere else - an error message,
 * a stack trace, a field added later - a run of 43 or more id characters is,
 * whole, because a run that long is the only shape by which an id can be
 * recognised in free text, and an id inside a longer run cannot be told from
 * the characters around it (D059).
 */
export function redactSessionIds(text: string): string {
  return text
    .replace(
      SESSION_ID_SEGMENT,
      (_match, slashes: string, segment: string) => `${slashes}${shorten(segment)}`,
    )
    .replace(SESSION_ID, shorten);
}

/**
 * The single place where log output leaves the process.
 *
 * Redacting individual fields would only cover the fields someone remembered to
 * cover; an id reaching the log inside an error message, a stack trace or a
 * field added later would pass straight through. Redacting the serialised line
 * makes the guarantee in D059 hold for everything that is ever logged.
 */
export function createRedactingStream(destination: NodeJS.WritableStream): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      destination.write(redactSessionIds(chunk.toString()));
      callback();
    },
  });
}
