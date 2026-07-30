/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

function init() {
    $ui.register(async (ctx) => {
        const LANGUAGES = [
            { label: "Arabic", value: "arabic" },
            { label: "Catalan", value: "catalan" },
            { label: "Chinese", value: "chinese" },
            { label: "Danish", value: "danish" },
            { label: "Dutch", value: "dutch" },
            { label: "English", value: "english" },
            { label: "Finnish", value: "finnish" },
            { label: "French", value: "french" },
            { label: "German", value: "german" },
            { label: "Hebrew", value: "hebrew" },
            { label: "Hindi", value: "hindi" },
            { label: "Hungarian", value: "hungarian" },
            { label: "Indonesian", value: "indonesian" },
            { label: "Italian", value: "italian" },
            { label: "Japanese", value: "japanese" },
            { label: "Korean", value: "korean" },
            { label: "Lithuanian", value: "lithuanian" },
            { label: "Norwegian", value: "norwegian" },
            { label: "Polish", value: "polish" },
            { label: "Portuguese", value: "portuguese" },
            { label: "Russian", value: "russian" },
            { label: "Spanish", value: "spanish" },
            { label: "Swedish", value: "swedish" },
            { label: "Tagalog", value: "tagalog" },
            { label: "Thai", value: "thai" },
            { label: "Turkish", value: "turkish" },
            { label: "Vietnamese", value: "vietnamese" },
        ];

        const CONFIDENCE_LEVELS = [
            { label: "Low", value: "low" },
            { label: "Normal", value: "normal" },
            { label: "High", value: "high" },
            { label: "Very High", value: "very-high" },
        ];

        const POSITION_OPTIONS = [
            { label: "Beside (Left)", value: "beside" },
            { label: "Below", value: "below" },
        ];

        const COLOR_OPTIONS = [
            { label: "Default (Indigo)", value: "default" },
            { label: "Green", value: "green" },
            { label: "Red", value: "red" },
            { label: "Blue", value: "blue" },
            { label: "Orange", value: "orange" },
        ];

        const DEBUG_OPTIONS = [
            { label: "Off", value: "false" },
            { label: "On", value: "true" },
        ];

        const COUNTER_OPTIONS = [
            { label: "On (English only)", value: "true" },
            { label: "Off", value: "false" },
        ];

        const DAY_MS = 24 * 60 * 60 * 1000;
        const TWO_MONTHS_MS = 60 * DAY_MS;
        const ONGOING_TTL = DAY_MS;
        const RECENT_FINISHED_TTL = 3 * DAY_MS;
        const FETCH_TIMEOUT_MS = 6000;

        const getStorageItem = (key: string, def: any) => {
            try {
                const v = $storage.get(key);
                return (v !== undefined && v !== null) ? v : def;
            } catch (e) { return def; }
        };
        const setStorageItem = (key: string, val: any) => {
            try { $storage.set(key, val); } catch (e) {}
        };

        const injectStyles = async () => {
            try {
                const styleId = "seanime-dub-badge-styles";
                const existing = await ctx.dom.queryOne(`#${styleId}`);
                if (!existing) {
                    const styleEl = await ctx.dom.createElement("style");
                    await styleEl.setAttribute("id", styleId);
                    await styleEl.setText(`
                        .group\\/media-entry-card:hover .seanime-base-dub-badge {
                            opacity: 0 !important;
                            visibility: hidden !important;
                            pointer-events: none !important;
                        }
                    `);
                    const body = await ctx.dom.queryOne("body");
                    if (body) await body.append(styleEl);
                }
            } catch (e) {
                console.error("Failed to inject dub badge styles", e);
            }
        };
        injectStyles();

        const savedLang = getStorageItem("dub-badge-lang", "english");
        const defaultConf = savedLang === "english" ? "normal" : "low";
        const savedConf = getStorageItem("dub-badge-conf", defaultConf);
        const savedPos = getStorageItem("dub-badge-pos", "beside");
        const savedColor = getStorageItem("dub-badge-color", "default");
        const savedDebug = getStorageItem("dub-badge-debug", "false");
        const savedCounter = getStorageItem("dub-badge-counter", "true");
        const apiToken: string = (getStorageItem("dub-badge-as-token", "") || "").toString().trim();

        const langRef = ctx.fieldRef(savedLang);
        const confRef = ctx.fieldRef(savedConf);
        const posRef = ctx.fieldRef(savedPos);
        const colRef = ctx.fieldRef(savedColor);
        const debugRef = ctx.fieldRef(savedDebug);
        const counterRef = ctx.fieldRef(savedCounter);
        const statusState = ctx.state("Ready");

        let currentLoadedLang = "";
        let currentLoadedConf = "";

        const selectorBase = "[data-media-entry-card-body='true'], [data-media-entry-card-hover-popup-banner-container='true']";
        const dubbedAnilistIds = new Set<string>();
        const anilistToMalMap: Record<string, number> = {};
        let episodeCache: Record<string, any> = getStorageItem("dub-badge-ep-cache-v1", {}) || {};
        const pendingFetches = new Set<string>();
        let isDataReady = false;
        let isScanning = false;
        let pendingPersist = false;
        let persistTimer: any = null;

        const persistCache = () => {
            if (pendingPersist) return;
            pendingPersist = true;
            if (persistTimer) clearTimeout(persistTimer);
            persistTimer = setTimeout(() => {
                try { setStorageItem("dub-badge-ep-cache-v1", episodeCache); } catch (e) {}
                pendingPersist = false;
            }, 1000);
        };

        const shouldRefetch = (entry: any) => {
            if (!entry) return true;
            if (entry.fullyDubbed) return false;
            const age = Date.now() - (entry.lastCheck || 0);
            const status = (entry.status || "").toString().toLowerCase();
            const isOngoing = status.indexOf("ongoing") >= 0 || status.indexOf("releasing") >= 0 || status.indexOf("airing") >= 0 || status.indexOf("current") >= 0;
            const isFinished = status.indexOf("finished") >= 0 || status.indexOf("ended") >= 0 || status.indexOf("complete") >= 0;
            if (isOngoing) return age > ONGOING_TTL;
            if (isFinished) {
                if (entry.finishedAt && (Date.now() - entry.finishedAt > TWO_MONTHS_MS)) return false;
                return age > RECENT_FINISHED_TTL;
            }
            return age > ONGOING_TTL;
        };

        const parseDateVal = (v: any): number | null => {
            if (!v) return null;
            if (typeof v === "number") return v > 1e12 ? v : v * 1000;
            if (typeof v === "string") {
                const t = Date.parse(v);
                if (!isNaN(t)) return t;
            }
            if (typeof v === "object") {
                if (v.endDate) return parseDateVal(v.endDate);
                if (v.date) return parseDateVal(v.date);
                if (typeof v.year === "number") {
                    const m = typeof v.month === "number" ? v.month : 12;
                    const d = typeof v.day === "number" ? v.day : 28;
                    return Date.UTC(v.year, Math.max(0, m - 1), d);
                }
            }
            return null;
        };

        const parseFinishedAt = (anime: any): number | null => {
            const candidates = [
                anime.dubPremier,
                anime.subPremier,
                anime.endDate,
                anime.premier?.endDate,
                anime.aired?.to,
                anime.airedTo,
                anime.finishedAiringDate,
                anime.tracks?.dub?.endDate,
                anime.tracks?.sub?.endDate,
            ];
            for (const c of candidates) {
                const t = parseDateVal(c);
                if (t) return t;
            }
            return null;
        };

        const extractEpisodeInfo = (anime: any) => {
            const rawStatus = (anime.status || anime.airType || anime.airingStatus || "").toString();
            let totalEps: number | null = null;
            if (typeof anime.episodes === "number" && anime.episodes > 0) totalEps = anime.episodes;
            else if (typeof anime.episodeOverride === "number" && anime.episodeOverride > 0) totalEps = anime.episodeOverride;
            else if (typeof anime.totalEpisodes === "number" && anime.totalEpisodes > 0) totalEps = anime.totalEpisodes;
            else if (typeof anime.episodeCount === "number" && anime.episodeCount > 0) totalEps = anime.episodeCount;

            let dubEps: number | null = null;
            let subEps: number | null = null;

            if (typeof anime.dubEpisodes === "number") dubEps = anime.dubEpisodes;
            if (typeof anime.subEpisodes === "number") subEps = anime.subEpisodes;

            if (anime.tracks && typeof anime.tracks === "object") {
                const dt = anime.tracks.dub;
                if (dt && typeof dt === "object" && dubEps === null) {
                    if (typeof dt.latestEpisode === "number") dubEps = dt.latestEpisode;
                    else if (typeof dt.subtractedEpisode === "number") dubEps = dt.subtractedEpisode;
                    else if (typeof dt.episode === "number") dubEps = dt.episode;
                    else if (typeof dt.episodes === "number") dubEps = dt.episodes;
                }
                const st = anime.tracks.sub;
                if (st && typeof st === "object" && subEps === null) {
                    if (typeof st.latestEpisode === "number") subEps = st.latestEpisode;
                    else if (typeof st.subtractedEpisode === "number") subEps = st.subtractedEpisode;
                    else if (typeof st.episode === "number") subEps = st.episode;
                    else if (typeof st.episodes === "number") subEps = st.episodes;
                }
            }

            if (dubEps === null && anime.leadingTrack === "dub") {
                if (typeof anime.latestEpisode === "number") dubEps = anime.latestEpisode;
                else if (typeof anime.subtractedEpisode === "number") dubEps = anime.subtractedEpisode;
            }

            const finishedAt = parseFinishedAt(anime);
            const fullyDubbed = (totalEps !== null && dubEps !== null && totalEps > 0 && dubEps >= totalEps);

            return { status: rawStatus, totalEps, subEps, dubEps, finishedAt, fullyDubbed };
        };

        const fetchAnimeScheduleByMal = async (malId: number) => {
            try {
                const headers: Record<string, string> = { "Accept": "application/json" };
                if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;
                const url = `https://animeschedule.net/api/v3/anime?mal-ids=${malId}`;
                const res = await ctx.fetch(url, { headers });
                if (!res || res.status !== 200) return null;
                const data = await res.json();
                let anime: any = null;
                if (Array.isArray(data)) anime = data[0];
                else if (data && Array.isArray(data.anime)) anime = data.anime[0];
                else if (data && Array.isArray(data.animes)) anime = data.animes[0];
                else if (data && Array.isArray(data.results)) anime = data.results[0];
                else if (data && data.route) anime = data;
                else if (data && (data.title || data.name)) anime = data;
                if (!anime) return null;
                return extractEpisodeInfo(anime);
            } catch (e) {
                return null;
            }
        };

        const getOrFetchEpisodeData = async (anilistId: string): Promise<any> => {
            const cached = episodeCache[anilistId];
            if (cached && !shouldRefetch(cached)) return cached;
            if (pendingFetches.has(anilistId)) return cached || null;
            const malId = anilistToMalMap[anilistId];
            if (!malId) return cached || null;
            pendingFetches.add(anilistId);
            try {
                const data = await fetchAnimeScheduleByMal(malId);
                if (!data) {
                    if (cached) {
                        cached.lastCheck = Date.now();
                        persistCache();
                        return cached;
                    }
                    const stub = { status: "", totalEps: null, subEps: null, dubEps: null, finishedAt: null, fullyDubbed: false, malId, lastCheck: Date.now(), stub: true };
                    episodeCache[anilistId] = stub;
                    persistCache();
                    return stub;
                }
                const entry: any = { ...data, malId, lastCheck: Date.now() };
                if (entry.finishedAt && (Date.now() - entry.finishedAt > TWO_MONTHS_MS)) {
                    entry.fullyDubbed = true;
                }
                episodeCache[anilistId] = entry;
                persistCache();
                return entry;
            } finally {
                pendingFetches.delete(anilistId);
            }
        };

        const tray = ctx.newTray({
            tooltipText: "Dub Badge Settings",
            iconUrl: "https://raw.githubusercontent.com/Bas1874/MyDubList-Seanime/refs/heads/main/src/icons/logo.png",
            withContent: true
        });

        tray.render(() => {
            return tray.stack([
                tray.text("Dub Badge Settings", { style: { fontWeight: "bold", fontSize: "1rem" } }),
                tray.select("Language", { options: LANGUAGES, fieldRef: langRef }),
                tray.select("Confidence", { options: CONFIDENCE_LEVELS, fieldRef: confRef }),
                tray.select("Badge Position", { options: POSITION_OPTIONS, fieldRef: posRef }),
                tray.select("Badge Color", { options: COLOR_OPTIONS, fieldRef: colRef }),
                tray.select("Show Episode Counter", { options: COUNTER_OPTIONS, fieldRef: counterRef }),
                tray.select("Debug Mode (Show ID)", { options: DEBUG_OPTIONS, fieldRef: debugRef }),
                tray.text(`Status: ${statusState.get()}`, { style: { fontSize: "0.8rem", color: "#888", marginBottom: "5px" } }),
                tray.button("Save & Reload", { onClick: "reload-data", intent: "primary", style: { width: "100%" } }),
                tray.button("Clear Episode Cache", { onClick: "clear-ep-cache", intent: "warning-subtle", style: { width: "100%" } })
            ], { gap: 4, style: { width: "260px", padding: "10px" } });
        });

        ctx.screen.onNavigate(async () => {
            try {
                const tooltips = await ctx.dom.query("#seanime-dub-tooltip-temp");
                for (const tt of tooltips) {
                    await tt.remove();
                }
            } catch (e) {}
        });

        ctx.registerEventHandler("reload-data", async () => {
            const newLang = langRef.current;
            const newConf = confRef.current;

            setStorageItem("dub-badge-lang", newLang);
            setStorageItem("dub-badge-conf", newConf);
            setStorageItem("dub-badge-pos", posRef.current);
            setStorageItem("dub-badge-color", colRef.current);
            setStorageItem("dub-badge-debug", debugRef.current);
            setStorageItem("dub-badge-counter", counterRef.current);

            await resetDomBadges();

            if (newLang !== currentLoadedLang || newConf !== currentLoadedConf || !isDataReady) {
                await loadDubData();
            } else {
                triggerScan();
            }
        });

        ctx.registerEventHandler("clear-ep-cache", async () => {
            episodeCache = {};
            setStorageItem("dub-badge-ep-cache-v1", {});
            await resetDomBadges();
            triggerScan();
        });

        const triggerScan = async () => {
            if (!isDataReady || isScanning) return;
            isScanning = true;
            const selectorRetry = `${selectorBase}:not([data-dub-badge-checked='true'])`;
            try {
                const retryElements = await ctx.dom.query(selectorRetry, { identifyChildren: true, withInnerHTML: true });
                if (retryElements && retryElements.length > 0) {
                    await processElements(retryElements);
                }
            } catch (e) { }
            finally {
                isScanning = false;
            }
        };

        const loadDubData = async () => {
            try {
                isDataReady = false;
                dubbedAnilistIds.clear();
                for (const k of Object.keys(anilistToMalMap)) delete anilistToMalMap[k];
                statusState.set("Loading...");

                const lang = langRef.current;
                const conf = confRef.current;
                const url = `https://raw.githubusercontent.com/Joelis57/MyDubList/refs/heads/main/dubs/confidence/${conf}/dubbed_${lang}.json`;
                const dubsRes = await ctx.fetch(url);

                if (dubsRes.status !== 200) throw new Error(`Fetch failed: ${dubsRes.status}`);

                const dubsData = await dubsRes.json();
                const dubbedMalIds = new Set(dubsData.dubbed);

                const mapRes = await ctx.fetch("https://raw.githubusercontent.com/Joelis57/MyDubList/refs/heads/main/dubs/mappings/mappings_anilist.jsonl");
                const mapText = await mapRes.text();

                const lines = mapText.split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const mapping = JSON.parse(line);
                        if (dubbedMalIds.has(mapping.mal_id)) {
                            const aid = String(mapping.anilist_id);
                            dubbedAnilistIds.add(aid);
                            anilistToMalMap[aid] = mapping.mal_id;
                        }
                    } catch (e) { }
                }

                currentLoadedLang = lang;
                currentLoadedConf = conf;
                isDataReady = true;
                statusState.set(`Active: ${lang} (${dubbedAnilistIds.size})`);

                triggerScan();
            } catch (e) {
                console.error("[Dub Badge] Error:", e);
                statusState.set("Error");
                isDataReady = false;
            }
        };

        const resetDomBadges = async () => {
            const processedElements = await ctx.dom.query("[data-dub-badge-checked='true']", { identifyChildren: true });
            for (const el of processedElements) {
                await el.removeAttribute("data-dub-badge-checked");
                await el.removeAttribute("data-dub-badge-added");
                await el.removeAttribute("data-badge-retries");
            }
            const marked = await ctx.dom.query("[data-has-dub-badge='true']");
            for (const el of marked) {
                await el.removeAttribute("data-has-dub-badge");
            }
            const oldBadges = await ctx.dom.query(".seanime-dub-badge-wrapper");
            for (const badge of oldBadges) {
                await badge.remove();
            }
        };

        loadDubData();

        const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> => {
            return new Promise((resolve) => {
                let done = false;
                const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
                p.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
                 .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
            });
        };

        const processSingleCard = async (el: any) => {
            try {
                if (await el.getAttribute("data-dub-badge-checked") === "true") return;
                if (!isDataReady) return;

                let mediaId = "N/A";
                let hasExistingBadge = false;
                let isPopup = false;

                if (await el.getAttribute("data-media-entry-card-hover-popup-banner-container") === "true") {
                    isPopup = true;
                }

                const directDataId = await el.getAttribute("data-media-id");
                if (directDataId) {
                    mediaId = directDataId;
                } else {
                    const directHref = await el.getAttribute("href");
                    if (directHref) {
                        const match = directHref.match(/[?&]id=(\d+)/);
                        if (match && match[1]) mediaId = match[1];
                    }
                }

                if (mediaId === "N/A" && !isPopup) {
                    let tempEl = el;
                    for (let i = 0; i < 4; i++) {
                        try {
                            const parent = await tempEl.getParent();
                            if (!parent) break;
                            const pDataId = await parent.getAttribute("data-media-id");
                            if (pDataId) { mediaId = pDataId; break; }
                            const pHref = await parent.getAttribute("href");
                            if (pHref) {
                                const match = pHref.match(/[?&]id=(\d+)/);
                                if (match && match[1]) { mediaId = match[1]; break; }
                            }
                            tempEl = parent;
                        } catch (e) { break; }
                    }
                }

                if (mediaId === "N/A" && el.innerHTML) {
                    if (el.innerHTML.includes("data-media-entry-card-body-releasing-badge-container") ||
                        el.innerHTML.includes("data-media-entry-card-body-next-airing-badge-container") ||
                        el.innerHTML.includes("data-media-entry-card-hover-popup-banner-releasing-badge-container")) {
                        hasExistingBadge = true;
                    }

                    const $ = LoadDoc(el.innerHTML);
                    const imgSrc = $("img").attr("src");
                    if (imgSrc) {
                        const match = imgSrc.match(/\/bx(\d+)/) ||
                            imgSrc.match(/\/banner\/(\d+)/) ||
                            imgSrc.match(/\/cover\/.*\/(\d+)/) ||
                            imgSrc.match(/\/media\/(\d+)/);
                        if (match && match[1]) mediaId = match[1];
                    }

                    if (mediaId === "N/A") {
                        const childLink = $("a[href*='id=']").attr("href");
                        if (childLink) {
                            const match = childLink.match(/[?&]id=(\d+)/);
                            if (match && match[1]) mediaId = match[1];
                        }
                    }
                } else if (mediaId !== "N/A" && el.innerHTML) {
                    if (el.innerHTML.includes("data-media-entry-card-body-releasing-badge-container") ||
                        el.innerHTML.includes("data-media-entry-card-body-next-airing-badge-container") ||
                        el.innerHTML.includes("data-media-entry-card-hover-popup-banner-releasing-badge-container")) {
                        hasExistingBadge = true;
                    }
                }

                if (mediaId === "N/A") {
                    const currentRetries = parseInt((await el.getAttribute("data-badge-retries")) || "0");
                    if (currentRetries > 10) {
                        await el.setAttribute("data-dub-badge-checked", "true");
                    } else {
                        await el.setAttribute("data-badge-retries", (currentRetries + 1).toString());
                    }
                    return;
                }

                if (!dubbedAnilistIds.has(mediaId)) {
                    await el.setAttribute("data-dub-badge-checked", "true");
                    return;
                }

                let episodeInfo: any = null;
                const wantCounter = (counterRef.current || "true") === "true" && currentLoadedLang === "english";

                if (wantCounter) {
                    const cached = episodeCache[mediaId];
                    if (cached && !shouldRefetch(cached)) {
                        episodeInfo = cached;
                    } else {
                        const fetched = await withTimeout(getOrFetchEpisodeData(mediaId), FETCH_TIMEOUT_MS);
                        episodeInfo = fetched || cached || null;
                    }
                }

                let showCounter = false;
                let counterText = "";
                let tooltipDetail = "Dubbed";
                if (episodeInfo) {
                    if (episodeInfo.fullyDubbed) {
                        tooltipDetail = "Fully Dubbed";
                    } else if (
                        typeof episodeInfo.dubEps === "number" &&
                        typeof episodeInfo.totalEps === "number" &&
                        episodeInfo.totalEps > 0 &&
                        episodeInfo.dubEps >= 0 &&
                        episodeInfo.dubEps < episodeInfo.totalEps
                    ) {
                        showCounter = true;
                        counterText = `${episodeInfo.dubEps}/${episodeInfo.totalEps}`;
                        tooltipDetail = `Dubbed: ${counterText} episodes`;
                    } else if (
                        typeof episodeInfo.dubEps === "number" &&
                        episodeInfo.dubEps > 0 &&
                        (episodeInfo.totalEps === null || episodeInfo.totalEps === 0)
                    ) {
                        showCounter = true;
                        counterText = `${episodeInfo.dubEps}`;
                        tooltipDetail = `Dubbed: ${counterText} episodes so far`;
                    }
                }

                const colorSetting = colRef.current || "default";
                let colorClass = "bg-indigo-500 hover:bg-indigo-600";
                if (colorSetting === "red") colorClass = "bg-red-600 hover:bg-red-700";
                else if (colorSetting === "green") colorClass = "bg-green-600 hover:bg-green-700";
                else if (colorSetting === "blue") colorClass = "bg-blue-600 hover:bg-blue-700";
                else if (colorSetting === "orange") colorClass = "bg-orange-600 hover:bg-orange-700";

                const positionSetting = posRef.current || "beside";
                let topValue = "8px";
                let rightValue = "4px";

                if (hasExistingBadge) {
                    if (positionSetting === "below") {
                        topValue = "40px";
                        rightValue = "4px";
                    } else {
                        topValue = "8px";
                        rightValue = showCounter ? "60px" : "52px";
                    }
                }

                const debugMode = debugRef.current || "false";
                const rawTooltip = debugMode === "true" ? `${mediaId} - ${tooltipDetail}` : tooltipDetail;
                const safeTooltipText = rawTooltip.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

                const wrapper = await ctx.dom.createElement("div");

                const wrapperClasses = [
                    "seanime-dub-badge-wrapper",
                    "absolute",
                    isPopup ? "z-[60]" : "z-10 seanime-base-dub-badge",
                    "flex",
                    "items-center",
                    "group/badge",
                    "pointer-events-auto",
                    "transition-all",
                    "duration-300",
                    "ease-in-out",
                    isPopup ? "group-hover/media-entry-card:scale-100" : "group-hover/media-entry-card:-translate-y-1",
                    "group-hover/episode-card:scale-110",
                    "group-hover/episode-card:-translate-y-1"
                ].filter(Boolean).join(" ");

                await wrapper.setProperty("className", wrapperClasses);
                await wrapper.setProperty("style", `top: ${topValue}; right: ${rightValue};`);
                await wrapper.setAttribute("data-dub-anilist-id", mediaId);

                const jsHoverLogic = `
                    (function(el) {
                        if (!window._seanime_dub_tt) window._seanime_dub_tt = { timer: null };
                        clearTimeout(window._seanime_dub_tt.timer);
                        var id = 'seanime-dub-tooltip-temp';
                        var ex = document.getElementById(id);
                        if(ex) ex.remove();
                        var tt = document.createElement('div');
                        tt.id = id;
                        tt.innerText = '${safeTooltipText}';
                        tt.style.cssText = 'position: absolute; z-index: 999999; background-color: #18181b; color: #FFFFFF; padding: 0.375rem 0.75rem; border-radius: 0.75rem; font-size: 0.875rem; line-height: 1.25rem; border: 1px solid #27272a; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); overflow: hidden; white-space: nowrap; pointer-events: auto; user-select: text; opacity: 0; transform: translateX(-50%) scale(0.95) translateY(4px); transition: opacity 150ms ease-out, transform 150ms ease-out;';
                        tt.onmouseenter = function() { clearTimeout(window._seanime_dub_tt.timer); };
                        tt.onmouseleave = function() {
                            window._seanime_dub_tt.timer = setTimeout(function() {
                                var t = document.getElementById(id);
                                if(t) t.remove();
                            }, 100);
                        };
                        var rect = el.getBoundingClientRect();
                        var top = rect.top + window.scrollY - 34;
                        var left = rect.left + window.scrollX + (rect.width / 2);
                        tt.style.top = top + 'px';
                        tt.style.left = left + 'px';
                        document.body.appendChild(tt);
                        var ttRect = tt.getBoundingClientRect();
                        var winWidth = window.innerWidth;
                        var pad = 10;
                        if (ttRect.left < pad) {
                            tt.style.left = (left + (pad - ttRect.left)) + 'px';
                        } else if (ttRect.right > winWidth - pad) {
                            tt.style.left = (left - (ttRect.right - (winWidth - pad))) + 'px';
                        }
                        setTimeout(function() {
                            tt.style.opacity = '1';
                            tt.style.transform = 'translateX(-50%) scale(1) translateY(0)';
                        }, 10);
                    })(this)
                `.replace(/\s+/g, ' ');

                const jsLeaveLogic = `
                    (function() {
                        if (!window._seanime_dub_tt) return;
                        window._seanime_dub_tt.timer = setTimeout(function() {
                            var tt = document.getElementById('seanime-dub-tooltip-temp');
                            if(tt) tt.remove();
                        }, 150);
                    })()
                `.replace(/\s+/g, ' ');

                const iconSvg = `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" height="1.1em" width="1.1em" xmlns="http://www.w3.org/2000/svg"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"></path><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"></path></svg>`;
                const counterHtml = showCounter ? `<span class="text-xs font-bold leading-none">${counterText}</span>` : '';
                const paddingClass = showCounter ? "px-2" : "px-2.5";
                const gapClass = showCounter ? "gap-1" : "gap-2";

                await wrapper.setProperty("innerHTML", `
                    <div class="group relative">
                        <span
                            onmouseenter="${jsHoverLogic}"
                            onmouseleave="${jsLeaveLogic}"
                            class="UI-Badge__root inline-flex flex-none w-fit overflow-hidden justify-center items-center ${gapClass} text-white ${colorClass} h-7 ${paddingClass} text-md font-semibold tracking-wide rounded-full shadow-md cursor-pointer transition-colors group"
                        >
                            ${iconSvg}
                            ${counterHtml}
                        </span>
                    </div>
                `);

                if (isPopup) {
                    if (!(await el.getAttribute("data-has-dub-badge"))) {
                        await el.append(wrapper);
                        await el.setAttribute("data-has-dub-badge", "true");
                    }
                } else {
                    let targetContainer = el;
                    try {
                        const p = await el.getParent();
                        if (p && await p.getAttribute("href")) targetContainer = p;
                    } catch {}

                    await targetContainer.setStyle("position", "relative");

                    if (!(await targetContainer.getAttribute("data-has-dub-badge"))) {
                        await targetContainer.append(wrapper);
                        await targetContainer.setAttribute("data-has-dub-badge", "true");
                    }
                }

                await el.setAttribute("data-dub-badge-checked", "true");
            } catch (err) { }
        };

        const processElements = async (elements: any[]) => {
            await Promise.all(elements.map(el => processSingleCard(el)));
        };

        ctx.dom.observe(
            selectorBase,
            async (elements) => {
                await processElements(elements);
            },
            { identifyChildren: true, withInnerHTML: true }
        );

        ctx.setInterval(async () => {
            if (!isDataReady || isScanning) return;
            isScanning = true;
            const selectorRetry = `${selectorBase}:not([data-dub-badge-checked='true'])`;
            try {
                const retryElements = await ctx.dom.query(selectorRetry, { identifyChildren: true, withInnerHTML: true });
                if (retryElements && retryElements.length > 0) {
                    await processElements(retryElements);
                }
            } catch (e) { }
            finally {
                isScanning = false;
            }
        }, 2000);
    });
}
