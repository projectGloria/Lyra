# Performance

All findings scale with library size. They are cheap on a few hundred tracks and expensive on tens of thousands. I had no large library to measure against, so the costs below are derived from the code's complexity, not from a profile.

### [Medium] A single irrelevant file event forces a full re-walk of the library

**Where:** [src-tauri/src/watcher.rs:102](src-tauri/src/watcher.rs:102), [src-tauri/src/scan.rs:424](src-tauri/src/scan.rs:424)
**Trigger:** Any directory created, renamed or removed under the library root; or any file with no extension; or a `.tmp`/editor swap file that the name filter doesn't catch.
**Detail:** The watcher's relevance filter deliberately lets through anything structural or unknown:

```rust
!is_local_write(path) && (structural || is_relevant(path) || path.is_dir() || path.extension().is_none())
```

The renderer forwards those paths, and `incremental_folders` bails to a full scan for any of them:

```rust
if path.is_dir() || !(is_audio(&path) || is_image(&path) || file_name(&path) == PLAYLIST_METADATA_FILE) {
    return None;
}
```

**Impact:** Creating one empty subfolder anywhere in the library re-walks the entire tree, re-stats every audio file, re-checks every artwork signature, and rewrites both JSON caches. Anything that touches the music folder on a schedule — a sync client, a backup tool, a download manager writing `.part` files — keeps the library in near-continuous full rescan.
**Fix:** Handle the common structural cases incrementally: a created/removed directory only invalidates that subtree; a renamed directory invalidates the old and new paths. Reserve the full-scan fallback for genuinely unknown events.

---

### [Medium] Every scan rewrites the full track cache and the full library snapshot

**Where:** [src-tauri/src/cache.rs:141](src-tauri/src/cache.rs:141), [src-tauri/src/cache.rs:170](src-tauri/src/cache.rs:170)
**Trigger:** Any scan, including a watcher-driven incremental refresh of one changed file.
**Detail:** `TrackCache::save` serialises every entry for every library ever scanned, and `write_snapshot` serialises the entire `Library` — all folders, all tracks, all metadata. Both go through `write_json_atomic`, which `sync_all`s before renaming. There is no incremental or append path.
**Impact:** Copying one new song into the library triggers two full-library JSON writes with an fsync each. At 50k tracks those files are on the order of tens of MB; on a spinning disk or a busy SSD this is seconds of I/O for a one-file change, and it repeats for every file of a large drag-and-drop that the debounce doesn't fully coalesce.
**Fix:** Skip the writes when the scan produced no changes (compare a cheap digest of the resulting library). Longer term, an embedded key-value store (redb, sled) or SQLite would make per-track updates O(1) instead of O(library).

---

### [Medium] The whole library crosses the IPC boundary as one JSON blob, then is walked again

**Where:** [src-tauri/src/main.rs:98](src-tauri/src/main.rs:98), [src/tauri-bridge.js:50](src/tauri-bridge.js:50)
**Trigger:** Every launch (snapshot read) and every scan completion.
**Detail:** `scan_library` returns the full `Library` by value; Tauri serialises it to JSON, the webview parses it, and then `mapLibraryUrls` recurses over every object and adds a derived URL for every path-shaped key:

```js
if (key === 'path' || key.endsWith('Path')) {
  library[key === 'path' ? 'url' : key.slice(0, -4) + 'Url'] = toAssetUrl(value);
}
```

That is `Object.entries` plus two `convertFileSrc` calls per track (`path` and `artworkPath`), on top of the parse.
**Impact:** Startup and post-scan both block the renderer's main thread for the duration of parse + walk, with no yielding — the UI is frozen, not just busy. Memory roughly doubles for path data, since each track now holds both the path and its percent-encoded URL.
**Fix:** Derive URLs lazily at render time (the virtual list only ever shows ~30 rows) instead of eagerly for the whole library; or stream the library to the renderer in folder-sized chunks so the first playlist is interactive before the last one arrives.

---

### [Medium] Library and search filtering re-scan every track on each keystroke

**Where:** [src/renderer.js:576](src/renderer.js:576), [src/renderer.js:707](src/renderer.js:707)
**Trigger:** Typing in the library filter or the global search box.
**Detail:** Both paths do a full linear pass with per-comparison allocation:

```js
(item.tracks || []).filter((track) => [track.title, track.artist, track.album]
  .some((value) => String(value || '').toLowerCase().includes(query)))
```

The array literal, the `String()` wrap and the `toLowerCase()` result are all allocated per track per field — three temporary strings per track, on every pass. Debouncing is 90ms, so a normal typing speed produces a pass per character.
**Impact:** At 50k tracks that is 150k temporary strings per keystroke, plus a full `innerHTML` rebuild of the sidebar. Perceptible input lag and GC churn on large libraries.
**Fix:** Precompute a lowercased `searchText` field per track once in `normalizeLibrary` and match against that. That alone removes all the per-keystroke allocation.

---

### [Low] The artwork directory listing is cloned once per track

**Where:** [src-tauri/src/artwork.rs:24](src-tauri/src/artwork.rs:24)
**Trigger:** Scanning a folder that contains many images — typically an album where every track has its own sidecar cover.
**Detail:** The cache exists to avoid re-reading the directory, which it does, but it hands back an owned copy every time:

```rust
.and_then(|map| map.get(directory).cloned())
```

`find_track_artwork` calls this once per track, so a folder with N tracks and N images performs N clones of an N-element `Vec<PathBuf>` — O(N²) allocations, under a `Mutex` that all rayon workers contend on.
**Impact:** Noticeable only for folders with hundreds of images; the lock contention is the more general cost since every worker thread serialises through it.
**Fix:** Return `Arc<Vec<PathBuf>>`, or switch to a sharded/read-write map so lookups don't serialise.

---

### [Low] The track cache is parsed twice on the first scan of each session

**Where:** [src-tauri/src/main.rs:126](src-tauri/src/main.rs:126), [src-tauri/src/cache.rs:68](src-tauri/src/cache.rs:68)
**Detail:** `MAINTENANCE.call_once(|| cache::collect_artwork(...))` runs immediately before `scan::scan_library`. `collect_artwork` calls `TrackCache::load`, and the scan then calls `TrackCache::load` again a few lines later. Both are full `serde_json` parses of the same file.
**Impact:** One redundant full parse of a potentially large JSON file on the first scan after launch, on the critical path to the first UI paint.
**Fix:** Load once and pass the cache into `collect_artwork`.

---

### [Low] `renderLibrary` recomputes its summary twice per call

**Where:** [src/renderer.js:511](src/renderer.js:511)
**Detail:** `updateLibrarySummary()` is called once at the top of `renderLibrary` and again with `items.length` after filtering. When the filter is `albums`, each call invokes `getAlbumCollections()` — cached, so the second is cheap, but both write to the DOM.
**Impact:** Trivial per call; it just makes the render path harder to reason about.
**Fix:** Call it once, after `items` is known.

---

### [Low] `render()` rebuilds every panel for changes that affect one

**Where:** [src/renderer.js:1162](src/renderer.js:1162)
**Detail:** `render()` fans out to six render functions plus five appearance appliers, each replacing `innerHTML` wholesale. It is called for things as small as toggling shuffle ([renderer.js:1443](src/renderer.js:1443) calls `renderContent()`, which rebuilds the hero, the toolbar and the virtual list container).
**Impact:** Full re-parse of several kilobytes of HTML and loss of any transient DOM state per toggle. Masked today because the app already has targeted updaters (`updatePlaybackModeControls`, `updateTrackRowStates`) for the hot paths.
**Fix:** Extend the targeted-updater pattern to the remaining cases rather than reaching for `render()`.
