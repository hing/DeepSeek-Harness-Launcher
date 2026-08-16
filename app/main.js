/**
 * DeepSeek Harness Launcher (DSHL) — Electron 主进程。
 *
 * 架构：Electron 只做窗口壳。DSH 宿主（dsh web）跑在捆绑的官方 Node 进程里，
 * 监听 127.0.0.1 端口（默认自动选空闲端口，可用 --port 参数或
 * .dsh\launcher.json 固定）；本进程解析宿主打印的 `dsh web: <url>` 就绪行，
 * 然后用 BrowserWindow 加载该 URL，窗口标题显示当前服务地址。
 *
 * 用户数据目录默认位于程序目录下的 `.dsh\`（即开即用、绿色便携）；
 * Electron 自身数据（缓存等）位于程序目录下 `.launcher\`，不写系统 AppData；
 * 首次启动弹出数据目录指引对话框。
 */'use strict'

const { app, BrowserWindow, Menu, dialog, shell, clipboard, ipcMain, Tray, nativeImage } = require('electron')
const { spawn, execFile } = require('node:child_process')
const { join, dirname } = require('node:path')
const { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, lstatSync, rmSync } = require('node:fs')

// ---------------------------------------------------------------- 路径解析

const isPackaged = app.isPackaged
// 开发模式（npm start）时，宿主运行时位于仓库根目录 build\ 下
const devRoot = join(__dirname, '..')
const nodeDir = isPackaged ? join(process.resourcesPath, 'node') : join(devRoot, 'build', 'node')
const dshDir = isPackaged ? join(process.resourcesPath, 'dsh') : join(devRoot, 'build', 'dsh')
// 程序目录：打包后是 exe 所在目录（绿色便携/安装目录），开发模式是仓库根目录。
// 注意 electron-builder 的 portable 单文件目标运行时会把 exe 解压到临时目录执行，
// 此时 process.execPath 指向临时目录，必须用 PORTABLE_EXECUTABLE_DIR 取真实位置。
const programDir = isPackaged
  ? (process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.execPath))
  : devRoot
// 用户数据目录：程序目录内 `.dsh`（即开即用、绿色便携）。
const dataDir = join(programDir, '.dsh')
const launcherDataDir = join(programDir, '.launcher')
const logDir = join(dataDir, 'logs')
const nodeExe = join(nodeDir, 'node.exe')
const dshBin = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const firstRunMarker = join(dataDir, '.first-run-done')

// Electron 用户数据（缓存、Local Storage 等）从系统 AppData 改到程序目录内 .launcher，
// 保持绿色便携（程序目录整体移动/复制即带走全部数据）。必须在 ready 前设置。
app.setPath('userData', launcherDataDir)

// ---------------------------------------------------------------- 配置解析

/** 从命令行参数解析 `--port <n>` / `--port=<n>`（打包后 argv[0]=exe，参数从 argv[1] 起）。 */
function parseCliPort() {
  const args = process.argv.slice(1)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port' && i + 1 < args.length) return Number(args[i + 1])
    if (a.startsWith('--port=')) return Number(a.slice('--port='.length))
  }
  return undefined
}

/** 读取用户数据目录下的 launcher.json 配置（目前支持 `port` / `remoteUrl` / `insecure` / `closeToTray`）。 */
function readLauncherConfig() {
  try {
    const raw = readFileSync(join(dataDir, 'launcher.json'), 'utf8')
    const cfg = JSON.parse(raw)
    if (typeof cfg === 'object' && cfg !== null) return cfg
  } catch { /* 文件缺失或格式错误时使用默认值 */ }
  return {}
}

/**
 * 解析监听端口：命令行 `--port` > `.dsh\launcher.json` 的 `port` > 0（OS 自动选空闲端口）。
 * @returns {number} 1-65535 的有效端口，或 0 表示自动。
 */
function resolvePort() {
  const fromCli = parseCliPort()
  const fromFile = readLauncherConfig().port
  for (const candidate of [fromCli, fromFile]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) {
      return candidate
    }
  }
  return 0
}

/** 从命令行参数解析 `--remote <url>` / `--remote=<url>`。 */
function parseCliRemote() {
  const args = process.argv.slice(1)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--remote' && i + 1 < args.length) return args[i + 1]
    if (a.startsWith('--remote=')) return a.slice('--remote='.length)
  }
  return undefined
}

/** 规范化远程地址：仅接受 http/https，允许省略协议自动补 http://，去尾部斜杠。 */
function normalizeRemoteUrl(raw) {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim().replace(/\/+$/, '')
  if (s === '') return undefined
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w.-]+(:\d{1,5})?([\/?#].*)?$/.test(s) && !s.includes(' ')) return `http://${s}`
  return undefined
}

/**
 * 解析远程连接目标：命令行 `--remote` > `.dsh\launcher.json` 的 `remoteUrl`。
 * @returns {{ url: string, insecure: boolean } | undefined} 配置了远程地址时返回目标，否则 undefined（本地模式）。
 */
function resolveRemote() {
  const cfg = readLauncherConfig()
  const candidate = parseCliRemote() !== undefined ? parseCliRemote() : cfg.remoteUrl
  if (candidate === undefined || candidate === '') return undefined
  const url = normalizeRemoteUrl(candidate)
  if (url === undefined) {
    console.warn(`[dshl] 忽略无效的远程地址: ${JSON.stringify(candidate)}`)
    return undefined
  }
  return { url, insecure: cfg.insecure === true }
}

// 远程模式配置在模块顶层解析一次（证书开关必须在任何网络请求前生效）
const remoteTarget = resolveRemote()
let remoteMode = false
if (remoteTarget !== undefined && remoteTarget.insecure) {
  // 用户显式配置 insecure:true 时忽略证书错误（自签 https 内网场景），默认关闭
  app.commandLine.appendSwitch('ignore-certificate-errors')
}

// 关闭窗口行为：默认最小化到托盘（launcher.json 配 "closeToTray": false 可改为直接退出）
const closeToTray = readLauncherConfig().closeToTray !== false
/** 真正退出标志：托盘/菜单退出时置位，窗口 close 不再拦截。 */
let isQuitting = false
let tray = null

// ---------------------------------------------------------------- 远程连接（运行时切换）

/** 「连接远程服务」输入对话框的 HTML（内嵌；按 DSH「添加 API Key」弹窗（DeepSeekOnboardingDialog + ProviderEditor）精确复刻）。 */
/**
 * 「连接远程服务」对话框（注入到主窗口页面的 DOM 覆盖层）。
 * 按 DSH「添加 API Key」弹窗（DeepSeekOnboardingDialog + ProviderEditor）精确复刻：
 * mask rgba(0,0,0,0.24)+blur、24px 圆角卡片、标题 20px/28px/500、32px 输入框、36px 胶囊按钮。
 * 覆盖层渲染在页面内，圆角由 CSS 原生绘制（无窗口合成，天然平滑无锯齿）。
 */
const REMOTE_FORM_HTML = `<div id="dshl-remote-overlay">
<style>
#dshl-remote-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex;
  align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(2px); font: 14px/22px "Segoe UI", system-ui, sans-serif; color: #0f1115; }
#dshl-remote-overlay .dshl-card { width: 480px; max-width: calc(100vw - 48px); box-sizing: border-box;
  padding: 28px; background: #ffffff; border-radius: 24px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18); }
#dshl-remote-overlay .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#dshl-remote-overlay .title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; color: #0f1115; }
#dshl-remote-overlay .body { margin-top: 20px; }
#dshl-remote-overlay .description { margin: 0; font-size: 14px; line-height: 24px; color: #61666b; }
#dshl-remote-overlay .editor { margin-top: 24px; display: flex; flex-direction: column; gap: 12px; }
#dshl-remote-overlay .field { display: flex; flex-direction: column; gap: 6px; }
#dshl-remote-overlay .fieldLabel { font-size: 12px; line-height: 18px; font-weight: 500; color: #61666b; }
#dshl-remote-overlay input { width: 100%; box-sizing: border-box; height: 32px; padding: 0 10px;
  border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 8px; background: #ffffff;
  color: #0f1115; font-size: 14px; line-height: 22px; outline: none; }
#dshl-remote-overlay input:focus { border-color: #0f1115; }
#dshl-remote-overlay input::placeholder { color: #e1e5ee; }
#dshl-remote-overlay .footer { display: flex; justify-content: flex-end; gap: 8px; }
#dshl-remote-overlay button { box-sizing: border-box; display: inline-flex; align-items: center;
  justify-content: center; height: 36px; padding: 0 14px; border-radius: 18px;
  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
  background: transparent; color: #0f1115; border: 1px solid rgba(0, 0, 0, 0.1); }
#dshl-remote-overlay button:hover { background: rgba(38, 49, 72, 0.06); }
#dshl-remote-overlay button.primary { background: #0f1115; color: #ffffff; border: none; }
#dshl-remote-overlay button.primary:hover { background: #43454a; }
</style>
<div class="dshl-card">
  <div class="head">
    <h2 class="title">连接远程 DSH 服务</h2>
  </div>
  <div class="body">
    <p class="description">输入远程 DSH Web 服务地址，例如 http://192.168.1.100:8080</p>
    <div class="editor">
      <div class="field">
        <span class="fieldLabel">远程地址</span>
        <input id="url" type="text" spellcheck="false" placeholder="http://192.168.1.100:8080">
      </div>
      <div class="footer">
        <button id="cancel">取消</button>
        <button id="connect" class="primary">连接</button>
      </div>
    </div>
  </div>
</div>
</div>`

/**
 * 在主窗口页面就绪后执行注入脚本；未就绪时每 500ms 重试（最多 attempts 次，默认 ~4s）。
 * 覆盖层注入依赖页面 DOM，托盘菜单可能在页面加载完成前被点击。
 */
function injectIntoMain(script, attempts = 8) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.executeJavaScript(script).catch(() => {
    if (attempts > 1 && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => injectIntoMain(script, attempts - 1), 500)
    }
  })
}

/** 打开「连接远程服务」覆盖层（先显示主窗口；已打开则聚焦输入框）。 */
function openRemoteDialog() {
  showMainWindow()
  injectIntoMain(`(() => {
    if (document.getElementById('dshl-remote-overlay')) {
      const i = document.getElementById('url'); if (i) i.focus(); return
    }
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(REMOTE_FORM_HTML)})
    const overlay = document.getElementById('dshl-remote-overlay')
    const urlInput = overlay.querySelector('#url')
    window.dshlRemote.getCurrent().then(v => { if (v) urlInput.value = v })
    const submit = () => window.dshlRemote.submit(urlInput.value)
    overlay.querySelector('#connect').addEventListener('click', submit)
    overlay.querySelector('#cancel').addEventListener('click', () => window.dshlRemote.cancel())
    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit()
      if (e.key === 'Escape') window.dshlRemote.cancel()
    })
    urlInput.focus()
  })()`)
}

/** 关闭「连接远程服务」覆盖层。 */
function closeRemoteOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.executeJavaScript(
    `document.getElementById('dshl-remote-overlay')?.remove()`,
  ).catch(() => {})
}

// ---------------------------------------------------------------- 服务端口设置

/**
 * 「设置服务端口」对话框（注入到主窗口页面的 DOM 覆盖层）。
 * 样式与「连接远程服务」弹窗一致（DSH 风格：mask、24px 圆角卡片、32px 输入框、36px 胶囊按钮）。
 */
const PORT_FORM_HTML = `<div id="dshl-port-overlay">
<style>
#dshl-port-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex;
  align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(2px); font: 14px/22px "Segoe UI", system-ui, sans-serif; color: #0f1115; }
#dshl-port-overlay .dshl-card { width: 480px; max-width: calc(100vw - 48px); box-sizing: border-box;
  padding: 28px; background: #ffffff; border-radius: 24px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18); }
#dshl-port-overlay .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#dshl-port-overlay .title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; color: #0f1115; }
#dshl-port-overlay .body { margin-top: 20px; }
#dshl-port-overlay .description { margin: 0; font-size: 14px; line-height: 24px; color: #61666b; }
#dshl-port-overlay .editor { margin-top: 24px; display: flex; flex-direction: column; gap: 12px; }
#dshl-port-overlay .field { display: flex; flex-direction: column; gap: 6px; }
#dshl-port-overlay .fieldLabel { font-size: 12px; line-height: 18px; font-weight: 500; color: #61666b; }
#dshl-port-overlay input { width: 100%; box-sizing: border-box; height: 32px; padding: 0 10px;
  border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 8px; background: #ffffff;
  color: #0f1115; font-size: 14px; line-height: 22px; outline: none; }
#dshl-port-overlay input:focus { border-color: #0f1115; }
#dshl-port-overlay input::placeholder { color: #e1e5ee; }
#dshl-port-overlay .footer { display: flex; justify-content: flex-end; gap: 8px; }
#dshl-port-overlay button { box-sizing: border-box; display: inline-flex; align-items: center;
  justify-content: center; height: 36px; padding: 0 14px; border-radius: 18px;
  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
  background: transparent; color: #0f1115; border: 1px solid rgba(0, 0, 0, 0.1); }
#dshl-port-overlay button:hover { background: rgba(38, 49, 72, 0.06); }
#dshl-port-overlay button.primary { background: #0f1115; color: #ffffff; border: none; }
#dshl-port-overlay button.primary:hover { background: #43454a; }
</style>
<div class="dshl-card">
  <div class="head">
    <h2 class="title">设置服务端口</h2>
  </div>
  <div class="body">
    <p class="description">设置本地 DSH 服务监听端口（1-65535），留空自动选择空闲端口。保存后本地服务将重启生效。</p>
    <div class="editor">
      <div class="field">
        <span class="fieldLabel">服务端口</span>
        <input id="port" type="text" inputmode="numeric" spellcheck="false" placeholder="自动">
      </div>
      <div class="footer">
        <button id="cancel">取消</button>
        <button id="save" class="primary">保存</button>
      </div>
    </div>
  </div>
</div>
</div>`

/** 打开「设置服务端口」覆盖层（先显示主窗口；已打开则聚焦输入框）。 */
function openPortDialog() {
  showMainWindow()
  injectIntoMain(`(() => {
    if (document.getElementById('dshl-port-overlay')) {
      const i = document.getElementById('port'); if (i) i.focus(); return
    }
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(PORT_FORM_HTML)})
    const overlay = document.getElementById('dshl-port-overlay')
    const portInput = overlay.querySelector('#port')
    window.dshlPort.getCurrent().then(v => { if (v) portInput.value = v })
    const submit = () => window.dshlPort.submit(portInput.value.trim())
    overlay.querySelector('#save').addEventListener('click', submit)
    overlay.querySelector('#cancel').addEventListener('click', () => window.dshlPort.cancel())
    portInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit()
      if (e.key === 'Escape') window.dshlPort.cancel()
    })
    portInput.focus()
  })()`)
}

/** 关闭「设置服务端口」覆盖层。 */
function closePortOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.executeJavaScript(
    `document.getElementById('dshl-port-overlay')?.remove()`,
  ).catch(() => {})
}

/** 读取 launcher.json 配置见文件顶部 readLauncherConfig。 */

/** 写回 launcher.json：patch 值为 null 表示删除该键。 */
function writeLauncherConfig(patch) {
  const cfg = readLauncherConfig()
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete cfg[k]
    else cfg[k] = v
  }
  writeFileSync(join(dataDir, 'launcher.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

/** 宿主正在主动重启（设置端口后）：跳过「宿主意外退出」错误框。 */
let hostRestarting = false

/** 应用端口设置：写入 launcher.json；本地模式重启宿主生效，远程模式仅保存。 */
async function applyPortSetting(raw) {
  closePortOverlay()
  const value = String(raw ?? '').trim()
  let port = null
  if (value !== '') {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'warning',
        title: '端口无效',
        message: '请输入 1-65535 之间的整数端口，或留空自动选择。',
        buttons: ['知道了'],
      })
      return false
    }
    port = n
  }
  try {
    writeLauncherConfig({ port })
  } catch (error) {
    dialog.showErrorBox('保存失败', String(error && error.message || error))
    return false
  }
  if (remoteMode || localUrl === null) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: '端口已保存',
      message: port === null ? '已恢复自动选择空闲端口。' : `服务端口已保存为 ${port}。`,
      detail: '当前为远程连接模式，返回本地服务后生效。',
      buttons: ['知道了'],
    })
    return true
  }
  // 本地模式：重启宿主立即生效
  hostRestarting = true
  try {
    killHost()
    const result = await startHost()
    hostUrl = result.url
    localUrl = result.url
    buildTrayMenu()
    if (mainWindow) {
      mainWindow.setTitle(windowTitleText())
      mainWindow.__dshlErrorPage = false
      mainWindow.loadURL(result.url)
    }
    return true
  } catch (error) {
    dialog.showErrorBox(
      '服务重启失败',
      String(error && error.message || error) + '\n\n请退出后重新启动程序。',
    )
    return false
  } finally {
    hostRestarting = false
  }
}

/** 用系统默认浏览器打开当前 DSH 服务地址。 */
function openInBrowser() {
  if (!hostUrl) return
  shell.openExternal(hostUrl).catch(() => {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: '无法打开浏览器',
      message: `未能调用默认浏览器打开：\n${hostUrl}`,
      buttons: ['知道了'],
    })
  })
}


/** 切换到指定远程地址（校验、更新状态、主窗口导航、重建菜单）。 */
function connectToUrl(raw) {
  const url = normalizeRemoteUrl(raw)
  if (url === undefined) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: '地址无效',
      message: '请输入有效的远程地址',
      detail: '例如：http://192.168.1.100:8080 或 https://dsh.example.com',
      buttons: ['知道了'],
    })
    return false
  }
  remoteMode = true
  hostUrl = url
  if (mainWindow) mainWindow.setTitle(windowTitleText())
  buildTrayMenu()
  if (mainWindow) {
    mainWindow.__dshlErrorPage = false
    mainWindow.loadURL(url)
  }
  return true
}

/** 切回本地宿主服务（本地宿主进程在远程连接期间保持运行）。 */
function backToLocal() {
  if (localUrl === null) return
  remoteMode = false
  hostUrl = localUrl
  if (mainWindow) mainWindow.setTitle(windowTitleText())
  buildTrayMenu()
  if (mainWindow) {
    mainWindow.__dshlErrorPage = false
    mainWindow.loadURL(localUrl)
  }
}

// ---------------------------------------------------------------- 宿主进程

let hostProcess = null
let hostUrl = null
/** 本地宿主的服务地址；远程连接时保留，用于「返回本地服务」。 */
let localUrl = null

/** 杀掉宿主进程树（Windows 用 taskkill /T，确保子进程一起退出）。 */
function killHost() {
  if (!hostProcess || hostProcess.killed) return
  const pid = hostProcess.pid
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      hostProcess.kill('SIGTERM')
    }
  } catch {
    /* 进程可能已退出 */
  }
  hostProcess = null
}

/** 数据目录说明文件：让用户清楚数据保存在哪、如何迁移。 */
function writeDataReadme() {
  const text = [
    'DeepSeek Harness Launcher — 用户数据目录',
    '',
    '本目录保存 DeepSeek Harness 的全部用户数据（DSH_HOME）：',
    '  profiles\\      各 profile（web / headless）的配置与插件依赖',
    '  settings.yaml   模型 API Key 等设置',
    '  sessions\\      会话记录',
    '  attachments\\   附件',
    '  logs\\          启动日志',
    '  launcher.json  启动器配置（可选）：',
    '                 {"port": 8080}            固定本地监听端口',
    '                 {"remoteUrl": "http://192.168.1.100:8080"}  连接远程 DSH 服务',
    '                 {"remoteUrl": "...", "insecure": true}     远程为自签 https 时忽略证书错误',
    '                 {"closeToTray": false}    关闭窗口直接退出（默认最小化到托盘）',
    '                 不配置 port 则自动选用空闲端口',
    '',
    '端口配置优先级：启动参数 --port <n> > launcher.json 的 port > 自动。',
    '远程连接优先级：启动参数 --remote <url> > launcher.json 的 remoteUrl；',
    '配置 remoteUrl 后不再启动本地宿主。',
    '',
    '备份/迁移：退出程序后把整个程序目录移动/复制到新位置即可，数据随目录一起走。',
    '',
    '【移动整个程序目录（绿色版解压目录）】',
    '  不能直接移动/复制程序目录！程序在 .dsh\\profiles\\node_modules 维护受管链接树，',
    '  直接移动/复制会被资源管理器跟随链接反复复制而卡死。',
    '  正确步骤：托盘菜单「程序备份迁移…」→ 点「清除受管链接树并退出」→',
    '  程序自动停止服务、清除链接树并退出 → 手动移动/复制整个程序目录 →',
    '  重新启动自动重建链接树，用户数据（.dsh）与 Electron 数据（.launcher）完好。',
    '  若自动清除失败：退出程序后运行 .clean-links.bat，或手动删除',
    '  .dsh\\profiles\\node_modules 目录后再迁移。',
    '',
    '如需改到其他位置，请设置环境变量 DSH_HOME 指向目标目录后重新启动。',
    '',
  ].join('\r\n')
  try {
    writeFileSync(join(dataDir, 'README.txt'), text, 'utf8')
  } catch { /* 目录不可写时静默，后续启动检查会报错 */ }
}

/**
 * 清理 .dsh\profiles\node_modules 中被复制工具解引用成真实目录的残留:
 * dsh 的 healProfilesModuleFallback 要求该目录下每个包条目都是指向安装闭包的
 * junction;移动整个程序目录时,若用户用「复制」而非「剪切/移动」,复制工具会把
 * junction 展开成真实目录,dsh 遇到真实目录会拒绝启动
 * ("exists and is not a symlink")。这里在启动宿主前删除这些实体目录
 * (仅限该受管链接树,不含用户数据),dsh 会在启动时按新位置重建全部链接;
 * 悬空/指向旧位置的链接无需处理,dsh 自行重新指向。
 */
function healProfileModuleLinks() {
  const nmDir = join(dataDir, 'profiles', 'node_modules')
  let entries
  try { entries = readdirSync(nmDir) } catch { return } // 首次运行尚无该目录
  for (const name of entries) {
    if (name.startsWith('@')) {
      // scope 目录本身合法;其内部每个包条目才是链接
      const scopeDir = join(nmDir, name)
      let subs
      try { subs = readdirSync(scopeDir) } catch { continue }
      for (const sub of subs) {
        const p = join(scopeDir, sub)
        let st
        try { st = lstatSync(p) } catch { continue }
        if (!st.isSymbolicLink() && st.isDirectory()) {
          try { rmSync(p, { recursive: true, force: true }) } catch { /* 保留失败项,交给宿主报错 */ }
        }
      }
    } else {
      // 顶层非 scope 包条目本应是链接;真实目录是复制残留
      const p = join(nmDir, name)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (!st.isSymbolicLink() && st.isDirectory()) {
        try { rmSync(p, { recursive: true, force: true }) } catch { /* 保留失败项,交给宿主报错 */ }
      }
    }
  }
}

/**
 * 启动 dsh 宿主：`node lib\bin.js web --port 0`（0 = 让 OS 选空闲端口），
 * 解析 stdout 中的 `dsh web: http://127.0.0.1:<port>` 就绪行。
 * @returns {Promise<{child: import('node:child_process').ChildProcess, url: string}>}
 */
function startHost() {
  return new Promise((resolve, reject) => {
    mkdirSync(logDir, { recursive: true })
    writeDataReadme()
    healProfileModuleLinks()

    if (!existsSync(nodeExe)) {
      reject(new Error(`未找到捆绑的 Node 运行时：\n${nodeExe}\n\n请重新运行构建脚本 scripts\\build.ps1。`))
      return
    }
    if (!existsSync(dshBin)) {
      reject(new Error(`未找到 dsh 依赖闭包：\n${dshBin}\n\n请重新运行构建脚本 scripts\\build.ps1。`))
      return
    }

    const env = {
      ...process.env,
      DSH_HOME: dataDir,
      DSH_TELEMETRY_DISABLED: '1',
      PATH: `${nodeDir};${process.env.PATH || ''}`,
    }
    // 端口：命令行/配置文件可指定固定端口，0 = 由 OS 选空闲端口（默认）
    const port = resolvePort()
    const child = spawn(nodeExe, [dshBin, 'web', '--port', String(port)], {
      env,
      cwd: programDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    hostProcess = child

    let out = ''
    let err = ''
    const urlRe = /dsh web:\s*(https?:\/\/\S+)/
    let settled = false
    const finish = (fn, ...args) => {
      if (settled) return
      settled = true
      fn(...args)
    }

    const timer = setTimeout(() => {
      finish(reject, new Error(
        `dsh 宿主 60 秒内未就绪。\n\n最近的输出：\n${(err || out).slice(-1500)}`,
      ))
      killHost()
    }, 60000)

    child.stdout.on('data', (chunk) => {
      out += chunk
      const m = out.match(urlRe)
      if (m) {
        clearTimeout(timer)
        finish(resolve, { child, url: m[1] })
      }
    })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (!settled) {
        finish(reject, new Error(
          `dsh 宿主异常退出（code=${code}, signal=${signal}）。\n\n${err.slice(-1500)}`,
        ))
      } else if (mainWindow && !hostRestarting) {
        // 宿主在就绪后死亡：服务已不可用，提示后退出
        // （设置端口后主动重启宿主时 hostRestarting=true，跳过此提示）
        dialog.showErrorBox(
          'DeepSeek Harness 已退出',
          `dsh 宿主进程意外退出（code=${code}, signal=${signal}）。\n\n请重新启动 DSHL。`,
        )
        app.quit()
      }
    })
    // 每行输出追加到日志文件（错误诊断用）
    const appendLog = (chunk) => {
      try { writeFileSync(join(logDir, 'host.log'), chunk, { flag: 'a' }) } catch { /* 忽略 */ }
    }
    child.stdout.on('data', appendLog)
    child.stderr.on('data', appendLog)
  })
}

// ---------------------------------------------------------------- 窗口

let mainWindow = null

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    // 一体化现代窗口：无边框不透明（直角矩形，无透明合成开销）
    title: windowTitleText(),
    frame: false,
    transparent: false,
    backgroundColor: '#ffffff',
    hasShadow: false,
    icon: join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // 窗口菜单栏已移除，注册窗口内快捷键（Ctrl+L 连接远程 / Ctrl+Q 退出）
  attachMainWindowShortcuts(mainWindow)
  // 一体化标题栏：注入拖拽条并下移页面内容
  attachTitlebar(mainWindow)
  // 阻止页面 document.title 覆盖窗口标题，保持服务地址可见
  mainWindow.on('page-title-updated', (event) => { event.preventDefault() })
  mainWindow.loadURL(url)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  // 关闭按钮默认最小化到托盘（closeToTray=true），宿主保持运行；真正退出走托盘/菜单/Ctrl+Q
  mainWindow.on('close', (event) => {
    if (closeToTray && !isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  return mainWindow
}

// ---------------------------------------------------------------- 托盘

/** 显示并聚焦主窗口。 */
function showMainWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

/** 单击托盘图标：切换主窗口显示/隐藏。 */
function toggleMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    showMainWindow()
  }
}

/** 主窗口内的快捷键（窗口菜单栏已移除，不依赖菜单加速键）。 */
function attachMainWindowShortcuts(win) {
  win.webContents.on('before-input-event', (_event, input) => {
    if (!input.control || input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 'q') app.quit()
    else if (key === 'l') openRemoteDialog()
  })
}

/** 创建系统托盘图标：单击切换窗口显示/隐藏；右键菜单承载全部操作入口。 */
function createTray() {
  if (tray) return
  const icon = nativeImage.createFromPath(join(__dirname, 'build', 'icon.png'))
  tray = new Tray(icon)
  tray.setToolTip(windowTitleText())
  tray.on('click', toggleMainWindow)
  buildTrayMenu()
}

/**
 * 重建托盘右键菜单（全部操作入口；在连接/模式变化时重建以刷新启用状态）。
 * 窗口菜单栏已移除（Menu.setApplicationMenu(null)），保持窗口简洁。
 */
function buildTrayMenu() {
  if (!tray) return
  tray.setToolTip(windowTitleText())
  const template = [
    { label: '显示/隐藏', click: toggleMainWindow },
    { type: 'separator' },
    { label: '连接远程服务…', click: openRemoteDialog },
    { label: '返回本地服务', enabled: remoteMode && localUrl !== null, click: backToLocal },
    { label: '重连远程服务', enabled: remoteMode && hostUrl !== null, click: reconnectRemote },
    { label: '设置服务端口…', click: openPortDialog },
    { label: '复制服务地址', enabled: hostUrl !== null, click: copyServiceUrl },
    { label: '用浏览器打开', enabled: hostUrl !== null, click: openInBrowser },
    { type: 'separator' },
    { label: '打开数据目录', click: openDataDir },
    { label: '打开日志目录', click: openLogDir },
    { label: '数据目录说明…', click: showDataDirDialog },
    { label: '程序备份迁移…', click: showMigrateDialog },
    { type: 'separator' },
    { label: '关于', click: showAboutDialog },
    { label: '退出', click: () => app.quit() },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------- 一体化标题栏

/** 标题栏高度。 */
const TITLEBAR_HEIGHT = 36

/**
 * 窗口标题 / 托盘提示的统一样式：`DeepSeek Harness · 本地/远程 · 地址`。
 */
function windowTitleText() {
  const mode = remoteMode ? '远程' : '本地'
  return `DeepSeek Harness · ${mode} · ${hostUrl || '启动中'}`
}

/**
 * 注入一体化标题栏（在页面上下文中执行）：
 * - 顶部 36px 标题栏：背景动态取页面背景色（随主题自适应），左侧显示「程序名 · 服务地址」，
 *   右侧自绘最小化/最大化/关闭按钮（-webkit-app-region: no-drag，经 IPC 控制窗口）
 * - 主窗口为直角矩形（无圆角）
 * @param {import('electron').BrowserWindow} win
 */
function attachTitlebar(win) {
  const inject = (url) => {
    const payload = { height: TITLEBAR_HEIGHT, mode: remoteMode ? '远程' : '本地', url: url || '' }
    const labelText = `DeepSeek Harness · ${payload.mode} · ${payload.url || '启动中'}`
    win.webContents.executeJavaScript(`(() => {
      // 标题栏已存在：仅更新左侧标签（远程/本地切换后导航触发）
      if (document.getElementById('dshl-titlebar')) {
        const l = document.getElementById('dshl-titlebar-label')
        if (l) l.textContent = ${JSON.stringify(labelText)}
        return
      }
      const P = ${JSON.stringify(payload)}
      // 页面背景色（body 透明时回退白色）
      const cs = getComputedStyle(document.body)
      let bg = cs.backgroundColor
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = '#ffffff'

      // 0) 基础布局：body 贴边填满窗口，顶部留出标题栏高度
      document.body.style.margin = '0'
      document.body.style.height = '100%'
      document.body.style.background = bg
      document.body.style.overflow = 'hidden'
      document.body.style.boxSizing = 'border-box'
      document.body.style.paddingTop = P.height + 'px'

      // 1) 标题栏：左侧显示程序名 + 服务地址
      const bar = document.createElement('div')
      bar.id = 'dshl-titlebar'
      bar.style.cssText = [
        'position:fixed','top:0','left:0','right:0',
        'height:' + P.height + 'px',
        '-webkit-app-region:drag','z-index:2147483646',
        'display:flex','align-items:center','padding-left:16px','box-sizing:border-box',
        'background:transparent','color:#1f2937','user-select:none',
        'font:13px/1 "Segoe UI",system-ui,sans-serif',
        'border-bottom:1px solid rgba(0,0,0,0.08)',
      ].join(';')
      const label = document.createElement('span')
      label.id = 'dshl-titlebar-label'
      label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;pointer-events:none'
      label.textContent = 'DeepSeek Harness · ' + P.mode + ' · ' + (P.url || '启动中')
      bar.appendChild(label)

      // 2) 自绘窗口按钮（no-drag，经 dshlWin 桥控制）
      const btnStyle = [
        'width:46px','height:' + P.height + 'px','display:flex','align-items:center',
        'justify-content:center','-webkit-app-region:no-drag','cursor:default',
        'color:#5b6472','transition:background 0.1s',
      ].join(';')
      const icon = (svg) => '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">' + svg + '</svg>'
      const makeBtn = (id, svg, hover) => {
        const b = document.createElement('div')
        b.id = id
        b.style.cssText = btnStyle
        b.innerHTML = icon(svg)
        b.addEventListener('mouseenter', () => { b.style.background = hover || 'rgba(0,0,0,0.06)' })
        b.addEventListener('mouseleave', () => { b.style.background = '' })
        return b
      }
      const btnMin = makeBtn('dshl-btn-min', '<line x1="0" y1="5" x2="10" y2="5"/>')
      const btnMax = makeBtn('dshl-btn-max', '<rect x="1" y="1" width="8" height="8" rx="1"/>')
      const btnClose = makeBtn('dshl-btn-close', '<line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>', '#e81123')
      const setMaxIcon = (maximized) => {
        btnMax.innerHTML = icon(maximized
          ? '<rect x="1" y="3" width="6" height="6" rx="1"/><line x1="3" y1="1" x2="9" y2="1"/><line x1="9" y1="1" x2="9" y2="7"/>'
          : '<rect x="1" y="1" width="8" height="8" rx="1"/>')
      }
      btnMin.addEventListener('click', () => window.dshlWin && window.dshlWin.minimize())
      btnMax.addEventListener('click', () => window.dshlWin && window.dshlWin.toggleMaximize())
      btnClose.addEventListener('click', () => window.dshlWin && window.dshlWin.close())
      if (window.dshlWin) {
        window.dshlWin.isMaximized().then(setMaxIcon)
        window.dshlWin.onMaximizeChange(setMaxIcon)
      }
      const right = document.createElement('div')
      right.id = 'dshl-titlebar-buttons'
      right.style.cssText = 'display:flex;height:' + P.height + 'px;margin-left:8px'
      right.appendChild(btnMin); right.appendChild(btnMax); right.appendChild(btnClose)
      bar.appendChild(right)
      document.body.prepend(bar)
    })()`).catch(() => { /* 页面导航中注入失败可忽略 */ })
  }
  // 最大化状态切换：仅同步自绘按钮图标
  win.on('maximize', () => { win.webContents.send('dshl:win-maximize-changed', true) })
  win.on('unmaximize', () => { win.webContents.send('dshl:win-maximize-changed', false) })
  win.webContents.on('did-finish-load', () => inject(hostUrl))
  win.webContents.on('did-navigate-in-page', () => inject(hostUrl))
}

/** HTML 转义，用于错误页内嵌远程地址。 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * 远程连接失败处理：主框架加载失败时在窗口内显示错误页（含重试链接）。
 * 地址从当前 hostUrl 动态读取，运行时切换远程目标后错误页仍指向最新地址。
 * @param {import('electron').BrowserWindow} win
 */
function attachRemoteFailureHandling(win) {
  win.webContents.on('did-start-navigation', (_event, target, _inPlace, isMainFrame) => {
    if (isMainFrame && target.startsWith('http')) win.__dshlErrorPage = false
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || win.__dshlErrorPage) return
    const url = hostUrl
    if (url === null) return
    win.__dshlErrorPage = true
    const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #ffffff; color: #1f2937; font-family: "Segoe UI", system-ui, sans-serif; }
  .card { max-width: 560px; padding: 28px 36px; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff; }
  h2 { margin: 0 0 12px; font-size: 18px; }
  .url { color: #0f1115; word-break: break-all; }
  .err { color: #dc2626; font-size: 13px; margin: 8px 0; }
  .hint { color: #61666b; font-size: 13px; line-height: 1.7; }
  a.btn { display: inline-block; margin-top: 16px; padding: 8px 20px; border-radius: 8px;
          background: #0f1115; color: #fff; text-decoration: none; }
</style></head><body><div class="card">
  <h2>无法连接远程服务</h2>
  <p class="url">${escapeHtml(url)}</p>
  <p class="err">错误码 ${errorCode}：${escapeHtml(errorDescription)}</p>
  <p class="hint">请确认远程 DSH 服务已启动、地址正确且网络可达。<br>
     提示：DSH 宿主默认只监听 127.0.0.1，远程访问需通过 SSH 隧道或内网穿透暴露端口。</p>
  <a class="btn" href="${escapeHtml(url)}">重试</a>
</div></body></html>`
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}

// ---------------------------------------------------------------- 菜单与指引

/**
 * 「数据目录说明」对话框（首次启动弹窗；注入到主窗口页面的 DOM 覆盖层）。
 * 说明用户数据与 Electron 数据保存在哪、如何备份迁移。
 * 按 DSH「内测声明」弹窗（WelcomeNotice）精确复刻；圆角由页面内 CSS 原生绘制，无锯齿。
 */
const DATA_DIR_DIALOG_HTML = `<div id="dshl-data-overlay">
<style>
#dshl-data-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex;
  align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(2px); font: 14px/22px "Segoe UI", system-ui, sans-serif; color: #0f1115; }
#dshl-data-overlay .dshl-card { width: 520px; max-width: calc(100vw - 48px); box-sizing: border-box;
  padding: 28px; background: #ffffff; border-radius: 24px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18); }
#dshl-data-overlay .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#dshl-data-overlay .title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; color: #0f1115; }
#dshl-data-overlay .body { margin-top: 20px; }
#dshl-data-overlay .copy { font-size: 14px; line-height: 24px; color: #61666b; }
#dshl-data-overlay .copy p { margin: 0; }
#dshl-data-overlay .copy p + p { margin-top: 12px; }
#dshl-data-overlay .copy b { color: #0f1115; font-weight: 500; }
#dshl-data-overlay .copy .path { word-break: break-all; user-select: text; font-size: 13px;
  line-height: 20px; color: #0f1115; background: #f1f3f5; border-radius: 8px; padding: 8px 12px; margin-top: 6px; }
#dshl-data-overlay .copy .warn { background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 10px;
  padding: 10px 14px; color: #8a5a00; }
#dshl-data-overlay .copy .warn b { color: #8a5a00; }
#dshl-data-overlay .actions { display: flex; justify-content: flex-end; margin-top: 24px; gap: 8px; }
#dshl-data-overlay button { box-sizing: border-box; display: inline-flex; align-items: center;
  justify-content: center; height: 36px; padding: 0 14px; border-radius: 18px;
  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
  background: transparent; color: #0f1115; border: 1px solid rgba(0, 0, 0, 0.1); }
#dshl-data-overlay button:hover { background: rgba(38, 49, 72, 0.06); }
#dshl-data-overlay button.primary { background: #0f1115; color: #ffffff; border: none; min-width: 120px; }
#dshl-data-overlay button.primary:hover { background: #43454a; }
</style>
<div class="dshl-card">
  <div class="head">
    <h2 class="title">数据目录说明</h2>
  </div>
  <div class="body">
    <div class="copy">
      <p><b>内核数据目录（.dsh）</b>：包含 DeepSeek Harness 的全部运行数据（API Key、会话、插件、附件等），保存在程序目录内的 <b>.dsh</b> 目录：</p>
      <p class="path" id="dsh-path"></p>
      <p><b>启动器数据目录（.launcher）</b>：包含启动器 Electron 自身的数据（缓存、Local Storage 等），保存在程序目录内的 <b>.launcher</b> 目录：</p>
      <p class="path" id="launcher-path"></p>
      <div class="warn">
        <p><b>⚠ 备份/迁移</b>：必须通过托盘菜单 <b>「程序备份迁移」</b> 才能保证程序以及上述数据随目录完好备份/迁移！</p>
      </div>
      <p>如需改到其他位置，设置环境变量 <b>DSH_HOME</b> 指向目标目录后重新启动。</p>
    </div>
    <div class="actions">
      <button id="open">打开程序目录</button>
      <button id="ok" class="primary">知道了</button>
    </div>
  </div>
</div>
</div>`

/** 打开「数据目录说明」覆盖层（先显示主窗口；已打开则忽略）。 */
function openDataDirDialog() {
  showMainWindow()
  injectIntoMain(`(() => {
    if (document.getElementById('dshl-data-overlay')) return
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(DATA_DIR_DIALOG_HTML)})
    const overlay = document.getElementById('dshl-data-overlay')
    overlay.querySelector('#dsh-path').textContent = ${JSON.stringify(dataDir)}
    overlay.querySelector('#launcher-path').textContent = ${JSON.stringify(launcherDataDir)}
    overlay.querySelector('#open').addEventListener('click', () => window.dshlDialog.openProgramDir())
    overlay.querySelector('#ok').addEventListener('click', () => window.dshlDialog.close())
  })()`)
}

/** 关闭「数据目录说明」覆盖层。 */
function closeDataDirOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.executeJavaScript(
    `document.getElementById('dshl-data-overlay')?.remove()`,
  ).catch(() => {})
}

/**
 * 「程序目录迁移」对话框（托盘菜单弹窗；注入到主窗口页面的 DOM 覆盖层）。
 * 说明迁移流程；用户确认后自动停止服务、完成迁移准备并退出。
 */
const MIGRATE_DIALOG_HTML = `<div id="dshl-migrate-overlay">
<style>
#dshl-migrate-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex;
  align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(2px); font: 14px/22px "Segoe UI", system-ui, sans-serif; color: #0f1115; }
#dshl-migrate-overlay .dshl-card { width: 540px; max-width: calc(100vw - 48px); box-sizing: border-box;
  padding: 28px; background: #ffffff; border-radius: 24px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18); }
#dshl-migrate-overlay .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#dshl-migrate-overlay .title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; color: #0f1115; }
#dshl-migrate-overlay .body { margin-top: 20px; }
#dshl-migrate-overlay .copy { font-size: 14px; line-height: 24px; color: #61666b; }
#dshl-migrate-overlay .copy p { margin: 0; }
#dshl-migrate-overlay .copy p + p { margin-top: 12px; }
#dshl-migrate-overlay .copy b { color: #0f1115; font-weight: 500; }
#dshl-migrate-overlay .copy .warn { background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 10px;
  padding: 10px 14px; color: #8a5a00; }
#dshl-migrate-overlay .copy .warn b { color: #8a5a00; }
#dshl-migrate-overlay .copy .steps { margin-top: 8px; padding-left: 0; list-style: none; }
#dshl-migrate-overlay .copy .steps li { margin-top: 8px; }
#dshl-migrate-overlay .copy .steps .num { display: inline-block; width: 20px; height: 20px; line-height: 20px;
  text-align: center; border-radius: 50%; background: #0f1115; color: #fff; font-size: 12px; margin-right: 8px; }
#dshl-migrate-overlay .actions { display: flex; justify-content: flex-end; margin-top: 24px; gap: 8px; }
#dshl-migrate-overlay button { box-sizing: border-box; display: inline-flex; align-items: center;
  justify-content: center; height: 36px; padding: 0 14px; border-radius: 18px;
  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
  background: transparent; color: #0f1115; border: 1px solid rgba(0, 0, 0, 0.1); }
#dshl-migrate-overlay button:hover { background: rgba(38, 49, 72, 0.06); }
#dshl-migrate-overlay button.primary { background: #0f1115; color: #ffffff; border: none; min-width: 160px; }
#dshl-migrate-overlay button.primary:hover { background: #43454a; }
</style>
<div class="dshl-card">
  <div class="head">
    <h2 class="title">程序备份迁移</h2>
  </div>
  <div class="body">
    <div class="copy">
      <p>本程序支持便携化运行，可以将整个程序目录移动到其它位置。</p>
      <p>但是，<b>不能直接移动/复制程序目录</b>：程序运行时会在
         <b>.dsh\\profiles\\node_modules</b> 维护一套指向安装目录的受管链接树。
         直接移动/复制时，Windows 资源管理器会跟随这些链接反复复制
         <b>resources\\dsh</b> 的内容，导致进度条卡死、目录损坏。</p>
      <p>必须按以下步骤操作，才能保证程序完好备份/迁移：</p>
      <ul class="steps">
        <li><span class="num">1</span>点击 <b>「清除受管链接树并退出」</b>：程序将自动停止服务、清除受管链接树，然后自动退出</li>
        <li><span class="num">2</span>随后手动把整个程序目录移动/复制到新位置，再重新启动程序，会自动重建受管链接树</li>
        <li><span class="num">3</span>可进一步确认程序运行状态无异常、会话记录完好</li>
      </ul>
      <div class="warn">
        <p><b>⚠ 提示</b>：若自动清除受管链接树失败，可退出程序后执行
           <b>.clean-links.bat</b>，或手动删除 <b>.dsh\\profiles\\node_modules</b> 目录后再迁移。</p>
      </div>
    </div>
    <div class="actions">
      <button id="cancel">取消</button>
      <button id="migrate" class="primary">清除受管链接树并退出</button>
    </div>
  </div>
</div>
</div>`

/** 打开「程序目录迁移」覆盖层（先显示主窗口；已打开则忽略）。 */
function openMigrateDialog() {
  showMainWindow()
  injectIntoMain(`(() => {
    if (document.getElementById('dshl-migrate-overlay')) return
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(MIGRATE_DIALOG_HTML)})
    const overlay = document.getElementById('dshl-migrate-overlay')
    overlay.querySelector('#cancel').addEventListener('click', () => window.dshlMigrate.cancel())
    overlay.querySelector('#migrate').addEventListener('click', () => window.dshlMigrate.confirm())
  })()`)
}

/** 关闭「程序目录迁移」覆盖层。 */
function closeMigrateOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.executeJavaScript(
    `document.getElementById('dshl-migrate-overlay')?.remove()`,
  ).catch(() => {})
}

/** 托盘菜单入口：程序目录迁移。 */
function showMigrateDialog() {
  openMigrateDialog()
}

/**
 * 执行程序目录迁移：停止宿主 → 清理链接树 → 提示可移动 → 退出。
 * 链接树不含用户数据，移动后首次启动自动重建；运行中删除不影响已加载模块。
 */
function performMigration() {
  closeMigrateOverlay()
  try {
    // 1. 停止宿主，确保文件未被占用
    killHost()
    // 2. 清理受管链接树（只删链接，不碰 .dsh\ 下其它用户数据）
    const nmDir = join(dataDir, 'profiles', 'node_modules')
    if (existsSync(nmDir)) {
      rmSync(nmDir, { recursive: true, force: true })
    }
    // 3. 提示用户可移动目录
    dialog.showMessageBox({
      type: 'info',
      title: '程序备份迁移',
      message: '受管链接树已清除，程序即将退出。',
      detail:
        `请将整个程序目录移动到新位置（推荐整体剪切/移动），然后重新启动。\n` +
        `移动后首次启动会自动重建受管链接树，用户数据不会丢失。\n\n` +
        `当前程序目录：${programDir}`,
      buttons: ['知道了'],
    })
  } catch (error) {
    dialog.showErrorBox(
      '程序备份迁移失败',
      String(error && error.message || error) + '\n\n请退出程序后运行 .clean-links.bat，' +
        '或手动删除 .dsh\\profiles\\node_modules 目录后再迁移。',
    )
    return
  }
  // 4. 退出（before-quit 会再次 killHost，幂等）
  app.quit()
}

function openDataDir() {
  shell.openPath(dataDir).then((err) => {
    if (err) dialog.showErrorBox('无法打开目录', err)
  })
}

/** 打开程序目录（数据目录说明弹窗按钮）。 */
function openProgramDir() {
  shell.openPath(programDir).then((err) => {
    if (err) dialog.showErrorBox('无法打开目录', err)
  })
}

/** 托盘菜单入口：数据目录说明。 */
function showDataDirDialog() {
  openDataDirDialog()
}

function openLogDir() {
  shell.openPath(logDir).then((err) => {
    if (err) dialog.showErrorBox('无法打开目录', err)
  })
}

/** 关于对话框（托盘菜单入口）。 */
function showAboutDialog() {
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: '关于',
    message: 'DSHL（DeepSeek Harness Launcher）',
    detail:
      `版本：${app.getVersion()}\n` +
      `模式：${remoteMode ? '远程连接' : '本地启动'}\n` +
      `服务地址：${hostUrl || '未启动'}\n` +
      `用户数据目录：${dataDir}\n\n` +
      'DeepSeek Harness 为开发者预览版（0.1.0-rc），可能存在兼容性变更。',
  })
}

function copyServiceUrl() {
  if (hostUrl) clipboard.writeText(hostUrl)
}

function reconnectRemote() {
  if (mainWindow && hostUrl) {
    mainWindow.__dshlErrorPage = false
    mainWindow.loadURL(hostUrl)
  }
}

function showFirstRunGuidance() {
  if (existsSync(firstRunMarker)) return
  try { writeFileSync(firstRunMarker, new Date().toISOString(), 'utf8') } catch { /* 忽略 */ }
  // 首次启动提示：数据目录说明（不含迁移确认按钮）
  setTimeout(() => openDataDirDialog(), 800)
}

// ---------------------------------------------------------------- 生命周期

// 单实例：重复启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // 窗口保持简洁：移除应用菜单栏，所有操作入口收进托盘右键菜单
    Menu.setApplicationMenu(null)
    createTray()
    if (remoteTarget !== undefined) {
      // 远程模式：不启动本地宿主，直接加载远程服务地址
      remoteMode = true
      hostUrl = remoteTarget.url
      buildTrayMenu()
      const win = createWindow(remoteTarget.url)
      attachRemoteFailureHandling(win)
      return
    }
    let url
    try {
      const result = await startHost()
      url = result.url
      hostUrl = url
      localUrl = url
      // 宿主就绪后重建托盘菜单，启用「复制服务地址」
      buildTrayMenu()
    } catch (error) {
      dialog.showErrorBox('DeepSeek Harness 启动失败', String(error && error.message || error))
      app.quit()
      return
    }
    createWindow(url)
    attachRemoteFailureHandling(mainWindow)
    showFirstRunGuidance()
  })

  app.on('before-quit', () => {
    // 真正退出：窗口 close 不再拦截（托盘/菜单/Ctrl+Q 走这里）
    isQuitting = true
    killHost()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  // 宿主意外退出（被外部杀死等）时提示
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && hostUrl) createWindow(hostUrl)
  })

  // 「连接远程服务」覆盖层 IPC
  ipcMain.on('dshl:remote-submit', (_event, raw) => {
    closeRemoteOverlay()
    connectToUrl(raw)
  })
  ipcMain.on('dshl:remote-cancel', () => {
    closeRemoteOverlay()
  })
  ipcMain.handle('dshl:remote-current', () => hostUrl || '')

  // 「设置服务端口」覆盖层 IPC
  ipcMain.on('dshl:port-submit', (_event, raw) => { applyPortSetting(raw) })
  ipcMain.on('dshl:port-cancel', () => {
    closePortOverlay()
  })
  ipcMain.handle('dshl:port-current', () => {
    const p = resolvePort()
    return typeof p === 'number' && p >= 1 && p <= 65535 ? String(p) : ''
  })

  // 自绘窗口按钮控制
  ipcMain.on('dshl:win-minimize', () => { if (mainWindow) mainWindow.minimize() })
  ipcMain.on('dshl:win-maximize-toggle', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('dshl:win-close', () => { if (mainWindow) mainWindow.close() })
  ipcMain.handle('dshl:win-is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false))

  // 「数据目录说明」覆盖层 IPC
  ipcMain.on('dshl:dialog-open-program-dir', () => openProgramDir())
  ipcMain.on('dshl:dialog-close', () => {
    closeDataDirOverlay()
  })
  // 「程序目录迁移」覆盖层 IPC
  ipcMain.on('dshl:migrate-cancel', () => {
    closeMigrateOverlay()
  })
  ipcMain.on('dshl:migrate-confirm', () => {
    performMigration()
  })
}
