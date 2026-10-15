# Security

Lyra is a local, offline desktop app: no network client, no server, no auth, no remote content. The realistic threat model is narrow — a malicious or malformed file inside the user's own music folder (audio tags, a hand-edited `.lyra-playlist.json`, a crafted filename), and whatever the renderer can ask the backend to do.

**The posture here is good, and the parts that usually go wrong in a Tauri app are done right.** Verified during this pass:

- **Path containment holds.** `is_path_inside` ([util.rs:117](src-tauri/src/util.rs:117)) canonicalises both sides before comparing, and every caller checks existence so canonicalisation actually runs — `reveal_in_explorer` checks `resolved.exists()` first, `delete_playlist`/`edit_playlist`/`reorder_playlist` all check `is_dir()`. I specifically tried to construct a `..` traversal (`C:\Music\..\Windows`): because the path exists, `canonicalize` resolves it to `C:\Windows`, which fails the prefix test. The lexical fallback only applies to paths that don't exist, which then fail the `is_dir()`/`exists()` check anyway.
- **Sidecar artwork cannot escape its folder.** `PlaylistMetadata::artwork_path` ([playlist.rs:16](src-tauri/src/playlist.rs:16)) reduces a stored value to its last path segment before joining, so a tampered `"artworkFile": "../../../secret.png"` resolves to `secret.png` inside the playlist folder and then fails `is_image`/`is_file`.
- **Playlist names cannot traverse.** `sanitize_playlist_name` ([util.rs:192](src-tauri/src/util.rs:192)) strips `< > : " / \ | ? *` and control characters, trims trailing dots and spaces, caps at 120 chars, and rejects the Windows reserved device names. `.` and `..` both reduce to empty and fall back.
- **No XSS path found.** Every `innerHTML` interpolation of file-derived data (titles, artists, albums, paths, playlist names) routes through `escapeHtml`, `artMarkup` or `iconMarkup`. I checked all 27 `innerHTML` assignment sites. Toasts and path labels use `textContent`.
- **Deletion is non-destructive and doesn't follow links.** `trash::delete` rather than `remove_dir_all`, behind a native confirmation whose file counts are read off the real folder, and `deletion_contents` ([playlist.rs:152](src-tauri/src/playlist.rs:152)) counts symlinks without traversing them.
- **The Tauri allowlist is opt-in** (`"all": false` at every level), the CSP is explicit with `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-src 'none'`, and there is no remote origin anywhere.

The findings below are hardening, not vulnerabilities.

---

### [Low] Diagnostic redaction only masks two known prefixes

**Where:** [src-tauri/src/diagnostics.rs:29](src-tauri/src/diagnostics.rs:29)
**Detail:** `redact` replaces the library root with `<library>` and the home directory with `~`. Any other absolute path passes through verbatim. Paths reach the log mainly through error strings — a Rust `io::Error` for a background image or a chosen cover on another drive (`D:\Photos\...`) is logged unmasked via `playlist.create-failed`, `library.scan-result-invalid` and similar. Object *keys* are never redacted at all ([diagnostics.rs:76](src-tauri/src/diagnostics.rs:76)), only string values.
**Impact:** A report the user shares for support can leak directory names outside the two masked roots. The settings copy does warn users to review reports before sharing, which limits this.
**Fix:** Also mask the drive-root form of any configured path (background, profile, last-chosen cover), and run keys through `redact` alongside values.
**Confidence:** Verified

---

### [Low] Asset-protocol scope only ever grows

**Where:** [src-tauri/src/main.rs:72](src-tauri/src/main.rs:72)
**Detail:** `allow_media_paths` grants scope for `libraryPath` (recursively), `backgroundPath` and `profilePath` on every settings save and at startup. Nothing is ever revoked — switching libraries three times in a session leaves all three roots readable by the webview for the rest of the process, and `removeBackground`/`removeProfilePicture` leave those grants in place.
**Impact:** Widens what a hypothetical injected script could read via `asset:` URLs beyond the currently configured library. Not reachable today given `script-src 'self'` and no remote content.
**Fix:** Rebuild the scope from the current settings on each save rather than appending to it.
**Confidence:** Verified

---

### [Low] `withGlobalTauri` exposes the full allowlisted API to any page script

**Where:** [src-tauri/tauri.conf.json:8](src-tauri/tauri.conf.json:8)
**Detail:** `"withGlobalTauri": true` puts `window.__TAURI__` on the page. `src/tauri-bridge.js` is the only intended consumer — its own header comment says "nothing below it reaches into `window.__TAURI__` directly" — so the global exists purely to avoid a bundler.
**Impact:** Defence in depth only. If an XSS were ever introduced, the attacker gets `dialog.save`, `dialog.open` and the asset protocol directly rather than only the curated `window.spotfck` surface.
**Fix:** Import from `@tauri-apps/api` (already a dependency) and drop the global. That does require a bundling step the project currently avoids by design, so this is a real trade-off rather than a free win.
**Confidence:** Verified

---

### [Low] `log_event` is an unbounded renderer→disk channel

**Where:** [src-tauri/src/main.rs:354](src-tauri/src/main.rs:354), [src-tauri/src/diagnostics.rs:67](src-tauri/src/diagnostics.rs:67)
**Detail:** The renderer can log arbitrary event names and detail objects with no rate limit. `sanitize` caps array elements at 50 and recursion at depth 4, but places no limit on object key count or individual string length.
**Impact:** A runaway loop in the renderer (e.g. an error handler that logs from inside an error path) fills the 5MB log and churns through all five archives, destroying the diagnostic history that the feature exists to provide. Disk use is bounded at ~25MB.
**Fix:** Cap string length and object entry count in `sanitize`, and drop duplicate consecutive events.
**Confidence:** Verified
