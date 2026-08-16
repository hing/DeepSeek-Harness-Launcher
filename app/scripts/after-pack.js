/**
 * electron-builder afterPack 钩子：
 * electron-builder 的 extraResources 会过滤掉 node_modules，导致捆绑的
 * Node 运行时与 dsh 依赖闭包不完整。此钩子在 app 打包完成后（portable / NSIS
 * 组装之前）把 build\node 与 build\dsh 完整复制进 resources\。
 * @param {import('app-builder-lib').AfterPackContext} context
 */
'use strict'

const { cpSync, existsSync, rmSync, copyFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

exports.default = async function afterPack(context) {
  const { appOutDir } = context
  const projectRoot = resolve(__dirname, '..', '..')
  const resourcesDir = join(appOutDir, 'resources')

  for (const name of ['node', 'dsh']) {
    const src = join(projectRoot, 'build', name)
    const dst = join(resourcesDir, name)
    if (!existsSync(src)) {
      console.warn(`afterPack: 源目录缺失 ${src}，跳过`)
      continue
    }
    rmSync(dst, { recursive: true, force: true })
    cpSync(src, dst, { recursive: true })
    console.log(`afterPack: 已复制 ${src} -> ${dst}`)
  }

  // 移动目录辅助脚本：复制到程序目录根（与 DSHL.exe 同级），用户移动目录前双击运行
  for (const file of ['clean-links.ps1', 'clean-links.bat']) {
    const src = join(projectRoot, 'app', 'build', file)
    const dst = join(appOutDir, file)
    if (!existsSync(src)) {
      console.warn(`afterPack: 缺失 ${src}，跳过`)
      continue
    }
    copyFileSync(src, dst)
    console.log(`afterPack: 已复制 ${src} -> ${dst}`)
  }
}
