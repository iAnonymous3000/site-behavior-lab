/**
 * The fixed words a decoded analytics event can be shown in (build brief
 * approved 2026-10-25, section 1 and owner call 1): Google's documented GA4
 * event names, Adobe Analytics' link types, and the scanner's own words for
 * a recognized scroll depth. The decoder (lib/analytics-events.ts) names an
 * event only in these words, never in a site's own, and the check's closed
 * evidence validator (lib/scroll-check-evidence.ts) refuses any other word,
 * so the two read one list and cannot drift apart. It imports nothing, so a
 * client bundle that validates a check's evidence carries nothing else from
 * here.
 */

/** The formats the decoder recognizes, by path and format parameters, never by host. */
export const GA4_FORMAT = "GA4";
export const ADOBE_ANALYTICS_FORMAT = "Adobe Analytics";
export const ANALYTICS_FORMATS = [GA4_FORMAT, ADOBE_ANALYTICS_FORMAT] as const;
export type AnalyticsFormat = (typeof ANALYTICS_FORMATS)[number];

/**
 * Google's documented GA4 event names, read 2026-10-25: the automatically
 * collected events, enhanced measurement's among them, and the recommended
 * events. A GA4 event name outside this list is site-defined text.
 */
export const GA4_STANDARD_EVENT_NAMES: readonly string[] = Object.freeze([
  // Automatically collected, enhanced measurement included.
  "ad_click",
  "ad_exposure",
  "ad_impression",
  "ad_query",
  "ad_reward",
  "adunit_exposure",
  "app_clear_data",
  "app_exception",
  "app_remove",
  "app_store_refund",
  "app_store_subscription_cancel",
  "app_store_subscription_convert",
  "app_store_subscription_renew",
  "app_update",
  "click",
  "dynamic_link_app_open",
  "dynamic_link_app_update",
  "dynamic_link_first_open",
  "error",
  "fiam_action",
  "fiam_dismiss",
  "fiam_impression",
  "file_download",
  "firebase_campaign",
  "firebase_in_app_message_action",
  "firebase_in_app_message_dismiss",
  "firebase_in_app_message_impression",
  "first_open",
  "first_visit",
  "form_start",
  "form_submit",
  "in_app_purchase",
  "notification_dismiss",
  "notification_foreground",
  "notification_open",
  "notification_receive",
  "os_update",
  "page_view",
  "screen_view",
  "scroll",
  "session_start",
  "user_engagement",
  "video_complete",
  "video_progress",
  "video_start",
  "view_search_results",
  // Recommended.
  "add_payment_info",
  "add_shipping_info",
  "add_to_cart",
  "add_to_wishlist",
  "begin_checkout",
  "close_convert_lead",
  "close_unconvert_lead",
  "disqualify_lead",
  "earn_virtual_currency",
  "generate_lead",
  "join_group",
  "level_end",
  "level_start",
  "level_up",
  "login",
  "post_score",
  "purchase",
  "qualify_lead",
  "refund",
  "remove_from_cart",
  "search",
  "select_content",
  "select_item",
  "select_promotion",
  "share",
  "sign_up",
  "spend_virtual_currency",
  "tutorial_begin",
  "tutorial_complete",
  "unlock_achievement",
  "view_cart",
  "view_item",
  "view_item_list",
  "view_promotion",
  "working_lead"
]);

/** GA4's scroll event: the one standard event whose percent_scrolled is read. */
export const GA4_SCROLL_EVENT = "scroll";

/**
 * Adobe Analytics' link types (its `pe`), in the scanner's words. A custom
 * link (`lnk_o`) is named by its link name under owner call 1, so it has no
 * word here.
 */
export const ADOBE_PAGE_VIEW = "page view";
export const ADOBE_DOWNLOAD_LINK = "download link";
export const ADOBE_EXIT_LINK = "exit link";
export const ADOBE_LINK_TYPE_NAMES: readonly string[] = Object.freeze([ADOBE_DOWNLOAD_LINK, ADOBE_EXIT_LINK, ADOBE_PAGE_VIEW]);

/**
 * A scroll depth recognized in a site's own event or link name (owner call
 * 1, option c), shown in the scanner's words with its percent: "scroll depth
 * 25%". The site's name itself is never shown.
 */
export const SCROLL_DEPTH_EVENT = "scroll depth";
