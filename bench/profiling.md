# Frontend profiling procedure

Manual procedure for the frontend metrics in PLAN.md §4.4 / §1 target table.
Run against `pnpm tauri dev` (or a release build for representative numbers).
All snippets paste into the webview devtools console (right-click → Inspect, or
the IDE webview inspector).

## Time to first visible row / total scan

The scan call site is `loadPaths` in `src/App.tsx`. To time it without code
changes, wrap the measurement in the console before opening a folder:

```js
performance.mark('scan:start')
// …open the folder…
// when the first row paints / when the count stops climbing:
performance.mark('scan:firstrow'); performance.measure('TTF row', 'scan:start', 'scan:firstrow')
performance.mark('scan:done');     performance.measure('total scan', 'scan:start', 'scan:done')
performance.getEntriesByType('measure').forEach(m => console.log(m.name, m.duration.toFixed(1), 'ms'))
```

For a precise first-row mark, temporarily add (dev-only) to `App.tsx`:

```tsx
useEffect(() => { if (rows.length > 0) performance.mark('scan:firstrow') }, [rows.length === 0])
```

(Pre-streaming, TTF row ≈ total scan — that's the baseline the streaming work
in Phase 4 attacks.)

## Keypress latency (Event Timing API)

```js
const lat = []
new PerformanceObserver(list => {
  for (const e of list.getEntries()) {
    if (e.name === 'keydown' || e.name === 'input') lat.push(e.duration)
  }
}).observe({ type: 'event', durationThreshold: 16, buffered: true })
// …type in a field…  then:
lat.sort((a,b)=>a-b); console.log('p95 keypress', lat[Math.floor(lat.length*0.95)]?.toFixed(1), 'ms', 'n='+lat.length)
```

Capture at: 20k loaded / 1 selected, and 20k loaded / 20k selected (Cmd/Ctrl+A).

## Long tasks (> 50 ms blocks)

```js
new PerformanceObserver(list => {
  for (const e of list.getEntries()) console.warn('longtask', e.duration.toFixed(1), 'ms')
}).observe({ type: 'longtask', buffered: true })
```

Watch during: scan, typing with full selection, find/replace all-fields, save.

## React commits per interaction

Use the React DevTools **Profiler** tab (Components extension). Record an
arrow-key hold, a single-field edit, and a typing burst with full selection.
Read: commit count, commit duration, and "why did this render" per row. Target:
arrow-key move re-renders ≤ 2 rows (old + new focused), independent of total
rows.

## IPC payload size

`AUDIOTAG_TIMING=1` logs the serialized `scan_paths` byte count on the backend.
On the frontend, wrap a call to log `JSON.stringify(result).length` (dev-only)
after `scanPaths` / `saveTracks` resolves.

## Memory

- Backend peak RSS: `/usr/bin/time -l <cmd>` on macOS (look at "maximum resident
  set size"). For the art-heavy scan, compare against a non-art corpus to see
  whether peak RSS scales with Σ embedded-art bytes (PLAN.md H3).
- Webview heap: DevTools → Memory → heap snapshot after loading 20k, and after
  100 selection changes (cover-art memory). Compare retained size.
