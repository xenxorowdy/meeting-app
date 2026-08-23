import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/utils/cn';

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef(({ className, ...props }, ref) => (
    <TabsPrimitive.List
        ref={ref}
        className={cn('inline-flex h-8 items-center justify-center gap-[2px] rounded-lg bg-muted p-[3px] text-muted-foreground', className)}
        {...props}
    />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef(({ className, ...props }, ref) => (
    <TabsPrimitive.Trigger
        ref={ref}
        className={cn(
            'inline-flex h-[26px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 text-callout font-medium transition-[background-color,color,box-shadow] duration-150 ease-apple-standard',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            'hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
            'data-[state=active]:bg-segment data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-control',
            '[&_svg]:size-3.5 [&_svg]:shrink-0',
            className
        )}
        {...props}
    />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef(({ className, ...props }, ref) => (
    <TabsPrimitive.Content
        ref={ref}
        className={cn('focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', className)}
        {...props}
    />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
