import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Music } from "lucide-react";
import "./App.css";
import { pickFiles, pickFolder, saveTracks, scanPaths } from "./api";
import { FileGrid } from "./components/FileGrid";
import { FindReplace, type FindReplaceOptions } from "./components/FindReplace";
import { StatusBar } from "./components/StatusBar";
import { TagEditor } from "./components/TagEditor";
import { Toolbar } from "./components/Toolbar";
import { EDITABLE_FIELDS, type EditableField, type Row, type Track } from "./types";

/** Fields validated as numeric (UI-side). Excluded from "all text fields" replace. */
const NUMERIC_FIELDS = new Set<EditableField>([
  "track",
  "track_total",
  "disc",
  "disc_total",
  "year",
]);

function toRow(track: Track): Row {
  return { ...track, id: track.path, modified: false };
}

function isModified(row: Row, original: Track): boolean {
  return EDITABLE_FIELDS.some((f) => (row[f] ?? "") !== (original[f] ?? ""));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace every occurrence of `find` in `haystack`, returning the result and hit count. */
function replaceAllCount(
  haystack: string,
  find: string,
  replacement: string,
  matchCase: boolean,
): { result: string; hits: number } {
  const re = new RegExp(escapeRegExp(find), matchCase ? "g" : "gi");
  let hits = 0;
  const result = haystack.replace(re, () => {
    hits++;
    return replacement;
  });
  return { result, hits };
}

export default function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIndex, setFocusIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(true);

  // Snapshot of on-disk values, keyed by path, to detect & revert edits.
  const originals = useRef<Map<string, Track>>(new Map());
  // Mirror of `rows` for use inside async callbacks (avoids stale closures).
  const rowsRef = useRef<Row[]>(rows);
  rowsRef.current = rows;
  // Anchor for shift-range selection.
  const anchor = useRef(0);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const modifiedCount = useMemo(() => rows.filter((r) => r.modified).length, [rows]);

  // ----- loading -----
  const loadPaths = useCallback(async (paths: string[]) => {
    setBusy(true);
    setMessage("Scanning…");
    try {
      const tracks = await scanPaths(paths);
      const existing = new Set(rowsRef.current.map((r) => r.id));
      const additions = tracks.filter((t) => !existing.has(t.path)).map(toRow);
      additions.forEach((a) => originals.current.set(a.id, { ...a }));
      const wasEmpty = rowsRef.current.length === 0;
      const next = [...rowsRef.current, ...additions];
      setRows(next);
      if (wasEmpty && next.length > 0) {
        setSelected(new Set([next[0].id]));
        setFocusIndex(0);
        anchor.current = 0;
      }
      setMessage(
        additions.length === tracks.length
          ? `Loaded ${additions.length} files`
          : `Added ${additions.length} new files (${tracks.length - additions.length} already loaded)`,
      );
    } catch (e) {
      setMessage(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const openFolder = useCallback(async () => {
    const dir = await pickFolder();
    if (dir) await loadPaths([dir]);
  }, [loadPaths]);

  const openFiles = useCallback(async () => {
    const files = await pickFiles();
    if (files.length) await loadPaths(files);
  }, [loadPaths]);

  // ----- editing -----
  const updateField = useCallback(
    (field: EditableField, value: string) => {
      setRows((prev) =>
        prev.map((r) => {
          if (!selected.has(r.id)) return r;
          const updated = { ...r, [field]: value };
          const orig = originals.current.get(r.id);
          updated.modified = orig ? isModified(updated, orig) : true;
          return updated;
        }),
      );
    },
    [selected],
  );

  // ----- batch find & replace -----
  // Operates on the current selection, or every loaded file when nothing is selected.
  const findReplace = useCallback(
    ({ find, replace, field, matchCase }: FindReplaceOptions) => {
      if (!find) return;
      const fields =
        field === "all" ? EDITABLE_FIELDS.filter((f) => !NUMERIC_FIELDS.has(f)) : [field];
      const targetIds =
        selected.size > 0 ? selected : new Set(rowsRef.current.map((r) => r.id));

      let changedFiles = 0;
      let totalHits = 0;
      setRows((prev) =>
        prev.map((r) => {
          if (!targetIds.has(r.id)) return r;
          let next = r;
          let touched = false;
          for (const f of fields) {
            const cur = r[f] ?? "";
            if (!cur) continue;
            const { result, hits } = replaceAllCount(cur, find, replace, matchCase);
            if (hits > 0) {
              if (!touched) {
                next = { ...r };
                touched = true;
              }
              next[f] = result;
              totalHits += hits;
            }
          }
          if (touched) {
            const orig = originals.current.get(r.id);
            next.modified = orig ? isModified(next, orig) : true;
            changedFiles++;
          }
          return next;
        }),
      );
      setMessage(
        totalHits > 0
          ? `Replaced ${totalHits} occurrence${totalHits === 1 ? "" : "s"} in ${changedFiles} file${changedFiles === 1 ? "" : "s"}`
          : `No matches for “${find}”`,
      );
    },
    [selected],
  );

  // ----- save / revert -----
  const save = useCallback(async () => {
    const dirty = rowsRef.current.filter((r) => r.modified && !r.error);
    if (dirty.length === 0) return;
    setBusy(true);
    setMessage(`Saving ${dirty.length} files…`);
    try {
      const results = await saveTracks(dirty.map((r) => ({ ...r })));
      const okPaths = new Set(results.filter((x) => x.ok).map((x) => x.path));
      const failed = results.filter((x) => !x.ok);
      setRows((prev) =>
        prev.map((r) => {
          if (!okPaths.has(r.id)) return r;
          originals.current.set(r.id, { ...r });
          return { ...r, modified: false };
        }),
      );
      setMessage(
        failed.length === 0
          ? `Saved ${okPaths.size} files`
          : `Saved ${okPaths.size}, ${failed.length} failed (${failed[0].error ?? "unknown"})`,
      );
    } catch (e) {
      setMessage(`Save error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const revert = useCallback(() => {
    setRows((prev) =>
      prev.map((r) => {
        if (!r.modified) return r;
        const orig = originals.current.get(r.id);
        return orig ? { ...orig, id: r.id, modified: false } : r;
      }),
    );
    setMessage("Reverted unsaved changes");
  }, []);

  // ----- selection -----
  const selectSingle = useCallback((index: number) => {
    const row = rowsRef.current[index];
    if (!row) return;
    setSelected(new Set([row.id]));
    setFocusIndex(index);
    anchor.current = index;
  }, []);

  const toggle = useCallback((index: number) => {
    const row = rowsRef.current[index];
    if (!row) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
    setFocusIndex(index);
    anchor.current = index;
  }, []);

  const range = useCallback((index: number) => {
    const lo = Math.min(anchor.current, index);
    const hi = Math.max(anchor.current, index);
    const ids = rowsRef.current.slice(lo, hi + 1).map((r) => r.id);
    setSelected(new Set(ids));
    setFocusIndex(index);
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(rowsRef.current.map((r) => r.id)));
  }, []);

  const activate = useCallback(() => {
    setEditorOpen(true);
    // Focus after the panel has had a chance to render.
    requestAnimationFrame(() => firstFieldRef.current?.focus());
  }, []);

  // Cmd/Ctrl+S to save anywhere in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const empty = rows.length === 0;
  const currentFile = rows[focusIndex]?.filename;

  // Find & replace targets the selection, or all files when nothing is selected.
  const frTargetCount = selected.size > 0 ? selected.size : rows.length;
  const frScopeLabel =
    selected.size > 0
      ? `${selected.size} selected file${selected.size === 1 ? "" : "s"}`
      : `all ${rows.length} file${rows.length === 1 ? "" : "s"}`;

  return (
    <div className="app">
      <Toolbar
        onOpenFolder={openFolder}
        onOpenFiles={openFiles}
        onSave={save}
        onRevert={revert}
        onToggleFindReplace={() => setFindReplaceOpen((v) => !v)}
        findReplaceActive={findReplaceOpen}
        hasFiles={!empty}
        modifiedCount={modifiedCount}
        busy={busy}
        currentFile={empty ? undefined : currentFile}
      />

      {!empty && findReplaceOpen && (
        <FindReplace
          targetCount={frTargetCount}
          scopeLabel={frScopeLabel}
          onApply={findReplace}
          onClose={() => setFindReplaceOpen(false)}
        />
      )}

      <main className="workspace">
        {empty ? (
          <div className="welcome">
            <h1>
              <Music size={28} aria-hidden="true" /> AudioTag
            </h1>
            <p>Open a folder or files to start editing tags.</p>
            <div className="welcome-actions">
              <button type="button" className="primary" onClick={openFolder} disabled={busy}>
                Open Folder
              </button>
              <button type="button" onClick={openFiles} disabled={busy}>
                Open Files
              </button>
            </div>
          </div>
        ) : (
          <>
            <section className="files-panel" aria-label="Files">
              <FileGrid
                rows={rows}
                selected={selected}
                focusIndex={focusIndex}
                onSelectSingle={selectSingle}
                onToggle={toggle}
                onRange={range}
                onSetFocus={setFocusIndex}
                onSelectAll={selectAll}
                onActivate={activate}
              />
            </section>
            <TagEditor
              selectedRows={selectedRows}
              onFieldChange={updateField}
              firstFieldRef={firstFieldRef}
              open={editorOpen}
              onToggle={() => setEditorOpen((v) => !v)}
            />
          </>
        )}
      </main>

      <StatusBar
        total={rows.length}
        selected={selected.size}
        modified={modifiedCount}
        message={message}
      />
    </div>
  );
}
