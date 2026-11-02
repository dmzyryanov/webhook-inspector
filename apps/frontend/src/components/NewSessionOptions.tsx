import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, LockKeyhole } from 'lucide-react';
import { useId, useRef, useState, type TouchEvent } from 'react';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import {
  SESSION_WINDOWS,
  triggerName,
  triggerValues,
  windowLabel,
  type NewSessionOptions as Options,
} from '../lib/session-options.ts';

interface NewSessionOptionsProps {
  options: Options;
  onChange: (options: Options) => void;
  /** A creation is in flight: the trigger is disabled with the tile. */
  disabled: boolean;
  className?: string;
}

/**
 * The new session's options from 768 px (issue #216, D249; Figma `819:99`,
 * `825:77`, `825:160`): the right end of the split tile, and the menu it opens
 * under the tile, right-aligned, in the style of the request's `Actions` menu.
 * The trigger always shows both values, muted while both are the defaults and
 * in ink once either differs. Its first 1.5 px are the divider, the tile's
 * full height dashed as its border is (`Divider`, issue #248), with 16 px
 * before the values (issue #246), so its hover starts at the line.
 *
 * Choosing does not close the menu: a window is a radio item, the address
 * and `Private session` checkbox items, each keeping the menu open
 * (`preventDefault` on select). `Private session` is last, below the address,
 * the lock before its words (R1, issue #228, D259). Escape and a click
 * outside close it, and focus returns to the trigger.
 */
export function OptionsMenu({ options, onChange, disabled, className }: NewSessionOptionsProps) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const ipLabelId = useId();
  const ipHintId = useId();
  const privateLabelId = useId();
  const privateHintId = useId();

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        disabled={disabled}
        aria-label={triggerName(options, m)}
        className={cn(
          // Opaque and starting at the divider, so the tile's own hover stops
          // at the line and the trigger's fills from it to the right end.
          'flex items-center gap-4 rounded-r-[7px] bg-canvas pr-4',
          'transition-colors hover:bg-row-pick-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          className,
        )}
      >
        <Divider />
        <TriggerValues options={options} open={open} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-40 w-[268px] rounded-[8px] border border-line bg-white py-1.5 shadow-[0_12px_32px_rgba(31,36,46,0.16)]"
        >
          <DropdownMenu.Label
            id={titleId}
            className="pb-1 pl-3.5 pr-4 pt-2 text-[11px] font-semibold uppercase leading-[15px] tracking-[0.04em] text-ink-muted"
          >
            {m.newSession.expiresTitle}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            aria-labelledby={titleId}
            value={String(options.idleSeconds)}
            onValueChange={(value) => onChange({ ...options, idleSeconds: Number(value) })}
          >
            {SESSION_WINDOWS.map((seconds) => (
              <DropdownMenu.RadioItem
                key={seconds}
                value={String(seconds)}
                onSelect={(event) => event.preventDefault()}
                className="flex h-8 cursor-default select-none items-center gap-2.5 pl-3.5 pr-4 text-[13px] leading-[18px] text-ink outline-none data-[highlighted]:bg-field data-[state=checked]:font-medium"
              >
                <span aria-hidden="true" className="w-3 shrink-0 font-semibold text-link">
                  <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
                </span>
                {windowLabel(seconds, m)}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1.5 h-px bg-line-header" />
          <DropdownMenu.CheckboxItem
            checked={options.storeSourceIp}
            onCheckedChange={(checked) => onChange({ ...options, storeSourceIp: checked })}
            onSelect={(event) => event.preventDefault()}
            aria-labelledby={ipLabelId}
            aria-describedby={ipHintId}
            className="flex cursor-default select-none items-start gap-2.5 pb-2 pl-3 pr-4 pt-1.5 outline-none data-[highlighted]:bg-field"
          >
            <CheckboxBox checked={options.storeSourceIp} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span id={ipLabelId} className="text-[13px] font-medium leading-[18px] text-ink">
                {m.newSession.storeIp}
              </span>
              <span id={ipHintId} className="text-[12px] leading-[17px] text-ink-muted">
                {m.newSession.storeIpHint}
              </span>
            </span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator className="my-1.5 h-px bg-line-header" />
          <DropdownMenu.CheckboxItem
            checked={options.private}
            onCheckedChange={(checked) => onChange({ ...options, private: checked })}
            onSelect={(event) => event.preventDefault()}
            aria-labelledby={privateLabelId}
            aria-describedby={privateHintId}
            className="flex cursor-default select-none items-start gap-2.5 pb-2 pl-3 pr-4 pt-1.5 outline-none data-[highlighted]:bg-field"
          >
            <CheckboxBox checked={options.private} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span
                id={privateLabelId}
                className="flex items-center gap-1.5 text-[13px] font-medium leading-[18px] text-ink"
              >
                <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0" />
                {m.newSession.privateSession}
              </span>
              <span id={privateHintId} className="text-[12px] leading-[17px] text-ink-muted">
                {m.newSession.privateHint}
              </span>
            </span>
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The tile border's stroke inside the tile: 1.5 px, 6 px dashes, 4 px gaps. */
const DIVIDER_STROKE = { stroke: 'currentColor', strokeWidth: 1.5, strokeDasharray: '6 4' };

/**
 * The line that splits the tile from 768 px (issue #248, the owner's A1): the
 * trigger's first 1.5 px, the tile's full height, dashed exactly as the tile's
 * border is, in the same stroke, dashes and `--color-tile-dash`. Like the
 * border it is an SVG stroke rather than `border-dashed`, whose dash length
 * each browser picks for itself. It meets the border top and bottom (issue
 * #246), and the trigger's opaque background shows through its gaps, so each
 * part's hover still ends at the line.
 *
 * Two lines, one from each end of the tile to its middle, so a whole dash
 * starts at the border at both ends whatever the height: at the returning
 * visitor's 56 px the dashes run unbroken, and at the first visit's 64 px the
 * middle one is 4 px. The SVG is placed absolutely in the span that holds the
 * line's place in the trigger's row, so an SVG's default 150 px height never
 * reaches the tile's grid row. It does not clip its stroke (`overflow-visible`):
 * the browser snaps an SVG's clip to whole device pixels, and wherever the
 * trigger's left edge fell at half a pixel or more that 1.5 px box was cut to
 * 1 px, so the line was drawn thinner than the border beside it.
 */
function Divider() {
  return (
    <span aria-hidden="true" className="relative w-[1.5px] shrink-0 self-stretch">
      <svg className="absolute inset-0 size-full overflow-visible text-tile-dash">
        <line x1="0.75" y1="0" x2="0.75" y2="50%" {...DIVIDER_STROKE} />
        <line x1="0.75" y1="100%" x2="0.75" y2="50%" {...DIVIDER_STROKE} />
      </svg>
    </span>
  );
}

/** How far down a touch must travel on the sheet to close it. */
const SWIPE_CLOSE_PX = 64;

/**
 * The new session's options below 768 px (Figma `826:14`, `826:61`,
 * `826:357`): a line 8 px under the whole tile, right-aligned, whose 18 px
 * reach 44 px of target above and below, and the bottom sheet it opens in the
 * style of #71's actions sheet: a grabber, the heading, 48 px rows at 15 px,
 * the checkbox row last.
 *
 * Choosing does not close it. A tap on the scrim, Escape or a swipe down
 * does, and focus returns to the trigger. The windows are native radio
 * buttons, the address and `Private session` native checkboxes, the latter
 * last at the sheet's 48 px rows (D259), so the keys and the roles are the
 * browser's own.
 */
export function OptionsSheet({ options, onChange, disabled }: NewSessionOptionsProps) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const ipLabelId = useId();
  const ipHintId = useId();
  const privateLabelId = useId();
  const privateHintId = useId();
  const radioName = useId();
  const touchStart = useRef<number | null>(null);

  function startSwipe(event: TouchEvent<HTMLDivElement>): void {
    touchStart.current = event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null;
  }

  function endSwipe(event: TouchEvent<HTMLDivElement>): void {
    const start = touchStart.current;
    const end = event.changedTouches[0]?.clientY;

    touchStart.current = null;

    // Only from the sheet's top: a sheet scrolled down is scrolled back first.
    if (
      start !== null &&
      end !== undefined &&
      end - start >= SWIPE_CLOSE_PX &&
      event.currentTarget.scrollTop <= 0
    ) {
      setOpen(false);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <div className="mt-2 flex justify-end">
        <DialogPrimitive.Trigger
          disabled={disabled}
          aria-label={triggerName(options, m)}
          className={cn(
            'relative flex items-center gap-1.5 rounded-[4px] disabled:opacity-60',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            // 44 px of target: 8 px up to the tile, 18 px down.
            'before:absolute before:inset-x-0 before:-top-2 before:-bottom-[18px]',
          )}
        >
          <TriggerValues options={options} open={open} />
        </DialogPrimitive.Trigger>
      </div>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onTouchStart={startSwipe}
          onTouchEnd={endSwipe}
          onTouchCancel={() => {
            touchStart.current = null;
          }}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain rounded-t-2xl bg-white px-2 pb-6 pt-2"
        >
          <div aria-hidden="true" className="flex justify-center pb-2 pt-1">
            <span className="h-1 w-9 rounded-[2px] bg-line" />
          </div>
          <DialogPrimitive.Title className="sr-only">{m.newSession.options}</DialogPrimitive.Title>
          <p id={titleId} className="pb-1 pl-3 text-[13px] font-semibold leading-4 text-ink-muted">
            {m.newSession.expiresTitle}
          </p>
          <div role="radiogroup" aria-labelledby={titleId}>
            {SESSION_WINDOWS.map((seconds) => {
              const checked = options.idleSeconds === seconds;

              return (
                <label
                  key={seconds}
                  className={cn(
                    'flex h-12 items-center gap-3 rounded-[6px] px-3 text-[15px] text-ink',
                    'active:bg-row-selected has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent',
                    checked && 'bg-field font-medium',
                  )}
                >
                  <input
                    type="radio"
                    name={radioName}
                    value={seconds}
                    checked={checked}
                    onChange={() => onChange({ ...options, idleSeconds: seconds })}
                    className="sr-only"
                  />
                  <span aria-hidden="true" className="w-4 shrink-0 font-semibold text-link">
                    {checked ? '✓' : ''}
                  </span>
                  {windowLabel(seconds, m)}
                </label>
              );
            })}
          </div>
          <div role="separator" className="my-1 h-px bg-line" />
          <label className="flex items-start gap-3 rounded-[6px] px-3 py-3 active:bg-row-selected has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent">
            <input
              type="checkbox"
              checked={options.storeSourceIp}
              onChange={(event) => onChange({ ...options, storeSourceIp: event.target.checked })}
              aria-labelledby={ipLabelId}
              aria-describedby={ipHintId}
              className="sr-only"
            />
            <CheckboxBox checked={options.storeSourceIp} />
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span id={ipLabelId} className="text-[15px] leading-[18px] text-ink">
                {m.newSession.storeIp}
              </span>
              <span id={ipHintId} className="text-[13px] leading-[18px] text-ink-muted">
                {m.newSession.storeIpHint}
              </span>
            </span>
          </label>
          <div role="separator" className="my-1 h-px bg-line" />
          <label className="flex items-start gap-3 rounded-[6px] px-3 py-3 active:bg-row-selected has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent">
            <input
              type="checkbox"
              checked={options.private}
              onChange={(event) => onChange({ ...options, private: event.target.checked })}
              aria-labelledby={privateLabelId}
              aria-describedby={privateHintId}
              className="sr-only"
            />
            <CheckboxBox checked={options.private} />
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span
                id={privateLabelId}
                className="flex items-center gap-1.5 text-[15px] leading-[18px] text-ink"
              >
                <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0" />
                {m.newSession.privateSession}
              </span>
              <span id={privateHintId} className="text-[13px] leading-[18px] text-ink-muted">
                {m.newSession.privateHint}
              </span>
            </span>
          </label>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The trigger's text: both values, the `·` between them, the lock after them
 * for a private session (R1, D259) and the caret.
 */
function TriggerValues({ options, open }: { options: Options; open: boolean }) {
  const m = useMessages();
  const values = triggerValues(options, m);
  const value = values.chosen ? 'font-medium text-brand' : 'text-ink-muted';

  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[13px] leading-[18px]">
      <span className={value}>{values.window}</span>
      <span aria-hidden="true" className="text-ink-muted">
        ·
      </span>
      <span className={value}>{values.address}</span>
      {values.private ? (
        <>
          <span aria-hidden="true" className="text-ink-muted">
            ·
          </span>
          <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0 text-ink" />
        </>
      ) : null}
      <span aria-hidden="true" className="text-[10px] text-ink-muted">
        {open ? '▴' : '▾'}
      </span>
    </span>
  );
}

/** The 16 px box the frames draw, ticked in the link colour. */
function CheckboxBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'mt-px flex size-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px]',
        checked ? 'border-link bg-link text-white' : 'border-tile-dash bg-white',
      )}
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}
