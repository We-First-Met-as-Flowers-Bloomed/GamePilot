import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { sha256 } from "../packages/protocol/sha256";
import { canonical } from "../packages/protocol/canonical";
import { canonical as storedCanonical } from "../packages/acceptance/files";
import { normalizeAbsoluteWindowsPath } from "../packages/protocol/windows-path";

it.each([
  "",
  "abc",
  "明日方舟-账号😀",
  "\ud800",
  "a".repeat(55),
  "a".repeat(56),
  "a".repeat(63),
  "a".repeat(64),
  "a".repeat(65),
  "ab汉字".repeat(10_000),
])("hashes UTF-8 evidence exactly like the host (%#)", (value) => {
  expect(sha256(value)).toBe(createHash("sha256").update(value).digest("hex"));
});

it("keeps the exact canonical representation of existing persisted evidence", () => {
  const data = {
    z: undefined,
    身份: "UID",
    a: [null, undefined, 1, { z: false, a: "😀" }],
  };
  expect(canonical(data)).toBe(storedCanonical(data));
  expect(sha256(canonical(data))).toBe(
    createHash("sha256").update(storedCanonical(data)).digest("hex"),
  );
});

it.each([
  "D:\\MuMu\\MuMuManager.exe",
  "D:/MuMu/./MuMuManager.exe",
  "D:/other/../MuMu//MuMuManager.exe",
  "D:/../../MuMuManager.exe",
  "D:/",
  "D:/foo/..",
  "D:/foo/../",
  "\\\\server\\share\\MuMuManager.exe",
  "//server/share/foo/../MuMuManager.exe",
  "\\\\server\\share\\..\\MuMuManager.exe",
  "\\\\?\\D:\\MuMu\\MuMuManager.exe",
])(
  "normalizes absolute device paths compatibly with the host (%#)",
  (value) => {
    expect(normalizeAbsoluteWindowsPath(value)).toBe(win32.normalize(value));
  },
);

it.each([
  "D:relative",
  "relative/path",
  "",
  "/not-a-windows-device",
  "\\root-relative",
])("does not accept a drive-relative or ambiguous path (%#)", (value) => {
  expect(() => normalizeAbsoluteWindowsPath(value)).toThrow();
});

it("bundles shared continuation and progress logic for a browser without Node polyfills", async () => {
  await expect(
    build({
      entryPoints: [
        "games/continuation.ts",
        "games/continuation-history.ts",
        "games/execution-progress.ts",
      ],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      outdir: "unused",
      logLevel: "silent",
    }),
  ).resolves.toBeDefined();
});
