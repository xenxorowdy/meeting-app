import * as React from 'react';
import { Card as HeroCard } from '@heroui/react';

import { cn } from '@/utils/cn';

const Card = React.forwardRef(({ className, ...props }, ref) => (
    <HeroCard
        ref={ref}
        className={cn('static block gap-0 bg-transparent p-0 shadow-none', 'rounded-xl border text-card-foreground', className)}
        {...props}
    />
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef(({ className, ...props }, ref) => (
    <HeroCard.Header ref={ref} className={cn('flex flex-col space-y-1 p-4', className)} {...props} />
));
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef(({ className, ...props }, ref) => (
    <HeroCard.Title ref={ref} className={cn('[--tw-leading:initial] [color:inherit]', 'text-headline font-semibold tracking-tight', className)} {...props} />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef(({ className, ...props }, ref) => (
    <HeroCard.Description ref={ref} className={cn('text-[length:inherit] leading-[inherit]', 'text-callout text-muted-foreground', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef(({ className, ...props }, ref) => (
    <HeroCard.Content ref={ref} className={cn('block flex-initial gap-0', 'p-4 pt-0', className)} {...props} />
));
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef(({ className, ...props }, ref) => (
    <HeroCard.Footer ref={ref} className={cn('flex items-center p-4 pt-0', className)} {...props} />
));
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
