# Architecture and maintainability

The Rust side is in good shape: clear module boundaries, one responsibility each, and — unusually — comments that explain *why* a non-obvious decision was made rather than restating the code. The generation-counter cancellation, the artwork precedence ordering and the local-write suppression in the watcher are all documented at the point where a future reader would otherwise undo them. The problems are concentrated in the renderer.

### [Medium] Render functions mutate the state that playback reads

**Where:** [src/renderer.js:669](src/renderer.js:669), [src/renderer.js:709](src/renderer.js:709), [src/renderer.js:752](src/renderer.js:752), [src/renderer.js:781](src/renderer.js:781)
**Detail:** `state.selectedTracks` is assigned as a side effect of rendering, in four different render paths:

```js
renderEntityView:  state.selectedTracks = tracks;          // all tracks by that artist/album
renderSearchView:  state.selectedTracks = tracks;          // all search matches
renderContent:     state.selectedTracks = [...(item.tracks || [])];
renderContent:     state.selectedTracks = getSelectedItem()?.tracks || state.selectedTracks;
```

`playSelected()`, `playTrackById()`, `queueTracks(state.selectedTracks)`, `getSelectedTrackObjects()`, `updateTrackSelection()` and `reorderSelectedTracks()` all read it.
**Impact:** What happens when you press Play is determined by whichever render ran last, not by an explicit selection. This is the root cause of the search finding in [04-ux.md](04-ux.md), it makes `render()` unsafe to call speculatively, and it means any future change to render ordering can silently change playback behaviour. It is also why the regression tests have to reconstruct so much fake state to exercise one function.
**Fix:** Make the current collection an explicit piece of state set by navigation (`setActiveCollection(tracks, id)`), and have the render functions read it without writing to it.

---

### [Medium] The test harness couples tests to source formatting

**Where:** [tests/renderer-regressions.test.cjs:9](tests/renderer-regressions.test.cjs:9), [tests/fullscreen.test.cjs:9](tests/fullscreen.test.cjs:9)
**Detail:** Tests read `renderer.js` as text and extract functions with a regex plus a string slice:

```js
const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
return source.slice(start, source.indexOf('\n}\n', start) + 2);
```

`fullscreen.test.cjs` slices the range *between* two named functions. This is a reasonable pragmatic choice for a no-bundler project, and the `assert.ok(start >= 0, name)` makes a rename fail loudly rather than silently. But it binds the test suite to: the `function name(` declaration form, a closing brace at column 0, and the absence of any line that is exactly `}` inside a template literal in a tested function. Converting one helper to `const name = () => ...`, or indenting it into a block, breaks discovery.
**Impact:** More importantly, this shapes what *can* be tested: only functions whose dependencies can be hand-stubbed in a `vm` context. There is no coverage of the render pipeline, the bridge, `normalizeLibrary`, the virtual list, or any DOM interaction — the three test files cover 30 cases, all of them pure-ish logic. The 2,866-line renderer's largest surfaces are untested.
**Fix:** Keep the current tests, but add a layer that loads the real `index.html` + `renderer.js` under jsdom or linkedom with a stubbed `window.spotfck`, so the render and event paths get exercised at all. That also removes the formatting coupling for anything moved into it.

---

### [Medium] `renderer.js` is one 2,866-line module with 44 mutable globals

**Where:** [src/renderer.js](src/renderer.js)
**Detail:** 44 module-level `let` bindings hold timers (`toastTimer`, `contentSearchTimer`, `listSearchTimer`, `libraryChangeTimer`, `librarySearchTimer`, `volumeSaveTimer`, `sidebarSaveTimer`, `playbackSessionTimer`, `fullscreenVolumeHideTimer`, `volumeFeedbackTimer`, `libraryViewSaveTimer`, `playbackErrorTimer`), drag state, request-id counters, and render memo keys. `bindEvents` is a single 489-line function. Concerns that belong apart — playback engine, library model, view rendering, drag-and-drop, settings, keyboard — are interleaved.
**Impact:** There is no way to test or reason about one concern in isolation, which is exactly why the test harness has to slice functions out by text. The eleven separate debounce timers are each correct but the pattern is duplicated eleven times.
**Fix:** The file is already organised into implicit sections; splitting it into `playback.js`, `library.js`, `views/*.js` and `input.js` as classic scripts requires no bundler — they can be additional `<script>` tags sharing the same global scope, which is what the code effectively does already. That would also let the tests import real files instead of slicing text.

---

### [Medium] Settings defaults are duplicated across the language boundary

**Where:** [src-tauri/src/settings.rs:16](src-tauri/src/settings.rs:16), [src/renderer.js:24](src/renderer.js:24)
**Detail:** Thirteen keys with their default values are written out twice, in Rust and in JS, with a comment in each pointing at the other. Nothing enforces agreement — a key added to one side and forgotten on the other fails silently, and `paletteVersion`/`layoutVersion` have the extra property that their absence re-runs a one-time migration on every launch.
**Impact:** A drift class that is invisible until a user reports that a setting resets.
**Fix:** Let Rust own the defaults and have the renderer start from `await readSettings()` rather than merging over its own copy. If a synchronous default is needed for first paint (it is, for the theme), keep only the two appearance keys duplicated — which is what `applyCachedAppearance` already does via `localStorage`.

---

### [Medium] Long CPU and I/O work runs on the async runtime with blocking locks

**Where:** [src-tauri/src/main.rs:97](src-tauri/src/main.rs:97), [src-tauri/src/main.rs:121](src-tauri/src/main.rs:121)
**Detail:** `scan_library` and the playlist commands are `#[tauri::command(async)]`, so Tauri spawns them on the tokio runtime. Each then blocks a runtime worker on a `std::sync::Mutex`, and `scan_library` additionally drives a rayon parallel iterator and synchronous file I/O for the whole scan — potentially minutes — inside that task. `delete_playlist` blocks a worker on a modal dialog awaiting user input.
**Impact:** Works today because the default runtime has several workers and the app has few concurrent commands, but it is the wrong shape: blocking calls on an async executor. It also produces the "dead button" behaviour in [01-bugs.md](01-bugs.md), since the blocked command cannot report that it is queued.
**Fix:** `tauri::async_runtime::spawn_blocking` for the scan, and a try-lock with an explicit "busy, scan in progress" error for the playlist commands so the renderer can say so.

---

### [Low] Two error channels for the same operation

**Where:** [src-tauri/src/main.rs:97](src-tauri/src/main.rs:97), [src-tauri/src/model.rs:54](src-tauri/src/model.rs:54)
**Detail:** `scan_library` returns a bare `Library` and encodes failure in `ok`/`error`/`cancelled` fields via `Library::failed`; `refresh_library_changes` returns `Result<Library, String>` *and* can still carry `ok: false` inside the Ok variant. The renderer therefore handles three failure shapes for one logical operation — a rejected promise, `result.ok === false`, and `result.cancelled` — which is visible in `scanLibrary`'s try/catch/finally at [renderer.js:2051](src/renderer.js:2051).
**Fix:** Pick one. `Result<Library, ScanError>` with a typed error enum would collapse the renderer's three branches into two.

---

### [Low] Vestigial code from earlier iterations

**Where:** [src/renderer.js:613](src/renderer.js:613), [src/renderer.js:627](src/renderer.js:627), [src/renderer.js:2384](src/renderer.js:2384)
**Detail:** Small residue that indicates drift rather than causing bugs:

- `const visible = playlists;` — an alias for a filter that no longer exists; the empty-state copy below it still says "Try a different search".
- `const subtitle = item.isLiked ? A : B` where `A` and `B` are character-for-character identical.
- `playSelected(false)` — `playSelected` takes no parameters.
- `PlaylistResult.warning` carries `#[serde(default)]` on a `Serialize`-only struct ([model.rs:115](src-tauri/src/model.rs:115)); `default` is a `Deserialize` attribute and does nothing there.
- `DeleteResult.audio_count` is computed and returned but never read by the renderer, which uses `item.tracks?.length` instead.
- `openPlaylistEditor`'s `item.isLiked` guard can never fire — `getFolderById` reads `libraryFolderIndex`, which only ever contains real folders.

**Fix:** Delete them. Each one costs a future reader time working out whether it matters.

---

### [Low] The bridge global is named after a different application

**Where:** [src/tauri-bridge.js:7](src/tauri-bridge.js:7)
**Detail:** The entire native surface is exposed as `window.spotfck`, documented as "the name the renderer was written against in the Electron build". It appears roughly 40 times across `renderer.js`.
**Impact:** Nothing functional. It is the most visible sign of the port's origin, and it is the kind of name that is awkward to explain to a contributor or leave in a public repo.
**Fix:** A rename to `window.lyra` is a mechanical find-and-replace across two files; the test stubs that reference `window.spotfck` would need the same change.
