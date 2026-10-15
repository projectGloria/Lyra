use crate::library_delta::LibraryDelta;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::model::{Library, Track};
use crate::util::{cache_key, file_signature, Signature};

// Bump when artwork assignment rules change so stale inherited covers are never reused.
const TRACK_CACHE_VERSION: u32 = 5;
const LIBRARY_SNAPSHOT_VERSION: u32 = 5;

pub fn track_cache_file(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("track-metadata-cache-v{TRACK_CACHE_VERSION}.json"))
}

pub fn library_snapshot_file(data_dir: &Path) -> PathBuf {
    data_dir.join("library-snapshot.json")
}

pub fn artwork_cache_directory(data_dir: &Path) -> PathBuf {
    data_dir.join("artwork-cache")
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSignature {
    size: u64,
    mtime_ms: f64,
}

impl From<Signature> for StoredSignature {
    fn from(value: Signature) -> Self {
        StoredSignature {
            size: value.size,
            mtime_ms: value.mtime_ms,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackCacheEntry {
    size: u64,
    mtime_ms: f64,
    artwork_signature: StoredSignature,
    /// Records that the file's embedded pictures were read and found absent, so a track
    /// with genuinely no cover is not re-parsed on every scan. A *failed* parse is not a
    /// negative result and stays unflagged, or one transient read error would strip the
    /// artwork from a track permanently.
    #[serde(default)]
    embedded_checked: bool,
    track: Track,
}

#[derive(Default, Serialize, Deserialize)]
struct TrackCacheFile {
    version: u32,
    #[serde(default)]
    revision: u64,
    entries: HashMap<String, TrackCacheEntry>,
}

/// Copy-on-write is limited to one shard when a scan changes a single track.
#[derive(Clone)]
struct CacheEntries {
    shards: Vec<Arc<HashMap<String, TrackCacheEntry>>>,
}
impl Default for CacheEntries {
    fn default() -> Self {
        Self {
            shards: (0..64).map(|_| Arc::new(HashMap::new())).collect(),
        }
    }
}
impl CacheEntries {
    fn shard(key: &str) -> usize {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut hash);
        hash.finish() as usize % 64
    }
    fn get(&self, key: &str) -> Option<&TrackCacheEntry> {
        self.shards[Self::shard(key)].get(key)
    }
    fn insert(&mut self, key: String, entry: TrackCacheEntry) {
        Arc::make_mut(&mut self.shards[Self::shard(&key)]).insert(key, entry);
    }
    fn remove(&mut self, key: &str) {
        Arc::make_mut(&mut self.shards[Self::shard(key)]).remove(key);
    }
    fn keys(&self) -> impl Iterator<Item = &String> {
        self.shards.iter().flat_map(|shard| shard.keys())
    }
    fn values(&self) -> impl Iterator<Item = &TrackCacheEntry> {
        self.shards.iter().flat_map(|shard| shard.values())
    }
    fn extend(&mut self, entries: HashMap<String, TrackCacheEntry>) {
        for (key, entry) in entries {
            self.insert(key, entry);
        }
    }
    fn flatten(&self) -> HashMap<String, TrackCacheEntry> {
        self.shards
            .iter()
            .flat_map(|shard| {
                shard
                    .iter()
                    .map(|(key, entry)| (key.clone(), entry.clone()))
            })
            .collect()
    }
}
impl From<HashMap<String, TrackCacheEntry>> for CacheEntries {
    fn from(entries: HashMap<String, TrackCacheEntry>) -> Self {
        let mut result = Self::default();
        result.extend(entries);
        result
    }
}

#[derive(Clone, Default)]
pub struct TrackCache {
    entries: CacheEntries,
    revision: u64,
    dirty: HashSet<String>,
}

impl TrackCache {
    pub fn load(data_dir: &Path) -> Self {
        let mut memory = track_memory().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cache) = memory.get(data_dir) {
            return cache.clone();
        }
        let parsed = std::fs::read_to_string(track_cache_file(data_dir))
            .ok()
            .and_then(|raw| serde_json::from_str::<TrackCacheFile>(&raw).ok())
            .filter(|file| file.version == TRACK_CACHE_VERSION)
            .unwrap_or_default();
        let mut cache = Self {
            entries: parsed.entries.into(),
            revision: parsed.revision,
            dirty: HashSet::new(),
        };
        for patch in read_journal::<TrackPatch>(&track_journal(data_dir)) {
            if patch.revision <= cache.revision {
                continue;
            }
            let entries = &mut cache.entries;
            for key in patch.removed {
                entries.remove(&key);
            }
            entries.extend(patch.entries);
            cache.revision = patch.revision;
        }
        memory.insert(data_dir.to_path_buf(), cache.clone());
        cache
    }

    /// Returns the cached track only when both the audio file and its sidecar artwork are
    /// unchanged. Artwork has to be part of the validity test: dropping a `cover.jpg` into
    /// a folder changes no audio file, and without this the new cover never appears.
    pub fn get(&self, file_path: &Path, signature: Signature) -> Option<&TrackCacheEntry> {
        let entry = self.entries.get(&cache_key(file_path))?;
        if entry.size != signature.size || entry.mtime_ms != signature.mtime_ms {
            return None;
        }
        if !entry.track.artwork_path.is_empty() {
            let current = file_signature(Path::new(&entry.track.artwork_path));
            if current.size != entry.artwork_signature.size
                || current.mtime_ms != entry.artwork_signature.mtime_ms
            {
                return None;
            }
        }
        Some(entry)
    }

    pub fn cached_track(&self, file_path: &Path, signature: Signature) -> Option<(Track, bool)> {
        self.get(file_path, signature)
            .map(|entry| (entry.track.clone(), entry.embedded_checked))
    }

    pub fn unchanged_track(&self, path: &Path) -> Option<(Track, bool, Signature)> {
        let entry = self.entries.get(&cache_key(path))?;
        Some((
            entry.track.clone(),
            entry.embedded_checked,
            Signature {
                size: entry.size,
                mtime_ms: entry.mtime_ms,
            },
        ))
    }

    pub fn raw_track(&self, path: &Path) -> Option<&Track> {
        self.entries.get(&cache_key(path)).map(|entry| &entry.track)
    }

    pub fn tracks(&self) -> impl Iterator<Item = &Track> {
        self.entries.values().map(|entry| &entry.track)
    }

    pub fn retry_paths(&self) -> HashSet<&str> {
        self.entries
            .values()
            .filter(|entry| !entry.embedded_checked)
            .map(|entry| entry.track.path.as_str())
            .collect()
    }

    pub fn insert(
        &mut self,
        file_path: &Path,
        signature: Signature,
        track: &Track,
        embedded_checked: bool,
    ) {
        let artwork_signature = if track.artwork_path.is_empty() {
            Signature::default()
        } else {
            file_signature(Path::new(&track.artwork_path))
        };
        let key = cache_key(file_path);
        self.dirty.insert(key.clone());
        self.entries.insert(
            key,
            TrackCacheEntry {
                size: signature.size,
                mtime_ms: signature.mtime_ms,
                artwork_signature: artwork_signature.into(),
                embedded_checked,
                track: track.clone(),
            },
        );
    }

    /// Persist only changed entries; compact bounded journals into a base periodically.
    pub fn save(&self, data_dir: &Path, root: &Path, active_paths: &[PathBuf]) {
        let active: HashSet<String> = active_paths.iter().map(|path| cache_key(path)).collect();
        let prefix = format!("{}/", cache_key(root).trim_end_matches('/'));
        let removed: Vec<String> = self
            .entries
            .keys()
            .filter(|key| key.starts_with(&prefix) && !active.contains(*key))
            .cloned()
            .collect();
        self.persist_changes(data_dir, removed);
    }

    pub fn save_incremental(&self, data_dir: &Path, removed_paths: &[PathBuf]) {
        let removed = removed_paths
            .iter()
            .map(|path| cache_key(path))
            .filter(|key| self.entries.get(key).is_some())
            .collect();
        self.persist_changes(data_dir, removed);
    }

    fn persist_changes(&self, data_dir: &Path, removed: Vec<String>) {
        let previous = track_memory()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(data_dir)
            .cloned()
            .unwrap_or_default();
        let entries: HashMap<String, TrackCacheEntry> = self
            .dirty
            .iter()
            .filter_map(|key| {
                let entry = self.entries.get(key)?;
                if removed.contains(key) || previous.entries.get(key) == Some(entry) {
                    None
                } else {
                    Some((key.clone(), entry.clone()))
                }
            })
            .collect();
        let base = track_cache_file(data_dir);
        if entries.is_empty() && removed.is_empty() && base.exists() {
            return;
        }
        let revision = previous.revision + 1;
        let patch = TrackPatch {
            revision,
            entries,
            removed,
        };
        let mut next = self.clone();
        for key in &patch.removed {
            next.entries.remove(key);
        }
        next.revision = revision;
        next.dirty.clear();
        let journal = track_journal(data_dir);
        let result = if !base.exists() || journal_too_large(&journal) {
            let payload = TrackCacheFile {
                version: TRACK_CACHE_VERSION,
                revision,
                entries: next.entries.flatten(),
            };
            crate::util::write_json_atomic(&base, &payload).map(|_| {
                let _ = std::fs::remove_file(&journal);
            })
        } else {
            append_journal(&journal, &patch)
        };
        if result.is_ok() {
            track_memory()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(data_dir.to_path_buf(), next);
        }
    }

    /// Persist dirty entries without purging non-active paths. Useful for single-track edits.
    pub fn save_changes(&self, data_dir: &Path) {
        self.persist_changes(data_dir, Vec::new());
    }
}

#[derive(Serialize, Deserialize)]
struct TrackPatch {
    revision: u64,
    entries: HashMap<String, TrackCacheEntry>,
    removed: Vec<String>,
}
fn track_journal(data_dir: &Path) -> PathBuf {
    data_dir.join("track-cache-updates.jsonl")
}
fn snapshot_journal(data_dir: &Path) -> PathBuf {
    data_dir.join("library-updates.jsonl")
}
fn track_memory() -> &'static Mutex<HashMap<PathBuf, TrackCache>> {
    static MEMORY: OnceLock<Mutex<HashMap<PathBuf, TrackCache>>> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(HashMap::new()))
}
fn snapshot_memory() -> &'static Mutex<HashMap<PathBuf, LibrarySnapshotFile>> {
    static MEMORY: OnceLock<Mutex<HashMap<PathBuf, LibrarySnapshotFile>>> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Scans capture a revision before reading and verify it at commit. Edits hold this
/// lock only for their mutation, so they never wait for metadata discovery/parsing.
pub fn transaction(data_dir: &Path) -> Arc<Mutex<u64>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<u64>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(data_dir.to_path_buf())
        .or_default()
        .clone()
}

fn journal_too_large(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.len() >= 4 * 1024 * 1024)
}

fn append_journal(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let original_len = file.metadata()?.len();
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = file.set_len(original_len);
        return Err(error);
    }
    Ok(())
}

fn read_journal<T: serde::de::DeserializeOwned>(path: &Path) -> Vec<T> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut reader = std::io::BufReader::new(file);
    let mut records = Vec::new();
    let mut valid_bytes = 0;
    loop {
        let mut line = Vec::new();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(size) => {
                if line.last() != Some(&b'\n') {
                    break;
                }
                let Ok(value) = serde_json::from_slice(&line) else {
                    break;
                };
                valid_bytes += size as u64;
                records.push(value);
            }
            Err(_) => break,
        }
    }
    // Drop the read handle before repairing an incomplete tail on Windows.
    drop(reader);
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
        if file.metadata().is_ok_and(|m| m.len() != valid_bytes) {
            let _ = file.set_len(valid_bytes);
        }
    }
    records
}

#[derive(Clone, Serialize, Deserialize)]
struct LibrarySnapshotFile {
    version: u32,
    #[serde(default)]
    revision: u64,
    library: Library,
}

#[derive(Serialize, Deserialize)]
struct SnapshotPatch {
    revision: u64,
    changes: LibraryDelta,
}

pub fn write_snapshot(data_dir: &Path, library: &Library) {
    let mut memory = snapshot_memory().lock().unwrap_or_else(|e| e.into_inner());
    let previous = memory.get(data_dir);
    let revision = previous.map(|file| file.revision).unwrap_or(0) + 1;
    let base = library_snapshot_file(data_dir);
    let journal = snapshot_journal(data_dir);
    let delta = previous
        .filter(|old| old.library.root_path == library.root_path)
        .map(|old| LibraryDelta::between(&old.library, library));
    if let (Some(delta), Some(old)) = (&delta, previous) {
        if delta.is_empty(&old.library) {
            let mut updated = old.clone();
            updated.library.scanned_at = library.scanned_at;
            memory.insert(data_dir.to_path_buf(), updated);
            return;
        }
    }
    let payload = LibrarySnapshotFile {
        version: LIBRARY_SNAPSHOT_VERSION,
        revision,
        library: library.clone(),
    };
    let result =
        if let Some(changes) = delta.filter(|_| base.exists() && !journal_too_large(&journal)) {
            append_journal(&journal, &SnapshotPatch { revision, changes })
        } else {
            crate::util::write_json_atomic(&base, &payload).map(|_| {
                let _ = std::fs::remove_file(&journal);
            })
        };
    if result.is_ok() {
        memory.insert(data_dir.to_path_buf(), payload);
    }
}

pub fn read_snapshot(data_dir: &Path, root_path: &str) -> Option<Library> {
    let requested = root_path.trim();
    if requested.is_empty() {
        return None;
    }
    let mut memory = snapshot_memory().lock().unwrap_or_else(|e| e.into_inner());
    if !memory.contains_key(data_dir) {
        let raw = std::fs::read_to_string(library_snapshot_file(data_dir)).ok()?;
        let mut parsed: LibrarySnapshotFile = serde_json::from_str(&raw).ok()?;
        if parsed.version != LIBRARY_SNAPSHOT_VERSION || !parsed.library.ok {
            return None;
        }
        for patch in read_journal::<SnapshotPatch>(&snapshot_journal(data_dir)) {
            if patch.revision > parsed.revision
                && patch.changes.root_path == parsed.library.root_path
            {
                patch.changes.apply_to(&mut parsed.library);
                parsed.revision = patch.revision;
            }
        }
        memory.insert(data_dir.to_path_buf(), parsed);
    }
    let parsed = memory.get(data_dir)?;
    let key = |value: &str| {
        value
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    (key(&parsed.library.root_path) == key(requested)).then(|| parsed.library.clone())
}

/// Startup maintenance is independent of scan eviction and sees references from all roots.
pub fn collect_artwork(data_dir: &Path, cache: &TrackCache) {
    crate::util::sweep_stale_temp_files(data_dir);
    let referenced: HashSet<String> = cache
        .entries
        .values()
        .map(|entry| cache_key(Path::new(&entry.track.artwork_path)))
        .collect();
    if let Ok(entries) = std::fs::read_dir(artwork_cache_directory(data_dir)) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_file())
                && !referenced.contains(&cache_key(&entry.path()))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::{path_string, tests::TestDirectory};

    fn track(root: &Path, name: &str) -> Track {
        Track {
            id: name.into(),
            path: path_string(&root.join(format!("{name}.mp3"))),
            title: name.into(),
            artist: "Artist".into(),
            album_artist: String::new(),
            album: "Album".into(),
            year: 0,
            genre: String::new(),
            comment: String::new(),
            duration: 1.0,
            duration_label: "0:01".into(),
            date_added: 0.0,
            folder_path: path_string(root),
            artwork_path: String::new(),
            track_no: 1,
        }
    }

    fn forget(data: &Path) {
        track_memory().lock().unwrap().remove(data);
        snapshot_memory().lock().unwrap().remove(data);
    }

    #[test]
    fn incremental_cache_changes_replay_without_evicting_other_roots() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("Music");
        let other = fixture.0.join("Other");
        let data = fixture.0.join("data");
        let a = track(&root, "A");
        let mut b = track(&root, "B");
        let c = track(&other, "C");
        let mut cache = TrackCache::load(&data);
        for track in [&a, &b, &c] {
            cache.insert(Path::new(&track.path), Signature::default(), track, true);
        }
        cache.save(
            &data,
            &root,
            &[PathBuf::from(&a.path), PathBuf::from(&b.path)],
        );
        let old_base = std::fs::read(track_cache_file(&data)).unwrap();
        b.title = "Edited B".into();
        let mut cache = TrackCache::load(&data);
        cache.insert(Path::new(&b.path), Signature::default(), &b, true);
        cache.save_incremental(&data, &[PathBuf::from(&a.path)]);
        assert_eq!(std::fs::read(track_cache_file(&data)).unwrap(), old_base);
        forget(&data);
        let restored = TrackCache::load(&data);
        assert!(restored.raw_track(Path::new(&a.path)).is_none());
        assert_eq!(
            restored.raw_track(Path::new(&b.path)).unwrap().title,
            "Edited B"
        );
        assert_eq!(restored.raw_track(Path::new(&c.path)), Some(&c));
    }

    #[test]
    fn journals_replay_track_edits_and_order_without_rewriting_bases() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("Music");
        let data = fixture.0.join("data");
        let a = track(&root, "A");
        let b = track(&root, "B");
        let active = vec![PathBuf::from(&a.path), PathBuf::from(&b.path)];
        let mut cache = TrackCache::load(&data);
        for t in [&a, &b] {
            cache.insert(Path::new(&t.path), Signature::default(), t, true);
        }
        cache.save(&data, &root, &active);
        let mut library = Library::failed(&path_string(&root), "");
        library.ok = true;
        library.liked_songs = vec![a.clone(), b.clone()];
        library.track_count = 2;
        write_snapshot(&data, &library);
        let old_cache = std::fs::read(track_cache_file(&data)).unwrap();
        let old_snapshot = std::fs::read(library_snapshot_file(&data)).unwrap();
        let mut updated = a.clone();
        updated.title = "Edited".into();
        let mut cache = TrackCache::load(&data);
        cache.insert(
            Path::new(&updated.path),
            Signature::default(),
            &updated,
            true,
        );
        cache.save(&data, &root, &active);
        library.liked_songs = vec![b.clone(), updated.clone()];
        library.scanned_at += 1;
        write_snapshot(&data, &library);
        assert_eq!(std::fs::read(track_cache_file(&data)).unwrap(), old_cache);
        assert_eq!(
            std::fs::read(library_snapshot_file(&data)).unwrap(),
            old_snapshot
        );
        forget(&data);
        assert_eq!(
            TrackCache::load(&data)
                .unchanged_track(Path::new(&a.path))
                .unwrap()
                .0
                .title,
            "Edited"
        );
        let restored = read_snapshot(&data, &path_string(&root)).unwrap();
        assert_eq!(restored.liked_songs, library.liked_songs);
        // A second identical commit does no disk work.
        let journal = std::fs::read(snapshot_journal(&data)).unwrap();
        write_snapshot(&data, &library);
        assert_eq!(std::fs::read(snapshot_journal(&data)).unwrap(), journal);
    }

    #[test]
    fn incomplete_journal_tail_is_repaired_before_the_next_write() {
        let fixture = TestDirectory::new();
        let path = fixture.0.join("journal.jsonl");
        append_journal(&path, &serde_json::json!({"value": 1})).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"value\":")
            .unwrap();
        assert_eq!(read_journal::<serde_json::Value>(&path).len(), 1);
        append_journal(&path, &serde_json::json!({"value": 2})).unwrap();
        let records = read_journal::<serde_json::Value>(&path);
        assert_eq!(records.len(), 2);
        assert_eq!(records[1]["value"], 2);
    }

    #[test]
    fn deltas_preserve_untouched_collections_and_remove_deleted_tracks() {
        let fixture = TestDirectory::new();
        let root = &fixture.0;
        let mut before = Library::failed(&path_string(root), "");
        before.ok = true;
        before.liked_songs = vec![track(root, "Root")];
        let folder_path = root.join("Album");
        before.folders.push(crate::model::Folder {
            id: "album".into(),
            name: "Album".into(),
            path: path_string(&folder_path),
            description: String::new(),
            artwork_path: String::new(),
            tracks: vec![track(&folder_path, "A"), track(&folder_path, "B")],
            is_root: false,
        });
        let mut after = before.clone();
        after.folders[0].tracks.remove(0);
        after.folders[0].description = "Updated".into();
        after.folders[0].tracks.push(track(&folder_path, "C"));
        let delta = LibraryDelta::between(&before, &after);
        assert_eq!(delta.tracks.len(), 1);
        delta.apply_to(&mut before);
        assert_eq!(
            serde_json::to_value(before).unwrap(),
            serde_json::to_value(after).unwrap()
        );
    }
}
