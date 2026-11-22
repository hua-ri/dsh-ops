export function substituteVars(template, context = {}) {
  const now = new Date()
  const builtins = {
    host: context.hostName || '',
    hostname: context.hostname || '',
    user: context.user || process.env.USER || '',
    port: String(context.port || 22),
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 8),
    timestamp: String(Math.floor(now.getTime() / 1000)),
    home: process.env.HOME || '~',
  }
  const vars = { ...builtins, ...context.vars }
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match
  })
}

export function extractVars(template) {
  const matches = template.match(/\{\{(\w+)\}\}/g) || []
  return [...new Set(matches.map(m => m.slice(2, -2)))]
}
