import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TriangleAlert, Circle, ChevronUp, ChevronDown } from "lucide-react";
import { GRID_COLUMNS, type ColumnDef, type ColumnKey } from "../fields";
import type { EditableField, Row } from "../types";

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

// Reused offscreen canvas for measuring text width when placing the edit caret.
let measureCanvas: HTMLCanvasElement | null = null;

/**
 * Given an open <input> and the viewport x of the click that opened it, return
 * the character index whose boundary is nearest that x — so the caret lands
 * where the user clicked rather than selecting the whole value.
 */
function caretIndexFromClientX(input: HTMLInputElement, clientX: number): number {
  const text = input.value;
  if (!text) return 0;
  const cs = getComputedStyle(input);
  const rect = input.getBoundingClientRect();
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  measureCanvas ??= document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return text.length;
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const fullW = ctx.measureText(text).width;
  const innerW = rect.width - padL - padR;
  // Right-aligned (numeric) inputs render their text flush to the right edge.
  const originX =
    cs.textAlign === "right" ? rect.right - padR - Math.min(fullW, innerW) : rect.left + padL;
  const x = clientX - originX;
  if (x <= 0) return 0;
  if (x >= fullW) return text.length;
  let prev = 0;
  for (let i = 1; i <= text.length; i++) {
    const w = ctx.measureText(text.slice(0, i)).width;
    if (w >= x) return x < (prev + w) / 2 ? i - 1 : i;
    prev = w;
  }
  return text.length;
}

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
  // Viewport x of the click that opened the editor, used to place the caret.
  const clickXRef = useRef<number | null>(null);

  useEffect(() => {
    const input = editRef.current;
    if (!editing || !input) return;
    input.focus();
    const clickX = clickXRef.current;
    clickXRef.current = null;
    // Place the caret where the user clicked (not select-all). If we have no
    // click position (e.g. keyboard-initiated), fall back to the end.
    const idx = clickX == null ? input.value.length : caretIndexFromClientX(input, clickX);
    input.setSelectionRange(idx, idx);
  }, [editing]);

  function beginEdit(row: Row, col: ColumnDef, clientX?: number) {
    if (col.editable === false || row.error) return;
    clickXRef.current = clientX ?? null;
    setDraft(row[col.key] ?? "");
    setEditing({ id: row.id, key: col.key as EditableField });
  }

  function commitEdit() {
    if (!editing) return;
    props.onCellCommit(editing.id, editing.key, draft);
    setEditing(null);
  }

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

  function handleRowClick(e: React.MouseEvent, index: number) {
    if (e.button === 2) return; // right-click is handled via onContextMenu
    if (e.shiftKey) props.onRange(index);
    else if (e.metaKey || e.ctrlKey) props.onToggle(index);
    else props.onSelectSingle(index);
  }

  // Two-step inline editing: the first click on a row selects it; a subsequent
  // click on a cell of that already-active row starts editing it. Modifier /
  // shift clicks and non-editable cells fall through to row selection.
  function handleCellMouseDown(e: React.MouseEvent, row: Row, col: ColumnDef) {
    if (e.button !== 0) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    if (col.editable === false || row.error) return;
    // A click on a cell of an already-selected row starts editing it. The first
    // click on an unselected row falls through to the row handler (which selects
    // it); the next click on a cell then edits.
    if (!selected.has(row.id)) return;
    e.stopPropagation();
    // Prevent the default focus action: the cell span isn't focusable, so the
    // browser would move focus to the grid container after our handler runs —
    // which blurs the just-opened input and immediately commits/closes it.
    e.preventDefault();
    beginEdit(row, col, e.clientX);
  }

  const focusedRow = rows[focusIndex];
  const virtualItems = virtualizer.getVirtualItems();
  const totalWidth = colWidths.reduce((sum, w) => sum + w, 0);

  const dragging = dragPos != null;
  const draggedCol = dragging ? colOrder[dragPos] : -1;

  // The columns to render, in order. While dragging, the dragged column is pulled
  // out (it's shown as the floating ghost) and an empty placeholder of its width
  // is inserted at the current drop slot — so the other columns shift live to
  // open a gap exactly where it will land. "gap" entries are that placeholder.
  type RenderCol = { c: number; p: number } | "gap";
  let renderCols: RenderCol[];
  if (dragging) {
    const remaining = colOrder
      .map((c, p) => ({ c, p }))
      .filter(({ p }) => p !== dragPos);
    const k = dropPos ?? remaining.length;
    renderCols = [];
    for (let idx = 0; idx <= remaining.length; idx++) {
      if (idx === k) renderCols.push("gap");
      if (idx < remaining.length) renderCols.push(remaining[idx]);
    }
  } else {
    renderCols = colOrder.map((c, p) => ({ c, p }));
  }

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
                className="col-drag-ghost-cell"
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
                style={{ width: colWidths[draggedCol] }}
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
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth: totalWidth }}>
          {virtualItems.map((vi) => {
            const row = rows[vi.index];
            const isSelected = selected.has(row.id);
            const isFocused = vi.index === focusIndex;
            return (
              // Rows are not individually focusable by design: this grid uses the
              // ARIA `aria-activedescendant` pattern (single tab-stop on the grid
              // container, keyboard handled in `handleKeyDown`). Mouse selection
              // via onMouseDown is a pointer-only enhancement.
              // eslint-disable-next-line jsx-a11y/interactive-supports-focus
              <div
                key={row.id}
                id={`row-${vi.index}`}
                role="row"
                aria-rowindex={vi.index + 1}
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
                  transform: `translateY(${vi.start}px)`,
                }}
                onMouseDown={(e) => handleRowClick(e, vi.index)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.onContextMenu(vi.index, e.clientX, e.clientY);
                }}
              >
                {renderCols.map((rc) => {
                  if (rc === "gap") {
                    return (
                      <span
                        key="__gap__"
                        className="cell cell-gap"
                        style={{ width: colWidths[draggedCol] }}
                        aria-hidden="true"
                      />
                    );
                  }
                  const i = rc.c;
                  const col = GRID_COLUMNS[i];
                  const value = row[col.key] ?? "";
                  const isNum = !!col.numeric;
                  const isEditing = editing?.id === row.id && editing.key === col.key;
                  return (
                    // Cells aren't individually focusable by design (the grid uses
                    // the aria-activedescendant pattern with one tab-stop on the
                    // container). Click-to-edit is a pointer-only enhancement.
                    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
                    <span
                      key={col.key}
                      role="gridcell"
                      className={`cell ${isNum ? "cell-num" : ""}${isEditing ? " is-editing" : ""}`}
                      style={{ width: colWidths[i] }}
                      title={isEditing ? undefined : value || undefined}
                      onMouseDown={(e) => handleCellMouseDown(e, row, col)}
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
                          ref={editRef}
                          className="cell-edit"
                          value={draft}
                          aria-label={`Edit ${col.label}`}
                          inputMode={isNum ? "numeric" : "text"}
                          onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            let v = e.target.value;
                            if (isNum) v = v.replace(/[^0-9]/g, "");
                            setDraft(v);
                          }}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            const el = e.currentTarget;
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitEdit();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            } else if (
                              // At the text boundary the caret can't move further, so the
                              // arrow's default would scroll the grid — suppress that.
                              (e.key === "ArrowLeft" && el.selectionStart === 0 && el.selectionEnd === 0) ||
                              (e.key === "ArrowRight" &&
                                el.selectionStart === el.value.length &&
                                el.selectionEnd === el.value.length)
                            ) {
                              e.preventDefault();
                            }
                          }}
                          onBlur={commitEdit}
                        />
                      ) : (
                        value
                      )}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
