/**
 * Gateway dispatch harness — loads the REAL plugin module into a minimal
 * cordis ctx (real TypertRegistry + TypertGatewayService from the host
 * install) and dispatches syncPanel RPCs directly, surfacing the true
 * server-side error. Run: node test/gateway-sim.mjs
 */
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import * as plugin from '../lib/index.js';

const fakeHome = await mkdtemp(join(tmpdir(), 'dss-gw-'));
await mkdir(fakeHome, { recursive: true });
await writeFile(join(fakeHome, 'settings.yaml'), 'locale:\n  preference: zh\n');

const ctx = new Context();
await ctx.plugin(TypertRegistry);
ctx.reflect.provide('launchEnvironment', {
  get: (k) => {
    const m = new Map([
      ['HOME', { value: fakeHome.replace(/\.dsh$/, '') }],
      ['USERPROFILE', { value: fakeHome.replace(/\.dsh$/, '') }],
      ['DSH_HOME', { value: fakeHome }],
    ]);
    return m.get(k);
  },
});
ctx.reflect.provide('subprocess', {
  spawn: () => { throw new Error('no subprocess in harness'); },
});
ctx.reflect.provide('timer', {
  timeout: () => ({}),
});
ctx.reflect.provide('timeout', () => ({}));
await ctx.plugin(plugin);
await ctx.plugin(TypertGatewayService);

// diagnostics: did our descriptors commit?
console.log('=== registration diagnostics ===');
const typertLoose = ctx.reflect._getImpl('typert', false);
const typertStrict = ctx.reflect._getImpl('typert', true);
console.log('typert impl (loose):', !!typertLoose, 'state:', typertLoose?.fiber?.state);
console.log('typert impl (strict):', !!typertStrict, 'state:', typertStrict?.fiber?.state);
console.log('local endpoints:', ctx.typert.local.list().map((d) => `${d.namespace}/${d.method}`));
console.log('packages:', ctx.typert.listPackages().map((p) => `${p.package}#${p.face}`));
console.log('reflect props:', Object.keys(ctx.reflect.props).sort());
console.log('syncPanel service present:', ctx.get('syncPanel') !== void 0);
console.log('syncPanel binding:', ctx.get('syncPanel')?.typertRemote);

async function call(method, args = {}) {
  const result = await ctx.typertGateway.dispatchRpc(`syncPanel/${method}`, { args }, undefined);
  return result;
}

console.log('=== status ===');
console.log(JSON.stringify(await call('status'), (k, v) => (typeof v === 'bigint' ? String(v) : v), 2));

console.log('=== saveConfig ===');
const saved = await call('saveConfig', { config: { backend: 'git', git: { repo: 'https://example.com/a.git', token: 'tok' }, includeCredentials: false, autoCheck: false } });
console.log(JSON.stringify(saved, null, 2));

console.log('=== status (after save) ===');
console.log(JSON.stringify(await call('status'), null, 2));

process.exit(0);
