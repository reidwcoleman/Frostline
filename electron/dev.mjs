#!/usr/bin/env node
// `npm run electron:dev` — run the Electron shell against the Vite dev server (HMR included).
// Reuses a dev server already listening on 127.0.0.1:5317; otherwise starts one and stops it on exit.
// Extra args are forwarded to Electron, e.g.  npm run electron:dev -- --no-steam --frostline-query=skipMenu=1
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_URL = process.env.FROSTLINE_DEV_URL || 'http://127.0.0.1:5317/';

async function isUp() {
  try {
    const res = await fetch(DEV_URL, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

let vite = null;
if (!(await isUp())) {
  console.log('[electron:dev] starting vite on', DEV_URL);
  vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5317', '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: 'inherit',
  });
  const t0 = Date.now();
  while (!(await isUp())) {
    if (Date.now() - t0 > 30000) {
      console.error('[electron:dev] vite did not come up within 30 s');
      vite.kill();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
} else {
  console.log('[electron:dev] using running vite at', DEV_URL);
}

const env = { ...process.env, FROSTLINE_DEV_URL: DEV_URL };
delete env.ELECTRON_RUN_AS_NODE; // some editors set this; it would turn Electron into plain Node
const child = spawn(electronPath, [root, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env });
const stop = () => {
  if (vite) vite.kill();
};
child.on('exit', (code) => {
  stop();
  process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
