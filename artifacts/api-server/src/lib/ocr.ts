import sharp from "sharp";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { logger } from "./logger.js";

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<void> = Promise.resolve();

const OCR_TIMEOUT_MS = 90_000;
/** Prefer results that look like job ads / Turkish listing text. */
const LISTING_HINT =
  /\b(guvenlik|güvenlik|maas|maaş|tl|basvuru|başvuru|alim|alım|vardiya|vardiya|telefon|iletisim|iletişim|proje|site|eleman|personel|irtibat|whatsapp|053|054|055|050)\b/i;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // LSTM engine — strongest modern model in Tesseract.js
      const worker = await createWorker(["tur", "eng"], OEM.LSTM_ONLY, {
        logger: () => undefined,
      });
      await worker.setParameters({
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
        tessedit_pageseg_mode: PSM.AUTO,
      });
      logger.info("Strong OCR worker ready (LSTM tur+eng, DPI 300)");
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function cleanOcrText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
    .filter((l) => l.length > 1)
    .join("\n")
    .trim();
}

function scoreResult(text: string, confidence: number): number {
  const cleaned = cleanOcrText(text);
  if (!cleaned) return 0;
  const len = cleaned.length;
  const lines = cleaned.split("\n").length;
  const hintBonus = LISTING_HINT.test(cleaned) ? 35 : 0;
  const digitBonus = /\d{3,}/.test(cleaned) ? 15 : 0;
  // Confidence 0–100; length rewards real paragraphs without preferring garbage
  return confidence * 1.2 + Math.min(len, 1200) * 0.08 + lines * 2 + hintBonus + digitBonus;
}

/**
 * Multi-pass preprocessing: high-res contrast, soft denoise, binarized.
 * Small WhatsApp screenshots are upscaled so Tesseract does not struggle.
 */
async function buildImageVariants(image: Buffer): Promise<Buffer[]> {
  const meta = await sharp(image).rotate().metadata();
  const w = meta.width || 800;
  const h = meta.height || 800;
  // Target ~2600px on long edge for phone screenshots / compressed WA images
  const longEdge = Math.max(w, h);
  const target = 2600;
  const scale = longEdge < target ? target / longEdge : Math.min(1.35, 3200 / longEdge);
  const outW = Math.round(w * scale);
  const outH = Math.round(h * scale);

  const base = sharp(image).rotate().resize({
    width: outW,
    height: outH,
    fit: "fill",
    kernel: sharp.kernel.lanczos3,
  });

  const [hiContrast, soft, binary, inverted] = await Promise.all([
    base
      .clone()
      .grayscale()
      .normalize()
      .modulate({ brightness: 1.08, saturation: 0 })
      .linear(1.35, -(128 * 0.35))
      .sharpen({ sigma: 1.6, m1: 1.2, m2: 0.7 })
      .png()
      .toBuffer(),
    base
      .clone()
      .grayscale()
      .normalize()
      .median(1)
      .sharpen({ sigma: 1.0 })
      .png()
      .toBuffer(),
    base
      .clone()
      .grayscale()
      .normalize()
      .threshold(145)
      .png()
      .toBuffer(),
    // Dark poster / black background ads
    base
      .clone()
      .grayscale()
      .normalize()
      .negate()
      .normalize()
      .sharpen({ sigma: 1.2 })
      .png()
      .toBuffer(),
  ]);

  return [hiContrast, soft, binary, inverted];
}

const PSM_PASSES = [PSM.AUTO, PSM.SINGLE_BLOCK, PSM.SPARSE_TEXT] as const;

async function recognizeBest(
  worker: Worker,
  variants: Buffer[],
): Promise<{ text: string; confidence: number }> {
  let best = { text: "", confidence: 0, score: 0 };

  for (const variant of variants) {
    for (const psm of PSM_PASSES) {
      try {
        await worker.setParameters({
          preserve_interword_spaces: "1",
          user_defined_dpi: "300",
          tessedit_pageseg_mode: psm,
        });
        const { data } = await worker.recognize(variant);
        const text = data.text || "";
        const confidence = Number(data.confidence) || 0;
        const sc = scoreResult(text, confidence);
        if (sc > best.score) {
          best = { text, confidence, score: sc };
        }
        // Early exit: already excellent
        if (confidence >= 78 && cleanOcrText(text).length >= 80) {
          return { text: best.text, confidence: best.confidence };
        }
      } catch {
        /* try next pass */
      }
    }
  }

  return { text: best.text, confidence: best.confidence };
}

/**
 * Strong OCR for Turkish listing images.
 * Upscale + multi preprocess + multi page-seg; pick highest scoring text.
 */
export function extractTextFromImage(image: Buffer): Promise<string> {
  const run = async (): Promise<string> => {
    if (!image?.length) return "";
    try {
      const variants = await buildImageVariants(image);
      const worker = await getWorker();
      const result = await Promise.race([
        recognizeBest(worker, variants),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("OCR timeout")), OCR_TIMEOUT_MS),
        ),
      ]);
      const cleaned = cleanOcrText(result.text);
      if (cleaned) {
        logger.info(
          { chars: cleaned.length, confidence: Math.round(result.confidence) },
          "OCR extracted image text",
        );
      }
      return cleaned;
    } catch (err) {
      logger.warn({ err }, "OCR failed for image");
      return "";
    }
  };

  const job = queue.then(run, run);
  queue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}
