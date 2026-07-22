// ============================================================================
// Aura Scene Image Cache
// ============================================================================

export class SceneImageCache {
    constructor() {
        this.images = new Map();
    }

    has(imageId) {
        return this.images.has(String(imageId));
    }

    get(imageId) {
        return this.images.get(String(imageId));
    }

    async load(imageId, imageUrl) {
        const key = String(imageId);

        if (this.images.has(key)) {
            return this.images.get(key);
        }

        const image = new Image();
        image.crossOrigin = 'anonymous';

        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
            image.src = imageUrl;
        });

        this.images.set(key, image);

        return image;
    }

    async loadSlots(slots, imageUrlResolver) {
        const result = new Map();

        for (const slot of slots) {
            if (!slot?.image_id || !slot?.image_path) {
                continue;
            }

            const imageUrl =
                imageUrlResolver(
                    slot.image_path,
                    slot.workflow_name || ''
                );

            // Skip a slot whose image fails to load rather than rejecting the
            // whole scene render. The renderer already tolerates a missing
            // image, and letting one broken slot throw here would abort the
            // camera scene sync entirely.
            try {
                const image =
                    await this.load(
                        slot.image_id,
                        imageUrl
                    );

                result.set(
                    String(slot.image_id),
                    image
                );
            } catch (error) {
                console.warn(
                    'Scene slot image failed to load; skipping slot',
                    slot.image_id,
                    error?.message || error
                );
            }
        }

        return result;
    }

    clear() {
        this.images.clear();
    }
}