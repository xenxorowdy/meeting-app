import * as React from 'react';
import { Separator as HeroSeparator } from '@heroui/react';

import { cn } from '@/utils/cn';

const Separator = React.forwardRef(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => {
    const Element = orientation === 'vertical' ? 'div' : 'hr';
    const render = decorative ? domProps => <Element {...domProps} role="none" aria-orientation={undefined} /> : undefined;

    return (
        <HeroSeparator
            ref={ref}
            orientation={orientation}
            render={render}
            className={cn('shrink-0 rounded-none bg-border', orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]', className)}
            {...props}
        />
    );
});
Separator.displayName = 'Separator';

export { Separator };
