// Frappe dans un shell local : temps entre la touche et son écho à l'écran.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = (await (await fetch('http://127.0.0.1:9223/json')).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const evaluate = async (expression) => { const id = ++n; const r = await new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }); if (r.result?.exceptionDetails) console.error('ERREUR', JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
const before = await evaluate('(window.__terms ?? []).length');
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true })); 1`);
for (let i = 0; i < 100; i++) { await sleep(100); if ((await evaluate('(window.__terms ?? []).length')) > before) break; }
await sleep(2500);
console.log(JSON.stringify(await evaluate((await import("node:fs")).readFileSync(new URL("./echo-page.js", import.meta.url), "utf8"))));
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', ctrlKey: true, shiftKey: true, bubbles: true })); 1`);
ws.close(); process.exit(0);
