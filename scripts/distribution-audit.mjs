import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function inventory(directory, prefix = "") {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw Error(`Linked distribution entry: ${path}`);
    if (entry.isDirectory())
      paths.push(...(await inventory(join(directory, entry.name), path)));
    else if (entry.isFile()) paths.push(path);
    else throw Error(`Non-file distribution entry: ${path}`);
  }
  return paths;
}
function safePath(root, value) {
  if (
    typeof value !== "string" ||
    !value ||
    isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    value.includes("\\") ||
    value.split("/").some((p) => p === ".." || p === "." || !p)
  )
    throw Error("unsafe manifest path");
  const path = resolve(root, value),
    rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw Error("unsafe manifest path");
  return path;
}

/** Byte coverage and delivery evidence are review aids, never a legal opinion. No downloads. */
export async function auditDistribution(directory, manifest) {
  const root = resolve(directory),
    gaps = [],
    components = [],
    binaries = [];
  if (
    !(await lstat(root)).isDirectory() ||
    (await lstat(root)).isSymbolicLink()
  )
    throw Error("Distribution must be a regular directory");
  const paths = await inventory(root);
  for (const path of paths.filter((p) =>
    /\.(?:dll|node|exe|so(?:\.\d+)*|dylib)$/i.test(p),
  ))
    binaries.push({ path, sha256: await digest(join(root, path)) });
  const listed = new Map();
  const checkArtifact = async (artifact) => {
    const target = safePath(root, artifact?.path);
    if (!paths.includes(artifact.path))
      throw Error(`Missing distribution artifact: ${artifact.path}`);
    const stat = await lstat(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size === 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") ||
      (await digest(target)) !== artifact.sha256
    )
      throw Error(`Artifact hash mismatch: ${artifact.path}`);
  };
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.components) ||
    !manifest.components.length ||
    manifest.components.length > 10000
  )
    gaps.push("Missing reviewed versioned distribution component manifest");
  else
    for (const component of manifest.components) {
      try {
        if (
          !component ||
          typeof component.id !== "string" ||
          !component.id.trim() ||
          typeof component.version !== "string" ||
          !component.version.trim() ||
          typeof component.license !== "string" ||
          !component.license.trim() ||
          !Array.isArray(component.files) ||
          !component.files.length ||
          !Array.isArray(component.notices) ||
          !component.notices.length ||
          components.some((c) => c.id === component.id)
        )
          throw Error(
            "Invalid or duplicate component identity/version/license/notices",
          );
        for (const artifact of [...component.files, ...component.notices])
          await checkArtifact(artifact);
        // Copyleft source cannot be replaced by an upstream URL or license text.
        if (/GPL|MPL|EPL|CDDL/i.test(component.license)) {
          if (
            !component.source ||
            typeof component.source.upstream !== "string" ||
            !/^https:\/\//.test(component.source.upstream) ||
            typeof component.source.buildInstructions !== "string" ||
            !component.source.buildInstructions.trim()
          )
            throw Error(
              `Missing corresponding source/build evidence: ${component.id}`,
            );
          await checkArtifact(component.source);
        }
        for (const artifact of component.files) {
          if (listed.has(artifact.path))
            throw Error(`Duplicate file attribution: ${artifact.path}`);
          listed.set(artifact.path, component.id);
        }
        components.push({
          id: component.id,
          version: component.version,
          license: component.license,
          sourceIncluded: !!component.source,
        });
      } catch (error) {
        gaps.push(`${component?.id ?? "invalid-component"}: ${error.message}`);
      }
    }
  for (const binary of binaries)
    if (!listed.has(binary.path))
      gaps.push(`Unattributed native file: ${binary.path}`);
  const dshLock = "resources/gamepilot-dsh-runtime/package-lock.json";
  if (paths.includes(dshLock)) {
    const lock = JSON.parse(await readFile(join(root, dshLock), "utf8"));
    for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
      if (!path || metadata.dev === true) continue;
      const name = metadata.name ?? path.split("node_modules/").at(-1);
      if (
        !components.some(
          (c) =>
            c.id === name &&
            c.version === metadata.version &&
            c.license === metadata.license,
        )
      )
        gaps.push(`Unreviewed DSH dependency: ${name}@${metadata.version}`);
    }
  }
  return {
    version: 1,
    status: gaps.length ? "blocked" : "ready-for-review",
    binaries,
    components,
    gaps,
    note: "A complete byte/notice/source inventory supports review; it does not assert public redistribution compliance.",
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, manifestFile, ...extra] = process.argv.slice(2);
  if (!directory || extra.length)
    throw Error(
      "Usage: node scripts/distribution-audit.mjs <package-directory> [manifest.json]",
    );
  const manifest = manifestFile
    ? JSON.parse(await readFile(resolve(manifestFile), "utf8"))
    : undefined;
  const report = await auditDistribution(directory, manifest);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "blocked") process.exitCode = 2;
}
