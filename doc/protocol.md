# Pine Drama protocol, major version 2

Status: draft. Major 2 replaces major 1 whole: a reader of one major reads no drama of the other (section 6).

This protocol connects two sides, the way Codex runs a task:
- the **client**, the program the person uses: a desktop app holding the drama's folder, or a web service holding it on its server. It shows the drama and lets the person change any file of it, as with a local coding agent;
- the **Computer side**, Pine Computer's agent and the tools it runs, which make the drama. Before each turn the client puts the drama's files onto the Computer, and after it the client takes back every file the turn changed and applies them, as Codex's cloud harness does (section 4).

The Computer side also works with no client: driven by Pine Computer's own agent, by another program, or from a terminal.

**The client keeps every file of the drama and its complete history** (section 2). A git repository is the reference implementation.
- **One current file per object.** Each object has one current copy of each of its files, and history keeps every earlier one.
- **No version numbers, no choices file, no acceptance state, no scopes.**
- **Any number of sessions** may work on one drama at once. The newest result lands, and history keeps every earlier one (4.3).

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
| Turn id | Pine's id of a turn. |
| Paid call id | An id the Computer side chooses for one paid call, unique in the drama, matching `^[A-Za-z0-9_-]{8,64}$`. |
| Time | An RFC 3339 `date-time` in UTC, whole seconds, with the `Z` suffix, for example `2026-11-15T10:00:00Z`. |
| Hash | The lowercase hex SHA-256 of a file's bytes. Git's own object ids never appear in a document. |

## 2. The drama's files (client)

### 2.1 The project's files and history

**What every client MUST keep.** These are properties; any storage that has them will do.
- **Files, byte for byte.** Every file of the drama, exactly as written, with no line-ending, encoding or other conversion.
- **A complete history.** Every earlier content of every file, with who changed it: `pine-computer` (a turn's files, applied after it, 4.3), `person` (the person's own change), or `client-found-changes-on-disk` (what a folder client finds on disk that no record holds, 3).
- **Applied once.** A turn's files are applied at most once, and the record that they were is durable.
- **Atomic changes.** A change's files are written and recorded together. A reader never sees half of one.
- **Restore and undo.** Any earlier result's files can be brought back (5), and a turn's change can be undone as a whole.

**The reference implementation is a git repository in the drama's folder**, which Pine Drama Studio uses:
- each change is a commit of exactly its paths (`git commit --only -- <paths>`), authored as above;
- a turn's change carries the trailer `Pine-Turn-Id: <turn id>`, which is its applied record;
- the byte rule is `* -text -filter -ident -working-tree-encoding` in the repository's `info/attributes`, which takes precedence over any `.gitattributes` ([gitattributes](https://git-scm.com/docs/gitattributes)), and nothing of the client's own goes into the folder itself;
- history is `git log` of a path, and undoing a turn is a revert of the commit carrying its `Pine-Turn-Id`.

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
| `relations` | Other relations, each `{kind, to}`: `inside_of` (a scene inside a scene), `appears_in` (an asset in an episode). |
| `objects_sent_by_draw_request` | The object ids this object's draw request sends, in the order it sends them (`Image 1`…`Image N`), or absent for an object that is not drawn from others. Every object drawn from others has it, whatever its type (a storyboard, a keyframe, a take, a cut, and any drawn kind added later), under this one rule. Pine Computer writes it only when a turn plans that object: never as a side effect of another object changing, and never when it reads. The person may add to, remove from or reorder it on any object, drawn or not, and it then stays as they set it until they, or a turn that plans that object again, change it. The draw builds its request from this list and nothing else, so what is drawn and what the canvas shows cannot differ. |

- **One source for lines.** Every line the client draws between objects comes from `objects_sent_by_draw_request` (plus `variant_of` and `relations`), for a drawn object and an undrawn one alike. A receipt's `inputs_sent_in_order` is the record of what a past draw sent, shown with that result; it is never read for lines.
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
- **References that no longer resolve.** A listed object may be deleted later, and a reference may point back at its own object, directly or through others. Both are allowed in the data. A draw sends the shown files of the listed objects that exist, in order, and Pine Computer tells the person each one it could not send (4.4). It refuses nothing. A draw sends files, not a graph, so a cycle sends each file once, as listed.
- **Who creates objects.** Either side may create an object. The client creates one when the person adds it, with `object.json` and the person's `description.md`. drama-cli derives every name a model reads from `name`, never from the id.
- **The person's text.** In an object's folder, `description.md` and `prompt.md`, when present, are the text the person and Pine Computer edit. Whoever writes last wins, and git keeps the earlier text.
- **Removal.** Removing an object deletes its folder; a variant is a folder below its asset's, so it goes with it.

### 2.3 Receipts

Each output of a paid call has a receipt beside it, **`<file>.receipt.json`** (`$defs/receipt`). It is written before the output, and always applied together with it (4.3):

| Field | Meaning |
|---|---|
| `paid_call_id` | The paid call that made it (2.4). |
| `finished_at` | When the output was finished. |
| `inputs_sent_in_order` | The record of what this call sent, for money and history (never for lines, 2.2): the files the call was sent, in the order it was given them (`Image 1`…`Image N`), each `{path, sha256}` as it was then. Their bytes are in the drama's history when the file was in the drama before the turn or at its end (4.3). An input that the same turn made and then replaced is recorded by its hash alone. |
| `prompt_sent` | The prompt the call was sent, or `null`. |
| `cost` | `{usd, reported_by}`, for example `"reported_by": "pine"`, or `null` when unknown. |

The rest of the receipt (the request and response as sent) belongs to the Computer side. A client MAY show it, and decides nothing from it. It holds no copy of the output's bytes (a provider's base64 image is left out): the output is the file beside it.

- **One receipt per output.** A call with several outputs (a take's video and its last frame) has a receipt beside each.
- **No paid call, no receipt.** A file made without a paid call (a cut, an overlay, a conversion) has none.

### 2.4 Pine Computer's records

Pine Computer keeps its own records of the drama in **`pine-computer-records/`**, as ordinary files that travel both ways like any other (4.3). They hold the **ledger** of paid calls (drama-cli's `ledger.py`): each call's reservation, generation lock, attempt identity, request as sent and provider reference. A later turn, on any Computer, so settles a call an earlier one started, and never sends again a call whose outcome it could not learn. A client MAY show these files, decides nothing from them, and the person does not edit them. A record, like a receipt (2.3), holds no copy of an output's bytes.

## 3. The person's changes (client)

- **The person changes any file of the drama.** Each edit is a plain write of exactly the files it changes, through the client's one write queue, recorded as a `person` change (2.1). There is one path per edit:
  - an `object.json` field (`objects_sent_by_draw_request`, `relations`, `variant_of`, `name`);
  - adding an object, which writes its folder with `object.json` and `description.md`;
  - removing an object, which deletes its folder;
  - `description.md` or `prompt.md`;
  - the person's own picture or video, below.
- **Canvas positions** and every other view state are the client's own, per person or per profile, and are never written into the drama.
- **Hand changes** (a folder client): a file changed outside the client is recorded as `client-found-changes-on-disk` at the next opening or before the next turn (4.3).
- **Using the person's own picture or video for an object.** The person's file replaces the object's shown file. It is written under the shown file's name, with the extension of the person's file, and `object.json` `shown_file` is set to it. If the extension changed, the old shown file and its receipt are deleted in the same commit. The person's file has no receipt, since no paid call made it. History keeps what it replaced.
- **Files the person attaches** to a chat message, and are not an object's file, are written to `person-attachments/<id>.<extension>` and recorded as a `person` change. The message names each by its path.
- **A running turn** sees the person's change only from the next turn on (4.3). A person's edit made while a turn runs is replaced only if that turn changes the same file; it stays in the file's history, one restore away (4.3).

## 4. The turn

The client is the turn's harness, as Codex's cloud harness is: it puts the drama's files onto the Pine Computer before a turn and takes back every file the turn changed after it. Pine Computer's agent works on the files and needs to run nothing of this protocol.

### 4.1 The session

- **The message.** A turn is one message to a session on a Pine Computer: the person's words. The client sends it with Pine's idempotency key, so a resend never runs a turn twice ([agent turns](https://console.pinecomputer.io/docs/agent)).
- **The drama on the Computer** is the folder `drama/` in the session's working directory. The shell keeps the directory the agent's last command left it in, so the client learns the working directory's absolute path with its first `exec` in a new session, before any turn, and gives it as the `cwd` of every later `exec`.
- **One turn at a time.** A session sends its next turn only after its previous turn has ended on Pine and its files are applied (4.3).
- **Any number of sessions** may work on one drama, and none owns an object. Each session has its own working directory, so a new session starts with a full `put`.
- **Pine's shell.** The client runs its operations with Pine's `exec` ([files and shell](https://console.pinecomputer.io/docs/files-and-shell)), which the project must have. Each command runs in a subshell, so it leaves the session's directory and environment as they were for the agent.

### 4.2 Three operations (client)

| Operation | What the client does |
|---|---|
| `list` | One `exec` that prints the hash and path of every file under `drama/` whose path is a path (section 1): a name starting with `.`, such as a lock or a temporary file, is left out. |
| `put(paths)` | Writes those files' bytes as a tar, in parts of at most 64 MiB, with Pine's `write_file` (into `attachments/`). Then one `exec` extracts the tar into `drama/`, deletes its parts, and deletes every path under `drama/` that the client does not hold. |
| `get(paths)` | One `exec` writes a tar of those files outside `drama/`. The client reads it with Pine's `read_file`, then deletes it. |

Bytes travel only as files: `exec` output is text.

### 4.3 A turn

1. **Before.** A folder client first records what the folder holds that no record does, as `client-found-changes-on-disk`. Then: `list`, and `put` every path whose hash differs from the client's, along with the deletions. Then `list` again, kept as the turn's `before`. That listing is the check that the Computer holds exactly the client's files.
2. **The turn.** The client sends the message (4.1).
3. **After.** Once Pine reports the turn ended, however it ended: `list` as `after`. The client applies every path whose hash in `after` differs from `before`, or that is new: it does a `get`, writes the files, and deletes every path of `before` missing from `after`. Then it records all of them as one `pine-computer` change with the trailer `Pine-Turn-Id` (2.1). Applying a turn again is a no-op.

- **An ended turn is always applied before the next put.** The client keeps a turn's `before` until the turn's change is recorded. A session's next turn, or the drama's next opening, first applies any ended turn that has no change yet. A `put` deletes what the client does not hold, so it would otherwise delete that turn's results and Pine Computer's records (2.4).
- **The newest result lands.** There is no check against what a file held before, and no refusal: whatever is applied last is the file's current content, and its history keeps every earlier one. The same rule covers a reroll, two sessions writing one file, and a turn writing over a person's edit. A turn's files are applied as they are at its end, so a file the turn wrote twice is in history once, as it ended. "Use" (5) brings any earlier one back.
- **Only on the Computer until applied.** A turn's files exist on the Computer alone until the client applies them. If the Computer stops first (an idle timeout, for example), they are lost with the session's files ([limits](https://console.pinecomputer.io/docs/limits)).

### 4.4 How a turn ends

A turn ends as Pine reports it ([agent turns](https://console.pinecomputer.io/docs/agent)), and its files are applied (4.3) whichever way it ended:

| Pine's turn | What the client shows |
|---|---|
| `needs_input` | Pine Computer asks the person something: the question is the turn result's `summary`. This is one of the five stops of the drama workflow. The person's answer is the approval of the next paid work, given before it, as a coding agent asks before it acts (Codex's AskForApproval). There is no acceptance after the fact. |
| `completed` | The work is done. |
| `canceled` | The person stopped it. |
| `failed` | The work broke off. The turn result's `terminalReason` (for example `timeout`, `budget`, `error`, `coordinator_restarted`) says why. |

- **What Pine Computer could not do** it says to the person in its answer.
- **The turn's own cost** is the one Pine reports for the turn (its turn result's `usage.cost`, `{total, currency}`). Receipts carry only the paid calls' costs (2.3).
- **Stop.** The client cancels the Pine turn, and Pine Computer sends no new paid call. A run cut off midway (Stop, the Computer lost, a timeout) runs nothing paid again by itself: Pine never reruns a turn, and the ledger never sends a call again whose outcome it could not learn (2.4).

## 5. What the client shows

- **The cards** show what the client holds: each object's `object.json`, its `shown_file` and its receipts. A file's history is every earlier content of it (2.1; in git, `git log` of the path).
- **"Use" on a past result** restores the files that result's change wrote inside the object's own folder, receipts with them, as a `person` change. That is the change's commit in git; for a turn's change, the commit carrying its `Pine-Turn-Id`. Files of a variant or any other object folded inside it are not included, since each is an object of its own. Files the same change wrote for other objects stay as they are. The rule is the same whoever made the change: a turn, the person, or `client-found-changes-on-disk`, which may hold the whole project. The restored result's file is the shown one again: `object.json` `shown_file` names it, and a current shown file of another name is deleted with its receipt in the same change, as for the person's own picture (3). An output's siblings and receipts live in its object's folder, so an output never sits beside another result's sibling or receipt.

## 6. Majors and upgrades

- **One major per reader.** A reader reads only its own major, and a drama whose `pine-drama-project.json` is of another major is never written. A major is the format itself: read by rules it does not follow, a drama could get wrong data written into it. Git likewise refuses a repository whose format version it does not understand ([gitrepository-layout](https://git-scm.com/docs/gitrepository-layout)).
  - An older drama: the client offers to convert it (section 7).
  - A newer drama: the client says which newer version of itself is needed, and where to download it when there is a download.
  - Pine Computer's tools refuse a drama of a major they do not read, and its agent tells the person.
- **Releases.** A new major ships the client and Pine Computer's tools on the same day.

## 7. Converting a major-1 drama (client)

The conversion is the client's alone. Its working records are its own, and only its outcome is normative.

1. **Freeze.** No turn is sent and no person change is written. While a major-1 turn has no return yet, the conversion refuses. It says that nothing was changed, and asks the person to finish or stop that turn in the previous client, with a link to its download. While a major-1 paid call is not settled (the table's `paid_call_settled`), it refuses the same way, before any run's first write, a run resumed after a cut-off included, naming the versions that hold one, and asks the person to open the drama once in the previous client, which settles them: the old version folders go in step 6, and with them the only record of a call still owed by its provider or of unknown outcome. No major-1 installer is kept for these cases.
2. **Back up.** The folder is copied beside itself as `<name>.backup-<YYYY-MM-DD>`, by clonefile where the file system has it, otherwise as a plain copy. Going back to the older client stays possible.
3. **Inventory.** Every major-1 version folder on disk goes in: those of installed turns, adopted ones, takes and discarded versions. The client records them with their hashes before it changes anything, so a cut-off conversion resumes from it.
4. **History.** The client applies [`protocol/v2/major1-to-major2-conversion.json`](../extensions/pine-drama/protocol/v2/major1-to-major2-conversion.json), normative data. In one order across all objects (oldest first), each old version that changes a file makes one commit writing its files to their major-2 paths, with receipts, as `client-found-changes-on-disk`. A version that changes nothing makes no commit: its bytes are already in history. So `git log` of a file lists every old version, discarded ones included. The table is the only place that knows major 1's record formats: the client reads it, never a format of its own.
5. **Current.** A last commit sets each object's files to its major-1 *current* (major 1's 3.2), deletes removed objects, and writes the person's pending text, as the table's `current` says.
6. **Verify, then mark.** The bytes of every inventoried version are checked to be reachable in history. Then `pine-drama-project.json` is written, and the old version folders and `choices.json` are removed.
