//! Yandex Translate API v2 (`translate`).
//!
//! Uses the official Yandex Cloud Translate REST endpoint with an API key
//! passed via the `Authorization: Api-Key <key>` header.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::Context;
use reqwest_middleware::ClientWithMiddleware;
use serde::{Deserialize, Serialize};

use crate::Language;

use super::AnyProvider;

const YANDEX_TRANSLATE_URL: &str = "https://translate.api.cloud.yandex.net/translate/v2/translate";

#[derive(Debug, Serialize)]
struct YandexRequest<'a> {
    texts: Vec<&'a str>,
    target_language_code: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_language_code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'static str>,
}

#[derive(Debug, Deserialize)]
struct YandexResponse {
    translations: Vec<YandexTranslation>,
}

#[derive(Debug, Deserialize)]
struct YandexTranslation {
    text: String,
}

pub struct YandexMtProvider {
    pub http_client: Arc<ClientWithMiddleware>,
    pub api_key: String,
}

impl AnyProvider for YandexMtProvider {
    fn translate<'a>(
        &'a self,
        source: &'a str,
        target_language: Language,
        _model: &'a str,
        _custom_system_prompt: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send + 'a>> {
        Box::pin(async move {
            let body = YandexRequest {
                texts: vec![source],
                target_language_code: target_language.tag(),
                source_language_code: None,
                format: Some("PLAIN_TEXT"),
            };

            let json =
                serde_json::to_vec(&body).context("serialize Yandex Translate request body")?;

            let response = self
                .http_client
                .post(YANDEX_TRANSLATE_URL)
                .header("Authorization", format!("Api-Key {}", self.api_key))
                .header("Content-Type", "application/json")
                .body(json)
                .send()
                .await
                .context("Yandex Translate request")?;

            let status = response.status();
            let response_text = response.text().await.context("Yandex response body")?;
            if !status.is_success() {
                anyhow::bail!("Yandex Translate API failed ({status}): {response_text}");
            }

            let parsed: YandexResponse = serde_json::from_str(&response_text)
                .with_context(|| format!("Yandex JSON parse: {response_text}"))?;
            let out = parsed
                .translations
                .into_iter()
                .next()
                .ok_or_else(|| anyhow::anyhow!("Yandex returned no translations"))?
                .text;
            Ok(out)
        })
    }
}
