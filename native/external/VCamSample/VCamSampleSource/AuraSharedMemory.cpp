#include "pch.h"
#include "AuraSharedMemory.h"
#include "TcpFrameClient.h"

#include <algorithm>
#include <cstdint>
#include <mutex>
#include <vector>

namespace
{
    std::mutex g_renderMutex;

    wil::com_ptr_nothrow<ID2D1Bitmap> g_bitmap;

    ID2D1RenderTarget* g_bitmapRenderTarget = nullptr;

    UINT g_bitmapWidth = 0;
    UINT g_bitmapHeight = 0;

    uint64_t g_lastBitmapFrameNumber = UINT64_MAX;

    void ResetCachedBitmap()
    {
        g_bitmap.reset();

        g_bitmapRenderTarget = nullptr;

        g_bitmapWidth = 0;
        g_bitmapHeight = 0;

        g_lastBitmapFrameNumber = UINT64_MAX;
    }

    D2D1_RECT_F CalculateContainedDestination(
        UINT sourceWidth,
        UINT sourceHeight,
        UINT targetWidth,
        UINT targetHeight
    )
    {
        if (
            sourceWidth == 0 ||
            sourceHeight == 0 ||
            targetWidth == 0 ||
            targetHeight == 0
            )
        {
            return D2D1::RectF(
                0.0f,
                0.0f,
                static_cast<FLOAT>(targetWidth),
                static_cast<FLOAT>(targetHeight)
            );
        }

        const FLOAT sourceAspect =
            static_cast<FLOAT>(sourceWidth) /
            static_cast<FLOAT>(sourceHeight);

        const FLOAT targetAspect =
            static_cast<FLOAT>(targetWidth) /
            static_cast<FLOAT>(targetHeight);

        FLOAT destinationWidth = 0.0f;
        FLOAT destinationHeight = 0.0f;

        if (sourceAspect > targetAspect)
        {
            /*
                Source is wider than the camera output.

                Fit to the target width and add bars above and below.
            */
            destinationWidth =
                static_cast<FLOAT>(targetWidth);

            destinationHeight =
                destinationWidth / sourceAspect;
        }
        else
        {
            /*
                Source is taller than the camera output.

                Fit to the target height and add bars on the sides.
            */
            destinationHeight =
                static_cast<FLOAT>(targetHeight);

            destinationWidth =
                destinationHeight * sourceAspect;
        }

        const FLOAT left =
            (
                static_cast<FLOAT>(targetWidth) -
                destinationWidth
                ) / 2.0f;

        const FLOAT top =
            (
                static_cast<FLOAT>(targetHeight) -
                destinationHeight
                ) / 2.0f;

        return D2D1::RectF(
            left,
            top,
            left + destinationWidth,
            top + destinationHeight
        );
    }

    bool CreateCachedBitmap(
        ID2D1RenderTarget* renderTarget,
        const AuraTcpFrameHeader& header,
        const std::vector<uint8_t>& pixels
    )
    {
        D2D1_BITMAP_PROPERTIES bitmapProperties{};

        bitmapProperties.pixelFormat.format =
            DXGI_FORMAT_B8G8R8A8_UNORM;

        bitmapProperties.pixelFormat.alphaMode =
            D2D1_ALPHA_MODE_IGNORE;

        wil::com_ptr_nothrow<ID2D1Bitmap> newBitmap;

        const HRESULT result =
            renderTarget->CreateBitmap(
                D2D1::SizeU(
                    header.width,
                    header.height
                ),
                pixels.data(),
                header.stride,
                bitmapProperties,
                &newBitmap
            );

        if (FAILED(result) || !newBitmap)
        {
            return false;
        }

        g_bitmap = std::move(newBitmap);

        g_bitmapRenderTarget = renderTarget;

        g_bitmapWidth = header.width;
        g_bitmapHeight = header.height;

        g_lastBitmapFrameNumber =
            header.frameNumber;

        return true;
    }

    bool UpdateCachedBitmap(
        const AuraTcpFrameHeader& header,
        const std::vector<uint8_t>& pixels
    )
    {
        if (!g_bitmap)
        {
            return false;
        }

        const HRESULT result =
            g_bitmap->CopyFromMemory(
                nullptr,
                pixels.data(),
                header.stride
            );

        if (FAILED(result))
        {
            return false;
        }

        g_lastBitmapFrameNumber =
            header.frameNumber;

        return true;
    }
}

namespace AuraSharedMemory
{
    bool DrawLatestFrame(
        ID2D1RenderTarget* renderTarget,
        UINT targetWidth,
        UINT targetHeight
    )
    {
        /*
            Once the Aura renderer is active, always return true for a valid
            render target.

            Returning false activates the old Microsoft rainbow fallback.
            Temporary transport delays should instead hold the last good frame.
        */
        if (!renderTarget)
        {
            return false;
        }

        std::lock_guard<std::mutex> lock(
            g_renderMutex
        );

        AuraTcpFrameHeader header{};
        std::vector<uint8_t> pixels;

        const bool hasFrame =
            TcpFrameClient::Instance().CopyLatestFrame(
                header,
                pixels
            );

        /*
            If the render target changed, the existing Direct2D bitmap belongs
            to the old target and must be recreated.
        */
        if (
            g_bitmap &&
            g_bitmapRenderTarget != renderTarget
            )
        {
            ResetCachedBitmap();
        }

        if (hasFrame)
        {
            const bool dimensionsChanged =
                !g_bitmap ||
                g_bitmapWidth != header.width ||
                g_bitmapHeight != header.height;

            if (dimensionsChanged)
            {
                ResetCachedBitmap();

                CreateCachedBitmap(
                    renderTarget,
                    header,
                    pixels
                );
            }
            else if (
                header.frameNumber !=
                g_lastBitmapFrameNumber
                )
            {
                if (
                    !UpdateCachedBitmap(
                        header,
                        pixels
                    )
                    )
                {
                    /*
                        If updating the existing bitmap fails, attempt one clean
                        recreation before retaining the last rendered state.
                    */
                    ResetCachedBitmap();

                    CreateCachedBitmap(
                        renderTarget,
                        header,
                        pixels
                    );
                }
            }
        }

        /*
            Clear the unused camera-output area to black. This produces clean
            letterboxing rather than stretching the Aura frame.
        */
        renderTarget->Clear(
            D2D1::ColorF(
                0.0f,
                0.0f,
                0.0f,
                1.0f
            )
        );

        if (g_bitmap)
        {
            const D2D1_RECT_F destination =
                CalculateContainedDestination(
                    g_bitmapWidth,
                    g_bitmapHeight,
                    targetWidth,
                    targetHeight
                );

            renderTarget->DrawBitmap(
                g_bitmap.get(),
                destination,
                1.0f,
                D2D1_BITMAP_INTERPOLATION_MODE_LINEAR
            );
        }

        /*
            Return true even when the TCP connection briefly lacks a frame.
            This prevents flashes of the Microsoft rainbow fallback and keeps
            the last successful Aura frame visible.
        */
        return true;
    }
}