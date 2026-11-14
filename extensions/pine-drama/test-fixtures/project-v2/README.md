# Major-2 project fixture

Two small Pine Drama projects in the form of [protocol major 2](../../../../doc/protocol.md): each folder is a project
(`pine-drama-project.json`), each object a folder holding `object.json`, its shown file and, for a paid output, its
`<file>.receipt.json` with the sha256 of every input it was sent.

**Hand-built until drama-cli's turn v2 lands** (worker-03): then these folders are replaced by ones drama-cli makes with
fake providers, so the fixture and the Computer side have one source.

- `after-bible/`: the project right after the bible. The screenplay and the bible are written, EP001 is planned, and
  Lin, the office and the umbrella are planned cards with their descriptions and nothing drawn. The render smoke opens
  it too: a blank-canvas bug once slipped through because only drawn fixtures were tested.
- `full/`: the same drama further on. Lin has a look and a variant, In the rain, drawn from it; the office's picture is
  the person's own (no receipt); the street is planned; the umbrella is drawn. EP001 has its breakdown, seg01's keyframe
  and take (drawn from the keyframe and Lin's look), and seg02's take, planned. Each drawn-from object's `objects_sent_by_draw_request` lists what its draw request sends
(seg02's: Lin, the umbrella and the street), the one source of the canvas's lines.

The pictures are 1x1 PNGs; the take is a one-second grey H.264 clip. The folders hold no `.git`: a test that needs
history copies a folder and commits it.
