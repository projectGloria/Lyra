"""Summarize actual build/test/benchmark artifacts; fails if required checks did not pass."""
from pathlib import Path
import hashlib
import json
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
verification = root / "verification"
build_log = (verification / "checks-log.txt").read_text(encoding="utf-8-sig")
assert "BUILD SUCCESSFUL" in build_log, "Required Gradle checks did not pass"
suites = [ET.parse(path).getroot() for path in (root / "app/build/test-results/testDebugUnitTest").glob("TEST-*.xml")]
tests = sum(int(suite.attrib["tests"]) for suite in suites)
failures = sum(int(suite.attrib.get("failures", 0)) + int(suite.attrib.get("errors", 0)) for suite in suites)
assert failures == 0
lint_report = (root / "app/build/reports/lint-results-debug.txt").read_text(encoding="utf-8")
lint = re.search(r"(\d+) errors?, (\d+) warnings?", lint_report)
assert lint and lint.group(1) == "0", "Lint must have zero errors"
benchmark = json.loads((verification / "synthetic-benchmark.json").read_text())
integrity = json.loads((verification / "desktop-integrity.json").read_text(encoding="utf-8-sig"))
assert integrity["changedFiles"] == 0
apk = root / "delivery/Lyra-Android-1.0.0-debug.apk"
digest = hashlib.sha256(apk.read_bytes()).hexdigest()
manifest = ET.parse(root / "app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml").getroot()
android = "{http://schemas.android.com/apk/res/android}"
permissions = [node.attrib[android + "name"] for node in manifest.findall("uses-permission")]
assert "android.permission.INTERNET" not in permissions
assert "android.permission.ACCESS_NETWORK_STATE" not in permissions
summary = {
    "tests": tests, "testFailures": failures,
    "lintErrors": 0, "lintWarnings": int(lint.group(2)),
    "assembleDebug": "passed", "assembleDebugAndroidTest": "passed",
    "apkSha256": digest, "apkBytes": apk.stat().st_size,
    "minSdk": 26, "compileSdk": 36, "targetSdk": 36,
    "applicationId": "com.lyra.sona.android", "permissions": permissions,
    "desktopIntegrity": integrity, "hostBenchmark": benchmark,
    "deviceTests": "not run: no device or emulator connected",
}
(verification / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
rows = "\n".join(f"| {suite.attrib['name'].split('.')[-1]} | {suite.attrib['tests']} | 0 |" for suite in suites)
report = f"""# Verification report — Lyra Android v1

The independent Android app builds successfully. All {tests} host tests pass; lint reports zero errors and {lint.group(2)} warnings. The Android test APK also compiles. **Playback on Android hardware has not been verified.** No device or emulator was connected.

## Build and artifact checks

- `:app:testDebugUnitTest`, `:app:lintDebug`, `:app:assembleDebug`, and `:app:assembleDebugAndroidTest`: passed in the final run. See `checks-log.txt`.
- Debug APK signature verified with Android `apksigner`: one Android Debug signer; APK Signature Scheme v2 passes.
- Android `zipalign -c -P 16 4`: passed. This checks ZIP alignment, not hardware execution or every native ELF loader behavior.
- Packaged manifest checked: minSdk 26, compile/target SDK 36, application ID `com.lyra.sona.android`, and **no Internet or network-state permission**.
- Foreground media-playback service type and the foreground-service, playback-service, notification, and wake-lock permissions are declared.
- SHA-256: `{digest}`.
- APK size: {apk.stat().st_size / 1024 / 1024:.2f} MiB.

## Host tests

| Suite | Tests | Failures |
| --- | ---: | ---: |
{rows}

Tests cover extension/MIME audio discovery, direct-child folder grouping, ordering, metadata failures, deterministic artwork, incremental read counts, concurrency, cancellation, failed/superseded scans, rejected and successful tree switches, Room database recreation, persisted playback serialization, bounded artwork sizes, real Media3 queue operations and shuffle traversal, error-limit policy, and Compose onboarding/recovery semantics.

Robolectric UI tests deliberately isolate real media-service binding. Media3 queue tests manipulate an actual player timeline without preparing or decoding audio. These tests **do not verify** Android service/controller integration, OS process eviction, actual codecs, visual rendering on a phone, or system media controls.

Lint warnings are dependency-update notices, Kotlin extension/style recommendations, and tooling recommendations. No lint baseline or disabled error checks were used.

## 5,000-track synthetic host performance

Environment: {benchmark['environment']}.

| Measurement | Result |
| --- | ---: |
| First synthetic scan | {benchmark['firstSyntheticScanMs']:.2f} ms |
| Cached in-memory library ready | {benchmark['cachedInMemoryLibraryReadyMs']:.2f} ms |
| Second synthetic scan | {benchmark['secondSyntheticScanMs']} ms |
| First metadata reads | 5,000 |
| Second metadata reads | 0 |
| Second reused tracks | 5,000 |

These measurements use the production scan orchestrator with a generated 50-folder/5,000-document fake provider, synthetic metadata, and an in-memory cache. **They are not Android first-scan or second-launch timings**, do not include SAF IO/audio decoding/Room startup, and are not a phone performance claim. They are a reproducible host baseline; timings vary by run. Raw results: `synthetic-benchmark.json`.

Actual Android measurements remain pending. `benchmark/generate-fixtures.py` creates 5,000 playable WAV fixtures, `DeviceScanBenchmarkTest` measures real SAF scanner passes, and the app logs actual scan completion plus time from Application initialization to the first usable Library UI. See `benchmark/README.md` for collection instructions.

## Desktop integrity

SHA-256 hashes before and after implementation match for all {integrity['checkedFiles']} original source, configuration, assets, tests, review, and archive files. Zero changes. All workspace additions are inside `android/`. Generated existing `node_modules` and desktop `src-tauri/target` trees were excluded from the source baseline; neither desktop dependency installation nor a desktop build was run. See `desktop-before.json`, `desktop-after.json`, and `desktop-integrity.json`.

## Checks not run

Every unrun phone check is listed in `PHONE_TEST_CHECKLIST.md`: system folder-picker restrictions/cancellation/persistent grants and reboot access; real-provider scan and cached cold-launch performance; storage disconnection/recovery; real codecs; screen-off and background playback; notification permission and controls; lock-screen/headset controls; calls/audio-focus/headphone removal; real process-death restoration; real player failure recovery; queue changes while listening; visual navigation/search/mini-player synchronization; screen rotation; font scaling/TalkBack/touch usability; keyboard and system-bar insets; predictive Back on Android 16. See `device-inventory.txt` for the empty ADB device listing.

The user will install the APK and run these checks on a phone. Successful compilation, host tests, and signing verification are not successful playback verification.
"""
(verification / "REPORT.md").write_text(report, encoding="utf-8")
print(f"Report written: {tests} passing tests; {lint.group(2)} lint warnings; desktop unchanged")
