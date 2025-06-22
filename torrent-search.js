const axios = require('axios');
const cheerio = require('cheerio');
const parseTorrent = require('parse-torrent');
const { decode } = require('entities');

const searchTorrents = async (apiClient, config, query) => {
    console.log(`🔎 Hledám '${query}' na SKTorrent...`);
    try {
        const session = axios.create({
            ...apiClient.defaults,
            headers: {
                ...apiClient.defaults.headers,
                Cookie: `uid=${config.SKT_UID}; pass=${config.SKT_PASS}`,
                Referer: config.BASE_URL,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const { data } = await session.get(config.SEARCH_URL, { 
            params: { search: query, category: 0 } 
        });
        
        const $ = cheerio.load(data);
        const results = [];

        $('a[href^="details.php"] img').each((_, img) => {
            const parent = $(img).closest("a");
            const outerTd = parent.closest("td");
            const fullBlock = outerTd.text().replace(/\s+/g, ' ').trim();
            const href = parent.attr("href") || "";
            const tooltip = parent.attr("title") || "";
            const torrentId = href.split("id=").pop();
            const category = outerTd.find("b").first().text().trim();
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);

            if (!category.toLowerCase().includes("film") &&
                !category.toLowerCase().includes("seri")) return;

            results.push({
                name: tooltip,
                id: torrentId,
                size: sizeMatch ? sizeMatch[1].trim() : "?",
                seeds: seedMatch ? seedMatch[1] : "0",
                category,
                downloadUrl: `${config.BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });

        console.log(`📦 Nalezeno torrentů: ${results.length}`);
        return results;
    } catch (err) {
        console.error(`❌ Vyhledávání selhalo: ${err.message}`);
        return [];
    }
};

const getTorrentInfo = async (apiClient, config, url) => {
    try {
        console.log(`🔍 Stahuji .torrent soubor: ${url}`);
        
        const { data } = await apiClient.get(url, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${config.SKT_UID}; pass=${config.SKT_PASS}`, // ✅ Opraveno: cookies přidány
                Referer: config.BASE_URL,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        // ✅ Použití parse-torrent pro konzistentní zpracování
        const parsed = parseTorrent(data);
        
        console.log(`✅ Torrent zpracován: ${parsed.name} (${parsed.infoHash})`);
        
        return {
            infoHash: parsed.infoHash,
            name: parsed.name || '',
            size: parsed.length || null,
            trackers: parsed.announce || []
        };
    } catch (err) {
        console.error(`❌ Chyba při zpracování .torrent: ${err.message}`);
        return null;
    }
};

const getTitleFromIMDb = async (apiClient, imdbId) => {
    try {
        const { data } = await apiClient.get(`https://www.imdb.com/title/${imdbId}/`);
        const $ = cheerio.load(data);
        const titleRaw = $('title').text().split(' - ')[0].trim();
        const title = decode(titleRaw);

        let originalTitle = title;
        const ldJson = $('script[type="application/ld+json"]').html();
        if (ldJson) {
            try {
                const json = JSON.parse(ldJson);
                if (json?.name) originalTitle = decode(json.name.trim());
            } catch (e) {}
        }

        console.log(`🌝 Lokalizovaný: ${title} | Originální: ${originalTitle}`);
        return { title, originalTitle };
    } catch (err) {
        console.error(`❌ IMDb chyba: ${err.message}`);
        return null;
    }
};

module.exports = {
    searchTorrents,
    getTorrentInfo,
    getTitleFromIMDb
};
