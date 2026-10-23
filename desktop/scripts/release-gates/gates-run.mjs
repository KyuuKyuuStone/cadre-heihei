#!/usr/bin/env node
/**
 * release-gates runner — 发布必过项（Q10）可自动化部分的一键执行器。
 *
 * 用法：
 *   node gates-run.mjs --exe "<exe 路径>" --out <证据目录>
 *     [--port 9341] [--user-data <dir>] [--home <dir>]
 *     [--gates start,session,employee,theme,tray,update,upgrade]
 *     [--upgrade-from <旧版 user-data 目录>] [--seed-key]   # seed 用 DEEPSEEK_API_KEY 环境变量
 *
 * 产出：<out>/gates-report.json（raw，含每项 ok/evidence/截图路径）
 * 手动项（安装、托盘图标视觉、更新按钮点击）见 docs/dev/release-gates.md 的勾选表。
 *
 * 原则：判定失败的项如实写 FAIL，不粉饰；清理进程树；user-data 每次独立。
 */
import { spawn, execSync } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
const { readFileSync, writeFileSync, mkdirSync, cpSync, appendFileSync } = fs

// Node 24 全局 WebSocket（undici）即可：截图 base64 在百 KB 级，默认帧上限足够
const WebSocket = globalThis.WebSocket

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const EXE = arg('exe')
const OUT = arg('out')
if (!EXE || !OUT) { console.error('usage: node gates-run.mjs --exe <exe> --out <dir> [--gates ...] [--upgrade-from <dir>]'); process.exit(2) }
const PORT = Number(arg('port', '9341'))
const GATES = (arg('gates', 'start,session,employee,theme,tray,update,upgrade')).split(',')
const USER_DATA = path.resolve(arg('user-data', path.join(OUT, 'user-data')))
const HOME = path.resolve(arg('home', path.join(OUT, 'home')))
const UPGRADE_FROM = arg('upgrade-from')
mkdirSync(OUT, { recursive: true })
mkdirSync(USER_DATA, { recursive: true })
mkdirSync(HOME, { recursive: true })
const LOG = path.join(OUT, 'gates-log.txt')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const say = (k, v) => { const line = `[${k}] ${typeof v === 'string' ? v : JSON.stringify(v)}`; console.log(line); appendFileSync(LOG, line + '\n') }
appendFileSync(LOG, `\n==== release-gates run ${new Date().toISOString()} exe=${EXE} ====\n`)

// 升级 gate：把旧版 user-data 复制为本轮 user-data（在 spawn 之前）
const HOME_FROM = arg('home-from')
if (GATES.includes('upgrade') && UPGRADE_FROM) {
  say('upgrade-seed', { from: UPGRADE_FROM, into: USER_DATA, homeFrom: HOME_FROM || '(fresh home)' })
  cpSync(UPGRADE_FROM, USER_DATA, { recursive: true, force: true })
  if (HOME_FROM) {
    mkdirSync(HOME, { recursive: true })
    cpSync(HOME_FROM, HOME, { recursive: true, force: true })
  }
}

function httpGetJSON(url) { return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 3000); fetch(url).then(r => r.json()).then(j => { clearTimeout(t); resolve(j) }).catch(e => { clearTimeout(t); reject(e) }) }) }
async function waitPort(n) { for (let i = 0; i < n; i++) { try { await httpGetJSON(`http://127.0.0.1:${PORT}/json/version`); return true } catch { await sleep(500) } } return false }
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0; const pending = new Map(); const listeners = []
    const api = {
      send: (m, p = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method: m, params: p })) }),
      on: fn => listeners.push(fn), close: () => { try { ws.close() } catch {} },
    }
    ws.onopen = () => resolve(api)
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return }; if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } else if (m.method) for (const fn of listeners) fn(m) }
    ws.onerror = ev => reject(new Error('ws error'))
  })
}

const mainLog = fs.createWriteStream(path.join(OUT, 'main-process.log'), { flags: 'w' })
const child = spawn(EXE, ['--remote-debugging-port=' + PORT, '--start-minimized', '--user-data-dir=' + USER_DATA], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, DSH_HOME: HOME } })
const pid = child.pid
say('pid', pid)
child.stdout.on('data', d => mainLog.write('[stdout] ' + d))
child.stderr.on('data', d => mainLog.write('[stderr] ' + d))
const report = { startedAt: new Date().toISOString(), exe: EXE, pid, userDataType: UPGRADE_FROM && GATES.includes('upgrade') ? 'upgraded-from:' + UPGRADE_FROM : 'fresh', gates: {} }
const consoleEntries = []
let CDP, q, shot

try {
  if (!await waitPort(240)) throw new Error('CDP never ready')
  await sleep(5000)
  const targets = await httpGetJSON(`http://127.0.0.1:${PORT}/json/list`)
  const app = targets.find(t => t.type === 'page' && /dsh-app|^file:/i.test(t.url)) || targets[0]
  if (!app) throw new Error('no page target')
  CDP = await connect(app.webSocketDebuggerUrl)
  CDP.on(m => {
    if (m.method === 'Runtime.consoleAPICalled') consoleEntries.push({ ts: Date.now(), type: m.params.type, text: (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 800) })
    else if (m.method === 'Runtime.exceptionThrown') consoleEntries.push({ ts: Date.now(), type: 'exception', text: String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 800) })
    else if (m.method === 'Log.entryAdded') consoleEntries.push({ ts: Date.now(), type: 'log.' + m.params.entry.level, text: String(m.params.entry.text).slice(0, 800) })
  })
  await CDP.send('Runtime.enable'); await CDP.send('Page.enable'); await CDP.send('Log.enable')
  q = async ex => { const r = await CDP.send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) { say('eval-err', r.exceptionDetails.exception?.description); return null } return r.result?.value }
  shot = async n => { for (let t = 0; t < 3; t++) { try { await CDP.send('Page.bringToFront', {}); await sleep(400); const s = await Promise.race([CDP.send('Page.captureScreenshot', { format: 'png' }), new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 9000))]); if (s.data) { writeFileSync(path.join(OUT, n), Buffer.from(s.data, 'base64')); return 'ok' } } catch { await sleep(1000) } } return 'fail' }

  const seedProvider = async () => {
    const key = process.env.DEEPSEEK_API_KEY || (/^DEEPSEEK_API_KEY=(.+)$/m.exec(readFileSync('D:/xxw_p/cadre-spike-env/.secrets/deepseek.env', 'utf8'))?.[1]?.trim())
    if (!key) return { ok: false, reason: 'no key' }
    for (let i = 0; i < 10; i++) {
      const save = await q(`window.cadre.saveProvider(${JSON.stringify({ providerId: 'prov-gates', name: 'Gates DeepSeek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: key, defaultModel: 'deepseek-chat', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }], enabled: true, isDefault: true })})`)
      if (save?.ok === true) return { ok: true }
      await sleep(3000)
    }
    return { ok: false, reason: 'credential service not ready after retries' }
  }
  const closeDialog = async () => { await q(`(() => { const b=[...document.querySelectorAll('[role="dialog"] button')].find(b=>['完成','关闭','取消'].includes((b.textContent||'').trim())); b?.click(); return !!b })()`); await sleep(900) }
  const openSettings = async tab => { await q(`(() => { const b=[...document.querySelectorAll('button, [role="tab"]')].find(x=>(x.textContent||'').trim()==='设置'); b?.click(); return !!b })()`); await sleep(1600); if (tab) { await q(`(() => { const b=[...document.querySelectorAll('button, [role="tab"]')].find(x=>(x.textContent||'').trim()===${JSON.stringify(tab)}); b?.click(); return !!b })()`); await sleep(1600) } }
  const newSession = async () => { await q(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='在“默认工作区”中新建会话'); b?.click(); return !!b })()`); await sleep(2200); return q(`(() => { const rows=[...document.querySelectorAll('[data-row-key^="session:"]')]; const r=rows.find(x=>/^新会话/.test((x.textContent||'').trim()))||rows[0]; return r?.getAttribute('data-row-key')?.slice(8) })()`) }

  // ===== gate: start =====
  if (GATES.includes('start')) {
    const c = await q(`(() => { const root=document.querySelector('#root')||document.body; return { title: document.title, rootHtmlLen: root.innerHTML.length, bodyTextLen: (document.body.innerText||'').length } })()`)
    const errs = consoleEntries.filter(e => e.type === 'exception' || e.type === 'error' || e.type === 'log.error')
    const mlog = readFileSync(path.join(OUT, 'main-process.log'), 'utf8')
    const collabUnavailable = /cadre-collab unavailable/i.test(mlog)
    report.gates.start = { ok: !!c?.title && c.rootHtmlLen > 50 && c.bodyTextLen > 0 && errs.length === 0 && !collabUnavailable, evidence: { page: c, consoleErrors: errs.length, collabUnavailable }, screenshot: await shot('gate-start.png') }
    say('gate-start', { ok: report.gates.start.ok, consoleErrors: errs.length, collabUnavailable })
  }

  // ===== gate: session =====
  if (GATES.includes('session')) {
    const seeded = await seedProvider()
    say('seed', seeded)
    const sid = await newSession()
    await q(`(() => { const el=document.querySelector('[contenteditable="true"]'); el?.focus(); return !!el })()`)
    await CDP.send('Input.insertText', { text: '只回复两个字：收到' })
    await sleep(400)
    await q(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='发送消息'); b?.click(); return !!b })()`)
    await sleep(20000)
    const tail = await q(`(() => { const d=document.querySelector('[role="dialog"]'); if(d) d.remove(); return (document.querySelector('main')||document.body).innerText.slice(-300) })()`)
    const replied = /收到/.test(tail || '')
    report.gates.session = { ok: !!sid && replied, evidence: { sessionId: sid, tail: (tail || '').slice(-120), seeded } }
    say('gate-session', { ok: report.gates.session.ok, sid })
    await shot('gate-session.png')
  }

  // ===== gate: employee =====
  if (GATES.includes('employee')) {
    const sid = await newSession()
    await q(`(() => { const row=document.querySelector('[data-row-key^="session:"]'); const b=row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:b.left+40,clientY:b.top+8})); return true })()`)
    await sleep(1800)
    const tpl = await q(`[...document.querySelectorAll('[role="dialog"] [aria-label="员工模板"] button')].map(b=>({t:(b.textContent||'').trim().slice(0,18), d:b.disabled}))`)
    const dlgNotFound = /未发现/.test(await q(`document.querySelector('[role="dialog"]')?.innerText ?? ''`) || '')
    await q(`(() => { const el=document.querySelector('#cadre-employee-name'); if(!el) return false
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
      setter.call(el,'Gates验证员工'); el.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
    await q(`(() => { const b=[...document.querySelectorAll('[role="dialog"] [aria-label="员工模板"] button')].find(b=>b.textContent?.includes('角色扮演')); b?.click(); return !!b })()`)
    await q(`(() => { const b=[...document.querySelectorAll('[role="dialog"] [aria-label="员工模型"] button')].find(b=>b.textContent?.trim()==='deepseek-chat'); b?.click(); return !!b })()`)
    await q(`(() => { const b=[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.textContent?.trim()==='保存'); b?.click(); return !!b })()`)
    await sleep(6000)
    const emp = sid ? await q(`window.cadre.getEmployee({sessionId:${JSON.stringify(sid)}})`) : null
    const readback = emp?.employee?.templateId === 'cadre-roleplay'
    await closeDialog()
    await openSettings('员工')
    const empPage = await q(`document.querySelector('[role="dialog"]')?.innerText ?? ''`)
    const listed = /Gates验证员工/.test(empPage || '')
    await closeDialog()
    report.gates.employee = { ok: (tpl || []).length === 4 && !dlgNotFound && readback && listed, evidence: { templateCount: (tpl || []).length, names: (tpl || []).map(x => x.t), notFoundWording: dlgNotFound, readback: emp, listed }, screenshot: await shot('gate-employee.png') }
    say('gate-employee', { ok: report.gates.employee.ok, tplCount: (tpl || []).length, readback, listed })
  }

  // ===== gate: theme + tray =====
  if (GATES.includes('theme') || GATES.includes('tray')) {
    const readColors = `(() => { const bg = el => el ? getComputedStyle(el).backgroundColor : null; const sidebar=document.querySelector('nav, aside, [class*="idebar"]'); return { body: bg(document.body), sidebar: bg(sidebar) } })()`
    await openSettings()
    const lightClick = await q(`(() => { const d=document.querySelector('[role="dialog"]'); const b=[...(d||document).querySelectorAll('button')].find(x => (x.textContent || '').trim() === '浅色'); b?.click(); return !!b })()`)
    await sleep(2200)
    const light = await q(readColors)
    await q(`(() => { const d=document.querySelector('[role="dialog"]'); const b=[...(d||document).querySelectorAll('button')].find(x => (x.textContent || '').trim() === '深色'); b?.click(); return !!b })()`)
    await sleep(2200)
    const dark = await q(readColors)
    const themeOk = !!lightClick && light?.body && dark?.body && light.body !== dark.body && light.body !== 'rgba(0, 0, 0, 0)'
    const brandLight = light?.body === 'rgb(246, 240, 225)'
    const brandDark = dark?.body === 'rgb(32, 29, 23)'
    await shot('gate-theme-dark.png')
    if (GATES.includes('tray')) {
      const mlog = readFileSync(path.join(OUT, 'main-process.log'), 'utf8')
      const trayLines = mlog.split('\n').filter(l => /desktop tray:/.test(l)).slice(-4)
      const trayOk = /theme=light/.test(trayLines.join('\n')) && /theme=dark/.test(trayLines.join('\n'))
      report.gates.tray = { ok: trayOk, evidence: { trayLines, note: '图标视觉请对照手动清单' } }
      say('gate-tray', { ok: trayOk, lines: trayLines.length })
    }
    // 恢复浅色结束前再截一张（对照）
    await q(`(() => { const d=document.querySelector('[role="dialog"]'); const b=[...(d||document).querySelectorAll('button')].find(x => (x.textContent || '').trim() === '浅色'); b?.click(); return !!b })()`)
    await sleep(1500)
    await closeDialog()
    report.gates.theme = { ok: themeOk, evidence: { light, dark, brandLightMatch: brandLight, brandDarkMatch: brandDark }, screenshots: ['gate-theme-dark.png'] }
    say('gate-theme', { ok: themeOk, brandLight, brandDark })
  }

  // ===== gate: update（自动部分）=====
  if (GATES.includes('update')) {
    await openSettings()
    const settingsText = (await q(`document.querySelector('[role="dialog"]')?.innerText || ''`)) || ''
    const versionDisplay = /当前版本：/.test(settingsText)
    const versionValue = (settingsText.match(/当前版本：([0-9.]+)/) || [])[1] || null
    const mlog = readFileSync(path.join(OUT, 'main-process.log'), 'utf8')
    const updateErrors = mlog.split('\n').filter(l => /update|updater/i.test(l) && /error|fail|crash/i.test(l)).slice(0, 5)
    await closeDialog()
    report.gates.update = { ok: versionDisplay && updateErrors.length === 0, evidence: { versionDisplay, versionValue, updateErrors }, note: '0.5.x 设置页无「检查更新」按钮（自动更新通道默认禁用）；手动项=确认「当前版本」显示正确' }
    say('gate-update', { ok: report.gates.update.ok, versionValue })
  }

  // ===== gate: upgrade =====
  if (GATES.includes('upgrade')) {
    const rows = await q(`[...document.querySelectorAll('[data-row-key^="session:"]')].map(r=>({key:r.getAttribute('data-row-key').slice(8,28), t:(r.textContent||'').trim().slice(0,20)}))`)
    await openSettings('员工')
    const empPage = await q(`document.querySelector('[role="dialog"]')?.innerText ?? ''`)
    await closeDialog()
    const mlog = readFileSync(path.join(OUT, 'main-process.log'), 'utf8')
    const migrationErrors = mlog.split('\n').filter(l => /migrat|schema|sqlite/i.test(l) && /error|fail/i.test(l)).slice(0, 6)
    const startOk = report.gates.start?.ok !== false
    report.gates.upgrade = { ok: startOk && migrationErrors.length === 0, evidence: { sessions: rows, employeePage: empPage.slice(0, 400), migrationErrors }, screenshot: await shot('gate-upgrade-employee.png') }
    say('gate-upgrade', { ok: report.gates.upgrade.ok, sessions: (rows || []).length, migrationErrors: migrationErrors.length })
  }

  writeFileSync(path.join(OUT, 'console-entries.json'), JSON.stringify(consoleEntries, null, 2))
} catch (e) {
  report.fatal = e.message
  say('fatal', e.message)
}

try { execSync(`taskkill /PID ${pid} /T /F 2>&1`, { encoding: 'utf8', shell: true }) } catch {}
await sleep(1500)
let residue = ''
try { residue = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*win-unpacked*' } | Select-Object ProcessId | ConvertTo-Json -Compress"`, { encoding: 'utf8' }) } catch {}
report.finishedAt = new Date().toISOString()
report.residue = residue
writeFileSync(path.join(OUT, 'gates-report.json'), JSON.stringify(report, null, 2))
mainLog.end()
console.log('SUMMARY=' + JSON.stringify(Object.fromEntries(Object.entries(report.gates).map(([k, v]) => [k, v.ok]))))
process.exit(0)
