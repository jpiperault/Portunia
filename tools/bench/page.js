(async () => {
  const m = window.__mock; const id = m.channels[0];
  let line = '';
  for (let i = 0; i < 40; i++) line += '2026-10-25 10:02:' + String(i % 60).padStart(2, '0') + ' [error] upstream 10.0.1.' + i + ':8080 failed (111: Connection refused) while connecting, warning retry ' + i + '\r\n';
  const small = '__SIZE__' === 'petits';
  const pieces = []; if (small) { for (let k = 0; k < line.length; k += 120) pieces.push(line.slice(k, k + 120)); } else pieces.push(line);
  const enc = m.bytes ? (t) => m.bytes(t) : (t) => ({ event: 'data', data: m.b64(t) });
  const encoded = pieces.map(enc); const chunks = 2000;
  const end = enc('\r\nFIN-BENCH\r\n');
  let frames = 0, running = true, worst = 0, last = performance.now();
  const tick = (t) => { frames++; worst = Math.max(worst, t - last); last = t; if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const t0 = performance.now();
  let sent = 0;
  for (let i = 0; i < chunks; i++) { for (const e of encoded) { m.send(id, e); if (++sent % 400 === 0) await new Promise((r) => setTimeout(r, 0)); } if (!small && i % 20 === 19) await new Promise((r) => setTimeout(r, 0)); }
  m.send(id, end);
  // Fin : xterm a tout analysé (rappel d'écriture), puis une image affichée.
  const term = window.__terms[0];
  await new Promise((r) => term.write('', r));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const lastLine = term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY - 1)?.translateToString(true);
  if (lastLine !== 'FIN-BENCH') return { erreur: 'fin non trouvée : ' + lastLine };
  const ms = performance.now() - t0; running = false;
  const mo = line.length * chunks / 1e6;
  return { mo: +mo.toFixed(1), ms: Math.round(ms), moParS: +(mo / (ms / 1000)).toFixed(1), fps: Math.round(frames / (ms / 1000)), pireImageMs: Math.round(worst), decorations: document.querySelectorAll('.xterm-decoration').length, memoireMo: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6) };
})()
