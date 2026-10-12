import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Calendar, DateField, DatePicker, FieldError, Label } from '@heroui/react';
import { parseDateTime } from '@internationalized/date';
import { CalendarDays } from 'lucide-react';
import { DateFieldStateContext } from 'react-aria-components/DateField';

function dateValue(value) {
    if (!value) return null;
    try { return parseDateTime(value); } catch { return null; }
}

function DateSegment({ segment, onValidityChange, inRange }) {
    const state = useContext(DateFieldStateContext);
    const complete = state.segments.every(part => !part.isEditable || !part.isPlaceholder);
    const valid = complete && !state.isInvalid && inRange;
    useEffect(() => {
        if (segment.type === 'day') onValidityChange?.(valid);
    }, [segment.type, valid, onValidityChange]);
    return <DateField.Segment segment={segment} />;
}

// Keep device-local ISO strings at the form boundary; callers convert to UTC on submit.
export function DateTimePicker({ label, 'aria-label': ariaLabel = label, value, onChange, onEdit, onValidityChange, min, disabled, required, id }) {
    const [portalContainer, setPortalContainer] = useState(null);
    const bindContainer = useCallback(node => setPortalContainer(node?.closest('.ks-app') || null), []);
    const selected = useMemo(() => dateValue(value), [value]);
    const minimum = useMemo(() => dateValue(min), [min]);
    const rangeInvalid = Boolean(selected && minimum && selected.compare(minimum) < 0);

    return (
        <div ref={bindContainer} className="ks-date-time-picker" data-date-field={ariaLabel}
            onInputCapture={onEdit}
            onKeyDownCapture={event => {
                if (event.target.getAttribute('role') === 'spinbutton' && /^(\d|Backspace|Delete|ArrowUp|ArrowDown|Home|End)$/.test(event.key)) onEdit?.();
            }}>
            <DatePicker
                id={id}
                aria-label={ariaLabel}
                value={selected}
                onChange={date => onChange(date ? date.toString().slice(0, 16) : '')}
                minValue={minimum || undefined}
                isInvalid={rangeInvalid || undefined}
                granularity="minute"
                hourCycle={24}
                shouldForceLeadingZeros
                isDisabled={disabled}
                isRequired={required}
            >
                <Label>{label}</Label>
                <DateField.Group fullWidth>
                    <DateField.Input>{segment => <DateSegment segment={segment} onValidityChange={onValidityChange} inRange={!rangeInvalid} />}</DateField.Input>
                    <DateField.Suffix>
                        <DatePicker.Trigger aria-label={`Choose ${ariaLabel.toLowerCase()}`}>
                            <DatePicker.TriggerIndicator><CalendarDays size={16} /></DatePicker.TriggerIndicator>
                        </DatePicker.Trigger>
                    </DateField.Suffix>
                </DateField.Group>
                <FieldError>{rangeInvalid ? 'Choose a date and time on or after the start.' : undefined}</FieldError>
                <DatePicker.Popover className="ks-date-time-popover" UNSTABLE_portalContainer={portalContainer || undefined}>
                    <Calendar aria-label={`${label} date`} minValue={minimum || undefined}>
                        <Calendar.Header>
                            <Calendar.YearPickerTrigger>
                                <Calendar.YearPickerTriggerHeading />
                                <Calendar.YearPickerTriggerIndicator />
                            </Calendar.YearPickerTrigger>
                            <Calendar.NavButton slot="previous" />
                            <Calendar.NavButton slot="next" />
                        </Calendar.Header>
                        <Calendar.Grid>
                            <Calendar.GridHeader>{day => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
                            <Calendar.GridBody>{date => <Calendar.Cell date={date} />}</Calendar.GridBody>
                        </Calendar.Grid>
                        <Calendar.YearPickerGrid>
                            <Calendar.YearPickerGridBody>{({ year }) => <Calendar.YearPickerCell year={year} />}</Calendar.YearPickerGridBody>
                        </Calendar.YearPickerGrid>
                    </Calendar>
                </DatePicker.Popover>
            </DatePicker>
        </div>
    );
}
