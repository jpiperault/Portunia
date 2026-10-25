// Bout en bout, source réseau : connexion rapide « telnet 127.0.0.1:2323 », 20 Mo reçus.
const label = process.argv[2] ?? 'mesure';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = (await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9223}/json`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const evaluate = async (expression) => { const id = ++n; const r = await new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }); if (r.result?.exceptionDetails) console.error('ERREUR', JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return r.result?.result?.value; };
const result = await evaluate(`(async () => {
  const before = (window.__terms ?? []).length;
  const search = document.getElementById('search');
  search.value = 'telnet 127.0.0.1:2323';
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  while ((window.__terms ?? []).length <= before) await new Promise((r) => setTimeout(r, 20));
  const term = window.__terms[window.__terms.length - 1];
  const write = term.write.bind(term); let calls = 0, bytes = 0, firstAt = 0, lastAt = 0;
  term.write = (d, cb) => { calls++; bytes += d.length ?? d.byteLength ?? 0; const now = performance.now(); if (!firstAt) firstAt = now; lastAt = now; return write(d, cb); };
  let frames = 0, running = true, worst = 0, last = performance.now();
  const tick = (t) => { frames++; worst = Math.max(worst, t - last); last = t; if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const hasEnd = () => { const b = term.buffer.active; for (let y = b.baseY + b.cursorY; y >= Math.max(0, b.baseY + b.cursorY - 6); y--) if (b.getLine(y)?.translateToString(true).startsWith('FIN-BENCH')) return true; return false; };
  const t0 = performance.now();
  while (!hasEnd()) { await new Promise((r) => setTimeout(r, 20)); if (performance.now() - t0 > 300000) return { timeout: true }; }
  await new Promise((r) => term.write('', r));
  running = false; term.write = write;
  const ms = lastAt - firstAt;
  return { messages: calls, octetsMoyens: Math.round(bytes / calls), receptionMs: Math.round(ms), moParS: +(20 / (ms / 1000)).toFixed(1), fps: Math.round(frames / ((performance.now() - t0) / 1000)), pireImageMs: Math.round(worst) };
})()`);
console.log(JSON.stringify({ label, ...result }));
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', ctrlKey: true, shiftKey: true, bubbles: true })); 1`);
ws.close(); process.exit(0);
