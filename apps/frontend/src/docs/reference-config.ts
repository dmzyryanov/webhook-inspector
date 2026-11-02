import type { createApiReference } from '@scalar/api-reference';

/**
 * The configuration of the API reference at `/docs` (D155).
 *
 * Kept apart from `main.ts` so that the unit tests can read it without loading
 * Scalar: this module imports Scalar's types only, which are erased.
 *
 * Every option here turns something of Scalar's off or points it at this
 * origin. Checked against @scalar/api-reference 1.72.0, pinned in
 * package.json. Option names change between Scalar versions, so the browser suite
 * (`e2e/api-docs.spec.ts`) checks the behaviour rather than these names: no
 * request leaves the page's origin, and none of Scalar's hosted-service entry
 * points is on the page.
 */
export type ReferenceConfiguration = Exclude<Parameters<typeof createApiReference>[1], unknown[]>;

/** The document the page renders, read from its own origin at load time. */
export const OPENAPI_PATH = '/openapi.json';

/** The code samples offered, in `target/client` form; curl is selected first. */
export const CODE_SAMPLE_CLIENTS = ['shell/curl', 'js/fetch', 'python/requests'] as const;

/**
 * Every Scalar target, with `true` hiding all of its clients and a list hiding
 * the ones named. What survives is exactly `CODE_SAMPLE_CLIENTS`; the unit test
 * compares the two against Scalar's own client list.
 */
export const HIDDEN_CLIENTS: ReferenceConfiguration['hiddenClients'] = {
  c: true,
  clojure: true,
  csharp: true,
  dart: true,
  fsharp: true,
  go: true,
  http: true,
  java: true,
  js: ['axios', 'jquery', 'ofetch', 'xhr'],
  julia: true,
  kotlin: true,
  node: true,
  objc: true,
  ocaml: true,
  php: true,
  powershell: true,
  python: ['python3', 'aiohttp', 'httpx_sync', 'httpx_async'],
  r: true,
  ruby: true,
  rust: true,
  shell: ['httpie', 'wget'],
  swift: true,
};

export function referenceConfiguration(origin: string): ReferenceConfiguration {
  return {
    url: OPENAPI_PATH,
    // The description names production as its server. The page's own origin
    // replaces it, so `Test Request` and the code samples call the API that
    // served the page, and a local or staging copy never calls production.
    // No `proxyUrl`: without one, `Test Request` goes straight to this origin.
    servers: [{ url: origin }],
    // Scalar's own fonts come from fonts.scalar.com. The page loads Inter from
    // its own origin instead (main.ts).
    withDefaultFonts: false,
    // The developer toolbar (Configure, Share, Deploy) links to Scalar's
    // hosted services; its default shows it on localhost.
    showDeveloperTools: 'never',
    // Ask AI and Generate MCP are hosted services too; both default to on
    // for a local URL.
    agent: { disabled: true },
    mcp: { disabled: true },
    // `Open API Client`, in the sidebar and in the Test Request window, links
    // to client.scalar.com with this page's description URL.
    hideClientButton: true,
    telemetry: false,
    // Light only, like the application, with no toggle (owner, 2026-09-24).
    darkMode: false,
    forceDarkModeState: 'light',
    hideDarkModeToggle: true,
    theme: 'default',
    hiddenClients: HIDDEN_CLIENTS,
    defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
    // "Try it", approved on 2026-09-24: sends real requests to this origin.
    hideTestRequestButton: false,
    // The download control links to /openapi.json itself.
    documentDownloadType: 'direct',
  };
}
