import * as React from 'react';
import { Chip } from '@heroui/react';
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

const chipVariants = {
    default: { color: 'accent', variant: 'primary' },
    secondary: { color: 'default', variant: 'secondary' },
    tinted: { color: 'accent', variant: 'soft' },
    destructive: { color: 'danger', variant: 'soft' },
    success: { color: 'success', variant: 'soft' },
    warning: { color: 'warning', variant: 'soft' },
    muted: { color: 'default', variant: 'secondary' },
    outline: { color: 'default', variant: 'tertiary' },
};

const chipReset = 'w-auto shrink text-[length:inherit] leading-[inherit]';

const Badge = React.forwardRef(({ className, variant, children, ...props }, ref) => (
    <Chip
        ref={ref}
        {...(chipVariants[variant] ?? chipVariants.default)}
        className={cn(chipReset, badgeVariants({ variant }), className)}
        {...props}
    >
        <>{children}</>
    </Chip>
));
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
