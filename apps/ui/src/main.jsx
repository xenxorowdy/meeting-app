import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { TooltipProvider } from '@/components/ui/tooltip';
import { applyTheme, getTheme } from '@/lib/theme';
import { applyPreferences, getPreferences } from '@/lib/preferences';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import './index.css';

applyTheme(getTheme());
applyPreferences(getPreferences());

const rootElement = document.getElementById('root');

if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <TooltipProvider delayDuration={400} skipDelayDuration={200}>
                <AppErrorBoundary><App /></AppErrorBoundary>
            </TooltipProvider>
        </React.StrictMode>
    );
}
