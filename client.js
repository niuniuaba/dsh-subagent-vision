// dsh-subagent-vision browser half (0.2.x port): send-time image-to-path
// conversion + the vision-route picker (Settings → Vision model).
//
// Intake stays native (thumbnail rail, caret, remove/undo). The only
// interception is at SEND time: when a draft carries image attachments, each
// image is uploaded to the host route (POST /subagent-vision/paste -> private
// temp file path), the draft is released, and the paths are appended to the
// prompt text before the real send — so the request carries text only and
// never trips the host's text-only image admission. The main agent then
// delegates each path to `subagent_vision`.
//
// The picker registers a Settings section (`settings.section` slot, same as
// 0.1.x) whose dropdown reads the live vision-model list from
// GET /subagent-vision/settings and persists the choice via POST.
window.__ModuleLoader__.load({
  id: 'dsh-subagent-vision',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var routeAvailable = true

    function uploadOne(file) {
      return file.arrayBuffer().then((buffer) =>
        fetch('/subagent-vision/paste', { method: 'POST', body: buffer }).then((res) => {
          if (!res.ok) {
            return res.json().catch(() => ({}))
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

    function wrapSendSession(conversation) {
      var original = conversation.sendSession.bind(conversation)
      conversation.sendSession = async function (session, text, attachmentIds, mode, signal, accept) {
        if (attachmentIds.length === 0 || !routeAvailable) {
          return original(session, text, attachmentIds, mode, signal, accept)
        }
        if (typeof conversation.resolveDraftAttachments !== 'function') {
          return original(session, text, attachmentIds, mode, signal, accept)
        }
        var attachments = conversation.resolveDraftAttachments(attachmentIds)
        if (attachments.length !== attachmentIds.length) {
          return original(session, text, attachmentIds, mode, signal, accept)
        }
        if (attachments.some((a) => a.kind !== 'image')) {
          return original(session, text, attachmentIds, mode, signal, accept)
        }
        var paths = []
        for (var i = 0; i < attachments.length; i++) {
          var result = await uploadOne(attachments[i].file)
          if (result && typeof result.path === 'string') paths.push(result.path)
        }
        if (typeof conversation.releaseDraftAttachments === 'function') {
          try { conversation.releaseDraftAttachments(attachments) } catch (_) {}
        }
        var finalText = text === '' ? paths.join(' ') : `${text} ${paths.join(' ')}`
        return original(session, finalText, [], mode, signal, accept)
      }
    }

    function VisionRouteSection() {
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect

      var state = useState({ loading: true, options: [], current: '', error: null })
      var options = state[0].options
      var current = state[0].current
      var loading = state[0].loading
      var error = state[0].error
      var setState = state[1]

      useEffect(function () {
        fetch('/subagent-vision/settings')
          .then(function (res) { return res.json() })
          .then(function (body) {
            setState({ loading: false, options: body.options || [], current: body.current || '', error: null })
          })
          .catch(function (err) {
            setState({ loading: false, options: [], current: '', error: String(err && err.message || err) })
          })
      }, [])

      function onChange(ev) {
        var value = ev.target.value
        setState({ loading: false, options: options, current: value, error: null })
        fetch('/subagent-vision/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visionRoute: value }),
        })
          .then(function (res) {
            if (!res.ok) {
              return res.json().catch(function () { return {} }).then(function (body) {
                throw new Error(body.error || `save failed (${res.status})`)
              })
            }
            return res.json()
          })
          .then(function (body) {
            setState({ loading: false, options: options, current: body.current || '', error: null })
          })
          .catch(function (err) {
            setState({ loading: false, options: options, current: current, error: String(err && err.message || err) })
          })
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 0' } },
        h('div', null, 'Vision model for subagent_vision'),
        loading
          ? h('div', null, 'Loading…')
          : h('select', { value: current, onChange: onChange, style: { maxWidth: '100%' } },
              h('option', { value: '' }, '— none —'),
              options.map(function (o) {
                return h('option', { key: o.value, value: o.value }, o.label)
              }),
            ),
        error ? h('div', { style: { color: 'var(--dsw-color-danger, #c0392b)' } }, String(error)) : null,
      )
    }

    function apply(ctx) {
      var conversation = ctx.conversation || (typeof ctx.get === 'function' ? ctx.get('conversation') : undefined)
      if (conversation && typeof conversation.sendSession === 'function') {
        wrapSendSession(conversation)
      }
      var slots = ctx.slots
      if (slots && typeof slots.inject === 'function') {
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'subagent-vision',
          order: 100,
          label: () => 'Vision model',
          inject: () => ({}),
        }, VisionRouteSection))
      }
    }

    exports.apply = apply
    exports.inject = ['conversation', 'slots']
    return module.exports
  },
})
