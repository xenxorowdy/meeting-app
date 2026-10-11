import { ImageResponse } from 'next/og';

export const alt = 'Kesami — Your meetings shouldn’t disappear when the call ends. Meeting memory for macOS and Windows.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Same bar geometry as components/Logo.tsx, in pixels for a 96px tile.
const BARS = [
    { x: 19, h: 30 },
    { x: 35, h: 54 },
    { x: 50, h: 39 },
    { x: 66, h: 60 },
];

// The share card uses the image renderer's own sans: it reads TTF/OTF only, and the site ships woff2.
export default function OpengraphImage() {
    return new ImageResponse(
        <div
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: 72,
                background: '#f5f5f0',
                color: '#111111',
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
                <div style={{ position: 'relative', display: 'flex', width: 96, height: 96, borderRadius: 27, background: '#ff5e00' }}>
                    {BARS.map(bar => (
                        <div
                            key={bar.x}
                            style={{
                                position: 'absolute',
                                left: bar.x,
                                top: (96 - bar.h) / 2,
                                width: 11,
                                height: bar.h,
                                borderRadius: 6,
                                background: '#ffffff',
                            }}
                        />
                    ))}
                </div>
                <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: 4 }}>KESAMI</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', fontSize: 84, fontWeight: 700, lineHeight: 1.02, letterSpacing: -3 }}>
                <span>Your meetings shouldn’t disappear</span>
                <span style={{ color: '#e25300' }}>when the call ends.</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 30, color: '#4a4a46' }}>
                <div style={{ display: 'flex', padding: '10px 24px', borderRadius: 999, background: '#ff5e00', color: '#111111', fontWeight: 700 }}>
                    Get Kesami
                </div>
                Meeting memory · macOS and Windows
            </div>
        </div>,
        size
    );
}
