/**
 * P2 transport tests: local folder backend + git backend against a real
 * bare repository (no network). Run: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createTransport, BACKENDS } from '../lib/transport/index.js';
import { buildSnapshot, applySnapshot } from '../lib/ops.js';

function makeRunner() {
  return async (argv, cwd, opts) => new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`exit ${code}: ${(err || out).trim().slice(0, 500)}`));
    });
  });
}

const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

function sampleSnapshot(machine, n = 2) {
  const files = [];
  for (let i = 0; i < n; i += 1) {
    files.push({ path: `settings-${i}.yaml`, sha256: `${i}`.padStart(64, '0'), content: `machine: ${machine}\n` });
  }
  return { meta: { machine, time: new Date().toISOString(), unitVersion: 1 }, files };
}

test('backend registry exposes git and local with panel fields', () => {
  const meta = BACKENDS;
  assert.deepEqual(Object.keys(meta).sort(), ['git', 'local']);
  assert.ok(meta.git.fields.some((f) => f.key === 'repo'));
  assert.ok(meta.local.fields.some((f) => f.key === 'dir'));
});

test('local backend: init creates dir, push/pull roundtrip', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const syncRoot = join(root, 'sync');
  const target = join(root, 'folder');
  const runner = makeRunner();
  const state = { backend: 'local', local: { dir: target } };

  const tr = createTransport(state, { syncRoot, run: runner });
  const init = await tr.init();
  assert.equal(init.ok, true, init.message);

  const snap = sampleSnapshot('A');
  const push = await tr.push(snap);
  assert.equal(push.ok, true, push.message);

  const tr2 = createTransport(state, { syncRoot, run: runner });
  const pull = await tr2.pull();
  assert.equal(pull.ok, true, pull.message);
  assert.deepEqual(pull.snapshot, snap);
});

test('git backend: A push → B pull against a real bare repo', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = makeRunner();

  // bare remote
  const remote = join(root, 'remote.git');
  await runner([GIT, 'init', '--bare', remote], root);

  const stateA = { backend: 'git', git: { repo: remote, branch: 'main' } };
  const stateB = { backend: 'git', git: { repo: remote, branch: 'main' } };

  // machine A: init + push snapshot1
  const trA = createTransport(stateA, { syncRoot: join(root, 'a-sync'), run: runner });
  const initA = await trA.init();
  assert.equal(initA.ok, true, initA.message);
  const snap1 = sampleSnapshot('A');
  const pushA = await trA.push(snap1);
  assert.equal(pushA.ok, true, pushA.message);

  // machine B: fresh worktree, pull snapshot1
  const trB = createTransport(stateB, { syncRoot: join(root, 'b-sync'), run: runner });
  const initB = await trB.init();
  assert.equal(initB.ok, true, initB.message);
  const pull1 = await trB.pull();
  assert.equal(pull1.ok, true, pull1.message);
  assert.deepEqual(pull1.snapshot, snap1, 'B sees exactly what A pushed');

  // A pushes newer snapshot → B pulls the update
  const snap2 = sampleSnapshot('A2', 3);
  const pushA2 = await trA.push(snap2);
  assert.equal(pushA2.ok, true, pushA2.message);
  const pull2 = await trB.pull();
  assert.equal(pull2.ok, true, pull2.message);
  assert.equal(pull2.snapshot.meta.machine, 'A2');
  assert.equal(pull2.snapshot.files.length, 3);

  // B can push back, A can pull it (two-way)
  const snapB = sampleSnapshot('B', 1);
  const pushB = await trB.push(snapB);
  assert.equal(pushB.ok, true, pushB.message);
  const pullA = await trA.pull();
  assert.equal(pullA.ok, true, pullA.message);
  assert.deepEqual(pullA.snapshot, snapB);
});

test('git backend: no-op push when nothing changed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = makeRunner();
  const remote = join(root, 'remote.git');
  await runner([GIT, 'init', '--bare', remote], root);

  const state = { backend: 'git', git: { repo: remote, branch: 'main' } };
  const tr = createTransport(state, { syncRoot: join(root, 'sync'), run: runner });
  await tr.init();
  const snap = sampleSnapshot('A');
  const first = await tr.push(snap);
  assert.equal(first.ok, true, first.message);
  const second = await tr.push(snap); // identical snapshot
  assert.equal(second.ok, true, second.message);
  assert.match(second.message, /最新/);
});

test('end-to-end: buildSnapshot → git push → pull → apply on new machine', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dss-p2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = makeRunner();
  const remote = join(root, 'remote.git');
  await runner([GIT, 'init', '--bare', remote], root);

  // machine A real-ish home
  const homeA = join(root, 'homeA');
  await mkdir(join(homeA, 'profiles', 'web'), { recursive: true });
  await mkdir(join(homeA, '.agent-presets', 'std'), { recursive: true });
  await writeFile(join(homeA, 'settings.yaml'), 'locale:\n  preference: zh\n');
  await writeFile(join(homeA, 'profiles', 'web', 'package.json'), '{"name":"p","private":true,"dependencies":{}}\n');
  await writeFile(join(homeA, '.agent-presets', 'std', 'agent.cordis.yml'), 'agent: std\n');

  const snapshot = await buildSnapshot(homeA);
  const state = { backend: 'git', git: { repo: remote, branch: 'main' } };

  const trA = createTransport(state, { syncRoot: join(root, 'a-sync'), run: runner });
  await trA.init();
  assert.equal((await trA.push(snapshot)).ok, true);

  // machine B: pull + apply
  const homeB = join(root, 'homeB');
  await mkdir(homeB, { recursive: true });
  const trB = createTransport(state, { syncRoot: join(root, 'b-sync'), run: runner });
  await trB.init();
  const pulled = await trB.pull();
  assert.equal(pulled.ok, true, pulled.message);
  const report = await applySnapshot(pulled.snapshot, homeB, { installDeps: false });
  assert.equal(report.writeErrors.length, 0);
  assert.equal(report.written.length, snapshot.files.length);
  const roundtrip = await buildSnapshot(homeB);
  assert.deepEqual(roundtrip.files, snapshot.files, 'homeB matches homeA after apply');
});
