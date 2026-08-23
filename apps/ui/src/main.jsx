import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { TooltipProvider } from '@/components/ui/tooltip';
import { applySystemAppearance } from '@/hooks/useSystemAppearance';
import './index.css';

applySystemAppearance(window.matchMedia('(prefers-color-scheme: dark)').matches);

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
