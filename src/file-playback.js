// Explorer-opened files play in the mini player, which owns its own <audio>. The library
// window's only involvement is this: pause when a file is opened. No resume afterwards,
// no queue changes, no session writes. Picking the music back up is the user's call.
async function initFilePlayback() {
  if (!window.spotfck.onExternalPlayback) return;
  // audio.pause() alone is enough: the existing 'pause' listeners update the dock,
  // media session and persisted position exactly like a manual pause would.
  await window.spotfck.onExternalPlayback(() => { if (!audio.paused) audio.pause(); });
}
