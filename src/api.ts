import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { CoverArt, SaveResult, Track } from "./types";

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

/** Write edits for the given tracks back to disk. */
export function saveTracks(tracks: Track[]): Promise<SaveResult[]> {
  return invoke<SaveResult[]>("save_tracks", { tracks });
}

/** Lazily fetch embedded cover art for one file. */
export function getCoverArt(path: string): Promise<CoverArt | null> {
  return invoke<CoverArt | null>("get_cover_art", { path });
}

/** Return the source paths opened in the last session (empty if none). */
export function loadSession(): Promise<string[]> {
  return invoke<string[]>("load_session");
}

/** Persist the source paths so they can be restored on the next launch. */
export function saveSession(paths: string[]): Promise<void> {
  return invoke("save_session", { paths });
}
