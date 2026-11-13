import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import {
  ChevronDown,
  Download,
  Ellipsis,
  GitCompareArrows,
  Link,
  ShieldCheck,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useId, useRef, useState, type ComponentProps } from 'react';
import type { RequestDetails } from '@webhook-inspector/shared';
import { useClipboardCopy } from '../hooks/useClipboardCopy.ts';
import { useDesktopLayout, usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import type { Phrase } from '../i18n/en.ts';
import { buildCurlCommand } from '../lib/curl-command.ts';
import { downloadRequestJson } from '../lib/request-download.ts';
import { buildAccessLink, buildRequestLink } from '../lib/request-link.ts';
import { isLanguageSwitch } from './LanguageSwitch.tsx';
import { SignatureCheckForm, type SignatureMemoryRef } from './SignatureCheck.tsx';
import type { ToastIcon } from './Toast.tsx';

/** Shows a toast, replacing the one on screen (D182). */
export type ShowToast = (text: Phrase, icon: ToastIcon) => void;

/** One entry of the menu and of the sheet. */
interface RequestAction {
  label: string;
  icon: LucideIcon;
  /** Runs as the menu or the sheet it was chosen from closes. */
  run: () => void;
  /**
   * The phone's sheet stays open and shows what the action opens in its
   * place, rather than closing: `Check signature…` (D197).
   */
  keepsSheetOpen?: boolean;
}

/*
 * What the request actions confirm, once the clipboard write has settled
 * (D182), is the dictionary's `actions`: a refusal says what was not copied,
 * under the info icon, and is never worded as a success. `actions.title` names
 * the phone's `⋯` and the sheet it opens; `actions.compare` is the item that
 * starts picking a request to compare with (#75, D186).
 */

interface RequestActionsProps {
  details: RequestDetails;
  /** The page's session: the link's, and the path of a request stored without one (D167). */
  sessionId: string;
  /**
   * The key of a private session, which `Copy link` then puts in its link,
   * confirmed by `Link with access copied` (D259); `null` or absent for a
   * public session, whose link is D182's.
   */
  accessKey?: string | null;
  /**
   * The origin of the session's receive URL, `https://hook.qa-tools.ru` in
   * production: `Copy as cURL` re-captures there, while `Copy link` stays on
   * the page's own origin (D187).
   */
  receiveOrigin: string;
  onToast: ShowToast;
  /**
   * Starts picking another request of the session to compare the open one
   * with (#75, D186). Without it the item is not offered.
   */
  onCompare?: () => void;
  /**
   * What `Check signature…` remembers between openings, the page's for as
   * long as it is open (#74, D197). Without it the item is not offered.
   */
  signature?: SignatureMemoryRef;
}

/**
 * Every per-request action, in groups; a divider goes between two groups.
 * #71's two copies are the first group. The second, after a divider, starts
 * with #73's `Download JSON` (D185), followed by #74's `Check signature…`
 * (D197) and #75's `Compare with…` (D186), in both the menu and the sheet
 * (Figma `Webhook Inspector · Request actions`, C2, C5, where the last was
 * drawn as `Compare with previous`).
 *
 * Each copy writes through `useClipboardCopy`, like a code box's icon, and
 * confirms with the page's toast only after the write has settled: the menu
 * or the sheet it was chosen from is closed by then (D182). `Download JSON`
 * shows no toast: the browser shows the download, and the page cannot know
 * the file was saved (D185).
 */
function useRequestActions({
  details,
  sessionId,
  accessKey = null,
  receiveOrigin,
  onToast,
  onCompare,
  onCheckSignature,
}: Omit<RequestActionsProps, 'signature'> & {
  /** Opens the check; without it the item is not offered. */
  onCheckSignature?: () => void;
}): RequestAction[][] {
  const m = useMessages();
  const { copy } = useClipboardCopy();

  function copyWithToast(
    text: string,
    copied: Phrase,
    refused: Phrase,
    icon: ToastIcon = 'check',
  ): void {
    void copy(text).then((outcome) => {
      if (outcome === 'copied') {
        onToast(copied, icon);
      } else {
        onToast(refused, 'info');
      }
    });
  }

  const origin = window.location.origin;

  return [
    [
      {
        label: m.actions.copyLink,
        icon: Link,
        // In a private session the label stays and the link carries the key
        // (#228's Decision 8).
        run: () =>
          accessKey === null
            ? copyWithToast(
                buildRequestLink(origin, sessionId, details.id),
                (words) => words.actions.linkCopied,
                (words) => words.actions.linkRefused,
              )
            : copyWithToast(
                buildAccessLink(origin, sessionId, accessKey, details.id),
                (words) => words.access.linkCopied,
                (words) => words.actions.linkRefused,
                'lock',
              ),
      },
      {
        label: m.actions.copyCurl,
        icon: Terminal,
        // Built when chosen, from the detail the panel holds: a 1 MB body is
        // not turned into a command on every render (D167).
        run: () =>
          copyWithToast(
            buildCurlCommand(details, { origin: receiveOrigin, sessionId }),
            (words) => words.actions.curlCopied,
            (words) => words.actions.curlRefused,
          ),
      },
    ],
    [
      {
        label: m.actions.downloadJson,
        icon: Download,
        // The details the panel holds when chosen, refreshed after a delayed
        // response is recorded (D125), exactly as the API returned them (D185).
        run: () => downloadRequestJson(details),
      },
      ...(onCheckSignature === undefined
        ? []
        : [
            {
              label: m.actions.checkSignature,
              icon: ShieldCheck,
              run: onCheckSignature,
              keepsSheetOpen: true,
            },
          ]),
      ...(onCompare === undefined
        ? []
        : [{ label: m.actions.compare, icon: GitCompareArrows, run: onCompare }]),
    ],
  ];
}

/**
 * `Actions ▾` at the end of the `Request` · `Response` row, on both halves,
 * from 768 px up (frames C1-C3 of the Figma page `Webhook Inspector · Request
 * actions`, D182): link-coloured, Inter Medium 13 with a chevron, ending 20 px
 * from the panel's edge on the desktop; 14 px with a target of the row's full
 * height below 1024 px, ending where the view strip's padding does. On a phone
 * the Back bar's `⋯` takes its place.
 *
 * A WAI-ARIA menu button, from Radix: Enter, Space or Down open it on its
 * first item, the arrows move, Enter chooses, and Escape - or a choice -
 * closes it with focus back on `Actions`. The menu opens under the trigger,
 * its right edge on the chevron's end and 8 px below it: 232 px wide, rows
 * 36 px at 13 px on the desktop, and 44 px at 14 px below 1024 px.
 */
export function RequestActionsMenu({ signature, ...props }: RequestActionsProps) {
  const m = useMessages();
  const [checking, setChecking] = useState(false);
  // Set by choosing `Check signature…`. The popover opens once the menu has
  // closed, in its place, and the menu does not take focus back to `Actions`
  // then: the popover's field takes it. Opened while the modal menu was still
  // up, the field could not take focus.
  const handingOver = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const groups = useRequestActions({
    ...props,
    onCheckSignature:
      signature === undefined
        ? undefined
        : () => {
            handingOver.current = true;
          },
  });
  const phone = usePhoneLayout();
  const desktop = useDesktopLayout();

  if (phone) {
    return null;
  }

  return (
    <Popover.Root open={checking} onOpenChange={setChecking}>
      <DropdownMenu.Root>
        {/* The popover hangs from `Actions` too, in the menu's place (frame B1
            of the Figma page `Webhook Inspector · Check signature`). */}
        <Popover.Anchor asChild>
          <DropdownMenu.Trigger
            ref={trigger}
            className={
              // The row's text line on the desktop, with 8 px either side that
              // only keep the focus ring off the label; the row's full height
              // with 12 px either side below 1024 px.
              '-mb-px flex shrink-0 items-center gap-1.5 self-stretch rounded-[4px] px-2 ' +
              'text-[13px] font-medium text-link hover:underline ' +
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ' +
              'max-lg:px-3 max-lg:text-[14px]'
            }
          >
            {m.actions.menu}
            <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
          </DropdownMenu.Trigger>
        </Popover.Anchor>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={MENU_SIDE_OFFSET}
            alignOffset={desktop ? MENU_ALIGN_OFFSET_DESKTOP : MENU_ALIGN_OFFSET_TABLET}
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              if (handingOver.current) {
                handingOver.current = false;
                event.preventDefault();
                setChecking(true);
              }
            }}
            className="z-40 w-[232px] rounded-[8px] border border-line bg-white p-1.5 shadow-[0_12px_32px_rgba(31,36,46,0.16)]"
          >
            {groups.map((group, index) => (
              <Fragment key={group.map((action) => action.label).join()}>
                {index > 0 ? <DropdownMenu.Separator className="my-1 h-px bg-line" /> : null}
                {group.map((action) => (
                  <DropdownMenu.Item
                    key={action.label}
                    onSelect={action.run}
                    className="flex h-9 cursor-default select-none items-center gap-3 rounded-[6px] px-2.5 text-[13px] text-ink outline-none data-[highlighted]:bg-row-selected max-lg:h-11 max-lg:text-[14px]"
                  >
                    <action.icon aria-hidden="true" className="size-4 shrink-0 text-menu-icon" />
                    {action.label}
                  </DropdownMenu.Item>
                ))}
              </Fragment>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {signature === undefined ? null : (
        <SignaturePopover
          details={props.details}
          signature={signature}
          desktop={desktop}
          onClosed={() => {
            // Escape, `×` or a click outside closes it, and focus returns to
            // `Actions` - unless the click put it on another control, a field
            // or a row, which keeps it.
            const focused = document.activeElement;

            if (focused === null || !focused.matches(KEEPS_FOCUS)) {
              trigger.current?.focus();
            }
          }}
        />
      )}
    </Popover.Root>
  );
}

interface SignaturePopoverProps {
  details: RequestDetails;
  signature: SignatureMemoryRef;
  desktop: boolean;
  /** Called once it has closed, to place focus. */
  onClosed: () => void;
}

/**
 * `Check signature…` from 768 px up (frames B1, B2 and B4 of the Figma page
 * `Webhook Inspector · Check signature`, D197): a 400 px popover under
 * `Actions`, 4 px below the row, its right edge 4 px inside the trigger's on
 * the desktop and on the chevron's end on a tablet - where its controls are
 * 44 px and its `×` a 44 × 44 target. Non-modal: the page stays live, and a
 * click outside - on another request, say - closes it as Escape and `×` do.
 * It is never taller than the room under `Actions`, and scrolls inside.
 */
function SignaturePopover({ details, signature, desktop, onClosed }: SignaturePopoverProps) {
  const m = useMessages();
  const titleId = useId();

  return (
    <Popover.Portal>
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={POPOVER_SIDE_OFFSET}
        alignOffset={desktop ? POPOVER_ALIGN_OFFSET_DESKTOP : POPOVER_ALIGN_OFFSET_TABLET}
        collisionPadding={8}
        aria-labelledby={titleId}
        // The form takes focus itself: the secret while it is empty, else
        // the header.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Changing the language changes the words, not what is open (D222).
        onInteractOutside={(event) => {
          if (isLanguageSwitch(event.target)) {
            event.preventDefault();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
        className="z-40 max-h-[var(--radix-popover-content-available-height)] w-[400px] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-[8px] border border-line bg-white px-4 pb-4 pt-3.5 shadow-[0_12px_32px_rgba(31,36,46,0.16)]"
      >
        <div className="mb-3.5 flex h-6 items-center justify-between gap-2 max-lg:h-11">
          <h2 id={titleId} className="text-[15px] font-semibold leading-[21px] text-ink">
            {m.signature.title}
          </h2>
          <Popover.Close
            aria-label={m.common.close}
            className="flex size-6 shrink-0 items-center justify-center rounded-[5px] text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-lg:size-11"
          >
            <X aria-hidden="true" className="size-4" />
          </Popover.Close>
        </div>
        <SignatureCheckForm details={details} memory={signature} />
      </Popover.Content>
    </Popover.Portal>
  );
}

/**
 * What a click outside the popover may have focused and keeps, rather than
 * handing focus back to `Actions`: a control, or a menu or dialog it opened.
 * A panel's text, which a tab panel makes focusable, is not one.
 */
const KEEPS_FOCUS = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  ...[
    'button',
    'link',
    'tab',
    'menu',
    'menuitem',
    'dialog',
    'option',
    'checkbox',
    'radio',
    'switch',
    'textbox',
    'searchbox',
    'combobox',
  ].map((role) => `[role="${role}"]`),
].join(', ');

/**
 * Where the popover sits against the trigger's box, which is the row's full
 * height with 8 px (desktop) or 12 px (tablet) of padding beside the label:
 * 4 px under the row, and its right edge 4 px inside the box on the desktop
 * (frame B1 of the Figma page `Webhook Inspector · Check signature`: 16 px from
 * the panel's edge) and on the chevron's end on a tablet (frame B4: 24 px from
 * the screen's).
 */
const POPOVER_SIDE_OFFSET = 4;
const POPOVER_ALIGN_OFFSET_DESKTOP = 4;
const POPOVER_ALIGN_OFFSET_TABLET = 12;

/**
 * Where the menu sits against the trigger's box, which is the row's full
 * height with the label centred in it and 8 px (desktop) or 12 px (tablet) of
 * padding beside it. The menu starts 8 px under the label - its 16 px chevron
 * - so above the box's bottom edge, and its right edge is on the chevron's end,
 * not on the padding's (the layer `Menu / Actions` of frame C2 of the Figma
 * page `Webhook Inspector · Request actions`, 8 px under `Actions ▾` with the
 * right edges on one line). The tablet has no frame of the open menu and
 * follows the same two rules.
 */
const MENU_SIDE_OFFSET = -6;
const MENU_ALIGN_OFFSET_DESKTOP = 8;
const MENU_ALIGN_OFFSET_TABLET = 12;

interface RequestActionsSheetProps extends Omit<RequestActionsProps, 'details'> {
  /** `null` while the request loads or failed to: `⋯` is there, and disabled. */
  details: RequestDetails | null;
  /**
   * Takes the page's toast away. A phone's toast sits at the bottom of the
   * screen, over the sheet's last row, so the sheet removes one still showing
   * from an earlier copy when it opens.
   */
  onDismissToast: () => void;
}

/**
 * The phone's `⋯`, a 44 × 44 target at the end of the Back bar, and the bottom
 * sheet it opens (frame C4 of the Figma page `Webhook Inspector · Request
 * actions`, D182): `Request actions` over a scrim, 48 px rows at 15 px. A tap
 * on the scrim, Escape or a choice closes it, and focus returns to `⋯`. A modal
 * Radix dialog: the page under the scrim is out of reach of Tab and of
 * assistive technology while it is open.
 *
 * `Check signature…` is the one choice that does not close it: the same
 * sheet becomes `Check signature` (frames B3 and B5 of the Figma page `Webhook
 * Inspector · Check signature`, D197), and closes the same way.
 *
 * From 768 px up it is not rendered, so a sheet open when the window widens
 * closes with it, and `Actions ▾` is there instead.
 */
export function RequestActionsSheet({ details, ...props }: RequestActionsSheetProps) {
  const phone = usePhoneLayout();

  if (!phone) {
    return null;
  }

  if (details === null) {
    return <EllipsisButton disabled />;
  }

  return <OpenableSheet details={details} {...props} />;
}

function OpenableSheet({
  onDismissToast,
  signature,
  ...props
}: RequestActionsProps & Pick<RequestActionsSheetProps, 'onDismissToast'>) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const groups = useRequestActions({
    ...props,
    onCheckSignature: signature === undefined ? undefined : () => setChecking(true),
  });

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onDismissToast();
          setChecking(false);
        }

        setOpen(next);
      }}
    >
      <DialogPrimitive.Trigger asChild>
        <EllipsisButton />
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
            {checking ? m.signature.title : m.actions.title}
          </DialogPrimitive.Title>
          {checking && signature !== undefined ? (
            <div className="px-2 pt-1">
              <SignatureCheckForm details={props.details} memory={signature} />
            </div>
          ) : null}
          {checking
            ? null
            : groups.map((group, index) => (
                <Fragment key={group.map((action) => action.label).join()}>
                  {index > 0 ? <div role="separator" className="mx-0 my-1 h-px bg-line" /> : null}
                  {group.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={() => {
                        if (!action.keepsSheetOpen) {
                          setOpen(false);
                        }

                        action.run();
                      }}
                      className="flex h-12 w-full items-center gap-3 rounded-[6px] px-3 text-left text-[15px] text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent active:bg-row-selected"
                    >
                      <action.icon aria-hidden="true" className="size-4 shrink-0 text-menu-icon" />
                      {action.label}
                    </button>
                  ))}
                </Fragment>
              ))}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * `⋯` itself: the link colour, its glyph ending 16 px from the screen's edge
 * with the bar's 2 px padding. Named for the sheet it opens.
 */
function EllipsisButton(props: ComponentProps<'button'>) {
  const m = useMessages();

  return (
    <button
      type="button"
      aria-label={m.actions.title}
      {...props}
      className="flex size-11 shrink-0 items-center justify-center rounded-[7px] text-link focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:text-disabled-ink"
    >
      <Ellipsis aria-hidden="true" className="size-4" />
    </button>
  );
}
