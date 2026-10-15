# Playback regression — version 1.0.2

The version 1.0.1 connection callback copied `super.onConnect(...).availablePlayerCommands`. With the pinned Media3 1.11.1 runtime, that synchronous default returns an internal sentinel with empty player/session command sets. The app connected and received readiness, but could not set a playlist, prepare, play, pause, or seek. The previous tests used a separate session without the production connection callback and did not catch this integration failure.

The service now overrides `onConnectAsync`, authenticates the controller, explicitly grants Media3's default player/session commands to the app and trusted controllers, and adds the app's queue commands. Other controllers remain rejected. No library reset, permission reset, or data migration is required.

Reference: [Media3 connection callback documentation](https://developer.android.com/reference/androidx/media3/session/MediaSession.Callback). The exact empty sentinel behavior was also verified in the locally resolved 1.11.1 runtime bytecode.

`PlaybackServiceRegressionTest.appCanStartASongThroughTheProductionServiceConnection` connects a real MediaController to the production service session and callback. It waits for restoration readiness, asserts playlist/prepare/play/seek and custom queue commands, invokes `LyraViewModel.play`, and checks that the real service ExoPlayer receives the track ID, URI and play intent. The test failed before the fix with `App must receive player command 20` and passes after it. It exercises the session transport; it does not decode audio or verify audible output.

- Before-fix evidence: `playback-regression-before.txt` and `playback-regression-before.xml`.
- Focused after-fix evidence: `playback-regression-after.txt`.
- Full build/test/lint evidence: `playback-fix-checks-log.txt`.
- Machine-readable check summary: `playback-fix-summary.json`.
- Installation artifact: `../delivery/Lyra-Android-1.0.2-debug.apk`.

Validation completed: 46 host tests passed, zero lint errors (26 warnings), debug application and instrumentation APKs built successfully, APK signature and alignment passed, and the signer matches 1.0.1. The 47 original desktop files remain unchanged.

No device or emulator was connected. Audible playback, phone audio focus, and background notification behavior remain device checks listed in `../PHONE_TEST_CHECKLIST.md`.
