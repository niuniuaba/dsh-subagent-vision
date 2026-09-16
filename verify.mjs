// Verification smoke for dsh-subagent-vision.
// Mounts this package's host plugin with the exact `visionTool` config the
// shipped patch declares (provider name swapped to a local scripted
// ctx.subagents provider) on the REAL tools/subagents/system-prompt services
// plus stubbed llm/webServer services, then asserts:
//   1. the `subagent_vision` tool registers once the provider appears;
//   2. executing it forwards the vision agentOptions into the start request;
//   3. the guide prompt section renders into the assembled system prompt;
//   4. the paste verdict answers true only for positively-confirmed
//      text-only models (vision and unknown models stay native);
//   5. POST /subagent-vision/paste sniffs, stores, and returns a temp path.
// Run from the plugin directory (after `npm install`):
//   node verify.mjs
// Exits non-zero on any failed assertion.
import { readFile, stat } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as host from './index.js'

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failures += 1
}

// The config the bundle patch ships, except `provider` is the scripted
// provider name here (the patch's `spawn` is the deployment route).
const VISION_TOOL_CONFIG = {
  provider: 'mock',
  agentOptions: { provider: 'pi-ai', model: 'qwen3.8-max', maxTokens: 16384 },
}

// A scripted one-shot provider registered through the real subagents service,
// mirroring how the deployment's spawn backend registers. Captures each start
// request and answers with fixed text.
let seenStart
function mountScriptedProvider(ctx, name) {
  const capabilities = {
    agentOptions: true,
    outputSchema: false,
    depthLimit: true,
    toolFilter: false,
    persona: false,
  }
  return ctx.plugin({
    name: 'scripted-subagent-provider',
    inject: ['subagents'],
    apply(pluginCtx) {
      pluginCtx.subagents.registerProvider({
        name,
        capabilities,
        inheritsParentContext: false,
        async start(request) {
          seenStart = request
          return {
            id: SessionId(`scripted:${name}:${request.parent.id}`),
            localAgent: undefined,
            result: Promise.resolve({
              output: [{ type: 'text', text: 'scripted subagent reply' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          }
        },
      })
    },
  })
}

// Stubbed llm: these model ids declare image input; every other id is
// text-only. An unknown provider has no adapter, so resolveModelInfo rejects
// (the paste route must then answer false, not take over).
const IMAGE_MODEL_IDS = new Set(['qwen3.8-max', 'claude-3.7', 'deepseek-v4-flash-vision-exp'])
const stubLlm = {
  listConfigurableProviders: () => [
    { provider: 'pi-ai', displayName: 'Qwen (DashScope)', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'qwen'] },
    { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-anthropic', settingsPath: [] },
  ],
  resolveModelInfo: async (provider, model) => {
    if (provider === 'unknown-provider') throw new Error(`no adapter for ${provider}`)
    return {
      provider,
      model,
      inputModalities: IMAGE_MODEL_IDS.has(model) ? ['text', 'image'] : ['text'],
    }
  },
}

// Stub settings service: the vision-route section records its change watcher
// so this smoke can drive a settings change, and `get` serves no provider
// documents (the picker then offers no options, which the route sync does not
// depend on).
const settingsWatchers = []
let storedSettings = null
const stubSettings = {
  get: () => undefined,
  describe: () => [],
  installSection(owner, ns, schema, entry, hooks) {
    if (ns !== 'subagent-vision') return
    const scope = { get: () => storedSettings ?? entry, watch: (fn) => settingsWatchers.push(fn) }
    hooks.setSource(() => scope.get())
    hooks.onChange()
    scope.watch(() => hooks.onChange())
  },
  replace(ns, section) {
    if (ns !== 'subagent-vision') return
    storedSettings = section
    for (const fn of settingsWatchers) fn()
  },
}

// Stub loader: records every entry rewrite. The plugin must never rewrite the
// entry that mounts it — the loader restarts that fiber, re-registering the
// paste and settings routes into the same webServer scope.
const loaderRewrites = []
const stubLoader = {
  entries: () => [{
    options: {
      id: 'subagent-vision',
      name: 'dsh-subagent-vision',
      config: { visionTool: VISION_TOOL_CONFIG },
    },
    update: async (next) => { loaderRewrites.push(next) },
  }],
}

const routes = []
const stubWebServer = {
  register: (route) => {
    routes.push(route)
    return () => {}
  },
}

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

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(SubagentRuntime)
ctx.provide('llm', stubLlm)
ctx.provide('webServer', stubWebServer)
ctx.provide('settings', stubSettings)
ctx.provide('loader', stubLoader)

// 1. Before the provider exists, the tool must not be visible.
await ctx.plugin(host, { visionTool: VISION_TOOL_CONFIG, persistToPatch: false })
check('tool absent before its provider registers', ctx.tools.get('subagent_vision') === undefined)

// Registering the scripted provider makes the tool appear.
await mountScriptedProvider(ctx, 'mock')
check('subagent_vision tool is registered', ctx.tools.get('subagent_vision') !== undefined)

// 2. Executing it forwards agentOptions and the prompt to the child boundary.
// The fake parent carries the shape delegationDepthOf reads (options + session
// header); a top-level parent sits at depth 0.
const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: ToolCallId('verify-call-1'),
  name: 'subagent_vision',
  arguments: { description: 'read the chart', prompt: 'Read /tmp/chart.png with read_image and summarize it' },
  agent: { id: SessionId('parent-verify'), options: {}, session: { header: { delegationDepth: 0 } } },
})
check(
  'start request carries the vision agentOptions',
  seenStart?.agentOptions?.provider === 'pi-ai'
    && seenStart?.agentOptions?.model === 'qwen3.8-max'
    && seenStart?.agentOptions?.maxTokens === 16384,
)
const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
check('tool result returns the child text', text === 'scripted subagent reply')

// 3. The guide prompt section renders into the system prompt.
const prompt = renderPrompt(await ctx.systemPrompt.assemble())
check(
  'guide prompt section mentions subagent_vision and the model hint',
  prompt.includes('subagent_vision') && prompt.includes('a vision-capable model'),
)

// 3b. A settings change re-points the running tool on its next call, keeping
// the row's maxTokens, and never rewrites the loader entry that mounts this
// plugin (a rewrite restarts the fiber and re-registers its routes).
await ctx.settings.replace('subagent-vision', { visionRoute: 'anthropic/claude-3.7' })
await new Promise((resolve) => setTimeout(resolve, 200))
const rerouted = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: ToolCallId('verify-call-2'),
  name: 'subagent_vision',
  arguments: { description: 'read the second chart', prompt: 'Read /tmp/chart2.png and summarize it' },
  agent: { id: SessionId('parent-verify'), options: {}, session: { header: { delegationDepth: 0 } } },
})
check(
  'settings change re-points the running tool',
  seenStart?.agentOptions?.provider === 'anthropic'
    && seenStart?.agentOptions?.model === 'claude-3.7'
    && seenStart?.agentOptions?.maxTokens === 16384,
  JSON.stringify(seenStart?.agentOptions),
)
check('rerouted call still returns the child text', rerouted.isError !== true)
check('loader entry is never rewritten', loaderRewrites.length === 0, JSON.stringify(loaderRewrites))

// 4. Paste verdict: text-only -> takeover; image-capable and unknown -> native.
const route = routes.find((r) => r.path === '/subagent-vision/paste')
check('paste route registered', route !== undefined)
if (route !== undefined) {
  const verdict = async (provider, model) => {
    const res = fakeRes()
    await route.handler(
      fakeReq('GET', `/subagent-vision/paste?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`),
      res,
    )
    return JSON.parse(res.state.body).takeover
  }
  check('text-only model -> takeover', await verdict('deepseek-official', 'deepseek-v4-flash') === true)
  check('image-capable model -> native', await verdict('pi-ai', 'qwen3.8-max') === false)
  check('unknown model -> native', await verdict('unknown-provider', 'unknown-model') === false)

  // 5. POST: a real PNG magic byte prefix is sniffed, stored 0600, and returned.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])
  const res = fakeRes()
  await route.handler(fakeReq('POST', '/subagent-vision/paste', [png]), res)
  const body = JSON.parse(res.state.body)
  check('POST returns a temp path', typeof body?.path === 'string' && body.path.length > 0, String(body))
  if (typeof body?.path === 'string') {
    const written = await readFile(body.path)
    const mode = (await stat(body.path)).mode & 0o777
    check('stored bytes match the upload', written.equals(png))
    check('stored file is private (0600)', mode === 0o600, `mode ${mode.toString(8)}`)
  }

  // Non-image bytes are refused.
  const bad = fakeRes()
  await route.handler(fakeReq('POST', '/subagent-vision/paste', [Buffer.from('not an image')]), bad)
  check('non-image POST is refused', bad.state.status === 400)

  // Unsupported methods are refused.
  const put = fakeRes()
  await route.handler(fakeReq('PUT', '/subagent-vision/paste'), put)
  check('non-GET/POST method is refused', put.state.status === 405)
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
