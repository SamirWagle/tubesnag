use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

// Tauri strips the `-<target-triple>` suffix off sidecar binaries when it
// copies them next to the app executable (both in dev and in a bundled
// build) — the suffix is only a source-file naming convention. The
// remaining name still needs the platform's executable extension
// (`.exe` on Windows, none on macOS/Linux).
fn ffmpeg_bin_name() -> String {
    format!("ffmpeg{}", std::env::consts::EXE_SUFFIX)
}

#[derive(Clone, Serialize, Deserialize)]
struct VideoMeta {
    id: String,
    url: String,
    title: String,
    thumbnail: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    video_qualities: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    id: String,
    stage: String,
    percent: Option<f32>,
    speed: Option<String>,
    eta: Option<String>,
    message: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Settings {
    save_dir: Option<String>,
    auto_watch: Option<bool>,
    mode: Option<String>,
}

#[derive(Serialize, Clone)]
struct SettingsResponse {
    save_dir: String,
    auto_watch: bool,
    mode: String,
}

fn is_youtube_url(url: &str) -> bool {
    let u = url.to_lowercase();
    u.contains("youtube.com/watch")
        || u.contains("youtu.be/")
        || u.contains("youtube.com/shorts/")
        || u.contains("music.youtube.com/watch")
}

fn ffmpeg_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "could not resolve app directory".to_string())?
        .to_path_buf();
    if dir.join(ffmpeg_bin_name()).exists() {
        Ok(dir)
    } else {
        Err(format!("ffmpeg binary not found next to app in {:?}", dir))
    }
}

fn is_playlist_url(url: &str) -> bool {
    let u = url.to_lowercase();
    (u.contains("youtube.com/playlist")) && u.contains("list=")
}

/// Extracts the distinct available video resolutions (e.g. ["best", "1080p",
/// "720p"]) from a yt-dlp `--dump-single-json` payload's `formats` array.
fn parse_video_qualities(json: &serde_json::Value) -> Vec<String> {
    let mut heights: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
    if let Some(formats) = json.get("formats").and_then(|v| v.as_array()) {
        for f in formats {
            let has_video = f
                .get("vcodec")
                .and_then(|v| v.as_str())
                .is_some_and(|v| v != "none");
            if has_video {
                if let Some(h) = f.get("height").and_then(|v| v.as_i64()) {
                    heights.insert(h);
                }
            }
        }
    }
    let mut qualities: Vec<String> = vec!["best".to_string()];
    qualities.extend(heights.iter().rev().map(|h| format!("{h}p")));
    qualities
}

/// Builds the yt-dlp `-f` format selector (and, for audio, the
/// `--audio-quality` value) for the given mode/quality choice.
fn build_format_args(is_video: bool, quality: &str) -> (String, Option<String>) {
    if is_video {
        let format_str = if quality == "best" || quality.is_empty() {
            "bv*+ba/b".to_string()
        } else {
            let height = quality.trim_end_matches('p');
            format!("bv*[height<={height}]+ba/b[height<={height}]")
        };
        (format_str, None)
    } else {
        let audio_quality = if quality == "best" || quality.is_empty() {
            "0".to_string()
        } else {
            quality.to_string()
        };
        ("bestaudio/best".to_string(), Some(audio_quality))
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn default_save_dir(app: &AppHandle) -> PathBuf {
    if let Ok(audio) = app.path().audio_dir() {
        return audio.join("YT Downloads");
    }
    if let Ok(home) = app.path().home_dir() {
        return home.join("YT Downloads");
    }
    PathBuf::from("YT Downloads")
}

fn read_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<Settings>(&contents).ok())
        .unwrap_or_default()
}

fn write_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<SettingsResponse, String> {
    let settings = read_settings(&app);
    let save_dir = match settings.save_dir {
        Some(dir) => dir,
        None => {
            let default_dir = default_save_dir(&app);
            fs::create_dir_all(&default_dir).map_err(|e| e.to_string())?;
            default_dir.to_string_lossy().to_string()
        }
    };
    Ok(SettingsResponse {
        save_dir,
        auto_watch: settings.auto_watch.unwrap_or(true),
        mode: settings.mode.unwrap_or_else(|| "audio".to_string()),
    })
}

#[tauri::command]
fn set_save_dir(app: AppHandle, dir: String) -> Result<(), String> {
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut settings = read_settings(&app);
    settings.save_dir = Some(dir);
    write_settings(&app, &settings)
}

#[tauri::command]
fn set_auto_watch(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = read_settings(&app);
    settings.auto_watch = Some(enabled);
    write_settings(&app, &settings)
}

#[tauri::command]
fn set_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let mut settings = read_settings(&app);
    settings.mode = Some(mode);
    write_settings(&app, &settings)
}

#[tauri::command]
async fn fetch_playlist_entries(app: AppHandle, url: String) -> Result<Vec<String>, String> {
    if !is_playlist_url(&url) {
        return Err("Not a playlist link".into());
    }

    let sidecar = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?;

    let output = sidecar
        .args(["--flat-playlist", "--dump-single-json", "--no-warnings", &url])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(if err.is_empty() {
            "yt-dlp failed to read this playlist".to_string()
        } else {
            err
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("could not parse playlist info: {e}"))?;

    let urls: Vec<String> = json
        .get("entries")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| e.get("id").and_then(|v| v.as_str()))
                .map(|id| format!("https://www.youtube.com/watch?v={id}"))
                .collect()
        })
        .unwrap_or_default();

    if urls.is_empty() {
        return Err("No videos found in this playlist".to_string());
    }

    Ok(urls)
}

#[tauri::command]
async fn fetch_metadata(app: AppHandle, id: String, url: String) -> Result<VideoMeta, String> {
    if !is_youtube_url(&url) {
        return Err("Not a valid YouTube link".into());
    }

    let sidecar = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?;

    let output = sidecar
        .args([
            "--dump-single-json",
            "--no-warnings",
            "--no-playlist",
            "--skip-download",
            &url,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(if err.is_empty() {
            "yt-dlp failed to read this link".to_string()
        } else {
            err
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("could not parse video info: {e}"))?;

    let title = json
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown title")
        .to_string();
    let thumbnail = json
        .get("thumbnail")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let uploader = json
        .get("uploader")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let duration = json.get("duration").and_then(|v| v.as_f64());

    let video_qualities = parse_video_qualities(&json);

    Ok(VideoMeta {
        id,
        url,
        title,
        thumbnail,
        uploader,
        duration,
        video_qualities,
    })
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    id: String,
    url: String,
    save_dir: String,
    mode: String,
    quality: String,
) -> Result<(), String> {
    if !is_youtube_url(&url) {
        return Err("Not a valid YouTube link".into());
    }
    let is_video = mode == "video";

    let ffmpeg_dir = ffmpeg_dir()?;
    let tmp_dir = std::env::temp_dir().join(format!("ytdlp_{id}"));
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let emit = |app: &AppHandle, stage: &str, percent: Option<f32>, speed: Option<String>, eta: Option<String>, message: Option<String>| {
        let _ = app.emit(
            "download-progress",
            ProgressPayload {
                id: id.clone(),
                stage: stage.to_string(),
                percent,
                speed,
                eta,
                message,
            },
        );
    };

    emit(&app, "starting", Some(0.0), None, None, None);

    let out_template = tmp_dir.join("%(title)s.%(ext)s");
    let out_template_str = out_template.to_string_lossy().to_string();
    let ffmpeg_dir_str = ffmpeg_dir.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?;

    let (format_str, audio_quality_arg) = build_format_args(is_video, &quality);
    let mut args: Vec<&str> = Vec::new();

    if is_video {
        args.extend(["-f", &format_str, "--merge-output-format", "mp4"]);
    } else {
        args.extend([
            "-f",
            &format_str,
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            audio_quality_arg.as_deref().unwrap_or("0"),
        ]);
    }
    args.extend([
        "--no-playlist",
        "--write-thumbnail",
        "--embed-thumbnail",
        "--add-metadata",
        "--ffmpeg-location",
        &ffmpeg_dir_str,
        "--newline",
        "--progress-template",
        "download:DLPROGRESS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "-o",
        &out_template_str,
        &url,
    ]);

    let (mut rx, _child) = sidecar.args(args).spawn().map_err(|e| e.to_string())?;

    let mut last_error = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                let line = line.trim();

                if let Some(rest) = line.strip_prefix("DLPROGRESS|") {
                    let parts: Vec<&str> = rest.split('|').collect();
                    if parts.len() == 3 {
                        let percent = parts[0].trim().trim_end_matches('%').parse::<f32>().ok();
                        let speed = Some(parts[1].trim().to_string());
                        let eta = Some(parts[2].trim().to_string());
                        emit(&app, "downloading", percent, speed, eta, None);
                    }
                } else if line.contains("[ExtractAudio]") || line.contains("[Merger]") {
                    emit(&app, "converting", None, None, None, None);
                } else if line.contains("[EmbedThumbnail]") {
                    emit(&app, "embedding", None, None, None, None);
                } else if line.contains("[Metadata]") {
                    emit(&app, "tagging", None, None, None, None);
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                if line.to_lowercase().contains("error") {
                    last_error = line.trim().to_string();
                }
            }
            CommandEvent::Error(err) => {
                last_error = err;
            }
            CommandEvent::Terminated(payload) => {
                let success = payload.code == Some(0);
                if success {
                    let wanted_exts: &[&str] = if is_video {
                        &["mp4", "mkv", "webm"]
                    } else {
                        &["mp3"]
                    };
                    let mut moved_path: Option<PathBuf> = None;
                    if let Ok(entries) = fs::read_dir(&tmp_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            let ext = path.extension().and_then(|e| e.to_str());
                            if ext.is_some_and(|e| wanted_exts.contains(&e)) {
                                let file_name = path.file_name().unwrap().to_owned();
                                let dest = PathBuf::from(&save_dir).join(&file_name);
                                if fs::create_dir_all(&save_dir).is_ok()
                                    && fs::rename(&path, &dest).is_err()
                                {
                                    let _ = fs::copy(&path, &dest);
                                }
                                moved_path = Some(dest);
                                break;
                            }
                        }
                    }
                    let _ = fs::remove_dir_all(&tmp_dir);

                    match moved_path {
                        Some(dest) => emit(
                            &app,
                            "done",
                            Some(100.0),
                            None,
                            None,
                            Some(dest.to_string_lossy().to_string()),
                        ),
                        None => emit(
                            &app,
                            "error",
                            None,
                            None,
                            None,
                            Some("Download finished but no output file was found".to_string()),
                        ),
                    }
                } else {
                    let _ = fs::remove_dir_all(&tmp_dir);
                    let message = if last_error.is_empty() {
                        format!("yt-dlp exited with code {:?}", payload.code)
                    } else {
                        last_error.clone()
                    };
                    emit(&app, "error", None, None, None, Some(message));
                }
                break;
            }
            _ => {}
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            fetch_metadata,
            fetch_playlist_entries,
            start_download,
            get_settings,
            set_save_dir,
            set_auto_watch,
            set_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognizes_watch_urls() {
        assert!(is_youtube_url("https://www.youtube.com/watch?v=abc123"));
        assert!(is_youtube_url("https://youtu.be/abc123"));
        assert!(is_youtube_url("https://www.youtube.com/shorts/abc123"));
        assert!(is_youtube_url("https://music.youtube.com/watch?v=abc123"));
        assert!(is_youtube_url("HTTPS://WWW.YOUTUBE.COM/WATCH?V=abc123"));
    }

    #[test]
    fn rejects_non_youtube_urls() {
        assert!(!is_youtube_url("https://vimeo.com/12345"));
        assert!(!is_youtube_url("not a url at all"));
        assert!(!is_youtube_url(""));
    }

    #[test]
    fn recognizes_playlist_urls() {
        assert!(is_playlist_url("https://www.youtube.com/playlist?list=PLxyz"));
        assert!(is_playlist_url("https://music.youtube.com/playlist?list=PLxyz"));
    }

    #[test]
    fn rejects_playlist_page_without_list_param() {
        assert!(!is_playlist_url("https://www.youtube.com/playlist"));
    }

    #[test]
    fn watch_url_with_list_param_is_not_a_playlist_url() {
        // A normal video link picked up while playing inside a playlist still
        // carries `&list=`, but the user almost always means "just this
        // video" — only the dedicated /playlist page counts as a playlist.
        assert!(!is_playlist_url(
            "https://www.youtube.com/watch?v=abc123&list=PLxyz"
        ));
    }

    #[test]
    fn parses_video_qualities_sorted_descending_with_best_first() {
        let json = json!({
            "formats": [
                { "vcodec": "avc1", "height": 720 },
                { "vcodec": "avc1", "height": 1080 },
                { "vcodec": "none", "height": 2160 }, // audio-only, must be ignored
                { "vcodec": "avc1", "height": 720 },  // duplicate height
                { "vcodec": "vp9", "height": 360 },
            ]
        });
        let qualities = parse_video_qualities(&json);
        assert_eq!(qualities, vec!["best", "1080p", "720p", "360p"]);
    }

    #[test]
    fn parses_video_qualities_with_no_formats() {
        let json = json!({});
        assert_eq!(parse_video_qualities(&json), vec!["best"]);
    }

    #[test]
    fn builds_best_video_format_with_no_height_cap() {
        let (format_str, audio_quality) = build_format_args(true, "best");
        assert_eq!(format_str, "bv*+ba/b");
        assert!(audio_quality.is_none());
    }

    #[test]
    fn builds_capped_video_format_for_specific_resolution() {
        let (format_str, audio_quality) = build_format_args(true, "720p");
        assert_eq!(format_str, "bv*[height<=720]+ba/b[height<=720]");
        assert!(audio_quality.is_none());
    }

    #[test]
    fn builds_best_audio_quality_as_vbr_zero() {
        let (format_str, audio_quality) = build_format_args(false, "best");
        assert_eq!(format_str, "bestaudio/best");
        assert_eq!(audio_quality.as_deref(), Some("0"));
    }

    #[test]
    fn builds_specific_audio_bitrate() {
        let (_, audio_quality) = build_format_args(false, "192");
        assert_eq!(audio_quality.as_deref(), Some("192"));
    }

    #[test]
    fn ffmpeg_bin_name_matches_platform_exe_suffix() {
        let name = ffmpeg_bin_name();
        assert!(name.starts_with("ffmpeg"));
        assert_eq!(name, format!("ffmpeg{}", std::env::consts::EXE_SUFFIX));
    }
}
