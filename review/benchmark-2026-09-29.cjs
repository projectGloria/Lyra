// Synthetic CPU/string measurements. No WebView DOM parsing/layout or IPC is included.
// Run: node review/benchmark-2026-09-29.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const names = ['normalizeLibrary', 'renderQueuePanel', 'escapeHtml', 'formatTime', 'getArtworkForTrack', 'artMarkup'];
const functions = names.map((name) => {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}).join('\n');
const list = { innerHTML: '', clientHeight: 340, scrollTop: 0 }, summary = {};
const panel = { classList: { contains: () => false } };
const context = {
  state: { selectedTrackIds: new Set(), selectedId: 'liked', playbackHistory: [], queueView: 'queue' },
  document: { getElementById: (id) => id === 'queueList' ? list : id === 'queuePanel' ? panel : summary, querySelectorAll: () => [], querySelector: () => null },
  tracksById: new Map(),
  iconMarkup: () => '<svg></svg>'
};
vm.runInNewContext(functions, context);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const size of [1000, 10000, 50000]) {
  const tracks = Array.from({ length: size }, (_, i) => ({
    id: String(i), path: `C:\\Music\\Album ${Math.floor(i / 12)}\\Song ${i}.mp3`,
    title: `Song ${i}`, artist: `Artist ${i % 500}`, album: `Album ${Math.floor(i / 12)}`,
    duration: 240, durationLabel: '4:00', artworkUrl: ''
  }));
  const library = { likedSongs: tracks, folders: [] };
  context.tracksById = new Map(tracks.map((track) => [track.id, track]));
  const normalize = [], queue = [];
  context.state.queue = tracks;
  for (let run = 0; run < 4; run++) {
    let start = performance.now();
    context.normalizeLibrary(library);
    if (run) normalize.push(performance.now() - start);
    start = performance.now();
    context.renderQueuePanel();
    if (run) queue.push(performance.now() - start);
  }
  console.log(JSON.stringify({ tracks: size, normalizeMs: +median(normalize).toFixed(1),
    queueWindowHtmlMs: +median(queue).toFixed(1), queueWindowHtmlKiB: +(Buffer.byteLength(list.innerHTML) / 1024).toFixed(1) }));
}
