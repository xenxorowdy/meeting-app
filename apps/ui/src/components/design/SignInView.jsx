import React from 'react';
import { ArrowRight, AudioLines, Check, MessageSquareText, Settings2, Sparkles } from 'lucide-react';

export function SignInView({ onContinue }) {
    return (
        <main className="ks-login">
            <section className="ks-login-story" aria-label="About Kesami">
                <div className="ks-brand">
                    <span className="ks-brand-mark"><AudioLines aria-hidden="true" /></span>
                    KESAMI
                </div>
                <div className="ks-login-intro">
                    <span className="ks-eyebrow">YOUR MEETING WORKSPACE</span>
                    <h1>Be in the conversation.<br /><span>Keep the clarity.</span></h1>
                    <p>Turn conversations into a transcript you can search, notes you can use, and answers you can trace back to the meeting.</p>
                    <div className="ks-welcome-preview" aria-hidden="true">
                        <div className="ks-welcome-preview-head"><AudioLines /><span>From conversation to clarity</span><span className="ks-tag">WORKFLOW</span></div>
                        <div className="ks-welcome-flow"><span><Check />Capture</span><i /><span><Check />Understand</span><i /><span><Check />Follow through</span></div>
                        <div className="ks-welcome-preview-question"><MessageSquareText />What did we decide?</div>
                        <p>Review decisions and action items, with links to the conversation behind them.</p>
                    </div>
                </div>
                <p className="ks-welcome-footer">Less note taking. More attention to what matters.</p>
            </section>
            <section className="ks-login-form" aria-labelledby="welcome-title">
                <div className="ks-welcome-icon"><Sparkles aria-hidden="true" /></div>
                <span className="ks-eyebrow">WELCOME TO KESAMI</span>
                <h2 id="welcome-title">Make room for<br />a better meeting.</h2>
                <p>Set up your workspace, connect your AI providers, and start your first conversation.</p>
                <ol className="ks-welcome-steps">
                    <li><span>01</span><div><strong>Choose your setup</strong><p>Use the service on this device or connect to your hosted backend.</p></div></li>
                    <li><span>02</span><div><strong>Make it yours</strong><p>Adjust text size, appearance, audio, and AI preferences.</p></div></li>
                    <li><span>03</span><div><strong>Keep the useful parts</strong><p>Record a meeting, review its notes, and ask a follow-up.</p></div></li>
                </ol>
                <button type="button" className="ks-auth-submit" onClick={() => onContinue()}>
                    Open workspace <ArrowRight aria-hidden="true" />
                </button>
                <button type="button" className="ks-local-entry" onClick={() => onContinue('settings')}>
                    <Settings2 aria-hidden="true" /> Configure connection & preferences
                </button>
                <p className="ks-auth-terms">No account is created here. Your connected service stores meeting data; your selected AI providers process transcription and answers.</p>
            </section>
        </main>
    );
}
