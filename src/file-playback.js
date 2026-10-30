// The main renderer owns audio. This controller handles external selections and
// publishes lightweight snapshots to the compact window; it never scans a folder.
const externalTracks = new Map();
let latestOpenRequestId = 0;
let compactMessage = '';
let filePlaybackStarted = false;
let lastCompactPublish = 0;

function publishCompactPlayback(message = compactMessage) {
  if (!filePlaybackStarted) return;
  compactMessage = message;
  const track = state.currentTrack;
  window.spotfck.publishPlayback({
    track: track ? { id: track.id, title: track.title, artist: track.artist, artworkUrl: track.artworkUrl || '' } : null,
    paused: audio.paused, position: Number(audio.currentTime || 0),
    duration: Number.isFinite(audio.duration) ? audio.duration : Number(track?.duration || 0),
    volume: audio.volume, message: compactMessage,
    accent: state.settings.accentColor || '#c9a94a', theme: state.settings.theme || 'lyra'
  });
}

function handleOpenedFiles(request) {
  if (!request || request.id <= latestOpenRequestId) return;
  latestOpenRequestId = request.id;
  const tracks = Array.isArray(request.tracks) ? request.tracks : [];
  if (!tracks.length) {
    publishCompactPlayback((request.errors || []).join('\n') || 'No supported audio files were opened.');
    return;
  }
  // Suppress startup session restoration even if the library cache is still loading.
  playbackSessionReady = true;
  for (const [id, track] of externalTracks) {
    if (tracksById.get(id) === track) tracksById.delete(id);
  }
  externalTracks.clear();
  for (const track of tracks) {
    track.external = true;
    externalTracks.set(track.id, track);
    if (!tracksById.has(track.id)) tracksById.set(track.id, track);
  }
  state.queue = [];
  state.consecutivePlaybackErrors = 0;
  compactMessage = (request.errors || []).join('\n');
  setPlaybackList(tracks, { resetHistory: true, activeTrack: tracks[0] });
  setCurrentTrack(tracks[0], true, null, { addHistory: false });
  publishCompactPlayback();
  for (const track of tracks) {
    window.spotfck.openedTrackMetadata(track.path, request.id).then((metadata) => {
      if (latestOpenRequestId !== request.id || !externalTracks.has(track.id)) return;
      // Mutate the shared track object so queue/list/current references all update.
      Object.assign(track, metadata, { external: true });
      if (state.currentTrack === track) {
        updateMediaSession();
        updatePlaybackUi({ trackChanged: true });
      }
      publishCompactPlayback();
    }).catch(() => {}); // Filename fallback remains playable if metadata is unreadable.
  }
}

function handleCompactControl({ action, value } = {}) {
  if (action === 'togglePlay') togglePlay();
  if (action === 'seek' && Number.isFinite(value) && Number.isFinite(audio.duration)) {
    audio.currentTime = Math.max(0, Math.min(audio.duration, value));
    updateSeekUi();
  }
  if (action === 'volume' && Number.isFinite(value)) {
    setVolume(value);
  }
  publishCompactPlayback();
}

async function initFilePlayback() {
  if (!window.spotfck.startFilePlayback) return;
  filePlaybackStarted = true;
  for (const event of ['loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'volumechange', 'seeked']) {
    audio.addEventListener(event, () => publishCompactPlayback());
  }
  audio.addEventListener('playing', () => publishCompactPlayback(''));
  audio.addEventListener('timeupdate', () => {
    if (Date.now() - lastCompactPublish < 250) return;
    lastCompactPublish = Date.now();
    publishCompactPlayback();
  });
  await window.spotfck.startFilePlayback(handleOpenedFiles, handleCompactControl);
  publishCompactPlayback();
}
