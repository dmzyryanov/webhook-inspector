import { Component, useMemo, useRef, type ReactNode } from 'react';
import type { RequestDetails, RequestListItem, ResponseRecord } from '@webhook-inspector/shared';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import {
  requestBodyBlock,
  requestHeadersBlock,
  requestQueryBlock,
  requestRawBlock,
  responseBodyBlock,
  responseHeadersBlock,
  responseRawBlock,
} from '../lib/detail-view.ts';
import { formatRequestFacts, splitRequestTarget } from '../lib/request-summary.ts';
import { describeResponse, type ResponseHeaderLines } from '../lib/response-summary.ts';
import { statusPillClassName } from '../lib/status-pill.ts';
import { Button } from './ui/button.tsx';
import { CodeBlock } from './CodeBlock.tsx';
import { CompareView, type ChosenDetails } from './CompareView.tsx';
import type { CompareViewName } from '../lib/request-diff.ts';
import { RequestActionsMenu, type ShowToast } from './RequestActions.tsx';
import type { SignatureMemoryRef } from './SignatureCheck.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.tsx';

interface RequestDetailProps {
  details: RequestDetails | null;
  /**
   * The page's session: the request link's, and the path `Copy as cURL` uses
   * for a request with no stored path (D167, D182).
   */
  sessionId: string;
  /** A private session's key, which the request's `Copy link` carries (D259). */
  accessKey?: string | null;
  /** The origin of the session's receive URL, which `Copy as cURL` targets (D187). */
  receiveOrigin: string;
  /** The page's toast, which confirms the request actions' copies (D182). */
  onToast: ShowToast;
  /** Whether a row is selected at all, which is what tells empty from loading. */
  hasSelection: boolean;
  /**
   * The session keeps no sender address: the facts line reads `IP not
   * stored` where the address is missing (D249).
   */
  keepsNoAddress: boolean;
  /** The detail request failed. The row itself is still in the list (D072). */
  failed: boolean;
  onRetry: () => void;
  /** `Compare with…` in the request actions: starts picking (D186). */
  onCompare: () => void;
  /** What `Check signature…` remembers between requests, the page's (D197). */
  signature: SignatureMemoryRef;
  /** The comparison the panel shows in place of the exchange, or `null` (D186). */
  comparison: PanelComparison | null;
  className?: string;
}

/** What the panel needs to show a comparison (#75, D186). */
export interface PanelComparison {
  chosenItem: RequestListItem;
  chosen: ChosenDetails;
  /** The view picked, kept by the page so that `Cancel` after `Change` restores it. */
  view: CompareViewName | null;
  onViewChange: (view: CompareViewName) => void;
  onChange: () => void;
  onClose: () => void;
  onRetry: () => void;
}

/**
 * Below 1024 px the panel is the whole screen under the Back bar: full-bleed,
 * with no frame of its own (3A, 7C, D157). It keeps a floor, so that a phone
 * or tablet held in landscape still has room for the tab area to scroll in;
 * the page scrolls to reach the rest of it.
 */
const NARROW_PANEL = 'max-lg:min-h-[420px] max-lg:rounded-none max-lg:border-0';

/** A phone's `Request` / `Response` tab: half the row, underlined across it. */
const EXCHANGE_TAB = 'max-md:flex-1 max-md:after:inset-x-0';

/** The view panels' padding: 16 px on a phone, 24 px on a tablet (3A, 7C). */
const VIEW_PANEL = 'max-md:px-4 max-md:pb-4 max-md:pt-3 md:max-lg:px-6 md:max-lg:pt-4';

/**
 * One captured exchange, split into the half that arrived and the half the
 * backend answered with (D107, D113).
 *
 * **Both levels of tabs are uncontrolled.** A newly selected request opens on
 * Request → `Raw` because the page remounts this component on
 * `key={selectedId}`, so there is no tab state to reset and none is kept in the
 * URL or in storage. The first switch into the Response half lands on `Body`,
 * which is simply that strip's `defaultValue`.
 *
 * The exchange panels are force-mounted and hidden by CSS rather than unmounted,
 * which is what makes "subsequent switching keeps whatever tab was last chosen
 * on each side" true without lifting either strip's state: an unmounted panel
 * would forget its tab and land back on `Body` every time.
 *
 * **A request that cannot be drawn costs the panel, not the page** (D169). An
 * exception thrown while rendering it shows the same `Could not load request
 * details` state as a failed load, inside the panel's own boundary, and the
 * list, the header and the endpoint card stay as they were. Without the
 * boundary React unmounts the whole page. Another selection remounts the
 * panel, boundary included, and draws that request normally.
 */
export function RequestDetail({
  details,
  sessionId,
  accessKey = null,
  receiveOrigin,
  onToast,
  hasSelection,
  keepsNoAddress,
  failed,
  onRetry,
  onCompare,
  signature,
  comparison,
  className,
}: RequestDetailProps) {
  const m = useMessages();

  if (!hasSelection) {
    return (
      <Centred
        heading={m.detail.noSelection}
        note={m.detail.noSelectionNote}
        className={className}
      />
    );
  }

  if (failed) {
    return <LoadFailed onRetry={onRetry} className={className} />;
  }

  // The panel used to say "Select a request to inspect it." here, while the
  // details of a request the viewer had just clicked were still loading. That
  // defect is fixed with the rebuild rather than left in place (D113).
  if (details === null) {
    return <Centred heading={m.detail.loading} note={m.detail.loadingNote} className={className} />;
  }

  return (
    <RenderBoundary
      fallback={(retry) => <LoadFailed onRetry={retry} className={className} />}
      onRetry={onRetry}
    >
      <section
        className={cn(
          'flex h-full flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-white',
          NARROW_PANEL,
          className,
        )}
      >
        {/* A comparison takes the exchange's place, its row included, until it
            is closed (A2, D186). The exchange is remounted then, on Request. */}
        {comparison !== null ? (
          <CompareView
            key={comparison.chosenItem.id}
            open={details}
            chosenItem={comparison.chosenItem}
            chosen={comparison.chosen}
            view={comparison.view}
            onViewChange={comparison.onViewChange}
            onChange={comparison.onChange}
            onClose={comparison.onClose}
            onRetry={comparison.onRetry}
          />
        ) : (
          <Tabs defaultValue="request" className="flex min-h-0 flex-1 flex-col">
            {/* Tabs with an underline indicator, in the same idiom as the strip
              below them - never a button pair and never a segmented switch. On
              a phone the two halves share the width equally, and the underline
              spans the whole half rather than running past the label (3A, E3,
              E4, D158).

              The row ends in `Actions ▾`, the menu of every per-request
              action, from 768 px up; it is outside every half, so it is there
              on both (C1-C3, D182). It sits beside the tab list rather than in
              it, since a `tablist` owns tabs only, and the row carries the
              border the two share. On a tablet the row's right padding is
              12 px, so the chevron ends where the view strip does. */}
            <div className="flex border-b border-line-tabs md:pr-3">
              <TabsList className="min-w-0 flex-1 border-y-0 max-md:gap-0 max-md:px-0 md:max-lg:px-6">
                {/* `Request` and `Response` stay English in every language (D222). */}
                <TabsTrigger value="request" className={EXCHANGE_TAB}>
                  Request
                </TabsTrigger>
                <TabsTrigger value="response" className={EXCHANGE_TAB}>
                  Response
                </TabsTrigger>
              </TabsList>
              <RequestActionsMenu
                details={details}
                sessionId={sessionId}
                accessKey={accessKey}
                receiveOrigin={receiveOrigin}
                onToast={onToast}
                onCompare={onCompare}
                signature={signature}
              />
            </div>

            <ExchangePanel value="request">
              <RequestHalf details={details} keepsNoAddress={keepsNoAddress} />
            </ExchangePanel>

            <ExchangePanel value="response">
              <ResponseHalf response={details.response} httpVersion={details.httpVersion} />
            </ExchangePanel>
          </Tabs>
        )}
      </section>
    </RenderBoundary>
  );
}

interface LoadFailedProps {
  onRetry: () => void;
  className?: string;
}

/**
 * The panel's error state: the detail request failed (D072), or the request it
 * returned could not be drawn (D169). Either way the row is still in the list,
 * and `Retry` loads the request again.
 */
function LoadFailed({ onRetry, className }: LoadFailedProps) {
  const m = useMessages();

  return (
    <Centred heading={m.detail.failed} note={m.detail.failedNote} className={className}>
      <Button variant="quiet" className="mt-4" onClick={onRetry}>
        {m.list.retry}
      </Button>
    </Centred>
  );
}

interface RenderBoundaryProps {
  /** Drawn instead of the children once they threw, given the way back. */
  fallback: (retry: () => void) => ReactNode;
  /** Loads the request again: the page's own `Retry` (D072). */
  onRetry: () => void;
  children: ReactNode;
}

interface RenderBoundaryState {
  failed: boolean;
}

/**
 * Catches an exception thrown while the selected request is rendered, and
 * draws `fallback` in its place (D169).
 *
 * A formatter defect, or a detail the panel does not expect, used to blank the
 * whole page, because React unmounts everything above an uncaught render error:
 * issue #59's deeply nested JSON did exactly that. Only rendering is caught, as
 * with every error boundary; an event handler that throws does not unmount
 * anything and is not caught here. React still reports the error to the
 * console.
 *
 * `Retry` clears the failure and loads the request again, so the same request
 * is drawn anew from a fresh copy; if it throws again, the fallback is back.
 * Nothing else clears it: a newly selected request remounts the whole panel
 * (`key={selectedId}` in `SessionPage`), and this boundary with it.
 *
 * A class, because React offers error boundaries only as class components.
 */
class RenderBoundary extends Component<RenderBoundaryProps, RenderBoundaryState> {
  override state: RenderBoundaryState = { failed: false };

  static getDerivedStateFromError(): RenderBoundaryState {
    return { failed: true };
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
    this.props.onRetry();
  };

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}

interface ExchangePanelProps {
  value: string;
  children: ReactNode;
}

/**
 * Force-mounted and hidden when inactive.
 *
 * Radix leaves a force-mounted panel visible, so the hiding is done here; the
 * point of force-mounting is that the strip inside keeps the tab the user chose
 * while the other half is on screen.
 */
function ExchangePanel({ value, children }: ExchangePanelProps) {
  return (
    <TabsContent
      value={value}
      forceMount
      className="flex min-h-0 flex-1 flex-col p-0 data-[state=inactive]:hidden"
    >
      {children}
    </TabsContent>
  );
}

function RequestHalf({
  details,
  keepsNoAddress,
}: {
  details: RequestDetails;
  keepsNoAddress: boolean;
}) {
  const m = useMessages();
  // `null` for a request captured before the path was recorded: there is no
  // backfill, so the slot is left empty rather than reconstructed and the
  // header shows the method alone (D110).
  const target = splitRequestTarget(details);

  /*
   * Memoised because the panels are force-mounted: without this, every render
   * of the page - including one caused by a realtime event about another
   * request - re-runs the JSON tokenizer over this body, up to the 256 KiB
   * ceiling, on both halves. The models depend on nothing but `details`, which
   * only changes when another request is selected or reloaded, and the
   * language, whose captions they carry (D222).
   */
  const blocks = useMemo(
    () => ({
      raw: requestRawBlock(details, m),
      body: requestBodyBlock(details, m),
      headers: requestHeadersBlock(details, m),
      query: requestQueryBlock(details, m),
    }),
    [details, m],
  );

  return (
    <>
      <DetailHeader>
        <div className="flex items-baseline gap-[10px]">
          {/* Never shrunk: beside a target long enough to fill the row, the
              flex row would otherwise squeeze the method to its narrowest
              fragment and fold `M-SEARCH` after its hyphen (D139). */}
          <span
            data-testid="detail-method"
            className="shrink-0 text-[12px] font-semibold text-method"
          >
            {details.method}
          </span>
          {target === null ? null : (
            /* One run of text in three parts with no gap between them, the
               same at every width (D173, Figma 3.2+): the session part, the
               path the sender added and the query. Plain inline flow lays it
               out; nothing is measured.

               - `/s/<id>` is text that breaks at any character (`break-all`),
                 so on a phone it fills two lines.
               - The path and the query are inline boxes no wider than the
                 line. One that fits on the rest of the current line
                 continues it, and one that does not starts the next line
                 whole: a short path is never split from the id, and a short
                 query follows a path that had to start a line. Only a part
                 longer than a whole line breaks inside itself - the path at
                 any character, clamped at three lines with `…`, the query not
                 at all, one line cut with `…`. `Raw` and `Query` show both
                 whole.
               - `overflow: clip`, not `hidden`, on both boxes: a box that
                 hides its overflow sits on the line by its bottom edge, which
                 lifts its text above the id's, while a clipping one keeps its
                 own baseline.
               - The container's own line height is zero, so each line is as
                 tall as the tallest part on it: 20 px with the id, 18 with
                 the path, 17 with the query alone, as the frames measure.

               The text is the whole target, so it reads in full to assistive
               technology; the desktop's `title` is gone with its one
               truncated line. */
            <span
              data-testid="detail-target"
              className="min-w-0 flex-1 break-all text-[15px] font-semibold leading-[0] text-ink"
            >
              <span data-testid="detail-target-session" className="leading-[20px]">
                {target.session}
              </span>
              {target.path === '' ? null : (
                <span
                  data-testid="detail-target-path"
                  className="max-w-full overflow-clip font-mono text-[13px] leading-[18px] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] [display:-webkit-inline-box]"
                >
                  {target.path}
                </span>
              )}
              {target.query === '' ? null : (
                <span
                  data-testid="detail-target-query"
                  className="inline-block max-w-full overflow-clip text-ellipsis whitespace-nowrap font-mono text-[12px] font-normal leading-[17px] text-ink-muted"
                >
                  {target.query}
                </span>
              )}
            </span>
          )}
        </div>
        {/* The sender's address is a segment of this line, in full, with no
            line of its own, no label and no country (D140, D141). The header
            is the target's lines and this one; the Response half is not
            padded to match. */}
        <p
          data-testid="request-facts"
          className="mt-2 text-[12px] text-ink-muted max-lg:leading-[17px] max-lg:wrap-break-word"
        >
          {formatRequestFacts(details, undefined, m, keepsNoAddress)}
        </p>
      </DetailHeader>

      {/* `Raw` first: the opening view is also the leftmost one (D107). The
          strip holds the four views only: `Copy as cURL` is in the request
          actions (D167, D182). */}
      <ViewTabs
        defaultValue="raw"
        triggers={
          <>
            <TabsTrigger value="raw">Raw</TabsTrigger>
            <TabsTrigger value="body">Body</TabsTrigger>
            <TabsTrigger value="headers">Headers</TabsTrigger>
            <TabsTrigger value="query">Query</TabsTrigger>
          </>
        }
      >
        <TabsContent value="raw" className={VIEW_PANEL}>
          <CodeBlock block={blocks.raw} copyLabel={m.detail.copyRawRequest} />
        </TabsContent>
        <TabsContent value="body" className={VIEW_PANEL}>
          <CodeBlock block={blocks.body} copyLabel={m.detail.copyRequestBody} />
        </TabsContent>
        <TabsContent value="headers" className={VIEW_PANEL}>
          <CodeBlock block={blocks.headers} copyLabel={m.detail.copyRequestHeaders} />
        </TabsContent>
        {/* URL and query belong to the Request half only; the Response half
            invents neither, and a redirect target is a `Location` header. */}
        <TabsContent value="query" className={VIEW_PANEL}>
          <CodeBlock block={blocks.query} copyLabel={m.detail.copyQuery} />
        </TabsContent>
      </ViewTabs>
    </>
  );
}

interface ResponseHalfProps {
  response: ResponseRecord | null;
  /** The version the request arrived on; the response was written on the same one. */
  httpVersion: string | null;
}

function ResponseHalf({ response, httpVersion }: ResponseHalfProps) {
  const m = useMessages();
  // Memoised for the same reason as the request side, and before the early
  // return below so the hook runs on every render of this component.
  const blocks = useMemo(
    () =>
      response === null
        ? null
        : {
            raw: responseRawBlock(response, m),
            body: responseBodyBlock(response, m),
            headers: responseHeadersBlock(response, m),
          },
    [response, m],
  );

  /*
   * A missing record is a reading of its own and never an empty response or an
   * invented one (D109, D119). It is what a request captured before this
   * release looks like, and what every request looks like under a backend
   * rolled back below it - which is what makes that rollback safe.
   */
  if (response === null || blocks === null) {
    return <Centred bare heading={m.record.noRecordHeading} note={m.record.noRecordNote} />;
  }

  const lines = describeResponse(response, undefined, m);

  return (
    <>
      <DetailHeader>
        <div className="flex items-baseline gap-[10px]">
          {httpVersion === null ? null : (
            <span className="text-[12px] font-semibold text-method">{`HTTP/${httpVersion}`}</span>
          )}
          {response.status === null || lines.statusLabel === null ? null : (
            <ResponseStatus status={response.status} lines={lines} />
          )}
        </div>
        <p
          data-testid="response-state"
          className="mt-2 text-[12px] text-ink-muted max-lg:wrap-break-word"
        >
          {lines.queueStep === null && lines.rule === null ? (
            lines.stateLine
          ) : (
            // The step of the response queue that answered, or the response
            // rule, as a tag inside the line, before its time (U7, M5, D205;
            // R8, RP4, D246). A rule's path may be 1 KiB long: the tag wraps
            // anywhere rather than push the panel sideways.
            <>
              {lines.stateParts.lead}
              {' · '}
              <span
                data-testid={lines.queueStep === null ? 'response-rule' : 'response-queue-step'}
                className="inline-block max-w-full rounded-[4px] bg-panel-note px-1.5 py-0.5 align-baseline text-[11px] font-medium leading-[13px] text-ink-id wrap-anywhere"
              >
                {lines.queueStep ?? lines.rule}
              </span>
              {lines.stateParts.time === null ? null : ` · ${lines.stateParts.time}`}
            </>
          )}
        </p>
        {/* What the state means, where it needs saying (D113). A normally
            finished write has no third line: `Sent by server` already states
            the observation boundary, and the sentence that repeated it on
            nearly every response said nothing (D158). */}
        {lines.note === null ? null : (
          <p data-testid="response-note" className="mt-1 text-[12px] text-ink-muted">
            {lines.note}
          </p>
        )}
      </DetailHeader>

      {/* No `Query`, and the first switch into this half lands on `Body`. */}
      <ViewTabs
        defaultValue="body"
        triggers={
          <>
            <TabsTrigger value="raw">Raw</TabsTrigger>
            <TabsTrigger value="body">Body</TabsTrigger>
            <TabsTrigger value="headers">Headers</TabsTrigger>
          </>
        }
      >
        <TabsContent value="raw" className={VIEW_PANEL}>
          <CodeBlock block={blocks.raw} copyLabel={m.detail.copyRawResponse} />
        </TabsContent>
        <TabsContent value="body" className={VIEW_PANEL}>
          <CodeBlock block={blocks.body} copyLabel={m.detail.copyResponseBody} />
        </TabsContent>
        <TabsContent value="headers" className={VIEW_PANEL}>
          <CodeBlock block={blocks.headers} copyLabel={m.detail.copyResponseHeaders} />
        </TabsContent>
      </ViewTabs>
    </>
  );
}

/**
 * The status in the Response half's heading (D207). An answer the session
 * gave is its code in the pill of its class, with the reason phrase beside it
 * in ink, which wraps beside the pill on a narrow phone; a code with no phrase
 * is the pill alone. Any other state keeps the label as it was before the pill:
 * ink, or red for a pending or failed write of a 4xx or 5xx.
 */
function ResponseStatus({ status, lines }: { status: number; lines: ResponseHeaderLines }) {
  if (lines.statusTone !== 'answered') {
    return (
      <span
        data-testid="response-status"
        className={cn(
          'text-[15px] font-semibold',
          lines.statusTone === 'failure' ? 'text-danger' : 'text-ink',
        )}
      >
        {lines.statusLabel}
      </span>
    );
  }

  // The space keeps the text `500 Internal Server Error` whole in
  // `textContent`, which the tests and the accessibility tree read; a flex
  // container does not render it, so a browser copy may split the two across
  // lines. The flex gap draws the 8 px between them.
  return (
    <span data-testid="response-status" className="flex min-w-0 items-baseline gap-2">
      <span className={statusPillClassName(status, 'heading')}>{status}</span>
      {lines.reasonPhrase === null ? null : (
        <>
          {' '}
          <span className="min-w-0 text-[15px] font-semibold text-ink wrap-break-word">
            {lines.reasonPhrase}
          </span>
        </>
      )}
    </span>
  );
}

interface ViewTabsProps {
  /** The view a half opens on (D107). */
  defaultValue: string;
  triggers: ReactNode;
  children: ReactNode;
}

/**
 * A half's `Raw` / `Body` / `Headers` / `Query` strip and the area under it.
 *
 * **The area is the one scroll in the panel, and it scrolls down only (D149).**
 * The code box inside it never scrolls and every line in it wraps, so nothing
 * here is wider than the area. The request header, the exchange strip and this
 * strip sit outside it and stay where they are while it scrolls.
 *
 * Choosing another view starts it at its top. The views share this one area,
 * so without that a view opened after scrolling far down a long body would
 * open somewhere in its middle.
 */
function ViewTabs({ defaultValue, triggers, children }: ViewTabsProps) {
  const area = useRef<HTMLDivElement>(null);

  return (
    <Tabs
      defaultValue={defaultValue}
      className="flex min-h-0 flex-1 flex-col"
      onValueChange={() => area.current?.scrollTo({ top: 0 })}
    >
      <TabsList className="max-md:px-4 md:max-lg:px-6">{triggers}</TabsList>

      {/* Named for the browser suite, which measures that this is the only
          element in the panel that scrolls, and never sideways (D149). */}
      <div ref={area} data-testid="tab-area" className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </Tabs>
  );
}

function DetailHeader({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-line-tabs px-5 py-4 max-md:px-4 max-md:py-3.5 md:max-lg:px-6">
      {children}
    </div>
  );
}

interface CentredProps {
  heading: string;
  note: string;
  /** Rendered inside an existing panel rather than as the whole panel. */
  bare?: boolean;
  className?: string;
  children?: ReactNode;
}

function Centred({ heading, note, bare, className, children }: CentredProps) {
  const body = (
    <div className="flex flex-col items-center px-8 text-center">
      <p className="text-[15px] font-semibold text-ink">{heading}</p>
      <p className="mt-2 text-[13px] text-ink-muted">{note}</p>
      {children}
    </div>
  );

  if (bare) {
    return <div className="flex min-h-0 flex-1 items-center justify-center">{body}</div>;
  }

  return (
    <section
      className={cn(
        'flex h-full flex-1 items-center justify-center rounded-[10px] border border-line bg-white',
        NARROW_PANEL,
        className,
      )}
    >
      {body}
    </section>
  );
}
