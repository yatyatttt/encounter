import { useStore } from '@/store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function SaveStatus() {
  const save = useStore((s) => s.save);
  const text = { saved: 'SAVED', saving: 'SAVING…', failed: 'SAVE FAILED' }[save];
  return (
    <span className={cn('label tracking-widest', save === 'saved' && 'text-primary', save === 'saving' && 'text-warn', save === 'failed' && 'text-destructive')}>
      {save === 'saved' ? '● ' : save === 'saving' ? '○ ' : '✕ '}{text}
    </span>
  );
}

/** Persistent save-failure message (with Retry) and version-conflict notice. Rendered in the app shell and inside dialogs. */
export function SaveError() {
  const { save, error, fieldErrors, failed, notice } = useStore();
  const retry = useStore((s) => s.retry);
  const dismiss = useStore((s) => s.dismissError);
  const clearNotice = () => useStore.setState({ notice: null });
  return (
    <>
      {save === 'failed' && (
        <div role="alert" className="border border-destructive bg-destructive/10 p-3 text-sm">
          <p><strong className="text-destructive">SAVE FAILED</strong> — {error}</p>
          {fieldErrors && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {Object.entries(fieldErrors).map(([k, v]) => <li key={k}>{k}: {v.join('; ')}</li>)}
            </ul>
          )}
          <p className="mt-1 text-xs text-muted-foreground">Nothing was changed on the server. Your typed input is kept; this encounter is shown as last saved.</p>
          <div className="mt-2 flex gap-2">
            {failed && <Button size="sm" onClick={() => void retry()}>Retry</Button>}
            <Button size="sm" variant="outline" onClick={dismiss}>Dismiss</Button>
          </div>
        </div>
      )}
      {notice && (
        <div role="alert" className="flex items-start justify-between gap-2 border border-warn bg-warn/10 p-3 text-sm text-warn">
          <p>{notice}</p>
          <Button size="sm" variant="outline" onClick={clearNotice}>OK</Button>
        </div>
      )}
    </>
  );
}
