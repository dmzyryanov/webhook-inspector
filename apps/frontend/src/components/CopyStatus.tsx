import type { CopyOutcome } from '../hooks/useClipboardCopy.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';

interface CopyStatusProps {
  outcome: CopyOutcome;
  /** What a refusal means for this control's reader, since nothing is shown for it. */
  refused: string;
}

/**
 * A copy control's outcome said in words (D122, D167).
 *
 * The visible confirmation is a colour and a glyph, and the glyph is
 * `aria-hidden`, so without this a screen-reader user is told nothing at all -
 * the refusal included. It is filled from the same place the control changes:
 * after the clipboard promise settles, either way.
 *
 * Always in the document, with only its text changing: a live region inserted
 * at the moment it has something to say is announced by fewer screen readers
 * than one that was already there. `sr-only` keeps it out of the layout.
 */
export function CopyStatus({ outcome, refused }: CopyStatusProps) {
  const m = useMessages();

  return (
    <span role="status" className="sr-only">
      {outcome === 'copied' ? m.copy.copied : outcome === 'refused' ? refused : ''}
    </span>
  );
}
