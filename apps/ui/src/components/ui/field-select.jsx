import * as React from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/utils/cn';

// The popover is portalled out of the field, so it needs the themed .ks-app root to inherit the design tokens;
// the span is only there to find that root from wherever the field is rendered.
function FieldSelect({ value, onChange, options, label, disabled, className, placeholder }) {
    const [container, setContainer] = React.useState();
    const bind = React.useCallback(node => {
        if (node) setContainer(node.closest('.ks-app') || undefined);
    }, []);

    return (
        <span ref={bind} className="contents">
            <Select value={value ?? ''} onValueChange={onChange} disabled={disabled}>
                <SelectTrigger aria-label={label} className={cn('ks-field-select', className)}>
                    <SelectValue placeholder={placeholder} />
                </SelectTrigger>
                <SelectContent UNSTABLE_portalContainer={container}>
                    {options.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                            {option.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </span>
    );
}

export { FieldSelect };
