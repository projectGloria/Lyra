use serde::{Deserialize, Serialize};

/// Every path-shaped field crosses to the frontend as a *path*, never a URL. The bridge
/// (`src/tauri-bridge.js`) turns `path` into `url` and `artworkPath` into `artworkUrl`
/// with `convertFileSrc`, because only the asset protocol can serve these files to the
/// webview. The bridge derives matching URL fields from every `path` or `*Path` key.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album_artist: String,
    pub album: String,
    #[serde(default)]
    pub year: u32,
    #[serde(default)]
    pub genre: String,
    #[serde(default)]
    pub comment: String,
    pub duration: f64,
    pub duration_label: String,
    pub date_added: f64,
    pub folder_path: String,
    pub artwork_path: String,
    pub track_no: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub path: String,
    pub description: String,
    pub artwork_path: String,
    pub tracks: Vec<Track>,
    pub is_root: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub root_path: String,
    pub ok: bool,
    pub error: String,
    pub liked_songs: Vec<Track>,
    pub liked_songs_artwork_path: String,
    pub folders: Vec<Folder>,
    pub folder_count: usize,
    pub track_count: usize,
    pub scanned_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
}

impl Library {
    pub fn failed(root_path: &str, error: &str) -> Self {
        Library {
            root_path: root_path.to_string(),
            ok: false,
            error: error.to_string(),
            liked_songs: Vec::new(),
            liked_songs_artwork_path: String::new(),
            folders: Vec::new(),
            folder_count: 0,
            track_count: 0,
            scanned_at: crate::util::now_ms(),
            cancelled: None,
        }
    }

    pub fn cancelled(root_path: &str) -> Self {
        let mut library = Library::failed(root_path, "cancelled");
        library.cancelled = Some(true);
        library
    }
}

/// Shape of the `library:progress` event. Mirrors `state.scanProgress` in the renderer;
/// `scanId` is echoed back so the renderer can drop events from a superseded scan.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_id: u64,
    pub stage: String,
    pub label: String,
    pub detail: String,
    pub percent: u32,
    pub processed: usize,
    pub total: usize,
    pub folders: usize,
    pub tracks: usize,
    pub timestamp: i64,
}

/// Per-folder sidecar (`.lyra-playlist.json`) holding the user's overrides. The music
/// folder is the database; this file is the only place custom names, descriptions, covers
/// and manual track order live.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlaylistMetadata {
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub folder_name: String,
    pub description: String,
    pub artwork_file: String,
    pub track_order: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistResult {
    pub ok: bool,
    pub id: String,
    pub folder_path: String,
    pub name: String,
    pub description: String,
    pub artwork_path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub warning: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    pub id: String,
    pub folder_path: String,
    pub audio_count: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueTrack {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub duration: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackEditResult {
    pub ok: bool,
    pub track: Track,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_scanned_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned_at: Option<i64>,
}
