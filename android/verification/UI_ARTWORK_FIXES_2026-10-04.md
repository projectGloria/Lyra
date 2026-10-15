# Android UI / artwork fixes — version 1.0.3

## Changes

- Embedded artwork no longer depends solely on Android's platform metadata retriever. A bounded, cancellable Media3 Inspector fallback reads ID3/FLAC/MP4/Vorbis metadata when the platform misses the cover or duration. Successful embedded covers are shared by content hash. Inspector failures are retried on refresh.
- The Room v1 → v2 migration preserves tracks and folders and marks existing track metadata for one rescan. Subsequent unchanged successful metadata stays cached.
- Folder image discovery accepts image MIME types and common image extensions. A corrupt or unreadable preferred cover falls through to the next candidate. Embedded track art supplies a folder thumbnail when there is no separate image. Missing track art falls back to album/folder art at display time, without persisting borrowed artwork as intrinsic metadata.
- MainActivity hides status and navigation bars and reapplies immersive mode on resume/focus. Android still permits temporary system controls through an edge swipe.
- Local playback buffers 150 ms before starting/resuming after a seek (instead of the Media3 default 1 second), retains 30 seconds of back buffer, and buffers up to 30 seconds ahead. Slider drag state resets on track/occurrence changes; only releasing the slider sends a seek. Position polling reuses queue state instead of traversing it every tick.
- Removed the volume-button hint from Now Playing.
- Queue UI shows only explicit Play next / Add to queue occurrences. Playlist playback has no explicit queue. Pending additions leave the queue when selected for playback; the queue button disappears and an open queue screen returns to Now Playing when empty. Duplicate occurrences, shuffle traversal, reorder/removal, reconciliation and session restoration retain their explicit flags. Old saved sessions restore with no explicit queue.
- Explicit queue indices and current player artwork are separate observable UI fields because Media3 item equality excludes custom metadata extras.

## Verification

The final `ui-artwork-checks-log.txt` records unit tests, lint and application/instrumentation APK assembly. `ui-artwork-summary.json` records totals and artifact hashes. Signature and alignment output is saved alongside this report. The debug APK uses the same signer as 1.0.2 and updates it in place.

Final results: 55 host tests passed, no failures; lint has 0 errors and 26 warnings. Debug application and instrumentation APKs built successfully. APK signature, matching update signer and 16 KiB alignment checks passed. The 47 original desktop files passed the existing integrity check.

New/extended checks cover:

- Production AndroidMetadata with a generated ID3 MP3 containing a front-cover PNG: title, duration, thumbnail/player cache files and decoded cover pixels. Media3 parses the file; this does not verify audio decoding.
- A v1 database upgrade preserving tracks/folders and causing one metadata rescan.
- Broken preferred folder images, image MIME/uppercase extensions, embedded folder thumbnails and preservation of individual track art.
- Queue flags on duplicate occurrences and metadata reconciliation, serialized explicit indices and legacy sessions, consumption by the real production service, and Compose queue visibility/empty navigation.
- Seek commands reaching a deterministic player through a real MediaController/MediaSession and immediate UI position updates.

No device/emulator is connected. Audible seek latency, real phone artwork/providers, fullscreen under gesture/three-button navigation, and phone playback remain unverified. Follow `../PHONE_TEST_CHECKLIST.md`.

Implementation references: [Media3 Inspector](https://developer.android.com/media/media3/inspector/retrieve-metadata), [local playback buffer settings](https://developer.android.com/reference/androidx/media3/exoplayer/DefaultLoadControl.Builder), [immersive system bars](https://developer.android.com/develop/ui/views/layout/immersive).

Install: `../delivery/Lyra-Android-1.0.3-debug.apk`.
