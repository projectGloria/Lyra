package com.lyra.sona.android.data

import android.content.Context
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** Device-only measurements. Host benchmark timings are deliberately recorded elsewhere. */
class PerformanceRecorder(context: Context, private val scope: CoroutineScope) {
    private val started = SystemClock.elapsedRealtime()
    private val visible = AtomicBoolean(false)
    private val output = File(context.filesDir, "performance-events.jsonl")
    fun cachedLibraryVisible(tracks: Int) {
        if (!visible.compareAndSet(false, true)) return
        record(JSONObject().put("event", "first_usable_library").put("tracks", tracks).put("elapsedMs", SystemClock.elapsedRealtime() - started))
    }
    fun scanned(tracks: Int, elapsedMs: Long, reads: Int, reused: Int) {
        record(JSONObject().put("event", "scan_completed").put("tracks", tracks).put("elapsedMs", elapsedMs).put("metadataReads", reads).put("reused", reused))
    }
    private fun record(data: JSONObject) {
        data.put("device", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}").put("sdk", android.os.Build.VERSION.SDK_INT)
            .put("recordedAtMs", System.currentTimeMillis())
        Log.i("LyraPerformance", data.toString())
        scope.launch(Dispatchers.IO) { synchronized(output.absolutePath.intern()) { output.appendText(data.toString() + "\n") } }
    }
}
