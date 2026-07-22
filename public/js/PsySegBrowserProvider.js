export class PsySegBrowserProvider {
    constructor() {
        this.psyseg = null;
        this.initialized = false;
    }

    async initialize() {
        const PsySegClass =
            window.PsySeg?.default ||
            window.PsySeg?.PsySeg ||
            window.PsySeg;

        if (!PsySegClass) {
            throw new Error('PsySeg SDK global not found.');
        }

        this.psyseg = new PsySegClass();

        const result = await this.psyseg.init({});

        console.log('PsySeg browser provider init:', result);

        this.initialized = !!result?.status;

        if (!this.initialized) {
            throw new Error('PsySeg failed to initialize.');
        }

        return result;
    }

    ensureInitialized() {
        if (!this.initialized || !this.psyseg) {
            throw new Error('PsySeg provider is not initialized.');
        }
    }

    async blurBackground(imageData, options = {}) {
        this.ensureInitialized();

        return this.psyseg.blurBackground(imageData, {
            blur: options.blur ?? 12
        });
    }

    async removeBackground(imageData, options = {}) {
        this.ensureInitialized();

        return this.psyseg.removeBackground(imageData, options);
    }

    async replaceBackground(imageData, backgroundImageData, options = {}) {
        this.ensureInitialized();

        return this.psyseg.replaceBackground(
            imageData,
            backgroundImageData,
            options
        );
    }

    async runAlpha(imageData, options = {}) {
        this.ensureInitialized();

        return this.psyseg.runAlpha(imageData, options);
    }
}