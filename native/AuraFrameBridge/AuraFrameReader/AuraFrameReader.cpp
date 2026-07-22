#include <windows.h>
#include <cstdint>
#include <iostream>
#include <thread>
#include <chrono>

static constexpr wchar_t SharedMemoryName[] =
L"Local\\AuraFrameBridge";

static constexpr uint32_t AuraFrameMagic =
0x41555241; // 'AURA'

struct AuraFrameHeader
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

int main()
{
    HANDLE mapping = OpenFileMappingW(
        FILE_MAP_READ,
        FALSE,
        SharedMemoryName
    );

    if (!mapping)
    {
        std::cerr
            << "OpenFileMapping failed: "
            << GetLastError()
            << std::endl;

        std::cerr
            << "Start AuraFrameBridge writer first."
            << std::endl;

        return 1;
    }

    void* view = MapViewOfFile(
        mapping,
        FILE_MAP_READ,
        0,
        0,
        0
    );

    if (!view)
    {
        std::cerr
            << "MapViewOfFile failed: "
            << GetLastError()
            << std::endl;

        CloseHandle(mapping);
        return 1;
    }

    auto* header =
        reinterpret_cast<AuraFrameHeader*>(view);

    std::cout << "AuraFrameReader started." << std::endl;
    std::cout << "Reading shared memory frames." << std::endl;
    std::cout << "Press Ctrl+C to stop." << std::endl;

    uint64_t lastFrame = UINT64_MAX;

    while (true)
    {
        if (header->magic != AuraFrameMagic)
        {
            std::cout
                << "Waiting for valid Aura frame..."
                << std::endl;
        }
        else if (header->frameNumber != lastFrame)
        {
            lastFrame = header->frameNumber;

            std::cout
                << "Frame "
                << header->frameNumber
                << " | "
                << header->width
                << "x"
                << header->height
                << " | stride="
                << header->stride
                << " | dataSize="
                << header->dataSize
                << " | format="
                << header->format
                << std::endl;
        }

        std::this_thread::sleep_for(
            std::chrono::milliseconds(250)
        );
    }

    UnmapViewOfFile(view);
    CloseHandle(mapping);

    return 0;
}