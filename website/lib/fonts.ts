import 'server-only';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The display face is Brier (Fatima Abbas, Type Department). It is commercial, so it cannot be fetched
// from a font CDN: with a Web licence, put the files in public/fonts under these names and the next
// build serves and preloads them. Until then the page uses Instrument Serif (SIL OFL, vendored beside
// them) under the same family name, so no CSS changes either way.
const BRIER = [
    { file: 'brier-regular.woff2', weight: 400 },
    { file: 'brier-bold.woff2', weight: 700 },
];
const STAND_IN = [{ file: 'instrument-serif-latin.woff2', weight: 400 }];

// Checked once when the module loads — at build time for this static page — never per request.
const FONT_DIR = join(process.cwd(), 'public', 'fonts');
const licensed = BRIER.filter(face => existsSync(join(FONT_DIR, face.file)));

export const DISPLAY_FACES = licensed.length ? licensed : STAND_IN;

export const DISPLAY_FONT_CSS = DISPLAY_FACES.map(
    face =>
        `@font-face{font-family:'Kesami Display';src:url(/fonts/${face.file}) format('woff2');font-weight:${face.weight};font-style:normal;font-display:swap}`
).join('');
