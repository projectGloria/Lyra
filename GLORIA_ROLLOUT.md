# GloriaSetup rollout notes

Please review these choices, made without being able to ask:

- **Build:** Tauri v1 app. CI runs `cargo build --release --features custom-protocol` (what `tauri build` does, minus the NSIS bundle) and ships only `lyra.exe`. The app has no resources or sidecars, and the frontend is embedded.
- **main_exe:** `lyra.exe` (Cargo package name; `build-release.bat` calls it `Lyra.exe`, the same file on Windows).
- **Version:** `1.0.0` matches `tauri.conf.json` and `Cargo.toml`. The tag overrides it when packing. The launcher catalog says 0.4.0; I left both alone.
- **Icon:** `Lyra.ico` in the repo root.
- **Data folder:** `%APPDATA%\com.lyra.sona` (the Tauri identifier, where `app_data_dir()` points).
- **legacy_names:** `["Lyra"]`. The old Tauri NSIS installer registered DisplayName `Lyra`, the same as `name`. I kept the entry in case the matcher needs it explicitly.
- **Workflow:** rewrote the existing `build-installers.yml` (name is now "Release"; file name kept). The old installer step and the softprops release job are gone, so the release gets only the GloriaSetup setup. The old `Lyra_<version>_x64-portable.exe` is no longer published; restore it if you want it.
- **Secrets:** `WINDOWS_PFX_BASE64` and `WINDOWS_PFX_PASSWORD` must exist, otherwise the setup is unsigned.
- **Not built locally,** so nothing here has been run yet.
- `ci.yml` is unchanged.
