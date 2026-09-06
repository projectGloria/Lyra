// --- Elements ---
class CrossfadeEngine extends EventTarget {
  constructor() {
    super();
    this.audioA = document.createElement('audio');
    this.audioB = document.createElement('audio');
    this.audioA.crossOrigin = 'anonymous';
    this.audioB.crossOrigin = 'anonymous';
    this.active = this.audioA;
    this.next = this.audioB;
    this.isCrossfading = false;
    this.crossfadeTime = 3.0;
    this.gainA = null;
    this.gainB = null;
    this.crossfadeTimer = null;
    
    const events = ['play', 'pause', 'timeupdate', 'loadedmetadata', 'ended', 'error', 'seeked'];
    const proxyEvent = (e) => {
      if (e.target !== this.active) return;
      if (e.type === 'ended' && this.isCrossfading) return;
      this.dispatchEvent(new Event(e.type));
    };
    for (const ev of events) {
      this.audioA.addEventListener(ev, proxyEvent);
      this.audioB.addEventListener(ev, proxyEvent);
    }

    const checkCrossfade = () => {
      if (!this.active.duration || this.isCrossfading) return;
      const timeLeft = this.active.duration - this.active.currentTime;
      if (timeLeft > 0 && timeLeft <= this.crossfadeTime) {
        this.isCrossfading = true;
        this.dispatchEvent(new Event('ended'));
      }
    };
    this.audioA.addEventListener('timeupdate', checkCrossfade);
    this.audioB.addEventListener('timeupdate', checkCrossfade);
  }

  get src() { return this.active.src; }
  set src(v) {
    if (this.isCrossfading) {
      const oldActive = this.active;
      this.active = this.next;
      this.next = oldActive;
      this.active.src = v;
      
      if (this.gainA && this.gainB && typeof audioCtx !== 'undefined' && audioCtx) {
        const oldGain = this.next === this.audioA ? this.gainA : this.gainB;
        const newGain = this.active === this.audioA ? this.gainA : this.gainB;
        const now = audioCtx.currentTime;
        
        oldGain.gain.cancelScheduledValues(now);
        oldGain.gain.setValueAtTime(oldGain.gain.value, now);
        oldGain.gain.linearRampToValueAtTime(0, now + this.crossfadeTime);
        
        newGain.gain.cancelScheduledValues(now);
        newGain.gain.setValueAtTime(0, now);
        newGain.gain.linearRampToValueAtTime(1, now + this.crossfadeTime);
        
        clearTimeout(this.crossfadeTimer);
        this.crossfadeTimer = setTimeout(() => {
          this.next.pause();
          this.isCrossfading = false;
        }, this.crossfadeTime * 1000);
      } else {
        this.isCrossfading = false;
        this.next.pause();
      }
    } else {
      clearTimeout(this.crossfadeTimer);
      this.isCrossfading = false;
      
      const oldActive = this.active;
      this.active = this.next;
      this.next = oldActive;

      if (this.gainA && this.gainB && typeof audioCtx !== 'undefined' && audioCtx) {
        const outGain = this.next === this.audioA ? this.gainA : this.gainB;
        const inGain  = this.active === this.audioA ? this.gainA : this.gainB;
        const now = audioCtx.currentTime;

        outGain.gain.cancelScheduledValues(now);
        outGain.gain.setValueAtTime(outGain.gain.value, now);
        outGain.gain.linearRampToValueAtTime(0, now + 0.2);
        
        setTimeout(() => { this.next.pause(); }, 200);

        inGain.gain.cancelScheduledValues(now);
        inGain.gain.setValueAtTime(0, now);
        inGain.gain.linearRampToValueAtTime(1, now + 0.2);
      } else {
        this.next.pause();
      }
      this.active.src = v;
    }
  }
  
  get volume() { return this.active.volume; }
  set volume(v) { this.audioA.volume = v; this.audioB.volume = v; }
  get duration() { return this.active.duration; }
  get currentTime() { return this.active.currentTime; }
  set currentTime(v) { this.active.currentTime = v; }
  get paused() { return this.active.paused; }
  get playbackRate() { return this.active.playbackRate; }
  set playbackRate(v) { this.audioA.playbackRate = v; this.audioB.playbackRate = v; }
  
  play() { return this.active.play(); }
  pause() { 
    this.active.pause(); 
    if (this.isCrossfading) this.next.pause();
  }
  addEventListener(type, listener, options) { super.addEventListener(type, listener, options); }
  removeEventListener(type, listener, options) { super.removeEventListener(type, listener, options); }
}
const audio = new CrossfadeEngine();
const contextMenu    = document.getElementById('context-menu');
const cmCopy         = document.getElementById('cm-copy');
const cmOpen         = document.getElementById('cm-open');
const cmRemove       = document.getElementById('cm-remove');
const artworkEl      = document.getElementById('artwork');
const coverImg       = document.getElementById('cover-img');
const artPlaceholder = document.getElementById('artwork-placeholder');
const trackTitle     = document.getElementById('track-title');
const trackMeta      = document.getElementById('track-meta');
const miniCover      = document.getElementById('mini-cover');
const miniTitle      = document.getElementById('mini-title');
const miniArtist     = document.getElementById('mini-artist');
const miniIconPlay   = document.getElementById('mini-icon-play');
const miniIconPause  = document.getElementById('mini-icon-pause');
const miniProgressFill = document.getElementById('mini-progress-fill');
document.getElementById('mini-btn-prev')?.addEventListener('click', () => executeAction('prev'));
document.getElementById('mini-btn-play')?.addEventListener('click', () => executeAction('playpause'));
document.getElementById('mini-btn-next')?.addEventListener('click', () => executeAction('next'));
document.getElementById('mini-btn-close')?.addEventListener('click', () => { if (window.electronAPI?.toggleMiniPlayer) window.electronAPI.toggleMiniPlayer(); });
const timeCurrent    = document.getElementById('time-current');
const timeTotal      = document.getElementById('time-total');
const progressBar    = document.getElementById('progress-bar');
const progressFill   = document.getElementById('progress-fill');
const progressThumb  = document.getElementById('progress-thumb');
const volumeBar      = document.getElementById('volume-bar');
const volumeFill     = document.getElementById('volume-fill');
const volumeThumb    = document.getElementById('volume-thumb');
const playlistEl     = document.getElementById('playlist');
const playlistEmpty  = document.getElementById('playlist-empty');
const btnPlay        = document.getElementById('btn-play');
const iconPlay       = document.getElementById('icon-play');
const iconPause      = document.getElementById('icon-pause');
const btnPrev        = document.getElementById('btn-prev');
const btnNext        = document.getElementById('btn-next');
const btnShuffle     = document.getElementById('btn-shuffle');
const btnRepeat      = document.getElementById('btn-repeat');
const btnMute        = document.getElementById('btn-mute');
const iconVol        = document.getElementById('icon-vol');
const iconMute       = document.getElementById('icon-mute');
const btnAddFiles    = document.getElementById('btn-add-files');
const btnAddFolder   = document.getElementById('btn-add-folder');
const btnToggleFolders = document.getElementById('btn-toggle-folders');
const btnExportPlaylist = document.getElementById('btn-export-playlist');
const btnClear       = document.getElementById('btn-clear');
const btnMin         = document.getElementById('btn-min');
const btnMax         = document.getElementById('btn-max');
const btnClose       = document.getElementById('btn-close');
const specCanvas     = document.getElementById('spectrum-canvas');
const specCtx        = specCanvas ? specCanvas.getContext('2d') : null;
const volumeVal      = document.getElementById('volume-val');

// Settings elements
const btnSettings     = document.getElementById('btn-settings');
const settingsPanel   = document.getElementById('settings-panel');
const animOpts        = document.querySelectorAll('.anim-opt');
const toggleCloseMin  = document.getElementById('toggle-close-minimize');
const togglePerfMode  = document.getElementById('toggle-perf-mode');
const toggleSpotifyLayout = document.getElementById('toggle-spotify-layout');
const interfaceModeOpts = document.querySelectorAll('[data-interface-mode]');

async function initInterfaceMode() {
  if (!window.electronAPI?.getInterfaceMode) return;
  const currentMode = await window.electronAPI.getInterfaceMode();
  interfaceModeOpts.forEach((button) => button.classList.toggle('active', button.dataset.interfaceMode === currentMode));
}

interfaceModeOpts.forEach((button) => button.addEventListener('click', async () => {
  if (button.dataset.interfaceMode === 'lyra' || !window.electronAPI?.setInterfaceMode) return;
  interfaceModeOpts.forEach((option) => { option.disabled = true; });
  await window.electronAPI.setInterfaceMode(button.dataset.interfaceMode);
}));

initInterfaceMode();

// EQ elements
const eqPanel         = document.getElementById('eq-panel');
const eqBandsEl       = document.getElementById('eq-bands');
const eqPresetBtns    = document.querySelectorAll('.eq-preset');
const btnEqToggle     = document.getElementById('btn-eq-toggle');
const btnEqClose      = document.getElementById('btn-eq-close');
const eqOnoff         = document.getElementById('eq-onoff');
const eqBackdrop      = document.getElementById('eq-backdrop');
const eqPill          = document.getElementById('eq-pill');

// Search elements
const playlistLabelArea = document.getElementById('playlist-label-area');
const playlistLabel     = document.getElementById('playlist-label');
const headerSearchWrap  = document.getElementById('header-search-wrap');
const searchInput       = document.getElementById('search-input');

// Cover strip (Off mode)
const coverStrip      = document.getElementById('cover-strip');

// Cover carousel (maximized/wide top strip)
const coverCarousel   = document.getElementById('cover-carousel');

// Queue preview strip (all non-off modes, narrow)
const queuePreview    = document.getElementById('queue-preview');

// Fullscreen
const fsView = document.getElementById('fullscreen-view');
const fsBg = document.getElementById('fs-bg');
const fsCover = document.getElementById('fs-cover');
const fsTitle = document.getElementById('fs-title');
const fsArtist = document.getElementById('fs-artist');
const fsTimeCurrent = document.getElementById('fs-time-current');
const fsTimeTotal = document.getElementById('fs-time-total');
const fsProgressFill = document.getElementById('fs-progress-fill');
const fsProgressBar = document.getElementById('fs-progress-bar');
let isFullscreenMode = false;
const fsOverlayUi = document.getElementById('fs-overlay-ui');
const fsControls = document.getElementById('fs-controls');
const fsBtnPrev = document.getElementById('fs-btn-prev');
const fsBtnPlay = document.getElementById('fs-btn-play');
const fsBtnNext = document.getElementById('fs-btn-next');
const fsIconPlay = document.getElementById('fs-icon-play');
const fsIconPause = document.getElementById('fs-icon-pause');

let fsIdleTimer = null;
function resetFsIdleTimer() {
  if (!isFullscreenMode) return;
  if (fsView) fsView.classList.remove('cursor-hidden');
  if (fsControls) fsControls.classList.remove('hidden');
  clearTimeout(fsIdleTimer);
  fsIdleTimer = setTimeout(() => {
    if (!isFullscreenMode) return;
    if (fsView) fsView.classList.add('cursor-hidden');
    if (fsControls) fsControls.classList.add('hidden');
  }, 3000);
}
if (fsView) {
  fsView.addEventListener('mousemove', resetFsIdleTimer);
  fsView.addEventListener('mousedown', resetFsIdleTimer);
}

function updateFsView() {
  if (!isFullscreenMode || currentIndex < 0 || !fsView) return;
  const track = queue[currentIndex];
  if (!track) return;
  fsTitle.textContent = track.name;
  fsArtist.textContent = track.artist || '—';
  const url = coverDataUrl(track);
  if (url) {
    fsCover.src = url; fsCover.style.display = 'block';
    fsBg.style.backgroundImage = `url("${url}")`;
  } else {
    fsCover.src = ''; fsCover.style.display = 'none';
    fsBg.style.backgroundImage = 'none';
  }
}

if (fsProgressBar) {
  let fsSeekDragging = false;
  const fsSeekTo = (e) => {
    const rect = fsProgressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = pct * audio.duration;
  };
  fsProgressBar.addEventListener('mousedown', (e) => { fsSeekDragging = true; fsSeekTo(e); });
  document.addEventListener('mousemove', (e) => { if (fsSeekDragging) fsSeekTo(e); });
  document.addEventListener('mouseup', () => { fsSeekDragging = false; });
}

if (fsBtnPrev) fsBtnPrev.addEventListener('click', (e) => { e.stopPropagation(); prevTrack(); });
if (fsBtnNext) fsBtnNext.addEventListener('click', (e) => { e.stopPropagation(); nextTrack(); });
if (fsBtnPlay) fsBtnPlay.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });

function searchArtist(artistName) {
  if (!artistName || artistName === '—' || artistName === '— · —') return;
  if (!searchActive && typeof openSearch === 'function') openSearch();
  if (searchInput) {
    searchInput.value = artistName;
    if (typeof applySearch === 'function') applySearch(artistName);
    if (isFullscreenMode && window.electronAPI?.toggleFullscreen) window.electronAPI.toggleFullscreen();
  }
}

if (trackMeta) {
  trackMeta.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentIndex >= 0 && queue[currentIndex]) searchArtist(queue[currentIndex].artist);
  });
}

if (fsArtist) {
  fsArtist.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentIndex >= 0 && queue[currentIndex]) searchArtist(queue[currentIndex].artist);
  });
}

// --- Queue Persistence ---
let _saveQueueTimer = null;
function saveQueue() {
  clearTimeout(_saveQueueTimer);
  _saveQueueTimer = setTimeout(() => {
    try {
      const data = {
        paths: queue.map(t => t.path),
        currentIndex,
        expandedFolders: Array.from(expandedFolders),
      };
      if (window.electronAPI?.saveQueue) window.electronAPI.saveQueue(data);
    } catch (_) {}
  }, 400);
}
async function loadSavedQueue() {
  try {
    let data = null;
    if (window.electronAPI?.loadQueue) data = await window.electronAPI.loadQueue();
    if (!data || !data.paths || !data.paths.length) return;
    
    if (data.expandedFolders) {
      expandedFolders = new Set(data.expandedFolders);
    }

    if (!window.electronAPI?.buildTracks) return;
    const tracks = await window.electronAPI.buildTracks(data.paths);
    if (!tracks.length) return;
    queue = prepareTracks(tracks);
    const idx = (data.currentIndex >= 0 && data.currentIndex < queue.length)
      ? data.currentIndex : 0;
    renderQueue();
    renderQueuePreview();
    renderCarousel();
    if (animStyle === 'off') updateCoverStrip();
    loadTrack(idx);
    renderSpotifySidebar();
  } catch (_) {}
}

const PLAYLISTS_KEY = 'lyra-user-playlists-v1';
let userPlaylists = [];
function savePlaylists() {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(userPlaylists));
  } catch (_) {}
  if (typeof renderSpotifySidebar === 'function') renderSpotifySidebar();
}
function loadPlaylists() {
  try {
    const r = localStorage.getItem(PLAYLISTS_KEY);
    if (r) {
      userPlaylists = JSON.parse(r);
    }
  } catch (_) {}
}
loadPlaylists();

function updateTrackPathEverywhere(oldPath, newPath) {
  if (oldPath === newPath) return;
  
  const update = (t) => {
    if (t.path === oldPath) {
      t.path = newPath;
      if (t.parentPath) {
        const lastSlashIndex = newPath.lastIndexOf('\\') !== -1 ? newPath.lastIndexOf('\\') : newPath.lastIndexOf('/');
        t.parentPath = newPath.substring(0, lastSlashIndex);
      }
    } else if (t.path.startsWith(oldPath + '\\') || t.path.startsWith(oldPath + '/')) {
      t.path = newPath + t.path.substring(oldPath.length);
      if (t.parentPath) {
        const lastSlashIndex = t.path.lastIndexOf('\\') !== -1 ? t.path.lastIndexOf('\\') : t.path.lastIndexOf('/');
        t.parentPath = t.path.substring(0, lastSlashIndex);
      }
    }
  };

  queue.forEach(update);
  if (librarySnapshot) {
    librarySnapshot.forEach(update);
    saveLibrarySnapshot();
  }
  userPlaylists.forEach(pl => {
    if (pl.tracks) pl.tracks.forEach(update);
  });
  savePlaylists();
  saveQueue();
}

const LIBRARY_QUEUE_KEY = 'lyra-library-queue-v1';
let librarySnapshot = null;
function saveLibrarySnapshot() {
  try {
    if (librarySnapshot) localStorage.setItem(LIBRARY_QUEUE_KEY, JSON.stringify(librarySnapshot));
    else localStorage.removeItem(LIBRARY_QUEUE_KEY);
  } catch (_) {}
}
function loadLibrarySnapshot() {
  try {
    const r = localStorage.getItem(LIBRARY_QUEUE_KEY);
    if (r) librarySnapshot = JSON.parse(r);
  } catch (_) {}
}
loadLibrarySnapshot();

let currentViewMode = 'queue'; // 'queue', 'playlists'

const btnPlaylistsView = document.getElementById('btn-playlists-view');
const btnBackLibrary = document.getElementById('btn-back-library');

if (librarySnapshot && btnBackLibrary) {
  btnBackLibrary.style.display = 'flex';
}

if (btnBackLibrary) {
  btnBackLibrary.addEventListener('click', (e) => {
    e.stopPropagation();
    
    if (currentPlaylistName) {
      renderPlaylistsView();
      return;
    }
    
    if (librarySnapshot) {
      const playingPath = queue[currentIndex]?.path;
      
      queue = prepareTracks(librarySnapshot);
      librarySnapshot = null;
      saveLibrarySnapshot();
      currentPlaylistName = null;
      if (playlistLabel) playlistLabel.textContent = 'QUEUE';
      btnBackLibrary.style.display = 'none';
      
      let newIndex = -1;
      if (playingPath) {
        newIndex = queue.findIndex(t => t.path === playingPath);
      }
      currentIndex = newIndex;
      
      currentViewMode = 'queue';
      if (btnPlaylistsView) btnPlaylistsView.classList.remove('active');
      
      if (playlistEl) {
        playlistEl.innerHTML = '';
        playlistEl.appendChild(playlistScroller);
      }
      
      renderQueue();
      renderQueuePreview();
      renderCarousel();
      saveQueue();
    }
  });
}
const playlistModal = document.getElementById('playlist-modal');
const playlistModalBackdrop = document.getElementById('playlist-modal-backdrop');
const playlistModalTitle = document.getElementById('playlist-modal-title');
const playlistModalContent = document.getElementById('playlist-modal-content');
const btnPlaylistModalClose = document.getElementById('btn-playlist-modal-close');
const cmAddToPlaylist = document.getElementById('cm-add-to-playlist');
const cmCreatePlaylist = document.getElementById('cm-create-playlist');
const cmDeletePlaylist = document.getElementById('cm-delete-playlist');

if (btnPlaylistModalClose) {
  btnPlaylistModalClose.addEventListener('click', closePlaylistModal);
}
if (playlistModalBackdrop) {
  playlistModalBackdrop.addEventListener('click', closePlaylistModal);
}

function openPlaylistModal() {
  playlistModal.classList.add('eq-visible');
  playlistModalBackdrop.classList.add('visible');
}

function closePlaylistModal() {
  playlistModal.classList.remove('eq-visible');
  playlistModalBackdrop.classList.remove('visible');
}

if (btnPlaylistsView) {
  btnPlaylistsView.addEventListener('click', () => {
    currentViewMode = currentViewMode === 'queue' ? 'playlists' : 'queue';
    btnPlaylistsView.classList.toggle('active', currentViewMode === 'playlists');
    if (currentViewMode === 'playlists') {
      if (playlistLabel) playlistLabel.textContent = 'PLAYLISTS';
      renderPlaylistsView();
    } else {
      if (playlistLabel) playlistLabel.textContent = currentPlaylistName || 'QUEUE';
      if (playlistEl) {
        playlistEl.innerHTML = '';
        playlistEl.appendChild(playlistScroller);
      }
      renderQueue();
    }
  });
}

function generateId() {
  // #21: Use crypto.randomUUID() instead of deprecated substr + weak Math.random()
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return crypto.getRandomValues(new Uint32Array(3)).join('-');
}

function renderPlaylistsView() {
  if (!playlistEl) return;
  playlistEl.innerHTML = '';
  
  if (userPlaylists.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'playlist-empty';
    empty.textContent = 'No playlists yet. Right-click a track to create one.';
    playlistEl.appendChild(empty);
    return;
  }

  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  
  userPlaylists.forEach((pl, idx) => {
    const item = document.createElement('div');
    item.className = 'custom-playlist-item';
    
    const art = document.createElement('div');
    art.className = 'cp-art';
    if (pl.art) {
      art.style.backgroundImage = `url("${pl.art}")`;
    } else {
      art.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`;
    }
    
    const info = document.createElement('div');
    info.className = 'cp-info';
    
    const name = document.createElement('div');
    name.className = 'cp-name';
    name.textContent = pl.name;
    
    const count = document.createElement('div');
    count.className = 'cp-count';
    count.textContent = `${pl.tracks ? pl.tracks.length : 0} tracks`;
    
    info.appendChild(name);
    info.appendChild(count);
    
    item.appendChild(art);
    item.appendChild(info);
    
    item.addEventListener('click', () => {
      // Load playlist
      if (!librarySnapshot) {
        librarySnapshot = JSON.parse(JSON.stringify(queue));
        saveLibrarySnapshot();
      }
      
      const playingPath = queue[currentIndex]?.path;
      
      if (pl.tracks && pl.tracks.length > 0) {
        queue = prepareTracks(JSON.parse(JSON.stringify(pl.tracks)));
      } else {
        queue = [];
      }
      
      let newIndex = -1;
      if (playingPath) {
        newIndex = queue.findIndex(t => t.path === playingPath);
      }
      currentIndex = newIndex;
      
      currentPlaylistName = pl.name;
      if (playlistLabel) playlistLabel.textContent = currentPlaylistName.toUpperCase();
      currentViewMode = 'queue';
      if (btnPlaylistsView) btnPlaylistsView.classList.remove('active');
      if (btnBackLibrary) btnBackLibrary.style.display = 'flex';
      
      if (playlistEl) {
        playlistEl.innerHTML = '';
        playlistEl.appendChild(playlistScroller);
      }
      renderQueue();
      renderQueuePreview();
      renderCarousel();
      saveQueue();
    });
    
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, idx, true);
    });
    
    container.appendChild(item);
  });
  
  playlistEl.appendChild(container);
}

function openSpotifyPlaylist(pl) {
  if (!pl) return;
  if (!librarySnapshot) {
    librarySnapshot = JSON.parse(JSON.stringify(queue));
    saveLibrarySnapshot();
  }
  const playingPath = queue[currentIndex]?.path;
  queue = prepareTracks(JSON.parse(JSON.stringify(pl.tracks || [])));
  currentIndex = playingPath ? queue.findIndex(t => t.path === playingPath) : -1;
  currentPlaylistName = pl.name;
  spotifySelectedFolderPath = null;
  if (playlistLabel) playlistLabel.textContent = pl.name.toUpperCase();
  currentViewMode = 'queue';
  if (btnPlaylistsView) btnPlaylistsView.classList.remove('active');
  if (btnBackLibrary) btnBackLibrary.style.display = 'flex';
  if (playlistEl) { playlistEl.innerHTML = ''; playlistEl.appendChild(playlistScroller); }
  renderQueue(); renderQueuePreview(); renderCarousel(); saveQueue();
  renderSpotifySidebar();
}

function renderSpotifySidebar() {
  const list = document.getElementById('spotify-playlist-list');
  const modeSelect = document.getElementById('spotify-library-mode');
  if (!list) return;
  const mode = settings?.spotifySidebarMode || 'playlists';
  if (modeSelect) modeSelect.value = mode;
  list.replaceChildren();
  if (mode === 'root') {
    renderSpotifyRoot(list);
    return;
  }
  if (!userPlaylists.length) {
    const empty = document.createElement('div');
    empty.className = 'spotify-playlist-empty';
    empty.textContent = 'Create a playlist from a track menu.';
    list.appendChild(empty);
    return;
  }
  userPlaylists.forEach(pl => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'spotify-playlist-link' + (currentPlaylistName === pl.name ? ' active' : '');
    const art = document.createElement('span');
    art.className = 'spotify-playlist-art';
    const artUrl = pl.art || coverDataUrl(pl.tracks?.[0]);
    if (artUrl) art.style.backgroundImage = `url("${artUrl}")`;
    else art.textContent = '♫';
    const text = document.createElement('span');
    text.className = 'spotify-playlist-text';
    const name = document.createElement('strong'); name.textContent = pl.name;
    const count = document.createElement('small'); count.textContent = `${pl.tracks?.length || 0} tracks`;
    text.append(name, count); item.append(art, text);
    item.addEventListener('click', () => openSpotifyPlaylist(pl));
    list.appendChild(item);
  });
}

function restoreRootLibrary() {
  if (!librarySnapshot) return;
  const playingPath = queue[currentIndex]?.path;
  queue = prepareTracks(JSON.parse(JSON.stringify(librarySnapshot)));
  librarySnapshot = null;
  saveLibrarySnapshot();
  currentPlaylistName = null;
  spotifySelectedFolderPath = null;
  currentIndex = playingPath ? queue.findIndex(track => track.path === playingPath) : -1;
  if (playlistLabel) playlistLabel.textContent = 'QUEUE';
  if (btnBackLibrary) btnBackLibrary.style.display = 'none';
  if (playlistEl) { playlistEl.innerHTML = ''; playlistEl.appendChild(playlistScroller); }
  renderQueue(); renderQueuePreview(); renderCarousel(); saveQueue();
}

function renderSpotifyRoot(list) {
  if (!queue.length) {
    const empty = document.createElement('div');
    empty.className = 'spotify-playlist-empty';
    empty.textContent = 'Add a folder or audio files to browse your root library.';
    list.appendChild(empty);
    return;
  }
  const parentDepth = new Map();
  queue.forEach(track => {
    const depth = track.parentPath ? (parentDepth.get(track.parentPath) ?? 0) : 0;
    if (track.type === 'folder') parentDepth.set(track.path, depth + 1);
  });
  queue.forEach((track, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'spotify-playlist-link spotify-root-link' + (index === currentIndex ? ' active' : '') + (track.type === 'folder' ? ' folder' : '');
    const depth = track.parentPath ? (parentDepth.get(track.parentPath) ?? 0) : 0;
    item.style.paddingLeft = `${8 + Math.min(depth, 4) * 12}px`;
    const art = document.createElement('span');
    art.className = 'spotify-playlist-art';
    if (track.type === 'folder') art.textContent = '▸';
    else {
      const artUrl = coverDataUrl(track);
      if (artUrl) art.style.backgroundImage = `url("${artUrl}")`;
      else art.textContent = '♫';
    }
    const text = document.createElement('span');
    text.className = 'spotify-playlist-text';
    const name = document.createElement('strong'); name.textContent = track.name;
    const detail = document.createElement('small'); detail.textContent = track.type === 'folder' ? 'Folder' : (track.artist || 'Song');
    text.append(name, detail); item.append(art, text);
    item.addEventListener('click', () => {
      if (track.type === 'folder') {
        spotifySelectedFolderPath = track.path;
        settings.spotifySelectedFolderPath = track.path;
        if (playlistLabel) playlistLabel.textContent = track.name.toUpperCase();
        saveSettings(); renderQueue(); saveQueue(); renderSpotifySidebar();
      } else {
        spotifySelectedFolderPath = track.parentPath || null;
        settings.spotifySelectedFolderPath = spotifySelectedFolderPath;
        saveSettings();
        switchTrackSmooth(index);
      }
    });
    list.appendChild(item);
  });
}

const SETTINGS_KEY = 'lyra-settings-v2';
function loadSettings() {
  try { const r = localStorage.getItem(SETTINGS_KEY); if (r) return JSON.parse(r); } catch (_) {}
  return { volume: 0.8, animStyle: 'default', eqEnabled: false, eqBands: null, theme: 'gold', foldersHidden: false, layout: 'classic' };
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}
const settings = loadSettings();
let foldersHidden = settings.foldersHidden || false;
let spotifySelectedFolderPath = settings.spotifySelectedFolderPath || null;

function applyLayout(layout) {
  const useSpotifyLayout = layout === 'spotify';
  settings.layout = useSpotifyLayout ? 'spotify' : 'classic';
  document.body.classList.toggle('spotify-layout', useSpotifyLayout);
  if (toggleSpotifyLayout) toggleSpotifyLayout.setAttribute('aria-checked', useSpotifyLayout ? 'true' : 'false');
  saveSettings();

  // The layout changes available space substantially, so redraw the responsive views.
  if (typeof renderQueue === 'function') renderQueue();
  if (typeof renderQueuePreview === 'function') renderQueuePreview();
  if (typeof renderCarousel === 'function') renderCarousel();
  if (typeof updateCoverStrip === 'function' && typeof animStyle !== 'undefined' && animStyle === 'off') updateCoverStrip();
}

toggleSpotifyLayout?.addEventListener('click', () => {
  applyLayout(document.body.classList.contains('spotify-layout') ? 'classic' : 'spotify');
});

// --- Theme ---
const THEMES = ['gold', 'red', 'ocean', 'forest', 'amethyst', 'mono', 'dynamic'];
let _accentRGBCache = null;

function getAccentRGB() {
  if (_accentRGBCache) return _accentRGBCache;
  let val = '';
  try {
    val = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  } catch (_) {}
  
  try {
    const cvs = document.createElement('canvas');
    cvs.width = 1; cvs.height = 1;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#c9a94a'; // fallback
    ctx.fillStyle = val;
    ctx.fillRect(0,0,1,1);
    const d = ctx.getImageData(0,0,1,1).data;
    _accentRGBCache = [d[0], d[1], d[2]];
  } catch (_) {
    _accentRGBCache = [201, 169, 74];
  }
  return _accentRGBCache;
}

function accentGradStops() {
  const [r, g, b] = getAccentRGB();
  const br = Math.min(255, r + 34), bg = Math.min(255, g + 31), bb = Math.min(255, b + 36);
  return [
    ['0%',   `rgba(${r},${g},${b},0.08)`],
    ['50%',  `rgba(${r},${g},${b},0.16)`],
    ['100%', `rgba(${br},${bg},${bb},0.48)`],
  ];
}

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'gold';
  document.documentElement.setAttribute('data-theme', name);
  
  document.documentElement.style.removeProperty('--bg');
  document.documentElement.style.removeProperty('--accent');
  document.documentElement.style.removeProperty('--text');
  _accentRGBCache = null; 

  settings.theme = name;
  saveSettings();
  
  document.querySelectorAll('.theme-opt').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.theme === name)
  );

  if (name === 'dynamic' && currentIndex >= 0) {
    applyDynamicTheme(queue[currentIndex]);
  } else {
    renderQueuePreview();
    renderCarousel();
    if (typeof animStyle !== 'undefined' && animStyle === 'off') updateCoverStrip();
  }
}

document.querySelectorAll('.theme-opt').forEach(btn =>
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme))
);

// --- State ---
let queue        = [];
let currentIndex = -1;
let isShuffle    = false;
let repeatMode   = 0;
let isPlaying    = false;
let volume       = settings.volume;
let isMuted      = false;
let animStyle    = settings.animStyle || 'default';
let currentPlaylistName = null;
let expandedFolders = new Set();

audio.volume = volume;

// --- Web Audio ---
let audioCtx, analyser, sourceNode, animFrameId, _freqBuf;

function ensureAudioCtx() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize               = 256;
  analyser.smoothingTimeConstant = 0.76;
  
  const srcA = audioCtx.createMediaElementSource(audio.audioA);
  const srcB = audioCtx.createMediaElementSource(audio.audioB);
  
  audio.gainA = audioCtx.createGain();
  audio.gainB = audioCtx.createGain();
  const masterBus = audioCtx.createGain();
  
  srcA.connect(audio.gainA).connect(masterBus);
  srcB.connect(audio.gainB).connect(masterBus);
  
  sourceNode = masterBus;
  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);
}

const CANVAS_CX = 160, CANVAS_CY = 160;
const INNER_R = 90, MAX_BAR_H = 54, MIN_BAR_H = 2, NUM_BARS = 80;
const smoothed = new Float32Array(NUM_BARS);
let decaying = false, decayFactor = 1.0;

// --- Cover Art reactive scaling ---
const bumpWrap = document.getElementById('artwork-bump-wrap');
let bumpActive = false;
let coverEnergySmooth = 0;

function applyCoverScale(raw, bufLen) {
  if (animStyle !== 'cover' || !bumpWrap) return;
  const end = Math.max(1, Math.floor(bufLen * 0.20));
  let energy = 0;
  for (let i = 0; i < end; i++) energy += raw[i];
  energy = energy / end / 255;
  const attack  = energy > coverEnergySmooth ? 0.55 : 0.12;
  coverEnergySmooth += (energy - coverEnergySmooth) * attack;
  const scale = 1.0 + coverEnergySmooth * 0.15;
  bumpWrap.style.transform  = `scale(${scale.toFixed(4)})`;
  bumpWrap.style.transition = 'none';
}

// --- Spectrum draw loop ---
const bgCanvas     = document.getElementById('bg-canvas');
const bgCtx        = bgCanvas ? bgCanvas.getContext('2d') : null;

function resizeBgCanvas() {
  if (!bgCanvas) return;
  bgCanvas.width  = window.innerWidth;
  bgCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeBgCanvas);
resizeBgCanvas();

async function extractPalette(dataUrl) {
  const dom = await getDominantColor(dataUrl);
  if (!dom) return null;
  const [r, g, b] = dom;
  const accent = `rgb(${r},${g},${b})`;
  const bg = `rgb(${Math.round(r * 0.12)}, ${Math.round(g * 0.12)}, ${Math.round(b * 0.14)})`;
  const text = `rgb(${Math.min(255, r + 200)}, ${Math.min(255, g + 200)}, ${Math.min(255, b + 200)})`;
  return { bg, accent, text };
}

async function applyDynamicTheme(track) {
  if (settings.theme !== 'dynamic') return;
  const url = coverDataUrl(track);
  if (!url) {
    document.documentElement.style.removeProperty('--bg');
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--text');
    applyTheme('gold');
    return;
  }
  const palette = await extractPalette(url);
  if (!palette) {
    document.documentElement.style.removeProperty('--bg');
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--text');
    applyTheme('gold');
    return;
  }

  document.documentElement.style.setProperty('--bg', palette.bg);
  document.documentElement.style.setProperty('--accent', palette.accent);
  document.documentElement.style.setProperty('--text', palette.text);
  _accentRGBCache = null;
  renderQueuePreview();
  renderCarousel();
}

function drawWaves(raw, bufLen) {
  const isMax = document.body.classList.contains('maximized') || document.body.classList.contains('wide');
  const isDynamic = settings.theme === 'dynamic';
  
  // Only show waves in dynamic theme, and never in carousel (maximized) view
  if (!isDynamic || isMax) {
    if (bgCanvas) bgCanvas.style.opacity = '0';
    return;
  }
  if (!bgCtx) return;
  bgCanvas.style.opacity = '1';

  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  const [ar, ag, ab] = getAccentRGB();

  let centerY = bgCanvas.height * 0.5;
  
  const width = bgCanvas.width;
  const numPoints = 120;
  const step = width / (numPoints - 1);
  
  bgCtx.beginPath();
  bgCtx.moveTo(0, centerY);
  for (let i = 0; i < numPoints; i++) {
    const bin = Math.floor((i / numPoints) * (bufLen * 0.7));
    const energy = raw[bin] / 255.0;
    const amplitude = energy * (isMax ? 90 : 160);
    const x = i * step;
    const y = centerY - amplitude;
    bgCtx.lineTo(x, y);
  }
  for (let i = numPoints - 1; i >= 0; i--) {
    const bin = Math.floor((i / numPoints) * (bufLen * 0.7));
    const energy = raw[bin] / 255.0;
    const amplitude = (energy * (isMax ? 90 : 160)) * 0.4;
    const x = i * step;
    const y = centerY + amplitude;
    bgCtx.lineTo(x, y);
  }
  bgCtx.closePath();
  
  const grd = bgCtx.createLinearGradient(0, centerY - 100, 0, centerY + 50);
  grd.addColorStop(0, `rgba(${ar}, ${ag}, ${ab}, 0)`);
  grd.addColorStop(0.5, `rgba(${ar}, ${ag}, ${ab}, 0.5)`);
  grd.addColorStop(1, `rgba(${ar}, ${ag}, ${ab}, 0)`);
  bgCtx.fillStyle = grd;
  bgCtx.fill();
  
  bgCtx.beginPath();
  bgCtx.moveTo(0, centerY);
  for (let i = 0; i < numPoints; i++) {
    const bin = Math.floor((i / numPoints) * (bufLen * 0.7));
    const energy = raw[bin] / 255.0;
    const amplitude = energy * (isMax ? 90 : 160);
    const x = i * step;
    const y = centerY - amplitude;
    if (i === 0) bgCtx.moveTo(x, y);
    else bgCtx.lineTo(x, y);
  }
  bgCtx.strokeStyle = `rgba(${ar}, ${ag}, ${ab}, 0.8)`;
  bgCtx.lineWidth = 2;
  bgCtx.lineJoin = 'round';
  bgCtx.stroke();
}

function drawSpectrum() {
  animFrameId = requestAnimationFrame(drawSpectrum);

  if (!analyser) return;
  const bufLen = analyser.frequencyBinCount;

  if (!_freqBuf || _freqBuf.length !== bufLen) _freqBuf = new Uint8Array(bufLen);
  const raw = _freqBuf;

  const isMax = document.body.classList.contains('maximized') || document.body.classList.contains('wide');
  const isDynamic = settings.theme === 'dynamic';

  if (!decaying) {
    analyser.getByteFrequencyData(raw);
    decayFactor = 1.0;
    if (animStyle === 'cover') applyCoverScale(raw, bufLen);
    if (isDynamic || isMax) drawWaves(raw, bufLen);
  } else {
    decayFactor *= 0.975;
    if (decayFactor < 0.004) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
      if (specCtx) specCtx.clearRect(0, 0, specCanvas.width, specCanvas.height);
      if (bgCtx) bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      return;
    }
  }

  if (animStyle !== 'default' || !specCtx) {
    if (specCtx) specCtx.clearRect(0, 0, specCanvas.width, specCanvas.height);
    return;
  }

  for (let i = 0; i < NUM_BARS; i++) {
    const bin    = Math.floor((i / NUM_BARS) * (bufLen * 0.78));
    const target = decaying ? 0 : raw[bin] / 255;
    smoothed[i] += (target - smoothed[i]) * (decaying ? 0.06 : 0.32);
    if (decaying) smoothed[i] *= decayFactor;
    smoothed[i] = Math.max(0, smoothed[i]);
  }

  // #14: Use a simple for-loop instead of Array.reduce to avoid GC pressure in the animation loop
  let _energySum = 0;
  for (let i = 0; i < NUM_BARS; i++) _energySum += smoothed[i];
  const avgEnergy = _energySum / NUM_BARS;
  const env       = decaying ? decayFactor : 1.0;
  const [ar, ag, ab] = getAccentRGB();
  const dimR = Math.round(ar * 0.75), dimG = Math.round(ag * 0.75), dimB = Math.round(ab * 0.75);
  const brR  = Math.min(255, ar + 54), brG = Math.min(255, ag + 66), brB = Math.min(255, ab + 76);

  specCtx.clearRect(0, 0, specCanvas.width, specCanvas.height);

  const haloGrd = specCtx.createRadialGradient(
    CANVAS_CX, CANVAS_CY, INNER_R,
    CANVAS_CX, CANVAS_CY, INNER_R + MAX_BAR_H + 20
  );
  haloGrd.addColorStop(0,   `rgba(${ar},${ag},${ab},${avgEnergy * 0.14 * env})`);
  haloGrd.addColorStop(0.4, `rgba(${ar},${ag},${ab},${avgEnergy * 0.05 * env})`);
  haloGrd.addColorStop(1,   `rgba(${ar},${ag},${ab},0)`);
  specCtx.beginPath();
  specCtx.arc(CANVAS_CX, CANVAS_CY, INNER_R + MAX_BAR_H + 20, 0, Math.PI * 2);
  specCtx.fillStyle = haloGrd;
  specCtx.fill();

  specCtx.save();
  specCtx.shadowBlur  = 10;
  specCtx.shadowColor = `rgba(${ar},${ag},${ab},${0.55 * env})`;
  // #9: Move constant per-bar state outside the loop — saves ~9 600 property-set calls/s
  specCtx.lineWidth = 2;
  specCtx.lineCap   = 'round';

  // #15: Replaced per-bar createLinearGradient (80 objects/frame) with a single interpolated
  // solid color per bar. Result is visually equivalent but eliminates all gradient allocations.
  for (let i = 0; i < NUM_BARS; i++) {
    const angle  = (i / NUM_BARS) * Math.PI * 2 - Math.PI / 2;
    const energy = smoothed[i];
    const barH   = MIN_BAR_H + energy * MAX_BAR_H;
    const x1 = CANVAS_CX + Math.cos(angle) * INNER_R;
    const y1 = CANVAS_CY + Math.sin(angle) * INNER_R;
    const x2 = CANVAS_CX + Math.cos(angle) * (INNER_R + barH);
    const y2 = CANVAS_CY + Math.sin(angle) * (INNER_R + barH);
    const t  = 0.4 + energy * 0.6;
    const cr = Math.round(dimR + (brR - dimR) * t);
    const cg = Math.round(dimG + (brG - dimG) * t);
    const cb = Math.round(dimB + (brB - dimB) * t);
    // Use integer arithmetic instead of toFixed() to avoid a per-bar string allocation
    const alpha = ((0.5 + energy * 0.5) * env * 1000 | 0) / 1000;
    specCtx.beginPath();
    specCtx.moveTo(x1, y1);
    specCtx.lineTo(x2, y2);
    specCtx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha})`;
    specCtx.stroke();
  }
  specCtx.restore();

  specCtx.beginPath();
  specCtx.arc(CANVAS_CX, CANVAS_CY, INNER_R - 1, 0, Math.PI * 2);
  specCtx.strokeStyle = `rgba(${ar},${ag},${ab},${(0.15 + avgEnergy * 0.35) * env})`;
  specCtx.lineWidth   = 1;
  specCtx.stroke();
}

function startSpectrum() {
  ensureAudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  decaying    = false;
  decayFactor = 1.0;
  if (!animFrameId) drawSpectrum();
}

function stopSpectrum() {
  decaying = true;
  if (animStyle === 'cover') {
    coverEnergySmooth = 0;
    if (bumpWrap) {
      bumpWrap.style.transition = 'transform 0.3s ease';
      bumpWrap.style.transform  = 'scale(1)';
      setTimeout(() => { if (bumpWrap) bumpWrap.style.transition = 'none'; }, 300);
    }
  }
}

function applyAnimStyle(style) {
  animStyle = style;
  document.body.setAttribute('data-anim', style);
  animOpts.forEach(btn => btn.classList.toggle('active', btn.dataset.anim === style));

  bumpActive = false;
  if (bumpWrap) {
    bumpWrap.style.transform  = '';
    bumpWrap.style.transition = '';
  }
  coverEnergySmooth = 0;

  artworkEl.style.transform  = '';
  artworkEl.style.transition = '';
  artworkEl.style.opacity    = '';

  settings.animStyle = style;
  saveSettings();
  renderQueuePreview();
  renderCarousel();
  if (style === 'off') updateCoverStrip();
}

function debounce(fn, ms) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), ms);
  };
}
// #14: Debounced version for settings that fire on continuous events (e.g. EQ slider drag)
const debouncedSaveSettings = debounce(saveSettings, 300);

function formatTime(sec) {
  if (isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function coverDataUrl(track) {
  if (!track || !track.path) return null;
  try {
    // #11: Use TextEncoder instead of deprecated unescape() for correct UTF-8 → base64 encoding
    const encoded = new TextEncoder().encode(track.path);
    // #3: Avoid spreading a large byte array onto the call stack (RangeError risk on long paths)
    let b64raw = '';
    for (let i = 0; i < encoded.length; i++) b64raw += String.fromCharCode(encoded[i]);
    const b64 = btoa(b64raw);
    return `lyra://cover/${encodeURIComponent(b64)}`;
  } catch (_) { return null; }
}

function updateSpotifyNowPlaying(track) {
  const cover = document.getElementById('spotify-now-cover');
  const bottomCover = document.getElementById('spotify-bottom-cover');
  const title = document.getElementById('spotify-now-title');
  const artist = document.getElementById('spotify-now-artist');
  const next = document.getElementById('spotify-now-next');
  if (!cover || !title || !artist || !next) return;
  if (!track) {
    cover.removeAttribute('src'); cover.classList.remove('has-cover');
    bottomCover?.removeAttribute('src'); bottomCover?.classList.remove('has-cover');
    title.textContent = 'No track loaded'; artist.textContent = 'Choose a song to start listening'; next.textContent = 'Your queue is empty';
    return;
  }
  const url = coverDataUrl(track);
  if (url) { cover.src = url; cover.classList.add('has-cover'); bottomCover?.setAttribute('src', url); bottomCover?.classList.add('has-cover'); }
  else { cover.removeAttribute('src'); cover.classList.remove('has-cover'); bottomCover?.removeAttribute('src'); bottomCover?.classList.remove('has-cover'); }
  title.textContent = track.name || 'Unknown track';
  artist.textContent = track.artist || 'Unknown artist';
  const nextIndex = getNextPlayable(currentIndex, 1);
  next.textContent = nextIndex >= 0 && queue[nextIndex] && nextIndex !== currentIndex
    ? `${queue[nextIndex].name}${queue[nextIndex].artist ? ` · ${queue[nextIndex].artist}` : ''}`
    : 'No more tracks in this queue';
}

const PLACEHOLDER_SVG_SM = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.4"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>`;
const PAUSE_INDICATOR_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" data-icon="pause"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
const PLAY_INDICATOR_SVG  = `<svg viewBox="0 0 24 24" fill="currentColor" data-icon="play"><path d="M8 5v14l11-7z"/></svg>`;

const _colorCache = new Map();
const MAX_COLOR_CACHE_SIZE = 100;

function getDominantColor(dataUrl) {
  if (!dataUrl) return null;
  if (_colorCache.has(dataUrl)) return _colorCache.get(dataUrl);

  if (_colorCache.size >= MAX_COLOR_CACHE_SIZE) {
    const firstKey = _colorCache.keys().next().value;
    _colorCache.delete(firstKey);
  }

  const promise = new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < d.length; i += 4) {
          const brightness = (d[i] + d[i+1] + d[i+2]) / 3;
          if (brightness < 20 || brightness > 235) continue;
          r += d[i]; g += d[i+1]; b += d[i+2]; count++;
        }
        if (count === 0) { resolve([128, 128, 128]); return; }
        resolve([Math.round(r/count), Math.round(g/count), Math.round(b/count)]);
      } catch (e) { resolve([128, 128, 128]); }
    };
    img.onerror = () => resolve([128, 128, 128]);
    img.src = dataUrl;
  });
  _colorCache.set(dataUrl, promise);
  return promise;
}

function prepareTracks(tracks) {
  // Build a per-folder sibling counter so renderVirtualItems can read _displayNum in O(1)
  // instead of running an O(n) inner loop for every visible item on every scroll tick. (#5)
  const folderCounters = new Map(); // parentPath -> next display number
  for (const t of tracks) {
    if (t.type !== 'folder') {
      t._searchKey = [t.name, t.artist || '', t.ext].join(' ').toLowerCase();
      const cnt = (folderCounters.get(t.parentPath) || 0) + 1;
      folderCounters.set(t.parentPath, cnt);
      t._displayNum = cnt;
    }
  }
  return tracks;
}

function getWrappedIndex(offset) {
  if (queue.length === 0) return -1;
  if (currentIndex === -1) {
    // #7: No track is active — only return a valid index for non-center (off-axis) slots
    if (offset === 0) return -1;
    return (offset % queue.length + queue.length) % queue.length;
  }
  const currentTrack = queue[currentIndex];
  if (currentTrack && currentTrack.parentPath) {
    const siblings = [];
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].type !== 'folder' && queue[i].parentPath === currentTrack.parentPath) siblings.push(i);
    }
    if (siblings.length > 0) {
      const sibIdx = siblings.indexOf(currentIndex);
      const targetSibIdx = (sibIdx + offset % siblings.length + siblings.length) % siblings.length;
      return siblings[targetSibIdx];
    }
  }
  return ((currentIndex + offset) % queue.length + queue.length) % queue.length;
}

function renderQueuePreview(goingRight) {
  if (perfMode || !queuePreview) return;
  const isMax = document.body.classList.contains('maximized') || document.body.classList.contains('wide');
  if (isMax) { queuePreview.classList.remove('visible'); return; } // #11: caller always calls renderCarousel() separately
  if (queue.length < 2) { queuePreview.classList.remove('visible'); return; }
  queuePreview.classList.add('visible');
  const items = [];
  const winW = window.innerWidth;
  let half = 3;
  if (winW < 440) half = 2;
  if (winW < 340) half = 1;
  if (winW < 240) half = 0;
  for (let offset = -half; offset <= half; offset++) {
    const dist = Math.abs(offset);
    const isCurr = offset === 0;
    const trackIdx = getWrappedIndex(offset);
    const item = document.createElement('div');
    item.className = 'qp-item' + (isCurr ? ' is-current' + (isPlaying ? ' is-playing' : '') : '');
    item.setAttribute('data-dist', dist);
    if (!isCurr && trackIdx >= 0) {
      const capturedIdx = trackIdx;
      item.addEventListener('click', () => switchTrackSmooth(capturedIdx));
    }
    const thumb = document.createElement('div');
    thumb.className = 'qp-thumb';
    if (trackIdx >= 0) {
      const track = queue[trackIdx];
      const url = coverDataUrl(track);
      const ph = document.createElement('div');
      ph.className = 'qp-thumb-ph';
      ph.innerHTML = PLACEHOLDER_SVG_SM;
      thumb.appendChild(ph);
      if (url) { thumb.style.backgroundImage = `url("${url}")`; ph.style.display = 'none'; }
    }
    if (isCurr) {
      const thumbW = 72, thumbH = 72, thumbR = 10, inset = 1;
      const px = inset, py = inset, pw = thumbW - 2*inset, ph = thumbH - 2*inset, pr = thumbR - inset;
      const size = thumbW, cx = size / 2, cy = size / 2;
      const pathD = [`M ${px+pr},${py}`, `L ${px+pw-pr},${py}`, `Q ${px+pw},${py} ${px+pw},${py+pr}`, `L ${px+pw},${py+ph-pr}`, `Q ${px+pw},${py+ph} ${px+pw-pr},${py+ph}`, `L ${px+pr},${py+ph}`, `Q ${px},${py+ph} ${px},${py+ph-pr}`, `L ${px},${py+pr}`, `Q ${px},${py} ${px+pr},${py} Z`].join(' ');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
      svg.style.cssText = `position:absolute;top:50%;left:50%;margin-top:-${size/2}px;margin-left:-${size/2}px;pointer-events:none;z-index:10;overflow:visible;`;
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
      grad.setAttribute('id', `rg-sm-${trackIdx}`); grad.setAttribute('gradientUnits', 'userSpaceOnUse');
      grad.setAttribute('x1', `${cx}`); grad.setAttribute('y1', '0'); grad.setAttribute('x2', `${cx}`); grad.setAttribute('y2', `${size}`);
      accentGradStops().forEach(([off, col]) => {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        s.setAttribute('offset', off); s.setAttribute('stop-color', col); grad.appendChild(s);
      });
      const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animateTransform');
      anim.setAttribute('attributeName', 'gradientTransform'); anim.setAttribute('type', 'rotate');
      anim.setAttribute('from', `0 ${cx} ${cy}`); anim.setAttribute('to', `360 ${cx} ${cy}`);
      anim.setAttribute('dur', '4s'); anim.setAttribute('repeatCount', 'indefinite');
      grad.appendChild(anim); defs.appendChild(grad); svg.appendChild(defs);
      const border = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      border.setAttribute('d', pathD); border.setAttribute('fill', 'none'); border.setAttribute('stroke', `url(#rg-sm-${trackIdx})`);
      border.setAttribute('stroke-width', '1.5'); border.setAttribute('stroke-linecap', 'round'); border.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(border); item.appendChild(svg);
    }
    item.appendChild(thumb);
    items.push(item);
  }
  queuePreview.replaceChildren(...items);
  if (goingRight !== undefined) {
    queuePreview.classList.remove('switching-right', 'switching-left');
    void queuePreview.offsetWidth;
    queuePreview.classList.add(goingRight ? 'switching-right' : 'switching-left');
    queuePreview.addEventListener('animationend', () => { queuePreview.classList.remove('switching-right', 'switching-left'); }, { once: true });
  }
}

function renderCarousel(goingRight) {
  if (!coverCarousel || perfMode) return;
  const isMax = document.body.classList.contains('maximized') || document.body.classList.contains('wide');
  if (!isMax) return;
  if (queue.length === 0) { while(coverCarousel.firstChild) coverCarousel.removeChild(coverCarousel.firstChild); return; }

  const winW = window.innerWidth;
  let half = 3;
  if (winW < 780) half = 2;
  if (winW < 640) half = 1;
  if (winW < 450) half = 0;

  const existingItems = new Map();
  for (const child of coverCarousel.children) { if (child.dataset.offset !== undefined) existingItems.set(parseInt(child.dataset.offset), child); }
  const newItems = [];
  for (let offset = -half; offset <= half; offset++) {
    const isCurr = offset === 0;
    const trackIdx = getWrappedIndex(offset);
    let item = existingItems.get(offset);
    if (!item) {
      item = document.createElement('div'); item.className = 'cc-item'; item.dataset.offset = offset;
      const thumb = document.createElement('div'); thumb.className = 'cc-thumb'; item.appendChild(thumb);
    }
    if (!isCurr && trackIdx >= 0) { const capturedIdx = trackIdx; item.onclick = () => switchTrackSmooth(capturedIdx); item.style.cursor = 'pointer'; }
    else { item.onclick = null; item.style.cursor = 'default'; }
    item.className = 'cc-item' + (isCurr ? ' is-center' + (isPlaying ? ' is-playing' : '') : '') + (offset !== 0 ? ' is-not-center' : '');
    item.setAttribute('data-dist', Math.abs(offset)); item.title = trackIdx >= 0 ? queue[trackIdx].name : '';
    const thumb = item.querySelector('.cc-thumb');
    const url = trackIdx >= 0 ? coverDataUrl(queue[trackIdx]) : null;
    let ph = thumb.querySelector('.qp-thumb-ph');
    if (!ph) { ph = document.createElement('div'); ph.className = 'qp-thumb-ph'; ph.innerHTML = PLACEHOLDER_SVG_SM; thumb.appendChild(ph); }
    if (url) { thumb.style.backgroundImage = `url("${url}")`; ph.style.display = 'none'; }
    else { thumb.style.backgroundImage = ''; ph.style.display = 'block'; }
    let svg = item.querySelector('svg');
    let overlay = item.querySelector('.cc-overlay');
    if (isCurr) {
      if (!overlay) { overlay = document.createElement('div'); overlay.className = 'cc-overlay'; overlay.innerHTML = `<div class="cc-icon-pause">${PAUSE_INDICATOR_SVG}</div><div class="cc-icon-play-animate">${PLAY_INDICATOR_SVG}</div>`; item.appendChild(overlay); }
    } else { if (svg) svg.remove(); if (overlay) overlay.remove(); }
    newItems.push(item); existingItems.delete(offset);
  }
  for (const unused of existingItems.values()) unused.remove();
  coverCarousel.append(...newItems);
}

function updateCoverStrip(goingRight) {
  if (perfMode || queue.length === 0 || currentIndex < 0 || !coverStrip) { if (coverStrip) coverStrip.innerHTML = ''; return; }
  const items = [];
  const winW = window.innerWidth;
  let half = 3;
  if (winW < 440) half = 2;
  if (winW < 340) half = 1;
  if (winW < 240) half = 0;
  for (let offset = -half; offset <= half; offset++) {
    const dist = Math.abs(offset), isCurr = offset === 0, trackIdx = getWrappedIndex(offset);
    const item = document.createElement('div'); item.className = 'cover-strip-item' + (isCurr ? ' is-center' : ''); item.setAttribute('data-dist', dist);
    if (!isCurr && trackIdx >= 0) { const capturedIdx = trackIdx; item.addEventListener('click', () => switchTrackSmooth(capturedIdx)); }
    const cover = document.createElement('div'); cover.className = 'strip-cover';
    if (trackIdx >= 0) { const track = queue[trackIdx], url = coverDataUrl(track); if (url) cover.style.backgroundImage = `url("${url}")`; }
    item.appendChild(cover); items.push(item);
  }
  coverStrip.replaceChildren(...items);
  if (goingRight !== undefined) {
    coverStrip.classList.remove('switching-right', 'switching-left');
    void coverStrip.offsetWidth;
    coverStrip.classList.add(goingRight ? 'switching-right' : 'switching-left');
    coverStrip.addEventListener('animationend', () => { coverStrip.classList.remove('switching-right', 'switching-left'); }, { once: true });
  }
}

let _pendingDirection;
function switchTrackSmooth(index) {
  if (index === currentIndex || index < 0 || index >= queue.length) return;
  const goingRight = index > currentIndex;
  _pendingDirection = goingRight;
  if (currentIndex !== -1 && !perfMode) {
    const ghost = artworkEl.cloneNode(true); ghost.id = '';
    const currentTransform = getComputedStyle(artworkEl).transform;
    ghost.style.transform = currentTransform; ghost.style.position = 'absolute'; ghost.style.zIndex = '5'; ghost.style.pointerEvents = 'none'; ghost.style.transition = 'opacity 0.25s ease, transform 0.25s ease'; ghost.classList.remove('playing');
    if (bumpWrap) bumpWrap.appendChild(ghost);
    requestAnimationFrame(() => {
      ghost.style.opacity = '0';
      if (animStyle !== 'cover') ghost.style.transform = `${currentTransform} translateX(${goingRight ? '-20px' : '20px'}) scale(0.95)`;
      ghost.addEventListener('transitionend', () => ghost.remove(), { once: true });
      setTimeout(() => ghost.remove(), 400);
    });
  }
  bumpActive = false; if (bumpWrap) { bumpWrap.style.transform = ''; bumpWrap.style.transition = ''; }
  if (animStyle === 'cover') {
    artworkEl.style.transition = 'none'; artworkEl.style.opacity = '0';
    loadTrack(index); playAudio();
    requestAnimationFrame(() => { requestAnimationFrame(() => { artworkEl.style.transition = 'opacity 0.2s ease'; artworkEl.style.opacity = '1'; }); });
  } else {
    artworkEl.style.transition = 'none'; artworkEl.style.opacity = '0'; artworkEl.style.transform = `translateX(${goingRight ? '16px' : '-16px'})`;
    loadTrack(index); playAudio();
    requestAnimationFrame(() => { requestAnimationFrame(() => { artworkEl.style.transition = 'opacity 0.2s ease, transform 0.2s ease'; artworkEl.style.opacity = '1'; artworkEl.style.transform = 'translateX(0)'; }); });
  }
}

let filteredIndices = [];
const ROW_HEIGHT = 34;
const playlistScroller = document.createElement('div');
playlistScroller.style.position = 'relative'; playlistScroller.style.width = '100%';

function initVirtualList() { if (!playlistEl) return; playlistEl.innerHTML = ''; playlistEl.appendChild(playlistScroller); playlistEl.addEventListener('scroll', () => { if (currentViewMode === 'queue') renderVirtualItems(); }); }

function renderVirtualItems() {
  if (queue.length === 0) { playlistScroller.style.height = '0px'; if (playlistEmpty) { playlistEmpty.style.display = 'block'; playlistScroller.replaceChildren(playlistEmpty); } return; }
  if (playlistEmpty) playlistEmpty.style.display = 'none';
  // The Spotify layout intentionally uses taller artwork rows; keep the virtual spacer and
  // absolute item positions in sync with that visual height.
  const rowHeight = document.body.classList.contains('spotify-layout') ? 60 : ROW_HEIGHT;
  const scrollTop = playlistEl.scrollTop, containerHeight = playlistEl.clientHeight || 400;
  const startIdx = Math.floor(scrollTop / rowHeight), endIdx = Math.ceil((scrollTop + containerHeight) / rowHeight);
  const buffer = 5, renderStart = Math.max(0, startIdx - buffer), renderEnd = Math.min(filteredIndices.length - 1, endIdx + buffer);
  playlistScroller.style.height = (filteredIndices.length * rowHeight) + 'px';
  const existingItems = new Map();
  for (const child of playlistScroller.children) { if (child.dataset.originalIndex !== undefined) existingItems.set(parseInt(child.dataset.originalIndex), child); }
  const newItems = [];
  const isMax = document.body.classList.contains('maximized') || document.body.classList.contains('wide');
  for (let i = renderStart; i <= renderEnd; i++) {
    const originalIdx = filteredIndices[i], track = queue[originalIdx]; if (!track) continue;
    let item = existingItems.get(originalIdx);
    if (!item) {
      item = document.createElement('div'); item.style.position = 'absolute'; item.dataset.originalIndex = originalIdx;
      if (track.type === 'folder') {
        item.style.pointerEvents = 'auto'; item.style.cursor = 'pointer';
        item.addEventListener('click', (e) => { if (expandedFolders.has(track.path)) expandedFolders.delete(track.path); else expandedFolders.add(track.path); renderQueue(); saveQueue(); });
        item.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, originalIdx); });
      } else {
        item.addEventListener('click', (e) => { if (e.target.classList.contains('item-artist')) { e.stopPropagation(); const artist = queue[originalIdx].artist; if (artist) searchArtist(artist); return; } switchTrackSmooth(originalIdx); });
        item.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, originalIdx); });
      }
    }
    item.style.top = (i * rowHeight) + 'px'; item.style.height = rowHeight + 'px'; item.style.width = '100%';
    let newClassName = '', newInnerHTML = '';
    if (track.type === 'folder') {
      let isExpanded = expandedFolders.has(track.path);
      if (searchActive) { const nextOriginalIdx = i + 1 < filteredIndices.length ? filteredIndices[i + 1] : null, nextTrack = nextOriginalIdx != null ? queue[nextOriginalIdx] : null; isExpanded = nextTrack && nextTrack.parentPath === track.path; }
      newClassName = 'playlist-folder' + (isExpanded ? ' expanded' : '') + (i % 2 === 1 ? ' zebra' : ''); newInnerHTML = `<span class=\"item-name\">${escHtml(track.name)}</span>`;
    } else {
      const isInFolder = track.parentPath && (searchActive || expandedFolders.has(track.parentPath));
      newClassName = 'playlist-item' + (originalIdx === currentIndex ? ' active' : '') + (isInFolder ? ' in-folder' : '') + (i % 2 === 1 ? ' zebra' : '');
      const dur = track.duration ? formatTime(track.duration) : '—', artist = track.artist || '—';
      // #5: Use pre-computed _displayNum instead of an O(n) inner loop
      const displayNum = track._displayNum ?? 1;
      let statusIcon; if (originalIdx === currentIndex) { if (isPlaying) statusIcon = '<div class=\"mini-eq\"><span></span><span></span><span></span></div>'; else statusIcon = PLAY_INDICATOR_SVG; } else { statusIcon = displayNum; }
      if (document.body.classList.contains('spotify-layout')) {
        const artworkUrl = coverDataUrl(track);
        const artworkStyle = artworkUrl ? ` style=\"background-image:url('${artworkUrl}')\"` : '';
        newInnerHTML = `<span class=\"item-index\">${statusIcon}</span><span class=\"spotify-track-art\"${artworkStyle}></span><span class=\"item-name\">${escHtml(track.name)}</span><span class=\"item-artist\">${escHtml(artist)}</span><span class=\"item-duration\">${escHtml(dur)}</span>`;
      }
      else if (isMax) newInnerHTML = `<span class=\"item-index\">${statusIcon}</span><span class=\"item-name\">${escHtml(track.name)}</span><span class=\"item-artist\">${escHtml(artist)}</span><span class=\"item-duration\">${escHtml(dur)}</span><span class=\"item-ext\">${escHtml(track.ext)}</span>`;
      else newInnerHTML = `<span class=\"item-index\">${statusIcon}</span><span class=\"item-name\">${escHtml(track.name)}</span><span class=\"item-duration\">${escHtml(dur)}</span><span class=\"item-ext\">${escHtml(track.ext)}</span>`;
    }
    if (item.className !== newClassName) item.className = newClassName;
    if (item.dataset.lastHtml !== newInnerHTML) { item.innerHTML = newInnerHTML; item.dataset.lastHtml = newInnerHTML; }
    newItems.push(item); existingItems.delete(originalIdx);
  }
  for (const unusedItem of existingItems.values()) unusedItem.remove();
  playlistScroller.append(...newItems);
}

let cmTargetIndex = -1;
let cmTargetIsPlaylist = false;
function showContextMenu(x, y, index, isPlaylist = false) {
  if (!contextMenu) return;
  cmTargetIndex = index;
  cmTargetIsPlaylist = isPlaylist;
  contextMenu.style.display = 'block'; const menuWidth = contextMenu.offsetWidth, menuHeight = contextMenu.offsetHeight, winWidth = window.innerWidth, winHeight = window.innerHeight;
  if (x + menuWidth > winWidth) x -= menuWidth; if (y + menuHeight > winHeight) y -= menuHeight;
  contextMenu.style.left = x + 'px'; contextMenu.style.top = y + 'px';
  
  if (isPlaylist) {
    if (cmAddToPlaylist) cmAddToPlaylist.style.display = 'none';
    if (cmCreatePlaylist) cmCreatePlaylist.style.display = 'none';
    if (cmCopy) cmCopy.style.display = 'none';
    if (cmOpen) cmOpen.style.display = 'none';
    if (cmRemove) cmRemove.style.display = 'none';
    if (cmEditPlaylist) cmEditPlaylist.style.display = 'flex';
    if (cmDeletePlaylist) cmDeletePlaylist.style.display = 'flex';
  } else {
    const track = queue[index]; if (!track) return;
    if (cmAddToPlaylist) cmAddToPlaylist.style.display = track.type === 'folder' ? 'none' : 'flex';
    if (cmCreatePlaylist) cmCreatePlaylist.style.display = track.type === 'folder' ? 'none' : 'flex';
    if (cmCopy) cmCopy.style.display = track.type === 'folder' ? 'none' : 'flex';
    if (cmOpen) {
      cmOpen.style.display = 'flex';
      cmOpen.textContent = track.type === 'folder' ? 'Open location' : 'Open in folder';
    }
    if (cmRemove) {
      cmRemove.style.display = 'flex';
      cmRemove.textContent = 'Remove from queue';
    }
    if (cmEditPlaylist) cmEditPlaylist.style.display = 'none';
    if (cmDeletePlaylist) cmDeletePlaylist.style.display = 'none';
  }
}
function closeContextMenu() { if (contextMenu) contextMenu.style.display = 'none'; cmTargetIndex = -1; cmTargetIsPlaylist = false; }
document.addEventListener('click', () => closeContextMenu());
document.addEventListener('wheel', () => closeContextMenu(), { passive: true });
window.addEventListener('resize', () => closeContextMenu());
if (cmCopy) cmCopy.addEventListener('click', () => { if (cmTargetIndex === -1 || cmTargetIsPlaylist) return; const track = queue[cmTargetIndex], text = track.artist ? `${track.name} - ${track.artist}` : track.name; navigator.clipboard.writeText(text); });
if (cmOpen) cmOpen.addEventListener('click', () => { if (cmTargetIndex === -1 || cmTargetIsPlaylist) return; const track = queue[cmTargetIndex]; if (window.electronAPI?.showInFolder) window.electronAPI.showInFolder(track.path); });

if (cmDeletePlaylist) {
  cmDeletePlaylist.addEventListener('click', () => {
    if (cmTargetIndex === -1 || !cmTargetIsPlaylist) return;
    userPlaylists.splice(cmTargetIndex, 1);
    savePlaylists();
    renderPlaylistsView();
  });
}

const cmEditPlaylist = document.getElementById('cm-edit-playlist');
if (cmEditPlaylist) {
  cmEditPlaylist.addEventListener('click', () => {
    if (cmTargetIndex === -1 || !cmTargetIsPlaylist) return;
    const pl = userPlaylists[cmTargetIndex];
    
    playlistModalTitle.textContent = 'EDIT PLAYLIST';
    playlistModalContent.innerHTML = '';
    
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'playlist-modal-input';
    nameInput.value = pl.name;
    nameInput.placeholder = 'Playlist name';
    
    const artContainer = document.createElement('div');
    artContainer.style.display = 'flex';
    artContainer.style.gap = '8px';
    
    const artInput = document.createElement('input');
    artInput.type = 'text';
    artInput.className = 'playlist-modal-input';
    artInput.style.flex = '1';
    artInput.value = pl.art || '';
    artInput.placeholder = 'Playlist cover URL (optional)';
    
    const pickImgBtn = document.createElement('button');
    pickImgBtn.className = 'playlist-modal-submit';
    pickImgBtn.textContent = 'BROWSE';
    let pickedImagePath = null;
    pickImgBtn.addEventListener('click', async () => {
      if (window.electronAPI?.pickImage) {
        const p = await window.electronAPI.pickImage();
        if (p) {
          pickedImagePath = p;
          artInput.value = 'file:///' + p.replace(/\\/g, '/');
        }
      }
    });
    
    artContainer.appendChild(artInput);
    artContainer.appendChild(pickImgBtn);
    
    const submitBtn = document.createElement('button');
    submitBtn.className = 'playlist-modal-submit';
    submitBtn.textContent = 'SAVE CHANGES';
    
    submitBtn.addEventListener('click', async () => {
      const newName = nameInput.value.trim() || 'Unnamed Playlist';
      pl.name = newName;
      
      let finalArtUrl = artInput.value.trim() || null;
      
      if (pickedImagePath && window.electronAPI?.copyImageToPlaylist) {
        const res = await window.electronAPI.copyImageToPlaylist(pickedImagePath, newName);
        if (res.success) {
          // add cache buster to force reload if the user replaces with an image of same name
          finalArtUrl = 'file:///' + res.newPath.replace(/\\/g, '/') + '?t=' + Date.now();
        }
      }
      
      pl.art = finalArtUrl;
      savePlaylists();
      renderPlaylistsView();
      closePlaylistModal();
    });
    
    playlistModalContent.appendChild(nameInput);
    playlistModalContent.appendChild(artContainer);
    playlistModalContent.appendChild(submitBtn);
    openPlaylistModal();
    requestAnimationFrame(() => nameInput.focus());
  });
}

if (cmCreatePlaylist) {
  cmCreatePlaylist.addEventListener('click', async () => {
    if (cmTargetIndex === -1 || cmTargetIsPlaylist) return;
    const track = queue[cmTargetIndex];
    
    if (!appSettings.playlistsDir) {
      playlistModalTitle.textContent = 'SETUP PLAYLISTS';
      playlistModalContent.innerHTML = '';
      
      const p = document.createElement('div');
      p.style.fontSize = '12px';
      p.style.color = 'var(--text)';
      p.style.marginBottom = '10px';
      p.style.textAlign = 'center';
      p.textContent = 'Please select a directory where Lyra should create your playlists.';
      
      const btn = document.createElement('button');
      btn.className = 'playlist-modal-submit';
      btn.textContent = 'SELECT DIRECTORY';
      btn.addEventListener('click', async () => {
        if (window.electronAPI?.pickDirectory) {
          const dir = await window.electronAPI.pickDirectory();
          if (dir) {
            if (playlistsDirInput) playlistsDirInput.value = dir;
            appSettings.playlistsDir = dir;
            if (window.electronAPI.setAppSettings) await window.electronAPI.setAppSettings(appSettings);
            
            // Continue to create playlist
            closePlaylistModal();
            setTimeout(() => {
              const rect = cmCreatePlaylist.getBoundingClientRect();
              const simulatedEvent = { clientX: rect.left, clientY: rect.top, target: cmCreatePlaylist };
              // We just re-trigger the click event now that the directory is set
              cmCreatePlaylist.click();
            }, 100);
          }
        }
      });
      
      playlistModalContent.appendChild(p);
      playlistModalContent.appendChild(btn);
      openPlaylistModal();
      return;
    }
    
    playlistModalTitle.textContent = 'CREATE PLAYLIST';
    playlistModalContent.innerHTML = '';
    
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'playlist-modal-input';
    input.placeholder = 'Playlist name';
    
    const submitBtn = document.createElement('button');
    submitBtn.className = 'playlist-modal-submit';
    submitBtn.textContent = 'CREATE & ADD';
    
    submitBtn.addEventListener('click', async () => {      const name = input.value.trim() || 'New Playlist';
      
      if (window.electronAPI?.createPlaylistFolder) {
        await window.electronAPI.createPlaylistFolder(name);
      }
      
      let newPath = track.path;
      if (window.electronAPI?.moveTrackToPlaylist && track.type !== 'folder') {
        const res = await window.electronAPI.moveTrackToPlaylist(track.path, name);
        if (res.success) newPath = res.newPath;
        else showToast('Failed to move track: ' + res.error);
      }
      
      const updatedTrack = { ...track, path: newPath };
      
      // #4: Call updateTrackPathEverywhere BEFORE pushing the new playlist entry,
      // so the update scan doesn't encounter the already-updated path in the new playlist.
      updateTrackPathEverywhere(track.path, newPath);

      const pl = {
        id: generateId(),
        name,
        // #22: Don't store the lyra:// URL (encodes the audio file path — breaks if files move).
        // Art is always derivable from the current track path on demand.
        art: null,
        tracks: [updatedTrack]
      };
      userPlaylists.push(pl);
      savePlaylists();
      closePlaylistModal();
      showToast(`Added to new playlist: ${name}`);
    });
    
    playlistModalContent.appendChild(input);
    playlistModalContent.appendChild(submitBtn);
    openPlaylistModal();
    requestAnimationFrame(() => input.focus());
  });
}

if (cmAddToPlaylist) {
  cmAddToPlaylist.addEventListener('click', () => {
    if (cmTargetIndex === -1 || cmTargetIsPlaylist) return;
    const track = queue[cmTargetIndex];
    
    playlistModalTitle.textContent = 'ADD TO PLAYLIST';
    playlistModalContent.innerHTML = '';
    
    if (userPlaylists.length === 0) {
      const p = document.createElement('div');
      p.style.fontSize = '11px';
      p.style.color = 'var(--text-dim)';
      p.textContent = 'No playlists available. Please create one first.';
      playlistModalContent.appendChild(p);
    } else {
      userPlaylists.forEach((pl, idx) => {
        const btn = document.createElement('button');
        btn.className = 'playlist-modal-btn';
        btn.textContent = pl.name;
        btn.addEventListener('click', async () => {
          let newPath = track.path;
          if (window.electronAPI?.moveTrackToPlaylist && track.type !== 'folder') {
            const res = await window.electronAPI.moveTrackToPlaylist(track.path, pl.name);
            if (res.success) newPath = res.newPath;
            else showToast('Failed to move track: ' + res.error);
          }
          // #2/#19: Update paths BEFORE pushing so the scan doesn't double-process the new entry.
          // Also skip storing a lyra:// URL as art — it encodes the file path and breaks if files move.
          updateTrackPathEverywhere(track.path, newPath);
          const updatedTrack = { ...track, path: newPath };
          pl.tracks.push(updatedTrack);
          savePlaylists();
          closePlaylistModal();
          showToast(`Added to playlist: ${pl.name}`);
        });
        playlistModalContent.appendChild(btn);
      });
    }
    
    openPlaylistModal();
  });
}

let _toastTimer = null; // #20: Module-scope timer; avoids storing state as a DOM element property
function showToast(msg) {
  let toast = document.getElementById('lyra-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'lyra-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '30px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.background = 'var(--accent)';
    toast.style.color = 'var(--bg)';
    toast.style.padding = '8px 16px';
    toast.style.borderRadius = '20px';
    toast.style.fontFamily = 'var(--font-mono)';
    toast.style.fontSize = '12px';
    toast.style.zIndex = '9999';
    toast.style.pointerEvents = 'none';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
}

if (cmRemove) cmRemove.addEventListener('click', () => {
  if (cmTargetIndex === -1 || cmTargetIsPlaylist) return; const index = cmTargetIndex, track = queue[index];
  if (track.type === 'folder') {
    const folderPath = track.path, toRemove = [];
    for (let i = 0; i < queue.length; i++) { if (queue[i].path === folderPath || queue[i].path.startsWith(folderPath + '\\') || queue[i].path.startsWith(folderPath + '/')) toRemove.push(i); }
    toRemove.sort((a, b) => b - a);
    for (const idx of toRemove) { queue.splice(idx, 1); if (idx < currentIndex) currentIndex--; else if (idx === currentIndex) currentIndex = -1; }
    if (currentIndex === -1 && queue.length > 0) { const next = getNextPlayable(-1, 1); if (next !== -1) loadTrack(next); else resetPlayer(); }
    else if (queue.length === 0) resetPlayer();
    renderQueue(); renderQueuePreview(); renderCarousel(); saveQueue();
    showToast('Folder removed from queue');
  } else {
    removeTrack(index);
    showToast('Song removed from queue');
  }
});

function renderQueue() {
  if (currentViewMode !== 'queue') return;
  if (!searchActive) {
    filteredIndices = [];
    if (foldersHidden) {
      const folderPaths = new Set();
      for (const t of queue) if (t.type === 'folder') folderPaths.add(t.path);
      for (let i = 0; i < queue.length; i++) {
        const t = queue[i];
        if (t.type !== 'folder' && !folderPaths.has(t.parentPath)) filteredIndices.push(i);
      }
    } else {
      let skipUntilParentNot = null;
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        if (skipUntilParentNot) { if (item.path.startsWith(skipUntilParentNot + '\\') || item.path.startsWith(skipUntilParentNot + '/')) continue; else skipUntilParentNot = null; }
        filteredIndices.push(i);
        if (item.type === 'folder' && !expandedFolders.has(item.path)) skipUntilParentNot = item.path;
      }
    }
  } else { if (searchInput) applySearch(searchInput.value, true); return; }
  if (document.body.classList.contains('spotify-layout') && settings.spotifySidebarMode === 'root') {
    if (spotifySelectedFolderPath) {
      filteredIndices = queue.reduce((indices, track, index) => {
        if (track.parentPath === spotifySelectedFolderPath) indices.push(index);
        return indices;
      }, []);
    } else {
      const folderPaths = new Set(queue.filter(track => track.type === 'folder').map(track => track.path));
      filteredIndices = queue.reduce((indices, track, index) => {
        if (!folderPaths.has(track.parentPath)) indices.push(index);
        return indices;
      }, []);
    }
  }
  renderVirtualItems();
}
function updateQueueActiveItem(newIdx) { renderVirtualItems(); }
function applySearch(q, force = false) {
  const query = q.toLowerCase().trim();
  if (!query) { renderQueue(); return; }
  else {
    filteredIndices = []; 
    const folderPaths = new Set();
    const folderMap = new Map();
    if (foldersHidden) { for (const t of queue) if (t.type === 'folder') folderPaths.add(t.path); }
    else { queue.forEach((t, i) => { if (t.type === 'folder') folderMap.set(t.path, i); }); }
    const matchedFolders = new Set();
    queue.forEach((track, i) => {
      if (track._searchKey && track._searchKey.includes(query)) {
        if (foldersHidden && folderPaths.has(track.parentPath)) return;
        if (!foldersHidden && track.parentPath) { const folderIdx = folderMap.get(track.parentPath); if (folderIdx !== undefined && !matchedFolders.has(folderIdx)) { matchedFolders.add(folderIdx); filteredIndices.push(folderIdx); } }
        filteredIndices.push(i);
      } else if (!foldersHidden && track.type === 'folder' && track.name.toLowerCase().includes(query) && !matchedFolders.has(i)) {
        // #12: Guard prevents the same folder index being pushed twice (once via a matching
        // track, and again via folder-name match), eliminating the need for a Set dedup pass.
        matchedFolders.add(i); filteredIndices.push(i);
      }
    });
    // Items are visited in queue order; the only reordering needed is folder headers injected
    // mid-iteration. A single sort is cheaper than constructing a Set on every keystroke.
    filteredIndices.sort((a, b) => a - b);
  }
  renderVirtualItems();
}

function addTracks(tracks, fromPlaylist) {
  queue.push(...prepareTracks(tracks));
  if (!fromPlaylist && playlistLabel) { currentPlaylistName = null; playlistLabel.textContent = 'QUEUE'; }
  renderQueue(); renderQueuePreview(); renderCarousel(); if (animStyle === 'off') updateCoverStrip();
  if (currentIndex === -1 && queue.length > 0) { const next = getNextPlayable(-1, 1); if (next !== -1) loadTrack(next); }
  saveQueue(); renderSpotifySidebar();
}
function removeTrack(index) {
  queue.splice(index, 1); if (index < currentIndex) currentIndex--;
  else if (index === currentIndex) { if (queue.length === 0) { resetPlayer(); saveQueue(); return; } loadTrack(Math.min(currentIndex, queue.length - 1)); if (isPlaying) playAudio(); saveQueue(); return; }
  renderQueue(); renderQueuePreview(); renderCarousel(); if (animStyle === 'off') updateCoverStrip(); saveQueue();
}
function clearQueue() { queue = []; currentIndex = -1; currentPlaylistName = null; if (playlistLabel) playlistLabel.textContent = 'QUEUE'; resetPlayer(); saveQueue(); }
function resetPlayer() {
  audio.pause(); audio.src = ''; isPlaying = false; currentIndex = -1; trackTitle.textContent = 'No track loaded'; trackMeta.textContent = '— · —'; if (miniTitle) miniTitle.textContent = 'No track loaded'; if (miniArtist) miniArtist.textContent = '— · —'; timeCurrent.textContent = '0:00'; timeTotal.textContent = '0:00'; progressFill.style.width = '0%'; progressThumb.style.left = '0%'; if (miniProgressFill) miniProgressFill.style.width = '0%'; coverImg.src = ''; coverImg.style.display = 'none'; artPlaceholder.style.display = 'flex'; if (miniCover) miniCover.src = ''; artworkEl.classList.remove('playing', 'has-cover'); artworkEl.style.opacity = ''; artworkEl.style.transform = ''; artworkEl.style.transition = ''; bumpActive = false; if (bumpWrap) { bumpWrap.style.transform = ''; bumpWrap.style.transition = ''; } setPlayIcon(false); stopSpectrum(); updateMediaSession(null); updateSpotifyNowPlaying(null); if (window.electronAPI?.updateDiscord) window.electronAPI.updateDiscord(null); renderQueue(); renderQueuePreview(); renderCarousel(); if (animStyle === 'off') updateCoverStrip();
}

function loadTrack(index) {
  if (index < 0 || index >= queue.length) return;
  const track = queue[index]; if (track.type === 'folder') { const next = getNextPlayable(index, 1); if (next !== -1) loadTrack(next); return; }
  currentIndex = index;
  if (settings.theme === 'dynamic') applyDynamicTheme(track);
  // #20: Use correct file:/// URL with forward slashes (required on Windows)
  audio.src = 'file:///' + track.path.replace(/\\/g, '/'); trackTitle.textContent = track.name; trackMeta.textContent = track.artist || '—'; if (miniTitle) miniTitle.textContent = track.name; if (miniArtist) miniArtist.textContent = track.artist || '—'; timeCurrent.textContent = '0:00'; timeTotal.textContent = '0:00'; progressFill.style.width = '0%'; progressThumb.style.left = '0%'; if (miniProgressFill) miniProgressFill.style.width = '0%';
  const url = coverDataUrl(track);
  if (url) {
    coverImg.src = url; coverImg.style.display = 'block'; artPlaceholder.style.display = 'none'; artworkEl.classList.add('has-cover');
    if (miniCover) miniCover.src = url;
    coverImg.onerror = () => { coverImg.src = ''; coverImg.style.display = 'none'; artPlaceholder.style.display = 'flex'; artworkEl.classList.remove('has-cover'); if (miniCover) miniCover.src = ''; };
  } else { coverImg.src = ''; coverImg.style.display = 'none'; artPlaceholder.style.display = 'flex'; artworkEl.classList.remove('has-cover'); if (miniCover) miniCover.src = ''; }
  updateMediaSession(track); updateSpotifyNowPlaying(track); updateQueueActiveItem(index); if (typeof updateFsView !== 'undefined') updateFsView();
  const dir = typeof _pendingDirection !== 'undefined' ? _pendingDirection : undefined; _pendingDirection = undefined; renderQueuePreview(dir); renderCarousel(dir); if (animStyle === 'off') updateCoverStrip(dir); saveQueue();
  const activeItem = playlistEl.querySelector('.playlist-item.active'); if (activeItem) activeItem.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function playAudio() { audio.play().catch(() => {}); }
function pauseAudio() { audio.pause(); }

audio.addEventListener('play', () => {
  isPlaying = true; artworkEl.classList.add('playing'); setPlayIcon(true); startSpectrum(); queuePreview?.querySelector('.qp-item.is-current')?.classList.add('is-playing');
  const centerItem = coverCarousel?.querySelector('.cc-item.is-center');
  if (centerItem) {
    centerItem.classList.add('is-playing'); const playIcon = centerItem.querySelector('.cc-icon-play-animate');
    if (playIcon) { playIcon.classList.remove('trigger'); void playIcon.offsetWidth; playIcon.classList.add('trigger'); }
  }
  renderVirtualItems(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  if (window.electronAPI?.updateDiscord && queue[currentIndex]) window.electronAPI.updateDiscord({ track: queue[currentIndex], isPlaying: true, currentTime: audio.currentTime });
});
audio.addEventListener('pause', () => {
  isPlaying = false; artworkEl.classList.remove('playing'); setPlayIcon(false); stopSpectrum(); queuePreview?.querySelector('.qp-item.is-current')?.classList.remove('is-playing');
  const centerItem = coverCarousel?.querySelector('.cc-item.is-center');
  if (centerItem) {
    centerItem.classList.remove('is-playing'); const pauseIcon = centerItem.querySelector('.cc-icon-pause');
    if (pauseIcon) { pauseIcon.classList.remove('trigger'); void pauseIcon.offsetWidth; pauseIcon.classList.add('trigger'); }
  }
  renderVirtualItems(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  if (window.electronAPI?.updateDiscord && queue[currentIndex]) window.electronAPI.updateDiscord({ track: queue[currentIndex], isPlaying: false, currentTime: audio.currentTime });
});
audio.addEventListener('seeked', () => {
  if (isPlaying && window.electronAPI?.updateDiscord && queue[currentIndex]) window.electronAPI.updateDiscord({ track: queue[currentIndex], isPlaying: true, currentTime: audio.currentTime });
});
function togglePlay() { 
  if (typeof ensureAudioCtx === 'function') ensureAudioCtx();
  if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') { audioCtx.resume(); }
  if (queue.length === 0) return; 
  if (currentIndex === -1) { const next = getNextPlayable(-1, 1); if (next !== -1) { loadTrack(next); playAudio(); } return; } 
  if (isPlaying) pauseAudio(); else playAudio(); 
}
function setPlayIcon(playing) { if (iconPlay) iconPlay.style.display = playing ? 'none' : ''; if (iconPause) iconPause.style.display = playing ? '' : 'none'; if (typeof fsIconPlay !== 'undefined' && fsIconPlay) fsIconPlay.style.display = playing ? 'none' : ''; if (typeof fsIconPause !== 'undefined' && fsIconPause) fsIconPause.style.display = playing ? '' : 'none'; if (miniIconPlay) miniIconPlay.style.display = playing ? 'none' : ''; if (miniIconPause) miniIconPause.style.display = playing ? '' : 'none'; }

function getNextPlayable(index, direction = 1) {
  if (queue.length === 0) return -1;

  if (foldersHidden) {
    if (index === -1) {
      for (let i = 0; i < queue.length; i++) { if (queue[i].type !== 'folder') return i; }
      return -1;
    }
    let next = index;
    for (let i = 0; i < queue.length; i++) {
      next = (next + direction + queue.length) % queue.length;
      if (queue[next].type !== 'folder') return next;
      if (next === index) break;
    }
    return -1;
  }

  if (index === -1) {
    let shallowest = null; for (const item of queue) { if (item.type === 'folder') continue; const p = item.parentPath; if (p && (!shallowest || p.length < shallowest.length)) shallowest = p; }
    for (let i = 0; i < queue.length; i++) { if (queue[i].type !== 'folder' && queue[i].parentPath === shallowest) return i; }
    for (let i = 0; i < queue.length; i++) { if (queue[i].type !== 'folder') return i; }
    return -1;
  }
  const currentTrack = queue[index]; if (!currentTrack) return -1; const currentParent = currentTrack.parentPath, siblings = [];
  for (let i = 0; i < queue.length; i++) { if (queue[i].type !== 'folder' && queue[i].parentPath === currentParent) siblings.push(i); }
  if (siblings.length === 0) return -1; const sibIdx = siblings.indexOf(index); if (sibIdx === -1) return siblings[0];
  const nextSibIdx = (sibIdx + direction + siblings.length) % siblings.length; return siblings[nextSibIdx];
}
function nextTrack() {
  if (queue.length === 0) return; if (repeatMode === 2) { audio.currentTime = 0; playAudio(); return; }
  let next; if (isShuffle) { const playables = queue.map((t, i) => t.type !== 'folder' ? i : -1).filter(i => i !== -1); if (playables.length === 0) return; next = playables[Math.floor(Math.random() * playables.length)]; }
  else { next = getNextPlayable(currentIndex, 1); if (next === -1) { if (repeatMode === 1) next = getNextPlayable(-1, 1); else { pauseAudio(); return; } } }
  if (next !== -1) switchTrackSmooth(next);
}
function prevTrack() {
  if (queue.length === 0) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let prev = getNextPlayable(currentIndex, -1);
  // #19: The original else-branch was identical to the if-branch (dead code).
  // Now: repeat-all wraps to first, otherwise stop at beginning.
  if (prev === -1) {
    if (repeatMode === 1) prev = getNextPlayable(-1, 1);
    else return; // Already at the beginning — do nothing
  }
  if (prev !== -1) switchTrackSmooth(prev);
}

audio.addEventListener('timeupdate', () => { if (!audio.duration) return; const pct = audio.currentTime / audio.duration; if (progressFill) progressFill.style.width = (pct * 100) + '%'; if (progressThumb) progressThumb.style.left = (pct * 100) + '%'; if (timeCurrent) timeCurrent.textContent = formatTime(audio.currentTime); if (typeof fsProgressFill !== 'undefined' && fsProgressFill) fsProgressFill.style.width = (pct * 100) + '%'; if (miniProgressFill) miniProgressFill.style.width = (pct * 100) + '%'; if (typeof fsTimeCurrent !== 'undefined' && fsTimeCurrent) fsTimeCurrent.textContent = formatTime(audio.currentTime); if ('mediaSession' in navigator && audio.duration) navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime }); });
audio.addEventListener('loadedmetadata', () => {
  if (timeTotal) timeTotal.textContent = formatTime(audio.duration); if (typeof fsTimeTotal !== 'undefined' && fsTimeTotal) fsTimeTotal.textContent = formatTime(audio.duration); if (currentIndex >= 0 && queue[currentIndex]) {
    queue[currentIndex].duration = audio.duration; const itemEl = playlistScroller.querySelector(`[data-original-index="${currentIndex}"]`);
    if (itemEl) {
      const durSpan = itemEl.querySelector('.item-duration'); if (durSpan) durSpan.textContent = formatTime(audio.duration);
      const track = queue[currentIndex], artist = track.artist || '—', tooltipParts = [`Title: ${track.name}`, `Artist: ${artist}`, `Duration: ${formatTime(audio.duration)}`, `Format: ${track.ext}`]; if (track.size) tooltipParts.push(`Size: ${(track.size / 1024 / 1024).toFixed(2)} MB`); itemEl.title = tooltipParts.join('\n');
    }
  }
});
audio.addEventListener('ended', nextTrack);
audio.addEventListener('error', (e) => {
  const err = audio.error;
  let msg = 'Unknown playback error';
  if (err) {
    switch (err.code) {
      case 1: msg = 'Playback aborted'; break;
      case 2: msg = 'Network error'; break;
      case 3: msg = 'Decode error'; break;
      case 4: msg = 'File not found or format not supported'; break;
    }
  }
  showToast('Error: ' + msg);
  console.error('Audio Error:', err, 'src:', audio.src);
});
function seekTo(e) { if (!progressBar) return; const rect = progressBar.getBoundingClientRect(), pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)); if (audio.duration) audio.currentTime = pct * audio.duration; }
let seekDragging = false; if (progressBar) progressBar.addEventListener('mousedown', (e) => { seekDragging = true; seekTo(e); }); document.addEventListener('mousemove', (e) => { if (seekDragging) seekTo(e); }); document.addEventListener('mouseup', () => { seekDragging = false; });

function setVolume(v) { volume = Math.max(0, Math.min(1, v)); audio.volume = isMuted ? 0 : volume; const pct = (volume * 100).toFixed(1) + '%'; if (volumeFill) volumeFill.style.width = pct; if (volumeThumb) volumeThumb.style.left = pct; if (volumeVal) volumeVal.textContent = Math.round(volume * 100); settings.volume = volume; saveSettings(); }
function setVolumeFromClick(e) { if (!volumeBar) return; const rect = volumeBar.getBoundingClientRect(); setVolume((e.clientX - rect.left) / rect.width); }
let volDragging = false; if (volumeBar) volumeBar.addEventListener('mousedown', (e) => { volDragging = true; setVolumeFromClick(e); }); document.addEventListener('mousemove', (e) => { if (volDragging) setVolumeFromClick(e); }); document.addEventListener('mouseup', () => { volDragging = false; }); setVolume(volume);
function toggleMute() { isMuted = !isMuted; audio.volume = isMuted ? 0 : volume; if (iconVol) iconVol.style.display = isMuted ? 'none' : ''; if (iconMute) iconMute.style.display = isMuted ? '' : 'none'; }

function toggleShuffle() { isShuffle = !isShuffle; if (btnShuffle) btnShuffle.classList.toggle('active', isShuffle); }
function cycleRepeat() {
  if (!btnRepeat) return;
  repeatMode = (repeatMode + 1) % 3; btnRepeat.classList.toggle('active', repeatMode > 0); btnRepeat.title = ['Repeat: Off', 'Repeat: All', 'Repeat: One'][repeatMode];
  const existing = btnRepeat.querySelector('.rep-badge'); if (existing) existing.remove();
  if (repeatMode === 2) { const badge = document.createElement('span'); badge.className = 'rep-badge'; badge.style.cssText = 'position:absolute;top:3px;right:3px;font-size:8px;color:var(--accent);font-family:var(--font-mono);line-height:1;'; badge.textContent = '1'; btnRepeat.style.position = 'relative'; btnRepeat.appendChild(badge); }
}

let settingsPanelOpen = false;
function openSettings() { if (!settingsPanel) return; settingsPanelOpen = true; settingsPanel.classList.add('open'); btnSettings?.classList.add('open'); }
function closeSettings() { if (!settingsPanel) return; settingsPanelOpen = false; settingsPanel.classList.remove('open'); btnSettings?.classList.remove('open'); }
function toggleSettings() { if (settingsPanelOpen) closeSettings(); else openSettings(); }
btnSettings?.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); }); document.addEventListener('click', (e) => { if (settingsPanelOpen && settingsPanel && !settingsPanel.contains(e.target) && e.target !== btnSettings) closeSettings(); });
animOpts.forEach(btn => btn.addEventListener('click', () => applyAnimStyle(btn.dataset.anim)));

const EQ_BANDS = [ { freq: '60', label: '60Hz' }, { freq: '170', label: '170Hz' }, { freq: '350', label: '350Hz' }, { freq: '1K', label: '1kHz' }, { freq: '3.5K', label: '3.5kHz'}, { freq: '10K', label: '10kHz' } ];
const EQ_PRESETS = { flat: [0, 0, 0, 0, 0, 0], bass: [8, 6, 4, 0, 0, 0], vocal: [-2, 0, 4, 6, 4, 0], treble: [0, 0, -2, -2, 4, 8] };
let eqFilters = [], eqGains = (settings.eqBands || EQ_PRESETS.flat).slice(), eqEnabled = settings.eqEnabled || false;
function ensureEqFilters() { if (eqFilters.length) return; ensureAudioCtx(); const freqsHz = [60, 170, 350, 1000, 3500, 10000]; freqsHz.forEach((freq, i) => { const filter = audioCtx.createBiquadFilter(); filter.type = i === 0 ? 'lowshelf' : i === freqsHz.length - 1 ? 'highshelf' : 'peaking'; filter.frequency.value = freq; filter.Q.value = 1.2; filter.gain.value = 0; eqFilters.push(filter); }); sourceNode.disconnect(); eqFilters.reduce((prev, cur) => { prev.connect(cur); return cur; }, sourceNode); eqFilters[eqFilters.length - 1].connect(analyser); }
function applyEqGains() { if (!eqFilters.length) return; eqFilters.forEach((f, i) => { f.gain.value = eqEnabled ? (eqGains[i] || 0) : 0; }); updateEqStatus(); }
function updateEqStatus() {
  if (!eqPill) return;
  let presetName = 'CUSTOM';
  for (const [name, gains] of Object.entries(EQ_PRESETS)) { if (eqGains.every((v, i) => v === (gains[i] || 0))) { presetName = name.toUpperCase(); break; } }
  if (typeof eqPresetBtns !== 'undefined') {
    eqPresetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === presetName.toLowerCase()));
  }
  if (!eqEnabled) { eqPill.textContent = 'EQ: OFF'; eqPill.classList.remove('active'); }
  else {
    eqPill.textContent = `EQ: ${presetName}`; eqPill.classList.add('active');
  }
}
function renderEqBands() { if (!eqBandsEl) return; eqBandsEl.innerHTML = ''; EQ_BANDS.forEach((band, i) => { const gain = eqGains[i] || 0, bandEl = document.createElement('div'); bandEl.className = 'eq-band'; const valEl = document.createElement('div'); valEl.className = 'eq-val'; valEl.textContent = (gain >= 0 ? '+' : '') + gain; const wrapEl = document.createElement('div'); wrapEl.className = 'eq-slider-wrap'; const slider = document.createElement('input'); slider.type = 'range'; slider.className = 'eq-slider'; slider.min = '-12'; slider.max = '12'; slider.step = '1'; slider.value = gain; slider.addEventListener('input', () => { const v = parseInt(slider.value, 10); eqGains[i] = v; valEl.textContent = (v >= 0 ? '+' : '') + v; if (eqFilters[i]) eqFilters[i].gain.value = eqEnabled ? v : 0; settings.eqBands = eqGains.slice(); debouncedSaveSettings(); eqPresetBtns.forEach(b => b.classList.remove('active')); updateEqStatus(); }); const labelEl = document.createElement('div'); labelEl.className = 'eq-label'; labelEl.textContent = band.label; wrapEl.appendChild(slider); bandEl.appendChild(valEl); bandEl.appendChild(wrapEl); bandEl.appendChild(labelEl); eqBandsEl.appendChild(bandEl); }); }
function applyEqPreset(name) { const gains = EQ_PRESETS[name]; if (!gains) return; eqGains = gains.slice(); settings.eqBands = eqGains.slice(); saveSettings(); renderEqBands(); applyEqGains(); eqPresetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === name)); updateEqStatus(); }
function setEqEnabled(on) { eqEnabled = on; settings.eqEnabled = on; if (eqPanel) eqPanel.classList.toggle('eq-active', on); if (btnEqToggle) btnEqToggle.classList.toggle('eq-is-on', on); document.body.classList.toggle('eq-on', on); if (on) ensureEqFilters(); applyEqGains(); saveSettings(); updateEqStatus(); }
eqPresetBtns.forEach(btn => btn.addEventListener('click', () => applyEqPreset(btn.dataset.preset)));
if (eqPill) eqPill.addEventListener('click', (e) => { e.stopPropagation(); toggleEqPopup(); });
function openEqPopup() { if (!eqPanel) return; ensureAudioCtx(); renderEqBands(); eqPanel.classList.add('eq-visible'); if (eqBackdrop) eqBackdrop.classList.add('visible'); btnEqToggle?.classList.add('active'); if (eqOnoff) { eqOnoff.textContent = eqEnabled ? 'ON' : 'OFF'; eqOnoff.classList.toggle('on', eqEnabled); } }
function closeEqPopup() { if (!eqPanel) return; eqPanel.classList.remove('eq-visible'); if (eqBackdrop) eqBackdrop.classList.remove('visible'); btnEqToggle?.classList.remove('active'); }
function toggleEqPopup() { if (eqPanel?.classList.contains('eq-visible')) closeEqPopup(); else openEqPopup(); }
btnEqToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleEqPopup(); }); btnEqToggle?.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); setEqEnabled(!eqEnabled); if (eqOnoff) { eqOnoff.textContent = eqEnabled ? 'ON' : 'OFF'; eqOnoff.classList.toggle('on', eqEnabled); } }); if (btnEqClose) btnEqClose.addEventListener('click', closeEqPopup); if (eqBackdrop) eqBackdrop.addEventListener('click', closeEqPopup);
if (eqOnoff) eqOnoff.addEventListener('click', () => { setEqEnabled(!eqEnabled); eqOnoff.textContent = eqEnabled ? 'ON' : 'OFF'; eqOnoff.classList.toggle('on', eqEnabled); });
setEqEnabled(eqEnabled);

let appSettings = { closeMinimizes: false };
const playlistsDirInput = document.getElementById('playlists-dir-input');
const btnPickPlaylistsDir = document.getElementById('btn-pick-playlists-dir');

async function loadAppSettings() { 
  if (window.electronAPI?.getAppSettings) { 
    try { appSettings = await window.electronAPI.getAppSettings(); } catch (_) {} 
  } 
  if (toggleCloseMin) toggleCloseMin.setAttribute('aria-checked', appSettings.closeMinimizes ? 'true' : 'false');
  if (playlistsDirInput) playlistsDirInput.value = appSettings.playlistsDir || '';
}
loadAppSettings();

if (toggleCloseMin) toggleCloseMin.addEventListener('click', async () => { 
  appSettings.closeMinimizes = !appSettings.closeMinimizes; 
  toggleCloseMin.setAttribute('aria-checked', appSettings.closeMinimizes ? 'true' : 'false'); 
  if (window.electronAPI?.setAppSettings) await window.electronAPI.setAppSettings(appSettings); 
});

if (btnPickPlaylistsDir) {
  btnPickPlaylistsDir.addEventListener('click', async () => {
    if (window.electronAPI?.pickDirectory) {
      const dir = await window.electronAPI.pickDirectory();
      if (dir) {
        if (playlistsDirInput) playlistsDirInput.value = dir;
        appSettings.playlistsDir = dir;
        if (window.electronAPI?.setAppSettings) await window.electronAPI.setAppSettings(appSettings);
      }
    }
  });
}

let perfMode = false; try { perfMode = JSON.parse(localStorage.getItem('lyra-perf-mode') || 'false'); } catch (_) {}
function applyPerfMode(enabled) {
  perfMode = enabled; document.body.classList.toggle('perf-mode', enabled); if (togglePerfMode) togglePerfMode.setAttribute('aria-checked', enabled ? 'true' : 'false'); try { localStorage.setItem('lyra-perf-mode', JSON.stringify(enabled)); } catch (_) {}
  if (enabled && coverCarousel) coverCarousel.innerHTML = '';
  if (enabled) { if (queuePreview) { queuePreview.classList.remove('visible'); queuePreview.innerHTML = ''; } if (coverStrip) coverStrip.innerHTML = ''; applyAnimStyle('off'); document.querySelectorAll('.anim-opt').forEach(b => b.disabled = true); }
  else { document.querySelectorAll('.anim-opt').forEach(b => b.disabled = false); renderCarousel(); renderQueuePreview(); if (animStyle === 'off') updateCoverStrip(); }
}
applyPerfMode(perfMode); if (togglePerfMode) togglePerfMode.addEventListener('click', () => { applyPerfMode(!perfMode); });

if (btnExportPlaylist) {
  btnExportPlaylist.addEventListener('click', async () => {
    if (!queue.length) return; if (!window.electronAPI?.exportPlaylist) return alert('Export is only available in the Electron app.');
    const playlistData = { name: currentPlaylistName || 'Lyra Playlist', created: new Date().toISOString(), tracks: queue.map(t => ({ path: t.path, name: t.name, artist: t.artist || '', ext: t.ext, })), };
    const result = await window.electronAPI.exportPlaylist(playlistData);
    if (result?.success) { const orig = btnExportPlaylist.textContent; btnExportPlaylist.textContent = '✓ SAVED'; btnExportPlaylist.style.color = 'var(--accent)'; setTimeout(() => { btnExportPlaylist.textContent = orig; btnExportPlaylist.style.color = ''; }, 1800); }
  });
}

function updateMediaSession(track) { if (!('mediaSession' in navigator)) return; if (!track) { navigator.mediaSession.metadata = null; return; } const url = coverDataUrl(track), artwork = url ? [{ src: url, sizes: '512x512' }] : []; navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: track.artist || '', artwork }); }
function setupMediaSession() { if (!('mediaSession' in navigator)) return; const ms = navigator.mediaSession; ms.setActionHandler('play', () => playAudio()); ms.setActionHandler('pause', () => pauseAudio()); ms.setActionHandler('stop', () => pauseAudio()); ms.setActionHandler('nexttrack', () => nextTrack()); ms.setActionHandler('previoustrack', () => prevTrack()); ms.setActionHandler('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d?.seekOffset ?? 10)); }); ms.setActionHandler('seekforward', (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d?.seekOffset ?? 10)); }); }
setupMediaSession();

if (btnAddFiles) btnAddFiles.addEventListener('click', async () => { if (!window.electronAPI) return alert('Run inside Electron to load files.'); const tracks = await window.electronAPI.openFiles(); if (tracks.length) addTracks(tracks); });
if (btnAddFolder) btnAddFolder.addEventListener('click', async () => { if (!window.electronAPI) return alert('Run inside Electron to load a folder.'); const tracks = await window.electronAPI.openFolder(); if (tracks.length) addTracks(tracks); });
if (btnClear) btnClear.addEventListener('click', clearQueue);

// Spotify-layout navigation deliberately delegates to the same actions used by the classic UI.
document.getElementById('spotify-nav-search')?.addEventListener('click', () => {
  if (currentViewMode !== 'queue') { currentViewMode = 'queue'; initVirtualList(); renderQueue(); }
  openSearch();
});
document.getElementById('spotify-nav-library')?.addEventListener('click', () => {
  settings.spotifySidebarMode = 'root';
  restoreRootLibrary();
  saveSettings();
  renderSpotifySidebar();
  renderQueue();
  playlistEl?.scrollTo({ top: 0, behavior: 'smooth' });
});
document.getElementById('spotify-nav-home')?.addEventListener('click', () => {
  settings.spotifySidebarMode = 'playlists';
  saveSettings(); renderSpotifySidebar();
  playlistEl?.scrollTo({ top: 0, behavior: 'smooth' });
});
document.getElementById('spotify-library-mode')?.addEventListener('change', (event) => {
  const mode = event.target.value === 'root' ? 'root' : 'playlists';
  settings.spotifySidebarMode = mode;
  if (mode === 'root') restoreRootLibrary();
  saveSettings();
  renderSpotifySidebar();
});

let searchActive = false, searchQuery = '';
if (playlistLabelArea) playlistLabelArea.addEventListener('click', (e) => { if (!searchActive) openSearch(); });
if (searchInput) { const debouncedApplySearch = debounce((v) => applySearch(v), 250); searchInput.addEventListener('input', (e) => debouncedApplySearch(e.target.value)); searchInput.addEventListener('keydown', (e) => { if (e.code === 'Escape') closeSearch(); e.stopPropagation(); }); searchInput.addEventListener('click', (e) => e.stopPropagation()); }
document.addEventListener('click', (e) => { if (searchActive && !e.target.closest('.playlist-header') && !e.target.classList.contains('item-artist') && !e.target.classList.contains('track-meta') && !e.target.classList.contains('fs-artist')) closeSearch(); });
function openSearch() { if (searchActive || !playlistLabel || !headerSearchWrap || !playlistLabelArea || !searchInput) return; searchActive = true; playlistLabel.classList.add('hidden'); headerSearchWrap.classList.add('visible'); playlistLabelArea.classList.add('searching'); searchInput.focus(); }
function closeSearch() { if (!searchActive || !playlistLabel || !headerSearchWrap || !playlistLabelArea || !searchInput) return; searchActive = false; searchQuery = ''; searchInput.value = ''; playlistLabel.classList.remove('hidden'); headerSearchWrap.classList.remove('visible'); playlistLabelArea.classList.remove('searching'); renderQueue(); }

document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag-over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag-over'); });
// #4: Also clean up on dragend (fires when drop is cancelled, e.g. user presses Escape)
document.addEventListener('dragend', () => document.body.classList.remove('drag-over'));
document.addEventListener('drop', async (e) => { e.preventDefault(); document.body.classList.remove('drag-over'); const audioExts = ['mp3','flac','wav','ogg','m4a','aac','opus','wma'], filePaths = []; for (const file of e.dataTransfer.files) { const ext = file.name.split('.').pop().toLowerCase(); if (audioExts.includes(ext)) filePaths.push(file.path); } if (!filePaths.length) return; if (window.electronAPI?.buildTracks) { const tracks = await window.electronAPI.buildTracks(filePaths); if (tracks.length) addTracks(tracks); } else { const tracks = filePaths.map(fp => { const name = fp.split(/[\\\/]/).pop(), ext = name.split('.').pop().toLowerCase(); return { path: fp, name: name.replace(/\.[^.]+$/, ''), artist: '', ext: ext.toUpperCase(), size: 0, coverArt: null }; }); if (tracks.length) addTracks(tracks); } });

if (btnPlay) btnPlay.addEventListener('click', togglePlay); if (btnPrev) btnPrev.addEventListener('click', prevTrack); if (btnNext) btnNext.addEventListener('click', nextTrack); if (btnShuffle) btnShuffle.addEventListener('click', toggleShuffle); if (btnRepeat) btnRepeat.addEventListener('click', cycleRepeat); if (btnMute) btnMute.addEventListener('click', toggleMute);

function toggleFolders() {
  foldersHidden = !foldersHidden;
  settings.foldersHidden = foldersHidden;
  saveSettings();
  if (btnToggleFolders) btnToggleFolders.classList.toggle('active', foldersHidden);
  if (currentViewMode === 'queue') renderQueue();
}
if (btnToggleFolders) {
  btnToggleFolders.addEventListener('click', toggleFolders);
  if (foldersHidden) btnToggleFolders.classList.add('active');
}

let keybindings = { ' ': 'playpause', 'n': 'next', 'p': 'prev', 's': 'shuffle', 'r': 'repeat', 'm': 'mute', 'arrowright': 'seek_forward', 'arrowleft': 'seek_backward', 'arrowup': 'volume_up', 'arrowdown': 'volume_down', 'o': 'toggle_mini' };
let cfgFilePath = '';
function applyConfig(cfg) {
  if (cfg._cfgPath) { cfgFilePath = cfg._cfgPath; const cfgNote = document.getElementById('keybind-cfg-path'); if (cfgNote) cfgNote.textContent = cfgFilePath; }
  if (cfg.bindings) Object.assign(keybindings, cfg.bindings);
  if (cfg.theme) { for (const [k, v] of Object.entries(cfg.theme)) { if (k === 'bg' || k === 'bg_color') document.documentElement.style.setProperty('--bg', v); if (k === 'accent' || k === 'accent_color') { document.documentElement.style.setProperty('--accent', v); _accentRGBCache = null; renderQueuePreview(); renderCarousel(); if (animStyle === 'off') updateCoverStrip(); } if (k === 'text' || k === 'text_color') document.documentElement.style.setProperty('--text', v); } }
  if (cfg.settings) { const s = cfg.settings; if (s.startup_volume !== undefined) setVolume(s.startup_volume); if (s.close_minimizes !== undefined) { appSettings.closeMinimizes = s.close_minimizes; if (toggleCloseMin) toggleCloseMin.setAttribute('aria-checked', s.close_minimizes ? 'true' : 'false'); } if (s.performance_mode !== undefined) applyPerfMode(s.performance_mode); if (s.animation_style !== undefined) applyAnimStyle(s.animation_style); }
}
function executeAction(action) {
  switch (action) {
    case 'playpause': togglePlay(); break; case 'next': nextTrack(); break; case 'prev': prevTrack(); break; case 'shuffle': toggleShuffle(); break; case 'repeat': cycleRepeat(); break; case 'mute': toggleMute(); break; case 'stop': pauseAudio(); break; case 'seek_forward': audio.currentTime = Math.min(audio.duration||0, audio.currentTime + 5); break; case 'seek_backward': audio.currentTime = Math.max(0, audio.currentTime - 5); break; case 'volume_up': setVolume(volume + 0.05); break; case 'volume_down': setVolume(volume - 0.05); break; case 'equalizer': toggleEqPopup(); break; case 'toggle_eq': setEqEnabled(!eqEnabled); if (eqOnoff) { eqOnoff.textContent = eqEnabled ? 'ON' : 'OFF'; eqOnoff.classList.toggle('on', eqEnabled); } break; case 'settings': toggleSettings(); break; case 'quit': if (window.electronAPI) window.electronAPI.closeWindow(); break; case 'toggle_mini': if (window.electronAPI?.toggleMiniPlayer) window.electronAPI.toggleMiniPlayer(); break;
  }
}
document.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; if (e.key === 'F11') { e.preventDefault(); if (window.electronAPI?.toggleFullscreen) window.electronAPI.toggleFullscreen(); return; } if (e.key === 'Escape') { if (settingsPanelOpen) { closeSettings(); return; } if (eqPanel?.classList.contains('eq-visible')) { closeEqPopup(); return; } if (isFullscreenMode && window.electronAPI?.toggleFullscreen) { window.electronAPI.toggleFullscreen(); return; } } const pressed = e.key.toLowerCase(), action = keybindings[pressed]; if (action) { e.preventDefault(); executeAction(action); } });

if (window.electronAPI) {
  window.electronAPI.onOpenFiles((tracks) => { if (!tracks.length) return; const hadContent = queue.length > 0 && currentIndex >= 0, insertIdx = queue.length; addTracks(tracks); if (hadContent) { loadTrack(insertIdx); playAudio(); } else if (!isPlaying && currentIndex >= 0) playAudio(); });
  if (window.electronAPI.onFolderUpdated) {
    window.electronAPI.onFolderUpdated((data) => {
      const { dir, tracks } = data;
      const normDir = dir.replace(/\\/g, '/');
      const newPaths = new Set(tracks.map(t => t.path.replace(/\\/g, '/')));
      let removedAny = false;
      let reLoadRequired = false;

      for (let i = queue.length - 1; i >= 0; i--) {
        const p = queue[i].path.replace(/\\/g, '/');
        if (p.startsWith(normDir) && !newPaths.has(p)) {
          queue.splice(i, 1);
          removedAny = true;
          if (i < currentIndex) currentIndex--;
          else if (i === currentIndex) {
            reLoadRequired = true;
          }
        }
      }

      if (removedAny) {
        if (reLoadRequired) {
          if (queue.length === 0) {
            resetPlayer();
          } else {
            currentIndex = Math.min(currentIndex, queue.length - 1);
            loadTrack(currentIndex);
            if (isPlaying) playAudio();
          }
        }
        renderQueue();
        renderQueuePreview();
        renderCarousel();
        if (animStyle === 'off') updateCoverStrip();
        saveQueue();
      }

      const existingPaths = new Set(queue.map(t => t.path.replace(/\\/g, '/')));
      const tracksToAdd = tracks.filter(t => !existingPaths.has(t.path.replace(/\\/g, '/')));
      if (tracksToAdd.length > 0) addTracks(tracksToAdd);
    });
  }
  if (window.electronAPI.onOpenPlaylist) { window.electronAPI.onOpenPlaylist((data) => { const tracks = Array.isArray(data) ? data : (data.tracks || []), name = !Array.isArray(data) ? (data.name || null) : null; clearQueue(); if (tracks.length) { queue.push(...prepareTracks(tracks)); renderQueue(); renderQueuePreview(); renderCarousel(); if (animStyle === 'off') updateCoverStrip(); saveQueue(); loadTrack(0); playAudio(); } if (name && playlistLabel) { currentPlaylistName = name; playlistLabel.textContent = name.toUpperCase(); } }); }
  window.electronAPI.onMediaKey((key) => { switch (key) { case 'playpause': togglePlay(); break; case 'next': nextTrack(); break; case 'prev': prevTrack(); break; case 'stop': pauseAudio(); break; } });
  if (window.electronAPI.onKeybindings) window.electronAPI.onKeybindings((cfg) => applyConfig(cfg));
  if (btnMin) btnMin.addEventListener('click', window.electronAPI.minimizeWindow); if (btnMax) btnMax.addEventListener('click', window.electronAPI.maximizeWindow); if (btnClose) btnClose.addEventListener('click', window.electronAPI.closeWindow);
  window.electronAPI.onMaximizeChange((isMaximized) => { document.body.classList.toggle('maximized', isMaximized); if (btnMax) btnMax.innerHTML = isMaximized ? '&#10697;' : '&#9723;'; renderQueue(); renderQueuePreview(); renderCarousel(); });
  if (window.electronAPI.onFullscreenChange) { window.electronAPI.onFullscreenChange((isFs) => { isFullscreenMode = isFs; document.body.classList.toggle('is-fullscreen', isFs); if (fsView) { if (isFs) { fsView.classList.remove('fs-fade-out'); fsView.style.display = 'flex'; updateFsView(); if (typeof resetFsIdleTimer !== 'undefined') resetFsIdleTimer(); } else { fsView.classList.add('fs-fade-out'); setTimeout(() => { if (!isFullscreenMode) fsView.style.display = 'none'; }, 280); } } }); }
  if (window.electronAPI.onMiniPlayerChange) { window.electronAPI.onMiniPlayerChange((isMini) => { document.body.classList.toggle('mini-player', isMini); if (isMini) { document.body.classList.add('perf-mode'); } else { document.body.classList.toggle('perf-mode', perfMode); } }); }
} else { if (btnClose) btnClose.addEventListener('click', () => window.close()); }

document.addEventListener('wheel', (e) => {
  // Wheel volume is intentionally scoped to the visible volume control, so browsing the
  // playlist/library can never alter volume as a side effect.
  if (!e.target.closest('.volume-area')) return;
  const direction = e.deltaY > 0 ? 'mwheeldown' : 'mwheelup';
  const action = keybindings[direction];
  if (action) executeAction(action); else setVolume(volume - e.deltaY * 0.0003);
}, { passive: true });
const layoutObserver = new ResizeObserver(debounce(() => {
  // #9: Debounce the resize handler — rebuilding DOM on every pixel of resize is very expensive
  const w = document.documentElement.clientWidth;
  document.body.classList.toggle('wide', w > 520);
  renderQueue(); renderQueuePreview(); renderCarousel();
  if (animStyle === 'off') updateCoverStrip();
}, 80));
layoutObserver.observe(document.documentElement);

document.addEventListener('dblclick', (e) => {
  const ignored = ['.playlist', '.controls', '.fs-controls', '.progress-area', '.fs-progress-area', '.volume-area', '.eq-panel', '.titlebar', '.settings-panel', 'button', 'input'];
  if (e.target.closest(ignored.join(','))) return;
  if (window.electronAPI?.toggleFullscreen) {
    window.getSelection().removeAllRanges();
    window.electronAPI.toggleFullscreen();
  }
});

initVirtualList(); applyAnimStyle(animStyle); loadSavedQueue(); applyTheme(settings.theme || 'gold'); applyLayout(settings.layout || 'classic'); renderSpotifySidebar(); updateSpotifyNowPlaying(queue[currentIndex]);
