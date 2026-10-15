package com.lyra.sona.android.library

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.database.Cursor
import android.os.CancellationSignal
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.io.File
import kotlin.coroutines.resumeWithException
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.inspector.MetadataRetriever
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

class AndroidDocuments(private val context: Context, private val artwork: ArtworkCache) : DocumentSource {
    private val resolver = context.contentResolver
    override fun rootId(tree: String): String = DocumentsContract.getTreeDocumentId(Uri.parse(tree))
    override fun uri(tree: String, documentId: String): String = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), documentId).toString()

    private suspend fun query(uri: Uri, columns: Array<String>): Cursor? = suspendCancellableCoroutine { continuation ->
        val signal = CancellationSignal()
        continuation.invokeOnCancellation { signal.cancel() }
        try {
            val cursor = resolver.query(uri, columns, null, null, null, signal)
            continuation.resume(cursor) { _, unused, _ -> unused?.close() }
        } catch (error: Exception) { continuation.resumeWithException(error) }
    }

    private fun requireComplete(cursor: Cursor) {
        val message = cursor.extras.getString(DocumentsContract.EXTRA_ERROR).orEmpty()
        check(message.isBlank()) { "The storage provider reported an error: $message" }
        check(!cursor.extras.getBoolean(DocumentsContract.EXTRA_LOADING, false)) {
            "The storage provider is still loading this folder. Wait for it to finish, then refresh."
        }
    }

    override suspend fun validate(tree: String): String = withContext(Dispatchers.IO) {
        require(DocumentsContract.isTreeUri(Uri.parse(tree))) { "Choose a music folder, rather than an individual file." }
        require(resolver.persistedUriPermissions.any { it.uri.toString() == tree && it.isReadPermission }) {
            "Android did not retain access to this folder. Choose another folder such as Music or a subfolder."
        }
        query(Uri.parse(uri(tree, rootId(tree))), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE))?.use {
            requireComplete(it)
            require(it.moveToFirst() && it.getString(1) == DIRECTORY_MIME) { "This folder is unavailable. Choose another folder." }
            val name = it.getString(0).orEmpty()
            children(tree, rootId(tree)) // Confirm that the provider actually permits enumeration.
            name
        } ?: error("Android rejected access to this folder. Choose Music or an allowed subfolder.")
    }

    override suspend fun children(tree: String, documentId: String): List<DocumentEntry> = withContext(Dispatchers.IO) {
        currentCoroutineContext().ensureActive()
        val childUri = DocumentsContract.buildChildDocumentsUriUsingTree(Uri.parse(tree), documentId)
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        val entries = mutableListOf<DocumentEntry>()
        query(childUri, columns)?.use { cursor ->
            requireComplete(cursor)
            while (cursor.moveToNext()) {
                currentCoroutineContext().ensureActive()
                entries += DocumentEntry(cursor.getString(0), cursor.getString(1).orEmpty(), cursor.getString(2),
                    if (cursor.isNull(3)) null else cursor.getLong(3), if (cursor.isNull(4)) null else cursor.getLong(4))
            }
            requireComplete(cursor)
        } ?: error("Could not read a music folder. Reconnect storage or choose another folder.")
        entries
    }

    override suspend fun cover(tree: String, entry: DocumentEntry): String = withContext(Dispatchers.IO) {
        val key = stableId(tree, "${entry.documentId}:${entry.size}:${entry.modified}")
        artwork.thumbnail(key).takeIf { entry.size != null && entry.modified != null && entry.modified > 0 && it.isFile }?.absolutePath ?: run {
            readCoverBytes(Uri.parse(uri(tree, entry.documentId)))?.let { bytes ->
                if (bytes.size > 16 * 1024 * 1024) return@let ""
                val reliable = entry.size != null && entry.modified != null && entry.modified > 0
                val contentKey = if (reliable) key else stableId(tree, entry.documentId + ":" +
                    java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
                artwork.save(contentKey, bytes).first
            }.orEmpty()
        }
    }

    private suspend fun readCoverBytes(uri: Uri): ByteArray? = suspendCancellableCoroutine { continuation ->
        val signal = CancellationSignal()
        val activeStream = java.util.concurrent.atomic.AtomicReference<java.io.InputStream?>()
        continuation.invokeOnCancellation {
            signal.cancel()
            runCatching { activeStream.get()?.close() }
        }
        try {
            val bytes = resolver.openAssetFileDescriptor(uri, "r", signal)?.use { descriptor ->
                descriptor.createInputStream().use { stream ->
                    activeStream.set(stream)
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (output.size() <= 16 * 1024 * 1024) {
                        if (!continuation.isActive) throw kotlinx.coroutines.CancellationException("Cover read cancelled")
                        val count = stream.read(buffer, 0, minOf(buffer.size, 16 * 1024 * 1024 + 1 - output.size()))
                        if (count < 0) break
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
            }
            continuation.resume(bytes) { _, _, _ -> }
        } catch (error: Exception) { continuation.resumeWithException(error) }
        finally { activeStream.set(null) }
    }
}

class ArtworkCache(context: Context, private val maxBytes: Long = 64L * 1024 * 1024) {
    private val directory = File(context.filesDir, "artwork").apply { mkdirs() }
    // A single bounded lock also excludes eviction while a pair of images is being written.
    private val lock = Any()
    @Volatile private var playingPaths: Set<String> = emptySet()
    fun protectCurrent(paths: Set<String>) { playingPaths = paths }
    fun thumbnail(key: String) = File(directory, "$key-small.jpg")
    fun save(key: String, bytes: ByteArray): Pair<String, String> = synchronized(lock) {
        saveLocked(key, bytes).also { paths ->
            listOf(paths.first, paths.second).filter { it.isNotEmpty() }.forEach { File(it).setLastModified(System.currentTimeMillis()) }
            trimLocked(playingPaths + listOf(paths.first, paths.second))
        }
    }
    fun prune(referencedPaths: Set<String>, canPrune: () -> Boolean = { true }) = synchronized(lock) {
        if (!canPrune()) return@synchronized
        val retained = referencedPaths + playingPaths
        directory.listFiles().orEmpty().filter { it.isFile && it.absolutePath !in retained }.forEach { it.delete() }
        trimLocked(playingPaths)
    }
    private fun trimLocked(protectedPaths: Set<String>) {
        val files = directory.listFiles().orEmpty().filter { it.isFile }
        var total = files.sumOf { it.length() }
        for (file in files.sortedBy { it.lastModified() }) {
            if (total <= maxBytes) break
            if (file.absolutePath !in protectedPaths) {
                val size = file.length()
                if (file.delete()) total -= size
            }
        }
    }
    private fun saveLocked(key: String, bytes: ByteArray): Pair<String, String> {
        if (bytes.size > 16 * 1024 * 1024) return "" to ""
        val small = thumbnail(key)
        val large = File(directory, "$key-player.jpg")
        if (small.isFile && large.isFile) return small.absolutePath to large.absolutePath
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return "" to ""
        for ((limit, target) in listOf(256 to small, 1024 to large)) {
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > limit * 2) sample *= 2
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: continue
            val scale = minOf(1f, limit.toFloat() / maxOf(decoded.width, decoded.height))
            val scaled = if (scale < 1f) Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt().coerceAtLeast(1), (decoded.height * scale).toInt().coerceAtLeast(1), true) else decoded
            val temporary = File(directory, "${target.name}.tmp")
            temporary.outputStream().use { scaled.compress(Bitmap.CompressFormat.JPEG, 88, it) }
            if (!temporary.renameTo(target)) { temporary.copyTo(target, overwrite = true); temporary.delete() }
            if (scaled !== decoded) scaled.recycle()
            decoded.recycle()
        }
        return small.takeIf { it.isFile }?.absolutePath.orEmpty() to large.takeIf { it.isFile }?.absolutePath.orEmpty()
    }
}

@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class AndroidMetadata(private val context: Context, private val artwork: ArtworkCache) : MetadataSource {
    companion object { private val workers = Semaphore(4) }
    override suspend fun read(tree: String, folderId: String, entry: DocumentEntry, uri: String): Track = workers.withPermit { withContext(Dispatchers.IO) {
        currentCoroutineContext().ensureActive()
        val values = mutableMapOf<Int, String>()
        var picture: ByteArray? = null
        val reader = MediaMetadataRetriever()
        try {
            reader.setDataSource(context, Uri.parse(uri))
            for (key in listOf(MediaMetadataRetriever.METADATA_KEY_TITLE, MediaMetadataRetriever.METADATA_KEY_ARTIST,
                MediaMetadataRetriever.METADATA_KEY_ALBUM, MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST,
                MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER, MediaMetadataRetriever.METADATA_KEY_YEAR,
                MediaMetadataRetriever.METADATA_KEY_GENRE, MediaMetadataRetriever.METADATA_KEY_DURATION)) {
                values[key] = runCatching { reader.extractMetadata(key).orEmpty().trim() }.getOrDefault("")
            }
            picture = runCatching { reader.embeddedPicture }.getOrNull()
        } catch (_: Exception) {
            // Some SAF providers / codecs play in Media3 but fail the platform retriever.
        } finally { reader.release() }
        currentCoroutineContext().ensureActive()
        fun value(key: Int) = values[key].orEmpty()
        var art = savePicture(picture)
        var duration = value(MediaMetadataRetriever.METADATA_KEY_DURATION).toLongOrNull() ?: 0
        var fallback = MediaMetadata.EMPTY
        var inspectionFailed = false
        if (art.first.isEmpty() || duration <= 0) {
            try {
                val inspected = withTimeoutOrNull(15000) {
                    MetadataRetriever.Builder(context, MediaItem.fromUri(uri)).build().use { retriever ->
                        val groups = retriever.retrieveTrackGroups().awaitResult()
                        val builder = MediaMetadata.Builder()
                        for (groupIndex in 0 until groups.length) {
                            val group = groups[groupIndex]
                            for (formatIndex in 0 until group.length) {
                                val tags = group.getFormat(formatIndex).metadata ?: continue
                                for (tagIndex in 0 until tags.length()) tags[tagIndex].populateMediaMetadata(builder)
                            }
                        }
                        builder.build() to (if (duration <= 0) retriever.retrieveDurationUs().awaitResult() / 1000 else duration)
                    }
                }
                if (inspected == null) inspectionFailed = true else {
                    fallback = inspected.first
                    if (duration <= 0) duration = inspected.second.coerceAtLeast(0)
                    if (art.first.isEmpty()) art = savePicture(fallback.artworkData)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { inspectionFailed = true }
        }
        Track(stableId(tree, entry.documentId), tree, entry.documentId, folderId, uri, entry.name, entry.size, entry.modified,
            value(MediaMetadataRetriever.METADATA_KEY_TITLE).ifBlank { fallback.title?.toString().orEmpty().ifBlank { entry.name.substringBeforeLast('.') } },
            value(MediaMetadataRetriever.METADATA_KEY_ARTIST).ifBlank { fallback.artist?.toString().orEmpty().ifBlank { "Unknown artist" } },
            value(MediaMetadataRetriever.METADATA_KEY_ALBUM).ifBlank { fallback.albumTitle?.toString().orEmpty() },
            value(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST).ifBlank { fallback.albumArtist?.toString().orEmpty() },
            value(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER).substringBefore('/').toIntOrNull() ?: fallback.trackNumber ?: 0,
            value(MediaMetadataRetriever.METADATA_KEY_YEAR).ifBlank { fallback.releaseYear?.toString().orEmpty() },
            value(MediaMetadataRetriever.METADATA_KEY_GENRE).ifBlank { fallback.genre?.toString().orEmpty() }, duration,
            art.first, art.second, when {
                duration <= 0 -> "Provider or decoder did not expose duration; metadata will be retried."
                inspectionFailed -> "Artwork inspection failed; metadata will be retried."
                else -> ""
            })
    } }

    private fun savePicture(bytes: ByteArray?): Pair<String, String> {
        if (bytes == null || bytes.size > 16 * 1024 * 1024) return "" to ""
        val key = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        return artwork.save("embedded-$key", bytes)
    }
}

private suspend fun <T> ListenableFuture<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel(true) }
    addListener({
        try { continuation.resume(get()) { _, _, _ -> } }
        catch (error: Exception) { continuation.resumeWithException(error.cause ?: error) }
    }, MoreExecutors.directExecutor())
}
