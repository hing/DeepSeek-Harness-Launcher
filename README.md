# DeepSeek Harness Launcher (DSHL)

DeepSeek Harness 的一键启动器：**免安装 Node.js、免下载源码、不打开浏览器**，
双击即用，DSH Web UI 以 Electron 原生窗口呈现。

## 特色功能

- **极简即用**：捆绑便携版 Node.js 与 `@deepseek-ai/dsh` 依赖闭包，最终用户无需安装任何运行时或浏览器，双击即用。
- **真正的绿色便携**：所有数据（用户数据、会话、Electron 缓存）都保存在程序目录内，不写入系统 AppData，整个程序目录就是一个可移动的完整单元。
- **一键备份迁移**：内置「程序备份迁移」向导，自动完成迁移准备，跨盘移动/复制程序目录不再卡死。
- **远程连接**：可不启动本地宿主，直接连接远程 DSH 服务，支持远程对话开发；本地/远程随时切换。
- **原生窗口体验**：一体化无边框窗口 + 系统托盘，关闭窗口最小化到托盘、宿主与对话保持运行。

## 架构

```
┌─────────────────────────────────────────────┐
│ Electron 窗口壳（app\main.js）              │
│   ├─ 启动捆绑的 dsh 宿主（独立 Node 进程）   │
│   ├─ 解析 "dsh web: http://127.0.0.1:<port>" │
│   └─ BrowserWindow 加载该 URL（非浏览器）     │
├─────────────────────────────────────────────┤
│ build\node\   便携版 Node.js（官方二进制）    │
│ build\dsh\    npm 安装的 @deepseek-ai/dsh 闭包│
│               （含前端 dist、原生 addon 预编译）│
└─────────────────────────────────────────────┘
```

Electron 只做窗口壳：DSH 宿主运行在捆绑的官方 Node 进程中，
规避 Electron 专用 Node ABI 与 `node-addon-require-builtin` / `koffi`
原生模块的兼容问题，Node 版本完全可控（要求 ≥ 22.19 或 ≥ 24）。

## 便携特性

### 数据都在程序目录内

程序运行产生的所有数据都保存在**程序目录内**，不写入系统 AppData：

| 目录 | 内容 |
|---|---|
| `.dsh\` | DSH 内核数据：API Key、会话记录、插件、附件、profile 配置、启动日志 |
| `.launcher\` | 启动器 Electron 自身数据：缓存、Local Storage 等 |

因此**整个程序目录就是一个完整单元**：复制/移动目录即带走全部数据，无需任何导出导入操作。重装系统、换电脑、U 盘携带，复制即用。

### 程序备份迁移

由于程序在运行时会在 `.dsh\profiles\node_modules` 维护一套指向安装目录的受管链接树，
**直接移动/复制程序目录会导致资源管理器跟随链接反复复制而卡死**。为此内置了一键迁移：

托盘菜单「**程序备份迁移…**」→ 点「**清除受管链接树并退出**」→ 程序自动停止服务、
清除受管链接树并退出 → 手动移动/复制整个程序目录 → 重新启动自动重建链接树。

用户数据与 Electron 数据均随目录完好迁移，不会丢失。若自动清除失败，
可退出程序后运行 `.clean-links.bat`，或手动删除 `.dsh\profiles\node_modules` 目录后再迁移。

## 远程连接（远程对话开发）

启动器可以**不启动本地宿主**，直接连接远程的 DSH 服务，用于远程对话开发。
三种方式（优先级：托盘菜单/对话框 > 命令行 > 配置文件）：

1. **界面输入**（最常用）：托盘菜单「连接远程服务…」或快捷键 `Ctrl+L`，
   在弹出的对话框中输入远程地址（如 `http://192.168.1.100:8080`）点击连接；
   连接失败时窗口内显示错误页（含错误码与重试按钮）。
   连接远程后本地宿主仍在后台运行，托盘菜单「返回本地服务」可随时切回。
2. **命令行参数**：`DSHL.exe --remote http://192.168.1.100:8080`
3. **配置文件**：`.dsh\launcher.json` 加 `remoteUrl`：
   ```json
   { "remoteUrl": "http://192.168.1.100:8080" }
   ```

配置 `remoteUrl` 后启动器直接加载该地址（窗口标题显示远程地址），
不再启动本地宿主；远程不可达时窗口内显示错误页，也可用「重连远程服务」重连。

**远程部署前提**：DSH 宿主默认只监听 `127.0.0.1`（CLI 有意拒绝
`--host 0.0.0.0`，防远程代码执行）。远程访问请用 SSH 隧道或内网穿透
把远程端口映射到本地，例如远程机器上 `dsh web --port 8080`，本地
`ssh -L 8080:127.0.0.1:8080 user@remote`，然后启动器连接 `http://127.0.0.1:8080`。

**自签 https 证书**：远程用自签证书时，需在 `launcher.json` 显式开启
`"insecure": true` 才会忽略证书错误（默认关闭，仅内网可信环境使用）。

## 构建（需要装有 Node.js 的机器，一次性）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

产物（`build\dist\`）：

| 产物 | 说明 | 启动速度 |
|---|---|---|
| `DSHL Setup 0.1.5.exe` | NSIS 安装包（推荐装机） | 安装后秒启动 |
| `DSHL-0.1.5-green.exe` | 绿色自解压单文件（推荐免安装） | 首次约 1 分钟，之后秒启动 |
| `DSHL-0.1.5-win.zip` | 绿色目录版 | 解压一次后秒启动 |

端到端产物无需 Node、无需浏览器；最终用户双击即可。打包体积约 180-250MB
（Electron 运行时 + 便携 Node + dsh 依赖闭包，属预期）。

### 绿色版（green.exe）自解压机制

`green.exe` = [C# stub] + [win-unpacked zip 载荷]，双击后：

- **首次运行**：弹出解压进度窗口，把完整运行时自解压到 exe 旁的
  `DSHL\` 子目录（约 1 分钟），随后自动启动应用；
  用户数据保存在该子目录的 `.dsh\` 下，持久保存。
- **之后运行**：检测到已解压 → 直接启动（秒开），不再解压。
- 复制 `green.exe` 到其他位置/机器首次运行时会就地重新解压，天然便携。
- 实现：`scripts\green-stub.cs`（csc 编译，零外部依赖，已处理长路径）。

### 托盘与关闭行为

- **一体化现代窗口**：无边框 + **透明窗口圆角**（`transparent` + body 24px 圆角卡片，
  四角透出桌面）。透明合成依赖系统 DWM；在远程桌面/虚拟化等禁用 DWM 合成的环境中
  自动退化为直角（页面仍为无边框现代样式，无残留色）。
- 程序窗口保持简洁：**无窗口菜单栏**，所有操作入口都在**托盘图标右键菜单**中
  （显示/隐藏、连接远程服务…、返回本地服务、重连远程服务、复制服务地址、
  打开数据目录、打开日志目录、数据目录说明…、程序备份迁移…、关于、退出）。
- **单击托盘图标：切换主窗口显示/隐藏**；关闭窗口（X）默认最小化到托盘，
  宿主与对话保持运行。真正退出请用托盘菜单「退出」。
- 窗口内快捷键：`Ctrl+L` 连接远程服务、`Ctrl+Q` 退出（不依赖菜单栏）。
- 如需关闭窗口直接退出，在 `.dsh\launcher.json` 配置：
  ```json
  { "closeToTray": false }
  ```

### 端口配置

默认自动选用空闲端口；窗口标题会实时显示当前服务地址（如
`DeepSeek Harness · http://127.0.0.1:8080`）。固定端口两种方式：

1. **配置文件**：在用户数据目录（`.dsh\`）下创建 `launcher.json`：
   ```json
   { "port": 8080 }
   ```
2. **命令行参数**（优先级更高）：`DSHL.exe --port 8080`
   （绿色版 green.exe 会透传参数，同样可用）

端口冲突时应用会启动失败并弹出错误提示；删除配置或改用其他端口即可。

### 使用建议

- **免安装绿色用户**：首选 `green.exe`（单文件、就地自解压）或 zip 版；
  重装系统/换电脑只需复制整个程序目录即可迁移数据。
- **正式装机**：用 Setup 安装版。
- 首次使用在 DSH 自带引导中配置 DeepSeek API Key。

### 构建已知要点

- **Node 下载**：国内网络 nodejs.org/GitHub 不可达时自动回退 npmmirror 镜像；
  Electron 与 electron-builder 工具链也通过 `ELECTRON_MIRROR` /
  `ELECTRON_BUILDER_BINARIES_MIRROR` 走 npmmirror。
- **npm 11 allow-scripts**：会拦截 koffi / node-pty / dsh-subprocess-local 等
  包的 install 脚本导致原生预编译二进制缺失；构建脚本会 `approve-scripts --all`
  并 `rebuild` 这些包。
- **electron-builder extraResources 过滤 node_modules**：extraResources 不会
  复制 node_modules，依赖 `afterPack` 钩子（`app\scripts\after-pack.js`）在打包
  app 之后、组装 portable/NSIS 之前把 `build\node`、`build\dsh` 完整复制进
  `resources\`。
- **powershell.exe 5.1 退出崩溃补丁**：部分机器上（安全软件 hook）powershell.exe
  在 stdout 重定向时以 0xC0000005 崩溃，electron-builder 的模块收集器恰好用
  `powershell.exe -EncodedCommand` 包装 npm list；构建脚本会把收集器改为
  `pwsh.exe`（PowerShell 7，需已安装）。

### 冒烟验证结论（本机已实测）

- `win-unpacked` / zip 版完整启动：宿主进程、随机端口监听、前端 HTTP 200、
  Electron 窗口与宿主实时 WebSocket 连接、数据目录自动初始化全部通过。
- **green.exe 首次运行**：进度窗口 → 自解压到 exe 旁子目录 → 自动启动应用，
  全程约 1 分钟。
- **green.exe 再次运行**：跳过解压直接启动，15 秒内出窗口。
- **Setup 安装版**：静默安装成功，完整运行时（node + dsh 闭包）就位。

## 开发调试

```powershell
# 先准备宿主运行时（Node + dsh 闭包）
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -SkipPack
# 然后以开发模式跑 Electron
cd app; npm install; npm start
```

## 注意事项

- DeepSeek Harness 是开发者预览版（0.1.0-rc），官方明示存在兼容性破坏变更；
  重新构建时应跟随 npm 上的最新发布（`npm view @deepseek-ai/dsh version`）。
- 首次使用需在「设置 → Models」填写 DeepSeek API Key（DSH 自带引导）。
- 用户数据目录若位于 Program Files 等受保护位置，需以管理员权限运行。
