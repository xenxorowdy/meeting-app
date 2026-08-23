import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { TooltipProvider } from '@/components/ui/tooltip';
import { applyTheme, getTheme } from '@/lib/theme';
import './index.css';

applyTheme(getTheme());

const rootElement = document.getElementById('root');

if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <TooltipProvider delayDuration={400} skipDelayDuration={200}>
                <App />
            </TooltipProvider>
        </React.StrictMode>
    );
}
