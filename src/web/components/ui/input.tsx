import * as React from 'react';
import { cn } from '@/lib/utils';

const field = 'w-full min-h-11 bg-background border border-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 disabled:opacity-50';

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn(field, className)} {...props} />;
}
export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'min-h-20', className)} {...props} />;
}
/** Native select: styled, keyboard/screen-reader friendly, no extra dependency. */
export function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return <select className={cn(field, 'appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2716%27%20height=%2716%27%20fill=%27none%27%20stroke=%27%23ececec%27%20stroke-width=%271.5%27%3E%3Cpath%20d=%27M3%206l5%205%205-5%27/%3E%3C/svg%3E")] bg-[length:16px] bg-[position:right_0.75rem_center] bg-no-repeat pr-10', className)} {...props} />;
}
/** Label + control + inline error. The control gets the id via render prop. */
export function Field({ label, error, className, children }: { label: string; error?: string; className?: string; children: (id: string) => React.ReactNode }) {
  const id = React.useId();
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="label">{label}</label>
      {children(id)}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}
