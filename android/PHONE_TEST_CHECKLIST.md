# Android phone checks — not yet run

No Android device or emulator was connected during implementation. These checks require your phone; none is established by APK assembly or host tests.

- [ ] Install and launch the debug APK on Android 8+; repeat on Android 13/14/16 where available.
- [ ] First-run hint is visible before the folder picker. Verify disabled root/Download selection on Android 11+, then select Music or an allowed subfolder.
- [ ] Cancel the picker: onboarding guidance or the previous library stays visible.
- [ ] Reject/lose a grant: clear error and Choose another folder action; previous cached library remains.
- [ ] Persistent folder access works after app restart and phone reboot.
- [ ] Internal storage and removable SD-card folders work. Remove/reconnect storage and check recovery messages.
- [ ] Generic-MIME and uppercase-extension audio files appear; corrupt candidates remain visible with metadata fallbacks.
- [ ] Root tracks appear only in Liked Songs; nested folders contain only their direct tracks.
- [ ] Track-number ordering, natural sorting, search, and embedded/folder/album artwork look correct.
- [ ] First scan and cached second launch with 5,000 real/generated tracks: follow benchmark/README.md and record both numbers.
- [ ] Add/change/delete files, refresh, and confirm unchanged metadata is reused; cancel/supersede a scan and verify the existing library survives.
- [ ] Play representative MP3, FLAC, AAC/M4A, WAV, Ogg/Vorbis, and Opus files. Try supported files with missing/bad metadata.
- [ ] Play/pause, previous/next, seek, repeat off/all/one, shuffle, play-next, add, remove, reorder, and duplicate queue items work.
- [ ] A corrupt track is skipped with its cause; five consecutive failures stop playback, and an entirely unplayable queue stops sooner.
- [ ] Background playback continues with the screen off, another app in front, and Lyra swiped out of Recents while playing.
- [ ] Lock-screen, notification, wired/Bluetooth headset controls work and show current metadata/artwork.
- [ ] Grant/deny/dismiss notification permission on Android 13+; playback is never blocked.
- [ ] Incoming calls/other audio correctly interrupt playback; disconnecting headphones pauses it. Check system volume controls.
- [ ] Force-stop/reopen and OS process eviction restore queue/current track/checkpoint position/shuffle order/repeat, initially paused. Force-stop is a cold-start approximation; also test actual OS eviction.
- [ ] Removing the current/queued file during refresh reconciles the queue; retained current tracks continue without interruption.
- [ ] Navigation, Android Back/predictive Back, search keyboard, and mini-player synchronization work.
- [ ] Rotate during playback/search/queue use; playback continues and screen state remains sensible.
- [ ] Small/large displays, large font scaling, TalkBack labels, 48dp touch controls, and long titles are usable.
- [ ] Fullscreen hides status/navigation bars (both gesture and three-button navigation); edge swipes reveal temporary controls. Return from picker, Settings, lock screen, dialogs, and rotation: fullscreen is restored. Keyboard/cutout insets remain usable.
- [ ] Inspect app permissions: no Internet or broad storage permission; music files are unchanged.

## Report results

Version 1.0.3 checks:

- [ ] Update over 1.0.2 without losing the selected folder, tracks, or restored playback. Allow the one-time artwork rescan to finish.
- [ ] Verify embedded front covers in MP3/FLAC/M4A/Ogg/Opus, track rows, mini-player, Now Playing, and folder thumbnails. Folder cover images fill missing track art; corrupt cover.jpg falls back to another readable image.
- [ ] Seek forward and backward repeatedly on internal storage and SD cards, paused and playing; confirm the position responds and audio resumes promptly. Record any slow files/providers and format.
- [ ] Playing a playlist shows no queue button. Add duplicates with Play next/Add to queue: only explicit pending additions appear, in shuffle traversal order. Starting an addition removes it from the pending queue; consuming/removing the last addition hides queue information.
- [ ] Reorder/remove manual additions and restart the app; duplicate occurrences and explicit queue flags survive. Old saved playlist sessions restore without an explicit queue.
- [ ] No volume-button hint is visible in Now Playing.

Version 1.0.2 playback fix to check on a phone:

- Install the update over 1.0.1; verify the selected folder and library are retained.
- Tap a track after a cold launch. Verify audible playback and advancing progress.
- Pause/resume, select another track, seek, and use Play next/Add to queue.
- Background the app, use notification controls, then reopen it and select another song.

Version 1.0.1 regressions also to check on a phone:

- [ ] With shuffle on, Play next immediately follows the current track; duplicate occurrences, Add to queue, and Move up/down follow the displayed playback order.
- [ ] Delete another queued file and refresh while listening: the retained current track continues without restarting or losing position. Updated titles/covers appear in Now Playing and system controls.
- [ ] Switch folders or finish a refresh while the playback service restores: the queue reconciles to the completed selected library.
- [ ] Finish a repeat-off queue: Play appears and restarts on the first tap. Swipe away ended/failed/paused playback and verify the service stops; playing audio survives swiping away.
- [ ] Return from notification settings: permission status updates. After repeated denial, Open notification settings remains usable.
- [ ] Switch folders repeatedly: unused storage grants and old library caches are removed. Cancelling before publication preserves the selected library and its grant.
- [ ] A temporarily loading/error provider preserves cached tracks; refresh after it becomes ready. Cancel a slow provider scan and verify recovery remains responsive.
- [ ] After an OS service restart, the visible UI reconnects; background audio and rotation continue to work.

Record phone model, Android version, storage provider, tested audio formats, first-scan ms, cached cold-launch ms, and any failed checks. Attach `adb logcat -s LyraPerformance LyraDeviceBenchmark` output for timings if possible.
