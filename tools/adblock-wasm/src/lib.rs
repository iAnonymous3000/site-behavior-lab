use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::sourcemap::FilterRuleDebugInfo;
use adblock::Engine;
use wasm_bindgen::prelude::*;

const SOURCE_HEADER_PREFIX: &str = "! ===== source: ";
const SOURCE_HEADER_SUFFIX: &str = " =====";

/// A compiled adblock engine, built once from newline-separated filter rules
/// (Brave / EasyList syntax) and then queried per network request.
#[wasm_bindgen]
pub struct AdblockEngine {
    inner: Engine,
    source_urls: Vec<String>,
}

#[wasm_bindgen]
impl AdblockEngine {
    /// Build a compact engine from newline-separated filter list rules
    /// (debug metadata off; kept for low-memory / legacy boolean callers).
    #[wasm_bindgen(constructor)]
    pub fn new(rules: &str) -> AdblockEngine {
        let mut filter_set = FilterSet::new(false);
        filter_set.add_filter_list(rules.to_string(), ParseOptions::default());
        AdblockEngine {
            inner: Engine::new_with_filter_set(filter_set),
            source_urls: Vec::new(),
        }
    }

    /// Build a full-telemetry engine with `FilterSet::new(true)` so every
    /// `checkDetailed` query reports the matched filter rule, originating list
    /// URL, line number, exception rule, `$redirect` surrogate, `$removeparam`
    /// rewritten URL, and Brave Standard vs. Aggressive blocking verdicts.
    #[wasm_bindgen(js_name = newWithDebug)]
    pub fn new_with_debug(rules: &str) -> AdblockEngine {
        let mut filter_set = FilterSet::new(true);
        let mut source_urls: Vec<String> = Vec::new();
        let mut current_source: Option<String> = None;
        let mut current_chunk = String::new();
        let mut saw_marker = false;

        for line in rules.lines() {
            if let Some(rest) = line.strip_prefix(SOURCE_HEADER_PREFIX) {
                let url = rest
                    .strip_suffix(SOURCE_HEADER_SUFFIX)
                    .unwrap_or(rest)
                    .trim();
                if saw_marker {
                    source_urls.push(current_source.take().unwrap_or_else(|| "unknown".to_string()));
                    filter_set.add_filter_list(
                        std::mem::take(&mut current_chunk),
                        ParseOptions::default(),
                    );
                } else {
                    current_chunk.clear();
                }
                saw_marker = true;
                current_source = Some(url.to_string());
                continue;
            }
            if !current_chunk.is_empty() {
                current_chunk.push('\n');
            }
            current_chunk.push_str(line);
        }

        if saw_marker {
            source_urls.push(current_source.unwrap_or_else(|| "unknown".to_string()));
            filter_set.add_filter_list(current_chunk, ParseOptions::default());
        } else {
            source_urls.push("custom".to_string());
            filter_set.add_filter_list(current_chunk, ParseOptions::default());
        }

        AdblockEngine {
            inner: Engine::new_with_filter_set(filter_set),
            source_urls,
        }
    }

    /// Number of distinct source lists indexed when constructed with `newWithDebug`.
    #[wasm_bindgen(js_name = sourceCount)]
    pub fn source_count(&self) -> usize {
        self.source_urls.len()
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

    /// Full `BlockerResult` query returning JSON with rule/list attribution,
    /// exceptions, `$redirect` surrogate, `$removeparam` rewritten URL, and
    /// both Brave Standard and Aggressive verdicts.
    #[wasm_bindgen(js_name = checkDetailed)]
    pub fn check_detailed(
        &self,
        url: &str,
        source_url: &str,
        request_type: &str,
        method: &str,
    ) -> String {
        let request = match Request::new(url, source_url, request_type, method) {
            Ok(req) => req,
            Err(_) => {
                return "{\"shouldBlock\":false,\"shouldBlockStandard\":false,\"shouldBlockAggressive\":false,\"matched\":false,\"isThirdParty\":false,\"important\":false,\"filter\":null,\"filterList\":null,\"filterLine\":null,\"exception\":null,\"exceptionList\":null,\"redirect\":null,\"rewrittenUrl\":null}".to_string();
            }
        };

        let result = self.inner.check_network_request(&request);
        let should_block_aggressive = result.should_block();
        let (filter_raw, filter_list, filter_line) = self.extract_debug_info(&result.filter);
        let (exception_raw, exception_list, _) = self.extract_debug_info(&result.exception);

        let is_first_party_list = filter_list
            .map(|list| list.contains("brave-firstparty"))
            .unwrap_or(false);
        let is_explicit_first_party_rule = filter_raw
            .map(rule_targets_first_party)
            .unwrap_or(false);
        let should_block_standard = should_block_aggressive
            && (request.is_third_party || is_first_party_list || is_explicit_first_party_rule);

        let matched = result.filter.is_some()
            || result.exception.is_some()
            || result.redirect.is_some()
            || result.rewritten_url.is_some();

        let mut out = String::with_capacity(256);
        out.push_str("{\"shouldBlock\":");
        out.push_str(if should_block_aggressive { "true" } else { "false" });
        out.push_str(",\"shouldBlockStandard\":");
        out.push_str(if should_block_standard { "true" } else { "false" });
        out.push_str(",\"shouldBlockAggressive\":");
        out.push_str(if should_block_aggressive { "true" } else { "false" });
        out.push_str(",\"matched\":");
        out.push_str(if matched { "true" } else { "false" });
        out.push_str(",\"isThirdParty\":");
        out.push_str(if request.is_third_party { "true" } else { "false" });
        out.push_str(",\"important\":");
        out.push_str(if result.important { "true" } else { "false" });
        out.push_str(",\"filter\":");
        push_json_opt_str(&mut out, filter_raw);
        out.push_str(",\"filterList\":");
        push_json_opt_str(&mut out, filter_list);
        out.push_str(",\"filterLine\":");
        match filter_line {
            Some(line) => out.push_str(&line.to_string()),
            None => out.push_str("null"),
        }
        out.push_str(",\"exception\":");
        push_json_opt_str(&mut out, exception_raw);
        out.push_str(",\"exceptionList\":");
        push_json_opt_str(&mut out, exception_list);
        out.push_str(",\"redirect\":");
        push_json_opt_str(&mut out, result.redirect.as_deref());
        out.push_str(",\"rewrittenUrl\":");
        push_json_opt_str(&mut out, result.rewritten_url.as_deref());
        out.push('}');
        out
    }

    fn extract_debug_info<'a>(
        &'a self,
        info: &'a Option<FilterRuleDebugInfo>,
    ) -> (Option<&'a str>, Option<&'a str>, Option<u32>) {
        let Some(info) = info else {
            return (None, None, None);
        };
        let raw = info.raw_line.as_deref();
        let (list, line) = match &info.source_location {
            Some(loc) => (
                self.source_urls.get(loc.source_index as usize).map(|s| s.as_str()),
                Some(loc.line_number + 1),
            ),
            None => (None, None),
        };
        (raw, list, line)
    }
}

fn rule_targets_first_party(raw_rule: &str) -> bool {
    let Some((_, options)) = raw_rule.rsplit_once('$') else {
        return false;
    };
    options.split(',').any(|opt| {
        matches!(
            opt.trim(),
            "1p" | "first-party" | "~3p" | "~third-party"
        )
    })
}

fn push_json_opt_str(out: &mut String, value: Option<&str>) {
    match value {
        Some(s) => push_json_str(out, s),
        None => out.push_str("null"),
    }
}

fn push_json_str(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
