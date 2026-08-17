//! 空间维护工具（参考 OPP 的 tools/lazer_disk_usage 与 tools/lazer_dedupe）：
//! 1. 磁盘占用统计：lazer files/ 的总大小与排除硬链接后的实际占用
//!    （从 stable 导入的文件以硬链接存在，删除 lazer 目录不会释放那部分空间）。
//! 2. 压缩空间：lazer 的 files 存储以内容 SHA-256 为文件名。扫描 stable 谱面
//!    目录中与 lazer 文件同大小的候选、计算 SHA-256 与文件名比对，完全一致的
//!    副本用「临时硬链接 + rename」原子替换为指向 stable 的硬链接，释放重复
//!    占用的空间。逐文件校验同卷与同 inode，失败只记录不中断。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;
use walkdir::WalkDir;

use crate::platform;

/// 取消标志：同一时间只应有一个去重任务。
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// 单个失败条目的展示上限，避免异常文件系统撑爆结果。
const MAX_FAILURES: usize = 50;

// ---- 磁盘占用统计 ----

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub path: String,
    pub total_size: u64,
    /// 排除硬链接后的实际占用（硬链接文件的磁盘块与 stable 共享）。
    pub unique_size: u64,
    pub file_count: u64,
}

#[tauri::command]
pub async fn get_lazer_disk_usage() -> Result<DiskUsage, String> {
    let root = platform::lazer_files_root().ok_or("未找到 osu!lazer 数据目录")?;
    let path = root.display().to_string();
    tokio::task::spawn_blocking(move || {
        let mut total_size = 0u64;
        let mut unique_size = 0u64;
        let mut file_count = 0u64;
        for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
            let file = entry.path();
            if !file.is_file() {
                continue;
            }
            let Ok(metadata) = fs::metadata(file) else { continue };
            total_size += metadata.len();
            file_count += 1;
            if !hard_linked(file) {
                unique_size += metadata.len();
            }
        }
        Ok(DiskUsage {
            path,
            total_size,
            unique_size,
            file_count,
        })
    })
    .await
    .map_err(|join| join.to_string())?
}

/// 文件是否存在其他硬链接（链接数 > 1）。
#[cfg(not(windows))]
fn hard_linked(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path)
        .map(|metadata| metadata.nlink() > 1)
        .unwrap_or(false)
}

#[cfg(windows)]
fn hard_linked(path: &Path) -> bool {
    file_info(path).map(|info| info.links > 1).unwrap_or(false)
}

// ---- 压缩空间（与 stable 去重） ----

#[derive(Debug, Clone, Serialize)]
pub struct DedupeProgress {
    pub phase: &'static str,
    pub processed: usize,
    pub total: usize,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeFailure {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeResult {
    pub dry_run: bool,
    pub cancelled: bool,
    pub lazer_files_root: String,
    pub stable_root: String,
    pub lazer_file_count: u64,
    pub lazer_total_size: u64,
    pub already_linked_count: u64,
    pub already_linked_size: u64,
    pub hashed_stable_count: u64,
    pub candidate_count: u64,
    pub reclaimable_size: u64,
    pub linked_count: u64,
    pub linked_size: u64,
    pub skipped_cross_volume_count: u64,
    pub skipped_cross_volume_size: u64,
    pub failed_count: u64,
    pub failed: Vec<DedupeFailure>,
}

struct LazerFile {
    hash: String,
    size: u64,
    path: PathBuf,
    volume: u64,
}

#[tauri::command]
pub async fn dedupe_lazer_files(
    app: tauri::AppHandle,
    stable_root: String,
    dry_run: bool,
) -> Result<DedupeResult, String> {
    tokio::task::spawn_blocking(move || run(&app, PathBuf::from(stable_root), dry_run))
        .await
        .map_err(|join| join.to_string())?
}

#[tauri::command]
pub fn cancel_dedupe() {
    CANCELLED.store(true, Ordering::Relaxed);
}

fn run(app: &tauri::AppHandle, stable_root: PathBuf, dry_run: bool) -> Result<DedupeResult, String> {
    CANCELLED.store(false, Ordering::Relaxed);
    let reporter = ProgressReporter::new(app);
    let mut result = DedupeResult {
        dry_run,
        ..DedupeResult::default()
    };

    let lazer_root = platform::lazer_files_root()
        .filter(|root| root.join("files").is_dir())
        .map(|root| root.join("files"))
        .ok_or("未找到 osu!lazer 文件存储目录（数据目录下的 files）")?;
    if !stable_root.is_dir() {
        return Err("所选 stable 目录不存在".into());
    }
    // 统一入口：选的是 stable 根目录时自动定位 Songs 子目录。
    let stable_root = match stable_root.join("Songs") {
        songs if songs.is_dir() => songs,
        _ => stable_root,
    };
    result.lazer_files_root = lazer_root.display().to_string();
    result.stable_root = stable_root.display().to_string();

    // 1. 扫描 lazer 文件存储：已是硬链接的无需处理，其余待匹配。
    reporter.emit("scan-lazer", 0, 0, true);
    let mut pending: Vec<LazerFile> = Vec::new();
    for entry in WalkDir::new(&lazer_root).into_iter().filter_map(Result::ok) {
        if CANCELLED.load(Ordering::Relaxed) {
            result.cancelled = true;
            return Ok(result);
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(metadata) = fs::metadata(path) else { continue };
        result.lazer_file_count += 1;
        result.lazer_total_size += metadata.len();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_content_hash(name) {
            continue;
        }
        let Some(info) = file_info(path) else { continue };
        if info.links > 1 {
            result.already_linked_count += 1;
            result.already_linked_size += metadata.len();
            continue;
        }
        pending.push(LazerFile {
            hash: name.to_ascii_lowercase(),
            size: metadata.len(),
            path: path.to_path_buf(),
            volume: info.volume,
        });
    }
    if pending.is_empty() {
        return Ok(result);
    }

    // 2. 扫描 stable，只保留大小能对上待匹配 lazer 文件的候选。
    reporter.emit("scan-stable", 0, 0, true);
    let sizes: HashSet<u64> = pending.iter().map(|file| file.size).collect();
    let mut walked = 0usize;
    let mut candidates: Vec<(PathBuf, u64)> = Vec::new();
    for entry in WalkDir::new(&stable_root).into_iter().filter_map(Result::ok) {
        if CANCELLED.load(Ordering::Relaxed) {
            result.cancelled = true;
            return Ok(result);
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        walked += 1;
        if walked % 2048 == 0 {
            reporter.emit("scan-stable", walked, 0, false);
        }
        let Ok(metadata) = fs::metadata(path) else { continue };
        if sizes.contains(&metadata.len()) {
            candidates.push((path.to_path_buf(), metadata.len()));
        }
    }
    result.hashed_stable_count = candidates.len() as u64;

    // 3. 计算候选文件的 SHA-256，与 lazer 文件名（即哈希）匹配。
    reporter.emit("hash", 0, candidates.len(), true);
    let processed = AtomicUsize::new(0);
    let mut by_hash: HashMap<String, PathBuf> = HashMap::new();
    for (path, size) in &candidates {
        if CANCELLED.load(Ordering::Relaxed) {
            result.cancelled = true;
            return Ok(result);
        }
        if let Ok(hash) = hash_file_sized(path, *size) {
            by_hash.insert(hash, path.clone());
        }
        let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
        reporter.emit("hash", done, candidates.len(), false);
    }
    reporter.emit("hash", candidates.len(), candidates.len(), true);

    // 4. 匹配 + 同卷校验。跨卷（不同分区/文件系统）无法硬链接，单独计数。
    let mut pairs = Vec::new();
    for file in pending {
        if let Some(stable) = by_hash.get(&file.hash) {
            pairs.push((file, stable.clone()));
        }
    }
    let mut cross_volume = Vec::new();
    let mut pairs_on_volume = Vec::new();
    for (file, stable) in pairs {
        match file_info(&stable) {
            Some(info) if info.volume == file.volume => pairs_on_volume.push((file, stable)),
            _ => cross_volume.push((file, stable)),
        }
    }
    result.candidate_count = (pairs_on_volume.len() + cross_volume.len()) as u64;
    result.reclaimable_size = pairs_on_volume.iter().map(|(file, _)| file.size).sum();
    result.skipped_cross_volume_count = cross_volume.len() as u64;
    result.skipped_cross_volume_size = cross_volume.iter().map(|(file, _)| file.size).sum();
    if dry_run || pairs_on_volume.is_empty() {
        return Ok(result);
    }

    // 5. 逐个替换：临时硬链接 → rename 覆盖，中间态不出现半成品。
    let total = pairs_on_volume.len();
    reporter.emit("link", 0, total, true);
    for (index, (file, stable)) in pairs_on_volume.into_iter().enumerate() {
        if CANCELLED.load(Ordering::Relaxed) {
            result.cancelled = true;
            return Ok(result);
        }
        reporter.emit("link", index, total, false);
        match link_replace(&file, &stable) {
            Ok(()) => {
                result.linked_count += 1;
                result.linked_size += file.size;
            }
            Err(message) => record_failure(&mut result, &file.path, message),
        }
    }
    reporter.emit("link", total, total, true);
    Ok(result)
}

fn record_failure(result: &mut DedupeResult, path: &Path, message: String) {
    result.failed_count += 1;
    if result.failed.len() < MAX_FAILURES {
        result.failed.push(DedupeFailure {
            path: path.display().to_string(),
            message,
        });
    }
}

/// 把 lazer 副本替换为指向 stable 的硬链接（临时链接 + rename 原子替换）。
fn link_replace(file: &LazerFile, stable: &Path) -> Result<(), String> {
    let fresh = |path: &Path| fs::metadata(path).map(|metadata| metadata.len());
    if fresh(stable).unwrap_or(u64::MAX) != file.size {
        return Err("stable 文件在扫描后发生变化，已跳过".into());
    }
    if fresh(&file.path).unwrap_or(u64::MAX) != file.size {
        return Err("lazer 文件在扫描后发生变化，已跳过".into());
    }
    let temporary = file.path.with_extension("lazer-exporter-link");
    let _ = fs::remove_file(&temporary);
    if let Err(error) = fs::hard_link(stable, &temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法创建硬链接：{error}"));
    }
    if let Err(error) = fs::rename(&temporary, &file.path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法替换原文件：{error}"));
    }
    Ok(())
}

/// 读取文件计算 SHA-256；大小不符（扫描后变化）直接报错跳过。
fn hash_file_sized(path: &Path, expected_size: u64) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    if file.metadata()?.len() != expected_size {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "文件大小与扫描时不一致",
        ));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// lazer 文件名为内容哈希（64 位十六进制字符）；其他命名的文件不参与匹配。
fn is_content_hash(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

struct ProgressReporter<'a> {
    app: &'a tauri::AppHandle,
    last_emit: Mutex<Instant>,
}

impl<'a> ProgressReporter<'a> {
    fn new(app: &'a tauri::AppHandle) -> Self {
        Self {
            app,
            last_emit: Mutex::new(Instant::now() - Duration::from_secs(1)),
        }
    }

    fn emit(&self, phase: &'static str, processed: usize, total: usize, force: bool) {
        let Ok(mut last_emit) = self.last_emit.lock() else {
            return;
        };
        if !force && last_emit.elapsed() < Duration::from_millis(100) {
            return;
        }
        *last_emit = Instant::now();
        drop(last_emit);
        let percent = if total > 0 {
            ((processed as f64 / total as f64) * 1000.0).round() / 10.0
        } else {
            0.0
        };
        let _ = self.app.emit(
            "dedupe-progress",
            DedupeProgress {
                phase,
                processed,
                total,
                percent: percent.min(100.0),
            },
        );
    }
}

/// 文件标识：卷/设备号 + 硬链接数，用于同卷与已链接判断。
struct FileInfo {
    volume: u64,
    links: u32,
}

#[cfg(not(windows))]
fn file_info(path: &Path) -> Option<FileInfo> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path).ok()?;
    Some(FileInfo {
        volume: metadata.dev(),
        links: metadata.nlink() as u32,
    })
}

#[cfg(windows)]
fn file_info(path: &Path) -> Option<FileInfo> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ,
        FILE_SHARE_WRITE, GetFileInformationByHandle, OPEN_EXISTING,
    };

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        let ok = GetFileInformationByHandle(handle, &mut info);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        Some(FileInfo {
            volume: info.dwVolumeSerialNumber as u64,
            links: info.nNumberOfLinks,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_content_hashes() {
        assert!(is_content_hash(&"a".repeat(64)));
        assert!(!is_content_hash(&"a".repeat(32)));
        assert!(!is_content_hash("song-title.mp3"));
    }

    #[test]
    fn hashes_files() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("data.bin");
        fs::write(&path, b"opp").expect("write file");
        assert_eq!(
            hash_file_sized(&path, 3).expect("hash file"),
            // sha256("opp") 的十六进制表示
            "591a0354f0692cb69c9d592a101cecec3efa25be9cbc0029e58447ca2fcb3de3"
        );
    }

    #[test]
    fn replaces_duplicate_with_hard_link() {
        let directory = tempfile::tempdir().expect("temp directory");
        let stable = directory.path().join("stable.bin");
        let lazer = directory.path().join("lazer.bin");
        fs::write(&stable, b"duplicate content").expect("write stable");
        fs::write(&lazer, b"duplicate content").expect("write lazer");
        let file = LazerFile {
            hash: hash_file_sized(&stable, 17).expect("hash"),
            size: 17,
            path: lazer.clone(),
            volume: file_info(&stable).expect("stable info").volume,
        };
        link_replace(&file, &stable).expect("link replace");
        assert_eq!(fs::read(&lazer).expect("read lazer"), b"duplicate content");
        assert_eq!(file_info(&lazer).expect("lazer info").links, 2);
        assert!(!lazer.with_extension("lazer-exporter-link").exists());
    }
}
