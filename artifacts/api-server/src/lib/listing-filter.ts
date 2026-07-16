/**
 * Very loose listing filter — prefer catching ads over missing them.
 * Exact full-text duplicates are handled outside this function.
 */

function foldTr(text: string): string {
  return text
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .replace(/ş/g, "s")
    .replace(/Ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/Ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/Ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/Ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/Ç/g, "c");
}

function looksLikePlainChat(n: string, len: number): boolean {
  if (len > 80) return false;
  return /^(selam|slm|merhaba|nbr|naber|iyi\s*gunler|gunaydin|iyi\s*aksamlar|tesekkur|sagol|ok|tamam|eyw|evet|hayir|as|sa|hmm+|alo)\b/.test(
    n,
  );
}

/**
 * Accept almost all non-trivial messages from selected groups/channels.
 * Only skips tiny greetings / empty noise.
 */
export function isPrivateSecurityJobListing(raw: string): boolean {
  const text = raw?.trim() ?? "";
  if (text.length < 12) return false;

  const n = foldTr(text);
  if (looksLikePlainChat(n, text.length)) return false;

  // Anything with a bit of body is kept (ilan + kanal postları)
  return true;
}
