/**
 * Detect private-security job listings (özel güvenlik iş ilanı).
 * Normal chat is rejected. Fields (salary/phone/etc.) are optional — ads vary.
 * Duplicate skip is handled elsewhere: only exact same content.
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
    /\d[\d.\s]{2,}\s*tl\b/.test(n) ||
    (/\btl\b/.test(n) && /\d{4,}/.test(n)) ||
    /\byemek\b/.test(n) ||
    /\bsetkart\b/.test(n) ||
    /\bnakit\b/.test(n)
  );
}

function hasSecurityTerm(n: string): boolean {
  return (
    /ozel\s*guvenlik/.test(n) ||
    /guvenlik\s*gorevlis/.test(n) ||
    /guvenlik\s*personel/.test(n) ||
    /guvenlik\s*alim/.test(n) ||
    /\bogu\b/.test(n) ||
    // bare "güvenlik" + hiring context is handled below with extra checks
    false
  );
}

function hasHiringOrListingShape(n: string): boolean {
  return (
    /\balim[iı]?\b/.test(n) ||
    /\baliniyor\b/.test(n) ||
    /\baraniyor\b/.test(n) ||
    /\bariyoruz\b/.test(n) ||
    /\bbasvuru\b/.test(n) ||
    /\birtibat\b/.test(n) ||
    /\bis\s*ilani\b/.test(n) ||
    /\bise\s*alim\b/.test(n) ||
    /\bcalisma\s*sekli\b/.test(n) ||
    /\bprojesine\b/.test(n) ||
    /\bsite\b/.test(n) ||
    /\bvardiya\b/.test(n) ||
    /\bgunduz\b/.test(n) ||
    /\bgece\b/.test(n) ||
    /\bkimlikli\b/.test(n) ||
    /\byas\s*arasi\b/.test(n) ||
    /\bcv\b/.test(n) ||
    /\bekran\s*goruntusu\b/.test(n) ||
    /\bwhatsapp\b/.test(n) ||
    /\bwatsapp\b/.test(n)
  );
}

function looksLikePlainChat(n: string, len: number): boolean {
  if (len > 120) return false;
  return /^(selam|slm|merhaba|nbr|naber|iyi\s*gunler|gunaydin|iyi\s*aksamlar|tesekkur|sagol|ok|tamam|eyw)\b/.test(
    n,
  );
}

/**
 * True for özel güvenlik job ads. Phone/name/salary may repeat across ads —
 * that alone must NOT reject. Only exact full-text duplicate is handled outside.
 */
export function isPrivateSecurityJobListing(raw: string): boolean {
  const text = raw?.trim() ?? "";
  if (text.length < 30) return false;

  const n = foldTr(text);

  if (looksLikePlainChat(n, text.length)) return false;

  const security = hasSecurityTerm(n);
  // Also allow "güvenlik görevlisi / alımı" without "özel" sometimes
  const looseSecurity =
    security ||
    (/\bguvenlik\b/.test(n) &&
      (/\bgorevlis/.test(n) || /\balim/.test(n) || /\bpersonel/.test(n)));

  if (!looseSecurity) return false;

  const hiring = hasHiringOrListingShape(n);
  const salary = hasSalarySignal(n);
  const phone = hasPhoneNumber(text);

  // Strong sample-like phrase
  if (
    /ozel\s*guvenlik\s*gorevlis.{0,40}alim/.test(n) ||
    /ozel\s*guvenlik.{0,40}alim/.test(n)
  ) {
    return true;
  }

  // Security + any listing signal (salary OR phone OR hiring shape)
  if (hiring || salary || phone) return true;

  // Longer posts that clearly mention özel güvenlik (ad body without clear phone parse)
  if (security && text.length >= 100) return true;

  return false;
}
