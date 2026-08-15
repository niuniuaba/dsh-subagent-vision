// verify-settings.mjs — node-level verification of the vision-route settings
// feature added to dsh-subagent-vision's host plugin.
//
// Runs the REAL apply() against a real @deepseek-ai/cordis Context with stub
// llm/settings/loader/webServer services, and asserts:
//   1. the guide prompt section still registers;
//   2. the settings section registers under the subagent-vision namespace;
//   3. the section's schema offers a select whose options are exactly the
//      configured models that declare image input (provider/model routes);
//   4. registering syncs the tool row's agentOptions when it differs;
//   5. changing the setting re-syncs the tool row (maxTokens preserved);
//   6. a route whose model cannot resolve, or does not declare image input,
//      is refused and the tool row is left alone;
//   7. splitVisionRoute handles provider/model strings and garbage.
// Run: node verify-settings.mjs
import { Context } from '@deepseek-ai/cordis'
import * as host from './index.js'

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failures += 1
}

// ---- stub services -------------------------------------------------------
const sections = []
const registrations = [] // { ns, schema, base } from settings.register
const watchers = [] // scope.watch callbacks, per registration
let userValue = null // what scope.get() returns (the user layer)
let resolveImpl = () => ({ inputModalities: ['text', 'image'] })
const updates = [] // loader.update invocations
const httpRoutes = [] // webServer.register captures
const routes = [] // plugin-owned http route list (reused name is fine)

function fakeRes() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
      return this
    },
    end(body) {
      state.body = body ?? ''
    },
    state,
  }
}

function fakeReq(method, url, chunks) {
  const req = { method, url }
  if (chunks !== undefined) {
    req[Symbol.asyncIterator] = async function* () {
      for (const chunk of chunks) yield chunk
    }
  }
  return req
}

const stubSettings = {
  get(ns) {
    if (ns === 'llm-pi-ai') {
      return {
        providers: {
          qwen: {
            models: [
              { id: 'qwen3.8-max', name: 'qwen3.8-max', input: ['text', 'image'] },
              { id: 'qwen-flash', name: 'qwen-flash', input: ['text'] },
            ],
          },
        },
      }
    }
    if (ns === 'llm-anthropic') {
      return {
        models: [{ id: 'claude-3.7', name: 'Claude 3.7', input: ['text', 'image'] }],
      }
    }
    return undefined
  },
  register(ns, schema, opts) {
    registrations.push({ ns, schema, base: opts.base })
    const scope = {
      get: () => userValue ?? opts.base,
      watch: (fn) => watchers.push(fn),
    }
    return scope
  },
  replace(ns, section) {
    userValue = section
    for (const fn of watchers) fn()
  },
}

const stubLlm = {
  listConfigurableProviders: () => [
    { provider: 'pi-ai', displayName: 'Qwen (DashScope)', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'qwen'] },
    { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-anthropic', settingsPath: [] },
  ],
  resolveModelInfo: async (provider, model) => resolveImpl(provider, model),
}

const stubLoader = {
  entries: () => [
    {
      options: {
        id: 'tool-subagent-vision',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: {
          toolName: 'subagent_vision',
          provider: 'spawn',
          backgroundMode: 'one-shot',
          agentOptions: { provider: 'pi-ai', model: 'qwen3.8-max', maxTokens: 16384 },
        },
      },
      update: async (next) => {
        updates.push({ id: 'tool-subagent-vision', options: next })
      },
    },
  ],
}

const stubWebServer = {
  register: (route) => {
    httpRoutes.push(route)
  },
}

const ctx = new Context()
ctx.provide('systemPrompt', { section: (def) => sections.push(def) })
ctx.provide('llm', stubLlm)
ctx.provide('settings', stubSettings)
ctx.provide('loader', stubLoader)
ctx.provide('webServer', stubWebServer)

// cordis schedules ctx.inject callbacks on later ticks; flush them.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

// ---- 1 & 2 & 3: apply registers the guide and the settings section ----
host.apply(ctx, { persistToPatch: false })
await flush()
check('guide prompt section registered', sections.length === 1)

const reg = registrations.find((r) => r.ns === 'subagent-vision')
check('settings section registered under subagent-vision', reg !== undefined)
if (reg) {
  const schema = JSON.stringify(reg.schema.toJSON())
  const options = [...schema.matchAll(/"value":"([^"]+)","label":"([^"]+)"/g)].map((m) => ({ value: m[1], label: m[2] }))
  check(
    'select options are the image-declaring configured models',
    options.length === 2
      && options.some((o) => o.value === 'pi-ai/qwen3.8-max' && o.label === 'Qwen (DashScope): qwen3.8-max')
      && options.some((o) => o.value === 'anthropic/claude-3.7'),
    JSON.stringify(options),
  )
  check('text-only model excluded from options', !options.some((o) => o.value.includes('qwen-flash')))
  check('default entry mirrors the tool row route', reg.base.visionRoute === 'pi-ai/qwen3.8-max')
}

// guide prompt: with a configured route it tells the model to use the tool
check('guide prompt guides delegation when a route is chosen', sections[0].text().includes('delegates to a fresh subagent'))

// 4: registration-time sync is a no-op when the row already matches
check('no tool-row update when already matching', updates.length === 0, JSON.stringify(updates))

// 5: a settings change re-syncs the tool row, preserving the rest of the config
userValue = { visionRoute: 'anthropic/claude-3.7' }
await watchers[0]()
await new Promise((r) => setTimeout(r, 150)) // resolve succeeds on the first attempt
check('settings change updates the tool row', updates.length === 1)
if (updates.length === 1) {
  const next = updates[0].options.config.agentOptions
  check(
    'tool row now routes to the chosen model',
    updates[0].id === 'tool-subagent-vision'
      && next.provider === 'anthropic'
      && next.model === 'claude-3.7'
      && next.maxTokens === 16384,
    JSON.stringify(next),
  )
  check('tool row config otherwise preserved', updates[0].options.config.toolName === 'subagent_vision')
}

// 6a: an unresolvable route is refused (sync retries with backoff, then gives up)
updates.length = 0
resolveImpl = () => {
  throw new Error('no adapter for anthropic/claude-3.7')
}
userValue = { visionRoute: 'anthropic/claude-3.7' }
await watchers[0]()
await new Promise((r) => setTimeout(r, 4300)) // 5 retries, 250ms..1250ms backoff
check('unresolvable route does not touch the tool row', updates.length === 0)

// 6b: a model that does not declare image input is refused (no retry needed)
resolveImpl = () => ({ inputModalities: ['text'] })
userValue = { visionRoute: 'pi-ai/qwen3.8-max' }
await watchers[0]()
await new Promise((r) => setTimeout(r, 150))
check('non-image route does not touch the tool row', updates.length === 0)

// 7: splitVisionRoute
check('splitVisionRoute parses provider/model', host.splitVisionRoute('pi-ai/qwen3.8-max')?.[0] === 'pi-ai' && host.splitVisionRoute('pi-ai/qwen3.8-max')?.[1] === 'qwen3.8-max')
check('splitVisionRoute keeps slash in model', host.splitVisionRoute('a/b/c')?.[0] === 'a' && host.splitVisionRoute('a/b/c')?.[1] === 'b/c')
check('splitVisionRoute rejects garbage', host.splitVisionRoute('')?.[0] === undefined && host.splitVisionRoute('no-slash')?.[0] === undefined && host.splitVisionRoute('/x')?.[0] === undefined)

// 8: an empty (cleared) choice does not touch the tool row
updates.length = 0
userValue = { visionRoute: '' }
await watchers[0]()
await new Promise((r) => setTimeout(r, 100))
check('cleared choice does not touch the tool row', updates.length === 0)

// 9: no vision model configured -> section shows the hint, empty entry, no sync
const ctxEmpty = new Context()
const registrationsEmpty = []
const sectionsEmpty = []
const updatesEmpty = []
ctxEmpty.provide('systemPrompt', { section: (def) => sectionsEmpty.push(def) })
ctxEmpty.provide('llm', {
  listConfigurableProviders: () => [
    { provider: 'pi-ai', displayName: 'Qwen (DashScope)', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'qwen'] },
  ],
  resolveModelInfo: async () => {
    throw new Error('no adapter')
  },
})
ctxEmpty.provide('settings', {
  get() {
    return { providers: { qwen: { models: [{ id: 'qwen-flash', name: 'qwen-flash', input: ['text'] }] } } }
  },
  register(ns, schema, opts) {
    registrationsEmpty.push({ ns, schema, base: opts.base })
    return { get: () => opts.base, watch: () => {} }
  },
  replace() {},
})
ctxEmpty.provide('loader', {
  entries: () => [], // the tool row is absent/unconfigured
  update: async (id, options) => updatesEmpty.push({ id, options }),
})
host.apply(ctxEmpty, { persistToPatch: false })
await flush()
const regEmpty = registrationsEmpty.find((r) => r.ns === 'subagent-vision')
const emptyJson = JSON.stringify(regEmpty?.schema.toJSON())
check('no-model section still registers', regEmpty !== undefined)
check('no-model section entry is empty (no default)', regEmpty?.base.visionRoute === '')
check(
  'no-model section carries the configure-in-Models hint',
  emptyJson.includes('没有可用的视觉处理模型'),
)
check('no-model section does not sync the tool row', updatesEmpty.length === 0)
check('guide prompt with no route tells the model not to call the tool', sectionsEmpty[0].text().includes('not configured yet'))

// 10: the picker's HTTP surface serves the enumeration and persists the choice
userValue = null // back to the base entry: current mirrors the tool row route
resolveImpl = () => ({ inputModalities: ['text', 'image'] }) // restore the happy path
const settingsRoute = httpRoutes.find((r) => r.path === '/subagent-vision/settings')
check('picker HTTP route registered', settingsRoute !== undefined)
if (settingsRoute) {
  const getRes = fakeRes()
  await settingsRoute.handler(fakeReq('GET', '/subagent-vision/settings'), getRes)
  const got = JSON.parse(getRes.state.body)
  check(
    'GET serves options/current/hint',
    got.options.length === 2 && got.current === 'pi-ai/qwen3.8-max' && typeof got.hint === 'string',
    JSON.stringify(got),
  )
  // POST a new choice: settings.replace persists it and the section watch
  // re-syncs the tool row.
  updates.length = 0
  const postRes = fakeRes()
  await settingsRoute.handler(fakeReq('POST', '/subagent-vision/settings', [Buffer.from(JSON.stringify({ visionRoute: 'anthropic/claude-3.7' }))]), postRes)
  check('POST persists the choice', postRes.state.status === 200 && JSON.parse(postRes.state.body).ok === true)
  check('settings.replace received the choice', userValue?.visionRoute === 'anthropic/claude-3.7')
  await new Promise((r) => setTimeout(r, 150))
  check('POST-triggered sync updates the tool row', updates.length === 1)
  const badRes = fakeRes()
  await settingsRoute.handler(fakeReq('POST', '/subagent-vision/settings', [Buffer.from(JSON.stringify({ visionRoute: 'nope/nope' }))]), badRes)
  check('unknown route POST is refused', badRes.state.status === 400)
  const putRes = fakeRes()
  await settingsRoute.handler(fakeReq('PUT', '/subagent-vision/settings'), putRes)
  check('non-GET/POST method is refused', putRes.state.status === 405)
}

console.log(failures === 0 ? 'ALL SETTINGS CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
