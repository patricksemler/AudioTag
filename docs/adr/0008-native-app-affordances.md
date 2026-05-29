# 8. Native-app affordances over web defaults

Date: 2026-05-29

## Status

Accepted

## Context

AudioTag ships a web UI inside a Tauri webview. By default that webview carries
every behavior of a browser page: arbitrary text selection (you can highlight a
button label, a column header, or Ctrl/Cmd+A the entire document), an I-beam
cursor over plain text, reload (Cmd/Ctrl+R, F5), print (Cmd/Ctrl+P), in-engine
zoom (Cmd/Ctrl with +/-/0 and Ctrl+scroll / trackpad pinch), history
back/forward, and HTML5 drag of images and elements.

Those are correct for a document you read; they are wrong for a desktop tool you
operate. They make the app *feel* like a rendered web page — text selects when
you click-drag to range-select rows, the cover art drags out as a ghost image,
an accidental pinch zooms the whole UI. We already suppressed the native
right-click menu (reload/inspect/back) for the same reason; this generalizes that
stance into a deliberate policy.

## Decision

Treat the webview as an application surface, not a page.

- **Selection is opt-in, not opt-out.** `user-select: none` and `cursor: default`
  are set globally on `html`; selection and the text caret are re-enabled only on
  `input`, `textarea`, and `contenteditable` — i.e. only where the user is
  actually editing a value. (CSS in `src/App.css`.)
- **Browser-only gestures are intercepted** at the `window` level and
  `preventDefault`-ed: reload, print, zoom keys, Ctrl/Cmd+wheel and pinch
  (`gesture*` events), history back/forward (Alt+Arrows, Cmd+[ / Cmd+]), and
  `dragstart`. Images are also marked `draggable={false}`. (Effect in
  `src/App.tsx`.)

OS-level file drag-and-drop (handled via Tauri's `onDragDropEvent`) and the
pointer-based column/sidebar reordering do **not** use the HTML5 drag API, so
suppressing `dragstart` leaves them working.

## Consequences

- The app reads as a native window: chrome isn't selectable, the cursor is an
  arrow except in fields, and the layout can't be zoomed or navigated away from.
- Accessibility is unchanged: keyboard navigation, focus-visible rings, and
  screen-reader semantics don't depend on text selection. Field editing — the
  one place selection matters — keeps full select/copy/paste.
- New UI must follow the rule: any genuinely selectable read-only text (should it
  ever be needed) has to opt back in explicitly with `user-select: text`.
- These are conventions enforced by a stylesheet block plus one effect, not the
  framework, so a future contributor could regress them; both are commented to
  explain why they exist.
