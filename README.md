# deceivableAI - demo

## Decision support tool

Deceivable AI acts as a digital twin for a fallible human observer. At its core, it's a rational decision-maker but extensions represent cognitive vulnerabilities such as confirmation bias, habituation, causal attribution error... Exposed to stimuli, the decision-maker interprets events as if it were human but because it is not human, it can tell you which extensions – and so which biases - have been triggered to arrive at any decision it makes. Where its human-like decision differs from its core rational decision, it can warn that exploitation or deception - or even a simple error of judgement - may be taking place and point its human operator to the cause.

Ablation interface lets users toggle individual biases on and off to observe how recommendations change, surfacing unconscious, reflexive responses to encourage critical thinking. 
 
_The research on which this tool was based, Deception Recognition and Exposure to achieve Strategic Advantage, was supported by the Government Office for Science and the Royal Academy of Engineering under the UK Intelligence Community Postdoctoral Research Fellowships scheme (ICRF2425-8-134)._

Codebase comprises:
- index.html
- engine.js - manages mechanics of scenario delivery
- model.js - definitions for the core BDN and biases
- styles.css - dark theme
- alt-theme.css - light theme
- scenario-manifest - list of scenarios to make available from drop down

Sample scenarios (fortitude, fire) point to associated style sheet and location of image files

# Scenario Quick Ref

## Structure

```js
(function(global){
  const ACTIONS = [...];
  const NODES = [...];
  const UTILITY = {...};
  function utilityFn(action, hAssign){ ... }
  const FRAMES = [...];
  const UI = {...};
  global.SCENARIO = { ACTIONS, NODES, UTILITY, utilityFn, FRAMES, UI, css: <filename> };
})(window);
```

## ACTIONS — the decision

Decision options (e.g., investigate, evacuate…), also the domain for a `biasDecision` node.

## NODES — the network definition: 5 types

- **hidden** — unobserved chance variable. Needs `domain` + `prior` (must sum to 1). This is what inference is over.
- **evidence** — observed, conditioned on hidden parents. Needs `parents`, `cpt` (2-value shorthand: a single number = P(`domain[0]`)). Seen identically by both networks.
- **biasBelief** — same maths as evidence, but only seen by the deceivable network. For use when claim is fabricated or prejudiced / not real evidence).
- **weightBias** (= an evidence node + `weightBias:true`) — both networks see it; deceivable network can raise its likelihood by `params.weight` (an exponent). With toggle off, exponent 1, identical to rational. Use this — not biasBelief — for real evidence the deceivable network merely over/under-weights.
- **biasDecision** — never touches belief. After expected utility is computed, `decide()` subtracts `penalty(action, observedValue, params)` from each action's score, deceivable network only.

## UTILITY — the payoff table

- **utilityDependsOn** — names which hidden node(s) the payoff depends on (usually one, but multiple supported — the key becomes their comma-joined values in that order).
- **utilityTable** — keyed by action, then by that same comma-joined key, giving the payoff for every action × hidden-value combination.

## utilityFn — payoff 'reader' function

A thin function — `utilityFn(action, hAssign) ⇒ number` looks up `UTILITY.utilityTable[action][key]`. Data-driven rather than hardcoded to facilitate live edits of `utilityTable` via Control Panel tab. Computed using standard maximum-expected-utility calc: Σ_h P(h | evidence) · utilityFn(a, h).

## FRAMES — the story

| Field | Purpose |
|---|---|
| `n` / `caption` / `desc` / `file` | Frame number, caption (HTML ok), image fallback text, image path. |
| `reveals` | `{ nodeId: value }` — any node id (evidence / weightBias / biasBelief / biasDecision). `{}` = deliberate no-op. Revealing only a biasDecision id leaves belief untouched — read at `decide()`, not `posterior()`. |
| `isFinal` | Exactly one frame. Plus `timerSeconds` + `timeoutAction` (the action taken on timeout). |

## UI — display strings

- `targetHiddenNode` / `targetValue` — hidden value shown as "the risk".
- `rationalLabel` / `deceivableLabel` — panel headings.
- `actionLabels` — display text per ACTIONS entry.

## Scenario Skeleton

*To appear in the demo, add entry (id, title, script path) to `scenarios-manifest.js`.*

```js
(function(global){
  const ACTIONS = ['optionA','optionB'];
  const IMAGEFOLDER = 'images-myscenario/';

  const NODES = [
    { id:'H', type:'hidden', domain:[true,false],
      prior:{ true:0.05, false:0.95 }, label:'Some Hidden Var' },
    { id:'E', type:'evidence', parents:['H'], domain:[true,false],
      cpt:{ true:0.9, false:0.1 }, label:'Some Observation' },
    // optional bias nodes — see below
  ];

  const UTILITY = {
    utilityDependsOn: ['H'],
    utilityTable: {
      optionA: { true:-10, false:0 },
      optionB: { true:0, false:-5 },
    }
  };

  function utilityFn(action, hAssign){
    const key = UTILITY.utilityDependsOn.map(id => hAssign[id]).join(',');
    return UTILITY.utilityTable[action][key];
  }

  const FRAMES = [
    { n:1, caption:'...', desc:'...', file:IMAGEFOLDER + '1.jpg',
      reveals:{} },
    { n:2, caption:'...', desc:'...', file:IMAGEFOLDER + '2.jpg',
      reveals:{}, isFinal:true, timerSeconds:20, timeoutAction:'optionA' },
  ];

  const UI = {
    title: 'My Scenario',
    targetHiddenNode: 'H', targetValue: true,
    rationalLabel: 'Rational risk',
    deceivableLabel: 'Perceived risk',
    actionLabels: { optionA:'Option A', optionB:'Option B' },
    rationalNote: '',
  };

  global.SCENARIO = { ACTIONS, NODES, UTILITY, utilityFn, FRAMES, UI,
    css: 'my-scenario.css' };
})(window);
```

*`SCENARIO_DEFAULTS` and `SCENARIO.scenarioId` set automatically via index and engine at load time.*

---

# Biases — Quick Ref

## Steps

1. **Decide type of impact:** Changes what's **believed** about the hidden state → weightBias evidence node; changes which **action** is picked, independent of belief → biasDecision node.
2. **Write the node definition** in the shape above — add `params`/`paramSchema` if you want it tunable in the Console., i.e., not required if you only want on/off toggle.
3. **Pick a label.** Reuse an existing glossary slug (case-insensitive) if it's conceptually the same bias, to get the definition for free. Genuinely new? Either add an entry to `BIAS_GLOSSARY` in `model.js`, or leave the label as plain text (no glossary link).
4. **Reveal it from a frame** — add `{ yourNodeId: someValue }` to whichever frame's `reveals` should trigger it.
5. **Sanity-check parity.** With every bias toggled off, the deceivable network must match the rational network exactly — `verifyRationalDeceivableParity()` checks this at startup and logs a failure to the console if not. (Most common failure results from weightBias node whose "off" behaviour isn't truly a no-op — e.g. a likelihood/penalty function that doesn't collapse to plain evidence when the toggle is off.)

## Bias glossary (auto-linked by label)

| Label | Mechanism |
|---|---|
| `confirmation-bias` | Not a node — engine-level parameter `q` applied to every observation automatically. Nothing to add in a scenario file. |
| `authority-bias` | weightBias evidence node, e.g., AB. |
| `obedience` | biasDecision node with a `stance` param (endorse/discourage) to favour or penalize an action, e.g., AR. |
| `social-proof` | Also biasDecision — mechanically identical to the row above, differs only in framing, e.g., SP. |

## Checklist before shipping

- [ ] Every evidence/biasBelief/weightBias `cpt` has a row for every parent-value combination.
- [ ] Every hidden node's `prior` sums to 1.
- [ ] `utilityTable` has an entry for every action × `utilityDependsOn` combination.
- [ ] Exactly one frame has `isFinal:true`, with `timerSeconds` and a valid `timeoutAction`.
- [ ] Anything the **rational** network should reason about is type hidden/evidence — never biasBelief, even if also `weightBias:true`.
- [ ] Check the browser console on load for the parity self-check and any "no CPT row" errors.

