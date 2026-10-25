(async () => {
  const m = window.__mock;
  m.send(m.channels[0], m.bytes('nouvelle error 10.0.0.1\r\n'));
  await new Promise((r) => setTimeout(r, 300));
  return document.querySelectorAll('.xterm-decoration').length;
})()
