// dsh-subagent-vision browser half (0.2.x port): send-time image-to-path
// conversion.
//
// Intake stays native (thumbnail rail, caret, remove/undo). The only
// interception is at SEND time: when a draft carries image attachments, each
// image is uploaded to the host route (POST /subagent-vision/paste -> private
// temp file path), the draft is released, and the paths are appended to the
// prompt text before the real send — so the request carries text only and
// never trips the host's text-only image admission. The main agent then
// delegates each path to `subagent_vision`.
//
// 0.2.x rewrote the client send stack. The old plugin wrapped
// `conversation.sendSession(session, text, imageIds, mode)` and read drafts
// with `conversation.draftImages(imageIds)`. The 0.2.x conversation service
// still exposes `sendSession(session, text, attachmentIds, mode, signal,
// accept)` and `resolveDraftAttachments(attachmentIds)` (each entry carries the
// raw `file`), so the same interception ports directly.
window.__ModuleLoader__.load({
  id: 'dsh-subagent-vision',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

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

    function wrapSendSession(ctx, conversation) {
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
        // Any non-image draft leaves the whole send native.
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

    function apply(ctx) {
      var conversation = ctx.conversation || (typeof ctx.get === 'function' ? ctx.get('conversation') : undefined)
      if (conversation && typeof conversation.sendSession === 'function') {
        wrapSendSession(ctx, conversation)
      }
    }

    exports.apply = apply
    exports.inject = ['conversation']
    return module.exports
  },
})
