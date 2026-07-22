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

    bool CopyLatestFrame(
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
};