import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
export function sourceState(root) {
  const git = (...args) => {
    const r = spawnSync("git", args, {
      cwd: resolve(root),
      encoding: "utf8",
      windowsHide: true,
    });
    return r.status === 0 ? r.stdout.trim() : undefined;
  };
  const commit = git("rev-parse", "HEAD"),
    tree = git("rev-parse", "HEAD^{tree}"),
    status = git("status", "--porcelain");
  return {
    commit,
    tree,
    clean:
      status === "" &&
      /^[a-f0-9]{40}$/.test(commit ?? "") &&
      /^[a-f0-9]{40}$/.test(tree ?? ""),
  };
}
async function files(directory, prefix = "") {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name,
      path = join(directory, entry.name);
    if (key === "gamepilot-build.json") continue;
    if (entry.isSymbolicLink()) throw Error("Linked build files refused");
    if (entry.isDirectory()) Object.assign(result, await files(path, key));
    else if (entry.isFile()) {
      const digest = createHash("sha256");
      for await (const bytes of createReadStream(path)) digest.update(bytes);
      result[key] = digest.digest("hex");
    } else throw Error("Unsupported build entry");
  }
  return result;
}
export async function writeBuildProvenance(root, before) {
  const metadata = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ),
    output = join(root, "dist"),
    inventory = await files(output),
    after = sourceState(root);
  const provenance = {
    version: 1,
    appVersion: metadata.version,
    sourceCommit: before.commit,
    sourceTree: before.tree,
    clean:
      before.clean &&
      after.clean &&
      before.commit === after.commit &&
      before.tree === after.tree,
    builtAt: new Date().toISOString(),
    files: inventory,
  };
  await writeFile(
    join(output, "gamepilot-build.json"),
    JSON.stringify(provenance, null, 2),
  );
  return provenance;
}
export async function validateBuild(directory, expected) {
  const p = JSON.parse(
    await readFile(join(directory, "gamepilot-build.json"), "utf8"),
  );
  if (
    p.version !== 1 ||
    p.clean !== true ||
    p.appVersion !== expected.appVersion ||
    p.sourceCommit !== expected.sourceCommit ||
    p.sourceTree !== expected.sourceTree ||
    !/^[a-f0-9]{40}$/.test(p.sourceCommit) ||
    !/^[a-f0-9]{40}$/.test(p.sourceTree)
  )
    throw Error("Build source is not the expected clean revision");
  const actual = await files(directory);
  if (
    !p.files ||
    Object.keys(actual).length !== Object.keys(p.files).length ||
    Object.entries(actual).some(([path, hash]) => p.files[path] !== hash)
  )
    throw Error("Built file bytes differ from their recorded hashes");
  return p;
}
