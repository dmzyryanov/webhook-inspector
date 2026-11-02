import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { useMessages } from '../../i18n/LanguageProvider.tsx';
import { cn } from '../../lib/cn.ts';

/**
 * Radix handles focus trapping, focus return, Escape, scroll locking and the
 * aria wiring; only the appearance is ours.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * What a dialog becomes on a phone, below 768 px (D157). From 768 px up every
 * dialog keeps its desktop size.
 *
 * - `dialog`: still a centred dialog, 16 px from each edge. `Delete all`.
 * - `sheet`: a full-screen sheet. Its title bar (`DialogHeading`) sticks to
 *   the top with a close control, the form scrolls, and its actions
 *   (`SHEET_ACTIONS`) are pinned to the bottom. The full response editor.
 */
type PhoneForm = 'dialog' | 'sheet';

const PHONE_FORM: Record<PhoneForm, string> = {
  dialog: 'max-md:w-[calc(100%-32px)] max-md:rounded-xl max-md:p-5',
  sheet:
    'max-md:inset-0 max-md:flex max-md:max-h-none max-md:w-auto max-md:translate-none ' +
    'max-md:flex-col max-md:overflow-y-auto max-md:overscroll-contain max-md:rounded-none ' +
    'max-md:px-4 max-md:py-0 max-md:shadow-none ' +
    // A field scrolled into view - by Tab, or by a failed submit focusing
    // the first error - stops clear of the sticky title bar and the pinned
    // actions rather than under them.
    'max-md:scroll-pt-16 max-md:scroll-pb-24',
};

export function DialogContent({
  className,
  children,
  phone = 'dialog',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { phone?: PhoneForm }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 bg-ink/35" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 w-[404px] -translate-x-1/2 -translate-y-1/2 rounded-[10px]',
          'bg-white p-6 shadow-[0_18px_48px_rgba(31,36,46,0.18)]',
          PHONE_FORM[phone],
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-[17px] font-semibold text-ink', className)}
      {...props}
    />
  );
}

interface DialogHeadingProps {
  children: ReactNode;
  /** Classes for the title itself, as `DialogTitle` takes them. */
  className?: string;
  /** While a save is in flight nothing closes the sheet, this control included. */
  closeDisabled?: boolean;
}

/**
 * A sheet's title. From 768 px up it is exactly `DialogTitle`, in a wrapper
 * that draws nothing. On a phone it is the sheet's bar: 56 px, the title at
 * 17 px, a 44 px close control, and it stays at the top while the form scrolls
 * under it (frames 5D; and 1B, now removed, D158).
 */
export function DialogHeading({ children, className, closeDisabled }: DialogHeadingProps) {
  const m = useMessages();

  return (
    <div className="max-md:sticky max-md:top-0 max-md:z-10 max-md:-mx-4 max-md:flex max-md:h-14 max-md:shrink-0 max-md:items-center max-md:justify-between max-md:gap-2 max-md:border-b max-md:border-line-header max-md:bg-white max-md:pl-4 max-md:pr-1">
      <DialogTitle
        className={cn(className, 'max-md:min-w-0 max-md:text-[17px] max-md:leading-normal')}
      >
        {children}
      </DialogTitle>
      <DialogPrimitive.Close
        aria-label={m.common.close}
        disabled={closeDisabled}
        className="hidden size-11 shrink-0 items-center justify-center rounded-[7px] text-[22px] leading-none text-ink-mark focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 max-md:flex"
      >
        ×
      </DialogPrimitive.Close>
    </div>
  );
}

/**
 * A sheet's actions, pinned to the bottom of a phone's screen: pushed down
 * when the form is short, stuck to the bottom edge while a long one scrolls
 * (frames 5D, 5E; and 1B, now removed, D158). From 768 px up these classes
 * do nothing.
 */
export const SHEET_ACTIONS =
  'max-md:sticky max-md:bottom-0 max-md:z-10 max-md:-mx-4 max-md:mt-auto max-md:border-t ' +
  'max-md:border-line-header max-md:bg-white max-md:px-4 max-md:py-3.5';

/** Each of a sheet's actions takes half the bar on a phone. */
export const SHEET_ACTION = 'max-md:min-w-0 max-md:flex-1';

/**
 * The space a phone sheet keeps between its last field and its pinned actions
 * when the form is long enough to reach them. It draws nothing from 768 px up.
 */
export function SheetSpacer() {
  return <div aria-hidden="true" className="hidden max-md:block max-md:h-6 max-md:shrink-0" />;
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('mt-3 text-[13px] leading-[1.5] text-ink-muted', className)}
      {...props}
    />
  );
}
