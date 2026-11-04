/**
 * Renders the interface's components in a frontend test file (issue #346),
 * so a test can prove what a component draws from what it draws rather than
 * from its source text.
 *
 * The suite runs in Node, which loads `.ts` itself but not `.tsx`, and has no
 * DOM. Importing this module does two things for the rest of the file's
 * process:
 *
 * - it registers load hooks (`module.registerHooks`) that compile a `.tsx`
 *   module with TypeScript's `transpileModule`, as `tsconfig.json` would emit
 *   it with `jsx: react-jsx`, and load a stylesheet as an empty module, as
 *   `main.tsx` imports some. A `.tsx` module is therefore imported with
 *   `await import(...)` after this one: a static import is loaded before any
 *   module of the file runs;
 * - it exports `installFakeBrowser`, a window, document, storage and
 *   navigator just large enough for `react-dom/client` to render a page into
 *   and for `main.tsx` to start on. It is no browser: no layout, no events,
 *   no CSS, and a timer it is given never runs. Each member is one that
 *   React, the router, `main.tsx` or a test uses, so a test that needs one
 *   more adds it (#366); the navigator is an English browser's, whatever the
 *   machine's locale.
 *
 * A server render needs only the first, with `react-dom/server`.
 *
 * Every test file runs in a process of its own, so what this module sets is
 * that file's alone. Like the backend's `src/testing/`, the directory holds
 * what tests use and the bundle never imports, and its modules' names keep
 * them out of the runner's discovery (`../exit-guard.ts` lists the
 * patterns); `render-in-node.test.ts` is this module's own test.
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

registerHooks({
  load(url, context, nextLoad) {
    // A module's address may carry a query: a test that evaluates one again asks for it so.
    const { pathname } = new URL(url);

    if (pathname.endsWith('.css')) {
      return { format: 'module', source: '', shortCircuit: true };
    }

    if (url.startsWith('file:') && pathname.endsWith('.tsx')) {
      const fileName = fileURLToPath(url);
      const { outputText } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
        fileName,
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: true,
        },
      });

      return { format: 'module', source: outputText, shortCircuit: true };
    }

    return nextLoad(url, context);
  },
});

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** A node of the fake document: its children, its parent and its text. */
export class FakeNode {
  readonly ownerDocument: FakeDocument | null;
  readonly nodeType: number;
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];

  constructor(ownerDocument: FakeDocument | null, nodeType: number) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
  }

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];

    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(text: string) {
    for (const child of this.childNodes) {
      child.parentNode = null;
    }

    this.childNodes.length = 0;

    if (text !== '') {
      this.appendChild(new FakeText(this.ownerDocument, text));
    }
  }

  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    child.parentNode?.removeChild(child);

    const at = before === null ? -1 : this.childNodes.indexOf(before);

    this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;

    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child);

    if (at !== -1) {
      this.childNodes.splice(at, 1);
      child.parentNode = null;
    }

    return child;
  }

  // React listens at the root it renders into; no event is ever dispatched.
  addEventListener(): void {}
}

/** A text node: its text is its value. */
export class FakeText extends FakeNode {
  nodeValue: string;

  constructor(ownerDocument: FakeDocument | null, nodeValue: string) {
    super(ownerDocument, 3);
    this.nodeValue = nodeValue;
  }

  override get textContent(): string {
    return this.nodeValue;
  }
}

/** An element: its tag, its attributes and a style that holds what is set on it. */
export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  /** React DOM looks in a `<div>`'s, as it loads, for the animation events' prefixed names. */
  readonly style = {};

  constructor(ownerDocument: FakeDocument | null, name: string, namespaceURI = HTML_NAMESPACE) {
    super(ownerDocument, 1);
    this.tagName = namespaceURI === HTML_NAMESPACE ? name.toUpperCase() : name;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  /** Every element below this one, in document order, whose attribute `name` is `value`. */
  findAll(name: string, value: string): FakeElement[] {
    const found: FakeElement[] = [];

    for (const child of this.childNodes) {
      if (child instanceof FakeElement) {
        if (child.getAttribute(name) === value) {
          found.push(child);
        }

        found.push(...child.findAll(name, value));
      }
    }

    return found;
  }
}

/** The document: it makes the nodes, and holds `<html>`, `<body>` and the page's root. */
export class FakeDocument extends FakeNode {
  /** The window the router takes, from the global `document`, as React DOM does. */
  readonly defaultView: FakeWindow;
  readonly documentElement: FakeElement;
  readonly body: FakeElement;

  constructor(defaultView: FakeWindow) {
    super(null, 9);
    this.defaultView = defaultView;
    this.documentElement = this.appendChild(this.createElement('html'));
    this.body = this.documentElement.appendChild(this.createElement('body'));
  }

  createElement(name: string): FakeElement {
    return new FakeElement(this, name);
  }

  createElementNS(namespace: string, name: string): FakeElement {
    return new FakeElement(this, name, namespace);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(this, text);
  }

  getElementById(id: string): FakeElement | null {
    return this.documentElement.findAll('id', id)[0] ?? null;
  }
}

/** The address bar: the address, its origin and its path, changed by history alone. */
class FakeLocation {
  private url: URL;

  constructor(href: string) {
    this.url = new URL(href);
  }

  get href(): string {
    return this.url.href;
  }

  set href(href: string) {
    this.url = new URL(href, this.url);
  }

  get origin(): string {
    return this.url.origin;
  }

  get pathname(): string {
    return this.url.pathname;
  }
}

/** History of one entry, with no state: `replaceState` changes the address alone. */
class FakeHistory {
  private readonly location: FakeLocation;

  constructor(location: FakeLocation) {
    this.location = location;
  }

  replaceState(_state: unknown, _title: string, url?: string | null): void {
    if (url !== undefined && url !== null && url !== '') {
      this.location.href = url;
    }
  }
}

/** An in-memory `localStorage`. */
export class FakeStorage {
  readonly items = new Map<string, string>();

  getItem(name: string): string | null {
    return this.items.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.items.set(name, String(value));
  }
}

/** The window: address, history, storage, media queries that match nothing, timers never run. */
export class FakeWindow {
  readonly location: FakeLocation;
  readonly history: FakeHistory;
  readonly localStorage = new FakeStorage();
  readonly document: FakeDocument;
  /** Checked by React for an iframe holding focus; nothing here is one. */
  readonly HTMLIFrameElement = class HTMLIFrameElement {};

  /**
   * An English browser's, whatever the locale of the machine running the
   * suite (#366), as the browser suite's contexts are `en-US`: Node's own
   * `navigator`, which `main.tsx` would otherwise read, follows the machine.
   * React DOM looks in `userAgent` for Chrome or Firefox as it loads, to
   * suggest its DevTools; it names neither.
   */
  readonly navigator = { userAgent: 'Node.js', languages: ['en-US'] };

  constructor(href: string) {
    this.location = new FakeLocation(href);
    this.history = new FakeHistory(this.location);
    this.document = new FakeDocument(this);
  }

  // No event is ever dispatched: `hashchange`, `popstate` and `storage` never come.
  addEventListener(): void {}

  removeEventListener(): void {}

  /** No query matches - `matches` is unset, which reads as false - and none ever changes. */
  matchMedia() {
    return {
      addEventListener(): void {},
      removeEventListener(): void {},
    };
  }

  /** A timer is never run: a toast stays on screen for as long as the test reads it. */
  setTimeout(): number {
    return 0;
  }
}

/**
 * Makes `window`, `document` and `navigator` this process's globals, at
 * `href`, with an empty `<div id="root">` in the body, and tells React it
 * renders under `act`. Called before `react-dom/client` or any page is
 * imported: React DOM decides at its load whether it has a DOM.
 */
export function installFakeBrowser(href: string): FakeWindow {
  const fake = new FakeWindow(href);
  const root = fake.document.createElement('div');

  root.setAttribute('id', 'root');
  fake.document.body.appendChild(root);

  Object.assign(globalThis, {
    window: fake,
    document: fake.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // Node's own `navigator` has a getter and no setter: it is replaced, not assigned.
  Object.defineProperty(globalThis, 'navigator', {
    value: fake.navigator,
    configurable: true,
    writable: true,
  });

  return fake;
}
