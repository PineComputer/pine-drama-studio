# Presets

A **preset** decides how a drama is written and drawn. It is a folder of prompt templates, one per model call drama-cli makes, plus a `preset.yaml` with a few settings. The agent on the Pine Computer runs drama-cli, and drama-cli fills each template with the drama's data and sends it to the model. A preset sets the style and the rules. It never names models: those come from a model set the platform keeps.

A preset is not an agent skill. A skill tells the agent what to do. A preset is the input drama-cli sends to the models. The terms are defined in the [vocabulary](vocabulary.md#running-the-work).

## Where a preset goes

Put each preset in its own folder under `inputs/preset/` in your project folder:

```
my-drama/
  choices.json
  inputs/
    my screenplay.fountain
    brief.md
    preset/
      my-style/
        preset.yaml
        bible.md
        ...
```

- **Every folder in `inputs/preset/` is a preset**, named by its folder.
- **You can keep several.** Tell the agent in the Chat which one to use ("use my-style"). With one, the agent uses it. With none, it uses a built-in preset.
- **It travels with every turn.** It is a client file under `inputs/` ([protocol §3.3](protocol.md#33-client-files)), so the Pine Computer always has your latest copy.
- **Change it** by editing the files, or ask the agent to switch to another preset. A change applies to what is made from then on. Nothing already made changes.

## Check a preset

drama-cli runs on the Pine Computer, where it checks a preset when the agent first uses it (`drama-cli init`). The agent can also check it at any time with `drama-cli preset validate`. A preset that does not pass is refused with each problem named, and the agent shows them in the Chat.

The check covers:
- `preset.yaml`: every key below, and its contract number;
- that every template below exists, and that no other template does;
- that each template uses only the placeholders it allows, and every one it requires;
- that each JSON template asks for JSON, and that its example matches the reply schema.

## Format

### `preset.yaml`

| Key | Value |
|---|---|
| `contract` | The preset contract this preset is written for: `18`. A drama-cli with another contract number refuses the preset (see [Contract](#contract)). |
| `min_character_age` | The youngest age a character may have, a whole number; `0` sets no floor. |
| `video_references` | What a video request carries besides the character sheets: `motion-or-keyframes`, the one value today. |
| `model_set` | The model set the templates are written for, one the platform keeps: `openai_based_model_set` or `claude_seedream_based_model_set`. |
| `understand.policy` | For each check drama-cli runs on pictures and video, `error` or `warn` for every key. The [sample](../examples/inputs/preset/minimal/preset.yaml) lists every key. |
| `listed` | Optional, `true` by default: whether drama-cli offers the preset in `preset list`. |

### Templates

Each template is a Markdown file at a fixed path, filled by one drama-cli command. `{{name}}` is a placeholder drama-cli fills, `{{shared:file}}` includes `shared/file` from the same preset, and `{{! ... }}` is a comment drama-cli removes before sending. The wording is yours. The paths, the placeholders and the reply's structure are fixed, because later steps read them.

**Bold** placeholders must appear in the template; the others are optional. A placeholder not listed is refused.

| Template | Command | Reply | Placeholders |
|---|---|---|---|
| `bible.md` | `bible` | JSON, [bible reply](presets/reply-schemas/bible.schema.json) | **`title`**, **`range`**, **`previous`**, `brief`, `screenplay`, `line_count`, `feedback`, `schema` |
| `breakdown.md` | `breakdown` | JSON, [breakdown](presets/reply-schemas/breakdown.schema.json) | **`names`**, `episode`, `segment_min_seconds`, `segment_max_seconds`, `brief`, `script`, `bible`, `previous`, `feedback`, `acts_index`, `schema` |
| `describe/characters.md`, `describe/scenes.md`, `describe/props.md` | `describe` | JSON, its format given as `{{schema}}` | **`entry`**, **`node`**, **`episodes`**, **`story`**, **`schema`**, `related`, `brief`, `feedback` |
| `cast/face.md`, `cast/sheet.md`, `cast/look.md` | `cast` | image prompt | `name`, `role`, `appearance`, `personality`, `look`, `state`, `base_state`, `base_look`, `feedback` |
| `scenes/floor-plan.md` | `scenes` | image prompt | **`outside`**, `name`, `description`, `feedback` |
| `scenes/base.md` | `scenes` | image prompt | **`time`**, **`camera`**, **`outside`**, `name`, `description`, `feedback` |
| `scenes/variant.md` | `scenes --variant` | image prompt | **`from`**, **`change`**, **`time`**, **`camera`**, **`plan`**, `name`, `description`, `feedback` |
| `props.md` | `props` | image prompt | `name`, `description`, `text`, `tone`, `feedback` |
| `keyframe.md` | `keyframe` | image prompt | **`references`**, **`people`**, **`shot`**, **`before`**, **`size`**, **`camera`**, **`visual`**, `shots`, `angle`, `feedback` |
| `multi-panel-storyboard/photoreal.md`, `multi-panel-storyboard/line-art.md` | `multi-panel-storyboard` | image prompt | `panel_count`, `grid`, `ratio`, `references`, `location_name`, `time`, `first_state`, `panels`, `feedback` |
| `multi-panel-storyboard/edit.md` | `multi-panel-storyboard --panel` | image prompt | `panel`, `references`, `feedback` |
| `video-prompts.md` | `video-prompts` | video prompt | **`shot_list_header`**, `references`, `subjects`, `dialogue`, `negative`, `first_state`, `shot_list`, `exit_state`, `people`, `blocking` |

- **A JSON template** says "JSON" and ends with a line `Example:` followed by one JSON object, which must match its reply schema. The model sees it as the format to follow. The reply schemas above are generated from drama-cli, with their prose left out.
- **`README.md`** is optional, and it is the agent's to read: the language the characters speak, and which `cast` steps to draw.
- **Optional templates.** An image template `X.md` may have an optimization template `X.optimize-prompt.md` that writes its prompt out at length first. `keyframe.md` may instead have `keyframe.optimize-segment.md`, whose reply is the [keyframe segment](presets/reply-schemas/keyframe-segment.schema.json) format. The check names what each requires.

## Contract

`contract` is the version of this format. When drama-cli changes what it asks of a preset (a template, a placeholder, a reply's structure or a setting), the number goes up, and the release notes say what a preset must change. A drama-cli refuses a preset written for another number, before any paid call.

## Sample

[`examples/inputs/preset/minimal/`](../examples/inputs/preset/minimal/) is a minimal preset written for this page. It shows the format and makes plain pictures; it is not a tuned style. It passes drama-cli's check. To start your own, copy it to your project's `inputs/preset/<name>/` and rewrite each template's wording.
