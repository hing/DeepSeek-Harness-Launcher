/**
 * DSHL preload — 通过 contextBridge 暴露最小化的启动器信息，
 * 供未来渲染层（欢迎页/状态页）使用；当前主窗口加载的是 DSH 自身 UI，
 * 此桥保持可用但不影响其运行。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshl', {
  /** 用户数据目录（程序目录内 data\）。 */
  getDataDir: () => process.env.DSH_HOME || '',
  /** 宿主就绪 URL（启动后填充）。 */
  getHostUrl: () => (globalThis.__DSHL_HOST_URL__ || '').toString(),
})

// 「连接远程服务」输入覆盖层使用的桥
contextBridge.exposeInMainWorld('dshlRemote', {
  /** 提交远程地址（主进程校验后连接）。 */
  submit: (url) => ipcRenderer.send('dshl:remote-submit', url),
  /** 取消连接。 */
  cancel: () => ipcRenderer.send('dshl:remote-cancel'),
  /** 获取当前服务地址（用于预填输入框）。 */
  getCurrent: () => ipcRenderer.invoke('dshl:remote-current'),
})

// 自绘窗口控制按钮桥（一体化标题栏用）
contextBridge.exposeInMainWorld('dshlWin', {
  minimize: () => ipcRenderer.send('dshl:win-minimize'),
  toggleMaximize: () => ipcRenderer.send('dshl:win-maximize-toggle'),
  close: () => ipcRenderer.send('dshl:win-close'),
  isMaximized: () => ipcRenderer.invoke('dshl:win-is-maximized'),
  /** 订阅最大化状态变化，返回取消订阅函数。 */
  onMaximizeChange: (callback) => {
    const listener = (_event, maximized) => callback(maximized)
    ipcRenderer.on('dshl:win-maximize-changed', listener)
    return () => ipcRenderer.removeListener('dshl:win-maximize-changed', listener)
  },
})

// 数据目录说明/移动目录说明覆盖层桥
contextBridge.exposeInMainWorld('dshlDialog', {
  openDataDir: () => ipcRenderer.send('dshl:dialog-open-data-dir'),
  close: () => ipcRenderer.send('dshl:dialog-close'),
  closeMove: () => ipcRenderer.send('dshl:dialog-close-move'),
})

// 「设置服务端口」覆盖层桥
contextBridge.exposeInMainWorld('dshlPort', {
  /** 提交端口设置（空字符串 = 自动选空闲端口）。 */
  submit: (port) => ipcRenderer.send('dshl:port-submit', port),
  /** 取消设置。 */
  cancel: () => ipcRenderer.send('dshl:port-cancel'),
  /** 获取当前端口配置（launcher.json 的 port；未配置返回 ''）。 */
  getCurrent: () => ipcRenderer.invoke('dshl:port-current'),
})
