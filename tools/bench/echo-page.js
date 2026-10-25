(async () => {
  const term = window.__terms[window.__terms.length - 1];
  const text = () => { const b = term.buffer.active; return b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? ''; };
  const delays = [];
  for (const ch of 'echo termoria-test') {
    const t0 = performance.now(); term.input(ch);
    while (!text().endsWith(ch)) { await new Promise((r) => setTimeout(r, 1)); if (performance.now() - t0 > 2000) break; }
    delays.push(performance.now() - t0);
  }
  term.input('\r');
  await new Promise((r) => setTimeout(r, 800));
  const b = term.buffer.active; const lines = [];
  for (let y = 0; y <= b.baseY + b.cursorY; y++) lines.push((b.getLine(y)?.translateToString(true) ?? '').trim());
  delays.sort((a, c) => a - c);
  return { echoMedianMs: Math.round(delays[Math.floor(delays.length / 2)]), echoMaxMs: Math.round(delays[delays.length - 1]), resultatAffiche: lines.includes('termoria-test') };
})()
