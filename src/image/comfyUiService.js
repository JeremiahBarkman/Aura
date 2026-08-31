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

function loadWorkflowTemplate() {
    const workflowJson = fs.readFileSync(workflowPath, 'utf8');
    return JSON.parse(workflowJson);
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

async function queueWorkflow(positivePrompt = null, negativePrompt = null) {
    let workflow = refreshWorkflowSeeds(loadWorkflowTemplate());

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

async function generateImageFromWorkflow(positivePrompt = null, negativePrompt = null) {
    const queued = await queueWorkflow(positivePrompt, negativePrompt);

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
    loadWorkflowTemplate,
    queueWorkflow,
    getHistory,
    waitForGeneratedImages,
    generateImageFromWorkflow
};