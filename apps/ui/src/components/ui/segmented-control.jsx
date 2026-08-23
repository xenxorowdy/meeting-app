import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';

import { cn } from '@/utils/cn';

const SegmentedControl = React.forwardRef(({ className, value, onValueChange, ...props }, ref) => (
    <ToggleGroupPrimitive.Root
        ref={ref}
        type="single"
        value={value}
        onValueChange={next => {
            if (next) onValueChange(next);
        }}
        className={cn('inline-flex h-8 items-center gap-[2px] rounded-lg bg-muted p-[3px]', className)}
        {...props}
    />
));
SegmentedControl.displayName = 'SegmentedControl';

const SegmentedItem = React.forwardRef(({ className, ...props }, ref) => (
    <ToggleGroupPrimitive.Item
        ref={ref}
        className={cn(
            'inline-flex h-[26px] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 text-callout font-medium text-muted-foreground',
            'transition-[background-color,color,box-shadow] duration-150 ease-apple-standard hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            'data-[state=on]:bg-segment data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-control',
            '[&_svg]:size-3.5 [&_svg]:shrink-0',
            className
        )}
        {...props}
    />
));
SegmentedItem.displayName = 'SegmentedItem';

export { SegmentedControl, SegmentedItem };
