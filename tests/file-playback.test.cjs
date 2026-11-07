const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const flush = () => new Promise(setImmediate);
const song = (id) => ({ id, path: `C:\\Outside music\\${id}.mp3`, title: id });

// Boots compact.js against fake DOM/Tauri globals and exposes what it does to its <audio>.
function loadMini(pending = []) {
  const listeners = new Map();
  const invoked = [];
  const metadata = new Map();
  const audios = [];
  const elements = new Map();
  const element = () => ({
    textContent: '', title: '', value: '', max: '', disabled: false, tagName: 'DIV', attrs: {},
    addEventListener() {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'src' ? this.src : this.attrs[k]; }
  });
  class FakeAudio {
    constructor() { this.paused = true; this.currentTime = 0; this.duration = NaN; this.volume = 1; this.events = {}; this.played = []; audios.push(this); }
    addEventListener(name, fn) { this.events[name] = fn; }
    getAttribute(name) { return name === 'src' ? this.src : null; }
    play() { this.paused = false; this.played.push(this.src); return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const context = {
    Audio: FakeAudio, setTimeout: (fn) => fn(),
    navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    document: {
      documentElement: { style: { setProperty() {} } }, addEventListener() {},
      getElementById: (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }
    },
    window: { addEventListener() {}, __TAURI__: {
      tauri: {
        convertFileSrc: (file) => `asset:${file}`,
        async invoke(name, args) {
          invoked.push(name);
          if (name === 'take_open_request') return pending.shift() || null;
          if (name === 'opened_track_metadata') return new Promise((resolve) => metadata.set(`${args.requestId}:${args.filePath}`, resolve));
          return {};
        }
      },
      event: { async listen(name, fn) { listeners.set(name, fn); return () => {}; } },
      window: { appWindow: {} }
    } }
  };
  vm.createContext(context);
  vm.runInContext(read('src/compact.js'), context);
  const deliver = async (request) => { pending.push(request); listeners.get('files:pending')(); await flush(); };
  return { audio: audios[0], elements, invoked, metadata, listeners, deliver };
}

test('the mini player plays opened files on its own <audio>, not through the library', async () => {
  const mini = loadMini([{ id: 1, tracks: [song('a'), song('b')], errors: [] }]);
  await flush();
  assert.equal(mini.audio.paused, false);
  assert.equal(mini.audio.src, `asset:${song('a').path}`);
  assert.equal(mini.elements.get('title').textContent, 'a');
  // Only its own native calls: no compact_control / publish_playback round-trips via main.
  assert.deepEqual([...new Set(mini.invoked)].sort(), ['opened_track_metadata', 'read_settings', 'take_open_request']);
});

test('a multi-file selection advances on end and stops after the last file', async () => {
  const mini = loadMini([{ id: 1, tracks: [song('a'), song('b')] }]);
  await flush();
  mini.audio.events.ended();
  assert.equal(mini.audio.src, `asset:${song('b').path}`);
  mini.audio.events.ended();
  assert.equal(mini.audio.paused, true);
  assert.equal(mini.audio.played.length, 2);
});

test('stale metadata and duplicate delivery cannot overwrite a newer selection', async () => {
  const mini = loadMini([{ id: 1, tracks: [song('a')] }]);
  await flush();
  await mini.deliver({ id: 2, tracks: [song('b')] });
  mini.metadata.get(`1:${song('a').path}`)({ ...song('a'), title: 'Old metadata' });
  await flush();
  assert.equal(mini.elements.get('title').textContent, 'b');
  await mini.deliver({ id: 1, tracks: [song('a')] });
  assert.equal(mini.audio.src, `asset:${song('b').path}`);
  mini.metadata.get(`2:${song('b').path}`)({ ...song('b'), title: 'New title', artworkPath: 'C:\\cache\\b.jpg' });
  await flush();
  assert.equal(mini.elements.get('title').textContent, 'New title');
  assert.equal(mini.elements.get('artwork').src, 'asset:C:\\cache\\b.jpg');
});

test('an invalid request shows its error and keeps the current file playing', async () => {
  const mini = loadMini([{ id: 1, tracks: [song('a')] }]);
  await flush();
  await mini.deliver({ id: 2, tracks: [], errors: ['File is missing'] });
  assert.equal(mini.audio.paused, false);
  assert.equal(mini.audio.src, `asset:${song('a').path}`);
  assert.equal(mini.elements.get('message').textContent, 'File is missing');
});

test('the mini player subscribes before draining so a launch during load is not lost', async () => {
  const mini = loadMini([{ id: 1, tracks: [song('a')] }]);
  await flush();
  assert.ok(mini.listeners.has('files:pending'));
  assert.equal(mini.audio.played.length, 1);
});

test('the library only pauses when a file is opened, and never resumes', async () => {
  let handler;
  const audio = { paused: false, pause() { this.paused = true; }, play() { throw Error('Library must not resume'); } };
  const context = { audio, window: { spotfck: { onExternalPlayback: async (fn) => { handler = fn; } } } };
  vm.runInNewContext(read('src/file-playback.js') + '\ninitFilePlayback();', context);
  await flush();
  handler();
  assert.equal(audio.paused, true);
  handler(); // Already paused: a second Explorer launch is a no-op, not a toggle.
  assert.equal(audio.paused, true);
});

test('the bridge exposes the pause nudge and no longer lets the library consume files', async () => {
  const listened = [];
  const context = { URL, console, window: { __TAURI__: {
    tauri: { invoke: async () => null, convertFileSrc: (s) => s }, window: { appWindow: {} }, dialog: {},
    event: { async listen(name) { listened.push(name); return () => {}; } }
  } } };
  vm.runInNewContext(read('src/tauri-bridge.js'), context);
  await context.window.spotfck.onExternalPlayback(() => {});
  assert.deepEqual(listened, ['external:pause']);
  for (const gone of ['startFilePlayback', 'openedTrackMetadata', 'publishPlayback']) assert.equal(context.window.spotfck[gone], undefined);
});

test('native: Explorer launches leave the library window alone; closing destroys the mini player', () => {
  const native = read('src-tauri/src/open_files.rs');
  const receive = native.slice(native.indexOf('pub fn receive('), native.indexOf('#[tauri::command]'));
  assert.doesNotMatch(receive, /main\.hide\(\)/);
  assert.match(receive, /main\.emit\("external:pause"/);
  assert.match(native, /fn take_open_request[\s\S]*?window\.label\(\) != "compact"/);
  const compactClose = native.slice(native.indexOf('if window.label() == "compact" {'), native.indexOf('// Library window.'));
  assert.match(compactClose, /window\.close\(\)/, 'hidden webviews keep playing, so the mini player must be destroyed');
  assert.doesNotMatch(compactClose, /show_main|hide\(\)/, 'dismissing the mini player must not surface the library');
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
