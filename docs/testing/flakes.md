# Flaky tests

A measurement log. One section per test observed to fail intermittently, holding
what was measured, how, and what was done about it. It records numbers, not
choices: nothing here decides anything, so nothing here belongs in the
decision log.

Each entry carries the test id and its `file:line`, the base commit, the exact
command, the iteration and failure counts, the failure output as it appeared,
the mechanism, and the current status. A fixed flake keeps its entry: the
pre-fix measurement is what makes the post-fix one mean something.

A whole suite is measured from the repository root in the form the agent
definitions prescribe (D132, amendments 2026-09-26 and 2026-10-01), one command
per workspace:

```sh
npm test -w @webhook-inspector/backend
npm test -w @webhook-inspector/frontend
```

Each workspace's `test` script carries its suite's flags, so none is typed. The
entries below keep the commands they were measured with, which until 0.36.1
carried the flags typed by hand. Neither suite is run with
`--test-force-exit`, and never through the root `npm test -- -- <flags>`, which
hands a flag to both: under load that flag drops the tail of a test file from
the report while the run still exits 0 (F-02 for the frontend, F-14 for the
backend), so a count taken that way is not the suite's count. A single file,
or a name pattern, is run through its workspace's script, the path taken from
the workspace's directory, and never through a bare `node --test`, which loads
neither the suite's exit guard nor the script's flags (D132, amendments
2026-09-27 on #63 and 2026-10-20 on #160); for a task in the delivery queue
the backend's goes through `node scripts/db.mjs task-test <task> -- <path>`:

```sh
npm test -w @webhook-inspector/frontend -- src/lib/<name>.test.ts
```

Rates are reported with a [Wilson score
interval](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval)
at 95%, because a handful of failures is a small sample and a bare percentage
reads far more precise than it is.

## F-01 — `answers 415 for an oversized body with no content-type`

- **Test**: `apps/backend/src/modules/sessions/sessions.test.ts:420` when
  measured, `:538` after the fix below, `:651` once issue #12 was fixed.
- **Status**: fixed in the test helper on `chore/flaky-oversized-body-test`. The
  server was not changed, and it generated the 415 every time. It would be too
  strong to say it never misbehaved: the same measurement shows the server
  discarding a response it had already written, by resetting a connection that
  still had unread request data arriving. That is a product finding, not a test
  one, and it is recorded as issue #12, **"A refusal answered before the
  request body is drained can be lost to a TCP reset"**, in the issue
  tracker of qa-tools, where this code lived then. Changing the server
  is out of scope for this chore; the test stops depending on the race either
  way.
- **The product finding is closed** by D143, which delivered issue #12. See
  **After issue #12** at the end of this entry.

### The pre-fix measurement

Measured on clean `origin/main` at `799dc63`, Node v24.19.0, a dedicated
disposable PostgreSQL with `pg_cron` (D073), otherwise-idle machine. Every
iteration was a fresh process, no iteration was retried, and no failing run was
re-run to recover a green result.

| Mode | Command | Runs | Failures | Rate (Wilson 95%) |
| --- | --- | --- | --- | --- |
| Full suite | `npm test` | 60 | 2 | 3.3% (0.9%–11.4%) |
| Single file | `node --test apps/backend/src/modules/sessions/sessions.test.ts` | 100 | 3 | 3.0% (1.0%–8.5%) |
| **Combined** | — | **160** | **5** | **3.1% (1.3%–7.1%)** |

Roughly one run in 32, with the interval spanning one in 75 to one in 14. Five
failures is a small sample and the error bars are wide; the point estimate
should not be quoted on its own.

No other test failed in any of the 160 runs.

The failures raised `ECONNRESET` three times and `EPIPE` twice, all from the
write side:

```text
✖ answers 415 for an oversized body with no content-type
  Error: write ECONNRESET
      at WriteWrap.onWriteComplete (node:internal/stream_base_commons:87:19)
```

It reproduces on `main` with none of the v0.5.0 work present, so it is
pre-existing. The higher rate seen on the v0.5.0 branches (about one run in
eight) is the same defect on a busier machine, not a second one.

### The mechanism

1. `apps/backend/src/modules/sessions/routes.ts` refuses the request on an
   `onRequest` hook, deliberately before the body is read, so that the media
   type is checked before `bodyLimit` (D104). The server answers 415 / 1007 and
   closes with more than a megabyte of body never consumed.
2. The test wrote that whole body in a single `socket.write`, far past anything
   the socket buffers can hold, so the client was still writing when the server
   tore the connection down.
3. Closing a connection that still has unread data arriving is a TCP reset, and
   a reset discards whatever the client has received but not yet read — the 415
   included. The helper then rejected, because it only tolerated a write-side
   error once at least one response byte had been read:

   ```ts
   socket.on('error', (error) => (response === '' ? reject(error) : resolve(response)));
   ```

The server produced the response every time. A throwaway probe against the real
server counted `onResponse` for all 800 exchanges it made, while the client saw
nothing in 29 of the 200 that wrote the whole body as one blast. Slowing the
client's writes made it strictly worse, which is the signature of the reset
rather than of a slow reader — a slow reader would improve as the writes slow,
not degrade. Writing the whole megabyte in 64 KiB chunks lost 95 of 200, in
8 KiB chunks 120 of 200, in 1 KiB chunks 194 of 200.

Chunk size there is how the whole body was written. It is **not** the same
variable as the prefix size under **The fix** below, which is how much of the
body is written *before waiting for the response*. The two move loss in opposite
directions: smaller chunks stretch the write out, so loss goes up, while a
smaller prefix leaves less unread data in flight when the refusal is decided, so
loss goes down.

The same race had a second shape. A response read only as far as its header
terminator left `rawErrorCode` parsing a truncated body, so the test could also
fail inside `JSON.parse` rather than on the socket.

### The first attempt, and why the read side alone was not enough

The first fix changed the reader and nothing else: tolerate a write-side `EPIPE`
or `ECONNRESET` as the expected end of a refused exchange, settle on `close` with
whatever had been read, require a complete response rather than a header block,
and bound the wait. The test still wrote the whole body in one `socket.write`.

It **failed 3 of 120 runs** — 2.5%, Wilson 95% **0.9%–7.1%**. That interval
overlaps the pre-fix one almost entirely, so it is not an improvement anyone
could claim. The failures were not truncations either. The client had read
nothing at all:

```text
✖ answers 415 for an oversized body with no content-type
  Error: the connection closed on an incomplete response: ""
```

Which is the point. A reader cannot recover bytes the reset discarded before it
ever saw them, so tolerance on the read side cannot help; what had to change was
how much unread request data was still arriving when the server closed. This
attempt never reached a commit, so this paragraph is its only record — and it is
the evidence that the 32 KiB prefix is load-bearing rather than
belt-and-braces. Remove the prefix on the grounds that the reader is robust now,
and the flake comes back at roughly the rate above.

### The fix

In the test only. The server is unchanged: its answer is the documented one and
the ordering it applies is correct, and the separate question of the answer
being lost on the wire is issue #12, named in the status above, not something
a test helper should paper over by changing the server.

- The raw-socket read is shared by one bounded reader, `readRawExchange`. It
  decodes latin1 so the string length is a byte count, treats a write-side
  `EPIPE` / `ECONNRESET` as the expected end of a refused exchange rather than
  an error, settles on `close` with what was read, and returns the response only
  once it is whole — header terminator plus the declared `Content-Length` bytes,
  or, for a response declaring no length at all, the header terminator once the
  connection has closed — failing with a clear message otherwise. A response
  that never completes fails on a 5 s bound instead of hanging the suite, which
  is the same bound `readRawResponse` in `webhook.test.ts` uses. They are not
  the same helper and no longer share a name: this one takes a writer callback
  and hands back only a complete response, while that one takes a request string
  and waits a grace period after the header block so that "no body followed" can
  be told apart from "the body has not arrived yet".
- The oversized case writes the header block and then the first 32 KiB of the
  body, and waits. That number is **body bytes written as a prefix before
  waiting for the response** — it is not an amount held back. A larger prefix is
  therefore riskier, not safer: it leaves more unread data in flight when the
  refusal is decided. 32 KiB is enough for the body to be genuinely in flight at
  that moment, and little enough that the server can drain it and close cleanly
  instead of resetting. By prefix size, the same probe measured 0 losses in 200
  exchanges each at 0, 4 KiB and 64 KiB; 17 of 200 at 256 KiB; and 0 in 1000
  exchanges at the 32 KiB the test now uses. Writing the whole 1 MiB is the
  largest prefix there is, and it is the 29 of 200 recorded above. The curve
  runs one way only: loss first appears between 64 and 256 KiB and grows from
  there.

What the test asserts is unchanged: the server answers **415** with error code
**1007**, and no session row is created. The request still declares
`Content-Length` above `MAX_BODY_BYTES` and still carries no `Content-Type`, and
that header block is what the route rules on. If the order ever regressed to
size before media type the test still fails, but most likely on the status
assertion rather than on the bound: Fastify compares a declared `Content-Length`
against `bodyLimit` before reading the body, so such a regression would answer
`413` / `1004` promptly. It fails on the 5 s bound only in the variant where the
regression waits for a body this client never finishes sending. Either way it
fails, and a timeout here means the regression rather than a broken helper.

### The post-fix measurement

Same machine, same Node, same disposable database, on
`chore/flaky-oversized-body-test`. Fresh process per iteration, no retries, exit
code recorded for each.

| Mode | Command | Base | Runs | Failures | Rate (Wilson 95%) |
| --- | --- | --- | --- | --- | --- |
| Single file | `node --test apps/backend/src/modules/sessions/sessions.test.ts` | `7119b27` | 150 | 0 | 0% (0%–2.5%) |
| Single file, re-check | same | review fixes | 50 | 0 | 0% (0%–7.1%) |

150 clean runs cannot prove the rate is zero; they put it under about 1 in 40 at
95% confidence, where the pre-fix interval started at 1 in 75. The mechanism
above is the stronger evidence, and the two together are what the entry rests
on.

The second row is a re-check, not a second measurement: review fixes touched the
helper after the 150 runs, so the 150 no longer describe the exact code in the
tree. What changed cannot reach this path — `readRawResponse` was renamed
`readRawExchange`, and `isRawResponseComplete` gained a branch that only fires
for a response declaring no `Content-Length`, which the 415 always declares — and
50 fresh processes with no retries were green. On its own that row bounds the
rate only at about 1 in 14, which is weaker than the pre-fix point estimate; it
is there to show the change was exercised, and the 150 above remain the number
worth quoting.

### After issue #12

The product finding above is closed by D143. When the create route refuses a
request on a connection Node is about to close, it now reads and discards a
body of at most 4 MiB (`MAX_REFUSAL_DRAIN_BYTES`) before answering, so the
refusal is no longer lost to a reset on that path. Chunked bodies and bodies
over 4 MiB are still answered at once, and `docs/API.md` states that limit.

Two things changed in `sessions.test.ts` with it.

- **This test declares a larger body.** It keeps its shape: the head, the
  32 KiB prefix, `Connection: close`, then waiting for the answer. Its declared
  `Content-Length` is now past the drain limit as well as the body limit. With
  the old length the server would wait for a body this test never finishes, and
  it did: run unchanged against the fix, it failed on its 5 s bound with
  `no complete response arrived within 5000ms: ""`. It now pins the path that
  is still answered at once, which is the path its prefix was measured for, so
  the prefix stays load-bearing for the reasons above. The same bound now also
  catches a server that drains past the limit.
- **A second test beside it writes the whole body**, a little over 1 MiB, with
  no `Content-Type` and `Connection: close`, and requires the `415`. That is the
  case this entry first measured, now expected to pass. It writes in 16 KiB
  pieces, because the pre-fix server lost the answer more often the longer the
  write was stretched out, as the probe above found.

Measured on `fix/drain-refused-create-body`, cut from `a92c65c`, Node v24.19.0,
the local development PostgreSQL, one fresh process per run, no retries, from
`apps/backend`:

```sh
node --env-file-if-exists=../../.env --test --test-timeout=120000 --test-force-exit \
  --test-name-pattern='delivers the 415 to a client that writes an oversized body in full' \
  src/modules/sessions/sessions.test.ts
```

Against the server before the fix — the new test present, the server code
unchanged — the first two rows are the same test before its piece size was
settled:

| Body written as | Runs | Failures | Rate (Wilson 95%) |
| --- | --- | --- | --- |
| one write | 40 | 2 | 5.0% (1.4%–16.5%) |
| 64 KiB pieces | 20 | 8 | 40% (21.9%–61.3%) |
| 16 KiB pieces, the test as committed | 40 | 38 | 95% (83.5%–98.6%) |

After the fix, with the same command, the committed test failed 0 of 40 runs,
0% (0%–8.8%). The F-01 test, selected by its own name the same way, failed 0 of
40 at its new length, and the whole file, run without a name pattern, failed 0
of 20.

A third test was added after review: an HTTP/1.0 variant of the second. It
sends the same body in the same pieces, with an HTTP/1.0 request line and no
`Connection` header, because that is Node's other reason to end the connection.
Measured the same way, with `--test-name-pattern='delivers the 415 to an
HTTP/1.0 client'`, it failed 39 of 40 runs, 97.5% (87.1%–99.6%), with the
create route's code as it stood at `a92c65c`, and 0 of 20, 0% (0%–16.1%), with
the fix.

## F-02 — the frontend suite under `--test-force-exit` reports fewer tests, exit 0

- **Test**: no single test. What is lost is the tail of one frontend test
  file's report: the tests of its last `describe` blocks, or of part of them,
  are absent from the summary, and no test fails. It was seen in
  `apps/frontend/src/lib/detail-view.test.ts`,
  `apps/frontend/src/lib/requests.test.ts` and
  `apps/frontend/src/lib/json-format.test.ts`, and any file's tail can go.
- **Status**: fixed in the procedure by issue #57. The frontend suite runs
  without `--test-force-exit`; the backend keeps it (D132, amendment
  2026-09-26). Nothing in either suite was changed. The backend lost tails the
  same way, and since issue #160 runs without the flag too, with an exit guard
  of its own: F-14 (D132, amendment 2026-10-20).

### Before the fix

On 2026-09-25, reported on issue #57, agents on several branches ran the root
`npm test -- -- --test-timeout=120000 --test-force-exit`. With the flag the
frontend reported 434 to 471 tests where the suite held 471, and 471 to 504
where it held 504, every run exit 0; without it, the full count every time.
Four flagged runs on `main` on a quiet machine all gave 471.

Measured again on the operator's Mac, Node v24.19.0, 8 CPUs, from the
repository root, one fresh process per run, no retries. The frontend suite
held 826 tests: the count it reported without flags, and the same at both
commits, whose `apps/` do not differ. The developer's runs were made at
`3bdfad9` while two other agents ran their own suites beside them, with the
load not recorded; the tester's at `56d909c`, with a 1-minute load average of
16.6–23.1.

```sh
npm test -w @qa-tools/frontend -- --test-timeout=120000 --test-force-exit
```

| Runs by | Commit | Runs | Short runs | Rate (Wilson 95%) | Counts of the short runs |
| --- | --- | --- | --- | --- | --- |
| developer | `3bdfad9` | 10 | 4 | 40% (16.8%–68.7%) | 819, 804, 798, 825 |
| tester | `56d909c` | 8 | 2 | 25% (7.1%–59.1%) | 808, 807 |

Every run exited 0 and reported `fail 0`. Each short run lost tests at the
end of one file only; a count of lost tests below is 826 less the summary's
`tests` line, which counts tests and not `describe` blocks, and a lost
`describe` shows separately as a lower `suites` line.

- The developer's runs 7 to 10 were the short ones. Run 7 lost 7 tests, its
  report stopping inside the last two `describe` blocks of `requests.test.ts`.
  Runs 8, 9 and 10 lost 22, 28 and 1 tests, stopping inside the last one or
  two of `detail-view.test.ts`, `how every block wraps` and
  `the hanging indent of re-indented JSON`.
- The tester's runs went 826 five times, then 808, 807 and 826. The 808 lost
  18 tests, the whole last `describe` of `detail-view.test.ts`, and `suites`
  fell from 150 to 149. The 807 lost 19 tests, the whole last two `describe`
  blocks of `json-format.test.ts`, and `suites` fell to 148.

### The mechanism

`node --test` runs each file in a child process and copies its own options onto
the child's command line: a test printing `process.execArgv` under
`--test-force-exit` found the flag there. A child with it exits once the tests
its root knows of are done, which under load can come before the rest of the
file's report has reached the parent; the parent counts what arrived and ends
with exit 0. A CPU-burning file beside the suite reproduced it, 793 of 804
reported (MR !82). Where exactly the rest is lost was not traced.

### After the fix

Both commands of the prescribed form, run in turn as one round, on the same
Mac and the same way. The developer's three rounds were made at `3bdfad9`
beside the other agents' suites, against a disposable PostgreSQL for the
backend; the tester's ten consecutive rounds at `56d909c`, with a 1-minute load
average of 6.9–11.8.

| Suite | Command | Runs by | Runs | Short runs | Rate (Wilson 95%) | Count |
| --- | --- | --- | --- | --- | --- | --- |
| Backend | `npm test -w @qa-tools/backend -- --test-timeout=120000 --test-force-exit` | developer | 3 | 0 | 0% (0%–56.2%) | 437 of 437 |
| Backend | the same | tester | 10 | 0 | 0% (0%–27.8%) | 437 of 437 |
| Frontend | `npm test -w @qa-tools/frontend -- --test-timeout=120000` | developer | 3 | 0 | 0% (0%–56.2%) | 826 of 826 |
| Frontend | the same | tester | 10 | 0 | 0% (0%–27.8%) | 826 of 826 |

Every run exited 0. The backend without flags reported 437 as well. The
tester's two sets ran at different loads, the flagged runs at roughly twice
the load of the rounds after the fix, so they are not a like-for-like
comparison: the rounds after the fix show the full count every time, at a
lower load than the one at which the tester's flagged runs lost tests.

## F-03 — `A Delete all missed while disconnected empties the list on reconnection`

- **Test**: `e2e/delete-all.spec.ts:416` when it failed and when measured,
  `:417` after the fix below. It is E2E-03's third test (issue #39).
- **Status**: fixed in the test on `fix/e2e-reconnect-discarded-socket`
  (issue #65). The application was not changed and was not at fault: the frame
  the test miscounted comes from the dev server's double mount, which
  production does not have.

### The failure

The `main` pipeline 2885196804 for `a460378`, the #59 merge, failed in `e2e`,
job 16753517316, so the build and the deploy were skipped. The job reported
1 failed and 8 passed. Its failure report as it appeared, down to the source
excerpt; the stack line and the attachments that follow are left out:

```text
  1) [chromium] › e2e/delete-all.spec.ts:416:1 › A Delete all missed while disconnected empties the list on reconnection

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 2

    Call Log:
    - Timeout 10000ms exceeded while waiting on the predicate

      471 |   }
      472 |
    > 473 |   await expect.poll(readyFrames).toBe(1);
          |                                  ^
      474 |
      475 |   await page.evaluate(() => {
      476 |     (window as unknown as { __notReloaded?: boolean }).__notReloaded = true;
```

That is the first of the test's two `readyFrames` expectations, before the
socket is cut. A retry of the job on the same SHA, 16753535620, passed 9 of 9,
and the pipeline deployed. The merged tree was identical to the MR head
`844a3d7`, which had passed `e2e`, and the eleven `main` pipelines before this
one were green.

### The mechanism

1. The suite serves the frontend from the Vite dev server, where `<StrictMode>`
   in `apps/frontend/src/main.tsx` runs `SessionPage`'s socket effect twice.
   The first run's socket is opened and closed in one task, then the page opens
   the socket it keeps. In production the effect runs once. This is the trap
   described in `docs/testing/browser-smoke.md`, met through a socket rather
   than a request.
2. Unrouted, the browser drops that first socket during its handshake. This
   test routes the socket with `page.routeWebSocket`, and in Playwright 1.63 the
   page then holds a mock: the real connection is made only when the route
   handler calls `connectToServer()`, and the page's `close()` reaches the
   handler as a `closePage` message, which Playwright by default forwards to
   close the real connection. The handler has asked for the real connection by
   then, so the close follows it, one more round trip later.
3. When that round trip is slower than the handshake through the Vite proxy
   plus the backend's session lookup, the discarded connection gets its own
   `ready`. The handler's `server.onMessage` pushed every text frame into
   `frames`, so `readyFrames()` read 2. The page never saw that frame, because
   its side of the socket was already closed.
4. No other test is exposed: this is the only one that routes the socket.
   `collectRealtimeFrames` in `e2e/helpers.ts` listens without routing, and
   there the browser drops the first socket before any frame arrives.

### The evidence

- **The CI logs.** A socket dropped during its handshake makes the Vite proxy
  print a pair, `ws proxy error: Error: read ECONNRESET` and
  `ws proxy socket error: Error: read ECONNRESET`. The passing retry printed the
  pair at 11:11:56.05, inside this test (11:11:55.40–11:11:58.16). The failed
  job printed none in the test's 10.6 s (11:08:26.02–11:08:36.74); its next
  pair, at 11:08:42.53, belongs to the following test. A pair means the first
  socket never finished its handshake, which rules the race out. Its absence
  does not prove the race: locally the pair was missing from most passing runs
  too (below). The logs agree with the mechanism, and the forced reproduction
  below shows it.
- **A forced reproduction**, not committed. The handler delayed forwarding a
  page-initiated close by 2 s:
  `ws.onClose((code, reason) => { setTimeout(() => void server.close({ code, reason }), 2000); })`.
  With the counting as it was, the test failed where CI failed, 1 of 1. The
  line is 476 because the delay's three lines sit above it. The report as it
  appeared, cut in the same place as the one above:

  ```text
    1) [chromium] › e2e/delete-all.spec.ts:416:1 › A Delete all missed while disconnected empties the list on reconnection

      Error: expect(received).toBe(expected) // Object.is equality

      Expected: 1
      Received: 2

      Call Log:
      - Timeout 10000ms exceeded while waiting on the predicate

        474 |   }
        475 |
      > 476 |   await expect.poll(readyFrames).toBe(1);
            |                                  ^
        477 |
        478 |   await page.evaluate(() => {
        479 |     (window as unknown as { __notReloaded?: boolean }).__notReloaded = true;
  ```

  With the fix and the same delay it passed, 1 of 1. Logging what the fix
  dropped in that run showed the discarded connection's `ready`, and then
  `requests.cleared`, `request.received` and `response.recorded`: held open for
  2 s, it outlived the cut, so without the fix it would also have broken the
  test's check that no `requests.cleared` arrived while the socket was down.
- **A probe**, not committed. The same logging in the fixed test with no delay
  reported the discarded connection's `ready` in 2 of the developer's 80 runs,
  runs 5 of 20 and 43 of 60, and in none of the tester's 200 (below). The test
  passed in both of those runs; before the fix they would have read 2 and
  failed. Neither of them printed the Vite pair.

### The measurement

Two sets, made independently by the developer and by the tester, both with
Node v24.19.0 and Playwright 1.63.0 on the operator's Mac, 8 CPUs, each against
a disposable PostgreSQL of its own, set up as `docs/testing/browser-smoke.md`
describes. One Playwright process per command, one worker and no retries, as
configured.

- **The developer's**, in the task's worktree on `6957869` with the fix not yet
  committed (the fixed test as later committed in `3ef5c78`), at a 1-minute
  load average of 5.5–8.8 from other agents' work, with PostgreSQL on port 5465
  and the suite moved to ports 3165 and 5265. The forced reproduction ran at
  `:416` both ways, before the test's comment grew by a line.
- **The tester's**, at a 1-minute load average of 4.3–8.8, in a copy of
  `3ef5c78` taken with `git archive 3ef5c78 | tar -x` and `npm ci`. The probe
  ran there on the fixed test, `:417`, with a log line added to the
  `if (closed)` branch, in two processes of 80 and 120 runs. The test before the
  fix ran in the same copy with `e2e/delete-all.spec.ts` replaced by its
  `6957869` version, `:416 --repeat-each=60`.

The developer's commands:

```sh
export E2E_DATABASE_URL='postgres://qa_tools:qa_tools@127.0.0.1:5465/qa_tools_e2e'
export E2E_BACKEND_PORT=3165 E2E_FRONTEND_PORT=5265
npm run test:e2e:migrate
npx playwright test e2e/delete-all.spec.ts:416                    # the forced reproduction, each way
npx playwright test e2e/delete-all.spec.ts:416 --repeat-each=60   # before the fix
npx playwright test e2e/delete-all.spec.ts:417 --repeat-each=20   # after it, with the probe or as committed
npx playwright test e2e/delete-all.spec.ts:417 --repeat-each=60   # after it, with the probe
```

| By | Test | Runs | Failures | Rate (Wilson 95%) | Discarded `ready` | Runs with the Vite pair |
| --- | --- | --- | --- | --- | --- | --- |
| developer | before the fix | 60, one process | 0 | 0% (0%–6.0%) | not visible | 17 |
| developer | after the fix, with the probe | 80, processes of 20 and 60 | 0 | 0% (0%–4.6%) | 2 | 21 (6 + 15) |
| developer | after the fix, as committed | 40, processes of 20 and 20 | 0 | 0% (0%–8.8%) | not visible | 7 (4 + 3) |
| tester | before the fix | 60, one process | 0 | 0% (0%–6.0%) | not visible | 16 |
| tester | after the fix, with the probe | 200, processes of 80 and 120 | 0 | 0% (0%–1.9%) | 0 | 46 (23 + 23) |

The race is what the probe counts: the discarded connection's `ready` reached
the handler in 2 of the developer's 80 runs and in none of the tester's 200.
Pooled over all 280 probe runs that is 2, 0.7% (0.2%–2.6%). Neither set on its
own gives the rate, and the pooled figure describes only this machine at these
loads: how often the discarded connection wins the race varies with the load
and the machine. The two sets ran at different loads, and CI runs on
another machine altogether. The tests before the fix, 120 of 120 passed
between the two sets, 0% (0%–3.1%), agree with a rate this low. The mechanism
does not rest on this count; it rests on the forced reproduction and the CI
logs above.

The developer's committed row ran its first process before the probe and its
second after it. The full suite, `npm run test:e2e`, ran once after the second
and passed 9 of 9.

### The fix

In the test only. The route handler sets `ws.onClose`: when a connection's page
side closes, the handler marks it closed and forwards the close to the server
itself, since setting `onClose` turns Playwright's own forwarding off.
`server.onMessage` neither counts nor forwards a frame of a closed connection.
The cut, the refused reconnections and both expectations, 1 and then 2, are
unchanged.

This does not depend on timing. The page closes the discarded socket in the task
that opened it, before the handler has asked for the real connection, so the
close comes before every server frame of that connection in the page's messages
to Playwright, and those are delivered in order. That holds only while the
handler sets `onClose` before it yields. An `await` placed ahead of it would
let the close arrive first and take Playwright's default forwarding. `closed`
would turn on too late: only when the page's mock reports the close a second
time, once the real socket has closed, after the frames it should have dropped.
The miscount would come back with nothing to show it.

The flag also turns on for the kept connection when its close comes back after
the cut, and for the last connection when the page closes at the end of the
test. Neither has frames left to count by then.

## F-04 — `answers made-up Accept values of 1048576 characters within 100 ms`

- **Test**: `apps/backend/src/modules/mcp/protocol.test.ts:460` at `7018965`,
  `:459` after the fix; the same `withinBound` rule holds every check of
  made-up input in that file and in `captured.test.ts` (200 ms). That file's
  bound was one, 100 ms, then 1000 ms since #363; since #377 each check has
  the bound of its kind: 1000 ms for the made-up bodies, 500 ms for `Accept`
  values of one character, or one parameter, repeated, 200 ms for `Accept`
  lists of whole media ranges and 50 ms for the rest (F-24, After #377).
  Branch `feat/mcp-server` (issue #116, D203); never on `main`.
- **Status**: fixed in the tests, before review.

### The failure

The eight MCP test files together, `npm test -w @qa-tools/backend --
'src/modules/mcp/*.test.ts'`, on the round-3 tree before it was committed,
while `mcp-memory.test.ts` still left V8's bytecode flushing on: 2 failed of 4
runs, 50% (15.0%–85.0%), each on one `acceptsJson` call of a 1 MiB value:

```text
AssertionError [ERR_ASSERTION]: took 107.9 ms
AssertionError [ERR_ASSERTION]: took 121.4 ms
```

The eight files without the memory test passed 3 of 3, and the full suite 5 of
5. With that test turning bytecode flushing off, as committed in `7018965`, the
eight files passed the check in 20 of 20 runs, 0% (0%–16.1%).

### The mechanism

A wall-clock bound on one run. The slowest checks — `parseMessage` and
`acceptsJson` on 1 MiB of made-up input — take 20 to 30 ms alone on the
developer's machine, and the test runner runs files at once, locally and in CI.
Under the memory test, which parses 160 MB of adversarial JSON and collects
garbage dozens of times, one call took 33 to 86 ms at worst in three probe runs
and over 100 ms in the two above: a run stopped by the scheduler or a
collection, not a check that grew worse than linear.

### The fix

`apps/backend/src/testing/timing.ts`, `withinBound`: a run over the bound is
run again, up to five runs, and the fastest is held to the same bound. A stall
stops one run, not five; a check worse than linear is over the bound on every
run, and at 1 MiB a quadratic one by seconds. `testing/timing.test.ts` holds
the rule on a made-up clock. After the fix the eight files passed 30 of 30
runs, 0% (0%–11.4%), and the full suite 3 of 3. The old `timed` could not be made to fail again at `7018965` for a
before-and-after count: it passed 10 of 10 beside the memory test and 6 of 6
beside eight busy-looping processes.

## F-05 — `a pending wait_for_request (D203)`, its warm-up

- **Test**: `apps/backend/src/modules/mcp/mcp-memory.test.ts:409` at
  `7018965`, the warm-up's check that a clear answered every wait `[]`. The
  ten measured cases make the same check after the same steps. Branch
  `feat/mcp-server` (issue #116, D203); never on `main`.
- **Status**: fixed in the test, before review.

### The failure

The eight MCP test files together, as in F-04, at `7018965`: 1 failed of 20
runs, 5% (0.9%–23.6%). The `before` hook failed, so the file's ten cases were
cancelled:

```text
actual: undefined,
expected: [],
operator: 'deepStrictEqual',
```

The assertion did not print the answer; its `structuredContent` had no list,
so it was a tool error.

### The mechanism

A wait is counted pending once it has subscribed, before its first read has
run. Sixteen waits share the pool's ten connections, so six first reads queue.
The test cleared the session as soon as all sixteen were counted, and a clear
that commits while a first read is still queued or running leaves that read no
request for its `after` to name: the wait answers `1003`, as it should, rather
than `[]`.

### The fix

In the test only. It waits, besides, until the pool has no query in flight —
none waiting for a connection and every connection idle — before it measures or
clears, and its assertions print the answer. After the fix the eight files
passed 30 of 30 runs, 0% (0%–11.4%).

## F-06 — `a Docker that does not answer is stopped at the limit, with what it started`

- **Test**: `scripts/db.test.mjs:110` at `7a667f8`, `:145` at `f9e37bc`, the
  fix, and `:152` at `3a48b04`, after #164. The entry also holds two tests of
  the same file: its twin `a hang-up reaches the Docker process group, and the
  script reports it`, `:157` at `7a667f8`, `:217` at `f9e37bc` and `:233` at
  `3a48b04`; and the `never` case of `task-up fails with the reason when
  Docker, the image, the health check or the migrations fail, and gives up at
  its limit` (`:418` at `7a667f8`, `:482` at `f9e37bc`, `:504` at `3a48b04`),
  which gives a container that never becomes healthy 2 s at `7a667f8`
  (`:465`), where it failed in the same measurement, and since the fix 2, 3, 5
  and then 8 s (`:539` at `f9e37bc`, `:566` at `3a48b04`). Issues #120 and
  #164.
- **Status**: fixed in the tests on `fix/db-test-docker-limit-flake`, at
  `f9e37bc`. `scripts/db.mjs` was not changed and was not at fault: in every
  run its group kill stopped the stand-in together with its helper, the
  helper's PID written or not. Since #164, at `3a48b04`, a regression in
  `scripts/db.mjs` no longer fails these tests in a message that blames load
  alone; see **After #164**.

### The failure

On 2026-10-02, correcting !119 at `c3f809b`, which touches neither file, a
developer ran the seven files `delivery-checks` ran then while the frontend
suite and `npm run build` ran on the same Mac: 181 of 182, exit 1, this test
failing with `ENOENT … helper.pid`. Run alone straight after, the seven files
gave 182 of 182 and `scripts/db.test.mjs` 9 of 9 three times, and the CI job
passed on that commit and on its merge. `delivery-checks` has run eleven files
since, and the file holds 16 tests (D216).

### The mechanism

1. `run()` in `scripts/db.mjs` fixes its deadline before it spawns `docker`,
   and at the deadline sends SIGTERM to the whole process group. The test gave
   it 1 s and a `/bin/sh` stand-in that appends its arguments to `calls`,
   starts `sleep 300 &` and writes its PID with
   `echo $! > "$(dirname "$0")/helper.pid"` — a fork and an exec of `dirname`,
   waited for — before `wait`.
2. A shell that has not written the file by the deadline is stopped with its
   group all the same. `run()` returns 124 with both messages, as it should,
   and the test's `readFileSync(… 'helper.pid')` throws ENOENT. Waiting for the
   file cannot help: `run()` resolves once the group is gone, so a file missing
   then never appears.
3. A SIGTERM between the redirection's opening of the file and the write leaves
   it empty. `Number('')` is 0, and `process.kill(0, 0)` asks about the test's
   own process group, which is alive: the test then fails 3 s later with a
   misleading `the process Docker started is still running`.
4. The hang-up test sent SIGHUP 200 ms after `calls` appeared, which the
   stand-in writes before its `trap … HUP` line. A shell that has not set the
   trap by then dies of the hang-up and never writes `signal`: the same race
   with a tighter margin.
5. The `never` case gave `task-up` 2 s from before its first `docker` call, and
   each call is a Node stand-in. While the container is `starting`, the wait
   asks Docker, gives up if one more second would reach the limit, and
   otherwise sleeps a second and asks again. With calls slow enough — at 2 s,
   a quarter of a second each can do it — the limit ends a call before the
   wait gives up, and `task-up` reports
   `docker inspect qa-tools-test-t127 did not finish`: the right exit code,
   not the message the case pins.

What made the shells late in the measurement below was not load as such but
its bursts: this test failed only in runs that started as many processes did —
the opening run of each process of the batch, and two of the second round of
eleven-file runs — and in none of the minutes between them, though the load
average was higher then. `a Docker that ignores the polite stop is killed after
the grace period` shows the same moments: before the fix it ended in about 1 s
instead of about 6 in 7 runs, all 7 of them runs in which this test failed,
because the SIGTERM came before its stand-in's `trap '' TERM`. The test at
`7a667f8` also failed once with ENOENT at a 1-minute load average near 2, in
the mutation runs below. The `never` case's failures were spread over the
batch.

### The forced reproductions

Not committed. Each ran in a copy of `scripts/db.mjs`, `scripts/db.test.mjs`
and `docker-compose.yml` outside the worktree, with the stand-in changed as
below, one fresh process per run:

```sh
node --test --test-name-pattern='<the test>' scripts/db.test.mjs
```

The copies of `7a667f8` ran at a 1-minute load average between 2 and 6, the
copies of the fix as committed between 5 and 24, after the second batch below.
For the helper's PID, a probe in the copies replaced `process.kill` with a
wrapper that printed every call the test file made with a PID of 1 or less.

| Change to the stand-in | Test | At `7a667f8` | With the fix |
| --- | --- | --- | --- |
| `sleep 2` first, the issue's forced reproduction | this one | 10 of 10 failed, ENOENT | 10 of 10 passed: no PID within 1 s or 2 s, a PID within 4 s, that helper found stopped |
| `sleep 9` first | this one | — | 2 of 2 failed: `the machine was too loaded to check: the stand-in wrote no helper's PID within 1, 2, 4, 8 s` |
| the PID written after a `sleep 2` inside the redirection, which leaves the file empty at the limit | this one | 5 of 5 failed: `the process Docker started is still running` | — |
| `0` written for the PID | this one | 1 of 1 failed: `the process Docker started is still running`, after 31 calls of `process.kill(0, 0)` | 1 of 1 failed as too loaded, no `process.kill` with a PID of 1 or less |
| an empty file, `1`, minus the PID, or the PID without its newline | this one | — | 1 of 1 each failed as too loaded, no `process.kill` with a PID of 1 or less |
| `sleep 1` before the trap | hang-up | 5 of 5 failed, ENOENT on `signal` | 5 of 5 passed |
| `sleep 12` before the trap | hang-up | — | 1 of 1 failed: `the stand-in did not set its trap within 10 s` |
| every docker call 0.8 s longer | `never` | 2 of 2 failed, `did not finish` | 3 of 3 passed |
| every docker call 3 s longer | `never` | — | 1 of 1 failed: `the machine was too loaded to check: a docker call outlasted the limit of 2, 3, 5, 8 s` |

### The mutation

In a copy of `scripts/db.mjs` outside the worktree, the group kill
`process.kill(-child.pid, signal)` made `process.kill(child.pid, signal)`, so
that only the stand-in's shell is signalled and its helper outlives it. The
fixed test failed 3 of 3 runs on its own with `the process Docker started is
still running`, its first attempt finding the helper running 3 s after the
limit and killing it, and the whole file failed 1 of 1 with 15 of 16 passing,
this test alone failing. The test at `7a667f8` failed 3 of 3 as well: twice
with `still running`, the first of those runs then held for 300 s by the
helper, which kept the test runner's output open, the second until the helper
was stopped by its PID; and once with ENOENT, the race above.

### The measurement

Two batches of the same script, from the repository root in the task's
worktree, `CI` unset, Node v24.19.0, on the operator's Mac, an Apple M1 Pro
with 8 CPUs and 16 GB, beside other agents' work: #129 merging and deploying
during the first, #132 in development during both. The load was the
measurement itself and eight busy loops, all fourteen processes started at
once by one shell script that recorded each PID and stopped the busy loops by
it at the end:

- eight `node -e 'for(;;){}'`, one per CPU, for the whole batch;
- four processes, each running the eleven-file command below five times in
  turn: 20 runs;
- two processes, each running the whole file fifty times in turn: 100 runs.

One fresh `node --test` per run, no retries, no run repeated. The 1-minute
load average, sampled every 30 s, includes the other agents' work; during the
second batch 7.5 of 8 GB of swap was in use.

| Batch | Commit | Time, 2026-10-10 (UTC+3) | 1-minute load average |
| --- | --- | --- | --- |
| before the fix | `7a667f8` | 14:17–14:57 | 4.8 before; 49 to 264 during, median 144 |
| after the fix | `f9e37bc` | 15:21–16:03 | 2.3 before; 39 to 317 during, median 143 |

```sh
node --test scripts/db.test.mjs
node --test scripts/delivery.test.mjs scripts/delivery-scripts.test.mjs \
  scripts/delivery-queue.test.mjs scripts/delivery-cycle.test.mjs \
  scripts/grooming.test.mjs \
  scripts/db.test.mjs scripts/db-backup.test.mjs \
  scripts/db-backup-notify.test.mjs scripts/db-backup-offsite.test.mjs \
  scripts/monitor.test.mjs scripts/check-api-breaking.test.mjs
```

The eleven files hold 501 tests at both commits. Without `CI`, the 7 cases of
`check-api-breaking.test.mjs` that need oasdiff skip; gpg is installed here, so
the real-gpg case runs. Alone after the second batch, at `f9e37bc`, the eleven
files gave 494 passed, 7 skipped, exit 0, as at `7a667f8` before the first.

Failures of this entry's tests:

| Test | Runs | Before the fix | Rate (Wilson 95%) | After the fix | Rate (Wilson 95%) |
| --- | --- | --- | --- | --- | --- |
| this one | whole file, 100 | 2 | 2.0% (0.6%–7.0%) | 0 | 0% (0%–3.7%) |
| this one | eleven files, 20 | 6 | 30% (14.5%–51.9%) | 0 | 0% (0%–16.1%) |
| **this one** | **both, 120** | **8** | **6.7% (3.4%–12.6%)** | **0** | **0% (0%–3.1%)** |
| `never` case | whole file, 100 | 3 | 3.0% (1.0%–8.5%) | 0 | 0% (0%–3.7%) |
| `never` case | eleven files, 20 | 5 | 25% (11.2%–46.9%) | 0 | 0% (0%–16.1%) |
| **`never` case** | **both, 120** | **8** | **6.7% (3.4%–12.6%)** | **0** | **0% (0%–3.1%)** |
| hang-up | both, 120 | 0 | 0% (0%–3.1%) | 0 | 0% (0%–3.1%) |
| polite stop | both, 120 | 0 | 0% (0%–3.1%) | 0 | 0% (0%–3.1%) |

Within each mode the intervals before and after overlap, so no improvement is
claimed for either mode alone. Over the 120 runs of each batch they do not,
for this test or for the `never` case: 3.4% to 12.6% before, 0% to 3.1% after.
The hang-up test did not fail under this load before the fix, so it has no rate
to improve on; its fix rests on the forced reproduction above.

Every failure of this test before the fix was ENOENT, never the empty file. As
it appeared in an eleven-file run:

```text
test at scripts/db.test.mjs:110:1
✖ a Docker that does not answer is stopped at the limit, with what it started (1003.283542ms)
  Error: ENOENT: no such file or directory, open '/var/folders/n4/g960v9mx1jz26vxns9fwr0t00000gn/T/qa-db-script-TMOVHt/helper.pid'
      at readFileSync (node:fs:484:20)
      at TestContext.<anonymous> (file:///…/scripts/db.test.mjs:127:25)
```

Every failure of the `never` case was the same:

```text
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /gave up after 2 s: qa-tools-test-t127 did not become healthy/. Input:

  'task-up 127 gave up after 2 s: docker inspect qa-tools-test-t127 did not finish.'
```

After the fix the retries were used. The test lasts about the sum of the limits
of the attempts it made, and by that 110 runs were decided by the first
attempt, 4 by the second and 6 by the fourth, at 8 s, the three before it
having found no PID. Those six are the opening runs of the six processes, the
runs in which this test failed before the fix. Three attempts at 1, 2 and 4 s,
the issue's starting point, would have failed them as too loaded to check,
never passed them; against a burst like this one the fourth attempt is the
whole margin.

Other tests failed in the eleven-file runs at this load and are not this
entry's subject: `scripts/monitor.test.mjs:360`, its table of page and lookup
cases, 30 times in 12 runs before the fix and twice in 2 runs after; and
`scripts/delivery-queue.test.mjs:1845`, `of processes waiting on a mutex that
goes stale at once, and holders killed midway, none lets a second writer in`,
once in each batch. So 18 of the 20 eleven-file runs exited 1 before the fix
and 2 after, those two on the other tests alone. That the same recipe gave
`monitor.test.mjs` 30 failures once and 2 the next suggests how far the other
agents' work moved the load between the batches. Since #162 each has an entry
of its own: the monitor's table F-12, the queue test F-11.

### The fix

In `scripts/db.test.mjs` only, `f9e37bc`.

- **This test.** The stand-in writes the PID with
  `echo $! > "${0%/*}/helper.pid"`: the shell's own expansion finds its
  directory, so nothing is started before the write. `recordedPid` takes a PID
  only from a whole line holding an integer above 1; a missing file, an empty
  one, a line without its newline, 0, 1 or a negative number give none.
  `isAlive` asserts that the PID it is asked about is above 1 before it calls
  `process.kill`, and counts `EPERM` as running. Each attempt is a fresh
  stand-in under a limit of 1, 2, 4 and then 8 s, and each is held to code 124,
  the bound of its limit plus 3 s, and both messages. An attempt that found no
  PID is followed by the next; the first that found one decides — its helper
  must be gone within 3 s, else the test kills it, so that it does not hold the
  runner's output open for 300 s, and fails — and when none found one, the test
  fails. Since #164 that failure gives each attempt's time and names both
  readings, the machine too loaded for the stand-in's shell to write the PID
  in time, or `scripts/db.mjs` no longer starting the stand-in as it did; and
  an attempt that gives up more than 100 ms before its limit fails the test at
  once, as `scripts/db.mjs` not waiting for its limit, since load only makes
  an attempt later. At `f9e37bc` the message named load alone. Only the
  precondition is tried again, never the property, as F-04's `withinBound`
  does. The issue's suggestion, writing to a temporary file and renaming it,
  was not taken: the rename is one more process before the PID is there, and
  the whole-line rule already turns away whatever a stopped write leaves.
- **The hang-up test.** The stand-in writes `ready` right after its trap line.
  The test waits for it up to 10 s instead of `calls` plus 200 ms, sends the
  hang-up either way so that the run ends, and fails with
  `the stand-in did not set its trap within 10 s` if it never came. It then
  waits up to 10 s for `signal` to hold `HUP` and its newline, since the file
  exists from the redirection's opening, before the trap has written to it.
- **The `never` case.** An attempt whose log says the limit ended a call —
  `docker inspect` or `docker run qa-tools-test-t127 did not finish` — is made
  again with a fresh stand-in under a longer limit, 2, 3, 5 and then 8 s. Any
  other ending must be the case's own message, every attempt is held to code
  124 and to printing no URL, and when none reaches the wait's own end the test
  fails. Since #164 that failure names both readings, the machine too loaded
  for the calls to be done within the limit, or `task-up` no longer giving up
  before its limit ends a call, with each attempt's number of health asks as
  evidence; at `f9e37bc` it named load alone. The limits are not doubled
  because a longer limit can fall inside a call again: the wait asks once a
  second, so with every call taking the same time the limit ends a call
  whenever it falls within one call of an ask. A model of the wait — two
  calls, then a call and a second's sleep in turn — run over constant call
  times in steps of 10 ms has 2, 3, 5 and 8 s reach the wait's own end for
  every call time below 1.2 s, where 2, 4, 8 and 16 s stop at 0.9 s. With calls
  0.8 s longer the doubled limits failed 3 of 4 runs, before they were changed;
  these passed 3 of 3, as the table above says.

### Watched, and left

`a Docker that ignores the polite stop is killed after the grace period`
(`:132` at `7a667f8`, `:192` at `f9e37bc`, `:208` at `3a48b04`) never failed.
It can pass without exercising the grace period, when the SIGTERM comes before
its stand-in's `trap '' TERM`, and did so in 7 of the 120 runs before the fix,
5.8% (2.9%–11.6%), and 5 of the 120 after, 4.2% (1.8%–9.4%), taking about 1 s
instead of about 6. That is a test that can pass without checking what it
names, not one that fails; issue #120 left it out of scope unless it failed, so
it is recorded here and not changed. Issue #164 left it out of scope too,
although it passes under the first regression of **After #164**, in 5 ms.
Issue #162 fixed it; its entry is F-13.

### After #164

The reviewer and the tester of !155 found that a regression in
`scripts/db.mjs` failed this test and the `never` case in the message meant
for load, `the machine was too loaded to check: …`, which points a night agent
at a re-run instead of the regression. Issue #164 changed
`scripts/db.test.mjs` alone, at `3a48b04`; `scripts/db.mjs` was not changed.

- **This test.** Every attempt is also held to a lower bound, its limit less
  100 ms, timed with `performance.now()` from before `run()` fixes its
  deadline. The timer that stops Docker cannot fire before that deadline but
  for Node's millisecond rounding, and load only makes an attempt later, so an
  attempt that gives up sooner is `scripts/db.mjs` not waiting for its limit:
  it fails the test at once and is not tried again. When no attempt found a
  PID, the failure gives each attempt's time and names both readings.
- **The `never` case.** No check in the test tells load from a `task-up` that
  no longer gives up before its limit ends a call: both end every attempt in
  `did not finish`. Its failure names both, with each attempt's number of
  health asks — the stand-in's `docker inspect` calls whose format reads
  `.State.Health` — as evidence, not a check: under the regression the wait
  asks about once a second until the limit, under load far less often.

Each run below was one fresh process in a copy of `scripts/db.mjs`,
`scripts/db.test.mjs` and `docker-compose.yml` outside the worktree, the test
file of `410a0dc` — the same as `f9e37bc`'s — for before and of `3a48b04` for
after, `scripts/db.mjs` of `410a0dc` with the change named, run by test name,
on 2026-10-10 from 21:17 to 21:32 (UTC+3), at a 1-minute load average between
3.9 and 10.8, beside the other tasks of the delivery cycle:

```sh
node --test --test-name-pattern='<the test>' scripts/db.test.mjs
```

The two regressions the tester of !155 injected:

| Change to `scripts/db.mjs` | Test | Before | After |
| --- | --- | --- | --- |
| `run()`'s deadline in milliseconds, `Date.now() + limit` | this one | 1 of 1 failed in 25 ms, every attempt ending at once | 4 of 4 failed in the first attempt, which gave up after 3, 4, 4 and 3 ms |
| the give-up check `if (Date.now() + POLL_MS >= deadline)` removed from `taskDatabase` | `never` | 1 of 1 failed, the test lasting 24.6 s | 4 of 4 failed, the test lasting 24 to 25 s, each with 2, 3, 5 and 8 health asks |
| that check off by one, `Date.now() >= deadline` | `never` | — | 1 of 1 failed, as the removed check, 2, 3, 5 and 8 health asks |

Before, as they appeared:

```text
AssertionError [ERR_ASSERTION]: the machine was too loaded to check: the stand-in wrote no helper's PID within 1, 2, 4, 8 s
AssertionError [ERR_ASSERTION]: the machine was too loaded to check: a docker call outlasted the limit of 2, 3, 5, 8 s
```

After:

```text
AssertionError [ERR_ASSERTION]: the attempt under a limit of 1 s gave up after 3 ms, before its limit: load only makes an attempt later, so scripts/db.mjs no longer waits for the limit it is given before it stops Docker
AssertionError [ERR_ASSERTION]: no attempt reached the wait's own end: a docker call outlasted the limit of 2, 3, 5, 8 s, the attempts asking for the container's health 2, 3, 5, 8 times. The machine was too loaded for the calls to be done within the limit, or task-up no longer gives up before its limit ends a call; about one ask per second of the limit points to task-up, far fewer to load
```

Under the first regression, the whole file in one run, `node --test
scripts/db.test.mjs`, exited 1 with 7 of its 16 tests reported, 5 passing:
`success is Compose reporting success, for every step` failed too, its 600 ms
reached, with `124 !== 0`, and this test with the message above; the process
then ended in the hang-up test: the run it started returned within its 30 ms,
so the hang-up the test then sends its own process found no handler. Hence
the runs by name.

Load still reads as load, and the mutation still fails, at `3a48b04`, the
stand-ins changed as in the forced reproductions above:

| Change | Test | After |
| --- | --- | --- |
| `sleep 9` first in the stand-in | this one | 3 of 3 failed, the attempts giving up after 1001, 2001, 4003, 8002 ms; 1004, 2002, 4004, 8002 ms; and 1003, 2005, 4004, 8003 ms |
| `sleep 2` first | this one | 4 of 4 passed, a PID within 4 s |
| every docker call 3 s longer, after the stand-in has recorded it | `never` | 2 of 2 failed, each with 0, 0, 0 and 1 health asks |
| every docker call 3 s longer, before it records anything | `never` | 1 of 1 failed, with no health ask |
| every docker call 0.8 s longer | `never` | 4 of 4 passed |
| the group kill made `process.kill(child.pid, signal)`, F-06's mutation | this one | 4 of 4 failed: `the process Docker started is still running` |

```text
AssertionError [ERR_ASSERTION]: the stand-in wrote no helper's PID within 1, 2, 4, 8 s, the attempts giving up after 1001, 2001, 4003, 8002 ms, none before its limit: the machine was too loaded for the stand-in's shell to write it in time, or scripts/db.mjs no longer starts the stand-in as it did
AssertionError [ERR_ASSERTION]: no attempt reached the wait's own end: a docker call outlasted the limit of 2, 3, 5, 8 s, the attempts asking for the container's health 0, 0, 0, 1 times. The machine was too loaded for the calls to be done within the limit, or task-up no longer gives up before its limit ends a call; about one ask per second of the limit points to task-up, far fewer to load
```

On the unchanged `scripts/db.mjs` the file holds 16 tests at `410a0dc` and at
`3a48b04`, and passed 16 of 16 at both.

## F-07 — `counts 100,000 distinct addresses quickly`

- **Test**: `apps/backend/src/modules/limits/rate-limit.test.ts:383` at
  `4e69009`, `:384` after the fix. Issue #161.
- **Status**: fixed in the test on `fix/rate-limit-timing-flake`, at `54f8bcf`.
  `rate-limit.ts` and `testing/timing.ts` were not changed, and the limiter was
  not at fault: the same loop takes about 1.6 s on its own, and the mutation
  below, which makes it quadratic, about a minute.

### The failure

On 2026-10-10 at about 14:05 (UTC+3), re-verifying #129 (!154) at `9b2ea40`,
the tester ran the full backend suite four times while other tasks of the
delivery cycle ran theirs (D216). Run 2 failed on this test, `took over 5 s`
at 7142 ms, while the 1-minute load average climbed from 6.9 to about 19; in
the other three it took 2014 to 2744 ms, two of them at a higher load. 1 failed
of 4, 25% (4.6%–69.9%). The limits module is the same at `9b2ea40`, `7a667f8`
and `4e69009`.

The base run of this entry failed the same way. The full backend suite at
`4e69009`, on 2026-10-10 from 20:06 (UTC+3), the 1-minute load average 12.2
before and 24.3 after, beside the other tasks of the cycle:

```sh
node scripts/db.mjs task-test 161
```

1795 of the 1798 tests it reported passed, exit 1 — the suite holds 1812, see
**Watched, and left** — and this test failed: 1 failed of 1, 100%
(20.7%–100%). As it appeared:

```text
test at src/modules/limits/rate-limit.test.ts:383:3
✖ counts 100,000 distinct addresses quickly (8397.808292ms)
  AssertionError [ERR_ASSERTION]: took over 5 s
      at TestContext.<anonymous> (file:///…/apps/backend/src/modules/limits/rate-limit.test.ts:394:12)
```

The two other failures of that run are not this entry's subject; see
**Watched, and left**.

### The mechanism

One wall-clock run of a synchronous loop of 100,000 calls, held to 5 s. On its
own the loop takes about 1.6 s on the operator's Mac (1531 to 2796 ms, median
1567 ms, in ten runs in one process at a 1-minute load average near 10, the
quietest the machine was during this work), and 2 to 3 s inside the suite,
which runs its files at once. The loop computes the whole time, so it lasts as
long as the share of a core its process gets: a process given a third of one
for a few seconds, while two other tasks' suites, builds and browsers run on
the same eight cores — normal with three tasks in flight (D216) — is over the
bound with nothing wrong in the counter. The counter's cost per call is
constant on average: every window is removed once, from the front of the map
(`#dropEnded`, D201).

### The forced reproductions

Not committed. Each ran in a copy of `4e69009` outside the worktree —
`package.json`, `tsconfig.base.json`, `apps/backend` and `packages/shared`
taken with `git archive`, the worktree's `node_modules` linked in — the fix's
copies holding `rate-limit.test.ts` of `54f8bcf`, each run from the copy's
root:

```sh
npm test -w @qa-tools/backend -- src/modules/limits/rate-limit.test.ts
```

A stall of 6 s inside the timed span,
`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_000)`, a sleep
that holds the thread as a descheduled process is held: at `4e69009` right
after `started`, in the fix at the start of the first call of `run` alone. The
1-minute load average was 19 to 23.

| Copy | Runs | Result |
| --- | --- | --- |
| `4e69009` | 3 | 3 failed, `took over 5 s`, the test at 8717 to 8766 ms |
| the fix | 3 | 3 passed, the test at 11023 to 13458 ms: the stalled run over the bound, a later one under it |

### The mutation

In copies outside the worktree, `#dropEnded` in `rate-limit.ts` with its
`return` made `continue`, so that every call walks the whole map instead of
stopping at the first window still running. The loop then grows with the
square of the addresses: 5,000 took 196 ms, 10,000 574 ms and 20,000 1697 ms in
one process.

- The fix, the whole file as above, 1 run at a 1-minute load average of 17 to
  23: exit 1, 21 of 22 passed, this test failing after 364.6 s with
  `took 56926.1 ms at best in 5 runs, over the 5000 ms bound`. The file took
  544 s; its three other tests of 100,000 addresses took about a minute each
  and passed, holding no time. The test is synchronous, so the suite's
  `--test-timeout=120000` does not cut it.
- `4e69009`, this test alone, 1 run: `took over 5 s` at 53785 ms.

  ```sh
  npm test -w @qa-tools/backend -- --test-name-pattern='counts 100,000' \
    src/modules/limits/rate-limit.test.ts
  ```

### The measurement

Two batches of one shell script, from the copies' roots, `CI` unset, Node
v24.19.0, on the operator's Mac, an Apple M1 Pro with 8 CPUs and 16 GB, beside
the other tasks of the delivery cycle. F-06's load, started at once, every PID
recorded:

- eight `node -e 'for(;;){}'`, one per CPU, for the whole batch, stopped by PID
  at its end;
- runners, each running the file of `4e69009` and the file of the fix in turn,
  alternately, half of them starting with each, so that both meet the same
  load, the other agents' included.

One fresh `node --test` per run, the command above, no retries, no run
repeated. The 1-minute load average, sampled every 30 s, includes the other
agents' work.

| Batch | Runners | Time, 2026-10-10 (UTC+3) | 1-minute load average |
| --- | --- | --- | --- |
| heavy | eight | 20:21–20:24 | 11 before; 27 to 55 during |
| moderate | two | 20:26–20:28 | 15 before; 24 to 59 during |

The heavy batch was set for five pairs per runner. It was stopped once every
run of both copies had failed: the runners were stopped, the runs in flight
left to finish under the busy loops, and then the loops stopped. More runs
could not have changed its answer, and it held the machine of three tasks at a
load of 55. The moderate batch ran its ten pairs per runner.

| Batch | Copy | Runs | This test failed | Rate (Wilson 95%) | The test's time |
| --- | --- | --- | --- | --- | --- |
| heavy | `4e69009` | 12 | 12 | 100% (75.8%–100%) | 12.1 to 21.8 s, one run |
| heavy | the fix | 16 | 16 | 100% (80.6%–100%) | 6.2 to 14.8 s at best of five, 55 to 91 s in all |
| moderate | `4e69009` | 20 | 8 | 40% (21.9%–61.3%) | 3.6 to 8.7 s, median 4.8 s |
| moderate | the fix | 20 | 0 | 0% (0%–16.1%) | 2.8 to 27.8 s, 18 runs passing on the first run of the loop |

Under the moderate load the intervals do not overlap: 21.9% to 61.3% before,
0% to 16.1% after. Under the heavy one no run of the loop came under 5 s — each
took four to fourteen times its 1.6 s alone — and both copies failed every
time: `withinBound` absorbs a stall, not a load that slows every run past the
bound, and then fails with its own message, after up to a minute and a half.
That load is beyond what the failure above saw, 7142 ms in one run of four with
the other three under 3 s. Every failure was this test alone; the file's other
21 tests passed in all 68 runs.

### The fix

In `rate-limit.test.ts` only, `54f8bcf`. The check goes through
`withinBound(5_000, run)` (`testing/timing.ts`, F-04): a run over the bound is
run again, up to five runs, and the fastest is held to the same bound. Each
run builds a fresh `WindowCounter(API_CALL_LIMIT)`, makes the same 100,000
`addressKey(...)` hits, closes the counter in a `finally` and answers its size,
which the test holds to 100,000. The bound, the count, the name and the loop
are unchanged, so the times here compare with the issue's. A test that passes
on its first run costs that run; one that needs more costs each of them, 27.8 s
at most in the moderate batch; the mutation above fails after about six
minutes. A ratio of the times of 10,000 and 100,000 addresses was weighed and
not taken: load skews both runs, JIT warm-up the small one, and it would be a
second timing pattern beside F-04's.

### Watched, and left

- `answers hostile values of 1 KiB, 64 KiB and 1 MiB within 100 ms, as
  unreadable` (`:453` at `4e69009`, `:464` after), in the same file, holds each
  of its 27 checks to one wall-clock run of 100 ms (`:472`, `:483` after). It
  passed in all 79 runs of the file logged for this entry, the 68 above
  included, at up to 2.0 s for all 27; issue #161 left it out of scope. Taking
  `withinBound(100, …)` as `capture-budget.test.ts` does would be the same
  change.
- The base suite run above failed two other tests with a single-run bound:
  `src/modules/mcp/mcp.test.ts:888`, `answers within 500 ms of a capture, not
  at the end of its 10 s wait, as list_requests lists it`, with
  `answered 533.0 ms after the capture`; and
  `src/modules/requests/request-wait.test.ts:900`, `with 200 waits at once, on
  one session and across sessions`, with `answered after 5089 ms`. The frontend
  suite at `4e69009`, `npm test -w @qa-tools/frontend`, run straight after,
  failed `src/lib/session-list.test.ts:433`, `reads 5242880 characters of
  nesting, garbage or an unclosed value as nothing`, with
  `1682.7 ms for 5242896 characters`. The first full backend run with the fix,
  at a 1-minute load average rising from 7 to 31, failed three others:
  `src/modules/limits/rate-limit-routes.test.ts:607`, `captures more than 1200
  webhooks a minute from one address, every one answered and stored`, cut by
  the 120 s timeout; `src/modules/requests/request-list.test.ts:2009`,
  `answers 503 / 1011, and the same query succeeds where it is given its 2 s`,
  answered `503` / `1011` where it expected `200`; and
  `src/modules/webhook/capture-admission.test.ts:1262`, `holds an address to
  its 16 MiB with small GETs whose delayed answers are at their bound, each
  holding no more than it was admitted for`, with 12 of 243 answers `503`. Each
  of these five passed in the other three full runs. None is this entry's
  subject or was changed: #161 left the other files' timing out of scope, and
  the calls-in-flight flake is #169, F-10.
- The full backend suite holds 1812 tests at both commits, the one file changed
  holding 22 at both, but its report lost the tail of
  `src/modules/requests/list-query.test.ts` — all or part of its last
  `describe`, `hostile input at growing sizes` — in 3 of the 4 full runs made
  for this entry with `node scripts/db.mjs task-test 161`: 1798 reported in the
  base run above, exit 1; 1812 in the first run with the fix, exit 1 on the
  three tests above; 1806 in the second, exit 0; and 1788 at `4e69009` again,
  `rate-limit.test.ts` put back for the run, exit 0. This is F-02's loss under
  `--test-force-exit`, which the backend keeps (D132, amendment 2026-09-26),
  seen in the backend: a count read from one run under load is not the suite's
  count. Whether a failure in a lost tail would still fail the run was not
  checked. Issue #160 answered it and dropped the flag from the backend: see
  F-14.

## F-08 — `names the step in request.received and response.recorded, and none for the session response`

- **Test**: `apps/backend/src/modules/realtime/realtime.test.ts:1063` at
  `1cece40`, `:1066` after the fix. Branch `feat/realtime-outbox` (issue #132,
  D221); never on `main`.
- **Status**: fixed in the test, in correction round 3 of MR A.

### The failure

CI's `test` job on the MR pipelines of the branch: 1 failed of 3 runs, 33%
(6.1%–79.2%), at `1cece40` (pipeline 2933844530, job 17082828894); it passed
at `433d503` and `d0c38cb`.

```text
✖ names the step in request.received and response.recorded, and none for the session response (39.498151ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    [
  +   null,
      { index: 1, total: 1 },
  -   null
    ]
```

Run alone on the developer's machine, `npm test -w @qa-tools/backend --
--test-name-pattern='names the step in request.received' <the file at
1cece40>`: 20 passed of 20, 0% (0%–16.1%).

### The mechanism

The test captures twice and read the two `response.recorded` events in the
order they arrived. A completion is written after its reply has ended, in a
transaction of its own that takes no lock of the session, so the first
capture's can draw its outbox id after the second capture's, or after the
second's completion: D221 point 6 orders a `response.recorded` after its own
capture only. The outbox delivers in id order, so the two arrived the other way
round. Forced: the first completion of the process held 300 ms before it began,
the test at `1cece40` failed with the output above in 1 of 1 run.

### The fix

In the test only: each event is matched to its request by the id its capture
answered, not by its place. Under the same forced delay the fixed test passed 1
of 1. No other test of the backend asserts an order between two requests'
events where one is a `response.recorded` or a `request.deleted` without
waiting for the completion first (the audit in correction round 3 of MR A).
After the fix it passed in 5 of 5 runs of its file and in each full suite run
of that round.

## F-09 — `answers 503, 503 after its delay with the request stored first, then the custom 200`

- **Test**: `apps/backend/src/modules/sessions/session-queue.test.ts:268` at
  `de14d7f`, `:273` after the fix, which is in its helper `awaitPendingRecord`
  (`:248` then) and one argument of its call. Branch `feat/realtime-outbox`
  (issue #132, D221).
- **Status**: fixed in the test, in correction round 3 of MR A.

### The failure

`node scripts/db.mjs task-test day-dev132r3`, the backend suite on a task
database of the developer's own: 1 failed of the round's 7 full runs, the last
three at `de14d7f` and the first four on the same code before its commit. The
failing run began at a load average of 5.6, which other work took to 22.

```text
✖ answers 503, 503 after its delay with the request stored first, then the custom 200 (1516.639583ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    {
      queueStep: {
  +     index: 1,
  -     index: 2,
        total: 2
      },
  +   state: 'sent',
  -   state: 'pending',
      status: 503
    }
```

### The mechanism

The test sends a second webhook right after the first one's answer and waits
for "the one request of the session whose response is still pending", the
second, inside its delay. A completion is written after its reply has ended
(D109), so the first request's record can still be pending then, and the
helper took it; by the time the list was read it was `sent`, step 1. Since
#132 the completion is a transaction of four statements rather than one
(D221 point 3), which widens the window. Forced, as in F-08: the first
completion of the process held 300 ms, the test at `de14d7f` failed in 1 of 1
run.

### The fix

`awaitPendingRecord` leaves out the requests it is told to, and the test names
the first one. Under the same forced delay the fixed test passed 1 of 1. The
helper of the same name in `session-response.test.ts` is used on a session's
first capture only.

## F-10 — `ends 140 refusals with stalled bodies after 128 calls held, kept alive: the connections are back at 128 within a second`

- **Test**: `apps/backend/src/modules/limits/calls-in-flight-routes.test.ts:1595`
  at `c300ccc` and at `bd9358c`, `:1602` on main at `edabc00`. Its check of the
  refused connections was
  `assert.ok(refused.every((connection) => connection.ended()))` at `:1650` at
  `c300ccc`; on main it is part of the count's loop, `:1649`–`:1660`. The test
  came with #139 and was last changed in `9e30099` until #132's `03593c5`.
  Issue #169; F-07 named it in passing.
- **Status**: fixed in the test on main by #132's `03593c5` (D221), merged in
  `d4187f4`, after this test failed on #132's MR pipeline 2933558703, as that
  commit's message records; its output is not copied here. This task's own
  wait, `bd9358c` on `fix/calls-in-flight-ended-wait`, was dropped
  when that branch merged main at `edabc00`; the forced reproductions, the
  mutation and the measurement below were made with it (see The fix). The
  calls-in-flight limit and `rate-limit.ts` were not changed by this task, and
  the server was not at fault: its count back at 128 shows every refused
  connection closed on its side, and the mutation below still fails the test.

### The failure

On 2026-10-10 the tester of !155 (#120), re-verifying at `6d64a30`, whose
`apps/` equals main at `5bd1d81`, ran the full backend suite three times at a
1-minute load average of about 6 to 13, beside the other tasks of the delivery
cycle:

```sh
node scripts/db.mjs task-test 120
```

The first run reported 1812 tests, 1811 passing, exit 1, this test failing; the
next two passed, and the file alone passed 5 of 5, 20 of 20 tests each, at a
load of about 11 to 12. As it appeared:

```text
test at src/modules/limits/calls-in-flight-routes.test.ts:1595:3
✖ ends 140 refusals with stalled bodies after 128 calls held, kept alive: the connections are back at 128 within a second (152.323209ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:

    assert.ok(refused.every((connection) => connection.ended()))

      at TestContext.<anonymous> (file:///…/apps/backend/src/modules/limits/calls-in-flight-routes.test.ts:1650:12)
```

The same day in CI: MR pipeline 2933986908 of !158 (#161), job `test`
17083557870 at `b9b1e35`, which changes tests and docs only, on `node:24-slim`.
The backend suite reported 1737 tests, 1736 passing, this one failing; the MR
pipeline was run again with `c4dc600`. As it appeared:

```text
test at src/modules/limits/calls-in-flight-routes.test.ts:1595:3
✖ ends 140 refusals with stalled bodies after 128 calls held, kept alive: the connections are back at 128 within a second (183.784463ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:

    assert.ok(refused.every((connection) => connection.ended()))

      at TestContext.<anonymous> (file:///…/apps/backend/src/modules/limits/calls-in-flight-routes.test.ts:1650:12)
```

The test, `calls-in-flight.ts` and `rate-limit.ts` are the same at `5bd1d81`,
`b9b1e35` and `c300ccc`.

### The mechanism

1. The test holds 128 waits, then sends 140 calls in waves of 20, alternating
   `PUT /api/sessions/:id/response` and `POST /mcp`, each declaring 200,000
   bytes and sending 16. Each is refused `429` / `1019` with
   `Connection: close`, which `rate-limit.ts:575` at `c300ccc`, `:576` on
   main, sets on an answer written while its body is still arriving, and the
   server ends and destroys its side of the connection;
   `app.server.getConnections()` drops as it does.
2. At `c300ccc`, the loop at `:1638`–`:1648` reads that count until it is
   back at 128, resuming from `delay(10)` between reads, and `:1650` then read
   every refused connection's `ended()` at once.
3. `ended()` is the test's own side of the connection: a flag set by the
   client socket's `end` or `close` handler in `connect()` (`:1300` and `:1303`
   at `c300ccc`, `:1307` and `:1310` on main).
   Both sides are sockets of the one process. The count drops when the server
   destroys its socket; the client socket reads the end in a poll phase of the
   event loop, and the loop resumes from its timer in the timers phase, which
   comes first in a turn. A count read after the server has destroyed the last
   sockets can be 128 before their client sockets have read their ends. The
   order of Node's phases here is inferred, as in the issue, not traced.
4. Under load the process is held off the CPU between turns, the 10 ms timer
   is due when it comes back, and the window is met more often: the failure
   was seen in whole-suite runs and in CI, and below in runs at a load near 30.

### The forced reproductions

Not committed. Each ran in a copy of `c300ccc` outside the worktree —
`package.json`, `package-lock.json`, `tsconfig.base.json`, `apps/backend`,
`packages/shared`, `scripts/db.mjs` and `docker-compose.yml` taken with
`git archive`, the worktree's `node_modules` and `apps/backend/node_modules`
linked in — the copies of this task's fix holding
`calls-in-flight-routes.test.ts` of `bd9358c`, which `9106e78` kept unchanged.
None ran main's loop of `03593c5`. Each run was one fresh process from the copy's root, against the
task's own test database (D216):

```sh
node scripts/db.mjs task-test 169 -- --test-name-pattern='ends 140 refusals' \
  src/modules/limits/calls-in-flight-routes.test.ts
```

In `connect()`, the `end` and `close` handlers set the flag in a `setTimeout`
of 30 or 50 ms instead of at once: a client side that reads its end a little
after the server's count has dropped. The four lines this adds put `c300ccc`'s
check at `:1654`. On 2026-10-10 from 22:42 to 22:44 (UTC+3), at a 1-minute load
average of 5.7 to 9.1:

| Change in `connect()` | Copy | Runs | Result |
| --- | --- | --- | --- |
| the flag set 30 ms after `end` or `close` | `c300ccc` | 10 | 10 failed at `:1654`, `The expression evaluated to a falsy value` |
| the flag set 30 ms after | `bd9358c` | 10 | 10 passed |
| the flag set 50 ms after | `c300ccc` | 5 | 5 failed at `:1654` |
| the flag set 50 ms after | `bd9358c` | 5 | 5 passed |
| the flag never set | `bd9358c` | 2 | 2 failed, the test in 1.23 s, as below |

```text
AssertionError [ERR_ASSERTION]: refusal 0: the server kept the connection open
```

### The mutation

In copies of `c300ccc` and of `bd9358c`, `reply.header('connection', 'close')`
removed from `rate-limit.ts` (`:575`), so that a refusal written while its body
is still arriving keeps its connection alive. Run as above, alternately, at
22:43 and 22:44 at a 1-minute load average of 8.3 to 9.1, both failed 3 of 3,
the test in 1.21 to 1.23 s, on the count's own 1 s bound and not on the suite's
120 s timeout, with the 268 connections D213 point 5 measured without the rule:

```text
AssertionError [ERR_ASSERTION]: 268 connections open a second after the refusals, not the 128 waits'
```

### The measurement

One batch of one shell script, from the roots of the copies above without the
change to `connect()`, `CI` unset, Node
v24.19.0, on the operator's Mac, an Apple M1 Pro with 8 CPUs and 16 GB, beside
the other tasks of the delivery cycle. Started at once, every PID recorded:

- four `node -e 'for(;;){}'`, one per two CPUs, for the whole batch, stopped by
  PID at its end;
- two runners, each running the copy of `c300ccc` and the copy of `bd9358c`
  in turn, alternately, one starting with each, 100 pairs each.

One fresh `node --test` per run, the command above, no retries, no run
repeated. The 1-minute load average, sampled every 30 s, includes the other
agents' work.

| Batch | Time, 2026-10-10 (UTC+3) | 1-minute load average |
| --- | --- | --- |
| moderate | 22:45–22:49 | 7.3 before; 17.7 to 41.3 during |

| Copy | Runs | This test failed | Rate (Wilson 95%) | The test's time |
| --- | --- | --- | --- | --- |
| `c300ccc` | 200 | 2 | 1.0% (0.3%–3.6%) | 248 to 1064 ms, median 339 ms |
| `bd9358c` | 200 | 0 | 0% (0%–1.9%) | 274 to 1057 ms, median 345 ms |

Both failures came at `c300ccc`'s `:1650`, as in the issue, in two runs of one
runner three seconds apart, at 22:46:56 and 22:46:59, at a load near 30. The
intervals overlap, 0.3% to 3.6% before and 0% to 1.9% with `bd9358c`, so no
improvement in rate is claimed, for `bd9358c` or for main's loop: the fix rests
on the mechanism and the forced reproductions above, as F-03's and F-04's did. The test alone, by name,
reproduced the failure here, where the issue's five runs of the file alone had
not.

### The fix

The fix that stands is on main, #132's `03593c5` (D221), in
`calls-in-flight-routes.test.ts` only. The count's loop waits for the count and
for every refused connection's end together, within the one deadline it
already had (`:1649`–`:1660` at `edabc00`):

```ts
const deadline = Date.now() + 1_000;
const unended = (): number => refused.filter((connection) => !connection.ended()).length;
let open = await connections();

while (open !== 128 || unended() > 0) {
  assert.ok(
    Date.now() < deadline,
    `${open} connections open and ${unended()} refusals not ended a second after the refusals, not the 128 waits'`,
  );
  await delay(10);
  open = await connections();
}
```

The bound is 1 s from the last refusal read, for the count and the 140 ends
together, both read every 10 ms; on timeout the message names the count still
open and how many refusals have not ended, and the bare `assert.ok` is gone.
Everything else the test checks is unchanged: its name, the 128 waits, the 140
refusals as above, each `429` with `Connection: close`, the count back at
exactly 128 within 1 s, which is what the test is named for (D213 point 5),
`places.takenBy(A)` at 128, then the clear and nothing held.

This task's `bd9358c`, on its branch until it merged main at `edabc00`, left
the loop as `c300ccc` had it and waited after it instead: for each of the 140
refused connections in turn, with the file's own `endedWithin` (`:1395` at `c300ccc`, `:1402` on main),
1 s at most from the start of its wait, failing
`refusal <index>: the server kept the connection open`. After main's loop it
would find every refusal ended already, so the merge dropped it. Both test the
same property: a client's end read after the server's count has dropped,
waited for within a bound instead of read at once. Whether the evidence above,
made with `bd9358c` only, carries over to main's loop was judged by reading
the two, not run again:

- The forced reproductions: `c300ccc`'s failures stand as they are. With the
  flag set 30 or 50 ms late, main's loop keeps reading until the ends are read,
  so it passes whenever the count and the delay together come within the
  second; the whole test took a median of about 340 ms in the measurement. With
  the flag never set, it fails at its deadline, about 1 s after the refusals,
  with `128 connections open and 140 refusals not ended …` where `bd9358c`
  failed `refusal 0: …`.
- The mutation: it failed `bd9358c` in the count's loop, before the wait for
  the ends was reached, and main's loop is that loop with one more condition,
  so it fails there on the same 1 s bound, its message reading
  `268 connections open and 140 refusals not ended …`.
- The measurement compared `c300ccc` with `bd9358c`, its intervals overlap, and
  no rate is claimed for either wait.

What differs is the time the ends are given: `bd9358c` gave them up to 1 s
each after the count was back, main's loop the rest of the count's own second.
Both resume from a timer, so a process held off the CPU for a second or more
inside the wait can find its deadline gone on the turn it comes back, before
the poll phase that would read the end, and fail. That takes a stall of a
second, not the turn or two this flake was, and the count's 1 s was already
exposed to it; recorded, not changed.

### Watched, and left

- The count loop's own 1 s (`:1641`–`:1648` at `c300ccc`, the loop at
  `:1649`–`:1660` on main) did not fail in the 400 runs above or in the full
  runs below. The file's other single wall-clock bounds,
  `answeredWithin(…, 1_000)` at `:651`, `:655` and `:785` on main (`:644`,
  `:648` and `:778` at `c300ccc`) and
  `answeredWithin(keptAlive, 1_000, 'kept alive')` at `:1072` (`:1065` at
  `c300ccc`), and
  the `delay(200)` and `delay(300)` checks, ran only in those full runs and in
  one run of the whole file in `bd9358c`'s copy, and did not fail. Issue #169
  left them out of scope.
- The full backend suite at `c300ccc`, `node scripts/db.mjs task-test 169`, on
  2026-10-10 from 22:37 (UTC+3), the 1-minute load average 15.6 before and 30.5
  after: 1812 tests, 1811 passing, exit 1, this test passing and F-07's
  `counts 100,000 distinct addresses quickly` (`rate-limit.test.ts:384`)
  failing with `took 5268.0 ms at best in 5 runs, over the 5000 ms bound`, a
  load beyond what `withinBound` absorbs, as F-07 records. At `bd9358c`, at a
  load of 8.2 before and 13.8 after: 1812 of 1812, exit 0.

## F-11 — `of processes waiting on a mutex that goes stale at once, and holders killed midway, none lets a second writer in`

- **Test**: `scripts/delivery-queue.test.mjs:2172` at `c43f5ea`, its check of
  each process's exit at `:2240`; `:2191` at `d43d90e`, the fix as it stands,
  that check at `:2308` and the check of the writers at `:2328`. F-06 cited it
  as `:1845` at `f9e37bc`, the issue as `:1993`, the check `:2061`, at
  `64c97ab`; on #191's branch the check was at `:1850`. Issue #162.
- **Status**: fixed in the test on `fix/delivery-script-test-flakes`: the hold,
  the refusals and the check of the writers at `bbd0758`, the empty claim at
  `d43d90e` after the measurement below found it.
  `.claude/scripts/delivery-queue.mjs` was not changed, and no failure whose
  output was kept is a second writer: each is a process giving up on its
  bounded wait, as the script says it does. Why they gave up in the
  measurement's failure — a claim left empty by a killed process, which the
  script waits on for 30 s (point 5 below) — is a wait of the script's, not
  of this test, and is filed as #225. What the test does not
  catch is under **Watched, and left**. #225 then closed point 5 in
  `.claude/scripts/delivery-queue.mjs`, and took the test's handling of an
  empty claim out again (**The fix**).

### The failure

It failed once in each batch of F-06's measurement, in the eleven-file runs,
its output not recorded; then in deliveries on branches that do not touch it,
each time passing on a re-run: for the developer of the 1.0.0 release MR on
2026-10-14 (the test in 7.0 s), and for the developer and the tester of #191
on 2026-10-17 (9.0 s and 10.2 s). The tester's, as the issue quotes it from
the session's transcript:

```text
AssertionError [ERR_ASSERTION]: round 7, …
```

Nothing more of these was kept, and the measurement below did not reproduce a
failure at `c43f5ea` in 50 runs. Both ways a process gives up below, the hold
or the turns (points 2 and 3) and the empty claim (point 5), end at `c43f5ea`
in the check of each exit, as
`round <n>, <shape>: <kind> fault: the queue state is in use by another process (…)`,
the forced reproductions show; which of them the deliveries met is not known.

### The mechanism

1. A process waiting for the queue's mutex gives up `MUTEX_WAIT_MS`, 5 s,
   after it began to wait: `acquire()` fixes its deadline before its first
   try. It then exits 1 with
   `fault: the queue state is in use by another process (<directory>/state.lock, PID <holder>) [D216]`
   and writes nothing, which is the bound working.
2. Each round, the test holds the mutex — its own process named in it — until
   all sixteen of its processes wait, each known by the file it makes beside
   the mutex as it begins to wait, for at most 60 looks 50 ms apart; then it
   makes the mutex stale. A loaded machine starts the sixteen over seconds —
   each a Node process that runs `git rev-parse` before it waits, a
   reservation `git show` as well — and runs the test's own looks late, so the
   hold could reach 5 s from the first process's start.
3. Then the sixteen take the mutex one at a time, and one that began to wait
   first can run out of its 5 s behind the others.
4. Either way that process exits 1 with the fault above, and the test held
   every process it had not killed to exit 0: it failed on a refusal, naming
   the round and the fault, not on a second writer.
5. Found by the measurement below, with the first fix: each round kills some
   updates a few milliseconds after the mutex goes stale, "while it takes the
   mutex over, holds it or writes". `takeOver()` makes its claim with
   `openSync(claim, 'wx')` and writes its PID into it after; a process killed
   between leaves an empty claim. An empty claim names no process, so
   `isStale()` holds it for one being made until it is 30 s old
   (`MUTEX_STALE_MS`), and every process that finds the stale mutex it is
   named for leaves that mutex to it, and gives up at its 5 s with the fault
   above, naming the dead holder's PID. Nobody writes in that round.
   Closed by #225: `takeOver()` makes its claim as `acquire()` puts the mutex
   in place, by hard-linking the caller's own mutex file, `<pid> <nonce>`
   already in it, into the claim's name, so a claim is never seen without its
   maker's PID. A maker killed holding it leaves a claim naming a dead
   process, which the next process passes over at once, and its own file,
   which the next holder sweeps as any dead process's mutex file.

The forced reproductions below make 2 and 5 happen on a quiet machine; 3 is
the same bound reached after the stale moment instead of before it, and was
not reproduced on its own.

### The forced reproductions

Not committed. Each ran in a copy of `.claude` and `scripts` outside the
worktree, of `c43f5ea` for before, of `bbd0758` and of `d43d90e` for after,
the test file changed as below, one fresh process per run, on 2026-10-19
(UTC+3): at `c43f5ea` and `bbd0758` between 17:22 and 17:31 at a 1-minute load
average of 1.7 to 3.2, the empty claim at 17:52 at 6.0, at `d43d90e` between
17:54 and 17:59 at 5.2 to 10.6, beside the other tasks of the delivery cycle:

```sh
node --test --test-name-pattern='goes stale at once' scripts/delivery-queue.test.mjs
```

| Change to the test | At `c43f5ea` | At `bbd0758` | At `d43d90e` |
| --- | --- | --- | --- |
| none | — | — | 3 of 3 passed, in 4 to 5 s |
| every other task's two processes started 3 s late, through `/bin/sh -c 'sleep "$0"; exec "$@"'`, which keeps the PID, and the mutex held, before it goes stale, until the processes started first have ended | 3 of 3 failed in round 0, the test in 6.8 s, as below | 3 of 3 passed, in 43 to 44 s; a probe counted, in each of the 8 rounds of one more run, 8 processes giving up, 8 waiting at the stale moment and 6 or 7 of them writing | 3 of 3 passed, in 43 to 44 s |
| the mutex held, before it goes stale, until every process has ended | 1 of 1 failed in round 0, as below | 1 of 1 failed: too loaded to check, as below | 1 of 1 failed, the same |
| in the shape `its holder is gone`, an empty claim named for the mutex put in place before it goes stale, as point 5 leaves one | 2 of 2 failed in round 1, as below | 2 of 2 failed: too loaded to check, `0 of the 16 processes … wrote`, 13 giving up and 3 killed, the counts of the measurement's failure | 1 of 1 failed after three attempts, as below |
| that claim only the first time | — | — | 3 of 3 passed, in 9 to 10 s, round 1 made again once |

At `c43f5ea`, the PID being the test's own, which holds the mutex, and the
eleven lines the change adds putting the test at `:2183`:

```text
test at scripts/delivery-queue.test.mjs:2183:1
✖ of processes waiting on a mutex that goes stale at once, and holders killed midway, none lets a second writer in (6757.055ms)
  AssertionError [ERR_ASSERTION]: round 0, its holder's time runs past the bound: reserve fault: the queue state is in use by another process (/private/var/folders/n4/g960v9mx1jz26vxns9fwr0t00000gn/T/qa-queue-PJ8pXD/work/.git/delivery-queue/state.lock, PID 10272) [D216]
```

At `c43f5ea` with the empty claim, the PID that of the dead holder the shape
names:

```text
AssertionError [ERR_ASSERTION]: round 1, its holder is gone: reserve fault: the queue state is in use by another process (/private/var/folders/n4/g960v9mx1jz26vxns9fwr0t00000gn/T/qa-queue-MX2eN4/work/.git/delivery-queue/state.lock, PID 28053) [D216]
```

With the fix, every process held past its wait, and the empty claim in every
attempt:

```text
AssertionError [ERR_ASSERTION]: the machine was too loaded to check: round 0, its holder's time runs past the bound: 0 of the 0 processes waiting when the mutex went stale wrote, fewer than the two a second writer needs, and 16 of the 16 gave up on their 5 s wait; or delivery-queue.mjs no longer lets a waiting process take a stale mutex over
AssertionError [ERR_ASSERTION]: round 1, its holder is gone: in each of 3 attempts a process killed between making its claim and writing it left the claim empty, which holds every other process off the stale mutex for 30 s, and 0 of the 16 processes waiting when it went stale wrote: the round checked nothing
```

### The mutation

In copies of `.claude/scripts/delivery-queue.mjs` outside the worktree, run
as above with the test file of each commit, between 17:23 and 17:32 at a
1-minute load average of 1.6 to 4.9, and at `d43d90e` between 17:54 and 17:59:

| Change to `delivery-queue.mjs` | At `c43f5ea` | At `bbd0758` | At `d43d90e` |
| --- | --- | --- | --- |
| `acquire()` takes a stale mutex by renaming its own file over it, with no claim and no check: `if (isStale(found)) { renameSync(mine, mutex); return { mutex, nonce }; }` | 3 of 3 failed, in round 0 or 1, a holder finding its mutex taken | 3 of 3 failed, in round 0, the same | 3 of 3 failed, in round 0 or 1, the same |
| the same, and `stillHeld` always true, so that the second holder writes | 3 of 3 failed: `day-a's D217 was lost`, `day-g's update was lost`, `day-b's update was lost` | 3 of 3 failed: `day-b's D217 was lost`, `day-d's D225 was lost`, `day-b's D233 was lost` | 3 of 3 failed: `day-d's update was lost`, `day-c's D217 was lost`, `day-a's D225 was lost` |
| `takeOver()` without its `sameFile` check, the issue's example | 5 of 5 passed | 5 of 5 passed | 3 of 3 passed |
| `acquire()` removing a stale mutex without `takeOver()`: `if (isStale(found)) { rmSync(mutex, { force: true }); continue; }` | 4 of 5 passed; 1 failed, a holder finding its mutex taken | 5 of 5 passed | 3 of 3 passed |

A holder finding its mutex taken, as it appeared:

```text
AssertionError [ERR_ASSERTION]: round 0, its holder's time runs past the bound: update fault: this process held the queue's mutex past 30 s and another took it over; nothing was written [D216]
```

The first two let every process that found the mutex stale in at once, and
every commit catches them in every run: through the holder's own check before
it writes, and with that check gone through the lost reservations and
updates. The last two let a second writer in only through a race some
microseconds wide — a process that read the stale mutex just before another
took it over, and makes its claim just after that one let its claim go — and
no commit's stampede catches them but by chance. The issue's example is
caught by the test that plays that race step by step, `a takeover of a mutex
found stale removes it only while it is still that one, never the mutex
another process took meanwhile` (`:2254` at `c43f5ea`, `:2347` at
`d43d90e`): 1 of 1 run failed at `c43f5ea` under it, with
`ENOENT … state.lock`. See **Watched, and left**.

### The measurement

One batch of one shell script, `CI` unset, Node v24.19.0, on the operator's
Mac, an Apple M1 Pro with 8 CPUs and 16 GB, beside the other tasks of the
delivery cycle, as the issue sets it out to keep its cost down. The load, as
F-10's: four `node -e 'for(;;){}'`, one per two CPUs, for the whole batch,
each PID recorded and stopped by it at the end. The script ran the copies of
`c43f5ea` and of `bbd0758` above, without the forced changes, in turn, 50
runs each, one fresh process per run, the command above, no retries, no run
repeated; the 1-minute load average was read before each run and includes
the other agents' work.

| Batch | Time, 2026-10-19 (UTC+3) | 1-minute load average |
| --- | --- | --- |
| moderate | 17:41–17:50 | 19.6 before; 18.9 to 37.4 at the runs, median 28.3 |

| Copy | Runs | This test failed | Rate (Wilson 95%) | The test's time |
| --- | --- | --- | --- | --- |
| `c43f5ea` | 50 | 0 | 0% (0%–7.1%) | 4830 to 5450 ms, median 5119 ms |
| `bbd0758` | 50 | 1 | 2.0% (0.4%–10.5%) | 4724 to 7270 ms, median 4970 ms |

The failure, run 10 of `bbd0758`, at a load of 28.0, in 7.3 s:

```text
test at scripts/delivery-queue.test.mjs:2191:1
✖ of processes waiting on a mutex that goes stale at once, and holders killed midway, none lets a second writer in (7270.920042ms)
  AssertionError [ERR_ASSERTION]: the machine was too loaded to check: round 1, its holder is gone: 0 of the 16 processes waiting when the mutex went stale wrote, fewer than the two a second writer needs, and 13 of the 16 gave up on their 5 s wait; or delivery-queue.mjs no longer lets a waiting process take a stale mutex over
```

Load leaves some of the processes their turn; here all sixteen waited at the
stale moment and every one of the thirteen not killed gave up. That is point
5 of the mechanism, the empty claim, whose forced reproduction above gives the
same counts. `d43d90e` makes such a round again instead of failing it.

The intervals overlap, 0% to 7.1% at `c43f5ea` and 0.4% to 10.5% at
`bbd0758`, so no improvement in rate is claimed: at this load the failure of
the deliveries did not come back in 50 runs at `c43f5ea`, and the fix rests
on the mechanism and the forced reproductions above, as F-03's, F-04's and
F-10's did. `d43d90e` was not measured under load: the issue's 50 runs after
were spent on `bbd0758`, and its change is proved by the forced reproduction
of the empty claim alone.

### The fix

In `scripts/delivery-queue.test.mjs` only, `bbd0758` and `d43d90e`; the
test's name, its eight rounds, its four ways of going stale and its kills are
unchanged.

- **The hold.** The mutex goes stale once every process waits, or 2 s
  (`HOLD_MS`) after the first began to, read from the time of that process's
  file beside the mutex, which it makes as its wait begins; 20 s at most from
  the spawn should none ever wait. Each process waiting at the stale moment
  then has at least about 3 s of its 5 left for its turn. The looks are 20 ms
  apart.
- **A process that gives up.** One that ends with exit 1, nothing on stdout,
  and on stderr the in-use fault alone, naming the queue's mutex, with or
  without a PID, is a process that never held the mutex, not a second
  writer, and no longer fails the test. It is held to writing nothing of its
  own: an update's value is not in the state, and each task holds exactly the
  reservations its processes reported, counted over the rounds, so that a
  reservation written by a process that gave up, or lost by one that
  reported it, fails the round. Any other ending of a process not killed
  still fails the test, as before, with the round and its stderr.
- **A round that checked nothing.** The processes waiting at the stale moment
  are read just before it, by their files; a round counts only when at least
  two of them wrote, the fewest a second writer needs. With fewer the round
  fails as too loaded to check, never passes, and its message names the
  other reading, the queue no longer letting a waiting process take a stale
  mutex over, with how many waited, wrote and gave up.
- **An empty claim**, `d43d90e`. Once a round is over, a claim file left
  empty — only a process killed between making it and writing it leaves one,
  since every process has ended and a live one removes its own — is aged past
  the 30 s bound, as the time would age it, so that the next holder's sweep
  removes it; the test's last check, that nothing killed processes left is
  still there, holds it to that. A round in which such a claim kept the
  waiting processes from writing — fewer than two wrote — is made again with
  fresh processes, up to three attempts in all; one blocked in all three fails
  naming the empty claim, not load. This is the precondition tried again, not
  the property: each attempt is held to every check above. The updates' values
  carry the attempt, so that one attempt's cannot pass for another's.
  #225 took this out again: with the claim linked into place whole (point
  5), every claim a round leaves names a process, and the test now fails a
  round that leaves one naming none, before its check of the writers, instead
  of making the round again; the attempts and their mark in the updates'
  values went with it.

`MUTEX_WAIT_MS` stays 5 s and unexported, as the issue keeps the script out
of scope; the test names the 5 s in its comment.

### Watched, and left

- The stampede is a net for regressions that let many processes in at once,
  not for the narrow race of `takeOver()`'s `sameFile` check: the mutation
  above passed every run of the Developer's at load 2–5, and the Tester
  saw the stampede catch it only by chance under load 29–39 (base 3 of 13,
  head 4 of 13), so it is not a check of it. That race is pinned by the step
  test named above, and the check before writing (`stillHeld`) by
  `a holder whose mutex was taken over while it held it writes nothing and
  says so`. Making the stampede itself catch it would need a way to stop a
  process inside `takeOver()`, which the script does not offer; issue #162
  did not ask for it.
- The empty claim's 30 s, point 5, was the script's own rule, not changed
  by #162: until a claim that names nobody is 30 s old, every queue command
  that finds the stale mutex it is named for fails with the in-use fault,
  naming a holder that is dead. #225 closed that window: a claim is now
  written whole before it is put in place, as the mutex is, and the script
  leaves none empty. Its tests are `a claim made by a takeover is never seen
  without its maker’s PID, at any step of the takeover`, which reads every
  claim after each file-system call of a takeover and fails a claim made
  with `wx` and written after, and `a takeover killed holding its claim
  holds nobody up: …`, which kills a takeover holding its claim and has the
  next writer take the mutex at once and sweep what it left. The rule itself
  stays: a claim that names nobody, which only a copy of the script from
  before #225 leaves, is still waited on until it is 30 s old, since taking
  it for a dead one at once would let two takeovers of the same mutex run
  together while such a copy is between making its claim and writing it.

### After #225

The tree committed as `f18ab7d` on `fix/queue-claim-whole`, on 2026-10-20
(UTC+3) between 03:17 and 03:21, on the operator's Mac as above, Node
v24.19.0, beside the other tasks of the delivery cycle, under the load of
**The measurement**: four `node -e 'for(;;){}'`, each PID recorded and
stopped at the end. Twenty runs, one fresh process each, no retries, the
1-minute load average read before each; the pattern takes the stampede, the
step test and #225's two tests:

```sh
node --test --test-name-pattern='goes stale at once|takeover|claim' scripts/delivery-queue.test.mjs
```

| Runs | A run failed | Rate (Wilson 95%) | 1-minute load average | The stampede's time |
| --- | --- | --- | --- | --- |
| 20 | 0 | 0% (0%–16.1%) | 19.8 to 45.1, median 42.5 | 4950 to 7697 ms, median 5898 ms |

No rate is claimed from it: it shows the stampede without its attempts, and
the two new tests, passing at that load — the first of them as `f18ab7d` had
it, before `0e926bd` added its third scenario, the takeover whose own file was
swept away first. In copies of `.claude` and `scripts`
outside the worktree, the first new test failed, 1 of 1 run each, on the
script of `4f5e0d1` and on the fix with the claim made by `openSync(claim,
'wx')` and written after, both at the same step:

```text
AssertionError [ERR_ASSERTION]: state.lock.claim-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1 after openSync
```

with `pid: null` and `nonce: null` read where the claim's maker was
expected; the second failed on both too, on the claim's PID and on the
claim not being its maker's file, linked.

## F-12 — ``each way the site can fail is named in `site/fail` ``, its table of page and lookup cases

- **Test**: `scripts/monitor.test.mjs:302` at `c43f5ea`, the `t.test` loop
  over its table of cases at `:360` — F-06's `scripts/monitor.test.mjs:360`,
  at `7a667f8` and `f9e37bc` — with `MONITOR_TIMEOUT_SECONDS: '0.3'` at
  `:362`; at `bbd0758`, the fix, the loop at `:365` and
  `the page never answers` a case of its own at `:385`. Issue #162.
- **Status**: fixed in the test on `fix/delivery-script-test-flakes`, at
  `bbd0758`. `deploy/helm/qa-tools/files/monitor.mjs` was not changed and was
  not at fault. No load measurement was made for this entry (issue #162,
  Decisions): the load figures are F-06's, and no new rate is claimed.

### The failure

In F-06's measurement, at a 1-minute load average of about 143 on 8 CPUs, the
table's cases failed 30 times in 12 of the 20 eleven-file runs before #120's
fix, and twice in 2 of the 20 after it, which does not touch this file. Their
output was not recorded, and the issue found none failing in the agents'
transcripts after 2026-10-10. What a late stand-in does to the table, from the
forced reproductions below at `c43f5ea`:

```text
test at scripts/monitor.test.mjs:360:13
✖ the page is not HTML (1097.410417ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'site down after 3 attempts: GET / failed: no answer within 0.3 s'
  - 'site down after 3 attempts: GET / answered 200 text/plain'
```

and, with the heartbeats late as well:

```text
  2026-10-19T14:33:02Z Monitor finished: site down, disk ok; 0 of 2 heartbeats delivered
  2026-10-19T14:33:01Z ERROR: Heartbeat disk not delivered: no answer within 0.3 s
  2026-10-19T14:33:02Z ERROR: Heartbeat site/fail not delivered: no answer within 0.3 s

  1 !== 0
```

### The mechanism

`MONITOR_TIMEOUT_SECONDS` bounds every request the monitor makes: the page,
the lookup and the receive host in each attempt, and both heartbeats
(`timeoutMs`, which `main()` passes to `probeSite` and `sendHeartbeat` alike).
The table ran at 0.3 s, so that its one case that never answers would not
wait long. The stand-ins are servers in the test's own process, which a loaded
machine runs late like everything else. An answer later than 0.3 s ends that
request with `no answer within 0.3 s`: on the last attempt the text replaces
the failure the case pins; on a heartbeat the heartbeat is not delivered and
the monitor exits 1, which the case's first assertion fails. Every other case
of the file runs at the 2 s `setup()` gives, and none of them failed under
F-06's load (inferred from F-06's counts, which name this table alone).

### The forced reproductions

Not committed. Each ran in a copy of `deploy`, `packages`, `package.json` and
`scripts` outside the worktree, of `c43f5ea` for before and with the test file
of `bbd0758` for after, the test file changed as below, one fresh process per
run, on 2026-10-19 between 17:33 and 17:37 (UTC+3), at a 1-minute load
average of 2.6 to 15.6:

```sh
node --test --test-name-pattern='each way the site can fail' scripts/monitor.test.mjs
```

| Change to the test | At `c43f5ea` | With the fix |
| --- | --- | --- |
| the site's stand-in answers 0.5 s late, `setup()` wrapping its handler in a `setTimeout` | 3 of 3 failed, 9 of 11 tests each: every case that gets an answer, its text replaced as above, and the parent; `the page never answers` and `nothing listens` passed | 3 of 3 passed, 11 of 11 |
| every stand-in, the heartbeats' included, answers 0.5 s late, `serve()` wrapping each handler | 3 of 3 failed, 10 of 11 each: all nine cases with exit 1, both heartbeats `not delivered: no answer within 0.3 s`, and the parent; `nothing listens`, at 2 s, passed | 3 of 3 passed, 11 of 11 |

By name the test holds 11 tests at both commits: itself, its nine cases and
`nothing listens`.

### The mutation

In the same copies, `main()`'s `await send('site', siteOk, siteLine)` made
`await send('site', true, siteLine)`, so that `site/fail` is sent as `site`:
3 of 3 runs failed at `c43f5ea` and 3 of 3 with the fix, every one of the 11
tests in each, each case on

```text
  + 'site'
  - 'site/fail'
```

### The fix

In `scripts/monitor.test.mjs` only, `bbd0758`. The cases of the table get an
answer, so they run with the file's 2 s for a request instead of 0.3 s: a
stand-in has nearly seven times as long to answer, and a case's text is still the
last attempt's failure, the site's answer. `the page never answers` is a case
of its own after the table: one attempt, `MONITOR_ATTEMPTS: '1'`, at the same
2 s, pinning `site down after 1 attempt: GET / failed: no answer within 2 s`
and that the only request was `GET /`. It waits out 2 s once where it waited
0.3 s three times, about a second more. A second limit only for the
heartbeats would take a change to `monitor.mjs`, which the issue keeps out of
scope.

## F-13 — `a Docker that ignores the polite stop is killed after the grace period`

- **Test**: `scripts/db.test.mjs:208` at `c43f5ea`, as at `3a48b04` (F-06's
  `:132` at `7a667f8` and `:192` at `f9e37bc`); `:212` at `bbd0758`, the fix.
  Issue #162.
- **Status**: fixed in the test on `fix/delivery-script-test-flakes`, at
  `bbd0758`. `scripts/db.mjs` was not changed and was not at fault. No load
  measurement was made for this entry (issue #162, Decisions): the load
  figures are F-06's, and no new rate is claimed.

### The failure

It never failed: it passed without checking its grace period. F-06 counted it
taking about 1 s instead of about 6 — its SIGTERM before its stand-in's trap —
in 7 of 120 runs before #120's fix, 5.8% (2.9%–11.6%), and 5 of 120 after,
4.2% (1.8%–9.4%), at a 1-minute load average of about 143, all 7 in runs in
which F-06's own test failed. At `c43f5ea` it also passes with the grace period
gone, as the mutation below shows: there is no failure output to quote, only
a pass in about 1 s.

### The mechanism

The stand-in was `trap '' TERM` and a loop of `sleep 1`. Under a limit of 1 s,
`run()` sends SIGTERM to the stand-in's process group at the limit and SIGKILL
`GRACE_MS`, 5 s, later. A SIGTERM that comes before the shell has read its
trap line ends the shell at once; `run()` then kills what is left of the group
and returns 124, about 1 s in. The test held the run to code 124 and to under
9 s only, so it passed either way, and passes whatever the grace period is.

### The forced reproduction

Not committed. Each ran in a copy of `scripts/db.mjs`, `scripts/db.test.mjs`,
`docker-compose.yml` and `package.json` outside the worktree, of `c43f5ea` for
before and with the test file of `bbd0758` for after, the stand-in changed as
below, one fresh process per run, on 2026-10-19 at 17:38 and 17:39 (UTC+3), at
a 1-minute load average of 14 to 17, beside the other tasks of the delivery
cycle:

```sh
node --test --test-name-pattern='ignores the polite stop' scripts/db.test.mjs
```

| Change | At `c43f5ea` | With the fix |
| --- | --- | --- |
| none | — | 3 of 3 passed, in 6.0 s: the first attempt, at 1 s, ready |
| `sleep 2` before the trap | 3 of 3 passed, in 1.0 s, the grace period not reached | 3 of 3 passed, in 12.0 s: the attempts at 1 and 2 s not ready, the one at 4 s ready, ending after its limit and the 5 s |
| `sleep 12` before the trap | 1 of 1 passed, in 1.0 s | 1 of 1 failed in 15.0 s, as below |

```text
AssertionError [ERR_ASSERTION]: the stand-in did not set its trap before the polite stop under a limit of 1, 2, 4, 8 s, the attempts giving up after 1006, 2002, 4004, 8003 ms, none before its limit: the machine was too loaded for the stand-in's shell to set it in time, or scripts/db.mjs no longer starts the stand-in as it did
```

### The mutation

In the same copies, `GRACE_MS = 5000` in `scripts/db.mjs` made `0`, so that
SIGKILL follows SIGTERM at once: at `c43f5ea` 3 of 3 runs passed, in 1.0 s;
with the fix 3 of 3 failed, in 1.0 s, on the first attempt:

```text
AssertionError [ERR_ASSERTION]: the attempt under a limit of 1 s, its stand-in ignoring the polite stop, gave up after 1001 ms: scripts/db.mjs no longer waits 5 s after the polite stop before it kills Docker
```

### The fix

In `scripts/db.test.mjs` only, `bbd0758`, as F-06's fix did for the hang-up
test. The stand-in writes `ready` right after its trap line, with the shell's
own redirection, `: > "${0%/*}/ready"`, so nothing is started between. Each
attempt is a fresh stand-in under a limit of 1, 2, 4 and then 8 s, held to
code 124, to giving up no sooner than its limit less 100 ms (`EARLY_MS`) —
load only makes an attempt later, so one sooner fails the test at once — and
to its limit plus the grace period plus 3 s at most. An attempt with no
`ready` once it ended had its trap come after the SIGTERM and checked nothing:
the next attempt follows. The first with `ready` decides: it must have lasted
its limit and the grace period, less the same 100 ms. The grace period is
written in the test as `GRACE_MS = 5000` with a comment, since
`scripts/db.mjs` does not export it. When no attempt was ready, the test fails
naming both readings, as F-06's test does since #164. Only the precondition,
the trap before the SIGTERM, is tried again, never the property. On a quiet
machine the test takes 6 s as before; against a burst like F-06's, whose
stand-ins were late at 1 s and on time by 8 s, it takes up to 1 + 2 + 4 + 8 s
and the grace period.

## F-14 — the backend suite under `--test-force-exit` reports fewer tests, exit 0

- **Test**: no single test. What is lost is the tail of one backend test
  file's report, as F-02 found for the frontend: the tests of its last
  `describe` blocks, or part of them, are absent from the summary. Seen in
  `src/modules/requests/list-query.test.ts` (`hostile input at growing
  sizes`), `src/modules/sessions/status-body.test.ts` (`parseStatusBody:
  hostile bodies up to the body limit`), `src/modules/mcp/protocol.test.ts`,
  `src/modules/sessions/access-key.test.ts` and
  `src/modules/requests/search.test.ts`, and any file's tail can go: on the
  operator's Mac (F-07, **Watched, and left**) and in CI's `test` job, on main
  in every pipeline checked (issue #160). Issue #160.
- **Status**: fixed in the procedure by issue #160, on
  `fix/backend-suite-exit-guard`: the backend's `test` script runs without
  `--test-force-exit` and loads an exit guard,
  `apps/backend/src/testing/exit-guard.ts` (D132, amendment 2026-10-20). No
  test file had to change: none was kept alive by a handle once the flag was
  gone.

### The question, at the base

Issue #160 asked first whether, under the base's flags and load, a test that
fails inside a lost tail still makes the run exit non-zero, and whether the
lost tests ran at all. At the base, `a69b262`, Node v24.19.0, on the
operator's Mac, an Apple M1 Pro with 8 CPUs and 16 GB: the lost tests ran,
and a failure among them failed the run, but as its file failing with
`'test failed'`, the test that failed and its error not reported.

- **The runner's source**, `internal/test_runner/test.js`, `harness.js` and
  `runner.js` of Node v24.19.0, read with `process.binding('natives')`. Under
  the flag a test file's process, once every test its root knows of has
  ended, waits only until its reporter has handed its last event to stdout,
  runs the harness's teardown, which reports the file's summary and sets
  `process.exitCode = 1` when a test failed, and calls `process.exit()`. What
  stdout still holds then, written to the stream but not yet taken by the
  pipe, which only the runner's reading empties, ends with the process. The
  runner fails a file whose process exits non-zero, with `'test failed'`.
- **Forced**, the file `apps/backend/src/testing/exit-guard.test.ts` writes
  for the script's cases, which stops its runner with SIGSTOP and then
  reports 15 tests more, about 100 KiB, while the test holds the runner
  stopped until the file's process has ended or 3 s are up: the base's
  script, `--test-force-exit` in it, run on that file through the test copied
  into the base,
  `npm test -w @qa-tools/backend -- src/testing/exit-guard.test.ts`.
  The file's process ended at once; the runner reported 9 of the file's 16
  tests, exit 0, and the record each test of the tail writes held all 15.
  With a test that fails added at the end of the tail: 9 tests passing and
  the file failed, exit 1, all 16 recorded, the failing test not named. The
  same test passes at the head, the runner reporting 16 of 16 and 17 of 17
  with the failure named.
- **Under load**, every backend test file but `test-files-exit.test.ts`
  given, in a copy of the base, not committed, a root-level `afterEach()`
  that appends the file and the test's name to a file of its own and a last
  test that fails, `dev-160: a failure planted at the end of the file`. Eight
  runs of `node scripts/db.mjs task-test 160` from the copy's root, on
  2026-10-20 from 05:38 to 05:50 (UTC+3), beside the other tasks of the
  delivery cycle, the 1-minute load average 42 to 137, median 66. The suite
  then held 2595 tests. Two runs lost a tail. Run 4 reported 2568, its report
  of `src/modules/sessions/access-key.test.ts` stopping after `carries no
  key in the protocol alone`, 27 tests and 6 `describe` blocks short; run 8
  reported 2574, `src/modules/requests/list-query.test.ts` stopping after
  `refuses conditions of 1024 bytes without echoing them`, 21 tests and
  `hostile input at growing sizes` short. In both the planted failure of that
  file was not named, the file was reported failed as below, and the record
  held every test of the file, the lost ones and the planted one included:
  65 of `access-key.test.ts`, as in each of the other runs. Every run exited
  1, on the other 94 planted failures as well. The same planting in three
  files only, `list-query.test.ts`, `status-body.test.ts` and
  `protocol.test.ts`, lost no tail in eight runs from 05:23 to 05:37, at a
  load of 41 to 118, median 89.

```text
✖ src/modules/sessions/access-key.test.ts (313.102375ms)
  'test failed'
```

### The mechanism

F-02's, now traced. A file's process writes its report to a pipe the runner
reads. On this Mac the pipe takes 64 KiB before a write waits, and the
process's stdout holds up to its high-water mark, 64 KiB as well, before it
pushes back on the reporter: measured with a child writing 1 KiB at a time
to a pipe nobody read, its first write held back after 66 KiB, with
`writableHighWaterMark` 65536. A report the runner has fallen behind on by
more than the pipe holds and less than that plus the high-water mark is in
the stream when the process calls `process.exit()`, and is lost; one further
behind is pushed back on, the process waits for the runner, and only what is
still in the stream at the very end goes. So the loss is never more than
about 64 KiB of report, a few dozen tests: 1 to 33 in the runs below, 20 to
72 in the CI pipelines of issue #160. A runner falls behind when the machine
gives it less time than the files it reads, which is load. In the runs
below a moderate load lost tails more often than a heavy one; perhaps a heavy
load slows the files as much as the runner, which was not traced.

Without the flag a file's process ends when nothing is left for it to do,
and a write the pipe has not taken yet is something left: the process waits
for the runner, however far behind it is, and the whole report arrives. What
then bounds a process kept alive is the exit guard, 10 s after the file's
tests: it names what it found, and a write still waiting, `SimpleWriteWrap`
on Node 24.19, means a runner more than 10 s behind, which fails the file
instead of shortening the count.

### The measurement

Batches of one shell script, from the repository root in each worktree,
`CI` unset, Node v24.19.0, on the same Mac, beside the other tasks of the
delivery cycle: the base `a69b262` in a detached worktree of its own with
its own `npm ci`, the head on the task's branch, each run one fresh
`node scripts/db.mjs task-test 160` against the task's database, one batch
at a time, no retries. The heavy batches add F-06's load: eight
`node -e` busy loops, one per CPU, each ending on its own after an hour at
most, started with the batch and stopped by their PIDs at its end. The
ambient ones add nothing. The 1-minute load average was sampled every 30 s.

| Batch | Commit | Time, 2026-10-20 (UTC+3) | 1-minute load average |
| --- | --- | --- | --- |
| heavy | `a69b262` | 04:18–05:08 | 16.6 before; 17 to 202 during, median 86 |
| ambient | `a69b262` | 05:10–05:23 | 37 before; 26 to 113 during, median 39 |
| ambient | head | 05:50–06:05 | 42 before; 42 to 134 during, median 70 |
| heavy | head | 06:05–06:58 | 99 before; 99 to 229 during, median 168 |
| alternating | `a69b262`, head | 06:59–07:25 | 133 before; 24 to 134 during, median 68 |

The suite holds 2500 tests in 386 `describe` blocks at the base, the count
of a run on a quieter machine before the batches and of every full run
since, and 2511 in 388 at the head: the 10 tests of `exit-guard.test.ts` and
the case `test-files-exit.test.ts` gives every test file. A short run is one
whose summary reports fewer tests or fewer `describe` blocks.

| Batch | Commit | Runs | Short runs | Rate (Wilson 95%) | Short with exit 0 | Counts of the short runs |
| --- | --- | --- | --- | --- | --- | --- |
| heavy | `a69b262` | 10 | 1 | 10% (1.8%–40.4%) | 0 | 2484 |
| ambient | `a69b262` | 10 | 4 | 40% (16.8%–68.7%) | 4 | 2499, 2473, 2467, 2496 |
| both | `a69b262` | 20 | 5 | 25% (11.2%–46.9%) | 4 | |
| ambient | head | 10 | 0 | 0% (0%–27.8%) | 0 | |
| heavy | head | 10 | 0 | 0% (0%–27.8%) | 0 | |
| both | head | 20 | 0 | 0% (0%–16.1%) | 0 | |
| alternating | `a69b262` | 10 | 1 | 10% (1.8%–40.4%) | 0 | 2500, its `describe` blocks 385 |
| alternating | head | 10 | 0 | 0% (0%–27.8%) | 0 | |
| **all** | **`a69b262`** | **30** | **6** | **20% (9.5%–37.3%)** | **4** | |
| **all** | **head** | **30** | **0** | **0% (0%–11.4%)** | **0** | |

Every heavy run at the base exited 1 on 5 to 9 tests that hold a time, none
of them in a lost tail (**Watched, and left**); every ambient one exited 0.
The short heavy run lost the last 16 tests of `status-body.test.ts` and their
`describe`; the short ambient ones the last test of the same file, 27 tests
of `access-key.test.ts`, those 27 and 6 of `search.test.ts`, and 4 of
`status-body.test.ts`.

At the head no run was short: 2511 tests in 388 `describe` blocks in all
20, and no guard line in any. The heavy head runs exited 1 on 5 to 15 tests
that hold a time, and two ambient ones on 1 and on 3 (**Watched, and
left**). The head's batches met a higher load than the base's, a median of
70 against 39 ambient and 168 against 86 heavy, so a last batch ran the two
in turn, each pair starting with the other side than the pair before, to
give both the same load. There the base lost one `describe` block's end,
`parseStatusBody: hostile bodies up to the body limit` with every test of it
reported, and exited 1 on a test that holds a time; the head lost nothing,
one run exiting 1 on two such tests. Over all 30 runs of each the intervals
touch, 9.5% to 37.3% against 0% to 11.4%, so the load measurement alone does
not prove the fix; it shows the loss at the base, four times with exit 0,
and none at the head, at a load as high or higher. What proves it is the
forced reproduction above, deterministic: 9 of 16 at the base every time,
16 of 16 at the head.

### The fix

In the procedure, on `fix/backend-suite-exit-guard`. The backend's `test`
script is
`node --env-file-if-exists=../../.env --import ./src/testing/exit-guard.ts --test --test-timeout=120000`,
without `--test-force-exit`. `apps/backend/src/testing/exit-guard.ts` is the
frontend's guard (#63) for the backend: in each test file's process it
starts an unref'd timer of 10 s once the file's tests have ended, and a
process still alive then fails its file, naming what keeps it alive, a
waiting write named as such. `apps/backend/src/testing/exit-guard.test.ts`
runs the guard on leaking and clean files, and the real script on the file
above, held to every test reported and a failing one named. Copied into the
base and run with its script, its four cases of the script fail: the script
loads no guard, 9 of 16 tests are reported, the failing test is not named,
and a runner held past the guard's wait loses the tail with exit 0 instead
of failing the file. `scripts/delivery-cycle.test.mjs` pins the script. No test
file was changed: a full run without the flag ended every file on its own,
no guard line in its output, and no slower: in the alternating batch a run
took 61 to 123 s at the base, median 72.5 s, and 63 to 157 s at the head,
median 67.5 s, the slowest of each, 123 s and 157 s, a run that failed tests
that hold a time.

### Watched, and left

- The heavy batches failed tests that hold a time, none in a lost tail and
  none this entry's subject: at the base
  `src/modules/webhook/pipelining.test.ts:729`, `:862` and `:883`,
  `src/modules/requests/request-wait.test.ts:503` and `:900`,
  `src/modules/limits/rate-limit-routes.test.ts:607`,
  `src/measure-ordinary-load.test.ts:1101` and
  `src/modules/mcp/mcp.test.ts:1184`. At the head, at twice that load, the
  heavy batch failed the same ones and, a few times each,
  `src/modules/requests/request-wait.test.ts:363`, `:481`, `:516` and `:610`,
  `src/measure-ordinary-load.test.ts:1219`, `src/measure-rollout.test.ts:240`,
  `src/modules/realtime/cross-process.test.ts:495` (F-15),
  `src/modules/limits/rate-limit.test.ts:384` (F-07's) and
  `src/db/pool.test.ts:232`; the ambient head runs failed
  `pipelining.test.ts:883` in one run, and `:729` with
  `measure-ordinary-load.test.ts:1101` and `:1219` in another. No test of a
  tail the base lost, here or in issue #160, failed at the head: what the
  recovered tails hold passed in every run.
- A runner more than 10 s behind a file's report now fails that file
  instead of losing its tail with exit 0. No run above did: no guard line
  appeared at the head. The guard's test holds that shape with the runner
  stopped and the guard at 1 s.
- CI's `test` job runs `node:24-slim`, a floating tag, so its Node version
  is read from each job's log; the count in CI is compared in the merge
  request (issue #160, criterion 3).

## F-15 — `delivers what one read finds in id order` and `judges what a read wants`

- **Test**: `apps/backend/src/modules/realtime/cross-process.test.ts:496`
  (`delivers what one read finds in id order: with the reads of both held
  while the calls commit, …`) and `:870` (`judges what a read wants, and
  delivers it, on the registrations as the read returned: …`) at `b3a9c93`;
  `:515` and `:916` at `5d9174d`, the fix, which also covers `:447`, `:465`
  at the fix, the same shape never seen failing. F-14 saw `:496` fail as
  `:495` under load. Issue #198.
- **Status**: fixed in the test on `chore/self-hosted-ci-runner`, at
  `5d9174d`. The listener and the hub were not changed and were not at fault:
  every failure was an event sent and not yet read by the viewer's side of
  its connection.

### The failure

On GitLab's CI runner of #198, `qa-tools-ci-firstvds` (4 vCPU, two jobs at a
time), the `test` job of merge request !251 ran 7 times on 2026-10-22.
Beside another job — `e2e`, or once
`delivery-tooling-tests` — it failed 4 of 6 runs, 66.7% (30.0%–90.3%), each
time one test of this file and nothing else, 2992 of 2993 passed: job
17373195919 (`:496`, beside `e2e`), 17375381943 (`:870`, beside `e2e`),
17387223137 (`:496`, beside `e2e`) and 17387647353 (`:870`, beside
`delivery-tooling-tests`). It passed 2 runs beside `e2e`, 17372972217 and
17374519466, and the one run alone on the idle runner, 17387899083, 2993 of
2993. `:870` had failed once before on a shared runner, job 17330151156 of
2026-10-20, 2883 of 2884.

`:496` failed at its `assert.deepEqual(viewer.events, written)`, line 519,
`actual` the outbox's first events and the rest missing:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
... Skipped lines
  [
    {
      data: {
        customResponse: {
          body: null,
...
    },
-   {
-     data: {
-       id: '4493bc9f-7216-4cdb-a941-8eb7dd65f618',
-       response: {
-         queueStep: null,
-         rule: null,
-         state: 'sent',
-         status: 200
-       }
-     },
-     type: 'response.recorded'
-   },
```

`:870` failed at line 917, the legacy viewer's events, with `actual: []`
against `expected: ['request.received']`.

### The mechanism

A test's flush (`RealtimeListener.flush`, D221) resolves once a read that
began after it has delivered what it found to the instance's hub, which
hands it to the viewer's socket. The viewer is a `WebSocket` client in the
same process; it reads the frame on a later turn of the event loop. The
tests asserted `viewer.events` at once after the flush, or after one
database query, and on a loaded machine the client had not read every
frame yet. The failures above are the only ones of this file in those
runs, and each shows events missing, never one too many or out of order.

### The forced reproductions

Not committed. Each ran the file in this worktree with
`apps/backend/src/testing/realtime.ts` changed as below and restored from
Git after, the test file of `b3a9c93` for before and of `5d9174d` for the
fix, on 2026-10-22, one run per line unless said:

```sh
node scripts/db.mjs task-test 198 -- src/modules/realtime/cross-process.test.ts
```

| The client in `watchUrl` | At `b3a9c93` | With the fix |
| --- | --- | --- |
| reads each event 25 ms late (`setTimeout`, order kept) | 3 of 3 runs failed, 8 of 11 passed: `:447`, `:496`, `:870`, the last with `actual: []` as in CI | 3 of 3 runs passed, 11 of 11 |
| drops every `response.recorded` | failed, 7 of 11: `:206` twice, `:447`, `:496` | failed, 7 of 11: `:224` twice, `:465` and `:515` with `Timed out after 10000 ms waiting for 29 events, 16 so far` |
| receives each event twice | failed, 5 of 11: `:206` twice, `:447`, `:496`, `:536`, `:870` | failed, 5 of 11: the same tests, at `:224`, `:465`, `:515`, `:556`, `:916` |

The second and third rows are the mutations: an event lost still fails the
fixed tests, after a bounded wait and naming what arrived, and one too many
still fails them at once.

### The measurement

CPU load alone did not reproduce it on the operator's Mac (8 cores): with 16
busy loops (`node -e 'for (;;) {}'`) beside it, the file passed 6 of 6 runs
at `b3a9c93`, 0.0% (0.0%–39.0%), and 10 of 10 with the fix, 0.0%
(0.0%–27.8%), the 5-minute load average 26 just after. The second figure
shows the fix does not fail under that load; what shows it removes the race
is the forced reproduction above. The CI runner's next pipelines on the
branch are the measurement under the load that failed it.

### The fix

In `cross-process.test.ts` only, `5d9174d`. Where a test asserts what a
viewer received after a flush, it first waits, bounded at 10 s, for what it
must have received: the two order tests for the outbox's count of events,
through `arrived(viewer, written.length)`, then assert exactly as before;
the overtaken-read test, which cannot know whether its late viewer was sent
nothing or two events, captures a marker request on `a` after its flush and
judges each viewer's events before the marker's `request.received`
(`sentBefore`): a connection keeps its order, so once the marker has arrived
everything sent before it has too, an event one too many included. The
checks that nothing arrived — `delivered while the reads were held`, after a
rollback, a bystander — stay immediate after their flush, as D221 requires.
The first describe's tests already waited for each event through
`viewer.received`. The other tests that flush or watch were read for the
same shape, and none was changed: `listener.test.ts`, `hub.test.ts` and
`mcp.test.ts` assert what an in-process stand-in connection was handed,
which it records synchronously; `realtime.test.ts` waits through `received`
and `next`; `session-delete.test.ts` polls its socket with a deadline where
it waits for an event, and asserts at once only that nothing arrived; the
other realtime test files assert no viewer's events after a flush.

## F-16 — `is left as it is when the migration meets an existing role`

- **Test**: `apps/backend/src/db/stats-views.test.ts:498` at `5cf1bab`, when
  it failed; `:515` at `bcf1abc`, the base of the fix, and `:522` at the fix,
  `d57a0e0`. The same race fails the set-up of
  `apps/backend/src/db/usage-daily.test.ts` (`setUp`, `:108` at `bcf1abc`) and
  with it the whole file: never seen in a run, shown by the forced
  reproduction below. Issue #255.
- **Status**: fixed in the tests on `fix/serialise-role-migration-replays`, at
  `d57a0e0`. Migration `007` was not changed and was not at fault: production
  applies it once and never again.

### The failure

The Tester's first full run of `node scripts/db.mjs task-test 227` at
`5cf1bab` (MR !239, the scheduled delivery run of 2026-10-21 00:02 MSK),
against the task's own database `qa_tools_t227`: 2931 tests, 1 failed, this
one, with PostgreSQL's `tuple concurrently updated`, code `XX000`. The file
alone then passed, 17 of 17, and the full suite again, 2931 of 2931. The
branch under test touched neither the database code nor the migrations.

That run's output is not preserved. The same failure, as the test reported it
in the forced reproduction at `bcf1abc` (below), trimmed:

```text
✖ is left as it is when the migration meets an existing role (539.581875ms)
  error: tuple concurrently updated
      at async TestContext.<anonymous> (file:///…/apps/backend/src/db/stats-views.test.ts:525:7)
    severity: 'ERROR',
    code: 'XX000',
    file: 'heapam.c',
    line: '4312',
    routine: 'simple_heap_update'
```

### The mechanism

Role `qa_readonly` is cluster-wide, and one run of the backend suite, whose
files Node's runner starts in parallel, had three writers of it:

- this test, which in a transaction that is rolled back runs
  `ALTER ROLE qa_readonly LOGIN` and then all of `007`, whose three
  `ALTER ROLE` statements write the role's row in `pg_authid` (its attributes
  and `CONNECTION LIMIT 2`) and its row in `pg_db_role_setting` (the two
  `SET`s);
- `usage-daily.test.ts`'s set-up, which replays `007` in a scratch database
  of its own as one simple query, committed when it returns;
- the same set-up a second time, when `test-files-exit.test.ts` runs that file
  alone.

`ALTER ROLE` reads the role's row and updates it through
`simple_heap_update`. The catalogue's `RowExclusiveLock` does not conflict
with another writer's, so nothing orders two writers before they meet the
row: the second waits for the first's transaction — `wait_event`
`transactionid` in `pg_stat_activity`, blocked by the first's process — and
when that one commits it raises `tuple concurrently updated`, `XX000`
(`heapam.c` line 4312 in PostgreSQL 16.15), rather than reading the row
again; when that one rolls back, the waiter goes on. So this test failed
whenever one of its statements waited for a set-up's `007`, which commits; a
set-up could fail waiting for the other set-up's, never for this test's,
which rolls back. The statement that fails is the waiter's first that meets
the row the other is changing, which need not be one of `007`'s: the test's
own `ALTER ROLE qa_readonly LOGIN` comes first. The forced reproduction
confirmed the issue's inference from the code. An advisory lock is keyed by
the database it is taken in, so the lock that serialises the writers has to
live in the one database they share, the test database.

### The forced reproductions

Not committed: a script in the session's scratchpad, Node v24.19.0, on
2026-10-23, on the operator's Mac, against the task's database `qa_tools_t255`
(PostgreSQL 16.15). A second connection runs `BEGIN` and one `ALTER ROLE` and
holds it uncommitted; the test file runs alone; a third connection polls
`pg_stat_activity` every 50 ms for another backend waiting on a `Lock`, and
the second connection commits 500 ms after it is seen. With the fix the
second connection first takes the lock as `usage-daily.test.ts`'s set-up now
does, `SELECT pg_advisory_lock(255000000000000007)`, and unlocks it after its
commit. One run per cell, the test files those of `bcf1abc` and of `d57a0e0`:

```sh
node scripts/db.mjs task-test 255 -- --test-name-pattern="existing role" src/db/stats-views.test.ts
node scripts/db.mjs task-test 255 -- src/db/usage-daily.test.ts
```

| The second connection holds | Run | At `bcf1abc` | At `d57a0e0` |
| --- | --- | --- | --- |
| `ALTER ROLE qa_readonly CONNECTION LIMIT 2` | this test | waited on `transactionid` in `ALTER ROLE qa_readonly LOGIN` (`:525`) and failed at the commit with `tuple concurrently updated`, `XX000`, `simple_heap_update`: `ℹ tests 1`, `ℹ fail 1` | waited on `advisory` in `SELECT pg_advisory_xact_lock(255000000000000007)` and passed after the unlock: `ℹ tests 1`, `ℹ pass 1` |
| `ALTER ROLE qa_readonly SET statement_timeout = '5s'` | this test | waited on `transactionid` in the replay of `007` (`:527`) and failed the same way: `ℹ fail 1` | waited on `advisory` and passed: `ℹ pass 1` |
| `ALTER ROLE qa_readonly CONNECTION LIMIT 2` | `usage-daily.test.ts` | its set-up waited on `transactionid` in the replay of `007` (`:108`) and failed the same way, its 25 tests cancelled: `ℹ tests 25`, `ℹ pass 0`, `ℹ cancelled 25`, exit 1 | its set-up waited on `advisory` in `SELECT pg_advisory_lock(255000000000000007)`, then `ℹ tests 25`, `ℹ pass 25` |

`pg_stat_activity` shows a simple query whole, so which of `007`'s statements
waited is read from what the second connection held (inferred): in the second
row the first of them that writes `pg_db_role_setting`,
`ALTER ROLE qa_readonly SET default_transaction_read_only = on`; in the third
the first that writes `pg_authid`,
`ALTER ROLE qa_readonly NOSUPERUSER … CONNECTION LIMIT 2`.

### The measurement

Not a series: one failure was seen, in one full run, and a series would show
little at that rate. With the fix, on the operator's Mac, Node v24.19.0, on
2026-10-23, the three files that take part,

```sh
node scripts/db.mjs task-test 255 -- src/db/stats-views.test.ts src/db/usage-daily.test.ts src/test-files-exit.test.ts
```

passed 10 of 10 runs in a row, 0.0% (0.0%–27.8%), each `ℹ tests 151`,
`ℹ pass 151`, `ℹ fail 0`, about 11 s a run; after them `pg_locks` held the
lock in no session. The full suite, `node scripts/db.mjs task-test 255`, then
passed: `ℹ tests 3001`, `ℹ pass 3001`, `ℹ fail 0`. The two changed files
hold 43 tests at `bcf1abc` and at the fix, all passing. These show the lock
does not stall the files; what shows it removes the race is the forced
reproduction above.

### The fix

In the two test files only, `d57a0e0`. One advisory lock, key
`255000000000000007` — `ROLE_REPLAY_LOCK`, the same literal in both files,
above the 1 to 2^47 that `pool.test.ts`, the suite's only other advisory
lock, draws its keys from — taken in the test database. This test takes
`pg_advisory_xact_lock` as the first statement after its `BEGIN`, so it holds
nothing while it waits and keeps the lock until its `ROLLBACK`.
`usage-daily.test.ts`'s set-up takes `pg_advisory_lock` on a connection of its
own to the test database before it replays the migrations in its scratch
database and, in a `finally`, unlocks it and releases the connection, or ends
the connection if the unlock fails, which releases the lock as well. The
other statements of the suite that name the role change no row of it: the
`GRANT … TO qa_readonly` of `008` and `009`, and the replays of `008` and
`020` in the test database, change only that database's objects, and
`migrations.test.ts` runs migrations of its own from a temporary directory.
How the suite runs its files is unchanged.

## F-17 — `answers the sender normally when recording the outcome fails`

- **Test**: `apps/backend/src/modules/webhook/webhook.test.ts:3497` at
  `30c8679`, the base of the fix; `:3498` at the fix, `54effcd`. Issue #267.
- **Status**: fixed in the test on `fix/webhook-outcome-failure-test`, at
  `54effcd`. The product was not changed and was not at fault: a failure to
  record the outcome is caught and logged by `recordCompletion` and never
  changes the reply (D109).

### The failure

On #198's CI runner, `qa-tools-ci-firstvds`, beside another heavy job, the
`test` job failed on this test in 3 of 20 runs, 15.0% (5.2%–36.0%), as
#198's criterion 5 report of 2026-10-23 counted them: jobs 17400170786 and
17400282383 (MR !255) and 17402279081 (MR !260), none of which changed that
code. In 82 runs on GitLab's shared runners over 2026-10-20 to 2026-10-22 it
did not fail. Each time, in about 15 ms, after the reply's status, body,
`Content-Length` and request id had passed, at the
`assert.equal(record?.state, 'pending', …)` line, as the issue quotes it:

```text
AssertionError [ERR_ASSERTION]: the terminal write should have failed
  actual: 'sent'
  expected: 'pending'
```

### The mechanism

The test wrapped the pool in a `Proxy` that threw on a `query` call whose
text held `UPDATE request_responses`, the outcome's write. That write has not
gone through the pool's `query` since #132 (`77dcc2e`, 2026-10-10), which
moved it into a transaction on a client from `pool.connect()`, and #173's
`inTransaction` (`46291a2`, D221) kept it there. The `Proxy` handed out
`connect` unchanged, so the client's `query` was never wrapped, the injected
failure never happened, and the outcome was recorded `sent`. The test passed
while its read of the record, one statement on the pool, came back before the
fire-and-forget recording's `BEGIN`, `UPDATE`, event and `COMMIT` on another
connection; under load the recording sometimes won. Shown at `30c8679`, not
committed: with `await delay(300)` before that read the test failed,
`'sent' !== 'pending'`, in the one run made, through the mutations' command
below.

### The fix

In the test only, `54effcd`. The injection fails the outcome's `UPDATE` on the
pool's own `query` and on the `query` of every client the pool lends, a
`Proxy` over that client whose `release` stays the client's own, so the
client goes back to the pool after `inTransaction`'s `ROLLBACK`; it reads the
statement's text from a string or a query config, and counts each failure.
The receiver is built with a `PendingWrites` of the test's, whose `track`
hands the test the recording's write; the test waits for that write to
settle, at most 10 s, and only then reads the record. It asserts that the
injected failure was met exactly once and that the record is `pending`, and
the reply's checks are as they were.

### The mutations

Not committed, at `54effcd`, ten runs each of

```sh
node scripts/db.mjs task-test 267 -- --test-name-pattern="recording the outcome fails" src/modules/webhook/webhook.test.ts
```

| Mutation | Result |
| --- | --- |
| The `connect` wrapping removed, the injection the old test's | 10 of 10 failed at the count, `0 !== 1`, `the outcome write should have met the injected failure once` |
| No `UPDATE` failed, and the count's assertion removed | 10 of 10 failed at the read, `'sent' !== 'pending'`, `the terminal write should have failed` |

Neither outcome depends on timing: the record is read only once the recording
has ended.

### The measurement

Not a series before the fix: the CI failures above are the pre-fix rate, and
the forced reproduction shows the mechanism. With the fix, at `54effcd`, on
the operator's Mac (8 CPUs), Node v24.19.0, PostgreSQL 16.15, on 2026-10-23,
the file alone,

```sh
node scripts/db.mjs task-test 267 -- src/modules/webhook/webhook.test.ts
```

passed 30 of 30 runs in a row, 0.0% (0.0%–11.4%), each `ℹ tests 116`,
`ℹ pass 116`, `ℹ fail 0`: 20 beside the machine's other work, the 1-minute
load average 19 to 22, each run 10 to 12 s and this test 11 to 73 ms; then 10
beside six busy loops (`node -e 'for(;;){}'`) as well, the load average
rising to 58, each run 20 to 43 s and this test 36 to 326 ms. These show the
fix does not fail under load; what shows it no longer decides by a race is
the mutations above. The CI runner's next pipelines are the measurement under
the load that failed it.

## F-18 — `keeps at most 48 KiB and no body per wait: <shape>`

- **Test**: `apps/backend/src/modules/mcp/mcp-memory.test.ts:456` at
  `c4a1627`, the base of the fix, its assertion
  `assert.ok(held <= WAITS * PER_WAIT_BYTES, report)` at `:500`; `:586` at
  the fix, `ea69a26`, the assertion at `:628`, its `held` named `more`. One test for each of the
  twelve shapes of `SHAPES`, in the suite `a pending wait_for_request (D203)`.
  Issue #178.
- **Status**: changed in the test, the `429` mechanism fixed and the cause of
  the two CI readings open until a pipeline shows otherwise, on
  `fix/flaky-memory-431-tests`, at `ea69a26`,
  in three commits: `8d2dd1f`, `e5f3e5e` and `ea69a26`. The limit and every
  value the test guards are unchanged (D203). The cause of the two CI
  over-limit readings is not established: the warm round is the issue's
  inferred remedy, the 30 runs under load cannot tell the base from the fix
  for that reading, since its rate before the fix was never measured, and the
  per-space line in the report will name the space of the next failure.

### The failure

On CI, twice, each time on a branch that did not touch the MCP code, each
passing when run again with no change, as the issue records them:

- MR pipeline 2934961796 on GitLab's shared runners, during #163 (MR !164),
  on 2026-10-11: 50.7 KiB a call, the shape
  `duplicate name and arguments keys in params`;
- job 17398605181 on #198's runner, MR !251's pipeline 2978633591, on
  2026-10-22, beside `e2e` on the runner's 4 vCPU, the shape
  `duplicate keys at the top level`:

```text
16 pending waits: 0 bodies kept, 0.93 MiB more held, 59.6 KiB a call
```

The limit is 768 KiB for the sixteen waits; those runs held about 811 and
954 KiB, and kept no body. Locally a shape that waits holds 20 to 29 KiB a
call, about 390 KiB for the sixteen.

And a second failure, met in this fix's own load series (below), in 4 of
the 35 runs of `8d2dd1f` and `e5f3e5e`: a round's sixteen calls never all
became pending, and `pendingReach` ran out, in a round with large bodies each
time — at `8d2dd1f` in the warm round of
`some 70,000 distinct unknown keys at the top level, accepted`, its leftover
waits failing the next four tests' counts; at `e5f3e5e` in the measured round
of `duplicate keys at the top level` and the warm rounds of
`a _meta of 300,000 characters and some 70,000 objects` and
`some 70,000 distinct unknown keys in params, accepted`:

```text
✖ keeps at most 48 KiB and no body per wait: duplicate keys at the top level (20586.798458ms)
  AssertionError [ERR_ASSERTION]: waits pending after 20002 ms

  10 !== 16
```

`8 !== 16`, `14 !== 16` and `15 !== 16` the other three times. The base's
measured round has the same step and the same bound.

### The mechanism

- **The bytes over the limit.** Inferred, not reproduced. Each test warmed
  only the pool before its baseline: sixteen `list_requests` on its session,
  answered at once. The file's `before(warmUp)` had run sixteen small waits
  once, for the whole file. So the first time a shape's own body reached the
  server was after its baseline, and whatever its parsing and checks compile
  and keep for good — bytecode, feedback, optimised code, the hidden classes
  of what they build — was counted against its sixteen waits, with the
  collector's and the optimiser's timing, which load stretches. Measured
  since, not committed: three runs each of the file at `ea69a26` and of the
  same with its `warmShape` call removed, alternately, in the detached
  worktree below, without busy loops, on 2026-10-24 at 16:11–16:13, the
  1-minute load average falling from 83 to 59 with the other agents' work.
  Over the 27 readings of each, the shapes that wait, `code_space` grew by a
  mean of +14.3 KiB a shape without the warm round and +3.8 KiB with it,
  `trusted_space` by +10.8 and +4.4 KiB, `old_space` by +392.7 and
  +392.3 KiB, and both read 25.3 KiB a call on average: the warm round takes
  some 17 KiB off a shape's reading here, about 1 KiB a call. What the CI
  failures held above a usual reading, 400 to 560 KiB, is far more, and is
  not shown to be the same thing. A probe outside the suite, a plain loop of
  `JSON.parse` with the test's flags and collections, saw the heap grow 360
  to 400 KiB between two readings taken one after the other, early in its
  process (in 2 of 5 runs, at round 2 of 200) and never later: a one-time
  cost of that size exists in this Node, and the file's warm-ups, now each
  shape's too, run before any baseline. The total and the spaces' sum
  disagree at times as well — by about 370 KiB in one reading of those runs,
  2.2 KiB a call while its spaces grew 405 KiB — so the next failure's line
  tells whether a space moved or the total alone.
- **The waits that never waited.** Shown by the forced reproduction below.
  The process has eight places for large bodies (D205, D213): a body over
  128 KiB takes one on `onRequest`, before it is read, and `/mcp` gives it
  back once its message is read and checked, before the call waits; a ninth
  finding none is refused at once, `429` / `1017`, never queued. Sixteen
  bodies of 1,000,000 bytes sent at once stay within eight only while the
  server reads each as fast as they come; when the process is slow they
  overlap, and the calls refused never wait, so `pendingReach` counts 8 to
  15 of 16 until its bound. The `1017`s were not seen in the series: the test
  did not record what its calls answered. That it was they is inferred from
  the counts — `8 !== 16` the eight places exactly, and doubling the bound at
  `e5f3e5e` did not fill the others — and from the reproduction.
- **The failures that spread.** A round that failed before its answers had
  come left its waits pending: the measured round's `finally` cleared them
  but did not wait for their answers, and the warm round, new at `8d2dd1f`,
  had no `finally` at all, so the next test counted them. The base's measured
  round spreads its failures the same way.

### The forced reproduction

Not committed: in a detached worktree of `c4a1627` outside the task's
worktree, its `mcp-memory.test.ts` that of `ea69a26`, on 2026-10-24. A `preParsing`
hook added to the test's API server holds each `/mcp` body over 128 KiB for
500 ms once its place is taken, so a round's sixteen bodies overlap whatever
the load; and the test tallies its calls' answers and prints them when
`pendingReach` runs out. Nothing else changes, the client included. One run
each, the command below:

| The test's servers | Result |
| --- | --- |
| a place for each call of a round, as at `ea69a26` | `ℹ tests 13`, `ℹ pass 13` |
| the process's eight, as at the base: `largeBodyPlaces` removed | `ℹ tests 13`, `ℹ fail 9`: the eight shapes that wait with a large body, each in 12.2 to 12.7 s, and `some 70,000 distinct unknown keys in arguments, refused`, answered `429` rather than refused for its arguments; the first: `answered so far: 71 x 200 / 8 x 429 {"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Too many large bodies are being saved; try again in a moment","data":{"errorCode":1017,"retryAfter":1}}}` |

A second check, the same way: `warmShape`'s `pendingReach` replaced by
`assert.fail`, so that every warm round of a shape that waits fails before its
waits are pending. At `ea69a26` those nine tests fail, each within 1 s, and the
three answered at once after them pass, `ℹ fail 9`, `ℹ pass 4`: a failure no
longer spreads.

### The mutations

Not committed, in the same worktree, its `mcp-memory.test.ts` that of
`ea69a26`, on 2026-10-24, one run each of

```sh
node scripts/db.mjs task-test 178 -- src/modules/mcp/mcp-memory.test.ts
```

| Mutation | Result |
| --- | --- |
| A wait keeps an extra 64 KiB buffer: `PendingWaits.add` keeps a `Buffer.alloc(64 * 1024)` for each wait until its `delete` | `ℹ tests 13`, `ℹ fail 9`: every shape that waits, 87.1 to 91.4 KiB a call, no body kept; the three answered at once and the strings' test pass, as nothing of theirs waits |
| The test holds a strong reference to each body: its `preHandler` hook keeps `request.body` in an array beside the `WeakRef` | `ℹ tests 13`, `ℹ fail 10`: every shape that waits, `16 bodies kept`, 28.2 KiB a call for the plain body and 1,001 to 1,004 KiB for the others; and `some 70,000 distinct unknown keys in arguments, refused`, `16 bodies kept` |
| The test's `post` keeps the text it sent until its answer has ended, a closure over `body` | `ℹ tests 13`, `ℹ fail 8`: the eight shapes that wait with a body of 1,000,000 bytes, 1,001 to 1,979 KiB a call, no body kept on the server; the plain body of under 500 bytes passes |

### The measurement

Three series of one shell script from the task's worktree, Node v24.19.0,
PostgreSQL 16.15, on the operator's Mac, an Apple M1 Pro with 8 CPUs and
16 GB, beside the other tasks of the delivery cycle, on 2026-10-24 (UTC+3).
F-06's load, every PID recorded and stopped by it at the end: eight
`node -e` busy loops, one per CPU, for the whole series, the first beside
F-19's series as well. One fresh run per line, no retries, no run repeated,
the command above. The 1-minute load average, sampled every 30 s, includes
the other agents' work.

| Series | Commit | Time | 1-minute load average | Runs | Failed | Rate (Wilson 95%) |
| --- | --- | --- | --- | --- | --- | --- |
| first, beside F-19's | `8d2dd1f` | 15:51–15:55 | 17 before; 53 to 147 during | 9 | 1, `8 !== 16` | 11.1% (2.0%–43.5%) |
| second | `e5f3e5e` | 15:57–16:04 | 106 at its start; up to 174 during | 26 | 3, `10 !== 16`, `14 !== 16` and `15 !== 16` | 11.5% (4.0%–29.0%) |
| third | `ea69a26` | 16:04–16:11 | 83 at its start; 83 to 139 during | 30 | 0 | 0.0% (0.0%–11.4%) |

The first two series were stopped once a failure had shown what to fix,
their in-flight runs left to finish; no run failed the 48 KiB limit. The
third passed 30 of 30 in a row, each `ℹ tests 13`, `ℹ pass 13`,
`ℹ fail 0`, each run 11 to 22 s; its 270 readings of a shape that waits were
20.4 to 28.7 KiB a call. These show the fix does not fail under
load; what shows the refusals no longer reach it is the forced reproduction
above.

One local run's lines, at `ea69a26`, the first of the comparison's above,
without busy loops, the 1-minute load average 83:

```text
✔ keeps at most 48 KiB and no body per wait: a plain body of under 500 bytes, for reference (185.064958ms)
ℹ 16 pending waits: 0 bodies kept, 0.38 MiB more held, 24.1 KiB a call; new_space -0.4 KiB, old_space +388.9 KiB, code_space -1.4 KiB, trusted_space -4.8 KiB, array buffers +0.0 KiB
✔ keeps at most 48 KiB and no body per wait: white space between the members (236.25425ms)
ℹ 16 pending waits: 0 bodies kept, 0.42 MiB more held, 26.6 KiB a call; new_space -0.4 KiB, old_space +388.1 KiB, code_space -45.2 KiB, trusted_space +8.2 KiB, array buffers +0.0 KiB
✔ keeps at most 48 KiB and no body per wait: about 99,000 duplicate wait keys in arguments (445.00475ms)
ℹ 16 pending waits: 0 bodies kept, 0.43 MiB more held, 27.2 KiB a call; old_space +393.4 KiB, code_space +22.1 KiB, trusted_space +20.3 KiB, array buffers +0.0 KiB
✔ keeps at most 48 KiB and no body per wait: duplicate name and arguments keys in params (302.59275ms)
ℹ 16 pending waits: 0 bodies kept, 0.39 MiB more held, 25.0 KiB a call; old_space +387.1 KiB, code_space +4.2 KiB, trusted_space +8.1 KiB, array buffers +0.0 KiB
✔ keeps at most 48 KiB and no body per wait: duplicate keys at the top level (354.452584ms)
ℹ 16 pending waits: 0 bodies kept, 0.38 MiB more held, 24.6 KiB a call; new_space -1.2 KiB, old_space +385.6 KiB, code_space +3.7 KiB, trusted_space +2.8 KiB, array buffers +0.0 KiB
✔ keeps at most 48 KiB and no body per wait: a _meta of 300,000 characters and some 70,000 objects (365.421834ms)
ℹ 16 pending waits: 0 bodies kept, 0.37 MiB more held, 23.9 KiB a call; new_space -0.3 KiB, old_space +388.7 KiB, code_space -2.9 KiB, trusted_space -3.3 KiB, array buffers +0.0 KiB
✔ keeps at most 48 KiB and no body per wait: some 70,000 distinct unknown keys in params, accepted (1022.992417ms)
ℹ 16 pending waits: 0 bodies kept, 0.39 MiB more held, 24.7 KiB a call; old_space +392.2 KiB, code_space +1.7 KiB, trusted_space +1.8 KiB, array buffers +0.0 KiB
✔ keeps at most 48 KiB and no body per wait: some 70,000 distinct unknown keys at the top level, accepted (939.442666ms)
ℹ 16 pending waits: 0 bodies kept, 0.37 MiB more held, 23.8 KiB a call; old_space +392.1 KiB, code_space -3.6 KiB, trusted_space -7.5 KiB, array buffers +0.0 KiB
✔ keeps at most 48 KiB and no body per wait: ids of 256 two-byte characters, padded with white space (405.720417ms)
ℹ 16 pending waits: 0 bodies kept, 0.41 MiB more held, 26.5 KiB a call; old_space +407.6 KiB, code_space +7.8 KiB, trusted_space +8.5 KiB, array buffers +0.0 KiB
✔ keeps at most 48 KiB and no body per wait: a query string of 15,000 characters, refused before the body (91.490916ms)
ℹ 16 refused calls: 0 bodies kept, 0.05 MiB more held, 3.0 KiB a call; old_space -15.9 KiB, array buffers +64.0 KiB
✔ keeps at most 48 KiB and no body per wait: a query string of 3,000 duplicate keys, refused before the body (70.334916ms)
ℹ 16 refused calls: 0 bodies kept, 0.05 MiB more held, 3.4 KiB a call; old_space -9.9 KiB, array buffers +64.0 KiB
✔ keeps at most 48 KiB and no body per wait: some 70,000 distinct unknown keys in arguments, refused (1176.396791ms)
ℹ 16 refused calls: 0 bodies kept, 0.01 MiB more held, 0.6 KiB a call; old_space -4.6 KiB, code_space +3.8 KiB, trusted_space +10.7 KiB, array buffers +0.0 KiB
```

### The fix

In the test only. Before its baseline each shape makes one round of its own
calls, `warmShape`: sixteen calls of the shape on a session of its own, with
ids of the same length, made pending and cleared, or answered at once for
the shapes refused, and checked as the measured round's are; then, as
before, its own session, the pool's sixteen `list_requests`, the baseline,
the measured round. The report adds the growth of each heap space that moved,
from `v8.getHeapSpaceStatistics`, and of the memory behind buffers, so that
the next failure names where the bytes went. The test's servers have a place
among the large bodies for each call of a round, `createLargeBodyPlaces(WAITS)`,
beside the rate limits the file already puts out of reach: each call gives
its place back before it waits, so none is held when anything is measured.
Both rounds end in a `finally` that clears what waits and awaits every
answer, so a failure stays in its test. `pendingReach` keeps the base's bound,
1000 tries of 10 ms, its messages naming the time waited; `e5f3e5e` had
raised it to 20 s on the reading that the bodies were slow, which the forced
reproduction disproved, and `ea69a26` put it back.

`PER_WAIT_BYTES` stays 48 KiB, `WAITS` 16, `BODY_BYTES` 1,000,000 and
`PER_STRING_BYTES` 16 KiB; every shape, the `kept === 0` check and the
query-string shapes' no-body and no-wait checks stay. The fallback the issue
named, the cost of a wait as the difference between N and 2N waits, was not
needed.

## F-19 — `answers 100 header lines and refuses 101 with 431 before any route, taking no place`

- **Test**: `apps/backend/src/modules/limits/calls-in-flight-routes.test.ts:1250`
  at `c4a1627`, the base of the fix, its helper `withLines` at `:1227`;
  `:1282` and `:1238` at the fix, `8d2dd1f`. Issue #178.
- **Status**: fixed in the test on `fix/flaky-memory-431-tests`, at `8d2dd1f`.
  The server was not changed: its `431` and the moment it decides it are as
  D213 and D143 pin them. That a client whose oversized head spans more than
  one packet can meet a reset instead of the `431` is the server's own
  question, left out of #178 (below).

### The failure

In a local `node scripts/db.mjs task-test 163` on 2026-10-11, during the
delivery of #163 (MR !164), which did not touch the listener, and once more
with the file alone; it then passed three times. As the issue records it,
`read ECONNRESET`. That output is not preserved; the forced reproduction
below fails the same way at the base helper:

```text
✖ base helper, forced, 2500 lines (119.943583ms)
  Error: read ECONNRESET
    errno: -54,
    syscall: 'read'
```

### The mechanism

- **Where the parser refuses.** The listener sets `maxHeadersCount` to 100
  (D213), and Node's parser refuses a head at the start of its header line
  101, before that line has ended: a probe in the session's scratchpad, not
  committed, a plain `node:http` server with `maxHeadersCount` 100 on Node
  v24.19.0, met `HPE_HEADER_OVERFLOW` with `bytesParsed` 952 for a head sent
  through line 101, with or without that line's `CRLF`, and answered nothing
  for one sent through line 100. Fastify's `clientError` handler then writes
  the `431` and destroys the socket.
- **What the helper sent.** `withLines` wrote the whole head in one
  `socket.write`: 960 bytes for 100 lines and 970 for 101 on `/healthz`, but
  26,461 for 2,500. A head that large can reach the server in more than one
  read; once the read holding line 101 has been parsed the server answers and
  closes while the rest is still arriving, and a connection closed with data
  unread, or sent data once closed, is reset. Then the client's next read
  fails, `read ECONNRESET`, and may lose the answer with it, as F-01's did.
- **Why the test failed on it.** The helper waited with
  `await once(socket, 'close')`, which rejects on the socket's `error` even
  with the no-op `error` listener beside it: a reset failed the test whether
  or not the `431` had been read.

Inferred from the code and the probe; the forced reproduction below shows the
last two steps. The two short heads are read whole at once on loopback and
were not seen to fail.

### The forced reproduction

Not committed: a `describe` block added for the run to a copy of the fix's
file in a detached worktree of `c4a1627`, outside the task's worktree, on
2026-10-24, on the operator's Mac, Node v24.19.0. It holds two helpers, run
on a `/healthz` head of 2,500 lines and one of 102, each on a listener of its
own:

- the base helper as it was, its one write replaced by the head in two
  chunks: through line 101, then a pause until the listener's server has
  emitted `clientError` — Fastify's handler has written the `431` and
  destroyed the socket by then — and then the rest in one write. The pause is
  an event, not a timer, so the server has always answered and closed before
  the rest is sent;
- the new helper, after the same pause, its rest written in 1 KiB writes.

```sh
node scripts/db.mjs task-test 178 -- --test-name-pattern="dev178 forced" src/modules/limits/calls-in-flight-routes.test.ts
```

Ten runs in a row: each `ℹ tests 4`, `ℹ pass 2`, `ℹ fail 2`, the base
helper failing both heads with `read ECONNRESET`, 20 of 20, and the new one
passing both with the pinned `431` bytes, 20 of 20. One run before them,
with the base helper's rest in 1 KiB writes as well, failed the 2,500-line
head with `write ECONNRESET` and the 102-line one with `read ECONNRESET`.

### The measurement

Not a series before the fix: one failure in one full run and one with the
file alone, as the issue records them; the forced reproduction above shows
the mechanism. With the fix, at `8d2dd1f`, whose file is the fix's, on the
operator's Mac, an Apple M1 Pro with 8 CPUs, Node v24.19.0, PostgreSQL 16.15,
on 2026-10-24 from 15:51 to 15:57 (UTC+3), the file alone,

```sh
node scripts/db.mjs task-test 178 -- src/modules/limits/calls-in-flight-routes.test.ts
```

passed 30 of 30 runs in a row, 0.0% (0.0%–11.4%), each `ℹ tests 20`,
`ℹ pass 20`, `ℹ fail 0`, each run 8 to 19 s and this test 22 to 326 ms.
F-06's load: eight `node -e` busy loops, one per CPU, started by one shell
script that recorded each PID and stopped them by it at the end, and for its
first 13 runs F-18's series of `mcp-memory.test.ts` beside it. The 1-minute
load average, sampled every 30 s, includes the other agents' work: 17 before,
53 to 147 during. These show the fix does not fail under load; what shows
the reset can no longer fail it is the forced reproduction above.

### The fix

In the test only, `8d2dd1f`. `withLines` writes a head of more than 101
lines in two parts: through line 101, where the parser refuses it, and the
rest only once the server has ended its side, the answer read whole — on a
half-open socket, so that the rest can still be written then — or not at all
if the connection has closed first. The server has then read all it was sent
when it closes, so its close is a clean one and the `431` arrives before
anything can reset the connection; the rest meets a closed connection, and
its `EPIPE` or `ECONNRESET` is expected. The helper resolves on `close` with
what it read and rejects only on another socket error, as F-01's reader does.
A head of 100 or 101 lines is still written whole: the 101 is a whole head
the server refuses. The assertions are unchanged: `200` for 100 lines on both
paths, the exact `431` bytes for 101, `HTTP/1.1 431 ` for 2,500, and no place
held afterwards. Read-side tolerance alone was not enough in F-01, which lost
its answer in 3 of 120 runs that way: what changed here is what is still
arriving when the server closes.

### Watched, and left

The server's side of the same race: a client whose oversized head reaches
the API or the receive listener in more than one packet can meet a reset
instead of the `431`, in production probably a `502` through Traefik
(inferred). A change to the listener in the shape of #12 and D143, out of
#178's scope; not filed by this entry.

## F-20 — `sends a capture’s step before the requests.cleared of a clear after it` and its MCP `clear_requests` sibling

- **Test**: `apps/backend/src/modules/realtime/realtime.test.ts:1348`
  (`sends a capture’s step before the requests.cleared of a clear after it,
  which deletes its request`) and `:1397` (`… of an MCP clear_requests
  after it, which deletes its request`) at `81238d8`, the base of the fix;
  `:1409` and `:1458` at the fix, `399e36b`, each renamed `… after it, or
  has the viewer reload, and the clear deletes its request`. Issue #279.
- **Status**: fixed in the test on `fix/realtime-clear-race-tests`, at
  `399e36b`. The listener was not changed: closing the viewer `1013` when a
  clear has purged a `request.received` it was to deliver is D221 point 8's
  documented reaction, which the tests did not expect.

### The failure

During the delivery of #207 (MR !274), on 2026-10-24, CI's `test` job
failed on `22ecf43` and on `88fdc1c` (pipelines 2984430369 and 2984798516)
at these two tests. The Tester then ran the file alone 10 times on #207's
head and 10 times on main `fc5c044`: all 20 runs failed, the route's test in
9 and 10 of them, the MCP test in 9 and 9, the 1-minute load average 17 to
24. In most full-suite runs the two passed. As it fails at the base of the
fix:

```text
✖ sends a capture’s step before the requests.cleared of a clear after it, which deletes its request (369.615625ms)
  Error: The connection closed while waiting for an event
      at check (file:///…/apps/backend/src/testing/realtime.ts:167:20)
```

### The mechanism

- **What the tests do.** Capture A commits on a pair of listeners whose
  pool holds back the answer to its `COMMIT`; the clear is made then, and
  waits in the session's line (`RealtimeHub.inOrder`, D205 point 12); A is
  let go after `HELD_MS`. A's turn ends once its commit has answered and it
  has poked the pair's listener (`committed`), and the clear's turn starts
  at once: one transaction deletes the requests, purges the payloads of
  their events (`forgetEvents`) and appends `requests.cleared`.
- **The race.** The poke reads at the end of a window of `COALESCE_MS`,
  20 ms, since #260 (`995fbeb`, 2026-10-23); a tick reads once a second,
  which may fall while A's answer is held. When the clear commits before
  the read has fetched A's payload, the fetch finds it purged, and the
  listener closes the viewer `1013` (`RealtimeHub.reload`, D221 point 8)
  and sends it nothing more. The tests' `watcher.next()` rejected on that
  close.
- **Where the reloads came from.** A probe, not committed: the fix's
  listener writing to stderr the kinds each reload's read held, 5 runs of
  the file alone. 9 reloads: 7 in a read holding both A's
  `request.received` and the clear's `requests.cleared`, 2 in a read
  holding only A's, the clear having committed between the read and its
  fetch.
- **The window.** The pair's listener built with `coalesceMs: 0`, reading
  at once as before #260, in the fix's test: 5 runs of 5 passed, and the
  viewer was sent the step in both tests in every run, 10 of 10. With the
  20 ms window the clear overtakes the read in most runs, as the issue
  inferred.

### The forced reproductions and mutations

Not committed. Each change was applied to the fix's code in the task's
worktree, at an earlier, unpushed version of `399e36b` whose test differs
from it in one line of a comment, and restored from Git after; the file run alone, on 2026-10-25:

```sh
node scripts/db.mjs task-test 279 -- src/modules/realtime/realtime.test.ts
```

| The change | Runs | What the two tests did |
| --- | --- | --- |
| The listener skips a purged `request.received` instead of reloading, as before D221's correction round 4 | 3, each failed | 5 of 6 failed, the viewer's first event `requests.cleared` where the step was expected; the sixth was sent the step |
| `RELOAD_CLOSE_CODE` 1011 instead of 1013 | 3, each failed | 5 of 6 failed, `actual: 1011, expected: 1013`; the sixth was sent the step |
| The listener delivers each read in reverse id order | 3, each failed, 31 to 33 of 42 passing | the MCP test failed 3 of 3, `requests.cleared` first; the route's passed 3, sent the step twice and reloaded once, from a read without the clear's row: in one holding both, the reversal sends `requests.cleared` first |
| Both clears made outside the session's line, `clearRequests` called directly | 3, each failed | 6 of 6 failed, `the clear did not wait in the line for capture A`, `actual: true`; `makes a clear on the same pair wait …` failed with them |
| The pair's listener with `coalesceMs: 0` | 5, each passed | 10 of 10 sent the step, then `requests.cleared` |

The first four are the mutations: a reload skipped, a wrong close code,
events out of order and a clear out of the line each fail the fixed tests,
the last at once and every time; the first three when the race goes the
reload's way, which it does in most runs.

### The measurement

On the operator's Mac, an Apple M1 Pro with 8 CPUs, Node v24.19.0,
PostgreSQL 16 (the `qa-tools-postgres` image), the task's own database, the
1-minute load average 17 to 28 with the other agents' work, the file alone
with the command above, every run a fresh process and none retried:

| Commit | When (UTC+3) | Runs | Failed | Rate (Wilson 95%) |
| --- | --- | --- | --- | --- |
| `81238d8`, the base | 2026-10-25 10:38–10:41 | 11 | 11 | 100.0% (74.1%–100.0%) |
| `399e36b`, the fix | 2026-10-25 10:53–10:55 | 10 | 0 | 0.0% (0.0%–27.8%) |

At the base the route's test failed 9 of 11, 81.8% (52.3%–94.9%), and the
MCP test 10 of 11, 90.9% (62.3%–98.4%), every time with `The connection
closed while waiting for an event`. At the fix every run was `ℹ tests 42`,
`ℹ pass 42`, `ℹ fail 0`; of the 20 outcomes 16 were the reload and 4 the
step, the route's test 3 of 10 and the MCP test 1 of 10. An earlier,
unpushed version of `399e36b`, the same assertions before a comment was
reworded, passed 11 runs of 11, the
step 1 of 22.

### The fix

In `realtime.test.ts` only, `399e36b`. Each test accepts exactly one of the
two outcomes D205 point 12 and D221 point 8 allow, through
`heardOfClearAfterCapture`: the viewer's first event is A's step, `1 of 2`,
and the next `requests.cleared`; or it is sent nothing and closed `1013`.
Anything else fails: `requests.cleared` first or without the step, another
event, another close code, nothing within `next`'s 10 s. A `t.diagnostic`
line names the outcome of each run. Two checks were added that hold either
way: `captureThen` reports whether the later call answered while A's commit
was held, and the clear must not have, since its turn of the line follows
A's — deterministic, where the old order assertion caught a clear out of
the line only through the race; and after the clear the session holds no
request and its queue reads `next` 1 again. Ordering the race instead,
holding the clear until the viewer had A's step, was not chosen: the order
asserted would then be the test's own.

### Watched, and left

With the 20 ms window, the cost D221 point 8 accepts, a viewer reloading
because a clear overtook a read, can fall on any clear made within about
20 ms of a capture of the same session — in this test, most of them — such
as an automated client's that sends a webhook and clears at once; the
reload loses nothing. Inferred from the mechanism, not measured outside the
test. Not filed by this entry.

## F-21 — `timed out waiting until 128 waits are pending`, the setup of four tests of `calls-in-flight-routes.test.ts`

- **Test**: four tests of
  `apps/backend/src/modules/limits/calls-in-flight-routes.test.ts`, at
  `8bb1443`, the base of the fix, whose file is that of `eec3e7b`, `6711da5`
  and `bbc5644`, and at the fix, `11fc084`:
  - `holds 128 waits and refuses the 129th call on the API and on /mcp, 429 / 1019 with Retry-After: 1`,
    `:404` at the base, `:479` at the fix;
  - `refuses a 129th /mcp call with a query string 429 / 1019 before its 400, and 403 for a foreign Origin`,
    `:451` and `:525`;
  - `refuses the 129th at once on a connection that closes with its declared body unfinished, never draining it`,
    `:633` and `:706`;
  - `ends 140 refusals with stalled bodies after 128 calls held, kept alive: the connections are back at 128 within a second`,
    F-10's test, `:1634` and `:1706`.

  At the base each waited for its 128 waits with
  `until(() => places.takenBy(A) === 128 && waits.size === 128, '128 waits are pending')`,
  at `:411`, `:458`, `:638` and `:1649`, `until` at `:308`; at the fix through
  `holdWaits`, at `:346`. Issue #276.
- **Status**: fixed in the test on `fix/calls-in-flight-setup-bound`, at
  `11fc084`. The server was not changed: the D244 gate and its three slots,
  `PendingWaits` and every limit are as they were, and so are the 128, the
  four tests' names and assertions, and the bounds they are named for.

### The failure

In the Tester's runs of the delivery of #178 (MR !279) on 2026-10-24, on the
operator's Mac, beside the other tasks of the delivery cycle, as the issue
records them: full runs of the suite at `bbc5644`,

```sh
node scripts/db.mjs task-test 178
```

failed `:633` in two of three runs, 66.7% (20.8%–93.9%), and `:404` and
`:451` in one of them; the file alone at `6711da5`,

```sh
node scripts/db.mjs task-test 178 -- src/modules/limits/calls-in-flight-routes.test.ts
```

failed `:633` once in 30 runs, 3.3% (0.6%–16.7%), in run 23, after 5333 ms,
under eight busy loops at a 1-minute load average of about 180, and then
passed alone at once, `ℹ tests 20`, `ℹ pass 20`, the test in 161 ms. MR
!279's finding F1 lists the three tests under one message; only `:633`'s
output was quoted, and it is not preserved in GitLab:

```text
AssertionError: timed out waiting until 128 waits are pending
```

As it fails at the base in the forced reproduction below:

```text
✖ refuses the 129th at once on a connection that closes with its declared body unfinished, never draining it (5164.356666ms)
  AssertionError [ERR_ASSERTION]: timed out waiting until 128 waits are pending
      at until (file:///…/apps/backend/src/modules/limits/calls-in-flight-routes.test.ts:312:12)
      at async TestContext.<anonymous> (file:///…/apps/backend/src/modules/limits/calls-in-flight-routes.test.ts:638:5)
```

`:1634` has the same setup and the same bound and was not seen failing.

### The mechanism

- **What the setup waits for.** Each test opens 128 waits from one address
  at once, each `?wait=30` on a connection of its own, and goes on once the
  address holds 128 places and `PendingWaits` holds 128 waits. A place is
  taken on `onRequest`, before any database work; a wait is added to
  `PendingWaits` only after its call's access check.
- **The gate.** `listen()` passes no `apiWorkSlots`, so the test's server
  has the production gate of three slots (D244, `createApiWorkSlots()` in
  `limits/api-work.ts`). `waitForRequests` (`requests/service.ts`) runs
  `requireAccess`, one statement, in its call's slot; `waitForList`
  (`requests/wait.ts`) then adds the wait and makes its first read in the
  same slot before letting it go. The 128th wait is added only after at
  least 125 of the 127 before it have finished their access check and first
  read, three at a time: about 43 rounds of two statements, some 85 database round trips one
  after the other, each of which load stretches. The 5 s bound came with
  `fb9cd0c` (2026-10-09), the gate with #213's `3b8cd72`.
- **Shown, not only inferred.** The forced reproduction below delays each
  statement of the test server's pool by 100 ms: the setup then takes 8.9 to
  9.2 s with the three slots, about 128 / 3 × 2 × 100 ms, and 125 to 160 ms
  with 128 slots, about one statement's delay. That load reaches the same
  setup the same way is inferred, from the failures above and from the
  setup's times in the measurement below, which the fix's diagnostic line
  records: 92 to 173 ms without busy loops, up to 1.2 s for the file alone
  under them, and up to 4,748 ms in the full suite under them.
- **The other mechanism the issue named**, calls ending before they are
  pending — for example `ECONNRESET` from the Mac's listen queue of 128
  connections (D213 point 8) — was not met: the fix's setup fails at once
  on any call that ends and names its status or error code, and in the
  series below none did.

### The forced reproduction

Not committed: in a detached worktree of `8bb1443` outside the task's
worktree, with its own `npm ci`, on 2026-10-25, on the operator's Mac, an
Apple M1 Pro with 8 CPUs, Node v24.19.0, against the task's own database
(D216). The four tests' `listen()` was given a pool, `listen({ database })`,
that waits `DEV276_DELAY_MS`, 100 ms, before each `query` and `connect` and
then hands it to the file's pool, as the file's `gatedPool` wraps them; the
realtime listener and the file's own clean-up kept the plain pool. Nothing
else changed, the client included. Ten runs of each file, one fresh process
each, no retries:

```sh
DEV276_DELAY_MS=100 node scripts/db.mjs task-test 276 -- \
  --test-name-pattern='holds 128 waits|refuses a 129th /mcp call with a query string|refuses the 129th at once|ends 140 refusals' \
  src/modules/limits/calls-in-flight-routes.test.ts
```

| Test file | When (UTC+3) | 1-minute load average | Runs | Result |
| --- | --- | --- | --- | --- |
| the base's, `until`'s 5 s | 15:11–15:15 | 14 to 25 | 10 | each `ℹ tests 4`, `ℹ fail 4`: 40 of 40 tests failed, 100.0% (91.2%–100.0%), each `timed out waiting until 128 waits are pending` after 5.12 to 5.36 s |
| the fix's, `holdWaits` | 15:15–15:22 | 17 to 32 | 10 | each `ℹ tests 4`, `ℹ pass 4`: 40 of 40 passed, 0.0% (0.0%–8.8%) failed; the setup 8,935 to 9,186 ms, each test 9.4 to 10.6 s |
| the fix's, the server given `createApiWorkSlots(128)` | 15:22 | 25 | 2 | each `ℹ pass 4`; the setup 125 to 160 ms |

The fix's file there was `11fc084`'s but for one comment's line wrap; the
third row is a probe of the gate's part, not a change the fix makes.

### The mutations

Not committed, in the same worktree, its test file that of `11fc084`, each
change restored from Git after, one run each on 2026-10-25 from 15:22 to
15:24 (UTC+3), the command above without the delay:

| Mutation | Result |
| --- | --- |
| a. `createCallPlaces`'s default limit `MAX_CALLS_IN_FLIGHT - 1` | `ℹ tests 4`, `ℹ fail 4`, each test in 64 to 182 ms, in its setup, 40 to 50 ms after the waits were opened: `a call ended before 128 waits were pending: 127 places held by A, 46 waits pending, 1 of 128 calls ended (1 x 429 / 1019), after 50 ms`, the others with 23 to 51 waits pending |
| b. The default limit `MAX_CALLS_IN_FLIGHT + 1` | `ℹ tests 4`, `ℹ fail 4`, each setup passing in 81 to 100 ms: `:479` at `:487`, its `GET` answered `200` with the session; `:525` at `:537`, `POST /mcp?x` answered `400` `Bad Request: this endpoint takes no query string`; `:706` at `:723`, `the API: not answered within 1000 ms`, the test in 1.10 s; and `:1706` in 5.11 s, `timed out waiting until answer 0 is read`, its first stalled call holding the 129th place and waiting for its body |
| c. `PendingWaits.add` keeps nothing, its `this.#waits.add(runOut)` removed | `ℹ tests 4`, `ℹ fail 4`, each test in 20.03 to 20.10 s, within the suite's 120 s: `timed out waiting until 128 waits are pending: 128 places held by A, 0 waits pending, 0 of 128 calls ended, after 20000 ms` |

### The measurement

Not a series before the fix: the failures above are the issue's, and the
forced reproduction shows the mechanism. With the fix, one shell script from
the task's worktree at `11fc084`, on the operator's Mac, an Apple M1 Pro with
8 CPUs, Node v24.19.0, the task's own database, beside the other tasks of
the delivery cycle, on 2026-10-25 from 15:27 to 15:49 (UTC+3). F-06's load:
eight `node -e 'for(;;){}'`, one per CPU, started by the script, each PID
recorded and stopped by it at the end, for the whole series. Every run a
fresh process, none retried, none repeated. The 1-minute load average,
sampled every 30 s, includes the other agents' work: 38.6 before, 63.8 to
128.2 during the file's runs and 123.8 to 204.5 during the full ones.

The file alone, 30 runs in a row from 15:27 to 15:32:

```sh
node scripts/db.mjs task-test 276 -- src/modules/limits/calls-in-flight-routes.test.ts
```

passed 30 of 30, 0.0% (0.0%–11.4%), each `ℹ tests 20`, `ℹ pass 20`,
`ℹ fail 0`, each run 7.2 to 10.9 s; the four tests 233 to 1,644 ms, their
setup 110 to 1,199 ms in its 120 readings.

The full suite, 3 runs from 15:32 to 15:49:

```sh
node scripts/db.mjs task-test 276
```

| Run | Time | Result | The four tests | Their setup |
| --- | --- | --- | --- | --- |
| 1 | 337 s | `ℹ tests 3289`, `ℹ pass 3281`, `ℹ fail 8` | passed, 2.5 to 5.5 s | 1,921 to 4,748 ms |
| 2 | 344 s | `ℹ tests 3289`, `ℹ pass 3281`, `ℹ fail 7`, `ℹ cancelled 1` | passed, 2.1 to 4.9 s | 1,593 to 3,608 ms |
| 3 | 348 s | `ℹ tests 3289`, `ℹ pass 3281`, `ℹ fail 7`, `ℹ cancelled 1` | passed, 2.0 to 5.2 s | 1,523 to 4,059 ms |

None of the four failed in the three, 0 of 12, where the base failed `:633`
in two of three such runs; the failures were other timing-bound tests, below
under "Watched, and left". In the full runs the setup took up to 4,748 ms,
within 252 ms of the base's 5 s, while the file alone never needed more than
1.2 s: the full suite's other work stretches the setup, as the base's
failures there suggested.

Without busy loops, at a 1-minute load average of 19.7 to 39.5 from the
other agents' work, on 2026-10-25 from 15:24 to 15:27, one full run each:
`8bb1443`, the base, in the worktree above, `ℹ tests 3289`, `ℹ pass 3289`,
`ℹ fail 0`; `11fc084`, `ℹ tests 3289`, `ℹ pass 3289`, `ℹ fail 0`, the setup
92 to 173 ms.

### The fix

In the test only, `11fc084`. The four tests open their 128 waits through
one helper, `holdWaits`, as before: 128 at once, each on a connection of its
own, `?wait=30`. It then waits until `places.takenBy(A) === 128 &&
waits.size === 128`, polling every 5 ms as `until` does, with three changes:

- the bound is 20 s instead of `until`'s 5 s, as `pipelining.test.ts` and
  `header-lines-bound.test.ts` bound theirs; well under the waits' own 30 s
  (D200), so all 128 are still pending when the test goes on;
- it fails at once when one of the 128 calls ends before all are pending,
  answered or failed: nothing in the setup ends a wait, so that is a defect
  or a flake of another kind, never load;
- its failure names what it read: the places `A` holds, the waits pending,
  and how many of the 128 calls have ended, with the status and error code
  of each answer or the client's error code, and the time waited.

A diagnostic line, `128 waits pending after <ms> ms`, gives the setup's time
on every run, so a slow setup shows before it fails. `until` keeps its 5 s for
every other wait in the file, `'80 are answered at once'` included; the 128,
the four tests' names and assertions, `answeredWithin(…, 1_000)` in `:706`
and F-10's 1 s loop over the connection count in `:1706` are unchanged.

### Watched, and left

The failures of the three full runs under load, each recorded and none
fixed here; issue #276 left them out of scope:

- `src/modules/webhook/pipelining.test.ts`, in every run, in both of its
  D229 suites, PROXY protocol off and v2: `has at most 32 requests read and
  unanswered, and gets all 300 of its GETs answered in order` (`:729`),
  `timed out waiting until all 300 are answered`, twice a run; `holds at
  most the bound for a client that reads none of its answers, and delivers
  them all once it reads` (`:862`), `timed out waiting until all 200 are
  delivered`, twice a run; and `bounds a burst that comes after the
  connection has been used` (`:883`), `timed out waiting until the burst is
  answered`, once a run. Each at its 20 s `until`; F-14's heavy batches
  failed the same three.
- `src/modules/webhook/receiver-http2.test.ts:1096`, `hands a connection
  that has sent nothing, or only P or PR, to HTTP/1.1 at the deadline, and
  captures what follows`, once in every run, PROXY off in runs 1 and 3 and
  v2 in run 2: `AssertionError [ERR_ASSERTION]`, its message the case, `''`
  once and `PR` twice, the answer read not `HTTP/1.1 200 OK`. The client
  ends its side 300 ms after writing its request; that this is the bound
  load overruns is inferred, not traced.
- `src/modules/requests/request-wait.test.ts:900`, `with 200 waits at once,
  on one session and across sessions`, in runs 2 and 3: `answered after
  5027 ms` and `answered after 5296 ms`.
- `src/modules/limits/rate-limit-routes.test.ts:607`, `captures more than
  1200 webhooks a minute from one address, every one answered and stored`,
  in runs 2 and 3: cancelled at the suite's 120 s; F-14's heavy batches
  failed it too.
- `src/measure-ordinary-load.test.ts`, in run 1: `writes the event loop's
  turns and events, a last line as the process exits` (`:1486`), `59
  turns`; and `runs the production mode within its budget, records every
  session before using it and deletes every one` (`:2121`),
  `{"verdict":false,"reasons":["capture p99 1240.6 ms, not under 1000 ms"]}`.

The four tests' own bounds, `answeredWithin(…, 1_000)` in `:706` and
F-10's 1 s loop in `:1706`, did not fail in the 30 runs of the file or the
three full runs.

## F-22 — `records sent for every open stream of a connection left open after a raw GOAWAY with NO_ERROR and last-stream-id 0` and its two siblings

- **Test**: the three last-stream-id cases of `cancellation over HTTP/2
  (criterion 7)` in `apps/backend/src/modules/webhook/receiver-http2.test.ts`,
  one `it` per row of one table, `:2353` at `2469544`, the base of the fix,
  and `:2408` at the fix, `375ad06`:
  - `records sent for every open stream of a connection left open after a raw GOAWAY with NO_ERROR and last-stream-id 0`,
    the one that failed in CI;
  - `records sent for every open stream of a connection left open after a raw GOAWAY with NO_ERROR and last-stream-id 2`;
  - `records aborted for every open stream of a connection left open after a raw GOAWAY with NO_ERROR and last-stream-id 5`,
    which failed once in this entry's own series, by a second race.

  At the base each read its raw connection's frames once, at `:2398`, the
  moment the last of its three response records had left `pending`, and each
  session delayed its answers 600 ms. Issue #287.
- **Status**: fixed in the test on `fix/http2-goaway-wait`, in two commits:
  `4754776`, the wait for the frames, for the CI failure, mechanism A, the
  read made too early, as measured on Node 24.19.0 (B not excluded on CI's
  24.22.1, below); and `375ad06`, the `aborted` case's 3 s delay, for
  the second race. The receiver was not changed, nor what `sent` means over
  HTTP/2 (D263 points 8 and 9); VERSION kept.

### The failure

Once, in CI: the `test` job 17446318132 of MR !282's pipeline 2986147870 on
`ce34386`, on 2026-10-25 at 08:29 UTC, the image `node:24-slim` on the
project's runner `qa-tools-ci-firstvds` (#198), an AMD EPYC 9655 as the
job's log names it; the suite ran 3,283 tests, 3,282 passed, 1 failed. The
retry, job 17446395843, passed, as did pipeline 2986113435 on `0e173f3`,
whose code is the same. At `ce34386` the assertion was at `:2119`:

```text
✖ records sent for every open stream of a connection left open after a raw GOAWAY with NO_ERROR and last-stream-id 0 (707.080733ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    [
      1,
      3,
  -   5
    ]

      at TestContext.<anonymous> (file:///…/apps/backend/src/modules/webhook/receiver-http2.test.ts:2119:16)
  …
    actual: [ 1, 3 ],
    expected: [ 1, 3, 5 ],
```

The assertions before it, that each of the three records reads `sent`,
passed. The cases for last-stream-id 2 (669 ms) and 5 (110 ms) passed in
the same run.

In this entry's series, at `4754776`, the first commit of the fix, the
`aborted` case failed in run 15 of 200 (below), on 2026-10-26 at about
02:04 (UTC+3), at its records' assertion, which the base has too:

```text
✖ records aborted for every open stream of a connection left open after a raw GOAWAY with NO_ERROR and last-stream-id 5 (934.258ms)
  AssertionError [ERR_ASSERTION]: /s/ehAQifZffNKCa1H2JauczOPGp8cBsckjMsRDjW8b3PY/1

  'sent' !== 'aborted'

      at TestContext.<anonymous> (file:///…/apps/backend/src/modules/webhook/receiver-http2.test.ts:2445:16)
```

### The mechanism

- **What the test read.** Each case writes three requests on streams 1, 3
  and 5 of a raw connection to a session delayed 600 ms, and once all three
  are stored, a GOAWAY with `NO_ERROR` and the row's last-stream-id. It then
  waits for each record through `settledResponse`, which polls the database
  every 20 ms through the receiver's own pool, and at the base parsed the
  connection's `chunks` once, with no wait: the one raw-frame read of the
  file made right after a database wait. In the `aborted` case the same read
  makes `answered` `[]` pass however early it is taken.
- **The record goes before the frames.** `sendOverHttp2` (`response.ts`)
  settles `sent` at the stream's `finish`, which Node emits as `end()` shuts
  the stream's writable side — `shutdownWritable`'s "synchronous finish" in
  Node 24.19.0's `internal/http2/core` — before the session writes the
  stream's frames to the socket later in that turn (inferred for Node's
  native side, not read); `recordCompletion` sends its one statement at
  once. The order is measured, not only read: in the second probe below
  stream 5's record was settled at `finish` in 200 of 200 iterations, and
  its answer reached the raw client 0.14 to 9.87 ms after that settle,
  median 0.32 ms, p99 5.83 ms.
- **The race, A.** A poll that PostgreSQL answers inside that gap, and whose
  answer Node delivers before the raw socket's read, has the test read
  `chunks` without stream 5's frames. Stream 5 is stored last, so its delay
  ends last, and its frames are the only ones that can still be in flight
  once every record reads `sent`: in mutation a below, where stream 5's
  frames are lost as its record settles, streams 1 and 3 had been answered
  already, the CI failure's `[ 1, 3 ]`. On the operator's Mac the poll read
  `sent` 1.5 to 85 ms after the settle, median 16 ms, in the second probe,
  and in neither probe, 800 iterations, before stream 5's answer had come;
  on CI's runner it did once.
- **B, the answer lost, not seen on 24.19.0; not excluded on 24.22.1.** In
  the first probe below every one of 600
  iterations received stream 5's answer, and every connection closed after
  it, none before. As read in Node 24.19.0's `internal/http2/core`: the
  session's graceful close after a client's GOAWAY with `NO_ERROR`
  (`onGoawayData` calls `session.close()`) is destroyed only without pending
  data (`kMaybeDestroy` reads `hasPendingData()`), `finishSessionClose` ends
  the socket waiting for its writable side, and the receiver's FIN rule
  (`installHttp2`) acts only on the sender's FIN, which the raw client sends
  after the server's. CI's Node, 24.22.1 when D263 point 8 recorded it, was
  neither read nor run here, and D263 point 8 records that the two versions
  differ where a stream is torn down; the CI failure itself cannot tell A
  from B. So B was not seen in 800 iterations on 24.19.0 and is not excluded
  on 24.22.1: should it happen there, the fixed test fails at its wait naming
  the stream whose answer never came.
- **Last-stream-id 0 and 2 alike.** Both name a stream of the server's,
  which has none, so nghttp2 treats them the same (inferred); in the first
  probe, 300 iterations each, stream 5's answer came a median 16.2 and 15.0
  ms before the records read `sent`. That the failure fell on 0 is chance.
- **The second race, in the `aborted` case.** Its premise is that all three
  streams are still waiting when its GOAWAY lands, so that Node's
  `PROTOCOL_ERROR` aborts them all; a stream whose 600 ms delay has run out
  first is answered and rightly recorded `sent`. The three captures of one
  session commit one after another under the session's lock
  (`clock_timestamp()` taken with it held, D196), stream 1's delay starting
  at its own, and the test writes the GOAWAY once its poll sees all three.
  In the third probe below, at a load of about 37, the GOAWAY was written 15
  to 163 ms after stream 1's capture, median 39; run 15's case took 934 ms
  where the series' median was 80 ms, and writing the GOAWAY 700 ms late
  forces the same failure (below). Which part of the 600 ms the load
  stretched in run 15 — the captures, the test's poll or the server's read
  of the GOAWAY — was not traced.

### The forced reproductions

Not committed, each restored from Git after: from the task's worktree, on
the operator's Mac, an Apple M1 Pro with 8 CPUs, Node v24.19.0, against the
task's own database (D216), on 2026-10-26, one run each of

```sh
node scripts/db.mjs task-test 287 -- \
  --test-name-pattern='after a raw GOAWAY with NO_ERROR and last-stream-id' \
  src/modules/webhook/receiver-http2.test.ts
```

- **The late read**, `D287_FORCE_LATE=1`: the raw socket paused,
  `socket.pause()`, right after the GOAWAY was written, and resumed,
  `socket.resume()`, once the three records had settled; nothing else
  changed.
- **The late GOAWAY**, `D287_GOAWAY_LATE_MS=700`: `await delay(700)` before
  the GOAWAY is written, once all three are stored.

| Test file | Forced | When (UTC+3) | 1-minute load average | Result |
| --- | --- | --- | --- | --- |
| the base's, `2469544` | the late read | 01:41:30 | 26.4 | `ℹ tests 3`, `ℹ fail 3`: both `sent` cases `actual: []`, `expected: [ 1, 3, 5 ]` at the answered-streams assertion; the `aborted` case `AssertionError [ERR_ASSERTION]: a GOAWAY with an error code`, `actual: false` |
| `4754776`'s | the late read | 01:51:55 | 100.7 | `ℹ tests 3`, `ℹ pass 3`, in 780, 711 and 140 ms |
| `4754776`'s | the late GOAWAY | 02:13:58 | 33.7 | `ℹ tests 3`, `ℹ pass 2`, `ℹ fail 1`: the `aborted` case, `'sent' !== 'aborted'` for `/s/<id>/1`, as in run 15 |
| the fix's, `375ad06` | the late GOAWAY | 02:14:26 | 26.9 | `ℹ tests 3`, `ℹ pass 3`, the `aborted` case in 775 ms |
| the fix's, `375ad06` | the late read | 02:23:16 | 26.0 | `ℹ tests 3`, `ℹ pass 3`, in 929, 646 and 100 ms |

### The mutations

Not committed, at `375ad06`, each change restored from Git after, one run
each of the command above, on 2026-10-26 from 02:23:19 to 02:23:25 (UTC+3),
at a 1-minute load average of 29.4 to 31.4; at `4754776`, from 01:52:30 to
01:52:38 at about 100, each gave the same result:

| Mutation | Result |
| --- | --- |
| a. `sendOverHttp2` destroys the connection's socket — the session's own, reached through Node's `kSocket` — as stream 5 settles `sent` | `ℹ tests 3`, `ℹ pass 1`, `ℹ fail 2`: both `sent` cases, in 711 and 636 ms, at the wait (`:2457`): `stream 5 recorded sent, its answer not received, connection closed`; streams 1 and 3 answered whole |
| b. `sendOverHttp2` settles stream 5 `sent` and resets it `CANCEL`, writing no answer | `ℹ tests 3`, `ℹ pass 1`, `ℹ fail 2`: both `sent` cases, in 682 and 634 ms, at the wait: `stream 5 recorded sent, its answer not received, connection closed` |
| c. last-stream-id 1 and 3, odd, in the `sent` cases' place | `ℹ tests 3`, `ℹ pass 1`, `ℹ fail 2`: both at the records' assertion (`:2452`), `'aborted' !== 'sent'`, the message the first stream's path |
| d. last-stream-id 4, valid, in the `aborted` case's place | `ℹ tests 3`, `ℹ pass 2`, `ℹ fail 1`: at the records' assertion, `'sent' !== 'aborted'`, in 3,034 ms |

### The probes

Not committed: cases generated in the same file behind `D287_PROBE` and
`D287_PROBE_ABORTED`, each iteration a test of its own writing one JSON
line, one process for each probe, under the load of the measurement below:

```sh
D287_PROBE=600 D287_PROBE_OUT=<scratchpad>/d287-probe.jsonl \
  node scripts/db.mjs task-test 287 -- --test-name-pattern='D287 probe' \
  src/modules/webhook/receiver-http2.test.ts
D287_PROBE=200 D287_PROBE_OUT=<scratchpad>/d287-probe2.jsonl \
  node scripts/db.mjs task-test 287 -- --test-name-pattern='D287 probe' \
  src/modules/webhook/receiver-http2.test.ts
D287_PROBE_ABORTED=600 D287_PROBE_OUT=<scratchpad>/d287-probe3.jsonl \
  node scripts/db.mjs task-test 287 -- --test-name-pattern='D287 aborted probe' \
  src/modules/webhook/receiver-http2.test.ts
```

The first, the `sent` case, raw frames and all, last-stream-id 0 and 2 in
turn, 600 iterations, on 2026-10-26 from 01:53:08 to 02:00:05 (UTC+3), the
1-minute load average 98.8 at its start and 36.2 at its end, 30.6 to 103.3
across its iterations, median 38.8: `ℹ tests 600`, `ℹ pass 600`. Each
iteration timed, from "every record reads `sent`" — the moment the base's
read was made — the 'data' event that brought stream 5's answer whole, its
`HEADERS` and its `END_STREAM`, and the connection's close; it recorded what
the base's one read would have found, and, had neither come within 5 s of
the records, which of "connection closed" or "5 s passed" held.

| | Iterations | Stream 5's answer never received | Received after the records read `sent` | When stream 5's answer was received |
| --- | --- | --- | --- | --- |
| last-stream-id 0 | 300 | 0, 0.0% (0.0%–1.3%) | 0, 0.0% (0.0%–1.3%) | 0.63 to 327.97 ms before the records read `sent`, median 16.19; 90% at least 4.33 ms before, 99% at least 1.73 ms |
| last-stream-id 2 | 300 | 0, 0.0% (0.0%–1.3%) | 0, 0.0% (0.0%–1.3%) | 1.20 to 181.90 ms before, median 14.97; 90% at least 3.63 ms before, 99% at least 1.45 ms |
| both | 600 | 0, 0.0% (0.0%–0.6%) | 0, 0.0% (0.0%–0.6%) | 0.63 to 327.97 ms before, median 15.33; 90% at least 4.07 ms before, 99% at least 1.48 ms |

The connection closed 0.33 to 327.90 ms before the records read `sent`,
after stream 5's answer in every iteration; the base's one read would have
found `[1, 3, 5]` in all 600, as in all 200 of the second.

The second, the same, 200 iterations, with `sendOverHttp2` given one more
change: stream 5's settle timed, and whether it came at `finish` or at
`close`. On 2026-10-26 from 02:01:00 to 02:03:14, load 37.7 to 35.3:
`ℹ tests 200`, `ℹ pass 200`; stream 5 settled at `finish` in 200, its
answer at the client 0.14 to 9.87 ms later, median 0.32, p90 1.12, p99 5.83;
the records read `sent` 1.5 to 84.7 ms after the settle, median 16.3; none
never received.

The third, the `aborted` case at `4754776`'s 600 ms, 600 iterations, each
reading its three captures' `received_at` and writing the GOAWAY's time, on
2026-10-26 from 02:12:27 to 02:13:04, load 37.1 to 36.5: `ℹ tests 600`,
`ℹ pass 600`, every record `aborted`. Stream 1's
capture 0.6 to 68.6 ms after the requests were written, median 4.1; the
three captures 6.7 to 147.2 ms apart, median 16.1, p99 79.1; the GOAWAY
written 14.8 to 163.1 ms after stream 1's capture, median 39.3, p99 107.4.

### The measurement

Criterion 4's loop, from the task's worktree on the operator's Mac, an Apple
M1 Pro with 8 CPUs, Node v24.19.0, the task's own database, each run a fresh
process, none retried, none repeated:

```sh
for i in $(seq 1 200); do
  node scripts/db.mjs task-test 287 -- \
    --test-name-pattern='after a raw GOAWAY with NO_ERROR and last-stream-id' \
    src/modules/webhook/receiver-http2.test.ts > "<scratchpad>/d287-<label>-loop-$i.log" 2>&1 \
    || echo "run $i failed"
done
```

The load, for the whole series, the probes included: a second backend suite
beside it on a second task database, `node scripts/db.mjs task-test
day-c287-load`, run again from the same worktree as each run ended, 29
runs from 01:41:56 to 02:24:56, each `ℹ tests 3302`, 27 of them `ℹ pass
3302` — and the other tasks of the delivery cycle. The 1-minute load
average, at each loop's start, every 20 runs, and at its end:

| Test file | When (UTC+3) | 1-minute load average | Runs | Result |
| --- | --- | --- | --- | --- |
| the base's, `2469544` | 01:42:09–01:51:03 | 26.9 at the start; 41.5, 48.2, 47.5, 40.9, 43.8, 110.2, 124.0, 102.8, 105.5; 103.0 at the end | 200 | each `ℹ tests 3`, `ℹ pass 3`: 0 of 200 failed, 0.0% (0.0%–1.9%) |
| `4754776`'s, the wait alone | 02:03:40–02:11:27 | 46.1 at the start; 44.8, 57.9, 44.1, 39.8, 38.3, 38.8, 42.2, 65.9, 48.2; 43.5 at the end | 200 | 199 `ℹ pass 3`; run 15 `ℹ fail 1`, the `aborted` case above: 1 of 200, 0.5% (0.1%–2.8%) |
| the fix's, `375ad06` | 02:15:03–02:22:47 | 28.7 at the start; 36.3, 38.3, 38.7, 39.9, 27.2, 29.0, 31.9, 31.7, 32.3; 26.1 at the end | 200 | each `ℹ tests 3`, `ℹ pass 3`: 0 of 200 failed, 0.0% (0.0%–1.9%) |

Neither race met the base here in 200 runs, nor A the 800 probe iterations:
A's gap is a fraction of a millisecond on this machine, which is why the
forced reproduction, not a count, shows it, and the count bounds the base's
rate here at 1.9%. The `aborted` case's 600 ms failed once in the 400 runs
of the base and `4754776` together, 0.3% (0.0%–1.4%). The fix's loop ran
at a lower load than the base's, the other agents' work having eased; the
second suite ran beside all three.

### The fix

In the test only, `4754776` and `375ad06`:

- After the records have settled, each case waits — `arrives`, polling every
  20 ms as `eventually` does, 5 s at most — for what it then reads: for
  `sent`, the `HEADERS` and the answer's `END_STREAM`, on a `HEADERS` or
  `DATA` frame, on each of streams 1, 3 and 5 (`answerEndedOn`); for
  `aborted`, a GOAWAY with an error code. The wait ends early when the
  connection closes, since a socket emits every chunk it read before its
  `close`. A wait that ends without what it waited for fails naming what is
  missing, for example `stream 5 recorded sent, its answer not received,
  connection closed`, or `not within 5000 ms: …` with the same names.
- The `aborted` case's session delays 3 s instead of 600 ms: its GOAWAY ends
  the session at once, so the case takes no longer, and a GOAWAY that did
  not abort would still show as `'sent' !== 'aborted'` within
  `settledResponse`'s 5 s. The `sent` cases keep 600 ms, which their answers
  wait out.

The records' `sent` and `aborted` assertions, the answered-streams assertion
and the GOAWAY-code assertion are unchanged and still made, the last two
after the wait.

### Watched, and left

The second suite's two failures, runs 7 and 9, both during the first probe:
`src/measure-ordinary-load.test.ts:1486`, `writes the event loop's turns and
events, a last line as the process exits`, `AssertionError [ERR_ASSERTION]:
59 turns`, as F-21 records it. Not this issue's; not filed by this entry.

## F-23 — `closes a connection whose session was deleted while it was being set up (D198)`, its `late` case

- **Test**: `apps/backend/src/modules/sessions/session-delete.test.ts:725` at
  `64fa7e6`, the base of the fix, and `:969` at the fix, `78b7042`. Its third
  case, `late`, waited at `:781` with
  `until(() => own.servers.hub.countFor(late) === 1, 'the connection to register')`,
  `until` at `apps/backend/src/testing/realtime.ts:16`; at the fix it waits
  through `registration`, at `:1036`. Issue #348.
- **Status**: fixed in the test on `fix/session-delete-late-case-flake`, at
  `78b7042`. The realtime route, the hub and the listener were not changed,
  nor D198's behaviour, which the case still asserts, more exactly than
  before; VERSION kept.

### The failure

Once, in CI: the `test` job 17645794567 of MR !332's pipeline 3014952164 on
`c97d7ec`, on 2026-11-01 at 16:04 UTC, on the project's runner; the suite
ran 3,347 tests, 3,346 passed, 1 failed. `c97d7ec` differs from `08b79d1`
only in the decision log, and the same test passed in `08b79d1`'s
pipeline 3014927441 (job 17645702276) and in two local runs of the suite on
it. As the issue quotes it:

```text
test at src/modules/sessions/session-delete.test.ts:725:3
✖ closes a connection whose session was deleted while it was being set up (D198) (10163.157919ms)
  Error: Timed out after 10000 ms waiting for the connection to register
      at until (file:///…/apps/backend/src/testing/realtime.ts:16:13)
      at async file:///…/apps/backend/src/modules/sessions/session-delete.test.ts:781:9
      at async withoutReading (file:///…/apps/backend/src/testing/realtime.ts:35:12)
```

### The mechanism

- **What the case sets up.** Servers of its own (`ownServers`) hold the
  realtime route's first lookup of the session once it has read it; the
  session is deleted through the API meanwhile, inside `withoutReading`, so
  the deletion's close is not read from the outbox before the lookup is let
  go; the case then polled every 5 ms for the connection's registration,
  and only then let the reads go, for the close to find it registered.
- **The route's second lookup.** The route reads `hub.closedSessions` before
  its first lookup and, once it has registered the connection, looks the
  session up a second time if the number has moved meanwhile (D198). If
  the session is gone, it forgets the connection and closes it `4404`
  without sending `ready`.
- **What moves the number.** It counts every close the process's listener
  delivers, of any session, and every deafness (`hub.ts`). The case's
  listener reads the whole database's outbox (D221), so every deletion made
  in that database is counted, including a deletion of a session not found,
  which writes a close too (D198). In the full suite, other test files
  delete sessions in the same database at the same time, as the file's
  header says: many other files call the deletion route, `deleteSession`
  or MCP's `delete_session`.
- **The window.** `withoutReading` began only once the lookup was held,
  after the route had read the number, and a hold of reads leaves a read
  already under way to deliver (`listener.ts`, `holdReads`). A close of
  another session delivered during the first lookup's round trip, or by a
  read under way when the hold began, sent the connection through the
  second lookup. That lookup found the session deleted, since the deletion
  had committed before the first lookup was let go. The registration then
  lasted one round trip to the database, 1.1 to 3.5 ms in the reproductions
  below. `until` checks once before the route has resumed and then every
  5 ms, so it saw 0 every time and ran to its 10 s, while the connection had
  been closed `4404`, with nothing sent, within a few milliseconds.
- **Why only in the full suite.** Run alone, the file deletes no other
  session while the case runs, so the number does not move. The issue's
  inference holds: the count went 0 → 1 → 0 between two polls. The trigger
  it left open is a close of *another* session, not the case's own. The
  case's own close was held, and a read under way when the hold began had
  been sent before the deletion was made; no timeline below shows the
  case's own close before the registration.

### The forced reproductions

Not committed, in the task's worktree at `64fa7e6`, on 2026-11-02 on the
agents' Linux host, an AMD EPYC 7763 with 8 CPUs, Node v24.22.2, against
the task's own database (D216). The case was given a timeline: the hub's
`hold`, `remove` and `closeSession` wrapped to record their time and the
case's registrations, and its wait bounded at 1 s instead of 10 s. Nothing
else changed.

1. **One close of another session**, made while the lookup was held:
   another session deleted through the file's shared servers and the own
   servers flushed, before `withoutReading`. Run with
   `node scripts/db.mjs task-test 348 -- --test-name-pattern="while it was being set up" src/modules/sessions/session-delete.test.ts`,
   it failed 1 of 1, `Timed out after 1000 ms waiting for the connection to
   register`, its 184 polls all reading 0, the timeline
   `33.90ms closeSession other closed=3`, `55.78ms hold count=1`,
   `58.41ms remove count=0`, `60.16ms client closed 4404 []`. Without the
   deletion it passed 1 of 1, `21.84ms hold count=1`.
2. **Closes from another process**, with no step added: the same command
   15 times in a row while a script wrote closes of sessions that do not
   exist into the same database, through `deleteSession` in three loops, as
   other test files' deletions are written. It failed 7 of 15, 46.7%
   (24.8%–69.9%), each the same way: `hold`, `remove` 1.1 to 3.5 ms later,
   the connection closed `4404` with nothing sent. In three of the seven,
   closes of other sessions were delivered 2.3 to 3.3 ms after
   `withoutReading` began, by a read already under way.

### The fix

In the test only, `78b7042`:

- **The reads are held from before the connection is opened, and a read is
  held before it is sent**: `holdRead` holds the next read of the outbox
  before its statement is sent (`READ_SQL`, through the listener's existing
  `beforeStatement` hook), and the case asks for a read with `flush`
  (`OwnServers.holdRead`). Reads run one at a time, so once one is
  held no read is under way, and nothing reaches the hub until it is let
  go: no close of any session moves `closedSessions` while the connection
  is set up. The route therefore registers it and sends `ready` at once,
  with no second lookup, every run. The read is let go after the
  registration, takes its snapshot after the deletion has committed, and
  delivers the close.
- **The registration is awaited as the hub records it, not polled for**: the
  case's hub is a `RecordingHub`, which records for one session it follows
  each `hold`, `release` and `remove`, every close of any session and every
  deafness, with the time and the session's registrations before and after.
  `registration` resolves on the hub's `hold` itself, so a registration
  undone at once is still seen.
- **What is asserted.** That the hub, while the read was held, registered the
  connection and sent `ready`, and did nothing else. Then that the
  connection was closed `4404` after exactly `ready`, where the base
  accepted any number of `ready` messages, none included, which was what
  the second lookup sent. Then that the deletion's close found it
  registered, 1 → 0, and that the count is 0. The kept and doomed cases
  before it are unchanged.
- **A failure names what it waited for and what the hub did.** The wait
  for the registration fails `Waiting for the connection to register:`
  followed by `not within 10000 ms` or by the close the connection received
  first, then the hub's steps. While the read is held, the listener's 5 s
  statement deadline comes first: a registration the test does not see shows
  after about 5 s as the close received first, `1006`, with a `deafen`
  step, rather than as the 10 s branch. The assertions and the waits for the
  close add the same steps: see the mutations below.

### The mutations

Not committed, each restored from Git after, in the task's worktree with
the fix applied, its test file that of `78b7042`, on 2026-11-02:

| Mutation | Result |
| --- | --- |
| a. `RealtimeHub.closeSession` forgets the session's connections without closing them | failed 1 of 1, in 10.6 s: `The connection was not closed within 10000 ms; the hub: +18.4 ms hold, registered 0 -> 1; +18.7 ms release, ready sent, registered 1 -> 1; +21.5 ms close of this session, registered 1 -> 0` |
| b. `holdRead` holds nothing: the gate reports itself reached and lets the read go | alone, passed 1 of 1: the deletion is this process's own commit, read only at the end of the listener's 20 ms window (`COALESCE_MS`), after the registration, inferred from `listener.ts`, not traced. Beside the closes of the second reproduction, failed 8 of 8, 100.0% (67.6%–100.0%), each in 0.72 to 0.92 s rather than 10 s, at `registered and sent ready, with nothing else`. In two the registration had no `release`, the route looking the session up again as at the base, for example `the hub: +2.3 ms 94 closes of other sessions, registered 0 -> 0; +31.5 ms hold, registered 0 -> 1`. In six it had its `release`, the closes having come before the route read the number, which the assertion refuses too, since none may arrive while the read is held |

### The measurement

Not a series before the fix: the failure above is CI's, and the
reproductions show the mechanism. With the fix, `78b7042`, one shell script
from the task's worktree on the same host, on 2026-11-02 from 08:49:43 to
09:00:15 UTC, every run a fresh process, none retried. The file, 50 runs in
a row:

```sh
node scripts/db.mjs task-test 348 -- src/modules/sessions/session-delete.test.ts
```

passed 50 of 50, 0.0% (0.0%–7.1%) failed, each `ℹ tests 20`, `ℹ pass 20`,
`ℹ fail 0`, the case in 436 to 1,835 ms. For the whole series it ran beside
the second reproduction's script, which wrote 919,129 closes into the same
database in 631 s. Runs 1 to 12, from 08:49:56 to 08:52:20, also ran beside a
full run of the suite, started at 08:49:43 and ended at 08:52:21, on a task
database of its own, so that the two shared no data:

```sh
node scripts/db.mjs task-test day-t348-load
```

It gave `ℹ tests 3407`, `ℹ pass 3404`, `ℹ fail 3`, the case passing in it in
320 ms. Its deletions did not reach the file's listeners, which read another
database; the closes script's did. The 1-minute load average at the end of
each run was 4.1 to 15.6, the other agents' work included.

### Watched, and left

The full run's three failures, all bounds on time in other files, under the
series' load; none is in this file:

- `src/measure-ordinary-load.test.ts:1486`, `writes the event loop's turns
  and events, a last line as the process exits`, `AssertionError
  [ERR_ASSERTION]: 59 turns`, as F-21 records it.
- `src/modules/limits/rate-limit.test.ts:388`, `counts 100,000 distinct
  addresses quickly`, `took 5107.4 ms at best in 5 runs, over the 5000 ms
  bound`.
- `src/modules/mcp/protocol.test.ts:260`, `survives made-up bodies of
  1048576 bytes`, `took 153.9 ms at best in 5 runs, over the 100 ms bound`.

Not this issue's; not filed by this entry.

## F-24 — `survives made-up bodies of 1048576 bytes`

- **Test**: `apps/backend/src/modules/mcp/protocol.test.ts:260` at `bc8f7a8`,
  the base of the fix, and `:267` at the fix, `c3ffb2b`. Each of its ten
  made-up bodies is read by `parseMessage` through `timed`, `withinBound`
  with the file's one bound then, `BOUND_MS`, which every check of made-up
  input in the file shared (F-04). Issue #363. Since #377, `:301`, through
  `withinBound` with a bound of its own, `BODIES_BOUND_MS`.
- **Status**: fixed in the test on `chore/mcp-protocol-timing-bound-363`, at
  `c3ffb2b`: the bound is 1000 ms, from 100 ms. `parseMessage` and
  `testing/timing.ts` were not changed; VERSION kept. On
  `chore/mcp-protocol-tight-bounds-377` the case keeps its 1000 ms and the
  file's other checks of made-up input are held to tighter bounds, of 500,
  200 and 50 ms (After #377); `protocol.ts` and `testing/timing.ts` were not
  changed, VERSION kept.

### The failure

Twice, in full runs of the backend suite on the agents' server under load,
3,407 tests each:

- the tester of #345's delivery, finding 2 on MR !340, on 2026-11-02 at
  09:30 MSK: `node scripts/db.mjs task-test 345` while the same tester's
  81-test e2e suite ran beside it; 3,406 passed, 1 failed. The file passed
  alone, 38 of 38, and the suite in a rerun with no other load, 3,407 of
  3,407. As the issue quotes it:

  ```text
  test at src/modules/mcp/protocol.test.ts:260:5
  ✖ survives made-up bodies of 1048576 bytes (796.643323ms)
    AssertionError [ERR_ASSERTION]: took 109.0 ms at best in 5 runs, over the 100 ms bound
        at withinBound (apps/backend/src/testing/timing.ts:38:14)
  ```

- F-23's run beside its reproduction's script, `took 153.9 ms at best in 5
  runs, over the 100 ms bound`, left there under Watched, and left.

### The mechanism

A bound with little room over the check's own time. `withinBound` holds the
fastest of up to five runs to the bound, so a stall that stops one run does
not fail it (F-04); a machine whose CPUs are all busy slows every run, and
the fastest with them. Of the ten bodies, the slowest, in every one of the
180 rounds measured below, is `fill('[', size)`: each byte opens an array
for V8's JSON.parse, which holds a level for each until the input ends and
it throws. At 1 MiB `parseMessage` takes 67 to 80 ms on it alone, at best of
five, against 10 to 12 ms for `{"a":` repeated and for the batch; the
bound's comment said 30 ms, the figure of F-04's developer's machine. So the
bound of 100 ms left this body about a quarter of its time, and a load that
slowed it by a third failed it.

Its time grows faster than its size: `parseMessage` on n bytes of `[`, the
fastest of seven runs, took 1.0 ms at 64 KiB, 8.0 ms at 256 KiB, 74.7 ms at
1 MiB and 433.4 ms at 4 MiB — 16, 32, 75 and 108 ms a MiB. From 1 to 4 MiB
that is ×5.8, where n² would be ×16. That the parser's levels cost more
once they outgrow the CPU's caches is an inference, not measured. `{"a":`
repeated and the batch took 9 to 13 ms a MiB from 64 KiB to 1 MiB.

### The measurement

On 2026-11-02 on the agents' Linux host, an AMD EPYC 7763 with 8 CPUs, Node
v24.22.2, with a script outside the tree that builds the test's ten bodies
of 1 MiB and, each round, runs `parseMessage` on each body five times and
keeps the slowest body's fastest run — the number `withinBound` holds to its
bound when every run is over it. The load is the 1-minute load average at
the start and the end of the series:

| beside | load | rounds | min / median / max, ms | over 100 ms | over 500 ms | over 1000 ms |
| --- | --- | --- | --- | --- | --- | --- |
| nothing | 0.7 | 20 | 66.8 / 74.5 / 79.7 | 0 | 0 | 0 |
| a full run of the backend suite, `node scripts/db.mjs task-test 363` | 3.3 to 7.0 | 60 | 31.9 / 79.3 / 110.8 | 1 | 0 | 0 |
| the same run and eight busy loops, `node -e 'for(;;){}'` | 9.5 to 17.2 | 60 | 72.6 / 96.2 / 268.0 | 26 | 0 | 0 |
| sixteen busy loops | 11.4 to 15.0 | 40 | 67.7 / 153.3 / 229.5 | 29 | 0 | 0 |

The slowest body was `[` in every round. The full-run row's minimum, 31.9 ms,
is one round of its 60, the eighth, where every other round read 63 ms or
more, and is under the 66.8 ms of the row with nothing beside it; why is not
known. The suite run under that load, at
the fix's file with the bound at 500 ms, an intermediate value, gave
`ℹ tests 3407`, `ℹ pass 3406`, `ℹ fail 1`: this file passed, the bodies case
in 251 ms for all ten bodies, and
`src/modules/webhook/capture-budget.test.ts:1490`, `gives a flooder of 81 KiB
webhooks on any number of connections no more of the reserve than a light
sender may hold, and leaves the rest to another sender`, failed with
`weighing the flood took too long`.

For the other side, the same script read `fill('[', n)` with a reader
quadratic in n: for each `[`, the rest of the body searched for a `]`, which
it does not hold, so each search runs to the end; one run each, at a load of
1 to 7:

| the search | 16 KiB | 32 KiB | 64 KiB | 128 KiB | 256 KiB | 512 KiB | 1 MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V8's `String.prototype.indexOf` | 2.0 ms | | 22.7 ms | 94.0 ms | 385.1 ms | 1,648.5 ms | 7,730.1 and 7,614.5 ms |
| Node's `Buffer.prototype.indexOf` | | | | | 397.3 ms | | 7,800.1 ms |
| a `charCodeAt` loop | 266.1 ms | 1,065.9 ms | 4,235.1 ms | 16,727.7 ms | | | not run; about 18 min by n² |

Each doubling multiplies the time by about four, as n² does. The fastest
quadratic reading of 1 MiB built here, 7.6 s, is over 1000 ms on every run,
and a busier machine only slows it further.

The script is not kept in the tree. Its reader for the `indexOf` row, given
the body decoded as UTF-8 in `text`, was:

```js
let found = 0;
for (let i = 0; i < text.length; i += 1) {
  if (text.charCodeAt(i) === 0x5b && text.indexOf(']', i + 1) !== -1) found += 1;
}
```

The `Buffer` row searched the bytes with `body.indexOf(0x5d, i + 1)` in its
place, and the `charCodeAt` row a loop over `j` from `i + 1` to the end.

### The fix

`BOUND_MS` is 1000 ms, for every check of the file: 3.7 times this check's
worst loaded reading and 12 times its time alone, and 7.6 times below the
fastest quadratic reading. 500 ms, the bound of most of the suite's
hostile-input files, would be 1.9 times the worst loaded reading; this check
takes 75 ms alone, where the slowest cut of `captured.test.ts`, by its
comment, takes about 3 ms against its 200 ms. The checks that tell a
quadratic reading from a linear one are the 1 MiB ones, where a quadratic
reading that searches from every byte, or every few bytes, takes seconds;
at 64 KiB the `indexOf` reading took 23 ms, under 100 ms and 1000 ms alike.
A quadratic reading that searches once per larger unit is not told apart at
1000 ms: in the runs of #363's tester at 1 MiB, one search per 41-byte
element of the batch body took 188 ms and one per 16-character `Accept`
item 491 ms, over the old 100 ms and under 1000 ms. A bound that holds the
loaded readings above gives those up. The names of the `Origin`, URL and `Accept` cases
carry the bound and read `within 1000 ms`.

No test holds that a quadratic reading fails the bound: one reading of 1 MiB
takes 7.6 s, and five to fail; `testing/timing.test.ts` holds, on a made-up
clock, that a check over the bound on every run fails.

At the fix, the file alone,
`node scripts/db.mjs task-test 363 -- src/modules/mcp/protocol.test.ts`,
gave `ℹ tests 38`, `ℹ pass 38`, `ℹ fail 0`, the bodies case in 213 ms, and
the full suite, `node scripts/db.mjs task-test 363`, with nothing of this
entry's beside it, `ℹ tests 3407`, `ℹ pass 3407`, `ℹ fail 0`, exit 0, in
112 s at a load of 2.2 to 10.0, the bodies case in 257 ms.

### After #377

One bound of 1000 ms, set for this case, left the file's other checks of
made-up input room for a reading many times slower than their own (#377,
from the review of #363). On `chore/mcp-protocol-tight-bounds-377` each is
held, through `withinBound` as before, to the bound of its kind, near its
own cost and with room for the load above. The test names carry their
bound, now the ids' and `ownCopy`'s too; the bodies case's does not, nor
the protocol version's, a test of five headers of which one is of 1 MiB:

| bound | its checks | slowest alone | slowest under load | quadratic readings over it | given up |
| --- | --- | --- | --- | --- | --- |
| `BODIES_BOUND_MS`, 1000 ms | `parseMessage` on the made-up bodies, this case | 60 to 84 ms, `[` | 269 ms, `[` | from every byte, 7.8 s | one search per 41-byte batch element, 178 and 213 ms |
| `ACCEPT_BOUND_MS`, 500 ms | `Accept` values of one character repeated - `,`, `;`, NUL - and one range with a parameter every four characters | 37 to 66 ms, the commas | 165 ms, the commas; 249 ms in one round whose value was not named | from every byte, 8.0 s; once per parameter, 1.9 and 2.0 s | none measured |
| `ACCEPT_RANGES_BOUND_MS`, 200 ms | `Accept` lists of whole media ranges, 10 to 21 characters each | 16 to 21 ms, ranges of 21 characters | 78 ms, the same | once per range: of 21 characters 364 and 377 ms, of 16 480 and 500 ms, of 10 753 and 756 ms | none measured |
| `BOUND_MS`, 50 ms | ids, `ownCopy`, `Origin`, URLs and the protocol version | 3.7 to 5.5 ms, an id of emoji; `ownCopy` 4.3 ms; the rest 0.1 ms or less | 21 ms, the ids; `ownCopy` 16 ms; the rest 0.1 ms or less | from every byte of 1 MiB, 7.8 to 16.5 s, and of the 16,384 `Origin` headers joined, 657 ms; once per URL parameter or escape, 1.9 to 2.9 s; once per origin repeated in one value, 280 to 467 ms; once per header of 16,384, the rest of them searched, 147 and 162 ms | none measured |

The `Accept` case of before is two since: its values of one character, or
one parameter, repeated allocate a string for each, a million for the
commas, and under load read up to 165 ms, where the lists of whole ranges
read at most 78 ms. One bound for both, first 250 ms, would have been 1.5
times the loaded commas and under 1.5 times a reading once per range of 21
characters; the `b3a644b` series below read 248.5 ms in one round.

On 2026-11-04 from 02:36 to 03:07 MSK on the same host, an AMD EPYC 7763
with 8 CPUs, Node v24.22.2, a script outside the tree built the file's
made-up values of 1 MiB and, each round, ran each check five times on each
value, keeping each value's fastest run and, for each kind, the slowest
value's: the number `withinBound` holds to its bound when every run is over
it. Under load is beside `node scripts/db.mjs task-test 377`, the full
backend suite, and eight busy loops, `node -e 'for(;;){}'`, as above. Min,
median and max of the rounds, in ms:

| beside | load | rounds | bodies | `Accept`, every value | ids | `ownCopy` |
| --- | --- | --- | --- | --- | --- | --- |
| nothing | 0.6 to 0.8 | 20 | 63.1 / 67.8 / 83.7 | 45.7 / 49.2 / 55.5 | 3.7 / 4.2 / 5.5 | 0.5 / 0.7 / 1.0 |
| nothing | 1.8 to 1.7 | 20 | 59.6 / 67.6 / 73.0 | 44.4 / 48.6 / 51.3 | 3.7 / 4.2 / 4.5 | 0.5 / 0.9 / 4.3 |
| the suite at the base, `d9f3959`, and eight loops | 5.4 to 19.5 | 60 | 68.2 / 95.6 / 245.7 | 50.7 / 79.9 / 140.1 | 3.6 / 6.3 / 20.1 | 0.5 / 0.7 / 5.4 |
| the suite at `b3a644b` and eight loops | 7.0 to 19.0 | 60 | 63.6 / 96.5 / 209.4 | 49.9 / 78.0 / 248.5 | 3.6 / 7.7 / 20.8 | 0.5 / 0.7 / 5.5 |
| the suite at `82dc81b` and eight loops | 10.9 to 19.2 | 50 | 66.0 / 89.6 / 268.7 | 49.0 / 86.4 / 165.1 | 3.6 / 7.1 / 15.4 | 0.5 / 0.7 / 11.4 |
| the same, and the `Accept` script below at once | 13.9 to 20.5 | 50 | 65.4 / 106.6 / 219.4 | 51.5 / 82.3 / 164.1 | 3.9 / 8.7 / 17.5 | 0.5 / 0.7 / 16.3 |

`Origin` and the protocol version read under 0.01 ms in every round, and
URLs 0.09 ms at most. The slowest `Accept` value of a round was the commas
in 52 of the `b3a644b` series' 60 rounds, the parameters in 7 and the
ranges of 21 characters in 1; that series did not keep each value's own
maximum, so which value read 248.5 ms is not known. The series after it
kept them, and a second script read the `Accept` values alone, each its
fastest of five a round:

| beside | load | rounds | `,` | the parameters | ranges of 21 | ranges of 10, and JSON | ranges of 16 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nothing | 1.9 to 1.8 | 20 | 36.7 / 38.6 / 65.6 | 25.1 / 27.0 / 29.3 | 16.3 / 17.8 / 20.7 | 7.3 / 8.1 / 10.1 | 4.6 / 5.5 / 7.4 |
| eight loops | 12.9 to 12.3 | 20 | 38.0 / 57.5 / 98.6 | 24.7 / 28.0 / 55.9 | 15.8 / 18.9 / 38.4 | 7.6 / 9.3 / 19.3 | 4.8 / 6.3 / 13.0 |
| the suite at `b3a644b` and eight loops | 12.6 to 18.6 | 150 | 36.2 / 54.3 / 148.9 | 24.0 / 40.1 / 150.7 | 16.5 / 31.0 / 75.9 | 7.2 / 12.6 / 36.9 | 4.6 / 7.8 / 26.0 |
| eight loops, the suite at `82dc81b` just ended | 19.2 to 14.3 | 80 | 35.7 / 45.0 / 112.5 | 24.9 / 29.5 / 84.0 | 15.9 / 18.6 / 61.1 | 8.2 / 10.0 / 27.4 | 5.1 / 6.2 / 22.5 |
| the suite at `82dc81b`, eight loops and the first script | 13.9 to 18.9 | 150 | 36.0 / 62.1 / 156.2 | 25.1 / 50.7 / 131.1 | 16.5 / 33.1 / 77.7 | 8.2 / 15.5 / 43.1 | 5.1 / 9.8 / 25.0 |

`;` and NUL read 0.19 ms or less in every round. Of the lists of whole
ranges, the highest of the 500 rounds beside the loops that named the
value, 400 of them beside the suite too, was 77.7 ms, 2.6 times under
200 ms.

The quadratic readings were the same script's, one run each with nothing
beside it, at a load of 0.5 to 1.3; each searches its value, as decoded
text, from a set of places to the end for a character the value does not
hold, with V8's `indexOf`, as F-24's reader above does from every `[`:

| the reading, at 1 MiB | ms |
| --- | --- |
| from every byte: the body of an id of `x`; of an id of emoji, two-byte text | 7,791.8; 16,538.7 |
| from every byte: `ownCopy`'s `x`; an `Origin` of the site's own repeated; a URL; `Accept`'s commas; the protocol version's header; the bodies case's `[` | 8,002.2; 8,348.5; 8,110.6; 8,010.0; 7,996.6; 7,767.6 |
| from every byte of the 16,384 `Origin` headers joined, 344,062 characters | 656.5 |
| once per URL parameter `a=1&`; per escape `%3F` | 1,917.7 and 2,124.4; 2,520.2 and 2,892.2 |
| once per `Accept` parameter `q=1;` | 1,889.8 and 1,989.5 |
| once per `Accept` range of 10 characters; of 16; of 21 | 753.4 and 755.5; 480.2 and 499.8; 364.4 and 376.8 |
| once per origin repeated in one `Origin` value: of 19 characters; of 27 | 381.5 and 466.7; 280.3 and 291.1 |
| once per `Origin` header of 16,384, the rest of the array searched | 161.8 and 146.6 |
| once per 41-byte element of the batch body | 177.7 and 212.7 |

Every reading but the batch's is over its check's bound by 1.8 times or
more: the ranges of 21 characters, the closest, by 1.8 times over 200 ms,
and the `Origin` headers by 2.9 times over 50 ms. The batch's, 178 ms, is
under the bodies case's 1000 ms, which `[` needs: given up, as before.

The same readings, written into `protocol.ts` for a run and taken out
after it, each switched on by an environment variable, were then run by
the test itself, `node scripts/db.mjs task-test 377 --
src/modules/mcp/protocol.test.ts`, with the checks of `82dc81b` and nothing
beside it:

| the reading in `protocol.ts` | `ℹ tests 41` | what failed, at 1 MiB |
| --- | --- | --- |
| from every byte, in `parseMessage`, `ownCopy`, `isAllowedOrigin`, `hasQueryString`, `acceptsJson` and `declaredProtocolVersion` | `ℹ pass 33`, `ℹ fail 8` | every case of made-up input of 1 MiB, the bodies, the ids, `ownCopy`, `Origin`, URLs, both `Accept` cases and the protocol version: `took 7292.6` to `7854.1 ms at best in 5 runs, over the` 50, 200, 500 or `1000 ms bound`; none at 1 or 64 KiB |
| once per `Accept` range longer than 8 characters, and once per `Origin` header, the rest of them searched | `ℹ pass 39`, `ℹ fail 2` | `Origin`: `took 140.7 ms at best in 5 runs, over the 50 ms bound`; the lists of whole ranges, on ranges of 16 characters: `took 480.6 ms at best in 5 runs, over the 200 ms bound` |
| once per `Accept` range longer than 16 characters, and once per origin repeated in one `Origin` value | `ℹ pass 39`, `ℹ fail 2` | `Origin`: `took 421.2 ms at best in 5 runs, over the 50 ms bound`; the lists of whole ranges, on ranges of 21 characters: `took 440.8 ms at best in 5 runs, over the 200 ms bound` |
| once per element of a batch, before JSON.parse, twice | `ℹ pass 41`, `ℹ fail 0`, twice | nothing: the bodies case in 390 and 376 ms, against 178 to 191 ms without it |

A first placing of the batch's reading, after JSON.parse, never ran: the
batch body of 1 MiB ends inside an element, as `fill` cuts it, and is a
parse error, not a batch.

The full suite under load, each run exit 1 on failures of other files'
bounds on time, none in this file:

| the tree | beside it | load | `ℹ tests` | `ℹ pass` | `ℹ fail`, all in other files |
| --- | --- | --- | --- | --- | --- |
| the base, `d9f3959`, the bound 1000 ms | eight loops and the first loaded series | 2.7 to 18.6 | 3420 | 3417 | 3: `rate-limit.test.ts:388`, `capture-budget.test.ts:960` and `:1490` |
| `b3a644b`, `Accept` at 250 ms and the rest at 50 ms | eight loops and a series | 3.3 to 17.7 | 3420 | 3418 | 2: `rate-limit.test.ts:388`, `capture-budget.test.ts:960` |
| `b3a644b` | eight loops and the `Accept` script | 11.9 to 18.8 | 3420 | 3417 | 3: `rate-limit.test.ts:388`, `capture-budget.test.ts:960` and `:1490` |
| `82dc81b`, the bounds of the fix | eight loops and a series | 10.0 to 18.3 | 3423 | 3422 | 1: `rate-limit.test.ts:388` |
| `82dc81b` | eight loops and both scripts at once | 13.5 to 19.7 | 3423 | 3418 | 5: `rate-limit.test.ts:388`, `access-key.test.ts:264` and `:473`, over their 100 ms, `capture-budget.test.ts:960` and `:1490` |

In the two runs at the bounds of the fix the file's cases of 1 MiB took
450 and 486 ms for the bodies, 209 and 201 ms for the ids, 265 and 335 ms
for the `Accept` values and 247 and 188 ms for the lists of whole ranges,
each case all its values and their building. The file alone, at `5db9a6d`,
whose checks are `82dc81b`'s, gave `ℹ tests 41`, `ℹ pass 41`, `ℹ fail 0` in
three runs of three, exit 0.

The scripts are not kept in the tree.

### Watched, and left

- `parseMessage` on `[` growing faster than its size up to 4 MiB, above: in
  V8's own JSON.parse, and `/mcp` takes a body of 1 MiB at most.
- `capture-budget.test.ts:1490` in the loaded run above; not this issue's.
- In #377's loaded runs, `rate-limit.test.ts:388` in all five,
  `capture-budget.test.ts:960` in four, `:1490` in three and
  `access-key.test.ts:264` and `:473` in one, over their bounds on time;
  not #377's.
- The 248.5 ms of one round of the `b3a644b` series, its `Accept` value not
  named: the commas' or the parameters', the likelier, would be half the
  500 ms they are held to; a list of whole ranges' would be over its 200 ms
  by 1.24 times, and fail. In the 500 rounds after it that named the value,
  no list read over 77.7 ms.

## F-25 — `keeps at most 64 KiB a wait: <shape>`

- **Test**: `apps/backend/src/modules/limits/calls-memory.test.ts:255` at
  `7c9c5cb`, the base of the fix, its assertion
  `assert.ok(held <= WAITS * PER_WAIT_BYTES, report)` at `:286`; `:371` at
  the fix, `4b3a199`, the assertion at `:386`, holding `least`, the least
  reading of the rounds. One test for each of the four shapes of
  `WAIT_SHAPES`, in the suite `a pending wait on the API (D213)`. Issue
  #382.
- **Status**: changed in the test on `chore/calls-memory-flake-382`, at
  `4b3a199`: a shape's round over the bound is made again, up to three
  rounds, and the least reading is held to the bound; each round ends with
  every answer awaited, so a failed round no longer spreads into the next
  test. `PER_WAIT_BYTES` stays 64 KiB, the issue's bound of #139 under D213,
  `WAITS` 16, and every shape and answer check stays. The cause of the
  bytes over the bound is not identified: what is measured is that they are
  not kept by every wait every time. VERSION kept: the change is a test and
  this entry.

### The failure

On CI once, on a branch that did not touch the backend: the delivery of
#344, webhook-inspector MR !6, head `d3b643f`, whose backend is that of
main `7c9c5cb` (1.19.6); MR pipeline 3020296935, job `test` 17683619935, on
the project runner, an AMD EPYC 9655, in the image `node:24-slim`, on
2026-11-03 at 01:12 UTC. The backend suite gave `ℹ tests 3407`,
`ℹ pass 3406`, `ℹ fail 1` in 158 s; the same commit's suite passed 3,407
of 3,407 twice on the agents' server. The file's four lines:

```text
✔ keeps at most 64 KiB a wait: two header lines, for reference (128.273019ms)
ℹ 16 calls, 16 pending: 342.2 KiB more held, 21.4 KiB a call
✔ keeps at most 64 KiB a wait: 100 header lines and a URL of 13,000 bytes (101.290155ms)
ℹ 16 calls, 16 pending: 701.0 KiB more held, 43.8 KiB a call
✖ keeps at most 64 KiB a wait: 100 header lines of 150 bytes, as much of 16 KiB as they fit (81.115322ms)
ℹ 16 calls, 16 pending: 1165.8 KiB more held, 72.9 KiB a call
✔ keeps at most 64 KiB a wait: 1,000 short header lines, which 16 KiB allows: refused 431 (66.925118ms)
ℹ 16 calls, 16 pending: 73.3 KiB more held, 4.6 KiB a call
```

```text
AssertionError [ERR_ASSERTION]: 16 calls, 16 pending: 1165.8 KiB more held, 72.9 KiB a call
    at TestContext.<anonymous> (file:///builds/qa-tools-team/webhook-inspector/apps/backend/src/modules/limits/calls-memory.test.ts:286:14)
```

The refused shape's calls are answered `431` and never wait, `0 pending` in
every run below but those after a failed test: its 16 pending were the
failed test's (below).

And once in the base series below, run 15 of 40, on the URL shape:

```text
✔ keeps at most 64 KiB a wait: two header lines, for reference (450.936714ms)
ℹ 16 calls, 16 pending: 305.2 KiB more held, 19.1 KiB a call
✖ keeps at most 64 KiB a wait: 100 header lines and a URL of 13,000 bytes (418.205181ms)
ℹ 16 calls, 16 pending: 1052.8 KiB more held, 65.8 KiB a call
✔ keeps at most 64 KiB a wait: 100 header lines of 150 bytes, as much of 16 KiB as they fit (30478.922097ms)
ℹ 16 calls, 16 pending: -466.6 KiB more held, -29.2 KiB a call
✔ keeps at most 64 KiB a wait: 1,000 short header lines, which 16 KiB allows: refused 431 (391.406091ms)
ℹ 16 calls, 0 pending: 54.3 KiB more held, 3.4 KiB a call
```

### The mechanism

- **Not a retention every wait makes every time.** Measured. A wait that
  kept more every time would read more in every round of its shape; a
  retention that only some waits make, or only sometimes, is not excluded:
  a head that arrives in several chunks, say, is never sent, since the
  test's `rawRequest` writes it in one `socket.write`. Of the 40 base runs
  below, the shape `100 header lines of 150 bytes` read 44.1 to 44.7 KiB a
  call in the 39 whose reading was its own (run 15's counted the URL
  shape's waits, below), 19 KiB a call under the bound, and the URL shape
  42.4 to 44.3 in all but run 15. Each head, about 15.5 KB, is in those
  readings already: they are some 25 KiB a call above the reference shape,
  two header lines, at about 19. The CI reading and the base's were single
  readings, about 455 and 350 KiB above their shape's usual for the sixteen
  calls, 28 and 22 KiB a call, on the two shapes with the least room under
  the bound, about 20 KiB a call; the reference shape has 45 KiB a call of
  room, and the same bytes would not have failed it.
- **Garbage still to collect.** Not shown. In the probe series below, a
  second reading taken right after each first one, three collections more,
  differed from it by −33 to +72 KiB for the sixteen calls in all 480
  readings; but none of those readings was over, so whether a further
  collection would have freed the bytes over the bound is not measured.
- **The load.** The base series under eight busy loops failed 1 run in 40;
  the CI failure ran in the full backend suite, beside the suite's other
  files. The file's rate without load was not measured here.
- **What the bytes were.** Not identified; inferred to be the process's,
  not the waits': something allocated once, or held for a while, besides
  the round's calls, between a baseline and its reading. The size is that
  of F-18's growth of 360 to 400 KiB seen early in a process and of its CI
  readings 400 to 560 KiB over the usual, and the readings over came early
  in their process too, the third shape on CI and the second here. A second
  probe that took a heap snapshot of any reading 150 KiB over its shape's
  usual, to compare with a usual one, ran 80 times under the same load and
  caught none (below): of the 190 runs under load here, the base's, both
  probes' and the fix's, one reading was over its shape's usual by that
  much, 0.5% (0.1%–2.9%).
- **The failures that spread.** Shown by the readings above and the forced
  reproduction below. A failed test threw before it awaited its answers; a
  clear ends its waits only once its `requests.cleared` has come back
  through the outbox and the realtime listener (D221), after `clear` has
  returned, so the next test began with the sixteen waits still pending,
  and its `until(() => answered + waits.size === WAITS)` held at once. On
  CI, the refused shape's reading was taken with the failed test's waits
  pending. In base run 15, the next shape's reading was taken before its own
  calls were pending, −466.6 KiB, and its clear came before them, so they
  waited out their 30 s: the test took 30.5 s. With every wait keeping
  24 KiB more (the mutations below), the base fails the URL shape and then
  passes `100 header lines of 150 bytes` with −51.9 KiB a call.

### The forced reproduction

Not committed: `PendingWaits.add` in `modules/requests/wait.ts` made, once,
at the 50th wait of the process, an array of 3,000 strings kept for good,
about 820 KiB: the first round of `100 header lines of 150 bytes`, in the
order of the file, after the warm-up's 16 waits and the two shapes' 32.
Two runs each, under the load of the measurement below:

| The file | Result |
| --- | --- |
| the base's, `7c9c5cb` | `ℹ tests 12`, `ℹ fail 1`, both runs: `100 header lines of 150 bytes`, `1530.4` and `1531.3 KiB more held, 95.7 KiB a call`; the refused shape after it `16 calls, 16 pending`, `-611.7` and `-618.8 KiB more held`, its count the failed test's waits, as on CI |
| the fix's, `4b3a199` | `ℹ tests 12`, `ℹ pass 12`, both runs: that shape's round 1 `95.6` and `95.8 KiB a call`, its round 2 `44.5` and `45.1 KiB a call`; the refused shape `16 calls, 0 pending` |

### The mutations

Not committed, in the task's worktree, `modules/requests/wait.ts` changed and
restored with `git checkout` after each, two runs each of

```sh
node scripts/db.mjs task-test 382 -- src/modules/limits/calls-memory.test.ts
```

under the load of the measurement below:

| Mutation | At | Result |
| --- | --- | --- |
| Each wait keeps an extra `Buffer.alloc(64 * 1024)` from `PendingWaits.add` until its `delete` | `4b3a199` | `ℹ tests 12`, `ℹ fail 3`, both runs: the three shapes that wait, each over in all three rounds, 82.4 to 109.4 KiB a call; the refused shape passes, having no wait |
| The same with 24 KiB | `4b3a199` | `ℹ tests 12`, `ℹ fail 2`, both runs: the URL shape and `100 header lines of 150 bytes`, over in all three rounds, 64.5 to 70.6 KiB a call; the reference shape passes at 43.4 KiB a call |
| The same with 24 KiB, one run | `7c9c5cb` | `ℹ tests 12`, `ℹ fail 1`: the URL shape at 67.9 KiB a call; `100 header lines of 150 bytes` passes with `-831.0 KiB more held, -51.9 KiB a call` in 30.5 s, the URL shape's waits counted as its own |

The 24 KiB mutation's lowest round, 64.5 KiB a call, is within a reading's
spread of the bound: the least of three rounds lets through a wait that
reads over the bound in one round and under it in another, a band of the
size of that spread, about 2 to 4 KiB a call, where one reading held to the
bound would fail it more often.

### The measurement

Series of one shell script from the task's worktree, on the agents' Linux
host, an AMD EPYC 7763 with 8 CPUs, Node v24.22.2, the task's own database,
PostgreSQL 16.15, on 2026-11-03 (UTC+3). The load: eight busy loops, one per
CPU, `node -e` running `while (Date.now() < end) {}` until a deadline of
their own, each PID recorded and stopped by it at the end, for every series
and the runs above; the other tasks of the delivery cycle could run beside
them. One fresh run per line, no retries, no run repeated, the command above
for the file of each series. The 1-minute load average is read before each
run.

| Series | File | Time | 1-minute load average | Runs | Failed | Rate (Wilson 95%) |
| --- | --- | --- | --- | --- | --- | --- |
| base | `7c9c5cb` | 05:08–05:15 | 1.1 at the start, rising with the loops; 10.0 to 12.9 from run 9 | 40 | 1, run 15, above | 2.5% (0.4%–12.9%) |
| probe | below | 05:15–05:23 | 11.1 to 13.4 | 30 | 0 | 0.0% (0.0%–11.4%) |
| fix | `4b3a199`'s test file, run in the worktree before its commit at 05:33 | 05:23–05:30 | 10.0 to 12.9 | 40 | 0 | 0.0% (0.0%–8.8%) |
| second probe | below | 05:33–05:41 | 10.5 to 12.5 | 80 | 0 | 0.0% (0.0%–4.6%) |

The probes hold nothing to the bound: what they count is a reading over the
bound, and for the second one a reading 150 KiB over its shape's usual.

The base and the fix cannot be told apart by these rates: 1 in 40 against 0
in 40. What shows that the fix passes a reading of that kind is the forced
reproduction above; what shows it still fails a wait that keeps more is the
mutations.

Each run 8 to 11 s, but run 15 of the base, 39 s. The readings, KiB a call,
least to most:

| Shape | base, 40 runs | fix, 40 runs, round 1 |
| --- | --- | --- |
| two header lines, for reference | 18.8 to 22.0 | 19.1 to 21.1 |
| 100 header lines and a URL of 13,000 bytes | 42.4 to 44.3, and 65.8 once | 42.5 to 44.6 |
| 100 header lines of 150 bytes, as much of 16 KiB as they fit | 44.1 to 44.7, and −29.2 once, run 15 | 44.2 to 44.8 |
| 1,000 short header lines, which 16 KiB allows: refused 431 | 2.5 to 3.5 | 3.0 to 3.6 |

In the fix series no shape needed a second round. A fix run's lines:

```text
✔ keeps at most 64 KiB a wait: two header lines, for reference (351.80379ms)
ℹ round 1: 16 calls, 16 pending: 308.4 KiB more held, 19.3 KiB a call; new_space -0.4 KiB, old_space +286.8 KiB, code_space +13.6 KiB, trusted_space +5.0 KiB, array buffers +0.0 KiB
✔ keeps at most 64 KiB a wait: 100 header lines and a URL of 13,000 bytes (381.694482ms)
ℹ round 1: 16 calls, 16 pending: 691.9 KiB more held, 43.2 KiB a call; new_space -0.4 KiB, old_space +647.2 KiB, code_space +20.1 KiB, trusted_space +22.3 KiB, array buffers +0.0 KiB
✔ keeps at most 64 KiB a wait: 100 header lines of 150 bytes, as much of 16 KiB as they fit (331.10758ms)
ℹ round 1: 16 calls, 16 pending: 715.4 KiB more held, 44.7 KiB a call; old_space +701.3 KiB, code_space +6.3 KiB, trusted_space +7.8 KiB, array buffers +0.0 KiB
✔ keeps at most 64 KiB a wait: 1,000 short header lines, which 16 KiB allows: refused 431 (240.976599ms)
ℹ round 1: 16 calls, 0 pending: 50.3 KiB more held, 3.1 KiB a call; old_space +38.6 KiB, code_space +4.3 KiB, trusted_space +3.9 KiB, array buffers +3.4 KiB
```

The probe, not committed, was the base's wait suite alone, each shape
measured in four rounds, each round printing its growth space by space, a
second reading right after the first, the pool's connections and the
realtime listener's marks at the baseline and the reading, and what was left
once the waits had ended: 480 readings, none over the bound; reference 15.0
to 20.6 KiB a call, the URL shape 40.7 to 43.3, `100 header lines of 150
bytes` 44.9 to 48.9, the refused shape 1.7 to 3.0. The pool held 3
connections at every baseline and reading, and the listener marked no row
seen at any.

The second probe, not committed, was the first in the base's order, one
round of each shape after the same warm-up, its reading compared with a
fixed usual for each shape, 330, 700, 790 and 70 KiB; one more than 150 KiB
over would have written a heap snapshot then, and another at a usual
reading of the same shape in a further round, to tell by their difference
what the bytes were. 80 runs, 05:33–05:41, the load average 10.5 to 12.5,
each run 5 to 7 s: none caught, 0.0% (0.0%–4.6%); reference 18.1 to 23.4
KiB a call, the URL shape 42.4 to 44.5, `100 header lines of 150 bytes`
44.1 to 45.5, the refused shape 3.2 to 4.0.

### The fix

In the test only. Each shape is measured in rounds, `waitRound`: the
session, the baseline, the sixteen calls, the reading; then, however it
went, the clear and every answer awaited, and the answers checked as the
shape's are. A round over the bound is made again, up to `WAIT_ROUNDS`, 3,
and the least is held to the bound, as `withinBound` holds the fastest of
its runs (F-04): a wait that keeps more than `PER_WAIT_BYTES` is over in
every round, and a reading that caught the process's bytes besides the
round's calls is not repeated in the next. The report gives every round, and
each heap space that moved and the memory behind buffers, as in F-18, so
that the next reading over the bound names its space. The base's
`heldBytes` stays for the change and body tests, now through the same
`held`.

`PER_WAIT_BYTES` stays 64 KiB and `WAITS` 16; the four shapes, the check
that each head is under 16 KiB, the `431` and `200 []` answers and the
`waits.size === 0` at the end stay, now checked in each round. The change
and body tests are unchanged.

## F-26 — `reads 5242880 characters of nesting, garbage or an unclosed value as nothing`, in `access-keys.test.ts` and `session-list.test.ts`

- **Test**: `apps/frontend/src/lib/access-keys.test.ts:627` and
  `apps/frontend/src/lib/session-list.test.ts:691` at `bbcf33b`, the base of
  the fix: the last size of the suites `parseAccessKeys: hostile values at
  growing sizes` and `parseSessionList: hostile values at growing sizes`,
  each of whose parses `timed` held to `LIMIT_MS`, 1500 ms, in one
  wall-clock run (`:593` and `:661`). With them, `access-keys.test.ts:479`,
  `reads old and new values of 5242880 characters, hostile or full, in
  bounded time`, which reads the same 5 MiB of nesting, its four calls and
  the building of its values held to 3000 ms (`:493`). Issue #355.
- **Status**: changed in the tests on `chore/hostile-size-test-margin-355`,
  at `33c7c8c` and `9bef555`: nesting stops at 2 MiB, `NESTING_MAX`, in tests
  of its own, `reads <size> characters of nesting as nothing`
  (`access-keys.test.ts:663`, `session-list.test.ts:712` at `9bef555`);
  every other hostile value still goes on to 5 MiB, in `reads <size>
  characters of garbage or an unclosed value as nothing` (`:656`, `:704`).
  `LIMIT_MS` is 3000 ms in both (`:615`, `:667`), 2500 ms at `33c7c8c`. The
  sibling, now `reads full or garbage old and new values of 5242880
  characters, and 2097152 of nesting, in bounded time`
  (`access-keys.test.ts:498`), times its reads and not the building of its
  values, and holds them to 5000 ms (`:516`). The parsers were not changed;
  VERSION kept.

### The failure

Six times in whole runs of the frontend suite on the agents' server, each
time with other suites running beside it, and never in a run of the file
alone:

- `access-keys.test.ts`, `1651.1 ms for 5242896 characters`: the developer
  of #342 on 2026-11-01, at `386a9a02` in qa-tools, before the move (#326),
  one of two whole-suite runs; the file alone passed, 47 of 47.
- `session-list.test.ts`, `1682.7 ms for 5242896 characters`: F-07's
  frontend run at `4e69009` in qa-tools, left there under Watched, and left.
- `access-keys.test.ts`, `1510.7 ms`, and `session-list.test.ts`,
  `2027.6 ms for 5242880 characters`: the developer and the tester of #343
  on 2026-11-03 at `9eb6deeb`, in one of two whole-suite runs each.
- Both at once in this entry's first run at the base, on 2026-11-03 at
  18:37 MSK, `npm test -w @webhook-inspector/frontend` beside
  `node scripts/db.mjs task-test 355`, the 1-minute load average rising from
  2.2 to 14.4: `ℹ tests 2453`, `ℹ pass 2443`, `ℹ fail 2`, `ℹ cancelled 8`
  (the 8 cancelled are llms.test.ts's, Watched, and left):

  ```text
  test at src/lib/access-keys.test.ts:627:5
  ✖ reads 5242880 characters of nesting, garbage or an unclosed value as nothing (1754.708436ms)
    AssertionError [ERR_ASSERTION]: 1752.6 ms for 5242880 characters

  test at src/lib/session-list.test.ts:691:5
  ✖ reads 5242880 characters of nesting, garbage or an unclosed value as nothing (2036.188074ms)
    AssertionError [ERR_ASSERTION]: 2032.6 ms for 5242880 characters
  ```

  The sibling passed in that run, in 2473.7 ms of its 3000.

### The mechanism

A bound with little room over V8's own time, as in F-24. Of the four values
of the test, two are nesting: `[` then as many `]`, alone and as `items`.
V8's JSON.parse builds an array for each `[`, 2,621,440 arrays one in
another at 5 MiB, and the parsers then read `items` and no deeper: the time
is the JSON.parse's. It grows faster than the length. One parse of `[` then
`]` by `parseAccessKeys`, the fastest of five, took 60 ms at 1 MiB, 144 ms
at 2 MiB, 486 ms at 4 MiB and 774 ms at 5 MiB: 60, 72, 122 and 155 ms a
MiB. At 5 MiB a parse took 0.69 to 1.06 s alone, half the bound and more,
and 2.0 s with the suite's other files beside it and another suite beside
them. Every other hostile value of the two blocks took 85.2 ms at most
alone at 5 MiB.

### The measurement

On 2026-11-03 on the agents' Linux host, an AMD EPYC 7763 with 8 CPUs, Node
v24.22.2. The script, outside the tree, builds each value of the two blocks
as the tests do and times one call of `parseAccessKeys` or
`parseSessionList` on it, five rounds; min / median / max in ms, alone at a
load of 0.7 to 1.3, and beside `node scripts/db.mjs task-test 355` at 11.6
to 9.8:

| value | 1 MiB alone | 2 MiB alone | 4 MiB alone | 5 MiB alone | 2 MiB loaded | 5 MiB loaded |
| --- | --- | --- | --- | --- | --- | --- |
| `parseAccessKeys`, nesting | 60.1 / 93.0 / 175.2 | 144.1 / 151.5 / 209.6 | 486.0 / 513.6 / 546.2 | 774.0 / 800.1 / 956.0 | 193.8 / 223.8 / 279.5 | 1087.7 / 1129.5 / 1349.0 |
| `parseAccessKeys`, nesting as `items` | 53.3 / 54.2 / 64.2 | 152.4 / 159.7 / 161.2 | 547.6 / 595.9 / 685.4 | 716.2 / 730.8 / 1063.0 | 179.6 / 204.1 / 231.8 | 998.1 / 1113.5 / 1133.0 |
| `parseSessionList`, nesting | 73.4 / 96.8 / 146.1 | 151.6 / 162.6 / 210.3 | 474.0 / 502.0 / 512.8 | 691.7 / 724.8 / 805.6 | 160.6 / 181.5 / 275.3 | 729.5 / 817.0 / 893.8 |
| `parseSessionList`, nesting as `items` | 95.9 / 100.8 / 105.7 | 143.1 / 164.0 / 169.1 | 481.2 / 499.7 / 714.6 | 718.4 / 760.6 / 794.5 | 155.8 / 190.0 / 206.1 | 855.4 / 912.6 / 1045.3 |
| `parseAccessKeys`, entries, the slowest other value | 9.1 / 10.5 / 12.3 | 17.9 / 19.8 / 20.5 | 46.5 / 49.2 / 59.5 | 49.9 / 56.9 / 64.2 | 23.1 / 28.3 / 31.1 | 85.0 / 95.1 / 121.4 |
| `parseSessionList`, entries, the slowest other value | 19.0 / 24.0 / 28.3 | 25.9 / 27.3 / 31.9 | 54.3 / 56.0 / 72.1 | 73.5 / 75.0 / 85.2 | 26.0 / 46.9 / 105.7 | 74.1 / 95.9 / 116.7 |

In the whole suite the load is heavier than beside one other suite, since
the suite's own files run side by side. Sixteen whole runs of the frontend
suite at the fix's sizes, each beside the backend suite,
`node scripts/db.mjs task-test 355`, two frontend runs to a backend run,
the 1-minute load average between 3.9 and 19.2, each run 47 to 53 s:

- ten with `LIMIT_MS` still 1500 and the sibling as at the base but for its
  nesting: every test of both blocks and the sibling passed in all ten. The
  2 MiB nesting test, two parses, took 497 to 760 ms in `access-keys.test.ts`
  and 452 to 1270 ms in `session-list.test.ts`; the sibling at 5 MiB 891 to
  1615 ms.
- six more of the same tree with a line written after each timed parse,
  not committed: the slowest single parse was 750.6 ms, `parseSessionList`
  on 2 MiB of `[` then `]`; `parseAccessKeys` on the same, 472.9 ms. Of the
  5 MiB values, the entries were the slowest, 323.6 and 504.6 ms; every
  other one took 240 ms or less. The sibling's reads took 844 to 1390 ms,
  the building of its full value before them 159 to 323 ms more.

Each of those sixteen runs exited 1 on llms.test.ts (Watched, and left), and
three of them failed `request-filter.test.ts:307` besides.

### The mutations

Two quadratic forms of each parser, applied in the worktree and reverted,
never committed. The items form keeps the entries in an array and looks for
each id with `findIndex` before adding it, as a list replacing the `Map`
might; the text form, before JSON.parse, looks from each `[` for a `]` after
it, `raw.indexOf(']', i + 1)`, quadratic in the depth of nesting. One run
each, alone, in ms:

| form | value | 64 KiB | 1 MiB | 2 MiB | 5 MiB |
| --- | --- | --- | --- | --- | --- |
| `parseAccessKeys`, items | entries | 3.3 and 9.4 | 639.8 and 707.5 | 2527.0 and 2554.6 | 38020.2 and 39107.9 |
| `parseAccessKeys`, text | nesting | 12.8 and 17.7 | 1769.2 and 1779.7 | 8085.6 and 8214.1 | |
| `parseAccessKeys`, text | nesting as `items` | 7.4 and 7.7 | 1755.2 and 1772.5 | 7899.5 and 7985.7 | |
| `parseSessionList`, items | entries | 13.6 | 1676.3 | 5020.5 | 108484.0 |
| `parseSessionList`, text | nesting | | 1793.5 | 9231.5 | |
| `parseSessionList`, text | nesting as `items` | | 1768.0 | 7559.9 | |

From 1 to 2 MiB the time grows 3.0 to 5.1 times, and from 2 to 5 MiB 15
and 22 times, where n² gives 4 and 6.25.

Against the tests at `33c7c8c`, with `LIMIT_MS` at 2500 ms, each form
applied in turn and its file run
alone, `npm test -w @webhook-inspector/frontend -- src/lib/<name>.test.ts`,
at a load of 1.3 to 1.6; the parser was put back with `git checkout --`
after each:

| form | the file | what failed |
| --- | --- | --- |
| `parseAccessKeys`, items | 49 of 51 passed, exit 1, 138 s | `reads 5242880 characters of entries as at most 100 keys`, `46295.0 ms for 5504957 characters`; the sibling at 5 MiB, `5242880 characters took too long`, in 85.7 s |
| `parseAccessKeys`, text | 49 of 51, exit 1, 24 s | `reads 2097152 characters of nesting as nothing`, `8916.7 ms for 2097152 characters`; the sibling at 5 MiB, `5242880 characters took too long`, in 8.4 s |
| `parseSessionList`, items | 56 of 57, exit 1, 77 s | `reads 5242880 characters of entries as at most 50 sessions`, `72483.2 ms for 5723307 characters` |
| `parseSessionList`, text | 56 of 57, exit 1, 13 s | `reads 2097152 characters of nesting as nothing`, `8087.1 ms for 2097152 characters` |

Each form fails its block, at the largest size only: the items form
passes at 1 MiB, the text form at 1 MiB of nesting.

### The fix

In the tests only. Nesting stops at 2 MiB, where V8 takes a fifth of what
it takes at 5 MiB, and a scan quadratic in the depth already takes 7.6 s or
more; the other values, whose time is the parsers' own, still go on to the
5 MiB a key of `localStorage` can hold at most, where a parse quadratic in
the entries takes 38 to 46 s (`parseAccessKeys`) and 72 to 108 s
(`parseSessionList`). `LIMIT_MS` is 3000 ms: 4.0 times the slowest loaded
parse above, 750.6 ms, and 2.5 times under the fastest quadratic parse of
a value at its largest size, 7.6 s alone, 7.8 s or more in the test runs.
A bound of 1500 ms keeps 2.0 times over that loaded parse, which the load
had made five times its 151.6 ms alone; the 2 MiB nesting passed at it in
all sixteen runs above, but with less room than the load took. 2500 ms,
the first value of the fix,
`33c7c8c`, kept 3.3 times; in the runs at it below, at a load of up to
20.7, the two parses of `access-keys.test.ts`'s 2 MiB nesting test took
1330 ms together, and `9bef555` set 3000 ms. The items form of either parser
at 1 MiB, 0.6 to 1.7 s, passes under every one of these bounds; at 5 MiB it
fails them all. The sibling's time starts once its values are built and
holds its four calls of `removedAccessKeys`, six parses, to 5000 ms, 3.6
times their slowest loaded time above; the block holds each parse to its
3000 ms.

Every test of both blocks and the sibling passed in all 26 whole runs of
the frontend suite at the fix's sizes, each beside the backend suite as
above: the sixteen above, at 1500 ms; six at `33c7c8c`, at 2500 ms, at a
load of 2.1 to 20.7; and four at `9bef555`, at 3000 ms, at 6.8 to 19.0;
each `ℹ tests 2461`, in 47 to 57 s. In the last ten the 2 MiB nesting test,
two parses, took 435 to 1330 ms in `access-keys.test.ts` and 487 to
1347 ms in `session-list.test.ts`; the sibling, the building of its values
in the test's time though not in its bound's, 828 to 2261 ms. So 0 of 26
failed, Wilson 95% 0%–12.9%. No series was run before the fix: the six
failures above were observed in whole runs, not counted against a number of
runs, and this entry's one run at the base failed both files.

Against `9bef555`, at 3000 ms, the four quadratic forms fail the same
tests as at `33c7c8c`, at a load of 1.4 to 2.2, 49 of 51 and 56 of 57
passing, exit 1: `parseAccessKeys`' items form with `41752.7 ms for
5504957 characters` and the sibling in 130.9 s, its text form with
`8082.3 ms for 2097152 characters` and the sibling in 8.5 s;
`parseSessionList`'s items form with `95706.8 ms for 5723307 characters`
and its text form with `7836.5 ms for 2097152 characters`.

### Watched, and left

- `llms.test.ts:640`, `the recipe’s waiting step, run with a stand-in for
  curl (D200)`, failed its `before` hook in every whole run of this entry,
  `jq must be installed`, `spawnSync jq ENOENT`, and its eight tests were
  cancelled: the agents' server had no `jq` on 2026-11-03. The tests require
  it and never skip, by their comment; CI's `test` job installs it. Not this
  entry's; each of these runs exited 1 on it alone.
- Two flakes of this entry's kind in other files of the frontend suite,
  each a one-run bound of 1000 ms on 1 MiB, outside #355's scope: of the 26
  loaded runs at the fix, `request-filter.test.ts:307`, `costs the list
  nothing: a megabyte of one word over 1000 rows`, failed in four, `1096.0`,
  `1100.0`, `1045.0` and `1222.1 ms for 1048576 characters`; and
  `response-template.test.ts:412`, `loses nothing of the line, and stands
  hostile lines at growing sizes in one pass`, in two, `1048576:
  1182.378455 ms` and `1048576: 1114.422662 ms for "{{{{{{{{{{{{"`.
- The backend suite beside them, 13 runs, failed
  `src/modules/webhook/capture-budget.test.ts:960`, `refuses 100,000
  webhooks of one address at once quickly once its line is full, and lets
  the others in`, `refusing the flood took too long`, in nine; and once
  each `src/modules/sessions/access-key.test.ts:473`, `took 108.1 ms at best
  in 5 runs, over the 100 ms bound`; `capture-budget.test.ts:1490`, F-24's,
  `weighing the flood took too long`;
  `src/modules/limits/rate-limit.test.ts:388`, `took 5146.9 ms at best in 5
  runs, over the 5000 ms bound`; and
  `src/modules/requests/request-wait.test.ts:900`, `answered after 5001 ms`.
  Its load was the frontend suite's; not this entry's.
