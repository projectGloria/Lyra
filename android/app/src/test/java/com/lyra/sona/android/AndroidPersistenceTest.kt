package com.lyra.sona.android

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.lyra.sona.android.data.PlaybackSnapshot
import com.lyra.sona.android.library.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class AndroidPersistenceTest {
    @Test fun upgradeRetainsCachedLibraryAndMarksOldMetadataForOneRescan() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val name = "artwork-upgrade-test.db"
        context.deleteDatabase(name)
        var db = Room.databaseBuilder(context, LibraryDatabase::class.java, name).build()
        val song = track(audio("saved"))
        val folder = Folder(song.folderId, "tree", "root", "Liked Songs", true)
        db.library().replace("tree", LibrarySnapshot(listOf(song), listOf(folder)))
        val sqlite = db.openHelper.writableDatabase
        val create = sqlite.query("SELECT sql FROM sqlite_master WHERE name='tracks'").use { it.moveToFirst(); it.getString(0) }
        val oldCreate = create.replace("`tracks`", "`old_tracks`").replace(", `metadataVersion` INTEGER NOT NULL DEFAULT 0", "")
        assertFalse(oldCreate.contains("metadataVersion"))
        val columns = sqlite.query("PRAGMA table_info(tracks)").use { cursor ->
            buildList { while (cursor.moveToNext()) if (cursor.getString(1) != "metadataVersion") add("`${cursor.getString(1)}`") }.joinToString(",")
        }
        sqlite.execSQL(oldCreate)
        sqlite.execSQL("INSERT INTO old_tracks ($columns) SELECT $columns FROM tracks")
        sqlite.execSQL("DROP TABLE tracks")
        sqlite.execSQL("ALTER TABLE old_tracks RENAME TO tracks")
        sqlite.execSQL("DELETE FROM room_master_table")
        sqlite.version = 1
        db.close()
        db = Room.databaseBuilder(context, LibraryDatabase::class.java, name).addMigrations(LibraryDatabase.ARTWORK_MIGRATION).build()
        val restored = db.library().snapshot("tree")
        assertEquals(song.copy(metadataVersion = 0), restored.tracks.single())
        assertEquals(folder, restored.folders.single())
        assertFalse(restored.tracks.single().matches(audio("saved")))
        db.close(); context.deleteDatabase(name); Unit
    }
    @Test fun artworkBudgetAndPruningRetainCurrentCoverAndRemoveOrphans() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
        val initial = ArtworkCache(context).save("playing", bytes)
        val pairSize = java.io.File(initial.first).length() + java.io.File(initial.second).length()
        val cache = ArtworkCache(context, maxBytes = pairSize * 2 + 10)
        cache.protectCurrent(setOf(initial.first, initial.second))
        repeat(20) { cache.save("evict-$it", bytes) }
        val directory = java.io.File(context.filesDir, "artwork")
        assertTrue(directory.listFiles().orEmpty().sumOf { it.length() } <= pairSize * 2 + 10)
        assertTrue(java.io.File(initial.first).isFile)
        assertTrue(java.io.File(initial.second).isFile)
        cache.prune(emptySet())
        assertEquals(setOf(initial.first, initial.second), directory.listFiles().orEmpty().map { it.absolutePath }.toSet())
        cache.protectCurrent(emptySet())
        cache.prune(emptySet())
        assertTrue(directory.listFiles().orEmpty().isEmpty())
        bitmap.recycle()
    }
    @Test fun playbackSnapshotSurvivesSerializationAsPausedRestorationData() {
        val saved = PlaybackSnapshot(listOf("a", "b", "a"), 2, 54321, true, 2, listOf(2, 0, 1), listOf(0, 1))
        assertEquals(saved, PlaybackSnapshot.decode(saved.encode()))
        assertEquals(PlaybackSnapshot(), PlaybackSnapshot.decode("broken JSON"))
        // Playing is deliberately not persisted: service restoration is always paused.
        assertFalse(saved.encode().contains("playWhenReady"))
        assertTrue(PlaybackSnapshot.decode("{\"queue\":[\"a\",\"b\"]}").explicitQueue.isEmpty())
    }
    @Test fun roomCacheSurvivesDatabaseRecreationAndScopesTrees() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val name = "persistence-test.db"
        context.deleteDatabase(name)
        var database = Room.databaseBuilder(context, LibraryDatabase::class.java, name).build()
        val old = track(audio("old"))
        database.library().replace("tree", LibrarySnapshot(listOf(old), listOf(Folder(stableId("tree", "root"), "tree", "root", "Liked Songs", true))))
        database.close()
        database = Room.databaseBuilder(context, LibraryDatabase::class.java, name).build()
        assertEquals(old, database.library().tracks("tree").single())
        assertTrue(database.library().tracks("other-tree").isEmpty())
        database.library().replace("tree", LibrarySnapshot())
        assertTrue(database.library().tracks("tree").isEmpty())
        database.close(); context.deleteDatabase(name); Unit
    }
    @Test fun artworkThumbnailsAndPlayerImagesAreBounded() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val bitmap = Bitmap.createBitmap(4096, 3072, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
        val paths = ArtworkCache(context).save("large-test", bytes)
        for ((path, bound) in listOf(paths.first to 256, paths.second to 1024)) {
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, options)
            assertTrue(options.outWidth in 1..bound); assertTrue(options.outHeight in 1..bound)
        }
        bitmap.recycle()
    }
}
