import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  API_CALL_LIMIT,
  MAX_RECEIVE_CONNECTIONS_PER_ADDRESS,
  SESSION_CREATE_LIMIT,
} from '@webhook-inspector/shared';
import { loadConfig } from './config.ts';

const BASE = {
  DATABASE_URL: 'postgres://webhook_inspector:webhook_inspector@localhost:5432/webhook_inspector',
};

function load(extra: NodeJS.ProcessEnv = {}): ReturnType<typeof loadConfig> {
  return loadConfig({ ...BASE, ...extra });
}

describe('the trust boundary read from configuration (D111)', () => {
  it('is empty when the variable is unset, which is the default everywhere', () => {
    assert.deepEqual(load().trustedProxyCidrs, []);
  });

  it('is empty for an empty or whitespace-only value', () => {
    assert.deepEqual(load({ TRUSTED_PROXY_CIDRS: '' }).trustedProxyCidrs, []);
    assert.deepEqual(load({ TRUSTED_PROXY_CIDRS: '  ,  ' }).trustedProxyCidrs, []);
  });

  it('accepts CIDR ranges and literal addresses, IPv4 and IPv6 alike', () => {
    assert.deepEqual(load({ TRUSTED_PROXY_CIDRS: '10.42.0.0/24' }).trustedProxyCidrs, [
      '10.42.0.0/24',
    ]);
    assert.deepEqual(
      load({ TRUSTED_PROXY_CIDRS: ' 10.42.0.0/24 , 10.42.1.5 , 2001:db8::/32 ' }).trustedProxyCidrs,
      ['10.42.0.0/24', '10.42.1.5', '2001:db8::/32'],
    );
  });

  it('refuses a hop count, so the boundary can never be expressed as one', () => {
    // A hop count is believed by whoever happens to be talking to the process,
    // which is the failure mode the boundary exists to prevent (D111).
    assert.throws(() => load({ TRUSTED_PROXY_CIDRS: '1' }), /TRUSTED_PROXY_CIDRS/);
  });

  it('refuses "true" and the named presets, so what is trusted is always written out', () => {
    for (const value of ['true', 'loopback', 'linklocal', 'uniquelocal']) {
      assert.throws(() => load({ TRUSTED_PROXY_CIDRS: value }), /TRUSTED_PROXY_CIDRS/, value);
    }
  });

  it('refuses a /0 prefix, which is "trust everyone" in CIDR syntax', () => {
    // The one spelling of trustProxy: true the CIDR grammar permits. Caught
    // here, with a message that names the variable, rather than deep inside
    // the server constructor (D111).
    assert.throws(() => load({ TRUSTED_PROXY_CIDRS: '0.0.0.0/0' }), /TRUSTED_PROXY_CIDRS/);
    assert.throws(() => load({ TRUSTED_PROXY_CIDRS: '::/0' }), /TRUSTED_PROXY_CIDRS/);
  });

  it('tells the operator why /0 is refused, rather than calling it malformed', () => {
    // 0.0.0.0/0 is a well-formed CIDR range. The generic message would say it
    // is not one, which is simply untrue, and the operator would go looking for
    // a typo that is not there.
    for (const value of ['0.0.0.0/0', '::/0']) {
      assert.throws(() => load({ TRUSTED_PROXY_CIDRS: value }), /trusts every address/, value);
    }

    // Genuinely malformed input keeps the generic message.
    assert.throws(
      () => load({ TRUSTED_PROXY_CIDRS: '10.42.0.0/99' }),
      /must be a comma-separated list/,
    );
  });

  it('refuses a zone suffix, which names an interface here and not a peer', () => {
    // The entry form and the storage form have to agree on what is strict:
    // normaliseSourceIp strips the zone before storing, so an allow-list entry
    // carrying one describes something the boundary can never mean.
    // @fastify/proxy-addr compiles it happily, so nothing downstream would
    // complain (D111).
    assert.throws(() => load({ TRUSTED_PROXY_CIDRS: 'fe80::1%eth0/64' }), /TRUSTED_PROXY_CIDRS/);
    assert.throws(() => load({ TRUSTED_PROXY_CIDRS: 'fe80::1%eth0' }), /TRUSTED_PROXY_CIDRS/);
  });

  it('refuses a leading-zero prefix length, the same ambiguity as a leading-zero octet', () => {
    // Number('024') is 24. A parser whose whole premise is that leading zeros
    // are ambiguous cannot accept them in the prefix.
    assert.throws(() => load({ TRUSTED_PROXY_CIDRS: '10.0.0.0/024' }), /TRUSTED_PROXY_CIDRS/);
    assert.throws(() => load({ TRUSTED_PROXY_CIDRS: '2001:db8::/032' }), /TRUSTED_PROXY_CIDRS/);
  });

  it('fails startup on an unreadable entry rather than dropping it silently', () => {
    assert.throws(() => load({ TRUSTED_PROXY_CIDRS: '10.42.0.0/24,not-a-range' }), /not-a-range/);
    assert.throws(() => load({ TRUSTED_PROXY_CIDRS: '10.42.0.0/99' }), /TRUSTED_PROXY_CIDRS/);
  });
});

describe('the receive listener read from configuration (D187)', () => {
  it('listens on 3001 locally, without PROXY protocol, and names itself as the receive origin', () => {
    const config = load();

    assert.equal(config.receivePort, 3001);
    assert.equal(config.receiveProxyProtocol, 'off');
    assert.equal(config.receiveOrigin, 'http://127.0.0.1:3001');
    assert.equal(load({ RECEIVE_PORT: '4001' }).receiveOrigin, 'http://127.0.0.1:4001');
  });

  it('refuses a port that is not one, or the application listener port', () => {
    for (const value of ['0', '65536', 'abc', '3001.5']) {
      assert.throws(() => load({ RECEIVE_PORT: value }), /RECEIVE_PORT/, value);
    }

    assert.throws(() => load({ RECEIVE_PORT: '3000' }), /must differ/);
    assert.throws(() => load({ BACKEND_PORT: '4000', RECEIVE_PORT: '4000' }), /must differ/);
  });

  it('keeps the origin of a configured RECEIVE_ORIGIN and nothing more', () => {
    assert.equal(
      load({ RECEIVE_ORIGIN: 'https://hook.qa-tools.ru' }).receiveOrigin,
      'https://hook.qa-tools.ru',
    );
    assert.equal(
      load({ RECEIVE_ORIGIN: 'https://HOOK.qa-tools.ru:443/' }).receiveOrigin,
      'https://hook.qa-tools.ru',
    );
    assert.equal(
      load({ RECEIVE_ORIGIN: 'http://127.0.0.1:3101' }).receiveOrigin,
      'http://127.0.0.1:3101',
    );
  });

  it('refuses a RECEIVE_ORIGIN with another scheme, credentials, a path, a query or a fragment, and never quotes it', () => {
    for (const value of [
      'hook.qa-tools.ru',
      'ftp://hook.qa-tools.ru',
      'https://user:secret@hook.qa-tools.ru',
      'https://hook.qa-tools.ru/s',
      'https://hook.qa-tools.ru/?x=1',
      'https://hook.qa-tools.ru?',
      'https://hook.qa-tools.ru#top',
    ]) {
      assert.throws(
        () => load({ RECEIVE_ORIGIN: value }),
        (error: Error) => /RECEIVE_ORIGIN/.test(error.message) && !error.message.includes('secret'),
        value,
      );
    }
  });

  it('accepts only off and v2 for RECEIVE_PROXY_PROTOCOL', () => {
    assert.equal(load({ RECEIVE_PROXY_PROTOCOL: 'off' }).receiveProxyProtocol, 'off');
    assert.equal(
      load({ RECEIVE_PROXY_PROTOCOL: 'v2', TRUSTED_PROXY_CIDRS: '10.42.0.0/24' })
        .receiveProxyProtocol,
      'v2',
    );

    for (const value of ['on', 'v1', 'V2', 'true']) {
      assert.throws(() => load({ RECEIVE_PROXY_PROTOCOL: value }), /RECEIVE_PROXY_PROTOCOL/, value);
    }
  });

  it('keeps the HTTP/2 path off unless RECEIVE_HTTP2 is on, and refuses any other value naming the setting (D263)', () => {
    assert.equal(load().receiveHttp2, 'off');
    assert.equal(load({ RECEIVE_HTTP2: '' }).receiveHttp2, 'off');
    assert.equal(load({ RECEIVE_HTTP2: 'off' }).receiveHttp2, 'off');
    assert.equal(load({ RECEIVE_HTTP2: ' off ' }).receiveHttp2, 'off');
    assert.equal(load({ RECEIVE_HTTP2: 'on' }).receiveHttp2, 'on');
    assert.equal(load({ RECEIVE_HTTP2: ' on ' }).receiveHttp2, 'on');
    assert.equal(
      load({
        RECEIVE_HTTP2: 'on',
        RECEIVE_PROXY_PROTOCOL: 'v2',
        TRUSTED_PROXY_CIDRS: '10.42.0.0/24',
      }).receiveHttp2,
      'on',
    );

    // A mistyped value must never switch the path on by accident, nor off a
    // value meant to be on: each refuses to start, and the message names the
    // setting and quotes the value.
    for (const value of ['ON', 'On', 'true', '1', 'yes', 'h2', 'h2c', 'v2', 'off,on', 'o n']) {
      assert.throws(
        () => load({ RECEIVE_HTTP2: value }),
        (error: Error) =>
          error.message.startsWith('RECEIVE_HTTP2 must be "on" or "off"') &&
          error.message.includes(`"${value.trim()}"`),
        value,
      );
    }
  });

  it('allows 512 connections an address unless RECEIVE_CONNECTIONS_PER_ADDRESS says otherwise, 0 turning the bound off (D227)', () => {
    assert.equal(MAX_RECEIVE_CONNECTIONS_PER_ADDRESS, 512);
    assert.equal(load().receiveConnectionsPerAddress, 512);
    assert.equal(load({ RECEIVE_CONNECTIONS_PER_ADDRESS: ' ' }).receiveConnectionsPerAddress, 512);
    assert.equal(
      load({ RECEIVE_CONNECTIONS_PER_ADDRESS: '512' }).receiveConnectionsPerAddress,
      512,
    );
    assert.equal(load({ RECEIVE_CONNECTIONS_PER_ADDRESS: '0' }).receiveConnectionsPerAddress, 0);
    assert.equal(load({ RECEIVE_CONNECTIONS_PER_ADDRESS: '1' }).receiveConnectionsPerAddress, 1);
    assert.equal(
      load({ RECEIVE_CONNECTIONS_PER_ADDRESS: '999999999' }).receiveConnectionsPerAddress,
      999_999_999,
    );
  });

  it('refuses any other RECEIVE_CONNECTIONS_PER_ADDRESS, so a typo never turns the bound off unnoticed', () => {
    for (const value of ['-1', '1.5', '1e3', '+5', '05', '00', 'off', 'unlimited', '1000000000']) {
      assert.throws(
        () => load({ RECEIVE_CONNECTIONS_PER_ADDRESS: value }),
        /RECEIVE_CONNECTIONS_PER_ADDRESS must be 0 \(no limit\) or a whole number/,
        value,
      );
    }
  });

  it('refuses PROXY protocol with nobody trusted to send it, or on localhost', () => {
    // Every connection would be refused: a receive host that answers nothing.
    assert.throws(() => load({ RECEIVE_PROXY_PROTOCOL: 'v2' }), /needs TRUSTED_PROXY_CIDRS/);
    // Fastify's second server for localhost would accept connections without
    // the PROXY layer.
    assert.throws(
      () =>
        load({
          RECEIVE_PROXY_PROTOCOL: 'v2',
          TRUSTED_PROXY_CIDRS: '10.42.0.0/24',
          BACKEND_HOST: 'localhost',
        }),
      /localhost/,
    );
  });
});

describe('the per-address limits read from configuration (D201)', () => {
  it('are the production numbers when nothing is set, which is what production does', () => {
    assert.deepEqual(load().rateLimits, {
      sessionCreates: SESSION_CREATE_LIMIT,
      apiCalls: API_CALL_LIMIT,
    });
    assert.deepEqual(
      load({ RATE_LIMIT_SESSION_CREATES_PER_MINUTE: ' ', RATE_LIMIT_API_CALLS_PER_MINUTE: '' })
        .rateLimits,
      { sessionCreates: 60, apiCalls: 1200 },
    );
  });

  it('take a whole number from 1 for either limit, separately', () => {
    assert.deepEqual(load({ RATE_LIMIT_SESSION_CREATES_PER_MINUTE: '1000' }).rateLimits, {
      sessionCreates: 1000,
      apiCalls: 1200,
    });
    assert.deepEqual(load({ RATE_LIMIT_API_CALLS_PER_MINUTE: '1' }).rateLimits, {
      sessionCreates: 60,
      apiCalls: 1,
    });
    assert.equal(
      load({ RATE_LIMIT_API_CALLS_PER_MINUTE: '999999999' }).rateLimits.apiCalls,
      999_999_999,
    );
  });

  it('refuse anything else, so a typo never leaves the API without the limit meant', () => {
    for (const value of ['0', '-1', '1.5', '1e3', '+5', '05', 'off', 'unlimited', '1000000000']) {
      assert.throws(
        () => load({ RATE_LIMIT_SESSION_CREATES_PER_MINUTE: value }),
        /RATE_LIMIT_SESSION_CREATES_PER_MINUTE/,
        value,
      );
      assert.throws(
        () => load({ RATE_LIMIT_API_CALLS_PER_MINUTE: value }),
        /RATE_LIMIT_API_CALLS_PER_MINUTE/,
        value,
      );
    }
  });
});

describe('the application origin read from configuration (D203)', () => {
  it('is the local dev server’s when APP_ORIGIN is unset or empty', () => {
    assert.equal(load().appOrigin, 'http://localhost:5173');
    assert.equal(load({ APP_ORIGIN: ' ' }).appOrigin, 'http://localhost:5173');
  });

  it('keeps the origin of a configured APP_ORIGIN and nothing more', () => {
    assert.equal(load({ APP_ORIGIN: 'https://qa-tools.ru' }).appOrigin, 'https://qa-tools.ru');
    assert.equal(load({ APP_ORIGIN: 'https://QA-TOOLS.ru:443/' }).appOrigin, 'https://qa-tools.ru');
  });

  it('refuses an APP_ORIGIN with another scheme, credentials, a path, a query or a fragment, and never quotes it', () => {
    for (const value of [
      'qa-tools.ru',
      'ftp://qa-tools.ru',
      'https://user:secret@qa-tools.ru',
      'https://qa-tools.ru/mcp',
      'https://qa-tools.ru/?x=1',
      'https://qa-tools.ru#top',
    ]) {
      assert.throws(
        () => load({ APP_ORIGIN: value }),
        (error: Error) => /APP_ORIGIN/.test(error.message) && !error.message.includes('secret'),
        value,
      );
    }
  });
});

describe('the second application origin read from configuration (#319, D275)', () => {
  it('is none when APP_ALIAS_ORIGIN is unset or empty', () => {
    assert.equal(load().appAliasOrigin, null);
    assert.equal(load({ APP_ALIAS_ORIGIN: '' }).appAliasOrigin, null);
    assert.equal(load({ APP_ALIAS_ORIGIN: ' \t' }).appAliasOrigin, null);
  });

  it('keeps the origin of a configured APP_ALIAS_ORIGIN and nothing more, leaving APP_ORIGIN as it is', () => {
    const config = load({
      APP_ORIGIN: 'https://qa-tools.ru',
      APP_ALIAS_ORIGIN: 'https://WEBHOOK.qa-tools.ru:443/',
    });

    assert.equal(config.appAliasOrigin, 'https://webhook.qa-tools.ru');
    assert.equal(config.appOrigin, 'https://qa-tools.ru');
  });

  it('refuses another scheme, credentials, a path, a query, a fragment or APP_ORIGIN itself, and never quotes it', () => {
    for (const value of [
      'webhook.qa-tools.ru',
      'ftp://webhook.qa-tools.ru',
      'https://user:secret@webhook.qa-tools.ru',
      'https://webhook.qa-tools.ru/mcp',
      'https://webhook.qa-tools.ru/?x=secret',
      'https://webhook.qa-tools.ru#secret',
      `https://webhook.qa-tools.ru/${'secret'.repeat(10_000)}`,
    ]) {
      assert.throws(
        () => load({ APP_ORIGIN: 'https://qa-tools.ru', APP_ALIAS_ORIGIN: value }),
        (error: Error) =>
          /^APP_ALIAS_ORIGIN /.test(error.message) && !error.message.includes('secret'),
        value.slice(0, 60),
      );
    }

    assert.throws(
      () =>
        load({ APP_ORIGIN: 'https://qa-tools.ru', APP_ALIAS_ORIGIN: 'https://qa-tools.ru:443' }),
      /^Error: APP_ALIAS_ORIGIN must be an origin other than APP_ORIGIN\.$/,
    );
  });
});
