function getBaseUrl() {
    if (process.env.EXTERNAL_DOMAIN) {
        return `https://${process.env.EXTERNAL_DOMAIN}`;
    }
    throw new Error('EXTERNAL_DOMAIN není nastaveno v .env');
}

module.exports = { getBaseUrl };
