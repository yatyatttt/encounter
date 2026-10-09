import { cn } from '@/lib/utils';

/** Labelled exclusive choice (e.g. TOTAL | ROLL). Buttons expose aria-pressed; selection is also shown as a ● marker. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-col gap-1', className)}>
      <span className="label" aria-hidden>{label}</span>
      <div className="inline-flex">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-h-11 cursor-pointer border px-3 text-xs uppercase tracking-wider -ml-px first:ml-0',
              o.value === value ? 'relative z-10 border-primary bg-primary/15 text-primary' : 'border-input text-muted-foreground hover:bg-accent',
            )}
          >
            {o.value === value ? '● ' : '○ '}{o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
