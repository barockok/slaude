/**
 * A type-aware scan for a Promise used where its value was meant: in a
 * condition, a ternary, `!`, `&&`, `||`, a comparison, a spread, a member access,
 * a sync array callback and so on. Making the access helpers async (slice C)
 * turned a missing `await` into a silent always-true, which `tsc` does not flag
 * in most positions. Reads `src` (without src/web), deterministic.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require("typescript");
import { dirname, join } from "node:path";

export function scanMisusedPromises(root: string): string[] {
  const cfgPath = join(root, "tsconfig.json");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dirname(cfgPath));
  const fileNames = parsed.fileNames.filter((f: string) => f.startsWith(join(root, "src") + "/") && !f.startsWith(join(root, "src/web") + "/"));
  const program = ts.createProgram(fileNames, parsed.options);
  const ck = program.getTypeChecker();
  const isP = (t: any): boolean => {
    if (!t) return false;
    if (t.isUnion && t.isUnion()) return t.types.some(isP);
    const s = t.getSymbol && t.getSymbol();
    if (s && s.getName() === "Promise") return true;
    return !!(t.getProperty && t.getProperty("then"));
  };
  const out: string[] = [];

  const rep = (n: any, why: string) => {
    const sf = n.getSourceFile();
    out.push(`${sf.fileName.replace(root + "/", "")} [${why}] ${n.getText().replace(/\s+/g, " ").slice(0, 140)}`);
  };
  const K = ts.SyntaxKind;
  const boolOps = new Set([K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken, K.LessThanToken, K.GreaterThanToken, K.PlusToken, K.InKeyword]);
  const arrM = new Set(["filter", "some", "every", "find", "findIndex", "findLast", "sort", "forEach", "flatMap", "reduce"]);
  function visit(n: any) {
    if (ts.isExpression(n) && !ts.isAwaitExpression(n)) {
      let t: any; try { t = ck.getTypeAtLocation(n); } catch {}
      if (isP(t) && (ts.isCallExpression(n) || ts.isIdentifier(n) || ts.isPropertyAccessExpression(n))) {
        let p = n.parent; let c = n;
        while (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p)) { c = p; p = p.parent; }
        if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === c) rep(n, "cond");
        else if (ts.isConditionalExpression(p) && p.condition === c) rep(n, "ternary");
        else if (ts.isPrefixUnaryExpression(p) && p.operator === K.ExclamationToken) rep(n, "not");
        else if (ts.isBinaryExpression(p) && boolOps.has(p.operatorToken.kind) && !(p.operatorToken.kind===K.QuestionQuestionToken && p.right===c) && !((p.operatorToken.kind===K.AmpersandAmpersandToken||p.operatorToken.kind===K.BarBarToken) && p.right===c && false)) rep(n, "binop");
        else if (ts.isTemplateSpan(p)) rep(n, "template");
        else if (ts.isExpressionStatement(p) && ts.isCallExpression(n)) rep(n, "floating");
        else if (ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) rep(n, "spread");
        else if (ts.isPropertyAccessExpression(p) && p.expression === c && !["then","catch","finally"].includes(p.name.text)) rep(n, "member");
        else if (ts.isElementAccessExpression(p) && p.expression === c) rep(n, "index");
        else if (ts.isVariableDeclaration(p) && p.initializer === c && (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name))) rep(n, "destructure");
        else if (ts.isForOfStatement(p) && p.expression === c && !p.awaitModifier) rep(n, "forof");
      }
    }
    // promise-returning callbacks to sync array methods
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && arrM.has(n.expression.name.text)) {
      for (const a of n.arguments) {
        let t: any; try { t = ck.getTypeAtLocation(a); } catch {}
        const sigs = t ? t.getCallSignatures() : [];
        if (sigs.some((s: any) => isP(s.getReturnType()))) rep(n, "arraycb:" + n.expression.name.text);
      }
    }
    // promise-returning function passed where param expects non-promise return (boolean etc.)
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const sig = ck.getResolvedSignature(n);
      (n.arguments || []).forEach((a: any, i: number) => {
        let at: any; try { at = ck.getTypeAtLocation(a); } catch {}
        const asigs = at ? at.getCallSignatures() : [];
        if (!asigs.length || !asigs.some((s: any) => isP(s.getReturnType()))) return;
        const ps = sig && sig.getParameters()[i];
        if (!ps) return;
        const pt = ck.getTypeOfSymbolAtLocation(ps, n);
        const psigs = pt.getCallSignatures();
        if (psigs.length && !psigs.some((s: any) => { const r = s.getReturnType(); return isP(r) || (r.flags & (ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)); })) rep(a, "cb-expects-sync");
      });
    }
    ts.forEachChild(n, visit);
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue;
    if (!fileNames.includes(sf.fileName)) continue;
    visit(sf);
  }
  return out;
}
