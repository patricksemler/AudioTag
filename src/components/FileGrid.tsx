import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TriangleAlert, Circle } from "lucide-react";
import { GRID_COLUMNS, type ColumnDef } from "../fields";
import type { EditableField, Row } from "../types";

interface FileGridProps {
  rows: Row[];
  selected: Set<string>;
  focusIndex: number;
  onSelectSingle: (index: number, viaKeyboard?: boolean) => void;
  onToggle: (index: number) => void;
  onRange: (index: number) => void;
  onSetFocus: (index: number) => void;
  onSelectAll: () => void;
  onActivate: () => void;
  /** Commit an inline (double-click) edit of a single cell. */
  onCellCommit: (id: string, field: EditableField, value: string) => void;
}

const ROW_HEIGHT = 30;
const NUMERIC_COLS = new Set<EditableField>(["track", "year"]);

export function FileGrid(props: FileGridProps) {
  const { rows, selected, focusIndex } = props;
  const parentRef = useRef<HTMLDivElement>(null);

  // Inline editing: which cell (row id + column) is open, plus its draft value.
  const [editing, setEditing] = useState<{ id: string; key: EditableField } | null>(null);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editing]);

  function beginEdit(row: Row, col: ColumnDef) {
    setDraft(row[col.key] ?? "");
    setEditing({ id: row.id, key: col.key });
  }

  function commitEdit() {
    if (!editing) return;
    props.onCellCommit(editing.id, editing.key, draft);
    setEditing(null);
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
    if (e.shiftKey) props.onRange(index);
    else if (e.metaKey || e.ctrlKey) props.onToggle(index);
    else props.onSelectSingle(index);
  }

  const focusedRow = rows[focusIndex];
  const totalWidth = GRID_COLUMNS.reduce((sum, c) => sum + c.width, 0) + 28;

  return (
    <div className="grid-wrap">
      {/* Column header row */}
      <div className="grid-header" role="presentation" style={{ minWidth: totalWidth }}>
        <span className="cell cell-status" aria-hidden="true" />
        {GRID_COLUMNS.map((col) => (
          <span
            key={col.key}
            className={`cell ${col.key === "track" || col.key === "year" ? "cell-num" : ""}`}
            style={{ width: col.width }}
          >
            {col.label}
          </span>
        ))}
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
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth: totalWidth }}>
          {virtualizer.getVirtualItems().map((vi) => {
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
              >
                <span className="cell cell-status" role="gridcell">
                  {row.error ? (
                    <span title={row.error} aria-label="Error reading file" role="img">
                      <TriangleAlert size={14} aria-hidden="true" />
                    </span>
                  ) : row.modified ? (
                    <span title="Unsaved changes" aria-label="Unsaved changes" role="img">
                      <Circle size={9} fill="currentColor" aria-hidden="true" />
                    </span>
                  ) : (
                    ""
                  )}
                </span>
                {GRID_COLUMNS.map((col) => {
                  const value = row[col.key] ?? "";
                  const isNum = NUMERIC_COLS.has(col.key);
                  const isEditing = editing?.id === row.id && editing.key === col.key;
                  return (
                    // Cells aren't individually focusable by design (the grid uses
                    // the aria-activedescendant pattern with one tab-stop on the
                    // container). Double-click to edit is a pointer-only enhancement.
                    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
                    <span
                      key={col.key}
                      role="gridcell"
                      className={`cell ${isNum ? "cell-num" : ""}${isEditing ? " is-editing" : ""}`}
                      style={{ width: col.width }}
                      title={isEditing ? undefined : value || undefined}
                      onDoubleClick={() => !row.error && beginEdit(row, col)}
                    >
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
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitEdit();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            }
                          }}
                          onBlur={commitEdit}
                        />
                      ) : (
                        value || (col.key === "title" ? row.filename : "")
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
