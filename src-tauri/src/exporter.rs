//! 导出：把选中的谱面集 / 皮肤 / 回放从 lazer 的内容寻址存储
//! （files/x/xy/<sha256>）打包回原始形态——
//! 谱面集 → .osz（zip）、皮肤 → .osk（zip）、回放 → 原样复制为 .osr。

use std::fs::File;
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::lazer_realm::RealmLibrary;
use crate::platform;
use crate::state::CachedLibrary;

/// 导出取消标志：cancel_export 置位，导出循环在下一个条目前停止。
#[derive(Default)]
pub struct ExportCancel(pub(crate) Arc<AtomicBool>);

#[tauri::command]
pub fn cancel_export(cancel: tauri::State<'_, ExportCancel>) {
    cancel.0.store(true, Ordering::Relaxed);
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub failures: Vec<String>,
    /// 是否被用户终止。
    pub cancelled: bool,
    /// 终止或完成前已成功写出的条数（不含失败项）。
    pub completed: usize,
    pub total: usize,
    /// 提示信息（如硬链接失败回退为复制）。
    pub notices: Vec<String>,
    /// 因目标已存在而跳过的文件数。
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub done: usize,
    pub total: usize,
    pub name: String,
}

/// 文件名里的非法字符替换为下划线（保留 '/' 用于皮肤内的相对路径）。
pub(crate) fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' => '/',
            '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

/// 按前端的 Unicode 开关取文件名用名：关 = 罗马字优先（回退 Unicode）。
fn display_name_with(use_unicode: bool, romanized: &str, unicode: &str) -> String {
    let (first, second) = if use_unicode { (unicode, romanized) } else { (romanized, unicode) };
    if first.trim().is_empty() { second.to_string() } else { first.to_string() }
}

fn load_library(cache: &std::sync::Arc<CachedLibrary>) -> Result<(PathBuf, RealmLibrary), String> {
    let files_root = platform::lazer_files_root().ok_or("无法确定 lazer 文件存储目录")?;
    Ok((files_root, cache.get_or_parse()?))
}

pub(crate) fn blob_path(files_root: &Path, hash: &str) -> PathBuf {
    files_root.join("files").join(platform::blob_relative_path(hash))
}

/// 把 (zip 内路径, blob hash) 列表写成 zip。单个 blob 缺失时跳过，
/// 尽可能保住其余内容。
pub(crate) fn write_zip(out_path: &Path, files_root: &Path, entries: &[(String, String)]) -> Result<(), String> {
    let file = File::create(out_path).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut zip = ZipWriter::new(file);
    for (zip_name, hash) in entries {
        let blob = blob_path(files_root, hash);
        if !blob.is_file() {
            continue;
        }
        let mut reader = BufReader::new(
            File::open(&blob).map_err(|e| format!("读取 blob 失败（{zip_name}）：{e}"))?,
        );
        // 已压缩的媒体（音频/图片/视频）用 Stored 直存：deflate 对它们几乎不再
        // 压缩却极耗 CPU，是 .osz 导出慢的主因；文本类保留 Deflated。
        let compressed = {
            let lower = zip_name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
            matches!(
                lower.as_str(),
                "mp3" | "ogg" | "oga" | "m4a" | "flac" | "wav" | "jpg" | "jpeg" | "png"
                    | "webp" | "gif" | "mp4" | "avi" | "mkv" | "mov" | "wmv" | "zip" | "osz"
            )
        };
        let options = SimpleFileOptions::default().compression_method(if compressed {
            zip::CompressionMethod::Stored
        } else {
            zip::CompressionMethod::Deflated
        });
        zip.start_file(sanitize(zip_name), options)
            .map_err(|e| format!("写入 zip 头失败（{zip_name}）：{e}"))?;
        std::io::copy(&mut reader, &mut zip)
            .map_err(|e| format!("写入文件失败（{zip_name}）：{e}"))?;
    }
    zip.finish()
        .map_err(|e| format!("收尾 zip 失败：{e}"))?
        .flush()
        .ok();
    Ok(())
}

/// 逐项导出循环（供主导出与集合页“导出所选集合谱面”共用）：
/// 构建与写盘都在阻塞线程上进行，每项是（输出文件名, 实际写文件的闭包）。
/// 单项失败记入 failures，不中断整体；取消标志置位后在下一个条目前停止。
pub(crate) async fn export_loop<B, F>(
    app: tauri::AppHandle,
    cancel: Arc<AtomicBool>,
    out_dir: String,
    build: B,
) -> Result<ExportResult, String>
where
    B: FnOnce(&Path, Arc<std::sync::Mutex<Vec<String>>>, Arc<std::sync::Mutex<usize>>) -> Result<Vec<(String, F)>, String> + Send + 'static,
    F: FnOnce(&Path, &dyn Fn(&str)) -> Result<(), String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        cancel.store(false, Ordering::Relaxed);
        let out_dir_path = PathBuf::from(out_dir);
        let notices = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let skipped = Arc::new(std::sync::Mutex::new(0usize));
        let items = build(&out_dir_path, notices.clone(), skipped.clone())?;
        let total = items.len();
        let mut failures = Vec::new();
        let mut completed = 0usize;
        let mut cancelled = false;
        // 节流：单文件条目（如回放）极快，逐条发事件会瞬间塞爆 WebView 的 IPC。
        // 条目级与文件级上报共用同一个节流器（100ms）。
        let last_emit = Arc::new(std::sync::Mutex::new(
            std::time::Instant::now()
                .checked_sub(std::time::Duration::from_millis(1000))
                .unwrap_or_else(std::time::Instant::now),
        ));
        let emit_throttled = |app: &tauri::AppHandle, done: usize, total: usize, name: &str| {
            let Ok(mut last) = last_emit.lock() else { return };
            if last.elapsed() < std::time::Duration::from_millis(100) {
                return;
            }
            *last = std::time::Instant::now();
            drop(last);
            let _ = app.emit(
                "export-progress",
                ExportProgress {
                    done,
                    total,
                    name: name.to_string(),
                },
            );
        };
        for (index, (name, write)) in items.into_iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            emit_throttled(&app, index, total, &name);
            let progress_app = app.clone();
            let done = index;
            let total_now = total;
            let throttle = Arc::clone(&last_emit);
            let report = move |text: &str| {
                if let Ok(mut last) = throttle.lock() {
                    if last.elapsed() < std::time::Duration::from_millis(100) {
                        return;
                    }
                    *last = std::time::Instant::now();
                }
                let _ = progress_app.emit(
                    "export-progress",
                    ExportProgress {
                        done,
                        total: total_now,
                        name: text.to_string(),
                    },
                );
            };
            match write(&out_dir_path, &report) {
                Ok(()) => completed += 1,
                Err(error) => failures.push(format!("{name}：{error}")),
            }
        }
        let _ = app.emit(
            "export-progress",
            ExportProgress {
                done: total,
                total,
                name: "完成".to_string(),
            },
        );
        let notices = notices.lock().map(|n| n.clone()).unwrap_or_default();
        let skipped = skipped.lock().map(|n| *n).unwrap_or(0);
        Ok(ExportResult {
            failures,
            cancelled,
            completed,
            total,
            notices,
            skipped,
        })
    })
    .await
    .map_err(|join| join.to_string())?
}


/// 导出格式：archive = 压缩包（.osz/.osk），folder = 展开为文件夹。
pub(crate) fn is_folder(format: &str) -> bool {
    format.eq_ignore_ascii_case("folder")
}

/// 把一个 blob 以复制或硬链接落到 dest；硬链接失败时回退复制并记录提示。
fn link_or_copy(
    src: &Path,
    dest: &Path,
    hardlink: bool,
    overwrite: bool,
    notices: &Arc<std::sync::Mutex<Vec<String>>>,
    skipped: &Arc<std::sync::Mutex<usize>>,
) -> Result<(), String> {
    // 目标已存在：默认跳过（不覆盖）；强制覆盖时先移除旧文件（硬链接要求目标不存在）。
    if dest.exists() {
        if !overwrite {
            if let Ok(mut count) = skipped.lock() {
                *count += 1;
            }
            return Ok(());
        }
        if hardlink {
            std::fs::remove_file(dest)
                .map_err(|e| format!("移除旧文件失败（{}）：{e}", dest.display()))?;
        }
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败（{}）：{e}", dest.display()))?;
    }
    if hardlink {
        match std::fs::hard_link(src, dest) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if let Ok(mut list) = notices.lock() {
                    list.push(format!(
                        "硬链接失败，已改为复制（{} ← {}）：{error}",
                        dest.display(),
                        src.display()
                    ));
                }
            }
        }
    }
    std::fs::copy(src, dest)
        .map_err(|e| format!("复制文件失败（{}）：{e}", dest.display()))?;
    Ok(())
}

/// 文件夹模式：每个条目导出为 out/<名称>/ 下的原始文件树；
/// 每写一个文件经 report 上报一次（文件级进度）。
pub(crate) fn write_folder(
    out_dir: &Path,
    base_name: &str,
    files_root: &Path,
    entries: &[(String, String)],
    hardlink: bool,
    overwrite: bool,
    notices: &Arc<std::sync::Mutex<Vec<String>>>,
    skipped: &Arc<std::sync::Mutex<usize>>,
    report: &dyn Fn(&str),
) -> Result<(), String> {
    let target = out_dir.join(sanitize(base_name));
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("创建目录失败（{}）：{e}", target.display()))?;
    for (file_name, hash) in entries {
        let blob = blob_path(files_root, hash);
        if !blob.is_file() {
            continue;
        }
        report(&format!("{}/{}", base_name, file_name));
        link_or_copy(&blob, &target.join(sanitize(file_name)), hardlink, overwrite, notices, skipped)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn export_sets(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, ExportCancel>,
    cache: tauri::State<'_, std::sync::Arc<CachedLibrary>>,
    set_ids: Vec<String>,
    out_dir: String,
    format: Option<String>,
    hardlink: Option<bool>,
    use_unicode: Option<bool>,
    overwrite: Option<bool>,
    folder_out_dir: Option<String>,
) -> Result<ExportResult, String> {
    let folder = format.as_deref().is_some_and(is_folder);
    // 额外把每个谱面集的文件原样导出为文件夹（默认 stable Songs），与主导出并行进行。
    let folder_out_dir = folder_out_dir.filter(|dir| !dir.trim().is_empty());
    let hardlink = hardlink.unwrap_or(false);
    let use_unicode = use_unicode.unwrap_or(true);
    let overwrite = overwrite.unwrap_or(false);
    let cache = cache.inner().clone();
    export_loop(app, cancel.0.clone(), out_dir, move |_out, notices, skipped| {
        let (files_root, library) = load_library(&cache)?;
        type Item = Box<dyn FnOnce(&Path, &dyn Fn(&str)) -> Result<(), String> + Send>;
        let mut items: Vec<(String, Item)> = Vec::new();
        for set_id in &set_ids {
            let Some(set) = library.sets.iter().find(|s| &s.id == set_id) else {
                continue;
            };
            // 文件夹模式强制使用罗马字名（Unicode 仅用于压缩包文件名）。
            let name_unicode = use_unicode && !folder;
            let artist = display_name_with(name_unicode, &set.artist, &set.artist_unicode);
            let title = display_name_with(name_unicode, &set.title, &set.title_unicode);
            let mut name = format!("{} - {}", artist, title);
            if name.trim() == "-" || name.trim().is_empty() {
                name = set.id.clone();
            }
            if set.online_id > 0 {
                name = format!("{} {}", set.online_id, name);
            }
            let entries: Vec<(String, String)> = set
                .files
                .iter()
                .map(|file| (file.filename.clone(), file.hash.clone()))
                .collect();
            let files_root = files_root.clone();
            let out_name = sanitize(&name);
            let extra = folder_out_dir.as_ref().map(|dir| {
                (
                    PathBuf::from(dir),
                    files_root.clone(),
                    entries.clone(),
                    out_name.clone(),
                )
            });
            if folder {
                let notices = notices.clone();
                let skipped = skipped.clone();
                items.push((
                    out_name.clone(),
                    Box::new(move |out: &Path, report: &dyn Fn(&str)| {
                        write_folder(out, &out_name, &files_root, &entries, hardlink, overwrite, &notices, &skipped, report)
                    }),
                ));
            } else {
                let osz = format!("{out_name}.osz");
                let skipped = skipped.clone();
                items.push((
                    osz.clone(),
                    Box::new(move |out: &Path, _report: &dyn Fn(&str)| {
                        // 压缩包已存在：默认跳过，强制覆盖时重写。
                        if out.join(&osz).exists() && !overwrite {
                            if let Ok(mut count) = skipped.lock() {
                                *count += 1;
                            }
                            return Ok(());
                        }
                        write_zip(&out.join(&osz), &files_root, &entries)
                    }),
                ));
            }
            // 额外导出：谱面集文件原样写入 folder_out_dir/<名称>/（如 stable Songs）。
            if let Some((extra_dir, extra_files_root, extra_entries, extra_name)) = extra {
                let notices = notices.clone();
                let skipped = skipped.clone();
                let label = format!("Songs/{extra_name}");
                items.push((
                    label.clone(),
                    Box::new(move |_out: &Path, report: &dyn Fn(&str)| {
                        write_folder(
                            &extra_dir,
                            &label,
                            &extra_files_root,
                            &extra_entries,
                            hardlink,
                            overwrite,
                            &notices,
                            &skipped,
                            report,
                        )
                    }),
                ));
            }
        }
        Ok(items)
    })
    .await
}

#[tauri::command]
pub async fn export_skins(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, ExportCancel>,
    cache: tauri::State<'_, std::sync::Arc<CachedLibrary>>,
    skin_ids: Vec<String>,
    out_dir: String,
    format: Option<String>,
    hardlink: Option<bool>,
    _use_unicode: Option<bool>,
    overwrite: Option<bool>,
) -> Result<ExportResult, String> {
    let folder = format.as_deref().is_some_and(is_folder);
    let hardlink = hardlink.unwrap_or(false);
    let overwrite = overwrite.unwrap_or(false);
    let cache = cache.inner().clone();
    export_loop(app, cancel.0.clone(), out_dir, move |_out, notices, skipped| {
        let (files_root, library) = load_library(&cache)?;
        type Item = Box<dyn FnOnce(&Path, &dyn Fn(&str)) -> Result<(), String> + Send>;
        let mut items: Vec<(String, Item)> = Vec::new();
        for skin_id in &skin_ids {
            let Some(skin) = library.skins.iter().find(|s| &s.id == skin_id) else {
                continue;
            };
            let name = if skin.name.trim().is_empty() {
                skin.id.clone()
            } else {
                skin.name.clone()
            };
            let entries: Vec<(String, String)> = skin
                .files
                .iter()
                .map(|file| (file.filename.clone(), file.hash.clone()))
                .collect();
            let files_root = files_root.clone();
            let out_name = sanitize(&name);
            if folder {
                let notices = notices.clone();
                let skipped = skipped.clone();
                items.push((
                    out_name.clone(),
                    Box::new(move |out: &Path, report: &dyn Fn(&str)| {
                        write_folder(out, &out_name, &files_root, &entries, hardlink, overwrite, &notices, &skipped, report)
                    }),
                ));
            } else {
                let osk = format!("{out_name}.osk");
                let skipped = skipped.clone();
                items.push((
                    osk.clone(),
                    Box::new(move |out: &Path, _report: &dyn Fn(&str)| {
                        // 压缩包已存在：默认跳过，强制覆盖时重写。
                        if out.join(&osk).exists() && !overwrite {
                            if let Ok(mut count) = skipped.lock() {
                                *count += 1;
                            }
                            return Ok(());
                        }
                        write_zip(&out.join(&osk), &files_root, &entries)
                    }),
                ));
            }
        }
        Ok(items)
    })
    .await
}

#[tauri::command]
pub async fn export_replays(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, ExportCancel>,
    cache: tauri::State<'_, std::sync::Arc<CachedLibrary>>,
    score_ids: Vec<String>,
    out_dir: String,
    hardlink: Option<bool>,
    use_unicode: Option<bool>,
    overwrite: Option<bool>,
) -> Result<ExportResult, String> {
    let hardlink = hardlink.unwrap_or(false);
    let use_unicode = use_unicode.unwrap_or(true);
    let overwrite = overwrite.unwrap_or(false);
    let cache = cache.inner().clone();
    export_loop(app, cancel.0.clone(), out_dir, move |_out, notices, skipped| {
        let (files_root, library) = load_library(&cache)?;
        type Item = Box<dyn FnOnce(&Path, &dyn Fn(&str)) -> Result<(), String> + Send>;
        let mut items: Vec<(String, Item)> = Vec::new();
        for score_id in &score_ids {
            let Some(score) = library.scores.iter().find(|s| &s.id == score_id) else {
                continue;
            };
            let beatmap = if use_unicode
                || score.beatmap_romanized.trim().is_empty()
            {
                &score.beatmap
            } else {
                &score.beatmap_romanized
            };
            let mut name = if beatmap.trim().is_empty() {
                score.id.clone()
            } else if score.difficulty.trim().is_empty() {
                beatmap.clone()
            } else {
                format!("{beatmap} [{}]", score.difficulty)
            };
            if !score.date.is_empty() {
                name = format!("{} ({})", name, score.date);
            }
            let hash = score.replay_hash.clone();
            let files_root = files_root.clone();
            let out_name = format!("{}.osr", sanitize(&name));
            let notices = notices.clone();
            let skipped = skipped.clone();
            items.push((
                out_name.clone(),
                Box::new(move |out: &Path, _report: &dyn Fn(&str)| {
                    link_or_copy(&blob_path(&files_root, &hash), &out.join(&out_name), hardlink, overwrite, &notices, &skipped)
                        .map_err(|e| format!("导出回放失败：{e}"))?;
                    Ok(())
                }),
            ));
        }
        Ok(items)
    })
    .await
}

#[cfg(test)]
mod zip_tests {
    use super::*;

    #[test]
    fn media_files_use_stored() {
        let dir = tempfile::tempdir().expect("tempdir");
        // 造两个 blob:一个“音频”一个 .osu 文本。
        let audio_hash = "aa".repeat(32);
        let osu_hash = "bb".repeat(32);
        let files_root = dir.path().join("files");
        std::fs::create_dir_all(&files_root).unwrap();
        let audio_blob = files_root.join("files").join("a/aa").join(&audio_hash);
        let osu_blob = files_root.join("files").join("b/bb").join(&osu_hash);
        std::fs::create_dir_all(audio_blob.parent().unwrap()).unwrap();
        std::fs::create_dir_all(osu_blob.parent().unwrap()).unwrap();
        std::fs::write(&audio_blob, vec![0u8; 4096]).unwrap();
        std::fs::write(&osu_blob, b"[General]\nAudioFilename: audio.mp3\n").unwrap();
        let out = dir.path().join("test.osz");
        write_zip(
            &out,
            &files_root,
            &[
                ("audio.mp3".into(), audio_hash),
                ("diff [Normal].osu".into(), osu_hash),
            ],
        )
        .unwrap();
        let file = File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let audio_method = zip.by_name("audio.mp3").unwrap().compression();
        assert_eq!(audio_method, zip::CompressionMethod::Stored);
        let osu_method = zip.by_name("diff [Normal].osu").unwrap().compression();
        assert_eq!(osu_method, zip::CompressionMethod::Deflated);
    }
}
