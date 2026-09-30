/**
 * Helpers that keep credentials out of logs and committed report files.
 * RPC URLs from providers such as Alchemy or Infura embed the API key in the path,
 * so reports only ever record the host.
 */
export function redactRpcUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "<redacted>";
  }
}
