# Canvas boards

Two episode boards as the extension posts their cards (`core/canvasProtocol.ts`, `CanvasCard`), for the layout tests
(`canvasLayout.test.ts`): `double-life-EP001.json`, from a real EP001 production (double-life-r4), and
`keyframes-EP001.json`, an episode with a keyframe per shot. They were converted once from drama-cli's
`export comfyui` of those projects when the canvas moved to the protocol (doc/protocol.md); only the cards' geometry
inputs matter here (section, column, kind, segment).
