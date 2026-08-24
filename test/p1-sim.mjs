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
  listSyncUnits,
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

function fakeRunner() {
  const calls = [];
  return {
    calls,
    async run(argv, cwd, opts) {
      calls.push({ argv, cwd });
      if (argv[0] === 'pnpm' && argv.includes('--frozen-lockfile')) {
        throw new Error('lockfile drift (simulated)');
      }
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
  const pnpmCalls = runner.calls.filter((c) => c.argv[0] === 'pnpm');
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

  // B already runs a working profile with OLD bundles
  const oldPkg = JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: { 'dsh-default': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-default'] } },
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
