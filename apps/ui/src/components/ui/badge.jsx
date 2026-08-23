import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from '@/utils/cn';

const badgeVariants = cva(
    'inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-footnote font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
    {
        variants: {
            variant: {
                default: 'border-transparent bg-primary text-primary-foreground',
                secondary: 'border-transparent bg-secondary text-secondary-foreground',
                tinted: 'border-transparent bg-primary/[0.14] text-primary',
                destructive: 'border-transparent bg-destructive/[0.16] text-destructive',
                success: 'border-transparent bg-success/[0.16] text-success',
                warning: 'border-transparent bg-warning/[0.16] text-warning',
                muted: 'border-transparent bg-muted text-muted-foreground',
                outline: 'border-border text-muted-foreground',
            },
        },
        defaultVariants: {
            variant: 'default',
        },
    }
);

function Badge({ className, variant, ...props }) {
    return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
