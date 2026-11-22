// dsh-subagent-vision host plugin (0.2.x port): guide prompt + paste-to-path +
// vision-route.
//
// 0.2.x port of niuniuaba/dsh-subagent-vision. The 0.1.x settings section used
// `settings.installSection` (removed in 0.2.x; settings are now Config-driven
// forms), so the vision route is fixed by the `visionTool.agentOptions` block in
// this bundle's own cordis.patch.yml (the upstream README's documented fallback).
//
// What works here: the `subagent_vision` delegation tool (tool.js), the guide
// prompt, and the paste-to-path host route (webServer.register is unchanged).
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountVisionTool } from './tool.js'

export const name = 'subagent-vision'
export const inject = ['systemPrompt', 'tools', 'subagents']

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

const PASTE_SNIFFS = [
  { ext: '.png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { ext: '.jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) },
  { ext: '.webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: '.heic', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx'].includes(b.toString('ascii', 8, 12)) },
  { ext: '.heif', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['mif1', 'msf1', 'heif'].includes(b.toString('ascii', 8, 12)) },
]

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

export function apply(ctx, config = {}) {
  const visionTool = config.visionTool === false ? {} : (config.visionTool ?? {})
  const toolName = visionTool.toolName ?? config.toolName ?? 'subagent_vision'
  const modelHint = config.modelHint ?? 'a vision-capable model'

  if (config.visionTool !== false && typeof ctx.tools?.register === 'function' && typeof ctx.subagents?.getProvider === 'function') {
    mountVisionTool(ctx, { ...visionTool, toolName })
  }

  ctx.systemPrompt.section({
    name: 'subagent-vision',
    order: config.order ?? 150,
    text: () =>
      `The ${toolName} tool delegates to a fresh subagent running on ${modelHint}. `
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

  if (config.pasteToPath !== false && typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerPasteRoute(scope, { maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES })
      } catch (error) {
        console.error(`[dsh-subagent-vision] paste-to-path route skipped: ${error}`)
      }
    })
  }
}
