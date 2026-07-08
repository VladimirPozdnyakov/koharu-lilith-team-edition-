//! Translation cache — stores per-source-text translation variants keyed by
//! a blake3 hash of (source + language + provider + model + prompt + glossary).
//!
//! Layout mirrors `BlobStore`: sharded JSON files under
//! `{data_root}/translation-cache/<2-hex-prefix>/<remaining-hex>.json`.
//! Each shard file holds many entries: `{ "<full_hash_hex>": [variant, ...] }`.
//! Writes are atomic (`atomicwrites`); an in-memory `DashMap` caches loaded
//! shards for hot reads.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use atomicwrites::{AtomicFile, OverwriteBehavior};
use dashmap::DashMap;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

/// One stored translation for a source text, produced by a specific
/// provider+model combination under a specific prompt/glossary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedVariant {
    pub translation: String,
    pub provider_id: Option<String>,
    pub model_id: String,
    pub created_at: i64,
    /// Updated when this variant is auto-selected on a cache hit, or when the
    /// user explicitly picks it. The most-recently-used variant wins on hit.
    pub last_used_at: i64,
}

/// Shard file body: a map of full-hash-hex → variants.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ShardFile {
    entries: HashMap<String, Vec<CachedVariant>>,
}

pub struct TranslationCache {
    root: PathBuf,
    /// Lazily-loaded shards, keyed by 2-char prefix. Each value is the parsed
    /// shard, behind a lock so concurrent writers don't clobber each other.
    shards: DashMap<String, Arc<RwLock<ShardFile>>>,
}

impl TranslationCache {
    /// Open (or create) the cache at `root` (e.g. `{data_root}/translation-cache`).
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root)
            .with_context(|| format!("create translation-cache root {}", root.display()))?;
        Ok(Self {
            root,
            shards: DashMap::new(),
        })
    }

    /// Compute the cache key hash for a (source, language, provider, model,
    /// prompt, glossary) tuple. Returns the full hex string.
    pub fn key(
        source: &str,
        target_language: &str,
        provider_id: Option<&str>,
        model_id: &str,
        custom_system_prompt: Option<&str>,
        glossary: Option<&str>,
    ) -> String {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"v1\0");
        hasher.update(source.as_bytes());
        hasher.update(b"\0L\0");
        hasher.update(target_language.as_bytes());
        hasher.update(b"\0P\0");
        hasher.update(provider_id.unwrap_or("").as_bytes());
        hasher.update(b"\0M\0");
        hasher.update(model_id.as_bytes());
        hasher.update(b"\0S\0");
        hasher.update(custom_system_prompt.unwrap_or("").as_bytes());
        hasher.update(b"\0G\0");
        hasher.update(glossary.unwrap_or("").as_bytes());
        hasher.finalize().to_hex().to_string()
    }

    /// Look up the best (most-recently-used) variant for a key, or `None`.
    pub fn get(&self, key: &str) -> Option<CachedVariant> {
        let (prefix, _) = split_hash(key);
        let shard = self.load_shard(prefix)?;
        let shard = shard.read();
        let variants = shard.entries.get(key)?;
        variants.iter().max_by_key(|v| v.last_used_at).cloned()
    }

    /// Look up ALL variants for a key (for the UI "show variants" feature).
    pub fn get_all(&self, key: &str) -> Vec<CachedVariant> {
        let (prefix, _) = split_hash(key);
        let Some(shard) = self.load_shard(prefix) else {
            return Vec::new();
        };
        let shard = shard.read();
        shard.entries.get(key).cloned().unwrap_or_default()
    }

    /// Insert a new variant for a key (deduplicating identical translations
    /// from the same provider+model). The inserted variant becomes the
    /// most-recently-used.
    pub fn put(&self, key: &str, variant: CachedVariant) -> Result<()> {
        let (prefix, _) = split_hash(key);
        let shard = self.load_or_init_shard(prefix)?;
        {
            let mut guard = shard.write();
            let entries = guard.entries.entry(key.to_string()).or_default();
            // Deduplicate: if the same provider+model already produced this
            // exact translation, just bump last_used_at.
            if let Some(existing) = entries
                .iter_mut()
                .find(|v| v.provider_id == variant.provider_id && v.model_id == variant.model_id && v.translation == variant.translation)
            {
                existing.last_used_at = variant.last_used_at;
            } else {
                entries.push(variant);
                // Cap variants per source to avoid unbounded growth.
                if entries.len() > 50 {
                    // Keep the most-recently-used 50.
                    entries.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
                    entries.truncate(50);
                }
            }
        }
        self.save_shard(prefix, &shard)
    }

    /// Mark a specific variant (by provider+model) as the selected one for a
    /// key (bumps its `last_used_at` so it wins future auto-selections).
    pub fn select(
        &self,
        key: &str,
        provider_id: Option<&str>,
        model_id: &str,
        translation: &str,
    ) -> Result<()> {
        let (prefix, _) = split_hash(key);
        let Some(shard) = self.load_shard(prefix) else {
            return Ok(());
        };
        let now = now_ts();
        {
            let mut guard = shard.write();
            if let Some(variants) = guard.entries.get_mut(key) {
                if let Some(v) = variants
                    .iter_mut()
                    .find(|v| v.provider_id.as_deref() == provider_id && v.model_id == model_id && v.translation == translation)
                {
                    v.last_used_at = now;
                }
            }
        }
        self.save_shard(prefix, &shard)
    }

    // --- internals ---------------------------------------------------------

    fn shard_path(&self, prefix: &str) -> PathBuf {
        self.root.join(prefix).join("shard.json")
    }

    /// Load (or create empty) a shard by prefix, caching it in memory.
    fn load_or_init_shard(&self, prefix: &str) -> Result<Arc<RwLock<ShardFile>>> {
        if let Some(guard) = self.shards.get(prefix) {
            return Ok(Arc::clone(&guard));
        }
        let shard = Arc::new(RwLock::new(self.read_shard_file(prefix)?));
        self.shards
            .entry(prefix.to_string())
            .or_insert(Arc::clone(&shard));
        Ok(shard)
    }

    /// Load a shard if it exists on disk, else `None`.
    fn load_shard(&self, prefix: &str) -> Option<Arc<RwLock<ShardFile>>> {
        if let Some(guard) = self.shards.get(prefix) {
            return Some(Arc::clone(&guard));
        }
        let path = self.shard_path(prefix);
        if !path.exists() {
            return None;
        }
        let shard = Arc::new(RwLock::new(
            self.read_shard_file(prefix).ok()?,
        ));
        self.shards
            .entry(prefix.to_string())
            .or_insert(Arc::clone(&shard));
        Some(Arc::clone(&shard))
    }

    fn read_shard_file(&self, prefix: &str) -> Result<ShardFile> {
        let path = self.shard_path(prefix);
        if !path.exists() {
            return Ok(ShardFile::default());
        }
        let bytes = std::fs::read(&path)
            .with_context(|| format!("read translation-cache shard {}", path.display()))?;
        if bytes.is_empty() {
            return Ok(ShardFile::default());
        }
        serde_json::from_slice(&bytes)
            .with_context(|| format!("parse translation-cache shard {}", path.display()))
    }

    fn save_shard(&self, prefix: &str, shard: &Arc<RwLock<ShardFile>>) -> Result<()> {
        let path = self.shard_path(prefix);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = {
            let guard = shard.read();
            serde_json::to_vec_pretty(&*guard).context("encode translation-cache shard")?
        };
        AtomicFile::new(path.as_path(), OverwriteBehavior::AllowOverwrite)
            .write(|f| f.write_all(&bytes))
            .context("write translation-cache shard atomically")?;
        Ok(())
    }
}

fn split_hash(hash: &str) -> (&str, &str) {
    hash.split_at(2.min(hash.len()))
}

fn now_ts() -> i64 {
    // Use a simple epoch-seconds timestamp; chrono is a workspace dep but
    // std is enough and avoids pulling extra context.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable() {
        let k1 = TranslationCache::key("안녕", "ru", Some("yandex"), "mt", None, None);
        let k2 = TranslationCache::key("안녕", "ru", Some("yandex"), "mt", None, None);
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 64); // blake3 hex
    }

    #[test]
    fn key_changes_with_glossary() {
        let base = TranslationCache::key("안녕", "ru", Some("yandex"), "mt", None, None);
        let with_g = TranslationCache::key("안녕", "ru", Some("yandex"), "mt", None, Some("g"));
        assert_ne!(base, with_g);
    }

    #[test]
    fn put_and_get_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let cache = TranslationCache::open(dir.path()).unwrap();
        let key = TranslationCache::key("안녕", "ru", Some("yandex"), "mt", None, None);
        assert!(cache.get(&key).is_none());

        let now = now_ts();
        cache
            .put(
                &key,
                CachedVariant {
                    translation: "Привет".into(),
                    provider_id: Some("yandex".into()),
                    model_id: "mt".into(),
                    created_at: now,
                    last_used_at: now,
                },
            )
            .unwrap();

        let got = cache.get(&key).expect("hit after put");
        assert_eq!(got.translation, "Привет");
        assert_eq!(got.provider_id.as_deref(), Some("yandex"));
    }

    #[test]
    fn put_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let cache = TranslationCache::open(dir.path()).unwrap();
        let key = TranslationCache::key("안녕", "ru", Some("yandex"), "mt", None, None);
        let now = now_ts();
        let v = CachedVariant {
            translation: "Привет".into(),
            provider_id: Some("yandex".into()),
            model_id: "mt".into(),
            created_at: now,
            last_used_at: now,
        };
        cache.put(&key, v.clone()).unwrap();
        cache.put(&key, v.clone()).unwrap();
        let all = cache.get_all(&key);
        assert_eq!(all.len(), 1, "dedup identical variant");
    }

    #[test]
    fn multiple_variants_pick_latest_used() {
        let dir = tempfile::tempdir().unwrap();
        let cache = TranslationCache::open(dir.path()).unwrap();
        let key = TranslationCache::key("안녕", "ru", None, "local", None, None);
        let now = now_ts();
        cache
            .put(
                &key,
                CachedVariant {
                    translation: "Старый".into(),
                    provider_id: Some("yandex".into()),
                    model_id: "mt".into(),
                    created_at: now - 100,
                    last_used_at: now - 100,
                },
            )
            .unwrap();
        cache
            .put(
                &key,
                CachedVariant {
                    translation: "Новый".into(),
                    provider_id: Some("deepseek".into()),
                    model_id: "deepseek-chat".into(),
                    created_at: now,
                    last_used_at: now,
                },
            )
            .unwrap();
        let got = cache.get(&key).expect("hit");
        assert_eq!(got.translation, "Новый"); // higher last_used_at
        assert_eq!(all_variants(&cache, &key), 2);
    }

    fn all_variants(cache: &TranslationCache, key: &str) -> usize {
        cache.get_all(key).len()
    }
}
