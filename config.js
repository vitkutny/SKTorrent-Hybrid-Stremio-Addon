// config.js - centrální konfigurace

module.exports = {
  SKT_UID: process.env.SKT_UID || '',
  SKT_PASS: process.env.SKT_PASS || '',
  ADDON_API_KEY: process.env.ADDON_API_KEY || '',
  STREAM_MODE: process.env.STREAM_MODE || 'BOTH',
  BASE_URL: process.env.BASE_URL || 'https://sktorrent.eu',
  SEARCH_URL: process.env.SEARCH_URL || 'https://sktorrent.eu/torrent/torrents_v2.php',
  RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX || 100
};
