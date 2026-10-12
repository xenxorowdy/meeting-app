import tailwindcssAnimate from 'tailwindcss-animate';

const spacing = {
    0: '0px',
    px: '1px',
    1: '4px',
    2: '8px',
    4: '16px',
    6: '24px',
    8: '32px',
    9: '36px',
    10: '40px',
    11: '44px',
    12: '48px',
    13: '52px',
    14: '56px',
    16: '64px',
    20: '80px',
    24: '96px',
    28: '112px',
    36: '144px',
    44: '176px',
    56: '224px',
    55: '220px',
};

/** @type {import('tailwindcss').Config} */
export default {
    darkMode: ['class'],
    content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
    theme: {
        extend: {
            spacing,
            fontFamily: {
                sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
                mono: ['ui-monospace', 'SF Mono', 'SFMono-Regular', 'Menlo', 'Cascadia Mono', 'Consolas', 'monospace'],
            },
            fontSize: {
                'large-title': ['34px', { lineHeight: '40px', letterSpacing: '-0.02em', fontWeight: '600' }],
                title1: ['28px', { lineHeight: '34px', letterSpacing: '-0.02em', fontWeight: '600' }],
                title2: ['22px', { lineHeight: '26px', letterSpacing: '-0.02em', fontWeight: '600' }],
                title3: ['17px', { lineHeight: '22px', letterSpacing: '-0.01em' }],
                headline: ['15px', { lineHeight: '20px', letterSpacing: '-0.01em' }],
                body: ['15px', { lineHeight: '21px' }],
                callout: ['13px', { lineHeight: '18px' }],
                subhead: ['13px', { lineHeight: '18px' }],
                footnote: ['12px', { lineHeight: '16px' }],
                caption: ['11px', { lineHeight: '15px' }],
            },
            colors: {
                border: 'hsl(var(--app-border))',
                input: 'hsl(var(--app-input))',
                ring: 'hsl(var(--app-ring))',
                background: 'hsl(var(--app-background))',
                foreground: 'hsl(var(--app-foreground))',
                elevated: 'hsl(var(--app-elevated))',
                segment: 'hsl(var(--app-segment))',
                speaker: {
                    1: 'hsl(var(--app-speaker-1))',
                    2: 'hsl(var(--app-speaker-2))',
                    3: 'hsl(var(--app-speaker-3))',
                    4: 'hsl(var(--app-speaker-4))',
                },
                primary: {
                    DEFAULT: 'hsl(var(--app-primary))',
                    foreground: 'hsl(var(--app-primary-foreground))',
                },
                secondary: {
                    DEFAULT: 'hsl(var(--app-secondary))',
                    foreground: 'hsl(var(--app-secondary-foreground))',
                },
                destructive: {
                    DEFAULT: 'hsl(var(--app-destructive))',
                    foreground: 'hsl(var(--app-destructive-foreground))',
                },
                success: {
                    DEFAULT: 'hsl(var(--app-success))',
                    foreground: 'hsl(var(--app-success-foreground))',
                },
                warning: {
                    DEFAULT: 'hsl(var(--app-warning))',
                    foreground: 'hsl(var(--app-warning-foreground))',
                },
                muted: {
                    DEFAULT: 'hsl(var(--app-muted))',
                    foreground: 'hsl(var(--app-muted-foreground))',
                },
                accent: {
                    DEFAULT: 'hsl(var(--app-accent))',
                    foreground: 'hsl(var(--app-accent-foreground))',
                },
                popover: {
                    DEFAULT: 'hsl(var(--app-popover))',
                    foreground: 'hsl(var(--app-popover-foreground))',
                },
                card: {
                    DEFAULT: 'hsl(var(--app-card))',
                    foreground: 'hsl(var(--app-card-foreground))',
                },
            },
            borderRadius: {
                xl: '12px',
                lg: '10px',
                md: '8px',
                sm: '6px',
            },
            boxShadow: {
                control: 'none',
                card: 'none',
                sheet: '0 18px 60px -12px hsl(var(--app-scrim) / 0.45)',
                knob: '0 1px 2px hsl(var(--app-scrim) / 0.24)',
            },
            transitionTimingFunction: {
                'apple-standard': 'cubic-bezier(0, 0, 0.2, 1)',
                'apple-emphasis': 'cubic-bezier(0, 0, 0.2, 1)',
            },
            transitionDuration: {
                DEFAULT: '200ms',
                150: '200ms',
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
                breathe: 'breathe 2s cubic-bezier(0, 0, 0.2, 1) infinite',
            },
        },
    },
    plugins: [tailwindcssAnimate],
};
