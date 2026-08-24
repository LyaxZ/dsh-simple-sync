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
 * resolveExecutable: async (name) => absolute path (ctx.subprocess) — used
 *   to resolve the pnpm shim on Windows; optional, defaults to 'pnpm'.
 * Returns a report; never throws for per-file write issues (collected).
 */
export async function applySnapshot(snapshot, dshHome, { run, resolveExecutable, signal, installDeps = true, skipMissing = false } = {}) {
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
  // If the install fails, roll back the boot-critical profile files
  // (package.json / cordis.patch.yml / pnpm-workspace.yaml) so DSH stays
  // loadable — a written-but-uninstallable bundle list bricks the boot.
  let depsInstalled = [];
  let depsFailed = [];
  let reverted = [];
  let autoInstalled = [];
  if (installDeps && run) {
    const changedProfiles = new Set();
    for (const f of written) {
      const m = f.path.match(/^profiles\/([^/]+)\/package\.json$/);
      if (m) changedProfiles.add(m[1]);
    }
    for (const p of changedProfiles) {
      if (signal?.aborted) throw new Error('操作已取消');
      const cwd = join(dshHome, 'profiles', p);
      const r = await installProfileDeps(run, resolveExecutable, cwd, signal);
      if (r.ok) {
        depsInstalled.push(p);
      } else {
        depsFailed.push({ profile: p, error: r.error });
        const rolled = await rollbackProfile(dshHome, p, backupDir);
        reverted.push({ profile: p, files: rolled });
      }
    }

    // Insert-referenced plugins: cordis.patch.yml may carry `insert` entries
    // whose packages are NOT in package.json (e.g. junction-installed plugins
    // on the source machine). On a fresh target they must be installed too,
    // otherwise the boot fails with "cannot find package <name>". Auto-install
    // the missing ones via `pnpm add` (skips packages already present).
    // Profiles whose main install failed were rolled back — their incoming
    // patch is gone, so installing their orphans would be pointless.
    const rolledProfiles = new Set(reverted.map((r) => r.profile));
    for (const o of await orphanInsertPlugins(snapshot)) {
      if (signal?.aborted) throw new Error('操作已取消');
      if (rolledProfiles.has(o.profile)) continue;
      const nmDir = join(dshHome, 'profiles', o.profile, 'node_modules', o.name);
      const present = await fs.access(nmDir).then(() => true, () => false);
      if (present) continue; // already installed — leave the version alone
      const cwd = join(dshHome, 'profiles', o.profile);
      const r = await addProfilePlugin(run, resolveExecutable, cwd, o.name, signal);
      if (r.ok) {
        autoInstalled.push(`${o.profile}: ${o.name}`);
      } else {
        depsFailed.push({
          profile: o.profile,
          error: `补丁引用的插件 ${o.name} 自动安装失败: ${r.error}（请手动运行 dsh plugin --profile ${o.profile} add ${o.name} 后重试）`,
        });
        const rolled = await rollbackProfile(dshHome, o.profile, backupDir);
        reverted.push({ profile: o.profile, files: rolled });
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
    reverted,
    autoInstalled,
    restartHint: written.length > 0,
    diff,
  };
}

/** Extract plugin names from cordis.patch.yml `insert` blocks. */
export function parseInsertNames(patchYaml) {
  const names = [];
  const lines = String(patchYaml || '').split(/\r?\n/);
  let collect = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!collect) {
      if (/^-?\s*insert:\s*$/.test(trimmed)) collect = true;
      continue;
    }
    // a new top-level entry ends the previous insert block
    if (line.length > 0 && !/^\s/.test(line) && !line.startsWith('#') && !/^-?\s*insert:\s*$/.test(trimmed)) {
      collect = false;
      continue;
    }
    if (line.startsWith('#')) continue;
    const m = trimmed.match(/^name:\s*['"]?([\w@./-]+)['"]?\s*$/);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)];
}

/**
 * Scan the incoming snapshot for `cordis.patch.yml` insert entries whose
 * plugin is NOT declared in that profile's incoming package.json
 * dependencies — these need explicit installation on the target machine.
 */
async function orphanInsertPlugins(snapshot) {
  const orphans = [];
  for (const f of snapshot.files || []) {
    const m = f.path.match(/^profiles\/([^/]+)\/cordis\.patch\.yml$/);
    if (!m) continue;
    const profile = m[1];
    const names = parseInsertNames(f.content);
    if (!names.length) continue;
    const pkgFile = (snapshot.files || []).find((x) => x.path === `profiles/${profile}/package.json`);
    let deps = {};
    if (pkgFile) {
      try {
        deps = JSON.parse(pkgFile.content).dependencies || {};
      } catch {
        // unparseable incoming package.json — treat everything as orphan
      }
    }
    for (const n of names) {
      if (!(n in deps)) orphans.push({ profile, name: n });
    }
  }
  return orphans;
}

/**
 * Windows: pnpm resolves to pnpm.cmd (a batch shim) which Node cannot spawn
 * directly (EINVAL). Route through cmd.exe /d /s /c so the .cmd runs.
 * POSIX: plain argv.
 */
export function pnpmCommand(bin, args) {
  if (process.platform !== 'win32') return [bin, ...args];
  const command = /[\s"]/.test(bin) ? `"${bin}"` : bin;
  const argstr = args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');
  return ['cmd.exe', '/d', '/s', '/c', `${command} ${argstr}`];
}

/** pnpm add <name> in one profile dir (records the dep into package.json). */
async function addProfilePlugin(run, resolveExecutable, cwd, name, signal) {
  let bin = 'pnpm';
  if (typeof resolveExecutable === 'function') {
    try {
      bin = await resolveExecutable('pnpm');
    } catch {
      return { ok: false, error: 'pnpm 未找到（请先安装 pnpm）' };
    }
  }
  try {
    await run(pnpmCommand(bin, ['add', name]), cwd, { signal });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Run the dependency install for one profile: pnpm first (frozen → plain
 * fallback for lockfile drift). resolveExecutable (ctx.subprocess) resolves
 * the pnpm shim on Windows; when absent, 'pnpm' is assumed on PATH.
 */
async function installProfileDeps(run, resolveExecutable, cwd, signal) {
  let bin = 'pnpm';
  if (typeof resolveExecutable === 'function') {
    try {
      bin = await resolveExecutable('pnpm');
    } catch {
      return {
        ok: false,
        error: 'pnpm 未找到。请先安装 pnpm（npm install -g pnpm），或在终端运行 dsh plugin --profile <name> install 手动安装依赖后再重新拉取。',
      };
    }
  }
  let lastError = '依赖安装失败';
  for (const args of [['install', '--frozen-lockfile'], ['install']]) {
    try {
      await run(pnpmCommand(bin, args), cwd, { signal });
      return { ok: true };
    } catch (err) {
      lastError = String(err?.message || err);
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Restore a profile's boot-critical files from the pre-apply backup
 * (modified files) or remove them (added files), so the loader never sees a
 * bundle list whose packages are not installed.
 */
async function rollbackProfile(dshHome, profile, backupDir) {
  const rolled = [];
  const rels = [
    `profiles/${profile}/package.json`,
    `profiles/${profile}/cordis.patch.yml`,
    `profiles/${profile}/pnpm-workspace.yaml`,
  ];
  for (const rel of rels) {
    const abs = absPath(dshHome, rel);
    const backup = backupDir ? absPath(backupDir, rel) : null;
    try {
      if (backup && await fs.access(backup).then(() => true, () => false)) {
        await fs.mkdir(dirname(abs), { recursive: true });
        await fs.copyFile(backup, abs);
        rolled.push(`${rel}（已回滚）`);
      } else {
        await fs.rm(abs, { force: true });
        rolled.push(`${rel}（已删除）`);
      }
    } catch (err) {
      rolled.push(`${rel}（回滚失败: ${String(err?.message || err)}）`);
    }
  }
  await ensureSyncPluginLoadable(dshHome, profile);
  return rolled;
}

/**
 * After a rollback, guarantee the sync plugin itself stays loadable: exactly
 * one load path must exist — the profile's bundle list if it already names
 * dsh-simple-sync, otherwise the cordis.patch.yml insert entry. Without this,
 * a rolled-back machine would silently lose the settings panel.
 */
async function ensureSyncPluginLoadable(dshHome, profile) {
  const pkgPath = join(dshHome, 'profiles', profile, 'package.json');
  const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  let inBundles = false;
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    inBundles = Boolean(pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) && pkg.dsh.profile.bundles.includes('dsh-simple-sync'));
  } catch {
    // unreadable package.json — fall through to the insert path
  }
  if (inBundles) return;
  let patch = '';
  try {
    patch = await fs.readFile(patchPath, 'utf8');
  } catch {
    // patch missing — will be created below
  }
  if (parseInsertNames(patch).includes('dsh-simple-sync') || /id:\s*simple-sync/.test(patch)) return;
  await fs.appendFile(
    patchPath,
    '\n# dsh-simple-sync: 多机配置同步（回滚后自动补回加载入口）\n- insert:\n    - id: simple-sync\n      name: dsh-simple-sync\n',
    'utf8',
  );
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
