import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';

import { cn } from '@/utils/cn';

const buttonVariants = cva(
    'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-lg font-medium transition-[background-color,color,border-color] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0',
    {
        variants: {
            variant: {
                default: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80',
                destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80',
                tinted: 'bg-primary/[0.14] text-primary hover:bg-primary/[0.22] active:bg-primary/[0.28]',
                'destructive-tinted': 'bg-destructive/[0.14] text-destructive hover:bg-destructive/[0.22] active:bg-destructive/[0.28]',
                outline: 'border border-border bg-transparent text-foreground hover:bg-accent active:bg-accent',
                secondary: 'border border-border bg-secondary text-secondary-foreground hover:bg-accent active:bg-accent',
                ghost: 'text-foreground hover:bg-accent active:bg-accent',
                plain: 'text-primary hover:bg-primary/[0.12] active:bg-primary/[0.18]',
                link: 'text-primary underline-offset-4 hover:underline',
            },
            size: {
                xs: 'h-8 px-2 text-callout [&_svg]:size-4',
                sm: 'h-8 px-2 text-callout [&_svg]:size-4',
                default: 'h-9 px-4 text-body [&_svg]:size-4',
                lg: 'h-10 px-4 text-title3 [&_svg]:size-4',
                icon: 'h-9 w-9 [&_svg]:size-4',
                iconSm: 'h-8 w-8 [&_svg]:size-4',
                iconXs: 'h-8 w-8 [&_svg]:size-4',
            },
        },
        defaultVariants: {
            variant: 'default',
            size: 'default',
        },
    }
);

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = 'Button';

export { Button, buttonVariants };
