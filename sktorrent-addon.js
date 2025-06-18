// SKTorrent Stremio addon s pokročilým fallback systémom pre filmy a seriály
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");
const express = require("express");

// Real-Debrid API integrace
const RealDebridAPI = require('./realdebrid');

const SKT_UID = process.env.SKT_UID || "";
const SKT_PASS = process.env.SKT_PASS || "";
const ADDON_API_KEY = process.env.ADDON_API_KEY || "";

// NOVÁ PROMĚNNÁ: Řízení zobrazování streamů
const STREAM_MODE = process.env.STREAM_MODE || "RD_ONLY"; // RD_ONLY, BOTH, TORRENT_ONLY

// Inicializace RD API
const rd = process.env.REALDEBRID_API_KEY ?
  new RealDebridAPI(process.env.REALDEBRID_API_KEY) : null;

if (rd) {
  console.log('🔧 Real-Debrid hybrid mode enabled');
} else {
  console.log('🔧 Running in torrent-only mode (set REALDEBRID_API_KEY for hybrid)');
}

if (ADDON_API_KEY) {
  console.log('🔐 API key authentication enabled');
} else {
  console.log('⚠️ Warning: No API key set - addon accessible to everyone');
}

console.log(`🎮 Stream mode: ${STREAM_MODE}`);

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = addonBuilder({
    id: "org.stremio.sktorrent.hybrid.secure",
    version: "1.5.3",
    name: `SKTorrent Hybrid (${STREAM_MODE})`,
    description: `Private Real-Debrid + Torrent addon with API key protection - Mode: ${STREAM_MODE}`,
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "sktorrent-movie", name: "SKTorrent Filmy" },
        { type: "series", id: "sktorrent-series", name: "SKTorrent Seriály" }
    ],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

function removeDiacritics(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

function isMultiSeason(title) {
    return /(S\d{2}E\d{2}-\d{2}|Complete|All Episodes|Season \d+(-\d+)?)/i.test(title);
}

function extractQuality(title) {
    const titleLower = title.toLowerCase();
    if (titleLower.includes('2160p') || titleLower.includes('4k')) return '4K';
    if (titleLower.includes('1080p')) return '1080p';
    if (titleLower.includes('720p')) return '720p';
    if (titleLower.includes('480p')) return '480p';
    return 'SD';
}

async function getTitleFromIMDb(imdbId) {
    try {
        const res = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 5000
        });
        const $ = cheerio.load(res.data);
        const titleRaw = $('title').text().split(' - ')[0].trim();
        const title = decode(titleRaw);
        const ldJson = $('script[type="application/ld+json"]').html();
        let originalTitle = title;
        if (ldJson) {
            try {
                const json = JSON.parse(ldJson);
                if (json && json.name) originalTitle = decode(json.name.trim());
            } catch (e) {}
        }
        console.log(`[DEBUG] 🌝 Lokalizovaný názov: ${title}`);
        console.log(`[DEBUG] 🇳️ Originálny názov: ${originalTitle}`);
        return { title, originalTitle };
    } catch (err) {
        console.error("[ERROR] IMDb scraping zlyhal:", err.message);
        return null;
    }
}

// PŮVODNÍ searchTorrents funkce (nezměněno)
async function searchTorrents(query) {
    console.log(`[INFO] 🔎 Hľadám '${query}' na SKTorrent...`);
    try {
        const session = axios.create({
            headers: { Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}` },
            timeout: 10000
        });
        const res = await session.get(SEARCH_URL, { params: { search: query, category: 0 } });
        const $ = cheerio.load(res.data);
        const posters = $('a[href^="details.php"] img');
        const results = [];

        posters.each((i, img) => {
            const parent = $(img).closest("a");
            const outerTd = parent.closest("td");
            const fullBlock = outerTd.text().replace(/\s+/g, ' ').trim();
            const href = parent.attr("href") || "";
            const tooltip = parent.attr("title") || ""; // PŮVODNÍ - používá tooltip
            const torrentId = href.split("id=").pop();
            const category = outerTd.find("b").first().text().trim();
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);
            const size = sizeMatch ? sizeMatch[1].trim() : "?";
            const seeds = seedMatch ? seedMatch[1] : "0";
            if (!category.toLowerCase().includes("film") && !category.toLowerCase().includes("seri")) return;
            results.push({
                name: tooltip, // PŮVODNÍ - používá tooltip
                id: torrentId,
                size,
                seeds,
                category,
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });
        console.log(`[INFO] 📦 Nájdených torrentov: ${results.length}`);
        return results;
    } catch (err) {
        console.error("[ERROR] Vyhľadávanie zlyhalo:", err.message);
        return [];
    }
}

async function getInfoHashFromTorrent(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}`,
                Referer: BASE_URL
            },
            timeout: 15000
        });
        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        const infoHash = crypto.createHash("sha1").update(info).digest("hex");
        return infoHash;
    } catch (err) {
        console.error("[ERROR] ⛔️ Chyba pri spracovaní .torrent:", err.message);
        return null;
    }
}

// PŮVODNÍ toStream funkce s původním parserem - SPRÁVNĚ s kategorií vlevo
async function toStream(t) {
    if (isMultiSeason(t.name)) {
        console.log(`[DEBUG] ❌ Preskakujem multi-season balík: '${t.name}'`);
        return null;
    }
    const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
    const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
    const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

    // PŮVODNÍ PARSER - přesně podle původního kódu
    let cleanedTitle = t.name.replace(/^Stiahni si\s*/i, "").trim();
    const categoryPrefix = t.category.trim().toLowerCase();
    if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) {
        cleanedTitle = cleanedTitle.slice(t.category.length).trim();
    }

    console.log(`[TORRENT PARSER] "${t.name}" + "${t.category}" → "${cleanedTitle}"`);

    const infoHash = await getInfoHashFromTorrent(t.downloadUrl);
    if (!infoHash) return null;

    return {
        name: `SKTorrent\n${t.category}`, // <- KATEGORIE VLEVO
        title: `${cleanedTitle}\n👤 ${t.seeds}  📀 ${t.size}  🩲 sktorrent.eu${flagsText}`, // <- ČISTÝ NÁZEV VPRAVO
        behaviorHints: { bingeGroup: cleanedTitle },
        infoHash
    };
}

// Globální proměnné
let addonBaseUrl = 'http://localhost:7000';
const sessionKeys = new Map(); // Map pro ukládání API klíčů podle IP

builder.defineStreamHandler(async (args) => {
    const { type, id } = args;
    console.log(`\n====== 🎮 RAW Požiadavka: type='${type}', id='${id}' ======`);

    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    console.log(`====== 🎮 STREAM Požiadavka pre typ='${type}' imdbId='${imdbId}' season='${season}' episode='${episode}' ======`);

    const titles = await getTitleFromIMDb(imdbId);
    if (!titles) return { streams: [] };

    const { title, originalTitle } = titles;
    const queries = new Set();
    const baseTitles = [title, originalTitle].map(t => t.replace(/\(.*?\)/g, '').replace(/TV (Mini )?Series/gi, '').trim());

    baseTitles.forEach(base => {
        const noDia = removeDiacritics(base);
        const short = shortenTitle(noDia);

        if (type === 'series' && season && episode) {
            const epTag = ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            [base, noDia, short].forEach(b => {
                queries.add(b + epTag);
                queries.add((b + epTag).replace(/[\':]/g, ''));
                queries.add((b + epTag).replace(/[\':]/g, '').replace(/\s+/g, '.'));
            });
        } else {
            [base, noDia, short].forEach(b => {
                queries.add(b);
                queries.add(b.replace(/[\':]/g, ''));
                queries.add(b.replace(/[\':]/g, '').replace(/\s+/g, '.'));
            });
        }
    });

    let torrents = [];
    let attempt = 1;
    for (const q of queries) {
        console.log(`[DEBUG] 🔍 Pokus ${attempt++}: Hľadám '${q}'`);
        torrents = await searchTorrents(q);
        if (torrents.length > 0) break;
    }

    if (torrents.length === 0) {
        console.log(`[INFO] ❌ Žiadne torrenty nenájdené`);
        return { streams: [] };
    }

    const streams = [];

    // ============= PODMÍNĚNÉ ZOBRAZOVÁNÍ STREAMŮ PODLE STREAM_MODE =============
    console.log(`🎮 Stream mode: ${STREAM_MODE} - generating appropriate streams...`);

    // OPRAVENÉ Real-Debrid streamy s kategorií vlevo
    if (rd && (STREAM_MODE === "RD_ONLY" || STREAM_MODE === "BOTH")) {
        console.log('🚀 Preparing RD streams for user selection...');

        const apiKeyFromArgs = args.extra && args.extra.api_key ? args.extra.api_key : null;
        const allStoredKeys = Array.from(sessionKeys.values());
        const fallbackApiKey = allStoredKeys.length > 0 ? allStoredKeys[0] : null;
        const availableApiKey = apiKeyFromArgs || fallbackApiKey;

        console.log(`🔑 Available API key for process URLs: ${availableApiKey ? availableApiKey.substring(0, 8) + '...' : 'NONE'}`);

        for (const torrent of torrents.slice(0, 5)) {
            const infoHash = await getInfoHashFromTorrent(torrent.downloadUrl);
            if (!infoHash) continue;

            const processUrl = availableApiKey
                ? `${addonBaseUrl}/process/${infoHash}?api_key=${availableApiKey}`
                : `${addonBaseUrl}/process/${infoHash}`;

            // PŘESNĚ STEJNÝ PARSER JAKO V toStream()
            let cleanedTitle = torrent.name.replace(/^Stiahni si\s*/i, "").trim();
            const categoryPrefix = torrent.category.trim().toLowerCase();
            if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) {
                cleanedTitle = cleanedTitle.slice(torrent.category.length).trim();
            }

            console.log(`🔗 Generated process URL: ${processUrl.replace(availableApiKey || '', '***')}`);
            console.log(`[RD PARSER] "${torrent.name}" + "${torrent.category}" → "${cleanedTitle}"`);

            streams.push({
                name: `RealDebrid\n${torrent.category}`, // <- Zkusit použít stejný formát jako SKTorrent
                title: `${cleanedTitle}\n👤 ${torrent.seeds}  📀 ${torrent.size}  🔥 Click to process via RD`,
                url: processUrl,
                behaviorHints: {
                    bingeGroup: 'real-debrid-lazy'
                }
            });

        }
    }

    // Torrent streamy (pokud je povolen) - už správně implementováno v toStream()
    if (STREAM_MODE === "TORRENT_ONLY" || STREAM_MODE === "BOTH") {
        console.log('🎬 Generating torrent streams...');
        const originalStreams = (await Promise.all(torrents.map(toStream))).filter(Boolean);
        streams.push(...originalStreams);
    }

    // Pokud je RD_ONLY mode a RD není dostupný, přidat torrent streamy jako fallback
    if (STREAM_MODE === "RD_ONLY" && !rd) {
        console.log('⚠️ RD_ONLY mode but Real-Debrid not available - adding torrent fallback');
        const fallbackStreams = (await Promise.all(torrents.map(toStream))).filter(Boolean);
        streams.push(...fallbackStreams);
    }

    console.log(`[INFO] ✅ Odosielam ${streams.length} streamov do Stremio (Mode: ${STREAM_MODE})`);
    return { streams };
});

builder.defineCatalogHandler(({ type, id }) => {
    console.log(`[DEBUG] 📚 Katalóg požiadavka pre typ='${type}' id='${id}'`);
    return { metas: [] };
});

// ============= EXPRESS SERVER S PŘÍSNOU API KLÍČ AUTENTIFIKACÍ =============
const app = express();
const rdProcessor = new RealDebridAPI(process.env.REALDEBRID_API_KEY);

// OPRAVENÝ middleware pro přísnou API klíč autentifikaci
app.use((req, res, next) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

    // Aktualizovat base URL
    if (req.get('host') && req.get('x-forwarded-proto')) {
        addonBaseUrl = `${req.get('x-forwarded-proto')}://${req.get('host')}`;
    } else if (req.get('host')) {
        addonBaseUrl = `${req.protocol}://${req.get('host')}`;
    }

    console.log(`🔗 HTTP Request: ${req.method} ${req.url} - ${new Date().toISOString()}`);

    // Pokud není nastaven API klíč, povolit vše (development mode)
    if (!ADDON_API_KEY) {
        console.log('⚠️ No API key configured - allowing unrestricted access (DEVELOPMENT MODE)');
        return next();
    }

    console.log(`🔐 API key required for all requests`);

    // Povolit pouze root path bez API klíče (pro zobrazení info stránky)
    if (req.path === '/' && !req.query.api_key) {
        console.log('ℹ️ Allowing root info page without API key');
        return next();
    }

    // Získání API klíče z query nebo session storage
    const apiKey = req.query.api_key || sessionKeys.get(clientIp);

    if (!apiKey) {
        console.log(`🚫 No API key provided from ${clientIp} for ${req.path}`);
        return res.status(401).json({
            error: 'Unauthorized - API key required',
            message: 'Add ?api_key=YOUR_KEY to all requests',
            path: req.path
        });
    }

    if (apiKey !== ADDON_API_KEY) {
        console.log(`🚫 Invalid API key from ${clientIp}: ${apiKey.substring(0, 8)}... for ${req.path}`);
        return res.status(401).json({
            error: 'Unauthorized - Invalid API key',
            message: 'Provided API key is not valid'
        });
    }

    console.log(`✅ API key authentication successful for ${clientIp} - ${req.path}`);

    // VYLEPŠENÉ: Ukládat API klíč do session při každém úspěšném requestu
    if (req.query.api_key) {
        sessionKeys.set(clientIp, req.query.api_key);
        console.log(`🔑 API key stored for ${clientIp}: ${req.query.api_key.substring(0, 8)}...`);
    }

    next();
});

// Root route - informační stránka s bezpečnostními informacemi
app.get('/', (req, res) => {
    const hasApiKey = req.query.api_key === ADDON_API_KEY;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>SKTorrent Hybrid Addon (Private)</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                    max-width: 900px;
                    margin: 0 auto;
                    padding: 20px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: #333;
                    min-height: 100vh;
                }
                .container {
                    background: white;
                    border-radius: 15px;
                    padding: 40px;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                }
                h1 {
                    color: #4a5568;
                    text-align: center;
                    margin-bottom: 10px;
                    font-size: 2.5em;
                }
                .subtitle {
                    text-align: center;
                    color: #718096;
                    font-size: 1.2em;
                    margin-bottom: 40px;
                }
                .auth-section {
                    background: ${hasApiKey ? '#f0fff4' : '#fffaf0'};
                    border: 2px solid ${hasApiKey ? '#48bb78' : '#f56565'};
                    border-radius: 10px;
                    padding: 30px;
                    margin: 30px 0;
                    text-align: center;
                }
                .install-section {
                    background: #f7fafc;
                    border: 2px solid #e2e8f0;
                    border-radius: 10px;
                    padding: 30px;
                    margin: 30px 0;
                    text-align: center;
                }
                .install-button {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 15px 30px;
                    text-decoration: none;
                    border-radius: 25px;
                    display: inline-block;
                    margin: 15px 10px;
                    font-weight: bold;
                    font-size: 1.1em;
                    transition: transform 0.2s;
                }
                .install-button:hover {
                    transform: translateY(-2px);
                }
                .install-button:disabled {
                    background: #ccc;
                    cursor: not-allowed;
                }
                code {
                    background: #2d3748;
                    color: #68d391;
                    padding: 8px 12px;
                    border-radius: 5px;
                    font-family: 'Monaco', 'Consolas', monospace;
                    word-break: break-all;
                    display: inline-block;
                    margin: 10px 0;
                }
                .warning {
                    background: #fed7d7;
                    border: 1px solid #fc8181;
                    border-radius: 5px;
                    padding: 15px;
                    margin: 20px 0;
                    color: #9b2c2c;
                }
                .error {
                    background: #fed7d7;
                    border: 2px solid #fc8181;
                    border-radius: 5px;
                    padding: 20px;
                    margin: 20px 0;
                    color: #9b2c2c;
                    font-weight: bold;
                }
                .success {
                    background: #c6f6d5;
                    border: 1px solid #68d391;
                    border-radius: 5px;
                    padding: 15px;
                    margin: 20px 0;
                    color: #276749;
                }
                .status-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    margin: 30px 0;
                }
                .status-card {
                    background: #f7fafc;
                    border-radius: 10px;
                    padding: 20px;
                    text-align: center;
                    border: 2px solid #e2e8f0;
                }
                .status-active { border-color: #48bb78; background: #f0fff4; }
                .status-inactive { border-color: #f56565; background: #fffaf0; }
                .status-warning { border-color: #ed8936; background: #fffbeb; }
                .emoji { font-size: 1.5em; margin-right: 10px; }
                hr { border: none; height: 2px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 40px 0; }
                .footer {
                    text-align: center;
                    color: #718096;
                    margin-top: 40px;
                    padding-top: 20px;
                    border-top: 1px solid #e2e8f0;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔐 SKTorrent Hybrid Addon (Private)</h1>
                <p class="subtitle">Fixed Categories + Real-Debrid + API security - Mode: ${STREAM_MODE}</p>

                <div class="auth-section">
                    <h2>${hasApiKey ? '✅ Authenticated Access' : '🔒 Authentication Required'}</h2>
                    ${hasApiKey ?
                        '<div class="success">✅ API klíč je platný - máte autentifikovaný přístup</div>' :
                        ADDON_API_KEY ?
                        '<div class="error">🚫 API klíč je vyžadován pro všechny funkce addonu. Bez platného API klíče nemáte přístup.</div>' :
                        '<div class="warning">⚠️ Addon běží v DEVELOPMENT módu - žádné zabezpečení není aktivní</div>'
                    }
                </div>

                <div class="install-section">
                    <h2>📥 Instalace do Stremio</h2>
                    ${ADDON_API_KEY ? `
                        ${!hasApiKey ? `
                            <div class="error">
                                <h3>🔑 API klíč je povinný!</h3>
                                <p>Tento addon vyžaduje platný API klíč pro všechny operace včetně instalace.</p>
                                <p><strong>Bez API klíče addon nebude fungovat!</strong></p>
                            </div>
                        ` : ''}

                        <p><strong>URL pro instalaci s API klíčem:</strong></p>
                        <code>${req.protocol}://${req.get('host')}/manifest.json?api_key=YOUR_API_KEY</code>
                        <br><br>
                        <p><strong>⚠️ Důležité:</strong> Nahraďte "YOUR_API_KEY" vaším skutečným API klíčem</p>

                        ${hasApiKey ? `
                            <br>
                            <a href="/manifest.json?api_key=${req.query.api_key}" class="install-button">📋 Otevřit Manifest</a>
                            <a href="stremio://${req.get('host')}/manifest.json?api_key=${req.query.api_key}" class="install-button">⚡ Instalovat do Stremio</a>
                        ` : `
                            <br>
                            <button class="install-button" disabled>🔒 Instalace vyžaduje API klíč</button>
                        `}
                    ` : `
                        <div class="warning">
                            <strong>DEVELOPMENT MODE</strong><br>
                            API klíč není nakonfigurován. Addon je dostupný všem.
                        </div>
                        <code>${req.protocol}://${req.get('host')}/manifest.json</code>
                        <br><br>
                        <a href="/manifest.json" class="install-button">📋 Otevřit Manifest</a>
                    `}
                </div>

                <h2>🔧 Stav konfigurace</h2>
                <div class="status-grid">
                    <div class="status-card ${ADDON_API_KEY ? 'status-active' : 'status-inactive'}">
                        <div class="emoji">${ADDON_API_KEY ? '🔐' : '⚠️'}</div>
                        <h3>API Key Security</h3>
                        <p>${ADDON_API_KEY ? 'Aktivní - addon je chráněný' : 'NENÍ NAKONFIGUROVÁNO - nezabezpečeno!'}</p>
                    </div>
                    <div class="status-card ${rd ? 'status-active' : 'status-inactive'}">
                        <div class="emoji">${rd ? '✅' : '❌'}</div>
                        <h3>Real-Debrid</h3>
                        <p>${rd ? 'Aktivní a připraveno' : 'Není nakonfigurováno'}</p>
                    </div>
                    <div class="status-card ${SKT_UID ? 'status-active' : 'status-inactive'}">
                        <div class="emoji">${SKT_UID ? '✅' : '❌'}</div>
                        <h3>Sktorrent.eu</h3>
                        <p>${SKT_UID ? 'Přihlášení je aktivní' : 'Chybí přihlašovací údaje'}</p>
                    </div>
                    <div class="status-card ${STREAM_MODE === 'RD_ONLY' ? 'status-active' : STREAM_MODE === 'BOTH' ? 'status-warning' : 'status-inactive'}">
                        <div class="emoji">${STREAM_MODE === 'RD_ONLY' ? '⚡' : STREAM_MODE === 'BOTH' ? '🔄' : '🎬'}</div>
                        <h3>Stream Mode</h3>
                        <p>${STREAM_MODE === 'RD_ONLY' ? 'Pouze Real-Debrid (s fallback)' :
                             STREAM_MODE === 'BOTH' ? 'RD + Torrent streamy' :
                             'Pouze Torrent streamy'}</p>
                    </div>
                </div>

                <hr>

                <div class="footer">
                    <p><strong>Powered by:</strong> Fixed Categories Layout + Real-Debrid API + Security</p>
                    <p><small>Private addon - pouze pro autorizované uživatele</small></p>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Custom endpoint pro RD processing s debug informacemi a automatickým fallbackem
app.get('/process/:infoHash', async (req, res) => {
    const { infoHash } = req.params;
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

    try {
        console.log(`🚀 User selected RD processing for: ${infoHash}`);
        console.log(`🔑 Process endpoint - API key from query: ${req.query.api_key ? req.query.api_key.substring(0, 8) + '...' : 'NONE'}`);
        console.log(`🔑 Process endpoint - API key from session: ${sessionKeys.get(clientIp) ? sessionKeys.get(clientIp).substring(0, 8) + '...' : 'NONE'}`);

        // Přidat do RD a čekat
        const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
        const rdLinks = await rdProcessor.addMagnetAndWait(magnetLink, 2);

        if (rdLinks && rdLinks.length > 0) {
            console.log('✅ RD download completed - using direct link');
            return res.redirect(302, rdLinks[0].url);
        }

        // Automatický fallback na magnet (pro RD_ONLY mode)
        console.log('⚠️ RD failed - redirecting to magnet (automatic fallback)');
        res.redirect(302, magnetLink);

    } catch (error) {
        console.error(`❌ RD processing failed: ${error.message}`);
        res.redirect(302, `magnet:?xt=urn:btih:${infoHash}`);
    }
});

// Převést addon na Express router a použít
const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

// Spustit server
app.listen(7000, () => {
    console.log('🚀 SKTorrent Hybrid addon běží na http://localhost:7000/manifest.json');
    console.log('🔧 RD Processor endpoint: /process/{infoHash}');
    console.log(`🔧 Mode: ${rd ? 'Hybrid (RD + Torrent)' : 'Torrent Only'}`);
    console.log(`🎮 Stream Mode: ${STREAM_MODE}`);
    console.log(`🔐 Security: ${ADDON_API_KEY ? 'API Key Protected' : 'UNSECURED - No API key set'}`);
    console.log('✅ Categories positioned correctly (left side for both RD and torrent streams)');
});
