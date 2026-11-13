import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { Fragment, useState } from 'react';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import {
  HINT_EXAMPLE,
  PLACEHOLDER_CHOICES,
  textParts,
  type PlaceholderChoice,
} from '../lib/response-template.ts';

interface TemplateControlProps {
  /** The checkbox's DOM id. */
  id: string;
  /** Whether the body is a template: the box ticked. */
  template: boolean;
  onTemplateChange: (template: boolean) => void;
  /** The body's byte counter, which shares the control's line. */
  counter: string;
  /** Inserts a placeholder at the body's caret, in place of a selection. */
  onInsert: (choice: PlaceholderChoice) => void;
  /**
   * Puts focus back in the body, its caret where the insertion left it;
   * `false` when nothing was inserted, so focus returns to the menu button.
   */
  onReturnFocus: () => boolean;
}

/**
 * The opt-in under the body of a response, and what it brings (issue #236,
 * D251; frames T1-T12 of the Figma page `Webhook Inspector · Response body
 * templates (#236) — approved A`): one control in `ResponseFields`, so the
 * session response editor, a step of the queue and a rule's response match.
 *
 * Unticked - the default - it is the checkbox on the left and the byte
 * counter on the right, on the line `Returned exactly as entered` held before
 * (T1), so it costs no height from 768 px. Ticked, `Insert placeholder ▾`
 * follows the label 16 px after it and one hint line comes under the row
 * (T2): +21 px. Where a column is too narrow for one line - the tablet's
 * queue and rules step editors - the counter wraps under the controls.
 *
 * On a phone (T4, T5, T9, T11) it is a 44 px checkbox row, the hint, and a
 * 44 px row with `Insert placeholder ▾` on the left and the counter on the
 * right; unticked, the checkbox row and the counter line. The list is the
 * Actions menu's dropdown from 768 px (T6) and a bottom sheet like the Actions
 * sheet below (T7). A choice inserts at the caret and focus returns to the
 * body; Escape or a click outside returns it to the button.
 */
export function TemplateControl({
  id,
  template,
  onTemplateChange,
  counter,
  onInsert,
  onReturnFocus,
}: TemplateControlProps) {
  const m = useMessages();
  const phone = usePhoneLayout();
  const checkbox = (
    <TemplateCheckbox id={id} checked={template} onChange={onTemplateChange} phone={phone} />
  );
  const hint = (
    <p data-testid="template-hint" className="text-[12px] leading-[17px] text-ink-muted">
      <CodeText text={m.template.hint(HINT_EXAMPLE)} />
    </p>
  );
  const counterLine = (
    <p className="shrink-0 text-[12px] leading-[17px] text-ink-muted">{counter}</p>
  );

  if (phone) {
    return (
      <div className="mt-2">
        {checkbox}
        {template ? (
          <>
            {hint}
            <div className="flex min-h-11 items-center justify-between gap-3">
              <PlaceholderSheet onInsert={onInsert} onReturnFocus={onReturnFocus} />
              {counterLine}
            </div>
          </>
        ) : (
          <div className="flex justify-end">{counterLine}</div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {checkbox}
          {template ? <PlaceholderMenu onInsert={onInsert} onReturnFocus={onReturnFocus} /> : null}
        </div>
        {counterLine}
      </div>
      {template ? <div className="mt-1">{hint}</div> : null}
    </div>
  );
}

interface TemplateCheckboxProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  phone: boolean;
}

/**
 * `Fill in placeholders from the request`: a native checkbox drawn as the
 * frames draw it - 16 px from 768 px and 20 px on a phone, radius 4, a
 * `--color-line-strong` border, and filled with the brand colour with a white
 * ✓ when ticked - its label 13/18, 14/20 on a phone in a 44 px row.
 */
function TemplateCheckbox({ id, checked, onChange, phone }: TemplateCheckboxProps) {
  const m = useMessages();

  return (
    <label
      htmlFor={id}
      className={cn(
        'flex min-w-0 cursor-pointer items-center text-ink',
        phone ? 'min-h-11 gap-2.5 text-[14px] leading-[20px]' : 'gap-2 text-[13px] leading-[18px]',
      )}
    >
      <span className="relative flex shrink-0">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className={cn(
            'peer m-0 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-line-strong bg-white',
            'checked:border-brand checked:bg-brand',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            'disabled:cursor-default disabled:opacity-60',
            phone ? 'size-5' : 'size-4',
          )}
        />
        <Check
          aria-hidden="true"
          strokeWidth={3}
          className={cn(
            'pointer-events-none absolute inset-0 m-auto text-white opacity-0 peer-checked:opacity-100',
            phone ? 'size-3.5' : 'size-3',
          )}
        />
      </span>
      {m.template.fill}
    </label>
  );
}

/** The three whole placeholders, then the three the user finishes, with a line between. */
const GROUPS: readonly (readonly PlaceholderChoice[])[] = [
  PLACEHOLDER_CHOICES.filter((choice) => !choice.stub),
  PLACEHOLDER_CHOICES.filter((choice) => choice.stub),
];

/** `Insert placeholder ▾`'s look: the link colour, medium, the `▾` after it. */
function TriggerLabel() {
  const m = useMessages();

  return (
    <>
      {m.template.insert}
      <span aria-hidden="true" className="ml-1 text-[10px] leading-none">
        ▾
      </span>
    </>
  );
}

interface MenuProps {
  onInsert: (choice: PlaceholderChoice) => void;
  onReturnFocus: () => boolean;
}

/**
 * The list from 768 px (frame T6 of the Figma page `Webhook Inspector ·
 * Response body templates (#236) — approved A`): the Actions menu's dropdown
 * under the button, left-aligned 4 px below it, 320 px wide, items 36 px with
 * the label at 13 px and the placeholder on the right in 12 px monospace.
 */
function PlaceholderMenu({ onInsert, onReturnFocus }: MenuProps) {
  const m = useMessages();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="inline-flex shrink-0 items-center whitespace-nowrap rounded-[4px] text-[13px] font-medium leading-[18px] text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-60">
        <TriggerLabel />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (onReturnFocus()) {
              event.preventDefault();
            }
          }}
          className="z-40 w-[320px] max-w-[calc(100vw-16px)] rounded-[8px] border border-line bg-white p-1.5 shadow-[0_12px_32px_rgba(31,36,46,0.16)]"
        >
          {GROUPS.map((group, index) => (
            <Fragment key={index}>
              {index > 0 ? <DropdownMenu.Separator className="my-1 h-px bg-line" /> : null}
              {group.map((choice) => (
                <DropdownMenu.Item
                  key={choice.key}
                  onSelect={() => onInsert(choice)}
                  className="flex h-9 cursor-default select-none items-center justify-between gap-3 rounded-[6px] px-2.5 text-[13px] text-ink outline-none data-[highlighted]:bg-row-selected"
                >
                  <span className="min-w-0 truncate">{m.template[choice.key]}</span>
                  <span className="shrink-0 font-mono text-[12px] text-ink-muted">
                    {choice.shown}
                  </span>
                </DropdownMenu.Item>
              ))}
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The list on a phone (frame T7 of the Figma page `Webhook Inspector · Response
 * body templates (#236) — approved A`): a bottom sheet like the Actions sheet,
 * titled `Insert placeholder`, its items 48 px with a 15 px label and the
 * placeholder on the right. A tap on the scrim or Escape closes it.
 */
function PlaceholderSheet({ onInsert, onReturnFocus }: MenuProps) {
  const m = useMessages();
  const [open, setOpen] = useState(false);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-[4px] text-[14px] font-medium leading-[20px] text-link focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-60">
        <TriggerLabel />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (onReturnFocus()) {
              event.preventDefault();
            }
          }}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain rounded-t-2xl bg-white px-2 pb-6 pt-2"
        >
          <div aria-hidden="true" className="flex justify-center pb-2 pt-1">
            <span className="h-1 w-9 rounded-[2px] bg-line" />
          </div>
          <DialogPrimitive.Title className="pb-1 pl-3 text-[13px] font-semibold leading-4 text-ink-muted">
            {m.template.insert}
          </DialogPrimitive.Title>
          {GROUPS.map((group, index) => (
            <Fragment key={index}>
              {index > 0 ? <div role="separator" className="mx-2 my-1 h-px bg-line" /> : null}
              {group.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onInsert(choice);
                  }}
                  className="flex h-12 w-full items-center justify-between gap-3 rounded-[6px] px-5 text-left text-[15px] text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent active:bg-row-selected"
                >
                  <span className="min-w-0 truncate">{m.template[choice.key]}</span>
                  <span className="shrink-0 font-mono text-[12px] text-ink-muted">
                    {choice.shown}
                  </span>
                </button>
              ))}
            </Fragment>
          ))}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A line with its placeholders in monospace, as the frames draw the hint and
 * the errors (frames T2 and T12 of the Figma page `Webhook Inspector · Response
 * body templates (#236) — approved A`): `{{request.id}}`, and a lone `{{` or
 * `}}`.
 */
export function CodeText({ text }: { text: string }) {
  return (
    <>
      {textParts(text).map((part, index) =>
        part.code ? (
          <span key={index} className="font-mono">
            {part.text}
          </span>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * `Template`, the quiet tag of a response that is one where it is summarised
 * (frames T13 and T14 of the Figma page `Webhook Inspector · Response body
 * templates (#236) — approved A`): 11/13 medium, muted, on `--color-panel-note`
 * with radius 4 and 2 × 6 padding - white on the quick switch's grey summary
 * box.
 */
export function TemplateTag({ onGrey = false }: { onGrey?: boolean }) {
  const m = useMessages();

  return (
    <span
      data-testid="template-tag"
      className={cn(
        'shrink-0 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium leading-[13px] text-ink-muted',
        onGrey ? 'bg-white' : 'bg-panel-note',
      )}
    >
      {m.template.tag}
    </span>
  );
}
