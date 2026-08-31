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
 * Asks ComfyUI to drop its models out of VRAM.
 *
 * Aura's other GPU consumers do not fit alongside it on a smaller card: with
 * ComfyUI holding SDXL, a 24B extraction model sat 48% GPU-resident on an 8 GB
 * board and one 38-minute meeting took 18 minutes to process.
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

        console.log('[AURA COMFY] Asked ComfyUI to release its VRAM.');
        return true;
    } catch (error) {
        console.log(
            `[AURA COMFY] Could not reach ComfyUI to free VRAM (${error.message}); continuing.`
        );
        return false;
    }
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