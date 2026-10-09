import { open } from "node:fs/promises";

/** Bounded even if the file grows between stat and read. */
export async function boundedRead(file: string, max = 1024 * 1024) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw Error("invalid file");
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > max) throw Error("oversized");
    return buffer.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
}
