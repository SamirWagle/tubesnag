// Downloads the yt-dlp and ffmpeg sidecar binaries that Tauri bundles with
// the app. These are too large (and change too often, in yt-dlp's case) to
// commit to git, so every fresh clone needs to run this once before `tauri dev`.
//
// Works on Windows, macOS, and Linux (x64 + arm64).

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BINARIES_DIR = path.join(__dirname, "..", "src-tauri", "binaries");

function targetTriple() {
  const { platform, arch } = process;
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
}

const TRIPLE = targetTriple();
const EXE_EXT = process.platform === "win32" ? ".exe" : "";

// yt-dlp doesn't ship a native Windows-on-ARM or universal build; the x64
// binaries run fine there (and on Apple Silicon, respectively) via emulation.
const YT_DLP_URLS = {
  win32: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
  darwin: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
  "linux-x64": "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
  "linux-arm64": "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64",
};

function ytDlpUrl() {
  if (process.platform === "linux") return YT_DLP_URLS[`linux-${process.arch}`];
  return YT_DLP_URLS[process.platform];
}

async function download(url, destPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  await pipeline(res.body, createWriteStream(destPath));
}

async function setupYtDlp() {
  const dest = path.join(BINARIES_DIR, `yt-dlp-${TRIPLE}${EXE_EXT}`);
  console.log("Downloading yt-dlp...");
  await download(ytDlpUrl(), dest);
  if (process.platform !== "win32") chmodSync(dest, 0o755);
  console.log(`  -> ${dest}`);
}

// Downloads an archive, extracts it with the platform's native tool, finds
// the ffmpeg binary inside (`locate`), and moves just that file into place.
async function downloadExtractAndPlace({ url, archiveExt, extract, locate, dest }) {
  const archivePath = path.join(BINARIES_DIR, `_ffmpeg${archiveExt}`);
  const extractDir = path.join(os.tmpdir(), `tubesnag-ffmpeg-${Date.now()}`);

  await download(url, archivePath);
  mkdirSync(extractDir, { recursive: true });
  extract(archivePath, extractDir);
  renameSync(locate(extractDir), dest);
  if (process.platform !== "win32") chmodSync(dest, 0o755);

  rmSync(archivePath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
}

function findEntryStartingWith(dir, prefix) {
  const entry = readdirSync(dir).find((name) => name.startsWith(prefix));
  if (!entry) throw new Error(`Could not find an extracted "${prefix}*" folder in ${dir}`);
  return entry;
}

function runExtractTool(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

const FFMPEG_SOURCES = {
  win32: (dest) => ({
    url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    archiveExt: ".zip",
    extract: (archivePath, extractDir) =>
      runExtractTool("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force`,
      ]),
    locate: (extractDir) =>
      path.join(extractDir, findEntryStartingWith(extractDir, "ffmpeg-"), "bin", "ffmpeg.exe"),
    dest,
  }),
  darwin: (dest) => ({
    url: "https://evermeet.cx/ffmpeg/getrelease/zip",
    archiveExt: ".zip",
    extract: (archivePath, extractDir) => runExtractTool("unzip", ["-o", archivePath, "-d", extractDir]),
    locate: (extractDir) => path.join(extractDir, "ffmpeg"),
    dest,
  }),
  linux: (dest) => {
    const archSuffix = process.arch === "arm64" ? "arm64" : "amd64";
    return {
      url: `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${archSuffix}-static.tar.xz`,
      archiveExt: ".tar.xz",
      extract: (archivePath, extractDir) => runExtractTool("tar", ["-xJf", archivePath, "-C", extractDir]),
      locate: (extractDir) =>
        path.join(extractDir, findEntryStartingWith(extractDir, "ffmpeg-"), "ffmpeg"),
      dest,
    };
  },
};

async function setupFfmpeg() {
  const dest = path.join(BINARIES_DIR, `ffmpeg-${TRIPLE}${EXE_EXT}`);
  console.log(`Downloading ffmpeg (${process.platform})...`);
  await downloadExtractAndPlace(FFMPEG_SOURCES[process.platform](dest));
  console.log(`  -> ${dest}`);
}

async function main() {
  mkdirSync(BINARIES_DIR, { recursive: true });

  const ytDlpDest = path.join(BINARIES_DIR, `yt-dlp-${TRIPLE}${EXE_EXT}`);
  const ffmpegDest = path.join(BINARIES_DIR, `ffmpeg-${TRIPLE}${EXE_EXT}`);

  if (existsSync(ytDlpDest)) {
    console.log("yt-dlp already present, skipping (delete it to re-fetch).");
  } else {
    await setupYtDlp();
  }

  if (existsSync(ffmpegDest)) {
    console.log("ffmpeg already present, skipping (delete it to re-fetch).");
  } else {
    await setupFfmpeg();
  }

  console.log("\nDone. You can now run: npm run tauri dev");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
