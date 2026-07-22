// ============================================================================
// Aura Scene Renderer
// ============================================================================
// Purpose:
// Draw Active Scene v3 scene layouts onto any canvas.
//
// This renderer is intentionally DOM-independent.
// It can later be reused by:
// - Slide Output
// - LiveCompositor
// - Camera Output
// - Future virtual webcam pipeline
// ============================================================================

export class SceneRenderer {
    constructor(canvas) {
        if (!canvas) {
            throw new Error('SceneRenderer requires a canvas.');
        }

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    resize(width, height) {
        if (!width || !height) {
            return;
        }

        if (this.canvas.width !== width) {
            this.canvas.width = width;
        }

        if (this.canvas.height !== height) {
            this.canvas.height = height;
        }
    }

    clear() {
        this.ctx.clearRect(
            0,
            0,
            this.canvas.width,
            this.canvas.height
        );

        this.ctx.fillStyle = '#000000';

        this.ctx.fillRect(
            0,
            0,
            this.canvas.width,
            this.canvas.height
        );
    }

    render(scene, loadedImages) {
        if (!scene || !Array.isArray(scene.slots)) {
            return;
        }

        const slots = scene.slots;

        if (!slots.length) {
            return;
        }

        this.clear();

        if (scene.sceneMode === 'dual' && slots.length >= 2) {
            this.renderDual(slots, loadedImages);
            this.renderBottomFade();
            return;
        }

        if (scene.sceneMode === 'triple' && slots.length >= 3) {
            this.renderTriple(slots, loadedImages);
            this.renderBottomFade();
            return;
        }

        if (scene.sceneMode === 'aura') {
            this.renderAura(slots, loadedImages);
            this.renderAuraVignette();
            this.renderBottomFade();
            return;
        }

        this.renderSingle(slots, loadedImages);
        this.renderBottomFade();
    }

    renderSingle(slots, loadedImages) {
        const slot = slots[0];

        const image =
            loadedImages.get(String(slot.image_id));

        if (!image) {
            return;
        }

        this.drawImageContain(
            image,
            0,
            0,
            this.canvas.width,
            this.canvas.height * 0.9
        );
    }

    renderDual(slots, loadedImages) {
        const leftImage =
            loadedImages.get(String(slots[0].image_id));

        const rightImage =
            loadedImages.get(String(slots[1].image_id));

        if (leftImage) {
            this.drawImageContain(
                leftImage,
                0,
                0,
                this.canvas.width * 0.5,
                this.canvas.height * 0.9
            );
        }

        if (rightImage) {
            this.drawImageContain(
                rightImage,
                this.canvas.width * 0.5,
                0,
                this.canvas.width * 0.5,
                this.canvas.height * 0.9
            );
        }
    }

    renderTriple(slots, loadedImages) {
    const leftImage =
        loadedImages.get(String(slots[0].image_id));

    const centerImage =
        loadedImages.get(String(slots[1].image_id));

    const rightImage =
        loadedImages.get(String(slots[2].image_id));

    const sectionWidth =
        this.canvas.width / 3;

    const sectionHeight =
        this.canvas.height * 0.9;

    if (leftImage) {
        this.drawImageContain(
            leftImage,
            0,
            0,
            sectionWidth,
            sectionHeight
        );
    }

    if (centerImage) {
        this.drawImageContain(
            centerImage,
            sectionWidth,
            0,
            sectionWidth,
            sectionHeight
        );
    }

    if (rightImage) {
        this.drawImageContain(
            rightImage,
            sectionWidth * 2,
            0,
            sectionWidth,
            sectionHeight
        );
    }
}

    drawImageContain(image, x, y, width, height) {
        const imageRatio =
            image.naturalWidth / image.naturalHeight;

        const boxRatio =
            width / height;

        let drawWidth;
        let drawHeight;

        if (imageRatio > boxRatio) {
            drawWidth = width;
            drawHeight = width / imageRatio;
        } else {
            drawHeight = height;
            drawWidth = height * imageRatio;
        }

        const drawX =
            x + ((width - drawWidth) / 2);

        const drawY =
            y + ((height - drawHeight) / 2);

        this.ctx.drawImage(
            image,
            drawX,
            drawY,
            drawWidth,
            drawHeight
        );
    }

    drawImageContainAlpha(image, x, y, width, height, alpha = 1) {
        this.ctx.save();

        this.ctx.globalAlpha = alpha;

        this.drawImageContain(
            image,
            x,
            y,
            width,
            height
        );

        this.ctx.restore();
    }

    /*
        Draws an image cover-fitted into a box, feathered by an elliptical
        alpha mask so its edges dissolve to transparent -- the "vignette"
        look Aura mode is built around. Matches the CSS mask-image treatment
        Slide Output uses for its DOM-based aura stage.

        Cover fit (crop) rather than contain (letterbox) is deliberate:
        with contain, an image whose aspect doesn't match the box leaves
        empty margins inside the ellipse, so the image's own hard edges
        survive the mask. Cover guarantees pixels reach the feather zone
        on every side.
    */
    drawImageVignette(image, x, y, width, height, alpha = 1) {
        const boxWidth = Math.max(1, Math.round(width));
        const boxHeight = Math.max(1, Math.round(height));

        if (!this._vignetteScratch) {
            this._vignetteScratch = document.createElement('canvas');
        }

        const scratch = this._vignetteScratch;
        const sctx = scratch.getContext('2d');

        if (scratch.width !== boxWidth) {
            scratch.width = boxWidth;
        }

        if (scratch.height !== boxHeight) {
            scratch.height = boxHeight;
        }

        sctx.clearRect(0, 0, boxWidth, boxHeight);
        sctx.globalCompositeOperation = 'source-over';

        // Cover fit: crop the source so the box is fully filled.
        const imageRatio = image.naturalWidth / image.naturalHeight;
        const boxRatio = boxWidth / boxHeight;

        let sourceX = 0;
        let sourceY = 0;
        let sourceWidth = image.naturalWidth;
        let sourceHeight = image.naturalHeight;

        if (imageRatio > boxRatio) {
            sourceWidth = image.naturalHeight * boxRatio;
            sourceX = (image.naturalWidth - sourceWidth) / 2;
        } else {
            sourceHeight = image.naturalWidth / boxRatio;
            sourceY = (image.naturalHeight - sourceHeight) / 2;
        }

        sctx.drawImage(
            image,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            0,
            0,
            boxWidth,
            boxHeight
        );

        // Elliptical feather: keep the center solid, dissolve to fully
        // transparent at the box edge. The y-scale turns the circular
        // gradient into an ellipse matching the box's aspect ratio.
        sctx.globalCompositeOperation = 'destination-in';
        sctx.save();
        sctx.translate(boxWidth / 2, boxHeight / 2);
        sctx.scale(1, boxHeight / boxWidth);

        const radius = boxWidth / 2;

        const feather = sctx.createRadialGradient(
            0, 0, 0,
            0, 0, radius
        );

        feather.addColorStop(0, 'rgba(0, 0, 0, 1)');
        feather.addColorStop(0.45, 'rgba(0, 0, 0, 1)');
        feather.addColorStop(0.65, 'rgba(0, 0, 0, 0.85)');
        feather.addColorStop(0.8, 'rgba(0, 0, 0, 0.5)');
        feather.addColorStop(0.92, 'rgba(0, 0, 0, 0.15)');
        feather.addColorStop(1, 'rgba(0, 0, 0, 0)');

        sctx.fillStyle = feather;
        sctx.fillRect(-radius, -radius, radius * 2, radius * 2);
        sctx.restore();
        sctx.globalCompositeOperation = 'source-over';

        this.ctx.save();
        this.ctx.globalAlpha = alpha;
        this.ctx.drawImage(scratch, Math.round(x), Math.round(y));
        this.ctx.restore();
    }

    renderAura(slots, loadedImages) {
    const primaryImage =
        slots[0]
            ? loadedImages.get(String(slots[0].image_id))
            : null;

    const leftImage =
        slots[1]
            ? loadedImages.get(String(slots[1].image_id))
            : null;

    const rightImage =
        slots[2]
            ? loadedImages.get(String(slots[2].image_id))
            : null;

    const width =
        this.canvas.width;

    const height =
        this.canvas.height;

    /*
        Aura layout:
                  Primary

            Left           Right

        Each image is drawn smaller than before and individually feathered
        to transparent at its edges (drawImageVignette), so neighbors blend
        into each other and into the dark background instead of stacking as
        hard-edged translucent rectangles.
    */
    if (leftImage) {
        this.drawImageVignette(
            leftImage,
            width * -0.05,
            height * 0.28,
            width * 0.56,
            height * 0.64,
            0.85
        );
    }

    if (rightImage) {
        this.drawImageVignette(
            rightImage,
            width * 0.49,
            height * 0.28,
            width * 0.56,
            height * 0.64,
            0.85
        );
    }

    if (primaryImage) {
        this.drawImageVignette(
            primaryImage,
            width * 0.20,
            height * -0.05,
            width * 0.60,
            height * 0.66,
            0.95
        );
    }
}

    renderAuraVignette() {
        const width =
            this.canvas.width;

        const height =
            this.canvas.height;

        const gradient =
            this.ctx.createRadialGradient(
                width * 0.5,
                height * 0.45,
                width * 0.18,
                width * 0.5,
                height * 0.45,
                width * 0.72
            );

        gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
        gradient.addColorStop(0.52, 'rgba(0, 0, 0, 0.06)');
        gradient.addColorStop(0.78, 'rgba(0, 0, 0, 0.32)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0.88)');

        this.ctx.fillStyle = gradient;

        this.ctx.fillRect(
            0,
            0,
            width,
            height
        );
}
    renderBottomFade() {
        const gradient =
            this.ctx.createLinearGradient(
                0,
                this.canvas.height * 0.72,
                0,
                this.canvas.height
            );

        gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0.92)');

        this.ctx.fillStyle = gradient;

        this.ctx.fillRect(
            0,
            0,
            this.canvas.width,
            this.canvas.height
        );
    }
}