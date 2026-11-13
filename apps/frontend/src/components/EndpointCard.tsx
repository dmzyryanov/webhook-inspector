import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LockKeyhole } from 'lucide-react';
import { useRef, useState } from 'react';
import type { SessionResponseState } from '@webhook-inspector/shared';
import { useClipboardCopy } from '../hooks/useClipboardCopy.ts';
import { useDesktopLayout, usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import type { Messages, Phrase } from '../i18n/en.ts';
import { cn } from '../lib/cn.ts';
import { RECEIVE_URL_TAIL, splitForMiddleEllipsis } from '../lib/format.ts';
import { buildAccessLink } from '../lib/request-link.ts';
import type { QuickCarry } from '../lib/quick-switch.ts';
import {
  sessionAddressMarker,
  sessionExpiryLine,
  type SessionRuleFields,
} from '../lib/session-lifetime.ts';
import { formatQueueRestartedToast, formatQueueSavedToast } from '../lib/response-queue.ts';
import { formatRulesSavedToast } from '../lib/response-rules.ts';
import { formatAppliedToast, type OwnAnswerTaker } from '../lib/session-response.ts';
import { ResponseQueueDialog } from './ResponseQueueDialog.tsx';
import { ResponseRulesDialog } from './ResponseRulesDialog.tsx';
import { SessionResponseEditor } from './SessionResponseEditor.tsx';
import { SessionResponseSwitch } from './SessionResponseSwitch.tsx';
import type { ToastIcon } from './Toast.tsx';
import { Button } from './ui/button.tsx';

interface EndpointCardProps {
  sessionId: string;
  url: string;
  /**
   * A private session's key (D259): the line ends `· 🔒 PRIVATE` and Copy
   * becomes `Copy ▾`, whose menu holds `Copy link with access`. `null` for a
   * public session, whose card is unchanged.
   */
  accessKey: string | null;
  /** What the session answers, and the custom response it keeps (D151). */
  state: SessionResponseState;
  /**
   * The rule the session follows and whether it keeps the sender's address,
   * as the session read gave them (D242, D243): the line states them (D249).
   */
  rule: SessionRuleFields;
  /** The page's response revision, read as a call starts (D152, D205). */
  responseRevision: () => number;
  /** Whether the queue was started from step 1 since that revision (D205). */
  queueStartedSince: (startedAt: number) => boolean;
  /**
   * A change this viewer saved: the state the answer carries and the
   * revision its call started at; the page takes it unless something newer
   * has arrived since, and answers the response state it then shows.
   */
  onStateChange: OwnAnswerTaker;
  /** A change found the session gone: the page moves to `Session not found`. */
  onSessionUnavailable: () => void;
  /** Shows the page's toast, replacing any on screen (D150, D182). */
  onToast: (text: Phrase, icon?: ToastIcon) => void;
  /** Takes the page's toast away. */
  onDismissToast: () => void;
  className?: string;
}

/**
 * The receive URL, Copy and the response button. On the desktop they share one
 * 36 px row. Below 1024 px they are 44 px touch targets: in one row on a tablet
 * (frame 7B of the Figma page `Webhook Inspector · Tablet and phone`), and on a
 * phone the response button takes a full-width row of its own under the URL
 * and Copy (frame 2A of the same page). Below 1024 px the URL is shortened in
 * the middle when it does not fit, so that the end of the session id stays
 * readable; Copy always copies the whole URL (D157).
 */
export function EndpointCard({
  sessionId,
  url,
  accessKey,
  state,
  rule,
  responseRevision,
  queueStartedSince,
  onStateChange,
  onSessionUnavailable,
  onToast,
  onDismissToast,
  className,
}: EndpointCardProps) {
  const m = useMessages();
  const desktop = useDesktopLayout();
  const addressMarker = sessionAddressMarker(rule, m);
  const [copied, setCopied] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [carry, setCarry] = useState<QuickCarry | undefined>(undefined);
  const responseButton = useRef<HTMLButtonElement | null>(null);

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  // 12 px above and below at every width; 8 px from the caption to the URL row
  // and, on a phone, from that row to the response button. The sides keep
  // 18 px, 14 on a phone (issue #96, direction B).
  return (
    <div
      className={cn(
        'w-full rounded-[10px] border border-line bg-white px-[18px] py-3 max-md:px-3.5',
        className,
      )}
    >
      {/* On a phone the retention line sits under the label, the two lines
          set close as the frames draw them: both do not fit on one line at
          320 px (frames E2 and E5 of the Figma page `Webhook Inspector ·
          Polish and API docs link`, D158). A tablet keeps them on one line
          (frame F2 of that page). A session that keeps no address adds
          `IP NOT STORED`: after the line and a `·` from 768 px, on a line of
          its own below (D249). */}
      <div className="flex items-center justify-between max-md:flex-col max-md:items-start max-md:leading-[normal]">
        <p className="text-[10px] font-semibold tracking-[0.04em] text-ink-muted">
          {m.endpoint.receiveUrl}
        </p>
        {/*
          The rule, stated once, where the countdown used to tick. Same slot,
          same metadata style, no timer and no state: the session's expiry moves
          on every use, so there is nothing here for the client to count down to
          and nothing for it to decide (D133). The session's own rule: its
          window, or the fixed end of a session created with a lifetime, in
          the viewer's time (D249).
        */}
        <p className="text-[10px] font-semibold uppercase tracking-[0.04em] text-ink-muted">
          {sessionExpiryLine(rule, m)}
          {/* A private session ends the line with `🔒 PRIVATE` in ink (frame
              R4 of the Figma page `Webhook Inspector · Private sessions
              (#228)`, D259): after `IP NOT STORED` on its line below 768 px,
              or on a line of its own there when the address is stored. */}
          {addressMarker === null && accessKey === null ? null : (
            <>
              <span className="max-md:hidden"> · </span>
              <span className="max-md:block">
                {addressMarker}
                {addressMarker !== null && accessKey !== null ? ' · ' : null}
                {accessKey === null ? null : <PrivateMarker m={m} />}
              </span>
            </>
          )}
        </p>
      </div>
      {/*
        The field, Copy and the response button share one 36 px height, as the
        design draws them (issue #36). Each states its height and a line height
        that fits inside it, rather than inheriting the page's 1.5 and padding
        up to it: that is how Copy came to 39.5 px and the field to 41.5 px. The
        fix is local on purpose - the shared Button keeps its height everywhere
        else, where no frame asked for a change (D150).
      */}
      <div className="mt-2 flex items-center gap-3 max-md:flex-wrap max-md:gap-2">
        {/* The browser smoke suite reads the URL from here. The field is a bare
            paragraph whose caption is a sibling, so it carries no role or label
            a test could use instead (D108). */}
        <p
          data-testid="receive-url"
          className="h-9 flex-1 truncate rounded-[7px] border border-line-soft bg-field px-3 text-[13px] font-medium leading-[34px] text-ink-strong max-lg:flex max-lg:h-11 max-lg:min-w-0 max-lg:leading-[42px]"
        >
          {desktop ? url : <MiddleEllipsis text={url} />}
        </p>
        {/*
          Both controls keep their own width, so the URL - the only element
          that may be arbitrarily long - is the one that truncates.
        */}
        {accessKey === null ? (
          <Button
            className="h-9 shrink-0 py-0 leading-[18px] max-lg:h-11"
            onClick={() => void copy()}
          >
            {copied ? m.copy.copied : m.copy.copy}
          </Button>
        ) : (
          <CopySplitButton
            label={copied ? m.copy.copied : m.copy.copy}
            onCopyUrl={() => void copy()}
            link={() => buildAccessLink(window.location.origin, sessionId, accessKey)}
            onToast={onToast}
            onDismissToast={onDismissToast}
          />
        )}
        <SessionResponseSwitch
          sessionId={sessionId}
          state={state}
          open={switchOpen}
          onOpenChange={setSwitchOpen}
          triggerRef={responseButton}
          responseRevision={responseRevision}
          queueStartedSince={queueStartedSince}
          onApplied={(next, startedAt) => {
            onStateChange(next, startedAt);
            setSwitchOpen(false);
            onToast((words) => formatAppliedToast(next.response, words));
          }}
          onUnavailable={onSessionUnavailable}
          onOpenEditor={(carried) => {
            setCarry(carried);
            setSwitchOpen(false);
            // A toast still showing from an earlier change would sit over the
            // editor's actions, which are at the bottom of the window too.
            onDismissToast();
            setEditorOpen(true);
          }}
          onOpenQueue={() => {
            setSwitchOpen(false);
            onDismissToast();
            setQueueOpen(true);
          }}
          onQueueRestarted={(next, startedAt) => {
            // Worded from the answer, or from what the page shows once it
            // holds the restart's own event: a capture may already have taken
            // a step of the queue started again, which the answer does not show.
            const described = onStateChange(next, startedAt);

            setSwitchOpen(false);
            onToast((words) => formatQueueRestartedToast(described, words));
          }}
          onQueueRemoved={(next, startedAt) => {
            // The quick switch stays open, its section showing no queue, and
            // the label drops `· N queued`: no toast, which on a phone would
            // sit over the sheet (D206).
            onStateChange(next, startedAt);
          }}
          onOpenRules={() => {
            setSwitchOpen(false);
            onDismissToast();
            setRulesOpen(true);
          }}
          onRulesRemoved={(next, startedAt) => {
            // As after the section's `Remove queue`: the quick switch stays
            // open, its section showing no rules, and no toast.
            onStateChange(next, startedAt);
          }}
        />
      </div>

      <SessionResponseEditor
        sessionId={sessionId}
        state={state}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        carry={carry}
        returnFocusRef={responseButton}
        responseRevision={responseRevision}
        onSaved={(next, startedAt) => {
          onStateChange(next, startedAt);
          setEditorOpen(false);
          onToast((words) => words.response.saved);
        }}
        onUnavailable={onSessionUnavailable}
      />

      <ResponseQueueDialog
        sessionId={sessionId}
        state={state}
        open={queueOpen}
        onOpenChange={setQueueOpen}
        returnFocusRef={responseButton}
        responseRevision={responseRevision}
        onSaved={(next, startedAt) => {
          // Worded from the answer, or from what the page shows once it holds
          // the save's own event: a capture may already have taken a step of
          // the queue saved, which the answer does not show.
          const described = onStateChange(next, startedAt);

          setQueueOpen(false);
          onToast((words) => formatQueueSavedToast(described, words));
        }}
        onRemoved={(next, startedAt) => {
          onStateChange(next, startedAt);
          setQueueOpen(false);
          onToast((words) => words.queue.removed);
        }}
        onUnavailable={onSessionUnavailable}
      />

      <ResponseRulesDialog
        sessionId={sessionId}
        state={state}
        open={rulesOpen}
        onOpenChange={setRulesOpen}
        returnFocusRef={responseButton}
        responseRevision={responseRevision}
        onSaved={(next, startedAt) => {
          // Worded from the answer, or from what the page shows once it
          // holds the save's own event (`ownChangeState`).
          const described = onStateChange(next, startedAt);

          setRulesOpen(false);
          onToast((words) => formatRulesSavedToast(described, words));
        }}
        onRemoved={(next, startedAt) => {
          onStateChange(next, startedAt);
          setRulesOpen(false);
          onToast((words) => words.rules.removed);
        }}
        onUnavailable={onSessionUnavailable}
      />
    </div>
  );
}

/**
 * `🔒 PRIVATE` at the end of the card's line (frame R4 of the Figma page
 * `Webhook Inspector · Private sessions (#228)`, D259): the lock, named
 * `Private session`, and the word, both in ink where the rest is muted, as
 * `IP NOT STORED` states the address.
 */
function PrivateMarker({ m }: { m: Messages }) {
  return (
    <span className="inline-flex items-center gap-[3px] align-bottom text-ink">
      <span role="img" aria-label={m.access.mark} className="inline-flex">
        <LockKeyhole aria-hidden="true" className="size-[11px]" strokeWidth={2.25} />
      </span>
      {m.lifetime.private}
    </span>
  );
}

interface CopySplitButtonProps {
  /** The main part's words: `Copy`, then `Copied` while the copy holds. */
  label: string;
  /** Copies the receive URL, as the plain `Copy` does. */
  onCopyUrl: () => void;
  /** The link with access, built when chosen. */
  link: () => string;
  onToast: (text: Phrase, icon?: ToastIcon) => void;
  onDismissToast: () => void;
}

/**
 * A private session's Copy (frame R4 of the Figma page `Webhook Inspector ·
 * Private sessions (#228)`, D259): a split button at every width. The main
 * part copies the receive URL, as the plain `Copy` does; `▾` opens `Copy
 * receive URL` - for the sender - and `Copy link with access` - for a
 * colleague - each with its hint: from 768 px a menu right-aligned under the
 * button in the style of the options menu, below it a bottom sheet in the
 * style of the request actions' (#71). The link is confirmed by the page's
 * toast once the write has settled, `Link with access copied` under the lock,
 * or the refusal under the info icon (D182); the key is never shown.
 */
function CopySplitButton({
  label,
  onCopyUrl,
  link,
  onToast,
  onDismissToast,
}: CopySplitButtonProps) {
  const m = useMessages();
  const phone = usePhoneLayout();
  const { copy } = useClipboardCopy();

  function copyLink(): void {
    void copy(link()).then((outcome) => {
      if (outcome === 'copied') {
        onToast((words) => words.access.linkCopied, 'lock');
      } else {
        onToast((words) => words.actions.linkRefused, 'info');
      }
    });
  }

  const chevron = cn(
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-r-[7px] bg-brand text-white transition-colors hover:bg-brand/90 max-lg:h-11 max-lg:w-11',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-[state=open]:bg-brand/90',
  );

  return (
    <div className="flex shrink-0 items-stretch">
      <Button
        className="h-9 shrink-0 rounded-r-none py-0 leading-[18px] max-lg:h-11"
        onClick={onCopyUrl}
      >
        {label}
      </Button>
      <span aria-hidden="true" className="w-px self-stretch bg-brand">
        <span className="mt-2.5 block h-4 w-px bg-white/35 max-lg:mt-3.5" />
      </span>
      {phone ? (
        <CopySheet
          triggerClassName={chevron}
          onCopyUrl={onCopyUrl}
          onCopyLink={copyLink}
          onOpen={onDismissToast}
        />
      ) : (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger aria-label={m.access.copyMenu} className={chevron}>
            <ChevronDown aria-hidden="true" className="size-4" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              collisionPadding={8}
              className="z-40 w-[268px] rounded-[8px] border border-line bg-white py-1.5 shadow-[0_12px_32px_rgba(31,36,46,0.16)]"
            >
              <DropdownMenu.Item onSelect={onCopyUrl} className={COPY_MENU_ITEM}>
                <span className="text-[13px] leading-[18px] text-ink">
                  {m.access.copyReceiveUrl}
                </span>
                <span className="text-[12px] leading-[17px] text-ink-muted">
                  {m.access.copyReceiveUrlHint}
                </span>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={copyLink} className={COPY_MENU_ITEM}>
                <span className="flex items-center gap-1.5 text-[13px] leading-[18px] text-ink">
                  <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0" />
                  {m.access.copyLink}
                </span>
                <span className="text-[12px] leading-[17px] text-ink-muted">
                  {m.access.copyLinkHint}
                </span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}

const COPY_MENU_ITEM =
  'flex cursor-default select-none flex-col gap-0.5 px-3.5 py-2 outline-none data-[highlighted]:bg-field';

interface CopySheetProps {
  triggerClassName: string;
  onCopyUrl: () => void;
  onCopyLink: () => void;
  /** The sheet opens: a toast still showing would sit over its last row. */
  onOpen: () => void;
}

/**
 * `▾` below 768 px: a bottom sheet in the style of #71's actions sheet, over
 * a scrim, its title `Copy options`, the same two items and hints in 48 px
 * rows at 15 px. A tap on the scrim, Escape or a choice closes it, and focus
 * returns to `▾`.
 */
function CopySheet({ triggerClassName, onCopyUrl, onCopyLink, onOpen }: CopySheetProps) {
  const m = useMessages();
  const [open, setOpen] = useState(false);

  function choose(run: () => void): void {
    setOpen(false);
    run();
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpen();
        }

        setOpen(next);
      }}
    >
      <DialogPrimitive.Trigger aria-label={m.access.copyMenu} className={triggerClassName}>
        <ChevronDown aria-hidden="true" className="size-4" />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain rounded-t-2xl bg-white px-2 pb-6 pt-2"
        >
          <div aria-hidden="true" className="flex justify-center pb-2 pt-1">
            <span className="h-1 w-9 rounded-[2px] bg-line" />
          </div>
          <DialogPrimitive.Title className="pb-1 pl-3 text-[13px] font-semibold leading-4 text-ink-muted">
            {m.access.copyMenu}
          </DialogPrimitive.Title>
          <button type="button" onClick={() => choose(onCopyUrl)} className={COPY_SHEET_ITEM}>
            <span className="text-[15px] leading-[20px] text-ink">{m.access.copyReceiveUrl}</span>
            <span className="text-[13px] leading-[18px] text-ink-muted">
              {m.access.copyReceiveUrlHint}
            </span>
          </button>
          <button type="button" onClick={() => choose(onCopyLink)} className={COPY_SHEET_ITEM}>
            <span className="flex items-center gap-2 text-[15px] leading-[20px] text-ink">
              <LockKeyhole aria-hidden="true" className="size-4 shrink-0" />
              {m.access.copyLink}
            </span>
            <span className="text-[13px] leading-[18px] text-ink-muted">
              {m.access.copyLinkHint}
            </span>
          </button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const COPY_SHEET_ITEM =
  'flex min-h-12 w-full flex-col items-start justify-center gap-0.5 rounded-[6px] px-3 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent active:bg-row-selected';

/**
 * The URL cut in the middle when it does not fit: the start truncates with an
 * ellipsis and the last characters of the session id always show, as
 * `https://hook.qa-tools.ru/s/G4t…mQxA`. Pure CSS at any width, so it follows a
 * rotation with no measuring; where the URL fits, the two halves read as one.
 * Its text is the whole URL, which is what a selection and the smoke suite
 * read (D157).
 */
function MiddleEllipsis({ text }: { text: string }) {
  const { head, tail } = splitForMiddleEllipsis(text, RECEIVE_URL_TAIL);

  return (
    <>
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0">{tail}</span>
    </>
  );
}
