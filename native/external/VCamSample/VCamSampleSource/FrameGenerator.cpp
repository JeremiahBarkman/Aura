#include "pch.h"
#include "Undocumented.h"
#include "Tools.h"
#include "EnumNames.h"
#include "MFTools.h"
#include "FrameGenerator.h"
#include "AuraSharedMemory.h"

HRESULT FrameGenerator::EnsureRenderTarget(
    UINT width,
    UINT height
)
{
    if (!HasD3DManager())
    {
        wil::com_ptr_nothrow<ID2D1Factory> d2d1Factory;

        RETURN_IF_FAILED(
            D2D1CreateFactory(
                D2D1_FACTORY_TYPE_MULTI_THREADED,
                IID_PPV_ARGS(&d2d1Factory)
            )
        );

        wil::com_ptr_nothrow<IWICImagingFactory> wicFactory;

        RETURN_IF_FAILED(
            CoCreateInstance(
                CLSID_WICImagingFactory,
                nullptr,
                CLSCTX_ALL,
                IID_PPV_ARGS(&wicFactory)
            )
        );

        RETURN_IF_FAILED(
            wicFactory->CreateBitmap(
                width,
                height,
                GUID_WICPixelFormat32bppPBGRA,
                WICBitmapCacheOnDemand,
                &_bitmap
            )
        );

        D2D1_RENDER_TARGET_PROPERTIES properties{};

        properties.pixelFormat.format =
            DXGI_FORMAT_B8G8R8A8_UNORM;

        properties.pixelFormat.alphaMode =
            D2D1_ALPHA_MODE_PREMULTIPLIED;

        RETURN_IF_FAILED(
            d2d1Factory->CreateWicBitmapRenderTarget(
                _bitmap.get(),
                properties,
                &_renderTarget
            )
        );

        RETURN_IF_FAILED(
            CreateRenderTargetResources(
                width,
                height
            )
        );
    }

    _prevTime = MFGetSystemTime();
    _frame = 0;

    return S_OK;
}

const bool FrameGenerator::HasD3DManager() const
{
    return _texture != nullptr;
}

HRESULT FrameGenerator::SetD3DManager(
    IUnknown* manager,
    UINT width,
    UINT height
)
{
    RETURN_HR_IF_NULL(
        E_POINTER,
        manager
    );

    RETURN_HR_IF(
        E_INVALIDARG,
        !width || !height
    );

    RETURN_IF_FAILED(
        manager->QueryInterface(
            &_dxgiManager
        )
    );

    RETURN_IF_FAILED(
        _dxgiManager->OpenDeviceHandle(
            &_deviceHandle
        )
    );

    wil::com_ptr_nothrow<ID3D11Device> device;

    RETURN_IF_FAILED(
        _dxgiManager->GetVideoService(
            _deviceHandle,
            IID_PPV_ARGS(&device)
        )
    );

    CD3D11_TEXTURE2D_DESC description(
        DXGI_FORMAT_B8G8R8A8_UNORM,
        width,
        height,
        1,
        1,
        D3D11_BIND_SHADER_RESOURCE |
        D3D11_BIND_RENDER_TARGET
    );

    RETURN_IF_FAILED(
        device->CreateTexture2D(
            &description,
            nullptr,
            &_texture
        )
    );

    wil::com_ptr_nothrow<IDXGISurface> surface;

    RETURN_IF_FAILED(
        _texture.copy_to(
            &surface
        )
    );

    wil::com_ptr_nothrow<ID2D1Factory> d2d1Factory;

    RETURN_IF_FAILED(
        D2D1CreateFactory(
            D2D1_FACTORY_TYPE_MULTI_THREADED,
            IID_PPV_ARGS(&d2d1Factory)
        )
    );

    auto properties =
        D2D1::RenderTargetProperties(
            D2D1_RENDER_TARGET_TYPE_DEFAULT,
            D2D1::PixelFormat(
                DXGI_FORMAT_UNKNOWN,
                D2D1_ALPHA_MODE_PREMULTIPLIED
            )
        );

    RETURN_IF_FAILED(
        d2d1Factory->CreateDxgiSurfaceRenderTarget(
            surface.get(),
            properties,
            &_renderTarget
        )
    );

    RETURN_IF_FAILED(
        CreateRenderTargetResources(
            width,
            height
        )
    );

    RETURN_IF_FAILED(
        CoCreateInstance(
            CLSID_VideoProcessorMFT,
            nullptr,
            CLSCTX_ALL,
            IID_PPV_ARGS(&_converter)
        )
    );

    wil::com_ptr_nothrow<IMFAttributes> attributes;

    RETURN_IF_FAILED(
        _converter->GetAttributes(
            &attributes
        )
    );

    TraceMFAttributes(
        attributes.get(),
        L"VideoProcessorMFT"
    );

    MFT_OUTPUT_STREAM_INFO streamInfo{};

    RETURN_IF_FAILED(
        _converter->GetOutputStreamInfo(
            0,
            &streamInfo
        )
    );

    wil::com_ptr_nothrow<IMFMediaType> inputType;

    RETURN_IF_FAILED(
        MFCreateMediaType(
            &inputType
        )
    );

    inputType->SetGUID(
        MF_MT_MAJOR_TYPE,
        MFMediaType_Video
    );

    inputType->SetGUID(
        MF_MT_SUBTYPE,
        MFVideoFormat_RGB32
    );

    MFSetAttributeSize(
        inputType.get(),
        MF_MT_FRAME_SIZE,
        width,
        height
    );

    RETURN_IF_FAILED(
        _converter->SetInputType(
            0,
            inputType.get(),
            0
        )
    );

    wil::com_ptr_nothrow<IMFMediaType> outputType;

    RETURN_IF_FAILED(
        MFCreateMediaType(
            &outputType
        )
    );

    outputType->SetGUID(
        MF_MT_MAJOR_TYPE,
        MFMediaType_Video
    );

    outputType->SetGUID(
        MF_MT_SUBTYPE,
        MFVideoFormat_NV12
    );

    MFSetAttributeSize(
        outputType.get(),
        MF_MT_FRAME_SIZE,
        width,
        height
    );

    RETURN_IF_FAILED(
        _converter->SetOutputType(
            0,
            outputType.get(),
            0
        )
    );

    RETURN_IF_FAILED(
        _converter->ProcessMessage(
            MFT_MESSAGE_SET_D3D_MANAGER,
            reinterpret_cast<ULONG_PTR>(manager)
        )
    );

    return S_OK;
}

HRESULT FrameGenerator::CreateRenderTargetResources(
    UINT width,
    UINT height
)
{
    assert(_renderTarget);

    /*
        Aura production output does not need the Microsoft sample brushes,
        fonts, diagnostic text, circles, rectangles, or test pattern.
    */

    _width = width;
    _height = height;

    return S_OK;
}

HRESULT FrameGenerator::Generate(
    IMFSample* sample,
    REFGUID format,
    IMFSample** outSample
)
{
    RETURN_HR_IF_NULL(
        E_POINTER,
        sample
    );

    RETURN_HR_IF_NULL(
        E_POINTER,
        outSample
    );

    *outSample = nullptr;

    if (_renderTarget)
    {
        _renderTarget->BeginDraw();

        /*
            Black is the production-safe state before the first Aura frame.
            AuraSharedMemory::DrawLatestFrame() holds the last good frame after
            one has arrived, so transport interruptions never reveal the old
            Microsoft rainbow pattern.
        */
        _renderTarget->Clear(
            D2D1::ColorF(
                0.0f,
                0.0f,
                0.0f,
                1.0f
            )
        );

        AuraSharedMemory::DrawLatestFrame(
            _renderTarget.get(),
            _width,
            _height
        );

        const HRESULT drawResult =
            _renderTarget->EndDraw();

        if (
            drawResult == D2DERR_RECREATE_TARGET
            )
        {
            return drawResult;
        }

        RETURN_IF_FAILED(
            drawResult
        );
    }

    wil::com_ptr_nothrow<IMFMediaBuffer> mediaBuffer;

    if (HasD3DManager())
    {
        RETURN_IF_FAILED(
            sample->RemoveAllBuffers()
        );

        RETURN_IF_FAILED(
            MFCreateDXGISurfaceBuffer(
                __uuidof(ID3D11Texture2D),
                _texture.get(),
                0,
                FALSE,
                &mediaBuffer
            )
        );

        RETURN_IF_FAILED(
            sample->AddBuffer(
                mediaBuffer.get()
            )
        );

        if (
            format == MFVideoFormat_NV12
            )
        {
            assert(_converter);

            RETURN_IF_FAILED(
                _converter->ProcessInput(
                    0,
                    sample,
                    0
                )
            );

            MFT_OUTPUT_DATA_BUFFER outputBuffer{};
            DWORD status = 0;

            RETURN_IF_FAILED(
                _converter->ProcessOutput(
                    0,
                    1,
                    &outputBuffer,
                    &status
                )
            );

            *outSample =
                outputBuffer.pSample;
        }
        else
        {
            sample->AddRef();

            *outSample =
                sample;
        }

        _frame++;

        return S_OK;
    }

    RETURN_IF_FAILED(
        sample->GetBufferByIndex(
            0,
            &mediaBuffer
        )
    );

    wil::com_ptr_nothrow<IMF2DBuffer2> buffer2D;

    BYTE* scanline = nullptr;
    LONG pitch = 0;
    BYTE* start = nullptr;
    DWORD length = 0;

    RETURN_IF_FAILED(
        mediaBuffer->QueryInterface(
            IID_PPV_ARGS(&buffer2D)
        )
    );

    RETURN_IF_FAILED(
        buffer2D->Lock2DSize(
            MF2DBuffer_LockFlags_Write,
            &scanline,
            &pitch,
            &start,
            &length
        )
    );

    wil::com_ptr_nothrow<IWICBitmapLock> bitmapLock;

    HRESULT result =
        _bitmap->Lock(
            nullptr,
            WICBitmapLockRead,
            &bitmapLock
        );

    if (SUCCEEDED(result))
    {
        UINT bitmapWidth = 0;
        UINT bitmapHeight = 0;

        result =
            bitmapLock->GetSize(
                &bitmapWidth,
                &bitmapHeight
            );

        if (SUCCEEDED(result))
        {
            UINT bitmapStride = 0;

            result =
                bitmapLock->GetStride(
                    &bitmapStride
                );

            if (SUCCEEDED(result))
            {
                UINT bitmapSize = 0;
                WICInProcPointer bitmapPixels = nullptr;

                result =
                    bitmapLock->GetDataPointer(
                        &bitmapSize,
                        &bitmapPixels
                    );

                if (SUCCEEDED(result))
                {
                    if (
                        format == MFVideoFormat_NV12
                        )
                    {
                        result =
                            RGB32ToNV12(
                                bitmapPixels,
                                bitmapSize,
                                bitmapStride,
                                bitmapWidth,
                                bitmapHeight,
                                scanline,
                                length,
                                pitch
                            );
                    }
                    else
                    {
                        result =
                            (
                                bitmapSize != length ||
                                bitmapStride != pitch
                                )
                            ? E_FAIL
                            : S_OK;

                        if (
                            SUCCEEDED(result) &&
                            bitmapPixels
                            )
                        {
                            CopyMemory(
                                scanline,
                                bitmapPixels,
                                length
                            );
                        }
                    }

                    if (SUCCEEDED(result))
                    {
                        _frame++;

                        sample->AddRef();

                        *outSample =
                            sample;
                    }
                }
            }
        }

        bitmapLock.reset();
    }

    buffer2D->Unlock2D();

    return result;
}