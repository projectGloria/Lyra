package com.lyra.sona.android

import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionResult
import android.os.Bundle
import android.os.Process
import android.content.Intent
import android.content.ComponentName
import android.os.Looper
import androidx.lifecycle.ViewModelStore
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import com.lyra.sona.android.ui.LyraViewModel
import com.lyra.sona.android.playback.QueueCommands
import com.lyra.sona.android.playback.shuffleIndices
import com.lyra.sona.android.playback.isExplicitlyQueued
import androidx.media3.exoplayer.source.ShuffleOrder
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Uses the production service collector and a real ExoPlayer; does not decode audio. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = LyraApplication::class)
@OptIn(ExperimentalCoroutinesApi::class)
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class PlaybackServiceRegressionTest {
    private fun field(target: Any, name: String, value: Any) {
        target.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(target, value)
    }
    private fun player(service: PlaybackService) = service.javaClass.getDeclaredField("player").apply { isAccessible = true }.get(service) as ExoPlayer
    @Suppress("UNCHECKED_CAST")
    private fun restoration(service: PlaybackService) = service.javaClass.getDeclaredField("restoring").apply { isAccessible = true }.get(service) as MutableStateFlow<Boolean>
    private fun session(service: PlaybackService) = service.javaClass.getDeclaredField("session").apply { isAccessible = true }.get(service) as MediaSession
    private fun callback(session: MediaSession): MediaSession.Callback {
        val impl = session.javaClass.getDeclaredMethod("getImpl").apply { isAccessible = true }.invoke(session)
        return impl.javaClass.getDeclaredField("callback").apply { isAccessible = true }.get(impl) as MediaSession.Callback
    }

    @Test fun appCanStartASongThroughTheProductionServiceConnection() = runTest {
        val app = ApplicationProvider.getApplicationContext<LyraApplication>()
        val source = FakeDocuments(emptyMap())
        val repository = LibraryRepository(MemoryDao(), MemoryPreferences(), source,
            ScanEngine(source, MetadataSource { _, _, _, _ -> error("unused") }), backgroundScope)
        val song = track(audio("song"))
        field(repository, "snapshot", MutableStateFlow(LibrarySnapshot(listOf(song), tree = "tree", loaded = true)))
        field(app, "library\$delegate", lazyOf(repository))
        val service = Robolectric.buildService(PlaybackService::class.java).create().get()
        // Binding is replaced only in the ViewModel; this controller uses the production session and callback.
        shadowOf(app).declareComponentUnbindable(ComponentName(app, PlaybackService::class.java))
        val model = LyraViewModel(app)
        val store = ViewModelStore().apply { put("model", model) }
        model.setUiActive(false)
        val future = MediaController.Builder(app, session(service).token).buildAsync()
        fun awaitCondition(message: String, condition: () -> Boolean) {
            val deadline = System.nanoTime() + 3_000_000_000L
            while (!condition() && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5) }
            assertTrue(message, condition())
        }
        try {
            awaitCondition("Controller must connect to the production session") { future.isDone }
            val controller = future.get()
            awaitCondition("Restoration must publish readiness") { controller.sessionExtras.getBoolean("ready") }
            for (command in listOf(Player.COMMAND_CHANGE_MEDIA_ITEMS, Player.COMMAND_PREPARE, Player.COMMAND_PLAY_PAUSE,
                Player.COMMAND_SEEK_TO_MEDIA_ITEM)) {
                assertTrue("App must receive player command $command", controller.isCommandAvailable(command))
            }
            assertTrue(controller.availableSessionCommands.contains(QueueCommands.enqueue))
            field(model, "controller", controller)
            model.javaClass.getDeclaredMethod("updatePlayer", Boolean::class.javaPrimitiveType).apply { isAccessible = true }.invoke(model, true)
            assertTrue(model.playback.value.ready)
            model.play(listOf(song))
            awaitCondition("Play request must reach ExoPlayer") { player(service).mediaItemCount == 1 && player(service).playWhenReady }
            assertEquals(song.id, player(service).currentMediaItem?.mediaId)
            assertEquals(song.uri, player(service).currentMediaItem?.localConfiguration?.uri.toString())
            assertTrue(model.playback.value.explicitQueue.isEmpty())
        } finally {
            store.clear(); MediaController.releaseFuture(future); service.onDestroy()
        }
    }

    @Test fun customQueueCommandsUseCurrentServiceQueueAndRejectOtherPackages() = runTest {
        Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
        val app = ApplicationProvider.getApplicationContext<LyraApplication>()
        val source = FakeDocuments(emptyMap())
        val repository = LibraryRepository(MemoryDao(), MemoryPreferences(), source,
            ScanEngine(source, MetadataSource { _, _, _, _ -> error("unused") }), backgroundScope)
        val a = track(audio("a")); val b = track(audio("b")); val c = track(audio("c")); val next = track(audio("next"))
        val state = MutableStateFlow(LibrarySnapshot(listOf(a, b, c, next), tree = "tree", loaded = true))
        field(repository, "snapshot", state)
        field(app, "library\$delegate", lazyOf(repository))
        val service = Robolectric.buildService(PlaybackService::class.java).create().get()
        try {
            restoration(service).value = false
            val player = player(service)
            player.setMediaItems(listOf(a.mediaItem(), b.mediaItem(), c.mediaItem()), 0, 1200)
            player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(intArrayOf(0, 2, 1), 0))
            player.shuffleModeEnabled = true
            val session = session(service)
            val callback = callback(session)
            fun controller(packageName: String) = MediaSession.ControllerInfo.createTestOnlyControllerInfo(packageName,
                Process.myUid(), 1, 1, 1, false, Bundle.EMPTY, true)
            val own = controller(app.packageName)
            assertTrue(callback.onConnectAsync(session, own).get().availableSessionCommands.contains(QueueCommands.enqueue))
            assertFalse(callback.onConnectAsync(session, controller("other.app")).get().isAccepted)
            val args = Bundle().apply { putStringArrayList("ids", arrayListOf(next.id, next.id)); putBoolean("next", true) }
            assertEquals(SessionResult.RESULT_ERROR_PERMISSION_DENIED, callback.onCustomCommand(session, controller("other.app"), QueueCommands.enqueue, args).get().resultCode)
            assertEquals(3, player.mediaItemCount)
            assertEquals(SessionResult.RESULT_SUCCESS, callback.onCustomCommand(session, own, QueueCommands.enqueue, args).get().resultCode)
            assertEquals(listOf(0, 1, 2, 4, 3), shuffleIndices(player))
            assertEquals(next.id, player.getMediaItemAt(player.nextMediaItemIndex).mediaId)
            assertEquals(1200L, player.currentPosition)
            assertTrue(com.lyra.sona.android.playback.explicitQueueIndices((0 until player.mediaItemCount).map { player.getMediaItemAt(it) }, shuffleIndices(player), player.currentMediaItemIndex).size == 2)
            player.seekToNextMediaItem()
            shadowOf(Looper.getMainLooper()).idle()
            assertFalse(player.currentMediaItem!!.isExplicitlyQueued())
            assertEquals(1, com.lyra.sona.android.playback.explicitQueueIndices((0 until player.mediaItemCount).map { player.getMediaItemAt(it) }, shuffleIndices(player), player.currentMediaItemIndex).size)
        } finally { service.onDestroy(); Dispatchers.resetMain() }
    }

    @Test fun taskRemovalStopsNonForegroundPlaybackEvenWithPlayIntentTrue() = runTest {
        Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
        val service = Robolectric.buildService(PlaybackService::class.java).create().get()
        try {
            restoration(service).value = false
            service.addSession(session(service))
            player(service).playWhenReady = true
            assertFalse(service.isPlaybackOngoing)
            service.onTaskRemoved(Intent())
            assertTrue(shadowOf(service).isStoppedBySelf)
            assertFalse(player(service).playWhenReady)
        } finally { service.onDestroy(); Dispatchers.resetMain() }
    }

    @Test fun scanCompletionReprocessesLatestSnapshotWithoutAnotherLibraryEmission() = runTest {
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
            restoration(service).value = false
            val queued = track(audio("deleted"))
            player(service).setMediaItems(listOf(queued.mediaItem()))
            repository.progress.value = ScanProgress(running = true)
            state.value = LibrarySnapshot(emptyList(), listOf(Folder("root", "tree", "root", "Liked Songs", true)), "tree", loaded = true)
            runCurrent()
            assertEquals(1, player(service).mediaItemCount)
            repository.progress.value = ScanProgress(running = false)
            runCurrent()
            assertEquals(0, player(service).mediaItemCount)
        } finally { service.onDestroy(); Dispatchers.resetMain() }
    }

    @Test fun metadataRefreshUpdatesCurrentItemWithoutReplacingItsSource() = runTest {
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
            restoration(service).value = false
            val old = track(audio("song")).copy(title = "Old title")
            player(service).setMediaItems(listOf(old.mediaItem()))
            val uid = player(service).currentTimeline.getUidOfPeriod(0)
            player(service).seekTo(0, 1234)
            state.value = LibrarySnapshot(listOf(old.copy(title = "New title", durationMs = 2000)), listOf(Folder("root", "tree", "root", "Liked Songs", true)), "tree", loaded = true)
            runCurrent()
            assertEquals("New title", player(service).currentMediaItem?.mediaMetadata?.title.toString())
            assertEquals(2000L, player(service).currentMediaItem?.mediaMetadata?.extras?.getLong("durationMs"))
            assertEquals(uid, player(service).currentTimeline.getUidOfPeriod(0))
            assertEquals(1234L, player(service).currentPosition)
            // Control: a change of IDs invokes reconciliation on the same collector.
            state.value = state.value.copy(tracks = emptyList())
            runCurrent()
            assertEquals(0, player(service).mediaItemCount)
        } finally { service.onDestroy(); Dispatchers.resetMain() }
    }
}
