// The mini player is a self-contained player: its own <audio>, its own queue, its own
// volume. It never drives the library window's playback, and the library never drives
// it. Closing the window destroys this webview, which is what actually stops the sound.
const { invoke, convertFileSrc } = window.__TAURI__.tauri;
const { listen } = window.__TAURI__.event;
const elements = Object.fromEntries(['title', 'artist', 'artwork', 'play', 'seek', 'elapsed', 'duration', 'volume', 'message'].map((id) => [id, document.getElementById(id)]));
const NO_ARTWORK = 'assets/no-artwork.svg';
// Same origin as the library webview means a shared localStorage; namespace the key so
// the two players' volumes stay independent.
const VOLUME_KEY = 'lyra-mini-player-volume';
const audio = new Audio();
audio.preload = 'auto';

let tracks = [];
let index = -1;
let requestId = 0;
let message = '';
let draggingSeek = false;

const format = (seconds) => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const toUrl = (path) => {
  try { return path ? convertFileSrc(path) : ''; } catch { return ''; }
};
const current = () => tracks[index] || null;

function setMessage(text) {
  message = String(text || '');
  elements.message.textContent = message;
  elements.message.title = message;
}
const showError = (error) => setMessage(error?.message || error);

function renderTrack() {
  const track = current();
  elements.title.textContent = track?.title || 'Nothing playing';
  elements.title.title = elements.title.textContent;
  elements.artist.textContent = track?.artist || 'Open a music file to begin';
  elements.artist.title = elements.artist.textContent;
  const artwork = toUrl(track?.artworkPath) || NO_ARTWORK;
  if (elements.artwork.getAttribute('src') !== artwork) elements.artwork.src = artwork;
  elements.play.disabled = !track;
  if (track && 'mediaSession' in navigator) {
    // Without this, the Windows media flyout shows a blank "Lyra" for the mini player.
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || '', artist: track.artist || '', album: track.album || '',
      artwork: track.artworkPath ? [{ src: toUrl(track.artworkPath) }] : []
    });
  }
  renderTransport();
}

// Driven by <audio> events, so the UI is derived from the element's real state rather
// than a mirrored `isPlaying` flag that can drift from it.
function renderTransport() {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  elements.play.textContent = audio.paused ? '▶' : 'Ⅱ';
  elements.play.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  elements.seek.disabled = !current() || !(duration > 0);
  if (!draggingSeek) {
    elements.seek.max = String(duration || 1);
    elements.seek.value = String(audio.currentTime || 0);
    elements.elapsed.textContent = format(audio.currentTime);
  }
  elements.duration.textContent = format(duration);
}

function playAt(next) {
  if (next < 0 || next >= tracks.length) {
    // End of the selection: stop on the last track instead of looping or going silent
    // with a stale title.
    audio.pause();
    return renderTransport();
  }
  index = next;
  audio.src = toUrl(tracks[index].path);
  renderTrack();
  audio.play().catch((error) => { if (error?.name !== 'AbortError') showError(error); });
}

function togglePlay() {
  if (!current()) return;
  if (audio.paused) audio.play().catch(showError);
  else audio.pause();
}

function handleRequest(request) {
  // Explorer can fire twice for one double-click on slow machines; ids are monotonic.
  if (!request || request.id <= requestId) return;
  requestId = request.id;
  const errors = (request.errors || []).join('\n');
  const opened = Array.isArray(request.tracks) ? request.tracks : [];
  if (!opened.length) return setMessage(errors || 'No supported audio files were opened.');
  setMessage(errors);
  tracks = opened;
  playAt(0);
  for (const track of opened) {
    invoke('opened_track_metadata', { filePath: track.path, requestId: request.id }).then((metadata) => {
      // A newer double-click replaced the selection while tags were being read.
      if (requestId !== request.id) return;
      // Mutate in place: `tracks` holds this same object, and path must not change
      // under a playing <audio> (Rust returns the canonical path we sent anyway).
      Object.assign(track, metadata, { path: track.path });
      if (current() === track) renderTrack();
    }).catch(() => {}); // Filename fallback stays playable if the tags are unreadable.
  }
}

for (const event of ['play', 'pause', 'loadedmetadata', 'durationchange', 'seeked']) audio.addEventListener(event, renderTransport);
audio.addEventListener('playing', () => setMessage(''));
let lastTick = 0;
audio.addEventListener('timeupdate', () => {
  // timeupdate fires ~4x/s on WebView2, but throttle anyway: cheap insurance.
  if (Date.now() - lastTick < 250) return;
  lastTick = Date.now();
  renderTransport();
});
audio.addEventListener('ended', () => playAt(index + 1));
audio.addEventListener('error', () => {
  const track = current();
  if (!track || !audio.getAttribute('src')) return;
  setMessage(`Cannot play ${track.title || 'this file'}`);
  // Skip a broken file in a multi-selection; a single broken file just shows the error.
  if (index + 1 < tracks.length) setTimeout(() => playAt(index + 1), 1500);
});

elements.artwork.addEventListener('error', () => {
  if (elements.artwork.getAttribute('src') !== NO_ARTWORK) elements.artwork.src = NO_ARTWORK;
});
elements.play.addEventListener('click', togglePlay);
elements.seek.addEventListener('pointerdown', () => { draggingSeek = true; });
elements.seek.addEventListener('input', () => { elements.elapsed.textContent = format(elements.seek.value); });
elements.seek.addEventListener('change', () => {
  draggingSeek = false;
  if (Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration, Number(elements.seek.value)));
});
elements.volume.addEventListener('input', () => {
  audio.volume = Math.max(0, Math.min(1, Number(elements.volume.value)));
  try { localStorage.setItem(VOLUME_KEY, String(audio.volume)); } catch {}
});
window.addEventListener('pointerup', () => { draggingSeek = false; });
window.addEventListener('pointercancel', () => { draggingSeek = false; });
document.getElementById('library').addEventListener('click', () => invoke('show_library').catch(showError));
document.getElementById('close').addEventListener('click', () => invoke('close_window').catch(showError));
document.getElementById('minimize').addEventListener('click', () => window.__TAURI__.window.appWindow.minimize().catch(showError));
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !['INPUT', 'BUTTON'].includes(event.target.tagName)) {
    event.preventDefault();
    togglePlay();
  }
});
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play().catch(showError));
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => { if (index + 1 < tracks.length) playAt(index + 1); });
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    if (audio.currentTime > 3 || index === 0) audio.currentTime = 0;
    else playAt(index - 1);
  });
}

const savedVolume = Number(localStorage.getItem(VOLUME_KEY));
audio.volume = Number.isFinite(savedVolume) && localStorage.getItem(VOLUME_KEY) !== null ? Math.max(0, Math.min(1, savedVolume)) : 0.5;
elements.volume.value = String(audio.volume);
// Theme only; a failed read just keeps the CSS default accent.
invoke('read_settings').then((settings) => {
  if (/^#[0-9a-f]{6}$/i.test(settings?.accentColor || '')) document.documentElement.style.setProperty('--accent', settings.accentColor);
}).catch(() => {});

(async () => {
  // Subscribe before draining: a double-click that lands while this page is still
  // loading is either already pending (drained below) or arrives as an event.
  const drain = () => invoke('take_open_request').then(handleRequest).catch(showError);
  await listen('files:pending', drain);
  await drain();
})().catch(showError);
