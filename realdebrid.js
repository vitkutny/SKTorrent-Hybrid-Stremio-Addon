const axios = require('axios');
const https = require('https');
const http = require('http');

const createClient = (apiKey) => axios.create({
    baseURL: 'https://api.real-debrid.com/rest/1.0',
    timeout: 15000,
    headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 15000 }),
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 10, timeout: 15000 })
});

const handleError = (error, context) => {
    const message = error.response?.data?.error || error.message;
    const status = error.response?.status || 500;
    let userMessage = message;
    // Speciální případ pro magnet_conversion
    if (message === 'parameter_missing' && error.response?.data?.error_details?.includes('{files} is missing')) {
        userMessage = 'Magnet link nelze zpracovat: chybí metadata nebo je torrent nekompletní. Zkuste jiný zdroj.';
    }
    if (error.response?.data?.error === 'magnet_error' || error.response?.data?.error === 'magnet_conversion') {
        userMessage = 'Magnet link nelze konvertovat. Pravděpodobně je neplatný nebo není dostatek seedů.';
    }
    console.error(`❌ ${context}: ${status} - ${userMessage}`);
    if (error.response?.data?.error_details) {
        console.error(`   Details: ${error.response.data.error_details}`);
    }
    if (error.response?.data?.error_code) {
        console.error(`   Code: ${error.response.data.error_code}`);
    }
    return null;
};

const waitForTorrent = async (apiKey, torrentId, maxMinutes = 2, isNew = false) => {
    const client = createClient(apiKey);
    const maxAttempts = maxMinutes * 6; // 10s intervaly
    const torrentType = isNew ? 'nový' : 'existující';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const { data } = await client.get(`/torrents/info/${torrentId}`);
            const { status, progress = 0, links } = data;
            console.log(`⏳ RD Progress (${torrentType}): ${progress}% (${status}) - ${attempt}/${maxAttempts}`);
            if (status === 'downloaded' && links) {
                console.log(`✅ Torrent ${torrentType} dokončen!`);
                return await getDownloadLinks(apiKey, links);
            }
            const terminalErrorStates = [
                'error', 'magnet_error', 'virus', 'dead',
                'magnet_conversion', 'timeout', 'failed'
            ];
            if (terminalErrorStates.includes(status)) {
                const errorMessages = {
                    'magnet_error': 'Neplatný nebo poškozený magnet link',
                    'magnet_conversion': 'Nelze konvertovat magnet link',
                    'virus': 'Detekován virus v torrentu',
                    'dead': 'Torrent je mrtvý (žádné seeders)',
                    'timeout': 'Timeout při zpracování',
                    'failed': 'Obecné selhání torrenta',
                    'error': 'Nespecifikovaná chyba'
                };
                const errorMsg = errorMessages[status] || `Neznámá chyba: ${status}`;
                console.log(`❌ Torrent ${torrentType} selhal s terminal stavem: ${status}`);
                console.log(`💡 Důvod: ${errorMsg}`);
                return null;
            }
            if (status === 'waiting_files_selection') {
                console.log(`🔧 Vybírám soubory pro ${torrentType} torrent: ${torrentId}`);
                await selectAllFiles(apiKey, torrentId);
                continue;
            }
            const activeStates = [
                'downloading', 'queued', 'uploading', 'compressing'
            ];
            if (activeStates.includes(status)) {
                console.log(`⏳ Torrent ${torrentType} je aktivní (${status}), čekám...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
                continue;
            }
            console.log(`⚠️ Neznámý stav torrenta: ${status}, pokračujem v čekání...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        } catch (error) {
            console.error(`❌ Chyba při kontrole ${torrentType} torrent: ${error.message}`);
            if (attempt < maxAttempts && error.response?.status >= 500) {
                console.log(`🔄 API chyba, zkouším znovu za 15s...`);
                await new Promise(resolve => setTimeout(resolve, 15000));
                continue;
            }
            return handleError(error, `Čekání na ${torrentType} torrent`);
        }
    }
    console.log(`⏰ Timeout při čekání na ${torrentType} torrent po ${maxMinutes} minutách`);
    return null;
};

const addNewTorrent = async (apiKey, magnetLink, maxWaitMinutes = 2) => {
    const client = createClient(apiKey);
    try {
        console.log(`📥 Přidávám nový torrent do RD...`);
        console.log(`🧲 Magnet: ${magnetLink}`);
        const formData = new URLSearchParams();
        formData.append('magnet', magnetLink);
        const { data } = await client.post('/torrents/addMagnet', formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const torrentId = data.id;
        console.log(`📥 Torrent přidán do RD: ${torrentId}`);
        console.log(`📋 Response:`, data);
        console.log(`🔧 Vybírám soubory pro spuštění torrenta...`);
        await selectAllFiles(apiKey, torrentId);
        return await waitForTorrent(apiKey, torrentId, maxWaitMinutes, true);
    } catch (error) {
        console.error(`❌ Detailní chyba při přidávání torrenta:`);
        console.error(`   Status: ${error.response?.status}`);
        console.error(`   Data:`, error.response?.data);
        console.error(`   Headers:`, error.response?.headers);
        return handleError(error, 'Přidání nového torrenta');
    }
};

const selectAllFiles = async (apiKey, torrentId, maxRetries = 5) => {
    const client = createClient(apiKey);
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            console.log(`🔧 Vybírám všechny soubory pro torrent: ${torrentId} (pokus ${attempt + 1}/${maxRetries})`);
            const formData = new URLSearchParams();
            formData.append('files', 'all');
            await client.post(`/torrents/selectFiles/${torrentId}`, formData, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            console.log(`✅ Vybrány všechny soubory pro torrent: ${torrentId}`);
            return;
        } catch (error) {
            const errData = error.response?.data;
            const isParamMissing = errData?.error === 'parameter_missing' &&
                errData?.error_details && errData.error_details.includes('{files} is missing');
            console.error(`❌ Chyba při výběru souborů:`, errData);
            if (isParamMissing && attempt < maxRetries - 1) {
                console.log('⏳ {files} is missing, čekám 3s a zkouším znovu...');
                await new Promise(resolve => setTimeout(resolve, 3000));
                attempt++;
                continue;
            }
            handleError(error, 'Výběr souborů');
            return;
        }
    }
    console.error(`❌ Nepodařilo se vybrat soubory pro torrent: ${torrentId} po ${maxRetries} pokusech.`);
};

const getDownloadLinks = async (apiKey, rdLinks) => {
    const client = createClient(apiKey);
    try {
        const linkPromises = rdLinks.slice(0, 3).map(async (link) => {
            try {
                const formData = new URLSearchParams();
                formData.append('link', link);
                const { data } = await client.post('/unrestrict/link', formData, {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });
                return {
                    filename: data.filename,
                    url: data.download,
                    filesize: data.filesize
                };
            } catch (error) {
                console.error(`❌ Chyba při unrestrict linku: ${error.message}`);
                return null;
            }
        });
        const results = await Promise.all(linkPromises);
        return results.filter(Boolean);
    } catch (error) {
        return handleError(error, 'Získání download linků');
    }
};

// Vždy přidej torrent do RD a čekej na jeho zpracování
const addMagnetIfNotExists = async (apiKey, magnetLink, infoHash, maxWaitMinutes = 2) => {
    if (!apiKey) {
        console.log(`❌ Žádný RD API klíč pro ${infoHash}`);
        return null;
    }
    try {
        return await addNewTorrent(apiKey, magnetLink, maxWaitMinutes);
    } catch (error) {
        console.log(`❌ RD: Výjimka při zpracování ${infoHash}: ${error.message}`);
        return handleError(error, 'RD operace');
    }
};

module.exports = {
    waitForTorrent,
    addMagnetIfNotExists,
    addNewTorrent,
    selectAllFiles,
    getDownloadLinks
};
