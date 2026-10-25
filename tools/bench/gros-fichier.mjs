// Fichier de 20 Mo de journaux (avec « FIN-BENCH » à la fin) pour les mesures de bout en bout.
import { writeFileSync } from 'node:fs';
let line = '';
for (let i = 0; i < 40; i++) line += `2026-10-25 10:02:${String(i % 60).padStart(2, '0')} [error] upstream 10.0.1.${i}:8080 failed (111: Connection refused) while connecting, warning retry ${i}\r\n`;
writeFileSync(new URL('./gros.log', import.meta.url), line.repeat(Math.ceil(20e6 / line.length)) + 'FIN-BENCH\r\n');
