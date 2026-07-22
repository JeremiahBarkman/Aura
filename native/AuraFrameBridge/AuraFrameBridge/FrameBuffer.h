#pragma once

#include "AuraFrameTypes.h"

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

    uint64_t GetLastFrameTimeMs() const;
    uint64_t GetFrameCount() const;

private:
    bool IsValidHeader(const AuraFrameHeader& header) const;

    mutable std::mutex mutex_;
    AuraFrameHeader latestHeader_;
    std::vector<uint8_t> latestPixels_;
    uint64_t lastFrameTimeMs_;
    uint64_t frameCount_;
    bool hasFrame_;
};
