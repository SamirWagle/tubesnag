import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { extractUrls, isPlaylistUrl, isYoutubeUrl } from "./lib/url";
import "./App.css";

type Status =
  | "fetching"
  | "pending"
  | "starting"
  | "downloading"
  | "converting"
  | "embedding"
  | "tagging"
  | "done"
  | "error";

type Mode = "audio" | "video";

const AUDIO_QUALITIES: { value: string; label: string }[] = [
  { value: "best", label: "Best" },
  { value: "320", label: "320 kbps" },
  { value: "256", label: "256 kbps" },
  { value: "192", label: "192 kbps" },
  { value: "128", label: "128 kbps" },
];

interface DownloadItem {
  id: string;
  url: string;
  title: string;
  uploader?: string;
  thumbnail?: string;
  duration?: number;
  status: Status;
  percent?: number;
  speed?: string;
  eta?: string;
  error?: string;
  filePath?: string;
  mode: Mode;
  quality: string;
  videoQualities: string[];
}

interface ProgressPayload {
  id: string;
  stage: Status;
  percent?: number;
  speed?: string;
  eta?: string;
  message?: string;
}

function makePlaceholder(id: string, url: string, title: string, mode: Mode): DownloadItem {
  return {
    id,
    url,
    title,
    status: "fetching",
    mode,
    quality: "best",
    videoQualities: ["best"],
  };
}

// Runs `worker` over `items` with at most `limit` in flight at once.
async function runWithLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function runNext(): Promise<void> {
    const current = index++;
    if (current >= items.length) return;
    await worker(items[current]);
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

function formatDuration(seconds?: number): string {
  if (!seconds || Number.isNaN(seconds)) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function statusLabel(status: Status, mode: Mode): string {
  switch (status) {
    case "fetching":
      return "Fetching info…";
    case "pending":
      return "Ready";
    case "starting":
      return "Starting…";
    case "downloading":
      return "Downloading";
    case "converting":
      return mode === "video" ? "Merging video" : "Converting to MP3";
    case "embedding":
      return "Embedding artwork";
    case "tagging":
      return "Tagging metadata";
    case "done":
      return "Done";
    case "error":
      return "Failed";
  }
}

function StatusBadge({ status, mode }: { status: Status; mode: Mode }) {
  const styles: Record<Status, string> = {
    fetching: "bg-slate-700/60 text-slate-300",
    pending: "bg-sky-500/20 text-sky-300",
    starting: "bg-slate-700/60 text-slate-300",
    downloading: "bg-indigo-500/20 text-indigo-300",
    converting: "bg-amber-500/20 text-amber-300",
    embedding: "bg-amber-500/20 text-amber-300",
    tagging: "bg-amber-500/20 text-amber-300",
    done: "bg-emerald-500/20 text-emerald-300",
    error: "bg-rose-500/20 text-rose-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      {statusLabel(status, mode)}
    </span>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
}) {
  return (
    <div className="no-drag flex rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-0.5 text-xs">
      {(["audio", "video"] as Mode[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`rounded px-2 py-1 font-medium capitalize transition-colors ${
            mode === m
              ? "bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-2)] text-white"
              : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function QueueCard({
  item,
  onOpenFolder,
  onRetry,
  onModeChange,
  onQualityChange,
  onStartDownload,
  onDismiss,
}: {
  item: DownloadItem;
  onOpenFolder: (path: string) => void;
  onRetry: (item: DownloadItem) => void;
  onModeChange: (item: DownloadItem, mode: Mode) => void;
  onQualityChange: (item: DownloadItem, quality: string) => void;
  onStartDownload: (item: DownloadItem) => void;
  onDismiss: (item: DownloadItem) => void;
}) {
  const busy = ["starting", "downloading", "converting", "embedding", "tagging"].includes(
    item.status,
  );
  const dismissable = ["pending", "error", "done"].includes(item.status);
  const qualityOptions =
    item.mode === "audio"
      ? AUDIO_QUALITIES
      : item.videoQualities.map((q) => ({
          value: q,
          label: q === "best" ? "Best available" : q,
        }));

  return (
    <div className="flex gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
      <div className="h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-[var(--color-panel-2)]">
        {item.thumbnail ? (
          <img src={item.thumbnail} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-[var(--color-text-dim)]">
            no preview
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-medium text-[var(--color-text)]" title={item.title}>
            {item.title}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <StatusBadge status={item.status} mode={item.mode} />
            {dismissable && (
              <button
                onClick={() => onDismiss(item)}
                aria-label="Dismiss"
                className="no-drag flex h-4 w-4 items-center justify-center rounded-full text-[var(--color-text-dim)] hover:bg-white/10 hover:text-[var(--color-text)]"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <p className="mt-0.5 truncate text-xs text-[var(--color-text-dim)]">
          {item.mode === "video" ? "Video" : "Audio"}
          {item.uploader ? ` · ${item.uploader}` : ""}
          {item.duration ? ` · ${formatDuration(item.duration)}` : ""}
        </p>

        {item.status === "pending" && (
          <div className="no-drag mt-2 flex flex-wrap items-center gap-2">
            <ModeToggle mode={item.mode} onChange={(m) => onModeChange(item, m)} />
            <select
              value={item.quality}
              onChange={(e) => onQualityChange(item, e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-xs text-[var(--color-text)] outline-none"
            >
              {qualityOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => onStartDownload(item)}
              className="ml-auto rounded-md bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-2)] px-3 py-1 text-xs font-semibold text-white hover:opacity-90"
            >
              Download
            </button>
          </div>
        )}

        {busy && (
          <div className="mt-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]">
              <div
                className="progress-fill h-full rounded-full transition-[width] duration-300"
                style={{ width: `${item.status === "downloading" ? item.percent ?? 0 : 100}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-[var(--color-text-dim)]">
              <span>
                {item.status === "downloading" && item.percent !== undefined
                  ? `${item.percent.toFixed(0)}%`
                  : statusLabel(item.status, item.mode)}
              </span>
              <span>
                {item.speed ?? ""} {item.eta ? `· ETA ${item.eta}` : ""}
              </span>
            </div>
          </div>
        )}

        {item.status === "error" && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="truncate text-xs text-rose-400" title={item.error}>
              {item.error ?? "Something went wrong"}
            </p>
            <button
              onClick={() => onRetry(item)}
              className="no-drag shrink-0 rounded-md bg-rose-500/20 px-2 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/30"
            >
              Retry
            </button>
          </div>
        )}

        {item.status === "done" && item.filePath && (
          <button
            onClick={() => onOpenFolder(item.filePath!)}
            className="no-drag mt-2 text-xs font-medium text-[var(--color-accent-2)] hover:underline"
          >
            Show in folder
          </button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [saveDir, setSaveDir] = useState<string>("");
  const [autoWatch, setAutoWatch] = useState(true);
  const [mode, setMode] = useState<Mode>("audio");
  const [isMaximized, setIsMaximized] = useState(false);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const saveDirRef = useRef(saveDir);
  saveDirRef.current = saveDir;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const lastClipboard = useRef<string | null>(null);
  const seenUrls = useRef<Set<string>>(new Set());

  useEffect(() => {
    invoke<{ save_dir: string; auto_watch: boolean; mode: Mode }>("get_settings")
      .then((s) => {
        setSaveDir(s.save_dir);
        setAutoWatch(s.auto_watch);
        setMode(s.mode);
      })
      .catch(() => {});

    const unlistenPromise = listen<ProgressPayload>("download-progress", (event) => {
      const payload = event.payload;
      setItems((prev) =>
        prev.map((it) =>
          it.id === payload.id
            ? {
                ...it,
                status: payload.stage,
                percent: payload.percent ?? it.percent,
                speed: payload.speed ?? it.speed,
                eta: payload.eta ?? it.eta,
                error: payload.stage === "error" ? payload.message ?? "Failed" : it.error,
                filePath: payload.stage === "done" ? payload.message ?? it.filePath : it.filePath,
              }
            : it,
        ),
      );
    });

    getCurrentWindow()
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {});

    return () => {
      unlistenPromise.then((f) => f());
    };
  }, []);

  // Fetches info for a link and adds it to the queue as "pending" — it does
  // NOT start downloading. The user picks audio/video + quality on the card
  // and confirms with its own Download button.
  const addLink = useCallback(async (rawUrl: string, modeOverride?: Mode) => {
    const url = rawUrl.trim();
    if (!url || !isYoutubeUrl(url)) return;

    const activeSame = itemsRef.current.find(
      (it) => it.url === url && it.status !== "done" && it.status !== "error",
    );
    if (activeSame) return;

    const id = crypto.randomUUID();
    const currentMode = modeOverride ?? modeRef.current;
    setItems((prev) => [makePlaceholder(id, url, "Loading video info…", currentMode), ...prev]);

    try {
      const meta = await invoke<{
        id: string;
        url: string;
        title: string;
        thumbnail?: string;
        uploader?: string;
        duration?: number;
        video_qualities: string[];
      }>("fetch_metadata", { id, url });

      setItems((prev) =>
        prev.map((it) =>
          it.id === id
            ? {
                ...it,
                title: meta.title,
                thumbnail: meta.thumbnail,
                uploader: meta.uploader,
                duration: meta.duration,
                videoQualities: meta.video_qualities,
                status: "pending",
              }
            : it,
        ),
      );
    } catch (err) {
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, status: "error", error: String(err) } : it)),
      );
    }
  }, []);

  // Expands a playlist link into its individual videos, then previews each
  // one exactly like addLink would (own thumbnail, own quality options).
  const addPlaylist = useCallback(
    async (url: string, modeOverride?: Mode) => {
      const activeSame = itemsRef.current.find(
        (it) => it.url === url && it.status !== "done" && it.status !== "error",
      );
      if (activeSame) return;

      const currentMode = modeOverride ?? modeRef.current;
      const placeholderId = crypto.randomUUID();
      setItems((prev) => [
        makePlaceholder(placeholderId, url, "Loading playlist…", currentMode),
        ...prev,
      ]);

      try {
        const urls = await invoke<string[]>("fetch_playlist_entries", { url });
        setItems((prev) => prev.filter((it) => it.id !== placeholderId));
        // Some playlists (radio mixes, curated lists) repeat the same video;
        // dedupe here rather than relying on addLink's queue check, since
        // that check reads state that hasn't re-rendered yet mid-loop.
        const uniqueUrls = [...new Set(urls)];
        await runWithLimit(uniqueUrls, 4, (videoUrl) => addLink(videoUrl, currentMode));
      } catch (err) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === placeholderId
              ? { ...it, status: "error", error: String(err) }
              : it,
          ),
        );
      }
    },
    [addLink],
  );

  const addOne = useCallback(
    (url: string, modeOverride?: Mode) => {
      if (isPlaylistUrl(url)) {
        addPlaylist(url, modeOverride);
      } else {
        addLink(url, modeOverride);
      }
    },
    [addLink, addPlaylist],
  );

  // Entry point for anything that might contain one or more links (manual
  // paste, clipboard paste) — splits batches, expands playlists, and
  // previews everything else individually.
  const addLinks = useCallback(
    (text: string, modeOverride?: Mode) => {
      for (const url of extractUrls(text)) {
        addOne(url, modeOverride);
      }
    },
    [addOne],
  );

  const handleStartDownload = useCallback((item: DownloadItem) => {
    setItems((prev) =>
      prev.map((it) => (it.id === item.id ? { ...it, status: "starting" } : it)),
    );
    invoke("start_download", {
      id: item.id,
      url: item.url,
      saveDir: saveDirRef.current,
      mode: item.mode,
      quality: item.quality,
    }).catch((err: unknown) => {
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: "error", error: String(err) } : it)),
      );
    });
  }, []);

  useEffect(() => {
    if (!autoWatch) return;
    const interval = setInterval(async () => {
      try {
        const text = await readText();
        if (text && text !== lastClipboard.current) {
          lastClipboard.current = text;
          for (const url of extractUrls(text)) {
            if (!seenUrls.current.has(url)) {
              seenUrls.current.add(url);
              addOne(url);
            }
          }
        }
      } catch {
        // clipboard read can fail if it doesn't contain text; ignore
      }
    }, 1200);
    return () => clearInterval(interval);
  }, [autoWatch, addOne]);

  const handleManualAdd = () => {
    if (!urlInput.trim()) return;
    addLinks(urlInput);
    setUrlInput("");
  };

  const handlePasteNow = async () => {
    try {
      const text = await readText();
      if (text) addLinks(text);
    } catch {
      // ignore
    }
  };

  const handleChangeFolder = async () => {
    const selected = await openDialog({ directory: true, defaultPath: saveDir || undefined });
    if (typeof selected === "string") {
      await invoke("set_save_dir", { dir: selected });
      setSaveDir(selected);
    }
  };

  const handleOpenFolder = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch {
      await openPath(saveDir).catch(() => {});
    }
  };

  const handleRetry = (item: DownloadItem) => {
    seenUrls.current.delete(item.url);
    setItems((prev) => prev.filter((it) => it.id !== item.id));
    addOne(item.url, item.mode);
  };

  const handleDismiss = (item: DownloadItem) => {
    setItems((prev) => prev.filter((it) => it.id !== item.id));
  };

  const handleItemModeChange = (item: DownloadItem, nextMode: Mode) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id ? { ...it, mode: nextMode, quality: "best" } : it,
      ),
    );
  };

  const handleItemQualityChange = (item: DownloadItem, quality: string) => {
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, quality } : it)));
  };

  const handleToggleAutoWatch = (enabled: boolean) => {
    setAutoWatch(enabled);
    invoke("set_auto_watch", { enabled }).catch(() => {});
  };

  const handleSetMode = (next: Mode) => {
    setMode(next);
    invoke("set_mode", { mode: next }).catch(() => {});
  };

  const pendingItems = items.filter((it) => it.status === "pending");

  const handleDownloadAllPending = () => {
    for (const item of pendingItems) {
      handleStartDownload(item);
    }
  };

  const win = getCurrentWindow();

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Titlebar */}
      <div
        data-tauri-drag-region
        className="titlebar flex h-10 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-panel)] px-3"
      >
        <div className="flex items-center gap-2">
          <div className="h-2.5 w-2.5 rounded-full bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-2)]" />
          <span className="text-xs font-semibold tracking-wide text-[var(--color-text-dim)]">
            TubeSnag
          </span>
        </div>
        <div className="no-drag flex items-center gap-1">
          <button
            onClick={() => win.minimize()}
            className="flex h-6 w-8 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-white/5"
          >
            &#8211;
          </button>
          <button
            onClick={() => win.toggleMaximize().then(() => win.isMaximized().then(setIsMaximized))}
            className="flex h-6 w-8 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-white/5"
          >
            {isMaximized ? "❐" : "☐"}
          </button>
          <button
            onClick={() => win.close()}
            className="flex h-6 w-8 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-rose-500/80 hover:text-white"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
        <div>
          <h1 className="text-xl font-bold">
            <span className="gradient-text">Paste a YouTube link</span>
          </h1>
          <p className="mt-0.5 text-sm text-[var(--color-text-dim)]">
            We'll fetch the info first — you pick audio or video and quality before anything downloads.
          </p>
        </div>

        <div className="flex gap-2">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleManualAdd()}
            placeholder="https://www.youtube.com/watch?v=…"
            className="no-drag flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-2)]"
          />

          <div className="no-drag flex rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-0.5 text-sm">
            <button
              onClick={() => handleSetMode("audio")}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                mode === "audio"
                  ? "bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-2)] text-white"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Audio
            </button>
            <button
              onClick={() => handleSetMode("video")}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                mode === "video"
                  ? "bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-2)] text-white"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Video
            </button>
          </div>

          <button
            onClick={handlePasteNow}
            className="no-drag rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-panel-2)]"
          >
            Paste
          </button>
          <button
            onClick={handleManualAdd}
            className="no-drag rounded-lg bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-2)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-black/20 hover:opacity-90"
          >
            Add
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-xs">
          <label className="no-drag flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoWatch}
              onChange={(e) => handleToggleAutoWatch(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            <span className="text-[var(--color-text-dim)]">
              Auto-detect links copied to clipboard
            </span>
          </label>

          <div className="no-drag flex items-center gap-2">
            <span className="max-w-[240px] truncate text-[var(--color-text-dim)]" title={saveDir}>
              {saveDir}
            </span>
            <button
              onClick={handleChangeFolder}
              className="rounded-md border border-[var(--color-border)] px-2 py-1 font-medium hover:bg-[var(--color-panel-2)]"
            >
              Change
            </button>
            <button
              onClick={() => openPath(saveDir)}
              className="rounded-md border border-[var(--color-border)] px-2 py-1 font-medium hover:bg-[var(--color-panel-2)]"
            >
              Open
            </button>
          </div>
        </div>

        {pendingItems.length > 1 && (
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-xs">
            <span className="text-[var(--color-text-dim)]">
              {pendingItems.length} links ready to download
            </span>
            <div className="no-drag flex items-center gap-2">
              <button
                onClick={() => pendingItems.forEach(handleDismiss)}
                className="rounded-md border border-[var(--color-border)] px-2 py-1 font-medium hover:bg-[var(--color-panel-2)]"
              >
                Clear all
              </button>
              <button
                onClick={handleDownloadAllPending}
                className="rounded-md bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-2)] px-3 py-1 font-semibold text-white hover:opacity-90"
              >
                Download all ({pendingItems.length})
              </button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-[var(--color-text-dim)]">
              <p className="text-sm">No downloads yet</p>
              <p className="text-xs">Paste a link above, or copy one — it'll show up here to preview.</p>
            </div>
          ) : (
            items.map((item) => (
              <QueueCard
                key={item.id}
                item={item}
                onOpenFolder={handleOpenFolder}
                onRetry={handleRetry}
                onModeChange={handleItemModeChange}
                onQualityChange={handleItemQualityChange}
                onStartDownload={handleStartDownload}
                onDismiss={handleDismiss}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
