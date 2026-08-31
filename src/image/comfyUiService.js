const fs = require('fs');
const path = require('path');
const auraConfig = require('../config/auraConfig');
const paths = require('../config/paths');

const comfyBaseUrl =
    process.env.COMFYUI_URL || 'http://127.0.0.1:8188';

const DEFAULT_NEGATIVE_PROMPT =
    'text, watermark, logo, blurry, distorted, low quality';

const workflowPath = path.join(
    __dirname,
    '../../comfy/workflows/aura_background_api.json'
);

const comfyOutputDir =
    process.env.COMFYUI_OUTPUT_DIR || 'C:\\AI\\ComfyUI\\output';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkComfyUiHealth() {
    const response = await fetch(`${comfyBaseUrl}/system_stats`);

    if (!response.ok) {
        throw new Error(`ComfyUI health check failed: ${response.status}`);
    }

    return response.json();
}

/**
 * Asks ComfyUI to drop its models out of VRAM, so the extraction model has the
 * card to itself.
 *
 * Measured benefit on an 8 GB RTX 4060 Ti: none. The 24B extraction model
 * needs 10.8 GB at a 21.5k context, so it cannot fit either way, and it loaded
 * at exactly 48% GPU-resident whether ComfyUI held 4 GB or nothing -- Windows
 * WDDM oversubscribes VRAM and pages the idle allocation out under pressure,
 * so the contention this was written to remove was already being handled.
 *
 * Kept because that result is specific to a card the model cannot fit on. Where
 * it can fit, 4 GB is the difference between fitting and not, and the call
 * costs about a second.
 *
 * Deliberately not "stop ComfyUI". Aura only holds a handle to that process
 * when it spawned it (COMFYUI_AUTOSTART with port 8188 free at launch), so a
 * user-started instance is invisible to it -- a stop/restart design would work
 * on some machines and silently do nothing on others. This works either way,
 * costs no restart, and needs no undo: ComfyUI reloads the checkpoint by
 * itself on the next generation.
 *
 * /free sets a queue flag rather than interrupting, so it cannot disturb a
 * generation already in flight.
 *
 * Best-effort. ComfyUI being absent is normal (it is an optional service) and
 * must not fail whatever asked for the memory.
 *
 * @returns {Promise<boolean>} Whether ComfyUI accepted the request.
 */
async function freeMemory() {
    try {
        const response = await fetch(`${comfyBaseUrl}/free`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                unload_models: true,
                free_memory: true
            })
        });

        if (!response.ok) {
            console.warn(
                `[AURA COMFY] /free returned ${response.status}; VRAM not released.`
            );
            return false;
        }

        return await waitForVramRelease();
    } catch (error) {
        console.log(
            `[AURA COMFY] Could not reach ComfyUI to free VRAM (${error.message}); continuing.`
        );
        return false;
    }
}

/**
 * Free VRAM on the device, as ComfyUI reports it.
 *
 * Deliberately vram_free and not torch_vram_total. On a device using the
 * cudaMallocAsync allocator, torch's own pool reads 32 MB while SDXL occupies
 * nearly 4 GB -- measured on an RTX 4060 Ti -- so watching the torch figure
 * would see almost nothing move.
 */
async function readFreeVram() {
    const response = await fetch(`${comfyBaseUrl}/system_stats`);

    if (!response.ok) {
        return null;
    }

    const stats = await response.json();
    const device = (stats.devices || [])[0];

    return device ? Number(device.vram_free) || 0 : null;
}

/**
 * Waits for ComfyUI to actually give the memory back.
 *
 * /free only sets a queue flag and returns 200; the unload and the collection
 * that follows it happen on ComfyUI's worker thread afterwards. Returning
 * before that lands would defeat the point: Ollama fixes its GPU/CPU layer
 * split when the model loads and keeps it for the whole run, so starting
 * extraction a moment too early locks in the bad split for the entire job and
 * the optimization silently does nothing.
 *
 * Polls rather than sleeping a guessed interval, and gives up rather than
 * blocking a conference on a service that is only an optimization.
 */
async function waitForVramRelease(timeoutMs = 15000, pollMs = 250) {
    const initial = await readFreeVram();

    if (initial === null) {
        return true;
    }

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    // Waits for free VRAM to stop rising rather than for a fixed target,
    // because how much is about to come back depends on which checkpoints
    // ComfyUI happens to have loaded. A plateau means the unload finished; a
    // plateau at the starting value means there was nothing to unload.
    const NOISE_BYTES = 10 * 1024 * 1024;
    const STABLE_POLLS = 3;

    let best = initial;
    let stablePolls = 0;

    while (Date.now() < deadline) {
        await sleep(pollMs);

        const now = await readFreeVram();

        if (now === null) {
            return true;
        }

        if (now > best + NOISE_BYTES) {
            best = now;
            stablePolls = 0;
            continue;
        }

        stablePolls += 1;

        if (stablePolls >= STABLE_POLLS) {
            const released = best - initial;
            const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

            console.log(
                released > NOISE_BYTES
                    ? `[AURA COMFY] Released ${(released / 1e9).toFixed(2)} GB of VRAM in ${seconds}s ` +
                      `(${(best / 1e9).toFixed(2)} GB now free).`
                    : `[AURA COMFY] ComfyUI had no VRAM to release (${(best / 1e9).toFixed(2)} GB free).`
            );

            return true;
        }
    }

    console.warn(
        `[AURA COMFY] Free VRAM was still moving after ${timeoutMs / 1000}s; continuing anyway.`
    );

    return false;
}

function loadWorkflowTemplate() {
    const workflowJson = fs.readFileSync(workflowPath, 'utf8');
    return JSON.parse(workflowJson);
}

/**
 * Latent dimensions per aspect ratio.
 *
 * These are SDXL's own training buckets, not arbitrary shapes with the right
 * proportions. SDXL is trained at roughly one megapixel and degrades badly
 * away from it -- asking for 1920x1080 gives a correctly proportioned image
 * full of duplicated subjects and mangled anatomy. Every entry here is close
 * to 1024x1024 in total pixels and divisible by 64.
 */
const ASPECT_RATIO_DIMENSIONS = {
    '1:1':  { width: 1024, height: 1024 },
    '16:9': { width: 1344, height: 768 },
    '9:16': { width: 768,  height: 1344 },
    '3:2':  { width: 1216, height: 832 },
    '2:3':  { width: 832,  height: 1216 },
    '4:3':  { width: 1152, height: 896 },
    '3:4':  { width: 896,  height: 1152 }
};

/**
 * Resizes the workflow's empty latent to the requested aspect ratio.
 *
 * An unknown or absent ratio leaves the template's own dimensions alone, so
 * every caller that does not ask for a shape keeps generating exactly what it
 * generated before.
 */
function applyAspectRatio(workflow, aspectRatio) {
    const dimensions = ASPECT_RATIO_DIMENSIONS[String(aspectRatio || '').trim()];

    if (!dimensions) {
        return workflow;
    }

    for (const node of Object.values(workflow)) {
        if (!node.inputs) {
            continue;
        }

        const hasWidth = Object.prototype.hasOwnProperty.call(node.inputs, 'width');
        const hasHeight = Object.prototype.hasOwnProperty.call(node.inputs, 'height');

        if (hasWidth && hasHeight) {
            node.inputs.width = dimensions.width;
            node.inputs.height = dimensions.height;
        }
    }

    return workflow;
}

function randomSeed() {
    return Math.floor(Math.random() * 999999999999999);
}

function refreshWorkflowSeeds(workflow) {
    for (const node of Object.values(workflow)) {
        if (!node.inputs) {
            continue;
        }

        if (Object.prototype.hasOwnProperty.call(node.inputs, 'noise_seed')) {
            node.inputs.noise_seed = randomSeed();
        }

        if (Object.prototype.hasOwnProperty.call(node.inputs, 'seed')) {
            node.inputs.seed = randomSeed();
        }
    }

    return workflow;
}

/**
 * Collects the ids of the text nodes wired into a sampler's negative input.
 *
 * The graph states this outright: every sampler carries `positive` and
 * `negative` input links, each of the form [nodeId, outputIndex]. Reading the
 * wiring is the only reliable way to tell the two apart -- all four
 * CLIPTextEncode nodes in aura_background_api.json carry ComfyUI's default
 * title, "CLIP Text Encode (Prompt)", so nothing distinguishes them by name.
 */
function findNegativeTextNodeIds(workflow) {
    const negativeIds = new Set();

    for (const node of Object.values(workflow)) {
        const link = node.inputs && node.inputs.negative;

        if (Array.isArray(link) && link.length > 0) {
            negativeIds.add(String(link[0]));
        }
    }

    return negativeIds;
}

function injectPrompt(workflow, positivePrompt, negativePrompt = DEFAULT_NEGATIVE_PROMPT) {
    const negativeIds = findNegativeTextNodeIds(workflow);

    let negativeNodesFilled = 0;

    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!node.inputs || !Object.prototype.hasOwnProperty.call(node.inputs, 'text')) {
            continue;
        }

        const title = node._meta && node._meta.title ? node._meta.title.toLowerCase() : '';

        // Wiring is authoritative. The title check stays as a fallback for
        // workflow templates that label the node but route it through
        // something this walk does not follow.
        if (negativeIds.has(nodeId) || title.includes('negative')) {
            node.inputs.text = negativePrompt;
            negativeNodesFilled += 1;
            continue;
        }

        node.inputs.text = positivePrompt;
    }

    // Failing to find a negative node is exactly the bug this replaced: every
    // node got the positive prompt, so the samplers were steered toward the
    // things the negative prompt exists to exclude, and nothing said so. Make
    // that loud rather than silent if a future workflow reintroduces it.
    if (negativeNodesFilled === 0) {
        console.warn(
            '[AURA COMFY] No negative conditioning node found in the workflow; ' +
            'the negative prompt was NOT applied to this generation.'
        );
    }

    return workflow;
}

async function queueWorkflow(positivePrompt = null, negativePrompt = null, aspectRatio = null) {
    let workflow = refreshWorkflowSeeds(loadWorkflowTemplate());

    workflow = applyAspectRatio(workflow, aspectRatio);

    if (positivePrompt) {
        // Precedence: a negative supplied for this specific image, then the
        // Settings UI override, then the built-in default. Conference subjects
        // carry their own subject-specific exclusions; everything else passes
        // null and keeps the previous behaviour exactly.
        const resolvedNegative =
            negativePrompt ||
            auraConfig.readConfig().negativePrompt ||
            DEFAULT_NEGATIVE_PROMPT;

        workflow = injectPrompt(workflow, positivePrompt, resolvedNegative);
    }

    const response = await fetch(`${comfyBaseUrl}/prompt`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            prompt: workflow
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ComfyUI prompt queue failed: ${response.status}\n${errorText}`);
    }

    return response.json();
}

async function getHistory(promptId) {
    const response = await fetch(`${comfyBaseUrl}/history/${promptId}`);

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ComfyUI history failed: ${response.status}\n${errorText}`);
    }

    return response.json();
}

function extractOutputImages(historyItem) {
    const images = [];

    if (!historyItem || !historyItem.outputs) {
        return images;
    }

    for (const output of Object.values(historyItem.outputs)) {
        if (!output.images) {
            continue;
        }

        for (const image of output.images) {
            images.push({
                filename: image.filename,
                subfolder: image.subfolder || '',
                type: image.type || 'output',
                localPath: path.join(comfyOutputDir, image.subfolder || '', image.filename)
            });
        }
    }

    return images;
}

async function waitForGeneratedImages(promptId, timeoutMs = 120000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const history = await getHistory(promptId);
        const historyItem = history[promptId];

        const images = extractOutputImages(historyItem);

        if (images.length > 0) {
            return images;
        }

        await sleep(1000);
    }

    throw new Error(`Timed out waiting for ComfyUI image generation: ${promptId}`);
}

// ComfyUI writes generated images into its OWN output folder, which is
// external to Aura and gets cleaned/rotated independently -- so referencing
// those files directly means the images silently disappear from the Library
// whenever ComfyUI's output is pruned. Copy each generated image into Aura's
// own images/generated folder and return that durable path instead, matching
// how manual and imported images are already persisted.
function persistGeneratedImageToStorage(sourcePath) {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
        return sourcePath;
    }

    fs.mkdirSync(paths.generatedImagesDir, { recursive: true });

    const ext = path.extname(sourcePath) || '.png';
    const base = path.basename(sourcePath, ext);

    const uniqueName =
        `${base}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext}`;

    const destPath = path.join(paths.generatedImagesDir, uniqueName);

    try {
        fs.copyFileSync(sourcePath, destPath);
        return destPath;
    } catch (error) {
        console.warn(
            'Could not copy generated image into Aura storage; ' +
            'falling back to the ComfyUI output path:',
            error.message
        );
        return sourcePath;
    }
}

async function generateImageFromWorkflow(positivePrompt = null, negativePrompt = null, aspectRatio = null) {
    const queued = await queueWorkflow(positivePrompt, negativePrompt, aspectRatio);

    const promptId = queued.prompt_id;

    if (!promptId) {
        throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(queued)}`);
    }

    const images = await waitForGeneratedImages(promptId);

    // Give each image a durable local copy under Aura's storage.
    const persistedImages = images.map(image => ({
        ...image,
        storedPath: persistGeneratedImageToStorage(image.localPath)
    }));

    return {
        promptId,
        images: persistedImages
    };
}

module.exports = {
    checkComfyUiHealth,
    freeMemory,
    loadWorkflowTemplate,
    queueWorkflow,
    getHistory,
    waitForGeneratedImages,
    generateImageFromWorkflow
};