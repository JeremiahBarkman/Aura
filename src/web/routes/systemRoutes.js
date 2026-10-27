// ============================================================================
// Aura System / Config / Group Routes
// ============================================================================
// Purpose:
// - System health checks
// - Aura runtime config API
// - Library group list/create routes
//
// These routes are intentionally extracted from server.js so server.js can
// become a lightweight app bootstrap instead of owning every Aura subsystem.
// ============================================================================

const express = require('express');

function createSystemRoutes({
    db,
    auraConfig
}) {
    const router = express.Router();

    // SerpAPI's account.json is a free, quota-exempt endpoint (per SerpAPI's
    // own docs) so calling it doesn't cost search credits, but the client
    // polls /api/system/status every 10s and there's no reason to make an
    // external HTTPS round-trip that often -- cache the result for a minute.
    let serpApiStatusCache = { checkedAt: 0, ok: false };
    const SERPAPI_STATUS_CACHE_MS = 60000;

    async function checkSerpApiStatus() {
        const apiKey = process.env.SERPAPI_KEY;

        if (!apiKey) {
            return false;
        }

        const now = Date.now();

        if (now - serpApiStatusCache.checkedAt < SERPAPI_STATUS_CACHE_MS) {
            return serpApiStatusCache.ok;
        }

        let ok = false;

        try {
            const url = new URL('https://serpapi.com/account.json');
            url.searchParams.set('api_key', apiKey);

            const response = await fetch(url);
            const body = await response.json();

            ok = response.ok && !body.error;
        } catch {}

        serpApiStatusCache = { checkedAt: now, ok };

        return ok;
    }

    // -------------------------------------------------------------------------
    // System Health Route
    // -------------------------------------------------------------------------
    router.get('/api/system/status', async (req, res) => {
        const status = {
            auraDb: true,
            whisper: false,
            comfyUi: false,
            ollama: false,
            serpApi: false
        };

        const whisperUrl =
            process.env.WHISPER_URL || 'http://127.0.0.1:8765';

        const comfyUiUrl =
            process.env.COMFYUI_URL || 'http://127.0.0.1:8188';

        const ollamaUrl =
            process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

        // Bounded: the client polls this every 10s, and a service that has
        // accepted the TCP connection but stopped answering (ComfyUI mid-load
        // does this) would otherwise hold each poll open until Node's own
        // socket timeout, stacking requests behind one stuck socket.
        const probe = url =>
            fetch(url, { signal: AbortSignal.timeout(3000) })
                .then(response => response.ok)
                .catch(() => false);

        [status.whisper, status.comfyUi, status.ollama] = await Promise.all([
            probe(`${whisperUrl}/health`),
            probe(`${comfyUiUrl}/`),
            probe(`${ollamaUrl}/api/tags`)
        ]);

        status.serpApi = await checkSerpApiStatus();

        res.json(status);
    });

    // -------------------------------------------------------------------------
    // Aura Application Configuration Routes
    // -------------------------------------------------------------------------
    router.get('/api/config', (req, res) => {
        res.json({
            success: true,
            config: auraConfig.readConfig()
        });
    });

    router.patch('/api/config', (req, res) => {
        res.json({
            success: true,
            config: auraConfig.updateConfig(req.body || {})
        });
    });

    // -------------------------------------------------------------------------
    // Library Group Routes
    // -------------------------------------------------------------------------
    router.get('/api/groups', (req, res) => {
        const groups = db.prepare(`
            SELECT
                id,
                name,
                description,
                created_at
            FROM library_groups
            ORDER BY name ASC
        `).all();

        res.json(groups);
    });

    router.post('/api/groups', (req, res) => {
        const name =
            String(req.body.name || '').trim();

        const description =
            String(req.body.description || '').trim();

        if (!name) {
            return res.status(400).json({
                error: 'Group name is required.'
            });
        }

        try {
            const result = db.prepare(`
                INSERT INTO library_groups (name, description)
                VALUES (?, ?)
            `).run(
                name,
                description
            );

            res.json({
                success: true,
                groupId: result.lastInsertRowid,
                name,
                description
            });
        } catch (error) {
            res.status(400).json({
                error: error.message
            });
        }
    });

    return router;
}

module.exports = createSystemRoutes;