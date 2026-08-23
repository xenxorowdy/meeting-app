import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
    darkMode: ['class'],
    content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
    theme: {
        extend: {
            fontFamily: {
                sans: [
                    '-apple-system',
                    'BlinkMacSystemFont',
                    'SF Pro Text',
                    'Segoe UI Variable Text',
                    'Segoe UI',
                    'Roboto',
                    'Helvetica Neue',
                    'Arial',
                    'sans-serif',
                ],
                mono: ['ui-monospace', 'SF Mono', 'SFMono-Regular', 'Menlo', 'Cascadia Mono', 'Consolas', 'monospace'],
            },
            fontSize: {
                'large-title': ['26px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
                title1: ['22px', { lineHeight: '28px', letterSpacing: '-0.015em' }],
                title2: ['17px', { lineHeight: '22px', letterSpacing: '-0.01em' }],
                title3: ['15px', { lineHeight: '20px', letterSpacing: '-0.005em' }],
                headline: ['13px', { lineHeight: '16px', letterSpacing: '-0.005em' }],
                body: ['13px', { lineHeight: '18px' }],
                callout: ['12px', { lineHeight: '16px' }],
                subhead: ['11px', { lineHeight: '15px' }],
                footnote: ['11px', { lineHeight: '14px' }],
                caption: ['10px', { lineHeight: '13px' }],
            },
            colors: {
                border: 'hsl(var(--border))',
                input: 'hsl(var(--input))',
                ring: 'hsl(var(--ring))',
                background: 'hsl(var(--background))',
                foreground: 'hsl(var(--foreground))',
                elevated: 'hsl(var(--elevated))',
                segment: 'hsl(var(--segment))',
                speaker: {
                    1: 'hsl(var(--speaker-1))',
                    2: 'hsl(var(--speaker-2))',
                    3: 'hsl(var(--speaker-3))',
                    4: 'hsl(var(--speaker-4))',
                },
                primary: {
                    DEFAULT: 'hsl(var(--primary))',
                    foreground: 'hsl(var(--primary-foreground))',
                },
                secondary: {
                    DEFAULT: 'hsl(var(--secondary))',
                    foreground: 'hsl(var(--secondary-foreground))',
                },
                destructive: {
                    DEFAULT: 'hsl(var(--destructive))',
                    foreground: 'hsl(var(--destructive-foreground))',
                },
                success: {
                    DEFAULT: 'hsl(var(--success))',
                    foreground: 'hsl(var(--success-foreground))',
                },
                warning: {
                    DEFAULT: 'hsl(var(--warning))',
                    foreground: 'hsl(var(--warning-foreground))',
                },
                muted: {
                    DEFAULT: 'hsl(var(--muted))',
                    foreground: 'hsl(var(--muted-foreground))',
                },
                accent: {
                    DEFAULT: 'hsl(var(--accent))',
                    foreground: 'hsl(var(--accent-foreground))',
                },
                popover: {
                    DEFAULT: 'hsl(var(--popover))',
                    foreground: 'hsl(var(--popover-foreground))',
                },
                card: {
                    DEFAULT: 'hsl(var(--card))',
                    foreground: 'hsl(var(--card-foreground))',
                },
            },
            borderRadius: {
                xl: 'calc(var(--radius) + 4px)',
                lg: 'var(--radius)',
                md: 'calc(var(--radius) - 2px)',
                sm: 'calc(var(--radius) - 4px)',
            },
            boxShadow: {
                control: '0 1px 1px hsl(var(--scrim) / 0.06)',
                card: '0 1px 3px hsl(var(--scrim) / 0.08), 0 4px 14px -6px hsl(var(--scrim) / 0.12)',
                sheet: '0 18px 60px -12px hsl(var(--scrim) / 0.45)',
            },
            transitionTimingFunction: {
                'apple-standard': 'cubic-bezier(0.4, 0, 0.2, 1)',
                'apple-emphasis': 'cubic-bezier(0.32, 0.72, 0, 1)',
            },
            keyframes: {
                'level-idle': {
                    '0%, 100%': { transform: 'scaleY(0.22)' },
                    '50%': { transform: 'scaleY(0.4)' },
                },
                breathe: {
                    '0%, 100%': { opacity: '1' },
                    '50%': { opacity: '0.45' },
                },
            },
            animation: {
                'level-idle': 'level-idle 1.6s ease-in-out infinite',
                breathe: 'breathe 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
            },
        },
    },
    plugins: [tailwindcssAnimate],
};
