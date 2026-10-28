import type { Plan, PlanQuestion } from './planner.js';

/**
 * Answers to the planner's questions: from `--answer <id>=<value>`, from a select prompt on a TTY
 * or, with `--assume-recommended`, from the recommendations. What stays unanswered is counted in
 * `phase.finished`.
 */

export interface AnsweredQuestion {
  id: string;
  question: string;
  answer: string;
  /** True when the answer is the planner's recommendation taken without asking. */
  assumed: boolean;
}

export interface QuestionResolution {
  answered: AnsweredQuestion[];
  unanswered: PlanQuestion[];
}

/** One select prompt; Enter picks `recommended`. Injected so tests use a fake TTY. */
export type SelectPrompt = (question: PlanQuestion) => Promise<string>;

export interface ResolveOptions {
  /** Parsed `--answer` flags, id to value; a value must be one of the question's options. */
  answers?: ReadonlyMap<string, string>;
  /** Takes every recommendation a flag did not answer, without a prompt even on a TTY. */
  assumeRecommended?: boolean;
  /** Set on a TTY; without it nothing is asked. */
  prompt?: SelectPrompt;
}

/** Parses repeated `--answer id=value`; a value may contain `=`. */
export function parseAnswerFlags(flags: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const flag of flags) {
    const at = flag.indexOf('=');
    if (at < 1 || at === flag.length - 1) {
      throw new Error(`--answer expects <id>=<value>, got '${flag}'`);
    }
    map.set(flag.slice(0, at), flag.slice(at + 1));
  }
  return map;
}

export async function resolveQuestions(
  plan: Plan,
  options: ResolveOptions = {},
): Promise<QuestionResolution> {
  const ids = new Set(plan.questions.map((q) => q.id));
  for (const id of options.answers?.keys() ?? []) {
    if (!ids.has(id)) throw new Error(`--answer names unknown question '${id}'`);
  }
  for (const q of plan.questions) {
    const given = options.answers?.get(q.id);
    if (given !== undefined && given !== q.recommended && !q.options.includes(given)) {
      const valid = [...new Set([q.recommended, ...q.options])].join(', ');
      throw new Error(`--answer ${q.id}=${given} is not an option; expected one of ${valid}`);
    }
  }
  const answered: AnsweredQuestion[] = [];
  const unanswered: PlanQuestion[] = [];
  for (const q of plan.questions) {
    const given = options.answers?.get(q.id);
    if (given !== undefined) {
      answered.push({ id: q.id, question: q.question, answer: given, assumed: false });
    } else if (options.assumeRecommended) {
      answered.push({ id: q.id, question: q.question, answer: q.recommended, assumed: true });
    } else if (options.prompt) {
      const answer = await options.prompt(q);
      answered.push({ id: q.id, question: q.question, answer, assumed: false });
    } else {
      unanswered.push(q);
    }
  }
  return { answered, unanswered };
}

/** Assumption lines for the plan: the planner's own plus every recommendation taken. */
export function assumptionLines(plan: Plan, resolution: QuestionResolution): string[] {
  const taken = resolution.answered
    .filter((a) => a.assumed)
    .map((a) => `${a.question} Assumed: ${a.answer}`);
  return [...plan.assumptions, ...taken];
}

/** The plan with the taken recommendations written into `assumptions`. */
export function withAssumptions(plan: Plan, resolution: QuestionResolution): Plan {
  return { ...plan, assumptions: assumptionLines(plan, resolution) };
}

/**
 * Answers from `/answer <id> <value>` lines of issue comments, oldest first; a later answer to the
 * same id wins. The line must start with `/answer`, so the instructions the runner posts (which
 * quote the command in backticks) are never read back as answers.
 */
export function parseAnswerComments(bodies: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const body of bodies) {
    for (const line of body.split(/\r?\n/)) {
      const m = /^\/answer\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (m) map.set(m[1] as string, m[2] as string);
    }
  }
  return map;
}

/** The issue comment of a headless run: the draft plan and one section per open question. */
export function questionsComment(plan: Plan, unanswered: PlanQuestion[]): string {
  const items = plan.items.map((i) => `- **${i.title}**`).join('\n');
  const sections = unanswered.map((q) => {
    const options = q.options.includes(q.recommended) ? q.options : [q.recommended, ...q.options];
    const list = options
      .map((o) => `- ${o}${o === q.recommended ? ' (recommended)' : ''}`)
      .join('\n');
    return `### ${q.id}: ${q.question}\n\n${list}\n\nRecommendation: ${q.recommended}. ${q.why}\n\nAnswer with \`/answer ${q.id} <value>\`.`;
  });
  return [
    'The planner needs decisions before it creates issues. Draft plan:',
    items,
    '## Questions',
    ...sections,
    'Reply with one `/answer <id> <value>` comment line per question, then run the planner again.',
  ].join('\n\n');
}

/** Select prompt on a TTY: numbered options, Enter takes `recommended`. */
export function ttySelectPrompt(
  out: { write(text: string): unknown },
  readLine: () => Promise<string>,
): SelectPrompt {
  return async (q) => {
    const options = q.options.includes(q.recommended) ? q.options : [q.recommended, ...q.options];
    const lines = options.map(
      (o, i) => `  ${String(i + 1)}) ${o}${o === q.recommended ? ' (recommended)' : ''}`,
    );
    for (;;) {
      out.write(`${q.question}\n${lines.join('\n')}\n[Enter = ${q.recommended}] > `);
      const reply = (await readLine()).trim();
      if (reply === '') return q.recommended;
      const n = Number(reply);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1] as string;
      if (options.includes(reply)) return reply;
      out.write(`'${reply}' is not an option\n`);
    }
  };
}
