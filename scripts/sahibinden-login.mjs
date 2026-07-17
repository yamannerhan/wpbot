/**
 * Sahibinden tek seferlik Google girişi.
 * Chrome açılır → sen Google ile giriş yaparsın → oturum Railway'e kaydedilir →
 * sonrası sunucuda Chromium otomatik ilan çeker (ekranında bir şey açılmaz).
 *
 * PowerShell:
 *   $env:SAHIBINDEN_API="https://wphot-production-cf99.up.railway.app"
 *   pnpm sahibinden:login
 *
 * veya çift tık: Sahibinden-Giris.cmd
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "sahibinden.config.json");
const PROFILE_DIR = path.join(__dirname, ".sahibinden-login-profile");

const LOGIN_URL =
  "https://secure.sahibinden.com/giris?return_url=https%3A%2F%2Fwww.sahibinden.com%2Fkoruma-guvenlik-guvenlik-gorevlisi-is-ilanlari";
const LISTINGS_URL =
  "https://www.sahibinden.com/koruma-guvenlik-guvenlik-gorevlisi-is-ilanlari";

function loadApi() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* ignore */
  }
  return (
    process.env.SAHIBINDEN_API?.replace(/\/$/, "") ||
    file.api?.replace(/\/$/, "") ||
    "https://wphot-production-cf99.up.railway.app"
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isStillLogin(url) {
  return /\/giris|secure\.sahibinden\.com\/giris/i.test(url || "");
}

async function main() {
  const api = loadApi();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log("");
  console.log("=== Sahibinden Google Giriş ===");
  console.log("1) Açılan Chrome penceresinde Google ile giriş yap");
  console.log("2) Giriş bitince bu script oturumu Railway'e kaydedecek");
  console.log(`API: ${api}`);
  console.log("");

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1280, height: 900 },
    });
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  console.log("Giriş sayfası açıldı. Google ile giriş yap...");

  const deadline = Date.now() + 10 * 60 * 1000; // 10 dk
  let loggedIn = false;

  while (Date.now() < deadline) {
    await sleep(2000);
    const url = page.url();
    if (!isStillLogin(url)) {
      // Ana siteye düştü mü?
      if (/sahibinden\.com/i.test(url) && !isStillLogin(url)) {
        loggedIn = true;
        break;
      }
    }
    // Bazen login sonrası return_url'e gider
    const cookies = await context.cookies();
    const hasSession = cookies.some((c) =>
      /sid|session|auth|token|remember|login/i.test(c.name),
    );
    if (hasSession && !isStillLogin(url) && /www\.sahibinden\.com/i.test(url)) {
      loggedIn = true;
      break;
    }
    process.stdout.write(".");
  }
  console.log("");

  if (!loggedIn) {
    // Son çare: ilan sayfasına git, hâlâ giris değilse OK
    await page.goto(LISTINGS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await sleep(3000);
    if (isStillLogin(page.url())) {
      console.error("Giriş tamamlanmadı (10 dk veya hâlâ giriş sayfası). Tekrar dene.");
      await context.close();
      process.exit(1);
    }
  }

  // İlan sayfasını doğrula
  await page.goto(LISTINGS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await sleep(2500);
  if (isStillLogin(page.url())) {
    console.error("Giriş var gibi ama ilan sayfası açılmadı. Tekrar Google ile giriş dene.");
    await context.close();
    process.exit(1);
  }

  const allCookies = await context.cookies();
  const shb = allCookies.filter((c) =>
    /sahibinden\.com$/i.test(c.domain.replace(/^\./, "")) ||
    c.domain.includes("sahibinden.com"),
  );

  const cookieHeader = shb.map((c) => `${c.name}=${c.value}`).join("; ");
  console.log(`${shb.length} cookie alındı, Railway'e kaydediliyor...`);

  const res = await fetch(`${api}/api/sahibinden/cookies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cookies: cookieHeader,
      cookieList: shb,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Cookie kayıt hatası:", data);
    await context.close();
    process.exit(1);
  }
  console.log("Oturum kaydedildi:", data.loggedIn ? "OK (girişli)" : data);
  console.log(data.message || "Railway otomatik taramayı başlattı.");

  await context.close();
  console.log("");
  console.log("Bitti. Bundan sonra Railway 30 dk'da bir otomatik çekecek.");
  console.log("Bu pencereyi kapatabilirsin — tarama sunucuda devam eder.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
