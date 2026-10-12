import * as React from 'react';
import { ToggleButton } from '@heroui/react';
import { cva } from 'class-variance-authority';

import { cn } from '@/utils/cn';

const toggleVariants = cva(
    'inline-flex items-center justify-center gap-2 rounded-lg text-callout font-medium transition-colors transform-none hover:bg-muted hover:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:m-0 [&_svg]:size-4 [&_svg]:shrink-0',
    {
        variants: {
            variant: {
                default: 'bg-transparent',
                outline: 'border border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
            },
            size: {
                default: 'h-9 px-2 min-w-9',
                sm: 'h-8 px-1 min-w-8',
                lg: 'h-10 px-2 min-w-10',
            },
        },
        defaultVariants: {
            variant: 'default',
            size: 'default',
        },
    }
);

const renderToggle = (domProps, { isSelected }) => <button {...domProps} data-state={isSelected ? 'on' : 'off'} />;

const Toggle = React.forwardRef(({ className, variant, size, pressed, defaultPressed, onPressedChange, disabled, ...props }, ref) => (
    <ToggleButton
        ref={ref}
        isSelected={pressed}
        defaultSelected={defaultPressed}
        onChange={onPressedChange}
        isDisabled={disabled}
        render={renderToggle}
        className={cn(toggleVariants({ variant, size, className }))}
        {...props}
    />
));
Toggle.displayName = 'Toggle';

export { Toggle, toggleVariants, renderToggle };
