# Pine Drama protocol, major version 2

Status: draft. Major 2 replaces major 1 whole: a reader of one major reads no document of the other (section 7).

This protocol connects two sides, the way Codex runs a task:
- the **client**, the program on the person's machine. It holds the drama's folder, shows it, and lets the person change any file in it, as with a local coding agent;
- the **Computer side**, the program on a Pine Computer that makes the drama. Each turn works in its own workspace, seeded from the folder, and every result it finishes comes back as one change the client applies, as Codex's cloud tasks are applied (`git apply --check`, then the apply).

The Computer side also works with no client: driven by Pine Computer's own agent, by another program, or from a terminal.

**The drama's folder is a git repository** (section 2).
- **One current file per object.** Each object has one current copy of each of its files, and history is the repository's commits.
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
| Path | A file or folder inside the drama's folder: project-relative, `/`-separated, Unicode NFC. No segment is empty or starts with `.`. No segment contains `\` or a control character (U+0000–U+001F, U+007F–U+009F), is a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an extension), or ends with `.` or a space. There is no leading or trailing `/`, and a path is at most 240 characters. Two paths that differ only by case are the same path. A name starting with `.` (`.git`, `.gitattributes`) is never a path of this protocol, so it never travels. |
| Object id | The path of the object's folder, for example `assets/characters/lin`. Whoever creates the object chooses it. |
| Turn id | An id the client chooses for a turn. It matches `^[A-Za-z0-9_-]{8,64}$` and is never reused in a drama. |
| Paid call id | An id the Computer side chooses for one paid call, unique in the drama, matching the same pattern. |
| Time | An RFC 3339 `date-time` in UTC, whole seconds, with the `Z` suffix, for example `2026-11-15T10:00:00Z`. |
| Hash | The lowercase hex SHA-256 of a file's bytes. Git's own object ids never appear in a document. |

## 2. The drama's folder (client)

### 2.1 The repository

- **Who writes what.** The folder is a git repository, and only the client writes `.git`.
- **Commits.** The client commits every change made in the folder, each with the author that made it:
  - `pine-computer`: a result applied from a turn (4.4), with the trailers `Pine-Turn-Id: <turn id>` and `Pine-Change-Number: <change number>`;
  - `person`: the person's own change through the client;
  - `client-found-changes-on-disk`: whatever the folder holds that no commit records (a hand edit, or the files of a write a crash cut off), found when the client opens the drama or seeds a turn.
- **Byte-preserving.** The client MUST store files byte for byte: `* -text` in `.gitattributes`, and no filters. A repository the folder already has is used as it is.
- **History is the only undo.** Undoing a change is a revert of its commit; a turn's changes are the commits carrying its `Pine-Turn-Id` trailer.

**`pine-drama-project.json`** (`$defs/projectMarker`) at the folder's root marks it as a drama of this major: `{"schema": 2}`. It is written when the drama is made, or last by a conversion from another major. A folder without it is not a drama of major 2.

### 2.2 Objects

An object is a folder holding **`object.json`** (`$defs/object`):

| Field | Meaning |
|---|---|
| `type` | `episode`, `screenplay`, `bible`, `character`, `scene`, `prop`, `variant`, `breakdown`, `storyboard`, `keyframe`, `video_prompts`, `take`, `cut` or `subtitles`, in pipeline order. |
| `name` | Its name for the person. |
| `shown_file` | The object's shown file, relative to its folder (image, video or text), or `null` before it has one. Such an object is a planned, empty card. |
| `variant_of` | For a variant: the object id it derives from. |
| `segment` | Its segment within the episode, or absent. |
| `setting` | For a scene: `interior` or `exterior`. |
| `relations` | Other relations, each `{kind, to}`: `inside_of` (a scene inside a scene), `appears_in` (an asset in an episode), `needs` (an episode needs an object before it can be shot). |

- **Who creates objects.** Either side may create an object. The client creates one when the person adds it, with `object.json` and the person's `description.md`. drama-cli derives every name a model reads from `name`, never from the id.
- **The person's text.** In an object's folder, `description.md` and `prompt.md`, when present, are the text the person and Pine Computer edit. Whoever writes last wins, and git keeps the earlier text.
- **Removal.** Removing an object deletes its folder; a variant is a folder below its asset's, so it goes with it.

### 2.3 Receipts

Each output of a paid call has a receipt beside it, **`<file>.receipt.json`** (`$defs/receipt`). It is written before the output, and always applied together with it (4.4):

| Field | Meaning |
|---|---|
| `paid_call_id` | The paid call that made it (4.5). |
| `finished_at` | When the output was finished. |
| `inputs_sent_in_order` | The files the call was sent, in the order it was given them (`Image 1`…`Image N`), each `{path, sha256}` as it was then. Their bytes are in the drama's history: the seed commits them (4.2), and a turn's own inputs land as its changes. |
| `prompt_sent` | The prompt the call was sent, or `null`. |
| `cost` | `{usd, reported_by}`, for example `"reported_by": "pine"`, or `null` when unknown. |

The rest of the receipt (the request and response as sent) belongs to the Computer side. A client MAY show it, and decides nothing from it.

- **One receipt per output.** A call with several outputs (a take's video and its last frame) has a receipt beside each, all in one change.
- **No paid call, no receipt.** A file made without a paid call (a cut, an overlay, a conversion) has none.

## 3. The person's changes (client)

- **The person changes any file in the folder**, through the client or by hand. A change through the client is a plain write (a temporary sibling, then a rename) and a `person` commit of the paths it wrote.
- **Hand changes** are committed as `client-found-changes-on-disk` at the next opening or seed.
- **Using the person's own picture or video for an object.** The person's file replaces the object's shown file. It is written under the shown file's name, with the extension of the person's file, and `object.json` `shown_file` is set to it. If the extension changed, the old shown file and its receipt are deleted in the same commit. The person's file has no receipt, since no paid call made it. History keeps what it replaced.
- **Files the person attaches** to a note or a chat message, and are not an object's file, are written to `person-attachments/<id>.<extension>` and committed. A note's `attached_file` names one of them (4.2).
- **A running turn** sees a change only at its next seed (4.2). A person's edit made while a turn runs can be replaced by that turn's later write to the same file; it stays in the file's history, one restore away (4.4).

## 4. The turn

### 4.1 Transport on Pine

**The message.** A turn is one message to a session on a Pine Computer.
- Its text begins with the line `pine-drama-turn <turn id>`, followed by the person's own words.
- The client sends it with Pine's idempotency key set to the turn id.
- It writes `request.json` once and keeps its bytes; a retry resends the same message with the same key.

**Sessions.**
- A session runs one turn at a time and sends its next only after its previous return is resolved (4.6).
- Any number of sessions may work on one drama. None owns any object.

**Storage.** The keys of the Computer's artifact store, each written once:
- `files/<hash>`: one file;
- `session-private-states/<hash>.tar`: one session's private state;
- `turns/<turn id>/request.json` (client), `turns/<turn id>/turn-started.json` and `turns/<turn id>/return.json` (Computer side);
- `turns/<turn id>/changes/<change number>.json`: one change (4.3);
- `turns/<turn id>/paid-calls/<paid call id>/<state>.json`: one state of one paid call (4.5).

**Bytes.**
- A reader MUST check every file against its hash before it uses it.
- Before a turn, the client makes the target store hold every file the request names: it copies a file inside Pine from a Computer it remembers holding that hash, or uploads it.

### 4.2 Request (client → Computer side)

`$defs/request`, at `turns/<turn id>/request.json`.

| Field | Meaning |
|---|---|
| `turn_id` | The turn id. |
| `seed_files` | The seed: every file of the drama at the commit the client made for it, `{<path>: <hash>}`. Paths starting with `.` are left out (section 1). |
| `session_private_state` | The hash of the session's private state from its last return, or `null`. |
| `notes_for_pine_computer` | The person's feedback for Pine Computer, each `{object_id, text, attached_file?, position_in_shown_file?: {x, y}, seconds_into_video?}`. `attached_file` is a file of `seed_files` (a picture the person attached), `position_in_shown_file` gives fractions 0–1 of the shown file's width and height, and `seconds_into_video` gives seconds into a video. A note decides nothing. |

- **The seed commit.** Before writing the request, the client commits whatever is uncommitted as `client-found-changes-on-disk`, so the seed is a commit and every input the turn may read is in history.
- **Restore.** The Computer side writes exactly `seed_files` into its workspace, then restores the private state outside it: private state never holds a file of the drama, so it cannot overwrite the seed. A file of the tree the Computer side rewrites only for its own machine, such as a path in its configuration, is kept outside the workspace too, so it never comes back as a change.
- **Only what changed moves.** The workspace MUST equal `seed_files` exactly. To get there, the Computer side MAY keep its workspace and a local cache of file bytes by hash between turns on the same Computer. It then fetches only the paths whose hash changed, links them in from the cache, and deletes the paths `seed_files` no longer has. This is the remote-execution model of Bazel's REAPI, where an executor materializes an input root from its content-addressed cache. A fresh Computer fetches the whole tree once.

### 4.3 Changes (Computer side → client)

Each result the turn finishes is one **change** (`$defs/change`) at `turns/<turn id>/changes/<change number>.json`: an output with its receipt, or a text write. `change_number` counts from 1 within the turn.

```
change = { schema, turn_id, change_number, previous_change_sha256, files_after_change: { <path>: <hash> | null } }
```

| Field | Meaning |
|---|---|
| `previous_change_sha256` | The hash of the previous change's bytes, or `null` for the first. A client that missed one finds it by its number in the store. |
| `files_after_change` | Each path the change writes, with the hash of its new bytes, or `null` for a file it deletes. |

- **Bytes first.** The Computer side stores every file of `files_after_change` at `files/<hash>` before it writes the change.
- **Every changed file comes back.** A file the Computer side changes in its workspace by any means (its own commands, or its agent editing the file directly) comes back as a change. Before each of its commands and before its return, the Computer side writes a change for every workspace file that differs from `seed_files` and from what its earlier changes wrote.

### 4.4 Applying a change (client)

The client applies a turn's changes in `change_number` order, through the one queue that also writes the person's changes, so two never write at once. For each change:

1. **Resolved already?** A change is resolved when a commit carries its trailers `Pine-Turn-Id: <turn id>` and `Pine-Change-Number: <change number>`. Then it is skipped. The repository is the record, so it travels with the folder. If every path's current hash already equals its hash in `files_after_change` (a crash's files that a `client-found-changes-on-disk` commit took), the client records it with an empty commit carrying those trailers, and goes on.
2. **Write.** Each file is written by a temporary sibling and a rename, receipts before the outputs they describe. A `null` deletes the file.
3. **Commit.** The client commits exactly those paths (`git commit --only -- <paths>`) as `pine-computer`, with the trailers `Pine-Turn-Id` and `Pine-Change-Number`.

**A crash** between steps 2 and 3 leaves the files on disk. The next opening commits them as `client-found-changes-on-disk`, and step 1 then finds the change applied.

**The newest result lands.** There is no check against what a file held before and no refusal: whichever change is applied last is the file's current content, and the file's history keeps every earlier one, the person's included. The same one rule covers a reroll's attempts, two sessions writing one file, and a turn writing over a person's edit. "Use" (section 5) brings any earlier one back.

### 4.5 Paid calls (Computer side)

Each paid call's states are documents of their own (`$defs/paidCallState`) at `turns/<turn id>/paid-calls/<paid call id>/<state>.json`, each written once:

| State | Written |
|---|---|
| `pine_computer_sent_request_to_provider` | Before the call is sent to the provider. |
| `provider_returned_output_to_pine_computer`, `provider_reported_failure_to_pine_computer`, `pine_computer_cancelled_call_after_person_pressed_stop` | When the call ends so. These are terminal. |

The person pressing Stop is the only cause of `pine_computer_cancelled_call_after_person_pressed_stop`. A call cut off any other way (the Pine turn ending, the Computer lost) is `pine_computer_cannot_learn_call_outcome` until a later turn learns its outcome.
| `pine_computer_cannot_learn_call_outcome` | When the call's outcome cannot be learned. This state is **not settled**: the Computer side MUST NOT send the same request to the provider again while a call of it is in this state. |

A paid-call state carries `{schema, paid_call_id, object_id, state, state_written_at, cost?}`. It is the public summary only.
- **The ledger stays the Computer side's.** The paid-call ledger keeps the reservation, the generation lock, the attempt identity, the request as saved and the provider's reference (drama-cli's `ledger.py`). It travels in the private state, so a later turn of the session can settle a call an earlier one started.
- **Settling a call.** The turn that settles a call writes its terminal state under the call's own key (`turns/<turn that started it>/paid-calls/<paid call id>/`), and writes its output as a change of its own (4.3).
- **Making.** An object is being made while it has a paid call sent to the provider with no terminal state. The client shows it as making.
- **Recovery.** Pine keeps each session's provider journal with its Computer. A Computer that replaces a lost one cannot observe its calls, so their calls stay `pine_computer_cannot_learn_call_outcome`, with their receipts and charges kept.

### 4.6 Return (Computer side → client)

`$defs/return`, at `turns/<turn id>/return.json`. It is written last, after every change and paid-call document it covers.

| Field | Meaning |
|---|---|
| `turn_id` | The turn id. |
| `state` | `pine_computer_is_waiting_for_person_answer` (Pine Computer asks the person something), `pine_computer_finished_the_work` (the work is done), `pine_computer_broke_off_the_turn_partway` (the work stopped early, and what finished came back as changes) or `pine_computer_refused_the_turn_before_running` (nothing was done; see `error`). |
| `last_change` | `{change_number, sha256}` of the turn's last change, or `null` when it made none. The client applies up to it before it resolves the return. |
| `session_private_state` | The hash of the session's new private state at `session-private-states/<hash>.tar`, or `null` when the session has none. |
| `pine_computer_could_not_do` | What the Computer side could not do, each `{object_or_file, error}`. |
| `question_for_person` | When `pine_computer_is_waiting_for_person_answer`: Pine Computer's question. |
| `error` | When `pine_computer_broke_off_the_turn_partway` or `pine_computer_refused_the_turn_before_running`: why (section 6). |

**Fields by state.** `pine_computer_refused_the_turn_before_running` carries `error` only. `pine_computer_is_waiting_for_person_answer`, `pine_computer_finished_the_work` and `pine_computer_broke_off_the_turn_partway` carry `last_change`, `session_private_state` and `pine_computer_could_not_do`. `pine_computer_is_waiting_for_person_answer` adds `question_for_person`, and `pine_computer_broke_off_the_turn_partway` adds `error`.

- **Resolved.** A return is resolved once its changes up to `last_change` are applied. The session may then send its next turn.
- **Private state.** The client keeps a copy of every private-state archive a return named, by hash, and the session's next request names the one its latest resolved return gave. A `pine_computer_refused_the_turn_before_running` or missing return keeps the one before.
- **Stops are questions.** The five stops of the drama workflow are `pine_computer_is_waiting_for_person_answer` returns: the person's answer is the approval of the next paid work, given before it, as a coding agent asks for approval before it acts (Codex's AskForApproval). There is no acceptance after the fact.

### 4.7 Stop, and a run that does not return

- **However a turn ends on Pine** (completed, failed, canceled), the client reads `return.json`. If it exists, it wins.
- **Stop.** The client cancels the Pine turn. The Computer side sends no new paid call to a provider, and writes a `pine_computer_broke_off_the_turn_partway` return with what was stored if it can. Pine Computer loses at most the text its agent edited directly after its last command, since every command starts by writing such edits as changes (4.3).
- **No return.** When the turn ends with no `return.json`, the client applies every change stored for it, in `change_number` order, up to the first missing one. It keeps the session's private state, and tells the person the run may have spent money. The return is then resolved, and the session may send its next turn. Paid calls in flight settle in that turn, on the same Computer (4.5).
- **Replay.** Before any work, the Computer side writes `turns/<turn id>/turn-started.json` (`$defs/turnStarted`): `{schema, turn_id, request_sha256: <hash of request.json's bytes>, started_at}`. It reads a request in this order:
  1. If `turn-started.json` exists with another `request_sha256`, the turn id came back with a different request. It is refused with `pine_computer_found_request_not_matching_protocol`.
  2. If `return.json` exists, it returns it again.
  3. If `turn-started.json` exists, the run was cut off: it runs nothing again, and returns `pine_computer_broke_off_the_turn_partway` with what was stored.
  4. Otherwise it writes `turn-started.json` and runs.

## 5. What the client shows

- **The cards** show what the folder holds: each object's `object.json`, its `shown_file` and its receipts. A history is `git log` of a path.
- **"Use" on a past result** restores every file of that result's change (the commit carrying its `Pine-Change-Number`), receipts with them, as a `person` commit. So an output never sits beside another result's sibling or receipt.

## 6. Errors

An error is `{code, message, action?, upgrade_needed?}`. `message` is for the person, and `action` says what to do.

| `code` | When |
|---|---|
| `pine_computer_found_no_such_file_or_object` | A request names a file or object that does not exist. |
| `pine_computer_found_request_not_matching_protocol` | A request does not match this page, or a turn id came back with a different request. |
| `pine_computer_found_file_missing_from_store` | A file the request names is not in the store. |
| `pine_computer_broke_off_the_work` | The work stopped early. |
| `pine_computer_refused_request_of_unsupported_protocol_major` | Pine Computer met a request of a major it does not read. |
| `client_refused_document_of_unsupported_protocol_major` | The client met a document of a major it does not read: a return, a change, or a project's `pine-drama-project.json`. |

## 7. Majors and upgrades

- **One major per reader.** A reader reads only its own major, and a document of any other major is refused whole, with `pine_computer_refused_request_of_unsupported_protocol_major` or `client_refused_document_of_unsupported_protocol_major` by whichever side refused. A major is the format itself: read by rules it does not follow, a document could write wrong data into the person's folder. Git likewise refuses a repository whose format version it does not understand ([gitrepository-layout](https://git-scm.com/docs/gitrepository-layout)).
- **A refusal names the upgrade.** Either refusal MUST carry `upgrade_needed: {minimum_client_version, download_url}` when the refusing side knows it: the lowest client version that reads the newer major, and where to download it. The client MUST show it to the person.
  - When the client meets a newer major, it names its own newer version and where to download it.
  - When it meets an older Computer side (a major-1 refusal, or no answer in major 2), it says that this Computer runs an older drama-cli and that a new Chat starts on a current one.
- **A drama of another major** is never written. The client offers to convert it (section 8).
- **Releases.** A new major ships the client and the Computer side on the same day.

## 8. Converting a major-1 drama (client)

The conversion is the client's alone. Its working records are its own, and only its outcome is normative.

1. **Freeze.** No turn is sent and no person change is written. While a major-1 turn has no return yet, the conversion refuses. It says that nothing was changed, and asks the person to finish or stop that turn in the previous client, with a link to its download. No major-1 installer is kept for this case.
2. **Back up.** The folder is copied beside itself as `<name>.backup-<YYYY-MM-DD>`, by clonefile where the file system has it, otherwise as a plain copy. Going back to the older client stays possible.
3. **Inventory.** Every major-1 version folder on disk goes in: those of installed turns, adopted ones, takes and discarded versions. The client records them with their hashes before it changes anything, so a cut-off conversion resumes from it.
4. **History.** The client applies [`protocol/v2/major1-to-major2-conversion.json`](../extensions/pine-drama/protocol/v2/major1-to-major2-conversion.json), normative data. Per object, oldest first, one commit per old version writes that version's files to their major-2 paths, with receipts, as `client-found-changes-on-disk`. So `git log` of a file lists every old version, discarded ones included. The table is the only place that knows major 1's record formats: the client reads it, never a format of its own.
5. **Current.** A last commit sets each object's files to its major-1 *current* (major 1's 3.2), deletes removed objects, and writes the person's pending text, as the table's `current` says. Unresolved paid calls keep their records until a turn settles them.
6. **Verify, then mark.** Every inventoried version is checked to be reachable in history. Then `pine-drama-project.json` is written, and the old version folders and `choices.json` are removed.
