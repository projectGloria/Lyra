package com.lyra.sona.android

import com.lyra.sona.android.library.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Host JVM only: exercises the real orchestration with synthetic provider and metadata. */
class SyntheticBenchmarkTest {
    @Test fun fiveThousandTrackHostBaseline() = runBlocking {
        val root = (1..50).map { DocumentEntry("folder$it", "Playlist$it", DIRECTORY_MIME, null, null) }
        val folders = buildMap {
            put("root", root)
            for (folder in 1..50) put("folder$folder", (1..100).map { audio("$folder-$it", "Track$it.MP3", mime = "application/octet-stream") })
        }
        val documents = FakeDocuments(folders)
        var reads = 0
        val engine = ScanEngine(documents, MetadataSource { tree, folder, entry, _ -> reads++; track(entry, tree, folder).copy(trackNumber = entry.name.removePrefix("Track").substringBefore('.').toInt()) })
        val started = System.nanoTime()
        val first = engine.scan("synthetic-tree", emptyList())
        val firstMs = (System.nanoTime() - started) / 1_000_000.0
        val persisted = first.snapshot.tracks.associateBy { it.id }
        val cacheStart = System.nanoTime()
        val usable = LibrarySnapshot(persisted.values.toList().sortedWith(trackComparator), first.snapshot.folders)
        val cachedMs = (System.nanoTime() - cacheStart) / 1_000_000.0
        val second = engine.scan("synthetic-tree", first.snapshot.tracks)
        assertEquals(5000, usable.tracks.size); assertEquals(5000, first.metrics.metadataReads)
        assertEquals(0, second.metrics.metadataReads); assertEquals(5000, second.metrics.reused)
        assertEquals(5000, reads)
        val report = """
            {
              "environment": "Host JVM ${System.getProperty("java.version")} / ${System.getProperty("os.name")} ${System.getProperty("os.arch")}",
              "kind": "synthetic-host-only",
              "tracks": 5000,
              "firstSyntheticScanMs": $firstMs,
              "cachedInMemoryLibraryReadyMs": $cachedMs,
              "secondSyntheticScanMs": ${second.metrics.elapsedMs},
              "firstMetadataReads": 5000,
              "secondMetadataReads": 0,
              "secondReused": 5000,
              "limitations": "Fake document provider and metadata; in-memory cache reconstruction. Not SAF IO, audio decoding, Room startup, Android launch, or phone performance."
            }
        """.trimIndent()
        val output = File("../verification/synthetic-benchmark.json")
        output.parentFile?.mkdirs(); output.writeText(report)
        println("LYRA_HOST_BENCHMARK $report")
    }
}
