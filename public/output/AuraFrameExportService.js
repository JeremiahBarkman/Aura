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

        // Recording indicator. Composited into the outgoing frame here rather
        // than drawn onto the live canvas, because the canvas is never read on
        // this path -- the provider hands pixels straight to submitFrame, and
        // anything drawn on auraLiveCanvas reaches only the local preview and
        // the Aura Output window. This is also the one seam both segmentation
        // providers pass through, so the badge does not have to be duplicated
        // into two render loops that already duplicate each other.
        this.recordingIndicator = false;
        this.badge = null;
    }

    /**
     * Shows or hides the recording badge on the outgoing camera frame.
     *
     * This is what other participants on a call see. It is Aura stating what
     * Aura is doing -- no meeting platform is told anything, because a local
     * loopback capture is invisible to Teams, Meet and Zoom by construction.
     */
    setRecordingIndicator(active) {
        this.recordingIndicator = Boolean(active);
    }

    /**
     * Rasterizes the badge once and caches its pixels.
     *
     * Re-rasterized only when the frame size changes, so the steady-state cost
     * per frame is the blit alone. Sized from frame height so it stays legible
     * at 720p without dominating at 1080p.
     */
    ensureBadge(frameWidth, frameHeight) {
        if (
            this.badge &&
            this.badge.frameWidth === frameWidth &&
            this.badge.frameHeight === frameHeight
        ) {
            return this.badge;
        }

        const height = Math.max(26, Math.round(frameHeight * 0.05));
        const fontSize = Math.round(height * 0.44);
        const dotRadius = Math.round(height * 0.16);
        const padding = Math.round(height * 0.38);
        const gap = Math.round(height * 0.30);

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Text is intentionally not localized: the audience is the other
        // people on the call, who do not necessarily share this user's UI
        // language.
        const label = 'RECORDING';

        ctx.font = `700 ${fontSize}px 'IBM Plex Mono', monospace`;

        const textWidth = ctx.measureText(label).width;
        const width = Math.round(padding * 2 + dotRadius * 2 + gap + textWidth);

        canvas.width = width;
        canvas.height = height;

        // Re-fetching the context's font after resizing: setting width/height
        // resets all canvas state.
        ctx.font = `700 ${fontSize}px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'middle';

        const radius = height / 2;

        ctx.beginPath();
        ctx.moveTo(radius, 0);
        ctx.lineTo(width - radius, 0);
        ctx.arcTo(width, 0, width, radius, radius);
        ctx.lineTo(width, height - radius);
        ctx.arcTo(width, height, width - radius, height, radius);
        ctx.lineTo(radius, height);
        ctx.arcTo(0, height, 0, height - radius, radius);
        ctx.lineTo(0, radius);
        ctx.arcTo(0, 0, radius, 0, radius);
        ctx.closePath();

        ctx.fillStyle = 'rgba(12, 10, 8, 0.72)';
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
        ctx.lineWidth = Math.max(1, Math.round(height * 0.03));
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(padding + dotRadius, height / 2, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#e0503a';
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, padding + dotRadius * 2 + gap, height / 2 + 1);

        const margin = Math.round(height * 0.6);

        this.badge = {
            frameWidth,
            frameHeight,
            width,
            height,
            // Top-right: the corner least often occupied by platform overlays
            // (names and mute badges sit bottom-left in Teams, Meet and Zoom).
            x: Math.max(0, frameWidth - width - margin),
            y: margin,
            pixels: ctx.getImageData(0, 0, width, height).data
        };

        return this.badge;
    }

    /**
     * Alpha-composites the cached badge into the BGRA frame buffer.
     *
     * Runs after the RGBA->BGRA conversion so it writes in the destination's
     * byte order and the provider's own pixel buffer is never mutated. Touches
     * only the badge rectangle -- roughly 1% of a 720p frame.
     */
    blitBadge(bgra, frameWidth, frameHeight) {
        const badge = this.ensureBadge(frameWidth, frameHeight);
        const source = badge.pixels;

        for (let row = 0; row < badge.height; row++) {
            const frameY = badge.y + row;

            if (frameY < 0 || frameY >= frameHeight) {
                continue;
            }

            for (let col = 0; col < badge.width; col++) {
                const frameX = badge.x + col;

                if (frameX < 0 || frameX >= frameWidth) {
                    continue;
                }

                const src = (row * badge.width + col) << 2;
                const alpha = source[src + 3];

                if (alpha === 0) {
                    continue;
                }

                const dst = (frameY * frameWidth + frameX) << 2;

                if (alpha === 255) {
                    bgra[dst + 0] = source[src + 2];
                    bgra[dst + 1] = source[src + 1];
                    bgra[dst + 2] = source[src + 0];
                    bgra[dst + 3] = 255;
                    continue;
                }

                const a = alpha / 255;
                const inverse = 1 - a;

                bgra[dst + 0] = source[src + 2] * a + bgra[dst + 0] * inverse;
                bgra[dst + 1] = source[src + 1] * a + bgra[dst + 1] * inverse;
                bgra[dst + 2] = source[src + 0] * a + bgra[dst + 2] * inverse;
                bgra[dst + 3] = 255;
            }
        }
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

            if (this.recordingIndicator) {
                this.blitBadge(bgra, width, height);
            }

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