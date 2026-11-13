import { Check, LockKeyhole } from 'lucide-react';
import { useRef } from 'react';
import { useClipboardCopy } from '../hooks/useClipboardCopy.ts';
import { usePhoneLayout } from '../hooks/useDesktopLayout.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.tsx';

/** A private session `Remove from list` was asked for. */
export interface PrivateRemoval {
  id: string;
  /** Its receive URL, as the status read gave it, or `null` when the read failed. */
  receiveUrl: string | null;
  /** Its link with access, which `Copy link with access` copies. */
  link: string;
}

interface RemovePrivateSessionDialogProps {
  /** The session to take off the list, or `null` while none is. */
  target: PrivateRemoval | null;
  /** `Remove from list`: the entry and its key leave this browser. */
  onConfirm: () => void;
  /** Cancel, Escape or a click outside: nothing changes. */
  onCancel: () => void;
}

/**
 * The warning `Remove from list` gives for a private session (frame R3 of the
 * Figma page `Webhook Inspector · Private sessions (#228)`, #228's Decisions 1
 * and 9, D259): only this browser holds its key, so once the entry leaves the
 * list, with its key, the session opens only with its link with access. `Copy
 * link with access` copies that link and keeps the dialog open, saying `Copied`
 * while the copy holds, or the browser's refusal; `Cancel` and `Remove from
 * list` sit on the right.
 *
 * Below 768 px it follows the phone's `Delete session…` confirmation: a
 * centred dialog whose buttons stack full width, `Remove from list` first,
 * then `Cancel`, then `Copy link with access`, in that order for the keyboard
 * too. Focus starts on `Cancel`; once it closes, the page places it: on the
 * row kept, or on what took the place of the row removed.
 */
export function RemovePrivateSessionDialog({
  target,
  onConfirm,
  onCancel,
}: RemovePrivateSessionDialogProps) {
  const m = useMessages();
  const phone = usePhoneLayout();
  const { outcome, copy } = useClipboardCopy();
  const cancel = useRef<HTMLButtonElement>(null);

  const copyButton = (
    <Button
      variant="quiet"
      className="gap-2 font-medium max-md:w-full"
      onClick={() => {
        if (target !== null) {
          void copy(target.link);
        }
      }}
    >
      {outcome === 'copied' ? (
        <Check aria-hidden="true" className="size-3.5 shrink-0 text-ok" strokeWidth={2.5} />
      ) : (
        <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      {outcome === 'copied' ? m.copy.copied : m.access.copyLink}
    </Button>
  );
  const cancelButton = (
    <Button ref={cancel} variant="quiet" className="font-medium max-md:w-full" onClick={onCancel}>
      {m.common.cancel}
    </Button>
  );
  const removeButton = (
    <Button className="max-md:w-full" onClick={onConfirm}>
      {m.sessions.removeFromList}
    </Button>
  );

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent
        aria-describedby="remove-private-session-description"
        // Above the home page's tile, whose dashed border is drawn on a layer
        // of its own (`z-[1]`), which a phone's dialog covers.
        className="z-40 w-[560px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="flex items-center gap-2.5 text-[16px] leading-[22px]">
          <LockKeyhole aria-hidden="true" className="size-4 shrink-0" />
          {m.access.removeTitle}
        </DialogTitle>
        <DialogDescription
          id="remove-private-session-description"
          className="max-md:mt-2 max-md:leading-[19px]"
        >
          {m.access.removeDescription}
        </DialogDescription>
        {target === null ? null : (
          <p className="mt-3 break-all font-mono text-[12px] leading-[17px] text-ink">
            {target.receiveUrl ?? target.id}
          </p>
        )}
        {outcome === 'refused' ? (
          <p role="alert" className="mt-3 text-[13px] leading-[1.5] text-danger">
            {m.actions.linkRefused}
          </p>
        ) : null}
        {phone ? (
          <div className="mt-4 flex flex-col gap-2.5">
            {removeButton}
            {cancelButton}
            {copyButton}
          </div>
        ) : (
          <div className="mt-5 flex items-center justify-between gap-3">
            {copyButton}
            <div className="flex gap-2">
              {cancelButton}
              {removeButton}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
