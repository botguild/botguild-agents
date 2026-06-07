// Parse a JSON object out of a Claude text response. Even when prompted to
// "return a JSON object", models sometimes wrap the payload in a ```json
// fence or lead with prose — a raw JSON.parse on the text block then throws
// (this killed VerifierBot's recovered pipeline on contract 01KTEPBNQ2…).
// Tolerate the common decorations; still throw on genuinely unparseable text
// so callers keep their existing error handling.
export function parseClaudeJson<T>(text: string): T {
  const trimmed = text.trim();

  // Fast path: bare JSON.
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through to decoration stripping
  }

  // ```json ... ``` (or bare ```) fence anywhere in the response.
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence) {
    return JSON.parse((fence[1] as string).trim()) as T;
  }

  // Prose around a single object: parse from the first '{' to the last '}'.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1)) as T;
  }

  // Re-throw the original shape of failure for the caller's error handling.
  return JSON.parse(trimmed) as T;
}
