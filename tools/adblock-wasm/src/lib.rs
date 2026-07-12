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
    /// `source_url`, would be blocked by the loaded lists.
    pub fn check(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        // The public wrapper historically had no method argument. Keep its
        // GET semantics stable across the adblock 0.13 API migration; a future
        // methodology revision can plumb the real request method explicitly.
        match Request::new(url, source_url, request_type, "GET") {
            Ok(request) => self.inner.check_network_request(&request).should_block(),
            Err(_) => false,
        }
    }
}
