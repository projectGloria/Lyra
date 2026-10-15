package com.lyra.sona.android.playback

/** Small deterministic policy so player failures cannot produce an infinite retry loop. */
class FailurePolicy {
    var consecutive = 0
        private set
    val failedIds = mutableSetOf<String>()
    fun failed(id: String, queueIds: List<String>): Boolean {
        consecutive++
        failedIds += id
        return consecutive >= 5 || queueIds.isEmpty() || queueIds.all { it in failedIds }
    }
    fun successful() { consecutive = 0; failedIds.clear() }
}

fun validShuffleOrder(order: List<Int>, size: Int): Boolean = order.size == size && order.toSet() == (0 until size).toSet()

data class RestoredQueue(val ids: List<String>, val index: Int, val positionMs: Long, val order: List<Int>)
fun reconcileQueue(ids: List<String>, currentIndex: Int, positionMs: Long, order: List<Int>, available: Set<String>): RestoredQueue {
    val retained = ids.indices.filter { ids[it] in available }
    val nextIds = retained.map { ids[it] }
    val retainedIndex = retained.indexOf(currentIndex)
    val index = if (retainedIndex >= 0) retainedIndex else retained.indexOfFirst { it > currentIndex }.let { if (it < 0) 0 else it }
    val oldToNew = retained.withIndex().associate { it.value to it.index }
    val nextOrder = if (validShuffleOrder(order, ids.size)) order.mapNotNull { oldToNew[it] } else nextIds.indices.toList()
    return RestoredQueue(nextIds, index, if (retainedIndex >= 0) positionMs.coerceAtLeast(0) else 0, nextOrder)
}
