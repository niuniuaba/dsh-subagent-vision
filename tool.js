// dsh-subagent-vision tool half (0.2.x port): the `subagent_vision` delegation
// tool, rewritten against the 0.2.x subagent seam.
//
// 0.1.x used `ctx.subagents.start(provider, request)` + `settleRun(run)` and
// awaited the child's text as the tool result. 0.2.x replaced that with
// `ctx.subagents.startActivation(spec)`: it starts a managed child and returns
// the activation's name immediately; the child's final answer is delivered to
// the parent as a settlement notice (exactly how the built-in `subagent` tool
// behaves). This port mirrors `@deepseek-ai/dsh-tool-subagent`.
//
// The child route is fixed by configuration (`visionTool.agentOptions`), never
// by a model-supplied argument: image blocks stay out of the parent session
// because only the child reads them (with its own read_image) and only its
// final text comes back to the parent.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'

export const DEFAULT_TOOL_NAME = 'subagent_vision'

/** Delegation depth at which a child may no longer delegate (matches the built-in tool's default budget). */
const MAX_CHILD_DEPTH = 3

/**
 * Mount the `subagent_vision` tool onto the context.
 * @param ctx - plugin context carrying `tools` and `subagents`.
 * @param config - the tool block: provider name, child agentOptions (an object,
 *   or a function returning the current ones), and tool name.
 */
export function mountVisionTool(ctx, config = {}) {
  const toolName = config.toolName ?? DEFAULT_TOOL_NAME
  const provider = config.provider ?? 'spawn'
  // Read per call: a settings change must take effect on the next delegation
  // without re-applying this plugin's loader entry.
  const readAgentOptions = typeof config.agentOptions === 'function'
    ? config.agentOptions
    : () => config.agentOptions

  const definition = defineTool({
    name: toolName,
    description:
      'Delegate a self-contained task to a subagent running on a vision-capable model. '
      + 'Use it when a task requires reading an image this model cannot see: pass the '
      + "image's file path or URL in the tool prompt and instruct the child to read it "
      + '(for example with its read_image tool). A path pasted by the user (often under '
      + 'the system temp directory) typically points at a pasted image — delegate it '
      + 'instead of reading it as text. This tool starts an independently managed subagent '
      + 'and immediately returns its name; the child returns text only, and the current '
      + 'session never receives the image itself.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description:
          'The complete, self-contained task for the subagent. It does not share this '
          + "conversation's context, so include everything it needs, including the image's file path or URL.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `started subagent ${value.name}`,
      }],
      presentationMeta: (_args, value) => ({
        kind: value.kind,
        name: value.name,
      }),
    },
    // Children never mutate the parent session.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error(`${toolName}: the tool requires a calling agent (exec.agent was undefined)`)
      }
      // Friendly early check before the provider enforces its own depth cap.
      if (delegationDepthOf(parent) >= MAX_CHILD_DEPTH) {
        throw new Error(`${toolName}: delegation depth limit ${MAX_CHILD_DEPTH} reached; this agent cannot delegate further`)
      }
      const agentOptions = readAgentOptions()
      exec.signal.throwIfAborted()
      return {
        kind: 'activation',
        name: (await ctx.subagents.startActivation({
          provider,
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          ...(agentOptions === undefined || agentOptions === null ? {} : { agentOptions }),
          maxDepth: MAX_CHILD_DEPTH,
          signal: exec.signal,
          delivery: 'parent',
        })).name,
      }
    },
  })

  let mounted
  const mount = () => {
    if (mounted !== undefined) return
    mounted = ctx.effect(() => {
      const unregister = ctx.tools.register(definition)
      return () => {
        unregister()
      }
    })
  }
  const unmount = () => {
    if (mounted === undefined) return
    mounted()
    mounted = undefined
  }
  ctx.on('subagent/provider-added', (added) => {
    if (added.name === provider) mount()
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name === provider) unmount()
  })
  const present = ctx.subagents.getProvider(provider)
  if (present !== undefined) mount()
  else ctx.logger.info(`subagent provider "${provider}" not registered yet; the "${toolName}" tool will register when it appears`)
  return unmount
}
