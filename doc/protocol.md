# Pine Drama protocol, major version 1

Status: draft.

This protocol connects two sides:
- the **client**, the program on the person's machine that holds a drama's folder, shows it and records the person's choices;
- the **Computer side**, the program on a Pine Computer that makes the drama.

The Computer side also works with no client: driven by an agent, by another program, or from a terminal.

A drama's folder holds these files, and each has exactly one writer:

| Files | Writer | Changed later? |
|---|---|---|
| **Version folders** (2.1): one folder per version of anything made | Computer side | Never. A version is only added. |
| **Review files** (2.2): acceptances of versions | Computer side | Never. A review is only added. |
| **`choices.json`** (section 3): the decisions the person makes through a client. It is optional. | client | It is rewritten whole, by its one writer. |
| **Client files** (3.3): the person's own pictures and inputs, under `imports/` and `inputs/` | client | An import never changes. An input is replaced whole, by its one writer. |

A turn (section 4) sends the person's message and choices to a Computer. It brings back new version folders, new review files, the session's private state and a status snapshot. Nothing is merged and nothing is locked.

A client can be built in any language from this page and one schema file, [`protocol/v1/protocol.schema.json`](../extensions/pine-drama/protocol/v1/protocol.schema.json).
- **This page is normative.** The schema checks each document's shape: each document is one entry of the schema's `$defs`, named where the document is defined.
- **The schema is JSON Schema 2020-12.** Its patterns end with `(?![\s\S])`, which means the end of the string in every regex engine. Validators MUST turn on format assertion, so that `date-time` is checked.
- **Key words.** MUST, MUST NOT, SHOULD and MAY are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Conventions

| Type | Rule |
|---|---|
| Document | UTF-8 JSON with `"schema": 1`. |
| Path | A file or folder inside the drama's folder. It is project-relative, `/`-separated and in Unicode NFC. No segment is empty or starts with `.`. No segment contains `\` or a control character (U+0000–U+001F, U+007F–U+009F), is a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an extension), or ends with `.` or a space. The segment `reviews` is reserved for review files (2.2). There is no leading or trailing `/`, and a path is at most 240 characters. Two paths that differ only by case are the same path. |
| Object id | The path of the object's folder, chosen by the Computer side, for example `assets/characters/lin`. |
| Version id | One path segment, chosen by the Computer side. The version folder is `<object id>/<version id>`. A version that has a `version.json` has an id of lowercase letters then digits, for example `v3` or `t01`, and documents name only such versions. |
| Client id | An id the client chooses for a turn, an add or an import. It matches `^[A-Za-z0-9_-]{8,64}$`. The three kinds share one namespace: no id is used twice in a drama, whatever it names. |
| Time | An RFC 3339 `date-time` in UTC, whole seconds, with the `Z` suffix, for example `2026-11-12T10:00:00Z`. It must be a real date and time. |
| Hash | The lowercase hex SHA-256 of a file's bytes. |

**No absolute paths in protocol documents.** These documents carry no absolute path of either machine:
- the request and the return;
- `version.json`;
- review files;
- the configuration in `config/vN`.

The Computer side's own files inside a version folder are opaque to the client. They may hold paths of the Computer that made them, and the Computer side resolves those again when it restores the drama. Rewriting them would break the hashes the Computer side pins them by. Machine-specific configuration belongs to the Computer side, which rewrites it each time it restores the drama on a machine.

**Sessions and scopes.** A drama has one Project Chat and any number of other sessions. The person tells each session which episodes it works on, in words, and the client parses nothing.

**Scopes.**
- A turn of the Project Chat has scope `project`. It MUST add version folders only outside `episodes/`.
- A turn of any other session has scope `episodes`. It MUST add version folders only under `episodes/`, or under `assets/` as the next two rules allow.
- **An object new to the drama** is one the client does not know when it installs the return: no version folder of it is in the drama other than this return's own (so installing it again after a crash is safe), and no snapshot installed before this return lists it. An `episodes` turn may make such an object under `assets/`, with its versions and their review files. It names the object so that no other turn can name the same one, for example with a suffix derived from its turn id. Once installed, the object is shared like any other.
- **Inside an object made in an episodes turn.** An `episodes` turn may also add versions and review files inside an object an installed snapshot marks `episode_made` (5.1): in its folder and anywhere under it, in any later turn, as long as the turn's request holds a version of the asset it derives from (`variant_of`, 5.2) other than the marked object's own. The Project Chat may add there too; two sessions making the same version clash (4.4). An `episodes` turn adds to no other shared object, a planned one included.
- An add (3.1) belongs to `project`. A variant add belongs to the scope of its `from`'s path. An import belongs to the scope of its object's path.

**Rules for a session.**
- A session runs one turn at a time.
- It sends its next turn only after its previous return is resolved (4.4): installed, or refused by the client. Otherwise the next turn would start from a folder that lacks the previous versions, and could number a version again.
- If two sessions make the same version folder, the return installed second clashes and is refused whole (4.4).

## 2. What the Computer side adds

### 2.1 Version folders

A version folder holds the files of one version. Once returned, nothing in it changes, apart from additions to its `reviews/` subfolder (2.2).

The Computer side MUST NOT put lock files, records of a paid call still in progress, or scratch files in a returned version folder. A version is returned only once it is complete. Work in progress travels in the session's private state (4.3).

**A version is a folder with `version.json`** (`$defs/versionRecord`). The rest of the folder belongs to the Computer side and is not part of the protocol. A returned folder without `version.json`, such as one of the Computer side's own records, is not a version. It is stored and restored like one, but never shown.

| Field | Meaning |
|---|---|
| `made_at` | When it was finished. |
| `file` | The file it shows (image, video or text), relative to the version folder, or `null`. |
| `inputs` | The versions it was made from, each `{object, version}`. A reader may show only the direct ones: those no other listed input was made from in turn. |
| `prompt` | The prompt it was made with, or `null`. |
| `from_import` | The client id of the import it was made from, or `null`. |
| `continues` | Optional: the id of the version of the same object this one goes on from, as a bible written in ranges, each range written onto the one before, which may also correct what earlier ranges wrote and is not approved yet. A chain of versions linked by `continues` is one piece of work written in parts. Two versions may continue the same one (a range written again with notes): they are alternatives, not one chain. Absent when a version redoes, replaces or starts its object as a whole, and in records written before this field. |

A version is **the person's own** when its `from_import` is set.

### 2.2 Review files

An acceptance is a file of its own (`$defs/review`), at `<version folder>/reviews/<review id>.json`, so its version folder is its path without the last two segments, and its scope is that folder's. The review id matches `[A-Za-z0-9_-]{1,64}` and is unique within its version. `reason` and `person` are never blank:

```
{"schema": 1, "accepted_at": <time>, "reason": <text>, "person"?: <the person's words>}
```

- A review file is only ever added.
- It travels on its own (4.1), never inside the version's archive: an archive with a `reviews/` entry is refused. So a version's archive stays the same whatever reviews it gains later.
- An **agent's acceptance** has no `person`.
- A **person's acceptance** carries `person`, the person's own words, verbatim. It is written when the person tells the Computer side directly, for example through the agent or from a terminal, with no client in between.


## 3. The choices file (client)

### 3.1 Contents

`choices.json` (`$defs/choices`) sits at the root of the folder.
- **It is optional.** When there is no choices file, nothing is overridden: everything resolves from the version and review files alone (3.2).
- **Only the client writes it**, and always writes it whole: it writes a sibling temporary file, then renames it into place.
- **It is declarative.** It states what the person wants now, not a history of edits. A click is durable once the rename is done.

```
choices = { schema, objects: { <object id>: object_choice }, added: [ add ], imports: [ import ] }
```

| `object_choice` field | Meaning |
|---|---|
| `chosen` | The version the person chose: `{version: <version id>}`, or `{import: <client id>}` for an import that is not a version yet. It may carry `words`, the person's approval in their own words. |
| `discarded` | The versions the person deleted. Their files stay. |
| `prompt` | The person's prompt for the object's next draw. |
| `description` | The person's description of an asset or variant. |
| `removed` | `true` when the person removed the asset or variant. |

**An add** is `{id, type, name, description, from?, setting?}`. It is a new asset, or a variant of one, before the Computer side gives it an object id.
- `type` is `character`, `scene`, `prop` or `variant`.
- `from`, for a variant only, is the object id of the asset or variant it derives from. It is never an add that has no object yet.
- `setting`, for a scene, is `interior` or `exterior`.

**Editing an add.**
- Before any turn has carried it, the person edits the add in place, and removing it deletes the entry.
- While a turn that carries it runs, the add cannot be edited or removed; its card shows it in progress.
- Once a snapshot object has the add's id as its `from_add` (5.1), edits go to `objects` under that object's id, and `removed` removes it.


**An import** is `{id, object, file}`:
- `object` is the object it becomes a version of;
- `file` is the person's picture, `imports/<id>.<extension>` (3.3), named by the import's own id.


### 3.2 Resolution

The client derives each object's state by these rules. The Computer side applies `choices.json` at the start of each turn, by its own means. Right after applying it, its own current and accepted for each object MUST be the ones these rules give.

- **versions.** The object's version folders, ordered by `made_at`, then by version id: its letters compared as strings, then its digits compared as numbers (`v9` before `v10`).
- **No choice.** A `chosen` counts as no choice when any of these holds:
  - it names a discarded version;
  - it names a version the client does not have;
  - it names an import that no version has come from yet (until one does, the client MAY show the imported picture itself);
  - it lacks the `words` it needs (below);
  - it belongs to a `removed` object.

  The Computer side reports such a choice in `problems`.
- **current.** The chosen version. Otherwise, the newest version that is not discarded. Otherwise, none.
- **accepted.** Whichever of these comes first:
  1. the chosen version, as the person's acceptance;
  2. the newest version that is not discarded and has a review carrying `person`;
  3. the newest version that is not discarded and has any review;
  4. none.

  It is never simply the newest version. Otherwise a version nobody reviewed would count as accepted.
- **Who wins.** The person wins over the agent: `choices.json` first, then a review with the person's words, then the agent's review.
- **`words`.** Required in `chosen`, unless the version has a review or is the person's own (2.1). Otherwise a version nobody approved could be accepted without the person's words.
- **`prompt` and `description`.** They hold until the person changes or clears them, even when the agent writes newer text. Otherwise the agent's later text would silently replace the person's. An empty string is a value: the person emptied the text. A field that is absent means the person set nothing.
- **`removed`.** A removed object, and every variant derived from it, has no current and no accepted version, and is neither shown nor used. *Derived from* is transitive: it follows `variant_of` edges (5.2) and an add's `from`.
- **Imports.** An import named in `chosen` resolves to the version whose `from_import` is that import, once one exists.

### 3.3 Client files

The person's own files live under two folders, and only the client writes them:
- **`imports/`.** The client copies the person's picture, unchanged, to `imports/<client id>.<extension>`, then adds the import to the choices file. Pictures attached to notes (4.2) live here too. An import never changes.
- **`inputs/`.** The person's screenplay and brief. Each is replaced whole (written to a temporary file, then renamed).


## 4. The turn

### 4.1 Transport on Pine

**The message.** A turn is one message to a session on a Pine Computer.
- Its text begins with the line `pine-drama-turn <turn id>`, followed by the person's own words.
- The client sends it with Pine's idempotency key set to the turn id.
- The client writes `request.json` once and keeps its exact bytes. A retry sends the same message with the same key; the client never builds the request again.

**On Pine.** Pine's public documentation describes clients, keys, sessions, turns and the artifact store, with SDKs for TypeScript, Python, Ruby and Go that share one wire contract: [overview](https://console.pinecomputer.io/docs/overview), [sessions](https://console.pinecomputer.io/docs/sessions), [agent turns](https://console.pinecomputer.io/docs/agent), [artifacts](https://console.pinecomputer.io/docs/artifacts). For constructing a client, authentication, Computers and endpoints, see [getting started](https://console.pinecomputer.io/docs/getting-started) and [integration](https://console.pinecomputer.io/docs/integration). The Pine project key comes from [pinecomputer.io](https://pinecomputer.io). This protocol maps onto it as follows:
- **Sessions.**
  - Each of the drama's Chats is one Pine session. The client creates it with `artifact_access` `read_write`, which is fixed for the session's life.
  - The client keeps its own map from Chat to session, and records which session is the Project Chat.
  - A session ends when its Computer stops. The client then creates the drama's Chats again on a new Computer.
  - The agent's memory does not carry over; only the folder and `private_state` do.
- **Turns.** A turn is one agent run, with the idempotency key set to the turn id. Answering a `stopped` return is a new turn, a new run; it is never Pine's answer to a question.
- **The end of a turn.**
  - However the turn ends, the client reads `return.json`. If it exists, it wins: a `failed` return is never lost because Pine marks the turn failed or canceled.
  - Only a missing `return.json` is a run that did not return (4.5).
  - The Computer side ends its turn `completed` once it has written a return.
- **Artifact keys.** The keys below are paths in the Computer's artifact store.

**Storage.** These files live in the Computer's artifact store, and each is written once:
- `versions/<hash>.tar`: one version folder without its `reviews/`, as an uncompressed POSIX (ustar or pax) tar archive;
- `files/<hash>`: one review file or one client file;
- `state/<hash>.tar`: one session's private state;
- `turns/<turn id>/request.json` and `turns/<turn id>/return.json`, each by its one writer.

**Before a turn.** Each Computer has its own artifact store. Before sending a turn, the client lists the target Computer's store. For each archive and file that the request names and the store lacks:
1. it copies it inside Pine's storage, from a Computer it remembers holding that hash, so that large media never leaves Pine;
2. if there is no such Computer, or the copy fails, it uploads it from its own copy.

**What the client keeps.**
- **Archive hashes.** For every installed version folder, the hash of the archive it came from, recorded before the folder is renamed into place. The client sends that hash and never archives a folder again. A version folder, or a `config/<version id>` folder, found on disk with no archive, such as one made outside the client, is archived once, on its first use, and is then kept like an installed one.
- **Copies.** A copy of every archive and file it installed or sent, private state included, kept by hash.
- **A cache.** For each hash, one Computer that holds it. This only saves an upload: correctness never depends on it, because a Computer is disposable.
- **Pruning.** The client MAY delete a copy once no installed version and no pending request names it.

**Archives.**
- An archive holds only regular files and directories.
- Their names are relative to the version folder, with no leading `./`. They contain no `..`, are not absolute, and appear once.
- An archive with a link, a device, or a name outside the folder is invalid.
- A reader MUST check every archive and file against its hash before it uses it. An upload cut off midway can leave a partial file in a store. On a mismatch, the client uploads the file again.

### 4.2 Request (client → Computer side)

`$defs/request`, at `turns/<turn id>/request.json`.

| Field | Meaning |
|---|---|
| `turn` | The turn id. |
| `scope` | `project` for the Project Chat, `episodes` for any other session (section 1). |
| `choices` | The whole choices file, or `null` when there is none. |
| `versions` | Every version folder the client holds: `{<folder>: <hash of its archive>}`. |
| `reviews` | Every review file the client holds: `{<path>: <hash>}`. |
| `files` | Every client file (3.3): `{<path>: <hash>}`. |
| `private_state` | The hash of the session's private state from its last return, or `null`. |
| `notes` | The person's feedback for the agent. Each note is `{object, version?, text, file?, at?: {x, y}, time?}`, where `file` is a picture under `imports/`. `at` gives fractions 0–1 of the width and height, and `time` gives seconds into a video. A note decides nothing. |

Before any work, the Computer side does three things:
1. It restores exactly these folders, review files and client files, and the session's private state.
2. It applies the whole `choices` (3.2). Every scope reads every choice, because an episode uses the person's choices on shared assets too.
3. For imports and adds of the turn's scope (section 1), it turns each into a version or an object. It skips an import that some version names in `from_import`, and an add that some object has as its `from_add`, so sending the same choices again never repeats one.

A choice about an object outside the turn's scope is never an error. That object's own scope applies it.

### 4.3 Return (Computer side → client)

`$defs/return`, at `turns/<turn id>/return.json`.

**Exactly one return per turn.** If the agent asks the person something, the turn ends as `stopped`, and the person's answer is a new turn.

**`return.json` is written last.** The Computer side writes every archive and file a return names before it writes `return.json`. So a `return.json` that exists is complete.

| Field | Meaning |
|---|---|
| `turn` | The turn id. |
| `state` | One of:<br>`stopped`: the agent waits for the person.<br>`ended`: the work is done.<br>`failed`: the work broke off. The return carries what did finish, so no paid work is lost, and `error` says why.<br>`refused`: nothing was done; see `error`. |
| `versions` | The new version folders: `{<folder>: <hash of its archive>}`. |
| `reviews` | The new review files: `{<path>: <hash>}`. |
| `private_state` | The hash of the session's new private state. The client does not read it; it stores it and sends it back with the session's next turn. |
| `snapshot` | The status of the objects the turn covers (section 5). |
| `problems` | Choices the Computer side could not apply, each `{ref, error}`. `ref` is an object id, or the client id of an add or import. |
| `question` | When `stopped`: the agent's question. |
| `review` | When `stopped`: the versions the agent asks the person to choose, each `{object, version, reason}`. These are proposals and record no acceptance; they are not review files (2.2). |
| `error` | When `failed` or `refused`: why (section 6). |

**Which fields each state carries:**
- **`stopped`:** `versions`, `reviews`, `private_state`, `snapshot`, `problems`, `question`, `review`.
- **`ended`:** `versions`, `reviews`, `private_state`, `snapshot`, `problems`.
- **`failed`:** `versions`, `reviews`, `private_state`, `snapshot`, `problems`, `error`.
- **`refused`:** `error` only.

**What a return carries.** A return carries what the turn's work made, and what the imports and adds of its scope made. It does not carry what the Computer side made only to apply other choices, such as drama-cli's records of the person's selections or prompt edits. Those are made again from `choices.json` at every turn. Returning them would add versions to another scope's objects.

### 4.4 Installing a return (client)

The client installs one return at a time, finishing one before it starts the next, so two returns never pass their checks together. It installs every returned version folder and review file; nothing returned is left out. It works in two passes:
1. **Check everything first.** Before the first rename, the client fetches and checks every archive and file (4.1), and extracts each archive into a temporary sibling folder whose name starts with `.pine-install-` and is its own (two places in one folder can hold the same bytes), so that at start the client can find such folders and delete them. It compares paths without regard to case.
   - **Already there.** A folder that already exists with the same archive hash (the one the client keeps for it, 4.1) is skipped. So is a review file with the same hash.
   - **Refused whole.** The client refuses the whole return, installs nothing and shows `invalid` if anything:
     - lies outside the turn's scope (section 1);
     - fails a check;
     - names a folder or a review that already exists with another hash.

     For a folder that already exists, the message says that another session made that version meanwhile, and that the work can be run again.
   - **A refused return is resolved**, like an installed one: the session may send its next turn.
2. **Then rename into place:** version folders first, then review files.

The client then stores `private_state` for the session, and shows `problems`, `question` and `review`. Returns are ordered by when they were installed.

**The turn stays with the folder.** For every return it installs or refuses, the client writes `turns/<turn>.json` into the folder: the return's version folders, review files, `problems` and `snapshot` (null when there is none), when it was sent and installed, and the version folders and choices its request carried. Any client that opens the folder shows the drama from these files (5.3), whichever client sent the turns. The Computer side never reads or writes `turns/`, and a request does not carry it. The session's `private_state`, the person's messages and `notes` stay with the client that sent them. One client works in a folder at a time: a folder moves between machines whole, and is not shared while in use. A newer turn's `private_state` or `snapshot` is never replaced by an older one's: when the client installs a return again after a crash, it keeps whatever a later turn left.

**Versions made from a version deleted during the turn.** Suppose an input of a returned version (2.1) is a version the person deleted after the request was sent. The client then adds that returned version to `discarded` in `choices.json`, and does the same for every returned version made from it. The folders stay installed, so version numbering stays intact, and the person can bring them back.

**Repeating an install is safe.** A crash leaves only whole folders, and a second run skips them. The temporary folders are deleted after the renames, or at the next start. A downloaded progress archive (4.6) that no installed return names is deleted once its turn's return is installed.

### 4.5 A run that does not return

The Computer side handles a request in this order:
1. If `return.json` exists for the turn, it returns it again.
2. Otherwise, if it finds the turn marked `running`, the run was cut off. It runs nothing and refuses with `interrupted`, because paid work may already have been done.
3. Otherwise, it marks the turn `running` before any work.

A turn id that comes back with a different request is refused with `invalid`.

On the client: when a turn ends without a return (4.1), the client tells the person that the run may have spent money. Only the person decides whether to run the work again, as a new turn.

### 4.6 Progress while a turn runs (optional)

While a turn runs, the Computer side MAY announce each version as soon as it is finished, before the return. It does three things, in this order:
1. stores the version's archive at `versions/<hash>.tar`, the same archive the return will name (4.1);
2. writes the entry `turns/<turn id>/progress/<hash>.json`, keyed by that archive's hash, written once, never changed;
3. puts this in the entry (`$defs/progress`): `{"schema": 1, "object", "version", "file"}`, where `file` is the shown file, relative to the version folder.

The client MAY list `turns/<turn id>/progress/` while the turn runs. For each new entry, it downloads the archive by its hash, and MAY show the version at once, on its card, like any other version. When the return names the same archive, the client installs it from what it already downloaded (4.4). Nothing from an entry reaches the drama's folder before the return is installed.

## 5. The status snapshot

The snapshot (`$defs/snapshot`) carries only what the client cannot derive from version folders, review files and the choices file. Each return carries a snapshot of the objects its turn covers:

```
snapshot = { observed_at, objects: { <object id>: object }, edges: [ edge ] }
```

### 5.1 Objects

Which objects a snapshot lists:
- **A Project Chat turn:** every shared object and every episode object, so a new episode appears with the Project Chat's next return.
- **Any other turn:** the objects of the episodes it worked on, including each episode object, and each shared object it made or added to (section 1), with its edges.

A snapshot that lists an episode object lists all of that episode's objects. An object's episode follows from its id (`episodes/<id>/…`).

| Field | Meaning |
|---|---|
| `type` | `episode`, `screenplay`, `bible`, `character`, `scene`, `prop`, `variant`, `breakdown`, `storyboard`, `keyframe`, `video_prompts`, `take`, `cut` or `subtitles`, in pipeline order. |
| `name` | Its name for the person. |
| `segment` | Its segment within the episode, or `null`. |
| `usable` | Whether the next steps can use it now. |
| `why` | When `usable` is false: why, in words for the person. |
| `making` | `true` while a version of it is being made. |
| `prompt` | When the person may edit the prompt: the agent's text for the next draw. |
| `description` | When the person may edit the description: the agent's current text. |
| `inputs` | For an object with no version yet: the objects its first version will be made from. |
| `from_add` | The client id of the add it was created for, or `null`. |
| `episode_made` | `true` for a shared object made in an `episodes` turn, inside which later `episodes` turns may add (section 1). Absent otherwise. |

Objects with no version are the planned nodes, shown as empty cards. The client shows the person's `prompt` or `description` (3.1) when there is one, and the snapshot's otherwise.

### 5.2 Edges

An edge is `{"from", "to", "kind"}`. Its `from` is an object of this snapshot; its `to` may be listed only in another snapshot. An edge goes with its `from` object.

| `kind` | Meaning |
|---|---|
| `variant_of` | `from` is a variant derived from `to`. |
| `inside_of` | The scene `from` lies inside the scene `to`. |
| `appears_in` | The asset `from` appears in the episode `to`. |
| `needs` | The episode `from` needs `to` before it can be shot. |

Lines between versions come from `version.json` `inputs`, not from edges.

### 5.3 What the client shows

The client shows each object, and the edges from it, from the snapshot installed last of those that list it, whichever session returned it. An object has been removed when it is missing from a later snapshot that should list it:
- for a shared object or an episode object, the Project Chat's snapshot;
- for an episode's object, a snapshot that lists its episode.

A snapshot removes only objects the client knew when it sent that turn's request: an object that appeared after the request was sent is never removed by its snapshot.

`usable`, `why`, `making` and the edges are as of the return that last listed the object. For example, a new picture of a shared asset reaches an episode's `usable` only with the next return that lists that episode. Each object is shown with its snapshot's `observed_at`.

Versions, reviews, current, accepted and the person's text are derived from the files and `choices.json`, so they are always current.

## 6. Errors and versions

An error is `{"code", "message", "action"?}`:
- `message` is for the person;
- the optional `action` is a sentence telling them what to do.

| `code` | When |
|---|---|
| `not_found` | A choice names an object or version that does not exist. |
| `not_allowed` | A choice breaks a rule of 3.2. |
| `invalid` | A document or archive does not match this specification (an unknown enum value included), a returned folder clashes with an existing one, or a turn id comes back with a different request. |
| `missing_input` | An archive or file that the request names is not in this Computer's store. |
| `interrupted` | An earlier run of this turn was cut off and may have spent money. Nothing is run again (4.5). |
| `failed` | The work broke off. A `failed` return carries what did finish (4.3). |
| `unsupported_schema` | A document's `schema` is a major the reader does not support. The message names the majors it supports. |

**Which codes go where:**
- a `problems` entry carries `not_found`, `not_allowed` or `invalid`;
- a `failed` return carries `failed`;
- a `refused` return carries `invalid`, `missing_input`, `interrupted` or `unsupported_schema`.

### 6.1 Versioning

- **Within major 1.** Fields are only ever added, and every added field is optional. Readers ignore fields they do not know, and enum values are as listed on this page.
- **Any other major.** A document of any other major is refused whole with `unsupported_schema`. The Computer side answers with a `refused` return, and the client installs nothing.

**What the schema cannot check.** The schema checks each document alone. Implementations check these rules, which span documents:
- that objects, versions and imports exist;
- that paths are NFC, avoid reserved names, and differ by more than case (two keys of one map that differ only by case are refused);
- that an import's file is named by the import's own id;
- that a version folder belongs to the turn's scope;
- that hashes match their bytes;
- that archives hold only what 4.1 allows.

## 7. A complete round trip

Each JSON block is valid against the `$defs` entry named in its heading, and the request is valid once its `choices` is filled in. The hashes are placeholders.

**`choices` before the turn.** The person has chosen Lin's `v2` with their words, imported a photo of the office, and added an umbrella prop:

```json
{
  "schema": 1,
  "objects": {
    "assets/characters/lin": {"chosen": {"version": "v2", "words": "Yes, this coat is right."}},
    "assets/scenes/office": {"chosen": {"import": "imp-0001-office"}}
  },
  "added": [{"id": "add-0001-umbrella", "type": "prop", "name": "Umbrella", "description": "A black umbrella with a bent rib."}],
  "imports": [{"id": "imp-0001-office", "object": "assets/scenes/office", "file": "imports/imp-0001-office.jpg"}]
}
```

**`request`.** Its `choices` is the document above. The office photo is a client file.

```
{
  "schema": 1, "turn": "turn-20261112-0001", "scope": "project",
  "choices": <the choices document above>,
  "versions": {"assets/characters/lin/v1": "1111111111111111111111111111111111111111111111111111111111111111",
               "assets/characters/lin/v2": "2222222222222222222222222222222222222222222222222222222222222222"},
  "reviews": {"assets/characters/lin/v1/reviews/review-1a2b3c.json": "6666666666666666666666666666666666666666666666666666666666666666"},
  "files": {"imports/imp-0001-office.jpg": "7777777777777777777777777777777777777777777777777777777777777777",
            "inputs/screenplay.md": "8888888888888888888888888888888888888888888888888888888888888888"},
  "private_state": null,
  "notes": []
}
```

**`return`.** The Computer side turned the import into `office/v1`, created and drew the umbrella, and asks the person to choose:

```json
{
  "schema": 1, "turn": "turn-20261112-0001", "state": "stopped",
  "versions": {"assets/scenes/office/v1": "3333333333333333333333333333333333333333333333333333333333333333",
               "assets/props/umbrella/v1": "4444444444444444444444444444444444444444444444444444444444444444"},
  "reviews": {},
  "private_state": "5555555555555555555555555555555555555555555555555555555555555555",
  "snapshot": {
    "observed_at": "2026-11-12T10:06:00Z",
    "objects": {
      "assets/characters/lin": {"type": "character", "name": "Lin", "segment": null, "usable": true, "prompt": "Lin, 30, grey wool coat", "description": "A reporter, calm under pressure.", "from_add": null},
      "assets/scenes/office": {"type": "scene", "name": "Office", "segment": null, "usable": true, "prompt": "", "description": "An open-plan newsroom.", "from_add": null},
      "assets/props/umbrella": {"type": "prop", "name": "Umbrella", "segment": null, "usable": false, "why": "The umbrella's picture waits for your choice.", "prompt": "A black umbrella with a bent rib, studio light", "description": "A black umbrella with a bent rib.", "from_add": "add-0001-umbrella"}
    },
    "edges": []
  },
  "problems": [],
  "question": "Is this umbrella right?",
  "review": [{"object": "assets/props/umbrella", "version": "v1", "reason": "Matches the description: black, one bent rib."}]
}
```

**`versionRecord`** of `assets/props/umbrella/v1`:

```json
{"schema": 1, "made_at": "2026-11-12T10:05:40Z", "file": "image-1.png", "inputs": [], "prompt": "A black umbrella with a bent rib, studio light", "from_import": null}
```

**After the return:**
- The client installs both folders (4.4).
- The office resolves to `v1`, whose `from_import` is `imp-0001-office`. That makes it the person's own picture.
- The add has its object, `assets/props/umbrella`, whose `from_add` names it. Later edits go under that id, and the next turn does not add it again.
- The person's next decision is written to `choices.json` at once: `"assets/props/umbrella": {"chosen": {"version": "v1", "words": "Good."}}`.
  - `words` is required, because `v1` has no review and is not the person's own.
  - The Project Chat's next turn carries the decision.
