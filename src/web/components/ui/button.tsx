import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium uppercase tracking-wider transition-colors disabled:pointer-events-none disabled:opacity-40 cursor-pointer border',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground border-primary hover:brightness-110',
        outline: 'bg-transparent border-border text-foreground hover:bg-accent',
        ghost: 'bg-transparent border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
      },
      size: {
        default: 'h-11 px-4 text-xs',
        sm: 'h-9 px-3 text-xs',
        lg: 'h-14 px-8 text-base',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({ className, variant, size, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
