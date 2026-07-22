export class SegmentationProvider {
    async initialize() {
        throw new Error('initialize() must be implemented.');
    }

    attachVideo(videoElement) {
        throw new Error('attachVideo() must be implemented.');
    }

    attachCanvas(canvasElement) {
        throw new Error('attachCanvas() must be implemented.');
    }

    async blurBackground() {
        throw new Error('blurBackground() must be implemented.');
    }

    async removeBackground() {
        throw new Error('removeBackground() must be implemented.');
    }

    async replaceBackground(backgroundImage) {
        throw new Error('replaceBackground() must be implemented.');
    }

    stop() {
        throw new Error('stop() must be implemented.');
    }

    dispose() {
        throw new Error('dispose() must be implemented.');
    }
}