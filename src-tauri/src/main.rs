#![windows_subsystem = "windows"]

mod artwork;
mod cache;
mod diagnostics;
mod global_shortcuts;
mod library_delta;
mod liked;
mod model;
mod opener;
mod playlist;
mod scan;
mod settings;
mod util;
mod watcher;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::Manager;

use crate::model::{DeleteResult, Library, PlaylistResult, QueueTrack};
use crate::util::{is_path_inside, path_string, resolve};

pub struct AppState {
    data_dir: PathBuf,
    /// Bumped by every new scan request. An in-flight scan compares the generation it
    /// started with against this to learn it has been superseded.
    scan_generation: Arc<AtomicU64>,
    watcher: watcher::WatcherHandle,
    scan_lock: std::sync::Mutex<()>,
    playlist_lock: std::sync::Mutex<()>,
    close_to_tray: AtomicBool,
}

impl AppState {
    fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

// --- settings ------------------------------------------------------------------------

#[tauri::command(async)]
fn read_settings(state: tauri::State<AppState>) -> Value {
    settings::read(state.data_dir())
}

#[tauri::command(async)]
fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    settings: Value,
) -> Result<Value, String> {
    let mut candidate = settings::read(state.data_dir());
    if let (Some(target), Some(source)) = (candidate.as_object_mut(), settings.as_object()) {
        target.extend(
            source
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
    }
    // Reject unusable asset paths before committing a new library root to disk.
    allow_media_paths(&app, &candidate)?;
    let saved = settings::write(state.data_dir(), &settings)?;
    diagnostics::set_library_root(saved["libraryPath"].as_str().unwrap_or(""));
    state.close_to_tray.store(
        saved["closeToTray"].as_bool().unwrap_or(false),
        Ordering::Relaxed,
    );
    Ok(saved)
}

fn allow_media_paths(app: &tauri::AppHandle, settings: &Value) -> Result<(), String> {
    let scope = app.asset_protocol_scope();
    if let Some(root) = settings["libraryPath"].as_str().filter(|p| !p.is_empty()) {
        let root_path = resolve(root);
        if root_path.is_dir() {
            scope
                .allow_directory(&root_path, true)
                .map_err(|e| e.to_string())?;
        }
    }
    for key in ["backgroundPath", "profilePath"] {
        if let Some(path) = settings[key].as_str().filter(|p| !p.is_empty()) {
            let file_path = resolve(path);
            if file_path.is_file() {
                scope.allow_file(&file_path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command(async)]
fn allow_asset_file(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    let target = resolve(&file_path);
    if target.is_file() {
        app.asset_protocol_scope()
            .allow_file(&target)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn configured_root(state: &AppState) -> Result<String, String> {
    let root = settings::library_path(state.data_dir());
    if root.is_empty() {
        return Err("Choose a music folder first.".into());
    }
    Ok(root)
}

// --- library -------------------------------------------------------------------------

#[tauri::command(async)]
fn scan_library(
    window: tauri::Window,
    state: tauri::State<AppState>,
    root_path: String,
    request_id: Option<u64>,
) -> Library {
    let generation = state.scan_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let context = scan::ScanContext {
        window: Some(window),
        data_dir: state.data_dir().to_path_buf(),
        // The renderer stamps every scan with its own id and drops progress events that do
        // not match, so echo it back rather than inventing one.
        scan_id: request_id.unwrap_or(generation),
        generation,
        current_generation: state.scan_generation.clone(),
    };
    diagnostics::log(
        state.data_dir(),
        "library.scan-started",
        &json!({ "requestId": request_id, "rootPath": root_path }),
        "info",
        "main",
    );
    let _scan_guard = state.scan_lock.lock().unwrap_or_else(|e| e.into_inner());
    if context.is_cancelled() {
        return Library::cancelled(&root_path);
    }
    let library = scan::scan_library(&context, &root_path);
    diagnostics::log(
        state.data_dir(),
        "library.scan-finished",
        &json!({
            "ok": library.ok,
            "error": library.error,
            "folders": library.folder_count,
            "tracks": library.track_count,
            "cancelled": library.cancelled,
        }),
        if library.ok { "info" } else { "warn" },
        "main",
    );
    library
}

#[tauri::command(async)]
fn refresh_library_changes(
    window: tauri::Window,
    state: tauri::State<AppState>,
    changes: Vec<String>,
    request_id: Option<u64>,
) -> Result<Value, String> {
    let root = configured_root(&state)?;
    let generation = state.scan_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let context = scan::ScanContext {
        window: Some(window),
        data_dir: state.data_dir.clone(),
        scan_id: request_id.unwrap_or(generation),
        generation,
        current_generation: state.scan_generation.clone(),
    };
    let _guard = state.scan_lock.lock().unwrap_or_else(|e| e.into_inner());
    if context.is_cancelled() {
        return serde_json::to_value(Library::cancelled(&root)).map_err(|e| e.to_string());
    }
    let previous = cache::read_snapshot(state.data_dir(), &root);
    let current = scan::scan_library_changes(&context, &root, &changes);
    if current.ok {
        if let Some(previous) = previous {
            return serde_json::to_value(library_delta::LibraryDelta::between(&previous, &current))
                .map_err(|e| e.to_string());
        }
    }
    serde_json::to_value(current).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn read_library_cache(state: tauri::State<AppState>, root_path: String) -> Result<Library, String> {
    cache::read_snapshot(state.data_dir(), &root_path).ok_or_else(|| "no-cache".to_string())
}

#[tauri::command(async)]
fn watch_library(
    window: tauri::Window,
    state: tauri::State<AppState>,
    root_path: String,
) -> Result<(), String> {
    state.watcher.watch(window, &root_path)
}

// --- playlists -----------------------------------------------------------------------

#[tauri::command(async)]
fn create_playlist(
    state: tauri::State<AppState>,
    name: Option<String>,
) -> Result<PlaylistResult, String> {
    let _guard = state
        .playlist_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let root_path = configured_root(&state)?;
    playlist::create_playlist(&root_path, name.as_deref().unwrap_or("New Playlist"))
}

#[tauri::command(async)]
fn delete_playlist(
    window: tauri::Window,
    state: tauri::State<AppState>,
    folder_path: String,
) -> Result<DeleteResult, String> {
    let root_path = configured_root(&state)?;
    playlist::delete_playlist(&window, &state.playlist_lock, &root_path, &folder_path)
}

#[tauri::command(async)]
fn edit_playlist(
    state: tauri::State<AppState>,
    folder_path: String,
    name: Option<String>,
    description: Option<String>,
    artwork_path: Option<String>,
    artwork_changed: Option<bool>,
) -> Result<PlaylistResult, String> {
    let _guard = state
        .playlist_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let root_path = configured_root(&state)?;
    playlist::edit_playlist(
        &root_path,
        &folder_path,
        name.as_deref().unwrap_or(""),
        description.as_deref().unwrap_or(""),
        artwork_path.as_deref().unwrap_or(""),
        artwork_changed.unwrap_or(false),
    )
}

#[tauri::command(async)]
fn reorder_playlist(
    state: tauri::State<AppState>,
    folder_path: String,
    paths: Option<Vec<String>>,
) -> Result<Value, String> {
    let _guard = state
        .playlist_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let root_path = configured_root(&state)?;
    playlist::reorder_playlist(&root_path, &folder_path, &paths.unwrap_or_default())
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn edit_track_metadata(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    track_path: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    year: Option<u32>,
    track_no: Option<u32>,
    genre: Option<String>,
    comment: Option<String>,
    artwork_path: Option<String>,
    artwork_changed: Option<bool>,
) -> Result<crate::model::TrackEditResult, String> {
    let _guard = state
        .playlist_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let root_path = configured_root(&state)?;
    let result = scan::edit_track_metadata(
        state.data_dir(),
        &root_path,
        &track_path,
        scan::TrackMetadataUpdate {
            title: title.as_deref().unwrap_or(""),
            artist: artist.as_deref().unwrap_or(""),
            album: album.as_deref().unwrap_or(""),
            album_artist: album_artist.as_deref().unwrap_or(""),
            year: year.unwrap_or(0),
            track_no: track_no.unwrap_or(0),
            genre: genre.as_deref().unwrap_or(""),
            comment: comment.as_deref().unwrap_or(""),
            artwork_path: artwork_path.as_deref().unwrap_or(""),
            artwork_changed: artwork_changed.unwrap_or(false),
        },
    )?;
    if !result.track.artwork_path.is_empty() {
        let _ = app
            .asset_protocol_scope()
            .allow_file(&result.track.artwork_path);
    }
    Ok(result)
}

// --- liked songs ---------------------------------------------------------------------

#[tauri::command(async)]
fn read_liked(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    liked::read_liked(&configured_root(&state)?)
}

#[tauri::command(async)]
fn set_track_liked(
    state: tauri::State<AppState>,
    track_path: String,
    liked: bool,
) -> Result<Vec<String>, String> {
    // Shares the playlist lock: a folder rename remaps this file under the same lock.
    let _guard = state
        .playlist_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    liked::set_track_liked(&configured_root(&state)?, &track_path, liked)
}

#[tauri::command(async)]
fn reorder_liked(
    state: tauri::State<AppState>,
    paths: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let _guard = state
        .playlist_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    liked::reorder_liked(&configured_root(&state)?, &paths.unwrap_or_default())
}

// --- queue ---------------------------------------------------------------------------

/// The native dialog owns authorization for the export destination.
#[tauri::command(async)]
fn export_queue(window: tauri::Window, tracks: Vec<QueueTrack>) -> Result<Value, String> {
    let valid: Vec<&QueueTrack> = tracks
        .iter()
        .filter(|track| !track.path.is_empty() && Path::new(&track.path).is_file())
        .collect();
    if valid.is_empty() {
        return Ok(json!({ "ok": false, "cancelled": false, "error": "Queue is empty" }));
    }
    let Some(target) = tauri::api::dialog::blocking::FileDialogBuilder::new()
        .set_parent(&window)
        .set_title("Export queue")
        .set_file_name("Lyra Queue.m3u8")
        .add_filter("M3U playlist", &["m3u8", "m3u"])
        .save_file()
    else {
        return Ok(json!({ "ok": false, "cancelled": true }));
    };
    if !matches!(util::extension_lower(&target).as_str(), "m3u" | "m3u8") {
        return Err("Choose an .m3u or .m3u8 file.".into());
    }
    let mut lines = vec!["#EXTM3U".to_string()];
    for track in valid {
        let title = if track.title.is_empty() {
            util::file_name(Path::new(&track.path))
        } else {
            track.title.clone()
        };
        let artist = if track.artist.is_empty() {
            "Unknown artist".to_string()
        } else {
            track.artist.clone()
        };
        lines.push(format!(
            "#EXTINF:{},{} - {}",
            track.duration.round() as i64,
            artist.replace(['\r', '\n'], " "),
            title.replace(['\r', '\n'], " ")
        ));
        lines.push(path_string(&resolve(&track.path)));
    }
    std::fs::write(&target, format!("{}\n", lines.join("\n")))
        .map_err(|error| format!("The queue could not be exported: {error}"))?;
    Ok(json!({ "ok": true, "filePath": path_string(&target) }))
}

/// Re-registers every system-wide hotkey from `{ actionId: binding }` and returns
/// `{ actionId: reason }` for the ones the OS refused, so the UI can flag them.
#[tauri::command(async)]
fn set_global_shortcuts(app: tauri::AppHandle, bindings: Value) -> Value {
    Value::Object(global_shortcuts::apply(&app, &bindings))
}

// --- shell / diagnostics --------------------------------------------------------------

// Programmatic window.close() bypasses CloseRequested in Tauri 1, so custom
// title-bar buttons must apply the tray preference before closing the window.
#[tauri::command(async)]
fn close_window(window: tauri::Window, state: tauri::State<AppState>) -> Result<(), String> {
    if state.close_to_tray.load(Ordering::Relaxed) {
        window.hide()
    } else {
        window.close()
    }
    .map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn minimize_window(window: tauri::Window, state: tauri::State<AppState>) -> Result<(), String> {
    if state.close_to_tray.load(Ordering::Relaxed) {
        window.hide()
    } else {
        window.minimize()
    }
    .map_err(|error| error.to_string())
}

/// The fullscreen player is a page overlay; this makes the window itself fullscreen so it
/// covers the taskbar. Rust-side, so the JS allowlist stays closed. Leaving fullscreen
/// restores the window's previous (maximized or normal) placement.
#[tauri::command(async)]
fn set_window_fullscreen(window: tauri::Window, fullscreen: bool) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

/// Reveals a path in the file manager, but only inside the configured music library.
/// The renderer hands this whatever path a track carries, so the library root is the
/// boundary that keeps a malformed or stale path from opening somewhere unrelated.
#[tauri::command(async)]
fn reveal_in_explorer(state: tauri::State<AppState>, target_path: String) -> bool {
    let requested = target_path.trim();
    if requested.is_empty() {
        return false;
    }
    let resolved = resolve(requested);
    if !resolved.exists() {
        return false;
    }
    let library_root = settings::library_path(state.data_dir());
    if library_root.is_empty() || !is_path_inside(&resolve(&library_root), &resolved, true) {
        diagnostics::log(
            state.data_dir(),
            "shell.reveal-rejected",
            &json!({ "reason": "outside-library" }),
            "warn",
            "main",
        );
        return false;
    }
    opener::reveal(&resolved)
}

#[tauri::command(async)]
fn report_info(state: tauri::State<AppState>) -> Value {
    json!({
        "directory": path_string(&diagnostics::report_directory(state.data_dir())),
        "file": path_string(&diagnostics::log_file(state.data_dir())),
    })
}

#[tauri::command(async)]
fn open_reports_folder(state: tauri::State<AppState>) -> Value {
    let directory = diagnostics::report_directory(state.data_dir());
    match opener::open_directory(&directory) {
        Ok(()) => json!({ "ok": true, "error": "", "directory": path_string(&directory) }),
        Err(error) => json!({ "ok": false, "error": error, "directory": path_string(&directory) }),
    }
}

#[tauri::command(async)]
fn log_event(
    state: tauri::State<AppState>,
    event: String,
    details: Option<Value>,
    level: Option<String>,
) {
    diagnostics::log(
        state.data_dir(),
        &event,
        &details.unwrap_or_else(|| json!({})),
        level.as_deref().unwrap_or("info"),
        "renderer",
    );
}

fn main() {
    tauri::Builder::default()
        .system_tray(
            tauri::SystemTray::new().with_menu(
                tauri::SystemTrayMenu::new()
                    .add_item(tauri::CustomMenuItem::new("show", "Show Lyra"))
                    .add_item(tauri::CustomMenuItem::new("quit", "Quit Lyra")),
            ),
        )
        .on_system_tray_event(|app, event| match event {
            tauri::SystemTrayEvent::MenuItemClick { id, .. } if id == "quit" => app.exit(0),
            tauri::SystemTrayEvent::LeftClick { .. }
            | tauri::SystemTrayEvent::DoubleClick { .. }
            | tauri::SystemTrayEvent::MenuItemClick { .. } => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                let state = event.window().state::<AppState>();
                if state.close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = event.window().hide();
                }
            }
        })
        .setup(|app| {
            let data_dir = app
                .path_resolver()
                .app_data_dir()
                .unwrap_or_else(|| PathBuf::from("."));
            std::fs::create_dir_all(&data_dir).ok();
            app.asset_protocol_scope()
                .allow_directory(cache::artwork_cache_directory(&data_dir), true)?;
            let saved = settings::read(&data_dir);
            if let Err(error) = allow_media_paths(&app.handle(), &saved) {
                eprintln!("Warning: Failed to allow media paths during startup: {error}");
            }
            diagnostics::set_library_root(saved["libraryPath"].as_str().unwrap_or(""));
            app.manage(AppState {
                data_dir,
                scan_generation: Arc::new(AtomicU64::new(0)),
                watcher: watcher::WatcherHandle::new(),
                scan_lock: std::sync::Mutex::new(()),
                playlist_lock: std::sync::Mutex::new(()),
                close_to_tray: AtomicBool::new(saved["closeToTray"].as_bool().unwrap_or(false)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_settings,
            save_settings,
            allow_asset_file,
            scan_library,
            read_library_cache,
            refresh_library_changes,
            watch_library,
            create_playlist,
            delete_playlist,
            edit_playlist,
            reorder_playlist,
            edit_track_metadata,
            read_liked,
            set_track_liked,
            reorder_liked,
            export_queue,
            reveal_in_explorer,
            report_info,
            open_reports_folder,
            log_event,
            close_window,
            minimize_window,
            set_window_fullscreen,
            set_global_shortcuts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lyra");
}
