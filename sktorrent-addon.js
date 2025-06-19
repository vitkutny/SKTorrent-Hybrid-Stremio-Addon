// SKTorrent Stremio doplněk s duálním stream zobrazením (RD + Torrent)
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

// Proměnná pro řízení zobrazování streamů
const STREAM_MODE = process.env.STREAM_MODE || "BOTH"; // RD_ONLY, BOTH, TORRENT_ONLY

// Inicializace Real-Debrid API
const rd = process.env.REALDEBRID_API_KEY ?
  new RealDebridAPI(process.env.REALDEBRID_API_KEY) : null;

if (rd) {
  console.log('🔧 Režim Real-Debrid hybrid aktivován');
} else {
  console.log('🔧 Režim pouze torrent (nastavte REALDEBRID_API_KEY pro hybrid)');
}

if (ADDON_API_KEY) {
  console.log('🔐 Autentizace pomocí API klíče aktivována');
} else {
  console.log('⚠️ Varování: API klíč není nastaven - doplněk je přístupný všem');
}

console.log(`🎮 Režim streamování: ${STREAM_MODE}`);

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = addonBuilder({
    id: "org.stremio.sktorrent.hybrid.dual",
    version: "2.0.0",
    name: "SKTorrent Hybrid",
    description: "Soukromý Real-Debrid + Torrent doplněk s ochranou API klíčem",
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

// Funkce pro odstranění diakritiky z textu
function removeDiacritics(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Funkce pro zkrácení názvu na určitý počet slov
function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

// Funkce pro detekci multi-season balíku
function isMultiSeason(title) {
    return /(S\d{2}E\d{2}-\d{2}|Complete|All Episodes|Season \d+(-\d+)?)/i.test(title);
}

// Funkce pro extrakci kvality z názvu
function extractQuality(title) {
    const titleLower = title.toLowerCase();
    if (titleLower.includes('2160p') || titleLower.includes('4k')) return '4K';
    if (titleLower.includes('1080p')) return '1080p';
    if (titleLower.includes('720p')) return '720p';
    if (titleLower.includes('480p')) return '480p';
    return 'SD';
}

// Funkce pro získání názvu z IMDb
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
        console.log(`[DEBUG] 🌝 Lokalizovaný název: ${title}`);
        console.log(`[DEBUG] 🇳️ Originální název: ${originalTitle}`);
        return { title, originalTitle };
    } catch (err) {
        console.error("[ERROR] Chyba při získávání z IMDb:", err.message);
        return null;
    }
}

// Funkce pro vyhledávání torrentů na SKTorrent
async function searchTorrents(query) {
    console.log(`[INFO] 🔎 Hledám '${query}' na SKTorrent...`);
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
            const tooltip = parent.attr("title") || "";
            const torrentId = href.split("id=").pop();
            const category = outerTd.find("b").first().text().trim();
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);
            const size = sizeMatch ? sizeMatch[1].trim() : "?";
            const seeds = seedMatch ? seedMatch[1] : "0";
            if (!category.toLowerCase().includes("film") && !category.toLowerCase().includes("seri")) return;
            results.push({
                name: tooltip,
                id: torrentId,
                size,
                seeds,
                category,
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });
        console.log(`[INFO] 📦 Nalezeno torrentů: ${results.length}`);
        return results;
    } catch (err) {
        console.error("[ERROR] Vyhledávání selhalo:", err.message);
        return [];
    }
}

// Funkce pro získání kompletních informací z torrent souboru
async function getTorrentInfo(url) {
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

        return {
            infoHash,
            name: torrent.info.name ? torrent.info.name.toString() : ''
        };
    } catch (err) {
        console.error("[ERROR] Chyba při zpracování .torrent:", err.message);
        return null;
    }
}

// Globální proměnné
let addonBaseUrl = 'http://localhost:7000';
const sessionKeys = new Map();

// Cache a tracking pro RD optimalizaci
const activeProcessing = new Map(); // infoHash -> Promise
const rdCache = new Map(); // infoHash -> {timestamp, links, expiresAt}
const CACHE_DURATION = 10 * 60 * 1000; // 10 minut cache

// Definice stream handleru s duálním zobrazením
builder.defineStreamHandler(async (args) => {
    const { type, id } = args;
    console.log(`\n====== 🎮 RAW Požadavek: type='${type}', id='${id}' ======`);

    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    console.log(`====== 🎮 STREAM Požadavek pro typ='${type}' imdbId='${imdbId}' season='${season}' episode='${episode}' ======`);

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
        console.log(`[DEBUG] 🔍 Pokus ${attempt++}: Hledám '${q}'`);
        torrents = await searchTorrents(q);
        if (torrents.length > 0) break;
    }

    if (torrents.length === 0) {
        console.log(`[INFO] ❌ Žádné torrenty nenalezeny`);
        return { streams: [] };
    }

    const streams = [];
    console.log(`🎮 Režim streamování: ${STREAM_MODE} - generuji duální streamy...`);

    // Zpracování torrentů pro duální zobrazení
    const apiKeyFromArgs = args.extra && args.extra.api_key ? args.extra.api_key : null;
    const allStoredKeys = Array.from(sessionKeys.values());
    const fallbackApiKey = allStoredKeys.length > 0 ? allStoredKeys[0] : null;
    const availableApiKey = apiKeyFromArgs || fallbackApiKey;

    for (const torrent of torrents.slice(0, 5)) {
        const torrentInfo = await getTorrentInfo(torrent.downloadUrl);
        if (!torrentInfo) continue;

        // Společný parser pro názvy
        let cleanedTitle = torrent.name.replace(/^Stiahni si\s*/i, "").trim();
        const categoryPrefix = torrent.category.trim().toLowerCase();
        if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) {
            cleanedTitle = cleanedTitle.slice(torrent.category.length).trim();
        }

        const langMatches = torrent.name.match(/\b([A-Z]{2})\b/g) || [];
        const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
        const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

        // 1. Real-Debrid stream (pokud je povolený)
        if (rd && (STREAM_MODE === "RD_ONLY" || STREAM_MODE === "BOTH")) {
            const processUrl = availableApiKey
                ? `${addonBaseUrl}/process/${torrentInfo.infoHash}?api_key=${availableApiKey}`
                : `${addonBaseUrl}/process/${torrentInfo.infoHash}`;

            streams.push({
                name: `⚡ Real-Debrid\n${torrent.category}`,
                title: `${cleanedTitle}\n👤 ${torrent.seeds}  📀 ${torrent.size}  🚀 Rychlé přehrání${flagsText}`,
                url: processUrl,
                behaviorHints: { bingeGroup: `rd-${cleanedTitle}` }
            });
        }

        // 2. Direct Torrent stream (pokud je povolený)
        if (STREAM_MODE === "TORRENT_ONLY" || STREAM_MODE === "BOTH") {
            streams.push({
                name: `🎬 Direct Torrent\n${torrent.category}`,
                title: `${cleanedTitle}\n👤 ${torrent.seeds}  📀 ${torrent.size}  💾 Přímé stahování${flagsText}`,
                infoHash: torrentInfo.infoHash,
                behaviorHints: { bingeGroup: `torrent-${cleanedTitle}` }
            });
        }
    }

    console.log(`[INFO] ✅ Odesílám ${streams.length} streamů do Stremio (Režim: ${STREAM_MODE})`);
    return { streams };
});

builder.defineCatalogHandler(({ type, id }) => {
    console.log(`[DEBUG] 📚 Požadavek na katalog pro typ='${type}' id='${id}'`);
    return { metas: [] };
});

// Express server s API klíč autentifikací
const app = express();
app.set('trust proxy', true);
const rdProcessor = new RealDebridAPI(process.env.REALDEBRID_API_KEY);

// Middleware pro API klíč management
app.use((req, res, next) => {
    // ✅ OPRAVENO: Správné získání IP adresy přes proxy
    const clientIp = req.ip || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';

    // Pokud je X-Forwarded-For seznam IP adres, vzít první (původní klient)
    const realClientIp = clientIp.includes(',') ? clientIp.split(',')[0].trim() : clientIp;

    // Aktualizace base URL
    if (req.get('host') && req.get('x-forwarded-proto')) {
        addonBaseUrl = `${req.get('x-forwarded-proto')}://${req.get('host')}`;
    } else if (req.get('host')) {
        addonBaseUrl = `${req.protocol}://${req.get('host')}`;
    }

    console.log(`🔗 HTTP požadavek: ${req.method} ${req.url} - ${new Date().toISOString()}`);
    console.log(`🌐 Návštěvník IP: ${realClientIp}`); // ✅ NOVÉ: Log skutečné IP

    // Pokud není nastaven API klíč, povolit vše (vývojový režim)
    if (!ADDON_API_KEY) {
        console.log('⚠️ API klíč není nastaven - povolen neomezený přístup (vývojový režim)');
        return next();
    }

    console.log('🔐 API klíč je vyžadován pro všechny požadavky');

    // Povolit pouze úvodní stránku bez API klíče
    if (req.path === '/' && !req.query.api_key) {
        console.log('ℹ️ Povolen přístup na úvodní stránku bez API klíče');
        return next();
    }

    // Získání API klíče z query nebo session (používat skutečnou IP)
    const apiKey = req.query.api_key || sessionKeys.get(realClientIp);

    if (!apiKey) {
        console.log(`🚫 Žádný API klíč od ${realClientIp} pro ${req.path}`);
        return res.status(401).json({
            error: 'Neautorizovaný přístup - API klíč je vyžadován',
            message: 'Přidejte ?api_key=VÁŠ_KLÍČ ke všem požadavkům',
            path: req.path,
            clientIp: realClientIp // ✅ NOVÉ: Ukázat IP v odpovědi
        });
    }

    if (apiKey !== ADDON_API_KEY) {
        console.log(`🚫 Neplatný API klíč od ${realClientIp}: ${apiKey.substring(0, 8)}... pro ${req.path}`);
        return res.status(401).json({
            error: 'Neautorizovaný přístup - neplatný API klíč',
            message: 'Poskytnutý API klíč není platný',
            clientIp: realClientIp
        });
    }

    console.log(`✅ Autentizace API klíče úspěšná pro ${realClientIp} - ${req.path}`);

    // Uložení API klíče do session (používat skutečnou IP)
    if (req.query.api_key) {
        sessionKeys.set(realClientIp, req.query.api_key);
        console.log(`🔑 API klíč uložen pro ${realClientIp}: ${req.query.api_key.substring(0, 8)}...`);
    }

    next();
});

// Úvodní stránka
app.get('/', (req, res) => {
    const hasApiKey = req.query.api_key === ADDON_API_KEY;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>SKTorrent Hybrid Addon (Soukromý)</title>
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
                .feature-highlight {
                    background: #e6fffa;
                    border: 2px solid #38b2ac;
                    border-radius: 10px;
                    padding: 20px;
                    margin: 20px 0;
                    text-align: center;
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
                <h1>🔐 SKTorrent Hybrid Addon</h1>
                <p class="subtitle">Duální zobrazení streamů - Real-Debrid + Torrent současně</p>

                <div class="feature-highlight">
                    <h3>🎯 Nová funkcionalita: Duální streamy</h3>
                    <p>✅ Zobrazuje Real-Debrid i Torrent streamy současně<br>
                    ✅ Žádné čekání na timeout - okamžitý výběr<br>
                    ✅ Uživatel si vybere preferovanou metodu</p>
                </div>

                <div class="auth-section">
                    <h2>${hasApiKey ? '✅ Autentizovaný přístup' : '🔒 Vyžadována autentizace'}</h2>
                    ${hasApiKey ?
                        '<div class="success">✅ API klíč je platný - máte přístup</div>' :
                        ADDON_API_KEY ?
                        '<div class="error">🚫 API klíč je vyžadován pro všechny funkce. Bez platného klíče není přístup.</div>' :
                        '<div class="warning">⚠️ Doplněk běží v režimu vývoje - bez zabezpečení</div>'
                    }
                </div>

                <div class="install-section">
                    <h2>📥 Instalace do Stremio</h2>
                    ${ADDON_API_KEY ? `
                        ${!hasApiKey ? `
                            <div class="error">
                                <h3>🔑 API klíč je povinný!</h3>
                                <p>Doplněk vyžaduje platný API klíč pro všechny operace včetně instalace.</p>
                                <p><strong>Bez API klíče doplněk nebude fungovat!</strong></p>
                            </div>
                        ` : ''}

                        <p><strong>URL pro instalaci s API klíčem:</strong></p>
                        <code>${req.protocol}://${req.get('host')}/manifest.json?api_key=VÁŠ_KLÍČ</code>
                        <br><br>
                        <p><strong>⚠️ Důležité:</strong> Nahraďte "VÁŠ_KLÍČ" vaším skutečným API klíčem</p>

                        ${hasApiKey ? `
                            <br>
                            <a href="/manifest.json?api_key=${req.query.api_key}" class="install-button">📋 Otevřít manifest</a>
                            <a href="stremio://${req.get('host')}/manifest.json?api_key=${req.query.api_key}" class="install-button">⚡ Instalovat do Stremio</a>
                        ` : `
                            <br>
                            <button class="install-button" disabled>🔒 Instalace vyžaduje API klíč</button>
                        `}
                    ` : `
                        <div class="warning">
                            <strong>REŽIM VÝVOJE</strong><br>
                            API klíč není nastaven. Doplněk je přístupný všem.
                        </div>
                        <code>${req.protocol}://${req.get('host')}/manifest.json</code>
                        <br><br>
                        <a href="/manifest.json" class="install-button">📋 Otevřít manifest</a>
                    `}
                </div>

                <h2>🔧 Stav konfigurace</h2>
                <div class="status-grid">
                    <div class="status-card ${ADDON_API_KEY ? 'status-active' : 'status-inactive'}">
                        <div class="emoji">${ADDON_API_KEY ? '🔐' : '⚠️'}</div>
                        <h3>API Key Security</h3>
                        <p>${ADDON_API_KEY ? 'Aktivní - doplněk je chráněný' : 'NENÍ NASTAVENO - nezabezpečeno!'}</p>
                    </div>
                    <div class="status-card ${rd ? 'status-active' : 'status-inactive'}">
                        <div class="emoji">${rd ? '✅' : '❌'}</div>
                        <h3>Real-Debrid</h3>
                        <p>${rd ? 'Aktivní a připraveno' : 'Není nakonfigurováno'}</p>
                    </div>
                    <div class="status-card ${SKT_UID ? 'status-active' : 'status-inactive'}">
                        <div class="emoji">${SKT_UID ? '✅' : '❌'}</div>
                        <h3>SKTorrent.eu</h3>
                        <p>${SKT_UID ? 'Přihlášení aktivní' : 'Chybí přihlašovací údaje'}</p>
                    </div>
                    <div class="status-card status-active">
                        <div class="emoji">🎭</div>
                        <h3>Duální zobrazení</h3>
                        <p>Aktivní - RD + Torrent současně</p>
                    </div>
                </div>

                <hr>

                <div class="footer">
                    <p><strong>Powered by:</strong> Duální stream zobrazení + Real-Debrid API + Zabezpečení</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Optimalizovaný endpoint pro Real-Debrid zpracování s cache a prevencí duplicit
app.get('/process/:infoHash', async (req, res) => {
    const { infoHash } = req.params;
    const now = Date.now();

    try {
        console.log(`🚀 Real-Debrid požadavek pro: ${infoHash}`);

        // 1. Kontrola lokální cache
        const cached = rdCache.get(infoHash);
        if (cached && cached.expiresAt > now && cached.links) {
            console.log(`🎯 Lokální cache HIT pro ${infoHash}`);
            return res.redirect(302, cached.links[0].url);
        }

        // 2. Kontrola aktivního zpracování
        if (activeProcessing.has(infoHash)) {
            console.log(`⏳ Čekám na aktivní zpracování pro ${infoHash}`);
            try {
                const result = await activeProcessing.get(infoHash);
                if (result && result.length > 0) {
                    console.log(`✅ Aktivní zpracování dokončeno pro ${infoHash}`);
                    return res.redirect(302, result[0].url);
                }
            } catch (error) {
                console.log(`❌ Aktivní zpracování selhalo: ${error.message}`);
                activeProcessing.delete(infoHash);
            }
        }

        // 3. Inteligentní zpracování s kontrolou existence v RD
        const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;

        const processingPromise = rdProcessor.addMagnetIfNotExists(magnetLink, infoHash, 2);
        activeProcessing.set(infoHash, processingPromise);

        try {
            const rdLinks = await processingPromise;
            activeProcessing.delete(infoHash);

            if (rdLinks && rdLinks.length > 0) {
                // Uložit do cache
                rdCache.set(infoHash, {
                    timestamp: now,
                    links: rdLinks,
                    expiresAt: now + CACHE_DURATION
                });

                console.log(`✅ RD zpracování úspěšné pro ${infoHash}`);
                return res.redirect(302, rdLinks[0].url);
            }
        } catch (error) {
            activeProcessing.delete(infoHash);
            console.error(`❌ RD zpracování selhalo: ${error.message}`);
        }

        console.log(`⚠️ Real-Debrid zpracování se nezdařilo pro ${infoHash}`);
        return res.status(503).json({
            error: 'Real-Debrid zpracování se nezdařilo',
            message: 'Zkuste Direct Torrent stream'
        });

    } catch (error) {
        activeProcessing.delete(infoHash);
        console.error(`❌ Chyba Real-Debrid zpracování: ${error.message}`);
        return res.status(503).json({
            error: 'Chyba Real-Debrid serveru',
            message: 'Zkuste Direct Torrent stream'
        });
    }
});

// Cleanup rutina pro čištění cache a aktivních zpracování
setInterval(() => {
    const now = Date.now();

    // Vyčistit expirovanou cache
    for (const [infoHash, cached] of rdCache.entries()) {
        if (cached.expiresAt <= now) {
            rdCache.delete(infoHash);
            console.log(`🧹 Vyčištěn expirovaný cache pro ${infoHash}`);
        }
    }

    // Vyčistit staré zpracování (starší než 5 minut)
    const oldProcessingLimit = now - (5 * 60 * 1000);
    for (const [infoHash] of activeProcessing.entries()) {
        activeProcessing.delete(infoHash);
        console.log(`🧹 Vyčištěno dlouho běžící zpracování pro ${infoHash}`);
    }
}, 60000); // Každou minutu

// Převod addon na Express router
const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

// Spuštění serveru
app.listen(7000, () => {
    console.log('🚀 SKTorrent Hybrid doplněk běží na http://localhost:7000/manifest.json');
    console.log('🔧 RD Processor endpoint: /process/{infoHash}');
    console.log(`🔧 Režim: ${rd ? 'Dual (RD + Torrent)' : 'Pouze Torrent'}`);
    console.log(`🎮 Režim streamování: ${STREAM_MODE}`);
    console.log(`🔐 Zabezpečení: ${ADDON_API_KEY ? 'Chráněno API klíčem' : 'NEZABEZPEČENO - API klíč není nastaven'}`);
});
