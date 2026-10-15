package com.lyra.sona.android.playback

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.source.ShuffleOrder
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionError
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.lyra.sona.android.LyraApplication
import com.lyra.sona.android.MainActivity
import com.lyra.sona.android.data.PlaybackSnapshot
import com.lyra.sona.android.library.Track
import com.lyra.sona.android.library.resolveLibraryArtwork
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import java.io.File

fun Track.mediaItem(): MediaItem = MediaItem.Builder().setMediaId(id).setUri(uri)
    .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(album)
        .setDurationMs(durationMs.takeIf { it > 0 })
        .setAlbumArtist(albumArtist).setTrackNumber(trackNumber.takeIf { it > 0 })
        .setArtworkUri(thumbnail.takeIf { it.isNotEmpty() }?.let { Uri.fromFile(File(it)) })
        .setExtras(Bundle().apply { putString("playerArtwork", artwork); putLong("durationMs", durationMs) }).build()).build()

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class PlaybackService : MediaSessionService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var player: ExoPlayer
    private var session: MediaSession? = null
    private lateinit var graph: LyraApplication
    private val failurePolicy = FailurePolicy()
    private val restoring = MutableStateFlow(true)
    private var saveJob: Job? = null
    private var successJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        graph = application as LyraApplication
        player = ExoPlayer.Builder(this).setLoadControl(DefaultLoadControl.Builder()
            .setBufferDurationsMsForLocalPlayback(5000, 30000, 150, 300)
            .setBackBuffer(30000, false).build()).build().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            setHandleAudioBecomingNoisy(true)
            setWakeMode(C.WAKE_MODE_LOCAL)
            addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) {
                    val current = player.currentMediaItem
                    if (current?.isExplicitlyQueued() == true) {
                        // An explicit occurrence leaves the pending queue when it starts playing.
                        player.replaceMediaItem(player.currentMediaItemIndex, current.withQueueFlag(false))
                    }
                    protectArtwork()
                    if (!restoring.value && (events.contains(Player.EVENT_TIMELINE_CHANGED) || events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) ||
                            events.contains(Player.EVENT_POSITION_DISCONTINUITY) || events.contains(Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED) ||
                            events.contains(Player.EVENT_REPEAT_MODE_CHANGED) || events.contains(Player.EVENT_IS_PLAYING_CHANGED))) save()
                }
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    successJob?.cancel()
                    if (isPlaying) successJob = serviceScope.launch {
                        // READY alone is insufficient: require the playing position to advance.
                        val index = player.currentMediaItemIndex
                        val position = player.currentPosition
                        while (player.isPlaying && player.currentMediaItemIndex == index) {
                            delay(50)
                            if (player.isPlaying && player.currentMediaItemIndex == index && player.currentPosition > position) {
                                failurePolicy.successful(); break
                            }
                        }
                    }
                }
                override fun onPlayerError(error: PlaybackException) { handleFailure(error) }
            })
        }
        val activity = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        session = MediaSession.Builder(this, player).setSessionActivity(activity).setSessionExtras(Bundle().apply { putBoolean("ready", false) }).setCallback(object : MediaSession.Callback {
            override fun onConnectAsync(session: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaSession.ConnectionResult> {
                val own = controller.packageName == packageName && controller.isPackageNameVerified
                if (!own && !controller.isTrusted) return Futures.immediateFuture(MediaSession.ConnectionResult.reject())
                // Media3 1.11's synchronous default is a sentinel with empty commands.
                // Grant commands explicitly after authenticating the controller.
                val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                if (own) { commands.add(QueueCommands.enqueue); commands.add(QueueCommands.move) }
                return Futures.immediateFuture(MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
                    .setAvailablePlayerCommands(MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS)
                    .setAvailableSessionCommands(commands.build()).build())
            }
            override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo,
                customCommand: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
                if (controller.packageName != packageName || !controller.isPackageNameVerified) return Futures.immediateFuture(SessionResult(SessionError.ERROR_PERMISSION_DENIED))
                if (restoring.value) return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
                when (customCommand) {
                    QueueCommands.enqueue -> {
                        val library = graph.library.snapshot.value
                        if (!library.loaded) return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
                        val available = library.tracks.associateBy { it.id }
                        val ids = args.getStringArrayList("ids").orEmpty()
                        if (ids.any { it !in available }) return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
                        enqueueItems(player, ids.map { available.getValue(it).mediaItem().withQueueFlag(true) }, args.getBoolean("next"))
                        if (player.playbackState == Player.STATE_IDLE && player.mediaItemCount > 0) player.prepare()
                    }
                    QueueCommands.move -> moveQueuedItem(player, args.getInt("from", -1), args.getInt("to", -1))
                    else -> return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
                }
                save()
                return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
        }).build()
        serviceScope.launch {
            try {
                val tree = graph.preferences.tree.first()
                val saved = graph.preferences.playback.first()
                val cached = graph.database.library().snapshot(tree)
                val tracks = resolveLibraryArtwork(cached.tracks, cached.folders).associateBy { it.id }
                val restored = reconcileQueue(saved.queue, saved.index, saved.positionMs, saved.shuffleOrder, tracks.keys)
                val retained = saved.queue.indices.filter { saved.queue[it] in tracks }
                if (restored.ids.isNotEmpty()) {
                    player.setMediaItems(restored.ids.mapIndexed { index, id ->
                        tracks.getValue(id).mediaItem().withQueueFlag(retained[index] in saved.explicitQueue && index != restored.index)
                    }, restored.index, restored.positionMs)
                    player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(restored.order.toIntArray(), 0L))
                    player.shuffleModeEnabled = saved.shuffle
                    player.repeatMode = saved.repeat
                    player.prepare()
                    player.playWhenReady = false
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { graph.playbackMessage.value = "Playback restoration failed: ${error.message}" }
            finally { restoring.value = false; session?.setSessionExtras(Bundle().apply { putBoolean("ready", true) }) }
            while (isActive) { delay(2000); if (player.isPlaying) save() }
        }
        serviceScope.launch {
            combine(graph.library.snapshot, graph.library.progress, restoring) { library, progress, restoring ->
                library.takeIf { it.loaded && !progress.running && !restoring }
            }.collect { library ->
                if (library != null && reconcilePlayer(player, library.tracks.associateBy { it.id })) {
                    if (player.mediaItemCount == 0) graph.playbackMessage.value = "No playable tracks remain in this library."
                    save()
                }
            }
        }
    }

    private fun shuffleIndices() = shuffleIndices(player)

    private fun protectArtwork() {
        val metadata = player.currentMediaItem?.mediaMetadata
        graph.artwork.protectCurrent(listOfNotNull(metadata?.artworkUri?.path,
            metadata?.extras?.getString("playerArtwork")).filter { it.isNotEmpty() }.toSet())
    }

    private fun snapshot() = PlaybackSnapshot((0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId },
        player.currentMediaItemIndex.coerceAtLeast(0), player.currentPosition.coerceAtLeast(0), player.shuffleModeEnabled, player.repeatMode, shuffleIndices(),
        (0 until player.mediaItemCount).filter { player.getMediaItemAt(it).isExplicitlyQueued() })

    private fun save() {
        if (restoring.value) return
        val state = snapshot()
        saveJob?.cancel()
        saveJob = serviceScope.launch { graph.preferences.savePlayback(state) }
    }

    private fun handleFailure(error: PlaybackException) {
        val shouldResume = player.playWhenReady
        val queue = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
        val failed = player.currentMediaItem?.mediaId.orEmpty()
        val cause = when (error.errorCode) {
            PlaybackException.ERROR_CODE_IO_NO_PERMISSION -> "Folder permission was revoked. Choose your music folder again."
            PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "The file or its storage is unavailable. Reconnect storage or refresh your library."
            else -> "${error.errorCodeName}: ${error.cause?.message ?: error.message ?: "Unreadable audio"}"
        }
        if (failurePolicy.failed(failed, queue)) {
            player.pause(); player.stop()
            graph.playbackMessage.value = "Playback stopped after ${failurePolicy.consecutive} consecutive failure(s): $cause"
            save(); return
        }
        val order = if (player.shuffleModeEnabled) shuffleIndices() else queue.indices.toList()
        val offset = order.indexOf(player.currentMediaItemIndex).coerceAtLeast(0)
        val next = (1..order.size).map { order[(offset + it) % order.size] }.firstOrNull { queue[it] !in failurePolicy.failedIds }
        if (next == null) {
            player.stop(); graph.playbackMessage.value = "No playable tracks remain: $cause"
        } else {
            graph.playbackMessage.value = "Skipped ${player.currentMediaItem?.mediaMetadata?.title ?: "track"}: $cause"
            player.seekTo(next, 0); player.prepare(); player.playWhenReady = shouldResume
        }
        save()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session
    override fun onTaskRemoved(rootIntent: Intent?) {
        save()
        super.onTaskRemoved(rootIntent)
        // Active playback intentionally survives swiping the app out of Recents.
    }
    override fun onDestroy() {
        val finalState = if (::player.isInitialized && !restoring.value) snapshot() else null
        serviceScope.cancel()
        if (finalState != null) graph.scope.launch { graph.preferences.savePlayback(finalState) }
        session?.release(); player.release(); session = null
        graph.artwork.protectCurrent(emptySet())
        super.onDestroy()
    }
}
