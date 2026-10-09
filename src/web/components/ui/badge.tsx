import * as React from 'react';
import { cn } from '@/lib/utils';

type Tone = 'amber' | 'green' | 'red' | 'dim';
const tones: Record<Tone, string> = {
  amber: 'text-warn border-warn/50',
  green: 'text-primary border-primary/60',
  red: 'text-destructive border-destructive/60',
  dim: 'text-muted-foreground border-border',
};
export function Badge({ tone = 'dim', className, ...props }: React.ComponentProps<'span'> & { tone?: Tone }) {
  return <span className={cn('inline-flex items-center gap-1 border px-1.5 py-0.5 text-[0.7rem] uppercase tracking-wider', tones[tone], className)} {...props} />;
}
