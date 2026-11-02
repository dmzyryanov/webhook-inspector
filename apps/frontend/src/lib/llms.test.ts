import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';
import {
  API_CALL_LIMIT,
  ErrorCode,
  MAX_CALLS_IN_FLIGHT,
  MAX_CONCURRENT_HEADER_QUERIES,
  MAX_CONCURRENT_SEARCHES,
  SESSION_CREATE_LIMIT,
  SESSION_IDLE_WINDOW_MAX_SECONDS,
  SESSION_IDLE_WINDOW_MIN_SECONDS,
  SESSION_LIFETIME_MAX_SECONDS,
  SESSION_LIFETIME_MIN_SECONDS,
} from '@webhook-inspector/shared';
import {
  MCP_INSTRUCTIONS,
  MCP_PATH,
  MCP_TOOL_NAMES,
  mcpTools,
} from '@webhook-inspector/shared/mcp';
import {
  AGENT_SECTION_FILE,
  buildLlmsFiles,
  endpointList,
  LLMS_FILE,
  llmsFull,
  OPENAPI_FILE,
  type OpenApiDescription,
} from '../../scripts/build-llms.mjs';
import { openApiText } from '../../scripts/build-site-files.mjs';
import { PRODUCTION_ORIGINS, RECEIVE_ORIGIN } from '../../scripts/site-origin.mjs';

/** The tools as the MCP server of this build's receive host lists them (D274). */
const MCP_TOOLS = mcpTools(RECEIVE_ORIGIN);

/**
 * The agent-readable documentation (D165). `llms-full.txt` is generated, so
 * what it copies from `openapi.json` cannot drift; the two hand-written files,
 * `llms/llms.txt` and `llms/agent-section.md`, can, and these tests hold every
 * API path, method and field they name to the description.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const openapi = JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as OpenApiDescription & {
  paths: Record<string, Record<string, unknown>>;
  components: unknown;
};
const llmsTxt = readFileSync(LLMS_FILE, 'utf8');
const agentSection = readFileSync(AGENT_SECTION_FILE, 'utf8');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'];

/** Words written in backticks that are tools or literals, not API fields. */
const NOT_FIELDS = new Set(['curl', 'jq', 'null', 'true', 'false']);

/**
 * Every property name, every parameter name, and every `const` or `enum`
 * string, anywhere in the description: a query parameter such as the list's
 * `wait` (D200) is a name the API has, as a field is.
 */
function knownNames(node: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) {
      knownNames(item, names);
    }
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const name of Object.keys(value)) {
          names.add(name);
        }
      }

      if (key === 'parameters' && Array.isArray(value)) {
        for (const parameter of value as unknown[]) {
          if (
            parameter !== null &&
            typeof parameter === 'object' &&
            'name' in parameter &&
            typeof parameter.name === 'string'
          ) {
            names.add(parameter.name);
          }
        }
      }

      if (key === 'const' && typeof value === 'string') {
        names.add(value);
      }

      if (key === 'enum' && Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            names.add(item);
          }
        }
      }

      knownNames(value, names);
    }
  }

  return names;
}

/** A path as segments, every `{param}`, `$VAR` or `${VAR}` segment read as a parameter. */
function shape(path: string): string {
  return path
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => (/^(?:\{[^}]*\}|\$\{?\w+\}?)$/.test(segment) ? '{}' : segment))
    .join('/');
}

const API_PATH = /\/(?:api|s)\/[^\s`'"()<>?#\]]*/g;

/** The API paths, methods and field names a hand-written text names. */
function namedApiTerms(text: string) {
  const paths: { method?: string; path: string }[] = [];
  const fields = new Set<string>();
  // A shell command continued over several lines is read as one.
  const joined = text.replace(/\\\n\s*/g, ' ');

  for (const line of joined.split('\n')) {
    let rest = line;

    for (const command of line.matchAll(/\bcurl\b[^|;]*/g)) {
      const url = command[0].match(API_PATH)?.[0];

      if (url === undefined) {
        continue;
      }

      const method =
        command[0].match(/-X\s+([A-Z]+)/)?.[1] ?? (/\s-d\s/.test(command[0]) ? 'POST' : 'GET');

      paths.push({ method, path: url.replace(/[.,:;]+$/, '') });

      // A body sent to the webhook URL is the sender's own, not an API field.
      if (url.startsWith('/s/')) {
        rest = rest.replace(command[0], ' ');
      }
    }

    for (const match of rest.matchAll(/\b([A-Z]+) (\/(?:api|s)\/[^\s`'"()<>?#\]]*)/g)) {
      if (METHODS.includes(match[1] as string)) {
        paths.push({ method: match[1], path: (match[2] as string).replace(/[.,:;]+$/, '') });
      }
    }

    for (const match of rest.matchAll(API_PATH)) {
      paths.push({ path: match[0].replace(/[.,:;]+$/, '') });
    }

    for (const match of rest.matchAll(/(?<!\\)"(\w+)"\s*:/g)) {
      fields.add(match[1] as string);
    }

    for (const match of rest.matchAll(/`([a-z][A-Za-z0-9]*)`/g)) {
      if (!NOT_FIELDS.has(match[1] as string)) {
        fields.add(match[1] as string);
      }
    }

    for (const filter of rest.matchAll(/\bjq\s+(?:-\w+\s+)*'([^']*)'/g)) {
      for (const match of (filter[1] as string).matchAll(/\.(\w+)/g)) {
        fields.add(match[1] as string);
      }
    }
  }

  return { paths, fields: [...fields] };
}

/**
 * What the MCP section of the agent documentation may name beside the HTTP
 * API's terms (D203): every name of the tools' input and output schemas, and
 * the two keys of an MCP client's configuration file it shows, `mcpServers`
 * and `url`, which belong to the client and to no schema here.
 */
const MCP_NAMES = new Set([...knownNames(MCP_TOOLS), 'mcpServers', 'url']);

/**
 * What a hand-written text names that the description does not have, or,
 * given `extra`, that neither has.
 */
function unknownApiTerms(
  text: string,
  description: typeof openapi,
  extra: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = [];
  const operations = new Map<string, Set<string>>();

  for (const [path, item] of Object.entries(description.paths)) {
    const methods = operations.get(shape(path)) ?? new Set<string>();

    for (const key of Object.keys(item)) {
      if (METHODS.includes(key.toUpperCase())) {
        methods.add(key.toUpperCase());
      }
    }

    operations.set(shape(path), methods);
  }

  const { paths, fields } = namedApiTerms(text);
  const names = new Set([...knownNames(description), ...extra]);

  for (const { method, path } of paths) {
    const methods = operations.get(shape(path));

    if (methods === undefined) {
      problems.push(`path ${path} is not in openapi.json`);
    } else if (method !== undefined && !methods.has(method)) {
      problems.push(`${method} ${path} is not in openapi.json`);
    }
  }

  for (const field of fields) {
    if (!names.has(field)) {
      problems.push(`field ${field} is not in openapi.json`);
    }
  }

  return [...new Set(problems)];
}

describe('the hand-written agent documentation', () => {
  for (const [name, text] of [
    ['llms/llms.txt', llmsTxt],
    ['llms/agent-section.md', agentSection],
  ] as const) {
    it(`${name} names only paths, methods and fields that openapi.json or the MCP tools have`, () => {
      assert.deepEqual(unknownApiTerms(text, openapi, MCP_NAMES), []);
    });

    it(`${name} names only tools the MCP server has (D203)`, () => {
      for (const match of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        assert.ok(
          (MCP_TOOL_NAMES as readonly string[]).includes(match[1] as string),
          `${match[1]} is not a tool`,
        );
      }
    });
  }

  it('the agent section covers waiting, cleaning up and the requests to the API it uses', () => {
    const { paths, fields } = namedApiTerms(agentSection);
    const named = new Set(paths.map(({ method, path }) => `${method ?? ''} ${shape(path)}`));

    for (const operation of [
      'POST /api/sessions',
      'DELETE /api/sessions/{}',
      'GET /api/sessions/{}/requests',
      'GET /api/sessions/{}/requests/{}',
      'DELETE /api/sessions/{}/requests',
      'DELETE /api/sessions/{}/requests/{}',
      'POST /s/{}',
    ]) {
      assert.ok(named.has(operation), `the agent section does not name ${operation}`);
    }

    for (const field of [
      'body',
      'status',
      'headers',
      'delayMs',
      'errorCode',
      'wait',
      'expiresInSeconds',
      'expiresAfterIdleSeconds',
    ]) {
      assert.ok(fields.includes(field), `the agent section does not name ${field}`);
    }
  });

  it('the agent section tells a run that can be interrupted to create its session with a lifetime (D220)', () => {
    const cleanup = agentSection.slice(
      agentSection.indexOf('### Cleaning up after yourself'),
      agentSection.indexOf('### Answering retries'),
    );

    assert.ok(cleanup.includes('{"expiresInSeconds":3600}'), 'no lifetime in the clean-up steps');
    assert.ok(
      cleanup.includes(`${SESSION_LIFETIME_MIN_SECONDS} to ${SESSION_LIFETIME_MAX_SECONDS}`),
      'the clean-up steps do not give the bounds',
    );
    assert.ok(
      agentSection.includes(
        'a creation takes only `response`, `queue`, `expiresInSeconds`, `expiresAfterIdleSeconds`, `storeSourceIp`, `rules` and `private`',
      ),
      'the unknown-keys mistake does not list the lifetime, the idle window, the address choice, the rules and private',
    );
  });

  it('the agent section tells an agent how to have a session expire soon after its last use (D242)', () => {
    const cleanup = agentSection.slice(
      agentSection.indexOf('### Cleaning up after yourself'),
      agentSection.indexOf('### Answering retries'),
    );

    assert.ok(
      cleanup.includes('{"expiresAfterIdleSeconds":3600}'),
      'no idle window in the clean-up steps',
    );
    assert.ok(
      cleanup.includes(`${SESSION_IDLE_WINDOW_MIN_SECONDS} to ${SESSION_IDLE_WINDOW_MAX_SECONDS}`),
      'the clean-up steps do not give the bounds of the idle window',
    );
    assert.ok(
      agentSection.includes('It takes `expiresAfterIdleSeconds` as the API does'),
      'the MCP part does not name the idle window',
    );
  });

  it('the agent section tells an agent how to keep no sender address, and that headers stay as sent (D243)', () => {
    const security = agentSection.slice(agentSection.indexOf('### Security'));

    assert.ok(
      security.includes('{"storeSourceIp":false}'),
      'the security part does not say how to keep no address',
    );
    assert.ok(
      security.includes('`X-Forwarded-For` included, are kept as sent'),
      'the security part does not say the headers are kept as sent',
    );
    assert.ok(
      agentSection.includes('it takes `storeSourceIp` as the API does'),
      'the MCP part does not name the address choice',
    );
    assert.ok(
      agentSection.includes('a `storeSourceIp` or a `private` that is not `true` or `false`'),
      'the mistakes do not name a choice that is no boolean',
    );
  });

  it('the agent section and llms.txt tell an agent how to create a private session, keep its key and present it (D253)', () => {
    const start = agentSection.indexOf('### Private sessions');
    const section = agentSection.slice(start, agentSection.indexOf('\n### ', start + 1));

    assert.ok(start > 0, 'the agent section has no Private sessions part');

    for (const phrase of [
      `-d '{"private":true}'`,
      '`accessKey`',
      'nothing returns it again',
      'Authorization: Bearer $WEBHOOK_INSPECTOR_ACCESS_KEY',
      '"accessKeys": {"<id>": "<key>"}',
      '`webhook-inspector.access-key.<key>` beside `webhook-inspector`',
      // The old names, until the date the changelog gives, which it does not name (D279).
      '`qa-tools.access-key.<key>` beside `qa-tools` is taken only until the date the changelog gives',
      '`404` with `errorCode` `1001`',
      'Never in a URL',
    ]) {
      assert.ok(section.includes(phrase), `the Private sessions part does not say ${phrase}`);
    }

    assert.ok(
      agentSection.includes(
        '`create_session` takes `private` as the API does, but never draws a key',
      ),
    );
    assert.ok(agentSection.includes('`WEBHOOK_INSPECTOR_ACCESS_KEY` before you run it'));
    assert.ok(
      agentSection.includes(
        'its old name, `QA_TOOLS_ACCESS_KEY`, is read only when it is not set, and only until the date the changelog gives',
      ),
    );
    assert.ok(!agentSection.includes('no accounts and no keys'), 'the stale sentence is back');
    assert.ok(!agentSection.includes('There is no authentication'), 'the stale sentence is back');
    assert.ok(llmsTxt.includes('`{"private":true}`') && llmsTxt.includes('`accessKey`'));
    assert.ok(!llmsTxt.includes('There is no authentication'), 'the stale sentence is back');
  });

  it('the agent section names the private case of a 1001 beside its advice to create a new session, and where --api sends the key (#256)', () => {
    // A 1001 does not always mean the session is gone: a private session
    // without its key answers it too, as the Private sessions part below says.
    const gone =
      '\n- `404` with `errorCode` `1001`, or `410` with `1002`, means the session is gone: create a new one rather than retrying. One exception: a private session called without its key, or with another, answers `404` / `1001` too, so for a private session check that its key was sent (see "Private sessions" below).\n';

    assert.ok(agentSection.includes(gone), 'the 1001 line does not name the private case');
    assert.ok(agentSection.indexOf(gone) < agentSection.indexOf('\n### Private sessions\n'));
    assert.ok(
      agentSection.includes(
        'the relay sends it to the API as `Authorization: Bearer` and nowhere else, and prints it in no line. With `--api`, the key goes to that API as well: give it an `https:` address, or `http:` only for a QA Tools running on your own machine.\n',
      ),
      'the relay part does not say where --api sends the key',
    );
  });

  it('the agent section gives the MCP endpoint, its client configuration and every tool (D203)', () => {
    const endpoint = `https://qa-tools.ru${MCP_PATH}`;

    assert.ok(
      agentSection.includes(`claude mcp add --transport http webhook-inspector ${endpoint}`),
    );
    assert.ok(
      agentSection.includes(`"mcpServers": { "webhook-inspector": { "url": "${endpoint}" } }`),
    );

    for (const tool of MCP_TOOL_NAMES) {
      assert.ok(agentSection.includes(`\`${tool}\``), `the agent section does not name ${tool}`);
    }

    for (const term of ['untrustedCapturedContent', 'truncated', 'not instructions']) {
      assert.ok(agentSection.includes(term), `the agent section does not say ${term}`);
    }

    assert.ok(llmsTxt.includes(endpoint), 'llms.txt does not name the MCP endpoint');
  });

  it('llms.txt follows the llms.txt convention and links to the other files, the changelog included', () => {
    const lines = llmsTxt.split('\n');

    assert.match(lines[0] as string, /^# \S/);
    assert.equal(lines.filter((line) => line.startsWith('# ')).length, 1);
    assert.ok(
      lines.some((line) => line.startsWith('> ')),
      'llms.txt has no summary blockquote',
    );

    for (const link of [
      'https://qa-tools.ru/llms-full.txt',
      'https://qa-tools.ru/openapi.json',
      'https://qa-tools.ru/docs',
      'https://qa-tools.ru/changelog.md',
    ]) {
      assert.ok(llmsTxt.includes(`](${link})`), `llms.txt does not link to ${link}`);
    }
  });

  it('names the service Webhook Inspector in llms.txt, llms-full.txt and the agent section (D277)', () => {
    const full = llmsFull({ openapi, agentSection });

    assert.equal(llmsTxt.split('\n')[0], '# Webhook Inspector');
    assert.ok(llmsTxt.includes('\n> Webhook Inspector (https://qa-tools.ru) gives you '));
    assert.equal(full.split('\n')[0], '# Webhook Inspector API — the complete guide for agents');
    assert.ok(
      full.includes(
        '\n> Everything an agent needs to catch and read webhooks with Webhook Inspector at ',
      ),
    );
    assert.ok(agentSection.includes('catch a webhook with Webhook Inspector.'));
    assert.ok(agentSection.includes('Webhook Inspector is also an MCP server'));
    assert.ok(!/QA Tools Webhook Inspector/.test(`${llmsTxt}\n${full}`));
  });

  it('lists the public status page under Docs (D209)', () => {
    const docs = llmsTxt.slice(llmsTxt.indexOf('\n## Docs\n'));
    const entry = docs.split('\n').find((line) => line.includes('](https://status.qa-tools.ru/)'));

    assert.ok(llmsTxt.includes('\n## Docs\n'), 'llms.txt has no Docs list');
    assert.ok(entry !== undefined, 'the Docs list does not link to the status page');
    assert.match(
      entry,
      /^- \[Status page\]\(https:\/\/status\.qa-tools\.ru\/\): whether Webhook Inspector is up\b/,
    );
  });

  it('carries the status page into llms-full.txt through the description (D209)', () => {
    const full = llmsFull({ openapi, agentSection });

    assert.ok(full.includes(openapi.info.description));
    assert.match(openapi.info.description, /https:\/\/status\.qa-tools\.ru\b/);
  });

  it('names the per-minute limits and the calls in progress, in llms.txt, the agent section and the MCP instructions (D201, D213)', () => {
    for (const [name, text] of [
      ['llms.txt', llmsTxt],
      ['the agent section', agentSection],
      ['the MCP instructions', MCP_INSTRUCTIONS],
    ] as const) {
      assert.ok(
        text.includes(`create ${SESSION_CREATE_LIMIT} sessions`),
        `${name}: no session limit`,
      );
      assert.ok(text.includes(`make ${API_CALL_LIMIT} other`), `${name}: no call limit`);
      assert.match(
        text,
        new RegExp(
          `have ${MAX_CALLS_IN_FLIGHT} calls in progress at a time, on the API and (?:the MCP server|this server) together, waits included`,
        ),
        `${name} does not name the ${MAX_CALLS_IN_FLIGHT} calls in progress`,
      );
    }

    // The refusal, where the text names refusals by their errorCode.
    for (const [name, text] of [
      ['llms.txt', llmsTxt],
      ['the agent section', agentSection],
    ] as const) {
      assert.ok(
        text.includes(
          `the next is \`429\` with \`errorCode\` \`${ErrorCode.TOO_MANY_CONCURRENT_CALLS}\` and \`Retry-After: 1\``,
        ),
        `${name} does not name the refusal`,
      );
    }
  });

  it('names the places of searches and queries and the Retry-After of 1012 as the API does, in the agent section and list_requests (D250)', () => {
    const words: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four' };
    const headerOnly = words[MAX_CONCURRENT_HEADER_QUERIES];
    const searches = words[MAX_CONCURRENT_SEARCHES];
    const query = openapi.paths['/api/sessions/{sessionId}/requests/query']?.post as {
      description: string;
      responses: Record<string, { description: string }>;
    };
    const retryAfter = (
      openapi as unknown as {
        components: { headers: { RetryAfter: { description: string } } };
      }
    ).components.headers.RetryAfter.description;
    const listRequests = MCP_TOOLS.find((tool) => tool.name === 'list_requests');

    assert.ok(headerOnly !== undefined && searches !== undefined);
    assert.ok(
      agentSection.includes(`It runs ${headerOnly} queries without a body condition at a time`),
      'the agent section does not name the places of header-only queries',
    );
    assert.ok(
      agentSection.includes(`${searches} searches and queries with a \`body\` condition`),
      "the agent section does not name the search's places",
    );
    assert.ok(
      agentSection.includes(
        `the next of either is \`429\` with \`errorCode\` \`${ErrorCode.SEARCH_BUSY}\` and \`Retry-After: 1\``,
      ),
      'the agent section does not name the refusal',
    );
    // The API description says the same numbers and the same header.
    assert.ok(query.description.includes(`one of ${headerOnly} places of its own`));
    assert.ok(query.description.includes(`shares the ${searches} places of`));
    assert.ok(query.description.includes('`429` / `1012` with `Retry-After: 1`'));
    assert.ok(
      query.responses['429']?.description.includes(
        `${headerOnly} queries without a body condition`,
      ),
    );
    assert.match(retryAfter, /`1` after `1012`,/);
    // So do its Limits and its error table, which llms-full.txt copies.
    const info = openapi.info.description;
    const capitalised = `${searches.charAt(0).toUpperCase()}${searches.slice(1)}`;

    assert.ok(
      info.includes(
        `Searches, and queries with a \`body\` condition, keep their own ${searches} at a time; queries with header conditions alone, or none, have ${headerOnly} more of their own. The next of either is refused at once: \`429\`, \`errorCode\` \`${ErrorCode.SEARCH_BUSY}\`, \`Retry-After: 1\`.`,
      ),
      'info.description does not name both counts of 1012 and its Retry-After in its Limits',
    );
    assert.equal(
      info.split('\n').find((line) => line.startsWith(`| \`${ErrorCode.SEARCH_BUSY}\` |`)),
      `| \`${ErrorCode.SEARCH_BUSY}\` | \`SEARCH_BUSY\` | \`429\` | ${capitalised} searches, or queries of requests with a \`body\` condition, were already running on the server; or, for a query with header conditions alone or none, ${headerOnly} such queries were. Call again after \`Retry-After\`, one second. |`,
      "info.description's 1012 row does not name both counts and Retry-After",
    );
    // And so does the tool.
    assert.ok(
      listRequests?.description.includes(
        `runs ${MAX_CONCURRENT_HEADER_QUERIES} filtered lists with header conditions alone at a time, and apart from them ${MAX_CONCURRENT_SEARCHES} with a body condition`,
      ),
    );
    assert.ok(listRequests?.description.includes('errorCode 1012: call again after a second'));
  });
});

/** The bash recipe at the top of the agent section. */
function recipe(): string {
  return /```bash\n([\s\S]*?)```/.exec(agentSection)?.[1] ?? '';
}

/**
 * The recipe's waiting step (D200) as it is written: the one line that sets
 * `REQUEST` from a call of curl, and the query string of the list call in it.
 * What the line does with the answer is not matched here: the tests below run
 * it, so a changed filter is judged by what it yields.
 */
function recipeWaitStep(): { line: string; query: string } {
  const lines = recipe().match(/^REQUEST=\$\(curl .*\)$/gm) ?? [];

  assert.equal(lines.length, 1, 'the recipe does not wait with one call of curl');

  const line = lines[0] ?? '';
  const query =
    /^REQUEST=\$\(curl -s "https:\/\/qa-tools\.ru\/api\/sessions\/\$SESSION\/requests\?([^"]*)" \| jq /.exec(
      line,
    )?.[1];

  assert.ok(query !== undefined, 'the recipe does not wait with one call of the list');

  return { line, query };
}

describe('the recipe’s waiting step (D200)', () => {
  it('waits with one call of the list, with parameters the list takes', () => {
    const { query } = recipeWaitStep();
    const list = openapi.paths['/api/sessions/{sessionId}/requests']?.get as {
      parameters: { name: string; schema: { minimum?: number; maximum?: number } }[];
    };
    const parameters = new Map(list.parameters.map((parameter) => [parameter.name, parameter]));
    const given = new URLSearchParams(query);

    for (const name of given.keys()) {
      assert.ok(parameters.has(name), `the list takes no ${name}`);
    }

    const wait = Number(given.get('wait'));
    const schema = parameters.get('wait')?.schema;

    assert.ok(Number.isInteger(wait), 'the recipe waits without a whole number of seconds');
    assert.ok(wait >= (schema?.minimum ?? 1) && wait <= (schema?.maximum ?? 0), `wait=${wait}`);
    assert.ok(
      recipe().includes(`no webhook arrived within ${wait} seconds`),
      'the timeout message names another wait',
    );
  });

  it('keeps no loop, no pause and no list of ids seen before', () => {
    assert.doesNotMatch(recipe(), /\bsleep\b|\bfor attempt\b|\bSEEN=/);
  });
});

/**
 * The waiting step run as the recipe writes it: the line taken from its text,
 * run by `sh` — and by `bash` too where installed, the recipe's own language —
 * with the real `jq`, and `curl` replaced by a stand-in first on the `PATH`
 * that prints a fixed answer, exits with a given status and records its
 * arguments. What the step leaves in `REQUEST` is printed, and the shell exits
 * with the step's own status, which is `jq`'s, the pipeline's last command.
 *
 * `sh` and `jq` are required: without them these tests **fail**, they never
 * skip, as the `Copy as cURL` round trip does without curl (D167). CI's `test`
 * job installs jq for them, since `node:24-slim` has none.
 */
describe('the recipe’s waiting step, run with a stand-in for curl (D200)', () => {
  const SESSION = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';
  const row = (id: string, receivedAt: string) => ({
    id,
    method: 'POST',
    receivedAt,
    bodySize: 36,
    sourceIp: '203.0.113.7',
    path: `/s/${SESSION}`,
    response: { state: 'sent', status: 200 },
  });
  const NEWEST = row('7c1e0d52-9a4b-4f3e-8d21-5b6a0c9e1f04', '2026-10-04T09:00:02.000Z');
  const MIDDLE = row('3f8a1b20-0000-4000-8000-000000000000', '2026-10-04T09:00:01.000Z');
  const OLDEST = row('0b9d4e7a-2c3f-4a61-9e85-d1f0a2b3c4d5', '2026-10-04T09:00:00.000Z');

  let directory = '';
  let shells: string[] = [];
  let runs = 0;

  before(() => {
    // Required, never skipped (see above).
    assert.doesNotThrow(
      () => execFileSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }),
      'sh must be installed',
    );
    assert.doesNotThrow(
      () => execFileSync('jq', ['--version'], { stdio: 'ignore' }),
      'jq must be installed',
    );

    shells = ['sh'];

    if (spawnSync('sh', ['-c', 'command -v bash'], { stdio: 'ignore' }).status === 0) {
      shells.push('bash');
    }

    directory = mkdtempSync(join(tmpdir(), 'webhook-inspector-llms-'));

    const curl = join(directory, 'curl');

    writeFileSync(
      curl,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" >> "$CURL_ARGUMENTS"`,
        `printf '%s' "$CURL_ANSWER"`,
        'exit "$CURL_STATUS"',
        '',
      ].join('\n'),
    );
    chmodSync(curl, 0o755);
  });

  after(() => {
    if (directory !== '') {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /**
   * Runs the step in each shell with curl answering `answer` and exiting with
   * `curlStatus`. Every shell must agree on the id, the status and the calls
   * of curl, each call's arguments one per line.
   */
  function runStep(
    answer: string,
    curlStatus = 0,
  ): { request: string; status: number; curlCalls: string } {
    const outcomes = shells.map((shell) => {
      runs += 1;

      const argumentsFile = join(directory, `arguments-${runs}`);
      const result = spawnSync(
        shell,
        ['-c', `${recipeWaitStep().line}\nstatus=$?\nprintf '%s' "$REQUEST"\nexit "$status"`],
        {
          env: {
            PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
            SESSION,
            CURL_ANSWER: answer,
            CURL_STATUS: String(curlStatus),
            CURL_ARGUMENTS: argumentsFile,
          },
          encoding: 'utf8',
        },
      );

      assert.equal(result.error, undefined, `${shell} did not run`);

      return {
        request: result.stdout,
        status: result.status ?? -1,
        curlCalls: readFileSync(argumentsFile, 'utf8'),
      };
    });

    for (const [index, outcome] of outcomes.entries()) {
      assert.deepEqual(outcome, outcomes[0], `${shells[index] ?? ''} disagrees with sh`);
    }

    return outcomes[0] ?? { request: '', status: -1, curlCalls: '' };
  }

  /** The id and the status of a run, without its calls of curl. */
  const only = ({ request, status }: { request: string; status: number }) => ({ request, status });

  it('calls curl once, quietly, for the list of the session the recipe created', () => {
    const url = `https://qa-tools.ru/api/sessions/${SESSION}/requests?${recipeWaitStep().query}`;

    assert.equal(runStep(JSON.stringify([MIDDLE])).curlCalls, `-s\n${url}\n`);
    assert.equal(runStep('[]').curlCalls, `-s\n${url}\n`);
  });

  it('yields no id for [], the answer when nothing arrived in time', () => {
    assert.deepEqual(only(runStep('[]')), { request: '', status: 0 });
    assert.deepEqual(only(runStep('[]\n')), { request: '', status: 0 });
  });

  it('yields the id of a list of one', () => {
    assert.deepEqual(only(runStep(JSON.stringify([MIDDLE]))), { request: MIDDLE.id, status: 0 });
  });

  it('yields the first id of a list of several, newest first as the list answers', () => {
    assert.deepEqual(only(runStep(JSON.stringify([NEWEST, MIDDLE, OLDEST], null, 2))), {
      request: NEWEST.id,
      status: 0,
    });
  });

  for (const [status, errorCode, message] of [
    [404, 1001, 'Session not found'],
    [410, 1002, 'Session expired'],
    [400, 1013, 'wait must be an integer number of seconds from 1 to 30'],
  ] as const) {
    it(`fails, and yields no id, on the error object of a ${status} / ${errorCode}`, () => {
      const outcome = runStep(JSON.stringify({ errorCode, message }));

      assert.equal(outcome.request, '');
      assert.notEqual(outcome.status, 0, 'the step succeeded on an error object');
    });
  }

  it('yields no id when curl answered nothing, as when it could not connect', () => {
    assert.equal(runStep('', 7).request, '');
  });
});

describe('the checker behind those tests', () => {
  it('catches a path, a method and a field the description does not have', () => {
    const problems = unknownApiTerms(
      [
        'Wait with `GET /api/sessions/{sessionId}/wait`.',
        'curl -X PATCH "https://qa-tools.ru/api/sessions/$SESSION"',
        'Send `{"response":{"status":201,"contentType":"text/plain"}}`, then read `bodyJson`.',
        "curl -s -X POST https://qa-tools.ru/api/sessions | jq -r '.sessionId'",
      ].join('\n'),
      openapi,
    );

    assert.deepEqual(problems.sort(), [
      'PATCH /api/sessions/$SESSION is not in openapi.json',
      'field bodyJson is not in openapi.json',
      'field contentType is not in openapi.json',
      'field sessionId is not in openapi.json',
      'path /api/sessions/{sessionId}/wait is not in openapi.json',
    ]);
  });

  it('accepts what the description has, and leaves a webhook body alone', () => {
    assert.deepEqual(
      unknownApiTerms(
        [
          'curl -X POST "https://qa-tools.ru/s/$SESSION/" \\',
          `  -d '{"event":"order.paid"}'`,
          'Change it with `PUT /api/sessions/{sessionId}/response` and `{"mode":"default"}`.',
        ].join('\n'),
        openapi,
      ),
      [],
    );
  });
});

describe('llms-full.txt', () => {
  // Built for production, as the sources it is compared with are written
  // (D274), so that the origins the shell running the tests holds change
  // nothing here (#342).
  const full = buildLlmsFiles(PRODUCTION_ORIGINS)['llms-full.txt'];

  it('carries the agent section, info.description byte for byte, and the endpoint list', () => {
    assert.ok(full.includes(agentSection.trimEnd()), 'the agent section is missing');
    assert.ok(full.includes(openapi.info.description), 'info.description is not copied verbatim');
    assert.ok(full.includes(endpointList(openapi)), 'the endpoint list is missing');
    assert.ok(full.indexOf(agentSection.trimEnd()) < full.indexOf(openapi.info.description));
  });

  it('lists every operation of openapi.json with its method, path and summary', () => {
    const list = endpointList(openapi).split('\n');
    let operations = 0;

    for (const [path, item] of Object.entries(openapi.paths)) {
      const servers = (item as { servers?: { url: string }[] }).servers;
      const host = servers ? ` (on ${servers[0]?.url})` : '';

      for (const [method, operation] of Object.entries(item)) {
        if (METHODS.includes(method.toUpperCase())) {
          const { summary } = operation as { summary: string };

          operations += 1;
          assert.ok(
            list.includes(`- \`${method.toUpperCase()} ${path}\` — ${summary}${host}`),
            `${method.toUpperCase()} ${path} is not listed`,
          );
        }
      }
    }

    assert.equal(list.length, operations);
    assert.ok(list.includes('- `GET /api/sessions/{sessionId}/requests` — List captured requests'));
  });

  it('names the webhook host for every webhook operation, and no host for the rest (D187)', () => {
    // The description as it is written, for production, and as the build
    // renames it for another address (D274); neither is the shell's (#342).
    const another = {
      app: 'https://inspector.example',
      receive: 'https://hook.inspector.example',
      alias: null,
    };

    for (const [description, receive] of [
      [openapi, PRODUCTION_ORIGINS.receive],
      [JSON.parse(openApiText(another)) as OpenApiDescription, another.receive],
    ] as const) {
      const list = endpointList(description).split('\n');
      const webhook = list.filter((line) => line.includes(' /s/{sessionId}`'));

      assert.equal(webhook.length, 8, receive);

      for (const line of webhook) {
        assert.ok(line.endsWith(` (on ${receive})`), line);
      }

      for (const line of list.filter((line) => !webhook.includes(line))) {
        assert.doesNotMatch(line, /\(on /, line);
      }
    }
  });

  it('sends webhooks to the webhook host in every hand-written text and in the description (D187)', () => {
    for (const [name, text] of [
      ['llms/llms.txt', llmsTxt],
      ['llms/agent-section.md', agentSection],
      ['info.description', openapi.info.description],
    ] as const) {
      assert.match(text, /https:\/\/hook\.qa-tools\.ru\/s\//, name);
      assert.doesNotMatch(text, /curl[^\n]*https:\/\/qa-tools\.ru\/s\//, name);
    }
  });

  it('follows the description: a changed description changes the file', () => {
    const changed = {
      ...openapi,
      info: { ...openapi.info, description: 'A changed introduction.\n\n## Anything' },
      paths: { ...openapi.paths, '/api/new': { get: { summary: 'A new operation' } } },
    };
    const regenerated = llmsFull({ openapi: changed, agentSection });

    assert.ok(regenerated.includes('A changed introduction.\n\n## Anything'));
    assert.ok(!regenerated.includes(openapi.info.description));
    assert.ok(regenerated.includes('- `GET /api/new` — A new operation'));
  });

  it('links its endpoint heading from the agent section', () => {
    assert.match(agentSection, /\]\(#endpoints\)/);
    assert.match(full, /^## Endpoints$/m);
  });
});

/** One exact location block of nginx.conf, comments and blank lines removed. */
function location(target: string): string {
  const config = read('../../nginx.conf');
  const escaped = target.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const block = new RegExp(`^\\s*location = ${escaped} \\{\\n([\\s\\S]*?)^\\s*\\}$`, 'm').exec(
    config,
  )?.[1];

  assert.ok(block !== undefined, `nginx.conf has no exact location for ${target}`);

  return block
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

describe('the /llms.txt and /llms-full.txt locations in nginx.conf', () => {
  for (const address of ['/llms.txt', '/llms-full.txt']) {
    it(`serves ${address} as UTF-8 Markdown, revalidated, never the application shell`, () => {
      assert.equal(
        location(address),
        [
          'types { }',
          'default_type text/markdown;',
          'charset utf-8;',
          'charset_types text/markdown;',
          "add_header Cache-Control 'no-cache' always;",
          'try_files $uri =404;',
        ].join('\n'),
      );
    });
  }

  it('leaves every other unknown address to the application’s not-found page', () => {
    assert.match(
      read('../../nginx.conf'),
      /location \/ \{\n\s*try_files \$uri =404;\n\s*error_page 404 \/index\.html;\n\s*\}/,
    );
  });
});

describe('discovery from the application page', () => {
  const html = read('../../index.html');

  it('announces llms.txt in the head', () => {
    assert.match(
      html,
      /<head>[\s\S]*<link rel="alternate" type="text\/markdown" href="\/llms\.txt" \/>[\s\S]*<\/head>/,
    );
  });

  it('points a reader without JavaScript at it, and shows nothing with JavaScript on', () => {
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1];

    assert.ok(noscript !== undefined, 'index.html has no <noscript>');
    assert.match(noscript, /href="\/llms\.txt"/);
    // Outside <noscript> and the React root, the body holds only the script.
    const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
    const rest = body
      .replace(/<noscript>[\s\S]*?<\/noscript>/, '')
      .replace('<div id="root"></div>', '')
      .replace(/<script[^>]*><\/script>/, '')
      .trim();

    assert.equal(rest, '');
  });
});

describe('the frontend image', () => {
  it('builds from a context that keeps the sources of the agent documentation', () => {
    const ignored = read('../../../../.dockerignore')
      .split('\n')
      .map((line) => line.trim());

    for (const pattern of [
      '**/*.md',
      '**/*.txt',
      '*.txt',
      'apps/frontend/llms',
      'apps/frontend/scripts',
      'packages/shared/openapi.json',
    ]) {
      assert.ok(!ignored.includes(pattern), `.dockerignore excludes ${pattern}`);
    }
  });
});
