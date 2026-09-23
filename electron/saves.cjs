// Save files on disk (main process). Layout, inside app.getPath('userData'):
//   saves/<slot>.json       current save      (Steam Auto-Cloud syncs saves/*.json)
//   saves/<slot>.json.bak   previous good save (fallback if the current one is corrupt)
//   saves/<slot>.json.tmp   in-flight write    (renamed over <slot>.json when complete)
// Writes are atomic (temp file + fsync + rename) and serialised per slot, so a crash or power loss mid-save
// can never leave a half-written <slot>.json.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const SLOT_RE = /^[a-z0-9_-]{1,32}$/;
/** Hard cap for one save (a normal run is well under 1 MB). */
const MAX_BYTES = 16 * 1024 * 1024;

let root = '';
/** slot -> tail of its write queue */
const queues = new Map();

function configure(userDataDir) {
  root = path.join(userDataDir, 'saves');
}

function dir() {
  if (!root) throw new Error('saves not configured');
  return root;
}

function assertSlot(slot) {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot)) throw new Error('invalid save slot');
}

const fileOf = (slot) => path.join(dir(), slot + '.json');

function enqueue(slot, job) {
  const prev = queues.get(slot) || Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  queues.set(slot, next);
  next.finally(() => {
    if (queues.get(slot) === next) queues.delete(slot);
  }).catch(() => {});
  return next;
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function isValidJson(text) {
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

async function read(slot) {
  assertSlot(slot);
  // Wait for a pending write so a read right after save() sees the new data.
  await (queues.get(slot) || Promise.resolve()).catch(() => {});
  return readText(fileOf(slot));
}

async function readBackup(slot) {
  assertSlot(slot);
  await (queues.get(slot) || Promise.resolve()).catch(() => {});
  return readText(fileOf(slot) + '.bak');
}

async function write(slot, data) {
  assertSlot(slot);
  if (typeof data !== 'string') throw new Error('save data must be a string');
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) throw new Error('save data too large');
  return enqueue(slot, async () => {
    await fsp.mkdir(dir(), { recursive: true });
    const file = fileOf(slot);
    const tmp = file + '.tmp';
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Keep the previous save as .bak — but only if it is valid, so a corrupt file never replaces a good backup.
    const prev = await readText(file).catch(() => null);
    if (prev !== null && isValidJson(prev)) await fsp.copyFile(file, file + '.bak').catch(() => {});
    await fsp.rename(tmp, file); // atomic replace on every OS Node supports
    if (process.platform !== 'win32') {
      // Persist the directory entry too (POSIX); best effort.
      try {
        const d = await fsp.open(dir(), 'r');
        await d.sync().catch(() => {});
        await d.close();
      } catch {
        /* ignore */
      }
    }
    return true;
  });
}

async function remove(slot) {
  assertSlot(slot);
  return enqueue(slot, async () => {
    const file = fileOf(slot);
    await Promise.all([file, file + '.bak', file + '.tmp'].map((f) => fsp.rm(f, { force: true })));
    return true;
  });
}

async function list() {
  let names = [];
  try {
    names = await fsp.readdir(dir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = /^([a-z0-9_-]{1,32})\.json$/.exec(name);
    if (!m) continue;
    try {
      const st = await fsp.stat(path.join(dir(), name));
      out.push({ slot: m[1], size: st.size, modified: st.mtimeMs });
    } catch {
      /* raced with delete */
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** Wait for every queued write (used right before the process exits). */
async function drain() {
  await Promise.all([...queues.values()].map((p) => p.catch(() => {})));
}

/** Remove stale temp files from an interrupted write on startup. */
function cleanupTemp() {
  try {
    for (const name of fs.readdirSync(dir())) if (name.endsWith('.json.tmp')) fs.rmSync(path.join(dir(), name), { force: true });
  } catch {
    /* no saves yet */
  }
}

module.exports = { configure, dir, read, readBackup, write, remove, list, drain, cleanupTemp, SLOT_RE, MAX_BYTES };
