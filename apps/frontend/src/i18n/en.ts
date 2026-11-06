/**
 * The interface's words in English (issue #108, D222): every visible and
 * accessible text the application draws, in one place. `ru.ts` is typed
 * against this object, so a key that exists in one language and not the other
 * fails the typecheck, and `i18n.test.ts` walks both.
 *
 * Plain values: a string, a list of strings, or a function for a text with
 * numbers or names in it, which composes the whole text itself - plurals and
 * word order included - so a caller never joins words. Nothing here imports
 * anything, so the build scripts can load it with Node's own TypeScript
 * support: `scripts/site-chrome.mjs` reads it, and `ru.ts`, for the header and
 * the footer band of the static pages, the English static pages in these
 * words and `/ru/about` in Russian (D255).
 *
 * The English texts are the ones the interface had before this dictionary,
 * byte for byte: the unit tests that pinned them still do, through the
 * functions that now read them here.
 */

/** `1 session`, `3 sessions`: a count and its noun, the English way. */
function count(value: number, one: string, other: string): string {
  return `${value} ${value === 1 ? one : other}`;
}

/** `503`, `503 and 200`, `503, 429 and 200`. */
function list(items: readonly (string | number)[]): string {
  return items.length < 2
    ? `${items[0] ?? ''}`
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A delay in seconds as a chip writes it: `2 s`, `0.5 s`, `1.25 s`. */
function seconds(delayMs: number): string {
  return `${Number((delayMs / 1000).toFixed(3))} s`;
}

/** Where a response rule is checked, by its place: `first` to `twentieth` (D246's 20). */
const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
];

export const en = {
  /** The language's tag: `<html lang>` while it is shown. */
  lang: 'en',

  /** A number as the language groups it: `65,536`. */
  number: (value: number): string => value.toLocaleString('en-US'),

  /**
   * The month abbreviations of the detail panel's time and the home page's
   * day headings, `17 Sep 2026`: fixed here rather than taken from a locale
   * (D148).
   */
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],

  /**
   * The browser tab's title, the only place the unread count appears (D014):
   * the service's own name, Webhook Inspector (issue #322, D277).
   */
  title: {
    base: 'Webhook Inspector',
    unread: (unread: number): string => `(${unread}) Webhook Inspector`,
    /**
     * The home page's: the `<title>` of `index.html`, which a search engine
     * shows, kept once the page has loaded (D183, D226), the platform's name
     * after the service's (D277).
     */
    home: 'Webhook Inspector — QA Tools',
  },

  /** The header every page carries (D158, D184, D209). */
  header: {
    changelog: 'Changelog',
    status: 'Status',
    apiDocs: 'API docs',
    /** What a link's drawn `↗` says to assistive technology. */
    newTab: '(opens in a new tab)',
  },

  /**
   * The move to the new address (issue #321, D276; Figma `Webhook Inspector ·
   * Move banner (#321)`, C1 and T): the banner above the header on the old
   * address, and the toast on the new one once a move link has been read.
   */
  move: {
    /** The banner's text: the new host and day X, both the build's. */
    notice: (host: string, day: string): string =>
      `Webhook Inspector is moving to ${host} on ${day}`,
    /** The banner's one action, which the page closes with a drawn `→`. */
    action: 'Move with my sessions',
    /**
     * What came: the link's sessions the list now holds, how many of them are
     * private, and the old address's host, `null` where the build names none.
     */
    arrived: (sessions: number, privateSessions: number, from: string | null): string => {
      const where = from === null ? '' : ` from ${from}`;

      if (privateSessions === 0) {
        return `Moved ${count(sessions, 'session', 'sessions')}${where}`;
      }

      return sessions === 1
        ? `Moved 1 private session${where}`
        : `Moved ${count(sessions, 'session', 'sessions')}${where}, ${privateSessions} of them private`;
    },
  },

  /** The footer band every page closes with (D177, D211, D217). */
  footer: {
    /** The privacy line, D265's, its last clause on the backups the operator's (issue #396). */
    line: "Captured requests — headers, body and the sender's IP — are kept until you delete them or the session expires, at most 7\u00a0days unused; backups keep them up to 3\u00a0days longer.",
    /**
     * The line of a build without the operator's texts (issue #396): D265's,
     * ending after the session's 7 days, with no promise about backups the
     * copy may not keep.
     */
    lineWithoutBackups:
      "Captured requests — headers, body and the sender's IP — are kept until you delete them or the session expires, at most 7\u00a0days unused.",
    about: 'About',
    terms: 'Terms',
    privacy: 'Privacy',
    contact: 'Contact:',
  },

  /** The `EN | RU` switch (D222). */
  language: {
    /** The switch's group name for assistive technology. */
    label: 'Language',
  },

  /** Words several surfaces share. */
  common: {
    cancel: 'Cancel',
    close: 'Close',
  },

  /** The copy controls (D122, D182). */
  copy: {
    copy: 'Copy',
    copied: 'Copied',
    /** Said when the browser refuses a code box's copy: the block is still on screen. */
    blockRefused: 'The browser refused the copy. The text is still selectable.',
  },

  /** The home page's first-visit copy, which `index.html`'s `<noscript>` repeats (D183, D199). */
  landing: {
    eyebrow: 'WEBHOOK INSPECTOR',
    heading: 'Inspect webhooks instantly.',
    lead: 'Generate a temporary URL and inspect incoming HTTP requests in real time. No registration, no setup.',
    generate: 'Generate URL',
    hintFirstVisit: '— your temporary endpoint, ready in a second',
    hintReturning: '— a new temporary endpoint',
    /** Under the tile when no session was created (issue #128). */
    notCreated: 'This session could not be created. Please\u00a0try\u00a0again.',
    /** `429` / `1015` with a `Retry-After` of `retryAfter` seconds. */
    tooManySessions: (retryAfter: number): string =>
      `Too many sessions created from your address. Try\u00a0again\u00a0in\u00a0${retryAfter}\u00a0s.`,
    stepsTitle: 'How it works',
    stepsCount: (steps: number): string => `${steps} steps`,
    steps: [
      {
        number: '01',
        title: 'Generate URL',
        description:
          'Create a temporary endpoint instantly. Anyone with its URL can see what it receives, so do not send sensitive production data.',
      },
      {
        number: '02',
        title: 'Send requests',
        description: 'Use it from Postman, CI, webhooks, or any HTTP client.',
      },
      {
        number: '03',
        title: 'Inspect live',
        description: 'See method, headers, query, body, IP, size, and time.',
      },
    ],
  },

  /**
   * The new session's options on the home page's tile (issue #216, D249): how
   * long it lives after its last use and whether it keeps the sender's IP.
   */
  newSession: {
    /** The trigger's name before its values, and the sheet's, for assistive technology. */
    options: 'New session options',
    /** The menu's and the sheet's heading over the three windows. */
    expiresTitle: 'Expires after last use',
    /** A window in whole days, as the trigger and the menu write it: `7 days`, `1 day`. */
    days: (days: number): string => count(days, 'day', 'days'),
    /** A window in whole hours: `1 hour`. */
    hours: (hours: number): string => count(hours, 'hour', 'hours'),
    ipStored: 'IP stored',
    ipNotStored: 'IP not stored',
    storeIp: "Store the sender's IP",
    /** The quoted part never breaks inside: its spaces are no-break spaces. */
    storeIpHint: 'Off: requests show “IP not stored”',
    /** In place of the tile's hint from 768 px while the window is not 7 days. */
    hintDays: (days: number): string => `— expires ${count(days, 'day', 'days')} after last use`,
    hintHours: (hours: number): string =>
      `— expires ${count(hours, 'hour', 'hours')} after last use`,
    /** The menu's and the sheet's last checkbox, and the trigger's name once ticked (D259). */
    privateSession: 'Private session',
    privateHint: 'Opens only with its link with access',
  },

  /**
   * A private session in the interface (issue #228, D259): its mark, the
   * card's `Copy ▾`, the list's warning before `Remove from list`, and the
   * field `Session not found` opens for a link with access or a key.
   */
  access: {
    /** The lock's accessible name, on a list row and on the card. */
    mark: 'Private session',
    /** The name of the split button's `▾`, and of the phone's sheet it opens. */
    copyMenu: 'Copy options',
    copyReceiveUrl: 'Copy receive URL',
    copyReceiveUrlHint: 'For the sender: it only receives requests',
    copyLink: 'Copy link with access',
    copyLinkHint: 'For a colleague: opens this session',
    /** The toast of either copy of a link with access, a request's `Copy link` included. */
    linkCopied: 'Link with access copied',
    removeTitle: 'Remove this private session from the list?',
    removeDescription:
      'Only this browser holds its key. The session itself is not deleted, but once it leaves the list it opens only with its link with access. Copy the link first if you may need it.',
    /** Under `Go to home page` on `Session not found`, opening the field. */
    openWith: 'Open with a link with access or a key…',
    pasteHint: 'Have a link with access or a key? Paste either one to open the session.',
    open: 'Open',
    /** A paste that opened nothing: a wrong key, a malformed link, a session that is gone. */
    pasteFailed:
      'Nothing opened: this is not a link with access or a key of a session that exists.',
  },

  /** The returning visitor's list of sessions (D199). */
  home: {
    loading: 'Loading sessions…',
    detailsFailed: 'Session details could not be loaded.',
    sessions: (sessions: number): string => count(sessions, 'session', 'sessions'),
    requests: (requests: number): string => count(requests, 'request', 'requests'),
    noRequestsYet: 'no requests yet',
    lastRequest: 'last request',
    lastRequestAt: (time: string): string => `last request ${time}`,
    /** `5 of 12 sessions in this browser`, while some are hidden. */
    someShown: (shown: number, total: number): string =>
      `${shown} of ${total} sessions in this browser`,
    /** `3 sessions in this browser`, when every one shows. */
    allShown: (total: number): string => `${count(total, 'session', 'sessions')} in this browser`,
    showAll: 'Show all',
    deleteTitle: 'Delete this session?',
    /**
     * The confirmation's sentence. `requests` is the status read's count, or
     * `null` when the read failed and the sentence names none.
     */
    deleteDescription: (shortId: string, requests: number | null): string => {
      const held =
        requests === null
          ? 'its requests and response settings'
          : requests === 0
            ? 'its response settings'
            : `its ${count(requests, 'request', 'requests')} and response settings`;

      return `This will permanently delete the session ${shortId} with ${held}. Its receive URL will answer 404 to every sender. This action cannot be undone.`;
    },
    deleteFailed: 'The session could not be deleted. Try again.',
    deleteButton: 'Delete session',
    deleting: 'Deleting…',
    deleted: (shortId: string): string => `Session ${shortId} deleted`,
    expired: (shortId: string): string => `Session ${shortId} had already expired`,
  },

  /** A row of the home page's list and its `⋯` (D199). */
  sessions: {
    removeFromList: 'Remove from list',
    deleteSession: 'Delete session…',
    /** The phone's sheet's title, before the session's short id. */
    sheetTitle: 'Session',
    actions: (shortId: string): string => `Actions for session ${shortId}`,
    copyUrl: (shortId: string): string => `Copy the receive URL of session ${shortId}`,
    copyRefused: 'The browser refused the copy. The receive URL was not copied.',
  },

  /**
   * The session page's statements about its own lifetime (D133, D158), one
   * per rule a session can follow (D249): its idle window in whole days,
   * hours or minutes, or the fixed end of a session created with a lifetime.
   */
  lifetime: {
    retention: (days: number): string =>
      `SESSION EXPIRES ${count(days, 'DAY', 'DAYS')} AFTER LAST USE`,
    retentionHours: (hours: number): string =>
      `SESSION EXPIRES ${count(hours, 'HOUR', 'HOURS')} AFTER LAST USE`,
    retentionMinutes: (minutes: number): string =>
      `SESSION EXPIRES ${count(minutes, 'MINUTE', 'MINUTES')} AFTER LAST USE`,
    /**
     * `SESSION EXPIRES 26 SEP AT 11:50`: the day, the month as the dictionary
     * abbreviates it, upper-cased, the year only when it is not this year,
     * and the time on a 24-hour clock.
     */
    retentionUntil: (day: number, month: string, year: number | null, time: string): string =>
      `SESSION EXPIRES ${day} ${month}${year === null ? '' : ` ${year}`} AT ${time}`,
    /** Beside the line for a session that keeps no sender address (D243). */
    ipNotStored: 'IP NOT STORED',
    /** Last on the line, after the lock, for a private session (D259). */
    private: 'PRIVATE',
  },

  /** The session page's own failure (D072, D133). */
  session: {
    errorTitle: 'Something went wrong',
    errorLines: [
      'This session could not be loaded.',
      'The session itself may be fine; try again in a moment.',
    ],
  },

  /** The two not-found screens (D146, D147). */
  notFound: {
    goHome: 'Go to home page',
    sessionTitle: 'Session not found',
    sessionAnswer: 'Session not available',
    sessionBody:
      'It was most likely deleted, on purpose or after going unused for the time chosen when it was created, together with its requests and response settings.',
    pageTitle: 'Page not found',
    pageBody: 'There is nothing at this address. Check the URL, or go back to the home page.',
  },

  /** A link to one request whose request is gone (D182). */
  staleLink: 'The linked request is no longer in this session.',

  /** The push flow's Back bar below 1024 px (D157). */
  push: {
    /** `2 of 4`: the open request's place in the list. */
    position: (place: number, total: number): string => `${place} of ${total}`,
    /** `1 new`. */
    arrived: (arrived: number): string => `${arrived} new`,
    /** The visible word of `‹ Requests`. */
    requests: 'Requests',
    /** Its name, spelled out: the visible words with the badge would read `Requests1 new`. */
    back: (arrived: string | null): string =>
      arrived === null ? 'Back to Requests' : `Back to Requests, ${arrived}`,
  },

  /** The endpoint card (D133, D150, D158). */
  endpoint: {
    receiveUrl: 'RECEIVE URL',
  },

  /** The request list (D014, D029, D157, D180, D186, D207). */
  list: {
    heading: 'Requests',
    /** After `340 / 1000` from 768 px: the limit's noun. */
    limitSuffix: (_limit: number): string => ' requests',
    filterLabel: 'Filter requests',
    closeFilter: 'Close filter',
    clearFilter: 'Clear filter',
    retry: 'Retry',
    noMatch: (query: string): string => `No requests match “${query}”`,
    waitingTitle: 'Waiting for the first request',
    waitingText: 'Send any HTTP request to the receive URL above. It will appear here instantly.',
    newestOnTop: 'Newest requests appear at the top.',
    compareWith: 'Compare with…',
    chooseFor: (method: string, shortId: string): string =>
      `Choose a request for ${method} ${shortId}`,
    tapFor: (shortId: string): string => `Tap a request for ${shortId}`,
    /** Read after the open row's id while picking: why it is disabled. */
    openCannotChoose: ', open request, cannot be chosen',
    open: 'open',
    compare: 'Compare',
    noResponseTitle: 'No response was recorded for this request',
    statusTitle: 'Recorded response status',
    /** The marker after the status of a request a response rule answered (#233). */
    ruleMarker: (place: number): string => `R${place}`,
    /** That marker's title, and what the row's accessible name reads in its place. */
    answeredByRule: (place: number): string => `Answered by rule ${place}`,
    deleteRequest: 'Delete request',
    requestNotDeleted: 'This request could not be deleted.',
    requestsNotDeleted: 'These requests could not be deleted.',
  },

  /** The list's filter and its search of headers and bodies (D180, D191). */
  filter: {
    /** `3 of 8`, before ` / 1000` on the desktop. */
    count: (shown: number, total: number): string => `${shown} of ${total}`,
    placeholder: 'Search the list, headers and bodies',
    placeholderPhone: 'Search, bodies too',
    searching: 'Searching headers and bodies…',
    searchedToo: 'Headers and bodies were searched too.',
    notSearchedLead: 'Headers and bodies not searched:',
    tookOver: (seconds: number): string => `it took over ${seconds} s.`,
    busy: 'the server is busy.',
    failed: 'the search failed.',
    wordTooLong: (bytes: number): string => `a word is over ${bytes} bytes.`,
    tooManyWords: (words: number): string => `more than ${words} words.`,
  },

  /** The Delete all dialog (D029, D180). */
  deleteAll: {
    button: 'Delete all',
    title: 'Delete all requests?',
    description: (total: number, hidden: number): string => {
      const all = `This will permanently delete all ${total} requests from this session`;

      return hidden > 0
        ? `${all}, including ${hidden} hidden by the filter. This action cannot be undone.`
        : `${all}. This action cannot be undone.`;
    },
  },

  /** What a list row and the panel say about a request's recorded response (D119, D207). */
  record: {
    /** In place of the address a request was captured without (D120b). */
    noAddress: 'IP unavailable',
    /** In its place for a session created to keep no sender address (D243, D249). */
    ipNotStored: 'IP not stored',
    notRecorded: 'Not recorded',
    noRecordHeading: 'Response not recorded',
    noRecordNote:
      'There is no stored response for this request. Its request data is still available.',
    queueStep: (step: number, total: number): string => `Queue step ${step} of ${total}`,
    /** The response rule that answered, as it was then: `Rule 1 · POST /orders` (D246, R8). */
    rule: (place: number, method: string | null, path: string): string =>
      `Rule ${place} · ${method ?? 'Any'} ${path}`,
    pending: 'Pending',
    failed: 'Failed',
    noStatusComposed: 'no status composed',
    prepared: (status: number): string => `${status} prepared`,
    configuredDelay: (delayMs: number): string => `configured delay: ${delayMs} ms`,
    pendingNote: 'Waiting to send. The prepared response is shown below.',
    aborted: 'Send aborted',
    abortedNote: 'The connection closed before the server finished writing the response.',
    unknown: 'Send outcome unknown',
    unknownNote: 'The prepared response was saved; its final send outcome is unavailable.',
    sendingFailed: 'Sending failed',
    sendingFailedNote:
      'The server failed while writing the response. The prepared response is shown below.',
    sentByServer: 'Sent by server',
    headNote: 'The prepared body is stored for inspection. HEAD responses do not send it.',
    bodyNotSent: 'body not sent',
    binaryRecord: 'binary response record',
    customResponse: 'custom response',
  },

  /** How the session's response is named and summarised outside the editor (D150, D151). */
  response: {
    default: 'Default',
    custom: 'Custom',
    /** What the endpoint card's button opens, after its label. */
    settings: 'Response settings',
    delayNone: 'none',
    /** No longer than it was before 0.55.0, which the panel was drawn for (D223). */
    defaultSummary: '200 OK · JSON describing the request · no delay.',
    noDelay: 'no delay',
    noHeaders: 'no headers',
    headers: (headers: number): string => count(headers, 'header', 'headers'),
    noBody: 'no body',
    body: 'body',
    /** `6 queued`: the steps of the response queue still to answer (D205). */
    queued: (left: number): string => `${left} queued`,
    keptNote: (summary: string): string =>
      `Your custom response stays saved — ${summary} — and comes back when you switch to Custom.`,
    editorKeptNote:
      'Your custom status, delay, headers and body stay saved and come back when you switch to Custom.',
    appliedDefault: (status: number): string =>
      `Response is now the default ${status}, no delay. Requests captured from now on get it.`,
    applied: (status: number, delayMs: number): string =>
      `Response is now ${status}, ${delayMs > 0 ? `a ${delayMs} ms delay` : 'no delay'}. Requests captured from now on get it.`,
    saved: 'Saved. Requests captured from now on get this response.',
  },

  /** The quick switch (D150, D157). */
  quick: {
    title: 'Session response',
    /** The Default / Custom switch's name. */
    modeLabel: 'Response',
    defaultResponse: 'Default response',
    httpStatus: 'HTTP status',
    otherStatus: 'Other status',
    other: 'Other',
    delay: 'Delay',
    delayLabel: 'Delay in milliseconds',
    editHeadersAndBody: 'Edit headers and body…',
    apply: 'Apply',
    applying: 'Applying…',
    /** A delay chip's label. */
    delayChip: (delayMs: number): string => (delayMs === 0 ? 'None' : seconds(delayMs)),
    needsEmptyBody: (status: number): string =>
      `${status} needs an empty body — clear the body first.`,
    untouchedWithBody: (headers: number): string =>
      `Headers (${headers}) and body stay as they are. 204 needs an empty body.`,
    untouchedNoBody: (headers: number): string =>
      `Headers (${headers}) stay as they are, with no body.`,
    fromNowOn: 'Applies to requests captured from now on.',
    customStatus: (status: number): string => `Custom ${status}`,
    statusRange: (min: number, max: number): string => `Enter an integer from ${min} to ${max}.`,
    delayRange: (max: number): string => `Enter an integer from 0 to ${max}.`,
    fix: (status: boolean, delay: boolean): string =>
      `Fix the ${status && delay ? 'status and delay' : status ? 'status' : 'delay'} to apply.`,
  },

  /**
   * The response form's checks (D101, D106, D150). The English wording mirrors
   * the backend's; the other languages say the same rules in their own words.
   */
  config: {
    status: (min: number, max: number): string =>
      `Status is required and must be a whole number between ${min} and ${max}.`,
    bodyForbidden: (status: number): string =>
      `Status ${status} requires an empty body. Clear the body or pick another status.`,
    tooManyHeaders: (max: number): string => `At most ${max} headers can be configured.`,
    nameTooLong: (bytes: number): string => `Header name must be at most ${bytes} bytes.`,
    nameNotToken:
      "Header name must be an HTTP token: letters, digits and the characters !#$%&'*+.^_`|~-",
    valueTooLong: (bytes: number): string => `Header value must be at most ${bytes} bytes.`,
    valueNotVisible: 'Header value must contain only visible ASCII, space and tab.',
    blockTooLarge: (bytes: number): string =>
      `All headers together must be at most ${bytes} bytes as "name: value" lines.`,
    reserved: 'This header name is reserved by the receiver and cannot be configured.',
    locationStatus: (min: number, max: number): string =>
      `Location can be set only with a status from ${min} to ${max}.`,
    locationTarget: (prefix: string): string =>
      `Location must be a path on this host beginning with ${prefix}.`,
    delay: (max: number): string =>
      `Delay must be a whole number of milliseconds between 0 and ${max}.`,
    bodyTooLarge: (bytes: number): string => `Body must be at most ${bytes} bytes of UTF-8.`,
    bodyNul: 'Body must not contain U+0000.',
  },

  /** The full response editor (D150). */
  editor: {
    title: 'Session response settings',
    description:
      'Status, delay, headers and body. Changes apply to requests captured after you save.',
    defaultAnswerNote: 'Default answers 200 OK with a JSON body carrying the request ID, no delay.',
    waitingKeep: 'Requests waiting out their delay keep their answer',
    afterSave: 'Only requests captured after you save get the new response.',
    save: 'Save response',
    /** `16 / 65,536 bytes`. */
    bodyCounter: (used: string, limit: string): string => `${used} / ${limit} bytes`,
    bodyLabel: 'Body · Optional',
    automaticHeaders:
      'Added automatically: X-Webhook-Inspector-Request-Id, X-QA-Tools-Request-Id, X-Content-Type-Options, Content-Security-Policy; Content-Type too, when there is a body and none is set here. Reserved headers cannot be added.',
    saveFailed: 'Could not save the response',
    applyFailed: 'Could not apply the change',
    /** The server's own diagnostic after a fixed lead-in, never parsed (D106). */
    rejected: (message: string): string => `The server rejected this configuration: ${message}`,
    changesKept: 'Something went wrong. Your changes are kept. Please try again.',
    choiceKept: 'Something went wrong. Your choice is kept. Please try again.',
  },

  /** The fields of one custom response, the editor's and each queue step's (D150, D205). */
  fields: {
    status: 'HTTP status',
    statusHint: (min: number, max: number): string => `Any integer from ${min} to ${max}`,
    delay: 'Delay (ms)',
    /** `maxDelay` grouped as the language writes it. */
    delayHint: (maxDelay: string): string => `0–${maxDelay} ms · Capture stays immediate`,
    headers: 'Response headers',
    name: 'Name',
    value: 'Value',
    /** A header field's name: `Header 2 name`. */
    headerField: (place: number, field: 'name' | 'value'): string => `Header ${place} ${field}`,
    remove: 'Remove',
    removeHeader: (place: number): string => `Remove header ${place}`,
    addHeader: '+ Add header',
    bodilessStatuses: 'Statuses 204, 205 and 304 require an empty body.',
  },

  /**
   * A response as a template, in the fields of one response (issue #236,
   * D251): the opt-in under the body, the list of placeholders it inserts,
   * the hint while it is on, the editor's own check of the placeholders and
   * the tag that marks a template where a response is summarised. A
   * placeholder is handed in, never written here, so the Russian words hold
   * no Latin of their own.
   */
  template: {
    /** The checkbox under the body: `template` on or off. */
    fill: 'Fill in placeholders from the request',
    /** The menu button, drawn with `▾` after it, and the phone's sheet's title. */
    insert: 'Insert placeholder',
    /** Under the row while the box is ticked; `example` is `{{request.id}}`. */
    hint: (example: string): string =>
      `Placeholders like ${example} are replaced with values of the captured request.`,
    requestId: 'Request id',
    method: 'Method',
    path: 'Path',
    query: 'Query parameter…',
    header: 'Header…',
    body: 'JSON body field…',
    /** The quiet tag of a template, and a queue chip's part: `201 · Template`. */
    tag: 'Template',
    /** A placeholder not of the set, as it was typed. */
    unknown: (placeholder: string): string => `Unknown placeholder ${placeholder}.`,
    /** A query or header placeholder with no name, or a body one with no path. */
    finish: (placeholder: string, part: 'name' | 'path'): string =>
      `Finish ${placeholder}: type the ${part === 'name' ? 'name' : 'field path'} before }}.`,
    unclosed: 'A placeholder is not closed: {{ without }}.',
  },

  /** The response queue: the quick switch's section, the dialog and their toasts (D205, D206). */
  queue: {
    title: 'Response queue',
    done: 'Done',
    setUp: 'Set up a queue…',
    edit: 'Edit queue…',
    runAgain: 'Run again',
    starting: 'Starting…',
    keep: 'Keep queue',
    description:
      'Answered first, one step per request, in this order. Then the session response answers every later request.',
    noStepsTitle: 'No steps yet',
    noStepsText:
      'Each step answers one request, in order. Until you add one, every request gets the session response.',
    addStep: '+ Add step',
    addStepHint: 'Add a step to set its status, delay, headers and body.',
    restartHint: 'Saving starts the queue from step 1; clearing requests does too.',
    waitingKeep: 'Requests waiting out their delay keep their answer.',
    steps: 'Steps',
    step: (place: number): string => `Step ${place}`,
    stepOfQueue: (place: number, total: number): string =>
      `Step ${place} of ${total} of the response queue.`,
    /** A step's row as assistive technology reads it: `Step 2: 503 Service Unavailable, 2 s, next`. */
    stepName: (
      place: number,
      code: string,
      name: string | null,
      delay: string,
      marker: 'answered' | 'next' | 'ahead' | 'invalid',
    ): string =>
      `Step ${place}: ${code}${name === null ? '' : ` ${name}`}${delay === '' ? '' : `, ${delay}`}${marker === 'next' ? ', next' : marker === 'answered' ? ', answered' : ''}`,
    nextTag: 'Next',
    thenEveryLater: 'then every later request',
    duplicate: 'Duplicate',
    duplicateStep: 'Duplicate step',
    removeStep: 'Remove step',
    backToSteps: 'Back to the steps',
    delay: (delayMs: number): string => seconds(delayMs),
    sessionDefault: (status: number): string => `Default ${status}`,
    sessionCustom: (status: number, delay: string): string =>
      `Custom ${status}${delay === '' ? '' : ` · ${delay}`}`,
    exampleChips: ['201', '404 · 2 s', '503'],
    noQueue: 'No steps yet. Answered before the session response, in Default and Custom alike.',
    everyStepAnswered: 'Every step answered — the session response comes next',
    counter: (next: number, total: number): string => `Step ${next} of ${total}`,
    leadNextThenSession: 'Next response, then the session response',
    leadNextThenRest: 'Next response, then the rest',
    leadLastThenSession: 'Last answered, the last step, then the session response',
    leadLastThenRest: 'Last answered, next response, then the rest',
    answeredLast: (chip: string): string => `Answered last: ${chip}.`,
    next: (chip: string): string => `Next: ${chip}.`,
    then: (chips: readonly string[]): string => `Then ${chips.join(', ')}.`,
    thenSession: (chip: string): string => `Then the session response, ${chip}.`,
    nextSession: (chip: string): string => `Next: the session response, ${chip}.`,
    saved: 'Queue saved.',
    /**
     * After a save: `statuses` are those of the steps still to answer, none
     * once every step has; `custom` whether the session response is custom.
     */
    savedAhead: (statuses: readonly number[], custom: boolean): string =>
      statuses.length === 0
        ? `Queue saved, and every step has already answered a request; the next requests get ${custom ? 'the custom response' : 'the default response'}.`
        : `Queue saved. ${nextRequests(statuses)}, then ${custom ? 'the custom response' : 'the default response'}.`,
    nothingToRestart: 'The session has no queue to start again.',
    /** After `Run again`: `started` once a capture has taken a step of the new run. */
    restarted: (statuses: readonly number[], custom: boolean, started: boolean): string =>
      statuses.length === 0
        ? `The queue started again from step 1, and every step has already answered a request; the next requests get ${custom ? 'the custom response' : 'the default response'}.`
        : `The queue ${started ? 'started' : 'starts'} again from step 1. ${nextRequests(statuses)}.`,
    removed: 'Queue removed. Requests get the session response only.',
    restartFailed: 'Could not start the queue again. Try again.',
    placeAnswered: 'answered a request in this run',
    placeNextFirst: 'answers the next request',
    placeNext: 'next — answers the next request',
    placeAhead: (previous: number): string => `answers the request after step ${previous}`,
    notAStatus: 'not a status code',
    hasError: 'has an error',
    fixSteps: (steps: readonly number[]): string =>
      steps.length === 1
        ? `Fix step ${steps[0]} to save the queue.`
        : `Fix steps ${list(steps)} to save the queue.`,
    removeShort: (steps: number): string =>
      steps === 1 ? 'Remove the step?' : `Remove all ${steps} steps?`,
    removeQuestion: (steps: number): string =>
      `${steps === 1 ? 'Remove the step?' : `Remove all ${steps} steps?`} Requests will get the session response only.`,
    tooLarge:
      'This queue is over 1 MiB as JSON, too large to save. Shorten a body or remove a step.',
    serverBusy:
      'The server is busy saving other large queues. Your steps are kept — try again in a moment.',
    rejected: (message: string): string => `The server rejected this queue: ${message}`,
    // A refusal placed at a step (D257): its place counted from 1, as the list counts.
    rejectedStep: (step: number): string =>
      `The server rejected step ${step}. Fix the marked field and save again.`,
    rejectedStepWithReason: (step: number, message: string): string =>
      `The server rejected step ${step}: ${message}`,
    saveFailed: 'Could not save the queue. Your steps are kept — try again.',
    removeFailed: 'Could not remove the queue. Try again.',
    saving: 'Saving…',
    tryAgain: 'Try again',
    save: 'Save queue',
    removing: 'Removing…',
    removeQueue: 'Remove queue',
    remove: 'Remove',
  },

  /** The response rules: the quick switch's section, the dialog and their toasts (D246, #226). */
  rules: {
    title: 'Response rules',
    setUp: 'Set up rules…',
    edit: 'Edit rules…',
    removeRules: 'Remove rules',
    keep: 'Keep rules',
    remove: 'Remove',
    noRules:
      'No rules yet. A request whose method and path match a rule gets its response, before the queue and the session response.',
    /** `3 rules`: in the endpoint label and on the right of the section's heading. */
    count: (rules: number): string => count(rules, 'rule', 'rules'),
    everyOther: 'Every other request → the session response.',
    everyOtherQueue: 'Every other request → the queue, then the session response.',
    description:
      "The first rule a request's method and path match answers it. Other requests: the queue, when set, then the session response.",
    noRulesTitle: 'No rules yet',
    noRulesText:
      'Add a rule to answer requests by their method and path. Until you add one, every request gets the session response.',
    fallbackTitle: 'Every other request',
    /** `session` is the session response as the queue names it: `Custom 200`. */
    fallbackSession: (session: string): string => `→ the session response, ${session}`,
    fallbackQueue: (session: string): string =>
      `→ the queue, then the session response, ${session}`,
    addRule: '+ Add rule',
    list: 'Rules',
    rule: (place: number): string => `Rule ${place}`,
    /** Beside `Rule 2`: `checked second`. */
    checked: (place: number): string => `checked ${ORDINALS[place - 1] ?? `as rule ${place}`}`,
    counter: (place: number, total: number): string => `Rule ${place} of ${total}`,
    ruleOfList: (place: number, total: number): string =>
      `Rule ${place} of ${total} of the response rules.`,
    /** A rule's row as assistive technology reads it: `Rule 2: GET /status → 200 OK`. */
    ruleName: (
      place: number,
      method: string,
      path: string,
      code: string,
      name: string | null,
      delay: string,
    ): string =>
      `Rule ${place}: ${method} ${path} → ${code}${name === null ? '' : ` ${name}`}${delay === '' ? '' : `, ${delay}`}`,
    duplicate: 'Duplicate',
    duplicateRule: 'Duplicate rule',
    removeRule: 'Remove rule',
    removeAll: 'Remove all rules',
    backToRules: 'Back to the rules',
    method: 'Method',
    anyMethod: 'Any',
    otherMethod: 'Other',
    otherMethodLabel: 'Other method',
    path: 'Path',
    pathHint: 'Exact path, query ignored. End it with * to match every path under it.',
    move: (place: number): string => `Move rule ${place}`,
    moveHint: 'Drag it, or press the up or down arrow, to change the order.',
    dragHint: 'Drag ⋮⋮ to change the order. Saving applies to requests captured from now on.',
    savingHint: 'Saving applies to requests captured from now on.',
    methodRequired: 'Type a method, such as OPTIONS.',
    methodUnknown: 'Not a method the receiver captures. Type one such as OPTIONS or PROPFIND.',
    /** `max` grouped as the language writes it. */
    pathTooLong: (max: string): string => `The path is longer than ${max} characters.`,
    pathCharacters:
      'Use visible ASCII only: write a space or any other character percent-encoded, as %20.',
    pathQuery: 'Leave out ? and what follows it: the query is never matched.',
    pathStar: 'Use * only at the end, where it matches every path under it.',
    pathLeadingSlash:
      'The receive URL before the field already ends in /, so this matches only a path that starts with //. Leave out the first / unless you mean two.',
    pathFullUrl:
      'This looks like a full URL. Type only the path after the receive URL: as typed, it matches no ordinary request.',
    fixRules: (rules: readonly number[]): string =>
      rules.length === 1
        ? `Fix rule ${rules[0]} to save the rules.`
        : `Fix rules ${list(rules)} to save the rules.`,
    removeShort: (rules: number): string =>
      rules === 1 ? 'Remove the rule?' : `Remove all ${rules} rules?`,
    removeQuestion: (rules: number): string =>
      `${rules === 1 ? 'Remove the rule?' : `Remove all ${rules} rules?`} Requests will be answered by the queue, when set, then the session response.`,
    tooLarge:
      'These rules are over 1 MiB as JSON, too large to save. Shorten a body or remove a rule.',
    serverBusy:
      'The server is busy with other large saves. Your rules are kept — try again in a moment.',
    rejected: (message: string): string => `The server rejected these rules: ${message}`,
    // A refusal placed at a rule (D257): its place counted from 1, as the list counts.
    rejectedRule: (rule: number): string =>
      `The server rejected rule ${rule}. Fix the marked field and save again.`,
    rejectedRuleWithReason: (rule: number, message: string): string =>
      `The server rejected rule ${rule}: ${message}`,
    saveFailed: 'Could not save the rules. Your rules are kept — try again.',
    removeFailed: 'Could not remove the rules. Try again.',
    save: 'Save rules',
    saved: (rules: number): string =>
      `${count(rules, 'rule', 'rules')} saved. Requests captured from now on are checked against them first.`,
    savedNone:
      'Saved with no rules. Requests are answered by the queue, when set, then the session response.',
    removed:
      'Rules removed. Requests are answered by the queue, when set, then the session response.',
  },

  /** `Check signature…` (D197). */
  signature: {
    title: 'Check signature',
    headerLabel: 'Signature header',
    chooseHeader: 'Choose a header',
    /** A header that arrived more than once, as the list offers it. */
    headerOption: (name: string, values: number): string => `${name} (${values} values)`,
    secretLabel: 'Secret',
    secretPlaceholder: 'Signing secret',
    showSecret: 'Show secret',
    hideSecret: 'Hide secret',
    algorithm: 'Algorithm',
    match: 'Match',
    noMatch: 'No match',
    computed: 'Computed',
    copyComputed: 'Copy computed signature',
    warning: 'Computed in your browser. Not sent or stored. Use a test secret.',
    noHeader: 'Choose the header that holds the signature.',
    noSecret: 'Type the secret to check.',
    hint: 'Stripe, Slack and Standard Webhooks sign a timestamp or an id together with the body, so a check of the body alone never matches them.',
    unavailable: 'This browser cannot compute an HMAC on this page.',
    /** `159 bytes`, `2,048 bytes`, `1 byte`. */
    bytes: (bytes: number): string =>
      `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`,
    /** `HMAC-SHA256 of the body, 159 bytes`. */
    subject: (hmac: string, bytes: string): string => `${hmac} of the body, ${bytes}`,
    /** The header that matched when it arrived more than once. */
    valueOf: (header: string, value: number, values: number): string =>
      `${header}, value ${value} of ${values}`,
    /** The header that did not match, arrived more than once. */
    values: (header: string, values: number): string => `${header}, ${values} values`,
  },

  /** `Compare with…` (D186). */
  compare: {
    comparing: 'Comparing',
    change: 'Change',
    closeComparison: 'Close comparison',
    /** Read after a view's name when it differs. */
    differs: ', differs',
    openMinus: 'Open request, minus',
    chosenPlus: 'Chosen request, plus',
    loading: (name: string): string => `Loading ${name}…`,
    gone: (name: string): string => `${name} is no longer in this session.`,
    notLoaded: (name: string): string => `${name} could not be loaded.`,
    chooseAnother: 'Choose another',
    unchangedLines: (lines: number): string =>
      lines === 1 ? '1 unchanged line' : `${lines} unchanged lines`,
    show: 'Show',
    removed: 'Removed: ',
    added: 'Added: ',
    noDifferences: (view: string): string => `No differences in ${view}.`,
    identical: 'The two requests are identical in every view.',
    tooManyChanges: 'Too many changes to show line by line.',
    /** `raw`: a view of raw requests, else of bodies. */
    wholeDiffer: (raw: boolean): string => `The ${raw ? 'raw requests' : 'bodies'} differ.`,
    wholeSame: (raw: boolean, binary: boolean, size: string): string =>
      `The ${raw ? 'raw requests' : 'bodies'} are ${binary ? 'binary and identical' : 'identical'}: ${size} each.`,
    wholeTooLarge: 'Bodies and raw requests above 256 KB are compared only as a whole.',
    wholeOther:
      'Binary bodies, multipart bodies and a Raw that is not UTF-8 are compared as a whole.',
  },

  /** The request actions: `Actions ▾`, the phone's sheet, their toasts (D182, D185). */
  actions: {
    menu: 'Actions',
    /** The name of the phone's `⋯` and the title of the sheet it opens. */
    title: 'Request actions',
    copyLink: 'Copy link',
    copyCurl: 'Copy as cURL',
    downloadJson: 'Download JSON',
    checkSignature: 'Check signature…',
    compare: 'Compare with…',
    linkCopied: 'Link copied',
    linkRefused: 'The browser refused the copy. The link was not copied.',
    curlCopied: 'cURL command copied',
    curlRefused: 'The browser refused the copy. The cURL command was not copied.',
  },

  /** The detail panel's states and its copy controls (D072, D113, D122). */
  detail: {
    noSelection: 'No request selected',
    noSelectionNote: 'Send a request to the receive URL to get started.',
    loading: 'Loading request details…',
    loadingNote: 'The selected request will appear here.',
    failed: 'Could not load request details',
    failedNote: 'Your selected request is still in the list.',
    copyRawRequest: 'Copy raw request',
    copyRequestBody: 'Copy request body',
    copyRequestHeaders: 'Copy request headers',
    copyQuery: 'Copy query parameters',
    copyRawResponse: 'Copy raw response',
    copyResponseBody: 'Copy response body',
    copyResponseHeaders: 'Copy response headers',
  },

  /** What each code block of the detail panel says about itself (D112, D149, D162–D164). */
  blocks: {
    binaryBody: 'Binary body shown as Base64. JSON formatting is unavailable.',
    bodyTooLarge: 'Formatting unavailable above 256 KiB. Original content remains accessible.',
    notJson: 'Formatting unavailable: this body is not valid JSON.',
    jsonTooDeep: (levels: number): string =>
      `Formatting unavailable: JSON nested more than ${levels} levels deep is shown as stored.`,
    jsonTooLong: (characters: number): string =>
      `Formatting unavailable: JSON that formats to more than ${characters.toLocaleString('en-US')} characters is shown as stored.`,
    notXml: 'Formatting unavailable: this body is not well-formed XML.',
    xmlDoctype: 'Formatting unavailable: XML with a DOCTYPE is shown as stored.',
    xmlTooDeep: (levels: number): string =>
      `Formatting unavailable: XML nested more than ${levels} levels deep is shown as stored.`,
    xmlTooLong: (characters: number): string =>
      `Formatting unavailable: XML that formats to more than ${characters.toLocaleString('en-US')} characters is shown as stored.`,
    notRecognised: 'Shown as stored: no JSON or XML structure was recognised.',
    formNotUtf8: 'Not decoded: this form body is not UTF-8.',
    formNoPairs: 'Not decoded: this form body has no name/value pairs.',
    queryNotUtf8: 'Not decoded: this query string is not UTF-8.',
    queryCaption: 'Query parameters belong to the incoming request.',
    multipartNoBoundary: 'Not split into parts: Content-Type declares no boundary.',
    multipartNoDelimiter:
      'Not split into parts: the boundary declared in Content-Type never starts a part.',
    multipartNoClose: 'Not split into parts: the closing boundary is missing.',
    multipartTooLarge: 'Not split into parts above 256 KiB, binary content not counted.',
    multipartSplit: (parts: number): string =>
      `${parts === 1 ? '1 part' : `${parts} parts`}, split at the boundary declared in Content-Type.`,
    multipartPreamble: 'Content before the first boundary is in Raw, not in a part.',
    multipartEpilogue: 'Content after the closing boundary is in Raw, not in a part.',
    multipartBoth:
      'Content before the first boundary and after the closing one is in Raw, not in a part.',
    partTitle: (place: number): string => `Part ${place}`,
    partText: 'text',
    partBinary: 'binary',
    partBinaryNote: 'Binary content, not shown. Its bytes are in Raw.',
    partEmpty: 'No content.',
    bodyNotSent: 'Body not sent (HEAD).',
    rawBodyBase64: 'Body shown as Base64 because it contains non-UTF-8 bytes.',
    rawHeadLatin1: 'Headers shown as Latin-1 because they contain non-UTF-8 bytes.',
    rawRequestBase64: 'Raw request shown as Base64 because it contains non-UTF-8 bytes.',
    rawResponseBase64: 'Raw response shown as Base64 because it contains non-UTF-8 bytes.',
    wrapped: 'Long lines wrap; the breaks on screen are not in the content.',
    addressShortened: 'The full sender address is shown above. List rows keep a compact address.',
    noRawRequest: 'No raw request',
    noRequestBody: 'No request body',
    noRequestBodyCaption: 'This request was captured without a body.',
    noHeaders: 'No headers',
    headersCaption: 'Headers as received by the server.',
    noQuery: 'No query parameters',
    responseHeadersOnly: 'This response contains headers and no body.',
    responseRecorded: 'Recorded HTTP representation · proxy changes are not included.',
    noRawResponse: 'No raw response',
    noResponseBody: 'No response body',
    statusWithoutBody: (status: number): string =>
      `HTTP ${status} does not include a response body.`,
    customWithoutBody: 'This custom response was configured without a body.',
    noResponseHeaders: 'No response headers',
    responseHeadersCaption: 'Recorded headers retain their order and repeated names.',
  },
};

/** `The next 2 requests get 503`, `The next request gets 503 and 429`. */
function nextRequests(statuses: readonly number[]): string {
  const said = statuses.every((status) => status === statuses[0])
    ? `${statuses[0]}`
    : list(statuses);

  return statuses.length === 1
    ? `The next request gets ${said}`
    : `The next ${statuses.length} requests get ${said}`;
}

/** The shape every language's dictionary has: `ru.ts` is typed against it. */
export type Messages = typeof en;

/**
 * A text kept for later - a toast, an error line - as the way to write it
 * rather than as words, so it is written in the language shown when it is
 * drawn: switching the language redraws it too.
 */
export type Phrase = (m: Messages) => string;
