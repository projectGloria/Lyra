// The entire native surface, exposed as `window.spotfck` — the name the renderer was
// written against in the Electron build. Everything the UI can do to the machine goes
// through this file; nothing below it reaches into `window.__TAURI__` directly.
//
// The one rule that shapes this file: Rust returns *paths*, the webview can only load
// *asset URLs*. Every path crossing into the renderer is converted here.

const { invoke, convertFileSrc } = window.__TAURI__.tauri;
const { appWindow } = window.__TAURI__.window;
const { open } = window.__TAURI__.dialog;
const { listen } = window.__TAURI__.event;

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'avif', 'gif', 'bmp', 'ico', 'svg'];
const looksLikeUrl = (value) => /^[a-z][a-z0-9+.-]+:/i.test(value);

const toAssetUrl = (filePath) => {
  const value = String(filePath || '');
  if (!value) return '';
  // Already a URL (asset, file, data, blob): leave it alone.
  if (looksLikeUrl(value)) {
    if (!value.startsWith('file:')) return value;
    return toAssetUrl(fromAssetUrl(value));
  }
  try {
    return convertFileSrc(value);
  } catch {
    return '';
  }
};

// Reverses `toAssetUrl`. Needed because the renderer remaps artwork and audio URLs in
// place when a playlist folder is renamed, and an asset URL percent-encodes the whole
// path into a single segment — there is no prefix left to do string surgery on.
const fromAssetUrl = (value) => {
  const raw = String(value || '');
  if (!raw) return '';
  if (!looksLikeUrl(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === 'file:') return (url.hostname ? `//${url.hostname}` : '') + decodeURIComponent(url.pathname.replace(/^\/([a-z]:)/i, '$1'));
    if (url.protocol !== 'asset:' && !(['http:', 'https:'].includes(url.protocol) && url.hostname === 'asset.localhost')) return raw;
    const encoded = url.pathname.replace(/^\//, '');
    if (!encoded) return '';
    return decodeURIComponent(encoded);
  } catch {
    return '';
  }
};

const mapLibraryUrls = (library) => {
  if (!library || typeof library !== 'object') return library;
  if (Array.isArray(library)) return library.map(mapLibraryUrls);
  for (const [key, value] of Object.entries(library)) {
    if (key === 'path' || key.endsWith('Path')) {
      library[key === 'path' ? 'url' : key.slice(0, -4) + 'Url'] = toAssetUrl(value);
    } else if (value && typeof value === 'object') mapLibraryUrls(value);
  }
  return library;
};

const mapPlaylistResult = (result) => {
  if (result?.artworkPath) result.artworkUrl = toAssetUrl(result.artworkPath);
  else if (result) result.artworkUrl = '';
  return result;
};

const chooseImage = async (title) => {
  const selected = await open({
    directory: false,
    multiple: false,
    title,
    filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
  });
  if (typeof selected === 'string' && selected) {
    await invoke('allow_asset_file', { filePath: selected }).catch(() => {});
    return selected;
  }
  return '';
};

window.spotfck = {
  toAssetUrl,
  fromAssetUrl,

  readSettings: () => invoke('read_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),

  minimize: () => invoke('minimize_window'),
  maximize: () => appWindow.toggleMaximize(),
  close: () => invoke('close_window'),
  setFullscreen: (fullscreen) => invoke('set_window_fullscreen', { fullscreen: Boolean(fullscreen) }).catch(() => {}),

  chooseLibrary: async () => {
    const selected = await open({ directory: true, multiple: false, title: 'Choose Music Library' });
    return typeof selected === 'string' ? selected : '';
  },
  chooseBackground: () => chooseImage('Choose background artwork'),
  chooseProfilePicture: () => chooseImage('Choose a profile picture'),
  choosePlaylistArtwork: () => chooseImage('Choose playlist artwork'),
  chooseTrackArtwork: () => chooseImage('Choose track artwork'),

  scanLibrary: async (rootPath, requestId = null) => {
    const result = await invoke('scan_library', { rootPath, requestId });
    return mapLibraryUrls(result);
  },

  readLibraryCache: async (rootPath) => {
    try {
      return mapLibraryUrls(await invoke('read_library_cache', { rootPath }));
    } catch {
      return { ok: false, error: 'no-cache' };
    }
  },

  watchLibrary: (rootPath) => invoke('watch_library', { rootPath }),

  refreshLibraryChanges: async (_rootPath, changes, requestId = null) =>
    mapLibraryUrls(await invoke('refresh_library_changes', { changes, requestId })),

  onLibraryProgress: (callback) => {
    let unlisten = null;
    let cancelled = false;
    listen('library:progress', (event) => callback(event.payload)).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  },

  onLibraryChanged: (callback) => {
    let unlisten = null;
    let cancelled = false;
    listen('library:changed', (event) => callback(event.payload)).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  },

  // System-wide hotkeys. Resolves to `{ actionId: reason }` for bindings the OS refused.
  setGlobalShortcuts: (bindings = {}) => invoke('set_global_shortcuts', { bindings }).catch(() => ({})),

  onGlobalShortcut: (callback) => {
    let unlisten = null;
    let cancelled = false;
    listen('shortcut:global', (event) => callback(event.payload)).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  },

  reportEvent: (event, details = {}, level = 'info') => {
    invoke('log_event', { event, details, level }).catch(() => {});
  },

  getReportInfo: () => invoke('report_info'),
  openReportFolder: () => invoke('open_reports_folder'),

  revealInExplorer: (targetPath) =>
    invoke('reveal_in_explorer', { targetPath }).then((ok) => Boolean(ok)).catch(() => false),

  createPlaylist: async (payload = {}) =>
    mapPlaylistResult(await invoke('create_playlist', { name: payload.name })),

  deletePlaylist: (payload = {}) =>
    invoke('delete_playlist', { folderPath: payload.folderPath }),

  editPlaylist: async (payload = {}) =>
    mapPlaylistResult(
      await invoke('edit_playlist', {
        folderPath: payload.folderPath,
        name: payload.name,
        description: payload.description,
        artworkPath: payload.artworkPath,
        artworkChanged: Boolean(payload.artworkChanged)
      })
    ),

  reorderPlaylist: (payload = {}) =>
    invoke('reorder_playlist', {
      folderPath: payload.folderPath,
      paths: payload.paths || []
    }),

  // Likes for tracks outside the root live in `.lyra-liked.json` at the library root; each
  // call returns the full, authoritative list of liked paths after the change.
  readLiked: () => invoke('read_liked').catch(() => []),
  setTrackLiked: (trackPath, liked) => invoke('set_track_liked', { trackPath, liked: Boolean(liked) }),
  reorderLiked: (paths = []) => invoke('reorder_liked', { paths }),

  editTrackMetadata: async (payload = {}) => {
    const artworkChanged = Boolean(payload.artworkChanged || payload.artworkSourcePath || payload.removeArtwork);
    const artworkPath = payload.removeArtwork ? '' : String(payload.artworkPath ?? payload.artworkSourcePath ?? '');
    return mapLibraryUrls(
      await invoke('edit_track_metadata', {
        trackPath: payload.trackPath,
        title: payload.title,
        artist: payload.artist,
        album: payload.album,
        albumArtist: payload.albumArtist,
        year: Number(payload.year || 0),
        trackNo: Number(payload.trackNo || 0),
        genre: payload.genre,
        comment: payload.comment,
        artworkPath,
        artworkChanged
      })
    );
  },

  exportQueue: async (tracks = []) => {
    const queue = (Array.isArray(tracks) ? tracks : []).filter((track) => track?.path);
    if (!queue.length) return { ok: false, cancelled: false, error: 'Queue is empty' };
    return invoke('export_queue', {
      tracks: queue.map((track) => ({
        path: track.path,
        title: track.title || '',
        artist: track.artist || '',
        duration: Number(track.duration || 0)
      }))
    });
  }
};
