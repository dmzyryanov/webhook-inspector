import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Connect, IndexHtmlTransformContext, Plugin, PluginOption, ViteDevServer } from 'vite';

/**
 * What the dev server that `vite.config.ts` configures answers, for a build's
 * environment: its own middleware for each request, and `/docs`'s head as its
 * plugin writes it. `OPERATOR` is read once, when `operator.ts` loads, so the
 * configuration is loaded in a child process given that environment, this
 * file run as a script, rather than in the test's own process, which holds
 * production's settings. No server is started: the middleware is called as
 * Vite would call it, with a request and an answer that record what it does.
 */

/** The frontend workspace, where `vite.config.ts` is. */
const FRONTEND = fileURLToPath(new URL('../../', import.meta.url));

/** A request to the dev server: its method and its address. */
export type DevRequest = readonly [method: 'GET' | 'HEAD', path: string];

/** What the dev server's own middleware did with a request. */
export interface DevAnswer {
  /** Whether it passed the request on, to Vite and then to the application. */
  readonly passedOn: boolean;
  /** Whether it answered the request itself. */
  readonly answered: boolean;
  /** The address it passed on, or answered: the one asked for unless it rewrote it. */
  readonly url: string;
  /** The headers it set, by their names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body it answered with itself; `null` when it wrote none. */
  readonly body: string | null;
}

/** The dev server's answers to the requests asked, in their order, and `/docs`'s page. */
export interface DevServer {
  readonly answers: readonly DevAnswer[];
  /** `docs/index.html` as the dev server's plugin for `/docs` writes it; as it is with none. */
  readonly docsPage: string;
}

/** The name of `apiReferencePages()` in `vite.config.ts`. */
const PAGES_PLUGIN = 'webhook-inspector-api-reference-pages';

/** The name of `docsPagePlugin()` of `scripts/site-operator.mjs`. */
const DOCS_PLUGIN = 'webhook-inspector-docs-operator';

/** The dev server of a build given `env` as its whole environment, asked `requests`. */
export function devServer(
  env: Readonly<Record<string, string | undefined>>,
  requests: readonly DevRequest[],
): DevServer {
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), JSON.stringify(requests)],
    { cwd: FRONTEND, env, encoding: 'utf8' },
  );

  if (run.status !== 0) {
    throw new Error(`the dev server's configuration did not load:\n${run.stderr}`);
  }

  return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as DevServer;
}

/** Every plugin of a configuration, its nested lists flattened. */
function pluginsOf(options: readonly PluginOption[]): Plugin[] {
  return options.flatMap((option): Plugin[] => {
    if (Array.isArray(option)) {
      return pluginsOf(option);
    }

    return option && !(option instanceof Promise) ? [option as Plugin] : [];
  });
}

/** The function of a hook given either as one or as `{ handler }`. */
function handlerOf<T>(hook: T | { handler: T } | undefined): T | undefined {
  return typeof hook === 'object' && hook !== null && 'handler' in hook ? hook.handler : hook;
}

/** What `middleware` does with `request`, recorded. */
function answerOf(middleware: Connect.NextHandleFunction, [method, path]: DevRequest): DevAnswer {
  const request = { method, url: path };
  const headers: Record<string, string> = {};
  let passedOn = false;
  let answered = false;
  let body: string | null = null;
  const response = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = String(value);
    },
    end(chunk?: string) {
      answered = true;
      body = chunk ?? null;
    },
  };

  middleware(request as IncomingMessage, response as unknown as ServerResponse, () => {
    passedOn = true;
  });

  return { passedOn, answered, url: request.url, headers, body };
}

/** The dev server's answers, in this process's environment. */
async function answer(requests: readonly DevRequest[]): Promise<DevServer> {
  const { default: config } = await import('../../vite.config.ts');
  const plugins = pluginsOf(config.plugins ?? []);
  const pages = plugins.find((plugin) => plugin.name === PAGES_PLUGIN);
  const configure = handlerOf(pages?.configureServer);
  const middlewares: Connect.NextHandleFunction[] = [];

  if (configure === undefined) {
    throw new Error(`vite.config.ts has no ${PAGES_PLUGIN} plugin`);
  }

  await configure.call(
    {} as never,
    {
      middlewares: {
        use(middleware: Connect.NextHandleFunction) {
          middlewares.push(middleware);
        },
      },
    } as unknown as ViteDevServer,
  );

  const [middleware] = middlewares;

  if (middleware === undefined || middlewares.length !== 1) {
    throw new Error(`${PAGES_PLUGIN} added ${middlewares.length} middlewares, not one`);
  }

  const html = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
  const writeDocs = handlerOf(
    plugins.find((plugin) => plugin.name === DOCS_PLUGIN)?.transformIndexHtml,
  );
  const docsPage =
    writeDocs === undefined
      ? html
      : await writeDocs.call({} as never, html, {
          path: '/docs/index.html',
          filename: fileURLToPath(new URL('../../docs/index.html', import.meta.url)),
        } as IndexHtmlTransformContext);

  if (typeof docsPage !== 'string') {
    throw new Error(`${DOCS_PLUGIN} did not write /docs's page as text`);
  }

  return { answers: requests.map((request) => answerOf(middleware, request)), docsPage };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requests = JSON.parse(process.argv[2] ?? '[]') as DevRequest[];

  process.stdout.write(`${JSON.stringify(await answer(requests))}\n`);
}
