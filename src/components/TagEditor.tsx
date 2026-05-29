import { useEffect, useMemo, useState } from "react";
import { getCoverArt } from "../api";
import { computeMixedValues } from "../edits";
import { TAG_EDITOR_FIELDS, type FieldDef } from "../fields";
import { EDITABLE_FIELDS, type EditableField, type Row } from "../types";

interface TagEditorProps {
  selectedRows: Row[];
  onFieldChange: (field: EditableField, value: string) => void;
  firstFieldRef: React.RefObject<HTMLInputElement | null>;
  /** Current sidebar width in px (set by the draggable divider). */
  width: number;
}

/** Numeric "total" fields rendered inline beside their base (Track of …, Disc of …). */
const PAIRED_TOTAL: Partial<Record<EditableField, EditableField>> = {
  track: "track_total",
  disc: "disc_total",
};
const TOTAL_FIELDS = new Set<EditableField>(["track_total", "disc_total"]);

export function TagEditor({
  selectedRows,
  onFieldChange,
  firstFieldRef,
  width,
}: TagEditorProps) {
  const count = selectedRows.length;
  const [art, setArt] = useState<string | null>(null);
  const [artLoading, setArtLoading] = useState(false);

  // All fields' mixed/shared values in a single pass over the selection
  // (was 12 separate O(selection) scans per render). Memoized on `selectedRows`,
  // whose identity is now stable when the selection is unchanged.
  const mixedValues = useMemo(
    () => computeMixedValues(selectedRows, EDITABLE_FIELDS),
    [selectedRows],
  );

  // The single selected file's cover-relevant fields. Depending on these
  // primitives (rather than the `selectedRows` array, whose identity churns on
  // every unrelated edit) keeps the effect from re-running spuriously — which
  // previously left the preview stuck on "Loading…" when a fetch was cancelled.
  const single = count === 1 ? selectedRows[0] : null;
  const path = single?.path ?? null;
  const hasArt = single?.has_art ?? false;
  const pendingArt = single?.art ?? null;

  useEffect(() => {
    // No single selection, or a pending pasted cover that takes precedence over
    // what's on disk, or a file known to have no art — all resolve synchronously.
    if (!path) {
      setArt(null);
      setArtLoading(false);
      return;
    }
    if (pendingArt) {
      setArt(`data:${pendingArt.mime};base64,${pendingArt.base64}`);
      setArtLoading(false);
      return;
    }
    if (!hasArt) {
      setArt(null);
      setArtLoading(false);
      return;
    }
    let cancelled = false;
    setArtLoading(true);
    getCoverArt(path)
      .then((c) => {
        if (!cancelled) setArt(c ? `data:${c.mime};base64,${c.base64}` : null);
      })
      .catch(() => {
        if (!cancelled) setArt(null);
      })
      .finally(() => {
        if (!cancelled) setArtLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, hasArt, pendingArt]);

  /** Render a single labelled input for a field. */
  function renderInput(f: FieldDef, isFirst = false) {
    const shared = mixedValues[f.key];
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

  if (count === 0) {
    return (
      <aside className="tag-editor" aria-label="Tag editor" style={{ width, flexBasis: width }}>
        <p className="empty-hint">Select a file to edit its tags.</p>
      </aside>
    );
  }

  return (
    <aside className="tag-editor" aria-label="Tag editor" style={{ width, flexBasis: width }}>
      {count > 1 && <p className="multi-hint">Editing {count} files</p>}

      <div className="cover" aria-label="Cover art">
        {artLoading ? (
          <span className="cover-state">Loading…</span>
        ) : art ? (
          <img src={art} alt="Embedded cover art" draggable={false} />
        ) : (
          <span className="cover-state">{count === 1 ? "No art" : "—"}</span>
        )}
      </div>

      <form className="fields" onSubmit={(e) => e.preventDefault()}>
        {TAG_EDITOR_FIELDS.map((f, i) => {
          // Totals are rendered inline beside their base field; skip them here.
          if (TOTAL_FIELDS.has(f.key)) return null;

          // Labels are intentionally NOT associated with their inputs (no
          // htmlFor): a `for`-linked label focuses the input on click, which
          // surprised users clicking the label area above a box. The inputs
          // carry their own aria-label, so screen-reader naming is preserved.
          const totalKey = PAIRED_TOTAL[f.key];
          if (totalKey) {
            const totalDef = TAG_EDITOR_FIELDS.find((d) => d.key === totalKey)!;
            return (
              <div className="field field-pair" key={f.key}>
                <span className="field-label">{f.label}</span>
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

          return (
            <div className="field" key={f.key}>
              <span className="field-label">{f.label}</span>
              {renderInput(f, i === 0)}
            </div>
          );
        })}
      </form>
    </aside>
  );
}
