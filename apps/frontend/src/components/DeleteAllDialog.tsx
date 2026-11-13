import { useState } from 'react';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { formatDeleteAllDescription } from '../lib/request-filter.ts';
import { Button } from './ui/button.tsx';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog.tsx';

interface DeleteAllDialogProps {
  /** Every request the session holds, filtered or not: all of them go. */
  count: number;
  /**
   * How many of them the list filter hides; the dialog names them (frame 2J of
   * the Figma page `Webhook Inspector · Request list filter`, D180).
   */
  hidden?: number;
  onConfirm: () => void;
}

/**
 * Bulk deletion is the destructive action and must be confirmed (D029). On a
 * phone it stays a centred dialog, with two half-width actions (frame 2C of the
 * Figma page `Webhook Inspector · Tablet and phone`, D157).
 */
export function DeleteAllDialog({ count, hidden = 0, onConfirm }: DeleteAllDialogProps) {
  const m = useMessages();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outlineDanger" size="sm" disabled={count === 0}>
          {m.deleteAll.button}
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby="delete-all-description">
        <DialogTitle>{m.deleteAll.title}</DialogTitle>
        <DialogDescription
          id="delete-all-description"
          className="max-md:mt-2 max-md:leading-[19px]"
        >
          {formatDeleteAllDescription(count, hidden, m)}
        </DialogDescription>
        <div className="mt-6 flex justify-end gap-3 max-md:mt-4">
          <DialogClose asChild>
            <Button variant="quiet" className="max-md:flex-1">
              {m.common.cancel}
            </Button>
          </DialogClose>
          <Button
            variant="danger"
            className="max-md:flex-1"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {m.deleteAll.button}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
