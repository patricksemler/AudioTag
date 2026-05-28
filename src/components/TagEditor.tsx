import { useEffect, useRef, useState } from "react";
import { getCoverArt } from "../api";
import { TAG_EDITOR_FIELDS } from "../fields";
import type { EditableField, Row } from "../types";

interface TagEditorProps {
  selectedRows: Row[];
  onFieldChange: (field: EditableField, value: string) => void;
  firstFieldRef: React.RefObject<HTMLInputElement | null>;
}

/** Returns the shared value across rows, or undefined if they differ ("mixed"). */
function commonValue(rows: Row[], field: EditableField): string | undefined {
  if (rows.length === 0) return "";
  const first = rows[0][field] ?? "";
  for (const r of rows) {
    if ((r[field] ?? "") !== first) return undefined;
  }
  return first;
}

export function TagEditor({ selectedRows, onFieldChange, firstFieldRef }: TagEditorProps) {
  const count = selectedRows.length;
  const [art, setArt] = useState<string | null>(null);
  const [artLoading, setArtLoading] = useState(false);
  const lastArtPath = useRef<string | null>(null);

  // Lazily load cover art when exactly one file is selected.
  useEffect(() => {
    if (count !== 1) {
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
  }, [count, selectedRows]);

  if (count === 0) {
    return (
      <aside className="tag-editor" aria-label="Tag editor">
        <p className="empty-hint">Select a file to edit its tags.</p>
      </aside>
    );
  }

  return (
    <aside className="tag-editor" aria-label="Tag editor">
      <h2 className="panel-title">
        {count === 1 ? selectedRows[0].filename : `${count} files selected`}
      </h2>

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
          return (
            <div className={"field" + (f.numeric ? " field-num" : "")} key={f.key}>
              <label htmlFor={fieldId}>{f.label}</label>
              {f.multiline ? (
                <textarea {...inputProps} rows={2} />
              ) : (
                <input
                  {...inputProps}
                  type="text"
                  inputMode={f.numeric ? "numeric" : "text"}
                  ref={i === 0 ? firstFieldRef : undefined}
                />
              )}
            </div>
          );
        })}
      </form>
    </aside>
  );
}
