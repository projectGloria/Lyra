//! Isolated audit tests against the actual repository modules. Production files are unchanged.
#![allow(dead_code)]
#[path = "../../src-tauri/src/artwork.rs"] mod artwork;
#[path = "../../src-tauri/src/cache.rs"] mod cache;
#[path = "../../src-tauri/src/model.rs"] mod model;
#[path = "../../src-tauri/src/library_delta.rs"] mod library_delta;
#[path = "../../src-tauri/src/playlist.rs"] mod playlist;
#[path = "../../src-tauri/src/scan.rs"] mod scan;
#[path = "../../src-tauri/src/util.rs"] mod util;
#[path = "../../src-tauri/src/watcher.rs"] mod watcher;

#[cfg(test)]
mod audit {
    use super::*;
    use std::fs;
    use std::path::Path;
    use util::{path_string, tests::TestDirectory};

    fn mp3(path: &Path) {
        let mut data = vec![b'I', b'D', b'3', 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00];
        data.extend_from_slice(&[0; 256]);
        fs::write(path, data).unwrap();
    }

    fn update(cover: &str) -> scan::TrackMetadataUpdate<'_> {
        scan::TrackMetadataUpdate {
            title: "New title", artist: "Artist", album: "Album", album_artist: "Artist",
            year: 2026, track_no: 1, genre: "", comment: "", artwork_path: cover, artwork_changed: true,
        }
    }

    #[test]
    fn cleanup_must_preserve_user_files_containing_tmp() {
        let fixture = TestDirectory::new();
        let unrelated = fixture.0.join("mix.tmp-final.mp3");
        fs::write(&unrelated, b"user-owned audio").unwrap();
        fs::File::options().write(true).open(&unrelated).unwrap().set_times(
            fs::FileTimes::new().set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(600))
        ).unwrap();
        util::sweep_stale_temp_files(&fixture.0);
        assert!(unrelated.exists(), "startup cleanup permanently deleted unrelated audio");
    }

    #[test]
    #[cfg(windows)]
    fn failed_tag_save_must_preserve_existing_sidecar() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("Music");
        fs::create_dir(&root).unwrap();
        let song = root.join("Song.mp3");
        let cover = root.join("Song.jpg");
        mp3(&song);
        fs::write(&cover, b"original artwork").unwrap();
        // Allow readers, deny writers, reproducing a track held by another application.
        use std::os::windows::fs::OpenOptionsExt;
        let handle = fs::OpenOptions::new().read(true).share_mode(1).open(&song).unwrap();
        let result = scan::edit_track_metadata(&fixture.0.join("data"), &path_string(&root), &path_string(&song), update(""));
        drop(handle);
        assert!(result.is_err(), "the audio write must actually have failed");
        assert!(cover.exists(), "the sidecar was deleted before the failed audio write");
    }

    #[test]
    fn replacement_cover_must_override_recognized_suffix_sidecar() {
        let fixture = TestDirectory::new();
        let root = fixture.0.join("Music");
        fs::create_dir(&root).unwrap();
        let song = root.join("Song.mp3");
        let old = root.join("Song-cover.jpg");
        let new = fixture.0.join("new.png");
        mp3(&song);
        fs::write(&old, b"old sidecar").unwrap();
        fs::write(&new, b"\x89PNG\r\n\x1a\npngdata").unwrap();
        let result = scan::edit_track_metadata(&fixture.0.join("data"), &path_string(&root), &path_string(&song), update(&path_string(&new))).unwrap();
        assert_ne!(result.track.artwork_path, path_string(&old), "successful cover replacement still displays the old sidecar");
    }

    fn wav() -> Vec<u8> {
        let mut data = Vec::new();
        data.extend(b"RIFF"); data.extend(236u32.to_le_bytes()); data.extend(b"WAVEfmt ");
        data.extend(16u32.to_le_bytes()); data.extend(1u16.to_le_bytes()); data.extend(1u16.to_le_bytes());
        data.extend(8000u32.to_le_bytes()); data.extend(16000u32.to_le_bytes());
        data.extend(2u16.to_le_bytes()); data.extend(16u16.to_le_bytes());
        data.extend(b"data"); data.extend(200u32.to_le_bytes()); data.extend([0; 200]);
        data
    }

    #[test]
    #[ignore = "synthetic debug-build benchmark; run explicitly with --ignored --nocapture"]
    fn benchmark_sidecar_lookup() {
        for count in [1000, 3000] {
            let fixture = TestDirectory::new();
            for i in 0..count { fs::write(fixture.0.join(format!("Song {i}.jpg")), b"image").unwrap(); }
            let index = artwork::ArtworkIndex::new();
            index.find_track_artwork(&fixture.0.join("Song 0.mp3"));
            let start = std::time::Instant::now();
            for i in 0..count {
                assert!(!index.find_track_artwork(&fixture.0.join(format!("Song {i}.mp3"))).is_empty());
            }
            println!("images_and_tracks={count} warm_sidecar_lookup_ms={}", start.elapsed().as_millis());
        }
    }

    #[test]
    #[ignore = "synthetic debug-build benchmark; run explicitly with --ignored --nocapture"]
    fn benchmark_one_file_refresh() {
        use std::sync::{Arc, atomic::AtomicU64};
        use std::time::Instant;
        for (count, folder_count) in [(1000, 0), (5000, 0), (5000, 100)] {
            let fixture = TestDirectory::new();
            let root = fixture.0.join("Music");
            fs::create_dir(&root).unwrap();
            let bytes = wav();
            for i in 0..folder_count { fs::create_dir(root.join(format!("Album {i}"))).unwrap(); }
            let folder_for = |i: usize| if folder_count == 0 { root.clone() } else { root.join(format!("Album {}", i % folder_count)) };
            for i in 0..count { fs::write(folder_for(i).join(format!("Song {i}.wav")), &bytes).unwrap(); }
            let context = scan::ScanContext { window: None, data_dir: fixture.0.join("data"), scan_id: 1,
                generation: 1, current_generation: Arc::new(AtomicU64::new(1)) };
            let initial = scan::scan_library(&context, &path_string(&root));
            assert_eq!(initial.track_count, count);
            let first = folder_for(0).join("Song 0.wav");
            assert!(cache::TrackCache::load(&context.data_dir).unchanged_track(&first).unwrap().1,
                "fixture must produce a valid warm cache");
            let start = Instant::now();
            scan::scan_library(&context, &path_string(&root));
            let full_ms = start.elapsed().as_millis();
            let changed = folder_for(0).join("Added.wav");
            fs::write(&changed, &bytes).unwrap();
            let start = Instant::now();
            let updated = scan::scan_library_changes(&context, &path_string(&root), &[path_string(&changed)]);
            let incremental_ms = start.elapsed().as_millis();
            assert_eq!(updated.track_count, count + 1);
            let cache_bytes = fs::metadata(cache::track_cache_file(&context.data_dir)).unwrap().len();
            let snapshot_bytes = fs::metadata(cache::library_snapshot_file(&context.data_dir)).unwrap().len();
            println!("tracks={count} folders={folder_count} warm_full_ms={full_ms} one_file_refresh_ms={incremental_ms} cache_bytes={cache_bytes} snapshot_bytes={snapshot_bytes}");
        }
    }
}
