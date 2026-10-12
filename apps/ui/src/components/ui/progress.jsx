import * as React from 'react';
import { ProgressBar } from '@heroui/react';

import { cn } from '@/utils/cn';

const Progress = React.forwardRef(({ className, value, max = 100, ...props }, ref) => (
    <ProgressBar
        ref={ref}
        value={value || 0}
        maxValue={max}
        className={cn('relative block h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
        {...props}
    >
        <ProgressBar.Track className="absolute inset-0 h-full rounded-none bg-transparent">
            <ProgressBar.Fill className="rounded-none bg-primary transition-all" />
        </ProgressBar.Track>
    </ProgressBar>
));
Progress.displayName = 'Progress';

export { Progress };
