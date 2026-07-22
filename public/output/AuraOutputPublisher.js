// ============================================================================
// Aura Output Publisher
// ============================================================================
// Sends finished Aura frames to the Aura Output window over BroadcastChannel.
// This preserves current behavior while making Aura Output one delivery target.
// ============================================================================

export class AuraOutputPublisher {
    constructor(channelName = 'aura-output') {
        this.channelName = channelName;
        this.channel = new BroadcastChannel(channelName);
    }

    publishFrame(frame) {
        if (!frame || !frame.bitmap) {
            return;
        }

        this.channel.postMessage({
            type: 'frame',
            width: frame.width,
            height: frame.height,
            bitmap: frame.bitmap
        }, [frame.bitmap]);
    }

    publishTransition(transition) {
        this.channel.postMessage({
            type: 'transition',
            durationMs: transition.durationMs || 0,
            transitionType: transition.transitionType || 'crossfade'
        });
    }

    dispose() {
        if (this.channel) {
            this.channel.close();
            this.channel = null;
        }
    }
}