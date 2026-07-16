/**
 * Detect private-security job listings (özel güvenlik iş ilanı).
 * Normal chat is rejected. Duplicate skip is handled elsewhere: exact full text only.
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
  if (/0?5\d{9}/.test(digits)) return true;
  if (/90?5\d{9}/.test(digits)) return true;
  return /(?:\+?90|0)?\s*5\d{2}[\s.\-]?\d{3}[\s.\-]?\d{2}[\s.\-]?\d{2}/.test(
    text,
  );
}

function hasSalarySignal(n: string): boolean {
  return (
    /\bmaas\b/.test(n) ||
    /\bhakedis\b/.test(n) ||
    /\bimkanlar\b/.test(n) ||
    /\ducret\b/.test(n) ||
    /\d[\d.\s]{2,}\s*tl\b/.test(n) ||
    (/\btl\b/.test(n) && /\d{4,}/.test(n)) ||
    /\byemek\b/.test(n) ||
    /\bsetkart\b/.test(n) ||
    /\bnakit\b/.test(n) ||
    /\byol\s*parasi\b/.test(n) ||
    /\bagirlamak\b/.test(n)
  );
}

function hasSecurityTerm(n: string): boolean {
  return (
    /\bguvenlik\b/.test(n) ||
    /ozel\s*guv/.test(n) ||
    /\bogu\b/.test(n) ||
    /\bog\b/.test(n)
  );
}

function hasHiringOrListingShape(n: string): boolean {
  return (
    /\balim[iı]?\b/.test(n) ||
    /\baliniyor\b/.test(n) ||
    /\baraniyor\b/.test(n) ||
    /\bariyoruz\b/.test(n) ||
    /\bbekleniyor\b/.test(n) ||
    /\bbasvuru\b/.test(n) ||
    /\birtibat\b/.test(n) ||
    /\biletisim\b/.test(n) ||
    /\bis\s*ilani\b/.test(n) ||
    /\bise\s*alim\b/.test(n) ||
    /\bcalisma\s*sekli\b/.test(n) ||
    /\bprojesine\b/.test(n) ||
    /\bproje\b/.test(n) ||
    /\bsite\b/.test(n) ||
    /\bvardiya\b/.test(n) ||
    /\bgunduz\b/.test(n) ||
    /\bgece\b/.test(n) ||
    /\bkimlikli\b/.test(n) ||
    /\byas\s*arasi\b/.test(n) ||
    /\beleman\b/.test(n) ||
    /\bpersonel\b/.test(n) ||
    /\bgorevlis/.test(n) ||
    /\bkadro\b/.test(n) ||
    /\bcv\b/.test(n) ||
    /\bekran\s*goruntusu\b/.test(n) ||
    /\bwhatsapp\b/.test(n) ||
    /\bwatsapp\b/.test(n) ||
    /\bwp\b/.test(n)
  );
}

function looksLikePlainChat(n: string, len: number): boolean {
  if (len > 140) return false;
  return /^(selam|slm|merhaba|nbr|naber|iyi\s*gunler|gunaydin|iyi\s*aksamlar|tesekkur|sagol|ok|tamam|eyw|evet|hayir)\b/.test(
    n,
  );
}

function looksLikeAdBody(text: string, n: string): boolean {
  const lines = text.split(/\n/).filter((l) => l.trim().length > 0);
  if (lines.length >= 3 && text.length >= 60) return true;
  if (text.length >= 90 && /[:：•\-]/.test(text)) return true;
  if (text.length >= 120 && /\bguvenlik\b/.test(n)) return true;
  return false;
}

/**
 * True for özel güvenlik job ads. Phone/name/salary may repeat across ads —
 * that alone must NOT reject. Only exact full-text duplicate is handled outside.
 */
export function isPrivateSecurityJobListing(raw: string): boolean {
  const text = raw?.trim() ?? "";
  if (text.length < 25) return false;

  const n = foldTr(text);

  if (looksLikePlainChat(n, text.length)) return false;
  if (!hasSecurityTerm(n)) return false;

  // Classic: "özel güvenlik ... alım"
  if (
    /ozel\s*guvenlik.{0,60}alim/.test(n) ||
    /guvenlik\s*gorevlis.{0,40}alim/.test(n) ||
    /guvenlik.{0,40}araniyor/.test(n)
  ) {
    return true;
  }

  const hiring = hasHiringOrListingShape(n);
  const salary = hasSalarySignal(n);
  const phone = hasPhoneNumber(text);

  // Security + any listing signal
  if (hiring || salary || phone) return true;

  // Longer structured posts that mention güvenlik (phone parse may fail)
  if (looksLikeAdBody(text, n)) return true;

  return false;
}
