# Windows 上怎么跑（runbook）

> **给谁看**：在一台 Windows 机器上跑 abx 的人——主要就是**使用者自己**
> （Windows 是他的日常测试平台，见 [`../overview/platforms.md`](../overview/platforms.md) §0），
> 以及将来在这台机器上查故障的人。
>
> **本文只写「怎么做、坏了怎么办」。** 为什么按平台分叉成那样写在
> [`../overview/platforms.md`](../overview/platforms.md)；某个结论到底验没验过写在
> 那一篇的 §5 与 [`../../roadmap.md`](../../roadmap.md) §四。**两处都不在本文重复。**

---

## 0. 一句话：Windows 上现在能跑到哪一步

| 能做的 | 还不能的 |
|---|---|
| `pnpm install` / `lint` / `typecheck` / `test` / `build` 全绿（CI 上有一个真 `windows-latest` job 在跑这五条） | **没有在 Windows 上起过真容器**（`abx open` 端到端没验过） |
| `pnpm release:win` 打出 `nsis` 安装包与 `portable` 单文件 | 安装包**没装过、没双击过**；**没有签名**，第一次运行会弹 SmartScreen |
| 托盘应用能起来、能加载面板（`pnpm --filter @abx/app dev`） | 托盘图标**长什么样**没人看过（跑 CI 的机器没有桌面） |

**别把左列当成「Windows 已支持」。** 右列还空着的时候，Windows 是
「代码层面站得住、日常开发链路可用」，不是「装上去就能用」。

---

## 1. 前置条件

| 需要 | 版本 / 说明 |
|---|---|
| Node | **≥ 24**（`package.json` 的 `engines`；低于这个版本 `pnpm install` 会拒绝） |
| pnpm | `12.14.0`（`packageManager` 字段，corepack 会自己取这个版本）。**不要用 npm / yarn** |
| Git | 任意近期版本。`core.autocrlf` 用默认值就行——仓库里没有靠行尾字节做判断的东西 |
| Docker Desktop | 只有走 docker 后端才需要。**装完必须重开终端**，理由见 §4.1 |

`pnpm install` 的 `prepare` 会把 `core.hooksPath` 指到 `.githooks/`、把
`commit.template` 指到 `.gitmessage`。这一步在 Windows 上也跑得通；
提交信息不合规会被 `commit-msg` 钩子拒掉（钩子是 Node 写的，不依赖 bash）。

---

## 2. 日常三条命令

```powershell
pnpm install
pnpm lint; pnpm typecheck; pnpm test    # 提交前这三样都要绿
pnpm build                              # 四个包都出产物
```

想跑托盘应用（需要有桌面会话，不能在纯 SSH 里跑）：

```powershell
pnpm --filter @abx/app dev
```

面板的渲染验证入口 `pnpm --filter @abx/app verify:linux` **是 Linux 专用的**
（它靠 Xvfb + X11 截图），Windows 上不要用它。

---

## 3. 打包

```powershell
pnpm release:win
```

产物在 `apps/app/release/`：

| 文件 | 是什么 |
|---|---|
| `ABX Setup <版本>.exe` | NSIS 安装包。`perMachine: false`（装到当前用户）、可选安装目录、**不建桌面快捷方式** |
| `ABX <版本>.exe` | portable 单文件，双击即用，不写注册表 |
| `win-unpacked/` | 解包目录，排障时直接跑里面的 `abx.exe` 最省事 |

**没有签名**（`electron-builder.config.cjs` 里 `forceCodeSigning: false`）。
所以第一次运行一定会在 SmartScreen 上停下来说「已保护你的电脑」——
这是这一版没有代码签名证书的结果，不是打包配错了。点「更多信息 → 仍要运行」。
**本文不建议任何人关掉 SmartScreen**：那台机器上的其他软件也会跟着失去这层保护。

CI 上同一条链路在 `package-windows.yml`（`windows-latest`，靠 push 到 `main`
或手动 `workflow_dispatch` 触发）。它会额外对**真实产物**断言：两个 exe 都在、
PE 头是 PE32+（`0x20b`）且子系统是 `2`（GUI，不是控制台）、
`win-unpacked/resources/app.asar` 里的图标清单里有 `icon-win.ico`。

---

## 4. 常见故障

### 4.1 「找不到 docker」

Windows 上的原话是：

```
找不到 docker：按 PATH 找过，也按 PATHEXT 试过 .exe / .cmd，都没有。
要么 Docker Desktop 还没装，要么装完之后**没重开终端**（PATH 是启动时读的）——重开一个再试。
```

**先重开终端，再怀疑安装。** 这是这条路上最常见的一步：Docker Desktop 装完会把
`C:\Program Files\Docker\Docker\resources\bin` 加进 PATH，而**进程的 PATH 是启动那一刻
读的**——已经开着的终端、已经开着的编辑器、已经开着的托盘应用，看到的都还是旧的那份。

重开之后确认：

```powershell
docker version           # 客户端与服务端**两个**版本号都要打印出来
docker run --rm hello-world
```

只看得到客户端版本 = 守护进程没起，那就是 Docker Desktop 自己没启动，
跟 abx 无关（`pnpm test` 里有对应的一条：`probeDocker` 判的正是
`docker version --format {{.Server.Version}}`，不是 `docker --version`）。

### 4.2 「舱面起不来」/ `EADDRNOTAVAIL`

如果报错里出现某个 IP 绑不上，看 [`../overview/platforms.md`](../overview/platforms.md) §1.1：
**「绑哪张网卡」与「告诉舱内哪个地址」是两个问题**。Windows 上跑的是 Docker Desktop
（WSL2 或 Hyper-V 后端），宿主上**没有** `172.17.0.1` 这张网卡。

现阶段的处理：配置里 `broker.cellHost` 写成 `host.docker.internal`，
或者起会话时用 `--cell-host`。绑定那一侧已经会按候选顺序退到 `0.0.0.0`，
并在日志里说明「舱面实际绑在 X，告诉舱内的是 Y，两者不是一回事」。

### 4.3 路径相关的报错

Windows 上有**两种**路径，报错里说清是哪一种很要紧：

| 形状 | 是什么 | 谁判 |
|---|---|---|
| `C:\Users\dev\...`、`\\server\share\...` | **宿主**路径。盘根、`C:\Windows`、`Program Files`、`ProgramData`、UNC、备用数据流（`file.txt:stream`）都在禁挂规则里 | 按 `win32` 那套规则判 |
| `/home/node/.claude/settings.json`、`/shared/notes` | **舱内**路径。永远是 Linux 形状，**跟宿主是不是 Windows 无关** | 按 POSIX 判 |

所以「`C:\...` 被拒了」和「`/home/dev/...` 在宿主机上被当成相对路径」是两类不同的问题，
不要混着看。

### 4.4 测试里的超时

`packages/core/source/commands/doctor.test.ts` 那一组**不是纯函数**：它会真的去找
可执行文件、起 docker 客户端、试绑端口。Windows runner 上起一次进程更贵，
所以那个文件把超时设成了 30 秒（默认 5 秒会在真 runner 上超时——第一次跑就是这么红的）。
**升的是超时，不是断言**；如果它在本地也超时，那是机器真的卡住了，不是这一条松了。

---

## 5. 在这台机器上验到什么算数

跑完这几条，把**原话**记下来（不要记「通过了」）：

```powershell
node -v
pnpm -v
docker version
pnpm lint; pnpm typecheck; pnpm test
pnpm build
```

蓝色那几行（`Tests  827 passed` 之类）就是证据。**没有原话的结论不算结论**——
这是 [`docker-verification.md`](./docker-verification.md) §0 的写法要求，本文照它办。

CI 上的对应证据在 `ci.yml` 的 `Windows` job 里；因为那条 job 由 push 触发，
所以「推上去了」和「CI 绿了」是两件事，**要分别确认**。

---

## 6. 明确没验的

不重复 [`../overview/platforms.md`](../overview/platforms.md) §5.4 那份总表，只列
**在 Windows 上跑一次就能补上**的那几条：

| 项 | 怎么补 |
|---|---|
| 托盘图标在 Windows 上**长什么样** | 在真机上看托盘区（`icon-win.ico` 的多档尺寸是按 Electron 的要求生成的，不是按观感挑的） |
| 面板落在哪（任务栏在四条边时各一次） | 真机上点托盘图标；几何计算本身已有单测 |
| `nsis` 装起来什么样、portable 双击能不能用 | 各跑一次 |
| `abx open` 能不能真的起容器 | 需要 Docker Desktop 起着；目前**一次都没跑过** |
| `drop-files` 在 Windows 上的替代路径 | 该事件是 macOS only；面板内的 HTML5 拖放是主要入口，真机上点一次 |
