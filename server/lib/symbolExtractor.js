/**
 * Lightweight, regex-based symbol extraction. This is intentionally not a
 * full parser/AST — it is a practical heuristic extractor for JS/TS/Python
 * that is good enough to identify functions, classes, routes, imports,
 * exports and type/interface declarations for context discovery and for
 * telling the AI layer which functional units a diff touched.
 */

const JS_TS_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const PY_EXT = new Set([".py"]);

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "all"];

export function extLang(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (JS_TS_EXT.has(ext)) return "js";
  if (PY_EXT.has(ext)) return "py";
  if (ext === ".json") return "json";
  if (ext === ".md" || ext === ".mdx") return "markdown";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  return "other";
}

export function extractSymbols(filePath, content) {
  const lang = extLang(filePath);
  if (!content) return emptySymbols(lang);
  if (lang === "js") return extractJs(content);
  if (lang === "py") return extractPy(content);
  return emptySymbols(lang);
}

function emptySymbols(lang) {
  return { lang, imports: [], exports: [], functions: [], classes: [], routes: [], types: [] };
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

function extractJs(content) {
  const result = emptySymbols("js");

  // imports: import ... from 'x'; and require('x')
  const importRe = /import\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = importRe.exec(content))) {
    result.imports.push({ source: m[1] || m[2], line: lineOf(content, m.index) });
  }

  // exports: export function/class/const, module.exports
  const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g;
  while ((m = exportRe.exec(content))) {
    result.exports.push({ name: m[2], kind: m[1], line: lineOf(content, m.index) });
  }
  const moduleExportsRe = /module\.exports(?:\.([A-Za-z0-9_$]+))?\s*=/g;
  while ((m = moduleExportsRe.exec(content))) {
    result.exports.push({ name: m[1] || "default", kind: "module.exports", line: lineOf(content, m.index) });
  }

  // functions: function foo(), const foo = (...) =>, async function foo
  const fnRe = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  while ((m = fnRe.exec(content))) {
    result.functions.push({ name: m[1], line: lineOf(content, m.index) });
  }
  const arrowRe = /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(?[^=]*?\)?\s*=>/g;
  while ((m = arrowRe.exec(content))) {
    result.functions.push({ name: m[1], line: lineOf(content, m.index) });
  }

  // classes
  const classRe = /(?:export\s+)?class\s+([A-Za-z0-9_$]+)/g;
  while ((m = classRe.exec(content))) {
    result.classes.push({ name: m[1], line: lineOf(content, m.index) });
  }

  // Express-style routes: router.get('/path', ...), app.post("/path", ...)
  const routeRe = new RegExp(
    `\\b(?:router|app)\\.(${HTTP_METHODS.join("|")})\\s*\\(\\s*["']([^"']+)["']`,
    "gi"
  );
  while ((m = routeRe.exec(content))) {
    result.routes.push({ method: m[1].toUpperCase(), path: m[2], line: lineOf(content, m.index) });
  }

  // TS types/interfaces
  const typeRe = /(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_$]+)/g;
  while ((m = typeRe.exec(content))) {
    result.types.push({ name: m[1], line: lineOf(content, m.index) });
  }

  // object/property field names, used for lightweight "field touched" search
  result.fields = extractObjectFieldNames(content);

  return result;
}

function extractObjectFieldNames(content) {
  const fields = new Set();
  const fieldRe = /(?:^|[\s{,])([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g;
  let m;
  while ((m = fieldRe.exec(content))) {
    fields.add(m[1]);
  }
  const dotRe = /\.([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  while ((m = dotRe.exec(content))) {
    fields.add(m[1]);
  }
  return Array.from(fields);
}

function extractPy(content) {
  const result = emptySymbols("py");
  let m;

  const importRe = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
  while ((m = importRe.exec(content))) {
    result.imports.push({ source: m[1] || m[2], line: lineOf(content, m.index) });
  }

  const fnRe = /^def\s+([A-Za-z0-9_]+)\s*\(/gm;
  while ((m = fnRe.exec(content))) {
    result.functions.push({ name: m[1], line: lineOf(content, m.index) });
  }

  const classRe = /^class\s+([A-Za-z0-9_]+)/gm;
  while ((m = classRe.exec(content))) {
    result.classes.push({ name: m[1], line: lineOf(content, m.index) });
  }

  const routeRe = /@(?:app|router|bp)\.route\(\s*["']([^"']+)["']|@(?:app|router)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/gi;
  while ((m = routeRe.exec(content))) {
    if (m[1]) result.routes.push({ method: "ROUTE", path: m[1], line: lineOf(content, m.index) });
    else result.routes.push({ method: m[2].toUpperCase(), path: m[3], line: lineOf(content, m.index) });
  }

  result.fields = extractObjectFieldNames(content);
  return result;
}

/**
 * Given hunks (from diffParser) and symbols extracted from the *new*
 * file version, find which functions/classes/routes each hunk falls
 * inside (approx: nearest preceding declaration).
 */
export function symbolsTouchedByHunks(symbols, hunks) {
  const declarations = [
    ...symbols.functions.map((s) => ({ ...s, kind: "function" })),
    ...symbols.classes.map((s) => ({ ...s, kind: "class" })),
    ...symbols.routes.map((s) => ({ ...s, kind: "route", name: `${s.method} ${s.path}` })),
  ].sort((a, b) => a.line - b.line);

  const touched = new Set();
  for (const hunk of hunks) {
    const changedLines = hunk.lines.filter((l) => l.type !== "del").map((l) => l.newLineNo);
    const start = Math.min(hunk.newStart, ...changedLines.filter(Boolean));
    const end = hunk.newStart + hunk.newLines;
    for (const decl of declarations) {
      if (decl.line >= start - 1 && decl.line <= end) {
        touched.add(JSON.stringify(decl));
      }
    }
    // also: nearest preceding declaration before the hunk start
    const preceding = declarations.filter((d) => d.line <= start).pop();
    if (preceding) touched.add(JSON.stringify(preceding));
  }
  return Array.from(touched).map((s) => JSON.parse(s));
}
