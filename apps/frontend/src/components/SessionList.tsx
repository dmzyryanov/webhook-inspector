import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Copy, Ellipsis, LockKeyhole } from 'lucide-react';
import { forwardRef, useRef, useState, type ComponentProps } from 'react';
import { Link } from 'react-router-dom';
import { useClipboardCopy } from '../hooks/useClipboardCopy.ts';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import type { Messages } from '../i18n/en.ts';
import { cn } from '../lib/cn.ts';
import {
  formatRowMeta,
  groupByDay,
  shortSessionId,
  splitReceiveUrl,
  type SessionRow,
} from '../lib/home-view.ts';
import { CopyStatus } from './CopyStatus.tsx';

/*
 * The two actions of a row's `⋯`, in the menu and in the phone's sheet, and
 * every other word here, are the dictionary's `sessions` (D222).
 */

export interface SessionRowActions {
  /**
   * Takes the session off this browser's list: a public one with no
   * confirmation, a private one after the page's warning (D259).
   */
  onRemove: (id: string) => void;
  /**
   * Asks to delete the session on the server, once the menu or the sheet has
   * closed; `trigger` is the row's `⋯`, where focus returns if the deletion is
   * cancelled.
   */
  onDelete: (row: SessionRow, trigger: HTMLButtonElement | null) => void;
}

interface SessionDaysProps extends SessionRowActions {
  /** The rows shown, newest first. */
  rows: SessionRow[];
  /** Each row's link, by session id, so the page can move focus to one. */
  linkRefs: Map<string, HTMLAnchorElement>;
  /** The private sessions among the rows, which this browser holds keys for (D259). */
  privateIds: ReadonlySet<string>;
}

/**
 * The returning visitor's sessions, grouped by day (G3′, frames `626:13`,
 * `626:129`, `626:237`; D199), in the changelog index's style: from 1024 px a
 * 160 px rail holding the date and its count, the rows beside it; below
 * 1024 px the date is a band above its rows, tinted on a phone.
 */
export function SessionDays({ rows, linkRefs, privateIds, onRemove, onDelete }: SessionDaysProps) {
  const m = useMessages();

  return (
    <div className="border-b border-line">
      {groupByDay(rows, undefined, m).map((group) => (
        <section
          key={group.key}
          aria-label={group.label}
          className="flex gap-8 border-t border-line max-lg:block"
        >
          <div className="flex w-40 flex-none flex-col gap-0.5 py-[13px] max-lg:w-auto max-lg:flex-row max-lg:items-baseline max-lg:gap-1.5 max-lg:py-2 max-md:bg-code max-md:px-4">
            <h2 className="text-[14px] font-semibold leading-5 text-ink max-lg:text-[13px] max-lg:leading-[18px]">
              {group.label}
            </h2>
            <p className="text-[12px] leading-[17px] text-ink-muted max-lg:text-[13px] max-lg:leading-[18px]">
              <span aria-hidden="true" className="hidden max-lg:inline">
                ·{' '}
              </span>
              {group.count}
            </p>
          </div>
          <ul className="min-w-0 flex-1 border-l border-line max-lg:border-l-0">
            {group.rows.map((row) => (
              <SessionRowItem
                key={row.id}
                row={row}
                isPrivate={privateIds.has(row.id)}
                ref={(element) => {
                  if (element === null) {
                    linkRefs.delete(row.id);
                  } else {
                    linkRefs.set(row.id, element);
                  }
                }}
                onRemove={onRemove}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface SessionRowItemProps extends SessionRowActions {
  row: SessionRow;
  /** A private session: the lock in line 1, just before the copy icon (R2, D259). */
  isPrivate: boolean;
}

/**
 * One session: the full receive URL - its prefix muted, the id bold - with
 * the copy icon and `⋯` on the first line, and under them the request count
 * and the last request. Nothing is shortened; on a phone the URL wraps.
 *
 * The URL is the row's link to `/v/<id>`, stretched over the whole row, so a
 * click anywhere on it opens the session in this tab - and a middle click in
 * a new one - while the copy icon and `⋯` sit above the link and open
 * nothing. When the status read failed the row shows the session's id in the
 * URL's place, with no count and no copy icon, since the receive URL is the
 * server's to give (D187).
 */
const SessionRowItem = forwardRef<HTMLAnchorElement, SessionRowItemProps>(function SessionRowItem(
  { row, isPrivate, onRemove, onDelete },
  ref,
) {
  const m = useMessages();
  const { details } = row;
  const url = details === null ? null : splitReceiveUrl(details.receiveUrl, row.id);
  const meta = details === null ? null : formatRowMeta(details, undefined, m);

  return (
    <li className="relative border-t border-line py-3 pl-5 pr-3 first:border-t-0 hover:bg-canvas max-lg:px-0 max-lg:first:border-t max-md:px-4">
      <div className="flex items-start gap-2">
        <Link
          ref={ref}
          to={`/v/${row.id}`}
          // The URL as shown, whole: the id's own box would otherwise be read
          // as a word apart from the prefix.
          aria-label={details === null ? row.id : details.receiveUrl}
          className={
            // Nothing is shortened: a URL wider than the row wraps at any
            // character, and the id, a box of its own, starts a line of its
            // own when it does not fit after the prefix (frame `626:237`).
            'min-w-0 flex-1 break-all font-mono text-[12px] leading-[17px] ' +
            // The whole row is the link's target; its ring is drawn on the row.
            "outline-none after:absolute after:inset-0 after:content-[''] " +
            'focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent'
          }
        >
          {url === null ? (
            <span className="font-semibold text-ink">{row.id}</span>
          ) : (
            <>
              <span className="text-ink-muted">{url.prefix}</span>
              <span className="inline-block font-semibold text-ink">{url.id}</span>
            </>
          )}
        </Link>
        {isPrivate ? <PrivateMark /> : null}
        {details === null ? null : <CopyReceiveUrl id={row.id} url={details.receiveUrl} />}
        <SessionActions row={row} onRemove={onRemove} onDelete={onDelete} />
      </div>
      {meta === null ? null : (
        <p className="mt-1 text-[13px] leading-[18px] text-ink-muted">
          <span className="text-ink">{meta.count}</span> ·{' '}
          <span className="whitespace-nowrap">{meta.last}</span>
        </p>
      )}
    </li>
  );
});

/**
 * The mark of a private session (R2, D259): lucide's `LockKeyhole`, a 12 px
 * glyph in the copy icon's 14 px box, muted as it is, named `Private session`.
 * It marks, and does nothing: the row's link stays under it.
 */
function PrivateMark() {
  const m = useMessages();

  return (
    <span
      role="img"
      aria-label={m.access.mark}
      title={m.access.mark}
      className="relative flex h-4 w-3.5 shrink-0 items-center justify-center text-ink-muted"
    >
      <LockKeyhole aria-hidden="true" className="size-3" />
    </span>
  );
}

/**
 * The row's copy icon: the exact receive URL, with the feedback every copy
 * control gives - a check while the copy holds, said in words by
 * `CopyStatus`, nothing claimed when the browser refuses (D122).
 */
function CopyReceiveUrl({ id, url }: { id: string; url: string }) {
  const m = useMessages();
  const { outcome, copy } = useClipboardCopy();
  const label = m.sessions.copyUrl(shortSessionId(id));

  return (
    <>
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => void copy(url)}
        className={cn(
          'relative flex h-4 w-3.5 shrink-0 items-center justify-center rounded-[3px] text-ink-muted',
          // A larger target than the 14 px glyph, 44 px below 1024 px (D157).
          'before:absolute before:-inset-1.5 max-lg:before:-inset-x-[11px] max-lg:before:-inset-y-3.5',
          'transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          outcome === 'copied' && 'text-ok hover:text-ok',
        )}
      >
        {outcome === 'copied' ? (
          <Check aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </button>
      {/* Said when the browser refuses the write: nothing was copied. */}
      <CopyStatus outcome={outcome} refused={m.sessions.copyRefused} />
    </>
  );
}

interface SessionActionsProps extends SessionRowActions {
  row: SessionRow;
}

/**
 * `⋯`: a menu from 768 px up (frame `604:373`), the actions sheet of #71 on a
 * phone (frame `604:478`), each with `Remove from list` and
 * `Delete session…`.
 */
function SessionActions(props: SessionActionsProps) {
  return usePhoneLayout() ? <SessionActionsSheet {...props} /> : <SessionActionsMenu {...props} />;
}

/** The name of a row's `⋯` and of the sheet it opens on a phone. */
function actionsLabel(id: string, m: Messages): string {
  return m.sessions.actions(shortSessionId(id));
}

/**
 * The menu, from Radix as the request actions' is: Enter, Space or Down open
 * it, the arrows move, Escape or a choice closes it. A choice hands focus on
 * rather than back to `⋯`: the page moves it once the row is gone, or the
 * confirmation takes it.
 */
function SessionActionsMenu({ row, onRemove, onDelete }: SessionActionsProps) {
  const m = useMessages();
  const trigger = useRef<HTMLButtonElement>(null);
  const chosen = useRef<'remove' | 'delete' | null>(null);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <EllipsisButton ref={trigger} aria-label={actionsLabel(row.id, m)} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            const choice = chosen.current;

            chosen.current = null;

            if (choice === 'remove') {
              event.preventDefault();
              onRemove(row.id);
            } else if (choice === 'delete') {
              event.preventDefault();
              onDelete(row, trigger.current);
            }
          }}
          className="z-40 w-[184px] rounded-[8px] border border-line bg-white p-1.5 shadow-[0_12px_32px_rgba(31,36,46,0.16)]"
        >
          <DropdownMenu.Item
            onSelect={() => {
              chosen.current = 'remove';
            }}
            className={MENU_ITEM}
          >
            {m.sessions.removeFromList}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item
            onSelect={() => {
              chosen.current = 'delete';
            }}
            className={cn(MENU_ITEM, 'text-danger')}
          >
            {m.sessions.deleteSession}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const MENU_ITEM =
  'flex h-9 cursor-default select-none items-center rounded-[6px] px-2.5 text-[13px] text-ink outline-none data-[highlighted]:bg-row-selected max-lg:h-11 max-lg:text-[14px]';

/**
 * The phone's sheet, as the request actions' (#71, D182): over a scrim, its
 * title naming the session, 48 px rows at 15 px. A tap on the scrim, Escape
 * or a choice closes it.
 */
function SessionActionsSheet({ row, onRemove, onDelete }: SessionActionsProps) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const chosen = useRef<'remove' | 'delete' | null>(null);

  function choose(choice: 'remove' | 'delete'): void {
    chosen.current = choice;
    setOpen(false);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <EllipsisButton ref={trigger} aria-label={actionsLabel(row.id, m)} />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            const choice = chosen.current;

            chosen.current = null;

            if (choice === 'remove') {
              event.preventDefault();
              onRemove(row.id);
            } else if (choice === 'delete') {
              event.preventDefault();
              onDelete(row, trigger.current);
            }
          }}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain rounded-t-2xl bg-white px-2 pb-6 pt-2"
        >
          <div aria-hidden="true" className="flex justify-center pb-2 pt-1">
            <span className="h-1 w-9 rounded-[2px] bg-line" />
          </div>
          <DialogPrimitive.Title className="pb-1 pl-3 text-[13px] font-semibold leading-4 text-ink-muted">
            {m.sessions.sheetTitle} <span className="font-mono">{shortSessionId(row.id)}</span>
          </DialogPrimitive.Title>
          <button type="button" onClick={() => choose('remove')} className={SHEET_ITEM}>
            {m.sessions.removeFromList}
          </button>
          <div role="separator" className="my-1 h-px bg-line" />
          <button
            type="button"
            onClick={() => choose('delete')}
            className={cn(SHEET_ITEM, 'text-danger')}
          >
            {m.sessions.deleteSession}
          </button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const SHEET_ITEM =
  'flex h-12 w-full items-center rounded-[6px] px-3 text-left text-[15px] text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent active:bg-row-selected';

/**
 * `⋯` itself: muted like the copy icon, 28 × 24 px, a 44 px target below
 * 1024 px (D157). Above the row's link, so it never opens the session.
 */
const EllipsisButton = forwardRef<HTMLButtonElement, ComponentProps<'button'>>(
  function EllipsisButton(props, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...props}
        className={
          'relative flex h-6 w-7 shrink-0 items-center justify-center rounded-[5px] text-ink-muted ' +
          'transition-colors hover:bg-line/50 hover:text-ink data-[state=open]:bg-line/50 data-[state=open]:text-ink ' +
          'focus-visible:outline-2 focus-visible:outline-accent ' +
          'max-lg:before:absolute max-lg:before:-inset-x-2 max-lg:before:-inset-y-2.5'
        }
      >
        <Ellipsis aria-hidden="true" className="size-4" />
      </button>
    );
  },
);
