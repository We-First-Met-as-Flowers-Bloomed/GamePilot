import { readdir, lstat, realpath, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";

/** Only disposable, obsolete built copies; archives and the vendor cache are untouched. */
export async function pruneBuiltMaaResources(
  resourcesDirectory,
  currentVersion,
) {
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(currentVersion))
    throw Error("Invalid bundled MaaCore version");
  const root = resolve(resourcesDirectory);
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
    throw Error("Linked build resource root rejected");
  const removed = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      entry.name === `maa-${currentVersion}` ||
      !/^maa-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(entry.name)
    )
      continue;
    const target = join(root, entry.name),
      info = await lstat(target);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      dirname(target) !== root ||
      (await realpath(target)) !== target
    )
      throw Error("Unsafe obsolete build resource path");
    await rm(target, { recursive: true, force: false });
    removed.push(target);
  }
  return removed;
}
