"""Record checked version 1.0.1 results and a source diff against the delivered 1.0.0 archive."""
from pathlib import Path
from zipfile import ZipFile
import difflib
import hashlib
import json
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
verification = root / "verification"
version = re.search(r'versionName\s*=\s*"([^"]+)"', (root / "app/build.gradle.kts").read_text()).group(1)
log = (verification / "fixes-checks-log.txt").read_text(encoding="utf-8-sig")
assert "BUILD SUCCESSFUL" in log, "Final Gradle checks have not passed"
suites = [ET.parse(path).getroot() for path in sorted((root / "app/build/test-results/testDebugUnitTest").glob("TEST-*.xml"))]
assert suites and all(int(s.attrib["failures"]) == 0 and int(s.attrib["errors"]) == 0 for s in suites)
tests = sum(int(s.attrib["tests"]) for s in suites)
lint = re.search(r"(\d+) errors, (\d+) warnings", (root / "app/build/reports/lint-results-debug.txt").read_text())
assert lint and int(lint.group(1)) == 0
apk = root / "delivery" / f"Lyra-Android-{version}-debug.apk"
digest = hashlib.sha256(apk.read_bytes()).hexdigest()
summary = {
    "version": version, "versionCode": 2, "tests": tests, "testFailures": 0,
    "lintErrors": 0, "lintWarnings": int(lint.group(2)), "apkSha256": digest, "apkBytes": apk.stat().st_size,
    "deviceTests": "Not run: no connected phone or emulator", "fixedReviewFindings": 9,
    "suites": [{"name": s.attrib["name"], "tests": int(s.attrib["tests"])} for s in suites],
}
(verification / "fixes-summary.json").write_text(json.dumps(summary, indent=2) + "\n")

patch = []
changed = []
with ZipFile(root / "delivery/Lyra-Android-1.0.0-source.zip") as baseline:
    baseline_names = set(baseline.namelist())
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if not path.is_file() or not (relative.startswith("app/src/") or relative in {"app/build.gradle.kts", "README.md", "PHONE_TEST_CHECKLIST.md", "verification/package-source.py"}):
            continue
        archive_name = "Lyra-Android/" + relative
        try:
            old = baseline.read(archive_name).decode("utf-8-sig") if archive_name in baseline_names else ""
            new = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            continue
        if old != new:
            changed.append(relative)
            patch.extend(difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True), fromfile="1.0.0/" + relative, tofile=version + "/" + relative))
(verification / "fixes-source-diff.patch").write_text("".join(patch), encoding="utf-8")
rows = "\n".join(f"| {s.attrib['name'].split('.')[-1]} | {s.attrib['tests']} | 0 |" for s in suites)
report = f"""# Android fixes — version {version}, 4 October 2026

All nine findings from ANDROID_REVIEW_2026-10-04.md have implementation fixes. The Android app is version {version}, version code 2. Desktop files remain unchanged. Earlier 1.0.0 delivery artifacts are retained; install `delivery/Lyra-Android-{version}-debug.apk` for these changes.

## Fixes and evidence

| Finding | Implemented change | Regression evidence |
| --- | --- | --- |
| P1 incomplete/error provider listings | Reject loading/error cursor extras before accepting enumeration; abort instead of replacing the cached library | ProviderRegressionTest + existing repository failure tests |
| P1 missed library reconciliation | Transactional table reads, explicit loaded state, and combined scan/restoration readiness reprocess the latest snapshot | PlaybackServiceRegressionTest.scanCompletionReprocessesLatestSnapshotWithoutAnotherLibraryEmission |
| Shuffle Play next | Service-side insertion explicitly updates occurrence indices in shuffle traversal; append and move follow displayed playback order | ProviderRegressionTest across 20 shuffle seeds; Media3QueueTest; service command authorization/dispatch test |
| Missing fingerprints | Require known size and positive modification time for reuse; unknown folder images use content-based cache keys | LibraryTest; ProviderRegressionTest metadata and red/blue provider cover replacement |
| Stale playback metadata | Replace metadata on retained queue occurrences, including duration/artwork extras | PlaybackServiceRegressionTest; Media3QueueTest |
| Finished queue button | Media3 state-aware Play/Pause rendering and actions | PlayerControlsTest uses a real local MediaController/MediaSession transport with deterministic ended state; first tap seeks to restart |
| Task-removal shutdown | Delegate ongoing foreground/session checks to MediaSessionService | PlaybackServiceRegressionTest stops a non-foreground session despite true play intent |
| Queue refresh interrupts retained source | Remove missing occurrences incrementally; preserve retained source configuration on metadata updates | Real Media3 tests preserve current period UID, position, shuffle traversal, and duplicates |
| Unbounded artwork | 64 MiB eviction budget, current/just-written image protection, orphan collection, and one bounded synchronization lock | AndroidPersistenceTest budget, current-cover retention, and orphan removal |

Additional improvements: visible UI controllers reconnect with bounded delays after disconnection, Activity stop releases controllers and stops position polling, successful selections discard other trees and release old URI grants, cancellation during selection publication preserves the committed grant, provider queries use CancellationSignal, cover reads close streams on cancellation, and notification settings refresh on resume with an explicit system-settings action. ProviderRegressionTest verifies cancellation reaches a stalled provider.

Artwork budget excludes the currently playing cover and the pair being written, so a small temporary/protected overage is intentional. Referenced non-current artwork can be evicted to keep storage bounded and regenerated on refresh. No music files are written or deleted. Room tables are unchanged, so upgrading needs no destructive database migration.

## Validation

- `{tests}` host tests passed, zero failures/errors.
- Lint: zero errors, `{lint.group(2)}` warnings. No lint baseline or suppressed errors.
- `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest --max-workers=1`: passed. Full log: `fixes-checks-log.txt`.
- APK signature and alignment checked: see `fixes-apk-signature.txt` and `fixes-apk-alignment.txt`.
- Delivered APK SHA-256: `{digest}`; size {apk.stat().st_size / 1024 / 1024:.2f} MiB.
- Debug signature remains compatible with the earlier APK for an in-place update.
- Desktop integrity: `desktop-integrity.json` verifies the 47 original files.
- Source diff against the delivered 1.0.0 archive: `fixes-source-diff.patch`; {len(changed)} changed/new text files in its selected production/test/build/documentation scope.

| Suite | Tests | Failures |
| --- | ---: | ---: |
{rows}

No phone or emulator was connected. These tests exercise actual provider IO, Media3 timelines and service code, plus local controller/session transport; they do not establish audio decoding, audible continuity, OS process eviction, notification/headset behavior, or visual rendering on a phone. Follow the version 1.0.1 regressions in PHONE_TEST_CHECKLIST.md for those checks. Historical review probes remain outside the test source set and assert old bugs; current regression tests assert the corrected behavior.
"""
(verification / "FIXES_2026-10-04.md").write_text(report, encoding="utf-8")
print(f"Recorded version {version}: {tests} passing tests, {lint.group(2)} lint warnings, {len(changed)} changed/new text files")
