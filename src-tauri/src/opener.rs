use std::path::Path;
use std::process::Command;

/// Shows a file selected in the OS file manager. Implemented with the platform command
/// rather than `shell.open`, which would *launch* an audio file in the default player
/// instead of revealing it.
pub fn reveal(target: &Path) -> bool {
    if !target.exists() {
        return false;
    }

    // `explorer /select,<path>` returns a non-zero exit code even on success, so across
    // every platform the spawn itself is the only meaningful signal.
    #[cfg(target_os = "windows")]
    let spawned = {
        use std::os::windows::process::CommandExt;
        let canonical = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
        let clean_path = canonical
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\");
        Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", clean_path))
            .spawn()
            .is_ok()
    };

    #[cfg(target_os = "macos")]
    let spawned = Command::new("open").arg("-R").arg(target).spawn().is_ok();

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let spawned = {
        // No portable "reveal" on Linux desktops; opening the containing folder is the
        // closest equivalent every file manager supports.
        let directory = if target.is_dir() {
            target.to_path_buf()
        } else {
            target
                .parent()
                .map(|value| value.to_path_buf())
                .unwrap_or_else(|| target.to_path_buf())
        };
        Command::new("xdg-open").arg(directory).spawn().is_ok()
    };

    spawned
}

pub fn open_directory(target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|error| format!("The folder could not be created: {error}"))?;

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("The folder could not be opened: {error}"))
}
