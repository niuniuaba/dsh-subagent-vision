// browser-verify/server.mjs — harness HTTP server for the browser verification
// of dsh-subagent-vision.
//
// What is real here:
//   - client.js is served verbatim from the plugin package and executes in the
//     page, exactly as the dsh client module system would load it (the page
//     provides the `window.__ModuleLoader__` protocol the plugin expects).
//   - /subagent-vision/paste is handled by the REAL route handler captured
//     from the plugin's index.js: this file applies the plugin against stub
//     `llm` and `webServer` services (the same contract verify.mjs stubs),
//     keeps the registered route, and passes the live Node request/response
//     objects straight into the plugin's handler. The sniffing, 0600 temp-file
//     storage, verdict TTL cache and method guards are therefore the shipped
//     host code, not a reimplementation.
//
// What is stubbed (out of scope for a browser test):
//   - the `llm` service: resolveModelInfo answers from a driver-controlled
//     map (provider/model -> inputModalities); unknown entries throw, which
//     exercises the real textOnlyVerdict fallback.
//   - the GUI shell: the page carries one <textarea> standing in for the
//     composer, and the client object layer (sessions.list / connection.api)
//     is a minimal stub with the same shape the plugin calls.
//
// Control endpoints (test scaffolding only, never served by the plugin):
//   GET  /__verify/state     -> counters, POST statuses, stored temp paths
//   POST /__verify/llm       -> { provider, model, modalities[] | null }
//                               (null clears -> resolveModelInfo throws)
//   POST /__verify/route-get -> { code: 404 } makes the verdict GET 404
//                               (simulates the route vanishing mid-session)
//   POST /__verify/reset     -> restore the initial state
//
// Usage: node server.mjs --port <port>

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as plugin from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_JS = join(HERE, '..', 'client.js')

// ---- apply the REAL host plugin against stub services, capture the route ----
const llmMap = new Map() // `${provider}/${model}` -> inputModalities array
const stubLlm = {
  async resolveModelInfo(provider, model) {
    const mods = llmMap.get(`${provider}/${model}`)
    if (!mods) throw new Error(`no adapter for ${provider}/${model}`)
    return { provider, model, inputModalities: mods }
  },
}
const routes = []
const stubWebServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}
const stubCtx = {
  systemPrompt: { section() {} },
  inject(list, cb) {
    // Only the paste route's webServer injection is served here; the
    // settings/llm injection (vision-route section) is left unprovided so the
    // plugin's guard skips it.
    if (list.includes('webServer')) cb({ webServer: stubWebServer })
  },
  llm: stubLlm,
}
plugin.apply(stubCtx, {})
const pasteRoute = routes.find((r) => r.path === '/subagent-vision/paste')
if (!pasteRoute) {
  console.error('[browser-verify] plugin did not register /subagent-vision/paste')
  process.exit(1)
}

// ---- test scaffolding state ----
const state = {
  getCount: 0,
  postCount: 0,
  postStatuses: [], // status code of every POST handled by the plugin handler
  uploads: [], // temp paths the plugin handler returned
  routeGetCode: 200, // 404 simulates the route being gone
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// Wrap a ServerResponse so the plugin handler's writes are observable.
function instrumentRes(res) {
  const origWriteHead = res.writeHead.bind(res)
  const origEnd = res.end.bind(res)
  let status = 200
  res.writeHead = (code, headers) => {
    status = code
    return origWriteHead(code, headers)
  }
  res.end = (body, ...rest) => {
    try {
      if (typeof body === 'string') {
        const parsed = JSON.parse(body)
        if (parsed && typeof parsed.path === 'string') state.uploads.push(parsed.path)
      }
    } catch {
      /* not JSON — leave it */
    }
    state.postStatuses.push(status)
    return origEnd(body, ...rest)
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  try {
    // ---- the plugin's own route: live request/response through real handler ----
    if (path === '/subagent-vision/paste') {
      if (method === 'GET') {
        if (state.routeGetCode === 404) {
          res.writeHead(404).end()
          return
        }
        state.getCount += 1
      } else if (method === 'POST') {
        state.postCount += 1
        instrumentRes(res) // record POST statuses / returned paths only
      }
      await pasteRoute.handler(req, res)
      return
    }

    // ---- scaffolding ----
    if (path === '/__verify/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(state))
      return
    }
    if (path === '/__verify/llm' && method === 'POST') {
      const body = await readJsonBody(req)
      if (body.modalities == null) llmMap.delete(`${body.provider}/${body.model}`)
      else llmMap.set(`${body.provider}/${body.model}`, body.modalities)
      res.writeHead(200).end('{}')
      return
    }
    if (path === '/__verify/route-get' && method === 'POST') {
      const body = await readJsonBody(req)
      state.routeGetCode = body.code ?? 200
      res.writeHead(200).end('{}')
      return
    }
    if (path === '/__verify/reset' && method === 'POST') {
      llmMap.clear()
      state.getCount = 0
      state.postCount = 0
      state.postStatuses = []
      state.uploads = []
      state.routeGetCode = 200
      res.writeHead(200).end('{}')
      return
    }
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HARNESS_HTML)
      return
    }
    if (path === '/client.js') {
      const body = await readFile(CLIENT_JS, 'utf8')
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(body)
      return
    }
    res.writeHead(404).end('not found')
  } catch (error) {
    if (!res.writableEnded) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error?.message ?? error) }))
    }
  }
})

const HARNESS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-subagent-vision browser verify</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; }
  textarea { width: 92%; height: 84px; font: 14px/1.4 monospace; }
  h1 { font-size: 1.15rem; }
</style>
</head>
<body>
<h1>dsh-subagent-vision browser-verify harness</h1>
<p>Stand-in composer (the GUI's message textarea): paste or drop image files here.</p>
<textarea id="composer" placeholder="composer stand-in"></textarea>
<pre id="log"></pre>
<script>
  // The client-module protocol the real web shell provides: the plugin's
  // client.js calls window.__ModuleLoader__.load(...) at load time.
  window.__ModuleLoader__ = {
    entries: [],
    load(entry) { this.entries.push(entry) },
  }
</script>
<script src="/client.js"></script>
<script>
  // Boot the loaded client module with a stub client context of the same
  // shape the real client object layer exposes to client plugins.
  //
  // The harness simulates the composer's NATIVE intake (paste/drop -> draft
  // image attachments shown in the thumbnail rail) and the conversation
  // service, then exercises the plugin's send-time conversion.
  window.__verify = {
    session: 'verify-session',
    selection: null, // { provider, model } the models RPC reports
    booted: false,
    applyError: null,
    conversation: null, // set below
    draft: new Map(), // id -> { file, previewUrl }
    released: [], // draft ids released by send-time conversion
    sendCalls: [], // { text, imageIds, mode } as seen by the wrapped sendSession
  }
  ;(function boot() {
    try {
      var entry = window.__ModuleLoader__.entries.find(function (e) { return e.id === 'dsh-subagent-vision' })
      if (!entry) { window.__verify.applyError = 'client module not registered'; return }
      var mod = entry.factory(function () { return {} })
      var draft = window.__verify.draft
      var conversation = {
        // The composer's native intake registers a browser draft attachment
        // (preview URL + file) per image; the harness mimics that.
        createDraftImage: function (file) {
          var id = 'draft-' + (draft.size + 1)
          draft.set(id, { file: file, previewUrl: URL.createObjectURL(file) })
          return id
        },
        draftImages: function (ids) {
          var out = []
          for (var i = 0; i < ids.length; i++) {
            var att = draft.get(ids[i])
            if (att !== void 0) out.push(att)
          }
          return out
        },
        releaseDraftImage: function (id) {
          draft.delete(id)
          window.__verify.released.push(id)
        },
        releaseDraftImages: function (attachments) {
          for (var i = 0; i < attachments.length; i++) {
            for (var key of draft.keys()) {
              if (draft.get(key) === attachments[i]) {
                draft.delete(key)
                window.__verify.released.push(key)
                break
              }
            }
          }
        },
        sendSession: async function (session, text, imageIds, mode) {
          window.__verify.sendCalls.push({ text: text, imageIds: imageIds.slice(), mode: mode })
          return { ok: true }
        },
      }
      window.__verify.conversation = conversation
      var ctx = {
        effect: function (fn) { this._cleanup = fn() },
        conversation: conversation,
        sessions: {
          list: {
            getSnapshot: function () { return { current: window.__verify.session } },
          },
        },
        connection: {
          api: {
            sessions: {
              models: function (params) {
                // RPC envelopes carry { result: { ok, value } }.
                return Promise.resolve({ result: { ok: true, value: { current: window.__verify.selection } } })
              },
            },
          },
        },
      }
      mod.apply(ctx)
      window.__verify.booted = true
    } catch (e) {
      window.__verify.applyError = String((e && e.stack) || e)
    }
  })()
</script>
</body>
</html>
`

const portArg = process.argv.indexOf('--port')
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 0
server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  console.log(`[browser-verify] harness server on http://127.0.0.1:${actual}`)
})
