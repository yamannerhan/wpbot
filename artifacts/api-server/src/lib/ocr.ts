import sharp from "sharp";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { logger } from "./logger.js";

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<void> = Promise.resolve();

const OCR_TIMEOUT_MS = 60_000;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(["tur", "eng"], OEM.LSTM_ONLY, {
        logger: () => undefined,
      });
      await worker.setParameters({
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
        tessedit_pageseg_mode: PSM.AUTO,
      });
      logger.info("OCR worker ready (LSTM tur+eng)");
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

/** Fast, strong preprocess — upscale + contrast for WhatsApp listing photos. */
async function prepareImage(image: Buffer): Promise<Buffer> {
  const meta = await sharp(image).rotate().metadata();
  const w = meta.width || 800;
  const h = meta.height || 800;
  const longEdge = Math.max(w, h);
  const target = 2400;
  const scale = longEdge < target ? target / longEdge : 1;
  const outW = Math.round(w * scale);
  const outH = Math.round(h * scale);

  return sharp(image)
    .rotate()
    .resize({
      width: outW,
      height: outH,
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .grayscale()
    .normalize()
    .modulate({ brightness: 1.1 })
    .linear(1.4, -(128 * 0.4))
    .sharpen({ sigma: 1.5 })
    .png()
    .toBuffer();
}

/**
 * Extract Turkish/English text from an image buffer.
 */
export function extractTextFromImage(image: Buffer): Promise<string> {
  const run = async (): Promise<string> => {
    if (!image?.length) return "";
    try {
      const prepared = await prepareImage(image);
      const worker = await getWorker();
      const result = await Promise.race([
        worker.recognize(prepared),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("OCR timeout")), OCR_TIMEOUT_MS),
        ),
      ]);
      const cleaned = cleanOcrText(result.data.text || "");
      logger.info(
        { chars: cleaned.length, bytes: image.length },
        cleaned ? "OCR ok" : "OCR empty",
      );
      return cleaned;
    } catch (err) {
      logger.warn({ err }, "OCR failed");
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
