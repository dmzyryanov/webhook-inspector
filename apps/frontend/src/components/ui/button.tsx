import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-[7px] font-semibold transition-colors ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
    'disabled:pointer-events-none disabled:opacity-60',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-white hover:bg-brand/90',
        danger: 'bg-danger text-white hover:bg-danger/90',
        outlineDanger: 'border border-danger-line bg-white text-danger hover:bg-danger/5',
        // A control's boundary rather than a container's: `line-strong` (D158).
        quiet: 'border border-line-strong bg-white text-ink hover:bg-canvas',
      },
      // Below 1024 px every button is a touch target: 44 px high, and 40 px
      // for the small one, which sits in the list header (D157). A floor
      // rather than a height, so a button that sets its own height keeps it
      // on the desktop and is raised to the floor below it.
      size: {
        md: 'px-4 py-[10px] text-[13px] max-lg:min-h-11',
        sm: 'px-3 py-2 text-[12px] max-lg:min-h-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';

  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
