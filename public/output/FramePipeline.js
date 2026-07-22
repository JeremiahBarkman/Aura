// ============================================================================
// Aura Frame Pipeline
// ============================================================================
// Purpose:
// Receives finished/composited frames and distributes them to output publishers.
//
// Current publisher:
// - Aura Output window
//
// Future publishers:
// - Virtual camera
// - Recorder
// - Stream output
// - OBS/direct external sink
// ============================================================================

export class FramePipeline {
    constructor() {
        this.publishers = [];
        this.frameInProgress = false;
    }

    addPublisher(publisher) {
        if (!publisher) {
            return;
        }

        this.publishers.push(publisher);
    }

    async publishCanvas(canvas) {
        if (
            !canvas ||
            !canvas.width ||
            !canvas.height ||
            this.frameInProgress
        ) {
            return;
        }

        this.frameInProgress = true;

        try {
            const bitmap =
                await createImageBitmap(canvas);

            const frame = {
                width: canvas.width,
                height: canvas.height,
                bitmap,
                createdAt: Date.now()
            };

            for (const publisher of this.publishers) {
                publisher.publishFrame(frame);
            }
        } catch (error) {
            console.error('FramePipeline publish failed:', error);
        } finally {
            this.frameInProgress = false;
        }
    }

    publishTransition(transition) {
        for (const publisher of this.publishers) {
            if (typeof publisher.publishTransition === 'function') {
                publisher.publishTransition(transition);
            }
        }
    }

    dispose() {
        for (const publisher of this.publishers) {
            if (typeof publisher.dispose === 'function') {
                publisher.dispose();
            }
        }

        this.publishers = [];
    }
}