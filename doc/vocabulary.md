# Vocabulary

This page defines each production term the Studio, drama-cli and the [protocol](protocol.md) use, as Pine Drama uses it. Each entry names its official source in the film and VFX industry, and says whether our meaning matches it exactly, is a subset of it, or is our own.

How to read the columns:
- **Source** is the standard or vendor page that defines the term. AYON is the base model: it is open source and documents its data model publicly ([why](#base-model)). Where AYON's pages are silent, the source is Autodesk Flow Production Tracking (ShotGrid), OpenTimelineIO, OpenUSD, a W3C Recommendation, the Fountain screenplay syntax, or Pine Computer's documentation.
- **Match** says how our meaning relates to the source's:
  - **exact**: same word, same meaning;
  - **subset**: same idea, and we use less of it;
  - **Pine Drama term**: no official counterpart. The reason is given in one line, with a link to the place that defines the term: our [protocol](protocol.md), Pine's documentation, or the video model vendor's guide.
- **Under review** marks a term whose official name differs from ours. A rename is proposed and waits for the person's decision; until then the current term stays in use.


## Three layers

Each term belongs to one of three layers, named under each section below:
1. **Production domain.** What the drama is made of: projects, episodes, assets, pictures and the cut. Industry terms are used wherever the industry has one.
2. **Artifact and version model.** How each thing made is stored, approved and related: versions, approvals, notes and links. This layer is modelled on AYON.
3. **Agent execution model.** How the work runs: sessions, turns, scopes and the files that carry decisions between the person's machine and a Pine Computer. This layer is native to Pine.

Three of our terms stay apart from their nearest industry terms. They name units of AI generation; they do not fill gaps in the industry's model:
- **segment, not shot.** A segment is what a video model generates in one request, within the model's duration range. One segment may hold several shots, and the shot stays the editorial unit.
- **take, not a separate Version kind.** A take is one paid generation of a segment. It is stored as a version, numbered `tNN`, so that generations of the same request are compared side by side, in the sense film gives a take: one attempt at the same material.
- **agent's and person's approval, not one status.** An AI agent reviews every version before the person does. Keeping its acceptance apart from the person's lets the person's word always win ([protocol §3.2][p-resolution]), which a single status field cannot express.

## Base model

AYON's model is used as the base:
- a Project holds Folders of a type, such as Episode, Sequence, Shot and AssetBuild;
- a Folder holds Products, each of one product type and named by type plus variant;
- a Product has Versions, and a Version has Representations;
- Statuses, Links and an Activity feed sit on these entities ([AYON Glossary][ayon-glossary], [Project Anatomy][ayon-anatomy]).

Two of its rules fit Pine Drama directly:
- A publish is "exporting data from your work scene to a versioned, immutable file" ([AYON Glossary][ayon-glossary]). A Pine Drama version is likewise only ever added.
- Folder types and product types are defined per project ([Project Anatomy][ayon-anatomy]). So a production type of our own, such as a storyboard, is a project-defined type inside the official model.

## Production structure

Layer: production domain.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **project** | A folder that holds one drama: its inputs, versions and choices. | AYON **Project**: "the dedicated workspace that contains everything related to a specific production" ([AYON Glossary][ayon-glossary]). | exact |
| **episode** | One episode of the screenplay, `EP001`, and everything made for it. | AYON **Episode** folder type, a default folder type ([AYON Glossary][ayon-glossary]). | exact |
| **segment** | One video generation request within an episode: one place, continuous time and one or more shots, within the video model's duration range. | AYON **Shot** folder type ([AYON Glossary][ayon-glossary]); OpenTimelineIO **Clip**, "a trimmed segment of media" ([OTIO timeline structure][otio]). | Pine Drama term: a segment holds several shots, and a generation model makes them in one request. **Under review.** Defined in [protocol §5.1][p-objects] (`segment`). The range comes from the model: [Create a video generation task][ark-video-api], `duration`. |
| **shot** | One picture between two cuts inside a segment, as the breakdown lists it. | AYON **Shot** folder type ([AYON Glossary][ayon-glossary]). | subset: the same picture between cuts, recorded as a row of the breakdown rather than an entity with versions |
| **screenplay** | The person's script, in Fountain. | Fountain syntax ([fountain.io/syntax][fountain]). | exact |
| **bible** | The whole screenplay read once: its characters, looks, locations and each episode's lines. | none in the base model | Pine Drama term: the series bible of television, a project-defined product type here Defined in [protocol §5.1][p-objects] (object `type`). |
| **breakdown** | One episode's lines split into segments, each with its shot list and the assets it uses. | AYON **Breakdown** link: "folder relationships based on a script breakdown" ([Project Anatomy][ayon-anatomy]). | subset: our breakdown also holds the shot list |

## Assets

Layer: production domain.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **asset** | A character, location or prop that episodes share, with its reference pictures. | AYON **AssetBuild** folder type ([AYON Glossary][ayon-glossary]). | subset |
| **character** | A person in the story and its reference sheets. The Studio lists characters under **Cast**. | AYON AssetBuild folder; a character type is project-defined ([Project Anatomy][ayon-anatomy]). | subset |
| **scene** (drama-cli, protocol) | A **place**: a location and its reference pictures. The Studio's label for scenes is **Locations**. The story unit the industry calls a scene, we call only a **scene heading**. | The industry's **scene** is a story unit that starts with a Fountain **Scene Heading**, which begins `INT.` or `EXT.` and names the place, e.g. `EXT. BRICK'S POOL - DAY` ([fountain.io/syntax][fountain]); Flow Production Tracking also groups shots under a Sequence or Scene ([Cut data model][sg-cut]). The place the heading names is its **location**: a Scene Heading gives INT. or EXT., "The location where the scene takes place" and the time of day ([Final Draft: Screenplay Formatting and Elements][fd-heading]). | Pine Drama term, settled (the person's decision): in Pine Drama a scene is a place, which the industry calls a location. Defined in [protocol §5.1][p-objects] (`scene`) and [§5.2][p-edges] (`inside_of`). |
| **prop** | An object a character handles, drawn once as its reference picture. | AYON AssetBuild folder ([AYON Glossary][ayon-glossary]). | subset |
| **base**, **variant** | The base is an asset's first picture. A variant is a look, state or time of day of that asset, made as an edit of the base. | AYON **Variant**: products of one folder named type plus variant, such as `main` and `proxy` ([AYON Glossary][ayon-glossary]). OpenUSD **Variant**: "a single, named variation of a VariantSet", a switchable set of alternatives ([OpenUSD Glossary][usd]). | subset: our base is AYON's `main` variant |
| **look** | One outfit or condition of a character. | AYON product type **look** ([AYON Glossary][ayon-glossary]). | Pine Drama term: AYON's `look` is a different product type. **Under review.** A look is a [protocol §5.1][p-objects] `variant` of a character. |
| **plate** | A location with no people in it: its floor plan and four views on one sheet. | AYON product type **plate** ([Products and Versions][ayon-products]). | Pine Drama term: AYON names the type but does not define it, so we claim no match A reference image the video request sends: [Seedance 2.5 prompt guide][seedance-guide], "Reference asset input recommendations". |

## Pictures and video

Layer: production domain.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **keyframe** | A photograph of the first frame of one shot. | none in the base model | Pine Drama term: the image a video model starts from. **Under review: first frame.** The vendor's term: [Seedance 2.5 prompt guide][seedance-guide], "Keyframe reference". |
| **first frame** | The image a segment's video starts from: its first shot's keyframe. | none in the base model | Pine Drama term: the video model's own input The vendor's term: [Seedance 2.5 prompt guide][seedance-guide], "First and last frames". |
| **storyboard** (multi-panel storyboard) | One image per segment, with one panel per shot. | none in the base model | Pine Drama term: a project-defined product type The vendor's term: [Seedance 2.5 prompt guide][seedance-guide], "Multi-panel storyboards". |
| **video prompts** | The text of each segment's video request. | none in the base model | Pine Drama term: the text a generation model takes The vendor's guide: [Seedance 2.5 prompt guide][seedance-guide], "Prompt writing recommendations". |
| **take** | One video generation of a segment. | AYON **Version**: "A numbered iteration of a given Product" ([AYON Glossary][ayon-glossary]). | subset: a take is a version of the segment's video. **Under review** (row *version id*). |
| **cut** | The edited episode, built from accepted takes, as one movie. | Flow Production Tracking **Cut** and **Cut Items**, which "make up the actual items of an EDL" ([Cut data model][sg-cut]); OpenTimelineIO **Timeline** ([OTIO timeline structure][otio]). | subset: we keep the movie, not the edit decisions |
| **subtitles** | The episode's subtitles. | none in the base model | Pine Drama term: a project-defined product type Defined in [protocol §5.1][p-objects] (object `type`). |

## Versions and approval

Layer: artifact and version model.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **object** (protocol) | Anything that has versions, such as an asset, a breakdown or a segment's take. Its id is its folder's path. | AYON **Product** under a **Folder** ([AYON Glossary][ayon-glossary]). | subset: we keep folder and product as one. **Under review: product.** |
| **version** | One finished output of an object, in its own folder, never changed. | AYON **Version** ([AYON Glossary][ayon-glossary]). Flow Production Tracking **Version**, "the visual representation of a publish" ([Version and PublishedFile][sg-version]). | exact |
| **version id** | Letters then digits: `v3` for most versions, `t01` for takes. | AYON: "`v001` is the typical output for version `1`… prefixed with a 'v' and has 3-digit zero-padding" ([Project Anatomy][ayon-anatomy]). | Pine Drama term: two prefixes, and ordered by time then id. **Under review: `v001`, ordered by number.** Defined in [protocol §1][p-conventions] (version id) and ordered by [§3.2][p-resolution]. |
| **publish** | The Computer side adds a finished version. A version is only ever added. | AYON **Publish**: "exporting … to a versioned, immutable file" ([AYON Glossary][ayon-glossary]). | exact |
| **shown file** (`file` in `version.json`) | The one image, video or text a version shows. | AYON **Representation** and **Reviewable** ([AYON Glossary][ayon-glossary], [Reviewables][ayon-reviewables]). | subset: one shown file per version |
| **inputs** | The versions a version was made from. | AYON **Generative** link: "between two product versions where the input was used to generate the output" ([Project Anatomy][ayon-anatomy]). | exact |
| **current** | The version the person chose, else the newest one not discarded. | AYON **latest** version ([entity URI][ayon-uri]); **Featured version** ([Products and Versions][ayon-products]). | Pine Drama term: latest unless the person chose one. **Under review: latest.** Defined in [protocol §3.2][p-resolution]. |
| **accepted** | The version later steps use: the person's choice, else the newest the person reviewed, else the newest the agent reviewed. | AYON **latestDone**, "the highest numbered version that has a 'Done' status (like Approved)" ([Products and Versions][ayon-products], [entity URI][ayon-uri]). Flow Production Tracking **Final Approved** ([Tracking statuses][sg-status]). | subset, with the agent's level added. **Under review: approved.** |
| **candidate** | The newest generated version, not yet judged. | Flow Production Tracking **Pending Review**: "not yet been reviewed by anyone" ([Tracking statuses][sg-status]). | subset |
| **review**, **review file** | The record that a version was accepted, by the agent or, with the person's words, by the person. | Flow Production Tracking: a Version is "used for review and taking notes", and approval is a status ([Version and PublishedFile][sg-version], [Tracking statuses][sg-status]). | Pine Drama term: there, review is the act and approval the status. **Under review: approval.** Defined in [protocol §2.2][p-reviews]. |
| **agent's acceptance**, **person's acceptance** | A review file without, or with, the person's verbatim words. | Flow Production Tracking **Viewed** and **Pending Director Review**, then **Final Approved**, "reviewed and approved by the director" ([Tracking statuses][sg-status]). | subset |
| **chosen**, **Approve** | The version the person picks for an object. `chosen` is the protocol's key; **Approve** is the one verb the UI shows for it. | Flow Production Tracking **Final Approved** ([Tracking statuses][sg-status]). | Pine Drama term: the person's pick, kept apart from the agent's acceptance. Defined in [protocol §3.1][p-contents] and [§3.2][p-resolution]. |
| **discarded** | A version the person removed from use. Its files stay and it can be brought back. | none in the base model | Pine Drama term: a reversible state that keeps every file and the version numbering Defined in [protocol §3.1][p-contents]. |
| **import** | The person's own picture, made a version of an object. | AYON **Tray Publisher**: "publishing data into pipeline without going though DCC app" ([AYON docs][ayon-docs]). | subset |
| **add** | A new asset or variant the person creates, before it has an id. | Creating a folder of a project-defined folder type ([Project Anatomy][ayon-anatomy]). | subset |

## Notes and relations

Layer: artifact and version model.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **note** | The person's feedback on a version for the agent, optionally at a point of the picture or a time in the video. It decides nothing. | Flow Production Tracking **Note** ([Tracking statuses][sg-status]); AYON comments with attachments ([Activity feed][ayon-activity]). Position and time follow W3C Media Fragments: a time in seconds (`t=`) and a region in percent (`xywh=percent:`) ([Media Fragments URI 1.0][media-frags]). | subset: no note status |
| **edge** | A relation between objects: `variant_of`, `inside_of`, `appears_in`, `needs`. | AYON **Links**: Generative, Reference, Breakdown, Template ([Project Anatomy][ayon-anatomy]). | subset: `appears_in` is a Breakdown link; `inside_of` is ours Our own kinds are defined in [protocol §5.2][p-edges]. |

## Running the work

Layer: agent execution model.

| Term | Definition (as we use it) | Source | Match |
|---|---|---|---|
| **person** | The human who owns the project, approves and authorizes spend. | Flow Production Tracking's final approver is "the director" ([Tracking statuses][sg-status]). | subset |
| **Pine Computer**, **Computer** | A cloud machine on Pine where the agent makes the drama. | Pine Computer documentation ([overview][pine-overview]). | exact |
| **session**, **Chat**, **Project Chat** | The person's conversation with one agent, one Pine session; the Project Chat works on shared assets. | Pine **session** ([sessions][pine-sessions]). | subset |
| **turn** | One run of the agent for one message, ending completed, failed, canceled or with a question. | Pine **turn**: "one unit of work… ends when the agent finishes, fails, is canceled or asks a question" ([agent turns][pine-agent]). | exact. In the protocol, a turn also carries its request and its return ([protocol §4][p-turn]). |
| **stop** | A point where the agent waits for the person's decision; the turn ends `stopped`. | A Pine turn ends when the agent "asks a question" ([agent turns][pine-agent]). Flow Production Tracking **Pending Review** ([Tracking statuses][sg-status]). | subset |
| **scope** | The folders a session's turns may add versions to: the project's or the episodes'. | none | Pine Drama term: it lets sessions work in parallel without locks Defined in [protocol §1][p-conventions], "Sessions and scopes". |
| **choices** | The person's decisions, one file only the client writes. | none: a tracker keeps status changes and comments in its database, and AYON in its Activity feed ([Activity feed][ayon-activity]) | Pine Drama term: one local file, so a decision needs no server Defined in [protocol §3][p-choices]. |
| **snapshot** | What a return reports that the files cannot show: names, whether each object is usable, what is being made, and the edges. | AYON **Status**, one per entity ([Project Anatomy][ayon-anatomy]). | Pine Drama term: a report with its time, not a stored status Defined in [protocol §5][p-snapshot]. |
| **preset** | A folder of prompt templates and a few settings, one template per model call: how drama-cli writes and draws a drama. A project's own presets are the folders of `inputs/preset/` ([presets](presets.md)). | Apple Compressor **preset**: "a group of preconfigured properties that you can apply to a source media file" ([Compressor glossary][compressor-glossary]). | subset. Not an agent **skill**, which is "directories containing instructions, executable code, and reference materials" for the agent itself ([Agent Skills][agent-skills]); a preset is input to the models drama-cli calls, not instructions to the agent. |

## References

[ayon-glossary]: https://help.ayon.app/articles/3030530
[ayon-anatomy]: https://help.ayon.app/articles/3815114
[ayon-products]: https://help.ayon.app/articles/1183758-products-and-versions-page
[ayon-reviewables]: https://help.ayon.app/articles/0359490-reviewables
[ayon-activity]: https://help.ayon.app/articles/8709483-activity-feed-and-comments
[ayon-uri]: https://docs.ayon.dev/ayon-core/latest/autoapi/client/ayon_core/pipeline/entity_uri.html
[ayon-docs]: https://docs.ayon.dev/
[sg-version]: https://developers.shotgridsoftware.com/b867b4b0/
[sg-status]: https://help.autodesk.com/cloudhelp/ENU/SG-Tutorials/files/SG_Tutorials_tu_tracking_statuses_html.html
[sg-cut]: https://help.autodesk.com/cloudhelp/ENU/SG-Editorial/files/ed-import-cut-depth/SG_Editorial_ed_cut_schema_html.html
[otio]: https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-timeline-structure.html
[usd]: https://openusd.org/release/glossary.html#usdglossary-variantset
[media-frags]: https://www.w3.org/TR/media-frags/
[fountain]: https://fountain.io/syntax
[fd-heading]: https://www.finaldraft.com/learn/screenplay-formatting-elements/
[pine-overview]: https://console.pinecomputer.io/docs/overview
[pine-sessions]: https://console.pinecomputer.io/docs/sessions
[pine-agent]: https://console.pinecomputer.io/docs/agent
[compressor-glossary]: https://support.apple.com/guide/compressor/glossary-cpsr67a75b98/mac
[agent-skills]: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
[seedance-guide]: https://ai.byteplus.com/ark/region:ap-southeast-1/docs/seedance-2-5-prompt-guide
[ark-video-api]: https://ai.byteplus.com/ark/region:ap-southeast-1/docs/create-video-generation-task-api
[p-conventions]: protocol.md#1-conventions
[p-reviews]: protocol.md#22-review-files
[p-choices]: protocol.md#3-the-choices-file-client
[p-contents]: protocol.md#31-contents
[p-resolution]: protocol.md#32-resolution
[p-turn]: protocol.md#4-the-turn
[p-snapshot]: protocol.md#5-the-status-snapshot
[p-objects]: protocol.md#51-objects
[p-edges]: protocol.md#52-edges

- AYON: [Glossary][ayon-glossary], [Project Anatomy][ayon-anatomy], [Products and Versions][ayon-products], [Reviewables][ayon-reviewables], [Activity feed and comments][ayon-activity], [entity URI][ayon-uri], [developer docs][ayon-docs].
- Autodesk Flow Production Tracking (ShotGrid): [Version and PublishedFile][sg-version], [Tracking statuses][sg-status], [Cut data model][sg-cut].
- ASWF: [OpenTimelineIO timeline structure][otio], [OpenUSD Glossary][usd].
- W3C: [Media Fragments URI 1.0][media-frags], Recommendation, 25 September 2012.
- [Fountain syntax][fountain]; Final Draft, [Screenplay Formatting and Elements][fd-heading].
- Pine Computer: [overview][pine-overview], [sessions][pine-sessions], [agent turns][pine-agent].
- BytePlus ModelArk (the video model's vendor): [Dreamina Seedance 2.5 prompt guide][seedance-guide], [Create a video generation task][ark-video-api].
- Apple: [Compressor User Guide, glossary][compressor-glossary]. Anthropic: [Agent Skills][agent-skills].
- Pine Drama: the [protocol](protocol.md) and [presets](presets.md).

All pages were read on 2026-11-13.
