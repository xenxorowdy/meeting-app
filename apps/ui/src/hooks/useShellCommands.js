import { useEffect, useRef } from 'react';

export function useShellCommands({ onRecord, onNewNote, onNewMeeting, onSettings }) {
    const latestRef = useRef({ onRecord, onNewNote, onNewMeeting, onSettings });
    latestRef.current = { onRecord, onNewNote, onNewMeeting, onSettings };

    useEffect(() => {
        const shell = globalThis.kesamiShell;
        if (!shell?.onMenuBarCommand) return undefined;

        const run = command => {
            const handlers = latestRef.current;
            if (command.type === 'record') handlers.onRecord?.(command.event, { auto: command.auto === true });
            else if (command.type === 'new-note') handlers.onNewNote?.();
            else if (command.type === 'new-meeting') handlers.onNewMeeting?.();
            else if (command.type === 'settings') handlers.onSettings?.();
        };

        const unsubscribe = shell.onMenuBarCommand(run);
        shell
            .pendingMenuBarCommand?.()
            .then(command => {
                if (command) run(command);
            })
            .catch(() => {});

        return unsubscribe;
    }, []);
}
