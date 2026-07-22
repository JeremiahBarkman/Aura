// ============================================================================
// Aura Frame Export Service
// ============================================================================
// Exports the final Aura live canvas to Electron, which forwards frames to
// AuraFrameBridge through the native named pipe.
//
// Design goals:
// - Export at approximately 30 FPS.
// - Never allow overlapping frame exports.
// - Reuse the BGRA output buffer instead of allocating one every frame.
// - Flatten partially transparent canvas pixels into opaque BGRA output.
// - Avoid per-frame console logging.
// ============================================================================

export class AuraFrameExportService {
    constructor(canvas) {
        if (!canvas) {
            throw new Error(
                'AuraFrameExportService requires a canvas.'
            );
        }

        this.canvas = canvas;

        this.ctx = canvas.getContext('2d', {
            willReadFrequently: true
        });

        if (!this.ctx) {
            throw new Error(
                'AuraFrameExportService could not obtain a 2D canvas context.'
            );
        }

        this.isRunning = false;
        this.frameInProgress = false;

        this.frameNumber = 0;

        // Target approximately 30 frames per second.
        this.intervalMs = 33;

        this.bgraBuffer = null;
        this.bufferWidth = 0;
        this.bufferHeight = 0;

        this.loopTimer = null;

        this.lastStatusLogMs = 0;
        this.framesExportedSinceStatus = 0;

        // The compositor updates the canvas at its own (sub-30) rate. The
        // export loop ticks at 30 FPS, so without this it would re-read,
        // re-convert, and re-send byte-identical duplicate frames -- pure
        // wasted work competing with the render loop. Track the canvas's
        // frame id (bumped by the segmentation provider on each new frame)
        // and skip export when nothing has changed.
        this.lastExportedFrameId = -1;
    }

    start() {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;

        this.scheduleNextFrame(0);
    }

    stop() {
        this.isRunning = false;

        if (this.loopTimer) {
            clearTimeout(this.loopTimer);
            this.loopTimer = null;
        }
    }

    scheduleNextFrame(delayMs = this.intervalMs) {
        if (!this.isRunning) {
            return;
        }

        this.loopTimer = setTimeout(() => {
            this.loop();
        }, Math.max(0, delayMs));
    }

    async loop() {
        if (!this.isRunning) {
            return;
        }

        const startedAt =
            performance.now();

        await this.exportFrame();

        const elapsedMs =
            performance.now() - startedAt;

        /*
            Subtract export time from the target interval.

            This avoids:
                export time + 33 ms delay

            and instead aims for approximately one frame every 33 ms.
        */
        const remainingDelay =
            Math.max(
                0,
                this.intervalMs - elapsedMs
            );

        this.scheduleNextFrame(
            remainingDelay
        );
    }

    ensureOutputBuffer(width, height) {
        const requiredLength =
            width * height * 4;

        if (
            !this.bgraBuffer ||
            this.bgraBuffer.length !== requiredLength ||
            this.bufferWidth !== width ||
            this.bufferHeight !== height
        ) {
            this.bgraBuffer =
                new Uint8Array(requiredLength);

            this.bufferWidth = width;
            this.bufferHeight = height;
        }

        return this.bgraBuffer;
    }

    convertRgbaToOpaqueBgra(
        rgba,
        bgra
    ) {
        /*
            Canvas getImageData() returns unpremultiplied RGBA.

            The native camera output is opaque BGRA. Merely copying RGB while
            discarding alpha can expose invalid colors around partially
            transparent PsySeg edges.

            Composite each pixel over black:

                outputColor = sourceColor × alpha

            Alpha is then forced to 255.

            Fully opaque pixels remain unchanged. Transparent and partially
            transparent edge pixels no longer reveal stale RGB values.

            The vast majority of composited pixels are fully opaque
            (alpha 255), so those are handled a whole 32-bit pixel at a time
            with a byte swizzle instead of four separate byte writes. Only
            genuinely semi-transparent edge pixels fall back to the
            per-channel premultiply path.
        */
        const pixelCount = rgba.length >>> 2;

        const in32 = new Uint32Array(
            rgba.buffer,
            rgba.byteOffset,
            pixelCount
        );

        const out32 = new Uint32Array(
            bgra.buffer,
            bgra.byteOffset,
            pixelCount
        );

        for (let i = 0; i < pixelCount; i++) {
            const p = in32[i]; // little-endian bytes R,G,B,A -> 0xAABBGGRR
            const alpha = p >>> 24;

            if (alpha === 255) {
                // Want BGRA bytes B,G,R,A (LE 0xAARRGGBB): swap R and B.
                out32[i] =
                    0xFF000000 |
                    ((p & 0x000000FF) << 16) |
                    (p & 0x0000FF00) |
                    ((p & 0x00FF0000) >>> 16);
            } else if (alpha === 0) {
                out32[i] = 0xFF000000;
            } else {
                const alphaScale = alpha / 255;
                const base = i << 2;

                bgra[base + 0] = Math.round(rgba[base + 2] * alphaScale);
                bgra[base + 1] = Math.round(rgba[base + 1] * alphaScale);
                bgra[base + 2] = Math.round(rgba[base + 0] * alphaScale);
                bgra[base + 3] = 255;
            }
        }
    }

    async exportFrame() {
        if (
            this.frameInProgress ||
            !this.canvas.width ||
            !this.canvas.height ||
            !window.auraElectron ||
            typeof window.auraElectron.sendAuraFrame !== 'function'
        ) {
            return;
        }

        // Skip if the compositor hasn't produced a new frame since the last
        // export. undefined means no producer is tagging frames, so fall
        // through and export unconditionally rather than stalling forever.
        const frameId = this.canvas.__auraFrameId;

        if (frameId !== undefined && frameId === this.lastExportedFrameId) {
            return;
        }

        this.lastExportedFrameId = frameId;

        this.frameInProgress = true;

        try {
            const width =
                this.canvas.width;

            const height =
                this.canvas.height;

            const stride =
                width * 4;

            const imageData =
                this.ctx.getImageData(
                    0,
                    0,
                    width,
                    height
                );

            const bgra =
                this.ensureOutputBuffer(
                    width,
                    height
                );

            this.convertRgbaToOpaqueBgra(
                imageData.data,
                bgra
            );

            const result =
                await window.auraElectron.sendAuraFrame({
                    width,
                    height,
                    stride,
                    frameNumber: this.frameNumber,
                    timestampMs: Date.now(),
                    pixels: bgra
                });

            if (
                result &&
                result.success === false
            ) {
                console.warn(
                    'Aura frame export was not accepted:',
                    result
                );
            }

            this.frameNumber++;
            this.framesExportedSinceStatus++;

            this.logPeriodicStatus(
                width,
                height
            );

        } catch (error) {
            console.error(
                'Aura frame export failed:',
                error
            );
        } finally {
            this.frameInProgress = false;
        }
    }

    logPeriodicStatus(width, height) {
        const now =
            performance.now();

        if (!this.lastStatusLogMs) {
            this.lastStatusLogMs = now;
            this.framesExportedSinceStatus = 0;
            return;
        }

        const elapsedMs =
            now - this.lastStatusLogMs;

        if (elapsedMs < 5000) {
            return;
        }

        const measuredFps =
            (
                this.framesExportedSinceStatus *
                1000 /
                elapsedMs
            ).toFixed(1);

        console.info(
            `Aura frame export: ${measuredFps} FPS, ` +
            `${width}x${height}, frame ${this.frameNumber}`
        );

        this.lastStatusLogMs = now;
        this.framesExportedSinceStatus = 0;
    }
}