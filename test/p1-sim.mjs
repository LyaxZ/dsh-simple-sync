/**
 * P1 simulation: two-machine flow against fake dsh homes.
 * Run: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSnapshot, diffSnapshot, applySnapshot, loadState, saveState,
  listSyncUnits, parseInsertNames, pnpmCommand, validateLocalProfile,
} from '../lib/ops.js';

const WEB_PKG = JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { 'dsh-memory': '^0.1.0', 'dsh-scholar': '^0.1.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-memory', 'dsh-scholar'] } },
}, null, 2);

const WEB_PKG_V2 = JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { 'dsh-memory': '^0.1.0', 'dsh-scholar': '^0.1.0', 'dsh-new-plugin': '^1.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-memory', 'dsh-scholar', 'dsh-new-plugin'] } },
}, null, 2);

async function makeHomeA(root) {
  const home = join(root, 'homeA');
  await mkdir(join(home, 'profiles', 'web'), { recursive: true });
  await mkdir(join(home, '.agent-presets', 'router-standard'), { recursive: true });
  await mkdir(join(home, 'sessions'), { recursive: true });
  await writeFile(join(home, 'settings.yaml'), 'locale:\n  preference: zh\n');
  await writeFile(join(home, '.credentials.yaml'), 'deepseek: SECRET\n');
  await writeFile(join(home, 'profiles', 'web', 'package.json'), WEB_PKG);
  await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), '- id: scholar\n  config: { proxy: "" }\n');
  await writeFile(join(home, 'profiles', 'web', 'pnpm-workspace.yaml'), 'allowBuilds: {}\n');
  await writeFile(join(home, '.agent-presets', 'router-standard', 'agent.cordis.yml'), 'agent: router\n');
  await writeFile(join(home, 'sessions', 'noise.jsonl'), '{"should":"not sync"}\n');
  return home;
}

async function materializeDeps(profileDir) {
  try {
    const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const name of Object.keys(deps)) {
      await mkdir(join(profileDir, 'node_modules', ...name.split('/')), { recursive: true });
    }
  } catch {
    // no package.json — nothing to materialize
  }
}

function fakeRunner() {
  const calls = [];
  return {
    calls,
    async run(argv, cwd, opts) {
      calls.push({ argv, cwd });
      if (argv.join(' ').includes('pnpm') && argv.join(' ').includes('--frozen-lockfile')) {
        throw new Error('lockfile drift (simulated)');
      }
      // simulate a successful install: create node_modules for declared deps
      await materializeDeps(cwd);
      return { out: '', err: '' };
    },
  };
}

test('snapshot excludes non-whitelisted data and credentials by default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeA = await makeHomeA(root);

  const snap = await buildSnapshot(homeA);
  const paths = snap.files.map((f) => f.path);
  assert.ok(paths.includes('settings.yaml'));
  assert.ok(paths.includes('profiles/web/package.json'));
  assert.ok(paths.includes('profiles/web/cordis.patch.yml'));
  assert.ok(paths.includes('profiles/web/pnpm-workspace.yaml'));
  assert.ok(paths.includes('.agent-presets/router-standard/agent.cordis.yml'));
  assert.ok(!paths.includes('sessions/noise.jsonl'), 'sessions must be excluded');
  assert.ok(!paths.includes('.credentials.yaml'), 'credentials excluded by default');
  assert.ok(snap.meta.machine && snap.meta.time && snap.meta.unitVersion === 1);
  assert.ok(snap.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));

  const snapCred = await buildSnapshot(homeA, { includeCredentials: true });
  assert.ok(snapCred.files.some((f) => f.path === '.credentials.yaml'));
});

test('one-click move: apply snapshot to an empty home', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeA = await makeHomeA(root);
  const homeB = join(root, 'homeB');
  await mkdir(homeB, { recursive: true });

  const runner = fakeRunner();
  const snap = await buildSnapshot(homeA);
  const report = await applySnapshot(snap, homeB, { run: runner.run });

  assert.equal(report.written.length, snap.files.length);
  assert.ok(report.written.every((w) => w.action === 'added'));
  assert.equal(report.writeErrors.length, 0);
  assert.deepEqual(report.backedUp, [], 'empty home: nothing to back up');
  assert.equal(report.restartHint, true);

  // pnpm install attempted (frozen fails → plain fallback)
  const pnpmCalls = runner.calls.filter((c) => c.argv.join(' ').includes('pnpm'));
  assert.ok(pnpmCalls.length >= 2, 'expected frozen + plain install attempts');
  assert.ok(pnpmCalls.some((c) => c.cwd.endsWith(join('profiles', 'web'))));
  assert.deepEqual(report.depsInstalled, ['web']);
  assert.deepEqual(report.depsFailed, []);

  // files actually match
  const written = await readFile(join(homeB, 'settings.yaml'), 'utf8');
  assert.ok(written.includes('preference: zh'));
  const pkg = JSON.parse(await readFile(join(homeB, 'profiles', 'web', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies['dsh-scholar'], '^0.1.0');
});

test('incremental sync: A changed → B applies with backup + dep install', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeA = await makeHomeA(root);
  const homeB = join(root, 'homeB');
  await mkdir(homeB, { recursive: true });

  // initial move A → B
  const runner = fakeRunner();
  await applySnapshot(await buildSnapshot(homeA), homeB, { run: runner.run });

  // A changes: settings, new plugin, new preset file
  await writeFile(join(homeA, 'settings.yaml'), 'locale:\n  preference: en\nagent-default-model:\n  provider: x\n');
  await writeFile(join(homeA, 'profiles', 'web', 'package.json'), WEB_PKG_V2);
  await writeFile(join(homeA, '.agent-presets', 'router-standard', 'preset.yml'), 'name: router-standard\n');

  const snap2 = await buildSnapshot(homeA);
  const diff = await diffSnapshot(snap2, homeB);
  assert.deepEqual(diff.added.map((f) => f.path), ['.agent-presets/router-standard/preset.yml']);
  assert.deepEqual(
    diff.modified.map((f) => f.path).sort(),
    ['profiles/web/package.json', 'settings.yaml'],
  );

  const runner2 = fakeRunner();
  const report = await applySnapshot(snap2, homeB, { run: runner2.run });
  assert.equal(report.written.length, 3);
  assert.equal(report.backedUp.length, 2, 'old settings.yaml + package.json backed up');
  assert.ok(report.backupDir && report.backupDir.includes('backups'));
  assert.deepEqual(report.depsInstalled, ['web'], 'new plugin triggers pnpm install');
  assert.equal(report.restartHint, true);

  // backup contents are the OLD versions
  const backupRoot = report.backupDir;
  const oldSettings = await readFile(join(backupRoot, 'settings.yaml'), 'utf8');
  assert.ok(oldSettings.includes('preference: zh'), 'backup keeps pre-sync settings');
  const oldPkg = JSON.parse(await readFile(join(backupRoot, 'profiles', 'web', 'package.json'), 'utf8'));
  assert.ok(!oldPkg.dependencies['dsh-new-plugin'], 'backup keeps pre-sync package.json');

  // idempotency: applying the same snapshot again writes nothing
  const runner3 = fakeRunner();
  const report3 = await applySnapshot(snap2, homeB, { run: runner3.run });
  assert.equal(report3.written.length, 0);
  assert.equal(report3.restartHint, false);
});

test('state persists under <home>/.dsh-sync', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  await saveState(home, { lastPush: '2026-01-01T00:00:00Z', includeCredentials: false });
  const state = await loadState(home);
  assert.equal(state.lastPush, '2026-01-01T00:00:00Z');
  assert.equal(state.includeCredentials, false);
  const missing = await loadState(join(root, 'nope'));
  assert.deepEqual(missing, {});
});

test('sync units enumerated from profiles dir, not hardcoded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, 'profiles', 'cli'), { recursive: true });
  await mkdir(join(home, 'profiles', 'web'), { recursive: true });
  await writeFile(join(home, 'profiles', 'cli', 'package.json'), '{}');
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}');
  const units = await listSyncUnits(home);
  const paths = units.map((u) => u.path);
  assert.ok(paths.includes('profiles/cli/package.json'));
  assert.ok(paths.includes('profiles/web/package.json'));
});

test('install failure rolls back profile config so DSH stays bootable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeA = await makeHomeA(root);
  const homeB = join(root, 'homeB');
  await mkdir(homeB, { recursive: true });

  // B already runs a working profile with OLD bundles (a SUBSET of A's — so
  // the downgrade guard does not trip; the rollback logic is what we test)
  const oldPkg = JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: { 'dsh-default': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2);
  await mkdir(join(homeB, 'profiles', 'web'), { recursive: true });
  await writeFile(join(homeB, 'profiles', 'web', 'package.json'), oldPkg);
  await writeFile(join(homeB, 'profiles', 'web', 'cordis.patch.yml'), '- id: old\n');

  // pnpm missing entirely
  const failRunner = async () => { throw new Error('should not be called'); };
  const snap = await buildSnapshot(homeA);
  const report = await applySnapshot(snap, homeB, {
    run: failRunner,
    resolveExecutable: async () => { throw new Error('pnpm not found'); },
  });

  assert.equal(report.depsFailed.length, 1);
  assert.equal(report.depsFailed[0].profile, 'web');
  assert.match(report.depsFailed[0].error, /pnpm 未找到/);
  assert.ok(report.reverted.length === 1);
  assert.ok(report.reverted[0].files.some((x) => x.includes('package.json')));

  // package.json restored to the OLD bundle list (no dsh-scholar)
  const pkgAfter = JSON.parse(await readFile(join(homeB, 'profiles', 'web', 'package.json'), 'utf8'));
  assert.ok(pkgAfter.dependencies['dsh-default'], 'old bundle kept');
  assert.ok(!pkgAfter.dependencies['dsh-scholar'], 'new bundle rolled back');
  const patchAfter = await readFile(join(homeB, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  assert.ok(patchAfter.includes('old'), 'patch rolled back');
});

test('pnpm errors surface the real reason', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, 'profiles', 'web'), { recursive: true });
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');

  const failRunner = async () => { throw new Error('pnpm: ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/xxx'); };
  const snap = { meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 }, files: [
    { path: 'profiles/web/package.json', sha256: 'a'.repeat(64), content: '{"name":"p","private":true,"dependencies":{"dsh-x":"^1.0.0"}}\n' },
  ] };
  const report = await applySnapshot(snap, home, { run: failRunner, resolveExecutable: async () => 'pnpm' });
  assert.equal(report.depsFailed.length, 1);
  assert.match(report.depsFailed[0].error, /ERR_PNPM_FETCH_404/, 'real pnpm error text surfaced');
});

test('insert-referenced plugins auto-install on a fresh machine', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeB = join(root, 'homeB');
  await mkdir(join(homeB, 'profiles', 'web'), { recursive: true });
  await writeFile(join(homeB, 'profiles', 'web', 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');

  const calls = [];
  const runner = async (argv, cwd, opts) => {
    calls.push(argv.join(' '));
    const joined = argv.join(' ');
    if (joined.includes('pnpm add')) {
      // simulate pnpm add: create the package in node_modules
      const m = joined.match(/pnpm add\s+([\w@./-]+)/);
      if (m) await mkdir(join(cwd, 'node_modules', ...m[1].split('/')), { recursive: true });
      return { out: '', err: '' };
    }
    if (argv.includes('--frozen-lockfile')) throw new Error('no lockfile (simulated)');
    await materializeDeps(cwd);
    return { out: '', err: '' };
  };
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'b'.repeat(64), content: '{"name":"p","private":true,"dependencies":{"dsh-memory":"^0.1.0"}}\n' },
      { path: 'profiles/web/cordis.patch.yml', sha256: 'c'.repeat(64), content: '# patch\n- insert:\n    - id: quick-toc\n      name: dsh-quick-toc\n- insert:\n    - id: simple-sync\n      name: dsh-simple-sync\n' },
    ],
  };
  const report = await applySnapshot(snap, homeB, { run: runner, resolveExecutable: async () => 'pnpm' });

  assert.ok(report.autoInstalled.some((x) => x.includes('dsh-quick-toc')), 'quick-toc auto-installed');
  assert.ok(report.autoInstalled.some((x) => x.includes('dsh-simple-sync')), 'simple-sync auto-installed');
  const adds = calls.filter((c) => c.includes('pnpm add'));
  assert.ok(adds.some((c) => c.includes('dsh-quick-toc')));
  assert.ok(adds.some((c) => c.includes('dsh-simple-sync')));
  assert.equal(report.depsFailed.length, 0, 'no failures');
});

test('already-installed insert plugins are left alone', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeB = join(root, 'homeB');
  await mkdir(join(homeB, 'profiles', 'web', 'node_modules', 'dsh-quick-toc'), { recursive: true });
  await writeFile(join(homeB, 'profiles', 'web', 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');

  const calls = [];
  const runner = async (argv, cwd, opts) => {
    calls.push(argv.join(' '));
    if (argv.join(' ').includes('pnpm add')) return { out: '', err: '' };
    if (argv.includes('--frozen-lockfile')) throw new Error('no lockfile');
    await materializeDeps(cwd);
    return { out: '', err: '' };
  };
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'd'.repeat(64), content: '{"name":"p","private":true,"dependencies":{}}\n' },
      { path: 'profiles/web/cordis.patch.yml', sha256: 'e'.repeat(64), content: '- insert:\n    - id: quick-toc\n      name: dsh-quick-toc\n' },
    ],
  };
  const report = await applySnapshot(snap, homeB, { run: runner, resolveExecutable: async () => 'pnpm' });
  assert.equal(report.autoInstalled.length, 0, 'nothing auto-installed');
  assert.ok(!calls.some((c) => c.includes('pnpm add')), 'no pnpm add ran');
});

test('parseInsertNames handles block and repeated inserts', () => {
  const yaml = [
    '# scholar config',
    '- id: scholar',
    '  config: { proxy: "" }',
    '- insert:',
    '    - id: quick-toc',
    '      name: dsh-quick-toc',
    '- insert:',
    '    - id: simple-sync',
    '      name: dsh-simple-sync',
  ].join('\n');
  const names = parseInsertNames(yaml);
  assert.deepEqual(names.sort(), ['dsh-quick-toc', 'dsh-simple-sync']);
});

test('pnpmCommand wraps .cmd shims through cmd.exe on Windows', () => {
  const argv = pnpmCommand('C:\\Users\\x\\AppData\\Roaming\\npm\\pnpm.cmd', ['install', '--frozen-lockfile']);
  if (process.platform === 'win32') {
    assert.equal(argv[0], 'cmd.exe');
    assert.equal(argv[1], '/d');
    assert.equal(argv[2], '/s');
    assert.equal(argv[3], '/c');
    assert.match(argv[4], /pnpm\.cmd.*install.*--frozen-lockfile/);
    // path with spaces gets quoted
    const spaced = pnpmCommand('C:\\my tools\\pnpm.cmd', ['install']);
    assert.match(spaced[4], /^"C:\\my tools\\pnpm\.cmd" install$/);
  } else {
    assert.equal(argv[0], 'C:\\Users\\x\\AppData\\Roaming\\npm\\pnpm.cmd');
  }
});

test('rollback guarantees the sync plugin stays loadable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  // pre-pull state: plain package.json WITHOUT simple-sync, patch WITHOUT insert
  await writeFile(join(profileDir, 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');
  await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: scholar\n  config: {}\n');

  const failRunner = async () => { throw new Error('boom'); };
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'f'.repeat(64), content: '{"name":"p","private":true,"dependencies":{"dsh-memory":"^0.1.0"}}\n' },
      { path: 'profiles/web/cordis.patch.yml', sha256: 'g'.repeat(64), content: '- insert:\n    - id: simple-sync\n      name: dsh-simple-sync\n' },
    ],
  };
  const report = await applySnapshot(snap, home, {
    run: failRunner,
    resolveExecutable: async () => 'pnpm',
  });
  assert.equal(report.depsFailed.length, 1);
  // the rollback restored the OLD patch — but the sync insert must be re-added
  const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('simple-sync'), 'sync plugin insert re-added after rollback');
  const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies['dsh-memory'], 'bundle list rolled back');
});

test('downgrade guard: refuses snapshots that remove local plugins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, 'profiles', 'web'), { recursive: true });
  // local machine HAS many plugins
  const localPkg = JSON.stringify({
    name: 'p', private: true,
    dependencies: { 'dsh-memory': '^0.1.0', 'dsh-scholar': '^0.1.0', 'dsh-skin': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-memory', 'dsh-scholar', 'dsh-skin'] } },
  }, null, 2);
  await writeFile(join(home, 'profiles', 'web', 'package.json'), localPkg);

  // incoming snapshot has FEWER bundles (bad laptop state)
  const snap = {
    meta: { machine: 'LAPTOP-BAD', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'h'.repeat(64), content: '{"name":"p","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}\n' },
    ],
  };
  const runner = async () => { throw new Error('should not install'); };
  const report = await applySnapshot(snap, home, { run: runner, resolveExecutable: async () => 'pnpm' });
  assert.ok(report.refused && report.refused.length === 1, 'refused downgrade');
  assert.equal(report.written.length, 0, 'nothing written');
  assert.ok(report.refused[0].missing.includes('dsh-memory'));
  // local file untouched
  const after = await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8');
  assert.equal(after, localPkg, 'local package.json untouched');
});

test('downgrade guard allows plugins covered by incoming patch inserts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  // laptop: `dsh plugin add` put simple-sync in local bundles
  await writeFile(join(profileDir, 'package.json'), '{"name":"p","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-simple-sync"]}}}\n');
  // incoming: simple-sync NOT in bundles, but the incoming PATCH inserts it
  const runner = async (argv, cwd) => {
    const joined = argv.join(' ');
    if (joined.includes('pnpm add')) return { out: '', err: '' };
    if (joined.includes('--frozen-lockfile')) throw new Error('no lockfile');
    await materializeDeps(cwd);
    return { out: '', err: '' };
  };
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'q'.repeat(64), content: '{"name":"p","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n' },
      { path: 'profiles/web/cordis.patch.yml', sha256: 'r'.repeat(64), content: '- insert:\n    - id: simple-sync\n      name: dsh-simple-sync\n' },
    ],
  };
  const report = await applySnapshot(snap, home, { run: runner, resolveExecutable: async (n) => n });
  assert.ok(!report.refused, 'not refused — insert covers the plugin');
  assert.ok(report.written.length > 0, 'apply proceeded past the guard');
});

test('install skipped when no NEW dependencies are added', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, 'profiles', 'web', 'node_modules', 'dsh-memory'), { recursive: true });
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"name":"p","private":true,"dependencies":{"dsh-memory":"^0.1.0"}}\n');

  let installRan = false;
  const runner = async (argv) => {
    if (argv.join(' ').includes('pnpm install')) installRan = true;
    return { out: '', err: '' };
  };
  // same deps, different version spec — no NEW packages → no install → no prune
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'i'.repeat(64), content: '{"name":"p","private":true,"dependencies":{"dsh-memory":"^0.2.0"}}\n' },
    ],
  };
  const report = await applySnapshot(snap, home, { run: runner, resolveExecutable: async () => 'pnpm' });
  assert.equal(installRan, false, 'no pnpm install for equal deps');
  assert.equal(report.depsInstalled.length, 0);
});

test('apply refuses a snapshot whose bundle is missing from dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, 'profiles', 'web'), { recursive: true });
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');

  const runner = async () => { throw new Error('should not install'); };
  // bundle dsh-magic is NOT in dependencies → cannot be installed on target
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'j'.repeat(64), content: '{"name":"p","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["dsh-magic"]}}}\n' },
    ],
  };
  const report = await applySnapshot(snap, home, { run: runner, resolveExecutable: async () => 'pnpm' });
  assert.ok(report.invalid && report.invalid.length === 1, 'invalid snapshot refused');
  assert.ok(report.invalid[0].errors.some((e) => e.includes('dsh-magic')));
  assert.equal(report.written.length, 0, 'nothing written');
});

test('apply refuses duplicate bundle+insert ids', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, 'profiles', 'web'), { recursive: true });
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');

  const runner = async () => { throw new Error('should not install'); };
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'k'.repeat(64), content: '{"name":"p","private":true,"dependencies":{"dsh-x":"^1.0.0"},"dsh":{"profile":{"bundles":["dsh-x"]}}}\n' },
      { path: 'profiles/web/cordis.patch.yml', sha256: 'l'.repeat(64), content: '- insert:\n    - id: x\n      name: dsh-x\n' },
    ],
  };
  const report = await applySnapshot(snap, home, { run: runner, resolveExecutable: async () => 'pnpm' });
  assert.ok(report.invalid && report.invalid.length === 1, 'duplicate refused');
  assert.ok(report.invalid[0].errors.some((e) => e.includes('同时')));
});

test('push-side validation flags missing local plugins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const nm = join(home, 'profiles', 'web', 'node_modules');
  await mkdir(nm, { recursive: true });
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"name":"p","private":true,"dependencies":{"dsh-memory":"^0.1.0"},"dsh":{"profile":{"bundles":["dsh-memory","dsh-ghost"]}}}\n');
  // dsh-memory present, dsh-ghost MISSING from node_modules
  await mkdir(join(nm, 'dsh-memory'), { recursive: true });
  const errors = await validateLocalProfile(home, 'web');
  assert.ok(errors.some((e) => e.includes('dsh-ghost')), 'missing plugin flagged');
  assert.ok(!errors.some((e) => e.includes('dsh-memory')), 'present plugin not flagged');
});

test('post-apply verification rolls back when install did not materialize', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');

  // fake runner claims success but does NOT create node_modules entries
  const runner = async () => ({ out: '', err: '' });
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'm'.repeat(64), content: '{"name":"p","private":true,"dependencies":{"dsh-memory":"^0.1.0"},"dsh":{"profile":{"bundles":["dsh-memory"]}}}\n' },
    ],
  };
  const report = await applySnapshot(snap, home, { run: runner, resolveExecutable: async () => 'pnpm' });
  // install "succeeded" but dsh-memory is not in node_modules → verification fails → rollback
  assert.ok(report.depsFailed.some((d) => /应用后验证失败/.test(d.error)), 'verification failure reported');
  assert.ok(report.reverted.length >= 1, 'rolled back');
  const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies['dsh-memory'], 'package.json rolled back');
});

test('install falls back to npm when pnpm fails (CN network)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');

  const calls = [];
  const runner = async (argv, cwd) => {
    calls.push(argv.join(' '));
    const joined = argv.join(' ');
    if (joined.includes('pnpm')) throw new Error('pnpm: UND_ERR_DESTROYED (simulated)');
    if (joined.includes('npm')) {
      await materializeDeps(cwd);
      return { out: '', err: '' };
    }
    return { out: '', err: '' };
  };
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'n'.repeat(64), content: '{"name":"p","private":true,"dependencies":{"dsh-memory":"^0.1.0"},"dsh":{"profile":{"bundles":["dsh-memory"]}}}\n' },
    ],
  };
  const report = await applySnapshot(snap, home, { run: runner, resolveExecutable: async (n) => n });
  assert.ok(calls.some((c) => c.includes('pnpm')), 'pnpm attempted first');
  assert.ok(calls.some((c) => c.includes('npm')), 'npm fallback used');
  assert.equal(report.depsInstalled.length, 1, 'install succeeded via npm');
  assert.equal(report.depsFailed.length, 0, 'no failures');
  assert.equal(report.reverted.length, 0, 'no rollback');
});

test('orphan plugin install falls back to npm too', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');

  const calls = [];
  const runner = async (argv, cwd) => {
    calls.push(argv.join(' '));
    const joined = argv.join(' ');
    if (joined.includes('pnpm')) throw new Error('pnpm: UND_ERR_DESTROYED');
    if (joined.includes('npm install ')) {
      const m = joined.match(/npm install\s+([\w@./-]+)/);
      if (m) await mkdir(join(cwd, 'node_modules', ...m[1].split('/')), { recursive: true });
      return { out: '', err: '' };
    }
    await materializeDeps(cwd);
    return { out: '', err: '' };
  };
  const snap = {
    meta: { machine: 'A', time: new Date().toISOString(), unitVersion: 1 },
    files: [
      { path: 'profiles/web/package.json', sha256: 'o'.repeat(64), content: '{"name":"p","private":true,"dependencies":{}}\n' },
      { path: 'profiles/web/cordis.patch.yml', sha256: 'p'.repeat(64), content: '- insert:\n    - id: quick-toc\n      name: dsh-quick-toc\n' },
    ],
  };
  const report = await applySnapshot(snap, home, { run: runner, resolveExecutable: async (n) => n });
  assert.ok(calls.some((c) => c.includes('npm install dsh-quick-toc')), 'npm fallback for orphan');
  assert.ok(report.autoInstalled.some((x) => x.includes('dsh-quick-toc')), 'orphan auto-installed');
  assert.equal(report.depsFailed.length, 0);
});
