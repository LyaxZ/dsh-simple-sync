# dsh-simple-sync

Sync your DeepSeek Harness config across computers — one click. Move everything
to a new machine, or keep two machines in step: plugin list, config patches,
settings, and agent presets travel as a file-level snapshot; missing plugins are
installed automatically.

多机同步 DSH 配置插件：一键搬家 + 自动同步。插件清单、配置补丁、全局设置、
Agent 预设按文件级快照同步，缺失的插件自动安装。

> No chat commands, no OAuth, no build step. Everything lives in one settings
> panel (Settings → Sync). 纯设置面板操作，无命令、无 OAuth、零运行时依赖。

## Features / 功能

- **One-click move** / 一键搬家：install on a new machine → set the backend →
  click「拉取并应用」→ config, plugins and presets all arrive; new plugins are
  `pnpm install`-ed automatically.
- **Auto-sync on startup** / 启动自动检测：DSH boots → plugin checks the remote
  → newer snapshot found → applies it (opt-out in the panel).
- **Two backends** / 两种传输后端：
  - **Git repo** (default): any git remote — GitHub / Gitee / GitLab /
    self-hosted / LAN path. Token optional (blank = system credentials / SSH);
    proxy configurable.
  - **Local folder**: a plain directory (USB drive, shared folder, cloud-drive
    sync folder). No network needed.
- **File-level snapshots** / 文件级快照：`snapshot.json` with per-file
  sha256 — only real changes travel; overwritten local files are backed up to
  `~/.dsh/.dsh-sync/backups/<timestamp>/` first.
- **Safe by default** / 默认安全：credentials (`.credentials.yaml`) are **not**
  synced unless you tick the option; tokens stay on the local machine (git
  worktree `.git-credentials`, 0600); nothing machine-specific is hardcoded.
- **No auto-restart** / 应用后只提示手动重启：after applying, DSH asks you to
  restart manually.

## Install / 安装

```bash
dsh plugin --profile web add dsh-simple-sync
# or from GitHub
dsh plugin --profile web add github:LyaxZ/dsh-simple-sync
```

Then restart DSH. Requires DSH 0.1.1-rc.x or compatible; Windows / macOS / Linux.

## Usage / 使用

1. Open **Settings → Sync**（设置 → 同步）.
2. Pick a backend and fill it in:
   - Git: repo URL + optional token/proxy/branch — e.g.
     `https://github.com/you/dsh-sync.git` (a private empty repo works).
   - Local: a folder path.
3. Click **测试连接** (Test connection) — first run prepares the worktree.
4. On the machine you configured first, click **立即推送** (Push now) to upload
   the first snapshot.
5. On every other machine, click **拉取并应用** (Pull & apply) — changes land,
   new plugins install, then restart DSH when prompted.

DSH startup auto-check applies newer remote snapshots by default; disable it in
the panel. 凭据同步（`.credentials.yaml`）默认关闭，按需勾选。

## How it works / 原理

- Sync units（同步单元，白名单）: `settings.yaml`, `.agent-presets/**`,
  and per-profile `package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`
  under `profiles/*`. Everything else (`node_modules`, sessions, memory, data,
  lockfiles, generated `cordis.yml`) is excluded by construction.
- A push builds `snapshot.json` = `{meta:{machine,time,unitVersion},
  files:[{path,sha256,content}]}` and uploads it (git commit+push / file copy).
- A pull fetches it and diffs against local state; apply writes changed files
  (backing up the old ones), then runs `pnpm install` in profiles whose
  `package.json` gained plugins.
- Last-writer-wins; machine names travel in every snapshot for traceability.
- Plugin state lives in `~/.dsh/.dsh-sync/state.json` (backend config, last
  push/pull timestamps, options).

## Development / 开发

```bash
node --test test/          # core + transport tests (incl. real bare-repo git)
node test/gateway-sim.mjs  # server-side gateway dispatch harness
```

`test/gateway-sim.mjs` imports the host's `@deepseek-ai` packages — create a
temporary `node_modules` junction to your DSH install's `node_modules` to run
it. The plugin itself ships with **zero runtime dependencies**.

## License

MIT — see [LICENSE](LICENSE).
