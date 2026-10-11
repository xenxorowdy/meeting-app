const DEFAULT_TIMEOUT_MS = 10_000;

function holdQuitUntil(
    app,
    cleanup,
    {
        beforeExit = () => {},
        onError = () => {},
        timeoutMs = DEFAULT_TIMEOUT_MS,
        schedule = setImmediate,
        startTimer = setTimeout,
        stopTimer = clearTimeout,
    } = {}
) {
    let holding = false;
    let exiting = false;

    const exit = () => {
        if (exiting) return;
        exiting = true;
        schedule(() => {
            try {
                beforeExit();
            } catch (cause) {
                onError(cause);
            }
            app.exit(0);
        });
    };

    app.on('before-quit', event => {
        if (exiting) return;
        event.preventDefault();
        if (holding) return;
        holding = true;
        const deadline = startTimer(exit, timeoutMs);
        Promise.resolve()
            .then(cleanup)
            .catch(onError)
            .finally(() => {
                stopTimer(deadline);
                exit();
            });
    });
}

module.exports = { holdQuitUntil, DEFAULT_TIMEOUT_MS };
