use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;
use wasm_bindgen::prelude::*;

/// A compiled adblock engine, built once from newline-separated filter rules
/// (Brave / EasyList syntax) and then queried per network request.
#[wasm_bindgen]
pub struct AdblockEngine {
    inner: Engine,
}

#[wasm_bindgen]
impl AdblockEngine {
    /// Build an engine from newline-separated filter list rules.
    #[wasm_bindgen(constructor)]
    pub fn new(rules: &str) -> AdblockEngine {
        let mut filter_set = FilterSet::new(false);
        let lines: Vec<String> = rules.lines().map(|line| line.to_string()).collect();
        filter_set.add_filters(&lines, ParseOptions::default());
        AdblockEngine {
            inner: Engine::from_filter_set(filter_set, true),
        }
    }

    /// Returns true if a request to `url` of `request_type`, initiated by
    /// `source_url`, would be blocked by the loaded lists.
    pub fn check(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        match Request::new(url, source_url, request_type) {
            Ok(request) => self.inner.check_network_request(&request).matched,
            Err(_) => false,
        }
    }
}
