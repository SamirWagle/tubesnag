import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

const YOUTUBE_RE =
  /(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?.*v=|shorts\/)|youtu\.be\/)/i;

type Status =
  | "fetching"
  | "starting"
  | "downloading"
  | "converting"
  | "embedding"
  | "tagging"
  | "done"
  | "error";

type Mode = "audio" | "video";

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
}

interface ProgressPayload {
  id: string;
  stage: Status;
  percent?: number;
  speed?: string;
  eta?: string;
  message?: string;
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

function QueueCard({
  item,
  onOpenFolder,
  onRetry,
}: {
  item: DownloadItem;
  onOpenFolder: (path: string) => void;
  onRetry: (item: DownloadItem) => void;
}) {
  const busy = !["done", "error", "fetching"].includes(item.status);
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
          <StatusBadge status={item.status} mode={item.mode} />
        </div>
        <p className="mt-0.5 truncate text-xs text-[var(--color-text-dim)]">
          {item.mode === "video" ? "Video" : "Audio"}
          {item.uploader ? ` · ${item.uploader}` : ""}
          {item.duration ? ` · ${formatDuration(item.duration)}` : ""}
        </p>

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

  const addLink = useCallback(async (rawUrl: string, modeOverride?: Mode) => {
    const url = rawUrl.trim();
    if (!url || !YOUTUBE_RE.test(url)) return;

    const activeSame = itemsRef.current.find(
      (it) => it.url === url && it.status !== "done" && it.status !== "error",
    );
    if (activeSame) return;

    const id = crypto.randomUUID();
    const currentMode = modeOverride ?? modeRef.current;
    const placeholder: DownloadItem = {
      id,
      url,
      title: "Loading video info…",
      status: "fetching",
      mode: currentMode,
    };
    setItems((prev) => [placeholder, ...prev]);

    try {
      const meta = await invoke<{
        id: string;
        url: string;
        title: string;
        thumbnail?: string;
        uploader?: string;
        duration?: number;
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
                status: "starting",
              }
            : it,
        ),
      );

      invoke("start_download", {
        id,
        url,
        saveDir: saveDirRef.current,
        mode: currentMode,
      }).catch((err: unknown) => {
        setItems((prev) =>
          prev.map((it) =>
            it.id === id ? { ...it, status: "error", error: String(err) } : it,
          ),
        );
      });
    } catch (err) {
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, status: "error", error: String(err) } : it)),
      );
    }
  }, []);

  useEffect(() => {
    if (!autoWatch) return;
    const interval = setInterval(async () => {
      try {
        const text = await readText();
        if (text && text !== lastClipboard.current) {
          lastClipboard.current = text;
          const trimmed = text.trim();
          if (YOUTUBE_RE.test(trimmed) && !seenUrls.current.has(trimmed)) {
            seenUrls.current.add(trimmed);
            addLink(trimmed);
          }
        }
      } catch {
        // clipboard read can fail if it doesn't contain text; ignore
      }
    }, 1200);
    return () => clearInterval(interval);
  }, [autoWatch, addLink]);

  const handleManualAdd = () => {
    if (!urlInput.trim()) return;
    addLink(urlInput);
    setUrlInput("");
  };

  const handlePasteNow = async () => {
    try {
      const text = await readText();
      if (text) addLink(text);
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
    addLink(item.url, item.mode);
  };

  const handleToggleAutoWatch = (enabled: boolean) => {
    setAutoWatch(enabled);
    invoke("set_auto_watch", { enabled }).catch(() => {});
  };

  const handleSetMode = (next: Mode) => {
    setMode(next);
    invoke("set_mode", { mode: next }).catch(() => {});
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
            {mode === "video"
              ? "Downloads the full video as MP4."
              : "Downloads as MP3 with embedded album art."}
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
            Download
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
              Auto-download links copied to clipboard
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

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-[var(--color-text-dim)]">
              <p className="text-sm">No downloads yet</p>
              <p className="text-xs">Paste a link above, or copy one — it'll pick it up.</p>
            </div>
          ) : (
            items.map((item) => (
              <QueueCard
                key={item.id}
                item={item}
                onOpenFolder={handleOpenFolder}
                onRetry={handleRetry}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
