package com.lyra.sona.android.ui

import android.app.Application
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.Util
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.ListenableFuture
import com.lyra.sona.android.LyraApplication
import com.lyra.sona.android.library.Track
import com.lyra.sona.android.playback.PlaybackService
import com.lyra.sona.android.playback.mediaItem
import com.lyra.sona.android.playback.QueueCommands
import com.lyra.sona.android.playback.shuffleIndices
import com.lyra.sona.android.playback.explicitQueueIndices
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class PlaybackUi(val ready: Boolean = false, val current: MediaItem? = null, val playing: Boolean = false,
    val position: Long = 0, val duration: Long = 0, val queue: List<MediaItem> = emptyList(), val currentIndex: Int = -1,
    val shuffle: Boolean = false, val repeat: Int = Player.REPEAT_MODE_OFF, val queueOrder: List<Int> = emptyList(),
    val explicitQueue: List<Int> = explicitQueueIndices(queue, queueOrder, currentIndex),
    val currentArtwork: String = current?.mediaMetadata?.extras?.getString("playerArtwork").orEmpty())

@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class LyraViewModel(application: Application) : AndroidViewModel(application) {
    val graph = application as LyraApplication
    val library = graph.library
    val playback = MutableStateFlow(PlaybackUi())
    val selectionError = MutableStateFlow("")
    val selecting = MutableStateFlow(false)
    private var controller: MediaController? = null
    private var future: ListenableFuture<MediaController>? = null
    private var connectionGeneration = 0
    private var reconnectJob: Job? = null
    private var pollJob: Job? = null
    private var uiActive = true
    private var cleared = false
    private var reconnectDelay = 1000L
    private var connectionMessage = ""

    init {
        connect()
        startPolling()
        viewModelScope.launch {
            val selected = graph.preferences.tree.first()
            if (selected.isNotBlank()) releaseOldGrants(Uri.parse(selected))
            library.refresh()
        }
    }

    private fun connect() {
        if (cleared || !uiActive || future != null) return
        val generation = ++connectionGeneration
        val application = getApplication<Application>()
        val connecting = MediaController.Builder(application, SessionToken(application, ComponentName(application, PlaybackService::class.java)))
            .setListener(object : MediaController.Listener {
                override fun onDisconnected(controller: MediaController) {
                    if (generation == connectionGeneration && !cleared) {
                        connectionMessage = "Playback service disconnected. Reconnecting…"
                        graph.playbackMessage.value = connectionMessage
                        disconnect(); scheduleReconnect()
                    }
                }
                override fun onExtrasChanged(controller: MediaController, extras: Bundle) { if (generation == connectionGeneration) updatePlayer(false) }
            }).buildAsync()
        future = connecting
        connecting.addListener({
            if (generation != connectionGeneration || cleared) return@addListener
            try {
                controller = connecting.get().also {
                    it.addListener(object : Player.Listener {
                        override fun onEvents(player: Player, events: Player.Events) {
                            if (player === controller) updatePlayer(events.contains(Player.EVENT_TIMELINE_CHANGED) ||
                                events.contains(Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED) || events.contains(Player.EVENT_MEDIA_METADATA_CHANGED))
                        }
                    })
                }
                reconnectDelay = 1000L
                if (graph.playbackMessage.value == connectionMessage) graph.playbackMessage.value = ""
                connectionMessage = ""
                updatePlayer()
            } catch (error: Exception) {
                connectionMessage = "Playback service could not connect: ${error.cause?.message ?: error.message}. Reconnecting…"
                graph.playbackMessage.value = connectionMessage
                disconnect(); scheduleReconnect()
            }
        }, ContextCompat.getMainExecutor(application))
    }

    private fun disconnect() {
        connectionGeneration++
        val previous = future
        future = null; controller = null
        playback.value = playback.value.copy(ready = false, playing = false)
        previous?.let { MediaController.releaseFuture(it) }
    }

    private fun scheduleReconnect() {
        if (!uiActive || cleared || reconnectJob?.isActive == true) return
        reconnectJob = viewModelScope.launch {
            delay(reconnectDelay)
            reconnectDelay = (reconnectDelay * 2).coerceAtMost(15000)
            reconnectJob = null
            connect()
        }
    }

    private fun startPolling() {
        if (pollJob?.isActive == true) return
        pollJob = viewModelScope.launch { while (isActive) { delay(250); updatePlayer(rebuildQueue = false) } }
    }

    fun setUiActive(active: Boolean) {
        uiActive = active
        if (active) { connect(); startPolling() }
        else { reconnectJob?.cancel(); reconnectJob = null; pollJob?.cancel(); pollJob = null; disconnect() }
    }

    private fun updatePlayer(rebuildQueue: Boolean = true) {
        val player = controller ?: return
        val previous = playback.value
        val items = if (rebuildQueue) (0 until player.mediaItemCount).map { player.getMediaItemAt(it) } else previous.queue
        val order = if (rebuildQueue) (if (player.shuffleModeEnabled) shuffleIndices(player) else items.indices.toList()) else previous.queueOrder
        val pending = if (rebuildQueue || player.currentMediaItemIndex != previous.currentIndex)
            explicitQueueIndices(items, order, player.currentMediaItemIndex) else previous.explicitQueue
        playback.value = PlaybackUi(player.isConnected && player.sessionExtras.getBoolean("ready", false), player.currentMediaItem, !Util.shouldShowPlayButton(player),
            player.currentPosition.coerceAtLeast(0), player.duration.takeIf { it > 0 } ?: player.currentMediaItem?.mediaMetadata?.extras?.getLong("durationMs") ?: 0,
            items,
            player.currentMediaItemIndex, player.shuffleModeEnabled, player.repeatMode,
            order, pending)
    }

    fun chooseFolder(uri: Uri, resultFlags: Int) {
        if (selecting.value) return
        viewModelScope.launch {
            selecting.value = true; selectionError.value = ""
            val resolver = graph.contentResolver
            val alreadyHeld = resolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }
            try {
                val readFlag = resultFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION
                if (!alreadyHeld && readFlag == 0) error("Android rejected read access to that folder.")
                if (!alreadyHeld) resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                library.select(uri.toString())
                releaseOldGrants(uri)
            } catch (cancelled: CancellationException) {
                withContext(NonCancellable) {
                    if (graph.preferences.tree.first() == uri.toString()) releaseOldGrants(uri)
                    else if (!alreadyHeld) runCatching { resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                }
                throw cancelled
            } catch (error: Exception) {
                if (!alreadyHeld) runCatching { resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                selectionError.value = "${error.message ?: "That folder could not be selected."} Choose Music or an allowed subfolder. Your previous library has not changed."
            } finally { selecting.value = false }
        }
    }
    private fun releaseOldGrants(selected: Uri) {
        graph.contentResolver.persistedUriPermissions.filter { it.uri != selected }.forEach {
            val flags = (if (it.isReadPermission) Intent.FLAG_GRANT_READ_URI_PERMISSION else 0) or
                (if (it.isWritePermission) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
            runCatching { graph.contentResolver.releasePersistableUriPermission(it.uri, flags) }
        }
    }
    fun rejectedSelection() { selectionError.value = "Android returned no usable folder. Choose Music or an allowed subfolder." }
    fun refresh() = library.refresh()
    fun play(tracks: List<Track>, index: Int = 0) {
        val player = controller ?: return
        if (!playback.value.ready || tracks.isEmpty()) return
        graph.playbackMessage.value = ""
        player.setMediaItems(tracks.map { it.mediaItem() }, index.coerceIn(tracks.indices), 0)
        player.prepare(); player.play(); updatePlayer()
    }
    fun toggle() { controller?.let { Util.handlePlayPauseButtonAction(it) }; updatePlayer() }
    fun previous() { controller?.seekToPreviousMediaItem(); updatePlayer() }
    fun next() { controller?.seekToNextMediaItem(); updatePlayer() }
    fun seek(position: Long) { controller?.seekTo(position.coerceAtLeast(0)); updatePlayer() }
    fun shuffle() { controller?.let { it.shuffleModeEnabled = !it.shuffleModeEnabled }; updatePlayer() }
    fun repeat() { controller?.let { it.repeatMode = when (it.repeatMode) { Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL; Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF } }; updatePlayer() }
    fun enqueue(tracks: List<Track>, next: Boolean = false) {
        val player = controller ?: return
        if (!playback.value.ready) return
        sendQueueCommand(player, QueueCommands.enqueue, Bundle().apply {
            putStringArrayList("ids", ArrayList(tracks.map { it.id })); putBoolean("next", next)
        })
    }
    fun remove(index: Int) { controller?.let { if (index in 0 until it.mediaItemCount) it.removeMediaItem(index) }; updatePlayer() }
    fun move(from: Int, to: Int) { controller?.let { sendQueueCommand(it, QueueCommands.move, Bundle().apply { putInt("from", from); putInt("to", to) }) } }
    private fun sendQueueCommand(player: MediaController, command: SessionCommand, args: Bundle) {
        if (!playback.value.ready) return
        val result = player.sendCustomCommand(command, args)
        result.addListener({
            try {
                if (result.get().resultCode != SessionResult.RESULT_SUCCESS) graph.playbackMessage.value = "The queue changed before that action completed. Try again."
                updatePlayer()
            } catch (_: Exception) { graph.playbackMessage.value = "The playback service disconnected. Try again after reconnection." }
        }, ContextCompat.getMainExecutor(getApplication()))
    }
    fun jump(index: Int) { controller?.seekTo(index, 0); controller?.prepare(); controller?.play(); updatePlayer() }
    override fun onCleared() { cleared = true; reconnectJob?.cancel(); pollJob?.cancel(); disconnect(); super.onCleared() }
}
