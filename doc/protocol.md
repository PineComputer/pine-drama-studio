# Pine Drama protocol, major version 2

Status: draft. Major 2 replaces major 1 whole: a reader of one major reads no document of the other (section 7).

This protocol connects two sides, the way Codex runs a task:
- the **client**, the program on the person's machine. It holds the drama's folder, shows it, and lets the person change any file in it, as with a local coding agent;
- the **Computer side**, the program on a Pine Computer that makes the drama. Each turn works in its own workspace, seeded from the folder, and every result it finishes comes back as one change the client applies, as Codex's cloud tasks are applied (`git apply --check`, then the apply).

The Computer side also works with no client: driven by an agent, by another program, or from a terminal.

**The drama's folder is a git repository** (section 2).
- **One current file per object.** Each object has one current copy of each of its files, and history is the repository's commits.
- **No version numbers, no choices file, no acceptance state, no scopes.**
- **Any number of sessions** may work on one drama at once. Two results that change the same file conflict, and a conflict loses nothing (4.4).

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
| Client id | An id the client chooses for a turn. It matches `^[A-Za-z0-9_-]{8,64}$` and is never reused in a drama. |
| Job id | An id the Computer side chooses for one paid call, unique in the drama, matching the client-id pattern. |
| Time | An RFC 3339 `date-time` in UTC, whole seconds, with the `Z` suffix, for example `2026-11-15T10:00:00Z`. |
| Hash | The lowercase hex SHA-256 of a file's bytes. Git's own object ids never appear in a document. |

## 2. The drama's folder (client)

### 2.1 The repository

- **Who writes what.** The folder is a git repository, and only the client writes `.git`.
- **Commits.** The client commits every change made in the folder, each with the author that made it:
  - `agent`: a result applied from a turn (4.4), with the trailers `Pine-Turn: <turn id>` and `Pine-Change: <seq>`;
  - `person`: the person's own change through the client;
  - `recovered`: whatever the folder holds that no commit records, found when the client opens the drama or seeds a turn.
- **Byte-preserving.** The client MUST store files byte for byte: `* -text` in `.gitattributes`, and no filters. A repository the folder already has is used as it is.
- **History is the only undo.** Undoing a change is a revert of its commit; a turn's changes are the commits carrying its `Pine-Turn` trailer.

**`drama.json`** (`$defs/drama`) at the folder's root marks it as a drama of this major: `{"schema": 2}`. It is written when the drama is made, or last by a conversion from another major. A folder without it is not a drama of major 2.

### 2.2 Objects

An object is a folder holding **`object.json`** (`$defs/object`):

| Field | Meaning |
|---|---|
| `type` | `episode`, `screenplay`, `bible`, `character`, `scene`, `prop`, `variant`, `breakdown`, `storyboard`, `keyframe`, `video_prompts`, `take`, `cut` or `subtitles`, in pipeline order. |
| `name` | Its name for the person. |
| `file` | The object's shown file, relative to its folder (image, video or text), or `null` before it has one. Such an object is a planned, empty card. |
| `from` | For a variant: the object id it derives from. |
| `segment` | Its segment within the episode, or absent. |
| `setting` | For a scene: `interior` or `exterior`. |
| `links` | Other relations, each `{kind, to}`: `inside_of` (a scene inside a scene), `appears_in` (an asset in an episode), `needs` (an episode needs an object before it can be shot). |

- **Who creates objects.** Either side may create an object. The client creates one when the person adds it, with `object.json` and the person's `description.md`. drama-cli derives every name a model reads from `name`, never from the id.
- **The person's text.** In an object's folder, `description.md` and `prompt.md`, when present, are the text the person and the agent edit. Whoever writes last wins, and git keeps the earlier text.
- **Removal.** Removing an object deletes its folder; a variant is a folder below its asset's, so it goes with it.

### 2.3 Receipts

Each output of a paid call has a receipt beside it, **`<file>.receipt.json`** (`$defs/receipt`). It is written before the output, and always applied together with it (4.4):

| Field | Meaning |
|---|---|
| `job` | The job id of the call (4.5). |
| `made_at` | When the output was finished. |
| `inputs` | The files the call was sent, in the order it was given them (`Image 1`…`Image N`), each `{path, sha256}` as it was then. Their bytes are in the drama's history: the seed commits them (4.2), and a turn's own inputs land as its changes. |
| `prompt` | The prompt it was made with, or `null`. |
| `cost` | `{usd, source}` as the source reports it, for example `"source": "pine"`, or `null` when unknown. |

The rest of the receipt (the request and response as sent) belongs to the Computer side. A client MAY show it, and decides nothing from it.

- **One receipt per output.** A call with several outputs (a take's video and its last frame) has a receipt beside each, all in one change.
- **No paid call, no receipt.** A file made without a paid call (a cut, an overlay, a conversion) has none.

## 3. The person's changes (client)

- **The person changes any file in the folder**, through the client or by hand. A change through the client is a plain write (a temporary sibling, then a rename) and a `person` commit of the paths it wrote.
- **Hand changes** are committed as `recovered` at the next opening or seed.
- **A running turn** sees a change only at its next seed (4.2). A result that lands over a file the person changed meanwhile conflicts (4.4).

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
- `state/<hash>.tar`: one session's private state;
- `turns/<turn id>/request.json` (client), `turns/<turn id>/running.json` and `turns/<turn id>/return.json` (Computer side);
- `turns/<turn id>/changes/<seq>.json`: one change (4.3);
- `turns/<turn id>/jobs/<job id>/<state>.json`: one state of one paid call (4.5).

**Bytes.**
- A reader MUST check every file against its hash before it uses it.
- Before a turn, the client makes the target store hold every file the request names: it copies a file inside Pine from a Computer it remembers holding that hash, or uploads it.

### 4.2 Request (client → Computer side)

`$defs/request`, at `turns/<turn id>/request.json`.

| Field | Meaning |
|---|---|
| `turn` | The turn id. |
| `tree` | The seed: every file of the drama at the commit the client made for it, `{<path>: <hash>}`. Paths starting with `.` are left out (section 1). |
| `private_state` | The hash of the session's private state from its last return, or `null`. |
| `notes` | The person's feedback for the agent, each `{object, text, file?, at?: {x, y}, time?}`. `file` is a file of the tree the note shows (a picture the person attached), `at` gives fractions 0–1 of the shown file's width and height, and `time` gives seconds into a video. A note decides nothing. |
| `conflicts` | The changes of this session's earlier turns that the client committed as conflicts since its last request (4.4), each `{turn, seq, paths}`, so the agent learns of them. |

- **The seed commit.** Before writing the request, the client commits whatever is uncommitted as `recovered`, so the seed is a commit and every input the turn may read is in history.
- **Restore.** The Computer side writes exactly `tree` into its workspace, then restores the private state outside it: private state never holds a file of the drama, so it cannot overwrite the seed. A file of the tree the Computer side rewrites only for its own machine, such as a path in its configuration, is kept outside the workspace too, so it never comes back as a change.

### 4.3 Changes (Computer side → client)

Each result the turn finishes is one **change** (`$defs/change`) at `turns/<turn id>/changes/<seq>.json`: an output with its receipt, or a text write. `seq` counts from 1 within the turn.

```
change = { schema, turn, seq, prev, files: { <path>: { base, new } } }
```

| Field | Meaning |
|---|---|
| `prev` | The hash of change `seq - 1`'s bytes, or `null` for the first. A client that missed one finds it by `seq` in the store. |
| `base` | The hash of the file as the turn read it, or `null` for a file the turn creates. |
| `new` | The hash of the file the change writes, or `null` for a file it deletes. |

- **Bytes first.** The Computer side stores every `new` file at `files/<hash>` before it writes the change.
- **Rerolls.** The attempts of one turn on one file chain: each attempt's `base` is the previous attempt's `new`. So they apply in order, and the file's history holds every one.

### 4.4 Applying a change (client)

The client applies a turn's changes in `seq` order, through the one queue that also writes the person's changes, so two never write at once. For each change:

1. **Resolved already?** The client records, in its turn record, the highest `seq` of each turn it has applied or committed as a conflict. A change at or below it is skipped. If every path's current hash equals its `new`, the change is applied already: it is recorded and skipped.
2. **Conflict.** If any path's current hash differs from its `base`, nothing is written. The whole change is committed, unapplied, under the ref `refs/pine/conflicts/<turn id>/<seq>`, and the client tells the person which paths conflicted. Nothing the turn paid for is lost: the conflict ref keeps it, and the person or a later turn can apply it.
3. **Write.** Each file is written by a temporary sibling and a rename, receipts before the outputs they describe. A `new` of `null` deletes the file.
4. **Commit.** The client commits exactly those paths (`git commit --only -- <paths>`) as `agent`, with the trailers `Pine-Turn` and `Pine-Change`.

**A crash** between steps 3 and 4 leaves the files on disk. The next opening commits them as `recovered`, and step 1 then finds the change applied.

A client that moves or exports the repository keeps `refs/pine/conflicts/*` with it (for example `git clone --mirror`).

### 4.5 Jobs (Computer side)

Each paid call is a **job**. Its states are documents of their own (`$defs/job`) at `turns/<turn id>/jobs/<job id>/<state>.json`, each written once:

| State | Written |
|---|---|
| `submitted` | Before the call is dispatched. |
| `succeeded`, `failed`, `cancelled` | When the call ends so. These are terminal. |
| `unknown` | When the call's outcome cannot be learned. This state is **not settled**: the Computer side MUST NOT submit the same request again while a job of it is unknown. |

A job carries `{schema, job, object, state, at, cost?}`. It is the public summary only.
- **The ledger stays the Computer side's.** The paid-call ledger keeps the reservation, the generation lock, the attempt identity, the request as saved and the provider's reference (drama-cli's `ledger.py`). It travels in the private state, so a later turn of the session can settle a call an earlier one started.
- **Settling a call.** The turn that settles a call writes its terminal state under the job's own key (`turns/<turn that started it>/jobs/<job id>/`), and publishes its output as a change of its own.
- **Making.** An object is being made while it has a submitted job with no terminal state. The client shows it as making.
- **Recovery.** Pine keeps each session's provider journal with its Computer. A Computer that replaces a lost one cannot observe its calls, so their jobs stay `unknown`, with their receipts and charges kept.

### 4.6 Return (Computer side → client)

`$defs/return`, at `turns/<turn id>/return.json`. It is written last, after every change and job document it covers.

| Field | Meaning |
|---|---|
| `turn` | The turn id. |
| `state` | `stopped` (the agent asks the person something), `ended` (the work is done), `failed` (the work broke off, and what finished came back as changes) or `refused` (nothing was done; see `error`). |
| `last` | `{seq, hash}` of the turn's last change, or `null` when it made none. The client applies up to it before it resolves the return. |
| `private_state` | The hash of the session's new private state at `state/<hash>.tar`, or `null` when the session has none. |
| `problems` | What the Computer side could not do, each `{ref, error}`. |
| `question` | When `stopped`: the agent's question. |
| `error` | When `failed` or `refused`: why (section 6). |

**Fields by state.** `refused` carries `error` only. `stopped`, `ended` and `failed` carry `last`, `private_state` and `problems`. `stopped` adds `question`, and `failed` adds `error`.

- **Resolved.** A return is resolved once its changes up to `last` are applied or committed as conflicts. The session may then send its next turn.
- **Private state.** The client keeps a copy of every private-state archive it received, by hash, and the session's next request names the one its latest resolved return gave. A `refused` or missing return keeps the one before.
- **Stops are questions.** The five stops of the drama workflow are `stopped` returns: the person's answer is the approval of the next paid work, given before it, as an agent asks for approval before it acts. There is no acceptance after the fact.

### 4.7 Stop, and a run that does not return

- **However a turn ends** (completed, failed, canceled), the client reads `return.json`. If it exists, it wins.
- **Stop.** The client cancels the Pine turn. The Computer side dispatches no new job, and writes a `failed` return with what was stored if it can.
- **No return.** When the turn ends with no `return.json`, the client applies every change stored for it, in `seq` order, up to the first missing one. It keeps the session's private state, and tells the person the run may have spent money. The return is then resolved, and the session may send its next turn. Jobs in flight settle in that turn, on the same Computer (4.5).
- **Replay.** Before any work, the Computer side writes `turns/<turn id>/running.json` (`$defs/running`): `{schema, turn, request: <hash of request.json's bytes>, at}`. It handles a request in this order:
  1. If `running.json` exists with another `request` hash, the turn id came back with a different request. It is refused with `invalid`.
  2. If `return.json` exists, it returns it again.
  3. If `running.json` exists, the run was cut off: it runs nothing again, and returns `failed` with what was stored.
  4. Otherwise it writes `running.json` and runs.

## 5. What the client shows

- **The cards** show what the folder holds: each object's `object.json`, its shown `file` and its receipts. A history is `git log` of a path, and a conflict ref is listed with the history of the paths it holds.
- **"Use" on a past result** restores every file of that result's change (the commit carrying its `Pine-Change`), receipts with them, as a `person` commit. So an output never sits beside another result's sibling or receipt.

## 6. Errors

An error is `{code, message, action?, upgrade?}`. `message` is for the person, and `action` says what to do.

| `code` | When |
|---|---|
| `not_found` | A request names a file or object that does not exist. |
| `invalid` | A document does not match this page, or a turn id comes back with a different request. |
| `missing_input` | A file the request names is not in the store. |
| `failed` | The work broke off. |
| `unsupported_schema` | A document of a major the reader does not support. |

## 7. Majors and upgrades

- **One major per reader.** A reader reads only its own major, and a document of any other major is refused whole with `unsupported_schema`. A major is the format itself: read by rules it does not follow, a document could write wrong data into the person's folder. Git likewise refuses a repository whose format version it does not understand ([gitrepository-layout](https://git-scm.com/docs/gitrepository-layout)).
- **A refusal names the upgrade.** An `unsupported_schema` error MUST carry `upgrade: {studio, url}` when the refusing side knows it: `studio` is the lowest client version that reads the newer major, and `url` is where to download it. The client MUST show it to the person.
  - When the client meets a newer major, it names its own update.
  - When it meets an older Computer side (a major-1 refusal, or no answer in major 2), it says that this Computer runs an older drama-cli and that a new Chat starts on a current one.
- **A drama of another major** is never written. The client offers to convert it (section 8).
- **Releases.** A new major ships the client and the Computer side on the same day.

## 8. Converting a major-1 drama (client)

The conversion is the client's alone. Its working records are its own, and only its outcome is normative.

1. **Freeze.** No turn is sent and no person change is written. While a major-1 turn has no return yet, the conversion refuses. It says that nothing was changed, and asks the person to finish or stop that turn in the previous client, with a link to its download. No major-1 installer is kept for this case.
2. **Back up.** The folder is copied beside itself as `<name>.backup-<YYYY-MM-DD>`, by clonefile where the file system has it, otherwise as a plain copy. Going back to the older client stays possible.
3. **Inventory.** Every major-1 version folder on disk goes in: those of installed turns, adopted ones, takes and discarded versions. So do every review and choice. The client records them with their archive hashes before it changes anything, so a cut-off conversion resumes from it.
4. **History.** Per object, in `made_at` order, one commit per old version writes that version's shown file to the object's file and its records to its receipt, as `recovered`. So `git log` of the file lists every old version, discarded ones included. Unresolved paid calls keep their records until a turn settles them.
5. **Current.** A last commit sets each object's files to its major-1 *current* (major 1's 3.2) and writes `object.json` from the snapshots the client installed. Removed objects are deleted, and the person's pending text becomes `description.md` or `prompt.md`.
6. **Verify, then mark.** Every inventoried version is checked to be reachable in history. Then `drama.json` is written, and the old version folders and `choices.json` are removed.
