// Démarrage de la version de production : temps jusqu'à l'arbre des sessions et au terminal affiché.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const label = process.argv[2] ?? 'mesure';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9335;
// Simulation de Tauri reprise de la page de démonstration.
const page = readFileSync(new URL('../../screenshot.html', import.meta.url), 'utf8');
const mock = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'));
const runs = [];
for (let run = 0; run < 5; run++) {
  const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}/portunia-start-${run}`, '--window-size=1400,860', 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let t; for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); } catch {} }
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let n = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: mock + `
    window.__t = {};
    new MutationObserver(() => {
      const now = performance.now();
      if (!window.__t.tree && document.querySelector('#tree .tree-item')) window.__t.tree = now;
      if (!window.__t.term && document.querySelector('.xterm-rows, .xterm-screen canvas')) window.__t.term = now;
    }).observe(document, { subtree: true, childList: true });` });
  await cdp('Page.navigate', { url: 'http://localhost:4173/' });
  let res;
  for (let i = 0; i < 100; i++) { await sleep(100); res = (await cdp('Runtime.evaluate', { expression: 'JSON.stringify({ ...window.__t, heap: performance.memory?.usedJSHeapSize })', returnByValue: true })).result?.result?.value; if (res && JSON.parse(res).term) break; }
  runs.push(JSON.parse(res));
  ws.send(JSON.stringify({ id: 999999, method: "Browser.close" })); await sleep(500); ws.close(); proc.kill();
}
const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[2];
console.log(`${label.padEnd(10)} arbre des sessions ${Math.round(med('tree'))} ms · terminal ${Math.round(med('term'))} ms · mémoire JS ${Math.round(med('heap') / 1e6)} Mo`);
process.exit(0);
