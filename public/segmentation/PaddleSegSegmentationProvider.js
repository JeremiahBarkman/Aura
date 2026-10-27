import { SegmentationProvider } from './SegmentationProvider.js?v=2';

/**
 * PaddleSeg (PP-HumanSeg family) segmentation provider.
 *
 * Runs an ONNX-exported PaddleSeg model in the renderer via onnxruntime-web,
 * so segmentation stays in-process on the camera's own render loop -- no
 * Python sidecar, no per-frame HTTP round trip on the live camera path.
 *
 * Implements the SegmentationProvider contract. The live preview
 * (public/index.html) and the aura-live dev page drive it through that
 * surface plus the erodeLevel/blurLevel knobs behind the Webcam Live View
 * sliders; composited frames reach the virtual camera through the
 * window.__auraFrameSink handoff and the output window through the canvas
 * stamps (__auraFrameId / __auraBackgroundGeneration).
 *
 * A raw ONNX model returns only a mask, so this provider does its own
 * compositing. That is deliberately
 * done with canvas operations (drawImage / globalCompositeOperation /
 * ctx.filter), which Chromium runs on the GPU, rather than per-pixel JS loops
 * over a 720p frame every tick.
 */
export class PaddleSegSegmentationProvider extends SegmentationProvider {
    /**
     * @param {object}  [options]
     * @param {string}  [options.modelUrl]  ONNX model to load.
     * @param {string[]}[options.executionProviders] ORT backends, in
     *        preference order. WebGPU first, WASM as the portable fallback.
     */
    constructor(options = {}) {
        super();

        this.modelUrl =
            options.modelUrl || '/models/paddleseg/pp_humanseg.onnx';

        this.executionProviders =
            options.executionProviders || ['webgpu', 'wasm'];

        this.ort = null;
        this.session = null;

        // Resolved from the ONNX graph at initialize() rather than hardcoded:
        // PP-HumanSeg ships at several input sizes (portrait vs general, v1
        // vs v2 lite) and guessing wrong yields a silently garbage mask.
        this.inputName = null;
        this.outputName = null;
        this.modelWidth = 0;
        this.modelHeight = 0;

        this.videoElement = null;
        this.canvasElement = null;
        this.outputCtx = null;
        this.renderMode = null;
        this.isRunning = false;
        this.backgroundImage = null;

        // Bumped on every background change so the output window can sync its
        // crossfade to the first frame actually composited with the new
        // background.
        this.backgroundGeneration = 0;

        // See startRenderLoop.
        this.loopGeneration = 0;

        // Frame -> model input (downscale + normalize happen off this one).
        this.inputCanvas = document.createElement('canvas');
        this.inputCtx = this.inputCanvas.getContext('2d', { willReadFrequently: true });

        // Model output mask, at model resolution, before it is scaled up.
        this.maskCanvas = document.createElement('canvas');
        this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });

        // Person-only (background transparent) layer at frame resolution.
        this.personCanvas = document.createElement('canvas');
        this.personCtx = this.personCanvas.getContext('2d');

        // Composite scratch -- what actually gets read back once per frame.
        this.composeCanvas = document.createElement('canvas');
        this.composeCtx = this.composeCanvas.getContext('2d', { willReadFrequently: true });

        // Webcam Live View sliders. erode softens the mask edge; blur is the
        // background blur strength in blur mode.
        this.erodeLevel = 1;
        this.blurLevel = 39;

        // Reused across frames so steady-state inference allocates nothing.
        this.inputTensorData = null;
        this.maskImageData = null;

        // Whether the model's 2-channel output is already softmaxed.
        // PaddleSeg publishes both variants ("..._with_softmax" bakes a
        // Softmax node into the graph; the plain export emits raw logits), and
        // applying softmax to something already softmaxed does not error -- it
        // silently compresses the mask toward 0.5 and washes the cutout out.
        // Detected once from the first real output rather than configured,
        // so either export just works. null = not yet determined.
        this.outputIsProbabilities = null;

        this.transitionActive = false;
        this.transitionFrom = null;
        this.transitionTo = null;
        this.transitionStartMs = 0;
        this.transitionDurationMs = 0;
        this.transitionType = 'crossfade';
    }

    async initialize() {
        // The bundle build inlines the WASM binary, so no ort.env.wasm.wasmPaths
        // setup is needed -- important because Express serves /node_modules
        // statically and relative wasm resolution from there is fragile.
        this.ort = await import(
            '/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs'
        );

        let response;

        try {
            response = await fetch(this.modelUrl);
        } catch (error) {
            throw new Error(
                `PaddleSeg model could not be fetched from ${this.modelUrl}: ${error.message}`
            );
        }

        if (!response.ok) {
            throw new Error(
                `PaddleSeg model missing at ${this.modelUrl} (HTTP ${response.status}). ` +
                'Place an ONNX-exported PP-HumanSeg model there.'
            );
        }

        const modelBytes = new Uint8Array(await response.arrayBuffer());

        this.session = await this.ort.InferenceSession.create(modelBytes, {
            executionProviders: this.executionProviders,
            graphOptimizationLevel: 'all'
        });

        this.inputName = this.session.inputNames[0];
        this.outputName = this.session.outputNames[0];

        this.resolveModelInputSize();

        this.inputCanvas.width = this.modelWidth;
        this.inputCanvas.height = this.modelHeight;
        this.maskCanvas.width = this.modelWidth;
        this.maskCanvas.height = this.modelHeight;

        console.log(
            `PaddleSeg provider ready: ${this.modelUrl} ` +
            `(input ${this.inputName} ${this.modelWidth}x${this.modelHeight}, output ${this.outputName})`
        );
    }

    /**
     * PP-HumanSeg exports are NCHW with a static H/W, but the batch (and
     * occasionally the spatial dims) can come through as dynamic symbols.
     * Read what the graph declares and only fall back when it is genuinely
     * unresolvable, so a model at an unexpected size still works.
     */
    resolveModelInputSize() {
        const FALLBACK_WIDTH = 192;
        const FALLBACK_HEIGHT = 192;

        const meta =
            this.session.inputMetadata &&
            this.session.inputMetadata[this.inputName];

        const dims = meta && (meta.dimensions || meta.shape);

        // NCHW -> [batch, channels, height, width]
        if (Array.isArray(dims) && dims.length === 4) {
            const height = dims[2];
            const width = dims[3];

            if (Number.isInteger(height) && height > 0) {
                this.modelHeight = height;
            }

            if (Number.isInteger(width) && width > 0) {
                this.modelWidth = width;
            }
        }

        if (!this.modelWidth || !this.modelHeight) {
            this.modelWidth = FALLBACK_WIDTH;
            this.modelHeight = FALLBACK_HEIGHT;

            console.warn(
                'PaddleSeg: model input size is dynamic/unreadable; falling back to ' +
                `${FALLBACK_WIDTH}x${FALLBACK_HEIGHT}. Override with options.modelUrl ` +
                'for a statically-shaped export if the mask looks wrong.'
            );
        }
    }

    attachVideo(videoElement) {
        this.videoElement = videoElement;
    }

    attachCanvas(canvasElement) {
        this.canvasElement = canvasElement;

        // Claim the context first, with willReadFrequently: whoever calls
        // getContext first decides the backing store, and the export service
        // must not be the one that loses and turns every readback into a GPU
        // stall.
        this.outputCtx = canvasElement.getContext('2d', {
            willReadFrequently: true
        });
    }

    async blurBackground() {
        this.renderMode = 'blur';

        if (!this.isRunning) {
            this.startRenderLoop();
        }
    }

    async removeBackground() {
        this.renderMode = 'remove';

        if (!this.isRunning) {
            this.startRenderLoop();
        }
    }

    async replaceBackground(backgroundImage) {
        this.startBackgroundTransition(backgroundImage, 0);
    }

    startBackgroundTransition(backgroundImage, durationMs = 0, transitionType = 'crossfade') {
        if (this.transitionActive) {
            this.backgroundImage = this.transitionTo;
            this.transitionActive = false;
            this.transitionFrom = null;
            this.transitionTo = null;
        }

        this.backgroundGeneration++;
        this.renderMode = 'replace';

        if (durationMs <= 0) {
            this.backgroundImage = backgroundImage;

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

        if (!this.isRunning) {
            this.startRenderLoop();
        }
    }

    startRenderLoop() {
        if (!this.videoElement || !this.canvasElement) {
            throw new Error('Video and canvas must be attached before rendering.');
        }

        if (!this.session) {
            throw new Error('PaddleSeg must be initialized before rendering.');
        }

        // Dual scheduling: rVFC/rAF drives smooth frame-accurate rendering
        // while visible, and a timer takes over when the window is minimized
        // and the compositor stops driving rAF (which would otherwise collapse
        // the camera pipeline to ~1 FPS).
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

        // Every start gets its own generation and every scheduled callback
        // checks it. stop() followed quickly by a new start (Reset then Blur,
        // or a scene transition landing while the camera restarts) used to
        // leave the old loop's pending rVFC/timer callback alive: it woke
        // after the new loop had set isRunning again, so from then on two
        // loops ran the model and the compositing on every frame.
        const generation = ++this.loopGeneration;

        this.isRunning = true;

        const frame = async () => {
            if (!this.isRunning || generation !== this.loopGeneration) {
                return;
            }

            // Whole body guarded so one bad frame (a decoding background, a
            // transient ORT error) is logged and skipped rather than throwing
            // out of the loop and freezing the camera for good.
            try {
                if (!this.videoElement.videoWidth || !this.videoElement.videoHeight) {
                    return;
                }

                const width = this.videoElement.videoWidth;
                const height = this.videoElement.videoHeight;

                this.resizeSurfaces(width, height);

                await this.updatePersonLayer(width, height);

                const composited = this.composite(width, height);

                if (composited) {
                    this.outputCtx.putImageData(composited, 0, 0);

                    if (window.__auraFrameSink) {
                        window.__auraFrameSink.submitFrame(composited, width, height);
                    }

                    this.canvasElement.__auraFrameId =
                        (this.canvasElement.__auraFrameId || 0) + 1;

                    this.canvasElement.__auraBackgroundGeneration =
                        this.backgroundGeneration;
                }
            } catch (error) {
                console.error('PaddleSeg render frame failed (continuing):', error);
            } finally {
                if (this.isRunning && generation === this.loopGeneration) {
                    scheduleNextFrame(frame);
                }
            }
        };

        scheduleNextFrame(frame);
    }

    resizeSurfaces(width, height) {
        if (this.canvasElement.width !== width || this.canvasElement.height !== height) {
            this.canvasElement.width = width;
            this.canvasElement.height = height;
        }

        for (const canvas of [this.personCanvas, this.composeCanvas]) {
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
        }
    }

    /**
     * Runs the model on the current video frame and leaves a person-only
     * (background transparent) image in this.personCanvas at frame size.
     */
    async updatePersonLayer(width, height) {
        // Downscale straight into the model's input resolution.
        this.inputCtx.drawImage(
            this.videoElement,
            0, 0, this.modelWidth, this.modelHeight
        );

        const frame = this.inputCtx.getImageData(
            0, 0, this.modelWidth, this.modelHeight
        );

        const tensor = this.toInputTensor(frame);

        const outputs = await this.session.run({ [this.inputName]: tensor });

        this.writeMaskCanvas(outputs[this.outputName]);

        // Scale the low-res mask up to frame size and cut the person out of
        // the full-resolution video with it. Both steps are canvas/GPU work;
        // the mask never round-trips through JS at frame resolution.
        const ctx = this.personCtx;

        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(this.videoElement, 0, 0, width, height);

        // erodeLevel softens the mask edge. A small blur on the upscaled mask
        // is what keeps the cutout from looking like stair-stepped pixels,
        // and it is far cheaper than a real morphological erode in JS.
        ctx.filter = this.erodeLevel > 0
            ? `blur(${Math.min(this.erodeLevel, 8)}px)`
            : 'none';

        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(this.maskCanvas, 0, 0, width, height);

        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
    }

    /**
     * Normalizes an RGBA frame into the NCHW float tensor PP-HumanSeg expects.
     *
     * PP-HumanSeg's published preprocessing is mean/std 0.5 on each channel,
     * i.e. pixels mapped from [0,255] to [-1,1]. If a differently-exported
     * model produces an inverted or washed-out mask, this is the first thing
     * to check.
     */
    toInputTensor(frame) {
        const { width, height, data } = frame;
        const pixelCount = width * height;

        if (!this.inputTensorData || this.inputTensorData.length !== pixelCount * 3) {
            this.inputTensorData = new Float32Array(pixelCount * 3);
        }

        const out = this.inputTensorData;
        const greenPlane = pixelCount;
        const bluePlane = pixelCount * 2;

        for (let i = 0; i < pixelCount; i++) {
            const p = i * 4;

            out[i] = (data[p] / 255 - 0.5) / 0.5;
            out[greenPlane + i] = (data[p + 1] / 255 - 0.5) / 0.5;
            out[bluePlane + i] = (data[p + 2] / 255 - 0.5) / 0.5;
        }

        return new this.ort.Tensor('float32', out, [1, 3, height, width]);
    }

    /**
     * Turns the model output into a white-on-transparent alpha mask in
     * this.maskCanvas.
     *
     * Handles both common PP-HumanSeg output shapes: [1,2,H,W] (per-class
     * scores, person = channel 1) and [1,1,H,W] / [1,H,W] (a single person
     * probability). Anything else is rejected loudly rather than rendering
     * a plausible-looking wrong mask.
     */
    writeMaskCanvas(output) {
        const dims = output.dims;
        const data = output.data;

        const pixelCount = this.modelWidth * this.modelHeight;

        if (!this.maskImageData) {
            this.maskImageData = this.maskCtx.createImageData(
                this.modelWidth, this.modelHeight
            );
        }

        const mask = this.maskImageData.data;

        const isTwoClass = dims.length === 4 && dims[1] === 2;
        const isSingleChannel =
            (dims.length === 4 && dims[1] === 1) || dims.length === 3;

        if (!isTwoClass && !isSingleChannel) {
            throw new Error(
                `PaddleSeg: unsupported model output shape [${dims.join(', ')}]. ` +
                'Expected [1,2,H,W] class scores or [1,1,H,W] person probability.'
            );
        }

        if (isTwoClass && this.outputIsProbabilities === null) {
            this.outputIsProbabilities = this.detectProbabilityOutput(data, pixelCount);

            console.log(
                `PaddleSeg: model output treated as ${this.outputIsProbabilities
                    ? 'probabilities (softmax already in the graph)'
                    : 'raw logits (applying softmax)'}.`
            );
        }

        for (let i = 0; i < pixelCount; i++) {
            let personAlpha;

            if (isTwoClass) {
                const background = data[i];
                const person = data[pixelCount + i];

                if (this.outputIsProbabilities) {
                    personAlpha = person;
                } else {
                    // Softmax over the two class scores; equivalent to argmax
                    // but keeps a soft edge, which matters for hair and
                    // shoulders. Shifted by the max for numerical stability.
                    const maxScore = background > person ? background : person;

                    const expBackground = Math.exp(background - maxScore);
                    const expPerson = Math.exp(person - maxScore);

                    personAlpha = expPerson / (expBackground + expPerson);
                }
            } else {
                personAlpha = data[i];
            }

            const p = i * 4;

            mask[p] = 255;
            mask[p + 1] = 255;
            mask[p + 2] = 255;
            mask[p + 3] = Math.round(Math.min(Math.max(personAlpha, 0), 1) * 255);
        }

        this.maskCtx.putImageData(this.maskImageData, 0, 0);
    }

    /**
     * True when the two class channels already sum to 1 (a Softmax is baked
     * into the graph). Sampled across a spread of pixels rather than the whole
     * frame -- this runs once, but there is no reason to walk 36k pixels for a
     * yes/no answer. Raw logits essentially never sum to exactly 1 everywhere,
     * so a tight tolerance is safe.
     */
    detectProbabilityOutput(data, pixelCount) {
        const SAMPLES = 32;
        const TOLERANCE = 0.01;

        const stride = Math.max(1, Math.floor(pixelCount / SAMPLES));

        for (let i = 0; i < pixelCount; i += stride) {
            const sum = data[i] + data[pixelCount + i];

            if (Math.abs(sum - 1) > TOLERANCE) {
                return false;
            }
        }

        return true;
    }

    /**
     * Combines the person layer with whatever the current mode calls for and
     * returns the finished frame. One getImageData per frame, at the end --
     * the only full-frame readback on this path.
     */
    composite(width, height) {
        const ctx = this.composeCtx;

        ctx.globalAlpha = 1;
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, width, height);

        if (this.renderMode === 'blur') {
            // Chromium runs ctx.filter blur on the GPU, so this stays far
            // cheaper than blurring pixels in JS.
            ctx.filter = `blur(${Math.max(this.blurLevel, 0)}px)`;
            ctx.drawImage(this.videoElement, 0, 0, width, height);
            ctx.filter = 'none';
        } else if (this.renderMode === 'replace') {
            this.drawBackground(ctx, width, height);
        }
        // 'remove' leaves the composite transparent behind the person.

        ctx.drawImage(this.personCanvas, 0, 0, width, height);

        return ctx.getImageData(0, 0, width, height);
    }

    /**
     * Paints the replace-mode background, including an in-progress
     * crossfade/fade. Drawn into the composite itself so the transition is
     * visible everywhere the frame goes (preview, virtual camera, output
     * window) rather than as a per-window overlay.
     */
    drawBackground(ctx, width, height) {
        const isDrawable = img =>
            img && img.complete && img.naturalWidth > 0;

        if (!this.transitionActive) {
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, width, height);

            if (isDrawable(this.backgroundImage)) {
                ctx.drawImage(this.backgroundImage, 0, 0, width, height);
            }

            return;
        }

        let progress =
            this.transitionDurationMs > 0
                ? (performance.now() - this.transitionStartMs) / this.transitionDurationMs
                : 1;

        if (progress >= 1) {
            this.backgroundImage = this.transitionTo;
            this.transitionActive = false;
            this.transitionFrom = null;
            this.transitionTo = null;

            this.drawBackground(ctx, width, height);
            return;
        }

        if (progress < 0) {
            progress = 0;
        }

        const smoothstep = x => x * x * (3 - 2 * x);

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);

        if (this.transitionType === 'fade') {
            // Dip through black: old out, then new in.
            if (progress < 0.5) {
                if (isDrawable(this.transitionFrom)) {
                    ctx.globalAlpha = smoothstep(1 - progress / 0.5);
                    ctx.drawImage(this.transitionFrom, 0, 0, width, height);
                }
            } else if (isDrawable(this.transitionTo)) {
                ctx.globalAlpha = smoothstep((progress - 0.5) / 0.5);
                ctx.drawImage(this.transitionTo, 0, 0, width, height);
            }
        } else {
            // With no incoming image (Clear Scene, or a background that
            // failed to load) there is nothing to dissolve into, so the
            // outgoing image must fade itself out over black -- otherwise it
            // stays fully opaque for the whole duration and snaps to black at
            // the end.
            const t = smoothstep(progress);
            const hasIncoming = isDrawable(this.transitionTo);

            if (isDrawable(this.transitionFrom)) {
                ctx.globalAlpha = hasIncoming ? 1 : 1 - t;
                ctx.drawImage(this.transitionFrom, 0, 0, width, height);
            }

            if (hasIncoming) {
                ctx.globalAlpha = t;
                ctx.drawImage(this.transitionTo, 0, 0, width, height);
            }
        }

        ctx.globalAlpha = 1;
    }

    stop() {
        this.isRunning = false;
    }

    dispose() {
        this.stop();

        // ORT sessions hold GPU/WASM memory that garbage collection will not
        // reclaim on its own.
        if (this.session && typeof this.session.release === 'function') {
            this.session.release().catch(() => {});
        }

        this.session = null;
        this.ort = null;
        this.videoElement = null;
        this.canvasElement = null;
        this.backgroundImage = null;
        this.renderMode = null;
        this.inputTensorData = null;
        this.maskImageData = null;
    }
}
