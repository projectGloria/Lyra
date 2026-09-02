const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, globalShortcut, protocol } = require('electron');
const path = require('path');
const fs   = require('fs');

// music-metadata is imported lazily on first use to avoid race conditions at startup
let mm;

const COVER_CACHE = new Map(); // path -> { data, format }
const MAX_COVER_CACHE_SIZE = 100;

function addToCoverCache(filePath, data) {
  if (COVER_CACHE.size >= MAX_COVER_CACHE_SIZE) {
    const firstKey = COVER_CACHE.keys().next().value;
    COVER_CACHE.delete(firstKey);
  }
  COVER_CACHE.set(filePath, data);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'lyra', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

let mainWindow;
let tray = null;
let pendingFiles = [];
let isQuitting = false; // #23: Module-level flag instead of dynamic property on `app`

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);
const LYRA_PLAYLIST_EXT = '.lyra';

function isAudioFile(fp) {
  try { return AUDIO_EXTS.has(path.extname(fp).toLowerCase()); } catch { return false; }
}
function isLyraPlaylist(fp) {
  try { return path.extname(fp).toLowerCase() === LYRA_PLAYLIST_EXT; } catch { return false; }
}

// ── Window bounds persistence ─────────────────────────────────────────────────
const BOUNDS_FILE = path.join(app.getPath('userData'), 'window-bounds.json');
const MINI_BOUNDS_FILE = path.join(app.getPath('userData'), 'mini-bounds.json');

let isMiniPlayer = false;

function loadBounds() {
  try {
    const raw = fs.readFileSync(BOUNDS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function loadMiniBounds() {
  try {
    const raw = fs.readFileSync(MINI_BOUNDS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function saveBounds() {
  if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
  try {
    const b = mainWindow.getBounds();
    if (isMiniPlayer) {
      await fs.promises.writeFile(MINI_BOUNDS_FILE, JSON.stringify(b), 'utf8');
    } else {
      await fs.promises.writeFile(BOUNDS_FILE, JSON.stringify(b), 'utf8');
    }
  } catch (_) {}
}

// ── App settings persistence ──────────────────────────────────────────────────
const APP_SETTINGS_FILE = path.join(app.getPath('userData'), 'app-settings.json');

function loadAppSettings() {
  try {
    const raw = fs.readFileSync(APP_SETTINGS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return { closeMinimizes: false };
  }
}

async function saveAppSettings(s) {
  try {
    await fs.promises.writeFile(APP_SETTINGS_FILE, JSON.stringify(s), 'utf8');
  } catch (_) {}
}

let appSettings = loadAppSettings();

// ── Lyra.cfg keybinding config ────────────────────────────────────────────────
// Look for Lyra.cfg in several locations (first found wins)
function getLyraConfigPaths() {
  const names = ['Lyra.cfg', 'lyra.cfg'];
  const dirs  = [app.getPath('userData'), app.getPath('home'), __dirname];
  const paths = [];
  for (const d of dirs) {
    for (const n of names) paths.push(path.join(d, n));
  }
  return paths;
}

// Returns the first Lyra.cfg path that exists, or the userData path for saving
function findLyraConfigPath() {
  for (const p of getLyraConfigPaths()) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

const ACTION_MAP = {
  play: 'playpause', pause: 'playpause', playpause: 'playpause',
  next: 'next',
  prev: 'prev', previous: 'prev',
  shuffle: 'shuffle',
  repeat: 'repeat',
  mute: 'mute',
  quit: 'quit', exit: 'quit',
  equalizer: 'equalizer', eq: 'equalizer',
  toggle_eq: 'toggle_eq', toggleeq: 'toggle_eq',
  settings: 'settings',
  seek_forward: 'seek_forward', seekforward: 'seek_forward',
  seek_backward: 'seek_backward', seekbackward: 'seek_backward',
  volume_up: 'volume_up', volumeup: 'volume_up',
  volume_down: 'volume_down', volumedown: 'volume_down',
  stop: 'stop',
  toggle_mini: 'toggle_mini', togglemini: 'toggle_mini',
};

const KEY_MAP = {
  'space': ' ',
  'escape': 'escape', 'esc': 'escape',
  'tab': 'tab',
  'enter': 'enter', 'return': 'enter',
  'uparrow': 'arrowup', 'up': 'arrowup',
  'downarrow': 'arrowdown', 'down': 'arrowdown',
  'leftarrow': 'arrowleft', 'left': 'arrowleft',
  'rightarrow': 'arrowright', 'right': 'arrowright',
  'ins': 'insert', 'insert': 'insert',
  'del': 'delete', 'delete': 'delete',
  'home': 'home',
  'end': 'end',
  'pgup': 'pageup', 'pageup': 'pageup',
  'pgdn': 'pagedown', 'pagedown': 'pagedown',
  'backspace': 'backspace',
  'capslock': 'capslock',
  'pause': 'pause',
  'backquote': '`',
  'semicolon': ';',
  'quote': "'",
  'comma': ',',
  'period': '.',
  'slash': '/',
  'backslash': '\\',
  'leftbracket': '[',
  'rightbracket': ']',
  'minus': '-',
  'equals': '=',
  'kp_ins': '0', 'kp_0': '0',
  'kp_end': '1', 'kp_1': '1',
  'kp_downarrow': '2', 'kp_2': '2',
  'kp_pgdn': '3', 'kp_3': '3',
  'kp_leftarrow': '4', 'kp_4': '4',
  'kp_5': '5',
  'kp_rightarrow': '6', 'kp_6': '6',
  'kp_home': '7', 'kp_7': '7',
  'kp_uparrow': '8', 'kp_8': '8',
  'kp_pgup': '9', 'kp_9': '9',
  'kp_del': '.',
  'kp_slash': '/',
  'kp_multiply': '*',
  'kp_minus': '-',
  'kp_plus': '+',
  'kp_enter': 'enter',
  'mwheelup': 'mwheelup',
  'mwheeldown': 'mwheeldown',
};

function parseLyraConfig(content) {
  const config = {
    bindings: {},
    theme: {},
    settings: {}
  };

  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;

    // bind "key" [toggle] action
    const bindMatch = t.match(/^bind\s+"([^"]+)"\s+(?:toggle\s+)?(\S+)$/i);
    if (bindMatch) {
      const keyRaw = bindMatch[1].toLowerCase();
      const actionRaw = bindMatch[2].toLowerCase();
      const action = ACTION_MAP[actionRaw];
      if (action) {
        const mappedKey = KEY_MAP[keyRaw] || keyRaw;
        config.bindings[mappedKey] = action;
      }
      continue;
    }

    // theme_... value
    const themeMatch = t.match(/^theme_(\w+)\s+(.+)$/i);
    if (themeMatch) {
      config.theme[themeMatch[1]] = themeMatch[2].trim();
      continue;
    }

    // other settings
    const settingMatch = t.match(/^(\w+)\s+(.+)$/i);
    if (settingMatch) {
      const key = settingMatch[1].toLowerCase();
      const val = settingMatch[2].trim();
      let parsedVal;
      if (val.toLowerCase() === 'true') parsedVal = true;
      else if (val.toLowerCase() === 'false') parsedVal = false;
      else if (!isNaN(val) && val !== '') parsedVal = parseFloat(val);
      else parsedVal = val;
      config.settings[key] = parsedVal;
    }
  }
  return config;
}

function loadLyraConfig() {
  const p = findLyraConfigPath();
  if (!p) return { _cfgPath: path.join(app.getPath('userData'), 'Lyra.cfg'), bindings: {}, theme: {}, settings: {} };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return { ...parseLyraConfig(raw), _cfgPath: p };
  } catch (_) {
    return { _cfgPath: p, bindings: {}, theme: {}, settings: {} };
  }
}


// ── Single-instance lock ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // Check for .lyra playlist files first
    const playlists = argv.filter(isLyraPlaylist);
    const files = argv.filter(isAudioFile);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (playlists.length) {
        loadPlaylistFile(playlists[0]);
      } else if (files.length) {
        buildTrackList(files).then(tracks =>
          mainWindow.webContents.send('open-files', tracks)
        );
      }
    }
  });
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (isLyraPlaylist(filePath)) {
    if (mainWindow) loadPlaylistFile(filePath);
    else pendingFiles.push({ type: 'playlist', path: filePath });
    return;
  }
  if (!isAudioFile(filePath)) return;
  if (mainWindow) {
    buildTrackList([filePath]).then(tracks =>
      mainWindow.webContents.send('open-files', tracks)
    );
  } else {
    pendingFiles.push({ type: 'audio', path: filePath });
  }
});

// ── Playlist file handling ────────────────────────────────────────────────────
async function loadPlaylistFile(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8'); // #2: was blocking readFileSync
    const data = JSON.parse(raw);
    if (!data.tracks || !Array.isArray(data.tracks)) return;
    const paths = data.tracks.map(t => t.path).filter(Boolean);
    const tracks = await buildTrackList(paths);
    if (tracks.length && mainWindow) {
      mainWindow.webContents.send('open-playlist', {
        tracks,
        name: data.name || path.basename(filePath, LYRA_PLAYLIST_EXT),
      });
    }
  } catch (_) {}
}

// ── Metadata helper ───────────────────────────────────────────────────────────
const { Worker } = require('worker_threads');
let workerId = 0;
const workerCallbacks = new Map();

function rejectAll(err) {
  for (const { reject } of workerCallbacks.values()) reject(err);
  workerCallbacks.clear();
}

// #1: Keep a reference so we can respawn the worker after an unexpected crash.
let worker;
function createWorker() {
  const w = new Worker(path.join(__dirname, 'worker.js'));
  w.on('message', (msg) => {
    if (workerCallbacks.has(msg.id)) {
      const { resolve, reject } = workerCallbacks.get(msg.id);
      workerCallbacks.delete(msg.id);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    }
  });
  w.on('error', (err) => rejectAll(err));
  w.on('exit', (code) => {
    if (code !== 0) {
      rejectAll(new Error(`Worker stopped with exit code ${code}`));
      worker = createWorker(); // Respawn so future metadata calls don't hang
    }
  });
  return w;
}
worker = createWorker();

function buildTrackList(items) {
  return new Promise((resolve, reject) => {
    const id = ++workerId;
    workerCallbacks.set(id, { resolve, reject });
    worker.postMessage({ type: 'buildTrackList', items, id });
  });
}

// ── Custom Protocol for Covers ────────────────────────────────────────────────
const PENDING_COVERS = new Map();
function registerProtocols() {
  protocol.handle('lyra', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'cover') return new Response(null, { status: 404 });
    
    // Path is base64 encoded to safely transport absolute filesystem paths
    const filePath = Buffer.from(decodeURIComponent(url.pathname.slice(1)), 'base64').toString('utf-8');
    
    // Check cache first
    if (COVER_CACHE.has(filePath)) {
      const cached = COVER_CACHE.get(filePath);
      COVER_CACHE.delete(filePath);
      COVER_CACHE.set(filePath, cached);
      if (!cached) return new Response(null, { status: 404 }); // Cached negative
      return new Response(cached.data, {
        headers: { 
          'Content-Type': cached.format,
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (!PENDING_COVERS.has(filePath)) {
      PENDING_COVERS.set(filePath, (async () => {
        try {
          if (!mm) mm = await import('music-metadata');
          const meta = await mm.parseFile(filePath, { skipCovers: false });
          if (meta.common.picture && meta.common.picture.length > 0) {
            const pic = meta.common.picture[0];
            const result = { data: pic.data, format: pic.format };
            addToCoverCache(filePath, result);
            return result;
          } else {
            addToCoverCache(filePath, null); // Mark as no cover
            return null;
          }
        } catch (_) {
          addToCoverCache(filePath, null);
          return null;
        } finally {
          PENDING_COVERS.delete(filePath);
        }
      })());
    }

    const pic = await PENDING_COVERS.get(filePath);
    if (pic) {
      return new Response(pic.data, {
        headers: { 
          'Content-Type': pic.format,
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    return new Response(null, { status: 404 });
  });
}

// ── Recursive directory walk ───────────────────────────────────────────────────
function walkDir(dirPath) {
  return new Promise((resolve, reject) => {
    const id = ++workerId;
    workerCallbacks.set(id, { resolve, reject });
    worker.postMessage({ type: 'walkDir', dirPath, id });
  });
}

function getFileArgs(argv) {
  const startIdx = app.isPackaged ? 1 : 2;
  return argv.slice(startIdx);
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Lyra');
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show Lyra', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch (_) {}
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  const savedBounds = loadBounds();

  mainWindow = new BrowserWindow({
    width:     savedBounds?.width  ?? 420,
    height:    savedBounds?.height ?? 680,
    x:         savedBounds?.x,
    y:         savedBounds?.y,
    minWidth:  380,
    minHeight: 520,
    resizable: true,
    frame: false,
    transparent: false,
    backgroundColor: '#0d0d0f',
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.loadFile('index.html');
  Menu.setApplicationMenu(null);

  mainWindow.webContents.once('did-finish-load', async () => {
    const allArgs = getFileArgs(process.argv);
    const playlistArgs = allArgs.filter(isLyraPlaylist);
    const audioArgs = allArgs.filter(isAudioFile);
    
    const pendingPlaylists = pendingFiles.filter(f => f.type === 'playlist');
    const pendingAudios = pendingFiles.filter(f => f.type === 'audio').map(f => f.path);
    pendingFiles = [];

    // Send app settings to renderer
    mainWindow.webContents.send('app-settings', appSettings);
    // Send keybindings from Lyra.cfg
    mainWindow.webContents.send('keybindings', loadLyraConfig());

    if (playlistArgs.length || pendingPlaylists.length) {
      const pl = playlistArgs[0] || pendingPlaylists[0]?.path;
      if (pl) await loadPlaylistFile(pl);
    } else {
      const allAudio = [...new Set([...pendingAudios, ...audioArgs])];
      if (allAudio.length) {
        const tracks = await buildTrackList(allAudio);
        mainWindow.webContents.send('open-files', tracks);
      }
    }
  });

  mainWindow.on('maximize',   () => mainWindow.webContents.send('window-maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-maximized', false));
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('fullscreen-change', true));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('fullscreen-change', false));

  let boundsTimer = null;
  const debounceSave = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 400);
  };
  mainWindow.on('resize', debounceSave);
  mainWindow.on('move',   debounceSave);
  mainWindow.on('close',  (e) => {
    saveBounds();
    if (appSettings.closeMinimizes && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      createTray();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  registerProtocols();
  createWindow();
  // #23: Only create tray on startup when closeMinimizes is already enabled
  if (appSettings.closeMinimizes) createTray();

  const send = (key) => { if (mainWindow) mainWindow.webContents.send('media-key', key); };
  try {
    globalShortcut.register('MediaPlayPause',    () => send('playpause'));
    globalShortcut.register('MediaNextTrack',    () => send('next'));
    globalShortcut.register('MediaPreviousTrack',() => send('prev'));
    globalShortcut.register('MediaStop',         () => send('stop'));
  } catch (_) {}
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // #10: close the folder watcher so it doesn't hold OS file descriptors open
  if (currentWatcher) { currentWatcher.close(); currentWatcher = null; }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (!appSettings.closeMinimizes) app.quit();
  }
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    // #23: on macOS, re-show a hidden window when the dock icon is clicked
    mainWindow.show();
    mainWindow.focus();
  }
});
app.on('before-quit', () => { isQuitting = true; });

// ── Discord RPC ───────────────────────────────────────────────────────────────
const DiscordRPC = require('discord-rpc');
// We use a known public client ID for testing so it works out of the box.
// You can replace this with your own Discord App ID from the developer portal to use custom images!
const clientId = '1532036455394705458'; 
DiscordRPC.register(clientId);
const rpc = new DiscordRPC.Client({ transport: 'ipc' });
let rpcReady = false;
rpc.on('ready', () => { rpcReady = true; });
rpc.login({ clientId }).catch(() => { /* ignore connection errors if discord is not running */ });

ipcMain.on('update-discord', (_e, data) => {
  if (!rpcReady) return;
  if (!data || !data.track || !data.isPlaying) {
    rpc.clearActivity().catch(()=>{});
    return;
  }
  const { track, isPlaying, currentTime } = data;
  const startTimestamp = Math.floor(Date.now() / 1000) - Math.floor(currentTime);
  rpc.request('SET_ACTIVITY', {
    pid: process.pid,
    activity: {
      type: 2, // 2 = Listening
      details: track.name || 'Unknown Track',
      state: track.artist || 'Unknown Artist',
      timestamps: { start: startTimestamp },
      assets: {
        large_image: 'lyra_logo',
        large_text: 'Lyra',
        small_image: isPlaying ? 'play_icon' : 'pause_icon',
        small_text: isPlaying ? 'Playing' : 'Paused'
      },
      instance: false,
    }
  }).catch(()=>{});
});

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('open-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio Files', extensions: ['mp3','flac','wav','ogg','m4a','aac','opus','wma'] }],
  });
  if (result.canceled) return [];
  return buildTrackList(result.filePaths);
});

let currentWatcher = null;
let watchTimeout = null;

ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return [];
  const dir = result.filePaths[0];

  if (currentWatcher) { currentWatcher.close(); currentWatcher = null; }
  try {
    // #25: { recursive: true } is only supported on Windows and macOS, not Linux
    const watchOpts = process.platform === 'linux' ? {} : { recursive: true };
    currentWatcher = fs.watch(dir, watchOpts, (eventType, filename) => {
      if (!filename) return;
      if (watchTimeout) clearTimeout(watchTimeout);
      watchTimeout = setTimeout(async () => {
        try {
          const filePaths = await walkDir(dir);
          const tracks = await buildTrackList(filePaths);
          const dirPrefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
          if (mainWindow) mainWindow.webContents.send('folder-updated', { dir: dirPrefix, tracks });
        } catch (err) {}
      }, 1000);
    });
    // #6: Handle the watcher being invalidated (e.g. the directory is deleted)
    currentWatcher.on('error', () => { currentWatcher = null; });
  } catch (err) {}

  const filePaths = await walkDir(dir);
  return buildTrackList(filePaths);
});

ipcMain.handle('build-tracks', async (_e, filePaths) => buildTrackList(filePaths));

ipcMain.handle('export-playlist', async (_e, playlistData) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Playlist',
    defaultPath: 'My Playlist',
    filters: [{ name: 'Lyra Playlist', extensions: ['lyra'] }],
  });
  if (result.canceled || !result.filePath) return { success: false };
  try {
    await fs.promises.writeFile(result.filePath, JSON.stringify(playlistData, null, 2), 'utf8');
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-queue', async (_e, data) => {
  try {
    const p = path.join(app.getPath('userData'), 'queue.json');
    await fs.promises.writeFile(p, JSON.stringify(data), 'utf8');
    return true;
  } catch (_) { return false; }
});

ipcMain.handle('load-queue', async () => {
  try {
    const p = path.join(app.getPath('userData'), 'queue.json');
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
});

ipcMain.handle('pick-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('pick-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

function getPlaylistsDir() {
  if (!appSettings.playlistsDir) {
    throw new Error('Playlists directory is not set. Please set it in Settings or create a playlist first.');
  }
  return appSettings.playlistsDir;
}

// #12: Validates that a resolved path is still inside the expected base directory
function assertInsideBase(resolvedPath, baseDir) {
  const normalBase = path.resolve(baseDir) + path.sep;
  const normalTarget = path.resolve(resolvedPath);
  if (!normalTarget.startsWith(normalBase) && normalTarget !== path.resolve(baseDir)) {
    throw new Error('Path traversal detected: resolved path escapes base directory.');
  }
}

ipcMain.handle('create-playlist-folder', async (_e, name) => {
  const baseDir = getPlaylistsDir();
  const targetDir = path.join(baseDir, name.replace(/[<>:"/\\|?*]+/g, '_'));
  assertInsideBase(targetDir, baseDir); // #12
  await fs.promises.mkdir(targetDir, { recursive: true }); // #24: was sync; recursive mkdir is idempotent
  return targetDir;
});

ipcMain.handle('move-track-to-playlist', async (_e, trackPath, playlistName) => {
  try {
    if (!isAudioFile(trackPath)) {
      return { success: false, error: 'Invalid file type. Only audio files can be moved.' };
    }
    const baseDir = getPlaylistsDir();
    const targetDir = path.join(baseDir, playlistName.replace(/[<>:"/\\|?*]+/g, '_'));
    assertInsideBase(targetDir, baseDir); // #12
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    
    const fileName = path.basename(trackPath);
    const targetPath = path.join(targetDir, fileName);
    
    if (trackPath !== targetPath) {
      await fs.promises.rename(trackPath, targetPath);
    }
    return { success: true, newPath: targetPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// #16: Only allow known image extensions as cover art sources
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
ipcMain.handle('copy-image-to-playlist', async (_e, sourcePath, playlistName) => {
  try {
    const srcExt = path.extname(sourcePath).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(srcExt)) return { success: false, error: 'Invalid image file type.' };
    const baseDir = getPlaylistsDir();
    const targetDir = path.join(baseDir, playlistName.replace(/[<>:"/\\|?*]+/g, '_'));
    assertInsideBase(targetDir, baseDir); // #12
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    
    const ext = path.extname(sourcePath) || '.jpg';
    const cleanName = playlistName.replace(/[<>:"/\\|?*]+/g, '_');
    const targetPath = path.join(targetDir, `${cleanName}${ext}`);
    
    await fs.promises.copyFile(sourcePath, targetPath);
    return { success: true, newPath: targetPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// #6: Handler for saving keybindings back to Lyra.cfg
ipcMain.handle('save-keybindings', async (_e, bindings) => {
  try {
    const cfgPath = findLyraConfigPath() || path.join(app.getPath('userData'), 'Lyra.cfg');
    let existing = '';
    try { existing = await fs.promises.readFile(cfgPath, 'utf8'); } catch (_) {}
    // Remove existing bind lines and append updated ones
    const lines = existing.split('\n').filter(l => !/^bind\s+/i.test(l.trim()));
    const newBindLines = Object.entries(bindings).map(([key, action]) => `bind "${key}" ${action}`); // #8: removed unused ACTION_TO_KEY
    const newContent = [...lines, ...newBindLines].join('\n');
    await fs.promises.writeFile(cfgPath, newContent, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-app-settings', () => appSettings);

ipcMain.handle('get-keybindings', () => loadLyraConfig());

ipcMain.handle('set-app-settings', async (_e, newSettings) => {
  appSettings = { ...appSettings, ...newSettings };
  await saveAppSettings(appSettings);
  // Handle tray based on closeMinimizes
  if (!appSettings.closeMinimizes && tray) destroyTray();
  return appSettings;
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('toggle-fullscreen', () => {
  if (mainWindow) {
    const isFs = mainWindow.isFullScreen();
    mainWindow.setFullScreen(!isFs);
  }
});

let preMiniBounds = null;
let preMiniMaximized = false;
let miniPlayerBounds = loadMiniBounds();

ipcMain.on('toggle-mini-player', () => {
  if (!mainWindow) return;
  isMiniPlayer = !isMiniPlayer;
  if (isMiniPlayer) {
    preMiniMaximized = mainWindow.isMaximized();
    if (preMiniMaximized) {
      mainWindow.unmaximize();
    }
    preMiniBounds = mainWindow.getBounds();
    mainWindow.setMinimumSize(250, 90);
    if (miniPlayerBounds) {
      mainWindow.setBounds(miniPlayerBounds, true);
    } else {
      mainWindow.setSize(280, 100, true);
    }
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.webContents.send('mini-player-change', true);
  } else {
    miniPlayerBounds = mainWindow.getBounds();
    fs.promises.writeFile(MINI_BOUNDS_FILE, JSON.stringify(miniPlayerBounds), 'utf8').catch(()=>{});
    mainWindow.setMinimumSize(380, 520);
    if (preMiniBounds) mainWindow.setBounds(preMiniBounds, true);
    if (preMiniMaximized) mainWindow.maximize();
    mainWindow.setAlwaysOnTop(false);
    mainWindow.webContents.send('mini-player-change', false);
  }
});

ipcMain.on('show-in-folder', (_event, fp) => {
  // #5: shell.showItemInFolder handles missing paths gracefully; no need for blocking existsSync
  const { shell } = require('electron');
  shell.showItemInFolder(fp);
});

ipcMain.on('window-close', () => {
  if (appSettings.closeMinimizes) {
    mainWindow?.hide();
    createTray();
  } else {
    mainWindow?.close();
  }
});
