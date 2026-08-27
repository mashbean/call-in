import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);
const outputDirectory = new URL("public/vendor/pdfjs/", projectRoot);
const files = ["pdf.mjs", "pdf.worker.mjs"];

await mkdir(fileURLToPath(outputDirectory), { recursive: true });
await Promise.all(
  files.map((filename) =>
    copyFile(
      fileURLToPath(new URL(`node_modules/pdfjs-dist/build/${filename}`, projectRoot)),
      fileURLToPath(new URL(filename, outputDirectory)),
    ),
  ),
);
