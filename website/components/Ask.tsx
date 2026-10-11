import { AskDemo } from './AskDemo';
import styles from './Ask.module.css';

export function Ask() {
    return (
        <section className={styles.ask} id="ask" data-theme="light" aria-labelledby="ask-title">
            <div className="wrap">
                <div className={styles.head}>
                    <p className="label" data-scramble>
                        Ask Kesami
                    </p>
                    <h2 id="ask-title" className="display h2" data-reveal>
                        Ask a question. <span className="em">Find the source.</span>
                    </h2>
                    <p className="lead" data-reveal style={{ '--d': '120ms' } as React.CSSProperties}>
                        Ask across everything you’ve recorded, one folder, or a single call. Every claim is numbered to the meeting, the date and the
                        moment it was said, so you can check it in a click — AI can still get things wrong.
                    </p>
                </div>
                <AskDemo />
            </div>
        </section>
    );
}
