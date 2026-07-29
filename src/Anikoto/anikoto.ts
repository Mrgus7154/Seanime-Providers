class Provider {
    private baseUrl = "https://anikototv.to"
    private loadSubtitles = "enabled"
    private mirrors = ["https://anikototv.to", "https://anikoto.cz", "https://anikoto.me", "https://anikoto.net", "https://anikototv.se"]
    private subEndpoint = "https://sub.ryuo.to"

    private readonly TTL = {
        page: 900000,
        server: 300000,
        serverNeg: 30000,
        token: 18000000,
        sourceProbed: 60000,
        lang: 86400000,
        health: 60000,
        meta: 86400000,
        latency: 604800000,
    }

    private readonly SUB_GROUPS = ["sub", "hsub", "h-sub", "softsub", "soft-sub"]
    private readonly DUB_GROUPS = ["dub", "adub", "a-dub", "altdub", "alt-dub"]
    private readonly SERVER_BLOCK_RX = /download|torrent/i

    private inflight: { [key: string]: Promise<any> } = {}

    private dedupe<T>(key: string, factory: () => Promise<T>): Promise<T> {
        const hit = this.inflight[key]
        if (hit) return hit as Promise<T>
        const p = factory().then(
            (v) => { delete this.inflight[key]; return v },
            (e) => { delete this.inflight[key]; throw e }
        )
        this.inflight[key] = p
        return p
    }

    private trimSlash(u: string): string {
        return u.replace(/\/+$/, "")
    }

    private hostOf(u: string): string {
        const m = (u || "").match(/^https?:\/\/([^/]+)/i)
        return m ? m[1].toLowerCase() : ""
    }

    private latencyMap(): { [h: string]: number } {
        return this.readCache<{ [h: string]: number }>("anikoto:latency", this.TTL.latency) || {}
    }

    private recordLatency(base: string, ms: number): void {
        if (!base || ms <= 0 || ms > 60000) return
        const host = this.hostOf(base)
        if (!host) return
        const map = this.latencyMap()
        const prev = map[host]
        map[host] = prev ? Math.round(prev * 0.7 + ms * 0.3) : ms
        this.writeCache("anikoto:latency", map)
    }

    private baseChain(): string[] {
        const seen: { [key: string]: boolean } = {}
        const chain: string[] = []
        const push = (u: string): void => {
            const n = this.trimSlash(u)
            if (!n || seen[n]) return
            seen[n] = true
            chain.push(n)
        }
        push(this.baseUrl)
        const cached = $store.get<string>("anikoto:base")
        if (cached) push(cached)
        const map = this.latencyMap()
        const ranked = this.mirrors.slice().sort((a, b) => {
            const la = map[this.hostOf(a)]
            const lb = map[this.hostOf(b)]
            if (la === undefined && lb === undefined) return 0
            if (la === undefined) return 1
            if (lb === undefined) return -1
            return la - lb
        })
        for (const m of ranked) push(m)
        return chain
    }

    private currentBase(): string {
        const configured = this.trimSlash(this.baseUrl)
        const cached = $store.get<string>("anikoto:base")
        if (cached && (cached === configured || this.mirrors.indexOf(cached) !== -1)) return cached
        const chain = this.baseChain()
        return chain[0] || configured
    }

    private rememberBase(base: string): void {
        this.baseUrl = base
        try { $store.set("anikoto:base", base) } catch (_e) {}
    }

    private invalidateBase(): void {
        const dead = this.trimSlash(this.baseUrl)
        try { $store.set("anikoto:base", "") } catch (_e) {}
        this.purgePrefix(`anikoto:eps:${dead}`)
        this.purgePrefix(`anikoto:slist:`)
        this.purgePrefix(`anikoto:src:`)
    }

    private purgePrefix(prefix: string): void {
        try {
            const anyStore = $store as any
            if (anyStore && typeof anyStore.keys === "function") {
                const ks: string[] = anyStore.keys() || []
                for (const k of ks) if (k.indexOf(prefix) === 0) $store.set(k, undefined as any)
            }
        } catch (_e) {}
    }

    private pageHeaders(base?: string): { [key: string]: string } {
        return { Referer: `${base || this.baseUrl}/` }
    }

    private ajaxHeaders(base?: string): { [key: string]: string } {
        return { Referer: `${base || this.baseUrl}/`, "X-Requested-With": "XMLHttpRequest" }
    }

    private async fetchRetry(url: string, opts?: FetchOptions, tries = 2): Promise<FetchResponse> {
        let lastErr: any
        for (let i = 0; i < tries; i++) {
            try {
                const res = await fetch(url, opts)
                const shouldRetry = res.status === 408 || res.status === 429 || res.status >= 500
                if (!shouldRetry || i === tries - 1) return res
            } catch (e) {
                lastErr = e
                if (i === tries - 1) throw e
            }
        }
        throw lastErr || `anikoto: fetch failed (${url})`
    }

    private firstAttr($: DocSelectionFunction, selectors: string[], attr: string): string {
        for (const sel of selectors) {
            const v = $(sel).first().attr(attr)
            if (v) return v
        }
        return ""
    }

    getSettings(): Settings {
        return {
            episodeServers: [
                "Auto",
                "VidPlay-1",
                "HD-1",
                "Vidstream-2",
                "VidCloud-1",
                "Kiwi-Stream",
                "HS: VidPlay-1",
                "HS: HD-1",
                "HS: Vidstream-2",
                "HS: VidCloud-1",
                "HS: Kiwi-Stream",
            ],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const audio = opts.dub ? "dub" : "sub"
        const plan = this.buildSearchPlan(opts)
        if (plan.queries.length === 0) return []

        const primary = this.currentBase()
        const primaryRes = await this.searchOn(primary, plan, opts, audio)
        if (primaryRes.reached) {
            this.rememberBase(primary)
            return this.finalizeSearch(primaryRes.results, opts, plan)
        }

        const alternates = this.baseChain().filter((b) => b !== primary)
        const winner = await this.raceMirrors(alternates, plan, opts, audio)
        if (winner) {
            this.rememberBase(winner.base)
            return this.finalizeSearch(winner.results, opts, plan)
        }

        this.invalidateBase()
        throw "anikoto: search failed (site unreachable)"
    }

    private async searchOn(base: string, plan: { queries: string[]; season: number; part: number }, opts: SearchOptions, audio: string): Promise<{ results: SearchResult[]; reached: boolean }> {
        const results: SearchResult[] = []
        const seen: { [key: string]: boolean } = {}
        let reached = false

        for (const q of plan.queries) {
            try {
                const start = this.now()
                const res = await fetch(`${base}/filter?keyword=${encodeURIComponent(q)}`, {
                    headers: this.pageHeaders(base),
                    timeout: 6,
                })
                if (!res.ok) continue
                const html = res.text()
                if (html.indexOf("div.item") === -1 && html.indexOf("d-title") === -1 && html.indexOf("no-results") === -1 && html.length < 500) continue
                this.recordLatency(base, this.now() - start)
                reached = true
                this.parseSearchInto(LoadDoc(html), base, audio, opts.dub, opts.media.id, seen, results)
            } catch (_e) {
                continue
            }
        }
        return { results, reached }
    }

    private raceMirrors(bases: string[], plan: { queries: string[]; season: number; part: number }, opts: SearchOptions, audio: string): Promise<{ base: string; results: SearchResult[] } | null> {
        if (bases.length === 0) return Promise.resolve(null)
        return new Promise((resolve) => {
            let done = false
            let remaining = bases.length
            const finish = (v: { base: string; results: SearchResult[] } | null): void => {
                if (done) return
                done = true
                resolve(v)
            }
            for (const base of bases) {
                this.searchOn(base, plan, opts, audio).then((r) => {
                    if (r.reached) finish({ base, results: r.results })
                    else if (--remaining === 0) finish(null)
                }).catch(() => {
                    if (--remaining === 0) finish(null)
                })
            }
        })
    }

    private finalizeSearch(results: SearchResult[], opts: SearchOptions, plan: { season: number; part: number }): SearchResult[] {
        const winner = this.dominantMatch(results, opts.media)
        return winner ? [winner] : this.filterBySeason(results, plan.season, plan.part)
    }

    private filterBySeason(results: SearchResult[], season: number, part: number): SearchResult[] {
        if (season < 2 && part < 2) return results
        const matched: SearchResult[] = []
        for (const r of results) {
            let rs = -1, rp = -1
            try {
                const n = $scannerUtils.normalizeTitle(r.title)
                if (n) { rs = n.season; rp = n.part }
            } catch (_e) {}
            const sOk = season < 2 || rs === season
            const pOk = part < 2 || rp === part
            if (sOk && pOk) matched.push(r)
        }
        return matched.length > 0 ? matched : results
    }

    private dominantMatch(results: SearchResult[], media: Media): SearchResult | null {
        if (results.length === 0) return null
        const targets: string[] = []
        for (const t of [media.romajiTitle, media.englishTitle]) {
            const n = this.normTitle(t || "")
            if (n) targets.push(n)
        }
        if (targets.length === 0) return null

        const isMovie = (media.format || "").toUpperCase() === "MOVIE"
        const scored: { r: SearchResult; s: number }[] = []
        for (const r of results) {
            const cn = this.normTitle(r.title)
            let best = 0
            for (const t of targets) {
                const v = this.simNorm(cn, t)
                if (v > best) best = v
            }
            if (isMovie && /\b(movie|film)\b/i.test(r.title)) best += 0.05
            scored.push({ r, s: best })
        }
        scored.sort((a, b) => b.s - a.s)
        if (scored[0].s >= 0.85 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.2)) return scored[0].r
        return null
    }

    private normTitle(s: string): string {
        return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
    }

    private simNorm(a: string, b: string): number {
        const ml = Math.max(a.length, b.length)
        return ml === 0 ? 0 : 1 - this.lev(a, b) / ml
    }

    private lev(a: string, b: string): number {
        const m = a.length, n = b.length
        if (!m) return n
        if (!n) return m
        const d: number[] = new Array(n + 1)
        for (let j = 0; j <= n; j++) d[j] = j
        for (let i = 1; i <= m; i++) {
            let prev = d[0]
            d[0] = i
            for (let j = 1; j <= n; j++) {
                const tmp = d[j]
                d[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, d[j], d[j - 1])
                prev = tmp
            }
        }
        return d[n]
    }

    private buildSearchPlan(opts: SearchOptions): { queries: string[]; season: number; part: number } {
        const raw: string[] = []
        const rawSeen: { [key: string]: boolean } = {}
        for (const t of [opts.query, opts.media.romajiTitle, opts.media.englishTitle]) {
            const q = (t || "").trim()
            if (!q) continue
            const key = q.toLowerCase()
            if (rawSeen[key]) continue
            rawSeen[key] = true
            raw.push(q)
        }

        const queries: string[] = []
        const seen: { [key: string]: boolean } = {}
        const push = (s: string): void => {
            const q = (s || "").trim()
            if (!q) return
            const key = q.toLowerCase()
            if (seen[key]) return
            seen[key] = true
            queries.push(q)
        }

        let season = 0, part = 0
        try {
            const smart = $scannerUtils.buildSmartSearchTitles(raw)
            if (smart) {
                season = smart.season || 0
                part = smart.part || 0
                if (smart.titles) for (const t of smart.titles) push(t)
            }
        } catch (_e) {}
        for (const t of raw) push(t)

        return { queries: queries.slice(0, 3), season, part }
    }

    private parseSearchInto(
        $: DocSelectionFunction,
        base: string,
        audio: string,
        dubOnly: boolean,
        anilistId: number,
        seen: { [key: string]: boolean },
        results: SearchResult[]
    ): void {
        $("div.item").each((_i, card) => {
            const titleLink = card.find("a.name.d-title").first()
            if (titleLink.length() === 0) return

            const href = titleLink.attr("href") || card.find(".ani.poster.tip a").first().attr("href")
            if (!href) return
            const seriesUrl = this.seriesUrl(this.resolveAgainst(href, base))
            if (seen[seriesUrl]) return

            const title = (titleLink.text() || titleLink.attr("data-jp") || card.find("img").first().attr("alt") || "").trim()
            if (!title) return

            const hasSub = card.find(".ep-status.sub").length() > 0
            const hasDub = card.find(".ep-status.dub").length() > 0
            if (dubOnly && !hasDub) return

            seen[seriesUrl] = true
            const subOrDub: SubOrDub = hasSub && hasDub ? "both" : hasDub ? "dub" : "sub"
            results.push({ id: this.withMeta(seriesUrl, audio, anilistId), title, url: seriesUrl, subOrDub })
        })
    }

    private async resolveFromServer(anilistId: number, audio: string): Promise<EpisodeDetails[] | null> {
        const cacheKey = `anikoto:resolve:${anilistId}:${audio}`
        const negKey = `anikoto:resolve:neg:${anilistId}:${audio}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey)
        if (cached && cached.length > 0) return cached
        if (this.readCache<boolean>(negKey, this.TTL.serverNeg)) return null

        return this.dedupe(cacheKey, async () => {
            try {
                const res = await fetch(`${this.subEndpoint}/resolve/${anilistId}`, { timeout: 4 })
                if (!res.ok) { this.writeCache(negKey, true); return null }
                const data = res.json<{ episodes?: { number: number; dataIds: string; title?: string; hasSub?: boolean; hasDub?: boolean }[]; token?: string }>()
                if (data && typeof data.token === "string" && data.token) this.writeCache(`anikoto:tok:${anilistId}`, data.token)
                const eps = data && data.episodes
                if (!eps || eps.length === 0) { this.writeCache(negKey, true); return null }

                const out: EpisodeDetails[] = []
                for (const e of eps) {
                    if (!e || typeof e.number !== "number" || !e.dataIds) continue
                    if (audio === "dub" ? e.hasDub === false : e.hasSub === false) continue
                    out.push({
                        id: this.withMeta(e.dataIds, audio, anilistId),
                        number: e.number,
                        url: `${this.baseUrl}/`,
                        title: e.title || undefined,
                    })
                }
                out.sort((a, b) => a.number - b.number)
                if (out.length === 0) { this.writeCache(negKey, true); return null }
                this.writeCache(cacheKey, out)
                return out
            } catch (_e) {
                this.writeCache(negKey, true)
                return null
            }
        })
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        this.baseUrl = this.currentBase()
        const meta = this.splitMeta(id)

        if (meta.anilistId) {
            const cached = this.readCache<EpisodeDetails[]>(`anikoto:resolve:${meta.anilistId}:${meta.audio}`)
            if (cached && cached.length > 0) {
                this.kickPrefetch(cached, meta.audio)
                return cached
            }
        }

        const seriesUrl = this.seriesUrl(this.absoluteUrl(meta.base))
        const scrapedKey = `anikoto:eps:${this.baseUrl}:${seriesUrl}:${meta.audio}:${meta.anilistId}`
        const scrapedCached = this.readCache<EpisodeDetails[]>(scrapedKey)
        if (scrapedCached && scrapedCached.length > 0) {
            this.kickPrefetch(scrapedCached, meta.audio)
            return scrapedCached
        }

        const episodes = await this.raceEpisodeSources(meta, seriesUrl, scrapedKey)
        if (episodes.length === 0) throw "anikoto: no episodes found"
        this.kickPrefetch(episodes, meta.audio)
        return episodes
    }

    private raceEpisodeSources(meta: { audio: string; anilistId: number; base: string }, seriesUrl: string, scrapedKey: string): Promise<EpisodeDetails[]> {
        return new Promise((resolve, reject) => {
            let done = false
            let scrapeErr: any
            let serverDone = false
            const finish = (fn: () => void): void => { if (done) return; done = true; fn() }

            if (meta.anilistId) {
                this.resolveFromServer(meta.anilistId, meta.audio).then((r) => {
                    serverDone = true
                    if (r && r.length > 0) finish(() => resolve(r))
                }).catch(() => { serverDone = true })
            } else {
                serverDone = true
            }

            const kickScrape = (): void => {
                if (done) return
                this.scrapeEpisodes(meta, seriesUrl, scrapedKey).then((r) => {
                    if (r.length > 0) finish(() => resolve(r))
                    else if (serverDone) finish(() => resolve([]))
                }).catch((e) => {
                    scrapeErr = e
                    if (serverDone) finish(() => reject(e))
                })
            }

            if (!meta.anilistId) { kickScrape(); return }
            setTimeout(kickScrape, 1500)

            setTimeout(() => {
                if (done) return
                if (scrapeErr) finish(() => reject(scrapeErr))
                else finish(() => resolve([]))
            }, 20000)
        })
    }

    private async scrapeEpisodes(meta: { audio: string; anilistId: number }, seriesUrl: string, scrapedKey: string): Promise<EpisodeDetails[]> {
        let page: FetchResponse
        try {
            page = await this.fetchRetry(seriesUrl, { headers: this.pageHeaders(), timeout: 10 })
        } catch (e) {
            this.invalidateBase()
            throw e
        }
        if (!page.ok) throw `anikoto: episode page failed (status ${page.status})`

        const pageHtml = page.text()
        let seriesId = this.firstAttr(LoadDoc(pageHtml), ["#watch-main", "[id*='watch'][data-id]", "main [data-id]"], "data-id")
        if (!seriesId) {
            const m = pageHtml.match(/data-id="(\d+)"/)
            if (m) seriesId = m[1]
        }
        if (!seriesId) throw "anikoto: could not determine series id (site layout may have changed)"

        const listRes = await this.fetchRetry(`${this.baseUrl}/ajax/episode/list/${seriesId}`, {
            headers: this.ajaxHeaders(), timeout: 10,
        })
        if (!listRes.ok) throw `anikoto: episode list failed (status ${listRes.status})`
        const listJson = listRes.json<{ status: number; result: string }>()
        if (!listJson || !listJson.result) throw "anikoto: empty episode list response"

        const both = this.parseBothEpisodeLists(listJson.result, meta.anilistId, seriesUrl)
        if (meta.anilistId) await this.enrichWithMeta(both.sub, both.dub, meta.anilistId)

        both.sub.sort((a, b) => a.number - b.number)
        both.dub.sort((a, b) => a.number - b.number)

        const subKey = `anikoto:eps:${this.baseUrl}:${seriesUrl}:sub:${meta.anilistId}`
        const dubKey = `anikoto:eps:${this.baseUrl}:${seriesUrl}:dub:${meta.anilistId}`
        if (both.sub.length > 0) this.writeCache(subKey, both.sub)
        if (both.dub.length > 0) this.writeCache(dubKey, both.dub)

        return meta.audio === "dub" ? both.dub : both.sub
    }

    private parseBothEpisodeLists(html: string, anilistId: number, seriesUrl: string): { sub: EpisodeDetails[]; dub: EpisodeDetails[] } {
        const $ = LoadDoc(html)
        const sub: EpisodeDetails[] = []
        const dub: EpisodeDetails[] = []
        const seenSub: { [key: string]: boolean } = {}
        const seenDub: { [key: string]: boolean } = {}

        let nodes = $("ul.ep-range li > a")
        if (nodes.length() === 0) nodes = $(".ep-range a")
        if (nodes.length() === 0) nodes = $("a[data-ids]")

        nodes.each((i, a) => {
            const epId = a.attr("data-id") || ""
            const dataIds = a.attr("data-ids")
            if (!dataIds) return
            const rawNum = a.attr("data-num") || ""
            if (/^\d+\.\d+$/.test(rawNum)) return

            let number = i + 1
            if (/^\d+$/.test(rawNum)) {
                const n = parseInt(rawNum, 10)
                if (n >= 1 && n <= 10000) number = n
            }
            const slug = a.attr("data-slug") || String(number)
            const title = a.find("span.d-title").first().text().trim()
            const dedupeKey = epId || dataIds

            const push = (bucket: EpisodeDetails[], seen: { [k: string]: boolean }, audio: string): void => {
                if (seen[dedupeKey]) return
                seen[dedupeKey] = true
                bucket.push({
                    id: this.withMeta(dataIds, audio, anilistId),
                    number,
                    url: `${seriesUrl}/ep-${slug}`,
                    title: title || undefined,
                })
            }

            if (a.attr("data-sub") !== "0") push(sub, seenSub, "sub")
            if (a.attr("data-dub") !== "0") push(dub, seenDub, "dub")
        })

        return { sub, dub }
    }

    private async enrichWithMeta(sub: EpisodeDetails[], dub: EpisodeDetails[], anilistId: number): Promise<void> {
        const cacheKey = `anikoto:meta:${anilistId}`
        let info = this.readCache<{
            episodes?: number
            episodeTitles?: { [key: string]: string }
            episodeMap?: { [key: string]: { ep: number | null; abs: number | null } }
        }>(cacheKey, this.TTL.meta)

        if (!info) {
            info = await this.dedupe(cacheKey, async () => {
                try {
                    const metaRes = await fetch(`${this.subEndpoint}/meta/${anilistId}`, { timeout: 4 })
                    if (!metaRes.ok) return { }
                    const data = metaRes.json<any>()
                    this.writeCache(cacheKey, data || {})
                    return data || {}
                } catch (_e) {
                    return { }
                }
            })
        }

        if (!info || Object.keys(info).length === 0) return
        this.applyMeta(sub, info)
        this.applyMeta(dub, info)
    }

    private applyMeta(episodes: EpisodeDetails[], info: { episodes?: number; episodeTitles?: { [key: string]: string }; episodeMap?: { [key: string]: { ep: number | null; abs: number | null } } }): void {
        if (episodes.length === 0) return
        const titles = info.episodeTitles || {}
        const map = info.episodeMap || {}
        const aniTotal = info.episodes || 0
        const mapKeys = Object.keys(map)
        const canRemap = mapKeys.length > 0 && !(aniTotal > 0 && mapKeys.length < aniTotal && episodes.length > mapKeys.length)

        if (canRemap) {
            const byNum: { [key: number]: EpisodeDetails } = {}
            for (const e of episodes) byNum[e.number] = e
            let maxTarget = 0
            for (const k of mapKeys) {
                const m = map[k]
                maxTarget = Math.max(maxTarget, m.ep || 0, m.abs || 0)
            }
            const perPart = episodes.length < maxTarget
            const remapped: EpisodeDetails[] = []
            for (const k of mapKeys) {
                const K = parseInt(k, 10)
                if (isNaN(K)) continue
                const m = map[k]
                const ep = !perPart && typeof m.ep === "number" && m.ep > 0 ? byNum[m.ep] : undefined
                const abs = !perPart && typeof m.abs === "number" && m.abs > 0 ? byNum[m.abs] : undefined
                const src = ep || abs || byNum[K]
                if (!src) continue
                remapped.push({ id: src.id, number: K, url: src.url, title: titles[String(K)] || src.title })
            }
            if (remapped.length >= Math.ceil(mapKeys.length / 2)) {
                episodes.length = 0
                for (const e of remapped) episodes.push(e)
            }
        }
        for (const e of episodes) {
            const t = titles[String(e.number)]
            if (!e.title && t) e.title = t
        }
    }

    private kickPrefetch(episodes: EpisodeDetails[], audio: string): void {
        if (episodes.length === 0) return
        const first = episodes[0]
        const meta = this.splitMeta(first.id)
        const key = `anikoto:pf:${meta.base}`
        if (this.readCache<boolean>(key, this.TTL.server)) return
        this.writeCache(key, true)
        try {
            void this.serverListDoc(meta.base).catch(() => undefined)
        } catch (_e) {}
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        this.baseUrl = this.currentBase()
        const meta = this.splitMeta(episode.id)
        const ctx = { anilistId: meta.anilistId, episode: episode.number }

        if (server === "Auto" || server === "default" || !server) {
            return this.pickAuto(meta.base, meta.audio, ctx)
        }

        const target = this.parseServerLabel(server, meta.audio)
        if (!target.ok) throw "anikoto: that server is not available for this audio track"

        const $ = await this.serverListDoc(meta.base)
        const candidates = this.collectServers($, target.groups)
        let picked: { name: string; linkId: string } | undefined
        for (const c of candidates) {
            if (this.normalizeServerName(c.name) === this.normalizeServerName(target.name)) {
                picked = c
                break
            }
        }
        if (!picked) throw "anikoto: that server is not available for this episode"

        return this.resolveServer(picked.linkId, target.label, ctx, meta.audio)
    }

    private normalizeServerName(name: string): string {
        return (name || "").replace(/[-\s]+$/g, "").toLowerCase()
    }

    private async pickAuto(dataIds: string, audio: string, ctx: { anilistId: number; episode: number }): Promise<EpisodeServer> {
        const $ = await this.serverListDoc(dataIds)
        const groups = audio === "dub" ? this.DUB_GROUPS : this.SUB_GROUPS
        const priority = audio === "dub"
            ? ["HD-1", "Vidstream-2", "VidCloud-1", "VidPlay-1", "Kiwi-Stream"]
            : ["VidPlay-1", "HD-1", "Vidstream-2", "VidCloud-1", "Kiwi-Stream"]

        const rankOf = (name: string): number => {
            const norm = this.normalizeServerName(name)
            for (let i = 0; i < priority.length; i++) {
                if (norm.indexOf(priority[i].toLowerCase()) === 0) return i
            }
            return -1
        }

        const candidates: { name: string; linkId: string; rank: number }[] = []
        for (const c of this.collectServers($, groups)) {
            const rank = rankOf(c.name)
            if (rank >= 0) candidates.push({ name: c.name, linkId: c.linkId, rank })
        }
        candidates.sort((a, b) => a.rank - b.rank)

        if (candidates.length === 0) {
            throw audio === "dub"
                ? "anikoto: no dub is available for this episode"
                : "anikoto: no server available for this episode"
        }

        const wantSubs = this.loadSubtitles !== "disabled"
        let firstResolved: EpisodeServer | undefined
        let playableNoSubs: EpisodeServer | undefined

        for (const c of candidates) {
            let resolved: EpisodeServer | undefined
            try { resolved = await this.resolveServer(c.linkId, c.name, ctx, audio) } catch (_e) { resolved = undefined }
            if (!resolved) continue
            resolved.server = "Auto"
            if (!firstResolved) firstResolved = resolved

            if (await this.isPlayable(resolved)) {
                const vs = resolved.videoSources[0]
                if (!wantSubs || (vs && vs.subtitles && vs.subtitles.length > 0)) return resolved
                if (!playableNoSubs) playableNoSubs = resolved
            }
        }

        if (playableNoSubs) return playableNoSubs
        if (firstResolved) return firstResolved
        throw "anikoto: no playable server found for this episode"
    }

    private parseServerLabel(server: string, audio: string): { groups: string[]; name: string; label: string; ok: boolean } {
        const hs = server.match(/^hs:\s*/i)
        if (hs) {
            const name = server.slice(hs[0].length)
            return { groups: ["hsub", "h-sub", "softsub", "soft-sub"], name, label: server, ok: audio !== "dub" }
        }
        return { groups: audio === "dub" ? this.DUB_GROUPS : this.SUB_GROUPS, name: server, label: server, ok: true }
    }

    private async serverListDoc(dataIds: string): Promise<DocSelectionFunction> {
        const cacheKey = `anikoto:slist:${dataIds}`
        const negKey = `anikoto:slist:neg:${dataIds}`
        let html = this.readCache<string>(cacheKey, this.TTL.server)
        if (html) return LoadDoc(html)
        if (this.readCache<boolean>(negKey, this.TTL.serverNeg)) return LoadDoc("")

        return this.dedupe(cacheKey, async () => {
            const slRes = await fetch(
                `${this.baseUrl}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`,
                { headers: this.ajaxHeaders(), timeout: 10 }
            )
            if (!slRes.ok) { this.writeCache(negKey, true); return LoadDoc("") }
            const sl = slRes.json<{ status: number; result: string }>()
            const body = (sl && sl.result) || ""
            if (body && body.indexOf("data-link-id") !== -1) this.writeCache(cacheKey, body)
            else this.writeCache(negKey, true)
            return LoadDoc(body)
        })
    }

    private collectServers($: DocSelectionFunction, groups: string[]): { name: string; linkId: string }[] {
        const out: { name: string; linkId: string }[] = []
        const seen: { [key: string]: boolean } = {}
        for (const t of groups) {
            $(`.servers .type[data-type="${t}"] li[data-link-id]`).each((_i, el) => {
                const linkId = el.attr("data-link-id")
                const name = el.text().trim()
                if (!linkId || !name || seen[linkId]) return
                if (this.SERVER_BLOCK_RX.test(name)) return
                seen[linkId] = true
                out.push({ name, linkId })
            })
        }
        return out
    }

    private async resolveServer(linkId: string, serverName: string, ctx: { anilistId: number; episode: number }, audio: string): Promise<EpisodeServer> {
        const got = await this.fetchSources(linkId)
        if (!got) throw "anikoto: could not resolve the player URL (embed page unavailable)"
        if (!got.file) throw "anikoto: could not resolve the player URL (source stream not found)"
        if (audio === "dub" && (await this.dubLooksWrong(got.tracks, got.origin))) throw "anikoto: dub source resolved to the subbed (Japanese) track"

        const subtitles = await this.buildSubtitles(got.tracks, { anilistId: ctx.anilistId, episode: ctx.episode, audio }, got.origin)
        return {
            server: serverName,
            headers: { Referer: `${got.origin}/`, Origin: got.origin },
            videoSources: [{ url: got.file, type: "m3u8", quality: "default", subtitles }],
        }
    }

    private async dubLooksWrong(
        tracks: { file: string; label?: string; kind?: string; default?: boolean }[] | undefined,
        origin: string
    ): Promise<boolean> {
        if (!tracks || tracks.length === 0) return false
        const caps: { file: string; label?: string; kind?: string; default?: boolean }[] = []
        let hasNonEnglish = false
        for (const t of tracks) {
            if (!t || typeof t.file !== "string" || !/^https?:\/\//i.test(t.file)) continue
            if (t.kind && t.kind !== "captions" && t.kind !== "subtitles") continue
            caps.push(t)
            const lbl = (t.label || "").toLowerCase()
            if (lbl && !/eng|english/.test(lbl)) hasNonEnglish = true
        }
        if (caps.length === 0) return false
        if (hasNonEnglish && caps.length > 1) return false

        let track: { file: string; label?: string; kind?: string; default?: boolean } | undefined
        for (const t of caps) if (t.default === true) { track = t; break }
        if (!track) track = caps[0]

        const label = track.label || "English"
        if (!/eng/i.test(label)) return false
        if (/\b(sdh|cc|signs?|songs?)\b/i.test(label)) return false

        const file = this.fixTrackUrl(track.file)
        try {
            const res = await fetch(file, { headers: { Referer: `${origin}/`, Origin: origin }, timeout: 3 })
            if (!res.ok) return false
            const body = res.text()
            const cues = (body.match(/-->/g) || []).length
            if (cues < 60 || body.length < 8000) return false
            const times = body.match(/(\d{2}):(\d{2}):(\d{2})/g) || []
            if (times.length < 2) return true
            const last = times[times.length - 1].split(":").map((n) => parseInt(n, 10))
            const secs = last[0] * 3600 + last[1] * 60 + last[2]
            if (secs < 60) return true
            const cpm = cues / (secs / 60)
            return cpm >= 8
        } catch (_e) {
            return false
        }
    }

    private async isPlayable(server: EpisodeServer): Promise<boolean> {
        const src = server.videoSources[0]
        if (!src || !src.url) return false
        try {
            const body = await this.fetchPlaylist(src.url, server.headers)
            if (body === undefined) return false
            const variants = this.variantLevelUrls(body, src.url)
            if (variants.length === 0) return true
            return await this.raceOk(variants.slice(0, 2), server.headers, 3)
        } catch (_e) {
            return false
        }
    }

    private raceOk(urls: string[], headers: { [k: string]: string }, timeout: number): Promise<boolean> {
        return new Promise((resolve) => {
            if (urls.length === 0) return resolve(false)
            let done = false
            let remaining = urls.length
            const finish = (v: boolean): void => { if (done) return; done = true; resolve(v) }
            for (const u of urls) {
                fetch(u, { headers, timeout })
                    .then((r) => { if (r && r.ok) finish(true); else if (--remaining === 0) finish(false) })
                    .catch(() => { if (--remaining === 0) finish(false) })
            }
        })
    }

    private async fetchPlaylist(url: string, headers: { [k: string]: string }): Promise<string | undefined> {
        try {
            const res = await fetch(url, { headers, timeout: 3 })
            if (!res.ok) return undefined
            const body = res.text()
            return body.indexOf("#EXTM3U") !== -1 ? body : undefined
        } catch (_e) {
            return undefined
        }
    }

    private variantLevelUrls(master: string, masterUrl: string): string[] {
        const out: string[] = []
        const lines = master.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf("#EXT-X-STREAM-INF") !== 0) continue
            const raw = (lines[i + 1] || "").trim()
            if (!raw || raw.charAt(0) === "#") continue
            out.push(this.resolveAgainst(raw, masterUrl))
        }
        return out
    }

    private resolveAgainst(ref: string, baseUrl: string): string {
        if (!ref) return ref
        if (/^https?:\/\//i.test(ref)) return ref
        const base = baseUrl.replace(/#.*$/, "")
        if (ref.indexOf("//") === 0) {
            const scheme = base.match(/^(https?):/i)
            return `${scheme ? scheme[1] : "https"}:${ref}`
        }
        const baseNoQuery = base.replace(/\?.*$/, "")
        const originMatch = baseNoQuery.match(/^(https?:\/\/[^/]+)/i)
        const origin = originMatch ? originMatch[1] : this.baseUrl
        if (ref.charAt(0) === "/") return `${origin}${ref}`

        const dir = baseNoQuery.replace(/[^/]*$/, "")
        let combined = dir + ref
        while (/\/\.\//.test(combined)) combined = combined.replace(/\/\.\//g, "/")
        while (/[^/]+\/\.\.\//.test(combined)) combined = combined.replace(/[^/]+\/\.\.\//, "")
        return combined
    }

    private async fetchSources(
        linkId: string
    ): Promise<{ origin: string; file?: string; tracks?: { file: string; label?: string; kind?: string; default?: boolean }[] } | undefined> {
        const cacheKey = `anikoto:src:${linkId}`
        const cachedSrc = this.readCache<{ origin: string; file?: string; tracks?: { file: string; label?: string; kind?: string; default?: boolean }[]; probed: number }>(
            cacheKey, this.TTL.server
        )
        if (cachedSrc) {
            const fresh = this.now() - cachedSrc.probed < this.TTL.sourceProbed
            if (fresh || !cachedSrc.file) return cachedSrc
            if (await this.headOk(cachedSrc.file, cachedSrc.origin)) {
                this.writeCache(cacheKey, { ...cachedSrc, probed: this.now() })
                return cachedSrc
            }
        }

        return this.dedupe(cacheKey, async () => {
            const psRes = await this.fetchRetry(`${this.baseUrl}/ajax/server?get=${encodeURIComponent(linkId)}`, {
                headers: this.ajaxHeaders(), timeout: 5,
            })
            if (!psRes.ok) return undefined
            const ps = psRes.json<{ status: number; result: { url: string } }>()
            let embedUrl = ps && ps.result ? ps.result.url : undefined
            if (!embedUrl) return undefined

            const origin = this.originOf(embedUrl)
            const embedRes = await this.fetchRetry(embedUrl, { headers: { Referer: `${this.baseUrl}/` }, timeout: 5 })
            if (!embedRes.ok) return undefined

            const ehtml = embedRes.text()
            let dataId = this.firstAttr(LoadDoc(ehtml), ["#megaplay-player", "[id*='player'][data-id]"], "data-id")
            if (!dataId) {
                const m = ehtml.match(/data-id="([^"]+)"/)
                if (m) dataId = m[1]
            }
            if (!dataId) {
                const ifr = ehtml.match(/<iframe[^>]+\bsrc="([^"]*\/stream\/[^"]*)"/i)
                const inner = ifr ? this.absoluteUrl(ifr[1]) : ""
                if (inner && this.originOf(inner) === origin) {
                    const innerRes = await this.fetchRetry(inner, { headers: { Referer: embedUrl }, timeout: 5 })
                    if (innerRes.ok) {
                        const ih = innerRes.text()
                        dataId = this.firstAttr(LoadDoc(ih), ["#megaplay-player", "[id*='player'][data-id]"], "data-id")
                        if (!dataId) {
                            const m2 = ih.match(/data-id="([^"]+)"/)
                            if (m2) dataId = m2[1]
                        }
                        if (dataId) embedUrl = inner
                    }
                }
            }
            if (!dataId || !/^[\w.-]{1,256}$/.test(dataId)) return undefined

            const srcRes = await this.fetchRetry(`${origin}/stream/getSources?id=${encodeURIComponent(dataId)}`, {
                headers: { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" }, timeout: 5,
            })
            if (!srcRes.ok) return undefined
            const data = srcRes.json<{
                sources: { file: string } | { file: string }[]
                tracks?: { file: string; label?: string; kind?: string; default?: boolean }[]
            }>()
            if (!data || !data.sources) return undefined
            const raw = Array.isArray(data.sources) ? (data.sources[0] || ({} as any)).file : data.sources.file
            const file = typeof raw === "string" && /^https?:\/\//i.test(raw) ? raw : undefined
            const result = { origin, file, tracks: Array.isArray(data.tracks) ? data.tracks : undefined, probed: this.now() }
            if (file) this.writeCache(cacheKey, result)
            return result
        })
    }

    private async headOk(url: string, origin: string): Promise<boolean> {
        try {
            const res = await fetch(url, { headers: { Referer: `${origin}/`, Origin: origin }, timeout: 3 })
            if (!res.ok) return false
            const body = res.text()
            return body.indexOf("#EXTM3U") !== -1
        } catch (_e) {
            return false
        }
    }

    private fixTrackUrl(file: string): string {
        if (!file || file.indexOf("/subtitles/") !== -1) return file
        const m = file.match(/^(https?:\/\/[^/]+\/[0-9a-f]{16,}\/)([^/?#]+\.(?:vtt|ass|srt))/i)
        if (m) return file.replace(m[0], `${m[1]}subtitles/${m[2]}`)
        return file
    }

    private extOf(file: string): string {
        const path = file.split(/[?#]/)[0]
        const m = path.match(/\.([a-z0-9]+)$/i)
        const e = m ? m[1].toLowerCase() : ""
        return e === "ass" || e === "srt" ? e : "vtt"
    }

    private async subUp(): Promise<boolean> {
        const cached = this.readCache<boolean>("anikoto:subup", this.TTL.health)
        if (cached !== undefined) return cached
        return this.dedupe("anikoto:subup", async () => {
            let up = false
            try {
                const res = await fetch(`${this.subEndpoint}/health`, { timeout: 3 })
                up = !!res && res.ok
            } catch (_e) {
                up = false
            }
            this.writeCache("anikoto:subup", up)
            return up
        })
    }

    private async ensureServeToken(anilistId: number): Promise<string | undefined> {
        const key = `anikoto:tok:${anilistId}`
        const cached = this.readCache<string>(key, this.TTL.token)
        if (cached) return cached
        return this.dedupe(`tok:${anilistId}`, async () => {
            try {
                const res = await fetch(`${this.subEndpoint}/resolve/${anilistId}`, { timeout: 4 })
                if (!res.ok) return undefined
                const data = res.json<{ token?: string }>()
                if (data && typeof data.token === "string" && data.token) {
                    this.writeCache(key, data.token)
                    return data.token
                }
            } catch (_e) {}
            return undefined
        })
    }

    private async buildSubtitles(
        tracks: { file: string; label?: string; kind?: string; default?: boolean }[] | undefined,
        ctx: { anilistId: number; episode: number; audio: string },
        embedOrigin?: string
    ): Promise<VideoSubtitle[]> {
        if (this.loadSubtitles === "disabled") return []
        if (!tracks || tracks.length === 0) return []

        const valid: { file: string; label?: string; kind?: string; default?: boolean }[] = []
        for (const t of tracks) {
            if (!t || typeof t.file !== "string" || !/^https?:\/\//i.test(t.file)) continue
            if (t.kind && t.kind !== "captions" && t.kind !== "subtitles") continue
            valid.push(t)
        }
        if (valid.length === 0) return []

        const useProxy = ctx.anilistId > 0
        const refParam = embedOrigin ? `&ref=${encodeURIComponent(embedOrigin)}` : ""
        let tokParam = ""
        let up = false

        if (useProxy) {
            up = await this.subUp()
            if (up) {
                let tok = this.readCache<string>(`anikoto:tok:${ctx.anilistId}`, this.TTL.token)
                if (!tok) tok = await this.ensureServeToken(ctx.anilistId)
                tokParam = tok ? `&t=${encodeURIComponent(tok)}` : ""
            }
        }

        const labels: string[] = []
        for (const t of valid) labels.push(t.label || "English")
        const codes = await this.langCodes(labels)

        type Entry = { sub: VideoSubtitle; lang: string; isSigns: boolean; srcDefault: boolean }
        const entries: Entry[] = []
        const seenUrls: { [key: string]: boolean } = {}
        const SIGNS_RX = /\b(signs?|songs?|s&s|sdh|cc)\b/i

        for (let i = 0; i < valid.length; i++) {
            const t = valid[i]
            const fixed = this.fixTrackUrl(t.file)
            if (seenUrls[fixed]) continue
            seenUrls[fixed] = true

            const lang = codes[i]
            const rawLabel = t.label || (lang === "en" ? "English" : lang)
            const isSigns = SIGNS_RX.test(rawLabel)
            const displayLabel = isSigns && !/\b(signs?|songs?)\b/i.test(rawLabel)
                ? `${rawLabel} (Signs)`
                : rawLabel
            const url = useProxy && up
                ? `${this.subEndpoint}/s/${ctx.anilistId}/${ctx.episode}/${lang}${isSigns ? "-signs" : ""}.${this.extOf(fixed)}?src=${encodeURIComponent(fixed)}${tokParam}${refParam}`
                : fixed
            entries.push({
                sub: {
                    id: `${lang}${isSigns ? "-signs" : ""}-${entries.length}`,
                    url,
                    language: displayLabel,
                    isDefault: false,
                },
                lang,
                isSigns,
                srcDefault: t.default === true,
            })
        }

        if (entries.length === 0) return []

        const isDub = ctx.audio === "dub"
        let defaultIdx = -1
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i]
            if (e.lang !== "en") continue
            if (isDub && e.isSigns) { defaultIdx = i; break }
            if (!isDub && !e.isSigns) { defaultIdx = i; break }
        }
        if (defaultIdx === -1) {
            for (let i = 0; i < entries.length; i++) {
                if (entries[i].lang === "en") { defaultIdx = i; break }
            }
        }
        if (defaultIdx === -1) {
            for (let i = 0; i < entries.length; i++) {
                if (entries[i].srcDefault) { defaultIdx = i; break }
            }
        }
        if (defaultIdx === -1) defaultIdx = 0
        entries[defaultIdx].sub.isDefault = true

        const collected = entries.map((e) => e.sub)
        if (useProxy && up) this.warmLanguages(collected, ctx)
        return collected.filter((s) => s.isDefault).concat(collected.filter((s) => !s.isDefault))
    }

    private warmLanguages(subs: VideoSubtitle[], ctx: { anilistId: number; episode: number; audio: string }): void {
        if (subs.length <= 1 || ctx.anilistId <= 0) return
        const key = `anikoto:lw:${ctx.anilistId}:${ctx.episode}:${ctx.audio}`
        if (this.readCache<boolean>(key, this.TTL.server)) return
        this.writeCache(key, true)
        try {
            void Promise.all(subs.map((s) => fetch(s.url, { timeout: 8 }).catch(() => undefined)))
        } catch (_e) {}
    }

    private async langCodes(labels: string[]): Promise<string[]> {
        const out: string[] = new Array(labels.length)
        const missing: { idx: number; label: string }[] = []
        for (let i = 0; i < labels.length; i++) {
            const cached = this.readCache<string>(`anikoto:lang:${labels[i]}`, this.TTL.lang)
            if (cached) out[i] = cached
            else missing.push({ idx: i, label: labels[i] })
        }
        if (missing.length > 0) {
            let codes: string[] = []
            try {
                const res = await fetch(`${this.subEndpoint}/lang`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ labels: missing.map((m) => m.label) }),
                    timeout: 5,
                })
                if (res.ok) {
                    const j = res.json<{ codes: string[] }>()
                    codes = (j && j.codes) || []
                }
            } catch (_e) {}
            for (let k = 0; k < missing.length; k++) {
                const fromServer = codes[k]
                const code = fromServer || this.fallbackCode(missing[k].label)
                out[missing[k].idx] = code
                if (fromServer) this.writeCache(`anikoto:lang:${missing[k].label}`, code)
            }
        }
        return out
    }

    private fallbackCode(label: string): string {
        const k = (label || "english").toLowerCase().replace(/[^a-z]/g, "")
        if (!k) return "en"
        const map: { [key: string]: string } = {
            eng: "en", english: "en",
            por: "pt", portuguese: "pt", brazilian: "pt",
            spa: "es", esp: "es", spanish: "es", castilian: "es",
            ger: "de", deu: "de", german: "de",
            fre: "fr", fra: "fr", french: "fr",
            dut: "nl", nld: "nl", dutch: "nl",
            chi: "zh", zho: "zh", chinese: "zh", mandarin: "zh",
            jpn: "ja", japanese: "ja",
            kor: "ko", korean: "ko",
            ind: "id", indonesian: "id",
            may: "ms", msa: "ms", malay: "ms",
            gre: "el", ell: "el", greek: "el",
            cze: "cs", ces: "cs", czech: "cs",
            rum: "ro", ron: "ro", romanian: "ro",
            swe: "sv", swedish: "sv",
            ara: "ar", arabic: "ar",
            rus: "ru", russian: "ru",
            ita: "it", italian: "it",
            pol: "pl", polish: "pl",
            tur: "tr", turkish: "tr",
            tha: "th", thai: "th",
            vie: "vi", vietnamese: "vi",
            ukr: "uk", ukrainian: "uk",
            hin: "hi", hindi: "hi",
        }
        return map[k] || "en"
    }

    private withAudio(base: string, audio: string): string {
        return `${base}$${audio}`
    }

    private splitAudio(id: string): { base: string; audio: string } {
        const i = id.lastIndexOf("$")
        if (i !== -1) {
            const a = id.slice(i + 1)
            if (a === "sub" || a === "dub") return { base: id.slice(0, i), audio: a }
        }
        return { base: id, audio: "sub" }
    }

    private withMeta(base: string, audio: string, anilistId: number): string {
        const a = this.withAudio(base, audio)
        return anilistId > 0 ? `${a}$al${anilistId}` : a
    }

    private splitMeta(id: string): { base: string; audio: string; anilistId: number } {
        let rest = id
        let anilistId = 0
        const m = rest.match(/\$al(\d+)$/)
        if (m) {
            anilistId = parseInt(m[1], 10)
            rest = rest.slice(0, rest.length - m[0].length)
        }
        const sa = this.splitAudio(rest)
        return { base: sa.base, audio: sa.audio, anilistId }
    }

    private now(): number {
        try { return Date.now() } catch (_e) { return 0 }
    }

    private readCache<T>(key: string, ttl?: number): T | undefined {
        const entry = $store.get<{ at: number; data: T }>(key)
        const t = this.now()
        const max = ttl === undefined ? this.TTL.page : ttl
        if (entry && t > 0 && entry.at > 0 && t - entry.at < max) return entry.data
        return undefined
    }

    private writeCache<T>(key: string, data: T): void {
        const t = this.now()
        if (t > 0) $store.set(key, { at: t, data })
    }

    private seriesUrl(href: string): string {
        let u = this.absoluteUrl(href)
        const q = u.indexOf("?")
        if (q !== -1) u = u.slice(0, q)
        const h = u.indexOf("#")
        if (h !== -1) u = u.slice(0, h)
        return u.replace(/\/ep-[^/]+\/?$/i, "")
    }

    private absoluteUrl(u: string): string {
        if (!u) return u
        if (u.indexOf("http://") === 0 || u.indexOf("https://") === 0) return u
        if (u.indexOf("//") === 0) return `https:${u}`
        if (u.charAt(0) === "/") return `${this.baseUrl}${u}`
        return `${this.baseUrl}/${u}`
    }

    private originOf(u: string): string {
        if (u && u.indexOf("//") === 0) u = `https:${u}`
        const m = u.match(/^(https?:\/\/[^/]+)/i)
        return m ? m[1] : this.baseUrl
    }
}
