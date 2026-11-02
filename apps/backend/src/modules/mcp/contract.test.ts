/**
 * The MCP server's published contract, `packages/shared/src/mcp.ts` (D203),
 * against what it restates: the tools' schemas compile as strict JSON Schema
 * under both draft-07 and 2020-12, which MCP clients validate with, and
 * accept what the server answers; `response` takes every response the API
 * takes, its own answers included; the descriptions name every reserved header
 * and the limits the backend enforces; and the server names the service.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import AjvModule from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import {
  LOCATION_STATUS_MAX,
  LOCATION_STATUS_MIN,
  LOCATION_TARGET_PREFIX,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_DELAY_MS,
  MAX_RESPONSE_HEADERS,
  REQUEST_LIST_MAX_WAIT_SECONDS,
  RESERVED_RESPONSE_HEADERS,
  RESERVED_RESPONSE_HEADER_PREFIX,
  SESSION_IDLE_WINDOW_MAX_SECONDS,
  SESSION_IDLE_WINDOW_MIN_SECONDS,
  SESSION_LIFETIME_MAX_SECONDS,
  SESSION_LIFETIME_MIN_SECONDS,
} from '@webhook-inspector/shared';
import {
  MCP_INSTRUCTIONS,
  MCP_LIST_DEFAULT_LIMIT,
  MCP_LIST_MAX_LIMIT,
  MCP_TOOL_NAMES,
  mcpTools,
  MCP_UNTRUSTED_NOTICE,
} from '@webhook-inspector/shared/mcp';
import {
  parseExpiresAfterIdleSeconds,
  parseExpiresInSeconds,
  parseResponse,
  parseResponseChange,
  parsePrivate,
  parseSessionExpiry,
  parseStoreSourceIp,
} from '../sessions/response-config.ts';
import { agentBody, capturedResult } from './captured.ts';

/** The tools as a server whose receive host is this one lists them (D274). */
const MCP_TOOLS = mcpTools('https://hook.qa-tools.example');

// CommonJS packages: the default import is `module.exports`.
const Ajv = AjvModule.default;
const Ajv2020 = Ajv2020Module.default;

type Validate = (data: unknown) => boolean;

function inputSchema(name: string): Record<string, unknown> {
  const tool = MCP_TOOLS.find((entry) => entry.name === name);

  assert.ok(tool, name);

  return tool.inputSchema as Record<string, unknown>;
}

/** The two tools' input schemas, compiled as clients compile them, under both dialects. */
function responseInputs(): { label: string; validate: Validate }[] {
  return [new Ajv({ strict: true }), new Ajv2020({ strict: true })].flatMap((ajv, index) => {
    const dialect = index === 0 ? 'draft-07' : '2020-12';
    const create = ajv.compile(inputSchema('create_session'));
    const set = ajv.compile(inputSchema('set_response'));

    return [
      {
        label: `create_session ${dialect}`,
        validate: (response: unknown) => create({ response }),
      },
      {
        label: `set_response ${dialect}`,
        validate: (response: unknown) => set({ sessionId: 'x', mode: 'custom', response }),
      },
    ];
  });
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const spec = JSON.parse(
  readFileSync(new URL('../../../../../packages/shared/openapi.json', import.meta.url), 'utf8'),
) as { components: { schemas: Record<string, Json> } };

/** A component of `openapi.json` with its local references written out in place. */
function component(schema: Json): Json {
  if (Array.isArray(schema)) {
    return schema.map(component);
  }

  if (schema === null || typeof schema !== 'object') {
    return schema;
  }

  const target = schema.$ref;

  if (typeof target === 'string') {
    const name = target.replace('#/components/schemas/', '');

    assert.ok(name in spec.components.schemas, target);

    return component(spec.components.schemas[name] as Json);
  }

  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, component(value)]));
}

/** Whether the API's own validator takes the value as a `response`. */
function apiTakes(response: unknown): boolean {
  try {
    parseResponse(response);

    return true;
  } catch {
    return false;
  }
}

const PAIRS = Array.from({ length: MAX_RESPONSE_HEADERS }, (_, index): [string, string] => [
  `X-H${index}`,
  'v',
]);

/** Responses the API takes, each field at an edge of what it takes. */
const TAKEN: unknown[] = [
  { status: 204, body: null },
  { status: 205, body: null },
  { status: 304, body: null },
  { status: 200, body: null },
  { status: 204, body: '' },
  { status: 204, headers: [], body: null, delayMs: 0 },
  { status: 200 },
  { status: 299, body: 'OK' },
  { status: 599, body: '{"broken":', delayMs: MAX_RESPONSE_DELAY_MS },
  { status: 200, body: 'a'.repeat(MAX_RESPONSE_BODY_BYTES) },
  { status: 200, body: '\\u0000' },
  { status: 200, headers: [] },
  { status: 200, headers: PAIRS },
  {
    status: 201,
    headers: [
      ['X-Dup', 'a'],
      ['x-dup', ''],
      ['Content-Type', 'text/plain;\tq=1'],
    ],
    body: 'x',
    delayMs: 0,
  },
  // A redirect's target, twice, which the API takes since D247.
  {
    status: 302,
    headers: [
      ['Location', '/s/x/after'],
      ['location', '/s/x/again'],
    ],
  },
  // A template, and braces of any kind without the opt-in (D251).
  { status: 200, body: '{"id":"{{request.id}}","n":{{request.body.n}}}', template: true },
  { status: 200, body: '{{ not a placeholder', template: false },
  { status: 204, body: null, template: true },
];

/** Responses the API refuses for their shape, which a schema can say. */
const SHAPE_REFUSED: unknown[] = [
  null,
  [],
  'x',
  {},
  { status: null },
  { status: '200' },
  { status: 200.5 },
  { status: 199 },
  { status: 600 },
  { status: 200, body: 5 },
  { status: 200, body: { received: true } },
  { status: 200, body: ['x'] },
  { status: 200, body: false },
  { status: 200, headers: null },
  { status: 200, headers: { a: 'b' } },
  { status: 200, headers: [['a']] },
  { status: 200, headers: [['a', 'b', 'c']] },
  { status: 200, headers: [['a', 1]] },
  { status: 200, headers: [...PAIRS, ['X-One', 'more']] },
  { status: 200, delayMs: null },
  { status: 200, delayMs: -1 },
  { status: 200, delayMs: 1.5 },
  { status: 200, delayMs: MAX_RESPONSE_DELAY_MS + 1 },
  { status: 200, extra: 1 },
  { status: 200, template: null },
  { status: 200, template: 'true' },
  { status: 200, template: 1 },
];

/**
 * Templates the API refuses for what their body holds (D251), which no
 * schema says: the tools' schemas and openapi.json take them, and the server
 * answers each `1005`, by the very function the API runs.
 */
const TEMPLATE_REFUSED: unknown[] = [
  { status: 200, body: '{{request.ip}}', template: true },
  { status: 200, body: '{{request.id', template: true },
  { status: 200, body: '{{ request.id }}', template: true },
  { status: 200, body: '{{request.body.a..b}}', template: true },
  { status: 200, body: '{{request.header.a b}}', template: true },
];

describe('the tools as tools/list gives them (D203)', () => {
  it('are the seven, each once, with a name MCP clients accept', () => {
    assert.deepEqual(
      MCP_TOOLS.map((tool) => tool.name),
      [...MCP_TOOL_NAMES],
    );

    for (const tool of MCP_TOOLS) {
      assert.match(tool.name, /^[a-z_]{1,64}$/);
      assert.ok(tool.title.length > 0 && tool.description.length > 0);
    }
  });

  it('name the service, Webhook Inspector, in the instructions and in create_session (D278)', () => {
    const createSession = MCP_TOOLS.find(({ name }) => name === 'create_session');

    assert.ok(
      MCP_INSTRUCTIONS.startsWith(
        'Webhook Inspector gives you temporary webhook URLs with no account. ',
      ),
      MCP_INSTRUCTIONS,
    );
    assert.ok(
      createSession?.description.startsWith(
        'Create a temporary webhook session on Webhook Inspector; no account is needed. ',
      ),
      createSession?.description,
    );
  });

  it('have schemas that compile strictly under draft-07 and 2020-12, with no $schema', () => {
    for (const ajv of [new Ajv({ strict: true }), new Ajv2020({ strict: true })]) {
      for (const tool of MCP_TOOLS) {
        assert.equal(tool.inputSchema.$schema, undefined);
        assert.doesNotThrow(() => ajv.compile(tool.inputSchema), `${tool.name} input`);
        assert.doesNotThrow(() => ajv.compile(tool.outputSchema), `${tool.name} output`);
      }
    }
  });

  it('describe what the captured answers are, the empty list and a cut body included', () => {
    const ajv = new Ajv({ strict: true });
    const listOutput = ajv.compile(
      MCP_TOOLS.find((tool) => tool.name === 'list_requests')?.outputSchema ?? {},
    );
    const getOutput = ajv.compile(
      MCP_TOOLS.find((tool) => tool.name === 'get_request')?.outputSchema ?? {},
    );
    const body = agentBody({
      bodySize: 70_000,
      isBinary: false,
      body: 'a'.repeat(70_000),
      bodyBase64: null,
    });

    assert.ok(listOutput(capturedResult({ requests: [] }).structuredContent));
    assert.ok(
      getOutput(
        capturedResult({
          id: 'x',
          method: 'POST',
          receivedAt: '2026-10-05T00:00:00.000Z',
          sourceIp: null,
          httpVersion: '1.1',
          bodySize: 70_000,
          bodyEncoding: body.bodyEncoding,
          truncated: body.truncated,
          response: null,
          inspectorUrl: 'https://qa-tools.ru/v/x#x',
          untrustedCapturedContent: { path: null, queryString: '', headers: [], body: body.body },
        }).structuredContent,
      ),
      JSON.stringify(getOutput.errors),
    );
    assert.equal(capturedResult({}).structuredContent?.notice, MCP_UNTRUSTED_NOTICE);
  });

  it('name every reserved header in set_response, and the limits the backend enforces', () => {
    const setResponse = MCP_TOOLS.find((tool) => tool.name === 'set_response')?.description ?? '';
    const named =
      /Reserved header names are refused, whatever their case: ([^.]*), and any name beginning with ([^ ]+)\./.exec(
        setResponse,
      );

    assert.ok(named, 'set_response does not list the reserved names');
    assert.deepEqual(
      (named[1] as string).split(', ').map((name) => name.toLowerCase()),
      RESERVED_RESPONSE_HEADERS,
    );
    assert.equal((named[2] as string).toLowerCase(), RESERVED_RESPONSE_HEADER_PREFIX);
    // Location left the list for a rule of its own, which the description states
    // from the same constants the validator reads (D247).
    assert.ok(
      setResponse.includes(
        `Location is allowed only with a status from ${LOCATION_STATUS_MIN} to ${LOCATION_STATUS_MAX} and a value beginning with ${LOCATION_TARGET_PREFIX},`,
      ),
      'set_response does not state the Location rule',
    );

    const wait = MCP_TOOLS.find((tool) => tool.name === 'wait_for_request');

    assert.deepEqual((wait?.inputSchema.properties as { wait: unknown }).wait, {
      type: 'integer',
      minimum: 1,
      maximum: REQUEST_LIST_MAX_WAIT_SECONDS,
      description: `Seconds to wait, 1 to ${REQUEST_LIST_MAX_WAIT_SECONDS}; ${REQUEST_LIST_MAX_WAIT_SECONDS} by default.`,
    });
    assert.equal(MCP_LIST_DEFAULT_LIMIT, 20);
    assert.equal(MCP_LIST_MAX_LIMIT, 100);
  });
});

describe('response in create_session and set_response, against the API (D203)', () => {
  const openapi = new Ajv2020({ strict: false }).compile(
    component(spec.components.schemas.ResponseConfigInput as Json) as Record<string, unknown>,
  );

  it('takes every response the API and openapi.json take, body null on 204, 205 and 304 among them', () => {
    for (const response of TAKEN) {
      const label = JSON.stringify(response).slice(0, 80);

      assert.ok(apiTakes(response), `the API refuses ${label}`);
      assert.ok(openapi(response), `openapi.json refuses ${label}`);

      for (const input of responseInputs()) {
        assert.ok(input.validate(response), `${input.label} refuses ${label}`);
      }
    }
  });

  it('takes back every response it answers: the API’s effective value, body null included', () => {
    for (const response of TAKEN) {
      const answered = parseResponse(response);

      for (const input of responseInputs()) {
        assert.ok(input.validate(answered), `${input.label} refuses ${JSON.stringify(answered)}`);
      }
    }

    assert.deepEqual(parseResponse({ status: 204 }), {
      status: 204,
      headers: [],
      body: null,
      delayMs: 0,
      template: false,
    });
  });

  it('refuses what the API and openapi.json refuse for its shape, a body that is no string or null included', () => {
    for (const response of SHAPE_REFUSED) {
      const label = JSON.stringify(response).slice(0, 80);

      assert.equal(apiTakes(response), false, `the API takes ${label}`);
      assert.equal(openapi(response), false, `openapi.json takes ${label}`);

      for (const input of responseInputs()) {
        assert.equal(input.validate(response), false, `${input.label} takes ${label}`);
      }
    }
  });

  it('leaves to the API a template whose placeholders break the grammar, which it refuses', () => {
    for (const response of TEMPLATE_REFUSED) {
      const label = JSON.stringify(response);

      assert.equal(apiTakes(response), false, `the API takes ${label}`);
      assert.ok(openapi(response), `openapi.json refuses ${label}`);

      for (const input of responseInputs()) {
        assert.ok(input.validate(response), `${input.label} refuses ${label}`);
      }
    }
  });

  it('declares each field of response with the type and bounds openapi.json gives it', () => {
    const published = spec.components.schemas.ResponseConfigInput as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };

    for (const name of ['create_session', 'set_response']) {
      const response = (inputSchema(name).properties as Record<string, unknown>).response as {
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, Record<string, unknown>>;
      };

      assert.deepEqual(response.required, published.required, name);
      assert.equal(response.additionalProperties, published.additionalProperties, name);
      assert.deepEqual(
        Object.keys(response.properties).sort(),
        Object.keys(published.properties).sort(),
        name,
      );

      for (const [field, schema] of Object.entries(response.properties)) {
        const expected = published.properties[field] ?? {};

        for (const keyword of ['type', 'minimum', 'maximum', 'maxItems']) {
          assert.deepEqual(schema[keyword], expected[keyword], `${name} ${field}.${keyword}`);
        }
      }
    }
  });

  it('takes mode as the API does: "custom" with a response, "default" alone', () => {
    const set = new Ajv({ strict: true }).compile(inputSchema('set_response'));

    for (const change of [
      { mode: 'custom', response: { status: 204, body: null } },
      { mode: 'custom', response: { status: 200 } },
      { mode: 'default' },
    ]) {
      assert.doesNotThrow(() => parseResponseChange(change), JSON.stringify(change));
      assert.ok(set({ sessionId: 'x', ...change }), JSON.stringify(set.errors));
    }

    assert.equal(set({ sessionId: 'x', mode: 'other' }), false);
    assert.throws(() => parseResponseChange({ mode: 'other' }));
  });
});

describe('expiresInSeconds in create_session, against the API (D220)', () => {
  it('declares the type and bounds openapi.json gives it, from the shared constants', () => {
    const published = (
      spec.components.schemas.CreateSessionRequest as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties.expiresInSeconds;
    const declared = (inputSchema('create_session').properties as Record<string, unknown>)
      .expiresInSeconds as Record<string, unknown>;

    assert.ok(published, 'openapi.json does not describe expiresInSeconds');

    for (const keyword of ['type', 'minimum', 'maximum']) {
      assert.deepEqual(declared[keyword], published[keyword], keyword);
    }

    assert.deepEqual(
      [declared.type, declared.minimum, declared.maximum],
      ['integer', SESSION_LIFETIME_MIN_SECONDS, SESSION_LIFETIME_MAX_SECONDS],
    );
  });

  it('takes what the API takes and refuses what it refuses, under both dialects', () => {
    const openapi = new Ajv2020({ strict: false }).compile(
      component(spec.components.schemas.CreateSessionRequest as Json) as Record<string, unknown>,
    );
    const inputs = [new Ajv({ strict: true }), new Ajv2020({ strict: true })].map((ajv) =>
      ajv.compile(inputSchema('create_session')),
    );
    const apiTakesLifetime = (value: unknown) => {
      try {
        parseExpiresInSeconds(value);

        return true;
      } catch {
        return false;
      }
    };

    for (const value of [60, 600, 604_800, 6e2]) {
      assert.ok(apiTakesLifetime(value), String(value));
      assert.ok(openapi({ expiresInSeconds: value }), String(value));

      for (const input of inputs) {
        assert.ok(input({ expiresInSeconds: value }), String(value));
      }
    }

    for (const value of [59, 604_801, 600.5, '600', null, true, [600], {}]) {
      assert.equal(apiTakesLifetime(value), false, JSON.stringify(value));
      assert.equal(openapi({ expiresInSeconds: value }), false, JSON.stringify(value));

      for (const input of inputs) {
        assert.equal(input({ expiresInSeconds: value }), false, JSON.stringify(value));
      }
    }
  });
});

describe('expiresAfterIdleSeconds in create_session, against the API (D242)', () => {
  it('declares the type and bounds openapi.json gives it, from the shared constants', () => {
    const published = (
      spec.components.schemas.CreateSessionRequest as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties.expiresAfterIdleSeconds;
    const declared = (inputSchema('create_session').properties as Record<string, unknown>)
      .expiresAfterIdleSeconds as Record<string, unknown>;

    assert.ok(published, 'openapi.json does not describe expiresAfterIdleSeconds');

    for (const keyword of ['type', 'minimum', 'maximum']) {
      assert.deepEqual(declared[keyword], published[keyword], keyword);
    }

    assert.deepEqual(
      [declared.type, declared.minimum, declared.maximum],
      ['integer', SESSION_IDLE_WINDOW_MIN_SECONDS, SESSION_IDLE_WINDOW_MAX_SECONDS],
    );
  });

  it('takes what the API takes and refuses what it refuses, under both dialects', () => {
    const openapi = new Ajv2020({ strict: false }).compile(
      component(spec.components.schemas.CreateSessionRequest as Json) as Record<string, unknown>,
    );
    const inputs = [new Ajv({ strict: true }), new Ajv2020({ strict: true })].map((ajv) =>
      ajv.compile(inputSchema('create_session')),
    );
    const apiTakesWindow = (value: unknown) => {
      try {
        parseExpiresAfterIdleSeconds(value);

        return true;
      } catch {
        return false;
      }
    };

    for (const value of [3600, 86_400, 604_800, 36e2]) {
      assert.ok(apiTakesWindow(value), String(value));
      assert.ok(openapi({ expiresAfterIdleSeconds: value }), String(value));

      for (const input of inputs) {
        assert.ok(input({ expiresAfterIdleSeconds: value }), String(value));
      }
    }

    for (const value of [3599, 604_801, 60, 3600.5, '3600', null, true, [3600], {}]) {
      assert.equal(apiTakesWindow(value), false, JSON.stringify(value));
      assert.equal(openapi({ expiresAfterIdleSeconds: value }), false, JSON.stringify(value));

      for (const input of inputs) {
        assert.equal(input({ expiresAfterIdleSeconds: value }), false, JSON.stringify(value));
      }
    }
  });

  it('leaves the two keys together to the API, which refuses them, as both descriptions say', () => {
    const both = { expiresInSeconds: 600, expiresAfterIdleSeconds: 3600 };

    assert.throws(() => parseSessionExpiry(both), /cannot be given together/);

    const published = spec.components.schemas.CreateSessionRequest as {
      description: string;
      properties: Record<string, { description: string }>;
    };
    const tool = MCP_TOOLS.find(({ name }) => name === 'create_session');
    const declared = tool?.inputSchema.properties as Record<string, { description: string }>;

    assert.match(
      published.description,
      /`expiresInSeconds` and `expiresAfterIdleSeconds` together/,
    );
    assert.match(
      declared.expiresAfterIdleSeconds?.description ?? '',
      /Not together with expiresInSeconds/,
    );
    assert.match(tool?.description ?? '', /not both/);
  });
});

describe('storeSourceIp in create_session, against the API (D243)', () => {
  it('declares the type openapi.json gives it, and both read back as GET gives it', () => {
    const published = (
      spec.components.schemas.CreateSessionRequest as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties.storeSourceIp;
    const declared = (inputSchema('create_session').properties as Record<string, unknown>)
      .storeSourceIp as Record<string, unknown>;

    assert.ok(published, 'openapi.json does not describe storeSourceIp');
    assert.equal(declared.type, published.type);
    assert.equal(declared.type, 'boolean');

    const details = spec.components.schemas.SessionDetails as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };

    assert.ok(details.required.includes('storeSourceIp'));
    assert.equal(details.properties.storeSourceIp?.type, 'boolean');
  });

  it('takes what the API takes and refuses what it refuses, under both dialects', () => {
    const openapi = new Ajv2020({ strict: false }).compile(
      component(spec.components.schemas.CreateSessionRequest as Json) as Record<string, unknown>,
    );
    const inputs = [new Ajv({ strict: true }), new Ajv2020({ strict: true })].map((ajv) =>
      ajv.compile(inputSchema('create_session')),
    );
    const apiTakes = (value: unknown) => {
      try {
        parseStoreSourceIp(value);

        return true;
      } catch {
        return false;
      }
    };

    for (const value of [true, false]) {
      assert.ok(apiTakes(value), String(value));
      assert.ok(openapi({ storeSourceIp: value }), String(value));

      for (const input of inputs) {
        assert.ok(input({ storeSourceIp: value }), String(value));
      }
    }

    for (const value of ['false', 'true', '', 0, 1, null, [], [false], {}, { value: false }]) {
      assert.equal(apiTakes(value), false, JSON.stringify(value));
      assert.equal(openapi({ storeSourceIp: value }), false, JSON.stringify(value));

      for (const input of inputs) {
        assert.equal(input({ storeSourceIp: value }), false, JSON.stringify(value));
      }
    }
  });

  it('says in both descriptions that the headers are kept as sent', () => {
    const published = spec.components.schemas.CreateSessionRequest as {
      properties: Record<string, { description: string }>;
    };
    const tool = MCP_TOOLS.find(({ name }) => name === 'create_session');
    const declared = tool?.inputSchema.properties as Record<string, { description: string }>;

    assert.match(published.properties.storeSourceIp?.description ?? '', /kept as sent/);
    assert.match(declared.storeSourceIp?.description ?? '', /kept as sent/);
    assert.match(
      tool?.description ?? '',
      /With storeSourceIp false, the session stores no sender IP address/,
    );
  });
});

describe('private in create_session, against the API (D253)', () => {
  it('declares the type openapi.json gives it, and GET reads it back as a boolean', () => {
    const published = (
      spec.components.schemas.CreateSessionRequest as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties.private;
    const declared = (inputSchema('create_session').properties as Record<string, unknown>)
      .private as Record<string, unknown>;

    assert.ok(published, 'openapi.json does not describe private');
    assert.equal(declared.type, published.type);
    assert.equal(declared.type, 'boolean');

    const details = spec.components.schemas.SessionDetails as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };

    assert.ok(details.required.includes('private'));
    assert.equal(details.properties.private?.type, 'boolean');
  });

  it('takes what the API takes and refuses what it refuses, under both dialects', () => {
    const openapi = new Ajv2020({ strict: false }).compile(
      component(spec.components.schemas.CreateSessionRequest as Json) as Record<string, unknown>,
    );
    const inputs = [new Ajv({ strict: true }), new Ajv2020({ strict: true })].map((ajv) =>
      ajv.compile(inputSchema('create_session')),
    );
    const apiTakes = (value: unknown) => {
      try {
        parsePrivate(value);

        return true;
      } catch {
        return false;
      }
    };

    for (const value of [true, false]) {
      assert.ok(apiTakes(value), String(value));
      assert.ok(openapi({ private: value }), String(value));

      for (const input of inputs) {
        assert.ok(input({ private: value }), String(value));
      }
    }

    for (const value of ['true', 'false', '', 0, 1, null, [], [true], {}, { private: true }]) {
      assert.equal(apiTakes(value), false, JSON.stringify(value));
      assert.equal(openapi({ private: value }), false, JSON.stringify(value));

      for (const input of inputs) {
        assert.equal(input({ private: value }), false, JSON.stringify(value));
      }
    }
  });

  it('says in both descriptions where the key travels, and that the inspector link carries none and opens once the key is given (#228, #256)', () => {
    const published = spec.components.schemas.CreateSessionRequest as {
      properties: Record<string, { description: string }>;
    };
    const tool = MCP_TOOLS.find(({ name }) => name === 'create_session');
    const declared = tool?.inputSchema.properties as Record<string, { description: string }>;
    const description = declared.private?.description ?? '';

    assert.match(published.properties.private?.description ?? '', /Authorization: Bearer/);
    assert.match(description, /Authorization: Bearer/);
    // Since 1.15.0 the interface opens a private session once its key is
    // given on Session not found (D259); the link itself still carries none.
    assert.ok(
      description.endsWith(
        ' The inspectorUrl carries no key: in a browser without the key it shows Session not found, where the key opens the session.',
      ),
      description,
    );
    assert.ok(
      !description.includes('until the QA Tools interface supports private sessions'),
      'the stale sentence is back',
    );
  });
});
