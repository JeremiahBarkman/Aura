const express = require('express');

function createPlayRoutes({
    playModeService,
    sceneSlotManager,
    sceneState
}) {
    const router = express.Router();

    router.post('/api/play/match', async (req, res) => {
        const spokenText =
            String(req.body.spokenText || '').trim();

        const rawGroupId =
            req.body.groupId;

        const groupId =
            rawGroupId === null ||
            rawGroupId === undefined ||
            rawGroupId === ''
                ? null
                : Number(rawGroupId);

        if (!spokenText) {
            return res.status(400).json({
                error: 'spokenText is required.'
            });
        }

        const matches =
            await playModeService.findBestImageMatches(
                spokenText,
                5,
                groupId
            );

        if (matches.length > 0) {
            const bestMatch = matches[0];

            sceneSlotManager.setSceneMode('aura');
            sceneSlotManager.insertMatch(bestMatch);

            sceneState.activeAuraScene =
                sceneSlotManager.getActiveScene();
        }

        res.json({
            spokenText,
            groupId,
            matches,
            activeScene: sceneState.activeAuraScene
        });
    });

    router.post('/api/play/scene-slots/primary', (req, res) => {
        const match = req.body || {};

        if (!match.image_id || !match.image_path) {
            return res.status(400).json({
                success: false,
                error: 'image_id and image_path are required.'
            });
        }

        sceneSlotManager.setSceneMode(
            match.sceneMode || 'aura'
        );

        sceneSlotManager.insertPrimary(match);

        sceneState.activeAuraScene =
            sceneSlotManager.getActiveScene();

        res.json({
            success: true,
            activeScene: sceneState.activeAuraScene
        });
    });

    router.post('/api/play/scene-slots/supporting', (req, res) => {
        const match = req.body || {};

        if (!match.image_id || !match.image_path) {
            return res.status(400).json({
                success: false,
                error: 'image_id and image_path are required.'
            });
        }

        sceneSlotManager.setSceneMode(
            match.sceneMode || 'aura'
        );

        sceneSlotManager.insertSupporting(match);

        sceneState.activeAuraScene =
            sceneSlotManager.getActiveScene();

        res.json({
            success: true,
            activeScene: sceneState.activeAuraScene
        });
    });

    router.post('/api/play/scene-slots/match', (req, res) => {
        const match = req.body || {};

        if (!match.image_id || !match.image_path) {
            return res.status(400).json({
                success: false,
                error: 'image_id and image_path are required.'
            });
        }

        sceneSlotManager.setSceneMode(
            match.sceneMode || 'aura'
        );

        sceneSlotManager.insertMatch(match);

        sceneState.activeAuraScene =
            sceneSlotManager.getActiveScene();

        res.json({
            success: true,
            activeScene: sceneState.activeAuraScene
        });
    });

    router.post('/api/play/active-scene', (req, res) => {
        const incomingScene = req.body || {};

        if (Array.isArray(incomingScene.slots)) {
            sceneState.activeAuraScene = {
                version: 2,
                sceneMode: incomingScene.sceneMode || 'single',
                slots: incomingScene.slots.slice(0, 3),
                transition: {
                    type: incomingScene.transition?.type || 'fade',
                    durationMs: Number(incomingScene.transition?.durationMs || 800),
                    minimumDisplayMs: Number(incomingScene.transition?.minimumDisplayMs || 5000),
                    easing: incomingScene.transition?.easing || 'ease-in-out'
                },
                updatedAt: Date.now()
            };
        } else {
            sceneState.activeAuraScene = {
                version: 2,
                sceneMode: 'single',
                slots: [
                    {
                        image_id: incomingScene.image_id,
                        image_path: incomingScene.image_path,
                        workflow_name: incomingScene.workflow_name || '',
                        source_item_id: incomingScene.source_item_id,
                        score: incomingScene.score || 0,
                        rawMatch: incomingScene
                    }
                ],
                transition: {
                    type: 'fade',
                    durationMs: 800,
                    minimumDisplayMs: 5000,
                    easing: 'ease-in-out'
                },
                updatedAt: Date.now()
            };
        }

        res.json({
            success: true,
            activeScene: sceneState.activeAuraScene
        });
    });

    router.get('/api/play/active-scene', (req, res) => {
        res.json({
            activeScene: sceneState.activeAuraScene
        });
    });

    return router;
}

module.exports = createPlayRoutes;