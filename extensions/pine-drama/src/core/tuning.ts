// The Studio's own chosen numbers, in one place: how long it waits and how often it looks, how much it takes at once,
// and where the canvases put their cards. Each is the Studio's choice, not a fact of another system (those stay
// where they are used, with their source) and not a contract between parts (those are in the protocol files). No
// import: the webview bundles read this file too.

// ---- Timing ----

/** How long one wait for a turn's end lasts before the generation is checked and the wait repeats (chats.ts). Longer: a Stop or a restart of the Computer is noticed later; shorter: more calls to Pine while a turn runs. */
export const TURN_WAIT_MS = 10_000;

/** The event stream's time to deliver what it has left once a turn has ended (since M0). Shorter can drop a turn's last activity lines; longer delays every turn's ending by as much. */
export const TURN_END_GRACE_MS = 500;

/**
 * How often a running turn's files are collected into the project folder (turn.ts collectTurn). Each collection is one
 * exec, which Pine runs beside the agent's own commands and counts as the Computer's activity (PineSandbox
 * session-coordinator pkg/server/exec.go:85). Shorter: results land sooner and the agent shares its Computer more;
 * longer: the person waits longer to see a finished file.
 */
export const COLLECT_EVERY_MS = 15_000;

/**
 * A follower that lost Pine tries again after these pauses, the last one repeating: VS Code's own reconnection schedule
 * for a lost remote, in seconds [0, 5, 5, 10, 10, 10, 10, 10, 30] (src/vs/platform/remote/common/remoteAgentConnection.ts:660
 * at the pinned 235ceeb5). Changing it changes how soon a dropped connection is retried and how often Pine is called meanwhile.
 */
export const RECONNECT_WAITS_MS = [0, 5, 5, 10, 10, 10, 10, 10, 30].map(seconds => seconds * 1000);

/** How long a follower keeps trying: VS Code's ReconnectionGraceTime, 3 hours (src/vs/base/parts/ipc/common/ipc.net.ts:304). After it, the turn is left to the next start of the window. */
export const RECONNECT_LIMIT_MS = 3 * 60 * 60 * 1000;

/**
 * The Computer's idle timeouts (open-pinedrama docs/PROPOSAL.md section 5.3, src/engine/config.ts). Work keeps a
 * Computer running; a question waiting for the person does not, so a waiting Computer gets longer. Longer: a Computer
 * forgotten costs more; shorter: a person who takes their time finds the Computer stopped and its session gone.
 */
export const IDLE_WORKING_SECONDS = 60 * 60;
export const IDLE_WAITING_SECONDS = 3 * 60 * 60;

/**
 * How long a start waits for Pine to give the Computer (the SDK's `readyTimeoutMs`, passed rather than assumed; its
 * default is the same 300 000 ms). Pine waits for capacity meanwhile when it has none free (PineSandbox
 * specs/computer-api.yaml; lines 663-666; S1). Shorter refuses a start Pine would have served; the person reads it as minutes.
 */
export const START_WAIT_SECONDS = 5 * 60;

/** How long Connect waits for Pine to answer the key check before saying it could not. Longer leaves the person under a progress notification; shorter fails a slow but working network. */
export const KEY_CHECK_LIMIT_MS = 15_000;

/** After this long with no message, the episode canvas says nothing has come (canvasWait.ts). The canvas counts up to it on screen. */
export const CANVAS_WAIT_LIMIT_SECONDS = 120;

/** How long a burst of file events settles before the folders are looked at again for a project: git's debounce. Shorter scans more during a big copy; longer opens a new project later. */
export const PROJECT_RESCAN_MS = 500;

/** How long after the last change of the folder's files the tree, the galleries and the canvases are read again (Code-OSS's FileSystemWatcher). Shorter reads more often while a turn lands many files; longer shows them later. */
export const FOLDER_REFRESH_MS = 1000;

/** How long a request to reveal a project's Chat in a window that is opening for it stays good; older, the window opens without revealing it. */
export const CHAT_REVEAL_MAX_AGE_MS = 60_000;

/** SQLite's busy_timeout for the Studio's own database, shared by the windows of one profile: how long a write waits for another window's before it fails. */
export const STORE_BUSY_TIMEOUT_MS = 5000;

// ---- Limits ----

/** Paths per git call when many are staged or listed at once, so that no command line is too long (projectHistory.ts). Larger risks the system's argument limit; smaller makes more git calls. */
export const GIT_PATHS_PER_CALL = 200;

/** The most of a webview's failure message the extension keeps for its log. */
export const FAILED_MESSAGE_MAX = 2000;

/** The most text textutil may print for one attached .doc or .rtf before the read fails (execFile maxBuffer). */
export const EXTRACTED_TEXT_MAX_BYTES = 64 * 1024 * 1024;

/** The most of its first message's first line a Chat's label keeps (its name where Chats are listed). */
export const CHAT_LABEL_MAX = 80;

// ---- Canvas layout ----
// The canvases' pixels are the Studio's: a card is as tall as its own picture at a fixed width, and a row as tall as
// its tallest card (as open-pinedrama does). Card width, gap, group padding and group title started as drama-cli's
// export.py WIDTH, GAP, PAD and TITLE; nothing reads one side's positions on the other, so they need not stay equal.
// Changing any of them moves every board that the person has not arranged; an arranged board keeps its places.

/** A card's fixed width; its picture is scaled to it. */
export const CARD_WIDTH = 300;

/** The picture's size a card is drawn at until the file's own size is known. */
export const UNKNOWN_PICTURE = { w: 300, h: 290 } as const;

/** A card's footer under its picture, the same on both canvases: its name, then its state, sized to be read zoomed out (canvas.css .foot). */
export const CARD_FOOTER_HEIGHT = 84;

/** The gap between two cards, between two groups of a board, and between the assets canvas's regions. */
export const CARD_GAP = 60;

/** A group frame's inner margin around its cards, the canvas's (canvas.tsx nodesFor) and the layout's alike. */
export const GROUP_PAD = 20;

/** The height of a group frame's title bar above its cards. */
export const GROUP_TITLE_HEIGHT = 50;

/** Cards to a row in an episode's segment groups. */
export const SEGMENT_COLUMNS = 4;

/** The height of a region's heading on the assets canvas: characters, scenes, props. */
export const ASSET_HEADING_HEIGHT = 70;

/** The gap between two groups on the assets canvas. */
export const ASSET_GROUP_GAP = 24;

/** The opening zoom's floor and cap (section 2c; 2026-11-10: 25 %): a board that fits only below the floor opens at it, at its corner; none opens above the cap. */
export const OPENING_ZOOM = { floor: 0.25, cap: 0.55 } as const;

/** The pane's margin around a fitted board. */
export const FIT_MARGIN = 40;

/** Where in the pane a board too large to fit opens its top-left corner (as before 2c). */
export const UNFITTED_CORNER = { x: 40, y: 56 } as const;
