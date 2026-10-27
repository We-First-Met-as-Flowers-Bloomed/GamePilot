import { createHash } from "node:crypto";
import { lstat, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/typescript";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const requireValue = (value, message) => {
  if (!value) throw Error(message);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rect = (value) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every(Number.isInteger) &&
  value[0] >= 0 &&
  value[1] >= 0 &&
  value[2] > 0 &&
  value[3] > 0 &&
  value[0] + value[2] <= 1920 &&
  value[1] + value[3] <= 1080;
function children(node, visit) {
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      for (const item of value) {
        if (item && typeof item.type === "string") visit(item);
      }
    else if (value && typeof value.type === "string") visit(value);
  }
}
async function noLinkedAncestors(path) {
  const absolute = resolve(path),
    anchor = parse(absolute).root;
  let cursor = anchor;
  for (const part of relative(anchor, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      requireValue(
        !(await lstat(cursor)).isSymbolicLink(),
        `Linked path refused: ${cursor}`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
async function paths(directory, prefix = "") {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    requireValue(
      !entry.isSymbolicLink(),
      `Linked inventory entry: ${entry.name}`,
    );
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      entries.push(...(await paths(join(directory, entry.name), name)));
    else if (entry.isFile()) entries.push(name);
  }
  return entries.sort();
}
/** Collect the literal references used by the current game implementation, not a hand-maintained promise. */
export async function templateInventory(root = workspace) {
  root = resolve(root);
  const directory = join(root, "games/onmyoji"),
    inventory = new Map();
  await noLinkedAncestors(directory);
  const add = (name, use) => {
    requireValue(
      /^[A-Za-z0-9_-]+\.png$/.test(name),
      `Unsupported template reference: ${name}`,
    );
    if (!inventory.has(name)) inventory.set(name, { name, uses: [] });
    inventory.get(name).uses.push(use);
  };
  for (const path of await paths(directory)) {
    if (path.endsWith(".ts")) {
      const source = parsers.typescript.parse(
        await readFile(join(directory, path), "utf8"),
      );
      function visit(node) {
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          ["matchTemplate", "matchFeatures"].includes(node.callee.property.name)
        ) {
          const [name, roi, threshold] = node.arguments;
          requireValue(
            name?.type === "Literal" && typeof name.value === "string",
            `Dynamic template reference requires manual inventory: ${path}`,
          );
          const roiValue =
            roi?.type === "ArrayExpression" &&
            roi.elements.every(
              (n) => n?.type === "Literal" && typeof n.value === "number",
            )
              ? roi.elements.map((n) => n.value)
              : null;
          add(name.value, {
            source: `games/onmyoji/${path}`,
            line: node.loc.start.line,
            algorithm:
              node.callee.property.name === "matchTemplate"
                ? "TemplateMatch"
                : "FeatureMatch",
            roi: roiValue,
            threshold:
              node.callee.property.name === "matchTemplate" &&
              threshold?.type === "Literal" &&
              typeof threshold.value === "number"
                ? threshold.value
                : null,
          });
        }
        children(node, visit);
      }
      visit(source);
    } else if (path.endsWith(".json")) {
      function visit(value) {
        if (!value || typeof value !== "object") return;
        if (Object.hasOwn(value, "template"))
          for (const name of Array.isArray(value.template)
            ? value.template
            : [value.template])
            add(name, {
              source: `games/onmyoji/${path}`,
              line: null,
              algorithm: value.algorithm ?? "TemplateMatch",
              roi: value.roi ?? null,
              threshold: Array.isArray(value.threshold)
                ? value.threshold[0]
                : (value.threshold ?? null),
            });
        for (const entry of Object.values(value))
          if (entry && typeof entry === "object") visit(entry);
      }
      visit(JSON.parse(await readFile(join(directory, path), "utf8")));
    }
  }
  requireValue(
    inventory.size > 0,
    "No template requirements found in current game sources",
  );
  for (const entry of inventory.values()) {
    try {
      const stat = await lstat(join(directory, "resources/image", entry.name));
      entry.present = stat.isFile() && !stat.isSymbolicLink();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entry.present = false;
    }
  }
  return [...inventory.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function pngInfo(bytes, path) {
  requireValue(
    bytes.length >= 45 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    `Invalid PNG: ${path}`,
  );
  let offset = 8,
    header,
    ended = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset),
      end = offset + 12 + size;
    requireValue(end <= bytes.length, `Truncated PNG: ${path}`);
    const type = bytes.toString("ascii", offset + 4, offset + 8),
      data = bytes.subarray(offset + 8, end - 4);
    requireValue(
      crc(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4),
      `PNG CRC mismatch: ${path}`,
    );
    if (type === "IHDR") {
      requireValue(
        !header && offset === 8 && size === 13,
        `Invalid PNG IHDR: ${path}`,
      );
      header = data;
    }
    if (type === "IDAT") compressed.push(data);
    if (type === "IEND") {
      requireValue(
        size === 0 && end === bytes.length,
        `Invalid PNG IEND: ${path}`,
      );
      ended = true;
      break;
    }
    offset = end;
  }
  requireValue(header && ended && compressed.length, `Incomplete PNG: ${path}`);
  const width = header.readUInt32BE(0),
    height = header.readUInt32BE(4),
    channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header[9]],
    depth = header[8];
  requireValue(
    width > 0 &&
      height > 0 &&
      width <= 1920 &&
      height <= 1080 &&
      channels &&
      header[10] === 0 &&
      header[11] === 0 &&
      header[12] === 0,
    `PNG must be non-interlaced and within 1920x1080: ${path}`,
  );
  requireValue(
    (header[9] === 0 && [1, 2, 4, 8, 16].includes(depth)) ||
      (header[9] === 3 && [1, 2, 4, 8].includes(depth)) ||
      ([2, 4, 6].includes(header[9]) && [8, 16].includes(depth)),
    `Unsupported PNG depth: ${path}`,
  );
  const stride = Math.ceil((width * channels * depth) / 8) + 1,
    decoded = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: stride * height + 1,
    });
  requireValue(
    decoded.length === stride * height,
    `PNG pixel payload size mismatch: ${path}`,
  );
  for (let row = 0; row < height; row++)
    requireValue(decoded[row * stride] <= 4, `Invalid PNG filter: ${path}`);
  return { path, width, height, sha256: sha(bytes) };
}
function localPath(directory, value) {
  requireValue(
    typeof value === "string" &&
      value &&
      !isAbsolute(value) &&
      !/^[a-z]:/i.test(value) &&
      !value.includes("\\") &&
      value.split("/").every((p) => p && p !== "." && p !== ".."),
    "Capture paths must be safe relative paths inside the manifest directory",
  );
  return resolve(directory, value);
}
async function validated(options) {
  const root = resolve(options.root ?? workspace),
    directory = resolve(options.manifestDirectory ?? root),
    manifest = options.manifest,
    gaps = [],
    templates = [],
    copies = [];
  const inventory = await templateInventory(root);
  if (
    manifest?.schemaVersion !== 1 ||
    JSON.stringify(manifest.coordinateSpace) !== "[1920,1080]" ||
    !Array.isArray(manifest.mappings) ||
    manifest.mappings.length > 1000
  )
    gaps.push(
      "Manifest requires schemaVersion:1, coordinateSpace:[1920,1080] and mappings (maximum 1000)",
    );
  const seen = new Set();
  for (const mapping of Array.isArray(manifest?.mappings) &&
  manifest.mappings.length <= 1000
    ? manifest.mappings
    : []) {
    try {
      requireValue(
        mapping && /^[A-Za-z0-9_-]+\.png$/.test(mapping.name),
        "Invalid template name",
      );
      requireValue(
        !seen.has(mapping.name),
        `Duplicate mapping: ${mapping.name}`,
      );
      seen.add(mapping.name);
      const requirement = inventory.find(
        (entry) => entry.name === mapping.name,
      );
      requireValue(
        requirement,
        `Unreferenced template: ${mapping.name}; identity anchors require a separately reviewed implementation`,
      );
      requireValue(
        rect(mapping.crop),
        "Crop rectangle outside normalized 1920x1080 screenshot",
      );
      requireValue(
        rect(mapping.roi),
        "ROI outside normalized 1920x1080 screenshot",
      );
      requireValue(
        Number.isFinite(mapping.threshold) &&
          mapping.threshold >= 0.5 &&
          mapping.threshold <= 1,
        "Threshold must be between 0.5 and 1",
      );
      const screenshotPath = localPath(directory, mapping.screenshot),
        templatePath = localPath(directory, mapping.template);
      await noLinkedAncestors(screenshotPath);
      await noLinkedAncestors(templatePath);
      requireValue(
        (await lstat(screenshotPath)).isFile() &&
          (await lstat(templatePath)).isFile(),
        "Capture inputs must be regular local files",
      );
      requireValue(
        (await lstat(screenshotPath)).size <= 20 * 1024 * 1024 &&
          (await lstat(templatePath)).size <= 20 * 1024 * 1024,
        "PNG input exceeds 20 MiB limit",
      );
      const screenshotBytes = await readFile(screenshotPath),
        screenshot = pngInfo(screenshotBytes, mapping.screenshot),
        bytes = await readFile(templatePath),
        template = pngInfo(bytes, mapping.template);
      requireValue(
        screenshot.width === 1920 && screenshot.height === 1080,
        "Screenshot must use actual normalized 1920x1080 coordinates",
      );
      requireValue(
        template.width === mapping.crop[2] &&
          template.height === mapping.crop[3],
        "Cropped template dimensions differ from explicit crop",
      );
      requireValue(
        template.width <= mapping.roi[2] && template.height <= mapping.roi[3],
        "Template is larger than search ROI",
      );
      requireValue(
        mapping.crop[0] >= mapping.roi[0] &&
          mapping.crop[1] >= mapping.roi[1] &&
          mapping.crop[0] + mapping.crop[2] <=
            mapping.roi[0] + mapping.roi[2] &&
          mapping.crop[1] + mapping.crop[3] <= mapping.roi[1] + mapping.roi[3],
        "Crop does not lie inside capture search ROI",
      );
      templates.push({
        name: mapping.name,
        screenshot,
        template,
        crop: mapping.crop,
        roi: mapping.roi,
        threshold: mapping.threshold,
        currentUses: requirement.uses,
        requiresCodeReview: requirement.uses.some(
          (use) =>
            JSON.stringify(use.roi) !== JSON.stringify(mapping.roi) ||
            (use.threshold !== null && use.threshold !== mapping.threshold),
        ),
        certification: "pending-real-device",
      });
      copies.push({
        name: mapping.name,
        bytes,
        screenshotBytes,
        screenshotSha256: screenshot.sha256,
      });
    } catch (error) {
      gaps.push(`${mapping?.name ?? "invalid-mapping"}: ${error.message}`);
    }
  }
  for (const requirement of inventory)
    if (!seen.has(requirement.name))
      gaps.push(`Missing capture mapping: ${requirement.name}`);
  return {
    report: {
      schemaVersion: 1,
      status: gaps.length ? "blocked" : "ready-for-review",
      certification: "pending-real-device",
      inventory,
      templates,
      gaps,
      limits: [
        "PNG/ROI/threshold checks do not establish semantic agreement between screenshot and manually cropped template.",
        "Review all currentUses and proposed ROI changes; staged manifests do not change runtime call parameters.",
        "False-positive, negative-scene, repeated-frame, identity anchor and real-device skill validation remain external gates.",
      ],
    },
    copies,
  };
}
export async function checkTemplateManifest(options) {
  return (await validated(options)).report;
}
/** The only mutation: create a NEW explicit task folder; never alter game assets or existing outputs. */
export async function applyTemplateManifest(options) {
  requireValue(
    typeof options.taskRoot === "string" && options.taskRoot,
    "--apply requires --task-root",
  );
  const { report, copies } = await validated(options);
  requireValue(
    report.status === "ready-for-review",
    `Capture check blocked: ${report.gaps.join("; ")}`,
  );
  const taskRoot = resolve(options.taskRoot);
  await noLinkedAncestors(taskRoot);
  try {
    await lstat(taskRoot);
    throw Error("Task root already exists; choose a new immutable task folder");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(taskRoot);
  await mkdir(join(taskRoot, "image"));
  await mkdir(join(taskRoot, "screenshots"));
  const screenshots = new Set();
  for (const entry of copies) {
    await writeFile(join(taskRoot, "image", entry.name), entry.bytes, {
      flag: "wx",
    });
    if (!screenshots.has(entry.screenshotSha256)) {
      await writeFile(
        join(taskRoot, "screenshots", `${entry.screenshotSha256}.png`),
        entry.screenshotBytes,
        { flag: "wx" },
      );
      screenshots.add(entry.screenshotSha256);
    }
  }
  const stagedManifest = {
    ...options.manifest,
    mappings: options.manifest.mappings.map((mapping) => ({
      ...mapping,
      screenshot: `screenshots/${copies.find((entry) => entry.name === mapping.name).screenshotSha256}.png`,
      template: `image/${mapping.name}`,
    })),
  };
  await writeFile(
    join(taskRoot, "capture-manifest.json"),
    JSON.stringify(stagedManifest, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    join(taskRoot, "validation-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  return { ...report, taskRoot };
}
export function parseTemplateArgs(args) {
  const result = { mode: "guide" },
    seen = new Set(),
    paths = {
      "--root": "root",
      "--manifest": "manifestFile",
      "--task-root": "taskRoot",
    };
  let mode;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    requireValue(!seen.has(flag), `Duplicate flag: ${flag}`);
    seen.add(flag);
    if (["--guide", "--check", "--apply"].includes(flag)) {
      requireValue(!mode, "Choose one guide/check/apply mode");
      mode = flag.slice(2);
      result.mode = mode;
    } else if (paths[flag]) {
      requireValue(
        args[i + 1] && !args[i + 1].startsWith("--"),
        `${flag} requires a path`,
      );
      result[paths[flag]] = args[++i];
    } else throw Error(`Unknown template guide flag: ${flag}`);
  }
  requireValue(
    result.mode === "guide" || result.manifestFile,
    "--check/--apply require --manifest",
  );
  requireValue(
    result.mode !== "apply" || result.taskRoot,
    "--apply requires --task-root",
  );
  requireValue(
    result.mode === "apply" || !result.taskRoot,
    "--task-root is only valid with --apply",
  );
  requireValue(
    result.mode !== "guide" || !result.manifestFile,
    "--manifest is only valid with --check/--apply",
  );
  return result;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseTemplateArgs(process.argv.slice(2));
    let report;
    if (options.mode === "guide") {
      const inventory = await templateInventory(options.root);
      report = {
        schemaVersion: 1,
        mode: "guide",
        inventory,
        instructions: [
          "Manually capture each referenced scene as a local 1920x1080 PNG; keep positive, negative and repeated-frame samples.",
          "Manually crop a stable UI control to a separate PNG; record exact source crop, search ROI and threshold. Avoid account-specific text or decorative/dynamic content.",
          "Store screenshot and cropped-template paths relative to the capture manifest. Fill every required mapping and review against currentUses.",
          "Run --check; visually confirm crop/scene/false-positive behavior. --apply only stages copies in a new explicit task root; runtime integration and real-device certification are separate.",
        ],
        manifest: {
          schemaVersion: 1,
          coordinateSpace: [1920, 1080],
          mappings: inventory.map((entry) => ({
            name: entry.name,
            screenshot: null,
            template: null,
            crop: null,
            roi: entry.uses[0]?.roi ?? null,
            threshold:
              entry.uses.find((use) => use.threshold !== null)?.threshold ??
              0.78,
          })),
        },
      };
    } else {
      const file = resolve(options.manifestFile);
      await noLinkedAncestors(file);
      options.manifest = JSON.parse(await readFile(file, "utf8"));
      options.manifestDirectory = dirname(file);
      report =
        options.mode === "apply"
          ? await applyTemplateManifest(options)
          : await checkTemplateManifest(options);
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "blocked") process.exitCode = 2;
  } catch (error) {
    console.error(`Template guide refused: ${error.message}`);
    process.exitCode = 1;
  }
}
