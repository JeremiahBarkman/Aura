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

        // Count of IPC sends dispatched but not yet acknowledged. Bounds
        // pathological backpressure only (see submitFrame); does not gate
        // normal per-frame cadence.
        this.inFlight = 0;

        this.frameNumber = 0;

        // Reused BGRA output buffer (resized on resolution change) so the
        // steady-state convert allocates nothing.
        this.bgraBuffer = null;
        this.bufferWidth = 0;
        this.bufferHeight = 0;
    }

    start() {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;

        // Push model: the segmentation provider calls submitFrame() with the
        // exact pixels it just composited. This replaces the old loop that
        // polled the canvas via getImageData every tick -- a second full
        // GPU->CPU readback per frame (~13 ms at 720p, measured) on top of the
        // one the segmentation loop already pays. Registering as the sink lets
        // the producer hand those pixels over directly, deleting the redundant
        // readback and the polling entirely.
        window.__auraFrameSink = this;
    }

    stop() {
        this.isRunning = false;

        if (window.__auraFrameSink === this) {
            window.__auraFrameSink = null;
        }
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

    // Called by the segmentation provider with the RGBA pixels it just
    // composited (result.data). No canvas readback here -- that is the whole
    // point. The convert runs inline (~a few ms), then the IPC send is fired
    // without awaiting so producer cadence is never gated on IPC latency.
    submitFrame(imageData, width, height) {
        if (
            !this.isRunning ||
            !imageData ||
            !width ||
            !height ||
            !window.auraElectron ||
            typeof window.auraElectron.sendAuraFrame !== 'function'
        ) {
            return;
        }

        // Send EVERY frame the producer hands us. ipcRenderer.invoke
        // structured-clones (copies) its args synchronously at call time, so
        // the buffer is safe to reuse the moment the call returns -- there is
        // no need to wait for the IPC round-trip. The old per-frame guard that
        // waited for the round-trip dropped export ~5 FPS below the producer
        // for no safety benefit. inFlight only guards against pathological
        // backpressure (main process unable to drain), never normal cadence.
        if (this.inFlight >= 3) {
            return;
        }

        try {
            const stride = width * 4;

            const bgra = this.ensureOutputBuffer(width, height);

            this.convertRgbaToOpaqueBgra(imageData.data, bgra);

            this.inFlight++;

            Promise.resolve(
                window.auraElectron.sendAuraFrame({
                    width,
                    height,
                    stride,
                    frameNumber: this.frameNumber,
                    timestampMs: Date.now(),
                    pixels: bgra
                })
            ).then(result => {
                if (result && result.success === false) {
                    console.warn('Aura frame export was not accepted:', result);
                }
            }).catch(error => {
                console.error('Aura frame export failed:', error);
            }).finally(() => {
                this.inFlight--;
            });

            this.frameNumber++;
        } catch (error) {
            console.error(
                'Aura frame export failed:',
                error
            );
        }
    }
}