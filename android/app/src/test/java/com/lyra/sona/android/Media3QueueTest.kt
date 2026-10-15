package com.lyra.sona.android

import android.app.Application
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ShuffleOrder
import com.lyra.sona.android.playback.*
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class Media3QueueTest {
    @Test fun playlistPlaybackHasNoExplicitQueueAndDuplicateManualAddsRemainSeparate() {
        val a = track(audio("a")); val b = track(audio("b"))
        val items = listOf(a.mediaItem(), b.mediaItem(), a.mediaItem().withQueueFlag(true), a.mediaItem().withQueueFlag(true))
        assertTrue(explicitQueueIndices(items.take(2), listOf(0, 1), 0).isEmpty())
        assertEquals(listOf(3, 2), explicitQueueIndices(items, listOf(0, 3, 1, 2), 0))
        assertEquals(listOf(2), explicitQueueIndices(items, listOf(0, 3, 1, 2), 3))
    }
    @Test fun metadataRefreshRetainsExplicitQueueFlags() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext<Application>()).build()
        val song = track(audio("song"))
        try {
            player.setMediaItems(listOf(song.mediaItem(), song.mediaItem().withQueueFlag(true)))
            reconcilePlayer(player, mapOf(song.id to song.copy(title = "Updated", artwork = "cover")))
            assertFalse(player.getMediaItemAt(0).isExplicitlyQueued())
            assertTrue(player.getMediaItemAt(1).isExplicitlyQueued())
            assertEquals(listOf(1), explicitQueueIndices((0..1).map { player.getMediaItemAt(it) }, listOf(0, 1), 0))
        } finally { player.release() }
    }
    @Test fun shuffledQueueAppendAndMovePreserveDuplicateOccurrencesAndCurrentSource() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext<Application>()).build()
        fun item(id: String) = MediaItem.Builder().setMediaId(id).setUri("content://test/$id").build()
        try {
            player.setMediaItems(listOf(item("a"), item("b"), item("a")), 0, 2500)
            player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(intArrayOf(0, 2, 1), 0L))
            player.shuffleModeEnabled = true
            val uid = player.currentTimeline.getUidOfPeriod(0)
            enqueueItems(player, listOf(item("a"), item("next")), next = true)
            assertEquals(listOf(0, 1, 2, 4, 3), shuffleIndices(player))
            enqueueItems(player, listOf(item("last")), next = false)
            assertEquals(listOf(0, 1, 2, 4, 3, 5), shuffleIndices(player))
            moveQueuedItem(player, 4, 2)
            assertEquals(listOf(0, 1, 4, 2, 3, 5), shuffleIndices(player))
            assertEquals(uid, player.currentTimeline.getUidOfPeriod(0))
            assertEquals(2500L, player.currentPosition)
        } finally { player.release() }
    }

    @Test fun deletingOtherQueueOccurrencesPreservesCurrentMediaSourceAndPosition() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext<Application>()).build()
        val retained = track(audio("retained"))
        val removed = track(audio("removed"))
        try {
            player.setMediaItems(listOf(removed.mediaItem(), retained.mediaItem(), removed.mediaItem(), retained.mediaItem()), 1, 4321)
            player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(intArrayOf(1, 3, 2, 0), 0L))
            player.shuffleModeEnabled = true
            val uid = player.currentTimeline.getUidOfPeriod(1)
            assertTrue(reconcilePlayer(player, mapOf(retained.id to retained)))
            assertEquals(2, player.mediaItemCount)
            assertEquals(0, player.currentMediaItemIndex)
            assertEquals(uid, player.currentTimeline.getUidOfPeriod(0))
            assertEquals(4321L, player.currentPosition)
            assertEquals(listOf(0, 1), shuffleIndices(player))
        } finally { player.release() }
    }

    @Test fun changedExtrasRefreshEvenWhenStandardMetadataIsUnchanged() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext<Application>()).build()
        val old = track(audio("track"))
        try {
            player.setMediaItems(listOf(old.mediaItem()))
            assertTrue(reconcilePlayer(player, mapOf(old.id to old.copy(durationMs = 9999, artwork = "large-cover"))))
            assertEquals(9999L, player.currentMediaItem?.mediaMetadata?.extras?.getLong("durationMs"))
            assertEquals("large-cover", player.currentMediaItem?.mediaMetadata?.extras?.getString("playerArtwork"))
        } finally { player.release() }
    }
    @Test fun realMedia3QueueSupportsInsertMoveRemoveAndDuplicateItems() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext<Application>()).build()
        fun item(id: String) = MediaItem.Builder().setMediaId(id).setUri("content://test/$id").build()
        fun ids() = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
        try {
            player.setMediaItems(listOf(item("a"), item("b"), item("a")), 0, 0)
            player.addMediaItem(player.currentMediaItemIndex + 1, item("next"))
            assertEquals(listOf("a", "next", "b", "a"), ids())
            player.moveMediaItem(3, 1)
            assertEquals(listOf("a", "a", "next", "b"), ids())
            player.removeMediaItem(2)
            assertEquals(listOf("a", "a", "b"), ids())
            player.seekTo(2, 1234)
            assertEquals("b", player.currentMediaItem?.mediaId)
            assertEquals(1234L, player.currentPosition)
        } finally { player.release() }
    }
    @Test fun realMedia3ShuffleTraversalAndRepeatModesRestore() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext<Application>()).build()
        try {
            player.setMediaItems((0..2).map { MediaItem.Builder().setMediaId("$it").setUri("content://test/$it").build() }, 1, 500)
            player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(intArrayOf(2, 0, 1), 0L))
            player.shuffleModeEnabled = true
            player.repeatMode = Player.REPEAT_MODE_ALL
            val timeline = player.currentTimeline
            assertEquals(2, timeline.getFirstWindowIndex(true))
            assertEquals(0, timeline.getNextWindowIndex(2, Player.REPEAT_MODE_OFF, true))
            assertEquals(1, timeline.getNextWindowIndex(0, Player.REPEAT_MODE_OFF, true))
            assertEquals(2, timeline.getNextWindowIndex(1, Player.REPEAT_MODE_ALL, true))
            player.repeatMode = Player.REPEAT_MODE_ONE
            assertEquals(1, timeline.getNextWindowIndex(1, Player.REPEAT_MODE_ONE, true))
            player.repeatMode = Player.REPEAT_MODE_OFF
            assertEquals(1, player.currentMediaItemIndex); assertEquals(500L, player.currentPosition)
            assertFalse(player.playWhenReady)
        } finally { player.release() }
    }
}
