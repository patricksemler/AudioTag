import { useEffect, useRef, useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { getCoverArt } from "../api";
import { TAG_EDITOR_FIELDS, type FieldDef } from "../fields";
import type { EditableField, Row } from "../types";

interface TagEditorProps {
  selectedRows: Row[];
  onFieldChange: (field: EditableField, value: string) => void;
  firstFieldRef: React.RefObject<HTMLInputElement | null>;
  open: boolean;
  onToggle: () => void;
}

/** Numeric "total" fields rendered inline beside their base (Track of …, Disc of …). */
const PAIRED_TOTAL: Partial<Record<EditableField, EditableField>> = {
  track: "track_total",
  disc: "disc_total",
};
const TOTAL_FIELDS = new Set<EditableField>(["track_total", "disc_total"]);

/** Returns the shared value across rows, or undefined if they differ ("mixed"). */
function commonValue(rows: Row[], field: EditableField): string | undefined {
  if (rows.length === 0) return "";
  const first = rows[0][field] ?? "";
  for (const r of rows) {
    if ((r[field] ?? "") !== first) return undefined;
  }
  return first;
}

export function TagEditor({
  selectedRows,
  onFieldChange,
  firstFieldRef,
  open,
  onToggle,
}: TagEditorProps) {
  const count = selectedRows.length;
  const [art, setArt] = useState<string | null>(null);
  const [artLoading, setArtLoading] = useState(false);
  const lastArtPath = useRef<string | null>(null);

  // Lazily load cover art when exactly one file is selected and the panel is open.
  useEffect(() => {
    if (!open || count !== 1) {
      setArt(null);
      lastArtPath.current = null;
      return;
    }
    const row = selectedRows[0];
    if (row.path === lastArtPath.current) return;
    lastArtPath.current = row.path;
    if (!row.has_art) {
      setArt(null);
      return;
    }
    let cancelled = false;
    setArtLoading(true);
    getCoverArt(row.path)
      .then((c) => {
        if (!cancelled) setArt(c ? `data:${c.mime};base64,${c.base64}` : null);
      })
      .finally(() => {
        if (!cancelled) setArtLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, count, selectedRows]);

  // Collapsed: a slim rail with just an expand button.
  if (!open) {
    return (
      <aside className="tag-editor is-collapsed" aria-label="Tag editor (collapsed)">
        <button
          type="button"
          className="panel-toggle"
          onClick={onToggle}
          aria-label="Show tag editor"
          aria-expanded={false}
          title="Show tag editor"
        >
          <PanelRightOpen size={18} aria-hidden="true" />
        </button>
      </aside>
    );
  }

  /** Render a single labelled input for a field. */
  function renderInput(f: FieldDef, isFirst = false) {
    const shared = commonValue(selectedRows, f.key);
    const mixed = shared === undefined;
    const fieldId = `field-${f.key}`;
    const inputProps = {
      id: fieldId,
      value: mixed ? "" : shared,
      placeholder: mixed ? "Multiple values" : "",
      "aria-label": f.label,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        let v = e.target.value;
        if (f.numeric) v = v.replace(/[^0-9]/g, "");
        onFieldChange(f.key, v);
      },
    };
    if (f.multiline) return <textarea {...inputProps} rows={2} />;
    return (
      <input
        {...inputProps}
        type="text"
        inputMode={f.numeric ? "numeric" : "text"}
        ref={isFirst ? firstFieldRef : undefined}
      />
    );
  }

  const toggleButton = (
    <button
      type="button"
      className="panel-toggle"
      onClick={onToggle}
      aria-label="Hide tag editor"
      aria-expanded={true}
      title="Hide tag editor"
    >
      <PanelRightClose size={18} aria-hidden="true" />
    </button>
  );

  if (count === 0) {
    return (
      <aside className="tag-editor" aria-label="Tag editor">
        <div className="panel-head">
          <h2 className="panel-title">Tag editor</h2>
          {toggleButton}
        </div>
        <p className="empty-hint">Select a file to edit its tags.</p>
      </aside>
    );
  }

  return (
    <aside className="tag-editor" aria-label="Tag editor">
      <div className="panel-head">
        <h2 className="panel-title">
          {count === 1 ? selectedRows[0].filename : `${count} files selected`}
        </h2>
        {toggleButton}
      </div>

      <div className="cover" aria-label="Cover art">
        {artLoading ? (
          <span className="cover-state">Loading…</span>
        ) : art ? (
          <img src={art} alt="Embedded cover art" />
        ) : (
          <span className="cover-state">{count === 1 ? "No art" : "—"}</span>
        )}
      </div>

      <form className="fields" onSubmit={(e) => e.preventDefault()}>
        {TAG_EDITOR_FIELDS.map((f, i) => {
          // Totals are rendered inline beside their base field; skip them here.
          if (TOTAL_FIELDS.has(f.key)) return null;

          const totalKey = PAIRED_TOTAL[f.key];
          if (totalKey) {
            const totalDef = TAG_EDITOR_FIELDS.find((d) => d.key === totalKey)!;
            return (
              <div className="field field-pair" key={f.key}>
                <label htmlFor={`field-${f.key}`}>{f.label}</label>
                <div className="pair-inputs">
                  {renderInput(f)}
                  <span className="pair-sep" aria-hidden="true">
                    of
                  </span>
                  {renderInput(totalDef)}
                </div>
              </div>
            );
          }

          const fieldId = `field-${f.key}`;
          return (
            <div className="field" key={f.key}>
              <label htmlFor={fieldId}>{f.label}</label>
              {renderInput(f, i === 0)}
            </div>
          );
        })}
      </form>
    </aside>
  );
}
