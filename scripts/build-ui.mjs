#!/usr/bin/env node
/**
 * build-ui.mjs — Inline CSS + bridge shim + app.js into index.html,
 * then embed the result as PANEL_HTML in web/client.js → lib/client.js.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const webDir = join(root, 'web')
const libDir = join(root, 'lib')

const BRIDGE_SHIM = `(function(){
var R=history.replaceState.bind(history),PU=history.pushState.bind(history);
history.replaceState=function(s,t,u){try{R(s,t,u)}catch(e){try{R(s,t)}catch(e2){}}};
history.pushState=function(s,t,u){try{PU(s,t,u)}catch(e){try{PU(s,t)}catch(e2){}}};
var P=window.parent,seq=0,waits={};
window.addEventListener('message',function(e){var d=e.data||{};
if(d.__dshops!=='res')return;var w=waits[d.id];if(!w)return;delete waits[d.id];w(d);});
window.fetch=function(u,o){o=o||{};var id=++seq;return new Promise(function(res,rej){
waits[id]=function(d){if(d.error){rej(new Error(d.error));return}
res({ok:d.ok,status:d.status,text:function(){return Promise.resolve(d.text)},
json:function(){return Promise.resolve(JSON.parse(d.text))}});};
try{P.postMessage({__dshops:'req',id:id,url:String(u),method:o.method||'GET',
body:(o.body==null?null:o.body),headers:o.headers||{}},'*');}catch(err){rej(err);}});};
})()`

try {
  console.log('[build-ui] Reading source files…')
  const html = readFileSync(join(webDir, 'index.html'), 'utf8')
  const css = readFileSync(join(webDir, 'style.css'), 'utf8')
  const appJs = readFileSync(join(webDir, 'app.js'), 'utf8')
  const clientTpl = readFileSync(join(webDir, 'client.js'), 'utf8')

  // 1. Inline CSS: replace <link> with <style>
  let panelHtml = html.replace(
    /<link\s+rel="stylesheet"\s+href="[^"]*style\.css"[^>]*>/,
    `<style>\n${css}\n</style>`
  )

  // 2. Inject bridge shim: replace the <script defer src="...app.js"> with just the shim
  //    and add app.js content before </body>
  panelHtml = panelHtml.replace(
    /<script\s+defer\s+src="[^"]*app\.js"[^>]*><\/script>/,
    `<script>${BRIDGE_SHIM}</script>`
  )
  panelHtml = panelHtml.replace(
    '</body>',
    `<script>\n${appJs}\n</script>\n</body>`
  )

  // 3. Build client module: replace __PANEL_HTML__ with stringified HTML
  const panelStr = JSON.stringify(panelHtml)
  const clientOut = clientTpl.replace('__PANEL_HTML__', panelStr)

  // 4. Validate output is syntactically valid JS
  console.log('[build-ui] Validating output…')
  new vm.Script(clientOut, { filename: 'lib/client.js' })

  // 5. Write to lib/client.js
  if (!existsSync(libDir)) mkdirSync(libDir, { recursive: true })
  const outPath = join(libDir, 'client.js')
  writeFileSync(outPath, clientOut, 'utf8')

  const sizeKB = (Buffer.byteLength(clientOut, 'utf8') / 1024).toFixed(1)
  console.log(`[build-ui] ✓ wrote ${outPath} (${sizeKB} KB)`)

  // 6. Quick sanity checks
  const checks = []
  if (panelHtml.includes('href="/plugins/dsh-ops/style.css"'))
    checks.push('WARNING: external CSS link still present')
  if (panelHtml.includes('src="/plugins/dsh-ops/app.js"'))
    checks.push('WARNING: external JS script still present')
  if (!clientOut.includes('__ModuleLoader__'))
    checks.push('WARNING: __ModuleLoader__ wrapper missing')
  if (checks.length) {
    checks.forEach(c => console.warn(`[build-ui] ${c}`))
    process.exit(1)
  }
  console.log('[build-ui] ✓ all checks passed')
} catch (err) {
  console.error('[build-ui] FAILED:', err.message || err)
  process.exit(1)
}
