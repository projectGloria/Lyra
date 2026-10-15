use std::path::{Path, PathBuf};

use tauri::api::dialog::blocking::MessageDialogBuilder;
use tauri::api::dialog::{MessageDialogButtons, MessageDialogKind};

use crate::model::{DeleteResult, PlaylistMetadata, PlaylistResult};
use crate::util::{
    file_name, is_audio, is_image, is_path_inside, make_id, path_string, resolve,
    sanitize_playlist_name, PLAYLIST_COVER_PREFIX, PLAYLIST_METADATA_FILE,
};

impl PlaylistMetadata {
    /// Resolves the sidecar's `artworkFile` against its own folder. Only a bare file name
    /// is honoured — a stored path is reduced to its last segment so a tampered sidecar
    /// cannot point the app at a file outside the playlist folder.
    pub fn artwork_path(&self, directory: &Path) -> String {
        if self.artwork_file.is_empty() {
            return String::new();
        }
        let name = file_name(Path::new(&self.artwork_file));
        if name.is_empty() {
            return String::new();
        }
        let candidate = directory.join(&name);
        if is_image(&candidate) && candidate.is_file() {
            path_string(&candidate)
        } else {
            String::new()
        }
    }
}

pub fn read_playlist_metadata(directory: &Path) -> PlaylistMetadata {
    let path = directory.join(PLAYLIST_METADATA_FILE);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return PlaylistMetadata::default();
    };
    let mut metadata: PlaylistMetadata = serde_json::from_str(&raw).unwrap_or_default();
    metadata.name = metadata.name.trim().chars().take(120).collect();
    metadata.folder_name = metadata.folder_name.trim().chars().take(120).collect();
    metadata.description = metadata.description.trim().chars().take(240).collect();
    metadata.track_order.retain(|value| !value.is_empty());
    let actual_basename = file_name(directory);
    if !actual_basename.is_empty() && !metadata.name.is_empty() {
        let renamed_externally = if !metadata.folder_name.is_empty() {
            !metadata.folder_name.eq_ignore_ascii_case(&actual_basename)
        } else {
            !metadata.name.eq_ignore_ascii_case(&actual_basename)
        };
        if renamed_externally {
            metadata.name = actual_basename.clone();
            metadata.folder_name = actual_basename;
        }
    }
    metadata
}

pub fn write_playlist_metadata(
    directory: &Path,
    metadata: &PlaylistMetadata,
) -> Result<(), String> {
    let value = serde_json::to_value(metadata)
        .map_err(|error| format!("Playlist details could not be prepared: {error}"))?;
    crate::watcher::mark_local_write(&directory.join(PLAYLIST_METADATA_FILE));
    crate::util::write_json_atomic(&directory.join(PLAYLIST_METADATA_FILE), &value)
        .map_err(|error| format!("Playlist details could not be saved: {error}"))
}

/// Retain original cover bytes until both the artwork and metadata have committed.
/// Recovery files are intentionally not classified as disposable temporary files.
fn save_playlist_details(
    directory: &Path,
    metadata: &mut PlaylistMetadata,
    artwork_changed: bool,
    source_path: &str,
) -> Result<(), String> {
    if !artwork_changed {
        return write_playlist_metadata(directory, metadata);
    }
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let token = format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let staged = directory.join(format!(".lyra-cover-staging-{}", crate::util::now_ms()));
    let mut target = None;
    let mut backups: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut installed = false;
    let mut staged_created = false;
    let result = (|| -> Result<(), String> {
        if !source_path.trim().is_empty() {
            let source = resolve(source_path);
            if !source.is_file() || !is_image(&source) {
                return Err("The selected cover image is not readable.".into());
            }
            let extension = crate::util::extension_lower(&source);
            let destination = directory.join(format!("{PLAYLIST_COVER_PREFIX}.{extension}"));
            // Copy before moving old covers: the source can be the current managed cover.
            let mut input = std::fs::File::open(&source).map_err(|e| e.to_string())?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)
                .map_err(|e| e.to_string())?;
            staged_created = true;
            std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
            metadata.artwork_file = file_name(&destination);
            target = Some(destination);
        } else {
            metadata.artwork_file.clear();
        }
        let prefix = format!("{PLAYLIST_COVER_PREFIX}.");
        for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let original = entry.path();
            if entry.file_type().map_err(|e| e.to_string())?.is_file()
                && file_name(&original).to_lowercase().starts_with(&prefix)
            {
                let backup =
                    directory.join(format!(".lyra-cover-rollback-{token}-{}", backups.len()));
                if backup.exists() {
                    return Err("A cover recovery file already exists.".into());
                }
                crate::watcher::mark_local_write(&original);
                std::fs::rename(&original, &backup).map_err(|e| e.to_string())?;
                backups.push((original, backup));
            }
        }
        if let Some(destination) = &target {
            crate::watcher::mark_local_write(destination);
            std::fs::rename(&staged, destination).map_err(|e| e.to_string())?;
            installed = true;
        }
        write_playlist_metadata(directory, metadata)
    })();
    if let Err(error) = result {
        if installed {
            if let Some(destination) = &target {
                let _ = std::fs::remove_file(destination);
            }
        }
        let mut recovery = String::new();
        for (original, backup) in backups.iter().rev() {
            if original.exists() || std::fs::rename(backup, original).is_err() {
                recovery.push_str(&format!(
                    " Original cover retained at {}.",
                    path_string(backup)
                ));
            }
        }
        if staged_created {
            let _ = std::fs::remove_file(&staged);
        }
        return Err(format!(
            "Playlist details could not be saved: {error}.{recovery}"
        ));
    }
    for (_, backup) in backups {
        let _ = std::fs::remove_file(backup);
    }
    crate::artwork::ArtworkIndex::invalidate_directory(directory);
    Ok(())
}

/// A playlist *is* a directory in the music library. A uniquifying suffix is appended
/// rather than failing, so repeated clicks keep producing new playlists.
pub fn create_playlist(root_path: &str, name: &str) -> Result<PlaylistResult, String> {
    let root = resolve(root_path);
    if !root.is_dir() {
        return Err("Choose a music folder before creating a playlist.".to_string());
    }
    let requested = sanitize_playlist_name(name, "New Playlist");
    let mut final_name = requested.clone();
    let mut folder_path = root.join(&final_name);
    let mut suffix = 2;
    while folder_path.exists() && suffix < 500 {
        final_name = format!("{requested} {suffix}");
        folder_path = root.join(&final_name);
        suffix += 1;
    }
    if folder_path.exists() {
        return Err("A folder with that playlist name already exists.".to_string());
    }
    std::fs::create_dir(&folder_path)
        .map_err(|error| format!("The playlist folder could not be created: {error}"))?;
    let metadata = PlaylistMetadata {
        name: final_name.clone(),
        folder_name: final_name.clone(),
        ..PlaylistMetadata::default()
    };
    write_playlist_metadata(&folder_path, &metadata)?;
    Ok(PlaylistResult {
        ok: true,
        id: make_id(&path_string(&folder_path)),
        folder_path: path_string(&folder_path),
        name: final_name,
        description: String::new(),
        artwork_path: String::new(),
        warning: String::new(),
    })
}

/// Deletion goes through the OS trash, never a recursive remove: this is a folder of the
/// user's own music files, so it has to stay recoverable. The confirmation is raised here
/// rather than in the renderer so the count of files at risk is read off the real folder.
#[derive(Default, Debug, PartialEq)]
struct DeletionContents {
    audio_files: usize,
    other_files: usize,
    subfolders: usize,
}

fn deletion_contents(folder: &Path) -> Result<DeletionContents, String> {
    let mut contents = DeletionContents::default();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = crate::util::try_read_dir_entries(&directory).map_err(|error| {
            format!("Cannot inspect everything inside this playlist: {error}. Nothing was deleted.")
        })?;
        for entry in entries {
            if entry.file_type.is_symlink() {
                // Count the link itself; never follow it outside the folder.
                contents.other_files += 1;
            } else if entry.file_type.is_dir() {
                contents.subfolders += 1;
                pending.push(entry.path);
            } else if is_audio(&entry.path) {
                contents.audio_files += 1;
            } else {
                contents.other_files += 1;
            }
        }
    }
    Ok(contents)
}

fn deletion_detail(name: &str, contents: &DeletionContents) -> String {
    format!(
        "The entire folder “{name}” and everything inside it will be moved to the Recycle Bin, including {} audio files, {} other files or links, and {} subfolders (including nested playlists). You can restore them from there.",
        contents.audio_files, contents.other_files, contents.subfolders
    )
}

pub fn delete_playlist(
    window: &tauri::Window,
    lock: &std::sync::Mutex<()>,
    root_path: &str,
    folder_path: &str,
) -> Result<DeleteResult, String> {
    let root = resolve(root_path);
    let folder = resolve(folder_path);
    if !is_path_inside(&root, &folder, false) {
        return Err("That playlist folder is not inside the selected music library.".to_string());
    }
    if !folder.is_dir() {
        return Err("That playlist folder no longer exists.".to_string());
    }

    let contents = deletion_contents(&folder)?;
    let audio_count = contents.audio_files;
    let name = file_name(&folder);
    let detail = deletion_detail(&name, &contents);

    let confirmed = MessageDialogBuilder::new(
        format!("Delete the playlist \u{201c}{name}\u{201d}?"),
        detail,
    )
    .parent(window)
    .kind(MessageDialogKind::Warning)
    .buttons(MessageDialogButtons::OkCancel)
    .show();

    if !confirmed {
        return Ok(DeleteResult {
            ok: false,
            cancelled: Some(true),
            id: String::new(),
            folder_path: path_string(&folder),
            audio_count,
        });
    }

    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if !is_path_inside(&root, &folder, false) || !folder.is_dir() {
        return Err("That playlist folder no longer exists.".to_string());
    }

    trash::delete(&folder)
        .map_err(|error| format!("The playlist could not be moved to the Recycle Bin: {error}"))?;

    Ok(DeleteResult {
        ok: true,
        cancelled: None,
        id: make_id(&path_string(&folder)),
        folder_path: path_string(&folder),
        audio_count,
    })
}

pub fn edit_playlist(
    root_path: &str,
    folder_path: &str,
    name: &str,
    description: &str,
    artwork_path: &str,
    artwork_changed: bool,
) -> Result<PlaylistResult, String> {
    let root = resolve(root_path);
    let folder = resolve(folder_path);
    if !is_path_inside(&root, &folder, false) || !folder.is_dir() {
        return Err(
            "The playlist folder is no longer available inside the selected library.".to_string(),
        );
    }

    let current_name = file_name(&folder);
    let final_name = sanitize_playlist_name(name, &current_name);
    let parent = folder
        .parent()
        .map(|value| value.to_path_buf())
        .unwrap_or_else(|| root.clone());
    let target: PathBuf = parent.join(&final_name);

    let renaming = path_string(&target).to_lowercase() != path_string(&folder).to_lowercase();
    if renaming && target.exists() {
        return Err("A folder with that playlist name already exists.".to_string());
    }
    let existing = read_playlist_metadata(&folder);
    let mut artwork_file = if existing.artwork_path(&folder).is_empty() {
        String::new()
    } else {
        file_name(Path::new(&existing.artwork_file))
    };
    let description: String = description.trim().chars().take(240).collect();
    let mut metadata = PlaylistMetadata {
        name: final_name.clone(),
        folder_name: if renaming {
            final_name.clone()
        } else {
            current_name.clone()
        },
        description: description.clone(),
        artwork_file: artwork_file.clone(),
        track_order: existing.track_order.clone(),
    };
    save_playlist_details(&folder, &mut metadata, artwork_changed, artwork_path)?;
    artwork_file = metadata.artwork_file.clone();

    let mut warning = String::new();
    let actual_folder = if renaming {
        match std::fs::rename(&folder, &target) {
            Ok(()) => target,
            Err(error) => {
                warning =
                    format!("Playlist details saved, but the folder could not be renamed: {error}");
                metadata.folder_name = current_name;
                let _ = write_playlist_metadata(&folder, &metadata);
                folder
            }
        }
    } else {
        folder
    };

    let resolved_artwork = if artwork_file.is_empty() {
        crate::artwork::ArtworkIndex::new().find_folder_artwork(&actual_folder)
    } else {
        path_string(&actual_folder.join(&artwork_file))
    };

    Ok(PlaylistResult {
        ok: true,
        id: make_id(&path_string(&actual_folder)),
        folder_path: path_string(&actual_folder),
        name: final_name,
        description,
        artwork_path: resolved_artwork,
        warning,
    })
}

/// Persists a manual track order into the folder's sidecar. Only file names are stored, so
/// the order survives the whole library being moved to a different drive.
pub fn reorder_playlist(
    root_path: &str,
    folder_path: &str,
    paths: &[String],
) -> Result<serde_json::Value, String> {
    let root = resolve(root_path);
    let folder = resolve(folder_path);
    // `allow_root` is true here: the library root is a real playlist (Liked Songs) and its
    // order is saved the same way as any other folder's.
    if !is_path_inside(&root, &folder, true) || !folder.is_dir() {
        return Err(
            "The playlist folder is no longer available inside the selected library.".to_string(),
        );
    }
    let canonical_folder = std::fs::canonicalize(&folder).map_err(|e| e.to_string())?;
    let available: std::collections::HashSet<String> =
        crate::util::read_dir_entries(&canonical_folder)
            .into_iter()
            .filter(|entry| {
                entry.file_type.is_file() && !entry.file_type.is_symlink() && is_audio(&entry.path)
            })
            .map(|entry| file_name(&entry.path).to_lowercase())
            .collect();
    let folder_key = crate::util::cache_key(&folder);
    let trimmed_folder_key = folder_key.trim_end_matches('/');
    let mut seen = std::collections::HashSet::new();
    let valid: Vec<PathBuf> = paths
        .iter()
        .map(|value| resolve(value))
        .filter(|path| {
            path.parent().is_some_and(|p| {
                crate::util::cache_key(p).trim_end_matches('/') == trimmed_folder_key
            }) && available.contains(&file_name(path).to_lowercase())
                && seen.insert(file_name(path).to_lowercase())
        })
        .collect();

    let existing = read_playlist_metadata(&folder);
    let metadata = PlaylistMetadata {
        name: existing.name.clone(),
        folder_name: file_name(&folder),
        description: existing.description.clone(),
        artwork_file: if existing.artwork_path(&folder).is_empty() {
            String::new()
        } else {
            file_name(Path::new(&existing.artwork_file))
        },
        track_order: valid.iter().map(|path| file_name(path)).collect(),
    };
    write_playlist_metadata(&folder, &metadata)?;

    Ok(serde_json::json!({
        "ok": true,
        "trackOrder": valid.iter().map(|path| path_string(path)).collect::<Vec<String>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn failed_metadata_commit_restores_removed_and_replaced_covers() {
        use std::os::windows::fs::OpenOptionsExt;
        for replacement in [false, true] {
            let fixture = crate::util::tests::TestDirectory::new();
            let root = fixture.0.join("Music");
            std::fs::create_dir(&root).unwrap();
            let created = create_playlist(&path_string(&root), "Album").unwrap();
            let folder = PathBuf::from(&created.folder_path);
            let source = fixture.0.join("old.jpg");
            std::fs::write(&source, b"old cover").unwrap();
            edit_playlist(
                &path_string(&root),
                &created.folder_path,
                "Album",
                "",
                &path_string(&source),
                true,
            )
            .unwrap();
            let metadata_path = folder.join(PLAYLIST_METADATA_FILE);
            let original_metadata = std::fs::read(&metadata_path).unwrap();
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&metadata_path)
                .unwrap();
            let next = fixture.0.join("new.png");
            std::fs::write(&next, b"new cover").unwrap();
            let image = if replacement {
                path_string(&next)
            } else {
                String::new()
            };
            assert!(edit_playlist(
                &path_string(&root),
                &created.folder_path,
                "Album",
                "changed",
                &image,
                true
            )
            .is_err());
            assert_eq!(
                std::fs::read(folder.join(".lyra-cover.jpg")).unwrap(),
                b"old cover"
            );
            assert!(!folder.join(".lyra-cover.png").exists());
            assert_eq!(std::fs::read(&metadata_path).unwrap(), original_metadata);
            drop(lock);
        }
    }

    #[test]
    fn cover_removal_invalidates_artwork_used_by_incremental_scans() {
        use std::sync::{atomic::AtomicU64, Arc};
        let fixture = crate::util::tests::TestDirectory::new();
        let root = fixture.0.join("Music");
        std::fs::create_dir(&root).unwrap();
        let created = create_playlist(&path_string(&root), "Album").unwrap();
        let folder = PathBuf::from(&created.folder_path);
        let cover = fixture.0.join("source.jpg");
        std::fs::write(&cover, b"cover").unwrap();
        std::fs::write(folder.join("existing.mp3"), b"fixture").unwrap();
        edit_playlist(
            &path_string(&root),
            &created.folder_path,
            "Album",
            "",
            &path_string(&cover),
            true,
        )
        .unwrap();
        let context = crate::scan::ScanContext {
            window: None,
            data_dir: fixture.0.join("data"),
            scan_id: 1,
            generation: 1,
            current_generation: Arc::new(AtomicU64::new(1)),
        };
        assert!(crate::scan::scan_library(&context, &path_string(&root)).ok);
        edit_playlist(
            &path_string(&root),
            &created.folder_path,
            "Album",
            "",
            "",
            true,
        )
        .unwrap();
        let added = folder.join("new.mp3");
        std::fs::write(&added, b"fixture").unwrap();
        let library = crate::scan::scan_library_changes(
            &context,
            &path_string(&root),
            &[path_string(&added)],
        );
        assert!(library.ok);
        assert!(library.folders[0].artwork_path.is_empty());
    }

    #[test]
    fn deletion_counts_nested_playlists_and_non_audio_files() {
        let fixture = crate::util::tests::TestDirectory::new();
        let nested = fixture.0.join("Album").join("Disc 2");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("song.mp3"), b"fixture").unwrap();
        std::fs::write(fixture.0.join("notes.txt"), b"notes").unwrap();
        let contents = deletion_contents(&fixture.0).unwrap();
        assert_eq!(
            contents,
            DeletionContents {
                audio_files: 1,
                other_files: 1,
                subfolders: 2
            }
        );
        let detail = deletion_detail("Music", &contents);
        assert!(detail.contains("entire folder"));
        assert!(detail.contains("nested playlists"));
        assert!(!detail.contains("empty folder"));
    }

    #[test]
    fn deletion_refuses_an_unreadable_listing() {
        let fixture = crate::util::tests::TestDirectory::new();
        assert!(deletion_contents(&fixture.0.join("missing")).is_err());
    }
    use crate::util::tests::TestDirectory;

    #[test]
    #[cfg(windows)]
    fn rename_sharing_violation_preserves_metadata_and_reports_actual_folder() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = TestDirectory::new();
        let folder = fixture.0.join("Album");
        std::fs::create_dir(&folder).unwrap();
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .custom_flags(0x02000000)
            .open(&folder)
            .unwrap();
        let result = edit_playlist(
            &path_string(&fixture.0),
            &path_string(&folder),
            "Renamed",
            "Saved description",
            "",
            false,
        )
        .unwrap();
        assert!(!result.warning.is_empty());
        assert_eq!(result.folder_path, path_string(&folder));
        assert_eq!(
            read_playlist_metadata(&folder).description,
            "Saved description"
        );
        drop(handle);
    }

    #[test]
    fn failed_cover_replacement_keeps_previous_cover() {
        let fixture = TestDirectory::new();
        let cover = fixture.0.join(".lyra-cover.jpg");
        std::fs::write(&cover, b"old cover").unwrap();
        assert!(save_playlist_details(
            &fixture.0,
            &mut PlaylistMetadata::default(),
            true,
            &path_string(&fixture.0.join("missing.png"))
        )
        .is_err());
        assert_eq!(std::fs::read(&cover).unwrap(), b"old cover");
        assert!(save_playlist_details(
            &fixture.0,
            &mut PlaylistMetadata::default(),
            true,
            &path_string(&cover)
        )
        .is_ok());
        assert_eq!(std::fs::read(&cover).unwrap(), b"old cover");
    }

    #[test]
    fn reorder_ignores_outside_paths_and_duplicates() {
        let fixture = TestDirectory::new();
        let folder = fixture.0.join("Album");
        std::fs::create_dir(&folder).unwrap();
        let track = folder.join("a.mp3");
        std::fs::write(&track, b"a").unwrap();
        let outside = fixture.0.join("b.mp3");
        std::fs::write(&outside, b"b").unwrap();
        reorder_playlist(
            &path_string(&fixture.0),
            &path_string(&folder),
            &[
                path_string(&outside),
                path_string(&track),
                path_string(&track),
            ],
        )
        .unwrap();
        assert_eq!(read_playlist_metadata(&folder).track_order, vec!["a.mp3"]);
    }

    #[test]
    fn reorder_succeeds_with_trailing_slash_in_folder_path() {
        let fixture = TestDirectory::new();
        let folder = fixture.0.join("Album");
        std::fs::create_dir(&folder).unwrap();
        let track = folder.join("song.mp3");
        std::fs::write(&track, b"song").unwrap();
        let folder_with_slash = format!("{}/", path_string(&folder));
        reorder_playlist(
            &path_string(&fixture.0),
            &folder_with_slash,
            &[path_string(&track)],
        )
        .unwrap();
        assert_eq!(
            read_playlist_metadata(&folder).track_order,
            vec!["song.mp3"]
        );
    }

    #[test]
    fn external_folder_rename_updates_sidecar_name_and_is_not_reverted() {
        let fixture = TestDirectory::new();
        let created = create_playlist(&path_string(&fixture.0), "Rock").unwrap();
        let old_folder = PathBuf::from(&created.folder_path);
        let new_folder = fixture.0.join("Rock 2024");
        std::fs::rename(&old_folder, &new_folder).unwrap();
        let metadata = read_playlist_metadata(&new_folder);
        assert_eq!(metadata.name, "Rock 2024");
        let edited = edit_playlist(
            &path_string(&fixture.0),
            &path_string(&new_folder),
            &metadata.name,
            "Updated description",
            "",
            false,
        )
        .unwrap();
        assert_eq!(edited.name, "Rock 2024");
        assert_eq!(edited.folder_path, path_string(&new_folder));
        assert!(new_folder.is_dir());
    }
}
