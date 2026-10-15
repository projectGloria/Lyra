"""Generate 5,000 short playable WAV files; only writes inside android/benchmark/fixtures."""
from pathlib import Path
import math
import struct
import wave

destination = Path(__file__).resolve().parent / "fixtures" / "LyraBenchmark"
samples = b"".join(struct.pack("<h", int(math.sin(2 * math.pi * 440 * n / 8000) * 2000)) for n in range(2000))
for folder in range(1, 51):
    directory = destination / f"Playlist{folder}"
    directory.mkdir(parents=True, exist_ok=True)
    for number in range(1, 101):
        with wave.open(str(directory / f"Track{number}.WAV"), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(8000)
            output.writeframes(samples)
print(f"Generated 5,000 WAV files in {destination}")
