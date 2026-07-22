#include "AuraFrameTypes.h"
#include "FrameBuffer.h"
#include "NamedPipeServer.h"
#include "TcpFrameServer.h"

#include <chrono>
#include <iostream>
#include <thread>
#include <vector>

namespace
{
    void WriteFallbackFrame(
        FrameBuffer& frameBuffer,
        uint64_t frameNumber
    )
    {
        const uint32_t width = AuraDefaultWidth;
        const uint32_t height = AuraDefaultHeight;
        const uint32_t stride = width * AuraBytesPerPixel;
        const uint32_t dataSize = stride * height;

        std::vector<uint8_t> pixels(dataSize);

        for (uint32_t y = 0; y < height; y++)
        {
            for (uint32_t x = 0; x < width; x++)
            {
                const uint32_t offset =
                    y * stride + x * AuraBytesPerPixel;

                pixels[offset + 0] =
                    static_cast<uint8_t>((x + frameNumber) % 256);

                pixels[offset + 1] =
                    static_cast<uint8_t>((y + frameNumber) % 256);

                pixels[offset + 2] =
                    static_cast<uint8_t>((x + y + frameNumber) % 256);

                pixels[offset + 3] = 255;
            }
        }

        AuraFrameHeader header{};
        header.magic = AuraFrameMagic;
        header.version = AuraFrameVersion;
        header.width = width;
        header.height = height;
        header.stride = stride;
        header.format = AuraFrameFormatBGRA32;
        header.frameNumber = frameNumber;
        header.timestampMs = AuraNowMs();
        header.dataSize = dataSize;

        frameBuffer.WriteFrame(header, pixels.data());
    }
}

int main()
{
    std::cout << "AuraFrameBridge started." << std::endl;
    std::cout << "Named pipe input: \\\\.\\pipe\\AuraFrameBridgePipe" << std::endl;
    std::cout << "TCP frame output: 127.0.0.1:5151" << std::endl;
    std::cout << "Waiting for Aura frames..." << std::endl;
    std::cout << "Press Ctrl+C to stop." << std::endl;

    FrameBuffer frameBuffer;

    NamedPipeServer pipeServer(frameBuffer);
    TcpFrameServer tcpServer(frameBuffer);

    std::thread pipeThread(
        [&pipeServer]()
        {
            pipeServer.Run();
        }
    );

    std::thread tcpThread(
        [&tcpServer]()
        {
            tcpServer.Run();
        }
    );

    pipeThread.detach();
    tcpThread.detach();
    while (true)
    {
        /*
            Production bridge.

            Never generate diagnostic frames.

            The FrameBuffer always retains the last successfully received Aura
            frame, so simply stay alive and allow the TCP server to continue
            serving that image until a newer Aura frame arrives.
        */

        std::this_thread::sleep_for(
            std::chrono::milliseconds(33)
        );
    }

    return 0;
}
