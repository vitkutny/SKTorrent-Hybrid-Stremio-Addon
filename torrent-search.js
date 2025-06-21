const axios = require('axios');
const cheerio = require('cheerio');
const bencode = require('bncode');
const crypto = require('crypto');
const { decode } = require('entities');

const searchTorrents = async (apiClient, config, query) => {
    console.log(`🔎 Hledám '${query}' na SKTorrent...`);
    try {
        const session = axios.create({
            ...apiClient.defaults,
            headers: { 
                ...apiClient.defaults.headers,
                Cookie: `uid=${config.SKT_UID}; pass=${config.SKT_PASS}` 
            }
        });
        const { data } = await session.get(config.SEARCH_URL, { params: { search: query, category: 0 } });
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
        const { data } = await apiClient.get(url, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${config.SKT_UID}; pass=${config.SKT_PASS}`,
                Referer: config.BASE_URL
            }
        });
        const torrent = bencode.decode(data);
        const info = bencode.encode(torrent.info);
        const infoHash = crypto.createHash("sha1").update(info).digest("hex");

        const trackers = [];
        if (torrent.announce) trackers.push(torrent.announce.toString());
        if (torrent['announce-list']) {
            for (const arr of torrent['announce-list']) {
                if (Array.isArray(arr)) {
                    for (const tr of arr) trackers.push(tr.toString());
                } else if (typeof arr === 'string' || Buffer.isBuffer(arr)) {
                    trackers.push(arr.toString());
                }
            }
        }
        return {
            infoHash,
            name: torrent.info.name ? torrent.info.name.toString() : '',
            size: torrent.info.length || null,
            trackers
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
