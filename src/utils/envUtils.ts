export function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return value !== "0" && value.toLowerCase() !== "false" && value.toLowerCase() !== "no";
}
