package com.lyra.sona.android

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ShuffleOrder
import androidx.test.core.app.ApplicationProvider
import com.lyra.sona.android.library.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

/** Review probes assert observed defects, not desired behavior. Kept outside the normal suite. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class ReviewEdgeCasesTest {
    @Test fun unknownFingerprintReusesObsoleteMetadata() = runBlocking {
        val entry = DocumentEntry("song", "song.mp3", "audio/mpeg", null, null)
        val old = track(entry).copy(title = "Old title")
        val source = FakeDocuments(mapOf("root" to listOf(entry)))
        val result = ScanEngine(source, MetadataSource { tree, folder, document, _ ->
            track(document, tree, folder).copy(title = "New title")
        }).scan("tree", listOf(old))
        assertEquals(0, result.metrics.metadataReads)
        assertEquals("Old title", result.snapshot.tracks.single().title)
    }

    @Test fun playNextDoesNotGuaranteeNextUnderShuffle() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        var missed = 0
        for (seed in 0L..19L) {
            val player = ExoPlayer.Builder(context).build()
            try {
                fun item(id: String) = MediaItem.Builder().setMediaId(id).setUri("content://test/$id").build()
                player.setMediaItems(listOf(item("a"), item("b"), item("c")), 0, 0)
                player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(intArrayOf(0, 2, 1), seed))
                player.shuffleModeEnabled = true
                // Exact insertion used by LyraViewModel.enqueue(next = true).
                player.addMediaItem(player.currentMediaItemIndex + 1, item("requested-next"))
                val nextIndex = player.nextMediaItemIndex
                if (nextIndex < 0 || player.getMediaItemAt(nextIndex).mediaId != "requested-next") missed++
            } finally { player.release() }
        }
        println("REVIEW: Play next missed requested track in $missed / 20 deterministic shuffle seeds")
        assertTrue(missed > 0)
    }

    private fun scanIncomplete(extra: Bundle): ScanResult = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        ShadowContentResolver.registerProviderInternal("review.provider", object : ContentProvider() {
            override fun onCreate() = true
            override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor =
                MatrixCursor(projection!!.map { it }.toTypedArray()).apply { extras = extra }
            override fun getType(uri: Uri): String? = null
            override fun insert(uri: Uri, values: ContentValues?): Uri? = null
            override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
            override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
        })
        val tree = "content://review.provider/tree/root"
        val source = AndroidDocuments(context, ArtworkCache(context))
        ScanEngine(source, MetadataSource { _, _, _, _ -> error("Not expected") }).scan(tree, listOf(track(audio("old"), tree)))
    }

    @Test fun loadingProviderReturnsSuccessfulEmptyScan() {
        val result = scanIncomplete(Bundle().apply { putBoolean(DocumentsContract.EXTRA_LOADING, true) })
        assertTrue(result.snapshot.tracks.isEmpty())
        assertEquals(0, result.metrics.discovered)
    }

    @Test fun providerErrorReturnsSuccessfulEmptyScan() {
        val result = scanIncomplete(Bundle().apply { putString(DocumentsContract.EXTRA_ERROR, "Storage temporarily unavailable") })
        assertTrue(result.snapshot.tracks.isEmpty())
        assertEquals(0, result.metrics.discovered)
    }
}
