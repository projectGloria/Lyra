use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_ARCHIVES: usize = 5;

pub fn report_directory(data_dir: &Path) -> PathBuf {
    data_dir.join("reports")
}

pub fn log_file(data_dir: &Path) -> PathBuf {
    report_directory(data_dir).join("lyra-diagnostics.jsonl")
}

/// Home-directory paths are masked before anything is written, so a report can be handed
/// over without leaking the user's account name. Keep new fields flowing through `log`
/// rather than writing to the file directly, or the masking is bypassed.
static LIBRARY_ROOT: Mutex<String> = Mutex::new(String::new());

pub fn set_library_root(root: &str) {
    *LIBRARY_ROOT.lock().unwrap_or_else(|e| e.into_inner()) = root.replace('\\', "/");
}

fn redact(value: &str) -> String {
    let mut out = value.replace('\\', "/");
    let root = LIBRARY_ROOT.lock().unwrap_or_else(|e| e.into_inner());
    if !root.is_empty() {
        out = replace_path_prefix(&out, &root, "<library>");
    }

    if let Some(home) = home_directory() {
        let home = home.to_string_lossy().to_string();
        if !home.is_empty() {
            out = replace_path_prefix(&out, &home.replace('\\', "/"), "~");
        }
    }
    out
}

fn replace_path_prefix(value: &str, prefix: &str, replacement: &str) -> String {
    let mut result = String::new();
    let mut remaining = value;
    while let Some((start, _)) = remaining.char_indices().find(|(i, _)| {
        remaining
            .get(*i..*i + prefix.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(prefix))
    }) {
        result.push_str(&remaining[..start]);
        result.push_str(replacement);
        remaining = &remaining[start + prefix.len()..];
    }
    result.push_str(remaining);
    result
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn sanitize(value: &Value, depth: usize) -> Value {
    if depth > 4 {
        return Value::String("[deep]".to_string());
    }
    match value {
        Value::String(text) => {
            let truncated: String = text.chars().take(2048).collect();
            Value::String(redact(&truncated))
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(50)
                .map(|item| sanitize(item, depth + 1))
                .collect(),
        ),
        Value::Object(entries) => Value::Object(
            entries
                .iter()
                .take(50)
                .map(|(key, item)| {
                    let clean_key: String = key.chars().take(256).collect();
                    (redact(&clean_key), sanitize(item, depth + 1))
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn rotate(path: &Path) {
    let oldest = path.with_extension(format!("jsonl.{MAX_LOG_ARCHIVES}"));
    let _ = std::fs::remove_file(oldest);
    for index in (1..MAX_LOG_ARCHIVES).rev() {
        let from = path.with_extension(format!("jsonl.{index}"));
        let to = path.with_extension(format!("jsonl.{}", index + 1));
        let _ = std::fs::rename(from, to);
    }
    let _ = std::fs::rename(path, path.with_extension("jsonl.1"));
}

struct LogEntry {
    path: PathBuf,
    line: String,
}
static LOGGER: OnceLock<mpsc::SyncSender<LogEntry>> = OnceLock::new();

pub fn log(data_dir: &Path, event: &str, details: &Value, level: &str, source: &str) {
    let entry = json!({
        "timestamp": crate::util::now_ms(), "level": level, "source": source,
        "event": redact(event), "details": sanitize(details, 0),
    });
    let sender = LOGGER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<LogEntry>(1024);
        std::thread::spawn(move || {
            let mut current: Option<(PathBuf, BufWriter<std::fs::File>, u64)> = None;
            loop {
                match receiver.recv_timeout(Duration::from_secs(1)) {
                    Ok(entry) => {
                        if current.as_ref().is_some_and(|(path, _, bytes)| {
                            path != &entry.path || *bytes >= MAX_LOG_BYTES
                        }) {
                            if let Some((path, mut writer, bytes)) = current.take() {
                                let _ = writer.flush();
                                drop(writer);
                                if bytes >= MAX_LOG_BYTES {
                                    rotate(&path);
                                }
                            }
                        }
                        if current.is_none() {
                            if let Some(parent) = entry.path.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            if let Ok(file) = OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(&entry.path)
                            {
                                let size = file.metadata().map(|m| m.len()).unwrap_or(0);
                                current = Some((entry.path, BufWriter::new(file), size));
                            }
                        }
                        if let Some((_, writer, bytes)) = current.as_mut() {
                            if writeln!(writer, "{}", entry.line).is_ok() {
                                *bytes += entry.line.len() as u64 + 1;
                            }
                            if level_requires_flush(&entry.line) {
                                let _ = writer.flush();
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if let Some((_, writer, _)) = current.as_mut() {
                            let _ = writer.flush();
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        sender
    });
    let _ = sender.try_send(LogEntry {
        path: log_file(data_dir),
        line: entry.to_string(),
    });
}

fn level_requires_flush(line: &str) -> bool {
    line.contains("\"level\":\"error\"")
}
