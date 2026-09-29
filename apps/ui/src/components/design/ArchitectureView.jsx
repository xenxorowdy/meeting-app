import React from 'react';
import { ArrowDown, ArrowLeftRight, AudioLines, CalendarDays, Database, Laptop, Network, PlugZap, Server, ShieldCheck, Workflow } from 'lucide-react';

const layers = [
    { icon: Laptop, title: 'Desktop shell', detail: 'Electron owns windows, tray, OS permissions and local recording files.', tech: 'apps/desktop' },
    { icon: Network, title: 'React interface', detail: 'Views and feature hooks coordinate meetings, history, chat and settings.', tech: 'apps/ui' },
    { icon: Server, title: 'Rust core backend', detail: 'HTTP and WebSocket APIs own sessions, transcription, summaries and persistence.', tech: '127.0.0.1:48900' },
];

const capabilities = [
    { icon: AudioLines, title: 'Meeting capture', body: 'Electron captures microphone and system audio. The UI streams audio to the backend, which returns live transcript events.' },
    { icon: Database, title: 'Local library', body: 'Meeting folders store JSON and Markdown. SQLite supports accounts, billing, chat and search.' },
    { icon: PlugZap, title: 'AI providers', body: 'Sarvam handles speech recognition. Gemini or Claude CLI can generate summaries and grounded chat responses.' },
    { icon: CalendarDays, title: 'Connected services', body: 'Google and Microsoft calendars provide events. Optional Supabase checks and payment providers are separate integrations.' },
];

export function ArchitectureView() {
    return (
        <div className="ks-home-scroll ks-architecture-scroll">
            <div className="ks-architecture">
                <header className="ks-architecture-heading">
                    <span className="ks-architecture-eyebrow"><Network size={14} /> SYSTEM MAP</span>
                    <h1>How Kesami works</h1>
                    <p>A local-first desktop app, with clear boundaries between the interface, operating system and meeting services.</p>
                </header>

                <section className="ks-architecture-flow" aria-label="Application layers">
                    {layers.map(({ icon: Icon, title, detail, tech }, index) => (
                        <React.Fragment key={title}>
                            <article className="ks-architecture-layer">
                                <span className="ks-architecture-icon"><Icon size={19} /></span>
                                <div><h2>{title}</h2><p>{detail}</p><code>{tech}</code></div>
                            </article>
                            {index < layers.length - 1 && <div className="ks-architecture-connector" aria-hidden="true"><ArrowDown size={16} /><span>{index === 0 ? 'preload bridge' : 'HTTP · WebSocket'}</span></div>}
                        </React.Fragment>
                    ))}
                </section>

                <section className="ks-architecture-boundary">
                    <div className="ks-architecture-boundary-icon"><ShieldCheck size={18} /></div>
                    <div><strong>Data boundary</strong><p>Recordings stay on the desktop. Audio or transcript text is sent to the selected provider when its feature is used. Accounts do not create isolated meeting libraries.</p></div>
                </section>

                <div className="ks-architecture-section-heading"><div><span>CAPABILITIES</span><h2>What connects to the core</h2></div><Workflow size={18} /></div>
                <section className="ks-architecture-grid">
                    {capabilities.map(({ icon: Icon, title, body }) => <article className="ks-architecture-card" key={title}><Icon size={18} /><h3>{title}</h3><p>{body}</p></article>)}
                </section>
                <footer className="ks-architecture-note"><ArrowLeftRight size={14} /> The renderer talks to the backend through shared HTTP and WebSocket client utilities; OS access goes through named Electron preload APIs.</footer>
            </div>
        </div>
    );
}
