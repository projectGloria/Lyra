const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);

let mm;

async function buildTrack(fp) {
  try {
    const stats = await fs.promises.stat(fp);
    if (stats.isDirectory()) {
      return {
        type: 'folder',
        name: path.basename(fp),
        path: fp,
        parentPath: path.dirname(fp)
      };
    }
    const base = {
      path:     fp,
      name:     path.basename(fp, path.extname(fp)),
      artist:   '',
      ext:      path.extname(fp).slice(1).toUpperCase(),
      size:     stats.size,
      parentPath: path.dirname(fp),
    };
    try {
      if (!mm) mm = await import('music-metadata');
      const meta = await mm.parseFile(fp, { duration: true, skipCovers: true });
      const c    = meta.common;
      if (c.title)  base.name   = c.title;
      if (c.artist) base.artist = c.artist;
      else if (c.albumartist) base.artist = c.albumartist;
      if (meta.format && meta.format.duration) base.duration = meta.format.duration;
    } catch (_) {}
    return base;
  } catch (_) {
    return null;
  }
}

async function buildTrackList(items) {
  const CHUNK_SIZE = 50;
  const results = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(chunk.map(async item => {
      if (typeof item === 'string') {
        return await buildTrack(item);
      } else {
        return item; // It's a folder marker
      }
    }));
    results.push(...chunkResults.filter(Boolean));
  }
  return results;
}

async function walkDir(dirPath) {
  const items = [];
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    
    // Separate folders and files
    const folders = entries.filter(e => e.isDirectory());
    const files = entries.filter(e => e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase()));
    
    // Sort both alphabetically
    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    // #13: Scan all subdirectories in parallel. Promise.all preserves insertion order,
    // so the alphabetical sort above is still honoured in the final output.
    const subResults = await Promise.all(
      folders.map(async (folder) => {
        const fullPath = path.join(dirPath, folder.name);
        const subItems = await walkDir(fullPath);
        return { name: folder.name, fullPath, subItems };
      })
    );

    for (const { name, fullPath, subItems } of subResults) {
      items.push({ type: 'folder', name, path: fullPath, parentPath: dirPath });
      items.push(...subItems);
    }

    // Then process files
    for (const file of files) {
      items.push(path.join(dirPath, file.name));
    }
  } catch (_) {}
  return items;
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'buildTrackList') {
      const result = await buildTrackList(msg.items);
      parentPort.postMessage({ id: msg.id, result });
    } else if (msg.type === 'walkDir') {
      const result = await walkDir(msg.dirPath);
      parentPort.postMessage({ id: msg.id, result });
    }
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: err.message });
  }
});
