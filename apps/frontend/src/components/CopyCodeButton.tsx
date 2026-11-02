import { Check, Copy } from 'lucide-react';
import { useClipboardCopy } from '../hooks/useClipboardCopy.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import { CopyStatus } from './CopyStatus.tsx';

interface CopyCodeButtonProps {
  /**
   * The whole text the block displays, never the fragment on screen (D122).
   * Composed by the block model in `lib/detail-view.ts`, which is where the
   * whole-content rule is tested.
   */
  text: string;
  /**
   * What it copies, said in words: `Copy raw request`, not a bare `Copy`. The
   * page carries one of these per block, so a bare label would give several
   * controls the same accessible name.
   */
  label: string;
  className?: string;
}

/**
 * The copy control every code block carries, inset at its top-right (D122).
 *
 * It sits on the block rather than beside the tab strip because the affordance
 * belongs to the thing it copies. There is no textual `Copy` next to the tabs,
 * and the receive-url `Copy` is a different control on a different surface.
 *
 * Two rules here are the interface's honesty rather than its polish:
 *
 * - **the checkmark follows the promise, never the click.** A clipboard write
 *   can be refused by the browser, and a checkmark shown regardless would lie
 *   about the one thing the user needs to know;
 * - **empty content is not copyable**, so the control renders disabled rather
 *   than writing an empty string.
 *
 * Both outcomes are also said in words, by `CopyStatus`: the glyph is
 * `aria-hidden`, so otherwise a screen-reader user would be told nothing at
 * all - including on the refusal path.
 *
 * It carries the block's own background so that text scrolled underneath it is
 * never legible through it, which is the "must not overlap the block's text"
 * half of D122 that CSS has to keep rather than a function.
 */
export function CopyCodeButton({ text, label, className }: CopyCodeButtonProps) {
  const m = useMessages();
  // The write and its outcome are shared with the request actions, `Copy link`
  // and `Copy as cURL` (D167, D182), so the copies cannot drift apart.
  const { outcome, copy } = useClipboardCopy();

  const copied = outcome === 'copied';

  return (
    <>
      <button
        type="button"
        // `title` as well as `aria-label`: the control is an icon, so the name is
        // the only thing that says what it copies to either kind of reader.
        title={label}
        aria-label={label}
        disabled={text.length === 0}
        onClick={() => void copy(text)}
        className={cn(
          'relative flex size-7 items-center justify-center rounded-[5px] bg-code text-ink-muted',
          // A 44 px hit area around the 28 px icon below 1024 px, where it is
          // tapped rather than clicked; it draws nothing (D157).
          'max-lg:before:absolute max-lg:before:-inset-2',
          'transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent',
          'disabled:cursor-default disabled:text-ink-mark/40 disabled:hover:text-ink-mark/40',
          copied && 'text-ok hover:text-ok',
          className,
        )}
      >
        {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      </button>

      {/* Said when the browser refuses the write: the block is still on screen. */}
      <CopyStatus outcome={outcome} refused={m.copy.blockRefused} />
    </>
  );
}
