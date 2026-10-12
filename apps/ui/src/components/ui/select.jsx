import * as React from 'react';
import { Header, ListBox, Select as HeroSelect, Separator } from '@heroui/react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@/utils/cn';

const toKey = value => (value === undefined || value === null || value === '' ? null : String(value));

const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (React.isValidElement(node)) return textOf(node.props.children);
    return '';
};

const Select = ({ value, defaultValue, onValueChange, open, defaultOpen, onOpenChange, disabled, required, children, ...props }) => (
    <HeroSelect
        className="contents"
        {...(value !== undefined ? { value: toKey(value) } : {})}
        defaultValue={toKey(defaultValue)}
        onChange={key => {
            if (key !== null && key !== undefined) onValueChange?.(String(key));
        }}
        isOpen={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        isDisabled={disabled}
        isRequired={required}
        {...props}
    >
        {children}
    </HeroSelect>
);
Select.displayName = 'Select';

const SelectGroup = React.forwardRef(({ className, ...props }, ref) => <ListBox.Section ref={ref} className={cn('p-0', className)} {...props} />);
SelectGroup.displayName = 'SelectGroup';

const SelectValue = React.forwardRef(({ className, placeholder, children, ...props }, ref) => (
    <HeroSelect.Value
        ref={ref}
        className={cn(
            'line-clamp-1 min-w-0 flex-1 text-left [font-size:inherit] [line-height:inherit] data-[placeholder]:text-muted-foreground',
            className
        )}
        {...props}
    >
        {({ isPlaceholder, selectedText }) => (isPlaceholder ? (placeholder ?? null) : (children ?? selectedText))}
    </HeroSelect.Value>
));
SelectValue.displayName = 'SelectValue';

const SelectTrigger = React.forwardRef(({ className, children, disabled, ...props }, ref) => (
    <HeroSelect.Trigger
        ref={ref}
        {...(disabled ? { isDisabled: true } : {})}
        className={cn(
            'flex h-9 min-h-0 w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-input bg-transparent px-2 py-0 text-body shadow-none ring-offset-background focus:outline-hidden focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            className
        )}
        {...props}
    >
        {children}
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
    </HeroSelect.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

const SelectScrollUpButton = React.forwardRef(({ className, ...props }, ref) => (
    <div ref={ref} aria-hidden="true" className={cn('flex cursor-default items-center justify-center py-1', className)} {...props}>
        <ChevronUp className="h-4 w-4" />
    </div>
));
SelectScrollUpButton.displayName = 'SelectScrollUpButton';

const SelectScrollDownButton = React.forwardRef(({ className, ...props }, ref) => (
    <div ref={ref} aria-hidden="true" className={cn('flex cursor-default items-center justify-center py-1', className)} {...props}>
        <ChevronDown className="h-4 w-4" />
    </div>
));
SelectScrollDownButton.displayName = 'SelectScrollDownButton';

const SelectContent = React.forwardRef(({ className, children, position, side = 'bottom', sideOffset = 4, ...props }, ref) => (
    <HeroSelect.Popover
        ref={ref}
        placement={side}
        offset={sideOffset}
        className={cn(
            'relative z-50 min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-lg border bg-popover p-0 text-popover-foreground shadow-sheet',
            className
        )}
        {...props}
    >
        <ListBox className="p-1 outline-hidden [&>*+*]:mt-0">{children}</ListBox>
    </HeroSelect.Popover>
));
SelectContent.displayName = 'SelectContent';

const SelectLabel = React.forwardRef(({ className, ...props }, ref) => (
    <Header ref={ref} className={cn('px-2 py-1 text-callout font-semibold', className)} {...props} />
));
SelectLabel.displayName = 'SelectLabel';

const SelectItem = React.forwardRef(({ className, children, value, disabled, textValue, ...props }, ref) => (
    <ListBox.Item
        ref={ref}
        id={String(value)}
        textValue={textValue ?? (textOf(children) || String(value))}
        isDisabled={disabled}
        className={cn(
            'relative flex min-h-0 w-full cursor-default select-none items-center gap-2 rounded-sm py-1 pl-2 pr-8 text-callout outline-hidden transform-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[focused=true]:bg-accent data-[focused=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
            className
        )}
        {...props}
    >
        {children}
        <ListBox.ItemIndicator className="right-2 size-4 text-current">
            {({ isSelected }) => (isSelected ? <Check className="h-4 w-4" /> : null)}
        </ListBox.ItemIndicator>
    </ListBox.Item>
));
SelectItem.displayName = 'SelectItem';

const SelectSeparator = React.forwardRef(({ className, ...props }, ref) => (
    <Separator ref={ref} className={cn('-mx-1 my-1 h-px w-auto bg-muted', className)} {...props} />
));
SelectSeparator.displayName = 'SelectSeparator';

export {
    Select,
    SelectGroup,
    SelectValue,
    SelectTrigger,
    SelectContent,
    SelectLabel,
    SelectItem,
    SelectSeparator,
    SelectScrollUpButton,
    SelectScrollDownButton,
};
