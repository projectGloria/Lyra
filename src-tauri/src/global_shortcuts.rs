//! System-wide hotkeys (Win32 `RegisterHotKey` under the hood), so playback can be driven
//! while Lyra is in the background or hidden in the tray. Rust only owns registration; the
//! renderer owns the action table and receives `shortcut:global` with the action id.

use std::collections::HashSet;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, GlobalShortcutManager, Manager};

pub const EVENT: &str = "shortcut:global";

/// Mirrors the `playback: true` entries of `SHORTCUT_ACTIONS` in `src/renderer.js`. Ids
/// outside this list are skipped, so a hand-edited settings file cannot make Lyra grab
/// keys system-wide for an action that does nothing.
const ACTIONS: &[&str] = &[
    "togglePlay",
    "nextTrack",
    "previousTrack",
    "seekForward",
    "seekBackward",
    "volumeUp",
    "volumeDown",
    "toggleMute",
    "toggleLike",
];

/// Translates a renderer binding (`Ctrl+Alt+KeyM`, DOM `event.code` names) into a tao
/// accelerator (`Ctrl+Alt+M`). tao's parser silently ignores names it does not know, so
/// anything not translatable is rejected here instead of registering a key-less hotkey.
pub fn to_accelerator(binding: &str) -> Option<String> {
    let mut parts: Vec<&str> = binding.split('+').collect();
    let base = parts.pop().filter(|base| !base.is_empty())?;
    let mut tokens = parts
        .into_iter()
        .map(|modifier| match modifier {
            "Ctrl" | "Alt" | "Shift" => Some(modifier),
            "Meta" => Some("Super"),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let key = translate_key(base)?;
    // A bare letter or arrow would be stolen from every other app on the system.
    let standalone = is_function_key(&key) || key.starts_with("Media") || key.starts_with("Volume");
    if tokens.is_empty() && !standalone {
        return None;
    }
    tokens.push(&key);
    Some(tokens.join("+"))
}

fn is_function_key(key: &str) -> bool {
    key.strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .map_or(false, |n| (1..=12).contains(&n))
}

fn translate_key(code: &str) -> Option<String> {
    if let Some(letter) = code.strip_prefix("Key").filter(|l| l.len() == 1) {
        return Some(letter.to_string());
    }
    if let Some(digit) = code.strip_prefix("Digit").filter(|d| d.len() == 1) {
        return Some(digit.to_string());
    }
    let key = match code {
        // DOM and tao disagree on the media/volume key names.
        "MediaTrackNext" => "MediaNextTrack",
        "MediaTrackPrevious" => "MediaPreviousTrack",
        "AudioVolumeUp" => "VolumeUp",
        "AudioVolumeDown" => "VolumeDown",
        "AudioVolumeMute" => "VolumeMute",
        // Mouse buttons cannot be hotkeys; Minus/Equal/MediaStop have no tao KeyCode.
        _ if code.starts_with("Mouse") => return None,
        "Minus" | "Equal" | "MediaStop" => return None,
        // Space, Arrow*, F1–F12, Numpad*, Home, Comma, MediaPlayPause… match tao's names.
        other => other,
    };
    Some(key.to_string())
}

/// Replaces every Lyra hotkey with `bindings` (`{ actionId: binding }`). Returns
/// `{ actionId: reason }` for each binding that could not be registered — most often
/// because another app already owns that chord.
pub fn apply(app: &AppHandle, bindings: &Value) -> Map<String, Value> {
    // Unregister + register must be one step, or two overlapping saves interleave and leave
    // a stale hotkey behind.
    static APPLY_LOCK: Mutex<()> = Mutex::new(());
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut manager = app.global_shortcut_manager();
    let _ = manager.unregister_all();
    let mut failures = Map::new();
    let Some(bindings) = bindings.as_object() else {
        return failures;
    };
    let mut taken = HashSet::new();
    for (id, binding) in bindings {
        let Some(binding) = binding.as_str().filter(|b| !b.is_empty()) else {
            continue;
        };
        if !ACTIONS.contains(&id.as_str()) {
            continue;
        }
        let error = match to_accelerator(binding) {
            None => Some("This key cannot be used as a global shortcut.".to_string()),
            Some(accelerator) if !taken.insert(accelerator.clone()) => {
                Some("Already used by another Lyra global shortcut.".to_string())
            }
            Some(accelerator) => {
                let handle = app.clone();
                let action = id.clone();
                manager
                    .register(&accelerator, move || {
                        let _ = handle.emit_to("main", EVENT, &action);
                    })
                    .err()
                    // RegisterHotKey's only failure mode in practice is "someone else has it".
                    .map(|_| "Already in use by another app.".to_string())
            }
        };
        if let Some(error) = error {
            failures.insert(id.clone(), Value::String(error));
        }
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::to_accelerator;

    #[test]
    fn translates_dom_codes_to_tao_names() {
        assert_eq!(to_accelerator("Ctrl+Alt+KeyM").as_deref(), Some("Ctrl+Alt+M"));
        assert_eq!(to_accelerator("Meta+Shift+Digit5").as_deref(), Some("Super+Shift+5"));
        assert_eq!(to_accelerator("Ctrl+ArrowRight").as_deref(), Some("Ctrl+ArrowRight"));
        assert_eq!(to_accelerator("MediaTrackNext").as_deref(), Some("MediaNextTrack"));
        assert_eq!(to_accelerator("F9").as_deref(), Some("F9"));
    }

    #[test]
    fn rejects_bindings_that_would_hijack_typing_or_cannot_register() {
        assert_eq!(to_accelerator("KeyM"), None);
        assert_eq!(to_accelerator("Space"), None);
        assert_eq!(to_accelerator("F13"), None);
        assert_eq!(to_accelerator("Ctrl+Mouse4"), None);
        assert_eq!(to_accelerator("Ctrl+Minus"), None);
        assert_eq!(to_accelerator("Hyper+KeyM"), None);
        assert_eq!(to_accelerator(""), None);
    }
}
