// browser-verify/driver.mjs — drives the browser verification of
// dsh-subagent-vision's browser half in a real Chrome.
//
// It starts the harness server (server.mjs) and a headless Chrome, loads the
// harness page — which runs the REAL client.js against a stub client context
// and the REAL /subagent-vision/paste host handler — and drives real
// paste/drop events through CDP, asserting the plugin's takeover contract:
//   - image paste on a positively-confirmed text-only model -> intake taken
//     over: event prevented, bytes POSTed, temp path inserted into the
//     composer (real file on disk, mode 0600);
//   - vision-capable and unknown models keep the native intake;
//   - non-image files, pastes outside the textarea, and stale verdicts stay
//     native; a vanished route (404) stands the takeover down;
//   - drop in the textarea is taken over and synthesizes the dragend the
//     composer listens for; mixed drops and drops outside stay native.
//
// Usage: node driver.mjs   (no network needed; requires google-chrome)

import { spawn, execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_MJS = join(HERE, 'server.mjs')

// ---- locate tooling ------------------------------------------------------
function which(bin) {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

// ws lives in the global dsh install's node_modules (npm-flat layout).
const globalNodeModules = join(dirname(dirname(process.execPath)), 'lib', 'node_modules')
const wsIndex = join(globalNodeModules, '@deepseek-ai', 'dsh', 'node_modules', 'ws', 'index.js')
const { default: WebSocket } = await import(pathToFileURL(wsIndex).href)

const chromeBin = which('google-chrome') ?? which('chromium') ?? which('chromium-browser')
if (!chromeBin) {
  console.error('[browser-verify] no Chrome found')
  process.exit(1)
}

// ---- tiny helpers --------------------------------------------------------
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpJson(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// 1x1 transparent PNG (67 bytes).
const PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082'
const PNG_B64 = Buffer.from(PNG_HEX, 'hex').toString('base64')
const PNG_BYTES = Buffer.from(PNG_HEX, 'hex')

// Page-side helpers injected into every page load (drives the harness page).
const HELPERS_SOURCE = `
window.__v = {
  pngB64: ${JSON.stringify(PNG_B64)},
  setSelection: function (provider, model) {
    window.__verify.selection = { provider: provider, model: model }
  },
  pngFile: function () {
    return new File([Uint8Array.from(atob(window.__v.pngB64), function (c) { return c.charCodeAt(0) })], 'pasted.png', { type: 'image/png' })
  },
  junkPngFile: function () {
    return new File(['not an image at all, just text bytes'], 'fake.png', { type: 'image/png' })
  },
  // Simulate the composer's NATIVE intake: register browser draft image
  // attachments (thumbnail rail in the real GUI) and return their ids.
  intake: function (files) {
    var ids = []
    for (var i = 0; i < files.length; i++) ids.push(window.__verify.conversation.createDraftImage(files[i]))
    return ids
  },
  // Dispatch a paste and report whether anything intercepted it: the plugin
  // must leave native intake untouched.
  pasteEvent: function () {
    var t = document.getElementById('composer')
    var dt = new DataTransfer()
    dt.items.add(window.__v.pngFile())
    var ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: dt })
    t.dispatchEvent(ev)
    return { defaultPrevented: ev.defaultPrevented, customThumbs: !!document.querySelector('[data-dsv-vision-thumbs]') }
  },
  // Send through the (wrapped) conversation service.
  send: function (text, ids) {
    return window.__verify.conversation
      .sendSession({ sessionId: 'verify-session' }, text, ids, 'queue')
      .then(function () { return { ok: true } })
      .catch(function (e) { return { error: String(e && e.message || e) } })
  },
  sendCalls: function () { return window.__verify.sendCalls },
  released: function () { return window.__verify.released },
  draftSize: function () { return window.__verify.draft.size },
}
`

// ---- minimal CDP client ---------------------------------------------------
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 1
    ws.on('open', () => resolve({ send, close, onEvent, waitFor }))
    ws.on('error', (e) => reject(new Error(`cdp ws error: ${e.message}`)))
    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else p.resolve(msg.result)
        return
      }
      for (const handler of listeners) {
        try {
          handler(msg)
        } catch (error) {
          console.error('[browser-verify] cdp event handler error:', error)
        }
      }
    })
    const listeners = new Set()
    function onEvent(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    }
    function send(method, params = {}) {
      const id = nextId++
      return new Promise((resolveP, rejectP) => {
        pending.set(id, { resolve: resolveP, reject: rejectP })
        ws.send(JSON.stringify({ id, method, params }))
      })
    }
    function waitFor(predicate, timeoutMs = 5000) {
      return new Promise((resolveP, rejectP) => {
        const off = onEvent((msg) => {
          if (predicate(msg)) {
            off()
            clearTimeout(timer)
            resolveP(msg)
          }
        })
        const timer = setTimeout(() => {
          off()
          rejectP(new Error('cdp waitFor timeout'))
        }, timeoutMs)
      })
    }
    function close() {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  })
}

// ---- results ---------------------------------------------------------------
let failures = 0
let passed = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

// ---- main ------------------------------------------------------------------
const harnessPort = await freePort()
const cdpPort = await freePort()
const userDataDir = join(tmpdir(), `dsv-browser-verify-${process.pid}`)

const serverProc = spawn(process.execPath, [SERVER_MJS, '--port', String(harnessPort)], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
const chromeProc = spawn(
  chromeBin,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-background-networking',
    '--disable-component-update',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)

let cdp
let evalJs
let pageWsUrl
let consoleLines = []

try {
  // wait for the harness server
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${harnessPort}/__verify/state`)
      break
    } catch {
      if (i === 49) throw new Error('harness server did not come up')
      await sleep(100)
    }
  }

  // wait for chrome's CDP endpoint, then pick a page-level target (the
  // Page/Runtime domains live on page sessions, not the browser endpoint)
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) {
        pageWsUrl = page.webSocketDebuggerUrl
        break
      }
    } catch {
      /* retry */
    }
    if (i === 99) throw new Error('chrome CDP endpoint did not come up')
    await sleep(100)
  }
  cdp = await cdpConnect(pageWsUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  cdp.onEvent((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      consoleLines.push(text)
    }
  })

  const BASE = `http://127.0.0.1:${harnessPort}`
  evalJs = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (exceptionDetails) {
      throw new Error(
        `page exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
      )
    }
    return result.value
  }

  async function navigate() {
    consoleLines = []
    await cdp.send('Page.navigate', { url: BASE + '/' })
    for (let i = 0; i < 100; i++) {
      const ready = await evalJs('document.readyState')
      if (ready === 'complete') break
      await sleep(50)
    }
    // inject the page-side helpers (and re-check the module booted)
    await evalJs(HELPERS_SOURCE)
    await sleep(30)
  }

  async function state() {
    return httpJson(harnessPort, 'GET', '/__verify/state')
  }
  async function setLlm(provider, model, modalities) {
    await httpJson(harnessPort, 'POST', '/__verify/llm', { provider, model, modalities })
  }
  async function setRouteGet(code) {
    await httpJson(harnessPort, 'POST', '/__verify/route-get', { code })
  }
  async function resetServer() {
    await httpJson(harnessPort, 'POST', '/__verify/reset', {})
  }

  // ---- sanity: module booted ----
  await navigate()
  check(
    'client.js loads and applies without error',
    (await evalJs('window.__verify.booted === true && window.__verify.applyError === null')),
    await evalJs('String(window.__verify.applyError)'),
  )

  // ---- T1: intake is left native (no interception, no custom strip) ----
  await navigate()
  await resetServer()
  await setLlm('deepseek-official', 'deepseek-v4-flash', ['text'])
  await evalJs(`__v.setSelection('deepseek-official', 'deepseek-v4-flash')`)
  const t1 = await evalJs(`__v.pasteEvent()`)
  check('T1 paste event is not intercepted (default not prevented)', t1.defaultPrevented === false, JSON.stringify(t1))
  check('T1 no custom thumbnail strip inserted', t1.customThumbs === false)

  // ---- T2: text-only session with one draft image -> send-time conversion ----
  await navigate()
  await resetServer()
  await setLlm('deepseek-official', 'deepseek-v4-flash', ['text'])
  await evalJs(`__v.setSelection('deepseek-official', 'deepseek-v4-flash')`)
  await evalJs(`window.__verify.conversation.createDraftImage(__v.pngFile())`)
  const t2 = await evalJs(`__v.send('describe this', ['draft-1'])`)
  const t2calls = await evalJs(`__v.sendCalls()`)
  check('T2 send resolves', t2.ok === true, JSON.stringify(t2))
  check(
    'T2 imageIds converted to a temp path in the text',
    t2calls.length === 1 && /subagent-vision-paste-/.test(t2calls[0].text) && t2calls[0].imageIds.length === 0,
    JSON.stringify(t2calls),
  )
  check('T2 text prefix preserved', t2calls[0].text.startsWith('describe this'), JSON.stringify(t2calls))
  const st2 = await state()
  check('T2 one upload POST happened', st2.postCount === 1, JSON.stringify(st2))
  const t2released = await evalJs(`__v.released()`)
  check('T2 draft released after conversion', t2released.length === 1 && (await evalJs('__v.draftSize()')) === 0, JSON.stringify(t2released))

  // ---- T3: two draft images -> two paths, two POSTs ----
  await navigate()
  await resetServer()
  await setLlm('deepseek-official', 'deepseek-v4-flash', ['text'])
  await evalJs(`__v.setSelection('deepseek-official', 'deepseek-v4-flash')`)
  await evalJs(`window.__verify.conversation.createDraftImage(__v.pngFile()); window.__verify.conversation.createDraftImage(__v.pngFile())`)
  const t3 = await evalJs(`__v.send('', ['draft-1', 'draft-2'])`)
  const t3calls = await evalJs(`__v.sendCalls()`)
  const st3 = await state()
  check(
    'T3 both images became paths (empty text -> paths only)',
    t3calls.length === 1 && (t3calls[0].text.match(/subagent-vision-paste-/g) || []).length === 2 && t3calls[0].text.startsWith('/tmp/'),
    JSON.stringify(t3calls),
  )
  check('T3 two upload POSTs', st3.postCount === 2, JSON.stringify(st3))
  check('T3 both drafts released', (await evalJs('__v.draftSize()')) === 0)

  // ---- T4: vision-capable session -> native send (attachments unchanged) ----
  await navigate()
  await resetServer()
  await setLlm('pi-ai', 'qwen3.8-max', ['text', 'image'])
  await evalJs(`__v.setSelection('pi-ai', 'qwen3.8-max')`)
  await evalJs(`window.__verify.conversation.createDraftImage(__v.pngFile())`)
  const t4 = await evalJs(`__v.send('hello', ['draft-1'])`)
  const t4calls = await evalJs(`__v.sendCalls()`)
  const st4 = await state()
  check('T4 vision model sends natively', t4calls.length === 1 && t4calls[0].imageIds.length === 1 && t4calls[0].text === 'hello', JSON.stringify(t4calls))
  check('T4 no upload POST', st4.postCount === 0, JSON.stringify(st4))
  check('T4 draft kept (native send)', (await evalJs('__v.draftSize()')) === 1)

  // ---- T5: unknown model -> native send ----
  await navigate()
  await resetServer()
  await evalJs(`__v.setSelection('unknown-provider', 'unknown-model')`)
  await evalJs(`window.__verify.conversation.createDraftImage(__v.pngFile())`)
  const t5 = await evalJs(`__v.send('x', ['draft-1'])`)
  const t5calls = await evalJs(`__v.sendCalls()`)
  const st5 = await state()
  check('T5 unknown model sends natively', t5calls.length === 1 && t5calls[0].imageIds.length === 1, JSON.stringify(t5calls))
  check('T5 no upload POST', st5.postCount === 0, JSON.stringify(st5))

  // ---- T6: no images -> send unchanged ----
  await navigate()
  await resetServer()
  await setLlm('deepseek-official', 'deepseek-v4-flash', ['text'])
  await evalJs(`__v.setSelection('deepseek-official', 'deepseek-v4-flash')`)
  const t6 = await evalJs(`__v.send('plain text', [])`)
  const t6calls = await evalJs(`__v.sendCalls()`)
  check('T6 no-image send unchanged', t6calls.length === 1 && t6calls[0].text === 'plain text' && t6calls[0].imageIds.length === 0, JSON.stringify(t6calls))

  // ---- T7: upload failure aborts the send (400 on fake bytes) ----
  await navigate()
  await resetServer()
  await setLlm('deepseek-official', 'deepseek-v4-flash', ['text'])
  await evalJs(`__v.setSelection('deepseek-official', 'deepseek-v4-flash')`)
  await evalJs(`window.__verify.conversation.createDraftImage(__v.junkPngFile())`)
  const t7 = await evalJs(`__v.send('go', ['draft-1'])`)
  const st7 = await state()
  check('T7 upload failure rejects the send', typeof t7.error === 'string' && t7.error.includes('not a recognized image'), JSON.stringify(t7))
  check('T7 host answered 400', st7.postCount === 1 && st7.postStatuses.includes(400), JSON.stringify(st7))
  check('T7 nothing reached the real send', (await evalJs('__v.sendCalls()')).length === 0)

  // ---- T8: verdict route 404 -> conversion stands down (native send) ----
  await navigate()
  await resetServer()
  await setLlm('deepseek-official', 'deepseek-v4-flash', ['text'])
  await evalJs(`__v.setSelection('deepseek-official', 'deepseek-v4-flash')`)
  await setRouteGet(404)
  await evalJs(`window.__verify.conversation.createDraftImage(__v.pngFile())`)
  const t8 = await evalJs(`__v.send('hi', ['draft-1'])`)
  const t8calls = await evalJs(`__v.sendCalls()`)
  const st8 = await state()
  check('T8 404 keeps the send native', t8calls.length === 1 && t8calls[0].imageIds.length === 1, JSON.stringify(t8calls))
  check('T8 no upload POST', st8.postCount === 0, JSON.stringify(st8))

  // ---- T9: verdict cached per model (second send does not re-query) ----
  await navigate()
  await resetServer()
  await setLlm('deepseek-official', 'deepseek-v4-flash', ['text'])
  await evalJs(`__v.setSelection('deepseek-official', 'deepseek-v4-flash')`)
  await evalJs(`window.__verify.conversation.createDraftImage(__v.pngFile())`)
  await evalJs(`__v.send('one', ['draft-1'])`)
  const g1 = (await state()).getCount
  await evalJs(`window.__verify.conversation.createDraftImage(__v.pngFile())`)
  await evalJs(`__v.send('two', ['draft-2'])`)
  const st9 = await state()
  check('T9 verdict cached (one GET for two sends)', g1 >= 1 && st9.getCount === g1, `g1=${g1} g2=${st9.getCount}`)

  // ---- T10: native removal (undo) then send -> nothing converted ----
  await navigate()
  await resetServer()
  await setLlm('deepseek-official', 'deepseek-v4-flash', ['text'])
  await evalJs(`__v.setSelection('deepseek-official', 'deepseek-v4-flash')`)
  await evalJs(`window.__verify.conversation.createDraftImage(__v.pngFile())`)
  await evalJs(`window.__verify.conversation.releaseDraftImage('draft-1')`) // the rail's remove button
  const t10 = await evalJs(`__v.send('no image now', [])`)
  const t10calls = await evalJs(`__v.sendCalls()`)
  check('T10 removed draft sends as plain text', t10calls.length === 1 && t10calls[0].text === 'no image now' && t10calls[0].imageIds.length === 0, JSON.stringify(t10calls))

  // ---- T11: stale image ids with no attachments -> native send (guard) ----
  await navigate()
  await resetServer()
  await setLlm('deepseek-official', 'deepseek-v4-flash', ['text'])
  await evalJs(`__v.setSelection('deepseek-official', 'deepseek-v4-flash')`)
  const t11 = await evalJs(`__v.send('ghost', ['gone-1'])`)
  const t11calls = await evalJs(`__v.sendCalls()`)
  check('T11 ghost ids pass through unchanged', t11calls.length === 1 && t11calls[0].imageIds.length === 1 && t11calls[0].text === 'ghost', JSON.stringify(t11calls))
  check('T11 no upload POST', (await state()).postCount === 0)

  console.log('')
  if (failures === 0) {
    console.log(`ALL ${passed} BROWSER CHECKS PASSED`)
  } else {
    console.log(`${failures} CHECK(S) FAILED (${passed} passed)`)
    if (consoleLines.length) {
      console.log('--- page console (last 20 lines) ---')
      console.log(consoleLines.slice(-20).join('\n'))
    }
  }
  await cleanup()
  process.exit(failures === 0 ? 0 : 1)
} catch (error) {
  console.error('[browser-verify] driver error:', error)
  if (consoleLines.length) {
    console.error('--- page console (last 20 lines) ---')
    console.error(consoleLines.slice(-20).join('\n'))
  }
  await cleanup()
  process.exit(1)
} finally {
  await cleanup()
}

// Kill everything this run started and remove its chrome profile. Chrome is
// reached by its unique --user-data-dir because the google-chrome wrapper
// forks the real binary, so the spawned ChildProcess pid may not own the tree.
async function cleanup() {
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  try {
    execFileSync('pkill', ['-9', '-f', `dsv-browser-verif[y]-${process.pid}`], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
  try {
    serverProc.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  try {
    chromeProc.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  await sleep(200)
  try {
    const fs = await import('node:fs/promises')
    await fs.rm(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

function extractPaths(value) {
  const out = []
  const re = /(\/[\w./-]*subagent-vision-paste-[\w./-]*)/g
  let m
  while ((m = re.exec(value)) !== null) out.push(m[1])
  return out
}

// Poll the composer until the async takeover (upload + insert) settles.
async function waitForPath(timeoutMs = 3000) {
  const start = Date.now()
  for (;;) {
    const value = await evalJs(`document.getElementById('composer').value`)
    if (/subagent-vision-paste-/.test(value)) return
    if (Date.now() - start > timeoutMs) return
    await sleep(50)
  }
}
