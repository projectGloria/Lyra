package com.lyra.sona.android.ui

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.content.Intent
import android.provider.Settings
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.QueueMusic
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.Lifecycle
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.navigation.NavType
import androidx.navigation.compose.*
import androidx.navigation.navArgument
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.lyra.sona.android.R
import com.lyra.sona.android.library.*
import java.io.File

private val Gold = Color(0xFFC9A94A)
private val Background = Color(0xFF0D0D0F)
private val Surface = Color(0xFF1C1C20)
private val Muted = Color(0xFFB9B3AA)
private val LyraColors = darkColorScheme(primary = Gold, onPrimary = Background, background = Background, surface = Surface,
    onBackground = Color(0xFFE8E4DC), onSurface = Color(0xFFE8E4DC), secondary = Gold, outline = Color(0xFF494641))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LyraApp(model: LyraViewModel, openPicker: () -> Unit) {
    MaterialTheme(colorScheme = LyraColors) {
        val nav = rememberNavController()
        val backStack by nav.currentBackStackEntryAsState()
        val route = backStack?.destination?.route ?: "library"
        val library by model.library.snapshot.collectAsStateWithLifecycle()
        val tree by model.library.tree.collectAsStateWithLifecycle()
        val progress by model.library.progress.collectAsStateWithLifecycle()
        val scanError by model.library.error.collectAsStateWithLifecycle()
        val selectionError by model.selectionError.collectAsStateWithLifecycle()
        val playbackMessage by model.graph.playbackMessage.collectAsStateWithLifecycle()
        val playback by model.playback.collectAsStateWithLifecycle()
        val selecting by model.selecting.collectAsStateWithLifecycle()
        var showHint by rememberSaveable { mutableStateOf(false) }
        val choose = { showHint = true }
        val navigate: (String) -> Unit = { target -> nav.navigate(target) { launchSingleTop = true } }
        Scaffold(
            topBar = {
                TopAppBar(title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Image(painterResource(R.drawable.lyra_logo), null, Modifier.size(30.dp))
                        Text("Lyra", fontWeight = FontWeight.SemiBold, color = Gold)
                    }
                }, navigationIcon = {
                    if (route !in listOf("library", "search", "settings")) Control(Icons.AutoMirrored.Outlined.ArrowBack, "Go back") { nav.popBackStack() }
                }, actions = {
                    if (tree.isNotEmpty()) Control(if (progress.running) Icons.Outlined.Close else Icons.Outlined.Refresh,
                        if (progress.running) "Cancel scan" else "Refresh library") { if (progress.running) model.library.cancelScan() else model.refresh() }
                }, colors = TopAppBarDefaults.topAppBarColors(containerColor = Background))
            },
            bottomBar = {
                Column {
                    if (playback.current != null && route != "player") MiniPlayer(playback, model) { navigate("player") }
                    if (route in listOf("library", "search", "settings")) NavigationBar(containerColor = Background) {
                        listOf(Triple("library", "Library", Icons.Outlined.LibraryMusic), Triple("search", "Search", Icons.Outlined.Search), Triple("settings", "Settings", Icons.Outlined.Settings)).forEach { (target, label, icon) ->
                            NavigationBarItem(selected = route == target, onClick = {
                                nav.navigate(target) { popUpTo("library") { saveState = true }; launchSingleTop = true; restoreState = true }
                            }, icon = { Icon(icon, label) }, label = { Text(label) })
                        }
                    }
                }
            }, containerColor = Background
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
                val message = selectionError.ifEmpty { scanError }.ifEmpty { playbackMessage }
                if (message.isNotEmpty()) MessageCard(message, onChoose = if (selectionError.isNotEmpty() || scanError.isNotEmpty()) choose else null) {
                    model.selectionError.value = ""; model.library.error.value = ""; model.graph.playbackMessage.value = ""
                }
                if (progress.running) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp)) {
                        Text(if (progress.total > 0) "${progress.label} · ${progress.processed}/${progress.total}" else progress.label, style = MaterialTheme.typography.labelMedium, color = Muted)
                        Spacer(Modifier.height(4.dp))
                        if (progress.total > 0) LinearProgressIndicator(progress = { progress.processed.toFloat() / progress.total }, modifier = Modifier.fillMaxWidth())
                        else LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                }
                NavHost(nav, startDestination = "library", modifier = Modifier.weight(1f)) {
                    composable("library") { LibraryScreen(library, tree.isNotEmpty(), selecting, progress.running, choose) { navigate("playlist/$it") } }
                    composable("search") { SearchScreen(library, model) { navigate("playlist/$it") } }
                    composable("settings") { SettingsScreen(tree, model, choose) }
                    composable("playlist/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                        val id = entry.arguments?.getString("id")
                        PlaylistScreen(library.folders.firstOrNull { it.id == id }, library.tracks.filter { it.folderId == id }, model)
                    }
                    composable("player") { PlayerScreen(playback, model) { navigate("queue") } }
                    composable("queue") {
                        LaunchedEffect(playback.explicitQueue.isEmpty()) { if (playback.explicitQueue.isEmpty()) nav.popBackStack() }
                        QueueScreen(playback, model)
                    }
                }
            }
        }
        if (showHint) AlertDialog(onDismissRequest = { showHint = false }, title = { Text("Choose your music folder") },
            text = { Text(FOLDER_HINT) }, confirmButton = { TextButton(onClick = { showHint = false; openPicker() }) { Text("Open folder picker") } },
            dismissButton = { TextButton(onClick = { showHint = false }) { Text("Cancel") } })
    }
}

@Composable
private fun LibraryScreen(library: LibrarySnapshot, selected: Boolean, selecting: Boolean, scanning: Boolean, choose: () -> Unit, open: (String) -> Unit) {
    val graph = LocalContext.current.applicationContext as com.lyra.sona.android.LyraApplication
    LaunchedEffect(library.tracks.isNotEmpty()) { if (library.tracks.isNotEmpty()) graph.performance.cachedLibraryVisible(library.tracks.size) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Text("Your music.\nYour space.", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(10.dp))
            Text(if (selected) "${library.tracks.size} tracks · ${library.folders.count { !it.isRoot }} folder playlists" else "A home for the music you already own.", color = Muted)
        }
        if (!selected) item {
            Card(colors = CardDefaults.cardColors(containerColor = Surface)) {
                Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Icon(Icons.Outlined.FolderOpen, null, tint = Gold, modifier = Modifier.size(44.dp))
                    Text("Bring your library", style = MaterialTheme.typography.titleLarge)
                    Text("Each folder with audio becomes a playlist. Tracks directly in your chosen folder appear in Liked Songs.", color = Muted)
                    Text(FOLDER_HINT, style = MaterialTheme.typography.bodyMedium, color = Muted)
                    Button(onClick = choose, enabled = !selecting) { Text(if (selecting) "Checking access…" else "Choose music folder") }
                }
            }
        }
        if (selected && !scanning && library.tracks.isEmpty()) item {
            Text("No music found yet. Add audio to this folder, refresh, or choose another folder.", color = Muted)
            TextButton(onClick = choose) { Text("Choose another folder") }
        }
        items(library.folders, key = { it.id }) { folder ->
            val count = library.tracks.count { it.folderId == folder.id }
            Card(onClick = { open(folder.id) }, colors = CardDefaults.cardColors(containerColor = Surface)) {
                Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Artwork(folder.thumbnail, folder.name, Modifier.size(68.dp), icon = if (folder.isRoot) Icons.Outlined.FavoriteBorder else Icons.Outlined.Folder)
                    Column(Modifier.weight(1f)) {
                        Text(folder.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("$count tracks", color = Muted, style = MaterialTheme.typography.bodySmall)
                    }
                    Icon(Icons.Outlined.ChevronRight, "Open ${folder.name}", tint = Muted)
                }
            }
        }
    }
}

@Composable
private fun SearchScreen(library: LibrarySnapshot, model: LyraViewModel, open: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val normalized = query.trim()
    val tracks = remember(library, normalized) { if (normalized.isBlank()) emptyList() else library.tracks.filter { it.matchesSearch(normalized) } }
    val folders = remember(library, normalized) { if (normalized.isBlank()) emptyList() else library.folders.filter { it.name.contains(normalized, ignoreCase = true) } }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), label = { Text("Search your music") },
            leadingIcon = { Icon(Icons.Outlined.Search, null) }, trailingIcon = { if (query.isNotEmpty()) Control(Icons.Outlined.Close, "Clear search") { query = "" } }, singleLine = true)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
            if (normalized.isBlank()) item { Text("Find tracks, artists, albums, genres, or playlists.", Modifier.padding(8.dp), color = Muted) }
            else if (tracks.isEmpty() && folders.isEmpty()) item { Text("No matches for “$normalized”.", Modifier.padding(8.dp), color = Muted) }
            if (folders.isNotEmpty()) item { SectionTitle("Playlists") }
            items(folders, key = { "folder-${it.id}" }) { folder ->
                ListItem(headlineContent = { Text(folder.name) }, leadingContent = { Icon(Icons.Outlined.Folder, null, tint = Gold) },
                    modifier = Modifier.clickable { open(folder.id) }, colors = ListItemDefaults.colors(containerColor = Background))
            }
            if (tracks.isNotEmpty()) item { SectionTitle("Tracks · ${tracks.size}") }
            items(tracks, key = { it.id }) { track -> TrackRow(track, model, onPlay = { model.play(tracks, tracks.indexOf(track)) }) }
        }
    }
}

@Composable
private fun PlaylistScreen(folder: Folder?, tracks: List<Track>, model: LyraViewModel) {
    val playback by model.playback.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 16.dp)) {
        item {
            Column(Modifier.fillMaxWidth().padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Artwork(folder?.thumbnail.orEmpty(), folder?.name ?: "Playlist", Modifier.size(200.dp), icon = Icons.Outlined.Folder)
                Text(folder?.name ?: "Playlist unavailable", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text("${tracks.size} tracks · ${time(tracks.sumOf { it.durationMs })}", color = Muted)
                if (folder?.isRoot == true) Text("Tracks directly in your selected folder", style = MaterialTheme.typography.bodySmall, color = Muted)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(onClick = { model.play(tracks) }, enabled = playback.ready && tracks.isNotEmpty()) { Icon(Icons.Outlined.PlayArrow, null); Text("Play") }
                    OutlinedButton(onClick = { model.enqueue(tracks) }, enabled = playback.ready && tracks.isNotEmpty()) { Icon(Icons.AutoMirrored.Outlined.QueueMusic, null); Text("Add to queue") }
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = Surface)
        }
        items(tracks, key = { it.id }) { track -> TrackRow(track, model, playback.current?.mediaId == track.id) { model.play(tracks, tracks.indexOf(track)) } }
    }
}

@Composable
private fun TrackRow(track: Track, model: LyraViewModel, current: Boolean = false, onPlay: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 76.dp).clickable(onClick = onPlay).padding(start = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Artwork(track.thumbnail, "${track.title} artwork", Modifier.size(52.dp))
        Column(Modifier.weight(1f)) {
            Text(track.title, maxLines = 2, overflow = TextOverflow.Ellipsis, color = if (current) Gold else MaterialTheme.colorScheme.onSurface)
            Text(track.artist, color = Muted, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (track.metadataError.isNotEmpty()) Text("Metadata unavailable · playback can still be tried", color = Muted, style = MaterialTheme.typography.labelSmall)
        }
        Text(time(track.durationMs), color = Muted, style = MaterialTheme.typography.labelSmall)
        Box {
            Control(Icons.Outlined.MoreVert, "Actions for ${track.title}") { menu = true }
            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Play next") }, onClick = { model.enqueue(listOf(track), next = true); menu = false })
                DropdownMenuItem(text = { Text("Add to queue") }, onClick = { model.enqueue(listOf(track)); menu = false })
            }
        }
    }
}

@Composable
private fun MiniPlayer(playback: PlaybackUi, model: LyraViewModel, expand: () -> Unit) {
    val item = playback.current ?: return
    Surface(color = Surface, tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth().clickable(onClick = expand)) {
        Row(Modifier.padding(start = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Artwork(item.mediaMetadata.artworkUri?.toString().orEmpty(), "Current track artwork", Modifier.size(44.dp))
            Column(Modifier.weight(1f)) {
                Text(item.mediaMetadata.title?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                Text(item.mediaMetadata.artist?.toString().orEmpty(), color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
            }
            Control(if (playback.playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, if (playback.playing) "Pause" else "Play", enabled = playback.ready) { model.toggle() }
            Control(Icons.Outlined.SkipNext, "Next track", enabled = playback.ready) { model.next() }
        }
    }
}

@Composable
private fun PlayerScreen(playback: PlaybackUi, model: LyraViewModel, queue: () -> Unit) {
    val item = playback.current
    LazyColumn(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFF28241A), Background))), contentPadding = PaddingValues(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        item { Text("NOW PLAYING", color = Gold, style = MaterialTheme.typography.labelMedium); Spacer(Modifier.height(24.dp)) }
        item {
            Artwork(playback.currentArtwork.ifEmpty { item?.mediaMetadata?.artworkUri?.toString().orEmpty() },
                "Now playing artwork", Modifier.fillMaxWidth().widthIn(max = 440.dp).aspectRatio(1f), playerSize = true)
            Spacer(Modifier.height(24.dp))
            Text(item?.mediaMetadata?.title?.toString() ?: "Nothing playing", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(item?.mediaMetadata?.artist?.toString().orEmpty(), color = Muted)
        }
        item {
            var scrub by remember(playback.current?.mediaId, playback.currentIndex) { mutableStateOf<Float?>(null) }
            val max = playback.duration.coerceAtLeast(1).toFloat()
            Slider(value = (scrub ?: playback.position.toFloat()).coerceIn(0f, max), onValueChange = { scrub = it },
                onValueChangeFinished = { scrub?.let { model.seek(it.toLong()) }; scrub = null }, valueRange = 0f..max,
                enabled = playback.ready && playback.duration > 0, modifier = Modifier.semantics { contentDescription = "Playback position" })
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(time(scrub?.toLong() ?: playback.position), color = Muted); Text(time(playback.duration), color = Muted) }
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                Control(Icons.Outlined.Shuffle, if (playback.shuffle) "Shuffle on" else "Shuffle off", playback.ready, tint = if (playback.shuffle) Gold else Muted) { model.shuffle() }
                Control(Icons.Outlined.SkipPrevious, "Previous track", playback.ready) { model.previous() }
                FilledIconButton(onClick = { model.toggle() }, enabled = playback.ready && item != null, modifier = Modifier.size(72.dp)) {
                    Icon(if (playback.playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, if (playback.playing) "Pause" else "Play", Modifier.size(38.dp))
                }
                Control(Icons.Outlined.SkipNext, "Next track", playback.ready) { model.next() }
                Control(if (playback.repeat == Player.REPEAT_MODE_ONE) Icons.Outlined.RepeatOne else Icons.Outlined.Repeat,
                    when (playback.repeat) { Player.REPEAT_MODE_ONE -> "Repeat one"; Player.REPEAT_MODE_ALL -> "Repeat all"; else -> "Repeat off" }, playback.ready,
                    tint = if (playback.repeat == Player.REPEAT_MODE_OFF) Muted else Gold) { model.repeat() }
            }
            Spacer(Modifier.height(20.dp))
            if (playback.explicitQueue.isNotEmpty()) TextButton(onClick = queue) {
                Icon(Icons.AutoMirrored.Outlined.QueueMusic, null); Spacer(Modifier.width(8.dp)); Text("Queue · ${playback.explicitQueue.size}")
            }
        }
    }
}

@Composable
private fun QueueScreen(playback: PlaybackUi, model: LyraViewModel) {
    val order = playback.explicitQueue
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp)) {
        if (order.isNotEmpty()) item { SectionTitle("Your queue · ${order.size}") }
        items(order.size, key = { "${playback.queue[order[it]].mediaId}:${order[it]}" }) { displayIndex ->
            val index = order[displayIndex]
            val item = playback.queue[index]
            var menu by remember { mutableStateOf(false) }
            Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).clickable { model.jump(index) }.padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (index == playback.currentIndex) "▶" else "${displayIndex + 1}", color = Gold, modifier = Modifier.width(36.dp))
                Column(Modifier.weight(1f)) {
                    Text(item.mediaMetadata.title?.toString().orEmpty(), maxLines = 2, color = if (index == playback.currentIndex) Gold else MaterialTheme.colorScheme.onSurface)
                    Text(item.mediaMetadata.artist?.toString().orEmpty(), color = Muted, style = MaterialTheme.typography.bodySmall)
                }
                Box {
                    Control(Icons.Outlined.MoreVert, "Queue actions for ${item.mediaMetadata.title}") { menu = true }
                    DropdownMenu(menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Move up") }, enabled = displayIndex > 0, onClick = { model.move(index, order[displayIndex - 1]); menu = false })
                        DropdownMenuItem(text = { Text("Move down") }, enabled = displayIndex < order.lastIndex, onClick = { model.move(index, order[displayIndex + 1]); menu = false })
                        DropdownMenuItem(text = { Text("Remove from queue") }, onClick = { model.remove(index); menu = false })
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsScreen(tree: String, model: LyraViewModel, choose: () -> Unit) {
    val context = LocalContext.current
    var notifications by remember { mutableStateOf(Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notifications = it }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        notifications = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }
    val metrics by model.library.metrics.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Text("Settings", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold) }
        item {
            SettingsCard("Music folder") {
                Text(if (tree.isBlank()) "No folder selected" else "Your chosen folder is connected through Android’s file picker.", color = Muted)
                Text(FOLDER_HINT, color = Muted, style = MaterialTheme.typography.bodySmall)
                Button(onClick = choose) { Text(if (tree.isBlank()) "Choose music folder" else "Choose another folder") }
                if (tree.isNotEmpty()) OutlinedButton(onClick = { model.refresh() }) { Text("Refresh library") }
            }
        }
        item {
            SettingsCard("Notifications") {
                Text(if (notifications) "Notification permission enabled." else "General notifications are disabled. Playback and media-session controls remain available.", color = Muted)
                if (Build.VERSION.SDK_INT >= 33 && !notifications) OutlinedButton(onClick = { permission.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("Enable notifications") }
                TextButton(onClick = {
                    context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                }) { Text("Open notification settings") }
                Text("Declining notification permission does not prevent listening.", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
        }
        item {
            SettingsCard("Lyra Gold") {
                Text("An offline home for your music. No accounts, network access, or changes to your music files.", color = Muted)
                Text("Liked Songs contains the tracks directly in your music folder; it is not a favorites list.", color = Muted, style = MaterialTheme.typography.bodySmall)
                Text("Version ${com.lyra.sona.android.BuildConfig.VERSION_NAME} · Android 8+", color = Gold)
            }
        }
        if (metrics != null) item {
            SettingsCard("Last scan · this device") {
                Text("${metrics!!.discovered} tracks · ${metrics!!.elapsedMs} ms\n${metrics!!.metadataReads} metadata reads · ${metrics!!.reused} reused", color = Muted)
                Text("Actual timings depend on this device and storage provider.", style = MaterialTheme.typography.bodySmall, color = Muted)
            }
        }
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Surface)) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { Text(title, style = MaterialTheme.typography.titleMedium); content() }
    }
}

@Composable
private fun MessageCard(message: String, onChoose: (() -> Unit)?, dismiss: () -> Unit) {
    Surface(color = Color(0xFF30291C), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(message, style = MaterialTheme.typography.bodySmall)
                if (onChoose != null) TextButton(onClick = onChoose) { Text("Choose another folder") }
            }
            Control(Icons.Outlined.Close, "Dismiss message", onClick = dismiss)
        }
    }
}

@Composable
private fun Artwork(path: String, description: String, modifier: Modifier, icon: ImageVector = Icons.Outlined.MusicNote, playerSize: Boolean = false) {
    Surface(modifier, shape = RoundedCornerShape(if (playerSize) 20.dp else 10.dp), color = Color(0xFF29271F)) {
        if (path.isEmpty()) Box(contentAlignment = Alignment.Center) { Icon(icon, description, tint = Gold, modifier = Modifier.fillMaxSize().padding(12.dp)) }
        else AsyncImage(model = ImageRequest.Builder(LocalContext.current).data(if (path.startsWith("file:") || path.startsWith("content:")) Uri.parse(path) else File(path))
            .size(if (playerSize) 1024 else 256).crossfade(true).build(), contentDescription = description, contentScale = ContentScale.Crop,
            error = painterResource(R.drawable.lyra_logo))
    }
}

@Composable
private fun Control(icon: ImageVector, label: String, enabled: Boolean = true, tint: Color = MaterialTheme.colorScheme.onSurface, onClick: () -> Unit) {
    IconButton(onClick, Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp), enabled) { Icon(icon, label, tint = tint) }
}

@Composable
private fun SectionTitle(title: String) { Text(title, Modifier.padding(8.dp), style = MaterialTheme.typography.titleMedium, color = Gold) }
private fun time(ms: Long): String { val seconds = ms.coerceAtLeast(0) / 1000; return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}" }
