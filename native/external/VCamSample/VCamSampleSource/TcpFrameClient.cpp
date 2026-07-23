#include "pch.h"
#include "TcpFrameClient.h"

#include <chrono>

#pragma comment(lib, "Ws2_32.lib")

namespace
{
    constexpr uint32_t AuraFrameMagic =
        0x41555241; // 'AURA'

    constexpr uint32_t AuraFrameVersion = 1;
    constexpr uint32_t AuraFrameFormatBGRA32 = 1;

    constexpr uint16_t AuraTcpFramePort = 5151;

    constexpr uint32_t AuraMaximumWidth = 3840;
    constexpr uint32_t AuraMaximumHeight = 2160;
    constexpr uint32_t AuraBytesPerPixel = 4;

    constexpr uint32_t AuraMaximumPayloadSize =
        AuraMaximumWidth *
        AuraMaximumHeight *
        AuraBytesPerPixel;
}

TcpFrameClient& TcpFrameClient::Instance()
{
    static TcpFrameClient instance;
    return instance;
}

TcpFrameClient::TcpFrameClient()
    : stopRequested_(false),
    socket_(INVALID_SOCKET),
    latestHeader_{},
    hasFrame_(false)
{
    workerThread_ =
        std::thread(
            [this]()
            {
                Run();
            }
        );
}

TcpFrameClient::~TcpFrameClient()
{
    stopRequested_.store(true);

    const SOCKET activeSocket =
        socket_.exchange(INVALID_SOCKET);

    if (activeSocket != INVALID_SOCKET)
    {
        shutdown(activeSocket, SD_BOTH);
        closesocket(activeSocket);
    }

    if (workerThread_.joinable())
    {
        workerThread_.join();
    }
}

bool TcpFrameClient::CopyLatestFrameIfNewer(
    uint64_t lastSeenFrameNumber,
    AuraTcpFrameHeader& header,
    std::vector<uint8_t>& pixels
)
{
    std::lock_guard<std::mutex> lock(frameMutex_);

    if (!hasFrame_ || latestPixels_.empty())
    {
        return false;
    }

    /*
        The cheap check first: when the caller's cached frame is still
        current, return before touching the pixel data at all. Inequality
        rather than greater-than so a renderer restart (which resets frame
        numbering) resumes immediately.
    */
    if (latestHeader_.frameNumber == lastSeenFrameNumber)
    {
        return false;
    }

    header = latestHeader_;

    /*
        assign() reuses the caller's capacity; with a hoisted destination
        vector this copies without allocating.
    */
    pixels.assign(
        latestPixels_.begin(),
        latestPixels_.end()
    );

    return true;
}

bool TcpFrameClient::IsValidHeader(
    const AuraTcpFrameHeader& header
) const
{
    if (
        header.magic != AuraFrameMagic ||
        header.version != AuraFrameVersion ||
        header.format != AuraFrameFormatBGRA32
        )
    {
        return false;
    }

    if (
        header.width == 0 ||
        header.height == 0 ||
        header.width > AuraMaximumWidth ||
        header.height > AuraMaximumHeight
        )
    {
        return false;
    }

    if (
        header.stride < header.width * AuraBytesPerPixel ||
        header.dataSize == 0 ||
        header.dataSize > AuraMaximumPayloadSize
        )
    {
        return false;
    }

    const uint64_t minimumPayloadSize =
        static_cast<uint64_t>(header.stride) *
        static_cast<uint64_t>(header.height);

    return header.dataSize >= minimumPayloadSize;
}

bool TcpFrameClient::Connect()
{
    SOCKET newSocket =
        socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);

    if (newSocket == INVALID_SOCKET)
    {
        return false;
    }

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(AuraTcpFramePort);

    if (
        inet_pton(
            AF_INET,
            "127.0.0.1",
            &address.sin_addr
        ) != 1
        )
    {
        closesocket(newSocket);
        return false;
    }

    if (
        connect(
            newSocket,
            reinterpret_cast<sockaddr*>(&address),
            sizeof(address)
        ) == SOCKET_ERROR
        )
    {
        closesocket(newSocket);
        return false;
    }

    BOOL noDelay = TRUE;

    setsockopt(
        newSocket,
        IPPROTO_TCP,
        TCP_NODELAY,
        reinterpret_cast<const char*>(&noDelay),
        sizeof(noDelay)
    );

    socket_.store(newSocket);

    return true;
}

bool TcpFrameClient::ReceiveExact(
    void* destination,
    int bytesToReceive
)
{
    auto* output =
        static_cast<uint8_t*>(destination);

    int totalReceived = 0;

    while (
        totalReceived < bytesToReceive &&
        !stopRequested_.load()
        )
    {
        const SOCKET activeSocket = socket_.load();

        if (activeSocket == INVALID_SOCKET)
        {
            return false;
        }

        const int received =
            recv(
                activeSocket,
                reinterpret_cast<char*>(
                    output + totalReceived
                    ),
                bytesToReceive - totalReceived,
                0
            );

        if (received <= 0)
        {
            return false;
        }

        totalReceived += received;
    }

    return totalReceived == bytesToReceive;
}

bool TcpFrameClient::ReceiveFrame()
{
    AuraTcpFrameHeader header{};

    if (
        !ReceiveExact(
            &header,
            static_cast<int>(sizeof(header))
        )
        )
    {
        return false;
    }

    if (!IsValidHeader(header))
    {
        return false;
    }

    /*
        Receive into the persistent buffer (resize is a no-op once capacity
        has stabilized), then publish by swapping under the mutex. The old
        code allocated a fresh vector for every frame -- ~3.7 MB, 30 times a
        second -- and the swap keeps the lock hold-time to a pointer
        exchange instead of a full copy.
    */
    receiveBuffer_.resize(header.dataSize);

    if (
        !ReceiveExact(
            receiveBuffer_.data(),
            static_cast<int>(receiveBuffer_.size())
        )
        )
    {
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(frameMutex_);

        latestHeader_ = header;
        latestPixels_.swap(receiveBuffer_);
        hasFrame_ = true;
    }

    return true;
}

void TcpFrameClient::CloseSocket()
{
    const SOCKET activeSocket =
        socket_.exchange(INVALID_SOCKET);

    if (activeSocket != INVALID_SOCKET)
    {
        shutdown(activeSocket, SD_BOTH);
        closesocket(activeSocket);
    }
}

void TcpFrameClient::Run()
{
    WSADATA wsaData{};

    if (
        WSAStartup(
            MAKEWORD(2, 2),
            &wsaData
        ) != 0
        )
    {
        return;
    }

    while (!stopRequested_.load())
    {
        if (socket_.load() == INVALID_SOCKET)
        {
            if (!Connect())
            {
                std::this_thread::sleep_for(
                    std::chrono::milliseconds(500)
                );

                continue;
            }
        }

        if (!ReceiveFrame())
        {
            CloseSocket();

            std::this_thread::sleep_for(
                std::chrono::milliseconds(250)
            );
        }
    }

    CloseSocket();
    WSACleanup();
}