use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;

use crate::util::{file_name, is_audio, is_image, PLAYLIST_METADATA_FILE};

const QUIET_PERIOD: Duration = Duration::from_millis(220);

static LOCAL_WRITES: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();

pub fn mark_local_write(path: &Path) {
    let mut writes = LOCAL_WRITES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    writes.retain(|_, expires| *expires > Instant::now());
    writes.insert(path.to_path_buf(), Instant::now() + Duration::from_secs(1));
}

fn is_local_write(path: &Path) -> bool {
    LOCAL_WRITES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
        .is_some_and(|expires| *expires > Instant::now())
}

enum WatchMessage {
    Changes(Vec<PathBuf>),
    Failure(String),
}

struct WatchSession {
    root: String,
    stop: Arc<AtomicBool>,
    healthy: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct WatcherHandle {
    session: Mutex<Option<WatchSession>>,
}

fn subscribe(
    root: &Path,
    sender: std::sync::mpsc::Sender<WatchMessage>,
    healthy: Arc<AtomicBool>,
) -> Result<RecommendedWatcher, String> {
    let root_key = crate::util::cache_key(root);
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                healthy.store(false, Ordering::SeqCst);
                let _ = sender.send(WatchMessage::Failure(error.to_string()));
                return;
            }
        };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        if matches!(event.kind, notify::EventKind::Remove(_))
            && event
                .paths
                .iter()
                .any(|path| crate::util::cache_key(path) == root_key)
        {
            healthy.store(false, Ordering::SeqCst);
            let _ = sender.send(WatchMessage::Failure(
                "The music folder was disconnected or removed.".into(),
            ));
            return;
        }
        let structural = matches!(
            event.kind,
            notify::EventKind::Create(notify::event::CreateKind::Folder)
                | notify::EventKind::Remove(notify::event::RemoveKind::Folder)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
        );
        let paths: Vec<_> = event
            .paths
            .into_iter()
            .filter(|path| {
                let name = file_name(path);
                if crate::util::is_managed_temporary(&name)
                    || name.starts_with(".lyra-tag-staging-")
                    || name.starts_with(".lyra-artwork-rollback-")
                    || name.starts_with(".lyra-cover-rollback-")
                {
                    return false;
                }
                !is_local_write(path)
                    && (structural
                        || is_relevant(path)
                        || path.is_dir()
                        || path.extension().is_none())
            })
            .collect();
        if !paths.is_empty() {
            let _ = sender.send(WatchMessage::Changes(paths));
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    Ok(watcher)
}

/// A busy import must still produce updates; silence is bounded by one second.
fn collect_batch(
    receiver: &std::sync::mpsc::Receiver<WatchMessage>,
    first: Vec<PathBuf>,
    stop: &AtomicBool,
) -> (HashSet<PathBuf>, Option<String>) {
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut changes: HashSet<_> = first.into_iter().collect();
    while !stop.load(Ordering::SeqCst) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(QUIET_PERIOD.min(remaining)) {
            Ok(WatchMessage::Changes(paths)) => changes.extend(paths),
            Ok(WatchMessage::Failure(error)) => return (changes, Some(error)),
            Err(_) => break,
        }
    }
    (changes, None)
}

impl WatcherHandle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn watch(&self, window: tauri::Window, root_path: &str) -> Result<(), String> {
        let root = root_path.trim().to_string();
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "The library watcher is unavailable.".to_string())?;
        if guard.as_ref().is_some_and(|existing| {
            existing.root.eq_ignore_ascii_case(&root) && existing.healthy.load(Ordering::SeqCst)
        }) {
            return Ok(());
        }
        if let Some(previous) = guard.take() {
            previous.stop.store(true, Ordering::SeqCst);
        }
        if root.is_empty() {
            return Ok(());
        }
        let (sender, receiver) = channel();
        let healthy = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let watch_root = PathBuf::from(&root);
        let initial = subscribe(&watch_root, sender.clone(), healthy.clone());
        let initial_error = initial.as_ref().err().cloned();
        healthy.store(initial.is_ok(), Ordering::SeqCst);
        let thread_stop = stop.clone();
        let thread_healthy = healthy.clone();
        std::thread::spawn(move || {
            let mut watcher = initial.ok();
            while !thread_stop.load(Ordering::SeqCst) {
                if !thread_healthy.load(Ordering::SeqCst) {
                    drop(watcher.take());
                    match subscribe(&watch_root, sender.clone(), thread_healthy.clone()) {
                        Ok(replacement) => {
                            watcher = Some(replacement);
                            thread_healthy.store(true, Ordering::SeqCst);
                            if !thread_stop.load(Ordering::SeqCst) {
                                let _ = window.emit("library:changed", json!({ "full": true, "changes": [], "watcherRecovered": true }));
                            }
                        }
                        Err(_) => {
                            // Poll without a long uninterruptible sleep so switching roots remains prompt.
                            let _ = receiver.recv_timeout(Duration::from_millis(500));
                            continue;
                        }
                    }
                }
                let (changes, error) = match receiver.recv_timeout(Duration::from_millis(500)) {
                    Ok(WatchMessage::Changes(paths)) => {
                        collect_batch(&receiver, paths, &thread_stop)
                    }
                    Ok(WatchMessage::Failure(error)) => (HashSet::new(), Some(error)),
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => break,
                };
                if thread_stop.load(Ordering::SeqCst) {
                    break;
                }
                let full = error.is_some();
                if full {
                    thread_healthy.store(false, Ordering::SeqCst);
                }
                let _ = window.emit(
                    "library:changed",
                    json!({ "changes": changes, "full": full, "watcherError": error }),
                );
            }
        });
        *guard = Some(WatchSession {
            root,
            stop,
            healthy,
        });
        initial_error.map_or(Ok(()), |error| {
            Err(format!(
                "The library could not be watched; retrying: {error}"
            ))
        })
    }
}

/// Only files that can change what the library looks like are worth a rescan. Without this
/// filter, editor swap files and thumbnail caches keep the library in permanent churn.
fn is_relevant(path: &Path) -> bool {
    if file_name(path) == PLAYLIST_METADATA_FILE {
        return true;
    }
    is_audio(path) || is_image(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_errors_preserve_pending_changes_and_request_recovery() {
        let (sender, receiver) = channel();
        sender
            .send(WatchMessage::Failure("subscription lost".into()))
            .unwrap();
        let (changes, error) = collect_batch(
            &receiver,
            vec![PathBuf::from("song.mp3")],
            &AtomicBool::new(false),
        );
        assert!(changes.contains(Path::new("song.mp3")));
        assert_eq!(error.as_deref(), Some("subscription lost"));
    }

    #[test]
    fn continuous_changes_do_not_starve_updates() {
        let (sender, receiver) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let producer_stop = stop.clone();
        let producer = std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(3);
            while !producer_stop.load(Ordering::SeqCst) && Instant::now() < until {
                if sender
                    .send(WatchMessage::Changes(vec![PathBuf::from("song.mp3")]))
                    .is_err()
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let started = Instant::now();
        let (changes, error) = collect_batch(&receiver, vec![], &stop);
        stop.store(true, Ordering::SeqCst);
        producer.join().unwrap();
        assert!(started.elapsed() < Duration::from_millis(2500));
        assert!(error.is_none());
        assert!(!changes.is_empty());
    }
}
