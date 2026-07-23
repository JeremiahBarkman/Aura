#include "FrameBuffer.h"

#include <chrono>
#include <cstring>

FrameBuffer::FrameBuffer()
    : latestHeader_{},
    lastFrameTimeMs_(0),
    frameCount_(0),
    hasFrame_(false)
{
}

bool FrameBuffer::IsValidHeader(const AuraFrameHeader& header) const
{
    return
        header.magic == AuraFrameMagic &&
        header.version == AuraFrameVersion &&
        header.format == AuraFrameFormatBGRA32 &&
        header.width > 0 &&
        header.height > 0 &&
        header.stride > 0 &&
        header.dataSize > 0 &&
        header.dataSize <= 3840 * 2160 * AuraBytesPerPixel;
}

void FrameBuffer::WriteFrame(
    const AuraFrameHeader& header,
    const uint8_t* pixels
)
{
    if (!pixels || !IsValidHeader(header))
    {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);

        latestHeader_ = header;
        latestPixels_.resize(header.dataSize);

        std::memcpy(
            latestPixels_.data(),
            pixels,
            header.dataSize
        );

        lastFrameTimeMs_ = AuraNowMs();
        frameCount_++;
        hasFrame_ = true;
    }

    /*
        Notify after releasing the lock so woken senders don't immediately
        block on a mutex the notifier still holds.
    */
    frameAvailable_.notify_all();
}

bool FrameBuffer::WaitForNewFrame(
    uint64_t lastSeenFrameNumber,
    AuraFrameHeader& header,
    std::vector<uint8_t>& pixels,
    uint32_t timeoutMs
)
{
    std::unique_lock<std::mutex> lock(mutex_);

    /*
        Inequality rather than greater-than: a renderer restart resets frame
        numbering, and the sender must pick the stream back up rather than
        wait for the counter to catch up to its old position.
    */
    const bool hasNewFrame =
        frameAvailable_.wait_for(
            lock,
            std::chrono::milliseconds(timeoutMs),
            [&]()
            {
                return
                    hasFrame_ &&
                    !latestPixels_.empty() &&
                    latestHeader_.frameNumber != lastSeenFrameNumber;
            }
        );

    if (!hasNewFrame)
    {
        return false;
    }

    header = latestHeader_;

    /*
        assign() reuses the caller's existing capacity. Callers hoist the
        vector out of their send loop, so steady state performs no heap
        allocation at all.
    */
    pixels.assign(
        latestPixels_.begin(),
        latestPixels_.end()
    );

    return true;
}

bool FrameBuffer::CopyLatestFrame(
    AuraFrameHeader& header,
    std::vector<uint8_t>& pixels
) const
{
    std::lock_guard<std::mutex> lock(mutex_);

    if (!hasFrame_ || latestPixels_.empty())
    {
        return false;
    }

    header = latestHeader_;
    pixels = latestPixels_;

    return true;
}

uint64_t FrameBuffer::GetLastFrameTimeMs() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    return lastFrameTimeMs_;
}

uint64_t FrameBuffer::GetFrameCount() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    return frameCount_;
}
