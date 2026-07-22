import { SegmentationProvider } from './SegmentationProvider.js';

export class PsySegSegmentationProvider extends SegmentationProvider {
    constructor() {
        super();

        this.psyseg = null;
        this.videoElement = null;
        this.canvasElement = null;
        this.renderMode = null;
        this.isRunning = false;
        this.backgroundImage = null;
    }

    async initialize() {
        const PsySegGlobal =
            (window.PsySeg && window.PsySeg.default)
            || window.psyseg
            || window.Personify;

        if (!PsySegGlobal) {
            throw new Error('PsySeg constructor was not found.');
        }

        this.psyseg = new PsySegGlobal();
    }

    attachVideo(videoElement) {
        this.videoElement = videoElement;
    }

    attachCanvas(canvasElement) {
        this.canvasElement = canvasElement;
    }

    async blurBackground() {
        this.renderMode = 'blur';
        this.startRenderLoop();
    }

    async removeBackground() {
        this.renderMode = 'remove';
        this.startRenderLoop();
    }

    async replaceBackground(backgroundImage) {
        this.backgroundImage = backgroundImage;
        this.renderMode = 'replace';
        this.startRenderLoop();
    }

    startRenderLoop() {
        this.isRunning = false;
        if (!this.videoElement || !this.canvasElement) {
            throw new Error('Video and canvas must be attached before rendering.');
        }

        if (!this.psyseg) {
            throw new Error('PsySeg must be initialized before rendering.');
        }

        if (this.isRunning) {
            return;
        }

        this.isRunning = true;

        const frame = async () => {
            if (!this.isRunning) {
                return;
            }

            if (!this.videoElement.videoWidth) {
                requestAnimationFrame(frame);
                return;
            }

            this.canvasElement.width = this.videoElement.videoWidth;
            this.canvasElement.height = this.videoElement.videoHeight;

            if (this.renderMode === 'blur') {
                await this.psyseg.blurBackground(this.videoElement, this.canvasElement, {
                    blurStrength: 12
                });
            }

            if (this.renderMode === 'remove') {
                await this.psyseg.removeBackground(this.videoElement, this.canvasElement);
            }

            if (this.renderMode === 'replace') {
                await this.psyseg.replaceBackground(
                    this.videoElement,
                    this.canvasElement,
                    this.backgroundImage
                );
            }

            requestAnimationFrame(frame);
        };

        requestAnimationFrame(frame);
    }

    stop() {
        this.isRunning = false;
    }

    dispose() {
        this.stop();
        this.psyseg = null;
        this.videoElement = null;
        this.canvasElement = null;
        this.backgroundImage = null;
        this.renderMode = null;
    }
}