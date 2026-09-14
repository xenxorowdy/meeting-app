import React from 'react';
import ReactDOM from 'react-dom/client';
import { StatusWidget } from '@/components/StatusWidget';
import { applyTheme, getTheme } from '@/lib/theme';
import { applyPreferences, getPreferences, subscribePreferences } from '@/lib/preferences';
import './index.css';

applyTheme(getTheme());
// The widget is its own window, so the personal preferences have to be applied
// here too. The preferences store replays storage events from the app's window
// into its subscribers, which keeps this in sync while both windows are open.
applyPreferences(getPreferences());
subscribePreferences(() => applyPreferences(getPreferences()));
document.body.classList.add('transparent-shell');

const rootElement = document.getElementById('root');

if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <StatusWidget />
        </React.StrictMode>
    );
}
