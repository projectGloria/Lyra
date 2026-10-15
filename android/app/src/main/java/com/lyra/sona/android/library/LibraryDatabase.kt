package com.lyra.sona.android.library

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

@Dao
abstract class LibraryDao {
    @Query("SELECT * FROM tracks") abstract fun observeTracks(): Flow<List<Track>>
    @Query("SELECT * FROM folders") abstract fun observeFolders(): Flow<List<Folder>>
    @Query("SELECT * FROM tracks WHERE tree = :tree") abstract suspend fun tracks(tree: String): List<Track>
    @Query("SELECT * FROM folders WHERE tree = :tree") abstract suspend fun folders(tree: String): List<Folder>
    @Query("DELETE FROM tracks WHERE tree = :tree") abstract suspend fun clearTracks(tree: String)
    @Query("DELETE FROM folders WHERE tree = :tree") abstract suspend fun clearFolders(tree: String)
    @Query("DELETE FROM tracks WHERE tree != :tree") abstract suspend fun clearOtherTracks(tree: String)
    @Query("DELETE FROM folders WHERE tree != :tree") abstract suspend fun clearOtherFolders(tree: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun insertTracks(tracks: List<Track>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) abstract suspend fun insertFolders(folders: List<Folder>)
    @Transaction open suspend fun replace(tree: String, snapshot: LibrarySnapshot) {
        clearTracks(tree); clearFolders(tree)
        insertTracks(snapshot.tracks); insertFolders(snapshot.folders)
    }
    @Transaction open suspend fun snapshot(tree: String) = LibrarySnapshot(tracks(tree), folders(tree), tree, loaded = true)
    @Transaction open suspend fun retainTree(tree: String) { clearOtherTracks(tree); clearOtherFolders(tree) }
}

@Database(entities = [Track::class, Folder::class], version = 2, exportSchema = false)
abstract class LibraryDatabase : RoomDatabase() {
    abstract fun library(): LibraryDao
    companion object {
        val ARTWORK_MIGRATION = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE tracks ADD COLUMN metadataVersion INTEGER NOT NULL DEFAULT 0")
            }
        }
    }
}
