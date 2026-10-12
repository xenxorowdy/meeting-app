import * as React from 'react';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';

import { cn } from '@/utils/cn';
import { renderToggle } from '@/components/ui/toggle';

const SegmentedControl = React.forwardRef(({ className, value, defaultValue, onValueChange, disabled, ...props }, ref) => (
    <ToggleButtonGroup
        ref={ref}
        isDetached
        selectionMode="single"
        disallowEmptySelection
        {...(value !== undefined ? { selectedKeys: value === null ? [] : [value] } : {})}
        defaultSelectedKeys={defaultValue === undefined || defaultValue === null ? undefined : [defaultValue]}
        onSelectionChange={keys => {
            const [next] = keys;
            if (next !== undefined) onValueChange?.(String(next));
        }}
        isDisabled={disabled}
        className={cn('inline-flex h-8 items-center gap-[2px] rounded-lg bg-muted p-[3px]', className)}
        {...props}
    />
));
SegmentedControl.displayName = 'SegmentedControl';

const SegmentedItem = React.forwardRef(({ className, value, disabled, ...props }, ref) => (
    <ToggleButton
        ref={ref}
        id={value}
        isDisabled={disabled}
        render={renderToggle}
        className={cn(
            'inline-flex h-[26px] flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-[7px] bg-transparent px-2 text-callout font-medium text-muted-foreground transform-none',
            'transition-[background-color,color,box-shadow] duration-200 ease-out hover:text-foreground',
            'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            'data-[state=on]:bg-segment data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-control',
            '[&_svg]:m-0 [&_svg]:size-4 [&_svg]:shrink-0',
            className
        )}
        {...props}
    />
));
SegmentedItem.displayName = 'SegmentedItem';

export { SegmentedControl, SegmentedItem };
