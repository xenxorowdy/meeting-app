import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, TriangleAlert } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { getBackendConnection } from '@/lib/connection';

const KIND_LABELS = {
    notes: 'Posts the summary, decisions and action items',
    tasks: 'Creates one task per action item',
};

function blankDraft(connector) {
    const draft = {};
    for (const field of connector.fields || []) {
        draft[field.key] = field.secret ? '' : connector.config?.[field.key] || '';
    }
    return draft;
}

function ConnectorCard({ connector, connectors, disabled }) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(() => blankDraft(connector));
    const [state, setState] = useState(null);

    useEffect(() => {
        setDraft(blankDraft(connector));
    }, [connector]);

    const run = async (label, action) => {
        setState({ status: 'busy', label });
        try {
            const message = await action();
            setState({ status: 'ok', message });
        } catch (cause) {
            setState({ status: 'error', message: cause.message });
        }
    };

    const handleSave = () =>
        run('Saving…', async () => {
            const saved = await connectors.save(connector.provider, draft);
            if (!saved?.connected) return 'Saved. Fill in the remaining fields to finish connecting.';
            const tested = await connectors.test(connector.provider).catch(cause => {
                throw new Error(`Saved, but the check failed: ${cause.message}`);
            });
            setOpen(false);
            return tested;
        });

    const handleAutoPush = checked =>
        run('Saving…', async () => {
            await connectors.save(connector.provider, { autoPush: checked });
            return checked ? 'New meetings will be sent automatically.' : 'Automatic sending is off.';
        });

    const handleSignIn = () =>
        run('Finish signing in in your browser…', async () => {
            await connectors.signIn(connector.provider);
            return connectors.test(connector.provider);
        });

    const busy = state?.status === 'busy';
    const expanded = open || !connector.connected;
    const description = connector.connected && connector.account ? `Signed in as ${connector.account}` : KIND_LABELS[connector.kind];

    return (
        <div className="overflow-hidden rounded-lg border bg-muted">
            <div className="flex items-center justify-between gap-4 px-4 py-4">
                <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                        <span className="text-body font-medium">{connector.label}</span>
                        {connector.connected && <Badge variant="success">Connected</Badge>}
                    </div>
                    <p className="text-footnote text-muted-foreground">{description}</p>
                </div>
                {connector.connected && (
                    <div className="flex shrink-0 items-center gap-2">
                        <Label htmlFor={`auto-${connector.provider}`} className="text-footnote text-muted-foreground">
                            Send after every meeting
                        </Label>
                        <Switch
                            id={`auto-${connector.provider}`}
                            checked={connector.autoPush}
                            disabled={disabled || busy}
                            onCheckedChange={handleAutoPush}
                        />
                        <Button variant="ghost" size="iconSm" aria-label={open ? 'Hide details' : 'Edit details'} onClick={() => setOpen(!open)}>
                            <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden="true" />
                        </Button>
                    </div>
                )}
            </div>

            {expanded && (
                <div className="space-y-4 border-t border-border px-4 py-4">
                    <p className="text-footnote text-muted-foreground">{connector.help}</p>
                    {connector.oauth && !connector.configured && (
                        <p className="text-footnote text-warning">
                            Google sign-in isn’t set up for this workspace yet. It uses the same OAuth client as Google Calendar, with the Google
                            Drive API enabled.
                        </p>
                    )}
                    {connector.fields?.length > 0 && (
                        <div className="grid gap-4 sm:grid-cols-2">
                            {connector.fields.map(field => {
                                const saved = field.secret && connector.config?.[`${field.key}Set`];
                                return (
                                    <div key={field.key} className="space-y-1">
                                        <Label htmlFor={`${connector.provider}-${field.key}`} className="text-footnote font-medium">
                                            {field.label}
                                            {!field.required && <span className="font-normal text-muted-foreground"> (optional)</span>}
                                        </Label>
                                        <Input
                                            id={`${connector.provider}-${field.key}`}
                                            type={field.secret ? 'password' : 'text'}
                                            autoComplete="off"
                                            spellCheck={false}
                                            value={draft[field.key] || ''}
                                            placeholder={saved ? 'Saved — leave blank to keep' : field.placeholder}
                                            onChange={event => setDraft({ ...draft, [field.key]: event.target.value })}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        {connector.connected && (
                            <>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={disabled || busy}
                                    onClick={() =>
                                        run('Disconnecting…', async () => {
                                            await connectors.disconnect(connector.provider);
                                            return 'Disconnected.';
                                        })
                                    }
                                >
                                    Disconnect
                                </Button>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={disabled || busy}
                                    onClick={() => run('Checking…', () => connectors.test(connector.provider))}
                                >
                                    Test
                                </Button>
                            </>
                        )}
                        {connector.oauth ? (
                            !connector.connected && (
                                <Button size="sm" disabled={disabled || busy || !connector.configured} onClick={handleSignIn}>
                                    Sign in with Google
                                </Button>
                            )
                        ) : (
                            <Button size="sm" disabled={disabled || busy} onClick={handleSave}>
                                {connector.connected ? 'Save' : 'Connect'}
                            </Button>
                        )}
                    </div>
                </div>
            )}

            {state && (
                <div
                    className={cn(
                        'border-t border-border px-4 py-2 text-footnote',
                        state.status === 'error' ? 'text-destructive' : 'text-muted-foreground'
                    )}
                    role="status"
                >
                    {state.status === 'busy' ? state.label : state.message}
                </div>
            )}
        </div>
    );
}

function CopyButton({ value, label }) {
    const [copied, setCopied] = useState(false);
    return (
        <Button
            variant="secondary"
            size="sm"
            onClick={() => {
                navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }}
        >
            {copied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? 'Copied' : label}
        </Button>
    );
}

function McpSection({ mcp }) {
    const connection = getBackendConnection();
    const url = `${connection.url}${mcp?.path || '/mcp'}`;
    const header = connection.token ? ` --header "Authorization: Bearer ${connection.token}"` : '';
    const headers = connection.token ? { headers: { Authorization: `Bearer ${connection.token}` } } : {};
    const snippets = {
        claude: `claude mcp add --transport http kesami ${url}${header}`,
        json: JSON.stringify({ mcpServers: { kesami: { url, ...headers } } }, null, 2),
    };

    return (
        <div className="space-y-4 rounded-lg border bg-muted px-4 py-4">
            <div className="space-y-1">
                <div className="flex items-center gap-2">
                    <span className="text-body font-medium">MCP server</span>
                    <Badge variant="tinted">Read-only</Badge>
                </div>
                <p className="text-footnote text-muted-foreground">
                    Let Claude, Cursor and other AI tools search your meetings, read notes and transcripts, and list action items. It runs on this
                    computer while Kesami is open.
                </p>
            </div>
            <div className="select-text break-all rounded-md border bg-background px-2 py-2 font-mono text-footnote">{url}</div>
            <div className="flex flex-wrap gap-2">
                <CopyButton value={snippets.claude} label="Copy Claude Code command" />
                <CopyButton value={snippets.json} label="Copy JSON config (Cursor, others)" />
            </div>
            {mcp?.hosted && (
                <p className="text-footnote text-muted-foreground">
                    This workspace is hosted, so the address above is reachable from other machines. The copied config includes your access token —
                    keep it private.
                </p>
            )}
        </div>
    );
}

const SECTIONS = [
    ['notes', 'Notes'],
    ['tasks', 'Tasks'],
];

export function ConnectorsPanel({ connectors, disabled = false }) {
    return (
        <div className="space-y-5">
            {connectors.error && (
                <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/[0.08] px-4 py-4">
                    <TriangleAlert className="mt-[1px] size-4 shrink-0 text-warning" aria-hidden="true" />
                    <p className="text-footnote text-muted-foreground">{connectors.error}</p>
                </div>
            )}
            {connectors.loading && connectors.providers.length === 0 && <p className="text-footnote text-muted-foreground">Loading connectors…</p>}

            {SECTIONS.map(([kind, title]) => {
                const group = connectors.providers.filter(connector => connector.kind === kind);
                return (
                    group.length > 0 && (
                        <section key={kind} className="space-y-2">
                            <h3 className="text-callout font-semibold">{title}</h3>
                            {group.map(connector => (
                                <ConnectorCard key={connector.provider} connector={connector} connectors={connectors} disabled={disabled} />
                            ))}
                        </section>
                    )
                );
            })}

            <section className="space-y-2">
                <h3 className="text-callout font-semibold">AI tools</h3>
                <McpSection mcp={connectors.mcp} />
            </section>
        </div>
    );
}
