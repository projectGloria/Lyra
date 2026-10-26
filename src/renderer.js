const audio = document.getElementById('audioElement');
const state = {
  library: { rootPath: '', ok: false, error: '', likedSongs: [], likedSongsArtworkUrl: '', folders: [], folderCount: 0, trackCount: 0, scannedAt: 0 },
  selectedId: 'liked',
  selectedTracks: [],
  currentTrack: null,
  fullscreenView: false,
  queue: [],
  playbackList: [],
  playbackAnchorPath: '',
  basePlaybackList: [],
  query: '',
  libraryQuery: '',
  libraryView: 'list',
  libraryFilter: 'playlists',
  creditsExpanded: false,
  shuffle: false,
  repeatMode: 'off',
  scanning: false,
  scanProgress: { stage: 'validate', label: 'Checking your folder', detail: '', percent: 0, processed: 0, total: 0, folders: 0, tracks: 0 },
  settings: { libraryPath: '', backgroundPath: '', profilePath: '', showInk: false, surfaceOpacity: 70, surfaceBlur: 16, backgroundBlur: 0, linkBlur: false, closeToTray: false, accentColor: '#c9a94a', theme: 'lyra', paletteVersion: 1, layoutVersion: 1, libraryView: 'list', leftSidebarWidth: 280, rightSidebarWidth: 286, shortcuts: {}, globalShortcuts: {} },
  homeActive: false,
  listQuery: '',
  view: { type: 'playlist', id: 'liked' },
  navigationHistory: [],
  navigationIndex: -1,
  selectedTrackIds: new Set(),
  selectionAnchorId: '',
  playbackHistory: [],
  playbackHistoryContexts: [],
  playbackForward: [],
  currentFromQueue: false,
  playlistEditState: null,
  isScrubbing: false,
  consecutivePlaybackErrors: 0,
  focusedTrackId: '',
  queueView: 'queue',
  searchShowAllSongs: false
};

const THEMES = {
  lyra: { label: 'Lyra Gold', accent: '#c9a94a' },
  aurora: { label: 'Aurora Glass', accent: '#62f2d3' },
  midnight: { label: 'Midnight Black', accent: '#b6c7d9' },
  ember: { label: 'Ember Red', accent: '#ff5d68' },
  violet: { label: 'Violet Night', accent: '#a77bff' },
  forest: { label: 'Forest Neon', accent: '#71e08b' },
  rose: { label: 'Rose Noir', accent: '#f27d9d' }
};

let toastTimer;
const inkBackground = new LyraInkBackground(audio, document.getElementById('inkCanvas'), (message) => showToast(message));
let progressRenderQueued = false;
let seekUiFrame = 0;
let playbackRequestId = 0;
let playbackErrorTimer = null;
let playbackTransitioning = false;
let lastPlaybackUiKey = '';
let lastCurrentRowId = '';
let libraryFolderIndex = new Map();
let volumeFeedbackTimer;
let fullscreenVolumeHideTimer;
let fullscreenVolumeVisible = false;
let volumeBeforeMute = 0.5;
let contentSearchTimer;
let searchSuggestIndex = -1;
let listSearchTimer;
let libraryChangeTimer;
let draggedTrackId = '';
let draggedTrackIds = [];
let draggedQueueId = '';
let dragChipElement = null;
let dropPosition = '';
let sidebarSaveTimer;
let playbackSessionTimer;
let playbackSessionReady = false;
let playbackSessionDirty = true;
let lastPositionWrite = 0;
let restoreSeek = null;
let contextTrackId = '';
let librarySearchTimer;
const PLAYBACK_SESSION_KEY = 'lyra-sona-playback-session-v1';
const MAX_NAVIGATION_HISTORY = 200;
const TRACK_ROW_HEIGHT = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--track-row-height'));
let trackListResizeObserver;
let allTracks = [];
let tracksById = new Map();
let tracksByPath = new Map();
let volumeSaveTimer;
const TRACK_VIRTUAL_OVERSCAN = 12;
let scanRequestId = 0;
let activeScanClientId = 0;
let activeScanPromise = null;
let modalReturnFocus = null;
// Likes for tracks outside the root, as absolute paths in the order they were liked. The
// root folder itself is Liked Songs, so these are references, never copies of audio.
let likedReferencePaths = [];
let likedReferenceKeys = new Set();
let likedTracksCache = null;
let likeWriteChain = Promise.resolve();
let likeWritesPending = 0;

function trackPathKey(path) {
  return String(path || '').replaceAll('\\', '/').toLowerCase();
}

function setLikedReferences(paths) {
  likedReferencePaths = Array.isArray(paths) ? paths.map(String) : [];
  likedReferenceKeys = new Set(likedReferencePaths.map(trackPathKey));
  likedTracksCache = null;
}

// Liked Songs is derived, not stored: root files (liked by location) followed by resolved
// references. Keyed on the root array's identity so a reorder or rescan that swaps
// `likedSongs` rebuilds it, while every render in between reuses the same array.
function getLikedTracks() {
  const rootTracks = state.library.likedSongs || [];
  if (likedTracksCache?.rootTracks === rootTracks) return likedTracksCache.tracks;
  const rootKeys = new Set(rootTracks.map((track) => trackPathKey(track.path)));
  const seen = new Set(rootKeys);
  const references = [];
  for (const path of likedReferencePaths) {
    const key = trackPathKey(path);
    const track = seen.has(key) ? null : tracksByPath.get(key);
    if (!track) continue;
    seen.add(key);
    references.push(track);
  }
  likedTracksCache = { rootTracks, rootKeys, tracks: references.length ? [...rootTracks, ...references] : rootTracks };
  return likedTracksCache.tracks;
}

function isRootTrack(track) {
  if (!track?.path) return false;
  getLikedTracks();
  return likedTracksCache.rootKeys.has(trackPathKey(track.path));
}

function isTrackLiked(track) {
  return Boolean(track?.path) && (likedReferenceKeys.has(trackPathKey(track.path)) || isRootTrack(track));
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

// The webview cannot load `file://` URLs at all — local media reaches the page only
// through Tauri's asset protocol. Every path-to-URL conversion goes through the bridge so
// there is exactly one place that knows how that mapping works.
function fileUrl(filePath) {
  return window.spotfck.toAssetUrl(filePath);
}

const ICONS = {
  search: '<circle cx="10.8" cy="10.8" r="6.2"/><path d="m16 16 4.5 4.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  list: '<path d="M5 6h14M5 12h14M5 18h14"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  settings: '<path d="m12 3 1.2 1.9 2.2.5 1.9-1.1 2.4 2.4-1.1 1.9.5 2.2L21 12l-1.9 1.2-.5 2.2 1.1 1.9-2.4 2.4-1.9-1.1-2.2.5L12 21l-1.2-1.9-2.2-.5-1.9 1.1-2.4-2.4 1.1-1.9-.5-2.2L3 12l1.9-1.2.5-2.2-1.1-1.9 2.4-2.4 1.9 1.1 2.2-.5L12 3Z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="m9 6 9 6-9 6Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 6v12M16 6v12"/>',
  previous: '<path d="m15 6-6 6 6 6M6 6v12"/>',
  next: '<path d="m9 6 6 6-6 6M18 6v12"/>',
  shuffle: '<path d="M3 7h2.5c3.6 0 4.4 10 8.2 10H21M3 17h2.5c1.3 0 2.2-.7 3-1.8M14.7 8.8C15.6 7.6 16.4 7 17.5 7H21M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>',
  heart: '<path d="M20.8 8.7c0 5.1-8.8 10.1-8.8 10.1S3.2 13.8 3.2 8.7A4.7 4.7 0 0 1 12 6.5a4.7 4.7 0 0 1 8.8 2.2Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="6" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1" fill="currentColor" stroke="none"/>',
  edit: '<path d="m4 20 3.8-1L18.5 8.3a2.1 2.1 0 0 0-3-3L4.8 16.1 4 20Z"/><path d="m13.8 6.2 3 3"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 9a5 5 0 0 1 0 6M19.5 6.5a9 9 0 0 1 0 11"/>',
  volumeMute: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m17 9 4 6m0-6-4 6"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  fullscreen: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>',
  folder: '<path d="M3.5 7.5h6l1.6 2H20.5v8.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V7.5Z"/><path d="M3.5 7.5V5.8a1.3 1.3 0 0 1 1.3-1.3h4l1.7 2h8.2a1.8 1.8 0 0 1 1.8 1.8v1.2"/>',
  music: '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
  warning: '<path d="m12 4 9 16H3L12 4Z"/><path d="M12 9v5M12 17h.01"/>'
};

function iconMarkup(name, className = 'ui-icon') {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.more}</svg>`;
}

function applyBackground() {
  const shell = document.getElementById('appShell');
  if (!shell) return;
  const background = String(state.settings.backgroundPath || '').trim();
  const hasBackground = Boolean(background);
  shell.classList.toggle('has-background', hasBackground);
  if (hasBackground) {
    shell.style.setProperty('--custom-background', `url("${fileUrl(background).replace(/["()\\\n\r]/g, (c) => encodeURIComponent(c))}")`);
    shell.style.setProperty('--background-opacity', '1');
  } else {
    shell.style.removeProperty('--custom-background');
    shell.style.removeProperty('--background-opacity');
  }
  applySurfaceStyle();
}

// Glass panels over a background picture: [min, max, default]. Clamped on read because
// settings.json is hand-editable and a stray "-5" or "abc" must not break the cascade.
const SURFACE_LIMITS = { surfaceOpacity: [0, 100, 70], surfaceBlur: [0, 40, 16], backgroundBlur: [0, 40, 0] };
const BLUR_SETTINGS = ['surfaceBlur', 'backgroundBlur'];

function surfaceSetting(key) {
  const [min, max, fallback] = SURFACE_LIMITS[key];
  const raw = state.settings[key];
  const value = raw === '' || raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

// Only the variables change; CSS scopes them to `.has-background`, so the solid
// no-picture surfaces are untouched whatever these are set to.
function applySurfaceStyle() {
  const shell = document.getElementById('appShell');
  if (!shell) return;
  shell.style.setProperty('--surface-opacity', `${surfaceSetting('surfaceOpacity')}%`);
  shell.style.setProperty('--surface-blur', `${surfaceSetting('surfaceBlur')}px`);
  shell.style.setProperty('--background-blur', `${surfaceSetting('backgroundBlur')}px`);
}

// One write path for the sliders. While the blurs are linked, moving either one moves both,
// so they can never drift apart through the UI.
function setSurfaceSetting(key, value) {
  if (!Object.hasOwn(SURFACE_LIMITS, key)) return;
  const keys = state.settings.linkBlur && BLUR_SETTINGS.includes(key) ? BLUR_SETTINGS : [key];
  for (const target of keys) state.settings[target] = Number(value);
  applySurfaceStyle();
  renderSurfaceControls();
}

function toggleBlurLink() {
  state.settings.linkBlur = !state.settings.linkBlur;
  // Panels are the reference: linking snaps the picture blur to the panel blur.
  if (state.settings.linkBlur) state.settings.backgroundBlur = surfaceSetting('surfaceBlur');
  applySurfaceStyle();
  renderSurfaceControls();
  persistSettings();
}

function renderSurfaceControls() {
  const rows = [...document.querySelectorAll('[data-surface-row]')];
  if (!rows.length) return;
  const enabled = Boolean(String(state.settings.backgroundPath || '').trim());
  for (const row of rows) row.classList.toggle('is-disabled', !enabled);
  const hint = document.getElementById('surfaceControlsHint');
  if (hint) hint.textContent = enabled ? 'How much of the picture shows through the panels.' : 'Choose a background picture to adjust these.';
  const link = document.querySelector('[data-action="toggle-blur-link"]');
  if (link) {
    link.disabled = !enabled;
    link.classList.toggle('active', Boolean(state.settings.linkBlur));
    link.setAttribute('aria-pressed', String(Boolean(state.settings.linkBlur)));
  }
  for (const [key, [min, max]] of Object.entries(SURFACE_LIMITS)) {
    const input = document.querySelector(`[data-surface-setting="${key}"]`);
    const readout = document.querySelector(`[data-surface-readout="${key}"]`);
    const value = surfaceSetting(key);
    if (input) {
      input.disabled = !enabled;
      // Don't fight the thumb mid-drag: the value is already what the user is holding.
      if (Number(input.value) !== value) input.value = String(value);
      input.style.setProperty('--progress', `${((value - min) / (max - min)) * 100}%`);
    }
    if (readout) readout.textContent = BLUR_SETTINGS.includes(key) ? `${value}px` : `${value}%`;
  }
}

const OVERLAY_THEME_PROPERTIES = [
  '--bg', '--bg-deep', '--panel', '--panel-strong', '--panel-soft', '--control', '--control-hover',
  '--line', '--line-strong', '--text', '--text-strong', '--text-soft', '--muted', '--muted-2',
  '--cyan', '--cyan-strong', '--violet', '--pink'
];

let lastOverlayThemeKey = '';
function syncOverlayTheme(force = false) {
  const shell = document.getElementById('appShell');
  if (!shell) return;
  // Reading 18 computed properties forces a synchronous style flush. The values only
  // change with the theme or accent, so key on those rather than on every render.
  const themeKey = `${state.settings.theme}:${state.settings.accentColor}`;
  if (!force && themeKey === lastOverlayThemeKey) return;
  lastOverlayThemeKey = themeKey;
  const computed = getComputedStyle(shell);
  OVERLAY_THEME_PROPERTIES.forEach((property) => {
    const value = computed.getPropertyValue(property).trim();
    if (value) document.documentElement.style.setProperty(property, value);
  });
}

// Settings arrive over async IPC, so the first paint used the stylesheet's own default
// palette - blue-black with teal accents - and visibly flipped to the saved theme once
// the IPC resolved. localStorage is synchronous, so cache the appearance there and apply
// it before that first paint. The cache is only ever a hint: readSettings() remains the
// source of truth and overwrites it a moment later.
const APPEARANCE_CACHE_KEY = 'lyra-appearance-v1';

function writeCachedAppearance() {
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ theme: state.settings.theme, accentColor: state.settings.accentColor }));
  } catch {}
}

function applyCachedAppearance() {
  try {
    const cached = JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) || 'null');
    if (cached && Object.hasOwn(THEMES, cached.theme)) state.settings.theme = cached.theme;
    if (cached && /^#[0-9a-f]{6}$/i.test(String(cached.accentColor || ''))) state.settings.accentColor = cached.accentColor;
  } catch {}
  applyTheme();
  applyAccentColor();
}

function applyTheme() {
  const shell = document.getElementById('appShell');
  const themeId = Object.hasOwn(THEMES, state.settings.theme) ? state.settings.theme : 'lyra';
  state.settings.theme = themeId;
  shell.dataset.theme = themeId;
  document.documentElement.dataset.theme = themeId;
  syncOverlayTheme();
  document.querySelectorAll('[data-theme-id]').forEach((option) => {
    option.classList.toggle('selected', option.dataset.themeId === themeId);
  });
}

function applyAccentColor() {
  const shell = document.getElementById('appShell');
  const accent = /^#[0-9a-f]{6}$/i.test(String(state.settings.accentColor || '')) ? state.settings.accentColor : '#62f2d3';
  state.settings.accentColor = accent;
  shell.style.setProperty('--cyan', accent);
  shell.style.setProperty('--cyan-strong', accent);
  document.documentElement.style.setProperty('--cyan', accent);
  document.documentElement.style.setProperty('--cyan-strong', accent);
  const picker = document.getElementById('accentColorPicker');
  if (picker) picker.value = accent;
  document.querySelectorAll('[data-accent-color]').forEach((swatch) => {
    swatch.classList.toggle('selected', swatch.dataset.accentColor.toLowerCase() === accent.toLowerCase());
  });
}

function applyProfilePicture() {
  const profilePath = String(state.settings.profilePath || '').trim();
  const avatar = document.getElementById('profileAvatar');
  if (avatar) {
    avatar.innerHTML = profilePath ? `<img src="${escapeHtml(fileUrl(profilePath))}" alt="Profile picture" />` : 'N';
    avatar.classList.toggle('has-image', Boolean(profilePath));
  }
  const preview = document.getElementById('settingsProfilePreview');
  if (preview) {
    preview.innerHTML = profilePath ? `<img src="${escapeHtml(fileUrl(profilePath))}" alt="Profile picture preview" />` : 'N';
    preview.classList.toggle('has-image', Boolean(profilePath));
  }
  const label = document.getElementById('settingsProfilePath');
  if (label) label.textContent = profilePath ? 'Custom picture selected' : 'Use initials';
  const removeButton = document.getElementById('removeProfileButton');
  if (removeButton) removeButton.disabled = !profilePath;
}

function scanErrorMessage(error) {
  const value = String(error || 'scan-failed');
  if (value === 'ENOENT' || value.includes('no-such')) return 'The selected folder no longer exists.';
  if (value === 'EACCES' || value.includes('permission')) return 'Windows denied access to this folder.';
  if (value === 'not-a-directory') return 'The selected path is not a folder.';
  if (value === 'no-folder-selected') return 'No music folder has been selected.';
  return `Could not scan this folder (${value}).`;
}

function scanProgressMarkup(compact = false) {
  const progress = state.scanProgress || {};
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  const processed = Number(progress.processed || 0);
  const total = Number(progress.total || 0);
  const folders = Number(progress.folders || 0);
  const tracks = Number(progress.tracks || 0);
  const counter = total ? `${processed} / ${total} audio files` : `${folders} playlist folders found`;
  return `<div class="scan-progress ${compact ? 'compact' : ''}" role="status" aria-live="polite">
    <div class="scan-progress-orbit"><span></span></div>
    <div class="scan-progress-copy"><strong>${escapeHtml(progress.label || 'Scanning your folder')}</strong><span>${escapeHtml(progress.detail || 'Preparing your local library…')}</span></div>
    <div class="scan-progress-meter"><span style="width:${percent}%"></span></div>
    <div class="scan-progress-meta"><span>${escapeHtml(counter)}</span><span>${folders} folders · ${tracks} tracks</span><b>${percent}%</b></div>
  </div>`;
}

function updateScanProgressDom() {
  const progress = state.scanProgress || {};
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  const processed = Number(progress.processed || 0);
  const total = Number(progress.total || 0);
  const folders = Number(progress.folders || 0);
  const tracks = Number(progress.tracks || 0);
  const counter = total ? `${processed} / ${total} audio files` : `${folders} playlist folders found`;
  document.querySelectorAll('.scan-progress').forEach((root) => {
    const label = root.querySelector('.scan-progress-copy strong');
    const detail = root.querySelector('.scan-progress-copy span');
    const meter = root.querySelector('.scan-progress-meter span');
    const meta = root.querySelectorAll('.scan-progress-meta span');
    const percentLabel = root.querySelector('.scan-progress-meta b');
    if (label) label.textContent = progress.label || 'Scanning your folder';
    if (detail) detail.textContent = progress.detail || 'Preparing your local library…';
    if (meter) meter.style.width = `${percent}%`;
    if (meta[0]) meta[0].textContent = counter;
    if (meta[1]) meta[1].textContent = `${folders} folders · ${tracks} tracks`;
    if (percentLabel) percentLabel.textContent = `${percent}%`;
  });
}

function handleScanProgress(progress) {
  if (progress?.scanId && activeScanClientId && progress.scanId !== activeScanClientId) return;
  state.scanProgress = { ...state.scanProgress, ...(progress || {}) };
  if (!state.scanning || progressRenderQueued) return;
  progressRenderQueued = true;
  requestAnimationFrame(() => {
    progressRenderQueued = false;
    if (state.scanning) updateScanProgressDom();
  });
}

function reportEvent(event, details = {}, level = 'info') {
  try { window.spotfck?.reportEvent?.(event, details, level); } catch {}
}

function reportTrack(track) {
  if (!track) return null;
  const extension = String(track.path || '').match(/\.[^.\\/]+$/)?.[0]?.toLowerCase() || '';
  return {
    id: track.id || '',
    duration: Number(track.duration || 0),
    extension
  };
}

window.addEventListener('error', (event) => {
  reportEvent('renderer.uncaught-error', { message: event.message, filename: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack || '' }, 'error');
});
window.addEventListener('unhandledrejection', (event) => {
  reportEvent('renderer.unhandled-rejection', { reason: event.reason?.stack || event.reason?.message || String(event.reason || 'Unknown rejection') }, 'error');
});

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}

function artMarkup(url, label, className = 'placeholder-art', fallbackUrl = '') {
  if (url) return `<img data-art-image="true" data-art-label="${escapeHtml(label)}" data-art-fallback="${escapeHtml(fallbackUrl || '')}" src="${escapeHtml(url)}" alt="${escapeHtml(label)} artwork" loading="lazy" decoding="async" />`;
  // Presentation only: never store the placeholder as a track's artwork URL.
  return `<div class="${className} no-artwork" role="img" aria-label="${escapeHtml(label ? `${label} — No artwork` : 'No artwork')}"></div>`;
}

function bindArtworkFallbacks() {
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.dataset.artImage !== 'true') return;
    const fallbackUrl = image.dataset.artFallback || '';
    if (fallbackUrl && image.dataset.artRetried !== 'true' && fallbackUrl !== image.src) {
      image.dataset.artRetried = 'true';
      image.src = fallbackUrl;
      return;
    }
    if (!image.parentElement) return;
    const label = image.dataset.artLabel || 'S';
    image.outerHTML = artMarkup('', label, 'placeholder-art');
  }, true);
}

function getSelectedItem() {
  if (state.selectedId === 'liked') {
    return { id: 'liked', name: 'Liked Songs', tracks: getLikedTracks(), artworkUrl: state.library.likedSongsArtworkUrl || '', isLiked: true };
  }
  return state.library.folders.find((folder) => folder.id === state.selectedId) || null;
}

function getAllTracks() {
  return allTracks;
}

function sameView(first, second) {
  return first?.type === second?.type && first?.id === second?.id && first?.value === second?.value && first?.query === second?.query;
}

function applyView(view) {
  if (!sameView(state.view, view)) {
    state.selectedTrackIds.clear();
    state.selectionAnchorId = '';
    state.focusedTrackId = '';
  }
  state.view = { ...view };
  state.homeActive = view.type === 'home';
  state.searchShowAllSongs = false;
  state.query = view.type === 'search' ? String(view.query || '') : '';
  state.listQuery = String(view.listQuery || '');
  if (view.type === 'playlist' && view.id) state.selectedId = view.id;
  const globalSearch = document.getElementById('globalSearch');
  if (globalSearch) globalSearch.value = state.query;
  // Any navigation (pick, back/forward, home, clear) retires the dropdown.
  // typeof guard: unit tests extract this function without the dropdown helpers.
  if (typeof closeSearchSuggest === 'function') closeSearchSuggest();
}

function snapshotCurrentNavigationState() {
  if (state.navigationIndex < 0 || !state.navigationHistory[state.navigationIndex]) return;
  const scroller = document.querySelector('#contentView .track-list, #contentView .home-view, #contentView .global-results-view');
  state.navigationHistory[state.navigationIndex] = { ...state.view, listQuery: state.listQuery, scrollTop: scroller?.scrollTop || 0 };
}

function restoreViewScroll(view) {
  const scrollTop = Number(view?.scrollTop || 0);
  if (!scrollTop) return;
  requestAnimationFrame(() => {
    const scroller = document.querySelector('#contentView .track-list, #contentView .home-view, #contentView .global-results-view');
    if (scroller) scroller.scrollTop = scrollTop;
  });
}

function updateNavigationControls() {
  const back = document.getElementById('navBackButton');
  const forward = document.getElementById('navForwardButton');
  if (back) back.disabled = state.navigationIndex <= 0;
  if (forward) forward.disabled = state.navigationIndex < 0 || state.navigationIndex >= state.navigationHistory.length - 1;
}

function seedNavigation(view = state.view) {
  if (state.navigationHistory.length) return;
  state.navigationHistory = [{ ...view }];
  state.navigationIndex = 0;
  updateNavigationControls();
}

function navigateTo(view, { replace = false } = {}) {
  if (state.fullscreenView) setFullscreenView(false);
  seedNavigation();
  snapshotCurrentNavigationState();
  const next = { ...view };
  if (replace) {
    state.navigationHistory[state.navigationIndex] = next;
  } else if (!sameView(state.navigationHistory[state.navigationIndex], next)) {
    state.navigationHistory = state.navigationHistory.slice(0, state.navigationIndex + 1);
    state.navigationHistory.push(next);
    if (state.navigationHistory.length > MAX_NAVIGATION_HISTORY) state.navigationHistory = state.navigationHistory.slice(-MAX_NAVIGATION_HISTORY);
    state.navigationIndex = state.navigationHistory.length - 1;
  }
  applyView(next);
  reportEvent('navigation.changed', { from: state.navigationHistory[state.navigationIndex - (replace ? 0 : 1)]?.type || null, to: next.type, entityType: next.type === 'artist' || next.type === 'album' ? next.type : null, queryLength: String(next.query || '').length });
  render();
  restoreViewScroll(next);
}

function navigateHistory(direction) {
  snapshotCurrentNavigationState();
  const nextIndex = state.navigationIndex + direction;
  if (nextIndex < 0 || nextIndex >= state.navigationHistory.length) return;
  state.navigationIndex = nextIndex;
  const view = state.navigationHistory[nextIndex];
  applyView(view);
  render();
  restoreViewScroll(view);
}

function getArtworkForTrack(track) {
  return track?.artworkUrl || '';
}

function getPathLabel(value = '') {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function normalizeLibrary(library) {
  const normalized = library || { rootPath: '', likedSongs: [], folders: [] };
  albumCollectionsCache = null;
  likedTracksCache = null;
  libraryFolderIndex = new Map();
  for (const folder of normalized.folders || []) {
    if (folder.path) libraryFolderIndex.set(folder.path, folder);
    if (folder.id) libraryFolderIndex.set(folder.id, folder);
  }
  const collections = [normalized.likedSongs || [], ...(normalized.folders || []).map((folder) => folder.tracks || [])];
  tracksById = new Map();
  tracksByPath = new Map();
  for (const collection of collections) for (const track of collection) {
    track._searchText = `${track.title || ''}\n${track.artist || ''}\n${track.album || ''}`.toLowerCase();
    tracksById.set(track.id, track);
    tracksByPath.set(String(track.path || '').replaceAll('\\', '/').toLowerCase(), track);
  }
  allTracks = [...tracksById.values()];
  state.selectedTrackIds = new Set([...state.selectedTrackIds].filter((id) => tracksById.has(id)));
  if (state.selectedId !== 'liked' && !libraryFolderIndex.has(state.selectedId)) {
    state.selectedId = 'liked';
    if (state.view.type === 'playlist') state.view.id = 'liked';
  }
  return normalized;
}

function applyLibraryDelta(library, delta) {
  const pathKey = (path) => String(path || '').replaceAll('\\', '/').toLowerCase();
  const removedFolders = new Set(delta.removedFolders || []);
  library.folders = library.folders.filter((folder) => !removedFolders.has(folder.path));
  for (const path of delta.removedTracks || []) {
    const previous = tracksByPath.get(pathKey(path));
    if (previous) { tracksById.delete(previous.id); state.selectedTrackIds.delete(previous.id); }
    tracksByPath.delete(pathKey(path));
  }
  let membershipChanged = Boolean(delta.removedTracks?.length);
  for (const update of delta.tracks || []) {
    const key = pathKey(update.path);
    const previous = tracksByPath.get(key);
    if (!previous) membershipChanged = true;
    else if (previous.id !== update.id) tracksById.delete(previous.id);
    const track = Object.assign(previous || {}, update);
    track._searchText = `${track.title || ''}\n${track.artist || ''}\n${track.album || ''}`.toLowerCase();
    tracksByPath.set(key, track);
    tracksById.set(track.id, track);
  }
  const folders = new Map(library.folders.map((folder) => [folder.path, folder]));
  for (const metadata of delta.folders || []) {
    const folder = folders.get(metadata.path) || { tracks: [] };
    const tracks = folder.tracks;
    Object.assign(folder, metadata, { tracks });
    folders.set(folder.path, folder);
  }
  for (const [path, order] of Object.entries(delta.orders || {})) {
    const tracks = order.map((path) => tracksByPath.get(pathKey(path))).filter(Boolean);
    if (pathKey(path) === pathKey(library.rootPath)) library.likedSongs = tracks;
    else if (folders.has(path)) folders.get(path).tracks = tracks;
  }
  library.folders = [...folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  libraryFolderIndex = new Map();
  for (const folder of library.folders) { libraryFolderIndex.set(folder.path, folder); libraryFolderIndex.set(folder.id, folder); }
  if (membershipChanged) allTracks = [...tracksById.values()];
  albumCollectionsCache = null;
  likedTracksCache = null;
  Object.assign(library, { scannedAt: delta.scannedAt, folderCount: delta.folderCount, trackCount: delta.trackCount,
    likedSongsArtworkPath: delta.likedSongsArtworkPath, likedSongsArtworkUrl: delta.likedSongsArtworkUrl || '' });
  if (state.selectedId !== 'liked' && !libraryFolderIndex.has(state.selectedId)) {
    state.selectedId = 'liked';
    if (state.view.type === 'playlist') state.view.id = 'liked';
  }
  return library;
}

// Albums cut across folders, so they are derived from the flat track list rather than
let albumCollectionsCache = null;
const albumCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
function albumIdentity(track) {
  const artist = String(track.albumArtist || track.artist || '').trim().toLowerCase();
  const album = String(track.album || '').trim().toLowerCase();
  return `${artist}\0${album}`;
}

function getAlbumCollections() {
  if (albumCollectionsCache) return albumCollectionsCache;
  const albums = new Map();
  for (const track of getAllTracks()) {
    const name = String(track.album || '').trim();
    if (!name || name.toLowerCase() === 'local library') continue;
    const key = albumIdentity(track);
    let album = albums.get(key);
    if (!album) {
      album = { id: `album:${key}`, name, value: key, tracks: [], artworkUrl: '', isAlbum: true, description: track.albumArtist || track.artist || '' };
      albums.set(key, album);
    }
    album.tracks.push(track);
    if (!album.artworkUrl && track.artworkUrl) album.artworkUrl = track.artworkUrl;
  }
  const collator = typeof albumCollator !== 'undefined' ? albumCollator : new Intl.Collator(undefined, { sensitivity: 'base' });
  albumCollectionsCache = [...albums.values()].sort((a, b) => collator.compare(a.name, b.name));
  return albumCollectionsCache;
}

function getFolderById(id) {
  return libraryFolderIndex.get(id) || null;
}

function updateLibrarySummary(visibleCount = null) {
  const summary = document.getElementById('librarySummary');
  if (!summary) return;
  if (state.scanning && !state.library.ok) {
    summary.textContent = 'Scanning library…';
    return;
  }
  if (state.scanning && state.library.ok) {
    summary.textContent = 'Checking library for changes…';
    return;
  }
  if (!state.settings.libraryPath) {
    summary.textContent = 'No folder selected';
    return;
  }
  if (!state.library.ok) {
    summary.textContent = 'Library unavailable';
    return;
  }
  const trackCount = Number(state.library.trackCount || 0);
  const noun = state.libraryFilter === 'albums' ? 'album' : 'playlist';
  const total = state.libraryFilter === 'albums'
    ? getAlbumCollections().length
    : Number(state.library.folderCount || state.library.folders?.length || 0) + 1;
  if (state.libraryQuery.trim()) {
    summary.textContent = `${Number(visibleCount || 0)} of ${total} ${noun}s`;
    return;
  }
  summary.textContent = `${total} ${total === 1 ? noun : `${noun}s`} · ${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}`;
}

function renderLibrary() {
  const list = document.getElementById('libraryList');
  if (state.scanning && !state.library.ok) {
    updateLibrarySummary();
    list.innerHTML = scanProgressMarkup(true);
    return;
  }
  if (!state.settings.libraryPath) {
    updateLibrarySummary();
    list.innerHTML = `<div class="library-empty"><span class="library-empty-icon">${iconMarkup('folder')}</span><strong>No music folder selected</strong><span>Choose a folder to populate your library.</span><button class="secondary-button compact" data-action="choose-library">Choose folder</button></div>`;
    return;
  }
  if (!state.library.ok) {
    updateLibrarySummary();
    list.innerHTML = `<div class="library-empty error-state"><span class="library-empty-icon">${iconMarkup('warning')}</span><strong>Library scan failed</strong><span>${escapeHtml(scanErrorMessage(state.library.error))}</span><button class="secondary-button compact" data-action="choose-library">Choose another folder</button></div>`;
    return;
  }
  if (!state.library.trackCount && !state.library.folders?.length) {
    updateLibrarySummary();
    list.innerHTML = `<div class="library-empty"><span class="library-empty-icon">${iconMarkup('music')}</span><strong>No audio files found</strong><span>Supported files can be placed in the root or inside folders.</span><button class="secondary-button compact" data-action="scan">Rescan folder</button></div>`;
    return;
  }
  const query = state.libraryQuery.trim().toLowerCase();
  const liked = getLikedTracks();
  const showingAlbums = state.libraryFilter === 'albums';
  const activeAlbumKey = state.view?.type === 'album' ? String(state.view.value || '').trim().toLowerCase() : '';
  const collections = showingAlbums
    ? getAlbumCollections().map((album) => ({ ...album, subtitle: `${album.tracks.length} ${album.tracks.length === 1 ? 'song' : 'songs'}` }))
    : [
      { id: 'liked', name: 'Liked Songs', subtitle: `${liked.length} ${liked.length === 1 ? 'song' : 'songs'}`, artworkUrl: state.library.likedSongsArtworkUrl || '', isLiked: true, tracks: liked },
      ...(state.library.folders || []).map((folder) => ({ ...folder, subtitle: `${folder.tracks.length} songs` }))
    ];
  document.querySelectorAll('[data-library-filter]').forEach((button) => {
    const active = button.dataset.libraryFilter === state.libraryFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const items = collections.map((item) => {
    const matchingTracks = query ? (item.tracks || []).filter((track) => (track._searchText ?? `${track.title || ''}\n${track.artist || ''}\n${track.album || ''}`.toLowerCase()).includes(query)).slice(0, 3) : [];
    const matchesCollection = !query || item.name.toLowerCase().includes(query) || item.subtitle.toLowerCase().includes(query) || String(item.description || '').toLowerCase().includes(query);
    return { ...item, matchingTracks, matchesCollection };
  }).filter((item) => !query || item.matchesCollection || item.matchingTracks.length);

  updateLibrarySummary(items.length);
  list.classList.toggle('grid-view', state.libraryView === 'grid');
  document.querySelectorAll('.view-toggle[data-view]').forEach((button) => {
    const active = button.dataset.view === state.libraryView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  list.innerHTML = items.length ? items.map((item) => {
    const selected = item.isAlbum ? item.value === activeAlbumKey : item.id === state.selectedId;
    // Album rows hand off to the existing album entity view instead of selecting a folder.
    const target = item.isAlbum
      ? `data-entity-type="album" data-entity-value="${escapeHtml(item.value)}"`
      : `data-library-id="${escapeHtml(item.id)}"`;
    const glyph = item.isAlbum ? '◉' : item.isLiked ? '♥' : '▰';
    return `
    <div class="library-item ${selected ? 'selected' : ''}">
      <button type="button" class="library-item-main" ${target} aria-pressed="${selected ? 'true' : 'false'}">
        <span class="library-art">${item.artworkUrl ? artMarkup(item.artworkUrl, item.name, 'library-art', getArtworkForTrack(item.tracks?.[0])) : `<span class="${item.isLiked ? 'heart-glyph' : 'folder-glyph'}">${glyph}</span>`}</span>
        <span class="library-copy"><strong>${escapeHtml(item.name)}</strong><span class="library-subtitle">${escapeHtml(item.subtitle)}</span></span>
      </button>
      ${item.matchingTracks.length ? `<div class="library-match-list">${item.matchingTracks.map((track) => `<button type="button" class="library-match" data-track-id="${escapeHtml(track.id)}" aria-label="Play ${escapeHtml(track.title)}"><span class="library-match-icon">${iconMarkup('music')}</span><span>${escapeHtml(track.title)}</span></button>`).join('')}</div>` : ''}
    </div>`;
  }).join('') : `<div class="empty-library"><span>No matches</span></div>`;

}

function renderHomeView(container) {
  const playlists = [
    { id: 'liked', name: 'Liked Songs', description: 'Root folder tracks and songs you liked', tracks: getLikedTracks(), artworkUrl: state.library.likedSongsArtworkUrl || '', isLiked: true },
    ...(state.library.folders || []).map((folder) => ({ ...folder, description: folder.description || '', tracks: folder.tracks || [] }))
  ];

  container.innerHTML = `
    <div class="home-view">
      <div class="home-heading">
        <div>
          <span class="eyebrow">YOUR LIBRARY</span>
          <h2>Your playlists</h2>
          <p>${playlists.length} ${playlists.length === 1 ? 'playlist' : 'playlists'}</p>
        </div>
      </div>
      <div class="playlist-grid">
        ${playlists.length ? playlists.map((item) => {
          const coverUrl = item.artworkUrl || getArtworkForTrack(item.tracks[0]);
          const subtitle = `${item.tracks.length} ${item.tracks.length === 1 ? 'song' : 'songs'}`;
          return `<button type="button" class="playlist-card ${item.id === state.selectedId ? 'selected' : ''}" data-home-library-id="${escapeHtml(item.id)}" aria-label="Open ${escapeHtml(item.name)}">
            <span class="playlist-card-art">${coverUrl ? artMarkup(coverUrl, item.name, 'placeholder-art') : `<span class="playlist-placeholder ${item.isLiked ? 'liked' : ''}">${item.isLiked ? '♥' : '♫'}</span>`}</span>
            <span class="playlist-card-copy"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span>${escapeHtml(subtitle)}</span></span>
            <span class="playlist-card-play" aria-hidden="true">${iconMarkup('play')}</span>
          </button>`;
        }).join('') : `<div class="home-empty"><h3>No playlists found</h3><p>Try a different search or add audio folders to your library.</p></div>`}
      </div>
    </div>`;
}

function filterListTracks(tracks) {
  const query = state.listQuery.trim().toLowerCase();
  if (!query) return tracks;
  return tracks.filter((track) => (track._searchText ?? `${track.title || ''}\n${track.artist || ''}\n${track.album || ''}`.toLowerCase()).includes(query));
}

function contextSearchMarkup(label) {
  return `<div class="context-search-zone hero-search-zone"><label class="context-search" for="contextSearch"><span>${iconMarkup('search')}</span><input id="contextSearch" type="search" value="${escapeHtml(state.listQuery)}" placeholder="Search in ${escapeHtml(label)}" autocomplete="off" aria-label="Search in ${escapeHtml(label)}" /></label></div>`;
}

function selectionToolbarMarkup() {
  return '';
}

function mountTrackCollection(container, tracks, collectionId) {
  const trackList = container.querySelector('.track-list');
  const virtualBody = trackList?.querySelector('.track-virtual-body');
  if (virtualBody && tracks.length) virtualBody.style.minHeight = `${tracks.length * TRACK_ROW_HEIGHT}px`;
  if (trackList && tracks.length) setupVirtualTrackList(trackList, tracks);
  if (trackList) trackList.dataset.libraryId = collectionId;
}

function renderEntityView(container, type, value) {
  const normalized = String(value || '').trim().toLowerCase();
  const tracks = getAllTracks().filter((track) => type === 'album'
    ? albumIdentity(track) === value
    : String(track[type] || '').trim().toLowerCase() === normalized);
  const label = type === 'album' ? tracks[0]?.album || 'Album' : value;
  const visibleTracks = filterListTracks(tracks);
  state.selectedTracks = tracks;
  const totalDuration = tracks.reduce((sum, track) => sum + Number(track.duration || 0), 0);
  const art = getArtworkForTrack(tracks.find((track) => getArtworkForTrack(track)) || tracks[0]);
  const kind = type === 'artist' ? 'Artist' : 'Album';
  const currentIsInCollection = Boolean(state.currentTrack && tracks.some((track) => track.id === state.currentTrack.id));
  const isPlaying = currentIsInCollection && !audio.paused;
  container.innerHTML = `<div class="content-view entity-view" data-entity-type="${type}" data-entity-value="${escapeHtml(value)}">
    <div class="content-hero entity-hero">
      <div class="hero-art">${artMarkup(art, label, 'placeholder-art')}</div>
      <div class="hero-info"><span class="eyebrow">${kind.toUpperCase()}</span><h2 title="${escapeHtml(label)}">${escapeHtml(label)}</h2>
        <p class="hero-subtitle">${type === 'artist' ? `${tracks.length} songs in your library` : `Album from ${escapeHtml(tracks[0]?.albumArtist || tracks[0]?.artist || 'your library')}`}</p>
        <div class="hero-metadata"><span>${tracks.length} songs</span><span>•</span><span>${formatTime(totalDuration)}</span></div>
        <div class="hero-actions"><button class="play-button" data-action="${currentIsInCollection ? 'toggle-play' : 'play-selected'}" aria-label="${isPlaying ? 'Pause' : 'Play'} ${escapeHtml(label)}">${iconMarkup(isPlaying ? 'pause' : 'play')}</button><button class="round-button${state.shuffle ? ' active' : ''}" data-action="shuffle-selected" aria-label="Toggle shuffle for ${escapeHtml(label)}" aria-pressed="${state.shuffle}">${iconMarkup('shuffle')}</button><button class="round-button" data-action="add-queue" aria-label="Add to queue">${iconMarkup('plus')}</button>${contextSearchMarkup(kind.toLowerCase())}</div>
      </div>
    </div>
    <div class="collection-tools">${selectionToolbarMarkup()}</div><div class="track-list"><div class="track-header"><span>#</span><span>Title</span><span>Artist</span><span>Album</span><span>◷</span></div><div class="track-virtual-body">${visibleTracks.length ? '' : `<div class="empty-state"><div class="empty-state-card"><h2>No matching tracks</h2><p>Try another search inside this ${kind.toLowerCase()}.</p></div></div>`}</div></div>
  </div>`;
  mountTrackCollection(container, visibleTracks, `${type}:${value}`);
}

function uniqueByLabel(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item.label || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function searchEntityGroupMarkup(title, cards) {
  if (!cards.length) return '';
  return `<section class="search-rail-group"><h3>${escapeHtml(title)}</h3><div class="search-rail-strip">${cards.join('')}</div></section>`;
}

function renderSearchView(container) {
  const rawQuery = state.query.trim();
  const tokens = searchTokens(rawQuery);
  const allTracks = getAllTracks();
  // Token AND-match (not one substring) so "hensonn galaxy" finds Galaxy by Hensonn even
  // though title and artist live in different fields. Same matcher as the dropdown.
  const tracks = tokens.length ? allTracks.filter((track) => matchesTokens(trackSearchText(track), tokens)) : [];
  state.selectedTracks = tracks;
  const artists = uniqueByLabel(tracks.map((track) => ({ label: track.artist, track }))).slice(0, 8);
  const matchingAlbums = new Set(tracks.map(albumIdentity));
  const albums = getAlbumCollections().filter((album) => matchingAlbums.has(album.value))
    .slice(0, 8).map((album) => ({ label: album.name, track: album.tracks[0] }));
  const playlists = (state.library.folders || []).filter((folder) => matchesTokens(String(folder.name || '').toLowerCase(), tokens) || (folder.tracks || []).some((track) => matchesTokens(trackSearchText(track), tokens))).slice(0, 8);
  const top = tracks[0] || artists[0]?.track || albums[0]?.track;
  const resultCount = tracks.length + artists.length + albums.length + playlists.length;

  const artistCards = artists.map(({ label, track }) => `<button class="result-card artist-result" data-entity-type="artist" data-entity-value="${escapeHtml(label)}"><span class="result-card-art">${artMarkup(getArtworkForTrack(track), label, 'placeholder-art')}</span><strong>${escapeHtml(label)}</strong><span>Artist</span></button>`);
  const albumCards = albums.map(({ label, track }) => `<button class="result-card" data-entity-type="album" data-entity-value="${escapeHtml(albumIdentity(track))}"><span class="result-card-art">${artMarkup(getArtworkForTrack(track), label, 'placeholder-art')}</span><strong>${escapeHtml(label)}</strong><span>${escapeHtml(track.artist)}</span></button>`);
  const playlistCards = playlists.map((playlist) => `<button class="result-card" data-home-library-id="${escapeHtml(playlist.id)}"><span class="result-card-art">${artMarkup(playlist.artworkUrl || getArtworkForTrack(playlist.tracks?.[0]), playlist.name, 'placeholder-art')}</span><strong>${escapeHtml(playlist.name)}</strong><span>${playlist.tracks?.length || 0} songs</span></button>`);
  // Top result, artists, albums and playlists share one horizontally scrolling band so
  // every kind of match is visible before the song list, instead of stacked rails that
  // pushed playlists a full screen below the fold.
  const rails = [
    searchEntityGroupMarkup('Artists', artistCards),
    searchEntityGroupMarkup('Albums', albumCards),
    searchEntityGroupMarkup('Playlists', playlistCards)
  ].filter(Boolean).join('');

  const displayedTracks = state.searchShowAllSongs ? tracks : tracks.slice(0, 8);
  if (!displayedTracks.some((track) => track.id === state.focusedTrackId)) state.focusedTrackId = displayedTracks[0]?.id || '';
  container.innerHTML = `<div class="global-results-view">
    <div class="search-results-heading"><span class="eyebrow">SEARCH</span><h2>${rawQuery ? `Results for “${escapeHtml(rawQuery)}”` : 'Search your library'}</h2><p>${rawQuery ? `${resultCount} matching results` : 'Find songs, artists, albums and playlists.'}</p></div>
    ${rawQuery && resultCount ? `<div class="search-top-row">
      ${top ? `<section class="top-result-section"><h3>Top result</h3><button class="top-result-card" data-action="play-track" data-track-id="${escapeHtml(top.id)}"><span class="top-result-art">${artMarkup(getArtworkForTrack(top), top.title, 'placeholder-art')}</span><strong>${escapeHtml(top.title)}</strong><span>${escapeHtml(top.artist)} · Song</span><b>SONG</b></button></section>` : ''}
      ${rails ? `<div class="search-rail-scroller">${rails}</div>` : ''}
    </div>
    ${tracks.length ? `<section class="search-songs-section"><div class="search-songs-header"><h3>Songs</h3>${tracks.length > 8 ? `<button class="secondary-button compact" data-action="toggle-search-all-songs">${state.searchShowAllSongs ? 'Show less' : `Show all (${tracks.length})`}</button>` : ''}</div><div class="search-song-list track-list"><div class="track-header"><span>#</span><span>Title</span><span>Artist</span><span>Album</span><span>◷</span></div><div class="track-virtual-body"></div></div></section>` : ''}` : rawQuery ? `<div class="search-empty"><span>${iconMarkup('search')}</span><h3>No results found</h3><p>Try another song, artist, album or playlist name.</p></div>` : ''}
  </div>`;
  if (displayedTracks.length) mountTrackCollection(container, displayedTracks, 'search');
}

function searchTokens(query) {
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesTokens(text, tokens) {
  return tokens.length > 0 && tokens.every((token) => text.includes(token));
}

function trackSearchText(track) {
  return track._searchText ?? `${track.title || ''}\n${track.artist || ''}\n${track.album || ''}`.toLowerCase();
}

// Lower is better: exact name > prefix > word-start > anywhere > matched only via other fields.
function suggestNameRank(name, query) {
  const text = String(name || '').toLowerCase();
  if (text === query) return 0;
  if (text.startsWith(query)) return 1;
  const at = text.indexOf(query);
  if (at > 0 && /[\s_\-([.]/.test(text[at - 1])) return 2;
  return at >= 0 ? 3 : 4;
}

const SUGGEST_KIND_ORDER = { track: 0, artist: 1, album: 2, playlist: 3 };

function getSearchSuggestions(rawQuery, limit = 8) {
  const tokens = searchTokens(rawQuery);
  if (!tokens.length) return [];
  const query = tokens.join(' ');
  const results = [];
  const artists = new Map();
  for (const track of getAllTracks()) {
    if (matchesTokens(trackSearchText(track), tokens)) results.push({ kind: 'track', rank: suggestNameRank(track.title, query), track });
    // Artists only exist on tracks, so collect them in the same pass instead of a second full-library scan.
    const artist = String(track.artist || '').trim();
    const key = artist.toLowerCase();
    if (artist && !artists.has(key) && matchesTokens(key, tokens)) artists.set(key, { kind: 'artist', rank: suggestNameRank(artist, query), label: artist, track });
  }
  results.push(...artists.values());
  for (const album of getAlbumCollections()) {
    if (matchesTokens(album.name.toLowerCase(), tokens)) results.push({ kind: 'album', rank: suggestNameRank(album.name, query), album });
  }
  for (const playlist of state.library.folders || []) {
    if (matchesTokens(String(playlist.name || '').toLowerCase(), tokens)) results.push({ kind: 'playlist', rank: suggestNameRank(playlist.name, query), playlist });
  }
  // Array#sort is stable, so equal ranks keep library order within each kind.
  return results.sort((a, b) => a.rank - b.rank || SUGGEST_KIND_ORDER[a.kind] - SUGGEST_KIND_ORDER[b.kind]).slice(0, limit);
}

function searchSuggestItemMarkup(item, index) {
  const wrap = (main, side = '') => `<div class="search-suggest-item" role="option" id="searchSuggest-${index}" aria-selected="false" data-suggest-index="${index}">${main}${side}</div>`;
  const body = (art, title, meta, round = false) => `<span class="search-suggest-art${round ? ' round' : ''}">${art}</span><span class="search-suggest-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></span>`;
  // Main buttons reuse the attributes the document-level click delegate already handles
  // (data-action / data-entity-type / data-home-library-id), so no new routing exists.
  if (item.kind === 'track') {
    const { track } = item;
    return wrap(
      `<button type="button" class="search-suggest-main" tabindex="-1" data-action="play-track" data-track-id="${escapeHtml(track.id)}">${body(artMarkup(getArtworkForTrack(track), track.title, 'placeholder-art'), track.title, `Song • ${track.artist || 'Unknown artist'}`)}</button>`,
      `<button type="button" class="search-suggest-side" tabindex="-1" data-action="add-track-queue" data-track-id="${escapeHtml(track.id)}" aria-label="Add ${escapeHtml(track.title)} to queue" title="Add to queue">${iconMarkup('plus')}</button>`
    );
  }
  if (item.kind === 'artist') {
    return wrap(`<button type="button" class="search-suggest-main" tabindex="-1" data-entity-type="artist" data-entity-value="${escapeHtml(item.label)}">${body(artMarkup(getArtworkForTrack(item.track), item.label, 'placeholder-art'), item.label, 'Artist', true)}</button>`);
  }
  if (item.kind === 'album') {
    const { album } = item;
    return wrap(`<button type="button" class="search-suggest-main" tabindex="-1" data-entity-type="album" data-entity-value="${escapeHtml(album.value)}">${body(artMarkup(album.artworkUrl || getArtworkForTrack(album.tracks[0]), album.name, 'placeholder-art'), album.name, album.description ? `Album • ${album.description}` : 'Album')}</button>`);
  }
  const { playlist } = item;
  const count = playlist.tracks?.length || 0;
  return wrap(`<button type="button" class="search-suggest-main" tabindex="-1" data-home-library-id="${escapeHtml(playlist.id)}">${body(artMarkup(playlist.artworkUrl || getArtworkForTrack(playlist.tracks?.[0]), playlist.name, 'placeholder-art'), playlist.name, `Playlist • ${count} ${count === 1 ? 'song' : 'songs'}`)}</button>`);
}

function renderSearchSuggest(rawQuery) {
  const panel = document.getElementById('searchSuggest');
  const input = document.getElementById('globalSearch');
  if (!panel || !input) return;
  const query = String(rawQuery || '').trim();
  if (!query) return closeSearchSuggest();
  const items = getSearchSuggestions(query);
  searchSuggestIndex = -1;
  // "See all" is a real option so the arrow keys can reach it and Enter on it commits.
  panel.innerHTML = `${items.length ? items.map(searchSuggestItemMarkup).join('') : `<div class="search-suggest-empty">No matches for “${escapeHtml(query)}”</div>`}<div class="search-suggest-item search-suggest-all" role="option" id="searchSuggest-${items.length}" aria-selected="false" data-suggest-index="${items.length}"><button type="button" class="search-suggest-main" tabindex="-1" data-action="commit-search">${iconMarkup('search')}<span>See all results for “${escapeHtml(query)}”</span></button></div>`;
  panel.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.removeAttribute('aria-activedescendant');
}

function closeSearchSuggest() {
  const panel = document.getElementById('searchSuggest');
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  searchSuggestIndex = -1;
  const input = document.getElementById('globalSearch');
  input?.setAttribute('aria-expanded', 'false');
  input?.removeAttribute('aria-activedescendant');
}

function moveSearchSuggest(step) {
  const items = [...document.querySelectorAll('#searchSuggest .search-suggest-item')];
  if (!items.length) return;
  // Combobox pattern: focus never leaves the input, only the highlighted option moves,
  // so the user can keep typing mid-navigation.
  searchSuggestIndex = searchSuggestIndex < 0 && step < 0 ? items.length - 1 : (searchSuggestIndex + step + items.length) % items.length;
  items.forEach((item, index) => item.setAttribute('aria-selected', String(index === searchSuggestIndex)));
  const active = items[searchSuggestIndex];
  active.scrollIntoView({ block: 'nearest' });
  document.getElementById('globalSearch').setAttribute('aria-activedescendant', active.id);
}

// Enter (or "See all") commits the query to the full results page.
function commitSearch(rawQuery) {
  const query = String(rawQuery || '').trim();
  closeSearchSuggest();
  if (!query) return;
  if (state.view?.type === 'search') {
    // Already on results: rewrite this history entry instead of stacking one per Enter.
    state.searchShowAllSongs = false;
    state.query = query;
    state.view.query = query;
    state.navigationHistory[state.navigationIndex] = { ...state.view };
    renderContent();
    updateNavigationControls();
  } else {
    navigateTo({ type: 'search', query });
  }
}

function renderContent() {
  trackListResizeObserver?.disconnect();
  const container = document.getElementById('contentView');
  if (state.view?.type === 'search') {
    renderSearchView(container);
    return;
  }
  if (state.view?.type === 'artist' || state.view?.type === 'album') {
    renderEntityView(container, state.view.type, state.view.value);
    return;
  }
  if (state.homeActive && state.library.ok) {
    state.selectedTracks = getSelectedItem()?.tracks || state.selectedTracks;
    renderHomeView(container);
    return;
  }
  if (state.scanning && !state.library.ok) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-card scan-empty-card"><h2>Scanning your music folder</h2><p>Lyra is actively reading your folders, audio metadata, and artwork.</p>${scanProgressMarkup(false)}</div></div>`;
    return;
  }
  if (!state.settings.libraryPath) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-card"><h2>Choose your music folder</h2><p>Each folder with audio becomes a playlist. Tracks placed directly in the root are collected in Liked Songs.</p><button class="primary-button" data-action="choose-library">Choose music folder</button></div></div>`;
    return;
  }
  if (!state.library.ok) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-card"><h2>Folder could not be scanned</h2><p>${escapeHtml(scanErrorMessage(state.library.error))}</p><button class="primary-button" data-action="choose-library">Choose another folder</button></div></div>`;
    return;
  }
  if (!state.library.trackCount && !state.library.folders?.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-card"><h2>No supported audio found</h2><p>This folder is saved, but Lyra did not find supported audio files in it or its subfolders.</p><button class="secondary-button" data-action="scan">Rescan folder</button></div></div>`;
    return;
  }
  const item = getSelectedItem();
  if (!item) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-card"><h2>Choose your music folder</h2><p>Every folder with audio becomes a playlist. Tracks placed directly in the root are collected in Liked Songs.</p><button class="primary-button" data-action="choose-library">Choose music folder</button></div></div>`;
    return;
  }

  const previousTrackList = container.querySelector('.track-list');
  const previousListId = container.querySelector('.content-view')?.dataset.libraryId || '';
  const previousScrollTop = previousTrackList?.scrollTop || 0;
  state.selectedTracks = [...(item.tracks || [])];
  const totalDuration = state.selectedTracks.reduce((sum, track) => sum + (track.duration || 0), 0);
  const currentIsInSelectedPlaylist = Boolean(state.currentTrack && state.selectedTracks.some((track) => track.id === state.currentTrack.id));
  const playlistIsPlaying = currentIsInSelectedPlaylist && !audio.paused;
  const playlistPlayAction = currentIsInSelectedPlaylist ? 'toggle-play' : 'play-selected';
  const coverUrl = item.artworkUrl || getArtworkForTrack(state.selectedTracks[0]);
  const subtitle = item.isLiked ? 'Songs in your root folder and songs you liked' : item.description;
  const tracks = filterListTracks(state.selectedTracks);
  container.innerHTML = `
          <div class="content-view" data-library-id="${escapeHtml(item.id)}">

      <div class="content-hero">
        <div class="hero-art">
          ${artMarkup(coverUrl, item.name, 'placeholder-art')}
          ${!item.isLiked ? `<button class="hero-art-edit" data-action="edit-playlist" data-library-id="${escapeHtml(item.id)}" aria-label="Edit playlist" title="Edit playlist">${iconMarkup('edit')}</button>` : ''}
        </div>
        <div class="hero-info">
          <h2 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h2>
          ${subtitle ? `<p class="hero-subtitle">${escapeHtml(subtitle)}</p>` : ''}
          <div class="hero-metadata"><span>${state.selectedTracks.length} songs</span><span>•</span><span>${formatTime(totalDuration)}</span></div>
          <div class="hero-actions">
            <button class="play-button" data-action="${playlistPlayAction}" aria-label="${playlistIsPlaying ? 'Pause playlist' : 'Play playlist'}">${iconMarkup(playlistIsPlaying ? 'pause' : 'play')}</button>
            <button class="round-button${state.shuffle ? ' active' : ''}" data-action="shuffle-selected" aria-label="Toggle playlist shuffle" aria-pressed="${state.shuffle}">${iconMarkup('shuffle')}</button>
            <button class="round-button" data-action="add-queue" aria-label="Add playlist to queue">${iconMarkup('plus')}</button>
            ${contextSearchMarkup(item.isLiked ? 'liked songs' : 'playlist')}
          </div>
        </div>
        
      </div>
      <div class="collection-tools">${selectionToolbarMarkup()}</div>
      <div class="track-list" data-library-id="${escapeHtml(item.id)}">
        <div class="track-header"><span>#</span><span>Title</span><span>Artist</span><span>Album</span><span>◷</span></div>
        <div class="track-virtual-body">${tracks.length ? '' : `<div class="empty-state"><div class="empty-state-card"><h2>No tracks here yet</h2><p>Drop audio into this folder and rescan the library from settings.</p><button class="secondary-button" data-action="scan">Rescan library</button></div></div>`}</div>
      </div>
    </div>`;
  const nextTrackList = container.querySelector('.track-list');
  const virtualBody = nextTrackList?.querySelector('.track-virtual-body');
  if (virtualBody && tracks.length) virtualBody.style.minHeight = `${tracks.length * TRACK_ROW_HEIGHT}px`;
  if (nextTrackList && previousListId === item.id) nextTrackList.scrollTop = previousScrollTop;
  if (nextTrackList && tracks.length) setupVirtualTrackList(nextTrackList, tracks);
}

function setupVirtualTrackList(trackList, tracks) {
  trackList._virtualTracks = tracks;
  if (!tracks.some((track) => track.id === state.focusedTrackId)) state.focusedTrackId = tracks[0]?.id || '';
  trackList._virtualFrame = 0;
  trackList._virtualStart = null;
  trackList._renderVirtualRows = () => renderVirtualTrackRows(trackList);
  trackList.addEventListener('scroll', trackList._renderVirtualRows, { passive: true });
  trackListResizeObserver?.disconnect();
  trackListResizeObserver = new ResizeObserver(() => {
    trackList._virtualStart = null;
    renderVirtualTrackRows(trackList);
  });
  trackListResizeObserver.observe(trackList);
  syncInk();
  renderVirtualTrackRows(trackList);
}

function renderVirtualTrackRows(trackList) {
  if (!trackList?.isConnected) return;
  const tracks = trackList._virtualTracks || [];
  if (!tracks.length) return;
  if (trackList._virtualFrame) return;
  trackList._virtualFrame = requestAnimationFrame(() => {
    trackList._virtualFrame = 0;
    const body = trackList.querySelector('.track-virtual-body');
    if (!body) return;
    const headerHeight = trackList.querySelector('.track-header')?.getBoundingClientRect().height || 46;
    const viewportTop = Math.max(0, trackList.scrollTop - headerHeight);
    const viewportHeight = Math.max(1, trackList.clientHeight - headerHeight);
    const start = Math.max(0, Math.floor(viewportTop / TRACK_ROW_HEIGHT) - TRACK_VIRTUAL_OVERSCAN);
    if (trackList._virtualStart === start && body.children.length > 0) return;
    trackList._virtualStart = start;
    const visibleCount = Math.ceil(viewportHeight / TRACK_ROW_HEIGHT) + TRACK_VIRTUAL_OVERSCAN * 2;
    const end = Math.min(tracks.length, start + visibleCount);
    if (!tracks.slice(start, end).some((track) => track.id === state.focusedTrackId)) {
      state.focusedTrackId = tracks[Math.min(tracks.length - 1, Math.floor(viewportTop / TRACK_ROW_HEIGHT))]?.id || '';
    }
    const top = start * TRACK_ROW_HEIGHT;
    const bottom = Math.max(0, (tracks.length - end) * TRACK_ROW_HEIGHT);
    body.innerHTML = `<div class="track-virtual-spacer" aria-hidden="true" style="height:${top}px"></div>${tracks.slice(start, end).map((track, offset) => renderTrackRow(track, start + offset)).join('')}<div class="track-virtual-spacer" aria-hidden="true" style="height:${bottom}px"></div>`;
  });
}

function updateTrackRowStates() {
  const currentId = state.currentTrack?.id || '';
  const ids = [...new Set([lastCurrentRowId, currentId].filter(Boolean))];
  // querySelectorAll: the same track id can be rendered more than once (e.g. duplicate
  // library entries), and querySelector would leave the second row stale.
  for (const row of ids.flatMap((id) => [...document.querySelectorAll(`#contentView .track-row[data-track-id="${CSS.escape(id)}"]`)])) {
    const id = row.dataset.trackId;
    const isCurrent = row.dataset.trackId === currentId;
    row.classList.toggle('current', isCurrent);
    const number = row.querySelector('.track-number');
    if (number) number.innerHTML = trackNumberMarkup({ id }, Number(row.dataset.trackIndex) - 1);
  }
  lastCurrentRowId = currentId;
}

function updateContentPlayControl() {
  const content = document.getElementById('contentView');
  const currentIsInSelectedPlaylist = Boolean(state.currentTrack && state.selectedTracks.some((track) => track.id === state.currentTrack.id));
  const button = content.querySelector('.hero-actions [data-action="play-selected"], .hero-actions [data-action="toggle-play"]');
  if (!button) return;
  const isPlaying = currentIsInSelectedPlaylist && !audio.paused;
  button.dataset.action = currentIsInSelectedPlaylist ? 'toggle-play' : 'play-selected';
  button.setAttribute('aria-label', isPlaying ? 'Pause playlist' : 'Play playlist');
  button.innerHTML = iconMarkup(isPlaying ? 'pause' : 'play');
}

function updateDockPlaybackControl() {
  const button = document.querySelector('#playerDock [data-action="toggle-play"]');
  if (!button) return;
  button.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  button.innerHTML = iconMarkup(audio.paused ? 'play' : 'pause');
}

function updatePlaybackModeControls() {
  document.querySelectorAll('[data-action="shuffle"]').forEach((button) => {
    button.classList.toggle('active', state.shuffle);
    button.setAttribute('aria-pressed', String(state.shuffle));
  });
  document.querySelectorAll('[data-action="repeat"]').forEach((button) => {
    const active = state.repeatMode !== 'off';
    button.classList.toggle('active', active);
    button.classList.toggle('repeat-one', state.repeatMode === 'one');
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', state.repeatMode === 'one' ? 'Repeat one' : state.repeatMode === 'all' ? 'Repeat all' : 'Repeat off');
    button.title = state.repeatMode === 'one' ? 'Repeat one' : state.repeatMode === 'all' ? 'Repeat all' : 'Repeat off';
  });
}

function updateSeekUi() {
  if (state.isScrubbing) return;
  const duration = Number(audio.duration || state.currentTrack?.duration || 0);
  const current = Number(audio.currentTime || 0);
  const value = String(Math.min(current, duration || current));
  const progress = `${duration ? (current / duration) * 100 : 0}%`;

  const seeks = [document.getElementById('seekRange'), document.getElementById('fullscreenSeekRange')].filter(Boolean);
  seeks.forEach((seek) => {
    if (seek.max !== String(duration || 100)) seek.max = String(duration || 100);
    if (seek.value !== value) seek.value = value;
    if (seek.style.getPropertyValue('--progress') !== progress) seek.style.setProperty('--progress', progress);
    const seekWrap = seek.closest('.fullscreen-seek-wrap');
    if (seekWrap && seekWrap.style.getPropertyValue('--progress') !== progress) seekWrap.style.setProperty('--progress', progress);
    const labels = seek.closest('.fullscreen-seek, .seek-row')?.querySelectorAll(':scope > span');
    if (labels?.length >= 2) {
      const currentLabel = formatTime(current);
      const durationLabel = state.currentTrack?.durationLabel || formatTime(duration);
      if (labels[0].textContent !== currentLabel) labels[0].textContent = currentLabel;
      if (labels[1].textContent !== durationLabel) labels[1].textContent = durationLabel;
    }
  });
}

function queueSeekUi() {
  if (seekUiFrame) return;
  seekUiFrame = requestAnimationFrame(() => {
    seekUiFrame = 0;
    updateSeekUi();
  });
}

function updatePlaybackUi({ trackChanged = false } = {}) {
  const playbackKey = `${state.currentTrack?.id || ''}:${audio.paused ? 'paused' : 'playing'}`;
  if (!trackChanged && playbackKey === lastPlaybackUiKey) return;
  lastPlaybackUiKey = playbackKey;
  if (trackChanged) {
    renderQueuePanel();
    renderNowPlaying();
    renderPlayerDock();
    updateSeekUi();
  }
  updateTrackRowStates();
  updateContentPlayControl();
  updateDockPlaybackControl();
  if (state.fullscreenView) {
    if (trackChanged) renderFullscreenPlayer();
    else {
      const button = document.querySelector('#fullscreenPlayer [data-action="toggle-play"]');
      if (button) {
        button.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
        button.innerHTML = iconMarkup(audio.paused ? 'play' : 'pause');
      }
      updateSeekUi();
    }
  }
}

// A bar equalizer reads as "this is the one that is playing" far faster than a glyph,
// and it is pure CSS so recycled virtual rows cost nothing extra to animate.
const EQUALIZER_MARKUP = '<span class="playing-equalizer" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
const EQUALIZER_PAUSED_MARKUP = '<span class="playing-equalizer is-paused" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';

function trackNumberMarkup(track, index) {
  if (state.currentTrack?.id !== track.id) return String(index + 1);
  // Paused = the same bars, frozen. The old literal "II" was the *pause* glyph, which
  // everywhere else (dock, hero, fullscreen) means "playing — click to pause", so a
  // paused row contradicted the ▶ in the dock.
  return audio.paused ? EQUALIZER_PAUSED_MARKUP : EQUALIZER_MARKUP;
}

function renderTrackRow(track, index) {
  const isCurrent = state.currentTrack?.id === track.id;
  const isSelected = state.selectedTrackIds.has(track.id);
  const art = getArtworkForTrack(track);
  return `<div class="track-row ${isCurrent ? 'current' : ''}${isSelected ? ' selected' : ''}" data-track-id="${escapeHtml(track.id)}" data-track-index="${index + 1}" role="button" tabindex="${track.id === state.focusedTrackId || (!state.focusedTrackId && index === 0) ? 0 : -1}" draggable="true" aria-selected="${isSelected}" aria-label="Play ${escapeHtml(track.title)}">
    <span class="track-number">${trackNumberMarkup(track, index)}</span>
    <span class="track-main"><span class="track-art">${artMarkup(art, track.title, 'placeholder-art')}</span><span class="track-title-wrap"><strong class="track-title">${escapeHtml(track.title)}</strong></span></span>
    <button type="button" class="track-cell entity-link" data-entity-type="artist" data-entity-value="${escapeHtml(track.artist)}" aria-label="Open artist ${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</button>
    <button type="button" class="track-cell entity-link" data-entity-type="album" data-entity-value="${escapeHtml(albumIdentity(track))}" aria-label="Open album ${escapeHtml(track.album)}">${escapeHtml(track.album)}</button>
    <span class="track-duration"><span>${escapeHtml(track.durationLabel || formatTime(track.duration))}</span><button type="button" class="track-queue-button" data-action="add-track-queue" data-track-id="${escapeHtml(track.id)}" aria-label="Add ${escapeHtml(track.title)} to queue" title="Add to queue">${iconMarkup('plus')}</button></span>
  </div>`;
}

function creditsDetailMarkup(track) {
  const extension = String(track.path || '').match(/[.][^.\\/]+$/)?.[0]?.slice(1).toUpperCase() || '';
  const rows = [
    ['Album artist', track.albumArtist || ''],
    ['Year', track.year ? String(track.year) : ''],
    ['Genre', track.genre || ''],
    ['Track', track.trackNo ? String(track.trackNo) : ''],
    ['Length', track.durationLabel || formatTime(track.duration)],
    ['Format', extension],
    ['Folder', getPathLabel(track.folderPath)],
    ['Comment', track.comment || '']
  ].filter(([, value]) => value);
  return rows.map(([label, value]) => `<div class="credit-line"><span>${escapeHtml(label)}</span><span class="credit-value">${escapeHtml(value)}</span></div>`).join('');
}

function renderNowPlaying() {
  const panel = document.getElementById('nowPlayingPanel');
  const track = state.currentTrack;
  if (!track) {
    panel.innerHTML = `<div class="empty-state"><div class="empty-state-card"><span class="empty-state-icon">${iconMarkup('music')}</span><span class="eyebrow">NOW PLAYING</span><h2>Nothing playing</h2><p>Select a track from your library to start playback and build a queue.</p></div></div>`;
    return;
  }
  const art = getArtworkForTrack(track);
  panel.innerHTML = `
    <div class="now-heading"><h2>Playing now</h2></div>
    <div class="now-art-slot"><div class="now-art">${artMarkup(art, track.title, 'placeholder-art')}</div></div>
    <div class="now-title-row"><div><h2>${escapeHtml(track.title)}</h2><button class="text-entity-link" data-entity-type="artist" data-entity-value="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</button></div></div>
    <div class="info-card"><div class="card-heading"><strong>Credits</strong><button type="button" class="text-entity-link" data-action="toggle-credits" aria-expanded="${state.creditsExpanded}">${state.creditsExpanded ? 'Show less' : 'Show all'}</button></div><div class="credit-line"><span>Artist</span><button class="text-entity-link strong" data-entity-type="artist" data-entity-value="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</button></div><div class="credit-line"><span>Album</span><button class="text-entity-link strong" data-entity-type="album" data-entity-value="${escapeHtml(albumIdentity(track))}">${escapeHtml(track.album)}</button></div>${state.creditsExpanded ? creditsDetailMarkup(track) : ''}</div>
    ${renderPlaylistContextCard(track)}
    <div class="queue-card"><button type="button" class="card-heading queue-heading-button" data-action="queue" aria-label="Open queue"><strong>Up next</strong><span>${state.queue.length ? `${state.queue.length} queued` : 'Open queue'}</span></button>${renderQueueItem()}</div>`;
}

// The playlist is derived from the track's folder (a folder *is* a playlist; root files are
// Liked Songs), not from what was clicked, so it stays right after queue jumps, restores and
// rescans without another piece of playback state to keep in sync.
function renderPlaylistContextCard(track) {
  const context = findTrackContext(track.id);
  if (!context) return '';
  const isLiked = context.libraryId === 'liked';
  const folder = isLiked ? null : getFolderById(context.libraryId);
  const name = isLiked ? 'Liked Songs' : folder?.name || getPathLabel(track.folderPath);
  const tracks = context.queue || [];
  const position = tracks.findIndex((candidate) => candidate.id === track.id) + 1;
  const artworkUrl = (isLiked ? state.library.likedSongsArtworkUrl : folder?.artworkUrl) || '';
  const art = artMarkup(artworkUrl || getArtworkForTrack(tracks[0]), name, 'placeholder-art', artworkUrl ? getArtworkForTrack(tracks[0]) : '');
  const count = `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}`;
  return `<div class="queue-card playlist-context-card"><button type="button" class="card-heading queue-heading-button" data-action="open-playlist" data-library-id="${escapeHtml(context.libraryId)}" aria-label="Open ${escapeHtml(name)}"><strong>In playlist</strong><span>Open playlist</span></button><button type="button" class="queue-item queue-item-button" data-action="open-playlist" data-library-id="${escapeHtml(context.libraryId)}" aria-label="Open ${escapeHtml(name)}"><span class="queue-art">${art}</span><span class="queue-copy"><strong>${escapeHtml(name)}</strong><span>${position > 0 ? `Song ${position} of ${count}` : count}</span></span></button></div>`;
}

function renderQueueItem() {
  const next = getNextTrack();
  if (!next) return `<span class="muted">Your queue is empty.</span>`;
  const art = getArtworkForTrack(next);
  return `<button type="button" class="queue-item queue-item-button" data-action="play-next" data-track-id="${escapeHtml(next.id)}" aria-label="Play ${escapeHtml(next.title)}"><span class="queue-art">${artMarkup(art, next.title, 'placeholder-art')}</span><span class="queue-copy"><strong>${escapeHtml(next.title)}</strong><span>${escapeHtml(next.artist)}</span></span><span class="queue-time">${escapeHtml(next.durationLabel || formatTime(next.duration))}</span></button>`;
}

function renderQueuePanel() {
  const list = document.getElementById('queueList');
  const summary = document.getElementById('queueSummary');
  if (!list || !summary || document.getElementById('queuePanel')?.classList?.contains('hidden')) return;
  const history = [...new Set([...state.playbackHistory].reverse())].map((id) => tracksById.get(id)).filter(Boolean);
  const showingHistory = state.queueView === 'history';
  const tracks = showingHistory ? history : state.queue;
  document.querySelectorAll('[data-action="queue-tab"]').forEach((button) => {
    const active = button.dataset.queueView === state.queueView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelector('[data-action="clear-queue"]')?.classList.toggle('hidden', showingHistory);
  document.querySelector('[data-action="export-queue"]')?.classList.toggle('hidden', showingHistory);
  summary.textContent = showingHistory ? `${history.length} recently played.` : (state.queue.length ? `${state.queue.length} track${state.queue.length === 1 ? '' : 's'} queued.` : 'No tracks queued.');
  if (list._queueView !== state.queueView) list.scrollTop = 0;
  list._queueView = state.queueView;
  let previousWindow = '';
  const renderRows = () => {
    const rowHeight = 52;
    const height = list.clientHeight || 340;
    const maxScroll = Math.max(0, tracks.length * rowHeight - height);
    if (list.scrollTop > maxScroll) list.scrollTop = maxScroll;
    const start = Math.max(0, Math.floor((list.scrollTop || 0) / rowHeight) - 4);
    const end = Math.min(tracks.length, start + Math.ceil(height / rowHeight) + 8);
    const key = `${start}:${end}`;
    if (key === previousWindow) return;
    previousWindow = key;
    list.innerHTML = tracks.length
      ? `<div aria-hidden="true" style="height:${start * rowHeight}px"></div>` + tracks.slice(start, end).map((track, offset) => {
    const index = start + offset;
    const art = getArtworkForTrack(track);
    return `<div class="queue-list-item" data-track-id="${escapeHtml(track.id)}" draggable="${!showingHistory}"><span class="queue-position">${index + 1}</span><span class="queue-art">${artMarkup(art, track.title, 'placeholder-art')}</span><button class="queue-list-copy" data-action="${showingHistory ? 'play-history' : 'play-queued'}" data-track-id="${escapeHtml(track.id)}"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></button><span class="queue-time">${escapeHtml(track.durationLabel || formatTime(track.duration))}</span>${showingHistory ? '<span></span>' : `<button class="icon-button small queue-remove" data-action="remove-queued" data-track-id="${escapeHtml(track.id)}" aria-label="Remove ${escapeHtml(track.title)} from queue">${iconMarkup('close')}</button>`}</div>`;
  }).join('') + `<div aria-hidden="true" style="height:${(tracks.length - end) * rowHeight}px"></div>`
      : `<div class="queue-empty"><span class="empty-state-icon">${iconMarkup('queue')}</span><h3>${showingHistory ? 'No listening history yet' : 'Your queue is empty'}</h3><p>${showingHistory ? 'Songs you play will appear here.' : 'Use the + button beside a song, or add a whole playlist.'}</p></div>`;
  };
  list.onscroll = renderRows;
  list._renderQueueRows = renderRows;
  renderRows();
}

// The queue is a popover pinned above the dock's queue button rather than a full-screen
// modal: it is a glance-and-go surface, and covering the whole app to read four rows
// meant losing sight of what was playing.
function positionQueuePanel() {
  const panel = document.getElementById('queuePanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const anchor = document.querySelector('#playerDock [data-action="queue"]');
  const rect = anchor?.getBoundingClientRect();
  const margin = 14;
  const width = panel.offsetWidth || 360;
  const anchorCenter = rect ? rect.left + rect.width / 2 : window.innerWidth - 120;
  const left = Math.max(margin, Math.min(anchorCenter - width / 2, window.innerWidth - width - margin));
  const bottom = rect ? Math.max(margin, window.innerHeight - rect.top + 12) : 120;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.bottom = `${Math.round(bottom)}px`;
  panel.style.maxHeight = `${Math.max(220, window.innerHeight - bottom - margin)}px`;
  document.getElementById('queueList')?._renderQueueRows?.();
  panel.style.setProperty('--arrow-x', `${Math.round(Math.min(Math.max(anchorCenter - left, 20), width - 20))}px`);
}

function isQueueOpen() {
  return !document.getElementById('queuePanel')?.classList.contains('hidden');
}

function openQueue() {
  const panel = document.getElementById('queuePanel');
  if (!panel) return;
  rememberModalFocus();
  panel.classList.remove('hidden');
  renderQueuePanel();
  positionQueuePanel();
  requestAnimationFrame(() => {
    positionQueuePanel();
    panel.classList.add('open');
    panel.querySelector('button')?.focus();
  });
}

function closeQueue() {
  const panel = document.getElementById('queuePanel');
  if (!panel || panel.classList.contains('hidden')) return;
  panel.classList.remove('open');
  panel.classList.add('hidden');
  // Only pull focus back when it was actually inside the popover; a click elsewhere in
  // the app has already put focus where the user wanted it.
  if (panel.contains(document.activeElement)) restoreModalFocus();
  else modalReturnFocus = null;
}

function toggleQueue() {
  if (isQueueOpen()) closeQueue();
  else openQueue();
}

function addTrackToQueue(track) {
  if (!track || track.id === state.currentTrack?.id || state.queue.some((item) => item.id === track.id)) return false;
  state.queue.push(track);
  renderNowPlaying();
  renderQueuePanel();
  persistPlaybackSession();
  return true;
}

function likeButtonMarkup(track) {
  const liked = isTrackLiked(track);
  // Root files are liked by *where they live*; the heart is shown filled but cannot unlike
  // them, because that would mean moving the user's file.
  const label = liked && isRootTrack(track) ? 'In your Liked Songs folder' : liked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
  return `<button type="button" class="dock-like-button${liked ? ' liked' : ''}" data-action="toggle-like" aria-pressed="${liked}" aria-label="${label}" title="${label}">${iconMarkup('heart')}</button>`;
}

function dockTrackMarkup(track) {
  return `<span class="dock-art">${artMarkup(getArtworkForTrack(track), track.title, 'placeholder-art')}</span><div class="dock-copy"><strong>${escapeHtml(track.title)}</strong><button class="text-entity-link" data-entity-type="artist" data-entity-value="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</button></div>${likeButtonMarkup(track)}`;
}

// Cheap targeted refresh: the heart in the dock, the sidebar count, and the Liked Songs or
// Home view when one is on screen. Everything else is unaffected by a like.
function refreshLikeViews() {
  const button = document.querySelector('#playerDock .dock-like-button');
  if (button && state.currentTrack) button.outerHTML = likeButtonMarkup(state.currentTrack);
  renderLibrary();
  if (state.homeActive || (state.view?.type === 'playlist' && state.selectedId === 'liked')) renderContent();
}

async function loadLikedReferences() {
  const rootPath = state.library.rootPath;
  if (!rootPath || likeWritesPending) return false;
  const paths = await window.spotfck.readLiked();
  // A library switch or a like issued while reading makes this answer stale.
  if (state.library.rootPath !== rootPath || likeWritesPending || !Array.isArray(paths)) return false;
  if (paths.join('\n') === likedReferencePaths.join('\n')) return false;
  setLikedReferences(paths);
  return true;
}

function toggleTrackLike(track = state.currentTrack) {
  if (!track?.path) return;
  if (isRootTrack(track)) return showToast('This song lives in your Liked Songs folder. Move the file out of the root to unlike it.');
  const key = trackPathKey(track.path);
  const liked = !likedReferenceKeys.has(key);
  const rootPath = state.library.rootPath;
  // Optimistic: the heart flips now, the write follows. Writes are chained so a fast
  // double-click lands on disk in click order instead of racing.
  setLikedReferences(liked ? [...likedReferencePaths, track.path] : likedReferencePaths.filter((path) => trackPathKey(path) !== key));
  refreshLikeViews();
  showToast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
  likeWritesPending += 1;
  likeWriteChain = likeWriteChain.then(async () => {
    try {
      const paths = await window.spotfck.setTrackLiked(track.path, liked);
      if (likeWritesPending === 1 && state.library.rootPath === rootPath) setLikedReferences(paths);
    } catch (error) {
      showToast(String(error?.message || error || 'Could not update Liked Songs'));
      // Disk is the source of truth; resync rather than guess which optimistic step failed.
      if (state.library.rootPath === rootPath) setLikedReferences(await window.spotfck.readLiked());
    } finally {
      likeWritesPending -= 1;
      refreshLikeViews();
    }
  });
  return likeWriteChain;
}

function persistLikedOrder(paths) {
  const keys = new Set(paths.map(trackPathKey));
  const next = [...paths, ...likedReferencePaths.filter((path) => !keys.has(trackPathKey(path)))];
  if (next.join('\n') === likedReferencePaths.join('\n')) return;
  setLikedReferences(next);
  likeWritesPending += 1;
  likeWriteChain = likeWriteChain.then(async () => {
    try {
      setLikedReferences(await window.spotfck.reorderLiked(paths));
    } catch (error) {
      showToast(String(error?.message || error || 'Could not save Liked Songs order'));
      setLikedReferences(await window.spotfck.readLiked());
    } finally {
      likeWritesPending -= 1;
      refreshLikeViews();
    }
  });
}

function renderPlayerDock() {
  const dock = document.getElementById('playerDock');
  const track = state.currentTrack;
  if (!track) {
    state.isScrubbing = false;
    dock.innerHTML = `<div class="dock-track"><div class="dock-copy"><strong>Lyra</strong><span>Select a track to begin playback</span></div></div><div class="dock-center"><div class="transport-controls"><button class="transport-button main disabled-control" disabled aria-label="No track selected">${iconMarkup('play')}</button></div><div class="seek-row"><span>0:00</span><input class="range" type="range" min="0" max="100" value="0" disabled /><span>0:00</span></div></div><div class="dock-actions"><button class="transport-button" data-action="queue" aria-label="Queue">${iconMarkup('queue')}</button><button class="transport-button" data-action="settings" aria-label="Settings">${iconMarkup('settings')}</button></div>`;
    return;
  }
  
  if (dock.children.length === 0 || dock.querySelector('.disabled-control')) {
    state.isScrubbing = false;
    const duration = Number(audio.duration || track.duration || 0);
    const current = Number(audio.currentTime || 0);
    const progress = duration ? Math.min(100, (current / duration) * 100) : 0;
    dock.innerHTML = `
      <div class="dock-track">${dockTrackMarkup(track)}</div>
      <div class="dock-center"><div class="transport-controls"><button class="transport-button${state.shuffle ? ' active' : ''}" data-action="shuffle" aria-label="Shuffle" aria-pressed="${state.shuffle}">${iconMarkup('shuffle')}</button><button class="transport-button" data-action="previous" aria-label="Previous">${iconMarkup('previous')}</button><button class="transport-button main" data-action="toggle-play" aria-label="Play or pause">${iconMarkup(audio.paused ? 'play' : 'pause')}</button><button class="transport-button" data-action="next" aria-label="Next">${iconMarkup('next')}</button><button class="transport-button${state.repeatMode !== 'off' ? ' active' : ''}${state.repeatMode === 'one' ? ' repeat-one' : ''}" data-action="repeat" aria-label="${state.repeatMode === 'one' ? 'Repeat one' : state.repeatMode === 'all' ? 'Repeat all' : 'Repeat off'}" aria-pressed="${state.repeatMode !== 'off'}">${iconMarkup('repeat')}</button></div><div class="seek-row"><span>${formatTime(current)}</span><input class="range" id="seekRange" type="range" min="0" max="${duration || 100}" step="0.1" value="${current}" style="--progress:${progress}%" /><span>${escapeHtml(track.durationLabel || formatTime(duration))}</span></div></div>
      <div class="dock-actions"><div class="volume-row"><button class="volume-icon" type="button" data-action="toggle-mute" aria-label="${audio.volume === 0 ? 'Unmute' : 'Mute'}" title="${audio.volume === 0 ? 'Unmute' : 'Mute'}">${iconMarkup(audio.volume === 0 ? 'volumeMute' : 'volume')}</button><div class="volume-control"><span class="volume-value" id="volumeValue" aria-live="polite"></span><input class="range" id="volumeRange" type="range" min="0" max="1" step="0.01" value="${audio.volume}" style="--progress:${audio.volume * 100}%" /></div></div><button class="transport-button" data-action="queue" aria-label="Queue">${iconMarkup('queue')}</button><button class="transport-button" data-action="settings" aria-label="Settings">${iconMarkup('settings')}</button><button class="transport-button" data-action="fullscreen" aria-label="Fullscreen">${iconMarkup('fullscreen')}</button></div>`;
    return;
  }

  const trackPanel = dock.querySelector('.dock-track');
  if (trackPanel) trackPanel.innerHTML = dockTrackMarkup(track);
  updateDockPlaybackControl();
  updatePlaybackModeControls();
  const durationSpans = dock.querySelectorAll('.seek-row span');
  if (durationSpans && durationSpans.length === 2) {
    const duration = Number(audio.duration || track.duration || 0);
    durationSpans[1].textContent = track.durationLabel || formatTime(duration);
  }
  updateSeekUi();
}

function getPlaybackCollection() {
  if (state.queue.length) return state.queue;
  return state.playbackList.length ? state.playbackList : state.selectedTracks;
}

function removeTrackFromQueue(trackId) {
  if (!trackId || !state.queue.length) return;
  state.queue = state.queue.filter((track) => track.id !== trackId);
  persistPlaybackSession();
}

function getNextTrack() {
  const forward = state.playbackForward?.at(-1);
  if (forward && tracksById.has(forward.id)) return tracksById.get(forward.id);
  if (state.queue.length) return state.queue[0];
  const collection = state.playbackList.length ? state.playbackList : state.selectedTracks;
  const anchor = state.playbackAnchorPath || state.currentTrack?.path;
  const index = collection.findIndex((track) => track.path === anchor);
  return collection[index + 1] || (state.repeatMode === 'all' ? collection[0] : null) || null;
}

function render() {
  seedNavigation();
  const shell = document.getElementById('appShell');
  shell?.classList.toggle('home-active', Boolean(state.homeActive));
  shell?.classList.toggle('fullscreen-view-active', Boolean(state.fullscreenView));
  renderLibrary();
  renderContent();
  renderNowPlaying();
  renderPlayerDock();
  renderFullscreenPlayer();
  renderSettingsValues();
  applyBackground();
  applyTheme();
  applyAccentColor();
  applyProfilePicture();
  syncInk();
  updateNavigationControls();
}

function renderFullscreenPlayer() {
  const overlay = document.getElementById('fullscreenPlayer');
  const content = document.getElementById('fullscreenPlayerContent');
  const backdrop = document.getElementById('fullscreenBackdropArt');
  if (!overlay || !content || !backdrop) return;
  overlay.classList.toggle('visible', Boolean(state.fullscreenView));
  overlay.setAttribute('aria-hidden', state.fullscreenView ? 'false' : 'true');
  backdrop.innerHTML = '';
  if (!state.fullscreenView) return;
  const track = state.currentTrack;
  if (!track) {
    content.innerHTML = `<div class="fullscreen-empty"><div class="fullscreen-empty-orbit">${iconMarkup('music')}</div><h2>Nothing playing</h2></div>`;
    return;
  }
  const art = getArtworkForTrack(track);
  const current = Number(audio.currentTime || 0);
  const duration = Number(audio.duration || track.duration || 0);
  const progress = duration ? Math.min(100, (current / duration) * 100) : 0;
  content.innerHTML = `
    <div class="fullscreen-main">
      <div class="fullscreen-art-wrap"><div class="fullscreen-art-shadow"></div><div class="fullscreen-art">${artMarkup(art, track.title, 'placeholder-art')}</div></div>
      <section class="fullscreen-info" aria-label="Track information">
        <div class="fullscreen-info-heading"><div class="fullscreen-copy"><h1 title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</h1><button class="fullscreen-entity-link artist" data-entity-type="artist" data-entity-value="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</button>${track.album ? `<button class="fullscreen-entity-link album" data-entity-type="album" data-entity-value="${escapeHtml(albumIdentity(track))}">${escapeHtml(track.album)}</button>` : ''}</div></div>
        <div class="fullscreen-controls">
          <div class="fullscreen-transport"><button class="fullscreen-transport-button${state.shuffle ? ' active' : ''}" type="button" data-action="shuffle" aria-label="Shuffle" aria-pressed="${state.shuffle}">${iconMarkup('shuffle')}</button><button class="fullscreen-transport-button" type="button" data-action="previous" aria-label="Previous">${iconMarkup('previous')}</button><button class="fullscreen-transport-button primary" type="button" data-action="toggle-play" aria-label="${audio.paused ? 'Play' : 'Pause'}">${iconMarkup(audio.paused ? 'play' : 'pause')}</button><button class="fullscreen-transport-button" type="button" data-action="next" aria-label="Next">${iconMarkup('next')}</button><button class="fullscreen-transport-button${state.repeatMode !== 'off' ? ' active' : ''}${state.repeatMode === 'one' ? ' repeat-one' : ''}" type="button" data-action="repeat" aria-label="${state.repeatMode === 'one' ? 'Repeat one' : state.repeatMode === 'all' ? 'Repeat all' : 'Repeat off'}" aria-pressed="${state.repeatMode !== 'off'}">${iconMarkup('repeat')}</button></div>
          <div class="fullscreen-seek"><span class="fullscreen-time">${formatTime(current)}</span><div class="fullscreen-seek-wrap" style="--progress:${progress}%"><input class="range fullscreen-range" id="fullscreenSeekRange" type="range" min="0" max="${duration || 100}" step="0.1" value="${current}" aria-label="Seek" /></div><span class="fullscreen-time">${escapeHtml(track.durationLabel || formatTime(duration))}</span></div>
        </div>
      </section>
    </div>`;
}

function revealFullscreenVolume() {
  if (!state.fullscreenView) return;
  fullscreenVolumeVisible = true;
  clearTimeout(fullscreenVolumeHideTimer);
  const row = document.querySelector('#fullscreenPlayer .fullscreen-volume-vertical');
  row?.classList.add('visible');
  fullscreenVolumeHideTimer = setTimeout(() => {
    fullscreenVolumeVisible = false;
    document.querySelector('#fullscreenPlayer .fullscreen-volume-vertical')?.classList.remove('visible');
  }, 1700);
}

function toggleMute() {
  if (audio.volume > 0) {
    volumeBeforeMute = audio.volume;
    setVolume(0, true);
  } else {
    setVolume(volumeBeforeMute > 0 ? volumeBeforeMute : 0.5, true);
  }
  if (state.fullscreenView) {
    renderFullscreenPlayer();
    revealFullscreenVolume();
  }
}

function setFullscreenView(enabled) {
  const next = Boolean(enabled);
  closeQueue();
  // The overlay only fills the window; the OS window must go fullscreen too or the taskbar
  // stays visible. Only on a real change, so re-renders don't spam the native call.
  if (next !== state.fullscreenView) window.spotfck.setFullscreen?.(next);
  state.fullscreenView = next;
  clearTimeout(fullscreenVolumeHideTimer);
  fullscreenVolumeVisible = false;
  document.getElementById('appShell')?.classList.toggle('fullscreen-view-active', next);
  document.body.classList.toggle('fullscreen-player-open', next);
  renderFullscreenPlayer();
  syncInk();
}


function toggleFullscreenView() {
  setFullscreenView(!state.fullscreenView);
}

function renderSettingsValues() {
  const settingsLibraryPath = document.getElementById('settingsLibraryPath');
  const libraryPath = String(state.settings.libraryPath || state.library.rootPath || '').trim();
  if (settingsLibraryPath) {
    settingsLibraryPath.textContent = libraryPath || 'No folder selected';
    settingsLibraryPath.title = libraryPath;
  }
  const revealLibraryButton = document.querySelector('[data-action="reveal-library"]');
  if (revealLibraryButton) revealLibraryButton.disabled = !libraryPath;

  const backgroundPath = String(state.settings.backgroundPath || '').trim();
  const settingsBackgroundPath = document.getElementById('settingsBackgroundPath');
  if (settingsBackgroundPath) {
    settingsBackgroundPath.textContent = backgroundPath || 'Use the selected theme background';
    settingsBackgroundPath.title = backgroundPath;
  }
  const removeBackgroundButton = document.getElementById('removeBackgroundButton');
  if (removeBackgroundButton) removeBackgroundButton.disabled = !backgroundPath;
  renderSurfaceControls();

  const inkToggle = document.getElementById('inkToggle');
  if (inkToggle) inkToggle.checked = Boolean(state.settings.showInk);
  const closeToTrayToggle = document.getElementById('closeToTrayToggle');
  if (closeToTrayToggle) closeToTrayToggle.checked = Boolean(state.settings.closeToTray);
  const volumeRange = document.getElementById('volumeRange');
  if (volumeRange) {
    volumeRange.value = audio.volume;
    volumeRange.style.setProperty('--progress', `${audio.volume * 100}%`);
  }
  updateVolumeReadout(false);
}

function applySidebarWidths() {
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  const left = Math.min(460, Math.max(220, Number(state.settings.leftSidebarWidth) || 280));
  const right = Math.min(460, Math.max(240, Number(state.settings.rightSidebarWidth) || 286));
  state.settings.leftSidebarWidth = left;
  state.settings.rightSidebarWidth = right;
  workspace.style.setProperty('--left-sidebar-width', `${left}px`);
  workspace.style.setProperty('--right-sidebar-width', `${right}px`);
}

function initSidebarResizers() {
  applySidebarWidths();
  document.querySelectorAll('[data-resize-sidebar]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const side = handle.dataset.resizeSidebar;
      const workspace = handle.closest('.workspace');
      const rect = workspace.getBoundingClientRect();
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-sidebar');
      const move = (moveEvent) => {
        const available = Math.max(0, rect.width - 520 - 24);
        const other = side === 'left' ? Number(state.settings.rightSidebarWidth) : Number(state.settings.leftSidebarWidth);
        const raw = side === 'left' ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX;
        const width = Math.min(460, Math.max(side === 'left' ? 220 : 240, Math.min(raw, available - other)));
        if (side === 'left') state.settings.leftSidebarWidth = width;
        else state.settings.rightSidebarWidth = width;
        applySidebarWidths();
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        document.body.classList.remove('resizing-sidebar');
        clearTimeout(sidebarSaveTimer);
        sidebarSaveTimer = setTimeout(() => persistSettings(), 80);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  });
}

function invalidatePlayback(clearSource = true) {
  cancelPlaybackErrorSkip();
  state.playbackAnchorPath = '';
  restoreSeek = null;
  playbackRequestId += 1;
  playbackTransitioning = true;
  try { audio.pause(); } catch {}
  if (clearSource) {
    audio.removeAttribute('src');
    try { audio.load(); } catch {}
  }
  state.currentTrack = null;
  state.queue = [];
  state.playbackList = [];
  state.basePlaybackList = [];
  state.playbackHistory = [];
  state.playbackHistoryContexts = [];
  state.playbackForward = [];
  lastPlaybackUiKey = '';
  lastCurrentRowId = '';
  playbackTransitioning = false;
}

function fisherYatesShuffle(items) {
  const array = [...items];
  for (let index = array.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [array[index], array[randomIndex]] = [array[randomIndex], array[index]];
  }
  return array;
}

function readPlaybackSession() {
  try { return JSON.parse(localStorage.getItem(PLAYBACK_SESSION_KEY) || 'null'); } catch { return null; }
}

function writePlaybackPosition() {
  if (!playbackSessionReady) return;
  try {
    localStorage.setItem(`${PLAYBACK_SESSION_KEY}-position`, JSON.stringify({
      currentPath: state.currentTrack?.path || '', position: Number(audio.currentTime || 0)
    }));
    lastPositionWrite = Date.now();
  } catch {}
}

function writePlaybackSessionNow() {
  if (!playbackSessionReady) return;
  writePlaybackPosition();
  if (!playbackSessionDirty) return;
  const base = state.basePlaybackList || [];
  const positions = new Map(base.map((track, index) => [track.id, index]));
  const payload = {
    currentPath: state.currentTrack?.path || '',
    playbackAnchorPath: state.playbackAnchorPath || '',
    position: Number(audio.currentTime || 0),
    queuePaths: state.queue.map((track) => track.path),
    basePlaybackPaths: base.map((track) => track.path),
    playbackOrder: state.playbackList.map((track) => positions.get(track.id)).filter(Number.isInteger),
    historyPaths: state.playbackHistory.map((id) => tracksById.get(id)?.path).filter(Boolean),
    historyContexts: (state.playbackHistoryContexts || []).map((entry) => ({
      path: tracksById.get(entry.id)?.path, anchorPath: entry.anchorPath, fromQueue: entry.fromQueue
    })).filter((entry) => entry.path),
    forwardContexts: (state.playbackForward || []).map((entry) => ({
      path: tracksById.get(entry.id)?.path, anchorPath: entry.anchorPath, fromQueue: entry.fromQueue
    })).filter((entry) => entry.path),
    currentFromQueue: Boolean(state.currentFromQueue),
    shuffle: state.shuffle, repeatMode: state.repeatMode, savedAt: Date.now()
  };
  try {
    localStorage.setItem(PLAYBACK_SESSION_KEY, JSON.stringify(payload));
    playbackSessionDirty = false;
  } catch {
    try {
      localStorage.setItem(PLAYBACK_SESSION_KEY, JSON.stringify({ ...payload, basePlaybackPaths: [], playbackOrder: [] }));
      playbackSessionDirty = false;
    } catch (error) {
      reportEvent('session.persist-failed', { error: error?.message || String(error) }, 'warn');
    }
  }
}

function persistPlaybackSession() {
  playbackSessionDirty = true;
  if (!playbackSessionReady || playbackSessionTimer) return;
  playbackSessionTimer = setTimeout(() => {
    playbackSessionTimer = null;
    writePlaybackSessionNow();
  }, 300);
}

function restorePlaybackSession() {
  const saved = readPlaybackSession();
  const byPath = tracksByPath;
  const remap = (paths) => (Array.isArray(paths) ? paths : []).map((item) => byPath.get(String(item || '').replaceAll('\\', '/').toLowerCase())).filter(Boolean);
  playbackSessionReady = true;
  if (!saved || !byPath.size) return false;
  state.shuffle = Boolean(saved.shuffle);
  state.repeatMode = ['off', 'all', 'one'].includes(saved.repeatMode) ? saved.repeatMode : 'off';
  state.queue = remap(saved.queuePaths);
  state.basePlaybackList = remap(saved.basePlaybackPaths);
  const originalBase = (saved.basePlaybackPaths || []).map((path) => byPath.get(String(path).replaceAll('\\', '/').toLowerCase()));
  state.playbackList = Array.isArray(saved.playbackOrder)
    ? saved.playbackOrder.filter(Number.isInteger).map((index) => originalBase[index]).filter(Boolean)
    : remap(saved.playbackPaths);
  state.playbackHistory = remap(saved.historyPaths).map((track) => track.id);
  const contexts = (entries) => (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    const track = remap([entry.path])[0];
    return track ? [{ id: track.id, anchorPath: remap([entry.anchorPath])[0]?.path || '', fromQueue: Boolean(entry.fromQueue) }] : [];
  });
  state.playbackHistoryContexts = contexts(saved.historyContexts);
  state.playbackForward = contexts(saved.forwardContexts);
  state.playbackAnchorPath = remap([saved.playbackAnchorPath || saved.currentPath])[0]?.path || '';
  const current = byPath.get(String(saved.currentPath || '').replaceAll('\\', '/').toLowerCase());
  if (current) {
    let position = saved.position;
    try {
      const checkpoint = JSON.parse(localStorage.getItem(`${PLAYBACK_SESSION_KEY}-position`) || 'null');
      if (checkpoint?.currentPath === current.path) position = checkpoint.position;
    } catch {}
    setCurrentTrack(current, false, null, { addHistory: false, fromQueue: Boolean(saved.currentFromQueue),
      anchorPath: state.playbackAnchorPath, resumePosition: position, preserveForward: true });
  }
  return Boolean(current || state.queue.length || state.playbackList.length);
}

function toggleShuffleMode() {
  state.shuffle = !state.shuffle;
  if (state.basePlaybackList?.length) {
    if (state.shuffle) {
      const shuffled = fisherYatesShuffle(state.basePlaybackList);
      const active = shuffled.find((track) => track.path === (state.playbackAnchorPath || state.currentTrack?.path));
      state.playbackList = active ? [active, ...shuffled.filter((track) => track.id !== active.id)] : shuffled;
    } else {
      state.playbackList = [...state.basePlaybackList];
    }
  }
  updatePlaybackModeControls();
  renderContent();
  showToast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
  persistPlaybackSession();
}

function setPlaybackList(tracks, { resetHistory = false, activeTrack = null } = {}) {
  if (tracks) {
    state.playbackAnchorPath = '';
    state.basePlaybackList = [...tracks];
    if (state.shuffle) {
      const shuffled = fisherYatesShuffle(state.basePlaybackList);
      const target = activeTrack || state.currentTrack;
      if (target && target !== 'ignore') {
        const active = shuffled.find((t) => t.id === target.id);
        const rest = shuffled.filter((t) => t.id !== target.id);
        state.playbackList = active ? [active, ...rest] : shuffled;
      } else {
        state.playbackList = shuffled;
      }
    } else {
      state.playbackList = [...state.basePlaybackList];
    }
  }
  if (resetHistory) {
    state.playbackHistory = [];
    state.playbackHistoryContexts = [];
    state.playbackForward = [];
  }
}

function setCurrentTrack(track, autoplay = false, playbackList = null, { addHistory = true, fromQueue = false, anchorPath = null, resumePosition = 0, preserveForward = false } = {}) {
  if (!track) return;
  cancelPlaybackErrorSkip();
  const previousTrackId = state.currentTrack?.id;
  const previousContext = { id: previousTrackId, anchorPath: state.playbackAnchorPath || '', fromQueue: Boolean(state.currentFromQueue) };
  const requestId = ++playbackRequestId;
  restoreSeek = Number.isFinite(Number(resumePosition)) && Number(resumePosition) > 0
    ? { requestId, path: track.path, position: Number(resumePosition) } : null;
  if (!preserveForward) state.playbackForward = [];

  if (playbackList) setPlaybackList(playbackList);
  state.currentTrack = track;
  state.currentFromQueue = fromQueue;
  if (anchorPath != null) state.playbackAnchorPath = anchorPath;
  else if (!fromQueue) state.playbackAnchorPath = track.path;
  updateMediaSession();
  reportEvent('playback.track-selected', { track: reportTrack(track), autoplay, collectionSize: Number(playbackList?.length || state.playbackList.length || state.selectedTracks.length || 0) });

  if (addHistory && previousTrackId && previousTrackId !== track.id) {
    state.playbackHistory.push(previousTrackId);
    (state.playbackHistoryContexts ||= []).push(previousContext);
    if (state.playbackHistory.length > 100) {
      state.playbackHistory.shift();
      state.playbackHistoryContexts.shift();
    }
  }

  playbackTransitioning = true;
  try { audio.pause(); } catch {}

  if (!track.url) {
    audio.removeAttribute('src');
    try { audio.load(); } catch {}
    playbackTransitioning = false;
    updatePlaybackUi({ trackChanged: true });
    if (autoplay) showToast('Demo preview: choose your music folder to play local audio');
    return;
  }

  audio.src = track.url;
  audio.load();
  audio.currentTime = 0;
  playbackTransitioning = false;
  updatePlaybackUi({ trackChanged: true });

  persistPlaybackSession();
  if (!autoplay) return;
  const playPromise = audio.play();
  if (playPromise?.catch) {
    playPromise.catch((error) => {
      if (requestId !== playbackRequestId || state.currentTrack?.id !== track.id) return;
      showToast(`Unable to play ${track.title || 'this file'}${error?.message ? `: ${error.message}` : ''}`);
      updatePlaybackUi();
    });
  }
}

function playSelected() {
  state.consecutivePlaybackErrors = 0;
  const source = [...state.selectedTracks];
  if (!source.length) return showToast('This playlist has no tracks yet');
  setPlaybackList(source, { resetHistory: true, activeTrack: 'ignore' });
  setCurrentTrack(state.playbackList[0], true, null, { addHistory: false });
}

function findTrackContext(id) {
  const track = tracksById.get(id);
  if (!track) return null;
  const folder = libraryFolderIndex.get(track.folderPath);
  return { track, queue: folder?.tracks || getLikedTracks(), libraryId: folder?.id || 'liked' };
}

function playTrackById(id) {
  state.consecutivePlaybackErrors = 0;
  const context = findTrackContext(id);
  if (!context?.track) return showToast('Track not found in current view');
  const activeCollection = state.selectedTracks.some((track) => track.id === id) ? [...state.selectedTracks] : context.queue;
  if (state.view?.type === 'playlist') state.selectedId = context.libraryId;
  state.selectedTracks = activeCollection;
  setPlaybackList(activeCollection, { resetHistory: true, activeTrack: context.track });
  renderLibrary();
  renderContent();
  setCurrentTrack(context.track, true, null, { addHistory: false });
}

function togglePlay() {
  cancelPlaybackErrorSkip();
  state.consecutivePlaybackErrors = 0;
  if (!state.currentTrack) return playSelected();
  if (!state.currentTrack.url) return showToast('Demo preview: choose your music folder to play local audio');
  if (audio.paused) {
    audio.play().catch((error) => showToast(`Unable to play this file${error?.message ? `: ${error.message}` : ''}`));
  } else {
    audio.pause();
  }
}

function nextTrack() {
  while (state.playbackForward?.length) {
    const entry = state.playbackForward.pop();
    const track = tracksById.get(entry.id);
    if (track) return setCurrentTrack(track, true, null, {
      fromQueue: entry.fromQueue, anchorPath: entry.anchorPath, preserveForward: true
    });
  }
  const next = getNextTrack();
  if (!next) return showToast('End of queue');
  const fromQueue = state.queue.length > 0;
  if (fromQueue) removeTrackFromQueue(next.id);
  return setCurrentTrack(next, true, null, { fromQueue });
}

function previousTrack() {
  if (!state.currentTrack) return;
  cancelPlaybackErrorSkip();
  if (audio.currentTime > 5) {
    audio.currentTime = 0;
    updateSeekUi();
    writePlaybackPosition(0);
    return;
  }
  while (state.playbackHistory.length) {
    const id = state.playbackHistory.pop();
    const context = state.playbackHistoryContexts?.pop();
    const previous = tracksById.get(id);
    if (previous) {
      (state.playbackForward ||= []).push({ id: state.currentTrack.id,
        anchorPath: state.playbackAnchorPath || '', fromQueue: Boolean(state.currentFromQueue) });
      return setCurrentTrack(previous, true, null, {
        addHistory: false, fromQueue: context?.id === id ? context.fromQueue : !state.playbackList.some((track) => track.id === previous.id),
        anchorPath: context?.id === id ? context.anchorPath : null, preserveForward: true
      });
    }
  }
  const collection = state.playbackList.length ? state.playbackList : state.selectedTracks;
  const index = collection.findIndex((track) => track.path === (state.playbackAnchorPath || state.currentTrack.path));
  if (collection[index - 1]) setCurrentTrack(collection[index - 1], true, null, { addHistory: false });
}

function syncModalInert() {
  const open = Boolean(document.querySelector('.modal-backdrop:not(.hidden)'));
  document.getElementById('appShell').inert = open;
  document.getElementById('fullscreenPlayer').inert = open;
  document.getElementById('queuePanel').inert = open;
}

function rememberModalFocus() {
  if (!modalReturnFocus || !modalReturnFocus.isConnected) modalReturnFocus = document.activeElement;
}

function restoreModalFocus() {
  const target = modalReturnFocus;
  modalReturnFocus = null;
  if (target && target.isConnected && typeof target.focus === 'function') requestAnimationFrame(() => target.focus());
}

// Last-viewed Options category; kept for the session so reopening lands where the user was.
let settingsTab = 'general';

function setSettingsTab(id, { focus = false } = {}) {
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  const tab = tabs.find((candidate) => candidate.dataset.settingsTab === id) || tabs[0];
  if (!tab) return;
  // Leaving the Shortcuts pane mid-recording would strand the capture (and the released hotkeys).
  if (shortcutCapture && tab.dataset.settingsTab !== settingsTab) cancelShortcutCapture();
  settingsTab = tab.dataset.settingsTab;
  for (const candidate of tabs) {
    const active = candidate === tab;
    candidate.classList.toggle('active', active);
    candidate.setAttribute('aria-selected', String(active));
    // Roving tabindex: Tab enters the tablist once, arrows move within it.
    candidate.tabIndex = active ? 0 : -1;
    document.getElementById(candidate.getAttribute('aria-controls'))?.toggleAttribute('hidden', !active);
  }
  const title = document.getElementById('settingsPaneTitle');
  if (title) title.textContent = tab.textContent.trim();
  const scroller = document.querySelector('.settings-scroll');
  if (scroller) scroller.scrollTop = 0;
  if (focus) tab.focus();
}

function handleSettingsTabKeydown(event) {
  const tabs = [...event.currentTarget.querySelectorAll('[data-settings-tab]')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  setSettingsTab(tabs[(target + tabs.length) % tabs.length].dataset.settingsTab, { focus: true });
}

function openSettings() {
  rememberModalFocus();
  renderSettingsValues();
  renderShortcutSettings();
  setSettingsTab(settingsTab);
  const modal = document.getElementById('settingsModal');
  modal.classList.remove('hidden');
  syncModalInert();
  requestAnimationFrame(() => modal.querySelector('.settings-tab.active')?.focus());
}
function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal.classList.contains('hidden')) return;
  if (shortcutCapture) cancelShortcutCapture();
  modal.classList.add('hidden');
  syncModalInert();
  restoreModalFocus();
}

function updatePlaylistCoverPreview() {
  const editor = state.playlistEditState;
  const preview = document.getElementById('playlistCoverPreview');
  const pathLabel = document.getElementById('playlistCoverPath');
  const removeButton = document.querySelector('[data-action="remove-playlist-cover"]');
  if (!editor || !preview || !pathLabel) return;
  const item = getFolderById(editor.folderId);
  const selectedUrl = editor.artworkChanged ? fileUrl(editor.artworkPath) : (item?.artworkUrl || '');
  preview.innerHTML = selectedUrl ? artMarkup(selectedUrl, item?.name || 'Playlist', 'playlist-cover-preview', item?.artworkUrl || '') : artMarkup('', item?.name || 'Playlist', 'playlist-cover-preview');
  pathLabel.textContent = editor.artworkChanged ? (editor.artworkPath ? getPathLabel(editor.artworkPath) : 'No cover artwork') : (item?.artworkUrl ? 'Use current artwork' : 'No cover artwork selected');
  if (removeButton) removeButton.disabled = !selectedUrl;
}

function openPlaylistEditor(folderId) {
  const item = getFolderById(folderId);
  if (!item || item.isLiked) return;
  state.playlistEditState = { folderId: item.id, artworkPath: item.artworkPath || '', artworkChanged: false };
  document.getElementById('playlistNameInput').value = item.name || '';
  document.getElementById('playlistDescriptionInput').value = item.description || '';
  updatePlaylistCoverPreview();
  rememberModalFocus();
  document.getElementById('playlistEditModal').classList.remove('hidden');
  syncModalInert();
  requestAnimationFrame(() => document.getElementById('playlistNameInput')?.focus());
}

function closePlaylistEditor() {
  state.playlistEditState = null;
  const modal = document.getElementById('playlistEditModal');
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  syncModalInert();
  restoreModalFocus();
}

async function choosePlaylistCover() {
  if (!state.playlistEditState) return;
  const chosen = await window.spotfck.choosePlaylistArtwork();
  if (!chosen) return;
  state.playlistEditState.artworkPath = chosen;
  state.playlistEditState.artworkChanged = true;
  updatePlaylistCoverPreview();
}

function removePlaylistCover() {
  if (!state.playlistEditState) return;
  state.playlistEditState.artworkPath = '';
  state.playlistEditState.artworkChanged = true;
  updatePlaylistCoverPreview();
}

function updateTrackCoverPreview() {
  const editor = state.trackEditState;
  const preview = document.getElementById('trackCoverPreview') || document.getElementById('trackEditCoverPreview');
  const pathLabel = document.getElementById('trackCoverPath');
  const removeBtn = document.querySelector('[data-action="remove-track-cover"]') || document.getElementById('removeTrackCoverBtn');
  if (!editor || !preview) return;
  const selectedUrl = editor.artworkChanged ? fileUrl(editor.artworkPath) : (editor.currentArtworkUrl || '');
  preview.innerHTML = selectedUrl
    ? artMarkup(selectedUrl, editor.title || 'Track', 'playlist-cover-preview', editor.currentArtworkUrl || '')
    : artMarkup('', editor.title || 'Track', 'playlist-cover-preview');
  if (pathLabel) {
    pathLabel.textContent = editor.artworkChanged
      ? (editor.artworkPath ? getPathLabel(editor.artworkPath) : 'Embedded cover will be removed')
      : (editor.currentArtworkUrl ? 'Embedded cover artwork' : 'No embedded cover');
  }
  if (removeBtn) removeBtn.disabled = !selectedUrl;
}

function openTrackEditor(trackId) {
  const context = findTrackContext(trackId);
  const track = context?.track;
  if (!track) return;
  state.trackEditState = {
    id: track.id,
    path: track.path,
    title: track.title || '',
    artworkPath: '',
    currentArtworkUrl: track.artworkUrl || '',
    artworkChanged: false,
    removeArtwork: false
  };
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  setVal('trackTitleInput', track.title || '');
  setVal('trackArtistInput', track.artist || '');
  setVal('trackAlbumInput', track.album || '');
  setVal('trackAlbumArtistInput', track.albumArtist || '');
  setVal('trackYearInput', track.year ? String(track.year) : '');
  setVal('trackNumberInput', track.trackNo ? String(track.trackNo) : '');
  setVal('trackGenreInput', track.genre || '');
  setVal('trackCommentInput', track.comment || '');
  const filePathEl = document.getElementById('trackEditFilePath') || document.getElementById('trackFilePathInput');
  if (filePathEl) {
    if ('value' in filePathEl) filePathEl.value = track.path || '';
    else filePathEl.textContent = track.path || '';
  }
  updateTrackCoverPreview();
  rememberModalFocus();
  document.getElementById('trackEditModal')?.classList.remove('hidden');
  syncModalInert();
  requestAnimationFrame(() => document.getElementById('trackTitleInput')?.focus());
}

function closeTrackEditor() {
  state.trackEditState = null;
  const modal = document.getElementById('trackEditModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  syncModalInert();
  restoreModalFocus();
}

async function chooseTrackCover() {
  if (!state.trackEditState) return;
  const chosen = await window.spotfck.choosePlaylistArtwork();
  if (!chosen) return;
  state.trackEditState.artworkPath = chosen;
  state.trackEditState.artworkChanged = true;
  state.trackEditState.removeArtwork = false;
  updateTrackCoverPreview();
}

function removeTrackCover() {
  if (!state.trackEditState) return;
  state.trackEditState.artworkPath = '';
  state.trackEditState.artworkChanged = true;
  state.trackEditState.removeArtwork = true;
  updateTrackCoverPreview();
}

function refreshEditedTrack(updatedTrack) {
  if (!updatedTrack?.id) return;
  if (updatedTrack.artworkUrl && !updatedTrack.artworkUrl.includes('?')) {
    updatedTrack.artworkUrl = `${updatedTrack.artworkUrl}?v=${Date.now()}`;
  }
  const searchText = `${updatedTrack.title || ''}\n${updatedTrack.artist || ''}\n${updatedTrack.album || ''}`.toLowerCase();
  const mergeTrack = (item) => Object.assign(item, updatedTrack, { _searchText: searchText });
  const matchTrack = (item) => item?.id === updatedTrack.id || (item?.path && item.path === updatedTrack.path);
  for (const folder of state.library.folders || []) {
    folder.tracks = (folder.tracks || []).map((item) => matchTrack(item) ? mergeTrack(item) : item);
  }
  if (Array.isArray(state.library.likedSongs)) {
    state.library.likedSongs = state.library.likedSongs.map((item) => matchTrack(item) ? mergeTrack(item) : item);
  }
  state.selectedTracks = (state.selectedTracks || []).map((item) => matchTrack(item) ? mergeTrack(item) : item);
  state.playbackList = (state.playbackList || []).map((item) => matchTrack(item) ? mergeTrack(item) : item);
  state.basePlaybackList = (state.basePlaybackList || []).map((item) => matchTrack(item) ? mergeTrack(item) : item);
  state.queue = (state.queue || []).map((item) => matchTrack(item) ? mergeTrack(item) : item);
  if (state.currentTrack && matchTrack(state.currentTrack)) {
    state.currentTrack = mergeTrack(state.currentTrack);
  }
  albumCollectionsCache = null;
  const track = tracksByPath.get(String(updatedTrack.path || '').replaceAll('\\', '/').toLowerCase());
  if (track) tracksById.set(track.id, track);
  if (typeof render === 'function') render();
  else if (typeof renderAll === 'function') renderAll();
  if (typeof renderQueuePanel === 'function') renderQueuePanel();
  if (typeof updateMediaSession === 'function') updateMediaSession();
}

async function saveTrackEditor() {
  if (!state.trackEditState || state.trackEditState.saving) return;
  const edit = state.trackEditState;
  edit.saving = true;
  const rootPath = state.library?.rootPath;
  const requestId = playbackRequestId;
  const trackNoRaw = document.getElementById('trackNumberInput')?.value.trim() || '';
  const parsedTrackNo = trackNoRaw ? Number.parseInt(trackNoRaw, 10) : null;
  const trackNo = Number.isFinite(parsedTrackNo) && parsedTrackNo > 0 ? parsedTrackNo : null;
  const activeTrack = state.currentTrack && (state.currentTrack.id === edit.id || state.currentTrack.path === edit.path) ? state.currentTrack : null;
  const wasPlaying = Boolean(activeTrack && !audio.paused);
  const resumePosition = activeTrack ? (Number.isFinite(audio.currentTime) && audio.currentTime > 0 ? audio.currentTime : state.currentPosition || 0) : 0;
  if (activeTrack) {
    playbackTransitioning = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    playbackTransitioning = false;
  }
  let result;
  try {
    result = await window.spotfck.editTrackMetadata({
      trackPath: edit.path,
      title: document.getElementById('trackTitleInput')?.value.trim() || '',
      artist: document.getElementById('trackArtistInput')?.value.trim() || '',
      album: document.getElementById('trackAlbumInput')?.value.trim() || '',
      albumArtist: document.getElementById('trackAlbumArtistInput')?.value.trim() || '',
      year: document.getElementById('trackYearInput')?.value.trim() || '',
      trackNo,
      genre: document.getElementById('trackGenreInput')?.value.trim() || '',
      comment: document.getElementById('trackCommentInput')?.value.trim() || '',
      artworkPath: edit.artworkChanged && !edit.removeArtwork ? edit.artworkPath : '',
      artworkChanged: Boolean(edit.artworkChanged),
      artworkSourcePath: edit.artworkChanged && !edit.removeArtwork ? edit.artworkPath : null,
      removeArtwork: Boolean(edit.artworkChanged && edit.removeArtwork)
    });
    if (!result?.ok || !result?.track) throw new Error(result?.error || 'Could not update track details');
    if (state.library?.rootPath === rootPath) {
      const baseMatches = state.library.scannedAt === result.baseScannedAt;
      refreshEditedTrack(result.track);
      if (baseMatches && Number.isFinite(result.scannedAt)) state.library.scannedAt = result.scannedAt;
    }
    if (state.trackEditState === edit) {
      closeTrackEditor();
      showToast('Track details saved');
    }
  } catch (error) {
    showToast(error?.message || String(error || 'Could not update track details'));
  } finally {
    edit.saving = false;
    if (activeTrack && playbackRequestId === requestId && state.library?.rootPath === rootPath
        && state.currentTrack?.path === edit.path) {
      const latestTrack = result?.ok && result?.track ? result.track : activeTrack;
      setCurrentTrack(latestTrack, wasPlaying, null, { addHistory: false, fromQueue: state.currentFromQueue,
        anchorPath: state.playbackAnchorPath, resumePosition, preserveForward: true });
    }
  }
}


function remapLocalPath(value, oldRoot, newRoot) {
  const raw = String(value || '');
  const oldValue = oldRoot.replaceAll('\\', '/').replace(/\/$/, '');
  const normalized = raw.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  const oldLower = oldValue.toLowerCase();
  if (lower !== oldLower && !lower.startsWith(`${oldLower}/`)) return value;
  const remapped = `${newRoot.replaceAll('\\', '/')}${normalized.slice(oldValue.length)}`;
  // Emit whichever separator the incoming root uses. Forcing backslashes corrupted
  // every path in the library on macOS and Linux.
  return newRoot.includes('\\') ? remapped.replaceAll('/', '\\') : remapped;
}

// An asset URL percent-encodes the whole path into a single segment, so there is no shared
// prefix left to rewrite the way a `file://` URL allowed. Decode back to the path, remap
// that, and re-encode.
function remapLocalUrl(value, oldRoot, newRoot) {
  const decoded = window.spotfck.fromAssetUrl(value);
  if (!decoded) return value;
  const remapped = remapLocalPath(decoded, oldRoot, newRoot);
  if (remapped === decoded) return value;
  const query = /^[a-z][a-z0-9+.-]+:/i.test(String(value)) ? new URL(value).search : '';
  return fileUrl(remapped) + query;
}

function refreshEditedPlaylist(result, previousItem) {
  const oldRoot = previousItem.path;
  const newRoot = result.folderPath;
  const hashId = (value) => {
    const bytes = new TextEncoder().encode(String(value || ''));
    const words = new Uint32Array(((bytes.length + 8 >> 6) + 1) * 16);
    for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
    words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length & 3) * 8);
    words[words.length - 1] = bytes.length * 8;
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Uint32Array(80);
    for (let i = 0; i < words.length; i += 16) {
      for (let t = 0; t < 16; t++) w[t] = words[i + t];
      for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let t = 0; t < 80; t++) {
        const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
        const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return `${h0.toString(16).padStart(8, '0')}${h1.toString(16).padStart(8, '0')}`;
  };
  state.playbackAnchorPath = remapLocalPath(state.playbackAnchorPath || '', oldRoot, newRoot);
  setLikedReferences(likedReferencePaths.map((path) => remapLocalPath(path, oldRoot, newRoot)));
  for (const entry of [...(state.playbackHistoryContexts || []), ...(state.playbackForward || [])]) {
    entry.anchorPath = remapLocalPath(entry.anchorPath || '', oldRoot, newRoot);
  }
  const tracksToRemap = new Set([
    ...(state.library.likedSongs || []), ...(state.selectedTracks || []),
    ...(state.queue || []), ...(state.playbackList || []), ...(state.basePlaybackList || []),
    ...(state.currentTrack ? [state.currentTrack] : [])
  ]);
  for (const folder of state.library.folders) {
    const prevFolderPath = folder.path;
    folder.path = remapLocalPath(folder.path, oldRoot, newRoot);
    if (folder.path !== prevFolderPath) folder.id = hashId(folder.path);
    folder.artworkPath = remapLocalPath(folder.artworkPath, oldRoot, newRoot);
    folder.artworkUrl = remapLocalUrl(folder.artworkUrl, oldRoot, newRoot);
    for (const track of folder.tracks || []) tracksToRemap.add(track);
  }
  for (const track of tracksToRemap) {
      const prevTrackPath = track.path;
      const prevTrackId = track.id;
      track.path = remapLocalPath(track.path, oldRoot, newRoot);
      if (track.path !== prevTrackPath) {
        track.id = hashId(track.path);
        if (state.selectedTrackIds?.has(prevTrackId)) { state.selectedTrackIds.delete(prevTrackId); state.selectedTrackIds.add(track.id); }
        if (state.focusedTrackId === prevTrackId) state.focusedTrackId = track.id;
        if (state.selectionAnchorId === prevTrackId) state.selectionAnchorId = track.id;
        if (Array.isArray(state.playbackHistory)) state.playbackHistory = state.playbackHistory.map((id) => id === prevTrackId ? track.id : id);
        for (const entry of [...(state.playbackHistoryContexts || []), ...(state.playbackForward || [])]) {
          if (entry.id === prevTrackId) entry.id = track.id;
        }
      }
      track.folderPath = remapLocalPath(track.folderPath, oldRoot, newRoot);
      track.url = remapLocalUrl(track.url, oldRoot, newRoot);
      track.artworkPath = remapLocalPath(track.artworkPath, oldRoot, newRoot);
      track.artworkUrl = remapLocalUrl(track.artworkUrl, oldRoot, newRoot);
  }
  const updated = state.library.folders.find((folder) => folder.path === newRoot);
  if (!updated) return false;
  updated.id = result.id;
  updated.name = result.name;
  updated.description = result.description;
  updated.artworkPath = result.artworkPath || '';
  updated.artworkUrl = result.artworkUrl || updated.tracks.find((track) => track.artworkUrl)?.artworkUrl || '';
  state.library.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  normalizeLibrary(state.library);
  state.selectedId = updated.id;
  if (state.view.type === 'playlist') state.view.id = updated.id;
  updateMediaSession();
  persistPlaybackSession();
  return true;
}

// The confirmation and the trashing both happen in the main process; here we only
// reconcile local state so the sidebar does not keep showing a folder that is gone.
async function deleteSelectedPlaylist() {
  if (!state.playlistEditState) return;
  const item = getFolderById(state.playlistEditState.folderId);
  if (!item || item.isLiked) return;
  try {
    const result = await window.spotfck.deletePlaylist({ rootPath: state.library.rootPath, folderPath: item.path });
    if (result?.cancelled) return;
    if (!result?.ok) throw new Error(result?.error || 'Could not delete this playlist');
    const removedRoot = item.path.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
    const previous = [state.currentTrack, [...state.queue], [...state.playbackList], [...state.basePlaybackList]];
    state.library.folders = (state.library.folders || []).filter((folder) => {
      const path = folder.path.replaceAll('\\', '/').toLowerCase();
      return path !== removedRoot && !path.startsWith(`${removedRoot}/`);
    });
    state.library.folderCount = state.library.folders.length;
    state.library.trackCount = state.library.likedSongs.length + state.library.folders.reduce((sum, folder) => sum + folder.tracks.length, 0);
    state.library = normalizeLibrary(state.library);
    reconcilePlaybackAfterLibraryRefresh(...previous);
    closePlaylistEditor();
    if (state.selectedId === item.id) navigateTo({ type: 'playlist', id: 'liked' });
    else render();
    showToast(`Moved “${item.name}” to the Recycle Bin`);
    reportEvent('playlist.deleted', { tracks: item.tracks?.length || 0 });
  } catch (error) {
    showToast(error?.message || 'Could not delete this playlist');
    reportEvent('playlist.delete-failed', { error: error?.message || String(error) }, 'warn');
  }
}

async function savePlaylistEditor() {
  if (!state.playlistEditState || state.playlistEditState.saving) return;
  const editor = state.playlistEditState;
  const item = getFolderById(editor.folderId);
  const name = document.getElementById('playlistNameInput').value.trim();
  const description = document.getElementById('playlistDescriptionInput').value.trim();
  if (!item || !name) return showToast('A playlist title is required');
  editor.saving = true;
  const current = state.currentTrack;
  const folderLabel = getPathLabel(item.path);
  const release = current && (name !== item.name || (folderLabel && name !== folderLabel)) && remapLocalPath(current.path, item.path, '') !== current.path;
  const position = audio.currentTime;
  const playing = !audio.paused;
  const requestId = playbackRequestId;
  if (release) {
    playbackTransitioning = true;
    audio.pause(); audio.removeAttribute('src'); audio.load();
  }
  try {
    const result = await window.spotfck.editPlaylist({
      folderPath: item.path, name, description, artworkPath: editor.artworkPath, artworkChanged: editor.artworkChanged
    });
    if (!result?.ok) throw new Error(result?.error || 'Could not update this playlist');
    refreshEditedPlaylist(result, item);
    closePlaylistEditor();
    render();
    showToast(result.warning || 'Playlist updated in your music folder');
  } catch (error) {
    showToast(error?.message || 'Could not update this playlist');
  } finally {
    editor.saving = false;
    playbackTransitioning = false;
    if (release && playbackRequestId === requestId && state.currentTrack === current) {
      setCurrentTrack(current, playing, null, { addHistory: false, fromQueue: state.currentFromQueue,
        anchorPath: state.playbackAnchorPath, resumePosition: position, preserveForward: true });
    }
  }
}

let libraryViewSaveTimer;
function persistLibraryView() {
  clearTimeout(libraryViewSaveTimer);
  libraryViewSaveTimer = setTimeout(() => persistSettings(), 120);
}

let settingsSaveChain = Promise.resolve();
let librarySwitching = false;
let scanNeedsFullRefresh = false;
async function persistSettings(overrides = {}) {
  writeCachedAppearance();
  // Ordinary preference saves must not overwrite a library switch queued ahead of them.
  const { libraryPath, ...preferences } = state.settings;
  const snapshot = { ...preferences, ...overrides };
  try {
    settingsSaveChain = settingsSaveChain.catch(() => {}).then(() => window.spotfck.saveSettings(snapshot));
    await settingsSaveChain;
    return true;
  } catch (error) {
    showToast(`Could not save settings${error?.message ? `: ${error.message}` : ''}`);
    return false;
  }
}

async function handleWindowAction(action) {
  try {
    // A just-toggled tray preference must reach Rust before the window action.
    await settingsSaveChain;
    await window.spotfck[action]();
  } catch (error) {
    showToast(`Could not ${action} window${error?.message ? `: ${error.message}` : ''}`);
  }
}

function getSelectedTrackObjects() {
  const selected = state.selectedTrackIds;
  return state.selectedTracks.filter((track) => selected.has(track.id));
}

function clearTrackSelection({ renderView = true } = {}) {
  state.selectedTrackIds.clear();
  state.selectionAnchorId = '';
  if (renderView) updateTrackSelectionStates();
}

function updateTrackSelectionStates() {
  document.querySelectorAll('#contentView .track-row').forEach((row) => {
    const selected = state.selectedTrackIds.has(row.dataset.trackId);
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('#contentView .collection-tools').forEach((toolbar) => { toolbar.innerHTML = selectionToolbarMarkup(); });
}

function updateTrackSelection(trackId, { range = false, toggle = false } = {}) {
  const tracks = filterListTracks(state.selectedTracks);
  if (range && state.selectionAnchorId) {
    const anchor = tracks.findIndex((track) => track.id === state.selectionAnchorId);
    const target = tracks.findIndex((track) => track.id === trackId);
    if (anchor >= 0 && target >= 0) {
      if (!toggle) state.selectedTrackIds.clear();
      for (let index = Math.min(anchor, target); index <= Math.max(anchor, target); index += 1) state.selectedTrackIds.add(tracks[index].id);
    }
  } else if (toggle) {
    if (state.selectedTrackIds.has(trackId)) state.selectedTrackIds.delete(trackId);
    else state.selectedTrackIds.add(trackId);
    state.selectionAnchorId = trackId;
  } else {
    state.selectedTrackIds = new Set([trackId]);
    state.selectionAnchorId = trackId;
  }
  updateTrackSelectionStates();
}

function queueTracks(tracks, { next = false } = {}) {
  const seen = new Set(next ? [] : state.queue.map((track) => track.id));
  const additions = tracks.filter((track) => {
    if (!track || track.id === state.currentTrack?.id || seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
  const requested = new Set(additions.map((track) => track.id));
  state.queue = next ? [...additions, ...state.queue.filter((track) => !requested.has(track.id))] : [...state.queue, ...additions];
  renderNowPlaying();
  renderQueuePanel();
  persistPlaybackSession();
  showToast(additions.length ? `${additions.length} track${additions.length === 1 ? '' : 's'} ${next ? 'will play next' : 'added to queue'}` : 'No new tracks were added');
}

function hideTrackContextMenu() {
  document.getElementById('trackContextMenu')?.classList.add('hidden');
  contextTrackId = '';
}

function showTrackContextMenu(trackId, clientX, clientY) {
  const menu = document.getElementById('trackContextMenu');
  if (!menu) return;
  contextTrackId = trackId;
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))}px`;
  requestAnimationFrame(() => menu.querySelector('button')?.focus());
}

const playlistOrderWrites = new Map();

async function reorderSelectedTracks(sourceIds, targetId, dropPosition = '') {
  const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
  if (!ids.length || !targetId || ids.includes(targetId) || state.view?.type !== 'playlist') return;
  const item = getSelectedItem();
  if (!item) return;
  const rootPath = state.library.rootPath;
  const folderPath = item.path || rootPath;
  const tracks = [...state.selectedTracks];
  const movedIds = new Set(ids);
  const moved = tracks.filter((track) => movedIds.has(track.id));
  const remaining = tracks.filter((track) => !movedIds.has(track.id));
  const targetIndex = remaining.findIndex((track) => track.id === targetId);
  if (!moved.length || targetIndex < 0) return;
  const writeKey = JSON.stringify([rootPath, folderPath]);
  let pending = playlistOrderWrites.get(writeKey);
  if (!pending) {
    pending = { version: 0, chain: Promise.resolve(), confirmedPaths: state.selectedTracks.map((track) => track.path) };
    playlistOrderWrites.set(writeKey, pending);
  }
  // Dropping onto a row that sat below the dragged block means "put it after that
  // row". Removing the block already shifted the target up by one, so inserting at
  // targetIndex would land everything back exactly where it started.
  const originalTargetIndex = tracks.findIndex((track) => track.id === targetId);
  const firstMovedIndex = tracks.findIndex((track) => movedIds.has(track.id));
  const insertIndex = dropPosition === 'before' ? targetIndex
    : dropPosition === 'after' ? targetIndex + 1
    : (firstMovedIndex < originalTargetIndex ? targetIndex + 1 : targetIndex);
  remaining.splice(insertIndex, 0, ...moved);
  tracks.splice(0, tracks.length, ...remaining);
  // Liked Songs mixes root files with liked references, and each half persists to its own
  // file. Split before touching `likedSongs` (isRootTrack is keyed on the current array),
  // and let the view snap to "root files, then likes" instead of showing an interleaving
  // that would silently revert on the next launch.
  const rootOrder = item.isLiked ? tracks.filter(isRootTrack) : tracks;
  if (item.isLiked) {
    const referenceOrder = tracks.filter((track) => !isRootTrack(track));
    state.library.likedSongs = rootOrder;
    persistLikedOrder(referenceOrder.map((track) => track.path));
  } else item.tracks = tracks;
  normalizeLibrary(state.library);
  state.selectedTracks = item.isLiked ? [...getLikedTracks()] : tracks;
  renderContent();
  const version = ++pending.version;
  const paths = rootOrder.map((track) => track.path);
  const write = pending.chain.then(async () => {
    const result = await window.spotfck.reorderPlaylist({ rootPath, folderPath, paths });
    if (result?.ok === false) throw new Error(result.error || 'Could not save song order');
    pending.confirmedPaths = paths;
  });
  pending.chain = write.catch(() => {});
  try {
    await write;
    if (version === pending.version) showToast('Song order saved');
  } catch (error) {
    if (version === pending.version && state.library.rootPath === rootPath) {
      const liveFolder = item.isLiked ? null : state.library.folders.find((folder) => folder.path === folderPath);
      const liveTracks = item.isLiked ? state.library.likedSongs : liveFolder?.tracks;
      if (liveTracks) {
        const byPath = new Map(liveTracks.map((track) => [track.path, track]));
        const restored = pending.confirmedPaths.map((path) => byPath.get(path)).filter(Boolean);
        const restoredPaths = new Set(restored.map((track) => track.path));
        restored.push(...liveTracks.filter((track) => !restoredPaths.has(track.path)));
        if (item.isLiked) state.library.likedSongs = restored;
        else liveFolder.tracks = restored;
        const selected = getSelectedItem();
        if ((selected?.path || (selected?.isLiked ? rootPath : '')) === folderPath) state.selectedTracks = selected.isLiked ? [...getLikedTracks()] : restored;
        normalizeLibrary(state.library);
        renderContent();
      }
    }
    showToast(error?.message || 'Could not save song order');
  } finally {
    if (version === pending.version) playlistOrderWrites.delete(writeKey);
  }
}

// "Create" makes a real directory in the music folder, because a directory *is* a
// playlist in this app. The library watcher picks the new folder up, but we select it
// right away so the user lands inside the playlist they just made.
async function createPlaylist() {
  if (!state.library.rootPath && !state.settings.libraryPath) {
    showToast('Choose a music folder first');
    openSettings();
    return;
  }
  try {
    const result = await window.spotfck.createPlaylist({ rootPath: state.library.rootPath || state.settings.libraryPath, name: 'New Playlist' });
    if (!result?.ok) throw new Error(result?.error || 'Could not create the playlist folder');
    state.library.folders = [...(state.library.folders || []), { id: result.id, name: result.name, path: result.folderPath, description: '', artworkPath: '', artworkUrl: '', tracks: [], isRoot: false }]
      .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
    state.library.folderCount = state.library.folders.length;
    state.library = normalizeLibrary(state.library);
    navigateTo({ type: 'playlist', id: result.id });
    showToast(`Created “${result.name}”`);
    reportEvent('playlist.created', { nameLength: result.name?.length });
  } catch (error) {
    showToast(error?.message || 'Could not create the playlist');
    reportEvent('playlist.create-failed', { error: error?.message || String(error) }, 'warn');
  }
}

async function chooseLibrary() {
  if (librarySwitching) return;
  librarySwitching = true;
  try {
    const chosen = await window.spotfck.chooseLibrary();
    if (!chosen) return;
    if (String(chosen).toLowerCase() === String(state.settings.libraryPath || '').toLowerCase()) {
      await scanLibrary();
      return;
    }
    if (!await persistSettings({ libraryPath: chosen })) return;
    state.settings.libraryPath = chosen;
    setLikedReferences([]);
    state.selectedId = 'liked';
    state.selectedTracks = [];
    await scanLibrary({ preservePlayback: false });
  } catch (error) {
    showToast(error?.message || 'Could not switch music folders');
  } finally {
    librarySwitching = false;
  }
}

function reconcilePlaybackAfterLibraryRefresh(previousTrack, previousQueue, previousPlaybackList, previousBaseList) {
  const byPath = tracksByPath;
  const remap = (tracks) => tracks.map((track) => byPath.get(String(track.path || '').replaceAll('\\', '/').toLowerCase())).filter(Boolean);
  state.queue = remap(previousQueue);
  state.playbackList = remap(previousPlaybackList);
  state.basePlaybackList = remap(previousBaseList);
  if (previousTrack) {
    state.currentTrack = byPath.get(String(previousTrack.path || '').replaceAll('\\', '/').toLowerCase()) || null;
    if (!state.currentTrack) { playbackRequestId += 1; audio.pause(); audio.removeAttribute('src'); audio.load(); }
  }
  state.playbackHistory = state.playbackHistory.filter((id) => tracksById.has(id));
  state.playbackHistoryContexts = (state.playbackHistoryContexts || []).filter((entry) => tracksById.has(entry.id));
  state.playbackForward = (state.playbackForward || []).filter((entry) => tracksById.has(entry.id));
  updateMediaSession();
  persistPlaybackSession();
}

function retainLibraryAfterScanFailure(rootPath, error) {
  const key = (path) => String(path || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const retained = state.library.ok && key(state.library.rootPath) === key(rootPath);
  if (!retained) {
    state.library = normalizeLibrary({ rootPath, ok: false, error, folders: [], likedSongs: [] });
    state.selectedTracks = [];
    state.selectedId = 'liked';
  }
  render();
  showToast(`Scan incomplete: ${error}${retained ? ' Previous library retained.' : ''}`);
}

async function scanLibrary({ preservePlayback = true, background = false, changes = null } = {}) {
  const rootPath = String(state.settings.libraryPath || '').trim();
  const requestId = ++scanRequestId;
  activeScanClientId = requestId;
  reportEvent('library.scan-requested', { requestId, libraryConfigured: Boolean(rootPath) });
  // A replacement request must include folders from any abandoned scan.
  if (activeScanPromise || scanNeedsFullRefresh) changes = null;
  if (activeScanPromise) activeScanPromise.catch(() => {});
  if (!preservePlayback) invalidatePlayback(true);
  state.scanning = Boolean(rootPath);
  state.scanProgress = { stage: 'validate', label: rootPath ? 'Checking your folder' : 'No folder selected', detail: rootPath || 'Choose a music folder to begin.', percent: 0, processed: 0, total: 0, folders: 0, tracks: 0 };
  if (!rootPath) {
    state.library = { rootPath: '', ok: false, error: 'no-folder-selected', likedSongs: [], likedSongsArtworkUrl: '', folders: [], folderCount: 0, trackCount: 0, scannedAt: Date.now() };
    state.selectedId = 'liked';
    state.selectedTracks = [];
    render();
    return state.library;
  }

  render();
  scanNeedsFullRefresh = true;
  const requestPromise = Promise.resolve().then(() => changes
    ? window.spotfck.refreshLibraryChanges(rootPath, changes, requestId)
    : window.spotfck.scanLibrary(rootPath, requestId));
  activeScanPromise = requestPromise;
  try {
    let result = await requestPromise;
    if (requestId !== activeScanClientId || result?.cancelled) return result;
    let incrementalApplied = false;
    if (result?.delta) {
      if (state.library.rootPath !== result.rootPath || state.library.scannedAt !== result.baseScannedAt) {
        result = await window.spotfck.scanLibrary(rootPath, requestId);
        if (requestId !== activeScanClientId || result?.cancelled) return result;
      } else {
        result = applyLibraryDelta(state.library, result);
        incrementalApplied = true;
      }
    }
    state.scanning = false;
    if (result?.ok) {
      scanNeedsFullRefresh = false;
      const livePlayback = [state.currentTrack, [...state.queue], [...state.playbackList], [...state.basePlaybackList]];
      state.library = incrementalApplied ? result : normalizeLibrary(result);
      if (preservePlayback) reconcilePlaybackAfterLibraryRefresh(...livePlayback);
      if (!playbackSessionReady) restorePlaybackSession();
      const selected = getSelectedItem();
      if (!selected) state.selectedId = 'liked';
      state.selectedTracks = getSelectedItem()?.tracks || [];
      state.libraryQuery = '';
      render();
      loadLikedReferences().then((changed) => { if (changed) refreshLikeViews(); }).catch(() => {});
      reportEvent('library.scan-applied', { requestId, folders: state.library.folderCount, tracks: state.library.trackCount, cached: false });
      window.spotfck.watchLibrary(rootPath).catch((error) => {
        reportEvent('library.watcher-start-failed', { error: String(error) }, 'warn');
        showToast('Library watching is unavailable. Lyra is retrying automatically.');
      });
      if (background) showToast('Library updated');
      return state.library;
    }
    retainLibraryAfterScanFailure(rootPath, result?.error || 'scan-failed');
    reportEvent('library.scan-result-invalid', { requestId, error: state.library.error || 'scan-failed' }, 'warn');
    return state.library;
  } catch (error) {
    if (requestId !== activeScanClientId) return null;
    state.scanning = false;
    retainLibraryAfterScanFailure(rootPath, error?.message || 'scan-failed');
    reportEvent('library.scan-ui-failed', { requestId, error: error?.stack || error?.message || String(error) }, 'error');
    return state.library;
  } finally {
    if (requestId === activeScanClientId) {
      const wasScanning = state.scanning;
      state.scanning = false;
      activeScanPromise = null;
      if (wasScanning) { renderLibrary(); renderContent(); }
    }
  }
}

async function revealLibrary() {
  const target = String(state.settings.libraryPath || state.library.rootPath || '').trim();
  if (!target) return showToast('No music folder selected');
  const ok = await window.spotfck.revealInExplorer(target);
  if (!ok) showToast('The library folder could not be opened');
}

async function openReportFolder() {
  const result = await window.spotfck.openReportFolder();
  if (!result?.ok) showToast(`Report folder could not be opened${result?.error ? `: ${result.error}` : ''}`);
}

async function chooseBackground() {
  const chosen = await window.spotfck.chooseBackground();
  if (!chosen) return;
  state.settings.backgroundPath = chosen;
  await persistSettings();
  applyBackground();
  renderSettingsValues();
}

async function removeBackground() {
  state.settings.backgroundPath = '';
  await persistSettings();
  applyBackground();
  renderSettingsValues();
}

async function chooseProfilePicture() {
  const chosen = await window.spotfck.chooseProfilePicture();
  if (!chosen) return;
  state.settings.profilePath = chosen;
  await persistSettings();
  applyProfilePicture();
}

async function removeProfilePicture() {
  state.settings.profilePath = '';
  await persistSettings();
  applyProfilePicture();
}

function setTheme(themeId) {
  if (!Object.hasOwn(THEMES, themeId)) return;
  state.settings.theme = themeId;
  applyTheme();
  persistSettings();
}

function setAccentColor(color) {
  const normalized = String(color || '').trim();
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) return;
  state.settings.accentColor = normalized;
  applyAccentColor();
  persistSettings();
  syncInk();
}

function updateVolumeReadout(show = true) {
  const value = document.getElementById('volumeValue');
  if (!value) return;
  value.textContent = `${Math.round(audio.volume * 100)}%`;
  value.classList.toggle('visible', Boolean(show));
  if (show) {
    clearTimeout(volumeFeedbackTimer);
    volumeFeedbackTimer = setTimeout(() => value.classList.remove('visible'), 1200);
  }
}

function setVolume(value, showFeedback = false) {
  audio.volume = Math.min(1, Math.max(0, Number(value) || 0));
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(() => { try { localStorage.setItem('lyra-volume', String(audio.volume)); } catch {} }, 300);
  updateVolumeReadout(showFeedback);
  const range = document.getElementById('volumeRange');
  if (range) {
    range.value = audio.volume;
    range.style.setProperty('--progress', `${audio.volume * 100}%`);
  }
  const dockMuteButton = document.querySelector('#playerDock .volume-icon');
  if (dockMuteButton) {
    dockMuteButton.innerHTML = iconMarkup(audio.volume === 0 ? 'volumeMute' : 'volume');
    dockMuteButton.setAttribute('aria-label', audio.volume === 0 ? 'Unmute' : 'Mute');
    dockMuteButton.title = audio.volume === 0 ? 'Unmute' : 'Mute';
  }
  const fullscreenRange = document.getElementById('fullscreenVolumeRange');
  if (fullscreenRange) {
    fullscreenRange.value = audio.volume;
    fullscreenRange.style.setProperty('--progress', `${audio.volume * 100}%`);
    const volumeWrap = fullscreenRange.closest('.fullscreen-volume-control');
    volumeWrap?.style.setProperty('--progress', `${audio.volume * 100}%`);
    const row = fullscreenRange.closest('.fullscreen-volume-vertical');
    const valueLabel = row?.querySelector(':scope > span:last-child');
    const muteButton = row?.querySelector('.fullscreen-volume-button');
    if (valueLabel) valueLabel.textContent = `${Math.round(audio.volume * 100)}%`;
    if (muteButton) {
      muteButton.innerHTML = iconMarkup(audio.volume === 0 ? 'volumeMute' : 'volume');
      muteButton.setAttribute('aria-label', audio.volume === 0 ? 'Unmute' : 'Mute');
      muteButton.title = audio.volume === 0 ? 'Unmute' : 'Mute';
    }
  }
}

function toggleInk(enabled) {
  state.settings.showInk = Boolean(enabled);
  const toggle = document.getElementById('inkToggle');
  if (toggle) toggle.checked = state.settings.showInk;
  persistSettings();
  syncInk();
}

function syncInk() {
  inkBackground.setEnabled(Boolean(state.settings.showInk), state.settings.accentColor);
}

// The default drag image is a full-width washed-out row, which reads as a rendering
// glitch. A compact chip that names what is moving (and how many) makes the gesture
// legible, and a drop line shows exactly where the release will land.
function createDragChip(label, count) {
  const chip = document.createElement('div');
  chip.className = 'drag-chip';
  chip.innerHTML = `<span class="drag-chip-icon">${iconMarkup('music')}</span><span class="drag-chip-copy"><strong>${escapeHtml(label)}</strong>${count > 1 ? `<span>${count} songs</span>` : ''}</span>`;
  document.body.appendChild(chip);
  dragChipElement = chip;
  return chip;
}

function clearDragChip() {
  dragChipElement?.remove();
  dragChipElement = null;
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-before, .drop-after').forEach((element) => element.classList.remove('drop-before', 'drop-after'));
}

function markDropTarget(row, event) {
  const rect = row.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  if (row.classList.contains(after ? 'drop-after' : 'drop-before')) return after ? 'after' : 'before';
  clearDropIndicators();
  row.classList.add(after ? 'drop-after' : 'drop-before');
  return after ? 'after' : 'before';
}

function updateMediaSession() {
  if (!navigator.mediaSession) return;
  const track = state.currentTrack;
  try {
    navigator.mediaSession.metadata = track && typeof MediaMetadata !== 'undefined' ? new MediaMetadata({
      title: track.title, artist: track.artist, album: track.album,
      artwork: track.artworkUrl ? [{ src: track.artworkUrl }] : []
    }) : null;
    navigator.mediaSession.playbackState = !track ? 'none' : audio.paused ? 'paused' : 'playing';
  } catch {}
}

function seekBy(seconds) {
  if (!state.currentTrack || !Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
  writePlaybackPosition();
}

// --- shortcuts ---------------------------------------------------------------------------
// A binding is `[Ctrl+][Alt+][Shift+][Meta+]<base>`, where <base> is the physical
// `event.code` (so it survives keyboard layout switches) or `MouseN` for mouse button N.
// One binding per action; '' means the user deliberately left it unbound. Only overrides
// are persisted (`settings.shortcuts`), so new defaults reach existing users.
// `playback` actions stay live behind dialogs; `repeatable` ones honour key auto-repeat.
const SHORTCUT_ACTIONS = [
  { id: 'togglePlay', label: 'Play / pause', binding: 'Space', playback: true },
  { id: 'nextTrack', label: 'Next track', binding: 'Ctrl+ArrowRight', playback: true },
  { id: 'previousTrack', label: 'Previous track', binding: 'Ctrl+ArrowLeft', playback: true },
  { id: 'seekForward', label: 'Seek forward 5s', binding: 'ArrowRight', playback: true, repeatable: true },
  { id: 'seekBackward', label: 'Seek back 5s', binding: 'ArrowLeft', playback: true, repeatable: true },
  { id: 'volumeUp', label: 'Volume up', binding: 'ArrowUp', playback: true, repeatable: true },
  { id: 'volumeDown', label: 'Volume down', binding: 'ArrowDown', playback: true, repeatable: true },
  { id: 'toggleMute', label: 'Mute / unmute', binding: '', playback: true },
  { id: 'toggleLike', label: 'Like current song', binding: '', playback: true },
  { id: 'toggleShuffle', label: 'Shuffle', binding: '' },
  { id: 'cycleRepeat', label: 'Repeat mode', binding: '' },
  { id: 'toggleFullscreen', label: 'Fullscreen player', binding: 'KeyF' },
  { id: 'navigateBack', label: 'Go back', binding: 'Mouse4' },
  { id: 'navigateForward', label: 'Go forward', binding: 'Mouse5' }
];
const SHORTCUT_ACTIONS_BY_ID = new Map(SHORTCUT_ACTIONS.map((action) => [action.id, action]));
// Global shortcuts are registered with the OS (RegisterHotKey) and fire while Lyra is in the
// background or hidden in the tray. Only playback actions qualify (the Rust side keeps the
// same list), and nothing is bound by default: grabbing a system-wide chord is the user's call.
// Stored in full (`settings.globalShortcuts`), keyboard only, and a modifier is required
// unless the key is an F-key or media key — a bare letter would be stolen from every app.
const GLOBAL_SHORTCUT_ACTIONS = SHORTCUT_ACTIONS.filter((action) => action.playback);
const SHORTCUT_SCOPES = {
  local: { settingsKey: 'shortcuts', actions: SHORTCUT_ACTIONS, listId: 'shortcutList', useDefaults: true },
  global: { settingsKey: 'globalShortcuts', actions: GLOBAL_SHORTCUT_ACTIONS, listId: 'globalShortcutList', useDefaults: false }
};
const SHORTCUT_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const MODIFIER_CODE_PATTERN = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;
const NON_TEXT_INPUT_TYPES = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);
const SCROLLABLE_REGION_SELECTOR = '.library-list, .home-view, .global-results-view, .now-playing-panel, .queue-panel, #trackContextMenu';
const SHORTCUT_KEY_LABELS = {
  Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Mouse3: 'Middle click', Mouse4: 'Mouse back', Mouse5: 'Mouse forward',
  MediaPlayPause: 'Media play/pause', MediaTrackNext: 'Media next', MediaTrackPrevious: 'Media previous', MediaStop: 'Media stop',
  AudioVolumeUp: 'Volume up key', AudioVolumeDown: 'Volume down key', AudioVolumeMute: 'Mute key'
};
let shortcutLookup = new Map();
let shortcutCapture = null;
let ignoreNextRecordClick = false;
let suppressedKeyupCode = '';
let globalShortcutErrors = {};
let globalShortcutSync = Promise.resolve();

function getShortcutBindings(scope = 'local') {
  const { settingsKey, actions, useDefaults } = SHORTCUT_SCOPES[scope];
  const saved = state.settings[settingsKey];
  const overrides = saved && typeof saved === 'object' ? saved : {};
  return Object.fromEntries(actions.map((action) => [action.id, typeof overrides[action.id] === 'string' ? overrides[action.id] : useDefaults ? action.binding : '']));
}

function isGlobalShortcutCandidate(binding) {
  const base = String(binding || '').split('+').pop();
  if (!base || base.startsWith('Mouse')) return false;
  return binding.includes('+') || /^F([1-9]|1[0-2])$/.test(base) || /^(Media|AudioVolume)/.test(base);
}

// Pushes the current global bindings to the OS. Chained so overlapping calls apply in order,
// and the bindings are read when the call actually runs, so the last state always wins.
// While any shortcut is being recorded every hotkey is released: a registered chord never
// reaches the webview, so the recorder could not see it (and it would fire its action).
function syncGlobalShortcuts() {
  globalShortcutSync = globalShortcutSync.catch(() => {}).then(async () => {
    const bindings = shortcutCapture ? {} : getShortcutBindings('global');
    const errors = await window.spotfck.setGlobalShortcuts(bindings);
    if (shortcutCapture) return;
    const previous = globalShortcutErrors;
    globalShortcutErrors = errors && typeof errors === 'object' ? errors : {};
    renderShortcutSettings();
    // Only announce failures that are new, not the same conflict on every settings save.
    const fresh = Object.keys(globalShortcutErrors).filter((id) => previous[id] !== globalShortcutErrors[id]);
    if (fresh.length) {
      const labels = fresh.map((id) => `${SHORTCUT_ACTIONS_BY_ID.get(id)?.label || id} (${formatShortcut(bindings[id])})`);
      showToast(`Global shortcut unavailable: ${labels.join(', ')} — ${globalShortcutErrors[fresh[0]]}`);
    }
  });
  return globalShortcutSync;
}

function handleGlobalShortcut(id) {
  // Payload comes from Rust, but stay strict: only bound global playback actions run.
  if (shortcutCapture || !GLOBAL_SHORTCUT_ACTIONS.some((action) => action.id === id)) return;
  if (!getShortcutBindings('global')[id]) return;
  runShortcutAction(id);
}

function rebuildShortcutLookup() {
  shortcutLookup = new Map();
  for (const [id, binding] of Object.entries(getShortcutBindings())) {
    if (binding && !shortcutLookup.has(binding)) shortcutLookup.set(binding, id);
  }
}

function shortcutModifierPrefix(event) {
  return SHORTCUT_MODIFIERS.filter((name) => event[`${name.toLowerCase()}Key`]).map((name) => `${name}+`).join('');
}

function keyboardShortcutBinding(event) {
  // Some media keys arrive with an empty `code`; fall back to `key` for those.
  const base = event.code || (event.key && event.key !== 'Unidentified' ? event.key : '');
  if (!base || MODIFIER_CODE_PATTERN.test(base)) return '';
  return shortcutModifierPrefix(event) + base;
}

// Left and right buttons stay reserved for clicking and context menus; every other button
// (middle, back, forward, and the extra thumb buttons gaming mice expose) is bindable.
function mouseShortcutBinding(event) {
  if (!Number.isInteger(event.button) || event.button < 0 || event.button === 0 || event.button === 2) return '';
  return `${shortcutModifierPrefix(event)}Mouse${event.button + 1}`;
}

function formatShortcut(binding) {
  if (!binding) return 'Not set';
  const parts = binding.split('+');
  const base = parts.pop();
  const label = SHORTCUT_KEY_LABELS[base] || base
    .replace(/^Key([A-Z])$/, '$1').replace(/^Digit(\d)$/, '$1')
    .replace(/^Numpad(.+)$/, 'Num $1').replace(/^Mouse(\d+)$/, 'Mouse $1');
  return [...parts, label].join(' + ');
}

function isTextEntryElement(element) {
  if (!element) return false;
  if (element.isContentEditable || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') return true;
  return element.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has(element.type);
}

function isModalOpen() {
  return Boolean(document.querySelector('.modal-backdrop:not(.hidden)'));
}

function shortcutAllowedHere(binding, action) {
  // Behind a dialog only playback control makes sense; navigating would change a screen
  // the user cannot see.
  if (isModalOpen() && !action.playback) return false;
  const base = binding.split('+').pop();
  // Mouse buttons, F-keys and media keys never collide with typing.
  if (base.startsWith('Mouse') || /^F\d{1,2}$/.test(base) || /^(Media|AudioVolume)/.test(base)) return true;
  const active = document.activeElement;
  // Typing a space into search must still type a space.
  if (isTextEntryElement(active)) return false;
  if (!binding.includes('+') && /^(Arrow|Page|Home$|End$)/.test(base)) {
    // Bare arrows keep their native meaning on sliders, in scrollable panels and in dialogs.
    if (isModalOpen() || (active?.tagName === 'INPUT' && active.type === 'range') || active?.closest?.(SCROLLABLE_REGION_SELECTOR)) return false;
  }
  return true;
}

function cycleRepeatMode() {
  state.repeatMode = state.repeatMode === 'off' ? 'all' : state.repeatMode === 'all' ? 'one' : 'off';
  renderPlayerDock();
  if (state.fullscreenView) renderFullscreenPlayer();
  updatePlaybackModeControls();
  showToast(state.repeatMode === 'one' ? 'Repeat one' : state.repeatMode === 'all' ? 'Repeat all' : 'Repeat off');
  persistPlaybackSession();
}

function runShortcutAction(id) {
  if (id === 'togglePlay') return togglePlay();
  if (id === 'nextTrack') { state.consecutivePlaybackErrors = 0; return nextTrack(); }
  if (id === 'previousTrack') { state.consecutivePlaybackErrors = 0; return previousTrack(); }
  if (id === 'seekForward') return seekBy(5);
  if (id === 'seekBackward') return seekBy(-5);
  if (id === 'volumeUp' || id === 'volumeDown') {
    setVolume(audio.volume + (id === 'volumeUp' ? 0.05 : -0.05), true);
    return revealFullscreenVolume();
  }
  if (id === 'toggleMute') return toggleMute();
  if (id === 'toggleLike') return toggleTrackLike();
  if (id === 'toggleShuffle') return toggleShuffleMode();
  if (id === 'cycleRepeat') return cycleRepeatMode();
  if (id === 'toggleFullscreen') return toggleFullscreenView();
  if (id === 'navigateBack') return state.fullscreenView ? setFullscreenView(false) : navigateHistory(-1);
  if (id === 'navigateForward') return navigateHistory(1);
}

function handleShortcutKeydown(event) {
  const binding = keyboardShortcutBinding(event);
  const action = SHORTCUT_ACTIONS_BY_ID.get(shortcutLookup.get(binding));
  if (!action || !shortcutAllowedHere(binding, action)) return false;
  // preventDefault on keydown is what stops a focused button or checkbox from also
  // activating on Space; keyup is suppressed as well because Chromium activates there.
  event.preventDefault();
  suppressedKeyupCode = event.code;
  // A held Space must not machine-gun play/pause; seek and volume are meant to repeat.
  if (event.repeat && !action.repeatable) return true;
  runShortcutAction(action.id);
  return true;
}

function handleShortcutMouse(event) {
  if (shortcutCapture) return;
  if (event.type === 'mousedown') ignoreNextRecordClick = false;
  const binding = mouseShortcutBinding(event);
  if (!binding) return;
  const action = SHORTCUT_ACTIONS_BY_ID.get(shortcutLookup.get(binding));
  // Back/forward are always swallowed: left alone, WebView2 treats them as history
  // navigation of the page itself.
  if (action || event.button === 3 || event.button === 4) event.preventDefault();
  if (event.type !== 'mousedown' || !action || !shortcutAllowedHere(binding, action)) return;
  runShortcutAction(action.id);
}

function renderShortcutSettings() {
  renderShortcutList('local');
  renderShortcutList('global');
}

function renderShortcutList(scope) {
  const { actions, listId } = SHORTCUT_SCOPES[scope];
  const list = document.getElementById(listId);
  if (!list) return;
  // Two columns filled top-to-bottom, so related actions (play, next, previous) stay adjacent.
  list.style.setProperty('--shortcut-rows', String(Math.ceil(actions.length / 2)));
  // Built once and then patched in place: replacing the buttons between mousedown and
  // mouseup would swallow the click that the capture logic below relies on.
  if (!list.children.length) {
    list.innerHTML = actions.map((action) => `<div class="shortcut-row" data-shortcut-row="${action.id}"><span class="shortcut-label">${escapeHtml(action.label)}</span><span class="shortcut-controls"><button type="button" class="shortcut-chip" data-action="record-shortcut" data-shortcut-id="${action.id}" data-shortcut-scope="${scope}"></button><button type="button" class="icon-button small shortcut-clear" data-action="clear-shortcut" data-shortcut-id="${action.id}" data-shortcut-scope="${scope}" aria-label="Clear ${escapeHtml(action.label)} shortcut" title="Clear shortcut">${iconMarkup('close')}</button></span></div>`).join('');
  }
  const bindings = getShortcutBindings(scope);
  const prompt = scope === 'global' ? 'Press a key combination…' : 'Press a key or mouse button…';
  for (const action of actions) {
    const row = list.querySelector(`[data-shortcut-row="${action.id}"]`);
    if (!row) continue;
    const chip = row.querySelector('.shortcut-chip');
    const recording = shortcutCapture?.id === action.id && shortcutCapture.scope === scope;
    const label = formatShortcut(bindings[action.id]);
    // Only global bindings can fail to apply: the OS refuses chords another app owns.
    const error = scope === 'global' && bindings[action.id] ? globalShortcutErrors[action.id] || '' : '';
    chip.textContent = recording ? prompt : label;
    chip.classList.toggle('recording', recording);
    chip.classList.toggle('unset', !recording && !bindings[action.id]);
    chip.classList.toggle('conflict', !recording && Boolean(error));
    chip.title = error;
    chip.setAttribute('aria-label', `${action.label}: ${recording ? 'waiting for a key' : label}${error ? ` (${error})` : ''}. Activate to change.`);
    row.querySelector('.shortcut-clear').disabled = !bindings[action.id];
  }
}

function setShortcutOverrides(overrides, message = '', scope = 'local') {
  const wasCapturing = Boolean(shortcutCapture);
  state.settings[SHORTCUT_SCOPES[scope].settingsKey] = overrides;
  shortcutCapture = null;
  rebuildShortcutLookup();
  renderShortcutSettings();
  // Recording released the hotkeys, so finishing any capture must re-register them.
  if (scope === 'global' || wasCapturing) syncGlobalShortcuts();
  persistSettings();
  if (message) showToast(message);
}

function assignShortcut(id, binding, scope = 'local') {
  const { settingsKey, actions } = SHORTCUT_SCOPES[scope];
  const action = actions.find((candidate) => candidate.id === id);
  if (!action) return;
  if (scope === 'global' && !isGlobalShortcutCandidate(binding)) {
    showToast('Global shortcuts need Ctrl, Alt, Shift or Win — or an F-key or media key');
    return cancelShortcutCapture();
  }
  const overrides = { ...(state.settings[settingsKey] || {}) };
  const bindings = getShortcutBindings(scope);
  // One input, one action: stealing a binding unbinds it from its previous owner.
  const displaced = actions.find((other) => other.id !== id && bindings[other.id] === binding);
  if (displaced) overrides[displaced.id] = '';
  overrides[id] = binding;
  setShortcutOverrides(overrides, displaced
    ? `${formatShortcut(binding)} now does “${action.label}” (removed from “${displaced.label}”)`
    : `${action.label}: ${formatShortcut(binding)}${scope === 'global' ? ' (global)' : ''}`, scope);
}

function startShortcutCapture(id, scope = 'local') {
  if (!SHORTCUT_SCOPES[scope]?.actions.some((action) => action.id === id)) return;
  shortcutCapture = { id, scope };
  renderShortcutSettings();
  syncGlobalShortcuts();
}

function cancelShortcutCapture() {
  shortcutCapture = null;
  renderShortcutSettings();
  syncGlobalShortcuts();
}

// Runs in the window capture phase, ahead of every other handler, so the key or button
// being recorded is never also executed (Escape must not close the dialog, Space must not
// toggle playback, Mouse back must not navigate).
function handleShortcutCapture(event) {
  if (!shortcutCapture) return;
  if (event.type === 'keydown') {
    if (event.key === 'Tab') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressedKeyupCode = event.code;
    if (event.key === 'Escape') return cancelShortcutCapture();
    const binding = keyboardShortcutBinding(event);
    // A lone modifier is the start of a chord; keep waiting for the real key.
    if (binding) assignShortcut(shortcutCapture.id, binding, shortcutCapture.scope);
    return;
  }
  if (event.type !== 'mousedown') return;
  const binding = mouseShortcutBinding(event);
  if (!binding) {
    // Left/right click cancels. Clicking the same chip again must not immediately restart.
    const chip = event.target.closest?.('[data-action="record-shortcut"]');
    ignoreNextRecordClick = chip?.dataset.shortcutId === shortcutCapture.id && chip?.dataset.shortcutScope === shortcutCapture.scope;
    return cancelShortcutCapture();
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  // assignShortcut rejects mouse buttons for the global scope (RegisterHotKey is keys only).
  assignShortcut(shortcutCapture.id, binding, shortcutCapture.scope);
}

function bindBackgroundFullscreenShortcut() {
  const excluded = 'button, input, textarea, select, a, img, [contenteditable="true"], [data-tauri-drag-region], .app-drag, .track-row, .playlist-card, .library-item-main, .modal-backdrop, .player-dock, .topbar, .now-art, .hero-art, .playlist-card-art, .track-art';
  const isBackground = (target) => target instanceof Element
    && !target.closest(excluded)
    && Boolean(target.closest('#appShell, .workspace, .content-panel, .now-playing-panel, .home-view'));
  let eligible = false;
  document.addEventListener('mousedown', (event) => {
    // Native title-bar resizing can move content under the second click.
    const background = event.button === 0 && isBackground(event.target);
    eligible = event.detail === 1 ? background : eligible && background;
  }, true);
  document.addEventListener('dblclick', (event) => {
    const activate = eligible && event.button === 0 && isBackground(event.target);
    eligible = false;
    if (!activate || state.fullscreenView) return;
    event.preventDefault();
    toggleFullscreenView();
  });
}

function cancelPlaybackErrorSkip() {
  clearTimeout(playbackErrorTimer);
  playbackErrorTimer = null;
}

function handlePlaybackError() {
  if (playbackTransitioning || !state.currentTrack) return;
  cancelPlaybackErrorSkip();
  const track = state.currentTrack;
  const mediaError = audio.error;
  const detail = mediaError?.message || (mediaError?.code ? `media error ${mediaError.code}` : 'unsupported or unreadable audio');
  reportEvent('playback.error', { track: reportTrack(track), code: mediaError?.code || 0, detail }, 'error');
  state.consecutivePlaybackErrors += 1;
  updatePlaybackUi();
  // Skipping past one bad file is helpful. Walking the entire library at one toast
  // every two seconds because a drive went away is not.
  if (state.consecutivePlaybackErrors >= 5) {
    showToast('Playback stopped: several files in a row could not be read');
    return;
  }
  showToast(`Playback error: ${track.title || 'track'} — ${detail}`);
  const requestId = playbackRequestId;
  const timer = setTimeout(() => {
    if (playbackErrorTimer !== timer) return;
    playbackErrorTimer = null;
    if (requestId === playbackRequestId && state.currentTrack?.id === track.id) nextTrack();
  }, 2000);
  playbackErrorTimer = timer;
}

// Scrollbars are invisible until the user scrolls. Must match the selector list in the
// "Scrollbars" block at the end of styles.css.
const SCROLL_REVEAL_SELECTOR = '.search-suggest, .library-list, .track-list, .now-playing-panel, .home-view, .global-results-view, .queue-list, .playlist-edit-modal, .fullscreen-shell, .search-rail-scroller';
const SCROLL_REVEAL_MS = 900;

function bindScrollReveal() {
  const timers = new WeakMap();
  // Only user-driven scrolls reveal the bar. A wheel/touchpad tick or a pointer press (a thumb
  // drag) records where the user is acting; a scroll counts only if that point is inside the
  // scroller. Renders that restore scrollTop or scrollIntoView() a row never flash it.
  let intent = { target: null, until: 0 };
  const capture = { capture: true, passive: true };
  document.addEventListener('wheel', (event) => { intent = { target: event.target, until: performance.now() + 300 }; }, capture);
  document.addEventListener('pointerdown', (event) => { intent = { target: event.target, until: Infinity }; }, capture);
  document.addEventListener('pointerup', () => { if (intent.until === Infinity) intent.until = performance.now() + 150; }, capture);
  // `scroll` doesn't bubble, but it does capture, so one listener sees every scroller,
  // including the ones the renderer re-creates with innerHTML.
  document.addEventListener('scroll', (event) => {
    const scroller = event.target;
    if (!(scroller instanceof Element) || !scroller.matches(SCROLL_REVEAL_SELECTOR)) return;
    if (performance.now() > intent.until || !(intent.target instanceof Node) || !scroller.contains(intent.target)) return;
    scroller.classList.add('is-scrolling');
    clearTimeout(timers.get(scroller));
    timers.set(scroller, setTimeout(() => scroller.classList.remove('is-scrolling'), SCROLL_REVEAL_MS));
  }, capture);
}

function bindEvents() {
  bindScrollReveal();
  if (navigator.mediaSession) {
    const handlers = {
      play: () => { if (audio.paused) togglePlay(); }, pause: () => audio.pause(),
      previoustrack: () => { state.consecutivePlaybackErrors = 0; previousTrack(); },
      nexttrack: () => { state.consecutivePlaybackErrors = 0; nextTrack(); },
      seekbackward: (details) => seekBy(-(details.seekOffset || 5)),
      seekforward: (details) => seekBy(details.seekOffset || 5),
      seekto: (details) => { if (Number.isFinite(details.seekTime)) seekBy(details.seekTime - audio.currentTime); }
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
    }
  }
  bindArtworkFallbacks();
  window.addEventListener('beforeunload', writePlaybackSessionNow);
  window.spotfck.onLibraryProgress(handleScanProgress);
  window.spotfck.onGlobalShortcut(handleGlobalShortcut);
  const pendingChanges = new Set();
  let watcherNeedsFullRefresh = false;
  window.spotfck.onLibraryChanged((payload) => {
    if (payload?.full) watcherNeedsFullRefresh = true;
    if (payload?.watcherError) {
      showToast('Library watching was interrupted. Lyra is reconnecting.');
      reportEvent('library.watcher-error', { error: payload.watcherError }, 'warn');
    }
    for (const path of payload?.changes || []) pendingChanges.add(path);
    clearTimeout(libraryChangeTimer);
    libraryChangeTimer = setTimeout(() => {
      const changes = [...pendingChanges];
      pendingChanges.clear();
      const full = watcherNeedsFullRefresh;
      watcherNeedsFullRefresh = false;
      scanLibrary({ preservePlayback: true, background: true, changes: !full && changes.length ? changes : null });
    }, 140);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#trackContextMenu')) hideTrackContextMenu();
    if (!event.target.closest('.global-search')) closeSearchSuggest();
    if (isQueueOpen() && !event.target.closest('#queuePanel') && !event.target.closest('[data-action="queue"]')) closeQueue();
    const viewToggle = event.target.closest('.view-toggle[data-view]');
    if (viewToggle) {
      state.libraryView = viewToggle.dataset.view === 'list' ? 'list' : 'grid';
      state.settings.libraryView = state.libraryView;
      persistLibraryView();
      renderLibrary();
      return;
    }
    const actionElement = event.target.closest('[data-action]');
    const action = actionElement?.dataset.action;
    if (['toggle-play', 'play-selected', 'play-history', 'play-queued', 'play-next', 'next', 'previous'].includes(action)) state.consecutivePlaybackErrors = 0;
    if (action) {
        if (action === 'choose-library') chooseLibrary();
      if (action === 'create-playlist') createPlaylist();
      if (action === 'reveal-library') revealLibrary();
      if (action === 'open-reports') openReportFolder();
      if (action === 'choose-background') chooseBackground();
      if (action === 'remove-background') removeBackground();
      if (action === 'toggle-blur-link') toggleBlurLink();
      if (action === 'open-playlist' && actionElement.dataset.libraryId) navigateTo({ type: 'playlist', id: actionElement.dataset.libraryId });
      if (action === 'choose-profile') chooseProfilePicture();
      if (action === 'remove-profile') removeProfilePicture();
      if (action === 'open-profile' || action === 'settings') openSettings();
      if (action === 'close-settings') closeSettings();
      if (action === 'settings-tab') setSettingsTab(actionElement.dataset.settingsTab);
      if (action === 'edit-playlist') openPlaylistEditor(actionElement.dataset.libraryId);
      if (action === 'close-playlist-editor') closePlaylistEditor();
      if (action === 'delete-playlist') deleteSelectedPlaylist();
      if (action === 'choose-playlist-cover') choosePlaylistCover();
      if (action === 'remove-playlist-cover') removePlaylistCover();
      if (action === 'close-track-editor') closeTrackEditor();
      if (action === 'choose-track-cover') chooseTrackCover();
      if (action === 'remove-track-cover') removeTrackCover();
      if (action === 'reveal-edited-track' && state.trackEditState?.path) window.spotfck.revealInExplorer(state.trackEditState.path);
      if (action === 'minimize') handleWindowAction('minimize');
      if (action === 'maximize') window.spotfck.maximize();
      if (action === 'close') handleWindowAction('close');
      if (action === 'navigate-back') navigateHistory(-1);
      if (action === 'navigate-forward') navigateHistory(1);
      if (action === 'play-selected') playSelected();
      if (action === 'shuffle-selected') toggleShuffleMode();
      if (action === 'play-track') playTrackById(actionElement.dataset.trackId);
      if (action === 'toggle-play') togglePlay();
      if (action === 'toggle-like') toggleTrackLike();
      if (action === 'next') nextTrack();
      if (action === 'previous') previousTrack();
      if (action === 'shuffle') toggleShuffleMode();
      if (action === 'repeat') cycleRepeatMode();
      if (action === 'record-shortcut') {
        if (ignoreNextRecordClick) ignoreNextRecordClick = false;
        else startShortcutCapture(actionElement.dataset.shortcutId, actionElement.dataset.shortcutScope);
      }
      if (action === 'clear-shortcut') {
        const scope = actionElement.dataset.shortcutScope === 'global' ? 'global' : 'local';
        const { settingsKey } = SHORTCUT_SCOPES[scope];
        const shortcut = SHORTCUT_ACTIONS_BY_ID.get(actionElement.dataset.shortcutId);
        if (shortcut) setShortcutOverrides({ ...(state.settings[settingsKey] || {}), [shortcut.id]: '' }, `${shortcut.label}: shortcut cleared`, scope);
      }
      if (action === 'reset-shortcuts') setShortcutOverrides({}, 'Shortcuts reset to defaults');
      if (action === 'clear-global-shortcuts') setShortcutOverrides({}, 'Global shortcuts cleared', 'global');
      if (action === 'add-queue') queueTracks(state.selectedTracks);
      if (action === 'add-track-queue') {
        const context = findTrackContext(actionElement.dataset.trackId);
        showToast(addTrackToQueue(context?.track) ? 'Added to queue' : 'Track is already queued');
      }
      if (action === 'play-next') nextTrack();
      if (action === 'play-queued') {
        const track = state.queue.find((item) => item.id === actionElement.dataset.trackId);
        if (track) { removeTrackFromQueue(track.id); closeQueue(); setCurrentTrack(track, true, null, { fromQueue: true }); }
      }
      if (action === 'play-history') {
        const track = getAllTracks().find((item) => item.id === actionElement.dataset.trackId);
        if (track) { closeQueue(); setCurrentTrack(track, true, findTrackContext(track.id)?.queue || state.selectedTracks); }
      }
      if (action === 'remove-queued') { removeTrackFromQueue(actionElement.dataset.trackId); renderQueuePanel(); renderNowPlaying(); }
      if (action === 'clear-queue') { state.queue = []; persistPlaybackSession(); renderQueuePanel(); renderNowPlaying(); showToast('Queue cleared'); }
      if (action === 'close-queue') closeQueue();
      if (action === 'queue-tab') { state.queueView = actionElement.dataset.queueView === 'history' ? 'history' : 'queue'; renderQueuePanel(); }
      if (action === 'export-queue') window.spotfck.exportQueue(state.queue).then((result) => { if (result?.ok) showToast('Queue exported'); else if (!result?.cancelled) showToast(result?.error || 'Could not export queue'); });
      if (action === 'queue-selection') queueTracks(getSelectedTrackObjects());
      if (action === 'play-next-selection') queueTracks(getSelectedTrackObjects(), { next: true });
      if (action === 'clear-selection') clearTrackSelection();
      if (action.startsWith('context-')) {
        const contextTrack = findTrackContext(contextTrackId)?.track;
        const targets = contextTrack && state.selectedTrackIds.has(contextTrackId) ? getSelectedTrackObjects() : (contextTrack ? [contextTrack] : []);
        if (action === 'context-play' && targets[0]) playTrackById(targets[0].id);
        if (action === 'context-play-next') queueTracks(targets, { next: true });
        if (action === 'context-add-queue') queueTracks(targets);
        if (action === 'context-edit-details' && (contextTrack || targets[0])) openTrackEditor((contextTrack || targets[0]).id);
        if (action === 'context-reveal' && targets[0]) window.spotfck.revealInExplorer(targets[0].path);
        if (action === 'context-copy' && targets.length) navigator.clipboard.writeText(targets.map((track) => `${track.title} — ${track.artist}`).join('\n'));
        hideTrackContextMenu();
      }
      if (action === 'library-filter') {
        const nextFilter = actionElement.dataset.libraryFilter === 'albums' ? 'albums' : 'playlists';
        if (nextFilter !== state.libraryFilter) {
          state.libraryFilter = nextFilter;
          state.libraryQuery = '';
          const libraryFilterInput = document.getElementById('libraryFilter');
          if (libraryFilterInput) libraryFilterInput.value = '';
          renderLibrary();
        }
        return;
      }
      if (action === 'toggle-credits') {
        state.creditsExpanded = !state.creditsExpanded;
        renderNowPlaying();
        return;
      }
      if (action === 'scan') scanLibrary();
      if (action === 'go-home') { navigateTo({ type: 'home' }); return; }
      if (action === 'clear-search') {
        if (state.view?.type === 'search' && state.navigationIndex > 0) navigateHistory(-1);
        else navigateTo({ type: 'home' });
        return;
      }
      if (action === 'commit-search') {
        commitSearch(document.getElementById('globalSearch').value);
        return;
      }
      if (action === 'toggle-search-all-songs') {
        state.searchShowAllSongs = !state.searchShowAllSongs;
        renderContent();
        return;
      }
      if (action === 'toggle-mute') toggleMute();
      if (action === 'fullscreen' || action === 'toggle-fullscreen-view') toggleFullscreenView();
      if (action === 'queue') toggleQueue();
      return;
    }
    const themeElement = event.target.closest('[data-theme-id]');
    if (themeElement) {
      setTheme(themeElement.dataset.themeId);
      return;
    }
    const accentElement = event.target.closest('[data-accent-color]');
    if (accentElement) {
      setAccentColor(accentElement.dataset.accentColor);
      return;
    }
    const entityLink = event.target.closest('button[data-entity-type][data-entity-value]');
    if (entityLink) {
      navigateTo({ type: entityLink.dataset.entityType, value: entityLink.dataset.entityValue });
      return;
    }
    const homeCard = event.target.closest('[data-home-library-id]');
    if (homeCard) {
      navigateTo({ type: 'playlist', id: homeCard.dataset.homeLibraryId });
      return;
    }
    const libraryMatch = event.target.closest('.library-match[data-track-id]');
    if (libraryMatch) {
      playTrackById(libraryMatch.dataset.trackId);
      return;
    }
    const trackRow = event.target.closest('.track-row[data-track-id]');
    if (trackRow) {
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        updateTrackSelection(trackRow.dataset.trackId, { range: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
        return;
      }
      if (state.selectedTrackIds.size) clearTrackSelection({ renderView: false });
      playTrackById(trackRow.dataset.trackId);
      return;
    }
    const libraryItem = event.target.closest('.library-item-main[data-library-id]');
    if (libraryItem) {
      navigateTo({ type: 'playlist', id: libraryItem.dataset.libraryId });
      return;
    }
  });

  document.addEventListener('contextmenu', (event) => {
    // The pencil on the hero art is easy to miss, so right-clicking a playlist in the
    // sidebar opens the same editor - which is where rename, cover and delete live.
    const libraryItem = event.target.closest('.library-item-main[data-library-id]');
    if (libraryItem && getFolderById(libraryItem.dataset.libraryId) && libraryItem.dataset.libraryId !== 'liked') {
      event.preventDefault();
      hideTrackContextMenu();
      openPlaylistEditor(libraryItem.dataset.libraryId);
      return;
    }
    const row = event.target.closest('.track-row[data-track-id]');
    if (!row) return hideTrackContextMenu();
    event.preventDefault();
    if (!state.selectedTrackIds.has(row.dataset.trackId)) {
      state.selectedTrackIds = new Set([row.dataset.trackId]);
      state.selectionAnchorId = row.dataset.trackId;
      updateTrackSelectionStates();
    }
    showTrackContextMenu(row.dataset.trackId, event.clientX, event.clientY);
  });

  bindBackgroundFullscreenShortcut();

  const globalSearchInput = document.getElementById('globalSearch');
  // Typing only drives the dropdown; the results page opens on Enter / "See all".
  // Debounced so a big library is scanned once per typing pause, not per keystroke.
  globalSearchInput.addEventListener('input', (event) => {
    const query = event.target.value;
    clearTimeout(contentSearchTimer);
    contentSearchTimer = setTimeout(() => renderSearchSuggest(query), 90);
  });
  globalSearchInput.addEventListener('focus', (event) => { if (event.target.value.trim()) renderSearchSuggest(event.target.value); });
  globalSearchInput.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const panel = document.getElementById('searchSuggest');
    const open = !panel.hidden;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) renderSearchSuggest(event.target.value);
      moveSearchSuggest(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // Kill a pending debounce, or it re-opens the panel right after we close it.
      clearTimeout(contentSearchTimer);
      const active = open && searchSuggestIndex >= 0 ? panel.querySelector(`[data-suggest-index="${searchSuggestIndex}"] .search-suggest-main`) : null;
      if (active) active.click();
      else commitSearch(event.target.value);
    } else if (event.key === 'Escape' && open) {
      // stopPropagation: the document-level Escape would also close fullscreen / the queue.
      event.preventDefault();
      event.stopPropagation();
      closeSearchSuggest();
    }
  });
  document.getElementById('searchSuggest').addEventListener('click', (event) => {
    // Picking a result closes the panel; "+ queue" keeps it open so several songs can be
    // queued in a row. This runs before the document-level delegate does the actual action.
    if (event.target.closest('.search-suggest-main')) {
      clearTimeout(contentSearchTimer);
      closeSearchSuggest();
      globalSearchInput.blur();
    }
  });
  document.getElementById('libraryFilter').addEventListener('input', (event) => {
    state.libraryQuery = event.target.value;
    clearTimeout(librarySearchTimer);
    librarySearchTimer = setTimeout(() => renderLibrary(), 90);
  });
  document.getElementById('inkToggle').addEventListener('change', (event) => toggleInk(event.target.checked));
  document.getElementById('closeToTrayToggle').addEventListener('change', (event) => { state.settings.closeToTray = event.target.checked; persistSettings(); });
  document.getElementById('accentColorPicker').addEventListener('change', (event) => setAccentColor(event.target.value));
  for (const input of document.querySelectorAll('[data-surface-setting]')) {
    // `input` restyles live while dragging; `change` (on release) writes settings.json once
    // instead of on every pixel of travel.
    input.addEventListener('input', () => setSurfaceSetting(input.dataset.surfaceSetting, input.value));
    input.addEventListener('change', () => persistSettings());
    // The dialog's dimmed, blurred backdrop would hide the very panels being tuned, so it
    // clears while the thumb is held.
    input.addEventListener('pointerdown', () => document.getElementById('settingsModal')?.classList.add('surface-preview'));
  }
  window.addEventListener('pointerup', () => document.getElementById('settingsModal')?.classList.remove('surface-preview'));
  window.addEventListener('pointercancel', () => document.getElementById('settingsModal')?.classList.remove('surface-preview'));
  document.getElementById('playerDock').addEventListener('wheel', (event) => {
    event.preventDefault();
    if (event.deltaY === 0) return;
    setVolume(audio.volume + (event.deltaY < 0 ? 0.05 : -0.05), true);
  }, { passive: false });
  window.addEventListener('resize', positionQueuePanel);
  const fullscreenPlayer = document.getElementById('fullscreenPlayer');
  fullscreenPlayer?.addEventListener('dblclick', (event) => {
    if (event.button !== 0 || event.target.closest('button, input, textarea, select, a, [data-tauri-drag-region]')) return;
    event.preventDefault();
    setFullscreenView(false);
  });
  fullscreenPlayer?.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (event.deltaY === 0) return;
    setVolume(audio.volume + (event.deltaY < 0 ? 0.05 : -0.05), true);
  }, { passive: false });
  document.getElementById('settingsModal').addEventListener('click', (event) => { if (event.target.id === 'settingsModal') closeSettings(); });
  document.querySelector('#settingsModal .settings-tabs')?.addEventListener('keydown', handleSettingsTabKeydown);
  document.getElementById('playlistEditModal').addEventListener('click', (event) => { if (event.target.id === 'playlistEditModal') closePlaylistEditor(); });
  document.getElementById('playlistEditForm').addEventListener('submit', (event) => { event.preventDefault(); savePlaylistEditor(); });
  document.getElementById('trackEditModal')?.addEventListener('click', (event) => { if (event.target.id === 'trackEditModal') closeTrackEditor(); });
  document.getElementById('trackEditForm')?.addEventListener('submit', (event) => { event.preventDefault(); saveTrackEditor(); });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const trackModal = document.getElementById('trackEditModal');
    const playlistModal = document.getElementById('playlistEditModal');
    const settingsModal = document.getElementById('settingsModal');
    const activeModal = trackModal && !trackModal.classList.contains('hidden')
      ? trackModal
      : (!playlistModal.classList.contains('hidden') ? playlistModal : (!settingsModal.classList.contains('hidden') ? settingsModal : null));
    const contextMenu = document.getElementById('trackContextMenu');
    if (event.key === 'Escape' && !contextMenu.classList.contains('hidden')) {
      event.preventDefault();
      hideTrackContextMenu();
      return;
    }
    if (!contextMenu.classList.contains('hidden') && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const items = [...contextMenu.querySelectorAll('button:not([disabled])')];
      if (items.length) {
        const index = items.indexOf(document.activeElement);
        const next = index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[next]?.focus();
      }
      return;
    }
    if (event.key === 'Escape') {
      if (isQueueOpen()) closeQueue();
      else if (activeModal === trackModal) closeTrackEditor();
      else if (activeModal === playlistModal) closePlaylistEditor();
      else if (activeModal === settingsModal) closeSettings();
      else if (state.fullscreenView) setFullscreenView(false);
      return;
    }
    if (event.key === 'Tab' && activeModal) {
      // Inactive Options panes and non-selected tabs are in the DOM but not reachable by Tab.
      const focusable = [...activeModal.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.tabIndex >= 0 && !element.closest('[hidden]'));
      if (focusable.length) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      return;
    }
    if (!activeModal && (event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'a' && document.activeElement?.closest?.('.track-list')) {
      event.preventDefault();
      const selectableTracks = filterListTracks(state.selectedTracks);
      state.selectedTrackIds = new Set(selectableTracks.map((track) => track.id));
      state.selectionAnchorId = selectableTracks[0]?.id || '';
      updateTrackSelectionStates();
      return;
    }
    if (!activeModal && !event.altKey && !document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) {
      const libraryRow = document.activeElement?.closest('.library-item-main');
      if (libraryRow && !event.ctrlKey && !event.metaKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const rows = [...document.querySelectorAll('#libraryList .library-item-main')];
        const index = rows.indexOf(libraryRow);
        const next = Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        rows[next]?.focus();
        return;
      }
      const row = document.activeElement?.closest('.track-row');
      if (row && !event.ctrlKey && !event.metaKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const list = row.closest('.track-list');
        const tracks = list?._virtualTracks || filterListTracks(state.selectedTracks);
        const index = tracks.findIndex((track) => track.id === row.dataset.trackId);
        const next = Math.max(0, Math.min(tracks.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        state.focusedTrackId = tracks[next]?.id || '';
        if (list?._virtualTracks) {
          const header = list.querySelector('.track-header')?.getBoundingClientRect().height || 46;
          const top = header + next * TRACK_ROW_HEIGHT;
          if (top < list.scrollTop) list.scrollTop = top;
          if (top + TRACK_ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + TRACK_ROW_HEIGHT - list.clientHeight;
          list._virtualStart = null;
          renderVirtualTrackRows(list);
        }
        requestAnimationFrame(() => {
          document.querySelectorAll('#contentView .track-row').forEach((node) => {
            node.tabIndex = node.dataset.trackId === state.focusedTrackId ? 0 : -1;
            if (node.tabIndex === 0) node.focus({ preventScroll: true });
          });
        });
        return;
      }
    }
    // Enter opens/plays the focused row. Space no longer does: it belongs to whatever the
    // play/pause binding is, no matter which row, button or slider has focus.
    const focusedLibraryItem = document.activeElement?.matches('.library-item-main[data-library-id]');
    if (focusedLibraryItem && event.key === 'Enter') {
      event.preventDefault();
      document.activeElement.click();
      return;
    }
    const focusedTrackRow = document.activeElement?.matches('.track-row[data-track-id]');
    if (focusedTrackRow && event.key === 'Enter') {
      event.preventDefault();
      playTrackById(document.activeElement.dataset.trackId);
      return;
    }
    handleShortcutKeydown(event);
  });
  document.addEventListener('keyup', (event) => {
    if (suppressedKeyupCode && event.code === suppressedKeyupCode) {
      suppressedKeyupCode = '';
      event.preventDefault();
    }
  });
  window.addEventListener('keydown', handleShortcutCapture, true);
  window.addEventListener('mousedown', handleShortcutCapture, true);
  for (const type of ['mousedown', 'mouseup', 'auxclick']) window.addEventListener(type, handleShortcutMouse, true);
  document.addEventListener('input', (event) => {
    if (event.target.id === 'contextSearch') {
      state.listQuery = event.target.value;
      const selectionStart = event.target.selectionStart;
      const selectionEnd = event.target.selectionEnd;
      clearTimeout(listSearchTimer);
      listSearchTimer = setTimeout(() => {
        renderContent();
        requestAnimationFrame(() => {
          const input = document.getElementById('contextSearch');
          if (!input) return;
          input.focus();
          // Re-rendering recreates the input. Restore the caret where the user left it
          // instead of snapping to the end, which made mid-string edits impossible.
          const caret = selectionStart == null ? input.value.length : Math.min(selectionStart, input.value.length);
          const caretEnd = selectionEnd == null ? caret : Math.min(selectionEnd, input.value.length);
          input.setSelectionRange(caret, caretEnd);
        });
      }, 90);
      return;
    }
    if (event.target.id === 'seekRange' || event.target.id === 'fullscreenSeekRange') {
      state.isScrubbing = true;
      const targetSeconds = Number(event.target.value);
      state.pendingSeekTime = targetSeconds;
      const seekProgress = `${(targetSeconds / Number(event.target.max || 1)) * 100}%`;
      event.target.style.setProperty('--progress', seekProgress);
      event.target.closest('.fullscreen-seek-wrap')?.style.setProperty('--progress', seekProgress);
      const labels = event.target.closest('.fullscreen-seek, .seek-row')?.querySelectorAll(':scope > span');
      if (labels?.length >= 1) labels[0].textContent = formatTime(targetSeconds);
    }
    if (event.target.id === 'volumeRange' || event.target.id === 'fullscreenVolumeRange') setVolume(Number(event.target.value), true);
  });

  const commitSeek = (explicitValue = null) => {
    const rawTarget = explicitValue !== null && Number.isFinite(explicitValue)
      ? explicitValue
      : (Number.isFinite(state.pendingSeekTime) ? state.pendingSeekTime : null);
    state.pendingSeekTime = null;
    state.isScrubbing = false;
    if (rawTarget !== null && state.currentTrack) {
      const duration = Number(audio.duration || state.currentTrack.duration || 0);
      const clamped = duration > 0 ? Math.max(0, Math.min(duration, rawTarget)) : Math.max(0, rawTarget);
      try {
        audio.currentTime = clamped;
        writePlaybackPosition();
      } catch {}
    }
    updateSeekUi();
  };

  document.addEventListener('change', (event) => {
    if (event.target.id === 'seekRange' || event.target.id === 'fullscreenSeekRange') {
      commitSeek(Number(event.target.value));
    }
  });
  const finishScrubbing = () => {
    if (!state.isScrubbing && state.pendingSeekTime == null) return;
    commitSeek();
  };
  window.addEventListener('pointerup', finishScrubbing);
  window.addEventListener('pointercancel', finishScrubbing);
  window.addEventListener('blur', finishScrubbing);

  document.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.track-row[data-track-id]');
    const queueRow = event.target.closest('.queue-list-item[draggable="true"]');
    if (queueRow) {
      draggedQueueId = queueRow.dataset.trackId;
      queueRow.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedQueueId);
      const queueLabel = queueRow.querySelector('.queue-list-copy strong')?.textContent || 'Track';
      event.dataTransfer.setDragImage(createDragChip(queueLabel, 1), 18, 22);
      return;
    }
    if (!row || state.view?.type !== 'playlist') return event.preventDefault();
    draggedTrackId = row.dataset.trackId;
    draggedTrackIds = state.selectedTrackIds.has(draggedTrackId) ? state.selectedTracks.filter((track) => state.selectedTrackIds.has(track.id)).map((track) => track.id) : [draggedTrackId];
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedTrackId);
    const label = row.querySelector('.track-title')?.textContent || 'Track';
    event.dataTransfer.setDragImage(createDragChip(label, draggedTrackIds.length), 18, 22);
    row.closest('.track-list')?.classList.add('is-reordering');
  });
  document.addEventListener('dragover', (event) => {
    event.preventDefault();
    const row = event.target.closest('.track-row[data-track-id]');
    const queueRow = event.target.closest('.queue-list-item[draggable="true"]');
    const target = (row && draggedTrackId) ? row : ((queueRow && draggedQueueId) ? queueRow : null);
    if (!target) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.dataTransfer.dropEffect = 'move';
    if (target.classList.contains('dragging')) { clearDropIndicators(); dropPosition = ''; return; }
    dropPosition = markDropTarget(target, event);
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const row = event.target.closest('.track-row[data-track-id]');
    const queueRow = event.target.closest('.queue-list-item[draggable="true"]');
    if (queueRow && draggedQueueId) {
      const sourceIndex = state.queue.findIndex((track) => track.id === draggedQueueId);
      let targetIndex = state.queue.findIndex((track) => track.id === queueRow.dataset.trackId);
      if (dropPosition === 'after') targetIndex += 1;
      if (sourceIndex >= 0 && targetIndex >= 0) {
        if (sourceIndex < targetIndex) targetIndex -= 1;
        if (sourceIndex !== targetIndex) {
          const [moved] = state.queue.splice(sourceIndex, 1);
          state.queue.splice(targetIndex, 0, moved);
          persistPlaybackSession();
          renderQueuePanel();
          renderNowPlaying();
        }
      }
      draggedQueueId = '';
      dropPosition = '';
      clearDropIndicators();
      return;
    }
    if (!row || !draggedTrackId) return;
    const sourceIds = [...draggedTrackIds];
    const position = dropPosition;
    draggedTrackId = '';
    draggedTrackIds = [];
    dropPosition = '';
    clearDropIndicators();
    document.querySelector('.track-row.dragging')?.classList.remove('dragging');
    reorderSelectedTracks(sourceIds, row.dataset.trackId, position);
  });
  document.addEventListener('dragend', () => {
    draggedTrackId = '';
    draggedTrackIds = [];
    draggedQueueId = '';
    dropPosition = '';
    clearDragChip();
    clearDropIndicators();
    document.querySelectorAll('.dragging').forEach((item) => item.classList.remove('dragging'));
    document.querySelectorAll('.track-list.is-reordering').forEach((item) => item.classList.remove('is-reordering'));
  });

  audio.addEventListener('loadedmetadata', () => {
    applyPendingPlaybackSeek();
    updateSeekUi();
    reportEvent('playback.metadata-loaded', { track: reportTrack(state.currentTrack), duration: Number(audio.duration || 0) });
  });
  audio.addEventListener('timeupdate', () => { queueSeekUi(); if (Date.now() - lastPositionWrite >= 15000) writePlaybackPosition(); });
  audio.addEventListener('playing', () => { cancelPlaybackErrorSkip(); state.consecutivePlaybackErrors = 0; });
  audio.addEventListener('play', () => { if (playbackTransitioning) return; syncInk(); updateMediaSession(); reportEvent('playback.started', { track: reportTrack(state.currentTrack), position: Number(audio.currentTime || 0) }); updatePlaybackUi(); });
  audio.addEventListener('pause', () => { inkBackground.stop(); updateMediaSession(); writePlaybackSessionNow(); if (!playbackTransitioning) { reportEvent('playback.paused', { track: reportTrack(state.currentTrack), position: Number(audio.currentTime || 0) }); updatePlaybackUi(); persistPlaybackSession(); } });
  audio.addEventListener('ended', () => {
    if (playbackTransitioning || !state.currentTrack) return;
    reportEvent('playback.ended', { track: reportTrack(state.currentTrack), repeatMode: state.repeatMode });
    if (state.repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    nextTrack();
  });
  audio.addEventListener('error', handlePlaybackError);
}

function applyPendingPlaybackSeek() {
  const pending = restoreSeek;
  restoreSeek = null;
  if (!pending || pending.requestId !== playbackRequestId || pending.path !== state.currentTrack?.path) return;
  audio.currentTime = Math.min(pending.position, Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : pending.position);
}

async function init() {
  // Before anything awaits: paint in the theme this user actually has.
  applyCachedAppearance();
  reportEvent('renderer.initializing', { language: navigator.language, userAgent: navigator.userAgent });
  // Defaults are live before settings arrive, so Space works from the very first frame.
  rebuildShortcutLookup();
  // A reload while the fullscreen player was open would otherwise leave the window
  // fullscreen with no player to exit from.
  window.spotfck.setFullscreen?.(false);
  bindEvents();
  try {
    const saved = localStorage.getItem('lyra-volume');
    if (saved !== null && Number.isFinite(Number(saved))) audio.volume = Math.min(1, Math.max(0, Number(saved)));
  } catch {}
  const settings = await window.spotfck.readSettings();
  const needsPaletteMigration = Number(settings?.paletteVersion || 0) < 1;
  const needsLayoutMigration = Number(settings?.layoutVersion || 0) < 1;
  state.settings = { ...state.settings, ...(settings || {}) };
  rebuildShortcutLookup();
  // Hotkeys live in the renderer's settings, so they register once those are known.
  syncGlobalShortcuts();
  initSidebarResizers();
  if (needsPaletteMigration) {
    state.settings.theme = 'lyra';
    state.settings.accentColor = '#c9a94a';
    state.settings.paletteVersion = 1;
  }
  if (needsLayoutMigration) {
    state.settings.libraryView = 'list';
    state.settings.layoutVersion = 1;
  }
  if (needsPaletteMigration || needsLayoutMigration) await persistSettings();
  state.settings.profilePath = String(state.settings.profilePath || '');
  state.libraryView = state.settings.libraryView === 'grid' ? 'grid' : 'list';
  if (!Object.hasOwn(THEMES, state.settings.theme)) state.settings.theme = 'lyra';
  // Real settings have landed; refresh the hint the next launch paints from.
  writeCachedAppearance();
  state.library = { rootPath: '', ok: false, error: 'no-folder-selected', likedSongs: [], likedSongsArtworkUrl: '', folders: [], folderCount: 0, trackCount: 0, scannedAt: Date.now() };
  state.scanProgress = { stage: 'validate', label: 'Checking your folder', detail: '', percent: 0, processed: 0, total: 0, folders: 0, tracks: 0 };
  state.currentTrack = null;
  state.queue = [];
  state.playbackList = [];
  state.basePlaybackList = [];
  state.selectedId = 'liked';
  const cachedLibrary = await window.spotfck.readLibraryCache(state.settings.libraryPath || '');
  if (state.settings.libraryPath) window.spotfck.watchLibrary(state.settings.libraryPath).catch((error) => {
    reportEvent('library.watcher-start-failed', { error: String(error) }, 'warn');
    showToast('Library watching is unavailable. Lyra is retrying automatically.');
  });
  if (cachedLibrary?.ok) {
    state.library = normalizeLibrary(cachedLibrary);
    state.selectedId = 'liked';
    await loadLikedReferences().catch(() => false);
    state.selectedTracks = getSelectedItem()?.tracks || [];
    restorePlaybackSession();
    render();
    reportEvent('library.cache-loaded', { folders: state.library.folderCount, tracks: state.library.trackCount });
  } else {
    render();
    reportEvent('library.cache-missed', { libraryConfigured: Boolean(state.settings.libraryPath) });
  }
  const reportInfo = await window.spotfck.getReportInfo().catch(() => null);
  const reportPath = document.getElementById('settingsReportPath');
  if (reportPath && reportInfo?.directory) {
    reportPath.textContent = reportInfo.directory;
    reportPath.title = reportInfo.directory;
  }
  reportEvent('renderer.ready', { theme: state.settings.theme, libraryView: state.libraryView, libraryConfigured: Boolean(state.settings.libraryPath) });
  scanLibrary({ preservePlayback: true });
}

init();
