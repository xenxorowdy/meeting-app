import React, { useRef, useState } from 'react';
import { RotateCw, Sparkles, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function SummaryGenerationControl({ meeting, isConnected, isProcessing, isGenerating, onGenerate }) {
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [error, setError] = useState('');
    const requestRef = useRef(false);
    const cancelRef = useRef(false);
    const hasSummary = Boolean(meeting?.summaryMarkdown?.trim());
    const hasNotes = hasSummary || Boolean(meeting?.keyDecisions?.length || meeting?.actionItems?.length || meeting?.emailDraft);
    const hasTranscript = meeting?.transcript?.some(turn => turn.text?.trim());
    const working = pending || isGenerating;
    const disabled = !isConnected || isProcessing || working || !hasTranscript || !onGenerate;

    const generate = async () => {
        if (disabled || requestRef.current) return;
        requestRef.current = true;
        setConfirming(false);
        setError('');
        setPending(true);
        try {
            const result = await onGenerate(meeting.id);
            if (result?.ok === false && !result.cancelled) setError(result.message || 'Could not generate notes. Try again.');
        } catch (cause) {
            setError(cause.message || 'Could not generate notes. Try again.');
        } finally {
            requestRef.current = false;
            setPending(false);
        }
    };

    const cancel = async () => {
        if (!isGenerating || cancelRef.current || !isConnected) return;
        cancelRef.current = true;
        setCancelling(true);
        try {
            const result = await onGenerate(meeting.id);
            if (result?.ok === false && !result.cancelled) setError(result.message || 'Could not stop generation. Try again.');
        } catch (cause) {
            setError(cause.message || 'Could not stop generation. Try again.');
        } finally {
            cancelRef.current = false;
            setCancelling(false);
        }
    };

    return (
        <div className="ks-summary-generation">
            <div className="ks-summary-generation-buttons" aria-busy={working}>
                <Button type="button" className="ks-summary-generate" disabled={disabled}
                    aria-label={hasSummary ? 'Regenerate summary' : 'Generate summary'}
                    onClick={() => hasNotes ? setConfirming(true) : void generate()}>
                    {hasSummary ? <RotateCw aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                    {working ? 'Generating…' : hasSummary ? 'Regenerate' : 'Generate'}
                </Button>
                {isGenerating && <Button type="button" variant="outline" disabled={!isConnected || cancelling}
                    aria-label="Stop summary generation" onClick={() => void cancel()}>
                    <Square aria-hidden="true" />{cancelling ? 'Stopping…' : 'Cancel'}
                </Button>}
            </div>
            {working && <span className="sr-only" role="status">Generating meeting notes.</span>}
            {error && <p className="ks-summary-generation-error" role="alert">{error}</p>}
            {!hasTranscript && <p className="ks-summary-generation-hint">A transcript is needed to generate notes.</p>}
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogContent className="ks-summary-regenerate-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{hasSummary ? 'Regenerate these notes?' : 'Generate new notes?'}</AlertDialogTitle>
                        <AlertDialogDescription>
                            This replaces the summary, extracted decisions, action items and follow-up email, including edits. Reviewed tasks keep their saved state.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep current notes</AlertDialogCancel>
                        <AlertDialogAction disabled={disabled} onClick={() => void generate()}>{hasSummary ? 'Regenerate' : 'Generate'}</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
