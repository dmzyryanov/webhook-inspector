import { ChevronLeft } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';

interface BackBarProps {
  /** `2 of 4`, or `null` while the open request is not in the list. */
  position: string | null;
  /** `1 new`, or `null` when nothing arrived since the request was opened. */
  arrived: string | null;
  onBack: () => void;
  /** Where focus goes when a request opens in the push flow (D157). */
  buttonRef?: Ref<HTMLButtonElement>;
  /**
   * The phone's `⋯`, which opens the request actions (frame C4 of the Figma
   * page `Webhook Inspector · Request actions`, D182). It renders nothing from
   * 768 px up, where `Actions ▾` is in the detail panel.
   */
  actions?: ReactNode;
  className?: string;
}

/**
 * The bar over a request opened in the push flow, below 1024 px (frames 3A, 6C
 * and 7C of the Figma page `Webhook Inspector · Tablet and phone`, D157): the
 * way back to the list, what arrived meanwhile, and where the request stands in
 * the list. On a phone it ends in `⋯`, 4 px after the position, its glyph 16 px
 * from the edge: the bar's right padding is 2 px there, and the 44 px target's
 * own 14 px make up the rest (frame C4 of the Figma page `Webhook Inspector ·
 * Request actions`, D182).
 *
 * `‹ Requests` takes the same step as the browser's or the OS's Back gesture:
 * both close the request and leave the page on its list. Its accessible name
 * says so: `Back to Requests`, and `Back to Requests, 1 new` with the badge.
 */
export function BackBar({
  position,
  arrived,
  onBack,
  buttonRef,
  actions,
  className,
}: BackBarProps) {
  const m = useMessages();

  return (
    <div
      className={cn(
        'flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line-header bg-white pl-1 md:pl-3 md:pr-6',
        actions === undefined ? 'pr-4' : 'pr-0.5',
        className,
      )}
    >
      <button
        ref={buttonRef}
        type="button"
        // Spelled out rather than read off the content: the visible words are
        // `Requests` and the badge, and a name composed from them would be
        // `Requests1 new`. The visible word stays in the name.
        aria-label={m.push.back(arrived)}
        onClick={onBack}
        className="flex h-11 min-w-0 items-center gap-1.5 rounded-[7px] px-3 text-[14px] font-semibold text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronLeft aria-hidden="true" className="size-[17px] shrink-0" strokeWidth={2.25} />
        {m.push.requests}
        {arrived === null ? null : (
          <span className="shrink-0 rounded-[10px] bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">
            {arrived}
          </span>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {position === null ? null : (
          <p data-testid="open-position" className="shrink-0 text-[12px] text-ink-muted">
            {position}
          </p>
        )}
        {actions}
      </div>
    </div>
  );
}
