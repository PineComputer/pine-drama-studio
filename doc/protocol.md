# Pine Drama protocol, major version 2

Status: draft. Major 2 replaces major 1 whole: a reader of one major reads no document of the other (section 7).

This protocol connects two sides, the way Codex runs a task:
- the **client**, the program the person uses: a desktop app holding the drama's folder, or a web service holding it on its server. It shows the drama and lets the person change any file of it, as with a local coding agent;
- the **Computer side**, the program on a Pine Computer that makes the drama. Each turn works in its own workspace, seeded from the client's files, and every result it finishes comes back as one change the client applies, as Codex's cloud tasks are applied (`git apply --check`, then the apply).

The Computer side also works with no client: driven by Pine Computer's own agent, by another program, or from a terminal.

**The client keeps every file of the drama and its complete history** (section 2). A git repository is the reference implementation.
- **One current file per object.** Each object has one current copy of each of its files, and history keeps every earlier one.
- **No version numbers, no choices file, no acceptance state, no scopes.**
- **Any number of sessions** may work on one drama at once. The newest result lands, and history keeps every earlier one (4.4).

A client can be built from this page and one schema file, [`protocol/v2/protocol.schema.json`](../extensions/pine-drama/protocol/v2/protocol.schema.json).
- **This page is normative.** Each document is one entry of the schema's `$defs`, named where the document is defined.
- **The schema is JSON Schema 2020-12.** Its patterns end with `(?![\s\S])`, which means the end of the string in every regex engine, and validators MUST turn on format assertion.
- **Key words.** MUST, MUST NOT, SHOULD and MAY are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Conventions

| Type | Rule |
|---|---|
| Document | UTF-8 JSON with `"schema": 2`. |
| Path | A file or folder of the drama: project-relative, `/`-separated, Unicode NFC. No segment is empty or starts with `.`. No segment contains `\` or a control character (U+0000–U+001F, U+007F–U+009F), is a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an extension), or ends with `.` or a space. There is no leading or trailing `/`, and a path is at most 240 characters. Two paths that differ only by case are the same path. A name starting with `.` (`.git`, `.gitattributes`) is never a path of this protocol, so it never travels. |
| Object id | The path of the object's folder, for example `assets/characters/lin`. Whoever creates the object chooses it. |
| Turn id | An id the client chooses for a turn. It matches `^[A-Za-z0-9_-]{8,64}$` and is never reused in a drama. |
| Paid call id | An id the Computer side chooses for one paid call, unique in the drama, matching the same pattern. |
| Time | An RFC 3339 `date-time` in UTC, whole seconds, with the `Z` suffix, for example `2026-11-15T10:00:00Z`. |
| Hash | The lowercase hex SHA-256 of a file's bytes. Git's own object ids never appear in a document. |

## 2. The drama's files (client)

### 2.1 The project's files and history

**What every client MUST keep.** These are properties; any storage that has them will do.
- **Files, byte for byte.** Every file of the drama, exactly as written, with no line-ending, encoding or other conversion.
- **A complete history.** Every earlier content of every file, with who changed it: `pine-computer` (a change applied from a turn, 4.4), `person` (the person's own change), or `client-found-changes-on-disk` (what a folder client finds on disk that no record holds, 3).
- **Applied once.** Each change of a turn, `(turn_id, change_number)`, is applied at most once, and the record that it was applied is durable.
- **Atomic changes.** A change's files are written and recorded together. A reader never sees half of one.
- **Restore and undo.** Any earlier result's files can be brought back (5), and a turn's changes can be undone as a whole.

**The reference implementation is a git repository in the drama's folder**, which Pine Drama Studio uses:
- each change is a commit of exactly its paths (`git commit --only -- <paths>`), authored as above;
- a turn's change carries the trailers `Pine-Turn-Id: <turn id>` and `Pine-Change-Number: <change number>`, which are its applied record;
- the byte rule is `* -text -filter -ident -working-tree-encoding` in the repository's `info/attributes`, which takes precedence over any `.gitattributes` ([gitattributes](https://git-scm.com/docs/gitattributes)), and nothing of the client's own goes into the folder itself;
- history is `git log` of a path, and undoing a turn is a revert of the commits carrying its `Pine-Turn-Id`.

A client that keeps the drama elsewhere, for example a web service on its own server, meets the same properties its own way. Git on its server is the simplest.

**`pine-drama-project.json`** (`$defs/projectMarker`) at the drama's root marks it as a drama of this major: `{"schema": 2}`. It is written when the drama is made, or last by a conversion from another major. A folder without it is not a drama of major 2.

### 2.2 Objects

An object is a folder holding **`object.json`** (`$defs/object`):

| Field | Meaning |
|---|---|
| `type` | `episode`, `screenplay`, `bible`, `character`, `character_face`, `scene`, `scene_floor_plan`, `scene_view`, `prop`, `variant`, `breakdown`, `storyboard`, `keyframe`, `video_prompts`, `take`, `cut` or `subtitles`, in pipeline order. Writers write only these. A client shows an object of a type it does not know as a plain card, and refuses nothing for it. |
| `name` | Its name for the person. |
| `shown_file` | The object's shown file, relative to its folder (image, video or text), or `null` before it has one. Such an object is a planned, empty card. |
| `variant_of` | For a variant: the object id it derives from. |
| `segment` | Its segment within the episode, or absent. |
| `setting` | For a scene: `interior` or `exterior`. |
| `relations` | Other relations, each `{kind, to}`: `inside_of` (a scene inside a scene), `appears_in` (an asset in an episode), `needs` (an episode needs an object before it can be shot). |
| `objects_sent_by_draw_request` | The object ids this object's draw request sends, in the order it sends them (`Image 1`…`Image N`), or absent for an object that is not drawn from others. Every object drawn from others has it, whatever its type (a storyboard, a keyframe, a take, a cut, and any drawn kind added later), under this one rule. Pine Computer writes it only when a turn plans that object: never as a side effect of another object changing, and never when it reads. The person may add to, remove from or reorder it on any object, drawn or not, and it then stays as they set it until they, or a turn that plans that object again, change it. The draw builds its request from this list and nothing else, so what is drawn and what the canvas shows cannot differ. |

- **One source for lines.** Every line the client draws between objects comes from `objects_sent_by_draw_request` (plus `variant_of` and `relations`), for a drawn object and an undrawn one alike. A receipt's `inputs_sent_in_order` is the record of what a past draw sent, shown with that result; it is never read for lines. `needs` is only an episode's, for what it needs before it can be shot.
- **Every drawn picture is an object.** A picture other pictures are drawn from has a folder with `object.json` of its own:
  - `character_face`, at `assets/characters/<id>/looks/face`: the face a character's sheets are drawn from;
  - `scene_floor_plan`, at `assets/scenes/<id>/plan`: the floor plan a scene's views are drawn from.
  - `scene_view`, at `<scene node>/views/<side>` with side `front`, `back`, `left` or `right`: one side of a scene node, the scene itself or one of its variants, drawn on its own. The node's object shows its composed sheet, whose list names the objects it is composed from, in the sheet's order. The node holds no copies of its views; a reader reads each view object's shown file.

  So `objects_sent_by_draw_request` always lists object ids. For example:
  - a character's list names the objects its sheet is drawn from: its `character_face` when the sheet is drawn from one (a face is optional);
  - a scene's front view lists its `scene_floor_plan`, then the outside's establishing view when it is inside of one;
  - its other views list its front view, then its `scene_floor_plan`;
  - a variant's view lists the view on the same side of the node it is drawn from (its `variant_of`);
  - a floor plan lists the outside's establishing view when there is one;
  - a scene node's composed sheet lists its front, back, floor plan, left and right, as its cells are laid out.
- **Pine Computer changes an object only in a turn that works on that object.** It plans, draws or rewrites that object itself: never as a side effect of another object changing, and never when it reads one. So a field the person set (`objects_sent_by_draw_request`, `relations`, `variant_of`, the text files) stays as they set it until they, or a turn that works on that object, change it. History keeps both.
- **References that no longer resolve.** A listed object may be deleted later, and a reference may point back at its own object, directly or through others. Both are allowed in the data. A draw sends the shown files of the listed objects that exist, in order, and names each one it could not send in `pine_computer_could_not_do` (4.6). It refuses nothing. A draw sends files, not a graph, so a cycle sends each file once, as listed.
- **Who creates objects.** Either side may create an object. The client creates one when the person adds it, with `object.json` and the person's `description.md`. drama-cli derives every name a model reads from `name`, never from the id.
- **The person's text.** In an object's folder, `description.md` and `prompt.md`, when present, are the text the person and Pine Computer edit. Whoever writes last wins, and git keeps the earlier text.
- **Removal.** Removing an object deletes its folder; a variant is a folder below its asset's, so it goes with it.

### 2.3 Receipts

Each output of a paid call has a receipt beside it, **`<file>.receipt.json`** (`$defs/receipt`). It is written before the output, and always applied together with it (4.4):

| Field | Meaning |
|---|---|
| `paid_call_id` | The paid call that made it (4.5). |
| `finished_at` | When the output was finished. |
| `inputs_sent_in_order` | The record of what this call sent, for money and history (never for lines, 2.2): the files the call was sent, in the order it was given them (`Image 1`…`Image N`), each `{path, sha256}` as it was then. Their bytes are in the drama's history: the seed commits them (4.2), and a turn's own inputs land as its changes. |
| `prompt_sent` | The prompt the call was sent, or `null`. |
| `cost` | `{usd, reported_by}`, for example `"reported_by": "pine"`, or `null` when unknown. |

The rest of the receipt (the request and response as sent) belongs to the Computer side. A client MAY show it, and decides nothing from it. It holds no copy of the output's bytes (a provider's base64 image is left out): the output is the file beside it.

- **One receipt per output.** A call with several outputs (a take's video and its last frame) has a receipt beside each, all in one change.
- **No paid call, no receipt.** A file made without a paid call (a cut, an overlay, a conversion) has none.

### 2.4 Pine Computer's records

Pine Computer keeps everything it needs to carry on a session's work in one folder of the drama, **`pine-computer-records/`**. These are ordinary files: they come back as changes like any other file (4.3), the client records them in history, and they travel with the seed (4.2). There is no private state, no archive of it, and no finishing step.
- `pine-computer-records/paid-calls/<paid call id>/<state>.json`: the paid-call states (4.5), and the ledger beside them.
- `pine-computer-records/turns/<turn id>.json` (`$defs/pineComputerTurnRecord`): the turn's own record. The turn's first drama-cli command writes it first thing, as the turn's first change after the edits it carries over from the earlier turn (4.3), and it is written again whenever it grows: `{schema, turn_id, pine_computer_could_not_do: [{object_or_file, error}], pine_computer_refused_the_turn_before_running?: error}`. It holds what the turn could not do, and whether it refused before running (4.2).
- Everything else in the folder is Pine Computer's own. A client MAY show it, decides nothing from it, and the person does not edit it.
- **No media bytes twice.** A record, like a receipt (2.3), holds no copy of an output's bytes, such as a provider's base64 image. It names the output by its path and hash.

## 3. The person's changes (client)

- **The person changes any file of the drama.** Each edit is a plain write of exactly the files it changes, through the client's one write queue, recorded as a `person` change (2.1). There is one path per edit:
  - an `object.json` field (`objects_sent_by_draw_request`, `relations`, `variant_of`, `name`);
  - adding an object, which writes its folder with `object.json` and `description.md`;
  - removing an object, which deletes its folder;
  - `description.md` or `prompt.md`;
  - the person's own picture or video, below.
- **Canvas positions** and every other view state are the client's own, per person or per profile, and are never written into the drama.
- **Hand changes** (a folder client): a file changed outside the client is recorded as `client-found-changes-on-disk` at the next opening or seed.
- **Using the person's own picture or video for an object.** The person's file replaces the object's shown file. It is written under the shown file's name, with the extension of the person's file, and `object.json` `shown_file` is set to it. If the extension changed, the old shown file and its receipt are deleted in the same commit. The person's file has no receipt, since no paid call made it. History keeps what it replaced.
- **Files the person attaches** to a note or a chat message, and are not an object's file, are written to `person-attachments/<id>.<extension>` and recorded as a `person` change. A note's `attached_file` names one of them (4.2).
- **A running turn** sees a change only at its next seed (4.2). A person's edit made while a turn runs can be replaced by that turn's later write to the same file; it stays in the file's history, one restore away (4.4).

## 4. The turn

### 4.1 Transport on Pine

**The message.** A turn is one message to a session on a Pine Computer.
- Its text begins with the line `pine-drama-turn <turn id>`, followed by the person's own words.
- Right before sending it, the client puts the turn's request into the session as the attachment `pine-drama-request.json` (Pine's `write_file`, [files and shell](https://console.pinecomputer.io/docs/files-and-shell)). Pine places it in the session before the turn starts, and an attachment is the session's own, so no other session sees it. The Computer side reads it at `attachments/pine-drama-request.json` in the session's working directory, the directory its shell starts in; Pine names no absolute path or environment variable for it ([files and shell](https://console.pinecomputer.io/docs/files-and-shell)). The drama's workspace is not that working directory itself, so Pine's `attachments/` is never one of the drama's files.
- The client sends the message with Pine's idempotency key set to the turn id. A retry resends the same message with the same key, and Pine answers it with the same turn: it never runs a turn twice.

**Sessions.**
- A session runs one turn at a time and sends its next only after its previous turn has ended on Pine and its changes are applied (4.6).
- Any number of sessions may work on one drama. None owns any object.
- A client that runs several turns at once opens several sessions. Which session runs what, and how many there are, is the client's to arrange.

**Storage.** The keys of the Computer's artifact store, each written once:
- `files/<hash>`: one file;
- `turns/<turn id>/changes/<change number>.json`: one change (4.3).

**Bytes.**
- A reader MUST check every file against its hash before it uses it.
- Before a turn, the client makes the target store hold every file the request names: it copies a file inside Pine from a Computer it remembers holding that hash, or uploads it.

### 4.2 Request (client → Computer side)

`$defs/request`, the session attachment `pine-drama-request.json` (4.1).

| Field | Meaning |
|---|---|
| `turn_id` | The turn id. |
| `seed_files` | The seed: every file of the drama as the client holds it now, `{<path>: <hash>}`, Pine Computer's records (2.4) included. Paths starting with `.` are left out (section 1). |
| `notes_for_pine_computer` | The person's feedback for Pine Computer, each `{object_id, text, attached_file?, position_in_shown_file?: {x, y}, seconds_into_video?}`. `attached_file` is a file of `seed_files` (a picture the person attached), `position_in_shown_file` gives fractions 0–1 of the shown file's width and height, and `seconds_into_video` gives seconds into a video. A note decides nothing. |

- **The seed is recorded.** `seed_files` MUST be the client's complete current state, recorded in history (2.1), so every input the turn may read can be found again. A folder client first records whatever the folder holds that no record does, as `client-found-changes-on-disk`.
- **Restore.** The Computer side writes into its workspace exactly the turn's **start tree**: `seed_files` with the turn's carried-over edits (4.3) applied over it, which is what the client's folder holds once it applies them. A restore never undoes what it has just sent back: the record of a paid call cut off before it was reported stays, so the call is never sent again (4.5). Its own records come with them (2.4), so any Computer can carry on a session's work. A file of the tree the Computer side rewrites only for its own machine, such as a path in its configuration, is kept outside the workspace, so it never comes back as a change.
- **Only what changed moves.** The workspace MUST equal the start tree exactly. To get there, the Computer side MAY keep its workspace and a local cache of file bytes by hash between turns on the same Computer. It then fetches only the paths whose hash changed, links them in from the cache, and deletes only the paths the start tree does not list. `seed_files` is the client's complete current state, so nothing the drama holds is ever deleted from the workspace. This is the remote-execution model of Bazel's REAPI, where an executor materializes an input root from its content-addressed cache. A fresh Computer fetches the whole tree once.
- **Each command starts its turn itself.** There is no start command. Before it does anything, every drama-cli command compares the request's `turn_id` with the turn its workspace was last restored for. Turn ids have no order, so a different id is a new turn, and that command starts it: it writes as this turn's first changes what the workspace holds that the earlier turn did not report (4.3), restores and verifies the workspace, and records which turn it restored. A turn whose agent runs no drama-cli command restores nothing. It reads the workspace as the last command left it, so it may miss the person's edits made since.
- **Verified before any work.** Before the turn's first command does its work, the Computer side checks that its workspace holds exactly the start tree: every path, each with its hash. If any file is absent or does not match, it does no work. It writes only the turn's record (2.4), saying `pine_computer_refused_the_turn_before_running` with `pine_computer_found_file_missing_from_store` naming the file, and sends that one file back as the turn's only change after the carried-over edits. A turn never runs on a partial workspace. A refused turn stays refused: its later commands do no work and write nothing more, since a file missing from the write-once store stays missing.

### 4.3 Changes (Computer side → client)

Each result the turn finishes is one **change** (`$defs/change`) at `turns/<turn id>/changes/<change number>.json`: an output with its receipt, a text write, or a write of Pine Computer's records. `change_number` counts from 1 within the turn.

```
change = { schema, turn_id, change_number, previous_change_sha256, files_after_change: { <path>: <hash> | null } }
```

| Field | Meaning |
|---|---|
| `previous_change_sha256` | The hash of the previous change's bytes, or `null` for the first. A client that missed one finds it by its number in the store. |
| `files_after_change` | Each path the change writes, with the hash of its new bytes, or `null` for a file it deletes. |

- **Bytes first.** The Computer side stores every file of `files_after_change` at `files/<hash>` before it writes the change.
- **Every changed file comes back.** A file the Computer side changes in its workspace by any means comes back as a change: its own commands, its records (2.4), or its agent editing the file directly. At the start and at the end of each of its commands, and after each output it writes, the Computer side writes a change for every workspace file that differs from the start tree and from what its earlier changes wrote. The baseline is the verified workspace, the start tree (4.2). No finishing step is needed, so a turn that ends any way has sent back everything its commands wrote. **An edit made outside a drama-cli command arrives with the next drama-cli command.** If that command belongs to a later turn, the edit is stored under that later turn's own key, as its first change or changes: measured against the files the earlier turn last reported, and written before the later turn restores its seed.
- **A deletion is only what the turn removed.** A path is written as `null` only if it was present in the files the change is measured against, and is gone now: the verified workspace and this turn's earlier changes or, for a later turn's first changes, the files the earlier turn last reported. A file that failed to arrive can never come back as a deletion, because then the turn never started.

### 4.4 Applying a change (client)

The client applies a turn's changes in `change_number` order, through the one queue that also writes the person's changes, so two never write at once. For each change:

1. **Resolved already?** A change whose applied record exists (2.1; in git, a commit carrying its trailers `Pine-Turn-Id` and `Pine-Change-Number`) is skipped. If every path's current hash already equals its hash in `files_after_change` (a crash's files that a folder client recorded as `client-found-changes-on-disk`), the client writes the applied record alone (in git, an empty commit with those trailers) and goes on.
2. **Write.** Each file is written by a temporary sibling and a rename, receipts before the outputs they describe. A `null` deletes that file. The client deletes no file a change does not list, and never replaces a whole tree.
3. **Record.** The client records exactly those paths as one `pine-computer` change with its applied record (in git, `git commit --only -- <paths>` with the trailers).

**A crash** between steps 2 and 3 leaves the files written but unrecorded. A folder client records them as `client-found-changes-on-disk` at the next opening, and step 1 then finds the change applied. A client whose store writes a change atomically has no such window.

**A wrong deletion is undone like any change.** Every deletion the client applies is a recorded change of its turn, so undoing the turn (2.1) brings every deleted file back.

**The newest result lands.** There is no check against what a file held before and no refusal: whichever change is applied last is the file's current content, and the file's history keeps every earlier one, the person's included. The same one rule covers a reroll's attempts, two sessions writing one file, and a turn writing over a person's edit. "Use" (section 5) brings any earlier one back.

### 4.5 Paid calls (Computer side)

Each paid call that makes or changes a file of an object has its states as records of their own (`$defs/paidCallState`) at `pine-computer-records/paid-calls/<paid call id>/<state>.json`, each written once. They tell the client what is being made for which object. A paid call that makes no file of the drama (an observation of a picture, an upload that registers a file with a provider) has none. It is kept in the ledger alone, under the same rule that a call whose outcome cannot be learned is never sent again.

| State | Written |
|---|---|
| `pine_computer_sent_request_to_provider` | Before the call is sent to the provider. |
| `provider_returned_output_to_pine_computer`, `provider_reported_failure_to_pine_computer`, `pine_computer_cancelled_call_after_person_pressed_stop` | When the call ends so. These are terminal. |
| `pine_computer_cannot_learn_call_outcome` | When the call's outcome cannot be learned. This state is **not settled**: the Computer side MUST NOT send the same request to the provider again while a call of it is in this state. |

The person pressing Stop is the only cause of `pine_computer_cancelled_call_after_person_pressed_stop`. A call cut off any other way (the Pine turn ending, the Computer lost) is `pine_computer_cannot_learn_call_outcome` until a later turn learns its outcome.

A paid-call state carries `{schema, paid_call_id, object_id, state, state_written_at, cost?}`. It is the public summary only.
- **The ledger** keeps the reservation, the generation lock, the attempt identity, the request as saved and the provider's reference (drama-cli's `ledger.py`), under `pine-computer-records/` (2.4). It travels with the drama, so any later turn, on any Computer, can settle a call an earlier one started.
- **Settling a call.** The turn that settles a call writes its terminal state under the call's own key, and writes its output as a change of its own (4.3).
- **Making.** An object is being made while it has a paid call sent to the provider with no terminal state. The client shows it as making.
- **Recovery.** Pine keeps each session's provider journal with its Computer. A Computer that replaces a lost one cannot observe its calls, so their calls stay `pine_computer_cannot_learn_call_outcome`, with their receipts and charges kept.

### 4.6 How a turn ends

There is no return document. A turn ends as Pine reports its turn ([agent turns](https://console.pinecomputer.io/docs/agent)), and the client reads that:

| Pine's turn | The client calls it | What the client shows |
|---|---|---|
| `needs_input` | `pine_computer_is_waiting_for_person_answer` | Pine Computer asks the person something: the question is the turn result's `summary`. One of the five stops of the drama workflow: the person's answer is the approval of the next paid work, given before it, as a coding agent asks for approval before it acts (Codex's AskForApproval). There is no acceptance after the fact. |
| `completed` | `pine_computer_finished_the_work` | The work is done. |
| `canceled` | `person_stopped_the_turn` | The person stopped it (4.7). |
| `failed` | `pine_computer_broke_off_the_turn` | The work broke off. The turn result's `terminalReason` (for example `timeout`, `budget`, `error`, `coordinator_restarted`) says why. |

- **Applied, then ended.** The Computer side stores each change before the command that made it ends (4.3). So once Pine reports the turn ended, however it ended, the changes in the store are complete. The client applies them in `change_number` order, up to the first missing one, and the session may then send its next turn. A client never reads a turn again after it has ended. What its workspace held that it did not report arrives as a later turn's first changes (4.3).
- **What Pine Computer could not do, or refused,** is in the turn's record (2.4), which comes back as a change like any other file.
- **The turn's own cost** is the one Pine reports for the turn (its turn result's `usage.cost`, `{total, currency}`). Receipts carry only the paid calls' costs (2.3).

### 4.7 Stop

- **Stop.** The client cancels the Pine turn, and the Computer side sends no new paid call to a provider. Every change already stored is applied (4.6). Text its agent edited directly after its last command arrives with the next drama-cli command (4.3). It is lost only if that Computer is lost first.
- **A run cut off midway** (Stop, the Computer lost, a timeout) runs nothing paid again by itself. Pine never reruns a turn (4.1), and the ledger never sends again a call whose outcome it could not learn (4.5). A later turn picks the work up from the records (2.4).

## 5. What the client shows

- **The cards** show what the client holds: each object's `object.json`, its `shown_file` and its receipts. A file's history is every earlier content of it (2.1; in git, `git log` of the path).
- **"Use" on a past result** restores the files that result's change wrote inside the object's own folder, receipts with them, as a `person` change. That is the change's commit in git; for a turn's change, the commit carrying its `Pine-Change-Number`. Files of a variant or any other object folded inside it are not included, since each is an object of its own. Files the same change wrote for other objects stay as they are. The rule is the same whoever made the change: a turn, the person, or `client-found-changes-on-disk`, which may hold the whole project. The restored result's file is the shown one again: `object.json` `shown_file` names it, and a current shown file of another name is deleted with its receipt in the same change, as for the person's own picture (3). An output's siblings and receipts live in its object's folder, so an output never sits beside another result's sibling or receipt.

## 6. Errors

An error is `{code, message, action?, upgrade_needed?}`. `message` is for the person, and `action` says what to do.

| `code` | When |
|---|---|
| `pine_computer_found_no_such_file_or_object` | A request names a file or object that does not exist. |
| `pine_computer_found_request_not_matching_protocol` | A request does not match this page. |
| `pine_computer_found_file_missing_from_store` | A file the request names is not in the store. |
| `pine_computer_refused_request_of_unsupported_protocol_major` | Pine Computer met a request of a major it does not read. |
| `client_refused_document_of_unsupported_protocol_major` | The client met a document of a major it does not read: a change, a record of Pine Computer's (2.4), an object, a receipt, or a project's `pine-drama-project.json`. |

## 7. Majors and upgrades

- **One major per reader.** A reader reads only its own major, and a document of any other major is refused whole, with `pine_computer_refused_request_of_unsupported_protocol_major` or `client_refused_document_of_unsupported_protocol_major` by whichever side refused. A major is the format itself: read by rules it does not follow, a document could write wrong data into the person's folder. Git likewise refuses a repository whose format version it does not understand ([gitrepository-layout](https://git-scm.com/docs/gitrepository-layout)).
- **A refusal names the upgrade.** Either refusal MUST carry `upgrade_needed: {minimum_client_version, download_url?}` when the refusing side knows it: the lowest client version that reads the newer major and, for a client people install, where to download it. The client MUST tell the person.
  - When the client meets a newer major, it says which newer version of itself is needed, and where to get it when there is a download.
  - A newer Computer side writes changes of a newer major, and the client refuses them by their `schema`.
  - An older Computer side is known only by what it writes, never by what is missing: a document whose `schema` is of an older major, or a key of an older major's store layout under `turns/<turn id>/` (major 1's `return.json`). The client then says the session runs on an older Pine Computer side, and that a new session starts on a current one. A turn that ends with neither a turn record nor a change ran no drama-cli command (4.2) and changed nothing.
- **A drama of another major** is never written. The client offers to convert it (section 8).
- **Releases.** A new major ships the client and the Computer side on the same day.

## 8. Converting a major-1 drama (client)

The conversion is the client's alone. Its working records are its own, and only its outcome is normative.

1. **Freeze.** No turn is sent and no person change is written. While a major-1 turn has no return yet, the conversion refuses. It says that nothing was changed, and asks the person to finish or stop that turn in the previous client, with a link to its download. No major-1 installer is kept for this case.
2. **Back up.** The folder is copied beside itself as `<name>.backup-<YYYY-MM-DD>`, by clonefile where the file system has it, otherwise as a plain copy. Going back to the older client stays possible.
3. **Inventory.** Every major-1 version folder on disk goes in: those of installed turns, adopted ones, takes and discarded versions. The client records them with their hashes before it changes anything, so a cut-off conversion resumes from it.
4. **History.** The client applies [`protocol/v2/major1-to-major2-conversion.json`](../extensions/pine-drama/protocol/v2/major1-to-major2-conversion.json), normative data. In one order across all objects (oldest first), each old version that changes a file makes one commit writing its files to their major-2 paths, with receipts, as `client-found-changes-on-disk`. A version that changes nothing makes no commit: its bytes are already in history. So `git log` of a file lists every old version, discarded ones included. The table is the only place that knows major 1's record formats: the client reads it, never a format of its own.
5. **Current.** A last commit sets each object's files to its major-1 *current* (major 1's 3.2), deletes removed objects, and writes the person's pending text, as the table's `current` says. Unresolved paid calls keep their records until a turn settles them.
6. **Verify, then mark.** The bytes of every inventoried version are checked to be reachable in history. Then `pine-drama-project.json` is written, and the old version folders and `choices.json` are removed.
