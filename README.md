# DeepSeek Harness Launcher (DSHL)

DeepSeek Harness 的一键启动器：**免安装 Node.js、免下载源码、不打开浏览器**，
双击即用，DSH Web UI 以 Electron 原生窗口呈现。

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

## 用户数据目录

默认位于**程序目录内**的 `.dsh\`（DSH_HOME）；Electron 自身数据（缓存等）位于
程序目录内 `.launcher\`，均不写入系统 AppData，整体移动/复制程序目录即带走全部数据：

- `profiles\`   profile 配置（web / headless）
- `settings.yaml`  模型 API Key 等设置
- `sessions\`   会话记录
- `attachments\` 附件
- `logs\`       启动日志

首次启动会弹出数据目录指引与移动目录说明；也可通过托盘菜单
「数据目录说明…」/「移动目录说明…」随时查看。迁移：退出后复制整个 `.dsh` 目录即可。
旧版本（`data\` / 系统 AppData）数据会在首次启动时自动迁移到新位置。

### 移动整个程序目录

跨盘移动（如把解压目录从 E 盘复制到 D 盘）时，Windows 资源管理器可能卡死：
`.dsh\profiles\node_modules` 是 dsh 自动维护的**链接树**（不含用户数据，删除后
下次启动自动重建），资源管理器会跟随这些链接反复复制 `resources\dsh` 的内容。
正确做法（任选其一）：

0. **双击程序目录内的 `clean-links.bat`**——自动删除链接树，删完即可安全移动（最省事，v0.1.2 起随程序自带）；
1. 移动前先删除 `.dsh\profiles\node_modules`（推荐，启动时自动重建）；
2. 同一盘符内剪切移动（纯改名，瞬间完成）；
3. 命令行复制：`robocopy "源目录" "目标目录" /E /SL /XJ /R:1 /W:1`。

移动后首次启动，启动器会自动重建全部链接（v0.1.1 起）。

## 构建（需要装有 Node.js 的机器，一次性）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

产物（`build\dist\`）：

| 产物 | 说明 | 启动速度 |
|---|---|---|
| `DSHL Setup 0.1.1.exe` | NSIS 安装包（推荐装机） | 安装后秒启动 |
| `DSHL-0.1.1-green.exe` | 绿色自解压单文件（推荐免安装） | 首次约 1 分钟，之后秒启动 |
| `DSHL-0.1.1-win.zip` | 绿色目录版 | 解压一次后秒启动 |

端到端产物无需 Node、无需浏览器；最终用户双击即可。打包体积约 180-250MB
（Electron 运行时 + 便携 Node + dsh 依赖闭包，属预期）。

### 绿色版（green.exe）自解压机制

`green.exe` = [C# stub] + [win-unpacked zip 载荷]，双击后：

- **首次运行**：弹出解压进度窗口，把完整运行时自解压到 exe 旁的
  `DSHL\` 子目录（约 1 分钟），随后自动启动应用；
  用户数据保存在该子目录的 `.dsh\` 下，持久保存。
- **之后运行**：检测到已解压 → 直接启动（秒开），不再解压。
- 复制 `green.exe` 到其他位置/机器首次运行时会就地重新解压，天然便携。
- **移动整个解压目录**：支持整体剪切/移动；若用「复制」方式移动，复制工具会把
  dsh 宿主维护的 `.dsh\profiles\node_modules\` 链接展开成真实目录，导致宿主报
  `exists and is not a symlink`——启动器会在启动宿主前自动清理这些残留并重建链接
  （0.1.1 起），无需手工删除。
- 实现：`scripts\green-stub.cs`（csc 编译，零外部依赖，已处理长路径）。

### 托盘与关闭行为

- **一体化现代窗口**：无边框 + **透明窗口圆角**（`transparent` + body 24px 圆角卡片，
  四角透出桌面）。透明合成依赖系统 DWM；在远程桌面/虚拟化等禁用 DWM 合成的环境中
  自动退化为直角（页面仍为无边框现代样式，无残留色）。
- 程序窗口保持简洁：**无窗口菜单栏**，所有操作入口都在**托盘图标右键菜单**中
  （显示/隐藏、连接远程服务…、返回本地服务、重连远程服务、复制服务地址、
  打开数据目录、打开日志目录、数据目录说明…、关于、退出）。
- **单击托盘图标：切换主窗口显示/隐藏**；关闭窗口（X）默认最小化到托盘，
  宿主与对话保持运行。真正退出请用托盘菜单「退出」。
- 数据目录说明、连接远程服务等弹窗**对齐 DSH 内置弹窗风格**（参照 DSH 源码
  `ui-settings-models` 的 OnboardingModal：24px 圆角卡片、深色主按钮
  `rgb(15,17,21)`、右上角关闭按钮、主窗口半透明遮罩），同为透明圆角窗口。
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

### 远程连接（远程对话开发）

启动器可以不启动本地宿主，直接连接远程的 DSH 服务进行远程对话开发。
三种方式（优先级：菜单/对话框 > 命令行 > 配置文件）：

1. **界面手动输入**（最常用）：菜单「文件 → 连接远程服务…」或快捷键
   `Ctrl+L`，在弹出的对话框中输入远程地址（如 `http://192.168.1.100:8080`）
   点击连接；连接失败时窗口内显示错误页（含错误码与重试按钮）。
   连接远程后本地宿主仍在后台运行，菜单「返回本地服务」可随时切回。
2. **命令行参数**：`DSHL.exe --remote http://192.168.1.100:8080`
3. **配置文件**：`.dsh\launcher.json` 加 `remoteUrl`：
   ```json
   { "remoteUrl": "http://192.168.1.100:8080" }
   ```

配置 `remoteUrl` 后启动器直接加载该地址（窗口标题显示远程地址），
不再启动本地宿主。远程不可达时窗口内显示错误页，也可用
「帮助 → 重新连接远程服务」重连。

**远程部署前提**：DSH 宿主默认只监听 `127.0.0.1`（CLI 有意拒绝
`--host 0.0.0.0`，防远程代码执行）。远程访问请用 SSH 隧道或内网穿透
把远程端口映射到本地，例如远程机器上 `dsh web --port 8080`，本地
`ssh -L 8080:127.0.0.1:8080 user@remote`，然后启动器连接
`http://127.0.0.1:8080`。

**自签 https 证书**：远程用自签证书时，需在 `launcher.json` 显式开启
`"insecure": true` 才会忽略证书错误（默认关闭，仅内网可信环境使用）。

### 使用建议

- **免安装绿色用户**：首选 `green.exe`（单文件、就地自解压）或 zip 版；
  重装系统只需复制解压目录即可迁移数据。
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
- **品牌补丁（中文文案定制）**：装完 dsh 闭包后，构建自动重打两处内置文案——
  设置窗口 “Agent 预设” → “Agent”、“PTC 模式” → “代码模式”
  （`build.ps1` 第 2.5 步，幂等，重复构建自动跳过）。dsh 升级会重置这些文件；
  若新版文案变动导致补丁找不到目标字符串，构建会打印黄色跳过提示，
  需同步更新 `build.ps1` 中的替换对。

### 冒烟验证结论（本机已实测）

- `win-unpacked` / zip 版完整启动：宿主进程、随机端口监听、前端 HTTP 200、
  Electron 窗口与宿主实时 WebSocket 连接、数据目录自动初始化全部通过；
  关闭窗口后宿主进程随之退出。
- **green.exe 首次运行**：进度窗口 → 自解压 35049 个文件到 exe 旁子目录 →
  自动启动应用（窗口 + 宿主 + 数据目录），全程约 1 分钟。
- **green.exe 再次运行**：跳过解压直接启动，15 秒内出窗口。
- **Setup 安装版**：静默安装成功，完整运行时（node + dsh 闭包）就位。
- 已知环境限制：本机安全软件导致 powershell.exe 5.1 在 stdout 重定向时退出
  崩溃（0xC0000005），已通过构建补丁（electron-builder 收集器改用 pwsh.exe）
  规避；不影响产物。

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
