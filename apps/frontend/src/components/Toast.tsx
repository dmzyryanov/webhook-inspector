import { Check, Info, LockKeyhole } from 'lucide-react';
import { useEffect } from 'react';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import type { Phrase } from '../i18n/en.ts';

/** How long a toast stays on screen before it goes by itself. */
const TOAST_MS = 5_000;

/**
 * A toast's icon: `check` confirms something that happened; `info` says
 * something did not - a copy the browser refused, a linked request that is
 * gone (D182); `lock` confirms a copied link with access (D259); `dot`, a
 * 10 px disc in the check's colour, says what a move link brought (Figma T of
 * `Webhook Inspector · Move banner (#321)`, D276).
 */
export type ToastIcon = 'check' | 'info' | 'lock' | 'dot';

/**
 * One toast. `id` tells two toasts with the same wording apart. `text` is a
 * phrase, written in the language shown while the toast is (D222).
 */
export interface ToastMessage {
  id: number;
  text: Phrase;
  icon?: ToastIcon;
}

interface ToastProps {
  /** The toast, or `null` for none. A new one replaces it and restarts the timer. */
  message: ToastMessage | null;
  onDismiss: () => void;
}

/**
 * The session page's one toast: a dark bar centred at the bottom of the window,
 * gone after a few seconds. It confirms a saved response change (frames C3 and
 * D3 of the Figma page `Webhook Inspector · Editable response settings`) and a
 * copy made from the request actions, and says when a copy was refused or a
 * linked request is no longer there (frames C3, S1 and S2 of the Figma page
 * `Webhook Inspector · Request actions`; D182). The page shows one at a time: a
 * new one replaces the one on screen. `App` draws one more, over whichever page
 * a move link opened, to say what the link brought (issue #321, D276).
 *
 * A polite live region, so the change is announced without taking focus from
 * wherever the viewer went next. A response change reports what is now
 * configured, never that a sender received anything (D103).
 *
 * On a phone it spans the screen 16 px from each edge and from the bottom, with
 * the same words (frame 5C of the Figma page `Webhook Inspector · Tablet and
 * phone`, D157).
 */
export function Toast({ message, onDismiss }: ToastProps) {
  const m = useMessages();

  useEffect(() => {
    if (message === null) {
      return;
    }

    const timer = window.setTimeout(onDismiss, TOAST_MS);

    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-10 z-50 flex justify-center max-md:inset-x-4 max-md:bottom-4"
    >
      {message === null ? null : (
        <p
          key={message.id}
          data-testid="toast"
          data-icon={message.icon ?? 'check'}
          className="flex items-center gap-2.5 rounded-[8px] bg-ink px-4 py-3 text-[13px] font-medium leading-[18px] text-white shadow-[0_12px_32px_rgba(31,36,46,0.24)] max-md:w-full"
        >
          {message.icon === 'info' ? (
            <Info aria-hidden="true" className="size-3.5 shrink-0 text-toast-info" />
          ) : message.icon === 'lock' ? (
            <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0 text-white" />
          ) : message.icon === 'dot' ? (
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-toast-check" />
          ) : (
            <Check
              aria-hidden="true"
              className="size-3.5 shrink-0 text-toast-check"
              strokeWidth={2.5}
            />
          )}
          {message.text(m)}
        </p>
      )}
    </div>
  );
}
