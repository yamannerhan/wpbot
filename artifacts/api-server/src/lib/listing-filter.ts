/**
 * Loose detector for özel güvenlik job listings.
 * Prefer catching ads over missing them. Exact-text duplicates handled elsewhere.
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

function hasPhoneNumber(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 10 && /0?5\d{9}/.test(digits)) return true;
  if (/90?5\d{9}/.test(digits)) return true;
  return /(?:\+?90|0)?\s*5\d{2}[\s.\-]?\d{3}[\s.\-]?\d{2}[\s.\-]?\d{2}/.test(
    text,
  );
}

function hasSecurityTerm(n: string): boolean {
  return (
    /\bguvenlik\b/.test(n) ||
    /ozel\s*guv/.test(n) ||
    /\bogu\b/.test(n) ||
    /\bog\s*kimlik/.test(n) ||
    /\bgorevlis/.test(n)
  );
}

function hasJobSignal(n: string): boolean {
  return (
    /\balim/.test(n) ||
    /\baliniyor\b/.test(n) ||
    /\baraniyor\b/.test(n) ||
    /\bariyoruz\b/.test(n) ||
    /\bbekleniyor\b/.test(n) ||
    /\bbasvuru\b/.test(n) ||
    /\birtibat\b/.test(n) ||
    /\biletisim\b/.test(n) ||
    /\bis\s*ilan/.test(n) ||
    /\bise\s*alim\b/.test(n) ||
    /\bmaas\b/.test(n) ||
    /\bhakedis\b/.test(n) ||
    /\ducret\b/.test(n) ||
    /\bimkanlar\b/.test(n) ||
    /\btl\b/.test(n) ||
    /\bvardiya\b/.test(n) ||
    /\bgunduz\b/.test(n) ||
    /\bgece\b/.test(n) ||
    /\bproje\b/.test(n) ||
    /\bsite\b/.test(n) ||
    /\bkadro\b/.test(n) ||
    /\bkimlikli\b/.test(n) ||
    /\byas\b/.test(n) ||
    /\beleman\b/.test(n) ||
    /\bpersonel\b/.test(n) ||
    /\bcv\b/.test(n) ||
    /\bwhatsapp\b/.test(n) ||
    /\bwatsapp\b/.test(n) ||
    /\bwp\b/.test(n) ||
    /\byemek\b/.test(n) ||
    /\bnakit\b/.test(n) ||
    /\bsetkart\b/.test(n)
  );
}

function looksLikePlainChat(n: string, len: number): boolean {
  if (len > 100) return false;
  return /^(selam|slm|merhaba|nbr|naber|iyi\s*gunler|gunaydin|iyi\s*aksamlar|tesekkur|sagol|ok|tamam|eyw|evet|hayir|as|sa)\b/.test(
    n,
  );
}

/**
 * Accept generously. Same phone/name/salary across ads is OK —
 * only exact full text is deduped outside.
 */
export function isPrivateSecurityJobListing(raw: string): boolean {
  const text = raw?.trim() ?? "";
  if (text.length < 18) return false;

  const n = foldTr(text);
  if (looksLikePlainChat(n, text.length)) return false;

  const security = hasSecurityTerm(n);
  const job = hasJobSignal(n);
  const phone = hasPhoneNumber(text);
  const lines = text.split(/\n/).filter((l) => l.trim()).length;
  const multiline = lines >= 2;

  // Güvenlik / OG geçiyorsa: neredeyse her ilan metnini al
  if (security) {
    if (job || phone || multiline || text.length >= 35) return true;
    return /guvenlik|ogu|ozel\s*guv|gorevlis/.test(n);
  }

  // Kanallarda bazen "güvenlik" yazılmaz — telefon + iş sinyali yeter
  if (phone && job) return true;
  if (phone && multiline && text.length >= 40) return true;
  if (job && multiline && text.length >= 55) return true;

  return false;
}
