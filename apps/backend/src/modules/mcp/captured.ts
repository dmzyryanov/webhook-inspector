/**
 * Captured content on its way to an agent (D203): what a sender wrote reaches
 * an agent's context, so it travels only inside one field marked as captured
 * third-party data, after a fixed sentence saying so, and a body is cut to its
 * first 64 KiB so that one call cannot flood that context (owner, 2026-10-04).
 * Pure, so every rule is tested without a server, with made-up input at
 * growing sizes.
 */
import {
  MCP_BODY_MAX_BYTES,
  MCP_UNTRUSTED_FIELD,
  MCP_UNTRUSTED_NOTICE,
} from '@webhook-inspector/shared/mcp';
import { asciiLowerCase } from '../requests/list-query.ts';

/** How `get_request` writes a body. `null`: the body is empty. */
export type BodyEncoding = 'utf-8' | 'base64' | null;

/**
 * A body as the API has read it (D043), the fields of `getRequestDetails`'s
 * answer that carry it: valid UTF-8 as text, decoded once, without the one
 * leading byte-order mark the decoder leaves out; anything else as Base64.
 */
export interface ReadBody {
  /** The size of the captured body, in bytes. */
  bodySize: number;
  isBinary: boolean;
  /** The text, or `null` for a binary body. */
  body: string | null;
  /** The Base64 of a binary body, or `null` for text. */
  bodyBase64: string | null;
}

export interface AgentBody {
  /** The first bytes of the body as text or Base64, or `null` for an empty body. */
  body: string | null;
  bodyEncoding: BodyEncoding;
  /** Whether bytes after the ones returned were left out. */
  truncated: boolean;
}

/**
 * Where a cut of valid UTF-8 at `max` bytes may fall: `max` itself, or before
 * the character `max` would split. A continuation byte (`10xxxxxx`) at `max`
 * means the character began before it, at most three bytes before.
 */
function characterBoundary(bytes: Buffer, max: number): number {
  let cut = max;

  while (cut > 0 && ((bytes[cut] as number) & 0xc0) === 0x80) {
    cut -= 1;
  }

  return cut;
}

/**
 * At most the first `max` bytes of a body the API has read (D043), so that
 * what `get_request` returns is a prefix of the API's own `body` or
 * `bodyBase64`, and the whole of it when it fits.
 *
 * Text is the API's text exactly, never decoded again - which would leave
 * out a second leading byte-order mark, one the API keeps as U+FEFF - and is
 * cut, when its UTF-8 is longer than `max`, before the character the cut would
 * split, so that what is returned is valid text up to three bytes short of
 * `max`. A binary body is Base64 of its first `max` bytes. An empty body is
 * `null` with no encoding; a body of one byte-order mark alone is text with
 * nothing after it. `truncated` says whether anything was left out.
 */
export function agentBody(read: ReadBody, max: number = MCP_BODY_MAX_BYTES): AgentBody {
  if (read.bodySize === 0) {
    return { body: null, bodyEncoding: null, truncated: false };
  }

  if (read.isBinary) {
    const bytes = Buffer.from(read.bodyBase64 ?? '', 'base64');

    return {
      body: bytes.subarray(0, max).toString('base64'),
      bodyEncoding: 'base64',
      truncated: bytes.length > max,
    };
  }

  const text = read.body ?? '';
  // The text's own bytes, so that a cut counts what the agent is given.
  const bytes = Buffer.from(text, 'utf8');

  if (bytes.length <= max) {
    return { body: text, bodyEncoding: 'utf-8', truncated: false };
  }

  return {
    body: bytes.subarray(0, characterBoundary(bytes, max)).toString('utf8'),
    bodyEncoding: 'utf-8',
    truncated: true,
  };
}

/**
 * The value of the first `Content-Type` header among captured pairs, its name
 * compared in ASCII lower case as a header condition compares it (D196), or
 * `null` when there is none.
 */
export function contentTypeOf(
  headers: readonly (readonly [string, string])[] | undefined,
): string | null {
  for (const [name, value] of headers ?? []) {
    if (name.length === 12 && asciiLowerCase(name) === 'content-type') {
      return value;
    }
  }

  return null;
}

/** One block of a tool's content. */
export interface TextContent {
  type: 'text';
  text: string;
}

/** What `tools/call` answers. */
export interface CallToolResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * The answer of a tool that returns no captured content: the structured
 * result, and the same as JSON in one text block for a client that reads only
 * text, as the specification asks.
 */
export function plainResult(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * The answer of a tool that returns captured content (D203).
 *
 * `fields` are the tool's own, and every captured value is inside
 * `untrustedCapturedContent` within them, which the caller builds: nothing a
 * sender wrote is ever put in a sentence. The answer's text opens with the
 * fixed sentence, a block of its own, and the structured result opens with it
 * too, as `notice`, so a client that hands the model only one of the two
 * still gives it the sentence first. The second block is the structured
 * result as JSON, whose escaping keeps every captured value inside its
 * string: a quote, a brace or a line break a sender wrote cannot end it.
 */
export function capturedResult(fields: Record<string, unknown>): CallToolResult {
  const structured = { notice: MCP_UNTRUSTED_NOTICE, ...fields };

  return {
    content: [
      { type: 'text', text: MCP_UNTRUSTED_NOTICE },
      { type: 'text', text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
}

/** A tool's refusal: one sentence of the server's own, `isError` set, no structured result. */
export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** The field's name, for code that builds what goes in it. */
export const UNTRUSTED = MCP_UNTRUSTED_FIELD;
