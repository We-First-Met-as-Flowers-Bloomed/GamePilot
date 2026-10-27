import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { pruneBuiltMaaResources } from "../scripts/shared/build-resources.mjs";
it("removes old built MaaCore copies while retaining current resources and unrelated evidence", async () => {
  const root = await mkdtemp(
    join(resolve("artifacts"), "build-resources-test-"),
  );
  for (const name of [
    "maa-v6.19.0-beta.2",
    "maa-v6.20.1",
    "onmyoji",
    "maa-not-a-version",
  ]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "proof.txt"), name);
  }
  expect(
    (await pruneBuiltMaaResources(root, "v6.20.1")).map((path: string) =>
      path.slice(root.length + 1),
    ),
  ).toEqual(["maa-v6.19.0-beta.2"]);
  expect(await readFile(join(root, "maa-v6.20.1", "proof.txt"), "utf8")).toBe(
    "maa-v6.20.1",
  );
  expect(await readdir(root)).toEqual(
    expect.arrayContaining(["onmyoji", "maa-not-a-version"]),
  );
});
it("refuses linked roots and linked obsolete copies instead of traversing shared resources", async () => {
  const parent = await mkdtemp(
      join(resolve("artifacts"), "build-resources-test-"),
    ),
    outside = join(parent, "outside"),
    root = join(parent, "resources");
  await mkdir(outside);
  await mkdir(root);
  await writeFile(join(outside, "proof"), "retained");
  await symlink(outside, join(root, "maa-v6.19.0-beta.2"), "junction");
  await expect(pruneBuiltMaaResources(root, "v6.20.1")).rejects.toThrow(
    /Unsafe/,
  );
  const linked = join(parent, "linked-root");
  await symlink(root, linked, "junction");
  await expect(pruneBuiltMaaResources(linked, "v6.20.1")).rejects.toThrow(
    /Linked/,
  );
  expect(await readFile(join(outside, "proof"), "utf8")).toBe("retained");
});
