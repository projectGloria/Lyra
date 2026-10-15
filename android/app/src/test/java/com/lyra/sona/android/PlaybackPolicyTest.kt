package com.lyra.sona.android

import com.lyra.sona.android.playback.*
import org.junit.Assert.*
import org.junit.Test

class PlaybackPolicyTest {
    @Test fun stopsOnFifthFailure() {
        val policy = FailurePolicy()
        val ids = (1..10).map { "$it" }
        repeat(4) { assertFalse(policy.failed(ids[it], ids)) }
        assertTrue(policy.failed("5", ids))
        assertEquals(5, policy.consecutive)
    }
    @Test fun stopsEarlierWhenAllTracksHaveFailed() {
        val policy = FailurePolicy()
        assertFalse(policy.failed("a", listOf("a", "b")))
        assertTrue(policy.failed("b", listOf("a", "b")))
    }
    @Test fun successfulPlaybackResetsFailureStreak() {
        val policy = FailurePolicy()
        repeat(4) { policy.failed("a", listOf("a", "b")) }
        policy.successful()
        assertEquals(0, policy.consecutive)
        assertTrue(policy.failedIds.isEmpty())
        assertFalse(policy.failed("b", listOf("a", "b")))
    }
    @Test fun restorePreservesDuplicatesIndexPositionAndShuffle() {
        val result = reconcileQueue(listOf("a", "b", "a", "c"), 2, 42000, listOf(2, 0, 3, 1), setOf("a", "b", "c"))
        assertEquals(listOf("a", "b", "a", "c"), result.ids)
        assertEquals(2, result.index); assertEquals(42000L, result.positionMs)
        assertEquals(listOf(2, 0, 3, 1), result.order)
    }
    @Test fun removedCurrentTrackAdvancesAndResetsPosition() {
        val result = reconcileQueue(listOf("a", "b", "c"), 1, 42000, listOf(2, 0, 1), setOf("a", "c"))
        assertEquals(listOf("a", "c"), result.ids); assertEquals(1, result.index)
        assertEquals(0L, result.positionMs); assertEquals(listOf(1, 0), result.order)
    }
    @Test fun malformedShuffleAndEmptyQueueAreSafe() {
        assertFalse(validShuffleOrder(listOf(1, 1), 2))
        assertEquals(emptyList<String>(), reconcileQueue(listOf("gone"), 0, 40, listOf(0), emptySet()).ids)
        assertEquals(listOf(0, 1), reconcileQueue(listOf("a", "b"), -1, -40, listOf(1, 1), setOf("a", "b")).order)
    }
}
