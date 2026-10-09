import { rename, copyFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
// Windows EFS can report EXDEV even for two paths in the same directory.
// Callers serialize access and reject malformed JSON after an interrupted copy.
export async function replaceFile(
  source: string,
  target: string,
  options: { atomicOnly?: boolean } = {},
) {
  const waits = [100, 300];
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Readers/antivirus can briefly prevent replacement on Windows. Keep
      // the original intact; persistent permission failures still stop writes.
      if (
        ["EPERM", "EACCES", "EBUSY"].includes(code ?? "") &&
        attempt < waits.length
      ) {
        await delay(waits[attempt]);
        continue;
      }
      if (code !== "EXDEV" || options.atomicOnly) throw error;
      await copyFile(source, target);
      await unlink(source);
      return;
    }
  }
}
