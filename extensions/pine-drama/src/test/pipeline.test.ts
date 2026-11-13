import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BUDGET, EPISODE_SESSION, LOCAL_REVIEW, STANDING_INSTRUCTIONS, STANDING_PARAGRAPH, UNKNOWN_CALL, standingParagraph, withStandingInstructions } from '../core/instructions';

// The Studio's standing instructions. Each rule is pinned by the words that carry it,
// so a rewrite that drops a rule fails here. How the driver works between the person's stops is the skill's
// ("Start or resume"): the Studio says only what the skill cannot know.

test('the standing paragraph: the budget, the unknown call and local review; the person\'s text still comes first and unchanged', () => {
	assert.deepEqual(STANDING_INSTRUCTIONS, [BUDGET, UNKNOWN_CALL, LOCAL_REVIEW], 'the local approval ownership contract is explicit; task transport remains separate');
	assert.match(LOCAL_REVIEW, /^My approvals of a version reach you in the task's choices, which drama-cli applies before you start\./);
	assert.match(LOCAL_REVIEW, /Keep doing the driver-owned acceptances/);
	assert.match(LOCAL_REVIEW, /never run accept --person/);
	// The rule is about a version, which the Studio's review records; the person's words on a continuity check are accepted
	// with no version, and the skill has the agent record them (its third stop).
	assert.match(LOCAL_REVIEW, /never run accept --person on a version \(vN or tNN\)/);
	assert.match(LOCAL_REVIEW, /my words on a continuity check, which accept takes with no version, you record as the skill says/);
	// One rule with the skill's five stops: a file the person accepts keeps its review targets; a canvas go accepts none.
	assert.match(LOCAL_REVIEW, /Ask me to approve a file that is mine to accept, such as a take or a photoreal storyboard I asked for, through the task's review, never by reading a Chat reply as approval; my go at a canvas stop approves no file\./);
	assert.equal(withStandingInstructions('make a drama'), `make a drama\n\n${STANDING_PARAGRAPH}`);
});

test('the intake, the stops and going on between them are the skill\'s, never restated here (design rule 10, D70)', () => {
	// The skill's "Start or resume" and "The person's five stops" state them; a second copy drifts.
	assert.doesNotMatch(STANDING_PARAGRAPH, /numbered choices|Language: |five stops|generate all|drama-cli status|progress\.md/);
});

// The person runs no budget; on Pine the skill sets a new project's
// budget_usd to null. The instruction is the delegation, with no amount of its own.
test('the budget: no cap, no question about cost, a refusal for a number the person set is told', () => {
	assert.match(BUDGET, /^Spending needs no cap: make every paid call without asking me about cost/);
	assert.ok(BUDGET.includes('drama/drama-cli.cfg.yaml') && BUDGET.includes('is null') && BUDGET.includes('stop and tell me'));
	assert.doesNotMatch(BUDGET, /1000|USD/, 'no amount of the Studio\'s own');
});

// A reported case: with a paid call still unknown after gen get, the agent asked the creator to
// contact tech support and would not --retry even when told. The rule, stated once and carried by the standing text and
// by every held-result note: the go that covered the call covers its --retry, a refusal said plainly, never support.
// No second question (rank 19): the person's go already authorized the call.
test('a paid call gen get leaves unknown: --retry under the go that covered it, never support (#276)', () => {
	assert.match(UNKNOWN_CALL, /^If drama-cli gen get leaves a paid call unknown/);
	assert.match(UNKNOWN_CALL, /or says the call belongs to another Pine session \(then it can never be checked\), say so plainly; the go that covered the call covers making it again, so run the command that made it again with --retry/, 'a call of a session that is gone is not "check first" (live run, 2026-11-06)');
	assert.doesNotMatch(UNKNOWN_CALL, /yes\/no|On yes/);
	assert.match(UNKNOWN_CALL, /never made twice, and a new one is made only when the earlier one can never be settled; an image whose answer was saved is finished from it instead/);
	// How a saved text reply is recovered is the skill's; restating it here went stale with v0.7.70 and could
	// replay paid work.
	assert.doesNotMatch(UNKNOWN_CALL, /saved text reply|text call's reply|stays unpublished/);
	assert.match(UNKNOWN_CALL, /If that command has no --retry, or drama-cli refuses it, do what the refusal's action says, or tell the person in one line what stays held and why/);
	assert.match(UNKNOWN_CALL, /Never ask the person to contact support or to look up a request\.$/);
	// A general rule: no request id, stage, picture or screenplay item of any case (no case examples in prompts).
	assert.doesNotMatch(UNKNOWN_CALL, /[0-9a-f]{8,}|seg\d|EP\d|blocking|storyboard|\u6280\u672f\u652f\u6301/);
	assert.ok(STANDING_PARAGRAPH.includes(UNKNOWN_CALL), 'a new session has it from its first run');
});

// No scope rule of the Studio's own: an episode session is told only
// that it is one; what that means (its progress file) is the skill's, and no drama-needs block is asked for.
test('an episode session is told it is one, and the skill says what that means', () => {
	assert.equal(EPISODE_SESSION, "This is an episode's conversation, not the project's: the drama-workflow skill says what that means.");
	assert.ok(standingParagraph(true).endsWith(EPISODE_SESSION), 'a session\'s first run carries it');
	assert.doesNotMatch(standingParagraph(true), /drama-needs|progress\.md|--out/, 'the skill states them');
	assert.doesNotMatch(standingParagraph(false), /episode's conversation/, 'the Project Chat is the project\'s');
});
