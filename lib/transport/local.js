/**
 * dsh-simple-sync — local folder transport (P2).
 *
 * Pushes/pulls snapshot.json to/from a plain folder (USB drive, shared
 * directory, cloud-drive sync folder). No network, no git.
 */
import { join } from 'node:path';
import { promises as fs } from 'node:fs';

export const SNAPSHOT_FILE = 'snapshot.json';
const PROBE = '.dsh-simple-sync-probe';

export function localTransport(config, { run: _run, signal } = {}) {
  const dir = typeof config?.dir === 'string' ? config.dir.trim() : '';

  return {
    id: 'local',

    async init() {
      if (!dir) return { ok: false, message: '请填写文件夹路径' };
      try {
        await fs.mkdir(dir, { recursive: true });
        const probe = join(dir, PROBE);
        await fs.writeFile(probe, 'ok', 'utf8');
        await fs.rm(probe, { force: true });
        return { ok: true, message: `文件夹可用: ${dir}` };
      } catch (err) {
        return { ok: false, message: `文件夹不可写: ${String(err?.message || err)}` };
      }
    },

    async push(snapshot) {
      if (!dir) return { ok: false, message: '请填写文件夹路径' };
      try {
        await fs.mkdir(dir, { recursive: true });
        const target = join(dir, SNAPSHOT_FILE);
        const tmp = `${target}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(snapshot)}\n`, 'utf8');
        await fs.rename(tmp, target);
        return { ok: true, message: '已写入本地文件夹' };
      } catch (err) {
        return { ok: false, message: `写入失败: ${String(err?.message || err)}` };
      }
    },

    async pull() {
      if (!dir) return { ok: false, snapshot: null, message: '请填写文件夹路径' };
      try {
        let text;
        try {
          text = await fs.readFile(join(dir, SNAPSHOT_FILE), 'utf8');
        } catch {
          return { ok: true, snapshot: null, message: '文件夹里还没有快照' };
        }
        const snapshot = JSON.parse(text);
        return { ok: true, snapshot, message: '已读取本地快照' };
      } catch (err) {
        return { ok: false, snapshot: null, message: `读取失败: ${String(err?.message || err)}` };
      }
    },
  };
}
