use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::util::write_json_atomic;

pub fn settings_file(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

/// Defaults are kept in sync with `state.settings` at the top of `src/renderer.js`. The
/// renderer merges whatever comes back over its own defaults, so a missing key is safe —
/// but `paletteVersion` / `layoutVersion` must be present or the renderer re-runs its
/// one-time migrations on every launch.
pub fn defaults() -> Value {
    json!({
        "libraryPath": "",
        "backgroundPath": "",
        "profilePath": "",
        "showInk": false,
        "surfaceOpacity": 70,
        "surfaceBlur": 16,
        "backgroundBlur": 0,
        "linkBlur": false,
        "closeToTray": false,
        "accentColor": "#c9a94a",
        "theme": "lyra",
        "paletteVersion": 1,
        "layoutVersion": 1,
        "libraryView": "list",
        "leftSidebarWidth": 280,
        "rightSidebarWidth": 286,
        "shortcuts": {},
        "globalShortcuts": {}
    })
}

pub fn read(data_dir: &Path) -> Value {
    let mut settings = defaults();
    let raw = match std::fs::read_to_string(settings_file(data_dir)) {
        Ok(contents) => contents,
        Err(_) => return settings,
    };
    let stored: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return settings,
    };
    // Merge rather than replace: a settings file written by an older build is missing
    // keys the current renderer expects, and a truncated file should not blank the theme.
    if let (Some(target), Some(source)) = (settings.as_object_mut(), stored.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    settings
}

pub fn write(data_dir: &Path, settings: &Value) -> Result<Value, String> {
    static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITE_LOCK.lock().map_err(|_| "Settings are unavailable.")?;
    let merged = if settings.is_object() {
        let mut base = read(data_dir);
        if let (Some(target), Some(source)) = (base.as_object_mut(), settings.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        base
    } else {
        defaults()
    };
    write_json_atomic(&settings_file(data_dir), &merged)
        .map_err(|error| format!("Settings could not be saved: {error}"))?;
    Ok(merged)
}

pub fn library_path(data_dir: &Path) -> String {
    read(data_dir)
        .get("libraryPath")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}
