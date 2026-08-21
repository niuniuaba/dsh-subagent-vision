# dsh-subagent-vision

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle 插件：让**纯文本**主代理（DeepSeek）在**同一会话内**读图——**不需要切换模型、不需要另开会话、不需要复制粘贴**。需要视觉时，主代理指派一个路由到**你在设置里选定的多模态模型**（先在「设置 > 模型」配置，再在「设置 > 视觉处理模型」选择；出厂默认 `qwen3.8-max`，详见[配置](#配置)）的全新子代理，子代理的文本结果再 merge 回当前会话。图片本身永远不会到达主模型：父代理只传**文件路径或 URL**，返回的是子代理对图的文本描述——所以这**不是**"当前模型原生支持图片输入"；当前会话的模型仍是纯文本，视觉发生在被委派的子代理里。**粘贴或拖放图片直接可用**：摄入保持完全原生（缩略图栏、删除/撤销照常）；在纯文本会话点击发送时，浏览器半区把每张草稿图片上传成私有临时文件、把路径追加到你的输入文本里，请求不会触发图片准入，纯文本代理即可把路径委派给视觉子代理。

## 为什么

DeepSeek 聊天模型不支持图片输入，而 harness 又拒绝把含图的会话切到纯文本模型（即使切了，纯文本 adapter 也会在请求时拒绝图片）。但 harness 本身有完善的子代理能力（`subagent` / `subagent_fork` 工具），子代理可以路由到任意已注册的 provider/model——这个 bundle 只是把一条指向你在设置里选定的视觉路由的第二个委派工具暴露出来，外加发送时的图片转路径转换，让图片以文件路径的形式到达该工具而不触发准入。

## 工作原理

bundle 的 `cordis.patch.yml` 向 profile 组合插入两行：

- **`tool-subagent-vision`** — 第二个 `@deepseek-ai/dsh-tool-subagent` 实例（`toolName: subagent_vision`、`provider: spawn`、`backgroundMode: one-shot`）。该行以发布版 `cordis.patch.yml` 中的**出厂默认 `agentOptions`**（qwen/qwen3.8-max）启动，保证开箱即用；在「设置 > 视觉处理模型」里改选模型会把该选择**写回这个 patch 文件**（新路由下次重启生效，实时 loader 同步成功时也会立即生效）；出问题时可直接编辑该文件的 `agentOptions` 字段。图片块永远不会进入父会话：父代理在工具 prompt 里传**文件路径或 URL**，视觉子代理用自己的 `read_image` 工具读取（该工具的执行闸门检查的是*子代理*的路由模型，它声明支持图片），只有子代理最终的**文本**作为工具结果返回。
- **`subagent-vision`** — 本包根插件，做三件事：
  - **引导提示词**：注册一段提示词，告诉模型何时用 `subagent_vision`（自带的 subagent 工具描述里完全没提视觉）。未配置路由时，它会告诉模型*不要*调用该工具、先让用户配置。
  - **视觉路由设置**：注册 `subagent-vision` 命名空间的设置 section（持久化到 `settings.yaml`），浏览器半区渲染「设置 > 视觉处理模型」入口。下拉框列出**所有可路由且声明支持图片输入的模型**——从 adapter 目录实时枚举（`ctx.llm.listModels`，合并各 provider 的 catalog 与 settings 覆盖），所以 adapter 自带的多模态模型（如 llm-deepseek 默认 catalog 里的 `deepseek-v4-flash-vision-exp`）即使 settings 条目从未声明模态也会出现（与 paste 裁决信任的是同一份元数据）；没有可用模型时，提示会**点名已配置但未声明图片输入的模型**，并为每个模型提供一键**「声明支持图片输入」**按钮（把 `input: [text, image]` 写进该模型在 provider settings 文档里的条目，如 `settings.yaml`——「设置 > 模型」界面本身无法表达输入模态，所以在那里配置的模型默认按纯文本处理，直到显式声明）。选择结果在注册时和设置每次变更时同步到工具行的 `agentOptions`，**并持久化进本 bundle 自己的 `cordis.patch.yml`**——即使实时同步失效，工具行也会在下次启动时带着所选路由；若保存的模型已无法解析、或未声明图片输入，会被拒绝。
  - **Paste-to-path 路由**（`/subagent-vision/paste`）：`GET` 回答给定 `provider`/`model` 是否被**正向确认**为纯文本（依据 `inputModalities`，绝不靠名字猜测）；`POST` 校验图片 magic bytes（PNG/JPEG/GIF/WebP/HEIC/HEIF）、强制 25 MB 上限、写入私有 `0600` 临时文件并返回路径。
- **浏览器半区**（`client.js`，通过包的 `dsh.client` 清单自动加载）：**摄入保持完全原生**——粘贴或拖放图片走 composer 自己的缩略图栏、原生光标行为与删除/撤销。插件的唯一拦截点在**发送时**：当草稿携带图片附件且目标会话模型被**正向确认**为纯文本（host 裁决，基于 `inputModalities`，60 秒缓存、过期重问）时，把每张草稿图片上传到宿主路由（POST /subagent-vision/paste → 私有临时路径）、释放草稿，并把路径追加到提示文本后再真正发送——请求只带文本，永不触发图片准入。支持图片的模型与未知模型原样带图发送。

子代理与普通 in-process 子代理一致：独立会话、独立工具集（继承父代预设组合，含 attachments 挂载时的 `read_image`）、标准委派策略（子代理审批固定为 `never`、sandbox 继承）。子代理内部的图片块只留在子代理自己的日志里。

## 前置条件

- 已安装挂载了子代理能力、tool-fs（`read_image`）、attachments 和 Web 表面的 dsh base bundle（官方 `web` profile 满足；浏览器半区需要 Web GUI）。
- 在**「设置 > 模型」**中至少配置一个支持图片输入的视觉模型（模型元数据声明 image input）。发布的 patch 出厂默认 `qwen/qwen3.8-max`：若你的部署没有该模型，可以配置它，或在「设置 > 视觉处理模型」里改选自己的模型，或直接修改插件 `cordis.patch.yml` 中的 `agentOptions` 字段。
- 粘贴的图片不能超过路由上限（默认 25 MB）；子代理 `read_image` 读取文件时会套用部署的规范图片限额。
- 运行时依赖从 profile 解析（宿主侧 `@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`；客户端 `react` 来自 client 模块系统）。

## 安装

```sh
# 从 npm 安装（最快；官方源或国内镜像均可）
dsh plugin --profile web add dsh-subagent-vision

# 从 GitHub 安装（pnpm 简写；可追加 #<标签或分支> 锁定版本）
dsh plugin --profile web add github:niuniuaba/dsh-subagent-vision

# 从 GitHub 安装（显式 git URL）
dsh plugin --profile web add git+https://github.com/niuniuaba/dsh-subagent-vision.git

# 本地目录
dsh plugin --profile web add /path/to/plugins/dsh-subagent-vision
```

重启 dsh，用 `dsh plugin --profile web list` 确认。

## 使用

粘贴图片、把图片拖进 composer 的输入框，或给代理一个路径/URL，并说明任务。摄入阶段与原生一致（缩略图栏、删除/撤销）；发送时若会话模型是纯文本，草稿图片会被转成文件路径追加到文本后发出，视觉模型下则原样带图发送。无论哪种，告诉代理你的需求：

> Read the pasted image and summarize what it shows, then continue from there.

主代理调用 `subagent_vision` 并传入路径；子代理读图后返回文本；对话在同一会话继续。

## 配置

**出厂默认：`qwen3.8-max`。** 发布的 `cordis.patch.yml` 把视觉处理模型默认为 `qwen/qwen3.8-max`，开箱即用。要使用你自己的模型：

1. 先在 dsh 内置的**「设置 > 模型」**页配置一个声明支持图片输入的模型（如 `input: [text, image]` 的 `qwen3.8-max`）。
2. 打开**「设置 > 视觉处理模型」**（下拉框上方有"请选择视觉处理模型"提示），从下拉框选一个模型并保存。选择写入 `settings.yaml`，**并持久化进本 bundle 自己的 `cordis.patch.yml`**（新路由下次重启生效；实时 loader 同步成功时也会立即生效）。

adapter 自带图片能力的模型**无需任何声明**：llm-deepseek 的默认 catalog 已把 `deepseek-v4-flash-vision-exp` 标记为 `inputModalities: [text, image]`，只要配置了该 provider，它就会出现在下拉框里。（即便如此，它在这里也只是「视觉处理模型」的*候选*——`subagent_vision` 委派的目标。主会话的对话模型仍是你选的那个；声明某个模型支持图片，绝不改变当前会话模型能直接接收什么。）

「设置 > 模型」界面无法表达输入模态：在那里配置的模型条目**不会带 `input` 声明**，因此 harness 会把它当作**纯文本**处理，直到你显式声明。若选择器把你的模型列在「声明支持图片输入」下，点击该按钮即可（它会向该模型的 `settings.yaml` 条目写入 `input: [text, image]`）；也可以手动添加：

```yaml
llm-pi-ai:
  providers:
    qwen:
      models:
        - id: qwen3.8-max
          name: qwen3.8-max
          input: [text, image]
```

如果遇到问题，可以直接修改插件 patch 文件中的 `agentOptions` 字段：

```text
$DSH_HOME/profiles/web/node_modules/dsh-subagent-vision/cordis.patch.yml
```

```yaml
agentOptions:
  provider: qwen        # 改成你部署里实际存在的 provider
  model: qwen3.8-max
  maxTokens: 16384
```

（在自己 profile 的 `cordis.patch.yml` 中加同 id 的行也可以覆盖本行——后层 patch 生效。）如果下拉框显示的是点名你已配置模型的提示（并带「声明支持图片输入」按钮），点击该按钮（或在 `settings.yaml` 为该模型条目加 `input: [text, image]`），然后刷新设置页——列表是实时重新枚举的。

host 插件通过 `subagent-vision` 行的 config 配置：`toolName`、`modelHint`、`order`、`visionSettings: false`（关闭设置 section 与选择器）、`pasteToPath: false`（关闭接管；路由 404 时客户端自动停摆）、`maxBytes`、`verdictTtlMs`。

## 验证

在仓库根目录运行：

```sh
node verify-settings.mjs          # 设置 section、模型枚举、选择器路由、工具行同步
node verify-live.mjs              # 真实实例：点名提示 + 一键声明（见下）
node browser-verify/driver.mjs    # 浏览器半区（真实 Chrome，见 browser-verify/README.md）
```

`verify-live.mjs` 直接驱动**正在运行的** dsh web 实例（经 `/subagent-vision/settings`）：在待测模型暂时未声明图片输入（选项为空）的前提下，断言提示点名了已配置但未声明的模型、POST `declareImage` 动作、并断言模型重新可选——声明动作本身就还原了配置。用法：`node verify-live.mjs [baseURL] [provider] [model]`（默认 `http://127.0.0.1:3080 qwen qwen3.8-max`）。

`verify-settings.mjs` 在真实 cordis 上下文 + stub `llm`/`settings`/`loader` 服务下运行 host 插件，断言：`subagent-vision` 设置 section 完成注册、下拉选项恰好是 adapter 目录中声明图片输入的模型（包括 settings 条目从未声明模态的 adapter 自带视觉模型）、注册与设置变更都会同步工具行的 `agentOptions`（保留其余配置）、无法解析或不支持图片的路由会被拒绝、选择器的 HTTP 路由能读取并持久化选择、未声明图片输入的已配置模型会被点名且支持一键声明、无模型提示正常渲染。浏览器套件在真实 Chrome 里驱动发货的 `client.js` 对抗真实 paste 路由。

（插件原仓库布局依赖的 `verify.mjs` 断言工具/subagent 接线本身，需要完整的 harness 仓库树才能运行。）

## 限制

- **没有按次调用的模型选择**：子代理路由来自部署配置的 `agentOptions`，不是模型能在任务中改的工具参数（这是 `tool-subagent` 自带 schema 的约束，不是本 bundle 的）。
- **输入框之外的 drop 保持原生**：浏览器半区接管 composer 内的粘贴和落在 textarea 上的 drop；其他位置的 drop（composer 的整页摄入）仍走缩略图栏，纯文本模型下发送时仍会撞上图片准入。
- **冷启动首次摄入**：接管需要一份新鲜的 host 裁决，因此纯文本模型冷启动后的第一次粘贴/拖放可能走一次原生流程。
- **临时文件会累积**：粘贴的图片落在系统临时目录的 `subagent-vision-paste-*` 下，无人删除（交给系统临时清理）。
- **one-shot 子代理**：结束后子代理会话只读（需要持续与子代理对话时，用自带的 `subagent`/continuable 工具）。
- **父模型永远看不到图片本身**——只有子代理对它的文本描述。

## 致谢

图片转路径模式（magic-byte 嗅探、私有临时文件、host 侧裁决）参考了 [ModLens](https://github.com/liustack/modlens)（MIT）；本 bundle 的不同之处在于从客户端对象层解析当前模型（而非模型选择器的 DOM label）、在发送时转换而非拦截摄入，以及委派给视觉子代理而非外部视觉引擎。

## License

MIT
