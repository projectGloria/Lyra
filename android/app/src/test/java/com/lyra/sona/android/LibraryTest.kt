package com.lyra.sona.android

import com.lyra.sona.android.library.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

internal class FakeDocuments(var folders: Map<String, List<DocumentEntry>>) : DocumentSource {
    var listingFailure = ""
    var rejected = false
    override suspend fun validate(tree: String): String { if (rejected) error("Folder rejected"); return "Music" }
    override fun rootId(tree: String) = "root"
    override fun uri(tree: String, documentId: String) = "$tree/$documentId"
    override suspend fun children(tree: String, documentId: String): List<DocumentEntry> {
        if (documentId == listingFailure) error("Storage disconnected")
        return folders[documentId] ?: emptyList()
    }
    override suspend fun cover(tree: String, entry: DocumentEntry) = "cover:${entry.documentId}"
}
internal fun audio(id: String, name: String = "$id.mp3", size: Long = 100, modified: Long = 1, mime: String? = "audio/mpeg") = DocumentEntry(id, name, mime, size, modified)
internal fun track(entry: DocumentEntry, tree: String = "tree", folder: String = stableId(tree, "root"), error: String = "") =
    Track(stableId(tree, entry.documentId), tree, entry.documentId, folder, "$tree/${entry.documentId}", entry.name, entry.size, entry.modified,
        entry.name.substringBeforeLast('.'), durationMs = 1000, metadataError = error)

class LibraryTest {
    @Test fun oldArtworkMetadataIsReadOnceAfterUpgrade() = runTest {
        val entry = audio("song")
        val source = FakeDocuments(mapOf("root" to listOf(entry)))
        val engine = ScanEngine(source, MetadataSource { tree, folder, file, _ -> track(file, tree, folder) })
        val first = engine.scan("tree", listOf(track(entry).copy(metadataVersion = 0)))
        assertEquals(1, first.metrics.metadataReads)
        assertEquals(0, engine.scan("tree", first.snapshot.tracks).metrics.metadataReads)
    }
    @Test fun unreadablePreferredCoverFallsBackToNextImage() = runTest {
        val source = object : DocumentSource by FakeDocuments(mapOf("root" to listOf(audio("song"),
            DocumentEntry("bad", "cover.jpg", "image/jpeg", 1, 1), DocumentEntry("good", "folder.png", "image/png", 1, 1)))) {
            override suspend fun cover(tree: String, entry: DocumentEntry) = if (entry.documentId == "bad") "" else "good-cover"
        }
        val result = ScanEngine(source, MetadataSource { tree, folder, file, _ -> track(file, tree, folder) }).scan("tree", emptyList())
        assertEquals("good-cover", result.snapshot.folders.single().thumbnail)
        assertEquals("good-cover", resolveLibraryArtwork(result.snapshot.tracks, result.snapshot.folders).single().artwork)
        assertEquals("", result.snapshot.tracks.single().artwork)
    }
    @Test fun embeddedTrackCoverBecomesFolderThumbnailWithoutOverwritingOtherTrackArt() = runTest {
        val source = FakeDocuments(mapOf("root" to listOf(audio("a"), audio("b"))))
        val result = ScanEngine(source, MetadataSource { tree, folder, file, _ ->
            track(file, tree, folder).copy(thumbnail = "small-${file.documentId}", artwork = "large-${file.documentId}")
        }).scan("tree", emptyList())
        assertEquals("small-a", result.snapshot.folders.single().thumbnail)
        assertEquals(listOf("large-a", "large-b"), resolveLibraryArtwork(result.snapshot.tracks, result.snapshot.folders).map { it.artwork })
    }
    @Test fun artworkRecognizesImageMimeAndUppercaseExtensions() {
        assertTrue(DocumentEntry("art", "Cover.JPG", "application/octet-stream", 1, 1).isImage)
        assertTrue(DocumentEntry("art", "Artwork", "image/jpeg", 1, 1).isImage)
        assertFalse(DocumentEntry("folder", "cover.jpg", DIRECTORY_MIME, null, null).isImage)
    }
    @Test fun unknownModificationTimeAndEvictedArtworkRequireRevalidation() {
        val unknownTime = DocumentEntry("song", "song.mp3", "audio/mpeg", 100, null)
        assertFalse(track(unknownTime).matches(unknownTime))
        val zeroTime = unknownTime.copy(modified = 0)
        assertFalse(track(zeroTime).matches(zeroTime))
        val known = audio("song")
        assertFalse(track(known).copy(artwork = "missing-artwork-file").matches(known))
        assertTrue(track(known).matches(known))
    }
    @Test fun audioDetectionHandlesProvidersAndDirectories() {
        for (mime in listOf(null, "application/octet-stream", "application/incorrect", "audio/flac")) {
            for (extension in listOf("MP3", "flac", "m4a", "aac", "wav", "ogg", "opus")) assertTrue(audio("x", "Song.$extension", mime = mime).isAudio)
        }
        assertTrue(audio("x", "unknown.bin", mime = "audio/custom").isAudio)
        assertFalse(audio("x", "song.mp3", mime = DIRECTORY_MIME).isAudio)
        assertFalse(audio("x", "notes.txt", mime = "application/octet-stream").isAudio)
        assertFalse(audio("x", "mp3", mime = null).isAudio)
    }
    @Test fun numberedTracksPrecedeNaturalFilenameFallback() {
        val entries = listOf(track(audio("10", "Song10.mp3")), track(audio("2", "Song2.mp3")),
            track(audio("b", "B.mp3")).copy(trackNumber = 1), track(audio("a", "A.mp3")).copy(trackNumber = 1), track(audio("z", "Z.mp3")).copy(trackNumber = 2))
        assertEquals(listOf("A", "B", "Z", "Song2", "Song10"), entries.sortedWith(trackComparator).map { it.title })
        assertTrue(naturalCompare("Playlist2", "Playlist10") < 0)
        assertTrue(naturalCompare("x999999999999999999999", "x1000000000000000000000") < 0)
    }
    @Test fun recursiveFoldersGroupOnlyDirectChildren() = runTest {
        val source = FakeDocuments(mapOf("root" to listOf(audio("root-song"), DocumentEntry("p10", "Playlist10", DIRECTORY_MIME, null, null),
            DocumentEntry("p2", "Playlist2", DIRECTORY_MIME, null, null)), "p2" to listOf(audio("child"), DocumentEntry("nested", "Nested", DIRECTORY_MIME, null, null)),
            "nested" to listOf(audio("nested-song")), "p10" to emptyList()))
        val result = ScanEngine(source, MetadataSource { tree, folder, entry, _ -> track(entry, tree, folder) }).scan("tree", emptyList())
        assertEquals(listOf("Liked Songs", "Nested", "Playlist2"), result.snapshot.folders.map { it.name })
        assertEquals(stableId("tree", "root"), result.snapshot.tracks.first { it.documentId == "root-song" }.folderId)
        assertEquals(stableId("tree", "nested"), result.snapshot.tracks.first { it.documentId == "nested-song" }.folderId)
        assertEquals(3, result.metrics.metadataReads)
    }
    @Test fun incrementalScanRetriesChangedAndFailedFilesAndPurgesRemoved() = runTest {
        val entries = listOf(audio("unchanged"), audio("changed", size = 101), audio("failed"), audio("new"))
        val source = FakeDocuments(mapOf("root" to entries))
        val reads = mutableListOf<String>()
        val old = listOf(track(audio("unchanged")), track(audio("changed")), track(audio("failed"), error = "bad tags"), track(audio("removed")))
        val result = ScanEngine(source, MetadataSource { tree, folder, entry, _ -> reads += entry.documentId; track(entry, tree, folder) }).scan("tree", old)
        assertEquals(setOf("changed", "failed", "new"), reads.toSet())
        assertEquals(1, result.metrics.reused)
        assertFalse(result.snapshot.tracks.any { it.documentId == "removed" })
        val again = ScanEngine(source, MetadataSource { _, _, _, _ -> error("Unchanged files must not be read") }).scan("tree", result.snapshot.tracks)
        assertEquals(0, again.metrics.metadataReads)
        assertEquals(4, again.metrics.reused)
    }
    @Test fun cacheIdentityIncludesTreeAndFileRename() = runTest {
        val source = FakeDocuments(mapOf("root" to listOf(audio("same", "renamed.mp3"))))
        val result = ScanEngine(source, MetadataSource { tree, folder, entry, _ -> track(entry, tree, folder) }).scan("new-tree", listOf(track(audio("same"), "old-tree")))
        assertEquals(1, result.metrics.metadataReads)
        assertNotEquals(stableId("new-tree", "same"), stableId("old-tree", "same"))
        assertFalse(track(audio("same", "old.mp3")).matches(audio("same", "new.mp3")))
    }
    @Test fun failedMetadataRetainsCandidateAndFilename() = runTest {
        val result = ScanEngine(FakeDocuments(mapOf("root" to listOf(audio("broken")))), MetadataSource { _, _, _, _ -> error("Cannot parse") }).scan("tree", emptyList())
        assertEquals("broken", result.snapshot.tracks.single().title)
        assertEquals("Cannot parse", result.snapshot.tracks.single().metadataError)
    }
    @Test fun albumDonorIsStableAndDoesNotOverwriteIndividualArt() {
        val a = track(audio("a", "Track2.mp3")).copy(album = "Album", artist = "Artist", artwork = "art-a", thumbnail = "small-a")
        val b = track(audio("b", "Track10.mp3")).copy(album = "Album", artist = "Artist", artwork = "art-b", thumbnail = "small-b")
        val c = track(audio("c")).copy(album = "Album", artist = "Artist")
        assertEquals("art-a", resolveAlbumArtwork(listOf(b, c, a)).first { it.id == c.id }.artwork)
        assertEquals("art-a", resolveAlbumArtwork(listOf(a, b, c)).first { it.id == c.id }.artwork)
        assertEquals("art-b", resolveAlbumArtwork(listOf(c, a, b)).first { it.id == b.id }.artwork)
    }
    @Test fun metadataConcurrencyIsBoundedAtFour() = runTest {
        val active = AtomicInteger(); val maximum = AtomicInteger()
        val engine = ScanEngine(FakeDocuments(mapOf("root" to (1..30).map { audio("$it") })), MetadataSource { tree, folder, entry, _ ->
            val count = active.incrementAndGet(); maximum.updateAndGet { maxOf(it, count) }
            delay(20); active.decrementAndGet(); track(entry, tree, folder)
        })
        engine.scan("tree", emptyList())
        assertEquals(4, maximum.get())
    }
    @Test fun cancellationDoesNotReturnPartialSnapshot() = runTest {
        var returned = false
        val engine = ScanEngine(FakeDocuments(mapOf("root" to (1..50).map { audio("$it") })), MetadataSource { tree, folder, entry, _ -> delay(100); track(entry, tree, folder) })
        val job = launch { engine.scan("tree", emptyList()); returned = true }
        delay(110); job.cancelAndJoin()
        assertFalse(returned)
    }
}
