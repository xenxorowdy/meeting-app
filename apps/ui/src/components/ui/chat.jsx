// Local, open-source chat compositions. These are not HeroUI Pro exports.
import React, { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Button, Disclosure, Skeleton } from '@heroui/react';
import { ArrowDown, Sparkles } from 'lucide-react';

function Conversation({ children, messages, isPending, resetKey, ref }) {
    const viewport = useRef(null);
    const following = useRef(true);
    const anchor = useRef(null);
    const previousKey = useRef(resetKey);
    const [away, setAway] = useState(false);

    const rememberAnchor = useCallback(() => {
        const element = viewport.current;
        if (!element) return;
        const top = element.getBoundingClientRect().top;
        const visible = [...element.querySelectorAll('[data-chat-message]')]
            .find(node => node.getBoundingClientRect().bottom > top);
        anchor.current = visible ? { node: visible, offset: visible.getBoundingClientRect().top - top } : null;
    }, []);

    const jumpToLatest = useCallback(() => {
        following.current = true;
        setAway(false);
        const element = viewport.current;
        if (element) element.scrollTop = element.scrollHeight;
        rememberAnchor();
    }, [rememberAnchor]);
    useImperativeHandle(ref, () => ({ jumpToLatest }), [jumpToLatest]);

    const maintainPosition = useCallback(() => {
        const element = viewport.current;
        if (!element) return;
        if (following.current) element.scrollTop = element.scrollHeight;
        else if (anchor.current?.node.isConnected) {
            // Preserve the visible message through prepends and responsive reflow.
            const offset = anchor.current.node.getBoundingClientRect().top - element.getBoundingClientRect().top;
            element.scrollTop += offset - anchor.current.offset;
        }
        rememberAnchor();
    }, [rememberAnchor]);

    useLayoutEffect(() => {
        if (previousKey.current !== resetKey) {
            previousKey.current = resetKey;
            jumpToLatest();
        } else maintainPosition();
    }, [messages, isPending, resetKey, jumpToLatest, maintainPosition]);

    useLayoutEffect(() => {
        const element = viewport.current;
        const content = element?.querySelector('.chat-conversation__content');
        if (!element || !content) return;
        const observer = new ResizeObserver(maintainPosition);
        observer.observe(element);
        observer.observe(content);
        return () => observer.disconnect();
    }, [maintainPosition]);

    return (
        <div className="chat-conversation">
            <div ref={viewport} className="ks-chat-log" role="log" aria-label="Conversation messages"
                aria-live="polite" aria-relevant="additions" onScroll={() => {
                    const element = viewport.current;
                    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
                    setAway(!following.current);
                    rememberAnchor();
                }}>
                {children}
            </div>
            {away && <Button type="button" variant="secondary" className="chat-conversation__scroll-button"
                onPress={jumpToLatest} aria-label="Jump to latest message">
                <ArrowDown aria-hidden="true" />Latest messages
            </Button>}
        </div>
    );
}

function ConversationContent({ children }) {
    return <div className="chat-conversation__content">{children}</div>;
}
function ScrollAnchor() {
    return <div className="chat-conversation__scroll-anchor" aria-hidden="true" />;
}
export const ChatConversation = Object.assign(Conversation, { Content: ConversationContent, ScrollAnchor });

function Assistant({ children, ...props }) {
    return <div {...props} data-chat-message className="ks-chat-row chat-message--assistant">{children}</div>;
}
function User({ children, ...props }) {
    return <div {...props} data-chat-message className="ks-chat-row ks-chat-row-user chat-message--user">{children}</div>;
}
function Body({ children }) {
    return <div className="ks-chat-bubble ks-chat-assistant chat-message__body">{children}</div>;
}
function Bubble({ children }) {
    return <div className="ks-chat-bubble ks-chat-user chat-message__bubble">{children}</div>;
}
function Content({ children }) {
    return <div className="chat-message__content">{children}</div>;
}
function Actions({ children }) {
    return <div className="chat-message__actions">{children}</div>;
}
export const ChatMessage = { Assistant, User, Body, Bubble, Content, Actions };

function ResponseSkeleton() {
    return <div className="chat-loader__skeleton" role="status">
        <span className="sr-only">Waiting for Kesami’s answer.</span>
        <div aria-hidden="true" className="chat-loader__lines">
            <Skeleton className="chat-loader__line" />
            <Skeleton className="chat-loader__line" />
            <Skeleton className="chat-loader__line" />
        </div>
    </div>;
}
export const ChatLoader = { Skeleton: ResponseSkeleton };

// The endpoint returns a whole answer, not a reasoning stream. Only expose
// client-observed request state; never invent model thoughts or retrieval stages.
export function ChatProgress({ phase }) {
    return <Disclosure className="chat-progress">
        <Disclosure.Heading>
            <Button slot="trigger" variant="ghost" className="chat-progress__trigger">
                <Sparkles aria-hidden="true" />
                {phase === 'creating-conversation' ? 'Starting conversation…' : 'Waiting for an answer…'}
                <Disclosure.Indicator />
            </Button>
        </Disclosure.Heading>
        <Disclosure.Content>
            <Disclosure.Body>
                <ol className="chat-progress__steps">
                    <li><strong>{phase === 'creating-conversation' ? 'Creating your conversation' : 'Question submitted'}</strong>
                        <p>{phase === 'creating-conversation' ? 'Saving a conversation for this meeting scope.' : 'The answer request is in progress. You can cancel below.'}</p></li>
                    <li><strong>Grounded in your meetings</strong><p>Answers use matching meeting excerpts. Detailed search and model progress aren’t available.</p></li>
                </ol>
            </Disclosure.Body>
        </Disclosure.Content>
    </Disclosure>;
}
