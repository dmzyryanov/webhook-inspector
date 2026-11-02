import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * `/openapi.json` is served by the frontend image (D154): the file is copied in
 * from `packages/shared/openapi.json`, and its own nginx location answers it as
 * JSON, uncached, and never with the application shell. No nginx runs in the
 * tests, so these read the files that decide it.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function openapiLocation(): string {
  const config = read('../../nginx.conf');
  const block = /^\s*location = \/openapi\.json \{\n([\s\S]*?)^\s*\}$/m.exec(config)?.[1];

  assert.ok(block !== undefined, 'nginx.conf has no exact location for /openapi.json');

  return block
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

describe('the /openapi.json location in nginx.conf', () => {
  it('answers application/json whatever the mime table says', () => {
    const block = openapiLocation();

    assert.match(block, /^types \{ \}$/m);
    assert.match(block, /^default_type application\/json;$/m);
  });

  it('is revalidated on every use', () => {
    assert.match(openapiLocation(), /^add_header Cache-Control 'no-cache' always;$/m);
  });

  it('serves the file or a plain 404, never the application shell', () => {
    const block = openapiLocation();

    assert.match(block, /^try_files \$uri =404;$/m);
    assert.doesNotMatch(block, /index\.html|error_page|rewrite/);
  });
});

describe('the frontend image', () => {
  it('serves the description the build writes into the served root, under its origins (D274)', () => {
    const dockerfile = read('../../Dockerfile');
    const served = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    const build = (JSON.parse(read('../../package.json')) as { scripts: { build: string } }).scripts
      .build;

    assert.match(
      served,
      /^COPY --from=build \/app\/apps\/frontend\/dist \/usr\/share\/nginx\/html$/m,
    );
    // Never the source as it is, which names production whatever the build's origins.
    assert.doesNotMatch(served, /^COPY packages\/shared\/openapi\.json /m);
    assert.ok(build.includes('node scripts/build-site-files.mjs'));
    assert.ok(build.indexOf('build-site-files.mjs') < build.indexOf('check-build.mjs'));
    assert.ok(
      dockerfile.indexOf('COPY packages/shared packages/shared') <
        dockerfile.indexOf('RUN npm run build'),
    );
  });

  it('builds from a context that does not ignore it', () => {
    const ignored = read('../../../../.dockerignore')
      .split('\n')
      .map((line) => line.trim());

    for (const pattern of [
      'packages',
      'packages/shared',
      'packages/shared/openapi.json',
      '*.json',
      '**/*.json',
    ]) {
      assert.ok(!ignored.includes(pattern), `.dockerignore excludes ${pattern}`);
    }
  });
});
