package com.lyra.sona.android.playback

import android.os.Bundle
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ShuffleOrder
import androidx.media3.session.SessionCommand
import com.lyra.sona.android.library.Track

object QueueCommands {
    val enqueue = SessionCommand("com.lyra.sona.ENQUEUE", Bundle.EMPTY)
    val move = SessionCommand("com.lyra.sona.MOVE", Bundle.EMPTY)
}

private const val EXPLICIT_QUEUE = "explicitQueue"
fun MediaItem.isExplicitlyQueued() = mediaMetadata.extras?.getBoolean(EXPLICIT_QUEUE, false) == true
fun MediaItem.withQueueFlag(queued: Boolean): MediaItem = buildUpon().setMediaMetadata(mediaMetadata.buildUpon()
    .setExtras(Bundle(mediaMetadata.extras ?: Bundle.EMPTY).apply { putBoolean(EXPLICIT_QUEUE, queued) }).build()).build()

fun explicitQueueIndices(items: List<MediaItem>, order: List<Int>, currentIndex: Int): List<Int> {
    val traversal = order.takeIf { validShuffleOrder(it, items.size) } ?: items.indices.toList()
    return traversal.filter { it != currentIndex && items[it].isExplicitlyQueued() }
}

fun shuffleIndices(player: Player): List<Int> {
    val timeline = player.currentTimeline
    if (timeline.isEmpty) return emptyList()
    val indices = mutableListOf<Int>()
    var index = timeline.getFirstWindowIndex(true)
    while (index != C.INDEX_UNSET && indices.size < player.mediaItemCount) {
        indices += index
        index = timeline.getNextWindowIndex(index, Player.REPEAT_MODE_OFF, true)
    }
    return indices
}

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
fun enqueueItems(player: ExoPlayer, items: List<MediaItem>, next: Boolean) {
    if (items.isEmpty()) return
    val oldOrder = shuffleIndices(player)
    val current = player.currentMediaItemIndex
    val insertion = if (next) (current + 1).coerceIn(0, player.mediaItemCount) else player.mediaItemCount
    val order = oldOrder.map { if (it >= insertion) it + items.size else it }.toMutableList()
    val afterCurrent = if (next && current >= 0) oldOrder.indexOf(current) + 1 else order.size
    order.addAll(afterCurrent.coerceIn(0, order.size), (insertion until insertion + items.size).toList())
    player.addMediaItems(insertion, items)
    player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(order.toIntArray(), 0L))
}

/** Queue positions refer to original indices; while shuffled the UI displays shuffle traversal. */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
fun moveQueuedItem(player: ExoPlayer, from: Int, to: Int) {
    if (from !in 0 until player.mediaItemCount || to !in 0 until player.mediaItemCount || from == to) return
    if (!player.shuffleModeEnabled) { player.moveMediaItem(from, to); return }
    val order = shuffleIndices(player).toMutableList()
    val target = order.indexOf(to)
    order.remove(from)
    order.add(target, from)
    player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(order.toIntArray(), 0L))
}

/** Removing non-current occurrences keeps their retained MediaSources and playback position alive. */
fun reconcilePlayer(player: Player, available: Map<String, Track>): Boolean {
    var changed = false
    for (index in player.mediaItemCount - 1 downTo 0) {
        if (player.getMediaItemAt(index).mediaId !in available) { player.removeMediaItem(index); changed = true }
    }
    for (index in 0 until player.mediaItemCount) {
        val item = player.getMediaItemAt(index)
        val updated = available.getValue(item.mediaId).mediaItem()
        // Keep the existing source configuration for metadata-only changes.
        val replacement = item.buildUpon().setMediaMetadata(updated.mediaMetadata).build().withQueueFlag(item.isExplicitlyQueued())
        val oldExtras = item.mediaMetadata.extras
        val newExtras = replacement.mediaMetadata.extras
        if (item.mediaMetadata != replacement.mediaMetadata || oldExtras?.getLong("durationMs") != newExtras?.getLong("durationMs") ||
            oldExtras?.getString("playerArtwork") != newExtras?.getString("playerArtwork")) {
            player.replaceMediaItem(index, replacement); changed = true
        }
    }
    if (changed && player.mediaItemCount == 0) { player.pause(); player.stop() }
    return changed
}
