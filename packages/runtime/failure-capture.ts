import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateDevice, type Device } from "../protocol";
import type { FailureCapture } from "../protocol/fault";
import { captureAndroidDisplay } from "./android-capture";
type CaptureCommand = (
  file: string,
  args: string[],
  signal: AbortSignal,
) => Promise<Buffer>;
const capture: CaptureCommand = async (file, args, signal) =>
  (
    await promisify(execFile)(file, args, {
      encoding: "buffer",
      windowsHide: true,
      timeout: 4500,
      maxBuffer: 8 * 1024 * 1024,
      signal,
    })
  ).stdout;
/** Only called with the worker's current device while Runner owns its execution lock. */
export async function captureFailureImage(
  directory: string,
  device: Device | undefined,
  signal: AbortSignal,
  run: CaptureCommand = capture,
): Promise<FailureCapture> {
  try {
    signal.throwIfAborted();
    if (!device) return { status: "not-attempted" };
    const checked = validateDevice(device),
      folder = join(directory, "failure-evidence");
    await mkdir(folder, { recursive: true });
    const info = await lstat(folder);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await readdir(folder)).length >= 32
    )
      throw Error("capture storage unavailable");
    signal.throwIfAborted();
    const {image: png} = await captureAndroidDisplay(checked, (file, args) => {
      signal.throwIfAborted();
      return run(file, args, signal);
    }, 8 * 1024 * 1024);
    signal.throwIfAborted();
    if (
      png.length < 45 ||
      png.length > 8 * 1024 * 1024 ||
      !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
      png.toString("ascii", 12, 16) !== "IHDR" ||
      png.toString("ascii", png.length - 8, png.length - 4) !== "IEND"
    )
      throw Error("invalid image");
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20);
    if (!width || !height || width > 16384 || height > 16384)
      throw Error("invalid dimensions");
    const key = `${randomUUID()}.png`;
    const capturedAt = new Date().toISOString();
    await writeFile(join(folder, key), png, { flag: "wx", signal });
    return {
      status: "stored",
      key,
      sha256: createHash("sha256").update(png).digest("hex"),
      bytes: png.length,
      width,
      height,
      capturedAt,
    };
  } catch {
    return { status: "unavailable" };
  }
}
