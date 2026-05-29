import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AllTags, CoverArt, SaveAllResult, SaveResult, TagItemDto, Track } from "./types";

/** Open a native folder picker; returns the chosen directory or null. */
export async function pickFolder(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title: "Open folder" });
  return typeof result === "string" ? result : null;
}

/** Open a native file picker for audio files; returns chosen paths. */
export async function pickFiles(): Promise<string[]> {
  const result = await open({
    directory: false,
    multiple: true,
    title: "Open audio files",
    filters: [
      {
        name: "Audio",
        extensions: [
          "mp3", "flac", "m4a", "m4b", "mp4", "aac", "ogg", "oga", "opus",
          "wav", "wave", "aiff", "aif", "aifc", "ape", "wv", "mpc", "spx",
        ],
      },
    ],
  });
  if (Array.isArray(result)) return result;
  if (typeof result === "string") return [result];
  return [];
}

/** Scan files/folders and return tag models for all audio files found. */
export function scanPaths(paths: string[]): Promise<Track[]> {
  return invoke<Track[]>("scan_paths", { paths });
}

/** A streamed-scan event (mirrors the Rust `ScanEvent` enum). */
export type ScanEvent =
  | { event: "total"; data: { count: number } }
  | { event: "batch"; data: { tracks: Track[] } }
  | { event: "progress"; data: { done: number; total: number } }
  | { event: "cancelled" }
  | { event: "done" };

/**
 * Streaming scan: tags are read in batches and delivered via `onEvent` as they
 * arrive, so the UI can paint rows before the whole scan finishes. The returned
 * promise resolves when the scan is complete (after the final `done` /
 * `cancelled` event). Concatenating every batch's tracks reproduces
 * `scanPaths(paths)` exactly. Pass `operationId` to a later `cancelOperation`.
 */
export function scanPathsStreamed(
  paths: string[],
  operationId: string,
  onEvent: (event: ScanEvent) => void,
): Promise<void> {
  const channel = new Channel<ScanEvent>();
  channel.onmessage = onEvent;
  return invoke("scan_paths_streamed", { paths, channel, operationId });
}

/** Ask a running cancellable operation (e.g. a scan) to stop. */
export function cancelOperation(operationId: string): Promise<void> {
  return invoke("cancel_operation", { operationId });
}

/** Write edits for the given tracks back to disk. */
export function saveTracks(tracks: Track[]): Promise<SaveResult[]> {
  return invoke<SaveResult[]>("save_tracks", { tracks });
}

/** A streamed-save event (mirrors the Rust `SaveEvent` enum). */
export type SaveEvent =
  | { event: "saved"; data: { path: string; ok: boolean; error: string | null } }
  | { event: "progress"; data: { done: number; total: number } }
  | { event: "cancelled" }
  | { event: "done" };

/**
 * Streaming, cancellable save: writes one file at a time, reporting each via
 * `onEvent` so the UI can show progress and clear dirty rows as they persist.
 * Resolves after the terminal `done` / `cancelled` event. Files reported
 * `saved` with `ok: true` are persisted even if later cancelled.
 */
export function saveChanges(
  tracks: Track[],
  operationId: string,
  onEvent: (event: SaveEvent) => void,
): Promise<void> {
  const channel = new Channel<SaveEvent>();
  channel.onmessage = onEvent;
  return invoke("save_changes", { tracks, channel, operationId });
}

/** Lazily fetch embedded cover art for one file. */
export function getCoverArt(path: string): Promise<CoverArt | null> {
  return invoke<CoverArt | null>("get_cover_art", { path });
}

/** Read every editable tag item from a file (for the additional-tags editor). */
export function readAllTags(path: string): Promise<AllTags> {
  return invoke<AllTags>("read_all_tags", { path });
}

/** Replace a file's text tag items; returns any keys the format couldn't store. */
export function saveAllTags(path: string, items: TagItemDto[]): Promise<SaveAllResult> {
  return invoke<SaveAllResult>("save_all_tags", { path, items });
}

/** Return the source paths opened in the last session (empty if none). */
export function loadSession(): Promise<string[]> {
  return invoke<string[]>("load_session");
}

/** Persist the source paths so they can be restored on the next launch. */
export function saveSession(paths: string[]): Promise<void> {
  return invoke("save_session", { paths });
}
