import * as React from 'react';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';

import { cn } from '@/utils/cn';
import { renderToggle, toggleVariants } from '@/components/ui/toggle';

const ToggleGroupContext = React.createContext({
    size: 'default',
    variant: 'default',
});

const toKeys = (value, multiple) => {
    if (value === undefined) return undefined;
    if (multiple) return value || [];
    return value === null || value === '' ? [] : [value];
};

const ToggleGroup = React.forwardRef(({ className, variant, size, type = 'single', value, defaultValue, onValueChange, disabled, children, ...props }, ref) => {
    const multiple = type === 'multiple';
    return (
        <ToggleButtonGroup
            ref={ref}
            isDetached
            selectionMode={multiple ? 'multiple' : 'single'}
            selectedKeys={toKeys(value, multiple)}
            defaultSelectedKeys={toKeys(defaultValue, multiple)}
            onSelectionChange={keys => {
                const next = [...keys].map(String);
                onValueChange?.(multiple ? next : (next[0] ?? ''));
            }}
            isDisabled={disabled}
            className={cn('flex items-center justify-center gap-1', className)}
            {...props}
        >
            <ToggleGroupContext.Provider value={{ variant, size }}>{children}</ToggleGroupContext.Provider>
        </ToggleButtonGroup>
    );
});
ToggleGroup.displayName = 'ToggleGroup';

const ToggleGroupItem = React.forwardRef(({ className, children, variant, size, value, disabled, ...props }, ref) => {
    const context = React.useContext(ToggleGroupContext);

    return (
        <ToggleButton
            ref={ref}
            id={value}
            isDisabled={disabled}
            render={renderToggle}
            className={cn(
                toggleVariants({
                    variant: context.variant || variant,
                    size: context.size || size,
                }),
                className
            )}
            {...props}
        >
            {children}
        </ToggleButton>
    );
});
ToggleGroupItem.displayName = 'ToggleGroupItem';

export { ToggleGroup, ToggleGroupItem };
