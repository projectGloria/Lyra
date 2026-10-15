package com.lyra.sona.android

import android.os.Bundle
import android.os.Looper
import android.content.ComponentName
import androidx.lifecycle.ViewModelStore
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import androidx.test.core.app.ApplicationProvider
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.lyra.sona.android.playback.PlaybackService
import com.lyra.sona.android.ui.LyraViewModel
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A local MediaController/MediaSession transport with deterministic state, without audio decoding. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = LyraApplication::class)
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class PlayerControlsTest {
    private class FinishedPlayer : SimpleBasePlayer(Looper.getMainLooper()) {
        val actions = mutableListOf<String>()
        private var state = State.Builder().setAvailableCommands(Player.Commands.Builder().addAllCommands().build())
            .setPlaylist(listOf(MediaItemData.Builder("song").setMediaItem(MediaItem.fromUri("content://test/song"))
                .setIsSeekable(true).setDurationUs(1000000).build()))
            .setPlaybackState(Player.STATE_ENDED).setPlayWhenReady(true, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setContentPositionMs(1000).build()
        override fun getState() = state
        override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
            actions += "seek"
            state = state.buildUpon().setContentPositionMs(positionMs.coerceAtLeast(0)).setPlaybackState(Player.STATE_READY).build()
            return Futures.immediateVoidFuture()
        }
        override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
            actions += if (playWhenReady) "play" else "pause"
            state = state.buildUpon().setPlayWhenReady(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST).build()
            return Futures.immediateVoidFuture()
        }
        override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()
    }

    @Test fun finishedQueueShowsPlayAndFirstTapSeeksToRestartThroughController() {
        val app = ApplicationProvider.getApplicationContext<LyraApplication>()
        shadowOf(app).declareComponentUnbindable(ComponentName(app, PlaybackService::class.java))
        val model = LyraViewModel(app)
        val store = ViewModelStore().apply { put("model", model) }
        model.setUiActive(false)
        val player = FinishedPlayer()
        val session = MediaSession.Builder(app, player).setSessionExtras(Bundle().apply { putBoolean("ready", true) }).build()
        val future = MediaController.Builder(app, session.token).buildAsync()
        try {
            val deadline = System.nanoTime() + 3_000_000_000L
            while (!future.isDone && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5) }
            assertTrue("Local media controller must connect", future.isDone)
            val controller = future.get()
            model.javaClass.getDeclaredField("controller").apply { isAccessible = true }.set(model, controller)
            model.javaClass.getDeclaredMethod("updatePlayer", Boolean::class.javaPrimitiveType).apply { isAccessible = true }.invoke(model, true)
            assertTrue(model.playback.value.ready)
            assertFalse(model.playback.value.playing)
            model.toggle()
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(player.actions.contains("seek"))
            assertFalse(player.actions.contains("pause"))
            assertEquals(0L, player.currentPosition)
            model.seek(750)
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(750L, player.currentPosition)
            assertEquals(750L, model.playback.value.position)
        } finally { store.clear(); MediaController.releaseFuture(future); session.release(); player.release() }
    }
}
