package com.lyra.sona.android

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import com.lyra.sona.android.library.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class ArtworkReaderTest {
    @Test fun media3ReadsEmbeddedFrontCoverWhenPlatformRetrieverHasNoPicture() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val bitmap = Bitmap.createBitmap(24, 24, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
        val png = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        bitmap.recycle()
        fun frame(id: String, payload: ByteArray) = id.toByteArray(Charsets.US_ASCII) +
            ByteBuffer.allocate(4).putInt(payload.size).array() + byteArrayOf(0, 0) + payload
        val tags = frame("TIT2", byteArrayOf(0) + "Embedded song".toByteArray()) +
            frame("APIC", byteArrayOf(0) + "image/png".toByteArray() + byteArrayOf(0, 3, 0) + png)
        val size = byteArrayOf(((tags.size shr 21) and 127).toByte(), ((tags.size shr 14) and 127).toByte(),
            ((tags.size shr 7) and 127).toByte(), (tags.size and 127).toByte())
        val file = File(context.cacheDir, "embedded-cover.mp3")
        // MPEG headers are parsed for metadata only; this test does not decode or play audio.
        val audioFrame = byteArrayOf(0xff.toByte(), 0xfb.toByte(), 0x90.toByte(), 0x64) + ByteArray(413)
        file.outputStream().use { stream ->
            stream.write("ID3".toByteArray()); stream.write(byteArrayOf(3, 0, 0)); stream.write(size); stream.write(tags)
            repeat(20) { stream.write(audioFrame) }
        }
        val entry = DocumentEntry("embedded", file.name, "audio/mpeg", file.length(), 1)
        val result = AndroidMetadata(context, ArtworkCache(context)).read("tree", "folder", entry, Uri.fromFile(file).toString())
        assertEquals("Embedded song", result.title)
        assertTrue("Embedded front cover must be cached", File(result.thumbnail).isFile)
        assertTrue(File(result.artwork).isFile)
        assertTrue(result.durationMs > 0)
        val decoded = BitmapFactory.decodeFile(result.thumbnail)
        assertTrue(Color.red(decoded.getPixel(12, 12)) > 200)
        decoded.recycle()
        file.delete()
        Unit
    }
}
