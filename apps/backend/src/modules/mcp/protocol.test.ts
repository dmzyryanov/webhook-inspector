/**
 * The transport checks of `/mcp` without a server (D203): the JSON-RPC
 * message a body holds, the `Origin` that may call, what `Accept` must allow,
 * the query string a URL may not carry, and the protocol versions. Each is
 * also given made-up input built to break it, at 1 KiB, 64 KiB and 1 MiB, and
 * must answer within the bound of its kind - the fastest of up to five runs,
 * so that the machine's load does not decide it (`withinBound`) - and never
 * let in what it should refuse. And `ownCopy`, which must give back every
 * code unit of whatever it is given.
 *
 * Each bound is near its checks' own cost, so that a reading of them worse
 * than linear is over it on every run, with room for the load of the full
 * backend suite beside eight busy processes on the agents' server. The
 * measurements, alone and under that load, and the quadratic readings each
 * bound catches and those it gives up, are in `docs/testing/flakes.md`, F-24.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MCP_REQUEST_ID_MAX_LENGTH } from '@webhook-inspector/shared/mcp';
import { withinBound } from '../../testing/timing.ts';
import {
  acceptsJson,
  declaredProtocolVersion,
  hasQueryString,
  isAllowedOrigin,
  isCreateSessionCall,
  negotiateProtocolVersion,
  ownCopy,
  parseMessage,
  rawHeaderValues,
  rpcError,
  RpcErrorCode,
  rpcResult,
} from './protocol.ts';

const APP_ORIGIN = 'https://qa-tools.ru';
const ALIAS_ORIGIN = 'https://webhook.qa-tools.ru';

/** 1 KiB, 64 KiB and 1 MiB. */
const SIZES = [1024, 64 * 1024, 1024 * 1024];

/**
 * Milliseconds `parseMessage` may take on one made-up body: 1000, above the
 * 500 of most of the suite's hostile input, as the slowest body - 1 MiB of
 * `[`, a level of nesting a byte for V8's own JSON.parse - takes 60 to 84 ms
 * alone and up to 269 ms under that load; two loaded suite runs took it to
 * 109 and 154 ms, over the 100 ms of before #363. A quadratic reading of the
 * same body, each `[` searched to the end for its `]` with V8's own
 * `indexOf`, takes 7.6 to 7.8 s: over the bound on every run. One search per
 * 41-byte element of the batch body takes 178 to 213 ms: under it, given up.
 */
const BODIES_BOUND_MS = 1000;

/**
 * Milliseconds `acceptsJson` may take on one made-up `Accept` value of one
 * character repeated, or of one range with a parameter every four characters:
 * 500, the suite's usual, as the slowest of them - 1 MiB of commas, a million
 * empty ranges, a string for each - takes 37 to 66 ms alone and up to 165 ms
 * under that load, and one round's slowest `Accept` value, not named, read
 * 249 ms. A reading that searches the rest of the value once per parameter
 * takes 1.9 s, and once per byte 8 s: over the bound on every run.
 */
const ACCEPT_BOUND_MS = 500;

/**
 * Milliseconds `acceptsJson` may take on one made-up list of whole media
 * ranges, of 10 to 21 characters each: 200, as the slowest of them, ranges of
 * 21 characters, takes 16 to 21 ms alone and under that load up to 78 ms in
 * 500 rounds, but 132 ms in one of 40 rounds of #377's tester: 1.5 times
 * under the bound. A reading that searches the rest of the list once per
 * range takes 364 ms on ranges of 21 characters, 480 ms on ranges of 16 and
 * 753 ms on ranges of 10: over the bound on every run.
 */
const ACCEPT_RANGES_BOUND_MS = 200;

/**
 * Milliseconds every other check of a made-up value may take - an id, a
 * copy, an `Origin`, a URL, a protocol version - each value built before it
 * is timed: 50, as the slowest of them alone, `parseMessage` on a body whose
 * id is 1 MiB of emoji, takes 3.5 to 6.6 ms, and the ids under that load up
 * to 24 ms in 879 rounds and 27 ms in one of 80 rounds of #377's tester: 1.9
 * times under the bound. `ownCopy` takes up to 4.3 ms alone and 16 ms under
 * that load, and the rest under 0.2 ms. The cheapest quadratic reading of
 * them measured, one search of the rest of 16,384 `Origin` headers per
 * header, takes 147 ms; one per origin repeated in a 1 MiB value 280 ms, and
 * once per byte of 1 MiB 8 s: over the bound on every run.
 */
const BOUND_MS = 50;

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/** `text` repeated to exactly `size` characters. */
function fill(text: string, size: number): string {
  return text.repeat(Math.ceil(size / text.length)).slice(0, size);
}

describe('the JSON-RPC message a body holds', () => {
  it('reads a request, with its id, method and the params the server reads', () => {
    assert.deepEqual(
      parseMessage(json({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { cursor: 'x' } })),
      { kind: 'request', id: 7, method: 'tools/list', params: {} },
    );
    assert.deepEqual(parseMessage(json({ jsonrpc: '2.0', id: 'a-1', method: 'ping' })), {
      kind: 'request',
      id: 'a-1',
      method: 'ping',
      params: {},
    });
  });

  it('keeps of params only name and arguments of tools/call and protocolVersion of initialize', () => {
    const args = { sessionId: 'z'.repeat(43), wait: 30 };
    const request = (method: string, params: Record<string, unknown>) =>
      parseMessage(json({ jsonrpc: '2.0', id: 1, method, params }));

    assert.deepEqual(
      request('tools/call', {
        name: 'wait_for_request',
        arguments: args,
        _meta: { progressToken: 'p'.repeat(1000) },
        unread: 'u'.repeat(1000),
      }),
      {
        kind: 'request',
        id: 1,
        method: 'tools/call',
        params: { name: 'wait_for_request', arguments: args },
      },
    );
    assert.deepEqual(request('tools/call', { _meta: {} }), {
      kind: 'request',
      id: 1,
      method: 'tools/call',
      params: {},
    });
    assert.deepEqual(
      request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'client', version: '1.0.0' },
        name: 'create_session',
        arguments: {},
      }),
      { kind: 'request', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    );

    for (const method of ['ping', 'tools/list', 'constructor', '__proto__', 'hasOwnProperty']) {
      assert.deepEqual(
        request(method, { name: 'create_session', arguments: {}, protocolVersion: '2025-11-25' }),
        { kind: 'request', id: 1, method, params: {} },
        method,
      );
    }
  });

  it(`takes an id of up to ${MCP_REQUEST_ID_MAX_LENGTH} characters or an exact integer, and refuses any other`, () => {
    for (const id of [
      '',
      'a-1',
      'x'.repeat(MCP_REQUEST_ID_MAX_LENGTH),
      // Characters as JavaScript counts them: two for each of these.
      '😀'.repeat(MCP_REQUEST_ID_MAX_LENGTH / 2),
      // Lone surrogates, which JSON can carry escaped, kept as they came.
      '\ud800x\udfff',
      '\udc00'.repeat(MCP_REQUEST_ID_MAX_LENGTH),
      0,
      -1,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
    ]) {
      const parsed = parseMessage(json({ jsonrpc: '2.0', id, method: 'ping' }));

      assert.equal(parsed.kind, 'request', String(id));
      assert.equal(parsed.kind === 'request' && parsed.id, id);
    }

    for (const id of [
      'x'.repeat(MCP_REQUEST_ID_MAX_LENGTH + 1),
      `${'😀'.repeat(MCP_REQUEST_ID_MAX_LENGTH / 2)}x`,
      2 ** 53,
      -(2 ** 53),
      1.5,
      1e300,
      null,
      true,
      {},
      [],
    ]) {
      const parsed = parseMessage(
        json({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'create_session' } }),
      );

      assert.deepEqual(
        parsed,
        {
          kind: 'invalid',
          code: RpcErrorCode.INVALID_REQUEST,
          message:
            'Invalid Request: id must be a string of at most 256 characters or an integer from -9007199254740991 to 9007199254740991',
        },
        JSON.stringify(id),
      );
      assert.equal(isCreateSessionCall(parsed), false);
    }
  });

  it('reads a notification and a response', () => {
    assert.deepEqual(parseMessage(json({ jsonrpc: '2.0', method: 'notifications/initialized' })), {
      kind: 'notification',
      method: 'notifications/initialized',
    });
    assert.deepEqual(parseMessage(json({ jsonrpc: '2.0', id: 1, result: {} })), {
      kind: 'response',
    });
    assert.deepEqual(
      parseMessage(json({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'm' } })),
      { kind: 'response' },
    );
  });

  it('answers a parse error for no body, bytes that are not UTF-8 and text that is not JSON', () => {
    for (const body of [
      undefined,
      Buffer.alloc(0),
      Buffer.from([0x7b, 0xff, 0x7d]),
      Buffer.from('{"jsonrpc":"2.0",'),
      Buffer.from('﻿{"jsonrpc":"2.0","id":1,"method":"ping"}'),
    ]) {
      const parsed = parseMessage(body);

      assert.equal(parsed.kind, 'invalid');
      assert.equal(parsed.kind === 'invalid' && parsed.code, RpcErrorCode.PARSE_ERROR);
    }
  });

  it('refuses a batch, and anything that is not JSON-RPC 2.0, as an invalid request', () => {
    for (const value of [
      [],
      [{ jsonrpc: '2.0', id: 1, method: 'ping' }],
      null,
      1,
      'ping',
      {},
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      { id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1, method: 7 },
      { jsonrpc: '2.0', id: null, method: 'ping' },
      { jsonrpc: '2.0', id: 1.5, method: 'ping' },
      { jsonrpc: '2.0', id: 2 ** 53, method: 'ping' },
      { jsonrpc: '2.0', id: { a: 1 }, method: 'ping' },
      { jsonrpc: '2.0', id: 1, method: 'ping', params: [] },
      { jsonrpc: '2.0', id: 1, method: 'ping', params: 'x' },
      { jsonrpc: '2.0', method: 'n', params: null },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', result: {} },
    ]) {
      const parsed = parseMessage(json(value));

      assert.equal(parsed.kind, 'invalid', JSON.stringify(value));
      assert.equal(parsed.kind === 'invalid' && parsed.code, RpcErrorCode.INVALID_REQUEST);
    }
  });

  it('reads own keys only: a __proto__ key is an ordinary key and pollutes nothing', () => {
    const parsed = parseMessage(
      Buffer.from('{"jsonrpc":"2.0","__proto__":{"method":"ping","id":1}}', 'utf8'),
    );

    assert.equal(parsed.kind, 'invalid');
    assert.equal(({} as { method?: unknown }).method, undefined);

    const withParams = parseMessage(
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"__proto__":{"name":"create_session"}}}',
      ),
    );

    assert.equal(withParams.kind, 'request');
    assert.equal(isCreateSessionCall(withParams), false);
  });

  it('tells a create_session call from every other message', () => {
    const call = (name: unknown) =>
      parseMessage(json({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }));

    assert.equal(isCreateSessionCall(call('create_session')), true);
    assert.equal(isCreateSessionCall(call('delete_session')), false);
    assert.equal(isCreateSessionCall(call(['create_session'])), false);
    assert.equal(isCreateSessionCall(call('CREATE_SESSION')), false);
    assert.equal(
      isCreateSessionCall(
        parseMessage(
          json({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'create_session' } }),
        ),
      ),
      false,
    );
    assert.equal(isCreateSessionCall(null), false);
  });

  for (const size of SIZES) {
    it(`survives made-up bodies of ${size} bytes`, () => {
      const bodies = [
        Buffer.from(fill('[', size)),
        Buffer.from(fill('{"a":', size)),
        Buffer.from(fill('\\"', size)),
        Buffer.from(fill('\u0000', size)),
        Buffer.alloc(size, 0xff),
        Buffer.alloc(size, 0x80),
        Buffer.from(`{"jsonrpc":"2.0","id":"${fill('x', size)}","method":"ping"}`),
        Buffer.from(`{"jsonrpc":"2.0","id":1,"method":"${fill('m', size)}"}`),
        Buffer.from(`[${fill('{"jsonrpc":"2.0","id":1,"method":"ping"},', size)}{}]`),
        Buffer.from(
          `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${fill('create_session', size)}"}}`,
        ),
      ];

      for (const body of bodies) {
        const parsed = withinBound(BODIES_BOUND_MS, () => parseMessage(body));

        assert.ok(['invalid', 'request'].includes(parsed.kind));
        assert.equal(isCreateSessionCall(parsed), false);
      }
    });

    it(`refuses made-up ids of ${size} characters or digits as invalid requests within ${BOUND_MS} ms`, () => {
      const ids = [
        `"${fill('x', size)}"`,
        `"${fill('é', size)}"`,
        `"${'😀'.repeat(size / 2)}"`,
        `"${fill('\\\\', size)}"`,
        fill('9', size),
        `-${fill('1', size)}`,
        `0.${fill('5', size)}`,
        `1${fill('0', size)}`,
      ];

      for (const id of ids) {
        // Built before the bound, so that it holds `parseMessage` alone.
        const body = Buffer.from(
          `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"wait_for_request"}}`,
        );
        const parsed = withinBound(BOUND_MS, () => parseMessage(body));

        assert.equal(parsed.kind, 'invalid', id.slice(0, 16));
        assert.equal(parsed.kind === 'invalid' && parsed.code, RpcErrorCode.INVALID_REQUEST);
      }
    });
  }
});

describe('ownCopy (D203)', () => {
  it('gives back every UTF-16 code unit, lone surrogates, NUL and a byte-order mark included', () => {
    for (const value of [
      '',
      'a',
      'z'.repeat(43),
      '3f8a1b20-0000-4000-8000-000000000000',
      'я'.repeat(MCP_REQUEST_ID_MAX_LENGTH),
      '😀',
      '\ud800',
      '\udfff',
      'a\ud800b',
      '\udc00\ud800',
      '\u0000',
      '\ufeff\ufeff',
    ]) {
      assert.equal(ownCopy(value), value, JSON.stringify(value));
    }
  });

  for (const size of SIZES) {
    it(`copies made-up strings of ${size} characters exactly within ${BOUND_MS} ms`, () => {
      for (const value of [
        fill('x', size),
        fill('é', size),
        fill('😀', size),
        fill('\ud83d', size),
        fill('\udc00\ud800', size),
        fill('\u0000\uffff', size),
        // A concatenation and a slice, as V8 may hold a string.
        `${fill('a', size / 2)}${fill('b', size / 2)}`,
        fill('cd', size + 2).slice(1, size + 1),
      ]) {
        const copy = withinBound(BOUND_MS, () => ownCopy(value));

        assert.equal(copy.length, value.length);
        assert.equal(copy, value);
      }
    });
  }
});

describe('the Origin that may call /mcp (D203)', () => {
  /** The site's two origins in production since 1.16.0 (#319, D275), and the first alone. */
  const BOTH = [APP_ORIGIN, ALIAS_ORIGIN];
  const ONE = [APP_ORIGIN];

  it('lets in no Origin and the application’s own, exactly', () => {
    assert.equal(isAllowedOrigin([], ONE), true);
    assert.equal(isAllowedOrigin([APP_ORIGIN], ONE), true);
  });

  it('lets in either of the site’s two origins, exactly, and the second only where it is configured (#319, D275)', () => {
    assert.equal(isAllowedOrigin([], BOTH), true);
    assert.equal(isAllowedOrigin([APP_ORIGIN], BOTH), true);
    assert.equal(isAllowedOrigin([ALIAS_ORIGIN], BOTH), true);
    assert.equal(isAllowedOrigin([ALIAS_ORIGIN], ONE), false);

    for (const values of [
      ['https://WEBHOOK.qa-tools.ru'],
      ['https://webhook.qa-tools.ru/'],
      ['https://webhook.qa-tools.ru:443'],
      ['http://webhook.qa-tools.ru'],
      ['https://webhook.qa-tools.ru.evil.example'],
      ['https://evil.webhook.qa-tools.ru'],
      ['https://evil.example/https://webhook.qa-tools.ru'],
      ['https://webhook.qa-tools.ru\u0000'],
      [' https://webhook.qa-tools.ru'],
      ['https://hook.qa-tools.ru'],
      ['https://evil.example'],
      ['null'],
      [''],
      [APP_ORIGIN, ALIAS_ORIGIN],
      [ALIAS_ORIGIN, ALIAS_ORIGIN],
      [ALIAS_ORIGIN, 'https://evil.example'],
    ]) {
      assert.equal(isAllowedOrigin(values, BOTH), false, JSON.stringify(values));
    }
  });

  it('refuses every other site, null, another spelling of its own and two headers', () => {
    for (const values of [
      ['https://evil.example'],
      ['null'],
      [''],
      ['https://QA-TOOLS.RU'],
      ['https://qa-tools.ru/'],
      ['https://qa-tools.ru:443'],
      ['http://qa-tools.ru'],
      ['https://qa-tools.ru.evil.example'],
      ['https://evil.example/https://qa-tools.ru'],
      ['https://hook.qa-tools.ru'],
      [' https://qa-tools.ru'],
      ['https://qa-tools.ru\u0000'],
      ['https://qа-tools.ru'],
      [APP_ORIGIN, APP_ORIGIN],
      [APP_ORIGIN, 'https://evil.example'],
    ]) {
      assert.equal(isAllowedOrigin(values, ONE), false, JSON.stringify(values));
      assert.equal(isAllowedOrigin(values, BOTH), false, JSON.stringify(values));
    }
  });

  for (const size of SIZES) {
    it(`refuses made-up Origins of ${size} characters within ${BOUND_MS} ms`, () => {
      for (const value of [
        fill(APP_ORIGIN, size),
        APP_ORIGIN + fill('/', size),
        fill('h', size) + APP_ORIGIN,
        fill('\u0000', size),
        fill('%', size),
        fill('😀', size),
        fill(ALIAS_ORIGIN, size),
        ALIAS_ORIGIN + fill('/', size),
        fill('w', size) + ALIAS_ORIGIN,
      ]) {
        assert.equal(
          withinBound(BOUND_MS, () => isAllowedOrigin([value], BOTH)),
          false,
        );
      }

      // Built before the bound, as the ids' bodies are.
      const headers = Array.from({ length: size / 64 }, () => APP_ORIGIN);

      assert.equal(
        withinBound(BOUND_MS, () => isAllowedOrigin(headers, BOTH)),
        false,
      );
    });
  }

  it('reads every Origin header from the raw headers, in any letter case', () => {
    const raw = ['Host', 'x', 'origin', 'a', 'Content-Type', 'b', 'ORIGIN', 'c', 'Origins', 'd'];

    assert.deepEqual(rawHeaderValues(raw, 'origin'), ['a', 'c']);
    assert.deepEqual(rawHeaderValues([], 'origin'), []);
    assert.deepEqual(rawHeaderValues(['origin'], 'origin'), []);
  });
});

describe('the query string a URL to /mcp may not carry (D203)', () => {
  it('finds one from any ? or #, an empty one included', () => {
    for (const url of [
      '/mcp?',
      '/mcp#',
      '/mcp?a=1',
      '/mcp?a=1&a=2',
      '/mcp#a',
      '/mcp?#',
      '/mcp#?',
      '/mcp??',
      '/mcp?%00',
      '/%6Dcp?x',
      '/%6dcp#',
      '/mcp?ÿ',
    ]) {
      assert.equal(hasQueryString(url), true, url);
    }
  });

  it('finds none in a bare path, an escaped spelling of /mcp, or an escaped ? or #', () => {
    for (const url of ['/mcp', '/%6Dcp', '/%6D%63%70', '/mcp%3F', '/mcp%3fa=1', '/mcp%23a', '']) {
      assert.equal(hasQueryString(url), false, url);
    }
  });

  for (const size of SIZES) {
    it(`judges made-up URLs of ${size} characters within ${BOUND_MS} ms`, () => {
      // Every one of these carries a query string, the last character alone
      // in some, and must be found to.
      for (const url of [
        `/mcp?${fill('a', size)}`,
        `/mcp?${fill('a=1&', size)}`,
        `/mcp?${fill('?', size)}`,
        `/mcp${fill('#', size)}`,
        `/mcp${fill('a', size)}?`,
        `/mcp${fill('a', size)}#`,
        `/mcp${fill('%3F', size)}#`,
        `/mcp?${fill('\u0000', size)}`,
        `/mcp#${fill('😀', size)}`,
      ]) {
        assert.equal(
          withinBound(BOUND_MS, () => hasQueryString(url)),
          true,
          `${url.slice(0, 16)}… of ${url.length}`,
        );
      }

      // And none of these does.
      for (const url of [
        `/mcp${fill('a', size)}`,
        `/mcp${fill('%3F', size)}`,
        `/mcp${fill('%23', size)}`,
        `/${fill('/', size)}`,
        fill('ÿ', size),
      ]) {
        assert.equal(
          withinBound(BOUND_MS, () => hasQueryString(url)),
          false,
          `${url.slice(0, 16)}… of ${url.length}`,
        );
      }
    });
  }
});

describe('what Accept must allow (D203)', () => {
  it('takes no Accept, an empty one, and any that allows application/json', () => {
    for (const accept of [
      undefined,
      '',
      '  ',
      'application/json, text/event-stream',
      'text/event-stream, application/json',
      'application/json',
      'APPLICATION/JSON',
      'application/json; charset=utf-8',
      'application/*',
      '*/*',
      '*/*;q=0.1',
      'text/html, */*;q=0.001',
      'application/json;q=1.000',
      'text/event-stream;q=0, application/json;q=0.5',
    ]) {
      assert.equal(acceptsJson(accept), true, String(accept));
    }
  });

  it('refuses an Accept that names no range for JSON, or rules it out', () => {
    for (const accept of [
      'text/event-stream',
      'text/html',
      'application/xml',
      'application/json;q=0',
      'application/json;q=0.000, */*',
      'application/*;q=0, */*;q=1',
      '*/*;q=0',
      'application/json;q=2',
      'application/json;q=-1',
      'application/json;q=abc',
      'application/jsonx',
      'json',
      ',,,',
    ]) {
      assert.equal(acceptsJson(accept), false, accept);
    }
  });

  for (const size of SIZES) {
    it(`answers made-up Accept values of ${size} characters within ${ACCEPT_BOUND_MS} ms`, () => {
      // One character repeated - a million empty ranges among them - and one
      // range of a parameter every four characters.
      for (const accept of [
        fill(',', size),
        fill(';', size),
        `application/json;${'q=1;'.repeat(size / 4)}q=0`,
        fill('\u0000', size),
      ]) {
        assert.equal(
          withinBound(ACCEPT_BOUND_MS, () => acceptsJson(accept)),
          false,
        );
      }
    });

    it(`answers made-up Accept lists of whole media ranges of ${size} characters within ${ACCEPT_RANGES_BOUND_MS} ms`, () => {
      for (const accept of [
        'text/html;q=0.5,'.repeat(size / 16),
        'application/json;q=0,'.repeat(Math.ceil(size / 21)),
      ]) {
        assert.equal(
          withinBound(ACCEPT_RANGES_BOUND_MS, () => acceptsJson(accept)),
          false,
        );
      }

      assert.equal(
        withinBound(ACCEPT_RANGES_BOUND_MS, () =>
          acceptsJson(`${'text/html,'.repeat(size / 10)}application/json`),
        ),
        true,
      );
    });
  }
});

describe('the protocol versions (D203)', () => {
  it('answers the version asked for when it is spoken, and the newest otherwise', () => {
    assert.equal(negotiateProtocolVersion('2025-11-25'), '2025-11-25');
    assert.equal(negotiateProtocolVersion('2025-06-18'), '2025-06-18');
    assert.equal(negotiateProtocolVersion('2025-03-26'), '2025-03-26');

    for (const asked of [
      '2024-11-05',
      '2099-01-01',
      '',
      undefined,
      20251125,
      null,
      ['2025-11-25'],
    ]) {
      assert.equal(negotiateProtocolVersion(asked), '2025-11-25');
    }
  });

  it('takes a request without MCP-Protocol-Version as 2025-03-26 and refuses one it does not speak', () => {
    assert.equal(declaredProtocolVersion(undefined), '2025-03-26');
    assert.equal(declaredProtocolVersion('2025-06-18'), '2025-06-18');

    for (const header of [
      '',
      '2024-11-05',
      '2025-06-18, 2025-06-18',
      ' 2025-06-18',
      fill('2025-06-18', 1024 * 1024),
    ]) {
      assert.equal(
        withinBound(BOUND_MS, () => declaredProtocolVersion(header)),
        null,
      );
    }
  });
});

describe('the JSON-RPC answers', () => {
  it('shapes a result and an error', () => {
    assert.deepEqual(rpcResult(1, { a: 1 }), { jsonrpc: '2.0', id: 1, result: { a: 1 } });
    assert.deepEqual(rpcError(null, RpcErrorCode.SERVER_ERROR, 'm'), {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'm' },
    });
    assert.deepEqual(rpcError('x', RpcErrorCode.SERVER_ERROR, 'm', { errorCode: 1015 }), {
      jsonrpc: '2.0',
      id: 'x',
      error: { code: -32000, message: 'm', data: { errorCode: 1015 } },
    });
  });
});
