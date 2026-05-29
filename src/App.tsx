import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Music } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./App.css";
import {
  cancelOperation,
  getCoverArt,
  loadSession,
  pickFiles,
  pickFolder,
  saveChanges,
  saveSession,
  saveTracks,
  scanPaths,
  scanPathsStreamed,
} from "./api";
import { AdditionalTags } from "./components/AdditionalTags";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { FileGrid, type SortState } from "./components/FileGrid";
import { FindReplace, type FindReplaceOptions } from "./components/FindReplace";
import { StatusBar } from "./components/StatusBar";
import { TagEditor } from "./components/TagEditor";
import { Toolbar } from "./components/Toolbar";
import type { ColumnKey } from "./fields";
import { EDITABLE_FIELDS, type CoverArt, type EditableField, type Row, type Track } from "./types";
import { compileFind, isModified, reconcileModified, replaceAllCount } from "./edits";

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

/**
 * Use the streaming scan (rows paint as they load) vs the blocking `scan_paths`.
 * A flag so we can fall back instantly if streaming ever misbehaves.
 */
const USE_STREAMING = true;

export default function App() {
  const [rows, setRows] = useState<Row[]>([]);
  // Ids of rows with unsaved edits, kept in sync with `rows` through the single
  // `commitRows` entry point below. Lets `modifiedCount` be O(1) (`.size`)
  // instead of an O(total) scan on every render.
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIndex, setFocusIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  // True while a streamed scan / save is in flight (each drives a Cancel
  // button). The ref holds the current cancellable operation's id so Cancel can
  // target it; only one such operation runs at a time (guarded by `busy`).
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const opIdRef = useRef<string | null>(null);
  const [message, setMessage] = useState("");
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [sort, setSort] = useState<SortState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Right-click menu position + target row; the file open in the additional-tags editor.
  const [menu, setMenu] = useState<{ x: number; y: number; rowId: string } | null>(null);
  const [additionalFor, setAdditionalFor] = useState<{ path: string; filename: string } | null>(
    null,
  );
  const [clipboardFilled, setClipboardFilled] = useState(false);

  // Snapshot of on-disk values, keyed by path, to detect & revert edits.
  const originals = useRef<Map<string, Track>>(new Map());
  // Mirror of `rows` for use inside async callbacks (avoids stale closures).
  const rowsRef = useRef<Row[]>(rows);
  rowsRef.current = rows;

  // The single place `rows` is replaced. Recomputes `dirtyIds` from the new
  // array in the same pass, so the dirty set can never drift from `row.modified`
  // (the per-row source of truth the grid renders). Every mutation routes
  // through this.
  const commitRows = useCallback((next: Row[]) => {
    setRows(next);
    setDirtyIds(new Set(next.filter((r) => r.modified).map((r) => r.id)));
  }, []);
  // Mirror of `focusIndex` so global shortcuts can read it without re-binding.
  const focusIndexRef = useRef(0);
  focusIndexRef.current = focusIndex;
  // Anchor for shift-range selection.
  const anchor = useRef(0);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  // Source paths (folders/files) the user has opened, for session restore.
  const sources = useRef<string[]>([]);
  // Snapshot of editable fields (and cover art) from a "Copy tags" action.
  const tagClipboard = useRef<{
    fields: Record<EditableField, string>;
    art: CoverArt | null;
  } | null>(null);

  // ----- undo / redo history -----
  // Each entry is a past `rows` snapshot (rows are never mutated in place, so
  // holding the array reference is a cheap, valid snapshot). History is cleared
  // on structural changes (load/remove) that invalidate the snapshots, but *not*
  // on save: a save only advances the on-disk baseline, so the snapshots stay
  // valid and undo can cross the save boundary. The catch is that a snapshot's
  // baked-in `modified` flags reflect the baseline at capture time — so on
  // restore we run `reconcileModified` to recompute them against the *current*
  // baseline (undoing a saved edit thus re-marks the row dirty for re-saving).
  const undoStack = useRef<Row[][]>([]);
  const redoStack = useRef<Row[][]>([]);
  // Signature of the in-progress edit "session" so rapid same-field typing
  // collapses into a single undo step (null = a discrete, always-recorded action).
  const lastEditSig = useRef<string | null>(null);

  const clearHistory = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    lastEditSig.current = null;
  }, []);

  // Record the current rows before a mutation. Consecutive edits sharing a
  // non-null signature coalesce so a typing burst is one undo step.
  const recordHistory = useCallback((sig: string | null) => {
    if (sig !== null && sig === lastEditSig.current) return;
    lastEditSig.current = sig;
    undoStack.current.push(rowsRef.current);
    if (undoStack.current.length > 200) undoStack.current.shift();
    redoStack.current = [];
  }, []);

  const undo = useCallback(() => {
    if (undoStack.current.length === 0) {
      setMessage("Nothing to undo");
      return;
    }
    const prev = undoStack.current.pop()!;
    redoStack.current.push(rowsRef.current);
    lastEditSig.current = null;
    commitRows(reconcileModified(prev, originals.current));
    setMessage("Undo");
  }, [commitRows]);

  const redo = useCallback(() => {
    if (redoStack.current.length === 0) {
      setMessage("Nothing to redo");
      return;
    }
    const next = redoStack.current.pop()!;
    undoStack.current.push(rowsRef.current);
    lastEditSig.current = null;
    commitRows(reconcileModified(next, originals.current));
    setMessage("Redo");
  }, [commitRows]);

  // Index rows by id, recomputed only when `rows` changes — so selection-only
  // changes (arrow-key navigation) don't trigger an O(total) scan.
  const rowsById = useMemo(() => {
    const m = new Map<string, Row>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  // O(selection): look the selected ids up in the index instead of filtering all
  // rows. Stable identity when neither selection nor rows changed.
  const selectedRows = useMemo(() => {
    const out: Row[] = [];
    for (const id of selected) {
      const r = rowsById.get(id);
      if (r) out.push(r);
    }
    return out;
  }, [selected, rowsById]);

  const modifiedCount = dirtyIds.size;

  // ----- loading -----
  // `remember` controls whether the input paths are added to the persisted
  // session (false when we're restoring that very session on startup).
  const loadPaths = useCallback(async (paths: string[], remember = true) => {
    if (paths.length === 0) return;
    setBusy(true);
    setMessage(remember ? "Scanning…" : "Restoring last session…");
    clearHistory(); // structural change — past snapshots no longer apply
    try {
      // Seed dedup + the running accumulator from what's already loaded. The
      // accumulator (not rowsRef, which only updates on render) is the source of
      // truth while batches stream in, so batches arriving faster than React can
      // re-render never drop rows. Selection is set only on the first batch when
      // the list started empty, so streaming never steals focus
      const known = new Set(rowsRef.current.map((r) => r.id));
      const wasEmpty = rowsRef.current.length === 0;
      let acc = rowsRef.current;
      let added = 0;
      let dupes = 0;
      let selectedFirst = !wasEmpty;

      let cancelled = false;

      const ingest = (tracks: Track[]) => {
        const additions: Row[] = [];
        for (const t of tracks) {
          if (known.has(t.path)) {
            dupes++;
            continue;
          }
          known.add(t.path);
          const r = toRow(t);
          originals.current.set(r.id, { ...r });
          additions.push(r);
        }
        if (additions.length === 0) return;
        added += additions.length;
        acc = [...acc, ...additions];
        commitRows(acc);
        if (!selectedFirst) {
          selectedFirst = true;
          setSelected(new Set([acc[0].id]));
          setFocusIndex(0);
          anchor.current = 0;
        }
      };

      if (USE_STREAMING) {
        const opId = crypto.randomUUID();
        opIdRef.current = opId;
        setScanning(true);
        try {
          await scanPathsStreamed(paths, opId, (ev) => {
            if (ev.event === "total") {
              setMessage(
                remember ? `Scanning… 0 of ${ev.data.count}` : `Restoring ${ev.data.count} files…`,
              );
            } else if (ev.event === "batch") {
              ingest(ev.data.tracks);
            } else if (ev.event === "progress") {
              setMessage(
                remember
                  ? `Scanning… ${ev.data.done} of ${ev.data.total}`
                  : `Restoring ${ev.data.done} of ${ev.data.total}…`,
              );
            } else if (ev.event === "cancelled") {
              cancelled = true;
            }
          });
        } finally {
          setScanning(false);
          opIdRef.current = null;
        }
      } else {
        ingest(await scanPaths(paths));
      }

      // Track the source paths for session restore (skip if cancelled — the
      // load was incomplete).
      if (!cancelled) {
        let sourcesChanged = false;
        for (const p of paths) {
          if (!sources.current.includes(p)) {
            sources.current.push(p);
            sourcesChanged = true;
          }
        }
        if (remember && sourcesChanged) void saveSession(sources.current);
      }

      if (cancelled) {
        setMessage(`Scan cancelled — loaded ${added} file${added === 1 ? "" : "s"}`);
      } else {
        setMessage(
          dupes === 0
            ? `Loaded ${added} file${added === 1 ? "" : "s"}`
            : `Added ${added} new file${added === 1 ? "" : "s"} (${dupes} already loaded)`,
        );
      }
    } catch (e) {
      setMessage(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [clearHistory, commitRows]);

  // Ask the in-flight scan or save to stop; the backend emits a terminal
  // `cancelled` event. Rows already streamed in stay loaded; files already
  // saved stay clean, the rest stay dirty.
  const cancelOp = useCallback(() => {
    const id = opIdRef.current;
    if (id) {
      setMessage("Cancelling…");
      void cancelOperation(id);
    }
  }, []);

  // ----- session restore (once, on startup) -----
  const didRestore = useRef(false);
  useEffect(() => {
    if (didRestore.current) return;
    didRestore.current = true;
    void loadSession()
      .then((paths) => {
        if (paths.length) void loadPaths(paths, false);
      })
      .catch(() => {
        /* no saved session — start empty */
      });
  }, [loadPaths]);

  // ----- drag & drop files/folders onto the window -----
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "over" || p.type === "enter") {
        setDragOver(true);
      } else if (p.type === "drop") {
        setDragOver(false);
        if (p.paths.length) void loadPaths(p.paths);
      } else {
        setDragOver(false);
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [loadPaths]);

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
      // Coalesce a typing burst into the same field/selection as one undo step.
      recordHistory(`field:${field}:${[...selected].sort().join(",")}`);
      commitRows(
        rowsRef.current.map((r) => {
          if (!selected.has(r.id)) return r;
          const updated = { ...r, [field]: value };
          const orig = originals.current.get(r.id);
          updated.modified = orig ? isModified(updated, orig) : true;
          return updated;
        }),
      );
    },
    [selected, recordHistory, commitRows],
  );

  // Edit a single row's field (used by inline double-click editing in the grid).
  const editCell = useCallback(
    (id: string, field: EditableField, value: string) => {
      // Committing an unchanged value (e.g. opening the inline editor and
      // clicking away, or the Enter-advance landing on a cell you don't touch)
      // must be a true no-op: recording an identical snapshot here would put a
      // no-op entry on top of the undo stack, so the next undo would "do
      // nothing" before a second undo reached the real edit.
      const cur = rowsRef.current.find((r) => r.id === id);
      if (!cur || (cur[field] ?? "") === value) return;
      recordHistory(null); // a committed inline edit is a discrete step
      commitRows(
        rowsRef.current.map((r) => {
          if (r.id !== id) return r;
          const updated = { ...r, [field]: value };
          const orig = originals.current.get(r.id);
          updated.modified = orig ? isModified(updated, orig) : true;
          return updated;
        }),
      );
    },
    [recordHistory, commitRows],
  );

  // ----- sorting -----
  // Clicking a column sorts ascending; clicking the same column again flips to
  // descending. Rows are reordered in place (load order isn't meaningful), so
  // index-based selection/focus stays correct; focus follows the same row.
  const sortBy = useCallback((key: ColumnKey) => {
    const dir: "asc" | "desc" =
      sort && sort.key === key && sort.dir === "asc" ? "desc" : "asc";
    const numeric = NUMERIC_FIELDS.has(key as EditableField);
    const focusedId = rowsRef.current[focusIndexRef.current]?.id;
    const sorted = [...rowsRef.current].sort((a, b) => {
      const av = (a[key] ?? "").toString();
      const bv = (b[key] ?? "").toString();
      // Files that have a value always sort above blanks, in both directions.
      const aEmpty = av.trim() === "";
      const bEmpty = bv.trim() === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      const cmp = numeric
        ? Number(av) - Number(bv)
        : av.localeCompare(bv, undefined, { sensitivity: "base", numeric: true });
      return dir === "asc" ? cmp : -cmp;
    });
    // Reorder only — dirty membership is unchanged, but route through commitRows
    // for the single-entry-point invariant.
    commitRows(sorted);
    setSort({ key, dir });
    if (focusedId) {
      const ni = sorted.findIndex((r) => r.id === focusedId);
      if (ni >= 0) {
        setFocusIndex(ni);
        anchor.current = ni;
      }
    }
  }, [sort, commitRows]);

  // ----- sidebar resize (drag the divider between the grid and the editor) -----
  const startSidebarResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      const clamp = (w: number) => Math.min(640, Math.max(200, w));
      const onMove = (ev: PointerEvent) => {
        // Dragging left (smaller clientX) widens the right-hand sidebar.
        setSidebarWidth(clamp(startW - (ev.clientX - startX)));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [sidebarWidth],
  );

  const resizeSidebarKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSidebarWidth((w) => Math.min(640, w + 16));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setSidebarWidth((w) => Math.max(200, w - 16));
    }
  }, []);

  // ----- right-click context menu actions -----
  const openMenu = useCallback(
    (index: number, x: number, y: number) => {
      const row = rowsRef.current[index];
      if (!row) return;
      // Right-clicking outside the current selection selects just that row.
      if (!selected.has(row.id)) {
        setSelected(new Set([row.id]));
        setFocusIndex(index);
        anchor.current = index;
      }
      setMenu({ x, y, rowId: row.id });
    },
    [selected],
  );

  const removeSelected = useCallback(() => {
    const ids = new Set(selected);
    if (ids.size === 0) return;
    const next = rowsRef.current.filter((r) => !ids.has(r.id));
    ids.forEach((id) => originals.current.delete(id));
    clearHistory(); // structural change — past snapshots no longer apply
    commitRows(next);
    setSelected(new Set());
    setFocusIndex((fi) => Math.max(0, Math.min(fi, next.length - 1)));
    setMessage(`Removed ${ids.size} file${ids.size === 1 ? "" : "s"} from the list`);
  }, [selected, clearHistory, commitRows]);

  const copyTags = useCallback(async (id: string) => {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row) return;
    const fields = {} as Record<EditableField, string>;
    for (const f of EDITABLE_FIELDS) fields[f] = row[f] ?? "";
    // Capture the cover art too so it travels with a paste.
    let art: CoverArt | null = null;
    if (row.has_art) {
      try {
        art = await getCoverArt(row.path);
      } catch {
        art = null;
      }
    }
    tagClipboard.current = { fields, art };
    setClipboardFilled(true);
    setMessage(`Copied tags${art ? " + cover" : ""} from ${row.filename}`);
  }, []);

  // Copy tags from the currently focused row (used by the Cmd/Ctrl+C shortcut).
  const copyFocused = useCallback(() => {
    const row = rowsRef.current[focusIndexRef.current];
    if (row) void copyTags(row.id);
  }, [copyTags]);

  const pasteTags = useCallback(() => {
    const clip = tagClipboard.current;
    if (!clip) return;
    recordHistory(null);
    commitRows(
      rowsRef.current.map((r) => {
        if (!selected.has(r.id)) return r;
        const updated = { ...r, ...clip.fields };
        // Paste the copied cover when there is one; otherwise leave art as-is.
        if (clip.art) {
          updated.art = clip.art;
          updated.has_art = true;
        }
        const orig = originals.current.get(r.id);
        updated.modified = orig ? isModified(updated, orig) : true;
        return updated;
      }),
    );
    setMessage(`Pasted tags into ${selected.size} file${selected.size === 1 ? "" : "s"}`);
  }, [selected, recordHistory, commitRows]);

  const clearTags = useCallback(() => {
    recordHistory(null);
    commitRows(
      rowsRef.current.map((r) => {
        if (!selected.has(r.id)) return r;
        const cleared = { ...r };
        for (const f of EDITABLE_FIELDS) cleared[f] = "";
        cleared.has_art = false; // clearing tags also drops embedded cover art
        const orig = originals.current.get(r.id);
        cleared.modified = orig ? isModified(cleared, orig) : true;
        return cleared;
      }),
    );
    setMessage(`Cleared tags on ${selected.size} file${selected.size === 1 ? "" : "s"}`);
  }, [selected, recordHistory, commitRows]);

  // After editing additional tags, re-scan that file so its row reflects disk.
  const refreshRow = useCallback(async (path: string) => {
    try {
      const [track] = await scanPaths([path]);
      if (!track) return;
      const fresh = toRow(track);
      originals.current.set(path, { ...fresh });
      commitRows(rowsRef.current.map((r) => (r.id === path ? fresh : r)));
    } catch {
      /* ignore — keep the existing row */
    }
  }, [commitRows]);

  // ----- batch find & replace -----
  // Operates on the current selection, or every loaded file when nothing is selected.
  const findReplace = useCallback(
    ({ find, replace, field, matchCase }: FindReplaceOptions) => {
      if (!find) return;
      const fields =
        field === "all" ? EDITABLE_FIELDS.filter((f) => !NUMERIC_FIELDS.has(f)) : [field];
      const targetIds =
        selected.size > 0 ? selected : new Set(rowsRef.current.map((r) => r.id));

      recordHistory(null);
      let changedFiles = 0;
      let totalHits = 0;
      // Compile the find pattern once, then reuse it across every row × field
      // (was recompiled per cell).
      const re = compileFind(find, matchCase);
      commitRows(
        rowsRef.current.map((r) => {
          if (!targetIds.has(r.id)) return r;
          let next = r;
          let touched = false;
          for (const f of fields) {
            const cur = r[f] ?? "";
            if (!cur) continue;
            const { result, hits } = replaceAllCount(cur, re, replace);
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
    [selected, recordHistory, commitRows],
  );

  // ----- save / revert -----
  const save = useCallback(async () => {
    const dirty = rowsRef.current.filter((r) => r.modified && !r.error);
    if (dirty.length === 0) return;
    setBusy(true);
    setMessage(`Saving ${dirty.length} file${dirty.length === 1 ? "" : "s"}…`);
    const payload = dirty.map((r) => ({ ...r }));
    // Only paths the backend confirmed `ok` are cleared; failed and (on cancel)
    // not-yet-attempted rows stay dirty.
    const okPaths = new Set<string>();
    let firstError: string | null = null;
    let failedCount = 0;
    let cancelled = false;
    try {
      if (USE_STREAMING) {
        const opId = crypto.randomUUID();
        opIdRef.current = opId;
        setSaving(true);
        try {
          await saveChanges(payload, opId, (ev) => {
            if (ev.event === "saved") {
              if (ev.data.ok) okPaths.add(ev.data.path);
              else {
                failedCount++;
                if (firstError === null) firstError = ev.data.error;
              }
            } else if (ev.event === "progress") {
              setMessage(`Saving ${ev.data.done} of ${ev.data.total}…`);
            } else if (ev.event === "cancelled") {
              cancelled = true;
            }
          });
        } finally {
          setSaving(false);
          opIdRef.current = null;
        }
      } else {
        const results = await saveTracks(payload);
        for (const x of results) {
          if (x.ok) okPaths.add(x.path);
          else {
            failedCount++;
            if (firstError === null) firstError = x.error;
          }
        }
      }

      // Keep the undo trail so edits can be undone after saving (restoring a
      // snapshot re-marks rows dirty against the new baseline — see `undo`). Only
      // break edit-coalescing so a fresh edit after the save records its own step.
      lastEditSig.current = null;
      commitRows(
        rowsRef.current.map((r) => {
          if (!okPaths.has(r.id)) return r;
          // Art is now embedded on disk; drop the pending payload.
          const saved = { ...r, art: null, modified: false };
          originals.current.set(r.id, { ...saved });
          return saved;
        }),
      );

      if (cancelled) {
        setMessage(`Save cancelled — saved ${okPaths.size} file${okPaths.size === 1 ? "" : "s"}`);
      } else if (failedCount === 0) {
        setMessage(`Saved ${okPaths.size} file${okPaths.size === 1 ? "" : "s"}`);
      } else {
        setMessage(`Saved ${okPaths.size}, ${failedCount} failed (${firstError ?? "unknown"})`);
      }
    } catch (e) {
      setMessage(`Save error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [commitRows]);

  const revert = useCallback(() => {
    recordHistory(null); // reverting is itself undoable
    commitRows(
      rowsRef.current.map((r) => {
        if (!r.modified) return r;
        const orig = originals.current.get(r.id);
        return orig ? { ...orig, id: r.id, modified: false } : r;
      }),
    );
    setMessage("Reverted unsaved changes");
  }, [recordHistory, commitRows]);

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
    // Focus the first tag field (the editor is always visible now).
    requestAnimationFrame(() => firstFieldRef.current?.focus());
  }, []);

  // Suppress the webview's native right-click menu (reload/inspect/back) app-wide.
  // The grid's own context menu still opens via its React onContextMenu handler.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Strip the browser-only gestures the webview inherits, so the window behaves
  // like a native app rather than a web page: no reload, print, in-engine
  // zoom/pinch, history back/forward, or HTML drag of elements/images. (OS-level
  // file drag-and-drop and the pointer-based column reorder are unaffected — they
  // don't use the HTML5 drag API.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      // Reload (Cmd/Ctrl+R, Ctrl+Shift+R, F5).
      if ((mod && k === "r") || e.key === "F5") return e.preventDefault();
      // Print.
      if (mod && k === "p") return e.preventDefault();
      // In-engine zoom (Cmd/Ctrl with +/=/-/_/0, including the numpad).
      if (mod && (k === "+" || k === "=" || k === "-" || k === "_" || k === "0")) {
        return e.preventDefault();
      }
      // History back/forward (Alt+Arrows; Cmd+[ / Cmd+] on macOS).
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        return e.preventDefault();
      }
      if (e.metaKey && (e.key === "[" || e.key === "]")) return e.preventDefault();
    };
    // Ctrl/Cmd+wheel and trackpad pinch both arrive as a ctrl-modified wheel.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    // Safari/WKWebView pinch-zoom gestures (not covered by the wheel handler).
    const onGesture = (e: Event) => e.preventDefault();
    // No native drag of images, text, or other elements.
    const onDragStart = (e: DragEvent) => e.preventDefault();

    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("gesturestart", onGesture);
    window.addEventListener("gesturechange", onGesture);
    window.addEventListener("gestureend", onGesture);
    window.addEventListener("dragstart", onDragStart);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("gesturestart", onGesture);
      window.removeEventListener("gesturechange", onGesture);
      window.removeEventListener("gestureend", onGesture);
      window.removeEventListener("dragstart", onDragStart);
    };
  }, []);

  // Global keyboard shortcuts. `additionalForRef` lets us bail when the
  // additional-tags modal owns the keyboard.
  const additionalForRef = useRef(additionalFor);
  additionalForRef.current = additionalFor;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();

      if (k === "s") {
        e.preventDefault();
        void save();
        return;
      }

      // Don't steal shortcuts while a text field or the modal has focus.
      const ae = document.activeElement as HTMLElement | null;
      const inField =
        !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
      if (inField || additionalForRef.current) return;

      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === "y") {
        e.preventDefault();
        redo();
      } else if (k === "c") {
        // Let a real text selection be copied normally.
        if ((window.getSelection()?.toString().length ?? 0) > 0) return;
        e.preventDefault();
        copyFocused();
      } else if (k === "v") {
        e.preventDefault();
        pasteTags();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, undo, redo, copyFocused, pasteTags]);

  const empty = rows.length === 0;
  const currentFile = rows[focusIndex]?.filename;

  // Build the right-click menu for the targeted row. Looks the target up via
  // `rowsRef` (not `rows`) so it doesn't recompute on every edit — the menu is
  // transient and rebuilt whenever it (re)opens.
  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu) return [];
    const targetRow = rowsRef.current.find((r) => r.id === menu.rowId);
    const selCount = selected.size;
    const plural = selCount === 1 ? "" : "s";
    return [
      {
        label: "Edit additional tags…",
        disabled: !targetRow || !!targetRow.error,
        onSelect: () => {
          if (targetRow) setAdditionalFor({ path: targetRow.path, filename: targetRow.filename });
        },
      },
      {
        label: "Copy tags",
        separatorBefore: true,
        disabled: !targetRow,
        onSelect: () => void copyTags(menu.rowId),
      },
      {
        label: `Paste tags${selCount > 1 ? ` (${selCount})` : ""}`,
        disabled: !clipboardFilled,
        onSelect: pasteTags,
      },
      {
        label: `Clear tags${selCount > 1 ? ` (${selCount})` : ""}`,
        onSelect: clearTags,
      },
      {
        label: `Remove ${selCount} file${plural} from list`,
        separatorBefore: true,
        danger: true,
        onSelect: removeSelected,
      },
    ];
  }, [menu, selected, clipboardFilled, copyTags, pasteTags, clearTags, removeSelected]);

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
        scanning={scanning}
        saving={saving}
        onCancel={cancelOp}
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

      <main className={`workspace${dragOver ? " drag-over" : ""}`}>
        {empty ? (
          <div className="welcome">
            <h1>
              <Music size={28} aria-hidden="true" /> AudioTag
            </h1>
            <p>Open a folder or files — or drag them here — to start editing tags.</p>
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
                sort={sort}
                onSelectSingle={selectSingle}
                onToggle={toggle}
                onRange={range}
                onSetFocus={setFocusIndex}
                onSelectAll={selectAll}
                onActivate={activate}
                onCellCommit={editCell}
                onSort={sortBy}
                onContextMenu={openMenu}
              />
            </section>
            {/* A focusable window-splitter: drag or use arrow keys to resize.
                jsx-a11y doesn't recognise the separator-splitter pattern. */}
            {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
            <div
              className="sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize tag editor"
              aria-valuenow={sidebarWidth}
              aria-valuemin={200}
              aria-valuemax={640}
              tabIndex={0}
              onPointerDown={startSidebarResize}
              onKeyDown={resizeSidebarKey}
            />
            {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
            <TagEditor
              selectedRows={selectedRows}
              onFieldChange={updateField}
              firstFieldRef={firstFieldRef}
              width={sidebarWidth}
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

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {additionalFor && (
        <AdditionalTags
          path={additionalFor.path}
          onClose={() => setAdditionalFor(null)}
          onSaved={(p) => void refreshRow(p)}
        />
      )}
    </div>
  );
}
