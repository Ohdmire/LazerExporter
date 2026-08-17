//! osu!lazer 目录识别（仅支持 Linux 与 Windows）。检测逻辑参考 OPP：
//! Windows 默认 `%APPDATA%\osu`，Linux 默认 `~/.local/share/osu`
//! （Flatpak 版为 `~/.var/app/sh.ppy.osu/data/osu`）；
//! `storage.ini` 的 `FullPath` 指向用户自定义的文件存储目录（files/ 所在处）。
//! 用户也可以手动指定数据目录（含 client.realm）；后端仅内存保存，
//! 由前端 localStorage 记忆并在启动时重新应用。

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
/// 目录必须包含 client.realm。
pub fn set_custom_data_dir(dir: Option<&Path>) -> Result<(), String> {
    if let Some(dir) = dir {
        if !dir.join("client.realm").is_file() {
            return Err(format!("所选目录中没有 client.realm：{}", dir.display()));
        }
    }
    let mut slot = CUSTOM_DATA_DIR
        .lock()
        .map_err(|_| "配置锁中毒".to_string())?;
    *slot = dir.map(Path::to_path_buf);
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

/// 当前生效的数据根：手动指定的优先，否则自动检测。
pub fn lazer_data_root() -> Option<PathBuf> {
    custom_data_dir().or_else(auto_data_root)
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
/// 优先取 storage.ini 的 FullPath，否则回退到数据根。
pub fn lazer_files_root() -> Option<PathBuf> {
    let data_root = lazer_data_root()?;
    read_storage_ini_fullpath(&data_root.join("storage.ini")).or(Some(data_root))
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

    /// 本机装有 lazer 时，自动检测应直接命中含 client.realm 的目录。
    #[test]
    #[ignore = "需要本机安装 osu!lazer"]
    fn auto_detect_finds_realm() {
        assert!(auto_data_root().unwrap().join("client.realm").is_file());
    }
}
