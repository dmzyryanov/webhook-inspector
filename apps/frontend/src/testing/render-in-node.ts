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
 * - it exports `installFakeBrowser`, a window, document and storage just
 *   large enough for `react-dom/client` to render a page into and for
 *   `main.tsx` to start on. It is no browser: no layout, no events, no CSS,
 *   and a timer it is given never runs.
 *
 * A server render needs only the first, with `react-dom/server`.
 *
 * Every test file runs in a process of its own, so what this module sets is
 * that file's alone. Like the backend's `src/testing/`, the directory holds
 * what tests use and the bundle never imports; its names keep it out of the
 * runner's discovery (`../exit-guard.ts` lists the patterns).
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
  readonly nodeName: string;
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];

  constructor(ownerDocument: FakeDocument | null, nodeType: number, nodeName: string) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
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

  contains(node: FakeNode | null): boolean {
    for (let at = node; at !== null; at = at.parentNode) {
      if (at === this) {
        return true;
      }
    }

    return false;
  }

  addEventListener(): void {}

  removeEventListener(): void {}

  /**
   * The node as an assertion's message prints it: its name alone. Inspected
   * as it is, a node would print the whole document and every fiber React
   * hangs on it, a message long enough to take the test file down with it.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `${this.nodeName} node`;
  }
}

/** A text node. */
export class FakeText extends FakeNode {
  nodeValue: string;

  constructor(ownerDocument: FakeDocument | null, nodeValue: string) {
    super(ownerDocument, 3, '#text');
    this.nodeValue = nodeValue;
  }

  get data(): string {
    return this.nodeValue;
  }

  override get textContent(): string {
    return this.nodeValue;
  }

  override set textContent(text: string) {
    this.nodeValue = text;
  }
}

/** An element: its tag, its attributes and a style that holds what is set on it. */
export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly attributes = new Map<string, string>();
  readonly style = {
    setProperty(): void {},
    removeProperty(): void {},
  };

  constructor(ownerDocument: FakeDocument | null, name: string, namespaceURI = HTML_NAMESPACE) {
    const tagName = namespaceURI === HTML_NAMESPACE ? name.toUpperCase() : name;

    super(ownerDocument, 1, tagName);
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  focus(): void {}

  blur(): void {}

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
  readonly defaultView: FakeWindow;
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  readonly activeElement = null;
  title = '';

  constructor(defaultView: FakeWindow) {
    super(null, 9, '#document');
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

/** The address bar: an address's parts, the address it was given changed by history alone. */
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

  get protocol(): string {
    return this.url.protocol;
  }

  get host(): string {
    return this.url.host;
  }

  get hostname(): string {
    return this.url.hostname;
  }

  get port(): string {
    return this.url.port;
  }

  get pathname(): string {
    return this.url.pathname;
  }

  get search(): string {
    return this.url.search;
  }

  get hash(): string {
    return this.url.hash;
  }

  // Nothing is opened or loaded again: there is no next page.
  assign(): void {}

  replace(): void {}

  reload(): void {}
}

/** History of one entry: `replaceState` and `pushState` change the address and the state. */
class FakeHistory {
  private readonly location: FakeLocation;
  state: unknown = null;
  readonly length = 1;

  constructor(location: FakeLocation) {
    this.location = location;
  }

  replaceState(state: unknown, _title: string, url?: string | null): void {
    this.state = state;

    if (url !== undefined && url !== null && url !== '') {
      this.location.href = url;
    }
  }

  pushState(state: unknown, title: string, url?: string | null): void {
    this.replaceState(state, title, url);
  }

  back(): void {}

  forward(): void {}

  go(): void {}
}

/** An in-memory `localStorage`. */
export class FakeStorage {
  readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  getItem(name: string): string | null {
    return this.items.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.items.set(name, String(value));
  }

  removeItem(name: string): void {
    this.items.delete(name);
  }

  clear(): void {
    this.items.clear();
  }
}

/** The window: the address, history, storage, a desktop's media queries, and timers never run. */
export class FakeWindow {
  readonly location: FakeLocation;
  readonly history: FakeHistory;
  readonly localStorage = new FakeStorage();
  readonly document: FakeDocument;
  /** Checked by React for an iframe holding focus; nothing here is one. */
  readonly HTMLIFrameElement = class HTMLIFrameElement {};

  constructor(href: string) {
    this.location = new FakeLocation(href);
    this.history = new FakeHistory(this.location);
    this.document = new FakeDocument(this);
  }

  // No event is ever dispatched: `hashchange`, `popstate` and `storage` never come.
  addEventListener(): void {}

  removeEventListener(): void {}

  matchMedia(media: string) {
    return {
      media,
      matches: false,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
    };
  }

  /** A timer is never run: a toast stays on screen for as long as the test reads it. */
  setTimeout(): number {
    return 0;
  }

  clearTimeout(): void {}
}

/**
 * Makes `window` and `document` this process's globals, at `href`, with an
 * empty `<div id="root">` in the body, and tells React it renders under
 * `act`. Called before `react-dom/client` or any page is imported: React DOM
 * decides at its load whether it has a DOM.
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

  return fake;
}
