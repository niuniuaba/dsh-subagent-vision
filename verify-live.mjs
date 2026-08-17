// verify-live.mjs — live instance test for the vision-route picker's two
// improvements:
//   1. the hint that NAMES configured-but-undecided models (点名提示);
//   2. the one-click "declare image input" action (一键声明支持图片输入).
//
// It drives the REAL running dsh web instance through its HTTP surface
// (/subagent-vision/settings) and asserts the full flow:
//   before : options empty, `undecided` lists <provider>/<model>, hint names it
//   declare: POST {action:'declareImage', provider, model} writes
//            `input: [text, image]` back into the model's settings entry -> ok
//   after  : the model is selectable again (the config is RESTORED by the test)
//
// Prereqs:
//   * dsh web running with the updated plugin code — restart after syncing
//     index.js into the profile's node_modules copy;
//   * the model under test currently does NOT declare image input (options
//     empty) — the pre-test state is prepared by removing the `input` line
//     from ~/.dsh/settings.yaml (backup kept as .pre-vision-test.bak).
//
// Usage:
//   node verify-live.mjs [baseURL] [provider] [model]
//   defaults: http://127.0.0.1:3080  qwen  qwen3.8-max
// Exits 0 only when every assertion passes.
const base = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const provider = process.argv[3] ?? 'qwen'
const model = process.argv[4] ?? 'qwen3.8-max'
const route = `${provider}/${model}`

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failures += 1
}

const get = async () => {
  const res = await fetch(`${base}/subagent-vision/settings`)
  if (!res.ok) throw new Error(`GET /subagent-vision/settings -> HTTP ${res.status}`)
  return res.json()
}
const post = async (body) => {
  const res = await fetch(`${base}/subagent-vision/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data = {}
  try {
    data = await res.json()
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, data }
}

console.log(`verify-live: ${base}  target=${route}`)

// ---- 0. pre-state ----
let before
try {
  before = await get()
} catch (error) {
  console.error(`cannot reach the instance: ${error.message}`)
  console.error('is dsh web running, and was it restarted after the plugin sync?')
  process.exit(1)
}
const alreadyListed = (before.options ?? []).some((o) => o.value === route)
if (alreadyListed) {
  console.error(`SKIP: ${route} already declares image input (options non-empty), so the `)
  console.error('undecided/declare flow cannot be shown. To prepare the pre-test state:')
  console.error('  rm ~/.dsh/settings.yaml && cp ~/.dsh/settings.yaml.pre-vision-test.bak ~/.dsh/settings.yaml')
  console.error('  # then remove the "input: [ text, image ]" line under the model, and restart dsh web')
  process.exit(1)
}

// ---- 1. named hint (点名提示) ----
const undecided = before.undecided ?? []
check(
  'undecided lists the configured model',
  undecided.some((u) => u.provider === provider && u.model === model),
  JSON.stringify(undecided),
)
check(
  'hint names the model',
  typeof before.hint === 'string' && before.hint.includes(route),
  before.hint,
)
check(
  'options are empty (nothing selectable yet)',
  Array.isArray(before.options) && before.options.length === 0,
  JSON.stringify(before.options),
)

// ---- 2. one-click declare (一键声明支持图片输入) ----
const declared = await post({ action: 'declareImage', provider, model })
check(
  'declareImage accepted',
  declared.status === 200 && declared.data.ok === true,
  `HTTP ${declared.status} ${JSON.stringify(declared.data)}`,
)
if (declared.status === 400 && String(declared.data.error ?? '').includes('visionRoute')) {
  console.error('note: the running host predates the declareImage action — restart dsh web to load the updated plugin')
}
if (declared.status === 400 && String(declared.data.error ?? '').includes('cannot declare image input')) {
  console.error(`note: provider ${provider} settings schema cannot express model input modalities — declare is refused by design`)
}

// ---- 3. restored state ----
const after = await get()
check(
  'model is now selectable (config restored)',
  (after.options ?? []).some((o) => o.value === route),
  JSON.stringify(after.options),
)
check(
  'model no longer undecided',
  !(after.undecided ?? []).some((u) => u.provider === provider && u.model === model),
)

console.log(failures === 0 ? 'ALL LIVE CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
