import { useEffect, useRef, useState } from "react";
import type { EditableField } from "../types";

export interface FindReplaceOptions {
  find: string;
  replace: string;
  /** A specific field, or "all" for every text field. */
  field: EditableField | "all";
  matchCase: boolean;
}

interface FindReplaceProps {
  /** How many files the operation will touch (selection, or all if none selected). */
  targetCount: number;
  /** Human-readable description of the scope, e.g. "3 selected files". */
  scopeLabel: string;
  onApply: (opts: FindReplaceOptions) => void;
  onClose: () => void;
}

const FIELD_OPTIONS: { value: EditableField | "all"; label: string }[] = [
  { value: "all", label: "All text fields" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "album", label: "Album" },
  { value: "album_artist", label: "Album Artist" },
  { value: "track", label: "Track" },
  { value: "track_total", label: "Track Total" },
  { value: "disc", label: "Disc" },
  { value: "disc_total", label: "Disc Total" },
  { value: "year", label: "Year" },
  { value: "genre", label: "Genre" },
  { value: "composer", label: "Composer" },
  { value: "comment", label: "Comment" },
];

export function FindReplace({ targetCount, scopeLabel, onApply, onClose }: FindReplaceProps) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [field, setField] = useState<EditableField | "all">("all");
  const [matchCase, setMatchCase] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);

  // Move focus to the Find input when the panel is revealed.
  useEffect(() => {
    findRef.current?.focus();
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!find) return;
    onApply({ find, replace, field, matchCase });
  }

  return (
    <form className="find-replace" aria-label="Find and replace" onSubmit={submit}>
      <div className="fr-row">
        <div className="fr-field">
          <label htmlFor="fr-find">Find</label>
          <input
            id="fr-find"
            type="text"
            value={find}
            ref={findRef}
            onChange={(e) => setFind(e.target.value)}
          />
        </div>
        <div className="fr-field">
          <label htmlFor="fr-replace">Replace with</label>
          <input
            id="fr-replace"
            type="text"
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
          />
        </div>
        <div className="fr-field">
          <label htmlFor="fr-scope-field">In</label>
          <select
            id="fr-scope-field"
            value={field}
            onChange={(e) => setField(e.target.value as EditableField | "all")}
          >
            {FIELD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <label className="fr-check">
          <input
            type="checkbox"
            checked={matchCase}
            onChange={(e) => setMatchCase(e.target.checked)}
          />
          Match case
        </label>
        <div className="fr-actions">
          <button type="submit" className="primary" disabled={!find || targetCount === 0}>
            Replace
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <p className="fr-scope" aria-live="polite">
        Replaces in {scopeLabel}.
      </p>
    </form>
  );
}
