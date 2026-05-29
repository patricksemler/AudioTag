import type { EditableField } from "./types";

export interface FieldDef {
  key: EditableField;
  label: string;
  /** Restrict input to digits (track/disc/year). */
  numeric?: boolean;
  /** Render as a multi-line textarea. */
  multiline?: boolean;
}

/** Field definitions used by the Tag Editor panel (in display order). */
export const TAG_EDITOR_FIELDS: FieldDef[] = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "album_artist", label: "Album Artist" },
  { key: "track", label: "Track", numeric: true },
  { key: "track_total", label: "Track total", numeric: true },
  { key: "disc", label: "Disc", numeric: true },
  { key: "disc_total", label: "Disc total", numeric: true },
  { key: "year", label: "Year", numeric: true },
  { key: "genre", label: "Genre" },
  { key: "composer", label: "Composer" },
  { key: "comment", label: "Comment", multiline: true },
];

/** A grid column may show an editable tag field or the (read-only) filename. */
export type ColumnKey = EditableField | "filename";

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  width: number;
  /** Right-align + numeric sort (track/year). */
  numeric?: boolean;
  /** False for read-only columns (the filename); defaults to editable. */
  editable?: boolean;
}

/** Columns shown in the file grid (in display order). File is leftmost. */
export const GRID_COLUMNS: ColumnDef[] = [
  { key: "filename", label: "File", width: 240, editable: false },
  { key: "title", label: "Title", width: 220 },
  { key: "artist", label: "Artist", width: 180 },
  { key: "album", label: "Album", width: 200 },
  { key: "track", label: "#", width: 56, numeric: true },
  { key: "year", label: "Year", width: 70, numeric: true },
  { key: "genre", label: "Genre", width: 140 },
];
