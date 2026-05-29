// Pure helpers for edit/dirty/find-replace/mixed-value logic. Kept free of React
// so they can be unit-tested directly (see edits.test.ts). PLAN.md §3/§9/§10.

import { EDITABLE_FIELDS, type EditableField, type Row, type Track } from "./types";

/** True when a row's current values differ from what was loaded from disk. */
export function isModified(row: Row, original: Track): boolean {
  if (row.art) return true; // pending cover art to write
  if (row.has_art !== original.has_art) return true;
  return EDITABLE_FIELDS.some((f) => (row[f] ?? "") !== (original[f] ?? ""));
}

/**
 * Recompute every row's `modified` flag against the *current* on-disk baseline
 * (`originals`), used when restoring an undo/redo snapshot. A snapshot captures
 * the `modified` flags that were true at capture time, but a save in between
 * advances the baseline — so a restored value that matched disk then may differ
 * now (and vice versa). Recomputing here keeps the invariant "`modified` ⇔
 * differs from disk", which is what lets undo cross a save boundary: undoing a
 * saved edit re-marks the row dirty so it must be saved again.
 *
 * Referential identity is preserved for rows whose flag is unchanged, so the
 * memoized grid only re-renders rows that actually flipped dirty/clean. Rows
 * with no baseline entry are treated as modified (same rule as the edit paths).
 */
export function reconcileModified(rows: Row[], originals: Map<string, Track>): Row[] {
  return rows.map((r) => {
    const orig = originals.get(r.id);
    const modified = orig ? isModified(r, orig) : true;
    return modified === r.modified ? r : { ...r, modified };
  });
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a literal find string into a global RegExp (once, before a loop). */
export function compileFind(find: string, matchCase: boolean): RegExp {
  return new RegExp(escapeRegExp(find), matchCase ? "g" : "gi");
}

/**
 * Replace every match of a *precompiled* global RegExp in `haystack`, returning
 * the result and the hit count. The regex is compiled once by the caller and
 * reused across every row/field, instead of recompiling per cell. (A global
 * regex passed to `String.replace` resets its `lastIndex`, so reuse is safe.)
 */
export function replaceAllCount(
  haystack: string,
  re: RegExp,
  replacement: string,
): { result: string; hits: number } {
  let hits = 0;
  const result = haystack.replace(re, () => {
    hits++;
    return replacement;
  });
  return { result, hits };
}

/**
 * The shared value of `field` across `rows`, or `undefined` when they differ
 * ("mixed"). `""` is a real shared value (all empty); only `undefined` means
 * mixed. Empty selection → `""`.
 */
export function commonValue(rows: Row[], field: EditableField): string | undefined {
  if (rows.length === 0) return "";
  const first = rows[0][field] ?? "";
  for (const r of rows) {
    if ((r[field] ?? "") !== first) return undefined;
  }
  return first;
}

/**
 * Mixed values for every field in one pass over the selection, instead of one
 * O(selection) scan per field. Returns `field → shared string | undefined`,
 * where `undefined` marks a mixed field (same contract as {@link commonValue}).
 */
export function computeMixedValues(
  rows: Row[],
  fields: readonly EditableField[],
): Record<EditableField, string | undefined> {
  const out = {} as Record<EditableField, string | undefined>;
  if (rows.length === 0) {
    for (const f of fields) out[f] = "";
    return out;
  }
  const first = rows[0];
  for (const f of fields) out[f] = first[f] ?? "";
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    for (const f of fields) {
      // Once a field is mixed (undefined) it stays mixed.
      if (out[f] !== undefined && (r[f] ?? "") !== out[f]) out[f] = undefined;
    }
  }
  return out;
}
