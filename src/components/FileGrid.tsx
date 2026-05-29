import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TriangleAlert, Circle, ChevronUp, ChevronDown } from "lucide-react";
import { coverThumbs } from "../coverThumbs";
import { GRID_COLUMNS, type ColumnDef, type ColumnKey } from "../fields";
import type { CoverArt, EditableField, Row } from "../types";

export interface SortState {
  key: ColumnKey;
  dir: "asc" | "desc";
}

interface FileGridProps {
  rows: Row[];
  selected: Set<string>;
  focusIndex: number;
  sort: SortState | null;
  onSelectSingle: (index: number, viaKeyboard?: boolean) => void;
  onToggle: (index: number) => void;
  onRange: (index: number) => void;
  onSetFocus: (index: number) => void;
  onSelectAll: () => void;
  onActivate: () => void;
  /** Commit an inline (single-click) edit of a single cell. */
  onCellCommit: (id: string, field: EditableField, value: string) => void;
  /** Sort the list by a column (toggles asc/desc on repeat clicks). */
  onSort: (key: ColumnKey) => void;
  /** Open the right-click context menu for the row at `index`. */
  onContextMenu: (index: number, x: number, y: number) => void;
}

const ROW_HEIGHT = 30;
const MIN_COL = 48;

// The fixed leading cover-art column. It sits left of every (reorderable) data
// column and is deliberately kept *out* of the GRID_COLUMNS machinery, so it
// can't be reordered, resized, or sorted — and the column drag/resize maths,
// which measure against the reorderable header, stay untouched.
const THUMB_COL_W = 40; // cell width incl. padding
const THUMB_PX = 28; // rendered image size (px)

// While dragging a header, the dragged column is pulled out (shown as a floating
// ghost) and a "gap" placeholder of its width is inserted at the drop slot.
type RenderCol = { c: number; p: number } | "gap";

// Reused offscreen canvas for measuring text width (column auto-fit).
let measureCanvas: HTMLCanvasElement | null = null;

// ---------------------------------------------------------------------------
// CoverThumb — the fixed leading cell showing a tiny cover-art preview.
//
// It subscribes to the `coverThumbs` store *by path* (not via row props), so a
// thumbnail loading in only re-renders this one cell — the surrounding GridRow
// memo is untouched. A pending pasted cover (`pendingArt`) is shown directly;
// otherwise, when the file has art, the downscaled disk thumbnail is requested
// lazily (on mount) and cached for the session.
// ---------------------------------------------------------------------------
interface CoverThumbProps {
  path: string;
  hasArt: boolean;
  /** Unsaved pasted cover for this row, if any (takes precedence over disk). */
  pendingArt: CoverArt | null | undefined;
}

function CoverThumbImpl({ path, hasArt, pendingArt }: CoverThumbProps) {
  const subscribe = useCallback((cb: () => void) => coverThumbs.subscribe(path, cb), [path]);
  const getSnapshot = useCallback(() => coverThumbs.get(path), [path]);
  const cached = useSyncExternalStore(subscribe, getSnapshot);

  // Only the disk-backed case needs a fetch; pending pasted art is in memory.
  useEffect(() => {
    if (hasArt && !pendingArt) coverThumbs.request(path);
  }, [path, hasArt, pendingArt]);

  const src = pendingArt
    ? `data:${pendingArt.mime};base64,${pendingArt.base64}`
    : hasArt
      ? (cached ?? null)
      : null;

  return (
    // Decorative: the file is identified by its filename cell, so the preview
    // adds no information for assistive tech (kept out of the a11y tree).
    <span className="cell cell-thumb" role="gridcell" aria-hidden="true">
      {src ? (
        <img
          className="thumb-img"
          src={src}
          alt=""
          width={THUMB_PX}
          height={THUMB_PX}
          draggable={false}
        />
      ) : (
        <span className="thumb-empty" />
      )}
    </span>
  );
}

const CoverThumb = memo(CoverThumbImpl);

// ---------------------------------------------------------------------------
// GridRow — one memoized grid row.
//
// Virtualization limits the number of DOM nodes, but *not* re-renders: without
// memoization every visible row re-renders on any focus/selection/edit change.
// `React.memo` + the `rowsEqual` comparator below means an arrow-key move (which
// changes only `focusIndex`, and the selected set) re-renders just the rows
// whose `isSelected`/`isFocused` actually flipped — independent of total rows.
//
// Correctness rule: the comparator ignores the callback props, so those MUST be
// stable across renders (they are — the parent wraps them in `useCallback` with
// refs for any state they read). `editingKey`/`draft` are passed per-row (null/""
// for non-edited rows) so a keystroke in the inline editor only re-renders the
// row being edited.
// ---------------------------------------------------------------------------
interface GridRowProps {
  row: Row;
  index: number;
  top: number;
  isSelected: boolean;
  isFocused: boolean;
  renderCols: RenderCol[];
  colWidths: number[];
  /** Width of the gap placeholder while a header is being dragged (else 0). */
  gapWidth: number;
  /** The column being inline-edited in *this* row, or null. */
  editingKey: EditableField | null;
  /** Draft value, only meaningful when `editingKey` is set. */
  draft: string;
  editRef: React.RefObject<HTMLInputElement | null>;
  onRowMouseDown: (e: React.MouseEvent, index: number) => void;
  onRowContextMenu: (e: React.MouseEvent, index: number) => void;
  onCellMouseDown: (e: React.MouseEvent, index: number, row: Row, col: ColumnDef) => void;
  onDraftChange: (value: string) => void;
  onEditKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onEditBlur: () => void;
}

function GridRowImpl(props: GridRowProps) {
  const { row, index, isSelected, isFocused, renderCols, colWidths, gapWidth, editingKey } = props;
  return (
    // Rows are not individually focusable by design: this grid uses the ARIA
    // `aria-activedescendant` pattern (single tab-stop on the grid container,
    // keyboard handled in `handleKeyDown`). Mouse selection via onMouseDown is a
    // pointer-only enhancement.
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      id={`row-${index}`}
      role="row"
      aria-rowindex={index + 1}
      aria-selected={isSelected}
      className={
        "grid-row" +
        (isSelected ? " is-selected" : "") +
        (isFocused ? " is-focused" : "") +
        (row.error ? " is-error" : "")
      }
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: ROW_HEIGHT,
        transform: `translateY(${props.top}px)`,
      }}
      onMouseDown={(e) => props.onRowMouseDown(e, index)}
      onContextMenu={(e) => props.onRowContextMenu(e, index)}
    >
      <CoverThumb path={row.path} hasArt={row.has_art} pendingArt={row.art} />
      {renderCols.map((rc) => {
        if (rc === "gap") {
          return (
            <span
              key="__gap__"
              className="cell cell-gap"
              style={{ width: gapWidth }}
              aria-hidden="true"
            />
          );
        }
        const i = rc.c;
        const col = GRID_COLUMNS[i];
        const value = row[col.key] ?? "";
        const isNum = !!col.numeric;
        const isEditing = editingKey === col.key;
        return (
          // Cells aren't individually focusable by design (the grid uses the
          // aria-activedescendant pattern with one tab-stop on the container).
          // Click-to-edit is a pointer-only enhancement.
          // eslint-disable-next-line jsx-a11y/interactive-supports-focus
          <span
            key={col.key}
            role="gridcell"
            className={`cell ${isNum ? "cell-num" : ""}${isEditing ? " is-editing" : ""}`}
            style={{ width: colWidths[i] }}
            title={isEditing ? undefined : value || undefined}
            onMouseDown={(e) => props.onCellMouseDown(e, index, row, col)}
          >
            {/* The File column carries the row's status indicator inline
                (unsaved dot / error icon) so there's no separate gutter. */}
            {col.key === "filename" &&
              (row.error ? (
                <span className="row-status" title={row.error} aria-label="Error reading file" role="img">
                  <TriangleAlert size={13} aria-hidden="true" />
                </span>
              ) : row.modified ? (
                <span className="row-status" title="Unsaved changes" aria-label="Unsaved changes" role="img">
                  <Circle size={8} fill="currentColor" aria-hidden="true" />
                </span>
              ) : null)}
            {isEditing ? (
              <input
                ref={props.editRef}
                className="cell-edit"
                value={props.draft}
                aria-label={`Edit ${col.label}`}
                inputMode={isNum ? "numeric" : "text"}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  let v = e.target.value;
                  if (isNum) v = v.replace(/[^0-9]/g, "");
                  props.onDraftChange(v);
                }}
                onKeyDown={props.onEditKeyDown}
                onBlur={props.onEditBlur}
              />
            ) : (
              value
            )}
          </span>
        );
      })}
    </div>
  );
}

function rowsEqual(a: GridRowProps, b: GridRowProps): boolean {
  // Callback props are intentionally excluded — they are stable by contract
  // (see GridRow doc comment). Compare only what changes a row's appearance.
  return (
    a.row === b.row &&
    a.index === b.index &&
    a.top === b.top &&
    a.isSelected === b.isSelected &&
    a.isFocused === b.isFocused &&
    a.renderCols === b.renderCols &&
    a.colWidths === b.colWidths &&
    a.gapWidth === b.gapWidth &&
    a.editingKey === b.editingKey &&
    a.draft === b.draft &&
    a.editRef === b.editRef
  );
}

const GridRow = memo(GridRowImpl, rowsEqual);

export function FileGrid(props: FileGridProps) {
  const { rows, selected, focusIndex, sort } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  // The header is clipped (overflow hidden); mirror the body's horizontal scroll
  // onto it so the column headers stay aligned as the grid resizes/scrolls.
  const headerRef = useRef<HTMLDivElement>(null);
  // The inner header row (as wide as all columns); used to map a pointer x to a
  // column slot while reordering.
  const headerInnerRef = useRef<HTMLDivElement>(null);

  // Column widths (resizable); seeded from the column defaults. Indexed by the
  // column's canonical position in GRID_COLUMNS (NOT by display order).
  const [colWidths, setColWidths] = useState<number[]>(() => GRID_COLUMNS.map((c) => c.width));

  // Display order: an array of canonical column indices in the order they're
  // shown. Drag a header to reorder; both the header and the rows map over this.
  const [colOrder, setColOrder] = useState<number[]>(() => GRID_COLUMNS.map((_, i) => i));
  // Position (within colOrder) currently being dragged, and the slot (0..n,
  // insert-before index) the pointer is hovering as a drop target.
  // The display position (within colOrder) currently being dragged, and the
  // insert slot (0..remaining.length) among the *remaining* columns.
  const [dragPos, setDragPos] = useState<number | null>(null);
  const [dropPos, setDropPos] = useState<number | null>(null);
  // The live cursor x while dragging; the floating full-column ghost tracks it.
  // `grabOffset` keeps the ghost under the point where the header was grabbed.
  const [dragX, setDragX] = useState(0);
  const grabOffsetRef = useRef(0);
  // Set when a header drag actually moved, so the trailing click doesn't sort.
  const suppressSortRef = useRef(false);

  // Inline editing: which cell (row id + column) is open, plus its draft value.
  const [editing, setEditing] = useState<{ id: string; key: EditableField } | null>(null);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  // Refs mirroring state that the stabilized callbacks read, so those callbacks
  // can keep a constant identity (required for the GridRow memo to hold) while
  // still seeing the latest values.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Mirror of `rows` so the stabilized edit callbacks can look a row up by id
  // without taking `rows` as a dependency (its identity churns on every edit).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const input = editRef.current;
    if (!editing || !input) return;
    input.focus();
    // Select the whole value when an editor opens (whether by click or by the
    // keyboard Enter-advance) so it can be overwritten immediately. The user can
    // still click within the field to drop the caret at a specific spot.
    input.select();
  }, [editing]);

  const beginEdit = useCallback((row: Row, col: ColumnDef) => {
    if (col.editable === false || row.error) return;
    setDraft(row[col.key] ?? "");
    setEditing({ id: row.id, key: col.key as EditableField });
  }, []);

  const { onCellCommit } = props;
  const commitEdit = useCallback(() => {
    const ed = editingRef.current;
    if (!ed) return;
    onCellCommit(ed.id, ed.key, draftRef.current);
    setEditing(null);
  }, [onCellCommit]);

  // ----- column resizing -----
  function setWidth(index: number, w: number) {
    setColWidths((prev) => {
      const next = [...prev];
      next[index] = Math.max(MIN_COL, Math.round(w));
      return next;
    });
  }

  function startResize(e: React.PointerEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[index];
    function onMove(ev: PointerEvent) {
      setWidth(index, startW + (ev.clientX - startX));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Double-click the divider to auto-fit the column to its widest entry (header
  // label and every row's value), the way a spreadsheet does.
  function autoFitColumn(index: number) {
    const col = GRID_COLUMNS[index];
    measureCanvas ??= document.createElement("canvas");
    const ctx = measureCanvas.getContext("2d");
    if (!ctx) return;
    const cs = parentRef.current ? getComputedStyle(parentRef.current) : null;
    const family = cs?.fontFamily || 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const size = cs?.fontSize || "14px";

    // Header label is semibold (600); add room for the gap + sort chevron.
    ctx.font = `600 ${size} ${family}`;
    let max = ctx.measureText(col.label).width + 20;

    // Body cells render at normal weight; the File column also carries the inline
    // status icon (~13px glyph + 5px margin) before its text.
    ctx.font = `400 ${size} ${family}`;
    const iconPad = col.key === "filename" ? 18 : 0;
    for (const row of rows) {
      const v = row[col.key];
      if (!v) continue;
      const w = ctx.measureText(v).width + iconPad;
      if (w > max) max = w;
    }

    // Add the cell's horizontal padding (0 8px) plus a little breathing room.
    setWidth(index, Math.ceil(max + 16 + 6));
  }

  function resizeKey(e: React.KeyboardEvent, index: number) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setWidth(index, colWidths[index] - 16);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setWidth(index, colWidths[index] + 16);
    }
  }

  // ----- column reordering (drag a header) -----
  // Returns the insert slot (0..remaining.length) for the dragged column whose
  // centre is at `centreX`. Evaluated against the *displayed* layout (remaining
  // columns with a gap of the dragged column's width currently open at
  // `currentK`): the dragged column shifts past a neighbour once its centre
  // crosses that neighbour's near edge — i.e. the centre enters the neighbour.
  function slotAtX(centreX: number, dragged: number, currentK: number): number {
    const el = headerInnerRef.current;
    const remaining = colOrder.filter((_, p) => p !== dragged);
    if (!el) return remaining.length;
    const W = colWidths[colOrder[dragged]];
    const x = centreX - el.getBoundingClientRect().left;
    // Left offsets of the remaining columns in the closed-up layout.
    const lefts: number[] = [];
    let acc = 0;
    for (let j = 0; j < remaining.length; j++) {
      lefts.push(acc);
      acc += colWidths[remaining[j]];
    }
    // Displayed left offset of column j when the gap sits at slot g.
    const disp = (j: number, g: number) => lefts[j] + (j >= g ? W : 0);
    let k = currentK;
    // Move right once the centre enters the left edge of the column right of the
    // gap; move left once it enters the right edge of the column left of it.
    while (k < remaining.length && x > disp(k, k)) k++;
    while (k > 0 && x < disp(k - 1, k) + colWidths[remaining[k - 1]]) k--;
    return k;
  }

  // Pointer-based header drag. (Not HTML5 drag-and-drop: that's intercepted by
  // Tauri's native file-drop handler, which would show the "drop files" overlay.)
  function startColDrag(e: React.PointerEvent, pos: number) {
    if (e.button !== 0) return;
    const cell = (e.currentTarget as HTMLElement).closest(".cell-head") as HTMLElement | null;
    const rect = cell?.getBoundingClientRect();
    const startX = e.clientX;
    grabOffsetRef.current = rect ? startX - rect.left : 0;
    const halfWidth = colWidths[colOrder[pos]] / 2;
    // The drop slot is decided by the centre of the dragged column (cursor minus
    // the grab offset, plus half the column width), so a column only shifts once
    // the dragged column's middle has crossed its midpoint.
    const centreX = (clientX: number) => clientX - grabOffsetRef.current + halfWidth;
    let moved = false;
    // The currently-open gap slot; seeded at the column's own position so a tiny
    // wiggle keeps everything put. Threaded back into slotAtX for hysteresis.
    let k = pos;
    function onMove(ev: PointerEvent) {
      if (!moved && Math.abs(ev.clientX - startX) > 4) {
        moved = true;
        setDragPos(pos);
      }
      if (moved) {
        setDragX(ev.clientX);
        k = slotAtX(centreX(ev.clientX), pos, k);
        setDropPos(k);
      }
    }
    function onUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) {
        k = slotAtX(centreX(ev.clientX), pos, k);
        setColOrder((prev) => {
          const draggedCol = prev[pos];
          const remaining = prev.filter((_, p) => p !== pos);
          remaining.splice(k, 0, draggedCol);
          return remaining;
        });
        suppressSortRef.current = true; // swallow the click that follows
      }
      setDragPos(null);
      setDropPos(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Keyboard parity for reordering: Ctrl/Cmd+Shift+Arrow on a header swaps it
  // with its neighbour. (Drag-and-drop isn't keyboard-accessible on its own.)
  function reorderKey(e: React.KeyboardEvent, pos: number) {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (e.key === "ArrowLeft" && pos > 0) {
      e.preventDefault();
      setColOrder((prev) => {
        const next = [...prev];
        [next[pos - 1], next[pos]] = [next[pos], next[pos - 1]];
        return next;
      });
    } else if (e.key === "ArrowRight" && pos < colOrder.length - 1) {
      e.preventDefault();
      setColOrder((prev) => {
        const next = [...prev];
        [next[pos + 1], next[pos]] = [next[pos], next[pos + 1]];
        return next;
      });
    }
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  function move(to: number, extend: boolean) {
    const next = Math.max(0, Math.min(rows.length - 1, to));
    virtualizer.scrollToIndex(next, { align: "auto" });
    if (extend) props.onRange(next);
    else props.onSelectSingle(next, true);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(focusIndex + 1, e.shiftKey);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(focusIndex - 1, e.shiftKey);
        break;
      case "ArrowLeft":
      case "ArrowRight":
        // Don't let left/right arrows scroll the list horizontally.
        e.preventDefault();
        break;
      case "PageDown":
        e.preventDefault();
        move(focusIndex + 12, e.shiftKey);
        break;
      case "PageUp":
        e.preventDefault();
        move(focusIndex - 12, e.shiftKey);
        break;
      case "Home":
        e.preventDefault();
        move(0, e.shiftKey);
        break;
      case "End":
        e.preventDefault();
        move(rows.length - 1, e.shiftKey);
        break;
      case " ":
        e.preventDefault();
        props.onToggle(focusIndex);
        break;
      case "Enter":
        e.preventDefault();
        props.onActivate();
        break;
      case "a":
        if (mod) {
          e.preventDefault();
          props.onSelectAll();
        }
        break;
    }
  }

  // ----- stabilized per-row callbacks (constant identity for the GridRow memo) -----
  const { onRange, onToggle, onSelectSingle, onContextMenu } = props;
  const handleRowMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      if (e.button === 2) return; // right-click is handled via onContextMenu
      if (e.shiftKey) onRange(index);
      else if (e.metaKey || e.ctrlKey) onToggle(index);
      else onSelectSingle(index);
    },
    [onRange, onToggle, onSelectSingle],
  );

  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      onContextMenu(index, e.clientX, e.clientY);
    },
    [onContextMenu],
  );

  // Two-step inline editing: the first click on a row selects it; a subsequent
  // click on a cell of that already-active row starts editing it. Modifier /
  // shift clicks and non-editable cells fall through to row selection.
  const handleCellMouseDown = useCallback(
    (e: React.MouseEvent, index: number, row: Row, col: ColumnDef) => {
      if (e.button !== 0) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) return;
      if (col.editable === false || row.error) return;
      // A click on a cell of an already-selected row starts editing it. The
      // first click on an unselected row falls through to the row handler (which
      // selects it); the next click on a cell then edits.
      if (!selectedRef.current.has(row.id)) return;
      e.stopPropagation();
      // Prevent the default focus action: the cell span isn't focusable, so the
      // browser would move focus to the grid container after our handler runs —
      // which blurs the just-opened input and immediately commits/closes it.
      e.preventDefault();
      // An inline edit only ever touches this one row, so a lingering multi-row
      // selection (e.g. after Ctrl/Cmd+A) is misleading — collapse it to the row
      // being edited so the bulk highlight clears as editing begins.
      if (selectedRef.current.size > 1) onSelectSingle(index);
      beginEdit(row, col);
    },
    [beginEdit, onSelectSingle],
  );

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      const el = e.currentTarget;
      if (e.key === "Enter") {
        e.preventDefault();
        const ed = editingRef.current;
        commitEdit();
        // Spreadsheet-style: after committing, drop straight into editing the
        // same column on the next row (skipping unreadable/errored rows) so a
        // field can be filled top-to-bottom from the keyboard. Stops at the last
        // row. commitEdit() set `editing` to null; beginEdit re-sets it, and
        // React batches both so only the next cell's editor actually renders.
        if (ed) {
          const list = rowsRef.current;
          const curIdx = list.findIndex((r) => r.id === ed.id);
          const col = GRID_COLUMNS.find((c) => c.key === ed.key);
          if (curIdx >= 0 && col) {
            let ni = curIdx + 1;
            while (ni < list.length && list[ni].error) ni++;
            if (ni < list.length) {
              virtualizer.scrollToIndex(ni, { align: "auto" });
              onSelectSingle(ni);
              beginEdit(list[ni], col);
            }
          }
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
      } else if (
        // At the text boundary the caret can't move further, so the arrow's
        // default would scroll the grid — suppress that.
        (e.key === "ArrowLeft" && el.selectionStart === 0 && el.selectionEnd === 0) ||
        (e.key === "ArrowRight" &&
          el.selectionStart === el.value.length &&
          el.selectionEnd === el.value.length)
      ) {
        e.preventDefault();
      }
    },
    [commitEdit, beginEdit, onSelectSingle, virtualizer],
  );

  const focusedRow = rows[focusIndex];
  const virtualItems = virtualizer.getVirtualItems();
  const totalWidth = colWidths.reduce((sum, w) => sum + w, 0);

  const dragging = dragPos != null;
  const draggedCol = dragging ? colOrder[dragPos] : -1;

  // The columns to render, in order. While dragging, the dragged column is pulled
  // out (it's shown as the floating ghost) and an empty placeholder of its width
  // is inserted at the current drop slot — so the other columns shift live to
  // open a gap exactly where it will land. "gap" entries are that placeholder.
  //
  // Memoized so that focus/selection/edit changes (which don't touch the column
  // layout) keep a *stable* `renderCols` identity — a prerequisite for the
  // GridRow memo to skip unaffected rows.
  const renderCols = useMemo<RenderCol[]>(() => {
    if (dragPos == null) {
      return colOrder.map((c, p) => ({ c, p }));
    }
    const remaining = colOrder.map((c, p) => ({ c, p })).filter(({ p }) => p !== dragPos);
    const k = dropPos ?? remaining.length;
    const out: RenderCol[] = [];
    for (let idx = 0; idx <= remaining.length; idx++) {
      if (idx === k) out.push("gap");
      if (idx < remaining.length) out.push(remaining[idx]);
    }
    return out;
  }, [colOrder, dragPos, dropPos]);
  const gapWidth = dragging ? colWidths[draggedCol] : 0;

  // Geometry for the floating full-column ghost (header + visible data cells),
  // read live so it stays aligned even if the grid was scrolled.
  let ghost: { left: number; top: number; width: number; headH: number; bodyTop: number; bodyH: number; scrollTop: number } | null = null;
  if (dragging && parentRef.current && headerRef.current) {
    const gridRect = parentRef.current.getBoundingClientRect();
    const headRect = headerRef.current.getBoundingClientRect();
    ghost = {
      left: dragX - grabOffsetRef.current,
      top: headRect.top,
      width: colWidths[draggedCol],
      headH: headRect.height,
      bodyTop: gridRect.top - headRect.top,
      bodyH: gridRect.height,
      scrollTop: parentRef.current.scrollTop,
    };
  }

  return (
    <div className="grid-wrap">
      {/* Floating full-height copy of the dragged column (header + visible data
          cells) that follows the cursor. The real column is removed from the
          layout while dragging, so this is the only place it appears. */}
      {ghost && draggedCol >= 0 && (
        <div
          className={`col-drag-ghost${GRID_COLUMNS[draggedCol].numeric ? " cell-num" : ""}`}
          aria-hidden="true"
          style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.headH + ghost.bodyH }}
        >
          <div className="col-drag-ghost-head" style={{ height: ghost.headH }}>
            <span className="col-label">{GRID_COLUMNS[draggedCol].label}</span>
          </div>
          <div className="col-drag-ghost-body" style={{ top: ghost.headH, height: ghost.bodyH }}>
            {virtualItems.map((vi) => (
              <div
                key={rows[vi.index].id}
                className={`col-drag-ghost-cell${selected.has(rows[vi.index].id) ? " is-selected" : ""}`}
                style={{ top: vi.start - ghost!.scrollTop, height: ROW_HEIGHT }}
              >
                {rows[vi.index][GRID_COLUMNS[draggedCol].key] ?? ""}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Column header row. The outer viewport clips to the panel width and is
          scrolled programmatically to mirror the body's horizontal scroll, so the
          (wider-than-panel) header row stays aligned with the data columns. */}
      <div ref={headerRef} className="grid-header-vp">
        {/* Fixed leading header for the cover column. Outside .grid-header so it
            never participates in column reordering/resizing. Decorative, like
            the cells below it. */}
        <span className="cell cell-head cell-head-thumb" aria-hidden="true" />
        <div
          ref={headerInnerRef}
          className="grid-header"
          role="presentation"
          style={{ minWidth: totalWidth }}
        >
          {renderCols.map((rc) => {
          if (rc === "gap") {
            return (
              <span
                key="__gap__"
                className="cell cell-head cell-head-gap"
                style={{ width: gapWidth }}
                aria-hidden="true"
              />
            );
          }
          const { c: i, p: pos } = rc;
          const col = GRID_COLUMNS[i];
          const active = sort?.key === col.key;
          return (
            <span
              key={col.key}
              className={`cell cell-head ${col.numeric ? "cell-num" : ""}`}
              style={{ width: colWidths[i] }}
            >
              <button
                type="button"
                className="col-sort"
                onPointerDown={(e) => startColDrag(e, pos)}
                onClick={() => {
                  if (suppressSortRef.current) {
                    suppressSortRef.current = false;
                    return;
                  }
                  props.onSort(col.key);
                }}
                onKeyDown={(e) => reorderKey(e, pos)}
                aria-label={`Sort by ${col.label}${
                  active ? (sort!.dir === "asc" ? ", currently ascending" : ", currently descending") : ""
                }`}
              >
                <span className="col-label">{col.label}</span>
                {active &&
                  (sort!.dir === "asc" ? (
                    <ChevronUp size={12} aria-hidden="true" />
                  ) : (
                    <ChevronDown size={12} aria-hidden="true" />
                  ))}
              </button>
              {/* Focusable window-splitter (drag or arrow-keys); jsx-a11y
                  doesn't recognise the separator-splitter pattern. */}
              {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
              <span
                className="col-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${col.label} column`}
                aria-valuenow={colWidths[i]}
                aria-valuemin={MIN_COL}
                tabIndex={0}
                onPointerDown={(e) => startResize(e, i)}
                onDoubleClick={() => autoFitColumn(i)}
                onKeyDown={(e) => resizeKey(e, i)}
              />
              {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
            </span>
          );
          })}
        </div>
      </div>

      <div
        ref={parentRef}
        className="grid-scroll"
        role="grid"
        aria-label="Audio files"
        aria-multiselectable="true"
        aria-rowcount={rows.length}
        aria-activedescendant={focusedRow ? `row-${focusIndex}` : undefined}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onScroll={(e) => {
          if (headerRef.current) headerRef.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            minWidth: THUMB_COL_W + totalWidth,
          }}
        >
          {virtualItems.map((vi) => {
            const row = rows[vi.index];
            const isEditingThisRow = editing?.id === row.id;
            return (
              <GridRow
                key={row.id}
                row={row}
                index={vi.index}
                top={vi.start}
                isSelected={selected.has(row.id)}
                isFocused={vi.index === focusIndex}
                renderCols={renderCols}
                colWidths={colWidths}
                gapWidth={gapWidth}
                editingKey={isEditingThisRow ? editing!.key : null}
                draft={isEditingThisRow ? draft : ""}
                editRef={editRef}
                onRowMouseDown={handleRowMouseDown}
                onRowContextMenu={handleRowContextMenu}
                onCellMouseDown={handleCellMouseDown}
                onDraftChange={setDraft}
                onEditKeyDown={handleEditKeyDown}
                onEditBlur={commitEdit}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
