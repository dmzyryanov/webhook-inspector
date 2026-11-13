import { useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn.ts';

interface SegmentedControlProps<T extends string> {
  /** Names the group for assistive technology; the design shows it beside or above. */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /**
   * `sm` in the quick switch (frame C1 of the Figma page `Webhook Inspector ·
   * Editable response settings`), `md` in the full editor (frame D2 of that
   * page), `check` for the algorithm of `Check signature…` (frames B1-B5 of the
   * Figma page `Webhook Inspector · Check signature`, D197).
   */
  size: 'sm' | 'md' | 'check';
}

/**
 * Two or more mutually exclusive choices drawn as one pill, the chosen one
 * raised on white: the design's Default / Custom control.
 *
 * A radio group underneath, so it is announced as one choice among several and
 * the arrow keys move between the options, as they do in any radio group; only
 * the chosen option is in the tab order.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  size,
}: SegmentedControlProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function move(event: KeyboardEvent<HTMLDivElement>): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;

    if (step === 0) {
      return;
    }

    event.preventDefault();

    const current = options.findIndex((option) => option.value === value);
    const next = (current + step + options.length) % options.length;
    const option = options[next];

    if (option !== undefined) {
      onChange(option.value);
      buttons.current[next]?.focus();
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
      className={cn(
        'inline-flex shrink-0 rounded-[7px] bg-panel-note',
        // Below 1024 px the options are touch targets (D157): the quick
        // switch's pill grows to 36 px (frame 5B of the Figma page `Webhook
        // Inspector · Tablet and phone`), and the full editor's to 44 px,
        // across the whole sheet on a phone (frame 5D of that page). The
        // algorithm's is 32 px on the desktop and 40 px below 1024 px, across
        // the sheet on a phone.
        size === 'sm'
          ? 'gap-0.5 p-0.5 max-lg:p-[3px]'
          : size === 'md'
            ? 'gap-0.5 p-[3px] max-md:flex max-md:w-full'
            : 'gap-0.5 p-0.5 max-md:flex max-md:w-full',
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;

        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-[6px] font-medium transition-colors',
              // A 44 px tap area around the drawn option below 1024 px,
              // reaching past the pill vertically only (D157).
              'max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0',
              size === 'sm'
                ? 'max-lg:before:-inset-y-[7px]'
                : size === 'md'
                  ? 'max-lg:before:-inset-y-[3px]'
                  : 'max-lg:before:-inset-y-1',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              size === 'sm'
                ? 'h-[25px] px-3 text-[12px] leading-[17px] max-lg:h-[30px] max-lg:px-3.5 max-lg:text-[13px]'
                : size === 'md'
                  ? 'h-[30px] px-4 text-[13px] leading-[18px] max-lg:h-[38px] max-md:flex-1'
                  : 'h-7 px-3 text-[13px] leading-[18px] max-lg:h-9 max-md:flex-1 max-md:text-[15px] max-md:leading-[21px]',
              checked
                ? 'bg-white text-ink shadow-[0_1px_2px_rgba(31,36,46,0.12)]'
                : 'text-ink-muted hover:text-ink',
              // The algorithm's chosen option is semibold and the others
              // regular, and its shadow a shade darker (frame B1 of the Figma
              // page `Webhook Inspector · Check signature`).
              size === 'check' &&
                (checked ? 'font-semibold shadow-[0_1px_2px_rgba(31,36,46,0.14)]' : 'font-normal'),
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
