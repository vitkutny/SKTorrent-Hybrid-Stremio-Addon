const diacritics = require('diacritics');
const parseTorrent = require('parse-torrent');

const removeDiacritics = str => diacritics.remove(str);

const shortenTitle = (title, wordCount = 3) =>
    title.split(/\s+/).slice(0, wordCount).join(" ");

const extractQuality = title => {
    const titleLower = title.toLowerCase();
    if (titleLower.includes('2160p') || titleLower.includes('4k')) return '4K';
    if (titleLower.includes('1080p')) return '1080p';
    if (titleLower.includes('720p')) return '720p';
    if (titleLower.includes('480p')) return '480p';
    return 'SD';
};

const validateInfoHash = infoHash =>
    !!infoHash && /^[a-fA-F0-9]{40}$/.test(infoHash);

const handleApiError = (error, context, res = null) => {
    const message = error?.response?.data?.error || error.message;
    const status = error?.response?.status || 500;
    console.error(`❌ ${context}: ${status} - ${message}`);
    if (res) {
        return res.status(status).json({
            error: `${context} selhal`,
            message,
            retryable: status >= 500 || status === 429
        });
    }
    return null;
};

const generateSearchQueries = (title, originalTitle, type, season, episode) => {
    const queries = new Set();
    const baseTitles = [title, originalTitle]
        .filter(Boolean)
        .map(t =>
            t.replace(/\(.*?\)/g, '').replace(/TV (Mini )?Series/gi, '').trim()
        );

    // Odstranění duplicitních titulů
    const uniqueTitles = [...new Set(baseTitles)];

    uniqueTitles.forEach(base => {
        const noDia = removeDiacritics(base);
        const short = shortenTitle(noDia);

        if (type === 'series' && season && episode) {
            const epTag = ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            [base, noDia, short].forEach(b => {
                queries.add(`${b}${epTag}`);
                queries.add(`${b}${epTag}`.replace(/[\':]/g, ''));
            });
        } else {
            [base, noDia, short].forEach(b => {
                queries.add(b);
                queries.add(b.replace(/[\':]/g, ''));
            });
        }
    });

    return queries;
};

module.exports = {
    removeDiacritics,
    shortenTitle,
    extractQuality,
    validateInfoHash,
    handleApiError,
    generateSearchQueries,
    parseTorrent // export pro jednotné použití
};

