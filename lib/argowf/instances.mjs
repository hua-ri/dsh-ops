import { readJson, writeJson, dataDir } from '../cli.mjs'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const instancesFile = () => join(dataDir(), 'argowf', 'instances.json')

export function loadInstances() {
  return readJson(instancesFile(), [])
}

export function saveInstances(instances) {
  mkdirSync(join(dataDir(), 'argowf'), { recursive: true })
  writeJson(instancesFile(), instances)
}

export function findInstance(name) {
  const instances = loadInstances()
  return instances.find((i) => i.name === name) || null
}

export function addInstance({ name, server, namespace, tags, note }) {
  const instances = loadInstances()
  if (instances.find((i) => i.name === name)) {
    return { ok: false, why: `实例 ${name} 已存在` }
  }
  instances.push({
    name,
    server,
    namespace: namespace || 'argo',
    tags: tags || [],
    note: note || '',
    addedAt: new Date().toISOString(),
  })
  saveInstances(instances)
  return { ok: true }
}

export function removeInstance(name) {
  const instances = loadInstances()
  const idx = instances.findIndex((i) => i.name === name)
  if (idx === -1) return { ok: false, why: `实例 ${name} 不存在` }
  instances.splice(idx, 1)
  saveInstances(instances)
  return { ok: true }
}

export function buildArgoArgs(instance, extraArgs = []) {
  const args = ['--server', instance.server]
  if (instance.namespace) args.push('-n', instance.namespace)
  args.push(...extraArgs)
  return args
}
