import * as React from 'react';
import { Label as HeroLabel } from '@heroui/react';
import { cva } from 'class-variance-authority';

import { cn } from '@/utils/cn';

const labelVariants = cva('text-callout font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70');

const Label = React.forwardRef(({ className, ...props }, ref) => (
    <HeroLabel ref={ref} className={cn('[color:inherit]', labelVariants(), className)} {...props} />
));
Label.displayName = 'Label';

export { Label };
