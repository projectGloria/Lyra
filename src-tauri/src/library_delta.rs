use crate::model::{Folder, Library, Track};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Track changes and collection order are separate: moving one row never resends tags.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDelta {
    pub delta: bool,
    pub root_path: String,
    pub base_scanned_at: i64,
    pub scanned_at: i64,
    pub liked_songs_artwork_path: String,
    pub folder_count: usize,
    pub track_count: usize,
    pub folders: Vec<Folder>,
    pub removed_folders: Vec<String>,
    pub tracks: Vec<Track>,
    pub removed_tracks: Vec<String>,
    pub orders: HashMap<String, Vec<String>>,
}

impl LibraryDelta {
    pub fn between(previous: &Library, current: &Library) -> Self {
        fn collections(library: &Library) -> HashMap<&str, &[Track]> {
            let mut result = HashMap::new();
            result.insert(library.root_path.as_str(), library.liked_songs.as_slice());
            for folder in &library.folders {
                result.insert(folder.path.as_str(), folder.tracks.as_slice());
            }
            result
        }
        let old_collections = collections(previous);
        let old_tracks: HashMap<&str, &Track> = previous
            .liked_songs
            .iter()
            .chain(previous.folders.iter().flat_map(|f| &f.tracks))
            .map(|t| (t.path.as_str(), t))
            .collect();
        let old_folders: HashMap<&str, &Folder> = previous
            .folders
            .iter()
            .map(|f| (f.path.as_str(), f))
            .collect();
        let mut folders = Vec::new();
        for folder in &current.folders {
            let same = old_folders.get(folder.path.as_str()).is_some_and(|old| {
                old.id == folder.id
                    && old.name == folder.name
                    && old.description == folder.description
                    && old.artwork_path == folder.artwork_path
                    && old.is_root == folder.is_root
            });
            if !same {
                folders.push(Folder {
                    id: folder.id.clone(),
                    name: folder.name.clone(),
                    path: folder.path.clone(),
                    description: folder.description.clone(),
                    artwork_path: folder.artwork_path.clone(),
                    is_root: folder.is_root,
                    tracks: Vec::new(),
                });
            }
        }
        let mut tracks = Vec::new();
        let mut active = HashSet::new();
        for track in current
            .liked_songs
            .iter()
            .chain(current.folders.iter().flat_map(|f| &f.tracks))
        {
            active.insert(track.path.as_str());
            if old_tracks
                .get(track.path.as_str())
                .map_or(true, |old| *old != track)
            {
                tracks.push(track.clone());
            }
        }
        let mut orders = HashMap::new();
        for (path, collection) in collections(current) {
            let order: Vec<String> = collection.iter().map(|t| t.path.clone()).collect();
            if old_collections
                .get(path)
                .map(|tracks| tracks.iter().map(|t| &t.path).eq(order.iter()))
                != Some(true)
            {
                orders.insert(path.to_string(), order);
            }
        }
        let current_folders: HashSet<&str> =
            current.folders.iter().map(|f| f.path.as_str()).collect();
        Self {
            delta: true,
            root_path: current.root_path.clone(),
            base_scanned_at: previous.scanned_at,
            scanned_at: current.scanned_at,
            liked_songs_artwork_path: current.liked_songs_artwork_path.clone(),
            folder_count: current.folder_count,
            track_count: current.track_count,
            folders,
            removed_folders: old_folders
                .keys()
                .filter(|p| !current_folders.contains(**p))
                .map(|p| p.to_string())
                .collect(),
            removed_tracks: old_tracks
                .keys()
                .filter(|p| !active.contains(**p))
                .map(|p| p.to_string())
                .collect(),
            tracks,
            orders,
        }
    }

    pub fn is_empty(&self, previous: &Library) -> bool {
        self.folders.is_empty()
            && self.removed_folders.is_empty()
            && self.tracks.is_empty()
            && self.removed_tracks.is_empty()
            && self.orders.is_empty()
            && self.liked_songs_artwork_path == previous.liked_songs_artwork_path
    }

    pub fn apply(&self, library: &mut Library) {
        let removed: HashSet<&str> = self.removed_tracks.iter().map(String::as_str).collect();
        let mut tracks: HashMap<String, Track> = std::mem::take(&mut library.liked_songs)
            .into_iter()
            .chain(
                library
                    .folders
                    .iter_mut()
                    .flat_map(|f| std::mem::take(&mut f.tracks)),
            )
            .filter(|t| !removed.contains(t.path.as_str()))
            .map(|t| (t.path.clone(), t))
            .collect();
        for track in &self.tracks {
            tracks.insert(track.path.clone(), track.clone());
        }
        library
            .folders
            .retain(|f| !self.removed_folders.contains(&f.path));
        for folder in &self.folders {
            if let Some(old) = library.folders.iter_mut().find(|f| f.path == folder.path) {
                *old = folder.clone();
            } else {
                library.folders.push(folder.clone());
            }
        }
        // Orders for unchanged collections are supplied by apply_to below.
        for (path, order) in &self.orders {
            let items: Vec<Track> = order.iter().filter_map(|p| tracks.remove(p)).collect();
            if path == &library.root_path {
                library.liked_songs = items;
            } else if let Some(folder) = library.folders.iter_mut().find(|f| &f.path == path) {
                folder.tracks = items;
            }
        }
        library
            .folders
            .sort_by(|a, b| crate::util::natural_cmp(&a.name, &b.name));
        library.liked_songs_artwork_path = self.liked_songs_artwork_path.clone();
        library.folder_count = self.folder_count;
        library.track_count = self.track_count;
        library.scanned_at = self.scanned_at;
    }

    pub fn apply_to(&self, library: &mut Library) {
        let mut complete = self.clone();
        complete
            .orders
            .entry(library.root_path.clone())
            .or_insert_with(|| library.liked_songs.iter().map(|t| t.path.clone()).collect());
        for folder in &library.folders {
            complete
                .orders
                .entry(folder.path.clone())
                .or_insert_with(|| folder.tracks.iter().map(|t| t.path.clone()).collect());
        }
        complete.apply(library);
    }
}
