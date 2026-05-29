import { describe, expect, it } from "vitest";
import {
  compileFind,
  commonValue,
  computeMixedValues,
  isModified,
  reconcileModified,
  replaceAllCount,
} from "./edits";
import { EDITABLE_FIELDS, type Row, type Track } from "./types";

function track(over: Partial<Track> = {}): Track {
  return {
    path: "/a.mp3",
    filename: "a.mp3",
    format: "MP3",
    title: null,
    artist: null,
    album: null,
    album_artist: null,
    track: null,
    track_total: null,
    disc: null,
    disc_total: null,
    year: null,
    genre: null,
    comment: null,
    composer: null,
    has_art: false,
    error: null,
    art: null,
    ...over,
  };
}

function row(over: Partial<Row> = {}): Row {
  const t = track(over);
  return { ...t, id: over.id ?? t.path, modified: over.modified ?? false };
}

describe("isModified", () => {
  it("is false when a row equals its original", () => {
    const orig = track({ title: "T", artist: "A" });
    expect(isModified(row({ title: "T", artist: "A" }), orig)).toBe(false);
  });

  it("is true after editing a field, false again after reverting", () => {
    const orig = track({ title: "T" });
    const edited = row({ title: "Changed" });
    expect(isModified(edited, orig)).toBe(true);
    const reverted = row({ title: "T" });
    expect(isModified(reverted, orig)).toBe(false);
  });

  it("treats null and empty string as equal (no spurious dirty)", () => {
    const orig = track({ genre: null });
    expect(isModified(row({ genre: "" }), orig)).toBe(false);
  });

  it("is true when art presence changes or pending art exists", () => {
    expect(isModified(row({ has_art: true }), track({ has_art: false }))).toBe(true);
    expect(
      isModified(row({ art: { mime: "image/jpeg", base64: "x" } }), track({ has_art: false })),
    ).toBe(true);
  });
});

describe("find/replace", () => {
  it("replaces all occurrences and counts hits with one compiled regex", () => {
    const re = compileFind("a", false);
    expect(replaceAllCount("banana", re, "X")).toEqual({ result: "bXnXnX", hits: 3 });
  });

  it("respects match-case", () => {
    expect(replaceAllCount("Aa", compileFind("a", true), "X")).toEqual({ result: "AX", hits: 1 });
    expect(replaceAllCount("Aa", compileFind("a", false), "X")).toEqual({ result: "XX", hits: 2 });
  });

  it("treats the find term literally (regex metachars escaped)", () => {
    expect(replaceAllCount("a.b.c", compileFind(".", false), "-")).toEqual({
      result: "a-b-c",
      hits: 2,
    });
    // A literal '.*' must not match everything.
    expect(replaceAllCount("x.*y", compileFind(".*", false), "_")).toEqual({
      result: "x_y",
      hits: 1,
    });
  });

  it("reuses one compiled regex across many haystacks (lastIndex safe)", () => {
    const re = compileFind("o", false);
    expect(replaceAllCount("foo", re, "0").hits).toBe(2);
    expect(replaceAllCount("boom", re, "0").hits).toBe(2);
    expect(replaceAllCount("xyz", re, "0").hits).toBe(0);
  });
});

describe("mixed values", () => {
  it("commonValue: shared value, mixed (undefined) when they differ", () => {
    const rows = [row({ title: "T" }), row({ title: "T" })];
    expect(commonValue(rows, "title")).toBe("T");
    expect(commonValue([row({ title: "T" }), row({ title: "U" })], "title")).toBeUndefined();
    expect(commonValue([], "title")).toBe("");
  });

  it("computeMixedValues matches commonValue field-by-field", () => {
    const rows = [
      row({ title: "Same", artist: "X", year: "2001" }),
      row({ title: "Same", artist: "Y", year: "2001" }),
      row({ title: "Same", artist: "Z", year: "2002" }),
    ];
    const mixed = computeMixedValues(rows, EDITABLE_FIELDS);
    for (const f of EDITABLE_FIELDS) {
      expect(mixed[f]).toEqual(commonValue(rows, f));
    }
    expect(mixed.title).toBe("Same"); // all equal
    expect(mixed.artist).toBeUndefined(); // differ → mixed
    expect(mixed.year).toBeUndefined(); // differ → mixed
  });

  it("empty selection yields empty strings for every field", () => {
    const mixed = computeMixedValues([], EDITABLE_FIELDS);
    for (const f of EDITABLE_FIELDS) expect(mixed[f]).toBe("");
  });

  it("a once-mixed field stays mixed even if later rows re-match the first", () => {
    const rows = [row({ genre: "A" }), row({ genre: "B" }), row({ genre: "A" })];
    expect(computeMixedValues(rows, EDITABLE_FIELDS).genre).toBeUndefined();
  });
});

describe("dirty-set derivation (commitRows invariant)", () => {
  // Mirrors how App derives dirtyIds from rows after a mutation.
  const deriveDirty = (rows: Row[]) => new Set(rows.filter((r) => r.modified).map((r) => r.id));

  it("an edited row enters the set; reverting removes it", () => {
    const orig = track({ title: "T" });
    const r = row({ id: "1", title: "Changed" });
    r.modified = isModified(r, orig);
    expect(deriveDirty([r]).has("1")).toBe(true);

    const back = row({ id: "1", title: "T" });
    back.modified = isModified(back, orig);
    expect(deriveDirty([back]).has("1")).toBe(false);
    expect(deriveDirty([back]).size).toBe(0);
  });
});

describe("reconcileModified (undo across a save boundary)", () => {
  it("re-marks a restored pre-save value as dirty against the new baseline", () => {
    // User edited "Old" → "New" and saved, so the baseline is now "New".
    const originals = new Map<string, Track>([["1", track({ title: "New" })]]);
    // Undo restores the pre-edit snapshot, whose flag was clean against the *old*
    // baseline. Reconciling against the saved baseline must flip it dirty.
    const snapshot = [row({ id: "1", title: "Old", modified: false })];

    const [reconciled] = reconcileModified(snapshot, originals);

    expect(reconciled.modified).toBe(true);
    expect(reconciled.title).toBe("Old");
  });

  it("marks a redo back to the saved value as clean", () => {
    const originals = new Map<string, Track>([["1", track({ title: "New" })]]);
    // The redo snapshot carries a stale dirty flag (true at capture time); once
    // the value matches the saved baseline again it must read clean.
    const snapshot = [row({ id: "1", title: "New", modified: true })];

    const [reconciled] = reconcileModified(snapshot, originals);

    expect(reconciled.modified).toBe(false);
  });

  it("preserves referential identity for rows whose flag does not change", () => {
    const originals = new Map<string, Track>([
      ["1", track({ title: "T" })],
      ["2", track({ title: "T" })],
    ]);
    // Row 1 already matches the baseline and stays clean; row 2 flips dirty.
    const clean = row({ id: "1", title: "T", modified: false });
    const flips = row({ id: "2", title: "Edited", modified: false });

    const out = reconcileModified([clean, flips], originals);

    expect(out[0]).toBe(clean); // same reference → grid row won't re-render
    expect(out[1]).not.toBe(flips); // new object so the dirty flag is visible
    expect(out[1].modified).toBe(true);
  });

  it("treats a row with no baseline entry as modified", () => {
    const reconciled = reconcileModified([row({ id: "gone", title: "X" })], new Map());
    expect(reconciled[0].modified).toBe(true);
  });
});
