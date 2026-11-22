// dsh-subagent-vision host plugin (0.2.x port): subagent_vision tool + guide
// prompt + paste-to-path + vision-route settings.
//
// 0.2.x port of niuniuaba/dsh-subagent-vision. The 0.1.x settings section used
// `settings.installSection` (removed in 0.2.x). Settings are now Config-driven
// forms: this plugin is a Cordis `Service` with a `static Config` whose
// `visionRoute` field is `.volatile()`, so the built-in Settings surface
// renders and persists it. A small host route serves the dynamic list of
// vision-capable models for the picker.
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountVisionTool } from './tool.js'

export const name = 'subagent-vision'

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

const PASTE_SNIFFS = [
  { ext: '.png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { ext: '.jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) },
  { ext: '.webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: '.heic', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx'].includes(b.toString('ascii', 8, 12)) },
  { ext: '.heif', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['mif1', 'msf1', 'heif'].includes(b.toString('ascii', 8, 12)) },
]

function splitRoute(route) {
  if (typeof route !== 'string' || route === '') return undefined
  const sep = route.indexOf('/')
  if (sep <= 0 || sep === route.length - 1) return undefined
  return { provider: route.slice(0, sep), model: route.slice(sep + 1) }
}

async function enumerateVisionRoutes(llm) {
  const providers = typeof llm?.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : []
  const seen = new Set()
  const routes = []
  for (const entry of providers) {
    if (typeof llm?.listModels !== 'function') continue
    let models
    try {
      models = await llm.listModels(entry.provider)
    } catch {
      continue
    }
    for (const model of models ?? []) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      if (!Array.isArray(model.inputModalities) || !model.inputModalities.includes('image')) continue
      const value = `${entry.provider}/${model.id}`
      if (seen.has(value)) continue
      seen.add(value)
      routes.push({
        value,
        label: `${entry.displayName ?? entry.provider}: ${model.name || model.id}`,
      })
    }
  }
  return routes
}

async function enumeratePolzaVisionRoutes() {
  const home = process.env.DSH_HOME
  if (!home) return []
  try {
    const data = JSON.parse(await readFile(join(home, 'polza', 'catalog.json'), 'utf8'))
    const routes = []
    for (const model of data.models ?? []) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      if (!Array.isArray(model.inputModalities) || !model.inputModalities.includes('image')) continue
      routes.push({ value: `polza/${model.id}`, label: `Polza: ${model.name || model.id}` })
    }
    return routes
  } catch {
    return []
  }
}

function mergeRoutes(lists, current) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const route of list ?? []) {
      if (typeof route?.value !== 'string' || route.value === '' || seen.has(route.value)) continue
      seen.add(route.value)
      out.push(route)
    }
  }
  if (current !== '' && current !== undefined && !seen.has(current)) {
    out.unshift({ value: current, label: current })
  }
  return out
}

function registerPasteRoute(scope, options) {
  scope.webServer.register({
    name: 'subagent-vision-paste',
    kind: 'exact',
    path: '/subagent-vision/paste',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ takeover: true }))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      try {
        const chunks = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > options.maxBytes) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: `image over the ${options.maxBytes}-byte limit` }))
            req.destroy()
            return
          }
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)
        const sniff = PASTE_SNIFFS.find((s) => s.test(buffer))
        if (sniff === undefined) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not a recognized image (png/jpeg/gif/webp/heic/heif)' }))
          return
        }
        const dir = await mkdtemp(join(tmpdir(), 'subagent-vision-paste-'))
        const file = join(dir, `paste${sniff.ext}`)
        await writeFile(file, buffer, { mode: 0o600 })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: file }))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    },
  })
}

export class SubagentVisionPlugin extends Service {
  static inject = ['systemPrompt', 'tools', 'subagents', 'llm', 'settings']

  static Config = z.object({
    visionRoute: z.string().default('').volatile(),
  })

  constructor(ctx, config) {
    super(ctx, name)
    this.config = config
  }

  readRoute() {
    return splitRoute(this.config.visionRoute.get())
  }

  async [Service.init]() {
    const ctx = this.ctx
    const toolName = 'subagent_vision'

    if (typeof ctx.tools?.register === 'function' && typeof ctx.subagents?.getProvider === 'function') {
      mountVisionTool(ctx, {
        provider: 'spawn',
        toolName,
        agentOptions: () => {
          const route = this.readRoute()
          return route === undefined ? undefined : { ...route, maxTokens: 16384 }
        },
      })
    }

    ctx.systemPrompt.section({
      name: 'subagent-vision',
      order: 150,
      text: () =>
        `The ${toolName} tool delegates to a fresh subagent running on a vision-capable model. `
        + 'Use it when a task requires reading an image this model cannot see: pass the '
        + "image's file path or URL in the tool prompt and instruct the child to read it "
        + 'with its read_image tool (or otherwise analyze it). A path pasted by the user '
        + '(often under the system temp directory) typically points at a pasted image — '
        + 'delegate it to this tool instead of reading it as text. The child returns text '
        + 'only; the current session never receives the image itself. '
        + `Do NOT probe the pasted path with the read tool (or glob/bash): the file is binary, `
        + 'read refuses it with "binary file", and the error is noise — skip straight to '
        + `delegating the path to ${toolName}.`,
    })

    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => {
        try {
          registerPasteRoute(scope, { maxBytes: DEFAULT_MAX_BYTES })
        } catch (error) {
          console.error(`[dsh-subagent-vision] paste-to-path route skipped: ${error}`)
        }
      })
    }

    ctx.inject(['webServer'], (scope) => {
      try {
        scope.webServer.register({
          name: 'subagent-vision-settings',
          kind: 'exact',
          path: '/subagent-vision/settings',
          handler: async (req, res) => {
            if (req.method === 'GET') {
              const current = this.config.visionRoute.get() ?? ''
              const [adapter, polza] = await Promise.all([
                enumerateVisionRoutes(ctx.llm).catch(() => []),
                enumeratePolzaVisionRoutes(),
              ])
              const options = mergeRoutes([adapter, polza], current)
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ options, current }))
              return
            }
            if (req.method !== 'POST') {
              res.writeHead(405).end()
              return
            }
            try {
              let body = ''
              for await (const chunk of req) body += chunk
              const parsed = body === '' ? {} : JSON.parse(body)
              const route = parsed.visionRoute
              if (typeof route !== 'string') throw new Error('visionRoute must be a string')
              if (route !== '') {
                const current = this.config.visionRoute.get() ?? ''
                const [adapter, polza] = await Promise.all([
                  enumerateVisionRoutes(ctx.llm).catch(() => []),
                  enumeratePolzaVisionRoutes(),
                ])
                const options = mergeRoutes([adapter, polza], current)
                if (options.length > 0 && !options.some((o) => o.value === route)) {
                  throw new Error(`unknown vision route ${JSON.stringify(route)}`)
                }
              }
              await ctx.settings.update(name, { visionRoute: route })
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: true, current: this.config.visionRoute.get() ?? '' }))
            } catch (error) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: String(error?.message ?? error) }))
            }
          },
        })
      } catch (error) {
        console.error(`[dsh-subagent-vision] settings route skipped: ${error}`)
      }
    })
  }
}

export default SubagentVisionPlugin
