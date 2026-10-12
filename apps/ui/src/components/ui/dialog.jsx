'use client';

import * as React from 'react';
import { Modal } from '@heroui/react';
import { X } from 'lucide-react';

import { cn } from '@/utils/cn';

const DialogContext = React.createContext({ open: false, setOpen: () => {} });
const DialogDescriptionContext = React.createContext(null);

const overlayClassName = 'fixed inset-0 z-50 bg-[hsl(var(--app-scrim)/var(--app-scrim-opacity))] backdrop-blur-[2px]';

function mergeRefs(...refs) {
    return node => {
        refs.forEach(ref => {
            if (typeof ref === 'function') ref(node);
            else if (ref) ref.current = node;
        });
    };
}

function slotted(asChild, children, props, ref) {
    if (!asChild || !React.isValidElement(children)) {
        return (
            <button type="button" ref={ref} {...props}>
                {children}
            </button>
        );
    }
    const childProps = children.props;
    return React.cloneElement(children, {
        ...props,
        ...childProps,
        className: cn(props.className, childProps.className),
        onClick: event => {
            childProps.onClick?.(event);
            props.onClick?.(event);
        },
        ref: mergeRefs(ref, childProps.ref),
    });
}

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

function useEscapeGuard(node, onEscapeKeyDown) {
    React.useEffect(() => {
        if (!node || !onEscapeKeyDown) return undefined;
        const handle = event => {
            if (event.key !== 'Escape') return;
            onEscapeKeyDown(event);
            if (event.defaultPrevented) event.stopPropagation();
        };
        node.addEventListener('keydown', handle, true);
        return () => node.removeEventListener('keydown', handle, true);
    }, [node, onEscapeKeyDown]);
}

function outsideGuard(handlers) {
    if (!handlers.some(Boolean)) return undefined;
    return target => {
        let prevented = false;
        const event = {
            target,
            preventDefault: () => {
                prevented = true;
            },
            get defaultPrevented() {
                return prevented;
            },
        };
        handlers.forEach(handler => handler?.(event));
        return !prevented;
    };
}

function Dialog({ open, defaultOpen = false, onOpenChange, children }) {
    const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
    const value = React.useMemo(() => ({ open: isOpen, setOpen }), [isOpen, setOpen]);
    return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

const DialogTrigger = React.forwardRef(({ asChild = false, children, onClick, ...props }, ref) => {
    const { open, setOpen } = React.useContext(DialogContext);
    const handleClick = event => {
        onClick?.(event);
        if (!event?.defaultPrevented) setOpen(!open);
    };
    return slotted(asChild, children, { ...props, 'data-state': open ? 'open' : 'closed', onClick: handleClick }, ref);
});
DialogTrigger.displayName = 'DialogTrigger';

const DialogPortal = ({ children }) => children;

const DialogClose = React.forwardRef(({ asChild = false, children, onClick, ...props }, ref) => {
    const { setOpen } = React.useContext(DialogContext);
    const handleClick = event => {
        onClick?.(event);
        if (!event?.defaultPrevented) setOpen(false);
    };
    return slotted(asChild, children, { ...props, onClick: handleClick }, ref);
});
DialogClose.displayName = 'DialogClose';

const DialogOverlay = React.forwardRef(({ className, ...props }, ref) => {
    const { open } = React.useContext(DialogContext);
    return <div ref={ref} data-state={open ? 'open' : 'closed'} className={cn(overlayClassName, className)} {...props} />;
});
DialogOverlay.displayName = 'DialogOverlay';

const DialogContent = React.forwardRef(
    ({ className, children, portalContainer, onEscapeKeyDown, onPointerDownOutside, onInteractOutside, ...props }, ref) => {
        const { open, setOpen } = React.useContext(DialogContext);
        const [node, setNode] = React.useState(null);
        const [descriptionId, setDescriptionId] = React.useState();
        const dialogRef = React.useMemo(() => mergeRefs(ref, setNode), [ref]);
        const state = open ? 'open' : 'closed';
        useEscapeGuard(node, onEscapeKeyDown);
        return (
            <Modal.Backdrop
                isOpen={open}
                onOpenChange={setOpen}
                isDismissable
                shouldCloseOnInteractOutside={outsideGuard([onPointerDownOutside, onInteractOutside])}
                UNSTABLE_portalContainer={portalContainer}
                data-state={state}
                className={overlayClassName}
            >
                <Modal.Container placement="center" className="p-0 data-[entering=true]:zoom-in-95 sm:w-full sm:p-4">
                    <Modal.Dialog
                        ref={dialogRef}
                        aria-describedby={descriptionId}
                        data-state={state}
                        className={cn(
                            'grid w-full max-w-lg gap-4 overflow-visible rounded-none border bg-popover p-6 shadow-sheet sm:rounded-xl',
                            className
                        )}
                        {...props}
                    >
                        <DialogDescriptionContext.Provider value={setDescriptionId}>
                            {children}
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                            >
                                <X className="size-4" />
                                <span className="sr-only">Close</span>
                            </button>
                        </DialogDescriptionContext.Provider>
                    </Modal.Dialog>
                </Modal.Container>
            </Modal.Backdrop>
        );
    }
);
DialogContent.displayName = 'DialogContent';

const DialogHeader = ({ className, ...props }) => <div className={cn('flex flex-col space-y-1 text-left', className)} {...props} />;
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }) => (
    <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef(({ className, ...props }, ref) => (
    <Modal.Heading ref={ref} level={2} className={cn('text-title3 font-semibold leading-none tracking-tight [color:inherit]', className)} {...props} />
));
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef(({ className, id, ...props }, ref) => {
    const register = React.useContext(DialogDescriptionContext);
    const generatedId = React.useId();
    const descriptionId = id ?? generatedId;
    React.useLayoutEffect(() => {
        if (!register) return undefined;
        register(descriptionId);
        return () => register(undefined);
    }, [register, descriptionId]);
    return <p ref={ref} id={descriptionId} className={cn('text-callout text-muted-foreground', className)} {...props} />;
});
DialogDescription.displayName = 'DialogDescription';

export { Dialog, DialogPortal, DialogOverlay, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription };
