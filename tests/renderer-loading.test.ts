import { resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { expect, it } from "vitest";

it("ships the slot home without loading advanced page implementations", async () => {
  const built = await build({
    configFile: false,
    root: resolve("apps/desktop/renderer"),
    base: "./",
    plugins: [react()],
    logLevel: "silent",
    build: { write: false, minify: false },
  });
  if (Array.isArray(built) || !("output" in built))
    throw Error("Expected one renderer build");
  const chunks = built.output.filter((entry) => entry.type === "chunk");
  const initialModules = new Set<string>();
  const visited = new Set<string>();
  function visit(fileName: string) {
    if (visited.has(fileName)) return;
    visited.add(fileName);
    const chunk = chunks.find((entry) => entry.fileName === fileName);
    if (!chunk) throw Error(`Missing initial chunk ${fileName}`);
    for (const id of Object.keys(chunk.modules))
      initialModules.add(id.replaceAll("\\", "/"));
    chunk.imports.forEach(visit);
  }
  chunks
    .filter((entry) => entry.isEntry)
    .forEach((entry) => visit(entry.fileName));
  const initial = [...initialModules].join("\n");
  expect(initial).toContain("/views/SlotDashboard.tsx");
  for (const page of [
    "Chat",
    "Devices",
    "Settings",
    "Daily",
    "ModelConnection",
  ])
    expect(initial).not.toContain(`/views/${page}.tsx`);
  expect(initial).not.toContain("/components/GameWorkspace.tsx");
  expect(initial).not.toContain("/components/ChatArchives.tsx");
}, 30000);
