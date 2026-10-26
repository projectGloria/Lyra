//! Liked Songs that live outside the library root.
//!
//! The root folder *is* Liked Songs: every audio file placed directly in it is liked by
//! location. Liking a track that lives in a playlist folder must not copy audio into the
//! root, so the like is recorded as a reference in `.lyra-liked.json` at the root instead.
//! Entries are stored relative to the root with forward slashes, so moving the whole
//! library to another drive (or another machine) keeps every like.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::util::{is_audio, is_path_inside, path_string, resolve, LIKED_SONGS_FILE};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LikedFile {
    version: u32,
    tracks: Vec<String>,
}

fn liked_file(root: &Path) -> PathBuf {
    root.join(LIKED_SONGS_FILE)
}

fn component_key(component: &Component) -> String {
    component.as_os_str().to_string_lossy().to_lowercase()
}

/// Root-relative, forward-slash form of `track`, compared case-insensitively because
/// Windows paths are. `None` when the track is not strictly inside the root.
fn relative_entry(root: &Path, track: &Path) -> Option<String> {
    let root_parts: Vec<Component> = root.components().collect();
    let track_parts: Vec<Component> = track.components().collect();
    if track_parts.len() <= root_parts.len() {
        return None;
    }
    let shares_root = root_parts
        .iter()
        .zip(&track_parts)
        .all(|(left, right)| component_key(left) == component_key(right));
    if !shares_root {
        return None;
    }
    let rest: Vec<String> = track_parts[root_parts.len()..]
        .iter()
        .map(|part| match part {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Option<_>>()?;
    Some(rest.join("/"))
}

/// A stored entry is only honoured when it is a plain relative path. A tampered file must
/// not be able to point the app at `..\..\Windows` or an absolute path elsewhere.
fn entry_path(root: &Path, entry: &str) -> Option<PathBuf> {
    let relative = Path::new(entry);
    if entry.is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    // Join segment by segment so Windows gets native separators, not `Album/song.mp3`.
    Some(
        entry
            .split('/')
            .fold(root.to_path_buf(), |path, part| path.join(part)),
    )
}

fn read_entries(root: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(liked_file(root)) else {
        return Vec::new();
    };
    let file: LikedFile = serde_json::from_str(&raw).unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    file.tracks
        .into_iter()
        .map(|entry| entry.trim().replace('\\', "/"))
        .filter(|entry| entry_path(root, entry).is_some() && seen.insert(entry.to_lowercase()))
        .collect()
}

fn write_entries(root: &Path, entries: &[String]) -> Result<(), String> {
    let target = liked_file(root);
    let file = LikedFile {
        version: 1,
        tracks: entries.to_vec(),
    };
    // Our own write must not bounce back through the watcher as a library change.
    crate::watcher::mark_local_write(&target);
    crate::util::write_json_atomic(&target, &file)
        .map_err(|error| format!("Liked Songs could not be saved: {error}"))
}

fn absolute_paths(root: &Path, entries: &[String]) -> Vec<String> {
    entries
        .iter()
        .filter_map(|entry| entry_path(root, entry))
        .map(|path| path_string(&path))
        .collect()
}

fn library_root(root_path: &str) -> Result<PathBuf, String> {
    let root = resolve(root_path);
    if !root.is_dir() {
        return Err("Choose a music folder first.".into());
    }
    Ok(root)
}

/// Absolute paths of every referenced like, in the order they were liked. Missing files
/// are kept on disk (a drive can come back) and simply fail to resolve in the renderer.
pub fn read_liked(root_path: &str) -> Result<Vec<String>, String> {
    let root = library_root(root_path)?;
    Ok(absolute_paths(&root, &read_entries(&root)))
}

pub fn set_track_liked(
    root_path: &str,
    track_path: &str,
    liked: bool,
) -> Result<Vec<String>, String> {
    let root = library_root(root_path)?;
    let track = resolve(track_path);
    if !is_path_inside(&root, &track, false) || !is_audio(&track) {
        return Err("That song is not inside the selected music library.".into());
    }
    let Some(entry) = relative_entry(&root, &track) else {
        return Err("That song is not inside the selected music library.".into());
    };
    // Directly in the root means "liked by location"; there is nothing to record, and
    // unliking would mean moving the user's file, which this command never does.
    if !entry.contains('/') {
        if liked {
            return Ok(absolute_paths(&root, &read_entries(&root)));
        }
        return Err("This song is stored in your Liked Songs folder. Move the file out of the root folder to unlike it.".into());
    }
    let mut entries = read_entries(&root);
    let key = entry.to_lowercase();
    let present = entries.iter().any(|value| value.to_lowercase() == key);
    if liked && !present {
        if !track.is_file() {
            return Err("That song could not be found on disk.".into());
        }
        entries.push(entry);
    } else if !liked && present {
        entries.retain(|value| value.to_lowercase() != key);
    } else {
        return Ok(absolute_paths(&root, &entries));
    }
    write_entries(&root, &entries)?;
    Ok(absolute_paths(&root, &entries))
}

/// Persists a manual order for the referenced likes. Unknown paths are ignored and any
/// stored like the renderer did not mention keeps its place at the end, so a stale view
/// can reorder but never drop a like.
pub fn reorder_liked(root_path: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let root = library_root(root_path)?;
    let entries = read_entries(&root);
    let mut remaining: Vec<Option<&String>> = entries.iter().map(Some).collect();
    let mut ordered = Vec::with_capacity(entries.len());
    for path in paths {
        let Some(key) = relative_entry(&root, &resolve(path)).map(|value| value.to_lowercase())
        else {
            continue;
        };
        let slot = remaining
            .iter_mut()
            .find(|slot| slot.is_some_and(|value| value.to_lowercase() == key));
        if let Some(value) = slot.and_then(Option::take) {
            ordered.push(value.clone());
        }
    }
    ordered.extend(remaining.into_iter().flatten().cloned());
    if ordered != entries {
        write_entries(&root, &ordered)?;
    }
    Ok(absolute_paths(&root, &ordered))
}

/// Keeps likes attached when a playlist folder is renamed through Lyra.
pub fn remap_folder(root_path: &str, old_folder: &Path, new_folder: &Path) -> Result<(), String> {
    let root = library_root(root_path)?;
    let (Some(old_prefix), Some(new_prefix)) = (
        relative_entry(&root, old_folder),
        relative_entry(&root, new_folder),
    ) else {
        return Ok(());
    };
    // Compare segment-wise: slicing by a lowercased prefix's byte length is not safe for
    // names whose case mapping changes their UTF-8 length.
    let old_parts: Vec<String> = old_prefix.split('/').map(str::to_lowercase).collect();
    let mut changed = false;
    let entries: Vec<String> = read_entries(&root)
        .into_iter()
        .map(|entry| {
            let parts: Vec<&str> = entry.split('/').collect();
            let inside = parts.len() > old_parts.len()
                && parts
                    .iter()
                    .zip(&old_parts)
                    .all(|(part, old)| part.to_lowercase() == *old);
            if inside {
                changed = true;
                format!("{new_prefix}/{}", parts[old_parts.len()..].join("/"))
            } else {
                entry
            }
        })
        .collect();
    if changed {
        write_entries(&root, &entries)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::tests::TestDirectory;

    fn fixture() -> (TestDirectory, PathBuf, PathBuf) {
        let directory = TestDirectory::new();
        let root = directory.0.join("Music");
        let album = root.join("Album");
        std::fs::create_dir_all(&album).unwrap();
        let song = album.join("song.mp3");
        std::fs::write(&song, b"fixture").unwrap();
        std::fs::write(root.join("root.mp3"), b"fixture").unwrap();
        (directory, root, song)
    }

    #[test]
    fn like_and_unlike_round_trip_as_relative_entries() {
        let (_directory, root, song) = fixture();
        let root_text = path_string(&root);
        let liked = set_track_liked(&root_text, &path_string(&song), true).unwrap();
        assert_eq!(
            liked,
            vec![path_string(&root.join("Album").join("song.mp3"))]
        );
        let stored = std::fs::read_to_string(root.join(LIKED_SONGS_FILE)).unwrap();
        assert!(stored.contains("\"Album/song.mp3\""));
        // Liking twice must not duplicate the entry.
        assert_eq!(
            set_track_liked(&root_text, &path_string(&song), true)
                .unwrap()
                .len(),
            1
        );
        assert!(set_track_liked(&root_text, &path_string(&song), false)
            .unwrap()
            .is_empty());
        assert!(read_liked(&root_text).unwrap().is_empty());
    }

    #[test]
    fn root_tracks_are_liked_by_location_and_cannot_be_unliked_here() {
        let (_directory, root, _song) = fixture();
        let root_text = path_string(&root);
        let root_song = path_string(&root.join("root.mp3"));
        assert!(set_track_liked(&root_text, &root_song, true)
            .unwrap()
            .is_empty());
        assert!(set_track_liked(&root_text, &root_song, false).is_err());
        assert!(!root.join(LIKED_SONGS_FILE).exists());
    }

    #[test]
    fn tampered_entries_and_outside_paths_are_rejected() {
        let (directory, root, _song) = fixture();
        std::fs::write(
            root.join(LIKED_SONGS_FILE),
            r#"{"version":1,"tracks":["../outside.mp3","C:/Windows/win.ini","Album/song.mp3"]}"#,
        )
        .unwrap();
        let liked = read_liked(&path_string(&root)).unwrap();
        assert_eq!(
            liked,
            vec![path_string(&root.join("Album").join("song.mp3"))]
        );
        let outside = directory.0.join("outside.mp3");
        std::fs::write(&outside, b"fixture").unwrap();
        assert!(set_track_liked(&path_string(&root), &path_string(&outside), true).is_err());
    }

    #[test]
    fn reorder_keeps_unmentioned_likes_and_rename_remaps_prefix() {
        let (_directory, root, song) = fixture();
        let root_text = path_string(&root);
        let other = root.join("Album").join("other.mp3");
        std::fs::write(&other, b"fixture").unwrap();
        set_track_liked(&root_text, &path_string(&song), true).unwrap();
        set_track_liked(&root_text, &path_string(&other), true).unwrap();
        let ordered = reorder_liked(&root_text, &[path_string(&other)]).unwrap();
        assert_eq!(
            ordered,
            vec![
                path_string(&root.join("Album").join("other.mp3")),
                path_string(&root.join("Album").join("song.mp3"))
            ]
        );
        remap_folder(&root_text, &root.join("Album"), &root.join("Renamed")).unwrap();
        assert_eq!(
            read_liked(&root_text).unwrap(),
            vec![
                path_string(&root.join("Renamed").join("other.mp3")),
                path_string(&root.join("Renamed").join("song.mp3"))
            ]
        );
    }
}
