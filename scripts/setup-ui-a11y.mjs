// Test tooling only. Never install through the shared application node_modules junction.
import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "artifacts", "ui-a11y-tools");
if (process.argv.length > 2)
  throw new Error("setup:ui-a11y does not accept arguments");
for (const path of [
  join(root, "artifacts"),
  directory,
  join(directory, "node_modules"),
]) {
  const stat = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat?.isSymbolicLink())
    throw new Error("Refuse to install UI test tools through a link");
}
await mkdir(directory, { recursive: true });
const npmCli =
  process.env.npm_execpath ??
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const code = await new Promise((done, reject) => {
  const child = spawn(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      "axe-core@4.10.3",
    ],
    { stdio: "inherit", windowsHide: true },
  );
  child.once("error", reject);
  child.once("exit", done);
});
if (code !== 0) throw new Error(`UI test tool setup failed (${code})`);
console.log(
  "axe-core 4.10.3 (MPL-2.0) ready for isolated UI checks; application dependencies unchanged.",
);
