# Android review — 4 October 2026

Reviewed the complete Android production source, Gradle configuration, manifest, host tests, device benchmark, and delivery documentation. This is a review, not a fix: production code and the delivered APK were not edited.

**Result: nine actionable findings, including two high-priority library/queue consistency bugs.** Five findings have focused host reproductions; four are established by code and Media3 behavior but still need phone-level validation of their visible effects. P1 means fix before relying on the affected workflow; P2 means a normal-priority functional or resource defect.

## Verification

- Original suite: **29 tests passed**, zero failures/errors. Final run: `review-final-tests-log.txt`.
- Debug app and instrumentation APK assembly: passed. `review-build-tests-log.txt`.
- Six additional review probes passed by asserting the observed defects. They are **not passing regression tests for correct behavior**. Sources and XML evidence are in `review-probes/` and are excluded from the normal test source set.
- Lint: **zero errors, 25 warnings** on a separate forced run with `--max-workers=1`. `review-lint-log.txt`.
- The initial combined forced build hit an internal Kotlin FIR lint crash in test analysis. This did not reproduce in the separate serial lint run. Preserve `review-checks-log.txt` as tooling evidence; do not classify it as an app defect.
- No ADB device or emulator was connected. Audio decoding, foreground-service behavior on a phone, notification/headset controls, and visual rendering were not verified.
- The delivered source archive's production Kotlin files, manifest, and Gradle build files match the reviewed workspace versions.
- Delivered APK remains SHA-256 `a201679358471f0df3aaa67f3c904cdee94d9811a165b45095095f4391c254f1`.

## 1. [P1] A loading/error document cursor can wipe the cached library

Location: [AndroidDocuments.kt:41](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/library/AndroidDocuments.kt:41>), [LibraryDatabase.kt:22](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/library/LibraryDatabase.kt:22>).

`children()` checks only for a null cursor or a thrown exception. It ignores `DocumentsContract.EXTRA_LOADING` and `EXTRA_ERROR` in cursor extras. A provider can legitimately return an empty/partial cursor while loading, or supply an error through cursor extras. Lyra treats that cursor as a complete listing, returns a successful scan, and replaces the previous database contents with the partial result. This removes cached tracks and playlists and can also remove queue entries; music files themselves are not deleted.

Reproduction: both `loadingProviderReturnsSuccessfulEmptyScan` and `providerErrorReturnsSuccessfulEmptyScan` use the actual AndroidDocuments implementation with a registered Robolectric provider. Starting with a cached track, an empty cursor carrying either extra produces a successful zero-track scan. The ordinary DAO replacement then deletes the cached rows.

Fix: inspect cursor extras before accepting the listing. Preserve the existing snapshot on provider errors. For loading cursors, wait for a provider change notification and retry, or abort safely with an explicit incomplete-listing result. Never publish an incomplete directory as proof that files disappeared.

The Android [DocumentsContract reference](https://developer.android.com/reference/android/provider/DocumentsContract) documents both extras, including partial loading results and the provider's completion notification.

## 2. [P1] Queue reconciliation loses library updates that arrive during a scan

Location: [PlaybackService.kt:101](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/playback/PlaybackService.kt:101>).

The collector returns immediately if `progress.running` or `restoring` is true. It collects only the library snapshot, so changing either guard back to false never reprocesses the skipped snapshot. Room and DataStore updates can arrive before the scan's running flag clears, particularly during a tree switch. A deleted file or a previous tree's queue can remain selected indefinitely, even though the UI has the new library. Refreshing an identical snapshot need not emit a new StateFlow value, so another refresh is not a reliable recovery.

Reproduction: `scanCompletionDoesNotReprocessSnapshotSkippedDuringScan` runs the production service collector and a real ExoPlayer with controlled library state. It publishes a library without the queued track while scanning, then completes the scan. The deleted item remains queued. A control emission after completion clears it, proving the collector is running and the missing trigger is the defect.

Fix: combine the snapshot with explicit scan/restoration readiness, or send a successful-publication event after the complete commit. Reconcile the latest snapshot when readiness changes. Distinguish an unloaded cache from a successfully loaded empty library instead of relying on first-emission/folder-count heuristics.

## 3. [P2] “Play next” is unreliable with shuffle enabled

Location: [LyraViewModel.kt:99](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/ui/LyraViewModel.kt:99>).

`enqueue(next = true)` inserts at `currentMediaItemIndex + 1`. That is the original playlist index, while Media3 uses a separate shuffle traversal. DefaultShuffleOrder assigns inserted items a shuffled position; the requested track is not guaranteed to follow the current track. Queue move operations likewise change the displayed original order without ensuring the intended shuffled playback order.

Reproduction: the real Media3 probe starts at A with traversal A → C → B and applies Lyra's exact insertion operation. The requested next item is not next in **20 of 20 tested deterministic seeds**. This sample proves a counterexample; it is not a general probability estimate.

Fix: implement a service-side queue command that inserts the item and updates the shuffle traversal to put that queue occurrence immediately after the current occurrence. Preserve duplicate occurrences, rather than addressing them only by media ID. Define whether queue reordering edits playback order while shuffled and make the UI reflect that choice.

See Media3's [playlist and shuffle documentation](https://developer.android.com/media/media3/exoplayer/playlists).

## 4. [P2] Missing provider fingerprints make changed files look unchanged forever

Location: [LibraryModels.kt:40](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/library/LibraryModels.kt:40>), [AndroidDocuments.kt:52](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/library/AndroidDocuments.kt:52>).

`Track.matches()` considers null size equal to null size and null modification time equal to null modification time. A provider that exposes neither fingerprint will always reuse a successful track with the same name and document ID, even after its tags, duration, or content change. With unknown modification time and unchanged size, same-size edits have the same problem. Folder-cover cache keys also reuse the unknown fingerprint.

Reproduction: `unknownFingerprintReusesObsoleteMetadata` supplies a same-ID/name document with null size/time and a metadata reader that would return a new title. Refresh performs zero reads and retains the old title.

Fix: require a reliable known fingerprint for indefinite reuse. Re-read unknown fingerprints, provide a forced metadata refresh, or use a bounded revalidation policy. Apply the same policy to folder images.

Android explicitly permits unknown/null size and modification time in the [document column contract](https://developer.android.com/reference/android/provider/DocumentsContract.Document).

## 5. [P2] Playback metadata never refreshes if queue IDs stay the same

Location: [PlaybackService.kt:108](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/playback/PlaybackService.kt:108>).

The library collector updates MediaItems only when the list of IDs changes. A successful rescan can update a track's title, artist, cover, or fallback duration while preserving all queue IDs. The Library screen then displays new metadata, but Now Playing, the mini-player, notification, and system session retain the old MediaItem metadata until the queue is replaced or the service is restored.

Reproduction: `metadataRefreshWithSameQueueIdsLeavesPlaybackMetadataStale` runs the production collector with a real ExoPlayer. Updating a queued track from “Old title” to “New title” keeps “Old title” on the player's current MediaItem. A control removal triggers reconciliation successfully.

Fix: compare queued MediaItem metadata with the published tracks and replace/update changed items even when IDs are unchanged. Media3 supports metadata-only replacement without interrupting the current item when playback properties are unchanged.

## 6. [P2] A finished queue still shows Pause and takes an extra tap to restart

Location: [LyraViewModel.kt:55](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/ui/LyraViewModel.kt:55>), [LyraViewModel.kt:90](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/ui/LyraViewModel.kt:90>).

The UI models “playing” exclusively as `playWhenReady`. At the end of a repeat-off queue, playback can be `STATE_ENDED` while that user-intent flag remains true. The UI consequently shows Pause after the music ends. Its first tap calls `pause()` instead of restarting. A second tap sends Play and can restart through Media3's session handling. The stopped-looking session therefore requires an unexpected extra interaction.

Evidence: code review plus inspection of the project's actual Media3 1.11.1 bytecode. MediaSessionImpl handles a controller Play command using `Util.handlePlayButtonAction`, including seeking from `STATE_ENDED`. That avoids an unrecoverable restart bug, but Lyra's initial Pause command prevents the helper from running on the first tap. Evidence is preserved in `review-probes/media3-play-action-bytecode.txt` and `media3-session-play-bytecode.txt`. Actual end-of-file playback remains a phone check.

Fix: carry playback state in PlaybackUi and use Media3's `shouldShowPlayButton`/play-pause handling or equivalent state logic. Send Play immediately when playback is ended. Do not substitute `isPlaying` alone: buffering and transient audio-focus suppression also need appropriate user-intent controls. The [Player reference](https://developer.android.com/reference/androidx/media3/common/Player) distinguishes playback intent from actual state.

## 7. [P2] Swiping away an ended/error session can leave a non-foreground service running

Location: [PlaybackService.kt:175](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/playback/PlaybackService.kt:175>).

`onTaskRemoved()` stops the service only when `playWhenReady` is false. That flag can remain true for ended or stopped/error playback, and does not establish that foreground playback is ongoing. The override bypasses MediaSessionService's default check, leaving the service running in cases where Media3 requires it to terminate. The documented consequence is a system crash/restart of the service.

Evidence: code review and the [MediaSessionService.onTaskRemoved contract](https://developer.android.com/reference/androidx/media3/session/MediaSessionService#onTaskRemoved(android.content.Intent)). This OS effect was not reproduced on a device.

Fix: use the service's foreground/playback-ongoing status or delegate to the superclass's default behavior. Save first, and ensure bound controller lifetime allows the service to stop.

## 8. [P2] Removing another queued file rebuilds the currently playing source

Location: [PlaybackService.kt:114](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/playback/PlaybackService.kt:114>).

Whenever reconciliation removes any queue ID, the service replaces the entire playlist with freshly constructed MediaItems and calls `prepare()`. If the current file still exists and only a later queued file was deleted, it still discards/recreates the current media source. This introduces rebuffering and a potential audible interruption instead of preserving the active source. The phone checklist specifically expects retained current tracks to continue uninterrupted.

Evidence: code-level finding. The precise audible gap depends on storage and buffering and needs a phone measurement. Media3's [playlist modification API](https://developer.android.com/media/media3/exoplayer/playlists) supports removing non-current items while preserving current playback.

Fix: remove missing occurrences in descending queue-index order and preserve retained sources. Rebuild only when the current source truly needs replacement, and maintain shuffle traversal after the incremental edit.

## 9. [P2] Artwork storage and synchronization keys grow without a limit

Location: [AndroidDocuments.kt:69](<C:/Users/Nihil/Desktop/Github Repos/Lyra/android/app/src/main/java/com/lyra/sona/android/library/AndroidDocuments.kt:69>).

Artwork is stored in `filesDir/artwork`, outside Android's evictable cache directory. Every unique embedded image and each changed folder-image fingerprint gets permanent small/player files. Deleted tracks, removed covers, and old folder selections never remove those files. The synchronization map also retains every key for the life of the process. Repeated imports/cover changes accumulate app storage and memory until the app's data is cleared; low storage can then break image writes or scans.

Evidence: complete inspection of the artwork writer and all call sites; there is no garbage collection or capacity policy. Existing image tests verify dimensions, not accumulated storage. Long-term growth was not benchmarked.

Fix: add a size budget and cleanup that respects artwork still referenced by current/cached libraries and playback. Use an evictable cache with reconstruction, or maintain explicit references for a durable artwork store. Bound/remove synchronization entries without introducing concurrent writers for the same key.

## Additional concerns and test gaps

- **Controller recovery:** LyraViewModel constructs one MediaController future and implements no `onDisconnected` recovery. A service failure/disconnection can leave the existing screen with unusable controls until the ViewModel is recreated. Add lifecycle-aware reconnect behavior and test a service restart.
- **Selection retention:** successful folder switches keep old persisted URI grants and old trees' database rows indefinitely. Both observed Room queries select every tree, then filter in memory. Decide whether old trees are intentionally retained and add a cleanup/budget policy.
- **Notification settings:** the enabled flag is read once per composition; returning from system settings may leave the displayed permission state stale. Repeated permission denial also needs a system-settings recovery action instead of an ineffective request button.
- **Cancellation responsiveness:** SAF queries and artwork streams are blocking operations without a CancellationSignal, and cover reads do not check cancellation in their loop. Cancelling a scan protects publication, but a slow provider may continue occupying IO workers. Test a stalled provider separately from cooperative fake delays.
- **UI coverage:** existing Compose tests exercise onboarding only. There are no automated full-player/queue/search/navigation or font-scale checks. The 250 ms ViewModel poll continues while its Activity is stopped; measure background overhead and use lifecycle-aware UI polling if necessary.
- **Performance claims:** the synthetic 5,000-track benchmark is useful for orchestration and reuse, but does not establish phone SAF, decoder, Room, or Compose performance. The existing documentation correctly acknowledges this limitation.

## Recommended order

1. Make provider enumeration safe and scan/readiness publication explicit; add regression tests for partial/error cursors and the service race.
2. Implement shuffle-aware queue commands and incremental reconciliation; synchronize queued metadata.
3. Fix ended-state play controls and task-removal service shutdown.
4. Add cache/selection cleanup and controller recovery.
5. Verify on phones: normal audio, end-of-queue restart, shuffle Play next, delete/refresh during playback, tree switching during a scan, screen-off playback, interruption/headset controls, and service recreation. Include Android 8 and a current target-SDK device where available.

The app has good foundations: bounded metadata workers, transactional Room replacement, Media3-managed audio focus/noisy handling, no network permission, and a meaningful baseline suite. Those checks do not cover the state transitions responsible for the findings above.
