'use client';

import * as React from 'react';
import { Focusable, Tooltip as HeroTooltip } from '@heroui/react';

import { cn } from '@/utils/cn';

const TooltipConfigContext = React.createContext({ delayDuration: 700, skipDelayDuration: 300 });
const TooltipHoverContext = React.createContext(null);

let lastClosedAt = 0;

function TooltipProvider({ delayDuration = 700, skipDelayDuration = 300, children }) {
    const value = React.useMemo(() => ({ delayDuration, skipDelayDuration }), [delayDuration, skipDelayDuration]);
    return <TooltipConfigContext.Provider value={value}>{children}</TooltipConfigContext.Provider>;
}

function Tooltip({ open, defaultOpen = false, onOpenChange, delayDuration, children }) {
    const config = React.useContext(TooltipConfigContext);
    const delay = delayDuration ?? config.delayDuration;
    const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
    const isOpen = open !== undefined ? open : uncontrolled;
    const openRef = React.useRef(isOpen);
    const timerRef = React.useRef();
    const pressedRef = React.useRef(false);
    openRef.current = isOpen;

    const clearTimer = React.useCallback(() => {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
    }, []);

    const setOpen = React.useCallback(
        next => {
            clearTimer();
            if (next === openRef.current) return;
            if (!next) lastClosedAt = Date.now();
            openRef.current = next;
            if (open === undefined) setUncontrolled(next);
            onOpenChange?.(next);
        },
        [clearTimer, open, onOpenChange]
    );

    React.useEffect(() => clearTimer, [clearTimer]);

    const hover = React.useMemo(
        () => ({
            onPointerMove: event => {
                if (event.pointerType !== 'mouse' || pressedRef.current || openRef.current || timerRef.current) return;
                const wait = Date.now() - lastClosedAt < config.skipDelayDuration ? 0 : delay;
                timerRef.current = setTimeout(() => setOpen(true), wait);
            },
            onPointerLeave: () => {
                pressedRef.current = false;
                clearTimer();
            },
            onPointerDown: () => {
                pressedRef.current = true;
                setOpen(false);
            },
        }),
        [clearTimer, config.skipDelayDuration, delay, setOpen]
    );

    return (
        <HeroTooltip delay={delay} closeDelay={150} isOpen={isOpen} onOpenChange={setOpen}>
            <TooltipHoverContext.Provider value={hover}>{children}</TooltipHoverContext.Provider>
        </HeroTooltip>
    );
}

function chain(...handlers) {
    return event => handlers.forEach(handler => handler?.(event));
}

const TooltipTrigger = React.forwardRef(({ asChild = false, children, ...props }, ref) => {
    const hover = React.useContext(TooltipHoverContext);
    const child =
        asChild && React.isValidElement(children) ? (
            children
        ) : (
            <button type="button" {...props}>
                {children}
            </button>
        );
    const extra = asChild ? props : {};
    const childProps = child.props;
    return (
        <Focusable>
            {React.cloneElement(child, {
                ...extra,
                onPointerMove: chain(childProps.onPointerMove, extra.onPointerMove, hover?.onPointerMove),
                onPointerLeave: chain(childProps.onPointerLeave, extra.onPointerLeave, hover?.onPointerLeave),
                onPointerDown: chain(childProps.onPointerDown, extra.onPointerDown, hover?.onPointerDown),
                ref: ref
                    ? node => {
                          if (typeof ref === 'function') ref(node);
                          else ref.current = node;
                          if (typeof childProps.ref === 'function') childProps.ref(node);
                          else if (childProps.ref) childProps.ref.current = node;
                      }
                    : childProps.ref,
            })}
        </Focusable>
    );
});
TooltipTrigger.displayName = 'TooltipTrigger';

const TooltipContent = React.forwardRef(({ className, side = 'top', align = 'center', sideOffset = 4, alignOffset = 0, ...props }, ref) => (
    <HeroTooltip.Content
        ref={ref}
        placement={align === 'center' ? side : `${side} ${align}`}
        offset={sideOffset}
        crossOffset={alignOffset}
        className={cn(
            'z-50 max-w-none overflow-hidden break-normal rounded-lg border border-border bg-popover px-3 py-1.5 text-footnote text-popover-foreground shadow-md data-[entering=true]:zoom-in-95',
            className
        )}
        {...props}
    />
));
TooltipContent.displayName = 'TooltipContent';

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
