import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * ARCHITECTURE.md's module map (#405) claims one bullet for each backend
 * module of `apps/backend/src/modules/`, and groups that between them name
 * each non-test module of `apps/frontend/src/lib/` exactly once. These tests
 * hold the map to the two directories, so a module added, renamed or removed
 * without its line in the map fails the frontend suite, naming the module
 * (#441). They read the names alone: what each line says, and where it points
 * in the document, is left to the document.
 */

/** The heading the map sits under; a renamed or re-levelled heading is not found. */
const MAP_HEADING = /^### Module map[ \t]*$/;
/** A heading that ends the map's section: the next one of its level or above. */
const SECTION_END = /^#{1,3} /;
/** The start of a list item, as the map writes it. */
const BULLET = /^- /;
/** The paragraph that opens each list names its directory, in backticks. */
const BACKEND_MARKER = '`apps/backend/src/modules/`';
const LIB_MARKER = '`apps/frontend/src/lib/`';
/** A backend bullet opens with its module's directory name, in backticks. */
const BACKEND_NAME = /^- `([^`]+)`/;
/** A frontend group opens with its name in bold, by which the messages name it. */
const GROUP_NAME = /^- \*\*(.+?)\*\*/;
/** A module a group names: a file name ending `.ts` or `.tsx`, in backticks. */
const LIB_NAME = /`([A-Za-z0-9_.-]+\.tsx?)`/g;
/** A test file, which sits beside its module and needs no line of its own. */
const TEST_FILE = /\.test\.tsx?$/;

/** A bullet shortened for a message. */
function excerpt(bullet: string): string {
  return JSON.stringify(bullet.length > 72 ? `${bullet.slice(0, 72)}…` : bullet);
}

/**
 * The lines of the `### Module map` section, up to the next heading of its
 * level or above; undefined when the document has no such heading.
 */
function mapSection(document: string): string[] | undefined {
  const lines = document.split(/\r?\n/);
  const start = lines.findIndex((line) => MAP_HEADING.test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && SECTION_END.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/**
 * The items of the list that follows the paragraph naming `marker`, each with
 * its continuation lines joined to it; undefined when no paragraph of the
 * section names `marker` or no list follows it. The list ends at its first
 * blank line.
 */
function listAfter(section: readonly string[], marker: string): string[] | undefined {
  let index = section.findIndex((line) => line.includes(marker) && !BULLET.test(line));
  if (index === -1) return undefined;
  index += 1;
  while (
    index < section.length &&
    section[index]?.trim() !== '' &&
    !BULLET.test(section[index] ?? '')
  ) {
    index += 1;
  }
  while (index < section.length && section[index]?.trim() === '') index += 1;
  if (!BULLET.test(section[index] ?? '')) return undefined;
  const items: string[] = [];
  for (; index < section.length; index += 1) {
    const line = (section[index] ?? '').trim();
    if (line === '') break;
    if (BULLET.test(line) || items.length === 0) items.push(line);
    else items[items.length - 1] += ` ${line}`;
  }
  return items;
}

/**
 * What is wrong with the module map of `document` against the directory
 * names of `apps/backend/src/modules/` and the file names of
 * `apps/frontend/src/lib/`; empty when the map holds. Each problem names the
 * module, or says which part of the map could not be read.
 */
function moduleMapProblems(
  document: string,
  backendModules: readonly string[],
  libFiles: readonly string[],
): string[] {
  const section = mapSection(document);
  if (section === undefined) {
    return ['ARCHITECTURE.md has no "### Module map" heading, so neither list of the map is read'];
  }
  const problems: string[] = [];

  const backend = listAfter(section, BACKEND_MARKER);
  if (backend === undefined) {
    problems.push(
      `the module map has no backend list: no "- " bullets follow a paragraph naming ${BACKEND_MARKER}`,
    );
  } else {
    const modules = new Set(backendModules);
    const bullets = new Map<string, number>();
    for (const bullet of backend) {
      const name = BACKEND_NAME.exec(bullet)?.[1];
      if (name === undefined) {
        problems.push(
          `a bullet of the backend list does not open with a module's name in backticks: ${excerpt(bullet)}`,
        );
        continue;
      }
      bullets.set(name, (bullets.get(name) ?? 0) + 1);
    }
    for (const directory of [...modules].sort()) {
      const count = bullets.get(directory) ?? 0;
      if (count === 0) {
        problems.push(
          `backend module \`${directory}\` (apps/backend/src/modules/${directory}/) has no bullet in the module map`,
        );
      } else if (count > 1) {
        problems.push(`backend module \`${directory}\` has ${count} bullets in the module map`);
      }
    }
    for (const name of [...bullets.keys()].sort()) {
      if (!modules.has(name)) {
        problems.push(
          `the module map has a bullet for backend module \`${name}\`, which apps/backend/src/modules/ does not hold`,
        );
      }
    }
  }

  const groups = listAfter(section, LIB_MARKER);
  if (groups === undefined) {
    problems.push(
      `the module map has no frontend list: no "- " bullets follow a paragraph naming ${LIB_MARKER}`,
    );
  } else {
    const modules = new Set(
      libFiles.filter((file) => /\.tsx?$/.test(file) && !TEST_FILE.test(file)),
    );
    const named = new Map<string, string[]>();
    for (const bullet of groups) {
      const name = GROUP_NAME.exec(bullet)?.[1];
      const group = name === undefined ? excerpt(bullet) : `"${name}"`;
      const files = new Set(Array.from(bullet.matchAll(LIB_NAME), (match) => match[1] ?? ''));
      if (files.size === 0) {
        problems.push(`the group ${group} of the frontend list names no module`);
      }
      for (const file of files) named.set(file, [...(named.get(file) ?? []), group]);
    }
    for (const file of [...modules].sort()) {
      const where = named.get(file) ?? [];
      if (where.length === 0) {
        problems.push(
          `frontend module \`${file}\` (apps/frontend/src/lib/${file}) is named in no group of the module map`,
        );
      } else if (where.length > 1) {
        problems.push(
          `frontend module \`${file}\` is named in ${where.length} groups of the module map: ${where.join(', ')}`,
        );
      }
    }
    for (const file of [...named.keys()].sort()) {
      if (!modules.has(file)) {
        const where = (named.get(file) ?? []).join(', ');
        problems.push(
          `the module map names \`${file}\` in ${where}, which apps/frontend/src/lib/ does not hold as a non-test module`,
        );
      }
    }
  }
  return problems;
}

describe('the module map of docs/ARCHITECTURE.md', () => {
  it('has one bullet for each backend module and names each frontend lib module in one group', () => {
    const document = readFileSync(
      new URL('../../../../docs/ARCHITECTURE.md', import.meta.url),
      'utf8',
    );
    const backendModules = readdirSync(new URL('../../../backend/src/modules/', import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const libFiles = readdirSync(new URL('./', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    assert.deepEqual(moduleMapProblems(document, backendModules, libFiles), []);
  });
});

/** A small map in the shape of the real one, for the checks below. */
const MADE_UP_MAP = [
  '# Made-up architecture',
  '',
  '## Repository structure',
  '',
  '### Module map',
  '',
  'One line for each backend module and for each group; tests sit beside them, as `*.test.ts`.',
  '',
  "The backend's modules, `apps/backend/src/modules/`, which `server.ts` registers:",
  '- `alpha` — the first (`routes.ts`, `service.ts`); in [Backend](#backend).',
  '- `beta` — the second (`routes.ts`); in [Backend](#backend).',
  '',
  "The frontend's `apps/frontend/src/lib/`, one flat directory, from `src/pages/` up. By what they serve:",
  '- **Group one** — `one.ts` (the first, and `Copy as cURL`), `two.ts` and `three.tsx`; in [X](#x).',
  '- **Group two** — `four.ts` (its `/about` and `index.html`); not described here.',
  '',
  '## Limiter glossary',
  '',
  '- `gamma` — a bullet after the map, not part of it; `five.ts`.',
  '',
].join('\n');
const MADE_UP_BACKEND = ['alpha', 'beta'];
const MADE_UP_LIB = [
  'one.ts',
  'one.test.ts',
  'two.ts',
  'two.roundtrip.test.ts',
  'three.tsx',
  'three.test.tsx',
  'four.ts',
  'notes.md',
];

describe('the module map check, on made-up maps', () => {
  it('passes a map that names each module once, needing no line for tests or other files', () => {
    assert.deepEqual(moduleMapProblems(MADE_UP_MAP, MADE_UP_BACKEND, MADE_UP_LIB), []);
  });

  it('names a lib module that no group names', () => {
    assert.deepEqual(
      moduleMapProblems(MADE_UP_MAP, MADE_UP_BACKEND, [...MADE_UP_LIB, 'x-made-up.ts']),
      [
        'frontend module `x-made-up.ts` (apps/frontend/src/lib/x-made-up.ts) is named in no group of the module map',
      ],
    );
  });

  it('names a lib module that two groups name', () => {
    const map = MADE_UP_MAP.replace('`four.ts` (its', '`four.ts` and `two.ts` (its');
    assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), [
      'frontend module `two.ts` is named in 2 groups of the module map: "Group one", "Group two"',
    ]);
  });

  it('counts a module named twice in one group as named in that group once', () => {
    const map = MADE_UP_MAP.replace('`four.ts` (its', '`four.ts` (and again `four.ts`, its');
    assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), []);
  });

  it('names a lib module the map names that the directory does not hold', () => {
    const lib = MADE_UP_LIB.filter((file) => file !== 'four.ts');
    assert.deepEqual(moduleMapProblems(MADE_UP_MAP, MADE_UP_BACKEND, lib), [
      'the module map names `four.ts` in "Group two", which apps/frontend/src/lib/ does not hold as a non-test module',
    ]);
  });

  it('names a test file a group names as if it were a module', () => {
    const map = MADE_UP_MAP.replace('`four.ts` (its', '`four.ts` and `one.test.ts` (its');
    assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), [
      'the module map names `one.test.ts` in "Group two", which apps/frontend/src/lib/ does not hold as a non-test module',
    ]);
  });

  it('names a group that names no module', () => {
    const map = MADE_UP_MAP.replace(
      '- **Group two** —',
      '- **Group empty** — nothing in backticks.\n- **Group two** —',
    );
    assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), [
      'the group "Group empty" of the frontend list names no module',
    ]);
  });

  it('names a backend module directory that has no bullet', () => {
    assert.deepEqual(moduleMapProblems(MADE_UP_MAP, [...MADE_UP_BACKEND, 'gamma'], MADE_UP_LIB), [
      'backend module `gamma` (apps/backend/src/modules/gamma/) has no bullet in the module map',
    ]);
  });

  it('names a backend module that has two bullets', () => {
    const map = MADE_UP_MAP.replace(
      '- `beta` — the second',
      '- `alpha` — the first again.\n- `beta` — the second',
    );
    assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), [
      'backend module `alpha` has 2 bullets in the module map',
    ]);
  });

  it('names a backend bullet whose directory does not exist', () => {
    assert.deepEqual(moduleMapProblems(MADE_UP_MAP, ['alpha'], MADE_UP_LIB), [
      'the module map has a bullet for backend module `beta`, which apps/backend/src/modules/ does not hold',
    ]);
  });

  it('names a backend bullet that does not open with a name in backticks', () => {
    const map = MADE_UP_MAP.replace('- `beta` — the second', '- beta — the second');
    assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), [
      'a bullet of the backend list does not open with a module\'s name in backticks: "- beta — the second (`routes.ts`); in [Backend](#backend)."',
      'backend module `beta` (apps/backend/src/modules/beta/) has no bullet in the module map',
    ]);
  });

  it('fails on a map without its heading, rather than passing on nothing', () => {
    const map = MADE_UP_MAP.replace('### Module map\n', '');
    assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), [
      'ARCHITECTURE.md has no "### Module map" heading, so neither list of the map is read',
    ]);
    for (const heading of ['## Module map', '### Module Map', '### Module map and groups']) {
      assert.deepEqual(
        moduleMapProblems(
          MADE_UP_MAP.replace('### Module map', heading),
          MADE_UP_BACKEND,
          MADE_UP_LIB,
        ),
        ['ARCHITECTURE.md has no "### Module map" heading, so neither list of the map is read'],
        heading,
      );
    }
  });

  it('fails on a map whose backend list cannot be found', () => {
    for (const map of [
      MADE_UP_MAP.replace(
        "The backend's modules, `apps/backend/src/modules/`,",
        "The backend's modules,",
      ),
      MADE_UP_MAP.replace(/^- `(alpha|beta)`.*\n/gm, ''),
      MADE_UP_MAP.replace(/^- `(alpha|beta)`/gm, '* `$1`'),
    ]) {
      assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), [
        'the module map has no backend list: no "- " bullets follow a paragraph naming `apps/backend/src/modules/`',
      ]);
    }
  });

  it('fails on a map whose frontend list cannot be found', () => {
    for (const map of [
      MADE_UP_MAP.replace("The frontend's `apps/frontend/src/lib/`,", "The frontend's library,"),
      MADE_UP_MAP.replace(/^- \*\*Group (one|two)\*\*.*\n/gm, ''),
      MADE_UP_MAP.replace('By what they serve:\n', 'By what they serve:\n\nA paragraph between.\n'),
    ]) {
      assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), [
        'the module map has no frontend list: no "- " bullets follow a paragraph naming `apps/frontend/src/lib/`',
      ]);
    }
  });

  it('reads no bullet after the next heading as part of the map', () => {
    const map = MADE_UP_MAP.replace('## Limiter glossary', '### Another section');
    assert.deepEqual(moduleMapProblems(map, MADE_UP_BACKEND, MADE_UP_LIB), []);
    assert.deepEqual(
      moduleMapProblems(map, [...MADE_UP_BACKEND, 'gamma'], [...MADE_UP_LIB, 'five.ts']),
      [
        'backend module `gamma` (apps/backend/src/modules/gamma/) has no bullet in the module map',
        'frontend module `five.ts` (apps/frontend/src/lib/five.ts) is named in no group of the module map',
      ],
    );
  });

  it('reads a bullet wrapped onto further lines as one, and CRLF line endings as LF', () => {
    const wrapped = MADE_UP_MAP.replace(
      '`two.ts` and `three.tsx`;',
      '`two.ts`\n  and `three.tsx`;',
    );
    assert.deepEqual(moduleMapProblems(wrapped, MADE_UP_BACKEND, MADE_UP_LIB), []);
    assert.deepEqual(
      moduleMapProblems(MADE_UP_MAP.replaceAll('\n', '\r\n'), MADE_UP_BACKEND, MADE_UP_LIB),
      [],
    );
  });

  it('checks maps of growing size, and still names the one module missing', () => {
    for (const size of [1, 100, 10_000]) {
      const backend = Array.from({ length: size }, (_, index) => `module-${index}`);
      const lib = Array.from({ length: size }, (_, index) => `lib-${index}.ts`);
      const map = [
        '### Module map',
        'The backend, `apps/backend/src/modules/`:',
        ...backend.map((module) => `- \`${module}\` — a module.`),
        '',
        'The frontend, `apps/frontend/src/lib/`:',
        ...lib.map((file, index) => `- **Group ${index}** — \`${file}\`.`),
        '',
      ].join('\n');
      assert.deepEqual(moduleMapProblems(map, backend, lib), [], `size ${size}`);
      assert.deepEqual(
        moduleMapProblems(map, backend, [...lib, 'x-made-up.ts']),
        [
          'frontend module `x-made-up.ts` (apps/frontend/src/lib/x-made-up.ts) is named in no group of the module map',
        ],
        `size ${size}`,
      );
    }
  });
});
