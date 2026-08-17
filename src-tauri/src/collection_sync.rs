//! 集合管理（参考 OPP 的 collections 模块语义，数据格式用 osu-db 库读写）：
//! 以 stable 目录的 collection.db 为操作对象——
//! - 同步（导出）：把 lazer 收藏夹写入 collection.db，追加（同名合并）或替换模式；
//! - 导入：把外部 collection.db 合并进 stable 的 collection.db（追加/替换），
//!   lazer 检测到 stable 目录后可在游戏内“从 stable 导入收藏夹”；
//! - 删除：从 collection.db 移除收藏夹。
//! osu!.db 用于定位：MD5 → stable 谱面集编号/文件夹，报告每个收藏夹在
//! stable 与 lazer 两侧的匹配情况。写盘前自动备份原 collection.db。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use osu_db::collection::{Collection, CollectionList};
use osu_db::listing::Listing;
use serde::Serialize;

use crate::lazer_realm;
use crate::platform;
use crate::state::CachedLibrary;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatmapRef {
    pub md5: String,
    /// “artist - title [难度]”定位标签（优先 lazer，回退 osu!.db）。
    pub label: String,
    /// 在对侧数据库中能否定位到。
    pub matched: bool,
    /// 谱面集封面 blob 的 SHA-256（来自 lazer；定位不到为 None）。
    pub cover: Option<String>,
    /// stable 谱面集文件夹内最大图片的绝对路径（lazer 无封面时回退）。
    pub stable_cover: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LazerCollectionInfo {
    pub name: String,
    /// MD5 能在 stable（osu!.db）中定位到的数量。
    pub matched_in_stable: usize,
    pub beatmaps: Vec<BeatmapRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StableCollectionInfo {
    pub name: String,
    /// MD5 能在 lazer（client.realm）中定位到的数量。
    pub matched_in_lazer: usize,
    /// 至少一个条目能在 osu!.db 定位到的谱面集文件夹示例（用于核对目录）。
    pub sample_folder: String,
    pub beatmaps: Vec<BeatmapRef>,
}

/// 一份“集合 → 选中的谱面 MD5”选择（操作粒度为单张谱面）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSelection {
    pub name: String,
    pub md5s: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPage {
    pub stable_dir: String,
    pub has_osu_db: bool,
    pub has_collection_db: bool,
    pub osu_db_beatmaps: usize,
    pub lazer_collections: Vec<LazerCollectionInfo>,
    pub stable_collections: Vec<StableCollectionInfo>,
}

fn realm_library(
    cache: &std::sync::Arc<CachedLibrary>,
) -> Result<lazer_realm::RealmLibrary, String> {
    cache.get_or_parse()
}

/// 副本模式：所有写操作输出到 collection.db 旁边的 collection.export.db，
/// 原文件永不被修改；确认无误后由用户手动替换。
fn export_copy_path(collection_db: &Path) -> PathBuf {
    collection_db.with_file_name("collection.export.db")
}

/// 读取基础数据：副本存在时以副本为准（连续操作在副本上叠加），否则读原文件。
fn read_write_base(collection_db: &Path) -> CollectionList {
    let copy = export_copy_path(collection_db);
    if copy.is_file() {
        return read_collection_db_path(&copy);
    }
    read_collection_db_path(collection_db)
}

fn read_collection_db_path(path: &Path) -> CollectionList {
    if path.is_file() {
        CollectionList::from_file(path).unwrap_or(CollectionList {
            version: 0,
            collections: Vec::new(),
        })
    } else {
        CollectionList {
            version: 0,
            collections: Vec::new(),
        }
    }
}

/// 在 Songs/<folder> 里找最大的图片文件作为封面（结果按文件夹缓存）。
fn stable_folder_cover(
    songs_root: &Path,
    folder: &str,
    cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    if let Some(cached) = cache.get(folder) {
        return cached.clone();
    }
    let dir = songs_root.join(folder);
    let mut best: Option<(u64, PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let lower = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if !matches!(lower.as_str(), "jpg" | "jpeg" | "png" | "webp") {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if best.as_ref().is_none_or(|(s, _)| size > *s) {
                best = Some((size, path));
            }
        }
    }
    let result = best.map(|(_, path)| path.display().to_string());
    cache.insert(folder.to_string(), result.clone());
    result
}

fn collection_md5s(collection: &Collection) -> Vec<String> {
    // collection.db 里同一难度也可能收藏多次，去重保证行数与选择集一致。
    let mut seen = HashSet::new();
    collection
        .beatmap_hashes
        .iter()
        .filter_map(|hash| hash.clone())
        .filter(|md5| seen.insert(md5.clone()))
        .collect()
}

/// 加载集合管理页数据：解析 realm 收藏夹、collection.db、osu!.db 并交叉定位。
#[tauri::command]
pub async fn load_collection_page(
    cache: tauri::State<'_, std::sync::Arc<CachedLibrary>>,
    stable_dir: String,
) -> Result<CollectionPage, String> {
    let cache = cache.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut stable = PathBuf::from(&stable_dir);
        if !stable.is_dir() {
            return Err("stable 目录不存在".into());
        }
        // 统一入口：选到 Songs 子目录时回溯到 stable 根目录找 osu!.db。
        if !stable.join("osu!.db").is_file() && stable.file_name().is_some_and(|n| n == "Songs") {
            if let Some(parent) = stable.parent() {
                stable = parent.to_path_buf();
            }
        }
        let osu_db_path = stable.join("osu!.db");
        let collection_db_path = stable.join("collection.db");
        let songs_root = stable.join("Songs");
        let has_osu_db = osu_db_path.is_file();
        let has_collection_db = collection_db_path.is_file();
        if !has_osu_db {
            return Err("所选目录中没有 osu!.db（应为 stable 根目录，含 Songs）".into());
        }

        // lazer 侧：realm 的收藏夹与“MD5 → 谱面定位标签”索引。
        let library = realm_library(&cache)?;
        let mut lazer_md5s: HashSet<String> = HashSet::new();
        let mut lazer_labels: HashMap<String, String> = HashMap::new();
        let mut lazer_covers: HashMap<String, String> = HashMap::new();
        for set in &library.sets {
            let artist = if set.artist_unicode.trim().is_empty() {
                set.artist.as_str()
            } else {
                set.artist_unicode.as_str()
            };
            let title = if set.title_unicode.trim().is_empty() {
                set.title.as_str()
            } else {
                set.title_unicode.as_str()
            };
            let cover = set.cover_hash.clone();
            for beatmap in &set.beatmaps {
                if beatmap.md5.is_empty() {
                    continue;
                }
                lazer_md5s.insert(beatmap.md5.clone());
                if let Some(cover) = &cover {
                    lazer_covers.insert(beatmap.md5.clone(), cover.clone());
                }
                lazer_labels.insert(
                    beatmap.md5.clone(),
                    format!("{artist} - {title} [{}]", beatmap.name),
                );
            }
        }

        // stable 侧：osu!.db 的 MD5 → 谱面集文件夹。
        let listing = Listing::from_file(&osu_db_path).map_err(|e| format!("解析 osu!.db 失败：{e}"))?;
        let mut stable_md5_to_folder: HashMap<String, String> = HashMap::new();
        for beatmap in &listing.beatmaps {
            if let (Some(hash), Some(folder)) = (&beatmap.hash, &beatmap.folder_name) {
                stable_md5_to_folder.insert(hash.clone(), folder.clone());
            }
        }

        // osu!.db 侧的谱面定位标签（lazer 找不到时回退）。
        let mut stable_labels: HashMap<String, String> = HashMap::new();
        let mut cover_cache: HashMap<String, Option<String>> = HashMap::new();
        for beatmap in &listing.beatmaps {
            if let Some(hash) = &beatmap.hash {
                let artist = beatmap
                    .artist_unicode
                    .clone()
                    .or_else(|| beatmap.artist_ascii.clone())
                    .unwrap_or_default();
                let title = beatmap
                    .title_unicode
                    .clone()
                    .or_else(|| beatmap.title_ascii.clone())
                    .unwrap_or_default();
                let diff = beatmap.difficulty_name.clone().unwrap_or_default();
                stable_labels.insert(hash.clone(), format!("{artist} - {title} [{diff}]"));
            }
        }

        let lazer_collections = library
            .collections
            .iter()
            .map(|collection| {
                let beatmaps: Vec<BeatmapRef> = collection
                    .md5s
                    .iter()
                    .map(|md5| BeatmapRef {
                        md5: md5.clone(),
                        label: lazer_labels
                            .get(md5)
                            .cloned()
                            .or_else(|| stable_labels.get(md5).cloned())
                            .unwrap_or_default(),
                        matched: stable_md5_to_folder.contains_key(md5),
                        cover: lazer_covers.get(md5).cloned(),
                        stable_cover: None,
                    })
                    .collect();
                let matched_in_stable = beatmaps.iter().filter(|b| b.matched).count();
                LazerCollectionInfo {
                    name: collection.name.clone(),
                    matched_in_stable,
                    beatmaps,
                }
            })
            .collect();

        // 工作副本模型：读取时若无副本则立即从原 collection.db 创建，
        // 之后所有读写都在副本上进行；重新读取会先删副本再重建（舍弃修改）。
        let copy_path = export_copy_path(&collection_db_path);
        if !copy_path.is_file() && collection_db_path.is_file() {
            std::fs::copy(&collection_db_path, &copy_path)
                .map_err(|e| format!("创建工作副本失败：{e}"))?;
        }
        let stable_list = read_write_base(&collection_db_path);
        let stable_collections = stable_list
            .collections
            .iter()
            .map(|collection| {
                let md5s = collection_md5s(collection);
                let sample_folder = md5s
                    .iter()
                    .find_map(|md5| stable_md5_to_folder.get(md5).cloned())
                    .unwrap_or_default();
                // 封面：优先 lazer；没有则按 osu!.db 的文件夹名去 Songs
                // 里找该谱面集文件夹中最大的图片（按文件夹缓存一次）。
                let beatmaps: Vec<BeatmapRef> = md5s
                    .iter()
                    .map(|md5| {
                        let in_lazer = lazer_md5s.contains(md5);
                        let lazer_cover = lazer_covers.get(md5).cloned();
                        let stable_cover = if lazer_cover.is_none() {
                            stable_md5_to_folder
                                .get(md5)
                                .and_then(|folder| stable_folder_cover(&songs_root, folder, &mut cover_cache))
                        } else {
                            None
                        };
                        BeatmapRef {
                            md5: md5.clone(),
                            label: lazer_labels
                                .get(md5)
                                .cloned()
                                .or_else(|| stable_labels.get(md5).cloned())
                                .unwrap_or_default(),
                            matched: in_lazer,
                            cover: lazer_cover,
                            stable_cover,
                        }
                    })
                    .collect();
                let matched_in_lazer = beatmaps.iter().filter(|b| b.matched).count();
                StableCollectionInfo {
                    name: collection.name.clone().unwrap_or_default(),
                    matched_in_lazer,
                    sample_folder,
                    beatmaps,
                }
            })
            .collect();

        Ok(CollectionPage {
            stable_dir,
            has_osu_db,
            has_collection_db,
            osu_db_beatmaps: listing.beatmaps.len(),
            lazer_collections,
            stable_collections,
        })
    })
    .await
    .map_err(|join| join.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub mode: String,
    pub written_collections: usize,
    pub written_hashes: usize,
    /// 副本文件路径（原 collection.db 未被修改）。
    pub backup: String,
    /// 同时导出的谱面集文件夹数（0 = 未启用）。
    pub folders_written: usize,
}

/// 同步（导出）所选谱面 → stable collection.db（粒度为单张谱面）。
/// selections = 每个收藏夹要写入的 MD5 列表。
/// mode = "append"（同名合并）| "replace"（collection.db 只保留所选内容）。
#[tauri::command]
pub async fn sync_collections(
    cache: tauri::State<'_, std::sync::Arc<CachedLibrary>>,
    stable_dir: String,
    selections: Vec<CollectionSelection>,
    mode: String,
) -> Result<SyncResult, String> {
    let _ = &cache;
    tokio::task::spawn_blocking(move || {
        if selections.iter().all(|s| s.md5s.is_empty()) {
            return Err("未选择任何谱面".into());
        }
        let selections: Vec<CollectionSelection> = selections
            .into_iter()
            .filter(|s| !s.md5s.is_empty())
            .collect();
        let stable = PathBuf::from(&stable_dir);
        let collection_db = stable.join("collection.db");
        let mut list = read_write_base(&collection_db);
        let out_path = export_copy_path(&collection_db);

        let mut written_hashes = 0usize;
        if mode == "replace" {
            // 替换模式：collection.db 重写为所选的集合与谱面。
            list.collections.clear();
            for selection in &selections {
                written_hashes += selection.md5s.len();
                list.collections.push(Collection {
                    name: Some(selection.name.clone()),
                    beatmap_hashes: selection.md5s.iter().map(|md5| Some(md5.clone())).collect(),
                });
            }
        } else {
            // 追加模式：同名合并（并集，保序），新收藏夹追加到末尾。
            for selection in &selections {
                written_hashes += selection.md5s.len();
                if let Some(existing) = list
                    .collections
                    .iter_mut()
                    .find(|c| c.name.as_deref() == Some(selection.name.as_str()))
                {
                    let mut merged: Vec<Option<String>> = existing.beatmap_hashes.clone();
                    let seen: HashSet<String> = merged.iter().filter_map(|h| h.clone()).collect();
                    for md5 in &selection.md5s {
                        if !seen.contains(md5) {
                            merged.push(Some(md5.clone()));
                        }
                    }
                    existing.beatmap_hashes = merged;
                } else {
                    list.collections.push(Collection {
                        name: Some(selection.name.clone()),
                        beatmap_hashes: selection
                            .md5s
                            .iter()
                            .map(|md5| Some(md5.clone()))
                            .collect(),
                    });
                }
            }
        }

        let written = list.collections.len();
        list.to_file(&out_path)
            .map_err(|e| format!("写入 collection.export.db 失败：{e}"))?;

        Ok(SyncResult {
            mode,
            written_collections: written,
            written_hashes,
            backup: out_path.display().to_string(),
            folders_written: 0,
        })
    })
    .await
    .map_err(|join| join.to_string())?
}

/// 导出所选收藏夹涉及的谱面集（去重）。与主导出同一套流程：格式
/// （archive=.osz / folder=文件夹）、硬链接、覆盖、跳过、进度与终止全部生效。
#[tauri::command]
pub async fn export_selected_sets(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, crate::exporter::ExportCancel>,
    cache: tauri::State<'_, std::sync::Arc<CachedLibrary>>,
    md5s: Vec<String>,
    out_dir: String,
    format: Option<String>,
    hardlink: Option<bool>,
    overwrite: Option<bool>,
) -> Result<crate::exporter::ExportResult, String> {
    let cache = cache.inner().clone();
    let folder = format.as_deref().is_some_and(crate::exporter::is_folder);
    let hardlink = hardlink.unwrap_or(false);
    let overwrite = overwrite.unwrap_or(false);
    crate::exporter::export_loop(app, cancel.0.clone(), out_dir, move |_out, notices, skipped| {
        if md5s.is_empty() {
            return Err("未选择任何谱面".into());
        }
        let library = realm_library(&cache)?;
        let files_root = platform::lazer_files_root().ok_or("无法确定 lazer 文件存储目录")?;
        export_sets_for_md5s(
            &library,
            &files_root,
            &md5s,
            folder,
            hardlink,
            overwrite,
            &notices,
            &skipped,
        )
    })
    .await
}

/// 按 MD5 集合生成谱面集导出条目（同一谱面集只导出一次）。
/// 返回（展示名, 写盘闭包）列表，交给 export_loop 执行。
#[allow(clippy::type_complexity)]
fn export_sets_for_md5s(
    library: &lazer_realm::RealmLibrary,
    files_root: &Path,
    md5s: &[String],
    folder: bool,
    hardlink: bool,
    overwrite: bool,
    notices: &std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    skipped: &std::sync::Arc<std::sync::Mutex<usize>>,
) -> Result<Vec<(String, Box<dyn FnOnce(&Path, &dyn Fn(&str)) -> Result<(), String> + Send>)>, String> {
    use std::collections::HashSet;

    let mut md5_to_set_id: HashMap<&str, &str> = HashMap::new();
    for set in &library.sets {
        for beatmap in &set.beatmaps {
            if !beatmap.md5.is_empty() {
                md5_to_set_id.insert(beatmap.md5.as_str(), set.id.as_str());
            }
        }
    }
    let mut exported_ids: HashSet<&str> = HashSet::new();
    let mut items: Vec<(String, Box<dyn FnOnce(&Path, &dyn Fn(&str)) -> Result<(), String> + Send>)> =
        Vec::new();
    for md5 in md5s {
        let Some(set_id) = md5_to_set_id.get(md5.as_str()) else {
            continue;
        };
        if !exported_ids.insert(set_id) {
            continue;
        }
        let Some(set) = library.sets.iter().find(|s| s.id == *set_id) else {
            continue;
        };
        let mut name = format!("{} - {}", set.artist, set.title);
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
        let files_root = files_root.to_path_buf();
        if folder {
            let out_name = crate::exporter::sanitize(&name);
            let notices = std::sync::Arc::clone(notices);
            let skipped = std::sync::Arc::clone(skipped);
            items.push((
                out_name.clone(),
                Box::new(move |out: &Path, report: &dyn Fn(&str)| {
                    crate::exporter::write_folder(
                        out,
                        &out_name,
                        &files_root,
                        &entries,
                        hardlink,
                        overwrite,
                        &notices,
                        &skipped,
                        report,
                    )
                }),
            ));
        } else {
            let osz = format!("{}.osz", crate::exporter::sanitize(&name));
            let skipped = std::sync::Arc::clone(skipped);
            items.push((
                osz.clone(),
                Box::new(move |out: &Path, _report: &dyn Fn(&str)| {
                    if out.join(&osz).exists() && !overwrite {
                        if let Ok(mut count) = skipped.lock() {
                            *count += 1;
                        }
                        return Ok(());
                    }
                    crate::exporter::write_zip(&out.join(&osz), &files_root, &entries)
                }),
            ));
        }
    }
    Ok(items)
}

/// 把工作副本导出为指定文件（可重命名、可替换既有文件，由保存对话框决定）。
#[tauri::command]
pub async fn export_collection_copy(
    stable_dir: String,
    target_file: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let copy = PathBuf::from(&stable_dir).join("collection.export.db");
        if !copy.is_file() {
            return Err("工作副本不存在，请先读取数据".into());
        }
        let target = PathBuf::from(&target_file);
        std::fs::copy(&copy, &target)
            .map_err(|e| format!("导出失败：{e}"))
            .map(|_| target.display().to_string())
    })
    .await
    .map_err(|join| join.to_string())?
}

/// 丢弃副本：删除 collection.export.db，重新读取时回到原 collection.db 的状态。
#[tauri::command]
pub async fn discard_collection_changes(stable_dir: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let copy = PathBuf::from(&stable_dir).join("collection.export.db");
        if copy.is_file() {
            std::fs::remove_file(&copy).map_err(|e| format!("删除副本失败：{e}"))?;
            Ok(true)
        } else {
            Ok(false)
        }
    })
    .await
    .map_err(|join| join.to_string())?
}

/// 从 stable collection.db 的收藏夹中删除所选谱面（集合清空后整个移除）。
#[tauri::command]
pub async fn delete_stable_collections(
    stable_dir: String,
    selections: Vec<CollectionSelection>,
) -> Result<SyncResult, String> {
    tokio::task::spawn_blocking(move || {
        if selections.iter().all(|s| s.md5s.is_empty()) {
            return Err("未选择任何谱面".into());
        }
        let stable = PathBuf::from(&stable_dir);
        let collection_db = stable.join("collection.db");
        if !collection_db.is_file() && !export_copy_path(&collection_db).is_file() {
            return Err("stable 目录中没有 collection.db".into());
        }
        let mut list = read_write_base(&collection_db);
        let out_path = export_copy_path(&collection_db);
        let mut removed = 0usize;
        for selection in &selections {
            let Some(existing) = list
                .collections
                .iter_mut()
                .find(|c| c.name.as_deref() == Some(selection.name.as_str()))
            else {
                continue;
            };
            let remove: HashSet<&str> = selection.md5s.iter().map(String::as_str).collect();
            let before = existing.beatmap_hashes.len();
            existing
                .beatmap_hashes
                .retain(|hash| !remove.contains(hash.as_deref().unwrap_or("")));
            removed += before - existing.beatmap_hashes.len();
        }
        // 清空的收藏夹整个移除。
        list.collections.retain(|c| !c.beatmap_hashes.is_empty());
        if removed == 0 {
            return Err("没有匹配到可删除的谱面".into());
        }
        let written = list.collections.len();
        list.to_file(&out_path)
            .map_err(|e| format!("写入 collection.export.db 失败：{e}"))?;
        Ok(SyncResult {
            mode: "delete".into(),
            written_collections: written,
            written_hashes: removed,
            backup: out_path.display().to_string(),
            folders_written: 0,
        })
    })
    .await
    .map_err(|join| join.to_string())?
}
