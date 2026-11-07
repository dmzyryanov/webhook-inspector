import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { isParseableContentType } from './content-type.ts';

/**
 * Fastify's own verdict on a header value - the check that answers `415` in
 * `handle-request.js`. An internal module, read here and nowhere else: the
 * point is to notice when an upgrade moves the rule this predicate has to stay
 * inside of, and a moved or renamed file failing this suite is that notice.
 */
const FastifyContentType = createRequire(import.meta.url)('fastify/lib/content-type.js') as {
  from(value: string): { isValid: boolean };
};

/** Values Fastify refuses: the four measured answering 415 (#19), then more of the set. */
const UNPARSEABLE = [
  'json',
  '',
  'application/',
  'a/b/c',
  '/json',
  'undefined',
  'text/plain, application/json',
  '; charset=utf-8',
  'json; charset=utf-8',
  'text /plain',
  'text/pl@in',
  'téxt/plain',
];

/** Values Fastify accepts, however unusual; parameters never decide it. */
const PARSEABLE = [
  'application/json',
  'Application/JSON',
  'application/json; charset=utf-8',
  'application/json ; charset=utf-8',
  'text/plain;charset',
  'text/plain; ;;; garbage',
  'vnd.example/x-thing+json',
  "a!#$%&'*+.^_`|~-/b!#$%&'*+.^_`|~-",
  'text/plain ',
  ' text/plain',
];

describe('isParseableContentType (D138)', () => {
  it('refuses every value Fastify refuses, so none of them can still answer 415', () => {
    for (const value of UNPARSEABLE) {
      assert.equal(FastifyContentType.from(value).isValid, false, `Fastify accepts ${value}`);
      assert.equal(
        isParseableContentType(value),
        false,
        `${JSON.stringify(value)} was let through`,
      );
    }
  });

  it('accepts real media types, so an ordinary declaration is left alone', () => {
    for (const value of PARSEABLE) {
      assert.equal(FastifyContentType.from(value).isValid, true, `Fastify refuses ${value}`);
      assert.equal(isParseableContentType(value), true, `${JSON.stringify(value)} was replaced`);
    }
  });
});
