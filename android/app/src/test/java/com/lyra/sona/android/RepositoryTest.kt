package com.lyra.sona.android

import com.lyra.sona.android.data.*
import com.lyra.sona.android.library.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

internal class MemoryPreferences : AppPreferences {
    override val tree = MutableStateFlow("tree")
    override val playback = MutableStateFlow(PlaybackSnapshot())
    override suspend fun selectTree(tree: String) { this.tree.value = tree }
    override suspend fun savePlayback(snapshot: PlaybackSnapshot) { playback.value = snapshot }
}
internal class MemoryDao : LibraryDao() {
    val trackState = MutableStateFlow<List<Track>>(emptyList())
    val folderState = MutableStateFlow<List<Folder>>(emptyList())
    var publications = 0
    override fun observeTracks() = trackState
    override fun observeFolders() = folderState
    override suspend fun tracks(tree: String) = trackState.value.filter { it.tree == tree }
    override suspend fun folders(tree: String) = folderState.value.filter { it.tree == tree }
    override suspend fun clearTracks(tree: String) { trackState.value = trackState.value.filter { it.tree != tree } }
    override suspend fun clearFolders(tree: String) { folderState.value = folderState.value.filter { it.tree != tree } }
    override suspend fun clearOtherTracks(tree: String) { trackState.value = trackState.value.filter { it.tree == tree } }
    override suspend fun clearOtherFolders(tree: String) { folderState.value = folderState.value.filter { it.tree == tree } }
    override suspend fun insertTracks(tracks: List<Track>) { trackState.value += tracks }
    override suspend fun insertFolders(folders: List<Folder>) { folderState.value += folders }
    override suspend fun replace(tree: String, snapshot: LibrarySnapshot) { publications++; super.replace(tree, snapshot) }
}
@OptIn(ExperimentalCoroutinesApi::class)
class RepositoryTest {
    @Test fun failedNewTreeScanPreservesPreviousSelectionAndLibrary() = runTest {
        val source = FakeDocuments(emptyMap()).apply { listingFailure = "root" }
        val preferences = MemoryPreferences()
        val dao = MemoryDao().apply { trackState.value = listOf(track(audio("old"))) }
        val repository = LibraryRepository(dao, preferences, source, ScanEngine(source, MetadataSource { _, _, _, _ -> error("unused") }), backgroundScope, StandardTestDispatcher(testScheduler))
        try { repository.select("new-tree"); fail("Expected inaccessible tree") } catch (_: IllegalStateException) { }
        assertEquals("tree", preferences.tree.value)
        assertEquals("old", dao.trackState.value.single().documentId)
        assertEquals(0, dao.publications)
    }
    @Test fun validSelectionPublishesOnlyAfterScanCompletes() = runTest {
        val source = FakeDocuments(mapOf("root" to listOf(audio("new"))))
        val preferences = MemoryPreferences()
        val dao = MemoryDao().apply { trackState.value = listOf(track(audio("old"))) }
        val repository = LibraryRepository(dao, preferences, source, ScanEngine(source, MetadataSource { tree, folder, entry, _ -> delay(100); track(entry, tree, folder) }), backgroundScope, StandardTestDispatcher(testScheduler))
        val selection = launch { repository.select("new-tree") }
        runCurrent(); assertEquals("tree", preferences.tree.value)
        advanceTimeBy(101); runCurrent(); selection.join()
        assertEquals("new-tree", preferences.tree.value)
        assertEquals("new", dao.trackState.value.first { it.tree == "new-tree" }.documentId)
        assertTrue(dao.trackState.value.all { it.tree == "new-tree" })
    }
    @Test fun rejectedSelectionPreservesPreviousTreeAndLibrary() = runTest {
        val source = FakeDocuments(emptyMap()).apply { rejected = true }
        val prefs = MemoryPreferences(); val dao = MemoryDao().apply { trackState.value = listOf(track(audio("old"))) }
        val repository = LibraryRepository(dao, prefs, source, ScanEngine(source, MetadataSource { _, _, _, _ -> error("unused") }), backgroundScope, StandardTestDispatcher(testScheduler))
        try { repository.select("rejected"); fail("Expected rejection") } catch (_: IllegalStateException) { }
        assertEquals("tree", prefs.tree.value); assertEquals("old", dao.trackState.value.single().documentId)
        assertEquals(0, dao.publications)
    }
    @Test fun failedEnumerationNeverPurgesCachedTracks() = runTest {
        val source = FakeDocuments(emptyMap()).apply { listingFailure = "root" }
        val dao = MemoryDao().apply { trackState.value = listOf(track(audio("old"))) }
        val repository = LibraryRepository(dao, MemoryPreferences(), source, ScanEngine(source, MetadataSource { _, _, _, _ -> error("unused") }), backgroundScope, StandardTestDispatcher(testScheduler))
        repository.refresh(); runCurrent()
        assertEquals(0, dao.publications); assertEquals("old", dao.trackState.value.single().documentId)
        assertTrue(repository.error.value.contains("preserved"))
    }
    @Test fun newerScanSupersedesOldAndRefreshesCoalesce() = runTest {
        val source = FakeDocuments(mapOf("root" to listOf(audio("old"))))
        val dao = MemoryDao(); var reads = 0
        val engine = ScanEngine(source, MetadataSource { tree, folder, entry, _ -> reads++; delay(100); track(entry, tree, folder) })
        val repository = LibraryRepository(dao, MemoryPreferences(), source, engine, backgroundScope, StandardTestDispatcher(testScheduler))
        repository.refresh(); runCurrent(); repository.refresh(); runCurrent()
        assertEquals(1, reads)
        source.folders = mapOf("root" to listOf(audio("new")))
        repository.refresh(supersede = true); runCurrent(); advanceTimeBy(101); runCurrent()
        assertEquals(1, dao.publications); assertEquals("new", dao.trackState.value.single().documentId)
    }
    @Test fun cancelledScanKeepsExistingSnapshot() = runTest {
        val source = FakeDocuments(mapOf("root" to listOf(audio("new"))))
        val dao = MemoryDao().apply { trackState.value = listOf(track(audio("old"))) }
        val engine = ScanEngine(source, MetadataSource { tree, folder, entry, _ -> delay(100); track(entry, tree, folder) })
        val repository = LibraryRepository(dao, MemoryPreferences(), source, engine, backgroundScope, StandardTestDispatcher(testScheduler))
        repository.refresh(); runCurrent(); repository.cancelScan(); advanceTimeBy(101); runCurrent()
        assertEquals(0, dao.publications); assertEquals("old", dao.trackState.value.single().documentId)
    }
}
