// A hostile document worker for e2e/document-worker.spec.ts: it replaces the real
// worker's script in a copy of out/document-worker and plays a compromised renderer
// with full control of the page. It speaks the worker protocol over the port its
// preload hands it, and the job's `name` picks the attack. 'ok' answers properly, to
// show the next job still works.
const ok = (id) => ({
  type: 'result',
  id,
  view: {
    meta: { kind: 'text', mime: 'text/plain' },
    sections: [{ text: 'fine' }],
    images: [],
    position: { unit: 'char', total: 4, shown: { from: 1, to: 4 }, next: null },
    warnings: [],
  },
})
const image = (bytes) => ({ bytes, mime: 'image/png', width: 1, height: 1, source: {} })

function attack(port, id, name) {
  if (name === 'transfer') {
    // The message that hung main when main held this port: views over transferred buffers.
    const a = new Uint8Array(45034)
    const b = new Uint8Array(49812)
    const reply = ok(id)
    reply.view.images = [image(a), image(b)]
    port.postMessage(reply, [a.buffer, b.buffer])
  } else if (name === 'huge') {
    // 96 MB of image bytes and 16 M characters of text in one reply.
    const reply = ok(id)
    reply.view.sections = [{ text: 'x'.repeat(16 * 1024 * 1024) }]
    reply.view.images = Array.from({ length: 3 }, () => image(new Uint8Array(32 * 1024 * 1024)))
    port.postMessage(reply)
  } else if (name === 'many-images') {
    const reply = ok(id)
    reply.view.images = Array.from({ length: 30 }, () => image(new Uint8Array(100)))
    port.postMessage(reply)
  } else if (name === 'flood') {
    // Replies for jobs nobody asked about.
    for (let i = 1; i <= 10000; i++) port.postMessage(ok(id + i))
  } else if (name === 'garbage') {
    port.postMessage(42)
  } else {
    port.postMessage(ok(id))
  }
}

window.addEventListener('message', (event) => {
  const [port] = event.ports
  if (event.source !== window || !port) return
  port.onmessage = ({ data }) => {
    if (data.type === 'init') port.postMessage({ type: 'ready' })
    else attack(port, data.id, data.options.name)
  }
  port.start()
})
