const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
function load(names, context) {
  const functions = names.map((name) => {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}\n', start) + 2);
  });
  vm.runInNewContext(functions.join('\n'), context);
  return context;
}
const ids = (tracks) => Array.from(tracks, (track) => track.id).join('');
const track = (id, artist = 'Artist') => ({ id, path: `/music/${id}.mp3`, title: id, artist, album: 'Greatest Hits' });
const flush = () => new Promise(setImmediate);
test('window actions wait for the tray preference to finish saving', async () => {
  for (const action of ['close', 'minimize']) {
    const save = deferred();
    const calls = [];
    const app = load(['handleWindowAction'], {
      settingsSaveChain: save.promise,
      window: { spotfck: { [action]: async () => calls.push(action) } },
      showToast: (message) => calls.push(message)
    });
    const pending = app.handleWindowAction(action);
    await flush();
    assert.equal(calls.length, 0);
    save.resolve();
    await pending;
    assert.deepEqual(calls, [action]);
  }
});

test('failed preference saves keep the window open and explain the failure', async () => {
  const calls = [];
  const app = load(['handleWindowAction'], {
    settingsSaveChain: Promise.reject(new Error('save failed')),
    window: { spotfck: { close: async () => calls.push('closed') } },
    showToast: (message) => calls.push(message)
  });
  await app.handleWindowAction('close');
  assert.deepEqual(calls, ['Could not close window: save failed']);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function playback() {
  const [a, b, c, x] = ['A', 'B', 'C', 'X'].map((id) => track(id));
  const math = Object.create(Math);
  math.random = () => 0.5;
  const timers = new Map();
  let timerId = 0;
  const context = {
    state: { queue: [], playbackList: [a, b, c], basePlaybackList: [a, b, c], selectedTracks: [a, b, c],
      currentTrack: a, playbackAnchorPath: a.path, repeatMode: 'off', shuffle: false,
      playbackHistory: [], consecutivePlaybackErrors: 0 },
    tracksById: new Map([a, b, c, x].map((item) => [item.id, item])),
    Math: math, playbackRequestId: 0, playbackErrorTimer: null, playbackTransitioning: false,
    audio: { currentTime: 0, error: { code: 3 }, pause() {}, removeAttribute() {}, load() {} },
    reportEvent() {}, reportTrack() {}, updatePlaybackUi() {}, updateMediaSession() {},
    showToast() {}, persistPlaybackSession() {}, renderNowPlaying() {}, renderQueuePanel() {},
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }, timers, a, b, c, x
  };
  return load(['getPlaybackCollection', 'getNextTrack', 'removeTrackFromQueue', 'nextTrack', 'previousTrack',
    'setCurrentTrack', 'setPlaybackList', 'fisherYatesShuffle', 'queueTracks', 'cancelPlaybackErrorSkip', 'handlePlaybackError'], context);
}

test('Next preserves an existing shuffle order and reaches every remaining song', () => {
  const app = playback();
  app.state.shuffle = true;
  app.nextTrack();
  assert.equal(app.state.currentTrack.id, 'B');
  assert.equal(ids(app.state.playbackList), 'ABC');
  app.nextTrack();
  assert.equal(app.state.currentTrack.id, 'C');
  assert.equal(ids(app.state.playbackList), 'ABC');
  app.previousTrack();
  assert.equal(app.state.currentTrack.id, 'B');
  assert.equal(ids(app.state.playbackList), 'ABC');
});

test('temporary queue resumes the playlist cursor, including queued playlist members', () => {
  for (const queued of ['X', 'A']) {
    const app = playback();
    app.setCurrentTrack(app.b);
    app.queueTracks([app.tracksById.get(queued)]);
    assert.equal(app.getNextTrack().id, queued);
    app.nextTrack();
    assert.equal(app.state.currentTrack.id, queued);
    assert.equal(app.getNextTrack().id, 'C');
    app.nextTrack();
    assert.equal(app.state.currentTrack.id, 'C');
  }
});

test('Previous resolves consumed queued songs from the whole library', () => {
  const app = playback();
  app.setCurrentTrack(app.b);
  app.queueTracks([app.x]);
  app.nextTrack();
  app.nextTrack();
  app.previousTrack();
  assert.equal(app.state.currentTrack.id, 'X');
});

test('Play Next moves existing queued songs and deduplicates the request', () => {
  const app = playback();
  app.state.queue = [app.b, app.c];
  app.queueTracks([app.c, app.c, app.a], { next: true });
  assert.equal(ids(app.state.queue), 'CB');
});

test('repeat all wraps at the playlist end after the queue finishes', () => {
  const app = playback();
  app.setCurrentTrack(app.c);
  app.state.repeatMode = 'all';
  app.queueTracks([app.x]);
  app.nextTrack();
  app.nextTrack();
  assert.equal(app.state.currentTrack.id, 'A');
});

test('retrying the same track cancels its stale error skip', () => {
  const app = playback();
  app.handlePlaybackError();
  assert.equal(app.timers.size, 1);
  const stale = [...app.timers.values()][0];
  app.setCurrentTrack(app.a);
  assert.equal(app.timers.size, 0);
  stale();
  assert.equal(app.state.currentTrack.id, 'A');
});

test('error skip still advances an unchanged failed playback request', () => {
  const app = playback();
  app.handlePlaybackError();
  [...app.timers.values()][0]();
  assert.equal(app.state.currentTrack.id, 'B');
});

test('recovery cancels the pending skip even if its callback was already queued', () => {
  const app = playback();
  app.handlePlaybackError();
  const stale = [...app.timers.values()][0];
  app.cancelPlaybackErrorSkip();
  stale();
  assert.equal(app.state.currentTrack.id, 'A');
});

test('reaching the playback error limit cancels the previous delayed skip', () => {
  const app = playback();
  app.state.consecutivePlaybackErrors = 3;
  app.handlePlaybackError();
  assert.equal(app.timers.size, 1);
  app.handlePlaybackError();
  assert.equal(app.timers.size, 0);
});

test('playback sessions preserve the playlist cursor while a queued song is current', () => {
  const app = playback();
  const saved = new Map();
  Object.assign(app, {
    localStorage: { setItem: (key, value) => saved.set(key, value), getItem: (key) => saved.get(key) || null },
    PLAYBACK_SESSION_KEY: 'session', playbackSessionReady: true, playbackSessionDirty: true,
    tracksByPath: new Map([...app.tracksById.values()].map((song) => [song.path.toLowerCase(), song])),
    restorePosition: 0, lastPositionWrite: 0
  });
  load(['writePlaybackPosition', 'writePlaybackSessionNow', 'readPlaybackSession', 'restorePlaybackSession'], app);
  app.setCurrentTrack(app.b);
  app.queueTracks([app.x]);
  app.nextTrack();
  app.writePlaybackSessionNow();
  app.state.currentTrack = null;
  app.state.playbackAnchorPath = '';
  assert.equal(app.restorePlaybackSession(), true);
  assert.equal(app.state.currentTrack.id, 'X');
  assert.equal(app.getNextTrack().id, 'C');
});

test('album identity separates namesakes but groups compilation album artists', () => {
  const a = track('A', 'Artist A'), b = track('B', 'Artist B');
  const guest = { ...track('C', 'Guest'), albumArtist: ' Artist A ' };
  const app = load(['albumIdentity', 'getAlbumCollections'], {
    albumCollectionsCache: null, getAllTracks: () => [a, b, guest]
  });
  const albums = app.getAlbumCollections();
  assert.equal(albums.length, 2);
  assert.equal(ids(albums.find((album) => album.value === app.albumIdentity(a)).tracks), 'AC');
  assert.notEqual(app.albumIdentity(a), app.albumIdentity(b));
});

test('album navigation selects only the identified album and displays its title', () => {
  const a = track('A', 'Artist A'), b = track('B', 'Artist B');
  let mounted;
  const app = load(['albumIdentity', 'renderEntityView'], {
    state: { currentTrack: null }, audio: { paused: true }, getAllTracks: () => [a, b],
    filterListTracks: (tracks) => tracks, getArtworkForTrack: () => '', formatTime: () => '0:00',
    artMarkup: () => '', iconMarkup: () => '', contextSearchMarkup: () => '', selectionToolbarMarkup: () => '',
    escapeHtml: (text) => String(text).replaceAll('"', '&quot;'),
    mountTrackCollection: (_, tracks) => { mounted = tracks; }
  });
  const container = {};
  app.renderEntityView(container, 'album', app.albumIdentity(b));
  assert.equal(ids(mounted), 'B');
  assert.match(container.innerHTML, />Greatest Hits<\/h2>/);
});

test('changing or removing a playlist cover leaves genuine track artwork intact', () => {
  for (const replacement of ['new-cover', '']) {
    const song = { ...track('A'), artworkPath: '/music/song.jpg', artworkUrl: 'song-cover' };
    const folder = { id: 'folder', path: '/music', tracks: [song], artworkUrl: 'song-cover' };
    const app = load(['refreshEditedPlaylist'], {
      state: { library: { folders: [folder] }, view: { type: 'playlist' } },
      remapLocalPath: (value) => value, remapLocalUrl: (value) => value,
      normalizeLibrary() {}, updateMediaSession() {}, persistPlaybackSession() {}
    });
    app.refreshEditedPlaylist({ folderPath: folder.path, id: folder.id, name: 'Music', artworkUrl: replacement }, folder);
    assert.equal(song.artworkUrl, 'song-cover');
    assert.equal(song.artworkPath, '/music/song.jpg');
  }
});

function settings(saveSettings) {
  return load(['persistSettings', 'chooseLibrary'], {
    state: { settings: { libraryPath: '/old', theme: 'lyra' }, selectedId: 'old' },
    settingsSaveChain: Promise.resolve(), librarySwitching: false,
    writeCachedAppearance() {}, showToast() {}, scanLibrary() { throw new Error('Unexpected scan'); },
    window: { spotfck: { saveSettings, chooseLibrary: async () => '/new' } }
  });
}

test('failed library save keeps the previous selection and does not scan', async () => {
  const app = settings(async () => { throw new Error('disk full'); });
  let scanned = false;
  app.scanLibrary = () => { scanned = true; };
  await app.chooseLibrary();
  assert.equal(app.state.settings.libraryPath, '/old');
  assert.equal(app.state.selectedId, 'old');
  assert.equal(scanned, false);
  assert.equal(app.librarySwitching, false);
});

test('successful library switch commits after save; queued preferences cannot undo it', async () => {
  const first = deferred();
  const writes = [];
  const app = settings(async (value) => { writes.push(value); if (writes.length === 1) await first.promise; });
  let scanRoot;
  app.scanLibrary = () => { scanRoot = app.state.settings.libraryPath; };
  const switchRequest = app.chooseLibrary();
  await flush();
  assert.equal(app.state.settings.libraryPath, '/old');
  const preferences = app.persistSettings();
  first.resolve();
  await Promise.all([switchRequest, preferences]);
  assert.equal(scanRoot, '/new');
  assert.equal(writes[0].libraryPath, '/new');
  assert.equal(Object.hasOwn(writes[1], 'libraryPath'), false);
});

function scanner() {
  const calls = [];
  const previous = { rootPath: '/music', ok: true, folders: [], likedSongs: [track('A')] };
  const context = {
    state: { settings: { libraryPath: '/music' }, library: previous, queue: [], playbackList: [], basePlaybackList: [] },
    scanRequestId: 0, activeScanClientId: 0, activeScanPromise: null, scanNeedsFullRefresh: false,
    playbackSessionReady: true, reportEvent() {}, render() {}, renderLibrary() {}, renderContent() {}, showToast() {},
    normalizeLibrary: (value) => value, reconcilePlaybackAfterLibraryRefresh() {}, getSelectedItem: () => ({ tracks: [] }),
    window: { spotfck: {
      scanLibrary: (root, id) => { const call = { full: true, id, ...deferred() }; calls.push(call); return call.promise; },
      refreshLibraryChanges: (root, changes, id) => { const call = { full: false, changes, id, ...deferred() }; calls.push(call); return call.promise; },
      watchLibrary: async () => {}
    } }, calls, previous
  };
  return load(['scanLibrary', 'retainLibraryAfterScanFailure'], context);
}

test('overlapping incremental scans promote the replacement to a full scan', async () => {
  const app = scanner();
  const first = app.scanLibrary({ changes: ['/music/A/song.mp3'] });
  await flush();
  const second = app.scanLibrary({ changes: ['/music/B/song.mp3'] });
  await flush();
  assert.equal(app.calls[0].full, false);
  assert.equal(app.calls[1].full, true);
  const library = { rootPath: '/music', ok: true, folders: [], likedSongs: [track('A'), track('B')] };
  app.calls[1].resolve(library);
  await second;
  app.calls[0].resolve({ cancelled: true });
  await first;
  assert.equal(app.state.library, library);
  assert.equal(app.scanNeedsFullRefresh, false);
});

test('scan failures retain the previous library and require a full retry', async () => {
  for (const reject of [false, true]) {
    const app = scanner();
    const request = app.scanLibrary({ changes: ['/music/A.mp3'] });
    await flush();
    if (reject) app.calls[0].reject(new Error('Access denied'));
    else app.calls[0].resolve({ ok: false, error: 'Access denied' });
    await request;
    assert.equal(app.state.library, app.previous);
    const retry = app.scanLibrary({ changes: ['/music/B.mp3'] });
    await flush();
    assert.equal(app.calls[1].full, true);
    app.calls[1].resolve(app.previous);
    await retry;
  }
});

function reorder() {
  const songs = ['A', 'B', 'C'].map((id) => track(id));
  const folder = { id: 'folder', path: '/music', tracks: songs };
  const calls = [];
  return load(['reorderSelectedTracks'], {
    state: { view: { type: 'playlist' }, selectedTracks: songs, library: { rootPath: '/', folders: [folder] } },
    playlistOrderWrites: new Map(), getSelectedItem: () => folder, normalizeLibrary() {}, renderContent() {}, showToast() {},
    window: { spotfck: { reorderPlaylist: (payload) => { const call = { payload, ...deferred() }; calls.push(call); return call.promise; } } },
    calls, folder
  });
}

test('failed reorder rolls back the displayed order', async () => {
  const app = reorder();
  const request = app.reorderSelectedTracks(['A'], 'C', 'after');
  assert.equal(ids(app.folder.tracks), 'BCA');
  await flush();
  app.calls[0].reject(new Error('read only'));
  await request;
  assert.equal(ids(app.folder.tracks), 'ABC');
  assert.equal(ids(app.state.selectedTracks), 'ABC');
});

test('older failed reorder cannot roll back a newer successful reorder', async () => {
  const app = reorder();
  const first = app.reorderSelectedTracks(['A'], 'C', 'after');
  const second = app.reorderSelectedTracks(['C'], 'B', 'before');
  await flush();
  assert.equal(app.calls.length, 1);
  app.calls[0].reject(new Error('first failed'));
  await flush();
  assert.equal(ids(app.folder.tracks), 'CBA');
  app.calls[1].resolve({ ok: true });
  await Promise.all([first, second]);
  assert.equal(ids(app.folder.tracks), 'CBA');
});

test('newer failed reorder rolls back to the most recent successful order', async () => {
  const app = reorder();
  const first = app.reorderSelectedTracks(['A'], 'C', 'after');
  const second = app.reorderSelectedTracks(['C'], 'B', 'before');
  await flush();
  app.calls[0].resolve({ ok: true });
  await flush();
  app.calls[1].reject(new Error('second failed'));
  await Promise.all([first, second]);
  assert.equal(ids(app.folder.tracks), 'BCA');
});

test('refreshEditedPlaylist recomputes track and subfolder IDs to match backend SHA-1 after folder rename', () => {
  const crypto = require('node:crypto');
  const expectedId = (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
  const song = { ...track('old-track-id'), path: '/music/Old/song.mp3', folderPath: '/music/Old' };
  const subfolder = { id: 'old-sub-id', name: 'Disc 1', path: '/music/Old/Disc 1', tracks: [] };
  const folder = { id: 'old-folder-id', name: 'Old', path: '/music/Old', tracks: [song] };
  const app = load(['remapLocalPath', 'refreshEditedPlaylist'], {
    state: {
      library: { folders: [folder, subfolder] },
      view: { type: 'playlist' },
      selectedTrackIds: new Set(['old-track-id']),
      focusedTrackId: 'old-track-id',
      selectionAnchorId: 'old-track-id',
      playbackHistory: ['old-track-id']
    },
    TextEncoder,
    remapLocalUrl: (value) => value,
    normalizeLibrary() {},
    updateMediaSession() {},
    persistPlaybackSession() {}
  });
  const newFolderId = expectedId('/music/Renamed');
  app.refreshEditedPlaylist({ folderPath: '/music/Renamed', id: newFolderId, name: 'Renamed', description: '' }, { path: '/music/Old' });
  const newSongId = expectedId('/music/Renamed/song.mp3');
  assert.equal(song.path, '/music/Renamed/song.mp3');
  assert.equal(song.id, newSongId);
  assert.equal(subfolder.path, '/music/Renamed/Disc 1');
  assert.equal(subfolder.id, expectedId('/music/Renamed/Disc 1'));
  assert.equal(app.state.selectedTrackIds.has(newSongId), true);
  assert.equal(app.state.focusedTrackId, newSongId);
  assert.deepEqual(app.state.playbackHistory, [newSongId]);
});

test('saveTrackEditor releases active audio handle before writing tags and refreshes all track lists', async () => {
  const original = { ...track('song-1'), path: '/music/song.mp3', title: 'Old Title', artist: 'Old Artist', album: 'Old Album' };
  const updated = { ...original, title: 'New Title', artist: 'New Artist', album: 'New Album', year: '2026', genre: 'Synthwave', artworkUrl: '/cache/art.png' };
  let audioReleasedAtEditTime = false;
  let restoredTrack = null;
  const audio = {
    currentTime: 42.5,
    src: '/music/song.mp3',
    pause() {},
    removeAttribute(attr) { if (attr === 'src') this.src = ''; },
    load() {}
  };
  const inputs = {
    trackTitleInput: { value: 'New Title' },
    trackArtistInput: { value: 'New Artist' },
    trackAlbumInput: { value: 'New Album' },
    trackAlbumArtistInput: { value: 'New Album Artist' },
    trackYearInput: { value: '2026' },
    trackNumberInput: { value: '4' },
    trackGenreInput: { value: 'Synthwave' },
    trackCommentInput: { value: 'Remastered' }
  };
  const app = load(['refreshEditedTrack', 'saveTrackEditor'], {
    state: {
      trackEditState: { id: 'song-1', path: '/music/song.mp3', artworkPath: '/covers/new.png', artworkChanged: true, removeArtwork: false },
      currentTrack: original,
      isPlaying: true,
      currentPosition: 42.5,
      library: { folders: [{ id: 'f1', tracks: [original] }], likedSongs: [original] },
      selectedTracks: [original],
      playbackQueue: [original],
      queue: [original]
    },
    audio,
    restorePosition: 0,
    playbackRequestId: 0,
    tracksById: new Map([[original.id, original]]),
    tracksByPath: new Map([[original.path, original]]),
    albumCollectionsCache: [],
    document: { getElementById: (id) => inputs[id] || null },
    window: {
      spotfck: {
        async editTrackMetadata(payload) {
          audioReleasedAtEditTime = audio.src === '';
          assert.equal(payload.title, 'New Title');
          assert.equal(payload.year, '2026');
          assert.equal(payload.trackNo, 4);
          assert.equal(payload.artworkSourcePath, '/covers/new.png');
          return { ok: true, track: updated };
        }
      }
    },
    setCurrentTrack(t) { restoredTrack = t; },
    ensureTrackIndexes() {},
    rebuildDerivedIndexes() {},
    renderAll() {},
    renderQueuePanel() {},
    closeTrackEditor() {},
    showToast() {}
  });
  await app.saveTrackEditor();
  assert.equal(audioReleasedAtEditTime, true);
  assert.equal(restoredTrack.title, 'New Title');
  assert.equal(app.state.library.folders[0].tracks[0].title, 'New Title');
  assert.equal(app.state.library.likedSongs[0].year, '2026');
  assert.equal(app.state.queue[0].genre, 'Synthwave');
  assert.match(app.state.currentTrack.artworkUrl, /^\/cache\/art\.png\?v=\d+$/);
});



test('a pending editor/session seek cannot seek a newly selected song', () => {
  const app = playback();
  app.a.url = 'asset:A'; app.b.url = 'asset:B';
  app.audio.duration = 120;
  app.restoreSeek = null;
  load(['applyPendingPlaybackSeek'], app);
  app.setCurrentTrack(app.a, false, null, { resumePosition: 42 });
  app.setCurrentTrack(app.b);
  app.applyPendingPlaybackSeek();
  assert.equal(app.audio.currentTime, 0);
  app.setCurrentTrack(app.a, false, null, { resumePosition: 42 });
  app.applyPendingPlaybackSeek();
  assert.equal(app.audio.currentTime, 42);
  app.restoreSeek = { requestId: app.playbackRequestId - 1, path: app.a.path, position: 70 };
  app.applyPendingPlaybackSeek();
  assert.equal(app.audio.currentTime, 42);
});

test('Previous and Next retrace consumed queue songs and their playlist anchors', () => {
  for (const queued of ['X', 'A']) {
    const app = playback();
    app.setCurrentTrack(app.b);
    app.queueTracks([app.tracksById.get(queued)]);
    app.nextTrack(); app.nextTrack();
    assert.equal(app.state.currentTrack.id, 'C');
    app.previousTrack();
    assert.equal(app.state.currentTrack.id, queued);
    assert.equal(app.getNextTrack().id, 'C');
    app.nextTrack();
    assert.equal(app.state.currentTrack.id, 'C');
    app.previousTrack(); app.previousTrack();
    assert.equal(app.state.currentTrack.id, 'B');
    app.nextTrack();
    assert.equal(app.state.currentTrack.id, queued);
    app.nextTrack();
    assert.equal(app.state.currentTrack.id, 'C');
  }
});

test('search mounts a virtual collection and keeps a displayed song in the tab order', () => {
  const tracks = Array.from({ length: 50000 }, (_, i) => ({ ...track(String(i)), title: 'Song ' + i, _searchText: 'song' }));
  let mounted;
  const app = load(['renderSearchView', 'uniqueByLabel', 'searchEntityGroupMarkup', 'albumIdentity'], {
    state: { query: 'song', library: { folders: [] }, searchShowAllSongs: true, focusedTrackId: 'missing' },
    getAllTracks: () => tracks, getAlbumCollections: () => [], getArtworkForTrack: () => '',
    artMarkup: () => '', iconMarkup: () => '', escapeHtml: String,
    mountTrackCollection: (_, items) => { mounted = items; }
  });
  const container = {};
  app.renderSearchView(container);
  assert.equal(mounted.length, 50000);
  assert.equal(app.state.focusedTrackId, '0');
  assert.match(container.innerHTML, /track-virtual-body/);
  assert.ok(container.innerHTML.length < 20000);
  app.state.searchShowAllSongs = false;
  app.state.focusedTrackId = '100';
  app.renderSearchView(container);
  assert.equal(mounted.length, 8);
  assert.equal(app.state.focusedTrackId, '0');
});

test('a successful tag edit advances the delta baseline only when its base matches', async () => {
  for (const base of [10, 9]) {
    const app = playback();
    app.state.library = { rootPath: '/music', scannedAt: 10 };
    app.state.trackEditState = { id: app.a.id, path: app.a.path };
    app.audio.paused = true;
    Object.assign(app, {
      document: { getElementById: () => ({ value: '' }) },
      window: { spotfck: { editTrackMetadata: async () => ({ ok: true, track: app.a, baseScannedAt: base, scannedAt: 11 }) } },
      refreshEditedTrack() {}, closeTrackEditor() {}
    });
    load(['saveTrackEditor'], app);
    await app.saveTrackEditor();
    assert.equal(app.state.library.scannedAt, base === 10 ? 11 : 10);
  }
});


test('virtual rows retain a keyboard entry point when the previous focus is offscreen', () => {
  const tracks = Array.from({ length: 100 }, (_, i) => track(String(i)));
  const body = { innerHTML: '', children: [] };
  const list = { isConnected: true, _virtualTracks: tracks, _virtualFrame: 0, scrollTop: 0, clientHeight: 300,
    querySelector: (selector) => selector === '.track-header' ? { getBoundingClientRect: () => ({ height: 46 }) } : body };
  let frame;
  const app = load(['renderVirtualTrackRows', 'renderTrackRow', 'trackNumberMarkup', 'escapeHtml', 'albumIdentity'], {
    state: { focusedTrackId: '99', currentTrack: null, selectedTrackIds: new Set() }, audio: { paused: true },
    TRACK_ROW_HEIGHT: 62, TRACK_VIRTUAL_OVERSCAN: 12, requestAnimationFrame: (callback) => { frame = callback; return 1; },
    iconMarkup: () => '', artMarkup: () => '', getArtworkForTrack: () => '', formatTime: () => '0:00'
  });
  app.renderVirtualTrackRows(list); frame();
  assert.equal(app.state.focusedTrackId, '0');
  assert.equal((body.innerHTML.match(/tabindex="0"/g) || []).length, 1);
});


test('restoring a session after Previous preserves its forward queue history', () => {
  const app = playback();
  const saved = new Map();
  Object.assign(app, {
    localStorage: { setItem: (key, value) => saved.set(key, value), getItem: (key) => saved.get(key) || null },
    PLAYBACK_SESSION_KEY: 'session', playbackSessionReady: true, playbackSessionDirty: true,
    tracksByPath: new Map([...app.tracksById.values()].map((song) => [song.path.toLowerCase(), song])),
    lastPositionWrite: 0
  });
  load(['writePlaybackPosition', 'writePlaybackSessionNow', 'readPlaybackSession', 'restorePlaybackSession'], app);
  app.setCurrentTrack(app.b);
  app.queueTracks([app.x]);
  app.nextTrack(); app.nextTrack(); app.previousTrack();
  app.writePlaybackSessionNow();
  app.state.currentTrack = null;
  app.state.playbackAnchorPath = '';
  app.state.playbackHistory = []; app.state.playbackHistoryContexts = []; app.state.playbackForward = [];
  assert.equal(app.restorePlaybackSession(), true);
  assert.equal(app.state.currentTrack.id, 'X');
  assert.equal(app.getNextTrack().id, 'C');
  app.nextTrack();
  assert.equal(app.state.currentTrack.id, 'C');
});
