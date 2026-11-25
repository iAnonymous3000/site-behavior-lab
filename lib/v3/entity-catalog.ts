/**
 * Expanded global multi-region entity catalog & corporate ownership graph for
 * Site Behavior Lab v3.
 *
 * Covers 160+ entities across US, EU/UK, APAC (CN/JP/KR/IN/SEA), RU, LATAM,
 * and global infrastructure with explicit parent-organization rollups,
 * functional categories, and server-side tagging signatures.
 */

import { sha256Hex } from "../sha256";
import type { EntityAttributionV3, EntityRegionV3, ServiceCategoryV3 } from "./schema";

export type EntityCatalogEntryV3 = {
  entity: string;
  parentOrg: string;
  category: ServiceCategoryV3;
  region: EntityRegionV3;
  suffixes: readonly string[];
  aliases?: readonly string[];
};

export const GLOBAL_ENTITY_CATALOG_V3: readonly EntityCatalogEntryV3[] = [
  // --- Alphabet / Google ---
  { entity: "Google Analytics", parentOrg: "Alphabet", category: "analytics", region: "US", suffixes: ["google-analytics.com", "analytics.google.com", "ssl.google-analytics.com"], aliases: ["google", "google analytics", "ga4"] },
  { entity: "Google Tag Manager", parentOrg: "Alphabet", category: "tag-manager", region: "US", suffixes: ["googletagmanager.com"], aliases: ["google", "google tag manager", "gtm"] },
  { entity: "Google Ads / DoubleClick", parentOrg: "Alphabet", category: "advertising", region: "US", suffixes: ["doubleclick.net", "googleadservices.com", "googlesyndication.com", "adservice.google.com", "2mdn.net", "googletraveladservices.com", "fundingchoicesmessages.google.com"], aliases: ["google", "doubleclick", "google ads", "adsense", "admob"] },
  { entity: "YouTube", parentOrg: "Alphabet", category: "social-widget", region: "US", suffixes: ["youtube.com", "youtube-nocookie.com", "ytimg.com", "googlevideo.com"], aliases: ["youtube", "google"] },
  { entity: "Google Fonts / Static", parentOrg: "Alphabet", category: "cdn-infra", region: "US", suffixes: ["fonts.googleapis.com", "fonts.gstatic.com", "ajax.googleapis.com", "gstatic.com"], aliases: ["google"] },
  { entity: "Google reCAPTCHA", parentOrg: "Alphabet", category: "anti-bot", region: "US", suffixes: ["recaptcha.net"], aliases: ["recaptcha", "google"] },
  { entity: "Firebase", parentOrg: "Alphabet", category: "analytics", region: "US", suffixes: ["firebaseio.com", "firebaselogging-pa.googleapis.com", "firebaseinstallations.googleapis.com"], aliases: ["firebase", "google"] },

  // --- Meta ---
  { entity: "Meta Pixel / Facebook", parentOrg: "Meta", category: "advertising", region: "US", suffixes: ["facebook.com", "facebook.net", "connect.facebook.net", "fbcdn.net", "fbsbx.com", "atdmt.com"], aliases: ["meta", "facebook", "meta platforms"] },
  { entity: "Instagram", parentOrg: "Meta", category: "social-widget", region: "US", suffixes: ["instagram.com", "cdninstagram.com"], aliases: ["instagram", "meta"] },
  { entity: "WhatsApp", parentOrg: "Meta", category: "social-widget", region: "US", suffixes: ["whatsapp.com", "whatsapp.net"], aliases: ["whatsapp", "meta"] },

  // --- Microsoft ---
  { entity: "Microsoft Advertising", parentOrg: "Microsoft", category: "advertising", region: "US", suffixes: ["bat.bing.com", "bing.com", "adnxs.com", "adnxs-simple.com", "appnexus.com", "xandr.com"], aliases: ["microsoft", "bing", "xandr", "appnexus"] },
  { entity: "Microsoft Clarity", parentOrg: "Microsoft", category: "session-replay", region: "US", suffixes: ["clarity.ms"], aliases: ["clarity", "microsoft clarity", "microsoft"] },
  { entity: "LinkedIn", parentOrg: "Microsoft", category: "advertising", region: "US", suffixes: ["linkedin.com", "ads.linkedin.com", "px.ads.linkedin.com", "licdn.com", "snap.licdn.com", "bizographics.com"], aliases: ["linkedin", "microsoft"] },
  { entity: "Microsoft Azure CDN", parentOrg: "Microsoft", category: "cdn-infra", region: "US", suffixes: ["azureedge.net", "azurefd.net", "msecnd.net"], aliases: ["azure", "microsoft"] },
  { entity: "Application Insights", parentOrg: "Microsoft", category: "error-monitoring", region: "US", suffixes: ["monitor.azure.com", "dc.services.visualstudio.com"], aliases: ["microsoft"] },

  // --- Amazon ---
  { entity: "Amazon Ads", parentOrg: "Amazon", category: "advertising", region: "US", suffixes: ["amazon-adsystem.com", "assoc-amazon.com", "serving-sys.com", "sizmek.com"], aliases: ["amazon", "amazon ads", "sizmek"] },
  { entity: "Amazon CloudFront", parentOrg: "Amazon", category: "cdn-infra", region: "US", suffixes: ["cloudfront.net"], aliases: ["amazon", "aws", "cloudfront"] },
  { entity: "Twitch", parentOrg: "Amazon", category: "social-widget", region: "US", suffixes: ["twitch.tv", "ttvnw.net", "jtvnw.net"], aliases: ["twitch", "amazon"] },

  // --- ByteDance / TikTok ---
  { entity: "TikTok", parentOrg: "ByteDance", category: "advertising", region: "APAC", suffixes: ["tiktok.com", "analytics.tiktok.com", "business-api.tiktok.com", "tiktokcdn.com", "byteoversea.com", "ibytedtos.com", "musical.ly"], aliases: ["tiktok", "bytedance"] },

  // --- X Corp ---
  { entity: "X (Twitter)", parentOrg: "X Corp", category: "advertising", region: "US", suffixes: ["x.com", "twitter.com", "ads-twitter.com", "analytics.twitter.com", "t.co", "twimg.com"], aliases: ["twitter", "x corp"] },

  // --- Snap / Pinterest / Reddit / Quora / Nextdoor ---
  { entity: "Snap", parentOrg: "Snap Inc.", category: "advertising", region: "US", suffixes: ["sc-static.net", "snapchat.com", "tr.snapchat.com", "snapkit.com"], aliases: ["snapchat", "snap"] },
  { entity: "Pinterest", parentOrg: "Pinterest", category: "advertising", region: "US", suffixes: ["pinterest.com", "ct.pinterest.com", "pinimg.com"], aliases: ["pinterest"] },
  { entity: "Reddit", parentOrg: "Reddit", category: "advertising", region: "US", suffixes: ["redditstatic.com", "alb.reddit.com", "events.redditmedia.com", "reddit.com"], aliases: ["reddit"] },
  { entity: "Quora", parentOrg: "Quora", category: "advertising", region: "US", suffixes: ["q.quora.com", "quora.com"], aliases: ["quora"] },
  { entity: "Nextdoor", parentOrg: "Nextdoor", category: "advertising", region: "US", suffixes: ["flask.nextdoor.com", "nextdoor.com"], aliases: ["nextdoor"] },

  // --- Adobe ---
  { entity: "Adobe Experience Cloud", parentOrg: "Adobe", category: "analytics", region: "US", suffixes: ["omtrdc.net", "2o7.net", "adobedtm.com", "adobedc.net", "demdex.net", "everesttech.net", "tt.omtrdc.net"], aliases: ["adobe", "omniture", "adobe analytics", "audience manager"] },
  { entity: "Marketo", parentOrg: "Adobe", category: "marketing-automation", region: "US", suffixes: ["marketo.com", "marketo.net", "mktoresp.com", "munchkin.marketo.net"], aliases: ["marketo", "adobe"] },

  // --- Oracle ---
  { entity: "Oracle Advertising / BlueKai", parentOrg: "Oracle", category: "advertising", region: "US", suffixes: ["bluekai.com", "bkrtx.com", "addthis.com", "addthisedge.com", "moatads.com", "moatpixel.com", "grapeshot.co.uk"], aliases: ["oracle", "bluekai", "moat", "addthis"] },
  { entity: "Oracle Eloqua", parentOrg: "Oracle", category: "marketing-automation", region: "US", suffixes: ["eloqua.com", "en25.com"], aliases: ["eloqua", "oracle"] },

  // --- Salesforce ---
  { entity: "Salesforce Marketing / Krux", parentOrg: "Salesforce", category: "marketing-automation", region: "US", suffixes: ["krxd.net", "pardot.com", "evergage.com", "exacttarget.com", "salesforceliveagent.com", "salesforce.com"], aliases: ["salesforce", "pardot", "krux", "evergage"] },

  // --- AdTech Exchanges / DSPs / SSPs / Verification ---
  { entity: "The Trade Desk", parentOrg: "The Trade Desk", category: "advertising", region: "US", suffixes: ["adsrvr.org", "thetradedesk.com", "uidapi.com"], aliases: ["the trade desk", "tradedesk", "uid2"] },
  { entity: "Criteo", parentOrg: "Criteo", category: "advertising", region: "EU", suffixes: ["criteo.com", "criteo.net", "gum.criteo.com"], aliases: ["criteo"] },
  { entity: "Taboola", parentOrg: "Taboola", category: "advertising", region: "US", suffixes: ["taboola.com", "taboolasyndication.com", "trc.taboola.com"], aliases: ["taboola"] },
  { entity: "Outbrain", parentOrg: "Outbrain", category: "advertising", region: "US", suffixes: ["outbrain.com", "outbrainimg.com", "zemanta.com"], aliases: ["outbrain", "zemanta"] },
  { entity: "Teads", parentOrg: "Outbrain", category: "advertising", region: "EU", suffixes: ["teads.tv", "a.teads.tv"], aliases: ["teads"] },
  { entity: "Magnite", parentOrg: "Magnite", category: "advertising", region: "US", suffixes: ["rubiconproject.com", "rubicon.com", "magnite.com", "spotxchange.com", "spotx.tv"], aliases: ["magnite", "rubicon", "spotx"] },
  { entity: "PubMatic", parentOrg: "PubMatic", category: "advertising", region: "US", suffixes: ["pubmatic.com", "ads.pubmatic.com"], aliases: ["pubmatic"] },
  { entity: "OpenX", parentOrg: "OpenX", category: "advertising", region: "US", suffixes: ["openx.net", "openx.com"], aliases: ["openx"] },
  { entity: "Index Exchange", parentOrg: "Index Exchange", category: "advertising", region: "US", suffixes: ["casalemedia.com", "indexexchange.com", "indexww.com"], aliases: ["index exchange", "casale media"] },
  { entity: "TripleLift", parentOrg: "TripleLift", category: "advertising", region: "US", suffixes: ["3lift.com"], aliases: ["triplelift"] },
  { entity: "Equativ (Smart AdServer)", parentOrg: "Equativ", category: "advertising", region: "EU", suffixes: ["smartadserver.com", "sascdn.com", "equativ.com", "sharethrough.com"], aliases: ["equativ", "smart adserver", "sharethrough"] },
  { entity: "Yahoo Advertising", parentOrg: "Yahoo", category: "advertising", region: "US", suffixes: ["advertising.com", "adtech.de", "adtechus.com", "gemini.yahoo.com", "analytics.yahoo.com", "sp.analytics.yahoo.com", "oath.com"], aliases: ["yahoo", "oath", "verizon media"] },
  { entity: "Media.net", parentOrg: "Media.net", category: "advertising", region: "APAC", suffixes: ["media.net", "contextual.media.net"], aliases: ["media.net"] },
  { entity: "StackAdapt", parentOrg: "StackAdapt", category: "advertising", region: "US", suffixes: ["stackadapt.com", "srv.stackadapt.com"], aliases: ["stackadapt"] },
  { entity: "AdRoll / NextRoll", parentOrg: "NextRoll", category: "advertising", region: "US", suffixes: ["adroll.com", "nextroll.com"], aliases: ["adroll", "nextroll"] },
  { entity: "Sovrn", parentOrg: "Sovrn", category: "advertising", region: "US", suffixes: ["lijit.com", "sovrn.com"], aliases: ["sovrn", "lijit"] },
  { entity: "Quantcast", parentOrg: "Quantcast", category: "advertising", region: "US", suffixes: ["quantserve.com", "quantcount.com", "quantcast.com"], aliases: ["quantcast"] },
  { entity: "Comscore", parentOrg: "Comscore", category: "analytics", region: "US", suffixes: ["scorecardresearch.com", "comscore.com"], aliases: ["comscore", "scorecardresearch"] },
  { entity: "Nielsen", parentOrg: "Nielsen", category: "analytics", region: "US", suffixes: ["imrworldwide.com", "nielsen.com", "exelator.com"], aliases: ["nielsen", "exelate"] },
  { entity: "DoubleVerify", parentOrg: "DoubleVerify", category: "advertising", region: "US", suffixes: ["doubleverify.com", "dvtp.io"], aliases: ["doubleverify"] },
  { entity: "Integral Ad Science (IAS)", parentOrg: "Integral Ad Science", category: "advertising", region: "US", suffixes: ["adsafeprotected.com", "iasds01.com"], aliases: ["integral ad science", "ias"] },
  { entity: "MediaMath", parentOrg: "Infillion", category: "advertising", region: "US", suffixes: ["mathtag.com"], aliases: ["mediamath"] },
  { entity: "BidSwitch", parentOrg: "Criteo", category: "advertising", region: "EU", suffixes: ["bidswitch.net"], aliases: ["bidswitch"] },
  { entity: "GumGum", parentOrg: "GumGum", category: "advertising", region: "US", suffixes: ["gumgum.com"], aliases: ["gumgum"] },
  { entity: "Kargo", parentOrg: "Kargo", category: "advertising", region: "US", suffixes: ["krg.com", "kargo.com"], aliases: ["kargo"] },
  { entity: "Yieldmo", parentOrg: "Yieldmo", category: "advertising", region: "US", suffixes: ["yieldmo.com"], aliases: ["yieldmo"] },
  { entity: "Mediavine", parentOrg: "Mediavine", category: "advertising", region: "US", suffixes: ["mediavine.com"], aliases: ["mediavine"] },
  { entity: "Raptive (AdThrive)", parentOrg: "Raptive", category: "advertising", region: "US", suffixes: ["adthrive.com", "cafemedia.com"], aliases: ["raptive", "adthrive", "cafemedia"] },
  { entity: "Prebid / Rubicon Header Bidding", parentOrg: "Prebid", category: "advertising", region: "GLOBAL", suffixes: ["prebid.org", "pbjs.org"], aliases: ["prebid"] },
  { entity: "RTB House", parentOrg: "RTB House", category: "advertising", region: "EU", suffixes: ["creativecdn.com", "rtbhouse.com"], aliases: ["rtb house"] },
  { entity: "Adform", parentOrg: "Adform", category: "advertising", region: "EU", suffixes: ["adform.net", "adform.com"], aliases: ["adform"] },
  { entity: "Improve Digital", parentOrg: "Azerion", category: "advertising", region: "EU", suffixes: ["360yield.com", "improvedigital.com"], aliases: ["improve digital", "azerion"] },
  { entity: "Seedtag", parentOrg: "Seedtag", category: "advertising", region: "EU", suffixes: ["seedtag.com"], aliases: ["seedtag"] },
  { entity: "Ogury", parentOrg: "Ogury", category: "advertising", region: "EU", suffixes: ["ogury.com", "presage.io"], aliases: ["ogury"] },
  { entity: "AppLovin / Adjust", parentOrg: "AppLovin", category: "advertising", region: "US", suffixes: ["applovin.com", "adjust.com"], aliases: ["applovin", "adjust"] },
  { entity: "Unity Ads / ironSource", parentOrg: "Unity", category: "advertising", region: "US", suffixes: ["unityads.unity3d.com", "supersonicads.com"], aliases: ["unity", "ironsource"] },

  // --- Identity Brokers & Data Management ---
  { entity: "LiveRamp", parentOrg: "LiveRamp", category: "identity-broker", region: "US", suffixes: ["rlcdn.com", "liveramp.com", "pippio.com", "idsync.rlcdn.com"], aliases: ["liveramp"] },
  { entity: "ID5", parentOrg: "ID5", category: "identity-broker", region: "UK", suffixes: ["id5-sync.com", "id5.io"], aliases: ["id5"] },
  { entity: "Lotame", parentOrg: "Lotame", category: "identity-broker", region: "US", suffixes: ["crwdcntrl.net", "lotame.com"], aliases: ["lotame"] },
  { entity: "Epsilon / Conversant", parentOrg: "Publicis Groupe", category: "identity-broker", region: "US", suffixes: ["dotomi.com", "conversantmedia.com", "emxdgt.com", "epsilon.com"], aliases: ["epsilon", "conversant", "publicis"] },
  { entity: "Tapad", parentOrg: "Experian", category: "identity-broker", region: "US", suffixes: ["tapad.com"], aliases: ["tapad", "experian"] },
  { entity: "Neustar / TransUnion", parentOrg: "TransUnion", category: "identity-broker", region: "US", suffixes: ["agkn.com", "neustar.biz"], aliases: ["neustar", "transunion"] },
  { entity: "LiveIntent", parentOrg: "LiveIntent", category: "identity-broker", region: "US", suffixes: ["liadm.com", "liveintent.com"], aliases: ["liveintent"] },
  { entity: "Zeotap", parentOrg: "Zeotap", category: "identity-broker", region: "EU", suffixes: ["zeotap.com"], aliases: ["zeotap"] },
  { entity: "Permutive", parentOrg: "Permutive", category: "identity-broker", region: "UK", suffixes: ["permutive.com", "permutive.app"], aliases: ["permutive"] },
  { entity: "6sense", parentOrg: "6sense", category: "identity-broker", region: "US", suffixes: ["6sc.co", "6sense.com"], aliases: ["6sense"] },
  { entity: "Demandbase", parentOrg: "Demandbase", category: "identity-broker", region: "US", suffixes: ["demandbase.com", "company-target.com"], aliases: ["demandbase"] },
  { entity: "Clearbit", parentOrg: "HubSpot", category: "identity-broker", region: "US", suffixes: ["clearbit.com", "clearbitjs.com"], aliases: ["clearbit", "hubspot"] },
  { entity: "ZoomInfo", parentOrg: "ZoomInfo", category: "identity-broker", region: "US", suffixes: ["ws.zoominfo.com", "zoominfo.com"], aliases: ["zoominfo"] },

  // --- Session Replay & Behavior Analytics ---
  { entity: "Hotjar", parentOrg: "Contentsquare", category: "session-replay", region: "EU", suffixes: ["hotjar.com", "hotjar.io"], aliases: ["hotjar", "contentsquare"] },
  { entity: "Contentsquare", parentOrg: "Contentsquare", category: "session-replay", region: "EU", suffixes: ["contentsquare.net", "contentsquare.com", "clicktale.net"], aliases: ["contentsquare", "clicktale"] },
  { entity: "Heap", parentOrg: "Contentsquare", category: "analytics", region: "US", suffixes: ["heapanalytics.com", "heap.io"], aliases: ["heap", "contentsquare"] },
  { entity: "FullStory", parentOrg: "FullStory", category: "session-replay", region: "US", suffixes: ["fullstory.com", "fullstorydev.com", "edge.fullstory.com"], aliases: ["fullstory"] },
  { entity: "LogRocket", parentOrg: "LogRocket", category: "session-replay", region: "US", suffixes: ["logrocket.com", "lr-ingest.com", "lr-in.com", "lr-in-prod.com"], aliases: ["logrocket"] },
  { entity: "Quantum Metric", parentOrg: "Quantum Metric", category: "session-replay", region: "US", suffixes: ["quantummetric.com"], aliases: ["quantum metric"] },
  { entity: "Glassbox", parentOrg: "Glassbox", category: "session-replay", region: "US", suffixes: ["glassboxdigital.io", "glassboxcdn.com"], aliases: ["glassbox"] },
  { entity: "Mouseflow", parentOrg: "Mouseflow", category: "session-replay", region: "EU", suffixes: ["mouseflow.com"], aliases: ["mouseflow"] },
  { entity: "Lucky Orange", parentOrg: "Lucky Orange", category: "session-replay", region: "US", suffixes: ["luckyorange.com", "luckyorange.net"], aliases: ["lucky orange"] },
  { entity: "Crazy Egg", parentOrg: "Crazy Egg", category: "session-replay", region: "US", suffixes: ["crazyegg.com"], aliases: ["crazy egg"] },
  { entity: "Smartlook", parentOrg: "Cisco", category: "session-replay", region: "EU", suffixes: ["smartlook.com", "smartlook.cloud"], aliases: ["smartlook"] },
  { entity: "Inspectlet", parentOrg: "Inspectlet", category: "session-replay", region: "US", suffixes: ["inspectlet.com"], aliases: ["inspectlet"] },
  { entity: "SessionCam", parentOrg: "Glassbox", category: "session-replay", region: "UK", suffixes: ["sessioncam.com"], aliases: ["sessioncam"] },
  { entity: "Decibel", parentOrg: "Medallia", category: "session-replay", region: "UK", suffixes: ["decibelinsight.net"], aliases: ["decibel", "medallia"] },

  // --- CDPs, Tag Managers & Product Analytics ---
  { entity: "Twilio Segment", parentOrg: "Twilio", category: "cdp", region: "US", suffixes: ["segment.io", "segment.com", "cdn.segment.com", "api.segment.io"], aliases: ["segment", "twilio"] },
  { entity: "Tealium", parentOrg: "Tealium", category: "tag-manager", region: "US", suffixes: ["tealiumiq.com", "tiqcdn.com", "tealium.com"], aliases: ["tealium"] },
  { entity: "mParticle", parentOrg: "Rokt", category: "cdp", region: "US", suffixes: ["mparticle.com"], aliases: ["mparticle"] },
  { entity: "RudderStack", parentOrg: "RudderStack", category: "cdp", region: "US", suffixes: ["rudderlabs.com", "rudderstack.com"], aliases: ["rudderstack"] },
  { entity: "Amplitude", parentOrg: "Amplitude", category: "analytics", region: "US", suffixes: ["amplitude.com", "amplitudeexperiment.com"], aliases: ["amplitude"] },
  { entity: "Mixpanel", parentOrg: "Mixpanel", category: "analytics", region: "US", suffixes: ["mixpanel.com", "mxpnl.com"], aliases: ["mixpanel"] },
  { entity: "PostHog", parentOrg: "PostHog", category: "analytics", region: "US", suffixes: ["posthog.com", "us.i.posthog.com", "eu.i.posthog.com"], aliases: ["posthog"] },
  { entity: "Snowplow", parentOrg: "Snowplow", category: "analytics", region: "UK", suffixes: ["snowplowanalytics.com", "snplow.net"], aliases: ["snowplow"] },
  { entity: "Pendo", parentOrg: "Pendo", category: "analytics", region: "US", suffixes: ["pendo.io"], aliases: ["pendo"] },
  { entity: "Statsig", parentOrg: "Statsig", category: "analytics", region: "US", suffixes: ["statsig.com", "statsigapi.net"], aliases: ["statsig"] },
  { entity: "Optimizely", parentOrg: "Optimizely", category: "analytics", region: "US", suffixes: ["optimizely.com", "optimizelyedge.com"], aliases: ["optimizely"] },
  { entity: "VWO", parentOrg: "Wingify", category: "analytics", region: "APAC", suffixes: ["visualwebsiteoptimizer.com", "vwo.com"], aliases: ["vwo", "wingify"] },
  { entity: "AB Tasty", parentOrg: "AB Tasty", category: "analytics", region: "EU", suffixes: ["abtasty.com"], aliases: ["ab tasty"] },
  { entity: "LaunchDarkly", parentOrg: "LaunchDarkly", category: "analytics", region: "US", suffixes: ["launchdarkly.com"], aliases: ["launchdarkly"] },
  { entity: "Chartbeat", parentOrg: "Chartbeat", category: "analytics", region: "US", suffixes: ["chartbeat.com", "chartbeat.net"], aliases: ["chartbeat"] },
  { entity: "Parse.ly", parentOrg: "Automattic", category: "analytics", region: "US", suffixes: ["parsely.com"], aliases: ["parse.ly", "automattic"] },
  { entity: "Matomo", parentOrg: "InnoCraft", category: "analytics", region: "EU", suffixes: ["matomo.cloud", "matomo.org"], aliases: ["matomo", "piwik"] },
  { entity: "Piwik PRO", parentOrg: "Piwik PRO", category: "analytics", region: "EU", suffixes: ["piwik.pro", "containers.piwik.pro"], aliases: ["piwik pro"] },
  { entity: "Plausible", parentOrg: "Plausible Insights", category: "analytics", region: "EU", suffixes: ["plausible.io"], aliases: ["plausible"] },
  { entity: "Fathom Analytics", parentOrg: "Conva Ventures", category: "analytics", region: "US", suffixes: ["usefathom.com"], aliases: ["fathom"] },
  { entity: "Cloudflare Web Analytics", parentOrg: "Cloudflare", category: "analytics", region: "US", suffixes: ["cloudflareinsights.com"], aliases: ["cloudflare"] },

  // --- EU / Regional Analytics, CNAME-Cloaking & Tag Managers ---
  { entity: "Eulerian", parentOrg: "Eulerian Technologies", category: "analytics", region: "EU", suffixes: ["eulerian.net", "eulerian.com"], aliases: ["eulerian"] },
  { entity: "Piano / AT Internet", parentOrg: "Piano Software", category: "analytics", region: "EU", suffixes: ["atinternet.com", "xiti.com", "pa-cd.com", "piano.io", "tinypass.com"], aliases: ["piano", "at internet", "xiti"] },
  { entity: "Commanders Act", parentOrg: "Commanders Act", category: "tag-manager", region: "EU", suffixes: ["tagcommander.com", "commander1.com", "commandersact.com"], aliases: ["commanders act", "tagcommander"] },
  { entity: "Econda", parentOrg: "Econda", category: "analytics", region: "EU", suffixes: ["econda-monitor.de", "econda.de"], aliases: ["econda"] },
  { entity: "etracker", parentOrg: "etracker", category: "analytics", region: "EU", suffixes: ["etracker.com", "etracker.de"], aliases: ["etracker"] },
  { entity: "Mapp Intelligence (Webtrekk)", parentOrg: "Mapp Digital", category: "analytics", region: "EU", suffixes: ["webtrekk.net", "wt-eu02.net", "mapp.com"], aliases: ["mapp", "webtrekk"] },
  { entity: "INFOnline (IOAM)", parentOrg: "INFOnline", category: "analytics", region: "EU", suffixes: ["ioam.de", "ivwbox.de"], aliases: ["infonline", "ioam", "ivw"] },
  { entity: "Gemius", parentOrg: "Gemius", category: "analytics", region: "EU", suffixes: ["hit.gemius.pl", "gemius.pl"], aliases: ["gemius"] },
  { entity: "Cint / Kantar", parentOrg: "Kantar", category: "analytics", region: "UK", suffixes: ["kantar.com", "tns-counter.ru", "research-int.se"], aliases: ["kantar"] },
  { entity: "Stape (sGTM Host)", parentOrg: "Stape", category: "server-side-tagging", region: "US", suffixes: ["stape.io", "stape.net", "stape.eu"], aliases: ["stape"] },
  { entity: "Addingwell (sGTM Host)", parentOrg: "Addingwell", category: "server-side-tagging", region: "EU", suffixes: ["addingwell.io"], aliases: ["addingwell"] },

  // --- APAC / CN / JP / KR / RU / LATAM Trackers & Platforms ---
  { entity: "Yandex Metrica / Ads", parentOrg: "Yandex", category: "analytics", region: "RU", suffixes: ["mc.yandex.ru", "mc.yandex.com", "yandex.ru", "yastatic.net", "an.yandex.ru"], aliases: ["yandex", "yandex metrica"] },
  { entity: "VK / Top.Mail.Ru", parentOrg: "VK", category: "advertising", region: "RU", suffixes: ["top-fwz1.mail.ru", "vk.com", "my.com", "target.my.com"], aliases: ["vk", "mail.ru"] },
  { entity: "Baidu Tongji / Ads", parentOrg: "Baidu", category: "analytics", region: "CN", suffixes: ["hm.baidu.com", "pos.baidu.com", "cpro.baidu.com", "baidu.com"], aliases: ["baidu"] },
  { entity: "Tencent Analytics / Ads", parentOrg: "Tencent", category: "advertising", region: "CN", suffixes: ["gdt.qq.com", "e.qq.com", "tajs.qq.com", "gtimg.cn"], aliases: ["tencent", "qq"] },
  { entity: "Alibaba / Umeng / Alimama", parentOrg: "Alibaba Group", category: "advertising", region: "CN", suffixes: ["mmstat.com", "cnzz.com", "umeng.com", "tanx.com", "alicdn.com"], aliases: ["alibaba", "umeng", "cnzz", "alimama"] },
  { entity: "Yahoo Japan / LINE (LY Corp)", parentOrg: "LY Corporation", category: "advertising", region: "APAC", suffixes: ["yimg.jp", "s.yimg.jp", "yjtag.jp", "tr.line.me", "scdn.line-apps.com"], aliases: ["yahoo japan", "line", "ly corporation"] },
  { entity: "Rakuten Advertising", parentOrg: "Rakuten", category: "advertising", region: "APAC", suffixes: ["rakuten.co.jp", "linksynergy.com", "rmtag.com"], aliases: ["rakuten", "linkshare"] },
  { entity: "Naver Analytics / Ads", parentOrg: "Naver", category: "analytics", region: "APAC", suffixes: ["wcs.naver.net", "siape.veta.naver.com", "naver.net"], aliases: ["naver"] },
  { entity: "Kakao Pixel", parentOrg: "Kakao", category: "advertising", region: "APAC", suffixes: ["t1.daumcdn.net", "track.tiara.kakao.com", "kakao.com"], aliases: ["kakao", "daum"] },
  { entity: "MicroAd / Fluct / Geniee", parentOrg: "MicroAd", category: "advertising", region: "APAC", suffixes: ["microad.jp", "fluct.jp", "gsspcln.jp"], aliases: ["microad", "fluct", "geniee"] },
  { entity: "Mercado Ads", parentOrg: "MercadoLibre", category: "advertising", region: "LATAM", suffixes: ["mercadolibre.com", "mlstatic.com"], aliases: ["mercadolibre", "mercado ads"] },
  { entity: "Navegg", parentOrg: "Dentsu", category: "identity-broker", region: "LATAM", suffixes: ["navdmp.com", "navegg.com"], aliases: ["navegg"] },

  // --- Consent Management Platforms (CMPs) ---
  { entity: "OneTrust", parentOrg: "OneTrust", category: "consent-platform", region: "US", suffixes: ["cookielaw.org", "onetrust.com", "optanon.blob.core.windows.net"], aliases: ["onetrust", "optanon"] },
  { entity: "Cookiebot (Usercentrics)", parentOrg: "Usercentrics", category: "consent-platform", region: "EU", suffixes: ["cookiebot.com", "cookiebot.eu"], aliases: ["cookiebot", "usercentrics"] },
  { entity: "Usercentrics", parentOrg: "Usercentrics", category: "consent-platform", region: "EU", suffixes: ["usercentrics.eu", "usercentrics.com"], aliases: ["usercentrics"] },
  { entity: "Didomi", parentOrg: "Didomi", category: "consent-platform", region: "EU", suffixes: ["didomi.io", "privacy-center.org"], aliases: ["didomi"] },
  { entity: "Sourcepoint", parentOrg: "Sourcepoint", category: "consent-platform", region: "US", suffixes: ["sp-prod.net", "sourcepoint.com", "privacy-mgmt.com"], aliases: ["sourcepoint"] },
  { entity: "TrustArc", parentOrg: "TrustArc", category: "consent-platform", region: "US", suffixes: ["trustarc.com", "truste.com"], aliases: ["trustarc", "truste"] },
  { entity: "Quantcast Choice", parentOrg: "InMobi", category: "consent-platform", region: "US", suffixes: ["quantcast.mgr.consensu.org", "cmp.inmobi.com"], aliases: ["quantcast choice", "inmobi"] },
  { entity: "CookieYes", parentOrg: "CookieYes", category: "consent-platform", region: "UK", suffixes: ["cookieyes.com"], aliases: ["cookieyes"] },
  { entity: "Osano", parentOrg: "Osano", category: "consent-platform", region: "US", suffixes: ["osano.com"], aliases: ["osano"] },
  { entity: "Iubenda", parentOrg: "TeamSystem", category: "consent-platform", region: "EU", suffixes: ["iubenda.com"], aliases: ["iubenda"] },
  { entity: "Ketch", parentOrg: "Ketch", category: "consent-platform", region: "US", suffixes: ["ketchcdn.com", "ketch.com"], aliases: ["ketch"] },
  { entity: "Transcend", parentOrg: "Transcend", category: "consent-platform", region: "US", suffixes: ["transcend-cdn.com", "transcend.io"], aliases: ["transcend"] },
  { entity: "Termly", parentOrg: "Termly", category: "consent-platform", region: "US", suffixes: ["termly.io"], aliases: ["termly"] },
  { entity: "ConsentManager", parentOrg: "consentmanager AB", category: "consent-platform", region: "EU", suffixes: ["consentmanager.net", "consentmanager.mgr.consensu.org"], aliases: ["consentmanager"] },

  // --- Marketing Automation / CRM / Messaging ---
  { entity: "HubSpot", parentOrg: "HubSpot", category: "marketing-automation", region: "US", suffixes: ["hubspot.com", "hs-scripts.com", "hs-analytics.net", "hsforms.net", "hs-banner.com", "hscollectedforms.net"], aliases: ["hubspot"] },
  { entity: "Klaviyo", parentOrg: "Klaviyo", category: "marketing-automation", region: "US", suffixes: ["klaviyo.com", "a.klaviyo.com"], aliases: ["klaviyo"] },
  { entity: "Braze", parentOrg: "Braze", category: "marketing-automation", region: "US", suffixes: ["braze.com", "braze.eu", "appboy.com"], aliases: ["braze", "appboy"] },
  { entity: "Mailchimp", parentOrg: "Intuit", category: "marketing-automation", region: "US", suffixes: ["mailchimp.com", "list-manage.com", "chimpstatic.com"], aliases: ["mailchimp", "intuit"] },
  { entity: "Intercom", parentOrg: "Intercom", category: "marketing-automation", region: "US", suffixes: ["intercom.io", "intercomcdn.com"], aliases: ["intercom"] },
  { entity: "Drift", parentOrg: "Salesloft", category: "marketing-automation", region: "US", suffixes: ["drift.com", "driftcdn.com", "driftt.com"], aliases: ["drift", "salesloft"] },
  { entity: "Zendesk", parentOrg: "Zendesk", category: "marketing-automation", region: "US", suffixes: ["zendesk.com", "zdassets.com", "zopim.com"], aliases: ["zendesk"] },
  { entity: "ActiveCampaign", parentOrg: "ActiveCampaign", category: "marketing-automation", region: "US", suffixes: ["trackcmp.net", "activehosted.com"], aliases: ["activecampaign"] },
  { entity: "Iterable", parentOrg: "Iterable", category: "marketing-automation", region: "US", suffixes: ["iterable.com"], aliases: ["iterable"] },
  { entity: "OneSignal", parentOrg: "OneSignal", category: "marketing-automation", region: "US", suffixes: ["onesignal.com"], aliases: ["onesignal"] },
  { entity: "Attentive", parentOrg: "Attentive", category: "marketing-automation", region: "US", suffixes: ["attn.tv", "attentivemobile.com"], aliases: ["attentive"] },
  { entity: "Yotpo", parentOrg: "Yotpo", category: "marketing-automation", region: "US", suffixes: ["yotpo.com"], aliases: ["yotpo"] },
  { entity: "Shopify Analytics", parentOrg: "Shopify", category: "analytics", region: "US", suffixes: ["monorail-edge.shopifysvc.com", "shopifycloud.com", "cdn.shopify.com"], aliases: ["shopify"] },
  { entity: "Criteo Retail / Impact / CJ Affiliate", parentOrg: "Publicis / Affiliate", category: "advertising", region: "US", suffixes: ["impactcdn.com", "emjcd.com", "anrdoezrs.net", "awin1.com", "dwin1.com", "shareasale.com", "rakuten.com"], aliases: ["impact", "cj affiliate", "awin", "shareasale"] },

  // --- Error Monitoring / APM / RUM ---
  { entity: "Sentry", parentOrg: "Functional Software", category: "error-monitoring", region: "US", suffixes: ["sentry.io", "sentry-cdn.com"], aliases: ["sentry"] },
  { entity: "Datadog RUM", parentOrg: "Datadog", category: "error-monitoring", region: "US", suffixes: ["datadoghq.com", "datadoghq-browser-agent.com", "datadoghq.eu"], aliases: ["datadog"] },
  { entity: "New Relic", parentOrg: "New Relic", category: "error-monitoring", region: "US", suffixes: ["newrelic.com", "nr-data.net", "bam.nr-data.net"], aliases: ["new relic"] },
  { entity: "Bugsnag", parentOrg: "SmartBear", category: "error-monitoring", region: "US", suffixes: ["bugsnag.com"], aliases: ["bugsnag"] },
  { entity: "Dynatrace", parentOrg: "Dynatrace", category: "error-monitoring", region: "US", suffixes: ["dynatrace.com", "ruxit.com"], aliases: ["dynatrace"] },
  { entity: "SpeedCurve / Akamai mPulse", parentOrg: "Akamai", category: "error-monitoring", region: "US", suffixes: ["go-mpulse.net", "akstat.io", "lux.speedcurve.com"], aliases: ["akamai", "mpulse"] },

  // --- Anti-Bot / Fraud / Telemetry ---
  { entity: "HUMAN Security (PerimeterX)", parentOrg: "HUMAN Security", category: "anti-bot", region: "US", suffixes: ["perimeterx.net", "px-cdn.net", "px-cloud.net", "px-client.net", "pxchk.net"], aliases: ["human security", "perimeterx"] },
  { entity: "DataDome", parentOrg: "DataDome", category: "anti-bot", region: "EU", suffixes: ["datadome.co", "captcha-delivery.com"], aliases: ["datadome"] },
  { entity: "Cloudflare Turnstile / Bot Mgmt", parentOrg: "Cloudflare", category: "anti-bot", region: "US", suffixes: ["challenges.cloudflare.com"], aliases: ["cloudflare"] },
  { entity: "Akamai Bot Manager", parentOrg: "Akamai", category: "anti-bot", region: "US", suffixes: ["akam.net", "akamaized.net"], aliases: ["akamai"] },
  { entity: "Arkose Labs", parentOrg: "Arkose Labs", category: "anti-bot", region: "US", suffixes: ["arkoselabs.com", "funcaptcha.com"], aliases: ["arkose"] },
  { entity: "hCaptcha", parentOrg: "Intuition Machines", category: "anti-bot", region: "US", suffixes: ["hcaptcha.com"], aliases: ["hcaptcha"] },
  { entity: "FingerprintJS", parentOrg: "Fingerprint", category: "anti-bot", region: "US", suffixes: ["fpjs.io", "fpnpmcdn.net", "fpcdn.io"], aliases: ["fingerprintjs", "fingerprint"] },
  { entity: "Sift", parentOrg: "Sift", category: "anti-bot", region: "US", suffixes: ["siftscience.com", "sift.com"], aliases: ["sift"] },
  { entity: "Forter", parentOrg: "Forter", category: "anti-bot", region: "US", suffixes: ["forter.com"], aliases: ["forter"] },
  { entity: "Riskified", parentOrg: "Riskified", category: "anti-bot", region: "US", suffixes: ["riskified.com"], aliases: ["riskified"] },
  { entity: "ThreatMetrix", parentOrg: "RELX (LexisNexis)", category: "anti-bot", region: "UK", suffixes: ["online-metrix.net"], aliases: ["threatmetrix", "lexisnexis"] },
  { entity: "Stripe Fraud / Radar", parentOrg: "Stripe", category: "anti-bot", region: "US", suffixes: ["m.stripe.network", "js.stripe.com", "r.stripe.com"], aliases: ["stripe"] },

  // --- Common CDNs / Infrastructure ---
  { entity: "Cloudflare CDN", parentOrg: "Cloudflare", category: "cdn-infra", region: "US", suffixes: ["cdnjs.cloudflare.com", "cloudflare.com"], aliases: ["cloudflare"] },
  { entity: "Fastly", parentOrg: "Fastly", category: "cdn-infra", region: "US", suffixes: ["fastly.net", "fastlylb.net"], aliases: ["fastly"] },
  { entity: "jsDelivr", parentOrg: "Prospect One", category: "cdn-infra", region: "EU", suffixes: ["cdn.jsdelivr.net"], aliases: ["jsdelivr"] },
  { entity: "unpkg", parentOrg: "unpkg", category: "cdn-infra", region: "US", suffixes: ["unpkg.com"], aliases: ["unpkg"] }
];

type IndexedEntry = {
  matchedDomain: string;
  entity: string;
  parentOrg: string;
  category: ServiceCategoryV3;
  region: EntityRegionV3;
  aliases: readonly string[];
};

const domainIndex: Map<string, IndexedEntry> = new Map();
const entityAliasIndex: Map<string, readonly string[]> = new Map();

for (const entry of GLOBAL_ENTITY_CATALOG_V3) {
  const aliases = entry.aliases ?? [entry.entity.toLowerCase()];
  entityAliasIndex.set(entry.entity, aliases);
  for (const suffix of entry.suffixes) {
    const normalized = normalizeHost(suffix);
    if (!normalized) continue;
    domainIndex.set(normalized, {
      matchedDomain: normalized,
      entity: entry.entity,
      parentOrg: entry.parentOrg,
      category: entry.category,
      region: entry.region,
      aliases
    });
  }
}

export const GLOBAL_ENTITY_CATALOG_V3_STATS = {
  entities: GLOBAL_ENTITY_CATALOG_V3.length,
  parentOrgs: new Set(GLOBAL_ENTITY_CATALOG_V3.map((e) => e.parentOrg)).size,
  domains: domainIndex.size,
  digest: sha256Hex(
    JSON.stringify(
      [...domainIndex.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([domain, v]) => [domain, v.entity, v.parentOrg, v.category, v.region])
    )
  )
};

/** Look up an entity by domain suffix (longest matching suffix wins). */
export function lookupEntityV3(hostname: string): EntityAttributionV3 | null {
  let candidate = normalizeHost(hostname);
  while (candidate) {
    const hit = domainIndex.get(candidate);
    if (hit) {
      return {
        entity: hit.entity,
        parentOrg: hit.parentOrg,
        category: hit.category,
        region: hit.region,
        confidence: "curated",
        matchedDomain: hit.matchedDomain
      };
    }
    const dot = candidate.indexOf(".");
    if (dot < 0) return null;
    candidate = candidate.slice(dot + 1);
  }
  return null;
}

/** Return policy-disclosure search aliases for a known entity name. */
export function entityPolicyAliasesV3(entityName: string): readonly string[] {
  return entityAliasIndex.get(entityName) ?? [entityName.toLowerCase()];
}

/**
 * Resolve attribution for a request domain:
 * 1. Curated global catalog match
 * 2. Fallback to Shields filter-list match (when matched by Brave Shields)
 */
export function attributeDomainV3(
  hostname: string,
  options?: { shieldsMatched?: boolean; registrableDomain?: string }
): EntityAttributionV3 | null {
  const curated = lookupEntityV3(hostname);
  if (curated) return curated;
  if (options?.shieldsMatched) {
    const domain = normalizeHost(options.registrableDomain ?? hostname) ?? hostname.toLowerCase();
    return {
      entity: domain,
      parentOrg: domain,
      category: "other",
      region: "GLOBAL",
      confidence: "shields-list",
      matchedDomain: domain
    };
  }
  return null;
}

/** Whether a service category counts as a tracking/behavioral/ad/identity service. */
export function isTrackingCategoryV3(category: ServiceCategoryV3): boolean {
  return (
    category === "advertising" ||
    category === "analytics" ||
    category === "session-replay" ||
    category === "cdp" ||
    category === "identity-broker" ||
    category === "marketing-automation" ||
    category === "server-side-tagging" ||
    category === "tag-manager"
  );
}

/** Detect common server-side tagging URL / header / cookie signatures on a first-party host. */
export function detectServerSideTaggingSignature(input: {
  url: string;
  firstParty: boolean;
  responseHeaders?: Record<string, string>;
}): { provider: string; product: string } | null {
  if (!input.firstParty) return null;
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  const path = parsed.pathname.toLowerCase();
  const params = parsed.searchParams;
  if (path.startsWith("/cdn-cgi/zaraz/")) {
    return { provider: "Cloudflare Zaraz", product: "Cloudflare Zaraz Server-Side Tagging" };
  }
  if (path.endsWith("/g/collect") && params.get("v") === "2") {
    return { provider: "Google sGTM", product: "Server-Side Google Tag Manager (GA4)" };
  }
  if (path === "/tr" || path.startsWith("/tr/")) {
    if (params.has("ev") && params.has("id")) {
      return { provider: "Meta CAPI Gateway", product: "First-Party Meta Pixel / CAPI Gateway" };
    }
  }
  if (/\/ee\/(?:v\d+|or\d+\/v\d+)\/interact\b/.test(path)) {
    return { provider: "Adobe Edge", product: "First-Party Adobe Experience Platform Edge" };
  }
  if (path.includes("/b/ss/")) {
    return { provider: "Adobe Analytics", product: "First-Party Adobe Analytics Beacon" };
  }
  const headers = input.responseHeaders ?? {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    const lv = v.toLowerCase();
    if (lk === "x-stape-region" || lv.includes("stape")) {
      return { provider: "Stape", product: "Stape Server-Side Tagging" };
    }
    if (lk === "x-gtm-server-preview" || lk === "x-sgtm") {
      return { provider: "Google sGTM", product: "Server-Side Google Tag Manager" };
    }
  }
  return null;
}

function normalizeHost(host: string): string | null {
  const cleaned = host.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  return cleaned.length > 0 && cleaned.includes(".") ? cleaned : null;
}
