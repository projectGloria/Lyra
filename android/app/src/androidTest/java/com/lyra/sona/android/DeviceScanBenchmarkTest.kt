package com.lyra.sona.android

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lyra.sona.android.library.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Requires the user-selected 5,000-track fixture tree. Does not claim to measure UI launch. */
@RunWith(AndroidJUnit4::class)
class DeviceScanBenchmarkTest {
    @Test fun firstAndIncrementalScanOnSelectedFixtureTree() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<LyraApplication>()
        val tree = app.preferences.tree.first()
        assertTrue("Select Music/LyraBenchmark in Lyra before running this test", tree.isNotEmpty())
        app.documents.validate(tree)
        val engine = ScanEngine(app.documents, AndroidMetadata(app, app.artwork))
        val first = engine.scan(tree, emptyList())
        assertEquals("Use the generated 5,000-track fixture folder", 5000, first.snapshot.tracks.size)
        val second = engine.scan(tree, first.snapshot.tracks)
        assertEquals(0, second.metrics.metadataReads)
        android.util.Log.i("LyraDeviceBenchmark", "firstScanMs=${first.metrics.elapsedMs}; secondScanMs=${second.metrics.elapsedMs}; reused=${second.metrics.reused}")
        app.database.library().replace(tree, first.snapshot)
        // Second cold-launch timing is recorded by PerformanceRecorder when the Library UI becomes usable.
    }
}
