// Renders the chart as `helm template` does, for the Go template actions and
// the Sprig functions its templates use, and refuses any other, naming it
// (#367). helm is not in `delivery-checks`' image, and this machine's tests
// run without it, so scripts/chart.test.mjs renders the chart with this
// module: with only the hosts set it names nothing of production's, the
// backup's off-server copy and the monitor render only when configured, and
// the deploy job's values render production as it was. The `chart` job of
// .gitlab/ci/validate.yml runs the real helm on the same cases.
//
// As a command it renders a chart from the arguments helm is given, the
// deploy job's among them, and prints each document, or with --json the
// documents as canonical JSON, sorted, for comparing two renders:
//
//   node scripts/chart-render.mjs upgrade --install <release> <chart> \
//     --namespace <namespace> --set-string <key>=<value> \
//     --set-file <key>=<path> [--wait --timeout 10m] [--json]
//
// Two parsers are here, each for a subset, each linear in its input and
// refusing what it does not read: a YAML reader for values.yaml, Chart.yaml
// and the rendered documents - block mappings and sequences, flow lists of
// scalars, `{}` and `[]`, `|` and `|-` block scalars, quoted and plain
// scalars - and the template language - text, `{{ }}` actions with `{{-` and
// `-}}` trimming, comments, `define`, `if`/`else if`/`else`, `with`, and
// pipelines of fields, literals, parentheses and the functions below.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Nesting deeper than this, in YAML or in a template, is refused rather than recursed into. */
const MAX_DEPTH = 100;

/* ------------------------------------------------------------------------ */
/* YAML                                                                      */
/* ------------------------------------------------------------------------ */

/** `line` without a comment: a `#` at its start or after white space, outside quotes. */
function stripComment(line) {
  let quote = '';

  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];

    if (quote === '"' && char === '\\') {
      at += 1;
    } else if (quote === "'" && char === "'" && line[at + 1] === "'") {
      at += 1;
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      if (at === 0 || /[\s[{,:-]/.test(line[at - 1])) quote = char;
    } else if (char === '#' && (at === 0 || line[at - 1] === ' ' || line[at - 1] === '\t')) {
      return line.slice(0, at).trimEnd();
    }
  }

  return line.trimEnd();
}

/** The spaces a line starts with: YAML's indentation, which a tab is never part of. */
const indentOf = (line) => {
  let at = 0;
  while (line[at] === ' ') at += 1;
  return at;
};

/** The position of the `"` that ends a double-quoted scalar starting at 0, or -1. */
function closingQuote(text) {
  for (let at = 1; at < text.length; at += 1) {
    if (text[at] === '\\') at += 1;
    else if (text[at] === '"') return at;
  }
  return -1;
}

/** A double-quoted scalar's text, its escapes read as YAML reads them. */
function unescapeDouble(text) {
  const escapes = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', 0: '\0', ' ': ' ' };

  return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (all, code) => {
    if (code.length > 1) return String.fromCharCode(parseInt(code.slice(1), 16));
    if (code in escapes) return escapes[code];
    throw new Error(`YAML: an escape this reader does not know: \\${code}`);
  });
}

/** A scalar written on one line: quoted, or plain and typed as YAML 1.1's core schema. */
function scalar(text) {
  if (text.startsWith('"')) {
    if (closingQuote(text) !== text.length - 1)
      throw new Error(`YAML: a double-quoted scalar this reader cannot read: ${text.slice(0, 80)}`);
    return unescapeDouble(text.slice(1, -1));
  }

  if (text.startsWith("'")) {
    const body = text.slice(1, -1);
    if (text.length < 2 || !text.endsWith("'") || body.replaceAll("''", '').includes("'"))
      throw new Error(`YAML: a single-quoted scalar this reader cannot read: ${text.slice(0, 80)}`);
    return body.replaceAll("''", "'");
  }

  if (/^[[{&*!|>%@`]/.test(text) || /^- /.test(text) || text === '-') {
    throw new Error(`YAML: a value this reader does not read: ${text.slice(0, 80)}`);
  }

  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true' || text === 'True') return true;
  if (text === 'false' || text === 'False') return false;
  if (/^-?(0|[1-9]\d*)$/.test(text)) return Number(text);
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(text)) return Number(text);

  return text;
}

/** A flow collection on one line: `{}`, `[]`, or a list of scalars without commas in them. */
function flow(text) {
  if (text === '{}') return {};
  if (text === '[]') return [];
  if (!text.startsWith('[') || !text.endsWith(']') || /[[\]{}]/.test(text.slice(1, -1))) {
    throw new Error(`YAML: a flow collection this reader does not read: ${text.slice(0, 80)}`);
  }

  return text
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim())
    .map((item) => {
      if (item === '') throw new Error('YAML: an empty item in a flow list');
      return scalar(item);
    });
}

/** The position of a mapping key's `:` in `text`, outside quotes, or -1. */
function colonOf(text) {
  let quote = '';

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];

    if (quote) {
      if (quote === '"' && char === '\\') at += 1;
      else if (quote === "'" && char === "'" && text[at + 1] === "'") at += 1;
      else if (char === quote) quote = '';
    } else if ((char === '"' || char === "'") && at === 0) {
      quote = char;
    } else if (char === ':' && (at + 1 === text.length || text[at + 1] === ' ')) {
      return at;
    }
  }

  return -1;
}

/**
 * Parses one YAML document of the subset above into plain objects, arrays,
 * strings, numbers, booleans and null; an empty document is null.
 */
export function parseYaml(text) {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));

  let at = 0;

  const skip = () => {
    while (at < lines.length && stripComment(lines[at]).trim() === '') at += 1;
  };

  const blockScalar = (header, parentIndent) => {
    if (header !== '|' && header !== '|-' && header !== '|+') {
      throw new Error(`YAML: a block scalar header this reader does not read: ${header}`);
    }

    const body = [];
    let indent = -1;

    for (; at < lines.length; at += 1) {
      const line = lines[at];

      if (line.trim() === '') {
        body.push('');
        continue;
      }

      const own = indentOf(line);

      if (indent === -1) {
        if (own <= parentIndent) break;
        indent = own;
      }

      if (own < indent) break;
      body.push(line.slice(indent));
    }

    let trailing = 0;
    while (trailing < body.length && body[body.length - 1 - trailing] === '') trailing += 1;
    const content = body.slice(0, body.length - trailing).join('\n');

    if (content === '') return '';
    if (header === '|-') return content;
    if (header === '|+') return `${content}${'\n'.repeat(trailing + 1)}`;
    return `${content}\n`;
  };

  // The value after `key:` or `- `: inline, or the block below at a deeper indent.
  const valueOf = (rest, indent, depth, sameIndentList) => {
    if (rest === '') {
      skip();
      if (at >= lines.length) return null;
      const next = indentOf(lines[at]);
      const isItem = /^\s*-( |$)/.test(lines[at]);
      if (next > indent || (sameIndentList && next === indent && isItem)) {
        return node(next, depth + 1);
      }
      return null;
    }

    if (rest.startsWith('|')) return blockScalar(rest, indent);
    if (rest.startsWith('[') || rest.startsWith('{')) return flow(rest);

    return scalar(rest);
  };

  const mapping = (indent, depth) => {
    const result = {};

    for (skip(); at < lines.length; skip()) {
      const line = stripComment(lines[at]);
      const own = indentOf(line);

      if (line[own] === '\t') throw new Error(`YAML: a tab in indentation at line ${at + 1}`);
      if (own < indent) break;
      if (own > indent) throw new Error(`YAML: unexpected indentation at line ${at + 1}`);
      if (/^\s*-( |$)/.test(line)) break;

      const text = line.slice(own);
      const colon = colonOf(text);

      if (colon <= 0) throw new Error(`YAML: not a mapping entry at line ${at + 1}`);

      const key = String(scalar(text.slice(0, colon)) ?? 'null');

      if (Object.hasOwn(result, key)) throw new Error(`YAML: the key ${key} twice`);

      at += 1;
      result[key] = valueOf(text.slice(colon + 1).trim(), indent, depth, true);
    }

    return result;
  };

  const sequence = (indent, depth) => {
    const result = [];

    for (skip(); at < lines.length; skip()) {
      const line = stripComment(lines[at]);
      const own = indentOf(line);

      if (line[own] === '\t') throw new Error(`YAML: a tab in indentation at line ${at + 1}`);
      if (own < indent || !/^\s*-( |$)/.test(line)) break;
      if (own > indent) throw new Error(`YAML: unexpected indentation at line ${at + 1}`);

      const rest = line.slice(own + 1).trimStart();

      if (rest !== '' && !rest.startsWith('"') && !rest.startsWith("'") && colonOf(rest) > 0) {
        // `- key: value` opens a mapping at the key's column: read it as if the
        // dash were a space.
        lines[at] = `${' '.repeat(own)} ${lines[at].slice(own + 1)}`;
        result.push(node(indentOf(lines[at]), depth + 1));
      } else {
        at += 1;
        result.push(valueOf(rest, own, depth, false));
      }
    }

    return result;
  };

  const node = (indent, depth) => {
    if (depth > MAX_DEPTH) throw new Error('YAML: nested deeper than this reader reads');
    skip();
    if (at >= lines.length) return null;
    return /^\s*-( |$)/.test(lines[at]) ? sequence(indent, depth) : mapping(indent, depth);
  };

  skip();

  if (at >= lines.length) return null;

  const first = stripComment(lines[at]).trim();
  let result;

  if (colonOf(first) <= 0 && !/^-( |$)/.test(first)) {
    // A document that is one scalar.
    at += 1;
    result = first.startsWith('[') || first.startsWith('{') ? flow(first) : scalar(first);
  } else {
    result = node(indentOf(lines[at]), 0);
  }

  skip();

  if (at < lines.length) throw new Error(`YAML: unexpected text at line ${at + 1}`);

  return result;
}

/** The documents of a stream, split at lines that are `---`; empty ones left out. */
export function parseYamlDocuments(text) {
  return text
    .split(/^---[ \t]*$/m)
    .map((document) => parseYaml(document))
    .filter((document) => document !== null);
}

/* ------------------------------------------------------------------------ */
/* Templates                                                                 */
/* ------------------------------------------------------------------------ */

/** Splits a template into text and actions, comments dropped, `{{-` and `-}}` applied. */
function lex(text, name) {
  const parts = [];
  let at = 0;

  while (at < text.length) {
    const open = text.indexOf('{{', at);

    if (open === -1) {
      parts.push({ text: text.slice(at) });
      break;
    }

    parts.push({ text: text.slice(at, open) });

    let start = open + 2;
    const trimLeft =
      /^- /.test(text.slice(start, start + 2)) || /^-[\t\n\r]/.test(text.slice(start, start + 2));

    if (trimLeft) start += 1;

    let end;
    let body;

    let first = start;
    while (first < text.length && /\s/.test(text[first])) first += 1;

    if (text.startsWith('/*', first)) {
      const close = text.indexOf('*/', first);
      if (close === -1) throw new Error(`${name}: a comment that does not end`);
      end = text.indexOf('}}', close);
      if (end === -1 || !/^\s*-?\s*$/.test(text.slice(close + 2, end))) {
        throw new Error(`${name}: a comment not closed by }}`);
      }
      body = null;
    } else {
      // The closing braces, outside a string.
      let quote = '';
      for (end = start; end < text.length; end += 1) {
        const char = text[end];
        if (quote) {
          if (quote === '"' && char === '\\') end += 1;
          else if (char === quote) quote = '';
        } else if (char === '"' || char === '`') {
          quote = char;
        } else if (char === '{' && text[end + 1] === '{') {
          throw new Error(`${name}: an action that holds {{`);
        } else if (char === '}' && text[end + 1] === '}') {
          break;
        }
      }
      if (end >= text.length) throw new Error(`${name}: an action that does not end`);
      body = text.slice(start, end);
    }

    const trimRight = / -$|[\t\n\r]-$/.test(text.slice(Math.max(start, end - 2), end));

    if (trimRight && body !== null) body = body.slice(0, -1);
    if (trimLeft) parts[parts.length - 1].text = parts.at(-1).text.trimEnd();
    if (body !== null) parts.push({ action: body.trim() });
    parts.push({ trimNext: trimRight });

    at = end + 2;
  }

  // Apply each `-}}` to the text after it.
  const result = [];
  let trimNext = false;

  for (const part of parts) {
    if ('trimNext' in part) {
      trimNext = part.trimNext;
    } else if ('text' in part) {
      const value = trimNext ? part.text.trimStart() : part.text;
      if (value.includes('}}')) throw new Error(`${name}: text holds }} outside an action`);
      result.push({ text: value });
      trimNext = false;
    } else {
      result.push(part);
    }
  }

  return result;
}

/** The tokens of an action's pipeline, each read where the last ended. */
function tokens(source) {
  const found = [];
  const space = /\s+/y;
  const fieldPattern = /(?:\.[A-Za-z_]\w*)+|\./y;
  const numberPattern = /-?\d+/y;
  const namePattern = /[A-Za-z_]\w*/y;
  const at = (pattern, from) => {
    pattern.lastIndex = from;
    return pattern.exec(source);
  };
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    let match;

    if ((match = at(space, index))) {
      index += match[0].length;
    } else if (char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      if (end >= source.length)
        throw new Error(`a string that does not end: ${source.slice(0, 80)}`);
      found.push({ string: unescapeDouble(source.slice(index + 1, end)) });
      index = end + 1;
    } else if (char === '(' || char === ')' || char === '|') {
      found.push({ punct: char });
      index += 1;
    } else if ((match = at(fieldPattern, index))) {
      found.push({ field: match[0] === '.' ? [] : match[0].slice(1).split('.') });
      index += match[0].length;
    } else if ((match = at(numberPattern, index))) {
      found.push({ number: Number(match[0]) });
      index += match[0].length;
    } else if ((match = at(namePattern, index))) {
      found.push({ name: match[0] });
      index += match[0].length;
    } else {
      throw new Error(`an action this renderer does not read: {{ ${source.slice(0, 80)} }}`);
    }
  }

  return found;
}

const FUNCTIONS = new Set([
  'include',
  'printf',
  'quote',
  'nindent',
  'indent',
  'toYaml',
  'required',
  'fail',
  'default',
  'eq',
  'ne',
  'not',
  'and',
  'or',
  'trimPrefix',
]);

/** A pipeline's tree: commands joined by `|`, each a list of operands. */
function parsePipeline(source) {
  const list = tokens(source);
  let at = 0;

  const pipeline = (depth) => {
    if (depth > MAX_DEPTH) throw new Error('a pipeline nested deeper than this renderer reads');
    const commands = [[]];

    while (at < list.length && list[at].punct !== ')') {
      const token = list[at];
      at += 1;

      if (token.punct === '|') {
        if (commands.at(-1).length === 0) throw new Error(`an empty command in {{ ${source} }}`);
        commands.push([]);
      } else if (token.punct === '(') {
        commands.at(-1).push({ pipeline: pipeline(depth + 1) });
        if (list[at]?.punct !== ')') throw new Error(`a ( that does not close in {{ ${source} }}`);
        at += 1;
      } else if (
        token.name &&
        !FUNCTIONS.has(token.name) &&
        !['true', 'false', 'nil'].includes(token.name)
      ) {
        throw new Error(`a function this renderer does not know: ${token.name}`);
      } else {
        commands.at(-1).push(token);
      }
    }

    if (commands.at(-1).length === 0) throw new Error(`an empty command in {{ ${source} }}`);

    return commands;
  };

  const result = pipeline(0);

  if (at !== list.length) throw new Error(`a ) with no ( in {{ ${source} }}`);

  return result;
}

/** The template's tree: text, output, if, with and define nodes. */
function parseTemplate(text, name) {
  const root = { body: [] };
  const stack = [root];

  for (const part of lex(text, name)) {
    const top = stack.at(-1);
    const into = top.branches ? top.branches.at(-1).body : top.body;

    if (part.text !== undefined) {
      if (part.text) into.push({ text: part.text });
      continue;
    }

    const action = part.action;
    let match;

    if (action === 'end') {
      if (stack.length === 1) throw new Error(`${name}: an end with no if, with or define`);
      stack.pop();
    } else if (action === 'else' || (match = /^else if (.+)$/s.exec(action))) {
      if (!top.branches || top.closed) throw new Error(`${name}: an else with no if or with`);
      if (action === 'else') {
        top.branches.push({ condition: null, body: [] });
        top.closed = true;
      } else {
        if (top.kind !== 'if') throw new Error(`${name}: else if inside a with`);
        top.branches.push({ condition: parsePipeline(match[1]), body: [] });
      }
    } else if ((match = /^(if|with) (.+)$/s.exec(action))) {
      if (stack.length > MAX_DEPTH)
        throw new Error(`${name}: nested deeper than this renderer reads`);
      const node = { kind: match[1], branches: [{ condition: parsePipeline(match[2]), body: [] }] };
      into.push(node);
      stack.push(node);
    } else if ((match = /^define "([\w.-]+)"$/.exec(action))) {
      if (stack.length !== 1) throw new Error(`${name}: a define inside another action`);
      const node = { define: match[1], body: [] };
      into.push(node);
      stack.push(node);
    } else if (/^(range|template|block|break|continue)\b|\$|:=/.test(action)) {
      throw new Error(`${name}: an action this renderer does not render: {{ ${action} }}`);
    } else {
      into.push({ output: parsePipeline(action) });
    }
  }

  if (stack.length !== 1) throw new Error(`${name}: an if, with or define with no end`);

  return root.body;
}

/** Whether Go's templates take `value` as true. */
function truth(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** A value as Go prints it with %v, for the kinds a value of the chart has. */
function printed(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error('a map or a list printed as text');
}

/** Go's %q of a string: escapes for `"`, `\` and control characters. */
function goQuote(text) {
  const named = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
  let quoted = '"';

  for (const char of text) {
    const code = char.charCodeAt(0);

    if (named[char]) quoted += named[char];
    else if (code < 0x20 || code === 0x7f) quoted += `\\x${code.toString(16).padStart(2, '0')}`;
    else quoted += char;
  }

  return `${quoted}"`;
}

/** A plain scalar YAML reads back as the same string. */
const PLAIN = /^[A-Za-z_/][\w./@-]*$/;

/** Helm's toYaml: sigs.k8s.io/yaml's keys sorted, its final newline taken off. */
export function toYaml(value, indent = '') {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return PLAIN.test(value) && scalar(value) === value ? value : goQuote(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((item) => `${indent}- ${toYaml(item, `${indent}  `).trimStart()}`).join('\n');
  }

  const keys = Object.keys(value).sort();

  if (keys.length === 0) return '{}';

  return keys
    .map((key) => {
      const item = value[key];
      const nested = item !== null && typeof item === 'object' && truth(item);
      return nested
        ? `${indent}${key}:\n${toYaml(item, `${indent}  `)}`
        : `${indent}${key}: ${toYaml(item, indent)}`;
    })
    .join('\n');
}

/** Go's fmt.Sprintf for the verbs %s, %d, %v and %%. */
function printf(format, ...args) {
  let next = 0;

  return format.replace(/%(.)/g, (all, verb) => {
    if (verb === '%') return '%';
    if (!['s', 'd', 'v'].includes(verb))
      throw new Error(`printf: a verb this renderer does not know: %${verb}`);
    if (next >= args.length) return `%!${verb}(MISSING)`;
    return printed(args[next++]);
  });
}

/** Renders a chart's templates as Helm does, or throws the first failure. */
export function renderTemplates(files, { values, release, chart, readFile }) {
  const defines = new Map();
  const trees = [];

  for (const [name, text] of files) {
    const tree = parseTemplate(text, name);

    for (const node of tree.filter((each) => each.define)) {
      if (defines.has(node.define)) throw new Error(`${name}: ${node.define} defined twice`);
      defines.set(node.define, node.body);
    }

    trees.push([name, tree.filter((each) => !each.define)]);
  }

  const root = {
    Values: values,
    Release: { Name: release.name, Namespace: release.namespace, Service: 'Helm' },
    Chart: { Name: chart.name, Version: chart.version, AppVersion: chart.appVersion },
    Files: { Get: (path) => readFile(path) },
  };

  let name = '';
  const fail = (message) => {
    throw new Error(`execution error at (${chart.name}/${name}): ${message}`);
  };

  const field = (path, dot) => {
    let value = dot;

    for (const [index, key] of path.entries()) {
      if (value === null || value === undefined || typeof value !== 'object') {
        fail(`nil pointer evaluating .${path.slice(0, index + 1).join('.')}`);
      }
      value = Object.hasOwn(value, key) ? value[key] : null;
    }

    return value;
  };

  const call = (fn, args, dot, depth) => {
    switch (fn) {
      case 'include': {
        const body = defines.get(args[0]);
        if (!body) fail(`no template "${args[0]}" associated with template "gotpl"`);
        return run(body, args[1], depth + 1);
      }
      case 'printf':
        return printf(...args);
      case 'quote':
        return args
          .filter((arg) => arg !== null && arg !== undefined)
          .map((arg) => goQuote(printed(arg)))
          .join(' ');
      case 'nindent':
        return `\n${call('indent', args, dot, depth)}`;
      case 'indent': {
        const pad = ' '.repeat(args[0]);
        return pad + printed(args[1]).replaceAll('\n', `\n${pad}`);
      }
      case 'toYaml':
        return toYaml(args[0]);
      case 'required':
        if (args[1] === null || args[1] === undefined || args[1] === '') fail(args[0]);
        return args[1];
      case 'fail':
        return fail(args[0]);
      case 'default':
        return args.length < 2 || !truth(args[1]) ? args[0] : args[1];
      case 'eq':
        return args.slice(1).some((arg) => arg === args[0]);
      case 'ne':
        return args[0] !== args[1];
      case 'not':
        return !truth(args[0]);
      case 'and':
        return args.find((arg) => !truth(arg)) ?? args.at(-1);
      case 'or':
        return args.find((arg) => truth(arg)) ?? args.at(-1);
      case 'trimPrefix':
        return printed(args[1]).startsWith(args[0])
          ? printed(args[1]).slice(args[0].length)
          : printed(args[1]);
      default:
        return fail(`function ${fn} not defined`);
    }
  };

  const operand = (token, dot, depth) => {
    if (token.pipeline) return evaluate(token.pipeline, dot, depth);
    if ('string' in token) return token.string;
    if ('number' in token) return token.number;
    if (token.field) return field(token.field, dot);
    if (token.name === 'true') return true;
    if (token.name === 'false') return false;
    if (token.name === 'nil') return null;
    return fail(`${token.name} is not a value`);
  };

  const evaluate = (commands, dot, depth) => {
    let piped;

    for (const [index, command] of commands.entries()) {
      const [head, ...rest] = command;
      const final = index > 0 ? [piped] : [];

      if (head.name && FUNCTIONS.has(head.name)) {
        piped = call(
          head.name,
          [...rest.map((token) => operand(token, dot, depth)), ...final],
          dot,
          depth,
        );
      } else if (head.field?.join('.') === 'Files.Get' && rest.length === 1 && final.length === 0) {
        piped = root.Files.Get(operand(rest[0], dot, depth));
      } else if (rest.length > 0 || final.length > 0) {
        fail(`can't give arguments to a value that is not a function`);
      } else {
        piped = operand(head, dot, depth);
      }
    }

    return piped;
  };

  const run = (body, dot, depth) => {
    if (depth > MAX_DEPTH) fail('templates included deeper than this renderer renders');

    let output = '';

    for (const node of body) {
      if (node.text !== undefined) {
        output += node.text;
      } else if (node.output) {
        output += printed(evaluate(node.output, dot, depth));
      } else {
        for (const branch of node.branches) {
          const value = branch.condition ? evaluate(branch.condition, dot, depth) : true;
          if (truth(value)) {
            output += run(
              branch.body,
              node.kind === 'with' && branch.condition ? value : dot,
              depth,
            );
            break;
          }
        }
      }
    }

    return output;
  };

  const rendered = [];

  for (const [file, tree] of trees) {
    name = file;
    if (!file.split('/').at(-1).startsWith('_')) rendered.push([file, run(tree, root, 0)]);
  }

  return rendered;
}

/* ------------------------------------------------------------------------ */
/* The chart                                                                 */
/* ------------------------------------------------------------------------ */

/** `values` with `value` at the dotted `path`, as helm's --set-string puts it. */
export function setValue(values, path, value) {
  const keys = path.split('.');

  if (keys.some((key) => !/^[\w-]+$/.test(key)))
    throw new Error(`a key this renderer does not set: ${path}`);

  let node = values;

  for (const key of keys.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key]))
      node[key] = {};
    node = node[key];
  }

  node[keys.at(-1)] = value;

  return values;
}

/**
 * The chart in `chartDir` rendered as `release` in `namespace`, with values.yaml
 * and `set`, a map of dotted keys to values over it: the documents, parsed,
 * and the text of each template.
 */
export function renderChart(chartDir, { release, namespace = release, set = {} }) {
  const chart = parseYaml(readFileSync(join(chartDir, 'Chart.yaml'), 'utf8'));
  const values = parseYaml(readFileSync(join(chartDir, 'values.yaml'), 'utf8')) ?? {};

  for (const [path, value] of Object.entries(set)) setValue(values, path, value);

  const templates = readdirSync(join(chartDir, 'templates'))
    .filter((file) => /\.(ya?ml|tpl)$/.test(file))
    .sort()
    .map((file) => [`templates/${file}`, readFileSync(join(chartDir, 'templates', file), 'utf8')]);
  const texts = renderTemplates(templates, {
    values,
    release: { name: release, namespace },
    chart: { name: chart.name, version: chart.version, appVersion: chart.appVersion },
    readFile: (path) => {
      try {
        return readFileSync(join(chartDir, path), 'utf8');
      } catch {
        return '';
      }
    },
  });

  return {
    texts,
    documents: texts.flatMap(([file, text]) => {
      try {
        return parseYamlDocuments(text);
      } catch (error) {
        throw new Error(`${file}: ${error.message}`, { cause: error });
      }
    }),
  };
}

/** `value` as JSON with every object's keys sorted. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** The documents sorted by kind and name, each canonical. */
export function sortedDocuments(documents) {
  const keyOf = (document) => `${document.kind}/${document.metadata?.name}`;
  return [...documents].sort((a, b) => keyOf(a).localeCompare(keyOf(b))).map(canonical);
}

/**
 * Helm's arguments, as the deploy job gives them, read into the release, the
 * chart, the namespace and the values set; `--set-file` read from the file.
 * A value holding a comma or a backslash, which helm would split or unescape,
 * is refused.
 */
export function parseHelmArguments(args, readFile = (path) => readFileSync(path, 'utf8')) {
  const positional = [];
  const set = {};
  let namespace;
  let json = false;

  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    const assignment = () => {
      const pair = args[++at] ?? '';
      const equals = pair.indexOf('=');
      if (equals <= 0) throw new Error(`${arg} takes <key>=<value>`);
      return [pair.slice(0, equals), pair.slice(equals + 1)];
    };

    if (arg === '--set-string' || arg === '--set-file' || arg === '--set') {
      const [key, value] = assignment();
      if (arg !== '--set-file' && /[,\\]/.test(value)) {
        throw new Error(`${arg} ${key}: a value with a comma or a backslash`);
      }
      set[key] =
        arg === '--set-file'
          ? readFile(value)
          : arg === '--set' && /^(true|false|-?\d+)$/.test(value)
            ? JSON.parse(value)
            : value;
    } else if (arg === '--namespace' || arg === '-n') {
      namespace = args[++at];
    } else if (arg === '--timeout') {
      at += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (['--install', '--wait', '--atomic'].includes(arg)) {
      // Not about what is rendered.
    } else if (arg.startsWith('-')) {
      throw new Error(`an argument this renderer does not read: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const words =
    positional[0] === 'upgrade' || positional[0] === 'template' ? positional.slice(1) : positional;

  if (words.length !== 2) throw new Error('give the release and the chart: <release> <chart>');

  return { release: words[0], chart: words[1], namespace: namespace ?? 'default', set, json };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { release, chart, namespace, set, json } = parseHelmArguments(process.argv.slice(2));
    const { texts, documents } = renderChart(chart, { release, namespace, set });

    process.stdout.write(
      json
        ? `${JSON.stringify(sortedDocuments(documents), null, 2)}\n`
        : texts.map(([file, text]) => `---\n# Source: ${file}\n${text}\n`).join(''),
    );
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
