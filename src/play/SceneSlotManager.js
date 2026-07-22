class SceneSlotManager {
    constructor() {
        this.sceneMode = 'single';

        this.slots = [];

        this.minimumDisplayMs = 5000;

        this.primaryPromotionScore = 0.90;

        this.transition = {
            type: 'crossfade',
            durationMs: 1200,
            easing: 'ease-in-out'
        };
    }

    setSceneMode(sceneMode) {
        this.sceneMode = sceneMode;
    }

findSlotByImageId(imageId) {
    return this.slots.find(slot =>
        slot &&
        String(slot.image_id) === String(imageId)
    );
}

    shouldPromoteToPrimary(match) {
    return (
        Number(match.score || 0) >=
        this.primaryPromotionScore
    );
}

promoteToPrimary(match) {
    const existingPrimary =
        this.slots[0];

    if (!existingPrimary) {
        this.insertPrimary(match);
        return;
    }

    /*
        Move old primary into supporting rotation.
    */
    this.replaceOldestSupporting({
        image_id: existingPrimary.image_id,
        image_path: existingPrimary.image_path,
        workflow_name: existingPrimary.workflow_name,
        source_item_id: existingPrimary.source_item_id,
        score: existingPrimary.score
    });

    this.insertPrimary(match);
}

    insertPrimary(match) {
        const slot = {
            slotIndex: 0,
            role: 'primary',
            image_id: match.image_id,
            image_path: match.image_path,
            workflow_name: match.workflow_name || '',
            source_item_id: match.source_item_id,
            score: match.score || 1,
            insertedAt: Date.now(),
            lastMatchedAt: Date.now()
        };

        this.slots[0] = slot;
    }

insertMatch(match) {
    const existingSlot =
        this.findSlotByImageId(match.image_id);

    if (existingSlot) {
        existingSlot.lastMatchedAt = Date.now();
        existingSlot.score = Math.max(
            Number(existingSlot.score || 0),
            Number(match.score || 0)
        );
        return;
    }

    if (!this.slots[0]) {
        this.insertPrimary(match);
        return;
    }

    if (this.shouldPromoteToPrimary(match)) {
        this.promoteToPrimary(match);
        return;
    }

    const supportingIndexes =
        this.sceneMode === 'aura'
            ? [1, 2]
            : [1];

    const emptySupportingIndex =
        supportingIndexes.find(index => !this.slots[index]);

    if (emptySupportingIndex !== undefined) {
        this.insertSupporting(match);
        return;
    }

    this.replaceOldestSupporting(match);
}
    insertSupporting(match) {
    const now = Date.now();

    const supportingIndexes =
        this.sceneMode === 'aura'
            ? [1, 2]
            : [1];

    let targetIndex =
        supportingIndexes.find(index => !this.slots[index]);

    if (targetIndex === undefined) {
        targetIndex =
            supportingIndexes
                .slice()
                .sort((a, b) => {
                    const slotA = this.slots[a];
                    const slotB = this.slots[b];

                    return (
                        (slotA?.lastMatchedAt || 0) -
                        (slotB?.lastMatchedAt || 0)
                    );
                })[0];
    }

    const role =
        targetIndex === 1
            ? 'supporting-left'
            : 'supporting-right';

    this.slots[targetIndex] = {
        slotIndex: targetIndex,
        role,
        image_id: match.image_id,
        image_path: match.image_path,
        workflow_name: match.workflow_name || '',
        source_item_id: match.source_item_id,
        score: match.score || 1,
        insertedAt: now,
        lastMatchedAt: now
    };
}

replaceOldestSupporting(match) {
    const now = Date.now();

    const supportingIndexes =
        this.sceneMode === 'aura'
            ? [1, 2]
            : [1];

    const targetIndex =
        supportingIndexes
            .slice()
            .sort((a, b) => {
                const slotA = this.slots[a];
                const slotB = this.slots[b];

                return (
                    (slotA?.lastMatchedAt || 0) -
                    (slotB?.lastMatchedAt || 0)
                );
            })[0];

    const role =
        targetIndex === 1
            ? 'supporting-left'
            : 'supporting-right';

    this.slots[targetIndex] = {
        slotIndex: targetIndex,
        role,
        image_id: match.image_id,
        image_path: match.image_path,
        workflow_name: match.workflow_name || '',
        source_item_id: match.source_item_id,
        score: match.score || 1,
        insertedAt: now,
        lastMatchedAt: now
    };
}

    getActiveScene() {
        return {
            version: 3,
            sceneMode: this.sceneMode,
            slots: this.slots,
            transition: {
                ...this.transition,
                minimumDisplayMs: this.minimumDisplayMs
            },
            updatedAt: Date.now()
        };
    }
}

module.exports = SceneSlotManager;