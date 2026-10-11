/** Remove Nessie `key` query values, bearer tokens and long digit runs (account numbers). */
export function redact(text: string): string {
  return text
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(?<![\w-])\d{12,19}(?![\w-])/g, "[REDACTED_NUMBER]");
}

type Level = "info" | "warn" | "error";

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test" && level === "info") return;
  const line = redact(JSON.stringify({ level, event, at: new Date().toISOString(), ...fields }));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
