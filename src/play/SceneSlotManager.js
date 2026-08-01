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

    // Empties every slot, returning the manager to its constructed state so
    // the next match fills a clean scene. sceneMode and transition settings
    // are deliberately kept -- they are display preferences, not scene
    // content, and re-deriving them from the next match would briefly show
    // the wrong layout.
    clearSlots() {
        this.slots = [];
    }

    findSlotByImageId(imageId) {
        return this.slots.find(slot =>
            slot &&
            String(slot.image_id) === String(imageId)
        );
    }

    // All slot indexes the current scene mode actually uses. 'aura' shows
    // primary + two supporting slots; everything else shows primary + one.
    getActiveIndexes() {
        return this.sceneMode === 'aura'
            ? [0, 1, 2]
            : [0, 1];
    }

    roleForIndex(index) {
        if (index === 0) {
            return 'primary';
        }

        return index === 1
            ? 'supporting-left'
            : 'supporting-right';
    }

    // Of the given indexes, the one whose slot has gone longest without a
    // fresh match (or is empty, sorting first with lastMatchedAt 0).
    oldestIndex(indexes) {
        return indexes
            .slice()
            .sort((a, b) =>
                (this.slots[a]?.lastMatchedAt || 0) -
                (this.slots[b]?.lastMatchedAt || 0)
            )[0];
    }

    insertAtIndex(index, match) {
        const now = Date.now();

        this.slots[index] = {
            slotIndex: index,
            role: this.roleForIndex(index),
            image_id: match.image_id,
            image_path: match.image_path,
            workflow_name: match.workflow_name || '',
            source_item_id: match.source_item_id,
            score: match.score || 1,
            insertedAt: now,
            lastMatchedAt: now
        };
    }

    shouldPromoteToPrimary(match) {
        return (
            Number(match.score || 0) >=
            this.primaryPromotionScore
        );
    }

    promoteToPrimary(match) {
        const existingPrimary = this.slots[0];

        if (!existingPrimary) {
            this.insertPrimary(match);
            return;
        }

        /*
            A genuinely dominant match displaces the current primary --
            move the old primary into supporting rotation (the oldest
            supporting slot) rather than just dropping it, since it's being
            bumped by relevance, not by old age.
        */
        const supportingIndexes =
            this.getActiveIndexes().filter(index => index !== 0);

        this.insertAtIndex(this.oldestIndex(supportingIndexes), {
            image_id: existingPrimary.image_id,
            image_path: existingPrimary.image_path,
            workflow_name: existingPrimary.workflow_name,
            source_item_id: existingPrimary.source_item_id,
            score: existingPrimary.score
        });

        this.insertPrimary(match);
    }

    insertPrimary(match) {
        this.insertAtIndex(0, match);
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

        const activeIndexes = this.getActiveIndexes();

        const emptyIndex =
            activeIndexes.find(index => !this.slots[index]);

        if (emptyIndex !== undefined) {
            this.insertAtIndex(emptyIndex, match);
            return;
        }

        if (this.shouldPromoteToPrimary(match)) {
            this.promoteToPrimary(match);
            return;
        }

        /*
            No empty slot, and this match isn't dominant enough to jump the
            queue via promoteToPrimary (whose 0.90 threshold ordinary
            keyword/semantic scores rarely reach). Replace whichever slot --
            including primary -- has gone longest without a fresh match, so
            every visible slot keeps cycling instead of primary sticking with
            its first-ever image forever.
        */
        this.insertAtIndex(this.oldestIndex(activeIndexes), match);
    }

    insertSupporting(match) {
        const supportingIndexes =
            this.getActiveIndexes().filter(index => index !== 0);

        const emptyIndex =
            supportingIndexes.find(index => !this.slots[index]);

        this.insertAtIndex(
            emptyIndex !== undefined ? emptyIndex : this.oldestIndex(supportingIndexes),
            match
        );
    }

    replaceOldestSupporting(match) {
        const supportingIndexes =
            this.getActiveIndexes().filter(index => index !== 0);

        this.insertAtIndex(this.oldestIndex(supportingIndexes), match);
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
