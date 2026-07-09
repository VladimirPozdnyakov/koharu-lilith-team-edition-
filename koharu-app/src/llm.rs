//! LLM lifecycle + translation driver.
//!
//! Owns the current LLM state (local llama.cpp model or remote provider).
//! Exposes `translate_texts(sources, target_lang, system_prompt)` which is
//! what the `llm-translate` pipeline engine calls.
//!
//! Construction:
//! ```ignore
//! let backend = app::shared_llama_backend(&runtime)?;
//! let llm = Arc::new(llm::Model::new(runtime, cpu, backend));
//! // then: llm.load_local(...) or llm.load_provider(...)
//! ```

use std::sync::Arc;

use anyhow::Result;
use koharu_core::{
    LlmCatalog, LlmCatalogModel, LlmLoadRequest, LlmProviderCatalog, LlmProviderCatalogStatus,
    LlmState, LlmStateStatus, LlmTarget, LlmTargetKind,
};
use koharu_llm::providers::{
    AnyProvider, ProviderCatalogModels, ProviderConfig, ProviderDescriptor,
    all_provider_descriptors, build_provider, discover_models,
};
use koharu_llm::safe::llama_backend::LlamaBackend;
use koharu_llm::{Language, Llm, ModelId, language::tags as language_tags};
use koharu_runtime::RuntimeManager;

use crate::translation_cache::{CachedVariant, TranslationCache};
use strum::IntoEnumIterator;
use tokio::sync::{RwLock, broadcast};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[allow(clippy::large_enum_variant)]
pub enum State {
    Empty,
    Loading {
        target: LlmTarget,
    },
    ReadyLocal(Llm),
    ReadyProvider {
        target: LlmTarget,
        provider: Box<dyn AnyProvider>,
    },
    Failed {
        target: Option<LlmTarget>,
        error: String,
    },
}

fn local_target(id: ModelId) -> LlmTarget {
    LlmTarget {
        kind: LlmTargetKind::Local,
        model_id: id.to_string(),
        provider_id: None,
    }
}

fn state_target(state: &State) -> Option<LlmTarget> {
    match state {
        State::Empty => None,
        State::Loading { target } => Some(target.clone()),
        State::ReadyLocal(llm) => Some(local_target(llm.id())),
        State::ReadyProvider { target, .. } => Some(target.clone()),
        State::Failed { target, .. } => target.clone(),
    }
}

fn snapshot_from_state(state: &State) -> LlmState {
    match state {
        State::Empty => LlmState {
            status: LlmStateStatus::Empty,
            target: None,
            error: None,
        },
        State::Loading { target } => LlmState {
            status: LlmStateStatus::Loading,
            target: Some(target.clone()),
            error: None,
        },
        State::ReadyLocal(llm) => LlmState {
            status: LlmStateStatus::Ready,
            target: Some(local_target(llm.id())),
            error: None,
        },
        State::ReadyProvider { target, .. } => LlmState {
            status: LlmStateStatus::Ready,
            target: Some(target.clone()),
            error: None,
        },
        State::Failed { target, error } => LlmState {
            status: LlmStateStatus::Failed,
            target: target.clone(),
            error: Some(error.clone()),
        },
    }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

pub struct Model {
    state: Arc<RwLock<State>>,
    state_tx: broadcast::Sender<LlmState>,
    runtime: RuntimeManager,
    cpu: bool,
    backend: Arc<LlamaBackend>,
    cache: Option<Arc<TranslationCache>>,
}

impl Model {
    pub fn new(runtime: RuntimeManager, cpu: bool, backend: Arc<LlamaBackend>) -> Self {
        Self {
            state: Arc::new(RwLock::new(State::Empty)),
            state_tx: broadcast::channel(64).0,
            runtime,
            cpu,
            backend,
            cache: None,
        }
    }

    /// Attach a translation cache. Translations are stored per source-text +
    /// language + provider + model + prompt + glossary hash; cache hits skip
    /// the LLM call entirely.
    pub fn with_cache(mut self, cache: Arc<TranslationCache>) -> Self {
        self.cache = Some(cache);
        self
    }

    pub fn is_cpu(&self) -> bool {
        self.cpu
    }

    pub fn backend(&self) -> Arc<LlamaBackend> {
        self.backend.clone()
    }

    /// Load a provider target (remote API) immediately.
    pub async fn load_provider(
        &self,
        target: LlmTarget,
        provider: Box<dyn AnyProvider>,
    ) -> Result<()> {
        *self.state.write().await = State::ReadyProvider { target, provider };
        self.emit_state().await;
        Ok(())
    }

    /// Kick off a local llama.cpp load in the background.
    pub async fn load_local(&self, id: ModelId) {
        let target = local_target(id);
        *self.state.write().await = State::Loading {
            target: target.clone(),
        };
        self.emit_state().await;

        let state_cloned = self.state.clone();
        let state_tx = self.state_tx.clone();
        let runtime = self.runtime.clone();
        let cpu = self.cpu;
        let backend = self.backend.clone();
        tokio::spawn(async move {
            let res = Llm::load(&runtime, id, cpu, backend).await;
            let mut guard = state_cloned.write().await;
            match res {
                Ok(llm) => *guard = State::ReadyLocal(llm),
                Err(e) => {
                    *guard = State::Failed {
                        target: Some(target),
                        error: format!("{e:#}"),
                    }
                }
            }
            let snapshot = snapshot_from_state(&guard);
            let _ = state_tx.send(snapshot);
        });
    }

    pub async fn offload(&self) {
        *self.state.write().await = State::Empty;
        self.emit_state().await;
    }

    pub async fn ready(&self) -> bool {
        matches!(
            *self.state.read().await,
            State::ReadyLocal(_) | State::ReadyProvider { .. }
        )
    }

    pub async fn current_target(&self) -> Option<LlmTarget> {
        state_target(&*self.state.read().await)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LlmState> {
        self.state_tx.subscribe()
    }

    pub async fn snapshot(&self) -> LlmState {
        snapshot_from_state(&*self.state.read().await)
    }

    async fn emit_state(&self) {
        let _ = self.state_tx.send(self.snapshot().await);
    }

    /// Translate a batch of source strings. Each source becomes a tagged
    /// `[N]...` block; the response is parsed back into per-block
    /// translations. Output length matches input length (possibly with empty
    /// strings for missing blocks).
    ///
    /// If a translation cache is attached, source texts that have been
    /// translated before (same language + provider + model + prompt + glossary)
    /// are served from the cache without calling the LLM. Only uncached sources
    /// are sent to the model; the results are stored back into the cache.
    pub async fn translate_texts(
        &self,
        sources: &[String],
        target_language: Option<&str>,
        custom_system_prompt: Option<&str>,
        glossary: Option<&str>,
    ) -> Result<Vec<String>> {
        if sources.is_empty() {
            return Ok(Vec::new());
        }
        let target_language = target_language
            .and_then(Language::parse)
            .unwrap_or(Language::English);

        // --- Cache lookup (partial hit) -------------------------------------
        // Resolve the target info needed for the cache key. Uses a read lock
        // so cache hits never block other readers.
        let target_info: Option<(Option<String>, String)> = {
            let guard = self.state.read().await;
            state_target(&guard).map(|t| (t.provider_id, t.model_id))
        };

        if let Some(cache) = &self.cache
            && let Some((provider_id, model_id)) = &target_info
        {
            let lang_tag = target_language.tag();
            // Compute keys and partition into hits / misses.
            let mut result: Vec<Option<String>> = vec![None; sources.len()];
            let mut miss_indices: Vec<usize> = Vec::new();
            let mut miss_keys: Vec<String> = Vec::new();
            for (i, src) in sources.iter().enumerate() {
                let key = TranslationCache::key(
                    src,
                    lang_tag,
                    provider_id.as_deref(),
                    model_id,
                    custom_system_prompt,
                    glossary,
                );
                if let Some(variant) = cache.get(&key) {
                    result[i] = Some(variant.translation);
                } else {
                    miss_indices.push(i);
                    miss_keys.push(key);
                }
            }

            if miss_indices.is_empty() {
                // Full hit — no LLM call.
                return Ok(result.into_iter().map(|v| v.unwrap_or_default()).collect());
            }

            // Partial hit — translate only the misses.
            let miss_sources: Vec<String> = miss_indices.iter().map(|&i| sources[i].clone()).collect();
            let translated = self
                .translate_uncached(&miss_sources, target_language, custom_system_prompt, glossary)
                .await?;

            // Store new variants + interleave into result.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            for (offset, &src_idx) in miss_indices.iter().enumerate() {
                let translation = translated.get(offset).cloned().unwrap_or_default();
                if !translation.trim().is_empty() {
                    let _ = cache.put(
                        &miss_keys[offset],
                        CachedVariant {
                            translation: translation.clone(),
                            provider_id: provider_id.clone(),
                            model_id: model_id.clone(),
                            created_at: now,
                            last_used_at: now,
                        },
                    );
                }
                result[src_idx] = Some(translation);
            }
            return Ok(result.into_iter().map(|v| v.unwrap_or_default()).collect());
        }

        // No cache or no target info — translate everything the old way.
        let body = format_sources(sources);
        let translation = self
            .translate_body(&body, target_language, custom_system_prompt, glossary)
            .await?;
        let translation = strip_thinking_block(&translation);
        let out = match parse_tagged_blocks(translation, sources.len())? {
            Some(blocks) => blocks,
            None => split_legacy_lines(translation, sources.len()),
        };
        Ok(out.into_iter().map(|s| strip_wrapping_quotes(s.trim())).collect())
    }

    /// Translate a sub-batch of sources (no cache). Returns per-source strings.
    async fn translate_uncached(
        &self,
        sources: &[String],
        target_language: Language,
        custom_system_prompt: Option<&str>,
        glossary: Option<&str>,
    ) -> Result<Vec<String>> {
        let body = format_sources(sources);
        let translation = self
            .translate_body(&body, target_language, custom_system_prompt, glossary)
            .await?;
        let translation = strip_thinking_block(&translation);
        let out = match parse_tagged_blocks(translation, sources.len())? {
            Some(blocks) => blocks,
            None => split_legacy_lines(translation, sources.len()),
        };
        Ok(out.into_iter().map(|s| strip_wrapping_quotes(s.trim())).collect())
    }

    /// Send the formatted body to the LLM/provider and return the raw response.
    async fn translate_body(
        &self,
        body: &str,
        target_language: Language,
        custom_system_prompt: Option<&str>,
        glossary: Option<&str>,
    ) -> Result<String> {
        let mut guard = self.state.write().await;
        match &mut *guard {
            State::ReadyLocal(llm) => {
                let opts = llm.id().default_generate_options();
                llm.generate(body, &opts, target_language, custom_system_prompt, glossary)
            }
            State::ReadyProvider { target, provider } => {
                provider
                    .translate(body, target_language, &target.model_id, custom_system_prompt, glossary)
                    .await
            }
            State::Loading { .. } => Err(anyhow::anyhow!("LLM is still loading")),
            State::Failed { error, .. } => Err(anyhow::anyhow!("LLM failed to load: {error}")),
            State::Empty => Err(anyhow::anyhow!("no LLM loaded")),
        }
    }
}

// ---------------------------------------------------------------------------
// Provider configuration + construction
// ---------------------------------------------------------------------------

impl Model {
    /// Resolve + build a provider from the app config, then load it.
    pub async fn load_from_request(
        &self,
        request: LlmLoadRequest,
        provider_config: Option<ProviderConfig>,
    ) -> Result<()> {
        match request.target.kind {
            LlmTargetKind::Local => {
                let id: ModelId =
                    std::str::FromStr::from_str(&request.target.model_id).map_err(|_| {
                        anyhow::anyhow!("unknown local model id: {}", request.target.model_id)
                    })?;
                self.load_local(id).await;
                Ok(())
            }
            LlmTargetKind::Provider => {
                let provider_id = request
                    .target
                    .provider_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("provider target missing provider_id"))?;
                let config = provider_config.ok_or_else(|| {
                    anyhow::anyhow!("no saved provider configuration for {provider_id}")
                })?;
                let provider = build_provider(provider_id, config)?;
                self.load_provider(request.target, provider).await?;
                Ok(())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/// Build the LLM catalog (local models + providers). Dynamic-provider entries
/// perform a live model-discovery call when the provider has valid
/// configuration; Static providers always return the baked-in list.
pub async fn catalog(config: &crate::config::AppConfig, runtime: &RuntimeManager) -> LlmCatalog {
    LlmCatalog {
        local_models: local_catalog_models(),
        providers: provider_catalog(config, runtime).await,
    }
}

fn provider_target(provider_id: &str, model_id: &str) -> LlmTarget {
    LlmTarget {
        kind: LlmTargetKind::Provider,
        model_id: model_id.to_string(),
        provider_id: Some(provider_id.to_string()),
    }
}

fn local_catalog_models() -> Vec<LlmCatalogModel> {
    ModelId::iter()
        .map(|model| LlmCatalogModel {
            target: local_target(model),
            name: model.to_string(),
            languages: language_tags(&model.languages()),
            size_bytes: model_size_bytes(model),
        })
        .collect()
}

/// Approximate download sizes for local GGUF models (bytes). These are rough
/// estimates based on the quantization and parameter count; the actual size
/// may vary slightly.
fn model_size_bytes(model: ModelId) -> Option<u64> {
    const MB: u64 = 1024 * 1024;
    match model {
        ModelId::VntlLlama3_8Bv2 => Some(5700 * MB),
        ModelId::Lfm2_5_1_2bInstruct => Some(800 * MB),
        ModelId::SakuraGalTransl7Bv3_7 => Some(3400 * MB),
        ModelId::Sakura1_5bQwen2_5v1_0 => Some(1000 * MB),
        ModelId::HunyuanMT7B => Some(4400 * MB),
        ModelId::Sugoi14bUltra => Some(8600 * MB),
        ModelId::Sugoi32bUltra => Some(19800 * MB),
        ModelId::Gemma4E2bIt => Some(1600 * MB),
        ModelId::Gemma4E4bIt => Some(2600 * MB),
        ModelId::Gemma4_12bIt => Some(7000 * MB),
        ModelId::Gemma4_26bA4bIt => Some(14000 * MB),
        ModelId::Gemma4_31bIt => Some(18000 * MB),
        ModelId::Gemma4E2bUncensored => Some(1600 * MB),
        ModelId::Gemma4E4bUncensored => Some(2600 * MB),
        ModelId::Qwen3_5_0_8b => Some(600 * MB),
        ModelId::Qwen3_5_2b => Some(1300 * MB),
        ModelId::Qwen3_5_4b => Some(2600 * MB),
        ModelId::Qwen3_5_9b => Some(5600 * MB),
        ModelId::Qwen3_5_27b => Some(16500 * MB),
        ModelId::Qwen3_5_35bA3b => Some(21000 * MB),
        ModelId::Qwen3_6_27b => Some(16500 * MB),
        ModelId::Qwen3_6_35bA3b => Some(21000 * MB),
        ModelId::Qwen3_5_2bUncensored => Some(1300 * MB),
        ModelId::Qwen3_5_4bUncensored => Some(2600 * MB),
        ModelId::Qwen3_5_9bUncensored => Some(5600 * MB),
        ModelId::Qwen3_5_27bUncensored => Some(16500 * MB),
        ModelId::Qwen3_5_35bA3bUncensored => Some(21000 * MB),
        ModelId::Qwen3_6_27bUncensored => Some(16500 * MB),
        ModelId::Qwen3_6_35bA3bUncensored => Some(21000 * MB),
    }
}

async fn provider_catalog(
    config: &crate::config::AppConfig,
    runtime: &RuntimeManager,
) -> Vec<LlmProviderCatalog> {
    let mut providers = Vec::new();
    for descriptor in all_provider_descriptors() {
        let stored = config.providers.iter().find(|p| p.id == descriptor.id);
        let base_url = stored.and_then(|p| p.base_url.clone());
        let api_key = stored
            .and_then(|p| p.api_key.as_ref())
            .map(|secret| secret.expose().to_owned());
        let has_api_key = api_key.as_deref().is_some_and(|v| !v.trim().is_empty());
        let missing = (descriptor.requires_api_key && !has_api_key)
            || (descriptor.requires_base_url
                && base_url.as_deref().is_none_or(|v| v.trim().is_empty()));

        let (status, error, models) = if missing {
            (
                LlmProviderCatalogStatus::MissingConfiguration,
                None,
                static_provider_models(descriptor),
            )
        } else {
            match &descriptor.models {
                ProviderCatalogModels::Static(_) => (
                    LlmProviderCatalogStatus::Ready,
                    None,
                    static_provider_models(descriptor),
                ),
                ProviderCatalogModels::Dynamic(_) => {
                    let cfg = ProviderConfig {
                        http_client: runtime.http_client(),
                        api_key,
                        base_url: base_url.clone(),
                        temperature: None,
                        max_tokens: None,
                    };
                    match discover_models(descriptor.id, cfg) {
                        Ok(future) => match future.await {
                            Ok(discovered) => (
                                LlmProviderCatalogStatus::Ready,
                                None,
                                discovered
                                    .into_iter()
                                    .map(|m| LlmCatalogModel {
                                        target: provider_target(descriptor.id, &m.id),
                                        name: m.name,
                                        languages: descriptor.supported_languages.tags(),
                                        size_bytes: None,
                                    })
                                    .collect(),
                            ),
                            Err(e) => (
                                LlmProviderCatalogStatus::DiscoveryFailed,
                                Some(format!("{e:#}")),
                                Vec::new(),
                            ),
                        },
                        Err(e) => (
                            LlmProviderCatalogStatus::DiscoveryFailed,
                            Some(format!("{e:#}")),
                            Vec::new(),
                        ),
                    }
                }
            }
        };

        providers.push(LlmProviderCatalog {
            id: descriptor.id.to_string(),
            name: descriptor.name.to_string(),
            requires_api_key: descriptor.requires_api_key,
            requires_base_url: descriptor.requires_base_url,
            has_api_key,
            base_url,
            status,
            error,
            models,
        });
    }
    providers
}

fn static_provider_models(descriptor: &ProviderDescriptor) -> Vec<LlmCatalogModel> {
    match &descriptor.models {
        ProviderCatalogModels::Static(models) => models
            .iter()
            .map(|m| LlmCatalogModel {
                target: provider_target(descriptor.id, m.id),
                name: m.name.to_string(),
                languages: descriptor.supported_languages.tags(),
                size_bytes: None,
            })
            .collect(),
        ProviderCatalogModels::Dynamic(_) => Vec::new(),
    }
}

/// Build a `ProviderConfig` from stored app config. Used by `load_from_request`
/// when a provider target is requested.
pub fn provider_config_from_settings(
    config: &crate::config::AppConfig,
    runtime: &RuntimeManager,
    provider_id: &str,
) -> ProviderConfig {
    let stored = config.providers.iter().find(|p| p.id == provider_id);
    ProviderConfig {
        http_client: runtime.http_client(),
        api_key: stored
            .and_then(|p| p.api_key.as_ref())
            .map(|s| s.expose().to_owned()),
        base_url: stored.and_then(|p| p.base_url.clone()),
        temperature: None,
        max_tokens: None,
    }
}

// ---------------------------------------------------------------------------
// Tag formatting + response parsing
// ---------------------------------------------------------------------------

fn format_sources(sources: &[String]) -> String {
    sources
        .iter()
        .enumerate()
        .map(|(idx, text)| format!("[{}]{}", idx + 1, text))
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_block_tag(text: &str) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    if bytes.first()? != &b'[' {
        return None;
    }
    let end = text[1..].find(']')?;
    let num_str = &text[1..1 + end];
    let id_1based: usize = num_str.parse().ok()?;
    if id_1based == 0 {
        return None;
    }
    Some((1 + end + 1, id_1based - 1))
}

fn find_next_tag(text: &str) -> Option<(usize, usize, usize)> {
    let mut line_start = 0;
    while line_start <= text.len() {
        let line = &text[line_start..];
        let indent = line
            .as_bytes()
            .iter()
            .take_while(|&&byte| matches!(byte, b' ' | b'\t'))
            .count();
        let offset = line_start + indent;
        if let Some((len, id)) = parse_block_tag(&text[offset..]) {
            return Some((offset, len, id));
        }
        let Some(next_newline) = line.find('\n') else {
            break;
        };
        line_start += next_newline + 1;
    }
    None
}

fn parse_tagged_blocks(translation: &str, expected_blocks: usize) -> Result<Option<Vec<String>>> {
    if find_next_tag(translation).is_none() {
        return Ok(None);
    }
    let mut blocks = vec![String::new(); expected_blocks];
    let mut cursor = translation;
    let mut found_any = false;
    while let Some((offset, len, id)) = find_next_tag(cursor) {
        found_any = true;
        cursor = &cursor[offset + len..];
        let content_end = find_next_tag(cursor)
            .map(|(next_offset, _, _)| next_offset)
            .unwrap_or(cursor.len());
        let content = cursor[..content_end].trim().to_string();
        if id < expected_blocks {
            blocks[id] = content;
        }
        cursor = &cursor[content_end..];
    }
    Ok(found_any.then_some(blocks))
}

fn split_legacy_lines(translation: &str, expected_blocks: usize) -> Vec<String> {
    let mut lines: Vec<String> = translation
        .lines()
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect();
    lines.truncate(expected_blocks);
    while lines.len() < expected_blocks {
        lines.push(String::new());
    }
    lines
}

fn strip_thinking_block(text: &str) -> &str {
    if let Some(start) = text.find("<think>")
        && let Some(end) = text[start..].find("</think>")
    {
        return text[start + end + "</think>".len()..].trim_start();
    }
    text
}

fn strip_wrapping_quotes(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.chars().next();
        let last = trimmed.chars().last();
        if let (Some(f), Some(l)) = (first, last)
            && (f == '"' && l == '"' || f == '\'' && l == '\'')
        {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}
