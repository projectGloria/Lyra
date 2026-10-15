package com.lyra.sona.android

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.graphics.Bitmap
import android.graphics.Color
import android.provider.DocumentsContract
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ShuffleOrder
import androidx.test.core.app.ApplicationProvider
import com.lyra.sona.android.library.*
import com.lyra.sona.android.playback.enqueueItems
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Actual provider cursors and Media3 traversal, without audio decoding. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class ProviderRegressionTest {
    private open class Provider : ContentProvider() {
        override fun onCreate() = true
        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor = MatrixCursor(projection!!.map { it }.toTypedArray())
        override fun getType(uri: Uri): String? = null
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
    }

    @Test fun folderArtworkWithoutFingerprintUsesNewImageContent() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val file = File(context.cacheDir, "review-cover.jpg")
        fun write(color: Int) {
            val bitmap = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
            bitmap.recycle()
        }
        ShadowContentResolver.registerProviderInternal("review.cover", object : Provider() {
            override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        }.apply {
            attachInfo(context, android.content.pm.ProviderInfo().apply { authority = "review.cover"; applicationInfo = context.applicationInfo })
        })
        val source = AndroidDocuments(context, ArtworkCache(context))
        val entry = DocumentEntry("cover", "cover.jpg", "image/jpeg", null, null)
        write(Color.RED)
        val first = source.cover("content://review.cover/tree/root", entry)
        write(Color.BLUE)
        val second = source.cover("content://review.cover/tree/root", entry)
        assertTrue(first.isNotEmpty())
        assertTrue(second.isNotEmpty())
        assertNotEquals(first, second)
    }

    @Test fun cancellingStalledQuerySignalsProviderAndReleasesScanWorker() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val started = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        ShadowContentResolver.registerProviderInternal("review.slow", object : Provider() {
            override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?, signal: CancellationSignal?): Cursor {
                signal?.setOnCancelListener { cancelled.countDown() }
                started.countDown()
                cancelled.await(2, TimeUnit.SECONDS)
                signal?.throwIfCanceled()
                return super.query(uri, projection, selection, selectionArgs, sortOrder)
            }
        })
        val source = AndroidDocuments(context, ArtworkCache(context))
        val job = launch(Dispatchers.Default) { source.children("content://review.slow/tree/root", "root") }
        try {
            assertTrue(withContext(Dispatchers.IO) { started.await(2, TimeUnit.SECONDS) })
            job.cancelAndJoin()
            assertEquals(0L, cancelled.count)
        } finally { job.cancelAndJoin() }
    }
    @Test fun unknownFingerprintRefreshesChangedMetadata() = runBlocking {
        val entry = DocumentEntry("song", "song.mp3", "audio/mpeg", null, null)
        val old = track(entry).copy(title = "Old title")
        val source = FakeDocuments(mapOf("root" to listOf(entry)))
        val result = ScanEngine(source, MetadataSource { tree, folder, document, _ ->
            track(document, tree, folder).copy(title = "New title")
        }).scan("tree", listOf(old))
        assertEquals(1, result.metrics.metadataReads)
        assertEquals("New title", result.snapshot.tracks.single().title)
    }

    @Test fun playNextAlwaysFollowsCurrentUnderShuffle() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        var missed = 0
        for (seed in 0L..19L) {
            val player = ExoPlayer.Builder(context).build()
            try {
                fun item(id: String) = MediaItem.Builder().setMediaId(id).setUri("content://test/$id").build()
                player.setMediaItems(listOf(item("a"), item("b"), item("c")), 0, 0)
                player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(intArrayOf(0, 2, 1), seed))
                player.shuffleModeEnabled = true
                enqueueItems(player, listOf(item("requested-next")), next = true)
                val nextIndex = player.nextMediaItemIndex
                if (nextIndex < 0 || player.getMediaItemAt(nextIndex).mediaId != "requested-next") missed++
            } finally { player.release() }
        }
        assertEquals(0, missed)
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

    @Test fun loadingProviderAbortsScanInsteadOfPublishingMissingFiles() {
        try {
            scanIncomplete(Bundle().apply { putBoolean(DocumentsContract.EXTRA_LOADING, true) })
            fail("An incomplete cursor must not become a successful empty scan")
        } catch (error: IllegalStateException) { assertTrue(error.message.orEmpty().contains("still loading")) }
    }

    @Test fun providerErrorAbortsScanInsteadOfPublishingMissingFiles() {
        try {
            scanIncomplete(Bundle().apply { putString(DocumentsContract.EXTRA_ERROR, "Storage temporarily unavailable") })
            fail("A provider error must not become a successful empty scan")
        } catch (error: IllegalStateException) { assertTrue(error.message.orEmpty().contains("temporarily unavailable")) }
    }
}
