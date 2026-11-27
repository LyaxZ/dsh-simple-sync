/**
 * Client-half tests: the browser bundle must load on DSH 0.2.x (where
 * @deepseek-ai/dsh-client-runtime is gone), register its Typert contribution
 * with strict codecs that carry a schema factory, and keep a visible settings
 * section with a retry when `$mount` rejects.
 * Run: node --test test/client-mount.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const clientSource = await readFile(join(root, 'lib', 'client.js'), 'utf8');

function loadFactory() {
  const captured = {};
  new Function('window', clientSource)({
    __ModuleLoader__: { load: (entry) => { captured.entry = entry; } },
  });
  assert.ok(captured.entry, 'client.js registers a lazy factory');
  assert.equal(captured.entry.id, 'dsh-simple-sync');
  return captured.entry.factory;
}

// ---------- minimal React (one render pass per call) ----------
let hooks = [];
let cursor = 0;
const React = {
  useState(initial) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
    return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
  },
  useEffect(fn) { const i = cursor++; if (!(i in hooks)) hooks[i] = fn(); },
  useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
};
const jsxRuntime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };

function render(component, props) {
  hooks = [];
  cursor = 0;
  return component(props);
}
function texts(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out; }
  if (node.props) texts(node.props.children, out);
  return out;
}
function findButton(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button' && node.props && typeof node.props.onClick === 'function') return node;
  const children = node.props && node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child);
    if (found) return found;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const panelStub = {
  status: async () => ({ ok: true, value: {} }),
  saveConfig: async () => ({ ok: true }),
  test: async () => ({ ok: true, message: 'ok' }),
  push: async () => ({ ok: true, message: 'ok' }),
  preview: async () => ({ ok: true, message: 'ok' }),
  apply: async () => ({ ok: true, message: 'ok' }),
};

/**
 * Run the plugin body against a minimal client Context.
 * failMount: false | 'always' | 'first'
 */
async function applyClient({ failMount }) {
  const factory = loadFactory();
  const requires = [];
  const exports = factory((spec) => {
    requires.push(spec);
    if (spec === 'react') return React;
    if (spec === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`unexpected require: ${spec}`);
  });

  const sections = [];
  let mountCalls = 0;
  const ctx = {
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {}; },
    locale: { register: () => () => {}, bind: () => (key) => key },
    remote: {
      async $mount(descriptor) {
        mountCalls += 1;
        if (failMount === 'always' || (failMount === 'first' && mountCalls === 1)) {
          throw new Error('client api: generated Remote syncPanel/test field "config" has no strict codec');
        }
        ctx.lastDescriptor = descriptor;
        ctx.remote.syncPanel = panelStub;
        return () => { ctx.remote.syncPanel = undefined; };
      },
    },
    slots: {
      inject(_key, callback) {
        const disposeRegistration = callback();
        return () => { if (typeof disposeRegistration === 'function') disposeRegistration(); };
      },
      register(definition, component) {
        const record = { definition, component, active: true };
        sections.push(record);
        return () => { record.active = false; };
      },
    },
    inject(deps, callback) {
      // Cordis invokes this once the coordinate exists; poll like the runtime.
      const started = Date.now();
      const tick = () => {
        const ready = deps.every((dep) => dep
          .split('.')
          .reduce((target, key) => (target == null ? undefined : target[key]), ctx) !== undefined);
        if (ready) { callback(ctx); return; }
        if (Date.now() - started > 1000) return; // stays unmounted, like a missing service
        setTimeout(tick, 5);
      };
      tick();
    },
  };

  exports.apply(ctx);
  await sleep(30);

  const snapshot = () => sections.map((s) => ({
    id: s.definition.id,
    order: s.definition.order,
    active: s.active,
    component: s.component.name,
    props: Object.keys(s.definition.inject ? s.definition.inject() : {}),
  }));

  return { requires, exports, ctx, sections, snapshot, mountCalls: () => mountCalls };
}

test('loads without the removed @deepseek-ai/dsh-client-runtime', async () => {
  const { requires, exports } = await applyClient({ failMount: false });
  assert.deepEqual(requires, ['react', 'react/jsx-runtime']);
  assert.deepEqual(exports.inject, ['slots', 'locale', 'remote']);
});

test('manifest no longer injects the removed client runtime', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-settings',
  ]);
});

test('mounts six endpoints whose strict codecs carry a schema factory', async () => {
  const run = await applyClient({ failMount: false });
  assert.equal(run.mountCalls(), 1);
  const descriptor = run.ctx.lastDescriptor;
  assert.equal(descriptor.package, 'dsh-simple-sync');
  assert.deepEqual(descriptor.descriptors.map((d) => d.method), [
    'status', 'saveConfig', 'test', 'push', 'preview', 'apply',
  ]);
  for (const entry of descriptor.descriptors) {
    assert.equal(entry.result.mode, 'strict');
    assert.equal(typeof entry.result.create, 'function', `${entry.method} result codec has create()`);
    assert.equal(typeof entry.result.schema.parse, 'function');
    for (const parameter of entry.parameters) {
      assert.equal(parameter.codec.mode, 'strict');
      assert.equal(typeof parameter.codec.create, 'function', `${entry.method}.${parameter.wire} codec has create()`);
    }
  }
});

test('registers the real panel once the remote is mounted', async () => {
  const run = await applyClient({ failMount: false });
  const active = run.snapshot().filter((s) => s.active && s.id === 'simple-sync');
  assert.equal(active.length, 1);
  assert.deepEqual(active[0].props, ['panel']);
  assert.equal(active[0].order, 240);
});

test('keeps a visible section with the mount error and a retry button', async () => {
  const run = await applyClient({ failMount: 'always' });
  const fallback = run.sections.find((s) => s.active && s.definition.id === 'simple-sync');
  assert.ok(fallback, 'the settings section stays registered after a failed mount');
  assert.equal(fallback.component.name, 'SyncUnavailable');

  const props = fallback.definition.inject();
  const tree = render(fallback.component, props);
  const text = texts(tree).join('\n');
  assert.match(text, /has no strict codec/, 'the panel shows the mount error text');
  assert.ok(findButton(tree), 'the panel offers a retry button');
  // the real panel must not appear while the remote is missing
  assert.ok(!run.snapshot().some((s) => s.active && s.props.includes('panel')));
});

test('retry remounts and replaces the fallback with the real panel', async () => {
  const run = await applyClient({ failMount: 'first' });
  const fallback = run.sections.find((s) => s.active && s.definition.id === 'simple-sync');
  assert.ok(fallback);
  const retry = findButton(render(fallback.component, fallback.definition.inject()));
  assert.ok(retry, 'fallback has a retry button');

  retry.props.onClick();
  await sleep(60);

  assert.equal(run.mountCalls(), 2, 'retry calls $mount again');
  const active = run.snapshot().filter((s) => s.active && s.id === 'simple-sync');
  assert.equal(active.length, 1, 'exactly one section owns the id after the swap');
  assert.deepEqual(active[0].props, ['panel']);
  assert.equal(run.sections.filter((s) => s.active && s.component.name === 'SyncUnavailable').length, 0);
});
