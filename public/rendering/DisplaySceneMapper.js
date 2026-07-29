// ============================================================================
// Display Scene Mapper
// ============================================================================
// Purpose:
// Turn the server's Active Scene v3 (owned by SceneSlotManager) into the exact
// set of slots a given Display Mode should present.
//
// This is the SINGLE source of truth for slot placement. Both output surfaces
// import it so they can never drift apart:
// - Aura Camera compositor  (public/index.html)
// - Aura Slide Output       (public/aura-slide-output/index.html)
//
// The server keeps scene memory in fixed slot positions:
//   slots[0] = primary          (aura: top-center)
//   slots[1] = supporting-left  (aura: left)
//   slots[2] = supporting-right (aura: right)
//
// Display Mode only changes PRESENTATION (how many slots, which layout); it
// never changes the underlying scene memory.
// ============================================================================

export function getEffectiveSceneMode(displayMode, slotCount) {
    if (displayMode === 'single') {
        return 'single';
    }

    if (displayMode === 'dual') {
        return slotCount >= 2 ? 'dual' : 'single';
    }

    if (displayMode === 'triple') {
        if (slotCount >= 3) return 'triple';
        if (slotCount >= 2) return 'dual';
        return 'single';
    }

    return 'aura';
}

export function getDisplaySlotLimit(displayMode) {
    if (displayMode === 'single') return 1;
    if (displayMode === 'dual') return 2;
    return 3;
}

function cloneDisplaySlot(slot, slotIndex = 0, role = 'primary') {
    if (!slot) {
        return null;
    }

    return {
        ...slot,
        slotIndex,
        role
    };
}

function recencyOf(slot) {
    return Number(slot.lastMatchedAt || slot.insertedAt || 0);
}

function getMostRecentSceneSlot(slots) {
    return slots
        .filter(Boolean)
        .slice()
        .sort((a, b) => recencyOf(b) - recencyOf(a))[0] || null;
}

function roleForIndex(index) {
    return index === 0
        ? 'primary'
        : index === 1
            ? 'supporting-left'
            : 'supporting-right';
}

export function getDisplaySlotsForMode(scene, displayMode) {
    const sourceSlots =
        Array.isArray(scene?.slots)
            ? scene.slots.filter(Boolean)
            : [];

    if (!sourceSlots.length) {
        return [];
    }

    if (displayMode === 'single') {
        const mostRecentSlot =
            getMostRecentSceneSlot(sourceSlots);

        return mostRecentSlot
            ? [cloneDisplaySlot(mostRecentSlot, 0, 'primary')]
            : [];
    }

    const limit = getDisplaySlotLimit(displayMode);

    if (displayMode === 'dual') {
        // The server always runs in aura mode and keeps up to THREE slots
        // (primary + supporting slots 1 and 2). A plain slots[0..1] slice only
        // ever shows slots 0 and 1, so a new match landing in slot 2 is
        // invisible in 2-image mode (and, not being in the display scene key,
        // doesn't even trigger a camera update). Pinning slot 0 (the server's
        // "primary") is no better: the primary only changes on a rare
        // high-score promotion, so the left image freezes while only the right
        // rotates.
        //
        // Instead, show the two MOST RECENTLY MATCHED slots so both positions
        // keep updating and the newest match is always one of the two. Order
        // the chosen pair by their server slot index so an image that stays
        // on screen keeps its side (only the replaced one changes) rather than
        // the whole pair shuffling on every match.
        const chosen =
            sourceSlots
                .slice()
                .sort((a, b) => recencyOf(b) - recencyOf(a))
                .slice(0, limit)
                .sort((a, b) =>
                    Number(a.slotIndex || 0) - Number(b.slotIndex || 0)
                );

        return chosen.map((slot, index) =>
            cloneDisplaySlot(slot, index, roleForIndex(index))
        );
    }

    // triple / aura: show up to three slots in their STABLE server positions,
    // so primary/left/right stay put and match the camera composite exactly.
    return sourceSlots
        .slice(0, limit)
        .map((slot, index) =>
            cloneDisplaySlot(slot, index, roleForIndex(index))
        );
}

export function applyDisplayModeToScene(scene, displayMode) {
    if (!scene || !Array.isArray(scene.slots)) {
        return scene;
    }

    const slots = getDisplaySlotsForMode(scene, displayMode);

    return {
        ...scene,
        sceneMode: getEffectiveSceneMode(displayMode, slots.length),
        requestedDisplayMode: displayMode,
        slots
    };
}
