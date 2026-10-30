const { invoke } = window.__TAURI__.tauri;
const { listen } = window.__TAURI__.event;
const elements = Object.fromEntries(['title', 'artist', 'artwork', 'play', 'seek', 'elapsed', 'duration', 'volume', 'message'].map((id) => [id, document.getElementById(id)]));
let snapshot = null;
let draggingSeek = false;
let draggingVolume = false;
const format = (seconds) => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
function showError(error) {
  elements.message.textContent = String(error?.message || error);
  elements.message.title = elements.message.textContent;
}
function control(action, value = null) {
  return invoke('compact_control', { action, value }).catch(showError);
}
function renderPlayback(value) {
  if (!value || typeof value !== 'object') return;
  snapshot = value;
  const track = value.track;
  elements.title.textContent = track?.title || 'Nothing playing';
  elements.title.title = elements.title.textContent;
  elements.artist.textContent = track?.artist || 'Open a music file to begin';
  elements.artist.title = elements.artist.textContent;
  const artwork = track?.artworkUrl || 'assets/no-artwork.svg';
  if (elements.artwork.getAttribute('src') !== artwork) elements.artwork.src = artwork;
  elements.play.disabled = !track;
  elements.play.textContent = value.paused ? '▶' : 'Ⅱ';
  elements.play.setAttribute('aria-label', value.paused ? 'Play' : 'Pause');
  elements.seek.disabled = !track || !(value.duration > 0);
  if (!draggingSeek) {
    elements.seek.max = String(value.duration || 1);
    elements.seek.value = String(value.position || 0);
    elements.elapsed.textContent = format(value.position);
  }
  elements.duration.textContent = format(value.duration);
  if (!draggingVolume) elements.volume.value = String(value.volume ?? 0.5);
  elements.message.textContent = value.message || '';
  elements.message.title = value.message || '';
  if (/^#[0-9a-f]{6}$/i.test(value.accent || '')) document.documentElement.style.setProperty('--accent', value.accent);
}
elements.artwork.addEventListener('error', () => {
  if (elements.artwork.getAttribute('src') !== 'assets/no-artwork.svg') elements.artwork.src = 'assets/no-artwork.svg';
});
elements.play.addEventListener('click', () => control('togglePlay'));
elements.seek.addEventListener('pointerdown', () => { draggingSeek = true; });
elements.seek.addEventListener('input', () => { elements.elapsed.textContent = format(elements.seek.value); });
elements.seek.addEventListener('change', () => { draggingSeek = false; control('seek', Number(elements.seek.value)); });
elements.volume.addEventListener('pointerdown', () => { draggingVolume = true; });
elements.volume.addEventListener('input', () => control('volume', Number(elements.volume.value)));
elements.volume.addEventListener('change', () => { draggingVolume = false; });
window.addEventListener('pointerup', () => { draggingSeek = false; draggingVolume = false; });
window.addEventListener('pointercancel', () => { draggingSeek = false; draggingVolume = false; });
document.getElementById('library').addEventListener('click', () => invoke('show_library').catch(showError));
document.getElementById('close').addEventListener('click', () => invoke('close_window').catch(showError));
// Minimizing the mini player keeps its normal taskbar behavior.
document.getElementById('minimize').addEventListener('click', () => window.__TAURI__.window.appWindow.minimize().catch(showError));
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !['INPUT', 'BUTTON'].includes(event.target.tagName)) {
    event.preventDefault();
    if (snapshot?.track) control('togglePlay');
  }
});
(async () => {
  // Attach first, then ask the audio owner for a fresh snapshot. Avoid rendering an
  // older command response over a live event received during initialization.
  await listen('playback:state', (event) => renderPlayback(event.payload));
  const cached = await invoke('playback_snapshot');
  if (!snapshot) renderPlayback(cached);
  await control('snapshot');
})().catch(showError);
