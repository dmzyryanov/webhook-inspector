import { useRef, useState, type FormEvent, type RefObject } from 'react';
import type { SessionResponseState } from '@webhook-inspector/shared';
import * as api from '../api/client.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import type { QuickCarry } from '../lib/quick-switch.ts';
import { firstErrorField, type ResponseForm } from '../lib/response-config.ts';
import {
  describeChangeFailure,
  editInEditor,
  editorView,
  evaluateEditorDraft,
  initialEditorDraft,
  shownChangeFailure,
  type EditorDraft,
  type HeldChangeFailure,
} from '../lib/response-editor.ts';
import {
  keptCustomResponse,
  staysOpen,
  type OwnAnswerHandler,
  type ResponseMode,
} from '../lib/session-response.ts';
import { ResponseFields } from './ResponseFields.tsx';
import { DISABLED_ACTION } from './SessionResponseSwitch.tsx';
import { Button } from './ui/button.tsx';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeading,
  SHEET_ACTION,
  SHEET_ACTIONS,
  SheetSpacer,
} from './ui/dialog.tsx';
import { SegmentedControl } from './ui/segmented.tsx';

/** The two modes the editor offers, named in the interface's language. */
const MODES = ['default', 'custom'] as const satisfies readonly ResponseMode[];

interface SessionResponseEditorProps {
  sessionId: string;
  state: SessionResponseState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * What the quick switch had chosen when its link opened this, if anything
   * (frame D2 of the Figma page `Webhook Inspector · Editable response settings`).
   */
  carry: QuickCarry | undefined;
  /** The page's response revision, read as a call starts (D152, D205). */
  responseRevision: () => number;
  /**
   * The change was saved; the answer is the state the session now has, with
   * the revision its call started at.
   */
  onSaved: OwnAnswerHandler;
  /** The session is gone: the page moves to `Session not found`. */
  onUnavailable: () => void;
  /** Where focus goes when the editor closes: the button it was reached from. */
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Session response settings, as a form (frames D1-D8 of the Figma page `Webhook
 * Inspector · Editable response settings`, D150). There is no read-only view
 * any more: the modal opens straight into the form, from the quick switch's
 * `Edit headers and body…`.
 *
 * The fields are the ones the landing page's create form had, checked by the
 * validator and with the wording it used (D158), and the backend checks a
 * change with the function it checks a creation with (D101). Errors are shown
 * as the fields are edited and Save is unavailable while any stands (frame D4).
 * While a save is in flight nothing closes the modal - Escape and a click on
 * the overlay are ignored and Cancel is disabled - so a failure is shown with
 * every change still in place (frame D8).
 *
 * On a phone it is a full-screen sheet with Cancel and Save pinned to the
 * bottom, its fields one under another (frames 5D-5F of the Figma page `Webhook
 * Inspector · Tablet and phone`); from 768 px up it is the desktop dialog
 * (frame 7E of that page, D157).
 */
export function SessionResponseEditor({
  sessionId,
  state,
  open,
  onOpenChange,
  carry,
  responseRevision,
  onSaved,
  onUnavailable,
  returnFocusRef,
}: SessionResponseEditorProps) {
  // Set by the panel while its save is in flight; read, not rendered.
  const saving = useRef(false);

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(staysOpen(next, saving.current))}>
      <DialogContent
        phone="sheet"
        aria-describedby="session-response-editor-description"
        className="max-h-[calc(100vh-48px)] w-[640px] overflow-y-auto md:max-lg:max-h-[calc(100dvh-48px)]"
        onCloseAutoFocus={(event) => {
          // The editor has no trigger of its own - it is opened from the quick
          // switch, which has closed by then - so focus is returned by hand to
          // the button both surfaces belong to.
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <EditorPanel
          sessionId={sessionId}
          state={state}
          carry={carry}
          responseRevision={responseRevision}
          onSaved={onSaved}
          onUnavailable={onUnavailable}
          onSavingChange={(busy) => {
            saving.current = busy;
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

type PanelProps = Pick<
  SessionResponseEditorProps,
  'sessionId' | 'state' | 'carry' | 'responseRevision' | 'onSaved' | 'onUnavailable'
> & { onSavingChange: (saving: boolean) => void };

function EditorPanel({
  sessionId,
  state,
  carry,
  responseRevision,
  onSaved,
  onUnavailable,
  onSavingChange,
}: PanelProps) {
  const m = useMessages();
  // `null` until the viewer edits anything, unless the quick switch handed over
  // a choice; `editorView` decides what is shown meanwhile and after (D152).
  const [draft, setDraft] = useState<EditorDraft | null>(() =>
    carry === undefined ? null : initialEditorDraft(state, carry),
  );
  const [saving, setSaving] = useState(false);
  // A failure is held, not its words, and described on render in the
  // language shown then (D222).
  const [failure, setFailure] = useState<HeldChangeFailure | null>(null);

  const shown = editorView(draft, state);
  const shownFailure = shownChangeFailure(failure, 'editor', m);
  const { form } = shown;
  const evaluation = evaluateEditorDraft(shown, m);
  const { errors } = evaluation;
  const kept = keptCustomResponse(state);

  function edit(next: Partial<ResponseForm>): void {
    setDraft(editInEditor(draft, state, { form: next }));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const request = evaluation.request;

    if (request === null) {
      const focus = firstErrorField(errors);

      if (focus !== null) {
        document.getElementById(fieldId(focus))?.focus();
      }

      return;
    }

    if (saving) {
      return;
    }

    setSaving(true);
    onSavingChange(true);
    setFailure(null);

    // What the page held as the call started: its answer yields to anything
    // newer that arrives before it (D152, D205).
    const startedAt = responseRevision();

    try {
      const next = await api.changeSessionResponse(sessionId, request);

      onSavingChange(false);
      onSaved(next, startedAt);
    } catch (error) {
      const described = describeChangeFailure(error, 'editor', m);

      if (described.kind === 'unavailable') {
        onUnavailable();

        return;
      }

      // Everything typed stays where it was (frame D8 of the Figma page
      // `Webhook Inspector · Editable response settings`).
      setFailure({ error });
    } finally {
      onSavingChange(false);
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeading className="text-[22px] leading-[32px]" closeDisabled={saving}>
        {m.editor.title}
      </DialogHeading>
      <DialogDescription
        id="session-response-editor-description"
        className="mt-1.5 leading-[19px] max-md:mt-4"
      >
        {m.editor.description}
      </DialogDescription>

      <form
        className="mt-5 max-md:flex max-md:flex-1 max-md:flex-col"
        onSubmit={(event) => void save(event)}
        noValidate
      >
        <p className="text-[13px] font-medium leading-[18px] text-ink">{m.quick.modeLabel}</p>
        <div className="mt-2">
          <SegmentedControl
            label={m.quick.modeLabel}
            options={MODES.map((mode) => ({
              value: mode,
              label: mode === 'default' ? m.response.default : m.response.custom,
            }))}
            value={shown.mode}
            onChange={(mode) => setDraft(editInEditor(draft, state, { mode }))}
            size="md"
          />
        </div>

        {shown.mode === 'default' ? (
          <div className="mt-5 rounded-[7px] bg-field px-3.5 py-3">
            <p className="text-[13px] font-medium leading-[19px] text-ink">
              {m.quick.defaultResponse}
            </p>
            <p className="mt-1 text-[12px] leading-[17px] text-ink-muted">
              {m.response.defaultSummary}
              {kept === null ? null : (
                <>
                  <br />
                  {m.response.editorKeptNote}
                </>
              )}
            </p>
          </div>
        ) : (
          <>
            {/* Said under the mode control while Custom is picked (frame D2 of
                the Figma page `Webhook Inspector · Editable response settings`). */}
            <p className="mt-2 text-[12px] leading-[17px] text-ink-muted">
              {m.editor.defaultAnswerNote}
            </p>

            <div className="mt-5">
              <ResponseFields form={form} errors={errors} onEdit={edit} fieldId={fieldId} />
            </div>
          </>
        )}

        <div className="mt-5 rounded-[7px] bg-field px-3.5 py-3">
          <p className="text-[13px] font-medium leading-[19px] text-ink">{m.editor.waitingKeep}</p>
          <p className="mt-1 text-[12px] leading-[17px] text-ink-muted">{m.editor.afterSave}</p>
        </div>

        {shownFailure === null ? null : (
          <div role="alert" className="mt-5 rounded-[7px] bg-danger-soft px-3.5 py-3">
            <p className="text-[13px] font-medium leading-[19px] text-danger">
              {shownFailure.title}
            </p>
            <p className="mt-1 text-[12px] leading-[17px] text-danger">{shownFailure.text}</p>
          </div>
        )}

        <SheetSpacer />
        <div className={cn('mt-5 flex justify-end gap-3', SHEET_ACTIONS)}>
          <DialogClose asChild>
            <Button
              type="button"
              variant="quiet"
              disabled={saving}
              className={cn(
                'h-[38px] py-0 font-medium leading-[18px]',
                DISABLED_ACTION,
                SHEET_ACTION,
              )}
            >
              {m.common.cancel}
            </Button>
          </DialogClose>
          <Button
            type="submit"
            disabled={!evaluation.canSave || saving}
            className={cn('h-[38px] py-0 leading-[18px]', DISABLED_ACTION, SHEET_ACTION)}
          >
            {saving ? m.queue.saving : failure === null ? m.editor.save : m.queue.tryAgain}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * The form's DOM ids, in a namespace of their own. The keys are the ones
 * `firstErrorField` returns, so a failed save can move focus to the field that
 * broke first.
 */
function fieldId(key: string): string {
  return `session-response-${key}`;
}
