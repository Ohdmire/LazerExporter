//! 全局缓存的 client.realm 解析结果：所有页面共用，只在“重载数据库”时重新解析。

use std::sync::RwLock;

use crate::lazer_realm::RealmLibrary;

#[derive(Default)]
pub struct CachedLibrary(pub RwLock<Option<RealmLibrary>>);

impl CachedLibrary {
    /// 取缓存；没有缓存时解析一次并写入（各命令共用，避免重复读取 realm）。
    pub fn get_or_parse(&self) -> Result<RealmLibrary, String> {
        if let Some(library) = self.0.read().ok().and_then(|guard| guard.clone()) {
            return Ok(library);
        }
        let realm_path = crate::platform::lazer_data_root()
            .filter(|root| root.join("client.realm").is_file())
            .map(|root| root.join("client.realm"))
            .ok_or_else(|| "未找到 osu!lazer 数据目录（client.realm）".to_string())?;
        let mut library = crate::lazer_realm::parse_realm_blocking(&realm_path)?;
        crate::lazer_realm::attach_file_sizes(&mut library)?;
        if let Ok(mut guard) = self.0.write() {
            *guard = Some(library.clone());
        }
        Ok(library)
    }

    /// 强制重新解析（重载数据库）。
    pub fn refresh(&self) -> Result<RealmLibrary, String> {
        if let Ok(mut guard) = self.0.write() {
            *guard = None;
        }
        self.get_or_parse()
    }
}
