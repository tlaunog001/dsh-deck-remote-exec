# dsh-deck-remote-exec

让 [dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) 在
[dsh-remote](https://github.com/flymysql/dsh-remote) 的**远端工作区**里正常工作。

## 解决的问题

远端会话的 cwd 是本地镜像（`~/.dsh/remote-workspaces/<host-user-port>/<name>`），不是远端目录。
deck 所有 I/O 都走 `ctx.get('fs')` 和 `ctx.get('subprocess')` —— 那是**宿主**的能力：

| 症状 | 原因 |
| --- | --- |
| deck 报「尚未初始化」，看不到远端 `.scratch` | 读的是镜像副本，镜像里没有 |
| 面板显示「已找到 gh: /Users/.../gh」（宿主路径） | `resolveExecutable` 查的是宿主 |
| 环境检查报「读不到本地仓库信息」 | git 在宿主跑，宿主没有那个目录 |
| setup 技能把配置写进镜像而非远端 | 写入落在副本上，且 `autoPush` 默认关闭 |

## 做法

**不改 dsh-remote 一个字节。** 本插件做两件事：

### 1. 提供两个服务

复用 dsh-remote 已有的能力（绝对路径动态 import，绕过 `exports` 限制）：

| 本插件提供 | 复用的 dsh-remote 模块 |
| --- | --- |
| `ctx.remoteFs` | `lib/binding.js` 的 `resolveMirror`（镜像识别，纯函数） |
| `ctx.remoteExec` | `lib/openssh.js` 的 `SystemOpenSshPool`（连接池） |
| 路径翻译 | `lib/paths.js`（同一套语义） |

`remoteFs` / `remoteExec` 都按路径路由：
- 落在**镜像内** → 走远端
- 落在**远端路径**（如 `/mnt/data/x`，远端命令的返回值）→ 反查镜像后走远端
- 其余 → 返回 null，调用方回退本地

### 2. 把 deck 的取服务函数改道

deck 内部用 `ctx.get('fs')` 拿核心单例，外部插件无法替换（cordis 的 `provide` 不覆盖已注册服务）。
所以改为在 deck 的构建产物里做**幂等 upsert**，改三处：

| 文件 | 改动 |
| --- | --- |
| `lib/index.js` | `fs` 代理；`detectionExec` / `execProc` 远端优先 |
| `lib/platform/index.js` | `resolveExecutable(name, opts)` 远端优先 |

锚点不依赖行号，目标包升级后每次启动重新检查。

## 安装

```bash
dsh plugin --profile desktop add /path/to/dsh-deck-remote-exec
```

或手工软链到 profile 的 `node_modules` 并在 `package.json` 的 `dsh.profile.bundles` 里加一行。

需要 `dsh-remote`（peer，可选：未安装时本插件不注册服务，deck 按本地工作）。

## 验证过的行为

真实远端（`192.168.10.201`，`/mnt/data/AI_Devops`）：

```
路径识别    镜像 true | 远端 /mnt/data/AI_Devops true | 宿主 false
git remote  0  "https://github.com/tlaunog001/AI_Devops.git"
gh 路径     /home/jx/.local/bin/gh          ← 远端，不是宿主
fs 读取     3731 字节（docs/agents/issue-tracker.md）
```

## 边界

- 只处理 fs 与 exec；端口转发、终端等仍归 dsh-remote 的 `rw_*` 工具
- 改的是 deck 的构建产物：deck 升级会覆盖，本插件下次启动自愈
- 远端需要装好 `gh` 等工具；本插件只负责在远端执行，不负责安装

## 许可

MIT
