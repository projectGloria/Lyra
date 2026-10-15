"""Package the independent Android source without local SDK paths, caches, fixtures or keys."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import re

root = Path(__file__).resolve().parents[1]
version = re.search(r'versionName\s*=\s*"([^"]+)"', (root / "app/build.gradle.kts").read_text()).group(1)
destination = root / "delivery" / f"Lyra-Android-{version}-source.zip"
destination.parent.mkdir(exist_ok=True)
excluded_directories = {".gradle", ".kotlin", "build", "delivery", "fixtures", "__pycache__"}
with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if not path.is_file() or any(part in excluded_directories for part in relative.parts):
            continue
        if path.name == "local.properties" or path.suffix in {".jks", ".keystore"}:
            continue
        archive.write(path, "Lyra-Android/" + relative.as_posix())
print(destination)
