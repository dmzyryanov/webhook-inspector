# Webhook Inspector — Changelog

What changed in each version of Webhook Inspector, newest first. The site
renders it at https://webhook.qa-tools.ru/changelog, with Atom feeds of every
release and of breaking changes alone. The numbers in parentheses after an
entry, an issue `#123` or a decision `D123`, point to the project's private
issue tracker and decision log; the site leaves them out.

## How to write an entry

This file is public. Every frontend build that shows the operator's texts,
as this site's does, publishes it as the page
`https://webhook.qa-tools.ru/changelog`, the text
`https://webhook.qa-tools.ru/changelog.md` and two Atom feeds,
`https://webhook.qa-tools.ru/changelog.xml` with every version and
`https://webhook.qa-tools.ru/changelog-breaking.xml` with the versions whose
entry has a Breaking, a Deprecated or a Notice paragraph (D212, D224); a
build without them publishes none of it (#396).
Everything above the first version heading, this header included, stays in the
repository; the published outputs carry a public header of their own. The
product version is in `VERSION`; delivery evidence and the exact commit live in
the MR and the Git tag. An entry in a branch is planned work until its
deployment is verified.

The rules (issue #97, D184):

- **One entry per version, newest first**, under a heading that is exactly
  `## <version>`, as `scripts/check-version.mjs` requires.
- **Date.** The first line after the heading is the UTC day on which the
  version reached production, as `YYYY-MM-DD`. A new entry carries the day of
  its merge, and is corrected before merging if the merge moves to another day.
  Past dates come from the `v<version>` tags; 0.25.3, which has no tag, takes
  the date of its merge commit.
- **Headline.** The entry opens with one bold sentence, `**…**`: what changed,
  in the words of someone using the site. An entry that changes nothing for
  users still gets a short public headline and at most a sentence or two after
  it.
- **Public wording.** Write for people outside the project. Name no
  infrastructure object or product (Kubernetes objects, Secrets, CronJobs,
  Traefik, k3s, Helm, kubectl, `qa-tools-*` object names), no runbook and no
  repository path: say "the proxy", "the server", "the owner is alerted".
  Write no `#` followed by a digit, such as a hex colour, and no `D` followed
  by three digits outside the references: the published text is checked for
  both.
- **References.** Issue and decision references appear only as a trailing
  parenthesis such as `(#69, D183)`, which the build removes from everything
  it publishes.
- **Breaking.** A paragraph inside the entry that starts `**Breaking:**` says
  what can break an API client. It is required whenever a request that used to
  succeed now fails or gets a different answer; a field of an answer or of a
  WebSocket event is removed or changes type or meaning; an `errorCode` or
  status changes for the same request; or a limit becomes stricter. Entries
  are marked from 0.16.0, the version that published the API; the published
  header says the API was not public before it. Since 1.0.0 the stability
  policy in the published header applies (D212, D233): a breaking change to a
  stable part ships only after a Deprecated paragraph has announced it at
  least 30 days before, unless it is an emergency, whose Breaking paragraph
  then gives the reason; an experimental part, such as the MCP server, may
  change without one. Entries before 1.0.0 carried the mark with no notice
  period. In `delivery-checks`, `scripts/check-api-breaking.mjs` fails a merge
  request whose `packages/shared/openapi.json` breaks a client against its
  base — a path, an operation, a request or answer field, a query, header or
  cookie parameter or a response header removed, an optional request field
  made required, a type changed — unless the bumped version's own entry has
  this paragraph; a path or operation marked `x-stability-level: experimental`
  is exempt. A new value of an enum in an answer, such as a response's
  `state`, is printed as a note and does not fail the check: before
  2026-11-24 it is a breaking change without notice, which the Reviewer
  reports, and from that day an addition that needs no paragraph (D248). A
  revert or fix after a failed delivery that removes from the description
  what the failed version added fails the check too: its new patch entry has
  this paragraph, saying that the failed version was rolled back or never
  deployed, so production already serves the description without what it
  removes, which is the reason given in place of the notice (D219). What the
  description cannot show, such as a stricter limit or a changed status or
  `errorCode`, stays with the writer and the Reviewer (D219).
- **Deprecated.** A paragraph inside the entry that starts `**Deprecated:**`
  announces a change ahead of time (D212): it names what is deprecated, its
  replacement and the removal date, `YYYY-MM-DD`, at least 30 days after the
  entry's date. A change that cannot sit beside the old, such as a
  stricter limit or a changed meaning, is announced the same way: what is
  deprecated is the current behaviour, the replacement the new one, and the
  date the day it ships on or after. The entry that later removes or changes
  it has a Breaking paragraph; a change that takes effect by itself on its
  date, as new values of an answer's enum do (D248), has no later entry. The
  page draws a Deprecated paragraph like a Breaking one, labels an entry that
  has only a Deprecated paragraph `Deprecated`, and shows it under
  `Breaking only`; the breaking feed carries it. Like Breaking, it is never the headline: the build refuses an entry
  that opens with it.
- **Notice.** A paragraph inside the entry that starts `**Notice:**`
  announces a change to the Terms of Use or the Privacy Policy at least 14
  days before it applies (D224). It is required for a new version of the
  Terms of Use, except one the law requires, one needed to protect the
  service or one that only adds to the user's rights, and for a change that
  makes the Privacy Policy say QA Tools keeps more data on the server, keeps
  it longer or shares it with anyone new — a move to another provider
  included — unless the law requires it sooner. Such a change ships in two
  steps: first an entry whose Notice paragraph names the change and the day
  it applies, `YYYY-MM-DD`, with a dated line saying the same in the page's
  changes section (`Changes to the terms`, `Changes to this policy`); then,
  on or after that day, the entry that makes the change. Every other change
  to either page — for the Privacy Policy, what only the browser keeps, a
  correction, keeping less — applies when published, with its own entry, and
  needs no Notice paragraph. More data means more data about people, senders
  and visitors: configuration a user types into a session, such as its
  response, its queue or its rules, is not, and the policy's list of what a
  session keeps gains it with its feature, in the same release, with no
  Notice paragraph (D246, amending D224). The page draws a Notice paragraph
  like a Deprecated one, labels an entry that has only a Notice paragraph
  `Notice`, and shows it under `Breaking only`; the breaking feed carries it. Like
  Breaking, it is never the headline: the build refuses an entry that opens
  with it.
- **Addresses.** Write production's addresses. A build for another address
  names its own addresses in their place: its second address in place of
  `webhook.qa-tools.ru`, or its own address where it has none (D274, D275). A
  build with no second address also leaves out the move's notices, every
  Breaking, Deprecated or Notice paragraph that names `webhook.qa-tools.ru`,
  which there would announce a move from its address to the same one, as
  1.16.0's notice of the move did; such a paragraph is production's alone
  (#343, reworded by #386).
- **Markup.** Paragraphs separated by blank lines, `code` in backticks and
  `**bold**`; nothing else is interpreted, and the page escapes the rest, so
  `<session-id>` shows as written. The build fails when an entry has no date
  or does not open with a bold headline, and a frontend test fails when the
  published text names an issue, a decision, a repository path or an
  infrastructure object.

## 1.19.35

2026-11-07

**Nothing changes on this site; a few more comments in the web page's source
code now say what they protect in words of their own, and two read more
plainly.** Every page looks and works exactly as before. (#445)

## 1.19.34

2026-11-07

**Nothing changes on this site; the inspector's own checks now notice if a
session's page stops following what its live updates say about responses, a
clear or a changed response, stops reading the session every 10 minutes while
it shows it, or applies a load that answers after the page was left.** They
also check that a private session keeps the key it opened with when another
tab removes it, and a comment in the page's source code now names the part of
the page that changes its status. Every page looks and works exactly as
before. (#444)

## 1.19.33

2026-11-07

**Nothing changes on this site; the inspector's own checks now notice if a
session's page stops treating a request as open, or as closed, from the
moment it is clicked, which a deletion by another viewer arriving just then
relies on.** The part that decides when a failed load takes the page to
`Session not found` now has tests of its own, and the page's checks share one
set of helpers. Every page looks and works exactly as before. (#443)

## 1.19.32

2026-11-07

**Nothing changes on this site; a few more comments in the server's source
code now state the rule they protect rather than how it was found, and name
where it was decided.** The server answers every request exactly as before.
(#434)

## 1.19.31

2026-11-07

**Nothing changes on this site; the inspector's own checks now notice if a
session's page stops counting as read a request opened in another tab of the
same browser just as the page opens.** A comment in the list filter's source
code now names the part of the page that holds the filter's state. Every page
looks and works exactly as before. (#436)

## 1.19.30

2026-11-07

**Nothing changes on this site; a copy of the inspector built without this
site's texts no longer fails to build when its status page's address contains
the word "Network".** Its build took that address for a mention of this
site's server, which such a copy leaves out of its API reference; it now reads
only the reference's own text, and still refuses it when that names this
site's server. This site's `/docs`, `/openapi.json` and `llms-full.txt` are
exactly as before. (#430)

## 1.19.29

2026-11-07

**Nothing changes on this site; the inspector's own checks now notice a
change to the order of its footer or to which addresses its development
server publishes without this site's texts.** Every page and every address
answers exactly as before. (#427)

## 1.19.28

2026-11-07

**Nothing changes on this site; a copy of the inspector built from its source
at an IPv6 address no longer links a changelog it does not publish.** A copy
built without this site's texts at an address such as `http://[::1]:8080`
leaves the changelog's links out of its API reference and `llms-full.txt`, as
a copy at a host name does, and its build refuses one left in. This site's
`/docs`, `/openapi.json` and `llms-full.txt` are exactly as before. (#426)

## 1.19.27

2026-11-07

**Nothing changes on this site; the comments in the deployment settings, the
browser tests and the maintenance scripts now state the rule each one
protects, rather than how it was decided.** The service is deployed, backed up
and works exactly as before. (#424)

## 1.19.26

2026-11-07

**Nothing changes on this site; the comments in the web page's source code now
state the rule each one protects, rather than how it was decided.** Every page
looks and works exactly as before. (#423)

## 1.19.25

2026-11-06

**Nothing changes on this site; the session page's code keeps its loading and
its live updates in parts of their own.** The session and its requests load,
new requests appear live, a reconnection catches up and an expired session
shows `Session not found` exactly as before. (#422)

## 1.19.24

2026-11-06

**Nothing changes on this site; the session page's code keeps the request
you open and the comparison with another in parts of their own.** Opening a
request, its details, a link to a request and `Compare with…` work exactly as
before. (#421)

## 1.19.23

2026-11-06

**Nothing changes on this site; the session page's code keeps its list
filter and what has been read in parts of their own.** The filter, its search
of headers and bodies, the unread requests and the count in the tab title
work exactly as before. (#406)

## 1.19.22

2026-11-06

**Nothing changes on this site; the comments in the server's source code now
state the rule each one protects, rather than how it was decided.** The
server answers every request exactly as before. (#403)

## 1.19.21

2026-11-06

**Nothing changes on this site; a copy of the inspector built from its source
no longer gives this site's server address in its API reference.** A copy
built without this site's texts leaves out the API reference's Network
section, which tells a network on an allow-list this site's address, port and
notice of a new address, and the sentence of the stability policy that points
at it; a copy built with them and with no second address leaves out the
section's announcement of the move, which there would name the copy's one
address on both sides. This site's `/docs`, `/openapi.json` and
`llms-full.txt` are exactly as before. (#386)

## 1.19.20

2026-11-06

**Nothing changes on this site; a copy of the inspector built from its source
no longer publishes this site's changelog, and its footer no longer promises
how long backups keep captured requests.** A copy shows this changelog, its
feeds and the footer's clause on backups only when whoever builds it shows
their own texts, as it does the Terms of Use and the Privacy Policy; without
them its footer ends after the 7 days a session lives unused. This site shows
both as before, and every address answers exactly as before. (#396)

## 1.19.19

2026-11-05

**Nothing changes on this site; the notes for the people who write this
changelog, which the site never publishes, now give this page and its feeds
one address.** Every other entry reads exactly as before. (#409)

## 1.19.18

2026-11-05

**Nothing changes on this site; the server's five copies of one check of
whether a request body is a JSON object are now a single one.** It answers
every request exactly as before. (#407)

## 1.19.17

2026-11-04

**Nothing changes on this site; the inspector's checks of what its pages draw
now see its not-found page as a browser shows it, and a stuck helper process
can no longer hold them up.** Every address answers exactly as before. (#391)

## 1.19.16

2026-11-04

**Nothing changes on this site; some of the inspector's own checks no longer
fail when nothing is wrong.** They no longer depend on how a comment is
wrapped, on the exact text the build tool writes, or on one timing taken on a
busy computer. The inspector's API contract also says now that a copy built
without its operator's details leaves our contact address, status page and
terms out of its API reference. Every page and address answers exactly as
before. (#379)

## 1.19.15

2026-11-04

**Nothing changes on this site; the inspector's source no longer refers to
files of ours that are not published with it.** Its documentation describes
the server it runs on in general terms, its comments and tests say in place
what they need, and an automated check keeps such references from coming
back. Every page and address answers exactly as before. (#375)

## 1.19.14

2026-11-03

**Nothing changes on this site; the inspector's checks of what its pages draw
now give the same result whatever language the computer running them is set
to.** Every address answers exactly as before. (#366)

## 1.19.13

2026-11-03

**The link that carries your sessions to webhook.qa-tools.ru is now read when
it is pasted into a tab whose session page is still loading its requests.**
Before, in some browsers, that page could take the link out of the address as
its requests arrived, before the link was read, and the sessions and keys it
carried did not arrive. (#362)

## 1.19.12

2026-11-03

**A request saved with Download JSON is now named after the service:
`webhook-inspector-request-<short id>.json`, e.g.
`webhook-inspector-request-2b906b8.json`.** The short id is the one its row
in the list shows, as before, and the file's content is unchanged. (#349)

## 1.19.11

2026-11-03

**Nothing changes on this site; a copy of the inspector built for an address
of its own, with no second address, no longer publishes this site's notice of
its move.** Such a copy names its own address wherever this changelog names
one of this site's, so the notice in the entry for 1.16.0 came out saying
that the copy's addresses would stop answering and redirect to the same
address. The copy's changelog page, its text and both its feeds now leave
that notice out, so its feed of breaking changes and deprecations no longer
lists 1.16.0. Every address here answers exactly as before. (#343)

## 1.19.10

2026-11-03

**Nothing changes on this site; the inspector's installation files no longer
assume they are this site's.** Someone installing the inspector on a server of
their own now gives it their own addresses, and its off-server backup copy and
its alerts are options they switch on with storage and an alerting service of
their own; this site sets the same values it had, kept outside the code.
The automated build of the site now stops, naming the setting, when the site's
or the receive host's address, or one of the operator's details, has not been
given, rather than build a copy that names this site's addresses or leaves its
details out. Every address answers exactly as before. (#367)

## 1.19.9

2026-11-03

**On a phone, the banner about the move to webhook.qa-tools.ru no longer
splits the new address over two lines at its hyphen, as it did in Russian.**
The address stays on one line at every width and in both languages; the rest
of the banner's text wraps as before, and its words, date and action are
unchanged. (#347)

## 1.19.8

2026-11-03

**The realtime connection again answers a subprotocol that starts like an
access-key prefix in another letter case, such as
`Webhook-Inspector.Access-Key.x` or `QA-TOOLS.ACCESS-KEY.x`, as it did before
1.19.0.** The prefixes are compared exactly, so such a name carries no key and
is answered like any other name: a connection offering it alone opens on a
public session, and on a private one opens and is closed `4404`, as without a
key. From 1.19.0 it was answered with no subprotocol, which a browser fails as
an abnormal closure, `1006`. The key under `webhook-inspector.access-key.` or
`qa-tools.access-key.` is still never written back. (#356, D279)

## 1.19.7

2026-11-03

**Nothing changes on this site; a few comments in the inspector's code now
say where the files it serves come from.** Every address answers exactly as
before. (#344)

## 1.19.6

2026-11-03

**Nothing changes on this site; a copy of the inspector built from its source
no longer shows this site's status page, contact address or terms.** A copy
shows a status link, a contact address, the Terms of Use and the Privacy
Policy only when whoever builds it names their own. This site names its own
as before, and every address answers exactly as before. (#369)

## 1.19.5

2026-11-02

**Nothing changes on this site; a few comments in the inspector's code now
say what it does.** Every address answers exactly as before. (#358)

## 1.19.4

2026-11-02

**Nothing changes on this site; a note in the inspector's code now names
Webhook Inspector, and its list of dependencies is in the order the package
manager writes it.** Every address answers exactly as before. (#351)

## 1.19.3

2026-11-02

**Nothing changes on this site; the move banner and the message about moved
sessions are now checked as the page draws them.** A copy of the inspector
built with no second address no longer reads this changelog for a move date
it does not use. (#346)

## 1.19.2

2026-11-02

**The link that carries your sessions to webhook.qa-tools.ru is now read when
it is pasted into a tab already showing a session's page there.** Before,
that page could take it out of the address before it was read, in some
browsers, and the sessions and keys it carried did not arrive; the link from
the banner, which opens the new address afresh, always worked. (#345)

## 1.19.1

2026-11-02

**Nothing changes on this site; a copy of the inspector set up with an
address whose host is not a valid host name is now stopped at the first check
that reads it.** A host such as `-`, `.`, `a..b` or `a.b.`, or one with a part
longer than 63 characters or starting or ending with a hyphen, is refused when
the copy is built and before it is deployed, where it used to fail only
partway through the deployment; the build also refuses port 0. Every address
here answers exactly as before. (#340)

## 1.19.0

2026-11-02

**What a client reads and sends now carries Webhook Inspector's name beside
the old one: the request-id header of a webhook's answer, the subprotocols of
the realtime connection, and the relay script's name, variable and
User-Agent.** Every webhook a session stores is answered with
`X-Webhook-Inspector-Request-Id`, the same id as `X-QA-Tools-Request-Id`,
which is still sent beside it, on the default answer, a custom one, a rule's
and a queue step's alike; a response can configure neither name, and neither
counts toward the 8 KiB of its configured headers. The WebSocket takes the
subprotocols `webhook-inspector` and `webhook-inspector.access-key.<key>`
beside `qa-tools` and `qa-tools.access-key.<key>`, and answers with the one
offered; the inspector's pages offer the key under both names, so a page
opened before this release, or while it rolls out, keeps receiving live. The
relay script reads a private session's key from `WEBHOOK_INSPECTOR_ACCESS_KEY`,
or from `QA_TOOLS_ACCESS_KEY` when that is not set, with a line saying so,
and `qa-tools-relay.mjs` now serves the same file as
`webhook-inspector-relay.mjs`, reading https://webhook.qa-tools.ru by default,
with the SHA-256
`38761689bf1581cbc2a8037b0f511d990171e8ff1d92dd8a772c9c12a411a8ae`.
(#334, D279)

**Deprecated:** the old names — the header `X-QA-Tools-Request-Id`, the
subprotocols `qa-tools` and `qa-tools.access-key.<key>`, the relay script's
name `qa-tools-relay.mjs` and its variable `QA_TOOLS_ACCESS_KEY` — and the
default answer's `message`, `Captured by QA Tools`. Their replacements are
`X-Webhook-Inspector-Request-Id`, `webhook-inspector` and
`webhook-inspector.access-key.<key>`, `webhook-inspector-relay.mjs` and
`WEBHOOK_INSPECTOR_ACCESS_KEY`, and `Captured by Webhook Inspector`. From
2026-12-02 the old header is no longer sent, the old subprotocols are no
longer taken, the relay script is served only as `webhook-inspector-relay.mjs`
and reads only `WEBHOOK_INSPECTOR_ACCESS_KEY`, and the default answer's
`message` reads `Captured by Webhook Inspector`. The relay script sends the
User-Agent `webhook-inspector-relay` from this release, where it sent the
User-Agent `qa-tools-relay`: nothing in the service reads it. Under either
name, the script's messages that named it start with the same new name,
`webhook-inspector-relay:` before an error in its arguments or key and
`webhook-inspector-relay stopped:` before a failure that stops it, where they
started with the old one. (#334, #357, D279)

## 1.18.2

2026-11-01

**The MCP server now introduces itself as Webhook Inspector.** An agent's
client reads the server's name as `webhook-inspector` and its title as
Webhook Inspector, where it read `qa-tools` and QA Tools, and its instructions
and the description of `create_session` name the service by that name too; the
address, the tools' names, their arguments and their answers are unchanged,
and a client that gave the server another name in its settings keeps working.
The examples for adding the server now call it `webhook-inspector`. Behind the
scenes, the service's internal names follow its own. (#323, D278)

## 1.18.1

2026-11-01

**Nothing changes on this site; a copy of the inspector built for one of this
site's own host names with a port of its own now builds, and its pages name
its address with the port once.** Before, such a copy either failed to build
or wrote the port twice into the links of its about and changelog pages.
Every address here answers exactly as before. (#339)

## 1.18.0

2026-11-01

**Webhook Inspector now calls itself by its own name: the header, the browser
tab, the API reference, the changelog and the agent documentation say Webhook
Inspector, and QA Tools is the platform it belongs to.** The header reads
`Webhook Inspector`, on one line on a computer or a tablet and on two lines on
a phone, where the Q mark still takes its place on the narrowest screens; it
still leads to the home page. The tab reads `Webhook Inspector`, or
`(5) Webhook Inspector` with unread requests, and in Russian
`Webhook Inspector — проверка вебхуков`; in a search result or a link preview
the home page is `Webhook Inspector — QA Tools`. `/docs` is headed
`Webhook Inspector API`, the title of `/openapi.json`; the changelog page, its
text and both feeds are titled Webhook Inspector, with every entry as it was.
The default answer to a webhook still says `Captured by QA Tools`, and the
about page, the Terms of Use and the Privacy Policy still speak of QA Tools.
(#322, D277)

## 1.17.0

2026-11-01

**On https://qa-tools.ru every page of Webhook Inspector now says, in a bar
above the header, that it is moving to https://webhook.qa-tools.ru and on
which day, with a link that takes your sessions with you.** `Move with my
sessions →` opens https://webhook.qa-tools.ru in the same tab with this
browser's list of sessions, the keys of its private sessions, the interface
language and whether the Response queue and Response rules sections are open,
so the list there shows the same sessions and a private one opens without its
link. They travel in the part of the address after the `#`, which a browser
never sends to a server, and the new address takes them out of the address bar
as soon as it has read them. They only add: what the new address already keeps
stays, no session or key is kept twice, the list still holds at most 50
sessions, and the language and the sections are taken only where none was
chosen there. A short message says how many sessions came and how many of them
are private. Which requests were read and the list filters stay behind. The
bar shows only on https://qa-tools.ru. (#321, D276)

## 1.16.1

2026-11-01

**Nothing changes for users; notes in the web server's configuration now say
that the build writes the robots file, the sitemap and the relay script for
the site's own addresses.** Only those notes changed: every address answers
exactly as before. (#341)

## 1.16.0

2026-11-01

**Webhook Inspector now also answers at https://webhook.qa-tools.ru, the
address it is moving to: the same site, API, WebSocket, API reference and MCP
server as https://qa-tools.ru, which keeps working until the date below.**
Webhooks are still received on https://hook.qa-tools.ru, and a session's
`receiveUrl` is unchanged. The new address is kept out of search engines until
the move. The home page's list of sessions is kept by the browser for each
address, so on the new one it starts empty; a session's own link opens it on
either. The relay script is published under a new name too, at
https://webhook.qa-tools.ru/webhook-inspector-relay.mjs: the same script as
`qa-tools-relay.mjs`, reading https://webhook.qa-tools.ru by default, with the
SHA-256
`afe848cb19fe839d942bb0f10121f1e5668274dfbcfd171605d76296c7adf264`.
(#319, D275)

**Deprecated:** Webhook Inspector's addresses on https://qa-tools.ru — the API
under `/api/`, the MCP server at `/mcp`, the WebSocket at `/ws/`, the old
webhook path `/s/`, the relay script `qa-tools-relay.mjs` and the changelog
feeds `/changelog.xml` and `/changelog-breaking.xml`. Their replacements are
the same addresses on https://webhook.qa-tools.ru, and
`webhook-inspector-relay.mjs` for the relay script. From 2026-12-01 they stop
answering on https://qa-tools.ru and redirect to https://webhook.qa-tools.ru,
the inspector's pages redirect there for good, and the `inspectorUrl` of a
webhook's default answer, like the inspector links of the MCP server, names
https://webhook.qa-tools.ru instead of https://qa-tools.ru. Webhooks stay on
https://hook.qa-tools.ru. Later, https://qa-tools.ru itself will serve the QA
Tools platform from another server, at another IP address: that change of
address is announced here at least 14 days ahead, once its date is known.
(#319, D275)

## 1.15.23

2026-11-01

**Nothing changes on the site: its own two addresses, https://qa-tools.ru and
https://hook.qa-tools.ru, are now settings of its build rather than written
into its pages by hand.** Every page, the API description, the agent guide,
the changelog feeds and the relay script are what they were. A copy of the
inspector run at another address is built with its own two addresses and names
them everywhere, apart from the contact address and the status page.
(#320, D274)

## 1.15.22

2026-10-26

**A webhook that arrives while the server is overloaded is now stored late
rather than lost.** When a flood kept the server busy for more than five
seconds at a stretch, a webhook could be cut off with no answer even though the
proxy had passed on the sender's address in time: the server gave up waiting
for it before looking at what had already arrived. It now looks once more
before giving up, so such a webhook is answered and stored, only later. A
connection that really sends nothing in time is still closed as before.
(#299, D187)

## 1.15.21

2026-10-26

**Nothing changes for users; the notes on the switched-off HTTP/2 receiving
path now say exactly what its tests check.** The record of the hostile-request
series states its coverage and its memory estimate as the tests and numbers
support them, and the tests close their connections as they finish, so later
tests stay clear of the per-address connection limit. (#302)

## 1.15.20

2026-10-26

**Nothing changes for users; the switched-off HTTP/2 receiving path was tried
against a series of hostile requests and gained limits where the series
overwhelmed it.** Floods of resets, half-finished headers, compression bombs
and oversized header fields, storms of control and empty frames, stalled
windows, overlong web addresses and memory-filling streams were fired at a
copy of the service limited as production is, from up to eight attacking
machines at once. At their smallest size every kind but one held from four
machines; that one, headers never finished, used up the server's memory from
eight, and a larger flood of cancelled requests lost ordinary webhooks from
two. On that path a request now carries at most 4,096 header lines, one sender
has at most 32 HTTP/2 connections, a connection that cancels requests too fast
is closed, and a web address or host longer than 16 KiB is turned away. HTTP/2
receiving stays off, so none of these limits applies on the site yet; the
series is run again with them before it is switched on. (#208, D266)

## 1.15.19

2026-10-25

**Nothing changes for users; a test now holds the answer to a client that
sends the whole opening of HTTP/2 and then an ordinary request.** Such a
client still gets the same `400 Bad Request` answer, byte for byte, and
nothing is stored; should an update of the server's runtime ever start
reading that request, the test fails before the update ships. The notes in the
code now say first what the server relies on there. (#288)

## 1.15.18

2026-10-25

**Nothing changes for users; the switched-off HTTP/2 receiving path is now
held by more tests.** Its safeguards — answers that never try to control their
connection, the close of a connection left idle, and the shutdown's close of a
connection whose client ignores the request to go away — are each held by a
test that fails without them, and three timing tests no longer depend on a
fast machine. HTTP/2 receiving stays off. (#278, D263)

## 1.15.17

2026-10-25

**Nothing changes for users; the server no longer logs an error when a client
sends the opening bytes of HTTP/2 to a webhook address.** Such a client, one
that assumes HTTP/2 without asking first, still gets the same `400 Bad
Request` answer, byte for byte, and nothing is stored. The server used to take
those bytes for a fault of its own and write a line at error level, the first
time after each start; it now treats them like any other malformed request,
and keeps that line for faults that are its own. (#277, D238)

## 1.15.16

2026-10-25

**The footer and the `Session not found` page no longer say that every
session lives 7 days after its last use.** A session can be created to expire
sooner, 1 hour or 1 day after its last use, or with a fixed lifetime through
the API, so the footer of every page now says that captured requests are kept
until you delete them or the session expires, at most 7 days unused, and that
backups keep them up to 3 days longer; the Russian footer says the same. The
`Session not found` page names no number any more: the session was most
likely deleted, on purpose or after going unused for the time chosen when it
was created. The relay script, meeting an expired session, now says that its
idle window or lifetime ran out, where it said it was not used for 7 days,
which gives `qa-tools-relay.mjs` a new SHA-256,
`1bbb1060f36f1c063214c9dcd73090d0d7e278d4063acf4aedd966974f571220`; the API
reference gives it with the commands. Its arguments, exit statuses and
behaviour are unchanged. (#274, D265)

## 1.15.15

2026-10-25

**A flood of calls from one address no longer takes the site down for
everyone.** The proxy in front of the server now refuses an address that sends
the API far more than its limits allow — more than 6,000 calls within seconds,
or more than 100 a second without pausing — with `429` and `Retry-After`, before
those calls reach the server. Its refusal carries no `errorCode` and no
`X-RateLimit-*` headers, so it is told apart from the API's own. A client
within the API's limits never meets it, and gets the same answers and headers
as before. The server is also no longer restarted while it is busy: it is
restarted only once it has stopped answering for over a minute, where before
three answers slower than a second in a row restarted it, which turned a flood
on 2026-10-15 into five short outages of the API and of webhook receiving.
(#205, D264)

## 1.15.14

2026-10-25

**The Privacy Policy announces that mail to the contact address moves to
Yandex 360, in Russia, at least 14 days before it applies.**
`Changes to this policy` on `/privacy` now has a dated line saying so and from
which day; until that day mail to the address is received by Apple iCloud Mail,
as the policy says. (#275, D224)

**Notice:** from 2026-11-08, mail to the contact address is received by Yandex
360, in Russia, instead of Apple iCloud Mail. The address,
`contact@qa-tools.ru`, stays the same. (#275, #151, D224)

## 1.15.13

2026-10-25

**Nothing changes for users; the notes on how the server records an answer
and announces events now match what it does since 1.15.10.** An answer to a
call may reach its sender up to about 20 ms before the event of its change
reaches an open page, and a session with a short idle window has its expiry
moved more often than once an hour; the documentation and the notes in the
code now say so, and the 1.15.10 entry below now says the latter too. (#271)

## 1.15.12

2026-10-24

**Groundwork for receiving HTTP/2 webhooks; nothing changes yet.** The server
can now take a webhook sent over HTTP/2 — from senders that speak nothing else,
such as gRPC clients — and store it as HTTP/2, with its fields as they arrived.
The new path is switched off: until a later version turns it on, the receive
address answers every request exactly as before. (#207, D263)

## 1.15.11

2026-10-23

**Your webhooks are captured while a few other addresses flood the server.**
The server receives webhooks within a memory budget, and a flood from a few
addresses could fill all of it, so that another sender's webhooks waited
behind the flood and some were refused with `503`. Now the server keeps
16 MiB of room for senders with less in flight — each with at most 12 MiB of
webhooks at once, about 150 small ones: their webhooks go in at once, ahead of
the senders that fill the budget, whose webhooks go in only while everything
in flight, the lighter senders' included, fits within the same budget as
before. In a test of four addresses flooding the server at once, every small
webhook of another sender was captured in all three runs, where 89 and 144 of
about 540 were refused before. The answers are the same: a webhook that cannot
get in still gets the same `503` as before. (#262, #273, D261)

## 1.15.10

2026-10-23

**Each webhook costs the server less work.** Receiving a webhook and recording
how its answer ended now take fewer round trips to the database: a session's
expiry is moved only when it is due — at most once an hour, more often for a
session with a short idle window — rather than checked
on every webhook, and how an answer ended is recorded in a single step. In a
load test of 600 users at once, each webhook took the server 16 to 22 % less
processor time and the database 17 to 26 % less. The server also reads and
announces new events at most once every 20 ms instead of after every change,
so an open page may show a new request or its answer up to 20 ms later. A page
whose request is deleted or cleared within those 20 ms of arriving reloads its
list instead of showing it come and go. What a webhook is answered and what is
stored are unchanged. (#260, D221, D232)

## 1.15.9

2026-10-23

**Agents are told that a private session called without its key answers as
one that does not exist.** The MCP server's tool error for `errorCode` 1001
and the agent documentation said only that the session was gone and to create
a new one; they now add that a private session called without its access key,
or with another, answers the same, and say to check the key first. The MCP
tool that creates a session no longer says that its inspector link cannot open
a private session: the link carries no key, and opens the session once the key
is given. `/docs` and the agent documentation add that the relay, run with
`--api`, sends a private session's key to that API too, so it should be given
an `https:` address. No call is refused or accepted differently. (#256, #259)

## 1.15.8

2026-10-23

**While the Response queue or Response rules dialog saves, its text fields
look locked too.** A save or a removal in flight has always left the selected
step's or rule's fields unavailable, but they were drawn as if they could be
edited, so a click into one gave no caret and no reason why. They are now
drawn faded, as the dialog's buttons and method chips already are while it
waits: the status, the delay, the headers and the body, and in the rules
dialog the typed method and the path. The session response editor, whose
fields stay editable while it saves, looks as before. (#250)

## 1.15.7

2026-10-23

**Receiving webhooks has its own connections to the database, and the
server works on at most three API and MCP calls at a time, apart from a change
waiting behind its session's webhooks.** No API call can take a connection a
webhook needs, and the server's health check uses them too. A call beyond the
three waits its turn, taken from each address in turn, and one whose client
leaves while it waits is not run, though a change to a session already waiting
behind that session's earlier webhooks and changes is still made. The queue
itself refuses nothing and changes no answer, but under a flood an API call may
be answered later, and since a waiting call keeps its places, the limits on
calls in progress from one address, on large bodies and on lists with bodies
may be reached sooner. Under the heaviest flood measured, many
addresses asking for lists of large bodies and leaving as each answer begins,
webhooks can still wait longer than 5 seconds, over a minute of it and at
times in a short burst; over the minute some are refused, though fewer than
before. (#243, D244)

## 1.15.6

2026-10-23

**The Russian about page now breaks its lines as Russian text should.** At
every width, no line of `/ru/about` ends with a one-letter word such as `и`
or `в`, no line starts with a dash, and `QA Tools` is never split across two
lines. On a phone the title's dash now ends its first line. The words of the
page are unchanged. (#258)

## 1.15.5

2026-10-23

**Nothing changes for users; the server's log of refused connections stays
short.** A connection that reaches the webhook receiver without coming
through the proxy is still refused before a byte of it is read, and the
server's log now counts such refusals instead of writing a line for each: the
first at once, then at most one line a minute saying how many there were, as
it already did for a sender holding too many connections. (#241)

## 1.15.4

2026-10-23

**A private session's page keeps its lock and its links with access while
another tab of the browser removes the session from the list.** Until now a
request arriving in the tab still showing the session made its card drop
`PRIVATE` and the split `Copy`, and a request's `Copy link` then copied a link
without the key, which opens nothing for the person who gets it. The page now
keeps the key it opened with for as long as it shows the session; its next
call, as before, finds the session missing and the page says
`Session not found`. (#264)

## 1.15.3

2026-10-23

**Nothing changes for users; response templates are checked more closely.**
Tests now hold that a template's `{{request.path}}` is escaped for the
answer's type like every other value, and that what a sender writes is filled
in once and never read again for placeholders: text such as `{{request.id}}`
in the path, the query, a header or the body comes back as it was sent. A note
in the code now says that a `HEAD` answer's `Content-Length` is that of the
body as its request fills it in. (#253)

## 1.15.2

2026-10-23

**A request whose sender address arrives from the server in an unexpected
form now reads `IP unavailable` instead of leaving the session page blank.**
The page reads an address that is not text, such as a number, an object or a
list, as a missing one wherever a request reaches it: in the list, in a newly
arrived request and in the request's details, which open with that wording in
the facts line rather than `Could not load request details`. A session that
keeps no addresses says `IP not stored` there, as before. The server always
sends the address as text or as nothing, so this only guards against an
answer it never gives. (#245)

## 1.15.1

2026-10-23

**Nothing changes for users; how the about page is served is checked more
closely.** A test now fails if the web server's configuration would ever
answer an address that only resembles the about page's, in English or in
Russian, such as `/ru/about.html` or `/ru/aboutX`, with that page, and the
notes in the code now say that the Russian about page is drawn in Russian.
(#257)

## 1.15.0

2026-10-22

**You can now create, open and share a private session on the site.** Tick
`Private session` in the new session's options, and the session opens only
with its key: the browser keeps the key and sends it by itself, so you never
type or see it. A lock marks a private session in your list of sessions and on
its page, which reads `PRIVATE`. To show it to a colleague, use `Copy ▾` →
`Copy link with access`: the link carries the key after a `#`, which a browser
never sends to the server, and opening it keeps the key in that browser and
takes it out of the address bar. In a private session a request's `Copy link`
carries the key too, and says `Link with access copied`. Without its key a
private session's page is the page of a session that does not exist, and that
page now offers `Open with a link with access or a key…`, where you paste
either one. Removing a private session from your list first warns that only
this browser holds its key and offers to copy its link; a full list drops
public sessions before private ones. The Privacy Policy now says that your
browser keeps the access keys of your private sessions and sends them to open
those sessions. (#228, D259)

## 1.14.1

2026-10-21

**Connections that stop in the middle of their header lines now cost the
server far less: floods of them are survived from 8 addresses at once, and the
number of attacking addresses the server is stated to hold against rises from
3 to 4.** The server's connections start with a smaller receive buffer, 16 KiB
rather than 128 KiB, so a connection the server holds unread keeps about 50 to
85 KiB on it instead of about 160 to 220 KiB; a connection the server reads
grows its buffer as before. Nothing is refused, closed or answered
differently, and every webhook is captured as before. (#242, D238, D228)

## 1.14.0

2026-10-21

**When the server refuses a response rule or a queue step, the dialog now
selects it and shows the server's reason at the field it names.** Until now
the footer quoted the server's message, which counts rules and steps from 0,
and nothing on screen was marked. Now the rule or step is selected, its row is
marked in error and the reason stands under the field — the method, the path,
the status, the delay, the body, or a header's name or value — while the
footer says `The server rejected rule 2. Fix the marked field and save
again.`, counting as the list does, in English or in Russian. The mark does
not stop you saving, and your first change clears it. The dialogs check what
the server checks, so this mostly happens while the site is being updated.
For API clients, a `400` / `1005` refusal that names a place in the request
body now also carries `field`, such as `"field": "rules[1].path"`, in the
notation its message begins with: read it instead of parsing the message. A
client that ignores it loses nothing. (#232, D257)

## 1.13.0

2026-10-21

**The page about QA Tools now has a Russian version,
`https://qa-tools.ru/ru/about`.** It says who runs QA Tools, how it is made,
who pays for it and what happens to your data, in the owner's own Russian
words, and like the English page it reads in full without JavaScript and
loads nothing from another site. Its header and footer are in Russian, and in
the Russian interface `О сервисе` in the footer now leads to it; `Условия` and
`Конфиденциальность` still open the English terms and privacy policy. `/about`
stays English, whatever language the browser asks for. The two pages name
each other for search engines, and the site map lists the Russian one.
(#170, D255)

## 1.12.2

2026-10-21

**Nothing changes for users; the server's log of accepted calls is checked
more closely.** A call that waits for a webhook is now tested to appear in
the server's log as soon as it is accepted, not only once it ends, and the
server's dependencies name the framework release it already runs. (#222)

## 1.12.1

2026-10-21

**Usage statistics keep each day's sender networks for 90 days instead of
indefinitely.** Each night the server records each day's 20 most frequent
sender networks, an IPv4 /24 or an IPv6 /48, never a full address; it now
removes a day's networks once they are 90 days old, and nightly backups keep
them up to 3 days longer. The daily totals and the most frequent User-Agent
values, content types and methods are still kept indefinitely. The Privacy
Policy says so in `Usage statistics`; it keeps less, so the change applies at
once. (#165, D254)

## 1.12.0

2026-10-21

**The response editor can now make a response a template: tick `Fill in
placeholders from the request` under the body and insert placeholders from a
list.** The box is off by default, and a body is sent exactly as typed until
it is ticked. Ticked, `Insert placeholder ▾` lists `Request id`, `Method` and
`Path`, inserted whole, and `Query parameter…`, `Header…` and `JSON body
field…`, inserted with the cursor where you type the name or the field's
path, such as `{{request.body.order.id}}`. A placeholder the server would
refuse is named under the body as you type, `Unknown placeholder
{{request.foo}}.`, and the response cannot be saved until it is fixed. The
same box is in each step of the response queue and in each response rule,
and a template is marked `Template` in the response menu, after a rule's
answer and in a queue step's chip, `201 · Template`. In Russian the box reads
`Подставлять значения из запроса`. (#236, D251)

## 1.11.0

2026-10-21

**A session can now be private: only someone with its access key can read or
change it, and its webhook URL only sends it requests.** Create one through
the API with `{"private": true}`: QA Tools draws a key and answers it once, as
`accessKey`, or creates the session under a key you send as
`Authorization: Bearer <key>`, so one key kept with your CI's secrets opens
every session created with it. Every call about the session then presents the
key — `Authorization: Bearer` on the API and the MCP server, `accessKeys`
beside its id when reading the status of sessions, and a subprotocol on the
WebSocket — and without it the session answers as one that does not exist.
Reading a session says whether it is `private`. The MCP server's
`create_session` takes `private` too, under the key your MCP client sends. The
relay script reads a private session's key from the environment variable
`QA_TOOLS_ACCESS_KEY`, which gives `qa-tools-relay.mjs` a new SHA-256,
`ec830a1fcec5e7f8756ec83b139450e9a7c1ba2ad5fbbda9808157a4c826a2cf`; the API
reference gives it with the commands. Sessions created without `private` work
exactly as before, and the site's pages cannot open a private session yet. The
Privacy Policy now says who can see a private session and that QA Tools keeps
only a fingerprint of its key. (#227, D253)

## 1.10.0

2026-10-20

**The request list now shows which response rule answered each request.**
A row a rule answered carries a small grey tag right after its status, `R2`
for rule 2 (`П2` in Russian), so a session whose rules answer several paths
can be read at a glance without opening each request. Hovering the tag, or a
screen reader reading the row, says `Answered by rule 2`. The number is the
rule's place when it answered; the request's Response tab still names the
rule in full, with its method and path. Rows no rule answered look as before,
and the tag appears live, in every open tab, as soon as the answer is
recorded. (#233)

## 1.9.1

2026-10-20

**No change for users; the documentation of the limit on API answers still
being sent now says exactly when a client meets it.** An answer counts only
while it is being written, so a client that reads each answer as it comes
meets the limit only when its address has more than 16 MiB of answers being
written at once — many large reads in parallel on a slow link, or many clients
behind one shared address — or the server more than 64 MiB. The API
documentation, the guide for AI agents and the entry of 1.0.8 said the limit
could not reach such a client at all. (#219)

## 1.9.0

2026-10-20

**A custom response can now give back values from the request it answers:
the same id, a field of the JSON it was sent, a header or a query
parameter.** Mark a response `"template": true` through the API or the MCP
tools, and placeholders in its body are filled in for each request:
`{{request.id}}`, `{{request.method}}`, `{{request.path}}`,
`{{request.query.<name>}}`, `{{request.header.<name>}}` and
`{{request.body.<path>}}`, such as `{{request.body.order.id}}`. It works for
the session's response, each step of a response queue and each response
rule. Values are escaped for the response's `Content-Type`, so a quoted
placeholder stays valid JSON; a missing value is left empty; and the answer
stays within 64 KiB. Every `{{` of a template must be one of the
placeholders, or the response is refused when you save it. A response not
marked is sent exactly as configured, as before, `{{` included. Every answer
that carries a response, and the realtime update, now carry `template`. The
session page keeps the setting when you save a response, and does not show
it yet. (#135, D251)

## 1.8.0

2026-10-20

**Filtering a session's requests by a header no longer shares its places with
searches, and a refusal now says when to try again.** A query of requests
with header conditions alone, or with no condition, now takes one of two
places of its own instead of one of the two it shared with every search and
every query that looks into bodies: a search running in someone's inspector
no longer refuses it, and it never holds up a search. A search or a query
with a body condition keeps its two places, unchanged. Every `429` with
`errorCode` `1012` — from the search, from the query and from either count —
now carries `Retry-After: 1`: parallel tests that each find their webhook by
a header such as `X-Merchant-ID` can call again after a second. The MCP tool
`list_requests` follows the same rule; its refusal stays a tool error with
`errorCode` `1012`. The filter stays in the request body, never in a URL.
(#130, D250)

## 1.7.6

2026-10-20

**While the Response queue dialog is saving, its steps can no longer be
edited, so the queue saved is the one you see.** A change made to a step in
the moment a save took used to stay on screen and be left out of what was
saved, with no word. Now, until the save or a removal answers, the selected
step's fields, `Duplicate` and `Remove step` are unavailable, as `+ Add step`
and `Cancel` already were, on desktop, tablet and phone; another step can
still be opened to look at, and a save that fails makes them editable again,
as the Response rules dialog already does. (#234)

## 1.7.5

2026-10-20

**No change for users; the API reference now says exactly when the server
closes a connection after refusing a malformed URL.** Since 0.57.1 the
server's refusal of a path it cannot decode, `400`, or of a session id or
other path parameter over 100 characters, `414`, closes the connection of any
request that carries a body, even one whose body was sent whole with its
headers, where the reference read as if that connection stayed open. The
reference's memory figure for live connections is corrected, and the entry of
0.57.1 now says that an answer written before the body has all arrived may
reach a client still sending it as a connection reset. (#180, D227)

## 1.7.4

2026-10-20

**Nothing changes for users; a rare database failure is now logged under its
real cause.** If the server lost its database connection while saving a
captured request or a change to what a session answers, the log could name
the failed clean-up instead of the original error. (#209)

## 1.7.3

2026-10-20

**The line that splits the `Generate URL` tile is now dashed, like the tile's
own border.** It keeps the border's stroke, dashes and colour from the tile's
top to its bottom, and each part of the tile still lights up exactly up to it.
(#248)

## 1.7.2

2026-10-20

**Buttons now show the hand cursor on hover, as links do, and the line that
splits the `Generate URL` tile is easier to see.** The line between `Generate
URL` and the session options now runs the tile's full height in the colour of
its dashed border, and each part of the tile lights up exactly up to it. A
disabled button keeps the arrow. (#246)

## 1.7.1

2026-10-20

**No change for users; more of the groundwork for private sessions is now
held by tests.** Changing a session's response, queue or rules, deleting a
session and waiting for its requests are tested to answer a caller without
the session's key exactly as for a session that does not exist, an expired
session included. (#229, D245)

## 1.7.0

2026-10-20

**The home page now lets you choose how long a new session lives after its
last use — 7 days, 1 day or 1 hour — and whether it keeps the sender's IP.**
The choice sits on the `Generate URL` tile, always showing its current values;
one click on the tile still creates a session that expires 7 days after its
last use and keeps the sender's IP, as before. Every session page now states
the rule its own session follows — `SESSION EXPIRES 1 HOUR AFTER LAST USE`,
or for a session created through the API with a fixed lifetime its end,
`SESSION EXPIRES 26 SEP AT 11:50` in your time — and adds `IP NOT STORED` for
a session that keeps no sender address, whose requests read `IP not stored`
instead of `IP unavailable`. A session page left open reads its session every
10 minutes, so an open tab keeps even a 1-hour session alive. `Session not
found` now says the session most likely went unused for the time chosen when
it was created. In English and Russian, on desktop, tablet and phone. (#216,
D249)

## 1.6.0

2026-10-20

**From 2026-11-24, a new value of an enum in an API answer, such as a
response's `state`, may ship without notice.** The stability policy in the API
docs and in this changelog's header now says so, and this entry announces it
more than 30 days ahead: a client should accept a value it does not know.
Nothing else in the API changes with this version. (#159, D248)

**Deprecated:** the fixed list of values of each enum in an answer or an
event, such as a response's `state`. From 2026-11-24 such an enum may gain new
values at once, without notice, as an answer gains fields; none is added before
that date. A client accepts a value it does not know. (#159, D248)

## 1.5.1

2026-10-20

**No change for users; the server's test suite now reports every test it
runs.** On a busy machine the suite could leave the last results of a test
file out of its report and still pass. It now waits until every result is
reported, and a test file that does not end on its own fails, naming what
kept it running (#160, D132).

## 1.5.0

2026-10-20

**Response rules can now be set up on the session page: a `Response rules`
section under the response queue in the quick switch, and a dialog that adds,
orders, edits and removes them.** Each rule is a method, or any method, and a
path under the session's address, exact or ending in `*`, with a status, a
delay, headers and a body; the first rule a request matches answers it, before
the queue and the session response. Rules are reordered by dragging `⋮⋮`, or
with the up and down arrows, and saved together. The response button counts
them, `Custom · 200 · 3 rules`, another open tab on the session follows at
once, and the Response tab of a request a rule answered names it,
`Rule 1 · POST /orders`. In English and Russian, on desktop, tablet and phone.
A page no longer forgets the rules it shows when the server it talks to is
briefly an earlier version, during an update. (#226, D246)

## 1.4.0

2026-10-20

**A custom response with a `3xx` status can now carry a `Location` header, so
a sender's handling of redirects can be tested.** Its value must be a path on
the webhook host that begins with `/s/`, such as `/s/<session-id>/after`, which
the same session captures like any path under its address; it can never point
elsewhere. `Location` with any other status, or with any other target, answers
`400` with `errorCode` `1005`, as before. Several `Location` headers are sent in
the order given. The rule holds for the session's response, every step of a
response queue and every response rule, through the API, the MCP tools and the
response editor, which says what is wrong under the header row. `Refresh` and
every other reserved header stay reserved. (#168, D247)

## 1.3.0

2026-10-20

**A session can now answer by path and method: up to 20 response rules, each
a method, or any method, and a path, exact or ending in `*`, with a response
of its own, set through the API.** A request is answered by the first rule it
matches, before the response queue, and takes no step of it; a request no rule
matches is answered as before, by the queue's next step and then the session's
response. The path is what follows the session's address, matched exactly as
sent and without the query. `PUT /api/sessions/{sessionId}/rules` sets the
whole list and `{"rules":[]}` removes it; `POST /api/sessions` takes `rules`
too. `GET /api/sessions/{sessionId}`, the answers of the calls that change a
session and `session.updated` carry `rules`, and every captured request names
the rule that answered it as `response.rule`. The web interface does not show
rules yet. (#134, D246)

## 1.2.1

2026-10-19

**Behind the scenes, the server is now ready for private sessions; nothing
changes for any session today.** A session may carry a fingerprint of an
access key, and one that does answers only a caller presenting that key,
anyone else exactly as a session that does not exist. No session carries one
yet, so every session answers every call as before, and webhooks are captured
as before. (#98, D245)

## 1.2.0

2026-10-19

**A session can now be created to keep no sender IP address.**
`POST /api/sessions` takes an optional `storeSourceIp`, `true` or `false`,
alone or beside the other keys: with `{"storeSourceIp":false}` every request
the session captures is stored without the sender's address, and `sourceIp`
is `null` wherever it is given — the list, the detail, the live event, a
waiting list call, the query, the default answer and the MCP tools. The
headers the sender sent, `X-Forwarded-For` included, are still kept exactly as
sent. `true`, or leaving the key out, keeps the address as every session did.
The choice is made at creation only. Any value other than a JSON boolean, such
as `"false"`, `0` or `null`, answers `400` with `errorCode` `1005` and creates
nothing. `GET /api/sessions/<session-id>` now carries `storeSourceIp`, always
present: `true` for every session created without the key, older ones
included. The MCP server's `create_session` takes the same key. Usage
statistics count such requests under an unknown network. The Privacy Policy
says so in `What a session keeps`; it keeps less, so the change applies at
once. (#166, D243)

## 1.1.0

2026-10-19

**A session can now be created to expire an hour or a day after its last use
instead of a week, and reading a session says which rule it expires by.**
`POST /api/sessions` takes an optional `expiresAfterIdleSeconds`, a whole
number of seconds from 3600 to 604800 (1 hour to 7 days), alone or beside
`response` and `queue`: `{"expiresAfterIdleSeconds":3600}` creates a session
that expires an hour after it was last used. Everything that keeps a session
alive keeps it alive as before — a webhook, reading it, changing its response
or its response queue — each moving its expiry a full window ahead again, at
most once an hour, or, for a window under 10 hours, once every tenth of it: a
use every 10 minutes keeps a 1-hour session alive. An expired session is never
revived. The MCP server's `create_session` takes the same key. It cannot be
given together with `expiresInSeconds`, the fixed lifetime, which keeps its
meaning: such a request answers `400` with `errorCode` `1005`, as does a value
outside the range, and creates nothing. `GET /api/sessions/<session-id>` now
carries two more fields, always present: `expiresAfterIdleSeconds`, the window
of a session that slides — 604800 for every session created without the key,
older ones included — or `null`, and `lifetimeEndsAt`, the fixed end of a
session created with `expiresInSeconds`, or `null`. The status read's
`lastUsedAt` is the expiry minus the session's own window. Sessions created
without the new key expire 7 days after their last use, exactly as before.
(#158, D242)

## 1.0.14

2026-10-19

**An ordinary HTTP request to the WebSocket address `/ws/<session-id>` now
gets a clean `404` with `errorCode` `1000`.** A `HEAD` request there answered
`500` with `errorCode` `1500` and was logged as a server fault; a `GET` that
asks for no WebSocket answered `404` with no body. Both now answer `404` with
the usual error body, `{ "errorCode": 1000, "message": "Not found" }` (a
`HEAD` its headers alone), whatever the session id, and nothing is logged as a
fault. WebSocket connections themselves are unchanged. (#179, D026, D062)

## 1.0.13

2026-10-19

**A call refused for going over a per-address limit no longer leaves lines in
the server's log.** Each such refusal wrote two lines; it now writes none, so
an address sending far more calls than its limit allows costs the server less.
The refusal's answer is unchanged: the same status, body and headers. Every
other call is logged as before. (#189, D201)

## 1.0.12

2026-10-19

**"Copy as cURL" now keeps a request's `X-Forwarded-*`, `X-Real-Ip` and
`Accept-Encoding: gzip` headers, so the copied command re-sends them as the
sender wrote them.** Until 0.36.0 the proxy in front of the site added these
headers to every request it captured, so the command left them out; since
then a capture holds only what the sender wrote, and the command still dropped
them. Now each is written like any other header, in its order and letter case,
repeats kept, for every request: one captured before 0.36.0 is not told apart,
so its `Accept-Encoding: gzip`, and before 0.11.0 its forwarding headers, may
be the proxy's. A server that answers a replayed `Accept-Encoding: gzip` with
a compressed body has it printed by curl undecoded. `Host`, `Content-Length`
and the connection's own headers are still left out.

The relay script sends exactly what it sent before: it keeps leaving out the
forwarding headers and an `Accept-Encoding` of exactly `gzip`, because it
sends on unattended, into a service that may trust a proxy on its own machine.
Only its comments changed, which gives `qa-tools-relay.mjs` a new SHA-256,
`e2688dacfd683e76bef5ffa84fbac691dfa8b280935f13dd6cf03bb7e0c750dd`; the API
reference gives it with the commands. (#114, D167)

## 1.0.11

2026-10-19

**The Privacy Policy announces a change to the server's log, at least 14 days
before it applies.** `Changes to this policy` on `/privacy` now has a dated
line saying what changes and from which day; until that day nothing is logged
differently. (#214, D224)

**Notice:** from 2026-11-02, the server's log records the IP address of a
sender that sends far more requests than the limits allow, at most once a
minute. (#214, D224)

## 1.0.10

2026-10-19

**No change for users; the server now logs a database connection it loses,
and its notes and tests say exactly what it does.** Deleting a request, a
session or every request of a session, and recording a webhook's response, now
end their database work through one shared piece of code, which behaves as
before. A database connection that ends unexpectedly now leaves one line in the
server's log. (#173, D221)

## 1.0.9

2026-10-19

**An open request's detail panel no longer goes back to "pending" after its
response was recorded.** When a request was opened just before its response
was recorded, the panel could show the recorded response for a moment and then
"pending" again, while its row in the list showed the final state. And when the
live connection dropped while a response was recorded, the panel stayed
"pending" after the page reconnected. In both cases the panel now ends on the
response the server holds, like its row, without reopening the request.
(#204, D125)

## 1.0.8

2026-10-19

**Large API answers that their clients leave unread no longer restart the
server from two addresses: the answers still being sent are now bounded by
their size, per address and in all.** A client that reads only the beginning
of each answer leaves the rest in the server, and the read of a session with
a full response queue is about 1 MB; two addresses each leaving 128 such
answers unread ran the server out of memory, stopping webhook capture for
everyone until it restarted. Now the answers of the API and the MCP server
that have not yet been written to their clients may weigh at most 16 MiB per
client address and 64 MiB on the server, an answer counting from the moment
it is ready until it has been written whole or its client has gone. An answer
that would pass either while its address already has another one being
written is not sent: the call is answered `429` with `errorCode` `1019` and
`Retry-After: 1` instead, the refusal clients already meet when they have too
many calls in flight, and what the call did stands. An address's first answer
is always sent, whatever its size, and since an answer counts only while it is
being written, a client that reads each answer as it comes meets the bound
only when its address has more than 16 MiB of answers being written at once —
many large reads in parallel on a slow link, or many clients behind one shared
address — or the server more than 64 MiB. The server was measured surviving
that flood from 4 addresses at once, every webhook of another sender still
captured, where 2 restarted it before; from 8 it still restarts. The number of
attacking addresses the server is stated to hold against rises from 1 to 3,
now set by connections that stop in the middle of their header lines while
sending far more than the header limit. The 3 is inferred from that flood's
measurement for 1.0.4, survived from 3 addresses and not from 4; it was not
measured again for this version. (#184, D228)

**Breaking:** this limit is stricter, and ships at once, against overload of
the server: an answer of the API or the MCP server that would take the
answers its address has not yet had written past 16 MiB, or the server's past
64 MiB, while the address already has another one being written, is now
replaced by `429` with `errorCode` `1019` and `Retry-After: 1`, where it used
to be sent — on the MCP server as a JSON-RPC error under the request's own
`id`. The call itself has been carried out: a session it created exists and a
change it made is saved, and calling it again repeats it, so a creation called
again creates another session. An address's first answer is always sent,
whatever its size, and a client that reads each answer as it comes meets the
limit only when its address has more than 16 MiB of answers being written at
once — many large reads in parallel on a slow link, or many clients behind one
shared address — or the server more than 64 MiB. (#184, D228)

## 1.0.7

2026-10-18

**No change for users; a request list whose client leaves before its answer
begins is no longer logged as a server error.** When the client of a
`POST /api/sessions/<session-id>/requests/query` with `include` closed its
connection before the answer began, the server logged an error and wrote an
error answer to the closed connection. Now it logs that the client gave up, as
it does for a request whose body never arrived, and begins no answer; the
list's `GET` is logged the same way. Every answer a client receives is the same
as before. (#212, D174)

## 1.0.6

2026-10-18

**No change for users; the notes on how the interface picks its language now
say exactly what it does.** When a browser's list of preferred languages is
empty, its single preferred language decides, as it always has; the notes now
say so, and a test holds it.
(#175)

## 1.0.5

2026-10-18

**A response recorded while the session page loads its request list now shows
on its row.** When a webhook was answered just as the page opened or
reconnected, its response could arrive before the list did, and the list, read
a moment earlier, put the row back as `pending` until the next reload. Now the
page keeps what arrives during the load and writes it onto the rows the list
brings, so every row shows its response as it is once the list has loaded. A
response never adds a row of its own, and a deleted request stays deleted.
(#174, D077)

## 1.0.4

2026-10-18

**Connections that stop in the middle of very many header lines no longer
restart the server from two addresses: it now reads a bounded number of header
lines still in flight, per sender and in all, and lets the rest wait.**
The webhook host stores every header line a webhook carries, and the server
keeps every line of a request it is still reading. Hundreds of connections from
one address, each stopping after some 16,000 header lines, held a large part of
the server's memory, and two such addresses could restart it. Now the
connections of one sender address to `https://hook.qa-tools.ru` have at most
32,768 header lines read of requests whose headers have not yet ended, and the
server at most 524,288 in all; a line counts from the moment the server reads
it until the empty line that ends its headers, or until its connection closes,
and the trailer lines of a chunked body count the same way. A connection whose
next line does not fit waits, unread, until lines are given back. Nothing is
refused, closed or answered for it, and every webhook is still captured whole,
with every header line in order; the first connection of an address holding no
lines is never held by its address's number, so the largest webhook you can
send is never held by its own size. During such a flood a waiting connection
keeps the server's usual timeouts, so a webhook with very many header lines can
meet the 60-second headers timeout. The server was measured surviving such a
flood from 8 addresses at once with no restart, where 2 restarted it before. A
waiting connection keeps what its sender sends past its room unread in the
server, up to about a quarter of a megabyte, so a flood whose waiting
connections each send that much still restarted it from 4 addresses. The number
of attacking addresses the server is stated to hold against stays 1, set by
large API answers their clients leave unread. (#182, D238)

## 1.0.3

2026-10-18

**No change for users; a `HEAD` request to the request list no longer makes
the server read bodies it does not send.** A `HEAD` to
`/api/sessions/<session-id>/requests` with `include` was answered at once, with
no body, but the server went on reading every listed request's headers and
body afterwards for no one, no longer counted by the limits on list answers
with bodies and on calls in flight. Now it reads none: a `HEAD` costs only the
work that decides its answer, and while that work runs it counts toward both
limits as before. Every answer to a `HEAD` is the same as before.
(#210, D201, D213)

## 1.0.2

2026-10-18

**After a failed Apply or `Run again` in the quick switch, the keyboard focus
stays in it.** While Apply or the queue's `Run again` was being sent, its
button was disabled and the focus went to the page itself, so after a failure
`Enter` and `Space` did nothing until you clicked or tabbed again. Now a failed
Apply puts the focus back on its button, which reads `Try again`, and a failed
`Run again` back on `Run again`, beside its message. When `Run again` goes
because the queue was started from step 1 again — by another viewer, a save or
`Delete all` — the focus moves to the Response queue heading. Focus you put
somewhere else meanwhile stays where you put it. (#143, D206, D150)

## 1.0.1

2026-10-18

**No change for users; when a night's off-server backup copy fails, the
owner's alert now names the right cause.** When an earlier attempt to upload
the copy stalled or failed, and the next one was still sending as the time
allowed ran out, the alert said the copy was too large for that time. It now
names the earlier attempt's problem first, so a storage that stalled or did not
answer is told apart from a copy too large to send in time. The copy has always
failed safely: the night's backup stays on the server and nothing is lost.
(#121, D190)

## 1.0.0

2026-10-14

**QA Tools 1.0 is out, and its API is now under the stability policy.** From
this version on, a change to what already exists in the API, the webhook URLs
and what they answer, or the relay script is announced at least 30 days before
it ships, in a Deprecated paragraph of the changelog that the breaking-changes
feed carries, unless it is needed for security, against abuse or overload, or
to recover from an outage, when it ships at once with the reason; additions
ship at once, and the MCP server stays experimental and may change without
notice. Nothing else in the service changes with this version: its addresses,
fields, limits and behaviour are those of 0.57.5, and the policy is set out
under Stability at `https://qa-tools.ru/docs`. (D233)

## 0.57.5

2026-10-12

**The Privacy Policy now says that the proxy in front of the server records a
sender's IP address in its error log when a connection fails: a correction of
an untrue sentence.** Its `Logs` section said "The server's log records each
request's method, URL and time, but not the sender's IP address." and named no
other log, so the policy read as if no log kept a sender's address, which was
not true. The proxy that receives every connection first writes a line to its
error log when one fails — for example when the sender drops it in the middle
of a request — and that line holds the sender's address. The proxy has always
done so: nothing more is kept, kept longer or shared than before, so the
policy changes at once. Its new line reads: "The proxy in front of the server
records a sender's IP address in its error log when a connection fails, for
example when the sender drops it mid-request. That log stays on the server
until the proxy restarts; it is not backed up or sent anywhere." The policy's
other lines are unchanged, and its date is now 12 October 2026. (#185, D231)

## 0.57.4

2026-10-12

**One sender can no longer restart the server by pipelining many tiny
requests down its connections: the server now reads at most 32 requests of a
connection ahead of their answers.** HTTP lets a client send its next request
on a connection before the answer to the one before has arrived. The server
used to read everything such a client had sent at once — hundreds of tiny
requests in one go — and keep every one until its turn to be answered, so a
few hundred connections from one address could use up its memory. Now a
connection to `https://hook.qa-tools.ru` has at most 32 requests read and not
yet answered; the requests a client pipelines past them wait in the
connection, unread, until earlier ones have been answered. Nothing is refused
for it: every request is still captured and answered, in the order it was
sent, though a long pipeline to a session whose answers are delayed is
answered in turns of 32, and a body with many empty lines close together is
read only once the requests pipelined before it on its connection have been
answered. The server was measured surviving such a flood from 8 addresses at
once with no restart, each opening 256 connections, and from 4 when each
opens all the 512 connections an address may have — from 8 such addresses it
ran out of memory; the number of attacking addresses it is stated to hold
against stays 1, set by connections that stop after the most header lines
allowed and by large API answers their clients leave unread. (#181, D229)

## 0.57.3

2026-10-12

**A webhook can now be refused at once when too many are already waiting for
room, so that a burst of waiting webhooks from one sender can no longer use up
the server's memory, though a burst that pipelines many tiny requests down
each connection still can.** Webhooks to `https://hook.qa-tools.ru` are
received within a budget of memory, and one that does not fit waits for room
(up to 30 seconds). The webhooks waiting are now bounded too: at most 64 MB of
them may wait on the server, plus the first waiting webhook of each address,
and 16 MB of them from one address, each counted by its headers — 16 KB plus a
little for every header line. A webhook that must wait while another from its
address is already waiting, and does not fit that line, is refused straight
away rather than after 30 seconds: `503` with `errorCode` `1018`,
`Retry-After: 1` and the connection closed, nothing stored. The first webhook
of an address to wait is always let in, so the largest webhook you can send
still waits and is stored. From one address alone, 512 webhooks waiting at
once with up to 64 header lines each fit in its 16 MB; with more header lines
fewer do — 399 with 100 lines each. And when a burst of waiting webhooks is
refused together, the server now reads and discards their bodies a few at a
time rather than all at once, which is what used to drive its memory up;
webhooks still sent to the old address on `https://qa-tools.ru`, answered
`410`, share those few places. The server was measured surviving floods of
waiting webhooks from 4 addresses at once with no restart; a flood of
connections that each stop after the most header lines allowed it survives
from 1 address only, so 1 is the number of attacking addresses it is stated to
hold against, the pipelined burst aside, which one sender can still use to
restart the server. Not every kind of flood is bounded yet. (#157, D228)

**Breaking:** a webhook to `https://hook.qa-tools.ru` can now be refused
`503` / `1018` **at once**, before the 30-second wait, when the webhooks
already waiting for room fill the line — 16 MB from your address, or 64 MB on
the server — where before every webhook waited the full 30 seconds before any
refusal. The answer carries `Retry-After: 1` and closes the connection;
nothing is stored; send the webhook again after the `Retry-After`. Once the
line is full, every webhook that has to wait while another from your address
is already waiting is refused this way, however small; only the first of your
address to wait always waits. So a sender meets it when its own webhooks
waiting fill its 16 MB, or when floods from other addresses fill the server's
64 MB while it has one waiting already. (#157, D228)

## 0.57.2

2026-10-12

**The server's log no longer keeps more than the first eight characters of a
session id written right next to other letters or digits.** The log writes
every run of 43 or more characters from `A–Z`, `a–z`, `0–9`, `-` and `_` as
its first eight characters followed by `...`, the whole run at once. Before,
such a run was cut into pieces of 43 counted from its start, so a session id
written straight after other characters of that kind could leave most of its
characters in the log: one written right after 42 such characters left 42 of
its 43 there. Now a
session id keeps at most its first eight characters in a logged line whatever
letters, digits, `-` or `_` stand right next to it, and none of them when
eight or more such characters stand right before it; a long
token that is not a session id is logged as its first eight characters and
`...` too. Addresses such as `/s/<session-id>` were already logged this way
and do not change (#176, D059).

## 0.57.1

2026-10-11

**One client can no longer use up the server's memory with connections: an
address may now have at most 512 connections open at a time to the webhook
host and 16 live connections to session pages, and an answer the server
writes before a request's body has arrived closes the connection.** A sender
that opened many connections and never finished their headers, or a client
that opened many live connections to a session page and never read them,
could keep enough of the server's memory to stop webhook receiving, the API
and the site for everyone until it restarted. Now the server lets one address
have 512 connections open at once to `https://hook.qa-tools.ru`, so a
provider or a CI runner sending hundreds of webhooks at a time keeps room —
a burst of 500 webhooks at once from one address stays within it — and
16 live connections at once to `wss://qa-tools.ru/ws/<session-id>`, enough
for 16 tabs of session pages from one network. A page over that number keeps
trying to reconnect, as after any interruption, and gets in once another tab
of its network closes. And any answer the server writes before the request's
body has arrived — the old webhook address's `410`, a webhook refused after
waiting for room, an unknown path on either host, a refused live connection —
now closes the connection, as answers of the API already did, so that a body
that never comes keeps nothing; a client still sending its body when such an
answer is written may get a connection reset instead of the answer, and opens
a new connection for its next request. A request to a path that does not exist,
on either host, is now answered before the server reads any of its body, which
it used to read first and hold, up to 1 MB on the webhook host, for as long
as the sender took to finish it. The server writes no address down for any of
this: the Privacy Policy's line on limits now reads "Limits keep an IP
address in memory for up to a minute, or while its connection stays open, and
write it nowhere." An open connection always held its address; nothing more
is kept. (#145, D227)

**Breaking:** these limits are stricter, and ship at once, against abuse and
overload of the server: the 513th connection open at the same time from one
address to `https://hook.qa-tools.ru` is closed by the server with no HTTP
answer, where it used to be served — an IPv6 address counted by its `/64`;
the 17th live connection open at the same time from one address to
`wss://qa-tools.ru/ws/<session-id>` is refused before it opens, `429` with the
new `errorCode` `1020` and `Retry-After: 1`, where it used to be accepted —
an IPv6 address counted by its `/64` there too; a request to a path that does
not exist, on either host, is answered `404` / `1000` before its body is read,
whatever the body, where a body declared as JSON or text used to be read first
and was answered `400` / `1006` when it did not parse or `413` / `1004` when
it was too large, and on `https://hook.qa-tools.ru` `500` / `1500` when it was
declared as JSON and held bytes that are not UTF-8; an answer written before
the server has read the request's whole body — including a `503` / `1018` on
a connection kept alive, `404`s outside the API, `https://qa-tools.ru/s/…`'s
`410` and the answer to a webhook sent as `GET`, `HEAD` or `TRACE` whose
declared body is still arriving — now ends the server's connection, where it
used to keep it alive, as a `413` / `1004` for a webhook body declared over
1 MB already did; and so does an upgrade request to `https://qa-tools.ru`
that is answered rather than upgraded, body or none, where it used to leave
the connection open. On `https://hook.qa-tools.ru` that is the sender's own
connection, and the answer carries `Connection: close`; on
`https://qa-tools.ru` it is the proxy's connection to the server, and the
client's own connection to the proxy may stay open, the answer reaching it
without that header. The proxy in front of the webhook host passes every
connection on to the server, which counts them. (#145, D227)

## 0.57.0

2026-10-11

**The home page now has a Russian version, `https://qa-tools.ru/ru/`, which
search engines can find in Russian.** It is the same page as `/`, Russian from
its first frame, with a Russian title and description for search results and
link previews, `QA Tools — проверка вебхуков онлайн`, and its Russian text is
there for a reader without JavaScript too. Opening it remembers Russian as
your language, so the session you create there and every page after it are
Russian, and while the interface is in Russian the QA Tools wordmark and
`На главную` lead back to `/ru/`. On the two home pages `EN | RU` also moves
between them — `RU` to `/ru/`, `EN` to `/` — and remembers the choice;
everywhere else it changes the language in place, as before. `/` stays where
it was and, as before, follows the language you chose or your browser's; in
Russian its tab now carries the same title as `/ru/`. The site map lists
`/ru/`, and the two home pages name each other for search engines. The pages
about QA Tools, the terms, the privacy policy, the changelog and the API
reference stay in English (#109, D226).

## 0.56.0

2026-10-11

**The Terms of Use now name the law that governs them, and a change to the
Terms of Use or the Privacy Policy is announced 14 days before it applies.**
`/terms` has a new section, `Governing law`: the terms are governed by the law
of the Russian Federation. A new version of the Terms of Use is announced on
the page at least 14 days before it applies; changes the law requires, changes
needed to protect the service and changes that only add to your rights apply
when published. `/privacy` has a new section, `Changes to this policy`: a
change that makes QA Tools keep more data, keep it longer or share it with
anyone new is announced there at least 14 days before it applies, unless the
law requires it sooner, and other changes apply when published. Such an
announcement also reaches this changelog as an entry with a paragraph that
starts **Notice:**, which the page labels `Notice` and shows under
`Breaking only`, and which the feed of breaking changes and deprecations
carries. `/terms`, `/privacy` and `/about` now say that a company can ask by
email for a data processing agreement as well as for the operator's details.
This version applies as published, since it only adds to your rights.
(#163, D224)

## 0.55.1

2026-10-11

**The Privacy Policy no longer overstates what the server's log keeps of a
session id.** Its `Logs` section said that a logged URL includes the session
id. It now reads "The URL includes the first eight characters of the session
id and any query string." Where the service's own addresses carry a session
id, as in `/s/<session-id>`, the log writes its first eight characters
followed by `...`, enough to tell sessions apart in the log and useless for
opening one, and no 43 characters from `A–Z`, `a–z`, `0–9`, `-` and `_` are
left in a row anywhere in a logged line, so no session id's 43 characters
stand together in it.
Nothing else changes on that page or on the Terms of Use, and nothing changes
in what is logged (#155, D217).

## 0.55.0

2026-10-11

**A default session now answers a webhook with what it captured and a link
to it in the inspector, so the sender's log or a CI log is enough to find the
request.** Besides `ok` and `requestId`, which keep their place, the answer
carries `message` (`Captured by QA Tools`), `inspectorUrl` — the request on
its session's page, `https://qa-tools.ru/v/<session-id>#<request-id>`, which
opens it in a browser — and the request's `receivedAt`, `method`, `path`,
`bodySize` and `sourceIp`, as the inspector and the API show them. Nothing of
the request's body, headers or query string is repeated, and the link grants
nothing the webhook URL does not. A custom response and the response queue
answer exactly as before, and requests captured earlier keep the answer they
were given. The Default response's summary now reads
`200 OK · JSON describing the request · no delay.`, and the MCP server's
`create_session` describes the new answer. (#137, D223)

## 0.54.1

2026-10-11

**An update of the server no longer stops webhook receiving, the API or the
site: the new version starts and takes over before the old one stops.** For
the few seconds of an update both versions serve, and every capture, deletion
and response change reaches the open pages and the calls waiting with `wait`
on either of them, as 0.53.1 prepared. The old version finishes what it was
answering, a webhook whose configured delay has begun included, and asks each
client to open a new connection for its next request; an open page reconnects
and reloads, as after any interruption. During those seconds each version
counts the per-address limits on its own, so an address may get up to twice a
limit. The server also ends a database transaction of its own left waiting for
a minute, instead of letting it hold what it locked. (#132, D221)

## 0.54.0

2026-10-11

**The interface can now be read in Russian: a browser that asks for Russian
gets it on its first visit, and `EN | RU` switches the language at any
moment.** Everything the home page and the session page show is in Russian
then — the header and the footer, the list of your sessions, the request list
and its filter, the detail panel, the request actions, the response settings
and the response queue, Compare, Check signature, the dialogs, toasts and
error messages — except the words that name HTTP itself: the `Raw`, `Body`,
`Headers`, `Query`, `Request` and `Response` tabs, methods, status phrases,
header names, the units `B`, `KB`, `MB` and `ms`, `cURL`, `JSON` and
`API docs`. The detail panel and the days of your session list are dated the
Russian way, `17 сент. 2026, 14:32:06`, while list rows keep
`2026-09-17 14:32:06`. On a wide screen the switch closes the header's links;
on a phone it is in the footer, before the contact address. It changes the
language at once, without reloading the page or losing the open request, and
your browser remembers the choice; a browser that asks for neither English nor
Russian gets English. The Privacy Policy now lists the interface language you
chose among what your browser keeps. The pages about QA Tools, the terms, the
privacy policy, the changelog and the API reference stay in English (#108,
D222).

## 0.53.1

2026-10-10

**The server is ready to run its old and new versions side by side during an
update, so that a later update need not stop webhook receiving, the API or the
site.** Until now a captured webhook, a deletion or a response change reached
only the people watching through the very server process that handled it, so an
update had to stop the running server before starting the new one, and for
about half a minute webhooks and API calls failed. Now every change is written
to the database together with the change itself, and every server process reads
it from there and passes it on to its own viewers and to calls waiting with
`wait`, in the order the changes happened, whichever process made them. This
version is itself installed the old way; the next one switches updates over.

A server that stops now first finishes what it was answering — a webhook whose
configured delay of up to 30 seconds has begun included — and asks each client
to open a new connection for its next request, instead of answering `503`.
While a server cannot read the database's stream of changes for a moment it
cuts its live connections, which the page and any client reconnect and reload,
and answers a new one with close code `1013`, Try Again Later, before `ready`:
retry it as any interruption. A `wait` it was holding is answered at once, as
at a shutdown; call again with `after`. A session deletion whose answer was lost
on the way now closes the session's open pages all the same. Until the next
version, an update leaves a gap about ten seconds longer than before.
(#132, D221)

## 0.53.0

2026-10-10

**A session can now be given a lifetime when it is created, so a test that is
interrupted before it deletes its session no longer leaves it behind for a
week.** `POST /api/sessions` takes an optional `expiresInSeconds`, a whole
number of seconds from 60 to 604800 (7 days), alone or beside `response` and
`queue`: `{"expiresInSeconds":3600}` creates a session that ends an hour after
its creation, with everything it captured, whatever happens to the test that
created it. Nothing extends it — not a webhook, not reading it, not changing its
response — and `expiresAt` in the answer is that end. Without the key a
session expires 7 days after its last use, as before, so a lifetime only ever
shortens one. A value outside the range, a fraction, a string or `null` is
refused `400` with `errorCode` `1005`, and nothing is created. The MCP server's
`create_session` takes the same key. For such a session, reading the status of
sessions gives `lastUsedAt` as the later of its creation and its newest
request (#129, D220).

## 0.52.1

2026-10-10

**One client can no longer use up the server's memory through the API: an
address may now have at most 128 calls in progress at a time, and a request to
the API carries at most 100 header lines.** A call the server holds open — a
`GET …/requests?wait=…` waiting for a webhook above all — keeps what its client
sent for as long as it waits, and nothing bounded how many one address could
hold: a few thousand waiting calls with long header blocks from one address
could use up the server's memory and stop webhook receiving, the API and the site
for everyone until it restarted. Now an address may have 128 calls in progress
at a time on the API and the MCP server together, waits included, so a CI run
with 100 waits pending still has room for its other calls, and a request to
`https://qa-tools.ru` may carry 100 header lines, `Host` among them. Webhooks
to `https://hook.qa-tools.ru` keep every header line, however many. Changing a
session's response, reading the status of sessions, searching and querying
requests now share the eight places for large bodies that creating a session
and saving a queue have, and so does a message to the MCP server; the server
lets go of each of these bodies once it has read it. The calls that take no
body — the deletions and restarting a queue — read at most 1 KiB of one sent
anyway and keep none of it, and an answer the server writes before a request's
body has arrived closes the connection, so that a request whose body never
comes is not kept.

**Breaking:** these limits are stricter, and ship at once, against abuse and
overload of the server: the 129th call in progress from one address is now
refused `429` with the new `errorCode` `1019` and `Retry-After: 1` — on the MCP
server as a JSON-RPC error with `id` `null` — where it used to be served; a
request to `https://qa-tools.ru` with more than 100 header lines is now refused
`431` with no `errorCode`, where the limit was 1000; and `PUT
/api/sessions/{sessionId}/response`, `POST /api/sessions/status`, `POST
/api/sessions/{sessionId}/requests/search` and `POST
/api/sessions/{sessionId}/requests/query` with a body over 128 KiB, or sent
chunked, are now refused `429` with `errorCode` `1017` while eight such bodies
are being read, where they used to succeed, and so is a message to the MCP
server with such a body. The deletions and `POST
/api/sessions/{sessionId}/queue/restart` with a body over 1 KiB are now refused
`413` with `errorCode` `1004`, where a body of up to 1 MiB was read and
ignored, and with a body declared JSON that is not UTF-8 `400` with `errorCode`
`1006`, where it was `500`; a call to a path or with a method the API has no
route for, with a body declared `application/json` or `text/plain` over 1 KiB,
is now refused `413` with `errorCode` `1004`, where a body of up to 1 MiB was
answered `404` with `errorCode` `1000`; any method but `POST` to the MCP
server is now `405` before its body is read, where a body over 1 MiB or a
`Content-Type` that is no media type was `413` or `415`. An answer written
before the request's body has arrived — a refusal before the body, above all —
now closes the connection: a client still sending can lose that answer, and
its next call opens a new connection. Call again after a second; an ordinary
client meets none of them (#139, D213).

## 0.52.0

2026-10-10

**Two new pages, `/terms` and `/privacy`, set out the Terms of Use and the
Privacy Policy, and every page's footer links to them.** The Terms of Use say
that a session's address is its key and should be shared only with people and
systems you trust; state the limits; say what may not be done with QA Tools —
serving phishing pages, malware or other harmful content through a session's
response, attacking, scanning or flooding other systems, overloading the
service — and what happens when the rules are broken; promise that a shutdown
would be announced on the site at least 30 days ahead; and say whom to write
to. The Privacy Policy says what a session keeps, who can see it, how long it
is kept and how much longer the nightly backups keep it, what the daily usage
statistics record, what the server's log records, what stays in your browser,
where everything is stored, in Russia, and how to have your data deleted. Both
are in plain English and describe the service as it works today. The footer
now reads `About · Terms · Privacy` before the contact address, and on the
narrowest phones it breaks after a dot rather than running off the screen. The
API reference links both pages in its introduction, and search engines are
offered them. Nothing changes in the API (#112, D217).

## 0.51.0

2026-10-09

**You can now subscribe to the changelog, all of it or only the changes that
can break an API client, and the API reference says how such changes will be
announced from version 1.0.** Two Atom feeds,
`https://qa-tools.ru/changelog.xml` with every version and
`https://qa-tools.ru/changelog-breaking.xml` with only the versions that have a
Breaking or a Deprecated paragraph, carry one entry per version, newest first,
so a feed reader, Slack or a Telegram bot can tell your team before a change
reaches its tests. `/changelog` and the API reference name both, and offer
them to a browser's feed reader.

QA Tools is in beta (0.x): the API may still change, and every breaking change
is marked in the changelog as before. From 1.0 the API keeps its paths, `/api/…`, as
version 1; additions ship at once; a part that changes ships beside the old
one, which is deprecated with a removal date at least 30 days ahead; what
cannot sit side by side, such as a stricter limit, is announced at least 30
days before it ships; a change needed for security, against abuse or to
recover from an outage may ship at once, with the reason; and the MCP server
stays experimental. The whole policy is in the Stability section of the API
reference and at the top of `/changelog.md`. Advance notices will be
paragraphs that start Deprecated, which the breaking feed carries; none has
one yet. Nothing changes in the API (#133, D212).

## 0.50.0

2026-10-09

**A new page, `/about`, says who runs QA Tools, how it is made, who pays for
it and what happens to the data you send.** QA Tools is a tester's personal
project, written by AI agents and made for them too. The page tells that
story and states four facts: how it is built; who pays for it, which is the
owner, with the promise that what is free today stays free and that paid
plans, if they ever come, will be extras for teams; what happens to your data,
with no ads, no cookies, no third-party analytics and captured requests never
sold or shared; and that a company doing a security review can ask for the
operator's details by email. Every page's footer now links to it as `About`,
before `Contact:`, the API reference names it in its introduction, and search
engines are offered it. Nothing changes in the API (#131, D211).

## 0.49.2

2026-10-09

**When `Generate URL` on the home page cannot create a session, a line under
it now says so, instead of the page doing nothing.** If the server cannot be
reached or answers with an error, for example while it restarts during an
update, the line reads
`This session could not be created. Please try again.` If your address has
already created 60 sessions within the minute, it reads
`Too many sessions created from your address. Try again in 40 s.`, with the
number of seconds the server asks you to wait. The line stays until your next
click, and `Generate URL` can be clicked again at once. Nothing changes in the
API (#128).

## 0.49.1

2026-10-08

**A burst of large webhooks no longer brings the server down: webhooks now
wait for room in a memory budget instead of all being taken in at once.**
About 180 webhooks of 1 MiB sent at once could exhaust the server's memory,
and webhook receiving, the API and the site then stopped until it restarted.
The server now receives webhooks within 64 MiB at a time, 16 MiB of it from
one address: a webhook counts its declared body, at most 1 MiB, plus 16 KiB,
256 bytes a header line and 64 KiB for its answer, from the moment its headers
arrive until its answer has been written. One that does
not fit waits, first come first served, before its body is read, and is
captured as soon as there is room, while webhooks from other addresses keep
going in; 500 webhooks of 1 MiB sent at once from one address are all
captured, one after another. A reply held by a configured delay now keeps only
what it sends, not the webhook's body.

**Breaking:** a webhook that has waited 30 seconds for room is now refused
`503` with the new `errorCode` `1018` and `Retry-After: 1`, and is not stored;
it used to be taken in at once, however many arrived. Send it again after a
second (#144, D210).

## 0.49.0

2026-10-07

**QA Tools has a public status page, https://status.qa-tools.ru, and the
header of every page links to it.** The page shows whether the site, the API
and webhook receiving are up, each checked every minute from outside, with its
uptime history and reports of outages users could notice, so a test that
failed while QA Tools was down can be told apart from a failure of the system
under test. `Status` sits in the header between `Changelog` and `API docs` and
opens the page in a new tab; `https://qa-tools.ru/status` leads there too, and
the API reference, `llms.txt` and `llms-full.txt` link to it. Below 375 px wide
the header shows the QA Tools logo in place of its name, so all three links
still fit on one row. Nothing changes in the API (#99, D209).

## 0.48.0

2026-10-07

**A response status you configured no longer looks like an error of QA
Tools: its code now sits in a soft pill tinted by its class, and the reason
phrase is ordinary text.** In the Response tab's heading and in every row of
the request list, a 2xx code is on green, 3xx on grey, 4xx on amber and 5xx on
red, so a `500` set on purpose to test a retry reads as the answer it is, and a
list of mixed answers can still be scanned at a glance. Every code is easy to
read on its tint, the list's `200` on a selected or unread row included. Only
an answer the session finished sending gets the pill: `Pending`, `Failed` and
`Not recorded` look as before, and a send that was aborted or whose outcome is
unknown shows its bare code. Nothing changes in the API (#138, D207).

## 0.47.0

2026-10-07

**The Response queue section of the response settings now folds away to one
row and opens as you last left it, and a used-up queue can be removed right
there.** The section's heading row opens and closes it; folded, the row still
shows the queue's state, live: the example chips while no queue is set, `Step 2
of 7` while a queue runs, `Done` once every step has answered. Whether it is
open is remembered in this browser — through closing the settings, switching
Default and Custom, a reload and other sessions — and the first time it is
closed. A darker line above it now sets it apart from the session response.
With a queue, `Remove queue` ends the section's links and asks once, `Remove
all 7 steps?`, with `Keep queue` and `Remove`; once removed, the settings stay
open and the section shows no queue. Nothing changes in the API (#142, D206).

## 0.46.0

2026-10-06

**A session can now answer the next requests with a queue of up to 10
responses, then with its own response again — so a check that a sender retries
after `503` runs by itself, with no switching of the response between its
attempts.** Set the queue from the new Response queue section at the bottom of
the response settings, in a dialog of its own: each step is a whole response —
status, headers, body and delay — checked by the same rules as the session's
response. The section and the response button show, live and in every tab,
which step comes next and how many are left, `Custom · 200 · 6 queued`; `Run
again` starts a used-up queue from step 1. Each request's Response tab names
the step that answered it, `Queue step 2 of 7`.

Through the API, `PUT /api/sessions/{sessionId}/queue` with `{"steps":[…]}`
saves a queue and starts it from step 1, `POST
/api/sessions/{sessionId}/queue/restart` starts it again without resending it,
and `DELETE /api/sessions/{sessionId}/queue` removes it. `POST /api/sessions`
takes a `queue` beside `response`, so a CI run creates a session with its queue
in one call, and clearing a session's requests starts its queue from step 1
too. An answer that describes a session carries its queue as `queue`, and
every request's `response` names the step that answered it as `queueStep`, or
`null`. Both calls take a body of up to 1 MiB, as every call does, which holds
10 steps of ordinary text at every limit. A session's events now reach the page
and the WebSocket in the order their calls took effect, and a clear made while
a request is being stored deletes that request too. A WebSocket connection that
falls more than 4 MiB of events behind is cut, and reconnects as after any
interruption.

The server reads at most eight large bodies of these two calls at a time — a
body over 128 KiB, or one sent chunked. The next one answers `429` with the
new `errorCode` `1017` and `Retry-After: 1` at once, before its body is read,
and nothing is saved or created; a session created with no body, or with a
response or a few steps of ordinary text, never meets it unless its body is
sent chunked.

**Breaking:** creating a session with a body over 128 KiB, which a large
response alone can be, or with a body of any size sent chunked, now gets `429`
with `1017` while eight such bodies are being read; it used to succeed. Read
`Retry-After` and call again. A WebSocket client that falls more than 4 MiB of
events behind is now disconnected, where it used to be kept until it missed a
ping; reconnect, as after any interruption (#106, D205).

## 0.45.2

2026-10-06

**The address QA Tools answers on, `80.87.198.166`, is now published, with a
promise of at least 14 days' notice before it changes.** The API reference at
`https://qa-tools.ru/docs` has a new Network section for teams whose CI may
reach only the addresses on an allow-list: `qa-tools.ru` and
`hook.qa-tools.ru` both answer on that one address, HTTPS on port 443, IPv4
only, with no CDN in front, and QA Tools never sends requests to your
systems, so only outgoing connections to it need allowing. A planned change
of address is announced there and in this changelog, with the new address and
the day of the switch, at least 14 days before it; only emergency recovery
after losing the server is announced later, as soon as the new address is
known (#101, D204).

## 0.45.1

2026-10-06

**The MCP server at `https://qa-tools.ru/mcp` now actually answers: in 0.45.0
that address reached the site's own "page not found" instead, so no MCP client
could connect to it.** The tools, their answers and the limits are as 0.45.0
describes them. Any longer address that starts with `/mcp`, such as `/mcp/` or
`/mcpx`, now gets the server's `404` with `errorCode` `1000` rather than the
site's page (#116, D203).

## 0.45.0

2026-10-06

**AI agents can now use QA Tools as an MCP server: add
`https://qa-tools.ru/mcp` to Claude Code, Cursor or another MCP client once,
and create a session, set its response, wait for a webhook, read it and delete
the session with one tool call each.** An agent without a shell had no way in
until now, and one beside a browser tool can check in the same chat that the
flow it drove sent the webhook it expected.

In Claude Code: `claude mcp add --transport http qa-tools https://qa-tools.ru/mcp`.
The seven tools are `create_session`, `set_response`, `wait_for_request` (up to
30 seconds), `list_requests`, `get_request`, `clear_requests` and
`delete_session`; they follow the API's rules and name its `errorCode` values
when they refuse. Lists carry no bodies, and `get_request` returns at most the
first 64 KiB of a body, saying when the rest was cut off. Whatever a sender
wrote comes back only in a field marked as content from an external party,
after a sentence saying it is data, not instructions. There is no key, as for
the API: the session id is the access key.

Calls to the MCP server count toward the same per-address limits as the API's:
creating a session toward the 60 a minute, everything else toward the 1200.
Nothing in the API changed (#116, D203).

## 0.44.0

2026-10-05

**The webhooks a session captures can now also reach a service on your own
machine or network: download one script from the site and run it with
Node.js.** A provider calls only a public address, while the service you test
often runs on your laptop or behind a VPN.
`node qa-tools-relay.mjs <session-id> http://localhost:3000` sends every request
the session captures from then on to that address — the same method, the path
after the session id, the query string, the headers in their order and letter
case, and the body byte for byte — and prints one line per request with your
service's status. Each request still appears in the inspector as before.

It is a relay, not a tunnel: the sender still receives the session's configured
response, not your service's. Requests captured before the script starts are
skipped unless `--from-start` is given, and none is sent twice, even after the
session's requests are cleared. It needs Node.js 22 or later and nothing else,
and it does not keep the session alive. Download it with
`curl -fO https://qa-tools.ru/qa-tools-relay.mjs` and read it before running
it; its SHA-256 in this version is
`1160f9911041e76b101ce42e3c254c8e56ed6d96d6da072ea641f43f78fe6810`, and the API reference gives the current one with the commands.
Nothing in the API changed (#77, D202).

## 0.43.0

2026-10-05

**The API now has published limits per address: 60 new sessions and 1200
other calls a minute, and every answer says how many are left.** Clients can
plan for them instead of meeting them by surprise, and no single address can
fill the service with sessions or slow it down for everyone else. The
interface is unchanged.

Every answer of an API route, errors included, carries `X-RateLimit-Limit`
(`60` for creating a session, `1200` for any other call),
`X-RateLimit-Remaining` and `X-RateLimit-Reset`, the seconds until the count
starts again. The two limits are counted apart, the minute starts with an
address's first call, and an IPv6 address counts by its `/64`. A call over a
limit answers `429` with the new `errorCode` `1015` and `Retry-After` in
seconds, and does nothing. Webhooks sent to `https://hook.qa-tools.ru` are
never limited, so every one is still captured, and neither is the live
connection of a session page.

The server also writes at most four lists with bodies at a time (`include`
holding `body`, on the list or the query of requests). The next one answers
`429` with the new `errorCode` `1016` and `Retry-After: 1` at once; lists
without bodies are never refused this way, and a call waiting with `wait`
takes its place only once it has requests to write.

**Breaking:** a client that creates more than 60 sessions, or makes more than
1200 other API calls, within a minute from one address now gets `429` with
`1015` for the rest of that minute, and a list with bodies asked for while
four are being written gets `429` with `1016`; both used to succeed. Read
`Retry-After` and call again (#100, D201).

## 0.42.0

2026-10-04

**API clients can now wait for a webhook in one call:
`GET /api/sessions/<session-id>/requests?wait=10` answers as soon as a request
has arrived, or with an empty list after 10 seconds.** Until now a test that
made a system send a webhook had to sleep a fixed time, ask for the list in a
loop, or hold the live connection open. The interface is unchanged.

`wait` takes 1 to 30 seconds. When the list the other parameters describe
already holds a request, the call answers at once, exactly as without `wait`.
With `after=<request-id>` it waits for anything newer than that request;
without `after` it waits for the session's first request, so clearing the
session, triggering the webhook and calling `?wait=10` needs no id and no
clock. It combines with `include`, `limit` and `order`, and a request that
arrives while the call waits is never missed. Clearing the session's requests
ends a wait at once with an empty list, and deleting the session ends it with
`404` and `errorCode` `1001`; a session that expired meanwhile answers `410`
with `1002` when the time runs out. When the server restarts for an update, a
waiting call answers at once with an empty list: call again.

A `wait` of 0, above 30, not a whole number or given twice, and `wait`
together with `since`, answer `400` with `1013`. Waiting does not keep a
session alive. Nothing that worked before changes, and the guide for AI agents
now waits this way (#104, D200).

## 0.41.0

2026-10-04

**The home page now lists the sessions you used in this browser: open one in
a click, copy its webhook URL, take it off the list or delete it.** Until now
the only way back to a session was its URL, so a lost tab or link lost the
session. A session joins the list when you create it on the home page and
when you open its page; the list keeps the 50 you opened last and stays in
this browser only.

The sessions are grouped by the day they were last used, newest first. Each
row shows the full webhook URL with a copy icon, how many requests the session
holds and when the last one arrived; a click on the row opens the session. The
first five show, and `Show all` shows the rest. `⋯` on a row offers `Remove
from list`, which takes it off the list at once, and `Delete session…`, which
asks first and then deletes the session with everything it captured. Expired
and deleted sessions drop off the list by themselves, and showing the list does
not keep any session alive.

A first visit, with an empty list, gets the home page in the same style: the
`Generate URL` tile and the three steps as rows. The warning not to send
sensitive production data is now part of the first step, in place of the
separate `Temporary and anonymous` block.

For API clients: a new call, `POST /api/sessions/status` with
`{"ids":[...]}`, answers for up to 50 sessions whether each is `active`,
`expired` or `not_found`, with an active one's webhook URL, request count, last
request and last use, without moving any session's expiry. Its new error code,
`1014`, refuses ids that are missing, malformed, repeated or more than 50.
Nothing that worked before changes (#92, D199).

## 0.40.0

2026-10-04

**A session can now be deleted through the API when you are done with it:
`DELETE /api/sessions/<session-id>` removes it at once, with every request it
captured and its response settings.** It answers `204` with no body. Until now
a session stayed until 7 days after its last use, its webhook URL still
answering, which left a trail of sessions behind every CI run that used one.

After the deletion the session's webhook URL answers `404` with `errorCode`
`1001`, exactly as for an address that never existed, and so does every API
call about the session, a second `DELETE` included. A page open on the session
moves to `Session not found` at once, without a reload, and its text now reads
`It was most likely deleted, on purpose or after 7 days without use, together
with its requests and response settings.` A sender still waiting out a
configured delay gets its response all the same. An expired session is not
deleted: it answers `410` with `1002`, and the cleanup removes it within about
10 minutes, as before. There is no delete button in the interface yet.

For API clients: the call is new, and nothing that worked before changes. An
open WebSocket connection to a deleted session is closed with code `4404`, the
code a connection to an unknown session is already refused with; a connection
is still not closed when its session expires. Like the other deletions, the
call takes no request body. The quickstart on the API reference ends with it,
and the guide for AI agents now cleans up by deleting the session (#102, D198).

## 0.39.0

2026-10-04

**You can now check a webhook's signature right in the request: choose
`Check signature…` in a request's actions, type the secret, and see whether
the signature header matches the body exactly as it arrived.** The check
computes the HMAC of the body with SHA-256, SHA-1 or SHA-512 in your browser,
and compares it with the header's value, in hex (either case) or in Base64,
with or without a prefix such as `sha256=`. The header whose name contains
`signature` or `hmac` is chosen for you, and the algorithm is picked from the
header's value, so GitHub's `X-Hub-Signature` and `X-Hub-Signature-256` both
match with nothing to change. A body that is not text, a body that starts with
a byte-order mark, and an empty body are signed byte for byte, as they arrived.

The result names the algorithm, the header and how many bytes were signed. On
no match it shows the value it computed, written the way the header writes
its own, with a copy icon. Stripe, Slack and Standard Webhooks sign a timestamp
or an id together with the body, so a check of the body alone does not match
their signatures; the result says so.

The secret is masked until you show it, is never sent anywhere and is never
stored: it stays in the page while it is open, so the check opened on another
request uses it at once, and a reload forgets it. On the desktop and tablets
the check opens under `Actions`; on a phone it opens in the actions sheet.
(#74, D197)

## 0.38.0

2026-10-04

**API clients can read many requests in one call, with their headers and
bodies, only the ones that arrived after a given request, and only the ones
that carry a header value or a text in their body.** The interface is
unchanged.

`GET /api/sessions/<session-id>/requests` takes five query parameters. Without
any, it answers exactly as before. `include=headers,body` adds each request's
headers and body, as reading one request gives them; with bodies, at most 20
requests are returned. `limit` caps the list, from 1 to 1000. `order=asc` lists
the oldest first. `after=<request-id>` keeps only the requests that arrived
after that one, so `order=asc&after=<the last id>&limit=100`, repeated until the
answer is empty, reads a whole session once, with no request skipped or
repeated. `since=<date-time>` keeps the requests received later than a moment,
such as `2026-10-04T09:00:00Z`.

`POST /api/sessions/<session-id>/requests/query` answers the same list,
filtered: `{"headers": [{"name": "X-Merchant-ID", "value": "123"}], "body":
["\"orderId\":42"]}` finds the requests whose `X-Merchant-ID` header, in any
letter case, is exactly `123` and whose body holds those exact bytes. It takes
the same five options in the same body. The filters are sent in the body, never
in the address, so they are not written to the server's log. A query may run
for 2 seconds, and queries share the two places searches have. One error code
is new: `1013` for a parameter, a field or a filter that breaks a rule; its
message names it. An `after` that names no request of the session answers `404`
with `1003` (#103, D196).

**Breaking:** the request list refuses a query parameter it does not know, and
one given twice, with `400` and `errorCode` `1013`. It ignored them before, so a
client that adds its own, such as a cache-busting `?_=<time>`, must drop it. A
JSON body holding bytes that are not UTF-8, sent to create a session, change its
response or search its requests, now answers `400` with `1006` instead of `500`.

## 0.37.0

2026-10-03

**The request list's filter now finds text inside the requests too: type an
order number, and the list shows every request that holds it in its body, its
headers, its path or its query string.** It is the same field as before, with
the placeholder `Search the list, headers and bodies`. A request is shown when
every word you typed is in what its row shows — method, status, address, time,
id, path — or anywhere in its raw request, so `POST 48213` finds a POST whose
body holds 48213. Rows found this way simply appear; nothing in them is
highlighted.

Inside a request a word is matched exactly as typed, including letter case:
`x-signature` does not find `X-Signature` there, while the row's own fields
still ignore case. Words of three bytes or more are searched inside requests,
up to 8 words of up to 200 bytes each; a shorter word filters by the row's
fields only. A body that is not text is searched byte for byte.

The search starts by itself shortly after you stop typing, and runs again when
new requests arrive, so a matching one appears within about a second. The words
are sent in the body of the search request, never in its address, so they are
not written to the server's log. If the requests could not be searched — the
search took over 2 seconds, the server was busy, or it failed — a notice at the
top of the list says so and offers Retry, and the filter keeps working on the
rows' own fields.

For API clients there is one new call, `POST
/api/sessions/<session-id>/requests/search` with `{"words": ["48213"]}`, which
answers `{"matches": [["<request-id>"]]}`: for each word, the ids of the
requests whose raw request contains it. A search may run for 2 seconds and the
server runs two at a time. Three error codes are new: `1010` for invalid
words, `1011` for a search that timed out and `1012` when two are already
running. Nothing else changed (#78, D191).

## 0.36.2

2026-10-02

**No change for users; each nightly backup now also has an encrypted copy kept
off the server.** The copy is stored with a second provider in Russia, Yandex
Object Storage, and is encrypted before it leaves the server, to a key only the
owner holds, so neither that provider nor the server itself can read it. The 3
newest copies are kept, as on the server, so data you deleted, or that expired,
still stays in backups for up to 3 days. The owner is alerted when a night's
copy fails (#89, D190).

## 0.36.1

2026-10-02

**No change for users; the backend and frontend test suites keep their own
time limit.** A test that hangs in either suite now fails after two minutes,
on a developer's machine and in the checks before each release alike, instead
of holding the run open (#82, D132).

## 0.36.0

2026-10-01

**Webhooks are received on a host of their own, `hook.qa-tools.ru`, and a
captured request shows its headers, path and protocol version as the sender
wrote them.** A session's webhook URL is now
`https://hook.qa-tools.ru/s/<session-id>`: the session page shows and copies
it, and `Copy as cURL` sends to it. On that host nothing stands between the
sender and the server but TLS, so each header keeps its name in the sender's
case, its place in the sender's order and its duplicates, and nothing is
added: no `Accept-Encoding: gzip` the sender did not send. The path is stored
exactly as sent, dot segments, doubled slashes and the case of a
percent-escape included, a malformed escape such as `%zz` is captured instead
of refused, and a sender's own `X-Forwarded-For` and `X-Real-Ip` are kept as
headers. The host speaks HTTP/1.1, so an HTTP/2 sender falls back to it and
the stored version, `1.1`, is the one it used. The address of a request is the
one its connection came from. Requests captured before are unchanged. The site,
the API, the realtime connection and `/docs` stay on `https://qa-tools.ru`
(#90, D187).

**Breaking:** `https://qa-tools.ru/s/<session-id>`, with any method and any
path under it, no longer receives webhooks: it stores nothing and answers
`410` with a new `errorCode`, `1009` (`RECEIVE_URL_MOVED`), whose `message`
names the session's new URL. A path with a malformed percent-escape such as
`%zz` is still refused there by the proxy with `400`, as before. Point senders at
`https://hook.qa-tools.ru/s/<session-id>`. `POST /api/sessions` and
`GET /api/sessions/{sessionId}` answer a new field, `receiveUrl`, the
session's webhook URL. A sender that ends its side of the connection before
its answer arrives, by closing it or by ending TLS, gets no answer from the new
host; its request is still stored.

## 0.35.0

2026-10-01

**An open request can be compared with any other request of its session.**
`Compare with…`, the last item of the request's `Actions` menu and of the
phone's `Request actions` sheet, turns the request list into a picker: choose
a row, and the panel shows what differs between the two in `Raw`, `Body`,
`Headers` and `Query`, with a dot on each view that differs. The open request
is always `−` and the chosen one `+`, whichever is newer. Removed lines are
red, added lines green, and inside a changed line the changed characters are
underlined; unchanged lines beyond three lines of context fold into
`N unchanged lines · Show`. What is compared is what each view shows: JSON
re-indented, XML indented, form fields and query parameters decoded, headers
one per line in their order. Binary and multipart bodies, bodies above 256 KB
and a raw request that is not UTF-8 are compared only as a whole, with both
sizes, and two very different bodies say `Too many changes to show line by
line.` instead of slowing the page down. `Cancel`, Escape or, on a phone, Back
leave the picker; `Change` picks again and `Close` returns to the open request.
Only the chosen request's details are loaded; nothing else is sent to the
server. (#75, D186)

## 0.34.0

2026-10-01

**An open request can be downloaded as a JSON file.** `Download JSON`, the
first item after the divider in the request's `Actions` menu and in the
phone's `Request actions` sheet, saves one `.json` file whose name ends in the
short id the request's list row shows. The file is the request
exactly as the API's request detail returns it, with two-space indentation:
the method, path, query, headers, body and raw request, the sender's address,
and the recorded response with its timings. A body that is not UTF-8 is
included as Base64, so nothing is lost, and a delayed response recorded while
the request is open is in the next download. The file is made in the browser
from what the page already shows; nothing is sent to the server, and the
browser's own download indicator is the only confirmation. The file contains
the session address, which grants access to the session, as a copied link
does. (#73, D185)

## 0.33.0

2026-09-30

**What changed in each version is published at
`https://qa-tools.ru/changelog`, and every page's header links to it.** Every
version since 0.5.0 is listed there newest first, grouped by the UTC day it
reached production, each as one line that opens to its whole entry; the newest
is open. `Breaking only` leaves the versions with a change that can break an
API client, and `Expand all` opens every line. Scripts and agents read the same
text at `/changelog.md`, which `/llms.txt` links. The header shows `Changelog`,
a divider and `API docs ↗` on the right at every width, a phone included, and
no longer shows the tool name `Webhook Inspector`. The stability policy on
`/docs` and in `/openapi.json` now points to the changelog: during 0.x there
is no fixed notice period, and a breaking change is marked in its entry (#97,
D184).

## 0.32.0

2026-09-30

**Search engines can find and describe the site, and a shared link shows a
preview.** `/robots.txt` keeps crawlers off `/s/`, `/api/` and `/ws/` and
names `/sitemap.xml`, which lists the home page and `/docs`. The home page
carries a description, Open Graph tags with the logo as the preview image and
a canonical link, and, for a reader without JavaScript, the landing page's
copy as plain HTML; `/docs` has a description too. The logo on a white square
is the icon beside a search result and at `/favicon.ico`. A session page,
`/v/<id>`, answers `X-Robots-Tag: noindex`, so it is never indexed. No
analytics. With JavaScript the pages look as before (#69, D183).

**Breaking:** only addresses outside the API change. A bare `/s`, `/api` or
`/ws`, and an address such as `/sxyz`, used to reach the API and answer `404`
with `errorCode` `1000`; they now answer the site's `Page not found` page,
still `404` but HTML with no `errorCode`. `/sitemap.xml`, which answered the
same way, is now the sitemap. Every address under `/s/`, `/api/` and `/ws/`
answers as before.

## 0.31.0

2026-09-30

**A link to one captured request, and one menu for every action on a
request.** `Actions ▾` at the end of the `Request` · `Response` row — on a
phone, `⋯` in the Back bar, which opens a sheet — holds `Copy link` and
`Copy as cURL`, on both halves; the view strip keeps `Raw`, `Body`, `Headers`
and `Query` only. `Copy link` copies `<origin>/v/<session-id>#<request-id>`:
whoever opens it gets the session with that request open and read, and the
`#…` leaves the address at once, so selecting and reloading work as before.
A link to a request that has since been deleted, or pushed out of the newest
1000, shows the list and says `The linked request is no longer in this
session.` Copies are confirmed by the toast at the bottom of the window,
`Link copied` or `cURL command copied`, only once the browser has accepted
the write; a refused copy is said with an info icon. The link grants what the
session's own address grants and nothing more (#71, D182).

## 0.30.1

2026-09-30

**No change for users; the site is now checked every 5 minutes, and the owner
is alerted when it is down.** The owner is also alerted when the disk holding
the database fills up or a nightly backup fails; the checks create no session
(#68, #93, D181).

## 0.30.0

2026-09-29

**The request list can be filtered.** A search icon beside Delete all turns
the list header into a field, and typing narrows the list at once, in the
browser: by method, recorded status, sender address, time, request id or the
path the request was sent to — `stripe` finds the requests sent to
`/s/<id>/stripe/events`, `POST 500` the POSTs answered 500. Every word must
match some field, case does not matter, and matches are highlighted in the
row. The field counts `3 of 8 / 1000`; `×` clears it. A request arriving
while the filter is on appears only if it matches, the tab title still counts
every unread request, and Delete all still deletes every request, its dialog
naming those the filter hides. The filter is kept per session in this browser
and restored on reload. The list API and `request.received` now carry each
request's `path`, `null` for requests stored before paths were recorded
(#70, D180).

## 0.29.0

2026-09-29

**A custom response can answer any body under any `Content-Type`.** The body
is no longer checked as JSON: `{"a":`, `{'a':1}`, a plain `OK`, a SOAP
envelope or an HTML error page is saved and sent exactly as typed, up to
64 KiB, and `Content-Type` is an ordinary header row, sent as configured, also
on a `HEAD` or a response without a body. With none configured a body is still
sent as `application/json; charset=utf-8`. In the editor the body field is
`Body · Optional` with the hint `Returned exactly as entered`, and says
nothing about JSON. Through the API an empty `body` now means no body, like
`null`, and the six characters of a `\u0000` escape are accepted; a raw
U+0000 is still refused. Every answer on `/s/…` now carries
`Content-Security-Policy: sandbox; default-src 'none'`, so a browser that
opens a receive URL runs no script from it and loads nothing for it; senders
ignore it, and it cannot be configured (#91, D179).

**Breaking:** a session create or response change whose `body` is not valid
JSON, or holds a `\u0000` escape, used to be refused with `400` / `1005` and
is now accepted; so is a `Content-Type` among `headers`, which used to be a
reserved name. `body: ""` used to be refused and now means no body: reading
the session back returns `body: null`. Every answer on `/s/…` carries a new
header, `Content-Security-Policy: sandbox; default-src 'none'`.

## 0.28.1

2026-09-29

**No change for users; daily usage counts now outlive the sessions they
count.** One row per UTC day records how many sessions were created and
requests captured, with each day's most frequent `User-Agent` values, media
types, methods and sender networks; it holds counts, never a session id, a
full address, a body, a path or a query string, and is kept indefinitely
(#49, D178).

## 0.28.0

2026-09-29

**The request list and the detail panel are taller.** On the session page the
header, the endpoint card, the panes and the footer band are now 12 px apart
at every width, and on the desktop so are the list and the detail panel; the
endpoint card is 12 px shorter (8 on a phone), with 12 px above and below its
contents and 8 px between its rows. At 1440 × 900 the panes gain 36 px, 681 px
where they were 645, which is 14 px more than before the footer band arrived;
a tablet gains 32 px and a phone 16. Side margins, the header, the footer band
and everything inside the panes are unchanged (#96, D177).

## 0.27.0

2026-09-29

**Every page says what it stores, for how long, and where to write.** A footer
band closes the landing page, the session page, `Session not found`, `Page not
found` and `Something went wrong`: `Captured requests — headers, body and the
sender's IP — are kept until you delete them or the session goes unused for 7
days; nightly backups keep them up to 3 days longer. Contact:
contact@qa-tools.ru`, the address a `mailto:` link. On the desktop the contact
sits on the right of the same line, and the session page's panes end 16 px
above the band instead of 28; on a tablet and a phone the contact ends the
paragraph, and the band follows the page's content. A request opened on a
tablet or a phone has no band. The same address is published in
`https://qa-tools.ru/.well-known/security.txt` (RFC 9116, its `Expires` under
a year after each deployment) and in `info.contact` of `/openapi.json`, which
`/docs` shows (#88, D177).

## 0.26.5

2026-09-28

**No change for users; the database is backed up every night.** The 3 newest
backups are kept on the same server and each is checked by restoring it, so
data you deleted, or that expired, stays in them for up to 3 days (#67, D176).

## 0.26.4

2026-09-27

**No change for users; the test suite is stricter.** A frontend test that
leaves something running now fails instead of keeping the test run alive
(#63, D132).

## 0.26.3

2026-09-26

**A typed status or delay sits with its chips, and secondary controls are
outlined more lightly.** In the quick switch, the `Other` status and the `ms`
delay now centre what is typed in them, and their placeholders, as the chips
beside them centre their labels. While one holds a valid value it is outlined
in the same line as the secondary buttons rather than the darkest one in the
popover; untouched it keeps the chips' line, and invalid, or typed into and
then cleared, it stays red. That shared line is a lighter grey than before,
on the response button and on every white secondary button: Cancel,
`+ Add header`, `Remove` and `Retry` (#61, D150, D158).

## 0.26.2

2026-09-26

**A JSON or XML body built to format into millions of characters no longer
freezes the Body tab.** A body under 256 KiB could still re-indent into tens of
millions of characters, and opening its `Body` froze the page for 20 s and
more. JSON and XML whose formatted text would pass 2,000,000 characters are
now shown as stored under `Formatting unavailable: JSON that formats to more
than 2,000,000 characters is shown as stored.`, or the same line for XML, and
such text is never built. Ordinary bodies keep their formatting, and `Raw` is
unchanged (#64, D169, D163).

## 0.26.1

2026-09-26

**A client that gives up on its request body is no longer logged as a server
error.** When the connection ends before the body has arrived — the sender
disconnected, the proxy cut a stalled upload at 60 s, or the body's chunked
framing was broken — the server logs one informational line instead of an
error with a stack, and writes nothing more to the connection. A real failure
on a request that arrived in full is still logged as an error and answered
`500`. Nothing a client receives changes (#62, D174).

## 0.26.0

2026-09-26

**Requests sent to any path under the endpoint are captured.** A sender
configured with `https://qa-tools.ru/s/<id>/stripe/events`, or a WebDAV client
addressing `/s/<id>/folder/`, now delivers instead of getting `404`: every path
under `/s/<id>/` is captured and answered exactly as `/s/<id>` is, with every
accepted method, the session's response, delay and limits. The path is stored
as it arrived, percent-encoding intact, and the header of the request details
shows it after `/s/<id>`, with the query string after it; the request list is
unchanged. On the desktop that header now wraps instead of cutting the target
to one line. Measured on production, the proxy keeps encoded characters such
as `%2F` and `%25` as sent, but resolves dot segments, collapses doubled
slashes, decodes `%7E` to `~` and writes hex digits in upper case before the
path reaches the application, so that is the path stored; it refuses a
malformed escape such as `%zz` with `400` (#42, D173).

**Breaking:** a request to a path under `/s/<id>/` used to answer `404` /
`1000 ROUTE_NOT_FOUND`. It is now captured and answered with the session's
response, and with an unknown session id it answers `404` /
`1001 SESSION_NOT_FOUND`. A method added in 0.9.0, such as `PROPFIND`, sent
to such a path with a body used to be refused with `415` / `1007` or `400` /
`1006`, and is now captured too. A path under `/s/<id>/` that cannot be
decoded, such as the escape of a byte that is not UTF-8, used to answer `400`
and is now captured; an id segment of that kind, such as `/s/l1%E9`, used to
answer `400` and now answers `404` / `1001`.

## 0.25.4

2026-09-26

**A request whose body stops arriving no longer holds its connection
forever.** The proxy in front of the server already gave up on such a client
after 60 s; that bound is now pinned in the site's configuration, so an
upgrade cannot change it unnoticed. The server itself now answers `408` to a
request still not fully arrived 90 s after it began, as a backstop behind the
proxy. A configured response delay, idle connections and the live WebSocket
are not affected (#45, D172).

## 0.25.3

2026-09-26

**No change for users; the owner can read anonymous usage figures.** A
read-only view of session and request metadata answers usage questions; it
shows a short hash in place of the session id and the sender's network rather
than its address, and never a body, path, query string or other header (D170).

## 0.25.2

2026-09-26

**A deeply nested JSON body no longer takes the page down.** A small body
such as 20 000 nested arrays, 40 KB, broke the inspector as soon as it was
selected. JSON nested more than 100 levels deep is now shown as stored under
`Formatting unavailable: JSON nested more than 100 levels deep is shown as
stored.`, as XML already was. And if a request ever cannot be drawn, the
detail panel says `Could not load request details` with `Retry`, while the
list and the rest of the page keep working (#59, D169).

## 0.25.1

2026-09-26

**The server log no longer carries a near miss of a session id.** A request
whose address held almost an id — one character short, a stray `.`, a
percent-encoded character — was logged in full, and for a real session that
is all but the whole access key. Whatever follows `/s/`, `/v/`,
`/api/sessions/` or `/ws/` is now logged as its first 8 characters and `...`,
whatever its length; a valid id anywhere else in a log line is still
shortened as before (#58, D168).

## 0.25.0

2026-09-26

**Copy a captured request as a cURL command.** The Request half's `Raw` ·
`Body` · `Headers` · `Query` strip ends in `Copy as cURL` (`cURL` on a phone,
the icon alone below 360 px). It copies a command that re-sends the request:
its method, path and query, headers in their order and case, and its body byte
for byte, into the same session on the same path, or anywhere else after the
host is changed. The headers curl computes, the proxy's and the connection's
are left out, and curl's own defaults are switched off. For sh, bash and zsh;
the Response half has no such action (D167).

## 0.24.3

2026-09-26

**On a phone a request row keeps its full time and its delete control apart.**
Below 768 px a row is 76 px high: the method, the short id and the full time
on the first line, and the status, address and size on the second, with the
`×` at the end of that second line under the time. Its 44 × 44 px target no
longer reaches the time, and a tap anywhere else on the row opens the request.
Tablets and the desktop are unchanged (#55, D157).

## 0.24.2

2026-09-26

**A `QUERY` without a `Content-Type` or a body is captured.** Such a request
to the webhook URL was refused with `500` / `1500` and lost. It is now
captured exactly as the same request sent with `POST`, with the session's
configured response. Anywhere else such a `QUERY` is answered `400` with the
new error code `1008 MISSING_REQUEST_CONTENT` instead of `500` (D166).

**Breaking:** the same `QUERY` request gets a different status: on the webhook
URL the session's response instead of `500` / `1500`, and anywhere else `400`
/ `1008` instead of `500` / `1500`.

## 0.24.1

2026-09-25

**A reconnection no longer brings back deleted requests.** A viewer whose
connection dropped while another viewer deleted a request, or used `Delete
all`, kept those rows on screen after reconnecting. The list loaded on
reconnection now replaces the one on screen, keeping only requests that
arrived during that load, so deleted rows disappear, and a request open in the
detail panel that was deleted closes it as a live deletion does (D136, D137).

## 0.24.0

2026-09-25

**Documentation for AI agents.** `https://qa-tools.ru/llms.txt` is a short
index in the llms.txt format, and `https://qa-tools.ru/llms-full.txt` the
whole guide in one Markdown file: a curl recipe that creates a session, sends
it a webhook, waits for it by polling, reads it and cleans up; how to wait
without WebSocket; the response-configuration mistakes agents make; and the
API introduction and endpoint list, generated from `openapi.json` at every
release so they cannot drift. The site's page points to both for a reader
without JavaScript, and nothing visible changes (D165).

## 0.23.0

2026-09-25

**Multipart bodies are shown as their parts.** A body sent as `multipart/*`
— a form with fields, or a file upload such as `curl -F file=@photo.png` —
now opens in `Body` as one box per part, in the order they arrived: its name,
what it is and its exact size (`text · 16 B`, `photo.png · image/png ·
463 B`), its own headers, and its content exactly as it arrived with a copy
button of its own. A file that is not text is described rather than shown;
its bytes stay in `Raw`, which does not change. A multipart body that cannot
be split is shown as before, with a line saying why (D164).

## 0.22.0

2026-09-25

**XML bodies are indented.** A request or response body that is well-formed
XML now opens in `Body` with each element on its own line, two spaces deeper
per level, wherever an element holds other elements and no text. An element
with text in it, and anything marked `xml:space="preserve"`, is shown exactly
as it arrived, and nothing inside a tag, a CDATA section, a comment or a
reference is rewritten. XML is recognised from the body itself, whatever its
`Content-Type` says. XML with a DOCTYPE, or nested more than 100 levels deep,
is shown as stored with a line saying so. Any other body that is not indented
says why: it is not valid JSON, it is not well-formed XML, or — for plain text
such as `hello` — no JSON or XML structure was recognised (D163).

## 0.21.0

2026-09-25

**Form bodies are shown as fields.** A body sent as
`application/x-www-form-urlencoded` now appears in `Body` as decoded
name/value rows, as `Query` shows a query string, and copies as one
`name=value` per line; `Raw` keeps it encoded. A valid JSON body is still
re-indented whatever its `Content-Type` says. `Query` no longer shows `�` for
escaped text that is not UTF-8, such as `name=%C8%E2%E0%ED` from a
windows-1251 sender, and neither tab draws it now: both show the text as it
arrived, with a line saying it was not decoded (D162).

## 0.20.3

2026-09-25

**Session ids are letters and digits only.** A new session's id is still 43
characters long and just as hard to guess, but it no longer contains `_` or
`-`, so a double-click selects the whole id and a webhook URL survives being
copied, read out or typed. Sessions created before keep their ids and work at
the same URLs as before (D161).

## 0.20.2

2026-09-25

**No change for users; the server runs under the name `qa-tools`.** The site
moved to it with every session and captured request kept, and its address,
`https://qa-tools.ru`, is unchanged (D160).

## 0.20.1

2026-09-25

**No change for users; the project's internal names change from `qa-tool` to
`qa-tools`.** Only names used in development changed (D159).

## 0.20.0

2026-09-25

**A link to the API reference, one button on the landing page, and six small
fixes.** Every page's header now has `API docs ↗`, which opens
`https://qa-tools.ru/docs` in a new tab; on a phone the header shows only
`QA Tools` and the link. The landing page keeps one action, `Generate URL`:
a session's response is set on its page, from the endpoint card, as it has been
since 0.15.0, so the `Custom response` button and its form are gone (the API
still creates a session with a response in one call). On the session page the
retention line reads `SESSION EXPIRES 7 DAYS AFTER LAST USE` (under
`RECEIVE URL` on a phone); `Newest requests appear at the top.` sits close
under the list; `Raw` of a request or response without a body ends at its last
header line, while Copy still yields it with its closing blank line; the active
tab's underline runs a little past its label; a normally sent response no
longer repeats `Server finished writing the response. Client delivery is not
confirmed.`; and the response button and other white buttons have a darker
outline, so the response button no longer looks smaller than Copy (D158).

## 0.19.0

2026-09-25

**Tablets and phones.** Every page now fits a tablet or a phone down to 320 px
wide, with nothing cut off and no sideways scrolling; the desktop at 1024 px
and wider is unchanged. On a session below 1024 px the request list is the home
screen: tap a request to open it full-screen, with `‹ Requests`, its place in
the list (`2 of 4`) and a count of what arrived meanwhile (`1 new`). The Back
gesture of the browser or the phone returns to the list instead of leaving the
session, and the address never changes. On a phone the receive URL is shortened
in the middle and Copy still copies all of it, headers show each name above its
value, Custom response and the response settings open as full-screen sheets and
the quick switch as a bottom sheet. Rows, the `×` and buttons are sized for a
finger, and nothing needs hover (D157).

## 0.18.0

2026-09-25

**Opening a request marks it read in your other tabs.** When the same session
is open in several tabs of one browser, opening a request in one of them removes
its unread shading and lowers the `(N)` in the title of every other tab, with no
reload and without touching what those tabs have selected. A request opened
before it reached another tab arrives there already read, and a reload or a new
tab shows what was already opened as read. Read state stays yours: it is kept
in the browser's storage, never on the server, so another browser, a private
window or a colleague with the link keeps their own. It is forgotten 7 days
after you last use the session; where the browser's storage is unavailable,
each tab keeps its own read state as before (D156).

## 0.17.0

2026-09-25

**The API has a reference page: `https://qa-tools.ru/docs`.** It renders
`openapi.json` with Scalar and opens with a quickstart in `curl` — create a
session, send it a webhook, list what it captured, read one request, then the
same with a response of your own and a change of it — followed by the concepts
(the session id is the access key, 7 days after last use, the newest 1000
requests, 1 MiB), the custom-response rules, the WebSocket events, every error
code with what to do about it, the security note and the stability policy.
Each operation has code samples in curl, JavaScript `fetch` and Python
`requests`, and `Test Request` calls the API from the page itself, creating
real sessions. The page is light only, loads nothing from any other site, and
has none of Scalar's hosted features; it is a page of its own, so the
application does not grow by it. `/docs` and `/openapi.json` are served
`no-cache`, so the page changes with each release (D155).

## 0.16.0

2026-09-25

**The API is published.** `https://qa-tools.ru/openapi.json` describes it in
OpenAPI 3.1 — creating a session (default or custom), reading it, changing its
response, listing, reading, deleting and clearing its requests, and the webhook
receiver with its answers and `X-QA-Tools-Request-Id` — with every error code,
the limits and an example answer for each operation. Import it into Postman,
Insomnia or Bruno, or generate a client from it. There is no authentication:
the session id is the access key, so do not send production secrets. From this
version on, error codes never change meaning, fields and endpoints may be added
(ignore the ones you do not know), and a breaking change comes with a version
bump and is marked in its entry here (D154).

## 0.15.0

2026-09-24

**A running session's response can be changed.** The response button in the
endpoint card — now `Custom · 201 · 500 ms ▾` — opens a quick switch: Default or
Custom, a status chip or any status from 200 to 599, a delay chip or any delay
up to 30 s, and Apply. Its link `Edit headers and body…` opens Session response
settings as a form with the create form's fields and rules. No new session and
no new URL: requests captured after the change get the new response, a request
waiting out its delay keeps the answer it already had, and every request still
shows what it was answered. Picking Default keeps the custom response, and
switching back restores it. Other open tabs follow the change without a reload.
Whoever has the session's URL can change its response, as they can already
delete its requests. A change counts as using the session. Every existing
session keeps the response it had (D150–D153).

## 0.14.0

2026-09-24

**A code box in the detail panel is as tall as its content, and the panel has
one scroll.** Every `Raw`, `Body`, `Headers` and `Query` box used to stop at
430 px with a scrollbar of its own inside a tab area that scrolled too: a tall
window showed a band of empty panel under a long body, and a laptop's window
put the box's bottom, and its sideways scrollbar, behind the outer scroll. Now
the box has no height limit and no scroll: the area under the tab strip scrolls
down, and nothing in the panel scrolls sideways. Every block wraps, re-indented
JSON included, whose continuations hang two characters deeper than their own
line so the nesting stays readable; `Headers` and `Query` wrap a long value in
its column and keep each name on its row. Captions sit above the box, the two
"scroll horizontally" captions are gone, and the request `Headers` caption reads
`Headers as received by the server.` The copy icon keeps its corner and stays in
view while a long box is scrolled past; what it copies is unchanged. A tab
already open switches when it reloads (D149).

## 0.13.0

2026-09-24

**The detail panel writes times the way the design draws them.** The Request
half's facts line and the Response half's `Sent by server` line now read
`17 Sep 2026, 14:32:06` instead of `2026-09-17 14:32:06`, still in the viewer's
own timezone. The day has no leading zero (`5 Sep 2026`), and midnight reads
`00:`. List rows keep `2026-09-17 14:32:06`: a row is a compact column to scan,
the panel is read. A tab already open switches when it reloads (D148).

## 0.12.0

2026-09-24

**An address that does not exist says so.** Opening an unknown URL used to land
silently on the home page with `200`, as if it were fine. Now every address the
application does not serve — `/anything`, `/v/`, `/v/<not a session id>`,
`/v/<id>/extra` — shows `Page not found` and answers a real `404`, and the page
makes no API call and opens no connection for it. A well-formed session address
still answers `200`, and when the session is gone it shows a redesigned
`Session not found`, which now says the session was most likely deleted after 7
days without use. Both screens show the address that was opened as a small
request and answer, and both lead back to the home page with `Go to home page`
rather than generating a new URL, since the lost session may have had a custom
response. `Something went wrong` is unchanged. An open tab is unaffected until
it reloads (D146, D147).

## 0.11.1

2026-09-24

**`Raw` shows the request line and headers of a request with a binary body.** A
request whose body is not valid UTF-8 (an image, gzip, protobuf, random bytes)
opened on a `Raw` view that was one Base64 string of the whole request, under
`Raw request shown as Base64 because it contains non-UTF-8 bytes.`: no method,
no path and no headers, although `Headers` showed them all. `Raw` now shows the
request line and the headers as text, the blank line, and only the body as
Base64, the same string `Body` shows, under `Body shown as Base64 because it
contains non-UTF-8 bytes.` A header carrying a byte that is not UTF-8 is shown
one character per byte, as `Headers` shows it, under `Headers shown as Latin-1
because they contain non-UTF-8 bytes.` The `Response` half applies the same
rule. Copying `Raw` yields exactly what is shown. The API and the stored bytes
are unchanged (D145).

## 0.11.0

2026-09-24

**Captured headers no longer carry the proxy's own `X-Forwarded-*` rows.**
Every request used to arrive with six headers the sender never sent:
`X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Port`,
`X-Forwarded-Proto`, `X-Forwarded-Server` and `X-Real-Ip`. They buried the few
headers a webhook actually has. They are now left out at capture, from
`Headers`, `Raw` and the API alike, together with the other five names the
proxy manages. The sender's address is still read from `X-Forwarded-For` and
still shown in the request facts line. The remaining headers keep their order
and duplicates, and the body is untouched. A `Forwarded` header is the
sender's and is kept. A sender's own values under those names were already
replaced by the proxy and never reached the inspector. `Accept-Encoding: gzip`
on a request that sent none is added by the proxy as well; it stays, because it
cannot be told apart from a sender's own. Requests captured before this version
keep the rows (D144).

## 0.10.2

2026-09-24

**A refused session create reaches the client that sent it.** `POST
/api/sessions` refuses a request that is not declared `application/json`
before reading its body. When the client had asked for the connection to
close, or spoke HTTP/1.0 without keep-alive, the server closed it while the
body was still arriving, and the TCP reset that followed could discard the
`415` before the client read it, leaving it with no response at all. The
server now reads and discards a body of up to 4 MiB first in that case, then
answers. A kept-alive connection never had the problem. A chunked body or one
over 4 MiB, sent by a client that declines keep-alive, is still answered at
once, and the API documentation states that limit (D143).

## 0.10.1

2026-09-24

**No change for users; the API documentation now describes the answers of the
HTTP parser.** A request the parser itself refuses — broken framing, oversized
or unfinished headers — is answered `400`, `431` or `408` without an
`errorCode`, and the documentation now says so and what a client should expect
(#11, D142).

## 0.10.0

2026-09-24

**The sender's country is gone, and the address moved into the request
facts.** Every request's detail panel read `<address> · Unknown country` on a
line of its own — a permanent "unknown" that said nothing, since no country
was ever resolved. That line is removed. The address is now one segment of the
Request half's facts line, between the size and the time: `HTTP/1.1 · 61 B ·
145.40.74.12 · 2026-09-17 14:32:06`. It is written in full, an IPv6 address
included, and reads `IP unavailable` in the same position where there is no
address. `sourceCountry` has left the request detail response; it was never on
the list row or in `request.received` (D140, D141).

## 0.9.0

2026-09-24

**The receiver accepts every HTTP method Node can parse.** A sender using
WebDAV, CalDAV, UPnP or a vendor method — `PROPFIND`, `MKCALENDAR`,
`M-SEARCH`, `PURGE`, `UNSUBSCRIBE` and the rest of the 34 method names Node
knows other than `CONNECT` — used to be answered `404` and shown nothing; its
request is
now captured and answered like any other, body included, with the configured
response, delay and limits unchanged. Node refuses any other method name with
`400` before the application sees it. Two kinds of `QUERY` are still refused
with `500`: one without a `Content-Type` header, and one with a `Content-Type`
but no body. In the detail panel a method name now always stays on one line
(D139).

## 0.8.1

2026-09-24

**A webhook whose `Content-Type` is not a media type is now captured instead of
refused.** An empty `Content-Type:`, `json`, `application/` or `a/b/c` used to
be answered `415` / `1007` by the receiver before its body was read, and the
request never appeared in the session: the sender got an error and the person
inspecting it saw nothing. It is now stored and answered like any other
request, with the session's normal response and its request id, and the broken
header shows in the captured headers and the raw request exactly as it was
sent. The rest of the API still answers `415` / `1007` to the same header, and
an oversized webhook body still answers `413` / `1004` whatever it declares
(D138).

## 0.8.0

2026-09-24

**Deleting a request, and `Delete all`, now reach every open viewer of the
session.** A session is opened by link, so it is routinely watched from a
second tab, a second window or by a second person, and until now only the tab
that deleted saw it: each of the others kept the deleted rows until it
reloaded.
Now the row disappears, or the list empties, everywhere at once with no
reload, and a viewer that had the deleted request open returns to `No request
selected`. Two new events on the session's WebSocket carry it,
`request.deleted` with the request's id and `requests.cleared`; they are sent
only to a client that asks for them, so an older client receives exactly what
it did before (D135, D136, D137).

## 0.7.1

2026-09-23

**A code block in the request and response inspector wraps its lines, unless
it shows re-indented JSON.** A body above the formatting limit, a body that is
not JSON, every Base64 rendering and `Raw` on both halves of the panel used to
be laid out on lines as long as the data made them, so a minified payload was
one line to drag sideways through. Those blocks are now read by scrolling down
alone, and a caption says `Long lines wrap; the breaks on screen are not in the
content.` where a line did not fit. A re-indented body keeps its indentation
and still scrolls sideways for a long value. Copying is unchanged, and the
detail header shows the full target when hovered.

## 0.7.0

2026-09-22

**A session now lives 7 days from its last use instead of 72 hours from its
creation.** Use is a captured webhook or a load of the View page; nothing is
asked of the user. An expired session is never revived, and sessions that
existed before move into the new window on their first use. On the page the
countdown is replaced by the standing line `KEPT FOR 7 DAYS AFTER LAST USE`,
and the two unavailable screens became one: `Session expired` is gone, and the
remaining screen tells an id-shaped address that the session may have existed
and been removed after 7 days without use. The API answers `410` / `1002` and
`404` / `1001` exactly as before (#3, D133).

## 0.6.1

2026-09-21

**Small muted text now meets WCAG AA contrast.** The muted text colour is now
dark enough for at least 4.5:1 on every background it is drawn on, and three paler
muted shades are gone, so step numbers, timestamps, sender addresses, inactive
tab labels, captions and placeholders all read in that one colour. No
behaviour and no wording changed (#17, D131).

## 0.6.0

2026-09-21

**The sender's own address is recorded.** `sourceIp` now holds the public
address the request came from, rather than the address of the proxy in front
of the server, and a value the sender forges in `X-Forwarded-For` is still
replaced before it arrives. The address is stored for the life of the session
and no longer. IPv6 is covered by tests only, since the site has no IPv6
address (#8, D117).

## 0.5.2

2026-09-21

**A request to clear a session that carries a body is answered as a client
error instead of `500`.** `DELETE /api/sessions/:sessionId/requests` takes no
body. A body declared `application/json` that is empty or does not parse now
answers `400` / `1006 MALFORMED_REQUEST_BODY`, and a body of another media
type, or with none declared, `415` / `1007 UNSUPPORTED_MEDIA_TYPE`, where both
used to answer `500` / `1500 INTERNAL_ERROR`. On the webhook URL a
`Content-Type` that is not a media type at all, such as `json`, now answers
`415` / `1007` instead of `500` / `1500` (#10, D104).

## 0.5.1

2026-09-21

**`Content-Security-Policy-Report-Only` can no longer be set on a custom
response.** It is refused at session creation with `400` /
`1005 INVALID_RESPONSE_CONFIG`, like `Content-Security-Policy`, `NEL`,
`Report-To` and `Reporting-Endpoints`, because it could make a browser that
opened the session's `/s/…` URL report to an address the session had chosen.
Sessions created before keep sending it until they expire (#16, D101).

## 0.5.0

2026-09-20

**QA Tools inspects webhooks: generate a temporary URL, send it requests and
see each one as it arrives.** `Generate URL` creates a session with a webhook
URL, `https://qa-tools.ru/s/<id>`, and a page, `https://qa-tools.ru/v/<id>`,
where every request sent to it appears live. The URL captures requests of the
common HTTP methods with any body, and answers `200` with the id of the stored request, or a custom response —
a status, headers, a JSON body and a delay of up to 30 s — chosen when the
session is created. Each request opens in two halves: `Request`, with its raw
text, re-indented JSON body, headers in their order, query string, size and
time, and `Response`, what the server answered and whether
it finished sending it. A session keeps its newest 1000 requests of up to 1 MiB
each, one request or all of them can be deleted, and the session is deleted
with everything it captured 72 hours after it was created. There are no
accounts: whoever has the URL has the session.
