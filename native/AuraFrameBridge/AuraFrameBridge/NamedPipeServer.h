#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include "FrameBuffer.h"

class NamedPipeServer
{
public:
    explicit NamedPipeServer(FrameBuffer& frameBuffer);

    void Run();

private:
    bool ReadExact(
        HANDLE handle,
        void* buffer,
        DWORD bytesToRead
    );

    void HandleClient(HANDLE pipe);

    FrameBuffer& frameBuffer_;
};
