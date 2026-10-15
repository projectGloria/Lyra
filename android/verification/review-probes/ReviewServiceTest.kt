package com.lyra.sona.android

import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import com.lyra.sona.android.library.*
import com.lyra.sona.android.playback.PlaybackService
import com.lyra.sona.android.playback.mediaItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Uses the production service collector and a real ExoPlayer; does not decode audio. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = LyraApplication::class)
@OptIn(ExperimentalCoroutinesApi::class)
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class ReviewServiceTest {
    private fun field(target: Any, name: String, value: Any) {
        target.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(target, value)
    }
    private fun player(service: PlaybackService) = service.javaClass.getDeclaredField("player").apply { isAccessible = true }.get(service) as ExoPlayer

    @Test fun scanCompletionDoesNotReprocessSnapshotSkippedDuringScan() = runTest {
        Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
        val app = ApplicationProvider.getApplicationContext<LyraApplication>()
        val source = FakeDocuments(emptyMap())
        val repository = LibraryRepository(MemoryDao(), MemoryPreferences(), source,
            ScanEngine(source, MetadataSource { _, _, _, _ -> error("unused") }), backgroundScope)
        val state = MutableStateFlow(LibrarySnapshot())
        field(repository, "snapshot", state)
        field(app, "library\$delegate", lazyOf(repository))
        val service = Robolectric.buildService(PlaybackService::class.java).create().get()
        try {
            field(service, "restoring", false)
            val queued = track(audio("deleted"))
            player(service).setMediaItems(listOf(queued.mediaItem()))
            repository.progress.value = ScanProgress(running = true)
            state.value = LibrarySnapshot(emptyList(), listOf(Folder("root", "tree", "root", "Liked Songs", true)))
            repository.progress.value = ScanProgress(running = false)
            runCurrent()
            assertEquals(1, player(service).mediaItemCount)
            assertEquals(queued.id, player(service).currentMediaItem?.mediaId)
            // Control: a fresh snapshot after the scan finishes DOES reach the collector.
            state.value = state.value.copy(folders = listOf(Folder("root", "tree", "root", "Changed root", true)))
            runCurrent()
            assertEquals(0, player(service).mediaItemCount)
        } finally { service.onDestroy(); Dispatchers.resetMain() }
    }

    @Test fun metadataRefreshWithSameQueueIdsLeavesPlaybackMetadataStale() = runTest {
        Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
        val app = ApplicationProvider.getApplicationContext<LyraApplication>()
        val source = FakeDocuments(emptyMap())
        val repository = LibraryRepository(MemoryDao(), MemoryPreferences(), source,
            ScanEngine(source, MetadataSource { _, _, _, _ -> error("unused") }), backgroundScope)
        val state = MutableStateFlow(LibrarySnapshot())
        field(repository, "snapshot", state)
        field(app, "library\$delegate", lazyOf(repository))
        val service = Robolectric.buildService(PlaybackService::class.java).create().get()
        try {
            field(service, "restoring", false)
            val old = track(audio("song")).copy(title = "Old title")
            player(service).setMediaItems(listOf(old.mediaItem()))
            state.value = LibrarySnapshot(listOf(old.copy(title = "New title")), listOf(Folder("root", "tree", "root", "Liked Songs", true)))
            runCurrent()
            assertEquals("Old title", player(service).currentMediaItem?.mediaMetadata?.title.toString())
            // Control: a change of IDs invokes reconciliation on the same collector.
            state.value = state.value.copy(tracks = emptyList())
            runCurrent()
            assertEquals(0, player(service).mediaItemCount)
        } finally { service.onDestroy(); Dispatchers.resetMain() }
    }
}
