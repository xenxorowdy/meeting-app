import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    // Relative asset paths so the built UI also loads from file:// inside the
    // Electron shell, not just from a dev server.
    base: './',
    resolve: {
        dedupe: ['react', 'react-dom'],
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 5173,
        strictPort: false,
        proxy: {
            '/ws': {
                target: 'ws://localhost:48900',
                ws: true,
            },
            '/api': {
                target: 'http://localhost:48900',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: path.resolve(__dirname, 'index.html'),
                widget: path.resolve(__dirname, 'widget.html'),
            },
        },
    },
});
