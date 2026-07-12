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
        filter_set.add_filter_list(rules.to_string(), ParseOptions::default());
        AdblockEngine {
            inner: Engine::new_with_filter_set(filter_set),
        }
    }

    /// Returns true if a request to `url` of `request_type`, initiated by
    /// `source_url`, would be blocked by the loaded lists. Kept for offline
    /// callers whose historical contract has GET semantics.
    pub fn check(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        self.check_with_method(url, source_url, request_type, "GET")
    }

    /// Method-aware network match for live routed requests. adblock-rust 0.13
    /// added `$method=` filters, so the scanner must pass the browser's actual
    /// method rather than silently treating POST/HEAD as GET.
    #[wasm_bindgen(js_name = checkWithMethod)]
    pub fn check_with_method(
        &self,
        url: &str,
        source_url: &str,
        request_type: &str,
        method: &str,
    ) -> bool {
        match Request::new(url, source_url, request_type, method) {
            Ok(request) => self.inner.check_network_request(&request).should_block(),
            Err(_) => false,
        }
    }
}
