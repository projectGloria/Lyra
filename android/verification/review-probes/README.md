# Review reproductions

These probes assert observed buggy behavior from the 4 October 2026 review. A green result confirms the reproduction; it does not mean the app is fixed. They are stored outside the Gradle test source set so that the normal suite remains unchanged.

These are historical version 1.0.0 probes. They are expected to fail against version 1.0.1, and the service field representation has changed. Current regression tests asserting correct behavior live in `app/src/test/java/com/lyra/sona/android/`, including ProviderRegressionTest, PlaybackServiceRegressionTest, and PlayerControlsTest. Do not copy these historical probes over those tests.

`ReviewEdgeCasesTest.kt` covers actual Media3 shuffle insertion, unknown metadata fingerprints, and actual AndroidDocuments queries against loading/error cursors. `ReviewServiceTest.kt` uses the production PlaybackService collector and a real ExoPlayer with injected controlled repository state. Its control assertions prove that subsequent eligible emissions reach reconciliation. None of these tests decodes audio or establishes OS foreground-service correctness.

To reproduce against a restored version 1.0.0 source checkout, temporarily copy the two Kotlin files into `app/src/test/java/com/lyra/sona/android/`, then run:

```powershell
.\gradlew.bat :app:testDebugUnitTest --tests '*ReviewEdgeCasesTest' --tests '*ReviewServiceTest' --max-workers=1
```

Remove only those two temporary test copies afterward. Keep the originals in this directory. XML outputs preserve the executed reproductions. After fixes, turn these into normal regression tests asserting the corrected behavior.
