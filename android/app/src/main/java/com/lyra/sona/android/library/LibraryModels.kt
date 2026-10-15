package com.lyra.sona.android.library

import androidx.room.Entity
import androidx.room.ColumnInfo
import androidx.room.PrimaryKey
import java.security.MessageDigest

const val FOLDER_HINT = "Choose Music or a subfolder containing your songs. On Android 11+, storage roots and the main Download folder cannot be selected. If ‘Use this folder’ is disabled, open an allowed subfolder."
const val DIRECTORY_MIME = "vnd.android.document/directory"
private val AUDIO_EXTENSIONS = setOf("mp3", "flac", "m4a", "aac", "wav", "ogg", "opus")

data class DocumentEntry(val documentId: String, val name: String, val mime: String?, val size: Long?, val modified: Long?) {
    val isDirectory: Boolean get() = mime == DIRECTORY_MIME
    val isAudio: Boolean get() = !isDirectory && (mime?.startsWith("audio/", ignoreCase = true) == true ||
        name.substringAfterLast('.', "").lowercase(java.util.Locale.ROOT) in AUDIO_EXTENSIONS)
    val isImage: Boolean get() = !isDirectory && (mime?.startsWith("image/", ignoreCase = true) == true ||
        name.substringAfterLast('.', "").lowercase(java.util.Locale.ROOT) in setOf("jpg", "jpeg", "png", "webp", "bmp", "gif", "heic", "heif", "avif"))
}

@Entity(tableName = "tracks")
data class Track(
    @PrimaryKey val id: String,
    val tree: String,
    val documentId: String,
    val folderId: String,
    val uri: String,
    val fileName: String,
    val size: Long?,
    val modified: Long?,
    val title: String,
    val artist: String = "Unknown artist",
    val album: String = "",
    val albumArtist: String = "",
    val trackNumber: Int = 0,
    val year: String = "",
    val genre: String = "",
    val durationMs: Long = 0,
    val thumbnail: String = "",
    val artwork: String = "",
    val metadataError: String = "",
    @ColumnInfo(defaultValue = "0") val metadataVersion: Int = 1,
) {
    fun matches(entry: DocumentEntry) = metadataVersion >= 1 && metadataError.isEmpty() && entry.size != null && entry.modified != null &&
        entry.modified > 0 && size == entry.size && modified == entry.modified && fileName == entry.name &&
        (thumbnail.isEmpty() || java.io.File(thumbnail).isFile) && (artwork.isEmpty() || java.io.File(artwork).isFile)
    fun matchesSearch(query: String): Boolean = listOf(title, artist, album, albumArtist, year, genre, fileName)
        .any { it.contains(query, ignoreCase = true) }
}

@Entity(tableName = "folders")
data class Folder(@PrimaryKey val id: String, val tree: String, val documentId: String, val name: String, val isRoot: Boolean, val thumbnail: String = "")

data class LibrarySnapshot(val tracks: List<Track> = emptyList(), val folders: List<Folder> = emptyList(),
    val tree: String = "", val loaded: Boolean = false)
data class ScanProgress(val label: String = "", val processed: Int = 0, val total: Int = 0, val running: Boolean = false)
data class ScanMetrics(val discovered: Int, val metadataReads: Int, val reused: Int, val elapsedMs: Long)
data class ScanResult(val snapshot: LibrarySnapshot, val metrics: ScanMetrics)

fun stableId(tree: String, documentId: String): String = MessageDigest.getInstance("SHA-256")
    .digest("$tree\u0000$documentId".toByteArray()).joinToString("") { "%02x".format(it) }

/** Compare arbitrary-length numeric runs without converting them to machine integers. */
fun naturalCompare(left: String, right: String): Int {
    var a = 0; var b = 0
    while (a < left.length && b < right.length) {
        if (left[a].isDigit() && right[b].isDigit()) {
            val startA = a; val startB = b
            while (a < left.length && left[a].isDigit()) a++
            while (b < right.length && right[b].isDigit()) b++
            val x = left.substring(startA, a).trimStart('0').ifEmpty { "0" }
            val y = right.substring(startB, b).trimStart('0').ifEmpty { "0" }
            val length = x.length.compareTo(y.length)
            if (length != 0) return length
            val digits = x.compareTo(y)
            if (digits != 0) return digits
        } else {
            val order = left[a].lowercaseChar().compareTo(right[b].lowercaseChar())
            if (order != 0) return order
            a++; b++
        }
    }
    val remaining = (left.length - a).compareTo(right.length - b)
    return if (remaining != 0) remaining else left.compareTo(right)
}

val trackComparator = Comparator<Track> { a, b ->
    val numbered = (if (a.trackNumber > 0) 0 else 1).compareTo(if (b.trackNumber > 0) 0 else 1)
    if (numbered != 0) numbered else {
        val number = a.trackNumber.compareTo(b.trackNumber)
        if (number != 0) number else naturalCompare(a.fileName, b.fileName).takeIf { it != 0 } ?: a.id.compareTo(b.id)
    }
}

/** Preserve individual artwork; album fallback never depends on provider enumeration order. */
fun resolveAlbumArtwork(tracks: List<Track>): List<Track> {
    val donors = tracks.filter { it.artwork.isNotEmpty() && it.album.isNotBlank() }
        .sortedWith(trackComparator).groupBy { (it.albumArtist.ifBlank { it.artist }).lowercase() to it.album.lowercase() }
    return tracks.map { track ->
        val donor = donors[(track.albumArtist.ifBlank { track.artist }).lowercase() to track.album.lowercase()]?.firstOrNull()
        if (track.artwork.isEmpty() && donor != null && track.album.isNotBlank()) track.copy(artwork = donor.artwork, thumbnail = donor.thumbnail) else track
    }
}

/** Folder art is a display fallback only; never write it into intrinsic track metadata. */
fun resolveLibraryArtwork(tracks: List<Track>, folders: List<Folder>): List<Track> {
    val covers = folders.associateBy { it.id }
    return resolveAlbumArtwork(tracks).map { track ->
        val cover = covers[track.folderId]?.thumbnail.orEmpty()
        if (track.artwork.isEmpty() && cover.isNotEmpty()) track.copy(thumbnail = cover, artwork = cover) else track
    }
}
