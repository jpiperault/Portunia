# médiane de 3 essais : bash med.sh <libellé> <on|off> <gros|petits>
for i in 1 2 3; do node run.mjs "$1" "$2" "$3" 2>/dev/null; done | node -e '
const rows = require("fs").readFileSync(0, "utf8").trim().split("\n").map(JSON.parse);
const med = (k) => rows.map((r) => r[k]).sort((a, b) => a - b)[1];
const r = rows[0];
console.log(`${r.label.padEnd(10)} mise en évidence ${r.highlight.padEnd(3)} morceaux ${r.morceaux.padEnd(6)} rendu ${r.renderer.padEnd(12)} ${med("moParS")} Mo/s  ${med("fps")} img/s  pire image ${med("pireImageMs")} ms`);'
