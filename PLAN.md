# dsh-simple-sync — DSH 多机配置同步插件（方案 v2）

> 状态：**待开工**（2026-08-19 v2 更新）
> 定位：**market 可发布的通用插件** —— 不绑定任何人的机器环境，面板操作，人人可用。
> 目标：两台电脑之间的 DSH 配置一键搬家 + 自动同步 + 插件自动更新，全部在设置界面完成。

## 0. 用户已拍板的决策（2026-08-19）

| 项 | 决策 |
|---|---|
| 插件名 | simple sync → npm 包 `dsh-simple-sync`（已确认无占用），GitHub `LyaxZ/dsh-simple-sync` |
| 传输后端 | **通用化，多后端**（git 仓库 / 本地文件夹），默认 git；**webdav 暂不做**（无测试环境，接口预留 v2）—— 不绑定 GitHub、不绑定代理、不绑定本机 |
| 交互入口 | **纯可视化**：Settings 里一个「同步」面板完成全部操作，**不做聊天命令** |
| 重启 | 应用配置后**只提示手动重启**，不自动重启 |
| 凭据同步 | 默认关；面板里可开启（明文入库，私有仓库内；加密留作后续） |
| 数据范围 | 只同步配置+插件；sessions/memory/storages 不同步 |
| 自动化 | DSH 启动时自动检测远端（可关）；平时手动点「推送」 |
| 泛用化 | 代理、路径、后端等一切与本机强相关的东西全部进面板配置，零硬编码 |

## 1. 插件分层结构（复用 dsh-backup 架构，逐层说明）

### 包级（4 个文件 = 与 DSH 的契约）

```
dsh-simple-sync/
  package.json        # ① 契约层：npm 身份 + exports(服务端/浏览器两个入口) + dsh.bundle.patch + dsh.client.inject
  cordis.patch.yml    # ② 装配层：声明"把我 insert 进 profile 的 loader 树"（可带 config 默认值）
  lib/index.js        # ③ 服务端层：跑在 DSH Node 进程里，全部业务逻辑
  lib/client.js       # ④ 浏览器层：跑在 Web 前端，设置面板 UI
```

- **package.json**：DSH loader 靠它发现插件的两个半边（`exports["."]` → 服务端入口；`exports["./client"]` → 浏览器入口）；`dsh.bundle.patch` 指向装配补丁；`dsh.client.inject` 声明浏览器半边需要宿主注入哪些模块（react / dsh-client-runtime / dsh-client-ui-slots / dsh-client-ui-settings）
- **cordis.patch.yml**：`- insert: {id, name}` 把插件插进 profile 的 loader 树；可带 `config` 给插件默认配置
- **lib/index.js**（服务端）：见下节分层
- **lib/client.js**（浏览器）：`window.__ModuleLoader__.load({id, factory(require)})` → 用宿主注入的模块 → 经 settings 插槽 API 在「设置」里注册一个面板页 → 用 Typert remote client 调服务端方法 → 渲染按钮/状态/结果

### 服务端内部（index.js 内的逻辑分层）

| 层 | 职责 | dsh-backup 对应物 |
|---|---|---|
| ① 能力声明 | `inject: ['subprocess','commands','timer','tools']` 声明依赖的 DSH 服务 | 同左 |
| ② 执行层 | `spawnRun()` 包装 `ctx.subprocess.spawn`：跑 git/pnpm 等外部命令，统一收集输出、处理取消、分类错误（取消 ≠ 失败 ≠ 退出码非零） | 同左 |
| ③ 路径层 | `launchEnvironment` → HOME/USERPROFILE/DSH_HOME → `~/.dsh`、profiles 枚举；跨平台（Windows 反斜杠→正斜杠） | 同左 |
| ④ 领域逻辑层 | ops 闭包：快照生成 / diff / 应用 / 备份 / 安装依赖 —— 纯逻辑，不感知 UI | backup/restore/verify/轮换/脱敏 |
| ⑤ 暴露层 | **只保留一个出口**：Typert Remote 面板服务（`TypertRemoteService` + `ctx.typert.register`），面板方法 = 领域操作 + 状态查询 | 三出口（命令/工具/面板） |
| ⑥ 持久化层 | node:fs 直写插件自有状态 `~/.dsh-sync/state.json`（后端配置、上次同步时间），重启续用；不走 ctx.fs（那是模型沙箱面） | auto.json |
| ⑦ 调度层 | `ctx.timeout` 链：启动后延迟检测远端（避开启动高峰），失败退避 | 定时自动备份 |

### 浏览器内部（client.js）

`factory(require)` 里：require 宿主模块 → 注册设置插槽（面板页）→ 定义 Typert remote 客户端方法（zod 描述，随包自带，无需额外依赖）→ React 渲染。整个面板只有三类东西：**配置表单**（后端选择+参数+代理）、**操作按钮**（推送 / 拉取并应用 / 测试连接）、**状态区**（上次同步时间、两端差异、历史备份、错误信息）。

## 2. 传输后端抽象（通用化核心）

```js
// lib/transport/*.js —— 统一接口，面板切换后端只是换实现
interface Transport {
  id: 'git' | 'local';            // webdav 预留（v2）
  label: string;                    // 面板显示名
  fields: Field[];                  // 面板动态表单（地址/令牌/账号密码/路径）
  init(signal): Promise<InitResult>;      // 建工作树/连网盘/建目录 + 测试连接
  push(files, signal): Promise<PushResult>;   // 上传快照（git commit+push / PUT / 拷贝）
  pull(signal): Promise<PullResult>;        // 拿远端快照（git pull / GET / 拷贝）
  dispose(): void;
}
```

| 后端 | 适用人群 | 面板填什么 | 实现要点 |
|---|---|---|---|
| **git**（默认） | 所有人：GitHub / Gitee / GitLab / 自建 / 局域网路径 | 仓库地址 + 令牌（可留空走系统凭据/SSH） | 工作树 `~/.dsh-sync/work/`；token 写 `.git-credentials`（0600）；快照文件 commit `sync: <machine> <time>` |
| **local** | 完全离线（U 盘/共享文件夹）；"第一次搬家" | 一个目录路径 | 快照 json 直接拷贝/读取；不依赖任何网络 |

> webdav 后端：**v2 可选**（接口预留），需要坚果云等 WebDAV 测试环境再做。

- **快照格式统一**：`snapshot.json` = `{meta: {machine, time, dshVersion, unitVersion}, files: [{path, sha256, content}]}`，所有后端共用同一格式与同一套 apply 逻辑
- **简单性设计**：默认后端 git，面板三步引导（① 建一个空私有仓库 ② 填地址和令牌 ③ 点「推送」）；「测试连接」按钮即时反馈；无需 OAuth、无需命令行
- **凭证存储**：git token → 工作树 `.git-credentials`（0600）；只读本机（POSIX 0600，Windows 用户目录默认私有）；**凭证绝不进快照文件、绝不进同步内容**

## 3. 同步单元（文件级增量，非整包归档）

| 单元 | 文件（相对 `~/.dsh`） | 说明 |
|---|---|---|
| 插件清单 | `profiles/<每个 profile>/package.json` | bundles + dependencies；**枚举 profiles 目录**，不写死 web |
| 配置补丁 | `profiles/<每个 profile>/cordis.patch.yml` | 各插件的用户配置 |
| 构建授权 | `profiles/<每个 profile>/pnpm-workspace.yaml` | allowBuilds，重装依赖必需 |
| 全局设置 | `settings.yaml` | 模型、主题、locale 等 |
| Agent 预设 | `.agent-presets/` | 预设目录 |
| 凭据（可选） | `.credentials.yaml` | 默认排除；面板开关开启 |
| 排除项 | node_modules / pnpm-lock.yaml / cordis.yml（生成物）/ sessions / memory / storages / data / cache / skills | 可重生成或机器相关 |

## 4. 同步协议

- **push**：生成本机快照 → transport.push → 本地记 `lastPush`
- **pull**：transport.pull 拿远端快照 → 与本地当前状态 diff（sha256）→ 差异报告（新增/修改/删除）
- **apply**（面板「拉取并应用」一键完成）：
  1. 写回前把将被覆盖的本地文件备份到 `~/.dsh-sync/backups/<时间戳>/`
  2. 差异写回（package.json / cordis.patch.yml / pnpm-workspace.yaml / settings.yaml / .agent-presets）
  3. 清单出现新插件 → 增量 `pnpm install`（frozen 失败回退普通 install）
  4. **提示"请手动重启 DSH 使配置生效"**（不自动重启）
  5. 两机同时改同一文件 → 最后写入者胜，被覆盖版在备份目录；快照带机器名可追溯
- **启动自动检测**（面板开关，默认开）：DSH 启动后延迟数秒 pull → 有更新自动 apply → 提示重启；本机有未推送改动时先提示（不覆盖）
- **状态**：`~/.dsh-sync/state.json`（后端类型+参数、凭证引用、lastPush/lastPull、自动开关），重启续用

## 5. 面板设计（唯一入口，Settings → 同步）

```
┌─ 同步 ─────────────────────────────┐
│ 后端: [git ▾]  仓库地址 [________]  │
│       令牌 [________]（留空=系统凭据）│
│ 代理: [________]（可选，如 http://127.0.0.1:7897）│
│        [测试连接]                    │
│ ────────────────────────────────── │
│ 上次推送: 2026-08-19 10:00（主力机） │
│ 上次拉取: 2026-08-19 09:55（轻薄本） │
│ 待推送改动: 2 个文件                 │
│ ────────────────────────────────── │
│ [立即推送]  [拉取并应用]              │
│ ☑ 启动时自动检测远端                 │
│ ☐ 同步凭据（.credentials.yaml）      │
│ ────────────────────────────────── │
│ 最近操作日志 / 错误信息               │
└────────────────────────────────────┘
```

新电脑"一键搬家" = 装插件 → 设置页填仓库+令牌 → 点「拉取并应用」→ 提示重启 → 完成（配置、插件、预设全部到位）。

## 6. 泛用化清单（不绑定本机）

- 无硬编码代理：代理地址在面板配置（git 走 `-c http.proxy=`；webdav 走环境变量或 URL），默认为空
- 无硬编码路径：`~/.dsh` 经 launchEnvironment 解析；profiles 目录枚举；Windows/macOS/Linux 通用（路径统一正斜杠、无 chmod 依赖）
- 无本机命令：不依赖 restart-dsh.bat 之类的本机脚本（只提示用户手动重启）
- 无硬编码后端：git 仓库地址、webdav、本地目录都在面板填
- 跨平台文件权限：POSIX 0600，Windows 用用户目录 ACL（默认私有）
- README 中英双语（market 受众）

## 7. 与 dsh-backup 的差异（优化点）

| 项 | dsh-backup | dsh-simple-sync |
|---|---|---|
| 出口 | 命令 + 模型工具 + 面板（三出口，需 zod） | **仅面板**（零 zod 依赖，src-json 描述符） |
| 传输 | GitHub 同步与备份逻辑耦合 | **transport 抽象**（git/local 两实现，webdav 预留） |
| 粒度 | 整包 tar 归档 | 文件级快照 diff |
| 代码组织 | 单文件 ~1000 行 | 拆分 lib/ops.js、lib/transport/*.js、lib/index.js、lib/client.js |
| 自动化 | 定时备份 | 启动检测 + 手动按钮 |

## 8. 开发阶段

- **P0 骨架**：包结构 + 空 apply + cordis.patch.yml → 本地 profile 安装 → `dsh --profile web --dump-config` 验证加载 → 重启验证 Web 正常
- **P1 核心**：快照生成器 + diff + 应用器（写回 + 自动备份 + pnpm install）
- **P2 传输**：transport 抽象 + git 后端（工作树/token/代理）+ local 后端
- **P3 面板**：Typert 面板服务 + client.js 设置页（表单/按钮/状态）+ 测试连接
- **P4 自动化**：启动检测 + 自动备份逻辑 + 一键搬家文档（中英）
- **P5 测试发布**：
  - 本机模拟双机：临时第二个 profile（或改 DSH_HOME）对同一测试仓库跑 push→pull→apply 全流程（含插件增删、配置覆盖、备份、冲突）
  - webdav 后端：v2 再做（接口已预留，需测试环境）
  - 发布 npm + GitHub（沿用 dsh-quick-toc 流程；**JSON 严禁 BOM**）
  - 市场介绍 PR 到 awesome-dsh-plugin

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 应用配置后 DSH 状态异常 | 写回前自动备份；`--dump-config` 离线预检；保留备份目录可手动回滚 |
| 两机 DSH 版本不同插件不兼容 | 快照记录 DSH 版本，差异过大警告不自动应用 |
| 网络不通/慢（git 后端） | 失败仅报错不破坏本地；git 可配代理，可重试 |
| 自动拉取覆盖本机未推送改动 | 拉取前 diff，有未推送改动先提示 |
| 插件把自己装坏 | 骨架先在本地验证；恢复 = 删 bundle 条目 + 重启（dsh-backup 兜底） |
| 凭据泄露 | 默认不同步凭据；凭证仅存本机私有文件；快照不含凭证 |

## 10. v2 改进方向（2026-08-24 用户提出）

**痛点**：后端 4 个配置字段（repo / token / proxy / branch）每台机器都要在面板手动填一遍。

**方向**：
- **① 快照携带"后端配置建议"**（只含 repo / proxy / branch，**绝不能含 token**）——目标机拉取后自动预填面板表单，用户只需补令牌
- ② 或提供"配置导入/分享"（复制配置串 / 扫码）
- ③ 或简化表单为最少字段 + 更智能默认

**硬约束**：token 是凭据，永远只存本机 state.json（0600），不进快照、不进同步内容。
| 凭据泄露 | 默认不同步凭据；凭证仅存本机私有文件；快照不含凭证 |
