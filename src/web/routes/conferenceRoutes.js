const fs = require('fs');
const express = require('express');

/**
 * Multer has already written the upload to disk by the time a handler runs, so
 * a rejected chunk leaves a file behind that no conference_chunks row points
 * at -- invisible to deleteSession, and never cleaned up. Every failure path
 * for a chunk upload has to discard the file it was given.
 */
function discardUploadedChunk(file) {
    if (!file || !file.path) return;

    try {
        fs.unlinkSync(file.path);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(
                '[AURA CONFERENCE] Could not discard rejected chunk:',
                file.path,
                error.message
            );
        }
    }
}

/**
 * Aura Conference routes.
 *
 * Phase 1 covers capture only: start a session, stream audio chunks to it
 * while the meeting runs, close it when recording stops. Transcription and
 * record generation are separate steps added on top of the same session.
 */
function createConferenceRoutes({
    conferenceService,
    conferenceProcessingService,
    conferenceDispatchService,
    chunkUpload
}) {
    const router = express.Router();

    router.post('/api/conference/sessions', (req, res) => {
        try {
            const rawGroupId = req.body.groupId;

            const groupId =
                rawGroupId === null ||
                rawGroupId === undefined ||
                rawGroupId === ''
                    ? null
                    : Number(rawGroupId);

            const session = conferenceService.createSession({
                title: req.body.title,
                groupId
            });

            res.json({
                success: true,
                session
            });
        } catch (error) {
            console.error('Conference session create failed:', error);

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * Receives one recorded chunk.
     *
     * The recorder keeps running while this uploads, so a failure here must be
     * reported precisely enough for the UI to show which chunk was lost
     * without stopping the meeting.
     */
    router.post(
        '/api/conference/sessions/:id/chunks',
        chunkUpload.single('audio'),
        (req, res) => {
            try {
                if (!req.file) {
                    return res.status(400).json({
                        success: false,
                        error: 'Audio chunk is required.'
                    });
                }

                const chunkIndex = Number(req.body.chunkIndex);

                if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
                    discardUploadedChunk(req.file);

                    return res.status(400).json({
                        success: false,
                        error: 'chunkIndex must be a non-negative integer.'
                    });
                }

                const rawDuration = Number(req.body.durationMs);

                const chunk = conferenceService.addChunk({
                    conferenceId: Number(req.params.id),
                    chunkIndex,
                    audioPath: req.file.path,
                    durationMs: Number.isFinite(rawDuration)
                        ? Math.round(rawDuration)
                        : null
                });

                res.json({
                    success: true,
                    chunk
                });
            } catch (error) {
                discardUploadedChunk(req.file);

                console.error('Conference chunk upload failed:', error);

                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    router.post('/api/conference/sessions/:id/finish', (req, res) => {
        try {
            const session = conferenceService.finishSession(
                Number(req.params.id)
            );

            res.json({
                success: true,
                session
            });
        } catch (error) {
            console.error('Conference finish failed:', error);

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    router.get('/api/conference/sessions', (req, res) => {
        try {
            res.json({
                success: true,
                sessions: conferenceService.listSessions()
            });
        } catch (error) {
            console.error('Conference list failed:', error);

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    router.get('/api/conference/sessions/:id', (req, res) => {
        try {
            const session = conferenceService.getSession(
                Number(req.params.id)
            );

            if (!session) {
                return res.status(404).json({
                    success: false,
                    error: 'Conference not found.'
                });
            }

            res.json({
                success: true,
                session
            });
        } catch (error) {
            console.error('Conference read failed:', error);

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * Starts transcription and extraction.
     *
     * Returns as soon as the job is accepted -- the work runs for minutes, and
     * the client follows it by polling GET /api/conference/sessions/:id.
     */
    router.post('/api/conference/sessions/:id/process', async (req, res) => {
        try {
            const session = await conferenceProcessingService.processConference(
                Number(req.params.id)
            );

            res.json({
                success: true,
                session
            });
        } catch (error) {
            console.error('Conference processing failed to start:', error);

            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * Generates images and draft records for the approved subjects.
     *
     * Like processing, this returns as soon as the job is accepted; ComfyUI
     * alone runs about 20 seconds per image.
     */
    router.post('/api/conference/sessions/:id/generate', (req, res) => {
        try {
            const session = conferenceDispatchService.dispatchConference(
                Number(req.params.id),
                { imagesPerSearch: req.body ? req.body.imagesPerSearch : undefined }
            );

            res.json({
                success: true,
                session
            });
        } catch (error) {
            console.error('Conference dispatch failed to start:', error);

            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });

    router.patch('/api/conference/topics/:id', (req, res) => {
        try {
            const topic = conferenceService.updateTopic(
                Number(req.params.id),
                req.body || {}
            );

            res.json({
                success: true,
                topic
            });
        } catch (error) {
            console.error('Conference topic update failed:', error);

            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });

    router.delete('/api/conference/sessions/:id', (req, res) => {
        try {
            const result = conferenceService.deleteSession(
                Number(req.params.id)
            );

            res.json({
                success: true,
                ...result
            });
        } catch (error) {
            console.error('Conference delete failed:', error);

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    return router;
}

module.exports = createConferenceRoutes;
