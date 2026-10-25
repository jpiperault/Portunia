// Source réseau locale : envoie gros.log à chaque connexion (Telnet sur 127.0.0.1:2323).
import net from 'node:net';
import { readFileSync } from 'node:fs';
const data = readFileSync(new URL('./gros.log', import.meta.url));
net.createServer((socket) => {
  socket.on('error', () => {});
  setTimeout(() => socket.end(data), 1500);
}).listen(2323, '127.0.0.1', () => console.log('source prête'));
