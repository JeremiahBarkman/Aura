import { SceneRenderer } from '../rendering/SceneRenderer.js';
import { SceneImageCache } from '../rendering/SceneImageCache.js';

export class LiveCompositor {
    constructor({
        videoElement,
        outputCanvas,
        segmentationProvider
    }) {
        this.video = videoElement;
        this.canvas = outputCanvas;
        this.ctx = outputCanvas.getContext('2d');

        this.segmentationProvider = segmentationProvider;

        /*
            Legacy single-image background path.

            Kept for compatibility with existing code that still calls:
            setBackgroundImage(imageUrl)
        */
        this.backgroundImage = null;
        this.backgroundCanvas = document.createElement('canvas');
        this.backgroundCtx = this.backgroundCanvas.getContext('2d');

        /*
            Active Scene v2 background path.

            This lets the camera/PsySeg compositor use the same scene renderer
            as Slide Output:
            - single
            - dual
            - triple
            - aura
        */
        this.activeScene = null;
        this.sceneCanvas = document.createElement('canvas');
        this.sceneRenderer = new SceneRenderer(this.sceneCanvas);
        this.sceneImageCache = new SceneImageCache();

        this.running = false;
        this.mode = 'replace'; // replace | blur | remove
    }

    imageUrlFromPath(imagePath, workflowName = '') {
        if (!imagePath) {
            return '';
        }

        const normalized = imagePath.replaceAll('\\', '/');
        const fileName = normalized.split('/').pop();

        // Match on /images/imports/ (not /data/images/imports/) so both the
        // dev layout (<repo>/data/images/...) and the packaged layout
        // (userData/images/...) classify correctly.
        if (normalized.includes('/images/imports/')) {
            return `/imported-images/${encodeURIComponent(fileName)}`;
        }

        if (normalized.includes('/images/manual/')) {
            return `/manual-images/${encodeURIComponent(fileName)}`;
        }

        if (normalized.includes('/images/generated/') || normalized.includes('/ComfyUI/output/')) {
            return `/generated-images/${encodeURIComponent(fileName)}`;
        }

        return `/manual-images/${encodeURIComponent(fileName)}`;
    }

    async setBackgroundImage(imageUrl) {
        const img = new Image();
        img.crossOrigin = 'anonymous';

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = imageUrl;
        });

        this.backgroundImage = img;

        /*
            If legacy single-image mode is used, clear active scene mode.
        */
        this.activeScene = null;
    }

    async setActiveScene(scene) {
        if (!scene || !Array.isArray(scene.slots) || !scene.slots.length) {
            this.activeScene = null;
            return;
        }

        /*
            Preload scene images once.

            renderFrame() must stay fast and should not load images every frame.
        */
        await this.sceneImageCache.loadSlots(
            scene.slots,
            this.imageUrlFromPath.bind(this)
        );

        this.activeScene = scene;
        this.backgroundImage = null;
        this.mode = 'replace';
    }

    setMode(mode) {
        this.mode = mode;
    }

    resize() {
        if (!this.video.videoWidth || !this.video.videoHeight) {
            return;
        }

        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;

        this.backgroundCanvas.width = this.canvas.width;
        this.backgroundCanvas.height = this.canvas.height;

        this.sceneCanvas.width = this.canvas.width;
        this.sceneCanvas.height = this.canvas.height;
    }

    getCameraImageData() {
        this.ctx.drawImage(
            this.video,
            0,
            0,
            this.canvas.width,
            this.canvas.height
        );

        return this.ctx.getImageData(
            0,
            0,
            this.canvas.width,
            this.canvas.height
        );
    }

    getBackgroundImageData() {
        /*
            Preferred path:
            Active Scene v2 background rendered through shared SceneRenderer.
        */
        if (this.activeScene) {
            this.sceneRenderer.resize(
                this.canvas.width,
                this.canvas.height
            );

            this.sceneRenderer.render(
                this.activeScene,
                this.sceneImageCache.images
            );

            return this.sceneCanvas
                .getContext('2d')
                .getImageData(
                    0,
                    0,
                    this.sceneCanvas.width,
                    this.sceneCanvas.height
                );
        }

        /*
            Legacy fallback:
            Single background image.
        */
        this.backgroundCtx.clearRect(
            0,
            0,
            this.backgroundCanvas.width,
            this.backgroundCanvas.height
        );

        this.backgroundCtx.fillStyle = '#000000';

        this.backgroundCtx.fillRect(
            0,
            0,
            this.backgroundCanvas.width,
            this.backgroundCanvas.height
        );

        if (this.backgroundImage) {
            this.backgroundCtx.drawImage(
                this.backgroundImage,
                0,
                0,
                this.backgroundCanvas.width,
                this.backgroundCanvas.height
            );
        }

        return this.backgroundCtx.getImageData(
            0,
            0,
            this.backgroundCanvas.width,
            this.backgroundCanvas.height
        );
    }

    getCanvasBlurredCameraBackgroundImageData(blurPx = 32) {
    const blurCanvas =
        document.createElement('canvas');

    const blurCtx =
        blurCanvas.getContext('2d');

    blurCanvas.width = this.canvas.width;
    blurCanvas.height = this.canvas.height;

    blurCtx.filter = `blur(${blurPx}px)`;

    blurCtx.drawImage(
        this.video,
        0,
        0,
        blurCanvas.width,
        blurCanvas.height
    );

    blurCtx.filter = 'none';

    return blurCtx.getImageData(
        0,
        0,
        blurCanvas.width,
        blurCanvas.height
    );
}

compositeForegroundOverBackground(foregroundImageData, backgroundImageData) {
    const output =
        this.ctx.createImageData(
            foregroundImageData.width,
            foregroundImageData.height
        );

    const fg = foregroundImageData.data;
    const bg = backgroundImageData.data;
    const out = output.data;

    for (let i = 0; i < fg.length; i += 4) {
        const alpha =
            fg[i + 3] / 255;

        out[i] =
            Math.round((fg[i] * alpha) + (bg[i] * (1 - alpha)));

        out[i + 1] =
            Math.round((fg[i + 1] * alpha) + (bg[i + 1] * (1 - alpha)));

        out[i + 2] =
            Math.round((fg[i + 2] * alpha) + (bg[i + 2] * (1 - alpha)));

        out[i + 3] = 255;
    }

    return {
        data: output
    };
}

compositeCameraWithMaskOverBackground(cameraImageData, maskImageData, backgroundImageData) {
    const output =
        this.ctx.createImageData(
            cameraImageData.width,
            cameraImageData.height
        );

    const camera = cameraImageData.data;
    const mask = maskImageData.data;
    const bg = backgroundImageData.data;
    const out = output.data;

    for (let i = 0; i < camera.length; i += 4) {
        const maskAlpha =
            mask[i + 3] < 255
                ? mask[i + 3] / 255
                : ((mask[i] + mask[i + 1] + mask[i + 2]) / 3) / 255;

        out[i] =
            Math.round((camera[i] * maskAlpha) + (bg[i] * (1 - maskAlpha)));

        out[i + 1] =
            Math.round((camera[i + 1] * maskAlpha) + (bg[i + 1] * (1 - maskAlpha)));

        out[i + 2] =
            Math.round((camera[i + 2] * maskAlpha) + (bg[i + 2] * (1 - maskAlpha)));

        out[i + 3] = 255;
    }

    return {
        data: output
    };
}

    async renderFrame() {
        if (!this.video.videoWidth) {
            return;
        }

        this.resize();

        const cameraImageData = this.getCameraImageData();

        let result;

       if (this.mode === 'blur') {
    result = await this.segmentationProvider.blurBackground(
        cameraImageData,
        {
            blur: 80,
            erode: 1,
            gamma: 0,
            isRemoveBlob: true,
            skipAlpha: false,
            worker: false,
            backend: 'webgl'
        }
    );

} else if (this.mode === 'remove') {
    result = await this.segmentationProvider.removeBackground(
        cameraImageData
    );

} else {
    const backgroundImageData =
        this.getBackgroundImageData();

    result = await this.segmentationProvider.replaceBackground(
        cameraImageData,
        backgroundImageData,
        {
            isRemoveBlob: true
        }
    );
}
        
        if (result && result.data) {
            this.ctx.putImageData(result.data, 0, 0);
        }
    }

    start() {
        if (this.running) {
            return;
        }

        this.running = true;

        const loop = async () => {
            if (!this.running) {
                return;
            }

            try {
                await this.renderFrame();
            } catch (error) {
                console.error('LiveCompositor frame error:', error);
            }

            requestAnimationFrame(loop);
        };

        loop();
    }

    stop() {
        this.running = false;
    }
}