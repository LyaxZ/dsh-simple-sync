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
export async function applySnapshot(snapshot, dshHome, { run, resolveExecutable, signal, installDeps = true, skipMissing = false, onProgress } = {}) {
  const progress = async (stage) => {
    if (typeof onProgress === 'function') await onProgress(stage);
  };
  // SAFETY: refuse to apply snapshots that would REMOVE plugins from a
  // profile (incoming bundles < local bundles). A downgrade usually means the
  // wrong/older machine pushed — auto-applying it strips the target machine's
  // plugins and pnpm then prunes them from node_modules (the 2026-08-25
  // incident). Refuse loudly instead.
  const downgrades = await detectDowngrades(snapshot, dshHome);
  if (downgrades.length) {
    return {
      written: [],
      writeErrors: [],
      backedUp: [],
      backupDir: null,
      depsInstalled: [],
      depsFailed: [],
      reverted: [],
      autoInstalled: [],
      restartHint: false,
      diff: await diffSnapshot(snapshot, dshHome),
      refused: downgrades,
    };
  }

  // PRE-APPLY VALIDATION: the incoming snapshot itself must be internally
  // consistent (bundles installable, no duplicate ids). A broken snapshot
  // must never be applied — refuse before writing anything.
  const invalid = [];
  for (const p of profilesInSnapshot(snapshot)) {
    const errs = validateIncomingProfile(snapshot, p);
    if (errs.length) invalid.push({ profile: p, errors: errs });
  }
  if (invalid.length) {
    return {
      written: [],
      writeErrors: [],
      backedUp: [],
      backupDir: null,
      depsInstalled: [],
      depsFailed: [],
      reverted: [],
      autoInstalled: [],
      restartHint: false,
      diff: await diffSnapshot(snapshot, dshHome),
      invalid,
    };
  }

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
    await progress('安装插件依赖（首次拉取可能需要几分钟）…');
    const changedProfiles = new Set();
    for (const f of written) {
      const m = f.path.match(/^profiles\/([^/]+)\/package\.json$/);
      if (m) changedProfiles.add(m[1]);
    }
    for (const p of changedProfiles) {
      if (signal?.aborted) throw new Error('操作已取消');
      // SAFETY: only run pnpm install when the incoming package.json adds NEW
      // dependencies. Running it on equal/subset changes makes pnpm prune
      // node_modules entries that are not in package.json — including local
      // junction plugins (quick-toc, simple-sync) — which is destructive.
      const incomingDeps = depsOf(snapshot, `profiles/${p}/package.json`);
      // read the PRE-apply local deps: added files didn't exist before ({}),
      // modified files come from the backup (the live file was overwritten)
      const wasAdded = diff.added.some((f) => f.path === `profiles/${p}/package.json`);
      const localDeps = wasAdded ? {} : await depsOfLocal(dshHome, `profiles/${p}/package.json`, backupDir);
      const newDeps = Object.keys(incomingDeps).filter((k) => !(k in localDeps));
      if (!newDeps.length) continue; // nothing new to install — skip entirely
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
    await progress('安装补丁引用的插件…');
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

    // POST-APPLY VERIFICATION: every bundle and insert must now resolve in
    // node_modules. If the applied state does not verify, roll the profile
    // back — a machine must never be left half-applied. Profiles already
    // rolled back above are in their pre-apply state — skip them.
    await progress('验证插件安装…');
    for (const p of profilesInSnapshot(snapshot)) {
      if (signal?.aborted) throw new Error('操作已取消');
      // recompute live: the orphan loop above may have rolled back this
      // profile — verify only profiles still in the applied state
      if (reverted.some((r) => r.profile === p)) continue;
      const verifyErrors = await validateLocalProfile(dshHome, p);
      if (verifyErrors.length) {
        const rolled = await rollbackProfile(dshHome, p, backupDir);
        reverted.push({ profile: p, files: rolled });
        depsFailed.push({ profile: p, error: `应用后验证失败，已回滚: ${verifyErrors.join('; ')}` });
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

/** Incoming `dependencies` of one profile package.json inside a snapshot. */
function depsOf(snapshot, relPath) {
  const f = (snapshot.files || []).find((x) => x.path === relPath);
  if (!f) return {};
  try {
    return JSON.parse(f.content).dependencies || {};
  } catch {
    return {};
  }
}

/** Local `dependencies` of one profile package.json (pre-apply when a backup exists). */
async function depsOfLocal(dshHome, relPath, backupDir) {
  const candidates = backupDir
    ? [absPath(backupDir, relPath), absPath(dshHome, relPath)]
    : [absPath(dshHome, relPath)];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(p, 'utf8'));
      return parsed.dependencies || {};
    } catch {
      // try next candidate
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// health validation — broken configs must never be pushed or applied
// ---------------------------------------------------------------------------

/** @deepseek-ai/* bundles are host-provided (resolve from the dsh install). */
function isBaseBundle(name) {
  return name.startsWith('@deepseek-ai/');
}

/**
 * Validate ONE profile inside an incoming snapshot WITHOUT touching the
 * machine: bundles must be installable (declared in deps, or host base),
 * and no plugin may appear in both bundles and patch inserts (duplicate id).
 */
export function validateIncomingProfile(snapshot, profile) {
  const errors = [];
  const pkg = (snapshot.files || []).find((x) => x.path === `profiles/${profile}/package.json`);
  if (!pkg) return errors;
  let parsed = null;
  try {
    parsed = JSON.parse(pkg.content);
  } catch {
    return [`profiles/${profile}/package.json 无法解析（快照已损坏）`];
  }
  const deps = parsed.dependencies || {};
  const bundles = (parsed.dsh && parsed.dsh.profile && parsed.dsh.profile.bundles) || [];
  const patch = (snapshot.files || []).find((x) => x.path === `profiles/${profile}/cordis.patch.yml`);
  const inserts = patch ? parseInsertNames(patch.content) : [];
  for (const b of bundles) {
    if (isBaseBundle(b)) continue;
    if (!(b in deps)) errors.push(`插件 ${b} 在 bundles 中但不在 dependencies（目标机无法安装）`);
    if (inserts.includes(b)) errors.push(`插件 ${b} 同时出现在 bundles 和 patch insert（会重复加载）`);
  }
  for (const n of inserts) {
    if (bundles.includes(n)) errors.push(`插件 ${n} 同时出现在 bundles 和 patch insert（会重复加载）`);
  }
  return errors;
}

/**
 * Validate the LOCAL machine's profile: every bundle (non-base) and every
 * patch insert must resolve in node_modules, and no duplicate ids. Used by
 * push (refuse uploading broken configs) and by post-apply verification
 * (roll back if the applied state does not resolve).
 */
export async function validateLocalProfile(dshHome, profile) {
  const errors = [];
  const pkgPath = absPath(dshHome, `profiles/${profile}/package.json`);
  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  } catch {
    return [`profiles/${profile}/package.json 无法解析或缺失`];
  }
  const bundles = (parsed.dsh && parsed.dsh.profile && parsed.dsh.profile.bundles) || [];
  const patchPath = absPath(dshHome, `profiles/${profile}/cordis.patch.yml`);
  let patch = '';
  try {
    patch = await fs.readFile(patchPath, 'utf8');
  } catch {
    // patch missing — no inserts to check
  }
  const inserts = parseInsertNames(patch);
  const nm = absPath(dshHome, `profiles/${profile}/node_modules`);
  for (const b of bundles) {
    if (isBaseBundle(b)) continue;
    const ok = await fs.access(join(nm, ...b.split('/'))).then(() => true, () => false);
    if (!ok) errors.push(`插件 ${b} 未安装（node_modules 中不存在）`);
    if (inserts.includes(b)) errors.push(`插件 ${b} 同时出现在 bundles 和 patch insert（会重复加载）`);
  }
  for (const n of inserts) {
    const ok = await fs.access(join(nm, ...n.split('/'))).then(() => true, () => false);
    if (!ok) errors.push(`补丁引用的插件 ${n} 未安装（node_modules 中不存在）`);
  }
  return errors;
}

/** Profile names present in a snapshot. */
export function profilesInSnapshot(snapshot) {
  const names = new Set();
  for (const f of snapshot.files || []) {
    const m = f.path.match(/^profiles\/([^/]+)\/package\.json$/);
    if (m) names.add(m[1]);
  }
  return [...names];
}

/**
 * SAFETY: find profiles where the incoming snapshot's bundle list is a strict
 * subset of the local machine's current bundle list. Applying such a snapshot
 * strips plugins (and a subsequent pnpm install prunes them from
 * node_modules). Returns [{profile, missing, localCount, incomingCount}].
 *
 * A local bundle is NOT considered "removed" when the incoming snapshot still
 * covers it — via its bundle list, a patch insert (insert-based loading, the
 * model this plugin uses), or its dependencies.
 */
async function detectDowngrades(snapshot, dshHome) {
  const downgrades = [];
  for (const f of snapshot.files || []) {
    const m = f.path.match(/^profiles\/([^/]+)\/package\.json$/);
    if (!m) continue;
    const profile = m[1];
    let incoming = null;
    try {
      incoming = JSON.parse(f.content);
    } catch {
      continue;
    }
    const incomingBundles = (incoming.dsh && incoming.dsh.profile && incoming.dsh.profile.bundles) || [];
    const incomingDeps = Object.keys(incoming.dependencies || {});
    const patch = (snapshot.files || []).find((x) => x.path === `profiles/${profile}/cordis.patch.yml`);
    const incomingInserts = patch ? parseInsertNames(patch.content) : [];
    const covered = new Set([...incomingBundles, ...incomingInserts, ...incomingDeps]);
    let localBundles = [];
    try {
      const local = JSON.parse(await fs.readFile(absPath(dshHome, f.path), 'utf8'));
      localBundles = local.dsh?.profile?.bundles || [];
    } catch {
      continue; // no local profile file yet — fresh machine, nothing to lose
    }
    if (!localBundles.length) continue;
    const missing = localBundles.filter((b) => !covered.has(b));
    if (missing.length > 0) {
      downgrades.push({ profile, missing, localCount: localBundles.length, incomingCount: incomingBundles.length });
    }
  }
  return downgrades;
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
 * Windows: pnpm/npm resolve to .cmd batch shims which Node cannot spawn
 * directly (EINVAL). Route through cmd.exe /d /s /c so the .cmd runs.
 * POSIX: plain argv.
 *
 * cmd /s /c strips the first+last quote of the string; when the command
 * starts with a QUOTED path (contains spaces, e.g. "C:\Program Files\..."
 * or any path under a spaced directory), the leading quote must be doubled
 * so the inner command survives the strip.
 */
export function pnpmCommand(bin, args) {
  if (process.platform !== 'win32') return [bin, ...args];
  const hasSpace = /[\s"]/.test(bin);
  const quoted = hasSpace ? `"${bin}"` : bin;
  const argstr = args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');
  const cmdStr = `${quoted} ${argstr}`;
  const wrapped = hasSpace ? `"${cmdStr}"` : cmdStr;
  return ['cmd.exe', '/d', '/s', '/c', wrapped];
}

/** Hard cap for npm install subprocesses (hang → rollback, not forever). */
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
/** pnpm gets a SHORT window — on CN networks it often hangs instead of
 *  erroring, which would block the npm fallback. Kill it and switch to npm. */
const PNPM_TRY_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * Resolve a package-manager executable via resolveExecutable; falls back to
 * the bare name. Returns { bin, missing }.
 */
async function resolvePkgManager(name, resolveExecutable) {
  if (typeof resolveExecutable === 'function') {
    try {
      return { bin: await resolveExecutable(name) };
    } catch {
      return { missing: true };
    }
  }
  return { bin: name };
}

/** pnpm add <name> — falls back to npm install <name> (npm survives CN networks). */
async function addProfilePlugin(run, resolveExecutable, cwd, name, signal) {
  const pnpm = await resolvePkgManager('pnpm', resolveExecutable);
  if (!pnpm.missing) {
    try {
      await run(pnpmCommand(pnpm.bin, ['add', name]), cwd, { signal, timeoutMs: PNPM_TRY_TIMEOUT_MS });
      return { ok: true };
    } catch {
      // fall through to npm
    }
  }
  const npm = await resolvePkgManager('npm', resolveExecutable);
  if (npm.missing) return { ok: false, error: 'pnpm 和 npm 都不可用（请先安装其中之一）' };
  try {
    await run(pnpmCommand(npm.bin, ['install', name, '--no-audit', '--no-fund']), cwd, { signal, timeoutMs: INSTALL_TIMEOUT_MS });
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
  // pnpm first (frozen → plain), then npm as a fallback — npm's HTTP stack
  // survives CN networks where pnpm's fetch gets connection-reset errors.
  const pnpm = await resolvePkgManager('pnpm', resolveExecutable);
  let lastError = '依赖安装失败';
  if (!pnpm.missing) {
    for (const args of [['install', '--frozen-lockfile'], ['install']]) {
      try {
        await run(pnpmCommand(pnpm.bin, args), cwd, { signal, timeoutMs: PNPM_TRY_TIMEOUT_MS });
        return { ok: true };
      } catch (err) {
        lastError = String(err?.message || err);
      }
    }
  } else {
    lastError = 'pnpm 未找到';
  }
  // npm fallback
  const npm = await resolvePkgManager('npm', resolveExecutable);
  if (!npm.missing) {
    try {
      await run(pnpmCommand(npm.bin, ['install', '--no-audit', '--no-fund', '--legacy-peer-deps']), cwd, { signal, timeoutMs: INSTALL_TIMEOUT_MS });
      return { ok: true, via: 'npm' };
    } catch (err) {
      lastError = `pnpm 失败（${lastError}）；npm 回退也失败: ${String(err?.message || err)}`;
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
