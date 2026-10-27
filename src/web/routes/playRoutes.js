const express = require('express');

function createPlayRoutes({
    playModeService,
    sceneSlotManager,
    sceneState,
    speechService,
    transcribeUpload
}) {
    const router = express.Router();

    // Play Mode's live speech chunks. The renderer used to post these straight
    // to the Whisper service: a cross-origin request to a hardcoded address,
    // a flask-cors dependency, and a second place that had to know
    // WHISPER_URL. Forwarding through here keeps one owner for that address
    // and lets the renderer stay same-origin. Chunks are forwarded from
    // memory -- a few seconds of audio each, needed by nothing once
    // transcribed, so writing them to the audio folder the way Record Mode
    // does would only leave files behind.
    router.post(
        '/api/play/transcribe',
        transcribeUpload.single('audio'),
        async (req, res) => {
            if (!req.file) {
                return res.status(400).json({
                    error: 'Audio chunk is required.'
                });
            }

            try {
                res.json(
                    await speechService.transcribeAudioBuffer(
                        req.file.buffer,
                        req.file.originalname || 'play-chunk.webm'
                    )
                );
            } catch (error) {
                res.status(502).json({
                    error: `Whisper transcription failed: ${error.message}`
                });
            }
        }
    );

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

    // Play Mode "Clear Scene": drop every filled slot and the published
    // scene, so the next match starts from an empty stage. activeAuraScene is
    // set back to null -- the same value it holds before the first match of a
    // session -- rather than an empty scene object, so consumers see exactly
    // the state they already handle at startup.
    router.post('/api/play/scene-slots/clear', (req, res) => {
        sceneSlotManager.clearSlots();

        sceneState.activeAuraScene = null;

        res.json({
            success: true,
            activeScene: null
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