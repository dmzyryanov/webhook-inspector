# Browser smoke suite

Three journeys through a real browser, a real backend and a real database, and
one check of the API reference page (E2E-04, D155), one of read state
across the tabs of one browser (E2E-05, D156), one of the detail panel's
error state (E2E-06, D169), one of the receiver's sandbox policy in a
browser (E2E-07, D179), one of the request list's filter (E2E-08, D180, D191),
one of a link to one request (E2E-09, D182), one of the changelog page
(E2E-10, D184), one of comparing two requests (E2E-11, D186), one of
checking a signature in the browser (E2E-12, D197), one of the home page's
list of the sessions used in a browser (E2E-13, D199), one of
`Generate URL` that creates nothing (E2E-14, issue #128), one of the about
page and its Russian twin (E2E-15, D211, D255), one of the Terms of Use and the Privacy Policy
(E2E-16, D217), one of the Russian interface and its `EN | RU` switch
(E2E-17, D222), one of the Russian home page at `/ru/` (E2E-18, D226),
one of the View pages of one address within its realtime connections
(E2E-19, D227), one of the new session's options on the home page
(E2E-20, D249) and one of a private session in the interface (E2E-21,
D259).
Every context of the suite is pinned to the `en-US` locale
(`playwright.config.ts`), since the interface follows the browser's languages
on a first visit; E2E-17 opens its own in `ru-RU` and `de-DE`, and E2E-18
one in `ru-RU`.
They
run in CI's `validate` stage and must pass before an image is built or deployed
(D108); on `main` they run again only when the merge request's own pipeline,
which ran them on the same tree, does not prove the commit (D241). This is the whole of the project's end-to-end coverage: the backend
suites cover business logic, and this covers the paths a user would notice first
if they broke.

The tests live in `e2e/`, outside both npm workspaces, and are named
`*.spec.ts`. That is deliberate: the workspaces run `node --test`, whose
discovery picks up `*.test.ts`, and a browser test caught by it would fail with
no browser to run in.

## The three journeys

### E2E-01 — capture, the two tab levels and the response record (`e2e/standard-session.spec.ts`)

Starts on an address the application does not serve and reaches the landing
page through its `Go to home page`, generates a session there, sends a `POST` to
the receive URL the page prints, and watches the row appear. The v0.5.0 coverage
was added inside this journey rather than as a fourth one (D114), and so were
v0.7.1's block measurement (D134), v0.9.0's method header (D139), v0.11.1's
`Raw` of a binary body (D145), v0.12.0's `Page not found` (D146), the
detail panel's time format beside the list row's (D148), v0.14.0's one
scroll per tab (D149), v0.25.0's `Copy as cURL` (D167, a request action
since 0.31.0, D182), v0.26.0's paths
under the endpoint (D173), v0.27.0's privacy footer (D177), v0.28.0's
spacing between the session page's blocks (#96, D177's amendment) and
v0.34.0's `Download JSON` (D185): D108 fixes
the suite at three journeys.

What it pins:

- `Page not found` on `/anything?from=e2e#fragment`: the heading, a request line
  carrying the query and not the fragment, the `404 Not Found` answer line, and
  **no `/api` request and no session WebSocket** once the page has settled. The
  same two lists fill on the session page later in the journey, which is the
  control that makes the empty ones mean something. The dev server answers
  every path `200`, so the `404` status is not asserted here; it is Nginx's and
  is checked with `curl` against the image and production (D146). `Go to home
  page` then has to land on `/`, where the journey continues (D147) once the
  landing page's `Generate URL` shows: the address changes before the landing
  page replaces `Page not found`, so the header and footer checks wait for it;
- the receive URL the page displays is usable as printed, with the retention rule `SESSION EXPIRES 7 DAYS AFTER LAST USE` shown beside it and `KEPT FOR` nowhere — asserted in a browser because nothing else in the project renders a component (D133, D158);
- **the header's links on every page the journey passes** (D158, D184, D209):
  `Page not found`, the landing page and the session page each carry in the
  banner `Changelog` to `/changelog` in the same tab, `Status ↗`, named
  `Status (opens in a new tab)`, to `https://status.qa-tools.ru/`, and
  `API docs ↗`, named `API docs (opens in a new tab)`, to `/docs`, both with
  `target="_blank"`, `Status ↗` with `rel="noopener noreferrer"` and
  `API docs ↗` with `rel="noopener"`, `API docs ↗` focusable from the
  keyboard, and `Webhook Inspector` only once, the wordmark leading to `/`
  (D277); on the session page `API docs ↗` is
  followed, and `/docs` opens in a new tab while the session page stays at its
  own address; then `Status ↗` is followed against a stand-in for the status
  page, which the suite never reaches, and opens in a new tab sending no
  `Referer` at all, so not the session page's address. The landing page
  has no `Custom response` button;
- **the header's layout** (D209, `expectHeaderLayout` in `e2e/helpers.ts`), on
  the session page at 1440, 768, 375, 360 and 320 px: the wordmark from 375 px
  and the 24 × 24 Q mark below, the link named `Webhook Inspector` at every
  width; the wordmark 17 px Semi Bold on one line from 768 px and on two
  lines, 15 px on 17 px lines and 34 px high, from 375 to 767 px, the header
  64 px high from 1024 px and 56 px below (D277); `Changelog`,
  a 1 × 16 divider, `Status ↗`, a divider and `API docs ↗` in that order, both
  arrows 10 × 10, 16 px apart from 768 px and 12 px below, inside the window,
  and nothing scrolling sideways; from 768 px a third divider and the
  `EN | RU` switch close the row on the application's pages, 16 px apart, and
  the static pages have none (D222). It first waits for the switch to be in
  its place (`expectLanguageSwitchPlaced`), so a header read just after a
  resize is the new width's;
- **the privacy footer on every page the journey passes** (D177): on `Page not
  found`, the landing page and the session page, the `contentinfo` landmark's
  `textContent` is the approved line byte for byte — read that way because
  Playwright's text matchers fold a no-break space into a plain one, `About ·`
  before `Contact:` since D211 and `About · Terms · Privacy ·` since D217 —
  `About`, `Terms` and `Privacy` are links to `/about`, `/terms` and
  `/privacy` with no `target` and no `aria-current`, and the address a link to
  `mailto:contact@qa-tools.ru`; at 1440×1024 the band is one 34 px line at the
  bottom of the window, the links and the contact 28 px from the right edge. On the empty session page the band is 34 and 51 px tall at 1440
  and 768 px with the content ending 12 px above it, as it ends at 375 px,
  and 119 px at 360 and 320 px; its height at 375 px, within 2 px of the
  width where the words of 1.15.16 make it a line taller (D265), is not
  asserted; nothing scrolls sideways at any of them; each is measured once
  `EN | RU` is in the band or the header as the width says
  (`expectLanguageSwitchPlaced`, D222); and a request opened at 800, 375 and
  320 px (in the `Copy as cURL` check) is shown without the band;
- **the session page's blocks 12 px apart** (#96, direction B): at 1440, 768
  and 375 px the header, the endpoint card and the panes are 12 px apart, as
  the content and the band are, and the endpoint card is 85, 93 and 154 px
  tall, to half a pixel; at 1440×1024 the list and the detail panel are 12 px
  apart too;
- the documented answer of a default session: `200`, an
  `x-webhook-inspector-request-id` header, an `x-qa-tools-request-id` header
  with the same value (D279), and a body whose `requestId` is that same id
  (D100);
- the row appears with no reload and no interaction — the test sets a value on
  `window` after the page loads and reads it back at the end, so a reload would
  be caught, and it asserts that a frame carrying `request.received` was
  received over the WebSocket;
- a selected request opens on Request → `Raw`, and the panel really holds the
  request line composed at capture time (D049), the header as it arrived, the
  query string and the body. The webhook goes straight to the backend's receive
  listener, as production's go to the receive host, so nothing between them
  changes a header (D187); the header name is still matched case-insensitively,
  which costs nothing;
- selecting another request returns to Request → `Raw` even after a manual
  switch elsewhere, and shows the newly selected request rather than the
  previous one (D107);
- the **first** switch into `Response` lands on `Body`, not on `Raw`, and each
  half then keeps the tab last chosen on it while the other half is on screen
  (D107). This is checked in a browser because it is a rule about two
  uncontrolled tab strips interacting;
- the `Body` view leaves an integer beyond `Number.MAX_SAFE_INTEGER` unchanged,
  character for character. There is no Formatted/Original toggle to drive any
  more (D112), so the assertion is made on the view as it opens;
- **`Copy as cURL`** from the request actions, from `Body` (D167, D182): the
  view strip holds its four views and no `Copy as cURL`, as a tab or beside
  them; `Actions` opens the menu, and with `navigator.clipboard.writeText`
  stubbed to resolve its `Copy as cURL` writes exactly `buildCurlCommand` of
  the request's detail as the API returns it, starting
  `curl '<receive origin>/s/<id>?marker=alpha&attempt=1'` — the origin of the
  session's `receiveUrl`, never the page's (D187) — and ending in `--data-raw`
  with the body, closes the menu and shows the toast `cURL command copied`
  with the check, the view tab still selected; stubbed to reject, the toast
  says `The browser refused the copy. The cURL command was not copied.` with
  the info icon and nothing more is written. At 800 px `Actions` does the same
  on the tablet's row, and at 375 and 320 px `Actions` is gone and the Back
  bar's `⋯` opens the `Request actions` sheet, which takes the toast still
  showing away, and whose `Copy as cURL` closes it and copies the same
  command; each width adds exactly one write, and nothing scrolls sideways at
  any of the three. On
  the Response half the strip has no `Copy as cURL` either, and `Actions`
  opens the same five items. That the commands re-send the request is
  unit-tested through real curl (`curl-command.roundtrip.test.ts`); here it is
  the wiring;
- **`Download JSON`** from the request actions, from `Body`, just before
  `Copy as cURL` so that no toast is up yet (D185): it is the first item after the menu's divider; choosing it closes
  the menu, the browser's download event names the file
  `qa-tools-request-<first 7 characters of the id>.json`, and the file,
  parsed, deep-equals the detail API's answer for that request, `response`
  included. No `/api/` request is made while it is chosen and no toast
  appears. At 375 px the `Request actions` sheet has the same item after its
  divider, closes as it saves the same file, and nothing scrolls sideways.
  The name, the two-space text and the lossless round trip of a binary body
  are unit-tested (`request-download.test.ts`); here it is the wiring;
- the Response half shows a **real recorded body** whose `requestId` is the one
  the sender got in `X-Webhook-Inspector-Request-Id` — which is what distinguishes a
  record from an illustration of the default body — under two header lines: a
  finished write has no third line, and `Client delivery is not confirmed.` is
  nowhere on the page (D158);
- the row reaches its final response state **without a reload**: a
  `response.recorded` frame arrives and the row's status cell settles on the
  recorded status. The backend sends that event only to connections that
  declared support, so this is the one end-to-end proof that the **shipped**
  bundle declares it (D110, D115). The **panel's** half of the same behaviour is
  pinned in E2E-02, which is the only journey that can configure a delay (D125);
- the sender's address as the third segment of the Request half's facts line,
  `HTTP/1.1 · <size> · <address> · <received>`, written in full — it equals the
  whole address the list row carries as its title — with no sender line of its
  own and no country anywhere on the page, the row included (D140, D141);
- the two time formats (D148): the facts line's `<received>` and the Response
  half's `Sent by server · <size> · <time>` (`data-testid="response-state"`)
  read `17 Sep 2026, 14:32:06`, the list row's `data-testid="row-time"` reads
  `2026-09-17 14:32:06`, and the row and the facts line name the same instant;
- **that the code box never scrolls and the tab area is the one scroll** (D134,
  D149), measured rather than described. A body above the 256 KiB ceiling and
  the `Raw` block holding it, a Base64 body and its `Raw`, a re-indented body
  with a long value, a 300-character header value and a 3.8 KB query string
  each have a box (`block-content`) whose `scrollWidth` equals its
  `clientWidth` and whose `scrollHeight` equals its `clientHeight`, a tab area
  (`tab-area`) that never scrolls sideways — and, for the long ones, scrolls
  down through several screens, so the assertion cannot pass on an empty
  block — and exactly the caption the block is expected to have, found as the
  block's own paragraph wherever it is rendered, ending above its box. On the re-indented body, each
  continuation starts two characters deeper than its line (measured in the
  face's own character width, not in pixels) and the value starts on its key's
  row; scrolled into the middle, the copy control is within 16 px of the tab
  area's top with no text under it, and neither strip nor the request header
  has moved. The journey then sets the window to **1440×780**, where the tab
  area must be the panel's only vertical scroll and the page must not scroll,
  and to **1440×1300**, where the box must run on past the tab area's bottom.
  With a `ResizeObserver` that reports nothing swapped in before that request
  is opened, it narrows the window to **1024** and **900** px while the blocks
  still draw what they measured at 1440 px — the frame between a resize and
  its redraw, held still — and the body's lines sixty levels deep must stay in
  the box. Then it restores 1440×1024. The header and the query value wrap in their column
  with their name on one row, a two-row `Query` ends under its last row with
  empty panel below, and the Response half's short blocks are measured too.
  The detail header holds the whole target as its text.
  This is here because no unit test can fail for it — the model's `wrap` is
  unit-tested, but restoring the box's height limit, dropping `wrap-anywhere`,
  removing the control's sticky position or the hanging padding, or rendering
  the caption after the box, drawing it under the box or leaving it out, or
  removing the CSS clamp on the hanging padding or the container query that
  lets a key's start break, leaves them green, and each fails this journey
  (D149). The extra requests are
  sent at the end of the journey, after the counts it asserts;
- **that `Raw` of a binary body keeps its head as text** (D145): the request
  whose body is 8 KiB that is not UTF-8 opens on a `Raw` holding its request
  line and its `Content-Type` header as text, under `Body shown as Base64
  because it contains non-UTF-8 bytes.` and never the old whole-request Base64
  caption, and that block wraps too. The split is unit-tested; this is where the
  browser's own `atob` and `TextDecoder` run it;
- **that a method name stays on one line in the detail header** (D139): an
  `M-SEARCH`, the one accepted name with a break opportunity in it, sent with
  the same long query string, renders `detail-method` no taller than its line
  height. The header's flex row used to fold it after the hyphen beside a
  truncated target. It also shows a non-standard method reaching the receive
  listener;
- **paths under the endpoint and the detail header's target** (D173), the last
  requests the journey sends: ten requests to the receive URL, directly
  (D187) — a short and a long path, each with a short and a long query, a
  path longer than three lines, a query longer than a line, a one-character
  path, a trailing slash, a `PROPFIND` of a WebDAV folder with an XML body and
  a percent-encoded path. Each answers `200`, arrives over realtime with a row
  that holds no `/`, shows its request line in `Raw`, and has a
  `detail-target` whose text is exactly the stored target and which has no
  `title`. The target is measured at 1440, 768 and 375 px: each of
  `detail-target-path` and `detail-target-query` starts a line of its own
  exactly when its unbroken width does not fit in what the line before it left
  free, and never runs out of the target; the path is one line when it fits a
  line and at most three otherwise, cut when longer; the query is always one
  line, cut exactly when it is longer than a line. At 1440 px the short cases
  are one line, the three-line path and the long query are cut, a trailing
  slash stays in `detail-target-session` with no path, and at 375 px the
  session part takes two lines. At 320 px the page does not scroll sideways.
  Then it restores 1440×1024. Removing the clamp, or making the path a block
  of its own, fails it.

The list is also reloaded over HTTP whenever the socket reports `ready` (D077,
D081). That is by design, so the test does not block the list endpoint to force
the realtime path; the window value and the socket frame are the honest proof.

### E2E-02 — the configured response (`e2e/custom-response.spec.ts`)

Creates a default session with **Generate URL** and gives it a custom response
on its page — status `201` and the `2 s` delay picked in the quick switch,
carried into the full editor, where one header and a JSON body are added and
saved — sends a real request to it, and then changes the response of that
running session (issue #36, D150). Until v0.20.0 the session was created
through the landing page's `Custom response` dialog, which is gone (issue #51,
D158); the journey was rewritten rather than a fourth one added (D108). The
change was added inside this journey for the same reason: its subject is the
configured response, and it continues from the session the journey created.

What it pins:

- the landing page has no `Custom response` button, **Generate URL** makes a
  default session (`Default · 200`), and the quick switch's choice reaches the
  editor, whose save relabels the button `Custom · 201 · 2000 ms` and produces
  the configuration it was given;
- before that, **the quick switch's typed status and delay at 1440, 768 and
  375 px** (issue #61, D150, D158): the text and the `Other` / `ms` placeholder
  centred; the border `--color-line` while untouched, `--color-line-strong`
  (`rgb(154, 162, 177)`) while holding a valid value, and `--color-danger` while
  holding an invalid one or typed into and then cleared; the size (60 × 32, 72 × 44, 80 × 44), padding, weight
  and font size D157 set; and the response button outlined in
  `--color-line-strong` at each width. At each width too, the Response queue
  section sits below its own 1 px `--color-line-section` line (`rgb(184, 191,
  204)`), collapsed the first time with no `Set up a queue…`, and its heading
  row, named `Response queue` by reference to the title (`aria-labelledby`),
  never by the example chips beside it, is 44 px tall at 768 and 375 px
  (issue #142, D206). Each opening is closed with Escape, so nothing is
  applied;
- the sender receives exactly that: status `201`, the configured header, and the
  body byte for byte, with no `requestId` folded into it (D100, D101);
- **an open detail panel follows the recorded response without being reselected**
  (D125). The configured delay holds the reply, so the request is selected while
  its response is still `pending`, the `Response` half is opened on
  `Pending · configured delay: …`, and the panel then reaches `Sent by server`
  with **nothing clicked in between** — with no third line (no
  `response-note`) and no `Client delivery is not confirmed.` (D158). This is
  the journey that pins it because it is the only one that configures a delay,
  and a delay is the only way to have a panel open on a request whose response
  has not been written yet;
- **the status pill** (issue #138, D207): while held, the row's `Pending` is
  muted text (`rgb(95, 105, 125)`) with no background; once sent, its `201` is
  the 2xx pill — tint `rgb(225, 242, 232)`, code `rgb(22, 107, 65)` — in the
  row and in the Response half's heading (`response-status`), which reads
  `201 Created` with `Created` beside the pill in ink (`rgb(31, 36, 46)`).
  E2E-08 asserts the row pill's tint too, and no other journey a status colour;
- the response button (`Custom · 201 · 2000 ms`, accessible name ending in
  `Response settings`) opens the quick switch; `204` is unavailable there while a
  body is set and says why on hover; `500` and `None` applied close it, show the
  toast and relabel the button `Custom · 500`, and the next request the sender
  makes gets `500` with the kept header and body; a change held in flight by a
  route stays open through Escape and a click outside and, failed with a
  `500`, says `Could not apply the change` with the choice kept and focus on
  Apply, now `Try again`, where Chromium's disabling had dropped it to the
  body (issue #143, D206);
- `Edit headers and body…` opens `Session response settings` on the form, and a
  header value and the body changed and saved are what the next request gets;
  its save, held in flight by a route and failed with a `500`, keeps the
  editor open, and while `Saving…` shows its fields — the status, the delay,
  header 1's name and value, the body — are drawn as before, computed
  `opacity` `1`, and its inputs stay enabled with their fill white: only its
  buttons wait (issue #250);
- `Default` in the quick switch says the custom response stays saved, the next
  request gets the default `{ ok, requestId }`, and switching back to `Custom`
  restores the edited header and body (owner's rule 1, D151);
- **a second viewer in an independent browser context follows every change** —
  its label reads `Custom · 500` and then `Default · 200` without a reload (a
  value set on its `window` survives to the end), and a `session.updated` frame
  arrived on its own socket, which it declared (D152);
- **the response queue's happy path** (0.46.0, D205): the quick switch's
  queue section, collapsed the first time, is opened by its heading row
  (`aria-expanded` from `false` to `true`, 0.47.0, D206), and its
  `Set up a queue…` opens `Response queue` with `Save queue` unavailable, `+ Add
  step` adds a copy of the session response (`500`), changed to `503`.
  **The steps are read only while a save is in flight** (issue #234, as the
  rules dialog's below): a second step, `404`, is added and `Save queue`,
  double-clicked, is held by a route — one `PUT …/queue` — while `Saving…`,
  the selected step's fields (the status, the delay, `+ Add header`, the
  header's name, value and `Remove header 1`, the body), `Duplicate`, `Remove
  step`, `+ Add step`, `Cancel` and the close control are disabled, the
  fields in a group named by the step's heading (`Step 2`); a forced click
  into the status with a key typed, Enter and Space, and forced clicks on the
  two links change nothing, and step 1, selected meanwhile, shows `503`, read
  only too. **Locked, the text fields read as locked** (issue #250): the
  status, the delay, header 1's name and value and the body each have the
  computed `opacity` `0.6` while `Saving…` shows, as the dialog's disabled
  buttons do. Failed with a `500`, the footer says `Could not save the queue.
  Your steps are kept — try again.` with `Try again`, every control is
  enabled again, the same text fields at `opacity` `1`, and both steps are
  kept. Step 2 is removed and `Try again` held the same way; at 375 px step 1
  opens as a screen of its own (group `Step 1 of 1`) with its fields,
  `Duplicate step` and `Remove step` disabled, the text fields at `0.6`, and
  `‹` and `Done` each go back to the list. Failed there too, the footer says
  so and step 1's screen, opened again, has its fields enabled and at `1`.
  Back at the project size `Try again`, held once more, is let through, which
  closes the dialog with its toast and
  relabels the button — and the other viewer's — `Custom · 500 · 1 queued`; the next request gets
  `503` with the kept header and body, both labels drop the suffix with no
  reload, that request's `Response` tab names `Queue step 1 of 1`, and the
  request after it gets the session's `500` again, with no `session.updated`
  published for either capture. Then **the used-up queue is removed from the
  section** (0.47.0, D206): reopened, the quick switch shows the section
  expanded as it was left, its heading row named `Response queue Done`.
  **Focus stays in the quick switch** (issue #143, D206): `Run again`, held
  by a route and failed with a `500`, says `Could not start the queue again.
  Try again.` with focus back on `Run again`; sent again with `Enter` and
  failed while the viewer focuses the language switch, it leaves focus there;
  with focus on `Run again`, a restart sent through the `request` fixture
  starts the queue from step 1, `Run again` and its message go and focus is
  on the heading row; and `Run again` held once more, a click on the
  popover's title focuses the popover itself (its content has
  `tabindex="-1"`), a restart sent meanwhile moves focus to the heading row,
  and the held call fails with no message and focus still there. After each
  restart a capture uses the queue up again, publishing nothing. Then
  `Remove queue` asks `Remove the step?` with focus on `Keep queue`, which
  puts the links back with focus on `Remove queue`. **The question cannot be
  skipped** (D206 point 5): a double-click near the right end of `Remove
  queue`, whose second click lands on the question's `Remove`, and two clicks
  there 300 ms apart each leave the question asked, `Remove` enabled and no
  `DELETE` sent. Half a second later a deliberate `Remove` is sent, held in
  flight by a route (`Removing…`, disabled) and failed once with a `500`: the
  row says `Could not remove the queue. Try again.`, with `Try again.` on one
  line, beside `Keep queue` and `Try again`, which has the focus Chromium
  dropped to the body while the button was disabled. With the route gone,
  `Try again` removes the queue and leaves the quick switch open with the
  section showing `Set up a queue…`, no `Remove queue`, focus on the heading
  row, two `DELETE`s sent in all, and the other viewer receiving the
  removal's `session.updated`, its eighth after the two restarts'. Expanded,
  the section is still expanded after a reload, `qa-tools:queue-section`
  holding exactly `{"v":1,"open":true}` — read back from `localStorage`, not
  the page's memory — and collapsed, it is still collapsed after one, holding
  `{"v":1,"open":false}` (issue #143). It is part of E2E-02, not a new
  journey (D108).
- **the response rules' happy path** (1.5.0, issue #226 over D246): the
  quick switch's `Response rules` section, under the queue's and collapsed
  the first time, named `Response rules`, is opened by its heading row and
  says `No rules yet. …`; `Set up rules…` opens the Response rules dialog
  (`No rules yet`, `0 / 20`, `→ the session response, Custom 500`). Two
  rules are added: `POST` `orders` → `201` with a body, and `GET` with the
  path `status?x=1`, refused at its field — `aria-invalid`, `Leave out ? and
  what follows it: the query is never matched.`, `Fix rule 2 to save the
  rules.`, `Save rules` disabled — then `/status`, taken (`aria-invalid`
  `false`) but said under the field (`rule-path-warning`: `The receive URL
  before the field already ends in /, so this matches only a path that
  starts with //. …`), then `status`, the warning gone, → `200` with another
  body.
  `Move rule 2` with `ArrowUp` puts `GET /status` first, focus following it
  to `Move rule 1`, whose `⋮⋮` has `cursor: grab`, its own utility winning
  over the base rule's `pointer`, which the rule's row beside it has (issue
  #246), and a mouse drag of that `⋮⋮` to the bottom of the second
  row puts it back. Rule 2's method is then typed under `Other` as `GET`, the
  method its chip sends, its row still `GET /status`. `Save rules`, its `PUT
  …/rules` held by a route, reads `Saving…` and leaves nothing to edit while
  it waits: the method chips, the typed method, the path, the status, the
  body, `+ Add header`, `Duplicate`, `Remove rule`, `+ Add rule`, both `⋮⋮`
  and `Cancel` disabled, and a drag of a `⋮⋮` moves nothing. **Its text
  fields read as locked** (issue #250): the typed method, the path's
  bordered box — read on the box, which carries the class, around the
  session's URL and the borderless input — the status, the delay, header 1's
  name and value and `Body · Optional` each have the computed `opacity`
  `0.6`. Failed with a `500`, the footer says `Could not save the rules.
  Your rules are kept — try again.`, every one of those controls is enabled
  again and the text fields are at `1`; `Try again`, held the same way, has
  them at `0.6` again and, answered, closes the dialog with `2 rules saved.
  Requests captured from now on are checked against them first.`, the button
  and the other viewer's read `Custom · 500 · 2 rules`, and the other viewer
  receives its ninth `session.updated`. `POST …/orders?attempt=1` gets `201`
  and its body, `GET …/status` `200` and its body, `POST …/other` the
  session's `500`, publishing nothing. Their list rows carry the rule
  marker (`row-rule`, issue #233) — `R1` and `R2`, titled `Answered by rule
  1` and `Answered by rule 2`, the rows' accessible names saying so and no
  `R1` — on this page and, with no reload, on the other viewer's, the third
  row and every earlier one none; unread, the tag is white, and on the
  desktop it is 14 px tall, 4 px after the pill and 8 px before the address,
  the row still 57 px and its rule. Their Response tabs read `Rule 1 ·
  POST /orders` and `Rule 2 · GET /status` (`response-rule`), and the third
  none, no queue step either; the tag of the selected row and of a row
  opened before is `--color-panel-note`, the other viewer's still white. At
  320 px, the list's answer rewritten by a route so the first row is the
  worst case of frame N1 — rule 20, a `404`, the sender
  `2a02:6b8:b010:a4fc::1f5` and `1018.4 KB` — that row and the `R2` one keep
  76 px, the time 16 px from the edge with the `×` glyph under its end, line
  2 clear of the `×`, the tag 4 px after the pill and 8 px before the
  address, nothing cut but the address and nothing sideways; the route
  removed and the page reloaded, `R1` is back. Then, on the list, the sheet's section
  (`Response rules 2 rules`) and the rules full screen scroll nothing
  sideways (criterion 7). Back at the project size the section opens as
  left, lists `1 POST /orders → 201` and `2 GET /status → 200` and `Every
  other request → the session response.`, `qa-tools:rules-section` holding
  `{"v":1,"open":true}`; `Remove rules` asks `Remove all 2 rules?` with focus
  on `Keep rules`, and `Remove`, half a second later, removes them: `Set up
  rules…` again, the label and the other viewer's back to `Custom · 500`, a
  tenth `session.updated`, and `POST …/orders` answered `500`. Before that,
  at 1440, 768 and 375 px, the typed-field pass checks the rules section's
  own 1 px `--color-line-section` line, its collapsed state with no `Set up
  rules…`, its name and its 44 px heading row below 1024 px. A
  `session.updated` without `rules`, which only an image before 1.3.0 sends,
  is not produced here: `session-response.test.ts` takes one, a read and an
  answer through the same library calls, in the same order, as the page's
  handlers make them.
- **response templates in the editor** (1.11.0, issue #236 over D251), a
  second test of the spec, on a session of its own, part of E2E-02 rather
  than a new journey (D108): in `Session response settings` the box `Fill in
  placeholders from the request` is unticked, with no `Insert placeholder`,
  no hint and no `Returned exactly as entered`, and `{{request.foo}}` is
  text; ticked, the hint appears and the same body is `Unknown placeholder
  {{request.foo}}.` with `Save response` disabled. The body is then built by
  typing and the menu — `Request id` and `Method` leave the caret after them,
  `Query parameter…`, `Header…` (over a selection, `XX`) and `JSON body
  field…` before their `}}`, each `Finish …` said until the name or path is
  typed, and focus is back in the body after every choice — and Escape gives
  focus back to the menu button. At 375 px the list is the sheet `Insert
  placeholder`, its six items in order, and `Path` lands where the caret was.
  Saved, the quick switch shows `Template` right of `Edit headers and body…`;
  `POST …/orders?page=7` with `X-Trace-Id` and a JSON body gets
  `{"id":"<its id>","method":"POST","page":"7","trace":"t-1","order":"ord_1"}`,
  the Response half shows that body and no `{{request.`, and the reopened
  editor is ticked on the saved body. A queue step added from it is ticked,
  unticked and ticked again around a new body, and `Save queue` sends
  `template: true`; the section's chip reads `201 · Template`, `Edit queue…`
  shows it ticked, and `GET …/ping` gets `201` and `{"step":"GET"}`. A rule
  `POST` `orders` → `202`, its body from the menu's `Path`, sends `template:
  true`, is listed `1 POST /orders → 202 Template`, reopens ticked and answers
  `POST …/orders` with `{"path":"/s/<id>/orders"}`. Cleared and saved, the
  session response loses its tag and `GET …/other` gets the body as typed,
  placeholders and all.
- **a refusal marked at the rule or the step it names** (1.14.0, issue #232
  over D257), a third test of the spec, on a session created with two rules
  and a queue of two steps, part of E2E-02 rather than a new journey (D108).
  Every save is answered by `page.route` with a `400` / `1005` that carries
  `field`, since the page's own checks refuse what a server would: with Rule
  1 selected, `Save rules`, sending both rules, is refused at `rules[1].path`
  — Rule 2 is then selected and its row in error (`has an error` in its
  name), Rule 1's not, `Path` keeps `status` with `aria-invalid` and the
  server's message as its description, the footer says `The server rejected
  rule 2. Fix the marked field and save again.`, and `Try again` is enabled.
  The first edit of the path takes the mark, the message and the footer away,
  `Save rules` enabled again. The queue's `Save queue`, refused at
  `steps[1].delayMs`, does the same for Step 2 and `Delay` (`2000`), the
  footer `The server rejected step 2. …`, and an edit of the delay clears it.
  In Russian both footers are Russian — `Сервер отклонил правило 2.
  Исправьте отмеченное поле и сохраните снова.`, `Сервер отклонил шаг 2. …` —
  and the message the server's, as it came. At 375 px the refused rule's row
  is marked in the list with the footer said and nothing opened (no `Path`);
  opened, its screen shows the mark and the message, and `Back to the rules`
  keeps the footer. The English refusals and the phone's are each one `PUT`,
  and the page raises no error.

The delay is the one piece of response timing in the suite and is deliberately
small: one worker and no retries (D108) mean every run pays it. It is not a
performance assertion — nothing here measures how long anything took, only that
the panel arrives at the recorded response on its own. The removal's guard adds
two fixed waits, 300 ms between the two clicks the guard must set aside and
500 ms before the deliberate `Remove`, because the guard itself is a matter of
time (D206 point 5); the first leaves about 200 ms of margin under the guard's
500 ms for the input to reach the page on a loaded CI runner.

### E2E-03 — `Delete all` (`e2e/delete-all.spec.ts`)

Sets up a session with three captured requests over the API, opens it, and
deletes them.

What it pins:

- the confirmation dialog is required, and the confirm button inside it is what
  performs the deletion;
- the list empties, the counter returns to `0 / 1000 requests`, and the empty
  state reappears;
- `Delete all` stays visible and becomes disabled at zero requests, which
  differs from the design file and is the approved behaviour (D071);
- the deletion reached the server: the request list is asserted to hold three
  items over the API before the deletion and none after it, and the emptiness
  survives a page reload. The assertion before the deletion is what makes the
  one after it meaningful — without it, a mistyped id or a changed response
  shape would pass silently;
- before `Delete all`, the touch row of issue #55 (D157): a fourth request is
  captured and every row is measured at 375 and 393 px — 76 px high, the full
  time on line 1 ending 16 px from the row's edge, line 2 16 px under it and
  clear of the `×`, the `×` a 44 × 44 target in the bottom-right corner that
  starts below line 1 with its glyph ending where the time ends, nothing
  clipped and no sideways scroll; 320 px does not scroll sideways, 768 px keeps
  the tablet's 64 px row with the `×` beside the time, and 1440 px the
  desktop's 57 px row with its 30 px mark. A tap on a phone row just left of
  the `×` opens the request, `‹ Requests` returns, and a tap on the `×` deletes
  that request at once (D029), leaving the three. Nothing compares pixels.

A second test in the same file drives **two viewers of one session in two
independent browser contexts** — two `browser.newContext()` calls, so nothing
but the server is shared between them (issue #7, D135–D137). It pins:

- deleting a request in one viewer removes its row in the other, with no reload
  (a value set on the observer's `window` survives to the end);
- the observer had that request's detail panel open, and it returns to
  `No request selected`;
- `Delete all` in one viewer empties the list in the other;
- the acting viewer shows no duplicate row and no error after its own event, and
  neither page raises a page error;
- the observer still receives a capture made afterwards.

A third test cuts one viewer's socket with Playwright's `routeWebSocket` and
refuses its reconnections while the session is emptied over the API and a new
request is captured (issue #39). Once the socket is let back, it pins that the
reload on `ready` replaced the list: the deleted rows are gone, the new request
is listed, the counter reads `1 / 1000 requests`, the open request's panel
returned to `No request selected`, and the page was not reloaded.

A fourth test deletes a whole session over the API, `DELETE
/api/sessions/{sessionId}`, while one tab is open on it and a second tab of the
same browser is open on another session (issue #102, D198). With both sockets
subscribed first, it pins that the deletion answers `204` with no body; that the
tab on the deleted session shows `Session not found` with the sentence `It was
most likely deleted, on purpose or after going unused for the time chosen when
it was created, together with its requests and response settings.`, with no
digit in it (since 1.15.16, D265; from 1.7.0, D249, it added `(7 days unless
set otherwise)`, and until then read `… or after 7 days without use, …`), at
the same address and without a reload —
the `4404` the backend closes its socket with, read as the end of the session
(D076); that the session's request list then answers `404` / `1001`; and that
the other tab still shows a request captured afterwards. The interface has no
delete control (issue #102, Decision 6), so the deletion is made as a CI run
would make it.

These are part of E2E-03 rather than a fourth journey (D108): they are the same
subject, in the file the owner named for it.

### E2E-05 — read state across the tabs of one browser (`e2e/read-state.spec.ts`)

Issue #46, D156. Tabs are pages of **one** browser context, which is what
shares `localStorage`. Two tabs show one session with three unread requests; a
third shows another session. Tab B opens a request of its own, then tab A opens
another, and it pins:

- in B, the row A opened loses its unread shading and the title count goes
  down, with no reload (a value set on `window` survives), and B's own
  selection and detail panel stay as they were (criterion 1); B's earlier
  opening reached A the same way;
- the tab on the other session keeps its shading and count (criterion 3);
- a page in a separate browser context — another browser, profile or private
  window — still shows all three unread: nothing went through the server
  (criterion 5);
- after a reload of B, and in a tab opened later, both opened rows are read and
  the count is `(1)` (criterion 4).

A request opened before it reached another tab (criterion 2) and unavailable
storage (criterion 6) cannot be staged reliably in a browser; they are unit-tested
in `apps/frontend/src/lib/read-state.test.ts`.

### E2E-06 — a request the panel cannot draw (`e2e/panel-errors.spec.ts`)

Issue #59, D169. Components are not unit-tested (D070), so the detail panel's
error boundary is checked here, in a spec of its own like E2E-04 and E2E-05. It
pins:

- the issue's own body, `[` × 20 000 + `]` × 20 000 (40 KB), which used to throw
  `RangeError: Invalid string length` and blank the page: `Body` shows it as
  stored under `Formatting unavailable: JSON nested more than 100 levels deep is
  shown as stored.`, and the header, the endpoint card and every row stay on
  screen;
- a request whose drawing throws. No body is known to do that any more, so the
  test changes one request's detail on its way to the page with `page.route`:
  the real answer, fetched from the backend, with `headers: null`, which throws
  while its blocks are built. The panel shows `Could not load request details`,
  `Your selected request is still in the list.` and `Retry`; the header, the
  endpoint card and every row are still there and the row is still selected;
- **that the boundary caught it, every time the state appears.** A drawing
  failure and a failed load draw the same state, so the screen cannot tell them
  apart: an answer that stopped loading would keep the spec green with the
  boundary gone. The spec therefore also requires, after each appearance, a new
  console error from React ending `React will try to recreate this component
  tree from scratch using the error boundary you provided, RenderBoundary.`,
  which a failed load never produces. That is the development build's wording,
  and the suite runs the dev server. Served as a `500` instead, the same steps
  leave the state on screen and fail with `RenderBoundary caught nothing`;
- another request selected after it opens normally;
- `Retry` loads the same request again — a new detail request each time,
  counted — and returns to the error state while the answer still throws, and
  to the request's details once it does not;
- no reload (a value set on `window` survives) and no uncaught page error;
- at 375 px, the error state under the Back bar, `‹ Requests` returning to the
  list, and the next request opening normally (frame `3I`, D157);
- **an address in a shape the contract does not allow costs nothing** (issue
  #245, v1.15.2). Four requests are sent; `page.route` hands the page the real
  list answer with three of them carrying `sourceIp` `123`, `{}` and `[]`, and
  each of those three's detail answer the same way. Each used to blank the
  page as the list drew — the number and the object with `sourceIp.slice is
  not a function`, the array with `text.toLowerCase is not a function` in the
  filter's row texts — and the number and the object failed to draw in the
  panel. The page renders
  with every row; each of the three rows reads `IP unavailable` and the fourth
  keeps its real address — the control that the route changed only what it
  names; `unavailable` in the filter keeps the three and hides the fourth, and
  one row's full id keeps only that row; each of the three opens on its own
  target and `Raw` with ` · IP unavailable · ` in its facts line and no error
  state, three routed detail answers counted; and there is no reload, no
  `RenderBoundary` catch and no uncaught page error. The `request.received`
  event, which passes through the same read, is unit-tested through
  `routeServerMessage` in `apps/frontend/src/lib/requests.test.ts`. On the
  frontend of 1.15.1 the test fails at its first look at the page, which is
  blank.

The dev server also echoes those console errors into the run's log, as
`[console.error] TypeError: Cannot read properties of null` followed by React's
sentence about `RenderBoundary`. That output is expected from this spec and is
not a failure.

### E2E-07 — a receive URL opened in a browser runs nothing (`e2e/receiver-sandbox.spec.ts`)

Issue #91, D179. A custom response may carry any body under any configured
`Content-Type`, so a session can answer HTML, SVG, XHTML or XML from the
receive host — since 0.36.0 an origin of its own (D187) — and what keeps that
harmless is the
`Content-Security-Policy: sandbox; default-src 'none'` the receiver puts on
every answer. The backend suite pins the header; only a browser can show what
it does. For each of `text/html`, `image/svg+xml`, `application/xhtml+xml` and
`text/xml` (a document in the XHTML namespace), the spec creates a session over
the API whose body carries a script that logs a marker to the console and writes
a key to `localStorage`, and opens the receive URL in the page. It pins:

- the answer as the receiver sends it: `200`, exactly the configured
  `Content-Type`, the policy and `nosniff`;
- the content is shown — the document's text is visible;
- no marker is logged; the document has no storage of its own — reading its
  `localStorage` throws, as it does for a sandboxed document with an opaque
  origin — and the key is not in `localStorage` on the application's origin,
  read from the application's own page afterwards;
- **the control**: the same answer, fetched from the receiver with
  `page.route` and handed to the page with the policy removed and nothing else
  changed, logs the marker and writes the key on the receive origin, read in
  that unprotected document. Without it, a document the browser refused for
  another reason would pass the check with the policy gone.

### E2E-08 — the request list's filter (`e2e/request-filter.spec.ts`)

Issue #70, D180, and issue #78, D191. The filter runs in the browser over rows
the page already holds, and asks the server which requests hold a word in
their headers or body. The unit tests pin the matcher, the searchable-word
rules and when the server is asked; only a browser shows the header turning
into the field and a row arriving from a search. On a session holding a
request to `/s/<id>`, two to `/s/<id>/stripe/events` and one whose body holds
the token `tok-48213-zq`, the spec pins:

- the search icon opens the field empty and focused, with the placeholder
  `Search the list, headers and bodies`, the `Requests` heading kept for
  assistive technology, and Escape on the empty field brings the heading back;
- typing `ev`, a word under three bytes, narrows the list to the two paths
  and sends no request to `/api/`, the search's 400 ms pause having passed;
- typing `stripe` — a path, which no row shows — leaves the two rows, reads
  `2 of 4 / 1000` and highlights nothing, and the page then makes exactly one
  call to `/api/`: a `POST` to `…/requests/search` with `{"words":["stripe"]}`
  in its body and the word in no URL; no spinner and no notice show;
- the Delete all dialog names the total and the two requests the filter hides;
- typing the token finds the one request whose body holds it, `1 of 4 / 1000`,
  with no `mark` in its row; `POST` beside it highlights the method alone; the
  token in capitals finds nothing, and the empty result adds
  `Headers and bodies were searched too.`;
- a query nothing matches shows `No requests match “…”` and never
  `Waiting for the first request`;
- the filter survives a reload with the field showing it, the matched method
  highlighted; `200` then highlights the code inside the row's status pill,
  which keeps its 2xx tint (`rgb(225, 242, 232)`, issue #138, D207); another
  session opens unfiltered; a reload under the
  token's filter finds the request again with no typing, and a webhook sent
  then, its body holding the token, appears, `2 of 5 / 1000`;
- `×` restores every row and the heading;
- with the search route answered `404` / `1000`, as a backend on the previous
  image answers it, the notice reads
  `Headers and bodies not searched: the search failed.` over the two rows the
  path matches; with no list-field match the reason and **Retry** are in the
  empty result, and Retry, the route answering again, finds the body;
- nine searchable words show `more than 8 words.` without Retry and send
  nothing;
- at 375 px the placeholder is `Search, bodies too`, and nothing scrolls
  sideways at 320 px: with the field open, with a query wider than the field,
  and with a word over 200 bytes in the empty result.

The spinner of a search slower than 300 ms, the `429` and `503` answers and
their texts are not driven here: the controller's unit tests
(`apps/frontend/src/lib/raw-search.test.ts`) and the backend's
`request-search.test.ts` pin them.

### E2E-09 — a link to one request (`e2e/request-link.spec.ts`)

Issue #71, D182. Building and reading the link, and the push flow's entry for
a request opened from one, are unit-tested (`request-link.test.ts`,
`push-flow.test.ts`); only a browser has an address bar, a clipboard and a
Back button. The clipboard is the browser's own, the permission granted to the
context, except where a refusal is driven by a stub. Three tests, on fresh
sessions:

- **the menu and the sheet**: `Actions` opens with Enter on `Copy link`, the
  arrows move down through the first three items, `Download JSON` after the
  divider, and back up — the menu lists five, `Check signature…` (D197)
  before `Compare with…` (D186), which is last — Escape closes it with focus back on
  `Actions`; Space opens it and Enter chooses `Copy link`, which closes it,
  returns focus and shows `Link copied`, and the clipboard then holds
  `<origin>/v/<session>#<request>`. The Response half has the same five items.
  A refused write shows `The browser refused the copy. The link was not
  copied.` with the info icon, and the clipboard keeps what it held. At 375 px
  `Actions` is gone and the Back bar's `⋯` opens the `Request actions` sheet
  with the five items; a tap on the scrim and Escape each close it with focus
  back on `⋯`, and its `Copy link` closes it and copies the link. At 320 px
  the bar holds `‹ Requests`, `1 of 2` and the whole of `⋯`, and nothing
  scrolls sideways with the sheet open or closed;
- **opening a link**, each time from `/` as a new document: at 1440 px the
  request is open, selected and read (the tab title counts one unread, the
  other request), the address reads `/v/<session>` with no `#`; selecting
  another request leaves the address, a reload shows `No request selected`,
  and Back leaves the session, as it does when the link is opened with nothing
  else done. At 768 and 375 px the request opens under the Back bar at `1 of N`
  with no `#` in the address, Back returns to the list with the row read, and
  the next Back leaves the session. `history.state` keeps the router's fields
  through the fragment's removal, with the push flow's marker on the pushed
  entry: `idx` at 768 px, and at 375 px `usr`, `key` and `idx`, which an init
  script gives the link's entry first, since a document opened at an address
  carries only `idx`;
- **a stale, a malformed and a filtered link**: a link to a deleted request
  shows the list, nothing open and the toast `The linked request is no longer
  in this session.` with the info icon, at 1440 and 375 px, the address
  without the fragment; `#not-a-request`, an empty `#` and a request id with a
  character after it are each dropped from the address, with no toast and
  nothing open; with the list filtered to `stripe`, a link to a request the
  filter hides opens it and the filter stays.

### E2E-10 — the changelog at `/changelog` (`e2e/changelog.spec.ts`)

Issue #97, D184. The parser, the renderers, the check that nothing internal is
published and the nginx locations are unit-tested (`changelog.test.ts`,
`changelog-controls.test.ts`); only a browser runs the page's script, opens a
`<details>` and lays it out. Two tests:

- **the page**: `/changelog` and `/changelog/` answer `200` HTML with
  `no-cache` and no `X-Robots-Tag`, and `/changelog.md` `text/markdown;
  charset=utf-8`; `/changelog.xml` and `/changelog-breaking.xml` answer
  `application/atom+xml; charset=utf-8` with `no-cache`, an Atom feed whose
  entries are, in order, every version the text lists and only those with a
  Breaking, Deprecated or Notice paragraph (D212, D224); the page's head names
  both feeds and its subscribe line links both; the page lists every version
  the text lists, in its order, only the newest open; a line opens to its
  entry; `Breaking only` leaves exactly the versions with a Breaking,
  Deprecated or Notice paragraph,
  each with its label, and no empty day; `Expand all` opens every line and reads `Collapse all`, which
  closes them; `Changelog` in the header carries `aria-current="page"` and
  neither `Status ↗` nor `API docs ↗` does, both opening a new tab, with the
  service's name only in the wordmark, which leads to `/` (D277); nothing scrolls sideways at 1440, 768, 375, 360 and 320 px with every
  line open, and the header keeps E2E-01's layout at each (D209); the whole
  browser context reaches no other
  origin; and with JavaScript off the toolbar is hidden and a line still opens;
- **the way there**: `Changelog` in the landing page's header opens the page in
  the same tab.

The header's `Changelog` link on the other pages, at every width, is checked
by E2E-01's header check.

### E2E-11 — comparing two requests (`e2e/compare-requests.spec.ts`)

Issue #75, D186; Figma `Webhook Inspector · Compare requests`, direction A.
The line model, the fold rule, the changed characters, the limits and the
edit limit are unit-tested (`request-diff.test.ts`); only a browser has a list
to pick in, a Back button and a layout that can scroll sideways. Two requests
are sent per session, differing in one JSON value, the `X-Attempt` header and
the `attempt` query parameter. Two tests:

- **1440 px**: `Compare with…` is the last item of `Actions`; choosing it
  turns the list header into `Compare with…` / `Choose a request for POST
  <short id>` with `Cancel` and no `Delete all`, no row shows `Delete
  request`, and the open row is `aria-disabled`, named with `open request,
  cannot be chosen`, keeps the arrow cursor (`default`) while a candidate
  has `pointer` (issue #246), and a click on it chooses nothing. Escape and `Cancel` each end picking with the exchange back. The
  filter narrows the candidates, and choosing a row sends exactly one request
  to the API, the chosen request's details. The comparison's two lines show
  the open request `−` with `open` and the chosen one `+`, both list rows carry
  their mark, it opens on `Body` with a dot on all four views, and `Body` has
  exactly one removed and one added line with `4200` and `"42.00"` underlined;
  `Headers` has exactly the changed `content-length` and `x-attempt` pairs,
  `Query` the changed `attempt`, and `Raw` the changed request line, with the
  blank line between the head and the body drawn, every row of the `Raw`
  comparison at least one 20 px line tall. `Change`
  picks again, and Escape, then `Cancel`, each bring the comparison back on
  `Raw`; `Close comparison`
  returns to the exchange and the marks go; with the older request open and
  the newer chosen, the open one is still `−`; a click on another row opens it
  and ends the comparison. A chosen request deleted through the API while
  compared shows `POST <short id> is no longer in this session.` and `Choose
  another`, which picks again; an identical request then shows `The two
  requests are identical in every view.`, no dot, `Body`, and a fold whose
  `Show` draws the lines;
- **375 px**: `⋯` lists `Compare with…` last; choosing it shows the list
  screen in picking mode with `Tap a request for <short id>` and no Back bar,
  with no sideways scroll; the browser's Back returns to the open request, and
  so does `Cancel`; a tapped row shows the comparison under the Back bar,
  opening on `Body` with both values underlined, with no sideways scroll at 375
  and, on `Raw`, at 320 px; Back from the comparison returns to the list.

### E2E-12 — checking a signature (`e2e/check-signature.spec.ts`)

Issue #74, D197; Figma `Webhook Inspector · Check signature`, direction B.
The HMAC against RFC 4231 and RFC 2202 vectors, the reading of a header value,
the preselection, the wording and the bytes signed are unit-tested
(`signature.test.ts`, `received-body.test.ts`); only a browser has a network
log, storage, an address bar and focus. Every request and every WebSocket
frame the context sends is recorded, as E2E-04 records them (D155), and the
test fails if any carries the secret. Three tests:

- **1440 px**: five requests are sent — a GitHub-style JSON body with
  `X-Hub-Signature` (`sha1=`) before `X-Hub-Signature-256` (`sha256=`), 2048
  bytes that are not UTF-8 with an `X-Signature` in Base64, a JSON body after
  a byte-order mark with an `X-Webhook-Hmac` of HMAC-SHA512 in upper-case hex,
  a `GET` with no body, and a text body with no signature header. `Actions`
  lists `Check signature…` after `Download JSON`; choosing it opens the
  `Check signature` popover with the secret field focused, empty and masked,
  the warning beside it, `Type the secret to check.`, `X-Hub-Signature`
  preselected and SHA-1 with it. Typing the secret shows `Match`, `HMAC-SHA1
  … · hex · X-Hub-Signature`; choosing `X-Hub-Signature-256` switches to
  SHA-256 and still matches. The eye shows and hides the secret. Another
  secret shows `No match`, the computed `sha256=…` that the copy icon writes
  to the clipboard, and the hint naming Stripe, Slack and Standard Webhooks.
  The verdict and the line under it are a live region (`role="status"`)
  without the computed value, and once the copy has said `Copied` no live
  region is nested in another.
  **From opening the check to closing it, the context sends no request.**
  Escape, `×` and a click on the request's facts line each close it with focus
  back on `Actions`; reopened, the header has focus and the result is there at
  once. Chosen on the Response half it checks the request; a click on another
  request closes it, and opened there the binary body matches, `2,048 bytes ·
  Base64`, with the same secret; the byte-order-mark body matches under
  SHA-512 with its full size, the empty body with `0 bytes`, and the request
  without a signature header has nothing chosen and says `Choose the header
  that holds the signature.` `localStorage`, `sessionStorage` and the address
  never hold the secret, and after a reload the field is empty;
- **375 px**: `⋯` lists `Check signature…` before `Compare with…`; choosing
  it turns the sheet into `Check signature` with the secret focused; the
  secret matches and another one shows the computed value, with nothing
  scrolling sideways; a tap on the scrim and Escape each close it with focus
  back on `⋯`, the secret kept; at 320 px, the sheet open, nothing scrolls
  sideways; nothing sent or stored carries the secret;
- **a long header name**: two requests carry a header whose name is one run
  without a hyphen after `X-`, of 73 and of 10,009 characters. Opened at 1440
  px in the popover and at 320 px in the sheet, each matches and then shows
  `No match` with the name at the end of the line under the verdict, and each
  time the popover or the sheet, the result box in it and the page have
  nothing wider than their box (`scrollWidth` ≤ `clientWidth`): the name
  wraps inside the result.

### E2E-13 — the sessions used in this browser (`e2e/session-list.spec.ts`)

Issue #92, D199; Figma `Webhook Inspector · My sessions`, G3′ and F. The
list's rules and strings are unit-tested (`session-list.test.ts`,
`home-view.test.ts`) and the status read against the database
(`session-status.test.ts`); only a browser has storage, a network log, focus
and a layout. Four tests:

- **1440 px**: an empty list is the first visit — `How it works`, `3 steps`,
  step 01 ending `so do not send sensitive production data.`, no `Temporary
  and anonymous`, and no status read. `Generate URL` creates a session, and
  back home it is listed under its receive URL with `0 requests` and `no
  requests yet`, without the eyebrow or the steps; every status read is a
  `POST` whose body is `{"ids":[…]}` and whose URL holds no piece of an id. A
  session opened by its link in another tab joins at the top. The copy icon
  writes the exact receive URL to the clipboard and `⋯` opens its menu, and
  neither leaves the page; a click on the row's counts opens the session.
  `Remove from list` asks nothing and shows no toast, survives a reload, and
  the session still answers. `Delete session…` asks `Delete this session?`
  with the session's 7 characters; Cancel closes it with focus back on `⋯`
  and the session still there; confirmed, the toast reads `Session <7>
  deleted`, the page is the first visit with an empty stored list, and the
  receive URL answers `404` / `1001`;
- **the cut, an unknown entry, loading and failure**: six sessions and a
  well-formed id that names none are stored; with the status read held, the
  page shows `Loading sessions…` under the tile and not the first visit; once
  it answers, the unknown id has left the stored list and `5 of 6 sessions in
  this browser` shows five rows; `Show all` shows six, reads `6 sessions in
  this browser` and moves focus to the sixth; with the read answering `500`,
  `Session details could not be loaded.` heads the rows, which show their ids
  in the opening order, no counts and no copy icon, and the stored list is
  unchanged; the same holds, with no page error, for seven `200` answers
  outside the contract — a body of `[]`, `sessions` `null` or `[null]`, a
  numeric `receiveUrl`, an unknown state, and `lastUsedAt` or `lastRequestAt`
  as an array nested 10,000 deep;
- **375 px**: the receive URL is whole and wraps inside its row; `⋯` opens the
  sheet titled `Session <7>` with both actions, and `Delete session…` there
  opens the confirmation with two half-width buttons side by side; nothing
  scrolls sideways at 375 or 320 px;
- **blocked storage**: with `localStorage` throwing on access, the page is the
  first visit, its tile enabled, with no page error.

### E2E-14 — `Generate URL` that creates nothing (`e2e/generate-url-failure.spec.ts`)

Issue #128; Figma `Webhook Inspector · Session could not be created (#128) —
approved`, frames A1–A3 and B1–B3. The two texts and which failure gets which
are unit-tested (`create-session-failure.test.ts`, `retry-after.test.ts`);
here `POST /api/sessions` is answered by `page.route`, never by the backend's
own limit, and its status read goes through. The line's text is compared with
`textContent`, byte for byte, because Playwright's text matchers fold the
no-break spaces of its second sentence into plain ones. Three tests:

- **the first visit, 1440 px**: a `503` with an HTML body, then no answer at
  all, each show `This session could not be created. Please try again.` in
  the one `role="alert"` under the tile; the address stays `/`, the tile is
  enabled and keeps focus, which the page gives back after the busy state
  took it. The next click removes the line while the creation is held
  pending, the tile disabled; the creation then reaches the backend, the
  browser opens `/v/<id>` and back home the session is listed. Neither a
  `pageerror` nor a console error naming an uncaught or unhandled rejection
  is seen;
- **a returning visitor, 1440 px**: `429` / `1015` with `Retry-After: 40`
  shows `Too many sessions created from your address. Try again in 40 s.`
  between the tile and the first day, 12 px from each; `429` with another
  code and `1015` without `Retry-After` show the general sentence; with the
  status read answering `500`, the line comes 12 px before `Session details
  could not be loaded.`;
- **the frames' measures**: on the first visit (no answer) at 1440, 768, 375
  and 320 px, and for a returning visitor (`429` / `1015`, `Retry-After: 40`)
  at the same widths, the line starts 12 px under the tile — below 768 px
  under the new session's options line, which sits 8 px under the tile there
  (#216, D249) — at the tile's left edge and as wide as it, Inter 13 px on a
  19.5 px line in `rgb(184, 46, 46)`,
  left-aligned, with `How it works` 32 px below it from 768 px and 24 px on a
  phone, or the first day 12 px below; its second sentence is drawn on one
  line, at 375 px for a returning visitor on a second line of its own; and
  nothing scrolls sideways.

### E2E-15 — the about page at `/about` and `/ru/about` (`e2e/about.spec.ts`)

Issue #131, D211; issue #170, D255; Figma `Webhook Inspector · About page
(#131)`, frames D1-1 to D1-3, which carry the Russian text too. The pages are
static HTML written at build time from `about-copy.ts` and `about-copy-ru.ts`,
whose texts `about-copy.test.ts` and `about-copy-ru.test.ts` pin byte for
byte; the dev server serves them as nginx does (`about-page.test.ts` reads
`nginx.conf`). Four tests:

- **the page**: `/about` and `/about/` answer `200` HTML with
  `Cache-Control: no-cache`, no `X-Robots-Tag`, the title `About QA Tools` and
  no `noindex`; the title, the three paragraphs and each fact's lines read, by
  `textContent`, exactly as `about-copy.ts` writes them, no-break spaces
  included; the only link in the page is the mail address; the header has no
  current page and the footer reads `PRIVACY_FOOTER_TEXT` with `About`
  linking to `/about` as the current page. At 1440, 768, 375 and 320 px the
  header keeps its layout (`expectHeaderLayout`), nothing scrolls sideways,
  and no line of the title, the story or the facts holds a single word: each
  word's box is measured with a `Range` across the page's inline elements, so
  an address and the full stop after it count as one word. No request leaves
  the origin, and with JavaScript off the page reads the same;
- **the way in**: `About` in the home page's footer opens `/about` in the
  same tab;
- **the Russian page**: `/ru/about`, `/ru/about/` and `/ru/about?x=1` answer
  `200` HTML, `<html lang="ru">`, with `Cache-Control: no-cache`, no
  `X-Robots-Tag`, the title `О QA Tools` and no `noindex`, and `/about` asked
  with `Accept-Language: ru` is still the English page with no redirect; the
  title, the paragraphs and the facts read exactly as `about-copy-ru.ts`
  writes them; the only link in the page is the mail address; the header is
  in Russian (`Изменения`, `Статус ↗`, `API docs ↗`) with no current page and
  `Webhook Inspector` leading to `/ru/`, and the band reads the Russian line and
  `О сервисе · Условия · Конфиденциальность · Почта:`, `О сервисе` linking to
  `/ru/about` as the current page and the other two to `/terms` and
  `/privacy`; the Cyrillic Inter faces are loaded at 400, 500 and 600. At
  1440, 768, 540, 510, 420, 384, 375, 360 and 320 px — the English page's
  four and five where 1.15.5's joints broke one of the Russian rules (issue
  #258) — the header keeps its layout in Russian (`expectHeaderLayout` reads
  the page's `lang`), nothing scrolls sideways, and no line of the title, the
  story or the facts starts with `—` or ends with a one-letter word or with
  `QA` (`laidOutLines` splits words at no-break spaces too, so a joined run's
  words count one by one); the title is one line from 510 px and below 500 px
  reads `От тестировщика —` over `тестировщикам`, its second line the one
  allowed a single word, and no other line holds a single word; each link of
  the band with its dot and the contact stays on one line, and at 1440 px the
  band is one 34 px line. No request leaves the origin, and with JavaScript
  off the page reads the same;
- **the Russian way in**: on `/ru/`, `Условия` and `Конфиденциальность` link
  to `/terms` and `/privacy`, and `О сервисе` opens `/ru/about` in the same
  tab; back in English, `About` opens `/about`.

E2E-01's footer check (`expectPrivacyFooter`) requires `About` in the band
of `Page not found`, the landing page and the session page, linking to
`/about` with no `target`.

`watchOrigins` and `laidOutLines`, which this spec and E2E-16 share, are in
`e2e/helpers.ts`; `laidOutLines` takes the selector of the blocks it lays out.

### E2E-16 — the Terms of Use and the Privacy Policy (`e2e/legal.spec.ts`)

Issue #112, D217; Figma `Webhook Inspector · Terms and Privacy (#112)`,
frames T1–T3 and P1–P3. The pages are static HTML written at build time from
`legal-copy.ts`, whose texts `legal-copy.test.ts` pins byte for byte and
`legal-facts.test.ts` holds to their sources; the dev server serves them as
nginx does (`legal-page.test.ts` reads `nginx.conf`). Four tests:

- **each page**, `/terms` and `/privacy`: both its addresses answer `200`
  HTML with `Cache-Control: no-cache`, no `X-Robots-Tag`, its title and
  canonical address and no `noindex`; the eyebrow, the title, the
  introduction, the date line and each section's label and lines read, by
  `textContent`, exactly as `legal-copy.ts` writes them; every link in the
  page is the mail address or, on `/terms`, `stability policy`; the header has
  no current page and the footer reads `PRIVACY_FOOTER_TEXT`, the page's own
  link its current page and the others not. At 1440, 768, 375 and 320 px the
  header keeps its layout, nothing scrolls sideways and no line of the title,
  the introduction or a section's lines holds a single word (the labels
  `Limits`, `Logs`, `Liability` and `Contact` are one word as approved); at
  the frames' widths the column's left edge and width (240/960, 40/688,
  16/343 px), the space above and below it (56/72, 56/40, 28/40 px), the
  lines 192 px right of their label on its 160 px rail or under it on a
  phone, the date line 12 px under the introduction and the band's 34 and
  51 px are the frames', and the band is 119 px at 320 px; at 375 px, where
  the words of 1.15.16 make it a line taller than the frames' 85 px within
  2 px of the width where it changes, only its fit is asserted (D265).
  Where each line wraps is not asserted: it rests on
  the platform's glyph advances; the pages' whole heights matched the frames
  in Chromium on macOS when they were built (D217). No request leaves the
  origin, and with JavaScript off the page reads the same;
- **the stability policy**: `stability policy` on `/terms` opens
  `/docs#api-1/description/stability` with the Stability heading in view;
- **the way in**: `Terms` and `Privacy` in the home page's footer open their
  pages in the same tab.

### E2E-17 — the Russian interface and its `EN | RU` switch (`e2e/language.spec.ts`)

Issue #108, D222; Figma `Webhook Inspector · Language switch (#108)`,
direction A, frames A-R1, A-T1/A-T2, A-P1–A-P5 and the glossary `792:57`.
The words are `apps/frontend/src/i18n/en.ts` and `ru.ts`, which
`i18n.test.ts` walks; this spec reads them from there rather than retyping
them. Eight tests, seven in a `ru-RU` context and one in a `de-DE` one:

- **the first render**: the home page in a `ru-RU` browser is Russian with
  `<html lang="ru">` and the Russian home page's tab title (`title.home`,
  D226), and a mutation observer
  installed before the page's script records every text the application root
  holds as it is built: each snapshot carries `lang="ru"` and none holds the
  English heading, `Generate URL` or `About`. The header reads `Изменения`,
  `Статус ↗`, `API docs ↗`, then the switch, `RU` pressed and `EN` not, both
  with `cursor: pointer` as the `Изменения` link (issue #246); the
  band's `textContent` is the Russian line and links, and at 1440 px it is one
  34 px line (A-R1); the page reads in Russian whole (below) and raises no
  page error;
- **the switch**: on a session page with a request open on `Body`, the filter
  holding `POST` and the quick switch open, `EN` turns the page English at
  once - the header, the open quick switch, the list's filter, `<html lang>`,
  the tab's title with its unread count - and `RU` turns it back; the request,
  the tab, the filter and the quick switch stay, the address does not change,
  a marker set on `window` before survives (no reload), and no `/api/` call is
  made. The filter's own search of the raw requests, sent a typing pause
  after `POST` is typed, is awaited before the calls are watched, so it is
  never taken for the switch's, and they are still watched for more than a
  typing pause after the last click;
- **a failure follows the switch**: in a session with a custom response and a
  one-step queue a request has used up, the quick switch's Apply refused with
  a `1005`, its `Запустить снова` and its section's `Удалить` failing with a
  `500` (all three routed in the page): each failure is said in Russian, in
  English after `EN` with the quick switch still open and nothing of the
  Russian left, and in Russian again after `RU`; the server's own message
  after the lead-in stays as it came;
- **the choice kept**: `EN` in a Russian browser is stored as
  `{"v":1,"lang":"en"}` and wins after a reload and in a new tab of the same
  context; ten stored values the page did not write - `xx`, an empty string,
  `__proto__`, `constructor`, `toString`, another language, another version,
  a `__proto__` key, broken JSON and 1 MiB of text - each read as no choice
  after a reload, the page Russian again, with no page error;
- **every screen in Russian**: a session with a custom response and a queue,
  and a JSON webhook, a form and a GET with a query; the session page, each
  tab of both halves, `Действия ▾`, `Проверить подпись`, picking and the
  comparison, the quick switch and its queue section, the response editor
  with a header in error, the response queue, the rules section, the
  response rules dialog and a request a rule answered, its row's marker `П1`
  titled `Ответило правило 1`, which the row's accessible name says in its
  place (issue #233), and its tag `Правило 1 ·
  GET /42` (issue #226; the rule's path holds no letter, being the user's,
  and the path field's `/s/<id…>/` is the session's URL, left out as the
  receive URL is), `Удалить все`, a filter that
  matches nothing, a request on a phone with its sheet and the list there,
  the home page as a returning visitor with a row's `⋯` and its question, and
  both not-found screens. On each, every text drawn and every name, title and
  placeholder assistive technology reads, outside captured data - the receive
  URL, addresses, the target and facts line, code boxes, multipart parts, the
  comparison's lines, the computed signature, the home page's URLs, mail
  links, a select's options, a text area's text and the stylised exchange -
  is read, fields' names and placeholders included, the ids of the session
  and its requests taken out, and every run of Latin letters must be one of
  the words that stay English (Decision 7): the list `i18n.test.ts` holds the
  dictionary to (`apps/frontend/src/i18n/latin.ts`), and what the screens
  draw outside it - the methods sent and the rules dialog's method chips,
  the reason phrases of the statuses configured, the signature's algorithm,
  `EN`, `English` and `RU`;
- **the session page's fit**: at 1440, 768, 375 and 320 px the endpoint
  card's `АДРЕС ДЛЯ ПРИЁМА` and `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ 7 ДНЕЙ ПРОСТОЯ` stay
  inside the window and their boxes, the list's header stays inside the list,
  and nothing scrolls sideways;
- **where the switch is**: in the header from 768 px - after `API docs ↗` and
  a 1 × 16 divider, 16 px apart each, `EN` Medium and `RU` Semi Bold - and in
  the band below it, after `Конфиденциальность ·` and before the contact, the
  header keeping its three links; at 375 and 320 px the band is 102 and
  119 px, at 360 px it fits (within 2 px of a width where it changes since
  the words of 1.15.16, D265), and its `EN` and `RU` switch the page; nothing
  scrolls sideways at any of the five widths;
- **a browser asking for neither**: `de-DE` gets the English interface with
  `<html lang="en">`, `EN` pressed, and `RU` switches it, which a reload
  keeps.

The page's own design comparison against the frames is not pixel-based:
the band's 34 px at 1440 px and 102 and 119 px at 375 and 320 px, the
switch's divider and gaps, and the fit checks are the measured part (D222).

### E2E-18 — the Russian home page at `/ru/` (`e2e/russian-home.spec.ts`)

Issue #109, D226; no frames of its own: `/ru/` is #108's Russian landing
page. The rules - which addresses are the Russian home page, which language
a page opens in, where the switch and the ways home lead - are unit-tested
(`not-found.test.ts`, `i18n.test.ts`), and the head, the `<noscript>` and
nginx's locations without a browser (`search-engines.test.ts`). The dev
server serves `/ru` and `/ru/` as nginx does; it still answers every other
address `200` (D146), so the statuses of the addresses around `/ru/` are
checked with curl on the built image, as D226 records. Nine tests, in the
suite's `en-US` context unless they say otherwise:

- **the page**: `/ru/` and `/ru` answer `200` HTML with
  `Cache-Control: no-cache`, no `X-Robots-Tag`, `<html lang="ru">`, the one
  title `Webhook Inspector — проверка вебхуков`, one canonical address,
  `https://qa-tools.ru/ru/`, and no `noindex`;
- **Russian from the first render**: in an English browser with nothing
  stored, `/ru/` is Russian, with `<html lang="ru">` and its title; a mutation
  observer installed before the page's script records every text the root
  holds as it is built, each with `lang="ru"` and none with the English
  heading or `Generate URL`; Russian is then stored as `{"v":1,"lang":"ru"}`,
  `RU` is pressed, and `/` is Russian after it, in a new tab too, at its own
  address; `/ru` is the same page; no page error;
- **`/` by the rule**: an English browser with nothing stored gets English at
  `/`, a `ru-RU` browser Russian, both at `/` with nothing stored;
- **to a session and back**: `Создать адрес` on `/ru/` opens a Russian session
  page, whose wordmark leads to `/ru/`, Russian; the session is then deleted
  through the API;
- **the switch between the home pages**: `EN` on `/ru/` leads to `/` in
  English and stores it, `RU` on `/` leads to `/ru/` and stores Russian, a
  marker set on `window` survives (no reload), the browser's Back from `/`
  returns to `/ru/` Russian and stores Russian again, and `EN` on `/` itself
  changes the language in place;
- **whatever is stored**: with `{"v":1,"lang":"en"}`, `{"v":1,"lang":"ru"}`,
  `ru`, `en`, `RU`, `"ru"`, `de`, another language, an empty string or 1 MiB
  stored, `/` follows the stored choice or the browser and `/ru/` is Russian
  and stores Russian; with storage that throws on every read and write `/ru/`
  is Russian and `/` English; no page error;
- **the way home**: in English `Page not found`'s `Go to home page` and the
  wordmark lead to `/`, and `/RU/`, `/Ru/`, `/ru/x`, `/ru/ru/` and `/rus` are
  `Page not found`; once `/ru/` has been opened, `На главную` on `Page not
  found` and on `Session not found` and the wordmark lead to `/ru/`;
- **the header on both home pages and `Page not found`** (D277): `/` and
  `/nowhere` in English, then `/ru/` and `/nowhere` in Russian, each at 1440,
  768, 375 and 320 px, keep E2E-01's header layout, the wordmark named
  `Webhook Inspector` leading to `/` or `/ru/`;
- **on a phone**: at 375 px the switch is in the footer band, `EN` there
  leads from `/ru/` to `/` and `RU` back, nothing sideways;
- **without a script**: `/ru/` reads the Russian `<noscript>` - the heading,
  the lead, the three steps and the pointer to `/llms.txt` - with
  `<html lang="ru">`, and `/` the English one.

### E2E-19 — View pages of one address within its realtime connections (`e2e/realtime-tabs.spec.ts`)

Issue #145, D227; no visual change. One address may have 16 realtime
connections open at once, and the 17th is refused `429` / `1020` before its
upgrade, which a browser sees as a failed connection and the page retries
with its growing delay (D079). Every tab of the suite comes from one
address, the dev server's proxy, as tabs behind one NAT do in production.
One test, in one browser context, with a script installed before each page
loads that keeps the page's WebSockets so the test can cut them:

- **16 tabs subscribed**: 16 tabs of one session each receive `ready` on
  their session socket; a tab whose first attempt met a moment over the limit,
  since the development build opens and closes its socket once on mount, gets
  in on a retry;
- **an interruption**: every tab's session socket is closed at once, and each
  tab reconnects and receives `ready` again;
- **live again**: a webhook sent then appears in all 16 lists with no reload;
- **a 17th tab**: it shows the session and its list but receives no `ready`
  while the 16 are open; once one of them closes, it is subscribed on one of
  its retries, with no reload; no page error in any tab.

The refusal's status, code and headers, the places given back and the
address keys are the backend suite's (`modules/realtime/connection-cap.test.ts`,
`connection-places.test.ts`).

### E2E-20 — the new session's options (`e2e/session-options.spec.ts`)

Issue #216, D249; Figma `Webhook Inspector · New session options (#158,
#166)`, direction A, frames A1–A3, S1, T1–T4 and P1–P5. What each choice
sends, the trigger's words, the card's line for every rule and the not-stored
wording are unit-tested (`session-options.test.ts`,
`session-lifetime.test.ts`, `address.test.ts`, `request-summary.test.ts`,
`request-filter.test.ts`); here they are read off the wire and the page. Ten
tests:

- **the defaults and a choice, 1440 px**: the trigger is named `New session
  options: 7 days · IP stored`, its values muted (`rgb(95, 105, 125)`, weight
  400); the tile sends `POST /api/sessions` with no body and no
  `Content-Type`, and that session's card reads `SESSION EXPIRES 7 DAYS AFTER
  LAST USE` with no `IP NOT STORED`. Then the menu: its group `Expires after
  last use`, `7 days` checked, `1 hour` chosen and `Store the sender's IP`
  (described by `Off: requests show “IP not stored”`) unticked, the menu open
  after each; Escape closes it with focus on the trigger, now `1 hour · IP not
  stored` in ink (`rgb(31, 46, 82)`, weight 500), and the tile's hint `—
  expires 1 hour after last use`. The creation sends exactly
  `{"expiresAfterIdleSeconds":3600,"storeSourceIp":false}` as
  `application/json`; `GET` gives (3600, `null`, `false`); the card reads
  `SESSION EXPIRES 1 HOUR AFTER LAST USE · IP NOT STORED` on one line; a
  webhook's row reads `IP not stored`, and so does its detail's facts line;
  no page error;
- **each key alone**: `1 day` sends `{"expiresAfterIdleSeconds":86400}`, the
  IP turned off `{"storeSourceIp":false}`; a choice turned back to 7 days and
  the IP on sends no body; a click outside closes the menu;
- **the keyboard**: Tab from the tile reaches the trigger, Enter opens the
  menu on `7 days`, ArrowDown and Enter choose `1 day` with the menu open,
  Escape closes it with focus back; a reload starts at the defaults;
- **in flight**: with the creation held, a double click leaves the tile and
  the trigger disabled, both with the arrow cursor (`default`, issue #246),
  and sends one `POST`;
- **1440 and 768 px**, on the first visit and on a returning visitor's page
  (a session put in the list): the trigger is the tile's right end, its full
  height; its divider is its first 1.5 px (left edges within 0.5 px), the
  tile's full height from its top, with 16 px to the values and 16 px from
  them to the tile's end (issue #246); the divider is dashed as the tile's
  border is (issue #248): two SVG lines down its middle, one from its top and
  one from its bottom, each to its middle, each stroked `rgb(169, 182, 204)`,
  `1.5px` wide, dash array `6px, 4px` (attribute `6 4`) from offset `0px`,
  in an SVG of computed `overflow: visible`, whose snapped clip would
  otherwise draw the line 1 px wide at half a pixel or more; at
  1440 px a hovered trigger fills with `rgb(243, 247, 255)` while the tile
  stays clear, and a hovered tile fills while the trigger stays
  `rgb(249, 250, 252)`; the menu, 268 px wide, hangs 6 px under the tile,
  right-aligned with it; nothing scrolls sideways;
- **the hand** (issue #246): at 1440 px the tile and the trigger have
  `cursor: pointer`, and the menu's `1 hour` and `Store the sender's IP`
  keep `default`, by their own `cursor-default`: they are not buttons, so the
  base rule never reaches them; at 375 px
  there is no divider, and the phone's line and the tile have `pointer`;
- **a phone**: at 375 px the trigger is an 18 px line 8 px under the tile,
  right-aligned, and the tile is named `Generate URL` alone; its sheet
  `New session options` holds the radio group `Expires after last use` and
  the checkbox, stays open as each is chosen by a tap on its row, and closes
  on Escape (focus back), on the scrim and on a swipe down from its top; a
  1-hour session without the IP shows `IP NOT STORED` on a line of its own
  under the card's line; at 320 px on `/ru/` the longest values, `1 час · IP
  не сохраняется`, leave nothing scrolling sideways;
- **hostile answers**: the session read answered through `page.route` with
  the three fields absent, `null`, `""`, `"3600"`, `-3600`, `1e400`, an
  object, an array nested 10,000 deep and a 1 MB string shows today's line,
  no marker and no page error;
- **the 10-minute read**: under Playwright's clock, a quiet tab reads its
  session once per 10 minutes on no new connection, while hidden too; a
  `429` to that read leaves the page as it is; a `410` to it shows `Session
  not found`, with no socket opened since the load;
- **offline**: a tab gone offline keeps its session on screen through two
  10-minute reads, with neither `Session not found` nor `Something went
  wrong`.

### E2E-21 — a private session (`e2e/private-session.spec.ts`)

Issue #228, D259; Figma `Webhook Inspector · Private sessions (#228) — L
chosen 2026-10-22, review`, R1–R8. The key store, the link's builder and
parser, the paste field's reading and check, the list's push-out, the calls'
headers and the socket's subprotocols are unit-tested (`access-keys.test.ts`,
`request-link.test.ts`, `open-with-access.test.ts`, `session-list.test.ts`,
`client.test.ts`, `realtime.test.ts`), and so are a move link's reading and
its merge (`move-link.test.ts`, D276); here it is a real browser against a
backend that checks keys (D245). Tests 1, 2, 5, 6 and 8 watch every request
and socket URL, every console line and page error, and the title, and the
key appears in none. Nine tests:

- **created on the home page, at work**: the menu's last checkbox `Private
  session`, described by `Opens only with its link with access`, ticked; the
  trigger named `… · Private session`; the creation sends exactly
  `{"private":true}` with no `Authorization`, and the key it answers is in
  `qa-tools:access-keys` and nowhere on the page. The card shows the lock,
  `· PRIVATE` and the split `Copy`; the socket offered `["webhook-inspector",
  "webhook-inspector.access-key.<key>", "qa-tools.access-key.<key>"]` (D279)
  and a webhook arrives live; a request opens;
  the response (`Custom · 201`), a queue and a rule save, their `PUT`s
  carrying `Authorization: Bearer <key>`. The home page marks the row with the
  lock and sends the status read `{ids, accessKeys}`; the box is unticked
  after a reload. `Delete session…` deletes it and its key leaves storage;
- **a link with access**: opened as a new document it opens the session and
  stores the key, the address `/v/<id>` with no `#`; Back and Forward hold no
  key. `Copy` copies the receive URL, `Copy ▾` → `Copy link with access` the
  link, with the toast `Link with access copied` under the lock. A fresh
  context opens the link with a history of two entries. A third context
  without the key sees `/v/<private id>` exactly as `/v/<unknown id>` — the
  `main` text with the ids masked, the structure as tag and class, the title,
  and the frame while the session read is held — both offering `Open with a
  link with access or a key…`. Its field refuses a wrong key, a malformed
  key, a link without a key, D182's link and another origin's link with R7's
  sentence, storing nothing; the key alone opens the session and stores it. A
  link with access pasted on an unknown id's page opens its session;
- **a request's link**: in a private session `Copy link` keeps its label,
  copies `#key=<key>&request=<id>` and toasts `Link with access copied`; a
  fresh context opens that request selected, with no fragment left. A public
  session's card has no `Copy options` and no lock, and its `Copy link`
  copies D182's link with `Link copied`. E2E-09 is unchanged;
- **Remove from list**: R3's warning, its receive URL, focus on `Cancel`;
  cancelled, the entry and the key stay; `Copy link with access` copies the
  link and keeps the dialog open; confirmed, both are gone, and the session
  itself still answers with its key;
- **a link pasted into the address bar of its keyless page**: on `Session not
  found` of `/v/<private id>`, a link with a wrong key, then the right link
  naming a request, are put into the address of that same document, as typing
  them there does; the wrong one is taken out at once and opens nothing, the
  right one opens the session in place at that request and stores the key,
  the address `/v/<id>` each time, the document the same; of the four history
  entries, Back through the two pasted ones finds `/v/<id>` and no key;
- **a move link pasted into the address bar** (#345, D276): over the home
  page, a move link carrying a public session; over `Session not found` of
  `/v/<private id>`, one carrying that session and its key; each put into the
  address of the document shown, as typing it there does. Each time the page
  loads again and reads it as on arrival: the toast `Moved 1 session`, then
  `Moved 1 private session` (each with ` from <old host>` where the build
  moves), the list holding what came, the key stored and the session open in
  place, the address with no `#`, no request URL holding the link. A record
  of every `replaceState` that takes a move link out, kept across the
  reloads, shows each taken out once, by the document loaded with it and
  never by the page it was pasted over: Chromium's reload loads the address
  it had when it was called, so without the record a page taking the link out
  after that call would pass unseen;
- **Remove from list in another tab**: a session opened by its link in one
  tab, a webhook received and its request opened there, then the session
  removed from the list, confirmed, in a second tab of the same browser. A
  second webhook arrives in the first tab, its row drawn, and the tab keeps
  what it shows until its next call (#264): the card's `· PRIVATE`, the lock
  and `Copy options`; the open request's `Copy link` copies
  `#key=<key>&request=<id>` with `Link with access copied`, and `Copy ▾` →
  `Copy link with access` the session's link with access, nothing stored
  again. The first tab then goes home through the header and Back, within
  the page, and finds `Session not found`, nothing stored again;
- **hostile storage and fragments**: with `localStorage` throwing, a link with
  access still opens its session in that tab; a stored key of the wrong shape
  for one listed session and none for another leave the status read `200`,
  `accessKeys` holding only the well-formed key; `#key=`, a key cut short, a
  key with a character after it, two keys, another session's key, a key with
  a malformed request and a key followed by 1 MiB each open as the frames say
  — the key with a malformed request opens the session, every other shows
  `Session not found` — with the address `/v/<id>` and no page error;
- **320 px**: the options sheet's `Private session` checkbox, the card's
  split button and its `Copy options` sheet, the warning's buttons stacked as
  `Remove from list`, `Cancel`, `Copy link with access`, and the field with
  R7's sentence — nothing scrolls sideways.

### E2E-04 — the API reference at `/docs` (`e2e/api-docs.spec.ts`)

Not a journey through the application but the check issue #34 places in this
suite, because a network log is only observable in a browser (D155). It opens
the reference page, which Scalar renders from `/openapi.json`, and pins:

- `/docs` and `/docs/` answer `200` `text/html` with `Cache-Control: no-cache`
  and the page itself (`id="api-reference"`), never the application shell; and
  `/openapi.json` answers JSON `no-cache`. The dev server stands in for nginx
  here through a plugin in `apps/frontend/vite.config.ts`; nginx itself is
  covered by `apps/frontend/src/lib/docs-serving.test.ts`, by `nginx -t` in the
  image build and, after a deployment, by `scripts/check-deployment.mjs`;
- the title and `v<info.version>` are shown, the introduction's `Quickstart`
  and its `Download openapi.json` link are there, the introduction's sentence
  pointing to the about page draws `https://qa-tools.ru/about` as a link
  (D211), the one linking the Terms of Use and the Privacy Policy draws
  `https://qa-tools.ru/terms` and `https://qa-tools.ru/privacy` as links,
  neither taking the comma after it (D217), the page's head names the changelog's two Atom feeds,
  `/changelog.xml` and `/changelog-breaking.xml` (D212), `info.contact` is drawn as a
  `QA Tools` link to `mailto:contact@qa-tools.ru` (D177), and every operation of
  the description — all twenty-three, the response queue's three since 0.46.0
  (D205) and the response rules' one since 1.3.0 (D246) — is in the sidebar
  under its tag;
- the page stays light with the browser set to prefer dark, and has no
  dark-mode toggle, no `Ask AI`, `Generate MCP`, `Connect MCP` or
  `Open API Client`, and no `Deploy`, `Share`, `Configure` or
  `Developer Tools`;
- `Create a session` shows its curl sample first, against the page's own
  origin; the sample menu holds exactly `Fetch`, `Requests` and `Curl`, and
  switching to each shows that client's code;
- `Test Request` sends `POST /api/sessions` to the page's own origin and gets
  `201` with a session id;
- **no request and no WebSocket of the whole browser context leaves the page's
  origin** from the moment the page is opened to the end: each one that would is
  refused before it leaves the machine, recorded, and fails the test. This is
  what catches a Scalar upgrade that starts calling home.

Removing any one of `withDefaultFonts`, `showDeveloperTools`, `agent`, `mcp`,
`hideClientButton`, `servers` or `hiddenClients` from the Scalar configuration
fails this test, checked one at a time on Scalar 1.72.0. `hideDarkModeToggle`,
`forceDarkModeState` and `defaultHttpClient` are redundant here — either of the
first two keeps the toggle away, and curl is Scalar's default sample — so
removing one alone leaves it green; `docs-serving.test.ts` pins them.

## Behaviours only this suite pins

Five pieces of wording and behaviour are asserted here and stated in no other
document:

- the empty state reads `Waiting for the first request`;
- the counter reads `N / 1000 requests`;
- `Delete all` is present and disabled at zero requests rather than hidden
  (D071);
- the `data-testid` hooks the application carries only for this suite:
  `receive-url`; `row-status`, `row-address` and `row-time` in a list row;
  `detail-method`, `detail-target` with its three parts
  `detail-target-session`, `detail-target-path` and `detail-target-query`
  (D173), `request-facts`, `response-status` (the Response half's status,
  holding the pill of an answer the session gave, D207), `response-state` and
  `response-note` (the third response line, absent for a finished write, D158)
  in the detail header; `tab-area` on the area under a half's view strip, and
  `block-content` on a code box's text element (D149); and `toast` on the
  session page's toast — the confirmation a saved response change shows
  (D150), and the request actions' copies and the stale link's notice
  (E2E-01, E2E-09, D182), whose `data-icon` says `check` or `info`, or
  `lock` for a copied link with access (E2E-21, D259); and
  `filter-count` on the
  list filter's match count, `filter-spinner` on the spinner that takes its
  place and `search-notice` on the notice that headers and bodies were not
  searched (E2E-08, D180, D191); and, for comparing two requests
  (E2E-11, D186), `list-picking` on the list header while picking,
  `compare-view`, `compare-bar`, `compare-header`, `compared-open` and
  `compared-chosen` in the comparison, `differs-dot` on a view that differs,
  `mark-removed` and `mark-added` on the `−` / `+` pills, `diff-box`,
  `diff-text` on a line's text cell and `diff-changed` in the lines, `compare-headline`, `compare-whole`,
  `compare-gone` and `compare-failed` for its states, and `data-diff` on each
  line or fold; and, for checking a signature (E2E-12, D197),
  `signature-result` on the result box and `signature-computed` on the
  computed value. Each marks an element
  whose text or box would otherwise have to be picked out of the whole row,
  header, panel, block or live region;
- that the page **re-reads its session on every realtime connection** (D133),
  which is what keeps a tab left open alive and is asserted nowhere else — see
  the trap below for why it is counted after `ready` rather than in total —
  and, since 1.7.0, every 10 minutes besides (E2E-20, D249).

Changing any of them changes this suite.

## What this suite runs against, and the assertion trap in it

The browser here drives a **Vite dev server** (`playwright.config.ts` starts the
frontend with `npm run dev -w @webhook-inspector/frontend`), and `main.tsx` wraps the
application in `StrictMode`. The production bundle is not exercised by this
suite at all; the image build already proves it builds (D094).

That has one consequence worth knowing before writing an assertion here.
**`StrictMode` double-invokes effects in development**, so a component's mount
effect runs twice, and an effect that issues a request issues it twice — the
cleanup sets a cancellation flag but does not abort a request already in flight.
Any assertion of the form "the page did X N times" is therefore
mount-count-sensitive, and a threshold on a total measures the number of mounts
as much as the behaviour it names.

Write such an assertion **relative to something**, never as a total:

- **order it against the socket.** `collectSessionReadTimeline` in
  `e2e/helpers.ts` splits the page's session reads at the first `ready` frame
  and E2E-01 asserts on the ones after it, so the mount's reads — however many
  there are — cannot satisfy it;
- **or force the transition** you mean to pin, sample before and after it, and
  assert the count grew.

This is not hypothetical. The first version of that assertion counted total
reads of `GET /api/sessions/<id>` and required at least two. Measured against
this dev server, the page issued three with the behaviour present (two from the
double mount, one from `ready`) and two with it deleted — so the assertion
passed either way and pinned nothing (D133).

A second one comes with a resize. `setViewportSize` returns before the page
has re-rendered for the new width: what the stylesheet decides follows at
once, but what the script decides with `useMediaQuery` - the session page's
split or pushed layout, and since D222 whether `EN | RU` is in the header or
the band - follows a frame or more later, when React handles the media
query's change. A measurement taken straight after the resize can read the
page of the width before: E2E-01 read the band at 375 px as 85 px, without
the switch, in six of ten runs on 2026-10-10. A measurement after a resize
therefore waits first for something only the new width's render draws, with a
web-first assertion and never a fixed wait; for the header and the band that
is `expectLanguageSwitchPlaced` in `e2e/helpers.ts`, which `expectHeaderLayout`
calls first.

## Non-goals

- **No visual assertions of any kind.** No screenshot comparison, no pixel,
  size, colour, font or spacing checks. Appearance is reviewed against the
  design file by a person. E2E-01's layout checks (D134, D149, D173, D177, #96)
  are the one narrow exception. They assert which element scrolls, that nothing
  overflows, and where one element sits relative to another; where a position
  follows from how text is set (D134, D149, D173) they allow a pixel of
  tolerance. Two of them are limits taken from the design: the copy control
  sits within 16 px of the tab area's top (the design pins it 8 px down), and
  a continuation starts two characters deeper than its line, measured in the
  face's own character width rather than in pixels. The footer band's heights
  at 1440 and 768 px (34 and 51 px), the 12 px above it and its 28 px right
  margin are the approved frames' (D177, amended by #96) and are asserted
  exactly, measured with at least 9 px of every wrapped line free, so a small
  difference in text width between platforms moves no word. So are the
  English band's 119 px at 360 and 320 px and, in E2E-17, the Russian band's
  102 and 119 px at 375 and 320 px, each at least 16 px from a width where it
  changes (measured in Chromium on 2026-10-25, D265). Two heights are not:
  the English band at 375 px - the frames' 102 px (85 px before `EN | RU`
  joined a phone's links, A-P1, D222), a line taller with the words of
  1.15.16 - and the Russian band at 360 px, each within 2 px of a width where
  it changes. The session page's gaps are #96's
  direction B and are asserted exactly too: 12 px from the header to the
  endpoint card and from the card to the panes at 1440, 768 and 375 px, and
  between the list and the detail panel at 1440 px. The card's 85, 93 and
  154 px are the heights B's padding and gaps give as the page renders them,
  held to half a pixel: B1 and B2 draw 80 and 90 px, because their caption
  line is 12 px where the page's is 15 (and B1 leaves out the card's 1 px
  border), while B3's 154 px is the page's own, its two caption lines at the
  face's normal line height. A design revision that moves any of those changes
  the limit with it. No other size, position, font or colour is asserted.
- **No cross-browser, and no tablet or phone journeys.** Chromium at
  1440x1024, which is the size the desktop design is drawn and measured at.
  The one exception is E2E-01's layout check, which sets 1440×780, 1440×1300,
  1024×1024 and 900×1024 for a few assertions about which element scrolls and
  whether anything leaves the box, and then restores 1440×1024 (D149); `Copy as
  cURL` is checked at 800, 375 and 320 px (D167, D182), the detail header's
  target at 768, 375 and 320 px (D173), the footer band on the session page at
  768, 375 and 320 px (D177) and the blocks above it at 768 and 375 px (#96),
  each restoring 1440×1024 after. Since
  v0.19.0, 900×1024 is the tablet layout: the open request shows full-screen
  under its Back bar, and its tab area is still the one scroll. The layouts
  below 1024 px (D157) are covered by unit tests of their logic — the push
  flow's history rule in `apps/frontend/src/lib/push-flow.test.ts` — and by
  viewport checks at delivery, not by a journey here. E2E-09 opens its links
  at 768 and 375 px and presses Back there, and checks 320 px, because a link
  opened below 1024 px is the push flow's opening (D182).
- **No load, performance or timing assertions.** E2E-02 configures a small
  response delay, which is not one: it exists so a request can be opened while
  its response is still `pending`, and nothing asserts how long anything took.
- **No accessibility audit.** Roles and labels are used to find elements, which
  is not the same as auditing them.
- **The production bundle is not exercised.** The frontend is served by the Vite
  dev server, whose proxy is the documented reproduction of production's single
  origin (D047, D060); the image build already proves the bundle builds (D094).
- **Screenshots and traces are diagnostics, never criteria.** Nothing in the
  suite passes or fails on an image.

## Running it locally

Requirements: Node 24 and Docker.

The suite needs ports **3000**, **3001** and **5173** free by default: the
backend, its receive listener (D187) and the dev server. It starts its own
backend and its own dev server on them and never reuses a server it finds already
running — a running dev stack is connected to the application's database, and
reusing it would silently test that instead. Stopping your dev stack before
running the suite is the shortest path; moving the suite is the other one, and is
now safe.

**Both ports come from one module and cannot be moved apart.**
`e2e/app-address.ts` declares them, and `playwright.config.ts` takes **every**
address from it: the port its backend is started on, that backend's readiness
URL, the dev server's `--port`, the dev server's readiness URL, and `baseURL`.
The Vite proxy target is no longer a second, independent copy of the backend
port: `apps/frontend/vite.config.ts` reads it from `WEBHOOK_INSPECTOR_BACKEND_ORIGIN`
(and its own port from `WEBHOOK_INSPECTOR_FRONTEND_PORT`), with today's values as
defaults, and the suite passes both from that same module. `vite.config.ts`
deliberately does not import from `e2e/` — the frontend workspace builds in its
own Docker context and must not reach outside it — so the environment is the
seam. To move the suite out of the way of a running dev stack, set either or
both:

```bash
E2E_BACKEND_PORT=3100 E2E_RECEIVE_PORT=3101 E2E_FRONTEND_PORT=5273 npm run test:e2e
```

**Webhooks go to the receive listener directly** (D187). The backend opens a
second port, `E2E_RECEIVE_PORT`, and is told it is its public receive origin,
so every session's `receiveUrl` names it. The specs send webhooks to that URL,
read from the API, and never through the dev server, whose proxy would rewrite
the headers a capture exists to show; the dev server's `/s/` reaches the
application listener and answers `410` / `1009`, as production's `qa-tools.ru`
does.

**And single-sourcing is only half of it.** One module stops the two addresses
drifting apart; it cannot prove that the dev server's proxy actually reached the
backend Playwright started rather than something else listening there and
answering `/readyz` just as convincingly. So `playwright.setup.ts` runs as
Playwright's `globalSetup`, after both servers are up and before any test:
it `POST`s a session **directly** to the backend, then `GET`s it **through** the
base URL. The same id means the proxy reaches this backend. It then checks
that the session's `receiveUrl` is `http://127.0.0.1:<E2E_RECEIVE_PORT>/s/<id>`,
that a webhook sent there lands in that very session, and that `/s/<id>`
through the base URL answers `410` / `1009` (D187). Anything else aborts
the run before a single test executes, naming both addresses and what it got —
which is the failure this whole arrangement exists to convert from a green run
into a loud one. It lives beside the config rather than in `e2e/` because that
directory is ESM and the config is CommonJS, and a module imported from both
sides is transformed once in the wrong mode.

### The database

The suite runs against its own database, `webhook_inspector_e2e`, in a PostgreSQL
instance of its own. A second database inside the development instance does not
work: migration `002` schedules the cleanup job, and pg_cron refuses to schedule
one from any database except the one the server was started for
(`cron.database_name`, which is fixed at server start). CI gives the suite its
own service for the same reason.

```bash
docker compose build postgres      # once per machine: the image that carries pg_cron

docker run -d --name webhook-inspector-postgres-e2e -p 5433:5432 \
  -e POSTGRES_USER=webhook_inspector -e POSTGRES_PASSWORD=webhook_inspector \
  -e POSTGRES_DB=webhook_inspector_e2e \
  webhook-inspector-postgres \
  postgres -c shared_preload_libraries=pg_cron \
           -c cron.database_name=webhook_inspector_e2e \
           -c cron.use_background_workers=on
```

The image is `webhook-inspector-postgres` whichever checkout or worktree built
it, because `docker-compose.yml` names it (D159, D278); if
`npm run db:rebuild` has already run on this machine, the build step is done,
and on a machine set up before 1.18.2 `npm run db:up` once gives the image
built then, `qa-tools-postgres`, that name. `npm run db:up` starts the
application's database and is not otherwise used here. The container above is
disposable: `docker rm -f webhook-inspector-postgres-e2e` removes it with
everything the suite wrote.

### The commands

```bash
export E2E_DATABASE_URL='postgres://webhook_inspector:webhook_inspector@127.0.0.1:5433/webhook_inspector_e2e'
npm run test:e2e:migrate   # apply the schema to the suite's database
npm run test:e2e           # run the three journeys and E2E-04 to E2E-21
```

`E2E_DATABASE_URL` is the only variable the suite **requires**. `DATABASE_URL` is
deliberately ignored and never falls back to: an exported value meant for the
running application is not consent to run a destructive suite against it.
The URL must name `webhook_inspector_e2e`; anything else is refused with an error rather
than obeyed. Neither command loads `.env`, which is why they are not
`npm run db:migrate` and not `npm run dev:backend`.

Three more are optional and default to today's values:

| Variable | Default | What it moves |
| --- | --- | --- |
| `E2E_BACKEND_PORT` | `3000` | the suite's backend, its readiness check **and** the dev server's proxy target, together |
| `E2E_RECEIVE_PORT` | `3001` | the backend's receive listener and the `receiveUrl` it names, together (D187) |
| `E2E_FRONTEND_PORT` | `5173` | the suite's dev server, its readiness check and `baseURL`, together |

All three are read once, in `e2e/app-address.ts`. A value that is not a TCP port is
refused there rather than turned into `NaN` somewhere further down.

The suite's backend runs with ten times the production limits per address
(D201): `playwright.config.ts` sets `RATE_LIMIT_SESSION_CREATES_PER_MINUTE=600`
and `RATE_LIMIT_API_CALLS_PER_MINUTE=12000`. Every call of the suite comes from
one address, the dev server's proxy, and a run at the production numbers on
2026-10-05 created 35 sessions and made 470 other calls within one minute, with
no refusal; the higher numbers keep a growing suite from meeting a `429` that
has nothing to do with what it tests. The production numbers are tested at
their real values in the backend suite (`apps/backend/src/modules/limits/`).

Useful while working on the suite:

```bash
npx playwright test e2e/delete-all.spec.ts     # one journey
npx playwright test --headed                   # watch it happen
npx playwright test --debug                    # step through it
```

## When it fails

In CI, in this order:

1. **The Tests tab of the merge request or the pipeline.** The job publishes a
   JUnit report (`e2e-results/junit.xml`), so a failed journey and its error are
   visible without downloading anything.
2. **The `playwright-report/` artifact.** The HTML report: every step, the error,
   and the failure screenshot. Download it and open `index.html`, or browse it
   from the job's artifacts. Artifacts are kept for a week and are uploaded
   whether the job passed or failed.
3. **`test-results/`.** One directory per failed test, holding
   `test-failed-1.png` and `trace.zip`.

A trace is the run itself — DOM snapshots before and after every action, the
network, and the console:

```bash
npx playwright show-trace test-results/<test-directory>/trace.zip
```

Traces are recorded only for a failure, and screenshots only on failure. Both
are there to explain a failure that already happened; no assertion looks at
them.

Locally, the same HTML report is written to `playwright-report/`:

```bash
npx playwright show-report
```

All of that output — `playwright-report/`, `test-results/`, `e2e-results/`,
`blob-report/` — is generated and ignored by git, Prettier and ESLint.

## Version pinning

`@playwright/test` is pinned to an exact version in the root `package.json`,
with no caret. The browser the suite drives is installed by that package, so the
version and the browser move together, and a silent upgrade would change what
the suite runs against without anything in the repository saying so.

Bumping it is a deliberate step: change the pin, run `npx playwright install
chromium`, run the suite locally, and check that the CI image still satisfies
the new version's requirements — the job runs on `node:24-bookworm-slim` and
installs the browser's system libraries with `npx playwright install-deps
chromium`, which is where a new Playwright's new dependency would surface.
Bump the pin and verify the image in the same change.
