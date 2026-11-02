import { useCallback, useEffect, useRef, useState } from 'react';

/** What the last write did, which the control shows and its live region says. */
export type CopyOutcome = 'idle' | 'copied' | 'refused';

/**
 * How long an outcome stays up, matching the receive-url `Copy` button. Shared
 * by every copy control, so a code box's icon holds its check exactly as long
 * as every other one (D122).
 */
export const COPY_CONFIRMATION_MS = 1_500;

/**
 * A clipboard write and its outcome, for the code boxes' copy controls (D122)
 * and the request actions, `Copy link` and `Copy as cURL` (D167, D182).
 *
 * **The outcome follows the promise, never the click.** A clipboard write can
 * be refused by the browser, and a confirmation shown regardless would lie
 * about the one thing the user needs to know; a refusal is `refused`, which a
 * code box shows as nothing at all and says in words through `CopyStatus`.
 *
 * `copy` also answers with the outcome, once the write has settled, for a
 * control that is gone by then: a menu item closes its menu, so the request
 * actions confirm with a toast instead (D182).
 */
export function useClipboardCopy(): {
  outcome: CopyOutcome;
  copy: (text: string) => Promise<Exclude<CopyOutcome, 'idle'>>;
} {
  const [outcome, setOutcome] = useState<CopyOutcome>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string): Promise<Exclude<CopyOutcome, 'idle'>> => {
    let next: Exclude<CopyOutcome, 'idle'> = 'copied';

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Refused, so nothing is claimed.
      next = 'refused';
    }

    setOutcome(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOutcome('idle'), COPY_CONFIRMATION_MS);

    return next;
  }, []);

  return { outcome, copy };
}
