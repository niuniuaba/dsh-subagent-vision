# Browser verification for dsh-subagent-vision

Drives the plugin's **browser half** (`client.js`) in a real Chrome, against the
plugin's **real host route** (`index.js`'s `/subagent-vision/paste` handler),
without needing a full dsh instance, a profile, or network.

## What runs

- `server.mjs` — a harness HTTP server:
  - serves the harness page and the shipped `../client.js` verbatim (the page
    provides the `window.__ModuleLoader__` protocol the client module system
    uses, plus a stub client context of the same shape the real GUI exposes —
    including a `conversation` service whose `sendSession` the plugin wraps);
  - handles `/subagent-vision/paste` by applying the **shipped `index.js`**
    against stub `llm`/`webServer` services (the same contract `verify.mjs`
    stubs) and passing the live Node request/response straight into the
    plugin's registered handler — sniffing, 0600 temp-file storage, verdict
    TTL cache and method guards are the shipped host code;
  - exposes `__verify/*` control endpoints (llm metadata map, 404 simulation,
    state/counters) used only by the driver.
- `driver.mjs` — starts the server + headless Chrome (CDP), loads the harness
  page, simulates the composer's **native intake** (draft image attachments,
  the thumbnail rail), sends through the wrapped `conversation.sendSession`,
  and asserts the send-time conversion contract.

## Requirements

- Node (the driver locates `ws` inside the global dsh install).
- `google-chrome` (or `chromium`) on PATH.
- No network access needed.

## Run

```sh
node browser-verify/driver.mjs
```

Exits non-zero on any failed assertion; prints one `PASS`/`FAIL` line per check
plus the page console on failure.

## What is verified

| # | Scenario | Expected |
|---|----------|----------|
| boot | client.js loads via `__ModuleLoader__` and `apply()` runs | no error |
| T1  | paste event dispatched, text-only session | not intercepted; no custom thumbnail strip |
| T2  | one draft image, text-only session, send | converted: temp path appended to text, imageIds emptied, 1 POST, draft released |
| T3  | two draft images, text-only | two paths, 2 POSTs, drafts released |
| T4  | draft image, vision-capable session | native send (attachments unchanged), no POST |
| T5  | draft image, unknown model | native send, no POST |
| T6  | send with no images | unchanged |
| T7  | image-typed but non-image bytes | send aborts (host 400), nothing reaches the real send |
| T8  | verdict route 404 | conversion stands down; native send |
| T9  | same model twice | verdict cached (one GET) |
| T10 | draft removed via the rail (undo), then send | plain-text send, nothing converted |
| T11 | stale image ids with no attachments | pass through unchanged |

The host-side assertions covered by the shipped `verify.mjs` (Config schema,
tool registration, agentOptions forwarding, guide-section rendering) remain the
node-level check; this harness deliberately scopes to what only a browser can
exercise.
