// The handover of the backend and the frontend at a deployment (#132,
// criterion 7; D221), read from the chart's templates as text: helm is not in
// `delivery-checks`' image, and what is pinned is a handful of lines whose
// exact values are the decision.
//
// Backend: one replica; `RollingUpdate` with `maxSurge: 1` and
// `maxUnavailable: 0` since 0.54.1 (MR B of #132), so the new pod is ready
// before the old one is told to stop; a `preStop` hook that starts the drain
// with SIGUSR2 and pauses 10 s; a grace period covering that pause plus a
// webhook reply held 30 s by its configured delay; readiness asked every 2 s. Frontend: `RollingUpdate` with
// `maxSurge: 1` and `maxUnavailable: 0`, stated rather than defaulted; a
// `preStop` pause of 10 s; a grace period covering it; readiness every 2 s.
// The commands are pinned whole, not parsed.
//
// And the receive host's connection bound (#145, D227): the chart's
// receive.connectionsPerAddress - 512 as the backend's default is, or 0 while
// the bound is turned off, the one-line recovery every check passes on -
// passed to the backend as RECEIVE_CONNECTIONS_PER_ADDRESS, and counted there,
// in the PROXY layer: no template renders a Traefik middleware for it.
//
// And the backend pod's kernel receive buffer (#217, amending D238): the
// chart's backend.tcpRmem - the measured `4096 16384 6291456`, or empty to
// drop it, its one-line recovery - rendered as the sysctl
// `net.ipv4.tcp_rmem` in the pod's own securityContext, where Kubernetes
// takes a sysctl, on no other pod; and the measurement's compose files give
// their backend the same value, so it runs as production does.
//
// And the edge rate limit and the liveness probe (#205, D264). The backend's
// liveness probe states its timeout and failures, so that a process answering
// within a few seconds is never restarted and a silent one is within about 2
// minutes. The Ingress template is rendered here - with values.yaml, as the
// release `qa-tools` in namespace `qa-tools`, and once in a namespace of
// another name for the Middleware's reference - by `render`, which knows the
// handful of Go template actions the file uses and refuses any other, so a
// new one fails this test rather than passing unread: the rendered Ingresses
// apply the Middleware to /api/ and /mcp alone, every backend path's router
// still outranks the frontend's /, the Middleware's numbers stay above what
// D201 lets one address through - or are 0, the recovery - and the
// measurement's Traefik carries the same numbers on the same paths.
//
// And the site's second host (#319, D275), rendered with the host the
// pipeline gives it: two Ingresses of its own with the first host's paths,
// every router behind the noindex middleware and the API's behind the edge
// rate limit too, a certificate of its own, a backend path outranking the
// frontend's / there as on the first host, and the first host's Ingresses
// rendered as they are without it; and the deploy job's check of its origin.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';

const TEMPLATES = new URL('../deploy/helm/qa-tools/templates/', import.meta.url);
const VALUES = new URL('../deploy/helm/qa-tools/values.yaml', import.meta.url);
const SHARED = new URL('../packages/shared/src/index.ts', import.meta.url);
const CI = new URL('../.gitlab/ci/validate.yml', import.meta.url);
const MEASUREMENTS = [
  new URL('measure-connections.compose.yml', import.meta.url),
  new URL('measure-ordinary-load.compose.yml', import.meta.url),
  new URL('measure-http2-hostile.compose.yml', import.meta.url),
];
/** The measurement's Traefik, which carries the edge rate limit as the chart sets it (#205). */
const MEASUREMENT_TRAEFIK = new URL('measure-connections.traefik.yml', import.meta.url);

/** The backend's `net.ipv4.tcp_rmem` as measured for #217 and #242 (D238's amendment of 2026-10-21). */
const TCP_RMEM = '4096 16384 6291456';

/** `MAX_RESPONSE_DELAY_MS` of packages/shared, in seconds: the longest a webhook reply is held. */
const MAX_RESPONSE_DELAY_SECONDS = 30;
const PAUSE_SECONDS = 10;

/** The Deployment document of a template: the text after its `kind: Deployment` line. */
function deployment(name) {
  const text = readFileSync(fileURLToPath(new URL(name, TEMPLATES)), 'utf8');
  const documents = text.split(/^---$/m);
  const found = documents.filter((document) => /^kind: Deployment$/m.test(document));

  assert.equal(found.length, 1, `${name} holds one Deployment`);

  // Comments describe the values; the values are what is pinned.
  return found[0]
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The one value of `key:` in `text`, which must appear exactly once. */
function only(text, key) {
  const values = [...text.matchAll(new RegExp(`^\\s*${key}: (.+)$`, 'gm'))].map((m) => m[1].trim());

  assert.equal(values.length, 1, `${key} appears once, not ${values.length} times`);

  return values[0];
}

/** The block of a probe (`readinessProbe` or `livenessProbe`) up to the next key at its own indentation. */
function probe(text, name) {
  const match = text.match(new RegExp(`^( *)${name}:\\n((?:\\1 .*\\n)+)`, 'm'));

  assert.ok(match, `${name} is there`);

  return match[2];
}

test('the backend: one replica, RollingUpdate with maxSurge 1 and maxUnavailable 0, the preStop drain and pause, a grace covering the pause and a 30 s delayed reply', () => {
  const backend = deployment('backend.yaml');

  assert.equal(only(backend, 'replicas'), '1');
  assert.match(
    backend,
    /^ {2}strategy:\n {4}type: RollingUpdate\n {4}rollingUpdate:\n {6}maxSurge: 1\n {6}maxUnavailable: 0\n/m,
  );
  assert.doesNotMatch(backend, /Recreate/);
  assert.match(
    backend,
    /^ {10}lifecycle:\n {12}preStop:\n {14}exec:\n {16}command: \['\/bin\/sh', '-c', 'kill -USR2 1; sleep 10'\]\n/m,
  );

  const grace = Number(only(backend, 'terminationGracePeriodSeconds'));

  assert.equal(grace, 60);
  assert.ok(grace >= PAUSE_SECONDS + MAX_RESPONSE_DELAY_SECONDS);
});

test('the backend: readiness on /readyz every 2 s, 1 s to answer, 15 failures to leave, unchanged', () => {
  const backend = deployment('backend.yaml');
  const readiness = probe(backend, 'readinessProbe');

  assert.match(readiness, /path: \/readyz\n/);
  assert.equal(only(readiness, 'initialDelaySeconds'), '1');
  assert.equal(only(readiness, 'periodSeconds'), '2');
  assert.equal(only(readiness, 'timeoutSeconds'), '1');
  assert.equal(only(readiness, 'failureThreshold'), '15');
});

test('the backend: liveness on /healthz every 15 s, 5 s to answer, 6 failures to restart: never a process answering within a few seconds, a silent one within about 2 minutes (#205)', () => {
  const liveness = probe(deployment('backend.yaml'), 'livenessProbe');

  assert.match(liveness, /path: \/healthz\n/);

  const period = Number(only(liveness, 'periodSeconds'));
  const timeout = Number(only(liveness, 'timeoutSeconds'));
  const failures = Number(only(liveness, 'failureThreshold'));

  assert.deepEqual([period, timeout, failures], [15, 5, 6]);
  // A busy process that answers within a few seconds passes every probe.
  assert.ok(timeout >= 3, `a ${timeout} s timeout restarts a process a few seconds slow`);
  // A silent one: the first probe after it falls silent comes within a
  // period, fails `failures` times a period apart, the last after its
  // timeout; the restart follows at once.
  assert.ok(period * failures <= 120, `${period} x ${failures} s is over 2 minutes`);
  assert.ok(
    period + (failures - 1) * period + timeout <= 120,
    'a silent process outlives 2 minutes',
  );
});

test('the frontend: RollingUpdate with maxSurge 1 and maxUnavailable 0, a 10 s preStop pause and a grace covering it', () => {
  const frontend = deployment('frontend.yaml');

  assert.equal(only(frontend, 'replicas'), '1');
  assert.match(
    frontend,
    /^ {2}strategy:\n {4}type: RollingUpdate\n {4}rollingUpdate:\n {6}maxSurge: 1\n {6}maxUnavailable: 0\n/m,
  );
  assert.match(
    frontend,
    /^ {10}lifecycle:\n {12}preStop:\n {14}exec:\n {16}command: \['sleep', '10'\]\n/m,
  );

  const grace = Number(only(frontend, 'terminationGracePeriodSeconds'));

  assert.equal(grace, 30);
  assert.ok(grace > PAUSE_SECONDS);

  const readiness = probe(frontend, 'readinessProbe');

  assert.match(readiness, /path: \/healthz\n/);
  assert.equal(only(readiness, 'initialDelaySeconds'), '1');
  assert.equal(only(readiness, 'periodSeconds'), '2');
  assert.equal(only(readiness, 'failureThreshold'), '15');
});

test('the delivery checks run this test', () => {
  const ci = readFileSync(fileURLToPath(CI), 'utf8');
  const job = ci.slice(ci.indexOf('delivery-checks:'), ci.indexOf('\nchart:'));

  assert.ok(job.includes('scripts/chart.test.mjs'), 'the test is not run');
});

/** `text` without its comment lines. */
function uncommented(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

test("the receive host: the chart's connections per address are the backend's default, 512, or 0 while the bound is off, and reach the backend", () => {
  const values = uncommented(readFileSync(fileURLToPath(VALUES), 'utf8'));
  const receive = values.slice(values.indexOf('\nreceive:\n'), values.indexOf('\nbackend:\n'));
  const configured = /^ {2}connectionsPerAddress: (\d+)$/m.exec(receive)?.[1];
  const fallback = /^export const MAX_RECEIVE_CONNECTIONS_PER_ADDRESS = (\d+);$/m.exec(
    readFileSync(fileURLToPath(SHARED), 'utf8'),
  )?.[1];

  assert.equal(fallback, '512', "the backend's default is no longer 512");
  // 512 as decided, or 0: the one-line recovery (runbook section 7), which
  // changes nothing else and must pass every check.
  assert.ok(
    configured === fallback || configured === '0',
    `values.yaml sets receive.connectionsPerAddress ${configured}, neither ${fallback} nor 0`,
  );

  // Passed to the backend's own container, which counts the connections in
  // its PROXY layer.
  assert.match(
    deployment('backend.yaml'),
    /^ {12}- name: RECEIVE_CONNECTIONS_PER_ADDRESS\n {14}value: \{\{ \.Values\.receive\.connectionsPerAddress \| quote \}\}$/m,
  );
});

test("no template renders a Traefik TCP middleware, and the receive route refers to none: the bound is the backend's (D227)", () => {
  for (const name of readdirSync(fileURLToPath(TEMPLATES))) {
    const text = uncommented(readFileSync(fileURLToPath(new URL(name, TEMPLATES)), 'utf8'));

    assert.doesNotMatch(text, /MiddlewareTCP|inFlightConn/, name);
  }

  const receive = uncommented(
    readFileSync(fileURLToPath(new URL('receive.yaml', TEMPLATES)), 'utf8'),
  );

  assert.doesNotMatch(receive, /middlewares:/);
});

test("the backend pod: a smaller kernel receive buffer, the sysctl net.ipv4.tcp_rmem in the pod's securityContext, on no other pod, and the measurement's backend given the same (#217)", () => {
  const backend = deployment('backend.yaml');
  // The pod's spec, between the template's `spec:` and its first container:
  // a sysctl is the pod's, of its network namespace, and Kubernetes takes it
  // there alone, never in a container's securityContext.
  const template = backend.slice(backend.indexOf('\n  template:\n'));
  const podSpec = template.slice(
    template.indexOf('\n    spec:\n'),
    template.indexOf('\n      initContainers:\n'),
  );

  assert.match(
    podSpec,
    /^ {6}\{\{- with \.Values\.backend\.tcpRmem \}\}\n {6}securityContext:\n {8}sysctls:\n {10}- name: net\.ipv4\.tcp_rmem\n {12}value: \{\{ \. \| quote \}\}\n {6}\{\{- end \}\}$/m,
  );
  assert.equal(backend.match(/sysctls:/g).length, 1, "one sysctls block, the pod's");

  for (const name of readdirSync(fileURLToPath(TEMPLATES)).filter(
    (each) => each !== 'backend.yaml',
  )) {
    const text = uncommented(readFileSync(fileURLToPath(new URL(name, TEMPLATES)), 'utf8'));

    assert.doesNotMatch(text, /sysctls|tcp_rmem/, `${name} sets a sysctl`);
  }

  const values = uncommented(readFileSync(fileURLToPath(VALUES), 'utf8'));
  const section = values.slice(values.indexOf('\nbackend:\n'), values.indexOf('\nfrontend:\n'));
  const configured = /^ {2}tcpRmem: '([^']*)'$/m.exec(section)?.[1];

  // The measured value, or empty: the one-line recovery, which drops the
  // sysctl and must pass every check.
  assert.ok(
    configured === TCP_RMEM || configured === '',
    `values.yaml sets backend.tcpRmem ${configured}, neither '${TCP_RMEM}' nor ''`,
  );

  for (const file of MEASUREMENTS) {
    const compose = readFileSync(fileURLToPath(file), 'utf8');
    // The `backend` service, up to the next service: no other has it.
    const start = compose.indexOf('\n  backend:\n');
    const next = compose.slice(start + 1).search(/\n {2}[a-z]+:\n/);
    const service = compose.slice(start, start + 1 + next);

    assert.ok(start !== -1 && next !== -1, `${fileURLToPath(file)} has no backend service`);
    assert.equal(compose.match(/sysctls:/g).length, 1, "one sysctls block, the backend's");
    assert.match(
      service,
      new RegExp(
        `^ {4}sysctls:\\n {6}net\\.ipv4\\.tcp_rmem: '\\$\\{MEASURE_TCP_RMEM:-${TCP_RMEM}\\}'$`,
        'm',
      ),
      `${fileURLToPath(file)} does not give its backend the chart's tcp_rmem`,
    );
  }
});

/* ------------------------------------------------------------------------ */
/* The edge rate limit (#205, D264).                                        */
/* ------------------------------------------------------------------------ */

/** The release and namespace the deploy job installs (`.gitlab-ci.yml`'s `helm upgrade`). */
const RELEASE = { Name: 'qa-tools', Namespace: 'qa-tools', Service: 'Helm' };
const CHART = new URL('../deploy/helm/qa-tools/Chart.yaml', import.meta.url);

/**
 * values.yaml's `ingress:` section as nested objects of strings: keys and
 * scalars alone, which is all it holds. A line that is neither - a list item,
 * a block scalar - is refused, so that the section cannot change shape
 * unread.
 */
function ingressValues(valuesText) {
  const lines = valuesText.split('\n');
  const start = lines.indexOf('ingress:');

  assert.ok(start !== -1, 'values.yaml has no ingress section');

  const root = {};
  const stack = [{ indent: 0, node: root }];

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }

    if (line.trim() === '' || /^\s*#/.test(line)) {
      continue;
    }

    // Greedy, and the comment cut by an index rather than a pattern, so a
    // hostile line costs its length, not its square.
    const match = /^( +)([\w.-]+):(?: (.*))?$/.exec(line);

    assert.ok(
      match,
      `values.yaml's ingress section has a line this test cannot read: ${line.slice(0, 80)}`,
    );

    const [, spaces, key, raw = ''] = match;
    const indent = spaces.length;

    while (stack.length > 1 && stack.at(-1).indent >= indent) {
      stack.pop();
    }

    const comment = raw.search(/\s#/);
    const value = (comment === -1 ? raw : raw.slice(0, comment)).trim();

    assert.doesNotMatch(value, /^[|>&*!-]/, `ingress.${key}: a value this test cannot read`);

    if (value === '') {
      const node = {};

      stack.at(-1).node[key] = node;
      stack.push({ indent, node });
    } else {
      stack.at(-1).node[key] = value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    }
  }

  return { ingress: root };
}

/** `path`, a dotted path from `.Values`, `.Release` or `.Chart`, in `scope`; refused when absent. */
function lookup(scope, path) {
  const value = path
    .slice(1)
    .split('.')
    .reduce((node, key) => (node === undefined ? undefined : node[key]), scope);

  assert.ok(
    value !== undefined && typeof value !== 'object',
    `the template reads ${path}, which is not a value`,
  );

  return value;
}

/**
 * Whether Go's `if` renders its body for a value as `ingressValues` reads it:
 * an unquoted `true` or `false` is YAML's boolean, and any other scalar a
 * string, true unless empty, as a host is (`ingress.aliasHost`, D275).
 */
function truthy(value) {
  return value !== '' && value !== 'false';
}

/**
 * Renders a template of the chart as Helm does, for the actions the Ingress
 * template uses and nothing else: `{{ include "qa-tools.name" . }}`,
 * `{{ include "qa-tools.labels" . | nindent N }}` with N of one or two
 * digits, a value of `.Values`, `.Release` or `.Chart`, and
 * `{{ if <value> }}` … `{{ end }}`, with `{{-` and `-}}` trimming whitespace
 * as Go's templates do. Any other action is refused, naming it, inside an
 * `if` that hides it too. Each part costs time linear in its length.
 */
function render(text, scope) {
  const name = scope.Release.Name;
  const labels = [
    `app.kubernetes.io/name: ${name}`,
    `app.kubernetes.io/instance: ${scope.Release.Name}`,
    `app.kubernetes.io/managed-by: ${scope.Release.Service}`,
    `helm.sh/chart: ${scope.Chart.Name}-${scope.Chart.Version}`,
  ];
  // An action holds no brace, so each is looked for only up to the next one.
  const parts = text.split(/(\{\{-? [^{}]*? -?\}\})/);
  const output = [];
  // Whether each enclosing `if` renders its body, and how many of them do
  // not: a part is shown while none hides it, a count rather than a look at
  // every enclosing `if`, so a part costs the same however deep the nesting.
  const shown = [];
  let hidden = 0;

  for (let index = 0; index < parts.length; index += 1) {
    let part = parts[index];

    if (index % 2 === 0) {
      // Braces left in the text are an action of a shape not read here.
      assert.ok(
        !part.includes('{{') && !part.includes('}}'),
        `the template has an action this test does not read: ${part.slice(0, 80)}`,
      );

      // Text: trimmed after an action ending `-}}` and before one opening
      // `{{-`; trimStart and trimEnd take what `\s` matches, in time linear
      // in the text, where `/\s+$/` takes its square on a run of spaces that
      // does not end it.
      if (index > 0 && parts[index - 1].endsWith('-}}')) {
        part = part.trimStart();
      }

      if (index + 1 < parts.length && parts[index + 1].startsWith('{{-')) {
        part = part.trimEnd();
      }

      if (hidden === 0) {
        output.push(part);
      }

      continue;
    }

    const action = /^\{\{-? (.*?) -?\}\}$/.exec(part)[1].trim();
    let match;

    if ((match = /^if (\.[\w.]+)$/.exec(action))) {
      const visible = hidden === 0 && truthy(lookup(scope, match[1]));

      shown.push(visible);
      hidden += visible ? 0 : 1;
    } else if (action === 'end') {
      assert.ok(shown.length > 0, 'an end with no if');
      hidden -= shown.pop() ? 0 : 1;
    } else if (action === 'include "qa-tools.name" .') {
      // Inside an `if` that hides it, an action is read for its shape alone.
      output.push(hidden === 0 ? name : '');
    } else if ((match = /^include "qa-tools\.labels" \. \| nindent (\d{1,2})$/.exec(action))) {
      const pad = ' '.repeat(Number(match[1]));

      output.push(hidden === 0 ? labels.map((line) => `\n${pad}${line}`).join('') : '');
    } else if ((match = /^(\.(?:Values|Release|Chart)\.[\w.]+)$/.exec(action))) {
      output.push(hidden === 0 ? lookup(scope, match[1]) : '');
    } else {
      assert.fail(`the template uses an action this test does not render: {{ ${action} }}`);
    }
  }

  assert.equal(shown.length, 0, 'an if with no end');

  return output.join('');
}

/**
 * The chart's Ingress template rendered as production's release, or as
 * `release`, with values.yaml's `ingress` section and `ingress` over it: the
 * deploy job gives the chart `ingress.host` and, in production,
 * `ingress.aliasHost` (D274, D275).
 */
function renderedIngress(release = RELEASE, ingress = {}) {
  const chart = readFileSync(fileURLToPath(CHART), 'utf8');
  const values = ingressValues(readFileSync(fileURLToPath(VALUES), 'utf8'));
  const scope = {
    Values: { ingress: { ...values.ingress, ...ingress } },
    Release: release,
    Chart: {
      Name: /^name: (\S+)$/m.exec(chart)[1],
      Version: /^version: (\S+)$/m.exec(chart)[1],
    },
  };

  return {
    scope,
    documents: render(
      readFileSync(fileURLToPath(new URL('ingress.yaml', TEMPLATES)), 'utf8'),
      scope,
    )
      .split(/^---$/m)
      .map(uncommented),
  };
}

/** A rendered Ingress's name, annotations, TLS hosts and Secret, host and paths. */
function ingressOf(document) {
  const annotations = /^ {2}annotations:\n((?: {4}\S.*\n)*)/m.exec(document)?.[1] ?? '';

  return {
    name: /^metadata:\n {2}name: (\S+)$/m.exec(document)[1],
    tlsHosts: [...document.matchAll(/^ {8}- (\S+)$/gm)].map((match) => match[1]),
    annotations: Object.fromEntries(
      [...annotations.matchAll(/^ {4}([^:\s]+): (.+)$/gm)].map(([, key, value]) => [key, value]),
    ),
    secretName: /^ {6}secretName: (\S+)$/m.exec(document)?.[1] ?? null,
    hosts: [...document.matchAll(/^ {4}- host: (\S+)$/gm)].map((match) => match[1]),
    paths: [
      ...document.matchAll(
        /^ {10}- path: (\S+)\n {12}pathType: (\S+)\n {12}backend:\n {14}service:\n {16}name: (\S+)\n {16}port:\n {18}name: (\S+)$/gm,
      ),
    ].map(([, path, type, service, port]) => ({ path, type, service, port })),
  };
}

/**
 * The rule Traefik 3.7's Kubernetes Ingress provider writes for a path, and
 * so its router's priority, the rule's length (D203; the frontend's
 * search-engines.test.ts models the same, strict matching included).
 */
function ruleOf(host, { path, type }) {
  assert.ok(type === 'Prefix' || type === 'Exact', `${path}: pathType ${type}`);

  return `Host(\`${host}\`) && ${type === 'Exact' ? 'Path' : 'PathPrefix'}(\`${path}\`)`;
}

/** A Traefik duration as Kubernetes' Middleware takes it, `1s` or `1m`, in seconds. */
function seconds(duration) {
  const match = /^(\d+)(s|m)$/.exec(duration);

  assert.ok(match, `the period ${duration} is not modelled`);

  return Number(match[1]) * (match[2] === 'm' ? 60 : 1);
}

/** A shared constant of packages/shared, a whole number. */
function shared(name) {
  const value = new RegExp(`^export const ${name} = (\\d+);$`, 'm').exec(
    readFileSync(fileURLToPath(SHARED), 'utf8'),
  )?.[1];

  assert.ok(value, `packages/shared has no ${name}`);

  return Number(value);
}

test('the edge rate limit: the Middleware on an Ingress of its own for /api/ and /mcp, and on no other path (#205, criterion 3)', () => {
  const { scope, documents } = renderedIngress();
  const kinds = documents.map((document) => /^kind: (\S+)$/m.exec(document)?.[1]);

  assert.deepEqual(kinds, ['Ingress', 'Ingress', 'Middleware']);

  // The API's first, so that Helm creates it before it takes the paths off
  // the site's, as it applies documents of one kind in their order.
  const [api, site] = documents.slice(0, 2).map(ingressOf);
  const middleware = documents[2];
  const middlewareName = /^metadata:\n {2}name: (\S+)$/m.exec(middleware)[1];
  const host = scope.Values.ingress.host;

  assert.equal(host, 'qa-tools.ru');
  assert.equal(site.name, 'qa-tools');
  assert.equal(api.name, 'qa-tools-api');
  assert.equal(middlewareName, 'qa-tools-api-rate-limit');
  assert.match(middleware, /^apiVersion: traefik\.io\/v1alpha1$/m);

  // The API's Ingress names the Middleware, in the release's namespace, by
  // the reference Traefik's Ingress provider reads; the site's names none.
  assert.deepEqual(api.annotations, {
    'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure',
    'traefik.ingress.kubernetes.io/router.middlewares': `qa-tools-${middlewareName}@kubernetescrd`,
  });
  assert.deepEqual(site.annotations, {
    'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure',
    'cert-manager.io/cluster-issuer': 'letsencrypt-production',
  });

  // Production's release and namespace share a name, so the reference is
  // read once more from a namespace of another name: it is the namespace's,
  // not the release's.
  const elsewhere = ingressOf(renderedIngress({ ...RELEASE, Namespace: 'elsewhere' }).documents[0]);

  assert.equal(
    elsewhere.annotations['traefik.ingress.kubernetes.io/router.middlewares'],
    `elsewhere-${middlewareName}@kubernetescrd`,
  );

  // Same host and certificate; one Ingress asks cert-manager for it.
  assert.deepEqual(site.hosts, [host]);
  assert.deepEqual(api.hosts, [host]);
  assert.equal(site.secretName, 'qa-tools-tls');
  assert.equal(api.secretName, site.secretName);

  // The API's paths alone carry it; /ws/, /s/ and the frontend's / do not.
  assert.deepEqual(api.paths, [
    { path: '/api/', type: 'Prefix', service: 'qa-tools-backend', port: 'http' },
    { path: '/mcp', type: 'Prefix', service: 'qa-tools-backend', port: 'http' },
  ]);
  assert.deepEqual(site.paths, [
    { path: '/ws/', type: 'Prefix', service: 'qa-tools-backend', port: 'http' },
    { path: '/s/', type: 'Prefix', service: 'qa-tools-backend', port: 'http' },
    { path: '/', type: 'Prefix', service: 'qa-tools-frontend', port: 'http' },
  ]);

  // Every backend path, on either Ingress, still outranks the frontend's /:
  // Traefik ranks every router of an entry point together, by its rule's
  // length, whichever Ingress it came from.
  const catchAll = ruleOf(host, site.paths.at(-1));

  assert.equal(catchAll.length, 38);

  for (const path of [...api.paths, ...site.paths.slice(0, -1)]) {
    assert.ok(
      ruleOf(host, path).length > catchAll.length,
      `${ruleOf(host, path)} does not outrank ${catchAll}`,
    );
  }

  // Nothing else in the chart names a middleware: not the receive host's
  // TCP route, not the frontend, not the backend.
  for (const name of readdirSync(fileURLToPath(TEMPLATES)).filter(
    (each) => each !== 'ingress.yaml',
  )) {
    const text = uncommented(readFileSync(fileURLToPath(new URL(name, TEMPLATES)), 'utf8'));

    assert.doesNotMatch(text, /middlewares|kind: Middleware|rateLimit/i, name);
  }
});

test('the edge rate limit: its numbers never refuse what D201 lets one address through, or are off; an IPv6 address by its /64 (#205, criteria 1 and 2)', () => {
  const { scope, documents } = renderedIngress();
  const limit = scope.Values.ingress.apiRateLimit;
  const middleware = documents[2];
  const rateLimit = /^spec:\n {2}rateLimit:\n((?: {4}.*\n?)*)/m.exec(middleware)?.[1];

  assert.ok(rateLimit, 'the Middleware has no rateLimit');
  assert.equal(only(rateLimit, 'average'), limit.average);
  assert.equal(only(rateLimit, 'period'), limit.period);
  assert.equal(only(rateLimit, 'burst'), limit.burst);
  assert.match(rateLimit, /^ {4}sourceCriterion:\n {6}ipStrategy:\n {8}ipv6Subnet: 64\n?$/m);
  // No depth and no excluded addresses: the TCP peer, never a header a
  // client writes.
  assert.doesNotMatch(rateLimit, /depth|excludedIPs|requestHeaderName|requestHost/);

  const average = Number(limit.average);
  const burst = Number(limit.burst);

  assert.ok(Number.isInteger(average) && average >= 0, `average ${limit.average}`);

  if (average === 0) {
    // Traefik's own meaning: no limit. The one-line recovery, which every
    // check passes on (runbook, section 7).
    return;
  }

  // What D201 lets one address through: its two counts in fixed windows, so
  // twice each within seconds across a window's edge, and twice again while
  // two processes count apart during a deployment's overlap (D221).
  const perWindow = shared('SESSION_CREATE_LIMIT') + shared('API_CALL_LIMIT');
  const windowSeconds = shared('RATE_LIMIT_WINDOW_SECONDS');

  assert.deepEqual([perWindow, windowSeconds], [1260, 60]);

  const mostAtOnce = 2 * 2 * perWindow;
  const mostPerSecond = (2 * perWindow) / windowSeconds;

  assert.ok(burst >= mostAtOnce, `burst ${burst} is under ${mostAtOnce}`);
  assert.ok(
    average / seconds(limit.period) >= mostPerSecond,
    `${average} per ${limit.period} is under ${mostPerSecond} a second`,
  );
  // The issue's own floor, met many times over.
  assert.ok(burst >= 2 * perWindow && average / seconds(limit.period) >= 21);
});

test("the edge rate limit: the measurement's Traefik carries the chart's numbers on the chart's paths (#205)", () => {
  const { scope } = renderedIngress();
  const limit = scope.Values.ingress.apiRateLimit;
  const traefik = uncommented(readFileSync(fileURLToPath(MEASUREMENT_TRAEFIK), 'utf8'));
  const http = traefik.slice(traefik.indexOf('\nhttp:\n'), traefik.indexOf('\ntls:\n'));
  const routers = [...http.matchAll(/^ {4}([\w-]+):\n((?: {6}.*\n)+)/gm)]
    .filter(([, , body]) => /^ {6}rule: /m.test(body))
    .map(([, name, body]) => ({
      name,
      rule: /^ {6}rule: (.+)$/m.exec(body)[1],
      middlewares: /^ {6}middlewares: \[(.*)\]$/m.exec(body)?.[1] ?? null,
    }));

  assert.deepEqual(routers, [
    { name: 'application', rule: 'Host(`qa-tools.test`)', middlewares: null },
    {
      name: 'api',
      rule: 'Host(`qa-tools.test`) && PathPrefix(`/api/`)',
      middlewares: 'api-rate-limit',
    },
    {
      name: 'mcp',
      rule: 'Host(`qa-tools.test`) && PathPrefix(`/mcp`)',
      middlewares: 'api-rate-limit',
    },
  ]);
  assert.doesNotMatch(traefik.slice(0, traefik.indexOf('\nhttp:\n')), /middlewares/);

  const middleware = /^ {4}api-rate-limit:\n {6}rateLimit:\n((?: {8}.*\n)+)/m.exec(http)?.[1];

  assert.ok(middleware, 'the measurement has no api-rate-limit middleware');
  assert.match(middleware, /^ {8}sourceCriterion:\n {10}ipStrategy:\n {12}ipv6Subnet: 64$/m);

  // The chart's numbers, unless the chart has the limit off (its recovery),
  // when the measurement keeps the numbers it measured.
  if (limit.average !== '0') {
    assert.equal(only(middleware, 'average'), limit.average);
    assert.equal(only(middleware, 'period'), limit.period);
    assert.equal(only(middleware, 'burst'), limit.burst);
  }
});

test('render: the actions the Ingress template uses, trimming as Go does, and any other refused', () => {
  // A release whose name, namespace and chart differ, so that each is seen
  // read from its own place.
  const scope = {
    Values: {
      ingress: { host: 'h.test', none: '', tls: { enabled: 'true' }, off: 'false' },
    },
    Release: { Name: 'rel', Namespace: 'ns', Service: 'Helm' },
    Chart: { Name: 'chart', Version: '1.0.0' },
  };
  const on = '{{ if .Values.ingress.tls.enabled }}';
  const off = '{{ if .Values.ingress.off }}';

  assert.equal(render('a: {{ .Values.ingress.host }}\n', scope), 'a: h.test\n');
  // A string is true unless empty, as Go's `if` takes it: a second host is
  // rendered when one is given (D275).
  assert.equal(render('a{{ if .Values.ingress.host }}b{{ end }}c', scope), 'abc');
  assert.equal(render('a{{ if .Values.ingress.none }}b{{ end }}c', scope), 'ac');
  assert.equal(
    render('x\n  {{- if .Values.ingress.tls.enabled }}\n  y\n  {{- end }}\nz', scope),
    'x\n  y\nz',
  );
  assert.equal(render('x\n  {{- if .Values.ingress.off }}\n  y\n  {{- end }}\nz', scope), 'x\nz');
  // Nested: an `if` inside a hidden one is hidden whatever its own value,
  // and what follows the hidden one's end is shown again.
  assert.equal(render(`a${off}b${on}c{{ end }}d{{ end }}e${on}f{{ end }}`, scope), 'aef');
  assert.equal(render(`a${on}b${off}c{{ end }}d{{ end }}e`, scope), 'abde');
  assert.equal(render(`${off}{{ .Values.ingress.missing }}{{ end }}`, scope), '');
  assert.equal(
    render('{{ .Release.Namespace }}-{{ include "qa-tools.name" . }}@k', scope),
    'ns-rel@k',
  );
  assert.equal(
    render('labels:\n    {{- include "qa-tools.labels" . | nindent 4 }}\n', scope),
    'labels:\n    app.kubernetes.io/name: rel\n    app.kubernetes.io/instance: rel\n' +
      '    app.kubernetes.io/managed-by: Helm\n    helm.sh/chart: chart-1.0.0\n',
  );

  for (const unknown of [
    '{{ .Values.ingress.host | quote }}',
    '{{ printf "%s" .Values.ingress.host }}',
    '{{ include "qa-tools.imageTag" . }}',
    '{{ include "qa-tools.labels" . | nindent 100 }}',
    '{{ .Values.ingress.missing }}',
    '{{ .Values.ingress.tls }}',
    '{{ if .Values.ingress.host }}x',
    '{{ end }}',
    '{{ range .Values.ingress }}{{ end }}',
    `${off}{{ printf "%s" .Values.ingress.host }}{{ end }}`,
    '{{.Values.ingress.host}}',
    '{{ .Values.ingress.host }',
    'a }} b',
  ]) {
    assert.throws(() => render(unknown, scope), undefined, unknown);
  }

  // Hostile shapes, each answered as the rules above say.
  const size = 10_000;

  assert.throws(() => render('{{ '.repeat(size), scope));
  assert.throws(() => render(`{{ ${'a'.repeat(size)}`, scope));
  assert.throws(() => render(`${off}${' '.repeat(size)}`, scope));
  assert.equal(render('{{ .Values.ingress.host }}'.repeat(size), scope), 'h.test'.repeat(size));
  // Deep nesting, shown and hidden, and one end short.
  assert.equal(render(`${on.repeat(size)}x${'{{ end }}'.repeat(size)}`, scope), 'x');
  assert.equal(render(`${off.repeat(size)}x${'{{ end }}'.repeat(size)}`, scope), '');
  assert.equal(
    render(`${on}${off.repeat(size)}x${'{{ end }}'.repeat(size)}y{{ end }}`, scope),
    'y',
  );
  assert.throws(() => render(`${on.repeat(size)}x${'{{ end }}'.repeat(size - 1)}`, scope));
  // A long run of white space that does not end the text it trims.
  assert.equal(
    render(`${' '.repeat(size)}x ${'\t'.repeat(size)}{{- .Values.ingress.host }}`, scope),
    `${' '.repeat(size)}xh.test`,
  );
  assert.equal(
    render(`{{ .Values.ingress.host -}}${' \n'.repeat(size)}x${' '.repeat(size)}`, scope),
    `h.testx${' '.repeat(size)}`,
  );
});

test('ingressValues: reads the section as values.yaml writes it, and refuses a shape it cannot read', () => {
  assert.deepEqual(
    ingressValues(
      "x: 1\ningress:\n  host: h # a comment\n  # a line\n  tls:\n    enabled: true\n    name: 'q'\n  rate:\n    average: 0\nnext:\n  host: no\n",
    ),
    { ingress: { host: 'h', tls: { enabled: 'true', name: 'q' }, rate: { average: '0' } } },
  );
  assert.throws(() => ingressValues('ingress:\n  hosts:\n    - a\n'));
  assert.throws(() => ingressValues('ingress:\n  text: |\n    a\n'));
  assert.throws(() => ingressValues('nothing: here\n'));

  // Hostile lines, each answered as the rules above say.
  const size = 10_000;

  assert.throws(() => ingressValues(`ingress:\n  ${'a'.repeat(size)}`));
  assert.throws(() => ingressValues(`ingress:\n  k: ${'-'.repeat(size)}`));
  assert.deepEqual(ingressValues(`ingress:\n  k: a${' '.repeat(size)}b`), {
    ingress: { k: `a${' '.repeat(size)}b` },
  });
  assert.deepEqual(ingressValues(`ingress:\n  k: a${' \t'.repeat(size)}# x`), {
    ingress: { k: 'a' },
  });
});

/** The pipeline, where the inspector's address is set (D274). */
const PIPELINE = new URL('../.gitlab-ci.yml', import.meta.url);

/** The top-level key `name` of a GitLab CI file, from its line to the next one's. */
function pipelineKey(text, name) {
  const start = text.indexOf(`\n${name}:\n`);

  assert.ok(start >= 0, `${name} is not in the pipeline`);

  const rest = text.slice(start + 1);
  const end = rest.search(/\n(?![\s#])/);

  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** A line of `.inspector-address` setting `name`, and its value; `null` without one. */
function addressLine(name, pipeline = readFileSync(PIPELINE, 'utf8')) {
  return new RegExp(`^ {4}${name}: '(https://[a-z0-9.-]+)'\n`, 'm').exec(
    pipelineKey(pipeline, '.inspector-address'),
  );
}

/** The site's second host as the pipeline gives it to the chart (D275), `webhook.qa-tools.ru` today. */
function pipelineAliasHost() {
  const alias = addressLine('APP_ALIAS_ORIGIN');

  assert.ok(alias, '.inspector-address sets no APP_ALIAS_ORIGIN');

  return new URL(alias[1]).host;
}

test("the inspector's address: .gitlab-ci.yml names each origin once, and the frontend image, the chart, the environment and the smoke take them from there (#320, D274, D275)", () => {
  const pipeline = readFileSync(PIPELINE, 'utf8');
  const app = addressLine('APP_ORIGIN', pipeline);
  const receive = addressLine('RECEIVE_ORIGIN', pipeline);
  const alias = addressLine('APP_ALIAS_ORIGIN', pipeline);

  // The three values, whatever they are: a change of address (#324) is these
  // lines. Each passes the deploy job's own check, and nothing else in the
  // pipeline outside comments names production or any of the hosts.
  assert.ok(app && receive, '.inspector-address sets no APP_ORIGIN or RECEIVE_ORIGIN');
  assert.ok(alias, '.inspector-address sets no APP_ALIAS_ORIGIN');
  assert.equal(deployHosts(app[1], receive[1], alias[1]).status, 0);

  const rest = uncommented(pipeline)
    .replace(app[0], '')
    .replace(receive[0], '')
    .replace(alias[0], '');

  for (const name of [
    'qa-tools.ru',
    new URL(app[1]).host,
    new URL(receive[1]).host,
    new URL(alias[1]).host,
  ]) {
    assert.ok(!rest.includes(name), `the pipeline names ${name} outside .inspector-address`);
  }
  // Not global: the test jobs' backend expects them unset. The comments
  // before .inspector-address, which this key's text runs into, may name them.
  assert.doesNotMatch(uncommented(pipelineKey(pipeline, 'variables')), /ORIGIN/);

  const image = pipelineKey(pipeline, '.image');
  const frontend = pipelineKey(pipeline, 'image:frontend');

  assert.equal(image.split('docker build --pull $BUILD_ARGS -f ').length - 1, 2);
  assert.equal(image.split('docker build').length - 1, 2);
  assert.match(image, /^ {2}extends: \.inspector-address$/m);
  assert.match(frontend, /^ {2}extends: \.image$/m);
  assert.match(
    frontend,
    /^ {4}BUILD_ARGS: '--build-arg APP_ORIGIN --build-arg RECEIVE_ORIGIN --build-arg APP_ALIAS_ORIGIN'$/m,
  );
  for (const job of ['image:backend', 'image:postgres']) {
    assert.doesNotMatch(pipelineKey(pipeline, job), /BUILD_ARGS/, job);
  }

  const dockerfile = readFileSync(new URL('../apps/frontend/Dockerfile', import.meta.url), 'utf8');
  const build = dockerfile.indexOf('RUN npm run build');

  for (const argument of ['ARG APP_ORIGIN\n', 'ARG RECEIVE_ORIGIN\n', 'ARG APP_ALIAS_ORIGIN\n']) {
    const at = dockerfile.indexOf(`\n${argument}`);

    assert.ok(at > dockerfile.indexOf('RUN npm ci') && at < build, argument);
  }

  const deploy = pipelineKey(pipeline, 'deploy');

  assert.match(deploy, /^ {2}extends: \.inspector-address$/m);
  assert.match(deploy, /^ {2}environment:\n {4}name: production\n {4}url: \$APP_ORIGIN$/m);
  for (const value of [
    'ingress.host="${APP_ORIGIN#https://}"',
    'ingress.aliasHost="${APP_ALIAS_ORIGIN#https://}"',
    'receive.host="${RECEIVE_ORIGIN#https://}"',
    'alerts.siteUrl="$APP_ORIGIN"',
  ]) {
    assert.equal(deploy.split(`--set-string ${value}\n`).length - 1, 1, value);
  }
  assert.ok(deploy.indexOf('for name in') < deploy.indexOf('- helm upgrade --install'));

  const smoke = pipelineKey(pipeline, 'deployment-smoke');

  assert.match(smoke, /^ {2}extends: \.inspector-address$/m);
  assert.ok(
    smoke.includes(
      '- node scripts/check-deployment.mjs "$APP_ORIGIN" "$RECEIVE_ORIGIN" "$APP_ALIAS_ORIGIN"\n',
    ),
  );
  // Room for the second host's certificate wait, about 5 minutes, and the
  // checks after it (D275).
  assert.match(smoke, /^ {2}timeout: 10m$/m);
});

/**
 * The deploy job's check of the origins, as the runner's shell runs it: the
 * first item of its script, the pattern of a label too long included (#340).
 */
function originCheck() {
  const deploy = pipelineKey(readFileSync(PIPELINE, 'utf8'), 'deploy');
  const block = /\n( +)script:\n\1 {2}- \|\n((?:\1 {4}[^\n]*\n)+)/.exec(deploy);

  assert.ok(
    block?.[2].includes('for name in APP_ORIGIN RECEIVE_ORIGIN APP_ALIAS_ORIGIN; do\n'),
    'the deploy job checks no origin',
  );

  return block[2]
    .split('\n')
    .map((line) => line.slice(block[1].length + 4))
    .join('\n');
}

/**
 * The check's exit status, the hosts the chart would be given - the site's,
 * the receive host's and, when there is a second site origin, its host - and
 * what it printed, under `shell`: `sh` as the runner's image has it, or
 * `bash`.
 */
function deployHosts(appOrigin, receiveOrigin, aliasOrigin = '', shell = 'sh') {
  const run = spawnSync(
    shell,
    [
      '-c',
      `${originCheck()}printf '%s %s' "\${APP_ORIGIN#https://}" "\${RECEIVE_ORIGIN#https://}"; ` +
        `if [ -n "\${APP_ALIAS_ORIGIN#https://}" ]; then printf ' %s' "\${APP_ALIAS_ORIGIN#https://}"; fi`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        APP_ORIGIN: appOrigin,
        RECEIVE_ORIGIN: receiveOrigin,
        APP_ALIAS_ORIGIN: aliasOrigin,
      },
    },
  );

  return run.status === 0
    ? { status: 0, hosts: run.stdout.toString() }
    : { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** The deploy job's refusal of `name`, which names it and never its value. */
const refusalOf = (name) =>
  `${name} must be https:// and a host name alone; its value is not printed\n`;

test("the deploy job's check of the two origins passes production's, giving the chart the hosts values.yaml has, and refuses anything but https:// and a host name (D274)", () => {
  const values = readFileSync(VALUES, 'utf8');
  const valueOf = (pattern) => pattern.exec(values)?.[1];

  // Production's two origins give the chart the hosts its own values name,
  // so production renders as it did before the deploy job set them.
  assert.deepEqual(deployHosts('https://qa-tools.ru', 'https://hook.qa-tools.ru'), {
    status: 0,
    hosts: `${valueOf(/^ingress:\n(?: +#[^\n]*\n)* +host: (\S+)$/m)} ${valueOf(/^receive:\n(?: +#[^\n]*\n)* +host: (\S+)$/m)}`,
  });
  assert.equal(valueOf(/^ {2}siteUrl: (\S+)$/m), 'https://qa-tools.ru');
  assert.deepEqual(deployHosts('https://inspector.example', 'https://hook.inspector.example'), {
    status: 0,
    hosts: 'inspector.example hook.inspector.example',
  });

  for (const origin of [
    '',
    'qa-tools.ru',
    'http://qa-tools.ru',
    'https://',
    'https://qa-tools.ru/',
    'https://qa-tools.ru/path',
    'https://qa-tools.ru:443',
    'https://Qa-Tools.ru',
    'https://qa-tools.ru?x=1',
    'https://user@qa-tools.ru',
    'https://a b',
    'https://a\nb',
    'https://$(touch x)',
    'https://*',
    'https://https://qa-tools.ru',
  ]) {
    assert.deepEqual(
      deployHosts(origin, 'https://hook.qa-tools.ru'),
      { status: 1, output: refusalOf('APP_ORIGIN') },
      JSON.stringify(origin),
    );
    assert.deepEqual(
      deployHosts('https://qa-tools.ru', origin),
      { status: 1, output: refusalOf('RECEIVE_ORIGIN') },
      JSON.stringify(origin),
    );
  }

  // A credential pasted into either value is not in the job's output, under
  // either shell, and neither is anything else of the value.
  const secret = 'Zq7xK2mW9pL4vN8';

  for (const shell of ['sh', 'bash']) {
    for (const origin of [
      `https://user:${secret}@inspector.example`,
      `https://${secret}@inspector.example`,
      `https://inspector.example/?token=${secret}`,
      `https://inspector.example\n${secret}`,
      `${secret}`,
    ]) {
      const app = deployHosts(origin, 'https://hook.inspector.example', '', shell);
      const receive = deployHosts('https://inspector.example', origin, '', shell);
      const alias = deployHosts(
        'https://inspector.example',
        'https://hook.inspector.example',
        origin,
        shell,
      );

      assert.deepEqual(app, { status: 1, output: refusalOf('APP_ORIGIN') }, `${shell} ${origin}`);
      assert.deepEqual(receive, { status: 1, output: refusalOf('RECEIVE_ORIGIN') }, shell);
      assert.deepEqual(alias, { status: 1, output: refusalOf('APP_ALIAS_ORIGIN') }, shell);
      assert.ok(
        !app.output.includes(secret) &&
          !receive.output.includes(secret) &&
          !alias.output.includes(secret),
        shell,
      );
    }
  }

  // At growing sizes, a long host of many labels passes and the same with
  // one character more than a host has is refused.
  for (const size of [10, 1000, 100_000]) {
    const host = `${'a.'.repeat(size / 2)}example`;

    assert.deepEqual(deployHosts(`https://${host}`, 'https://hook.example'), {
      status: 0,
      hosts: `${host} hook.example`,
    });
    assert.deepEqual(deployHosts(`https://${host}/`, 'https://hook.example'), {
      status: 1,
      output: refusalOf('APP_ORIGIN'),
    });
    assert.deepEqual(deployHosts('https://example', `https://${'/'.repeat(size)}`), {
      status: 1,
      output: refusalOf('RECEIVE_ORIGIN'),
    });
    assert.deepEqual(
      deployHosts(`https://user:${'s'.repeat(size)}@example`, 'https://hook.example'),
      {
        status: 1,
        output: refusalOf('APP_ORIGIN'),
      },
    );
  }
});

test("the deploy job's check of the second site origin: empty is none, production's passes, and anything but https:// and a host name of its own is refused (#319, D275)", () => {
  const app = 'https://qa-tools.ru';
  const receive = 'https://hook.qa-tools.ru';

  // None: the chart is given the two hosts alone and an empty aliasHost.
  assert.deepEqual(deployHosts(app, receive, ''), {
    status: 0,
    hosts: 'qa-tools.ru hook.qa-tools.ru',
  });
  assert.deepEqual(deployHosts(app, receive, `https://${pipelineAliasHost()}`), {
    status: 0,
    hosts: `qa-tools.ru hook.qa-tools.ru ${pipelineAliasHost()}`,
  });
  assert.deepEqual(
    deployHosts(
      'https://inspector.example',
      'https://hook.inspector.example',
      'https://next.example',
    ),
    { status: 0, hosts: 'inspector.example hook.inspector.example next.example' },
  );

  // The site's own origin or the receive host's is no second host.
  for (const same of [app, receive]) {
    assert.deepEqual(deployHosts(app, receive, same), {
      status: 1,
      output: 'APP_ALIAS_ORIGIN must name a host of its own; its value is not printed\n',
    });
  }

  for (const origin of [
    ' ',
    'webhook.qa-tools.ru',
    'http://webhook.qa-tools.ru',
    'https://',
    'https://webhook.qa-tools.ru/',
    'https://webhook.qa-tools.ru:443',
    'https://Webhook.qa-tools.ru',
    'https://webhook.qa-tools.ru?x=1',
    'https://user@webhook.qa-tools.ru',
    'https://a b',
    'https://a\nb',
    'https://$(touch x)',
    'https://*',
    'https://https://webhook.qa-tools.ru',
  ]) {
    assert.deepEqual(
      deployHosts(app, receive, origin),
      { status: 1, output: refusalOf('APP_ALIAS_ORIGIN') },
      JSON.stringify(origin),
    );
  }

  // At growing sizes, a long host of many labels passes and one character
  // more is refused.
  for (const size of [10, 1000, 100_000]) {
    const host = `${'w.'.repeat(size / 2)}example`;

    assert.deepEqual(deployHosts(app, receive, `https://${host}`), {
      status: 0,
      hosts: `qa-tools.ru hook.qa-tools.ru ${host}`,
    });
    assert.deepEqual(deployHosts(app, receive, `https://${host}/`), {
      status: 1,
      output: refusalOf('APP_ALIAS_ORIGIN'),
    });
    assert.deepEqual(deployHosts(app, receive, `https://${'/'.repeat(size)}`), {
      status: 1,
      output: refusalOf('APP_ALIAS_ORIGIN'),
    });
  }
});

test("the deploy job's check refuses a host that is no host name under sh and bash, with its line, and passes production's three origins (#340)", () => {
  const production = ['APP_ORIGIN', 'RECEIVE_ORIGIN', 'APP_ALIAS_ORIGIN'].map((name) => {
    const line = addressLine(name);

    assert.ok(line, `.inspector-address sets no ${name}`);

    return line[1];
  });
  const hostsOf = (origins) => origins.map((origin) => new URL(origin).host).join(' ');
  const app = 'https://inspector.example';
  const receive = 'https://hook.inspector.example';
  // Each of the three variables given `origin`, the other two good, under `shell`.
  const refusedEverywhere = (origin, shell) => {
    assert.deepEqual(
      deployHosts(origin, receive, '', shell),
      { status: 1, output: refusalOf('APP_ORIGIN') },
      `${shell} APP_ORIGIN ${JSON.stringify(origin.slice(0, 80))}`,
    );
    assert.deepEqual(
      deployHosts(app, origin, '', shell),
      { status: 1, output: refusalOf('RECEIVE_ORIGIN') },
      `${shell} RECEIVE_ORIGIN ${JSON.stringify(origin.slice(0, 80))}`,
    );
    assert.deepEqual(
      deployHosts(app, receive, origin, shell),
      { status: 1, output: refusalOf('APP_ALIAS_ORIGIN') },
      `${shell} APP_ALIAS_ORIGIN ${JSON.stringify(origin.slice(0, 80))}`,
    );
  };
  const passed = (origin, shell) =>
    assert.deepEqual(
      deployHosts(app, receive, origin, shell),
      { status: 0, hosts: hostsOf([app, receive, origin]) },
      `${shell} ${JSON.stringify(origin.slice(0, 80))}`,
    );

  for (const shell of ['sh', 'bash']) {
    // Production's values, as .inspector-address sets them, give the chart
    // their hosts as before.
    assert.deepEqual(deployHosts(...production, shell), {
      status: 0,
      hosts: hostsOf(production),
    });

    // An empty label, a dot or a hyphen at either end, a hyphen beside a
    // dot, and a label of 64 characters or more.
    for (const origin of [
      'https://-',
      'https://.',
      'https://a..b',
      'https://a.b.',
      'https://-a.example',
      'https://a-.example',
      'https://..',
      'https://.a',
      'https://a.-b',
      'https://a.b-',
      'https://--',
      `https://${'a'.repeat(64)}`,
      `https://${'a'.repeat(64)}.example`,
      `https://a.${'b'.repeat(64)}`,
      `https://a.${'b'.repeat(64)}.example`,
    ]) {
      refusedEverywhere(origin, shell);
    }

    // Host names: labels of 63, inner hyphens two at a time, digits, punycode.
    for (const origin of [
      `https://${'a'.repeat(63)}.${'b'.repeat(63)}.example`,
      'https://a--b.0.example',
      'https://xn--e1afmkfd.xn--p1ai',
      'https://a1.b2',
      'https://x',
    ]) {
      passed(origin, shell);
    }

    // At growing sizes, hosts built to break the rule: one long label, a run
    // of dots or of hyphens, many labels with a trailing dot, an empty label,
    // a hyphen at either end of each, or a last label of 64; and many labels
    // of 63 with no dot missing, which pass.
    for (const size of [10, 1000, 100_000]) {
      const many = 'a.'.repeat(size / 2);

      refusedEverywhere(`https://${'a'.repeat(64 + size)}.example`, shell);
      refusedEverywhere(`https://${'.'.repeat(size)}`, shell);
      refusedEverywhere(`https://${'-'.repeat(size)}`, shell);
      refusedEverywhere(`https://${many}`, shell);
      refusedEverywhere(`https://${many}.a`, shell);
      refusedEverywhere(`https://${'a-.'.repeat(Math.ceil(size / 3))}example`, shell);
      refusedEverywhere(`https://${'-a.'.repeat(Math.ceil(size / 3))}example`, shell);
      refusedEverywhere(`https://${many}${'b'.repeat(64)}`, shell);
      passed(`https://${many}example`, shell);
      passed(`https://${`${'a'.repeat(63)}.`.repeat(Math.ceil(size / 64))}example`, shell);
    }
  }
});

test("the second site host: two Ingresses of its own with the first host's paths, a certificate of its own, noindex on every router and the edge rate limit on the API's, and the first host's Ingresses as they were (#319, D275)", () => {
  const aliasHost = pipelineAliasHost();
  const without = renderedIngress();
  const { scope, documents } = renderedIngress(RELEASE, { aliasHost });
  const kinds = documents.map((document) => /^kind: (\S+)$/m.exec(document)?.[1]);

  assert.equal(aliasHost, 'webhook.qa-tools.ru');
  assert.equal(without.scope.Values.ingress.aliasHost, '', 'values.yaml gives no second host');
  assert.deepEqual(kinds, ['Ingress', 'Ingress', 'Middleware', 'Ingress', 'Ingress', 'Middleware']);

  // The first host renders byte for byte as it does with no second host: its
  // certificate's hosts are unchanged, so it is not reissued, and neither
  // the noindex middleware nor anything else of the second host reaches it.
  assert.deepEqual(documents.slice(0, 3), without.documents);

  const [api, site] = documents.slice(0, 2).map(ingressOf);
  const [aliasApi, aliasSite] = documents.slice(3, 5).map(ingressOf);
  const noindex = documents[5];
  const noindexName = /^metadata:\n {2}name: (\S+)$/m.exec(noindex)[1];
  const host = scope.Values.ingress.host;

  assert.deepEqual(
    [aliasApi.name, aliasSite.name, noindexName],
    ['qa-tools-alias-api', 'qa-tools-alias', 'qa-tools-noindex'],
  );

  // Every answer on the second host carries X-Robots-Tag: noindex: the
  // middleware sets that one response header and does nothing else.
  assert.match(noindex, /^apiVersion: traefik\.io\/v1alpha1$/m);
  assert.match(
    noindex,
    /^spec:\n {2}headers:\n {4}customResponseHeaders:\n {6}X-Robots-Tag: noindex\n?$/m,
  );
  assert.equal(noindex.slice(noindex.indexOf('\nspec:\n')).trim().split('\n').length, 4);

  // noindex on both of the second host's Ingresses, first, so that the edge
  // rate limit's own 429 carries it; the rate limit on the API's alone; the
  // certificate asked for by the site's alone.
  assert.deepEqual(aliasApi.annotations, {
    'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure',
    'traefik.ingress.kubernetes.io/router.middlewares': `qa-tools-${noindexName}@kubernetescrd,qa-tools-qa-tools-api-rate-limit@kubernetescrd`,
  });
  assert.deepEqual(aliasSite.annotations, {
    'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure',
    'traefik.ingress.kubernetes.io/router.middlewares': `qa-tools-${noindexName}@kubernetescrd`,
    'cert-manager.io/cluster-issuer': 'letsencrypt-production',
  });
  for (const first of [api, site]) {
    assert.ok(
      !(first.annotations['traefik.ingress.kubernetes.io/router.middlewares'] ?? '').includes(
        noindexName,
      ),
      first.name,
    );
  }

  // The references are the namespace's, as the rate limit's are.
  const elsewhere = renderedIngress({ ...RELEASE, Namespace: 'elsewhere' }, { aliasHost });

  assert.equal(
    ingressOf(elsewhere.documents[4]).annotations[
      'traefik.ingress.kubernetes.io/router.middlewares'
    ],
    `elsewhere-${noindexName}@kubernetescrd`,
  );

  // Its own host, and a certificate of its own for that host alone, beside
  // the first host's; the first host's Ingresses name the first host alone.
  assert.deepEqual(aliasApi.hosts, [aliasHost]);
  assert.deepEqual(aliasSite.hosts, [aliasHost]);
  assert.deepEqual(aliasApi.tlsHosts, [aliasHost]);
  assert.deepEqual(aliasSite.tlsHosts, [aliasHost]);
  assert.equal(aliasSite.secretName, 'webhook-qa-tools-tls');
  assert.equal(aliasApi.secretName, aliasSite.secretName);
  assert.notEqual(aliasSite.secretName, site.secretName);
  for (const first of [api, site]) {
    assert.deepEqual(first.hosts, [host]);
    assert.deepEqual(first.tlsHosts, [host]);
    assert.equal(first.secretName, 'qa-tools-tls');
  }

  // The same paths to the same Services as the first host's.
  assert.deepEqual(aliasApi.paths, api.paths);
  assert.deepEqual(aliasSite.paths, site.paths);

  // Traefik ranks the second host's routers by their rules' lengths, as the
  // first's: Host(`webhook.qa-tools.ru`) && PathPrefix(`/`) is 46, and every
  // backend path's rule is longer.
  const catchAll = ruleOf(aliasHost, aliasSite.paths.at(-1));

  assert.equal(catchAll.length, 46);
  assert.deepEqual(
    [...aliasApi.paths, ...aliasSite.paths.slice(0, -1)].map(
      (path) => ruleOf(aliasHost, path).length,
    ),
    [50, 49, 49, 48],
  );

  // Without TLS, a render on its own: no certificate is asked for or named.
  const plain = renderedIngress(RELEASE, {
    aliasHost,
    tls: { ...scope.Values.ingress.tls, enabled: 'false' },
  });

  for (const document of plain.documents.filter((each) => /^kind: Ingress$/m.test(each))) {
    assert.doesNotMatch(document, /tls:|secretName|cert-manager/);
  }
});

test('the backend is given the second site origin as APP_ALIAS_ORIGIN when there is one, and nothing else of it (D275)', () => {
  const text = readFileSync(fileURLToPath(new URL('backend.yaml', TEMPLATES)), 'utf8');
  const block =
    /\n( +)\{\{- if \.Values\.ingress\.aliasHost \}\}\n((?:\1#.*\n)*)\1- name: APP_ALIAS_ORIGIN\n\1 {2}value: \{\{ printf "https:\/\/%s" \.Values\.ingress\.aliasHost \| quote \}\}\n\1\{\{- end \}\}\n/.exec(
      text,
    );

  assert.ok(block, 'backend.yaml gives no APP_ALIAS_ORIGIN from ingress.aliasHost');
  assert.equal(text.split('.Values.ingress.aliasHost').length - 1, 2);
  assert.equal(text.split('APP_ALIAS_ORIGIN').length - 1, 1);

  // No other template reads it but the Ingresses'.
  for (const name of readdirSync(fileURLToPath(TEMPLATES)).filter(
    (each) => each !== 'ingress.yaml' && each !== 'backend.yaml',
  )) {
    assert.doesNotMatch(
      readFileSync(fileURLToPath(new URL(name, TEMPLATES)), 'utf8'),
      /aliasHost|aliasSecretName/,
      name,
    );
  }
});
