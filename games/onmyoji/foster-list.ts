export type FosterRow = { name: string; y: number };

/** OCR returns rows in varying order and jitters by a few pixels on a static list. */
export function sameFosterPage(previous: FosterRow[], current: FosterRow[]) {
  if (!current.length || previous.length !== current.length) return false;
  const before = [...previous].sort((a, b) => a.y - b.y);
  const after = [...current].sort((a, b) => a.y - b.y);
  if (new Set(after.map((row) => row.name)).size !== after.length) return false;
  return before.every(
    (row, index) =>
      row.name === after[index].name && Math.abs(row.y - after[index].y) <= 12,
  );
}
