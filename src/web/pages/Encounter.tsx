// ONE route /encounter/:id: Builder for drafts, Tracker for active / paused / completed.
import { useEffect } from 'react';
import { useStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Builder } from '@/pages/Builder';
import { Tracker } from '@/pages/Tracker';

export function Encounter({ id }: { id: string }) {
  const snapshot = useStore((s) => s.snapshot);
  const loadError = useStore((s) => s.loadError);
  const open = useStore((s) => s.open);
  const refetch = useStore((s) => s.refetch);

  useEffect(() => {
    void open(id);
    const onFocus = () => void refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [id, open, refetch]);

  if (!snapshot || snapshot.id !== id) {
    return loadError
      ? <p role="alert" className="border border-destructive p-3 text-sm text-destructive">{loadError} <Button size="sm" variant="outline" onClick={() => void open(id)}>Retry</Button></p>
      : <p className="text-muted-foreground">Loading…</p>;
  }
  return snapshot.status === 'draft' ? <Builder /> : <Tracker />;
}
