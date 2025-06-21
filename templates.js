const generateHomePage = (req, config, stats) => {
    const { hasApiKey, ADDON_API_KEY, rd, SKT_UID } = config;
    const { getBaseUrl } = require('./base-url-manager');
    const baseUrl = getBaseUrl();

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>SKTorrent Hybrid Addon</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; background: #f7fafc; color: #222; }
                .container { background: white; border-radius: 12px; padding: 32px; box-shadow: 0 8px 24px rgba(0,0,0,0.07); }
                h1 { color: #4a5568; text-align: center; margin-bottom: 8px; font-size: 2.1em; }
                .version-badge { background: #3182ce; color: white; padding: 3px 12px; border-radius: 16px; font-size: 0.95em; margin-left: 8px; }
                .subtitle { text-align: center; color: #718096; font-size: 1.1em; margin-bottom: 28px; }
                .status { display: flex; justify-content: center; gap: 18px; margin: 18px 0 28px 0; }
                .status-card { background: #f1f5f9; border-radius: 8px; padding: 16px 20px; text-align: center; min-width: 120px; border: 1px solid #e2e8f0; }
                .status-active { border-color: #38a169; background: #f0fff4; }
                .status-inactive { border-color: #e53e3e; background: #fff5f5; }
                .install-section { background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 22px; margin: 24px 0; text-align: center; }
                .install-button { background: #3182ce; color: white; padding: 10px 22px; text-decoration: none; border-radius: 20px; display: inline-block; margin: 10px 6px; font-weight: bold; font-size: 1em; transition: background 0.2s; }
                .install-button:hover { background: #2563eb; }
                code { background: #2d3748; color: #68d391; padding: 6px 10px; border-radius: 5px; font-family: 'Monaco', 'Consolas', monospace; word-break: break-all; display: inline-block; margin: 8px 0; }
                .footer { text-align: center; color: #718096; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 0.95em; }
                a.repo-link { color: #3182ce; text-decoration: none; }
                a.repo-link:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>SKTorrent Hybrid Addon <span class="version-badge">v1.0.0</span></h1>
                <p class="subtitle">Moderní Stremio addon pro SKTorrent.eu s Real-Debrid podporou a bezpečností</p>

                <div class="status">
                    <div class="status-card ${ADDON_API_KEY ? 'status-active' : 'status-inactive'}">
                        <strong>API klíč</strong><br>${ADDON_API_KEY ? 'Aktivní' : 'Nezabezpečeno'}
                    </div>
                    <div class="status-card ${rd ? 'status-active' : 'status-inactive'}">
                        <strong>Real-Debrid</strong><br>${rd ? 'Připojeno' : 'Neaktivní'}
                    </div>
                    <div class="status-card ${SKT_UID ? 'status-active' : 'status-inactive'}">
                        <strong>SKTorrent</strong><br>${SKT_UID ? 'OK' : 'Chybí'}
                    </div>
                </div>

                <div class="install-section">
                    <h2>📥 Instalace do Stremio</h2>
                    <p><strong>Manifest URL:</strong></p>
                    <code id="manifest-url">${baseUrl}/manifest.json${ADDON_API_KEY ? '?api_key=VÁŠ_KLÍČ' : ''}</code>
                    <br><br>
                    <input type="text" id="api-key-input" placeholder="Vložte svůj API klíč" style="padding:8px 12px;border-radius:6px;border:1px solid #cbd5e1;width:220px;font-size:1em;" value="${req.query.api_key || ''}">
                    <br><br>
                    <a id="manifest-link" href="/manifest.json${ADDON_API_KEY ? '?api_key=' + (req.query.api_key || '') : ''}" class="install-button">📋 Manifest</a>
                    <a id="stremio-link" href="stremio://${req.get('host')}/manifest.json${ADDON_API_KEY ? '?api_key=' + (req.query.api_key || '') : ''}" class="install-button">⚡ Instalovat do Stremio</a>
                    ${!req.query.api_key && ADDON_API_KEY ? '<div style="color:#e53e3e;margin-top:16px;">Pro plnou funkčnost zadejte platný <b>api_key</b> v URL nebo do pole výše.</div>' : ''}
                </div>
                <script>
                (function() {
                    var input = document.getElementById('api-key-input');
                    var manifestUrl = document.getElementById('manifest-url');
                    var manifestLink = document.getElementById('manifest-link');
                    var stremioLink = document.getElementById('stremio-link');
                    var baseUrl = "${baseUrl}";
                    var host = "${req.get('host')}";
                    var hasApiKey = Boolean(${ADDON_API_KEY ? 'true' : 'false'});
                    function updateLinks() {
                        var key = input.value.trim();
                        var suffix = hasApiKey && key ? ('?api_key=' + encodeURIComponent(key)) : (hasApiKey ? '?api_key=VÁŠ_KLÍČ' : '');
                        manifestUrl.textContent = baseUrl + '/manifest.json' + suffix;
                        manifestLink.href = '/manifest.json' + suffix;
                        stremioLink.href = 'stremio://' + host + '/manifest.json' + suffix;
                    }
                    input.addEventListener('input', updateLinks);
                    updateLinks();
                })();
                </script>

                <div class="footer">
                    <p>Projekt: <a class="repo-link" href="https://github.com/Martin22/SKTorrent-Hybrid-Stremio-Addon" target="_blank">SKTorrent-Hybrid-Stremio-Addon</a></p>
                    <p>Poděkování původnímu autorovi: <a class="repo-link" href="https://github.com/JohnnyK007/Sktorrent-Stremio-addon" target="_blank">JohnnyK007/Sktorrent-Stremio-addon</a></p>
                </div>
            </div>
        </body>
        </html>
    `;
};

module.exports = {
    generateHomePage
};
