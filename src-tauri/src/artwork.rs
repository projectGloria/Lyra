use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use lofty::{Picture, PictureType};

use crate::util::{file_stem_lower, is_image, path_string, sha1_hex};

const MAX_EMBEDDED_ARTWORK_BYTES: usize = 16 * 1024 * 1024;

/// Directory listings are read once and reused. A scan asks the same folder for its images
/// once per track, so without this the artwork passes dominate the whole scan.
#[derive(Default)]
pub struct ArtworkIndex {
    directories: Mutex<HashMap<PathBuf, Arc<DirectoryImages>>>,
    embedded: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Default)]
struct DirectoryImages {
    paths: Vec<PathBuf>,
    by_stem: HashMap<String, Vec<usize>>,
}

impl ArtworkIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn for_scan(data_dir: &Path, changes: &[String]) -> Arc<Self> {
        let mut indices = scan_indices().lock().unwrap_or_else(|e| e.into_inner());
        if changes.is_empty() || !indices.contains_key(data_dir) {
            indices.insert(data_dir.to_path_buf(), Arc::new(Self::new()));
        }
        let index = indices.get(data_dir).unwrap().clone();
        for path in changes.iter().map(Path::new) {
            if !crate::util::is_audio(path) {
                if let Some(parent) = path.parent() {
                    index.directories.lock().unwrap().remove(parent);
                }
            }
        }
        index
    }

    pub fn invalidate(data_dir: &Path, directory: &Path) {
        if let Some(index) = scan_indices()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(data_dir)
        {
            index
                .directories
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(directory);
        }
    }

    pub fn invalidate_directory(directory: &Path) {
        for index in scan_indices()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            index
                .directories
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(directory);
        }
    }

    fn image_entries(&self, directory: &Path) -> Arc<DirectoryImages> {
        let mut directories = self.directories.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = directories.get(directory) {
            return cached.clone();
        }
        let paths: Vec<PathBuf> = crate::util::read_dir_entries(directory)
            .into_iter()
            .filter(|entry| entry.file_type.is_file() && is_image(&entry.path))
            .map(|entry| entry.path)
            .collect();
        let mut by_stem: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, path) in paths.iter().enumerate() {
            by_stem
                .entry(file_stem_lower(path))
                .or_default()
                .push(index);
        }
        let entries = Arc::new(DirectoryImages { paths, by_stem });
        directories.insert(directory.to_path_buf(), entries.clone());
        entries
    }

    /// Collection cover for a folder: a conventionally named image wins, otherwise the
    /// first image in the folder by name.
    pub fn find_folder_artwork(&self, directory: &Path) -> String {
        let named = self.find_named_folder_artwork(directory);
        if !named.is_empty() {
            return named;
        }
        self.image_entries(directory)
            .paths
            .first()
            .map(|path| path_string(path))
            .unwrap_or_default()
    }

    /// Only explicit collection covers are safe to use as track fallbacks.
    pub fn find_named_folder_artwork(&self, directory: &Path) -> String {
        let entries = self.image_entries(directory);
        if entries.paths.is_empty() {
            return String::new();
        }
        const PREFERRED: &[&str] = &[
            "cover",
            "folder",
            "front",
            "album",
            "albumart",
            "album-art",
            "artwork",
            "thumbnail",
            "thumb",
            "default",
        ];
        for preferred in PREFERRED {
            if let Some(index) = entries.by_stem.get(*preferred).and_then(|v| v.first()) {
                return path_string(&entries.paths[*index]);
            }
        }
        String::new()
    }

    /// Per-track sidecar image: `song.mp3` next to `song.jpg`. This is the strongest
    /// artwork signal there is and must never be overwritten by a collection cover.
    pub fn find_track_artwork(&self, file_path: &Path) -> String {
        self.track_artworks(file_path)
            .first()
            .map(|path| path_string(path))
            .unwrap_or_default()
    }

    /// Shared by lookup and editing so every recognized sidecar has the same policy.
    pub fn track_artworks(&self, file_path: &Path) -> Vec<PathBuf> {
        let Some(directory) = file_path.parent() else {
            return Vec::new();
        };
        let base = file_stem_lower(file_path);
        if base.is_empty() {
            return Vec::new();
        }
        let entries = self.image_entries(directory);
        let exact = entries.by_stem.get(&base).cloned().unwrap_or_default();
        let mut suffixes = Vec::new();
        for suffix in ["-cover", "_cover", " cover", "-front", "_front", " front"] {
            if let Some(indices) = entries.by_stem.get(&format!("{base}{suffix}")) {
                suffixes.extend(indices.iter().copied());
            }
        }
        suffixes.sort_unstable();
        exact
            .into_iter()
            .chain(suffixes)
            .map(|index| entries.paths[index].clone())
            .collect()
    }

    /// Writes an embedded picture into the artwork cache and returns its path. Files are
    /// named by the SHA-1 of their bytes, so one cover shared by a whole album is stored
    /// once no matter how many tracks carry it.
    pub fn materialize_embedded(&self, picture: &Picture, cache_directory: &Path) -> String {
        let data = picture.data();
        if data.is_empty() || data.len() > MAX_EMBEDDED_ARTWORK_BYTES {
            return String::new();
        }
        let hash = sha1_hex(data);
        if let Some(existing) = self
            .embedded
            .lock()
            .ok()
            .and_then(|map| map.get(&hash).cloned())
        {
            return path_string(&existing);
        }
        if std::fs::create_dir_all(cache_directory).is_err() {
            return String::new();
        }
        let target = cache_directory.join(format!("{hash}{}", sniff_extension(data)));
        if !target.exists() && std::fs::write(&target, data).is_err() {
            return String::new();
        }
        if let Ok(mut map) = self.embedded.lock() {
            map.insert(hash, target.clone());
        }
        path_string(&target)
    }
}

fn scan_indices() -> &'static Mutex<HashMap<PathBuf, Arc<ArtworkIndex>>> {
    static INDICES: OnceLock<Mutex<HashMap<PathBuf, Arc<ArtworkIndex>>>> = OnceLock::new();
    INDICES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Tags can carry a back cover, an artist photo and a booklet scan alongside the real
/// front cover, so picking `pictures[0]` blindly lands on the wrong image often enough
/// to matter.
pub fn pick_best_picture<'a>(
    pictures: impl IntoIterator<Item = &'a Picture>,
) -> Option<&'a Picture> {
    pictures
        .into_iter()
        .filter(|picture| {
            !picture.data().is_empty() && picture.data().len() <= MAX_EMBEDDED_ARTWORK_BYTES
        })
        .min_by_key(|picture| match picture.pic_type() {
            PictureType::CoverFront => 0,
            PictureType::Other => 1,
            _ => 2,
        })
}

/// Container formats are sniffed from the bytes rather than read off the tag's MIME
/// field, which arrives as a full MIME type from modern tags but as a bare "JPG" from
/// ID3v2.2 — and is simply wrong often enough that trusting it produced unreadable files.
fn sniff_extension(data: &[u8]) -> &'static str {
    match data {
        [0xFF, 0xD8, 0xFF, ..] => ".jpg",
        [0x89, b'P', b'N', b'G', ..] => ".png",
        [b'G', b'I', b'F', b'8', ..] => ".gif",
        [b'B', b'M', ..] => ".bmp",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => ".webp",
        _ => ".jpg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::tests::TestDirectory;

    #[test]
    fn sidecars_do_not_match_other_tracks_with_shared_prefixes() {
        let fixture = TestDirectory::new();
        std::fs::write(fixture.0.join("Song Remix.jpg"), b"image").unwrap();
        let track = fixture.0.join("Song.mp3");
        assert!(ArtworkIndex::new().find_track_artwork(&track).is_empty());
        std::fs::write(fixture.0.join("Song-cover.jpg"), b"image").unwrap();
        assert_eq!(
            ArtworkIndex::new().find_track_artwork(&track),
            path_string(&fixture.0.join("Song-cover.jpg"))
        );
        std::fs::write(fixture.0.join("Song.jpg"), b"image").unwrap();
        assert_eq!(
            ArtworkIndex::new().find_track_artwork(&track),
            path_string(&fixture.0.join("Song.jpg"))
        );
    }

    #[test]
    fn named_folder_artwork_ignores_other_sidecars_and_parent_covers() {
        let fixture = TestDirectory::new();
        let album = fixture.0.join("Album");
        std::fs::create_dir(&album).unwrap();
        std::fs::write(fixture.0.join("cover.jpg"), b"image").unwrap();
        std::fs::write(album.join("Other Song.jpg"), b"image").unwrap();
        assert!(ArtworkIndex::new()
            .find_named_folder_artwork(&album)
            .is_empty());
        std::fs::write(album.join("cover.png"), b"image").unwrap();
        assert_eq!(
            ArtworkIndex::new().find_named_folder_artwork(&album),
            path_string(&album.join("cover.png"))
        );
    }

    #[test]
    fn front_cover_in_later_tag_wins_and_empty_pictures_are_skipped() {
        let first = [Picture::new_unchecked(
            PictureType::CoverBack,
            None,
            None,
            vec![1],
        )];
        let second = [
            Picture::new_unchecked(PictureType::CoverFront, None, None, vec![]),
            Picture::new_unchecked(PictureType::CoverFront, None, None, vec![2]),
        ];
        assert_eq!(
            pick_best_picture(first.iter().chain(second.iter()))
                .unwrap()
                .data(),
            &[2]
        );
    }
}
