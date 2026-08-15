# dstORCH

Chrome MV3 extension for the dual-stream transcription pipeline. It captures two audio
streams from a Google Meet call — the local microphone and the tab's own audio — and
sends them, kept separate, to the [`dstDESK`](https://github.com/hrantsp/dstDESK)
desktop application.

`dstORCH` is the *orchestra*: it plays, and `dstDESK` listens.

The wire protocol is defined by `dstDESK`. This repository consumes a generated copy of
it rather than maintaining its own.

Built and versioned by [`dstOMNI`](https://github.com/hrantsp/dstOMNI) — see that
repository for the workspace layout and build instructions.
