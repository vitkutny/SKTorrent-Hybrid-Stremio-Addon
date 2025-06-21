const crypto = require('crypto');

function createAuthManager() {
    const sessions = new Map();
    const sessionKeys = new Map();
    const rateLimiter = new Map();
    const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hodin
    const RATE_LIMIT_WINDOW = 3600000; // 1 hodina
    const RATE_LIMIT_MAX = 100;

    const generateSessionId = () => crypto.randomBytes(32).toString('hex');

    const hashUserAgent = (userAgent) =>
        crypto.createHash('sha256').update(userAgent || 'unknown').digest('hex').substring(0, 16);

    const createUniqueClientId = (ip, userAgent) => `${ip}_${hashUserAgent(userAgent)}`;

    const getSessionFromRequest = (req) => {
        const sessionId = req.headers['x-session-id'] || req.cookies?.sessionId;
        const apiKeyDirect = req.query.api_key;
        const clientId = createUniqueClientId(req.ip, req.headers['user-agent']);

        if (sessionId) {
            const session = sessions.get(sessionId);
            if (session && session.expires > Date.now()) {
                return session;
            }
        }

        // Přímý API klíč pro kompatibilitu
        if (apiKeyDirect) {
            return { apiKey: apiKeyDirect, isLegacy: true, clientId };
        }

        // Legacy session keys
        const legacyKey = sessionKeys.get(req.ip) || sessionKeys.get(clientId);
        if (legacyKey) {
            return { apiKey: legacyKey, isLegacy: true, clientId };
        }

        return null;
    };
    const createSession = (apiKey, clientIp, userAgent) => {
        const sessionId = generateSessionId();
        const uniqueClientId = createUniqueClientId(clientIp, userAgent);

        sessions.set(sessionId, {
            apiKey,
            ip: clientIp,
            uniqueClientId,
            expires: Date.now() + SESSION_TTL,
            created: Date.now()
        });

        console.log(`🔑 Nová session: ${sessionId.substring(0, 8)}... pro ${uniqueClientId}`);
        return sessionId;
    };

    const checkRateLimit = (ip, maxRequests = RATE_LIMIT_MAX) => {
        const now = Date.now();
        const userRequests = rateLimiter.get(ip) || { requests: [], lastReset: now };

        userRequests.requests = userRequests.requests.filter(time => now - time < RATE_LIMIT_WINDOW);

        if (userRequests.requests.length >= maxRequests) {
            return false;
        }

        userRequests.requests.push(now);
        rateLimiter.set(ip, userRequests);
        return true;
    };

    const cleanupExpiredSessions = () => {
        const now = Date.now();
        let cleanedSessions = 0;
        let cleanedRateLimit = 0;

        // Cleanup sessions
        for (const [id, session] of sessions.entries()) {
            if (session.expires <= now) {
                sessions.delete(id);
                cleanedSessions++;
            }
        }

        // Cleanup legacy sessions při velkém počtu
        if (sessionKeys.size > 100) {
            sessionKeys.clear();
        }

        // Cleanup rate limiter
        for (const [ip, data] of rateLimiter.entries()) {
            data.requests = data.requests.filter(time => now - time < RATE_LIMIT_WINDOW);
            if (data.requests.length === 0) {
                rateLimiter.delete(ip);
                cleanedRateLimit++;
            }
        }

        if (cleanedSessions > 0 || cleanedRateLimit > 0) {
            console.log(`🧹 Auth cleanup: ${cleanedSessions} sessions, ${cleanedRateLimit} rate limits`);
        }
    };

    const getStats = () => ({
        sessions: sessions.size,
        legacySessions: sessionKeys.size,
        rateLimitEntries: rateLimiter.size
    });

    function setSessionKey(key, value) {
        sessionKeys.set(key, value);
    }

    function getAllSessionKeys() {
        return Array.from(sessionKeys.values());
    }

    return {
        getSessionFromRequest,
        createSession,
        checkRateLimit,
        cleanupExpiredSessions,
        getStats,
        createUniqueClientId,
        setSessionKey,
        getAllSessionKeys,
        SESSION_TTL
    };
}

module.exports = createAuthManager;
