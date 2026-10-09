/** Absolute drive or UNC paths only; no host filesystem access or cwd guessing. */
export function normalizeAbsoluteWindowsPath(value: string): string {
  const path = value.replace(/\//g, "\\");
  const drive = /^([A-Za-z]:)\\+/.exec(path);
  const unc = /^\\\\+([^\\]+)\\+([^\\]+)(?:\\+|$)/.exec(path);
  if (!drive && !unc)
    throw Error("An absolute Windows device path is required");
  const root = drive
    ? drive[1] + "\\"
    : "\\\\" + unc![1] + "\\" + unc![2] + "\\";
  const tail = path.slice((drive ?? unc)![0].length);
  const segments: string[] = [];
  for (const segment of tail.split(/\\+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return (
    root +
    segments.join("\\") +
    (segments.length && path.endsWith("\\") ? "\\" : "")
  );
}
