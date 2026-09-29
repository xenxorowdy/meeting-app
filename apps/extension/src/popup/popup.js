const elements = {
    state: document.getElementById('state'),
    summary: document.getElementById('summary'),
    speaking: document.getElementById('speaking'),
    roster: document.getElementById('roster'),
    problem: document.getElementById('problem'),
    enabled: document.getElementById('enabled'),
    fallback: document.getElementById('fallback'),
    port: document.getElementById('port'),
    test: document.getElementById('test'),
};

const SOURCES = { 'google-meet': 'Google Meet', zoom: 'Zoom' };

function setState(text, tone) {
    elements.state.textContent = text;
    elements.state.className = `pill${tone ? ` ${tone}` : ''}`;
}

function renderRoster(names, speaking) {
    elements.roster.replaceChildren();
    for (const name of names || []) {
        const item = document.createElement('li');
        item.textContent = name;
        if ((speaking || []).includes(name)) item.className = 'talking';
        elements.roster.append(item);
    }
}

function render(status) {
    const { settings, report, stale } = status;
    elements.enabled.checked = settings.enabled;
    elements.fallback.checked = settings.activityFallback;
    elements.port.value = settings.port;

    if (!settings.enabled) {
        setState('paused');
        elements.summary.textContent = 'Nothing is being sent to Kesami.';
        elements.speaking.textContent = '';
        renderRoster([], []);
        elements.problem.hidden = true;
        return;
    }

    if (!report) {
        setState('waiting');
        elements.summary.textContent = 'Open a Google Meet or Zoom call.';
        return;
    }

    elements.problem.hidden = !report.error;
    elements.problem.textContent = report.error || '';

    const source = SOURCES[report.source] || report.source || 'the call';
    if (report.error) {
        setState('no backend', 'bad');
    } else if (report.accepted) {
        setState('recording', 'on');
    } else {
        setState(report.state ? report.state.toLowerCase() : 'idle');
    }

    const seen = stale ? 'last seen a while ago' : 'live';
    const how = report.method === 'activity' ? 'tile activity' : report.method === 'indicator' ? 'the page indicator' : 'no speaker signal';
    elements.summary.textContent = `${source} · ${seen} · ${how}`;
    elements.speaking.textContent = (report.speaking || []).length ? `Speaking: ${report.speaking.join(', ')}` : '';
    renderRoster(report.participants, report.speaking);

    if (!report.error && !report.accepted) {
        elements.problem.hidden = false;
        elements.problem.textContent = 'Kesami is not recording, so names are held until you start a meeting.';
    }
}

async function refresh() {
    const status = await chrome.runtime.sendMessage({ type: 'kesami:status' });
    if (status) render(status);
}

elements.enabled.addEventListener('change', async () => {
    await chrome.storage.local.set({ enabled: elements.enabled.checked });
    refresh();
});

elements.fallback.addEventListener('change', async () => {
    await chrome.storage.local.set({ activityFallback: elements.fallback.checked });
});

elements.port.addEventListener('change', async () => {
    const port = Number(elements.port.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    await chrome.storage.local.set({ port });
    refresh();
});

elements.test.addEventListener('click', async () => {
    setState('testing…');
    const result = await chrome.runtime.sendMessage({ type: 'kesami:probe' });
    if (result?.ok) {
        setState(`backend ${String(result.state || 'idle').toLowerCase()}`, 'on');
        elements.problem.hidden = true;
    } else {
        setState('no backend', 'bad');
        elements.problem.hidden = false;
        elements.problem.textContent = result?.error || 'The Kesami backend did not answer.';
    }
});

refresh();
setInterval(refresh, 1500);
