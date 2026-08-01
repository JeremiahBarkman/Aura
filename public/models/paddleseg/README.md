# PaddleSeg models

`PaddleSegSegmentationProvider` loads an ONNX-exported PaddleSeg model from
here. Default path:

```
/models/paddleseg/pp_humanseg.onnx
```

## Bundled model

`pp_humanseg.onnx` is **PP-HumanSeg**, 192x192 input, 6.1 MB.

- **License**: Apache 2.0, Copyright (c) 2021 PaddlePaddle Authors — see
  `LICENSE` in this directory.
- **Source**: [opencv/human_segmentation_pphumanseg](https://huggingface.co/opencv/human_segmentation_pphumanseg)
  (`human_segmentation_pphumanseg_2023mar.onnx`), ported from PaddleHub by
  OpenCV with [their conversion script](https://github.com/opencv/opencv/blob/master/samples/dnn/dnn_model_runner/dnn_conversion/paddlepaddle/paddle_humanseg.py).

Taken pre-converted because PaddleSeg publishes only Paddle inference format,
and converting locally needs `paddle2onnx` + `paddlepaddle`, which have no
wheels for the Python 3.14 on this machine.

To use a different model instead:

```js
createSegmentationProvider('paddleseg', { modelUrl: '/models/paddleseg/your-model.onnx' })
```

## Model contract

Input size is read from the ONNX graph, so a static-shaped export at any
resolution works. What the provider does assume:

- **Input**: NCHW `float32`, 3 channels, normalized mean/std `0.5` per channel
  (pixels mapped `[0,255]` → `[-1,1]`). Matches both PaddleSeg's `Normalize`
  default and OpenCV's `pphumanseg.py`.
- **Output**: `[1,2,H,W]` two-class (channel 0 background, channel 1 person),
  or `[1,1,H,W]` / `[1,H,W]` person probability. Any other rank is rejected at
  runtime with an explicit error rather than rendering a wrong-but-plausible
  mask.

**Softmax is auto-detected, not configured.** PaddleSeg ships both a
`..._with_softmax` export (Softmax baked into the graph, output already sums
to 1) and a plain one (raw logits). Softmaxing an already-softmaxed output
does not error — it quietly compresses the mask toward 0.5 and washes the
cutout out. The provider samples the first real output and picks the right
path, logging which it chose. The bundled model has Softmax in-graph.

If a mask still looks inverted or washed out with some other model, the
normalization above is the first thing to check.

## `__synthetic_test.onnx`

**Not a segmentation model.** A ~1.3 KB stand-in generated with
`torch.onnx.export` that mimics only the I/O contract — its "person" score
just tracks the red channel, and it deliberately has *no* Softmax so it
exercises the raw-logits path. Used by `public/paddleseg-test/` to verify
tensor layout, mask generation and compositing deterministically. Not useful
for anything else.
