/**
 * The pool names of `scripts/measure-backend-probe.mjs` (#213, D244): the
 * probe files each pool's readings under its `application_name` without the
 * prefix the backend gives a named pool, so a series reads `capture` and
 * `api` whatever the base image. Only the backend's own prefix is taken off,
 * once and at the start; any other name is kept as it is. Importing the probe
 * starts nothing: it probes only the backend's own process.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { poolName } from '../../../scripts/measure-backend-probe.mjs';
import { APPLICATION_NAME_PREFIX } from './db/pool.ts';

describe('poolName', () => {
  it("is all a test gets from importing the probe, which patches nothing outside the backend's process", () => {
    assert.ok(!Object.hasOwn(http.Server.prototype, 'emit'), 'http.Server emit was patched');
  });

  it("names the backend's pools by what follows its prefix, and a pool without a name shared", () => {
    assert.equal(poolName({ application_name: `${APPLICATION_NAME_PREFIX}capture` }), 'capture');
    assert.equal(poolName({ application_name: `${APPLICATION_NAME_PREFIX}api` }), 'api');
    for (const options of [undefined, null, {}, { application_name: undefined }]) {
      assert.equal(poolName(options), 'shared', JSON.stringify(options));
    }
  });

  it('keeps every other name whole: another prefix, the prefix elsewhere or nearly, and a second one', () => {
    for (const [given, kept] of [
      ['qa-tools-capture', 'qa-tools-capture'],
      ['other-api', 'other-api'],
      ['capture-webhook-inspector-api', 'capture-webhook-inspector-api'],
      [' webhook-inspector-api', ' webhook-inspector-api'],
      ['Webhook-Inspector-api', 'Webhook-Inspector-api'],
      ['webhook-inspectorapi', 'webhook-inspectorapi'],
      ['webhook-inspector_api', 'webhook-inspector_api'],
      ['webhook_inspector-api', 'webhook_inspector-api'],
      ['x\nwebhook-inspector-api', 'x\nwebhook-inspector-api'],
      ['webhook-inspector-webhook-inspector-api', 'webhook-inspector-api'],
      ['webhook-inspector-', ''],
      ['', ''],
    ]) {
      assert.equal(poolName({ application_name: given }), kept, JSON.stringify(given));
    }
    assert.equal(poolName({ application_name: 42 }), '42');
  });
});
