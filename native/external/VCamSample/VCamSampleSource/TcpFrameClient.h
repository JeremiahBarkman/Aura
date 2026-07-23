#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

#pragma pack(push, 1)

struct AuraTcpFrameHeader
{
    uint32_t magic;
    uint32_t version;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t format;
    uint64_t frameNumber;
    uint64_t timestampMs;
    uint32_t dataSize;
};

#pragma pack(pop)

static_assert(
    sizeof(AuraTcpFrameHeader) == 44,
    "Aura TCP frame header must be exactly 44 bytes."
    );

class TcpFrameClient
{
public:
    static TcpFrameClient& Instance();

    TcpFrameClient(const TcpFrameClient&) = delete;
    TcpFrameClient& operator=(const TcpFrameClient&) = delete;

    /*
        Copy the latest frame out ONLY if it is newer than what the caller
        already has (by frame number). Returns false, touching nothing, when
        the cached frame is still current.

        The previous unconditional CopyLatestFrame ran once per generated
        camera sample (30/s) and copied ~3.7 MB each time even though the
        overwhelming majority of calls found nothing new -- the pixels were
        copied, compared, and discarded. Under Debug-build codegen that was
        a large slice of the frame budget, and it contended the receive
        thread's mutex for the full duration of every wasted copy.
    */
    bool CopyLatestFrameIfNewer(
        uint64_t lastSeenFrameNumber,
        AuraTcpFrameHeader& header,
        std::vector<uint8_t>& pixels
    );

private:
    TcpFrameClient();
    ~TcpFrameClient();

    void Run();

    bool Connect();
    bool ReceiveExact(void* destination, int bytesToReceive);
    bool ReceiveFrame();

    void CloseSocket();
    bool IsValidHeader(const AuraTcpFrameHeader& header) const;

    std::atomic<bool> stopRequested_;
    std::atomic<SOCKET> socket_;

    std::thread workerThread_;

    std::mutex frameMutex_;
    AuraTcpFrameHeader latestHeader_;
    std::vector<uint8_t> latestPixels_;
    bool hasFrame_;

    /*
        Owned by the receive thread. Frames are received into this buffer and
        then swapped with latestPixels_ under the mutex, so the steady state
        allocates nothing and the lock is held only for a pointer swap --
        never for a 3.7 MB copy.
    */
    std::vector<uint8_t> receiveBuffer_;
};