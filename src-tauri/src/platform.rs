//! osu!lazer 目录识别（仅支持 Linux 与 Windows）。检测逻辑参考 OPP：
//! Windows 默认 `%APPDATA%\osu`，Linux 默认 `~/.local/share/osu`
//! （Flatpak 版为 `~/.var/app/sh.ppy.osu/data/osu`）。
//! `storage.ini` 的 `FullPath` 无条件优先：lazer 迁移存储后 client.realm
//! 与 files/ 全部位于 FullPath 指向的目录，原目录只剩 ini 与旧残留，
//! 一律不使用。用户也可以手动指定目录（含 client.realm 或 storage.ini）；
//! 后端仅内存保存，由前端 localStorage 记忆并在启动时重新应用。

use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// 用户手动指定的 lazer 数据目录；None 表示使用自动检测。
static CUSTOM_DATA_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 设置（或清除，传入 None）手动指定的数据目录（仅本次运行有效，
/// 前端负责在 localStorage 记忆并在启动时重新应用）。
/// 所选目录可以直接含 client.realm，也可以只含 storage.ini（由其 FullPath
/// 重定向到真正的工作目录）；按解析后的实际位置校验。
pub fn set_custom_data_dir(dir: Option<&Path>) -> Result<(), String> {
    if let Some(dir) = dir {
        let mut slot = CUSTOM_DATA_DIR
            .lock()
            .map_err(|_| "配置锁中毒".to_string())?;
        *slot = Some(dir.to_path_buf());
        // 解析后的工作目录必须存在 client.realm，否则回滚（源目录的残留 realm 不算数）。
        let resolved = custom_data_dir().map(|base| resolve_working_dir(&base));
        let ok = resolved
            .as_ref()
            .map(|root| root.join("client.realm").is_file())
            .unwrap_or(false);
        if !ok {
            *slot = None;
            let shown = resolved
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| dir.display().to_string());
            return Err(format!("解析后的目录中没有 client.realm：{shown}"));
        }
        return Ok(());
    }
    let mut slot = CUSTOM_DATA_DIR
        .lock()
        .map_err(|_| "配置锁中毒".to_string())?;
    *slot = None;
    Ok(())
}

pub fn custom_data_dir() -> Option<PathBuf> {
    CUSTOM_DATA_DIR.lock().ok().and_then(|slot| slot.clone())
}

/// osu!lazer 自动检测的数据根（含 client.realm 与 storage.ini），与 OPP 一致：
/// Windows 为 `%APPDATA%\osu`；Linux 固定为 `~/.local/share/osu`
/// （lazer 不读取 XDG_DATA_HOME，软件也不装在那里）。
fn auto_data_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        env::var_os("APPDATA").map(PathBuf::from).map(|appdata| appdata.join("osu"))
    }
    #[cfg(not(windows))]
    {
        home_dir().map(|home| home.join(".local").join("share").join("osu"))
    }
}

/// 从基础目录（手动指定或自动检测的数据根）解析实际工作目录：
/// storage.ini 的 FullPath 无条件优先——迁移存储后 client.realm 与 files/
/// 都在 FullPath 指向的目录，源目录即使残留旧 client.realm 也禁止使用。
fn resolve_working_dir(base: &Path) -> PathBuf {
    read_storage_ini_fullpath(&base.join("storage.ini")).unwrap_or_else(|| base.to_path_buf())
}

/// 当前生效的工作目录：storage.ini 的 FullPath 无条件优先——
/// lazer 迁移存储后 client.realm 与 files/ 都在 FullPath 指向的目录，
/// 原数据目录只剩 storage.ini（及旧残留），一律忽略。
pub fn lazer_data_root() -> Option<PathBuf> {
    let base = custom_data_dir().or_else(auto_data_root)?;
    Some(resolve_working_dir(&base))
}

/// 当前数据根是否来自手动指定。
pub fn using_custom_dir() -> bool {
    custom_data_dir().is_some()
}

/// 读取 lazer `storage.ini` 中的 `FullPath=`（用户自定义的文件存储目录）。
fn read_storage_ini_fullpath(storage_ini: &Path) -> Option<PathBuf> {
    let reader = BufReader::new(File::open(storage_ini).ok()?);
    for line in reader.lines().flatten() {
        if let Some(value) = line
            .strip_prefix("FullPath")
            .and_then(|rest| rest.split('=').nth(1))
        {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(PathBuf::from(trimmed));
            }
        }
    }
    None
}

/// osu!lazer 的文件存储根（files/ 内容寻址目录的父目录）：
/// 与工作目录一致（storage.ini 的 FullPath 已在 lazer_data_root 内生效）。
pub fn lazer_files_root() -> Option<PathBuf> {
    lazer_data_root()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LazerStatus {
    pub data_root: Option<String>,
    pub files_root: Option<String>,
    pub realm_path: Option<String>,
    pub auto_data_root: Option<String>,
    pub using_custom: bool,
}

#[tauri::command]
pub fn detect_lazer() -> LazerStatus {
    let data_root = lazer_data_root();
    let realm_path = data_root
        .as_ref()
        .filter(|root| root.join("client.realm").is_file())
        .map(|root| root.join("client.realm"));
    LazerStatus {
        data_root: data_root.as_ref().map(|p| p.display().to_string()),
        files_root: lazer_files_root().map(|p| p.display().to_string()),
        realm_path: realm_path.map(|p| p.display().to_string()),
        auto_data_root: auto_data_root().map(|p| p.display().to_string()),
        using_custom: using_custom_dir(),
    }
}

/// 手动指定 lazer 数据目录（需包含 client.realm）；传 None 恢复自动检测。
#[tauri::command]
pub fn set_lazer_data_dir(path: Option<String>) -> Result<LazerStatus, String> {
    set_custom_data_dir(path.as_deref().map(Path::new))?;
    Ok(detect_lazer())
}

/// 自动扫描 osu!stable 安装目录候选（与 OPP 的 stable_install_candidates 同逻辑）：
/// Windows 走注册表卸载信息 + `%LOCALAPPDATA%\osu!`；Linux 为 osu-wine 的
/// `~/.local/share/osu-wine/osu!`。逐个校验 Songs 目录存在后返回。
#[tauri::command]
pub fn detect_stable_dir() -> Vec<String> {
    let candidates = stable_install_candidates();
    candidates
        .into_iter()
        .filter(|dir| dir.join("Songs").is_dir() || dir.join("osu!.db").is_file())
        .map(|dir| dir.display().to_string())
        .collect()
}

fn stable_install_candidates() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        // 注册表优先；整个卸载信息里都找不到 osu! 时才兜底 %LOCALAPPDATA%\osu!。
        registry_install()
            .or_else(|| env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join("osu!")))
            .into_iter()
            .collect()
    }
    #[cfg(not(windows))]
    {
        // osu-wine 方案的实际安装目录是 `osu-wine/osu!`。
        let data = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|home| home.join(".local").join("share")));
        data.into_iter()
            .map(|data| data.join("osu-wine").join("osu!"))
            .collect()
    }
}

/// files/ 内容寻址存储中的 blob 相对路径：`x/xy/<sha256>`。
pub fn blob_relative_path(hash: &str) -> String {
    if hash.len() >= 2 {
        format!(
            "{}/{}/{}",
            hash[..1].to_ascii_lowercase(),
            hash[..2].to_ascii_lowercase(),
            hash
        )
    } else {
        hash.to_string()
    }
}

/// 读取封面 blob 并编码为 data URL；asset 协议不可用时的兜底。
/// MIME 按文件头魔数判断。
#[tauri::command]
pub fn read_cover(hash: String) -> Result<Option<String>, String> {
    let Some(files_root) = lazer_files_root() else {
        return Ok(None);
    };
    let blob = files_root
        .join("files")
        .join(blob_relative_path(&hash));
    let bytes = std::fs::read(&blob).map_err(|e| format!("读取封面失败：{e}"))?;
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 11 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        "image/jpeg"
    };
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:{mime};base64,{encoded}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// storage.ini 的 FullPath 无条件优先：源目录即使残留 client.realm 也禁止使用。
    #[test]
    fn ini_fullpath_overrides_source_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        // 源目录里留着旧 realm 和 files，模拟迁移后的残留。
        fs::write(source.join("client.realm"), b"old").unwrap();
        fs::write(source.join("storage.ini"), "FullPath = D:\\osu-moved\n").unwrap();
        assert_eq!(resolve_working_dir(&source), PathBuf::from("D:\\osu-moved"));
    }

    /// 没有 storage.ini 或 FullPath 为空时，工作目录就是基础目录本身。
    #[test]
    fn without_ini_base_dir_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("plain");
        fs::create_dir_all(&base).unwrap();
        assert_eq!(resolve_working_dir(&base), base);

        fs::write(base.join("storage.ini"), "FullPath =\n").unwrap();
        assert_eq!(resolve_working_dir(&base), base);
    }

    /// 默认目录在每个平台都指向 lazer 的官方数据位置。
    #[test]
    fn auto_data_root_matches_platform_layout() {
        let root = auto_data_root().expect("默认目录不能为空");
        let text = root.display().to_string().replace("\\", "/");
        #[cfg(windows)]
        {
            let lower = text.to_lowercase();
            assert!(
                lower.contains("appdata") && !lower.contains("localappdata") && lower.ends_with("/osu"),
                "Windows 默认应为 %APPDATA%\\osu，实际：{}",
                root.display()
            );
        }
        #[cfg(not(windows))]
        {
            assert!(
                text.ends_with("/.local/share/osu"),
                "Linux 默认应为 ~/.local/share/osu，实际：{text}"
            );
        }
    }

    /// 本机装有 lazer 时，实际工作目录（含 storage.ini 重定向）应含 client.realm。
    #[test]
    #[ignore = "需要本机安装 osu!lazer"]
    fn auto_detect_finds_realm() {
        assert!(lazer_data_root().unwrap().join("client.realm").is_file());
    }
}

#[cfg(windows)]
fn registry_install() -> Option<PathBuf> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    };

    const KEYS: [&str; 2] = [
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let hive = RegKey::predef(hive);
        for key_name in KEYS {
            let Ok(uninstall) = hive.open_subkey(key_name) else {
                continue;
            };
            for subkey_name in uninstall.enum_keys().flatten() {
                let Ok(subkey) = uninstall.open_subkey(subkey_name) else {
                    continue;
                };
                let Ok(display_name) = subkey.get_value::<String, _>("DisplayName") else {
                    continue;
                };
                if !display_name.eq_ignore_ascii_case("osu!") {
                    continue;
                }
                // 优先 InstallLocation；缺失时（部分安装条目只有卸载串）从
                // UninstallString（如 `D:\osu!\osu!.exe -uninstall`）取 exe 所在目录。
                if let Ok(path) = subkey.get_value::<String, _>("InstallLocation") {
                    let path = path.trim().trim_matches('"');
                    if !path.is_empty() {
                        return Some(PathBuf::from(path));
                    }
                }
                if let Ok(uninstall) = subkey.get_value::<String, _>("UninstallString") {
                    if let Some(dir) = dir_from_uninstall_string(&uninstall) {
                        return Some(dir);
                    }
                }
            }
        }
    }
    None
}

/// 从卸载串里提取 exe 路径的所在目录：
/// `D:\osu!\osu!.exe -uninstall` → `D:\osu!`；带引号与参数均能处理。
#[cfg(windows)]
fn dir_from_uninstall_string(uninstall: &str) -> Option<PathBuf> {
    let trimmed = uninstall.trim();
    let exe = if let Some(rest) = trimmed.strip_prefix('"') {
        // 引号形式："D:\osu!\osu!.exe" -uninstall
        rest.split('"').next()?
    } else {
        // 裸路径形式：D:\osu!\osu!.exe -uninstall（exe 路径含空格时只能按第一个 .exe 截断）
        let end = trimmed.find(".exe").map(|i| i + 4)?;
        &trimmed[..end]
    };
    let exe = exe.trim();
    if exe.is_empty() {
        return None;
    }
    Path::new(exe).parent().map(|dir| dir.to_path_buf())
}
