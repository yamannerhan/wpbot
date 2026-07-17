import sharp from "sharp";
import { createWorker, type Worker } from "tesseract.js";
import { logger } from "./logger.js";

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<void> = Promise.resolve();

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(["tur", "eng"], 1, {
        logger: () => undefined,
      });
      logger.info("OCR worker ready (tur+eng)");
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
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}

async function preprocessForOcr(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .rotate()
    .resize({
      width: 2000,
      height: 2000,
      fit: "inside",
      withoutEnlargement: false,
    })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.2 })
    .png()
    .toBuffer();
}

/**
 * Extract text from an image buffer (Turkish + English).
 * Serialized queue so one worker stays stable under load.
 */
export function extractTextFromImage(image: Buffer): Promise<string> {
  const run = async (): Promise<string> => {
    if (!image?.length) return "";
    try {
      const prepared = await preprocessForOcr(image);
      const worker = await getWorker();
      const result = await Promise.race([
        worker.recognize(prepared),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("OCR timeout")), 45_000),
        ),
      ]);
      return cleanOcrText(result.data.text || "");
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
