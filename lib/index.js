/**
 * dsh-simple-sync — server half (P3).
 *
 * Hosts the `syncPanel` Typert remote service behind the Settings「同步」
 * page: status / saveConfig / test / push / preview / apply. All real
 * work delegates to ops.js (snapshot/diff/apply) and transport/*.js
 * (git / local folder). No chat commands, no model tools — the panel is
 * the only entry point (per project decision).
 */
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import {
  buildSnapshot, applySnapshot, diffSnapshot, loadState, saveState,
  resolveDshHome, syncRoot, UNIT_VERSION,
} from './ops.js';
import { createTransport, BACKENDS, backendMeta } from './transport/index.js';

export const name = 'dsh-simple-sync';
export const inject = ['subprocess', 'timer'];

const NS = 'syncPanel';
const PKG = 'dsh-simple-sync';

/**
 * `syncPanel` 调用描述符（src-json codec）——手工经 ctx.typert.register
 * 注册，免 zod 依赖；Web 客户端半边（lib/client.js）携带同一组端点。
 */
function panelDescriptor(method, parameters, cancellation) {
  return Object.freeze({
    id: `dsh-simple-sync#${NS}/${method}`,
    service: NS,
    namespace: NS,
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((p) => Object.freeze({
      name: p,
      wire: p,
      source: 'json',
      codec: Object.freeze({ mode: 'src-json' }),
    }))),
    ...(cancellation ? { cancellation: Object.freeze({ parameter: 'signal' }) } : {}),
    result: Object.freeze({ mode: 'src-json' }),
  });
}

const PANEL_INVOCATIONS = Object.freeze([
  panelDescriptor('status', []),
  panelDescriptor('saveConfig', ['config']),
  panelDescriptor('test', [], true),
  panelDescriptor('push', [], true),
  panelDescriptor('preview', [], true),
  panelDescriptor('apply', [], true),
]);

/**
 * 面板服务：普通对象（零 @deepseek-ai 依赖）。
 * cordis Service 基类实际只做两件事：把实例注册进 ctx（reflect.provide）
 * 并挂上 `typertRemote` 可见绑定。gateway 的 validateBinding 只要求：
 *   receiver.typertRemote.service === receiver（originalOf 解包后）
 *   .serviceKey === descriptor.service，.namespace === descriptor.namespace
 * 因此普通对象 + 手工绑定即可通过，无需继承 cordis Service，
 * 也无需 import 任何 @deepseek-ai 包（junction 开发目录无法解析它们）。
 */
function createSyncPanelService(ops) {
  const service = {
    status() {
      return ops.status();
    },
    saveConfig(config) {
      return ops.saveConfig(config);
    },
    test(signal) {
      return ops.test(signal);
    },
    push(signal) {
      return ops.push(signal);
    },
    preview(signal) {
      return ops.preview(signal);
    },
    apply(signal) {
      return ops.apply(signal);
    },
  };
  service.typertRemote = Object.freeze({
    service,
    serviceKey: NS,
    namespace: NS,
  });
  return service;
}

export function apply(ctx, pluginConfig) {
  // ---------- paths ----------
  let dshHome = null;
  try {
    dshHome = resolveDshHome(ctx.get('launchEnvironment'));
  } catch (err) {
    console.error(`[dsh-simple-sync] ${String(err?.message || err)}`);
  }

  // ---------- subprocess runner (git / pnpm) ----------
  async function collectOutput(col) {
    const read = col && col.readFrom ? col.readFrom(0) : null;
    if (!read) return '';
    if (read.lossy && read.spillPath) {
      try {
        return await readFile(read.spillPath, 'utf8');
      } catch {
        // fall through to the in-memory tail window
      }
    }
    return read.text ?? '';
  }

  async function spawnRun(argv, cwd, signal) {
    const proc = ctx.subprocess.spawn({
      argv,
      cwd,
      graceMs: 5000,
      signal,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } },
        stderr: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } },
      },
    });
    const outcome = await proc.done;
    const out = await collectOutput(proc.collected && proc.collected.stdout);
    const err = await collectOutput(proc.collected && proc.collected.stderr);
    if (signal && signal.aborted) throw new Error('操作已取消');
    if (outcome.signal != null) throw new Error(`命令被终止（signal=${outcome.signal}）`);
    if (outcome.exitCode !== 0) throw new Error(`命令失败 exit=${outcome.exitCode}: ${err || out}`);
    return { out, err };
  }

  const run = async (argv, cwd, opts = {}) => spawnRun(argv, cwd, opts.signal);
  const resolveExecutable = async (name) => ctx.subprocess.resolveExecutable(name);

  // ---------- state ----------
  let stateCache = null;
  async function getState() {
    if (!dshHome) throw new Error('无法解析 DSH 家目录（launchEnvironment 缺失）');
    if (!stateCache) stateCache = await loadState(dshHome);
    return stateCache;
  }

  async function setState(next) {
    stateCache = next;
    if (dshHome) await saveState(dshHome, next);
  }

  function transportFor(s, signal) {
    return createTransport(s, { syncRoot: syncRoot(dshHome), run, signal });
  }

  // ---------- panel ops ----------
  const ops = {
    async status() {
      const s = await getState();
      return {
        dshHome,
        syncRoot: syncRoot(dshHome),
        machine: hostname(),
        unitVersion: UNIT_VERSION,
        backends: backendMeta(),
        state: {
          backend: s.backend || 'git',
          git: {
            repo: (s.git && s.git.repo) || '',
            tokenSet: Boolean(s.git && s.git.token),
            proxy: (s.git && s.git.proxy) || '',
            branch: (s.git && s.git.branch) || '',
          },
          local: { dir: (s.local && s.local.dir) || '' },
          includeCredentials: Boolean(s.includeCredentials),
          autoCheck: s.autoCheck !== false,
          lastPush: s.lastPush || null,
          lastPushMachine: s.lastPushMachine || null,
          lastPull: s.lastPull || null,
          lastPullMachine: s.lastPullMachine || null,
          lastError: s.lastError || null,
        },
      };
    },

    async saveConfig(config) {
      const backend = config && BACKENDS[config.backend] ? config.backend : 'git';
      const incoming = config || {};
      const s = await getState();
      const oldGit = s.git || {};
      const git = {
        repo: typeof incoming.git?.repo === 'string' ? incoming.git.repo.trim() : (oldGit.repo || ''),
        token: (typeof incoming.git?.token === 'string' && incoming.git.token.trim())
          ? incoming.git.token.trim()
          : (oldGit.token || ''),
        proxy: typeof incoming.git?.proxy === 'string' ? incoming.git.proxy.trim() : (oldGit.proxy || ''),
        branch: typeof incoming.git?.branch === 'string' ? incoming.git.branch.trim() : (oldGit.branch || ''),
      };
      const local = {
        dir: typeof incoming.local?.dir === 'string' ? incoming.local.dir.trim() : ((s.local && s.local.dir) || ''),
      };
      const next = {
        ...s,
        backend,
        git,
        local,
        includeCredentials: Boolean(incoming.includeCredentials),
        autoCheck: incoming.autoCheck !== false,
        lastError: null,
      };
      await setState(next);
      return { ok: true, message: '配置已保存' };
    },

    async test(signal) {
      const s = await getState();
      const r = await transportFor(s, signal).init();
      return { ok: r.ok, message: r.message };
    },

    async push(signal) {
      const s = await getState();
      const snapshot = await buildSnapshot(dshHome, { includeCredentials: s.includeCredentials });
      const r = await transportFor(s, signal).push(snapshot);
      if (r.ok) {
        await setState({
          ...s,
          lastPush: snapshot.meta.time,
          lastPushMachine: snapshot.meta.machine,
          lastError: null,
        });
      } else {
        await setState({ ...s, lastError: r.message });
      }
      return { ok: r.ok, message: r.message, files: snapshot.files.length };
    },

    async preview(signal) {
      const s = await getState();
      const r = await transportFor(s, signal).pull();
      if (!r.ok) return { ok: false, message: r.message, diff: null, snapshotMeta: null };
      if (!r.snapshot) {
        return { ok: true, message: r.message, diff: { added: [], modified: [] }, snapshotMeta: null };
      }
      const diff = await diffSnapshot(r.snapshot, dshHome);
      return {
        ok: true,
        message: r.message,
        snapshotMeta: r.snapshot.meta,
        diff: {
          added: diff.added.map((f) => f.path),
          modified: diff.modified.map((f) => f.path),
        },
      };
    },

    async apply(signal) {
      const s = await getState();
      const r = await transportFor(s, signal).pull();
      if (!r.ok) return { ok: false, message: r.message, summary: r.message, report: null };
      if (!r.snapshot) {
        return {
          ok: true,
          message: r.message,
          summary: '远端还没有快照。先在另一台电脑上点「立即推送」。',
          report: null,
        };
      }
      const report = await applySnapshot(r.snapshot, dshHome, { run, resolveExecutable, signal });
      await setState({
        ...s,
        lastPull: r.snapshot.meta.time,
        lastPullMachine: r.snapshot.meta.machine,
        lastError: report.writeErrors.length ? report.writeErrors[0].error : null,
      });
      return {
        ok: report.writeErrors.length === 0 && report.depsFailed.length === 0,
        message: summarizeReport(report),
        report: {
          written: report.written,
          backedUp: report.backedUp,
          depsInstalled: report.depsInstalled,
          depsFailed: report.depsFailed,
          restartHint: report.restartHint,
          writeErrors: report.writeErrors,
        },
      };
    },
  };

  // ---------- typert registration (web profiles only) ----------
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => scope.typert.register({
      package: PKG,
      face: 'host',
      schemas: [],
      invocations: PANEL_INVOCATIONS,
      model: Object.freeze({ services: Object.freeze([]), events: Object.freeze([]), objects: Object.freeze([]) }),
    }), 'dsh-simple-sync: typert invocations');
    scope.reflect.provide(NS, createSyncPanelService(ops));
  });

  // ---------- P4: startup auto-check (opt-out via state.autoCheck) ----------
  async function autoCheck() {
    const s = await getState();
    if (!s || s.autoCheck === false) return;
    const hasBackend = (s.git && (s.git.repo || s.git.token)) || (s.local && (s.local.dir || ''));
    if (!hasBackend) return;
    const tr = transportFor(s, undefined);
    const pull = await tr.pull();
    if (!pull.ok || !pull.snapshot) return;
    if (s.lastPull && pull.snapshot.meta.time === s.lastPull) return; // already applied
    const diff = await diffSnapshot(pull.snapshot, dshHome);
    if (!diff.added.length && !diff.modified.length) return;
    const report = await applySnapshot(pull.snapshot, dshHome, { run, resolveExecutable, signal: undefined });
    await setState({
      ...s,
      lastPull: pull.snapshot.meta.time,
      lastPullMachine: pull.snapshot.meta.machine,
      lastError: report.writeErrors.length ? report.writeErrors[0].error : null,
    });
    console.log(`[dsh-simple-sync] 启动检测：已应用远端更新 ${report.written.length} 个文件${report.restartHint ? '，请重启 DSH 使配置生效' : ''}`);
  }

  if (ctx.timeout && dshHome) {
    ctx.timeout(() => {
      void autoCheck().catch((err) => {
        console.warn(`[dsh-simple-sync] 启动检测失败: ${String(err?.message || err)}`);
      });
    }, 5000);
  }
}

function summarizeReport(report) {
  const lines = [];
  if (report.written.length) {
    lines.push(`已写入 ${report.written.length} 个文件：`);
    for (const w of report.written) lines.push(`  ${w.action === 'added' ? '新增' : '更新'} ${w.path}`);
  } else {
    lines.push('本地已经是最新，无需写入。');
  }
  if (report.backedUp.length) lines.push(`已备份被覆盖的本地文件 ${report.backedUp.length} 个（${report.backupDir}）`);
  if (report.depsInstalled.length) lines.push(`已重装依赖：${report.depsInstalled.join(', ')}`);
  if (report.depsFailed.length) {
    lines.push('⚠️ 依赖重装失败，已回滚配置文件避免 DSH 无法启动：');
    for (const d of report.depsFailed) lines.push(`  ${d.profile}: ${d.error}`);
    lines.push('  恢复步骤：终端运行 `dsh plugin --profile web install` 安装依赖，重启 DSH 后再点「拉取并应用」。');
  }
  if (report.reverted.length) {
    for (const r of report.reverted) lines.push(`↩️ ${r.profile} 已回滚：${r.files.join('、')}`);
  }
  if (report.writeErrors.length) {
    lines.push(`⚠️ 写入失败 ${report.writeErrors.length} 个：`);
    for (const e of report.writeErrors) lines.push(`  ${e.path}: ${e.error}`);
  }
  if (report.restartHint) lines.push('请重启 DSH 使同步后的配置生效。');
  return lines.join('\n');
}
