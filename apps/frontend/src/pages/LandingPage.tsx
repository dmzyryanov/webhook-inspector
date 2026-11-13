import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorCode } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import { AppFooter } from '../components/AppFooter.tsx';
import { AppHeader } from '../components/AppHeader.tsx';
import { DeleteSessionDialog, type DeletionPhase } from '../components/DeleteSessionDialog.tsx';
import { OptionsMenu, OptionsSheet } from '../components/NewSessionOptions.tsx';
import {
  RemovePrivateSessionDialog,
  type PrivateRemoval,
} from '../components/RemovePrivateSessionDialog.tsx';
import { SessionDays } from '../components/SessionList.tsx';
import { Toast, type ToastMessage } from '../components/Toast.tsx';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import type { Phrase } from '../i18n/en.ts';
import {
  accessKeyFor,
  accessKeysFor,
  keepAccessKey,
  privateSessionIds,
} from '../lib/access-keys.ts';
import { cn } from '../lib/cn.ts';
import { createSessionFailureText } from '../lib/create-session-failure.ts';
import {
  formatDeletedToast,
  formatExpiredToast,
  formatListCount,
  homeState,
  sessionRows,
  settleStatusRead,
  visibleRows,
  type SessionRow,
  type StatusRead,
} from '../lib/home-view.ts';
import { browserStorage } from '../lib/read-state.ts';
import { buildAccessLink } from '../lib/request-link.ts';
import {
  DEFAULT_SESSION_OPTIONS,
  tileHint,
  type NewSessionOptions,
} from '../lib/session-options.ts';
import {
  loadSessionList,
  recordSessionOpened,
  removeListedSessions,
  removeReportedSessions,
  type ListedSession,
} from '../lib/session-list.ts';

/** A deletion asked for from the list, and where it stands. */
interface Deletion {
  row: SessionRow;
  phase: DeletionPhase;
  /** The row's `⋯`, where focus returns when the deletion is cancelled. */
  trigger: HTMLButtonElement | null;
}

/** What takes focus once the list has changed under it. */
type FocusTarget = { kind: 'tile' } | { kind: 'row'; id: string };

/**
 * The column both states share: 960 px centred from 1024 px, as the changelog
 * index's (D184); 40 px margins on a tablet and 16 px on a phone.
 */
const COLUMN = 'mx-auto w-full max-w-[1024px] px-8 md:max-lg:px-10 max-md:px-4';

/**
 * The home page, in two states (issue #92, D199; the Figma page `Webhook
 * Inspector · My sessions`, `604:11`): the first visit (row F, frames
 * `626:345`, `626:412`, `626:475`) while this browser lists no session, and the
 * returning visitor's (row G3′, frames `626:13`, `626:129`, `626:237`) once it
 * lists one, where the sessions take the place of the steps. Which one shows,
 * and the list's rows, days and cut, are decided in `lib/home-view.ts`; the
 * list itself is `lib/session-list.ts`.
 *
 * The list is read from storage on the first render, so a returning visitor
 * never sees F first: G3′ is drawn at once with `Loading sessions…` until the
 * status read answers. That read is not a use of any session (D133). The
 * header and the footer are every page's (D177); the copy is the dictionary's
 * `landing` (D222), whose English the `<noscript>` of `index.html` repeats as
 * F (D183, `lib/landing-copy.ts`), and whose Russian that of `ru/index.html`,
 * the Russian home page at `/ru/`, which renders this same page (D226).
 */
export function LandingPage() {
  const m = useMessages();
  const navigate = useNavigate();
  const [storage] = useState(browserStorage);
  const [list, setList] = useState<ListedSession[]>(() => loadSessionList(storage));
  /** The ids the status read is sent for: the list as the page was opened with it. */
  const [readIds] = useState(() => list.map((entry) => entry.id));
  const [read, setRead] = useState<StatusRead>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  /**
   * The new session's options (issue #216, D249): page state and nothing
   * else, so every visit starts at the defaults and a reload returns to them.
   */
  const [options, setOptions] = useState<NewSessionOptions>(DEFAULT_SESSION_OPTIONS);
  /** Set from the click until the creation settles: a second click creates nothing. */
  const creating = useRef(false);
  /**
   * Why the last `Generate URL` created nothing, until the next click (issue
   * #128): the error, whose text is asked for on every render, so it follows
   * the interface's language (D222).
   */
  const [createFailure, setCreateFailure] = useState<{ error: unknown } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [deletion, setDeletion] = useState<Deletion | null>(null);
  /**
   * A private session `Remove from list` warns about first (frame R3 of the
   * Figma page `Webhook Inspector · Private sessions (#228)`, D259).
   */
  const [removal, setRemoval] = useState<PrivateRemoval | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const tile = useRef<HTMLButtonElement>(null);
  const rowLinks = useRef(new Map<string, HTMLAnchorElement>());
  const pendingFocus = useRef<FocusTarget | null>(null);
  /** Set when the confirmation was cancelled: focus goes back to the row's `⋯`. */
  const returnFocus = useRef<HTMLButtonElement | null>(null);

  const dismissToast = useCallback(() => setToast(null), []);
  const showToast = useCallback((text: Phrase, icon: 'check' | 'info'): void => {
    setToast((current) => ({ id: (current?.id ?? 0) + 1, text, icon }));
  }, []);

  useEffect(() => {
    if (readIds.length === 0) {
      return;
    }

    let cancelled = false;
    // The keys the read is sent with, which its verdicts are about (D259).
    const sentKeys = accessKeysFor(readIds, storage);

    // A read that failed or answered outside its contract settles as `failed`,
    // with nothing gone; anything thrown while the outcome is applied lands
    // there too, so the rows never stay on `Loading sessions…`.
    settleStatusRead(readIds, (ids) => api.readSessionStatuses(ids, sentKeys))
      .then((outcome) => {
        if (cancelled) {
          return;
        }

        // Sessions the server no longer has leave the list for good - unless
        // another tab has stored a session's right key since the read was
        // sent, which the verdict on the old one says nothing about.
        if (outcome.gone.length > 0) {
          const goneIds = new Set(removeReportedSessions(storage, outcome.gone, sentKeys));

          setList((current) => current.filter((entry) => !goneIds.has(entry.id)));
        }

        setRead(outcome.read);
      })
      .catch(() => {
        if (!cancelled) {
          setRead({ state: 'failed' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [readIds, storage]);

  // Focus asked for by a removal, a deletion or `Show all`, once the rows it
  // names are on screen.
  useEffect(() => {
    const target = pendingFocus.current;

    if (target === null) {
      return;
    }

    pendingFocus.current = null;
    (target.kind === 'row'
      ? (rowLinks.current.get(target.id) ?? tile.current)
      : tile.current
    )?.focus();
  });

  const state = homeState(list, read);
  const rows = sessionRows(list, read);
  const shown = visibleRows(rows, showAll);
  /** The listed sessions this browser holds keys for: private ones (D259). */
  const privateIds = useMemo(
    () =>
      privateSessionIds(
        list.map((entry) => entry.id),
        storage,
      ),
    [list, storage],
  );

  /** Asks for focus on what takes the place of the row about to go: the next row, else the one before, else the tile. */
  function focusAfterRemoving(id: string): void {
    const index = rows.findIndex((row) => row.id === id);
    const next = rows[index + 1] ?? rows[index - 1];

    pendingFocus.current =
      index >= 0 && next !== undefined ? { kind: 'row', id: next.id } : { kind: 'tile' };
  }

  function dropFromList(id: string): void {
    focusAfterRemoving(id);
    removeListedSessions(storage, [id]);
    setList((current) => current.filter((entry) => entry.id !== id));
  }

  /**
   * `Remove from list`: at once for a public session; for a private one, whose
   * key leaves with the entry, after the warning of frame R3 of the Figma page
   * `Webhook Inspector · Private sessions (#228)`, which offers its link with
   * access first (#228's Decision 1).
   */
  function askToRemove(id: string): void {
    const key = privateIds.has(id) ? accessKeyFor(id, storage) : null;

    if (key === null) {
      dropFromList(id);

      return;
    }

    setRemoval({
      id,
      receiveUrl: rows.find((row) => row.id === id)?.details?.receiveUrl ?? null,
      link: buildAccessLink(window.location.origin, id, key),
    });
  }

  /**
   * Creates a session and opens it. A failure of any kind - no answer, any
   * status - is caught and said under the tile (issue #128); a click clears
   * that line at once, and the tile stays clickable, since a refused creation
   * is not counted toward the limit.
   */
  async function generate(): Promise<void> {
    if (creating.current) {
      return;
    }

    creating.current = true;

    // The tile is disabled while the creation is pending, which can take
    // focus from it; after a failure focus is where it was, on the tile,
    // unless the visitor has moved it meanwhile.
    const tileHadFocus = document.activeElement === tile.current;

    setCreateFailure(null);
    setBusy(true);

    try {
      const session = await api.createSession(options);

      // A private session's key, answered this once (D253), is kept before the
      // list records the session, so a full list pushes out a public one
      // first; the person never sees it (D259).
      if (session.accessKey !== undefined) {
        keepAccessKey(storage, session.id, session.accessKey);
      }

      recordSessionOpened(storage, session.id, Date.now());
      void navigate(`/v/${session.id}`);
    } catch (error) {
      setCreateFailure({ error });

      const active = document.activeElement;

      if (
        tileHadFocus &&
        (active === null || active === document.body || active === tile.current)
      ) {
        pendingFocus.current = { kind: 'tile' };
      }
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }

  async function confirmDeletion(): Promise<void> {
    if (deletion === null) {
      return;
    }

    const { row } = deletion;

    setDeletion({ ...deletion, phase: 'deleting' });

    try {
      await api.deleteSession(row.id);
      finishDeletion(row.id, (words) => formatDeletedToast(row.id, words), 'check');
    } catch (error) {
      if (error instanceof ApiError && error.errorCode === ErrorCode.SESSION_NOT_FOUND) {
        // Gone already: a deletion whose answer was lost, retried, or one made
        // elsewhere (D198). Either way the session no longer exists.
        finishDeletion(row.id, (words) => formatDeletedToast(row.id, words), 'check');
      } else if (error instanceof ApiError && error.errorCode === ErrorCode.SESSION_EXPIRED) {
        // Not deleted: it expired, and the cleanup removes it. It leaves the
        // list as the status read would have taken it off.
        finishDeletion(row.id, (words) => formatExpiredToast(row.id, words), 'info');
      } else {
        setDeletion((current) => (current === null ? null : { ...current, phase: 'failed' }));
      }
    }
  }

  function finishDeletion(id: string, text: Phrase, icon: 'check' | 'info'): void {
    returnFocus.current = null;
    dropFromList(id);
    setDeletion(null);
    showToast(text, icon);
  }

  /** The line under the tile, in the language shown. */
  const failureText =
    createFailure === null ? null : createSessionFailureText(createFailure.error, m);

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <AppHeader />
      {state === 'first-visit' ? (
        <main className="flex-1 bg-white pb-12 pt-24 max-lg:pb-10 md:max-lg:pt-[72px] max-md:pt-8">
          <div className={COLUMN}>
            <p className="text-[11px] font-semibold leading-[15px] tracking-[0.08em] text-accent">
              {m.landing.eyebrow}
            </p>
            <h1 className="mt-3.5 text-[48px] font-semibold leading-[55px] text-ink md:max-lg:text-[40px] md:max-lg:leading-[46px] max-md:mt-2.5 max-md:text-[32px] max-md:leading-[37px]">
              {m.landing.heading}
            </h1>
            <p className="mt-3.5 text-[17px] leading-[25px] text-ink-muted max-md:mt-2.5 max-md:text-[15px] max-md:leading-[21px]">
              {m.landing.lead}
            </p>
            <GenerateUrlTile
              tileRef={tile}
              firstVisit
              busy={busy}
              options={options}
              onOptionsChange={setOptions}
              onClick={() => void generate()}
              className="mt-8 max-md:mt-6"
            />
            <CreateFailureLine text={failureText} />
            <HowItWorks />
          </div>
        </main>
      ) : (
        <main className="flex-1 bg-white pb-12 pt-14 max-lg:pb-10 max-md:pt-7">
          <div className={COLUMN}>
            <h1 className="text-[32px] font-semibold leading-[45px] text-ink max-md:text-[26px] max-md:leading-9">
              {m.landing.heading}
            </h1>
            <p className="mt-3 text-[15px] leading-[21px] text-ink-muted max-md:mt-2">
              {m.landing.lead}
            </p>
            <div className="mt-7 max-md:mt-5">
              <GenerateUrlTile
                tileRef={tile}
                firstVisit={false}
                busy={busy}
                options={options}
                onOptionsChange={setOptions}
                onClick={() => void generate()}
              />
              <CreateFailureLine text={failureText} />
              {read.state === 'loading' ? (
                <p role="status" className="mt-3 text-[13px] leading-[18px] text-ink-muted">
                  {m.home.loading}
                </p>
              ) : (
                <>
                  {read.state === 'failed' ? (
                    <p role="status" className="mt-3 text-[13px] leading-[18px] text-ink-muted">
                      {m.home.detailsFailed}
                    </p>
                  ) : null}
                  <div className="mt-3">
                    <SessionDays
                      rows={shown}
                      linkRefs={rowLinks.current}
                      privateIds={privateIds}
                      onRemove={askToRemove}
                      onDelete={(row, trigger) => {
                        returnFocus.current = trigger;
                        setDeletion({ row, phase: 'confirm', trigger });
                      }}
                    />
                  </div>
                  <ListCount
                    shown={shown.length}
                    total={rows.length}
                    onShowAll={() => {
                      const firstHidden = rows[shown.length];

                      if (firstHidden !== undefined) {
                        pendingFocus.current = { kind: 'row', id: firstHidden.id };
                      }

                      setShowAll(true);
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </main>
      )}
      <AppFooter />
      <DeleteSessionDialog
        target={
          deletion === null
            ? null
            : { id: deletion.row.id, requestsCount: deletion.row.details?.requestsCount ?? null }
        }
        phase={deletion?.phase ?? 'confirm'}
        onConfirm={() => void confirmDeletion()}
        onCancel={() => setDeletion(null)}
        onClosed={() => {
          const trigger = returnFocus.current;

          returnFocus.current = null;

          if (trigger?.isConnected) {
            trigger.focus();
          }
        }}
      />
      <RemovePrivateSessionDialog
        target={removal}
        onConfirm={() => {
          if (removal !== null) {
            dropFromList(removal.id);
          }

          setRemoval(null);
        }}
        onCancel={() => {
          if (removal !== null) {
            pendingFocus.current = { kind: 'row', id: removal.id };
          }

          setRemoval(null);
        }}
      />
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}

interface GenerateUrlTileProps {
  tileRef: Ref<HTMLButtonElement>;
  firstVisit: boolean;
  busy: boolean;
  /** The new session's options, which the trigger shows and changes (D249). */
  options: NewSessionOptions;
  onOptionsChange: (options: NewSessionOptions) => void;
  onClick: () => void;
  className?: string;
}

/**
 * The page's one action, `+ Generate URL`, as a dashed tile across the column
 * (direction G3 of the Figma page `Webhook Inspector · My sessions`, chosen
 * 2026-10-03): one click to a session with the options shown,
 * the default session unless one was chosen (D150, D158, amended by D249).
 * Its hint shows from 768 px up, and says a window other than 7 days once one
 * is chosen. Taller on the first visit, where it follows the hero.
 *
 * The options are the trigger beside it (issue #216, direction A): from
 * 768 px the tile is split - `Generate URL` centred in its own part, then a
 * divider and the trigger, which opens a menu; below 768 px the tile stays
 * whole and the trigger is a line 8 px under it, right-aligned, which opens a
 * bottom sheet. While a creation is in flight both are disabled.
 *
 * The dashed border is drawn by an SVG rectangle rather than `border-dashed`,
 * whose dash length each browser picks for itself: the frames' 1.5 px stroke
 * in 6 px dashes and 4 px gaps. The stroke is 3 px on the rectangle's edge,
 * so the half outside the SVG is clipped and 1.5 px shows inside.
 */
function GenerateUrlTile({
  tileRef,
  firstVisit,
  busy,
  options,
  onOptionsChange,
  onClick,
  className,
}: GenerateUrlTileProps) {
  const m = useMessages();
  const phone = usePhoneLayout();

  // From 768 px the trigger sits in the tile's second column, over the
  // button, which spans both: its content is laid out on the tile's columns
  // (`subgrid`), centred in the first, and its box is still the whole tile,
  // whose width #128's failure line follows. The dashed border is drawn last,
  // over both.
  return (
    <div className={className}>
      <div
        className={cn(
          'relative grid w-full grid-cols-[minmax(0,1fr)_auto] rounded-[7px] bg-canvas text-brand',
          busy && 'pointer-events-none opacity-60',
          firstVisit ? 'h-16 max-md:h-14' : 'h-14 max-md:h-[52px]',
        )}
      >
        <button
          ref={tileRef}
          type="button"
          disabled={busy}
          onClick={onClick}
          className={cn(
            'col-span-full row-start-1 grid grid-cols-subgrid items-center rounded-[7px]',
            'transition-colors hover:bg-row-pick-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          )}
        >
          <span className="col-start-1 flex min-w-0 items-center justify-center gap-2.5">
            <Plus
              aria-hidden="true"
              className={cn('shrink-0', firstVisit ? 'size-4' : 'size-3.5')}
              strokeWidth={3}
            />
            <span
              className={cn(
                'shrink-0 font-semibold',
                firstVisit ? 'text-[16px] leading-[22px]' : 'text-[15px] leading-[21px]',
              )}
            >
              {m.landing.generate}
            </span>
            <span className="truncate text-[13px] leading-[18px] text-ink-muted max-md:hidden">
              {tileHint(options, firstVisit, m)}
            </span>
          </span>
        </button>
        {phone ? null : (
          <OptionsMenu
            options={options}
            onChange={onOptionsChange}
            disabled={busy}
            className="relative col-start-2 row-start-1"
          />
        )}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[1] size-full text-tile-dash"
        >
          <rect
            width="100%"
            height="100%"
            rx="7"
            ry="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeDasharray="6 4"
          />
        </svg>
      </div>
      {phone ? <OptionsSheet options={options} onChange={onOptionsChange} disabled={busy} /> : null}
    </div>
  );
}

/**
 * Why `Generate URL` created nothing (issue #128; Figma page `739:11`, frames
 * `739:15` to `739:342`): 12 px under the tile on both states, before the
 * returning visitor's status lines and days, across the column, in the style
 * of `DeleteSessionDialog`'s error. `role="alert"` has it read out while focus
 * stays on the tile; the text is `createSessionFailureText`'s.
 */
function CreateFailureLine({ text }: { text: string | null }) {
  return text === null ? null : (
    <p role="alert" className="mt-3 text-[13px] leading-[1.5] text-danger">
      {text}
    </p>
  );
}

/**
 * The three steps as rows in the changelog's style (F): `How it works` on a
 * rail from 1024 px, a band above the rows below it, tinted on a phone. Step
 * 01 carries the security note that used to be a block of its own (D199).
 */
function HowItWorks() {
  const m = useMessages();

  return (
    <section
      aria-labelledby="how-it-works"
      className="mt-8 flex gap-8 border-y border-line max-lg:block max-md:mt-6"
    >
      <div className="flex w-40 flex-none flex-col gap-0.5 py-[13px] max-lg:w-auto max-lg:flex-row max-lg:items-baseline max-lg:gap-1.5 max-lg:py-2 max-md:bg-code max-md:px-4">
        <h2
          id="how-it-works"
          className="text-[14px] font-semibold leading-5 text-ink max-lg:text-[13px] max-lg:leading-[18px]"
        >
          {m.landing.stepsTitle}
        </h2>
        <p className="text-[12px] leading-[17px] text-ink-muted max-lg:text-[13px] max-lg:leading-[18px]">
          <span aria-hidden="true" className="hidden max-lg:inline">
            ·{' '}
          </span>
          {m.landing.stepsCount(m.landing.steps.length)}
        </p>
      </div>
      <ol className="min-w-0 flex-1 border-l border-line max-lg:border-l-0">
        {m.landing.steps.map((step) => (
          <li
            key={step.number}
            className="flex gap-4 border-t border-line py-[13px] pl-5 pr-3 first:border-t-0 max-lg:px-0 max-lg:first:border-t max-md:px-4"
          >
            <span className="w-4 flex-none font-mono text-[13px] leading-[18px] text-ink-muted">
              {step.number}
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold leading-5 text-ink">{step.title}</p>
              <p className="mt-0.5 text-[13px] leading-[18px] text-ink-muted">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface ListCountProps {
  shown: number;
  total: number;
  onShowAll: () => void;
}

/** `5 of 12 sessions in this browser · Show all`, or `3 sessions in this browser`. */
function ListCount({ shown, total, onShowAll }: ListCountProps) {
  const m = useMessages();
  const count = formatListCount(shown, total, m);

  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-1.5 text-[13px] leading-[18px] text-ink-muted">
      <span>{count.text}</span>
      {count.showAll ? (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onShowAll}
            className="rounded-[4px] font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-[13px]"
          >
            {m.home.showAll}
          </button>
        </>
      ) : null}
    </p>
  );
}
