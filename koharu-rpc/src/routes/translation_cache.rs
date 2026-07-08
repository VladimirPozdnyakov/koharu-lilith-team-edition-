//! Translation cache routes. Lets the frontend look up stored translation
//! variants for a source text and select one as the preferred choice.
//!
//! - `POST /translation-cache/lookup`  — all variants for a source + params
//! - `POST /translation-cache/select`  — mark a variant as last-used

use axum::Json;
use axum::extract::State;
use koharu_app::translation_cache::CachedVariant;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::AppState;
use crate::error::{ApiError, ApiResult};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::default()
        .routes(routes!(lookup_variants))
        .routes(routes!(select_variant))
}

// --- Lookup ---------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CacheLookupRequest {
    pub source: String,
    #[serde(default)]
    pub target_language: Option<String>,
    /// If `None`, returns variants across ALL providers/models (for the UI
    /// "show all variants" feature). If set, only returns matching ones.
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub glossary: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CacheLookupResponse {
    pub variants: Vec<CacheVariantDto>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CacheVariantDto {
    pub translation: String,
    pub provider_id: Option<String>,
    pub model_id: String,
    pub created_at: i64,
    pub last_used_at: i64,
}

impl From<CachedVariant> for CacheVariantDto {
    fn from(v: CachedVariant) -> Self {
        Self {
            translation: v.translation,
            provider_id: v.provider_id,
            model_id: v.model_id,
            created_at: v.created_at,
            last_used_at: v.last_used_at,
        }
    }
}

#[utoipa::path(
    post,
    path = "/translation-cache/lookup",
    request_body = CacheLookupRequest,
    responses((status = 200, body = CacheLookupResponse))
)]
async fn lookup_variants(
    State(app): State<AppState>,
    Json(req): Json<CacheLookupRequest>,
) -> ApiResult<Json<CacheLookupResponse>> {
    // If the client supplied provider+model, compute the exact key and
    // return only variants for that key. Otherwise, scan the shard for any
    // variants whose language+glossary+prompt match (across providers).
    let key = koharu_app::translation_cache::TranslationCache::key(
        &req.source,
        req.target_language.as_deref().unwrap_or(""),
        req.provider_id.as_deref(),
        req.model_id.as_deref().unwrap_or(""),
        req.system_prompt.as_deref(),
        req.glossary.as_deref(),
    );

    let variants: Vec<CacheVariantDto> = app
        .translation_cache
        .get_all(&key)
        .into_iter()
        .map(Into::into)
        .collect();

    Ok(Json(CacheLookupResponse { variants }))
}

// --- Select ---------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CacheSelectRequest {
    pub source: String,
    #[serde(default)]
    pub target_language: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: String,
    pub translation: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub glossary: Option<String>,
}

#[utoipa::path(
    post,
    path = "/translation-cache/select",
    request_body = CacheSelectRequest,
    responses((status = 204))
)]
async fn select_variant(
    State(app): State<AppState>,
    Json(req): Json<CacheSelectRequest>,
) -> ApiResult<()> {
    let key = koharu_app::translation_cache::TranslationCache::key(
        &req.source,
        req.target_language.as_deref().unwrap_or(""),
        req.provider_id.as_deref(),
        &req.model_id,
        req.system_prompt.as_deref(),
        req.glossary.as_deref(),
    );
    app.translation_cache
        .select(&key, req.provider_id.as_deref(), &req.model_id, &req.translation)
        .map_err(ApiError::internal)?;
    Ok(())
}
