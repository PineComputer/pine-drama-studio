# Pine Drama Studio's app icon

The mark is the slate: Pine Computer's viewfinder corners with the top-left arm opened like a clapper stick, and the
mint light under it. It was chosen on 2026-11-02. Its source lives in pine-computer-narrative, at
`brand/concepts/video-studio-mark/`: the drawings, the build, the motion spec for the chat's working indicator, and
the trademark screen.

| file | what | who reads it |
|---|---|---|
| `pine-drama-studio.icns` | every size `iconutil` asks for: 16, 32, 128, 256 and 512, each with its @2x | packaging (`Contents/Resources/Pine Drama Studio.icns`) |
| `pine-drama-studio.svg` | the master: a 1024 canvas with the macOS tile (824 px at 100, 100) | rebuilding |
| `pine-drama-studio-1024.png` | the master as a PNG | reference |
| `small/` | the 16, 32 and 64 px entries, drawn on the pixel grid | rebuilding |

**Rebuilding from the SVG alone loses the small sizes.** At 16, 32 and 64 px the clapper stick is drawn pixel by
pixel, a solid stepped bar; rasterised from the vector it becomes a faint scratch. When rebuilding the iconset,
take `icon_16x16`, `icon_16x16@2x`, `icon_32x32` and `icon_32x32@2x` from `small/`, and rasterise only 128 and up
from the SVG.
