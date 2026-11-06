# Flaky tests

A flaky test here is one that passes and fails on the same code. Nearly
every test below holds a time — a wall-clock bound, or a wait of fixed
length — and fails only on a machine loaded well beyond one suite's own
work: both suites at once, other heavy processes beside them, or a busy CI
runner. None of them is known to be a fault of the product. A
test listed here that fails as shown, on a loaded machine, is the known
flake: run it again alone before taking the change as its cause. A test that
fails every time is not flaky: the frontend's tests of the recipe's waiting
step, in `apps/frontend/src/lib/llms.test.ts`, fail without `jq` on the
`PATH`, as [Running locally](../../README.md#running-locally) says.

## Running a suite, a file or one test

A whole suite runs from the repository root, one command per workspace:

```sh
npm test -w @webhook-inspector/backend
npm test -w @webhook-inspector/frontend
```

Each workspace's `test` script carries its suite's flags, so none is typed,
and the backend suite needs the database running and migrated ([Tests and
checks](../../README.md#tests-and-checks)). A single file, or one test by a
part of its name, goes through the same script, the path taken from the
workspace's directory:

```sh
npm test -w @webhook-inspector/frontend -- src/lib/<name>.test.ts
npm test -w @webhook-inspector/backend -- --test-name-pattern='<part of its name>' src/<path>.test.ts
```

Never a bare `node --test` on a file, which loads neither the suite's exit
guard nor the script's flags. Neither suite is run with `--test-force-exit`,
and no flag is given through the root `npm test`, which hands it to both:
under load that flag cut the tail of a test file's report off while the run
still exited 0 (F-02 for the frontend, F-14 for the backend), so a count
taken that way is not the suite's. Each suite loads an exit guard instead,
which fails a test file whose process is still alive 10 s after its last
test, naming what keeps it alive.

## Still failing now and then

Each test is given with its file, the entries of the measurement log that
record it (F-numbers, see the last line), the failure as it appears, and the
command that runs it again; where the log kept no message, the check made.

### [`apps/backend/src/modules/requests/request-wait.test.ts`](../../apps/backend/src/modules/requests/request-wait.test.ts)

- `with 200 waits at once, on one session and across sessions` (F-07,
  F-14, F-21, F-26, F-27): `answered after 5089 ms`, 5001 to 5296 ms in the
  runs recorded, a wait answered past the test's 5000 ms. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='with 200 waits at once' src/modules/requests/request-wait.test.ts`
- `until a request is captured: wait=10 with a capture at about 1 s answers before 2 s`,
  `with 200 [] when the session is cleared, with after`,
  `with 200 [] when the session is cleared, without after`,
  `with 404 / 1001 when the session is deleted` and
  `captured while a read after an announcement is under way` (F-14), each a
  few times under the heaviest load, its message not kept: each holds its
  answer to 2000 ms (the first and the last) or 1000 ms, and fails past it as
  `answered after <n> ms`. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='answers before 2 s|when the session is cleared|when the session is deleted|captured while a read after an announcement' src/modules/requests/request-wait.test.ts`

### [`apps/backend/src/modules/webhook/pipelining.test.ts`](../../apps/backend/src/modules/webhook/pipelining.test.ts)

Three tests, each in both suites `a connection that pipelines, PROXY
protocol off (D229)` and `… PROXY protocol v2 (D229)`, each failing at its
20 s wait (F-14, F-21, F-28):

- `has at most 32 requests read and unanswered, and gets all 300 of its GETs answered in order`:
  `timed out waiting until all 300 are answered`.
- `holds at most the bound for a client that reads none of its answers, and delivers them all once it reads`:
  `timed out waiting until all 200 are delivered`, the number the case's
  own, set by the machine's socket buffers (224 on another machine).
- `bounds a burst that comes after the connection has been used`:
  `timed out waiting until the burst is answered`.

Rerun:
`npm test -w @webhook-inspector/backend -- --test-name-pattern='gets all 300 of its GETs|reads none of its answers|bounds a burst that comes after' src/modules/webhook/pipelining.test.ts`

### [`apps/backend/src/measure-ordinary-load.test.ts`](../../apps/backend/src/measure-ordinary-load.test.ts)

- `writes the event loop's turns and events, a last line as the process exits`
  (F-21, F-22, F-23): `AssertionError [ERR_ASSERTION]: 59 turns`, at least
  60 expected.
- `runs the production mode within its budget, records every session before using it and deletes every one`
  (F-14, F-21): `{"verdict":false,"reasons":["capture p99 1240.6 ms, not under 1000 ms"]}`.
- `names each user's own address to the backend in the per-user mode, reloads the page, and keeps the reloads out of the errors`
  (F-14), its message not kept: as the test above, it fails on the probe's
  verdict, its report as the message.

Rerun:
`npm test -w @webhook-inspector/backend -- --test-name-pattern='turns and events|runs the production mode within its budget|in the per-user mode' src/measure-ordinary-load.test.ts`

### One test in each of seven more backend files

- [`rate-limit-routes.test.ts`](../../apps/backend/src/modules/limits/rate-limit-routes.test.ts):
  `captures more than 1200 webhooks a minute from one address, every one answered and stored`
  (F-07, F-14, F-21), cut off by the suite's per-test timeout,
  `test timed out after 120000ms`. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='captures more than 1200 webhooks' src/modules/limits/rate-limit-routes.test.ts`
- [`receiver-http2.test.ts`](../../apps/backend/src/modules/webhook/receiver-http2.test.ts):
  `hands a connection that has sent nothing, or only P or PR, to HTTP/1.1 at the deadline, and captures what follows (PROXY off)`
  and its `(PROXY v2)` twin (F-21): `AssertionError [ERR_ASSERTION]`, its
  message the case, `''` or `PR`, the answer read not `HTTP/1.1 200 OK`. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='hands a connection that has sent nothing' src/modules/webhook/receiver-http2.test.ts`
- [`mcp.test.ts`](../../apps/backend/src/modules/mcp/mcp.test.ts):
  `answers within 500 ms of a capture, not at the end of its 10 s wait, as list_requests lists it`
  (F-07, F-14): `answered 533.0 ms after the capture`. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='answers within 500 ms of a capture' src/modules/mcp/mcp.test.ts`
- [`request-list.test.ts`](../../apps/backend/src/modules/requests/request-list.test.ts):
  `answers 503 / 1011, and the same query succeeds where it is given its 2 s`
  (F-07): the query given its 2 s answered `503` / `1011`, not `200`. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='the same query succeeds where it is given its 2 s' src/modules/requests/request-list.test.ts`
- [`capture-admission.test.ts`](../../apps/backend/src/modules/webhook/capture-admission.test.ts):
  `holds an address to its 16 MiB with small GETs whose delayed answers are at their bound, each holding no more than it was admitted for`
  (F-07): 12 of its 243 answers `503` where each was to be `200`. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='holds an address to its 16 MiB with small GETs' src/modules/webhook/capture-admission.test.ts`
- [`measure-rollout.test.ts`](../../apps/backend/src/measure-rollout.test.ts):
  `keeps a viewer cut while it runs whole: it reconnects, reloads, and nothing is missing`
  (F-14), its message not kept: the test cuts the probe's viewers and fails
  on its report if one did not reconnect or missed an event. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='keeps a viewer cut while it runs whole' src/measure-rollout.test.ts`
- [`pool.test.ts`](../../apps/backend/src/db/pool.test.ts):
  `ends a lent-out connection left idle in a transaction: its event never commits, …`
  (F-14), its message not kept: the test waits up to 5000 ms for the
  database to end that connection, and fails past it as
  `server process <pid> was not ended within 5000 ms`. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='ends a lent-out connection left idle' src/db/pool.test.ts`

### [`apps/backend/src/modules/sessions/access-key.test.ts`](../../apps/backend/src/modules/sessions/access-key.test.ts)

Open issue: #419. Both hold the fastest of five runs to 100 ms:

- `answers made-up headers of 1048576 characters at once` (F-24, F-27,
  F-30): `took 115.3 ms at best in 5 runs, over the 100 ms bound`.
- `answer made-up handshakes of 1048576 characters under both prefixes at once`
  (F-24, F-26, F-27, F-29, F-31): `took 113.4 ms at best in 5 runs, over the 100 ms bound`,
  102.9 to 116.2 ms in the runs recorded.

Rerun:
`npm test -w @webhook-inspector/backend -- --test-name-pattern='headers of 1048576 characters at once$|handshakes of 1048576 characters' src/modules/sessions/access-key.test.ts`

## Changed, the cause not established

Two memory tests changed after failing on CI; the log records the cause of
their readings over the bound as not established, so either may still fail:

- `keeps at most 48 KiB and no body per wait: <shape>`, in
  [`apps/backend/src/modules/mcp/mcp-memory.test.ts`](../../apps/backend/src/modules/mcp/mcp-memory.test.ts)
  (F-18): `16 pending waits: 0 bodies kept, 0.93 MiB more held, 59.6 KiB a call`.
  Its report names the heap space the bytes went to. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='no body per wait' src/modules/mcp/mcp-memory.test.ts`
- `keeps at most 64 KiB a wait: <shape>`, in
  [`apps/backend/src/modules/limits/calls-memory.test.ts`](../../apps/backend/src/modules/limits/calls-memory.test.ts)
  (F-25): `16 calls, 16 pending: 1165.8 KiB more held, 72.9 KiB a call`; it
  now holds the least of up to three rounds to the bound. Rerun:
  `npm test -w @webhook-inspector/backend -- --test-name-pattern='KiB a wait' src/modules/limits/calls-memory.test.ts`

## Watched, not seen failing

The log also names tests that hold a single wall-clock run to a bound and
passed in every run it recorded; a failure of one under load would be of the
same kind, run again as above: `answers hostile values of 1 KiB, 64 KiB and 1 MiB within 100 ms, as unreadable`
in `apps/backend/src/modules/limits/rate-limit.test.ts` (F-07); the one-run
bounds of 1 s of `apps/backend/src/modules/limits/calls-in-flight-routes.test.ts`,
F-10's count loop among them (F-10, F-21);
`refuses 100,000 answers of one full address quickly, …` in
`apps/backend/src/modules/limits/answer-budget.test.ts`, whose message,
`refusing the flood took too long`, is that of `capture-budget.test.ts`
too (F-27); `planRawSearch: hostile queries` in
`apps/frontend/src/lib/request-filter.test.ts` and
`stands hostile bodies at growing sizes in one pass, its message a line` in
`apps/frontend/src/lib/response-template.test.ts` (F-29);
`reads hostile probe files of growing size in linear time`,
`names modules by package, path or pseudo-node, …` and
`reads pg_stat_statements' counts, …` in
`apps/backend/src/measure-ordinary-load.test.ts` (F-30, F-31); and
`runs every pending wait out at once on close, each after one last read` in
`apps/backend/src/modules/requests/wait.test.ts` (F-31).

The F-numbers here and in code comments, and a comment that cites this file
for a measurement, name entries of the full measurement log of these tests,
kept with the project's private records: as the
[README](../../README.md#how-it-is-built) says of `#N` and `DN`, they lead to
nothing public.
