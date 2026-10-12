import * as React from 'react';
import { AlertDialog as HeroAlertDialog } from '@heroui/react';

import { cn } from '@/utils/cn';
import { Button } from '@/components/ui/button';

const AlertDialogContext = React.createContext({ open: false, setOpen: () => {} });
const AlertDialogDescriptionContext = React.createContext(null);

const overlayClassName = 'fixed inset-0 z-50 bg-[hsl(var(--app-scrim)/var(--app-scrim-opacity))] backdrop-blur-[2px]';

function useOpenState(open, defaultOpen, onOpenChange) {
    const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
    const isControlled = open !== undefined;
    const value = isControlled ? open : uncontrolled;
    const setValue = React.useCallback(
        next => {
            if (!isControlled) setUncontrolled(next);
            onOpenChange?.(next);
        },
        [isControlled, onOpenChange]
    );
    return [value, setValue];
}

function useClosingClick(onClick) {
    const { setOpen } = React.useContext(AlertDialogContext);
    return event => {
        onClick?.(event);
        if (!event?.defaultPrevented) setOpen(false);
    };
}

function AlertDialog({ open, defaultOpen = false, onOpenChange, children }) {
    const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
    const value = React.useMemo(() => ({ open: isOpen, setOpen }), [isOpen, setOpen]);
    return <AlertDialogContext.Provider value={value}>{children}</AlertDialogContext.Provider>;
}

const AlertDialogTrigger = React.forwardRef(({ asChild = false, children, onClick, ...props }, ref) => {
    const { open, setOpen } = React.useContext(AlertDialogContext);
    const handleClick = event => {
        onClick?.(event);
        if (!event?.defaultPrevented) setOpen(true);
    };
    if (asChild && React.isValidElement(children)) {
        return React.cloneElement(children, {
            ...props,
            'data-state': open ? 'open' : 'closed',
            onClick: event => {
                children.props.onClick?.(event);
                handleClick(event);
            },
        });
    }
    return (
        <button type="button" ref={ref} data-state={open ? 'open' : 'closed'} onClick={handleClick} {...props}>
            {children}
        </button>
    );
});
AlertDialogTrigger.displayName = 'AlertDialogTrigger';

const AlertDialogPortal = ({ children }) => children;

const AlertDialogOverlay = React.forwardRef(({ className, ...props }, ref) => {
    const { open } = React.useContext(AlertDialogContext);
    return <div ref={ref} data-state={open ? 'open' : 'closed'} className={cn(overlayClassName, className)} {...props} />;
});
AlertDialogOverlay.displayName = 'AlertDialogOverlay';

const AlertDialogContent = React.forwardRef(({ className, children, portalContainer, ...props }, ref) => {
    const { open, setOpen } = React.useContext(AlertDialogContext);
    const [descriptionId, setDescriptionId] = React.useState();
    const state = open ? 'open' : 'closed';
    return (
        <HeroAlertDialog.Backdrop
            isOpen={open}
            onOpenChange={setOpen}
            isDismissable={false}
            isKeyboardDismissDisabled={false}
            UNSTABLE_portalContainer={portalContainer}
            data-state={state}
            className={overlayClassName}
        >
            <HeroAlertDialog.Container placement="center" className="p-0 data-[entering=true]:zoom-in-95 sm:w-full sm:p-4">
                <HeroAlertDialog.Dialog
                    ref={ref}
                    aria-describedby={descriptionId}
                    data-state={state}
                    className={cn(
                        'grid w-full max-w-lg gap-4 overflow-visible rounded-none border bg-popover p-6 shadow-sheet sm:rounded-xl',
                        className
                    )}
                    {...props}
                >
                    <AlertDialogDescriptionContext.Provider value={setDescriptionId}>{children}</AlertDialogDescriptionContext.Provider>
                </HeroAlertDialog.Dialog>
            </HeroAlertDialog.Container>
        </HeroAlertDialog.Backdrop>
    );
});
AlertDialogContent.displayName = 'AlertDialogContent';

const AlertDialogHeader = ({ className, ...props }) => <div className={cn('flex flex-col space-y-2 text-left', className)} {...props} />;
AlertDialogHeader.displayName = 'AlertDialogHeader';

const AlertDialogFooter = ({ className, ...props }) => (
    <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
);
AlertDialogFooter.displayName = 'AlertDialogFooter';

const AlertDialogTitle = React.forwardRef(({ className, ...props }, ref) => (
    <HeroAlertDialog.Heading ref={ref} level={2} className={cn('text-title3 font-semibold [color:inherit]', className)} {...props} />
));
AlertDialogTitle.displayName = 'AlertDialogTitle';

const AlertDialogDescription = React.forwardRef(({ className, id, ...props }, ref) => {
    const register = React.useContext(AlertDialogDescriptionContext);
    const generatedId = React.useId();
    const descriptionId = id ?? generatedId;
    React.useLayoutEffect(() => {
        if (!register) return undefined;
        register(descriptionId);
        return () => register(undefined);
    }, [register, descriptionId]);
    return <p ref={ref} id={descriptionId} className={cn('text-callout text-muted-foreground', className)} {...props} />;
});
AlertDialogDescription.displayName = 'AlertDialogDescription';

const AlertDialogAction = React.forwardRef(({ onClick, ...props }, ref) => {
    const handleClick = useClosingClick(onClick);
    return <Button ref={ref} onClick={handleClick} {...props} />;
});
AlertDialogAction.displayName = 'AlertDialogAction';

const AlertDialogCancel = React.forwardRef(({ className, onClick, autoFocus = true, ...props }, ref) => {
    const handleClick = useClosingClick(onClick);
    return <Button ref={ref} variant="outline" autoFocus={autoFocus} onClick={handleClick} className={cn('mt-2 sm:mt-0', className)} {...props} />;
});
AlertDialogCancel.displayName = 'AlertDialogCancel';

export {
    AlertDialog,
    AlertDialogPortal,
    AlertDialogOverlay,
    AlertDialogTrigger,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogFooter,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogAction,
    AlertDialogCancel,
};
