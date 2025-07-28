// SKTorrent-Hybrid - modularizovaná verze v1.0.0
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const asyncHandler = require("express-async-handler");
const https = require("https");
const http = require("http");
const axios = require('axios');
const config = require('./config');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getBaseUrl } = require('./base-url-manager');
const parseTorrent = require('parse-torrent');

// Vždy používej baseUrl z EXTERNAL_DOMAIN
const baseUrl = getBaseUrl();

const rdApiKey = process.env.REALDEBRID_API_KEY || null;
const rd = rdApiKey ? require('./realdebrid') : null;
const authManager = require('./auth')();
const StreamingManager = require('./streaming');
const torrentSearch = require('./torrent-search');
const TemplateManager = require('./templates');
const Utils = require('./utils');

// Klient pro HTTP požadavky s poolingem
const apiClient = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 10 }),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});

const streamingManager = new StreamingManager(apiClient);
const { getRealDebridStreamUrl } = streamingManager;

// ✅ NOVÁ CACHE pro propojení infoHash s původními torrent daty
class TorrentDataCache {
    constructor(maxSize = 1000) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }
    
    set(infoHash, torrentData) {
        if (this.cache.has(infoHash)) this.cache.delete(infoHash);
        this.cache.set(infoHash, {
            ...torrentData,
            cached: Date.now(),
            expires: Date.now() + (30 * 60 * 1000) // 30 minut
        });
        
        // Cleanup old entries
        if (this.cache.size > this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
    }
    
    get(infoHash) {
        const entry = this.cache.get(infoHash);
        if (!entry) return null;
        
        if (entry.expires < Date.now()) {
            this.cache.delete(infoHash);
            return null;
        }
        
        // Move to end (LRU)
        this.cache.delete(infoHash);
        this.cache.set(infoHash, entry);
        return entry;
    }
    
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, entry] of this.cache.entries()) {
            if (entry.expires <= now) {
                this.cache.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`🧹 TorrentDataCache cleanup: ${cleaned} entries`);
        }
    }
}

const torrentDataCache = new TorrentDataCache();

// Inicializace a výpis základních informací
console.log(`🔧 Inicializace: RD=${!!rd}, Auth=${!!config.ADDON_API_KEY}, Mode=${config.STREAM_MODE}`);

// Mapování jazykových kódů na vlajky
const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵"
};

// Pomocné funkce pro práci s torrent-search.js
const searchTorrents = (query) => torrentSearch.searchTorrents(apiClient, config, query);
const getTorrentInfo = (url) => torrentSearch.getTorrentInfo(apiClient, config, url);
const getTitleFromIMDb = (imdbId) => torrentSearch.getTitleFromIMDb(apiClient, imdbId);

// Definice addonu pro Stremio
const builder = addonBuilder({
    id: "org.stremio.sktorrent.hybrid.modular",
    version: "1.0.0",
    name: "SKTorrent-Hybrid",
    description: "SKTorrent-Hybrid - Modularizovaný Real-Debrid + Torrent addon s pokročilou bezpečností",
    types: ["movie", "series"],
    catalogs: [],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const app = express();
app.set('trust proxy', true);

// Bezpečné nastavení CORS
const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['https://stremio.com'];
app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

// Middleware pro základní hlavičky a rate limit
app.use(asyncHandler(async (req, res, next) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range, X-Session-ID',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
    });
    const clientIp = req.ip || req.headers['x-real-ip'] || 'unknown';
    if (!authManager.checkRateLimit(clientIp)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    next();
}));

// Middleware pro validaci infoHash
app.use('/process/:infoHash/:name', (req, res, next) => {
    if (!Utils.validateInfoHash(req.params.infoHash)) {
        return res.status(400).json({ error: 'Neplatný infoHash formát' });
    }
    next();
});

// Debug endpoint pro analýzu torrentu
app.get('/debug/:infoHash', async (req, res) => {
    const { infoHash } = req.params;
    try {
        console.log(`🔍 Debug request pro hash: ${infoHash}`);
        if (!Utils.validateInfoHash(infoHash)) {
            return res.status(400).json({ error: 'Neplatný infoHash formát' });
        }

        const torrentSearchManager = {
            searchTorrents: (query) => searchTorrents(query),
            getTorrentInfo: (url) => getTorrentInfo(url),
            getTitleFromIMDb: (imdbId) => getTitleFromIMDb(imdbId)
        };

        const debugResult = await streamingManager.debugTorrent(
            infoHash,
            torrentSearchManager,
            rd,
            rdApiKey,
            torrentDataCache
        );

        // HTML odpověď s výsledky analýzy
        const htmlResponse = `
<!DOCTYPE html>
<html>
<head>
    <title>🔍 Debug Torrent: ${infoHash}</title>
    <meta charset="utf-8">
    <style>
        body { font-family: monospace; max-width: 1200px; margin: 0 auto; padding: 20px; background: #1a1a1a; color: #00ff00; }
        .step { margin: 5px 0; padding: 5px; background: #2a2a2a; border-left: 3px solid #00ff00; }
        .error { border-left-color: #ff0000; color: #ff6666; }
        .success { border-left-color: #00ff00; color: #66ff66; }
        .info { border-left-color: #0066ff; color: #6666ff; }
        .details { background: #333; padding: 15px; margin: 10px 0; border-radius: 5px; }
        pre { overflow-x: auto; background: #444; padding: 10px; border-radius: 3px; }
    </style>
</head>
<body>
    <h1>🔍 DEBUG ANALÝZA TORRENTA</h1>
    <div class="details">
        <h2>📊 Základní info:</h2>
        <p><strong>InfoHash:</strong> ${debugResult.infoHash}</p>
        <p><strong>Čas analýzy:</strong> ${debugResult.timestamp}</p>
        <p><strong>Úspěch:</strong> ${debugResult.success ? '✅ ANO' : '❌ NE'}</p>
        ${debugResult.error ? `<p><strong>Chyba:</strong> <span style="color: #ff6666">${debugResult.error}</span></p>` : ''}
    </div>
    ${debugResult.torrentDetails ? `
    <div class="details">
        <h2>📦 Detaily torrenta:</h2>
        <pre>${JSON.stringify(debugResult.torrentDetails, null, 2)}</pre>
    </div>
    ` : ''}
    ${debugResult.magnetLink ? `
    <div class="details">
        <h2>🧲 Magnet Link:</h2>
        <p style="word-break: break-all; background: #444; padding: 10px;">${debugResult.magnetLink}</p>
    </div>
    ` : ''}
    ${debugResult.rdStatus ? `
    <div class="details">
        <h2>🔄 Real-Debrid Status:</h2>
        <pre>${JSON.stringify(debugResult.rdStatus, null, 2)}</pre>
    </div>
    ` : ''}
    ${debugResult.rdLinks ? `
    <div class="details">
        <h2>🔗 RD Links (prvních 3):</h2>
        <pre>${JSON.stringify(debugResult.rdLinks, null, 2)}</pre>
    </div>
    ` : ''}
    ${debugResult.cacheData ? `
    <div class="details">
        <h2>📋 Cache Data:</h2>
        <pre>${JSON.stringify(debugResult.cacheData, null, 2)}</pre>
    </div>
    ` : ''}
    ${debugResult.torrentDataSize ? `
    <div class="details">
        <h2>📦 Torrent File Size:</h2>
        <p>${debugResult.torrentDataSize} bytes</p>
    </div>
    ` : ''}
    <div class="details">
        <h2>📝 Kroky analýzy:</h2>
        ${debugResult.steps.map(step => {
            let className = 'step';
            if (step.includes('❌')) className += ' error';
            else if (step.includes('✅')) className += ' success';
            else if (step.includes('🔍') || step.includes('📊')) className += ' info';
            return `<div class="${className}">${step}</div>`;
        }).join('')}
    </div>
    <div class="details">
        <h2>🔧 Kompletní debug data:</h2>
        <pre>${JSON.stringify(debugResult, null, 2)}</pre>
    </div>
</body>
</html>`;
        res.send(htmlResponse);
    } catch (error) {
        console.error(`❌ Debug endpoint chyba: ${error.message}`);
        res.status(500).json({ error: 'Debug chyba', message: error.message });
    }
});

// Middleware pro timeout na /process/:infoHash/:name
app.use('/process/:infoHash/:name', (req, res, next) => {
    req.timeout = 30000;
    const timeoutHandler = setTimeout(() => {
        if (!res.headersSent) {
            console.log(`⏰ Timeout pro ${req.params.infoHash} - ukončuji požadavek`);
            res.status(408).send('Request Timeout');
            res.end();
        }
    }, req.timeout);
    res.on('finish', () => clearTimeout(timeoutHandler));
    res.on('close', () => clearTimeout(timeoutHandler));
    next();
});

// Middleware pro logování a autorizaci
app.use((req, res, next) => {
    const clientIp = req.ip || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const uniqueClientId = authManager.createUniqueClientId(clientIp, userAgent);

    console.log(`🔗 ${req.method} ${req.url} - ${uniqueClientId}`);

    // Povolit veřejný přístup na hlavní stránku a favicon
    if (req.path === '/' || req.path === '/favicon.ico') return next();

    if (!config.ADDON_API_KEY) {
        console.log('⚠️ Vývojový režim - bez API klíče');
        return next();
    }
    if (req.path.startsWith('/debug/')) {
        const hash = req.path.split('/debug/')[1];
        if (Utils.validateInfoHash(hash)) {
            console.log('🔍 Debug endpoint - přeskakuji auth');
            return next();
        }
    }
    const session = authManager.getSessionFromRequest(req);
    if (!session || session.apiKey !== config.ADDON_API_KEY) {
        console.log(`🚫 Neautorizovaný přístup od ${uniqueClientId}`);
        return res.status(401).json({
            error: 'Neautorizovaný přístup',
            message: 'API klíč je vyžadován'
        });
    }
    console.log(`✅ Autorizace úspěšná pro ${uniqueClientId}`);
    if (req.query.api_key) {
        if (authManager.setSessionKey) {
            authManager.setSessionKey(clientIp, req.query.api_key);
            authManager.setSessionKey(uniqueClientId, req.query.api_key);
        }
        const sessionId = authManager.createSession(req.query.api_key, clientIp, userAgent);
        res.cookie('sessionId', sessionId, {
            httpOnly: true,
            secure: req.secure,
            sameSite: 'lax',
            maxAge: authManager.SESSION_TTL
        });
    }
    next();
});

// Implementace LRU cache pro vyhledávání a info
class LRUCache {
    constructor(maxSize = 500) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }
    get(key) {
        if (!this.cache.has(key)) return null;
        const value = this.cache.get(key);
        // Přesun na konec (nejpoužívanější)
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }
    set(key, value) {
        if (this.cache.has(key)) this.cache.delete(key);
        this.cache.set(key, value);
        if (this.cache.size > this.maxSize) {
            // Odstranění nejméně používaného (první)
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
    }
    delete(key) {
        this.cache.delete(key);
    }
    clear() {
        this.cache.clear();
    }
}

// Debounce map pro dotazy (sloučení stejných dotazů v krátkém čase)
const debounceMap = new Map();
const DEBOUNCE_TTL = 2000; // 2 sekundy

// LRU cache pro vyhledávání a info
const SEARCH_CACHE_TTL = 10 * 60 * 1000; // 10 minut
const INFO_CACHE_TTL = 30 * 60 * 1000;   // 30 minut

const searchCache = new LRUCache(500);
const infoCache = new LRUCache(1000);

// Funkce pro získání hodnoty z cache
function getCache(cache, key) {
    const entry = cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.value;
    if (entry) cache.delete(key);
    return null;
}
// Funkce pro nastavení hodnoty do cache
function setCache(cache, key, value, ttl) {
    cache.set(key, { value, expires: Date.now() + ttl });
}

// Debounced vyhledávání torrentů
const debouncedSearchTorrents = async (query) => {
    if (debounceMap.has(query)) return debounceMap.get(query);
    const promise = searchTorrents(query)
        .finally(() => {
            setTimeout(() => debounceMap.delete(query), DEBOUNCE_TTL);
        });
    debounceMap.set(query, promise);
    return promise;
};

// Paralelní vyhledávání s LRU cache a debouncingem
const parallelSearchTorrents = async (queries) => {
    const cachedResults = [];
    const uncachedQueries = [];
    for (const query of queries) {
        const cached = getCache(searchCache, query);
        if (cached) {
            cachedResults.push({ query, results: cached });
        } else {
            uncachedQueries.push(query);
        }
    }
    const searchPromises = uncachedQueries.map(query =>
        debouncedSearchTorrents(query).then(results => ({ query, results })).catch(() => ({ query, results: [] }))
    );
    const results = await Promise.all(searchPromises);
    for (const { query, results: res } of results) {
        setCache(searchCache, query, res, SEARCH_CACHE_TTL);
    }
    const allResults = [...cachedResults, ...results];
    for (const q of queries) {
        const found = allResults.find(r => r.query === q && r.results && r.results.length > 0);
        if (found) return found.results;
    }
    return [];
};

// Získání info o torrentu s LRU cache
const getTorrentInfoCached = async (url) => {
    const cached = getCache(infoCache, url);
    if (cached) return cached;
    const info = await getTorrentInfo(url);
    if (info) setCache(infoCache, url, info, INFO_CACHE_TTL);
    return info;
};

// ✅ Handler pro streamy - ZACHOVÁNO pro Stremio kompatibilitu, RD používá torrent soubory
builder.defineStreamHandler(async ({ type, id }, req) => {
    console.log(`\n====== 🎮 STREAM pro ${type}:${id} ======`);
    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;
    const titles = await getTitleFromIMDb(imdbId);
    if (!titles) return { streams: [] };
    const { title, originalTitle } = titles;
    const queries = Utils.generateSearchQueries(title, originalTitle, type, season, episode);

    // Paralelní vyhledávání s cache
    const torrents = await parallelSearchTorrents(queries);
    if (torrents.length === 0) {
        console.log(`❌ Žádné torrenty nenalezeny`);
        return { streams: [] };
    }

    const streams = [];

    // Správná baseUrl pro streamy
    const currentBaseUrl = baseUrl;
    if (!currentBaseUrl) {
        console.error('❌ Nelze určit BaseUrl pro streamy.');
        return { streams: [] };
    }
    const allStoredKeys = authManager.getAllSessionKeys ? authManager.getAllSessionKeys() : [];
    const availableApiKey = allStoredKeys.length > 0 ? allStoredKeys[0] : null;

    // Paralelní získání info o torrentech s cache a timeoutem
    let torrentInfos;
    try {
        torrentInfos = await Promise.race([
            Promise.all(
                torrents.slice(0, 5).map(t => {
                    console.log(`🧩 SKTorrent downloadUrl: ${t.downloadUrl}`);
                    return getTorrentInfoCached(t.downloadUrl);
                })
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout při získávání torrent info (2 minuty)')), 2 * 60 * 1000))
        ]);
    } catch (e) {
        return { streams: [] };
    }

    // Pro debug: vypiš všechny SKTorrent downloadUrl
    if (req && typeof req.debug === 'object') {
        req.debug.sktorrentDownloadUrls = torrents.slice(0, 5).map(t => t.downloadUrl);
    }

    for (let i = 0; i < torrents.slice(0, 5).length; i++) {
        const torrent = torrents[i];
        const torrentInfo = torrentInfos[i];
        if (!torrentInfo) continue;
        
        // ✅ KLÍČOVÁ OPRAVA: Uložení původního torrentu do cache
        torrentDataCache.set(torrentInfo.infoHash, {
            originalTorrent: torrent,
            torrentInfo: torrentInfo,
            searchContext: {
                query: queries[0], // Původní query
                title,
                originalTitle,
                type,
                season,
                episode
            }
        });
        console.log(`💾 Cached torrent data pro ${torrentInfo.infoHash}: ${torrent.name}`);
        
        let cleanedTitle = torrent.name.replace(/^Stiahni si\s*/i, "").trim();
        const categoryPrefix = torrent.category.trim().toLowerCase();
        if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) {
            cleanedTitle = cleanedTitle.slice(torrent.category.length).trim();
        }
        const langMatches = torrent.name.match(/\b([A-Z]{2})\b/g) || [];
        const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
        const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

        if (rd && (config.STREAM_MODE === "RD_ONLY" || config.STREAM_MODE === "BOTH")) {
            const processUrl = `${currentBaseUrl}/process/${torrentInfo.infoHash}/${encodeURIComponent(torrentInfo.name || cleanedTitle || 'torrent')}`
                + (availableApiKey ? `?api_key=${availableApiKey}` : '');
            streams.push({
                name: `⚡ Real-Debrid\n${torrent.category}`,
                title: `${cleanedTitle}\n👤 ${torrent.seeds}  📀 ${torrent.size}  🚀 Rychlé${flagsText}`,
                url: processUrl, // ✅ URL pro RD processing (použije torrent soubor)
                behaviorHints: { bingeGroup: `rd-${cleanedTitle}` }
            });
        }
        if (config.STREAM_MODE === "TORRENT_ONLY" || config.STREAM_MODE === "BOTH") {
            streams.push({
                name: `🎬 Direct Torrent\n${torrent.category}`,
                title: `${cleanedTitle}\n👤 ${torrent.seeds}  📀 ${torrent.size}  💾 Přímé${flagsText}`,
                infoHash: torrentInfo.infoHash, // ✅ infoHash pro Stremio (magnet link)
                behaviorHints: { bingeGroup: `torrent-${cleanedTitle}` }
            });
        }
    }
    console.log(`✅ Odesílám ${streams.length} streamů (${config.STREAM_MODE})`);
    return { streams };
});

// Hlavní stránka addonu
app.get('/', (req, res) => {
    const hasApiKey = req.query.api_key === config.ADDON_API_KEY;
    const baseUrl = getBaseUrl();
    const templateConfig = {
        hasApiKey,
        baseUrl,
        ...config,
        rd,
        RATE_LIMIT_MAX: authManager.RATE_LIMIT_MAX
    };
    let stats = {};
    try {
        stats = {
            ...authManager.getStats(),
            ...streamingManager.getStats(),
            authSessions: authManager.sessions ? authManager.sessions.size : 0,
            activeProcessing: streamingManager.activeProcessing ? streamingManager.activeProcessing.size : 0,
            torrentDataCache: torrentDataCache.cache.size
        };
    } catch (e) {
        stats = {};
    }
    res.send(TemplateManager.generateHomePage(req, templateConfig, stats));
});

// ✅ OPRAVENÝ endpoint pro streaming s předáním torrentDataCache - používá torrent soubory pro RD
app.all('/process/:infoHash/:name', async (req, res) => {
    const { infoHash } = req.params;
    let finished = false;

    const timeout = setTimeout(() => {
        if (!finished && !res.headersSent) {
            finished = true;
            res.status(504).json({ error: 'Gateway Timeout', infoHash });
        }
    }, 2 * 60 * 1000);

    try {
        const torrentSearchManager = {
            searchTorrents: (query) => searchTorrents(query),
            getTorrentInfo: (url) => getTorrentInfo(url),
            getTitleFromIMDb: (imdbId) => getTitleFromIMDb(imdbId)
        };

        // ✅ processRealDebridStream nyní používá torrent soubory místo magnet linků
        const url = await streamingManager.processRealDebridStream(
            infoHash,
            rd,
            rdApiKey,
            req,
            res,
            torrentSearchManager,
            config,
            torrentDataCache
        );

        if (!finished && url) {
            finished = true;
            clearTimeout(timeout);
            return streamingManager.streamFromUrl(url, req, res, 'RD');
        }

        if (!finished && !res.headersSent) {
            finished = true;
            clearTimeout(timeout);
            res.status(404).json({ error: 'Stream není dostupný', infoHash });
        }
    } catch (e) {
        if (!finished && !res.headersSent) {
            finished = true;
            clearTimeout(timeout);
            res.status(500).json({ error: 'Server chyba', infoHash, message: e.message });
        }
    }
});

// Pravidelný cleanup session a cache
const smartCleanup = () => {
    authManager.cleanupExpiredSessions();
    streamingManager.cleanupCache();
    torrentDataCache.cleanup();
};
setInterval(smartCleanup, 5 * 60 * 1000);

// Asynchronní cleanup cache každých 60 minut
function asyncCacheCleanup() {
    const now = Date.now();
    let cleanedSearch = 0, cleanedInfo = 0;
    for (const [key, entry] of searchCache.cache.entries()) {
        if (entry.expires <= now) {
            searchCache.delete(key);
            cleanedSearch++;
        }
    }
    for (const [key, entry] of infoCache.cache.entries()) {
        if (entry.expires <= now) {
            infoCache.delete(key);
            cleanedInfo++;
        }
    }
    if (cleanedSearch || cleanedInfo) {
        console.log(`🧹 Cache cleanup: search=${cleanedSearch}, info=${cleanedInfo}`);
    }
}
setInterval(asyncCacheCleanup, 60 * 60 * 1000);

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

app.listen(7000, '0.0.0.0', () => {
    console.log('🚀 SKTorrent Hybrid v1.0.0 Modular běží na http://0.0.0.0:7000');
    console.log(`🔧 Režim: ${rd ? 'Dual (RD + Torrent)' : 'Pouze Torrent'} | Stream: ${config.STREAM_MODE}`);
    console.log(`🔐 Zabezpečení: ${config.ADDON_API_KEY ? 'API klíč aktivní' : 'VÝVOJOVÝ REŽIM'}`);
    console.log(`🛡️ Rate limit: ${authManager.RATE_LIMIT_MAX} req/hod`);
    console.log(`📦 Moduly: 6 načteno | ⚡ Connection pooling aktivní`);
    console.log('⏰ Request timeout: 30s pro streaming endpointy');
    console.log('🔍 Debug endpoint dostupný na /debug/:infoHash');
    console.log('💾 TorrentDataCache aktivní pro propojení infoHash s původními torrenty');
    console.log('📂 RD používá torrent soubory, Stremio používá magnet linky');
});
