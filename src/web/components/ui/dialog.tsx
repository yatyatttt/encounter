import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export const Dialog = DialogPrimitive.Root;

export function DialogContent({ title, description, className, children, ...props }: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, 'title'> & { title: string; description?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/70" />
      <DialogPrimitive.Content
        className={cn('fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-border bg-card p-5 shadow-xl', className)}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...props}
      >
        <DialogPrimitive.Title className="mb-1 text-base uppercase tracking-wider text-foreground">{title}</DialogPrimitive.Title>
        {description && <DialogPrimitive.Description className="mb-4 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>}
        <div className="flex flex-col gap-4">{children}</div>
        <DialogPrimitive.Close className="absolute right-2 top-2 inline-flex size-11 items-center justify-center text-muted-foreground hover:text-foreground" aria-label="Close dialog">
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const DialogFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div className={cn('flex flex-wrap justify-end gap-2 pt-2', className)} {...props} />
);

/** Confirmation naming the affected object. onConfirm may be async; return false to keep the dialog open. */
export function Confirm({ open, onOpenChange, title, children, confirmLabel, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; children: React.ReactNode; confirmLabel: string;
  onConfirm: () => Promise<boolean | void> | boolean | void;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title}>
        <div className="text-sm">{children}</div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { if ((await onConfirm()) !== false) onOpenChange(false); } finally { setBusy(false); }
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
