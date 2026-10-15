use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use lofty::{Accessor, AudioFile, TaggedFileExt};
use rayon::prelude::*;

use crate::artwork::{pick_best_picture, ArtworkIndex};
use crate::cache::{artwork_cache_directory, TrackCache};
use crate::model::{Folder, Library, ScanProgress, Track};
use crate::playlist::read_playlist_metadata;
use crate::util::{
    file_name, file_signature, format_duration, is_audio, make_id, natural_cmp, now_ms,
    path_string, Signature, PLAYLIST_METADATA_FILE,
};

pub struct ScanContext {
    pub window: Option<tauri::Window>,
    pub data_dir: PathBuf,
    pub scan_id: u64,
    pub generation: u64,
    pub current_generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl ScanContext {
    /// A newer scan request bumps the generation, which is how an in-flight scan learns it
    /// has been superseded. Every long loop must consult this or a cancelled scan keeps
    /// burning CPU and eventually overwrites the newer result.
    pub fn is_cancelled(&self) -> bool {
        self.current_generation.load(Ordering::SeqCst) != self.generation
    }

    #[allow(clippy::too_many_arguments)]
    fn emit(
        &self,
        stage: &str,
        label: &str,
        detail: &str,
        percent: u32,
        processed: usize,
        total: usize,
        folders: usize,
        tracks: usize,
    ) {
        #[cfg(test)]
        if stage != "metadata" && std::env::var_os("LYRA_PROFILE_SCANS").is_some() {
            eprintln!("scan-stage {stage} {}", now_ms());
        }
        let payload = ScanProgress {
            scan_id: self.scan_id,
            stage: stage.to_string(),
            label: label.to_string(),
            detail: detail.to_string(),
            percent,
            processed,
            total,
            folders,
            tracks,
            timestamp: now_ms(),
        };
        if let Some(window) = &self.window {
            let _ = window.emit("library:progress", payload);
        }
    }
}

pub fn scan_library(context: &ScanContext, requested_root: &str) -> Library {
    scan_library_changes(context, requested_root, &[])
}

pub fn scan_library_changes(
    context: &ScanContext,
    requested_root: &str,
    changes: &[String],
) -> Library {
    loop {
        if context.is_cancelled() {
            return Library::cancelled(requested_root);
        }
        let library = scan_library_changes_once(context, requested_root, changes);
        if library.error != "scan-stale" {
            return library;
        }
    }
}

fn scan_library_changes_once(
    context: &ScanContext,
    requested_root: &str,
    changes: &[String],
) -> Library {
    let requested = requested_root.trim();
    context.emit(
        "validate",
        "Checking your folder",
        if requested.is_empty() {
            "No folder selected"
        } else {
            requested
        },
        2,
        0,
        0,
        0,
        0,
    );
    if requested.is_empty() {
        return Library::failed("", "no-folder-selected");
    }

    let root = crate::util::resolve(requested);
    let root_display = path_string(&root);
    match std::fs::metadata(&root) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Library::failed(&root_display, "not-a-directory"),
        Err(error) => {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => "folder-not-readable",
            };
            return Library::failed(&root_display, code);
        }
    }

    // --- discovery -------------------------------------------------------------------
    let transaction = crate::cache::transaction(&context.data_dir);
    let guard = transaction.lock().unwrap_or_else(|e| e.into_inner());
    let revision = *guard;
    let cache = TrackCache::load(&context.data_dir);
    static MAINTENANCE: std::sync::Once = std::sync::Once::new();
    MAINTENANCE.call_once(|| {
        crate::cache::collect_artwork(&context.data_dir, &cache);
        crate::util::sweep_stale_temp_files(&root);
    });
    let previous_snapshot = crate::cache::read_snapshot(&context.data_dir, &root_display);
    let previous_timestamp = previous_snapshot
        .as_ref()
        .map(|library| library.scanned_at)
        .unwrap_or(0);
    let incremental = incremental_folders(&root, changes, previous_snapshot);
    drop(guard);
    let incremental_scan = incremental.is_some();
    let changed_paths: HashSet<String> = changes
        .iter()
        .map(|path| crate::util::cache_key(Path::new(path)))
        .collect();
    let artwork_folders: HashSet<PathBuf> = changes
        .iter()
        .filter(|path| crate::util::is_image(Path::new(path)))
        .filter_map(|path| Path::new(path).parent().map(Path::to_path_buf))
        .collect();
    let mut unchanged: HashMap<PathBuf, Vec<Track>> = HashMap::new();
    let (folder_paths, mut directory_entries) =
        if let Some((folders, entries, previous)) = incremental {
            unchanged = previous;
            (folders, entries)
        } else {
            match discover_folders(context, &root) {
                Ok(discovered) => discovered,
                Err(error) => return Library::failed(&root_display, &error),
            }
        };
    if context.is_cancelled() {
        return Library::cancelled(&root_display);
    }
    context.emit(
        "folders",
        "Finding playlists",
        &format!("{} playlist folders discovered", folder_paths.len()),
        18,
        0,
        0,
        folder_paths.len(),
        0,
    );

    // --- index -----------------------------------------------------------------------
    let mut all_folder_paths = vec![root.clone()];
    all_folder_paths.extend(folder_paths.iter().cloned());

    let mut jobs: Vec<(PathBuf, PathBuf, usize)> = Vec::new();
    let affected_folders: HashSet<PathBuf> = changes
        .iter()
        .filter_map(|path| Path::new(path).parent().map(Path::to_path_buf))
        .collect();
    let mut tracks_by_folder: HashMap<PathBuf, Vec<Option<Track>>> = HashMap::new();
    let mut affected_albums = HashSet::new();
    let retry_paths = cache.retry_paths();
    let mut retry_numbers = HashMap::new();
    for folder_path in &all_folder_paths {
        if context.is_cancelled() {
            return Library::cancelled(&root_display);
        }
        if let Some(tracks) = unchanged.remove(folder_path) {
            let affected = affected_folders.contains(folder_path);
            let mut slots = Vec::with_capacity(tracks.len());
            for (index, mut track) in tracks.into_iter().enumerate() {
                let retry = retry_paths.contains(track.path.as_str());
                if !affected && !retry {
                    slots.push(Some(track));
                    continue;
                }
                let path = PathBuf::from(&track.path);
                if retry || (affected && changed_paths.contains(&crate::util::cache_key(&path))) {
                    if !affected {
                        retry_numbers.insert(path.clone(), track.track_no);
                    }
                    if let Some(old) = cache
                        .raw_track(&path)
                        .filter(|track| !track.artwork_path.is_empty())
                    {
                        affected_albums.insert(album_key(old));
                    }
                    jobs.push((path, folder_path.clone(), index));
                    slots.push(None);
                } else {
                    if affected {
                        if let Some(raw) = cache.raw_track(&path) {
                            track.track_no = if raw.track_no == 0 {
                                index as u32 + 1
                            } else {
                                raw.track_no
                            };
                            track.artwork_path = raw.artwork_path.clone();
                        }
                    }
                    slots.push(Some(track));
                }
            }
            tracks_by_folder.insert(folder_path.clone(), slots);
            continue;
        }
        let listing = match directory_entries.remove(folder_path) {
            Some(entries) => entries,
            None => match scan_directory(folder_path) {
                Ok(entries) => entries,
                Err(error) => return Library::failed(&root_display, &error),
            },
        };
        let audio_files: Vec<PathBuf> = listing
            .into_iter()
            .filter(|entry| entry.file_type.is_file() && is_audio(&entry.path))
            .map(|entry| entry.path)
            .collect();
        for (index, file_path) in audio_files.into_iter().enumerate() {
            jobs.push((file_path, folder_path.clone(), index));
        }
    }
    // Deleted audio donors and image edits can change artwork inherited by other folders.
    for path in changes.iter().map(Path::new) {
        if let Some(old) = cache
            .raw_track(path)
            .filter(|track| !track.artwork_path.is_empty())
        {
            affected_albums.insert(album_key(old));
        }
    }
    if !artwork_folders.is_empty() {
        for track in cache
            .tracks()
            .filter(|track| artwork_folders.contains(Path::new(&track.folder_path)))
        {
            affected_albums.insert(album_key(track));
        }
    }
    let reused_count = tracks_by_folder
        .values()
        .map(|tracks| tracks.iter().flatten().count())
        .sum::<usize>();
    let total_audio = jobs.len() + reused_count;
    context.emit(
        "index",
        "Indexing audio files",
        &format!("{total_audio} audio files found"),
        28,
        0,
        total_audio,
        folder_paths.len(),
        0,
    );

    // --- metadata --------------------------------------------------------------------
    let artwork_index = ArtworkIndex::for_scan(
        &context.data_dir,
        if incremental_scan { changes } else { &[] },
    );
    let artwork_directory = artwork_cache_directory(&context.data_dir);
    let updates: Mutex<Vec<(PathBuf, Signature, Track, bool)>> = Mutex::new(Vec::new());
    let processed = AtomicUsize::new(reused_count);
    let last_emit = Mutex::new((Instant::now(), 0usize));

    let parsed: Vec<(PathBuf, usize, Track)> = jobs
        .par_iter()
        .filter_map(|(file_path, folder_path, index)| {
            if context.is_cancelled() {
                return None;
            }
            let cached = if incremental_scan
                && !changed_paths.contains(&crate::util::cache_key(file_path))
                && !artwork_folders.contains(folder_path)
            {
                cache
                    .unchanged_track(file_path)
                    .filter(|(_, checked, _)| *checked)
            } else {
                None
            };
            let (mut track, embedded_checked, signature, from_cache) =
                if let Some((mut track, checked, signature)) = cached {
                    if track.track_no == 0 {
                        track.track_no = *index as u32 + 1;
                    }
                    (track, checked, signature, true)
                } else {
                    read_track(
                        file_path,
                        folder_path,
                        *index,
                        &artwork_index,
                        &cache,
                        &artwork_directory,
                    )
                };
            if !from_cache {
                if let Ok(mut pending) = updates.lock() {
                    pending.push((
                        file_path.clone(),
                        signature,
                        track.clone(),
                        embedded_checked,
                    ));
                }
            }
            if track.track_no == 0 {
                track.track_no = retry_numbers
                    .get(file_path)
                    .copied()
                    .filter(|number| *number > 0)
                    .unwrap_or(*index as u32 + 1);
            }
            let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
            // Throttled so a large library does not flood the webview with events; the
            // final item always reports so the bar cannot stall short of the end.
            let should_emit = {
                match last_emit.lock() {
                    Ok(mut guard) => {
                        let ready = done == total_audio
                            || (done.saturating_sub(guard.1) >= 8
                                && guard.0.elapsed().as_millis() >= 80);
                        if ready {
                            *guard = (Instant::now(), done);
                        }
                        ready
                    }
                    Err(_) => false,
                }
            };
            if should_emit {
                let percent = if total_audio > 0 {
                    28 + ((done as f64 / total_audio as f64) * 62.0).round() as u32
                } else {
                    90
                };
                context.emit(
                    "metadata",
                    "Reading metadata and artwork",
                    &file_name(file_path),
                    percent,
                    done,
                    total_audio,
                    folder_paths.len(),
                    done,
                );
            }
            Some((folder_path.clone(), *index, track))
        })
        .collect();

    if context.is_cancelled() {
        return Library::cancelled(&root_display);
    }

    let mut cache = cache;
    if let Ok(pending) = updates.into_inner() {
        for (file_path, signature, track, embedded_checked) in pending {
            cache.insert(&file_path, signature, &track, embedded_checked);
        }
    }
    let active_paths: Vec<PathBuf> = jobs.iter().map(|(path, _, _)| path.clone()).collect();

    // --- artwork fallbacks -----------------------------------------------------------
    context.emit(
        "artwork",
        "Resolving artwork",
        "Matching covers to albums and folders",
        91,
        total_audio,
        total_audio,
        folder_paths.len(),
        total_audio,
    );

    for folder_path in &all_folder_paths {
        tracks_by_folder.entry(folder_path.clone()).or_default();
    }
    for (folder_path, index, track) in parsed {
        if !track.artwork_path.is_empty() {
            affected_albums.insert(album_key(&track));
        }
        let slot = tracks_by_folder.entry(folder_path).or_default();
        if slot.len() <= index {
            slot.resize(index + 1, None);
        }
        slot[index] = Some(track);
    }
    let mut tracks_by_folder: HashMap<PathBuf, Vec<Track>> = tracks_by_folder
        .into_iter()
        .map(|(folder_path, slots)| (folder_path, slots.into_iter().flatten().collect()))
        .collect();

    affected_albums.remove("");
    if incremental_scan && !affected_albums.is_empty() {
        for (folder, tracks) in &mut tracks_by_folder {
            if affected_folders.contains(folder) {
                continue;
            }
            for track in tracks {
                if affected_albums.contains(&album_key(track)) {
                    if let Some(raw) = cache.raw_track(Path::new(&track.path)) {
                        track.artwork_path = raw.artwork_path.clone();
                    }
                }
            }
        }
    }

    // The order below is load-bearing. Per-track artwork is identity; album and folder
    // covers are only collection art and must never overwrite a track that has its own.
    apply_album_artwork_within_folders(&mut tracks_by_folder);
    apply_album_artwork_globally(&mut tracks_by_folder);
    // A folder can contain unrelated singles and albums. Never assign its generic
    // `cover.jpg` to every track. Folder artwork is still used for playlist cards below.

    if context.is_cancelled() {
        return Library::cancelled(&root_display);
    }

    // --- finalize --------------------------------------------------------------------
    context.emit(
        "finalize",
        "Building your library",
        "Preparing playlists and artwork",
        94,
        total_audio,
        total_audio,
        folder_paths.len(),
        total_audio,
    );

    let mut folders: Vec<Folder> = folder_paths
        .iter()
        .map(|folder_path| {
            let metadata = read_playlist_metadata(folder_path);
            let tracks = tracks_by_folder.remove(folder_path).unwrap_or_default();
            let tracks = if metadata.track_order.is_empty()
                || (incremental_scan && !affected_folders.contains(folder_path))
            {
                tracks
            } else {
                apply_track_order(tracks, &metadata.track_order)
            };
            let sidecar_artwork = metadata.artwork_path(folder_path);
            let artwork_path = if sidecar_artwork.is_empty() {
                artwork_index.find_folder_artwork(folder_path)
            } else {
                sidecar_artwork
            };
            let artwork_path = if artwork_path.is_empty() {
                tracks
                    .iter()
                    .find(|track| !track.artwork_path.is_empty())
                    .map(|track| track.artwork_path.clone())
                    .unwrap_or_default()
            } else {
                artwork_path
            };
            let name = if metadata.name.is_empty() {
                file_name(folder_path)
            } else {
                metadata.name.clone()
            };
            Folder {
                id: make_id(&path_string(folder_path)),
                name,
                path: path_string(folder_path),
                description: metadata.description.clone(),
                artwork_path,
                tracks,
                is_root: false,
            }
        })
        .collect();
    folders.sort_by(|a, b| natural_cmp(&a.name, &b.name));

    let root_metadata = read_playlist_metadata(&root);
    let liked_songs = tracks_by_folder.remove(&root).unwrap_or_default();
    let liked_songs = if root_metadata.track_order.is_empty()
        || (incremental_scan && !affected_folders.contains(&root))
    {
        liked_songs
    } else {
        apply_track_order(liked_songs, &root_metadata.track_order)
    };
    let root_artwork = artwork_index.find_folder_artwork(&root);
    let liked_songs_artwork_path = if root_artwork.is_empty() {
        liked_songs
            .iter()
            .find(|track| !track.artwork_path.is_empty())
            .map(|track| track.artwork_path.clone())
            .unwrap_or_default()
    } else {
        root_artwork
    };

    let track_count = liked_songs.len()
        + folders
            .iter()
            .map(|folder| folder.tracks.len())
            .sum::<usize>();
    let library = Library {
        root_path: root_display,
        ok: true,
        error: String::new(),
        liked_songs,
        liked_songs_artwork_path,
        folder_count: folders.len(),
        folders,
        track_count,
        scanned_at: now_ms().max(previous_timestamp + 1),
        cancelled: None,
    };

    if context.is_cancelled() {
        return Library::cancelled(&library.root_path);
    }
    #[cfg(test)]
    {
        let hook = commit_hooks().lock().unwrap().remove(&context.data_dir);
        if let Some(hook) = hook {
            hook();
        }
    }
    let mut guard = transaction.lock().unwrap_or_else(|e| e.into_inner());
    if *guard != revision {
        return Library::failed(&library.root_path, "scan-stale");
    }
    if context.is_cancelled() {
        return Library::cancelled(&library.root_path);
    }
    if incremental_scan {
        let removed_paths: Vec<PathBuf> = changes
            .iter()
            .map(PathBuf::from)
            .filter(|path| {
                is_audio(path)
                    && !std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
            })
            .collect();
        cache.save_incremental(&context.data_dir, &removed_paths);
    } else {
        cache.save(&context.data_dir, &root, &active_paths);
    }
    crate::cache::write_snapshot(&context.data_dir, &library);
    *guard += 1;
    drop(guard);
    context.emit(
        "complete",
        "Library ready",
        &format!(
            "{} tracks in {} playlists",
            library.track_count, library.folder_count
        ),
        100,
        total_audio,
        total_audio,
        library.folder_count,
        library.track_count,
    );
    library
}

type DirectoryEntries = HashMap<PathBuf, Vec<crate::util::DirectoryEntry>>;
type IncrementalFolders = (Vec<PathBuf>, DirectoryEntries, HashMap<PathBuf, Vec<Track>>);

/// File-only bursts can reuse untouched folders. Directory moves and unknown events use
/// full discovery because a whole subtree may have appeared or disappeared.
fn incremental_folders(
    root: &Path,
    changes: &[String],
    snapshot: Option<Library>,
) -> Option<IncrementalFolders> {
    if changes.is_empty() {
        return None;
    }
    let snapshot = snapshot?;
    let mut affected = HashSet::new();
    for changed in changes {
        let path = PathBuf::from(changed);
        let touches_known_folder = snapshot.folders.iter().any(|folder| {
            let folder_path = Path::new(&folder.path);
            folder_path == path || folder_path.starts_with(&path)
        });
        if path.is_dir() || touches_known_folder {
            return None;
        }
        let parent = path.parent()?;
        if !parent.is_dir() || !crate::util::is_path_inside(root, parent, true) {
            return None;
        }
        affected.insert(parent.to_path_buf());
    }
    let mut folders: Vec<PathBuf> = snapshot
        .folders
        .iter()
        .map(|folder| PathBuf::from(&folder.path))
        .collect();
    let mut unchanged: HashMap<PathBuf, Vec<Track>> = snapshot
        .folders
        .into_iter()
        .map(|folder| (PathBuf::from(folder.path), folder.tracks))
        .collect();
    unchanged.insert(root.to_path_buf(), snapshot.liked_songs);
    let mut entries = HashMap::new();
    for folder in affected {
        let changed: Vec<&Path> = changes
            .iter()
            .map(Path::new)
            .filter(|p| p.parent() == Some(folder.as_path()))
            .collect();
        if !changed.is_empty() && changed.iter().all(|p| is_audio(p)) {
            // Validate access even when no directory enumeration is needed.
            let _readable = std::fs::read_dir(&folder).ok()?;
            let mut tracks = unchanged.remove(&folder).unwrap_or_default();
            // A snapshot with no manual order is already naturally sorted. Only a
            // manually reordered folder needs sorting before assigning fallback numbers.
            if !read_playlist_metadata(&folder).track_order.is_empty() {
                tracks.sort_by(|a, b| natural_cmp(&a.path, &b.path));
            }
            let changed_keys: HashSet<String> =
                changed.iter().map(|p| crate::util::cache_key(p)).collect();
            tracks.retain(|t| !changed_keys.contains(&crate::util::cache_key(Path::new(&t.path))));
            for path in changed {
                match std::fs::symlink_metadata(path) {
                    Ok(metadata) if metadata.file_type().is_file() => {
                        let path_text = path_string(path);
                        let index = tracks
                            .partition_point(|track| natural_cmp(&track.path, &path_text).is_le());
                        tracks.insert(
                            index,
                            Track {
                                path: path_text,
                                ..Track::default()
                            },
                        );
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return None,
                }
            }
            if folder != root {
                folders.retain(|p| p != &folder);
                if !tracks.is_empty() || folder.join(PLAYLIST_METADATA_FILE).is_file() {
                    folders.push(folder.clone());
                }
            }
            unchanged.insert(folder, tracks);
            continue;
        }
        unchanged.remove(&folder);
        let listing = crate::util::try_read_dir_entries(&folder).ok()?;
        let qualifies = listing.iter().any(|entry| {
            entry.file_type.is_file()
                && (is_audio(&entry.path) || file_name(&entry.path) == PLAYLIST_METADATA_FILE)
        });
        if folder != root {
            folders.retain(|path| path != &folder);
            if qualifies {
                folders.push(folder.clone());
            }
        }
        entries.insert(folder, listing);
    }
    folders.sort_by(|a, b| natural_cmp(&path_string(a), &path_string(b)));
    Some((folders, entries, unchanged))
}

/// Breadth-first walk of the library root. A directory becomes a playlist when it holds
/// audio *or* carries a `.lyra-playlist.json` sidecar — the sidecar marker is what keeps a
/// freshly created, still-empty playlist from vanishing on the next scan.
fn discover_folders(
    context: &ScanContext,
    root: &Path,
) -> Result<(Vec<PathBuf>, DirectoryEntries), String> {
    let mut folders: Vec<PathBuf> = Vec::new();
    let mut entries_by_directory: HashMap<PathBuf, Vec<crate::util::DirectoryEntry>> =
        HashMap::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(directory) = queue.pop() {
        if context.is_cancelled() {
            break;
        }
        let key = path_string(&directory).replace('\\', "/").to_lowercase();
        if !visited.insert(key) {
            continue;
        }
        let entries = scan_directory(&directory)?;
        let has_audio = entries
            .iter()
            .any(|entry| entry.file_type.is_file() && is_audio(&entry.path));
        let has_sidecar = entries.iter().any(|entry| {
            entry.file_type.is_file() && file_name(&entry.path) == PLAYLIST_METADATA_FILE
        });
        if (has_audio || has_sidecar) && directory != root {
            folders.push(directory.clone());
            if folders.len() % 16 == 0 {
                let progress = (2 + (folders.len() / 16).min(15)) as u32;
                context.emit(
                    "folders",
                    "Finding playlists",
                    &file_name(&directory),
                    progress,
                    0,
                    0,
                    folders.len(),
                    0,
                );
            }
        }
        for entry in &entries {
            // DirEntry types do not follow symlinks, preventing directory cycles.
            if entry.file_type.is_dir() && !entry.file_type.is_symlink() {
                queue.push(entry.path.clone());
            }
        }
        if has_audio || has_sidecar || directory == root {
            entries_by_directory.insert(directory, entries);
        }
    }

    let mut keyed: Vec<_> = folders
        .into_iter()
        .map(|path| (path_string(&path), path))
        .collect();
    keyed.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    let folders = keyed.into_iter().map(|(_, path)| path).collect();
    Ok((folders, entries_by_directory))
}

fn scan_directory(directory: &Path) -> Result<Vec<crate::util::DirectoryEntry>, String> {
    crate::util::try_read_dir_entries(directory).map_err(|error| {
        format!(
            "Scan incomplete: could not read {}: {error}. The previous library has been retained.",
            path_string(directory)
        )
    })
}

fn read_track(
    file_path: &Path,
    folder_path: &Path,
    fallback_index: usize,
    artwork_index: &ArtworkIndex,
    cache: &TrackCache,
    artwork_directory: &Path,
) -> (Track, bool, Signature, bool) {
    let signature = file_signature(file_path);
    let path_text = path_string(file_path);
    let folder_text = path_string(folder_path);

    let sidecar = artwork_index.find_track_artwork(file_path);
    if let Some((mut track, embedded_checked)) = cache
        .cached_track(file_path, signature)
        .filter(|(_, checked)| *checked)
        .filter(|(track, _)| sidecar.is_empty() || sidecar == track.artwork_path)
    {
        // Identity fields are recomputed rather than trusted: the same audio file can be
        // reached at a new path after a folder rename, and a stale id breaks selection.
        track.id = make_id(&path_text);
        track.path = path_text;
        track.folder_path = folder_text;
        track.date_added = signature.mtime_ms;
        if track.track_no == 0 {
            track.track_no = fallback_index as u32 + 1;
        }
        return (track, embedded_checked, signature, true);
    }

    let fallback_title = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Unknown title")
        .to_string();
    let mut track = Track {
        id: make_id(&path_text),
        path: path_text,
        title: fallback_title.clone(),
        artist: "Unknown artist".to_string(),
        album_artist: String::new(),
        album: "Local library".to_string(),
        year: 0,
        genre: String::new(),
        comment: String::new(),
        duration: 0.0,
        duration_label: "--:--".to_string(),
        date_added: signature.mtime_ms,
        folder_path: folder_text,
        artwork_path: sidecar,
        track_no: 0,
    };

    let read_metadata = |read_properties| -> lofty::Result<lofty::TaggedFile> {
        lofty::Probe::open(file_path)?
            .guess_file_type()?
            .options(lofty::ParseOptions::new().read_properties(read_properties))
            .read()
    };
    // A broken duration/header must not discard readable tags and embedded covers.
    // Probe bytes as well: downloaded files sometimes have the wrong extension.
    let (tagged, properties_read) = match read_metadata(true) {
        Ok(tagged) => (tagged, true),
        Err(_) => match read_metadata(false) {
            Ok(tagged) => (tagged, false),
            Err(_) => return (track, false, signature, false),
        },
    };

    let duration = tagged.properties().duration().as_secs_f64();
    track.duration = duration;
    if properties_read {
        track.duration_label = format_duration(duration);
    }

    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    if let Some(tag) = tag {
        track.album_artist = tag
            .get_string(&lofty::ItemKey::AlbumArtist)
            .unwrap_or("")
            .trim()
            .to_string();
        if let Some(title) = tag.title().map(|value| value.trim().to_string()) {
            if !title.is_empty() {
                track.title = title;
            }
        }
        if let Some(artist) = tag.artist().map(|value| value.trim().to_string()) {
            if !artist.is_empty() {
                track.artist = artist;
            }
        }
        if let Some(album) = tag.album().map(|value| value.trim().to_string()) {
            if !album.is_empty() {
                track.album = album;
            }
        }
        if let Some(year) = tag.year() {
            if year > 0 {
                track.year = year;
            }
        }
        if let Some(genre) = tag.genre().map(|value| value.trim().to_string()) {
            if !genre.is_empty() {
                track.genre = genre;
            }
        }
        if let Some(comment) = tag.comment().map(|value| value.trim().to_string()) {
            if !comment.is_empty() {
                track.comment = comment;
            }
        }
        if let Some(number) = tag.track() {
            if number > 0 {
                track.track_no = number;
            }
        }
    }

    let mut embedded_checked = true;
    if track.artwork_path.is_empty() {
        if let Some(picture) =
            pick_best_picture(tagged.tags().iter().flat_map(|tag| tag.pictures()))
        {
            track.artwork_path = artwork_index.materialize_embedded(picture, artwork_directory);
            embedded_checked = !track.artwork_path.is_empty();
        }
    }

    // Retry partial reads next scan so a temporary properties failure is not permanent.
    (track, embedded_checked && properties_read, signature, false)
}

fn album_key(track: &Track) -> String {
    let key = track.album.trim().to_lowercase();
    // "Local library" is the placeholder for an untagged file, not a real album; grouping
    // by it would smear one arbitrary cover across every untagged track in the library.
    let artist = if track.album_artist.trim().is_empty() {
        &track.artist
    } else {
        &track.album_artist
    }
    .trim()
    .to_lowercase();
    if key.is_empty() || key == "local library" || artist.is_empty() || artist == "unknown artist" {
        String::new()
    } else {
        format!("{artist}\0{key}")
    }
}

fn apply_album_artwork_within_folders(tracks_by_folder: &mut HashMap<PathBuf, Vec<Track>>) {
    for tracks in tracks_by_folder.values_mut() {
        let mut covers: HashMap<String, String> = HashMap::new();
        for track in tracks.iter() {
            let key = album_key(track);
            if !key.is_empty() && !track.artwork_path.is_empty() {
                covers
                    .entry(key)
                    .or_insert_with(|| track.artwork_path.clone());
            }
        }
        for track in tracks.iter_mut() {
            if track.artwork_path.is_empty() {
                let key = album_key(track);
                if let Some(cover) = covers.get(&key) {
                    track.artwork_path = cover.clone();
                }
            }
        }
    }
}

fn apply_album_artwork_globally(tracks_by_folder: &mut HashMap<PathBuf, Vec<Track>>) {
    let mut ordered_folders: Vec<(&PathBuf, String)> = tracks_by_folder
        .keys()
        .map(|k| (k, path_string(k)))
        .collect();
    ordered_folders.sort_by(|a, b| natural_cmp(&a.1, &b.1));
    let mut covers: HashMap<String, String> = HashMap::new();
    for (folder, _) in ordered_folders {
        if let Some(tracks) = tracks_by_folder.get(folder) {
            for track in tracks {
                let key = album_key(track);
                if !key.is_empty() && !track.artwork_path.is_empty() {
                    covers
                        .entry(key)
                        .or_insert_with(|| track.artwork_path.clone());
                }
            }
        }
    }
    for tracks in tracks_by_folder.values_mut() {
        for track in tracks.iter_mut() {
            if track.artwork_path.is_empty() {
                let key = album_key(track);
                if let Some(cover) = covers.get(&key) {
                    track.artwork_path = cover.clone();
                }
            }
        }
    }
}

/// With no custom order, fall back to the same natural path sort discovery used, so a
/// newly added track lands in place instead of at the end of the list.
pub fn apply_track_order(tracks: Vec<Track>, track_order: &[String]) -> Vec<Track> {
    let mut tracks = tracks;
    if track_order.is_empty() {
        tracks.sort_by(|a, b| natural_cmp(&a.path, &b.path));
        return tracks;
    }
    let positions: HashMap<String, usize> = track_order
        .iter()
        .enumerate()
        .map(|(index, name)| (name.to_lowercase(), index))
        .collect();
    let mut decorated: Vec<(Track, Option<usize>)> = tracks
        .into_iter()
        .map(|t| {
            let key = file_name(Path::new(&t.path)).to_lowercase();
            let pos = positions.get(&key).copied();
            (t, pos)
        })
        .collect();
    decorated.sort_by(|(a_track, a_pos), (b_track, b_pos)| {
        match (a_pos, b_pos) {
            (Some(left), Some(right)) => left.cmp(right),
            // Tracks the saved order does not mention are new; they belong after the
            // ordered ones rather than silently jumping to the top.
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => natural_cmp(&a_track.path, &b_track.path),
        }
    });
    decorated.into_iter().map(|(t, _)| t).collect()
}

pub struct TrackMetadataUpdate<'a> {
    pub title: &'a str,
    pub artist: &'a str,
    pub album: &'a str,
    pub album_artist: &'a str,
    pub year: u32,
    pub track_no: u32,
    pub genre: &'a str,
    pub comment: &'a str,
    pub artwork_path: &'a str,
    pub artwork_changed: bool,
}

pub fn edit_track_metadata(
    data_dir: &Path,
    root_path: &str,
    track_path: &str,
    update: TrackMetadataUpdate<'_>,
) -> Result<crate::model::TrackEditResult, String> {
    use crate::util::{is_path_inside, resolve};
    use lofty::{MimeType, Picture, PictureType, Tag};

    let transaction = crate::cache::transaction(data_dir);
    let mut revision = transaction.lock().unwrap_or_else(|e| e.into_inner());
    *revision += 1;

    let root = resolve(root_path);
    let target = resolve(track_path);
    if root_path.trim().is_empty()
        || track_path.trim().is_empty()
        || !is_path_inside(&root, &target, false)
    {
        return Err("Can only edit tracks inside the selected music folder.".into());
    }
    if !target.is_file() || !is_audio(&target) {
        return Err("The selected audio file was not found.".into());
    }

    let mut tagged_file = lofty::Probe::open(&target)
        .map_err(|error| format!("Could not open audio file: {error}"))?
        .guess_file_type()
        .map_err(|error| format!("Could not detect audio format: {error}"))?
        .options(lofty::ParseOptions::new().read_properties(false))
        .read()
        .map_err(|error| format!("Could not read existing audio tags: {error}"))?;

    let tag_type = tagged_file.primary_tag_type();
    if tagged_file.primary_tag().is_none() && tagged_file.first_tag().is_none() {
        tagged_file.insert_tag(Tag::new(tag_type));
    }

    let picture_to_embed = if update.artwork_changed && !update.artwork_path.trim().is_empty() {
        let source = resolve(update.artwork_path);
        if !source.is_file() {
            return Err("The selected artwork file was not found.".into());
        }
        let bytes = std::fs::read(&source)
            .map_err(|error| format!("Could not read artwork file: {error}"))?;
        let ext = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = match ext.as_str() {
            "png" => MimeType::Png,
            "bmp" => MimeType::Bmp,
            "gif" => MimeType::Gif,
            "tif" | "tiff" => MimeType::Tiff,
            _ => MimeType::Jpeg,
        };
        let mut cursor = std::io::Cursor::new(&bytes);
        let mut pic = Picture::from_reader(&mut cursor).unwrap_or_else(|_| {
            Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, bytes)
        });
        pic.set_pic_type(PictureType::CoverFront);
        Some(pic)
    } else {
        None
    };

    if update.artwork_changed {
        let existing_types: Vec<_> = tagged_file.tags().iter().map(|t| t.tag_type()).collect();
        for tt in existing_types {
            if let Some(existing_tag) = tagged_file.tag_mut(tt) {
                while !existing_tag.pictures().is_empty() {
                    existing_tag.remove_picture(0);
                }
            }
        }
    }

    let tag = if let Some(tag) = tagged_file.primary_tag_mut() {
        tag
    } else if let Some(tag) = tagged_file.first_tag_mut() {
        tag
    } else {
        tagged_file.insert_tag(Tag::new(tagged_file.primary_tag_type()));
        tagged_file
            .first_tag_mut()
            .ok_or_else(|| "Could not initialize tags for track".to_string())?
    };

    let title = update.title.trim();
    if title.is_empty() {
        tag.remove_title();
    } else {
        tag.set_title(title.to_string());
    }

    let artist = update.artist.trim();
    if artist.is_empty() {
        tag.remove_artist();
    } else {
        tag.set_artist(artist.to_string());
    }

    let album = update.album.trim();
    if album.is_empty() {
        tag.remove_album();
    } else {
        tag.set_album(album.to_string());
    }

    let album_artist = update.album_artist.trim();
    tag.remove_key(&lofty::ItemKey::AlbumArtist);
    if !album_artist.is_empty() {
        tag.insert_text(lofty::ItemKey::AlbumArtist, album_artist.to_string());
    }

    if update.year > 0 {
        tag.set_year(update.year);
    } else {
        tag.remove_year();
    }

    if update.track_no > 0 {
        tag.set_track(update.track_no);
    } else {
        tag.remove_track();
    }

    let genre = update.genre.trim();
    if genre.is_empty() {
        tag.remove_genre();
    } else {
        tag.set_genre(genre.to_string());
    }

    let comment = update.comment.trim();
    if comment.is_empty() {
        tag.remove_comment();
    } else {
        tag.set_comment(comment.to_string());
    }

    if let Some(picture) = picture_to_embed {
        tag.push_picture(picture);
    }

    save_tags_transactionally(&target, &tagged_file, update.artwork_changed)?;

    if let Some(parent) = target.parent() {
        ArtworkIndex::invalidate(data_dir, parent);
    }

    let folder_path = target.parent().unwrap_or(&root);
    let artwork_directory = artwork_cache_directory(data_dir);
    let artwork_index = ArtworkIndex::new();
    let empty_cache = TrackCache::default();
    let (mut refreshed, checked, signature, _) = read_track(
        &target,
        folder_path,
        0,
        &artwork_index,
        &empty_cache,
        &artwork_directory,
    );
    if refreshed.track_no == 0 && update.track_no > 0 {
        refreshed.track_no = update.track_no;
    }

    let mut cache = TrackCache::load(data_dir);
    cache.insert(&target, signature, &refreshed, checked);

    let mut base_scanned_at = None;
    let mut scanned_at = None;
    if let Some(mut snapshot) = crate::cache::read_snapshot(data_dir, &path_string(&root)) {
        let previous_timestamp = snapshot.scanned_at;
        for item in &mut snapshot.liked_songs {
            if item.id == refreshed.id || item.path.eq_ignore_ascii_case(&refreshed.path) {
                if refreshed.track_no == 0 {
                    refreshed.track_no = item.track_no;
                }
                *item = refreshed.clone();
            }
        }
        for folder in &mut snapshot.folders {
            for item in &mut folder.tracks {
                if item.id == refreshed.id || item.path.eq_ignore_ascii_case(&refreshed.path) {
                    if refreshed.track_no == 0 {
                        refreshed.track_no = item.track_no;
                    }
                    *item = refreshed.clone();
                }
            }
        }
        cache.save_changes(data_dir);
        snapshot.scanned_at = now_ms().max(snapshot.scanned_at + 1);
        crate::cache::write_snapshot(data_dir, &snapshot);
        if crate::cache::read_snapshot(data_dir, &path_string(&root))
            .is_some_and(|stored| stored.scanned_at == snapshot.scanned_at)
        {
            base_scanned_at = Some(previous_timestamp);
            scanned_at = Some(snapshot.scanned_at);
        }
    } else {
        cache.save_changes(data_dir);
    }

    Ok(crate::model::TrackEditResult {
        ok: true,
        track: refreshed,
        base_scanned_at,
        scanned_at,
    })
}

/// Save into a sibling file first. Roll back every sidecar move if the final atomic
/// replacement fails (including Windows sharing violations). Crash leftovers retain
/// the original bytes and are deliberately excluded from automatic temp cleanup.
fn save_tags_transactionally(
    target: &Path,
    tagged: &lofty::TaggedFile,
    artwork_changed: bool,
) -> Result<(), String> {
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = target.parent().ok_or("The audio folder is unavailable.")?;
    let token = format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let staged = parent.join(format!(".lyra-tag-staging-{token}"));
    let original_signature = file_signature(target);
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| -> Result<(), String> {
        let mut input = std::fs::File::open(target).map_err(|e| e.to_string())?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        drop(input);
        drop(output);
        tagged.save_to_path(&staged).map_err(|e| e.to_string())?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&staged)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        if file_signature(target) != original_signature {
            return Err("The audio file changed while saving. Please reopen the editor.".into());
        }
        if artwork_changed {
            for (index, sidecar) in ArtworkIndex::new()
                .track_artworks(target)
                .into_iter()
                .enumerate()
            {
                let backup = parent.join(format!(".lyra-artwork-rollback-{token}-{index}"));
                if backup.exists() {
                    return Err("An artwork backup already exists.".into());
                }
                crate::watcher::mark_local_write(&sidecar);
                std::fs::rename(&sidecar, &backup).map_err(|e| e.to_string())?;
                moved.push((sidecar, backup));
            }
        }
        std::fs::rename(&staged, target).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        let mut recovery = String::new();
        for (original, backup) in moved.iter().rev() {
            if original.exists() || std::fs::rename(backup, original).is_err() {
                recovery.push_str(&format!(
                    " Original artwork retained at {}.",
                    path_string(backup)
                ));
            }
        }
        let _ = std::fs::remove_file(&staged);
        return Err(format!("Could not save audio tags: {error}.{recovery}"));
    }
    for (_, backup) in moved {
        let _ = std::fs::remove_file(backup);
    }
    Ok(())
}

#[cfg(test)]
type CommitHook = Box<dyn FnOnce() + Send>;
#[cfg(test)]
fn commit_hooks() -> &'static Mutex<HashMap<PathBuf, CommitHook>> {
    static HOOKS: std::sync::OnceLock<Mutex<HashMap<PathBuf, CommitHook>>> =
        std::sync::OnceLock::new();
    HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::tests::TestDirectory;
    use std::sync::{atomic::AtomicU64, Arc};

    fn context(data: &Path) -> ScanContext {
        ScanContext {
            window: None,
            data_dir: data.to_path_buf(),
            scan_id: 1,
            generation: 1,
            current_generation: Arc::new(AtomicU64::new(1)),
        }
    }

    #[test]
    #[cfg(windows)]
    fn unreadable_subfolder_preserves_snapshot_and_track_cache() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = TestDirectory::new();
        let root = fixture.0.join("Music");
        let album = root.join("Album");
        std::fs::create_dir_all(&album).unwrap();
        let song = album.join("song.mp3");
        std::fs::write(&song, b"fixture").unwrap();
        let context = context(&fixture.0.join("data"));
        assert!(scan_library(&context, &path_string(&root)).ok);
        let snapshot = crate::cache::library_snapshot_file(&context.data_dir);
        let cache = crate::cache::track_cache_file(&context.data_dir);
        let previous_snapshot = std::fs::read(&snapshot).unwrap();
        let previous_cache = std::fs::read(&cache).unwrap();
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .custom_flags(0x02000000)
            .open(&album)
            .unwrap();
        let result = scan_library(&context, &path_string(&root));
        assert!(!result.ok);
        assert!(result.error.contains("Scan incomplete"));
        let incremental =
            scan_library_changes(&context, &path_string(&root), &[path_string(&song)]);
        assert!(!incremental.ok);
        assert_eq!(std::fs::read(&snapshot).unwrap(), previous_snapshot);
        assert_eq!(std::fs::read(&cache).unwrap(), previous_cache);
        drop(handle);
        assert!(scan_library(&context, &path_string(&root)).ok);
    }

    #[test]
    fn embedded_cover_survives_unreadable_audio_properties_and_wrong_extension() {
        use lofty::{Picture, PictureType, TagExt};
        let fixture = TestDirectory::new();
        let mut tag = lofty::id3::v2::Id3v2Tag::default();
        // A real 1x1 GIF: this fixture tests tag extraction, not image decoding.
        let image = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b";
        tag.insert_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(lofty::MimeType::Gif),
            None,
            image.to_vec(),
        ));
        let mut bytes = Vec::new();
        tag.dump_to(&mut bytes).unwrap();
        bytes.extend_from_slice(&[0xff, 0xfb, 0x90, 0x00]);
        bytes.extend_from_slice(&[0; 256]);
        for name in ["tag-only.mp3", "misnamed.flac"] {
            let audio = fixture.0.join(name);
            std::fs::write(&audio, &bytes).unwrap();
            assert!(lofty::read_from_path(&audio).is_err());
            let (track, checked, _, _) = read_track(
                &audio,
                &fixture.0,
                0,
                &ArtworkIndex::new(),
                &TrackCache::default(),
                &fixture.0.join("cache"),
            );
            assert_eq!(std::fs::read(&track.artwork_path).unwrap(), image);
            assert_eq!(track.duration_label, "--:--");
            assert!(!checked, "partial metadata reads must remain retryable");
        }
    }

    #[test]
    fn failed_metadata_reads_are_retried_on_the_next_scan() {
        let fixture = TestDirectory::new();
        let audio = fixture.0.join("song.mp3");
        std::fs::write(&audio, b"unreadable metadata").unwrap();
        let index = ArtworkIndex::new();
        let mut cache = TrackCache::default();
        let artwork = fixture.0.join("cache");
        let (track, checked, signature, _) =
            read_track(&audio, &fixture.0, 0, &index, &cache, &artwork);
        assert!(!checked);
        cache.insert(&audio, signature, &track, checked);
        let (_, _, _, from_cache) = read_track(&audio, &fixture.0, 0, &index, &cache, &artwork);
        assert!(!from_cache);
    }

    #[test]
    fn album_fallback_requires_matching_artist_and_preserves_track_art() {
        let fixture = TestDirectory::new();
        let folder = fixture.0.join("music");
        std::fs::create_dir(&folder).unwrap();
        let audio = folder.join("song.mp3");
        std::fs::write(&audio, b"fixture").unwrap();
        let (mut donor, _, _, _) = read_track(
            &audio,
            &folder,
            0,
            &ArtworkIndex::new(),
            &TrackCache::default(),
            &fixture.0.join("cache"),
        );
        donor.album = "Greatest Hits".into();
        donor.artist = "Artist A".into();
        donor.artwork_path = "a.jpg".into();
        let mut compilation = donor.clone();
        compilation.artist = "Guest artist".into();
        compilation.album_artist = "Artist A".into();
        assert_eq!(album_key(&donor), album_key(&compilation));
        let mut recipient = donor.clone();
        recipient.artwork_path.clear();
        let mut unrelated = recipient.clone();
        unrelated.artist = "Artist B".into();
        let mut own_cover = recipient.clone();
        own_cover.artwork_path = "own.jpg".into();
        let mut folders = HashMap::from([
            (folder.clone(), vec![donor, unrelated.clone(), own_cover]),
            (fixture.0.join("other"), vec![recipient, unrelated]),
        ]);
        apply_album_artwork_within_folders(&mut folders);
        apply_album_artwork_globally(&mut folders);
        assert!(folders[&folder][1].artwork_path.is_empty());
        assert_eq!(folders[&folder][2].artwork_path, "own.jpg");
        assert_eq!(folders[&fixture.0.join("other")][0].artwork_path, "a.jpg");
        assert!(folders[&fixture.0.join("other")][1].artwork_path.is_empty());
    }

    #[test]
    fn generic_folder_cover_is_not_assigned_to_unrelated_tracks() {
        let fixture = TestDirectory::new();
        let folder = fixture.0.join("mixed");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("cover.jpg"), b"image").unwrap();
        std::fs::write(folder.join("one.mp3"), b"fixture").unwrap();
        std::fs::write(folder.join("two.mp3"), b"fixture").unwrap();
        let library = scan_library(&context(&fixture.0.join("data")), &path_string(&fixture.0));
        assert!(library.folders[0]
            .tracks
            .iter()
            .all(|track| track.artwork_path.is_empty()));
    }

    #[test]
    fn scan_incremental_updates_and_manual_order_match_full_scan() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("music");
        let folder = root.join("Album");
        std::fs::create_dir_all(&folder).unwrap();
        // Unreadable media still belongs in the library and uses filename metadata.
        for name in ["Track 10.mp3", "Track 2.mp3"] {
            std::fs::write(folder.join(name), b"fixture").unwrap();
        }
        let context = context(&fixture.0.join("data"));
        let first = scan_library(&context, &path_string(&root));
        assert!(first.ok);
        assert_eq!(first.track_count, 2);
        assert_eq!(first.folders[0].tracks[0].title, "Track 2");
        let new_track = folder.join("Track 3.mp3");
        std::fs::write(&new_track, b"fixture").unwrap();
        let updated =
            scan_library_changes(&context, &path_string(&root), &[path_string(&new_track)]);
        assert_eq!(updated.track_count, 3);
        crate::playlist::reorder_playlist(
            &path_string(&root),
            &path_string(&folder),
            &[
                path_string(&folder.join("Track 10.mp3")),
                path_string(&new_track),
            ],
        )
        .unwrap();
        let reordered = scan_library_changes(
            &context,
            &path_string(&root),
            &[path_string(&folder.join(PLAYLIST_METADATA_FILE))],
        );
        assert_eq!(reordered.folders[0].tracks[0].title, "Track 10");
        assert_eq!(reordered.folders[0].tracks[1].title, "Track 3");
        std::fs::remove_file(&new_track).unwrap();
        let incremental =
            scan_library_changes(&context, &path_string(&root), &[path_string(&new_track)]);
        let full = scan_library(&context, &path_string(&root));
        assert_eq!(
            serde_json::to_value(&incremental.folders).unwrap(),
            serde_json::to_value(&full.folders).unwrap()
        );
    }

    #[test]
    fn cancelled_scan_does_not_replace_snapshot() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("music");
        std::fs::create_dir(&root).unwrap();
        let context = context(&fixture.0.join("data"));
        assert!(scan_library(&context, &path_string(&root)).ok);
        let path = crate::cache::library_snapshot_file(&context.data_dir);
        let previous = std::fs::read(&path).unwrap();
        context.current_generation.store(2, Ordering::SeqCst);
        assert_eq!(
            scan_library(&context, &path_string(&root)).cancelled,
            Some(true)
        );
        assert_eq!(std::fs::read(path).unwrap(), previous);
    }

    #[test]
    fn scanning_other_roots_preserves_cached_metadata() {
        let fixture = TestDirectory::new();
        let first = fixture.0.join("A");
        let second = fixture.0.join("B");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let track = first.join("a.mp3");
        std::fs::write(&track, b"fixture").unwrap();
        let context = context(&fixture.0.join("data"));
        scan_library(&context, &path_string(&first));
        scan_library(&context, &path_string(&second));
        assert!(TrackCache::load(&context.data_dir)
            .unchanged_track(&track)
            .is_some());
    }

    #[test]
    fn untagged_cached_tracks_update_fallback_track_no_when_files_shift() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("music");
        let folder = root.join("Album");
        std::fs::create_dir_all(&folder).unwrap();
        // Write a minimal valid ID3v2 header without a TRCK frame so lofty parses it
        // (`embedded_checked = true`) and stores it in TrackCache with `track_no = 0`.
        let untagged_id3 = [b'I', b'D', b'3', 3, 0, 0, 0, 0, 0, 0];
        std::fs::write(folder.join("02-second.mp3"), untagged_id3).unwrap();
        let context = context(&fixture.0.join("data"));
        let first = scan_library(&context, &path_string(&root));
        assert_eq!(first.folders[0].tracks[0].track_no, 1);

        let inserted = folder.join("01-first.mp3");
        std::fs::write(&inserted, untagged_id3).unwrap();
        let second = scan_library_changes(&context, &path_string(&root), &[path_string(&inserted)]);
        assert_eq!(second.folders[0].tracks[0].title, "01-first");
        assert_eq!(second.folders[0].tracks[0].track_no, 1);
        assert_eq!(second.folders[0].tracks[1].title, "02-second");
        assert_eq!(second.folders[0].tracks[1].track_no, 2);
    }

    #[test]
    fn edit_track_metadata_persists_tags_and_embedded_cover() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("music");
        let folder = root.join("Album");
        std::fs::create_dir_all(&folder).unwrap();
        let song = folder.join("track.mp3");
        let mut untagged_mp3 = vec![
            b'I', b'D', b'3', 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00,
        ];
        untagged_mp3.extend_from_slice(&[0; 256]);
        std::fs::write(&song, untagged_mp3).unwrap();
        let cover_source = fixture.0.join("cover.png");
        std::fs::write(&cover_source, b"\x89PNG\r\n\x1a\npngdata").unwrap();
        let data_dir = fixture.0.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        let before = scan_library(&context(&data_dir), &path_string(&root));

        let result = edit_track_metadata(
            &data_dir,
            &path_string(&root),
            &path_string(&song),
            TrackMetadataUpdate {
                title: "Starlight",
                artist: "Muse",
                album: "Black Holes and Revelations",
                album_artist: "Muse",
                year: 2006,
                track_no: 2,
                genre: "Alternative Rock",
                comment: "Remastered",
                artwork_path: &path_string(&cover_source),
                artwork_changed: true,
            },
        )
        .unwrap();

        assert!(result.ok);
        assert_eq!(result.base_scanned_at, Some(before.scanned_at));
        assert_eq!(
            result.scanned_at,
            crate::cache::read_snapshot(&data_dir, &path_string(&root))
                .map(|snapshot| snapshot.scanned_at)
        );
        assert_eq!(result.track.title, "Starlight");
        assert_eq!(result.track.artist, "Muse");
        assert_eq!(result.track.album, "Black Holes and Revelations");
        assert_eq!(result.track.album_artist, "Muse");
        assert_eq!(result.track.year, 2006);
        assert_eq!(result.track.track_no, 2);
        assert_eq!(result.track.genre, "Alternative Rock");
        assert_eq!(result.track.comment, "Remastered");
        assert!(!result.track.artwork_path.is_empty());
    }
}

#[cfg(test)]
mod edit_transaction_tests {
    use super::*;
    use crate::{
        scan,
        util::{path_string, tests::TestDirectory},
    };
    use std::fs;
    fn mp3(path: &Path) {
        let mut data = vec![
            b'I', b'D', b'3', 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00,
        ];
        data.extend_from_slice(&[0; 256]);
        fs::write(path, data).unwrap();
    }

    fn update(cover: &str) -> scan::TrackMetadataUpdate<'_> {
        scan::TrackMetadataUpdate {
            title: "New title",
            artist: "Artist",
            album: "Album",
            album_artist: "Artist",
            year: 2026,
            track_no: 1,
            genre: "",
            comment: "",
            artwork_path: cover,
            artwork_changed: true,
        }
    }

    #[test]
    fn incremental_artwork_donor_changes_match_a_full_scan() {
        use std::sync::{atomic::AtomicU64, Arc};
        for remove_image in [false, true] {
            let fixture = TestDirectory::new();
            let root = fixture.0.join("Music");
            let donor_folder = root.join("A");
            let recipient_folder = root.join("B");
            fs::create_dir_all(&donor_folder).unwrap();
            fs::create_dir_all(&recipient_folder).unwrap();
            let donor = donor_folder.join("donor.mp3");
            let recipient = recipient_folder.join("recipient.mp3");
            let data = fixture.0.join("data");
            for path in [&donor, &recipient] {
                mp3(path);
                let mut metadata = update("");
                metadata.artwork_changed = false;
                edit_track_metadata(&data, &path_string(&root), &path_string(path), metadata)
                    .unwrap();
            }
            let cover = donor_folder.join("donor.jpg");
            fs::write(&cover, b"cover").unwrap();
            let context = ScanContext {
                window: None,
                data_dir: data.clone(),
                scan_id: 1,
                generation: 1,
                current_generation: Arc::new(AtomicU64::new(1)),
            };
            let first = scan_library(&context, &path_string(&root));
            assert!(!first
                .folders
                .iter()
                .find(|folder| folder.path == path_string(&recipient_folder))
                .unwrap()
                .tracks[0]
                .artwork_path
                .is_empty());
            let removed = if remove_image { &cover } else { &donor };
            fs::remove_file(removed).unwrap();
            let incremental =
                scan_library_changes(&context, &path_string(&root), &[path_string(removed)]);
            let full = scan_library(&context, &path_string(&root));
            assert!(incremental.ok && full.ok);
            assert_eq!(
                serde_json::to_value(&incremental.folders).unwrap(),
                serde_json::to_value(&full.folders).unwrap()
            );
            assert!(incremental
                .folders
                .iter()
                .find(|folder| folder.path == path_string(&recipient_folder))
                .unwrap()
                .tracks[0]
                .artwork_path
                .is_empty());
            if !remove_image {
                assert!(TrackCache::load(&data).raw_track(&donor).is_none());
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn incremental_scan_retries_a_transient_read_error_in_an_untouched_folder() {
        use std::os::windows::fs::OpenOptionsExt;
        use std::sync::{atomic::AtomicU64, Arc};
        let fixture = TestDirectory::new();
        let root = fixture.0.join("Music");
        let album = root.join("Album");
        let other = root.join("Other");
        fs::create_dir_all(&album).unwrap();
        fs::create_dir(&other).unwrap();
        let song = album.join("song.mp3");
        let data = fixture.0.join("data");
        mp3(&song);
        let mut metadata = update("");
        metadata.artwork_changed = false;
        edit_track_metadata(&data, &path_string(&root), &path_string(&song), metadata).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&song)
            .unwrap();
        let context = ScanContext {
            window: None,
            data_dir: data,
            scan_id: 1,
            generation: 1,
            current_generation: Arc::new(AtomicU64::new(1)),
        };
        let first = scan_library(&context, &path_string(&root));
        assert!(first.ok);
        assert_eq!(first.folders[0].tracks[0].title, "song");
        drop(lock);
        let added = other.join("new.mp3");
        mp3(&added);
        let refreshed = scan_library_changes(&context, &path_string(&root), &[path_string(&added)]);
        assert!(refreshed.ok);
        assert_eq!(
            refreshed
                .folders
                .iter()
                .find(|folder| folder.path == path_string(&album))
                .unwrap()
                .tracks[0]
                .title,
            "New title"
        );
    }

    #[test]
    #[cfg(windows)]
    fn failed_tag_save_must_preserve_existing_sidecar() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("Music");
        fs::create_dir(&root).unwrap();
        let song = root.join("Song.mp3");
        let cover = root.join("Song.jpg");
        mp3(&song);
        fs::write(&cover, b"original artwork").unwrap();
        // Allow readers, deny writers, reproducing a track held by another application.
        use std::os::windows::fs::OpenOptionsExt;
        let handle = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&song)
            .unwrap();
        let result = scan::edit_track_metadata(
            &fixture.0.join("data"),
            &path_string(&root),
            &path_string(&song),
            update(""),
        );
        drop(handle);
        assert!(result.is_err(), "the audio write must actually have failed");
        assert!(
            cover.exists(),
            "the sidecar was deleted before the failed audio write"
        );
    }

    #[test]
    fn replacement_cover_must_override_recognized_suffix_sidecar() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("Music");
        fs::create_dir(&root).unwrap();
        let song = root.join("Song.mp3");
        let old = root.join("Song-cover.jpg");
        let new = fixture.0.join("new.png");
        mp3(&song);
        fs::write(&old, b"old sidecar").unwrap();
        fs::write(&new, b"\x89PNG\r\n\x1a\npngdata").unwrap();
        let result = scan::edit_track_metadata(
            &fixture.0.join("data"),
            &path_string(&root),
            &path_string(&song),
            update(&path_string(&new)),
        )
        .unwrap();
        assert_ne!(
            result.track.artwork_path,
            path_string(&old),
            "successful cover replacement still displays the old sidecar"
        );
    }

    #[test]
    fn edit_during_scan_forces_a_retry_instead_of_overwriting_new_tags() {
        use std::sync::{atomic::AtomicU64, mpsc, Arc};
        use std::time::Duration;
        let fixture = TestDirectory::new();
        let root = fixture.0.join("Music");
        fs::create_dir(&root).unwrap();
        let song = root.join("Song.mp3");
        mp3(&song);
        let data = fixture.0.join("data");
        let context = ScanContext {
            window: None,
            data_dir: data.clone(),
            scan_id: 1,
            generation: 1,
            current_generation: Arc::new(AtomicU64::new(1)),
        };
        assert!(scan_library(&context, &path_string(&root)).ok);
        let (arrived, wait_for_scan) = mpsc::channel();
        let (resume, wait_for_edit) = mpsc::channel();
        commit_hooks().lock().unwrap().insert(
            data.clone(),
            Box::new(move || {
                arrived.send(()).unwrap();
                wait_for_edit.recv_timeout(Duration::from_secs(10)).unwrap();
            }),
        );
        let requested = path_string(&root);
        let worker = std::thread::spawn(move || scan_library(&context, &requested));
        wait_for_scan.recv_timeout(Duration::from_secs(10)).unwrap();
        let result =
            edit_track_metadata(&data, &path_string(&root), &path_string(&song), update(""));
        resume.send(()).unwrap();
        assert!(result.is_ok(), "{result:?}");
        let scanned = worker.join().unwrap();
        assert!(scanned.ok);
        assert_eq!(scanned.liked_songs[0].title, "New title");
        assert_eq!(
            crate::cache::read_snapshot(&data, &path_string(&root))
                .unwrap()
                .liked_songs[0]
                .title,
            "New title"
        );
        assert_eq!(
            TrackCache::load(&data)
                .unchanged_track(&song)
                .unwrap()
                .0
                .title,
            "New title"
        );
    }
}
