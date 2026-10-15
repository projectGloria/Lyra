package com.lyra.sona.android.library

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.util.ArrayDeque

interface DocumentSource {
    suspend fun validate(tree: String): String
    fun rootId(tree: String): String
    fun uri(tree: String, documentId: String): String
    suspend fun children(tree: String, documentId: String): List<DocumentEntry>
    suspend fun cover(tree: String, entry: DocumentEntry): String
}

fun interface MetadataSource {
    suspend fun read(tree: String, folderId: String, entry: DocumentEntry, uri: String): Track
}

/** Pure orchestration shared by production SAF scanning and the synthetic host benchmark. */
class ScanEngine(private val documents: DocumentSource, private val metadata: MetadataSource) {
    suspend fun scan(tree: String, previous: List<Track>, progress: (ScanProgress) -> Unit = {}): ScanResult = coroutineScope {
        val started = System.nanoTime()
        val cache = previous.filter { it.tree == tree }.associateBy { it.documentId }
        val pending = ArrayDeque<Pair<String, String>>()
        pending.add(documents.rootId(tree) to "Liked Songs")
        val visited = mutableSetOf<String>()
        val folders = mutableListOf<Folder>()
        val candidates = mutableListOf<Pair<String, DocumentEntry>>()
        val rootId = documents.rootId(tree)
        while (pending.isNotEmpty()) {
            currentCoroutineContext().ensureActive()
            val (folderDocument, name) = pending.removeFirst()
            if (!visited.add(folderDocument)) continue
            progress(ScanProgress("Finding folders · $name", candidates.size, 0, true))
            // Any failed listing aborts the scan. Absence must never be inferred from failed IO.
            val entries = documents.children(tree, folderDocument).sortedWith { a, b -> naturalCompare(a.name, b.name) }
            val folderId = stableId(tree, folderDocument)
            val audio = entries.filter { it.isAudio }
            val images = entries.filter { it.isImage }.sortedWith(compareBy<DocumentEntry> {
                when (it.name.substringBeforeLast('.').lowercase()) { "cover" -> 0; "folder" -> 1; "front" -> 2; else -> 3 }
            }.thenComparator { a, b -> naturalCompare(a.name, b.name) })
            var cover = ""
            for (image in images) {
                cover = try { documents.cover(tree, image) } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { "" }
                if (cover.isNotEmpty()) break
            }
            if (audio.isNotEmpty() || folderDocument == rootId) folders += Folder(folderId, tree, folderDocument, name, folderDocument == rootId, cover)
            audio.forEach { candidates += folderId to it }
            entries.filter { it.isDirectory }.forEach { pending.add(it.documentId to it.name) }
        }
        var reads = 0; var reused = 0; var processed = 0
        val tracks = mutableListOf<Track>()
        // Chunked workers cap both metadata concurrency and in-flight coroutine allocation.
        for (batch in candidates.distinctBy { it.second.documentId }.chunked(4)) {
            currentCoroutineContext().ensureActive()
            val results = batch.map { (folderId, entry) ->
                val old = cache[entry.documentId]
                if (old?.matches(entry) == true) {
                    reused++
                    async { old.copy(folderId = folderId) }
                } else {
                    reads++
                    async {
                        try { metadata.read(tree, folderId, entry, documents.uri(tree, entry.documentId)) }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (error: Exception) {
                            Track(stableId(tree, entry.documentId), tree, entry.documentId, folderId, documents.uri(tree, entry.documentId),
                                entry.name, entry.size, entry.modified, entry.name.substringBeforeLast('.'), metadataError = error.message ?: "Metadata unavailable")
                        }
                    }
                }
            }.awaitAll()
            tracks += results; processed += results.size
            progress(ScanProgress("Reading music", processed, candidates.size, true))
        }
        currentCoroutineContext().ensureActive()
        val completedTracks = resolveAlbumArtwork(tracks).sortedWith(trackComparator)
        val completedFolders = folders.map { folder ->
            if (folder.thumbnail.isNotEmpty()) folder else folder.copy(thumbnail = completedTracks.firstOrNull { it.folderId == folder.id && it.thumbnail.isNotEmpty() }?.thumbnail.orEmpty())
        }.sortedWith { a, b -> if (a.isRoot != b.isRoot) if (a.isRoot) -1 else 1 else naturalCompare(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id) }
        // Persist only intrinsic artwork. Otherwise a removed album donor would remain cached forever.
        ScanResult(LibrarySnapshot(tracks.sortedWith(trackComparator), completedFolders), ScanMetrics(completedTracks.size, reads, reused, (System.nanoTime() - started) / 1_000_000))
    }
}
