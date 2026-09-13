import React from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';

export class AppErrorBoundary extends React.Component {
    state = { failed: false };

    static getDerivedStateFromError() { return { failed: true }; }

    render() {
        if (!this.state.failed) return this.props.children;
        return (
            <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
                <section className="max-w-lg space-y-6" role="alert">
                    <p className="text-body font-medium text-muted-foreground">KESAMI</p>
                    <h1 className="text-title1 font-semibold">Let’s get you back to your workspace.</h1>
                    <p className="text-body text-muted-foreground">
                        This view ran into a problem. Try opening it again. If a meeting is recording, the service may still be capturing it.
                    </p>
                    <div className="flex flex-wrap gap-4">
                        <button className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-3 text-body text-primary-foreground" onClick={() => this.setState({ failed: false })}>
                            <RotateCcw size={16} /> Try again
                        </button>
                        <button className="inline-flex items-center gap-2 rounded-lg border px-4 py-3 text-body" onClick={() => globalThis.location.reload()}>
                            Reload app <ArrowRight size={16} />
                        </button>
                    </div>
                </section>
            </main>
        );
    }
}
