#!/usr/bin/env node

import { which } from '../lib/cli.mjs'

const deps = [
  { bin: 'ssh',      module: 'ssh',    install: 'macOS 自带',              required: true },
  { bin: 'kubectl',  module: 'k8s',    install: 'brew install kubectl',    required: true },
  { bin: 'helm',     module: 'helm',   install: 'brew install helm',       required: false },
]

async function main() {
  console.log('dsh-ops 依赖检查\n')
  let allOk = true

  for (const dep of deps) {
    const path = await which(dep.bin)
    const status = path ? '✓' : '✗'
    const hint = path ? path : `未找到 — ${dep.install}`
    const tag = dep.required ? '(默认启用)' : '(按需启用)'
    console.log(`  ${status}  ${dep.bin.padEnd(10)} ${dep.module.padEnd(8)} ${tag}  ${hint}`)
    if (!path && dep.required) allOk = false
  }

  console.log('')
  if (allOk) {
    console.log('基础依赖就绪。helm 按需安装即可。')
  } else {
    console.log('⚠ 有必需依赖缺失，请先安装。')
    process.exitCode = 1
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
