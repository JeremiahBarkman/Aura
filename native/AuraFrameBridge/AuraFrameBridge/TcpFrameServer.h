#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <winsock2.h>
#include <ws2tcpip.h>

#include "FrameBuffer.h"

#include <atomic>

class TcpFrameServer
{
public:
    explicit TcpFrameServer(FrameBuffer& frameBuffer);

    void Run();

private:
    bool SendExact(
        SOCKET socket,
        const void* data,
        int bytesToSend
    );

    void HandleClient(SOCKET clientSocket);

    FrameBuffer& frameBuffer_;
    std::atomic<uint64_t> clientCount_;
};
