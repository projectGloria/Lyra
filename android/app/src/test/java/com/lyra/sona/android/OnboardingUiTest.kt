package com.lyra.sona.android

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.lyra.sona.android.library.FOLDER_HINT
import com.lyra.sona.android.ui.LyraApp
import com.lyra.sona.android.ui.LyraViewModel
import com.lyra.sona.android.ui.PlaybackUi
import com.lyra.sona.android.playback.mediaItem
import com.lyra.sona.android.playback.withQueueFlag
import androidx.test.core.app.ApplicationProvider
import org.junit.Rule
import org.junit.Test
import org.junit.Before
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Host Compose semantics tests, not phone rendering or playback verification. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = LyraApplication::class, qualifiers = "w411dp-h891dp")
class OnboardingUiTest {
    @get:Rule val compose = createComposeRule()
    @Before fun isolateUiFromSystemMediaBinding() {
        val app = ApplicationProvider.getApplicationContext<LyraApplication>()
        // Robolectric cannot bind a real system media service. These tests cover UI semantics only.
        org.robolectric.Shadows.shadowOf(app).declareComponentUnbindable(android.content.ComponentName(app, com.lyra.sona.android.playback.PlaybackService::class.java))
    }
    @Test fun firstRunExplainsRestrictionsAndPickerNeedsAnExplicitAction() {
        val app = ApplicationProvider.getApplicationContext<LyraApplication>()
        val model = LyraViewModel(app)
        var opened = false
        compose.setContent { LyraApp(model) { opened = true } }
        compose.onNodeWithText(FOLDER_HINT).assertExists()
        compose.onNodeWithText("Choose music folder").performScrollTo().performClick()
        compose.onNodeWithText("Open folder picker").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Bring your library").assertExists()
        org.junit.Assert.assertFalse(opened)
        compose.onNodeWithText("Choose music folder").performScrollTo().performClick()
        compose.onNodeWithText("Open folder picker").performClick()
        org.junit.Assert.assertTrue(opened)
    }
    @Test fun rejectionShowsRecoveryWithoutHidingOnboarding() {
        val model = LyraViewModel(ApplicationProvider.getApplicationContext<LyraApplication>())
        model.selectionError.value = "Android rejected access. Your previous library has not changed."
        compose.setContent { LyraApp(model) {} }
        compose.onNodeWithText("Choose another folder").assertExists()
        compose.onNodeWithText("Bring your library").assertExists()
        compose.onNodeWithContentDescription("Dismiss message").performClick()
        compose.onNodeWithText("Android rejected access. Your previous library has not changed.").assertDoesNotExist()
    }
    @Test fun playerHidesPlaylistQueueAndVolumeHintButShowsExplicitAdds() {
        val model = LyraViewModel(ApplicationProvider.getApplicationContext<LyraApplication>())
        model.setUiActive(false)
        val song = track(audio("song")).copy(title = "Queue UI song").mediaItem()
        val state = PlaybackUi(ready = true, current = song, duration = 1000, queue = listOf(song, song), currentIndex = 0)
        model.playback.value = state
        compose.setContent { LyraApp(model) {} }
        compose.onNodeWithText("Queue UI song").performClick()
        compose.onNodeWithText("NOW PLAYING").assertExists()
        compose.onNodeWithText("Queue · 2").assertDoesNotExist()
        compose.onNodeWithText("Queue · 0").assertDoesNotExist()
        compose.onNodeWithText("Use your phone’s volume buttons to adjust sound.").assertDoesNotExist()
        compose.runOnIdle { model.playback.value = state.copy(queue = listOf(song, song.withQueueFlag(true)), explicitQueue = listOf(1)) }
        compose.onNode(hasScrollAction()).performScrollToIndex(2)
        compose.onNodeWithText("Queue · 1").performScrollTo().performClick()
        compose.onNodeWithText("Your queue · 1").assertExists()
        compose.runOnIdle { model.playback.value = state }
        compose.onNodeWithText("Your queue · 1").assertDoesNotExist()
        compose.onNodeWithText("NOW PLAYING").assertExists()
    }
}
