"""Capture the completed hotfix checks and diff against the previously delivered source."""
from pathlib import Path
from zipfile import ZipFile
import difflib
import hashlib
import json
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
verification = root / "verification"
assert "BUILD SUCCESSFUL" in (verification / "playback-fix-checks-log.txt").read_text(encoding="utf-8-sig")
results = [ET.parse(p).getroot() for p in (root / "app/build/test-results/testDebugUnitTest").glob("TEST-*.xml")]
totals = {key: sum(int(r.get(key, 0)) for r in results) for key in ("tests", "failures", "errors", "skipped")}
assert results and totals["failures"] == totals["errors"] == totals["skipped"] == 0
lint = ET.parse(root / "app/build/reports/lint-results-debug.xml").getroot()
errors = sum(i.get("severity") in {"Error", "Fatal"} for i in lint.findall("issue"))
assert errors == 0
build = (root / "app/build.gradle.kts").read_text()
version = re.search(r'versionName\s*=\s*"([^"]+)"', build).group(1)
code = int(re.search(r'versionCode\s*=\s*(\d+)', build).group(1))
apk = root / "delivery" / f"Lyra-Android-{version}-debug.apk"
signature = (verification / "playback-fix-apk-signature.txt").read_text(encoding="utf-8-sig")
previous_signature = (verification / "fixes-apk-signature.txt").read_text(encoding="utf-8-sig")
certificate = re.search(r"certificate SHA-256 digest: (\w+)", signature).group(1)
assert certificate == re.search(r"certificate SHA-256 digest: (\w+)", previous_signature).group(1)
assert "Verified using v2 scheme (APK Signature Scheme v2): true" in signature
assert "Verification successful" in (verification / "playback-fix-apk-alignment.txt").read_text(encoding="utf-8-sig")
integrity = json.loads((verification / "desktop-integrity.json").read_text(encoding="utf-8-sig"))
assert integrity["changedFiles"] == 0
summary = {
    "versionName": version, "versionCode": code, "checks": totals, "lintErrors": errors,
    "lintWarnings": sum(i.get("severity") == "Warning" for i in lint.findall("issue")),
    "build": "successful", "productionControllerRegression": "failed before fix; passed after fix",
    "apk": {"file": apk.name, "bytes": apk.stat().st_size, "sha256": hashlib.sha256(apk.read_bytes()).hexdigest()},
    "signerSha256": certificate, "sameSignerAsPreviousBuild": True, "alignment": "passed",
    "desktop": integrity, "deviceTestsRun": False, "audiblePlaybackVerified": False,
    "testSuites": [{"name": r.get("name"), "tests": int(r.get("tests")), "failures": int(r.get("failures"))} for r in results],
}
(verification / "playback-fix-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
paths = ["app/build.gradle.kts", "app/src/main/java/com/lyra/sona/android/playback/PlaybackService.kt",
         "app/src/test/java/com/lyra/sona/android/PlaybackServiceRegressionTest.kt", "README.md", "PHONE_TEST_CHECKLIST.md"]
with ZipFile(root / "delivery/Lyra-Android-1.0.1-source.zip") as previous:
    diff = []
    for path in paths:
        before = previous.read("Lyra-Android/" + path).decode("utf-8-sig").splitlines(keepends=True)
        after = (root / path).read_text(encoding="utf-8-sig").splitlines(keepends=True)
        diff.extend(difflib.unified_diff(before, after, fromfile="1.0.1/" + path, tofile="1.0.2/" + path))
(verification / "playback-fix-source-diff.patch").write_text("".join(diff), encoding="utf-8")
print(json.dumps(summary, indent=2))
