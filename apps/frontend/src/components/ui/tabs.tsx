import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex gap-6 border-y border-line-tabs px-5', className)}
      {...props}
    />
  );
}

/**
 * A tab with an underline indicator (D113). The active tab's underline runs
 * 12 px past each side of its label, as the approved design has always drawn
 * it, so it is easier to spot than a line exactly as wide as the word (issue
 * #51, D158, reversing that departure in D071). Every tab row has at least
 * 16 px of padding, so the overhang never leaves the row. A tab that fills
 * its share of the row - the phone's `Request` / `Response` - draws the
 * underline across the whole tab instead, by overriding `after:inset-x`.
 */
export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative -mb-px py-3 text-[13px] font-medium text-ink-muted transition-colors',
        'hover:text-ink data-[state=active]:font-semibold data-[state=active]:text-brand',
        'after:absolute after:-inset-x-3 after:bottom-0 after:h-[3px] after:rounded-[1.5px]',
        'data-[state=active]:after:bg-accent',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('px-5 pb-5 pt-[18px]', className)} {...props} />;
}
