package com.lyra.sona.android.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

private val Context.lyraDataStore by preferencesDataStore("lyra")

data class PlaybackSnapshot(val queue: List<String> = emptyList(), val index: Int = 0, val positionMs: Long = 0,
    val shuffle: Boolean = false, val repeat: Int = 0, val shuffleOrder: List<Int> = emptyList(), val explicitQueue: List<Int> = emptyList()) {
    fun encode(): String = JSONObject().put("queue", JSONArray(queue)).put("index", index).put("position", positionMs)
        .put("shuffle", shuffle).put("repeat", repeat).put("order", JSONArray(shuffleOrder)).put("explicitQueue", JSONArray(explicitQueue)).toString()
    companion object {
        fun decode(raw: String): PlaybackSnapshot = try {
            val json = JSONObject(raw)
            val queue = json.optJSONArray("queue") ?: JSONArray()
            val order = json.optJSONArray("order") ?: JSONArray()
            val explicit = json.optJSONArray("explicitQueue") ?: JSONArray()
            PlaybackSnapshot(List(queue.length()) { queue.getString(it) }, json.optInt("index"), json.optLong("position"),
                json.optBoolean("shuffle"), json.optInt("repeat").coerceIn(0, 2), List(order.length()) { order.getInt(it) },
                List(explicit.length()) { explicit.getInt(it) }.filter { it in 0 until queue.length() }.distinct())
        } catch (_: Exception) { PlaybackSnapshot() }
    }
}

interface AppPreferences {
    val tree: Flow<String>
    val playback: Flow<PlaybackSnapshot>
    suspend fun selectTree(tree: String)
    suspend fun savePlayback(snapshot: PlaybackSnapshot)
}

class Preferences(context: Context) : AppPreferences {
    private val store = context.lyraDataStore
    private val treeKey = stringPreferencesKey("tree")
    private val playbackKey = stringPreferencesKey("playback")
    private val safeData = store.data.catch { if (it is IOException) emit(androidx.datastore.preferences.core.emptyPreferences()) else throw it }
    override val tree: Flow<String> = safeData.map { it[treeKey].orEmpty() }
    override val playback: Flow<PlaybackSnapshot> = safeData.map { PlaybackSnapshot.decode(it[playbackKey].orEmpty()) }
    override suspend fun selectTree(tree: String) { store.edit { it[treeKey] = tree } }
    override suspend fun savePlayback(snapshot: PlaybackSnapshot) {
        val serialized = withContext(Dispatchers.IO) { snapshot.encode() }
        store.edit { it[playbackKey] = serialized }
    }
}
