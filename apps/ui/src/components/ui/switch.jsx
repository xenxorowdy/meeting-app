import * as React from 'react';
import { Switch as HeroSwitch } from '@heroui/react';

import { cn } from '@/utils/cn';

const Switch = React.forwardRef(({ className, checked, defaultChecked, onCheckedChange, disabled, required, ...props }, ref) => (
    <HeroSwitch
        inputRef={ref}
        isSelected={checked}
        defaultSelected={defaultChecked}
        onChange={onCheckedChange}
        isDisabled={disabled}
        isRequired={required}
        className="inline-flex shrink-0 gap-0"
        {...props}
    >
        {({ isSelected }) => {
            const state = isSelected ? 'checked' : 'unchecked';
            return (
                <HeroSwitch.Content className="gap-0">
                    <HeroSwitch.Control
                        data-state={state}
                        className={cn(
                            'peer inline-flex h-[31px] w-[51px] shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 ease-out data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
                            className
                        )}
                    >
                        <HeroSwitch.Thumb
                            data-state={state}
                            className="pointer-events-none ms-0 block h-[27px] w-[27px] rounded-full bg-background shadow-knob ring-0 transition-transform duration-200 ease-out data-[state=checked]:translate-x-[20px] data-[state=unchecked]:translate-x-0"
                        />
                    </HeroSwitch.Control>
                </HeroSwitch.Content>
            );
        }}
    </HeroSwitch>
));
Switch.displayName = 'Switch';

export { Switch };
