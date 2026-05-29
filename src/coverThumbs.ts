import { getCoverThumbnails } from "./api";

/**
 * Session cache + batched loader for the grid's cover-art thumbnail column.
 *
 * Why this lives outside React state: the file grid is virtualized and its rows
 * are memoized, so we must NOT thread thumbnail data through row props (that
 * would re-render rows on every load and defeat the memo). Instead each
 * thumbnail cell subscribes to this store *by path* via `useSyncExternalStore`,
 * so a loaded thumbnail re-renders only its own cell.
 *
 * Optimisation shape:
 * - **Lazy**: a cell only `request()`s when it mounts (i.e. scrolls into view).
 * - **Batched**: requests made within the same tick are coalesced into a single
 *   `get_cover_thumbnails` IPC call (the backend decodes them in parallel).
 * - **Cached**: results are kept for the session keyed by path, so scrolling a
 *   row out and back never refetches. Covers don't change unless edited, and
 *   `invalidate()` is called at those edit points.
 */

// data URL when art is present; `null` once we know there's none (or it failed
// to decode). `undefined` (absent from the map) means "not loaded yet".
type Entry = string | null;

const cache = new Map<string, Entry>();
const inflight = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

let queued = new Set<string>();
let flushScheduled = false;

function notify(path: string): void {
  const set = listeners.get(path);
  if (set) for (const cb of set) cb();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // A microtask lets every cell that mounted in this commit enqueue first, so
  // a screenful of rows collapses into one IPC round-trip.
  queueMicrotask(flush);
}

async function flush(): Promise<void> {
  flushScheduled = false;
  const batch = [...queued].filter((p) => !cache.has(p) && !inflight.has(p));
  queued = new Set();
  if (batch.length === 0) return;
  for (const p of batch) inflight.add(p);
  try {
    const result = await getCoverThumbnails(batch);
    for (const p of batch) {
      const art = result[p];
      cache.set(p, art ? `data:${art.mime};base64,${art.base64}` : null);
    }
  } catch {
    // On failure, mark as "no thumbnail" so we don't hammer a broken path.
    for (const p of batch) cache.set(p, null);
  } finally {
    for (const p of batch) {
      inflight.delete(p);
      notify(p);
    }
  }
}

export const coverThumbs = {
  /** Current cache value: a data URL, `null` (no art), or `undefined` (pending). */
  get(path: string): Entry | undefined {
    return cache.get(path);
  },

  /** Queue a thumbnail fetch for `path` (no-op if cached or already in flight). */
  request(path: string): void {
    if (cache.has(path) || inflight.has(path)) return;
    queued.add(path);
    scheduleFlush();
  },

  /** Subscribe a cell to changes for its path; returns an unsubscribe fn. */
  subscribe(path: string, cb: () => void): () => void {
    let set = listeners.get(path);
    if (!set) {
      set = new Set();
      listeners.set(path, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) listeners.delete(path);
    };
  },

  /**
   * Drop a cached thumbnail so the next view refetches it. Call when a file's
   * embedded art changes on disk (e.g. after saving pasted cover art).
   */
  invalidate(path: string): void {
    if (cache.delete(path)) notify(path);
  },
};
