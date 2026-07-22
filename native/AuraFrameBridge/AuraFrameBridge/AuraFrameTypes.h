#pragma once

#include <cstdint>
#include <chrono>

static constexpr uint32_t AuraFrameMagic = 0x41555241; // AURA
static constexpr uint32_t AuraFrameVersion = 1;
static constexpr uint32_t AuraFrameFormatBGRA32 = 1;
static constexpr uint32_t AuraBytesPerPixel = 4;

static constexpr uint32_t AuraDefaultWidth = 1280;
static constexpr uint32_t AuraDefaultHeight = 720;

static constexpr wchar_t AuraPipeName[] =
L"\\\\.\\pipe\\AuraFrameBridgePipe";

static constexpr uint16_t AuraTcpFramePort = 5151;

#pragma pack(push, 1)

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

#pragma pack(pop)

inline uint64_t AuraNowMs()
{
    using namespace std::chrono;

    return static_cast<uint64_t>(
        duration_cast<milliseconds>(
            steady_clock::now().time_since_epoch()
        ).count()
        );
}
