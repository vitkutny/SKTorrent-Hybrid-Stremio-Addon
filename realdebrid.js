const axios = require('axios');

const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';

// ✅ Jednoduchý RD klient
const createRDClient = (apiKey) => {
    return axios.create({
        baseURL: RD_API_BASE,
        timeout: 60000,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'User-Agent': 'SKTorrent-Hybrid/1.0.0'
        }
    });
};

const downloadingLink = {url: 'https://torrentio.strem.fun/videos/downloading_v2.mp4', cacheDuration: 60 * 1000};

// ✅ Unrestrict funkce (zachována)
const unrestrictLink = async (client, link) => {
    try {
        console.log(`🔓 Unrestrict link: ${link}`);

        const response = await client.post('/unrestrict/link',
            `link=${encodeURIComponent(link)}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const unrestrictedData = response.data;
        console.log(`✅ Link unrestricted: ${unrestrictedData.filename} (${unrestrictedData.filesize} bytes)`);

        if (unrestrictedData.download) {
            return unrestrictedData.download;
        } else {
            throw new Error('Unrestrict nevrátil download link');
        }
    } catch (error) {
        console.error(`❌ Unrestrict chyba: ${error.message}`);
        throw error;
    }
};

// ✅ NOVÁ funkce pro inteligentní výběr video souborů
const selectVideoFile = (files) => {
    const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg'];
    const skipExtensions = ['.rar', '.zip', '.7z', '.tar', '.gz', '.txt', '.nfo', '.srt', '.sub', '.idx', '.par2', '.sfv'];
    
    console.log(`🎬 Analyzuji ${files.length} souborů pro výběr videa:`);
    
    // Debug - vypiš všechny soubory
    files.forEach((file, index) => {
        const sizeGB = (file.bytes / (1024 * 1024 * 1024)).toFixed(2);
        console.log(`📁 Soubor ${index + 1}: ${file.path} (${sizeGB} GB) - ID: ${file.id}`);
    });
    
    // 1. Najdi video soubory (filtruj podle přípony)
    const videoFiles = files.filter(file => {
        const fileName = file.path.toLowerCase();
        const isVideo = videoExtensions.some(ext => fileName.endsWith(ext));
        const isSkip = skipExtensions.some(ext => fileName.endsWith(ext));
        return isVideo && !isSkip;
    });
    
    console.log(`🎥 Nalezeno ${videoFiles.length} video souborů`);
    
    if (videoFiles.length === 0) {
        console.warn(`⚠️ Žádné video soubory nenalezeny, vybírám největší non-archive soubor`);
        // Fallback - vyberi největší soubor (ale ne archiv)
        const nonArchiveFiles = files.filter(file => {
            const fileName = file.path.toLowerCase();
            return !skipExtensions.some(ext => fileName.endsWith(ext));
        });
        
        if (nonArchiveFiles.length > 0) {
            const largest = nonArchiveFiles.reduce((largest, file) => 
                file.bytes > largest.bytes ? file : largest
            );
            const sizeGB = (largest.bytes / (1024 * 1024 * 1024)).toFixed(2);
            console.log(`📦 Fallback: vybírám největší non-archive: ${largest.path} (${sizeGB} GB)`);
            return largest;
        }
        
        console.warn(`⚠️ Ultima fallback: vybírám první soubor`);
        return files[0]; // Poslední fallback
    }
    
    if (videoFiles.length === 1) {
        const selected = videoFiles[0];
        const sizeGB = (selected.bytes / (1024 * 1024 * 1024)).toFixed(2);
        console.log(`✅ Jeden video soubor nalezen: ${selected.path} (${sizeGB} GB)`);
        return selected;
    }
    
    // 2. Pokud je více video souborů, vyberi největší
    const largest = videoFiles.reduce((largest, file) => 
        file.bytes > largest.bytes ? file : largest
    );
    
    const sizeGB = (largest.bytes / (1024 * 1024 * 1024)).toFixed(2);
    console.log(`✅ Vybírám největší video soubor: ${largest.path} (${sizeGB} GB)`);
    return largest;
};

// ✅ OPRAVENÁ selectTorrentFiles - inteligentní výběr video souborů
const selectTorrentFiles = async (client, torrentId) => {
    try {
        console.log(`🔧 Analyzuji soubory pro ${torrentId}`);

        // Počkej než jsou soubory dostupné
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Získej info o torrentu
        const torrentInfo = await client.get(`/torrents/info/${torrentId}`);

        if (!torrentInfo.data?.files) {
            throw new Error('Torrent nemá dostupné soubory');
        }

        const files = torrentInfo.data.files;
        console.log(`📋 Torrent obsahuje ${files.length} souborů`);

        // ✅ KLÍČOVÁ OPRAVA: Inteligentní výběr video souboru
        const selectedFile = selectVideoFile(files);
        
        if (!selectedFile) {
            throw new Error('Nepodařilo se najít vhodný video soubor');
        }
        
        // Real-Debrid používá file.id přímo z API response
        const fileId = selectedFile.id;
        console.log(`🎯 Vybírám pouze video soubor: ID=${fileId}, ${selectedFile.path}`);
        console.log(`📏 Velikost: ${(selectedFile.bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`);
        
        // ✅ Pošli pouze ID video souboru
        await client.post(`/torrents/selectFiles/${torrentId}`, 
            `files=${fileId}`, // ✅ Pouze ID video souboru
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        console.log(`✅ Video soubor úspěšně vybrán (ID: ${fileId})`);
        return selectedFile; // Vrať info o vybraném souboru pro debug
        
    } catch (error) {
        console.error(`❌ selectFiles chyba: ${error.message}`);
        throw error;
    }
};

// ✅ SPRÁVNÁ addTorrentFile podle API dokumentace
const addTorrentFile = async (apiKey, torrentData, infoHash) => {
    const client = createRDClient(apiKey);

    try {
        console.log(`📥 Přidávám torrent soubor do RD pro ${infoHash}...`);
        console.log(`📦 Velikost: ${torrentData.byteLength} bytes`);

        // ✅ KLÍČOVÁ OPRAVA: PUT metoda s raw binary data
        console.log(`📤 Používám PUT /torrents/addTorrent s raw binary data`);

        const response = await client.put('/torrents/addTorrent', torrentData, {
            headers: {
                'Content-Type': 'application/x-bittorrent', // ✅ Správný Content-Type
                'Content-Length': torrentData.byteLength.toString()
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: function (status) {
                return status === 201; // ✅ API vrací 201 pro úspěch
            }
        });

        // ✅ Kontrola očekávaného status code
        if (response.status !== 201) {
            throw new Error(`Neočekávaný status code: ${response.status}, očekáván 201`);
        }

        const torrentId = response.data.id;
        const torrentUri = response.data.uri;

        console.log(`✅ Torrent úspěšně přidán: ${torrentId}`);
        console.log(`📋 URI: ${torrentUri}`);
        console.log(`📋 Response: ${JSON.stringify(response.data)}`);

        return {
            id: torrentId,
            uri: torrentUri
        };

    } catch (error) {
        console.error(`❌ addTorrentFile chyba: ${error.message}`);

        // ✅ Specifické error handling podle API dokumentace
        if (error.response) {
            const status = error.response.status;
            const data = error.response.data;

            console.error(`📋 HTTP Status: ${status}`);
            console.error(`📋 Response Data: ${JSON.stringify(data)}`);

            switch (status) {
                case 400:
                    console.error(`❌ Bad Request: ${data.error || 'Špatný požadavek'}`);
                    break;
                case 401:
                    console.error(`❌ Bad Token: Token je neplatný nebo expirovaný`);
                    break;
                case 403:
                    console.error(`❌ Permission Denied: Account uzamčen nebo není premium`);
                    break;
                case 503:
                    console.error(`❌ Service Unavailable: ${data.error || 'Služba nedostupná'}`);
                    break;
                default:
                    console.error(`❌ Neočekávaný HTTP error: ${status}`);
            }
        }

        throw error;
    }
};

// ✅ OPRAVENÁ pomocná funkce pro čekání na dokončení s lepším debugem
const waitForTorrentCompletion = async (client, torrentId) => {
    console.log(`⏳ Čekám na zpracování ${torrentId}...`);

    for (let i = 0; i < 24; i++) { // Max 6 minut (24 x 15s)
        try {
            await new Promise(resolve => setTimeout(resolve, 15000)); // Čekej 15s mezi kontrolami

            const torrentInfo = await client.get(`/torrents/info/${torrentId}`);
            const torrent = torrentInfo.data;

            console.log(`📊 Status: ${torrent.status} (${torrent.progress}%)`);

            if (torrent.status === 'downloaded' && torrent.links?.length > 0) {
                console.log(`✅ Torrent dokončen s ${torrent.links.length} linky`);
                
                // ✅ Debug - vypiš všechny linky s informacemi
                torrent.links.forEach((link, index) => {
                    console.log(`🔗 Link ${index + 1}: ${link}`);
                });

                const unrestrictedLinks = [];
                for (const link of torrent.links) {
                    try {
                        const directLink = await unrestrictLink(client, link);
                        unrestrictedLinks.push({ url: directLink });
                        console.log(`✅ Unrestricted: ${directLink}`);
                    } catch (e) {
                        console.warn(`⚠️ Unrestrict selhal pro ${link}: ${e.message}`);
                    }
                }

                if (unrestrictedLinks.length > 0) {
                    console.log(`🎉 Celkem ${unrestrictedLinks.length} direct linků připraveno`);
                    return unrestrictedLinks;
                }
            }

            if (torrent.status === 'error') {
                throw new Error(`Torrent error: ${torrent.status}`);
            }
            
            // Debug další stavy
            if (torrent.status === 'waiting_files_selection') {
                console.log(`📋 Čekám na výběr souborů...`);
            } else if (torrent.status === 'magnet_conversion') {
                console.log(`🧲 Konvertuji torrent...`);
            } else if (torrent.status === 'downloading') {
                console.log(`⬇️ Stahování probíhá...`);
                return [downloadingLink];
            } else if (torrent.status === 'queued') {
                console.log(`⏰ Ve frontě...`);
            }

        } catch (error) {
            console.error(`❌ Chyba při čekání (pokus ${i+1}): ${error.message}`);
            if (i === 23) throw error;
        }
    }

    throw new Error('Timeout při čekání na zpracování (6 minut)');
};

// ✅ HLAVNÍ FUNKCE - torrent soubor priorita s inteligentním výběrem
const addTorrentIfNotExists = async (apiKey, torrentData, infoHash) => {
    const client = createRDClient(apiKey);

    try {
        console.log(`🔄 RD: Zpracovávám torrent ${infoHash}`);
        let torrentId = undefined;
        let torrentStatus = undefined;

        // 1. Zkontroluj existující torrenty
        try {
            const existingTorrents = await client.get('/torrents');
            const existing = existingTorrents.data.find(t =>
                t.hash && t.hash.toLowerCase() === infoHash.toLowerCase()
            );

            if (existing?.status === 'downloading') {
                console.log(`⬇️ Stahování probíhá...`);
                return [downloadingLink];
            }

            if (existing?.status === 'downloaded' && existing.links?.length > 0) {
                console.log(`✅ Torrent již existuje: ${existing.id}`);

                const unrestrictedLinks = [];
                for (const link of existing.links) {
                    try {
                        const directLink = await unrestrictLink(client, link);
                        unrestrictedLinks.push({ url: directLink });
                    } catch (e) {
                        console.warn(`⚠️ Unrestrict selhal: ${e.message}`);
                    }
                }

                if (unrestrictedLinks.length > 0) {
                    return unrestrictedLinks;
                }
            }

            torrentId = existing?.id;
            torrentStatus = existing?.status;
        } catch (error) {
            console.warn(`⚠️ Chyba při kontrole existujících: ${error.message}`);
        }

        if (torrentId === undefined) {
            // 2. ✅ Přidej torrent soubor pomocí PUT
            console.log(`📤 Přidávám torrent soubor pomocí PUT metody`);
            const addResult = await addTorrentFile(apiKey, torrentData, infoHash);
            torrentId = addResult.id;
            torrentStatus = 'waiting_files_selection';
        }

        if (['waiting_files_selection', 'magnet_conversion'].includes(torrentStatus)) {
            // 3. ✅ Inteligentní výběr pouze video souborů
            console.log(`🎬 Vybírám video soubory pomocí inteligentní analýzy...`);
            const selectedFile = await selectTorrentFiles(client, torrentId);

            if (selectedFile) {
                console.log(`🎯 Vybraný soubor: ${selectedFile.path} (${(selectedFile.bytes / (1024 * 1024 * 1024)).toFixed(2)} GB)`);
            }
        }

        // 4. Čekej na zpracování
        console.log(`⏳ Čekám na zpracování...`);
        return await waitForTorrentCompletion(client, torrentId);

    } catch (error) {
        console.error(`❌ addTorrentIfNotExists celková chyba: ${error.message}`);
        throw error;
    }
};

// ✅ MAGNET funkce (zachována pro kompatibilitu) - také s inteligentním výběrem
const addMagnetIfNotExists = async (apiKey, magnetLink, infoHash) => {
    const client = createRDClient(apiKey);
    let torrentId = undefined;
    let torrentStatus = undefined;

    try {
        console.log(`🔄 RD: Zpracovávám magnet ${infoHash}`);

        // Zkontroluj existující
        try {
            const existingTorrents = await client.get('/torrents');
            const existing = existingTorrents.data.find(t =>
                t.hash && t.hash.toLowerCase() === infoHash.toLowerCase()
            );

            if (existing?.status === 'downloading') {
                console.log(`⬇️ Stahování probíhá...`);
                return [downloadingLink];
            }

            if (existing?.status === 'downloaded' && existing.links?.length > 0) {
                console.log(`✅ Magnet již existuje: ${existing.id}`);

                const unrestrictedLinks = [];
                for (const link of existing.links) {
                    try {
                        const directLink = await unrestrictLink(client, link);
                        unrestrictedLinks.push({ url: directLink });
                    } catch (e) {
                        console.warn(`⚠️ Unrestrict selhal: ${e.message}`);
                    }
                }

                if (unrestrictedLinks.length > 0) {
                    return unrestrictedLinks;
                }
            }

            torrentId = existing?.id;
            torrentStatus = existing?.status;
        } catch (error) {
            console.warn(`⚠️ Chyba při kontrole existujících: ${error.message}`);
        }

        if (torrentId === undefined) {
            // Přidej magnet
            console.log(`🧲 Přidávám magnet: ${magnetLink.substring(0, 100)}...`);

            const addResponse = await client.post('/torrents/addMagnet',
                `magnet=${encodeURIComponent(magnetLink)}`,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            console.log(`✅ Magnet přidán: ${torrentId}`);
            torrentId = addResponse.data.id;
            torrentStatus = 'waiting_files_selection';
        }

        if (['waiting_files_selection', 'magnet_conversion'].includes(torrentStatus)) {
            // ✅ Také pro magnet použij inteligentní výběr souborů
            console.log(`🎬 Vybírám video soubory pro magnet...`);
            await selectTorrentFiles(client, torrentId);
        }

        return await waitForTorrentCompletion(client, torrentId);

    } catch (error) {
        console.error(`❌ addMagnetIfNotExists chyba: ${error.message}`);
        throw error;
    }
};

// Export funkcí
module.exports = {
    addTorrentIfNotExists,
    addMagnetIfNotExists,
    unrestrictLink
};
