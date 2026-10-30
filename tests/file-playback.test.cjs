const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/file-playback.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const flush = () => new Promise(setImmediate);
const song = (id) => ({ id, path: `C:\\Outside music\\${id}.mp3`, title: id, url: `asset:${id}` });
function load() {
  const metadata = new Map();
  const snapshots = [];
  const events = {};
  const context = {
    state: { settings: {}, currentTrack: null, queue: [song('queued')], playbackList: [], basePlaybackList: [] },
    tracksById: new Map(), playbackSessionReady: false,
    audio: { paused: true, currentTime: 0, duration: NaN, volume: 0.5, addEventListener(name, fn) { events[name] = fn; } },
    window: { spotfck: {
      publishPlayback: (snapshot) => snapshots.push(snapshot),
      openedTrackMetadata: (file, id) => new Promise((resolve) => metadata.set(`${id}:${file}`, resolve)),
      startFilePlayback: async () => {}
    } },
    setPlaybackList(tracks) { context.state.playbackList = [...tracks]; context.state.basePlaybackList = [...tracks]; },
    setCurrentTrack(track, autoplay) { context.state.currentTrack = track; context.audio.paused = !autoplay; },
    setVolume(value) { context.audio.volume = Math.max(0, Math.min(1, value)); },
    updateMediaSession() {}, updatePlaybackUi() {}, updateSeekUi() {},
    togglePlay() { context.audio.paused = !context.audio.paused; },
    Date, Number, Map
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, metadata, snapshots, events };
}

test('opens external selections immediately without waiting for metadata or library setup', async () => {
  const { context, metadata } = load();
  await context.initFilePlayback();
  context.handleOpenedFiles({ id: 1, tracks: [song('a'), song('b')], errors: [] });
  assert.equal(context.state.currentTrack.id, 'a');
  assert.equal(context.audio.paused, false);
  assert.equal(context.state.queue.length, 0);
  assert.equal(context.state.playbackList.length, 2);
  assert.equal(context.playbackSessionReady, true);
  assert.equal(metadata.size, 2);
});

test('stale metadata and duplicate delivery cannot overwrite a newer file selection', async () => {
  const { context, metadata } = load();
  await context.initFilePlayback();
  context.handleOpenedFiles({ id: 1, tracks: [song('a')] });
  context.handleOpenedFiles({ id: 2, tracks: [song('b')] });
  metadata.get(`1:${song('a').path}`)({ ...song('a'), title: 'Old metadata' });
  await flush();
  assert.equal(context.state.currentTrack.id, 'b');
  context.handleOpenedFiles({ id: 1, tracks: [song('a')] });
  context.handleOpenedFiles({ id: 2, tracks: [song('a')] });
  assert.equal(context.state.currentTrack.id, 'b');
  metadata.get(`2:${song('b').path}`)({ ...song('b'), title: 'New title' });
  await flush();
  assert.equal(context.state.currentTrack.title, 'New title');
  assert.equal(context.state.playbackList[0].title, 'New title');
});

test('invalid requests preserve playback and publish an error to the compact window', async () => {
  const { context, snapshots } = load();
  await context.initFilePlayback();
  context.handleOpenedFiles({ id: 1, tracks: [song('a')] });
  context.handleOpenedFiles({ id: 2, tracks: [], errors: ['File is missing'] });
  assert.equal(context.state.currentTrack.id, 'a');
  assert.equal(context.audio.paused, false);
  assert.equal(snapshots.at(-1).message, 'File is missing');
});

test('metadata finishing after Next enriches its track without restarting playback', async () => {
  const { context, metadata } = load();
  await context.initFilePlayback();
  context.handleOpenedFiles({ id: 1, tracks: [song('a'), song('b')] });
  context.state.currentTrack = context.state.playbackList[1];
  metadata.get(`1:${song('a').path}`)({ ...song('a'), title: 'Title a' });
  await flush();
  assert.equal(context.state.currentTrack.id, 'b');
  assert.equal(context.state.playbackList[0].title, 'Title a');
});

test('compact controls drive the owner and clamp seek and volume', async () => {
  const { context } = load();
  await context.initFilePlayback();
  context.audio.duration = 100;
  context.handleCompactControl({ action: 'seek', value: 120 });
  assert.equal(context.audio.currentTime, 100);
  context.handleCompactControl({ action: 'seek', value: -10 });
  assert.equal(context.audio.currentTime, 0);
  context.handleCompactControl({ action: 'volume', value: 2 });
  assert.equal(context.audio.volume, 1);
  context.handleCompactControl({ action: 'togglePlay' });
  assert.equal(context.audio.paused, false);
  context.handleCompactControl({ action: 'seek', value: NaN });
  assert.equal(context.audio.currentTime, 0);
});

test('library reconciliation retains external playback while removing deleted library tracks', () => {
  const external = { ...song('external'), external: true };
  const removed = song('removed');
  const context = {
    state: { playbackHistory: [external.id], playbackHistoryContexts: [], playbackForward: [] },
    tracksByPath: new Map(), tracksById: new Map([[external.id, external]]),
    audio: { pause() { throw Error('External playback must continue'); } },
    updateMediaSession() {}, persistPlaybackSession() {}
  };
  const start = renderer.indexOf('function reconcilePlaybackAfterLibraryRefresh(');
  vm.runInNewContext(renderer.slice(start, renderer.indexOf('\n}\n', start) + 2), context);
  context.reconcilePlaybackAfterLibraryRefresh(external, [external, removed], [external], [external]);
  assert.equal(context.state.currentTrack, external);
  assert.equal(context.state.queue.length, 1);
  assert.equal(context.state.playbackList[0], external);
});

test('external playback never overwrites persisted library sessions', () => {
  const context = {
    state: { currentTrack: { ...song('external'), external: true } }, playbackSessionReady: true,
    localStorage: { setItem() { throw Error('External playback must not be persisted'); } }
  };
  for (const name of ['writePlaybackPosition', 'writePlaybackSessionNow']) {
    const start = renderer.indexOf(`function ${name}(`);
    vm.runInNewContext(renderer.slice(start, renderer.indexOf('\n}\n', start) + 2), context);
    context[name]();
  }
});

test('startup subscribes before draining and consumes a request only once across wakeups', async () => {
  let pending = { id: 1, tracks: [song('a')] };
  const listeners = new Map();
  const requests = [];
  const calls = [];
  const context = { URL, console, window: { __TAURI__: {
    tauri: { async invoke(name) { calls.push(name); const result = pending; pending = null; return result; }, convertFileSrc: (s) => `asset:${s}` },
    window: { appWindow: {} }, dialog: {}, event: { async listen(name, handler) { listeners.set(name, handler); calls.push(name); return () => {}; } }
  } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/tauri-bridge.js'), 'utf8'), context);
  await context.window.spotfck.startFilePlayback((r) => requests.push(r), () => {});
  listeners.get('files:pending')();
  await flush();
  assert.deepEqual(calls.slice(0, 3), ['files:pending', 'compact:control', 'take_open_request']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tracks[0].url, `asset:${song('a').path}`);
});

test('opening a known library track keeps its normal library entry intact', async () => {
  const { context } = load();
  const libraryTrack = song('a');
  context.tracksById.set(libraryTrack.id, libraryTrack);
  await context.initFilePlayback();
  context.handleOpenedFiles({ id: 1, tracks: [song('a')] });
  assert.equal(context.state.currentTrack.external, true);
  assert.equal(context.tracksById.get('a'), libraryTrack);
  assert.equal(libraryTrack.external, undefined);
});

test('a replacement selection releases old external index entries', async () => {
  const { context } = load();
  await context.initFilePlayback();
  context.handleOpenedFiles({ id: 1, tracks: [song('a')] });
  context.handleOpenedFiles({ id: 2, tracks: [song('b')] });
  assert.equal(context.tracksById.has('a'), false);
  assert.equal(context.tracksById.get('b'), context.state.currentTrack);
});

test('ordinary library notices cannot overwrite compact playback errors', () => {
  const published = [];
  const toast = { classList: { add() {}, remove() {} } };
  const context = {
    publishCompactPlayback: (text) => published.push(text),
    document: { getElementById: () => toast },
    clearTimeout() {}, setTimeout() {}, toastTimer: null
  };
  const start = renderer.indexOf('function showToast(');
  vm.runInNewContext(renderer.slice(start, renderer.indexOf('\n}\n', start) + 2), context);
  context.showToast('Playback error', { playback: true });
  context.showToast('Library updated');
  assert.deepEqual(published, ['Playback error']);
});

test('external tracks do not display a misleading library playlist card', () => {
  const context = {};
  const start = renderer.indexOf('function renderPlaylistContextCard(');
  vm.runInNewContext(renderer.slice(start, renderer.indexOf('\n}\n', start) + 2), context);
  assert.equal(context.renderPlaylistContextCard({ ...song('a'), external: true }), '');
});

test('NSIS registers and removes every supported extension without claiming defaults', () => {
  const native = fs.readFileSync(path.join(__dirname, '../src-tauri/src/util.rs'), 'utf8');
  const extensions = [...native.match(/AUDIO_EXTENSIONS[^=]*=\s*&\[([^\]]+)/)[1].matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]).sort();
  const template = fs.readFileSync(path.join(__dirname, '../src-tauri/installer/installer.nsi'), 'utf8');
  for (const action of ['Register', 'Unregister']) {
    const registered = [...template.matchAll(new RegExp(`!insertmacro Lyra${action}Extension ([a-z0-9]+)`, 'g'))].map((m) => m[1]).sort();
    assert.deepEqual(registered, extensions);
  }
  assert.ok(template.includes('OpenWithProgids'));
  assert.ok(template.includes('Software\\RegisteredApplications'));
  assert.ok(template.includes('exe" "%1"'));
  assert.equal(/WriteRegStr[^\n]+Software\\Classes\\\.\$\{EXT\}" ""/.test(template), false);
});
