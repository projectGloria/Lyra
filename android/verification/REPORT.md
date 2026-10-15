# Verification report — Lyra Android v1

The independent Android app builds successfully. All 29 host tests pass; lint reports zero errors and 25 warnings. The Android test APK also compiles. **Playback on Android hardware has not been verified.** No device or emulator was connected.

## Build and artifact checks

- `:app:testDebugUnitTest`, `:app:lintDebug`, `:app:assembleDebug`, and `:app:assembleDebugAndroidTest`: passed in the final run. See `checks-log.txt`.
- Debug APK signature verified with Android `apksigner`: one Android Debug signer; APK Signature Scheme v2 passes.
- Android `zipalign -c -P 16 4`: passed. This checks ZIP alignment, not hardware execution or every native ELF loader behavior.
- Packaged manifest checked: minSdk 26, compile/target SDK 36, application ID `com.lyra.sona.android`, and **no Internet or network-state permission**.
- Foreground media-playback service type and the foreground-service, playback-service, notification, and wake-lock permissions are declared.
- SHA-256: `a201679358471f0df3aaa67f3c904cdee94d9811a165b45095095f4391c254f1`.
- APK size: 25.59 MiB.

## Host tests

| Suite | Tests | Failures |
| --- | ---: | ---: |
| AndroidPersistenceTest | 3 | 0 |
| LibraryTest | 9 | 0 |
| Media3QueueTest | 2 | 0 |
| OnboardingUiTest | 2 | 0 |
| PlaybackPolicyTest | 6 | 0 |
| RepositoryTest | 6 | 0 |
| SyntheticBenchmarkTest | 1 | 0 |

Tests cover extension/MIME audio discovery, direct-child folder grouping, ordering, metadata failures, deterministic artwork, incremental read counts, concurrency, cancellation, failed/superseded scans, rejected and successful tree switches, Room database recreation, persisted playback serialization, bounded artwork sizes, real Media3 queue operations and shuffle traversal, error-limit policy, and Compose onboarding/recovery semantics.

Robolectric UI tests deliberately isolate real media-service binding. Media3 queue tests manipulate an actual player timeline without preparing or decoding audio. These tests **do not verify** Android service/controller integration, OS process eviction, actual codecs, visual rendering on a phone, or system media controls.

Lint warnings are dependency-update notices, Kotlin extension/style recommendations, and tooling recommendations. No lint baseline or disabled error checks were used.

## 5,000-track synthetic host performance

Environment: Host JVM 21.0.12.1 / Windows 11 amd64.

| Measurement | Result |
| --- | ---: |
| First synthetic scan | 640.06 ms |
| Cached in-memory library ready | 2.88 ms |
| Second synthetic scan | 119 ms |
| First metadata reads | 5,000 |
| Second metadata reads | 0 |
| Second reused tracks | 5,000 |

These measurements use the production scan orchestrator with a generated 50-folder/5,000-document fake provider, synthetic metadata, and an in-memory cache. **They are not Android first-scan or second-launch timings**, do not include SAF IO/audio decoding/Room startup, and are not a phone performance claim. They are a reproducible host baseline; timings vary by run. Raw results: `synthetic-benchmark.json`.

Actual Android measurements remain pending. `benchmark/generate-fixtures.py` creates 5,000 playable WAV fixtures, `DeviceScanBenchmarkTest` measures real SAF scanner passes, and the app logs actual scan completion plus time from Application initialization to the first usable Library UI. See `benchmark/README.md` for collection instructions.

## Desktop integrity

SHA-256 hashes before and after implementation match for all 47 original source, configuration, assets, tests, review, and archive files. Zero changes. All workspace additions are inside `android/`. Generated existing `node_modules` and desktop `src-tauri/target` trees were excluded from the source baseline; neither desktop dependency installation nor a desktop build was run. See `desktop-before.json`, `desktop-after.json`, and `desktop-integrity.json`.

## Checks not run

Every unrun phone check is listed in `PHONE_TEST_CHECKLIST.md`: system folder-picker restrictions/cancellation/persistent grants and reboot access; real-provider scan and cached cold-launch performance; storage disconnection/recovery; real codecs; screen-off and background playback; notification permission and controls; lock-screen/headset controls; calls/audio-focus/headphone removal; real process-death restoration; real player failure recovery; queue changes while listening; visual navigation/search/mini-player synchronization; screen rotation; font scaling/TalkBack/touch usability; keyboard and system-bar insets; predictive Back on Android 16. See `device-inventory.txt` for the empty ADB device listing.

The user will install the APK and run these checks on a phone. Successful compilation, host tests, and signing verification are not successful playback verification.
