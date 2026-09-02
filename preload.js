const { contextBridge, ipcRenderer } = require('electron');

// #7: Helper that replaces any existing listener on a channel before attaching a new one,
// preventing listener accumulation if an on* method is called more than once.
function replaceListener(channel, wrapper) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, wrapper);
}

contextBridge.exposeInMainWorld('electronAPI', {
  buildTracks:      (paths)    => ipcRenderer.invoke('build-tracks', paths),
  openFiles:        ()         => ipcRenderer.invoke('open-files'),
  openFolder:       ()         => ipcRenderer.invoke('open-folder'),
  exportPlaylist:   (data)     => ipcRenderer.invoke('export-playlist', data),
  getAppSettings:   ()         => ipcRenderer.invoke('get-app-settings'),
  setAppSettings:   (settings) => ipcRenderer.invoke('set-app-settings', settings),
  getKeybindings:   ()         => ipcRenderer.invoke('get-keybindings'),
  saveKeybindings:  (bindings) => ipcRenderer.invoke('save-keybindings', bindings),
  saveQueue:        (data)     => ipcRenderer.invoke('save-queue', data),
  loadQueue:        ()         => ipcRenderer.invoke('load-queue'),
  showInFolder:     (fp)       => ipcRenderer.send('show-in-folder', fp),
  minimizeWindow:   ()         => ipcRenderer.send('window-minimize'),
  maximizeWindow:   ()         => ipcRenderer.send('window-maximize'),
  toggleFullscreen: ()         => ipcRenderer.send('toggle-fullscreen'),
  toggleMiniPlayer: ()         => ipcRenderer.send('toggle-mini-player'),
  closeWindow:      ()         => ipcRenderer.send('window-close'),
  updateDiscord:    (data)     => ipcRenderer.send('update-discord', data),
  onMaximizeChange:   (cb) => replaceListener('window-maximized',  (_e, val)    => cb(val)),
  onFullscreenChange: (cb) => replaceListener('fullscreen-change', (_e, val)    => cb(val)),
  onMiniPlayerChange: (cb) => replaceListener('mini-player-change',(_e, val)    => cb(val)),
  onFolderUpdated:    (cb) => replaceListener('folder-updated',    (_e, tracks) => cb(tracks)),
  onOpenFiles:        (cb) => replaceListener('open-files',        (_e, tracks) => cb(tracks)),
  onOpenPlaylist:     (cb) => replaceListener('open-playlist',     (_e, data)   => cb(data)),
  onAppSettings:      (cb) => replaceListener('app-settings',      (_e, s)      => cb(s)),
  onMediaKey:         (cb) => replaceListener('media-key',         (_e, key)    => cb(key)),
  onKeybindings:      (cb) => replaceListener('keybindings',       (_e, kb)     => cb(kb)),
  pickDirectory:    ()         => ipcRenderer.invoke('pick-directory'),
  pickImage:        ()         => ipcRenderer.invoke('pick-image'),
  createPlaylistFolder: (n)    => ipcRenderer.invoke('create-playlist-folder', n),
  moveTrackToPlaylist: (t, p)  => ipcRenderer.invoke('move-track-to-playlist', t, p),
  copyImageToPlaylist: (s, p)  => ipcRenderer.invoke('copy-image-to-playlist', s, p),
});
