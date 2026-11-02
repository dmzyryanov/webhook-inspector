import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * The field styling of the endpoint card, applied to something editable.
 *
 * On a phone the text is 16 px: iOS Safari zooms the page into any field whose
 * text is smaller when it takes focus, and the page stays zoomed after. The
 * viewport is left alone, so pinch zoom keeps working (D157).
 *
 * Disabled, by its own prop or by a `<fieldset disabled>` around it, the whole
 * field is drawn at 60 %, as a disabled button is: its own fill and ink
 * outrank the browser's disabled look (issue #250).
 */
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'w-full rounded-[7px] border border-line-soft bg-field px-3 py-2 text-[13px] text-ink-strong',
        'placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1',
        'focus-visible:outline-accent disabled:opacity-60 max-md:h-11 max-md:text-[16px]',
        className,
      )}
      {...props}
    />
  );
}
