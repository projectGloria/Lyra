package com.lyra.sona.android

import android.app.Application
import androidx.room.Room
import com.lyra.sona.android.data.Preferences
import com.lyra.sona.android.library.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.withContext

class LyraApplication : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val database by lazy { Room.databaseBuilder(this, LibraryDatabase::class.java, "library.db").addMigrations(LibraryDatabase.ARTWORK_MIGRATION).build() }
    val preferences by lazy { Preferences(this) }
    val artwork by lazy { ArtworkCache(this) }
    val documents by lazy { AndroidDocuments(this, artwork) }
    val library by lazy { LibraryRepository(database.library(), preferences, documents, ScanEngine(documents, AndroidMetadata(this, artwork)), scope) }
    val playbackMessage = MutableStateFlow("")
    lateinit var performance: com.lyra.sona.android.data.PerformanceRecorder
        private set
    override fun onCreate() {
        super.onCreate()
        performance = com.lyra.sona.android.data.PerformanceRecorder(this, scope)
        scope.launch {
            library.metrics.collect { it?.let { metrics -> performance.scanned(metrics.discovered, metrics.elapsedMs, metrics.metadataReads, metrics.reused) } }
        }
        scope.launch {
            combine(library.snapshot, library.progress) { snapshot, progress -> snapshot.takeIf { it.loaded && !progress.running } }
                .collect { snapshot ->
                    if (snapshot != null) withContext(Dispatchers.IO) {
                        val paths = snapshot.tracks.flatMap { listOf(it.thumbnail, it.artwork) } + snapshot.folders.map { it.thumbnail }
                        artwork.prune(paths.filter { it.isNotEmpty() }.toSet()) {
                            !library.progress.value.running && library.snapshot.value == snapshot
                        }
                    }
                }
        }
    }
}
