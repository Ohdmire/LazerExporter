//! 通过 realm-db-reader 只读解析 lazer 的 client.realm：
//! 谱面集、皮肤、回放（Score）、收藏夹（BeatmapCollection）。
//! 读取时先复制快照到临时目录，避免与正在运行的 lazer 争抢 .lock 文件。
//! 解析逻辑（表加载策略、链接解引用）参考 OPP 的 local_analysis::lazer_realm。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use realm_db_reader::{Group, Link, Realm, Row, Value};
use serde::Serialize;

use crate::platform;

/// 行数不超过该阈值的表整表全载；超过的表按行懒加载。
const BULK_ROW_LIMIT: usize = 50_000;


#[derive(Debug, Clone, Serialize)]
pub struct RealmFile {
    pub filename: String,
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RealmBeatmap {
    pub sha256: String,
    pub md5: String,
    pub online_id: i64,
    /// 计算好的星级（class_Beatmap 的 StarRating）。
    pub star_rating: f64,
    /// 所属模式短名（class_Ruleset 的 ShortName：osu/taiko/fruits/mania）。
    pub ruleset: String,
    /// 难度名（class_Beatmap 的 DifficultyName），供 `diff=` 搜索。
    pub name: String,
    /// 以下均为 lazer 搜索语法所需的难度属性。
    pub ar: f64,
    pub dr: f64,
    pub cs: f64,
    pub od: f64,
    pub bpm: f64,
    /// 时长（毫秒）。
    pub length_ms: f64,
    /// 在线状态（class_Beatmap.Status，BeatmapOnlineStatus 枚举值）。
    pub status: i64,
    /// 上次游玩时间（YYYY-MM-DD HH:MM；从未玩过为空）。
    pub last_played: String,
    pub divisor: i64,
    /// Metadata 的 Source / Tags（空格分隔），供 `source=` / `tag=` 搜索。
    pub source: String,
    pub tags: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RealmSet {
    pub id: String,
    pub online_id: i64,
    pub artist: String,
    pub artist_unicode: String,
    pub title: String,
    pub title_unicode: String,
    pub creator: String,
    /// 谱面集导入 lazer 的时间（class_BeatmapSet 的 DateAdded）。
    pub date_added: String,
    /// 谱面集封面（第一张难度 .osu [Events] 段声明的背景图）blob 的 SHA-256。
    /// 找不到背景声明时回退到谱面集里最大的图片文件；都没有则为 None。
    pub cover_hash: Option<String>,
    pub beatmaps: Vec<RealmBeatmap>,
    pub files: Vec<RealmFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RealmSkin {
    pub id: String,
    pub name: String,
    pub creator: String,
    pub files: Vec<RealmFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RealmScore {
    pub id: String,
    /// 回放文件（files/ blob）的 SHA-256；导出为 .osr 时按它取文件。
    pub replay_hash: String,
    pub replay_size: u64,
    pub beatmap: String,
    /// 罗马字版本的谱面名（供导出文件名跟随 Unicode 开关）。
    pub beatmap_romanized: String,
    pub difficulty: String,
    pub rank: i64,
    pub total_score: i64,
    pub accuracy: f64,
    pub max_combo: i64,
    pub date: String,
    pub mods: String,
    /// 成绩所属模式短名（class_Ruleset 的 ShortName：osu/taiko/fruits/mania）。
    pub ruleset: String,
    /// 所属谱面集 id（经 BeatmapInfo → BeatmapSet 链接），用于取封面。
    pub set_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RealmCollection {
    pub name: String,
    /// 收藏夹按谱面 MD5 关联难度；这里已折算成所属谱面集的 id。
    pub set_ids: Vec<String>,
    /// 原始的难度 MD5 列表（collection.db 的原生格式），供导出/同步使用。
    pub md5s: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct RealmLibrary {
    pub sets: Vec<RealmSet>,
    pub skins: Vec<RealmSkin>,
    pub scores: Vec<RealmScore>,
    pub collections: Vec<RealmCollection>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryResult {
    pub realm_path: String,
    pub library: RealmLibrary,
}

#[tauri::command]
pub async fn list_library(
    cache: tauri::State<'_, std::sync::Arc<crate::state::CachedLibrary>>,
) -> Result<LibraryResult, String> {
    let realm_path = platform::lazer_data_root()
        .filter(|root| root.join("client.realm").is_file())
        .map(|root| root.join("client.realm"))
        .ok_or_else(|| "未找到 osu!lazer 数据目录（client.realm）".to_string())?;
    let realm_path_display = realm_path.display().to_string();

    let cache = cache.inner().clone();
    tokio::task::spawn_blocking(move || {
        let library = cache.refresh()?;
        Ok(LibraryResult {
            realm_path: realm_path_display,
            library,
        })
    })
    .await
    .map_err(|join| join.to_string())?
}

/// stat 出每个文件条目在 files/ 中的实际大小，并剔除 blob 缺失的条目。
pub fn attach_file_sizes(library: &mut RealmLibrary) -> Result<(), String> {
    let files_root = platform::lazer_files_root().ok_or("无法确定 lazer 文件存储目录")?;
    fn size_of(files_root: &Path, hash: &str) -> u64 {
        std::fs::metadata(
            files_root.join("files").join(platform::blob_relative_path(hash)),
        )
        .map(|m| m.len())
        .unwrap_or(0)
    }
    for set in &mut library.sets {
        set.files.retain_mut(|file| {
            file.size = size_of(&files_root, &file.hash);
            file.size > 0
        });
        set.cover_hash = set_cover_hash(&files_root, set);
    }
    library.sets.retain(|set| !set.files.is_empty());
    for skin in &mut library.skins {
        skin.files.retain_mut(|file| {
            file.size = size_of(&files_root, &file.hash);
            file.size > 0
        });
    }
    library.skins.retain(|skin| !skin.files.is_empty());
    for score in &mut library.scores {
        score.replay_size = size_of(&files_root, &score.replay_hash);
    }
    library.scores.retain(|score| score.replay_size > 0);
    Ok(())
}

/// 供导出命令复用：解析 realm 得到完整资料库。
pub fn parse_realm_blocking(realm_path: &Path) -> Result<RealmLibrary, String> {
    parse_realm(realm_path)
}

fn snapshot_realm(realm_path: &Path) -> Result<PathBuf, String> {
    let snapshot =
        std::env::temp_dir().join(format!("lazer-exporter-realm-{}.realm", std::process::id()));
    std::fs::copy(realm_path, &snapshot)
        .map_err(|error| format!("复制 client.realm 快照失败：{error}"))?;
    Ok(snapshot)
}

fn parse_realm(realm_path: &Path) -> Result<RealmLibrary, String> {
    let snapshot = snapshot_realm(realm_path)?;
    let result = (|| {
        let realm = Realm::open(&snapshot).map_err(|e| format!("打开 client.realm 失败：{e}"))?;
        let group = realm
            .into_group()
            .map_err(|e| format!("读取 Realm 组失败：{e}"))?;
        let mut store = RowStore::new(&group);
        let mut library = RealmLibrary::default();

        parse_beatmap_sets(&mut store, &mut library)?;
        parse_skins(&mut store, &mut library)?;
        parse_scores(&mut store, &mut library)?;
        parse_collections(&mut store, &mut library)?;

        Ok(library)
    })();
    let _ = std::fs::remove_file(&snapshot);
    result
}

fn parse_beatmap_sets(store: &mut RowStore<'_>, library: &mut RealmLibrary) -> Result<(), String> {
    for row in store.bulk_rows("class_BeatmapSet")? {
        if matches!(row.get("DeletePending"), Some(Value::Bool(true))) {
            continue;
        }
        let files = resolve_named_files(store, row.get("Files"))?;
        let mut beatmaps = Vec::new();
        if let Some(Value::LinkList(links)) = row.get("Beatmaps") {
            for link in links {
                let Some(beatmap) = store.row(link)? else { continue };
                let sha256 = string_value(beatmap.get("Hash"));
                if sha256.is_empty() || !files.iter().any(|file| file.hash == sha256) {
                    continue;
                }
                // Difficulty / Metadata 里的搜索属性。
                let difficulty_row = match beatmap.get("Difficulty") {
                    Some(Value::Link(link)) => store.row(link)?,
                    _ => None,
                };
                let (ar, dr, cs, od) = match difficulty_row {
                    Some(diff) => (
                        float_value(diff.get("ApproachRate")),
                        float_value(diff.get("DrainRate")),
                        float_value(diff.get("CircleSize")),
                        float_value(diff.get("OverallDifficulty")),
                    ),
                    None => (0.0, 0.0, 0.0, 0.0),
                };
                let metadata_row = match beatmap.get("Metadata") {
                    Some(Value::Link(link)) => store.row(link)?,
                    _ => None,
                };
                let (source, tags) = match metadata_row {
                    Some(meta) => (
                        string_value(meta.get("Source")),
                        string_value(meta.get("Tags")),
                    ),
                    None => (String::new(), String::new()),
                };
                beatmaps.push(RealmBeatmap {
                    sha256,
                    md5: string_value(beatmap.get("MD5Hash")),
                    online_id: int_value(beatmap.get("OnlineID"), -1),
                    star_rating: double_value(beatmap.get("StarRating"), 0.0),
                    ruleset: ruleset_short_name(store, beatmap.get("Ruleset")),
                    name: string_value(beatmap.get("DifficultyName")),
                    ar,
                    dr,
                    cs,
                    od,
                    bpm: double_value(beatmap.get("BPM"), 0.0),
                    length_ms: double_value(beatmap.get("Length"), 0.0),
                    status: int_value(beatmap.get("Status"), -3),
                    last_played: timestamp_value(beatmap.get("LastPlayed")),
                    divisor: int_value(beatmap.get("BeatDivisor"), 0),
                    source,
                    tags,
                });
            }
        }
        if beatmaps.is_empty() {
            continue;
        }

        // 元数据取第一张难度关联的 BeatmapMetadata（与 lazer 自身行为一致）。
        let metadata = row
            .get("Beatmaps")
            .and_then(first_link)
            .and_then(|link| store.row(link).ok().flatten())
            .and_then(|beatmap| match beatmap.get("Metadata") {
                Some(Value::Link(link)) => Some(link.clone()),
                _ => None,
            })
            .and_then(|link| store.row(&link).ok().flatten());
        let (artist, artist_unicode, title, title_unicode, creator) = match metadata {
            Some(metadata) => {
                let artist = string_value(metadata.get("Artist"));
                let title = string_value(metadata.get("Title"));
                (
                    artist.clone(),
                    non_empty_or(string_value(metadata.get("ArtistUnicode")), artist),
                    title.clone(),
                    non_empty_or(string_value(metadata.get("TitleUnicode")), title),
                    match metadata.get("Author") {
                        Some(Value::Link(user_link)) => store
                            .row(user_link)
                            .ok()
                            .flatten()
                            .map(|user| string_value(user.get("Username")))
                            .unwrap_or_default(),
                        _ => String::new(),
                    },
                )
            }
            None => (String::new(), String::new(), String::new(), String::new(), String::new()),
        };

        library.sets.push(RealmSet {
            id: uuid_string(row.get("ID")),
            date_added: timestamp_value(row.get("DateAdded")),
            online_id: int_value(row.get("OnlineID"), -1),
            artist,
            artist_unicode,
            title,
            title_unicode,
            creator,
            cover_hash: None,
            beatmaps,
            files,
        });
    }
    Ok(())
}

fn parse_skins(store: &mut RowStore<'_>, library: &mut RealmLibrary) -> Result<(), String> {
    for row in store.bulk_rows("class_Skin")? {
        if matches!(row.get("DeletePending"), Some(Value::Bool(true))) {
            continue;
        }
        let files = resolve_named_files(store, row.get("Files"))?;
        // 内置皮肤（Argon/Triangles 等）没有文件列表，无法导出。
        if !files.iter().any(|file| file.filename.eq_ignore_ascii_case("skin.ini")) {
            continue;
        }
        library.skins.push(RealmSkin {
            id: uuid_string(row.get("ID")),
            name: string_value(row.get("Name")),
            creator: string_value(row.get("Creator")),
            files,
        });
    }
    Ok(())
}

fn parse_scores(store: &mut RowStore<'_>, library: &mut RealmLibrary) -> Result<(), String> {
    for row in store.bulk_rows("class_Score")? {
        if matches!(row.get("DeletePending"), Some(Value::Bool(true))) {
            continue;
        }
        // Files 链接到 RealmNamedFileUsage（文件名即 .osr 名），再经 File 链接到
        // 回放 blob；没有文件就是没有回放数据（比如仅导入了成绩信息）。
        let replay_files = resolve_named_files(store, row.get("Files"))?;
        let replay_hash = replay_files
            .iter()
            .find(|file| file.filename.to_ascii_lowercase().ends_with(".osr"))
            .or_else(|| replay_files.first())
            .map(|file| file.hash.clone())
            .unwrap_or_default();
        if replay_hash.is_empty() {
            continue;
        }

        let beatmap_row = match row.get("BeatmapInfo") {
            Some(Value::Link(link)) => store.row(link)?,
            _ => None,
        };
        let (beatmap, beatmap_romanized, difficulty, set_id) = match beatmap_row {
            Some(beatmap_info) => {
                let difficulty = string_value(beatmap_info.get("DifficultyName"));
                // BeatmapInfo → BeatmapSet 链接，取谱面集 id（用于封面）。
                let set_id = match beatmap_info.get("BeatmapSet") {
                    Some(Value::Link(link)) => store
                        .row(link)?
                        .map(|set| uuid_string(set.get("ID")))
                        .unwrap_or_default(),
                    _ => String::new(),
                };
                let metadata = match beatmap_info.get("Metadata") {
                    Some(Value::Link(link)) => store.row(link)?,
                    _ => None,
                };
                let (beatmap, beatmap_romanized) = match metadata {
                    Some(metadata) => (
                        format!(
                            "{} - {}",
                            non_empty_or(string_value(metadata.get("ArtistUnicode")), string_value(metadata.get("Artist"))),
                            non_empty_or(string_value(metadata.get("TitleUnicode")), string_value(metadata.get("Title"))),
                        ),
                        format!(
                            "{} - {}",
                            string_value(metadata.get("Artist")),
                            string_value(metadata.get("Title")),
                        ),
                    ),
                    None => (String::new(), String::new()),
                };
                (beatmap, beatmap_romanized, difficulty, set_id)
            }
            None => (String::new(), String::new(), String::new(), String::new()),
        };

        library.scores.push(RealmScore {
            id: uuid_string(row.get("ID")),
            replay_hash,
            replay_size: 0,
            beatmap,
            beatmap_romanized,
            difficulty,
            rank: int_value(row.get("Rank"), 0),
            total_score: int_value(row.get("TotalScore"), 0),
            accuracy: double_value(row.get("Accuracy"), 0.0),
            max_combo: int_value(row.get("MaxCombo"), 0),
            date: timestamp_value(row.get("Date")),
            mods: string_value(row.get("Mods")),
            ruleset: ruleset_short_name(store, row.get("Ruleset")),
            set_id,
        });
    }
    Ok(())
}

fn parse_collections(store: &mut RowStore<'_>, library: &mut RealmLibrary) -> Result<(), String> {
    // 收藏夹按难度 MD5 关联；先把所有谱面集的 md5 → set id 建索引。
    let mut md5_to_set: HashMap<&str, String> = HashMap::new();
    for set in &library.sets {
        for beatmap in &set.beatmaps {
            if !beatmap.md5.is_empty() {
                md5_to_set.insert(beatmap.md5.as_str(), set.id.clone());
            }
        }
    }

    for row in store.bulk_rows("class_BeatmapCollection")? {
        let name = string_value(row.get("Name"));
        if name.is_empty() {
            continue;
        }
        let mut set_ids: Vec<String> = Vec::new();
        let mut md5s: Vec<String> = Vec::new();
        if let Some(Value::List(values)) = row.get("BeatmapMD5Hashes") {
            for value in values {
                if let Value::String(md5) = value {
                    // realm 中同一难度可能被收藏多次，去重保证行数与选择集一致。
                    if md5s.contains(md5) {
                        continue;
                    }
                    md5s.push(md5.clone());
                    if let Some(set_id) = md5_to_set.get(md5.as_str()) {
                        if !set_ids.iter().any(|existing| existing == set_id) {
                            set_ids.push(set_id.clone());
                        }
                    }
                }
            }
        }
        library.collections.push(RealmCollection { name, set_ids, md5s });
    }
    // lazer 的“收藏夹”（Favourites）固定置顶。
    library
        .collections
        .sort_by_key(|c| !c.name.eq_ignore_ascii_case("favourites"));
    Ok(())
}

/// 谱面集封面：realm 中没有封面字段（lazer 的 Covers 是 [Ignored]，只来自
/// 在线 API），因此直接从 Files 文件列表里取最大的图片文件作为封面。
fn set_cover_hash(_files_root: &Path, set: &RealmSet) -> Option<String> {
    set.files
        .iter()
        .filter(|file| {
            let lower = file.filename.to_ascii_lowercase();
            [".jpg", ".jpeg", ".png", ".webp"]
                .iter()
                .any(|ext| lower.ends_with(ext))
        })
        .max_by_key(|file| file.size)
        .map(|file| file.hash.clone())
}

/// 解析 Ruleset 链接为模式短名（class_Ruleset 的 ShortName）。
fn ruleset_short_name(store: &mut RowStore<'_>, value: Option<&Value>) -> String {
    let link = match value {
        Some(Value::Link(link)) => link.clone(),
        _ => return String::new(),
    };
    store
        .row(&link)
        .ok()
        .flatten()
        .map(|row| string_value(row.get("ShortName")))
        .unwrap_or_default()
}

fn non_empty_or(value: String, fallback: String) -> String {
    if value.is_empty() { fallback } else { value }
}

/// 表加载策略：小表整表全载（Bulk），大表仅保留表句柄、按行懒加载（Lazy）。
enum TableData {
    Bulk(Vec<Row<'static>>),
    Lazy {
        table: realm_db_reader::Table,
        rows: HashMap<usize, Row<'static>>,
    },
}

struct RowStore<'a> {
    group: &'a Group,
    tables: HashMap<usize, TableData>,
}

impl<'a> RowStore<'a> {
    fn new(group: &'a Group) -> Self {
        Self {
            group,
            tables: HashMap::new(),
        }
    }

    fn load_table(&mut self, number: usize) -> Result<(), String> {
        if self.tables.contains_key(&number) {
            return Ok(());
        }
        let table = self
            .group
            .get_table(number)
            .map_err(|error| error.to_string())?;
        let data = if table.row_count().unwrap_or(0) <= BULK_ROW_LIMIT {
            let rows: Vec<Row<'static>> = table
                .get_rows()
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(Row::into_owned)
                .collect();
            TableData::Bulk(rows)
        } else {
            TableData::Lazy {
                table,
                rows: HashMap::new(),
            }
        };
        self.tables.insert(number, data);
        Ok(())
    }

    fn bulk_rows(&mut self, name: &str) -> Result<Vec<Row<'static>>, String> {
        let number = self
            .group
            .get_table_names()
            .iter()
            .position(|table_name| table_name == name)
            .ok_or_else(|| format!("数据库中没有 {name} 表"))?;
        self.load_table(number)?;
        match self.tables.get(&number).expect("上面已确保存在") {
            TableData::Bulk(rows) => Ok(rows.clone()),
            TableData::Lazy { .. } => Err(format!("{name} 行数过多，不支持整表载入")),
        }
    }

    fn row(&mut self, link: &Link) -> Result<Option<Row<'static>>, String> {
        self.load_table(link.target_table_number)?;
        let data = self
            .tables
            .get_mut(&link.target_table_number)
            .expect("上面已确保存在");
        match data {
            TableData::Bulk(rows) => Ok(rows.get(link.row_number).cloned()),
            TableData::Lazy { table, rows } => {
                if let Some(row) = rows.get(&link.row_number) {
                    return Ok(Some(row.clone()));
                }
                let row = table
                    .get_row(link.row_number)
                    .map_err(|error| error.to_string())?
                    .into_owned();
                rows.insert(link.row_number, row.clone());
                Ok(Some(row))
            }
        }
    }
}

fn first_link<'a>(value: &'a Value) -> Option<&'a Link> {
    match value {
        Value::LinkList(links) => links.first(),
        _ => None,
    }
}

fn string_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        _ => String::new(),
    }
}

fn int_value(value: Option<&Value>, fallback: i64) -> i64 {
    match value {
        Some(Value::Int(value)) => *value,
        _ => fallback,
    }
}

fn double_value(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        Some(Value::Double(value)) => *value,
        _ => fallback,
    }
}

fn float_value(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Float(value)) => *value as f64,
        _ => 0.0,
    }
}

fn timestamp_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::Timestamp(dt)) => dt.format("%Y-%m-%d %H:%M").to_string(),
        _ => String::new(),
    }
}

fn uuid_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::Uuid(bytes)) => bytes.iter().map(|b| format!("{b:02x}")).collect(),
        _ => String::new(),
    }
}

/// 展开 BeatmapSet/Skin 行的 Files 链接列表为 (filename, hash)。
/// `RealmNamedFileUsage` 与 `File` 都是大表，全部按行懒加载。
fn resolve_named_files(
    store: &mut RowStore<'_>,
    value: Option<&Value>,
) -> Result<Vec<RealmFile>, String> {
    let Some(Value::LinkList(links)) = value else {
        return Ok(Vec::new());
    };
    let mut files = Vec::with_capacity(links.len());
    for link in links {
        let Some(usage) = store.row(link)? else { continue };
        let filename = string_value(usage.get("Filename"));
        if filename.is_empty() {
            continue;
        }
        let hash = match usage.get("File") {
            Some(Value::Link(file_link)) => match store.row(file_link)? {
                Some(row) => string_value(row.get("Hash")),
                None => continue,
            },
            _ => continue,
        };
        files.push(RealmFile {
            filename,
            hash,
            size: 0,
        });
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 对真实 lazer 数据库的读取测试：`cargo test --lib -- --ignored`
    #[test]
    #[ignore = "需要本机安装 osu!lazer 且存在 client.realm"]
    fn reads_real_lazer_realm() {
        let data_root = crate::platform::lazer_data_root().expect("未找到 lazer 数据目录");
        let realm_path = data_root.join("client.realm");
        let mut library = parse_realm(&realm_path).expect("读取 client.realm 失败");
        eprintln!(
            "realm read: {} sets, {} skins, {} scores, {} collections",
            library.sets.len(),
            library.skins.len(),
            library.scores.len(),
            library.collections.len()
        );
        attach_file_sizes(&mut library).expect("stat 文件大小失败");

        assert!(!library.sets.is_empty(), "谱面集为空");
        let sample = library.sets.iter().find(|s| !s.beatmaps.is_empty()).expect("没有可用谱面集");
        assert!(!sample.title.is_empty() || !sample.artist.is_empty());
        let beatmap = &sample.beatmaps[0];
        assert_eq!(beatmap.sha256.len(), 64);
        assert!(sample.files.iter().any(|f| f.hash == beatmap.sha256));
        assert!(sample.files.iter().all(|f| f.size > 0));

        if let Some(collection) = library.collections.first() {
            eprintln!("first collection: {} -> {} sets", collection.name, collection.set_ids.len());
        }
        if let Some(score) = library.scores.first() {
            eprintln!("sample score: {} [{}] replay {} bytes", score.beatmap, score.difficulty, score.replay_size);
            assert!(score.replay_size > 0);
        }
        // 导入日期可排序：格式 YYYY-MM-DD HH:MM 的字符串按字典序即时间序。
        let dated = library.sets.iter().filter(|s| !s.date_added.is_empty()).count();
        eprintln!("sets with DateAdded: {}/{}", dated, library.sets.len());
        assert!(dated > 0, "没有任何谱面集解析出导入日期");

        // 封面：绝大多数谱面集都应能从文件列表里选出一张图片。
        let covered = library.sets.iter().filter(|s| s.cover_hash.is_some()).count();
        eprintln!("sets with cover: {}/{}", covered, library.sets.len());
        assert!(covered > library.sets.len() / 2, "封面命中率过低");

        // 模式：绝大多数难度都应解析出 ruleset 短名。
        let mut by_ruleset: HashMap<&str, usize> = HashMap::new();
        let mut total = 0usize;
        for set in &library.sets {
            for beatmap in &set.beatmaps {
                total += 1;
                *by_ruleset.entry(beatmap.ruleset.as_str()).or_default() += 1;
            }
        }
        eprintln!("rulesets: {:?} ({} beatmaps)", by_ruleset, total);
        let named: usize = by_ruleset.iter().filter(|(k, _)| !k.is_empty()).map(|(_, v)| v).sum();
        assert!(named > total / 2, "ruleset 解析命中率过低");
    }
}






#[cfg(test)]
mod bench_phases {
    use super::*;
    use std::time::Instant;

    /// 分阶段计时读取 client.realm：`cargo test --lib bench_phases -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机安装 osu!lazer 且存在 client.realm"]
    fn phase_timings() {
        let data_root = crate::platform::lazer_data_root().expect("未找到 lazer 数据目录");
        let realm_path = data_root.join("client.realm");

        // 0. 快照复制
        let t = Instant::now();
        let snapshot = snapshot_realm(&realm_path).expect("快照失败");
        let copy = t.elapsed();
        let size_mb = std::fs::metadata(&realm_path).map(|m| m.len()).unwrap_or(0) as f64
            / 1024.0
            / 1024.0;

        // 1. 打开 + 解析组结构
        let t = Instant::now();
        let realm = Realm::open(&snapshot).expect("打开失败");
        let group = realm.into_group().expect("读组失败");
        let open = t.elapsed();
        let mut store = RowStore::new(&group);
        let mut library = RealmLibrary::default();

        // 2. 谱面集表
        let t = Instant::now();
        parse_beatmap_sets(&mut store, &mut library).expect("谱面集失败");
        let sets = t.elapsed();

        // 3. 皮肤表
        let t = Instant::now();
        parse_skins(&mut store, &mut library).expect("皮肤失败");
        let skins = t.elapsed();

        // 4. 成绩表（回放）
        let t = Instant::now();
        parse_scores(&mut store, &mut library).expect("成绩失败");
        let scores = t.elapsed();

        // 5. 收藏夹表
        let t = Instant::now();
        parse_collections(&mut store, &mut library).expect("收藏夹失败");
        let collections = t.elapsed();

        // 6. 文件大小 stat + 封面选择（磁盘 IO）
        let t = Instant::now();
        attach_file_sizes(&mut library).expect("stat 失败");
        let stat = t.elapsed();

        let _ = std::fs::remove_file(&snapshot);
        let total = copy + open + sets + skins + scores + collections + stat;
        println!("=== client.realm 分阶段耗时（{size_mb:.1} MB）===");
        println!(
            "{:<28} {:>8.2} s  {:>5.1}%",
            "0. 快照复制",
            copy.as_secs_f64(),
            copy.as_secs_f64() / total.as_secs_f64() * 100.0
        );
        println!(
            "{:<28} {:>8.2} s  {:>5.1}%",
            "1. 打开+读 Realm 组",
            open.as_secs_f64(),
            open.as_secs_f64() / total.as_secs_f64() * 100.0
        );
        println!(
            "{:<28} {:>8.2} s  {:>5.1}%  ({} sets)",
            "2. class_BeatmapSet",
            sets.as_secs_f64(),
            sets.as_secs_f64() / total.as_secs_f64() * 100.0,
            library.sets.len()
        );
        println!(
            "{:<28} {:>8.2} s  {:>5.1}%",
            "3. class_Skin",
            skins.as_secs_f64(),
            skins.as_secs_f64() / total.as_secs_f64() * 100.0
        );
        println!(
            "{:<28} {:>8.2} s  {:>5.1}%  ({} scores)",
            "4. class_Score",
            scores.as_secs_f64(),
            scores.as_secs_f64() / total.as_secs_f64() * 100.0,
            library.scores.len()
        );
        println!(
            "{:<28} {:>8.2} s  {:>5.1}%",
            "5. class_BeatmapCollection",
            collections.as_secs_f64(),
            collections.as_secs_f64() / total.as_secs_f64() * 100.0
        );
        println!(
            "{:<28} {:>8.2} s  {:>5.1}%",
            "6. stat 文件大小+封面",
            stat.as_secs_f64(),
            stat.as_secs_f64() / total.as_secs_f64() * 100.0
        );
        println!("{:<28} {:>8.2} s", "总计", total.as_secs_f64());
    }
}
