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
            const { headers, data, status } = await apiClient.get(url, {
                responseType: 'stream',
                headers: { 'Range': range || 'bytes=0-' }
            });
            const responseHeaders = {
                'Content-Type': headers['content-type'] || 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache, no-store',
                'Connection': 'keep-alive',
                ...(headers['content-length'] && { 'Content-Length': headers['content-length'] })
            };
            if (range && status === 206) {
                res.status(206);
                if (headers['content-range']) responseHeaders['Content-Range'] = headers['content-range'];
                console.log(`📍 Range stream: ${headers['content-range']}`);
            } else {
                res.status(200);
                console.log(`📺 Full stream: ${responseHeaders['Content-Length']} bytes`);
            }
            res.set(responseHeaders);
            data.pipe(res);
            const cleanup = () => {
                activeStreams.delete(streamKey);
                console.log(`🧹 Stream cleanup: ${streamKey}`);
            };
            data.on('error', err => {
                console.error(`❌ Stream error: ${err.message}`);
                cleanup();
                if (!res.headersSent) res.status(500).end();
            });
            data.on('end', cleanup);
            data.on('close', cleanup);
            req.on('close', cleanup);
            req.on('aborted', cleanup);
        } catch (error) {
            activeStreams.delete(streamKey);
            console.error(`❌ ${source} proxy stream chyba: ${error.message}`);
            if (!res.headersSent) {
                res.status(503).json({
                    error: `${source} proxy stream chyba`,
                    message: error.message
                });
            }
        }
    };

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

    const debugTorrent = async (infoHash, torrentSearchManager, rd, rdApiKey) => {
        const debugInfo = {
            infoHash,
            timestamp: new Date().toISOString(),
            steps: []
        };
        try {
            debugInfo.steps.push('🔍 Začínám debug analýzu...');
            debugInfo.steps.push('📊 Hledám torrent v SKTorrent databázi...');
            const queries = ['The Accountant 2', 'Accountant 2', 'The Accountant'];
            let foundTorrent = null;
            for (const query of queries) {
                debugInfo.steps.push(`🔎 Zkouším query: "${query}"`);
                const torrents = await torrentSearchManager.searchTorrents(query);
                for (const torrent of torrents) {
                    debugInfo.steps.push(`📦 Kontroluji torrent: "${torrent.name}" (ID: ${torrent.id})`);
                    const torrentInfo = await torrentSearchManager.getTorrentInfo(torrent.downloadUrl);
                    if (torrentInfo && torrentInfo.infoHash === infoHash) {
                        foundTorrent = { ...torrent, ...torrentInfo, downloadUrl: torrent.downloadUrl };
                        debugInfo.steps.push(`✅ NALEZEN! Hash se shoduje: ${torrentInfo.infoHash}`);
                        break;
                    } else if (torrentInfo) {
                        debugInfo.steps.push(`❌ Hash se neshoduje: očekávaný=${infoHash}, skutečný=${torrentInfo.infoHash}`);
                    } else {
                        debugInfo.steps.push(`❌ Nepodařilo se získat info z .torrent souboru`);
                    }
                }
                if (foundTorrent) break;
            }
            if (!foundTorrent) {
                debugInfo.steps.push('❌ Torrent nenalezen v SKTorrent!');
                debugInfo.error = 'Torrent nenalezen';
                return debugInfo;
            }
            debugInfo.steps.push('🔧 Analýza .torrent souboru...');
            debugInfo.torrentDetails = {
                sktId: foundTorrent.id,
                sktName: foundTorrent.name,
                sktCategory: foundTorrent.category,
                sktSeeds: foundTorrent.seeds,
                sktSize: foundTorrent.size,
                downloadUrl: foundTorrent.downloadUrl,
                internalName: foundTorrent.name,
                calculatedHash: foundTorrent.infoHash
            };
            debugInfo.steps.push(`📋 SKT název: "${foundTorrent.name}"`);
            debugInfo.steps.push(`📋 Interní název: "${foundTorrent.name}"`);
            debugInfo.steps.push(`📋 Kategorie: "${foundTorrent.category}"`);
            debugInfo.steps.push(`📋 Seeds: ${foundTorrent.seeds}`);
            debugInfo.steps.push(`📋 Velikost: ${foundTorrent.size}`);
            const name = foundTorrent.name;
            const hasNonAscii = /[^\x00-\x7F]/.test(name);
            const problematicChars = name.match(/[<>:"/\\|?*]/g);
            debugInfo.steps.push(`🔍 Analýza názvu:`);
            debugInfo.steps.push(`   Délka: ${name.length}`);
            debugInfo.steps.push(`   Non-ASCII znaky: ${hasNonAscii ? '✅ ANO' : '❌ NE'}`);
            debugInfo.steps.push(`   Problematické znaky: ${problematicChars ? problematicChars.join(', ') : 'žádné'}`);
            // Sestav magnet link s parametry pokud jsou dostupné
            let magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
            if (foundTorrent) {
                const params = [];
                // Bezpečná validace a sanitizace názvu
                if (foundTorrent.name) {
                    const safeName = encodeURIComponent(foundTorrent.name.replace(/[\r\n\0]/g, '').slice(0, 255));
                    params.push(`dn=${safeName}`);
                }
                // Velikost pouze číslo
                if (foundTorrent.size && !isNaN(Number(foundTorrent.size))) {
                    params.push(`xl=${Number(foundTorrent.size)}`);
                }
                // Trackery z pole
                if (Array.isArray(foundTorrent.trackers)) {
                    foundTorrent.trackers.forEach(tr => {
                        if (typeof tr === 'string' && tr.startsWith('http')) {
                            params.push(`tr=${encodeURIComponent(tr)}`);
                        }
                    });
                } else if (foundTorrent.downloadUrl) {
                    // fallback tracker
                    const tracker = 'http://sktorrent.eu/torrent/announce.php';
                    params.push(`tr=${encodeURIComponent(tracker)}`);
                }
                if (params.length > 0) {
                    magnetLink += '&' + params.join('&');
                }
            }
            debugInfo.magnetLink = magnetLink;
            debugInfo.steps.push(`🧲 Magnet link: ${magnetLink}`);
            if (rd) {
                debugInfo.steps.push('🔄 Testování Real-Debrid...');
                try {
                    const existing = await rd.checkExistingTorrent(rdApiKey, infoHash);
                    debugInfo.rdStatus = existing;
                    if (existing.exists) {
                        debugInfo.steps.push(`✅ Torrent existuje v RD: ${existing.torrentId}`);
                        debugInfo.steps.push(`📊 Status: ${existing.status}`);
                        debugInfo.steps.push(`📈 Progress: ${existing.progress || 0}%`);
                        if (existing.error) {
                            debugInfo.steps.push(`❌ RD ERROR: ${existing.message}`);
                            debugInfo.rdError = existing.message;
                        }
                        if (existing.links) {
                            debugInfo.steps.push(`🔗 RD Links: ${existing.links.length} odkazů`);
                            debugInfo.rdLinks = existing.links.slice(0, 3);
                        }
                    } else {
                        debugInfo.steps.push('🆕 Torrent neexistuje v RD - nový torrent');
                        debugInfo.steps.push('📥 Zkouším přidat do RD...');
                        const rdResult = await rd.addMagnetIfNotExists(rdApiKey, magnetLink, infoHash, 1);
                        if (rdResult && rdResult.length > 0) {
                            debugInfo.steps.push(`✅ Úspěšně přidáno do RD!`);
                            debugInfo.rdLinks = rdResult.slice(0, 3);
                        } else {
                            debugInfo.steps.push(`❌ Nepodařilo se přidat do RD`);
                        }
                    }
                } catch (rdError) {
                    debugInfo.steps.push(`❌ RD API chyba: ${rdError.message}`);
                    debugInfo.rdError = rdError.message;
                }
            }
            const cached = rdCache.get(infoHash);
            if (cached) {
                debugInfo.steps.push('📋 Nalezen záznam v local cache:');
                debugInfo.steps.push(`   Timestamp: ${new Date(cached.timestamp).toISOString()}`);
                debugInfo.steps.push(`   Expires: ${new Date(cached.expiresAt).toISOString()}`);
                debugInfo.steps.push(`   Valid: ${cached.expiresAt > Date.now()}`);
                debugInfo.steps.push(`   Error: ${cached.error ? 'ANO' : 'NE'}`);
                if (cached.error) debugInfo.steps.push(`   Error msg: ${cached.message}`);
                if (cached.links) debugInfo.steps.push(`   Links: ${cached.links.length}`);
                debugInfo.cacheData = cached;
            } else {
                debugInfo.steps.push('❌ Žádný záznam v local cache');
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

    // --- POZOR: Tato funkce už nikdy nesmí streamovat ani posílat odpověď! ---
    const processRealDebridStream = async (infoHash, rd, rdApiKey, req, res) => {
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
            const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout při čekání na Real-Debrid (2 minuty)')), 2 * 60 * 1000));
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
                        expiresAt: now + CACHE_DURATION
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

    /**
     * Vrátí streamovací URL pro RD, ale NEstreamuje do res!
     * @returns {Promise<string|null>} RD streamovací URL nebo null při chybě/timeoutu
     */
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
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout při čekání na Real-Debrid (2 minuty)')), 2 * 60 * 1000));
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
                        expiresAt: now + CACHE_DURATION
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
        getRealDebridStreamUrl
    };
}

module.exports = createStreamingManager;
