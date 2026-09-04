// Downloads the yt-dlp and ffmpeg sidecar binaries that Tauri bundles with
// the app. These are too large (and change too often, in yt-dlp's case) to
// commit to git, so every fresh clone needs to run this once before `tauri dev`.
//
// Windows-only for now, matching the rest of the app.

import { execSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BINARIES_DIR = path.join(__dirname, "..", "src-tauri", "binaries");
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";

const YT_DLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_ZIP_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

async function download(url, destPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  await pipeline(res.body, createWriteStream(destPath));
}

async function setupYtDlp() {
  const dest = path.join(BINARIES_DIR, `yt-dlp-${TARGET_TRIPLE}.exe`);
  console.log("Downloading yt-dlp.exe...");
  await download(YT_DLP_URL, dest);
  console.log(`  -> ${dest}`);
}

async function setupFfmpeg() {
  const dest = path.join(BINARIES_DIR, `ffmpeg-${TARGET_TRIPLE}.exe`);
  const zipPath = path.join(BINARIES_DIR, "_ffmpeg.zip");
  const extractDir = path.join(BINARIES_DIR, "_ffmpeg_extract");

  console.log("Downloading ffmpeg (essentials build)...");
  await download(FFMPEG_ZIP_URL, zipPath);

  console.log("Extracting ffmpeg.exe...");
  rmSync(extractDir, { recursive: true, force: true });
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
    { stdio: "inherit" },
  );

  const rootEntry = readdirSync(extractDir).find((name) => name.startsWith("ffmpeg-"));
  if (!rootEntry) throw new Error("Could not find extracted ffmpeg folder");
  const extractedExe = path.join(extractDir, rootEntry, "bin", "ffmpeg.exe");

  renameSync(extractedExe, dest);
  rmSync(zipPath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  console.log(`  -> ${dest}`);
}

async function main() {
  mkdirSync(BINARIES_DIR, { recursive: true });

  const ytDlpDest = path.join(BINARIES_DIR, `yt-dlp-${TARGET_TRIPLE}.exe`);
  const ffmpegDest = path.join(BINARIES_DIR, `ffmpeg-${TARGET_TRIPLE}.exe`);

  if (existsSync(ytDlpDest)) {
    console.log("yt-dlp.exe already present, skipping (delete it to re-fetch).");
  } else {
    await setupYtDlp();
  }

  if (existsSync(ffmpegDest)) {
    console.log("ffmpeg.exe already present, skipping (delete it to re-fetch).");
  } else {
    await setupFfmpeg();
  }

  console.log("\nDone. You can now run: npm run tauri dev");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
