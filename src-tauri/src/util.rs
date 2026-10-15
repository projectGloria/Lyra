use std::cmp::Ordering;
use std::fmt::Write as FmtWrite;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha1::{Digest, Sha1};

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "flac", "m4a", "m4b", "aac", "ogg", "oga", "opus", "webm", "mka",
];

pub const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "webp", "avif", "gif", "bmp", "ico", "svg",
];

pub const PLAYLIST_METADATA_FILE: &str = ".lyra-playlist.json";
pub const PLAYLIST_COVER_PREFIX: &str = ".lyra-cover";

pub fn extension_lower(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
}

pub fn is_audio(path: &Path) -> bool {
    AUDIO_EXTENSIONS.contains(&extension_lower(path).as_str())
}

pub fn is_image(path: &Path) -> bool {
    IMAGE_EXTENSIONS.contains(&extension_lower(path).as_str())
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string()
}

pub fn file_stem_lower(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// Stable short identity for a path. Matches the Electron build's `sha1(path)[0..16]`
/// so ids stay recognisable, but only internal consistency actually matters.
pub fn make_id(value: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub fn sha1_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(40);
    for byte in digest.iter() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Cache keys are case-folded and slash-normalised: the same file must not produce two
/// entries just because it was reached through a differently-cased path.
pub fn cache_key(path: &Path) -> String {
    path_string(path).replace('\\', "/").to_lowercase()
}

#[derive(Clone, Copy, Default, PartialEq)]
pub struct Signature {
    pub size: u64,
    pub mtime_ms: f64,
}

pub fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as f64)
        .unwrap_or(0.0)
}

pub fn file_signature(path: &Path) -> Signature {
    match std::fs::metadata(path) {
        Ok(meta) => Signature {
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
        },
        Err(_) => Signature::default(),
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_millis() as i64)
        .unwrap_or(0)
}

/// Case-insensitive, separator-normalised containment test. Both sides are canonicalised
/// when they exist, so `..` segments and symlinks cannot be used to escape the root.
pub fn is_path_inside(root: &Path, target: &Path, allow_root: bool) -> bool {
    let root = normalize_for_compare(root);
    let target = normalize_for_compare(target);
    if root.is_empty() || target.is_empty() {
        return false;
    }
    if target == root {
        return allow_root;
    }
    target.starts_with(&format!("{root}/"))
}

fn normalize_for_compare(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut value = resolved.to_string_lossy().replace('\\', "/");
    // Windows canonicalisation yields a `\\?\` verbatim prefix; drop it so a canonicalised
    // root and a lexical target still compare as the same string.
    if let Some(stripped) = value.strip_prefix("//?/") {
        value = stripped.to_string();
    }
    while value.len() > 1 && value.ends_with('/') {
        value.pop();
    }
    value.to_lowercase()
}

pub fn resolve(path: &str) -> PathBuf {
    let path = PathBuf::from(path.trim());
    if path.is_absolute() {
        return path;
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(&path))
        .unwrap_or(path)
}

/// Digit-aware comparison so "Track 2" sorts before "Track 10". Mirrors the
/// `localeCompare(..., { numeric: true, sensitivity: 'base' })` the UI was built against.
pub fn natural_cmp(first: &str, second: &str) -> Ordering {
    let mut left = first;
    let mut right = second;
    while let (Some(a), Some(b)) = (left.chars().next(), right.chars().next()) {
        if a.is_ascii_digit() && b.is_ascii_digit() {
            let i = left.bytes().take_while(u8::is_ascii_digit).count();
            let j = right.bytes().take_while(u8::is_ascii_digit).count();
            let x = left[..i].trim_start_matches('0');
            let y = right[..j].trim_start_matches('0');
            let order = x.len().cmp(&y.len()).then_with(|| x.cmp(y));
            if order != Ordering::Equal {
                return order;
            }
            left = &left[i..];
            right = &right[j..];
        } else {
            let order = a.to_lowercase().cmp(b.to_lowercase());
            if order != Ordering::Equal {
                return order;
            }
            left = &left[a.len_utf8()..];
            right = &right[b.len_utf8()..];
        }
    }
    left.is_empty().cmp(&right.is_empty()).reverse()
}

pub fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds <= 0.0 {
        return "--:--".to_string();
    }
    let total = seconds.floor() as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// Playlists are real directories, so the requested name has to survive as a folder name.
/// Returns `fallback` when nothing usable (or a reserved Windows device name) is left.
pub fn sanitize_playlist_name(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| {
            !matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) && !character.is_control()
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(&['.', ' '][..]).trim();
    let cleaned: String = cleaned.chars().take(120).collect();
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.chars().count() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem
                .chars()
                .nth(3)
                .map(|c| matches!(c, '1'..='9' | '¹' | '²' | '³'))
                == Some(true));
    if cleaned.is_empty() || reserved {
        return fallback.to_string();
    }
    cleaned
}

pub struct DirectoryEntry {
    pub path: PathBuf,
    pub file_type: std::fs::FileType,
}

pub fn read_dir_entries(directory: &Path) -> Vec<DirectoryEntry> {
    try_read_dir_entries(directory).unwrap_or_default()
}

pub fn try_read_dir_entries(directory: &Path) -> std::io::Result<Vec<DirectoryEntry>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        entries.push((path_string(&path), DirectoryEntry { path, file_type }));
    }
    entries.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    Ok(entries.into_iter().map(|(_, entry)| entry).collect())
}

pub fn write_json_atomic(path: &Path, value: &impl serde::Serialize) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let temporary = path.with_file_name(format!(
        "{}.tmp-{}-{}",
        file_name(path),
        std::process::id(),
        NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = (|| {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, value)?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        std::fs::rename(&temporary, path)?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub fn sweep_stale_temp_files(directory: &Path) {
    sweep_stale_temp_files_depth(directory, 0, 8);
}

fn sweep_stale_temp_files_depth(directory: &Path, depth: usize, max_depth: usize) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(300))
        .unwrap_or(UNIX_EPOCH);
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(file_type) = entry.file_type() {
            if file_type.is_dir() && !file_type.is_symlink() {
                sweep_stale_temp_files_depth(&path, depth + 1, max_depth);
            } else if file_type.is_file() {
                let name = file_name(&path);
                if is_managed_temporary(&name) {
                    if let Ok(meta) = entry.metadata() {
                        if meta.modified().is_ok_and(|mtime| mtime < cutoff) {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                }
            }
        }
    }
}

/// Only names emitted by our JSON/cover writers qualify for automatic cleanup.
pub fn is_managed_temporary(name: &str) -> bool {
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    if let Some(timestamp) = name.strip_prefix(".lyra-cover-staging-") {
        return digits(timestamp);
    }
    if let Some(token) = name.strip_prefix(".lyra-tag-staging-") {
        return token
            .split_once('-')
            .is_some_and(|(pid, sequence)| digits(pid) && digits(sequence));
    }
    let Some((target, suffix)) = name.rsplit_once(".tmp-") else {
        return false;
    };
    let known = matches!(
        target,
        ".lyra-playlist.json" | "settings.json" | "library-snapshot.json"
    ) || target
        .strip_prefix("track-metadata-cache-v")
        .and_then(|v| v.strip_suffix(".json"))
        .is_some_and(digits);
    let Some((pid, sequence)) = suffix.split_once('-') else {
        return false;
    };
    known && digits(pid) && digits(sequence)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn temporary_cleanup_only_recognizes_managed_names() {
        for name in [
            "mix.tmp-final.mp3",
            "notes.tmp-1-2",
            ".lyra-cover-staging-family.jpg",
            ".lyra-tag-staging-family-1",
            "settings.json.tmp-1-2-extra",
        ] {
            assert!(!is_managed_temporary(name), "{name}");
        }
        for name in [
            ".lyra-playlist.json.tmp-123-4",
            "settings.json.tmp-123-4",
            "track-metadata-cache-v5.json.tmp-1-2",
            ".lyra-cover-staging-123",
            ".lyra-tag-staging-123-4",
        ] {
            assert!(is_managed_temporary(name), "{name}");
        }
    }

    pub struct TestDirectory(pub PathBuf);
    impl TestDirectory {
        pub fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "lyra-review-test-{}-{}-{}",
                std::process::id(),
                now_ms(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            if let Ok(root) = std::fs::canonicalize(&self.0) {
                assert!(
                    root.starts_with(&temp)
                        && root != temp
                        && file_name(&root).starts_with("lyra-review-test-")
                );
                let _ = std::fs::remove_dir_all(root);
            }
        }
    }

    #[test]
    fn natural_order_handles_large_numbers_unicode_and_leading_zeroes() {
        assert_eq!(natural_cmp("Track 2", "track 10"), Ordering::Less);
        assert_eq!(natural_cmp("x0002", "x2"), Ordering::Equal);
        assert_eq!(
            natural_cmp("x999999999999999999999", "x1000000000000000000000"),
            Ordering::Less
        );
        assert_eq!(natural_cmp("Ä2", "ä10"), Ordering::Less);
        assert_eq!(natural_cmp("a", "ab"), Ordering::Less);
        assert_eq!(natural_cmp("", ""), Ordering::Equal);
    }

    #[test]
    fn reserved_windows_names_include_extensions_and_superscripts() {
        for name in [
            "CON",
            "con.mp3",
            "NUL.txt",
            "COM1.foo",
            "LPT9",
            "COM¹",
            "LPT².png",
            "COM³",
            "..",
            "<>:",
        ] {
            assert_eq!(
                sanitize_playlist_name(name, "Playlist"),
                "Playlist",
                "{name}"
            );
        }
        assert_eq!(sanitize_playlist_name("  Album. ", "Fallback"), "Album");
        assert_eq!(sanitize_playlist_name("COM10", "Fallback"), "COM10");
    }

    #[test]
    fn durations_and_hashes_are_stable() {
        assert_eq!(format_duration(f64::NAN), "--:--");
        assert_eq!(format_duration(0.0), "--:--");
        assert_eq!(format_duration(125.9), "2:05");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(make_id("abc"), "a9993e364706816a");
    }

    #[test]
    fn containment_rejects_siblings_and_traversal() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("music");
        let sibling = fixture.0.join("music-other");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        assert!(is_path_inside(&root, &root, true));
        assert!(!is_path_inside(&root, &root, false));
        assert!(!is_path_inside(&root, &sibling, false));
        assert!(!is_path_inside(&root, &root.join("../music-other"), false));
    }

    #[test]
    fn atomic_write_replaces_files_and_cleans_failed_temporary_files() {
        let fixture = TestDirectory::new();
        let target = fixture.0.join("settings.json");
        write_json_atomic(&target, &serde_json::json!({"a": 1})).unwrap();
        write_json_atomic(&target, &serde_json::json!({"a": 2})).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"a\":2}");
        let directory_target = fixture.0.join("directory.json");
        std::fs::create_dir(&directory_target).unwrap();
        assert!(write_json_atomic(&directory_target, &serde_json::json!({})).is_err());
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 2);
    }
}
