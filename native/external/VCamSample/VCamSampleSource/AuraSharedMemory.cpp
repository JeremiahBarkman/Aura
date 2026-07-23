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

    /*
        Persistent staging buffer for frame copies, guarded by g_renderMutex.
        Hoisted so the per-sample path never allocates: the old local vector
        re-allocated ~3.7 MB on every generated camera sample.
    */
    std::vector<uint8_t> g_framePixels;

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

        /*
            If the render target changed, the existing Direct2D bitmap
            belongs to the old target and must be recreated. This runs
            BEFORE the copy check on purpose: resetting sets
            g_lastBitmapFrameNumber back to the sentinel, which forces the
            copy below to fetch pixels for the recreation even when the
            frame number itself has not advanced.
        */
        if (
            g_bitmap &&
            g_bitmapRenderTarget != renderTarget
            )
        {
            ResetCachedBitmap();
        }

        /*
            Copies only when the client holds a frame newer than the one
            already uploaded to the cached bitmap. The common case at
            camera-sample cadence -- no new Aura frame yet -- now costs a
            frame-number comparison instead of a 3.7 MB copy.
        */
        AuraTcpFrameHeader header{};

        const bool hasNewFrame =
            TcpFrameClient::Instance().CopyLatestFrameIfNewer(
                g_lastBitmapFrameNumber,
                header,
                g_framePixels
            );

        if (hasNewFrame)
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
                    g_framePixels
                );
            }
            else if (
                !UpdateCachedBitmap(
                    header,
                    g_framePixels
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
                    g_framePixels
                );
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