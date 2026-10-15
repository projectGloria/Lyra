const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const start = source.indexOf('function bindBackgroundFullscreenShortcut()');
  const end = source.indexOf('\nfunction bindEvents()', start);
  const handlers = {};
  let toggles = 0;
  class Element {
    constructor(region) { this.region = region; }
    closest(selector) {
      return selector.split(',').some((part) => part.trim() === this.region) ? this : null;
    }
  }
  const state = { fullscreenView: false };
  vm.runInNewContext(source.slice(start, end) + '\nbindBackgroundFullscreenShortcut();', {
    Element, state,
    document: { addEventListener: (type, handler) => { handlers[type] = handler; } },
    toggleFullscreenView: () => { toggles++; }
  });
  const emit = (type, region, detail, button = 0) => handlers[type]({
    target: new Element(region), detail, button, preventDefault() {}
  });
  return { emit, state, toggles: () => toggles };
}

test('title-bar double-click retargeted to content does not open player', () => {
  for (const region of ['.topbar', '[data-tauri-drag-region]', '.app-drag', 'button']) {
    const app = setup();
    app.emit('mousedown', region, 1);
    app.emit('mousedown', '.workspace', 2);
    app.emit('dblclick', '.workspace', 2);
    assert.equal(app.toggles(), 0);
  }
});

test('background double-click still opens player and leaves open player alone', () => {
  const app = setup();
  for (const open of [false, true]) {
    app.state.fullscreenView = open;
    app.emit('mousedown', '.workspace', 1);
    app.emit('mousedown', '.workspace', 2);
    app.emit('dblclick', '.workspace', 2);
    assert.equal(app.toggles(), 1);
  }
});

test('a new background gesture works after an excluded gesture', () => {
  const app = setup();
  app.emit('mousedown', '.topbar', 1);
  app.emit('dblclick', '.topbar', 2);
  app.emit('mousedown', '.workspace', 1);
  app.emit('mousedown', '.workspace', 2);
  app.emit('dblclick', '.workspace', 2);
  assert.equal(app.toggles(), 1);
});
