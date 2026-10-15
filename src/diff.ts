// Minimal line diff (LCS) for showing score / lyrics changes.
export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.replace(/\r\n/g, "\n").split("\n");
  const B = b.replace(/\r\n/g, "\n").split("\n");
  const n = A.length;
  const m = B.length;
  // LCS table (bounded for very long inputs)
  if (n * m > 4_000_000) {
    return [...A.map((t) => ({ kind: "del" as const, text: t })), ...B.map((t) => ({ kind: "add" as const, text: t }))];
  }
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: "same", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: A[i] });
      i++;
    } else {
      out.push({ kind: "add", text: B[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: A[i++] });
  while (j < m) out.push({ kind: "add", text: B[j++] });
  return out;
}

export function diffStats(d: DiffLine[]): { added: number; removed: number } {
  return { added: d.filter((x) => x.kind === "add").length, removed: d.filter((x) => x.kind === "del").length };
}
