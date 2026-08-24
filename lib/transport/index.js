/**
 * dsh-simple-sync — transport layer (P2).
 *
 * Unified Transport interface — the Settings panel picks a backend, the
 * domain ops stay backend-agnostic:
 *
 *   init(signal)                 -> { ok, message }   prepare + test connection
 *   push(snapshot, signal)       -> { ok, message }   upload snapshot
 *   pull(signal)                 -> { ok, snapshot|null, message }  latest remote snapshot
 *
 * Snapshot JSON is the single wire format for every backend.
 */
import { gitTransport } from './git.js';
import { localTransport } from './local.js';

export const BACKENDS = {
  git: {
    id: 'git',
    label: 'Git 仓库',
    hint: '任意 git 仓库（GitHub / Gitee / GitLab / 自建 / 局域网路径），填入仓库地址和令牌即可',
    fields: [
      { key: 'repo', label: '仓库地址', type: 'text', placeholder: 'https://github.com/user/dsh-sync.git' },
      { key: 'token', label: '令牌（可选）', type: 'password', placeholder: '留空则用系统 git 凭据 / SSH' },
      { key: 'proxy', label: '代理（可选）', type: 'text', placeholder: 'http://127.0.0.1:7897' },
      { key: 'branch', label: '分支（可选）', type: 'text', placeholder: 'main' },
    ],
    create: (config, deps) => gitTransport(config, deps),
  },
  local: {
    id: 'local',
    label: '本地文件夹',
    hint: '一个本地文件夹（U 盘 / 共享目录 / 云盘同步目录），不依赖网络',
    fields: [
      { key: 'dir', label: '文件夹路径', type: 'text', placeholder: 'D:/dsh-sync' },
    ],
    create: (config, deps) => localTransport(config, deps),
  },
};

export function backendMeta() {
  return Object.values(BACKENDS).map((b) => ({
    id: b.id, label: b.label, hint: b.hint, fields: b.fields,
  }));
}

/** Create the transport for the persisted state (defaults to git). */
export function createTransport(state, deps) {
  const id = state && state.backend && BACKENDS[state.backend] ? state.backend : 'git';
  const config = (state && state[id]) || {};
  return BACKENDS[id].create(config, deps);
}
