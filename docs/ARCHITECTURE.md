# QA Tools — Architecture

## Overview

QA Tools v0.1 is a TypeScript monorepo deployed to a single k3s server using Helm.

```text
Internet
   |
   | HTTPS / WSS
   v
Ingress Controller
   |
   +--> frontend Service --> frontend Pod
   |
   +--> backend Service  --> backend Pod
                              |
                              v
                        postgres Service
                              |
                              v
                        PostgreSQL Pod
```

## Frontend
Stack:
- TypeScript
- React
- Vite
- React Router
- Tailwind CSS
- shadcn/ui
- Lucide icons

The frontend is implementation-oriented rather than a learning focus. Prefer standard components and conventional React architecture. Avoid unnecessary state-management frameworks in v0.1.

Production frontend assets are built into static HTML/CSS/JS and served from the frontend container, typically via Nginx.

### Languages
The interface reads in English or Russian (issue #108, D222). Its words live in `apps/frontend/src/i18n/`: `en.ts`, a plain object of strings, lists and functions that compose a whole text - plurals and word order included - and `ru.ts`, typed against it, so a key one language lacks fails the typecheck; no dependency. `index.ts` decides the language before the first render (`initialLanguage`): a choice stored in `localStorage` under `qa-tools:language` as `{"v":1,"lang":"ru"}` wins, else the first Russian or English entry of `navigator.languages`, or `navigator.language` where that list is missing or empty, else English; a stored value of any other shape counts as no choice, and storage that throws is none. One address decides before all of these: the Russian home page, `/ru/`, is always Russian (issue #109, D226) — `classifyAddress` (`lib/not-found.ts`) reads it as the landing page with the language `ru`, `initialLanguage` takes that as its third argument, and `App` stores it through `setLanguage` in a layout effect, also when the page arrives there in English by the browser's Back. `main.tsx` sets `<html lang>` and the tab's title from it and renders `LanguageProvider` (`i18n/LanguageProvider.tsx`) with it; components read the words through `useMessages()`, and `components/LanguageSwitch.tsx` changes them through `useLanguage()`, storing the choice; on the two home pages it also navigates to the paired one, `/` or `/ru/` (`switchAddress`). The wordmark and `Go to home page` lead to the home page of the language shown (`homeAddress` in `i18n/index.ts`), and the landing page's tab title is its head's in its language (`title.home`). Every `lib` function that returns text takes the words as its last parameter, `m`, English by default, so a unit test pins English unless it asks for Russian; a text kept for later - a toast, the list's failed deletion, the home page's creation failure - is kept as a phrase, `(m) => string`, written when drawn, so it follows a switch. The list filter matches a row against what it shows in the language shown, with a cache per language. The static pages' build (`scripts/site-chrome.mjs`, `about.mjs`, `legal.mjs`, `changelog.mjs`) draws every English static page in the English words, through the constants `lib/*-link.ts` and `lib/privacy-footer.ts` take from `en.ts`; `legal.mjs` and `changelog.mjs` read no Russian at all, and `site-chrome.mjs` and `about.mjs` read `ru.ts` and `about-copy-ru.ts` for `/ru/about` alone (D255). `i18n/i18n.test.ts` walks both dictionaries; E2E-17 reads every screen in Russian.

### Layouts by width
The layout is CSS: Tailwind's `md` (768 px) and `lg` (1024 px) breakpoints split phone, tablet and desktop (D157). The desktop's classes are the approved design's and every narrower rule is an added `max-md:`, `md:max-lg:` or `max-lg:` class, so nothing below 1024 px can change the desktop. Two decisions a stylesheet cannot make are taken in script, from `hooks/useDesktopLayout.ts`, which reads the same `64rem` query: whether a selection gets a history entry, and whether the receive URL is drawn whole or cut for a middle ellipsis.

Every page is the same column: `AppHeader`, the page's `main`, and `AppFooter`, the privacy band (D177). The band's text is one constant, `PRIVACY_FOOTER` in `lib/privacy-footer.ts`, its links to the site's own pages another, `FOOTER_LINKS` there — `About`, `lib/about-link.ts`, since D211, then `Terms` and `Privacy`, `lib/legal-links.ts`, since D217 — and the contact address is written once, in `lib/contact.ts`, which the band, the static pages' texts and the `security.txt` build script import. Below 1024 px the links and the contact are one inline block at the end of the paragraph, kept whole where it fits; each link with its dot does not wrap, and a `<wbr>` after it is the one place a narrower line may end (D217). The static pages `/changelog`, `/about`, `/terms` and `/privacy` draw the same header and band from the same constants (`scripts/site-chrome.mjs`, below), and `/ru/about` draws them in Russian. The band's links in a language are `footerLinks(m)` there, which the application's band draws too: in Russian `О сервисе` leads to `/ru/about` (`aboutAddress` in `lib/about-link.ts`, D255). The session page is as tall as the window on the desktop, so the band closes the window under the panes; below 1024 px the column grows with its content and the band follows it, and the open request's screen hides the band as it hides the endpoint card.

Below 1024 px the session page is a push flow: the list, or the open request over it. Which one shows is the selection alone, still component state and never in the address. `hooks/usePushFlowHistory.ts` gives an open request one history entry with the page's own address, so the Back gesture closes it rather than leaving the session, and takes the entry off again whenever nothing is open; the rule is `historyStep` in `lib/push-flow.ts`, unit-tested with a simulated tab. It uses the History API directly and is the only code that does: React Router is not told, because the address does not change.

A link to one request, `/v/<session-id>#<request-id>`, is the one case where the address does change, and the router is not told of that either (D182): its `useLocation().hash` keeps the fragment the page was opened with until the next `popstate`, so nothing reads the fragment from the router — the page reads `window.location.href`, once.

The link is read by `SessionPage` once, after its first list load. `lib/request-link.ts` builds the link, reads the fragment and decides what it does — open, stale, ignore — as pure functions, and the page reads it through `resolveRequestLinkUnlessMove` (`lib/move-link.ts`), which first leaves a move link's fragment, one pasted while that load was in flight, in the address for `main.tsx`'s reload (#362); the page removes the fragment through `removeAddressFragment`, a `replaceState` that `usePushFlowHistory` returns, which keeps `history.state` and leaves the router untold as its own entries do, and then opens the request through the same `select()` a click uses, so below 1024 px the push flow pushes its entry for it. The per-request actions — `Copy link`, `Copy as cURL`, `Download JSON`, `Check signature…` and `Compare with…` — are one list in `components/RequestActions.tsx`, drawn as a Radix dropdown menu from 768 px up and as a Radix dialog bottom sheet on a phone; each copy writes through `hooks/useClipboardCopy.ts` and confirms through the page's one `Toast`.

`Compare with…` (D186) is the one action that changes the page rather than copying or saving. Its state lives in `SessionPage` beside the selection — picking, or comparing with a chosen row — and anything that changes the selection ends it. Below 1024 px picking is the list screen while the request stays open, so the push flow's history entry stays too; a Back while picking only ends picking, and `usePushFlowHistory` reconciles after every render so the entry taken off by that Back is pushed again. The chosen request is loaded with the existing `getRequestDetails`; nothing else is sent. What is compared is decided in `lib/request-diff.ts`, a pure module over two `RequestDetails` (the open one first): each view's lines are the text `lib/detail-view.ts` already draws, the line diff is the `diff` package's (jsdiff) `diffArrays` with `maxEditLength` 1000, and the fold rule, the whole-body limits and the underlined ranges inside a changed pair are its own. `components/CompareView.tsx` draws that model inside the detail panel's `RenderBoundary`. `diff` is the frontend's only dependency added for it.

`Check signature…` (D197) runs entirely in the browser and sends nothing: no API, schema or event takes part. The bytes it signs are the body as it arrived, rebuilt from the detail response by `lib/received-body.ts` — Base64 decoded for a binary body, the byte-order mark the backend's decoder removed put back from `bodySize` (D043), nothing for an empty body or a `HEAD` — which `Copy as cURL` (`lib/curl-command.ts`) reads too, so the bytes one re-sends and the other signs cannot drift apart. `lib/signature.ts` holds every rule as a function of its arguments: the headers offered and the one preselected, how a value splits into an optional prefix and a digest, the algorithm preselected from the prefix or the digest's length, the comparison in hex of either case and in Base64, the computed value written in the header's form, and the result's wording; the HMAC itself is WebCrypto's `crypto.subtle`, which is asynchronous, so the form shows the latest answer and drops a stale one. `components/SignatureCheck.tsx` draws the form; `RequestActions.tsx` shows it in a `@radix-ui/react-popover` anchored to `Actions` from 768 px up, opened once the menu has closed so the form can take focus, and on a phone as the `Request actions` sheet's second view. What it remembers between openings — the secret, the header chosen and an algorithm switched by hand — is a ref in `SessionPage`, read and written by the form, so typing does not re-render the page; it is never in storage, the address or a request, and a reload or another session's page starts empty. `@radix-ui/react-popover` is the one dependency added for it, its Radix dependencies already in the lockfile.

### The detail panel's error boundary
A request the detail panel cannot draw costs the panel, not the page (D169). `components/RequestDetail.tsx` wraps the drawn request in an error boundary, the one class component in the frontend, because React offers boundaries only as classes. An exception while rendering it — a formatter defect, or a detail the panel does not expect — shows the panel's `Could not load request details` state with `Retry`, the same state a failed load shows (D072), while the header, the endpoint card and the list stay mounted; without a boundary React unmounts the whole page. The panel is keyed by the selection, so another selection remounts the boundary and draws that request; `Retry` clears the failure and loads the same request again. Event handlers are not covered, as with any boundary, and the error is left to React's console report.

The boundary is a last resort, not the Body formatters' limit: they bound their own work. JSON and XML nested more than 100 levels deep are shown as stored (D163, D169), because indentation grows with the square of the depth, and so are JSON and XML whose formatted text would be longer than 2,000,000 characters (`FORMATTED_MAX_CHARACTERS`), because drawing it froze the page for tens of seconds. Each formatter first walks the body without building anything, counting the depth and the length of the rendering, and builds it only when both are within their limits.

### The API reference page
`/docs` is a static page of its own, not a React route (D155). `apps/frontend/docs/index.html` and `src/docs/main.ts` mount `@scalar/api-reference`, pinned to an exact version in the frontend's `package.json`, which reads `/openapi.json` from the page's origin when it loads; the page holds no API text. `src/docs/reference-config.ts` is the whole configuration: the page origin as the only server and no proxy, so `Test Request` and the code samples call the API that served the page; no Scalar fonts (Inter comes from `@fontsource/inter`, as in the application); no developer toolbar, agent, MCP or `Open API Client`; telemetry off; light only; curl, JavaScript `fetch` and Python `requests`.

The frontend build runs Vite five times into one `dist/`: `vite build` builds the application, from two pages — `index.html` and the Russian home page `ru/index.html` (D226), the same script under a head of its own, so the two share every chunk — then `vite build --config vite.docs.config.ts` builds the reference page into `dist/docs/index.html` and content-hashed files under `dist/assets/`, `vite build --config vite.changelog.config.ts` the changelog page, `vite build --config vite.about.config.ts` the about page and `vite build --config vite.legal.config.ts` the Terms of Use and the Privacy Policy (below), which writes nothing in a build that does not show the operator's texts (The operator's details, below). Separate builds share no chunk, so the application's bundle neither contains Scalar nor loads anything the page uses; `scripts/check-build.mjs` ends the build by proving it on the output, so the image build fails otherwise. In development and in the browser suite, a plugin in `vite.config.ts` serves `/docs`, `/docs/`, `/openapi.json`, `/llms.txt`, `/llms-full.txt`, `/changelog`, `/changelog/`, `/changelog.md`, `/changelog.xml`, `/changelog-breaking.xml`, `/about`, `/about/`, `/terms`, `/terms/`, `/privacy`, `/privacy/` (with the operator's texts only), `/ru` and `/ru/` as nginx does. After the Vite builds and the generated files below, `scripts/build-site-files.mjs` writes `robots.txt`, `sitemap.xml`, the relay script and `openapi.json` into `dist/` under the build's origins, just before `check-build.mjs`; for a build whose origins are not production's, the same plugin also serves `/robots.txt`, `/sitemap.xml` and the relay script so written (The inspector's address, below).

The agent-readable documentation (D165) is written into the same `dist/` by `scripts/build-llms.mjs`, between the reference build and `check-build.mjs`: `llms.txt` written from `apps/frontend/llms/llms.txt`, and `llms-full.txt` generated from `apps/frontend/llms/agent-section.md`, `info.description` of `packages/shared/openapi.json`, and an endpoint list from its `paths`, each under the build's origins (`nameSite()` and `openApiText()`, D274) and so byte for byte the sources under production's. Neither is committed; the image build, which copies `packages/shared` before it builds, regenerates them, and `check-build.mjs` fails it if either is missing or empty.

### The changelog page
`/changelog`, `/changelog.md` and the two Atom feeds are generated from the repository's `CHANGELOG.md` at every frontend build (D184, D212), as `llms-full.txt` is (D165). `apps/frontend/scripts/changelog.mjs` reads the file: everything above the first `## <version>` is the writers' rules and is dropped, each version must have a `YYYY-MM-DD` line and open with a bold headline, versions must be newest first, and every trailing reference parenthesis such as `(#69, D183)` is removed. The text is production's: a build for another address names its own origins in every entry (`siteEntries()`, The inspector's address below), and one with no second origin leaves out of every output the Breaking, Deprecated and Notice paragraphs that name `webhook.qa-tools.ru` (#343). An entry is marked when a paragraph after its first starts `**Breaking:**`, `**Deprecated:**` (D212) or `**Notice:**` (D224), and none of the three may be its headline. It writes every output from those entries:

- **The page.** A third build, `vite build --config vite.changelog.config.ts`, after the reference build, builds `apps/frontend/changelog/index.html` into `dist/changelog/index.html`. Its body is a placeholder that `changelogPagePlugin()` replaces with the header, the versions and the footer, rendered as static HTML: a `<details>` per version, the newest open, grouped by UTC day, the source's `code` and `**bold**` rendered and everything else escaped. `src/changelog/main.ts` loads Inter from `@fontsource/inter`, the header and footer styles the static pages share (`src/static-pages/site-chrome.css`, D211) and the page's own stylesheet, `src/changelog/changelog.css`, and adds only the filter and `Expand all` (their logic is `src/lib/changelog-controls.ts`); the toolbar is hidden by a `<noscript>` style when scripts are off. The page shares no script with the application or Scalar — the Inter font files are common to the builds — and loads nothing from another origin.
- **The text.** `scripts/build-changelog.mjs` writes `dist/changelog.md`: a public header — the two feeds, how an entry reads and the stability policy, in force since 1.0.0 (D212, D233) — then every version with its date and whole entry.
- **The feeds.** The same script writes `dist/changelog.xml`, every version, and `dist/changelog-breaking.xml`, only the versions with a Breaking, Deprecated or Notice paragraph: Atom (RFC 4287), one `<entry>` per version, newest first, each with a tag URI of its version as `id`, the version and headline as `title`, its UTC day as `updated`, its line on the page as `link` and its text as HTML `content`. Every text is escaped for XML and a character XML 1.0 cannot carry is replaced by U+FFFD; nothing depends on the time of the build (D212). On the page, a Deprecated or a Notice paragraph is drawn like a Breaking one and its entry carries `data-breaking`, so `Breaking only` shows it, labelled `Deprecated`, or `Notice` when it has only a Notice paragraph (D224); a line under the link to the text names both feeds, and the heads of `/changelog` and `/docs` carry `<link rel="alternate" type="application/atom+xml">` for both.

A version with no date or no bold headline throws, so the build fails; `check-build.mjs` fails it too when any output is missing or empty, when the page lists no version, when a feed is not well-formed (`isWellFormedXml` of `src/lib/xml-format.ts`, the check the Body view's XML formatter makes, without its ceiling), not Atom, or carries other versions than `CHANGELOG.md` gives it, in another order or with an incomplete entry, or when the text of any names an issue, a decision, a repository path or an infrastructure object, as may no comment in the served source of any page the build writes — the application, `/docs`, `/changelog`, `/about`, `/terms` and `/privacy` (`pageComments`, which reads them as a browser does). The frontend image's build context must hold `CHANGELOG.md`: `.dockerignore` excludes root Markdown files but lets `!CHANGELOG.md` through, and `apps/frontend/Dockerfile` copies it to the build stage's root before the build. The dev server serves `/changelog`, `/changelog/`, `/changelog.md` and both feeds through `vite.config.ts` from the same module, reading the source on each request.

### The about page
`/about` (D211) is a fourth static page, built like the changelog's: `vite build --config vite.about.config.ts` builds `apps/frontend/about/index.html` into `dist/about/index.html`, and `aboutPagePlugin()` (`scripts/about.mjs`) replaces its placeholder with the header, the page and the footer, written from the constants of `src/lib/about-copy.ts` — the texts `about-copy.test.ts` pins byte for byte — and escaped for HTML content only, so the page holds them as written. Which of them the page has is the build's operator's (#369): `composeAbout(text, operator)` puts the first paragraph, who runs the service, and the facts `Who pays for it` and `Security reviews` in only with the operator's texts, and the third paragraph, which ends in the contact address, only with a contact address, for both languages from the parts each writes (`AboutText`). The page loads no script: its template links `src/about/about.css`, which imports Inter from `@fontsource/inter` and the shared header and footer styles, and the build emits it as one content-hashed stylesheet under `/assets/`. `check-build.mjs` fails the build when the page is missing, lacks its title, has no body or carries `noindex`, as well as on the unhashed files and Scalar it checks for every page. The dev server serves `/about` and `/about/` through `vite.config.ts` with the same plugin.

Its Russian twin, `/ru/about` (D255), is a second input of the same build: `apps/frontend/ru/about/index.html` into `dist/ru/about/index.html`, sharing the stylesheet. Both pages are objects of one type, `AboutCopy` — `ABOUT_EN` in `about-copy.ts`, `ABOUT_RU` in `about-copy-ru.ts` — and `renderAboutBody(page)`, `renderAboutPage(template, page)` and the plugin take the page, the plugin choosing it by the longest template the path ends with (`aboutPageOf`), since `/ru/about/index.html` ends with `/about/index.html` too. `about-pair.test.ts` holds the two in step, the hash of the English text the Russian was approved against among them. The build check reads each page's `lang`, title, one canonical address, `hreflang` pair and body, and the Russian page has its own entries in `BUILT_PAGES`, `SCALAR_FREE_PAGES` and `COMMENTED_PAGES`; a test holds the Scalar list to the built pages, so a page built but not checked for Scalar fails it. The build also refuses a `sitemap.xml` that leaves out any of `SITEMAP_ADDRESSES`.

### The Terms of Use and the Privacy Policy
`/terms` and `/privacy` (D217) are a fifth build of two static pages, made like the about page: `vite build --config vite.legal.config.ts` builds `apps/frontend/terms/index.html` and `apps/frontend/privacy/index.html` into `dist/terms/index.html` and `dist/privacy/index.html`, and `legalPagesPlugin()` (`scripts/legal.mjs`) replaces each placeholder with the header, the page and the footer, written from `LEGAL_PAGES` of `src/lib/legal-copy.ts`, `termsPage(operator)` and `privacyPage(operator)`, one function per page whose text for production's operator `legal-copy.test.ts` pins byte for byte; `legal-facts.test.ts` holds every number in them to its source — the shared limits, the chart's `backup.keep`, the migrations' cleanup schedule, statistics cut and network masks, the stability policy's 30 days, the eight characters the log keeps of what it cuts (`VISIBLE_CHARACTERS` of `apps/backend/src/lib/redact.ts`, read as text, as the migrations and the chart are, with no import across workspaces), `contact.ts`, and the 14 days' notice of a change on both pages, read from the `- **Notice.**` bullet of `CHANGELOG.md`'s unpublished header, the rule a delivery reads when it writes an entry (D224), and each dated line of a changes section to the oldest changelog entry whose Notice paragraph names its day (issue #214). Both pages link one stylesheet, `src/legal/legal.css`, which imports `/about`'s and adds the introduction's date line, the links in a section's lines and 72 px below the content on the desktop; the build emits it as one content-hashed file. `check-build.mjs` fails the build when either page is missing, lacks its own title, has no body or carries `noindex`, when anything in it but a content-hashed file's name matches `LEGAL_CLAIMS` — `compl`, `152`, `roskomnadzor`, `gdpr` or `federal law`, in any case, the pages claiming compliance with no law and naming none but the one that governs the Terms (D224) — and on unhashed files and Scalar as for every page. The dev server serves both addresses of each with the same plugin. Both pages are the operator's texts (#369): `LEGAL_PAGES` is empty in a build whose `OPERATOR_TEXTS` is not `true`, `vite.legal.config.ts` then writes nothing (`build.write`), the footer links neither, the sitemap lists neither, and nginx answers both addresses with the application's 404, its `error_page` finding no file; `check-build.mjs` then refuses either file or sitemap entry.

The static pages share their header and footer band: `scripts/site-chrome.mjs` writes them as HTML — `siteHeader(page, lang, operator)` and `siteFooter(page, lang, operator)`, the given page marked `aria-current="page"` and `operator` the build's unless a test gives another (#369), in English unless `lang` is `ru` (D255), when they draw `ru.ts`'s `header` and `footer` and lead the wordmark to `/ru/` — from the constants the application's `AppHeader` and `AppFooter` use, and `src/static-pages/site-chrome.css` styles them as the application's Tailwind classes do; each page's own stylesheet follows it. `keptRuns(parts, renderPart)` there writes a run of text with addresses in it, each address kept on one line with the word before it, for `/about`'s story and the legal pages' lines alike.

The relay script (D202), `apps/frontend/public/webhook-inspector-relay.mjs` since 1.19.0 (D279), is a static file: nothing imports it, and the build writes it to `dist/webhook-inspector-relay.mjs` and, the same bytes, to `dist/qa-tools-relay.mjs`, its old name, from `public/` under the build's origins, byte for byte under production's (`scripts/build-site-files.mjs`, over the copy Vite makes; D274). It reads `https://webhook.qa-tools.ru`, the site's second origin, by default, and the build names the configured second origin, or the site's where there is none (D275); the old name serves the same file until the date the changelog gives. From 1.16.0 to 1.18.x the source was `public/qa-tools-relay.mjs`, served under that name as it was, and `renamedRelayScript()` wrote the new name from it. The dev server serves the file from `public/` under production's origins and through `vite.config.ts`, written the same way, under any other, and the old name through `vite.config.ts` always. It is a second client of the public API, run by a tester on their own machine to send a session's captures on to a local service (PRODUCT, Forwarding to a local service); the server forwards nothing. `/docs` gives its SHA-256, so `check-build.mjs` fails the build when either built file's hash is not the one `info.description` of the built `dist/openapi.json` gives, or either name is missing, and the frontend suite fails when the production file's is not the one the source description gives (`src/lib/relay-script.test.ts`, with `scripts/relay-script.mjs` reading both). The backend suite runs it as a child process against a real backend (`apps/backend/src/relay-script.test.ts`).

`scripts/build-security-txt.mjs` then writes `dist/.well-known/security.txt` (RFC 9116, D177): the contact from `src/lib/contact.ts`, which the script imports through Node's own TypeScript support, an `Expires` 364 days after the build, `Preferred-Languages` and `Canonical`. It is not committed either, and `check-build.mjs` fails the build when the file is missing, lacks a field, or its `Expires` is past or a year or more ahead. A build that names no contact address (`CONTACT_EMAIL`, #369) writes no file, nginx answers its address with a plain 404, and the build check refuses one that is there. The dev server does not serve it.

### The home page and its list of sessions
The home page (`pages/LandingPage.tsx`) has two states since 0.41.0 (D199): the first visit while this browser lists no session, and the returning visitor's once it lists one. Which one shows, the rows, their order, the days they are grouped by, the cut after five and every string of the list are decided by pure functions in `lib/home-view.ts`, which the unit tests target; the components only draw them (`components/SessionList.tsx` for the days and rows, `components/DeleteSessionDialog.tsx` for the confirmation).

The tile carries the new session's options since 1.7.0 (D249): the choice is the page's React state, never stored, and `lib/session-options.ts` decides what it sends — `createSessionInit`, which `api.createSession(options?)` passes to `fetch`: exactly `{ method: 'POST' }` at the defaults (D104), else the differing keys as JSON — and what the trigger and the hint say. From 768 px the tile is a two-column grid whose button spans both columns and lays its content out on them (`subgrid`), so its box is still the whole tile, and the trigger, a Radix dropdown menu (`components/NewSessionOptions.tsx`), sits in the second column over it; below 768 px the trigger is a line under the tile opening a Radix dialog bottom sheet with native radio buttons and a checkbox, as the request actions' sheet is built. A ref holds a creation in flight, so a double click sends one request.

The list itself is `lib/session-list.ts`: one `localStorage` key, `qa-tools:sessions`, holding `{"v":1,"items":[{"id","openedAt"}]}`, the most recently opened first and at most 50, with every access guarded as `lib/read-state.ts` guards its own, so unavailable, blocked or full storage is an empty list and no error. `SessionPage` adds its session once its load on mount has succeeded, and the home page adds the session it creates before navigating to it. The home page reads the list in its first render, so a returning visitor never sees the first visit first, and sends one status read, `POST /api/sessions/status`, for the ids it was opened with: the read is not a use of any session (D133), so listing sessions does not keep them alive. Sessions it reports `expired` or `not_found` are taken off the stored list. A read that fails leaves the rows as the list has them, by the day each was last opened, with the id in the URL's place, since the receive URL is the server's to give (D187). An answer that does not match the route's documented shape is that same failure: `readSessionStatuses` checks it field by field against the contract (`parseSessionStatuses` in `lib/home-view.ts`) — one entry per id sent, in order, one of the three states, each `active` field of its documented type — and refuses it whole, an unknown state included, so nothing is taken off the stored list; the page settles the read through `settleStatusRead`, which never rejects, so it cannot stay on `Loading sessions…` (D199). `Remove from list` and a successful deletion (`DELETE /api/sessions/:sessionId`, D198) take a session off the stored list too. The list does not follow other tabs live: a home page shows the list it was opened with, changed only by what is done on it. Two tabs writing it at the same moment are not ordered, since `localStorage` has no atomic read-modify-write: the last write wins, so one entry can be lost or a just-removed one come back (D199).

Each row's receive URL is a react-router `Link` to `/v/<id>`, stretched over the row by a pseudo-element, so a click anywhere opens the session and the copy icon and `⋯`, placed after it in the document, sit above it without a z-index that would lift them over a dialog. `⋯` is a Radix dropdown menu from 768 px up and a Radix dialog bottom sheet on a phone, as the request actions are; a choice hands focus on once the menu has closed — to the confirmation, or to the row that takes the removed one's place.

### Private sessions in the browser

Since 1.15.0 (issue #228, D259) the interface creates, opens and shares private sessions (D245, D253). **The key store** is `lib/access-keys.ts`, beside the list and guarded as it is: one `localStorage` key, `qa-tools:access-keys`, holding `{"v":1,"items":[{"id","key"}]}`, the most recently stored last, at most 100. A separate key rather than a field of the list's entries, so a bundle before this one, which rewrites the list with the fields it knows, never drops a key. Only values of a key's shape (43 characters of `A-Z a-z 0-9 _ -`) of a session id's shape are read or written. A key is stored only once its session has opened with it as private — the creation's `accessKey`, or a link's or a pasted key once `GET /api/sessions/:sessionId` has answered `private: true` with it — so a wrong key never replaces a right one, and a key held for a public session is dropped. Beside storage the tab holds keys in memory (`holdAccessKey`): a link's before its session has answered, and every key storage refused, so a link with access opens its session in that tab whatever storage does. A stored key is not held as well (`keepAccessKey`), so every tab reads the one stored copy and a key removed in one tab is gone from all; a held key another tab removes is let go of on its `storage` event (`watchAccessKeyRemovals`, installed by `main.tsx`). `accessKeyFor` asks storage first, then the tab: a stored key has opened its session, a held one may not have. `lib/session-list.ts` takes a session's key with its entry on every way out — `removeListedSessions` for `Remove from list` and a deletion, and `removeReportedSessions` for a status read's `expired` or `not_found`, which takes a session off only while the browser holds the very key the read was sent with, so an answer about an old key or none never removes a right key another tab stored meanwhile — and `recordSessionOpened` pushes out the least recently opened public session of a full list, a private one only when all are private, its key with it (`pushOut`).

**Sending it.** `api/client.ts` adds `Authorization: Bearer <key>` to every call for a session whose key the browser holds (`forSession`), and leaves a public session's call exactly as before; `getSession` takes an explicit key for the field's check. `readSessionStatuses` sends `accessKeys` only for the ids it asks about and only values of a key's shape (`accessKeysFor`), and no `accessKeys` at all without a key, so the body is `{ "ids": […] }` byte for byte as before and one bad stored value cannot fail the read (`400` / `1014`). `api/realtime.ts` opens a private session's socket with `[REALTIME_PROTOCOL, REALTIME_ACCESS_KEY_PROTOCOL_PREFIX + key]` (`sessionSocketProtocols`), computed once like its URL so every retry presents it, and a public one's with the URL alone. `packages/shared` and `buildInspectorUrl` are unchanged: the reply's and `/mcp`'s `inspectorUrl` never carries a key.

**The link with access** is `lib/request-link.ts`'s: `buildAccessLink` writes `<origin>/v/<id>#key=<key>`, or `#key=<key>&request=<request-id>` for a request, on the shared builder's page part. `SessionPage` reads it in a layout effect, before its first load and its socket (`readSessionLink`, bounded at 256 characters before anything is split): it holds a well-formed key unless the browser already holds one for that session, and replaces the history entry's address at once (`history.replaceState`, the router's state kept) with the request id alone, D182's link, which the page reads after its first list load as before, or with no fragment; a fragment of any other shape goes at once too. The same reading runs on every `hashchange` while the page is shown, since a link pasted into the address bar of that session's tab loads no new document and mounts no new page: a key is taken out at once and held, and `SessionPage` opens its view afresh. There it goes through `takeKeyUnlessMove` (`lib/move-link.ts`), which leaves a move link's fragment in the address for `main.tsx`'s reload and hands every other one to `takeKeyFromAddress` (#345), as the reading after the first list load leaves it too (#362). The load that succeeds keeps the key for a private session, before the list records it, and lists nothing when that key went meanwhile (`settleOpenedKey`); a refused load lets the tab's unchecked key go (`settleLoadFailure`). `Session not found` (`components/NotFound.tsx`) is that page for a missing and a keyless private session alike, in every state; its field reads a value with `readPastedAccess` — the key alone for its own session, or a link with access of this origin — checks it with one `GET` (`lib/open-with-access.ts`: one check at a time, none heeded once the screen has gone, R7's sentence only for a missing or gone session), keeps the key and opens the page afresh (`SessionPage` remounts its view, since `Session not found` is final for a page, `settlePageStatus`) or navigates to the link's session. The card (`components/EndpointCard.tsx`) shows `· 🔒 PRIVATE` and the split `Copy ▾`, and `RequestActions.tsx` puts the key in a private session's `Copy link`; neither shows it.

### The move to the new address

Since 1.17.0 (issue #321, D276) the inspector's pages on its old address carry a browser's state to the new one. **The build** hands the bundle the move as `__WEBHOOK_INSPECTOR_MOVE__`, a Vite `define` in `vite.config.ts` from `scripts/move-setting.mjs`: `{ from, to, day }`, the site's origin `APP_ORIGIN`, its second `APP_ALIAS_ORIGIN` (D274, D275) and day X, read from the sentence `From <YYYY-MM-DD> they stop answering` of the changelog's Deprecated paragraph, the one place with D275 that names it; `null` for a build with no second origin, whose changelog leaves that paragraph out (#343), and a build with one whose changelog names no such day fails. `lib/move-link.ts` reads it as `BUILT_MOVE`, `null` outside a Vite build, in the unit tests. **The banner** is `components/MoveBanner.tsx`, which `AppHeader` draws above the header, so every page that draws the header — the home page, the session page in every state, `Page not found` — shows it, and only while `window.location.origin` is the move's `from` (`moveBannerShown`); it has `--color-row-selected` behind it and `--color-move-line` under it. Its text is the dictionary's `move.notice`, cut around the host by `moveNoticePieces` (since 1.19.9, #347), which writes the sentence once with a mark in the host's place, so the host is never searched for in the words; the host is a `whitespace-nowrap` span that no line breaks at its hyphen or dots, the words around it wrapping as the browser wraps them. Its action's `href` is the new origin alone; the click builds the link from storage (`collectMove`, which reads each store with its own reader) and follows it with `location.assign`, so the link with its keys is never in the page.

**The link** is `<to>/#move=<base64url JSON>`, `{"v":1,"sessions":[{"id","openedAt"}],"keys":[{"id","key"}],"language","queueSection","rulesSection"}`, the last three only where the old address stores a value. `main.tsx` reads it before anything else, before the language is decided (`takeMoveFromAddress`), and on every `hashchange` that brings one reloads the page so it is read the same way; a session page's own readings leave the fragment in the address for that load — its `hashchange` reading (`takeKeyUnlessMove`, #345) and its one reading of a request link after its first list load (`resolveRequestLinkUnlessMove`, #362) — since a browser may take the address to reload only after every listener has run, or only after a list load in flight at the paste has answered. `readMoveFragment` is bounded: one search for `#`, a length check of at most 32,768 characters before anything is decoded, a base64url check, `atob`, `JSON.parse`, then field by field with the stored formats' own checks — a session id's shape, `isTimeValue`, a key's shape, `en` or `ru`, booleans, at most 50 sessions and 100 keys, no id twice — any fault refusing the whole link. The address loses the fragment whatever it held (`history.replaceState`, the history entry's state kept). A read link is merged add-only by the stores themselves: `mergeMovedAccessKeys` (`lib/access-keys.ts`) adds a key only for a session that holds none, in the room left under 100, the listed sessions' first, as less recently stored than every key held; `mergeMovedSessions` (`lib/session-list.ts`) keeps every entry, takes the later `openedAt` of one already listed and adds new ones in the room left under 50, private ones first; the language and section states are written only where their readers find none. `App` shows the toast (`moveArrivedToast`), with the counts the stores hold afterwards, over whichever page opened. `lib/move-link.test.ts` and `lib/move-setting.test.ts` hold the format, the refusals at growing sizes, the merge and the visibility; `lib/move-render.test.ts` renders the banner on each origin, its host in the one span that does not wrap, and starts `main.tsx` with a link, so the toast is read from the page drawn (#346); E2E-21 pastes a link over the home page and a session page.

### Session expiration UI
The backend provides an absolute `expiresAt` timestamp as the source of truth. The frontend does not count down to it and does not act on it: the expiry slides on every use of the session, so the endpoint card states the rule — `SESSION EXPIRES 7 DAYS AFTER LAST USE` (D158) — and nothing on the client declares a session dead (D133). Since 1.7.0 the rule is the session's own (D249): `sessionExpiryLine` in `lib/session-lifetime.ts`, a pure function of the session read's `expiresAfterIdleSeconds`, `lifetimeEndsAt` and the language, writes its window in whole days, hours or minutes, rounded down, or the fixed end of a session created with a lifetime in the viewer's time zone, and today's line for anything outside the contract; `sessionAddressMarker` adds `IP NOT STORED` for a session whose `storeSourceIp` is `false`, whose rows and detail then read `IP not stored` (`lib/address.ts`).

The page learns that a session is unavailable from an API answer, never from a local verdict, and shows one screen for both `410` and `404`. Four things produce that answer: the load on mount, any action the viewer takes, **the session reload the page runs on every realtime connection**, including every reconnection, and, since 1.7.0, **the same reload every 10 minutes** while the page shows the session (`readSessionPeriodically`, D249). The last two are also what makes an open tab a continuing use of its session, since reading a session slides its expiry: the backend moves a short window's expiry at most once a tenth of it (D242), so a read every 10 minutes keeps even a 1-hour session alive. The timer's read starts none while one is in flight, goes on while the tab is hidden, and keeps the page as it is on any failure but `410`/`404`; it is a read, never a verdict of its own. A connection the backend refuses closes with `4404`/`4410` and moves the page to the same screen, and so does an established connection the backend closes with `4404` because its session was deleted (D198). Once there the page stays there: every change of its status goes through `settlePageStatus` (`lib/session-lifetime.ts`), so nothing that answers later — the load on mount that read the session before it was deleted, a reload, an action — puts the session back on screen. An established connection is **not** closed when its session expires (D076), so a tab whose socket never drops and which receives nothing is told on its next reconnection, action or reload rather than at the moment of expiry.

### Time display
Backend and database timestamps use UTC/timezone-aware values. The frontend renders absolute request times in the user's browser-local timezone. Relative-time labels are not used in v0.1. The detail panel's time and the home page's day headings take their month from the dictionary's fixed table, English or Russian genitive (`17 сент. 2026, 14:32:06`); list rows write `2026-09-17 14:32:06` in both (D148, D222).

## Backend
Stack:
- Node.js
- TypeScript
- Fastify

Fastify handles the HTTP API, webhook receiver, and WebSocket connections.

The process runs **two listeners** since 0.36.0 (D187): the application listener (`buildServer`, port 3000) serves the API, the realtime endpoint, the MCP server `/mcp` (D203), the probes and the `410` for `/s/…`; the receive listener (`buildReceiver`, `RECEIVE_PORT`, 3001) serves `/s/*` and its own `robots.txt` and nothing else. They are two Fastify instances built from one `createApp` — the log and its serializer, the timeouts, the methods, the error contract, the not-found route's `404` before any body (D227) and the receive URL's protective headers are the same code — and share one realtime hub, which the process's realtime listener feeds with the events every backend process on the database has committed, its own included, so a capture on either listener of any process reaches the viewers connected to every process (D074, D221; [Realtime](#realtime)). With `RECEIVE_HTTP2=on` the receive listener builds a third instance from the same `createApp`, on Node's HTTP/2 server, for the connections that open with the HTTP/2 preface ([Webhook capture](#webhook-capture), D263). The receive listener opens first, so the pod is never ready before it can receive, and readiness waits for the realtime listener's first read too.

A deployment rolls the backend since 0.54.1 (D088, D221): the new pod starts, migrates and becomes ready beside the old one, which only then is told to stop, so for those seconds two backend processes serve, each with its own registry fed by the outbox and its own per-process counts ([Infrastructure](#infrastructure)).

How the process ends (`lifecycle.ts`, D221): the pod's `preStop` hook sends SIGUSR2 and pauses 10 s; SIGUSR2 starts the **drain** — both listeners keep serving and an answer then closes its connection, `Connection: close`, the receiver's own reply to a webhook included, unless another request of the same socket is in flight, ahead of it or behind it, when its head is written (`lib/drain.ts`), so that Traefik, which drops the terminating pod meanwhile, keeps no connection to it. A pipelined pair whose first answer is held by a configured delay, the second's head written first, goes out keep-alive, and that connection closes on its next answer or at SIGTERM. SIGTERM then drains if SIGUSR2 did not, closes both listeners — a request arriving on a connection a listener still holds is served rather than answered `503` (`return503OnClosing: false`), the application listener's close first answers every list call held by `wait`, as if its time had run out (D200), and every realtime connection is closed — waits for what is in flight, a webhook reply held up to 30 s by its delay included, then for the completion writes those replies started, then stops the realtime listener and ends both pools. A wake-up still inside its 20 ms window when the listener stops is not sent (#260): the last completions' events are in the outbox, and the other processes read them at their one-second tick (D221). Kubernetes allows 60 s for all of it.

The backend has no build step: Node 24 runs TypeScript sources directly through native type stripping, in development and in production alike. TypeScript remains responsible for type checking through `tsc --noEmit`.

The application is organised by module: routes translate HTTP to calls and back, services hold the rules that unit tests target, and repositories contain SQL. Configuration is read and validated at startup so that a missing value fails immediately rather than on the first request. A process has two connection pools since 1.15.7 (D244, `index.ts`): capture's own, 10 connections, for the receive listener's captures and completion writes and for `/readyz`, so that no call of the API can take a connection a capture needs, and the API's, 6, for `/api`, `/mcp`, `/ws` and the realtime listener's prune; each connection names its pool in `pg_stat_activity` (`application_name` `webhook-inspector-capture` or `webhook-inspector-api`, D278), and neither has an acquire timeout. SIGTERM closes the servers before ending both, so that a rollout does not drop in-flight requests. The realtime listener holds one more connection of its own, outside the pools: about 17 a process, twice that during a rollout's overlap. Every connection of the pools and the realtime listener's own asks the server at its start for an `idle_in_transaction_session_timeout` of 60 s (`db/pool.ts`, D221 point 19): no transaction of the application waits for anything but its own statements, so one left idle that long is a stall or a leak, and the server ends it, its locks and its outbox event with it. A connection the server ends — so, or at a restart of PostgreSQL — is discarded by the pool rather than ending the process: its caller's query fails as any failed query, the next opens a new connection, and it leaves one `warn` line, `A pooled database connection ended`, with the error's message and code (D221 point 19). The backup's and `qa_readonly`'s connections ask for no timeout.

Session ids are shortened before they reach the log. The id is the access key to a session (D004), so a complete one must not sit in log output. Redaction is applied to the serialised line as it leaves the process, so it covers error messages and stack traces as well as request URLs (D059). In a session-id position of a URL — the path segment after `/s/`, `/v/`, `/api/sessions/` or `/ws/` — anything longer than 8 characters is shortened whatever it holds, so a near miss of an id is too (D168); elsewhere in a line every run of 43 or more id characters is shortened whole to its first 8, so an id glued to other id characters keeps at most its own first 8 (D059, amended with 0.57.2).

**A session may carry an access key** (1.2.1, D245, amending D004; the interface sends it since 1.15.0, [Private sessions in the browser](#private-sessions-in-the-browser), D259). Its SHA-256 fingerprint is `sessions.access_key_hash`; `NULL` is a public session, which answers exactly as before whatever key a call sends. Since 1.11.0 a creation with `"private": true` sets it, and the session is **private** (D253): the route reads `Authorization` only then, through `creationKey` beside `bearerKey` — no header draws a key, as `generateSessionId` draws an id, answered once as `accessKey`; `Bearer <key>` creates the session under that key, never answered back; a header carrying no key is `400` / `1005` after every rule of the body — and `createSession` hands `insertSession` the key's fingerprint alone. `create_session` over MCP creates it under the call's own key and never draws one. `GET` and the create answer say `private`, read as `access_key_hash IS NOT NULL`; nothing ever answers the key again. A keyed session answers only a caller that presents its key, and anyone else exactly as a session that does not exist: `404` / `1001`, the socket closed `4404`, the MCP tools' not-found error, `not_found` in the status read — expired or not, so a refusal never reveals `410`. The decision is one function, `opens` (`modules/sessions/access-key.ts`), which compares the key's SHA-256 digest with the fingerprint by `timingSafeEqual`; a key has a session id's shape, 43 characters of `A-Z a-z 0-9 _ -` (D161), and any other value is no key. Every service function that reads or changes a session makes the check where it would find the session missing, so the routes, `/mcp` and the socket cannot drift apart: the paths that lock the row — a response change, a queue call, the session's deletion — check it with the lock held, before the expiry; the session's read and the socket first read the fingerprint and the expiry's verdict alone, by `sessionAccess`, one statement whose answer is the same two small columns whatever the session stores, so a refusal costs a keyed session what it costs a missing one; the session's read loads its response and queue only once the key has opened it, and the socket never loads them; every request path reads the fingerprint by `requireAccess` right before its own statement — after the query string, the body, a place for bodies or a search slot, before a wait subscribes — and answers a missing session there too, so the two cost one statement each. So every answer that comes before the session is looked up, `413`, `415`, `429` and the per-address limits included, is the same for a keyed and a missing session. A refused call is not a use: nothing is written, no expiry moves (D133, D242), no event is announced, and a refused deletion closes no viewer. The check is made apart from the statement on the request paths, which is sound because a fingerprint is set at creation and never changed. The key arrives as `Authorization: Bearer <key>` on the API and `/mcp` (the scheme in any letter case), beside each id in the status read's optional `accessKeys`, `{ "<id>": "<key>" }`, and as a subprotocol of the socket's handshake ([Realtime](#realtime)) — never in a URL, which the log keeps (D168). The log records no header, no error body quotes a key, and no event carries one. The receive host never asks: a webhook is captured into a keyed session as into any other.

The log runs at `info`. Fastify logs every request as `incoming request` and `request completed`, but for the probes, which log at `warn` and above (`modules/health/routes.ts`), and since 1.0.13 a call a per-address limit refuses, which writes neither (#189, the rate-limiting paragraph under Infrastructure). A request whose connection ended before its body arrived — a client that gave up, Traefik's 60 s `readTimeout`, a chunked body Node's parser refused — is not a fault of the server: it is logged once at `info` as `Request aborted by the client`, with its request id, and the application writes nothing further to the connection; a `400` or `408` Fastify's client-error handler already wrote stands (D142). A list answer with content whose client left before it began — before its list statement or while it ran — is logged with the same line, by the list's own code, and is not begun; one cut off once begun is Fastify's `stream closed prematurely`, at `info` too (#212). A failure on a request that arrived whole is still `Unhandled error` at `error` level and a `500` (D174).

Kubernetes probes are two distinct endpoints: liveness answers from the process,
readiness queries the database through capture's own pool, so that a flood of
API calls holding every connection of the API's cannot mark the pod unready
(D244), and answers `503` until the realtime listener has read the outbox once
(D086, D221). They are not routed by the Ingress, and log at
`warn` and above only, since readiness is asked every 2 s. Liveness gives
`/healthz` 5 s to answer and restarts the pod only after 6 failures in a row,
15 s apart, so a busy process that answers within 5 s is never restarted and a
silent one is within 95 s; Kubernetes' defaults, 1 s and 3, restarted the busy backend five
times on 2026-10-15 (#205, D264). Readiness keeps its 1 s and 15 failures.

The list filter's search of headers and bodies (D191) is the one route whose
cost is every stored byte of a session:
`POST /api/sessions/:sessionId/requests/search` runs one statement,
`position(<word> IN raw_request)` per word over the session's requests, with no
index. Two things bound it. The statement runs in a transaction of its own with
a `statement_timeout` of 2 s set for that transaction alone, so no other query
has a timeout; and a counter in the process allows two searches at once and
refuses the third (`modules/requests/search.ts`), so searches hold at most two
of the API's pool's connections, and never one of capture's (D244). The counter
is per process: there is one process, and for the seconds of a deployment two
(D221). The words arrive in the
request's body and are bound as parameters, so they reach neither a URL, nor
the log, nor the statement's text.

The query of requests (D196), `POST /api/sessions/:sessionId/requests/query`,
is the list with header and body conditions, and its body conditions read the
stored bodies as the search reads raw requests: it runs under the same
statement timeout, and a query with a body condition takes its place from the
same counter, so two searches and such queries together run at once. A query
without one - header conditions alone, or none - reads no body and takes its
place from a counter of its own, two at once (`createQuerySlots` and
`slotsForQuery` in `modules/requests/search.ts`, D250), so parallel tests
finding their webhooks by a header neither wait for a search nor hold one up;
its header conditions still read every stored header line, so the count stays
bounded. The four places would let the process's searches and queries hold
four of the API's pool's six connections; since each runs inside one of the
three slots of the gate in front of the API's work, at most three of them run
at once (D244). Either counter refuses `429` / `1012` with `Retry-After: 1`,
to a call that holds its slot and finds every place of its counter taken. The query's conditions arrive in the request's body for the
same reason as the search's words. The list's own query parameters
(`include`, `limit`, `order`, `after`, `since`)
carry no captured data and stay in the URL; both routes are
parsed in `modules/requests/list-query.ts` into one query that one statement
answers, with the session's state and the request `after` names read by it
too (D068). That statement reads no content: an answer that includes content is
streamed one request at a time (`modules/requests/list-answer.ts`), each
request's headers and body read by id just before it is written and a body
written in pieces, because 20 bodies of 1 MiB can be 120 MiB of JSON once
control characters are escaped, and reading them all first outgrew the
backend's 512 MiB with a few such answers at once. A request gone by the time
its content is read is replaced by those that follow the last one chosen, from
its receipt time to the microsecond, through the same statement - on the query
route in a slot of the same counter as its first statement's and under the
timeout - so an answer is short only where nothing follows (D196, D250). A `HEAD` on the list, which Fastify answers through
the `GET`'s route, handler and hooks included, gets the `GET`'s status and
headers and nothing is read for its body: the route's `onSend` destroys the
answer's stream before its first content read, where Fastify had drained it
to no one after the head was sent, past the body-list place and the call in
flight that had been given back by then. So a `HEAD` costs its list
statement, and holds its call in flight, and with bodies its place, for that
alone (#210, D201's note on point 8).

The status read of the home page's list (D199), `POST /api/sessions/status`,
takes up to 50 session ids in its body, checked in `modules/sessions/status-body.ts`
before anything is read, reads the asked ids' access-key fingerprints
(`openSessions`, D245), and answers the ids found open with one statement
(`SESSION_STATUS_SQL`, `modules/sessions/repository.ts`); both only read: no
lock and no refresh, so no expiry moves (D133). Expiry is judged against
`clock_timestamp()` once per session, an expired session's requests are not
read (D068), and `lastUsedAt` is `expires_at` minus the session's own idle
window, `idle_seconds`, subtracted with the interval of seconds creation and a
refresh add (D242); for a session created with a lifetime, whose
expiry no use moves, it is the later of its creation and its newest request
(D220). The ids arrive in the body for the reason the
search's words do: no URL, and so no log line, holds them.

The MCP server (D203), `POST /mcp` on the application listener, is MCP's
Streamable HTTP transport, stateless and written by hand
(`modules/mcp/`): `protocol.ts` checks a request — the JSON-RPC message, the
`Origin`, `Accept`, the protocol version and the query string the URL may not
carry — and shapes the answers;
`tools.ts` maps each of the seven tools onto the service functions the API's
routes call, whose changes announce what the routes' changes announce (D221); `captured.ts` cuts a body
to 64 KiB and wraps whatever a sender wrote in `untrustedCapturedContent`
after a fixed sentence; `routes.ts` is the Fastify scope, with a body parser
that takes any body as bytes, which the handler lets go once the message is
read, and whose synchronous part, a function of its own, checks the request
and has the tool's `read` step build anew what the call needs: only that
reaches the tool's `run` step, so a pending `wait_for_request` holds neither
the body nor the parsed message; a hook that refuses a URL with a query
string on every method before the body is read, so no request held keeps a
URL of the caller's making; its own error handler answering in JSON-RPC's
shape; and `405` for every method but `POST`, answered before the body is
read. A `POST` whose body is over 128 KiB, or chunked, takes one of D205's
eight places of large bodies before it is read and gives it back once the
message is read and checked (D213). A message the transport and the count let
through then waits for its turn in the gate in front of the API's work, with
its message read (D244): a tool call, and `initialize`, `ping`, `tools/list`
and every other answer the server makes itself. The tools' names, descriptions
and schemas are plain data in `packages/shared/src/mcp.ts`, which the
frontend suite holds the agent documentation to. It shares the process's
pending waits (D200), the search's two places and the header-only queries'
two (D191, D250), the two counters of
the per-address limits (D201) and the 128 calls an address may have in
flight (D213) with the API: `registerRateLimits` answers the counters, and
`/mcp` counts each request once its body says which limit it counts toward,
having taken its place in flight before the body was read. The product version `initialize` reports is the API
description's `info.version`, which the backend image copies in for it.

Backend responsibilities:
- create sessions
- change a running session's response (D150)
- delete a session with everything it holds (D198)
- read the status of up to 50 sessions without using them (D199)
- validate session existence/expiration
- capture webhook requests
- enforce 1 MB payload limit
- enforce latest-1000 request retention
- serve session/request APIs
- delete/clear requests
- search the raw requests of a session for the list filter's words (D191)
- list requests with their headers and bodies on request, filtered by header and body conditions, and paged by `after` (D196)
- announce new-request metadata, response summaries, deletions and response changes to the viewers of every backend process, through the outbox and over WebSocket (D221)
- serve the same operations to AI agents as MCP tools at `/mcp` (D203)
- return consistent API errors

## Realtime
Technology: **WebSocket**, at `/ws/:sessionId`.

HTTP remains the mechanism for CRUD/actions. WebSocket is used for realtime notifications of newly captured requests, their recorded responses and their deletion, and of changes to the session's own response (D152), and for nothing about session expiry: a changed expiry is not broadcast, and there is no countdown to tick (D133). The connection is one-directional: the viewer sends nothing.

`request.received` contains lightweight list metadata only. Request bodies and full headers are not sent over WebSocket. Full details are fetched over HTTP when the user selects a request.

`response.recorded` carries a light summary for the same reason, and that shapes what the client does with it: it updates the list row from the frame, and it **refetches the detail endpoint** when the event names the request whose panel is open, because the panel shows the whole record and the frame does not carry one (D125). So an open panel is kept live by an HTTP read that a WebSocket frame triggers, never by a frame that carries the data — which is what keeps **recorded** response bodies, and captured request bodies, off every socket. `session.updated` is the one frame that carries a body: the session's configured response, headers and JSON body of at most 64 KiB included, and since 0.46.0 the steps of its response queue, up to ten more such responses, and since 1.3.0 its response rules, up to twenty more (D246), which every viewer of the session already reads from `GET /api/sessions/:sessionId` (D152, D205). The refetch reuses the detail request token without advancing it and is applied only while both that token and the selected request still hold, so a viewer who switches rows mid-update sees the row they switched to; a refetch that fails is discarded and leaves the panel showing what it already had. Neither the opening answer nor a refetch moves the panel back to an earlier reading of its response: an answer for the request whose panel is open is not applied when it reads `pending` and the panel shows any other state, `unknown` included, or when it reads `unknown` and the panel shows a recorded state (`sent`, `aborted`, `failed`), whichever order the two land in. A record leaves `pending` once and never returns to it, and `unknown` is derived on read from a record still stored `pending`, so reads of one record go `pending`, `unknown`, recorded and never back, and such an answer was read first (D125, #204). And every `ready` while a request is open refetches its detail beside the list reload, since a `response.recorded` sent while the socket was down reaches no one.

**Every change writes its event to the outbox, and every process delivers what it reads there** (D221, amending D074 and D075). Open connections are held in an in-memory registry keyed by session id, in each backend process (`RealtimeHub`), and nothing calls it to announce a change. A change — a capture, a recorded response, a request deletion, a clear, a response change, a queue saved, started again or removed, response rules saved, a session's deletion — appends its event to the table `realtime_events` as the last statement of its own transaction (`modules/realtime/events.ts`), under the lock that orders it, so the event exists exactly when the change does; a refused or failed change rolls back and announces nothing. A recorded response is one statement that commits on its own, its guarded update and its event together (`RECORD_COMPLETION_SQL`, #260). Once `COMMIT` has returned, the writer asks its own process's listener to read and sends the other processes one coalesced wake-up, a `NOTIFY` in a transaction of its own with `synchronous_commit` off: no `NOTIFY` is ever made inside a transaction that writes WAL, because PostgreSQL commits notifying transactions one after another, each waiting for its own flush, which cost a burst of captures 25 % (D221 point 4). Both wait for a window of 20 ms (`COALESCE_MS`, #260) that the first commit opens and every commit until its end joins: the commits inside one window cause one read and one wake-up, where each caused one of each, and a process woken reads at once, so an event reaches the viewers of every process at most 20 ms later than without the window. Each process's `RealtimeListener` (`modules/realtime/listener.ts`), one connection outside both pools, reads at the end of a commit's window, at once on a wake-up from another process, and every second: one statement returns its snapshot's transaction horizon and every row at or above the previous read's horizon, in id order, so every committed row is returned by the first read whose snapshot sees it, and a transaction still in progress holds the floor below its rows. A row not read before is marked seen; a `close` closes the session's connections with `4404`; a row someone on the process wants has its payload fetched by id, 32 at a time; nothing is fetched for a session nobody on the process watches. Everything is delivered in id order. An event that must follow another is inserted after that other committed — under the session row's lock for whatever moves the queue and for the deletion, after its cause for a request's recorded response and deletion — so its id is larger, and every viewer of every process receives a session's events in the order the changes took the lock (D205 point 12). That rests on the identity's `CACHE 1`, on `READ COMMITTED`, and on the floor being a transaction horizon, never an id. A clear locks the session in a statement of its own and deletes in a later one, so a capture that held the lock first, on any process, is deleted with the rest. `RealtimeHub.inOrder` still keeps each session's line within a process, so that calls waiting for one session hold no pool connection (D205), nor a slot of the gate in front of the API's work: a change of the API gives its slot back before it joins the line and runs its turn without one, so that calls waiting there hold nothing the API's other calls need, and a session's captures never wait behind a change for the API's other work (D244).

Every viewer of the session receives each event, the one that made the change included; no origin is tracked, because applying a deletion is idempotent (D136). A refused deletion announces nothing, and a clear announces on every `204`, emptied session or not. The client applies a deletion as its own deletion already does — dropping the row by id or emptying the list, advancing the list generation so a reload in flight cannot restore a row, and closing a detail panel showing the deleted request through the same `discardPendingDetails()` (D137). `session.updated` carries the whole new response state rather than a difference, so a viewer replaces what it holds and applying it twice changes nothing; an open settings surface follows it only until the viewer has chosen something in it, and from then on keeps the choice — last write wins (D152). Saving, restarting and removing the response queue announce it the same way, the queue in the state, and so does saving the response rules, the rules in the state (D246); a restart or a removal on a session without a queue changes nothing and announces nothing. A capture that takes a step of the queue announces no `session.updated`, which would carry every step: its `request.received` names the step, `queueStep`, and the client moves the queue's `next` from it, as it starts the queue again on `requests.cleared`. A session read, on mount and on every `ready`, may have been taken by the server before or after the events that arrive while it is in flight, so the client keeps those events — `session.updated`, the steps, the clears — and applies them on top of what the read answers, in the order they arrived: each is absolute, so a `session.updated` or a clear the read already holds changes nothing and one it lacks brings it forward, while a step sets `next` to the one after it, so a read that already holds a later step is a step behind until that step's own event arrives a moment later (D205's accepted consequences); of two reads in flight one that began before a read already applied is not applied (D152, D205). An answer may reach the client up to about 20 ms before the event of its own change (#260).

**A channel that may have missed something is never used as if it had not** (D221 point 7). A listener whose connection errors or ends, whose statement goes unanswered for 5 s, which completes no read for 5 s, which finds a wanted row gone, or which holds more than 100,000 marks or 10,000 wanted events, **deafens** the registry: every connection of the process is cut — its viewer sees `1006`, reconnects with its delays and reloads on `ready` (D077, D079) — and every pending wait is answered after one last read, as at shutdown. It connects again, from 250 ms up to 5 s apart, and reads once marking every row seen before the registry hears again; meanwhile a new connection is closed `1013`, Try Again Later, which the viewer retries, and a new wait answers its first read. The viewer's reload is the catch-up; there is no catch-up by id.

The registry holds, against each open connection, the set of **optional** event types that connection declared when it was established, on the `?events=` query parameter of the socket URL (D115). Fan-out honours it: an event whose type is negotiable is skipped for a connection that did not declare it, and an event whose type is not negotiable reaches every connection exactly as before. The declaration is decided by whichever process accepted the socket, so it stays correct under any deployment strategy. The negotiable set — `response.recorded`, `request.deleted`, `requests.cleared` (D135) and `session.updated` (D152) — is defined once, in `packages/shared`, and imported by the registry rather than restated beside it — a second copy is how the gate would invert itself later without anything erroring.

A connection to an unknown or expired session is refused with a close code matching the HTTP answer for the same session: `4404` and `4410` (D076). Since 0.57.1 one address may have 16 connections open on a process, an IPv6 address by its `/64`: the 17th is refused before the upgrade with an HTTP `429` / `1020`, not a close code, so D076's table is unchanged and the viewer retries it as any interruption (D079, D227).

**A keyed session is watched only with its key, offered as a subprotocol of the handshake** (1.2.1, D245): `Sec-WebSocket-Protocol` carrying `webhook-inspector.access-key.<key>` (`REALTIME_ACCESS_KEY_PROTOCOL_PREFIX`), or `qa-tools.access-key.<key>` (`OLD_REALTIME_ACCESS_KEY_PROTOCOL_PREFIX`), its name before 1.19.0, until the date the changelog gives, or both with the same key (D279). A browser cannot set `Authorization` on a socket, and the URL reaches the log (D168). A first message was the other way and was not taken: the server would have to wait for it, and to wait alike for a session that does not exist, or the wait would tell them apart. With the handshake, a connection without the key, or with another, is closed `4404` `Session not found` by the very lookup that closes one to a missing session, right after it, with nothing awaited between and no message read — the same statement, which reads the fingerprint and the expiry and nothing the session answers with (`sessionAccess`), the same code and reason. A browser fails a handshake that offered subprotocols and was answered none, and the server never writes the key back: it answers the first offered subprotocol that carries no key, as `ws` answered the first before (`chooseProtocol`), so a client offers `webhook-inspector` (`REALTIME_PROTOCOL`), or the old `qa-tools`, beside the key and that is echoed. The prefixes are compared exactly here too, so a name that starts with either in another letter case carries no key and is answered like any other name, as before 1.19.0 (D279's #356 amendment). The page offers `webhook-inspector`, then the key under the new prefix and under the old, in that order, so that a backend of 1.18.x, which reads the old prefix alone and echoes the first name that does not start with it, opens the session too while the backend rolls (D221, D279). The choice is made before the session is looked up, so it says nothing about the session. A connection that offers no subprotocol, as every tab does on a public session, is answered as before.

**Pending waits of the request list are subscribers of the same registry** (D200). `GET /api/sessions/:sessionId/requests?wait=N` registers one for its session (`modules/requests/wait.ts`), declaring `requests.cleared`, **before** it reads the list, and reads the list again on every `request.received` delivered for the session; a capture's event is delivered only once it has committed, on whichever process (D075, D221), so one that commits after the first read began is announced to the wait, and one that committed before is seen by that read. Announcements that arrive during a read are folded into one more read after it, and the first outcome settles the wait: a list that is not empty, `[]` on `requests.cleared`, `404` / `1001` when `closeSession` closes it after a deletion (D198), or the answer of one last read when its time runs out, which reads the session's state too. A wait is a registration like a socket, so `countFor` counts both, and it leaves the registry — with its timer — the moment it is settled or its client's connection closes. A capture taken by another process ends it as one taken here does, through the outbox (D221). The application listener keeps its pending waits in a `PendingWaits` set, which a `preClose` hook runs out on shutdown; an answer written then carries `Connection: close`, set in the route's `onSend` hook so that an error answer — `410`, `404`, `500` — carries it too, so that a connection kept alive by Traefik does not hold the close until its idle timeout. Waiting ends with the list chosen, and only then is it written, through the same `sendList` as every list.

A session deleted through `DELETE /api/sessions/:sessionId` closes its viewers on every process (D198, D221). The deletion writes the session's `close` in its transaction, and a `DELETE` that finds no session for a well-formed id writes one after its rollback; each process, reading it, calls the registry's `closeSession`, which forgets every connection of that session at once — so nothing delivered afterwards reaches them — and closes each with `4404`, the code a connection opened afterwards is refused with; other sessions' connections are untouched. A connection being set up during the deletion would otherwise escape it: its lookup can read the session before the deletion commits and register it after the close has been read. The registry therefore counts the closes it has run, process-wide, and counts a deafening as one; the realtime route reads the count before its lookup and again once the connection is registered, and when it changed looks the session up a second time and closes the connection with `4404` if the session is gone. A deletion whose close was read before that second lookup is seen by it, and one read after it finds the connection registered and closes it, after its `ready` if that was sent first. The `404` case repairs a deletion whose close a process never read; a deletion whose acknowledgement was lost closes its viewers at once, its `close` committed with it. Expiry still closes nothing (D076).

An accepted connection is confirmed with a `ready` message, sent after it has been subscribed. It is registered held (`hold`): what is delivered to it until `ready` is sent, during the second lookup above, is kept and sent right after `ready`, in the order delivered (`release`), so `ready` is always the first message and nothing in between is lost (D198). A connection may fall at most 4 MiB behind (`MAX_SUBSCRIBER_BACKLOG_BYTES`): an event that would take what it has not yet written to the network — `ws`'s `bufferedAmount` — or, while it is held, what is held for it, over that bound terminates it and drops it from the registry instead of being sent, so a peer that stops reading cannot gather the session's events in the process's memory until the heartbeat notices; the viewer reconnects and reads again what it missed (D074, D079, D205 point 13). The registry reports such cuts to the application listener's log at most once a minute, naming no session. The viewer reloads the list on `ready` rather than on the socket opening, because the handshake is accepted before the session is looked up and the two moments are not the same (D081).

Idle connections are kept alive by a server-side ping every 30 seconds, because the Ingress closes silent connections while a session lives for days (D079). The viewer reconnects with a growing delay and reloads the request list on every connection, which is what makes a request captured during an interruption appear without a manual refresh (D077). A `response.recorded` that arrives while that reload, or the page's first load, is in flight is kept with the load and written onto the row its answer brings, since the answer may have been read before the response was recorded (#174, D077).

The View page is mounted per session, keyed by the session id, so no state can survive navigation from one session to another (D080).

Deleting one request and `Delete all` reach every open viewer of the session through `request.deleted` and `requests.cleared` (D135–D137, above); the sentence that called this outside v0.1 predated them and was corrected with issue #36.

## Database
Use PostgreSQL only in v0.1. Do not introduce Redis or ClickHouse.

The executable schema lives in `apps/backend/migrations` as numbered SQL files and is the source of truth. The fields below describe intent; the migrations describe the exact types and constraints.

### `sessions`
Conceptual fields:
- `id`
- `created_at`
- `expires_at`
- `response_status`
- `response_headers`
- `response_body`
- `response_delay_ms`
- `response_custom_disabled`
- `response_template`
- `response_queue`
- `response_queue_answered`
- `response_rules`
- `lifetime_ends_at`
- `idle_seconds`
- `store_source_ip`
- `access_key_hash`

The four configuration columns hold the session's custom response (D099) and are all nullable, with no default and no backfill. `response_status IS NULL` says the session has never had a custom response (D102). `response_headers` is `jsonb` holding the same ordered `[name, value]` pair array as captured headers, validated by the same function, so duplicates and order survive (D045). `response_body` is `TEXT` rather than `jsonb` on purpose: `jsonb` reorders keys, drops duplicates and rewrites whitespace, and the body is promised back exactly as it was entered. Its JSON validity is checked whenever it is written, at creation and on a change (D150).

`response_custom_disabled` (migration `005`, D151) is the mode. A session answers its custom response exactly when `response_status IS NOT NULL AND NOT response_custom_disabled`; picking the default sets the flag and leaves the four columns as they are, so switching back restores them. It is `NOT NULL DEFAULT false`, a default that means "behave as before": a row written by an image that does not know the column — every existing row, and every session the previous image creates after a rollback — reads as custom exactly when it has a status, which is what that image meant by it. A mode column defaulting to "default" would have turned those custom sessions into default ones. The capture path answers by this reading, and the response change takes the same `FOR UPDATE` lock on the row that every capture takes, so a request is composed wholly from one configuration.

`response_template` (migration `018`, D251) says whether the custom response's body is a template, whose placeholders the capture fills in from the request it answers. It is nullable with no default and no backfill, and every reader takes `NULL` as `false` (`COALESCE` in `RESPONSE_COLUMNS`): every existing row, and every session the previous image creates, is no template. It belongs to the custom response as the four columns do: a change to a custom response writes it with them, and picking the default leaves it, so switching back restores the template. A queue's step and a rule's response carry the same as a `"template"` key of their `jsonb` object, which a step or rule without the key reads as `false`. The previous image, which names its columns, never reads the column or the key, and answers a template's text as configured, placeholders and all; its change of the session response leaves the column as it was (migration `018`).

`response_queue` and `response_queue_answered` (migration `010`, D205) hold the session's response queue: a `jsonb` array of 1 to 10 complete responses, each at its effective values, and how many of them have answered a request since the queue was last started; both are `NULL` exactly when there is no queue, which a constraint holds, as it holds the array's length and the count's range. `jsonb` suits a step's body here although it does not suit `response_body`: a body is a string inside the array, and `jsonb` keeps a string's characters exactly — it is object keys it reorders. Each string is written through UTF-8 first, so a lone surrogate is stored as U+FFFD, as the text columns store it. Both columns are nullable with no default, so a session the previous image creates has no queue, and that image, which names its columns, never reads them (D205).

`response_rules` (migration `017`, D246) holds the session's response rules: a `jsonb` array of 1 to 20 objects `{"method", "path", "response"}` in the order they are matched — the method in upper case or `null` for any, the path pattern as typed, the response at its effective values, written as a queue's step is — and `NULL` when there are none, which is how an empty list is saved; a constraint holds the type and the length. It is nullable with no default, so the ALTER rewrites no row and a session the previous image creates has no rules; that image, which names its columns, never reads it, so during a rolling update or after a rollback it answers every request by the queue and the session response, the rules ignored and not lost (D246). One column for the whole list rather than a table of rules: the capture matches it in the statement that locks the row, which a table would turn into a join under `FOR UPDATE`, for a list of at most twenty.

`lifetime_ends_at` (migration `011`, D220) is the fixed end of a lifetime given at creation, `expiresInSeconds`: set by the insert to the same instant as `expires_at`, both `now()` plus that many seconds, and `NULL` for a session created without one, which expires 7 days after its last use as before. It is nullable with no default, so a session the previous image creates has none. `expires_at` stays the one column every expiry check, the cleanup and the statistics read; the lifetime only keeps the refresh from moving it (below).

`idle_seconds` (migration `013`, D242) is the idle window a session slides by, `expiresAfterIdleSeconds` at creation: `INTEGER NOT NULL DEFAULT 604800`, the 7 days every session slid by before, with a constraint holding it to 3600–604800. The constant default makes the column metadata-only on PostgreSQL 16, so the ALTER rewrites no row, and every existing row and every row the previous image inserts, which never names it, reads 604800. A session with a lifetime gets the default and never slides by it; the API reports its window as `null`. The insert sets `expires_at` to `now()` plus the window in seconds; the refresh and the status read take the window from the row.

`store_source_ip` (migration `014`, D243) says whether the session's requests keep their sender's address, `storeSourceIp` at creation: `BOOLEAN NOT NULL DEFAULT true`, what every session did before. The constant default makes the column metadata-only, so every existing row and every row the previous image inserts reads `true`. It is set at creation only. The capture reads it under the session row's lock and writes `NULL` into `requests.source_ip` for a session that keeps none; the trigger `requests_source_ip_choice` on `requests` (`BEFORE INSERT OR UPDATE OF source_ip, session_id`, `WHEN (NEW.source_ip IS NOT NULL)`) does the same for every other writer, the previous image's capture included, so the row never holds an address its session was created not to keep, at one primary-key read of the session row for every insert that carries an address. Nothing is refused, so no capture fails on it. The previous image's record of its default answer is held to the row by `015`'s trigger ([`request_responses`](#request_responses)). The function reads `public.sessions` under a fixed `search_path`, and `EXECUTE` is revoked from `PUBLIC`.

`access_key_hash` (migration `016`, D245) is the SHA-256 fingerprint of the session's access key, 32 bytes, which the constraint `sessions_access_key_hash_size` holds; `NULL` is a public session. Nullable with no default and no backfill, so the ALTER is metadata-only and every existing row reads `NULL`. Set at creation only, by a creation with `"private": true` since 1.11.0 (D253), and never changed, never the key itself; the `stats` views name their columns, so the read-only role never sees it. The previous image never names it: it serves public sessions as before, and would serve a keyed one to anyone holding its id, which is why the check shipped with 1.2.1 before 1.11.0 let anything create one. Since 1.11.0 a recovery never returns an image older than 1.2.1, and never drops the column.

### `requests`
Conceptual fields:
- `id`
- `session_id`
- `method`
- `path`
- `http_version`
- `received_at`
- `query_string`
- `headers`
- `body`
- `body_size`
- `raw_request`
- `source_ip`
- `source_country` — kept in the schema and unused (D140)
- optional additional useful captured metadata

`path`, `http_version` and `source_country` are nullable, have no default and were not backfilled, so a request captured before they existed reads `NULL` on all three (D102, D110, D118). `source_country` is no longer written or read: country resolution was removed (D140). The column stays because the previous image still inserts into it on every capture, so dropping it in the same release would break a rollback of the application; dropping it is a later, separate migration once no deployable image writes it, and like every migration here it has no down-migration (D055).

Required types/representation:
- request id: UUID v4
- headers: `jsonb` containing an ordered array of `[name, value]` pairs so duplicate header names are preserved
- query string: raw `text`
- body: PostgreSQL `BYTEA` containing the raw captured bytes
- body size: PostgreSQL `INTEGER`, measured in bytes
- raw request: PostgreSQL `BYTEA` containing the complete request as composed at capture time: the request line and headers composed in the process, followed by the body, joined by the insert itself (`$head || $body`, D210)
- timestamps: timezone-aware PostgreSQL timestamps

The detail API converts body bytes for transport without changing storage:
- valid UTF-8 -> textual `body`, `bodyBase64: null`, `isBinary: false`;
- invalid UTF-8 -> `body: null`, exact Base64 in `bodyBase64`, `isBinary: true`.

`raw_request` is composed by the webhook receiver when the request is captured, from the request line, HTTP version, ordered raw headers and body bytes. The frontend never reconstructs it. It is transported using the same UTF-8/Base64 rule as the body.

Relationship:
```text
sessions 1 ---- N requests
```

`requests.session_id` references `sessions.id` with `ON DELETE CASCADE`.

The v0.1 statement that no separate request `path` field was required — true while only the exact `/s/<session-id>` route was supported — is **lifted**. The path component is stored, without its query string, because the detail panel shows the URL the sender actually used rather than the route pattern that matched it (D110). Since v0.26.0 that includes any path under the endpoint (D173), which the column held room for without a migration.

The request-list API returns lightweight metadata only unless a client asks for the request's headers and body with `include` (D196), which the frontend does not; the query string, the raw request and the full response record are only on the individual request-details endpoint. That holds on the response side too: a list row carries the recorded response's `state` and `status`, and which queue step or response rule answered it, and nothing else, while the stored headers, body and raw representation are on the details endpoint (D110, D205, D246).

### `realtime_events`
The realtime outbox (migration `012`, D221): one row per event a viewer or a wait hears of, written in the transaction of the change it announces and read by every backend process. Fields: `id`, an identity with the default `CACHE 1`, which orders the events; `tx`, the writing transaction's id (`xid8`), which a reader's floor is taken from; `session_id`; `request_id`, the request whose captured data the payload carries, `NULL` for any other event; `kind`, the event's wire type or `close`; `payload`, the event exactly as it is sent, `NULL` for a `close` and for an event a deletion purged; `created_at`. No foreign key, so a `close` outlives its session. **UNLOGGED**: no WAL, emptied by a crash, which every reader treats as a lost channel. Each backend process deletes, every 5 s, the rows older than 20 s whose transaction is below the floor it read two prunes earlier, and vacuums the table after a prune that deleted 1 MiB of payload or more and after the prune after it; a pg_cron job deletes every minute the rows older than five minutes ([Expiration and cleanup](#expiration-and-cleanup)). So a row lives about 20 to 25 s while a backend runs, and the table's size follows about the last 40 s of what was written. A request deletion, a clear and a session deletion empty the payloads of what they delete, in their own transactions; the 1000-request eviction leaves its request's events to the prune, about 25 s at most. `qa_readonly` cannot read it.

### `request_responses`
One row per captured request, 1:1 with `requests`, holding the response the backend formed and how writing it ended (D109). Conceptual fields: `request_id`, `state`, `status`, `headers`, `body`, `body_size`, `body_suppressed`, `raw_response`, `delay_ms`, `started_at`, `completed_at`, `duration_ms`, `queue_step_index`, `queue_step_total`, `rule_index`, `rule_method`, `rule_path`.

`queue_step_index` and `queue_step_total` (migration `010`, D205) record the step of the session's response queue that answered the request — its position and the queue's length at that moment — and are both `NULL` when the session response answered it, for every request recorded before 0.46.0 and for every request the previous image records.

`rule_index`, `rule_method` and `rule_path` (migration `017`, D246) record the response rule that answered the request — its position, 1-based, its method (`NULL` for any) and its path pattern, as they were when it answered — and are all `NULL` when no rule did, for every request recorded before 1.3.0 and every request the previous image records. Constraints hold the three together and keep a rule and a queue step from answering one request. The list and the events carry the position alone (`response.rule`, `{ "index": 2 }`), the detail all three.

It is a separate table rather than columns on `requests` for a mechanical reason, not a semantic one: `raw_response` is a second large `BYTEA`, and `requests` is the hot table that the list endpoint reads and the newest-1000 eviction scans. `headers` is `jsonb` holding the same ordered `[name, value]` pair array as captured headers, validated by the same function. `body IS NULL` means there was no body at all and a zero-length `body` means an empty one; the two are different answers.

`request_responses.request_id` references `requests.id` with `ON DELETE CASCADE`, which covers all five deletion paths: a single delete, a clear, the newest-1000 eviction, the deletion of a whole session (D198) and the scheduled session cleanup.

Only `pending`, `sent`, `aborted` and `failed` are ever stored, which a `CHECK` enforces. `unknown` is derived when a `pending` row is older than its own `delay_ms` plus a fixed grace, and is never written. A missing row is a fifth reading and means this request predates the release or its record was never written.

The record of a default answer names no address its request does not hold (migration `015`, D243). The trigger `request_responses_source_ip_choice` (`BEFORE INSERT`, `WHEN` the body starts as a default answer and ends with `"}`) stores a record that is this request's default answer and names an address while the request's row holds none — the previous image's, for a session created with `storeSourceIp: false` — as this image records the same answer: `"sourceIp":null`, with `body_size`, the `content-length` pair and `raw_response` following, byte for byte. Since migration `019` (D251 point 16) it first asks which response answered: a record answered by a queue's step or a rule, or written while the request's session answers its custom response, is stored as written whatever it holds — a template can write the default answer's shape, the request's id and a `sourceIp` member taken from its query string — so a custom answer's record is always the bytes sent. A record of any other shape is stored as written, and so is every record of a request whose row holds an address. Nothing is refused or dropped. The function reads `public.requests` and `public.sessions` by primary key under a fixed `search_path`, and `EXECUTE` is revoked from `PUBLIC`.

### The `stats` schema
Two read-only views over the tables above, for inspecting usage without webhook content (migration `007`, D170), two tables of daily counters that outlive the sessions they count (migration `008`, D178), and a table of the sessions deleted through the API each day (migration `009`, D198). The application writes the last one, when it deletes a session, and neither reads nor writes any of the others.

- `stats.sessions`: `session_key`, `created_at`, `expires_at`.
- `stats.requests`: `session_key`, `received_at`, `method`, `body_size`, `content_type`, `user_agent`, `sender_net`.

`session_key` is the first 12 hex characters of `sha256(sessions.id)` (from `requests.session_id` in the second view): it groups a session's requests without being the access key (D004). `content_type` and `user_agent` are the first stored header of that name, matched case-insensitively because headers keep the sender's spelling (D045), truncated to 200 characters; `NULL` when absent. `sender_net` is `requests.source_ip` reduced to its /24 (IPv4) or /48 (IPv6) network as `cidr`, and `NULL` when the address is missing or does not parse. Nothing else is exposed: not the body, raw request, path, query string, other headers or response snapshot, not the full session id and not the full sender address.

**Daily counters.** A session and its requests are deleted 7 days after its last use (D133), so the views show a week at most. `stats.usage_daily` keeps one row per UTC day indefinitely; every count is `NOT NULL`, and zero when nothing happened:

- `day` — the UTC day, the primary key.
- `sessions_created` — sessions created that day.
- `sessions_created_with_requests` — of those, sessions that captured at least one request the same day.
- `sessions_with_requests` — distinct sessions that captured at least one request that day.
- `sessions_returning` — of those, sessions created before that day.
- `requests_captured` — requests captured that day.
- `sender_nets` — distinct sender networks that day, as `sender_net` reduces them; a missing or unreadable address is not counted.
- `body_bytes_total` (`bigint`), `body_bytes_max` — the sum and the largest of that day's `body_size`, 0 when there were none.
- `sessions_custom_response` — sessions with requests that day whose custom response is active when the day is recorded: `response_status IS NOT NULL AND NOT response_custom_disabled` (D151).
- `requests_with_subpath` — requests that day whose stored `path` continues past `/s/<id>` with more than a lone `/` (D173); a `NULL` path, captured before D110, is not counted.
- `sessions_at_request_limit` — sessions with requests that day that hold 1000 requests (D006) when the day is recorded.
- `database_bytes` — `pg_database_size()` when the day is recorded on the day after it; `NULL` for a day recorded later (the deployment's backfill, a missed night), since it would be a later day's size.
- `recorded_at` — when the row was written.

`stats.usage_daily_top` keeps each day's 20 most frequent values of four dimensions: `day`, `dimension`, `value`, `requests`, and `sessions`, the distinct sessions among those requests, counted by `session_key`; the primary key is (`day`, `dimension`, `value`). `dimension` is checked to be `user_agent` — as the view gives it, `<none>` when absent; `content_type` — the view's value cut to its media type (parameters after `;` dropped), trimmed and lower-cased, `<none>` when absent; `method` — as stored; or `sender_net` — the network as text, such as `203.0.113.0/24` or `2001:db8:1::/48`, `<unknown>` for a missing or unreadable address. Values are ranked by requests, then by value in byte order (`COLLATE "C"`), so the cut at 20 is the same under any database collation. Its `sender_net` rows are kept 90 UTC days, and the rows of the other three dimensions indefinitely (D254). Neither table holds a session id or a hash of one, a full sender address, a body, path or query string.

**The snapshot job.** `public.record_usage_days()` records every UTC day that has no `usage_daily` row, from its start to yesterday, oldest first, and returns how many it recorded. The start is the day after the latest recorded day; with nothing recorded, the earliest UTC day in `sessions.created_at` or `requests.received_at`; with no data at all, yesterday. A day with no activity is a zero row, and a recorded day is never rewritten. Day boundaries are computed with `AT TIME ZONE 'UTC'`, never from the connection's `TimeZone`. The dimension values and `sender_nets` are read through `stats.requests`, so the header and network rules live in the view alone; what the view does not expose — the session, its response mode, its request count, the path — comes from the tables. One statement writes a run's rows, so a day's columns come from one snapshot. A `SHARE ROW EXCLUSIVE` lock on `usage_daily` serialises runs, and the insert skips a day that already has a row, so two overlapping runs change nothing and do not fail under the default `READ COMMITTED`. The function sits in schema `public`, on which `qa_readonly` has no `USAGE`, with `EXECUTE` revoked from `PUBLIC`. The pg_cron job `webhook-inspector-record-usage-days` runs `SELECT public.record_usage_days()` on the schedule `5 0 * * *`, read in `cron.timezone`, which is GMT by default and set by neither the chart nor `docker-compose.yml`: at 00:05 UTC, 03:05 in Moscow, when the 00:00 UTC backup (D176) may still be running; its dump reads one consistent snapshot, so the two do not interfere. The migration calls the function once at its end, so the days still in the database were recorded at deployment.

**Sender networks, 90 days** (migration `020`, D254). The pg_cron job `webhook-inspector-delete-old-sender-nets` runs `DELETE FROM stats.usage_daily_top WHERE dimension = 'sender_net' AND day < (now() AT TIME ZONE 'UTC')::date - 90` on the schedule `10 0 * * *`, at 00:10 UTC, five minutes after the snapshot job: on UTC day T the days T−90 to T−1 keep their networks, `<unknown>` among them, and T−91 and older lose them, a day recorded late included, the same night. Nothing else is removed: the totals of `usage_daily` and `deletions_daily` and the top table's other dimensions stay, and `usage_daily.sender_nets` is a count, not a network. A removed row is never written again, since the function records only a day with no `usage_daily` row. The statement is the job's command, with no function; a second run finds nothing, and an overlapping run waits for the rows the first deletes and then skips them. `qa_readonly` can neither run it nor change the job: it holds `SELECT` alone and no `USAGE` on schema `cron`. The migration runs the statement once at its end. The 00:00 UTC backup runs first, so a nightly dump holds what that night removes, up to 3 days longer (D176).

**Deletions, counted at write time** (D198). A session deleted through the API is gone before its day is recorded, so a session created and deleted within one UTC day never appears in `usage_daily`. `stats.deletions_daily` counts the deletions themselves: `day` — the UTC day of the deletion, the primary key; `sessions_deleted` — sessions deleted through the API that day; `requests_held` — the requests they held when they were deleted. Both counts are `bigint`, checked not to be negative. The deletion adds to the day's row with an upsert in its own transaction (`COUNT_SESSION_DELETION_SQL` in `modules/sessions/repository.ts`), with the day taken from `clock_timestamp()` at UTC, so the count and the deletion commit or roll back together, and concurrent deletions on one day are counted one after the other at that row. Nothing on the capture path writes it. Sessions removed by the expiry cleanup are not counted here. The table holds aggregates only, like the two above.

**What a snapshot misses, accepted.** A day is counted from what the tables hold when it is recorded. A request deleted, cleared or evicted by the per-session limit before then is not counted, nor is anything that expired before a late recording, so the days the migration backfilled are incomplete, as their `recorded_at` shows. `sessions_custom_response` and `sessions_at_request_limit` are read when the day is recorded, not as they were during it. The owner's own traffic, deployment-smoke probes included, counts like anyone else's; `sender_net` and `user_agent` in the top table separate it. The numbers are a usage signal, not billing. Counting at write time was rejected: exact, but it would put a hot row lock and a new failure mode into the capture path (D178).

Role `qa_readonly` holds `USAGE` on `stats` and `SELECT` on the two views and the three tables, nothing else: it is `NOLOGIN` without a password in every environment, with `default_transaction_read_only = on`, `statement_timeout = '5s'` and `CONNECTION LIMIT 2`, and migration `007` withdraws what `PUBLIC` holds on schema `public` (`USAGE`) and on the database (`TEMPORARY`). Only production gives it `LOGIN` and a password, by hand, an operator's step whose runbook is kept outside this repository; a read-only Postgres MCP server, `qa-db`, connects as it through the cluster tunnel. The views pin the columns they read, so a migration that drops or retypes one of them recreates the view.

### Webhook capture
The receiver is registered as a separate plugin so its body handling cannot affect the `/api` routes. Inside that scope the JSON parser is removed and every content type is read as raw bytes: Fastify would otherwise answer `400` to a malformed payload, which is exactly the payload the inspector exists to show (D007). A `Content-Type` that is not a media type, which Fastify would refuse before choosing any parser, is replaced with `application/octet-stream` on Fastify's parsed view by the scope's `onRequest` hook, so that body is read as bytes too; nothing stored comes from that view, so the capture keeps the header as sent (D138).

Headers come from the raw header list rather than Fastify's normalised object, preserving the order, case and duplicates of the request as received (D045). Since 0.36.0 the request received is the one the sender wrote: the receive host reaches the receive listener through a Traefik TCP route, which ends TLS and passes the bytes on unchanged, so names keep the sender's case and order and nothing is added (D187). The path and the query string are taken from the URL as received (`request.originalUrl`), dot segments, doubled slashes and escapes included. Before 0.36.0 captures came through Traefik's HTTP layer, which rewrote names into Go's canonical case and its own order, added `Accept-Encoding: gzip` and normalised paths (D091, D173); those requests keep what was stored. Body size is the number of bytes actually received.

The receiver has three routes, `/s/:sessionId`, `/s/:sessionId/` and `/s/:sessionId/*`, one endpoint (D063, D173): the segment after `/s/` names the session and the rest of the path is stored, never read. The routes are registered on the receive listener after `createApp` declares the methods of D139, so each takes all 34. Fastify's router decodes a path before matching it and refuses one it cannot decode; for a path under `/s/` alone, the server's `rewriteUrl` gives the router every `%` escaped once more, so such a request still reaches the receiver, which stores the URL as received.

Every header is stored as it arrived: there is no proxy header to leave out, so D144's filter is gone, and a sender's own `X-Forwarded-*`, `X-Real-Ip` and `Forwarded` are stored as the sender's. The raw request is composed from the same pairs, so `Headers` and `Raw` cannot disagree. Only its head - request line, headers, blank line - is composed in the process; the insert appends the body, `$head || $body`, so no second full copy of a body is built while the capture waits for a connection of the pool, and the stored bytes are the same (D210).

**The capture budget** (`modules/webhook/capture-budget.ts`, D210). Webhooks are admitted by bytes: 64 MiB for the process and 16 MiB for one sender address, the address keyed as the API's limits key one (D201). A webhook's weight is read from its headers in the plugin's `onRequest` hook, before the body: its `Content-Length`, at most 1 MiB, or 1 MiB when it is chunked or its framing is unclear, plus 16 KiB, 256 bytes a header line and 64 KiB for the answer (`CAPTURE_ANSWER_RESERVE_BYTES`, the most a session's response or queue step can carry), reserved before the session is read; a body declared over 1 MiB weighs nothing, Fastify refusing it `413` unread. A `GET`, `HEAD` or `TRACE` (`METHODS_WITHOUT_BODY`), whose body Fastify never reads nor refuses, weighs the body it declares all the same, at most 1 MiB, 1 MiB when it declares over that: Node reads such a body into the request's stream, up to 128 KiB measured, and keeps it there unread until the reply has closed. One that does not fit waits in a line, first come first served: among those waiting, the earliest whose address has room goes in first, and while it does not fit the process's budget nobody behind it does; an address that is full keeps no other out. **A light sender keeps a reserve** (`lightWithRoom`, `inFlightBound`, D261): a webhook whose address holds, with it, at most 12 MiB (`CAPTURE_LIGHT_SENDER_BYTES`) goes in whenever the total stays within the process's budget and 16 MiB more (`CAPTURE_LIGHT_RESERVE_BYTES`), 80 MiB, and before that first come first served runs — among the addresses' first webhooks waiting, the earliest light one that fits goes in, and a heavier one ahead of it that does not fit keeps it out no longer; every other webhook keeps the rule above, under 64 MiB. Whether a webhook is light is read each time it is weighed, from what its address holds then, so one that becomes heavier while it waits — its address's handler taking a weight again — waits for the 64 MiB, and one whose address's other webhooks are answered meanwhile goes in past it. So no admission takes the process past 80 MiB, nor the addresses holding more than 12 MiB together past 64 MiB, and a webhook admitted past the 64 MiB leaves its address holding at most 12 MiB, so one address takes at most 12 MiB of the reserve, however many connections it sends on. Four addresses at their 16 MiB each hold the whole 64 MiB; before the reserve an ordinary sender's webhooks waited behind such a flood and were refused `1018` (#242), and under it at 0.5 CPU an ordinary sender of 10 small webhooks a second had up to 10.4 MiB of them in flight, which set the 12 MiB. The reserve is one pool shared by every light sender, not 16 MiB for each, and was measured with one light sender (D261 points 4 and 5). A flood from more than four addresses can fill the reserve too, each flooding address taking at most 12 MiB of it while it holds no more, after which light senders wait as before (D228 point 5's attacks from more than N addresses). `take`, which holds again what was admitted once, is the one way past 80 MiB, as it was past 64 MiB. While it waits its socket is not read past the chunk that carried its headers: the hook stops it, because Node would otherwise read up to two chunks of the body, and the kernel grows the receive buffer of a connection read that fast until it holds most of a 1 MiB body, charged to the backend's memory (500 waiting senders took 374 MiB that way). The stop belongs to the connection: the webhooks pipelined on it are counted while they wait, and the hook starts it again, a turn later, only once the last of them is admitted, refused or gone, and only if it stopped it itself, since Node restarts a socket only when a body is read or a message ends; a socket Node stopped stays Node's. Meanwhile the hook holds the connection against the pipelining bound below (`holdStopped`, D229), which would otherwise start a connection it stopped at its count as soon as an earlier request on it is answered, with a webhook still waiting; the bound starts it once the hook lets go. The weight is held by the connection until the reply closes and by the handler until it settles, as D205 holds a large body's place; a handler whose connection went before it began takes the weight again at once and still stores. A reply closes once its answer is written or once Node sees its connection close, which closes the answers of pipelined requests still queued behind an unfinished one too (`abortOutgoing`, Node 24); while a webhook of the connection waits the connection is not read, so Node sees that close only when it next reads or writes there, and not always then — when a delayed answer before the webhook is written, or the webhook's refusal — each within 30 s (D210 points 6 and 7). Once stored it shrinks to 16 KiB, the header part, the answer's body and, for a `GET`, `HEAD` or `TRACE` that declared a body, that body's part (`unreadBodyWeight`), which is never more than the weight admitted; a hold only shrinks (`CaptureHold.shrink`), so it never grows past what the budgets let in. A sender gone while waiting is dropped with a line at `info` only when Node sees its connection end, which with the socket not read it generally does not, and under the PROXY protocol, as production runs, did in no measured case — nor since 0.57.4 without it, every receive connection being read alike (D229): a webhook that had arrived whole is then stored when its place comes (D187) or refused when its wait runs out, and one whose body was still arriving is seen gone once reading starts again. After 30 s of waiting the webhook is refused `503` / `1018 CAPTURES_BUSY` with `Retry-After: 1`, its body drained first on a closing connection (D143), and logged at `warn` — or at `info`, as a sender that left, when the drain finds its connection gone, which is also how a sender cut by Node's 90 s request bound during the drain is logged. A chunked body, or one on a kept-alive connection, is not drained, so a sender gone there is logged at `warn` with the refusals. The wait counts toward that 90 s bound. The line and the counts live in the process: there is one outside a rollout, and two for its seconds, when an address may have up to twice its share in flight (D074, D221).

**The waiting line is bounded** (`waitingWeight`, D228): a waiting webhook weighs its header part — 16 KiB and 256 bytes a header line, D210's own weight of what it keeps besides its body and its answer — and at most 16 MiB may wait from one address (`CAPTURE_WAITING_PER_ADDRESS_BYTES`) and 64 MiB in the process (`CAPTURE_WAITING_BYTES`). The weight joins the line with the waiter and goes back when it is admitted, leaves or runs out of time. A webhook that must wait while another of its address is already waiting, and does not fit, is refused `503` / `1018` at once rather than after 30 s, `Retry-After: 1` and `Connection: close`, its body drained the same way, however small. The first of an address to wait always waits, so the largest webhook a sender may send (16,320 header lines, 4 MiB of the line) is never refused for its own size; an address's line is held to 16 MiB, and the process's to 64 MiB plus, for each address with exactly one webhook waiting, that webhook, up to 4 MiB — soft by design. One address alone fills its 16 MiB only past 512 webhooks waiting at once with up to 64 header lines each, the most its 512 connections (D227) carry unpipelined; with 100 header lines 399 fit and the next is refused at once, as measured (D228 point 2). So an ordinary burst meets the line only while floods from other addresses fill the process's 64 MiB and the light senders' reserve does not take it in (D261), when any webhook that must wait behind another of its own address is refused at once. Before it, nothing bounded the line, and header-heavy bursts from one address ran the process out of heap (D210 point 12). Pipelined bursts are bounded by what a connection may have read and not yet answered, below, not by the line. Refused webhook bodies are drained a few at a time, not all at once: the receive host's `1018` refusals and the application listener's `/s/…` `410` share at most `MAX_CONCURRENT_REFUSAL_DRAINS`, 8, drains in the process (`refusalDrainPlaces`, `lib/slots.ts`), since a drain reads a socket whose receive buffer the kernel grows, charged to the backend; with none free a refusal is answered at once and its connection ends (`refused-body.ts`'s `drainRefusedBody`, D228). `/s/…` on the application listener holds no place among an address's calls in flight, so these 8 places are what bounds its drains. The listener's other refusals before the body (`1015`, `1017`, the media-type `415`, `/mcp`'s) drain while their call holds one of its address's 128 places of calls in flight (D213), and are not counted against these 8. The waiting line's bound, the drains and the measured number of attacking addresses the backend survives are D228.

**Pipelined requests** (`modules/webhook/pipelining.ts`, D229). A connection to the receive listener has at most `MAX_PIPELINED_REQUESTS`, 32, requests read and not yet answered. Node's HTTP server parses whatever one read delivers in one go — about 736 minimal `GET`s in a 64 KiB read — and each became a request and its response, kept behind the connection's first answer, which a delayed session holds for up to 30 s: about 6.6 KiB a request, and 256 such connections from one address ran the process out of heap (D228's S4). So `boundPipelinedRequests`, put in front of Node's `connection` listener in `buildReceiver` before the PROXY layer, takes Node's own `data` listener off each connection, which makes Node's parser read through JavaScript rather than natively, and calls it with slices of each read, only while fewer than 32 of the connection's requests are unanswered. Every request head Node's parser counts ends in `LF CR LF` (`HEAD_END`), so a slice is cut one byte short of the head that would be one too many (`sliceLength`): a long header block or a body is parsed in one slice as before, and a run of tiny requests in slices of the ones still free. Where `LF CR LF` comes close together — a body of empty CRLF lines has one every two bytes — the slices would be a few bytes each, every one a call into the parser and a piece of the body Node keeps apart: round 1 of #181 measured 1.4 million unread pieces and 280 MiB of heap for 32 connections each pipelining 30 delayed `GET`s and a 1 MiB body of `LF CR LF`. So a slice cut shorter than `MIN_SLICE_BYTES`, 128, is not parsed while more than one of the connection's requests is unanswered (`nextSlice`): the connection waits for an answer, which comes without reading on, since only the newest unanswered request can still be arriving, and with one unanswered a cut slice is 62 bytes or more. And the pieces of a body Node's parser gives a request while one read is parsed are pushed into its stream as one, once the read is parsed or the body ends — the request's `push`, through which Node delivers a body, is wrapped for it — so an unread body keeps one piece a read, as Node kept it. The limit is at least 2, since a connection whose only unanswered request is still arriving must be read on. Requests are counted on Node's own `http.server.request.start` and `http.server.response.finish` channels, which also see the requests Node answers itself, and a request counts until its whole answer has been handed to the socket, so a client that reads no answers holds at most 32 too. What a sender pipelines past them stays unread — the rest of one read in the socket, whose read-ahead is set to nothing, and the kernel's and the sender's buffers behind it — and is read as earlier ones are answered; nothing is refused, and answers keep their order. The bound stops the connection with `pause()` and starts it again only while the stop is still its own — a `pause` it did not make comes only once the connection has been started since, and makes the stop its maker's — and nothing holds it, the capture budget's hook above holding it while a webhook waits; Node's own `pause` and `resume` listeners, which stop and start the socket's reads at once, are put back. A read is parsed whole, as Node parses it, unless the bound or Node's own stop for unwritten answers stops it; any other stop, a body nobody reads yet or the capture budget's guard, takes effect from the next read. Every receive connection is therefore read as the first read behind a PROXY header always was: a request's handling runs once the read that carried it has been parsed, not between its head and its body. Should a later Node set its listener up otherwise, connections are read as Node sets them up, unbounded, and one line is logged at `error`.

**Header lines in flight** (`modules/webhook/header-lines.ts`, D238). The receive listener keeps every header line (`maxHeadersCount = 0`, D187), and Node's parser keeps every line of a head still arriving, about 24 bytes a line at the least, until the head ends or the connection closes: 512 connections from one address each stalled after 16,000 lines of `a:` held 182 to 197 MiB, and two addresses ran the process out of memory (D227, D228's S9). So the slicing layer above also counts the lines it gives Node's parser, per sender address and per process (`createHeaderLineBudget`): `MAX_HEADER_LINES_IN_FLIGHT_PER_ADDRESS`, 32,768, and `MAX_HEADER_LINES_IN_FLIGHT`, 524,288 (`packages/shared`), the address the PROXY layer has read by the time it hands the connection over — `buildReceiver` passes `boundPipelinedRequests` a function that reads it late, since the bound is put in place before the layer — keyed by `addressKey`, an IPv6 address by its `/64` and an IPv4-mapped one as its IPv4; without PROXY protocol, the socket peer. A connection that dies before or during its PROXY header never reaches the bound and opens no account. `scanLines` follows a connection's bytes through the framing of its requests: CR and LF before a request line, which Node's parser skips, are passed over; in a head, and in a chunked body's trailer section, every line counts from its first byte — the request line too — and the CR LF of the empty line that ends the section is free; a slice ends at the end of a head, since what follows depends on what Node made of it, at the end of a message, and before the first line the budget has no room for. After a head, the body's framing is taken from the request Node's parser has just made of it (`framingAfterHead`): none once `complete`, chunked for any `Transfer-Encoding`, which Node takes from a request only when chunked comes last, else its one `Content-Length`. A body of declared length is skipped by its length; a chunked body by its chunk sizes, extensions, data and CR LF; neither counts a line, so a body of newlines costs nothing. Trailer lines count because Node keeps them as it keeps header lines, up to the same 16 KiB. A head's or a trailer section's lines are given back when it ends, and all a connection holds when it closes, however it closes — `close` — or when Node hands it on, an upgrade or a `CONNECT`. Each slice is checked against what Node's parser did: a request begins only where a head ends, one at the most, and is complete exactly where its message ends; should they ever disagree, the connection's lines are given back, it is read as before #182, uncounted, and one line is logged at `error`. A head that ends with no request made of it is not a disagreement but a sender's doing: Node's parser holds the HTTP/2 preface's `PRI` line, which a sender with prior knowledge opens with, while it waits for the rest of the preface, and then refuses the connection with `400` whatever follows. Its lines are given back as any head's, nothing is logged, and the connection is read uncounted from there on, as before #182, so that what follows reaches Node's parser at once and gets the same answer whatever room the sender's address has: counted, it would wait for room once the address's lines were all in flight, and be answered `408` at `headersTimeout` instead. Nothing can hold lines there, since Node's parser refuses whatever follows such a head, a request included (#277, D238's amendment). A connection whose next line does not fit waits, the rest of its read put back in front of the stopped socket as the pipelining bound does — what it keeps unread, the rest of that read, at most 64 KiB, and the kernel's receive buffer behind it, 16 KiB since the pod's `net.ipv4.tcp_rmem` of 1.14.1 rather than Linux's 128 KiB ([Infrastructure](#infrastructure)), about 32 KiB of socket memory as measured, is the sender's to size, about 50 to 85 KiB a held connection as measured, 160 to 220 KiB before (D238 points 7 and 9 and their amendment, #242): nothing is answered, closed or refused for it, and Node's own timeouts run as before — `headersTimeout`, 60 s, for one whose head has begun or that has read nothing yet, answered `408`; the keep-alive timeout, 72 s, for a kept-alive connection held before its next request's first line, which Node then closes. Who is never held: by the address's number, the address's oldest holder of lines and a connection of an address holding none; by the process's, the process's oldest holder and a connection while none holds any — so a webhook with the most lines Node allows, 16,320, is never held by its own size, and the oldest holder can always end its head, the next then being the oldest. A connection of an address holding none still waits for the process's room. The waiting are woken in the order they first waited — a connection that took some lines and waits again goes to the back — as many as the room freed is enough for by an estimate of what each has waiting, a line in 4 bytes; a woken connection goes on before any other connection's next read, Node running what is due on the next turn first, and once those woken have, the room is looked at again, so that room one of them did not use — held by the pipelining bound or the capture budget's hook, or wanting less — wakes the next. A held connection whose sender leaves is seen to go once it is read again or a timeout of Node's ends it, as for the other stops. The count is the process's: one outside a rollout, two for its seconds (D221).

**PROXY protocol v2 on the receive listener** (`modules/webhook/proxy-protocol.ts`, D187). In production every connection from Traefik's TCP route opens with a PROXY v2 header carrying the sender's address. Node's own `connection` listener is taken off the receive server before it listens; for each connection the socket peer is checked against the trust boundary before a byte is read, the header must then arrive within 5 s, its source is remembered for the socket, the bytes after it are put back in front of the stream, and Node's listener takes the socket with all its own limits and timeouts. A header the server has already received when the deadline passes on a busy event loop is still read, one turn later (#299): a turn of the loop runs its timers before it reads the sockets that are ready, so the deadline's timer refuses nothing itself but checks once more, after that turn's sockets have been read, and refuses only a connection still waiting for its header, with the same log line and reason. Version 2 with the `PROXY` command over TCP/IPv4 or IPv6 is accepted, TLVs skipped, the header capped at 1 KiB; `LOCAL`, version 1, any other family and a peer outside the boundary are refused by destroying the socket with nothing written. A refused header is logged once a connection; the refusals of a peer outside the boundary are logged as a count, as D227's refusals over a sender's bound are and apart from them: the first at once, then at most one line a minute, `Receive connections refused: peer outside the trust boundary` with `refused` and the latest refused `peer`, absent when the connection was reset before Node read its address (#241). The socket's own `remoteAddress` is left alone, so the log still names the Traefik pod (D117). Locally and in the tests the layer is off and the socket peer is the sender.

**HTTP/2, behind `RECEIVE_HTTP2`** (`modules/webhook/http2-preface.ts`, `modules/webhook/http2-server.ts`, `installHttp2` in `server.ts`, D263). Off by default and on production until #115; off, none of this is built. On, a receive connection passes three layers in order: the PROXY layer (with PROXY on), the preface layer, then the pipelining bound and Node's HTTP/1.1 parser. The preface layer compares a connection's first bytes with the 24-byte HTTP/2 preface and decides at the first byte that disagrees: the whole preface hands the socket, preface put back, to a second Fastify instance on Node's h2c server (`emit('connection')`), which serves the same receive routes with the same capture budget, completion writes and drain; a disagreeing byte hands it on to the HTTP/1.1 path with every byte unchanged. At its 10 s deadline a connection that has sent nothing, `P` or `PR` goes to HTTP/1.1 as well, and one further into the preface is destroyed with nothing written; one half-closed before the decision is destroyed at once. HTTP/2 requests are told apart by their object (`lib/http2.ts`), never by `httpVersion`. The HTTP/2 server allows 32 streams a connection (D229's bound), a header list of 4,100 fields — 4,096 lines and the four pseudo-header fields, fewer than HTTP/1.1's 16 KiB allows, since Node holds the fields of a header block a sender leaves open until the connection closes (D266) — and 148,608 bytes, the size measured by the server itself as each stream is emitted, before Node's compatibility layer builds a request of it, since Node holds a list to its announced size only once the client has acknowledged it — within which a `:path` or `:authority` of at most 16 KiB (`HTTP2_MAX_PSEUDO_HEADER_BYTES`, D266), so neither reaches the default answer, the stored row, the list rows, a `request.received` event or the log line, all sized for HTTP/1.1's 16 KiB head — though the log line's `host`, which Fastify takes from a regular `host` field before `:authority`, is held by the list's 148,608 bytes alone; a list or a pseudo-header over its bound is refused `RST_STREAM(ENHANCE_YOUR_CALM)` where HTTP/1.1 answers `431`, the connection going on; 10 MB of session memory, 90 s for a request to arrive, past which nothing of it is stored, and 72 s of idle connection; a sender's stream resets past 64 at once, and 33 a second after them, end its connection with a GOAWAY; and with PROXY protocol on, one sender address has at most 32 HTTP/2 connections among D227's 512, the preface layer's hand-over counting them, the 33rd reset and destroyed with nothing written and a warn line counting the refusals without the address (D266) — bounds not yet measured, which #298 measures before #115 switches the path on; a `:method` no route has is answered `404` / `1000` before Fastify; a request's sender address is read once a connection and kept per session; an HTTP/2 capture stores `2.0`, its fields without pseudo-headers, and `raw` as its header list, pseudo-headers first. Its answers carry no `Connection`, end a stream still being sent with `RST_STREAM(NO_ERROR)` after their own `END_STREAM`, and drop or trim the configured fields HTTP/2 refuses, the record holding what was sent. A request is stored only once its sender's `END_STREAM` has come — one reset before it stores nothing, its `Content-Length` met or not; a `GET`, `HEAD` or `TRACE` excepted, stored on its headers — and an answer is `sent` only once written whole; a reset, a GOAWAY with an error or the connection's FIN records `aborted`; SIGUSR2 sends each session a GOAWAY and SIGTERM closes every session before the listener's close resolves.

**The old address.** On the application listener an encapsulated plugin answers every `/s/*` URL `410` / `1009 RECEIVE_URL_MOVED` from `onRequest`, before body parsing, naming the session's receive URL, and stores nothing (D187). The session answers carry `receiveUrl`, composed from `RECEIVE_ORIGIN` in the session routes (`modules/webhook/receive-url.ts`).

The 1 MB limit is enforced by Fastify before the handler runs, so an oversized request is never stored (D008, D046).

The reply is composed from the session's response configuration, which is read by the same locking statement that begins the capture transaction, so no second round trip and no second race are added. That statement also matches the request against the session's response rules, in a scalar subquery over `response_rules` of the locked row, and returns only the first rule it matches with its position, never the others (D246): a rule matches when its method is `null` or the request's own, and its path is the request's path under `/s/<session-id>` — what follows the id segment as stored, `/` when nothing does — or, ending in `*`, a prefix of it, compared with `=` and `starts_with` byte for byte, so no character of a pattern is a wildcard but that last `*`. A matched request is answered with its rule's response, records the rule on the `pending` record and takes no step of the queue. The statement also reads the session's response queue's next step, `response_queue -> response_queue_answered`, and only that step, never the whole queue; while one is left a request no rule matched is answered with it, its step is recorded on the `pending` record, and the count is moved by one in the same transaction, under the same lock, so each request takes exactly one step and requests that arrive together take them in receipt order (D205). Otherwise a default session answers the standard body; a custom one answers its configured status, headers and body, with the body returned byte for byte under its configured `Content-Type`, or `application/json; charset=utf-8` when none is configured (D179). A response marked a template — the session response, a step or a rule's — has its body filled in instead, by `@webhook-inspector/shared/response-template`, in `composeWebhookResponse`, inside the capture transaction (D251): the id, method and path from the stored row (`RequestFacts`, D223), the query string, the headers and the body from the captured request (`CarriedRequest`), each value escaped for the answer's effective `Content-Type`, the whole at most 65,536 bytes, a value that does not fit rendering empty. Reading a template is one pass over it; each distinct placeholder is resolved and escaped once, one longer than the room left never escaped; and the request's body is decoded as UTF-8 and parsed as JSON once, only when a placeholder of it is reached with room left. Measured on the developer's Mac (D251 point 7), a 1 MiB body of 349,524 `{}` is decoded, parsed and read in 11.1 ms at the median and 23.7 ms at most of 15 runs, and eight such captures at once on one session take about 15 ms more each, under the row lock, answering a template that reads the body than answering a plain one. Nothing in it can throw out of the capture: a value that cannot be read renders empty, and a body that does not read as a template, or any failure, is sent as configured. `Content-Length`, a `HEAD`'s included, and the record are the filled-in body's. A body not marked never reaches that code. Every response the receive listener sends, and the application listener's `410` for a `/s/...` URL, carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`, including the rejections, which is why those headers are set by a hook on each root instance rather than inside the receiver plugin; a request Node's parser refuses is answered by Fastify straight to the socket and gets no hook and neither header (D142). A response with no body carries no `Content-Length` and no `Content-Type` unless one is configured, which the receiver writes itself, because Fastify would otherwise stamp a `Content-Length: 0` on it.

The order is compose, persist with its announcement, wait, reply, record (D105, D109, D221). The answer is composed before the delay, so a sender that disconnects mid-delay still leaves a record of real content; composing touches no connection and flushes no head, and `reply.hijack()` stays at write time. The `pending` record is inserted inside the capture transaction, so the invariant "no row means this request predates the release" survives a crash between the capture and the reply.

The delay is taken after the transaction has committed, never inside it: sleeping while holding the session's row lock and a pooled connection would exhaust the pool. During it the handler keeps only the request id, the delay and the answer it will write: the request's body is taken off the request once it is stored, and the response configuration and the composed raw answer stay in the function that stored them (D210). Two consequences are worth stating. The viewer sees the request while the sender is still waiting, which is correct even though it looks like a fault from the sender's side. And a sender that disconnects during the delay leaves the request stored, its wait cancelled, nothing written to the dead socket, and its response record marked `aborted` — how writing ended, never whether anything was delivered. Rejections are never delayed, and they store no response record at all, because nothing was stored for one to hang on. A deployment does not cut such a reply short since 0.53.1 (D221): the stopping process answers in full a webhook whose delayed reply is under way when it is told to stop, and records its outcome — the `preStop` pause of 10 s and a delay of up to 30 s fit within the 60 s grace period, and the shutdown waits for the reply and then for its completion write (`lifecycle.ts`). Before 0.53.1 a deployment inside a 30-second delay window dropped the in-flight reply, the request already stored and already delivered to the viewer, and left a `pending` record that nothing would complete, which is exactly what reads as `unknown`; such a record now takes a process that ends without its shutdown — killed at the end of its grace period, out of memory, or by a crash. Since 0.54.1 the backend rolls (D088 as amended, D221 point 17), so a deployment refuses no connection; before it, the `Recreate` gap refused new connections, about 10 s longer in 0.53.1 and 0.54.0 for the pause.

The terminal write is one statement on its own pooled connection, committing on its own, after the reply, and never inside the capture transaction: that transaction holds the session row `FOR UPDATE`, and a delayed response finishing inside it would serialise every other capture on that session behind it. It **updates and never inserts**, guarded by `WHERE request_id = $1 AND state = 'pending'` — the state, not only the row, because the teardown `close` listener fires on a normally completed response too. A request deleted while its response was still pending therefore stays deleted. `response.recorded` is written by the same statement, a `WITH` whose insert reads the update's row, so only when that update changed exactly one row (D221, #260); its payload is built from what the capture recorded — the status, the queue's step and the rule — beside how the response ended, which is the summary the row gives, byte for byte the event an earlier image writes from the row. The readers are woken only when it wrote one, and a shutdown waits for the write. A deletion of the request or its session that runs meanwhile waits for the row the statement holds and purges its event after it; one that deleted the row first leaves it nothing to update and nothing to announce. Recording is fire-and-forget: the response is written first and recorded second, and a failure to record is logged and never changes the reply or its status.

Validating the session, inserting the request and evicting anything beyond the newest 1000 all happen in one transaction that begins by locking the session row (D065). The lock is what makes the limit hold when requests arrive together, and what keeps expiration authoritative at the moment of writing rather than at an earlier check.

The capture's transaction is eight statements since 1.15.10 (#260): `BEGIN`; the lock, which reads the response settings, the queue's next step and the matched rule; the expiry read once the lock is held, which also reads whether the expiry is due to move, by the refresh statement's own conditions (`CAPTURE_EXPIRY_SQL`, `REFRESH_DUE_SQL`); the request's insert; the eviction; the response record's insert; the event's append; `COMMIT`. A step of the queue adds its `UPDATE`, and a refresh that is due — at most once an hour a session, more often for a short idle window (D242) — its `SAVEPOINT`, `UPDATE` and `RELEASE`: eleven with a refresh, twelve with both. Whether it is due is read after the lock, not in the locking statement, whose select list PostgreSQL may compute before it waits for the lock and computes again only for a row changed meanwhile, so a session that falls due while its capture waits is refreshed by it. The refresh judges its conditions again and decides what is written. With the completion's one statement and the listener's read and wake-up shared by every commit of a window — a capture's and its completion's usually among them — a webhook on an idle server sends about eleven statements where it sent nineteen, and fewer under load (inference; `realtime/transaction-writers.test.ts` counts the capture's and the completion's, `realtime/listener.test.ts` the reads and wake-ups of a window).

Expiration is compared against `clock_timestamp()` rather than `now()`, which PostgreSQL fixes at the start of a transaction and which would therefore ignore time spent waiting for the lock. The receipt time is read the same way: the insert writes `received_at = clock_timestamp()` once the lock is held, so within a session receipt order is the order in which captures took the lock and committed, and a request committed after a list was answered is received after everything that list could hold (D196).

The session-scoped read and delete routes carry the same property without locking: each one answers the session's state and performs its operation in a single statement, so no window exists in which the session could expire between the check and the act (D068). Two deletions are the exceptions. Deleting a whole session takes the capture's row lock, so that a capture and a deletion of one session run one after the other (D198). Clearing a session's requests (`DELETE .../requests`) locks the session row `FOR NO KEY UPDATE` in a statement of its own, judges expiry with the lock held, and then deletes the requests, starts the queue again, purges the outbox and appends its event in later statements of the same transaction, so a capture that held the lock first is deleted with the rest and announced before the clear (D221 point 6).

### Migrations
Schema changes are plain `.sql` files applied in filename order by `npm run db:migrate`. Applied names are recorded in a `schema_migrations` table, so running the command repeatedly only executes new files. Each migration runs in its own transaction and is rolled back completely if it fails.

**Each migration waits at most 5 s for a lock** (`lock_timeout`, `apps/backend/src/db/migrations.ts`, D221): a statement held off longer fails, the migration rolls back unrecorded, and the backend's init container runs again, rather than queueing every query of an image still serving behind it. **Every migration runs while the previous image serves** (D151 as amended, D221 point 18). The backend rolls, so at every deployment the new pod's init container migrates while the old pod still serves, and the two images serve on the new schema side by side for the seconds of the rollout; after a rollback the previous image keeps running on it, as it always did (D055). A migration therefore adds only what the previous image ignores and changes nothing it reads or writes in a way it would refuse or misread — migration `012` adds a table the previous image never reads and takes no lock it waits for — and a change the previous image cannot serve on is split: the addition first, and the removal in a later release, once no image that needs the old shape can serve or be rolled back to. The previous image's statements replayed on the new schema are the evidence, as D151's, D205's and D220's tests replay them. Migration `014` (D243) adds a column with a constant default the previous image never names and a trigger on `requests` that rewrites nothing it reads: its capture's insert, replayed in `source-ip-choice.test.ts`, stores no address for a session created not to keep one, and stores it as before for every other. Migration `015` adds a trigger on `request_responses` that does the same for the record of its default answer, which it reads back only for the detail: the rewritten record is as well-formed as the one it wrote, so it reads it without misreading. Migration `019` replaces that trigger's function with `CREATE OR REPLACE FUNCTION`, which takes no lock on the table, and changes the outcome of no record an image before 1.9.0 writes (D251 point 16). Their locks are those every such change takes, and the reason for the 5 s: the `ALTER` takes `ACCESS EXCLUSIVE` on `sessions`, and each `CREATE TRIGGER` `SHARE ROW EXCLUSIVE` on its table, held until the migration commits; each waits for the captures in flight, transactions of milliseconds, and holds new ones behind it while it waits, at most 5 s, after which the migration rolls back and the init container runs it again.

Constraints enforced by the schema: the session id is 43 characters, `body_size` is between zero and 1 MB, `headers` must be an array of `[name, value]` string pairs on captured requests, configured responses and recorded responses alike, a recorded response's `state` is one of the four stored values, both requests and response records reference their parent with `ON DELETE CASCADE`, and a top value's `dimension` is one of the four the usage counters keep.

Neither proxy writes an access log, because a request URL contains the session id and that id is the access key to a session (D090). Traefik's error log stays on, at its chart's default level, INFO, and records a sender's address when a connection fails: on the receive host's TCP route a connection the sender resets mid-request is logged at ERROR as `Error while handling TCP connection … read tcp <proxy>:8443-><sender>:<port>: read: connection reset`. The Privacy Policy says so since 0.57.5 (D231).

### The trust boundary and the sender's address
**Since 0.36.0 the boundary governs the PROXY protocol header, not `X-Forwarded-For`** (D187). A capture's `source_ip` is the source address of the PROXY v2 header on its connection, accepted only when the socket peer is inside the allow-list below; a connection from anybody else is refused, so no pod outside it and no sender can choose the stored address. The receive listener's `trustProxy` is off and no request header is read for the address. With `RECEIVE_PROXY_PROTOCOL=v2` the backend refuses to start on an empty allow-list. The application listener still applies the allow-list to `X-Forwarded-For` as described below, for `request.ip`, which nothing stored reads any more. What follows is the mechanism as D111 and D130 built it, and it holds for the PROXY check unchanged: the same list, compiled once by `@fastify/proxy-addr`, the same `/24`, the same single-node assumption.

The backend decides whose forwarding headers it believes from a **CIDR allow-list read from configuration** (`TRUSTED_PROXY_CIDRS`), which is **empty by default and set to `10.42.0.0/24` in the deployed chart** (D111, D130). It is never a hop count — a hop count is believed by whoever happens to be talking to the process — and never `true`. The configuration parser accepts only literal addresses and CIDR ranges, rejects the named presets `@fastify/proxy-addr` also understands, and fails startup on an entry it cannot read, so what is trusted is always written out in full. An entry is held to the same strict spelling as a stored address, plus two refusals the entry form needs of its own: a `/0` prefix, which is `trustProxy: true` under CIDR syntax and is refused with a message saying exactly that rather than with the generic one, and a zone suffix (`fe80::1%eth0/64`), which names an interface on this host rather than a peer that can reach it. A prefix length is also refused unless it is written without leading zeros, since `/024` is the same ambiguity as `010.1.1.1`.

With the list empty, `trustProxy` is off: forwarding headers are ignored entirely, `source_ip` is the socket peer and every header is stored. With entries in it, `X-Forwarded-For` is evaluated **right-to-left** by `@fastify/proxy-addr` and the address is the right-most one that is not itself trusted, so a value forged on the left is skipped even if it survives the proxy. Before 0.36.0 that was the stored address, and a capture from a trusted peer was stored without the proxy's own forwarding headers (D144, retired by D187). `X-Real-Ip` is never the stored value, and `Forwarded` (RFC 7239) is ignored because Traefik does not produce it. Traefik's default `forwardedHeaders` configuration — no `trustedIPs`, no `insecure` — deletes a sender's forged `X-Forwarded-*` and replaces it, which a production probe measured rather than assumed; that default must not be changed.

**What the mechanism does not do, stated rather than left to be discovered.** A `/24` such as the node's pod network trusts **every pod on that node**, not one named peer: any workload scheduled beside the backend would be inside the boundary and could set `X-Forwarded-For` to anything. The range is also **per-node** — a second node gets a different one, and the allow-list would silently stop matching whoever actually forwards. Narrowing it to the proxy pod's own address is not possible, because a pod IP is not stable across restarts. The single-node cluster is what makes the approximation acceptable, and it is an assumption with an expiry date rather than a property of the design. What holds without qualification is the weaker statement: **nothing off-cluster can be trusted**, because the backend Service is ClusterIP with no Ingress route.

**On production the allow-list names the in-cluster proxy, and the stored address is the sender's own.** Traefik has run `externalTrafficPolicy: Local` since 2026-09-21, so the k3s ServiceLB no longer MASQUERADEs the source address before Traefik sees it, and the deployed chart sets the allow-list to the node's pod network. The header probe re-run after that policy change — and before the allow-list was filled — arrived with `X-Forwarded-For` and `X-Real-Ip` both equal to the prober's real public address, where the same probe under `Cluster` had arrived as `10.42.0.1`, the pod network gateway; a forged `X-Forwarded-For` was still stripped by Traefik. The order of the two changes matters in both directions, which is why it is written down: the allow-list is filled only after a probe confirms a real address arrives, and on the way back it is emptied and deployed *before* the policy is reverted, because a populated allow-list under `Cluster` stores a private address through a path the code considers trusted — worse than the honest wrong answer it replaces (D118, D130; the operator's runbook for the policy is kept outside this repository). The IPv6 path is **not verified on production**: neither the host nor the prober has IPv6, so it rests on the unit tests alone.

The address is **normalised and validated before storage** by a pure function: an IPv6 zone suffix is dropped, IPv4-mapped IPv6 is unwrapped in both the dotted and the hex spelling, IPv6 text is lower-cased and compressed, and anything that does not parse is stored as `null`. The historical short IPv4 spellings (`1`, `127.1`, `0x7f.1.1.1`, and the octal `010.1.1.1` that `ipaddr.js` reads as `8.1.1.1`) are refused rather than expanded, because recording an address that never arrived is the worst available failure for an inspector. `source_ip` stays `TEXT`: validation belongs in the application, which can answer `null`, not in the column, which would fail the capture of an otherwise valid webhook.

**A session may keep no address** (D243). One created with `storeSourceIp: false` stores `source_ip` `NULL` for every request, whatever its sender: the capture reads `store_source_ip` with the lock it already takes, writes `NULL`, and builds the default answer, its record and `request.received` from the row the insert returned (`RETURNING source_ip`), never from the address it read, so no answer about a request can say more than its row; the triggers of migrations `014` and `015` hold every other writer to the same, in the request and in the record of its default answer; the previous image's live event and the answer it sends the sender, built in its own process, are what no trigger reaches (D243 item 10). Everything in memory is unchanged: the capture budget (D210), the waiting line and the per-address limits of the API (D201, D213) key by the real address before the session is read, as `/privacy` says, and the log keeps the socket peer (D117). The headers stay as sent (D187), a sender's own forwarding headers included. The usage statistics count such a request under `<unknown>`, as one whose address did not parse (migration `008`).

**Nothing is derived from the address.** Country resolution was removed rather than finished (D140): the capture path performs no lookup, there is no geodata dataset, reader dependency or attribution line, and `requests.source_country` is left in place, unwritten, for the rollback reason given under `requests` above. The address is stored and shown as it is, and that is the whole of what the product says about the sender.

The structured log emits `request.socket.remoteAddress` through a custom `req` serializer rather than Fastify's default `remoteAddress: req.ip` (D117). The two are the same value only while the allow-list is empty. It is filled in on production, so `req.ip` there is the sender's real public address, and Fastify's default would write it into every request log line. The receive listener uses the same serializer, and its PROXY layer leaves the socket's address alone, so a capture's line names the Traefik pod and never the sender's address the PROXY header carried (D187). What is logged instead is the peer the process is actually talking to, which preserves the "which peer is talking to me" signal while keeping the sender's address out of a record that is read through Lens, pasted into issues and screenshotted, and that outlives the session TTL. This is field-level redaction, with the weakness D059 names against it — an address arriving inside an error message passes through — accepted because stream-level redaction cannot do this job: an IP address has no distinctive textual shape.

## Expiration and cleanup
`expires_at` is authoritative.

Backend must check expiration when serving a session, regardless of whether physical cleanup has already run.

Physical cleanup should use PostgreSQL `pg_cron`, approximately every 10 minutes:
```sql
DELETE FROM sessions
WHERE expires_at < NOW();
```

`ON DELETE CASCADE` removes associated requests automatically.

**A lifetime at creation** (D220). The refresh statement that slides `expires_at` on a use (`REFRESH_SESSION_EXPIRY_SQL`, D133) carries one more condition, `AND lifetime_ends_at IS NULL`, so a session created with a lifetime keeps the expiry it was created with: the hot capture path gains a condition on the row it already locks, and nothing else. The constraint `sessions_lifetime_cap`, `lifetime_ends_at IS NULL OR expires_at <= lifetime_ends_at`, holds the rule for every writer: the previous image, which keeps running on this schema after a rollback and beside this one during a rolling update, slides without the condition, and the database refuses that update (`23514`); its refresh already runs in a savepoint that turns a failure into "keeps its previous expiry", with at most one warning a minute, so its capture or response change still commits. Moving an expiry back, as the tests do to expire a session, always satisfies it. The column is never dropped in a recovery: the previous image does not name it.

**An idle window at creation** (D242). The refresh statement reads the window from the row: `SET expires_at = clock_timestamp() + make_interval(secs => idle_seconds)`, throttled by `expires_at < clock_timestamp() + make_interval(secs => idle_seconds) - least(interval '1 hour', make_interval(secs => idle_seconds / 10))`, so a 1-hour session can be moved every 6 minutes and a session of 10 hours or more once an hour, as every session was; it takes the session id alone. Uses at once write once: a refresh that waited on the row's lock re-reads the row the first wrote, which its throttle then leaves alone. The window is an interval of seconds, exact in any time zone, where the 7 days were calendar days. The trigger `sessions_idle_window_cap`, `BEFORE UPDATE OF expires_at`, holds every writer to the window, since a CHECK cannot read the clock: on a session without a lifetime it sets `NEW.expires_at` to the earlier of what was written and `clock_timestamp()` plus `idle_seconds`. The previous image's refresh, which slides every session 7 days, thus leaves a short session a full window ahead and never fails, on every use of it, its own throttle being an hour off 7 days; this image's statement never reaches the cap. A move back is below the cap and kept as written; a session with a lifetime is left to `sessions_lifetime_cap`. The trigger fires on the hot capture path only when the throttle lets a refresh write, and since 1.15.10 the capture sends the refresh only when its expiry read finds it due by the same conditions (`REFRESH_DUE_SQL`, #260). Neither the column nor the trigger is dropped in a recovery: without the trigger the previous image would keep a short session a week.

**The realtime outbox** (D221). Each backend process deletes, every 5 s through its API's pool (D244), the outbox rows older than 20 s whose writing transaction is below the floor it read two prunes earlier, so no row is deleted before every listening process has read it. It records a floor only while it listens, so a process whose channel is lost prunes nothing from 10 to 15 s after the loss until 10 to 15 s after it listens again. A prune that deleted 1 MiB of payload or more is followed by `VACUUM (SKIP_LOCKED, INDEX_CLEANUP ON) realtime_events` from the same process, and so is the prune after it: a deleted row's space, its TOAST chunks above all, is written again only once a vacuum has passed over it, and autovacuum, which looks once a minute, let a flood of large events grow the table without bound; autovacuum stays the backstop, at full speed on this table. A snapshot older than the deleted rows - the nightly `pg_dump`'s, while it runs, kept short by leaving the outbox's rows out of the dump - holds the reclaim back, and the table grows meanwhile by what is written (D221 point 9). A third job, `webhook-inspector-prune-realtime-events`, deletes every minute what is older than five minutes, for a database no process prunes, after a rollback to an image without the outbox. Neither the prune nor the job waits for a row lock: each locks what it deletes `FOR UPDATE SKIP LOCKED`, so a row a deletion's purge holds is left to its next run and the two never deadlock. A deletion empties the payloads of what it deletes at once.

**Deletion beside the cleanup** (D198). `DELETE /api/sessions/:sessionId` removes a live session at once rather than waiting for its expiry: one transaction locks the session row `FOR UPDATE`, as a capture does, judges expiry with the lock held, deletes the session's requests — their response records go by the cascade — and then the session row, and counts the deletion in `stats.deletions_daily`. An expired session is refused with `410` and left to this cleanup, which is unchanged.

The PostgreSQL server must run with `shared_preload_libraries=pg_cron`, `cron.database_name` pointing at this database, and **`cron.use_background_workers=on`**. Without background workers pg_cron opens a new libpq connection to localhost for every run, which must then pass `pg_hba`/`.pgpass` authentication; under the default password authentication those runs fail while the job still appears healthy in `cron.job`.

Verify a deployment by inspecting `cron.job_run_details`, not by checking that the job is registered.

pg_cron runs a second job, `webhook-inspector-record-usage-days`, which records the daily usage counters at 00:05 UTC (under **The `stats` schema**, D178), and a fourth, `webhook-inspector-delete-old-sender-nets`, which removes at 00:10 UTC the sender networks of those counters older than 90 days (D254); the third is the outbox's above. The first is `webhook-inspector-delete-expired-sessions`, the statement above every 10 minutes. Migrations `006`, `008`, `012` and `020` scheduled the four as `qa-tools-<the same suffix>`; migration `021` renames them on `006`'s pattern, each old job unscheduled by its id, found by name alone, so a row a restore wrote under another owner goes too, and the same statement scheduled on the same schedule under the new name (D160, D278).

The PostgreSQL image/deployment must support `pg_cron`. This must be validated when the database infrastructure is implemented. If `pg_cron` proves impractical, a Kubernetes CronJob executing equivalent SQL is the approved fallback. Do not embed the cleanup scheduler in the backend by default.

## Local development
Local development runs PostgreSQL through `docker-compose.yml`, using an image that provides `pg_cron` so scheduled cleanup matches production behaviour.

The Compose project is named `webhook-inspector` in the file itself, not after the checkout's directory, so the main checkout and every worktree share one container, `webhook-inspector-postgres-1`, one image, `webhook-inspector-postgres`, and one volume, `webhook-inspector_postgres-data` (D159, D278); the database and role are `webhook_inspector`. Until 1.18.2 every one of those names was `qa-tools`' (D278): on a machine set up before, `npm run db:up` gives the old image `qa-tools-postgres` the new name with `docker tag` and stops a running `qa-tools-postgres-1`, which would hold port 5432, and leaves it and its volume `qa-tools_postgres-data`, with the data in it, where they are; the README says how to remove them. It stops that container only once the image has its new name: a `docker tag` that fails ends `db:up` non-zero with the command and what Docker said, and with neither name there Compose reports the image missing, so the old database keeps running either way (#353). `npm run db:up` starts that container from the image already built — it never builds and never pulls, so it never waits on a registry or Docker Desktop's credential helper — and succeeds only once the container's health check can query the configured database; it gives up with a non-zero exit and a message after three minutes at most. `npm run db:rebuild` builds the image, which is needed once per machine and again only when `deploy/postgres/` changes.

Backend and frontend run natively through npm scripts against that database. Application containers are built in CI for production rather than used for day-to-day development.

`packages/shared` is consumed as TypeScript source by both applications, so no package needs to be built before the others run and no stale build output can be used by mistake.

The frontend dev server proxies the four paths the Ingress routes to the backend's application listener, each a string prefix as there: `/api/`, `/ws/` and `/s/` (D047, D183), so a bare `/api`, `/ws` or `/s` stays the frontend's, as in production, and `/s/…` answers the `410` production's `qa-tools.ru` answers; and `/mcp` (D203), so `/mcp/` and `/mcpx` reach the backend's `404` / `1000` locally as in production since 0.45.1. The slash that ends the first three also keeps `/s/` off the dev server's own `/src/` modules; a frontend test compares the four with the Ingress's. Webhooks are not proxied: the receive URL the session page displays is the backend's receive listener itself, `http://127.0.0.1:3001` unless `RECEIVE_ORIGIN` says otherwise, because Vite's proxy in front of a capture would lower-case and merge the headers it exists to show (D187).

Connection settings and other local configuration come from a gitignored `.env`, with `.env.example` committed as documentation.

## Infrastructure
Hosting:
- a single Linux server; its provider and size are the operator's, recorded
  outside this repository

Kubernetes:
- k3s, single node acting as control plane and worker
- managed/inspected through Lens over an SSH tunnel to the API port, which is
  not published to the internet (D082)

Cluster prerequisites live in `deploy/cluster/` so an install can be repeated
exactly. They belong to the cluster rather than to a release of the application:
- Traefik, the controller k3s packages and upgrades, customised through a
  `HelmChartConfig` that k3s reconciles (D083)
- cert-manager, issuing Let's Encrypt certificates, installed by hand
- k3s built-ins kept as installed: `local-path` storage, ServiceLB, CoreDNS

Packaging/deployment:
- Docker images, built from the repository root: the backend image reproduces the
  workspace layout because Node resolves `@webhook-inspector/shared` through the npm
  workspace symlink and refuses to strip types under `node_modules` (D051)
- the frontend image is static files behind Nginx and carries no configuration
  at run time, since the application only ever talks to its own origin; the
  address it names is set when it is built (below, D274)
- Helm chart

### The inspector's address

The inspector's address is two settings, the site's origin `APP_ORIGIN` and
the receive host's `RECEIVE_ORIGIN` (D274), the names the backend reads for
the same values (D187, D203), and since 1.16.0 a third, `APP_ALIAS_ORIGIN`,
the site's second origin, the host the same site also answers on and moves
to on day X (D275). Since 1.19.10 (#367) they are the project's CI/CD
variables `DEPLOY_APP_ORIGIN`, `DEPLOY_RECEIVE_ORIGIN` and
`DEPLOY_APP_ALIAS_ORIGIN`, which no file of the repository names; the hidden
job `.inspector-address` of `.gitlab-ci.yml` gives them the three names above
for the image builds' template `.image` and the smoke, which extend it, and
the deploy job reads the variables themselves:

- `image:frontend` passes the three to the frontend image build as build
  arguments of `apps/frontend/Dockerfile`, through its `BUILD_ARGS`, so an
  image is built for one address; the other images take no build argument.
  On `main` the image is built once per commit and published under its SHA,
  and a rerun reuses it, so it holds the variables as they were when it was
  first built: a later change of one reaches the image only with a new
  commit, while `deploy` and the smoke read it at once. So since 1.19.10
  (#367) the build on `main` stops before building, naming the variable,
  when `DEPLOY_APP_ORIGIN` or `DEPLOY_RECEIVE_ORIGIN` is not set or empty,
  or `DEPLOY_APP_ALIAS_ORIGIN` is not set (empty is none), rather than
  publish an image named for the build's fallbacks, production's origins;
- `deploy` checks that each is `https://` and a host name alone — since
  1.19.1 (#340) dot-separated labels of lowercase letters, digits and
  hyphens, each 1 to 63 characters and neither starting nor ending with a
  hyphen, with no empty label and no trailing dot — a refusal naming the
  variable and never its value, and installs the chart with
  `ingress.host` and `receive.host`, the two hosts, and `alerts.siteUrl`, the
  site's origin; from the two hosts the chart sets the backend's `APP_ORIGIN`
  and `RECEIVE_ORIGIN`, and from `receive.host` the monitor's receive URL, as
  it did before, the monitor's site URL being `alerts.siteUrl`; the second
  origin, which may be empty for none and must otherwise be a host of its
  own, goes to `ingress.aliasHost`, from which the chart renders the second
  host's Ingresses and sets the backend's `APP_ALIAS_ORIGIN`, the other
  `Origin` `/mcp` lets in. `environment.url` is `$DEPLOY_APP_ORIGIN`;
- `deployment-smoke` runs `scripts/check-deployment.mjs` against both, and the
  check takes the canonical link and the sitemap line it expects from the
  origin it is given; then, given the second origin, it waits up to about 5
  minutes for that host's certificate, which cert-manager issues only once
  the deployment has created its Ingress, and checks the host as one closed
  to search whose pages name the first.

The backend's names are not those of the project variables, which reach every
job: the `test` job's backend suite expects both unset, and the e2e suite
gives its backend its own `RECEIVE_ORIGIN` but no `APP_ORIGIN`, so a project
variable `APP_ORIGIN` would reach that backend too. A change of address is a
change of the variables, made in a delivery and recorded with the operator
(#367); `scripts/chart.test.mjs` holds the deploy job's check to production's
three origins and the pipeline files and `deploy/` to naming none of them.
`values.yaml` names no host: the chart refuses to render without the two.

What else makes an installation is in the project's CI/CD variables too,
since 1.19.10 (#367): the runners (`QA_TOOLS_RUNNER_TAG`, `DEPLOY_RUNNER_TAG`),
the certificates' and the database's names, the backup directory, the
off-server copy's bucket, storage, Secret and recipient key, the heartbeat
URL and Secret, and the operator's details the frontend image names
(`DEPLOY_STATUS_PAGE_URL`, `DEPLOY_CONTACT_EMAIL`, `DEPLOY_OPERATOR_TEXTS`,
below), each listed in README.md, "Deploying from GitLab CI". The deploy job
stops before `helm upgrade`, naming every one it reads that is not set, so an
unset variable cannot switch the off-server copy or the monitor off; it stops
the same way for one set empty, but for the three options, the second origin,
the bucket and the heartbeat URL, which empty are off, so an empty variable
cannot let the chart's default rename the database, the backup directory or
the receive host's certificate under a running installation. It gives the
chart each value that is not empty. The chart's own defaults name
nothing of production's: no host, registry, bucket, storage, heartbeat
service or key, TLS and database Secrets named after the release, the backup
directory `/var/backups/webhook-inspector`, and the off-server copy and the
monitor off.

The frontend build reads both from its environment, production's when unset
or empty, and refuses anything but an http or https origin alone whose host
is a host name by the deploy job's rule (since 1.19.1, #340) or an IPv6
address in brackets, with any port but 0, never quoting the value
(`apps/frontend/scripts/site-origin.mjs`): `URL` lets a quote, an apostrophe
or a backtick into a host, and the build pastes the origin into attributes,
JSON and the relay script's string; it also lets through `-`, `.`, `a..b`
and `a.b.`, which the chart's Ingress would refuse only at deployment. The
files the site serves are written for production — the pages' templates,
`public/robots.txt`, `public/sitemap.xml`, the relay script,
`packages/shared/openapi.json`, `llms/` and `CHANGELOG.md` — and the build
names the configured origins in them on their way into `dist/`:
`https://qa-tools.ru` becomes the site's origin, `https://hook.qa-tools.ru`
the receive host's,
`https://webhook.qa-tools.ru` the second origin's, or the site's where there
is none (D275), a `wss://` name its origin under `wss:` or `ws:`, and a bare
host the host. The second origin defaults to production's while the site is
production's and to none for any other site — so an empty
`DEPLOY_APP_ALIAS_ORIGIN` beside production's site origin removes the second
host's Ingresses and certificate while the image still names
`https://webhook.qa-tools.ru`; a copy on its own origins is unaffected — and the build refuses origins
it could not name as they are, such as a second origin equal to the site's. The rename leaves the feeds' entry ids `tag:qa-tools.ru,2026:…`
as they are, which are permanent, and `contact@qa-tools.ru` and
`status.qa-tools.ru`, which until 1.19.6 every build named as the platform's
and which since #369 a build names only when its operator settings do, or in
the changelog's history (The operator's details, below). A production host followed by a port is another origin
than production's and stays too, so a copy on `https://qa-tools.ru:8443` is
named once and naming a text again changes nothing (#339). A build with no
second origin names `https://webhook.qa-tools.ru` as its own site, so it also
leaves out of the changelog every Breaking, Deprecated or Notice paragraph
that names that host, such as 1.16.0's notice of the move, which would come
out moving the site from its origin to the same one; an entry left with none
is no longer marked, and the breaking feed leaves it out (#343). Built for
production, every file is byte for byte what it was. The places that compose
an address themselves — the feeds' links,
`security.txt`'s `Canonical`, the about page's MCP address, the legal pages'
and the about pages' own addresses, the agent guide's header and the build
check's expectations — take `APP_ORIGIN` from the same module. The build
writes `openapi.json` into `dist/` itself, named and with the relay section's
SHA-256 being the built relay script's, and the image serves that copy. A
build for another origin is refused by the build check if any text file of it
still names `qa-tools.ru` outside the names kept and the configured hosts,
which may themselves end in production's name, as `webhook.qa-tools.ru`
does; a host counts only as a whole name, so a build for another receive host
alone still shows a `hook.qa-tools.ru` it left. Any build is refused if a text
file names a configured host that has a port with a second port after it,
`qa-tools.ru:8443:8443` (#339).

**The operator's details** (#369). What the site says of whoever runs it is
three more settings of the frontend build, passed like the origins as build
arguments of `apps/frontend/Dockerfile` and read by `src/lib/operator.ts`:
`STATUS_PAGE_URL`, the status page, an http or https address with no query,
fragment or credentials whose path needs no quoting; `CONTACT_EMAIL`, the
contact address; and `OPERATOR_TEXTS`, `true` or `false`, the operator's own
texts. Unlike the origins, an unset or empty one has no default: the detail
is left out, and nothing in the sources falls back to production's. A value
of the wrong form fails the build, never quoted, and so does
`OPERATOR_TEXTS=true` without the other two, which the texts name. Since
1.19.10 (#367) production's come from the project's CI/CD variables
`DEPLOY_STATUS_PAGE_URL`, `DEPLOY_CONTACT_EMAIL` and `DEPLOY_OPERATOR_TEXTS`,
which the `.gitlab-ci.yml` job `image:frontend` gives the three names above
beside its `BUILD_ARGS`, as `.inspector-address` does the origins; no file of
the repository names their values. On `main` the build stops before building,
naming each of the three that is not set, so an unset variable cannot leave a
detail out of production's site, whose image is built once per commit (The
inspector's address, above); set empty, the image leaves it out.

- The status page: `Status ↗` in the application's header (`AppHeader`) and
  the static pages' (`siteHeader`), with the divider before it, comes from
  `statusLink()` of `src/lib/status-link.ts`; the `llms.txt` line and the API
  description's sentence come from `scripts/site-operator.mjs`; and `/status`
  and `/status/` are two exact locations that `scripts/nginx-conf.mjs` writes
  in place of the comment `# status-page-locations` of `nginx.conf`, a 301 to
  the address. The image build runs it after `npm run build` and copies what
  it wrote in as `/etc/nginx/conf.d/default.conf`, so the redirect is decided
  when the image is built (D274); without a status page the line stays a
  comment and `/status` is `location /`'s 404 with the application.
- The contact address: the footer's `Contact:` in both bands, the about
  pages' third paragraph, the legal pages' mail links, `security.txt` and
  the API description's `info.contact`.
- The operator's texts: the Terms of Use and the Privacy Policy, their
  footer links and sitemap entries, the about pages' lines on who runs the
  service and who pays for it, and the API description's two paragraphs on
  who runs it and on the terms. The Privacy Policy names the status page's
  host from `STATUS_PAGE_URL`.

The bundle gets the settings as `__WEBHOOK_INSPECTOR_OPERATOR__`, which
`vite.config.ts` defines from what `operator.ts` read in its own process;
everywhere else, the build's scripts and the tests, `operator.ts` reads the
environment. `public/sitemap.xml`, `llms/llms.txt` and
`packages/shared/openapi.json` stay written for production, as for the
origins, and `scripts/site-operator.mjs` names the operator's details in
them or leaves the part out on their way into `dist/`, refusing a source
that lost the part it edits; with production's settings each file is its
source byte for byte. The build check refuses any file of the build — every
file, read as UTF-8, images and fonts among them — that names production's
status page host, its contact address, its hosting provider or its backup
storage when the build's settings do not name it, in any case, inside a
longer word, split across lines or escaped as a character reference, a
percent escape or a JavaScript escape, outside the changelog's history:
`changelog.md`, the two feeds and the entries of `/changelog`, whose header
and footer it does read (`operatorNameProblems`). The frontend suite runs
with production's settings in its environment
(`src/testing/production-operator-env.ts`, loaded with `--import`), and so
does the browser suite (`playwright.config.ts`); `src/lib/operator.test.ts`
builds the site with an example origin and none of the settings. The
frontend suite gives the same result whatever origins the developer's shell
exports: a test file that loads a build module reading `APP_ORIGIN`,
`APP_ALIAS_ORIGIN` or `RECEIVE_ORIGIN` sets the three to production's in
`process.env` before importing it, or passes production's origins to it,
and a build for another address is checked with a fixed one the test names
itself, as in `src/lib/llms.test.ts` (#354).

The backend names its `RECEIVE_ORIGIN` in the MCP tool `create_session`'s
description, as it already did in every `receiveUrl`; it serves no OpenAPI
description of its own, the frontend image's being the one at `/openapi.json`.

Initial workloads:
- frontend Deployment, 1 replica
- backend Deployment, 1 replica, and two for the seconds of a rollout
- PostgreSQL stateful workload, 1 replica with a 20 GB persistent volume (D085)
- Services for frontend, backend, PostgreSQL
- two Ingresses for public HTTP/HTTPS and WebSocket routing, the API's
  behind a Traefik `Middleware`, the edge rate limit (D264)
- a CronJob backing the database up every night (D176), with a notifier
  sidecar in its pod reporting each run to the alert service (D181)
- a CronJob checking the site and the disk every 5 minutes for the alert
  service (D181)

PostgreSQL is not exposed publicly through Ingress.

The backend rolls since 0.54.1 (D088, D221): `RollingUpdate` with
`maxSurge: 1` and `maxUnavailable: 0`, so a deployment starts the new pod, whose
init container migrates while the old pod serves, takes it into the Service once
it is ready, and only then tells the old one to stop. For those seconds two
backend processes serve, events reaching the viewers of both through the outbox
and each keeping its own per-address counts. The old pod's `preStop` hook sends
SIGUSR2, starting the drain, and pauses 10 s, so that Traefik drops the
terminating pod before it stops accepting; `terminationGracePeriodSeconds` is
60, the pause and a webhook reply held 30 s by its delay with room; readiness is
asked from 1 s after start every 2 s, with a 1 s timeout and 15 failures to leave
the Service. A deployment therefore refuses no connection, and a new pod that
never becomes ready leaves the old one serving. Such a rollout leaves the
unready new pod beside the old one, a `failed` Helm release once
`helm upgrade --wait` gives up after its 10 minutes, and any migration the new
pod's init container ran, which the old image runs on (D221 point 18). The next
deployment clears the pod and the release, or the serving deployment's deploy
job run again (D267), which is a deployment of that commit
and so rolls and leaves no gap; neither undoes the
migration, which stays (D055). That is Kubernetes' and Helm's
behaviour, inferred, not observed on production. `helm upgrade --wait` returns
once the new pod is ready, while the old one may still be stopping. A rollback
to a version before 0.54.1 applies that version's `Recreate` once, with the gap
it always had.

The backend pod sets one sysctl of its own network namespace since 1.14.1,
`net.ipv4.tcp_rmem` `4096 16384 6291456` (`backend.tcpRmem` in the chart's
values, in the pod's `securityContext`; #242 from #217, amending D238): a TCP socket of
the pod starts with a receive buffer of 16 KiB rather than Linux's 128 KiB, and
one the backend reads fast still grows to 6 MiB. A connection the receive host
holds unread — for its header lines (D238), behind its pipelined requests
(D229) or waiting for a capture place (D228) — never grows its buffer, so it
costs the backend that start and the one read put back in front of it, about
50 to 85 KiB as measured rather than 160 to 220 KiB. What its sender sends
beyond that waits in Traefik's sockets and the sender's instead, and Traefik
has no memory limit (D228 point 5), so under a flood that part of the cost is
the node's: from 4 attacking addresses each holding 512 connections, Traefik
peaked at about 0.7 GiB with the sysctl and 0.6 GiB without it, while the
backend's peak fell from 394 and 512 MiB to 225 and 204 MiB (D238's amendment). It is a
safe sysctl since Kubernetes 1.32, which the kubelet allows with no node
setting; a node that refused it (`SysctlForbidden`) would leave the new pod
unstarted and the rollout failed with the old pod serving, as for any pod that
never becomes ready. An empty `backend.tcpRmem` drops it. No other pod sets a
sysctl, and `scripts/chart.test.mjs` pins where it is set.

The frontend rolls with `maxSurge: 1` and `maxUnavailable: 0`, stated in the
chart: the new pod is ready before the old one is told to stop. The old one has
a `preStop` pause of 10 s, so no request reaches it after nginx has stopped
accepting, and 30 s to stop; its readiness is asked every 2 s (D221).
`scripts/chart.test.mjs` pins both.

Schema migrations run as an init container on the backend pod, from the same
image that then serves traffic, so a release applies the schema it expects. The
runner records applied names, which makes repeating it safe, and it exits
non-zero while the database is unreachable, which is also how the container
waits for it.

The database password is a Secret created outside the release; the chart
references it by name and Kubernetes composes the connection URL from it, so the
value appears neither in the chart nor in the deployment pipeline (D087).

The database is backed up by a CronJob every night at 03:00 Moscow time (D176).
It runs the database's own image and a script the chart mounts from a
ConfigMap, dumps the database into a directory on the node outside the
namespace, `backup.hostPath`, and restores each dump into a
scratch PostgreSQL inside its own pod, without pg_cron, failing unless the
restored session and request counts equal those read in the dump's own
snapshot. The rows of the realtime outbox, `realtime_events`, are left out
of the dump, and a restore creates that table empty (D221). It keeps the 3
newest dumps, writes nothing when the disk has less than 10 GiB free, and leaves no dump behind from a run that fails — except when
only the deletion of old dumps failed, when the new, checked dump is kept. The
dumps share the node's disk with the database: they protect against a mistake,
not against losing the server. The deploy identity may manage CronJobs but not
Jobs, so the chart creates the CronJob and never a Job. The backup and
restore procedures are the operator's runbook, kept outside this repository.

Against losing the server, an installation that sets `backup.offsite.bucket`
has each run also leave an encrypted copy of its dump in that bucket, of any
S3-compatible storage (D190; production's storage is its operator's). The
backup container encrypts the dump it has saved and checked with `gpg`, to the
public key the installation gives, `backup.offsite.recipientKey`; the private
key is with its holder only, so the server cannot decrypt its own copies. It hands the ciphertext, through an `emptyDir`, to an uploader beside
it in the pod — a second native sidecar on the backend image, which alone
holds the storage key and never sees the dump — and waits for its answer. The
uploader signs its requests itself (AWS Signature Version 4, no SDK), uploads
the copy, and deletes all but the 3 newest copies from the bucket, after
checking that the bucket's versioning is off. A failure there fails the run
after its dump is kept, and reaches the owner through the same `backup`
heartbeat. With `backup.offsite.bucket` empty the pod has no uploader and
nothing is encrypted.

Alerts come from a heartbeat service, for an installation that sets
`alerts.heartbeatUrl`: any that takes a POST to `<url>/<token>` and
`<url>/<token>/fail` (D181; production's is its operator's, which messages the
owner). Jobs in the cluster send it heartbeats, and it alerts when one reports
a failure or when they stop arriving, so a dead cluster or VPS alerts by its
silence. Without a heartbeat URL neither the monitor nor the backup's notifier
is rendered. A CronJob on the backend image, every 5 minutes, probes the site by
its public name — `GET /`, then a lookup of a random id shaped as a session
id, which no session has, so that it reaches the backend and the database and
creates nothing, then the same kind of id as a webhook on the receive host,
through its own TCP route (D187), up to three attempts —
and reads the usage of the disk holding the database volume, and sends `site`
and `disk`. The backup's pod carries a notifier on the
backend image as a native sidecar: the backup script writes its outcome to a
file the two containers share, and the notifier sends `backup`, which a run
reports only when its dump and its off-server copy both succeeded; the
PostgreSQL image has no HTTPS client and is left unchanged. In production
three more monitors check from the heartbeat service's own locations every
minute: the home page, and
the same two lookups of a session that does not exist, on the API and on the
receive host. They alone feed the public status page,
`https://status.qa-tools.ru/`, which `/status` redirects to and every page's
header links to (D209). The alerts procedures are the operator's runbook,
kept outside this repository.

### Ingress routing
Route public paths of `qa-tools.ru` as follows:
- `/api/*` -> backend Service
- `/ws/*` -> backend Service
- `/s/*` -> backend Service, whose application listener answers `410` / `1009` there since 0.36.0 (D173, D187)
- `/mcp*` -> backend Service: `/mcp` is the MCP server (D203), any longer path its `404` / `1000`
- `/` -> frontend Service
- `/v/*` -> frontend Service
- every other path -> frontend Service, bare `/api`, `/ws` and `/s` included

The three backend paths are `/api/`, `/ws/` and `/s/`, each with its trailing
slash and `pathType: Prefix` (D183). Traefik matches a `Prefix` path as a
string prefix, so without the slash `/s` would also take `/sitemap.xml` or
`/sxyz`; with it, only the backend's own segments reach the backend, and every
backend route lies under one of them. `/mcp` is the fourth backend path since
0.45.0 (D203), with `pathType: Prefix` since 0.45.1, so `/mcp/` and `/mcpx`
reach the backend too, whose not-found route answers them `404` / `1000`. Both
Ingresses are pinned to the `websecure` entry point
(`traefik.ingress.kubernetes.io/router.entrypoints`, D187). The receive host's
TCP route reaches only the receive listener, which serves `/s/*` and its
`robots.txt`, so `hook.qa-tools.ru/mcp` is its `404` / `1000`.

**Two Ingresses** since 1.15.15 (#205, D264), because Traefik applies a
middleware annotation to every path of its Ingress: `qa-tools` holds `/ws/`,
`/s/` and the frontend's `/`, and asks cert-manager for the certificate;
`qa-tools-api` holds `/api/` and `/mcp`, on the same host and the same TLS
Secret, and names the `Middleware` `qa-tools-api-rate-limit`
(`traefik.ingress.kubernetes.io/router.middlewares`), the edge rate limit of
the rate-limiting paragraph under Infrastructure. Nothing else carries it: not
the frontend's pages, `/ws/`, `/s/` or the receive host's TCP route.
`scripts/chart.test.mjs` renders the template and checks it.

**Order** (D203). Traefik 3.7 makes each path a router whose rule is
``Host(`qa-tools.ru`) && PathPrefix(`<path>`)``, or `Path` for an `Exact` path,
and gives a router with no priority of its own the length of its rule; of the
routers that match a request, the highest priority serves it. So a backend path
wins over the frontend's `/`, 38 characters, only while its rule is longer:
`/api/` is 42, `/ws/` and `/mcp` 41, `/s/` 40. 0.45.0's `Exact` `/mcp` was 35,
and production sent `/mcp` to the frontend's `404` page. No path sets a
priority: Traefik's annotation for one applies to every path of the Ingress.
Traefik ranks the routers of both Ingresses together, and a middleware leaves
a router's priority alone, so the order holds across the two (D264).
`apps/frontend/src/lib/search-engines.test.ts` computes the rules and their
order from the template, with Traefik's `strictPrefixMatching` too, which the
cluster leaves off, and `deployment-smoke` asks production's `/mcp` for the MCP
server's `405`.

**The second site host** (D275), `webhook.qa-tools.ru` in production, has
two Ingresses of its own, rendered when `ingress.aliasHost` is set:
`qa-tools-alias-api` with `/api/` and `/mcp`, behind the edge rate limit as on
the first host, and `qa-tools-alias` with `/ws/`, `/s/` and `/`, the same
paths to the same Services. Both name first the `headers` Middleware
`qa-tools-noindex`, which sets `X-Robots-Tag: noindex` on every HTTP answer of
that host, the backend's and the frontend's, until day X (whether the
WebSocket's `101` carries it is not checked); on Ingresses of their own
because a middleware annotation applies to every router of its Ingress, so
`qa-tools.ru`'s two stay as they were. `qa-tools-alias` asks cert-manager for
the host's certificate, the Secret `webhook-qa-tools-tls`, apart from
`qa-tools-tls`. Its routers are ranked as the first host's: the frontend's `/`
is 46 characters there, `/s/` 48, `/ws/` and `/mcp` 49, `/api/` 50.

**The receive host** (D187) is not on the Ingress. `hook.qa-tools.ru` is an
`IngressRouteTCP` on `websecure` matching `HostSNI(hook.qa-tools.ru)`: Traefik
terminates TLS with a `TLSOption` that offers `http/1.1` alone, and hands the
decrypted bytes to the backend Service's `receive` port, 3001, through a
`ServersTransportTCP` that puts a PROXY protocol v2 header in front of each
connection. A sender's TCP FIN or TLS `close_notify` reaches the backend as a
FIN, which aborts a request not yet answered: such a sender gets no answer, and
a wait for a configured delay is cancelled (D105, D109, D187). Its HTTP layer — header rewriting, path normalisation,
`readTimeout`, `Accept-Encoding` — never sees a webhook. Its certificate is a
cert-manager `Certificate` of its own, into the Secret `hook-qa-tools-tls`,
from the same ClusterIssuer; the HTTP-01 challenge is answered on `web`, where
the entry point's redirect is kept at priority 100 so that cert-manager's
solver route, whose rule is longer, wins. All of it is in
`deploy/helm/qa-tools/templates/receive.yaml`.

Since 0.57.1 the backend counts the connections each sender address has open
to the receive listener, at most `receive.connectionsPerAddress`, 512, passed
as `RECEIVE_CONNECTIONS_PER_ADDRESS` (D227). The count is the PROXY layer's
(`modules/webhook/proxy-protocol.ts`), by `lib/slots.ts`'s
`createKeyedSlots` keyed by `addressKey` of the address the header carries —
an IPv6 address by its `/64`, an IPv4-mapped one as its IPv4: a place is taken
once the header has been read and given back on the socket's `close`, however
it closes, an idle kept-alive connection included. One over the limit is
destroyed right after its header, before Node's HTTP server sees it, and
Traefik then ends the sender's connection with no HTTP answer; the layer logs
only how many it refused, the first at once and the rest at most once a
minute, never an address. The sender's address is the TCP peer Traefik saw
only while its Service keeps `externalTrafficPolicy: Local` (D111, D130), so
`0`, which turns the bound off, must be set before the policy goes back to
`Cluster`, where every sender is `10.42.0.1` (runbook section 7). With
`receive.proxyProtocol: off` nothing is counted. The count is each process's,
twice during a deployment's overlap (D221). The route itself carries no
middleware: an edge cap in Traefik was weighed and dropped, because Traefik
logs each refused connection with its sender's address (D227, D187).

The frontend container's Nginx then decides the status (D146): `200` with
`index.html` for `/` and for `/v/<43 characters of A–Z a–z 0–9 _ ->` with an
optional trailing slash (new ids are letters and digits; older ones may hold
`_` and `-`, D161), `200` with `ru/index.html`, the Russian home page, for
`/ru/` and `/ru` (D226), the file itself for a file that exists, and `404` with
`index.html` as the body for everything else, so the application can render
`Page not found`. Every answer to a session-shaped `/v/` address carries
`X-Robots-Tag: noindex`: that location sets the value before its rewrite, and
the internal `/index.html` location sends it beside `Cache-Control`; every other
address has none (D183). `/robots.txt`, `/sitemap.xml`, `/favicon.ico`,
`/favicon-192.png` and `/logo-512.png`, from `apps/frontend/public/` — the
first two written from it under the build's origins, byte for byte under
production's, the images copied (D274) — are files like any other there. `/assets/`, `/healthz`, `/openapi.json`, `/docs`, `/changelog`, `/changelog.md`, `/changelog.xml`, `/changelog-breaking.xml`, `/about`, `/ru/about`, `/terms`, `/privacy`, `/ru`, `/llms.txt`,
`/llms-full.txt`, `/.well-known/security.txt`, `/qa-tools-relay.mjs` and `/webhook-inspector-relay.mjs` keep their own locations, and a missing asset is a plain `404`. `/webhook-inspector-relay.mjs`, the relay script written from `apps/frontend/public/` under the build's origins, byte for byte under production's (D202, D274, D275), and `/qa-tools-relay.mjs`, the same file under its old name (D279), each answer `text/javascript; charset=utf-8` with `Cache-Control: no-cache`, and a missing file is a plain `404`. `/changelog` and
`/changelog/` are rewritten to `changelog/index.html` exactly as `/docs` is, with
`Cache-Control: no-cache` and no `X-Robots-Tag`, and `/changelog.md` answers
`text/markdown; charset=utf-8` with `Cache-Control: no-cache` like `/llms.txt`
(D184); `/changelog.xml` and `/changelog-breaking.xml` answer
`application/atom+xml; charset=utf-8` the same way, a missing file a plain
`404` (D212). `/about` and `/about/` are rewritten to `about/index.html` the same
way, with `Cache-Control: no-cache` and no `X-Robots-Tag` (D211), `/ru/about` and
`/ru/about/` to `ru/about/index.html`, its Russian twin, whose own location is
internal too, so it is an unknown address by name (D255). `/terms`, `/terms/`,
`/privacy` and `/privacy/` are rewritten likewise to `terms/index.html` and
`privacy/index.html` (D217), and `/ru` and `/ru/` to `ru/index.html`, the
application under its Russian head (D226); nginx matches the decoded,
slash-merged path, so `//ru//` and `/%72u/` are that page too, while `/RU/`,
`/ru/x` and `/ru/index.html` by name are unknown addresses. `/docs` and `/docs/` are
rewritten to `docs/index.html`, the API reference page (D155), whose own
location is internal and sends `Cache-Control: no-cache`; asked for by name,
`/docs/index.html` is an unknown address like `/index.html`. Its Scalar bundle
lives under `/assets/` with the application's, cached for a year by content
hash. The image runs `nginx -t` as it is built. `/openapi.json` is the public
OpenAPI description, written into the build from `packages/shared/openapi.json`
under the image's origins (D274) and answered as `application/json` with
`Cache-Control: no-cache`, never with
`index.html` (D154). `/llms.txt` and `/llms-full.txt`, the agent documentation
written into the build (D165), answer `text/markdown; charset=utf-8` with
`Cache-Control: no-cache`, and a missing one is a plain `404`. `/.well-known/security.txt`,
written into the build as well (D177), answers `text/plain; charset=utf-8`, the
type RFC 9116 asks for, with `Cache-Control: no-cache`; nginx refuses no
dot-directory, and a missing file is a plain `404`. Every answer carrying `index.html` has
`Cache-Control: no-cache`. The session pattern is repeated in `nginx.conf` and
kept in step with `SESSION_ID_PATTERN` by a frontend unit test.

TLS:
- HTTPS/WSS
- Let's Encrypt certificates issued and renewed by cert-manager, solving the
  HTTP-01 challenge through the same Ingress, and for the receive host through
  a `Certificate` of its own (D187)
- plain HTTP is redirected to HTTPS on Traefik's `web` entrypoint, which Traefik
  does not do on its own (D083); the redirect runs at priority 100, below
  cert-manager's challenge routes (D187)

A realtime connection is idle between server pings. Traefik's idle timeout of 180
seconds is well clear of the 30 second interval, so the controller does not close
a live connection (D079). One address may have at most 16 open on a backend
process, counted in the route's `onRequest` before the upgrade by
`lib/slots.ts`'s `createKeyedSlots` keyed by `addressKey(request.ip)`, and
given back on the socket's `close`, or on the reply's when the upgrade never
happens (`modules/realtime/connection-places.ts`); the 17th is answered `429` /
`1020` with `Retry-After: 1` and `Connection: close` through the error handler,
and `@fastify/websocket` ends its socket once the answer is written (D227).

The Ingress sets no request body limit: Traefik streams a body rather than
buffering it, so the application refuses an oversized request itself and every
oversized request receives the documented error (D089).

A request that stops arriving is bounded twice (D172). Traefik reads the whole
request, body included, within its `readTimeout` of 60 s, pinned on both entry
points in `deploy/cluster/traefik-config.yaml`, and gives up on the client after
that. The backend's own `requestTimeout` of 90 s is longer, so behind Traefik's
HTTP routes it never fires; it is the bound on the receive host, whose TCP route
applies no `readTimeout` (D187), and wherever the backend is reached directly,
and answers `408` 90 to 120 s after the request began. It stops counting once the
request has fully arrived, so a configured response delay, pooled keep-alive
connections and WebSockets are unaffected. `connectionTimeout` is left unset.

**The edge rate limit** (1.15.15, #205, D264): in front of the backend, Traefik's `rateLimit` middleware on the API's two paths, `/api/` and `/mcp`, and nothing else ([Ingress routing](#ingress-routing)) — a token bucket per client address Traefik sees, an IPv6 address by its `/64` (`ipStrategy.ipv6Subnet: 64`), refilled at 100 calls a second and holding 6,000 (`ingress.apiRateLimit` in the chart's values). Past it Traefik answers `429` itself, `Too Many Requests` with `Retry-After` and `X-Retry-In` and no `X-RateLimit-*` or `errorCode`, and the call never reaches Node, so a flood from one address costs the backend at most a burst and then 100 calls a second, refused by Traefik, which has no CPU limit. The numbers are far above what the backend's own limits below let one address through — at most 5,040 calls within seconds and 42 a second, counting a window's edge and a deployment's two processes — so no client within them meets the edge, and the backend's `429` / `1015` with its headers stays the answer such a client sees. Traefik builds the middleware for each router, so `/api/` and `/mcp` each keep a bucket of their own per address; and it forgets an address idle for about 2 s, which then has its whole burst again, so a sender that pauses between bursts gets most of them through (measured with 3 s pauses: 81 % reached the backend, D264) — the edge holds a continuous flood, the incident's shape, and the liveness probe below keeps a pulsed one from restarting the backend. The address is the TCP peer Traefik sees, the sender's own only while its Service keeps `externalTrafficPolicy: Local` (D111): `average: 0` turns the limit off, and is set before the policy goes back to `Cluster` (runbook section 7). It writes no log line per refusal at production's level, INFO: measured with a steady flood over connections kept alive, and with floods that reset each connection 0–5 ms after writing to it, pipelined over HTTP/1.1, or cancel each HTTP/2 stream (D264 point 7). Measured locally behind Traefik 3.7.8 at about 1,000 creations a second for 2 minutes, Traefik refused 81–85 % of them, about 150 a second reached the backend, which was never restarted, and another address's calls were all answered and its captures all stored (D264).

Rate limiting exists since 0.43.0, on the application listener alone (D201, amending D039): `POST /api/sessions` 60 times and every other call under `/api` 1200 times per minute per client address, an IPv6 address by its `/64`, in fixed windows counted in the backend's memory (`modules/limits/rate-limit.ts`). The address is `request.ip`, which the trust boundary decides from Traefik's `X-Forwarded-For` (D111, D130); it is a key of the counter and nothing else, never logged or stored because of a limit, and dropped with its window, by the next call or by the counter's timer. And since 1.0.13 a refusal writes no line of the request log (#189, `lib/request-log.ts`): a call either count refuses — `429` / `1015` on the API, and on `/mcp` its `429` or a tool's error naming the limit — writes neither Fastify's `incoming request` nor its `request completed`, nor the `Request aborted by the client` of a client that leaves while its body is drained; a line at `warn` or above would still be written. Fastify writes `incoming request` before any hook, so the line of every call the limits count, on `/api` and `/mcp`, is held from its arrival until its verdict — in the limits' `onRequest` for the API, and for `/mcp` once its body has said which count it goes to — and written as soon as the call is let through, or before any other line of it, its `request completed` among them; the router's own refusals, which no hook sees, write theirs at once. So the line's `time` is when it is written, not when the call arrived: a call of the API's is let through in `onRequest`, at once, and an `/mcp` call once its body has arrived and its count has let it through, up to the backend's `requestTimeout` after its arrival — 90 s, enforced between 90 and 120 s, and cut at 60 s by Traefik's `readTimeout` in production (D172); the `responseTime` of its `request completed` counts from the arrival either way, and a call held by `wait` is in the log while it waits (#222). Every other answer is logged as before, with the same fields and redaction: a call let through, a `1017`, a `1019`, a `5xx`, and an answer `/mcp` gives for another reason — a `405`, a `406`, a foreign `Origin` — to a call whose count it then found over. One address sending session creations far over its limit took the backend's 0.5 CPU and its liveness probe with it on 2026-10-15, two lines a refusal; the lines were measured at about a tenth of what a refusal costs, and the backend alone at production's limits answered `/healthz` within 1 s under 1,000 refused creations a second, before and after (D201's note). The count is each process's: with one backend process it is the service's, and a new process starts with none; for the seconds of each deployment's overlap, since 0.54.1, two processes count apart, and an address may get up to twice its limit (#132, Decision 2; D221), and the per-process places below are twice as many. The hook runs on `onRequest`, before the body is read and before any database work, and the route is told by the route the router matched, not by the URL as written. Since 0.45.0 `/mcp` shares the two counters (D203): `registerRateLimits` answers them, and the MCP route counts each request once its body has said which limit it counts toward and the transport's checks have let it through — a `create_session` call the creations, anything else the other calls — and a request refused before that count, by Fastify or by those checks, toward the other calls as it is answered. The receive listener, `/ws`, the probes and everything outside `/api` and `/mcp` are never counted per minute. Beside it, at most four list answers with bodies are written at once per process, across the list and the query (`modules/requests/body-lists.ts`): a place is taken before the list statement and given back when the answer's stream closes or its response does, whichever comes first, the response from the moment the place is taken; a call held by `wait` takes one only once it has requests to write. Since 0.52.1 an address has at most 128 calls in flight at once on `/api` and `/mcp` together, waits included (D213, `modules/limits/calls-in-flight.ts`, counted per key by `lib/slots.ts`'s `createKeyedSlots`): `registerRateLimits`' `onRequest` takes the place after a call is counted and let through, and for `/mcp` before its body, giving it back at once if `/mcp`'s count then refuses it; an `onRoute` hook registered with the counters wraps every handler of `/api` and `/mcp`, so the place is held by the connection until the answer's response closes and by the handler until it settles, in D205's shape, and given back once, the address's entry deleted with its last place. The 129th is `429` / `1019`, answered at once. A refusal whose body is drained on a connection Node is about to close (D143) holds a place for as long as the drain lasts — a `1017` keeps the one it took, a `1015` takes one for it — since the drain keeps the request until its client has sent the body; one that cannot hold a place, the 129th and a `1015` while the address has all 128, is answered at once, undrained, and its answer may then be lost to a reset on a client still sending, as D143 accepts for the bodies it does not drain. Every answer written while its request's body is still arriving — Node's `complete` `false` with a body framed, looked at again a turn of the event loop later so that the rest of what arrived with the headers is read — carries `Connection: close`, so that Node ends the connection and does not keep the request for the rest of its body after its place has gone back (`isBodyArriving`, D213 point 5): since 0.57.1 on every answer of both listeners, set in `createApp`'s `onSend` (`server.ts`), where it was `registerRateLimits`' and ended only those of `/api` and `/mcp` before, and by the receiver for its own reply to a capture, which a `GET`, `HEAD` or `TRACE` can get while its declared body is still arriving, Fastify reading none of it (`webhook/routes.ts`); an upgrade request the application listener answers rather than upgrades carries it whatever its body, and `createApp`'s `onResponse` ends its socket, which Node no longer reads; and the router's own `400` and `414`, written before any hook, follow the same rule through `frameworkErrors` (`writeRouterRefusal`), still in Fastify's shape and with none of the hooks' headers, but look only once, as they are written, before any of the body is parsed, so that they close the connection of a request that frames a body even when it came whole with the head (D227, `answer-before-body.test.ts`). A path or a method no route has is answered `404` / `1000` in `createApp`'s `preParsing` hook, after every `onRequest` — so that an `/api` path no route has is still counted and holds its place — and before Fastify chooses a parser, so that it reads no body on either listener, whatever its method, media type or framing, where the not-found route had read one declared JSON or text before it answered; Fastify's own refusals on the headers alone, a `QUERY` without content and a `Content-Type` that is not a media type, keep their `400` / `1008` and `415` / `1007` (D227 point 4). `complete` means read whole by the server, not sent whole: an answer before the body leaves it unread and Node stops reading past its buffer, so a body over about 100 KB answered before it is read ends its connection even when sent whole, a `1017` framed by `Content-Length` always. A place on a connection Node has stopped reading — hundreds of calls pipelined unanswered behind a wait — comes back only once Node sees the connection go, at the latest when the first answer is written (D213 point 3). Since 1.0.8 the answers of those calls are bounded by their bytes as well (#184, D228's amendment; `modules/limits/answer-budget.ts`): an `onSend` hook `registerRateLimits` adds after its own counts each answer of a call that takes a place — its body as serialized, a string or bytes — under the same address key, from that moment until the answer's response closes, the same `close` that gives the call's place back, 16 MiB an address and 64 MiB the process (`API_ANSWER_PER_ADDRESS_BYTES`, `API_ANSWER_BYTES`); one that would pass either while its address already has another answer counted is thrown out of the hook as `answersNotWritten`, `429` / `1019` with `Retry-After: 1`, which the route's own error handler answers — the API's error body, or `/mcp`'s JSON-RPC error under the request's id — and whose answer passes the hook again, counted and never refused, as every answer with an error status is. The address's first answer is always sent, and an answer counted goes on to the connection as its UTF-8 bytes, which the socket keeps as they are while it waits, where it keeps a string it cannot take at once as a copy of three bytes a character — about 170 MiB behind 56 MiB counted, measured. A `HEAD`, a streamed list or query with `include` and an empty body count nothing; an answer counted and then replaced by a later hook's failure gives its bytes back as its replacement is counted. The places bound how many calls an address holds, the budget what their answers weigh while unwritten: before it, 128 answers of about 1 MiB from each of two addresses, their clients reading only the heads, killed the backend for memory (D228's S8). The application listener also sets `server.maxHeadersCount` to 100, which Node enforces with `431` before any route; the receive listener sets 0. The seven routes that read a JSON body — `PUT /api/sessions/:sessionId/rules` the seventh since 1.3.0 (D246) — share D205's eight places of large bodies with `POST /mcp` and take their body off the request once parsed (`readJsonBody`), in a `preHandler` since 1.15.7, before the gate below (`jsonBody`). The routes that take no body — the four deletions and the queue's restart — use the root instance's parsers, which read at most 1 KiB of one, check it by D104's rules and give the route nothing (`lib/ignored-body.ts`, D213 point 7), where Fastify's defaults read up to 1 MiB and the route kept what they parsed; the not-found route used them too until 0.57.1, and reads no body since (D227 point 4). Since 0.57.1 the connections an address holds are bounded as well (D227): 512 open at once to the receive host, counted by the receive listener's PROXY layer (the receive host, above), and 16 realtime connections an address on a backend process, counted before the upgrade (the paragraph on idle realtime connections, above). Since 1.15.7 the work of `/api` and `/mcp` is bounded across every address too (D244, `modules/limits/api-work.ts`, counted by `lib/slots.ts`'s `createWaitingSlots`): at most three handlers work at once in the process; the next waits for a slot, never refused, the waiting served round robin by address and in order within one. A call takes its slot inside its place among the calls in flight, once its body is read, and gives it back once its answer begins (`onSend`) or its handler settles having answered by itself (a hijack); a call whose client goes while it waits runs nothing, and a handler working for a client gone keeps its slot until it settles. A `wait` holds a slot for each read and none while it waits. A read a call started keeps the slot until it settles, whatever ends the call meanwhile: a wait's read under way when its client leaves, a clear or the session's deletion ends the wait, and a read of a streamed answer whose response closes. A call that changes a session — its response, queue or rules, or a clear, on the API or over `/mcp` — gives its slot back before it joins the session's line (`RealtimeHub.inOrder`, D205) and runs its turn without one (`inSessionLine`): it waits there behind the session's captures, which can take as long as a burst of webhooks to that session, and holding a slot meanwhile let three such calls stall every other call of the API; a turn that waited for a slot would hold the session's captures behind it for the API's other work. The line, one call of a session at a time, the calls in flight and the API's pool bound those turns. So a flooding address's calls stay in flight longer and meet its `1019` sooner. CAPTCHA, quotas per session or account, and bursts of webhooks from many addresses remain deferred; the waiting line's memory, the refused bodies' drains and the measured number of attacking addresses the backend survives are D228's (the capture budget, above).

## Git and CI/CD
Platform:
- GitLab

Use:
- GitLab repository `qa-tools-team/webhook-inspector`, holding Webhook
  Inspector alone since it moved out of `qa-tools` at 1.19.5 (#326); the
  QA Tools platform, the delivery process and the decision log stay there
- GitLab CI, with nothing included from another project
- GitLab Container Registry
- automatic production deployment after merge to `main`

Use immutable image tags such as commit SHA.

### Pipeline
`.gitlab-ci.yml` has four stages: `validate`, `build`, `deploy` and
`verify-deployment`. Merge request pipelines and `main` pipelines are the only
ones that run at all, so a branch without a merge request does not validate
the same commits twice.

`validate` runs lint and formatting, type checking, the backend and frontend
suites against a PostgreSQL service built from the same image production runs
(D073, D084), the `check:native-ts` resolution check on a deliberately clean
install (D051), the `e2e` browser smoke suite, the chart's checks with the real
helm, and the delivery
checks: `check-version`, `check-api-breaking` and the quick script tests in
`delivery-checks`, and the slow script tests in `operations-tests`. A merge
request pipeline runs that group only when the merge request changes a path
its rule lists, what its tests read, which the job checks by recording it
(D241). Among the quick ones, since 1.19.11 (#375),
`scripts/private-names.test.mjs` fails when a tracked file outside
`CHANGELOG.md` names a file of the QA Tools project that is not published,
or production's CI runner or hosting provider, naming the file, the line and
the name; its allow-list holds `.gitignore`'s entries, the check's own list,
the changelog check's test of a private path it refuses and, until the owner
decides otherwise, the operator's own texts and the build check that refuses
those names, and an entry that allows nothing fails it too. The `chart` job
runs `helm lint` and, since 1.19.10 (#367), renders
the chart with the real helm as an installer with none of production's values
would: with made-up hosts and registry alone the render must name nothing of
production's or its services and hold neither the monitor, the backup's
notifier nor its off-server uploader; without the hosts helm must refuse,
naming them; and with a bucket and a heartbeat URL the three must render. It
also fails if the database
image tag in the pipeline and in the chart have drifted apart, because the
suite would otherwise prove `pg_cron` against an image production does not use.

These jobs live in `.gitlab/ci/validate.yml`, which a merge request pipeline
includes. A `main` pipeline validates a commit once at most (D241): its
`main-validation-gate` job proves through GitLab's API, with the job's own
`CI_JOB_TOKEN`, that the merge request this merge commit merges passed its
pipeline on the same tree from the same base, after the previous `main`
pipeline passed, and the trigger job `main-validation` then runs a child
pipeline holding only a proof job. Without that proof — a direct push, a tree
that differs because `main` moved, an API answer that is missing or refused —
the child pipeline is the whole validate stage, every group of script tests
included, as before. `main-validation` mirrors the child pipeline's status.

The `e2e` job drives Chromium through three journeys, the API reference check
(D155), the cross-tab read state check (D156), the detail panel's error
state check (D169), the receiver's sandbox check (D179) and the request list
filter check (D180, D191) against a backend and a
frontend it starts itself, on a PostgreSQL service of its own holding the
separate `webhook_inspector_e2e` database (D108). No job in the pipeline declares
`needs:`, so `build` and `deploy` wait for every job in `validate`: a failing
smoke blocks the image build and the deployment through stage ordering alone,
with nothing in `deploy` referring to it. On `main` that job is
`main-validation`, which passes only when the child pipeline's smoke suite
passed or the proof showed that the merge request's own pipeline, which ran
it on the same tree, passed (D241).

`build` builds the frontend and backend images. A merge request builds them
without pushing, which catches a Dockerfile that breaks while every test passes
(D094). Only `main` pushes, tagged with the commit SHA. The frontend's production
build happens inside its image build rather than in a job of its own, and the
backend has no build step at all (D051).

The database image is built by the same stage, but only when
`deploy/postgres/**` changes, and it is pushed under the tag the chart pins as
well as under the commit SHA, so the tag production pulls is produced by the
pipeline rather than by hand (D084). That named tag is never repointed: a build
finds it absent and creates it, finds this same image behind it and succeeds
without touching it, or finds a different image and fails asking for the bump.

Because two builds of one Dockerfile do not produce one image, a SHA tag already
in the registry is pulled and reused instead of built again, so rerunning a
pipeline for the same commit publishes the same bytes it published the first
time rather than quietly replacing them.

`deploy` runs `helm upgrade --install` with that same SHA and explicitly sets
`images.registry` from `CI_REGISTRY_IMAGE`, the same project registry used by the
build jobs. This works in both the personal and group namespace; the command
fails before invoking Helm if that variable is empty or unset. The chart has
no registry default since 1.19.10 (#367): a manual upgrade passes
`images.registry` too, and the render is refused without it. Registry contents, pull access and existing Helm
revisions require the separate transfer procedure, kept with the operations outside this repository.
The deploy job is the only job that
runs on the runner inside the production server, because the cluster API is not
reachable from anywhere else (D092), and it authenticates as a ServiceAccount
scoped to the application namespace rather than with administrative credentials
(D093). Its kubeconfig variable is scoped to the `production` environment, which
no other job declares, so no other job receives it (D258). The deploy job is
also the only job that declares itself not interruptible: deployments are
serialised by a resource group, but a helm client cancelled part-way through an
upgrade leaves the release needing manual repair before the next one can run,
and the delivery lock relies on a deployment that runs to its end (D216). Every
other job takes `interruptible: true` from the `default:` of its file, but the
proof job does not: it prints one line in a child pipeline that holds no
`default:`, so it is not interruptible, GitLab's own default. A test of the
pipeline files fails when
`deploy` loses `interruptible: false` or another job declares it (#370). The validate
stage, the gate on `main`, the proof job and the image builds run on the
project's own CI runner, on a server of its own that holds nothing else: every
one takes its runner tag from `QA_TOOLS_RUNNER_TAG`, GitLab's shared runners
by default since 1.19.10 (#367), which production's project CI/CD variable of
that name points at its own runner and can point back at the shared runners
as the fallback, the child pipeline on `main` included, since the trigger job
does not pass that variable on (D258). The deploy job's runner is the project
variable `DEPLOY_RUNNER_TAG`. A tag that expands to nothing is dropped, and an
untagged job may go to GitLab's shared runners, so `deploy` and the smoke after
it are created only when the variable holds one runner tag, letters, digits,
`.`, `_` and `-`; otherwise the job `deploy-runner-tag` fails the `main`
pipeline in `.pre`, before anything is built, naming the variable, and
`scripts/ci-runners.test.mjs` holds that no value creates `deploy` without its
runner's tag (#367). The
validate stage's two heavy jobs, `test` and `e2e`, take turns through a
resource group of their own, `heavy-tests-$QA_TOOLS_RUNNER_TAG`, across every
pipeline of the project, so the two never share that server's CPU and the
other jobs take its second place (#266, D258's amendment). The smoke after a
deployment runs on GitLab's shared runners, from outside.

## Repository structure
```text
webhook-inspector/
├── apps/
│   ├── frontend/
│   └── backend/
├── packages/
│   └── shared/
├── e2e/
├── deploy/
│   ├── cluster/
│   ├── helm/
│   │   └── qa-tools/
│   └── postgres/
├── docs/
├── scripts/
├── .gitlab/
│   └── ci/
│       └── validate.yml
├── .gitlab-ci.yml
├── CHANGELOG.md
├── VERSION
├── package.json
└── README.md
```

`packages/shared` may contain shared TypeScript contracts/types used by frontend and backend, including API error codes and WebSocket DTOs.

The chart keeps its name, `qa-tools`, as do the release, the namespace and the database it deploys: renaming them is a change of production of its own (#335).

## Testing
v0.1 deliberately avoids a large testing effort.

Behaviour that a merge request claims to have verified is covered by a test in the same change (D061), so the claim keeps holding after later work. These tests run through Fastify's request injection against the local PostgreSQL, exercising real routing, handlers and SQL without opening a port.

Required direction:
- backend unit tests for meaningful business logic

Important candidates:
- session creation defaults
- expiration checks
- request limit of 1000
- 1 MB payload behavior
- individual deletion
- clearing requests
- deleting a whole session (D198)
- the status read, which uses no session (D199)

Frontend unit/E2E coverage is not a v0.1 priority, with one exception added
after the MVP: three browser journeys — capture, the configured response, and
`Delete all` — and checks of the API reference page's rendering and network
traffic (D155), of read state across tabs (D156), of the detail panel's
error state (D169), of the receiver's sandbox (D179), of the request list
filter (D180, D191) and of the home page's list of sessions (D199) run in CI against a real browser, backend and database, and must
pass before an image is built or deployed (D108). They are the whole of the
project's end-to-end coverage and are described in
`docs/testing/browser-smoke.md`. Components are unit-tested only where a
change needed it: since 1.19.3 (#346) the move banner and the arrival toast
are rendered in the frontend suite, through `src/testing/render-in-node.ts`,
which compiles `.tsx` for the test with TypeScript and gives `react-dom/client`
a fake window, document and navigator, no browser, holding only what React,
the router, `main.tsx` and the tests use (#366). Its navigator is an English
browser's, `languages` `['en-US']` as the browser suite's locale, so a page
it starts draws the same text whatever the machine's locale; Node's own
`navigator` follows the machine's (`src/testing/render-in-node.test.ts`
starts one under `ru_RU.UTF-8`). Nothing anywhere asserts layout or
appearance.
