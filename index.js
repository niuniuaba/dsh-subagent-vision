// dsh-subagent-vision host plugin (0.2.x port): guide prompt + vision-route.
//
// This is a reduced port. The 0.1.x plugin's settings section used
// `settings.installSection` (removed in 0.2.x; settings are now Config-driven
// forms) and its paste-to-path browser half used `conversation.sendSession`
// (also removed). Those halves are dropped here; the vision route is fixed by
// the `visionTool.agentOptions` block in this bundle's own cordis.patch.yml,
// which is exactly the upstream README's documented fallback for hand-editing.
//
// What remains and works: the `subagent_vision` delegation tool (tool.js) and
// the guide prompt telling the model when to use it.
import { mountVisionTool } from './tool.js'

export const name = 'subagent-vision'
// `tools` and `subagents` back the tool half (tool.js); `systemPrompt` backs the
// guide section. A deployment without them leaves this plugin unloaded, which
// is correct: its whole purpose is the vision delegation tool.
export const inject = ['systemPrompt', 'tools', 'subagents']

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
}
