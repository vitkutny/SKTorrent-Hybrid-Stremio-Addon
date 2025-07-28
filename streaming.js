const axios = require('axios');
const parseTorrent = require('parse-torrent');

// --- LRU cache pro HEAD dotazy a chybové stavy RD ---
function createLRUCache(maxSize = 300) {
    const cache = new Map();
    return {
        get(key) {
            if (!cache.has(key)) return null;
            const value = cache.get(key);
            cache.delete(key);
            cache.set(key, value);
            return value;
        },
        set(key, value) {
            if (cache.has(key)) cache.delete(key);
            cache.set(key, value);
            if (cache.size > maxSize) {
                const firstKey = cache.keys().next().value;
                cache.delete(firstKey);
            }
        },
        delete(key) {
            cache.delete(key);
        },
        clear() {
            cache.clear();
        },
        size() {
            return cache.size;
        }
    };
}

function createStreamingManager(apiClient) {
    const activeProcessing = new Map();
    const rdCache = new Map();
    const activeStreams = new Map();
    const CACHE_DURATION = 10 * 60 * 1000;
    const headCache = createLRUCache(300);
    const rdErrorCache = createLRUCache(300);
    let lastCleanup = 0;

    function getStreamKey(req, url) {
        const { ip, method, headers: { range } } = req;
        const baseKey = `${ip}_${url}`;
        if (method === 'HEAD') return `${baseKey}_HEAD`;
        if (range) return `${baseKey}_RANGE_${range}`;
        return `${baseKey}_FULL`;
    }

    // ✅ NOVÁ funkce pro získání torrent dat z cache
    const getTorrentDataFromCache = async (infoHash, torrentSearchManager, config, torrentDataCache) => {
        console.log(`📦 Získávám torrent data pro RD upload: ${infoHash}`);

        if (!torrentDataCache) {
            throw new Error(`TorrentDataCache není k dispozici pro ${infoHash}`);
        }

        const cachedData = torrentDataCache.get(infoHash);
        if (!cachedData || !cachedData.originalTorrent) {
            throw new Error(`Cached torrent data nenalezena pro ${infoHash} - stream handler možná selhal`);
        }

        console.log(`💾 Použiji POUZE cached torrent data: ${cachedData.originalTorrent.name}`);
        console.log(`🔍 Cached context: ${cachedData.searchContext?.query} (${cachedData.searchContext?.type})`);

        try {
            // Stáhneme původní torrent soubor z cached URL
            const { data } = await apiClient.get(cachedData.originalTorrent.downloadUrl, {
                responseType: "arraybuffer",
                headers: {
                    Cookie: `uid=${config.SKT_UID}; pass=${config.SKT_PASS}`,
                    Referer: config.BASE_URL || 'https://sktorrent.eu',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            // ✅ Ověření, že je to správný torrent
            const parsed = parseTorrent(data);
            console.log(`🎯 InfoHash check: očekávaný=${infoHash}, skutečný=${parsed.infoHash}`);
            
            if (parsed.infoHash.toLowerCase() !== infoHash.toLowerCase()) {
                throw new Error(`InfoHash mismatch: očekávaný ${infoHash}, ale torrent má ${parsed.infoHash}`);
            }
            
            console.log(`✅ Torrent data úspěšně získána pro RD upload (${data.byteLength} bytes)`);
            return data; // Vrátí Buffer s torrent daty
            
        } catch (error) {
            console.error(`❌ Chyba při získávání torrent dat z cached URL: ${error.message}`);
            throw error;
        }
    };

    // ✅ ZACHOVANÁ funkce buildCompleteMagnetLink pro Stremio kompatibilitu
    const buildCompleteMagnetLink = async (infoHash, torrentSearchManager, config, torrentDataCache) => {
        console.log(`🧲 Sestavuji kompletní magnet link pro ${infoHash}`);

        if (!torrentDataCache) {
            throw new Error(`TorrentDataCache není k dispozici pro ${infoHash}`);
        }

        const cachedData = torrentDataCache.get(infoHash);
        if (!cachedData || !cachedData.originalTorrent) {
            throw new Error(`Cached torrent data nenalezena pro ${infoHash} - stream handler možná selhal`);
        }

        console.log(`💾 Použiji POUZE cached torrent data: ${cachedData.originalTorrent.name}`);
        console.log(`🔍 Cached context: ${cachedData.searchContext?.query} (${cachedData.searchContext?.type})`);

        try {
            // Stáhneme původní torrent soubor z cached URL
            const { data } = await apiClient.get(cachedData.originalTorrent.downloadUrl, {
                responseType: "arraybuffer",
                headers: {
                    Cookie: `uid=${config.SKT_UID}; pass=${config.SKT_PASS}`,
                    Referer: config.BASE_URL || 'https://sktorrent.eu',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            // ✅ Použití parse-torrent pro parsování
            const parsed = parseTorrent(data);
            
            console.log(`🔍 Parsed torrent data:`, {
                infoHash: parsed.infoHash,
                name: parsed.name,
                length: parsed.length,
                announceLength: parsed.announce?.length,
                files: parsed.files?.length
            });
            
            // ✅ SPRÁVNÉ pořadí parametrů jako ve vašem externím magnet linku
            const magnetParams = [];
            
            // ✅ xl parametr PRVNÍ
            if (parsed.length) {
                magnetParams.push(`xl=${parsed.length}`);
                console.log(`📏 Přidávám xl parametr jako první: ${parsed.length} bytes`);
            }
            
            // Potom xt parametr
            magnetParams.push(`xt=urn:btih:${parsed.infoHash}`);
            
            // Display name
            if (parsed.name) {
                magnetParams.push(`dn=${encodeURIComponent(parsed.name)}`);
            }
            
            // Trackery
            if (parsed.announce && parsed.announce.length > 0) {
                parsed.announce.forEach(tracker => {
                    magnetParams.push(`tr=${encodeURIComponent(tracker)}`);
                });
            }
            
            // Sestavení finálního magnet linku
            const completeMagnet = `magnet:?${magnetParams.join('&')}`;
            
            console.log(`✅ Kompletní magnet link sestaven s xl parametrem na první pozici`);
            console.log(`🎯 InfoHash check: očekávaný=${infoHash}, skutečný=${parsed.infoHash}`);
            console.log(`📏 Velikost: ${parsed.length} bytes`);
            
            // ✅ Kontrola, že xl parametr je na první pozici
            if (completeMagnet.startsWith(`magnet:?xl=${parsed.length}&xt=`)) {
                console.log(`✅ xl parametr správně na první pozici: xl=${parsed.length}`);
            } else {
                console.error(`❌ xl parametr není na první pozici!`);
            }
            
            console.log(`🧲 Finální magnet: ${completeMagnet.substring(0, 120)}...`);
            
            // ✅ Dodatečná kontrola, že hash sedí
            if (parsed.infoHash.toLowerCase() !== infoHash.toLowerCase()) {
                throw new Error(`InfoHash mismatch: očekávaný ${infoHash}, ale torrent má ${parsed.infoHash}`);
            }
            
            return completeMagnet;
            
        } catch (error) {
            console.error(`❌ Chyba při sestavování magnet linku z cached dat: ${error.message}`);
            throw error;
        }
    };

    // ✅ OPRAVENÁ streamFromUrl funkce s lepším error handlingem
    async function streamFromUrl(url, req, res, source) {
        const streamKey = getStreamKey(req, url);
        const baseKey = `${req.ip}_${url}`;
        const { range } = req.headers;
        const isRangeRequest = range && range.includes('bytes=');

        if (!isRangeRequest && activeStreams.has(`${baseKey}_FULL`)) {
            const existingStream = activeStreams.get(`${baseKey}_FULL`);
            if (Date.now() - existingStream < 5000) {
                console.log(`⚠️ Základní stream nedávno spuštěn pro ${baseKey}, čekám...`);
                return;
            }
        }

        try {
            activeStreams.set(streamKey, Date.now());
            console.log(`🔄 Spouštím ${source} stream: ${req.method} ${range ? `Range: ${range}` : 'FULL'}`);
            console.log(`🌐 Stream URL: ${url}`);

            // ✅ OPRAVA: Nejprve zkontroluj URL dostupnost
            let response;
            try {
                response = await apiClient.get(url, {
                    responseType: 'stream',
                    headers: { 
                        'Range': range || 'bytes=0-',
                        'User-Agent': 'SKTorrent-Hybrid/1.0.0'
                    },
                    timeout: 30000,
                    validateStatus: function (status) {
                        return status >= 200 && status < 400; // Povolí redirects
                    }
                });
            } catch (urlError) {
                console.error(`❌ Chyba při načítání URL: ${urlError.message}`);
                if (urlError.response) {
                    console.error(`📋 Status: ${urlError.response.status}, Headers:`, urlError.response.headers);
                }
                throw urlError;
            }

            const { headers, data, status } = response;
            
            // ✅ OPRAVA: Debug response headers
            console.log(`📊 Response status: ${status}`);
            console.log(`📋 Response headers:`, {
                'content-type': headers['content-type'],
                'content-length': headers['content-length'],
                'content-range': headers['content-range'],
                'accept-ranges': headers['accept-ranges']
            });

            const responseHeaders = {
                'Content-Type': headers['content-type'] || 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache, no-store',
                'Connection': 'keep-alive'
            };

            // ✅ OPRAVA: Lepší handling Content-Length
            if (headers['content-length']) {
                responseHeaders['Content-Length'] = headers['content-length'];
                console.log(`📏 Content-Length: ${headers['content-length']} bytes`);
            } else {
                console.warn(`⚠️ Content-Length chybí v response headers`);
            }

            if (range && status === 206) {
                res.status(206);
                if (headers['content-range']) {
                    responseHeaders['Content-Range'] = headers['content-range'];
                    console.log(`📍 Range stream: ${headers['content-range']}`);
                } else {
                    console.warn(`⚠️ Content-Range chybí pro 206 response`);
                }
            } else {
                res.status(200);
                console.log(`📺 Full stream: ${responseHeaders['Content-Length'] || 'unknown size'} bytes`);
            }

            res.set(responseHeaders);

            // ✅ OPRAVA: Lepší stream handling s error listenery
            let streamEnded = false;
            const cleanup = () => {
                if (!streamEnded) {
                    streamEnded = true;
                    activeStreams.delete(streamKey);
                    console.log(`🧹 Stream cleanup: ${streamKey}`);
                }
            };

            // ✅ OPRAVA: Error handling před pipe
            data.on('error', err => {
                console.error(`❌ ${source} stream data error: ${err.message}`);
                cleanup();
                if (!res.headersSent) {
                    res.status(500).end();
                } else if (!res.destroyed) {
                    res.destroy();
                }
            });

            data.on('end', () => {
                console.log(`✅ ${source} stream ended normally`);
                cleanup();
            });

            data.on('close', () => {
                console.log(`🔒 ${source} stream closed`);
                cleanup();
            });

            req.on('close', () => {
                console.log(`🔒 Client disconnected from ${source} stream`);
                cleanup();
                if (!data.destroyed) {
                    data.destroy();
                }
            });

            req.on('aborted', () => {
                console.log(`🚫 Client aborted ${source} stream`);
                cleanup();
                if (!data.destroyed) {
                    data.destroy();
                }
            });

            // ✅ OPRAVA: Pipe s error handling
            data.pipe(res).on('error', (err) => {
                console.error(`❌ ${source} pipe error: ${err.message}`);
                cleanup();
            });

            console.log(`🚀 ${source} stream pipeline nastavena úspěšně`);

        } catch (error) {
            activeStreams.delete(streamKey);
            console.error(`❌ ${source} proxy stream chyba: ${error.message}`);
            console.error(`📋 Error stack: ${error.stack}`);
            
            if (!res.headersSent) {
                res.status(503).json({
                    error: `${source} proxy stream chyba`,
                    message: error.message,
                    url: url // ✅ Debug info
                });
            }
        }
    }

    const getStreamHeaders = async (infoHash, rd, rdApiKey) => {
        const now = Date.now();
        try {
            const cached = rdCache.get(infoHash);
            if (cached && cached.expiresAt > now) {
                if (cached.error) {
                    console.log(`❌ HEAD: Cache obsahuje chybu pro ${infoHash}`);
                    return null;
                }
                if (cached.links) {
                    const url = cached.links[0].url;
                    return await getUrlHeaders(url);
                }
            }

            const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
            const rdLinks = await rd.addMagnetIfNotExists(rdApiKey, magnetLink, infoHash, 1);

            if (rdLinks && rdLinks.length > 0) {
                rdCache.set(infoHash, {
                    timestamp: now,
                    links: rdLinks,
                    expiresAt: now + CACHE_DURATION
                });
                return await getUrlHeaders(rdLinks[0].url);
            }

            rdCache.set(infoHash, {
                timestamp: now,
                error: true,
                message: 'HEAD request selhal',
                expiresAt: now + (CACHE_DURATION / 4)
            });
            return null;
        } catch (error) {
            console.error(`❌ HEAD request chyba: ${error.message}`);
            return null;
        }
    };

    const maybeCleanupCaches = () => {
        const now = Date.now();
        if (now - lastCleanup > 10 * 60 * 1000) { // 10 minut
            headCache.clear();
            rdErrorCache.clear();
            lastCleanup = now;
            console.log('🧹 StreamingManager: cache cleanup');
        }
    };

    const getUrlHeaders = async (url) => {
        const cached = headCache.get(url);
        if (cached && cached.expires > Date.now()) return cached.value;

        try {
            const { headers } = await apiClient.head(url);
            const value = {
                'Content-Type': headers['content-type'] || 'video/mp4',
                'Content-Length': headers['content-length'],
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache'
            };
            headCache.set(url, { value, expires: Date.now() + 10 * 60 * 1000 }); // 10 min
            return value;
        } catch (error) {
            console.error(`❌ HEAD URL chyba: ${error.message}`);
            headCache.set(url, { value: {
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes'
            }, expires: Date.now() + 2 * 60 * 1000 }); // 2 min pro chybu
            return {
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes'
            };
        }
    };

    const cacheRDError = (infoHash, message) => {
        rdErrorCache.set(infoHash, { error: true, message, expires: Date.now() + 5 * 60 * 1000 }); // 5 min
    };

    const getRDError = (infoHash) => {
        const cached = rdErrorCache.get(infoHash);
        if (cached && cached.expires > Date.now()) return cached;
        if (cached) rdErrorCache.delete(infoHash);
        return null;
    };

    // ✅ OPRAVENÁ debugTorrent funkce s torrentDataCache
    const debugTorrent = async (infoHash, torrentSearchManager, rd, rdApiKey, torrentDataCache) => {
        const debugInfo = {
            infoHash,
            timestamp: new Date().toISOString(),
            steps: []
        };

        try {
            debugInfo.steps.push('🔍 Začínám debug analýzu...');
            
            // ✅ Zkontroluj cached data
            if (torrentDataCache) {
                const cachedData = torrentDataCache.get(infoHash);
                if (cachedData) {
                    debugInfo.steps.push('💾 Nalezena cached torrent data!');
                    debugInfo.cacheData = {
                        originalTorrent: cachedData.originalTorrent,
                        searchContext: cachedData.searchContext,
                        cached: new Date(cachedData.cached).toISOString()
                    };
                    debugInfo.torrentDetails = {
                        sktId: cachedData.originalTorrent.id,
                        sktName: cachedData.originalTorrent.name,
                        sktCategory: cachedData.originalTorrent.category,
                        sktSeeds: cachedData.originalTorrent.seeds,
                        sktSize: cachedData.originalTorrent.size,
                        downloadUrl: cachedData.originalTorrent.downloadUrl,
                        calculatedHash: cachedData.torrentInfo.infoHash
                    };
                } else {
                    debugInfo.steps.push('❌ Žádná cached data nenalezena');
                }
            }

            // ✅ Testování torrent dat pro RD
            debugInfo.steps.push('📦 Zkouším získat torrent data pro RD...');
            try {
                const torrentData = await getTorrentDataFromCache(infoHash, torrentSearchManager, {
                    SKT_UID: process.env.SKT_UID,
                    SKT_PASS: process.env.SKT_PASS,
                    BASE_URL: process.env.BASE_URL || 'https://sktorrent.eu'
                }, torrentDataCache);
                debugInfo.steps.push(`✅ Torrent data získána (${torrentData.byteLength} bytes)`);
                debugInfo.torrentDataSize = torrentData.byteLength;
            } catch (torrentError) {
                debugInfo.steps.push(`❌ Chyba při získávání torrent dat: ${torrentError.message}`);
                debugInfo.torrentError = torrentError.message;
            }

            // ✅ Sestavení magnet linku pro Stremio kompatibilitu
            debugInfo.steps.push('🧲 Sestavuji magnet link pro Stremio...');
            try {
                const completeMagnet = await buildCompleteMagnetLink(infoHash, torrentSearchManager, {
                    SKT_UID: process.env.SKT_UID,
                    SKT_PASS: process.env.SKT_PASS,
                    BASE_URL: process.env.BASE_URL || 'https://sktorrent.eu'
                }, torrentDataCache);
                debugInfo.magnetLink = completeMagnet;
                debugInfo.steps.push(`🧲 Magnet link: ${completeMagnet}`);
            } catch (magnetError) {
                debugInfo.steps.push(`❌ Chyba při sestavování magnet linku: ${magnetError.message}`);
                debugInfo.magnetError = magnetError.message;
            }

            if (rd && debugInfo.torrentDataSize) {
                debugInfo.steps.push('🔄 Testování Real-Debrid s torrent souborem (PUT metoda)...');
                try {
                    const torrentData = await getTorrentDataFromCache(infoHash, torrentSearchManager, {
                        SKT_UID: process.env.SKT_UID,
                        SKT_PASS: process.env.SKT_PASS,
                        BASE_URL: process.env.BASE_URL || 'https://sktorrent.eu'
                    }, torrentDataCache);
                    
                    const rdResult = await rd.addTorrentIfNotExists(rdApiKey, torrentData, infoHash);
                    if (rdResult && rdResult.length > 0) {
                        debugInfo.steps.push(`✅ Úspěšně přidáno do RD pomocí PUT metody!`);
                        debugInfo.rdLinks = rdResult.slice(0, 3);
                    } else {
                        debugInfo.steps.push(`❌ Nepodařilo se přidat do RD`);
                    }
                } catch (rdError) {
                    debugInfo.steps.push(`❌ RD API chyba: ${rdError.message}`);
                    debugInfo.rdError = rdError.message;
                }
            }

            debugInfo.steps.push('✅ Debug analýza dokončena!');
            debugInfo.success = true;
        } catch (error) {
            debugInfo.steps.push(`❌ Debug chyba: ${error.message}`);
            debugInfo.error = error.message;
            debugInfo.success = false;
        }

        return debugInfo;
    };

    // ✅ HLAVNÍ OPRAVENÁ processRealDebridStream - používá PUT torrent upload
    const processRealDebridStream = async (infoHash, rd, rdApiKey, req, res, torrentSearchManager, config, torrentDataCache) => {
        maybeCleanupCaches();

        // Zkontroluj RD error cache
        const cachedError = getRDError(infoHash);
        if (cachedError) {
            console.log(`❌ RD error cache hit pro ${infoHash}: ${cachedError.message}`);
            return null;
        }

        const now = Date.now();
        try {
            const rangeHeader = req.headers.range;
            console.log(`🚀 RD ${req.method} pro: ${infoHash}${rangeHeader ? ` Range: ${rangeHeader}` : ''}`);

            const cached = rdCache.get(infoHash);
            if (cached && cached.expiresAt > now) {
                if (cached.error) {
                    console.log(`❌ CACHE ERROR pro ${infoHash}: ${cached.message}`);
                    return null;
                }
                if (cached.links) {
                    console.log(`🎯 CACHE SUCCESS pro ${infoHash}`);
                    return cached.links[0].url;
                }
            }

            if (activeProcessing.has(infoHash)) {
                console.log(`⏳ Čekám na aktivní zpracování ${infoHash}`);
                try {
                    const result = await activeProcessing.get(infoHash);
                    if (result && result.length > 0) {
                        return result[0].url;
                    } else {
                        return null;
                    }
                } catch (error) {
                    activeProcessing.delete(infoHash);
                    return null;
                }
            }

            console.log(`🔄 NOVÉ RD zpracování pro ${infoHash}`);

            // ✅ KLÍČOVÁ ZMĚNA: Získej pouze torrent data pro PUT upload
            const torrentData = await getTorrentDataFromCache(infoHash, torrentSearchManager, config, torrentDataCache);
            console.log(`📦 Torrent data připravena pro PUT upload (${torrentData.byteLength} bytes)`);

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout při čekání na Real-Debrid (2 minuty)')), 2 * 60 * 1000)
            );

            // ✅ Volej pouze s torrent daty (PUT metoda)
            const processingPromise = Promise.race([
                rd.addTorrentIfNotExists(rdApiKey, torrentData, infoHash), // ✅ Pouze torrent data
                timeoutPromise
            ]);

            activeProcessing.set(infoHash, processingPromise);

            try {
                const rdLinks = await processingPromise;
                activeProcessing.delete(infoHash);

                if (rdLinks && rdLinks.length > 0) {
                    rdCache.set(infoHash, {
                        timestamp: now,
                        links: rdLinks,
                        expiresAt: now + (rdLinks[0].cacheDuration ?? CACHE_DURATION),
                    });
                    return rdLinks[0].url;
                }

                rdCache.set(infoHash, {
                    timestamp: now,
                    error: true,
                    message: 'Torrent nelze zpracovat (PUT torrent error)',
                    expiresAt: now + CACHE_DURATION
                });
                return null;
            } catch (error) {
                activeProcessing.delete(infoHash);
                console.error(`❌ RD processing error: ${error.message}`);
                return null;
            }
        } catch (error) {
            activeProcessing.delete(infoHash);
            console.error(`❌ processRealDebridStream error: ${error.message}`);
            return null;
        }
    };

    const getRealDebridStreamUrl = async (infoHash, rd, rdApiKey, req) => {
        maybeCleanupCaches();

        const cachedError = getRDError(infoHash);
        if (cachedError) {
            console.log(`❌ RD error cache hit pro ${infoHash}: ${cachedError.message}`);
            return null;
        }

        const now = Date.now();
        try {
            const cached = rdCache.get(infoHash);
            if (cached && cached.expiresAt > now) {
                if (cached.error) {
                    console.log(`❌ CACHE ERROR pro ${infoHash}: ${cached.message}`);
                    return null;
                }
                if (cached.links) {
                    console.log(`🎯 CACHE SUCCESS pro ${infoHash}`);
                    return cached.links[0].url;
                }
            }

            if (activeProcessing.has(infoHash)) {
                console.log(`⏳ Čekám na aktivní zpracování ${infoHash}`);
                try {
                    const result = await activeProcessing.get(infoHash);
                    if (result && result.length > 0) {
                        return result[0].url;
                    } else {
                        return null;
                    }
                } catch (error) {
                    activeProcessing.delete(infoHash);
                    return null;
                }
            }

            console.log(`🔄 NOVÉ RD zpracování pro ${infoHash}`);
            const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout při čekání na Real-Debrid (2 minuty)')), 2 * 60 * 1000)
            );

            const processingPromise = Promise.race([
                rd.addMagnetIfNotExists(rdApiKey, magnetLink, infoHash, 2),
                timeoutPromise
            ]);

            activeProcessing.set(infoHash, processingPromise);

            try {
                const rdLinks = await processingPromise;
                activeProcessing.delete(infoHash);

                if (rdLinks && rdLinks.length > 0) {
                    rdCache.set(infoHash, {
                        timestamp: now,
                        links: rdLinks,
                        expiresAt: now + (rdLinks[0].cacheDuration ?? CACHE_DURATION),
                    });
                    return rdLinks[0].url;
                }

                rdCache.set(infoHash, {
                    timestamp: now,
                    error: true,
                    message: 'Torrent nelze zpracovat (magnet_error)',
                    expiresAt: now + CACHE_DURATION
                });
                return null;
            } catch (error) {
                activeProcessing.delete(infoHash);
                return null;
            }
        } catch (error) {
            activeProcessing.delete(infoHash);
            return null;
        }
    };

    const cleanupCache = () => {
        const now = Date.now();
        let cleanedCache = 0;
        let cleanedProcessing = 0;
        let cleanedStreams = 0;

        for (const [hash, cached] of rdCache.entries()) {
            if (cached.expiresAt <= now) {
                rdCache.delete(hash);
                cleanedCache++;
            }
        }

        for (const [infoHash] of activeProcessing.entries()) {
            activeProcessing.delete(infoHash);
            cleanedProcessing++;
        }

        const oldStreamLimit = now - (5 * 60 * 1000);
        for (const [streamKey, timestamp] of activeStreams.entries()) {
            if (timestamp < oldStreamLimit) {
                activeStreams.delete(streamKey);
                cleanedStreams++;
            }
        }

        if (cleanedCache > 0 || cleanedProcessing > 0 || cleanedStreams > 0) {
            console.log(`🧹 Streaming cleanup: ${cleanedCache} cache, ${cleanedProcessing} processing, ${cleanedStreams} streams`);
        }
    };

    const getStats = () => ({
        cache: rdCache.size,
        activeProcessing: activeProcessing.size,
        activeStreams: activeStreams.size
    });

    return {
        getStreamKey,
        streamFromUrl,
        getStreamHeaders,
        maybeCleanupCaches,
        getUrlHeaders,
        cacheRDError,
        getRDError,
        debugTorrent,
        processRealDebridStream,
        cleanupCache,
        getStats,
        getRealDebridStreamUrl,
        buildCompleteMagnetLink,
        getTorrentDataFromCache
    };
}

module.exports = createStreamingManager;
