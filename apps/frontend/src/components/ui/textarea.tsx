import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * 16 px text on a phone, and drawn at 60 % when disabled, for the reasons
 * `Input` gives (D157, issue #250).
 */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-y rounded-[7px] border border-line-soft bg-field px-3 py-2 text-[13px]',
        'text-ink-strong placeholder:text-ink-muted focus-visible:outline-2',
        'focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60',
        'max-md:text-[16px]',
        className,
      )}
      {...props}
    />
  );
}
