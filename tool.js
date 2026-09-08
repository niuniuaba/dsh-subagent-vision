// dsh-subagent-vision tool half: the `subagent_vision` delegation tool.
//
// This package owns the tool implementation instead of inserting a second
// instance of another bundle's subagent tool through the patch. The
// delegation runs on the public seams the harness exposes to third-party
// plugins: `ctx.subagents.start()` starts a one-shot child on the configured
// provider (the deployment's spawn backend), `ctx.tools.register(defineTool(...))`
// publishes the model-facing definition, and `ctx.jobs` backs the optional
// background mode with a plain Task job (no readOutput: the child session
// owns intermediate detail).
//
// The child route is fixed by configuration (`visionTool.agentOptions`), never
// by a model-supplied argument: image blocks stay out of the parent session
// because only the child reads them (with its own read_image) and only its
// final text returns as the tool result.
//
// Registration follows the provider lifecycle: the tool appears when the
// configured `ctx.subagents` provider appears and disappears with it, so a
// deployment without the provider never shows a tool that cannot start.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { delegationDepthOf, settleRun } from '@deepseek-ai/dsh-subagent'

/** Config block for the tool half (the host plugin passes it through). */
export const DEFAULT_TOOL_NAME = 'subagent_vision'

/**
 * Delegation depth at which a child may no longer delegate. The harness's own
 * subagent tools default to 3 (a top-level agent sits at depth 0); the vision
 * child is a leaf by design — it reads one image and answers in text — so it
 * delegates at all only under an unusually deep chain.
 */
const MAX_CHILD_DEPTH = 3

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values) {
  return values
    .filter((value) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map((value) => value.text)
    .join('')
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append provider-authored failure detail and the child's preserved partial
 * answer to a stop-reason error, keeping diagnostic text separate from the
 * child's assistant output.
 * @param error - the stop-reason headline.
 * @param result - the child's terminal result.
 * @returns the headline, diagnostic, and partial text that are present.
 */
function withDiagnosticAndPartialText(error, result) {
  const diagnostic = result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const text = (result.output ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  const partial = text.length === 0 ? '' : `\nPartial output before the run ended:\n${text}`
  return `${error}${diagnostic}${partial}`
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start, signal) {
  try {
    return await settleRun(await start)
  } catch (error) {
    // Cancellation must not turn a failed cleanup into a cleanly killed Job.
    return signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(error) }
  }
}

/**
 * Mount the `subagent_vision` tool onto the context.
 * @param ctx - plugin context carrying `tools`, `subagents`, and optionally `jobs`.
 * @param config - the tool block ({@link VisionToolConfig}): provider name,
 *   child agentOptions, tool name, and background enablement.
 */
export function mountVisionTool(ctx, config = {}) {
  const toolName = config.toolName ?? DEFAULT_TOOL_NAME
  const provider = config.provider ?? 'spawn'
  const backgroundEnabled = config.enableRunInBackground !== false
  const agentOptions = config.agentOptions

  /** Build the start request shared by foreground and background routes. */
  const buildRequest = (args, parent, signal) => ({
    label: args.description,
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
    ...agentOptions !== undefined ? { agentOptions } : {},
    maxDepth: MAX_CHILD_DEPTH,
    signal,
  })

  const definition = defineTool({
    name: toolName,
    description:
      'Delegate a self-contained task to a subagent running on a vision-capable model. '
      + 'Use it when a task requires reading an image this model cannot see: pass the '
      + "image's file path or URL in the tool prompt and instruct the child to read it "
      + '(for example with its read_image tool). A path pasted by the user (often under '
      + 'the system temp directory) typically points at a pasted image — delegate it '
      + 'instead of reading it as text. The child returns text only; the current '
      + 'session never receives the image itself.'
      + (backgroundEnabled
        ? ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
        : ' This call waits for the subagent and returns its result.'),
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
      ...(backgroundEnabled
        ? {
            run_in_background: {
              type: 'boolean',
              description:
                'Whether to run as a background job and return its id. Defaults to false; '
                + 'collect with job_output or stop with job_kill.',
            },
          }
        : {}),
    },
    output: {
      schema: backgroundEnabled
        ? {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'background' },
                  jobId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'foreground' },
                  runId: { type: 'string', required: true },
                  output: { type: 'array', required: true, items: { type: 'json' } },
                },
              },
            ],
          }
        : {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              output: { type: 'array', required: true, items: { type: 'json' } },
            },
          },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background subagent job ${value.jobId}`
          : outputValueText(value.output),
      }],
    },
    // Children never mutate the parent session; the one parent-owned write
    // (jobs.start) is a synchronous commutative insertion.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error(`${toolName}: the tool requires a calling agent (exec.agent was undefined)`)
      }
      // The provider enforces the cap at start; this early check keeps a
      // too-deep caller on a plain tool error instead of a provider rejection.
      if (delegationDepthOf(parent) >= MAX_CHILD_DEPTH) {
        throw new Error(`${toolName}: delegation depth limit ${MAX_CHILD_DEPTH} reached; this agent cannot delegate further`)
      }
      if (args.run_in_background === true) {
        if (!backgroundEnabled) {
          throw new Error(`run_in_background is disabled for ${toolName} (enableRunInBackground: false)`)
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error(`background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`)
        }
        const controller = new AbortController()
        const jobId = jobs.start({
          kind: 'subagent',
          label: args.description,
          owner: parent,
          run: () => ({
            cancel: (reason) => controller.abort(reason ?? 'background subagent job killed'),
            done: settleStart(
              ctx.subagents.start(provider, buildRequest(args, parent, controller.signal)),
              controller.signal,
            ),
          }),
        })
        return { kind: 'background', jobId }
      }
      const run = await ctx.subagents.start(provider, buildRequest(args, parent, exec.signal))
      try {
        const result = await run.result
        const error = stopReasonError(result)
        if (error !== undefined) {
          // The registry converts this throw to isError; partial output is not
          // success, but the preserved partial answer still reaches the parent.
          throw new Error(withDiagnosticAndPartialText(error, result))
        }
        return { kind: 'foreground', runId: run.id, output: result.output }
      } finally {
        // Release the child either way; disposal failures surface after the
        // result path has already thrown its own error.
        try {
          await run.dispose()
        } catch (disposeError) {
          console.error(`[dsh-subagent-vision] ${toolName} run dispose failed: ${disposeError?.message ?? disposeError}`)
        }
      }
    },
  })

  let mounted = undefined
  const mount = () => {
    if (mounted !== undefined) return
    mounted = ctx.tools.register(definition)
  }
  const unmount = () => {
    mounted?.()
    mounted = undefined
  }
  ctx.on('subagent/provider-added', (added) => {
    if (added.name === provider) mount()
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name === provider) unmount()
  })
  if (ctx.subagents.getProvider(provider) !== undefined) {
    mount()
  } else {
    ctx.logger.info(`subagent provider "${provider}" not registered yet; the "${toolName}" tool will register when it appears`)
  }
  return unmount
}
