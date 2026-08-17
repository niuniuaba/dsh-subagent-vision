# dsh-subagent-vision

English | [中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle plugin that lets a **text-only** main agent (DeepSeek) read images **in the same session**: when a task needs vision, the main agent delegates to a fresh subagent routed to a **vision-capable model you pick in the settings** (configured under Settings > Models, chosen under Settings > 视觉处理模型; the factory default is `qwen3.8-max` — see [Configure](#configure)), and the child's text result is merged back. **Pasting or dropping an image just works**: intake stays native (thumbnail rail, remove/undo); when you hit send on a text-only session, the browser half uploads each draft image to a private temp file and appends the paths to your prompt, so the request never trips image admission and the text-only agent can delegate the paths to the vision subagent. No model switching, no second session, no copy-paste.

## Why

DeepSeek chat models cannot take image input, and the harness refuses to switch a session that contains images to a text-only model (and a text-only adapter would reject the image at request time anyway). The harness does have a first-class subagent seam (`subagent` / `subagent_fork` tools) whose children can be routed to any registered provider/model — this bundle simply exposes a second delegation tool pinned to the vision route you pick in the settings, plus a send-time image-to-path conversion so images reach that tool as file paths without tripping admission.

## How it works

The bundle's `cordis.patch.yml` inserts two rows into the profile composition:

- **`tool-subagent-vision`** — a second `@deepseek-ai/dsh-tool-subagent` instance (`toolName: subagent_vision`, `provider: spawn`, `backgroundMode: one-shot`). The row starts with the factory-default `agentOptions` in the shipped `cordis.patch.yml` (qwen/qwen3.8-max) so the tool works out of the box; picking a different model in Settings > 视觉处理模型 rewrites that file (the new route applies from the next restart, and immediately too when the live sync works); if anything breaks, edit the `agentOptions` block directly in that file. Image blocks never enter the parent's session: the parent passes a **file path or URL** in the tool prompt, the vision child reads it with its own `read_image` tool (its execution gate checks the *child's* routed model, which declares image input), and only the child's final **text** returns as the tool result.
- **`subagent-vision`** — this package's root plugin, which does three things:
  - **Guidance**: registers one prompt section telling the model when to use `subagent_vision` (the stock subagent tool description says nothing about vision). With no route configured it tells the model *not* to call the tool and to ask the user to configure one first.
  - **Vision-route settings**: a settings section (`subagent-vision` namespace, persisted in `settings.yaml`) plus a Settings > 视觉处理模型 entry rendered by the browser half. The dropdown lists the models this deployment has actually configured with image input declared (from `llm.listConfigurableProviders` plus each provider's settings document — the same metadata the paste verdict trusts); when none exist it shows a hint that names the configured-but-undecided models and offers each a one-click **declare image input** button (writes `input: [text, image]` into that model's entry in the provider settings document, e.g. `settings.yaml` — the Settings > Models surface itself cannot express input modalities, so a model configured there arrives text-only until declared). The choice is synced onto the tool row's `agentOptions` at registration and whenever the setting changes — and also persisted into this bundle's own `cordis.patch.yml`, so the tool row starts with the chosen route on the next boot even if the live sync cannot apply it; a saved model that no longer resolves, or that doesn't declare image input, is refused.
  - **Paste-to-path route** (`/subagent-vision/paste`): `GET` answers whether a given `provider`/`model` is positively confirmed text-only (from `inputModalities`, never a name guess); `POST` sniffs image magic bytes (PNG/JPEG/GIF/WebP/HEIC/HEIF), enforces a 25 MB cap, writes a private `0600` temp file, and returns its path.
- **Browser half** (`client.js`, loaded automatically through the package's `dsh.client` manifest): **intake is left fully native** — pasting or dropping an image shows the composer's own thumbnail rail, native caret behaviour, and native remove/undo. The plugin's only interception is at **send time**: when the draft carries image attachments and the target session's model is positively confirmed text-only (the host's verdict, cached 60 s and re-asked when stale), each draft image is uploaded to the host route (POST /subagent-vision/paste -> private temp path), the draft is released, and the paths are appended to the prompt text before the real send — so the request carries text only and never trips image admission. Image-capable models and unknown models send natively (attachments go through unchanged).

The child is composed like any in-process subagent: its own session, its own tools (the parent's preset composition, including `read_image` when attachments are mounted), and the standard delegation policy (child approval pinned to `never`, sandbox inherited). The child's internal image blocks stay in the child's own log.

## Requirements

- A dsh installation whose base bundle mounts the subagent capability, tool-fs (`read_image`), attachments, and the Web surface (the stock `web` profile does; the browser half needs the Web GUI).
- At least one vision-capable model configured through **Settings > Models** (model metadata declaring image input). The shipped patch's factory default is `qwen/qwen3.8-max`: if that model isn't configured in your deployment, either configure it, pick your own model in Settings > 视觉处理模型, or edit the `agentOptions` field in the bundle's `cordis.patch.yml`.
- The pasted image must fit the route cap (25 MB default); the child's `read_image` applies the deployment's canonical image limits when it reads the file.
- Runtime dependencies resolved from the profile (`@deepseek-ai/dsh-settings`, `@deepseek-ai/schemastery` host-side; `react` from the client module system).

## Install

```sh
# from npm (fastest — works with the official registry or CN mirrors)
dsh plugin --profile web add dsh-subagent-vision

# from GitHub (pnpm shorthand; append #<tag-or-branch> to pin a revision)
dsh plugin --profile web add github:niuniuaba/dsh-subagent-vision

# from GitHub (explicit git URL)
dsh plugin --profile web add git+https://github.com/niuniuaba/dsh-subagent-vision.git

# from a local checkout
dsh plugin --profile web add /path/to/plugins/dsh-subagent-vision
```

Restart dsh, then confirm with `dsh plugin --profile web list`.

## Use

Paste an image, drag one into the composer textarea, or give the agent a path/URL, and state a task. On a text-only model the intake becomes a file path in the composer; on a vision model it stays a normal thumbnail paste. Either way, tell the agent what you need:

> Read the pasted image and summarize what it shows, then continue from there.

The main agent calls `subagent_vision` with the path; the child reads it and returns text; the conversation continues in the same session.

## Configure

**Factory default: `qwen3.8-max`.** The shipped `cordis.patch.yml` pins `qwen/qwen3.8-max` as the vision processing model, so the tool works out of the box. To use your own model:

1. Configure it under **Settings > Models** — a provider whose model declares image input (e.g. `qwen3.8-max` with `input: [text, image]`).
2. Open **Settings > 视觉处理模型**, pick your model from the dropdown, and save. The choice is written to `settings.yaml` and persisted into this bundle's own `cordis.patch.yml` (applies from the next restart; the live loader sync also tries to apply it immediately).

The Models surface cannot express input modalities: a model configured there is stored without an `input` declaration and is therefore treated as **text-only** by the harness until you declare otherwise. If the picker shows your model under "声明支持图片输入", click that button (it writes `input: [text, image]` into the model's `settings.yaml` entry) — or add the line by hand:

```yaml
llm-pi-ai:
  providers:
    qwen:
      models:
        - id: qwen3.8-max
          name: qwen3.8-max
          input: [text, image]
```

If something goes wrong, you can edit the `agentOptions` field directly in the bundle's patch file:

```text
$DSH_HOME/profiles/web/node_modules/dsh-subagent-vision/cordis.patch.yml
```

```yaml
agentOptions:
  provider: qwen        # use a provider your deployment actually has
  model: qwen3.8-max
  maxTokens: 16384
```

(A row with the same id in your profile's own `cordis.patch.yml` also overrides this one — later patch layers win.) If the dropdown instead shows a hint naming your configured model under "声明支持图片输入", click that button (or add `input: [text, image]` to the model's `settings.yaml` entry), then reload the settings page — the list is re-read live.

The host plugin is configurable through the `subagent-vision` row's config: `toolName`, `modelHint`, `order`, `visionSettings: false` (turns the settings section and picker off), `pasteToPath: false` (turns the takeover off; the client stands down when the route 404s), `maxBytes`, `verdictTtlMs`.

## Verify

From the repository root:

```sh
node verify-settings.mjs          # settings section, enumeration, picker route, tool-row sync
node verify-live.mjs              # live instance: named hint + one-click declare (see below)
node browser-verify/driver.mjs    # browser half in real Chrome (see browser-verify/README.md)
```

`verify-live.mjs` drives the REAL running dsh web instance through `/subagent-vision/settings`: with the model under test temporarily not declaring image input (options empty), it asserts the hint names the configured-but-undecided model, POSTs the `declareImage` action, and asserts the model becomes selectable again — the declaration itself restores the config. Run `node verify-live.mjs [baseURL] [provider] [model]` (defaults `http://127.0.0.1:3080 qwen qwen3.8-max`).

`verify-settings.mjs` runs the host plugin against a real cordis context with stub `llm`/`settings`/`loader` services and asserts: the settings section registers under `subagent-vision`, its dropdown options are exactly the configured image-declaring models, registration and settings changes sync the tool row's `agentOptions` (preserving the rest of the config), unresolvable or non-image routes are refused, the picker's HTTP route serves and persists the choice, configured-but-undecided models are surfaced and can be declared image-capable with one click, and the no-model hint renders. The browser suite drives the shipped `client.js` in Chrome against the real paste route and the send-time conversion (native intake untouched, drafts converted on send for text-only sessions, native send for vision/unknown models, upload failures abort the send).

(The repo-layout-dependent `verify.mjs` from the plugin's original checkout asserts the tool/subagent wiring itself; it needs the full harness repo tree.)

## Limitations

- **No per-call model selection**: the child route is the deployment-configured `agentOptions`, not a tool argument the model can change mid-task. (This is a stock `tool-subagent` schema constraint, not this bundle's.)
- **Send-time conversion is all-or-nothing per send**: a draft's images are all converted before the send; a failed upload aborts the send (the composer restores the draft and thumbnails, so nothing is lost).
- **Temp files accumulate**: pasted images land in the OS temp directory under `subagent-vision-paste-*`; nothing deletes them (the OS temp cleaner will).
- **One-shot children**: the child settles and its conversation is read-only afterwards (use the stock `subagent`/continuable tools if you need to keep talking to a child).
- **The parent model never sees the image itself** — only the child's text reading of it.

## Credits

The image-to-path pattern (magic-byte sniffing, private temp files, host-side verdict) follows [ModLens](https://github.com/liustack/modlens) (MIT); this bundle differs by resolving the current model from the client object layer instead of the model-selector DOM label, converting at send time instead of intercepting intake, and delegating to a vision subagent instead of an external vision engine.

## License

MIT
