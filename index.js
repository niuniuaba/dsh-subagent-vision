// dsh-subagent-vision host plugin: prompt guidance + paste-to-path route +
// vision-route settings.
//
// Guidance: one prompt section telling the model when to use the
// subagent_vision tool (mounted by the sibling patch row). The stock subagent
// tool description is generic (it says nothing about vision), so without this
// section the model has no reason to prefer subagent_vision over subagent.
//
// Paste-to-path: under the web profile, a browser half (client.js) intercepts
// image pastes when the current model is text-only and POSTs the bytes here.
// The route sniffs the bytes, writes a private temp file, and returns its
// path; the browser inserts the path into the composer as plain text, so the
// host's image admission never fires and the text-only agent can delegate the
// path to subagent_vision. The verdict (whether to take a paste over) is the
// HOST's call from provider metadata (inputModalities), never a name guess.
//
// Vision-route settings: a settings section (`subagent-vision` namespace)
// lets the user pick which model subagent_vision delegates to. The options
// are enumerated from the deployment's configurable-provider directory
// (llm.listConfigurableProviders + the provider's settings document) and
// filtered to models that positively declare image input — the same
// metadata the paste verdict trusts. The choice is stored in the settings
// system (settings.yaml, GUI-editable, survives restarts) AND persisted into
// this bundle's own cordis.patch.yml, so the tool row starts with the chosen
// agentOptions on the next boot even if the runtime settings->agentOptions
// sync cannot apply it live. Clearing the choice removes the hardcode again.
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'subagent-vision'
export const inject = ['systemPrompt', 'llm']

/** Settings namespace owning the user's vision-route choice. */
const SETTINGS_NS = settingsNamespace('subagent-vision')
/** The patch row whose agentOptions the choice is synced onto. */
const TOOL_ENTRY_ID = 'tool-subagent-vision'
/** The stored value's shape: a `provider/model` string. */
const ROUTE_FIELD = 'visionRoute'
/** Shown in the settings form when no vision-capable model is configured yet. */
const NO_ROUTE_HINT = '没有可用的视觉处理模型，请先在「设置 > 模型」中配置一个支持图片输入的模型。'

/** This bundle's own patch file; the tool row this bundle inserts lives there. */
const PATCH_FILE = join(dirname(fileURLToPath(import.meta.url)), 'cordis.patch.yml')
/** maxTokens written into the persisted agentOptions block. */
const PATCH_MAX_TOKENS = 16384

/** Image magic-byte sniffers for the paste route: refuse anything that is not a real image. */
const PASTE_SNIFFS = [
  {
    ext: '.png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  { ext: '.jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) },
  {
    ext: '.webp',
    test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    ext: '.heic',
    test: (b) =>
      b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'hevx'].includes(b.toString('ascii', 8, 12)),
  },
  {
    ext: '.heif',
    test: (b) =>
      b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' &&
      ['mif1', 'msf1', 'heif'].includes(b.toString('ascii', 8, 12)),
  },
]

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
const VERDICT_TTL_MS = 15_000
const VERDICT_CAP = 32

/**
 * Whether the exact model is positively confirmed text-only: its metadata
 * declares input modalities and image is absent. A missing declaration means
 * unknown, never text-only, so an uncatalogued or vision model keeps its
 * native paste. Any resolution failure answers false (the safe direction).
 */
async function textOnlyVerdict(host, provider, model) {
  try {
    const info = await host.llm.resolveModelInfo(provider, model)
    const modalities = info?.inputModalities
    return Array.isArray(modalities) && !modalities.includes('image')
  } catch {
    return false
  }
}

/**
 * Register the paste-to-path route on the web server.
 * GET  /subagent-vision/paste?provider=&model= -> { takeover }
 * POST /subagent-vision/paste                  -> { path }
 * @param scope - scoped context carrying the webServer service.
 * @param host - plugin context carrying the llm service.
 * @param options - route tuning (maxBytes, verdictTtlMs).
 */
function registerPasteRoute(scope, host, options) {
  const verdicts = new Map()
  scope.webServer.register({
    name: 'subagent-vision-paste',
    kind: 'exact',
    path: '/subagent-vision/paste',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const provider = url.searchParams.get('provider') ?? ''
        const model = url.searchParams.get('model') ?? ''
        let takeover = false
        if (provider !== '' && model !== '') {
          const key = `${provider}/${model}`
          const cached = verdicts.get(key)
          if (cached !== undefined && Date.now() - cached.at < options.verdictTtlMs) {
            takeover = cached.takeover
          } else {
            takeover = await textOnlyVerdict(host, provider, model)
            verdicts.delete(key)
            verdicts.set(key, { takeover, at: Date.now() })
            if (verdicts.size > VERDICT_CAP) {
              verdicts.delete(verdicts.keys().next().value)
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ takeover }))
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
        const { mkdtemp, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
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

/**
 * Register the guidance section and the optional paste route.
 * @param ctx - plugin context carrying the injected systemPrompt and llm services.
 * @param config - optional overrides ({@link toolName}, {@link modelHint}, {@link order},
 *   {@link pasteToPath}, {@link maxBytes}, {@link verdictTtlMs}).
 */
// The route currently chosen in the settings, mirrored here so the guide
// prompt section (registered before the settings service settles) can render
// its current state lazily.
let visionRoute = null

export function apply(ctx, config = {}) {
  const toolName = config.toolName ?? 'subagent_vision'
  const modelHint = config.modelHint ?? 'a vision-capable model'
  ctx.systemPrompt.section({
    name: 'subagent-vision',
    order: config.order ?? 150,
    text: () =>
      visionRoute === null || visionRoute === ''
        ? `The ${toolName} tool is not configured yet: no vision model has been chosen, so do NOT call it. `
          + 'Tell the user to configure a vision-capable model in Settings > Models and pick it in the '
          + 'subagent-vision settings section, then retry the task.'
        : `The ${toolName} tool delegates to a fresh subagent running on ${modelHint}. `
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
  if (config.visionSettings !== false) {
    registerVisionRouteSettings(ctx, config)
  }
  if (config.pasteToPath !== false && typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerPasteRoute(scope, ctx, {
          maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
          verdictTtlMs: config.verdictTtlMs ?? VERDICT_TTL_MS,
        })
      } catch (error) {
        // A preview-era surface change: keep the guide; the paste takeover is off.
        console.error(`[dsh-subagent-vision] paste-to-path route skipped: ${error}`)
      }
    })
  }
}

/**
 * Split a stored `provider/model` route value into its parts. A provider or
 * model id may itself contain a slash, so only the FIRST separator splits;
 * the remainder is re-joined and stays with the model.
 * @param route - the stored value, e.g. `pi-ai/qwen3.8-max`.
 * @returns `[provider, model]`, or `[undefined, undefined]` for garbage.
 */
export function splitVisionRoute(route) {
  if (typeof route !== 'string' || route === '') return [undefined, undefined]
  const sep = route.indexOf('/')
  if (sep <= 0 || sep === route.length - 1) return [undefined, undefined]
  return [route.slice(0, sep), route.slice(sep + 1)]
}

/**
 * Enumerate the vision-capable models a deployment has actually configured.
 * @param providers - `llm.listConfigurableProviders()` output: each entry
 *   carries `provider`, `displayName`, `settingsNs`, `settingsPath`.
 * @param readSettings - `(ns) => document` for the settings service.
 * @returns `{ value, label }` routes for models whose `input` declares image,
 *   deduplicated, in provider order.
 */
export function enumerateVisionRoutes(providers, readSettings) {
  const seen = new Set()
  const routes = []
  for (const entry of providers) {
    let node
    try {
      node = readSettings(entry.settingsNs)
    } catch {
      continue
    }
    if (node === undefined || node === null) continue
    for (const key of entry.settingsPath ?? []) {
      node = node?.[key]
      if (node === undefined || node === null) break
    }
    const models = Array.isArray(node?.models) ? node.models : []
    for (const model of models) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      if (!Array.isArray(model.input) || !model.input.includes('image')) continue
      const value = `${entry.provider}/${model.id}`
      if (seen.has(value)) continue
      seen.add(value)
      routes.push({
        value,
        label: `${entry.displayName}: ${typeof model.name === 'string' && model.name !== '' ? model.name : model.id}`,
      })
    }
  }
  return routes
}

/** Leading-whitespace width of one line. */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match ? match[0].length : 0
}

/**
 * Persist a vision route onto the tool-subagent-vision row of this bundle's
 * own cordis.patch.yml. An empty route removes the hardcoded block; a route
 * that does not parse is ignored. The edit is structure-aware (comments and
 * sibling rows survive) and atomic (temp file + rename). No-op when the file
 * already carries the wanted block.
 *
 * The loader reads this file at boot, so the persisted choice makes the tool
 * row start with the user's agentOptions on the next restart even when the
 * runtime settings->agentOptions sync (queueToolRouteSync) cannot apply it
 * live. This is the durable half of the sync; the live half remains
 * best-effort on top.
 * @param route - `provider/model` to hardcode, or `''` to clear.
 * @returns true when the file was rewritten.
 */
export async function persistToolRoute(route) {
  const [provider, model] = splitVisionRoute(route)
  let text
  try {
    text = await readFile(PATCH_FILE, 'utf8')
  } catch (error) {
    console.warn(`[dsh-subagent-vision] cannot read patch file ${PATCH_FILE}: ${error?.message ?? error}`)
    return false
  }
  const lines = text.split('\n')
  const row = lines.findIndex((line) => line.trim() === `- id: ${TOOL_ENTRY_ID}`)
  if (row === -1) {
    console.warn(`[dsh-subagent-vision] patch row ${TOOL_ENTRY_ID} not found; skipping persist`)
    return false
  }
  // The row's config block: first `config:` after the row, before the next row.
  let config = -1
  for (let i = row + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === 'config:') {
      config = i
      break
    }
    if (trimmed.startsWith('- id:')) break
  }
  if (config === -1) {
    console.warn(`[dsh-subagent-vision] patch row ${TOOL_ENTRY_ID} has no config block; skipping persist`)
    return false
  }
  const keyIndent = indentOf(lines[config]) + 2
  const keyPad = ' '.repeat(keyIndent)
  const valuePad = ' '.repeat(keyIndent + 2)
  // Locate an existing agentOptions block (the key line plus deeper children).
  let optionsAt = -1
  let optionsEnd = -1
  for (let i = config + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const ind = indentOf(line)
    if (ind < keyIndent) break
    if (ind === keyIndent && line.trim().startsWith('agentOptions:')) {
      optionsAt = i
      break
    }
    if (ind === keyIndent) continue
  }
  if (optionsAt !== -1) {
    let end = optionsAt + 1
    while (end < lines.length && lines[end].trim() !== '' && indentOf(lines[end]) > keyIndent) end++
    optionsEnd = end
  }
  // Preserve an existing maxTokens when present; fall back to the default.
  let maxTokens = PATCH_MAX_TOKENS
  if (optionsAt !== -1) {
    for (let i = optionsAt + 1; i < optionsEnd; i++) {
      const match = /maxTokens:\s*(\d+)/.exec(lines[i])
      if (match) maxTokens = Number(match[1])
    }
  }
  const wanted = provider && model
    ? [
        `${keyPad}agentOptions:`,
        `${valuePad}provider: ${provider}`,
        `${valuePad}model: ${model}`,
        `${valuePad}maxTokens: ${maxTokens}`,
      ]
    : []
  const existing = optionsAt !== -1 ? lines.slice(optionsAt, optionsEnd) : []
  if (existing.length === wanted.length && existing.every((line, i) => line === wanted[i])) return false
  const next = optionsAt !== -1
    ? [...lines.slice(0, optionsAt), ...wanted, ...lines.slice(optionsEnd)]
    : insertAfterConfigKeys(lines, config, keyIndent, wanted)
  const result = next.join('\n')
  if (result === text) return false
  const tmp = `${PATCH_FILE}.tmp`
  try {
    await writeFile(tmp, result, { mode: 0o600 })
    await rename(tmp, PATCH_FILE)
    console.log(`[dsh-subagent-vision] patch file updated: vision route ${provider && model ? `${provider}/${model}` : 'cleared'}`)
    return true
  } catch (error) {
    console.error(`[dsh-subagent-vision] cannot write patch file ${PATCH_FILE}: ${error?.message ?? error}`)
    return false
  }
}

/** Insert lines after the last top-level config key of the tool row's config block. */
function insertAfterConfigKeys(lines, config, keyIndent, wanted) {
  let anchor = config
  for (let i = config + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const ind = indentOf(line)
    if (ind < keyIndent) break
    if (ind === keyIndent) anchor = i
  }
  return [...lines.slice(0, anchor + 1), ...wanted, ...lines.slice(anchor + 1)]
}

// One serialized persist at a time: settings can change while a write is in
// flight, and the final state must win.
let persistChain = Promise.resolve()
function queuePersist(route) {
  persistChain = persistChain
    .then(() => persistToolRoute(route))
    .catch((error) => {
      console.error(`[dsh-subagent-vision] persist failed: ${error?.message ?? error}`)
    })
}

/**
 * Register the vision-route settings section and sync the choice onto the
 * tool row whenever it settles. Registration is conditional: a deployment
 * without the settings service simply leaves the tool row as patched.
 * The choice is stored in the settings system AND, when the user picks one,
 * persisted into this bundle's own cordis.patch.yml — so the tool row starts
 * with the chosen agentOptions on the next boot even if the live sync cannot
 * apply it. Clearing the choice removes the hardcoded block again.
 * @param ctx - plugin context carrying llm (and optionally loader/settings).
 * @param config - the plugin config (persistToPatch gates the file write).
 */
function registerVisionRouteSettings(ctx, config) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['settings', 'llm'], (sctx) => {
    let source = () => undefined
    const enumerateNow = () =>
      enumerateVisionRoutes(sctx.llm.listConfigurableProviders?.() ?? [], (ns) => sctx.settings.get(ns))
    try {
      const options = enumerateNow().map((r) => ({ value: r.value, label: r.label }))
      const current = currentToolRoute(ctx)
      // Only mirror an existing, still-available choice; never fabricate one.
      const initial = current !== '' && options.some((o) => o.value === current) ? current : ''
      const field = z.string().role('select', { options })
      const schema = z.object({
        [ROUTE_FIELD]:
          options.length === 0
            ? field.default('').description(NO_ROUTE_HINT)
            : field.required().description('选择用于 subagent_vision 委派读图的视觉模型（来自「设置 > 模型」中已配置的模型）。'),
      })
      const entry = { [ROUTE_FIELD]: initial }
      installSettingsSection(ctx, SETTINGS_NS, schema, entry, {
        setSource: (read) => {
          source = read
        },
        // Called at registration and on every settings change: keep the tool
        // row's agentOptions aligned with the user's choice — persist it into
        // this bundle's own patch file (durable across restarts) and try the
        // live loader update on top (best-effort immediate apply).
        onChange: () => {
          visionRoute = source?.()?.[ROUTE_FIELD] ?? ''
          if (config.persistToPatch !== false) {
            // Only persist a parseable route that is currently selectable (or
            // the clear case); a stale/unresolvable stored route must not
            // overwrite the file's last good hardcode. An empty options list
            // means the provider directory has not settled yet — mirroring the
            // settings is still safe then (the boot-time value mirrors the
            // file, so the write is idempotent anyway).
            const options = enumerateNow().map((r) => r.value)
            const [p, m] = splitVisionRoute(visionRoute)
            const persistable = visionRoute === '' || (Boolean(p && m) && (options.length === 0 || options.includes(visionRoute)))
            if (persistable) queuePersist(visionRoute)
          }
          queueToolRouteSync(ctx, visionRoute)
        },
      })
    } catch (error) {
      console.error(`[dsh-subagent-vision] vision-route settings skipped: ${error}`)
    }
    // HTTP read/write for the client picker. The client settings RPC only
    // serves a hardcoded allowlist of namespaces, so the picker talks to this
    // plugin's own route instead; storage still goes through the settings
    // system (the watch on the section re-syncs the tool row). Reads enumerate
    // live: dormant providers may only register their configurable-provider
    // directory after boot, so the boot-time snapshot would stay empty.
    ctx.inject(['webServer'], (scope) => {
      try {
        registerVisionRouteHttp(scope, ctx, {
          read: () => {
            const options = enumerateNow().map((r) => ({ value: r.value, label: r.label }))
            return {
              options,
              hint: options.length === 0 ? NO_ROUTE_HINT : '选择用于 subagent_vision 委派读图的视觉模型（来自「设置 > 模型」中已配置的模型）。',
              current: source?.()?.[ROUTE_FIELD] ?? '',
            }
          },
          write: async (route) => {
            await sctx.settings.replace(SETTINGS_NS, { [ROUTE_FIELD]: route })
          },
        })
      } catch (error) {
        console.error(`[dsh-subagent-vision] vision-route http route skipped: ${error}`)
      }
    })
  })
}

/**
 * Register the picker's HTTP surface:
 *   GET  /subagent-vision/settings -> { options, hint, current }
 *   POST /subagent-vision/settings -> { visionRoute } -> stored
 * @param scope - scoped context carrying the webServer service.
 * @param ctx - plugin context.
 * @param io - `read()` snapshot and `write(route)` persistence callback.
 */
function registerVisionRouteHttp(scope, ctx, io) {
  scope.webServer.register({
    name: 'subagent-vision-settings',
    kind: 'exact',
    path: '/subagent-vision/settings',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        const { options, hint, current } = io.read()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ options, hint, current }))
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
        const { options } = io.read()
        if (options.length > 0 && !options.some((o) => o.value === route)) {
          throw new Error(`unknown vision route ${JSON.stringify(route)}`)
        }
        await io.write(route)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, current: route }))
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    },
  })
}

/** The route currently declared on the tool row, or '' when the row has none. */
function currentToolRoute(ctx) {
  try {
    const entry = ctx.loader?.entries?.().find((e) => e.options?.id === TOOL_ENTRY_ID)
    const agentOptions = entry?.options?.config?.agentOptions
    if (agentOptions?.provider && agentOptions?.model) return `${agentOptions.provider}/${agentOptions.model}`
  } catch {
    /* loader unavailable */
  }
  return ''
}

/**
 * Point the tool row's agentOptions at the chosen route. The model must
 * resolve and declare image input; anything else logs a warning and leaves
 * the row untouched (the patch default keeps serving). No-op when the row
 * already matches.
 *
 * Resolution is retried with backoff: at boot the llm route directory can
 * still be settling (dormant adapters register only after the settings
 * document is published), so an early resolve failure must not silently drop
 * a saved route.
 */
const SYNC_RETRY_ATTEMPTS = 5
const SYNC_RETRY_BASE_MS = 250

// One sync at a time, coalescing the latest requested route: settings can
// change while a retry is in flight, and the final state must win.
let syncPromise = null
let syncWanted = null

function queueToolRouteSync(ctx, route) {
  syncWanted = route
  if (syncPromise !== null) return
  syncPromise = (async () => {
    while (syncWanted !== null) {
      const next = syncWanted
      syncWanted = null
      await syncToolRouteOnce(ctx, next)
    }
    syncPromise = null
  })()
}

async function syncToolRouteOnce(ctx, route) {
  const [provider, model] = splitVisionRoute(route)
  if (!provider || !model) return
  let lastError
  let resolved = false
  let image = false
  for (let attempt = 0; attempt < SYNC_RETRY_ATTEMPTS; attempt++) {
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      resolved = true
      image = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
      break
    } catch (error) {
      lastError = error
      if (attempt < SYNC_RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, SYNC_RETRY_BASE_MS * (attempt + 1)))
      }
    }
  }
  if (!resolved) {
    console.warn(`[dsh-subagent-vision] configured vision route ${provider}/${model} cannot be resolved (${lastError?.message ?? lastError}); leaving the tool row as patched`)
    return
  }
  if (!image) {
    console.warn(`[dsh-subagent-vision] configured vision route ${provider}/${model} does not declare image input; leaving the tool row as patched`)
    return
  }
  try {
    const list = ctx.loader?.entries ? Array.from(ctx.loader.entries()) : []
    const entry = list.find((e) => e.options?.id === TOOL_ENTRY_ID)
    if (!entry?.options?.config) return
    const agentOptions = entry.options.config.agentOptions
    if (agentOptions?.provider === provider && agentOptions?.model === model) return
    const next = {
      ...entry.options,
      config: {
        ...entry.options.config,
        agentOptions: { ...agentOptions, provider, model },
      },
    }
    // Update through the entry object itself: it is reachable via the tree
    // walk (entries), while a bare-id loader.update can miss nested rows.
    await entry.update(next, false, true)
    console.log(`[dsh-subagent-vision] vision route set to ${provider}/${model}`)
  } catch (error) {
    console.error(`[dsh-subagent-vision] could not apply vision route ${provider}/${model}: ${error?.message ?? error}`)
  }
}
