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
//
// And the chart as an install with none of production's values renders it
// (#367), by scripts/chart-render.mjs, which renders the whole chart as helm
// does for the actions its templates use and refuses any other: with the two
// hosts alone it names no host, Secret, account or service of production's,
// and has no monitor and no off-server uploader; without them it refuses,
// naming them; each option renders when configured. The deploy job's script
// runs here under sh and bash against a stand-in for helm: it stops before
// `helm upgrade`, naming the variable, when one it needs is not set, refuses
// a value helm would split, and with production's CI/CD variables gives the
// chart production's values, which render production's names. The Ingress
// tests render production that way.
//
// And README.md's install commands (#395), read as text: every chart value
// its fenced shell blocks and its prose set with a `--set…` flag, and every
// key path its prose quotes alone, is a key of values.yaml - but what a helm
// command of another chart, cert-manager's, is given; and every command of
// its Install section but the variables it sets stands in "Installing on k3s
// with the chart" as the same command, read for its continuation lines and
// indentation alone. Each check is shown to fail on a mutated copy of the
// README or of the values, and its readers to survive made-up input at
// growing sizes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { URL, fileURLToPath } from 'node:url';
import {
  parseHelmArguments,
  parseYaml,
  parseYamlDocuments,
  renderChart,
  renderTemplates,
  setValue,
  toYaml,
} from './chart-render.mjs';

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
/* The renderer (#367).                                                     */
/* ------------------------------------------------------------------------ */

const CHART_DIR = fileURLToPath(new URL('../deploy/helm/qa-tools', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PIPELINE = new URL('../.gitlab-ci.yml', import.meta.url);
/** A public key for the off-server copy's tests; production's is its own variable. */
const RECIPIENT_PATH = fileURLToPath(new URL('fixtures/db-backup-recipient.asc', import.meta.url));

test('render: the actions and functions the chart uses, trimming as Go does, and any other refused', () => {
  const files = (text) => [
    ['templates/_helpers.tpl', '{{- define "x.name" -}}{{ .Release.Name }}{{- end -}}'],
    ['templates/t.yaml', text],
  ];
  const run = (text, values = {}) =>
    renderTemplates(files(text), {
      values: {
        host: 'h.test',
        none: '',
        on: true,
        off: false,
        n: 3000,
        map: { b: '2', a: 'x y' },
        ...values,
      },
      release: { name: 'rel', namespace: 'ns' },
      chart: { name: 'chart', version: '1.0.0' },
      readFile: (path) => (path === 'files/f' ? 'one\ntwo\n' : ''),
    })[0][1];

  assert.equal(run('a: {{ .Values.host }}\n'), 'a: h.test\n');
  assert.equal(run('{{ .Release.Namespace }}-{{ include "x.name" . }}@k'), 'ns-rel@k');
  assert.equal(run('a{{ if .Values.host }}b{{ end }}c'), 'abc');
  assert.equal(run('a{{ if .Values.none }}b{{ else if .Values.on }}c{{ else }}d{{ end }}e'), 'ace');
  assert.equal(run('a{{ if .Values.off }}b{{ else }}d{{ end }}e'), 'ade');
  assert.equal(run('x\n  {{- if .Values.on }}\n  y\n  {{- end }}\nz'), 'x\n  y\nz');
  assert.equal(run('x\n  {{- if .Values.off }}\n  y\n  {{- end }}\nz'), 'x\nz');
  assert.equal(run('{{- /* a\ncomment */ -}}\n  x'), 'x');
  assert.equal(
    run('{{ with .Values.host }}[{{ . | quote }}]{{ end }}{{ with .Values.none }}no{{ end }}'),
    '["h.test"]',
  );
  assert.equal(
    run('{{ .Values.n | quote }} {{ .Values.on | quote }} {{ "a\\"b" | quote }}'),
    '"3000" "true" "a\\"b"',
  );
  assert.equal(run('{{ printf "https://%s:%d" .Values.host .Values.n }}'), 'https://h.test:3000');
  assert.equal(run('{{ printf "%s-tls" (include "x.name" .) }}'), 'rel-tls');
  assert.equal(
    run('{{ .Values.none | default "d" }} {{ .Values.host | default "d" }}'),
    'd h.test',
  );
  assert.equal(
    run('{{ if not (and .Values.host .Values.none) }}one missing{{ end }}'),
    'one missing',
  );
  assert.equal(
    run('{{ if or .Values.none .Values.on }}y{{ end }}{{ if eq .Values.host "h.test" }}z{{ end }}'),
    'yz',
  );
  assert.equal(run('m:{{ toYaml .Values.map | nindent 2 }}'), 'm:\n  a: "x y"\n  b: "2"');
  assert.equal(run('f: |-\n  {{- .Files.Get "files/f" | nindent 2 }}'), 'f: |-\n  one\n  two\n  ');
  assert.equal(run('{{ required "need it" .Values.host }}'), 'h.test');
  assert.equal(run('{{ .Values.missing }}|{{ trimPrefix "https://" "https://a" }}'), '|a');
  assert.throws(() => run('{{ required "host must be set" .Values.none }}'), /host must be set/);
  assert.throws(() => run('{{ fail "refused, naming it" }}'), /refused, naming it/);
  assert.throws(() => run('{{ .Values.missing.deeper }}'), /nil pointer/);

  for (const unknown of [
    '{{ range .Values.map }}{{ end }}',
    '{{ $x := 1 }}',
    '{{ template "x.name" . }}',
    '{{ lower .Values.host }}',
    '{{ if .Values.on }}x',
    '{{ end }}',
    '{{ else }}',
    '{{ .Values.host }',
    'a }} b',
    '{{ .Values.host {{ }}',
    '{{ printf "%q" .Values.host }}',
    '{{ ( .Values.host }}',
    '{{ .Values.host ) }}',
    '{{ .Values.host | }}',
    '{{ .Values.map }}',
    '{{ "unterminated }}',
    '{{/* unterminated }}',
  ]) {
    assert.throws(() => run(unknown), undefined, unknown);
  }

  // Hostile shapes at growing sizes, each answered as the rules above say,
  // in time linear in their length: a run of openings, a long action, deep
  // nesting refused, long white space trimmed, many actions.
  for (const size of [10, 1000, 100_000]) {
    assert.throws(() => run('{{ '.repeat(size)));
    assert.throws(() => run(`{{ ${'a'.repeat(size)}`));
    assert.throws(() => run(`{{ "${'\\'.repeat(size)}`));
    assert.throws(
      () => run(`${'{{ if .Values.on }}'.repeat(size + 100)}x${'{{ end }}'.repeat(size + 100)}`),
      /deeper/,
    );
    assert.throws(
      () => run(`{{ ${'('.repeat(size + 100)}.Values.host${')'.repeat(size + 100)} }}`),
      /deeper/,
    );
    assert.equal(run('{{ .Values.host }}'.repeat(size)), 'h.test'.repeat(size));
    assert.equal(
      run(`${' '.repeat(size)}x ${'\t\n'.repeat(size)}{{- .Values.host }}`),
      `${' '.repeat(size)}xh.test`,
    );
    assert.equal(run(`{{ .Values.host -}}${' \n'.repeat(size)}x`), 'h.testx');
    assert.equal(run(`{{ "${'a'.repeat(size)}" | quote }}`), `"${'a'.repeat(size)}"`);
  }
});

test('parseYaml: the shapes values.yaml and the rendered documents have, and any other refused', () => {
  assert.deepEqual(
    parseYaml(
      [
        '# a comment',
        'a: 1 # a comment',
        "b: 'it''s # not a comment'",
        'c: "q\\"x\\n"',
        'd:',
        '  e: true',
        '  f: ""',
        '  g:',
        '    - x',
        '    - name: n',
        '      value: v',
        '    - "-c"',
        "h: ['a', b]",
        'i: {}',
        'j: |-',
        '    line one',
        '',
        '      two # kept',
        'k: |',
        '  x',
        'l:',
        '- 1',
        'm: Host(`a.b`) && PathPrefix(`/`)',
        'n: 10.5',
        'o: a@b:c',
      ].join('\n'),
    ),
    {
      a: 1,
      b: "it's # not a comment",
      c: 'q"x\n',
      d: { e: true, f: '', g: ['x', { name: 'n', value: 'v' }, '-c'] },
      h: ['a', 'b'],
      i: {},
      j: 'line one\n\n  two # kept',
      k: 'x\n',
      l: [1],
      m: 'Host(`a.b`) && PathPrefix(`/`)',
      n: 10.5,
      o: 'a@b:c',
    },
  );
  assert.equal(parseYaml('# only a comment\n'), null);
  assert.deepEqual(parseYamlDocuments('---\na: 1\n---\n# none\n---\n- b\n'), [{ a: 1 }, ['b']]);

  for (const unknown of [
    'a: &anchor x',
    'a: *alias',
    'a: !tag x',
    'a: >\n  folded',
    'a: |2\n  x',
    'a: x\n  b: y',
    'a: 1\na: 2',
    '\ta: 1',
    'a:\n\t- b',
    'a: "x',
    'a: "x"y"',
    "a: 'x",
    'a: [x, [y]]',
    'a: {b: c}',
    'a: "\\q"',
    'a: b\n- c',
  ]) {
    assert.throws(() => parseYaml(unknown), undefined, unknown);
  }

  // Nesting deeper than the reader reads is refused rather than recursed into.
  for (const depth of [101, 1001]) {
    assert.throws(
      () =>
        parseYaml(Array.from({ length: depth + 1 }, (_, at) => `${' '.repeat(at)}k:`).join('\n')),
      /deeper/,
    );
  }

  // Hostile shapes at growing sizes, linear in their length: long keys and
  // scalars, runs of quotes and backslashes, many entries, deep nesting
  // refused, a long block scalar.
  for (const size of [10, 1000, 100_000]) {
    assert.deepEqual(parseYaml(`${'k'.repeat(size)}: ${'v'.repeat(size)}`), {
      ['k'.repeat(size)]: 'v'.repeat(size),
    });
    assert.deepEqual(parseYaml(`a: "${'\\\\'.repeat(size)}"`), { a: '\\'.repeat(size) });
    assert.throws(() => parseYaml(`a: "${'\\'.repeat(2 * size + 1)}"`));
    assert.throws(() => parseYaml(`a: '${"'".repeat(2 * size)}`));
    assert.deepEqual(parseYaml(`a: '${"''".repeat(size)}'`), { a: "'".repeat(size) });
    assert.equal(
      Object.keys(parseYaml(Array.from({ length: size }, (_, at) => `k${at}: ${at}`).join('\n')))
        .length,
      size,
    );
    assert.equal(parseYaml(`a: |-\n${'  x #\n'.repeat(size)}`).a.length, size * 4 - 1);
    assert.equal(parseYaml(`a: [${'x, '.repeat(size)}y]`).a.length, size + 1);
    assert.throws(() => parseYaml(`a: [${'x,'.repeat(size)}]`));
  }
});

test('toYaml and parseHelmArguments: what the chart and the deploy job hand them', () => {
  for (const value of [
    { limits: { cpu: '500m', memory: '512Mi' }, requests: { cpu: '50m' } },
    {
      a: ['x', { b: 'y' }],
      c: {},
      d: [],
      e: null,
      f: true,
      g: 3,
      h: '0x1',
      i: 'yes',
      j: '- x',
      k: 'a: b',
    },
  ]) {
    assert.deepEqual(parseYaml(toYaml(value)), value);
  }

  const key = 'key.asc';
  const parsed = parseHelmArguments(
    [
      'upgrade',
      '--install',
      'rel',
      'chart',
      '--namespace',
      'ns',
      '--set-string',
      'a.b=c=d',
      '--set',
      'n=3',
      '--set-file',
      `k=${key}`,
      '--wait',
      '--timeout',
      '10m',
    ],
    (path) => `read ${path}`,
  );

  assert.deepEqual(parsed, {
    release: 'rel',
    chart: 'chart',
    namespace: 'ns',
    set: { 'a.b': 'c=d', n: 3, k: `read ${key}` },
    json: false,
  });
  for (const refused of [
    ['rel', 'chart', '--set-string', 'a=b,c'],
    ['rel', 'chart', '--set-string', 'a=b\\c'],
    ['rel', 'chart', '--set-string', '=b'],
    ['rel', 'chart', '--post-renderer', 'x'],
    ['rel'],
  ]) {
    assert.throws(() => parseHelmArguments(refused, () => ''), undefined, refused.join(' '));
  }
  assert.throws(() => setValue({}, 'a..b', 'x'));
});

/* ------------------------------------------------------------------------ */
/* Neutral defaults and the options (#367, criteria 1 and 2).               */
/* ------------------------------------------------------------------------ */

/** The values an installer with none of production's gives: the two hosts, and the images every install names (D022). */
const NEUTRAL = {
  'images.registry': 'registry.example/inspector',
  'images.tag': '0123456789abcdef0123456789abcdef01234567',
  'ingress.host': 'inspector.example',
  'receive.host': 'hook.inspector.example',
};
const BUCKET = {
  'backup.offsite.bucket': 'inspector-backups',
  'backup.offsite.endpoint': 'https://storage.example',
  'backup.offsite.region': 'region-1',
  'backup.offsite.recipientKey': readFileSync(RECIPIENT_PATH, 'utf8'),
};
const HEARTBEAT = { 'alerts.heartbeatUrl': 'https://heartbeat.example' };

/** The chart rendered as `release` with `set` over values.yaml: the documents. */
const rendered = (set, release = 'inspector', namespace = release) =>
  renderChart(CHART_DIR, { release, namespace, set }).documents;

const find = (documents, kind, name) =>
  documents.find((each) => each.kind === kind && each.metadata.name === name);
const podOf = (cronJob) => cronJob.spec.jobTemplate.spec.template.spec;
const envOf = (container) =>
  Object.fromEntries(
    (container.env ?? []).map((each) => [each.name, each.value ?? each.valueFrom]),
  );

/** Every key and value of `value`, at any depth, with the path to it. */
function* leaves(value, path = '') {
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield [`${path}/${key}`, key];
      yield* leaves(item, `${path}/${key}`);
    }
  } else {
    yield [path, String(value)];
  }
}

test("with the hosts alone the chart names nothing of production's: no host, Secret, account, bucket or service of ours, and the chart's own name in helm.sh/chart alone (#367, criterion 1)", () => {
  const documents = rendered(NEUTRAL);
  const named = [];

  for (const document of documents) {
    for (const [path, text] of leaves(document)) {
      // The chart's own name, qa-tools, in the label Helm's convention gives
      // it, is the one exception: renaming the chart is #335's.
      if (path.endsWith('/helm.sh/chart') && /^qa-tools-[\d.]+$/.test(text)) continue;
      if (/qa[-_]tools|statuser|yandex|firstvds/i.test(text)) {
        named.push(`${document.kind}/${document.metadata.name}${path}: ${text.slice(0, 80)}`);
      }
    }
  }

  assert.deepEqual(named, []);

  // The release's own names, Secrets included.
  assert.deepEqual(documents.map((each) => `${each.kind}/${each.metadata.name}`).sort(), [
    'Certificate/inspector-receive',
    'ConfigMap/inspector-db-backup',
    'CronJob/inspector-db-backup',
    'Deployment/inspector-backend',
    'Deployment/inspector-frontend',
    'Ingress/inspector',
    'Ingress/inspector-api',
    'IngressRouteTCP/inspector-receive',
    'Middleware/inspector-api-rate-limit',
    'ServersTransportTCP/inspector-receive',
    'Service/inspector-backend',
    'Service/inspector-frontend',
    'Service/inspector-postgres',
    'StatefulSet/inspector-postgres',
    'TLSOption/inspector-receive',
  ]);
  assert.equal(find(documents, 'Ingress', 'inspector').spec.tls[0].secretName, 'inspector-tls');
  assert.equal(
    find(documents, 'Certificate', 'inspector-receive').spec.secretName,
    'inspector-receive-tls',
  );
  assert.equal(
    envOf(find(documents, 'Deployment', 'inspector-backend').spec.template.spec.containers[0])
      .POSTGRES_PASSWORD.secretKeyRef.name,
    'inspector-postgres',
  );

  // No monitor, and a backup with neither notifier nor uploader: the local
  // dump alone, into the chart's own directory.
  const backup = podOf(find(documents, 'CronJob', 'inspector-db-backup'));

  assert.equal(backup.initContainers, undefined);
  assert.deepEqual(
    backup.containers.map((each) => each.name),
    ['db-backup'],
  );
  assert.deepEqual(
    Object.keys(envOf(backup.containers[0])).filter((name) => /OFFSITE|STATUS|NOTIFY/.test(name)),
    [],
  );
  assert.deepEqual(
    backup.volumes.map((each) => each.name),
    ['backup', 'scratch', 'script'],
  );
  assert.equal(backup.volumes[0].hostPath.path, '/var/backups/webhook-inspector');
  assert.deepEqual(Object.keys(find(documents, 'ConfigMap', 'inspector-db-backup').data), [
    'db-backup.sh',
  ]);
});

test('without either host, or the images, the chart refuses to render, naming what to set (#367, criterion 1)', () => {
  const hosts = /ingress\.host and receive\.host must both be set/;

  assert.throws(() => rendered({ ...NEUTRAL, 'ingress.host': '' }), hosts);
  assert.throws(() => rendered({ ...NEUTRAL, 'receive.host': '' }), hosts);
  assert.throws(() => rendered({ ...NEUTRAL, 'ingress.host': '', 'receive.host': '' }), hosts);
  assert.throws(
    () => rendered({ ...NEUTRAL, 'images.registry': '' }),
    /images\.registry must be set/,
  );
  assert.throws(() => rendered({ ...NEUTRAL, 'images.tag': '' }), /images\.tag must be set/);
});

test('the off-server copy renders with a bucket alone, and the monitor and the backup notifier with a heartbeat URL alone, each as before (#367, criterion 2)', () => {
  for (const [bucket, heartbeat] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const label = `bucket ${bucket}, heartbeat ${heartbeat}`;
    const documents = rendered({
      ...NEUTRAL,
      ...(bucket ? BUCKET : {}),
      ...(heartbeat ? HEARTBEAT : {}),
    });
    const backup = podOf(find(documents, 'CronJob', 'inspector-db-backup'));
    const sidecars = (backup.initContainers ?? []).map((each) => each.name);
    const env = envOf(backup.containers[0]);
    const data = Object.keys(find(documents, 'ConfigMap', 'inspector-db-backup').data);

    assert.deepEqual(
      sidecars,
      [...(heartbeat ? ['db-backup-notify'] : []), ...(bucket ? ['db-backup-offsite'] : [])],
      label,
    );
    assert.deepEqual(
      data,
      [
        'db-backup.sh',
        ...(heartbeat ? ['db-backup-notify.mjs'] : []),
        ...(bucket ? ['db-backup-offsite.mjs', 'db-backup-recipient.asc'] : []),
      ],
      label,
    );
    assert.equal(Boolean(find(documents, 'CronJob', 'inspector-monitor')), heartbeat, label);
    assert.equal(Boolean(find(documents, 'ConfigMap', 'inspector-monitor')), heartbeat, label);
    assert.equal('BACKUP_STATUS_FILE' in env, heartbeat, label);
    assert.equal(
      'BACKUP_OFFSITE_DIR' in env && 'BACKUP_OFFSITE_RECIPIENT_FILE' in env,
      bucket,
      label,
    );
    assert.deepEqual(
      backup.volumes.map((each) => each.name),
      [
        'backup',
        'scratch',
        ...(heartbeat ? ['status'] : []),
        ...(bucket ? ['offsite'] : []),
        'script',
      ],
      label,
    );

    if (bucket) {
      const uploader = envOf(backup.initContainers.at(-1));

      assert.deepEqual(
        [
          uploader.OFFSITE_BUCKET,
          uploader.OFFSITE_ENDPOINT,
          uploader.OFFSITE_REGION,
          uploader.OFFSITE_DATABASE,
        ],
        ['inspector-backups', 'https://storage.example', 'region-1', 'inspector'],
      );
      assert.equal(uploader.OFFSITE_ACCESS_KEY_ID.secretKeyRef.name, 'inspector-offsite-backup');
      // The key the installer gave, as the file it was, but for the final
      // newline a `|-` block drops.
      assert.equal(
        find(documents, 'ConfigMap', 'inspector-db-backup').data['db-backup-recipient.asc'],
        BUCKET['backup.offsite.recipientKey'].trimEnd(),
      );
    }

    if (heartbeat) {
      const monitor = envOf(podOf(find(documents, 'CronJob', 'inspector-monitor')).containers[0]);

      assert.equal(monitor.MONITOR_HEARTBEAT_URL, 'https://heartbeat.example');
      assert.equal(monitor.MONITOR_SITE_URL, 'https://inspector.example');
      assert.equal(monitor.MONITOR_RECEIVE_URL, 'https://hook.inspector.example');
      assert.equal(monitor.MONITOR_SITE_TOKEN.secretKeyRef.name, 'inspector-heartbeat');
      assert.equal(
        envOf(backup.initContainers[0]).NOTIFY_TOKEN.secretKeyRef.name,
        'inspector-heartbeat',
      );
    }
  }

  // A bucket without what the copy needs is refused, naming the value.
  for (const missing of ['endpoint', 'region', 'recipientKey']) {
    assert.throws(
      () => rendered({ ...NEUTRAL, ...BUCKET, [`backup.offsite.${missing}`]: '' }),
      new RegExp(`backup\\.offsite\\.${missing} must be set when backup\\.offsite\\.bucket is`),
    );
  }

  // Secret names and the site probed, given, win over the derived ones.
  const given = rendered({
    ...NEUTRAL,
    ...BUCKET,
    ...HEARTBEAT,
    'backup.offsite.existingSecret': 'storage-key',
    'alerts.existingSecret': 'beats',
    'alerts.siteUrl': 'https://inspector.example/',
  });
  const monitor = envOf(podOf(find(given, 'CronJob', 'inspector-monitor')).containers[0]);

  assert.equal(monitor.MONITOR_SITE_TOKEN.secretKeyRef.name, 'beats');
  assert.equal(monitor.MONITOR_SITE_URL, 'https://inspector.example/');
  assert.equal(
    envOf(podOf(find(given, 'CronJob', 'inspector-db-backup')).initContainers[1])
      .OFFSITE_SECRET_ACCESS_KEY.secretKeyRef.name,
    'storage-key',
  );
});

/* ------------------------------------------------------------------------ */
/* The deploy job (#367, criteria 3 and 4; D274, D275, #340).               */
/* ------------------------------------------------------------------------ */

/** The top-level key `name` of a GitLab CI file, from its line to the next one's. */
function pipelineKey(text, name) {
  const start = text.indexOf(`\n${name}:\n`);

  assert.ok(start >= 0, `${name} is not in the pipeline`);

  const rest = text.slice(start + 1);
  const end = rest.search(/\n(?![\s#])/);

  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** A job's first script item, a `- |` block holding `marker`, as the runner's shell runs it. */
function firstScript(job, marker) {
  const text = pipelineKey(readFileSync(PIPELINE, 'utf8'), job);
  const block = /\n( +)script:\n\1 {2}- \|\n((?:(?:\1 {4}[^\n]*)?\n)+)/.exec(text);

  assert.ok(block?.[2].includes(marker), `${job}'s first script item runs no ${marker}`);

  return block[2]
    .split('\n')
    .map((line) => line.slice(block[1].length + 4))
    .join('\n');
}

/** The deploy job's first script item, the checks and `helm upgrade`. */
const DEPLOY_SCRIPT = firstScript('deploy', 'helm upgrade --install');

/**
 * Production's CI/CD variables as set and read back on 2026-11-03 (#367;
 * their record is the operator's, outside this repository), the runner's
 * own and the recipient key given as a stand-in's file: with these the deploy
 * job gives the chart production's values, the frontend image names
 * production's operator, and the jobs land on production's runners.
 */
const PRODUCTION = Object.freeze({
  CI_REGISTRY_IMAGE: 'registry.gitlab.com/qa-tools-team/webhook-inspector',
  CI_COMMIT_SHA: 'a'.repeat(40),
  QA_TOOLS_RUNNER_TAG: 'qa-tools-ci',
  DEPLOY_RUNNER_TAG: 'qa-tools-vps',
  DEPLOY_APP_ORIGIN: 'https://qa-tools.ru',
  DEPLOY_RECEIVE_ORIGIN: 'https://hook.qa-tools.ru',
  DEPLOY_APP_ALIAS_ORIGIN: 'https://webhook.qa-tools.ru',
  DEPLOY_ALIAS_TLS_SECRET: 'webhook-qa-tools-tls',
  DEPLOY_RECEIVE_TLS_SECRET: 'hook-qa-tools-tls',
  DEPLOY_POSTGRES_USER: 'qa_tools',
  DEPLOY_POSTGRES_DATABASE: 'qa_tools',
  DEPLOY_BACKUP_HOST_PATH: '/var/backups/qa-tools/nightly',
  DEPLOY_BACKUP_BUCKET: 'qa-tools-backups',
  DEPLOY_BACKUP_ENDPOINT: 'https://storage.yandexcloud.net',
  DEPLOY_BACKUP_REGION: 'ru-central1',
  DEPLOY_BACKUP_SECRET: 'qa-tools-offsite-backup',
  DEPLOY_BACKUP_RECIPIENT_KEY: RECIPIENT_PATH,
  DEPLOY_HEARTBEAT_URL: 'https://hb.statuser.cloud',
  DEPLOY_HEARTBEAT_SECRET: 'qa-tools-statuser',
  DEPLOY_STATUS_PAGE_URL: 'https://status.qa-tools.ru/',
  DEPLOY_CONTACT_EMAIL: 'contact@qa-tools.ru',
  DEPLOY_OPERATOR_TEXTS: 'true',
});

/** The variables an unset or empty one stops the deploy job for, whatever the others hold: what every installation needs. */
const VALUE_NEEDED = [
  'DEPLOY_APP_ORIGIN',
  'DEPLOY_RECEIVE_ORIGIN',
  'DEPLOY_RECEIVE_TLS_SECRET',
  'DEPLOY_POSTGRES_USER',
  'DEPLOY_POSTGRES_DATABASE',
  'DEPLOY_BACKUP_HOST_PATH',
];

/** The options: an unset one stops the deploy job, an empty one is off. */
const OPTIONS = ['DEPLOY_APP_ALIAS_ORIGIN', 'DEPLOY_BACKUP_BUCKET', 'DEPLOY_HEARTBEAT_URL'];

/** The variables an unset one stops the deploy job for, whatever the others hold, in the order it names them. */
const ALWAYS_NEEDED = [...VALUE_NEEDED, ...OPTIONS];

// A stand-in helm that records its arguments, NUL-separated, and does nothing else.
const STAND_INS = mkdtempSync(join(tmpdir(), 'chart-test-helm-'));
let runs = 0;

writeFileSync(
  join(STAND_INS, 'helm'),
  '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\0\' "$arg"; done > "$HELM_ARGS"\n',
  {
    mode: 0o755,
  },
);
after(() => rmSync(STAND_INS, { recursive: true, force: true }));

/** The deploy job's script under `shell` with exactly `variables`: its status, its output and helm's arguments, or null when helm was not run. */
function deployJob(variables, shell = 'sh') {
  const record = join(STAND_INS, `args-${(runs += 1)}`);
  const run = spawnSync(shell, ['-c', DEPLOY_SCRIPT], {
    env: { PATH: `${STAND_INS}:${process.env.PATH}`, HELM_ARGS: record, ...variables },
    encoding: 'utf8',
  });
  let helm = null;

  try {
    helm = readFileSync(record, 'utf8').split('\0').slice(0, -1);
    rmSync(record);
  } catch {
    // helm was not run.
  }

  return { status: run.status, output: `${run.stdout}${run.stderr}`, helm };
}

/** The chart rendered from the arguments the deploy job gave helm, its chart path the repository's. */
function renderedFrom(helm, namespace) {
  const parsed = parseHelmArguments(helm);

  return renderChart(join(ROOT, parsed.chart), {
    release: parsed.release,
    namespace: namespace ?? parsed.namespace,
    set: parsed.set,
  });
}

/** The documents of one template file, in its order. */
const fileDocuments = (result, file) =>
  parseYamlDocuments(result.texts.find(([name]) => name === file)[1]);

const PRODUCTION_RUN = deployJob(PRODUCTION);

test("the deploy job gives helm production's values from the CI/CD variables, and the chart renders production's names with them (#367, criterion 3)", () => {
  assert.deepEqual(PRODUCTION_RUN, {
    status: 0,
    output: '',
    helm: [
      'upgrade',
      '--install',
      'qa-tools',
      'deploy/helm/qa-tools',
      '--namespace',
      'qa-tools',
      '--set-string',
      'images.registry=registry.gitlab.com/qa-tools-team/webhook-inspector',
      '--set-string',
      `images.tag=${'a'.repeat(40)}`,
      '--set-string',
      'ingress.host=qa-tools.ru',
      '--set-string',
      'receive.host=hook.qa-tools.ru',
      '--set-string',
      'alerts.siteUrl=https://qa-tools.ru',
      '--set-string',
      'ingress.aliasHost=webhook.qa-tools.ru',
      '--set-string',
      'ingress.tls.aliasSecretName=webhook-qa-tools-tls',
      '--set-string',
      'receive.tlsSecretName=hook-qa-tools-tls',
      '--set-string',
      'postgres.user=qa_tools',
      '--set-string',
      'postgres.database=qa_tools',
      '--set-string',
      'backup.hostPath=/var/backups/qa-tools/nightly',
      '--set-string',
      'backup.offsite.bucket=qa-tools-backups',
      '--set-string',
      'backup.offsite.endpoint=https://storage.yandexcloud.net',
      '--set-string',
      'backup.offsite.region=ru-central1',
      '--set-string',
      'backup.offsite.existingSecret=qa-tools-offsite-backup',
      '--set-string',
      'alerts.heartbeatUrl=https://hb.statuser.cloud',
      '--set-string',
      'alerts.existingSecret=qa-tools-statuser',
      '--set-file',
      `backup.offsite.recipientKey=${RECIPIENT_PATH}`,
      '--wait',
      '--timeout',
      '10m',
    ],
  });

  const { documents } = renderedFrom(PRODUCTION_RUN.helm);
  const backend = find(documents, 'Deployment', 'qa-tools-backend').spec.template.spec
    .containers[0];
  const postgres = find(documents, 'StatefulSet', 'qa-tools-postgres').spec.template.spec
    .containers[0];
  const backup = podOf(find(documents, 'CronJob', 'qa-tools-db-backup'));
  const monitor = envOf(podOf(find(documents, 'CronJob', 'qa-tools-monitor')).containers[0]);

  assert.deepEqual(
    [
      find(documents, 'Ingress', 'qa-tools').spec.tls[0],
      find(documents, 'Ingress', 'qa-tools-alias').spec.tls[0],
    ],
    [
      { hosts: ['qa-tools.ru'], secretName: 'qa-tools-tls' },
      { hosts: ['webhook.qa-tools.ru'], secretName: 'webhook-qa-tools-tls' },
    ],
  );
  assert.deepEqual(
    find(documents, 'Certificate', 'qa-tools-receive').spec.secretName,
    'hook-qa-tools-tls',
  );
  assert.deepEqual(find(documents, 'Certificate', 'qa-tools-receive').spec.dnsNames, [
    'hook.qa-tools.ru',
  ]);
  assert.deepEqual(
    [envOf(backend).DATABASE_URL, envOf(backend).POSTGRES_PASSWORD.secretKeyRef.name],
    [
      'postgres://qa_tools:$(POSTGRES_PASSWORD)@qa-tools-postgres:5432/qa_tools',
      'qa-tools-postgres',
    ],
  );
  assert.deepEqual(
    [envOf(backend).APP_ORIGIN, envOf(backend).RECEIVE_ORIGIN, envOf(backend).APP_ALIAS_ORIGIN],
    ['https://qa-tools.ru', 'https://hook.qa-tools.ru', 'https://webhook.qa-tools.ru'],
  );
  assert.deepEqual(
    [envOf(postgres).POSTGRES_USER, envOf(postgres).POSTGRES_DB],
    ['qa_tools', 'qa_tools'],
  );
  assert.ok(postgres.args.includes('cron.database_name=qa_tools'));
  assert.equal(backup.volumes[0].hostPath.path, '/var/backups/qa-tools/nightly');
  assert.deepEqual(
    backup.initContainers.map((each) => each.name),
    ['db-backup-notify', 'db-backup-offsite'],
  );
  assert.deepEqual(
    [
      envOf(backup.initContainers[0]).NOTIFY_HEARTBEAT_URL,
      envOf(backup.initContainers[0]).NOTIFY_TOKEN.secretKeyRef.name,
    ],
    ['https://hb.statuser.cloud', 'qa-tools-statuser'],
  );

  const uploader = envOf(backup.initContainers[1]);

  assert.deepEqual(
    [
      uploader.OFFSITE_BUCKET,
      uploader.OFFSITE_ENDPOINT,
      uploader.OFFSITE_REGION,
      uploader.OFFSITE_DATABASE,
    ],
    ['qa-tools-backups', 'https://storage.yandexcloud.net', 'ru-central1', 'qa_tools'],
  );
  assert.equal(uploader.OFFSITE_ACCESS_KEY_ID.secretKeyRef.name, 'qa-tools-offsite-backup');
  assert.equal(
    find(documents, 'ConfigMap', 'qa-tools-db-backup').data['db-backup-recipient.asc'],
    readFileSync(RECIPIENT_PATH, 'utf8').trimEnd(),
  );
  assert.deepEqual(
    [
      monitor.MONITOR_SITE_URL,
      monitor.MONITOR_RECEIVE_URL,
      monitor.MONITOR_HEARTBEAT_URL,
      monitor.MONITOR_DISK_TOKEN.secretKeyRef.name,
    ],
    [
      'https://qa-tools.ru',
      'https://hook.qa-tools.ru',
      'https://hb.statuser.cloud',
      'qa-tools-statuser',
    ],
  );
});

/** The deploy job's answer when the variables `names` are missing: exit 1, their names, helm not run. */
const stopped = (names) => ({
  status: 1,
  output: `Not deployed: the project CI/CD variables ${names.join(' ')} are not set, or are empty where a value is needed (README.md, Deploying from GitLab CI)\n`,
  helm: null,
});

test('the deploy job stops before helm upgrade, naming the variable, when one it needs is not set, under sh and bash (#367, criterion 4)', () => {
  const without = (...names) =>
    Object.fromEntries(Object.entries(PRODUCTION).filter(([name]) => !names.includes(name)));

  for (const shell of ['sh', 'bash']) {
    for (const name of [
      ...ALWAYS_NEEDED,
      'DEPLOY_ALIAS_TLS_SECRET',
      'DEPLOY_BACKUP_ENDPOINT',
      'DEPLOY_BACKUP_REGION',
      'DEPLOY_BACKUP_SECRET',
      'DEPLOY_BACKUP_RECIPIENT_KEY',
      'DEPLOY_HEARTBEAT_SECRET',
    ]) {
      assert.deepEqual(deployJob(without(name), shell), stopped([name]), `${shell} ${name}`);
    }
    // Every one missing is named at once.
    assert.deepEqual(deployJob(without(...ALWAYS_NEEDED), shell), stopped(ALWAYS_NEEDED), shell);
    // Set empty, the backup's copy's companions too are needed.
    assert.deepEqual(
      deployJob({ ...PRODUCTION, DEPLOY_BACKUP_ENDPOINT: '', DEPLOY_HEARTBEAT_SECRET: '' }, shell),
      stopped(['DEPLOY_BACKUP_ENDPOINT', 'DEPLOY_HEARTBEAT_SECRET']),
      shell,
    );
  }

  // Set empty, the second host, the off-server copy and the monitor are off,
  // their companions not needed, and helm is given none of them.
  const off = deployJob({
    ...without(
      'DEPLOY_ALIAS_TLS_SECRET',
      'DEPLOY_BACKUP_ENDPOINT',
      'DEPLOY_BACKUP_REGION',
      'DEPLOY_BACKUP_SECRET',
      'DEPLOY_BACKUP_RECIPIENT_KEY',
      'DEPLOY_HEARTBEAT_SECRET',
    ),
    DEPLOY_APP_ALIAS_ORIGIN: '',
    DEPLOY_BACKUP_BUCKET: '',
    DEPLOY_HEARTBEAT_URL: '',
  });

  assert.equal(off.status, 0, off.output);
  assert.deepEqual(
    off.helm.filter((arg) =>
      /^(ingress\.aliasHost|ingress\.tls\.alias|backup\.offsite|alerts\.(heartbeat|existing))/.test(
        arg,
      ),
    ),
    [],
  );

  const { documents } = renderedFrom(off.helm);

  assert.equal(find(documents, 'CronJob', 'qa-tools-monitor'), undefined);
  assert.equal(podOf(find(documents, 'CronJob', 'qa-tools-db-backup')).initContainers, undefined);
  assert.equal(find(documents, 'Ingress', 'qa-tools-alias'), undefined);
});

// Set empty, a name every installation needs would leave the chart's
// default: the database role and database `inspector`, the backup directory
// /var/backups/webhook-inspector and a receive certificate Secret named after
// the release, under a running installation. So empty stops the job as unset
// does; only the options may be empty.
for (const name of VALUE_NEEDED) {
  test(`the deploy job stops before helm upgrade, naming ${name}, when it is set empty, under sh and bash (#367, criterion 4)`, () => {
    for (const shell of ['sh', 'bash']) {
      assert.deepEqual(deployJob({ ...PRODUCTION, [name]: '' }, shell), stopped([name]), shell);
    }
  });
}

test('the deploy job takes an empty option as off and stops for every needed name set empty at once (#367, criterion 4)', () => {
  for (const shell of ['sh', 'bash']) {
    // Each option alone set empty: deployed, that option off.
    for (const name of OPTIONS) {
      const run = deployJob({ ...PRODUCTION, [name]: '' }, shell);

      assert.equal(run.status, 0, `${shell} ${name}: ${run.output}`);
    }
    // Every needed name empty and every option unset: all named, in order.
    const empty = Object.fromEntries(VALUE_NEEDED.map((name) => [name, '']));
    const rest = Object.fromEntries(
      Object.entries(PRODUCTION).filter(([name]) => !OPTIONS.includes(name)),
    );

    assert.deepEqual(deployJob({ ...rest, ...empty }, shell), stopped(ALWAYS_NEEDED), shell);
  }
});

test('the deploy job refuses a value helm would split or a shell would read, and a recipient key that is not a public key alone, naming the variable and printing no value (#367)', () => {
  const secret = 'Zq7xK2mW9pL4vN8';
  const plain = [
    'DEPLOY_ALIAS_TLS_SECRET',
    'DEPLOY_RECEIVE_TLS_SECRET',
    'DEPLOY_POSTGRES_USER',
    'DEPLOY_POSTGRES_DATABASE',
    'DEPLOY_BACKUP_HOST_PATH',
    'DEPLOY_BACKUP_BUCKET',
    'DEPLOY_BACKUP_ENDPOINT',
    'DEPLOY_BACKUP_REGION',
    'DEPLOY_BACKUP_SECRET',
    'DEPLOY_HEARTBEAT_URL',
    'DEPLOY_HEARTBEAT_SECRET',
  ];
  const refusal = (name) =>
    `${name} holds a character other than letters, digits, '.', '_', ':', '/' and '-'; its value is not printed\n`;

  for (const shell of ['sh', 'bash']) {
    for (const name of plain) {
      for (const value of [
        `a,${secret}`,
        `a ${secret}`,
        `a\n${secret}`,
        `"${secret}`,
        `$(touch ${secret})`,
        `a\\${secret}`,
        `a=${secret}`,
        `ä${secret}`,
        `*${secret}`,
      ]) {
        const result = deployJob({ ...PRODUCTION, [name]: value }, shell);

        assert.deepEqual(
          result,
          { status: 1, output: refusal(name), helm: null },
          `${shell} ${name} ${JSON.stringify(value)}`,
        );
      }
    }

    // At growing sizes, a long value of the allowed characters passes, and
    // one forbidden character at its end is refused.
    for (const size of [10, 1000, 100_000]) {
      const long = `a/${'b.-_:'.repeat(size / 5)}`;

      assert.equal(
        deployJob({ ...PRODUCTION, DEPLOY_BACKUP_SECRET: long }, shell).status,
        0,
        shell,
      );
      assert.deepEqual(
        deployJob({ ...PRODUCTION, DEPLOY_BACKUP_SECRET: `${long},` }, shell),
        { status: 1, output: refusal('DEPLOY_BACKUP_SECRET'), helm: null },
        shell,
      );
    }
  }

  const keyRefusal =
    'DEPLOY_BACKUP_RECIPIENT_KEY must be a variable of type File holding an armored OpenPGP public key and no private key; its value is not printed\n';
  const write = (name, text) => {
    const path = join(STAND_INS, name);
    writeFileSync(path, text);
    return path;
  };

  for (const key of [
    join(STAND_INS, 'absent.asc'),
    STAND_INS,
    write('empty.asc', ''),
    write('text.asc', `${secret}\n`),
    write(
      'private.asc',
      `${readFileSync(RECIPIENT_PATH, 'utf8')}-----BEGIN PGP PRIVATE KEY BLOCK-----\n${secret}\n`,
    ),
  ]) {
    assert.deepEqual(
      deployJob({ ...PRODUCTION, DEPLOY_BACKUP_RECIPIENT_KEY: key }),
      { status: 1, output: keyRefusal, helm: null },
      key,
    );
  }
});

/** The hosts the deploy job gives the chart for these origins, the others production's: the site's, the receive host's and, with one, the second's. */
function deployHosts(appOrigin, receiveOrigin, aliasOrigin = '', shell = 'sh') {
  const result = deployJob(
    {
      ...PRODUCTION,
      DEPLOY_APP_ORIGIN: appOrigin,
      DEPLOY_RECEIVE_ORIGIN: receiveOrigin,
      DEPLOY_APP_ALIAS_ORIGIN: aliasOrigin,
    },
    shell,
  );

  if (result.status !== 0) return { status: result.status, output: result.output };

  const value = (key) =>
    result.helm.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);

  return {
    status: 0,
    hosts: [value('ingress.host'), value('receive.host'), value('ingress.aliasHost')]
      .filter(Boolean)
      .join(' '),
  };
}

/** The deploy job's refusal of `name`, which names it and never its value. */
const refusalOf = (name) =>
  `${name} must be https:// and a host name alone; its value is not printed\n`;

test("the deploy job's check of the two origins passes production's and refuses anything but https:// and a host name (D274)", () => {
  assert.deepEqual(deployHosts('https://qa-tools.ru', 'https://hook.qa-tools.ru'), {
    status: 0,
    hosts: 'qa-tools.ru hook.qa-tools.ru',
  });
  assert.deepEqual(deployHosts('https://inspector.example', 'https://hook.inspector.example'), {
    status: 0,
    hosts: 'inspector.example hook.inspector.example',
  });

  // Empty, either is missing, as unset (#367, criterion 4).
  assert.deepEqual(deployHosts('', 'https://hook.qa-tools.ru'), {
    status: 1,
    output: stopped(['DEPLOY_APP_ORIGIN']).output,
  });
  assert.deepEqual(deployHosts('https://qa-tools.ru', ''), {
    status: 1,
    output: stopped(['DEPLOY_RECEIVE_ORIGIN']).output,
  });

  for (const origin of [
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
      { status: 1, output: refusalOf('DEPLOY_APP_ORIGIN') },
      JSON.stringify(origin),
    );
    assert.deepEqual(
      deployHosts('https://qa-tools.ru', origin),
      { status: 1, output: refusalOf('DEPLOY_RECEIVE_ORIGIN') },
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

      assert.deepEqual(
        app,
        { status: 1, output: refusalOf('DEPLOY_APP_ORIGIN') },
        `${shell} ${origin}`,
      );
      assert.deepEqual(receive, { status: 1, output: refusalOf('DEPLOY_RECEIVE_ORIGIN') }, shell);
      assert.deepEqual(alias, { status: 1, output: refusalOf('DEPLOY_APP_ALIAS_ORIGIN') }, shell);
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
      output: refusalOf('DEPLOY_APP_ORIGIN'),
    });
    assert.deepEqual(deployHosts('https://example', `https://${'/'.repeat(size)}`), {
      status: 1,
      output: refusalOf('DEPLOY_RECEIVE_ORIGIN'),
    });
    assert.deepEqual(
      deployHosts(`https://user:${'s'.repeat(size)}@example`, 'https://hook.example'),
      {
        status: 1,
        output: refusalOf('DEPLOY_APP_ORIGIN'),
      },
    );
  }
});

test("the deploy job's check of the second site origin: empty is none, production's passes, and anything but https:// and a host name of its own is refused (#319, D275)", () => {
  const app = 'https://qa-tools.ru';
  const receive = 'https://hook.qa-tools.ru';

  assert.deepEqual(deployHosts(app, receive, ''), {
    status: 0,
    hosts: 'qa-tools.ru hook.qa-tools.ru',
  });
  assert.deepEqual(deployHosts(app, receive, 'https://webhook.qa-tools.ru'), {
    status: 0,
    hosts: 'qa-tools.ru hook.qa-tools.ru webhook.qa-tools.ru',
  });
  assert.deepEqual(
    deployHosts(
      'https://inspector.example',
      'https://hook.inspector.example',
      'https://next.example',
    ),
    {
      status: 0,
      hosts: 'inspector.example hook.inspector.example next.example',
    },
  );

  // The site's own origin or the receive host's is no second host.
  for (const same of [app, receive]) {
    assert.deepEqual(deployHosts(app, receive, same), {
      status: 1,
      output: 'DEPLOY_APP_ALIAS_ORIGIN must name a host of its own; its value is not printed\n',
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
      { status: 1, output: refusalOf('DEPLOY_APP_ALIAS_ORIGIN') },
      JSON.stringify(origin),
    );
  }

  for (const size of [10, 1000, 100_000]) {
    const host = `${'w.'.repeat(size / 2)}example`;

    assert.deepEqual(deployHosts(app, receive, `https://${host}`), {
      status: 0,
      hosts: `qa-tools.ru hook.qa-tools.ru ${host}`,
    });
    assert.deepEqual(deployHosts(app, receive, `https://${host}/`), {
      status: 1,
      output: refusalOf('DEPLOY_APP_ALIAS_ORIGIN'),
    });
    assert.deepEqual(deployHosts(app, receive, `https://${'/'.repeat(size)}`), {
      status: 1,
      output: refusalOf('DEPLOY_APP_ALIAS_ORIGIN'),
    });
  }
});

test("the deploy job's check refuses a host that is no host name under sh and bash, with its line, and passes production's three origins (#340)", () => {
  const production = [
    PRODUCTION.DEPLOY_APP_ORIGIN,
    PRODUCTION.DEPLOY_RECEIVE_ORIGIN,
    PRODUCTION.DEPLOY_APP_ALIAS_ORIGIN,
  ];
  const hostsOf = (origins) => origins.map((origin) => new URL(origin).host).join(' ');
  const app = 'https://inspector.example';
  const receive = 'https://hook.inspector.example';
  const refusedEverywhere = (origin, shell) => {
    const label = `${shell} ${JSON.stringify(origin.slice(0, 80))}`;

    assert.deepEqual(
      deployHosts(origin, receive, '', shell),
      { status: 1, output: refusalOf('DEPLOY_APP_ORIGIN') },
      label,
    );
    assert.deepEqual(
      deployHosts(app, origin, '', shell),
      { status: 1, output: refusalOf('DEPLOY_RECEIVE_ORIGIN') },
      label,
    );
    assert.deepEqual(
      deployHosts(app, receive, origin, shell),
      { status: 1, output: refusalOf('DEPLOY_APP_ALIAS_ORIGIN') },
      label,
    );
  };
  const passed = (origin, shell) =>
    assert.deepEqual(
      deployHosts(app, receive, origin, shell),
      { status: 0, hosts: hostsOf([app, receive, origin]) },
      `${shell} ${JSON.stringify(origin.slice(0, 80))}`,
    );

  for (const shell of ['sh', 'bash']) {
    assert.deepEqual(deployHosts(...production, shell), { status: 0, hosts: hostsOf(production) });

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

    for (const origin of [
      `https://${'a'.repeat(63)}.${'b'.repeat(63)}.example`,
      'https://a--b.0.example',
      'https://xn--e1afmkfd.xn--p1ai',
      'https://a1.b2',
      'https://x',
    ]) {
      passed(origin, shell);
    }

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

/** Every file under `path` of the repository, recursively. */
function filesUnder(path) {
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(path, entry.name)) : [join(path, entry.name)],
  );
}

/** The project CI/CD variables an installation sets that the pipeline files read: `DEPLOY_*`, the runner tags and the kubeconfig, outside comments. */
function pipelineVariables(texts) {
  const names = new Set();

  for (const text of texts) {
    for (const [name] of uncommented(text).matchAll(
      /\b(?:DEPLOY_[A-Z0-9_]+|[A-Z0-9_]+_RUNNER_TAG|KUBECONFIG_[A-Z0-9_]+)\b/g,
    )) {
      names.add(name);
    }
  }

  return [...names].sort();
}

/** The names README.md's table of "Deploying from GitLab CI" lists, each row's first cell. */
function readmeVariables(readme) {
  const from = readme.indexOf('\n### Deploying from GitLab CI\n');

  assert.ok(from >= 0, 'README.md has no "Deploying from GitLab CI"');

  const section = readme.slice(from + 1, readme.indexOf('\n## ', from + 1));
  const names = new Set();

  for (const [, cell] of section.matchAll(/^\| ([^|\n]+?) \|/gm)) {
    for (const [, name] of cell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) names.add(name);
  }

  return [...names].sort();
}

/** The pipeline files: .gitlab-ci.yml and every file under .gitlab/ci/. */
const pipelineFiles = () => [
  readFileSync(PIPELINE, 'utf8'),
  ...readdirSync(join(ROOT, '.gitlab/ci')).map((name) =>
    readFileSync(join(ROOT, '.gitlab/ci', name), 'utf8'),
  ),
];

test("README.md's table of CI/CD variables lists every one the pipeline files read, and nothing they do not (#367)", () => {
  const read = pipelineVariables(pipelineFiles());
  const listed = readmeVariables(readFileSync(join(ROOT, 'README.md'), 'utf8'));

  assert.deepEqual(listed, read);
  // Twenty-one of them today: the installation's nineteen DEPLOY_* values,
  // QA_TOOLS_RUNNER_TAG and the deploy credential.
  assert.equal(read.length, 21, read.join(' '));
  for (const name of ['QA_TOOLS_RUNNER_TAG', 'DEPLOY_RUNNER_TAG', 'KUBECONFIG_DEPLOYER']) {
    assert.ok(read.includes(name), name);
  }

  // The comparison sees a row missing, a row of a name no file reads, and a
  // name read in a file under .gitlab/ci/ only.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const row = readme.match(/^\| `DEPLOY_HEARTBEAT_SECRET` \|[^\n]*\n/m)?.[0];

  assert.ok(row, 'the test looks for the row of DEPLOY_HEARTBEAT_SECRET');
  assert.notDeepEqual(readmeVariables(readme.replace(row, '')), read);
  assert.notDeepEqual(
    readmeVariables(readme.replace(row, `${row}| \`DEPLOY_UNREAD\` | x | x | all |\n`)),
    read,
  );
  assert.notDeepEqual(
    pipelineVariables([...pipelineFiles(), 'x:\n  script:\n    - echo "$DEPLOY_NEW_VALUE"\n']),
    listed,
  );
  // Comments do not count as reading.
  assert.deepEqual(pipelineVariables(['# DEPLOY_ONLY_SAID\nx: 1\n']), []);
});

test("the pipeline and deploy/ name no host, account or runner of production's: the CI/CD variables do (#367, criterion 6)", () => {
  const pipeline = readFileSync(PIPELINE, 'utf8');
  const validate = readFileSync(fileURLToPath(CI), 'utf8');

  for (const file of ['.gitlab-ci.yml', ...filesUnder('deploy')]) {
    const text = readFileSync(join(ROOT, file), 'utf8');

    assert.doesNotMatch(text, /qa-tools\.ru|statuser|yandexcloud|qa-tools-backups/i, file);
    assert.doesNotMatch(text, /qa-tools-ci|qa-tools-vps/, file);
  }
  // The validate stage's `chart` job looks for those names in a render, so
  // it holds them as its pattern; not as runner tags.
  assert.doesNotMatch(validate, /qa-tools-ci|qa-tools-vps/);

  // The address, from the variables, for the image builds and the smoke under
  // the names the backend reads; the test jobs' backend expects those unset,
  // so they are no global variables.
  assert.match(
    pipelineKey(pipeline, '.inspector-address'),
    /^ {2}variables:\n {4}APP_ORIGIN: \$DEPLOY_APP_ORIGIN\n {4}RECEIVE_ORIGIN: \$DEPLOY_RECEIVE_ORIGIN\n {4}APP_ALIAS_ORIGIN: \$DEPLOY_APP_ALIAS_ORIGIN\n/m,
  );
  assert.doesNotMatch(uncommented(pipelineKey(pipeline, 'variables')), /ORIGIN/);
  assert.match(pipelineKey(pipeline, '.image'), /^ {2}extends: \.inspector-address$/m);
  assert.match(
    pipelineKey(pipeline, 'image:frontend'),
    /^ {4}BUILD_ARGS: '--build-arg APP_ORIGIN --build-arg RECEIVE_ORIGIN --build-arg APP_ALIAS_ORIGIN --build-arg STATUS_PAGE_URL --build-arg CONTACT_EMAIL --build-arg OPERATOR_TEXTS'$/m,
  );

  const smoke = pipelineKey(pipeline, 'deployment-smoke');

  assert.match(smoke, /^ {2}extends: \.inspector-address$/m);
  assert.ok(smoke.includes(`- ${SMOKE_COMMAND}\n`));
  assert.match(smoke, /^ {2}timeout: 10m$/m);

  // The deploy job reads the variables themselves, on the runner one names.
  const deploy = pipelineKey(pipeline, 'deploy');

  assert.doesNotMatch(deploy, /extends:/);
  assert.match(deploy, /^ {2}tags:\n {4}- \$DEPLOY_RUNNER_TAG$/m);
  assert.match(deploy, /^ {2}environment:\n {4}name: production\n {4}url: \$DEPLOY_APP_ORIGIN$/m);

  // Its check stops before helm upgrade: its commands, not its comments.
  const commands = uncommented(DEPLOY_SCRIPT);

  assert.ok(commands.indexOf('Not deployed:') < commands.indexOf('helm upgrade --install'));
  assert.match(validate, /^variables:\n {2}QA_TOOLS_RUNNER_TAG: 'saas-linux-small-amd64'$/m);
});

/** deployment-smoke's command (D187, D275, #381): the three hosts, then the operator's three settings. */
const SMOKE_COMMAND =
  'node scripts/check-deployment.mjs "$APP_ORIGIN" "$RECEIVE_ORIGIN" "$APP_ALIAS_ORIGIN" --status-page="$DEPLOY_STATUS_PAGE_URL" --contact-email="$DEPLOY_CONTACT_EMAIL" --operator-texts="$DEPLOY_OPERATOR_TEXTS"';

// A stand-in node for deployment-smoke's command: it records its arguments,
// NUL-separated, and runs nothing.
const SMOKE_STAND_INS = mkdtempSync(join(tmpdir(), 'chart-test-smoke-'));

writeFileSync(
  join(SMOKE_STAND_INS, 'node'),
  '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\0\' "$arg"; done > "$SMOKE_ARGS"\n',
  { mode: 0o755 },
);
after(() => rmSync(SMOKE_STAND_INS, { recursive: true, force: true }));

/** deployment-smoke's command as the runner's shell runs it with the project's CI/CD variables `project`: the arguments the smoke is given. */
function smokeArguments(project) {
  const line = /^ {4}- (node scripts\/check-deployment\.mjs [^\n]*)$/m.exec(
    pipelineKey(readFileSync(PIPELINE, 'utf8'), 'deployment-smoke'),
  );

  assert.ok(line, 'deployment-smoke runs no scripts/check-deployment.mjs');

  const record = join(SMOKE_STAND_INS, `args-${(runs += 1)}`);
  const run = spawnSync('sh', ['-c', line[1]], {
    cwd: SMOKE_STAND_INS,
    env: {
      PATH: `${SMOKE_STAND_INS}:${process.env.PATH}`,
      SMOKE_ARGS: record,
      ...jobVariables(['.inspector-address', 'deployment-smoke'], project),
    },
    encoding: 'utf8',
  });

  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);

  const args = readFileSync(record, 'utf8').split('\0').slice(0, -1);

  rmSync(record);
  assert.equal(args[0], 'scripts/check-deployment.mjs');
  return args.slice(1);
}

test("deployment-smoke gives the smoke production's address and operator from the project's CI/CD variables, each operator's setting as the frontend image is built with it, empty for none (#381)", async () => {
  const { parseOperator } = await import('../apps/frontend/src/lib/operator.ts');
  const { parseCommandLine } = await import('./check-deployment.mjs');
  /** What the image built with `project`'s variables names, as the smoke is to expect it. */
  const builtWith = (project) => {
    const operator = parseOperator({
      STATUS_PAGE_URL: project.DEPLOY_STATUS_PAGE_URL,
      CONTACT_EMAIL: project.DEPLOY_CONTACT_EMAIL,
      OPERATOR_TEXTS: project.DEPLOY_OPERATOR_TEXTS,
    });

    return { ...operator };
  };

  // Production's: the three hosts and the operator's three details.
  const production = parseCommandLine(smokeArguments(PRODUCTION));

  assert.deepEqual(production, {
    base: PRODUCTION.DEPLOY_APP_ORIGIN,
    receiveBase: PRODUCTION.DEPLOY_RECEIVE_ORIGIN,
    aliasBase: PRODUCTION.DEPLOY_APP_ALIAS_ORIGIN,
    operator: builtWith(PRODUCTION),
  });
  assert.deepEqual(production.operator, {
    statusPageUrl: 'https://status.qa-tools.ru/',
    contactEmail: 'contact@qa-tools.ru',
    texts: true,
  });

  // A copy's own, with no second host, and one with none of the three:
  // each given, so each is checked, empty as none.
  const copy = {
    ...PRODUCTION,
    DEPLOY_APP_ORIGIN: 'https://inspector.example',
    DEPLOY_RECEIVE_ORIGIN: 'https://hook.inspector.example',
    DEPLOY_APP_ALIAS_ORIGIN: '',
    DEPLOY_STATUS_PAGE_URL: 'https://status.inspector.example/',
    DEPLOY_CONTACT_EMAIL: 'hello@inspector.example',
    DEPLOY_OPERATOR_TEXTS: 'false',
  };
  const none = {
    ...copy,
    DEPLOY_STATUS_PAGE_URL: '',
    DEPLOY_CONTACT_EMAIL: '',
    DEPLOY_OPERATOR_TEXTS: '',
  };

  for (const project of [copy, none]) {
    const smoke = parseCommandLine(smokeArguments(project));

    assert.equal(smoke.aliasBase, '');
    assert.deepEqual(smoke.operator, builtWith(project));
  }
  assert.deepEqual(parseCommandLine(smokeArguments(none)).operator, {
    statusPageUrl: null,
    contactEmail: null,
    texts: false,
  });

  // Each value reaches the smoke as one argument, as it is: never split,
  // expanded or run by the shell. The smoke then refuses what the image
  // build refuses.
  const hostile = "a b\"; $(touch ran) `touch ran` '*' $HOME";
  const args = smokeArguments({ ...PRODUCTION, DEPLOY_CONTACT_EMAIL: hostile });

  assert.equal(args.length, 6);
  assert.equal(args[4], `--contact-email=${hostile}`);
  assert.deepEqual(readdirSync(SMOKE_STAND_INS), ['node']);
  assert.throws(() => parseCommandLine(args), /^Error: --contact-email must /);
});

/* ------------------------------------------------------------------------ */
/* The frontend image's address and operator (#369), from the project's      */
/* CI/CD variables (#367).                                                    */
/* ------------------------------------------------------------------------ */

/** The `.image` template's script, the check and the builds, as the runner's shell runs it. */
const IMAGE_SCRIPT = firstScript('.image', 'docker build');

/** The operator's three settings: the project's CI/CD variable and the name the frontend build reads. */
const OPERATOR_VARIABLES = [
  ['DEPLOY_STATUS_PAGE_URL', 'STATUS_PAGE_URL'],
  ['DEPLOY_CONTACT_EMAIL', 'CONTACT_EMAIL'],
  ['DEPLOY_OPERATOR_TEXTS', 'OPERATOR_TEXTS'],
];

/** The image's origins: the project's CI/CD variable, empty allowed or not. */
const ORIGIN_VARIABLES = [
  ['DEPLOY_APP_ORIGIN', false],
  ['DEPLOY_RECEIVE_ORIGIN', false],
  ['DEPLOY_APP_ALIAS_ORIGIN', true],
];

/** Production's origins and operator as the frontend build sees them, in the stand-in's order. */
const PRODUCTION_ORIGINS = [
  'https://qa-tools.ru',
  'https://hook.qa-tools.ru',
  'https://webhook.qa-tools.ru',
];
const PRODUCTION_SETTINGS = ['https://status.qa-tools.ru/', 'contact@qa-tools.ru', 'true'];

// A stand-in docker: `manifest inspect` finds nothing, so a build on main
// builds and pushes; each other call is recorded with the origins and the
// operator's settings as the build sees them, `-` for one not in its
// environment.
writeFileSync(
  join(STAND_INS, 'docker'),
  [
    '#!/bin/sh',
    'if [ "$1" = manifest ]; then echo "manifest unknown" >&2; exit 1; fi',
    'printf \'%s|%s|%s|%s|%s|%s|%s\\n\' "$*" "${APP_ORIGIN--}" "${RECEIVE_ORIGIN--}" "${APP_ALIAS_ORIGIN--}" "${STATUS_PAGE_URL--}" "${CONTACT_EMAIL--}" "${OPERATOR_TEXTS--}" >> "$DOCKER_CALLS"',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

/**
 * A job's variables as GitLab gives them, its templates' first: each
 * `NAME: value` under `variables:` of `jobs`, in order, a later one winning,
 * its `$NAME` references expanded against `project`, one not set expanded
 * to nothing; the project's own variables outrank them all.
 */
function jobVariables(jobs, project) {
  const pipeline = readFileSync(PIPELINE, 'utf8');
  const own = {};

  for (const job of jobs) {
    const variables = /\n {2}variables:\n((?: {4}[^\n]*\n| *#[^\n]*\n)+)/.exec(
      pipelineKey(pipeline, job),
    );

    for (const [, name, value] of variables?.[1].matchAll(/^ {4}([A-Z_][A-Z0-9_]*): (.*)$/gm) ??
      []) {
      own[name] = value
        .replace(/^'(.*)'$/, '$1')
        .replace(/\$([A-Z_][A-Z0-9_]*)/g, (whole, ref) => project[ref] ?? '');
    }
  }

  return { ...own, ...project };
}

/**
 * The `.image` script of `image:frontend`, or of `job`, with the project's
 * CI/CD variables `project`, in a pipeline on main or in a merge request,
 * from `cwd`: its status, its output and docker's calls.
 */
function imageBuild(
  project,
  { main = true, shell = 'sh', job = 'image:frontend', cwd = STAND_INS } = {},
) {
  const record = join(STAND_INS, `docker-${(runs += 1)}`);
  const predefined = {
    CI_DEFAULT_BRANCH: 'main',
    CI_COMMIT_SHA: 'a'.repeat(40),
    CI_REGISTRY_IMAGE: 'registry.example/inspector',
    ...(main ? { CI_COMMIT_BRANCH: 'main' } : {}),
  };
  const run = spawnSync(shell, ['-c', IMAGE_SCRIPT], {
    cwd,
    env: {
      PATH: `${STAND_INS}:${process.env.PATH}`,
      DOCKER_CALLS: record,
      ...jobVariables(['.inspector-address', '.image', job], { ...predefined, ...project }),
    },
    encoding: 'utf8',
  });
  let docker = [];

  try {
    docker = readFileSync(record, 'utf8').split('\n').slice(0, -1);
    rmSync(record);
  } catch {
    // docker was not run.
  }

  return { status: run.status, output: `${run.stdout}${run.stderr}`, docker };
}

/** The frontend image's build and push, as recorded, with the operator's settings and the origins the build saw. */
const builtWith = (
  settings,
  origins = PRODUCTION_ORIGINS,
  image = `${PRODUCTION.CI_REGISTRY_IMAGE}/frontend`,
) => {
  const seen = [...origins, ...settings].join('|');

  return [
    `build --pull --build-arg APP_ORIGIN --build-arg RECEIVE_ORIGIN --build-arg APP_ALIAS_ORIGIN --build-arg STATUS_PAGE_URL --build-arg CONTACT_EMAIL --build-arg OPERATOR_TEXTS -f apps/frontend/Dockerfile -t ${image}:${'a'.repeat(40)} .|${seen}`,
    `push ${image}:${'a'.repeat(40)}|${seen}`,
  ];
};

/** The build's refusal when the variables `names` are missing: exit 1, their names, docker not run. */
const notBuilt = (names) => ({
  status: 1,
  output: `Not built: the project CI/CD variables ${names.join(' ')} are not set, or are empty where a value is needed (README.md, Deploying from GitLab CI)\n`,
  docker: [],
});

test("the pipeline's checks read its settings and commands, not its comments, which may say anything in any wrapping (#379)", () => {
  assert.equal(
    uncommented(
      [
        '# docker build, Not built: and STATUS_PAGE_URL: in a comment',
        'check',
        '    #   docker build --pull $BUILD_ARGS -f ',
        '\t# helm upgrade --install',
        'docker build --pull $BUILD_ARGS -f x',
        '',
      ].join('\n'),
    ),
    'check\ndocker build --pull $BUILD_ARGS -f x\n',
  );

  // Every comment of the pipeline wrapped again, and saying what the checks
  // look for: what they read is the same.
  const pipeline = readFileSync(PIPELINE, 'utf8');
  const rewrapped = pipeline.replace(
    /^( *)# (.*)$/gm,
    (_, indent, words) =>
      `${indent}# docker build STATUS_PAGE_URL: Not built: helm upgrade --install\n${indent}#\n${indent}# ${words}`,
  );

  assert.notEqual(rewrapped, pipeline);
  assert.equal(uncommented(rewrapped), uncommented(pipeline));
});

/** PRODUCTION without the variables `names`. */
const productionWithout = (...names) =>
  Object.fromEntries(Object.entries(PRODUCTION).filter(([name]) => !names.includes(name)));

test("the frontend image's address and operator: its build takes production's from the project's CI/CD variables, which the pipeline does not name, under the names the build reads (#369, #367)", async () => {
  const { parseOperator } = await import('../apps/frontend/src/lib/operator.ts');
  const pipeline = readFileSync(PIPELINE, 'utf8');
  const frontend = pipelineKey(pipeline, 'image:frontend');

  // Read outside the comments, which may say anything in any wrapping.
  for (const [variable, name] of OPERATOR_VARIABLES) {
    assert.match(frontend, new RegExp(`^ {4}${name}: \\$${variable}$`, 'm'), name);
    assert.equal(
      uncommented(pipeline).split(`${name}:`).length - 1,
      1,
      `the pipeline sets ${name} elsewhere`,
    );
  }
  // What the build checks on main: the two origins need a value; the second
  // origin and the operator's settings must be set, empty for none.
  assert.match(frontend, /^ {4}BUILD_VALUES: 'DEPLOY_APP_ORIGIN DEPLOY_RECEIVE_ORIGIN'$/m);
  assert.match(
    frontend,
    /^ {4}BUILD_VARIABLES: 'DEPLOY_APP_ALIAS_ORIGIN DEPLOY_STATUS_PAGE_URL DEPLOY_CONTACT_EMAIL DEPLOY_OPERATOR_TEXTS'$/m,
  );
  // Not global, not the inspector's address, not the other images': the
  // deploy job does not read them, the test jobs build no image, and the
  // smoke reads the project's variables themselves, not the build's names
  // (#381).
  assert.doesNotMatch(
    uncommented(pipelineKey(pipeline, 'variables')),
    /STATUS_PAGE_URL|CONTACT_EMAIL|OPERATOR_TEXTS|BUILD_VARIABLES|BUILD_VALUES/,
  );
  for (const job of ['.inspector-address', 'image:backend', 'image:postgres', 'deploy']) {
    assert.doesNotMatch(
      uncommented(pipelineKey(pipeline, job)),
      /STATUS_PAGE_URL|CONTACT_EMAIL|OPERATOR_TEXTS|BUILD_VARIABLES|BUILD_VALUES|BUILD_ARGS/,
      job,
    );
  }
  assert.doesNotMatch(
    uncommented(pipelineKey(pipeline, 'deployment-smoke')),
    /(?<!DEPLOY_)(?:STATUS_PAGE_URL|CONTACT_EMAIL|OPERATOR_TEXTS)|BUILD_VARIABLES|BUILD_VALUES|BUILD_ARGS/,
  );

  // The check comes before either build, and the image builds twice at
  // most: once in a merge request, once on main. The script's commands,
  // not its comments.
  const commands = uncommented(IMAGE_SCRIPT);

  assert.equal(commands.split('docker build --pull $BUILD_ARGS -f ').length - 1, 2);
  assert.equal(commands.split('docker build').length - 1, 2);
  for (const call of ['docker build', 'registry_has "$IMAGE']) {
    assert.ok(commands.indexOf('Not built:') < commands.indexOf(call), call);
  }

  // The Dockerfile takes each argument before the build that reads it.
  const dockerfile = readFileSync(new URL('../apps/frontend/Dockerfile', import.meta.url), 'utf8');
  const build = dockerfile.indexOf('RUN npm run build');

  for (const name of [
    'APP_ORIGIN',
    'RECEIVE_ORIGIN',
    'APP_ALIAS_ORIGIN',
    ...OPERATOR_VARIABLES.map(([, each]) => each),
  ]) {
    const at = dockerfile.indexOf(`\nARG ${name}\n`);

    assert.ok(at > dockerfile.indexOf('RUN npm ci') && at < build, name);
  }

  // The frontend's and the browser suite's record of production's settings
  // is these variables' values.
  const recorded = readFileSync(
    new URL('../apps/frontend/src/testing/production-operator-env.ts', import.meta.url),
    'utf8',
  );

  for (const [variable, name] of OPERATOR_VARIABLES) {
    assert.match(
      recorded,
      new RegExp(`^ {2}${name}: '${PRODUCTION[variable].replaceAll('.', '\\.')}',$`, 'm'),
      name,
    );
  }

  // Production's variables: the image is built and pushed naming
  // production's origins, status page, address and texts, as before #367.
  assert.deepEqual(imageBuild(PRODUCTION), {
    status: 0,
    output: '',
    docker: builtWith(PRODUCTION_SETTINGS),
  });
  assert.deepEqual(
    parseOperator(
      Object.fromEntries(OPERATOR_VARIABLES.map(([, name], at) => [name, PRODUCTION_SETTINGS[at]])),
    ),
    {
      statusPageUrl: 'https://status.qa-tools.ru/',
      contactEmail: 'contact@qa-tools.ru',
      texts: true,
    },
  );
});

test("on main the frontend image's build stops before docker build, naming the variable, when an origin or an operator's variable is not set, or the site's or the receive host's origin is empty; an empty second origin or detail is left out; a merge request builds either way (#367)", async () => {
  const { parseOperator } = await import('../apps/frontend/src/lib/operator.ts');
  const operator = OPERATOR_VARIABLES.map(([variable]) => variable);
  const origins = ORIGIN_VARIABLES.map(([variable]) => variable);

  for (const shell of ['sh', 'bash']) {
    // Not set: each stops the build on main.
    for (const name of [...origins, ...operator]) {
      assert.deepEqual(
        imageBuild(productionWithout(name), { shell }),
        notBuilt([name]),
        `${shell} ${name}`,
      );
    }
    // Every one at once, the origins first.
    assert.deepEqual(
      imageBuild(productionWithout(...origins, ...operator), { shell }),
      notBuilt([...origins, ...operator]),
      shell,
    );

    // Set empty: the site's and the receive host's origins stop the build
    // as unset; the second origin is none, built for the first alone.
    for (const [name, mayBeEmpty] of ORIGIN_VARIABLES) {
      const run = imageBuild({ ...PRODUCTION, [name]: '' }, { shell });

      if (mayBeEmpty) {
        assert.deepEqual(
          run,
          {
            status: 0,
            output: '',
            docker: builtWith(PRODUCTION_SETTINGS, [...PRODUCTION_ORIGINS.slice(0, 2), '']),
          },
          `${shell} ${name}`,
        );
      } else {
        assert.deepEqual(run, notBuilt([name]), `${shell} ${name}`);
      }
    }
    assert.deepEqual(
      imageBuild({ ...PRODUCTION, DEPLOY_APP_ORIGIN: '', DEPLOY_RECEIVE_ORIGIN: '' }, { shell }),
      notBuilt(['DEPLOY_APP_ORIGIN', 'DEPLOY_RECEIVE_ORIGIN']),
      shell,
    );

    // Set empty, each detail is left out of the build, and the others kept;
    // with the texts off, the status page and the address may go too.
    for (const [at, name] of operator.entries()) {
      if (name !== 'DEPLOY_OPERATOR_TEXTS') {
        const run = imageBuild({ ...PRODUCTION, DEPLOY_OPERATOR_TEXTS: '', [name]: '' }, { shell });
        const seen = PRODUCTION_SETTINGS.map((value, index) =>
          index === at || index === 2 ? '' : value,
        );

        assert.deepEqual(
          run,
          { status: 0, output: '', docker: builtWith(seen) },
          `${shell} ${name}`,
        );
      }
    }

    const none = imageBuild(
      { ...PRODUCTION, ...Object.fromEntries(operator.map((name) => [name, ''])) },
      { shell },
    );

    assert.deepEqual(none, { status: 0, output: '', docker: builtWith(['', '', '']) }, shell);
    assert.deepEqual(
      parseOperator({ STATUS_PAGE_URL: '', CONTACT_EMAIL: '', OPERATOR_TEXTS: '' }),
      {
        statusPageUrl: null,
        contactEmail: null,
        texts: false,
      },
    );

    // A merge request builds what is set and pushes nothing.
    const request = imageBuild(productionWithout(...origins, ...operator), { main: false, shell });

    assert.equal(request.status, 0, request.output);
    assert.deepEqual(request.docker, [builtWith(['', '', ''], ['', '', ''])[0]]);

    // The other images read none: with no variable of the project at all,
    // the backend's builds on main.
    const backend = imageBuild({}, { shell, job: 'image:backend' });

    assert.equal(backend.status, 0, backend.output);
    assert.equal(backend.docker.length, 2, backend.output);
  }
});

test('the image build reads BUILD_VALUES and BUILD_VARIABLES as variable names alone, never running, globbing or expanding what else they hold, at growing sizes (#367)', () => {
  const marker = join(STAND_INS, 'ran');
  const refused = {
    status: 1,
    output: 'BUILD_VALUES or BUILD_VARIABLES holds something other than variable names\n',
    docker: [],
  };
  // A directory holding one file named like a variable that is set: a
  // glob read there would turn `*` into that name.
  const globbed = mkdtempSync(join(tmpdir(), 'chart-test-glob-'));

  writeFileSync(join(globbed, 'DEPLOY_CONTACT_EMAIL'), '');
  after(() => rmSync(globbed, { recursive: true, force: true }));

  for (const shell of ['sh', 'bash']) {
    for (const list of ['BUILD_VALUES', 'BUILD_VARIABLES']) {
      for (const value of [
        `$(touch ${marker})`,
        `\`touch ${marker}\``,
        `A;touch ${marker}`,
        `A}; touch ${marker}; {`,
        'A-B',
        'a',
        '1A',
        'A.B',
        '*',
        'DEPLOY_CONTACT_EMAI?',
        '${PATH}',
      ]) {
        for (const cwd of [STAND_INS, globbed]) {
          assert.deepEqual(
            imageBuild({ ...PRODUCTION, [list]: value }, { shell, cwd }),
            refused,
            `${shell} ${list} ${JSON.stringify(value)} in ${cwd}`,
          );
        }
        assert.throws(() => readFileSync(marker), /ENOENT/, `${shell} ${JSON.stringify(value)}`);
      }

      // Names: words split at white space, each checked; one missing is named.
      assert.deepEqual(
        imageBuild({ ...PRODUCTION, [list]: ' DEPLOY_CONTACT_EMAIL\n\tNOT_SET_X ' }, { shell }),
        notBuilt(['NOT_SET_X']),
        `${shell} ${list}`,
      );

      for (const size of [10, 1000, 100_000]) {
        const long = `N${'A'.repeat(size)}`;

        assert.deepEqual(
          imageBuild({ ...PRODUCTION, [list]: long }, { shell }),
          notBuilt([long]),
          `${shell} ${list} ${size}`,
        );
        assert.deepEqual(
          imageBuild({ ...PRODUCTION, [list]: `${long}-` }, { shell }),
          refused,
          `${shell} ${list} ${size}`,
        );
      }
    }
    // A name that needs a value, set empty, is named; the same name in the
    // list that needs it set alone passes.
    assert.deepEqual(
      imageBuild({ ...PRODUCTION, BUILD_VALUES: 'DEPLOY_X', DEPLOY_X: '' }, { shell }),
      notBuilt(['DEPLOY_X']),
      shell,
    );
    assert.equal(
      imageBuild({ ...PRODUCTION, BUILD_VARIABLES: 'DEPLOY_X', DEPLOY_X: '' }, { shell }).status,
      0,
      shell,
    );
  }
});

/* ------------------------------------------------------------------------ */
/* The edge rate limit (#205, D264) and the second host (#319, D275), as    */
/* production renders them.                                                  */
/* ------------------------------------------------------------------------ */

/** production's Ingresses and Middlewares, in templates/ingress.yaml's order, rendered from the deploy job's arguments with `variables` over production's. */
function renderedIngress(variables = {}, namespace) {
  const run = deployJob({ ...PRODUCTION, ...variables });

  assert.equal(run.status, 0, run.output);

  const result = renderedFrom(run.helm, namespace);

  return {
    set: parseHelmArguments(run.helm).set,
    documents: fileDocuments(result, 'templates/ingress.yaml'),
  };
}

/** A rendered Ingress's name, annotations, TLS hosts and Secret, host and paths. */
function ingressOf(document) {
  return {
    name: document.metadata.name,
    annotations: document.metadata.annotations ?? {},
    tlsHosts: (document.spec.tls ?? []).flatMap((each) => each.hosts),
    secretName: document.spec.tls?.[0]?.secretName ?? null,
    hosts: document.spec.rules.map((rule) => rule.host),
    paths: document.spec.rules.flatMap((rule) =>
      rule.http.paths.map((each) => ({
        path: each.path,
        type: each.pathType,
        service: each.backend.service.name,
        port: each.backend.service.port.name,
      })),
    ),
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

/** values.yaml's own edge rate limit. */
const apiRateLimit = () =>
  parseYaml(readFileSync(fileURLToPath(VALUES), 'utf8')).ingress.apiRateLimit;

test('the edge rate limit: the Middleware on an Ingress of its own for /api/ and /mcp, and on no other path (#205, criterion 3)', () => {
  const { documents } = renderedIngress({ DEPLOY_APP_ALIAS_ORIGIN: '' });

  assert.deepEqual(
    documents.map((each) => each.kind),
    ['Ingress', 'Ingress', 'Middleware'],
  );

  // The API's first, so that Helm creates it before it takes the paths off
  // the site's, as it applies documents of one kind in their order.
  const [api, site] = documents.slice(0, 2).map(ingressOf);
  const middleware = documents[2];
  const host = 'qa-tools.ru';

  assert.deepEqual(
    [site.name, api.name, middleware.metadata.name],
    ['qa-tools', 'qa-tools-api', 'qa-tools-api-rate-limit'],
  );
  assert.equal(middleware.apiVersion, 'traefik.io/v1alpha1');

  // The API's Ingress names the Middleware, in the release's namespace, by
  // the reference Traefik's Ingress provider reads; the site's names none.
  assert.deepEqual(api.annotations, {
    'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure',
    'traefik.ingress.kubernetes.io/router.middlewares':
      'qa-tools-qa-tools-api-rate-limit@kubernetescrd',
  });
  assert.deepEqual(site.annotations, {
    'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure',
    'cert-manager.io/cluster-issuer': 'letsencrypt-production',
  });

  // Production's release and namespace share a name, so the reference is
  // read once more from a namespace of another name: it is the namespace's.
  const elsewhere = ingressOf(
    renderedIngress({ DEPLOY_APP_ALIAS_ORIGIN: '' }, 'elsewhere').documents[0],
  );

  assert.equal(
    elsewhere.annotations['traefik.ingress.kubernetes.io/router.middlewares'],
    'elsewhere-qa-tools-api-rate-limit@kubernetescrd',
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
  const limit = apiRateLimit();
  const { rateLimit } = renderedIngress().documents[2].spec;

  assert.deepEqual(rateLimit, {
    average: limit.average,
    period: limit.period,
    burst: limit.burst,
    // No depth and no excluded addresses: the TCP peer, never a header a
    // client writes.
    sourceCriterion: { ipStrategy: { ipv6Subnet: 64 } },
  });
  assert.ok(Number.isInteger(limit.average) && limit.average >= 0, `average ${limit.average}`);

  if (limit.average === 0) {
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

  assert.ok(limit.burst >= mostAtOnce, `burst ${limit.burst} is under ${mostAtOnce}`);
  assert.ok(
    limit.average / seconds(limit.period) >= mostPerSecond,
    `${limit.average} per ${limit.period} is under ${mostPerSecond} a second`,
  );
  // The issue's own floor, met many times over.
  assert.ok(limit.burst >= 2 * perWindow && limit.average / seconds(limit.period) >= 21);
});

test("the edge rate limit: the measurement's Traefik carries the chart's numbers on the chart's paths (#205)", () => {
  const limit = apiRateLimit();
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
  if (limit.average !== 0) {
    assert.equal(only(middleware, 'average'), String(limit.average));
    assert.equal(only(middleware, 'period'), limit.period);
    assert.equal(only(middleware, 'burst'), String(limit.burst));
  }
});

test("the second site host: two Ingresses of its own with the first host's paths, a certificate of its own, noindex on every router and the edge rate limit on the API's, and the first host's Ingresses as they were (#319, D275)", () => {
  const aliasHost = 'webhook.qa-tools.ru';
  const without = renderedIngress({ DEPLOY_APP_ALIAS_ORIGIN: '' });
  const { documents } = renderedIngress();

  assert.deepEqual(
    documents.map((each) => each.kind),
    ['Ingress', 'Ingress', 'Middleware', 'Ingress', 'Ingress', 'Middleware'],
  );

  // The first host renders as it does with no second host: its
  // certificate's hosts are unchanged, so it is not reissued, and neither
  // the noindex middleware nor anything else of the second host reaches it.
  assert.deepEqual(documents.slice(0, 3), without.documents);

  const [api, site] = documents.slice(0, 2).map(ingressOf);
  const [aliasApi, aliasSite] = documents.slice(3, 5).map(ingressOf);
  const noindex = documents[5];
  const host = 'qa-tools.ru';

  assert.deepEqual(
    [aliasApi.name, aliasSite.name, noindex.metadata.name],
    ['qa-tools-alias-api', 'qa-tools-alias', 'qa-tools-noindex'],
  );

  // Every answer on the second host carries X-Robots-Tag: noindex: the
  // middleware sets that one response header and does nothing else.
  assert.equal(noindex.apiVersion, 'traefik.io/v1alpha1');
  assert.deepEqual(noindex.spec, {
    headers: { customResponseHeaders: { 'X-Robots-Tag': 'noindex' } },
  });

  // noindex on both of the second host's Ingresses, first, so that the edge
  // rate limit's own 429 carries it; the rate limit on the API's alone; the
  // certificate asked for by the site's alone.
  assert.deepEqual(aliasApi.annotations, {
    'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure',
    'traefik.ingress.kubernetes.io/router.middlewares':
      'qa-tools-qa-tools-noindex@kubernetescrd,qa-tools-qa-tools-api-rate-limit@kubernetescrd',
  });
  assert.deepEqual(aliasSite.annotations, {
    'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure',
    'traefik.ingress.kubernetes.io/router.middlewares': 'qa-tools-qa-tools-noindex@kubernetescrd',
    'cert-manager.io/cluster-issuer': 'letsencrypt-production',
  });
  for (const first of [api, site]) {
    assert.ok(
      !(first.annotations['traefik.ingress.kubernetes.io/router.middlewares'] ?? '').includes(
        'noindex',
      ),
      first.name,
    );
  }

  // The references are the namespace's, as the rate limit's are.
  const elsewhere = renderedIngress({}, 'elsewhere');

  assert.equal(
    ingressOf(elsewhere.documents[4]).annotations[
      'traefik.ingress.kubernetes.io/router.middlewares'
    ],
    'elsewhere-qa-tools-noindex@kubernetescrd',
  );

  // Its own host, and a certificate of its own for that host alone, beside
  // the first host's; the first host's Ingresses name the first host alone.
  assert.deepEqual(
    [aliasApi.hosts, aliasSite.hosts, aliasApi.tlsHosts, aliasSite.tlsHosts],
    [[aliasHost], [aliasHost], [aliasHost], [aliasHost]],
  );
  assert.equal(aliasSite.secretName, 'webhook-qa-tools-tls');
  assert.equal(aliasApi.secretName, aliasSite.secretName);
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
  assert.equal(ruleOf(aliasHost, aliasSite.paths.at(-1)).length, 46);
  assert.deepEqual(
    [...aliasApi.paths, ...aliasSite.paths.slice(0, -1)].map(
      (path) => ruleOf(aliasHost, path).length,
    ),
    [50, 49, 49, 48],
  );

  // Without TLS, a render on its own: no certificate is asked for or named.
  const plain = renderChart(CHART_DIR, {
    release: 'inspector',
    set: {
      ...NEUTRAL,
      'ingress.aliasHost': 'next.inspector.example',
      'ingress.tls.enabled': false,
    },
  });

  for (const document of fileDocuments(plain, 'templates/ingress.yaml').filter(
    (each) => each.kind === 'Ingress',
  )) {
    assert.equal(document.spec.tls, undefined);
    assert.ok(!('cert-manager.io/cluster-issuer' in (document.metadata.annotations ?? {})));
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

  // No other template reads it but the Ingresses' and the helper naming the
  // second host's certificate.
  for (const name of readdirSync(fileURLToPath(TEMPLATES)).filter(
    (each) => !['ingress.yaml', 'backend.yaml', '_helpers.tpl'].includes(each),
  )) {
    assert.doesNotMatch(
      readFileSync(fileURLToPath(new URL(name, TEMPLATES)), 'utf8'),
      /aliasHost|aliasSecretName/,
      name,
    );
  }
});

/* ------------------------------------------------------------------------ */
/* README.md's install commands, held to the chart and to each other (#395). */
/* ------------------------------------------------------------------------ */

/** A fence of a fenced code block: its indentation, three or more backticks or tildes, and its info string. */
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
/** A line that is an ATX heading. */
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** The info words of a fenced block of shell commands. */
const SHELL_BLOCKS = new Set(['bash', 'sh', 'shell']);

/**
 * `markdown` read as CommonMark reads its fenced code blocks: each block's
 * info word, first line and lines, the fence's indentation removed, a fence
 * left open running to the end; the prose, with every line of a block and
 * its fences blank; and the lines that are headings outside the blocks.
 */
function readMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  const prose = [];
  const headings = [];
  let open = null;

  lines.forEach((line, at) => {
    const fence = FENCE.exec(line);

    if (open) {
      if (
        fence &&
        fence[2][0] === open.marker[0] &&
        fence[2].length >= open.marker.length &&
        fence[3].trim() === ''
      ) {
        open = null;
      } else {
        const indent = /^[ \t]*/.exec(line)[0].length;

        open.block.lines.push(line.slice(Math.min(open.indent, indent)));
      }
      prose.push('');
    } else if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      // A backtick fence's info string holds no backtick (CommonMark).
      open = {
        marker: fence[2],
        indent: fence[1].length,
        block: { info: fence[3].trim().split(/[ \t]/)[0], line: at + 1, lines: [] },
      };
      blocks.push(open.block);
      prose.push('');
    } else {
      if (HEADING.test(line)) headings.push(at);
      prose.push(line);
    }
  });

  return { lines, blocks, prose: prose.join('\n'), headings };
}

/** The text of `markdown` under the heading line `heading`, which it has once, up to the next heading of any level. */
function readmeSection(markdown, heading) {
  const { lines, headings } = readMarkdown(markdown);
  const found = headings.filter((at) => lines[at].trimEnd() === heading);

  assert.equal(found.length, 1, `README.md has one "${heading}", not ${found.length}`);

  const end = headings.find((at) => at > found[0]) ?? lines.length;

  return lines.slice(found[0] + 1, end).join('\n');
}

/** Reserved words that open a compound command, which the matching done, fi or esac closes. */
const OPENERS = new Set(['for', 'while', 'until', 'select', 'if', 'case']);
const CLOSERS = new Set(['done', 'fi', 'esac']);
/** Reserved words after which a command's first word comes. */
const LEAD_INS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{']);
/** The shell's operator characters, each ending a word. */
const OPERATORS = new Set([';', '&', '|', '(', ')', '<', '>']);
/** A here-document's operator and delimiter, where the regular expression's lastIndex is. */
const HEREDOC = /<<-?[ \t]*(?:'([\w-]*)'|"([\w-]*)"|\\?([\w-]+))/y;

/**
 * The commands of a shell script, each read as the shell reads it to run
 * it, and normalised for its continuation lines and indentation only: a
 * line ending in a backslash is joined to the next, with one space between
 * them where either side had white space and none where neither did; each
 * line's indentation and trailing white space are removed and a comment is
 * dropped. A line break inside quotes is kept, with the next line as it is.
 * A for, while, until, select, if or case is one command with its lines up
 * to the matching done, fi or esac, joined by line breaks, and the lines of
 * a here-document stay, as they are, with the command that reads it. A
 * quote, a compound command or a here-document left open runs to the end.
 * Not read: `$'…'`, and quotes inside `$( )` inside double quotes.
 */
function shellCommands(script) {
  const lines = script.split(/\r?\n/);
  const commands = [];
  // The command's lines read so far, the line being read, and the white
  // space read outside quotes and not yet followed by anything: dropped at
  // the end of a line, so that no string is ever trimmed whole.
  let read = [];
  let current = '';
  let space = '';
  let word = '';
  let quote = '';
  let depth = 0;
  let atStart = true;
  let joining = false;
  let heredocs = [];

  const endWord = () => {
    if (!word) return;
    if (atStart && OPENERS.has(word)) depth += 1;
    else if (atStart && CLOSERS.has(word)) depth = Math.max(0, depth - 1);
    atStart = atStart && LEAD_INS.has(word);
    word = '';
  };
  const append = (characters) => {
    if (current) current += space;
    space = '';
    current += characters;
  };
  const add = (characters) => {
    append(characters);
    word += characters;
  };
  const endLine = () => {
    if (current) read.push(current);
    current = '';
    space = '';
  };
  const endCommand = () => {
    endLine();

    const command = read.join('\n').trimEnd();

    if (command) commands.push(command);
    read = [];
  };

  for (let row = 0; row < lines.length; row += 1) {
    let line = lines[row];

    if (joining) {
      joining = false;
      if (!quote) {
        // Outside quotes a continuation with white space on either side is
        // one space; with none, the two lines' words are one.
        if (space || /^[ \t]/.test(line)) {
          endWord();
          space = ' ';
        }
        line = line.replace(/^[ \t]+/, '');
      }
    } else if (quote) {
      current += '\n';
    } else {
      line = line.replace(/^[ \t]+/, '');
      if (line === '') continue;
    }

    for (let at = 0; at < line.length; at += 1) {
      const character = line[at];

      if (quote === "'") {
        add(character);
        if (character === "'") quote = '';
      } else if (character === '\\') {
        if (at === line.length - 1) {
          joining = true;
        } else {
          add(line.slice(at, at + 2));
          at += 1;
        }
      } else if (quote === '"') {
        add(character);
        if (character === '"') quote = '';
      } else if (character === "'" || character === '"') {
        quote = character;
        add(character);
      } else if (character === '#' && word === '') {
        break;
      } else if (character === ' ' || character === '\t') {
        endWord();
        space += character;
      } else if (OPERATORS.has(character)) {
        endWord();
        HEREDOC.lastIndex = at;

        const heredoc =
          character === '<' && line[at - 1] !== '<' && line[at + 2] !== '<'
            ? HEREDOC.exec(line)
            : null;

        if (heredoc) {
          heredocs.push(heredoc[1] ?? heredoc[2] ?? heredoc[3]);
          append(heredoc[0]);
          at += heredoc[0].length - 1;
        } else {
          append(character);
        }
        atStart = character !== '<' && character !== '>';
      } else {
        add(character);
      }
    }

    if (quote || joining) continue;

    endWord();
    atStart = true;
    endLine();
    for (const delimiter of heredocs) {
      for (row += 1; row < lines.length; row += 1) {
        read.push(lines[row]);
        if (lines[row].trim() === delimiter) break;
      }
    }
    heredocs = [];
    if (depth === 0) endCommand();
  }
  endCommand();

  return commands;
}

/** The commands of the fenced shell blocks of `markdown`, in order. */
const shellBlockCommands = (markdown) =>
  readMarkdown(markdown)
    .blocks.filter((block) => SHELL_BLOCKS.has(block.info))
    .flatMap((block) => shellCommands(block.lines.join('\n')));

/** A helm flag that sets a chart value, alone or with its assignment after `=`. */
const SET_FLAG = /^(--set(?:-string|-file|-json|-literal)?)(?:=(.*))?$/;
/** The chart's own path, as a command names it. */
const OWN_CHART = /^(?:\.\/)?deploy\/helm\/qa-tools\/?$/;

/**
 * The chart values `command` sets: for each `<key>=<value>` of a SET_FLAG,
 * split at the commas helm splits at (all but --set-json's and
 * --set-literal's), its key without quotes, or the flag with what follows it
 * where that is no `<key>=`; with `chart` null, or, for an assignment given
 * to a helm command that does not name this chart, that command's words up
 * to its first flag. Words are what white space separates.
 */
function setAssignments(command) {
  const words = command.split(/\s+/).filter(Boolean);
  const found = [];
  let chart = null;

  for (let at = 0; at < words.length; at += 1) {
    if (words[at] === 'helm') {
      const next = words.indexOf('helm', at + 1);
      const own = words.slice(at, next === -1 ? words.length : next);
      const flag = own.findIndex((word) => word.startsWith('-'));

      chart = own.some((word) => OWN_CHART.test(word))
        ? null
        : own.slice(0, flag === -1 ? own.length : flag).join(' ');
      continue;
    }

    const flag = SET_FLAG.exec(words[at]);

    if (!flag) continue;

    const [, name, inline] = flag;
    const assignment = inline ?? words[at + 1] ?? '';

    if (inline === undefined) at += 1;

    const parts =
      name === '--set-json' || name === '--set-literal'
        ? [assignment]
        : assignment.split(/(?<!\\),/);

    for (const part of parts) {
      const equals = part.indexOf('=');
      const key = equals > 0 ? part.slice(0, equals).replace(/['"]/g, '') : '';

      found.push({ key: key || `${name} ${part}`.trimEnd(), chart });
    }
  }

  return found;
}

/** A `--set…` flag and its key in prose, as an inline code span gives it. */
const PROSE_SET = /(?<![\w-])--set(?:-string|-file|-json|-literal)?(?:\s+|=)([^\s`'"=,]+)=/g;
/** A key path quoted alone in prose: `a.b`, `a.b.c`. */
const QUOTED_KEY = /`([A-Za-z][\w-]*(?:\.[\w-]+)+)`/g;

/**
 * The keys of the chart's values README.md names, by where it names them:
 * the `--set…` assignments of its fenced shell blocks to this chart, those
 * of its prose, and the key paths its prose quotes alone whose first key is
 * a top-level key of `values`; and, apart, the assignments to another chart,
 * each with that chart's command.
 */
function readmeKeys(readme, values) {
  const { blocks, prose } = readMarkdown(readme);
  const keys = { commands: [], prose: [], quoted: [], otherCharts: [] };

  for (const block of blocks.filter((each) => SHELL_BLOCKS.has(each.info))) {
    for (const command of shellCommands(block.lines.join('\n'))) {
      for (const { key, chart } of setAssignments(command)) {
        if (chart === null) keys.commands.push(key);
        else keys.otherCharts.push(`${chart}: ${key}`);
      }
    }
  }
  for (const [, key] of prose.matchAll(PROSE_SET)) keys.prose.push(key);
  for (const [, key] of prose.matchAll(QUOTED_KEY)) {
    if (Object.hasOwn(values, key.split('.')[0])) keys.quoted.push(key);
  }

  return keys;
}

/**
 * Whether `path` is a key of `values`: each dot steps into a map holding
 * the next key, and what the last key holds - a value, an empty string,
 * null, a list or a map - is not looked at. A list index or an escaped dot
 * is no such path.
 */
function hasKey(values, path) {
  let node = values;

  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    if (!Object.hasOwn(node, key)) return false;
    node = node[key];
  }

  return true;
}

/** The keys README.md sets or quotes for this chart that are not keys of `values`, each once, in the README's order. */
function missingKeys(readme, values) {
  const { commands, prose, quoted } = readmeKeys(readme, values);

  return [...new Set([...commands, ...prose, ...quoted])].filter((key) => !hasKey(values, key));
}

/** A command that only sets a shell variable: `NAME=` and a word, a quoted string or a `$( )` holding no parenthesis. */
const ASSIGNMENT = /^[A-Za-z_]\w*=(?:\$\([^()\n]*\)|"[^"\n]*"|'[^'\n]*'|[^\s;&|()<>`'"]*)$/;

/** The commands of README.md's Install section, but those setting the variables the rest use. */
const installCommands = (readme) =>
  shellBlockCommands(readmeSection(readme, '## Install')).filter(
    (command) => !ASSIGNMENT.test(command),
  );

/** The commands of README.md's Install section that "Installing on k3s with the chart" does not give as they are. */
function installCommandsMissing(readme) {
  const full = new Set(
    shellBlockCommands(readmeSection(readme, '## Installing on k3s with the chart')),
  );

  return installCommands(readme).filter((command) => !full.has(command));
}

const readme = () => readFileSync(join(ROOT, 'README.md'), 'utf8');
const chartValues = () => parseYaml(readFileSync(VALUES, 'utf8'));

/** `text` with the first, or the last, `from` replaced by `to`; `from` must be there. */
function replaced(text, from, to, last = false) {
  const at = last ? text.lastIndexOf(from) : text.indexOf(from);

  assert.ok(at >= 0, `the test looks for ${JSON.stringify(from)}`);

  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** The Install section's release, as it reads once its continuation lines are joined. */
const RELEASE =
  'helm upgrade --install inspector deploy/helm/qa-tools --namespace inspector ' +
  '--set-string images.registry=$REGISTRY --set-string images.tag=$TAG ' +
  '--set-string ingress.host=$SITE_HOST --set-string receive.host=$RECEIVE_HOST ' +
  '--set-string ingress.tls.issuer=$ISSUER --wait --timeout 10m';
const PUSH_LOOP =
  'for image in backend:$TAG frontend:$TAG postgres:16-pgcron-1; do docker push $REGISTRY/$image; done';

test("README.md's install commands set only keys values.yaml has: every --set… of its shell blocks and of its prose, and every key path it quotes alone (#395, criterion 1)", () => {
  const text = readme();
  const values = chartValues();
  const keys = readmeKeys(text, values);

  assert.deepEqual(missingKeys(text, values), []);

  // What is read: the five values of the Install section and of step 6, and
  // the off-server copy's four, from the fenced commands; ...
  for (const key of [
    'images.registry',
    'images.tag',
    'ingress.host',
    'receive.host',
    'ingress.tls.issuer',
  ]) {
    assert.equal(keys.commands.filter((each) => each === key).length, 2, key);
  }
  for (const key of ['bucket', 'endpoint', 'region', 'recipientKey']) {
    assert.ok(keys.commands.includes(`backup.offsite.${key}`), key);
  }
  // ... the ones the prose adds to a release; and the ones it quotes alone.
  for (const key of ['backend.tcpRmem', 'images.pullSecret', 'alerts.heartbeatUrl']) {
    assert.ok(keys.prose.includes(key), key);
  }
  for (const key of ['backend.trustedProxyCidrs', 'backup.hostPath', 'images.pullSecret']) {
    assert.ok(keys.quoted.includes(key), key);
  }
  // cert-manager's value is its own chart's, the one of another chart.
  const certManager = 'helm install cert-manager oci://quay.io/jetstack/charts/cert-manager';

  assert.deepEqual(keys.otherCharts, [
    `${certManager}: crds.enabled`,
    `${certManager}: crds.enabled`,
  ]);
});

test('the check of the keys fails, naming the key, on a mutated copy of README.md or of the values (#395, criterion 3)', () => {
  const text = readme();
  const values = chartValues();
  const without = (path) => {
    const copy = chartValues();
    const keys = path.split('.');

    delete keys.slice(0, -1).reduce((node, key) => node[key], copy)[keys.at(-1)];

    return copy;
  };

  // A key renamed in one copy of the release, in the Install section or in
  // step 6; in the off-server copy's lines, which name no helm command.
  for (const last of [false, true]) {
    assert.deepEqual(
      missingKeys(
        replaced(text, 'ingress.tls.issuer=$ISSUER', 'ingress.tls.clusterIssuer=$ISSUER', last),
        values,
      ),
      ['ingress.tls.clusterIssuer'],
    );
  }
  assert.deepEqual(
    missingKeys(replaced(text, 'backup.offsite.region=', 'backup.offsite.zone='), values),
    ['backup.offsite.zone'],
  );
  // A key renamed in the chart's values: set in prose, quoted, or both.
  assert.deepEqual(missingKeys(text, without('backend.tcpRmem')), ['backend.tcpRmem']);
  assert.deepEqual(missingKeys(text, without('backend.trustedProxyCidrs')), [
    'backend.trustedProxyCidrs',
  ]);
  assert.deepEqual(missingKeys(text, without('images.pullSecret')), ['images.pullSecret']);
  assert.deepEqual(missingKeys(text, without('images.tag')), ['images.tag']);

  // cert-manager's value given to this chart is named.
  assert.deepEqual(
    missingKeys(
      replaced(text, '--wait --timeout 10m', '--set crds.enabled=true --wait --timeout 10m'),
      values,
    ),
    ['crds.enabled'],
  );

  // Each form of the flag; commas, as helm splits them; no `<key>=`; a key
  // past a value; a fenced block of another language is not read.
  const release = (flags) =>
    `\`\`\`bash\nhelm upgrade --install x deploy/helm/qa-tools ${flags}\n\`\`\`\n`;

  for (const [flags, missing] of [
    ['--set-string=images.tagg=x', ['images.tagg']],
    ['--set images.tag=x,images.nope=y', ['images.nope']],
    ['--set-string images.tag=x\\,images.nope=y', []],
    ['--set-json images.nope={"a":1,"b":2}', ['images.nope']],
    ['--set-literal images.tag=a,b=c', []],
    ['--set-file "backup.offsite.recipientKey=key file.asc"', []],
    ["--set-string 'images.nope=x'", ['images.nope']],
    ['--set-string images.tag', ['--set-string images.tag']],
    ['--set-string =x', ['--set-string =x']],
    ['--set', ['--set']],
    ['--set-string images.tag.value=x', ['images.tag.value']],
    ['--set-string images..tag=x', ['images..tag']],
    ['--set-string images.list[0]=x', ['images.list[0]']],
    ['--set-string images\\.tag=x', ['images\\.tag']],
    ['--set-string __proto__.x=y --set-string constructor=z', ['__proto__.x', 'constructor']],
    ['--set-string ingress.tls=x --set-string ingress.tls.secretName=', []],
    ['--settings images.nope=x', []],
  ]) {
    assert.deepEqual(missingKeys(release(flags), values), missing, flags);
  }
  assert.deepEqual(
    missingKeys(
      '```text\nhelm upgrade --install x deploy/helm/qa-tools --set a.b=c\n```\n',
      values,
    ),
    [],
  );
  assert.deepEqual(missingKeys('```sh\n--set-string images.nope=x\n```\n', values), [
    'images.nope',
  ]);
  // Another chart's values are its own; this chart named in the same line
  // of commands is still this chart.
  assert.deepEqual(
    missingKeys(
      '```bash\nhelm install x repo/chart --set a.b=c && helm upgrade --install y ./deploy/helm/qa-tools/ --set d.e=f\n```\n',
      values,
    ),
    ['d.e'],
  );
  // In prose: a flag with its key, quoted keys under a top-level key alone.
  assert.deepEqual(
    missingKeys(
      'Add `--set-string images.nope=` or\n`--set\nalerts.nope=x`; `backend.nope`, `net.ipv4.tcp_rmem`, `llms.txt`, `--set-string`.\n',
      values,
    ),
    ['images.nope', 'alerts.nope', 'backend.nope'],
  );
});

test('every command of README.md\'s Install section, but the variables it sets, is given as it stands in "Installing on k3s with the chart" (#395, criterion 2)', () => {
  const text = readme();
  const commands = installCommands(text);

  assert.deepEqual(installCommandsMissing(text), []);
  // What is compared: the three builds, the push loop, the namespace, the
  // database's Secret, the backup directory and the release.
  assert.deepEqual(
    commands.map((command) => command.split(' ').slice(0, 2).join(' ')),
    [
      'docker build',
      'docker build',
      'docker build',
      'for image',
      'kubectl create',
      'kubectl -n',
      'sudo install',
      'helm upgrade',
    ],
  );
  assert.equal(commands[3], PUSH_LOOP);
  assert.equal(commands[6], 'sudo install -d -o 999 -g 999 -m 0700 /var/backups/webhook-inspector');
  assert.equal(commands[7], RELEASE);
});

test('the check of the Install section fails, naming the command, on a mutated copy of README.md, and reads continuation lines and indentation alone as the same command (#395, criterion 3)', () => {
  const text = readme();
  const step6 = text.lastIndexOf('helm upgrade --install inspector');

  // A command edited in the Install section, or in the full section.
  assert.deepEqual(installCommandsMissing(replaced(text, '--timeout 10m', '--timeout 5m')), [
    RELEASE.replace('10m', '5m'),
  ]);
  assert.deepEqual(installCommandsMissing(replaced(text, '--timeout 10m', '--timeout 5m', true)), [
    RELEASE,
  ]);
  assert.deepEqual(
    installCommandsMissing(replaced(text, 'frontend:$TAG postgres', 'postgres', true)),
    [PUSH_LOOP],
  );
  assert.deepEqual(
    installCommandsMissing(replaced(text, 'kubectl create namespace inspector\n', '', true)),
    ['kubectl create namespace inspector'],
  );
  const directory = 'sudo install -d -o 999 -g 999 -m 07';

  assert.deepEqual(
    installCommandsMissing(replaced(text, `${directory}00`, `${directory}55`, true)),
    ['sudo install -d -o 999 -g 999 -m 0700 /var/backups/webhook-inspector'],
  );
  // A command added to the Install section alone.
  assert.deepEqual(
    installCommandsMissing(
      replaced(
        text,
        'kubectl create namespace inspector\n',
        'kubectl create namespace inspector\nkubectl get pods\n',
      ),
    ),
    ['kubectl get pods'],
  );

  // The release wrapped at other places and indented otherwise is the same
  // command; so is the Install section's with its comment changed.
  const end = text.indexOf('--timeout 10m', step6) + '--timeout 10m'.length;
  const rewrapped =
    text.slice(0, step6) +
    'helm upgrade --install inspector \\\n' +
    '         deploy/helm/qa-tools --namespace inspector --set-string images.registry=$REGISTRY \\\n' +
    '\t--set-string images.tag=$TAG --set-string ingress.host=$SITE_HOST \\\n' +
    '   --set-string receive.host=$RECEIVE_HOST --set-string ingress.tls.issuer=$ISSUER \\\n' +
    '   --wait --timeout 10m' +
    text.slice(end);

  assert.deepEqual(installCommandsMissing(rewrapped), []);
  assert.deepEqual(
    installCommandsMissing(replaced(text, '# on the node itself', '# a comment of its own')),
    [],
  );
  // A line break is read as the shell reads it: with no white space on
  // either side, the two lines make one word, and another command.
  assert.deepEqual(
    installCommandsMissing(
      replaced(
        text,
        'inspector \\\n     --set-string images.registry',
        'inspector\\\n   --set-string images.registry',
        true,
      ),
    ),
    [RELEASE],
  );

  // A push loop over several lines is one command, compared whole.
  const loop =
    'for image in backend:$TAG frontend:$TAG postgres:16-pgcron-1; do\n  docker push $REGISTRY/$image\ndone';
  const spread =
    'for image in backend:$TAG frontend:$TAG postgres:16-pgcron-1; do\ndocker push $REGISTRY/$image\ndone';

  assert.deepEqual(installCommandsMissing(replaced(text, PUSH_LOOP, loop)), [spread]);
  assert.deepEqual(
    installCommandsMissing(
      replaced(replaced(text, PUSH_LOOP, loop), PUSH_LOOP, loop.replaceAll('\n', '\n      '), true),
    ),
    [],
  );
});

test("the README's readers on made-up input built to break them, at growing sizes: fences, sections, shell commands, assignments and prose (#395)", () => {
  // Fences: a longer fence closes only with as long a one, of its own
  // character; an open fence runs to the end; a backtick in a backtick
  // fence's info string makes no fence; the fence's indentation is removed.
  assert.deepEqual(
    readMarkdown('````bash\n```\nx\n~~~\n````\ny\n').blocks.map((each) => each.lines),
    [['```', 'x', '~~~']],
  );
  assert.deepEqual(readMarkdown('~~~sh\na\n```').blocks, [
    { info: 'sh', line: 1, lines: ['a', '```'] },
  ]);
  assert.deepEqual(readMarkdown('```ba`sh\na\n```\n').blocks, [{ info: '', line: 3, lines: [''] }]);
  assert.deepEqual(readMarkdown('   ```bash\n     a\n  b\n```\n').blocks[0].lines, ['  a', 'b']);
  assert.equal(readMarkdown('a\n```bash\n--set x=y\n```\nb').prose, 'a\n\n\n\nb');

  // Sections: a heading inside a block ends nothing; a heading twice, or
  // none, is refused.
  assert.equal(
    readmeSection('## A\n```bash\n## B\n```\nx\n### C\ny\n', '## A'),
    '```bash\n## B\n```\nx',
  );
  assert.throws(() => readmeSection('## A\n## A\n', '## A'), /one "## A", not 2/);
  assert.throws(() => readmeSection('```\n## A\n```\n', '## A'), /one "## A", not 0/);

  // Shell commands.
  for (const [script, commands] of [
    ['a \\\n  b \\\n\tc', ['a b c']],
    ['a\\\nb', ['ab']],
    ['a\\\n  b', ['a b']],
    ['a \\\\\nb', ['a \\\\', 'b']],
    ['a \\\\\\\nb', ['a \\\\b']],
    ['a # c \\\nb', ['a', 'b']],
    ['a "# x" \'# y\' $# ${#z} b#c # d', ['a "# x" \'# y\' $# ${#z} b#c']],
    ["a;# it's\nb", ['a;', 'b']],
    ['a "x\n  y" b\nc', ['a "x\n  y" b', 'c']],
    ["a 'x \\\ny' b", ["a 'x \\\ny' b"]],
    ['a "x \\\n  y"', ['a "x   y"']],
    [
      'for i in 1 2\ndo\n  echo $i  # each\ndone\nnext',
      ['for i in 1 2\ndo\necho $i\ndone', 'next'],
    ],
    ['if a; then\n  for x in y; do z; done\nfi', ['if a; then\nfor x in y; do z; done\nfi']],
    ['echo for done\nb', ['echo for done', 'b']],
    ['for x in "done"; do\n"done"\ndone', ['for x in "done"; do\n"done"\ndone']],
    [
      'case $x in\n  a) for y in z; do w; done;;\nesac',
      ['case $x in\na) for y in z; do w; done;;\nesac'],
    ],
    [
      'cat <<-EOF > f\n  a # not a comment\n  EOF\nb',
      ['cat <<-EOF > f\n  a # not a comment\n  EOF', 'b'],
    ],
    [
      "kubectl apply -f - <<'EOF'\nit's\nEOF\nnext",
      ["kubectl apply -f - <<'EOF'\nit's\nEOF", 'next'],
    ],
    ['a <<< "x"\nb', ['a <<< "x"', 'b']],
    ['\n\n  \n\t\n', []],
    ['a\r\nb\r\n', ['a', 'b']],
    ['while true; do', ['while true; do']],
    ['a "open', ['a "open']],
    ['a \\', ['a']],
  ]) {
    assert.deepEqual(shellCommands(script), commands, JSON.stringify(script));
  }

  // Assignments: the chart named by another helm command in one line.
  assert.deepEqual(
    setAssignments('helm template a b/c --set x=1 helm lint deploy/helm/qa-tools --set y=2'),
    [
      { key: 'x', chart: 'helm template a b/c' },
      { key: 'y', chart: null },
    ],
  );
  assert.deepEqual(setAssignments('--set-string a=b'), [{ key: 'a', chart: null }]);

  const values = chartValues();

  for (const size of [10, 1000, 100_000]) {
    const many = (part, separator = '') => Array.from({ length: size }, () => part).join(separator);

    // A fence of `size` backticks closed by one shorter is open to the end.
    assert.equal(
      readMarkdown(`${'`'.repeat(size)}bash\na\n${'`'.repeat(size - 1)}\n`).blocks[0].lines.length,
      3,
      `fence ${size}`,
    );
    assert.equal(readMarkdown(many('```bash\nx\n```\n')).blocks.length, size, `blocks ${size}`);
    assert.equal(readMarkdown(many('#', ' ')).headings.length, 1, `heading ${size}`);
    assert.equal(
      readmeSection(`## A\n${many('x\n')}## B\n`, '## A').length,
      size * 2 - 1,
      `section ${size}`,
    );

    // Continuations, backslashes, comments, quotes, loops and here-documents.
    assert.deepEqual(shellCommands(many('a \\\n')), [many('a', ' ')], `continued ${size}`);
    assert.deepEqual(shellCommands(`${'\\'.repeat(size * 2)}\nb`), ['\\'.repeat(size * 2), 'b']);
    assert.deepEqual(shellCommands(`${'\\'.repeat(size * 2 + 1)}\nb`), [
      `${'\\'.repeat(size * 2)}b`,
    ]);
    assert.deepEqual(shellCommands(`a ${many('#')}\nb`), ['a', 'b'], `comment ${size}`);
    assert.deepEqual(shellCommands(`'${many('x\n')}`), [`'${many('x\n')}`.trim()], `quote ${size}`);
    assert.deepEqual(shellCommands(`"${many('\\"')}"\nb`), [`"${many('\\"')}"`, 'b']);
    assert.equal(shellCommands(`${many('for x in y; do\n')}z\n${many('done\n')}`).length, 1);
    assert.equal(shellCommands(`${many('for x in y; do\n')}z\n`).length, 1, `open loops ${size}`);
    assert.equal(shellCommands(many('<<', ' ')).length, 1, `operators ${size}`);
    assert.equal(shellCommands(`${many('<<a ')}\n${many('a\n')}b\n`).length, 2, `heredocs ${size}`);
    assert.deepEqual(shellCommands(`cat <<${many('x')}\n${many('y\n')}`), [
      `cat <<${many('x')}\n${many('y\n')}`.trimEnd(),
    ]);

    // Assignments and keys: long, many, odd.
    assert.deepEqual(setAssignments(many('--set', ' ')).length, Math.ceil(size / 2));
    assert.deepEqual(setAssignments(`--set ${many('=')}`), [
      { key: `--set ${many('=')}`, chart: null },
    ]);
    assert.equal(setAssignments(`--set ${many('a=b', ',')}`).length, size, `commas ${size}`);
    assert.equal(setAssignments(many('helm', ' ')).length, 0, `helm ${size}`);
    assert.equal(hasKey(values, many('images', '.')), false, `depth ${size}`);
    assert.deepEqual(
      missingKeys(`\`\`\`bash\n--set ${many('a', '.')}=b\n\`\`\`\n`, values),
      [many('a', '.')],
      `path ${size}`,
    );

    // Prose: a flag followed by a long word with no `=`, a long run of
    // spaces, a long quoted path, many backticks.
    assert.deepEqual(missingKeys(`--set ${many('a')} b`, values), [], `prose ${size}`);
    assert.deepEqual(missingKeys(`--set${many(' ')}images.nope=x`, values), ['images.nope']);
    assert.deepEqual(missingKeys(`\`images${many('.a')}\``, values), [`images${many('.a')}`]);
    assert.deepEqual(missingKeys(`\`images${many('.a')}`, values), [], `open span ${size}`);
    assert.deepEqual(missingKeys(many('`'), values), [], `backticks ${size}`);

    // Assignments a command of the Install section may be.
    assert.equal(ASSIGNMENT.test(`X=$${many('a')} `), false, `assignment ${size}`);
    assert.equal(ASSIGNMENT.test(`X=$(${many('a')}`), false, `assignment ${size}`);
    assert.equal(ASSIGNMENT.test(`X=$(${many('a')})`), true, `assignment ${size}`);
  }
  assert.equal(ASSIGNMENT.test('TAG=$(git rev-parse --short HEAD)'), true);
  assert.equal(ASSIGNMENT.test('X="a b"'), true);
  for (const command of ['X=1 kubectl create x', 'X=$(a) b', 'X=a;b', 'X=$(a (b))', 'x y=1']) {
    assert.equal(ASSIGNMENT.test(command), false, command);
  }
});
