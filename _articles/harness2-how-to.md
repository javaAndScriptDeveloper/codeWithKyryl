---
layout: post
title: "How to use Harness² in Python: a recursive agent harnessing demo"
date: 2026-10-22
tags: [harness2, python, tutorial]
excerpt: "Harness² refines the system around a model instead of the model itself. Here is the Propose, Probe, Compose loop running on one task in plain Python, offline, with no answer key."
description: "How to use Harness², the recursive agent harnessing framework: the eight editable components, Propose, Probe, Compose, and a runnable offline Python demo."
faq:
  - question: "What is Harness²?"
    answer: "Harness² is a plug-and-play framework from Google Research for recursive agent harnessing in an open world. A harness is the system around a model that lets it act as an agent: prompts, tools, memory, skills, orchestration. Harness² optimizes that system while the model weights stay fixed."
  - question: "Does Harness² change model weights?"
    answer: "No. Both levels of recursion keep model weights fixed. Task-level recursion refines the execution harness for the current task, and harnessing-level recursion updates a persistent improvement harness used by later tasks."
  - question: "Does Harness² need model credentials to run?"
    answer: "The local demo does not. It runs both recursion modes with deterministic editors and real Python executions and requires no model credentials. Model-backed benchmark runs do need credentials, Vertex AI model IDs, and they cost money per task."
  - question: "What is the difference between parallel and sequential recursion in Harness²?"
    answer: "With --k K --mode parallel, Harness² probes K general and K domain-specific candidates and then produces K compositions, so it explores wider. With --k K --mode sequential it refines the harness through K successive Propose, Probe, Compose steps, so it refines deeper."
  - question: "Which benchmarks does the Harness² release support?"
    answer: "JobBench for professional work, LAB for legal work, and WorkBuddy-Bench for office, web and code tasks. The release also supports parallel and sequential recursion and the OpenCode and Codex executors."
---

A harness I wrote by hand read two rows out of seven and reported a confident total. No error, no warning, just five hours billed where ten and three quarters belonged, and five rows that never appeared in the output. The prompt was fine. The model was fine. The system around the model was the thing that was broken, and nothing in my loop was looking at it.

Code: [github.com/javaAndScriptDeveloper/harness2-how-to](https://github.com/javaAndScriptDeveloper/harness2-how-to)

## 🤖 Run this with an AI agent

The repo carries an [AGENTS.md](https://github.com/javaAndScriptDeveloper/harness2-how-to/blob/main/AGENTS.md) with the same how-to written for an agent to execute. Hand your agent this prompt:

```text
Clone https://github.com/javaAndScriptDeveloper/harness2-how-to and follow AGENTS.md to run the example and show me the output.
```

## What Harness² actually optimizes

Google Research published [harness2](https://github.com/google-research/harness2) with a definition worth copying into your own notes: a harness is the system around a model that enables it to act as an agent, meaning prompts, tools, memory, skills, orchestration and more. Harnessing is the process of optimizing that system.

Harness² connects two levels of recursion while keeping model weights fixed. Task-level recursion refines the execution harness for the current task through a contrastive Propose, Probe, Compose step: propose edits, probe their effects on the same task, and compose a refined harness from behavioral contrasts between executions, without ground-truth feedback. Harnessing-level recursion updates a persistent improvement harness with adopted harnesses and evidence-supported lessons from each task, which guides refinement on the next one.

The published results: across three professional benchmarks and four model-harness configurations, a single Harness² step improves GLM-5 and Gemini 3.5 Flash over their base harnesses, with gains of up to 11.5 points on WorkBuddy-Bench, 4.5 points on JobBench, and 11.8 percentage points on LAB's partial pass rate. Increasing the task-level recursion budget brings further gains.

The part that made me build a demo is the phrase "without ground-truth feedback". Every eval loop I have shipped needs a label to score against. This one scores by comparing executions of the same task against each other.

## What you build in this tutorial

The repo above is a small standalone implementation of that loop in plain Python, standard library only, no model credentials and no network. It is not the Google Research package. I wrote it to make the mechanics visible, the way you would reimplement a consensus algorithm to understand it before running the real one. Instructions for the real package are further down.

The task is a timesheet. Seven rows, written the way people write them, and one instruction:

```text
# instruction: report billed hours per project and account for every row you cannot read
2026-10-19 | aiden | api-migration | 2h
2026-10-19 | aiden | api-migration | 90m
2026-10-20 | bo | api-migration | 1.5 h
2026-10-20 | bo | onboarding | 45m
2026-10-21 | cyd | onboarding | 2 hours
2026-10-21 | cyd | api-migration | 3h
2026-10-22 | cyd | api-migration |
```

The base harness names two tools and says nothing about a row the executor cannot read. So the first execution reads `2h` and `3h`, bills five hours to one project, and silently drops the rest.

## The eight components as plain data

Harness² exposes eight editable components around the model: system prompt, guardrails, memory, tool guidance, subagents, skills, scripts and plugins. They control context construction, the tool interface, delegation and behavior inside the tool loop.

Keeping all eight as data is what makes an edit cheap and a probe trivial:

```python
COMPONENTS = (
    "system_prompt",
    "guardrails",
    "memory",
    "tool_guidance",
    "subagents",
    "skills",
    "scripts",
    "plugins",
)


@dataclass(frozen=True)
class Harness:
    system_prompt: str
    guardrails: tuple = ()
    memory: tuple = ()
    tool_guidance: tuple = ()
    subagents: tuple = ()
    skills: tuple = ()
    scripts: tuple = ()
    plugins: tuple = ()

    def with_edit(self, edit):
        if edit.component == "system_prompt":
            return replace(self, system_prompt=edit.value)
        current = getattr(self, edit.component)
        if edit.value in current:
            return self
        return replace(self, **{edit.component: current + (edit.value,)})
```

An edit is a name, a component, a value, a scope (general or domain-specific) and a rationale. The executor reads the harness and changes what it does: `skills.duration_normalizer` swaps the duration parser, `guardrails.row_accounting` makes the deliverable list every row that was not read, `scripts.reconcile_rows` runs a row count check inside the execution, `subagents.unit_checker` delegates a second look at parsed durations.

## Probe and contrast, with no answer key

A probe executes the same task under the edited harness. The contrast is the set of evidence keys where that execution behaved differently from the baseline execution:

```python
def contrast(baseline, candidate):
    before, after = baseline.evidence(), candidate.evidence()
    return {key: (before[key], after[key]) for key in before if before[key] != after[key]}
```

The evidence is six values the run produces about itself: rows read, rows declared unreadable, projects reported, total hours, whether read plus declared equals the row count, and whether the self-check ran and passed. Not one of them needs a correct answer to exist. That is the whole trick, and it is also the limit, which I come back to below.

Composition ranks the surviving edits by how much they changed, builds refined harnesses out of the top ones, executes each, and adopts the strongest by a rule that puts accounting first:

```python
def rank_key(execution):
    return (
        execution.reconciliation == "pass",
        execution.rows_read,
        execution.self_check == "pass",
    )
```

Reading more rows while hiding the rest never wins.

## Run it

Python 3.12, nothing to install:

```bash
python3 selftest.py
```

```text
selftest: 10 checks passed
```

Then parallel recursion with k = 2, which probes two general and two domain-specific candidates and produces two compositions:

```bash
python3 run_parallel.py
```

```text
harness2 mini demo
mode: parallel
k: 2
task: timesheet-billing (7 rows)
instruction: report billed hours per project and account for every row you cannot read
prior lessons applied: 0
base: rows_read=2 declared=0 projects=1 hours_total=5.0 reconciliation=fail self_check=off
probes:
  guardrails.row_accounting [general] score=2 declared 0 -> 5, reconciliation fail -> pass
  scripts.reconcile_rows [general] score=1 self_check off -> fail
  skills.duration_normalizer [domain] score=3 rows_read 2 -> 6, projects 1 -> 2, hours_total 5.0 -> 10.75
  subagents.unit_checker [domain] score=0 no behavioral contrast
compositions:
  1 edit: rows_read=6 declared=0 projects=2 hours_total=10.75 reconciliation=fail self_check=off
  3 edits: rows_read=6 declared=1 projects=2 hours_total=10.75 reconciliation=pass self_check=pass
adopted: guardrails.row_accounting, scripts.reconcile_rows, skills.duration_normalizer
rejected: subagents.unit_checker (no behavioral contrast)
refined: rows_read=6 declared=1 projects=2 hours_total=10.75 reconciliation=pass self_check=pass
lessons in improvement harness: 3
files: adopted_harness.json, probes.json, billing_summary.txt
```

Three things in that output are the point of the whole exercise.

The narrow composition, one edit, reads six rows and still fails reconciliation. Better parsing alone produced a nicer wrong answer. The wide composition reads six rows, declares the seventh, and passes.

`subagents.unit_checker` is rejected. Its probe added a delegation step to the trace and changed no evidence at all, so the composition dropped it. An edit that looks reasonable in review and does nothing in execution is exactly what a contrastive probe is for.

The deliverable now names what it could not do:

```text
Billing summary for timesheet-billing
api-migration=8.0h
onboarding=2.75h
total=10.75h
rows_read=6
needs_review=1
needs_review_1=2026-10-22 | cyd | api-migration |
```

## Sequential mode and the improvement harness

Parallel recursion explores wider, sequential recursion refines deeper. The sequential run does the same work in two successive steps, each probing against the harness the previous step adopted:

```bash
python3 run_sequential.py
```

The middle of its summary:

```text
steps:
  step 1 probed: guardrails.row_accounting score=2, skills.duration_normalizer score=3
  step 1 adopted: guardrails.row_accounting, skills.duration_normalizer
  step 2 probed: scripts.reconcile_rows score=1, subagents.unit_checker score=0
  step 2 adopted: scripts.reconcile_rows
```

The same summary reports `prior lessons applied: 3`, because the parallel run left an improvement harness behind at `runs/improvement_harness.json`. That file is harnessing-level recursion in miniature, and one of its three lessons looks like this:

```json
{
  "edit": "skills.duration_normalizer",
  "component": "skills",
  "rationale": "read 90m, 1.5 h and 2 hours, not only 2h",
  "evidence": "rows_read 2 -> 6, projects 1 -> 2, hours_total 5.0 -> 10.75",
  "tasks": ["timesheet-billing"],
  "adoptions": 1
}
```

A lesson carries the evidence that earned it. The next task proposes lesson-backed edits before the rest of the pool, so the second run reaches the same harness with half the probes.

Two of the assertions that hold this honest, and that run in CI on every push:

```bash
grep -q reconciliation=pass runs/parallel/summary.txt
grep -q api-migration=8.0h runs/parallel/billing_summary.txt
```

## Running the real Harness²

Upstream Harness² wants Linux, Python 3.12 and `uv`. From the repository root you create the environment with `uv venv --python 3.12 .venv`, activate it, install with `uv pip install -e '.[render]'`, and run the local demo with `harness2-demo --output runs/demo --k 2`. That demo runs both recursion modes with deterministic editors and real Python executions, and it requires no model credentials, which is why it is the right first command.

Model-backed benchmarks are a bigger setup. Node.js 20 or newer, the Google Cloud CLI, and the benchmark dependencies; Pandoc and Poppler for LAB; Docker for WorkBuddy-Bench. Models are configured through a `.env` copied from `.env.example` with your Vertex AI project and model IDs, then `gcloud auth application-default login`. The settings that matter are `HARNESS2_SOLVER_MODEL` for the executor, `HARNESS2_IMPROVER_MODEL` for the improver (it defaults to the executor), `HARNESS2_JUDGE_MODEL` for the judge, and `HARNESS2_RUNS_DIR` for the output root. Shell environment variables take precedence over `.env`.

A benchmark run is five commands: `harness2-setup lab`, `harness2-check --bench lab`, the refinement run `harness2 --bench lab --k 1 --mode parallel --only-domains antitrust-competition --max-tasks 1`, then `harness2-judge` and `harness2-report` with the same arguments. Judging and reporting must use the same benchmark, executor, subset, `--k`, `--mode` and seed as the refinement run. `--dry-run` previews task selection without model calls, and `--substrate cx` switches from the default OpenCode executor to Codex. Repeat the same command to resume, and use a new `HARNESS2_RUNS_DIR` when you change models or task selection.

## The honest trade-offs

Recursion is paid for in executions. One Propose, Probe, Compose step at `--k 2` in my demo costs seven executions of the same task instead of one (the baseline, four probes, two compositions), and those executions are free only because there is no model behind them. Upstream, every probe is model calls on a real task: the docs say model-backed runs incur API costs and advise starting with a small task selection, and `--k` multiplies that bill. Scaling the recursion budget brings further gains, so the budget is a money dial, not a quality dial.

Selection without ground truth is selection on the evidence you thought to collect. My loop rejected a useless subagent because none of its six evidence values moved. If I had been collecting step counts as evidence, the same edit would have scored a point for adding a delegation step and gone into the refined harness. A contrastive loop will happily adopt an edit that changes behavior without improving it, and the only defense is picking evidence that is hard to game, like read plus declared equaling the row count.

The security note in the upstream README deserves its own paragraph. Executor network access is unrestricted, and Codex runs with its sandbox disabled. Public benchmark rubrics may be accessible online, so an executor with open web access can read the grading criteria it is being graded against. The docs tell you to configure network restrictions before evaluation. If you skip that step, your gains measure the executor's search skills.

And the whole approach assumes the harness is where your problem lives. If your agent fails because the model cannot do the task, eight editable components will not save it. Harness² keeps weights fixed by design, which is the right call when the harness is the bottleneck and the wrong tool when it is not.

What I keep from it is smaller than the framework: probe your harness edits by running the same task twice and diffing the behavior, and write down the evidence that justified every edit you kept. My demo does that in a few hundred lines of standard library Python.

Which part of your own agent harness has never been probed, only reviewed?
