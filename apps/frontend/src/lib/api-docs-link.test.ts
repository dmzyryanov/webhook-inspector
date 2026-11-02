import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { en } from '../i18n/en.ts';
import { API_DOCS_ACCESSIBLE_NAME, API_DOCS_LINK } from './api-docs-link.ts';

/**
 * The header's link to the API reference (issue #51, D158). The browser suite
 * checks the rendered link on every page; this pins what it points at and how
 * it opens, against the server configuration that answers that address.
 */
describe('the API docs link', () => {
  it('points at /docs, the address nginx serves the reference page at (D155)', () => {
    const nginx = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');

    assert.equal(API_DOCS_LINK.href, '/docs');
    assert.match(nginx, /^\s*location = \/docs \{$/m);
  });

  it('opens in a new tab, so an open session page is not left', () => {
    assert.equal(API_DOCS_LINK.target, '_blank');
    assert.match(API_DOCS_LINK.rel, /\bnoopener\b/);
  });

  /** WCAG 2.5.3: the visible words come first in the name; the rest says what ↗ says. */
  it('is named by its visible words, then says it opens a new tab', () => {
    assert.equal(API_DOCS_LINK.label, 'API docs');
    assert.equal(API_DOCS_ACCESSIBLE_NAME, 'API docs (opens in a new tab)');
    assert.ok(API_DOCS_ACCESSIBLE_NAME.startsWith(API_DOCS_LINK.label));
  });

  it('is what the shared header renders, with the new-tab note for screen readers only', () => {
    const header = readFileSync(new URL('../components/AppHeader.tsx', import.meta.url), 'utf8');

    assert.ok(header.includes('href={API_DOCS_LINK.href}'));
    assert.ok(header.includes('target={API_DOCS_LINK.target}'));
    assert.ok(header.includes('rel={API_DOCS_LINK.rel}'));
    // The words are the interface's language's (D222); the English ones are the constant's.
    assert.ok(header.includes('{m.header.apiDocs}'));
    assert.equal(API_DOCS_LINK.label, en.header.apiDocs);
    assert.equal(API_DOCS_LINK.newTabNote, en.header.newTab);
    assert.equal(
      header.match(/<span className="sr-only">\{` \$\{m\.header\.newTab\}`\}<\/span>/g)?.length,
      2,
    );
  });
});
