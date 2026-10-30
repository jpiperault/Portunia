// Vérifie que chaque appel t(…) / tr(…) de src/ vise bien la fonction de traduction de src/i18n.ts,
// et pas une variable locale du même nom (que TypeScript laisse passer quand elle est de type any).
const ts = require('typescript');
const path = require('path');

const config = ts.getParsedCommandLine
  ? null
  : null;
const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, path.dirname(configPath));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const i18n = path.resolve('src/i18n.ts').replace(/\\/g, '/');
let bad = 0;
for (const sf of program.getSourceFiles()) {
  if (!sf.fileName.includes('/src/') || sf.fileName.endsWith('i18n.ts')) continue;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^(t|tr)$/.test(node.expression.text)
      && node.arguments.length === 2 && node.arguments.every((a) => ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isTemplateExpression(a))) {
      let sym = checker.getSymbolAtLocation(node.expression);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      const decl = sym && sym.declarations && sym.declarations[0];
      const file = decl && decl.getSourceFile().fileName.replace(/\\/g, '/');
      if (file !== i18n) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        console.log(`${path.relative(process.cwd(), sf.fileName)}:${line + 1}: ${node.expression.text}(…) vise une variable locale`);
        bad++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
console.log(bad ? `${bad} problème(s)` : 'ok');
process.exit(bad ? 1 : 0);
