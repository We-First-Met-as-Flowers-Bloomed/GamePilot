import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/typescript";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const origin = "https://github.com/MaaAssistantArknights/MaaAssistantArknights";
const requireValue = (value, message) => {
  if (!value) throw Error(message);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function noLinkedAncestors(path) {
  const absolute = resolve(path),
    anchor = parse(absolute).root;
  let cursor = anchor;
  for (const part of relative(anchor, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    requireValue(
      !(await lstat(cursor)).isSymbolicLink(),
      `Linked engine path refused: ${cursor}`,
    );
  }
}
function safeEntry(name) {
  return (
    typeof name === "string" &&
    name &&
    !isAbsolute(name) &&
    !/^[a-z]:/i.test(name) &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name.split("/").every((p) => p && p !== "." && p !== "..")
  );
}
const relevant = (name) =>
  name.startsWith("resource/") ||
  /\.(?:dll|exe|node|so(?:\.\d+)*|dylib)$/i.test(name);
async function inventory(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    requireValue(
      !entry.isSymbolicLink(),
      `Linked bundle entry refused: ${name}`,
    );
    if (entry.isDirectory())
      result.push(...(await inventory(join(directory, entry.name), name)));
    else if (entry.isFile()) result.push(name);
    else throw Error(`Non-file bundle entry: ${name}`);
  }
  return result.sort();
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = (c >>> 8) ^ crcTable[(c ^ b) & 255];
  return (c ^ 0xffffffff) >>> 0;
}
/** Inspect ZIP bytes locally. No extraction, subprocess, native loading, network or device call. */
async function withArchive(archive, action) {
  const handle = await open(archive, "r");
  async function bytes(offset, size) {
    const data = Buffer.alloc(size);
    const read = await handle.read(data, 0, size, offset);
    requireValue(read.bytesRead === size, "Truncated official ZIP");
    return data;
  }
  try {
    const { size } = await handle.stat();
    requireValue(size >= 22, "Invalid ZIP archive");
    const tailStart = Math.max(0, size - 65557),
      tail = await bytes(tailStart, size - tailStart);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (
        tail.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + tail.readUInt16LE(i + 20) === tail.length
      ) {
        end = i;
        break;
      }
    requireValue(end >= 0, "ZIP central directory missing");
    requireValue(
      tail.readUInt16LE(end + 4) === 0 &&
        tail.readUInt16LE(end + 6) === 0 &&
        tail.readUInt16LE(end + 8) === tail.readUInt16LE(end + 10),
      "Multi-disk ZIP refused",
    );
    const count = tail.readUInt16LE(end + 10),
      length = tail.readUInt32LE(end + 12),
      start = tail.readUInt32LE(end + 16);
    requireValue(
      count !== 65535 && length !== 0xffffffff && start !== 0xffffffff,
      "ZIP64 archive requires a separately reviewed parser",
    );
    requireValue(
      length <= 64 * 1024 * 1024 && start + length === tailStart + end,
      "Invalid ZIP directory bounds",
    );
    const directory = await bytes(start, length),
      entries = new Map(),
      allNames = new Set();
    let position = 0;
    for (let index = 0; index < count; index++) {
      requireValue(
        position + 46 <= directory.length &&
          directory.readUInt32LE(position) === 0x02014b50,
        "Malformed ZIP directory entry",
      );
      const nameLength = directory.readUInt16LE(position + 28),
        extraLength = directory.readUInt16LE(position + 30),
        commentLength = directory.readUInt16LE(position + 32),
        entryEnd = position + 46 + nameLength + extraLength + commentLength;
      requireValue(entryEnd <= directory.length, "Truncated ZIP entry name");
      const name = directory.toString(
        "utf8",
        position + 46,
        position + 46 + nameLength,
      );
      requireValue(!allNames.has(name), `Duplicate ZIP entry: ${name}`);
      allNames.add(name);
      if (relevant(name) && !name.endsWith("/")) {
        requireValue(safeEntry(name), `Unsafe ZIP entry: ${name}`);
        const flags = directory.readUInt16LE(position + 8),
          method = directory.readUInt16LE(position + 10),
          compressedSize = directory.readUInt32LE(position + 20),
          size = directory.readUInt32LE(position + 24),
          offset = directory.readUInt32LE(position + 42),
          mode = directory.readUInt32LE(position + 38) >>> 16;
        requireValue(
          !(flags & 1) && [0, 8].includes(method) && (mode & 0xf000) !== 0xa000,
          `Encrypted, linked or unsupported ZIP entry: ${name}`,
        );
        requireValue(
          compressedSize <= 512 * 1024 * 1024 &&
            size <= 512 * 1024 * 1024 &&
            offset + 30 + compressedSize < start,
          `ZIP entry outside supported bounds: ${name}`,
        );
        entries.set(name, {
          name,
          method,
          compressedSize,
          size,
          offset,
          crc: directory.readUInt32LE(position + 16),
        });
      }
      position = entryEnd;
    }
    requireValue(
      position === directory.length,
      "ZIP directory entry count mismatch",
    );
    async function entryDigest(entry) {
      const header = await bytes(entry.offset, 30);
      requireValue(
        header.readUInt32LE(0) === 0x04034b50 &&
          header.readUInt16LE(8) === entry.method,
        "ZIP local header mismatch",
      );
      const nameLength = header.readUInt16LE(26),
        extraLength = header.readUInt16LE(28);
      requireValue(
        (await bytes(entry.offset + 30, nameLength)).toString("utf8") ===
          entry.name,
        "ZIP local filename mismatch",
      );
      const dataStart = entry.offset + 30 + nameLength + extraLength;
      requireValue(
        dataStart + entry.compressedSize <= start,
        "ZIP payload overlaps directory",
      );
      const compressed = await bytes(dataStart, entry.compressedSize),
        data =
          entry.method === 0
            ? compressed
            : inflateRawSync(compressed, { maxOutputLength: entry.size + 1 });
      requireValue(
        data.length === entry.size && crc(data) === entry.crc,
        `ZIP payload size/CRC mismatch: ${entry.name}`,
      );
      return sha(data);
    }
    return await action(entries, entryDigest);
  } finally {
    await handle.close();
  }
}
const requiredParams = {
  CloseDown: ["client_type"],
  StartUp: ["client_type", "start_game_enabled"],
  Recruit: ["refresh", "select", "confirm", "times", "expedite"],
  Mall: ["visit_friends", "shopping", "credit_fight"],
  Fight: [
    "stage",
    "medicine",
    "stone",
    ["medicine_expire_days", "expiring_medicine"],
  ],
  Infrast: ["mode", "replenish", "dorm_trust_enabled"],
  Award: ["award", "mail", "recruit", "orundum", "mining", "specialaccess"],
  Depot: ["enable"],
  OperBox: ["enable"],
  Copilot: [
    ["filename", "copilot_list"],
    "use_sanity_potion",
    "ignore_requirements",
  ],
  // stop_at_final_boss is not supported by Phantom, so it is deliberately conditional.
  Roguelike: ["theme", "mode", "starts_count"],
  Reclamation: ["theme", "mode", "clear_store", "num_craft_batches"],
  SSSCopilot: ["filename", "loop_times"],
  ParadoxCopilot: [["filename", "list"]],
  SwitchTheme: ["themes"],
  VideoRecognition: ["filename"],
  Custom: ["task_names"],
  OperProgress: ["plans"],
};
function children(node, visit) {
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value)
        if (child && typeof child.type === "string") visit(child);
    } else if (value && typeof value.type === "string") visit(value);
  }
}
function property(object, name) {
  return object.properties.find(
    (p) => p.type === "Property" && (p.key.name ?? p.key.value) === name,
  )?.value;
}
async function skillContracts(root, gaps) {
  // Parse a closed source graph. Never import/evaluate adapter or fixture JavaScript.
  const knownSources = [
    "config.ts",
    "task-options.ts",
    "extended-options.ts",
    "copilot-options.ts",
  ].map((name) => `games/arknights/${name}`);
  const modules = new Map();
  for (const filename of knownSources) {
    let text;
    try {
      await noLinkedAncestors(join(root, filename));
      text = await readFile(join(root, filename), "utf8");
    } catch (error) {
      if (filename !== knownSources[0] && error.code === "ENOENT") continue;
      throw error;
    }
    const module = {
      filename,
      text,
      ast: parsers.typescript.parse(text),
      functions: new Map(),
      imports: new Map(),
    };
    modules.set(filename, module);
    for (const statement of module.ast.body) {
      if (statement.type === "ImportDeclaration") {
        const importedPath = relative(
          root,
          resolve(root, dirname(filename), statement.source.value),
        ).replaceAll("\\", "/");
        const target = /\.ts$/.test(importedPath)
          ? importedPath
          : `${importedPath}.ts`;
        if (knownSources.includes(target))
          for (const specifier of statement.specifiers)
            if (specifier.type === "ImportSpecifier")
              module.imports.set(specifier.local.name, {
                target,
                name: specifier.imported.name,
              });
      }
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
      if (declaration?.type === "FunctionDeclaration")
        module.functions.set(declaration.id.name, {
          node: declaration,
          module,
        });
      if (declaration?.type === "VariableDeclaration")
        for (const entry of declaration.declarations)
          if (
            entry.id.type === "Identifier" &&
            ["ArrowFunctionExpression", "FunctionExpression"].includes(
              entry.init?.type,
            )
          )
            module.functions.set(entry.id.name, { node: entry.init, module });
    }
  }
  const configModule = modules.get(knownSources[0]),
    taskFor = configModule.functions.get("taskFor");
  requireValue(taskFor, "Native taskFor parameter contracts not found");
  const unwrap = (node) =>
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ChainExpression",
    ].includes(node?.type)
      ? unwrap(node.expression)
      : node;
  function context(definition, args = []) {
    const ctx = { module: definition.module, bindings: new Map() };
    for (let i = 0; i < definition.node.params.length; i++) {
      const parameter = definition.node.params[i];
      if (parameter.type === "Identifier")
        ctx.bindings.set(parameter.name, args[i] ?? null);
    }
    function local(node) {
      if (node.type === "FunctionDeclaration" && node.id)
        ctx.bindings.set(node.id.name, null);
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(node.type)
      )
        return;
      if (node.type === "VariableDeclaration")
        for (const entry of node.declarations)
          if (entry.id.type === "Identifier") {
            const name = entry.id.name;
            // Mutable or ambiguously shadowed locals are intentionally unresolved.
            ctx.bindings.set(
              name,
              node.kind !== "const" || ctx.bindings.has(name)
                ? null
                : { node: entry.init, context: ctx },
            );
          }
      children(node, local);
    }
    local(definition.node.body);
    function invalidate(node, seen = new Set()) {
      node = unwrap(node);
      if (node?.type === "MemberExpression")
        return invalidate(node.object, seen);
      if (node?.type !== "Identifier" || seen.has(node.name)) return;
      seen.add(node.name);
      const binding = ctx.bindings.get(node.name);
      if (binding?.context === ctx && binding.node?.type === "Identifier")
        invalidate(binding.node, seen);
      if (ctx.bindings.has(node.name)) ctx.bindings.set(node.name, null);
    }
    function writes(node) {
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(node.type)
      )
        return;
      if (node.type === "AssignmentExpression") invalidate(node.left);
      if (node.type === "UpdateExpression") invalidate(node.argument);
      if (node.type === "CallExpression") {
        if (node.callee.type === "MemberExpression")
          invalidate(node.callee.object);
        for (const argument of node.arguments) {
          const binding =
            argument.type === "Identifier" && ctx.bindings.get(argument.name);
          if (binding && unwrap(binding.node)?.type !== "Literal")
            invalidate(argument);
        }
      }
      children(node, writes);
    }
    writes(definition.node.body);
    return ctx;
  }
  function literal(ref, seen = new Set()) {
    const node = unwrap(ref?.node);
    if (!node || seen.has(node)) return undefined;
    seen.add(node);
    if (node.type === "Literal") return node.value;
    if (node.type === "Identifier")
      return literal(ref.context.bindings.get(node.name), seen);
    if (
      node.type === "BinaryExpression" &&
      ["===", "!=="].includes(node.operator)
    ) {
      const left = literal({ ...ref, node: node.left }, new Set(seen)),
        right = literal({ ...ref, node: node.right }, new Set(seen));
      if (left !== undefined && right !== undefined)
        return node.operator === "===" ? left === right : left !== right;
    }
    return undefined;
  }
  function returns(definition, ctx) {
    if (definition.node.body.type !== "BlockStatement")
      return [{ node: definition.node.body, context: ctx }];
    const result = [];
    function visit(node) {
      if (
        !node ||
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(node.type)
      )
        return;
      if (node.type === "ReturnStatement") {
        result.push({ node: node.argument, context: ctx });
        return;
      }
      if (node.type === "IfStatement") {
        const test = literal({ node: node.test, context: ctx });
        if (test !== false) visit(node.consequent);
        if (test !== true) visit(node.alternate);
        return;
      }
      if (node.type === "SwitchStatement") {
        const value = literal({ node: node.discriminant, context: ctx });
        if (value === undefined) {
          for (const branch of node.cases)
            for (const statement of branch.consequent) visit(statement);
        } else {
          let start = node.cases.findIndex(
            (branch) =>
              branch.test &&
              literal({ node: branch.test, context: ctx }) === value,
          );
          if (start < 0) start = node.cases.findIndex((branch) => !branch.test);
          for (let i = start; i >= 0 && i < node.cases.length; i++) {
            for (const statement of node.cases[i].consequent) visit(statement);
            if (node.cases[i].consequent.length) break;
          }
        }
        return;
      }
      children(node, visit);
    }
    visit(definition.node.body);
    return result;
  }
  function callee(ref) {
    const name = ref.node.callee.type === "Identifier" && ref.node.callee.name,
      module = ref.context.module;
    if (!name || ref.context.bindings.has(name)) return undefined;
    const imported = module.imports.get(name);
    return (
      module.functions.get(name) ??
      (imported && modules.get(imported.target)?.functions.get(imported.name))
    );
  }
  function objects(ref, id, purpose, seen = new Set()) {
    const node = unwrap(ref?.node),
      ctx = ref?.context;
    if (
      !node ||
      (node.type === "Identifier" &&
        node.name === "undefined" &&
        !ctx.bindings.has(node.name))
    )
      return purpose === "spread"
        ? [{ node: { type: "ObjectExpression", properties: [] }, context: ctx }]
        : [];
    if (seen.has(node) || seen.size > 64) {
      gaps.push(
        `${id}: recursive dynamic native parameter ${purpose} requires review`,
      );
      return [];
    }
    const next = new Set(seen).add(node);
    if (node.type === "ObjectExpression") return [{ node, context: ctx }];
    if (node.type === "ConditionalExpression") {
      const test = literal({ node: node.test, context: ctx });
      const branches =
        test === undefined
          ? [node.consequent, node.alternate]
          : [test ? node.consequent : node.alternate];
      return branches.flatMap((branch) =>
        objects({ node: branch, context: ctx }, id, purpose, next),
      );
    }
    if (node.type === "Identifier" && ctx.bindings.get(node.name))
      return objects(ctx.bindings.get(node.name), id, purpose, next);
    if (node.type === "CallExpression") {
      const definition = callee({ node, context: ctx });
      if (definition) {
        const called = context(
          definition,
          node.arguments.map((argument) => ({ node: argument, context: ctx })),
        );
        const returned = returns(definition, called);
        if (returned.length)
          return returned.flatMap((value) => objects(value, id, purpose, next));
      }
    }
    gaps.push(
      `${id}: dynamic native parameter ${purpose} requires review (${ctx.module.filename}:${node.loc.start.line})`,
    );
    return [];
  }
  function fields(ref, id, groups, seen = new Set()) {
    const result = new Map(),
      guarantees = new Set(),
      variants = objects(ref, id, "spread", seen);
    let first = true;
    for (const variant of variants) {
      const branchGuarantees = new Set();
      for (const entry of variant.node.properties) {
        if (entry.type === "SpreadElement") {
          const nested = fields(
            { node: entry.argument, context: variant.context },
            id,
            groups,
            new Set(seen).add(variant.node),
          );
          for (const [key, value] of nested.fields) result.set(key, value);
          for (const group of nested.guarantees) branchGuarantees.add(group);
        } else if (
          entry.type === "Property" &&
          !entry.computed &&
          ["Identifier", "Literal"].includes(entry.key.type)
        ) {
          const key = String(entry.key.name ?? entry.key.value),
            source = variant.context.module;
          result.set(key, {
            expression: source.text.slice(...entry.value.range),
            source: source.filename,
            line: entry.loc.start.line,
          });
          groups.forEach((group, index) => {
            if (group.includes(key)) branchGuarantees.add(index);
          });
        } else gaps.push(`${id}: dynamic native parameter key requires review`);
      }
      if (first) {
        for (const group of branchGuarantees) guarantees.add(group);
        first = false;
      } else
        for (const group of guarantees)
          if (!branchGuarantees.has(group)) guarantees.delete(group);
    }
    return { fields: result, guarantees };
  }
  const index = parsers.typescript.parse(
    await readFile(join(root, "games/arknights/index.ts"), "utf8"),
  );
  const registered = [];
  function registeredVisit(node) {
    if (
      node.type === "Property" &&
      (node.key.name ?? node.key.value) === "skills" &&
      node.value.type === "ArrayExpression"
    )
      for (const entry of node.value.elements) {
        const id = entry?.type === "ObjectExpression" && property(entry, "id");
        if (id?.type === "Literal" && typeof id.value === "string")
          registered.push(id.value);
        else gaps.push("Dynamic skill registration requires review");
      }
    children(node, registeredVisit);
  }
  registeredVisit(index);
  requireValue(registered.length, "Game skill registration not found");
  const ids = new Set(registered),
    skills = [];
  function directIds(node) {
    if (node.type === "SwitchCase" && typeof node.test?.value === "string")
      ids.add(node.test.value);
    if (!["FunctionExpression", "ArrowFunctionExpression"].includes(node.type))
      children(node, directIds);
  }
  directIds(taskFor.node.body);
  for (const id of ids) {
    const gapStart = gaps.length,
      ctx = context(taskFor, [
        { node: { type: "Literal", value: id }, context: null },
      ]);
    const tasks = returns(taskFor, ctx).flatMap((ref) =>
      objects(ref, id, "contract"),
    );
    const byType = new Map();
    for (const task of tasks) {
      const type = property(task.node, "type"),
        params = property(task.node, "params");
      if (
        type?.type !== "Literal" ||
        typeof type.value !== "string" ||
        !params
      ) {
        gaps.push(`Unresolved native parameter contract for skill: ${id}`);
        continue;
      }
      const required = requiredParams[type.value];
      if (!required)
        gaps.push(
          `Unknown native task type ${type.value}; review its required parameters`,
        );
      const groups = (required ?? []).map((group) =>
        Array.isArray(group) ? group : [group],
      );
      const shape = fields({ node: params, context: task.context }, id, groups);
      const missing = groups
        .filter((_group, index) => !shape.guarantees.has(index))
        .map((group) => group.join(" or "));
      if (missing.length)
        gaps.push(
          `${id}: missing required ${type.value} parameters: ${missing.join(", ")}`,
        );
      let skill = byType.get(type.value);
      if (!skill) {
        skill = {
          id,
          type: type.value,
          params: [],
          parameterExpressions: {},
          parameterSources: {},
          source: task.context.module.filename,
          line: task.node.loc.start.line,
          certification: "pending-real-device",
          parameterStatus: "static-adapter-reviewed",
        };
        byType.set(type.value, skill);
      }
      for (const [name, value] of shape.fields) {
        skill.parameterExpressions[name] ??= value.expression;
        const sources = (skill.parameterSources[name] ??= []);
        if (
          !sources.some(
            (source) =>
              source.source === value.source && source.line === value.line,
          )
        )
          sources.push({ source: value.source, line: value.line });
      }
    }
    if (!byType.size && registered.includes(id))
      gaps.push(
        `Registered skill has no resolved native parameter contract: ${id}`,
      );
    for (const skill of byType.values()) {
      skill.params = Object.keys(skill.parameterExpressions).sort();
      skill.parameterStatus =
        gaps.length > gapStart ? "blocked" : "static-adapter-reviewed";
      skills.push(skill);
    }
  }
  requireValue(skills.length, "Native taskFor parameter contracts not found");
  return skills;
}
/** Byte provenance is independently checked; native behavioral compatibility is deliberately pending. */
export async function auditEngine(options = {}) {
  const root = resolve(options.root ?? workspace),
    gaps = [],
    files = [],
    awardOptions = [];
  let contract,
    bundle,
    archive,
    contractSha256,
    skills = [];
  try {
    const contractFile = resolve(
      options.contractFile ??
        join(root, "games/arknights/engine-contract.json"),
    );
    await noLinkedAncestors(contractFile);
    const contractBytes = await readFile(contractFile);
    contractSha256 = sha(contractBytes);
    contract = JSON.parse(contractBytes.toString("utf8"));
    requireValue(
      /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(contract.version) &&
        /^[a-f0-9]{64}$/.test(contract.archiveSha256),
      "Invalid fixed engine contract version/archive SHA-256",
    );
    requireValue(
      contract.awardOptions &&
        typeof contract.awardOptions === "object" &&
        !Array.isArray(contract.awardOptions),
      "Missing fixed Award option contract",
    );
    skills = await skillContracts(root, gaps);
    const award = skills.find((skill) => skill.type === "Award");
    for (const [key, value] of Object.entries(contract.awardOptions)) {
      requireValue(
        value && typeof value.supported === "boolean",
        `Invalid Award contract: ${key}`,
      );
      if (value.supported && !award?.params.includes(key))
        gaps.push(
          `Supported Award option ${key} is absent from actual adapter parameters`,
        );
      if (!value.supported && award?.params.includes(key))
        gaps.push(
          `Unsupported Award option ${key} appears in adapter parameters`,
        );
      awardOptions.push({
        key,
        supported: value.supported,
        configKey: value.configKey ?? null,
        minVersion: value.minVersion ?? null,
        certification: value.supported ? "pending-real-device" : "unsupported",
      });
    }
    const asset = `MAA-${contract.version}-win-x64.zip`;
    bundle = resolve(
      options.bundle ?? join(root, `artifacts/vendor/maa-${contract.version}`),
    );
    archive = resolve(options.archive ?? join(root, "artifacts/vendor", asset));
    await noLinkedAncestors(bundle);
    await noLinkedAncestors(archive);
    requireValue(
      (await lstat(bundle)).isDirectory() && (await lstat(archive)).isFile(),
      "Engine bundle/archive must be a regular directory/file",
    );
    const paths = await inventory(bundle),
      metadata = JSON.parse(
        await readFile(join(bundle, "gamepilot-provenance.json"), "utf8"),
      );
    const expected = {
      version: contract.version,
      asset,
      sha256: contract.archiveSha256,
      url: `${origin}/releases/download/${contract.version}/${asset}`,
      source: `${origin}/tree/${contract.version}`,
      digestSource: `${origin}/releases/expanded_assets/${contract.version}`,
      license: "AGPL-3.0",
    };
    requireValue(
      Object.entries(expected).every(([key, value]) => metadata[key] === value),
      "Engine provenance differs from the fixed official release",
    );
    requireValue(
      (await digest(archive)) === contract.archiveSha256,
      "Official archive SHA-256 mismatch; no archive entries trusted",
    );
    await withArchive(archive, async (entries, entryDigest) => {
      for (const name of [
        "MaaCore.dll",
        "resource/config.json",
        "resource/tasks/tasks.json",
      ])
        requireValue(
          entries.has(name),
          `Official ZIP missing critical entry: ${name}`,
        );
      const local = new Set(paths);
      for (const [name, entry] of entries) {
        if (!local.has(name)) {
          gaps.push(`Missing official bundle file: ${name}`);
          continue;
        }
        const expectedSha256 = await entryDigest(entry),
          actualSha256 = await digest(join(bundle, name));
        files.push({
          path: name,
          sha256: actualSha256,
          archiveSha256: expectedSha256,
          status: actualSha256 === expectedSha256 ? "matched" : "modified",
        });
        if (actualSha256 !== expectedSha256)
          gaps.push(`Bundle bytes differ from official ZIP: ${name}`);
      }
      for (const name of paths.filter(relevant))
        if (!entries.has(name))
          gaps.push(`Untracked native/resource bundle file: ${name}`);
    });
  } catch (error) {
    gaps.push(
      error.code === "ENOENT"
        ? `Missing local engine input: ${error.path ?? "artifact"}`
        : error.message,
    );
  }
  return {
    schemaVersion: 1,
    status: gaps.length ? "blocked" : "ready-for-review",
    version: contract?.version ?? null,
    bundle: bundle ?? null,
    archive: archive ?? null,
    contractSha256: contractSha256 ?? null,
    archiveSha256: contract?.archiveSha256 ?? null,
    files,
    skills,
    awardOptions,
    gaps,
    limits: [
      "Official archive bytes and declared adapter parameter keys do not certify native parameter acceptance or real-device skill behavior.",
      "Parameter inventory parses only the explicit local adapter/helper source graph; conditional keys describe possible branches, not simultaneous runtime values or user authorization.",
      "All skills remain pending-real-device: record device/account identity, repeated frames, task completion/effect evidence and negative-case checks for this exact contract/archive.",
      "A minVersion, including v6.18.0 for signinevent, never enables an unsupported contract option.",
      "Corresponding source/notices and public redistribution review remain a separate distribution-audit gate.",
    ],
  };
}
/** An explicit local target comparison. The target folder is treated as immutable; no switch is executed. */
export async function planEngineRollback(options) {
  requireValue(
    options.targetBundle && options.targetArchive && options.targetContract,
    "Rollback requires explicit target-bundle, target-archive and target-contract",
  );
  const [current, target] = await Promise.all([
    auditEngine(options),
    auditEngine({
      ...options,
      bundle: options.targetBundle,
      archive: options.targetArchive,
      contractFile: options.targetContract,
    }),
  ]);
  const gaps = [
    ...current.gaps.map((gap) => `current: ${gap}`),
    ...target.gaps.map((gap) => `target: ${gap}`),
  ];
  if (
    current.bundle &&
    target.bundle &&
    current.bundle.toLowerCase() === target.bundle.toLowerCase()
  )
    gaps.push("Rollback target must be a distinct immutable bundle directory");
  const currentFiles = new Map(
      current.files.map((file) => [file.path, file.sha256]),
    ),
    targetFiles = new Map(target.files.map((file) => [file.path, file.sha256]));
  const changedFiles = [
    ...new Set([...currentFiles.keys(), ...targetFiles.keys()]),
  ]
    .filter((path) => currentFiles.get(path) !== targetFiles.get(path))
    .sort();
  return {
    schemaVersion: 1,
    status: gaps.length ? "blocked" : "ready-for-review",
    action: "manual-engine-switch",
    automaticOverwrite: false,
    current,
    target,
    changedFiles,
    gaps,
    steps: [
      "Review both immutable bundle/archive/contract hashes and skill parameter compatibility; retain the active bundle and all user data.",
      "Stop scheduled/live tasks and close the independent native worker before any separately authorized engine selection change.",
      "Prepare a new build/profile referencing the target contract and target bundle together; do not copy DLLs over an active library.",
      "Re-run setup and engine audits, record launch/build references, then perform identity/effect/negative-case real-device validation before enabling tasks.",
      "If validation fails, select the retained previous bundle/contract together; keep logs and screenshots for diagnosis.",
    ],
  };
}
export function parseEngineArgs(args) {
  const result = { mode: "check" },
    seen = new Set(),
    paths = {
      "--root": "root",
      "--bundle": "bundle",
      "--archive": "archive",
      "--contract": "contractFile",
      "--target-bundle": "targetBundle",
      "--target-archive": "targetArchive",
      "--target-contract": "targetContract",
    };
  let mode;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    requireValue(!seen.has(flag), `Duplicate flag: ${flag}`);
    seen.add(flag);
    if (["--check", "--rollback"].includes(flag)) {
      requireValue(!mode, "Choose check or rollback");
      mode = flag.slice(2);
      result.mode = mode;
    } else if (paths[flag]) {
      requireValue(
        args[i + 1] && !args[i + 1].startsWith("--"),
        `${flag} requires a path`,
      );
      result[paths[flag]] = args[++i];
    } else throw Error(`Unknown engine audit flag: ${flag}`);
  }
  if (result.mode === "rollback")
    for (const name of ["targetBundle", "targetArchive", "targetContract"])
      requireValue(
        result[name],
        `--rollback requires --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      );
  else
    requireValue(
      !result.targetBundle && !result.targetArchive && !result.targetContract,
      "Target paths require --rollback",
    );
  return result;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseEngineArgs(process.argv.slice(2)),
      report =
        options.mode === "rollback"
          ? await planEngineRollback(options)
          : await auditEngine(options);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "blocked") process.exitCode = 2;
  } catch (error) {
    console.error(`Engine audit refused: ${error.message}`);
    process.exitCode = 1;
  }
}
