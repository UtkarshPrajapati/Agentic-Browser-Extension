// Placeholder JSON schema utils
export function stringify(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

