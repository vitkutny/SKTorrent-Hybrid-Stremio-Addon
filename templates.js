const generateHomePage = (req, config, stats) => {
    const { hasApiKey, ADDON_API_KEY, rd, SKT_UID, STREAM_MODE, RATE_LIMIT_MAX } = config;
    const { getBaseUrl } = require('./base-url-manager');
    const baseUrl = getBaseUrl();

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>SKTorrent Hybrid Pro - Optimalizovaný</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #333; min-height: 100vh; }
                .container { background: white; border-radius: 15px; padding: 40px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); }
                h1 { color: #4a5568; text-align: center; margin-bottom: 10px; font-size: 2.5em; }
                .version-badge { background: #48bb78; color: white; padding: 5px 15px; border-radius: 20px; font-size: 0.9em; display: inline-block; margin-left: 10px; }
                .subtitle { text-align: center; color: #718096; font-size: 1.2em; margin-bottom: 40px; }
                .feature-highlight { background: #e6fffa; border: 2px solid #38b2ac; border-radius: 10px; padding: 20px; margin: 20px 0; text-align: center; }
                .auth-section { background: ${hasApiKey ? '#f0fff4' : '#fffaf0'}; border: 2px solid ${hasApiKey ? '#48bb78' : '#f56565'}; border-radius: 10px; padding: 30px; margin: 30px 0; text-align: center; }
                .install-section { background: #f7fafc; border: 2px solid #e2e8f0; border-radius: 10px; padding: 30px; margin: 30px 0; text-align: center; }
                .install-button { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px; display: inline-block; margin: 15px 10px; font-weight: bold; font-size: 1.1em; transition: transform 0.2s; }
                .install-button:hover { transform: translateY(-2px); }
                .install-button:disabled { background: #ccc; cursor: not-allowed; }
                code { background: #2d3748; color: #68d391; padding: 8px 12px; border-radius: 5px; font-family: 'Monaco', 'Consolas', monospace; word-break: break-all; display: inline-block; margin: 10px 0; }
                .success { background: #c6f6d5; border: 1px solid #68d391; border-radius: 5px; padding: 15px; margin: 20px 0; color: #276749; }
                .error { background: #fed7d7; border: 2px solid #fc8181; border-radius: 5px; padding: 20px; margin: 20px 0; color: #9b2c2c; font-weight: bold; }
                .warning { background: #fed7d7; border: 1px solid #fc8181; border-radius: 5px; padding: 15px; margin: 20px 0; color: #9b2c2c; }
                .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 30px 0; }
                .status-card { background: #f7fafc; border-radius: 10px; padding: 20px; text-align: center; border: 2px solid #e2e8f0; }
                .status-active { border-color: #48bb78; background: #f0fff4; }
                .status-inactive { border-color: #f56565; background: #fffaf0; }
                .emoji { font-size: 1.5em; margin-right: 10px; }
                .stats-section { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 10px; padding: 20px; margin: 20px 0; text-align: center; font-size: 0.9em; color: #6c757d; }
                .baseurl-info { background: #f0f9ff; border: 1px solid #0ea5e9; border-radius: 10px; padding: 15px; margin: 20px 0; font-size: 0.9em; color: #0c4a6e; }
                .footer { text-align: center; color: #718096; margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; }
                hr { border: none; height: 2px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 40px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 SKTorrent Hybrid Pro<span class="version-badge">v2.2.0 Optimalizovaný</span></h1>
                <p class="subtitle">Vysoce optimalizovaný addon s pokročilou bezpečností</p>

                <div class="baseurl-info">
                    <h4>🌐 Inteligentní URL konfigurace:</h4>
                    <p><strong>Aktuální URL:</strong> <code>${baseUrl}</code></p>
                    <p><strong>Optimalizace:</strong> Connection pooling, Session management, Smart cleanup</p>
                </div>

                <div class="feature-highlight">
                    <h3>⚡ Nové optimalizace v2.2.0</h3>
                    <p>🔧 Unifikované HTTP klienty + Connection pooling<br>
                    🔒 Vylepšený session management<br>
                    📊 Inteligentní cleanup a cache<br>
                    🛡️ Enhanced security validation<br>
                    📦 Modularizace kódu<br>
                    🚀 ~40% méně kódu při zachování funkcí</p>
                </div>

                <div class="auth-section">
                    <h2>${hasApiKey ? '✅ Autentizace aktivní' : '🔒 Vyžadována autentizace'}</h2>
                    ${hasApiKey ? 
                        '<div class="success">✅ API klíč ověřen - plný přístup povolen</div>' :
                        ADDON_API_KEY ? 
                            '<div class="error">🚫 Vyžadován platný API klíč pro přístup</div>' :
                            '<div class="warning">⚠️ Vývojový režim - bez zabezpečení</div>'
                    }
                </div>

                <div class="install-section">
                    <h2>📥 Instalace do Stremio</h2>
                    ${ADDON_API_KEY ? `
                        ${!hasApiKey ? `
                            <div class="error">
                                <h3>🔑 API klíč je povinný!</h3>
                                <p>Bez platného API klíče nebude addon fungovat.</p>
                            </div>
                        ` : ''}
                        <p><strong>Manifest URL:</strong></p>
                        <code>${baseUrl}/manifest.json?api_key=VÁŠ_KLÍČ</code>
                        ${hasApiKey ? `
                            <br><br>
                            <a href="/manifest.json?api_key=${req.query.api_key}" class="install-button">📋 Manifest</a>
                            <a href="stremio://${req.get('host')}/manifest.json?api_key=${req.query.api_key}" class="install-button">⚡ Instalovat</a>
                        ` : `
                            <br><br>
                            <button class="install-button" disabled>🔒 Vyžadován API klíč</button>
                        `}
                    ` : `
                        <div class="warning">VÝVOJOVÝ REŽIM - bez API klíče</div>
                        <code>${baseUrl}/manifest.json</code>
                        <br><br>
                        <a href="/manifest.json" class="install-button">📋 Manifest</a>
                    `}
                </div>

                <h2>🔧 Stav systému</h2>
                <div class="status-grid">
                    <div class="status-card ${ADDON_API_KEY ? 'status-active' : 'status-inactive'}">
                        <div class="emoji">${ADDON_API_KEY ? '🔐' : '⚠️'}</div>
                        <h3>Zabezpečení</h3>
                        <p>${ADDON_API_KEY ? 'API klíč aktivní' : 'Nezabezpečeno'}</p>
                    </div>
                    <div class="status-card ${rd ? 'status-active' : 'status-inactive'}">
                        <div class="emoji">${rd ? '✅' : '❌'}</div>
                        <h3>Real-Debrid</h3>
                        <p>${rd ? 'Připojeno' : 'Nenakonfigurováno'}</p>
                    </div>
                    <div class="status-card ${SKT_UID ? 'status-active' : 'status-inactive'}">
                        <div class="emoji">${SKT_UID ? '✅' : '❌'}</div>
                        <h3>SKTorrent</h3>
                        <p>${SKT_UID ? 'Přihlášen' : 'Nepřihlášen'}</p>
                    </div>
                    <div class="status-card status-active">
                        <div class="emoji">⚡</div>
                        <h3>Modularizace</h3>
                        <p>6 modulů aktivních</p>
                    </div>
                    <div class="status-card status-active">
                        <div class="emoji">🛡️</div>
                        <h3>Rate Limiting</h3>
                        <p>${RATE_LIMIT_MAX} req/hod</p>
                    </div>
                    <div class="status-card status-active">
                        <div class="emoji">🧹</div>
                        <h3>Smart Cleanup</h3>
                        <p>Každých 5 min</p>
                    </div>
                </div>

                <div class="stats-section">
                    <h3>📊 Statistiky</h3>
                    <p>Sessions: ${stats.sessions} | Cache: ${stats.cache} | BaseURLs: ${stats.baseUrls}</p>
                    <p>Auth: ${stats.authSessions} | Streaming: ${stats.activeProcessing}</p>
                </div>

                <hr>

                <div class="footer">
                    <p><strong>SKTorrent Hybrid Pro v2.2.0</strong> - Modularizovaná architektura</p>
                    <p>Vytvořeno s ❤️ pro Stremio komunitu</p>
                </div>
            </div>
        </body>
        </html>
    `;
};

module.exports = {
    generateHomePage
};
