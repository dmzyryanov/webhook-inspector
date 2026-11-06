# Webhook Inspector — Product Specification

This document specifies Webhook Inspector as its users meet it: what it does and for whom, every page and address of the site, what a session keeps and for how long, the limits, and what each screen shows and says. The HTTP API's contract is [API.md](API.md), and how the system is built and deployed is [ARCHITECTURE.md](ARCHITECTURE.md).

Webhook Inspector gives a QA engineer or a developer a temporary URL that captures every HTTP request sent to it and shows each one in the browser as it arrives, with its headers, its body and its raw bytes. There is no registration: one click creates a session, kept by default for 7 days after its last use and holding its newest 1000 requests, which answers each webhook with the default response, a configured one, a queue of responses or response rules. Scripts and CI reach the same sessions through the API, AI agents through an MCP server, and a relay script forwards captured requests to a service on the tester's own machine. The interface is desktop-first, usable on tablets and phones, and reads in English or Russian.

Main sections:
- [Product](#product), [Product principles](#product-principles) and [Explicitly deferred](#explicitly-deferred) — what it is, the rules it keeps, and what it leaves for later.
- [Landing page](#landing-page), [URLs](#urls) and [Language](#language) — the home page, every address the site answers, and the two languages.
- [Session lifecycle](#session-lifecycle), [Private sessions](#private-sessions), [Request capture](#request-capture), [Request retention](#request-retention) and [Limits](#limits) — what a session is, what it captures and keeps, and what one address may do.
- [Webhook Inspector UI](#webhook-inspector-ui), with [The response queue](#the-response-queue) and [The response rules](#the-response-rules), [Realtime behavior](#realtime-behavior) and [Time display](#time-display) — the session page.
- [Forwarding to a local service](#forwarding-to-a-local-service) — the relay script.
- [Branding](#branding), [Status page](#status-page), [Footer](#footer), [Changelog](#changelog), [About page](#about-page), [Terms of Use and Privacy Policy](#terms-of-use-and-privacy-policy) and [Visual direction](#visual-direction) — the site around the inspector.
- [Moving to webhook.qa-tools.ru](#moving-to-webhookqa-toolsru) — the move to the new address.
- [MVP completion scenario](#mvp-completion-scenario) — the first version's end-to-end check.

## Product
**Name:** Webhook Inspector, a service of the QA Tools platform: since v1.18.0 its interface, tab titles, `/docs`, the changelog, `llms.txt` and the API description's title name it so, and QA Tools stays the platform's and the operator's name (issue #322, D277)  
**Domain:** `qa-tools.ru`; Webhook Inspector also answers on `webhook.qa-tools.ru` since v1.16.0, the same site closed to search, and moves there on day X, the date the changelog's 1.16.0 entry gives, when `qa-tools.ru` becomes the QA Tools platform's main page (#319, D275); since v1.17.0 a banner on the old address carries a browser's sessions there ([Moving to webhook.qa-tools.ru](#moving-to-webhookqa-toolsru), #321, D276)  
**Version:** the one in `VERSION`, each version's changes in [`CHANGELOG.md`](../CHANGELOG.md); the specification began with v0.1, the version some sections below still name  
**Initial tool:** Webhook Inspector

Webhook Inspector is the QA Tools service for QA engineers and developers who test webhooks: generate a temporary URL and inspect incoming HTTP requests in real time. It is designed for the desktop first and usable on tablets and phones. The first version lets a user instantly generate a temporary HTTP endpoint, send requests to it, and inspect incoming requests in a browser in real time.

**The platform's main page.** `qa-tools.ru` is to become the QA Tools platform's main page (D275): what QA Tools is, and every service as a card with its name, description and address, `Open ↗`, `Status ↗` for its status page and `GitHub ↗` once its repository is published; a service still to come is a dashed card marked `Coming soon` that links nothing. English at `/`, Russian at `/ru/`, with no script, no cookie and no request to another host. It is built in the platform's own repository, apart from Webhook Inspector (#317, D280), and served once the platform has a server of its own (#329, #331); today it shows Webhook Inspector and HTTP Mirror, still to come.

## Branding

The header carries the **Webhook Inspector** wordmark on the left — the
service's own name since v1.18.0, in place of `QA Tools` (issue #322, D277) —
and, on the right, `Changelog`, `Status ↗` and a link to the API reference,
`API docs ↗`, a thin divider between each pair (v0.49.0, issue #99, D209;
v0.33.0, issue #97, D184, which amends v0.20.0's header of D158: the name of
the active tool, `Webhook Inspector`, and its divider left the header; the name
came back as the wordmark itself, with no divider). The wordmark is 17 px Semi
Bold on one line from 768 px and stands on two lines, `Webhook` over
`Inspector`, 15 px on 17 px lines, from 375 to 767 px; the header stays 64 px
high from 1024 px and 56 px below, the two lines included (direction A of the
Figma page `Webhook Inspector · Header name (#322)`). The links are 16 px apart
from 768 px and 12 px below. The product mark is shipped as the browser-tab icon;
on a white square it is also the icon a search engine shows beside the site,
`/favicon.ico`, and the image of a link preview (v0.32.0, issue #69, D183).
In the page layout it appears only below 375 px, where the 24 px Q mark takes
the wordmark's place so that the three links fit (D096 as amended by D209).
The wordmark, or the mark, is a link to the landing page on every screen that
uses the header — to the Russian home page, `/ru/`, while the interface is in
Russian (v0.57.0, issue #109, D226) — named `Webhook Inspector` at every width,
reachable with the mouse and the keyboard; following it creates no session and
deletes none (D107).
`Changelog` opens `/changelog` in the same tab; on `/changelog` itself it is
drawn in ink as the current page and carries `aria-current="page"`. `Status ↗`
opens the public status page, `https://status.qa-tools.ru/`, in a new tab; its
accessible name is `Status (opens in a new tab)` (see
[Status page](#status-page)). `API docs ↗` opens `/docs` in a new tab, so an
open session page stays where it was; its accessible name is `API docs (opens
in a new tab)`. Every page uses this header: the landing page, the session
page, `Session not found`, `Page not found`, `Something went wrong`,
`/changelog` and `/about`, which draw the same header in their own HTML, with
nothing added for `/about`; `/ru/about` draws it in Russian, `Изменения |
Статус ↗ | API docs ↗`, its wordmark leading to `/ru/` (v1.13.0, issue #170,
D255). Every width shows
all three links, both dividers and both arrows, a phone included; no page
scrolls sideways at 320 px. `Changelog` and `Status ↗` are this site's
operator's (see [Status page](#status-page)): a copy built without the
settings draws neither, nor the divider after each, and its header reads
`API docs ↗` alone (v1.19.20, issue #396, for `Changelog`).

## Status page

Since v0.49.0 (issue #99, D209), `https://status.qa-tools.ru/` is a public
status page: whether the site (`Website`), the API (`API`) and webhook
receiving (`Webhook receiving`) are up, each checked every minute from
outside, with 60 days of uptime history and reports of outages users could
notice, so a team whose CI test failed can tell an outage of QA Tools from a
failure of its own system. It is Statuser's page, with our logo; its own text
is Russian and cannot be switched, and it carries "Powered by Statuser". A
report is published only for an outage longer than 5 minutes. The header of
every page links to it, `https://qa-tools.ru/status` redirects to it with a
`301`, and `/docs`, `llms-full.txt`, `llms.txt` and `docs/API.md` name it.
There is no footer link to it and no status dot or colour on our pages: the
link does not know the status.

Since 1.19.6 (issue #369) the status page, the contact address, the Terms of
Use with the Privacy Policy and the about pages' lines on who runs the service
are settings of the frontend build — `STATUS_PAGE_URL`, `CONTACT_EMAIL` and
`OPERATOR_TEXTS` (README, Installing on k3s with the chart). This site's
build sets all three, so everything this document says of them holds here. A
copy of the inspector built without them shows none of them: no `Status ↗`,
no `Contact:` and no `Terms` or `Privacy` in the footer, no `security.txt`,
and `/status`, `/terms` and `/privacy` are `Page not found`. Since 1.19.20
(issue #396) `OPERATOR_TEXTS` also covers the [changelog](#changelog), which
tells this site's releases, and the [footer](#footer)'s clause on backups,
which states this site's backup period: such a copy has no `Changelog` in
the header and no changelog at its four addresses, and its footer line ends
after the session's 7 days. Since 1.19.21 (issue #386) it also covers the
API reference's network section (see [URLs](#urls)), which gives this site's
server address, its port and its notice of a new address: such a copy's
`/docs`, `/openapi.json` and `llms-full.txt` have no network section, nor the
stability policy's sentence pointing at it. A copy built with the texts and
no second address keeps the section but leaves out its bullet on the move to
`webhook.qa-tools.ru`, which there would name one address on both sides.

## Footer

Every page that carries the header closes with a footer band that says what
the site stores, for how long, and where to write (v0.27.0, issue #88, D177; Figma page
`Webhook Inspector · Privacy footer`, direction A), with a link to the
[About page](#about-page) since v0.50.0 (issue #131, D211) and to the
[Terms of Use and the Privacy Policy](#terms-of-use-and-privacy-policy) since
v0.52.0 (issue #112, D217; frames F1–F3):

```text
Captured requests — headers, body and the sender's IP — are kept until you delete them or the session expires, at most 7 days unused; backups keep them up to 3 days longer. About · Terms · Privacy · Contact: contact@qa-tools.ru
```

In Russian the line reads `Запросы — заголовки, тело и IP отправителя —
хранятся, пока вы их не удалите или сессия не истечёт (до 7 дней простоя); в
копиях — ещё до 3 дней.` Until v1.15.16 it said `… or the session goes unused
for 7 days; nightly backups keep them …` (`… или сессия 7 дней не
используется; в ночных копиях …`), which a session created to expire sooner
made untrue; the owner's words of 2026-10-25 name 7 days as the most a session
lives unused, and drop `nightly` so that the line keeps its height on the
desktop (issue #274, D265).

The clause on backups is this site's: its 3 days are the backup period of
this site's install, which a copy run with `npm run dev` does not have and a
copy installed with another `backup.keep` does not keep. A copy built without
`OPERATOR_TEXTS` (see [Status page](#status-page)) ends the line after the
session's 7 days, `Captured requests — headers, body and the sender's IP —
are kept until you delete them or the session expires, at most 7 days
unused.`, in Russian `Запросы — заголовки, тело и IP отправителя — хранятся,
пока вы их не удалите или сессия не истечёт (до 7 дней простоя).`, the same
words cut at the semicolon, in the application's band, the static pages and
`/ru/about` (v1.19.20, issue #396). This site's line is unchanged.

The address is a `mailto:` link, and `About`, `Terms` and `Privacy` links to
`/about`, `/terms` and `/privacy` in the same tab. `7 days` and `3 days` never
break across a line; `About · Terms · Privacy · Contact: contact@qa-tools.ru`
stays whole on one line wherever it fits, and where it does not, below about
345 px, it breaks only after a dot, so no link is on a line of its own and the
address never breaks. The band is white under a thin line, 12 px text in the
muted ink with the links Medium in ink and the address in the link blue, and
the header's side margins. On the desktop the line is on the left and the
links and the contact on the right, 16 px apart and without the dots, on one
34 px line from about 1,410 px wide; a narrower desktop wraps the line and
keeps the right side whole. Below 1024 px the links and the contact end the
paragraph: two lines on a tablet, five on a 375 px phone (four until
v1.15.16, whose words take a line more there, D265), six at 320 px. On
`/about`, `/terms` and `/privacy` the footer marks that page's link as the
current page. In the Russian interface the band reads `О сервисе · Условия ·
Конфиденциальность · Почта:` and `О сервисе` opens the Russian about page,
`/ru/about`, whose own band is the same Russian one with `О сервисе` as its
current page; `Условия` and `Конфиденциальность` open the English pages until
their Russian versions are delivered (v1.13.0, issue #170, D255).
The band sits at the bottom of the window while the page is shorter than it
and after the content when the page scrolls, so on a phone it is reached at
the end of the page. A request opened on a tablet or a phone is shown without
the band; the list it returns to has it. `/docs` has no band and shows the same
address as its contact.

The line states the rules the product keeps: what a request stores (see
[Request capture](#request-capture)), a session's expiry, at most 7 days from
last use and sooner for a session created with a shorter idle window or a
lifetime (see [Session lifecycle](#session-lifecycle)), the rows `Delete` and
`Delete all` remove at once, and the nightly backups, which keep deleted or
expired data for up to 3 days (D176). Since 0.36.2 the nightly backups include an encrypted copy of
each night's dump kept off the server, in an S3-compatible bucket in Russia,
with the same retention: the 3 newest copies, the older ones deleted by the
same nightly run. A copy is encrypted before it leaves the server, to a key
whose private half only the owner holds, so neither the storage provider nor
the server itself can read it (D190). The line did not change for it: it does
not say where backups are kept, and `up to 3 days` holds for both places. It
says nothing about the server's logs or the usage views.

## Changelog

What changed in each version is public (v0.33.0, issue #97, D184), at
`https://qa-tools.ru/changelog` for people and `https://qa-tools.ru/changelog.md`
for scripts and agents, both generated from the repository's `CHANGELOG.md` at
every release. Every version since 0.5.0 is listed newest first, each under the
UTC day it reached production and opening with a one-sentence headline in
bold. A change that can break an API client carries a paragraph that starts
**Breaking:**; which changes count is written in the header of `CHANGELOG.md`
(a request that used to succeed now fails or is answered differently; a field
of an answer or of a WebSocket event is removed or changes type or meaning; an
`errorCode` or status changes for the same request; a limit becomes stricter),
and entries are marked from 0.16.0, the version that published the API.
Entries before 1.0.0 marked a breaking change with no fixed notice period and
no support period for an old version: the mark was the notice. Entries are
written for the public: no issue or decision number, repository path or
infrastructure name is published.

The changelog tells this site's releases, for its readers — its hosts, its
moves, how its owner is alerted — so it is this site's operator's text
(v1.19.20, issue #396): a copy built without `OPERATOR_TEXTS` (see
[Status page](#status-page)) publishes no `/changelog`, `/changelog.md` or
feed, each address answering `Page not found`, and links none of them — not
the header, the sitemap, `/llms.txt`, the head of `/docs` or the API
reference, whose sentence naming the feeds it leaves out and whose other
sentences keep their words without the link. `CHANGELOG.md` stays in the
repository, which is where a copy's operator reads what changed.

Since 1.0.0 (2026-10-14, D233) the API is under the stability policy published
with v0.51.0 (issue #133, D212), in the same words in `/docs`'s Stability
section, the public header of `/changelog.md` and the API contract: the paths
stay `/api/…` and are version 1, with no `/v1` prefix; additions ship at once,
and from 2026-11-24 so does a new value of an enum in an answer or an event,
such as a response's `state`, which a client accepts even when it does not know it (issue
#159, D248); a breaking change to a stable part ships beside the old, which is
deprecated with a removal date at least 30 days ahead, or, when the two cannot
sit side by side, is announced at least 30 days before it ships; a change needed for
security, against abuse or overload, or to recover from an outage may ship at
once, with the reason; and the MCP server is experimental. The policy binds
the HTTP API, the webhook URLs and what they answer, the MCP server and the
relay script; the interface stays free. A deprecation is a paragraph that
starts **Deprecated:**, naming what is deprecated, its replacement and its
removal date; the first announces, 30 days and more ahead, that new values of
those enums ship at once from that date (D248).

A change to the Terms of Use or the Privacy Policy that must be announced 14
days ahead (v0.56.0, issue #163, D224; see
[Terms of Use and Privacy Policy](#terms-of-use-and-privacy-policy)) is
announced by an entry with a paragraph that starts **Notice:**, naming the
change and the day it applies, which the changelog treats as a Deprecated
paragraph; the first, in v1.0.11 (issue #214), announces the server log's
line naming an address that floods far over the limits, and the second, in
v1.15.14 (issue #275), that mail to the contact address moves from Apple
iCloud Mail to Yandex 360, in Russia.

Two Atom feeds carry the changelog to a feed reader, Slack or a Telegram bot
(D212): `https://qa-tools.ru/changelog.xml`, every version, and
`https://qa-tools.ru/changelog-breaking.xml`, only the versions with a
Breaking, a Deprecated or a Notice paragraph — one entry per version, newest
first, each linking to its line on the page.

The page (Figma page `Webhook Inspector · Changelog`, row C′) has the title
`Changelog`, a lead, a link to `/changelog.md`, a line naming the two feeds
(D212), the filter chips `All versions`
(selected on arrival) and `Breaking only`, and `Expand all` on the right, which
reads `Collapse all` while every line is open. Versions are grouped by day,
each day with its date and its number of versions — on a rail at the left on
the desktop and a tablet, as a grey band above the day on a phone. Each version
is one line: its number, its headline, a `Breaking` label when its entry has a
Breaking paragraph (`Deprecated` when it has a Deprecated one and no Breaking
one, D212, and `Notice` when it has only a Notice one, D224), and a chevron; a
line opens to the rest of its entry, a Breaking, Deprecated or Notice
paragraph drawn with a red edge. The newest version is open on arrival.
`Breaking only` hides every version without a Breaking, Deprecated or Notice
paragraph and every day left empty. Without JavaScript every line still opens, and the
filter and `Expand all` are not shown. The footer band ends the page. The page
loads nothing from another site.

## About page

Since v0.50.0 (issue #131, D211), `https://qa-tools.ru/about` says who runs
QA Tools, how it is made, who pays for it and what happens to the data people
send, for a visitor — a company's tester or security reviewer among them —
deciding whether to send it their traffic (Figma page `Webhook Inspector ·
About page (#131)`, direction D1). Every page links to it as `About` in the
footer band; the header is unchanged. The page is static: it reads in full
without JavaScript and loads nothing from another site.

Under the eyebrow `ABOUT QA TOOLS` and the title `Made by a tester, for
testers`, a story of three paragraphs in the owner's words: a software tester
building tools for testers, as a personal and research project; written by AI
agents and made for them too, through the MCP server
`https://qa-tools.ru/mcp`, shown and not linked; and glad of users and of what
they think, at `contact@qa-tools.ru`, a mail link. Then four facts, a label
and its lines, drawn as the home page's `How it works` rows:

- **How it's built** — written entirely by AI agents, Claude Code writing,
  testing and reviewing the code; the owner decides what to build and approves
  every design, drawn in Figma first; TypeScript, React and Fastify,
  PostgreSQL, a small Kubernetes cluster (k3s).
- **Who pays for it** — the owner, and using QA Tools is free. What is free
  today stays free; if paid plans ever come, they will be extras for teams.
- **Your data** — no ads, no cookies and no third-party analytics; captured
  requests are never sold or shared.
- **Security reviews** — companies can ask for the operator's details, or for
  a data processing agreement, by email (since v0.56.0, D224).

The operator is not named on the site; the details are given by email on
request. The exact wording is in `apps/frontend/src/lib/about-copy.ts`, joined
by no-break spaces so that no line ends with a single word at any width from
320 px. The texts are pinned by a test, and a change that would make one of
the facts false changes the page with it. On the desktop the story is a 680 px
column and the labels sit on a 160 px rail beside their lines; below 768 px
each label sits above its lines. `/docs` points to the page in one sentence of
its introduction.

Since v1.13.0 (issue #170, D255) the page has a Russian version,
`https://qa-tools.ru/ru/about`, in the owner's words, approved word for word:
under the eyebrow `О QA TOOLS` and the title `От тестировщика —
тестировщикам`, the same three paragraphs, the second ending in the MCP
address and the third in the mail address, and the same four facts —
`Как это сделано`, `Кто платит`, `Ваши данные` and `Проверка безопасности`,
with as many lines each. It is laid out as the English page, its labels on a
180 px rail from 768 px so that `Проверка безопасности` stays on one line, and
it too reads in full without JavaScript and loads nothing from another site.
Its header and footer band are in Russian. The two pages name each other for
search engines; neither links to the other, and `/about` stays English
whatever language the browser asks for. The texts are
`apps/frontend/src/lib/about-copy-ru.ts`, and a test holds them in step with
the English: an English text changes its Russian twin in the same change,
approved by the owner. Since v1.15.6 (issue #258) its lines break as Russian
is typeset: in the eyebrow, the title, the story and the facts, no-break
spaces join every one-letter word (`и`, `в`, `с`, `о`, `я`) to the word after
it and every dash to the word before it, and keep `QA Tools` whole, so at
every width from 320 px no line ends with a one-letter word and none starts
with a dash. The title's dash ends its first line on a phone, `От
тестировщика —` over `тестировщикам`, the one line of a single word on the
page; elsewhere the last words of a line are joined as on `/about`, so no
other line holds a single word. The tab title and the description keep their
ordinary spaces. At 320 px the line ending in the MCP address runs up to
about 8 px into its 16 px margin, with nothing scrolling sideways or cut off.

## Terms of Use and Privacy Policy

Since v0.52.0 (issue #112, D217), `https://qa-tools.ru/terms` sets out the
Terms of Use and `https://qa-tools.ru/privacy` the Privacy Policy: together
they say what the service is and is not, what may not be done with it, what is
stored, for how long, who can see it, where it is, and whom to write to, so a
company can pass QA Tools through a security review against published rules
and the operator has written rules to point to when removing abuse (Figma page
`Webhook Inspector · Terms and Privacy (#112)`, frames T1–T3 and P1–P3). Both
are plain English in the owner's voice, as `/about` is, describe the service
as it works today and claim compliance with no law; since v0.56.0 (issue #163,
D224) the Terms name the one law that governs them, that of the Russian
Federation, and no other. Every page links to them as `Terms` and `Privacy` in
the footer band, and `/docs` links both in one sentence of its introduction:
by using the API or the MCP server you agree to the Terms of Use. There is no
banner and no checkbox. The pages
are static and drawn as `/about` is: an eyebrow and a title, an introduction
with `Last updated <day> <Month> <year>` under it, the day the current text
shipped, then sections, each a label and its lines; they read in full without
JavaScript and load nothing from another site.

- **Terms of Use** (`TERMS OF USE`, `The rules for using QA Tools`): **Your
  sessions** — a session's address is its key, 43 random letters and digits;
  anyone who has it can see, change and delete the session; keep it safe.
  **Limits** — a body up to 1 MB, a session's newest 1,000 requests, deletion
  7 days after its last use, and 60 new sessions and 1,200 other API calls a
  minute from one address. **Not allowed** — phishing pages, malware or other
  harmful content served through a session's response; attacking, scanning or
  flooding other systems; deliberately overloading QA Tools; anything
  unlawful. **If the rules are broken** — the operator may delete a session or
  block an address's traffic without notice. **Changes to the service** — API
  changes follow the stability policy in `/docs` (linked); a shutdown is
  announced on the site at least 30 days ahead unless an emergency leaves no
  time. **Liability** — one sentence: as far as the law allows, no liability
  for any loss caused by using QA Tools. **Changes to the terms** — the date
  at the top is the version; a new version is announced on the page at least
  14 days before it applies, and changes the law requires, changes needed to
  protect the service and changes that only add to the user's rights apply
  when published. **Governing law** — the law of the Russian Federation.
  **Contact** — `contact@qa-tools.ru` for questions, abuse reports and
  deletion requests; companies can ask for the operator's details, or for a
  data processing agreement, by email.
- **Privacy Policy** (`PRIVACY POLICY`, `What QA Tools keeps, and for how
  long`): **What a session keeps** — each captured request as received, with
  its size, time and sender's IP address, the answer the session sent and the
  response, queue and rules set up — the rules since v1.3.0, published at
  once: configuration the user types, not data about people (D246, amending
  D224); a session created with the sender's IP turned
  off keeps no sender IP address, the headers the sender sent kept as sent
  (since v1.2.0, published at once since it keeps less, D243); a private
  session keeps a fingerprint of its access key, never the key (since
  v1.11.0, D253).
  - **Who can see it** — anyone with the session's
    URL, on its page, through the API or the MCP server, unless the session is
    private; a private session, only someone with its access key, its URL only
    sending it requests (since v1.11.0, the owner's lines of 2026-10-20,
    published at once with no notice: fewer people can see a session, and the
    fingerprint says nothing about a person, D253); the operator; nobody
    else, and session pages are hidden from search engines. **How long** —
    until deleted or 7 days unused, then removed within 10 minutes; nightly
    backups up to 3 days longer.
  - **Usage statistics** — daily totals kept
    indefinitely, and each day's 20 most frequent `User-Agent` values, content
    types, methods and sender networks (an IPv4 /24 or an IPv6 /48), never a
    session id, a full address, a body, a path or a query string; the sender
    networks are kept 90 days and up to 3 days longer in nightly backups, the
    rest indefinitely (the owner's line of 2026-10-20, published at once: it
    keeps less, D254). **Logs** — the
    server's log records each request's method, URL and time, not the sender's
    IP; the URL includes the first eight characters of the session id, not the
    whole id (since v0.55.1, D217); the proxy in front of the server records a
    sender's IP address in its error log when a connection fails, for example
    when the sender drops it mid-request, and that log stays on the server until
    the proxy restarts, neither backed up nor sent anywhere (since v0.57.5, a
    correction, D231); limits hold an address in memory for up to a minute, or
    while its connection stays open, and write it nowhere (since v0.57.1,
    D227).
  - **In your browser** — no cookies,
    ads, analytics or other third-party scripts; local storage keeps the
    sessions opened, the access keys of private sessions (since v1.15.0,
    D259), which requests were read, the filters, one panel's state and the
    interface language chosen (since v0.54.0, D222); only session ids and the
    access keys of private sessions leave the browser, to open those sessions
    and check that they still exist (the owner's decision 4 of #228, published
    at once: what only the browser keeps applies when published, D224). **Where it is stored** — the operator's server, with
    its city, its country and its hosting provider, and the encrypted backup
    copies kept off the server, with their storage service and its country, as
    the operator's text names them; mail to the contact address is received by
    Apple iCloud Mail; the status page is run by Statuser. **Deleting your data** — on the page or through the API, or
    by writing to the contact address.
  - **Changes to this policy** — a change
    that makes QA Tools keep more data, keep it longer or share it with anyone
    new is announced on the page at least 14 days before it applies, unless the
    law requires it sooner; other changes apply when published. Since v1.0.11 it
    announces the first such change: from 2 November 2026 the server's log
    records the IP address of a sender that sends far more requests than the
    limits allow, at most once a minute (D224). Since v1.15.14 it announces the
    second, a new provider: from 8 November 2026 mail to the contact address is
    received by Yandex 360, in Russia, instead of Apple iCloud Mail (issue #275,
    D224); until then `Where it is stored` names iCloud, and #151 makes the
    switch on or after that day. **Contact** — as on `/terms`.

The exact wording, approved by the owner on 2026-10-09, with two lines of the
Privacy Policy amended on 2026-10-10 (D222, #155) and, for the governing law,
the notice of a change, the data processing agreement and the `Logs` line on
limits (D224, D227), on 2026-10-11, a `Logs` line on the proxy's error log
added on 2026-10-12 (D231), the first dated announcement of a change,
approved on 2026-10-18 (D224, #214), the second, approved on 2026-10-24
(D224, #275), and the line of a session created with
the sender's IP turned off, approved on 2026-10-18 (D243, #166), is in
`apps/frontend/src/lib/legal-copy.ts`, joined by no-break spaces so that no
line ends with a single word at any width from 320 px, and pinned by a test;
every number in it is tested against its source, so a change to a limit, the
idle lifetime, the backups kept, the cleanup's schedule, the statistics' top
20, the networks' masks, the eight characters the log keeps of what it cuts,
the contact address or the notice period, 14 days, whose source is the
`Notice` rule in the header of `CHANGELOG.md`, fails the suite until the page
changes with it; so does a proxy setting that would turn its access log on,
set its log level or send its log elsewhere, a backup that reaches more of the
node than its own directory, or anything deployed that reads the node's
logs. A change that makes a line false still changes these pages in its own
merge request, with a new `Last updated` date; one that needs
notice — a new version of the Terms of Use, or a Privacy Policy that keeps
more, keeps longer or shares with anyone new — ships in two steps: first an
announcement, a dated line in the page's changes section and a changelog
entry with a **Notice:** paragraph, which reaches the breaking feed; then, at
least 14 days later, the change itself (D224). v0.56.0 itself applied when
published, since it only adds to the user's rights. Neither page claims
compliance with any law, which the build checks. Every contact address is a
mail link; `stability policy` links to the Stability section of `/docs`;
`status.qa-tools.ru` and the MCP server are plain text.
The pages stay English when the interface is shown in Russian; their Russian
versions are #237's (D255).

## Language

Since v0.54.0 (issue #108, D222; Figma page `Webhook Inspector · Language switch (#108)`, direction A and the glossary `792:57`) the home page, the session page and everything they draw read in English or in Russian.

- **The first visit** follows the browser: the first entry of its languages that is Russian or English decides, and a browser that asks for neither gets English. The page is drawn in that language from its first frame, with `<html lang>` and the tab's title in it.
- **`EN | RU`** changes the language at once, with no reload, no new address and no call to the server; the open request, its tab, the filter and an open quick switch stay as they were. On the two home pages it also moves to the other one — `RU` to `/ru/`, `EN` to `/` — still with no reload (v0.57.0, issue #109, D226). The language shown is in ink, Semi Bold, the other a link. From 768 px the switch closes the header's links, after `API docs ↗` and a divider; below 768 px, where the header has no room, it is the last of the footer band's links, before the contact address.
- **The choice is remembered** in this browser (`localStorage`, `qa-tools:language`) and wins over the browser's languages on the next visit and in a new tab; open tabs keep theirs until they are reloaded. A stored value the page did not write counts as no choice. Since v1.17.0 the move link carries it from `qa-tools.ru` to `webhook.qa-tools.ru`, where it is taken only when no choice is stored there ([Moving to webhook.qa-tools.ru](#moving-to-webhookqa-toolsru)). The Privacy Policy names it among what the browser keeps.
- **What stays English in Russian** (Decision 7): `Raw`, `Body`, `Headers`, `Query` and the `Request` / `Response` tabs, methods, status reason phrases, header names, the units `B`, `KB`, `MB` and `ms`, `cURL`, `JSON`, `API docs ↗`, and names with no Russian word — `QA Tools`, `HTTP`, `IP`, `XML`, `UTF-8`, `Base64`, `HMAC`, `Postman`, `Stripe`. Numbers are grouped and their nouns agree the Russian way (`1 запрос`, `2 запроса`, `5 запросов`, `65 536 байт`); seconds are `с`. When the server refuses a response or a queue, its English message follows a Russian lead-in, so the field it names stays visible (Decision 6); a refusal placed at a rule or a step names it in Russian — `Сервер отклонил правило 2. Исправьте отмеченное поле и сохраните снова.` — and its English message stands under the field (D257).
- **The Russian home page**, `https://qa-tools.ru/ru/` (v0.57.0, issue #109, D226), is always Russian, and opening it remembers Russian as the choice, so `Создать адрес` there opens a Russian session page and every page after it is Russian; in Russian the wordmark and `На главную` lead back to it. `/` follows the rule above, with no redirect. Search engines are offered both: a Russian search finds `/ru/`, with its Russian title, description and text for readers without JavaScript (see [URLs](#urls)).
- **What stays English always**: `/about`, `/terms`, `/privacy`, `/changelog` and `/docs`, `llms.txt`, `llms-full.txt`, `security.txt`, API error messages, everything copied or downloaded, and what `/` gives a reader without JavaScript or a search engine; `/ru/` gives them Russian.
- **The about page in Russian**, `https://qa-tools.ru/ru/about` (v1.13.0, issue #170, D255), is `/about`'s Russian twin, with a Russian header and footer band; the Russian interface's `О сервисе` leads to it, while `/about` stays English (see [About page](#about-page)).

## Moving to webhook.qa-tools.ru

(v1.17.0, issue #321, D276; Figma page `Webhook Inspector · Move banner (#321)`, direction C1 with the toast T, chosen by the owner on 2026-11-01.) Webhook Inspector moves from `qa-tools.ru` to `webhook.qa-tools.ru` on day X, the date the changelog's 1.16.0 entry gives (D275). A browser keeps the list of sessions, the keys of private sessions and the settings for each address apart, so the new address starts with an empty list; the banner carries them over with one click.

- **The banner.** On every page of the inspector served from the old address — the home page, a session's page in every state, `Page not found` — a light-blue bar spans the page above the header: `Webhook Inspector is moving to webhook.qa-tools.ru on <day X>` (`Webhook Inspector переезжает на webhook.qa-tools.ru <day X>`), the day written as the interface writes days (`9 Mar 2027`, `9 мар. 2027`), 13 px in the brand colour, then one action, `Move with my sessions →` (`Перейти со своими сессиями →`), 13 px Semi Bold and underlined in the link colour, with a 1 px line under the bar. One centred line from 768 px; on a phone the text and the action are centred lines of their own, and the new address is never broken across two lines, at its hyphen or its dots, in either language (since v1.19.9, #347). It cannot be dismissed. It never shows on `webhook.qa-tools.ru`, nor on `/about`, `/terms`, `/privacy`, `/changelog` or `/docs`. Which address is the old one and which the new are the build's origin settings, and the day is read from the changelog when the site is built (D274, D275), so a corrected date reaches the bar with the next release.
- **What travels.** The action opens `https://webhook.qa-tools.ru/` in the same tab with this browser's list of sessions, the keys of its private sessions, the language chosen and whether the Response queue and Response rules sections are open, in one versioned parameter of the fragment, `#move=<base64url JSON>`. Read marks and list filters stay behind: up to 1,000 ids for each of 50 sessions would swell the link, and losing them loses nothing important. The link is built from storage when the action is clicked and never shown; a browser never sends what follows a `#`, so it reaches no server, log or `Referer`. A middle click opens the new address with nothing carried.
- **The arrival.** The new address reads the parameter before it draws anything and takes it out of the address bar at once by replacing the history entry, as a link with access's key is, so the address bar and Back hold none of it. It only adds: sessions by id, the later opening kept, within the list's 50, the private ones first when there is not room for all; keys within the 100 kept, a key already held for a session never replaced; the language and each section's state only where the new address stores none. Nothing there is removed, and no session or key is kept twice. A toast at the bottom, a dot in the toast's check colour before its words, says what came: `Moved 5 sessions from qa-tools.ru, 2 of them private` (`Перенесено 5 сессий с qa-tools.ru, из них 2 приватные`), without the second part when none is private. The list then shows those sessions, a private one opening without its link, in the language that came. A move link pasted into the address bar of a tab already showing a page of the new address — the home page or a session's — is read the same way: the page loads again to read it (since v1.19.2, #345), a session's page still loading its requests when the link is pasted included (since v1.19.13, #362).
- **A bad link changes nothing.** A parameter that is malformed, longer than any link writes, of another version, or that holds anything a stored list would not keep is refused whole: no stored value changes, no toast shows, and it is taken out of the address bar all the same.
- **No other guard** (the owner's decision 4 of #321): a crafted move link can only add sessions and keys to a list, as a link to a session or a link with access can; the toast says what it added.
- **After day X** the hand-off that runs this link on the old address before its pages redirect is #324's.

## Product principles
- No registration.
- No setup form before creating an endpoint.
- Fast path from landing page to a working URL.
- The interface reads in English or in Russian (v0.54.0, issue #108, D222; see [Language](#language)); the static pages, `/docs`, the agent documentation and the API stay English, but for the about page's Russian version, `/ru/about` (v1.13.0, D255).
- Utility-first, calm, non-distracting interface.
- Light theme only in v0.1; dark theme is deferred to a later version.
- Desktop first: the approved desktop layout at 1024 px and wider. Tablets (768–1023 px) and phones (below 768 px, down to 320 px) have layouts of their own with every desktop action reachable by touch (v0.19.0, issue #50, D157, lifting D011).

## Landing page

The landing page has the shared header, its wordmark `Webhook Inspector`, and clearly explains the Webhook Inspector. Since v0.41.0 it has two states, and lists the sessions used in this browser (issue #92, D199, Figma page `Webhook Inspector · My sessions`, frames G3′ and F). Both follow the changelog index's style: a 960 px column centred from 1024 px, rows between thin rules, and the label of a group on a 160 px rail at the left from 1024 px, as a band above its rows below that.

Primary CTA: **Generate URL**, a dashed `+ Generate URL` tile across the column on both states.

Clicking Generate URL:
1. Creates an anonymous session, with the options the tile shows (below).
2. Generates a cryptographically random session ID of 43 letters and digits, with no `_` or `-`, so a double-click selects the whole id and it survives being copied or typed (v0.20.3, issue #53, D161).
3. Adds it to this browser's list of sessions.
4. Redirects immediately to `/v/<session-id>`.

No session name or other input is required.

**When the session cannot be created** (v0.49.2, issue #128; Figma page `739:11`) — the backend is down or restarting during a deployment, the network fails, or the address has used its 60 creations a minute ([Limits](#limits)) — a line under the tile says so, in place of the silence since 0.20.0: `Too many sessions created from your address. Try again in N s.` for a `429` / `1015 RATE_LIMIT_EXCEEDED` with a `Retry-After` of N seconds, and `This session could not be created. Please try again.` for every other failure — no answer, any other status, any other `429` code, or a `1015` without a usable `Retry-After`. The seconds are one number from the refusal, with no countdown. The line is 13 px in the danger colour, 12 px under the tile on both states and at every width — below 768 px under the tile's options line since v1.7.0 (below) — before a returning visitor's `Loading sessions…` or `Session details could not be loaded.` and the days; it is announced as an alert while focus stays on the tile, and the spaces of its second sentence are no-break spaces, so `Please try again.` and `Try again in N s.` wrap whole. The tile does not change and stays clickable, since a refused creation is not counted toward the limit; the next click clears the line at once, and a failure shows it again.

**Generate URL** is the page's only action that creates a session. A session's response — status, response headers, a body and a delay — is configured on its View page, from the endpoint card, at any time (D150); the landing page no longer offers a `Custom response` form beside the button, which led to the same page (v0.20.0, issue #51, D158). The API still creates a session with a custom response in one call, and `/docs` shows how.

**The new session's options** (v1.7.0, issue #216, D249; Figma `Webhook Inspector · New session options (#158, #166)`, direction A, approved 2026-10-18). The tile carries two options of the session it creates, on both states of `/` and `/ru/`: how long it lives after its last use — `7 days`, `1 day` or `1 hour` (`7 дней`, `1 день`, `1 час`) — and whether it keeps the sender's IP. One click on the tile still creates today's default session, 7 days and the IP kept.

- **The trigger always shows both values**: `7 days · IP stored` (`7 дней · IP сохраняется`) muted while both are the defaults, and in ink, Medium, once either differs, as `1 hour · IP not stored`. From 768 px the tile is split: `Generate URL` centred in its own part, then the trigger at the tile's right end, whose first 1.5 px are the divider — the tile's full height, meeting the dashed border top and bottom, dashed exactly as that border is, in its 1.5 px stroke, 6 px dashes, 4 px gaps and colour, a whole dash at each end — with 16 px after it and 16 px at the end, so each part's hover ends at the line and the options cost no height; a window other than 7 days also replaces the tile's hint, `— expires 1 hour after last use` (`— истекает через 1 час простоя`). Below 768 px the tile stays whole and the trigger is a line 8 px under it, right-aligned, 26 px in all; the hint is not shown there.
- **The menu** (from 768 px, under the tile, right-aligned, in the style of the request's `Actions` menu) and **the bottom sheet** (below 768 px, in the style of the request's actions sheet) hold `EXPIRES AFTER LAST USE` (`ИСТЕКАЕТ ПОСЛЕ ПРОСТОЯ`; the sheet's heading `Expires after last use`) with the three windows, the chosen one ticked, then the checkbox `Store the sender's IP` (`Сохранять IP отправителя`), ticked by default, with the hint `Off: requests show “IP not stored”` (`Без галочки в запросах будет «IP не сохраняется»`), whose quoted part never breaks. Choosing does not close them; a click or tap outside, Escape or a swipe down on the sheet does, and focus returns to the trigger. Both are named for the keyboard and assistive technology: the trigger `New session options: 7 days · IP stored`, the windows as radio items, the IP as a checkbox.
- **The choice lasts until the page is left**: it is kept in the page and nowhere else, so every visit, and a reload, starts at the defaults. While a creation is in flight the tile and the trigger are disabled, and a double click creates one session.
- **What it sends** (D104, D242, D243): the defaults send `POST /api/sessions` with no body and no `Content-Type`, as before; a choice sends only the keys that differ from the default, as JSON — `{"expiresAfterIdleSeconds":3600}`, `{"storeSourceIp":false}` or both. The failure line under the tile (below) works the same with any choice; below 768 px it comes 12 px under the options line.
- **Private session** (v1.15.0, issue #228, D259; Figma `Webhook Inspector · Private sessions (#228)`, R1). The menu's and the sheet's last checkbox, below `Store the sender's IP`, the lock before its words: `Private session` — `Opens only with its link with access` (`Приватная сессия` — `Открывается только по ссылке с доступом`), unticked on every visit, a reload included (decision 6). Ticked, the trigger shows the lock after its values, `7 days · IP stored · 🔒 ▾`, the values keeping their tone, and is named `New session options: 7 days · IP stored · Private session`; the creation sends `"private": true` beside the other chosen keys, with no `Authorization`, so the server draws the key and answers it once (D253). The page keeps that key in this browser (below) and opens the session as any other, with no key shown.

A fixed lifetime (`expiresInSeconds`), a window under 1 hour, changing a session's options after it is created, remembering the last choice and showing a session's options in the list below are not part of it.

**First visit (F).** While this browser lists no session: the eyebrow `WEBHOOK INSPECTOR`, the title `Inspect webhooks instantly.` at 48 px (40 px on a tablet, 32 px on a phone) and the lead, then the tile with `— your temporary endpoint, ready in a second` beside its label from 768 px up, or the chosen window's hint (above). Under it **How it works**, three rows — `01 Generate URL`, `02 Send requests`, `03 Inspect live` — on a rail `How it works · 3 steps`. Step 01 carries the security note: `Create a temporary endpoint instantly. Anyone with its URL can see what it receives, so do not send sensitive production data.` The `Temporary and anonymous` block it replaces is gone. Search engines and readers without JavaScript have no list, so they always get F: the `<noscript>` of `index.html` repeats its copy (D183), and that of the Russian home page, `/ru/`, its Russian copy (D226).

**Returning visitor (G3′).** Once the list holds a session the sessions take the place of the steps: the title at 32 px (26 px on a phone) without the eyebrow, the lead at 15 px, the tile with `— a new temporary endpoint`, then the sessions.

- **Grouped by the day of their last use**, newest first: from 1024 px the date (`3 Oct 2026`) and its count (`3 sessions`) on the rail, below 1024 px a band above its rows (`3 Oct 2026 · 3 sessions`), tinted on a phone.
- **A row** shows the session's full receive URL, its prefix muted and the id bold, the copy icon and `⋯` on the first line — a private session's with the lock just before the copy icon, a 12 px glyph in the icon's 14 px box, named `Private session` (since v1.15.0, R2, D259) — and under them `14 requests · last request 2026-10-03 11:40`, or `0 requests · no requests yet`. Nothing is shortened: on a phone the URL wraps, and down to 320 px nothing scrolls sideways.
- **The first 5 sessions** show, then `5 of 12 sessions in this browser · Show all`, which shows the rest in place; with 5 or fewer, or once all show, the line reads `3 sessions in this browser`.
- **A click on a row** opens `/v/<id>` in this tab. The copy icon copies the receive URL with the session page's copy feedback, and `⋯` opens a menu — the actions sheet on a phone — with **Remove from list**, at once with no confirmation and no toast — for a private session after a warning (below) — and **Delete session…**, which asks `Delete this session?`, deletes the session on the server (`DELETE /api/sessions/<session-id>`, D198) and, once it is gone, removes the row and shows `Session G4t2kM8 deleted`. A session that had already expired leaves the list with the toast `Session G4t2kM8 had already expired`. If the deletion fails the dialog stays and says `The session could not be deleted. Try again.`; Cancel changes nothing.
- **While the list loads** the page is G3′ at once, with `Loading sessions…` in the rows' place, and never F first. If the session details cannot be loaded, the rows show by the day each was last opened here, without counts — the session id in the URL's place, with no copy icon — under `Session details could not be loaded.`
- The steps and the security note are not shown on this page: the visitor has used the product before.
- **Remove from list on a private session** (since v1.15.0, R3, the owner's decisions 1 and 9 of #228) first asks `Remove this private session from the list?` (`Убрать приватную сессию из списка?`): `Only this browser holds its key. The session itself is not deleted, but once it leaves the list it opens only with its link with access. Copy the link first if you may need it.`, over the session's receive URL. `Copy link with access` on the left copies the link and keeps the dialog open, saying `Copied` while the copy holds; `Cancel` changes nothing; `Remove from list` takes the entry and its key out of this browser. Below 768 px the buttons stack full width — `Remove from list`, `Cancel`, `Copy link with access` — as the phone's `Delete session…` confirmation does.

**The list in this browser.** It is kept in this browser's storage and nowhere else: another browser, device or private window has its own, and nothing about it reaches the server except the ids of a status read that does not extend the sessions, and the keys of the private ones among them (`POST /api/sessions/status`, D199). Each address keeps its own; since v1.17.0 the move banner's link carries the list and its keys from `qa-tools.ru` to `webhook.qa-tools.ru`, in the address's fragment, which no server receives, adding to what is there ([Moving to webhook.qa-tools.ru](#moving-to-webhookqa-toolsru), D276). A session joins it when the home page creates it and when its View page has loaded it, opening it again moves it to the top, and it keeps at most 50, the least recently opened public session dropping out — a private one only when every listed session is private, its key with it (since v1.15.0, decision 2 of #228, D259). A session leaves it by `Remove from list`, by being deleted from the list, and when the status read reports it expired or unknown — so expired and deleted sessions drop out on the next home page load, and when none remain the page is F. A private session's key leaves with its entry, however it leaves, and from every tab of this browser at once: a tab still showing the session keeps what it shows — the card's lock and `· PRIVATE`, `Copy ▾` with `Copy link with access`, and a request's `Copy link` with the key — through whatever it redraws meanwhile, a request arriving live included, until its next call, which is then answered as a missing session's: the page holds the key its session opened with, while each of its calls reads the stored one (#264). A status read that reports a private session unknown leaves it listed when another tab has opened it with its key since the read was sent. **The keys** of private sessions are kept beside the list, under `qa-tools:access-keys`, and only keys of a key's shape, of sessions that opened with them as private: a creation's, a link's or a pasted one once the server accepted it. The page sends a key by itself on every call for its session — `Authorization: Bearer` on the API, on the socket the subprotocol `webhook-inspector.access-key.<key>` beside `webhook-inspector`, and the same key as `qa-tools.access-key.<key>`, which a backend of the release before reads, until the old names stop (D279) — and the status read sends `accessKeys` for the listed private sessions only, so one stored value that is no key never fails the read of the rest; the person never sees a key. With storage unavailable a key is held in the open tab alone, so a link with access still opens its session there. With storage unavailable there is no list and the page is F, with no error. Accounts, a list that follows the user, names for sessions and a session switcher on the session page are not part of it (#113).

## URLs

Webhook endpoint, and any path under it (D173), on a host of its own since v0.36.0 (issue #90, D187):
```text
https://hook.qa-tools.ru/s/<session-id>
https://hook.qa-tools.ru/s/<session-id>/<any path>
```

Webhooks are received on `hook.qa-tools.ru` and nowhere else, so that a captured request is exactly what the sender wrote (see [Request capture](#request-capture)). The API gives each session's webhook URL as `receiveUrl`, and the session page shows and copies it. That host serves `/s/` alone: any other address there answers `404` with `errorCode` `1000`, and its `/robots.txt` keeps every crawler out. The site, the API, the realtime connection, `/docs` and every other address below stay on `qa-tools.ru`.

The old webhook address, `https://qa-tools.ru/s/<session-id>`, stopped receiving in v0.36.0, with no transition period (owner, 2026-09-30). Whatever the method and whatever the path under `/s/`, it stores nothing and answers `410` with `errorCode` `1009` (`RECEIVE_URL_MOVED`) — except a path with a malformed percent-escape such as `%zz`, which the proxy in front of `qa-tools.ru` still refuses with its own `400` before it arrives — and a message naming the session's new URL: `Webhooks for this session are received at https://hook.qa-tools.ru/s/<session-id>`, or, when the segment after `/s/` cannot be a session id, `https://hook.qa-tools.ru/s/<session-id>` as a pattern. It is not a redirect: senders rarely follow one for `POST`.

View page:
```text
https://qa-tools.ru/v/<session-id>
```

The same session ID is used for receiving and viewing. Sessions created before v0.20.3 keep their ids, which may contain `_` and `-`, and work exactly as before. There are no accounts. Anyone with a public session's URL may access it; sensitive production data should not be sent. A private session (since v1.11.0, [Private sessions](#private-sessions)) is opened only by its access key, and its URL only sends it requests.

API reference (v0.17.0, issue #34, D155):
```text
https://qa-tools.ru/docs
```

A developer or QA engineer opens it and, in a few minutes, can create a session, configure its response, send a webhook and read what was captured with `curl` or their own client, without the interface. It is the public API description `https://qa-tools.ru/openapi.json` (D154) rendered by Scalar, in Scalar's stock light look, accepted by the owner on 2026-09-24 without a Figma frame:

- **An introduction**, which is the description's `info.description`: a quickstart in `curl` — create a default session, send it a webhook, list the captured requests, read one; then a session with a custom response (status, headers, a JSON body, a delay) and a change of that response — then the concepts (the session id is the access key unless the session is private, the View page `/v/<session-id>`, 7 days after last use, the newest 1000 requests, the 1 MiB payload limit, the search, many requests in one call with their headers and bodies, paged by `after` and filtered by header and body), private sessions — creating one, keeping its key and presenting it (since v1.11.0, D253) —, the custom-response rules, the WebSocket `/ws/<session-id>` and its events, forwarding to a local service with the relay script (D202, see [Forwarding to a local service](#forwarding-to-a-local-service)), every error code with what to do about it, the network section — the one address both hosts answer on (the one this contract, `docs/API.md`, names), HTTPS on port 443, IPv4 only, no CDN, no requests sent to users' systems, and at least 14 days' notice before a planned change of address (D204) — the security note, the stability policy — the two changelog feeds, the policy in force since 1.0.0 and the rule entries before it followed (D212, D233) — and a `Download openapi.json` link, its second paragraph. Its head names the two feeds for a feed reader. The page carries no API text of its own, so a release that changes the description changes the page with it.
- **Every operation**, grouped by tag, with its parameters, answers and examples, and the version from `info.version` at the top.
- **Code samples** in curl, JavaScript `fetch` and Python `requests`, curl selected first, calling the page's own origin — and, for the webhook operations, the webhook host `https://hook.qa-tools.ru`, which their description names as their server (D187).
- **`Test Request`**, which sends the request from the page to the page's own origin — on production, `https://qa-tools.ru` — with no proxy. It creates real sessions, which expire like any other (owner, 2026-09-24). On a webhook operation it therefore shows the old address's `410` / `1009`, naming the webhook URL; webhooks are sent from curl or a client (D187).
- **Light only**, with no dark-mode toggle, and **no request to any other site**: no Scalar fonts, telemetry, AI assistant, MCP, hosted client, registry or toolbar.

The page's title is `Webhook Inspector — API reference`, and its heading is the description's `info.title`, `Webhook Inspector API` (v1.18.0, issue #322, D277). `/docs` and `/docs/` both answer `200` with the page; `/docs` and `/openapi.json` are sent with `Cache-Control: no-cache`, so a reader sees a new release at once. English only, whatever the interface's language (D222). Every page of the interface links to it from its header, `API docs ↗`, opening it in a new tab (v0.20.0, issue #51, D158; see [Branding](#branding)).

Documentation for AI agents (v0.24.0, issue #35, D165):
```text
https://qa-tools.ru/llms.txt
https://qa-tools.ru/llms-full.txt
```

An AI agent told to catch a webhook with Webhook Inspector learns from one fetch how to create a session, configure its response, give out the receive URL, wait for the webhook, read it and clean up. `llms.txt` is a short index in the llms.txt format (llmstxt.org): the product in one paragraph and links to `llms-full.txt`, `/openapi.json` and `/docs`. `llms-full.txt` is the complete guide in Markdown: an agent section — a curl recipe from creation to clean-up, the MCP server with its Claude Code and Cursor configuration (D203), waiting without WebSocket in one call with the list's `wait` (D200), asking only for what arrived after a request already seen with its headers and body in the same call, filtering by a header or the body on the server, the `DELETE` calls that clean up, the response-configuration mistakes agents make (`body` is a JSON string, `status` is required, `204`/`205`/`304` take no body, reserved header names, unknown keys rejected) and the security note — followed by the API introduction shown on `/docs` and a list of every endpoint, both generated from `openapi.json` at every release. Both answer `200` as `text/markdown; charset=utf-8` with `Cache-Control: no-cache`, never the application page. The application's page carries `<link rel="alternate" type="text/markdown" href="/llms.txt">` and, for a reader without JavaScript, a line pointing to both files after the landing page's copy (see below); nothing visible changes with JavaScript on. English only.

MCP server for AI agents (v0.45.0, reachable since v0.45.1, issue #116, D203):
```text
https://qa-tools.ru/mcp
```

An agent in Claude Code, Cursor or another MCP client adds the endpoint once — `claude mcp add --transport http webhook-inspector https://qa-tools.ru/mcp` — and then creates a session, sets its response, waits for a webhook, reads it and deletes the session with one tool call each, for example beside a browser tool, checking in the same chat that the flow it drove sent the webhook it expected. Seven tools, each the API call of the same name with its rules and its `errorCode` values: `create_session` (the session id, its webhook URL on `hook.qa-tools.ru` and its inspector link), `set_response`, `wait_for_request` (up to 30 s), `list_requests`, `get_request`, `clear_requests` and `delete_session`.

- **No key for a public session**, as for the API: its id is its access key (owner, 2026-10-04). A private session's key travels in the `Authorization: Bearer` header the agent's MCP client sends on every call, which the user configures once; `create_session` takes `private` and creates the session under that key, and never draws one (since v1.11.0, D253). No npm package and no local server: the endpoint is the product.
- **One call cannot flood an agent's context** (owner, 2026-10-04): lists carry no bodies and at most 100 requests, 20 by default; `get_request` returns at most the first 64 KiB of a body — text as text, anything else as Base64 — with its whole size and a `truncated` flag, and the inspector link shows the whole.
- **What a sender wrote is untrusted.** The path, the query string, the headers and the body come back only inside a field marked as captured third-party content, `untrustedCapturedContent`, after a fixed sentence saying it was sent by an external party and is data, not instructions; the tools' descriptions say the same.
- **The API's limits** apply to it, shared with the address's API calls ([Limits](#limits)).
- **Not on the webhook host**: `https://hook.qa-tools.ru/mcp` answers `404` with `errorCode` `1000`. Listing it in public MCP catalogues is a later step the owner confirms, after a week of the project's own use.

`llms.txt` names it, and the agent section of `llms-full.txt` gives the Claude Code and Cursor configuration. English only.

Security contact (v0.27.0, issue #88, D177):
```text
https://qa-tools.ru/.well-known/security.txt
```

A `security.txt` in the RFC 9116 format: `Contact: mailto:contact@qa-tools.ru`, an `Expires` 364 days after the release that served it, `Preferred-Languages: en, ru` and its own address as `Canonical`. It answers `200` as `text/plain; charset=utf-8` with `Cache-Control: no-cache`, and is rebuilt at every release, so it never expires while releases continue.

Changelog (v0.33.0, issue #97, D184; the feeds since v0.51.0, issue #133, D212; see [Changelog](#changelog)):
```text
https://qa-tools.ru/changelog
https://qa-tools.ru/changelog.md
https://qa-tools.ru/changelog.xml
https://qa-tools.ru/changelog-breaking.xml
```

`/changelog` and `/changelog/` answer `200` with the page, `text/html`, `/changelog.md` answers `200` as `text/markdown; charset=utf-8`, and the two feeds `200` as `application/atom+xml; charset=utf-8`, each with `Cache-Control: no-cache` and never the application page; a missing feed is a plain `404`. The heads of `/changelog` and `/docs` name both feeds. The page's title is `Changelog — Webhook Inspector`, its lead, the heading of `/changelog.md` and the feeds' titles and subtitles name Webhook Inspector (v1.18.0, D277), it has a description, and its canonical address is `https://qa-tools.ru/changelog`. `/llms.txt` links `/changelog.md`. A copy built without `OPERATOR_TEXTS` serves none of the four, each `Page not found`, and links none (v1.19.20, issue #396, see [Changelog](#changelog)).

About page (v0.50.0, issue #131, D211; see [About page](#about-page)):
```text
https://qa-tools.ru/about
```

`/about` and `/about/` answer `200` with the page, `text/html`, with `Cache-Control: no-cache` and never the application page. The page's title is `About QA Tools`, its description `Who runs QA Tools, how it is built, who pays for it and what happens to your data.`, and its canonical address `https://qa-tools.ru/about`.

About page in Russian (v1.13.0, issue #170, D255; see [About page](#about-page)):
```text
https://qa-tools.ru/ru/about
```

`/ru/about` and `/ru/about/` answer `200` with the page, `text/html`, `<html lang="ru">`, with `Cache-Control: no-cache`, no `X-Robots-Tag` and never the application page; `/ru/about/index.html` by name, `/RU/about` and `/ru/about.html` are `Page not found`. Its title is `О QA Tools`, its description `Кто и как делает QA Tools, кто за него платит и что происходит с вашими данными.`, and its canonical address `https://qa-tools.ru/ru/about`. Both about pages carry the same `hreflang` links, `en` and `x-default` to `https://qa-tools.ru/about` and `ru` to `https://qa-tools.ru/ru/about`. `/about` is the English page whatever `Accept-Language` asks for, with no redirect.

Terms of Use and Privacy Policy (v0.52.0, issue #112, D217; see [Terms of Use and Privacy Policy](#terms-of-use-and-privacy-policy)):
```text
https://qa-tools.ru/terms
https://qa-tools.ru/privacy
```

`/terms`, `/terms/`, `/privacy` and `/privacy/` answer `200` with their page, `text/html`, with `Cache-Control: no-cache` and never the application page. The titles are `Terms of Use — QA Tools` and `Privacy Policy — QA Tools`, the descriptions `The rules for using QA Tools: your sessions, the limits, what is not allowed, and whom to write to.` and `Everything QA Tools stores, who can see it, where it is kept and when it is deleted.`, and the canonical addresses the two above.

Status page (v0.49.0, issue #99, D209; see [Status page](#status-page)):
```text
https://status.qa-tools.ru/
https://qa-tools.ru/status
```

The first is Statuser's page on a name of ours. `/status` and `/status/` answer `301` with `Location: https://status.qa-tools.ru/` whatever the request's host, scheme or query string; every other address under `/status` is `Page not found`.

Russian home page (v0.57.0, issue #109, D226; see [Language](#language)):
```text
https://qa-tools.ru/ru/
```

The landing page in Russian, for a Russian search. `/ru/` and `/ru` answer `200` with a page of their own, `text/html`, with `Cache-Control: no-cache` and no `X-Robots-Tag`; it is the application itself under a Russian head, so with JavaScript it is the home page above, always in Russian. Its title and `og:title` are `Webhook Inspector — проверка вебхуков`, the Russian tab's title (v1.18.0, issue #322, D277; `QA Tools — проверка вебхуков онлайн` before), its description and `og:description` `Создайте временный адрес и смотрите входящие вебхуки и HTTP-запросы в реальном времени. Без регистрации и настройки.`, its canonical address and `og:url` `https://qa-tools.ru/ru/`, and a reader without JavaScript gets the landing page's Russian copy — the heading, the lead and the three steps — and the pointer to the agent documentation, which is English. `/` stays where it was.

Search engines and link previews (v0.32.0, issue #69, D183):
```text
https://qa-tools.ru/robots.txt
https://qa-tools.ru/sitemap.xml
```

Search engines are offered the landing page, its Russian version `/ru/` (since v0.57.0, D226), `/docs`, `/changelog` (since v0.33.0, D184), `/about` (since v0.50.0, D211) and its Russian version `/ru/about` (since v1.13.0, D255), `/terms` and `/privacy` (since v0.52.0, D217), and nothing else. `robots.txt` keeps crawlers off `/s/`, `/api/` and `/ws/` and names the sitemap; the webhook host has a `robots.txt` of its own, `Disallow: /`, so a crawler never sends a request into anyone's session (D187). The sitemap lists `https://qa-tools.ru/`, `https://qa-tools.ru/ru/`, `https://qa-tools.ru/docs`, `https://qa-tools.ru/changelog`, `https://qa-tools.ru/about`, `https://qa-tools.ru/ru/about`, `https://qa-tools.ru/terms` and `https://qa-tools.ru/privacy`. A session page is never indexed: every answer to `/v/<session-id>` carries `X-Robots-Tag: noindex`, because a public session's id is the access key to the session — a private session's id opens nothing without its key (since v1.11.0, D253), and its page carries the header too; `/v/` is left open to crawlers so that they read that header. There is no web analytics on any page, since a script would send the page's address, and on a public session's page that is the key.

The landing page describes itself to a search result and a link preview: the description `Generate a temporary URL and inspect incoming HTTP requests and webhooks in real time. No registration, no setup.`, the title `Webhook Inspector — QA Tools` and site name `Webhook Inspector` (v1.18.0, issue #322, D277), `https://qa-tools.ru/` as its canonical address, and as its image the product mark on a white square, 512 × 512 at `https://qa-tools.ru/logo-512.png`, described as `Webhook Inspector logo` (`Логотип Webhook Inspector` on the Russian page); the same mark as a 192 px PNG is the icon beside a search result, and `/favicon.ico` holds it at 16, 32 and 48 px. A reader without JavaScript, a crawler among them, gets the landing page's copy as plain HTML — the heading, the lead, the three steps and the note — followed by the pointer to `/llms.txt` and `/llms-full.txt`. The two home pages name each other for search engines: both carry the same `hreflang` links, `en` and `x-default` to `https://qa-tools.ru/` and `ru` to `https://qa-tools.ru/ru/`, and an `og:locale` pair, `en_US` and `ru_RU` (D226); the Russian page describes itself as the Russian home page above does. `/docs` describes itself as `HTTP API reference for QA Tools Webhook Inspector, rendered from /openapi.json.` With JavaScript both pages look as before. Yandex Webmaster and Google Search Console verify the site through a DNS record, so no verification tag or file is part of it.

### Addresses the application does not serve

An address the application does not serve says so; it is not redirected to the landing page (v0.12.0, issue #24, D146). What the page says depends on how the address looks:

| Address | Screen | HTTP status |
| --- | --- | --- |
| `/` | the landing page | `200` |
| `/ru/` or `/ru` | the landing page in Russian, a page of its own (v0.57.0, D226) | `200` |
| `/v/<43 characters of A–Z a–z 0–9 _ ->`, with or without a trailing slash — a new session id or an older one | the session, or **`Session not found`** when the API says it is not available (`404` or `410`) | `200` — the server cannot know whether the session exists, so the page asks — with `X-Robots-Tag: noindex` |
| any other address: `/anything`, `/v/`, `/v/<value that cannot be a session id>`, `/v/<session-id>/<more>`, `/RU/`, `/ru/<more>` | **`Page not found`**, shown at once, with no request to the API and no WebSocket | `404`, with the application as the page |

Addresses under `/api/`, `/ws/` and `/s/`, and every address that starts with `/mcp` (v0.45.1, D203), belong to the backend and keep their own answers — under `/s/`, since v0.36.0, the `410` / `1009` naming the webhook host (D187), and anything after `/mcp`, such as `/mcp/` or `/mcpx`, `404` with `errorCode` `1000`; a bare `/api`, `/ws` or `/s`, and an address such as `/sxyz`, is an address like any other above (v0.32.0, D183). `/docs` and `/docs/` are the API reference above, `/changelog`, `/changelog/`, `/changelog.md` and the two feeds the changelog above (`Page not found` in a copy without the operator's texts), `/about` and `/about/` the about page above, `/llms.txt` and `/llms-full.txt` are the agent documentation above, `/.well-known/security.txt` is the security contact above, `/robots.txt`, `/sitemap.xml`, `/favicon.ico`, `/favicon-192.png` and `/logo-512.png` are the files for search engines above, and a file the application ships under `/assets/` is served as a file; a missing one is a plain `404`. Every answer that carries the application, `200` or `404`, is sent with `Cache-Control: no-cache`, so a browser never keeps a previous release's page.

Both screens share one layout (Figma page `Webhook Inspector · Not found`, frames `2A` and `2B`, D147): a title, a code block, one line of text and a `Go to home page` button that leads to `/` — in Russian `На главную`, which leads to `/ru/` (D226). The code block is a stylised request and its answer — the address actually opened, path and query without the fragment, then `Host:` with the page's own host, a blank line, and the answer. It wraps like `Raw` and has no copy control: it illustrates, it is not a capture.

| | `Session not found` | `Page not found` |
| --- | --- | --- |
| Code block | `GET /v/Au6J…MKss HTTP/1.1` — the session id shortened to its first and last four characters<br>`Host: qa-tools.ru`<br><br>`Session not available` | `GET /pricing HTTP/1.1`<br>`Host: qa-tools.ru`<br><br>`HTTP/1.1 404 Not Found` |
| Text | `It was most likely deleted, on purpose or after going unused for the time chosen when it was created, together with its requests and response settings.` | `There is nothing at this address. Check the URL, or go back to the home page.` |

Both buttons go home rather than generating a new URL: the home page is where a new session is created, and a screen that only reports a missing session does not create one by itself. A response like the one the lost session may have had is set on the new session's page (D150, D158).

**Opening a private session there** (since v1.15.0, R6–R8, issue #228, D259). `Session not found` is also what a private session opened without its key shows (D245), so it can be no other page: under `Go to home page` it has a quiet link, `Open with a link with access or a key…` (`Открыть по ссылке с доступом или ключу…`), shown for a missing session too. It opens a field in its place under a rule: `Have a link with access or a key? Paste either one to open the session.` and `Open`. The key alone is tried on the page's own session; a link with access of this site, on the session it names, at the request it names. The server is asked once with the key; a session that opens keeps its key and is opened — this page afresh, or the link's session. A key of the wrong shape, a link without a key, another site's link or a session the server says is missing or gone — a wrong key included — changes nothing and says `Nothing opened: this is not a link with access or a key of a session that exists.` in the danger colour under the field. A check the server could not answer — too many requests, a server error, no connection — changes nothing either, but says `This session could not be loaded. The session itself may be fine; try again in a moment.` there instead, since the key may be right. A second `Open` while the check runs does nothing, and leaving the page meanwhile stays left. The field and `Open` stay on one row from 375 px; at 320 px nothing scrolls sideways.

## Session lifecycle
- Lifetime: **7 days from the session's last use**, not from its creation (D133), unless it was created with a shorter idle window or with a lifetime (below, D242, D220). The limit exists to reclaim storage from abandoned sessions, so it measures abandonment rather than age: a session in daily use never expires, and one nobody touches is gone a week later.
- Three things count as using a session: **a captured webhook**, **a load of its View page** and **a change of its response** (D150) — its queue's and, since v1.3.0, its rules' among them (D205, D246). Nothing is asked of the user, and nothing in the interface extends a session: the home page reads the status of the sessions it lists without using them (D199). Over MCP only `set_response` is a use, as the response change it makes is (D203).
- A tab left open reloads the session on every realtime connection and, since v1.7.0, every 10 minutes besides while it shows the session (issue #216, D249), and therefore keeps it alive for as long as it stays open, whatever its window — "an open tab is a use", the owner's decision of 2026-10-18 — except a session created with a lifetime, whose end no reload moves (below, D220). The 10-minute read goes on while the tab is hidden; one that fails — offline, refused, a server error — leaves the page as it is and the next one tries again. This is accepted: the storage one session can occupy is bounded by the newest-1000 rule. Those reloads are also how such a tab finds out that its session is gone: a `410` or `404` to either shows `Session not found`, and no timer in the page decides that by itself.
- The expiry moves at most once an hour per session — for a window under 10 hours, once a tenth of the window (D242) — so `expiresAt` in the API may sit up to an hour behind the last use. Nothing shows it: the page states the rule rather than a date, and nothing in the product depends on the exact figure.
- The View page states the rule where the countdown used to be — `SESSION EXPIRES 7 DAYS AFTER LAST USE` (v0.20.0, D158; until then `KEPT FOR 7 DAYS AFTER LAST USE`, which did not say what was kept) — and never counts down. Looking at the page is itself a use, so a counter could never approach zero in front of the person reading it. On a phone the line sits under `RECEIVE URL`; from 768 px up it shares that line.
- **Since v1.7.0 the line is the session's own rule** (issue #216, D249), read from `GET /api/sessions/<session-id>`: a default session's is unchanged; a window of 1 day or 1 hour reads `SESSION EXPIRES 1 DAY AFTER LAST USE` / `SESSION EXPIRES 1 HOUR AFTER LAST USE` (`СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ 1 ДЕНЬ ПРОСТОЯ`, `… 1 ЧАС ПРОСТОЯ`), and any other window the API allows is stated in whole days, else whole hours, else whole minutes, rounded down so it never states a longer window than the real one (5400 s is `90 MINUTES`). A session created with a lifetime states its end in the viewer's time, the date with it — `SESSION EXPIRES 26 SEP AT 11:50` (`СЕССИЯ ИСТЕКАЕТ 26 СЕНТ. В 11:50`, the month from the interface's own table) — the year added only when it is not this year, minutes truncated so it is never later than the real end, and never `TODAY` or `TOMORROW`, which would go stale past midnight in an open tab. An answer without the fields, or with values outside the contract, reads as today's line. A session that keeps no sender address adds `IP NOT STORED` (`IP НЕ СОХРАНЯЕТСЯ`): after the line and a `·` from 768 px, on a line of its own below. A private session ends the line with `· 🔒 PRIVATE` (`· 🔒 ПРИВАТНАЯ`) in ink, since v1.15.0 (R4, D259): on the same line from 768 px; below it beside `IP NOT STORED` on that line, or on a line of its own when the address is stored. Its card's `Copy` is a split button at every width: the main part copies the receive URL, and `▾` — named `Copy options` — opens `Copy receive URL` (`For the sender: it only receives requests`) and `Copy link with access` (`For a colleague: opens this session`), a menu from 768 px and a bottom sheet below, the link confirmed by the toast `Link with access copied`. A public session's card keeps the plain `Copy`.
- **A session can be deleted at once through the API**, `DELETE /api/sessions/<session-id>`, with its requests and response settings (v0.40.0, issue #102, D198) — for a script or a CI run that has finished with it. Its webhook URL then answers as for a session that never existed, and every tab open on it moves to `Session not found` without a reload. Since v0.41.0 the home page's list of the sessions used in this browser deletes one too, after a confirmation (issue #92, D199); the session page itself has no delete control. Deleting is not a use, and an expired session is not deleted: the cleanup removes it.
- **A session can be created with a lifetime through the API** (v0.53.0, issue #129, D220): `POST /api/sessions` with `expiresInSeconds`, from 60 seconds to 7 days, ends the session that many seconds after its creation, whatever happens to it — no use moves its expiry — so a CI test that crashes, times out or is cancelled before its clean-up step leaves its session behind for no longer than it chose. It only shortens a session: with a lifetime or without one, a session never lives past 7 days after its last use. The MCP tool `create_session` takes it too. The interface does not set one. Until v1.7.0 such a session's View page read `SESSION EXPIRES 7 DAYS AFTER LAST USE`, inexact for it; since then it states the session's fixed end (above, D249), and the `Session not found` sentence names the time chosen at creation.
- **A session can be created with an idle window through the API** (v1.1.0, issue #158, D242): `POST /api/sessions` with `expiresAfterIdleSeconds`, from 1 hour to 7 days, makes the session expire that long after its last use instead of 7 days — "if it is used it is not deleted, if it is not used it is", as the owner put it on 2026-10-18. Every rule above applies with that window in place of 7 days: the same three uses keep it alive, each moving its expiry a full window ahead, at most once a tenth of the window for a window under 10 hours — 6 minutes for an hour, so a use every 10 minutes, the open tab's read since v1.7.0, keeps a 1-hour session alive. It cannot be combined with a lifetime. `GET /api/sessions/<session-id>` says which rule a session follows, its window or its fixed end, so that a page can state its real rule. The MCP tool `create_session` takes it too. Since v1.7.0 the home page offers 1 hour, 1 day or 7 days, an open tab keeps a short session alive, and the session page states each session's rule (issue #216, D249, above); until then such a session's page read `SESSION EXPIRES 7 DAYS AFTER LAST USE`, inexact for it.
- **A session can be created to keep no sender IP address through the API** (v1.2.0, issue #166, D243; the owner's decisions of 2026-10-18): `POST /api/sessions` with `{"storeSourceIp":false}` stores every request the session captures without the sender's address, and `sourceIp` is `null` in every answer about them, the default answer and the live event included; the address is otherwise stored by default, as before. It covers only the address QA Tools itself records: the headers the sender sent, `X-Forwarded-For` included, are kept as sent, and so is anything the sender writes into its own request. Set at creation only. The limits and the capture budget still use the real address in memory, as before; the statistics count such requests under an unknown network. `GET /api/sessions/<session-id>` gives the choice as `storeSourceIp`, always present. The MCP tool `create_session` takes it too. `/privacy` says so in `What a session keeps`, a change that keeps less and so applies at once (D224). Since v1.7.0 the home page offers the choice beside the session's window, the session card says `IP NOT STORED`, and its rows and the detail read `IP not stored` (`IP не сохраняется`) where the address would be (issue #216, D249); until then such a session's rows read `IP unavailable`, the wording of an address that did not parse (D120), which every other session keeps.
- **A session can be created private through the API and MCP** (v1.11.0, issue #227, D253; the owner's decisions of 2026-10-19, D245): see [Private sessions](#private-sessions).
- Expired sessions are unavailable immediately based on `expires_at`.
- Physical database cleanup may happen shortly afterward.
- **One unavailable screen, not two.** `Session expired` is gone: the page no longer tells an expired session from an unknown one. A well-formed session address whose session the API says is not available shows `Session not found`, which names the likely causes, hedged — `It was most likely deleted, on purpose or after going unused for the time chosen when it was created, together with its requests and response settings.` (`Скорее всего, её удалили — намеренно или после простоя, заданного при создании, — вместе с запросами и настройками ответа.`) — and offers `Go to home page` (D147). Since 0.40.0 a session can be deleted on purpose through the API, so the sentence names that beside the idle window (D198); until then it named the idle window alone, because a session could not be deleted by hand. Since v1.7.0 a session's window is chosen when it is created, so the sentence names the time chosen, in the owner's words of 2026-10-18 (issue #216, D249); until then it read `… or after 7 days without use, …`. Since v1.15.16 it names no number (issue #274, D265): until then it added `(7 days unless set otherwise)` (`(7 дней, если не выбрано другое)`), but the page cannot know the window of a session the API no longer has, which a person who chose 1 hour read as 7 days. An address that cannot be a session never reaches the session page and shows `Page not found` instead (see [Addresses the application does not serve](#addresses-the-application-does-not-serve)). The backend still answers `410 SESSION_EXPIRED` and `404 SESSION_NOT_FOUND` as before.
- A failure that says nothing about the session — a network error, a server error — shows `Something went wrong` with `Try again`, unchanged (D072).

## Private sessions

(v1.11.0, issue #227, D253, built on the check of v1.2.1, D245.) A public session's id is its webhook URL and its whole access key at once (D004): whoever saw the URL — in the configuration of the system under test, in a log, in a CI report — reads everything the session captured, deletes requests and changes the response. A team that uses QA Tools as a controllable mock in CI asked for private sessions with a separate key (external feedback of 2026-09-30 and 2026-10-10). A **private session** is opened only by its **access key**: a CI pipeline creates its sessions with one key kept in its secrets, hands their webhook URLs to the system under test and to its logs, and nobody who sees those URLs can read what was captured.

- **Creating one.** `POST /api/sessions` with `{"private":true}`. With no `Authorization` header the server draws a key — 43 letters and digits, as an id is drawn (D161) — and answers it once, as `accessKey`; it is never shown again and cannot be recovered. With `Authorization: Bearer <key>` the session is created under that key, so one key opens every session created with it, and the answer carries no key. Any value of a key's shape is taken; a header that carries no key is refused `400` / `1005` and nothing is created. Without `private` a creation ignores `Authorization` and the session is public, exactly as before. `GET` says `private`, `true` or `false`. Over MCP, `create_session` takes `private` and creates the session under the key the agent's client sends to `/mcp`.
- **Presenting the key.** `Authorization: Bearer <key>` on the API and `/mcp`; beside each id in `accessKeys` in the status read; the subprotocol `webhook-inspector.access-key.<key>` beside `webhook-inspector` on the socket; `WEBHOOK_INSPECTOR_ACCESS_KEY` for the relay. Until the date the changelog's 1.19.0 entry gives, the old names are taken too: `qa-tools.access-key.<key>` beside `qa-tools`, and `QA_TOOLS_ACCESS_KEY` when the new variable is not set (D279). Never in a URL. Without its key, or with another, a private session is answered exactly as one that does not exist (D245).
- **What stays open.** Its webhook URL receives as any session's and never asks for the key, so whoever has it can send the session requests and learn that it exists. QA Tools keeps only the key's SHA-256 fingerprint.
- **Set at creation only.** A session cannot be made private later, and its key cannot be changed, removed or recovered; private is not the default; there are no accounts (#113).
- **The interface** (since v1.15.0, issue #228, D259) creates one with the home page's `Private session` checkbox, keeps the keys in this browser's storage beside the list of sessions, sends them by itself, and marks a private session with the lock: on its list row, and on the session card, whose line ends `· 🔒 PRIVATE` (`· 🔒 ПРИВАТНАЯ`). **Sharing** is a link with access, `https://qa-tools.ru/v/<session-id>#key=<key>`: the card's `Copy ▾` holds it, and in a private session a request's `Copy link` carries the key too (`#key=<key>&request=<request-id>`). A browser never sends what follows a `#`, so the key reaches neither the server nor a log nor a `Referer`; the page reads it before it loads anything, stores it once the session has opened with it as private, and takes it out of the address at once by replacing the history entry, so the address bar and Back hold no key. A key this browser already holds for a session is not replaced by another link's. Since v1.17.0 the move link carries the stored keys to `webhook.qa-tools.ru` with the list, handled as a link with access is — in the fragment, never logged or sent, taken out of the address once read — where they only add, a key held there never replaced ([Moving to webhook.qa-tools.ru](#moving-to-webhookqa-toolsru), D276). **Without its key** the View page of a private session is the page of a session that does not exist, in every state; that page's field takes a link with access or the key alone (above). A link with access typed into the address bar of a tab already on that session — its `Session not found`, say — is read at once too: the key leaves the address and the page opens afresh with it, at the request the link names. The `inspectorUrl` of `/mcp` and of a default reply carries no key, as before.
- **Privacy.** `/privacy` says who can see a private session and that it keeps a fingerprint of its key, in the owner's words of 2026-10-20, published at once with no `**Notice:**` paragraph (owner, 2026-10-19): the fingerprint says nothing about a person, and fewer people can see a session (D224).

## Request capture
The webhook endpoint accepts every HTTP method Node's parser can produce - the 34 names of `http.METHODS` other than `CONNECT` - on `/s/<session-id>` and on any path under it (D139, D173). Those are GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, TRACE and QUERY, and 25 extension methods from WebDAV, CalDAV, UPnP and similar protocols: ACL, BIND, CHECKOUT, COPY, LINK, LOCK, M-SEARCH, MERGE, MKACTIVITY, MKCALENDAR, MKCOL, MOVE, NOTIFY, PROPFIND, PROPPATCH, PURGE, REBIND, REPORT, SEARCH, SOURCE, SUBSCRIBE, UNBIND, UNLINK, UNLOCK and UNSUBSCRIBE. Each is captured and answered like any other request, the configured response, delay and limits included, and each of the 25 may carry a body. There is nothing further to accept: Node rejects any other method name with `400` before the application sees it, and a `CONNECT` never reaches a route. That includes a `QUERY` without a `Content-Type` header, or with one and no body, which the receiver captures as it would the same request sent with `POST`, although RFC 10008 asks a server to refuse it; everywhere else such a `QUERY` is answered `400` / `1008` and nothing is stored (D166).

Any path under the endpoint is the same endpoint (D173, issue #42). A sender configured with a route per provider or per event type, or a WebDAV client addressing a folder, delivers like one sent to `/s/<session-id>` itself, with the session's response, delay and limits, and one session can take several of them, told apart by path:

```text
https://hook.qa-tools.ru/s/<session-id>                   -> captured
https://hook.qa-tools.ru/s/<session-id>/                  -> captured
https://hook.qa-tools.ru/s/<session-id>/stripe/events     -> captured
PROPFIND https://hook.qa-tools.ru/s/<session-id>/folder/  -> captured
```

A trailing slash was the first case of this rule (D063). The segment after `/s/` alone names the session: an unknown id answers `404` / `1001 SESSION_NOT_FOUND` whatever path follows it, and stores nothing. The path is stored exactly as the sender wrote it, and shown in the request's details; the application decodes and normalises nothing, and since v0.36.0 nothing in front of it does either (D187): a dot segment (`/s/<session-id>/a/../b`), a doubled slash (`//dbl`), an escape of an unreserved character (`%7euser`) and lower-case hex digits are stored verbatim, in the details and in `Raw`, and a malformed percent-escape such as `%zz` is captured like any other path. The query string arrives unchanged. There is no path length limit of its own: the 16 KB limit on the request line and headers bounds it. The session has one response for every path (D099), unless its response rules answer the method and path (D246). A request captured through `qa-tools.ru` before v0.36.0 shows its path as the proxy there forwarded it — hex digits in upper case, `%7E` decoded to `~`, dot segments resolved, doubled slashes collapsed — and `%zz` was refused (D173).

Opening the webhook URL in a browser is a normal GET request and is captured like requests from Postman or external systems.

For every captured request, preserve as much useful information as practical:
- HTTP method
- received timestamp
- every header, exactly as the sender wrote it: each name in its case, in the sender's order, duplicates included, and nothing added (D187)
- raw query string
- raw body bytes
- body size
- the sender's IP address
- the path the request was sent to, without its query string, and the HTTP version it arrived on: `1.1`, since the webhook host speaks HTTP/1.1 alone and an HTTP/2 sender falls back to it (D187)
- other useful HTTP/network metadata if readily available

Every captured request also gets a **record of the response the backend formed for it** and of how sending that response ended: still waiting, finished writing, the connection went away first, or the write itself failed. It is recorded per request rather than derived from the session's configuration, so what a user sees is what happened to *their* request. A request captured before this was recorded has no record, and that reads as **not recorded** rather than as an invented status.

What is recorded is the response the backend **formed**: its status, the headers the backend set, its body bytes, and a raw representation composed from exactly those. It is not a capture of the answer as it travelled. Headers the HTTP server adds while transmitting — `Date`, `Connection`, `Keep-Alive` — are not part of the stored representation, so it is not expected to match a client's own view of the response byte for byte. And where writing was still pending, or ended before it finished, none of that response or only part of it ever left the machine, whatever the record shows.

Finishing to write is never a delivery confirmation. No surface may be worded as one.

Raw request bodies are stored as bytes. Valid UTF-8 bodies are returned to the frontend as text; non-UTF-8 bodies are transported as Base64 without lossy conversion.

Maximum body size: **1 MB**. Larger requests return `413 Payload Too Large` and are not stored. `413` may be returned before session existence/expiration is checked.

Successful webhook response (v0.55.0, issue #137, D223):
```json
{"ok": true, "requestId": "3f8a1b20-0000-4000-8000-000000000000", "message": "Captured by QA Tools", "inspectorUrl": "https://qa-tools.ru/v/G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA#3f8a1b20-0000-4000-8000-000000000000", "receivedAt": "2026-10-10T12:34:56.789Z", "method": "POST", "path": "/s/G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA/stripe/events", "bodySize": 1284, "sourceIp": "203.0.113.7"}
```
with HTTP `200 OK`. It says what was captured and links straight to it, so the sender's log, a CI log or a `curl` output is enough to find and open the request: `inspectorUrl` is the request's `Copy link`, on the inspector's site rather than the webhook host, and `receivedAt`, `method`, `path`, `bodySize` and `sourceIp` are the values the inspector shows for it. Nothing of the request's body, headers or query string is repeated. `ok` stays first and `requestId` second, and the body stays open to added keys (D100); up to v0.54.x it held those two alone, and a request captured then keeps the answer it got.

The same id is returned in the `X-Webhook-Inspector-Request-Id` response header on every stored request, and in `X-QA-Tools-Request-Id`, its old name, beside it until the date the changelog's 1.19.0 entry gives (D279), so a sender can correlate its own log line with the row it produced in the inspector. The default answer's `message` reads `Captured by Webhook Inspector` from that date.

The response is configurable. A session is created either with the default response above or with a custom one — an HTTP status, response headers, a body and a delay — and that response can be changed while the session runs, without a new session and without losing the requests already captured (D150, issue #36). A change applies to the requests captured after it is saved; a request already waiting out its delay answers with what it was composed with, and every request keeps the record of the response it actually got (D105, D109). Switching a session to the default keeps its custom response saved, and switching back restores it (D151). The response body is any text or empty — JSON, broken JSON, XML, HTML, plain text — sent exactly as entered, and its `Content-Type` is an ordinary configured header; with none configured, a body is sent as `application/json; charset=utf-8` (D179). A set of headers that would redirect a client, raise a credential prompt, or change what a browser believes about the origin cannot be configured (D101), with one exception since 1.4.0: a response with a `3xx` status may carry `Location`, and its target is a path under `/s/` on the host that answered, such as another session's URL or a path under the same one, so a sender's redirect handling can be tested end to end and the domain never sends anyone elsewhere (D247). The editor has no control of its own for it: a `Location` row with any other status, or with a target outside `/s/`, shows its error under the row. Every answer on `/s/…` carries `Content-Security-Policy: sandbox; default-src 'none'`, so a browser that opens a receive URL runs no script from it and loads nothing for it: an HTML answer shows as unstyled text with its links (D179). A custom body is returned exactly as it was entered, with no `requestId` added to it — the `X-Webhook-Inspector-Request-Id` header carries the id instead, and `X-QA-Tools-Request-Id` beside it — unless the response is marked a template (below).

Since v1.9.0 (issue #135, D251) a response may be marked a **template**: `template: true`, through the API and the MCP tools. Its body's placeholders are then replaced with values of the request each answer is for — `{{request.id}}`, `{{request.method}}`, `{{request.path}}`, `{{request.query.<name>}}`, `{{request.header.<name>}}` and `{{request.body.<path>}}`, a field of a JSON body — so a mock gives back the same id, an `orderId` from the body or a header value, as a client that checks the echo expects. The session response, each step of the queue and each rule's response can be one. Values are read, never computed: there are no expressions, conditions or functions. A value is escaped for the answer's `Content-Type`, so a quoted placeholder stays valid JSON and a value in HTML or XML stays text; a missing value — an absent header, a body that is not JSON, a path not found, `null`, an object or an array — renders empty; and the answer stays within the 64 KiB of every custom body, a value that does not fit rendering empty. Every `{{` of a template must start a placeholder of the set, or the response is refused when it is saved. A response not marked is sent byte for byte, as before, `{{` and all. The recorded response is the body actually sent. The interface keeps the flag through every save (API.md, Response templates).

Since v1.11.0 (issue #236) the interface sets it too, as drawn on the Figma page `Webhook Inspector · Response body templates (#236) — approved A` (direction A, the owner's pick, in the project's Figma file). Under the body of the session response editor, of each queue step and of each rule's response is one checkbox, `Fill in placeholders from the request`, off by default: unticked, it stands where the hint `Returned exactly as entered` stood, beside the byte counter, so it costs no height from 768 px, and `{{` stays text. Ticked, **Insert placeholder ▾** follows its label and one line under it says `Placeholders like {{request.id}} are replaced with values of the captured request.` The list — the Actions menu's dropdown from 768 px, a bottom sheet like the Actions sheet on a phone — inserts `Request id`, `Method` and `Path` whole, as `{{request.id}}`, `{{request.method}}` and `{{request.path}}`, and, after a line, `Query parameter…`, `Header…` and `JSON body field…` as `{{request.query.}}`, `{{request.header.}}` and `{{request.body.}}` with the caret before `}}`, where the name or the dot path is typed. It inserts at the body's caret, in place of a selection — at the end while the body has had no caret — and focus returns to the body. While the box is ticked, the body is checked as it is edited by the server's own rules, and the placeholder that breaks them is named under the body, in red, with Save unavailable: `Unknown placeholder {{request.foo}}.`, `Finish {{request.header.}}: type the name before }}.` — `the field path` for a body field — or `A placeholder is not closed: {{ without }}.`; a refusal from the server is shown as every other. The body stays a plain monospace text area: placeholders are not highlighted, and nothing previews the filled-in body. A template is marked where a response is summarised: a quiet `Template` tag right of **Edit headers and body…** in the quick switch, at no extra height, and after a rule's answer in its Response rules section, and a `· Template` part in a queue step's chip, `201 · Template`, as a delay shows `· 2 s`. The response button and the dialogs' lists of steps and rules are unchanged. Templated header values stay out of scope.

A configured delay holds the reply, never the capture: the request is stored and shown in the inspector immediately, while the sender is still waiting (D105). Rejections are never delayed.

**Headers, path and version as sent** (v0.36.0, issue #90, D187). The webhook host passes the sender's bytes to the backend unchanged: TLS ends at the proxy, and nothing reads or rewrites the request in between. So `Headers` and `Raw` show each header name in the sender's case, in the sender's order, with its duplicates and its value, and nothing the sender did not write: no `Accept-Encoding: gzip` appears unless the sender sent it, and a sender's own `X-Forwarded-For`, `X-Real-Ip` or `Forwarded` is shown as sent, like any other header. "As sent" rather than byte for byte: the white space around a value is not kept, and `Raw` is composed from what was stored (D049). The version is HTTP/1.1, the one the sender used: the host offers nothing else, so an HTTP/2 client falls back to it.

In production the stored address is the sender's own. The proxy in front of the webhook host passes it to the backend in a PROXY protocol header, which the backend accepts only from the in-cluster proxy that the chart's trusted-proxy allow-list names; a connection from anybody else, or without that header, is refused (D111, D130, D187). No request header decides the address. A deployment without PROXY protocol — local development, and the tests — records the peer that connected to the backend.

Requests captured before v0.36.0 came through the HTTP proxy of `qa-tools.ru` and keep what it delivered: names in its canonical case and its order (D091), without the proxy's own `X-Forwarded-*` and `X-Real-Ip` from v0.11.0 on (D144), with an `Accept-Encoding: gzip` the proxy added when the sender sent none, a sender's own `X-Forwarded-For` replaced, and `httpVersion` `1.1` whatever the sender used.

A sender that ends its side of the connection before its answer is written — a TCP FIN, or a TLS `close_notify` even if it keeps reading — gets no answer, and its request is still stored. Its response record reads `aborted` on a session with a delay, whose wait ends there, and stays `pending`, shown as `unknown`, on a session without one (D187).

**Many webhooks at once** (v0.49.1, issue #144, D210; waiting line bounded v0.57.3, issue #157, D228). Capture admits webhooks by a byte budget, 64 MiB for the server and 16 MiB for one sender address ([Limits](#limits)). A burst beyond it is not lost: each webhook waits, first come first served, with its body unread, and is captured in turn, so 500 webhooks of 1 MiB sent at once from one address are all stored, one after another. A webhook that has waited 30 s is refused, `503` / `1018` with `Retry-After: 1`, and not stored. A sender with little in flight keeps a reserve: while it has at most 12 MiB of webhooks being received, the new one included, its webhooks go in at once, past the server's 64 MiB, within 16 MiB more, and ahead of heavier senders waiting, so that a flood from four addresses at once, each at its 16 MiB, no longer holds up or refuses an ordinary sender's webhooks (v1.15.11, issue #262, D261). The webhooks waiting are themselves bounded, so that a flood from one address cannot use up the server's memory while it waits: at most 16 MiB of them from one address and 64 MiB on the server, plus the first waiting webhook of each address, may wait, each counted by its headers, and one that must wait while another from its address is already waiting, and does not fit, is refused `503` / `1018` at once rather than after 30 s, however small; the first of an address to wait always waits. A burst from one address alone fills its own 16 MiB only past 512 webhooks waiting at once with up to 64 header lines each — 399 fit with 100 lines each — but while floods from other addresses fill the server's 64 MiB and its reserve, a webhook that has to wait behind another of its own address is refused at once too. A sender that leaves while its webhook waits is generally not noticed before its place comes or its wait ends: a webhook that had arrived whole is then stored, as any request that arrived whole is, or refused; one whose body was still arriving stores nothing. The configured delay begins once a webhook is stored, so a wait for room comes before it.

## Request retention
Each session stores at most the latest **1000 requests**. When exceeded, remove the oldest request(s).

## Limits
Since v0.43.0 the API is limited per client address, and the limits are published (issue #100, D201): **60 session creations and 1200 other API calls a minute**, counted apart, an IPv6 address by its `/64`. Every answer of an API route, errors included, carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`, and a call over a limit is refused `429` / `1015` with `Retry-After` before anything is done. The server also writes at most **four lists with bodies** at a time; the next is refused `429` / `1016` with `Retry-After: 1`, so a burst of 120 MiB answers cannot exhaust the backend's memory. The numbers are about three times the busiest minute observed in production and leave a CI run room for dozens of parallel sessions; they are enforced in the release that publishes them, with no report-only period (owner, 2026-10-04). Since v0.46.0 the server also handles at most **eight large bodies** of a queue save or a session creation at a time — over 128 KiB, or chunked; the next is refused `429` / `1017` with `Retry-After: 1`, for the same reason as the lists' cap (issue #106, D205: the cap is the Coordinator's choice of 2026-10-06, and eight the number a measurement of the backend as production runs it supported). Since v0.52.1 a response change, a status read, a search and a query — and since 1.3.0 a rules save (D246) — take the same eight places for such a body (issue #139, D213).

Since v0.52.1 one address may have at most **128 calls in flight** at a time on the API and the MCP server together, waits included, and a request to the application carries at most **100 header lines** (issue #139, D213; the owner's decisions of 2026-10-07). A call held open keeps what its client sent — a pending `wait` its URL and header lines for up to 30 s — and the per-minute count let one address hold a few thousand at once, enough to use up the server's memory and stop capture for everyone until it restarted. The 129th call is refused `429` / `1019` with `Retry-After: 1`, the 101st header line `431`; 128 rather than 100 so that a CI run with 100 waits pending can still make its other calls. Webhooks on the receive host keep every header line.

Since v1.0.8 the **answers still being sent** are bounded by their size too (issue #184, D228; the owner's decisions of 2026-10-18): the answers of the API and the MCP server not yet written to their clients may weigh at most **16 MiB per address** and **64 MiB on the server**, an IPv6 address by its `/64`, an answer counting from the moment it is ready until it has been written whole or its client has gone. The calls in flight bound how many calls one address holds, not what their answers weigh: a client that reads only the beginning of each answer leaves the rest in the server, about 1 MiB for the read of a session with a full response queue, and two addresses each leaving 128 such answers unread had used up the server's memory, stopping capture for everyone until it restarted. An answer that would pass either bound while its address already has another one counted is not sent: the call is answered `429` / `1019` with `Retry-After: 1` instead — the refusal clients already retry for too many calls in flight, so no new error code (the owner's decision) — and what the call did stands. An address's first answer is always sent, whatever its size, so no answer is refused for its own size. An answer is counted only while it is being written, so a client that reads each answer as it comes meets the bound only when its address has more than 16 MiB of answers being written at once — many large reads in parallel on a slow link, or many clients behind one shared address — or the server more than 64 MiB; the owner preferred this bound to fewer calls in flight or more memory for the server, which would only move the failure from 2 addresses to a few more at a lasting cost. Measured on the server limited as in production, without the proxy, a flood of 128 reads of about 1 MiB from each address, each left unread after its first 64 KiB, which had run the server out of memory from 2 addresses, was survived from **4 addresses at once** with no restart, the server's memory at most 369 MiB of its 512 MiB and every small webhook of another sender stored; from 8 addresses it still ran out of memory and restarted. Another sender's slowest small webhook took 3.4 to 3.7 s while that flood came from 1 address, 7.9 s from 2 and 16.0 to 16.7 s from 4, the server starved of CPU.

Since v1.15.15 the proxy in front of the server also limits each address on the API and the MCP server, **far above** the counts above (issue #205, D264): more than 6,000 calls within seconds, or more than 100 a second without pausing, an IPv6 address by its `/64`, are refused by the proxy itself, `429` with `Retry-After` and no `errorCode` or `X-RateLimit-*`, before they reach the server. On 2026-10-15 one address's flood of refused session creations took the server's whole processor, and Kubernetes restarted it five times, each restart stopping the API and webhook receiving for everyone; the proxy now turns such a flood away cheaply, and the server is restarted only once it stops answering for over a minute, not while it is busy. A client within the counts above never meets the proxy's limit — it lets through more than they allow within seconds, 2,520 calls at a window's edge and 5,040 during a deployment, and almost five times their rate — and still gets the server's own `429` / `1015` with its headers; the webhook endpoint, the realtime connection and the site's pages are not limited by it.

The MCP server shares these limits with the API (v0.45.0, D203): a `create_session` call counts as a session creation and every other request to `/mcp` as an API call, so an address's MCP and API calls are counted together; a tool call over a limit is refused with a tool error naming the limit and the seconds to wait.

What is not limited per minute: the webhook endpoint on the receive host, so every request within the limits is still captured, its storage bounded per session by the newest 1000 and 1 MiB a body; the realtime connection, bounded since v0.57.1 in how many one address keeps open (below); the probes.

Since v0.49.1 the webhook endpoint takes in webhooks within a **byte budget** instead (issue #144, D210): 64 MiB for the server and 16 MiB for one sender address, a webhook counting its declared body, at most 1 MiB, plus 16 KiB, 256 bytes a header line and 64 KiB for its answer, until its answer has been written. About 180 webhooks of 1 MiB at once from one address had exhausted the server's 512 MiB, stopping capture, the API and the site for everyone until it restarted. A webhook that does not fit waits, first come first served, before its body is read, and is captured as soon as there is room, while other addresses' webhooks keep going in; one that has waited 30 s is refused, `503` / `1018` with `Retry-After: 1`, and not stored (owner, 2026-10-07). Since v0.57.3 the webhooks **waiting** for room are bounded too, so that a flood from one address cannot use up the server's memory while it waits (issue #157, D228): at most 16 MiB of them from one address and 64 MiB on the server, plus the first waiting webhook of each address, may wait, each counted by its headers; one that must wait while another from its address is already waiting, and does not fit, is refused `503` / `1018` at once rather than after 30 s, with `Retry-After: 1` and the connection closed, however small; the first of an address to wait always waits, so the largest webhook a sender can send is never refused for its size.

The server's survival of a flood is measured and stated as a number of attacking addresses: it is stated to survive the hostile bursts of D228 from **4 addresses**, the smallest number measured — a flood pipelining requests down every connection an address may open, below, and a flood of large API answers left unread, above, each ran the server out of memory from 8 — the API answers in one run of two — measured again with v1.14.1; the flood of connections held for header lines that each send a head of 256,000 bytes, below, set it at 3 from v1.0.8, inferred from its measurement with v1.0.4, and since v1.14.1 is survived from **8 addresses at once**, measured, as is the same flood with every head padded with spaces, every small webhook of another sender stored (issue #242, D238); a flood of large API answers that their clients leave unread, 128 at a time from each address, measured without the proxy, set it at 1 until v1.0.8, reaching the memory limit at 2 addresses (issue #183), and is survived from 4 since the answers still being sent are bounded (above; issue #184); a flood of connections each stalled after the most header lines allowed set it too until v1.0.4, which bounds the header lines in flight (below) and was measured surviving that flood from **8 addresses at once** with no restart, every small webhook of another sender stored from up to 4 addresses (issue #182, D238); a connection that waits for header lines keeps what its sender sends past them unread, about 250 KiB a connection as measured with v1.0.4, so the same flood with every waiting connection sending a head of 256,000 bytes, over the 16 KiB limit, ran the server out of memory from 4 addresses, where without the bound the server refused those heads and survived (D238); since v1.14.1 the server's connections start with a smaller receive buffer, 16 KiB rather than 128 KiB, so such a connection keeps about 50 to 85 KiB on the server as measured, against 160 to 220 KiB without it in the same runs, and the bytes it no longer takes wait in the proxy in front of it and with the sender instead (issue #242) — and was measured surviving the waiting-line bursts this change bounds from **4 addresses at once** with no restart, with the proxy in front and the server limited as in production; from more the server may restart and recover.

Surviving is not serving everyone as usual: under the burst that fills the waiting line, 2,000 webhooks of 2,500 header lines each from every one of 4 addresses, the waiting webhooks filled the server's 64 MiB, and another sender's small webhooks were refused `503` / `1018` whenever one of its own was already waiting — between about one in twenty and about one in five of them over three runs: 31 of 576 and 34 of 824 refused at once, and 204 of 1,144 in the third run, which did not tell a refusal at once from one after 30 s — a few more were lost, 2, none and 12, 2 of them when the server, starved of CPU, took over 5 s to read their connections' first bytes, and the slowest of the rest took 16 to 69 s.

Since v0.57.4 a connection to the receive host has at most **32 requests read and not yet answered**: a sender may still send its requests one after another without waiting for the answers (HTTP pipelining), and those past 32 wait in the connection, unread, until earlier ones are answered, nothing refused and every request still captured and answered in order — in turns of 32 when the session delays its answers, and a body with many empty lines close together only once the requests before it on its connection have been answered. Before it, a flood pipelining many tiny requests down a few hundred connections restarted the server from one address; it was measured surviving that flood from **8 addresses at once**, each opening 256 connections, with no restart, with the same cost to other senders as the waiting-line floods from 4 addresses up: another sender's small webhooks were refused `503` / `1018` about one in four at 4 attacking addresses and one in two at 8, the slowest of the rest taking 15 and 45 s (issue #181, D229). Since v1.15.11 a sender with little in flight keeps a reserve (above): under that flood from 4 addresses, each opening all the 512 connections it may, every small webhook of another sender was stored in all three runs measured, where the version before refused 144 of 542 and 89 of 543 (issue #262, D261). With each address opening all the 512 connections it may have, the same flood was survived from 4 addresses and ran the server out of memory from 8.

Since v1.0.4 the **header lines** the server has read of requests still arriving are bounded too (issue #182, D238; the owner's decisions of 2026-10-18): the connections of one sender address to the receive host have at most **32,768 header lines in flight**, an IPv6 address by its `/64`, and the server at most 524,288, a line counting from the moment the server reads its first byte until the empty line that ends its headers, or until its connection closes, and a chunked body's trailer lines the same way; a body's lines never count. A connection whose next line does not fit waits in the connection, unread, until lines are given back, first come first served, what its sender sends past that line kept unread on the server, about 50 to 85 KiB a connection as measured since v1.14.1, about 160 to 220 KiB before (issue #242) — nothing refused, closed or answered for it, every webhook still captured whole with every header line in order — and the first connection of an address holding no lines, or the address's oldest holder, is never held by its address's number, so the largest webhook a sender can send, 16,320 header lines, is never held by its own size. A waiting connection keeps the server's usual timeouts, so during such a flood a webhook with very many header lines may be answered `408` after the 60 s headers timeout, a risk the owner accepted. Before it, 512 connections from one address each stalled after 16,000 header lines held a large part of the server's memory, and two such addresses restarted it.

Since v1.0.8 the unread API answers above are bounded too (issue #184, D228), and the stated number of attacking addresses was then 3, inferred from D238's `s9-big` rather than measured again; since v1.14.1 it is 4, that flood measured again surviving from 8 (issue #242, D238). A person does not press `Generate URL` 60 times a minute, so the interface did not change for #100; since v0.49.2 a refused creation says under the tile how many seconds to wait, and any other failure asks to try again (issue #128, [Landing page](#landing-page)).

Since v0.57.1 the **connections** one address holds are bounded too (issue #145, D227; the owner's decisions of 2026-10-10 and 2026-10-11): at most **512 open at a time to the receive host**, an IPv6 address by its `/64`, counted by the server from the sender address the proxy passes on — the 513th is closed with no answer and nothing is stored, a generous number so that a provider or a CI runner behind one NAT sending many webhooks at once keeps room, and a burst of 500 webhooks at once from one address stays within it — and at most **16 realtime connections at a time**, an IPv6 address by its `/64`, the 17th refused `429` / `1020` with `Retry-After: 1` before it opens. Connections that never finished their headers, or realtime connections that stopped reading, could otherwise hold enough of the server's 512 MiB to stop capture for everyone. 16 rather than the 32 first decided, because 32 realtime connections that stopped reading cost the server 128 to 178 MiB, measured. A browser shows a refused realtime connection as an interruption and keeps reconnecting with its usual delay, so a 17th tab of session pages from one network gets in once another closes, or, for a tab whose connection vanished without closing, once the server's heartbeat has cut it, within about a minute; the interface did not change. And any answer the server writes before a request's body has arrived now closes the connection, on both hosts, so a body that never comes keeps nothing; a request to a path that does not exist is answered `404` before the server reads any of its body. None of these counts writes an address anywhere; each keeps one in memory only while its connection stays open, which the Privacy Policy's `Logs` line says since v0.57.1.

**How many ordinary users at once the server serves well** was measured locally, as the floods above were measured as attacking addresses (issues #186, #188 and #261, D232): on the server limited as in production, 0.5 CPU and 512 MiB, without the proxy, each simulated user from an address of its own, **1,100 users at once were served well** in two of three runs, and 1,000 in both of theirs — 990 with a session page open, each receiving a webhook every 5 s, mostly up to 10 KiB and one in 20 of 200 KiB, and reloading the page about once a minute, and 110 CI runs, each creating a session, sending 20 webhooks a second apart, waiting for them through the API and deleting the session, about 284 webhooks a second in all: every webhook captured and stored, 99 % of them within 0.18 to 0.23 s, each on its open page within 90 ms of its capture at the 99th percentile, and no error. Served well means a capture under 1 s and the row on the open page within 2 s for 99 % of webhooks, nothing lost and no error (the owner's definition, 2026-10-12). At 1,000 and 1,100 users, in the runs served well, a page that reloaded waited longer for its list, up to 2.5 to 3.2 s at the 99th percentile, which that definition does not count. **1,200 users were not served well**, in either of two runs: nothing was lost and no error occurred, but the server's CPU was used up and 1 % of captures took longer than 2.2 s, and 6.5 s in the other run. The earlier figure, 600 users served well and 700 not (2026-10-21), was measured with a health check of the measurement's own running inside the server, a separate process every second that took about 7 % of its CPU and that production's checks, requests from outside, do not spend; the measurement now asks the server from outside too, and the server it measured carries later changes as well, among them fewer database statements a webhook (1.15.10), so the difference is not the check's alone. On production itself, from one address within the limits above, 12 users with a session page open and 2 CI runs were served well too: every webhook captured and stored, 99 % of them within 0.68 s, the network between the sender and the server included, each on its open page within 95 ms of its capture at the 99th percentile, and no error.

## Webhook Inspector UI

Desktop layout:
- shared header, its wordmark `Webhook Inspector` (D277)
- one endpoint card holding the webhook URL, **Copy URL**, the response
  button that opens the response settings, and the retention rule
- two-column master/detail workspace
- left: request list
- right: selected request details
- the footer band under both columns, which end 12 px above it (see [Footer](#footer))

The inspector has no title block of its own: the tool is named in the header, so
the workspace below the endpoint card gets that space instead (D097). For the
same reason the blocks sit close (v0.28.0, issue #96, direction B of the Figma
page `Webhook Inspector · Tighter spacing`): at every width the header, the
endpoint card, the workspace and the footer band are 12 px apart, and on the
desktop so are the two columns. The endpoint card has 12 px above and below its
contents, 8 px between its caption (`RECEIVE URL` and the retention rule) and
the URL row and, on a phone, 8 px between that row and the response button.
The side margins stay the header's: 28 px on the desktop, 24 on a tablet, 16
on a phone.

### Tablet and phone

Below 1024 px the page is laid out for touch, as drawn on the Figma page
`Webhook Inspector · Tablet and phone` (v0.19.0, issue #50, D157). Nothing on
any page is cut off or scrolls the page sideways down to 320 px wide: long
values — a URL, a header, a 1 MB body — wrap or scroll inside their own box.

- **Push flow.** The request list is the session's home screen, under the
  endpoint card. Tapping a row opens that request full-screen under a Back bar:
  `‹ Requests`, the request's position in the list (`2 of 4`), and a badge
  counting the requests that arrived while it was open (`1 new`); on a phone
  the bar ends in `⋯`, the request actions. The Back
  gesture of the browser or the device returns to the list, as `‹ Requests`
  does; the next Back leaves the session. Selecting a request never changes
  the address, and a reload shows the list; a link to one request opens it
  here as a tap does, and its `#…` leaves the address at once (D182). Opening
  a request marks it read, as a click on the desktop does. When the open request goes away — deleted here or by another
  viewer, `Delete all` — the page returns to the list. The Request/Response
  tabs and the `Raw` / `Body` / `Headers` / `Query` strip behave as on the
  desktop.
- **Tablet (768–1023 px).** The same push flow, with the endpoint card in one
  row and desktop-sized dialogs. A tablet in landscape at 1024 px is the
  desktop; rotating keeps the open request.
- **Phone (below 768 px).** The header shows the wordmark and `API docs ↗`
  only. The retention line sits under `RECEIVE URL`. The receive URL is
  shortened in the middle to keep the end of the session id in view, and Copy
  still copies all of it; the response button is a full-width row under it.
  Headers, query parameters, the fields of a form body and the headers of
  each part of a multipart body show each name above its value, and a part's
  size and kind move to a line of their own under `Part N` and its name
  (D164). Session
  response settings opens as a full-screen sheet with its actions pinned to the
  bottom; the quick switch opens as a bottom sheet; the `Delete all`
  confirmation stays a centred dialog. Toasts span the bottom of the screen.
  The `Request` / `Response` tabs each take half the row and are underlined
  across it.
- **Touch.** Rows are 64 px on a tablet, with the `×` in a column of its own,
  and 76 px on a phone: the method, short id and full time on the first line,
  the status, address and size on the second, and the `×` at the end of the
  second line, clear of the time (#55, D157). The `×` of a row is a 44 × 44 px
  target, and a tap anywhere else on the row opens the request. Buttons are 44 px high (40 px in the list header). Nothing depends on hover:
  the copy controls are always shown, an unavailable status chip gives its
  reason on a tap, the request's target wraps in its header by the desktop's
  rule (D173) and shows in full in `Raw` and `Query`, and the address and status a
  row only abbreviates are shown in full in the opened request.

The configured response is read and changed on demand rather than displayed permanently (D107, D150). The response button sits immediately right of **Copy** in the endpoint card and names the mode, the status and, when there is one, the delay, followed by a small caret — `Default · 200 ▾`, `Custom · 201 · 500 ms ▾`; its accessible name ends in `Response settings`. A custom session answering `200` is never presented as a default one. It stays reachable on an empty session, before the first request. The receive-URL field, **Copy** and the response button share one 36 px height on the desktop, and 44 px below 1024 px. The response button is outlined in a darker line than the card around it (`#9aa2b1`, 2.57:1 on white — below WCAG's 3:1 for a control's boundary by the owner's choice, D158), so beside the filled **Copy** it reads as a control of the same size; every white secondary button in the product shares that outline.

The naming separates two things that are both about a response (D113). Session-level surfaces say *configured / settings / for every captured request*; the per-request surface described below says *returned / sent / for this request*. That is what keeps the prohibition on delivery-confirmation wording true in the copy (D103).

The response can be changed from two surfaces, drawn on the Figma page `Webhook Inspector · Editable response settings` (frames C1–C8 and D1–D8, D150). There is no read-only view of the settings any more.

- **The quick switch.** The button opens a popover under it, titled `Session response`, for the frequent change: `Default` or `Custom`; with Custom, status chips `200 201 204 400 404 500 503` and an `Other` field for any integer from 200 to 599, delay chips `None 0.5 s 2 s 10 s 30 s` and a milliseconds field for anything up to 30000; and **Apply**. The two fields centre their text, the `Other` and `ms` placeholders included, as the chips centre their labels; a field holding a valid value shares the secondary buttons' outline, an untouched one — empty, or emptied by picking a chip — the chips' lighter line, and an invalid one, a field typed into and then cleared included, is outlined in red (D150, D158). Headers and body are not edited here: a note says they stay as they are, and its link **Edit headers and body…** opens the full editor. The footer names what Apply would change (`201 → 500 · 500 ms → none`, `Custom 201 → Default`), or what to fix first, and Apply is available only when something would change. While a body is set, `204` is unavailable, with the reason on hover, focus or a tap — `204 needs an empty body — clear the body first.` — and a typed `205` or `304` shows the same reason under its field. With Default picked, the popover says what the default answers and, when there is one, that the custom response stays saved and comes back on switching to Custom. Applying shows `Applying…`; a failure keeps the choice, says `Could not apply the change`, and offers `Try again`.
- **Session response settings**, the full editor: a modal opened straight into its form, with `Default` / `Custom`, the status and the delay, the configured headers with **Remove** and **+ Add header** and, under them, the headers the receiver adds itself, and the body — labelled `Body · Optional` — with, under it, the checkbox `Fill in placeholders from the request` and its byte counter (Request capture, response templates, since v1.11.0). Its fields, rules and wording are the ones the landing page's create form had until v0.20.0, and the backend checks a change with the same rules as a creation (D101). Errors are shown as the fields are edited and **Save response** is unavailable while one stands; a body set with `204`, `205` or `304` is reported on the body. With Default picked the custom fields are hidden and kept, and saving the default leaves the saved custom response as it is. What the quick switch had chosen is carried into the form. Saving shows `Saving…`; a failure keeps every change, says `Could not save the response` and offers `Try again`; **Cancel** discards the form.

Saving from either surface closes it, updates the button label and shows a toast at the bottom of the window — `Response is now 500, no delay. Requests captured from now on get it.` after the quick switch, `Saved. Requests captured from now on get this response.` after the editor. Both say what is configured and for which requests; neither is worded as a delivery (D103). Closing either surface returns focus to the response button and leaves the selected request, its tab and the arrival of new requests untouched. A session that turns out to be gone when a change is saved moves the page to `Session not found`, as any other session-level answer does.

**Access.** Whoever knows the session id can change its response, the sender included, since the id is in the receive URL it was given — the same capability that can already delete or clear the session's requests (D153).

### The response queue

Since 0.46.0 (issue #106, D205) a session may also hold a **response queue**: an ordered list of 1 to 10 responses layered over the session response, Default or Custom. Each captured request, whatever its method and path, takes the next step, unless a response rule answers it, which takes none (D246); after the last step every request gets the session response again — whatever it is then — and a used-up queue stays saved until it is removed. It is how a tester checks that a sender retries after an error: `503`, `503`, then the session's `200`, set once and run by itself, in the browser and in CI. Cycling the queue, repeating its last step, conditions on a step and reordering steps by drag are out of scope; responses by path and method came as the response rules (#134, D246), and templates in the body (#135, D251) apply to a step as to any response. It is drawn on the Figma page `Webhook Inspector · Response queue (#106) — chosen, review 2` (direction C, D205), and the section's collapsing and its `Remove queue`, since 0.47.0, on `Webhook Inspector · Collapsible response queue (#142) — approved` (D206).

- **The quick switch's section.** At the bottom of the quick switch, after the session response and its Apply, in Default and Custom alike: `Response queue`, below a line of its own, darker than the lines inside the popover and lighter than a control's border, so it reads as a feature of its own rather than part of the session response (since 0.47.0, issue #142, D206). Its heading row — the title, the state on the right and a chevron at the end, pointing down while collapsed and up while expanded — is one button that collapses and expands the section. Collapsed, only that row shows, and its right side tells the state, live: the example chips `201 → 404 · 2 s → 503` while no queue is set (on a phone, where they sit under the title, the title alone), `Step N of M` while a queue runs, `Done` once every step has answered. Open or closed is remembered in this browser, for every session alike: closing the quick switch, switching Default and Custom, a reload and another session keep it; the first time it is collapsed, and where the browser keeps nothing it is kept while the page stays open. Expanded, with no queue it shows grey example chips, `201 → 404 · 2 s → 503`, beside the title (under it on a phone), the line `No steps yet. Answered before the session response, in Default and Custom alike.` and **Set up a queue…**.
  - With a queue it shows `Step N of M` on the right and one line of chips — from step 2 on the step just answered, grey with ✓, then the next step framed, the rest grey and the session response as a dashed chip; a step that is a template ends `· Template`, `201 · Template` (since v1.11.0); what does not fit ends with `→ …` — and **Edit queue…**. Once every step has answered it shows `Done`, the dashed session response framed as the next, **Run again** — which starts the queue from step 1 again without resending it, with the toast `The queue starts again from step 1. The next 2 requests get 503.`; a failure says `Could not start the queue again. Try again.` under the links for as long as the queue stays used up — and **Edit queue…**.
  - With a queue, running or used up, **Remove queue** ends the links, in red. It asks once in their place — `Remove all 7 steps?`, or `Remove the step?` for one, with **Keep queue** and **Remove** — as the dialog's Remove queue does. `Remove` appears where Remove queue was, so a double-click or a quick second tap does not answer the question: a click on it counts only once the question has been there half a second, and never as the second click of a double-click; Enter or Space on it always does. Removed, the quick switch stays open with no toast, the section shows no queue and the button drops `· N queued`; a failure says `Could not remove the queue. Try again.` in place of the question and offers **Try again**, which removes again, beside **Keep queue**. The question goes if the queue goes meanwhile, removed by another viewer. While a change of the quick switch is in flight — Apply, Run again or a removal — the section's links wait.
- **The endpoint label** adds the steps left — `Custom · 200 · 6 queued` — and drops the suffix once none is left.
- **The Response queue dialog**, opened from the section. On the left, the steps as a timeline: each step's number right-aligned left of a line, on the line a grey dot with ✓ for a step answered in this run, a dark ring for the next one with `Next` on the right, small hollow dots ahead, a red dot for a step in error, and a dashed dot for the session response as the last row (`Default 200 then every later request`); each row gives the status, its name and the delay, and the selected step is highlighted. Under it **+ Add step**, which adds a copy of the session response, and the count, `7 / 10`. On the right, the selected step with **Duplicate**, which copies it right after itself, **Remove step**, and the response editor's own fields, rules and messages: status, delay, headers and body.
  - The footer says `Saving starts the queue from step 1; clearing requests does too. Requests waiting out their delay keep their answer.` and, while the session has a saved queue, offers **Remove queue**, which asks once in the footer — `Remove all 2 steps? Requests will get the session response only.` with **Keep queue** — **Cancel** and **Save queue**. Save queue is unavailable with no steps or with a step in error; the footer then names the step to fix, `Fix step 2 to save the queue.` Saving closes the dialog with the toast `Queue saved. The next 2 requests get 503, then the default response.` — it names the steps still to answer, so after a request already took the first it says `The next request gets 503`, as `Run again`'s does; a failure keeps every step, says `Could not save the queue. Your steps are kept — try again.` and offers **Try again**; a save refused because the server is busy with other large queues says `The server is busy saving other large queues. Your steps are kept — try again in a moment.` with **Try again**, and one refused as over 1 MiB says so and offers no retry: the button keeps reading **Save queue**, and the message goes once the steps change.
  - A step the server refuses is selected, its row marked in error and the server's message shown under the field it names, and the footer says `The server rejected step 2. Fix the marked field and save again.`, or `The server rejected step 2: <message>` when no field of the step shows it; the mark holds nothing back, the first edit takes it and the line away, and on a phone the step's row is marked and nothing opens (issue #232, D257). A refusal the dialog cannot place says `The server rejected this queue:` and the server's message. A removal that fails keeps the question's row, says `Could not remove the queue. Try again.` in place of the question and offers **Try again** beside **Keep queue**, which tries the removal again; Keep queue or an edit takes the message away, and so does the queue's going, as when a removal succeeded and only its answer was lost.
  - While a save or a removal is in flight the steps wait, read only, for its answer (issue #234): the selected step's fields, **Duplicate**, **Remove step** and **+ Add step** are unavailable, as are **Cancel** and the close control, so the queue saved is the one the dialog shows; since 1.15.6 its text fields — status, delay, the headers and the body — are drawn so too, at 60 %, as its unavailable buttons are (issue #250); another step can still be selected, and on a phone opened and left again with `‹` or `Done`, and an answer that fails makes the steps editable again. The footer's question about removing the queue goes if the queue is removed meanwhile, by another viewer. An untouched dialog follows the queue live, as the session's other surfaces do (D152); an edited one shows the queue it will save, from step 1.
- **The Response tab** of each request names the step that answered it, as a tag in its state line: `Sent by server · 35 B · [Queue step 2 of 7] · 26 Sep 2026, 11:42:14`.
- **Tablet and phone.** On a tablet the quick switch stays a popover with the same section and the dialog keeps its two columns at 704 px, the list without status names. Below 1024 px the section's heading row is a 44 px touch target (D157, D206). On a phone the section follows Apply in the bottom sheet with the example chips under the title, and its links stay 32 px tall, with Remove queue on the right; the dialog is a full-screen sheet whose list selects nothing and ends each row with `›`, a step opens as a screen of its own with `‹` back and **Done**, and Cancel and Save queue stay pinned under the list.
- **What starts it from step 1:** saving it, **Run again**, and `Delete all`. Changing only the session response and deleting one request leave it where it is.
- **Live.** The section, the label and an untouched dialog follow every capture, clear and queue change from any tab or sender, with no reload: each captured request names the step it took, and a clear starts the queue again (Realtime behavior).
- **The API** sets, restarts and removes the queue and takes one at session creation, so a CI run sets everything up in one call (API.md, Response queue).

### The response rules

Since v1.3.0 (issue #134, D246; the owner's decisions of 2026-10-19) a session may also hold up to 20 ordered **response rules**, each a method — or any method — and a path with a response of its own, so one session mocks a small API on one base URL: `POST …/orders` answered `201`, `GET …/status` `200` with another body. A captured request is answered by the first rule it matches and takes no step of the queue; a request no rule matches is answered as before, by the queue's next step and then the session response, and a session without rules answers every request exactly as before.

- **Method and path only** (decision 1): headers, query and body are not matched.
- **The path** is what follows `/s/<session-id>`, compared exactly as the request sent it — case, percent-encoding, doubled slashes and a trailing slash all count, nothing decoded, the query left out — and `/` for the session's own URL. It is an exact path, or a prefix when it ends in `*`; nothing else in it is special, and there are no regular expressions (decision 2). A `HEAD` is a method of its own.
- **Up to 20 rules** (decision 3), the whole list within the 1 MiB every call takes: 20 with ordinary bodies, about 14 at every response limit.
- **Rules first** (decision 4): a request a rule answers leaves the queue where it was.
- **Each request records the rule that answered it**, its position, method and path as they were then, which the request's detail returns.
- **Through the API** (decision 5): `PUT /api/sessions/<id>/rules` sets the whole list, `[]` removes it, `POST /api/sessions` takes `rules`, and the session read and `session.updated` carry them (API.md, Response rules).
- **Saving the rules is a use of the session**, as a response change is, and does not start the queue again.

Since v1.5.0 (issue #226) the session page sets them up too, as drawn on the Figma page `Webhook Inspector · Response rules (#134) — A APPROVED 2026-10-19` (direction A, decision 6, in the project's Figma file), modelled on the response queue's section and dialog:

- **The quick switch's section.** Under the Response queue section, below a line of its own, `Response rules`, drawn as the queue's section is: its heading row is one button that collapses and expands it, collapsed only that row, open or closed remembered in this browser apart from the queue's — the first time collapsed. Collapsed with no rules the row shows the grey examples `POST /orders` `GET /status` (not on a phone); with rules, their count on the right, `3 rules`. Expanded with no rules it says `No rules yet. A request whose method and path match a rule gets its response, before the queue and the session response.` and offers **Set up rules…**. With rules it lists them in order — the number, the method (`Any` for any, in grey), the path, a long one cut with `…`, and `→` the status and the delay, `→ 404 · 2 s`, with a `Template` tag after it when the rule's response is a template (since v1.11.0) — then `Every other request → the session response.`, or `→ the queue, then the session response.` while the queue has steps left, **Edit rules…** and **Remove rules**, in red, which asks once in place of the links — `Remove all 3 rules?` or `Remove the rule?`, with **Keep rules** and **Remove** — as `Remove queue` asks, `Remove` taken only once the question has been there half a second. Removed, the quick switch stays open with no toast and the section shows no rules; a failure says `Could not remove the rules. Try again.` in place of the question.
- **The Response rules dialog**, opened from the section. On the left, the rules in order, without borders: `⋮⋮`, the number, the method and the path, and under them `→` the status, its name and the delay; the selected rule highlighted, a rule in error in red. A rule is dragged by its `⋮⋮` to another place, or moved a place up or down with the arrow keys on it, since the first match wins. Under the list a dashed box says what every other request gets — `Every other request → the session response, Custom 200`, or the queue first while it has steps left — then **+ Add rule**, which adds a rule for any method on the session's own URL with a copy of the session response, and the count, `3 / 20`, the button unavailable at 20.
  - On the right, the selected rule: `Rule 2` `checked second`, **Duplicate** and **Remove rule**; its method as chips — `Any`, `GET`, `POST`, `PUT`, `PATCH`, `DELETE` and `Other`, which takes any other method the receiver captures, typed and suggested, in upper case; its path, typed after the session's URL, which the field draws before it, `/s/G4t2kM8qVYp3…/`, with the hint `Exact path, query ignored. End it with * to match every path under it.`; then the response editor's own fields and rules: status, delay, headers and body. A rule is checked as the API checks it, at its field: a method the receiver does not capture, a path over 1,024 characters, a character other than visible ASCII — write it percent-encoded — a `?`, a `*` before the end; the footer then names the rules to fix, `Fix rule 2 to save the rules.`, and **Save rules** waits. A path typed with a `/` of its own first — `/orders`, which saves `//orders` — or a full `http://` or `https://` URL is taken, as the API takes it, but said under the field: `The receive URL before the field already ends in /, so this matches only a path that starts with //. Leave out the first / unless you mean two.` or `This looks like a full URL. Type only the path after the receive URL: as typed, it matches no ordinary request.` Save rules does not wait for it, and a saved `//orders` opens as `/orders` with the same words, so a doubled slash, which a request may carry, stays a rule the dialog writes.
  - With no rules the right side says `No rules yet`, and Save rules saves none. The footer says `Drag ⋮⋮ to change the order. Saving applies to requests captured from now on.` — with no rules only its second sentence, and on a phone neither — and, while the session has saved rules, offers **Remove all rules**, which asks once in the footer, **Cancel** and **Save rules**, which sends the whole list in order and closes the dialog with the toast `3 rules saved. Requests captured from now on are checked against them first.` A failure keeps every rule and offers **Try again**.
  - A rule the server refuses — rare, since the dialog checks what the server checks, but met when the two disagree, during a rollout or after a limit changed — is selected, its row marked in error and the server's message shown under the field it names, as the dialog's own checks are, and the footer names it counted from 1, as the list does: `The server rejected rule 2. Fix the marked field and save again.`, or `The server rejected rule 2: <message>` when no field of the rule shows the message (issue #232, D257). The mark holds nothing back, and the first edit takes it and the footer's line away; on a phone the rule's row is marked and nothing opens, and its screen shows the mark. A refusal the dialog cannot place — from a server before 1.14.0, say — is said with the server's message after `The server rejected these rules:`, as the queue dialog says its own; a list over 1 MiB says it is too large and offers no retry.
  - While a save or a removal is in flight the rules wait, read only, for their answer (issue #226): the selected rule's fields, **Duplicate**, **Remove rule**, **+ Add rule** and the order are unavailable, as are **Cancel** and the close control, so the rules saved are the ones the dialog shows; since 1.15.6 its text fields — the method typed under `Other`, the path's box with the session's URL in it, status, delay, the headers and the body — are drawn so too, at 60 %, as the method chips and its unavailable buttons are (issue #250); another rule can still be selected, and on a phone opened and left again with `‹` or `Done`, and an answer that fails makes the rules editable again. An untouched dialog follows the rules live; an edited one keeps the viewer's.
- **The response button** adds the count to its label, after the queue's part: `Custom · 200 · 3 rules`, `Custom · 200 · 6 queued · 3 rules`. On a phone, where the button spans the card, a label too long for one line — `Свой · 201 · 30000 ms · 10 в очереди · 20 правил` at 320 px — wraps onto a second rather than run past the card.
- **The Response tab** of a request a rule answered names it beside the size, where a queue step shows its tag: `Rule 1 · POST /orders`, `Rule 3 · Any /items/*` — the rule as it was when it answered, whatever happened to the rules since. A request no rule answered shows no rule tag.
- **The request list** marks the row of a request a rule answered with that rule's number (issue #233; Figma page `Webhook Inspector · Rule marker in the request list (#233) — approved A`, in the project's Figma file): a small grey tag right after the status, `R2`, `П2` in Russian, 4 px from it and as tall as the status pill, so no row grows — grey text on the note's light fill, white on an unread row's shading. Its title, and the row's name for assistive technology in its place, is `Answered by rule 2` (`Ответило правило 2`). The number is the rule's place when it answered, which is all the list carries (D246 point 8): the rules saved since may hold another rule there, so the row names no method and no path, and the Response tab names the rule in full. A row no rule answered — the queue or the session response did, there is no response record, or it was recorded before 1.3.0 — shows nothing new. The status and the tag never shrink; on a narrow row only the address is cut, and at 320 px rule 20 beside a long IPv6 address and `1018.4 KB` still fits, the time and the `×` in their places (D157). The tag appears live, with the row's recorded response.
- **Tablet and phone.** On a tablet the dialog keeps its two columns at 704 px, the list 236 px and the method chips wrapping. On a phone the section follows the queue's in the bottom sheet, with its links 32 px tall and Remove rules on the right; the dialog is a full-screen sheet whose list ends each row with `›` and has **Remove all rules** as a link under it, a rule opens as a screen of its own — `‹` back, `Rule 1 of 3`, the hints over the fields, **Duplicate rule**, **Remove rule** and **Done** — and Cancel and Save rules stay pinned. At 320 px nothing scrolls sideways.
- **Every viewer follows**: rules saved in one tab appear in every other tab on the session with no reload (D152). A page talking for a moment to an earlier image — during a rolling update or after a rollback — keeps the rules it shows when that image's `session.updated`, session read or answer says nothing of them, and one that says none clears them (D246 point 13).

Request list rows include:
- HTTP method
- first 7 characters of the request UUID
- the response status recorded for that request, or `Not recorded` where there is no response record (D119)
- for a request a response rule answered, that rule's number after the status, `R2` (issue #233; Response rules, above)
- source IP, compacted to fit the row
- exact received time, in the row's compact form `2026-09-17 14:32:06` (see Time display)
- body size, in the compact unit used everywhere else in the application, for example `172 B` (D014)

Do not show the webhook path in each row.

**Filtering the list** (v0.30.0, issue #70, D180; Figma page `Webhook Inspector · Request list filter`, direction 2; headers and bodies since v0.37.0, issue #78, D191; Figma page `Webhook Inspector · Body and header search`, direction A). The list can be narrowed at once, in the browser, by what its rows carry, and the same field finds a text anywhere in a request — body, headers, path or query — which the server searches:

- With no filter a search icon button sits beside **Delete all**, 31 px on the desktop and 40 px below 1024 px, outlined like the other controls. Activating it turns the header row into the field, empty and focused, with the placeholder `Search the list, headers and bodies`, and `Search, bodies too` on a phone. The `Requests` heading and the count are hidden visually and stay for assistive technology. Escape, `×`, or leaving the field while it is empty brings the heading back. The field keeps 8 px from **Delete all** at every width.
- With a value, the field ends in the match count and `×`: `3 of 8 / 1000` on the desktop and tablet, `3 of 8` on a phone. The count is of the rows shown, those found in headers and bodies included. `×` clears the filter and brings the heading back. On a phone with no filter the count beside the icon reads `3 / 1000`, without `requests`.
- The query is trimmed and split on whitespace, and every word must occur, case-insensitively, in at least one field of the row (`POST 500`). The fields are the method; the status text the row shows (`200`, `Pending`, `Failed`, `Not recorded`); the sender address in full and as the row shows it; the time as the row shows it, in the viewer's timezone; the full request id, so a few characters of it or a pasted `X-Webhook-Inspector-Request-Id` or `X-QA-Tools-Request-Id` find the request; and the path after `/s/<session-id>`, as stored (D173). Body size is not matched. A short fragment matches many rows — `12` also matches times — which is accepted: one box over every field was chosen for speed and simplicity. A request stored before paths were recorded (D110) is never matched by its path.
- **Headers and bodies.** A word also matches a row when it occurs in the row's **Raw**: the stored raw request — the request line with the path and query as received, every header as `Name: value`, the blank line and the body — which is what the `Raw` tab shows. So a row matches when every word is in one of its list fields or in its Raw: `POST 48213` finds a POST whose body holds 48213. In Raw a word is matched as the exact bytes of its UTF-8 encoding, **case-sensitively**, on the server: `x-signature` does not find `X-Signature` there, and a body that is not UTF-8 is matched byte for byte. Only words of 3 bytes or more are searched in Raw; a shorter word matches list fields only, and a query of only such words asks the server nothing. At most 8 searchable words of at most 200 bytes each: beyond that Raw is not searched for the query and the list-field filter still applies. No regex, no query syntax and no field selector.
- The search starts by itself, 400 ms after typing stops — no Enter, no button, no mode — and one runs at a time per tab. While a query with a searchable word is active it runs again 1 s after new requests arrive, so a request whose Raw matches appears within about a second; until then an arrival shows if its list fields match. After a search that timed out, was refused as busy or failed, arrivals start no new one: only **Retry**, a new query or the list reload on reconnect do. A filter restored on reload is searched at once, and the list reload on reconnect searches again. The words are sent in the request's body, never in its address, so they reach no log.
- Nothing new shows in the common case: rows found in Raw simply appear, with no line, badge or marker saying where they matched. A search still running after 300 ms shows a small spinner in place of the count; a faster one shows nothing. While it runs and no list field matches, the list reads `Searching headers and bodies…`.
- **Headers and bodies not searched.** Only then, an amber notice at the top of the list says `Headers and bodies not searched:` and why — `it took over 2 s.`, `the server is busy.` (two searches were already running) or `the search failed.`, each with **Retry**, and `a word is over 200 bytes.` or `more than 8 words.`, without. The rows the list fields match stay under it, and it goes with the next search that succeeds. The reason starts a new line unless it fits whole.
- Where the matched text appears in a row — method, short id, status, address, time — it is highlighted in `#ffe9a8`. A match in the path, which rows do not show, has nothing to highlight, and neither has a row found only in Raw.
- The filter is live: a request arriving over realtime appears only if it matches, and a row whose status changes (`Pending` → `200`) enters or leaves the list accordingly. The browser tab title still counts every unread request, filtered or not (D078).
- Nothing matches: `No requests match “<query>”` and a **Clear filter** action, centred in the list — never `Waiting for the first request`. When headers and bodies were searched too, a line between them says so: `Headers and bodies were searched too.` When they were not, that line is the reason, with **Retry** beside **Clear filter** where another attempt can change it. With no word of 3 bytes the empty result is as it was. An open request the filter hides stays open. Below 1024 px the Back bar's `N of M` counts the filtered list, and `K new` counts only arrivals that match.
- **Delete all** still deletes every request in the session. Under a filter that hides some, its dialog says so: `This will permanently delete all 3 requests from this session, including 1 hidden by the filter. This action cannot be undone.` With nothing hidden it is unchanged.
- The filter text is kept per session in this browser's storage and restored on reload, the page opening with the field showing it; another session starts unfiltered. Other open tabs pick it up on their next reload, not live. It is dropped with the session's read state, 7 days after the viewer last used the session (D156). Where storage is blocked or full, the filter belongs to the tab alone.

The status a row shows is the one the backend **recorded for that request**, never one derived from the session configuration (D119). A request with no stored response record reads `Not recorded`; while a configured delay holds the reply, the row reads `Pending`. The configured status stays visible on the endpoint card, where it is unambiguously configuration. No status here is a confirmation that the sender received the answer: `sent` means the backend finished writing the response into the connection, and a request whose sender disconnected during a configured delay is stored and listed like any other.

**How a status is drawn** (since 0.48.0, issue #138, D207; Figma page `Webhook Inspector · Response status colour`, sub-variant C1). A status is what the tester configured, so no status reads as an alarm or a reassurance: an answer the session gave — a finished write, state `sent` — shows its code in a soft, fully rounded pill tinted by its class, green for 2xx, grey for 3xx, amber for 4xx and red for 5xx, each code readable at WCAG AA on its tint. In a row the pill holds the code alone, 11 px; in the Response half's heading it holds the code, 14 px, and the reason phrase follows it in ink, `500` `Internal Server Error`, or the pill stands alone for a code without one, `299`. The pill never wraps or shrinks: on a narrow phone a long phrase wraps beside it. A filter match in the code is highlighted inside the pill, and row heights are unchanged. Everything else keeps its look: `Pending` is muted, `Failed` — or the code where one was composed — is red, because our own write threw, and `Not recorded` is muted; a send that was aborted or whose outcome is unknown shows the bare code, muted in the row and ink in the heading, because the sender may never have received that answer. In the heading a pending or failed `400` to `599` stays red, as before. The quick switch's chips, the full editor and the response queue's chips show configuration and keep their look.

Request details include:
- method, path and HTTP version
- received time
- the sender's source address, written in full
- body size
- headers
- query string
- raw body representation
- the complete raw request
- the recorded response for that request

The panel has two levels of tabs, both with an underline indicator rather than buttons or a segmented switch (D113). The active tab's underline runs 12 px past each side of its label, on both levels; the phone's `Request` / `Response` tabs, which each fill half the row, are underlined across the whole tab (D158). The top level is `Request` / `Response`. The Request side carries `Raw`, `Body`, `Headers` and `Query`; the Response side carries `Raw`, `Body` and `Headers`. URL and query belong to the Request side only: the Response side invents neither, and a redirect target appears as a `Location` header row. The `Raw` tab of either side shows the stored representation — for a request, its request line with HTTP version, headers and body. A representation with no body — a `GET`, a `204`, a custom response with no body, a HEAD response — ends on screen at its last header line, without the empty line that closes a head; its copy control still yields the stored text, which ends in that empty line (CRLF CRLF), so a copied request replays as it arrived (D158). With a body, the empty line between head and body is shown as stored. The `Query` tab shows each parameter **decoded**: percent-escapes are resolved and `+` is read as a space, so `?sig=abc%2Bdef` is listed and copied as `sig=abc+def`. It is the one place the panel does not show the received bytes as they arrived — together with `Body` of a form, which is the same data in the same shape (below) — and nothing is lost by it: `Raw` carries the query string in its encoded form. Decoding is strict UTF-8: a query string with an escape that is not UTF-8, such as `?name=%C8%E2%E0%ED` ("Иван" in windows-1251), is not drawn as rows of replacement characters but shown as stored under `Not decoded: this query string is not UTF-8.` An escape that is not an escape at all, such as `100%` or `%zz`, stays literally in its cell (D162).

`Raw` never shows less than `Headers` does, a representation that is not valid UTF-8 included (D145). Its request line or status line and its headers are still shown as text, then the blank line, then the body: as text where the body is UTF-8, and otherwise as the Base64 of exactly its bytes — the same string the `Body` tab shows, unless `Body` draws a multipart body as its parts (D164) — with `Body shown as Base64 because it contains non-UTF-8 bytes.` A header carrying a byte that is not UTF-8, such as `0xE9`, is shown one character per byte, which is how `Headers` shows it, with `Headers shown as Latin-1 because they contain non-UTF-8 bytes.` Both lines follow whatever the tab says about a representation that is text. The Response side applies the same rule and would keep its recorded-representation line, but no response the backend records is binary today: a configured body is text, and configured header values are ASCII.

A newly selected request opens on Request → `Raw`, and so does each request selected after it (D107). The first switch into the Response side within one selection lands on `Body`; after that each side keeps whatever tab was last chosen on it. Switching tabs by hand applies to the request currently selected: a newly captured request arriving over the realtime connection, and opening, closing or saving the response settings, leave that choice alone. Neither tab is remembered across selections or reloads.

The Response side opens with the status line and how sending ended, and, for every state but a normally finished write, a third line saying what that means. The status line is the HTTP version, `HTTP/1.1`, then the status: an answer the session gave shows its code in its pill with the reason phrase beside it (How a status is drawn, above; D207). A finished write of a readable body says how large it was and when the write completed, `Sent by server · 62 B · 17 Sep 2026, 14:32:06`; no other state line carries a time. `Sent by server` is itself the observation boundary — the server finished writing, and nothing more is claimed — so a finished write has no third line (v0.20.0, D158; until then it read `Server finished writing the response. Client delivery is not confirmed.`). A HEAD response keeps its third line, `The prepared body is stored for inspection. HEAD responses do not send it.`, and so do `Pending`, `Send aborted`, `Send outcome unknown` and `Sending failed`. A request with no stored response record shows `Response not recorded` over `There is no stored response for this request. Its request data is still available.`, and never an empty response or an invented one. The send state is shown here, in the response details, and is not repeated in the list rows. These lines are live: a request opened while a configured delay is still holding its reply reads `Pending` and then moves to the recorded response on its own, without being selected again (D125). The tab chosen on either side is not disturbed by that update.

The Request side opens with the method and target, on as many lines as the target takes (D173), then the request facts, which read `HTTP/1.1 · 61 B · 145.40.74.12 · 17 Sep 2026, 14:32:06` (D141, D148). The sender's address is one segment of that line, between the size and the time, in the same size and colour as the rest of it, with no label in front of it and no flag, country code or globe anywhere (D123). It is written in full, an IPv6 address included; only a list row shortens it, and the Request `Raw` tab then says `The full sender address is shown above. List rows keep a compact address.` Where there is no address the segment reads `IP unavailable`, in the same position and between the same separators — `IP not stored` for a session created to keep no sender address, as its list rows do (v1.7.0, D249) — and a request captured before the HTTP version was recorded drops only that segment (D110, D120). An address the answer gives in any shape other than text, such as a number, an object or an array, counts as no address, here, in the list row and in the filter alike: it reads `IP unavailable` (or `IP not stored`) rather than leaving the page or the panel unable to draw (v1.15.2, issue #245). A Response side in any state but a normally finished write keeps three lines (a HEAD response keeps its note), so switching sides then moves the tabs by one line; the Request side is deliberately not padded to match.

**No country is shown for any sender.** Country resolution was removed rather than finished: nothing is looked up, stored or shown, and there is no geodata dataset and no attribution line anywhere in the product (D140). The address itself is **the original sender's** in production: Traefik has forwarded external traffic to local endpoints only since 2026-09-21 and the trusted-proxy allow-list names the in-cluster proxy, so what the panel shows is the address the request came from (D111, D130). Where no allow-list is configured — local development, and any other deployment that has not set one — it is the peer that connected to the backend, which is the honest answer there. The IPv6 path is unverified on production, since neither the host nor the probe had IPv6.

The Body tab renders valid JSON re-indented and well-formed XML indented for display, up to 256 KiB. The re-indenting only changes the whitespace between tokens: a number is shown exactly as it arrived, duplicate keys are all kept in their original order, and escape sequences are not rewritten (D112). Valid JSON nested more than 100 levels deep — more than 100 objects and arrays open at once — is not re-indented but shown as stored, under `Formatting unavailable: JSON nested more than 100 levels deep is shown as stored.` (D169). Valid JSON whose re-indented text would be longer than 2,000,000 characters is shown as stored too, under `Formatting unavailable: JSON that formats to more than 2,000,000 characters is shown as stored.`, a limit meant for bodies built to be drawn large: ordinary JSON under the ceiling formats to a small multiple of its size (D169).

XML is indented, two spaces per level, only where an element holds at least one child element and, beside it, nothing but comments and processing instructions; an element with any text in it, and one marked `xml:space` `preserve` with everything inside it, is shown exactly as stored, and tags, attributes, CDATA, comments, references and the declaration are never rewritten (D163). The same cap applies to XML: well-formed XML whose indented text would be longer than 2,000,000 characters is shown as stored under `Formatting unavailable: XML that formats to more than 2,000,000 characters is shown as stored.` (D163).

A body labelled `application/x-www-form-urlencoded` — in any case, with or without parameters such as `; charset=UTF-8` — that is neither valid JSON nor well-formed XML is drawn as `Query` draws a query string: decoded name/value rows in the order they arrived, repeated names kept, copied one `name=value` per line, with the encoded body in `Raw` (D162).

A body labelled `multipart/*` with a `boundary` parameter that is neither valid JSON nor well-formed XML is drawn as its parts, in the order they arrived, one box per part under `N parts, split at the boundary declared in Content-Type.` (D164). It is split from its exact bytes, so a file upload — a binary body — is split as a text body is, and `Raw` does not change. The one exception is a text body that began with a byte-order mark, which the backend removes when it decodes the body: that body is split as if it began after the mark (D164). Each box starts with `Part N`, the part's `name` where it has one, and on the right what it is and its size: `text · 16 B`, or for a file `invoice.pdf · application/pdf · 47.1 KB`. Then come the part's own headers as name/value rows, a rule, and its content exactly as stored — JSON, XML or form content inside a part is not formatted — with a copy control that copies exactly that content. A part that is not UTF-8 shows `Binary content, not shown. Its bytes are in Raw.` instead, with no copy control. A part that is itself `multipart/*` is one part and is not expanded, and bytes before the first boundary or after the closing one are not a part; the caption says where there are any. A multipart body with no boundary parameter, whose boundary never starts a part, or with no closing boundary is shown as it would be without the label, with a line saying why it was not split after the line it already carries. A binary multipart body whose parts other than binary content exceed 256 KiB is shown as Base64 with a line saying so; only CRLF line endings are split.

JSON and XML describe themselves and are recognised from the text, so a valid JSON body is re-indented and a well-formed XML body indented whatever its `Content-Type` claims, and a body shaped like a form without that label is not drawn as rows; a form cannot describe itself, and a multipart body's boundary is only in its label, so those two are the formats read from the header. A form body with an escape that is not UTF-8 (`Not decoded: this form body is not UTF-8.`) or with no pairs at all, such as `&&&` (`Not decoded: this form body has no name/value pairs.`), is shown as stored. Anything else — invalid JSON, XML that is not well-formed (HTML such as `<br>`, or content after the root, included), a body over the ceiling, a binary body that is not split into parts — is shown as stored, always with a short line saying why it was not re-indented. Which line is chosen by how the body starts, after a byte-order mark and white space: `{` or `[` says it is not valid JSON, `<` that it is not well-formed XML, and anything else, such as `hello`, that no JSON or XML structure was recognised. XML with a DOCTYPE, whose DTD the viewer does not read, and XML nested more than 100 levels deep say that instead (D163), as does JSON nested more than 100 levels deep (D169), and JSON or XML that would format to more than 2,000,000 characters (D169, D163); a body that is also too deep, has a DOCTYPE, is not well-formed or is over the ceiling keeps that line.

An empty body keeps its placeholder, whatever its label. There is no Formatted/Original control: the stored representation lives in `Raw`, which is never re-indented on either side. There is no `Content-Type` caption above the body either; the real header is in `Headers` and in `Raw`, and a caption says what the view did, never what the sender claimed.

Under the `Raw` / `Body` / `Headers` / `Query` strip, the tab area is the panel's one scroll, and it scrolls down only; the request header and both strips stay where they are (D149). The code box in it never scrolls: it has no height limit, it is as wide as the panel and exactly as tall as its lines, so a short block ends under its last row with empty panel below it, and a long body simply continues down the tab area. Choosing another tab starts it at its top.

Every code block wraps its lines, and nothing in the panel scrolls sideways (D134, D149). `Raw` on both sides, a body above the ceiling, a body shown as stored and every Base64 rendering wrap at the box's edge. Re-indented JSON and indented XML wrap with a **hanging indent**: a continuation starts two characters deeper than its own line, so the nesting stays readable, and a JSON value too long for its row starts beside its key. An empty line in XML shown as stored keeps its row (D163). The one exception is nesting nearly as deep as the box is wide (past 48 levels in a 1440 px window, 19 in a 1024 px one): there a continuation keeps 16 columns to wrap in rather than running out of the box (D149). `Headers`, `Query`, the rows of a form body and the headers of each part of a multipart body wrap a long value inside the value column, and every name keeps its row; a part's content wraps at its box's edge (D164). A run without spaces breaks anywhere, mid-token included, and no mark is drawn at a break. A block's caption sits above the box, so it is read before the content, and wherever a line actually wraps it says `Long lines wrap; the breaks on screen are not in the content.`, so that the breaks on screen are not mistaken for breaks in the data. The request `Headers` caption reads `Headers as received by the server.` Copying is unaffected — it yields the block's content, not the lines the browser drew. None of this applies to the `JSON body` field of Session response settings, which is a form field, not a code block (D150).

The header shows the target beside the method as one run of text in three parts, with no gap between them (D173, Figma `Webhook Inspector · Request path in the details`, variant 3.2+): the session part `/s/<session-id>`, then the path the sender added after it in monospace, then the query string, `?` included, in smaller muted monospace. `/s/<session-id>` may break at any character. The path and the query are never split between lines: each continues the current line if it fits there whole, and otherwise starts a line of its own, so a request that fits on one line is one line and a short path never gets a line to itself. Only a part longer than a whole line breaks inside itself: the path wraps at any character for up to three lines and then ends in `…`; the query stays on one line and ends in `…`. `Raw` and `Query` show both whole. A trailing slash stays with the session part — a lone `/` is not a path — and the path is shown exactly as stored, percent-encoding included. A request stored before paths were recorded shows the method alone (D110). The rule is the same at every width; on a phone `/s/<session-id>` takes two lines, and a short path or query continues the second. The header has no hover title.

Every code block — `Raw`, `Body`, `Headers` and `Query` on both sides — carries a small copy icon inset at its top right (D122, which supersedes D031 and lifts the two `Copy body` exclusions below). In the detail panel the icon has a column of its own that no line runs under, and while a box taller than the tab area is scrolled past, it stays at the top of the part of the box still visible and leaves with the box's bottom edge (D149). It copies the **whole** text that block displays, never the fragment on screen: `Body` yields the re-indented or indented text as displayed, `Raw` the stored representation as displayed — for one that is not UTF-8, its text and its Base64 exactly as on screen, and for one with no body, the stored text with the closing empty line the screen leaves out (D158) — a binary body its Base64 block, `Headers` and `Query` their full contents, and a form body its decoded rows, as `Query` does (D162). A multipart body drawn as its parts has no copy icon of its own: each part whose content is shown carries one, which copies exactly that content, and the whole body is copied from `Raw` (D164). The confirmation appears only after the clipboard write succeeds, and the control is disabled when there is nothing to copy. A browser that refuses the write confirms nothing and says so to assistive technology instead - the text stays on screen and selectable by hand - so the refusal is never shown as a success. There is no textual `Copy` beside the tabs; the receive-URL **Copy** button is unchanged. The strip holds its views and nothing else: `Copy as cURL` and `Copy link` are request actions, below (D182). The settings modal's body box, which D122 also gave an icon, went with the read-only modal (D150): a configured body is now edited in the `JSON body` field of Session response settings, a form field rather than a code block, with no copy control.

**Request actions** (D182, Figma `Webhook Inspector · Request actions`, direction C). Every action on the selected request is in one menu. From 768 px up, `Actions ▾` ends the `Request` · `Response` row, link-coloured, on both halves; it opens a menu under it holding `Copy link` and `Copy as cURL`, then, after a divider, `Download JSON` (D185), `Check signature…` (D197) and `Compare with…` (D186), 36 px rows on the desktop and 44 px on a tablet. It works from the keyboard as a menu button does: Enter, Space or Down open it, the arrows move, Enter chooses, and Escape closes it, focus returning to `Actions`. On a phone the Back bar ends in a 44 × 44 `⋯`, which opens the same actions as a bottom sheet titled `Request actions` over a scrim; a tap on the scrim or Escape closes it and focus returns to `⋯`. Choosing an action closes the menu or the sheet — `Check signature…` opens the check in the menu's place, and on a phone in the same sheet — and the toast at the bottom of the window confirms the copy — `Link copied`, `cURL command copied` — only once the clipboard write has succeeded. `Download JSON` shows no toast. A browser that refuses the write gets the toast with an info icon saying what was not copied, such as `The browser refused the copy. The link was not copied.`, never a success.

**Copy link** (D182). It copies `<origin>/v/<session-id>#<request-id>`, the full request id after the `#`; in a private session, since v1.15.0, a link with access to the request, `<origin>/v/<session-id>#key=<key>&request=<request-id>`, under the same label, and the toast reads `Link with access copied` beside a lock (decision 8 of #228, D259). The browser does not send what follows a `#`, so the server, and every log, sees the session's own address. The link grants exactly what the session's address grants — anyone with it may access the session (D004) — so it comes with no warning of its own. Whoever opens it gets the session with that request open and read, at every width; below 1024 px Back returns to the list and the next Back leaves the session, and on the desktop Back leaves the session. The `#…` is removed from the address as soon as the page has read it, whatever it held but a move link, which the page leaves for its reload to read (see [Moving to webhook.qa-tools.ru](#moving-to-webhookqa-toolsru); since v1.19.13, #362), so the address bar reads `/v/<session-id>`; selecting other requests does not change it, and a reload shows the list with nothing open. A request the session no longer holds — deleted, or pushed out of the newest 1000 — opens nothing: the list shows, and a toast with the info icon says `The linked request is no longer in this session.` A `#` holding anything but a request id or a move link is removed and ignored. A linked request the list's filter hides opens, and the filter stays. The link is read when the page loads: pasted into a tab already showing that session, it is read on the next reload — except a link with access, whose key is read at once (since v1.15.0, D259).

**Copy as cURL** (D167, which lifts the exclusion D031 and D122 kept; a request action since D182). It is in the request actions on both halves, and copies a command for a POSIX shell (sh, bash, zsh) that re-sends the selected request: pasted unchanged it is captured again by the same session on the same path, and pointed at another host it replays the webhook against the user's own server. The command is `curl` with the webhook host's address — the origin of the session's receive URL, `https://hook.qa-tools.ru` since v0.36.0 (D187), where `Copy link` keeps the page's own — the path exactly as stored — `/s/<session-id>` for a request captured before paths were stored — and the query string, and one option per line:
- the method as curl needs it: `--head` for `HEAD`, nothing for `GET` without a body or `POST` with one, `-X <METHOD>` otherwise;
- the headers in the order and letter case they arrived, repeated ones repeated, less `Host` and `Content-Length`, which curl computes, and the connection's own headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Proxy-Connection`, `Expect`). Every other header is kept, `X-Forwarded-*`, `X-Real-Ip` and an `Accept-Encoding: gzip` included, for every request (v1.0.12, issue #114): since v0.36.0 a capture holds only what the sender wrote (D187), and a request captured earlier is not told apart, so its `Accept-Encoding: gzip` — and, before v0.11.0, its forwarding headers — may be the proxy's and are replayed just the same. A server that answers a replayed `Accept-Encoding: gzip` with a gzip body gets it printed by curl undecoded: the command adds no `--compressed`. A header that arrived empty is sent empty, and curl's own `User-Agent`, `Accept` and form `Content-Type`, which the sender never sent, are switched off;
- the body byte for byte: text up to 64 KiB inline, larger text piped in from `printf`, and a body that is not UTF-8, or text holding a carriage return or another control character a paste would change, piped in as Base64 through `base64 --decode`. A text body that began with a byte-order mark gets it back.

`--globoff` and `--path-as-is` are added where curl would otherwise rewrite the address. The toast `cURL command copied` confirms it once the clipboard write succeeds; a refused write gets `The browser refused the copy. The cURL command was not copied.` with the info icon. Neither Windows `cmd` nor PowerShell is served.

**Download JSON** (v0.34.0, issue #73, D185; Figma `Webhook Inspector · Request actions`, C2, C5). The first item after the divider in the request actions, on both halves and in the phone's sheet, with a download icon. It saves the selected request as one file, `webhook-inspector-request-<short id>.json`, the short id being the first 7 characters of the request id that its list row shows, e.g. `webhook-inspector-request-2b906b8.json`; the file has carried the service's name since 1.19.12 (issue #349). The file is the answer of the detail endpoint `GET /api/sessions/:sessionId/requests/:requestId` exactly as the panel holds it, written with two-space indentation: the request, its headers, body and raw form, the sender's address, and the recorded response with its timings, or `null` when none was recorded. A body that is not UTF-8 is there as Base64 (`bodyBase64`, `rawBase64`), so nothing is lost. The file is built in the browser from what the panel already has, and nothing is sent to the server. It follows the panel: a delayed response recorded while the request is open (D125) is in the next download. Nothing is masked — `path` and `raw` carry `/s/<session-id>`, which grants access to the session, as `Copy link` and `Copy as cURL` do — and there is no warning beside the item. There is no toast either: the browser shows the download itself, and the page cannot know the file was saved. While the details are loading or failed, there is no `Actions ▾`, and the phone's `⋯` is disabled, so the item is not offered.

**Compare with…** (v0.35.0, issue #75, D186; Figma `Webhook Inspector · Compare requests`, direction A, frames A1–A7 and D1–D4). The last item of the request actions, after `Check signature…`, on both halves and in the phone's sheet. It compares the open request with any other request of the session, which the tester chooses in the list; the response half is not compared.

*Picking.* The list header turns `#e7f0ff` and reads `Compare with…` over `Choose a request for <method> <short id>` (on a phone `Tap a request for <short id>`); the filter icon stays, so the filter narrows the candidates, and `Cancel` takes the place of `Delete all`. No row shows `×`. The open row says `open` and cannot be chosen. On the desktop a hovered row shows a `Compare` chip where its `×` was. A click, a tap or Enter on any other row chooses it; `Cancel` or Escape leaves picking with nothing changed — back to the open request, or, when picking began with `Change` or `Choose another`, back to that comparison on the view it showed. Below 1024 px picking is the list screen itself, in picking mode, and `Cancel` or the browser's or the OS's Back returns the same way.

*The comparison.* It takes the panel's place — below 1024 px the detail screen's, under the usual Back bar. The `Request` · `Response` row becomes `Comparing` · `Change` · `Close ×`: `Change` picks again for the same open request, `Close` returns to the open request, and a click on another row in the list opens that request normally and ends the comparison. Back below 1024 px returns to the list, as from any request. Two lines name the requests: the open one first, marked `−` and `open`, then the chosen one, marked `+`, each with its method, short id, time and body size. The open request is always `−` and the chosen one `+`, whichever is newer. While the comparison is shown both list rows carry their `−` / `+` after the short id. The views are `Raw`, `Body`, `Headers` and `Query`, and a dot after a name marks a view that differs. The comparison opens on `Body` when the bodies differ, else on the first view that differs in the order `Raw`, `Headers`, `Query`, else on `Body`. Each view is one column at every width: removed lines on a light red with `−`, added lines on a light green with `+`, and inside a changed pair of lines the changed characters underlined in a darker tone. Up to three unchanged lines are kept next to each change; where more than three further unchanged lines would follow, they fold into `N unchanged lines · Show`, and `Show` opens them in place. Lines wrap; nothing scrolls sideways, at 320 px either.

*What is compared* is the text each view displays, so what is read is what is compared, and nothing stored changes (D007): `Raw` as the `Raw` view shows it, `Body` as `Body` shows it — JSON re-indented (D112), XML indented (D163), a form as decoded rows (D162) — and `Headers` and `Query` one `Name: value` or `name=value` line per pair, in their recorded order with duplicates kept (D045). A binary body, a body above 256 KiB, a multipart body drawn as its parts (D164), a `Raw` that is not UTF-8 and a `Raw` above 256 KiB are compared only as a whole: `The bodies differ.` with both sizes, or e.g. `The bodies are binary and identical: 4.1 KB each.` Two views with more than 1000 changed lines between them say `Too many changes to show line by line.` with both sizes, so the tab never freezes. Two identical requests say `The two requests are identical in every view.`, with no dots and each view folded; a view with no differences while others differ says `No differences in <view>.` above its folded content. A chosen request that is deleted — here, by another viewer, by `Delete all` or by the 1000-request limit — before or during the comparison is shown as `<method> <short id> is no longer in this session.` with `Choose another`; if the open request itself is deleted, the panel closes as it always does. Only the chosen request's details are loaded, by the existing detail call; nothing else is sent to the server. Choosing a request marks it read, as opening it does.

**Check signature…** (v0.39.0, issue #74, D197; Figma `Webhook Inspector · Check signature`, direction B, frames B1–B5 and S1–S5). The item after `Download JSON` in the request actions, on both halves and in the phone's sheet, with a shield icon. It checks whether a header of the selected request holds the HMAC of its body under a secret the tester types, in the browser: nothing is sent to the server. Chosen on the Response half, it checks the request all the same.

*Where it opens.* From 768 px up the menu closes and a 400 px popover titled `Check signature` opens in its place, under `Actions`, its right edge by the panel's; it closes on Escape, on its `×` or on a click outside it — a click on another request included — and focus returns to `Actions`, unless that click put it on another control, a field or a row, which keeps it. On a tablet its controls are 44 px tall and `×` is a 44 × 44 target. On a phone the `Request actions` sheet becomes `Check signature`, with 44 px fields and 16 px text; a tap on the scrim or Escape closes it and focus returns to `⋯`. Focus goes to the secret field while it is empty, otherwise to the header. If it is taller than the room under `Actions`, the popover scrolls inside, and the sheet scrolls as the actions sheet does; at 320 px nothing scrolls sideways.

*What is signed* is the body exactly as it arrived, and only the body: a body that is not UTF-8 as its bytes, a text body that began with a byte-order mark with the mark put back (D043), and an empty body — or a `HEAD`, which has none — as zero bytes. The bytes are the ones `Copy as cURL` re-sends.

*The inputs.* `Signature header` lists the request's headers, one entry per name whatever its letter case, a repeated one as e.g. `X-Hub-Signature-256 (2 values)`; it opens on the first header whose name contains `signature` or `hmac` in any case, and on none — `Choose a header` — when there is no such header. `Secret`, masked, with an eye that shows and hides it; its UTF-8 bytes are the key; beside it: `Computed in your browser. Not sent or stored. Use a test secret.` `Algorithm`: SHA-256, SHA-1 or SHA-512, preselected from the chosen header's value — the algorithm an `sha1=`, `sha256=` or `sha512=` prefix names, else the one whose digest length the value has in hex (40, 64 or 128 characters) or Base64 (28, 44 or 88), else SHA-256 — and switchable by hand. So GitHub's `X-Hub-Signature` (`sha1=`), preselected as the first such header when it comes first, and its `X-Hub-Signature-256` both match with nothing changed. Choosing another header preselects its algorithm again.

*The result*, computed as the tester types, in a grey box under the form. A header's name too long for the box's line wraps inside it, so nothing scrolls sideways; assistive technology is told the verdict and the line under it as they change, not the computed value. The header's value is compared with the computed HMAC in hex, in either case, and in Base64, as a whole and after a prefix such as `sha256=`; there is no input for the encoding or the prefix. A repeated header matches when any of its values does. `Match`, green, names what was compared — `HMAC-SHA256 of the body, 159 bytes · hex · X-Hub-Signature-256`, with `, value 2 of 2` after the name when the second value of a repeated header matched. `No match`, red, says the same without the encoding, then `Computed` and the value in the header's form — its prefix, renamed for the algorithm checked when it names one, and its encoding, hex in the case it uses or Base64, bare lower-case hex when the value has no readable form — with a copy icon (D122), and the hint `Stripe, Slack and Standard Webhooks sign a timestamp or an id together with the body, so a check of the body alone never matches them.` With no header chosen it says `Choose the header that holds the signature.`; with no secret, `Type the secret to check.` Provider presets — Stripe's `t.body`, Slack's `v0:ts:body`, Standard Webhooks' `id.ts.body` — timestamp tolerance and asymmetric signatures are not offered.

*What is remembered.* The secret, the header chosen by name and an algorithm switched by hand stay in the page's memory while the session's page is open, for every request opened there: opened on another request, the check shows that request's result at once, on the same header when the request has one of that name, else by the preselection rule, and with the algorithm switched by hand when it is the same header. The eye starts masked at every opening. A reload, or another session's page, forgets everything. The secret is never sent, never written to `localStorage`, `sessionStorage`, IndexedDB or the address, and the field asks the browser and password managers not to offer to save it.

While a selected request's details are loading the panel says `Loading request details…`; if the load fails it offers `Retry` and says the request is still in the list. It says the same if the request cannot be drawn: the panel shows that state, the list and the rest of the page keep working, another request opens normally, and `Retry` loads and draws the same request again (D169). With nothing selected it says `No request selected`.

The interface asks the request-list API for metadata only. Full request details are loaded when the user selects a request. (An API client may ask the list for headers and bodies too, D196, and have an empty list held until a request arrives, D200; the interface does neither.)

Actions:
- Copy URL
- Copy the contents of any code block (D122)
- Copy a link to the selected request (D182)
- Copy the selected request as a cURL command (D167)
- Download the selected request as a JSON file (D185)
- Check the selected request's HMAC signature against a secret typed in the browser (D197)
- Compare the selected request with another request of the session (D186)
- Delete individual request
- Clear all requests while keeping the session alive

The individual request delete control is represented by `×`, with a **30 × 30 px** interactive hit area on the desktop and **44 × 44 px** below 1024 px (D157). Single deletion happens immediately without confirmation; Delete all requires confirmation.

Not included:
- pause receiving

## Realtime behavior
New requests appear at the top without page refresh.

A response recorded after its row is already listed - the `Pending` row of a delayed reply reaching its final status - updates that row in place, with no refresh. **A detail panel open on that same request follows it too, with no reselection and no page reload** (D125): the response section moves from `Pending` to the recorded response while the viewer watches. Switching to another request while one is being updated shows the request that was switched to, never the late answer for the one left behind. A panel whose refresh does not arrive keeps the response it was opened with rather than emptying or reporting a failure.

A newly received request:
- is marked unread
- does not replace the selected request
- becomes read when explicitly opened

Unread means never opened, so requests already captured when the page is opened are unread as well: opening a session holding 37 requests shows `(37)` in the browser tab title (D078). Read state belongs to the viewer's browser and is shared by its tabs (v0.18.0, issue #46, D156): opening a request in one tab marks it read in every other tab of the same browser showing that session, with no reload — the row loses its shading and the `(N)` in that tab's title goes down, and nothing else in that tab changes, neither its selection nor its detail panel. A request opened in one tab before it reached another tab's list arrives there already read. A reload, or a tab opened later, shows the requests already opened as read. Read state is still personal: another browser, profile, private window or person with the link keeps its own, and nothing about it goes through the server. It is kept in the browser's storage for as long as the viewer keeps using the session, and dropped 7 days after the viewer last used it. Where the browser's storage is blocked or disabled, read state belongs to the tab alone and starts over on reload, as before. Where it is full, what was already stored still loads on reload, but new openings stay in the tab that made them and are neither saved nor shared.

WebSocket sends only lightweight metadata for new request rows. Body and full headers are loaded through the detail API.

Unread count is not shown inside the page UI. It is reflected only in the browser document title, for example `(5) Webhook Inspector`, and in Russian `(5) Webhook Inspector — проверка вебхуков` (v1.18.0, D277). Unread rows are shaded in the request list.

A lost connection is reconnected automatically, and the request list is reloaded on every connection, so requests captured while the connection was down still appear without a manual refresh (D077). If the session has expired or does not exist, the page moves to `Session not found` instead of reconnecting. A page open on a session deleted through the API moves there at once, with no reload: the backend closes its connection with the same refusal (D198).

Deleting one request, and `Delete all`, reach **every viewer currently watching the session** — a second tab, a second window, another person with the link — with no reload (v0.8.0, issue #7). The row disappears, or the list empties, exactly as it does in the viewer that deleted it. A viewer whose detail panel is showing the deleted request returns to `No request selected`, with no notice (D137). The viewer that deleted it sees nothing extra: its own deletion reaches it too and changes nothing (D136). A viewer disconnected at that moment catches up by reloading the list when it reconnects (D077): the reloaded list replaces the one on screen, so the deleted rows disappear and a detail panel showing one of them returns to `No request selected` (v0.24.1, issue #39). A click landing at the exact moment another viewer deletes the same request can still reach a request that is gone; the panel survives that as before, and its copy is unchanged.

A change of the session's response reaches every viewer watching the session the same way, with no reload (issue #36, D152): the response button's label follows at once. So does the response queue (issue #106, D205): saving, restarting or removing it, each captured request that takes a step, and `Delete all`, which starts it from step 1, move the quick switch's section, the label's `· N queued` and an untouched Response queue dialog in every viewer at once. So do the response rules (issue #226): saving or removing them moves the quick switch's Response rules section, the label's `· N rules` and an untouched Response rules dialog in every viewer at once. A quick switch or an editor open in another viewer follows too until something has been chosen in it; from then on it keeps what was chosen, and whichever viewer saves last decides the response — there is no locking. No marker of a queue step is added to the request list: each request's `Response` tab already shows what that request was answered. A request a rule answered carries its rule's number in its row, in every viewer, as soon as its response is recorded (issue #233).

## Forwarding to a local service

(v0.44.0, issue #77, D202.) A provider calls only a public URL, while the service under test often runs on the tester's laptop or behind a VPN. The site serves one script for that, `https://webhook.qa-tools.ru/webhook-inspector-relay.mjs` since v1.16.0 (#319, D275), which the tester downloads, checks against the SHA-256 that `/docs` gives, reads, and runs next to their service with Node.js 22 or later. It is downloaded and read, never piped into `node`, and it needs nothing but Node's own modules:

```text
node webhook-inspector-relay.mjs <session id or webhook URL> <target base URL> [--from-start] [--api <base URL>]
```

It reads `https://webhook.qa-tools.ru` unless `--api` names another API. Until v1.16.0 the script was `https://qa-tools.ru/qa-tools-relay.mjs`, reading `https://qa-tools.ru`; since v1.19.0 that old name serves the same file, byte for byte, until the date the changelog's 1.19.0 entry gives, and on `qa-tools.ru` until day X, the date its 1.16.0 entry gives (D279).

- **A relay, not a tunnel.** The sender is answered at once with the session's configured response, as for any capture; the local service's answer reaches only the relay's console line. Nothing on the server forwards anything and the server makes no outbound request: the script is one more client of the public API, reading the session with the request list's `wait` (D200) and each request through its details.
- **What is sent.** Every request the session captures after the relay starts, one at a time in capture order, each with 30 s to be answered: the method as captured; the target base URL, then the stored path after `/s/<session-id>` — nothing for `/s/<session-id>` itself, a trailing slash kept, and the target base URL alone for a request captured before paths were stored — and `?` with the query string when there is one; the captured headers in their order and letter case, duplicates kept, less the headers `Copy as cURL` leaves out (D167, above) and, unlike it, less the eleven forwarding header names of the proxy that served `qa-tools.ru` until v0.36.0 (`X-Forwarded-*`, `X-Real-Ip`) and an `Accept-Encoding` whose value is exactly `gzip` — a copied command is read before it is run, while the relay sends on unattended, into a service that may trust a proxy on its own machine and take those headers for that proxy's — with `Host` and `Content-Length` set for the target and the body actually sent — no length for a `GET`, `HEAD`, `DELETE`, `OPTIONS` or `TRACE` that had no body and no `Content-Length` or `Transfer-Encoding` of its own, and never a `Transfer-Encoding` the sender did not send; and the body byte for byte, binary included. The first argument is the session id or its webhook URL, with or without a path after the id; the target is an `http:` or `https:` URL without a user name, password, query or fragment.
- **Where it starts.** Requests captured before the relay starts are skipped. With `--from-start` every request the session holds is sent first, oldest first.
- **No request twice, none missed.** The relay keeps the ids it has seen. When the request it waits after is gone — deleted, cleared, or pushed out by the newest 1000 — it reads the list once, sends only what it has not seen, and waits again, so it neither repeats a request nor spins.
- **What it prints.** One line per request: the time, the method, the path with its query, and the target's status, or the error for a target that cannot be reached or does not answer in time. An error does not stop it. An API that cannot be reached, or answers `5xx`, gets an error line and is tried again after 1 s, growing to 15 s; a `429` is waited out for its `Retry-After`. A session that is not found or has expired ends it with a message and exit status 1; an invalid argument prints the usage and exits with status 2 before any call.
- **The session's life.** The relay's own calls are not a use of the session (D133): the webhooks it relays keep the session alive as any capture does, and a session nobody uses expires as usual.
- **The API's limits.** Its calls count toward the 1200 API calls a minute of the address it runs from ([Limits](#limits), D201): two a minute while it waits, and at most two per request it sends, one detail read and one list answer per up to 100 requests. Only webhooks arriving one by one faster than about 600 a minute, or other API clients at that address, bring it to the limit; it then prints a line naming `429` and `errorCode` `1015`, waits the `Retry-After` and sends the rest late, in order.
- **The access key.** The session id is an argument, so it lands in the shell's history. `/docs` says so, and the owner accepted it (issue #77). A private session's access key is read from the environment variable `WEBHOOK_INSPECTOR_ACCESS_KEY` — or, when it is not set, from its old name `QA_TOOLS_ACCESS_KEY` until the date the changelog's 1.19.0 entry gives, with a line saying so (D279) — never from an argument, so it stays out of the shell's history and the process list; the relay sends it as `Authorization: Bearer` on every API call, never to the local service, and prints it in no line. With `--api`, the key goes to that API as well: give it an `https:` address, or `http:` only for a QA Tools running on your own machine. Unset, the relay reads a public session exactly as before; set to anything that is not a key, empty included, it prints the usage and exits with status 2 before any call (since v1.11.0, D253).

`/docs` gives the download command, the SHA-256 with a command that checks it, the run command and these rules in its introduction, under `Forward to a local service`; the file is served as `text/javascript; charset=utf-8` with `Cache-Control: no-cache`, never the application page. English only, whatever the interface's language (D222).

## Time display
Backend/API timestamps are UTC/timezone-aware. The frontend displays absolute times in the user's browser-local timezone. Relative-time labels are not used in v0.1.

A time is written in one of two forms, depending on where it appears (D148):
- **the detail panel** writes `17 Sep 2026, 14:32:06` — the Request side's facts line and the Response side's `Sent by server` line. The day has no leading zero (`5 Sep 2026, 09:04:05`), the month is a three-letter English abbreviation (`Sep`, never `Sept`), the clock is 24-hour with a two-digit hour, midnight reads `00:`, and seconds are always shown. In Russian the order is the same with the genitive abbreviation ICU gives, `17 сент. 2026, 14:32:06`, `5 мая 2026, 09:04:05`, and the home page's day headings read `3 окт. 2026` (D222, Decision 5);
- **a request list row** writes `2026-09-17 14:32:06`, in both languages.

The two forms on one screen are intended: a row is a compact column to scan, and the panel is read. Both name the same instant in the same timezone.

## Visual direction
- Light theme only in v0.1.
- Approved Figma design is the implementation reference.
- Simple, restrained, work-oriented visual style.
- Prioritize information density and readability.
- Every enabled button shows the hand cursor on hover, as links do, unless the element sets its own cursor, as the rules dialog's `⋮⋮` handle sets `grab` and the unavailable response chip `not-allowed`; any other button disabled, natively or by `aria-disabled` — the open request's row while Compare is picking — and a menu item keep the arrow (issue #246).

## Explicitly deferred
- dark theme
- accounts/authentication
- named sessions
- pause receiving
- a hint on the endpoint card that any path works; the response per path
  under the endpoint is no longer deferred: response rules by path and
  method answer since v1.3.0 through the API and since v1.5.0 from the
  session page (The response rules, D246, issue #226)
- CAPTCHA, quotas per session or account, paid tiers (#113), limits on the
  webhook endpoint and on realtime connections, and other storage-abuse
  protection — rate limiting is no longer deferred: the API is limited per
  address and lists with bodies four at a time ([Limits](#limits), D201), large
  bodies of the seven routes that read one eight at a time (D205, D213,
  D246), 128
  calls in flight per address and 100 header lines a request on the API
  (D213), and
  the search of headers and bodies runs two at a time and 2 s each (Filtering
  the list, D191), its places and its time shared with the API's query of
  requests by header and body (D196)
- syntax highlighting, collapsible JSON nodes and a JSON editor — JSON
  re-indenting (D112) and XML indenting (D163) for display, form-urlencoded
  bodies as decoded rows (D162) and multipart bodies as their parts (D164) are
  no longer deferred
- large E2E test suite — still excluded; the three fixed browser journeys
  added after the MVP, and the checks beside them — the API reference, read
  state across tabs and the detail panel's error state — are not a suite
  (D108, D155, D156, D169)

## MVP completion scenario
v0.1 is ready when a user can:
1. Open `qa-tools.ru`.
2. Click Generate URL.
3. Be redirected to `/v/<session-id>`.
4. Copy the receive URL, `https://hook.qa-tools.ru/s/<session-id>` since v0.36.0 (D187).
5. Send an HTTP request to it.
6. See the request appear in real time without refresh.
7. Inspect method, timestamp, IP visible to backend, query, headers, raw body representation, and body size.
8. Delete one request.
9. Send multiple requests.
10. Clear all requests.
11. Continue receiving requests in the same session.
12. Observe unread behavior and unread count in the browser tab title.
13. Observe session expiration behavior.
14. Use the approved light-theme desktop UI.
