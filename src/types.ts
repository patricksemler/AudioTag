/** A track's tag data, mirrors the Rust `Track` struct. */
export interface Track {
  path: string;
  filename: string;
  format: string;

  title: string | null;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  track: string | null;
  track_total: string | null;
  disc: string | null;
  disc_total: string | null;
  year: string | null;
  genre: string | null;
  comment: string | null;
  composer: string | null;

  has_art: boolean;
  error: string | null;
}

/** A grid row: a track plus UI-only derived state. */
export interface Row extends Track {
  /** Stable identity (the file path). */
  id: string;
  /** True when current values differ from what was loaded from disk. */
  modified: boolean;
}

export interface SaveResult {
  path: string;
  ok: boolean;
  error: string | null;
}

export interface CoverArt {
  mime: string;
  base64: string;
}

/** A raw tag item (format-native key + text value) for the additional-tags editor. */
export interface TagItemDto {
  key: string;
  value: string;
}

/** The full set of editable tag items for one file. */
export interface AllTags {
  tag_type: string;
  items: TagItemDto[];
}

/** Outcome of writing arbitrary tags: keys not supported by the file's format. */
export interface SaveAllResult {
  ok: boolean;
  skipped: string[];
}

/** The editable tag fields (everything except read-only metadata). */
export type EditableField =
  | "title"
  | "artist"
  | "album"
  | "album_artist"
  | "track"
  | "track_total"
  | "disc"
  | "disc_total"
  | "year"
  | "genre"
  | "comment"
  | "composer";

export const EDITABLE_FIELDS: EditableField[] = [
  "title",
  "artist",
  "album",
  "album_artist",
  "track",
  "track_total",
  "disc",
  "disc_total",
  "year",
  "genre",
  "comment",
  "composer",
];
