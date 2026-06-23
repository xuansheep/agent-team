export function gte(version: string, minimum: string): boolean {
  return compareSemver(version, minimum) >= 0;
}

function compareSemver(left: string, right: string): number {
  const a = parseParts(left);
  const b = parseParts(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseParts(value: string): number[] {
  return value
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part.replace(/\D.*$/, ""), 10) || 0);
}
