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
