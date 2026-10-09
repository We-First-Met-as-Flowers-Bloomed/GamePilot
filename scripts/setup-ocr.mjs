import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
const revision = "dabcd4681ac990dc4361de26416d986abd80e4aa";
const root = new URL("../games/onmyoji/resources/model/ocr/", import.meta.url);
const files = {
  "det.onnx":
    "767e663dded50813dca0abc9a49859e345e0f74a48b387661188f096a9211d74",
  "rec.onnx":
    "da4815ea386ee8083be319da8d20e70f4fdb0b6404ba0d2da7f675831e1b37fa",
  "keys.txt":
    "d917d7489d2c20d2e4cee8c17068f8ac54f6ee406a04bf5ac3b1ff5dc38e1e52",
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
await mkdir(root, { recursive: true });
for (const [name, expected] of Object.entries(files)) {
  const target = new URL(name, root);
  try {
    if (sha(await readFile(target)) === expected) {
      console.log(`${name}: verified`);
      continue;
    }
  } catch {}
  const response = await fetch(
    `https://raw.githubusercontent.com/MaaXYZ/MaaCommonAssets/${revision}/OCR/ppocr_v4/zh_cn/${name}`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok) throw new Error(`OCR download ${response.status}: ${name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== expected)
    throw new Error(`OCR checksum mismatch: ${name}`);
  const temporary = new URL(`${name}.tmp`, root);
  await writeFile(temporary, bytes);
  await rename(temporary, target);
  console.log(`${name}: installed and verified`);
}
