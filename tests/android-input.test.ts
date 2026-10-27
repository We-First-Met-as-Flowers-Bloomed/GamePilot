import { expect, it } from "vitest";
import { pressAndroidBack } from "../packages/runtime/android-capture";
import { displayDump, displayWindow } from "./android-capture-fixture";
const device = {name:"MuMu", adbPath:"adb.exe", address:"127.0.0.1:16384"};

it("sends back to the verified foreground logical display", async () => {
  const calls: string[][] = [];
  await pressAndroidBack(device, "com.example.game", new AbortController().signal, async (_file, args) => {
    calls.push(args);
    if (args.includes("window")) return Buffer.from(displayWindow);
    if (args.includes("display")) return Buffer.from(displayDump);
    return Buffer.alloc(0);
  });
  expect(calls.at(-1)).toEqual(["-s",device.address,"shell","input","-d","2","keyevent","4"]);
  expect(calls.filter((args)=>args.includes("input"))).toHaveLength(1);
});

it("does not send input to another foreground app or after cancellation", async () => {
  const calls: string[][]=[];
  const run = async (_file:string,args:string[]) => {
    calls.push(args);
    return Buffer.from(args.includes("window") ? displayWindow : displayDump);
  };
  await expect(pressAndroidBack(device,"com.other.game",new AbortController().signal,run)).rejects.toThrow(/前台|foreground/);
  const stop=new AbortController(); stop.abort();
  await expect(pressAndroidBack(device,"com.example.game",stop.signal,run)).rejects.toThrow();
  expect(calls.some((args)=>args.includes("input"))).toBe(false);
});
