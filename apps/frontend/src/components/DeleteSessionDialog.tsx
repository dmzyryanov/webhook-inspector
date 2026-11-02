import { useMessages } from '../i18n/LanguageProvider.tsx';
import { formatDeleteDescription } from '../lib/home-view.ts';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.tsx';

/** Where a deletion asked for from the list stands. */
export type DeletionPhase = 'confirm' | 'deleting' | 'failed';

interface DeleteSessionDialogProps {
  /** The session to delete, or `null` while no deletion is asked for. */
  target: { id: string; requestsCount: number | null } | null;
  phase: DeletionPhase;
  onConfirm: () => void;
  /** Cancel, Escape or a click outside; not offered while the deletion runs. */
  onCancel: () => void;
  /** Called once it has closed, to place focus. */
  onClosed: () => void;
}

/**
 * The confirmation `Delete session…` asks for (frames `604:408` and
 * `604:511`, with the states of the reference page `594:11`; D199). Deleting
 * a session is destructive and cannot be undone, so it is confirmed, as
 * `Delete all` is (D029).
 *
 * While the deletion runs, `Delete session` reads `Deleting…` and nothing
 * closes the dialog. If it fails, the dialog stays, says so above the
 * buttons, and `Delete session` tries again. On a phone it is still a centred
 * dialog with two half-width buttons (D157).
 */
export function DeleteSessionDialog({
  target,
  phase,
  onConfirm,
  onCancel,
  onClosed,
}: DeleteSessionDialogProps) {
  const m = useMessages();
  const deleting = phase === 'deleting';

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) {
          onCancel();
        }
      }}
    >
      <DialogContent
        aria-describedby="delete-session-description"
        onEscapeKeyDown={(event) => {
          if (deleting) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (deleting) {
            event.preventDefault();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <DialogTitle>{m.home.deleteTitle}</DialogTitle>
        <DialogDescription
          id="delete-session-description"
          className="max-md:mt-2 max-md:leading-[19px]"
        >
          {target === null ? null : formatDeleteDescription(target.id, target.requestsCount, m)}
        </DialogDescription>
        {phase === 'failed' ? (
          <p role="alert" className="mt-3 text-[13px] leading-[1.5] text-danger">
            {m.home.deleteFailed}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-3 max-md:mt-4">
          <Button variant="quiet" className="max-md:flex-1" disabled={deleting} onClick={onCancel}>
            {m.common.cancel}
          </Button>
          <Button
            variant="danger"
            className="max-md:flex-1"
            disabled={deleting}
            onClick={onConfirm}
          >
            {deleting ? m.home.deleting : m.home.deleteButton}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
