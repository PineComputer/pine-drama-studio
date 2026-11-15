# Vocabulary

This page defines each production term the Studio, drama-cli and the [protocol](protocol.md) use, as Pine Drama uses it. Each entry names its official source in the film and VFX industry, and says whether our meaning matches it exactly, is a subset of it, or is our own.

How to read the columns:
- **Source** is the standard or vendor page that defines the term. AYON is the base model: it is open source and documents its data model publicly ([why](#base-model)). Where AYON's pages are silent, the source is Autodesk Flow Production Tracking (ShotGrid), OpenTimelineIO, OpenUSD, the Fountain screenplay syntax, or Pine Computer's documentation.
- **Match** says how our meaning relates to the source's:
  - **exact**: same word, same meaning;
  - **subset**: same idea, and we use less of it;
  - **Pine Drama term**: no official counterpart. The reason is given in one line, with a link to the place that defines the term: our [protocol](protocol.md), Pine's documentation, or the video model vendor's guide.
- **Under review** marks a term whose official name differs from ours. A rename is proposed and waits for the person's decision; until then the current term stays in use.


## Three layers

Each term belongs to one of three layers, named under each section below:
1. **Production domain.** What the drama is made of: projects, episodes, assets, pictures and the cut. Industry terms are used wherever the industry has one.
2. **Object and history model.** How each thing made is stored and related: objects, their history and their relations. This layer is modelled on AYON.
3. **Agent execution model.** How the work runs: sessions and turns on a Pine Computer. This layer is native to Pine.

Two of our terms stay apart from their nearest industry terms. They name units of AI generation; they do not fill gaps in the industry's model:
- **segment, not shot.** A segment is what a video model generates in one request, within the model's duration range. One segment may hold several shots, and the shot stays the editorial unit.
- **take, not a separate Version kind.** A take is one paid generation of a segment, in the sense film gives a take: one attempt at the same material. Each take is one result in the take object's history.

## Base model

AYON's model is used as the base:
- a Project holds Folders of a type, such as Episode, Sequence, Shot and AssetBuild;
- a Folder holds Products, each of one product type and named by type plus variant;
- a Product has Versions, and a Version has Representations;
- Statuses, Links and an Activity feed sit on these entities ([AYON Glossary][ayon-glossary], [Project Anatomy][ayon-anatomy]).

Two of its rules fit Pine Drama directly:
- A publish is "exporting data from your work scene to a versioned, immutable file" ([AYON Glossary][ayon-glossary]). A Pine Drama result is likewise never changed: history keeps every one ([protocol §2.1][p-history]).
- Folder types and product types are defined per project ([Project Anatomy][ayon-anatomy]). So a production type of our own, such as a storyboard, is a project-defined type inside the official model.

## Production structure

Layer: production domain.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **project** | A folder that holds one drama: its files and their history. | AYON **Project**: "the dedicated workspace that contains everything related to a specific production" ([AYON Glossary][ayon-glossary]). | exact |
| **episode** | One episode of the screenplay, `EP001`, and everything made for it. | AYON **Episode** folder type, a default folder type ([AYON Glossary][ayon-glossary]). | exact |
| **segment** | One video generation request within an episode: one place, continuous time and one or more shots, within the video model's duration range. | AYON **Shot** folder type ([AYON Glossary][ayon-glossary]); OpenTimelineIO **Clip**, "a trimmed segment of media" ([OTIO timeline structure][otio]). | Pine Drama term: a segment holds several shots, and a generation model makes them in one request. **Under review.** Defined in [protocol §2.2][p-objects] (`segment`). The range comes from the model: [Create a video generation task][ark-video-api], `duration`. |
| **shot** | One picture between two cuts inside a segment, as the breakdown lists it. | AYON **Shot** folder type ([AYON Glossary][ayon-glossary]). | subset: the same picture between cuts, recorded as a row of the breakdown rather than an entity with versions |
| **screenplay** | The person's script, in Fountain. | Fountain syntax ([fountain.io/syntax][fountain]). | exact |
| **bible** | The whole screenplay read once: its characters, looks, locations and each episode's lines. | none in the base model | Pine Drama term: the series bible of television, a project-defined product type here Defined in [protocol §2.2][p-objects] (object `type`). |
| **breakdown** | One episode's lines split into segments, each with its shot list and the assets it uses. | AYON **Breakdown** link: "folder relationships based on a script breakdown" ([Project Anatomy][ayon-anatomy]). | subset: our breakdown also holds the shot list |

## Assets

Layer: production domain.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **asset** | A character, location or prop that episodes share, with its reference pictures. | AYON **AssetBuild** folder type ([AYON Glossary][ayon-glossary]). | subset |
| **character** | A person in the story and its reference sheets. The Studio lists characters under **Cast**. | AYON AssetBuild folder; a character type is project-defined ([Project Anatomy][ayon-anatomy]). | subset |
| **scene** (drama-cli, protocol) | A **place**: a location and its reference pictures. The Studio's label for scenes is **Locations**. The story unit the industry calls a scene, we call only a **scene heading**. | The industry's **scene** is a story unit that starts with a Fountain **Scene Heading**, which begins `INT.` or `EXT.` and names the place, e.g. `EXT. BRICK'S POOL - DAY` ([fountain.io/syntax][fountain]); Flow Production Tracking also groups shots under a Sequence or Scene ([Cut data model][sg-cut]). The place the heading names is its **location**: a Scene Heading gives INT. or EXT., "The location where the scene takes place" and the time of day ([Final Draft: Screenplay Formatting and Elements][fd-heading]). | Pine Drama term, settled (the person's decision): in Pine Drama a scene is a place, which the industry calls a location. Defined in [protocol §2.2][p-objects] (`scene`) and [§2.2][p-objects] (`inside_of`). |
| **prop** | An object a character handles, drawn once as its reference picture. | AYON AssetBuild folder ([AYON Glossary][ayon-glossary]). | subset |
| **base**, **variant** | The base is an asset's first picture. A variant is a look, state or time of day of that asset, made as an edit of the base. | AYON **Variant**: products of one folder named type plus variant, such as `main` and `proxy` ([AYON Glossary][ayon-glossary]). OpenUSD **Variant**: "a single, named variation of a VariantSet", a switchable set of alternatives ([OpenUSD Glossary][usd]). | subset: our base is AYON's `main` variant |
| **look** | One outfit or condition of a character. | AYON product type **look** ([AYON Glossary][ayon-glossary]). | Pine Drama term: AYON's `look` is a different product type. **Under review.** A look is a [protocol §2.2][p-objects] `variant` of a character. |
| **plate** | A location with no people in it: its floor plan and four views on one sheet. | AYON product type **plate** ([Products and Versions][ayon-products]). | Pine Drama term: AYON names the type but does not define it, so we claim no match A reference image the video request sends: [Seedance 2.5 prompt guide][seedance-guide], "Reference asset input recommendations". |

## Pictures and video

Layer: production domain.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **keyframe** | A photograph of the first frame of one shot. | none in the base model | Pine Drama term: the image a video model starts from. **Under review: first frame.** The vendor's term: [Seedance 2.5 prompt guide][seedance-guide], "Keyframe reference". |
| **first frame** | The image a segment's video starts from: its first shot's keyframe. | none in the base model | Pine Drama term: the video model's own input The vendor's term: [Seedance 2.5 prompt guide][seedance-guide], "First and last frames". |
| **storyboard** (multi-panel storyboard) | One image per segment, with one panel per shot. | none in the base model | Pine Drama term: a project-defined product type The vendor's term: [Seedance 2.5 prompt guide][seedance-guide], "Multi-panel storyboards". |
| **video prompts** | The text of each segment's video request. | none in the base model | Pine Drama term: the text a generation model takes The vendor's guide: [Seedance 2.5 prompt guide][seedance-guide], "Prompt writing recommendations". |
| **take** | One video generation of a segment. | AYON **Version**: "A numbered iteration of a given Product" ([AYON Glossary][ayon-glossary]). | subset: a take is one result in the take object's history. |
| **cut** | The edited episode, built from takes, as one movie. | Flow Production Tracking **Cut** and **Cut Items**, which "make up the actual items of an EDL" ([Cut data model][sg-cut]); OpenTimelineIO **Timeline** ([OTIO timeline structure][otio]). | subset: we keep the movie, not the edit decisions |
| **subtitles** | The episode's subtitles. | none in the base model | Pine Drama term: a project-defined product type Defined in [protocol §2.2][p-objects] (object `type`). |

## Objects and history

Layer: object and history model.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **object** (protocol) | Anything the drama is made of, such as an asset, a breakdown or a segment's take, with one current copy of each of its files. Its id is its folder's path. | AYON **Product** under a **Folder** ([AYON Glossary][ayon-glossary]). | subset: we keep folder and product as one. **Under review: product.** |
| **shown file** (`shown_file` in `object.json`) | The one image, video or text an object shows. | AYON **Representation** and **Reviewable** ([AYON Glossary][ayon-glossary], [Reviewables][ayon-reviewables]). | subset: one shown file per object |
| **import** | The person's own picture or video, used as an object's shown file. | AYON **Tray Publisher**: "publishing data into pipeline without going though DCC app" ([AYON docs][ayon-docs]). | subset |
| **add** | A new object the person creates. | Creating a folder of a project-defined folder type ([Project Anatomy][ayon-anatomy]). | subset |

## Relations

Layer: object and history model.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **edge** | A relation between objects: `variant_of`, `inside_of`, `appears_in`. | AYON **Links**: Generative, Reference, Breakdown, Template ([Project Anatomy][ayon-anatomy]). | subset: `appears_in` is a Breakdown link; `inside_of` is ours Our own kinds are defined in [protocol §2.2][p-objects] (`relations`). |

## Running the work

Layer: agent execution model.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **person** | The human who owns the project, approves and authorizes spend. | Flow Production Tracking's final approver is "the director" ([Tracking statuses][sg-status]). | subset |
| **Pine Computer**, **Computer** | A cloud machine on Pine where the agent makes the drama. | Pine Computer documentation ([overview][pine-overview]). | exact |
| **session**, **Chat**, **Project Chat** | The person's conversation with one agent, one Pine session; the Project Chat works on shared assets. | Pine **session** ([sessions][pine-sessions]). | subset |
| **turn** | One run of the agent for one message, ending completed, failed, canceled or with a question. | Pine **turn**: "one unit of work… ends when the agent finishes, fails, is canceled or asks a question" ([agent turns][pine-agent]). | exact. In the protocol, the client puts the drama onto the Computer before a turn and applies what it changed after it ([protocol §4][p-turn]). |
| **stop** | A point where the agent waits for the person's decision; the turn ends `needs_input`. | A Pine turn ends when the agent "asks a question" ([agent turns][pine-agent]). Flow Production Tracking **Pending Review** ([Tracking statuses][sg-status]). | subset |
| **preset** | A folder of prompt templates and a few settings, one template per model call: how drama-cli writes and draws a drama. A project's own presets are the folders of `inputs/preset/` ([presets](presets.md)). | Apple Compressor **preset**: "a group of preconfigured properties that you can apply to a source media file" ([Compressor glossary][compressor-glossary]). | subset. Not an agent **skill**, which is "directories containing instructions, executable code, and reference materials" for the agent itself ([Agent Skills][agent-skills]); a preset is input to the models drama-cli calls, not instructions to the agent. |

## References

[ayon-glossary]: https://help.ayon.app/articles/3030530
[ayon-anatomy]: https://help.ayon.app/articles/3815114
[ayon-products]: https://help.ayon.app/articles/1183758-products-and-versions-page
[ayon-reviewables]: https://help.ayon.app/articles/0359490-reviewables
[ayon-docs]: https://docs.ayon.dev/
[sg-status]: https://help.autodesk.com/cloudhelp/ENU/SG-Tutorials/files/SG_Tutorials_tu_tracking_statuses_html.html
[sg-cut]: https://help.autodesk.com/cloudhelp/ENU/SG-Editorial/files/ed-import-cut-depth/SG_Editorial_ed_cut_schema_html.html
[otio]: https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-timeline-structure.html
[usd]: https://openusd.org/release/glossary.html#usdglossary-variantset
[fountain]: https://fountain.io/syntax
[fd-heading]: https://www.finaldraft.com/learn/screenplay-formatting-elements/
[pine-overview]: https://console.pinecomputer.io/docs/overview
[pine-sessions]: https://console.pinecomputer.io/docs/sessions
[pine-agent]: https://console.pinecomputer.io/docs/agent
[compressor-glossary]: https://support.apple.com/guide/compressor/glossary-cpsr67a75b98/mac
[agent-skills]: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
[seedance-guide]: https://ai.byteplus.com/ark/region:ap-southeast-1/docs/seedance-2-5-prompt-guide
[ark-video-api]: https://ai.byteplus.com/ark/region:ap-southeast-1/docs/create-video-generation-task-api
[p-turn]: protocol.md#4-the-turn
[p-history]: protocol.md#21-the-projects-files-and-history
[p-objects]: protocol.md#22-objects

- AYON: [Glossary][ayon-glossary], [Project Anatomy][ayon-anatomy], [Products and Versions][ayon-products], [Reviewables][ayon-reviewables], [developer docs][ayon-docs].
- Autodesk Flow Production Tracking (ShotGrid): [Tracking statuses][sg-status], [Cut data model][sg-cut].
- ASWF: [OpenTimelineIO timeline structure][otio], [OpenUSD Glossary][usd].
- [Fountain syntax][fountain]; Final Draft, [Screenplay Formatting and Elements][fd-heading].
- Pine Computer: [overview][pine-overview], [sessions][pine-sessions], [agent turns][pine-agent].
- BytePlus ModelArk (the video model's vendor): [Dreamina Seedance 2.5 prompt guide][seedance-guide], [Create a video generation task][ark-video-api].
- Apple: [Compressor User Guide, glossary][compressor-glossary]. Anthropic: [Agent Skills][agent-skills].
- Pine Drama: the [protocol](protocol.md) and [presets](presets.md).

All pages were read on 2026-11-13.
