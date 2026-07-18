class Provider {
    baseUrl = "https://animepahe.pw"

    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

    private siteHeaders(): Record<string, string> {
        return {
            "User-Agent": this.ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": this.baseUrl + "/",
            "Cookie": "__ddg1_=;__ddg2_=;",
        }
    }

    getSettings(): Settings {
        return {
            episodeServers: ["kwik"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const res = await fetch(
            `${this.baseUrl}/api?m=search&q=${encodeURIComponent(opts.query)}`,
            { headers: this.siteHeaders() },
        )
        const data = await res.json() as { data?: any[] }
        const rows = Array.isArray(data?.data) ? data.data : []

        return rows.map((item: any): SearchResult => ({
            id: `${item.id}/${item.session}`,
            title: String(item.title ?? ""),
            url: `${this.baseUrl}/anime/${item.session}`,
            subOrDub: "both",
        }))
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const parts = String(id).split("/")
        const session = parts[1] ?? parts[0]
        if (!session) throw new Error("AnimePahe id must be in 'animeId/session' format")

        const episodes: EpisodeDetails[] = []

        const first = await this.fetchReleasePage(session, 1)
        const lastPage = parseInt(String(first.last_page ?? 1), 10) || 1
        this.mapEpisodes(session, first.data ?? []).forEach(e => episodes.push(e))

        if (lastPage > 1) {
            const promises: Promise<EpisodeDetails[]>[] = []
            for (let page = 2; page <= lastPage; page++) {
                promises.push(
                    this.fetchReleasePage(session, page)
                        .then(r => this.mapEpisodes(session, r.data ?? []))
                        .catch(() => [] as EpisodeDetails[]),
                )
            }
            const results = await Promise.all(promises)
            for (const eps of results) episodes.push(...eps)
        }

        return episodes
            .filter(e => Number.isFinite(e.number))
            .sort((a, b) => a.number - b.number)
    }

    private async fetchReleasePage(session: string, page: number): Promise<{ last_page?: number, data?: any[] }> {
        const res = await fetch(
            `${this.baseUrl}/api?m=release&id=${session}&sort=episode_asc&page=${page}`,
            { headers: this.siteHeaders() },
        )
        return await res.json() as any
    }

    private mapEpisodes(session: string, rows: any[]): EpisodeDetails[] {
        return rows.map((item: any): EpisodeDetails => ({
            id: `${session}/${item.session}`,
            number: Number(item.episode),
            url: `${this.baseUrl}/play/${session}/${item.session}`,
            title: item.title && String(item.title).length > 0
                ? String(item.title)
                : `Episode ${item.episode}`,
        }))
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const episodeId = String(episode.id ?? "").trim()
        if (!episodeId.includes("/"))
            throw new Error("AnimePahe episode id must be in 'animeSession/episodeSession' format")

        const playUrl = `${this.baseUrl}/play/${episodeId}`
        const res = await fetch(playUrl, { headers: this.siteHeaders() })
        const html = await res.text()
        const $ = LoadDoc(html)

        type Btn = { src: string, quality: string, fansub: string, isEng: boolean }
        const buttons: Btn[] = []
        $("button[data-src]").each((_, el) => {
            const src = el.attr("data-src") ?? ""
            if (!src.startsWith("http")) return
            buttons.push({
                src: src,
                quality: el.attr("data-resolution") ?? "Auto",
                fansub: el.attr("data-fansub") ?? "",
                isEng: el.attr("data-audio") === "eng",
            })
        })

        if (buttons.length === 0)
            throw new Error("No AnimePahe server buttons found on play page")

        const kwikHeaders: Record<string, string> = {
            "User-Agent": this.ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": this.baseUrl + "/",
        }

        const sources: VideoSource[] = []
        const seen: Record<string, boolean> = {}
        let lastEmbed = this.baseUrl + "/"

        for (const btn of buttons) {
            if (seen[btn.src]) continue
            seen[btn.src] = true
            try {
                const kwikRes = await fetch(btn.src, { headers: kwikHeaders })
                const kwikHtml = await kwikRes.text()
                const m3u8 = extractKwikM3u8FromHtml(kwikHtml)
                if (!m3u8) continue

                lastEmbed = btn.src
                const label = `${btn.quality}p ${btn.fansub}${btn.isEng ? " Eng" : ""}`
                    .replace(/\s+/g, " ").trim()

                sources.push({
                    url: m3u8,
                    type: m3u8.includes(".m3u8") ? "m3u8" : "mp4",
                    quality: label,
                    label: btn.isEng ? "English" : undefined,
                    subtitles: [],
                })
            } catch (e) {
            }
        }

        if (sources.length === 0)
            throw new Error("AnimePahe: could not extract any stream URLs from kwik embed pages")

        return {
            server: "kwik",
            headers: { "Referer": lastEmbed },
            videoSources: sources,
        }
    }
}

function kwikSkipSpaces(src: string, index: number): number {
    while (index < src.length && /\s/.test(src[index])) index++
    return index
}

function kwikReadJsString(src: string, index: number): { value: string, end: number } | null {
    index = kwikSkipSpaces(src, index)
    const quote = src[index]
    if (quote !== "'" && quote !== '"') return null
    let value = ""
    for (let i = index + 1; i < src.length; i++) {
        const ch = src[i]
        if (ch === "\\") {
            const next = src[++i]
            if (next === undefined) return null
            if (next === "x" && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 1, i + 3))) {
                value += String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16))
                i += 2
            } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 1, i + 5))) {
                value += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16))
                i += 4
            } else {
                const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }
                value += Object.prototype.hasOwnProperty.call(map, next) ? map[next] : next
            }
        } else if (ch === quote) {
            return { value: value, end: i + 1 }
        } else {
            value += ch
        }
    }
    return null
}

function kwikReadNumber(src: string, index: number): { value: number, end: number } | null {
    index = kwikSkipSpaces(src, index)
    const match = src.slice(index).match(/^\d+/)
    if (!match) return null
    return { value: parseInt(match[0], 10), end: index + match[0].length }
}

function kwikReadComma(src: string, index: number): number {
    index = kwikSkipSpaces(src, index)
    return src[index] === "," ? index + 1 : -1
}

function kwikBaseEncode(num: number, radix: number): string {
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    if (!Number.isFinite(num) || num < 0 || radix < 2 || radix > alphabet.length) return String(num)
    let out = ""
    do {
        out = alphabet[num % radix] + out
        num = Math.floor(num / radix)
    } while (num > 0)
    return out
}

type KwikPayload = { packed: string, radix: number, count: number, keys: string[] }

function kwikParsePackedPayloads(html: string): KwikPayload[] {
    const payloads: KwikPayload[] = []
    const marker = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)\s*\{[\s\S]*?\}\s*\(\s*/g
    let markerMatch: RegExpExecArray | null
    while ((markerMatch = marker.exec(html)) !== null) {
        let index = marker.lastIndex
        const packed = kwikReadJsString(html, index)
        if (!packed) continue
        index = kwikReadComma(html, packed.end)
        if (index < 0) continue
        const radix = kwikReadNumber(html, index)
        if (!radix) continue
        index = kwikReadComma(html, radix.end)
        if (index < 0) continue
        const count = kwikReadNumber(html, index)
        if (!count) continue
        index = kwikReadComma(html, count.end)
        if (index < 0) continue
        const keys = kwikReadJsString(html, index)
        if (!keys) continue
        payloads.push({ packed: packed.value, radix: radix.value, count: count.value, keys: keys.value.split("|") })
    }
    return payloads
}

function kwikUnpackPayload(payload: KwikPayload): string {
    const dict: Record<string, string> = {}
    const limit = Math.min(payload.count, payload.keys.length)
    for (let i = limit - 1; i >= 0; i--) {
        if (payload.keys[i]) dict[kwikBaseEncode(i, payload.radix)] = payload.keys[i]
    }
    return payload.packed.replace(/\b\w+\b/g, token =>
        Object.prototype.hasOwnProperty.call(dict, token) ? dict[token] : token)
}

function kwikNormaliseEscapes(text: string): string {
    return String(text || "")
        .replace(/\\\//g, "/")
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function kwikFindM3u8(text: string): string | null {
    const body = kwikNormaliseEscapes(text)
    const direct = body.match(/https?:\/\/[^"'<>\s\\]+?\.m3u8(?:\?[^"'<>\s\\]*)?/i)
    if (direct) return direct[0]
    const source = body.match(/(?:source|src|file|url)\s*[:=]\s*["']([^"']+?\.m3u8[^"']*)["']/i)
    if (source) return kwikNormaliseEscapes(source[1])
    return null
}

function extractKwikM3u8FromHtml(html: string): string | null {
    const direct = kwikFindM3u8(html)
    if (direct) return direct
    const payloads = kwikParsePackedPayloads(String(html || ""))
    for (let i = 0; i < payloads.length; i++) {
        try {
            const unpacked = kwikUnpackPayload(payloads[i])
            const stream = kwikFindM3u8(unpacked)
            if (stream) return stream
        } catch (e) {
        }
    }
    return null
}
