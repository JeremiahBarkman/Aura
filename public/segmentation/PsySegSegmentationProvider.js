import { SegmentationProvider } from './SegmentationProvider.js?v=2';

export class PsySegSegmentationProvider extends SegmentationProvider {
    constructor() {
        super();

        this.psyseg = null;
        this.videoElement = null;
        this.canvasElement = null;
        this.outputCtx = null;
        this.renderMode = null;
        this.isRunning = false;
        this.backgroundImage = null;

        // Bumped every time the replace-mode background changes. Each rendered
        // frame is stamped with the generation that produced it, so the output
        // window can tell exactly when the first new-background frame has been
        // composited and start its crossfade in sync with it (instead of
        // guessing, which made transitions fire before the new content was
        // actually visible).
        this.backgroundGeneration = 0;

        this.inputCanvas = document.createElement('canvas');
        this.inputCtx = this.inputCanvas.getContext('2d', { willReadFrequently: true });

        this.backgroundCanvas = document.createElement('canvas');
        this.backgroundCtx = this.backgroundCanvas.getContext('2d', { willReadFrequently: true });

        // The replace-mode background is static between scene switches, so
        // its pixels are cached and only re-read when the image or output
        // size actually changes -- avoiding a full-frame getImageData
        // readback on every single render frame.
        this.cachedBackgroundPixels = null;
        this.cachedBackgroundWidth = 0;
        this.cachedBackgroundHeight = 0;
        this.backgroundScratch = null;

        // Active background crossfade. When set, getBackgroundImageData blends
        // transitionFrom -> transitionTo over transitionDurationMs, so the
        // transition happens inside the composited frame itself (visible in the
        // live camera view, the virtual camera, and the output window alike)
        // rather than as a separate overlay in one window.
        this.transitionActive = false;
        this.transitionFrom = null;
        this.transitionTo = null;
        this.transitionStartMs = 0;
        this.transitionDurationMs = 0;
        this.transitionType = 'crossfade';
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

        if (typeof this.psyseg.init === 'function') {
const response = await fetch('/api/config/psyseg');
const config = await response.json();

await this.psyseg.init({
    license: config.license,
    accessKey: config.accessKey,
    accessToken: config.accessToken
});
        }
    }

    attachVideo(videoElement) {
        this.videoElement = videoElement;
    }

    attachCanvas(canvasElement) {
        this.canvasElement = canvasElement;

        // Acquire the output context ONCE, with willReadFrequently, so the
        // canvas is CPU-backed. A canvas hands back the same context object
        // on every getContext call regardless of later options, so whoever
        // asks first decides the backing store. If the export service (which
        // must getImageData every frame) asks second, its flag is ignored and
        // every readback becomes a slow GPU->CPU texture stall. Claiming it
        // here, up front, keeps both putImageData (here) and getImageData
        // (export) on a fast CPU-backed surface.
        this.outputCtx = canvasElement.getContext('2d', {
            willReadFrequently: true
        });
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
        // Instant swap (no crossfade). Kept for compatibility; the animated
        // path is startBackgroundTransition.
        this.startBackgroundTransition(backgroundImage, 0);
    }

    /**
     * Switches the replace-mode background, optionally animating from the
     * current background over durationMs. The animation is rendered into the
     * composite by getBackgroundImageData, so it appears everywhere the
     * composited frame goes.
     *
     * transitionType:
     *   'crossfade' - direct dissolve, old and new blended simultaneously.
     *   'fade'      - dip through black: old -> black -> new.
     *
     * durationMs <= 0 (or no current background, or the render loop not yet
     * running) swaps instantly.
     */
    startBackgroundTransition(backgroundImage, durationMs = 0, transitionType = 'crossfade') {
        // Settle any in-flight crossfade to its target first, so a new
        // transition always starts from a clean image rather than a
        // half-blended one.
        if (this.transitionActive) {
            this.backgroundImage = this.transitionTo;
            this.transitionActive = false;
            this.transitionFrom = null;
            this.transitionTo = null;
        }

        this.backgroundGeneration++;
        this.renderMode = 'replace';
        this.cachedBackgroundPixels = null;

        const canAnimate =
            durationMs > 0 &&
            !!this.backgroundImage &&
            this.isRunning;

        if (!canAnimate) {
            this.backgroundImage = backgroundImage;

            // First background (or effect switch) -- kick off the render loop.
            if (!this.isRunning) {
                this.startRenderLoop();
            }

            return;
        }

        this.transitionFrom = this.backgroundImage;
        this.transitionTo = backgroundImage;
        this.transitionStartMs = performance.now();
        this.transitionDurationMs = durationMs;
        this.transitionType = transitionType === 'fade' ? 'fade' : 'crossfade';
        this.transitionActive = true;
        // The already-running render loop picks up the blended background on
        // its next frame; no loop restart (restarting caused visible strobing).
    }

    startRenderLoop() {
        this.isRunning = false;

        if (!this.videoElement || !this.canvasElement) {
            throw new Error('Video and canvas must be attached before rendering.');
        }

        if (!this.psyseg) {
            throw new Error('PsySeg must be initialized before rendering.');
        }

        // Schedule the next frame via BOTH requestVideoFrameCallback/rAF and
        // a setTimeout, whichever fires first. When the window is visible,
        // rVFC/rAF wins and drives smooth, frame-accurate rendering (the timer
        // is cleared before it fires). When the window is minimized, the OS
        // compositor stops driving rVFC/rAF, so the setTimeout takes over and
        // keeps the camera pipeline running at ~25 FPS instead of collapsing
        // to Chromium's ~1 FPS background rate. A getUserMedia video keeps
        // delivering fresh frames to drawImage while hidden, so this stays
        // correct. A re-entrancy guard prevents the two paths from both
        // running the same frame.
        const MINIMIZED_FALLBACK_MS = 40;

        const scheduleNextFrame = frame => {
            let dispatched = false;
            let timerId = null;

            const runOnce = () => {
                if (dispatched) {
                    return;
                }

                dispatched = true;

                if (timerId !== null) {
                    clearTimeout(timerId);
                }

                frame();
            };

            if (typeof this.videoElement.requestVideoFrameCallback === 'function') {
                this.videoElement.requestVideoFrameCallback(runOnce);
            } else {
                requestAnimationFrame(runOnce);
            }

            timerId = setTimeout(runOnce, MINIMIZED_FALLBACK_MS);
        };

        setTimeout(() => {
            this.isRunning = true;

            const frame = async () => {
                if (!this.isRunning) {
                    // Intentional stop -- do not reschedule.
                    return;
                }

                // The whole body is guarded so that a single failing frame
                // (a broken background image mid-transition, a PsySeg hiccup, a
                // transient canvas error) is logged and skipped instead of
                // throwing out of the loop and permanently freezing the camera.
                // scheduleNextFrame ALWAYS runs in the finally, so the loop
                // survives any per-frame error.
                try {
                    if (!this.videoElement.videoWidth || !this.videoElement.videoHeight) {
                        return;
                    }

                    const width = this.videoElement.videoWidth;
                    const height = this.videoElement.videoHeight;

                    if (this.inputCanvas.width !== width || this.inputCanvas.height !== height) {
                        this.inputCanvas.width = width;
                        this.inputCanvas.height = height;
                    }

                    if (this.canvasElement.width !== width || this.canvasElement.height !== height) {
                        this.canvasElement.width = width;
                        this.canvasElement.height = height;
                    }

                    this.inputCtx.drawImage(this.videoElement, 0, 0, width, height);

                    const inputImageData = this.inputCtx.getImageData(0, 0, width, height);

                    let result = null;

                    if (this.renderMode === 'blur') {
                        result = await this.psyseg.blurBackground(inputImageData, {
                            blur: 39,
                            erode: 1,
                            gamma: 0,
                            isRemoveBlob: true,
                            skipAlpha: false,
                            worker: false,
                            backend: 'webgl',
                            dstSize: { width, height }
                        });
                    }

                    if (this.renderMode === 'remove') {
                        result = await this.psyseg.removeBackground(inputImageData, {
                            dstSize: { width, height }
                        });
                    }

                    if (this.renderMode === 'replace') {
                        const backgroundImageData = this.getBackgroundImageData(width, height);

                        result = await this.psyseg.replaceBackground(
                            inputImageData,
                            backgroundImageData,
                            {
                                dstSize: { width, height }
                            }
                        );
                    }

                    if (result && result.data) {
                        const outputCtx =
                            this.outputCtx ||
                            this.canvasElement.getContext('2d', { willReadFrequently: true });

                        outputCtx.putImageData(result.data, 0, 0);

                        // Signal downstream consumers (frame export) that a new
                        // frame is available, so they can skip re-exporting an
                        // unchanged canvas.
                        this.canvasElement.__auraFrameId =
                            (this.canvasElement.__auraFrameId || 0) + 1;

                        // Stamp the background generation this frame was
                        // composited with, so the output window can sync its
                        // crossfade to the first frame that shows the new
                        // background.
                        this.canvasElement.__auraBackgroundGeneration =
                            this.backgroundGeneration;
                    }
                } catch (error) {
                    console.error('Segmentation render frame failed (continuing):', error);
                } finally {
                    if (this.isRunning) {
                        scheduleNextFrame(frame);
                    }
                }
            };

            scheduleNextFrame(frame);
        }, 0);
    }

    getBackgroundImageData(width, height) {
        // During a crossfade the background changes every frame, so bypass the
        // static cache and composite the blended background live.
        if (this.transitionActive) {
            return this.getTransitionBackgroundImageData(width, height);
        }

        // The background only changes when the scene (backgroundImage) or the
        // output size changes. Re-drawing + reading it back every frame was a
        // full-frame GPU->CPU readback on the hot render path. Read it back
        // once into a cache, then hand PsySeg a fresh copy each frame (a cheap
        // in-memory copy, not a GPU readback). The copy keeps us safe if
        // PsySeg writes into the background buffer it's given.
        const backgroundDrawable =
            this.backgroundImage &&
            this.backgroundImage.complete &&
            this.backgroundImage.naturalWidth > 0;

        // A background image that is set but still decoding must NOT be baked
        // into the cache, or the cached black frame would stick even after the
        // image finishes. Force a rebuild every frame until it's drawable.
        const backgroundPending =
            this.backgroundImage && !backgroundDrawable;

        const needsRebuild =
            backgroundPending ||
            !this.cachedBackgroundPixels ||
            this.cachedBackgroundWidth !== width ||
            this.cachedBackgroundHeight !== height;

        if (needsRebuild) {
            if (this.backgroundCanvas.width !== width || this.backgroundCanvas.height !== height) {
                this.backgroundCanvas.width = width;
                this.backgroundCanvas.height = height;
            }

            this.backgroundCtx.clearRect(0, 0, width, height);

            if (backgroundDrawable) {
                this.backgroundCtx.drawImage(
                    this.backgroundImage,
                    0,
                    0,
                    width,
                    height
                );
            } else {
                this.backgroundCtx.fillStyle = '#000000';
                this.backgroundCtx.fillRect(0, 0, width, height);
            }

            const pixels =
                this.backgroundCtx.getImageData(0, 0, width, height).data;

            this.backgroundScratch = null;

            if (backgroundPending) {
                // Transient: don't cache a not-yet-ready background. Return
                // this frame's pixels directly and rebuild next frame.
                const transient = new ImageData(width, height);
                transient.data.set(pixels);
                return transient;
            }

            this.cachedBackgroundPixels = pixels;
            this.cachedBackgroundWidth = width;
            this.cachedBackgroundHeight = height;
        }

        if (
            !this.backgroundScratch ||
            this.backgroundScratch.width !== width ||
            this.backgroundScratch.height !== height
        ) {
            this.backgroundScratch =
                new ImageData(width, height);
        }

        this.backgroundScratch.data.set(this.cachedBackgroundPixels);

        return this.backgroundScratch;
    }

    getTransitionBackgroundImageData(width, height) {
        const now = performance.now();

        let progress =
            this.transitionDurationMs > 0
                ? (now - this.transitionStartMs) / this.transitionDurationMs
                : 1;

        if (progress >= 1) {
            // Crossfade finished: settle on the target and hand back to the
            // cached (static) path, which rebuilds + caches the final image.
            this.backgroundImage = this.transitionTo;
            this.transitionActive = false;
            this.transitionFrom = null;
            this.transitionTo = null;
            this.cachedBackgroundPixels = null;

            return this.getBackgroundImageData(width, height);
        }

        if (progress < 0) {
            progress = 0;
        }

        const smoothstep = x => x * x * (3 - 2 * x);

        if (this.backgroundCanvas.width !== width || this.backgroundCanvas.height !== height) {
            this.backgroundCanvas.width = width;
            this.backgroundCanvas.height = height;
        }

        const ctx = this.backgroundCtx;

        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);

        // A background scene image can be momentarily un-drawable (still
        // decoding, or failed to load). drawImage on such an image throws, so
        // only draw when it's fully ready; otherwise that layer is simply
        // skipped (shows black) for this frame.
        const isDrawable = img =>
            img && img.complete && img.naturalWidth > 0;

        if (this.transitionType === 'fade') {
            // Dip through black: first half fades the old background out to
            // black, second half fades the new background in from black. At
            // the midpoint the frame is fully black.
            if (progress < 0.5) {
                const alpha = smoothstep(1 - progress / 0.5);

                if (isDrawable(this.transitionFrom)) {
                    ctx.globalAlpha = alpha;
                    ctx.drawImage(this.transitionFrom, 0, 0, width, height);
                }
            } else {
                const alpha = smoothstep((progress - 0.5) / 0.5);

                if (isDrawable(this.transitionTo)) {
                    ctx.globalAlpha = alpha;
                    ctx.drawImage(this.transitionTo, 0, 0, width, height);
                }
            }
        } else {
            // Crossfade: old fully opaque, new fading in over it. Both scene
            // images are opaque (rendered over black), so this is a clean
            // A*(1-t) + B*t dissolve across the whole frame.
            const t = smoothstep(progress);

            if (isDrawable(this.transitionFrom)) {
                ctx.globalAlpha = 1;
                ctx.drawImage(this.transitionFrom, 0, 0, width, height);
            }

            if (isDrawable(this.transitionTo)) {
                ctx.globalAlpha = t;
                ctx.drawImage(this.transitionTo, 0, 0, width, height);
            }
        }

        ctx.globalAlpha = 1;

        // Fresh ImageData each frame (blend changes every frame); getImageData
        // already returns a new buffer, so PsySeg can't corrupt a shared one.
        return ctx.getImageData(0, 0, width, height);
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