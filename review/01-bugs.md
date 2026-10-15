# Correctness bugs

### [High] Dropping any file on the window navigates the webview away from the app

**Where:** [src-tauri/tauri.conf.json:52](src-tauri/tauri.conf.json:52), [src/renderer.js:2730](src/renderer.js:2730)
**Trigger:** Drag any file (an mp3, a cover image, anything) from Explorer onto the Lyra window and release it anywhere that is not a track row during an in-progress internal drag.
**Detail:** `"fileDropEnabled": false` is required for the app's own HTML5 drag-and-drop reordering to work — it tells Tauri not to intercept OS file drops, handing them to WebView2 instead. But the only `dragover` listener returns without calling `preventDefault()` unless the target is a track row or queue row *and* `draggedTrackId`/`draggedQueueId` is set:

```js
const target = (row && draggedTrackId) ? row : ((queueRow && draggedQueueId) ? queueRow : null);
if (!target) return;
event.preventDefault();
```

With no `preventDefault` on `dragover`, the drop is never cancelled, and Chromium's default action for a file dropped on a document is to navigate to it.
**Impact:** The app window is replaced by the raw file or a blank page. All in-memory playback state (queue, history, position) is lost; the app must be restarted. There is no navigation guard configured to bounce it back.
**Fix:** Register a window-level guard at the top of `bindEvents`, before the delegated handlers:

```js
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
```

The existing delegated handlers still run and still call `preventDefault` themselves, so internal reordering is unaffected.
**Confidence:** Probable — the missing guard is verified in the source; that WebView2 navigates on an uncancelled file drop is standard Chromium behaviour I could not exercise here.

---

### [High] Turning the ink background off after it has run can leave all audio silent

**Where:** [src/ink-background.js:188](src/ink-background.js:188), [src/ink-background.js:28](src/ink-background.js:28), [src/ink-background.js:72](src/ink-background.js:72)
**Trigger:** Enable "Sound-reactive background", play a track (this creates the `MediaElementAudioSourceNode`), turn the setting back off, then hit any condition that suspends the `AudioContext` — sleep/resume, or an audio output device change.
**Detail:** `createMediaElementSource(this.audio)` permanently reroutes the `<audio>` element's output through the `AudioContext`; the element no longer reaches the speakers directly. `stop()` deliberately never disconnects, and the comment says why:

```js
// Never suspend/disconnect the media source: it is also the audible playback route.
```

That is correct as far as it goes, but the only code that ever *resumes* a suspended context is the `pointerdown` handler, which is gated on the effect being on:

```js
document.addEventListener('pointerdown', () => {
  if (!this.enabled || document.hidden) return;
  this.prepareAudio().then(...)
```

The constructor comment at lines 29–33 documents that WebView2 suspends the context "after a launch, resume from sleep, or output-device change". With the ink disabled, nothing brings it back.
**Impact:** Music appears to play — `timeupdate` fires, the seek bar advances, no error is raised — but there is no sound until the app is restarted. The user has no reason to connect this to a visual setting they turned off.
**Fix:** Gate the resume on whether the graph exists, not on whether the visual is enabled: `if ((!this.enabled && !this.source) || document.hidden) return;`. Additionally, resume on `audio.play` when `this.source && this.context.state !== 'running'`.
**Confidence:** Probable — the code paths are verified; the suspension trigger is taken from the file's own comments rather than observed.

---

### [Medium] The scanner indexes audio formats the playback engine cannot decode

**Where:** [src-tauri/src/util.rs:9](src-tauri/src/util.rs:9)
**Trigger:** Point the library at a folder containing `.wma`, `.ape`, `.mpc`, `.dsf` or `.dff` files and press play on one.
**Detail:** `AUDIO_EXTENSIONS` lists 19 extensions. Playback is a plain `<audio>` element in WebView2, which uses Chromium's bundled decoders: MP3, AAC (m4a/m4b), FLAC, WAV, Ogg Vorbis, Opus and WebM. WMA, Monkey's Audio, Musepack and DSD are not among them, and `.aif`/`.aiff` and `.mp2` are not decoded by stock Chromium builds either. `lofty` reads tags for these formats happily, so they scan cleanly and appear in the library with full metadata and artwork.
**Impact:** Tracks look playable, then fail. Each failure raises a toast and auto-skips after 2s ([renderer.js:2297](src/renderer.js:2297)); five in a row halts playback entirely with "several files in a row could not be read". A library that is mostly DSD or WMA is effectively unusable, and the message blames the files rather than the format support.
**Fix:** Either narrow `AUDIO_EXTENSIONS` to what the webview can decode, or keep scanning them and mark them unplayable in the row (greyed, with a tooltip) so the failure is predicted rather than discovered.
**Confidence:** Verified for the extension list; Probable for the exact per-codec support in this WebView2 build.

---

### [Medium] Saving a playlist reverts a folder that was renamed outside Lyra

**Where:** [src-tauri/src/playlist.rs:249](src-tauri/src/playlist.rs:249), [src-tauri/src/scan.rs:346](src-tauri/src/scan.rs:346)
**Trigger:** Rename a playlist folder in Explorer (say `Rock` → `Rock 2024`), let Lyra rescan, open that playlist's editor, change only the description, Save.
**Detail:** The scan prefers the sidecar's stored name over the folder's basename for display:

```rust
let name = if metadata.name.is_empty() { file_name(folder_path) } else { metadata.name.clone() };
```

So the UI still shows `Rock`, and the editor pre-fills the title field with `Rock`. `edit_playlist` then compares against the *folder basename*, not the displayed name:

```rust
let current_name = file_name(&folder);            // "Rock 2024"
let final_name = sanitize_playlist_name(name, &current_name);   // "Rock"
let renaming = path_string(&target).to_lowercase() != path_string(&folder).to_lowercase();  // true
```

and renames the directory back to `Rock`.
**Impact:** A filesystem rename the user performed deliberately is silently undone by an unrelated edit. In a design where "the music folder is the database", this is data the user owns being rewritten without consent.
**Fix:** When the sidecar name and the folder basename disagree, treat the folder basename as authoritative (re-sync the sidecar on scan), or make the rename conditional on the title field actually having been edited in this session rather than on a string comparison.
**Confidence:** Verified

---

### [Medium] The "release the audio file before renaming" check uses the wrong name

**Where:** [src/renderer.js:1771](src/renderer.js:1771)
**Trigger:** The divergence above (sidecar name ≠ folder basename, which also occurs after any rename that previously failed), plus a track from that folder currently playing.
**Detail:** The renderer closes the audio element before saving only when it believes a rename is coming:

```js
const release = current && name !== item.name && remapLocalPath(current.path, item.path, '') !== current.path;
```

`item.name` is the sidecar name. Rust decides to rename by comparing against `file_name(&folder)`. When those differ, the renderer computes `release === false`, leaves the file handle open, and `std::fs::rename` on the containing directory fails on Windows with a sharing violation. That path is handled, but only as a soft warning:

```rust
warning = format!("Playlist details saved, but the folder could not be renamed: {error}");
```

**Impact:** The rename fails every time for that playlist while anything inside it is playing, and each failure widens the sidecar/folder divergence that caused it. The user sees a warning they cannot act on.
**Fix:** Have `edit_playlist` return the folder basename (or a `willRename` flag) so the renderer's release decision matches the backend's rename decision; or always release when the edited folder contains the current track.
**Confidence:** Verified for the code paths; Probable for the Windows sharing-violation specifics.

---

### [Medium] Playlist actions hang with no feedback for the whole duration of a scan

**Where:** [src-tauri/src/main.rs:121](src-tauri/src/main.rs:121), [src-tauri/src/main.rs:160](src-tauri/src/main.rs:160)
**Trigger:** Click "create playlist", or save the playlist editor, while a first-run scan of a large library is in progress.
**Detail:** `scan_library` takes `scan_lock` and holds it across the entire scan — discovery, parallel metadata read, artwork resolution, cache write. Every playlist command (`create_playlist`, `delete_playlist`, `edit_playlist`, `reorder_playlist`) blocks on the same mutex. On the renderer side `createPlaylist` simply awaits the invoke with no pending state, disabled button, or spinner.
**Impact:** The button is dead for as long as the scan runs — minutes for a large library — with no indication that anything was registered. A user will click it repeatedly, queueing several playlist creations that all fire at once when the lock releases.
**Fix:** Either disable the mutating controls while `state.scanning` is true and say why, or hold the lock only around the cache/snapshot commit rather than the whole scan.
**Confidence:** Verified

---

### [Medium] Album artwork for cross-folder albums is nondeterministic between scans

**Where:** [src-tauri/src/scan.rs:697](src-tauri/src/scan.rs:697)
**Trigger:** An album whose tracks live in more than one folder (e.g. `Disc 1/`, `Disc 2/`, or a compilation split by artist) where those folders carry different cover images.
**Detail:** `apply_album_artwork_globally` builds its cover map by iterating a `HashMap`:

```rust
for tracks in tracks_by_folder.values() {
    ...
    covers.entry(key).or_insert_with(|| track.artwork_path.clone());
```

`HashMap` iteration order is randomised per process by the default hasher, and `or_insert_with` keeps whichever cover is seen first. `apply_album_artwork_within_folders` has the same shape but is safe because it operates inside one folder's ordered `Vec`.
**Impact:** The same album can show a different cover after each restart, for no reason the user can see. It also invalidates the track cache's artwork signature check, causing avoidable re-reads.
**Fix:** Collect the folder paths into a sorted `Vec` before the first pass, or break ties on a stable key (shortest path, then lexicographic).
**Confidence:** Verified

---

### [Low] Deletion holds the scan lock while a modal dialog waits for the user

**Where:** [src-tauri/src/main.rs:188](src-tauri/src/main.rs:188), [src-tauri/src/playlist.rs:203](src-tauri/src/playlist.rs:203)
**Trigger:** Start deleting a playlist, then leave the native confirmation dialog open.
**Detail:** `delete_playlist` acquires `scan_lock` in the command handler and then calls `MessageDialogBuilder::...::show()`, which blocks until the user answers. The lock is held for the entire time the dialog is on screen.
**Impact:** Every scan — including watcher-driven background refreshes — stalls behind an unanswered dialog, and the library silently stops tracking filesystem changes. Indefinite if the dialog is ignored.
**Fix:** Take the confirmation before acquiring the lock, or split the command into confirm and commit phases.
**Confidence:** Verified

---

### [Low] An interrupted scrub can freeze the seek bar for the rest of the session

**Where:** [src/renderer.js:2689](src/renderer.js:2689), [src/renderer.js:2694](src/renderer.js:2694)
**Trigger:** Begin dragging the seek slider, and have the dock re-render before releasing — e.g. a library switch that nulls `state.currentTrack`, which makes `renderPlayerDock` replace the dock's `innerHTML` with the disabled variant.
**Detail:** `state.isScrubbing` is set `true` on `input` and cleared only on `change`. Both listeners are delegated on `document` and match by element id. When the original slider is detached mid-drag, its `change` event never reaches `document`, so the flag is never cleared. `updateSeekUi` then returns at its first line forever:

```js
function updateSeekUi() { if (state.isScrubbing) return; ... }
```

**Impact:** Time labels and the progress fill stop updating for all remaining playback. Playback itself is unaffected, so it reads as a rendering bug with no obvious cause.
**Fix:** Also clear the flag on `pointerup`/`pointercancel` at the document level, and reset it in `renderPlayerDock` when the dock is rebuilt.
**Confidence:** Probable

---

### [Low] Atomic writes leave orphaned temp files inside the user's music folder

**Where:** [src-tauri/src/util.rs:245](src-tauri/src/util.rs:245)
**Trigger:** The process is killed (or the machine loses power) between the temp-file write and the rename, while saving a playlist sidecar.
**Detail:** `write_json_atomic` places its temp file beside the target: `<name>.tmp-<pid>-<n>`. For app-data files that is invisible, but `write_playlist_metadata` targets `.lyra-playlist.json` *inside the music library*, so the temp file lands in the user's own folder. The error path cleans up, but a hard kill does not run it, and nothing sweeps them later. The watcher explicitly ignores names containing `.tmp-`, so they never surface in the UI either.
**Impact:** Slow accumulation of hidden junk files in the user's music library.
**Fix:** Sweep `*.tmp-*` older than a few minutes during the existing `MAINTENANCE.call_once` startup pass, scoped to folders the scan already visits.
**Confidence:** Verified
