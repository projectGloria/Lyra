package com.lyra.sona.android.library

import com.lyra.sona.android.data.AppPreferences
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class LibraryRepository(private val dao: LibraryDao, val preferences: AppPreferences, private val source: DocumentSource,
    private val engine: ScanEngine, private val scope: CoroutineScope, private val workerDispatcher: CoroutineDispatcher = Dispatchers.IO) {
    val tree = preferences.tree.stateIn(scope, SharingStarted.Eagerly, "")
    val snapshot: StateFlow<LibrarySnapshot> = combine(dao.observeTracks(), dao.observeFolders(), preferences.tree) { _, _, selected ->
        // Flow notifications can arrive separately even after one Room commit. Read both tables together.
        val cached = dao.snapshot(selected)
        cached.copy(tracks = resolveLibraryArtwork(cached.tracks, cached.folders).sortedWith(trackComparator),
            folders = cached.folders.sortedWith { a, b -> if (a.isRoot != b.isRoot) if (a.isRoot) -1 else 1 else naturalCompare(a.name, b.name) })
    }.stateIn(scope, SharingStarted.Eagerly, LibrarySnapshot())
    val progress = MutableStateFlow(ScanProgress())
    val error = MutableStateFlow("")
    val metrics = MutableStateFlow<ScanMetrics?>(null)
    private val publication = Mutex()
    private var scanJob: Job? = null
    @Volatile private var generation = 0L

    suspend fun validateSelection(tree: String): String = source.validate(tree)
    suspend fun select(tree: String) {
        source.validate(tree)
        val ticket = publication.withLock { scanJob?.cancel(); ++generation }
        scanJob = currentCoroutineContext().job
        try {
            error.value = ""
            progress.value = ScanProgress("Checking new music folder", running = true)
            val result = withContext(workerDispatcher) {
                engine.scan(tree, dao.tracks(tree)) { if (ticket == generation) progress.value = it }
            }
            publication.withLock {
                currentCoroutineContext().ensureActive()
                if (ticket != generation) throw CancellationException("New folder scan superseded")
                // Keep the previous selection visible until the whole new tree has been read.
                withContext(NonCancellable) {
                    dao.replace(tree, result.snapshot)
                    preferences.selectTree(tree)
                    // Cleanup must not turn a committed selection into a reported selection failure.
                    runCatching { dao.retainTree(tree) }
                }
                metrics.value = result.metrics
                progress.value = ScanProgress("${result.metrics.discovered} tracks · ${result.metrics.reused} cached", result.metrics.discovered, result.metrics.discovered)
            }
        } finally {
            if (ticket == generation) progress.value = progress.value.copy(running = false)
        }
    }
    fun refresh(requestedTree: String? = null, supersede: Boolean = false) {
        if (!supersede && scanJob?.isActive == true) return
        scanJob?.cancel()
        val ticket = ++generation
        scanJob = scope.launch(workerDispatcher) {
            val selected = requestedTree ?: preferences.tree.first()
            if (selected.isBlank()) return@launch
            try {
                error.value = ""
                progress.value = ScanProgress("Checking folder access", running = true)
                source.validate(selected)
                val result = engine.scan(selected, dao.tracks(selected)) { if (ticket == generation) progress.value = it }
                publication.withLock {
                    if (ticket == generation && preferences.tree.first() == selected) {
                        dao.replace(selected, result.snapshot)
                        dao.retainTree(selected)
                        metrics.value = result.metrics
                        progress.value = ScanProgress("${result.metrics.discovered} tracks · ${result.metrics.reused} cached", result.metrics.discovered, result.metrics.discovered)
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (ticket == generation) error.value = "${failure.message ?: "The folder could not be read."} Your cached library is preserved. Choose another folder or reconnect storage."
            } finally { if (ticket == generation) progress.value = progress.value.copy(running = false) }
        }
    }
    fun cancelScan() { generation++; scanJob?.cancel(); progress.value = progress.value.copy(label = "Scan cancelled · cached library preserved", running = false) }
}
