import * as React from 'react';
import { TextArea as HeroTextArea } from '@heroui/react';

import { cn } from '@/utils/cn';

const Textarea = React.forwardRef(({ className, ...props }, ref) => {
    return (
        <HeroTextArea
            className={cn(
                'shadow-none transition-none [--field-foreground:currentColor] disabled:pointer-events-auto',
                'flex min-h-[60px] w-full rounded-lg border border-input bg-transparent px-2 py-2 text-body placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                className
            )}
            ref={ref}
            {...props}
        />
    );
});
Textarea.displayName = 'Textarea';

export { Textarea };
