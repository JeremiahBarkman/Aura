#include "NamedPipeServer.h"

#include <iostream>

#include <iostream>
#include <vector>

NamedPipeServer::NamedPipeServer(FrameBuffer& frameBuffer)
    : frameBuffer_(frameBuffer)
{
}

bool NamedPipeServer::ReadExact(
    HANDLE handle,
    void* buffer,
    DWORD bytesToRead
)
{
    auto* output = static_cast<uint8_t*>(buffer);
    DWORD totalRead = 0;

    while (totalRead < bytesToRead)
    {
        DWORD bytesRead = 0;

        BOOL ok = ReadFile(
            handle,
            output + totalRead,
            bytesToRead - totalRead,
            &bytesRead,
            nullptr
        );

        if (!ok || bytesRead == 0)
        {
            return false;
        }

        totalRead += bytesRead;
    }

    return true;
}

void NamedPipeServer::HandleClient(HANDLE pipe)
{
    /*
        A single client connection stays open for the life of a camera
        session (potentially thousands of frames), not just one frame.
        Keep reading frames until the client disconnects or sends a
        malformed header/payload.
    */
    while (true)
    {
        AuraFrameHeader header{};

        if (!ReadExact(pipe, &header, sizeof(header)))
        {
            return;
        }

        if (
            header.magic != AuraFrameMagic ||
            header.version != AuraFrameVersion ||
            header.format != AuraFrameFormatBGRA32 ||
            header.width == 0 ||
            header.height == 0 ||
            header.stride == 0 ||
            header.dataSize == 0 ||
            header.dataSize > 3840 * 2160 * AuraBytesPerPixel
            )
        {
            std::cerr << "Invalid Aura frame header received." << std::endl;
            return;
        }

        std::vector<uint8_t> pixels(header.dataSize);

        if (!ReadExact(pipe, pixels.data(), header.dataSize))
        {
            std::cerr << "Failed to read Aura frame payload." << std::endl;
            return;
        }

        frameBuffer_.WriteFrame(
            header,
            pixels.data()
        );

        if (header.frameNumber % 30 == 0)
        {
            std::cout
                << "Received Aura frame "
                << header.frameNumber
                << " | "
                << header.width
                << "x"
                << header.height
                << " | bytes="
                << header.dataSize
                << std::endl;
        }
    }
}

void NamedPipeServer::Run()
{
    std::cout
        << "Named pipe input listening on \\\\.\\pipe\\AuraFrameBridgePipe"
        << std::endl;

    while (true)
    {
        HANDLE pipe = CreateNamedPipeW(
            AuraPipeName,
            PIPE_ACCESS_INBOUND,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            4,
            0,
            1024 * 1024,
            0,
            nullptr
        );

        if (pipe == INVALID_HANDLE_VALUE)
        {
            std::cerr
                << "CreateNamedPipe failed: "
                << GetLastError()
                << std::endl;

            Sleep(1000);
            continue;
        }

        BOOL connected =
            ConnectNamedPipe(pipe, nullptr)
            ? TRUE
            : GetLastError() == ERROR_PIPE_CONNECTED;

        if (connected)
        {
            HandleClient(pipe);
        }

        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }
}
