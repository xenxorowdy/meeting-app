import * as React from 'react';
import { Checkbox as HeroCheckbox } from '@heroui/react';
import { Check, Minus } from 'lucide-react';

import { cn } from '@/utils/cn';

const Checkbox = React.forwardRef(({ className, checked, defaultChecked, onCheckedChange, disabled, required, ...props }, ref) => (
    <HeroCheckbox
        inputRef={ref}
        isSelected={checked === 'indeterminate' ? false : checked}
        isIndeterminate={checked === 'indeterminate'}
        defaultSelected={defaultChecked === 'indeterminate' ? undefined : defaultChecked}
        onChange={onCheckedChange}
        isDisabled={disabled}
        isRequired={required}
        className="inline-flex shrink-0 gap-0"
        {...props}
    >
        {({ isSelected, isIndeterminate }) => {
            const state = isIndeterminate ? 'indeterminate' : isSelected ? 'checked' : 'unchecked';
            return (
                <HeroCheckbox.Content className="gap-0">
                    <HeroCheckbox.Control
                        data-state={state}
                        className={cn(
                            'grid place-content-center peer h-4 w-4 shrink-0 rounded-sm border border-primary bg-transparent shadow-xs transition-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground before:hidden',
                            className
                        )}
                    >
                        {state !== 'unchecked' && (
                            <HeroCheckbox.Indicator className="grid size-auto place-content-center text-current">
                                {isIndeterminate ? <Minus className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                            </HeroCheckbox.Indicator>
                        )}
                    </HeroCheckbox.Control>
                </HeroCheckbox.Content>
            );
        }}
    </HeroCheckbox>
));
Checkbox.displayName = 'Checkbox';

export { Checkbox };
