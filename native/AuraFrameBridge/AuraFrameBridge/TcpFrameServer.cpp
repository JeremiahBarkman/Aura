#include "TcpFrameServer.h"

#include <iostream>
#include <thread>
#include <vector>
#include <ws2tcpip.h>

#pragma comment(lib, "Ws2_32.lib")

TcpFrameServer::TcpFrameServer(FrameBuffer& frameBuffer)
    : frameBuffer_(frameBuffer),
    clientCount_(0)
{
}

bool TcpFrameServer::SendExact(
    SOCKET socket,
    const void* data,
    int bytesToSend
)
{
    const char* cursor = static_cast<const char*>(data);
    int totalSent = 0;

    while (totalSent < bytesToSend)
    {
        int sent = send(
            socket,
            cursor + totalSent,
            bytesToSend - totalSent,
            0
        );

        if (sent <= 0)
        {
            return false;
        }

        totalSent += sent;
    }

    return true;
}

void TcpFrameServer::HandleClient(SOCKET clientSocket)
{
    const uint64_t clientId = ++clientCount_;

    std::cout
        << "TCP camera client connected #"
        << clientId
        << std::endl;

    uint64_t lastSentFrameNumber = UINT64_MAX;

    /*
        Hoisted out of the loop: with FrameBuffer::WaitForNewFrame's assign()
        reusing this capacity, the steady-state send path performs zero heap
        allocations. The old code allocated and freed ~3.7 MB every 5 ms per
        client whether or not a new frame existed.
    */
    AuraFrameHeader header{};
    std::vector<uint8_t> pixels;

    while (true)
    {
        /*
            Sleep until the writer publishes a genuinely new frame. The
            timeout only bounds how often this loop re-checks a dead-idle
            stream; a broken connection is still detected by send() failing.
        */
        if (!frameBuffer_.WaitForNewFrame(
            lastSentFrameNumber,
            header,
            pixels,
            250
        ))
        {
            continue;
        }

        if (!SendExact(clientSocket, &header, sizeof(header)))
        {
            break;
        }

        if (!SendExact(
            clientSocket,
            pixels.data(),
            static_cast<int>(pixels.size())
        ))
        {
            break;
        }

        lastSentFrameNumber = header.frameNumber;
    }

    std::cout
        << "TCP camera client disconnected #"
        << clientId
        << std::endl;
}

void TcpFrameServer::Run()
{
    std::cout << "TCP frame server starting on 127.0.0.1:5151" << std::endl;

    WSADATA wsaData{};

    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0)
    {
        std::cerr << "WSAStartup failed." << std::endl;
        return;
    }

    SOCKET listenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);

    if (listenSocket == INVALID_SOCKET)
    {
        std::cerr << "socket failed: " << WSAGetLastError() << std::endl;
        WSACleanup();
        return;
    }

    BOOL reuse = TRUE;
    setsockopt(
        listenSocket,
        SOL_SOCKET,
        SO_REUSEADDR,
        reinterpret_cast<const char*>(&reuse),
        sizeof(reuse)
    );

    sockaddr_in service{};
    service.sin_family = AF_INET;
    service.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    service.sin_port = htons(AuraTcpFramePort);

    if (
        bind(
            listenSocket,
            reinterpret_cast<SOCKADDR*>(&service),
            sizeof(service)
        ) == SOCKET_ERROR
        )
    {
        std::cerr << "bind failed: " << WSAGetLastError() << std::endl;
        closesocket(listenSocket);
        WSACleanup();
        return;
    }

    if (listen(listenSocket, SOMAXCONN) == SOCKET_ERROR)
    {
        std::cerr << "listen failed: " << WSAGetLastError() << std::endl;
        closesocket(listenSocket);
        WSACleanup();
        return;
    }

    std::cout << "TCP frame server listening on 127.0.0.1:5151" << std::endl;

    while (true)
    {
        SOCKET clientSocket = accept(listenSocket, nullptr, nullptr);

        if (clientSocket == INVALID_SOCKET)
        {
            continue;
        }

        std::thread clientThread(
            [this, clientSocket]()
            {
                HandleClient(clientSocket);
                closesocket(clientSocket);
            }
        );

        clientThread.detach();
    }
}
