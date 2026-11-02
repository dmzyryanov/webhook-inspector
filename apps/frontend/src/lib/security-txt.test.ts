import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  EXPIRES_AFTER_DAYS,
  SECURITY_TXT_FILE,
  SECURITY_TXT_URL,
  securityTxt,
} from '../../scripts/build-security-txt.mjs';
// @ts-expect-error -- a plain ES module with no declarations; the build runs it.
import { checkBuild, securityTxtProblems } from '../../scripts/check-build.mjs';
import { CONTACT_MAILTO } from './contact.ts';
import { APP_ORIGIN } from '../../scripts/site-origin.mjs';

/**
 * `/.well-known/security.txt` (RFC 9116, issue #88, D177): the file the build
 * writes, the check the build runs on it, and the nginx location that serves
 * it. `scripts/check-deployment.mjs` reads it from the deployed site.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const problems = (text: string, now: Date) => securityTxtProblems(text, now) as string[];

describe('security.txt', () => {
  it('names the contact, an Expires 364 days after the build, the languages and its address', () => {
    assert.equal(
      securityTxt(new Date('2026-09-29T10:11:12.345Z')),
      [
        'Contact: mailto:contact@qa-tools.ru',
        'Expires: 2027-09-28T10:11:12Z',
        'Preferred-Languages: en, ru',
        `Canonical: ${APP_ORIGIN}/.well-known/security.txt`,
        '',
      ].join('\n'),
    );
    assert.equal(SECURITY_TXT_FILE, '.well-known/security.txt');
    assert.equal(SECURITY_TXT_URL, `${APP_ORIGIN}/${SECURITY_TXT_FILE}`);
    assert.equal(EXPIRES_AFTER_DAYS, 364);
  });

  it('publishes the address the footer links to', () => {
    assert.ok(securityTxt().split('\n').includes(`Contact: ${CONTACT_MAILTO}`));
  });

  it('expires less than a year after any build, leap years included', () => {
    for (const built of ['2026-09-29T00:00:00Z', '2027-03-01T00:00:00Z', '2028-02-29T23:59:59Z']) {
      const now = new Date(built);

      assert.deepEqual(problems(securityTxt(now), now), [], built);
    }
  });

  it('is refused by the build check without its Contact, or with another one', () => {
    const now = new Date('2026-09-29T00:00:00Z');
    const text = securityTxt(now);

    for (const broken of [
      text.replace(/^Contact: .*\n/m, ''),
      text.replace('contact@qa-tools.ru', 'someone@example.com'),
    ]) {
      assert.ok(
        problems(broken, now).includes(
          '.well-known/security.txt has no line "Contact: mailto:contact@qa-tools.ru"',
        ),
      );
    }
  });

  it('is refused once expired, a year or more ahead, malformed, or without one Expires', () => {
    const now = new Date('2026-09-29T00:00:00Z');
    const withExpires = (value: string) =>
      securityTxt(now).replace(/^Expires: .*$/m, `Expires: ${value}`);

    assert.deepEqual(problems(withExpires('2026-09-28T23:59:59Z'), now), [
      '.well-known/security.txt expired at 2026-09-28T23:59:59Z',
    ]);
    assert.deepEqual(problems(withExpires('2026-09-29T00:00:00Z'), now), [
      '.well-known/security.txt expired at 2026-09-29T00:00:00Z',
    ]);
    assert.deepEqual(problems(withExpires('2027-09-29T00:00:00Z'), now), [
      '.well-known/security.txt expires at 2027-09-29T00:00:00Z, a year or more ahead',
    ]);
    assert.deepEqual(problems(withExpires('2027-09-28T23:59:59Z'), now), []);
    assert.deepEqual(problems(withExpires('next year'), now), [
      '.well-known/security.txt has Expires "next year", not an RFC 3339 UTC time',
    ]);
    assert.deepEqual(problems(securityTxt(now).replace(/^Expires: .*\n/m, ''), now), [
      '.well-known/security.txt has 0 Expires fields, not one',
    ]);
    assert.deepEqual(problems(`${securityTxt(now)}Expires: 2027-01-01T00:00:00Z\n`, now), [
      '.well-known/security.txt has 2 Expires fields, not one',
    ]);
  });

  it('is required in the build', () => {
    const dist = mkdtempSync(join(tmpdir(), 'webhook-inspector-dist-'));

    try {
      assert.ok((checkBuild(dist) as string[]).includes('.well-known/security.txt was not built'));
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
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

describe('the /.well-known/security.txt location in nginx.conf', () => {
  it('serves it as UTF-8 plain text, revalidated, never the application shell', () => {
    assert.equal(
      location(`/${SECURITY_TXT_FILE}`),
      [
        'types { }',
        'default_type text/plain;',
        'charset utf-8;',
        "add_header Cache-Control 'no-cache' always;",
        'try_files $uri =404;',
      ].join('\n'),
    );
  });

  it('refuses no dot-directory anywhere else in the configuration', () => {
    const config = read('../../nginx.conf')
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');

    assert.doesNotMatch(config, /location[^{]*\\\./, 'a location matches a dot in the path');
    assert.doesNotMatch(config, /\bdeny\b/);
  });
});
