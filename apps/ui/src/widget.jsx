import React from 'react';
import ReactDOM from 'react-dom/client';
import { StatusWidget } from '@/components/StatusWidget';
import { applyTheme, getTheme } from '@/lib/theme';
import './index.css';

applyTheme(getTheme());
document.body.classList.add('transparent-shell');

const rootElement = document.getElementById('root');

if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <StatusWidget />
        </React.StrictMode>
    );
}
