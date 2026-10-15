# Lyra for Android

A separate, offline Android music player. Android 8+ (API 26); compile/target API 36. Kotlin, Compose, Media3, Room, and DataStore. Application ID: `com.lyra.sona.android`.

All Android source, branding copies, builds, tests, and delivery files live here. The desktop application has not been migrated or modified. No desktop dependency or command is required to build Android.

## Install

Copy `delivery/Lyra-Android-1.0.3-debug.apk` to your phone and open it. It updates the earlier debug build in place. Allow installation from the file manager you use when Android asks. This APK uses a development signing key; it is intended for direct testing, not Play Store publication.

On first run, choose `Music` or an allowed subfolder. Android 11+ blocks choosing the internal storage root, certain SD-card roots, and the main `Download` folder. If **Use this folder** is greyed out, enter an allowed subfolder. Lyra explains this before opening the picker. Cancelling leaves the guidance or previous library visible. Rejected selections and failed grants show a recovery action and preserve the previous library.

Each folder's directly contained audio becomes a playlist. **Liked Songs** contains only tracks directly in the selected root; it is not a favorites feature. File discovery accepts audio MIME types or `.mp3`, `.flac`, `.m4a`, `.aac`, `.wav`, `.ogg`, and `.opus` regardless of provider MIME errors, case-insensitively. Codec support still depends on Android/Media3 and the actual file.

Tap a track to play its collection. Track menus provide **Play next** and **Add to queue**. Tap the mini-player to open Now Playing; open Queue there to remove/reorder tracks. Use system volume buttons. Restored sessions start paused. Sudden process death can lose up to two seconds since the last position checkpoint. Seeking and queue/mode changes save immediately.

Queue displays only occurrences explicitly added with Play next or Add to queue, in playback order including shuffle. Playing a playlist creates no explicit queue. The queue button disappears when there are no pending explicit additions; an addition leaves the queue when it starts playing. Play next inserts immediately after the current occurrence; Add to queue appends to the playback order. Moving a shuffled item changes the shuffle traversal while preserving the current source. Turning shuffle off restores the underlying playlist order.

Lyra hides Android's status and navigation bars while the Activity is foreground. An edge swipe can reveal transient system controls, which Android hides again. Fullscreen is reapplied after returning from the folder picker or Settings.

Embedded covers use the platform metadata reader with a Media3 fallback for formats/tags the platform misses. Folder cover images also appear on tracks without embedded or album artwork; a track's embedded cover supplies the playlist thumbnail when no folder image exists. Failed preferred folder images fall through to the next readable image. Updating from 1.0.2 keeps the selected library and rescans old metadata once. Local playback uses a 150 ms seek/start buffering threshold and a 30-second back buffer.

When a storage provider reports a loading or failed listing, Lyra preserves the previous library and asks you to refresh after storage is ready. Files with unknown size/modification time are re-read on refresh. Successful folder switches discard old folder caches and release unused grants. Artwork has a 64 MiB eviction budget, with the current cover and just-written image pair protected; deleted covers are collected after library publication. Evicted artwork can be regenerated on refresh.

Settings contains the folder picker, refresh, notification permission action, and latest scan metrics. General notification denial does not gate playback or media-session controls.

## Build independently

Requirements: JDK 21, Android SDK command-line tools, SDK platform 36, and Android build tools. Dependencies are downloaded only by the development toolchain; the app has no network permission.

Create an ignored `local.properties` inside this directory containing your local SDK path, for example:

```properties
sdk.dir=C\:/Users/YourName/AppData/Local/Android/Sdk
```

From this directory on Windows:

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest --max-workers=1
```

macOS/Linux: use `sh ./gradlew` with the same task names. APK output: `app/build/outputs/apk/debug/app-debug.apk`. The wrapper pins Gradle 8.13 and checks the official distribution SHA-256. Versions are pinned in the Gradle build files. The Gradle plugin runs on the installed JDK 21 and produces Java/Kotlin 17 bytecode.

## Architecture

- SAF enumeration uses `DocumentsContract` projected cursor queries, never `DocumentFile.listFiles()`.
- Metadata work is bounded to four workers. Known, successful unchanged fingerprints with intact artwork skip metadata IO; missing fingerprints, evicted artwork, and failed metadata are retried.
- Room holds intrinsic metadata and artwork references. Album artwork fallback is recomputed deterministically so removed donors do not become permanent cached covers.
- A successful generation publishes the complete scan transactionally. Failed/cancelled/superseded scans cannot purge the cached library.
- Compose observes the cache immediately, independently of background scanning. Media3 owns playback in a foreground `MediaSessionService`; the UI operates a `MediaController`.
- Repository snapshots read both Room tables transactionally and distinguish loaded empty libraries from startup. Playback combines library state with scan/restoration readiness, removes missing queue occurrences incrementally, and updates metadata without replacing retained sources.
- Controller connections and position polling follow Activity visibility; foreground playback survives UI disconnection. Visible clients reconnect with bounded retry delays after a service failure.
- DataStore stores the selected tree and playback snapshot, including duplicate queue items and shuffle traversal order. Only the app and trusted system controllers may connect to the playback session.
- Image decoding uses sampling and bounded 256px thumbnails / 1024px player images. Music files are never copied or edited.

## Verification and performance

See `verification/UI_ARTWORK_FIXES_2026-10-04.md` for version 1.0.3 artwork, fullscreen, seek, and queue fixes, `verification/PLAYBACK_FIX_2026-10-04.md` for the version 1.0.2 playback regression fix, `verification/FIXES_2026-10-04.md` for version 1.0.1 fixes and checks, `verification/REPORT.md` for historical version 1.0.0 verification, and `PHONE_TEST_CHECKLIST.md` for phone checks. Build success and host tests do **not** verify Android audio playback.

The synthetic 5,000-track host benchmark uses the production scan orchestrator with fake document listings, fake metadata, and an in-memory cache. Its cache-ready time is not Room startup or Android second-launch time. Run only that benchmark with:

```powershell
.\gradlew.bat :app:testDebugUnitTest --tests '*SyntheticBenchmarkTest'
```

Actual first-scan and cached UI launch measurements require a phone. Follow `benchmark/README.md`. Future features are recorded in `BACKLOG.md`.
