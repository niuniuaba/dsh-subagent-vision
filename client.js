// Browser half of dsh-subagent-vision: send-time image-to-path conversion +
// the vision-route picker (Settings > 视觉处理模型).
//
// Intake is left ENTIRELY native: pasting or dropping an image shows the
// composer's own thumbnail rail, the native caret behaviour, and the native
// remove/undo affordances. This plugin's only interception is at SEND time:
// when a draft carries image attachments and the target session's model is
// positively confirmed text-only (the host's verdict from provider metadata,
// cached 60 s), each draft image is uploaded to the host route
// (POST /subagent-vision/paste -> private temp file path), the draft is
// released, and the paths are appended to the prompt text before the real
// send — so the request carries text only and never trips image admission.
// Image-capable models and unknown models send natively (attachments go
// through unchanged).
//
// The vision-route picker registers a settings.section entry; it reads and
// writes through the plugin's own /subagent-vision/settings route (the client
// settings RPC serves only a hardcoded namespace allowlist), rendering the
// dropdown with hand-written React via createElement.
//
// Hand-written in the lazy-CJS bundle protocol
// (window.__ModuleLoader__.load), so no build step.
window.__ModuleLoader__.load({
  id: 'dsh-subagent-vision',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var VERDICT_MAX_AGE_MS = 60000
    var routeAvailable = true
    var verdicts = {}

    // Upload one image to the host route; resolves to the stored temp path.
    function uploadOne(file) {
      return file.arrayBuffer().then((buffer) =>
        fetch('/subagent-vision/paste', { method: 'POST', body: buffer }).then((res) => {
          if (!res.ok) {
            return res
              .json()
              .catch(() => ({}))
              .then((body) => {
                var error = new Error(body.error || `paste upload failed (${res.status})`)
                error.status = res.status
                throw error
              })
          }
          return res.json()
        }),
      )
    }

    // Whether the target session's model is positively confirmed text-only:
    // the host's verdict from inputModalities, never a name guess. Unknown
    // (unresolvable model, route gone) answers false, keeping the intake
    // native for anything we cannot confirm.
    function textOnlyFor(ctx, sessionId) {
      return ctx.connection.api.sessions
        .models({ sessionId })
        .then((res) => {
          if (!res.result?.ok) return false
          var selection = res.result.value?.current
          if (!selection?.provider || !selection?.model) return false
          var key = JSON.stringify([selection.provider, selection.model])
          var cached = verdicts[key]
          if (cached && !cached.pending && Date.now() - cached.at <= VERDICT_MAX_AGE_MS) {
            return cached.takeover === true
          }
          var entry = { pending: true, takeover: cached ? cached.takeover : false, at: cached ? cached.at : 0 }
          verdicts[key] = entry
          return fetch(
            `/subagent-vision/paste?provider=${encodeURIComponent(selection.provider)}&model=${encodeURIComponent(selection.model)}`,
          )
            .then((res) => {
              if (res.status === 404) {
                routeAvailable = false
                entry.pending = false
                return false
              }
              if (!res.ok) throw new Error(`policy ${res.status}`)
              return res.json()
            })
            .then((body) => {
              entry.pending = false
              if (body) {
                entry.takeover = body.takeover === true
                entry.at = Date.now()
              }
              return entry.takeover === true
            })
            .catch(() => {
              entry.pending = false
              return false
            })
        })
        .catch(() => false)
    }

    // Wrap the conversation service's sendSession: on a text-only session,
    // turn draft image attachments into temp paths appended to the prompt
    // before sending, so the request carries no image blocks.
    function wrapSendSession(ctx, conversation) {
      var original = conversation.sendSession.bind(conversation)
      conversation.sendSession = async function (session, text, imageIds, mode) {
        if (imageIds.length === 0 || !routeAvailable) return original(session, text, imageIds, mode)
        var textOnly = await textOnlyFor(ctx, session.sessionId)
        if (!textOnly) return original(session, text, imageIds, mode)
        var attachments = conversation.draftImages(imageIds)
        if (attachments.length === 0) return original(session, text, imageIds, mode)
        var paths = []
        for (var i = 0; i < attachments.length; i++) {
          // A failed upload aborts the send; the composer's sink restores the
          // draft and thumbnails (its usual send-failure recovery).
          var result = await uploadOne(attachments[i].file)
          if (result && typeof result.path === 'string') paths.push(result.path)
        }
        conversation.releaseDraftImages(attachments)
        var finalText = text === '' ? paths.join(' ') : `${text} ${paths.join(' ')}`
        return original(session, finalText, [], mode)
      }
    }

    // ---- vision-route settings entry (Settings > 视觉处理模型) ----
    //
    // A self-contained settings.section: the dropdown lists the models the
    // host enumerated (live re-read through the plugin route), the current
    // value comes from the namespace document, and saving issues a settings
    // mutate. When the host has no selectable options it shows the hint it put
    // on the field — "configure a vision model in Settings > Models first" —
    // and, when configured models exist but none declares image input (the
    // Models surface cannot express input modalities), lists them with a
    // one-click "declare image input" button that writes `input: [text, image]`
    // into that model's settings entry. No build step: hand-written React via
    // createElement.
    function VisionRouteSection() {
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var [state, setState] = useState({ status: 'loading', options: [], undecided: [], current: '', hint: '' })
      function load() {
        return fetch('/subagent-vision/settings')
          .then((res) => res.json())
          .then((data) => {
            setState({
              status: 'ready',
              options: Array.isArray(data.options) ? data.options : [],
              undecided: Array.isArray(data.undecided) ? data.undecided : [],
              current: typeof data.current === 'string' ? data.current : '',
              hint: typeof data.hint === 'string' ? data.hint : '',
            })
          })
          .catch((error) => {
            setState({ status: 'error', options: [], undecided: [], current: '', hint: String(error?.message ?? error) })
          })
      }
      useEffect(() => {
        load()
      }, [])
      function onSelect(event) {
        var value = event.target.value
        fetch('/subagent-vision/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visionRoute: value }),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data.ok === true) setState((s) => Object.assign({}, s, { current: data.current }))
          })
          .catch(() => {
            /* keep the previous value on failure */
          })
      }
      function declareImage(provider, model) {
        fetch('/subagent-vision/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'declareImage', provider, model }),
        })
          .then((res) => {
            // 404: the running host predates the declare route (plugin not
            // restarted). Fall back to the manual hint instead of a dead button.
            if (res.status === 404) {
              setState((s) =>
                Object.assign({}, s, {
                  status: 'error',
                  hint: '「声明支持图片输入」需要重启 dsh 生效（宿主路由尚未加载）。也可直接编辑 settings.yaml：在该模型的 models 条目中添加 input: [text, image]。',
                }),
              )
              return null
            }
            return res.json()
          })
          .then((data) => {
            if (data && data.ok === true) {
              // The model now declares image input: refresh the list so the
              // dropdown appears with it selectable.
              load()
            }
          })
          .catch(() => {
            /* keep the previous state on failure */
          })
      }
      var style = { width: '100%', minHeight: '34px', boxSizing: 'border-box' }
      var labelStyle = { margin: '0 0 6px', fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #222)' }
      var hintStyle = { margin: '4px 0 8px', color: 'var(--dsw-alias-label-tertiary, #888)' }
      var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0', fontSize: '13px' }
      var nameStyle = { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      var buttonStyle = {
        boxSizing: 'border-box',
        height: '28px',
        border: 'none',
        borderRadius: '14px',
        cursor: 'pointer',
        padding: '0 12px',
        fontSize: '12px',
        lineHeight: '28px',
        background: 'var(--dsw-alias-button-primary-fill, #2563eb)',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        flex: 'none',
      }
      var body
      if (state.status === 'ready' && state.options.length > 0) {
        body = h(
          'div',
          { key: 'picker' },
          h('p', { key: 'label', style: labelStyle, 'data-testid': 'vision-route-label' }, '请选择视觉处理模型'),
          h(
            'select',
            { key: 'select', value: state.current, onChange: onSelect, style: style, 'data-testid': 'vision-route-select' },
            state.current === '' ? h('option', { key: 'empty', value: '' }, '—') : null,
            state.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
          ),
        )
      } else if (state.status === 'ready' && state.undecided.length > 0) {
        body = h(
          'div',
          { key: 'undecided' },
          h('p', { key: 'hint', style: hintStyle, 'data-testid': 'vision-route-hint' }, state.hint),
          h(
            'ul',
            { key: 'list', style: { listStyle: 'none', margin: '0', padding: '0' } },
            state.undecided.map((entry) =>
              h(
                'li',
                { key: `${entry.provider}/${entry.model}`, style: rowStyle },
                h(
                  'span',
                  { key: 'name', style: nameStyle },
                  `${entry.displayName || entry.provider}: ${entry.modelName || entry.model}`,
                ),
                h(
                  'button',
                  {
                    key: 'declare',
                    type: 'button',
                    style: buttonStyle,
                    'data-testid': `vision-route-declare-${entry.provider}-${entry.model}`,
                    onClick: () => declareImage(entry.provider, entry.model),
                  },
                  '声明支持图片输入',
                ),
              ),
            ),
          ),
        )
      } else if (state.status === 'ready') {
        body = h('p', { key: 'hint', style: hintStyle }, state.hint || '…')
      } else if (state.status === 'loading') {
        body = h('p', { key: 'loading', style: hintStyle }, '…')
      } else {
        body = h('p', { key: 'error', style: { margin: '4px 0', color: 'var(--dsw-alias-state-error-primary, #c0392b)' } }, state.hint)
      }
      return h('div', { 'data-testid': 'vision-route-section' }, body)
    }

    function apply(ctx) {
      // Send-time conversion: only when the conversation service is present.
      var conversation = ctx.conversation || (typeof ctx.get === 'function' ? ctx.get('conversation') : undefined)
      if (conversation && typeof conversation.sendSession === 'function' && typeof conversation.draftImages === 'function') {
        wrapSendSession(ctx, conversation)
      }
      // Settings entry: the vision-route picker card. Only when the client
      // slots service (the settings shell) is present.
      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'subagent-vision',
              order: 100,
              label: '视觉处理模型',
            },
            VisionRouteSection,
          ),
        )
      }
    }

    exports.apply = apply
    exports.inject = ['connection', 'sessions', 'slots', 'conversation']
    return module.exports
  },
})
