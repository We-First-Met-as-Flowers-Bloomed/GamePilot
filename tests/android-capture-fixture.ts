/** Minimal OS dumps for transport tests; game/account verification remains outside this fixture. */
export const physicalDisplay = "4619827767814508545";
export const displayWindow = "Display: mDisplayId=2\n mCurrentFocus=Window{abc u0 com.example.game/.Main}\nmTopFocusedDisplayId=2";
export const displayDump = `mViewports=[DisplayViewport{type=INTERNAL, valid=true, isActive=true, displayId=2, uniqueId='local:${physicalDisplay}', deviceWidth=1, deviceHeight=1}]`;

export function withDisplayQueries<T extends (file: string, args: string[], ...rest: any[]) => Promise<Buffer>>(capture: T): T {
  return ((file: string, args: string[], ...rest: any[]) => {
    if (args.includes("window")) return Promise.resolve(Buffer.from(displayWindow));
    if (args.includes("display")) return Promise.resolve(Buffer.from(displayDump));
    return capture(file, args, ...rest);
  }) as T;
}
