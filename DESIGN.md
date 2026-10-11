# UI Design Rules

Binding for every view in `apps/ui`. The target is a native macOS app — System Settings,
Finder, Notes — not a SaaS landing page.

## Anti-patterns (HARD RULES — never violate)

These are the "vibe coded" tells. Banned:

- ❌ Inter, Roboto, Open Sans, Lato, or `system-ui` as the *only* font
- ❌ Purple/blue gradient backgrounds, or gradient text on headings
- ❌ Centered hero with a pill badge above the H1
- ❌ Three identical feature cards in a row with icons
- ❌ Glassmorphism / backdrop-blur panels as decoration
- ❌ Glowing blobs, abstract shapes, or "aurora" backgrounds
- ❌ Colored left borders on cards
- ❌ Pill badge spam ("AI-powered", "New", "Beta" on every section)
- ❌ Emoji as icons in nav or sidebar
- ❌ Nested cards (card inside card inside card)
- ❌ Drop shadows on everything — 1px borders, elevation only where it floats
- ❌ Uniform spacing (everything 16px or 24px, no rhythm)
- ❌ shadcn/ui default styling left untouched

## Apple design system

### Typography

| Property | Value |
|---|---|
| Stack | `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif` |
| Scale | 11 / 13 / 15 / 17 / 22 / 28 / 34 (Apple's actual sizes) |
| Weight | 400 body, 600 headings, 700 for emphasis only |
| Line height | 1.4 body, 1.2 headings |
| Letter spacing | −0.02em on headings ≥ 22pt |

### Spacing — 8pt grid, strict

- 4px — micro gaps (icon to label)
- 8px — component internal
- 16px — between related elements
- 32px — between sections
- 40–60px — page-level padding

**Never** 12px, 20px, 28px, or any non-multiple-of-4.

### Color

| Role | Light | Dark |
|---|---|---|
| Background | `#FFFFFF` | `#1C1C1E` |
| Surface | `#F5F5F7` | `#2C2C2E` |
| Text primary | `#1D1D1F` | `#F5F5F7` |
| Text secondary | `#6E6E73` | `#A1A1A6` |
| Accent | `#007AFF` | `#007AFF` |
| Border | `#E5E5EA` @ 1px | — |

Accent used sparingly — **one per view, max**. No shadows unless floating. No gradients.
No decorative color.

### Layout

- Left-aligned. No centered layouts except modals/dialogs.
- Max content width: 680px reading, 960px dashboards.
- Asymmetric is fine. Symmetric grids are not.
- One primary action per screen. Secondary actions are text links, not buttons.
- Tables: 40px rows, 13px text, no zebra striping, subtle 1px dividers.
- Lists: 48px rows, 16px icon left, text, trailing chevron.

### Components

- **Buttons** — 36px height, 10px radius, 15px font, no shadow
  - Primary: `#007AFF` bg, white text
  - Secondary: `#F5F5F7` bg, `#1D1D1F` text, 1px `#E5E5EA` border
- **Inputs** — 36px height, 10px radius, 1px `#D1D1D6` border, focus 2px `#007AFF` ring
- **Cards** — 12px radius, 1px `#E5E5EA` border, **no shadow**, 16px padding
- **Toggle/Switch** — native macOS style, 51×31px
- **View switching** — segmented control, not tabs

### Motion

- 200ms ease-out for all transitions
- No bounce, no spring, no parallax
- Fade + 4px slide for sheets and popovers
- Nothing animates on page load — it's a desktop app, not a landing page

### Electron shell

- Custom titlebar: 52px height, traffic lights 12px from top-left
- Sidebar: 220px wide, `#F5F5F7`, 13px items, 8px vertical padding per item
- Content area: 40px padding, overlay scrollbars only when needed
- Window: no border-radius on the window itself — the OS handles it

## Workflow

1. Before writing any component, state which rules above apply.
2. After generating code, self-audit against the anti-pattern list. Any match → rewrite.
3. Screenshot it. Compare against System Settings, Finder, Notes. If it reads as a SaaS
   landing page, it's wrong.


## Kesami rounded workspace — 2026-10-09

This amendment governs the whole desktop app and supersedes the blue accent,
small corner radii and typography examples above wherever they conflict.
Requested direction: minimal, rounded borders, rich UI, fewer visible buttons;
audience: anyone using Kesami. The main job is recording, reviewing and recalling meetings.

- Genre: modern-minimal; tone: calm and approachable.
- App macrostructure family: Workbench adapted to an operational workspace,
  with a side rail and account utility footer. No marketing hero or decorative imagery.
- Keep native SF/system display and body typography, with existing DM Mono for time/code.
  Headings are roman, weight 600; body is 13–15px with comfortable line height.
- One shared coral signal, warm neutral surfaces and distinct light/dark palettes.
- 12px control corners, 20px panel corners; 4/8/16/24/32/48px spacing.
- Primary recording control stays visible; account/plans/noise controls use Workspace tools.
  Settings and navigation remain directly accessible. Safety confirmation flows stay explicit.
- Meetings use a divided list inside one rounded panel; secondary row menus appear
  on hover/focus and remain visible on touch. No repeated card grids or ornamental shadows.
- Meeting views, Ask AI, account, pricing, settings and the widget share the system.
- Motion: no entry animation; only short transform/opacity feedback, no springs.
  Focus rings appear immediately. Reduced motion removes spatial feedback.
- At narrow widths, navigation wraps above the content; settings tabs wrap without clipping.
- Shared tokens live in root `tokens.css` and are imported by `apps/ui/src/design.css`.
  Existing CSS and business logic are preserved. Do not regenerate the theme per screen.

## Exports

### CSS tokens

`tokens.css` is the canonical portable export: OKLCH palettes, native font roles,
spacing, typography, radii, rule width, duration and easing tokens.

### Tailwind v4 (portable example only; the application remains on Tailwind 3)

```css
@theme inline {
  --color-paper: var(--color-light-paper);
  --color-ink: var(--color-light-ink);
  --color-accent: var(--color-light-accent);
  --font-sans: var(--font-body);
  --spacing-md: var(--space-md);
  --radius-panel: 20px;
}
```

### DTCG token sample

```json
{
  "color": {
    "paper": { "$type": "color", "$value": "oklch(97% 0.004 55)" },
    "ink": { "$type": "color", "$value": "oklch(25% 0.008 55)" },
    "accent": { "$type": "color", "$value": "oklch(51% 0.17 32)" }
  },
  "radius": { "panel": { "$type": "dimension", "$value": "20px" } }
}
```

### shadcn/ui compatibility

The application retains its existing HSL channel variables in `src/index.css`.
Use `--background`, `--foreground`, `--primary`, `--primary-foreground`,
`--border`, `--input`, and `--ring` through the existing Tailwind mapping;
do not paste OKLCH channels into an HSL consumer. Scoped workspace roles map
onto `--ks-*` in the redesign amendment in `design.css`.
