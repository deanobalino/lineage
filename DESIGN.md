# Lineage Design System

## Intent

Lineage is a forensic review instrument. The interface should disappear behind the diff, then become unmistakably specific when provenance is available. Its signature is the evidence seam: a chamfered bracket that visually joins a selected changed line to its explanation without relying on color alone.

Primary concept references:

- `docs/design/lineage-review-desktop-concept.png` at 1536 × 1024
- `docs/design/lineage-review-phone-concept.png` at 853 × 1844

## Theme

An experienced reviewer works late in a quiet studio under one warm task lamp. The stage is true neutral black, not blue-charcoal. Fired-clay red is reserved for the active task and recorded provenance. Git-only inference remains neutral. Diff additions and removals use low-chroma semantic green and red that remain distinguishable through signs, labels, and line structure.

Color strategy: restrained.

```css
:root {
  --color-bg: oklch(0.08 0 0);
  --color-surface: oklch(0.115 0 0);
  --color-surface-raised: oklch(0.15 0 0);
  --color-surface-selected: oklch(0.205 0.035 24);
  --color-ink: oklch(0.94 0 0);
  --color-muted: oklch(0.7 0 0);
  --color-faint: oklch(0.53 0 0);
  --color-edge: oklch(0.26 0 0);
  --color-primary: oklch(0.66 0.18 24);
  --color-primary-soft: oklch(0.3 0.08 24);
  --color-success: oklch(0.72 0.12 145);
  --color-warning: oklch(0.78 0.13 78);
  --color-danger: oklch(0.65 0.17 24);
  --color-diff-add-bg: oklch(0.22 0.045 145);
  --color-diff-add-ink: oklch(0.83 0.09 145);
  --color-diff-remove-bg: oklch(0.205 0.055 24);
  --color-diff-remove-ink: oklch(0.82 0.085 24);
  --color-focus: oklch(0.88 0.08 78);
}
```

No gradients, bloom, glass, tinted dark base, decorative grain, or all-around shadows.

## Typography

- UI: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Code and true data: `ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace`
- Wordmark: the UI family in light uppercase with deliberate spacing; it is text, not a logo tile.
- Base UI text: 14px desktop, 15px phone.
- Compact chrome: 12px to 13px with normal tracking and sentence case.
- Code: 13px desktop, 13px phone, 1.65 line-height.
- Headings: 18px to 24px, fixed scale, no fluid display typography.
- Prose: 15px, 1.5 line-height, maximum 72ch.

## Geometry

- 0px for rails, tables, diff rows, and full-height regions.
- 4px for inputs and compact buttons.
- 8px only for phone sheets and bounded dialogs.
- Tonal surface changes define most boundaries.
- One-pixel neutral rules are structural, not decorative.
- The evidence seam uses a 10px chamfer and an outward bracket. It must never crop the selected code or inspector text.

## Layout

Desktop at 1280px and above:

- 48px command rail.
- 44px review summary rail.
- 280px changed-file rail.
- Flexible diff with a 620px minimum.
- 420px evidence inspector.
- Independent scrolling for file rail, diff, and evidence.

Tablet from 768px to 1279px:

- Repository and branch controls condense into one context menu.
- File rail becomes an overlay drawer.
- Diff remains primary.
- Evidence becomes a 42% width resizable sheet or full-width focused route in portrait.

Phone below 768px:

- Sequential focused routes preserve all features.
- Review diff is primary.
- The selected line exposes a persistent evidence action above the safe area.
- Evidence opens as a full-height sheet with Back to diff.
- Repository, branches, base, files, capture, exports, sessions, and settings remain reachable from focused menus or routes.
- Touch targets are at least 44px.

## Components

- `CommandRail`: wordmark, repository/branch/base context, Review/Explore, capture state, refresh, actions.
- `ReviewSummary`: five metrics presented as one compact reading line, never metric cards.
- `ChangedFileRail`: filter, grouped status lists, selected file.
- `DiffViewer`: file header, hunk rows, old/new line columns, line selection, horizontal scrolling.
- `EvidenceSeam`: selected-line bracket joining the diff to evidence.
- `EvidenceInspector`: source type, answer, prompt, decision record, constraints, tests, Git evidence, session, follow-up, export.
- `ExploreWorkspace`: repository tree/search, source, selected-line explanation.
- `CaptureWorkspace`: status, queue/replay, installation, diagnostics, dead letters, incomplete evidence.
- `RepositoryWorkspace`: remembered repositories, open/add, restore/forget, demo.
- `SessionWorkspace`: provider metadata, timeline, graph context, transcript, exports.
- `FocusedMenu` and `Dialog`: built on tested accessible primitives and portals.

Every interactive component needs default, hover, focus-visible, active, disabled, loading, and error states. Motion is 150–220ms and communicates panel or selection state only. Content is visible without animation, and reduced motion removes transforms.

## Copy Lock

The primary desktop frame may show:

`LINEAGE`, `Review`, `Explore`, `Capture healthy`, repository, branch, base, `files`, `commits`, `sessions`, `recorded`, `Git only`, changed-file groups, file path, `Recorded provenance`, provider, `Why this changed`, `Prompt`, `Decision`, `Alternatives`, `External constraints`, `Tests`, `Git evidence`, `Open session`, `Ask a follow-up`, and `Export`.

The phone frame may additionally show `Open evidence` and `Back to diff`.

## Accessibility

- WCAG 2.2 AA minimum, with a 7:1 target for primary text.
- Selected states use shape, text, and position in addition to color.
- Diff additions/removals include `+`/`−`, labels, and accessible row names.
- Focus-visible uses the tonal amber focus token and is never removed.
- Live regions announce loading, capture replay, errors, follow-up completion, and exports.
- All panes and sheets have labeled landmarks and logical focus restoration.
- At 200% zoom the workspace switches to sequential focused views rather than clipping.
