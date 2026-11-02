/**
 * Random pipelines of well-formed requests, as Node's HTTP parser takes them,
 * and what each request is: how many lines its head has, where its head and
 * its message end, its framing and its trailer lines (#182, D238). Heads of
 * request line, `Host` and lines of tokens, spaces, tabs and colons; bodies
 * of declared length, leading zeros allowed, and chunked bodies of upper-
 * and lower-case sizes, leading zeros and extensions, followed by trailer
 * sections; both full of the bytes that end lines and heads; CR LF between
 * messages, which Node's parser skips. The header-line scanner is held to it
 * without a socket, and Node's parser and the bound together over sockets.
 *
 * Not a test file itself: only `*.test.ts` files import it.
 */

/** A seeded generator of numbers in [0, 1), the same for the same seed. */
export function random(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;

    return state / 0x7fffffff;
  };
}

/** What one well-formed request of a model pipeline is. */
export interface Modelled {
  /** The request line and its header lines. */
  headLines: number;
  /** Where its head ends, its body begins: the byte after the empty line. */
  headEnd: number;
  body: 'none' | 'length' | 'chunked';
  /** The bytes of its body: declared, or the chunks' data together. */
  length: number;
  trailerLines: number;
  /** The byte after its last. */
  end: number;
}

/** Bytes that end lines and heads, and look like lines, for bodies. */
const NASTY = [
  '\n',
  '\r\n',
  '\n\r\n',
  '\r',
  'a:\r\n',
  '\r\n\r\n',
  '0\r\n\r\n',
  'GET / HTTP/1.1\r\n',
];

/** `size` latin1 characters of `NASTY` pieces and random bytes. */
export function nastyBytes(draw: () => number, size: number): string {
  let text = '';

  while (text.length < size) {
    text +=
      draw() < 0.5
        ? (NASTY[Math.floor(draw() * NASTY.length)] as string)
        : String.fromCharCode(Math.floor(draw() * 256));
  }

  return text.slice(0, size);
}

/**
 * A pipeline of `count` well-formed requests, as latin1 text, and what each
 * is; `maxLines` bounds the lines a head has besides its request line, `Host`
 * and framing line.
 */
export function modelPipeline(
  draw: () => number,
  count: number,
  maxLines = 300,
): { text: string; requests: Modelled[] } {
  let text = '';
  const requests: Modelled[] = [];

  for (let index = 0; index < count; index += 1) {
    if (draw() < 0.2) {
      text += '\r\n'.repeat(1 + Math.floor(draw() * 3));
    }

    const kind = (['none', 'length', 'chunked'] as const)[
      Math.floor(draw() * 3)
    ] as Modelled['body'];
    const lines = Math.floor(draw() * maxLines);
    let head = `${kind === 'none' ? 'GET' : 'POST'} /s/x?i=${index} HTTP/1.1\r\nHost: h\r\n`;

    for (let line = 0; line < lines; line += 1) {
      head += draw() < 0.3 ? 'a:\r\n' : `x-${line}: ${'v \t:'.repeat(Math.floor(draw() * 4))}v\r\n`;
    }

    let body = '';
    let length = 0;
    let trailerLines = 0;

    if (kind === 'length') {
      length = 1 + Math.floor(draw() * 3_000);
      head += `Content-Length: ${draw() < 0.2 ? '00' : ''}${length}\r\n`;
      body = nastyBytes(draw, length);
    } else if (kind === 'chunked') {
      head += 'Transfer-Encoding: chunked\r\n';

      for (let chunk = Math.floor(draw() * 6); chunk > 0; chunk -= 1) {
        const size = 1 + Math.floor(draw() * 700);
        const hex = size.toString(16);

        body += `${draw() < 0.3 ? '00' : ''}${draw() < 0.5 ? hex.toUpperCase() : hex}`;
        body += draw() < 0.3 ? ';a=b;c="d e"' : '';
        body += `\r\n${nastyBytes(draw, size)}\r\n`;
        length += size;
      }

      body += draw() < 0.3 ? '000;x\r\n' : '0\r\n';
      trailerLines = draw() < 0.5 ? Math.floor(draw() * 40) : 0;

      for (let line = 0; line < trailerLines; line += 1) {
        body += draw() < 0.5 ? 'a:\r\n' : `t-${line}: v\r\n`;
      }

      body += '\r\n';
    }

    // The request line, Host, the generated lines and the framing line.
    const headLines = 2 + lines + (kind === 'none' ? 0 : 1);

    text += `${head}\r\n`;

    const headEnd = text.length;

    text += body;
    requests.push({ headLines, headEnd, body: kind, length, trailerLines, end: text.length });
  }

  return { text, requests };
}
