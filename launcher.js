const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const MODE_FILE = path.join(app.getPath('userData'), 'interface-mode.json');
const VALID_MODES = new Set(['lyra', 'sona']);

function readInterfaceMode() {
  try {
    const saved = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    return VALID_MODES.has(saved?.mode) ? saved.mode : 'lyra';
  } catch (_) {
    return 'lyra';
  }
}

function writeInterfaceMode(mode) {
  const normalized = VALID_MODES.has(mode) ? mode : 'lyra';
  fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true });
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: normalized }), 'utf8');
  return normalized;
}

const currentMode = readInterfaceMode();

ipcMain.handle('interface-mode:get', () => currentMode);
ipcMain.handle('interface-mode:set', (_event, requestedMode) => {
  const nextMode = writeInterfaceMode(requestedMode);
  if (nextMode !== currentMode) {
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 120);
  }
  return nextMode;
});

if (currentMode === 'sona') {
  require('./sona/main.cjs');
} else {
  require('./main.js');
}
