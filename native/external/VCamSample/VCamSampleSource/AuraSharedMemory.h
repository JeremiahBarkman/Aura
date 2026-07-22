#pragma once

#include <d2d1.h>

namespace AuraSharedMemory
{
    bool DrawLatestFrame(
        ID2D1RenderTarget* renderTarget,
        UINT targetWidth,
        UINT targetHeight
    );
}
