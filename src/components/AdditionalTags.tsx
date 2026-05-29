import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { readAllTags, saveAllTags } from "../api";
import type { TagItemDto } from "../types";

interface AdditionalTagsProps {
  path: string;
  onClose: () => void;
  /** Called after a successful save so the grid can refresh this file's row. */
  onSaved: (path: string) => void;
}

/** A few common keys offered as autocomplete suggestions when adding a tag. */
const KEY_SUGGESTIONS = [
  "ALBUMARTIST",
  "COMPOSER",
  "CONDUCTOR",
  "PUBLISHER",
  "LABEL",
  "ISRC",
  "BARCODE",
  "BPM",
  "MOOD",
  "INITIALKEY",
  "LYRICS",
  "COPYRIGHT",
  "ENCODEDBY",
  "MUSICBRAINZ_TRACKID",
  "MUSICBRAINZ_ALBUMID",
  "REPLAYGAIN_TRACK_GAIN",
];

export function AdditionalTags({ path, onClose, onSaved }: AdditionalTagsProps) {
  const [items, setItems] = useState<TagItemDto[]>([]);
  const [tagType, setTagType] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    readAllTags(path)
      .then((all) => {
        if (cancelled) return;
        setItems(all.items);
        setTagType(all.tag_type);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Close on Escape or a click outside the dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    function onDown(e: MouseEvent) {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  function updateItem(index: number, patch: Partial<TagItemDto>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  function addItem() {
    setItems((prev) => [...prev, { key: "", value: "" }]);
  }

  // Render nothing until the tags are loaded, so the dialog appears already
  // populated instead of flashing an empty/loading shell first. (On error the
  // `finally` clears `loading`, so the dialog still opens to show the message.)
  if (loading) return null;

  async function save() {
    setSaving(true);
    setError(null);
    setSkipped([]);
    try {
      const payload = items
        .map((it) => ({ key: it.key.trim(), value: it.value }))
        .filter((it) => it.key !== "");
      const result = await saveAllTags(path, payload);
      onSaved(path);
      if (result.skipped.length) {
        setSkipped(result.skipped);
      } else {
        onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="additional-tags-title"
      >
        <div className="modal-head">
          <h2 id="additional-tags-title" className="modal-title">
            Additional tags
            {tagType ? <span className="modal-subtitle"> ({tagType})</span> : null}
          </h2>
          <button type="button" className="panel-toggle" onClick={onClose} aria-label="Close">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <datalist id="tag-key-suggestions">
          {KEY_SUGGESTIONS.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>

        <div className="tag-rows" role="group" aria-label="Tag items">
          {items.length === 0 && <p className="empty-hint">No tags yet. Add one below.</p>}
          {items.map((it, i) => (
            <div className="tag-row" key={i}>
              <input
                className="tag-key"
                value={it.key}
                list="tag-key-suggestions"
                placeholder="KEY"
                aria-label={`Tag ${i + 1} key`}
                onChange={(e) => updateItem(i, { key: e.target.value.toUpperCase() })}
              />
              <input
                className="tag-value"
                value={it.value}
                placeholder="Value"
                aria-label={`Tag ${i + 1} value`}
                onChange={(e) => updateItem(i, { value: e.target.value })}
              />
              <button
                type="button"
                className="panel-toggle"
                onClick={() => removeItem(i)}
                aria-label={`Remove tag ${it.key || i + 1}`}
                title="Remove tag"
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>

        <button type="button" className="add-tag" onClick={addItem}>
          <Plus size={16} aria-hidden="true" /> Add tag
        </button>

        {skipped.length > 0 && (
          <p className="modal-warn" role="status">
            Saved. These keys aren&rsquo;t supported by {tagType} and were skipped:{" "}
            {skipped.join(", ")}.
          </p>
        )}
        {error && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            {skipped.length ? "Close" : "Cancel"}
          </button>
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save tags"}
          </button>
        </div>
      </div>
    </div>
  );
}
