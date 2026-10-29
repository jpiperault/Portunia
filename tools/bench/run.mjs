// Mesure du terminal dans Edge headless (pas de ralentissement d'onglet masqué).
// node run.mjs <libellé> [highlight on|off]
import { spawn } from 'node:child_process';
const [label = 'mesure', hl = 'on', size = 'gros'] = process.argv.slice(2);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9333;
const dir = `${process.env.TEMP}/portunia-bench-profile`;
const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--window-size=1400,860', '--enable-gpu', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
const logs = [];
await new Promise((r) => (ws.onopen = r));
let n = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown' || (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')) logs.push(JSON.stringify(d.params).slice(0, 400)); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.error("ERREUR", JSON.stringify(r.result.exceptionDetails).slice(0, 600)); if (r.error) console.error("CDP", JSON.stringify(r.error)); return r.result?.result?.value; };
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `try { const s = JSON.parse(localStorage.getItem("termoria.settings") || "{}"); delete s.highlight; if ("${hl}" === "off") s.highlight = { enabled: false, rules: [] }; localStorage.setItem("termoria.settings", JSON.stringify(s)); } catch {}` });
await cdp("Page.navigate", { url: `http://localhost:${process.env.BENCH_PORT ?? 1420}/screenshot.html` });
await sleep(1500);
await evaluate(`(() => { const s = JSON.parse(localStorage.getItem('termoria.settings') || '{}'); delete s.highlight; if ('${hl}' === 'off') s.highlight = { enabled: false, rules: [] }; localStorage.setItem('termoria.settings', JSON.stringify(s)); return 1; })()`);
await cdp('Page.reload');
for (let i = 0; i < 60; i++) { await sleep(250); if (await evaluate(`window.__mock?.channels?.length > 0 && !!document.querySelector('.xterm-rows')`)) break; }
await sleep(800);
console.error("réglage", await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem("termoria.settings") || "{}").highlight ?? "défaut")`), "décorations au départ", await evaluate(`document.querySelectorAll(".xterm-decoration").length`));
const renderer = await evaluate(`document.querySelector('.xterm canvas') ? 'canvas/webgl' : 'dom'`);
const result = await evaluate((await import("node:fs")).readFileSync(new URL("./page.js", import.meta.url), "utf8").replace('__SIZE__', size));
console.log(JSON.stringify({ label, highlight: hl, morceaux: size, renderer, ...result }));
console.error("après une ligne de plus :", await evaluate((await import("node:fs")).readFileSync(new URL("./diag.js", import.meta.url), "utf8")));
console.error("erreurs de la page :", logs.slice(0, 3));
ws.send(JSON.stringify({ id: 999999, method: "Browser.close" })); await sleep(500); ws.close(); proc.kill();
process.exit(0);
