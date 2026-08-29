import { createRequire } from "node:module";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { Language, Parser } from "web-tree-sitter";

/** 符号标签（Aider Repo Map 的 tree-sitter 层）：
 *  - def：定义（函数/类/方法/接口…），来自各语言 AST 节点类型 + name 字段；
 *  - ref：引用（identifier 系节点），用于构建「引用文件 → 定义文件」图。
 *  不用 .scm query 文件——按语言写节点类型映射更少魔法，且 web-tree-sitter
 *  运行时编译 query 的行为跨版本不稳。 */

export type Tag = { file: string; line: number; name: string; kind: "def" | "ref" };

const require_ = createRequire(import.meta.url);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", "coverage",
  ".zmzai", ".venv", "venv", "__pycache__", "vendor", ".cache", ".turbo",
]);

const CODE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go"]);

const MAX_FILE_BYTES = 512 * 1024;

type LangSpec = { wasm: string; defs: string[]; refs: string[] };

const LANG_BY_EXT: Record<string, LangSpec> = {
  ".ts": { wasm: "tree-sitter-typescript.wasm", defs: ["function_declaration", "class_declaration", "method_definition", "interface_declaration", "enum_declaration", "type_alias_declaration", "abstract_class_declaration", "generator_function_declaration"], refs: ["identifier", "property_identifier", "type_identifier"] },
  ".mts": { wasm: "tree-sitter-typescript.wasm", defs: ["function_declaration", "class_declaration", "method_definition", "interface_declaration", "enum_declaration", "type_alias_declaration"], refs: ["identifier", "property_identifier", "type_identifier"] },
  ".cts": { wasm: "tree-sitter-typescript.wasm", defs: ["function_declaration", "class_declaration", "method_definition", "interface_declaration", "enum_declaration", "type_alias_declaration"], refs: ["identifier", "property_identifier", "type_identifier"] },
  ".tsx": { wasm: "tree-sitter-tsx.wasm", defs: ["function_declaration", "class_declaration", "method_definition", "interface_declaration", "enum_declaration", "type_alias_declaration"], refs: ["identifier", "property_identifier", "type_identifier"] },
  ".js": { wasm: "tree-sitter-javascript.wasm", defs: ["function_declaration", "class_declaration", "method_definition", "generator_function_declaration"], refs: ["identifier", "property_identifier", "shorthand_property_identifier"] },
  ".jsx": { wasm: "tree-sitter-javascript.wasm", defs: ["function_declaration", "class_declaration", "method_definition"], refs: ["identifier", "property_identifier", "shorthand_property_identifier"] },
  ".mjs": { wasm: "tree-sitter-javascript.wasm", defs: ["function_declaration", "class_declaration", "method_definition"], refs: ["identifier", "property_identifier", "shorthand_property_identifier"] },
  ".cjs": { wasm: "tree-sitter-javascript.wasm", defs: ["function_declaration", "class_declaration", "method_definition"], refs: ["identifier", "property_identifier", "shorthand_property_identifier"] },
  ".py": { wasm: "tree-sitter-python.wasm", defs: ["function_definition", "class_definition"], refs: ["identifier"] },
  ".go": { wasm: "tree-sitter-go.wasm", defs: ["function_declaration", "method_declaration", "type_spec"], refs: ["identifier", "field_identifier", "type_identifier", "package_identifier"] },
};

let parserInit: Promise<void> | null = null;
const languageCache = new Map<string, Promise<Language>>();
const parserByLang = new Map<string, Parser>();

function pkgDir(moduleName: string): string {
  // 包 exports 各有缺口（web-tree-sitter 不暴露 wasm/package.json 子路径，
  // tree-sitter-wasms 的 main 坏了），双策略：先 package.json 锚点，fallback 主入口
  try {
    return path.dirname(require_.resolve(`${moduleName}/package.json`));
  } catch {
    return path.dirname(require_.resolve(moduleName));
  }
}

function ensureParserInit(): Promise<void> {
  parserInit ??= Parser.init({
    locateFile(scriptName: string) {
      // web-tree-sitter 的运行时 wasm（tree-sitter.wasm）随包分发
      return path.join(pkgDir("web-tree-sitter"), scriptName);
    },
  });
  return parserInit;
}

async function languageFor(wasmFile: string): Promise<Language> {
  const cached = languageCache.get(wasmFile);
  if (cached) return cached;
  const pending = (async () => {
    await ensureParserInit();
    const wasmPath = path.join(pkgDir("tree-sitter-wasms"), "out", wasmFile);
    return Language.load(wasmPath);
  })();
  languageCache.set(wasmFile, pending);
  return pending;
}

function collectTags(file: string, content: string, spec: LangSpec): Tag[] {
  const tags: Tag[] = [];
  let parser = parserByLang.get(spec.wasm);
  if (!parser) {
    parser = new Parser();
    parserByLang.set(spec.wasm, parser);
  }
  const tree = parser.parse(content);
  if (!tree) return tags;
  const root = tree.rootNode;
  for (const defType of spec.defs) {
    for (const node of root.descendantsOfType(defType)) {
      if (!node) continue;
      const nameNode = node.childForFieldName("name");
      if (!nameNode) continue;
      tags.push({ file, line: node.startPosition.row + 1, name: nameNode.text, kind: "def" });
    }
  }
  for (const refType of spec.refs) {
    for (const node of root.descendantsOfType(refType)) {
      if (!node) continue;
      const name = node.text;
      if (name && name.length <= 64) tags.push({ file, line: node.startPosition.row + 1, name, kind: "ref" });
    }
  }
  tree.delete();
  return tags;
}

/** 解析单文件为标签（缓存未命中路径）。语言不支持或解析失败返回空。 */
export async function extractTags(relFile: string, absFile: string): Promise<Tag[]> {
  const ext = path.extname(relFile).toLowerCase();
  const spec = LANG_BY_EXT[ext];
  if (!spec) return [];
  const { readFile } = await import("node:fs/promises");
  let content: string;
  try {
    const info = await stat(absFile);
    if (info.size > MAX_FILE_BYTES) return [];
    content = await readFile(absFile, "utf8");
  } catch {
    return [];
  }
  if (content.includes("\u0000")) return []; // 二进制嗅探
  try {
    const lang = await languageFor(spec.wasm);
    let parser = parserByLang.get(spec.wasm);
    if (!parser) {
      parser = new Parser();
      parserByLang.set(spec.wasm, parser);
    }
    parser.setLanguage(lang);
    return collectTags(relFile, content, spec);
  } catch (error) {
    if (process.env.ZMZAI_REPOMAP_DEBUG) console.error("[repomap] extract failed:", error);
    return [];
  }
}

/** 递归列出工作区内的代码文件（跳重目录，cap 防爆）。 */
export async function listCodeFiles(root: string, opts: { maxFiles?: number; filter?: (rel: string) => boolean } = {}): Promise<{ files: string[]; skipped: number }> {
  const maxFiles = opts.maxFiles ?? 5000;
  const files: string[] = [];
  let skipped = 0;
  const walk = async (dir: string): Promise<void> => {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (!CODE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
        if (opts.filter && !opts.filter(rel)) continue;
        files.push(rel);
      }
    }
  };
  await walk(root);
  if (files.length >= maxFiles) skipped = files.length; // 达到 cap：未知总数，标记触顶
  return { files: files.sort(), skipped };
}
