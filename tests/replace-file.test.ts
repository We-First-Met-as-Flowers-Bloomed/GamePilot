import { expect, it, vi, beforeEach } from "vitest";
const fs = vi.hoisted(() => ({
  rename: vi.fn(),
  copyFile: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock("node:fs/promises", () => fs);
const pause = vi.hoisted(() => vi.fn());
vi.mock("node:timers/promises", () => ({ setTimeout: pause }));
import { replaceFile } from "../apps/desktop/main/replace-file";
beforeEach(() => {
  vi.resetAllMocks();
});
it("prefers atomic rename", async () => {
  await replaceFile("a", "b");
  expect(fs.rename).toHaveBeenCalledWith("a", "b");
  expect(fs.copyFile).not.toHaveBeenCalled();
});
it("handles EFS EXDEV and removes temp only after successful copy", async () => {
  fs.rename.mockRejectedValue({ code: "EXDEV" });
  await replaceFile("a", "b");
  expect(fs.copyFile).toHaveBeenCalledWith("a", "b");
  expect(fs.unlink).toHaveBeenCalledWith("a");
});
it("does not hide permission errors or remove failed copies", async () => {
  fs.rename.mockRejectedValue({ code: "EACCES" });
  await expect(replaceFile("a", "b")).rejects.toMatchObject({ code: "EACCES" });
  expect(fs.copyFile).not.toHaveBeenCalled();
  fs.rename.mockRejectedValue({ code: "EXDEV" });
  fs.copyFile.mockRejectedValue(new Error("disk full"));
  await expect(replaceFile("a", "b")).rejects.toThrow("disk full");
  expect(fs.unlink).not.toHaveBeenCalled();
});

it.each(["EPERM", "EACCES", "EBUSY"])(
  "retries a briefly locked destination (%s) without copying over it",
  async (code) => {
    fs.rename.mockRejectedValueOnce({ code }).mockRejectedValueOnce({ code });
    await replaceFile("a", "b");
    expect(fs.rename).toHaveBeenCalledTimes(3);
    expect(pause.mock.calls).toEqual([[100], [300]]);
    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  },
);

it("preserves both paths and reports persistent locking after two retries", async () => {
  const error = Object.assign(new Error("still locked"), { code: "EPERM" });
  fs.rename.mockRejectedValue(error);
  await expect(replaceFile("a", "b")).rejects.toBe(error);
  expect(fs.rename).toHaveBeenCalledTimes(3);
  expect(pause).toHaveBeenCalledTimes(2);
  expect(fs.copyFile).not.toHaveBeenCalled();
  expect(fs.unlink).not.toHaveBeenCalled();
});

it("does not retry a missing source", async () => {
  fs.rename.mockRejectedValue({ code: "ENOENT" });
  await expect(replaceFile("a", "b")).rejects.toMatchObject({ code: "ENOENT" });
  expect(fs.rename).toHaveBeenCalledTimes(1);
  expect(pause).not.toHaveBeenCalled();
});
