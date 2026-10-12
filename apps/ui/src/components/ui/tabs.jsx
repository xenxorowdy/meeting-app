import * as React from 'react';
import { Tabs as HeroTabs } from '@heroui/react';

import { cn } from '@/utils/cn';

const Tabs = React.forwardRef(({ className, value, defaultValue, onValueChange, orientation, activationMode, children, ...props }, ref) => (
    <HeroTabs
        ref={ref}
        {...(value !== undefined ? { selectedKey: value } : {})}
        defaultSelectedKey={defaultValue}
        onSelectionChange={key => onValueChange?.(String(key))}
        orientation={orientation}
        keyboardActivation={activationMode === 'manual' ? 'manual' : 'automatic'}
        className={cn('block gap-0', className)}
        {...props}
    >
        {children}
    </HeroTabs>
));
Tabs.displayName = 'Tabs';

const TabsList = React.forwardRef(({ className, ...props }, ref) => (
    <HeroTabs.List
        ref={ref}
        className={cn(
            'inline-flex h-8 w-auto min-w-0 items-center justify-center gap-[2px] rounded-lg bg-muted p-[3px] text-muted-foreground',
            className
        )}
        {...props}
    />
));
TabsList.displayName = 'TabsList';

const renderTab = (domProps, { isSelected }) => <div {...domProps} data-state={isSelected ? 'active' : 'inactive'} />;

const TabsTrigger = React.forwardRef(({ className, value, disabled, ...props }, ref) => (
    <HeroTabs.Tab
        ref={ref}
        id={value}
        isDisabled={disabled}
        render={renderTab}
        className={cn(
            'inline-flex h-[26px] w-auto items-center justify-center gap-1 whitespace-nowrap rounded-[7px] px-4 text-callout font-medium text-inherit transition-[background-color,color,box-shadow] duration-200 ease-out',
            'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            'hover:text-foreground hover:opacity-100 data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40',
            'data-[state=active]:bg-segment data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-control',
            '[&_svg]:size-4 [&_svg]:shrink-0',
            className
        )}
        {...props}
    />
));
TabsTrigger.displayName = 'TabsTrigger';

const TabsContent = React.forwardRef(({ className, value, forceMount, ...props }, ref) => (
    <HeroTabs.Panel
        ref={ref}
        id={value}
        shouldForceMount={forceMount}
        className={cn('p-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', className)}
        {...props}
    />
));
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsContent };
