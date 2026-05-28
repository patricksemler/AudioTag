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

export interface ColumnDef {
  key: EditableField;
  label: string;
  width: number;
}

/** Columns shown in the file grid (in display order). */
export const GRID_COLUMNS: ColumnDef[] = [
  { key: "title", label: "Title", width: 240 },
  { key: "artist", label: "Artist", width: 180 },
  { key: "album", label: "Album", width: 200 },
  { key: "track", label: "#", width: 56 },
  { key: "year", label: "Year", width: 70 },
  { key: "genre", label: "Genre", width: 140 },
];
