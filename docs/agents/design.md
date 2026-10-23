# The design layer

## One stylesheet, imported last (`app/new_design.css`, `app/layout.tsx`)
- `app/new_design.css` is the whole fork look. `app/layout.tsx` imports it after `globals.css`, `settings.css`, `sidebar.css` and `sidebar-menu.css`, so it wins on equal specificity without any of those files being edited to know about it. A new rule belongs here, not in the upstream sheets: a rebase that re-lands upstream CSS then keeps this layer's overrides in one file to re-check.
- Components are overridden by name (`.sidebar-container`, `.session-tree-*`, `.chat-input-*`, `.file-viewer-*`, `.settings-*`) or by the inline styles they write, never by editing the `.tsx`. `app/layout.tsx`'s import is the only change outside this file, so a component added upstream appears in the stock chrome until a rule here names it.
- Tokens are `--nd-*`: ground, surface, raised, hover, selected, borders, ink, positive/negative/warning, code background, the user bubble, accent trio, `--nd-glass` (gradient fill plus top-lit border), `--nd-mat`, `--nd-lift`, the two bloom colours and the vignette. Light values sit in `:root, :root[data-theme]` and dark ones in `html.dark, html.dark:root`; both also remap the upstream `--bg`, `--text`, `--border`, `--tool-bg` names and set `--chat-content-max-width`, so the rest of the app follows without knowing the `--nd-*` vocabulary.

## Palettes
- The base overrides (`--accent`, `--accent-hover`, `--accent-contrast`, `--user-bg`, `--syntax-*`) are declared inside `:where(:root)`, whose specificity is zero: any palette's own rule outranks them, so the twelve non-default palettes keep their accent, user bubble and syntax colours.
- The two default themes are re-declared at normal specificity — `:root[data-theme="light"]` and `html.dark:root[data-theme="dark"]` — so light and dark are this design's amber while a chosen palette is not matched there. Surfaces, ink and hierarchy stay the design's for every palette.
- A font chosen in Settings is honoured by `html:root[style*="--font-ui"] { --nd-sans: ... !important; }`; `:root[data-theme]` outranks a plain attribute selector, so the `!important` is load-bearing (the same reason `--font-mono-default`/`--font-ui-default` are remapped instead of copied).
- `README.md`'s entry states the palette split. Do not describe the design as replacing all fourteen hues: the first pass did, and this pass handed them back.

## Type and atmosphere
- The three faces come from one Google Fonts `@import` at the top of the file: Instrument Serif italic for the wordmark, hero and quotations; Hanken Grotesk for the interface; Martian Mono for data only (counts, durations, paths, tool names, ids, code). The host falls back to system faces when the import cannot load, so nothing depends on the network for layout.
- A font selected in Settings replaces the grotesk and the mono through `--font-ui`/`--font-mono`; the serif brand stays the design's.
- Atmosphere is body pseudo-elements and viewport gradients: a warm bloom low and centre, a cool one high and right, a vignette and a faint scanline pitch. The breathing animation is `prefers-reduced-motion: reduce`-gated.

## Inline styles written by components
- The layer flattens status tints the components write inline, because it cannot change their `.tsx`: selectors like `[style*="background: rgba(34, 197, 94"]` plus `!important` beat an inline declaration. They key on the serialized `rgba()` text, which the browser normalizes to `rgba(34, 197, 94, 0.12)` with spaces.
- A tint that is content rather than chrome must be exempted, or it disappears: a patch line's added/removed fill (`rgba(34, 197, 94, 0.12)`, `rgba(248, 113, 113, 0.13)` in `components/MessageView.tsx`) is excluded through `:where(:not([style*="0.12)"]))`-style guards. A new diff colour, or any other inline fill that must survive, needs the same exemption here; a generic alpha change in the component is otherwise silently flattened.
- Those selectors are matched against the style attribute, not a class, so they are brittle by construction: a component that stops writing that exact colour also stops being themed, and nothing fails. When a card, badge or alert here looks unthemed, check its inline style string first.

## What was verified, and where
- The e2e suite (`e2e/themes.mjs`, `e2e/chat-appearance.mjs`) drives WebKit through both themes and the appearance settings; the layer's own fixes (emphasis weight, an interface font on `body`, the mobile section picker, a second settings scroller, the 320px settings stack, a clipped list marker) came from those runs.
- The `@import` is a render-blocking external request; the page still paints with fallback faces if Google Fonts is unreachable, which is what keeps a local, offline install usable.
