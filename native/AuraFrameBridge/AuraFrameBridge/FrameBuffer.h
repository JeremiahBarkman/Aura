#pragma once

#include "AuraFrameTypes.h"

#include <condition_variable>
#include <mutex>
#include <vector>

class FrameBuffer
{
public:
    FrameBuffer();

    void WriteFrame(
        const AuraFrameHeader& header,
        const uint8_t* pixels
    );

    bool CopyLatestFrame(
        AuraFrameHeader& header,
        std::vector<uint8_t>& pixels
    ) const;

    /*
        Block until a frame NEWER than lastSeenFrameNumber arrives, then copy
        it out. Returns false on timeout with nothing new.

        This replaces the old poll-every-5ms pattern in the TCP sender, which
        copied the full frame (~3.7 MB at 720p) on EVERY poll -- ~200 copies
        a second per client, almost all discarded as duplicates -- while
        holding the same mutex the writer needs. One camera consumer was
        enough contention to backpressure the writer, which backpressured
        Electron's frame export, which halved the visible frame rate
        everywhere at once.

        Now senders sleep on a condition variable and copy exactly once per
        new frame.
    */
    bool WaitForNewFrame(
        uint64_t lastSeenFrameNumber,
        AuraFrameHeader& header,
        std::vector<uint8_t>& pixels,
        uint32_t timeoutMs
    );

    uint64_t GetLastFrameTimeMs() const;
    uint64_t GetFrameCount() const;

private:
    bool IsValidHeader(const AuraFrameHeader& header) const;

    mutable std::mutex mutex_;
    std::condition_variable frameAvailable_;
    AuraFrameHeader latestHeader_;
    std::vector<uint8_t> latestPixels_;
    uint64_t lastFrameTimeMs_;
    uint64_t frameCount_;
    bool hasFrame_;
};
