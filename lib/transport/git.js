/**
 * dsh-simple-sync — git transport (P2).
 *
 * Works in a dedicated worktree under <syncRoot>/work, pushing/pulling a
 * single snapshot.json. Works with any git remote: GitHub / Gitee / GitLab
 * / self-hosted / bare local path. Auth via credential-helper store file
 * (token never lands in .git/config or the snapshot); proxy configurable.
 */
import { join } from 'node:path';
import { promises as fs } from 'node:fs';

export const SNAPSHOT_FILE = 'snapshot.json';
const CRED_FILE = '.git-credentials';
const BRANCH_DEFAULT = 'main';

function workdirFor(syncRoot) {
  return join(syncRoot, 'work');
}

/** Strip userinfo (user:pass@) from http(s) URLs; other forms unchanged. */
function stripUserinfo(raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      return u.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

/** Compare two snapshots by payload content only (path + sha256), ignoring meta. */
function sameFiles(a, b) {
  if (!a || !b || !Array.isArray(a.files) || !Array.isArray(b.files)) return false;
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i += 1) {
    if (a.files[i].path !== b.files[i].path || a.files[i].sha256 !== b.files[i].sha256) return false;
  }
  return true;
}

export function gitTransport(config, { syncRoot, run, signal }) {
  const repoRaw = typeof config?.repo === 'string' ? config.repo.trim() : '';
  const repo = stripUserinfo(repoRaw);
  const token = typeof config?.token === 'string' ? config.token.trim() : '';
  const proxy = typeof config?.proxy === 'string' ? config.proxy.trim() : '';
  const branch = typeof config?.branch === 'string' && config.branch.trim() ? config.branch.trim() : BRANCH_DEFAULT;
  const workdir = workdirFor(syncRoot);
  const isHttp = /^https?:\/\//i.test(repo);

  async function git(args, cwd = workdir) {
    return run(['git', ...args], cwd, { signal });
  }

  /** Ensure identity exists for commits (repo-local, never touches global). */
  async function ensureIdentity() {
    for (const [k, v] of [['user.name', 'dsh-simple-sync'], ['user.email', 'sync@localhost']]) {
      try {
        await git(['config', '--get', k]);
      } catch {
        await git(['config', k, v]);
      }
    }
  }

  async function ensureWorktree() {
    try {
      await fs.access(join(workdir, '.git'));
    } catch {
      await fs.mkdir(workdir, { recursive: true });
      await git(['init']);
    }
    // remote
    const remote = ['remote', 'get-url', 'origin'];
    try {
      await git(remote);
      await git(['remote', 'set-url', 'origin', repo]);
    } catch {
      await git(['remote', 'add', 'origin', repo]);
    }
    // proxy
    if (isHttp) {
      if (proxy) {
        await git(['config', 'http.proxy', proxy]);
        await git(['config', 'https.proxy', proxy]);
      } else {
        await git(['config', '--unset-all', 'http.proxy']).catch(() => {});
        await git(['config', '--unset-all', 'https.proxy']).catch(() => {});
      }
    }
    // credentials (http(s) + token only)
    if (isHttp && token) {
      const credPath = join(workdir, CRED_FILE).replace(/\\/g, '/');
      let host;
      try {
        host = new URL(repo).host;
      } catch {
        host = '';
      }
      if (host) {
        await fs.writeFile(join(workdir, CRED_FILE), `https://${token}@${host}/\n`, 'utf8');
        try {
          await fs.chmod(join(workdir, CRED_FILE), 0o600);
        } catch {
          // Windows: user dir ACLs already private
        }
      }
      await git(['config', 'credential.helper', `store --file=${credPath}`]);
    }
    await ensureIdentity();
  }

  /** Position the worktree on the sync branch (handles empty remotes). */
  async function syncBranch() {
    await git(['fetch', 'origin']).catch(() => {});
    let hasRemote = false;
    try {
      await git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
      hasRemote = true;
    } catch {
      // empty remote or first sync
    }
    if (hasRemote) {
      await git(['checkout', '-B', branch, `origin/${branch}`]);
      await git(['reset', '--hard', `origin/${branch}`]);
    } else {
      await git(['checkout', '-B', branch]);
    }
  }

  return {
    id: 'git',

    async init() {
      if (!repo) return { ok: false, message: '请填写仓库地址' };
      try {
        await ensureWorktree();
        await syncBranch();
        return { ok: true, message: `工作树就绪: ${workdir}` };
      } catch (err) {
        return { ok: false, message: `初始化失败: ${String(err?.message || err)}` };
      }
    },

    async push(snapshot) {
      if (!repo) return { ok: false, message: '请填写仓库地址' };
      try {
        await ensureWorktree();
        const target = join(workdir, SNAPSHOT_FILE);
        // Skip the commit when the payload content (path+sha256) is identical
        // to the last pushed snapshot — meta.time changes every push, so a
        // naive diff would create a no-op commit each time.
        let previous = null;
        try {
          previous = JSON.parse(await fs.readFile(target, 'utf8'));
        } catch {
          // no previous snapshot in the worktree
        }
        if (sameFiles(previous, snapshot)) {
          return { ok: true, message: '远端已是最新' };
        }
        const tmp = `${target}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(snapshot)}\n`, 'utf8');
        await fs.rename(tmp, target);
        await git(['add', SNAPSHOT_FILE]);
        const stamp = snapshot?.meta?.machine || 'unknown';
        const when = snapshot?.meta?.time || new Date().toISOString();
        await git(['commit', '-m', `sync: ${stamp} ${when}`]);
        await git(['push', '-u', 'origin', branch]);
        return { ok: true, message: '已推送到远端' };
      } catch (err) {
        return { ok: false, message: `推送失败: ${String(err?.message || err)}` };
      }
    },

    async pull() {
      if (!repo) return { ok: false, snapshot: null, message: '请填写仓库地址' };
      try {
        await ensureWorktree();
        await syncBranch();
        let text;
        try {
          text = await fs.readFile(join(workdir, SNAPSHOT_FILE), 'utf8');
        } catch {
          return { ok: true, snapshot: null, message: '远端还没有快照（首次使用）' };
        }
        const snapshot = JSON.parse(text);
        return { ok: true, snapshot, message: '已拉取远端快照' };
      } catch (err) {
        return { ok: false, snapshot: null, message: `拉取失败: ${String(err?.message || err)}` };
      }
    },
  };
}
