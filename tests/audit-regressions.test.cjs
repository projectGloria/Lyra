// Regression coverage for the 2026-09-29 audit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
function load(names, context) {
  const source = names.map((name) => {
    const start = renderer.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    return renderer.slice(start, renderer.indexOf('\n}\n', start) + 2);
  }).join('\n');
  vm.runInNewContext(source, context);
  return context;
}
const song = (id) => ({ id, path: `C:\\Music\\${id}.mp3`, url: `https://asset.localhost/${id}`, title: id });
const backendId = (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);

test('Windows drive paths must pass through convertFileSrc', () => {
  const converted = [];
  const context = { URL, window: { __TAURI__: {
    tauri: { invoke() {}, convertFileSrc(value) { converted.push(value); return `asset:${value}`; } },
    window: { appWindow: {} }, dialog: {}, event: {}
  } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/tauri-bridge.js'), 'utf8'), context);
  const input = 'C:\\Music\\Album\\Song.mp3';
  const actual = context.window.spotfck.toAssetUrl(input);
  assert.equal(actual, `asset:${input}`, `actual=${actual}; conversion calls=${converted.length}`);
});

test('renamed track IDs must match the Rust raw-path SHA-1 contract', () => {
  const track = { ...song('old'), path: 'C:\\Music\\Old\\Song.mp3', folderPath: 'C:\\Music\\Old' };
  const folder = { id: 'old-folder', path: track.folderPath, tracks: [track] };
  const app = load(['remapLocalPath', 'refreshEditedPlaylist'], {
    state: { library: { folders: [folder] }, view: { type: 'playlist' }, selectedTrackIds: new Set() },
    TextEncoder, remapLocalUrl: (v) => v, normalizeLibrary() {}, updateMediaSession() {}, persistPlaybackSession() {}
  });
  app.refreshEditedPlaylist({ folderPath: 'C:\\Music\\New', id: backendId('C:\\Music\\New'), name: 'New' }, { path: folder.path });
  assert.equal(track.id, backendId(track.path));
});

function editorContext(editTrackMetadata) {
  const a = song('A'), b = song('B'), x = song('X');
  return load(['saveTrackEditor', 'setCurrentTrack', 'setPlaybackList', 'fisherYatesShuffle'], {
    state: { trackEditState: { id: a.id, path: a.path }, currentTrack: a, selectedTracks: [x],
      playbackList: [a, b], basePlaybackList: [a, b], playbackHistory: [], playbackAnchorPath: a.path },
    audio: { currentTime: 42, paused: false, pause() {}, removeAttribute() {}, load() {}, play: () => Promise.resolve() },
    document: { getElementById: () => ({ value: '' }) },
    window: { spotfck: { editTrackMetadata } },
    playbackRequestId: 0, cancelPlaybackErrorSkip() {}, updateMediaSession() {}, reportEvent() {}, reportTrack() {},
    updatePlaybackUi() {}, persistPlaybackSession() {}, refreshEditedTrack() {}, closeTrackEditor() {}, showToast() {},
    restorePosition: 0, a, b, x
  });
}

test('saving the playing track must preserve its playback collection while browsing another playlist', async () => {
  const app = editorContext(async () => ({ ok: true, track: song('A') }));
  await app.saveTrackEditor();
  assert.equal(app.state.playbackList.map((t) => t.id).join(','), 'A,B');
});

test('a metadata save finishing after Next must not restart the old track', async () => {
  let finish;
  const app = editorContext(() => new Promise((resolve) => { finish = resolve; }));
  const request = app.saveTrackEditor();
  app.setCurrentTrack(app.b, true);
  finish({ ok: true, track: song('A') });
  await request;
  assert.equal(app.state.currentTrack.id, 'B');
});

test('a rejected native metadata save must be caught and displayed', async () => {
  const messages = [];
  const app = editorContext(async () => { throw new Error('Access denied'); });
  app.showToast = (text) => messages.push(text);
  await assert.doesNotReject(app.saveTrackEditor());
  assert.ok(messages.some((text) => text.includes('Access denied')));
});

test('automatic queue consumption must update an already open queue panel', () => {
  const a = song('A'), b = song('B');
  let renders = 0;
  const app = load(['getNextTrack', 'nextTrack', 'removeTrackFromQueue', 'setCurrentTrack', 'updatePlaybackUi'], {
    state: { queue: [b], currentTrack: a, playbackList: [a], selectedTracks: [a], playbackHistory: [], playbackAnchorPath: a.path },
    audio: { paused: false, pause() {}, load() {}, play: () => Promise.resolve() },
    playbackRequestId: 0, lastPlaybackUiKey: '', cancelPlaybackErrorSkip() {}, reportEvent() {}, reportTrack() {},
    updateMediaSession() {}, persistPlaybackSession() {}, renderNowPlaying() {}, renderPlayerDock() {}, updateSeekUi() {},
    updateTrackRowStates() {}, updateContentPlayControl() {}, updateDockPlaybackControl() {}, showToast() {},
    renderQueuePanel() { renders++; }
  });
  app.nextTrack();
  assert.equal(app.state.queue.length, 0);
  assert.ok(renders > 0, 'queue changed but its rendered list was never refreshed');
});

test('an empty library must still show newly created empty playlists', () => {
  const list = { innerHTML: '', classList: { toggle() {} } };
  const app = load(['renderLibrary'], {
    state: { libraryQuery: '', libraryFilter: 'playlists', view: { type: 'playlist' }, settings: { libraryPath: 'C:\\Music' }, library: { ok: true, trackCount: 0, folders: [{ id: 'new', name: 'New Playlist', tracks: [] }] } },
    document: { getElementById: () => list, querySelectorAll: () => [] }, updateLibrarySummary() {}, iconMarkup: () => '', escapeHtml: (v) => String(v), getArtworkForTrack: () => ''
  });
  app.renderLibrary();
  assert.match(list.innerHTML, /New Playlist/);
});

test('renaming a playlist after tag editing must update detached current and queued track objects', () => {
  const oldRoot = 'C:\\Music\\Old', newRoot = 'C:\\Music\\New';
  const track = { ...song('A'), path: `${oldRoot}\\Song.mp3`, folderPath: oldRoot };
  const folder = { id: 'folder', path: oldRoot, tracks: [track] };
  const app = load(['refreshEditedTrack', 'remapLocalPath', 'refreshEditedPlaylist'], {
    state: { library: { folders: [folder], likedSongs: [] }, currentTrack: track, queue: [track],
      selectedTracks: [track], playbackList: [track], basePlaybackList: [track], selectedTrackIds: new Set(),
      playbackHistory: [], view: { type: 'playlist' } },
    tracksByPath: new Map([[track.path.replaceAll('\\', '/').toLowerCase(), track]]), tracksById: new Map([[track.id, track]]),
    TextEncoder, remapLocalUrl: (v) => v, normalizeLibrary: (v) => v,
    updateMediaSession() {}, persistPlaybackSession() {}, render() {}, renderQueuePanel() {}
  });
  app.refreshEditedTrack({ ...track, title: 'Edited' });
  // Also cover playback copies restored before canonical object sharing was introduced.
  app.state.currentTrack = { ...app.state.currentTrack };
  app.state.queue = app.state.queue.map((track) => ({ ...track }));
  app.refreshEditedPlaylist({ folderPath: newRoot, id: 'new-folder', name: 'New' }, { path: oldRoot });
  assert.equal(app.state.currentTrack.path, `${newRoot}\\Song.mp3`);
  assert.equal(app.state.queue[0].path, `${newRoot}\\Song.mp3`);
});

test('asset URL cache-busting queries must not become part of a remapped filename', () => {
  const context = { URL, window: { __TAURI__: {
    tauri: { invoke() {}, convertFileSrc: (value) => `https://asset.localhost/${encodeURIComponent(value)}` },
    window: { appWindow: {} }, dialog: {}, event: {}
  } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/tauri-bridge.js'), 'utf8'), context);
  load(['remapLocalPath', 'remapLocalUrl', 'fileUrl'], context);
  const original = 'C:\\Music\\Old\\Song.jpg';
  const url = context.window.spotfck.toAssetUrl(original) + '?v=123';
  const remapped = context.remapLocalUrl(url, 'C:\\Music\\Old', 'C:\\Music\\New');
  assert.equal(decodeURIComponent(new URL(remapped).pathname.slice(1)), 'C:\\Music\\New\\Song.jpg');
});

test('previousTrack seeks to 0 and immediately updates seek UI and position when past 5 seconds', () => {
  let seekUpdated = false;
  let savedPosition = -1;
  const current = song('Playing');
  const app = load(['previousTrack'], {
    state: { currentTrack: current, playbackHistory: [], playbackList: [current], selectedTracks: [current] },
    audio: { currentTime: 12 },
    cancelPlaybackErrorSkip() {},
    updateSeekUi: () => { seekUpdated = true; },
    writePlaybackPosition: (pos) => { savedPosition = pos; }
  });
  app.previousTrack();
  assert.equal(app.audio.currentTime, 0);
  assert.equal(seekUpdated, true);
  assert.equal(savedPosition, 0);
});
