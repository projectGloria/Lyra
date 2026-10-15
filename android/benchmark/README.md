# Measuring on Android — requires a connected phone

Host benchmark results are synthetic and are reported separately. This procedure measures real Android SAF scanning and actual cached UI launch. It does not install an emulator.

1. From `android/`, run `python benchmark/generate-fixtures.py`. It creates 50 folders with 100 playable short WAV files each (5,000 total, about 20 MB).
2. Install the APK on your phone. With ADB enabled, run:

   ```powershell
   adb shell mkdir -p /sdcard/Music
   adb push benchmark/fixtures/LyraBenchmark /sdcard/Music/
   adb logcat -c
   ```

3. In Lyra, choose `Music/LyraBenchmark`. Do not select the storage root. Wait until the scan completes. **Settings → Last scan** gives actual first-scan elapsed time, metadata reads, and reused tracks. The first fixture scan should show 5,000 reads.
4. Run `adb shell am force-stop com.lyra.sona.android`, then `adb shell am start -n com.lyra.sona.android/.MainActivity`. The cache is retained. The Library UI logs `first_usable_library` when cached tracks become visible; its `elapsedMs` is measured from Application initialization to that UI effect. It excludes time before Application initialization and is not a full Android process-start benchmark. A background refresh proceeds independently.
5. Export the events:

   ```powershell
   adb logcat -d -s LyraPerformance LyraDeviceBenchmark
   adb shell run-as com.lyra.sona.android cat files/performance-events.jsonl
   ```

6. Record phone model, Android version, provider/storage type, actual first scan, cached second launch, and the refresh's metadata-read count. Repeated unchanged scans should read zero metadata, unless the provider/decoder leaves files in a failed state.

For an instrumented first/incremental scanner check, with the fixture tree already selected:

```powershell
.\gradlew.bat :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.lyra.sona.android.DeviceScanBenchmarkTest
```

This uses real SAF and Android metadata readers. It records scanner timings and verifies a zero-read second scan, but **does not measure UI launch**; use steps 4–5 for that. Real playback, system media controls, and OS interruptions require the separate phone checklist.
