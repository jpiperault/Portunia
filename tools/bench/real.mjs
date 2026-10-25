// Bout en bout dans la vraie application (WebView2, port 9223) : shell local, `type` d'un gros fichier.
import { fileURLToPath } from 'node:url';
const label = process.argv[2] ?? 'mesure';
const file = fileURLToPath(new URL('./gros.log', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = (await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9223}/json`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const evaluate = async (expression) => { const id = ++n; const r = await new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }); if (r.result?.exceptionDetails) console.error('ERREUR', JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return r.result?.result?.value; };
// Nouveau shell local (Ctrl+Maj+T), puis attente de l'invite.
const before = await evaluate('(window.__terms ?? []).length');
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true })); 1`);
for (let i = 0; i < 100; i++) { await sleep(100); if ((await evaluate('(window.__terms ?? []).length')) > before) break; }
await sleep(2500);
const result = await evaluate(`(async () => {
  const term = window.__terms[window.__terms.length - 1];
  let frames = 0, running = true, worst = 0, last = performance.now();
  const tick = (t) => { frames++; worst = Math.max(worst, t - last); last = t; if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const write = term.write.bind(term); let calls = 0, bytes = 0, firstAt = 0, lastAt = 0;
  term.write = (d, cb) => { calls++; const n = d.length ?? d.byteLength ?? 0; bytes += n; const now = performance.now(); if (!firstAt) firstAt = now; lastAt = now; return write(d, cb); };
  const t0 = performance.now();
  term.input(${JSON.stringify(`cmd /c type "${file}"\r`)});
  const hasEnd = () => { const b = term.buffer.active; for (let y = b.baseY + b.cursorY; y >= Math.max(0, b.baseY + b.cursorY - 5); y--) if (b.getLine(y)?.translateToString(true).startsWith('FIN-BENCH')) return true; return false; };
  while (!hasEnd()) { await new Promise((r) => setTimeout(r, 20)); if (performance.now() - t0 > 300000) return { timeout: true }; }
  const ms = performance.now() - t0; running = false;
  term.write = write;
  return { messages: calls, octetsMoyens: Math.round(bytes / calls), arriveeMs: Math.round(lastAt - firstAt), premierMs: Math.round(firstAt - t0), ms: Math.round(ms), moParS: +(20 / (ms / 1000)).toFixed(1), fps: Math.round(frames / (ms / 1000)), pireImageMs: Math.round(worst) };
})()`);
console.log(JSON.stringify({ label, ...result }));
// Fermeture de l'onglet de test (Ctrl+Maj+W).
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', ctrlKey: true, shiftKey: true, bubbles: true })); 1`);
ws.close(); process.exit(0);
