/**
 * Detect private-security job listings (özel güvenlik iş ilanı).
 * Normal chat is rejected. Not all fields are required — example posts vary.
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
  // 05xxxxxxxxx or 905xxxxxxxxx
  if (/0?5\d{9}/.test(digits)) return true;
  if (/90?5\d{9}/.test(digits)) return true;
  // spaced / dashed mobile patterns in original text
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
    /\btl\b/.test(n) && /\d{4,}/.test(n)
  );
}

function hasSecurityTerm(n: string): boolean {
  return (
    /ozel\s*guvenlik/.test(n) ||
    /guvenlik\s*gorevlis/.test(n) ||
    /guvenlik\s*personel/.test(n) ||
    /\bogu\b/.test(n) || // common abbreviation
    /guvenlik\s*alim/.test(n)
  );
}

function hasHiringIntent(n: string): boolean {
  return (
    /\balim[iı]?\b/.test(n) ||
    /\baliniyor\b/.test(n) ||
    /\baraniyor\b/.test(n) ||
    /\bariyoruz\b/.test(n) ||
    /\bbasvuru\b/.test(n) ||
    /\birtibat\b/.test(n) ||
    /\bis\s*ilani\b/.test(n) ||
    /\bise\s*alim\b/.test(n) ||
    /\bcv\b/.test(n) ||
    /\bcalisma\s*sekli\b/.test(n) ||
    /\bprojesine\b/.test(n)
  );
}

/**
 * Returns true only for özel güvenlik job ads.
 * Example-like posts with "ÖZEL GÜVENLİK GÖREVLİSİ ALIMI" pass even if some fields missing.
 */
export function isPrivateSecurityJobListing(raw: string): boolean {
  const text = raw?.trim() ?? "";
  if (text.length < 40) return false; // too short for a real listing

  const n = foldTr(text);

  if (!hasSecurityTerm(n)) return false;

  // Strong phrase match (like the sample ad)
  const strongPhrase =
    /ozel\s*guvenlik\s*gorevlis.{0,20}alim/.test(n) ||
    /ozel\s*guvenlik.{0,30}alim/.test(n) ||
    /guvenlik\s*gorevlis.{0,20}alim/.test(n);

  const hiring = hasHiringIntent(n);
  const salary = hasSalarySignal(n);
  const phone = hasPhoneNumber(text);

  if (strongPhrase && (salary || phone || hiring)) return true;

  // Flexible: security + hiring + (salary or phone)
  if (hiring && (salary || phone)) return true;

  // Security + both salary and phone without explicit "alım" (some posts omit the word)
  if (salary && phone) return true;

  return false;
}
