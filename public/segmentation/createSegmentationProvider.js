/**
 * Segmentation engine registry.
 *
 * Call sites ask for an engine by id instead of importing a concrete provider
 * class, so adding an engine is a one-line entry here rather than an edit to
 * every consumer (live preview, aura-live output window, test pages).
 *
 * Every registered engine must satisfy the SegmentationProvider contract:
 * initialize / attachVideo / attachCanvas / blurBackground / removeBackground
 * / replaceBackground / startBackgroundTransition / stop / dispose, plus the
 * erodeLevel and blurLevel knobs the Webcam Live View sliders drive.
 *
 * Providers are imported lazily so an engine's runtime cost is only paid when
 * it is actually selected -- picking psyseg must not download onnxruntime-web,
 * and picking paddleseg must not load the PsySeg SDK.
 */

export const DEFAULT_ENGINE = 'psyseg';

const ENGINES = {
    psyseg: {
        label: 'PsySeg',
        load: async () => {
            const module = await import('./PsySegSegmentationProvider.js?v=7');
            return module.PsySegSegmentationProvider;
        }
    },

    paddleseg: {
        label: 'PaddleSeg (ONNX)',
        load: async () => {
            const module = await import('./PaddleSegSegmentationProvider.js?v=1');
            return module.PaddleSegSegmentationProvider;
        }
    }
};

/** Engine ids and labels, for populating a settings dropdown. */
export function listSegmentationEngines() {
    return Object.entries(ENGINES).map(([id, entry]) => ({
        id,
        label: entry.label
    }));
}

/**
 * Constructs (but does not initialize) the provider for `engineId`.
 *
 * An unknown or missing id falls back to DEFAULT_ENGINE with a warning rather
 * than throwing: a bad persisted config value should degrade to the working
 * camera path, not leave the user with no camera at all.
 *
 * @param {string} engineId
 * @param {object} [options] Passed to the provider constructor. Engine
 *        specific -- PaddleSeg accepts modelUrl/executionProviders; PsySeg
 *        takes none.
 */
export async function createSegmentationProvider(engineId = DEFAULT_ENGINE, options = {}) {
    let resolvedId = engineId;

    if (!ENGINES[resolvedId]) {
        console.warn(
            `Unknown segmentation engine "${engineId}"; falling back to "${DEFAULT_ENGINE}".`
        );

        resolvedId = DEFAULT_ENGINE;
    }

    const ProviderClass = await ENGINES[resolvedId].load();

    const provider = new ProviderClass(options);

    // Lets callers report/log which engine actually backs the pipeline
    // without re-deriving it from the class name.
    provider.engineId = resolvedId;

    return provider;
}
