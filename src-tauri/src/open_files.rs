//! Explorer launches and the mini player. The mini player is a self-contained player with
//! its own webview and <audio>; the library window is never asked to play these files. The
//! only cross-window effect is a one-way "pause" nudge so two tracks don't play at once.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

use crate::model::Track;
use crate::util::{is_audio, make_id, path_string};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    id: u64,
    tracks: Vec<Track>,
    errors: Vec<String>,
}

#[derive(Default)]
struct Requests {
    id: u64,
    pending: Option<OpenRequest>,
    authorized: Vec<String>,
}

#[derive(Default)]
pub struct OpenFiles {
    requests: Mutex<Requests>,
}

pub fn fallback_track(path: &Path) -> Track {
    let text = path_string(path);
    Track {
        id: make_id(&text),
        path: text,
        title: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        artist: "Unknown artist".into(),
        folder_path: path.parent().map(path_string).unwrap_or_default(),
        duration_label: "--:--".into(),
        ..Track::default()
    }
}

fn validate_paths(args: &[String], cwd: &Path) -> (Vec<Track>, Vec<String>) {
    let mut tracks = Vec::new();
    let mut errors = Vec::new();
    for arg in args {
        let path = Path::new(arg);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        match path.canonicalize() {
            Ok(path) if path.is_file() && is_audio(&path) => {
                let track = fallback_track(&path);
                if !tracks
                    .iter()
                    .any(|existing: &Track| existing.path == track.path)
                {
                    tracks.push(track);
                }
            }
            _ => errors.push(format!(
                "Cannot open {}: missing or unsupported audio file",
                Path::new(arg)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            )),
        }
    }
    (tracks, errors)
}

pub fn show_main(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or("Library window is unavailable")?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

fn show_compact(app: &tauri::AppHandle) -> Result<(), String> {
    let window = match app.get_window("compact") {
        Some(window) => window,
        None => {
            tauri::WindowBuilder::new(app, "compact", tauri::WindowUrl::App("compact.html".into()))
                .title("Lyra — Mini Player")
                .inner_size(440.0, 240.0)
                .resizable(false)
                .decorations(false)
                .center()
                .build()
                .map_err(|e| e.to_string())?
        }
    };
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

pub fn receive(app: &tauri::AppHandle, args: &[String], cwd: &Path) -> Result<(), String> {
    if args.is_empty() {
        return show_main(app);
    }
    let state = app.state::<OpenFiles>();
    let (candidates, mut errors) = validate_paths(args, cwd);
    let mut tracks = Vec::new();
    for track in candidates {
        match app.asset_protocol_scope().allow_file(&track.path) {
            Ok(()) => tracks.push(track),
            Err(error) => errors.push(format!("Cannot open {}: {error}", track.title)),
        }
    }
    {
        let mut requests = state.requests.lock().unwrap_or_else(|e| e.into_inner());
        requests.id += 1;
        if !tracks.is_empty() {
            requests.authorized = tracks.iter().map(|t| t.path.clone()).collect();
        }
        requests.pending = Some(OpenRequest {
            id: requests.id,
            tracks,
            errors,
        });
    }
    show_compact(app)?;
    if let Some(compact) = app.get_window("compact") {
        // A wakeup, not a payload: the compact page drains via take_open_request, so a
        // freshly created window that isn't listening yet still picks it up on load.
        let _ = compact.emit("files:pending", ());
    }
    if let Some(main) = app.get_window("main") {
        // Deliberately the *only* thing the library hears about: pause, nothing else. No
        // hide, no queue swap, no resume later — the library's session stays exactly as
        // the user left it, and continuing it is a manual decision.
        let _ = main.emit("external:pause", ());
    }
    Ok(())
}

#[tauri::command]
pub fn take_open_request(
    window: tauri::Window,
    state: tauri::State<OpenFiles>,
) -> Result<Option<OpenRequest>, String> {
    if window.label() != "compact" {
        return Err("Only the mini player may consume opened files".into());
    }
    Ok(state
        .requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .pending
        .take())
}

#[tauri::command(async)]
pub fn opened_track_metadata(
    app: tauri::AppHandle,
    state: tauri::State<OpenFiles>,
    file_path: String,
    request_id: u64,
) -> Result<Track, String> {
    {
        let requests = state.requests.lock().unwrap_or_else(|e| e.into_inner());
        if requests.id != request_id || !requests.authorized.contains(&file_path) {
            return Err("Superseded file request".into());
        }
    }
    let data_dir = app.state::<crate::AppState>().data_dir.clone();
    let track = crate::scan::read_opened_track(&PathBuf::from(file_path), &data_dir);
    if !track.artwork_path.is_empty() {
        app.asset_protocol_scope()
            .allow_file(&track.artwork_path)
            .map_err(|e| e.to_string())?;
    }
    Ok(track)
}

#[tauri::command]
pub fn show_library(app: tauri::AppHandle) -> Result<(), String> {
    show_main(&app)
}

/// Whether dismissing the mini player should take the whole app down: true only when it
/// was the sole thing on screen (a cold Explorer launch never shows the library) and the
/// user hasn't opted into living in the tray.
pub fn compact_close_exits(app: &tauri::AppHandle, close_to_tray: bool) -> bool {
    let library_visible = app
        .get_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    !close_to_tray && !library_visible
}

pub fn close_player(window: &tauri::Window, close_to_tray: bool) -> Result<(), String> {
    if window.label() == "compact" {
        // Destroy, don't hide: the mini player owns its <audio>, and a hidden webview
        // keeps playing. Tearing the window down is the only reliable "stop". The library
        // window is left exactly as it was (no show, no resume).
        if compact_close_exits(&window.app_handle(), close_to_tray) {
            window.app_handle().exit(0);
            return Ok(());
        }
        return window.close().map_err(|e| e.to_string());
    }
    // Library window. If the mini player is up, only hide: exiting would kill the song the
    // user is listening to there. Once the mini player closes, compact_close_exits sees
    // the hidden library and lets the app go.
    let mini_visible = window
        .app_handle()
        .get_window("compact")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if close_to_tray || mini_visible {
        window.hide().map_err(|e| e.to_string())
    } else {
        window.app_handle().exit(0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_relative_unicode_paths_and_rejects_non_audio() {
        let dir = std::env::temp_dir().join(format!("lyra-open-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("şarkı space.MP3"), b"audio").unwrap();
        std::fs::write(dir.join("notes.txt"), b"text").unwrap();
        let (tracks, errors) = validate_paths(
            &[
                "şarkı space.MP3".into(),
                "şarkı space.MP3".into(),
                "notes.txt".into(),
                "missing.mp3".into(),
                ".".into(),
            ],
            &dir,
        );
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "şarkı space");
        assert_eq!(errors.len(), 3);
        std::fs::remove_file(dir.join("şarkı space.MP3")).unwrap();
        std::fs::remove_file(dir.join("notes.txt")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
