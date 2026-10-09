import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Immutable Git blob IDs verified against the indicated upstream releases.
const upstream = [
  [
    "MaaFramework-LGPL-3.0.md",
    "MaaXYZ/MaaFramework",
    "cb564dabeb29dd072fb252024a34d129c0fa3c44",
    "https://github.com/MaaXYZ/MaaFramework/blob/v5.13.0/LICENSE.md",
  ],
  [
    "GPL-3.0.txt",
    "gcc-mirror/gcc",
    "94a9ed024d3859793618152ea559a168bbcbb5e2",
    "https://github.com/gcc-mirror/gcc/blob/releases/gcc-14.2.0/COPYING3",
  ],
  [
    "FastDeploy-Apache-2.0.txt",
    "MaaXYZ/FastDeploy",
    "261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64",
    "https://github.com/MaaXYZ/FastDeploy/blob/e962983da6daba7d0c12f6bf5f8ff7173be70982/LICENSE",
  ],
  [
    "ONNXRuntime-MIT.txt",
    "microsoft/onnxruntime",
    "48bc6bb4996ac924359e8e28b9ae88970e5ed3fc",
    "https://github.com/microsoft/onnxruntime/blob/v1.19.2/LICENSE",
  ],
  [
    "ONNXRuntime-ThirdPartyNotices.txt",
    "microsoft/onnxruntime",
    "6a11f414361bdab073199488d946c69461d93f94",
    "https://github.com/microsoft/onnxruntime/blob/v1.19.2/ThirdPartyNotices.txt",
  ],
];
const blobId = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
export async function prepareLicenses(root, maaVersion) {
  if (maaVersion !== "5.13.0")
    throw new Error(
      "Review pinned upstream licenses before packaging a different Maa version",
    );
  const directory = join(root, "artifacts", "portable-licenses");
  await mkdir(directory, { recursive: true });
  const sources = [];
  for (const [name, repo, blob, source] of upstream) {
    const target = join(directory, name);
    let bytes;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!bytes || blobId(bytes) !== blob) {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/git/blobs/${blob}`,
        { signal: AbortSignal.timeout(30000) },
      );
      if (!response.ok)
        throw new Error(
          `License download failed (${response.status}): ${source}`,
        );
      const body = await response.json();
      if (body.encoding !== "base64")
        throw new Error(`Unexpected license encoding: ${source}`);
      bytes = Buffer.from(body.content, "base64");
      if (blobId(bytes) !== blob)
        throw new Error(`License integrity mismatch: ${source}`);
      await writeFile(target, bytes);
    }
    sources.push({
      name,
      source,
      gitBlob: blob,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  for (const name of ["react", "react-dom", "scheduler", "lucide-react"]) {
    const metadata = JSON.parse(
      await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
    );
    const bytes = await readFile(join(root, "node_modules", name, "LICENSE"));
    const filename = `${name}-LICENSE.txt`;
    await writeFile(join(directory, filename), bytes);
    sources.push({
      name: filename,
      package: name,
      version: metadata.version,
      source: `Installed npm package ${name}@${metadata.version}/LICENSE`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const ccSwitchLicense = await readFile(
    join(root, "docs", "CC-Switch-MIT.txt"),
  );
  await writeFile(join(directory, "CC-Switch-MIT.txt"), ccSwitchLicense);
  sources.push({
    name: "CC-Switch-MIT.txt",
    package: "cc-switch (theme reference)",
    version: "3.20.4",
    source:
      "https://github.com/farion1231/cc-switch/blob/1ee2fdc3a791f1e73476c631c7ab7ce8fac0638f/LICENSE",
    sha256: createHash("sha256").update(ccSwitchLicense).digest("hex"),
  });
  await writeFile(
    join(directory, "sources.json"),
    JSON.stringify(sources, null, 2),
  );
  return directory;
}
