import { useRef, type ReactNode } from 'react';
import {
  MAX_RESPONSE_DELAY_MS,
  RESPONSE_STATUS_MAX,
  RESPONSE_STATUS_MIN,
} from '@webhook-inspector/shared';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import type { FormErrors, ResponseForm } from '../lib/response-config.ts';
import { formatBodyCounter, formatHeaderCounter } from '../lib/response-editor.ts';
import { insertPlaceholder, type PlaceholderChoice } from '../lib/response-template.ts';
import { CodeText, TemplateControl } from './TemplateControl.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';

interface ResponseFieldsProps {
  form: ResponseForm;
  errors: FormErrors;
  onEdit: (next: Partial<ResponseForm>) => void;
  /**
   * The DOM id of a field, by the key `firstErrorField` names it with, so a
   * failed save can move focus to the field that broke first.
   */
  fieldId: (key: string) => string;
  /**
   * Where the hints under the status and delay labels show: always, as in
   * the session response editor (D2), or on a phone only, as in a step of
   * the response queue (D1, M4).
   */
  hints?: 'always' | 'phone';
  /**
   * Whether the note about the automatic headers and the line about bodiless
   * statuses leave the tablet's narrower step editor (T2).
   */
  compactOnTablet?: boolean;
}

/** Where the body's selection was, and in which text: a range read in another text is stale. */
interface BodySelection {
  start: number;
  end: number;
  body: string;
}

/**
 * The fields of one custom response - status, delay, headers and body, and
 * whether the body is a template - with the response editor's validation
 * messages (D150, D158). The session response editor, each step of the
 * Response queue dialog and each rule of the Response rules dialog edit a
 * response with them (D205, D246), so they cannot drift apart: the template
 * control under the body is one control for all three (issue #236).
 */
export function ResponseFields({
  form,
  errors,
  onEdit,
  fieldId,
  hints = 'always',
  compactOnTablet = false,
}: ResponseFieldsProps) {
  const m = useMessages();
  const body = useRef<HTMLTextAreaElement>(null);
  // The body's caret or selection as last seen, which a placeholder replaces;
  // none yet, or one read in another text, puts it at the end.
  const selection = useRef<BodySelection | null>(null);
  // Where the caret goes once the list that inserted a placeholder has closed.
  const insertedCaret = useRef<number | null>(null);

  function rememberSelection(textarea: HTMLTextAreaElement): void {
    selection.current = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      body: textarea.value,
    };
  }

  function insert(choice: PlaceholderChoice): void {
    const seen = selection.current?.body === form.body ? selection.current : null;
    const end = form.body.length;
    const next = insertPlaceholder(form.body, seen?.start ?? end, seen?.end ?? end, choice);

    selection.current = { start: next.caret, end: next.caret, body: next.body };
    insertedCaret.current = next.caret;
    onEdit({ body: next.body });
  }

  function returnFocusToBody(): boolean {
    const caret = insertedCaret.current;
    const textarea = body.current;

    insertedCaret.current = null;

    if (caret === null || textarea === null) {
      return false;
    }

    textarea.focus();
    textarea.setSelectionRange(caret, caret);

    return true;
  }

  function editHeader(index: number, field: 'name' | 'value', value: string): void {
    onEdit({
      headers: form.headers.map((row, position) =>
        position === index ? { ...row, [field]: value } : row,
      ),
    });
  }

  const tabletHidden = compactOnTablet ? 'md:max-lg:hidden' : undefined;

  return (
    <>
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1 max-md:gap-5">
        <Field
          id={fieldId('status')}
          label={m.fields.status}
          hint={m.fields.statusHint(RESPONSE_STATUS_MIN, RESPONSE_STATUS_MAX)}
          hintOnPhoneOnly={hints === 'phone'}
          error={errors.status}
        >
          <Input
            id={fieldId('status')}
            inputMode="numeric"
            value={form.status}
            aria-invalid={errors.status !== undefined}
            className={fieldClass(errors.status !== undefined)}
            onChange={(event) => onEdit({ status: event.target.value })}
          />
        </Field>

        <Field
          id={fieldId('delayMs')}
          label={m.fields.delay}
          hint={m.fields.delayHint(m.number(MAX_RESPONSE_DELAY_MS))}
          hintOnPhoneOnly={hints === 'phone'}
          error={errors.delayMs}
        >
          <Input
            id={fieldId('delayMs')}
            inputMode="numeric"
            value={form.delayMs}
            aria-invalid={errors.delayMs !== undefined}
            className={fieldClass(errors.delayMs !== undefined)}
            onChange={(event) => onEdit({ delayMs: event.target.value })}
          />
        </Field>
      </div>

      <div className="mt-5">
        <div className="flex items-baseline justify-between">
          <p className="text-[14px] font-medium leading-[20px] text-ink">{m.fields.headers}</p>
          <p className="text-[12px] leading-[17px] text-ink-muted">{formatHeaderCounter(form)}</p>
        </div>

        {form.headers.length === 0 ? null : (
          <div className="mt-2.5 flex flex-col gap-2.5">
            {form.headers.map((row, index) => {
              const rowErrors = errors.rows?.[index];

              return (
                <div key={index}>
                  <div className="flex items-end gap-3 max-md:gap-2">
                    <HeaderInput
                      id={fieldId(`header-name-${index}`)}
                      index={index}
                      field="name"
                      value={row.name}
                      invalid={rowErrors?.name !== undefined}
                      onChange={(value) => editHeader(index, 'name', value)}
                    />
                    <HeaderInput
                      id={fieldId(`header-value-${index}`)}
                      index={index}
                      field="value"
                      value={row.value}
                      invalid={rowErrors?.value !== undefined}
                      onChange={(value) => editHeader(index, 'value', value)}
                    />
                    {/* On a phone a 44 px `×` (5D); the accessible
                        name is the same. */}
                    <Button
                      type="button"
                      variant="quiet"
                      aria-label={m.fields.removeHeader(index + 1)}
                      className="h-[38px] w-[82px] shrink-0 py-0 font-medium leading-[18px] max-md:size-11 max-md:px-0 max-md:text-[18px] max-md:font-normal max-md:text-ink-mark"
                      onClick={() =>
                        onEdit({
                          headers: form.headers.filter((_unused, position) => position !== index),
                        })
                      }
                    >
                      <span className="max-md:hidden">{m.fields.remove}</span>
                      <span aria-hidden="true" className="hidden max-md:inline">
                        ×
                      </span>
                    </Button>
                  </div>
                  {rowErrors?.name ? <FieldError>{rowErrors.name}</FieldError> : null}
                  {rowErrors?.value ? <FieldError>{rowErrors.value}</FieldError> : null}
                </div>
              );
            })}
          </div>
        )}

        {errors.headers ? <FieldError>{errors.headers}</FieldError> : null}

        <Button
          type="button"
          variant="quiet"
          className="mt-2.5 h-[38px] py-0 font-medium leading-[18px]"
          onClick={() => onEdit({ headers: [...form.headers, { name: '', value: '' }] })}
        >
          {m.fields.addHeader}
        </Button>

        <p className={cn('mt-2.5 text-[12px] leading-[17px] text-ink-muted', tabletHidden)}>
          {m.editor.automaticHeaders}
        </p>
      </div>

      <div className="mt-5">
        <label
          htmlFor={fieldId('body')}
          className="block text-[13px] font-medium leading-[18px] text-ink"
        >
          {m.editor.bodyLabel}
        </label>
        {/* A plain monospace text area: placeholders are not highlighted. */}
        <Textarea
          ref={body}
          id={fieldId('body')}
          rows={3}
          spellCheck={false}
          value={form.body}
          aria-invalid={errors.body !== undefined}
          className={cn(
            'mt-2.5 min-h-[80px] font-mono',
            errors.body !== undefined ? 'border-danger' : 'border-line',
          )}
          onChange={(event) => {
            onEdit({ body: event.target.value });
            rememberSelection(event.target);
          }}
          onSelect={(event) => rememberSelection(event.currentTarget)}
        />
        {/* A template's placeholder is named in monospace (T12). */}
        {errors.body ? (
          <FieldError>
            <CodeText text={errors.body} />
          </FieldError>
        ) : null}
        <TemplateControl
          id={fieldId('template')}
          template={form.template}
          onTemplateChange={(template) => onEdit({ template })}
          counter={formatBodyCounter(form.body, m)}
          onInsert={insert}
          onReturnFocus={returnFocusToBody}
        />
        <p
          className={cn(
            'mt-2 text-[12px] leading-[17px] text-ink-muted',
            tabletHidden,
            hints === 'phone' ? 'max-md:hidden' : undefined,
          )}
        >
          {m.fields.bodilessStatuses}
        </p>
      </div>
    </>
  );
}

function fieldClass(invalid: boolean): string {
  return cn('h-[38px] bg-white', invalid ? 'border-danger' : 'border-line');
}

interface FieldProps {
  id: string;
  label: string;
  hint: string;
  hintOnPhoneOnly: boolean;
  error: string | undefined;
  children: ReactNode;
}

function Field({ id, label, hint, hintOnPhoneOnly, error, children }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium leading-[18px] text-ink">
        {label}
      </label>
      <p
        className={cn(
          'mt-1.5 text-[12px] leading-[17px] text-ink-muted',
          hintOnPhoneOnly ? 'hidden max-md:block' : undefined,
        )}
      >
        {hint}
      </p>
      <div className="mt-2">{children}</div>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-[12px] leading-[17px] text-danger">{children}</p>;
}

interface HeaderInputProps {
  id: string;
  index: number;
  field: 'name' | 'value';
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}

/** One header field. Only the first row carries the visible column names (D2). */
function HeaderInput({ id, index, field, value, invalid, onChange }: HeaderInputProps) {
  const m = useMessages();

  return (
    <div className="min-w-0 flex-1">
      {index === 0 ? (
        <p
          aria-hidden="true"
          className="mb-2 text-[13px] font-medium leading-[18px] text-ink max-md:mb-1.5 max-md:text-[12px] max-md:font-normal max-md:text-ink-muted"
        >
          {field === 'name' ? m.fields.name : m.fields.value}
        </p>
      ) : null}
      <Input
        id={id}
        aria-label={m.fields.headerField(index + 1, field)}
        aria-invalid={invalid}
        spellCheck={false}
        className={cn(fieldClass(invalid), 'font-mono')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
