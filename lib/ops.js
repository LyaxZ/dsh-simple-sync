/**
 * dsh-simple-sync — core ops (P1).
 *
 * Snapshot / diff / apply for the sync units of a DSH home directory.
 * Pure Node builtins; the external process runner (git/pnpm) is injected
 * so the same code runs inside DSH (ctx.subprocess) and in standalone
 * tests (child_process).
 *
 * Sync units (whitelist — everything else is excluded by construction):
 *   settings.yaml, .credentials.yaml (opt-in), profiles/<name>/package.json,
 *   profiles/<name>/cordis.patch.yml, profiles/<name>/pnpm-workspace.yaml,
 *   .agent-presets/<subdir> (recursive).
 *
 * Snapshot format:
 *   { meta: { machine, time, unitVersion }, files: [{ path, sha256, content }] }
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { promises as fs } from 'node:fs';

export const SYNC_DIR_NAME = '.dsh-sync';
export const BACKUPS_DIR = 'backups';
export const STATE_FILE = 'state.json';
export const UNIT_VERSION = 1;

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * Resolve ~/.dsh from a launchEnvironment-like map (DSH side) with
 * process.env fallback (standalone tests / CLI side).
 */
export function resolveDshHome(env) {
  const get = (k) => (env && typeof env.get === 'function' ? env.get(k)?.value : env?.[k]);
  const home = get('HOME') || get('USERPROFILE') || process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error('无法解析 HOME/USERPROFILE');
  return get('DSH_HOME') || join(home, '.dsh');
}

export function syncRoot(dshHome) {
  return join(dshHome, SYNC_DIR_NAME);
}

export function backupsRoot(dshHome) {
  return join(syncRoot(dshHome), BACKUPS_DIR);
}

// ---------------------------------------------------------------------------
// unit collection
// ---------------------------------------------------------------------------

/**
 * List sync unit specs (relative POSIX paths) for a dsh home.
 * Optional units are skipped when absent; profile units are enumerated
 * from the profiles/ directory (never hardcoded to "web").
 */
export async function listSyncUnits(dshHome, { includeCredentials = false } = {}) {
  const units = [{ path: 'settings.yaml' }];
  if (includeCredentials) units.push({ path: '.credentials.yaml' });

  const profilesDir = join(dshHome, 'profiles');
  let profileNames = [];
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    profileNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !n.startsWith('.'))
      .sort();
  } catch {
    // no profiles dir — fine, root units only
  }
  for (const p of profileNames) {
    units.push(
      { path: `profiles/${p}/package.json` },
      { path: `profiles/${p}/cordis.patch.yml` },
      { path: `profiles/${p}/pnpm-workspace.yaml` },
    );
  }

  // .agent-presets/** recursive
  const presetsDir = join(dshHome, '.agent-presets');
  try {
    await walkDir(presetsDir, (rel) => units.push({ path: `.agent-presets/${rel}` }));
  } catch {
    // absent — fine
  }
  return units;
}

async function walkDir(dir, onFile, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walkDir(full, onFile, rel);
    } else if (e.isFile()) {
      onFile(rel);
    }
  }
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

export function sha256Of(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Map a snapshot-relative POSIX path onto the local filesystem. */
function absPath(dshHome, rel) {
  return join(dshHome, ...rel.split('/'));
}

async function readUnit(dshHome, relPath) {
  const abs = absPath(dshHome, relPath);
  const content = await fs.readFile(abs, 'utf8');
  return { path: relPath, sha256: sha256Of(content), content };
}

/** Build a snapshot of the current machine state. */
export async function buildSnapshot(dshHome, opts = {}) {
  const units = await listSyncUnits(dshHome, opts);
  const files = [];
  for (const u of units) {
    try {
      files.push(await readUnit(dshHome, u.path));
    } catch (err) {
      if (err?.code === 'ENOENT') continue; // optional unit absent
      throw err;
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    meta: { machine: hostname(), time: new Date().toISOString(), unitVersion: UNIT_VERSION },
    files,
  };
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/**
 * Diff a snapshot against the local current state.
 * Returns per-file actions: 'added' (not present locally), 'modified',
 * 'unchanged', or 'conflict' (local content differs AND local was never
 * recorded — treated as 'modified' in v1, see applySnapshot).
 */
export async function diffSnapshot(snapshot, dshHome) {
  const result = { added: [], modified: [], unchanged: [], missing: [] };
  for (const f of snapshot.files || []) {
    const abs = absPath(dshHome, f.path);
    let localSha = null;
    try {
      const content = await fs.readFile(abs, 'utf8');
      localSha = sha256Of(content);
    } catch {
      // ENOENT → added
    }
    if (localSha === null) result.added.push(f);
    else if (localSha === f.sha256) result.unchanged.push(f.path);
    else result.modified.push(f);
  }
  return result;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function stampNow() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
}

/**
 * Backup local files that are about to be overwritten (or removed).
 * Copies into <syncRoot>/backups/<timestamp>/ mirroring the relative path.
 */
async function backupFiles(dshHome, files, signal) {
  if (!files.length) return { dir: null, copied: [] };
  const dir = join(backupsRoot(dshHome), stampNow());
  const copied = [];
  for (const f of files) {
    if (signal?.aborted) throw new Error('操作已取消');
    const src = absPath(dshHome, f.path);
    const dst = absPath(dir, f.path);
    try {
      await fs.access(src);
    } catch {
      continue; // nothing local to back up
    }
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    copied.push(f.path);
  }
  return { dir, copied };
}

/**
 * Apply a snapshot to the local machine: backup overwritten files, write
 * snapshot content, then (optionally) pnpm-install profiles whose
 * package.json gained plugins.
 *
 * runner: async (argv, cwd, { signal }) => { out, err }  — throws on failure.
 * Returns a report; never throws for per-file write issues (collected).
 */
export async function applySnapshot(snapshot, dshHome, { run, signal, installDeps = true, skipMissing = false } = {}) {
  const diff = await diffSnapshot(snapshot, dshHome);
  const toWrite = [...diff.added, ...diff.modified];
  const toBackup = diff.modified.filter((f) => f.path !== '.credentials.yaml');

  const { dir: backupDir, copied: backedUp } = await backupFiles(dshHome, toBackup, signal);

  const written = [];
  const writeErrors = [];
  for (const f of toWrite) {
    if (signal?.aborted) throw new Error('操作已取消');
    const abs = absPath(dshHome, f.path);
    try {
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.content, 'utf8');
      written.push({ path: f.path, action: diff.added.includes(f) ? 'added' : 'modified' });
    } catch (err) {
      writeErrors.push({ path: f.path, error: String(err?.message || err) });
    }
  }

  // Plugin-dependency install: profiles whose package.json changed and now
  // reference bundles/dependencies not present in the old local state.
  let depsInstalled = [];
  let depsFailed = [];
  if (installDeps && run) {
    const changedProfiles = new Set();
    for (const f of written) {
      const m = f.path.match(/^profiles\/([^/]+)\/package\.json$/);
      if (m) changedProfiles.add(m[1]);
    }
    for (const p of changedProfiles) {
      if (signal?.aborted) throw new Error('操作已取消');
      const cwd = join(dshHome, 'profiles', p);
      const frozen = await runPnpm(run, cwd, ['install', '--frozen-lockfile'], signal);
      if (frozen.ok) {
        depsInstalled.push(p);
      } else {
        // lockfile drift → plain install fallback
        const plain = await runPnpm(run, cwd, ['install'], signal);
        if (plain.ok) depsInstalled.push(p);
        else depsFailed.push(p);
      }
    }
  }

  return {
    written,
    writeErrors,
    backedUp,
    backupDir,
    depsInstalled,
    depsFailed,
    restartHint: written.length > 0,
    diff,
  };
}

async function runPnpm(run, cwd, argv, signal) {
  try {
    await run(['pnpm', ...argv], cwd, { signal });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ---------------------------------------------------------------------------
// state (persisted under <syncRoot>/state.json, survives restarts)
// ---------------------------------------------------------------------------

export async function loadState(dshHome) {
  const p = join(syncRoot(dshHome), STATE_FILE);
  try {
    const parsed = JSON.parse(await fs.readFile(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveState(dshHome, state) {
  const root = syncRoot(dshHome);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(join(root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
