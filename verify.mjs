// Verification smoke for dsh-subagent-vision.
// Mounts the exact config the shipped patch declares on the REAL
// tool-subagent plugin plus this package's host plugin (guide section +
// paste-to-path route) and stubbed llm/webServer services, then asserts:
//   1. the `subagent_vision` tool registers;
//   2. executing it forwards the vision agentOptions into the start request;
//   3. the guide prompt section renders into the assembled system prompt;
//   4. the paste verdict answers true only for positively-confirmed
//      text-only models (vision and unknown models stay native);
//   5. POST /subagent-vision/paste sniffs, stores, and returns a temp path.
// Run from the repository root:
//   pnpm exec tsx plugins/dsh-subagent-vision/verify.mjs
// Exits non-zero on any failed assertion.
import { readFile, stat } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as tool from '../../packages/subagent/tool-subagent/src/index.ts'
import { mountScriptedProvider } from '../../packages/subagent/tool-subagent/tests/scripted-provider.ts'
import * as host from './index.js'

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failures += 1
}

// The config the bundle patch ships, except `provider` is the scripted
// provider name here (the patch's `spawn` is the deployment route).
const PATCH_CONFIG = {
  toolName: 'subagent_vision',
  provider: 'mock',
  backgroundMode: 'one-shot',
  agentOptions: { provider: 'pi-ai', model: 'qwen3.8-max', maxTokens: 16384 },
}

// Stubbed llm: a model is image-capable when its id mentions vision/qwen; an
// unknown provider has no adapter, so resolveModelInfo rejects (the host route
// must then answer false, not take over).
const stubLlm = {
  resolveModelInfo: async (provider, model) => {
    if (provider === 'unknown-provider') throw new Error(`no adapter for ${provider}`)
    return {
      provider,
      model,
      inputModalities: /vision|qwen/i.test(model) ? ['text', 'image'] : ['text'],
    }
  },
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

// Capture the start request the tool builds, like the repo's agentOptions test.
let seen
await mountScriptedProvider(ctx, {
  name: 'mock',
  onStart(request) {
    seen = request
  },
})
await ctx.plugin(host)
await ctx.plugin(tool, PATCH_CONFIG)

// 1. The tool registers under the patch's toolName.
check('subagent_vision tool is registered', ctx.tools.get('subagent_vision') !== undefined)

// 2. Executing it forwards agentOptions and the prompt to the child boundary.
const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: CallId('verify-call-1'),
  name: 'subagent_vision',
  arguments: { description: 'read the chart', prompt: 'Read /tmp/chart.png with read_image and summarize it' },
  agent: { id: SessionId('parent-verify') },
})
check(
  'start request carries the vision agentOptions',
  seen?.agentOptions?.provider === 'pi-ai'
    && seen?.agentOptions?.model === 'qwen3.8-max'
    && seen?.agentOptions?.maxTokens === 16384,
)
const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
check('tool result returns the child text', text === 'scripted subagent reply')

// 3. The guide prompt section renders into the system prompt.
const prompt = renderPrompt(await ctx.systemPrompt.assemble())
check(
  'guide prompt section mentions subagent_vision and the model hint',
  prompt.includes('subagent_vision') && prompt.includes('a vision-capable model'),
)

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
