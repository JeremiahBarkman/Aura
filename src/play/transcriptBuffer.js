class TranscriptBuffer {
    constructor(maxEntries = 8) {
        this.maxEntries = maxEntries;
        this.entries = [];
    }

    add(text) {
        if (!text || !text.trim()) {
            return;
        }

        this.entries.push({
            text: text.trim(),
            timestamp: Date.now()
        });

        while (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }
    }

    getCombinedText() {
        return this.entries
            .map(entry => entry.text)
            .join(' ');
    }

    clear() {
        this.entries = [];
    }

    getEntries() {
        return [...this.entries];
    }
}

module.exports = TranscriptBuffer;