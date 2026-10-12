import * as React from 'react';
import { Input as HeroInput } from '@heroui/react';

import { cn } from '@/utils/cn';

const Input = React.forwardRef(({ className, type, ...props }, ref) => {
    return (
        <HeroInput
            type={type}
            className={cn(
                'py-0 shadow-none [--field-foreground:currentColor] disabled:pointer-events-auto',
                'flex h-9 w-full rounded-lg border border-input bg-transparent px-2 text-body transition-[border-color,box-shadow] duration-200 ease-out file:border-0 file:bg-transparent file:text-callout file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                className
            )}
            ref={ref}
            {...props}
        />
    );
});
Input.displayName = 'Input';

export { Input };
