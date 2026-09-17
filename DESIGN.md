---
name: Syneva
description: An integrated review environment (IRE) — a local browser desk where a human judges an agent's diff and hands back a verdict.
colors:
  bg: "#070909"
  surface: "#0b0e0f"
  panel: "#101415"
  surface-raised: "#151a1c"
  panel-3: "#1d2426"
  line: "#222a2d"
  line-strong: "#354146"
  ink: "#d9d9d4"
  ink-bright: "#fafafa"
  muted: "#8a9396"
  ghost: "#4b5558"
  on-accent: "#050608"
  circuit-cyan: "#00a8ff"
  circuit-cyan-bg: "#081923"
  circuit-cyan-bg-strong: "#0c2533"
  circuit-cyan-line: "#17394a"
  circuit-cyan-line-strong: "#25617a"
  circuit-cyan-fg: "#8fc4d4"
  signal-green: "#00d084"
  signal-green-bg: "#071811"
  signal-green-line: "#163b2b"
  signal-green-fg: "#9af0b2"
  accept: "rgba(34, 197, 94, 0.72)"
  accept-hover: "rgba(34, 197, 94, 0.9)"
  reject: "rgba(63, 63, 70, 0.82)"
  reject-hover: "rgba(82, 82, 91, 0.92)"
  caution-amber: "#e0af68"
  caution-amber-fg: "#f0c783"
  alarm-red: "#ff4d6d"
  alarm-red-fg: "#ff8095"
  guide-rail: "#1b2226"
typography:
  display:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.3
  headline:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.4
  title:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  body:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.08em"
    lineHeight: 1.5
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "16px"
components:
  button:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "5px 8px"
  button-hover:
    backgroundColor: "{colors.surface-raised}"
  button-primary:
    backgroundColor: "{colors.circuit-cyan-bg}"
    textColor: "{colors.circuit-cyan-fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "5px 8px"
  button-primary-hover:
    backgroundColor: "{colors.circuit-cyan-bg-strong}"
  button-accept:
    backgroundColor: "{colors.accept}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
  button-accept-hover:
    backgroundColor: "{colors.accept-hover}"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "8px"
---

# Design System: Syneva

## Overview

**Creative North Star: "The Verdict Ledger"**

Syneva's interface is a desk for recording verdicts. It reads like a dark, ruled ledger: five near-black surfaces stacked one tonal step apart, every boundary drawn with a 1px hairline, and nothing floating unless it truly floats. The voice is quiet, exact, and confident — the record outlives the session, so nothing on the desk is allowed to shout. Color is ink for decisions, not decoration: cyan marks questions and interaction, green marks acceptance and additions, amber marks a requested change, red marks removal and error. Everything else stays gray.

The chrome is machinery-precise. Controls are small, bordered, and look pressable: a hover brightens the border one rung and steps the fill one tone, exactly the way a key presses. Ten-pixel uppercase micro-labels with wide letter-spacing are the chrome's own script, while anything that is code, a path, or an identifier is typeset in a drafting mono — the ledger's record vs. the clerk's hand.

Because the desk is the whole product (see PRODUCT.md: "the review surface is the whole product"), the system must read equally well in its dark default and its light mirror, and with any of the fourteen curated code themes the user can pair with either mode. All values below are the dark defaults; the light mode is a wholesale flip of the semantic tokens with hues kept and darkened for contrast on white.

**Key Characteristics:**

- Five-step near-black surface ladder (canvas → recessed → panel → raised → selected), separated by 1px hairlines, never by shadows
- Two voices: Geist for the chrome, JetBrains Mono for anything that is code, a path, or an identifier
- Color as signal only — circuit cyan (interaction/questions), signal green (accept/added), caution amber (change requested), alarm red (removed/error); the chrome itself stays gray
- 10px uppercase micro-labels are the chrome's voice; type never exceeds a 17px display step
- Only floating layers cast shadows: tooltip, dropdown menu, modal, off-canvas drawer, floating verdict buttons
- Both display modes and both code themes are user settings; every surface must survive all four combinations

## Colors

An ink-drawn neutral world with four signal hues held strictly in reserve: cyan for the reviewer's questions and interactions, green for what survives, amber for what must change, red for what must go.

### Primary

- **Circuit Cyan** (#00a8ff; light: #0067c0): the interactive hue — focus, links, comment anchors, question threads, the primary button. It never appears as a bare wash: it carries a tinted triad (fill `--cyan-bg` #081923, hover fill `--cyan-bg-strong` #0c2533, line `--cyan-line` #17394a, hover line `--cyan-line-strong` #25617a, text `--cyan-fg` #8fc4d4) so it can tint a surface without dyeing the desk.

### Secondary

- **Signal Green** (#00d084; light: #16a34a): acceptance and additions — accepted hunks, review progress, the Send action. Its own triad: fill `--green-bg` #071811, line `--green-line` #163b2b, text `--green-fg` #9af0b2.
- **Verdict fills** — Accept `rgba(34, 197, 94, 0.72)` (hover `0.9`) and Reject `rgba(63, 63, 70, 0.82)` (hover `0.92`; light: `rgba(0,0,0,0.055)` / `0.1`): alpha washes with near-black `--on-accent` text. These are the only solid accent fills in the system, reserved for the Keep/Undo verdict buttons.

### Tertiary

- **Caution Amber** (#e0af68; light: #b46f18; text #f0c783 / #8f5711): change-requested intents, critical guide categories, stale notices.
- **Alarm Red** (#ff4d6d; light: #d81f43; text #ff8095 / #b3163a): removed lines, destructive-action hints, blockers.

### Neutral

- **Canvas** (#070909): the page and diff backdrop — the darkest ink in the ledger.
- **Recessed** (#0b0e0f): fields sink into this: inputs, sub-headers, scroll-track gutters.
- **Panel** (#101415): the standing surfaces — sidebar, guide bar, modals, default buttons.
- **Raised** (#151a1c): hover and active rows; one tonal step up from Panel.
- **Selected** (#1d2426): the strongest raised tone — selected rows, chips, tooltip fill.
- **Hairline** (#222a2d): the default 1px rule between everything.
- **Hairline Strong** (#354146): emphasized borders, hover borders, the drawer edge.
- **Ink** (#d9d9d4): primary text on any surface.
- **Ink Bright** (#fafafa): highest-contrast text — counters, values, the thing being read.
- **Muted** (#8a9396): secondary text, the default button label tone.
- **Ghost** (#4b5558): faint text and idle icons — present but unpressed.
- **On-Accent** (#050608): near-black text that sits on the solid verdict fills.
- **Guide Rail** (#1b2226): the dotted nesting rails in the file tree.

**Named Rules:**

**The Signal-Only Rule.** Color never decorates. Every saturated pixel on the desk marks a verdict, a state, a question, or focus; chrome text, borders, and fills stay neutral unless they carry signal.

**The Tint-Not-Fill Rule.** Accents appear as tinted fills under 1px tinted borders with tinted text (the bg/line/fg triad). The solid accent wash is reserved for verdict buttons — if a control isn't recording a verdict, it gets the tint, not the fill.

**The Two-Masters Rule.** Chrome light/dark and the code highlight theme are independent settings that may mix freely; never couple them or derive one from the other.

### Light mode

`data-theme="light"` (Settings → Appearance) flips only the semantic color tokens, wholesale — radius, type scale, and fonts never change. Structural surfaces invert to a white ladder: Canvas #ffffff, Recessed #f2f4f5, Panel #f7f8f9, Raised #eceff1, Selected #dfe4e7; hairlines to #d6dcdf / #b6c0c4; text to Ink #1b1f21, Ink Bright #05080a, Muted #5a6469, Ghost #9aa4a8. Accents keep their hue and darken so rails and text read on white: Circuit Cyan #0067c0 (fill #e8f2fb, hover #d7e9f8, line #bcdaf0, hover line #7fb4de, text #1d5f86), Signal Green #16a34a (fill #e7f6ee), Caution Amber #b46f18, Alarm Red #d81f43. The alpha verdict fills keep their values so they blend into light tints under the still-near-black On-Accent text.

## Typography

**Display Font:** Geist (Google Fonts, weights 400–700) with `system-ui, -apple-system, 'Segoe UI', Roboto` fallback
**Code Font:** JetBrains Mono (weights 400–700) with `ui-monospace, monospace` fallback
**Label/Mono Font:** no third voice — the two fonts cover everything

Both stacks are user-overridable in Settings → Appearance (UI font / Code font), which re-applies them live; the diff canvas takes its family from the Code font via `--diffs-font-family`.

**Character:** a ledger's two scripts. Geist is the clerk's hand — humanist, quiet, slightly warm. JetBrains Mono is the record — drafting-table precise. Mono is the tell for anything written down: code, paths, sizes, line numbers.

### Hierarchy

- **Display** (700, 17px, 1.3): the guide-overview headline and the oversized-file size readout — the largest ink on the desk, and it is still small.
- **Headline** (700, 14px, 1.4): modal titles, section headers.
- **Title** (500, 13px, 1.5): composer input text, emphasized inline values; file names in the guide header are mono at 600.
- **Body** (400, 12px, 1.5–1.6): the chrome's working text — topbar, tree, modal paragraphs, descriptions.
- **Label** (700, 10px, +0.06–0.12em, UPPERCASE): categories, section labels, badges, kbd-adjacent hints — the system's voice. `0.08em` is the standard step; `0.12em` for the faintest standalone labels.
- **Mono** (400, 12px, 1.6): code, paths, counters; 600 when a path is the subject (guide header file names).

**Named Rules:**

**The Two-Voice Rule.** Geist typesets the chrome; JetBrains Mono typesets anything that is code, a path, or an identifier. No third font, ever — even kbd chips use the sans so system glyph symbols render at cap height.

**The Uppercase Whisper Rule.** The label voice whispers at 10px, uppercase, with 0.06–0.12em tracking. Never scale it up, never lowercase it into a heading — if text needs emphasis, it earns a color or a weight, not a size.

## Layout

A fixed application frame, not a scrolling page. The `.app` grid reserves a 48px topbar (tall enough to keep clear air above the progress strip riding its bottom edge) above the workspace. The workspace splits into a 280px sidebar (user-resizable, persisted) | 1px rail | 1fr diff column; the diff column scrolls, the desk does not.

Panels share one continuity device: the sidebar's tab strip and the guide bar both occupy `--subbar-h: 40px`, so their bottom borders draw a single continuous line across the column seam. Between indicators, `--churn-gap: 5px` spaces the +added / −removed churn markers identically on every surface that shows them (walkthrough, overview rows, diff header).

Density is deliberate: 5–8px control paddings, 10px panel insets, 16px modal padding. Scrollbars are drawn by the system — 8px thin, pill thumbs in Hairline gray, strong on hover — so the desk keeps its own edge everywhere.

Below 1100px the sidebar leaves the grid and returns as an off-canvas drawer: fixed under the topbar, `min(86vw, 300px)` wide, sliding in over 0.18s, casting the system's only sideways shadow along its right edge.

**Named Rules:**

**The Continuous Seam Rule.** Bars that touch must share a height (`--subbar-h: 40px`) so their 1px bottom borders read as one ruled line across the whole desk.

## Elevation & Depth

Depth is drawn, not cast. In-page hierarchy comes from the tonal ladder and 1px hairlines; `box-shadow` is evidence that a layer has detached from the desk. The scale is small and strictly sorted by altitude: the verdict button floats 10px, the drawer 24px, the menu 24px, the tooltip 20px, the modal 100px.

### Shadow Vocabulary

- **Floating verdict button** (`box-shadow: 0 2px 10px rgba(0,0,0,0.35)`): the Keep/Undo pills — they sit above the diff they act on.
- **Off-canvas drawer** (`box-shadow: 8px 0 24px rgba(0,0,0,0.35)`): the narrow-mode sidebar; the system's only sideways shadow, and it points right.
- **Dropdown menu** (`box-shadow: 0 8px 24px rgba(0,0,0,0.45)`): popovers and context menus.
- **Tooltip** (`box-shadow: 0 6px 20px rgba(0,0,0,0.5)`): the custom `data-tip` pseudo-element.
- **Modal** (`box-shadow: 0 24px 100px rgba(0,0,0,0.65)`): the deepest point in the system — it is the only full interruption.
- **Focus halo** (`box-shadow: 0 0 0 4px rgba(0,168,255,0.09)`): a soft Circuit Cyan ring around anchored text on hover — attention, not altitude.
- **Accept pulse** (`box-shadow: 0 0 10px 0 var(--green)`, keyframed): the review-progress strip breathing while the review is underway.

**Named Rules:**

**The Floating-Layer Rule.** A shadow is evidence of z, not a style: if it doesn't float above the desk, it doesn't get a shadow.

## Shapes

Compact, controlled radii, each step with a job: **3px** for kbd chips, **4px** for tooltips, menus, and text anchors, **6px** as the workhorse on every button and input, **8px** for modals and cards, **12px** for the largest standalone cards (the desk-closed card), and **999px** reserved for pills and badges. Nothing is notched, clipped, or organically curved.

Edges are hairlines. The default 1px border is `--line`; hover and emphasis brighten it to `--line-strong` — the border never grows thicker, only brighter. The file tree's nesting rails are 1px dotted lines in `--guide`, drawn one every 14px by a clipped repeating gradient, with indent depth at 14px per level.

**Named Rules:**

**The Ruled-Edge Rule.** Edges are drawn with 1px lines and separated by tone; a glow or a thicker border never substitutes for the hairline.

## Components

### Buttons

Machinery-precise: small, bordered, unmistakably pressable, often carrying a kbd chip that shows the shortcut.

- **Shape:** 6px radius, 5px 8px padding, 12px text, 1px border.
- **Default:** Panel fill (#101415), Ink text, hairline border. **Hover:** Raised fill (#151a1c) + Hairline Strong border.
- **Primary (Circuit tint):** `--cyan-bg` fill (#081923), `--cyan-fg` text (#8fc4d4), `--cyan-line` border. Hover steps to `--cyan-bg-strong` / `--cyan-line-strong`. Tint, never solid cyan (Tint-Not-Fill Rule).
- **Green (Signal):** `--green-bg` / `--green-fg` / `--green-line` triad for accept-flavored actions (Send to Agent).
- **Danger:** default until hover, then Alarm Red text, a 55% red border, and a 12% red fill — destructive intent appears only under the cursor.
- **Icon-only:** borderless and transparent at rest (reads apart from bordered actions); hover steps to Raised fill.
- **Focus:** bare controls keep the UA outline; containers that own focus raise their border to Hairline Strong on `:focus-within` (see composer card).

### Segmented toggle

A bordered strip (hairline border, Canvas fill, 8px radius) of borderless segments; the active segment fills Selected (#1d2426) and brightens to Ink. Disabled segments dim to 0.4 opacity.

### Chips and badges

The pill is the only 999px shape, used in three registers:

- **Category labels:** 10px/700 uppercase at +0.08em, tinted text (Circuit Cyan; Caution Amber for critical), no fill.
- **Intent badges:** 10px/600 uppercase at +0.05em, `1px 7px` padding, tinted triad — question: `--cyan-bg` fill + `--cyan-line-strong` border + `--cyan-fg` text; change-requested: amber family.
- **Status pills:** alpha fills (e.g. `rgba(0,208,132,0.12)`) with Signal Green text for "ok".

### Inputs / fields

Fields sink below their surroundings: Canvas fill (#070909, darker than the Panel around them), hairline border, 6px radius, 8px padding, 13px sans text. Placeholder and idle text sit in Ghost.

### Composer card (signature)

The comment composer is a thread card, not a bare input: 2px Circuit Cyan rail on the left (`--cyan-line`, lifted to `--cyan-line-strong`), Recessed fill, `0 6px 6px 0` radius (flat where it meets its rail), transparent borderless textarea inside at 13px/1.6. On `:focus-within` the whole border lifts to Hairline Strong — the card, not the field, announces focus.

### Modal

420px wide (help overlay: 640px / 92vw max), Surface fill, hairline border, 8px radius, 16px padding, the 100px-elevation shadow. Headline at 14px, body in Muted at 12px/1.5; actions right-aligned in a 6px-gap row of small (4px 7px) buttons, confirm actions carrying kbd hints.

### Tooltip

Custom `[data-tip]` pseudo-element, not a native title: Selected fill (#1d2426), Hairline Strong border, 4px radius, 10px text, 6px below the anchor, 0.18s delay, 0.1s fade.

### Dropdown menu

Panel fill, Hairline Strong border, 4px radius, 4px inner padding, 280–420px, the 24px-elevation shadow.

### File tree (signature)

14px-per-depth indent with 1px dotted nesting rails in `--guide`, drawn by a background gradient clipped to the indent width — so any depth renders correctly without fixed classes. Rows: 12px mono-friendly text at 1.6, `3px 6px` padding, hover/active through Raised/Selected.

### Diff canvas

The diff is rendered by `@pierre/diffs` with its own theme system — `pierre-dark` / `pierre-light` CSS-variable themes plus the fourteen curated Shiki themes (comments and fenced code share the same set). Its colors are not part of this token layer; it takes only the Code font (`--diffs-font-family`) and the scrollbar gutter override from the desk. Treat the diff as a mounted instrument: Syneva provides the ledger around it, the instrument themes itself.

## Do's and Don'ts

### Do:

- **Do** carry every accent state as a tinted triad (bg fill + 1px line + tinted text), stepping one rung up on hover (`--cyan-bg` → `--cyan-bg-strong`, `--line` → `--line-strong`).
- **Do** keep chrome text at 12–13px and labels at 10px/700/uppercase/0.06–0.12em.
- **Do** record state through tinted fills **and** text — a verdict must survive without color (badges carry words, not just hues).
- **Do** use the 1px hairline as the universal separator, and align touching bars on `--subbar-h` (40px) so the seam stays continuous.
- **Do** keep controls compact: 5px 8px buttons, 8px inputs, 4–6px gaps.

### Don't:

- **Don't** decorate with gradients, glows, or illustration — the only gradient in the system draws the file tree's guide rails.
- **Don't** cast shadows on in-page surfaces; hierarchy is tonal plus hairline (The Floating-Layer Rule).
- **Don't** introduce a third font, and never let the code font typeset chrome text (The Two-Voice Rule).
- **Don't** exceed 8px radius on containers or 12px on the largest cards; 999px is for pills and badges only.
- **Don't** apply a solid accent fill outside the verdict buttons (The Tint-Not-Fill Rule).
- **Don't** scale type past the 17px display step in the chrome (The Uppercase Whisper Rule applies to labels; the ceiling applies to everything).
