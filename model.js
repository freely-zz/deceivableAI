/* =============================================================================
   model.js — Generic discrete Bayesian network / decision engine.

   This file knows nothing about fire alarms, students, or any other scenario
   content. It only knows about four node roles:

     'hidden'       - unobserved variable with a prior. Part of the
                      enumeration used for inference.
     'evidence'     - observed variable with a CPT over hidden parents.
                      Folds into belief via Bayes' rule.
     'biasBelief'   - mechanically IDENTICAL to 'evidence' (same CPT/likelihood
                      maths) but flagged separately because conceptually it
                      represents a claim that might be manipulative, even
                      though it's processed exactly like honest evidence.
                      Can be switched off via a toggle.
     'biasDecision' - never touches belief/posterior at all. Instead it
                      supplies a penalty(action, observedValue, params)
                      function applied directly to the decision layer,
                      after expected utility has already been computed.
                      Can be switched off via a toggle.

   A NETWORK is just an array of node definitions (see scenario.js for a
   concrete example). Two networks can be built from overlapping subsets of
   the same node list — e.g. a "rational" network containing only
   hidden+evidence nodes, and a "deceivable" network containing all of them.
   When every biasBelief/biasDecision node in the deceivable network is
   toggled off, its results are mathematically guaranteed to match the
   rational network's, because the maths is identical — see
   verifyRationalDeceivableParity() below.

   CPT VALUE SHORTHAND: for a node whose domain has exactly two values, a CPT
   row may be a single number meaning P(domain[0] | parents); the engine
   infers P(domain[1] | parents) = 1 - that number. For richer domains
   (3+ values), a CPT row should instead be an object mapping each domain
   value to its probability.

   CORRESPONDENCE WITH A FORMAL BAYESIAN DECISION NETWORK (BDN / influence
   diagram — see Constantinou & Fenton, "Things to know about Bayesian
   Networks: Decisions under Uncertainty, Part 2", Significance 15(2), 2018):
   a BDN extends an ordinary BN with a decision node (whose only parents are
   "informational arcs" — the evidence available at decision time) and a
   utility node (depending on the decision plus the relevant chance nodes),
   solved by picking the decision that maximizes expected utility given
   everything observed so far. The rational network here is exactly that:
     - 'hidden' and 'evidence' nodes are the chance nodes (priors + CPTs).
     - ACTIONS (see scenario.js) is the decision node's domain.
     - utilityFn is the utility node — it depends on the chosen action plus
       whichever hidden node(s) utilityDependsOn names, nothing else.
     - decide() computes argmax_a  Σ_h P(h | evidence) · utilityFn(a, h),
       i.e. the standard maximum-expected-utility rule, where "evidence" is
       every evidence-node observation folded in via posterior() — the full
       informational arc set into the decision, nothing withheld.
   For this correspondence to hold, EVERY node the rational network is meant
   to reason about must be a plain 'hidden' or 'evidence' node: a claim
   wrongly modeled as 'biasBelief' (which the rational network never sees at
   all) would make the rational network's decision use less than the full
   available evidence — no longer a faithful BDN. biasBelief/biasDecision
   nodes are a deliberate, clearly-separated extension used ONLY by the
   deceivable network, to model departures from that formal decision rule;
   they play no part in the rational network's own correspondence to a BDN.
   ============================================================================= */

(function(global){

  function cartesian(arraysById){
    const ids = Object.keys(arraysById);
    let combos = [{}];
    for(const id of ids){
      const next = [];
      for(const combo of combos){
        for(const val of arraysById[id]){
          next.push(Object.assign({}, combo, {[id]: val}));
        }
      }
      combos = next;
    }
    return combos;
  }

  function buildNetwork(nodeDefs){
    const byId = {};
    nodeDefs.forEach(n => byId[n.id] = n);

    const hiddenNodes = nodeDefs.filter(n => n.type === 'hidden');
    const evidenceLikeNodes = nodeDefs.filter(n => n.type === 'evidence' || n.type === 'biasBelief');
    const biasBeliefNodes = nodeDefs.filter(n => n.type === 'biasBelief');
    const biasDecisionNodes = nodeDefs.filter(n => n.type === 'biasDecision');
    // weightBias nodes are ORDINARY 'evidence' nodes (same CPT, same domain,
    // seen identically by both the rational and deceivable networks) that
    // additionally carry a `weightBias: true` flag plus the same
    // params/paramSchema/toggleLabel shape a biasDecision node uses. The
    // node itself does nothing special — posterior() is what looks these
    // ids up in its optional `weights` argument and, only when asked to,
    // raises that node's likelihood to an extra power. Omit the flag (or
    // never pass weights for that id) and the node behaves exactly like
    // any other evidence node, with the rational network none the wiser.
    const weightBiasNodes = nodeDefs.filter(n => n.weightBias);

    const hiddenDomains = {};
    hiddenNodes.forEach(n => hiddenDomains[n.id] = n.domain);
    const hiddenCombos = cartesian(hiddenDomains); // [{nodeId: value, ...}, ...]

    function priorOf(hAssign){
      let p = 1;
      for(const n of hiddenNodes) p *= n.prior[hAssign[n.id]];
      return p;
    }

    function likelihoodOf(node, hAssign, observedValue){
      if(observedValue === undefined || observedValue === null) return 1; // not observed -> no factor
      // Defensive check: a scenario file's FRAMES reveals must use a value
      // that's string-identical to one of the node's own declared `domain`
      // entries. Without this check, a typo/mismatch (e.g. reveals:{AB:
      // 'playing up'} against domain:['reports fault','reports no fault'])
      // fails silently: the binary-shorthand branch below just treats any
      // non-domain[0] string as domain[1], silently inverting the evidence's
      // meaning, and the multi-value branch would return undefined and let
      // NaN propagate through the maths instead of surfacing the mistake at
      // its source. This is always a scenario-authoring bug, never a valid
      // "unobserved" state — omit the key, or use null/undefined, for that.
      if(node.domain.indexOf(observedValue) === -1){
        throw new Error('model.js: node "' + node.id + '" observed value "' + observedValue +
          '" is not in its declared domain [' + node.domain.join(', ') + '] — check the scenario file\'s FRAMES reveals for this node.');
      }
      const key = node.parents.map(pid => String(hAssign[pid])).join(',');
      const dist = node.cpt[key];
      if(dist === undefined) throw new Error('model.js: no CPT row for node "' + node.id + '" at key "' + key + '"');
      if(typeof dist === 'number'){
        return (observedValue === node.domain[0]) ? dist : (1 - dist);
      }
      return dist[observedValue];
    }

    /* observations: { nodeId: value } | [{ nodeId: value }, ...]
                     — a single flat object is treated as one step (identical
                       to the original one-shot behaviour); an ARRAY is a
                       sequence of steps applied in order (see q, below).
                       Omit a key, or use null/undefined, for "not observed".
       toggles:      { nodeId: bool }   — for biasBelief/biasDecision nodes only;
                                          missing key defaults to ON (true)
       q:            number in [0,1), default 0.5 — "fanaticism" / confirmation-
                     bias temperature, applied AT EACH STEP as
                       weight ∝ Likelihood_step^(2(1-q)) · runningBelief^(2q)
                     — i.e. "prior" means the belief carried in from the
                     previous step, not the original hidden-node prior.
                     q=0.5 makes every step plain sequential Bayes, which is
                     mathematically identical to the old one-shot computation
                     regardless of order or step count (this is what keeps
                     the rational network, which never receives a q, exactly
                     unchanged). q=0 means "only ever look at the newest
                     step" (each step fully discards everything before it).
                     q=1 means "only ever trust what's already believed"
                     (each step fully discards the new evidence, but still
                     re-sharpens the running belief). A step with no
                     observations for any node this network uses is a no-op
                     — it leaves belief exactly as it was, at any q.
       weights:      { nodeId: exponent }, default {} — for weightBias nodes
                     only (see weightBiasNodes above); missing key defaults
                     to 1 (no extra weight, identical to plain evidence).
                     Raises that ONE node's likelihood contribution to the
                     given power before it's folded into the step's combined
                     likelihood — a per-node analogue of q, rather than a
                     temperature applied to the whole step. A caller that
                     never passes weights (the rational network's calls,
                     and the parity check below) gets exponent 1 for every
                     node unconditionally, so a shared evidence node with a
                     weightBias flag is mathematically indistinguishable
                     from plain evidence unless the caller explicitly asks
                     for extra weight on it. */
    function posterior(observations, toggles, q, weights){
      toggles = toggles || {};
      weights = weights || {};
      q = (q === undefined || q === null) ? 0.5 : q;
      const steps = Array.isArray(observations) ? observations : [observations];

      let combos = hiddenCombos.map(hAssign => ({ hAssign, p: priorOf(hAssign) }));
      let startTotal = combos.reduce((s,x)=>s+x.p, 0);
      combos = combos.map(x => ({ hAssign: x.hAssign, p: x.p/startTotal }));

      steps.forEach(obsStep => {
        obsStep = obsStep || {};
        const hasEvidence = evidenceLikeNodes.some(node => {
          const isBias = node.type === 'biasBelief';
          const on = isBias ? (toggles[node.id] !== false) : true;
          return on && obsStep[node.id] !== undefined && obsStep[node.id] !== null;
        });
        if(!hasEvidence) return; // no new information this step — belief unchanged

        const raw = combos.map(({hAssign, p}) => {
          let likelihood = 1;
          for(const node of evidenceLikeNodes){
            const isBias = node.type === 'biasBelief';
            const on = isBias ? (toggles[node.id] !== false) : true;
            const val = on ? obsStep[node.id] : null;
            const wExp = weights[node.id] || 1;
            likelihood *= Math.pow(likelihoodOf(node, hAssign, val), wExp);
          }
          const w = Math.pow(likelihood, 2*(1-q)) * Math.pow(p, 2*q);
          return { hAssign, w };
        });
        const total = raw.reduce((s,x)=>s+x.w, 0);
        if(total <= 0) throw new Error('model.js: zero-probability evidence combination — check the CPTs.');
        combos = raw.map(x => ({ hAssign: x.hAssign, p: x.w/total }));
      });

      const marginals = {};
      hiddenNodes.forEach(n => { marginals[n.id] = {}; n.domain.forEach(v => marginals[n.id][v] = 0); });
      combos.forEach(({hAssign, p}) => hiddenNodes.forEach(n => { marginals[n.id][hAssign[n.id]] += p; }));

      return { combos, marginals };
    }

    function expectedUtility(combos, utilityFn, actions){
      const eu = {};
      actions.forEach(a => {
        eu[a] = combos.reduce((sum, {hAssign, p}) => sum + p * utilityFn(a, hAssign), 0);
      });
      return eu;
    }

    /* Applies biasDecision penalties (if toggled on and observed) on top of EU. */
    function decide(combos, utilityFn, actions, observations, toggles){
      toggles = toggles || {};
      const eu = expectedUtility(combos, utilityFn, actions);
      const scores = Object.assign({}, eu);
      for(const node of biasDecisionNodes){
        const on = toggles[node.id] !== false;
        const obs = observations[node.id];
        if(!on || obs === undefined || obs === null) continue;
        // Same defensive check as likelihoodOf() above, and for the same
        // reason: a FRAMES reveal that doesn't string-match one of this
        // node's declared domain values is always a scenario-authoring
        // bug. Left unchecked, most penalty(action, observedValue, params)
        // functions just never match `action === observedValue` for any
        // real action, so the bias silently applies a zero penalty
        // everywhere instead of the one the scenario intended — no error,
        // just a bias that quietly does nothing.
        if(node.domain.indexOf(obs) === -1){
          throw new Error('model.js: node "' + node.id + '" observed value "' + obs +
            '" is not in its declared domain [' + node.domain.join(', ') + '] — check the scenario file\'s FRAMES reveals for this node.');
        }
        actions.forEach(a => { scores[a] -= node.penalty(a, obs, node.params || {}); });
      }
      let best = actions[0];
      actions.forEach(a => { if(scores[a] > scores[best]) best = a; });
      return { eu, scores, best };
    }

    return {
      hiddenNodes, evidenceLikeNodes, biasBeliefNodes, biasDecisionNodes, weightBiasNodes, byId,
      posterior, expectedUtility, decide
    };
  }

  /* Regression guard: with every bias node forced off, the deceivable network
     MUST produce identical numbers to the rational network, for any shared
     observation set. Throws (loudly, in the console) if not. Call this once
     at startup after building both networks. */
  function verifyRationalDeceivableParity(rationalNet, deceivableNet, utilityFn, actions, testObservations){
    const allOff = {};
    deceivableNet.biasBeliefNodes.concat(deceivableNet.biasDecisionNodes).forEach(n => allOff[n.id] = false);

    const rPost = rationalNet.posterior(testObservations, {});
    const dPost = deceivableNet.posterior(testObservations, allOff);

    const rResult = rationalNet.decide(rPost.combos, utilityFn, actions, testObservations, {});
    const dResult = deceivableNet.decide(dPost.combos, utilityFn, actions, testObservations, allOff);

    const mismatch = actions.some(a => Math.abs(rResult.eu[a] - dResult.scores[a]) > 1e-9);
    if(mismatch){
      console.error('PARITY CHECK FAILED — rational and deceivable networks disagree with all biases off.',
        { rational: rResult, deceivable: dResult });
      return false;
    }
    console.log('Parity check passed: deceivable network with all biases off matches the rational network exactly.');
    return true;
  }

  /* ===========================================================================
     BIAS_GLOSSARY — plain-English definitions of the deceivable-mode biases,
     PLUS how each one is technically implemented in this engine. Kept here
     rather than in a scenario file because the definitions and the
     mechanisms they describe are the same regardless of which scenario is
     loaded; a scenario file only ever supplies which of these mechanisms it
     uses and the content (labels, CPTs) that mechanism is applied to.
     Keyed by a slug matching how a bias node's own `label` normalizes
     (lowercased, spaces to hyphens) — e.g. a node labelled "Authority Bias"
     resolves to 'authority-bias' — so engine.js can link the first mention
     of a term straight to its entry here without any scenario having to
     know the glossary exists.
     =========================================================================== */
  const BIAS_GLOSSARY = {
    'confirmation-bias': {
      term: 'Confirmation bias',
      definition: 'Weighing new evidence in a way that reinforces what you already believe, rather than updating on it evenhandedly.',
      implementation: 'A temperature parameter q (0\u20131) reweights each observation step as weight \u221d Likelihood^(2(1\u2212q)) \u00b7 priorBelief^(2q). q = 0.5 is standard, order-independent Bayesian updating. As q rises toward 1, new evidence is increasingly discounted in favour of whatever is already believed. A separate "order-dependent updating" toggle controls whether evidence is folded in frame-by-frame (so this asymmetry compounds across steps) or all at once as a single batch (mathematically order-independent regardless of q).',
      popup: 'Weighing new evidence in a way that reinforces what you already believe.',
    },
    'authority-bias': {
      term: 'Authority bias',
      definition: 'Giving a claim extra credence simply because it comes from a perceived authority or confident source, independent of the claim\u2019s actual reliability.',
      implementation: 'Modeled as an ordinary evidence node that BOTH networks observe identically \u2014 there is no separate, excluded version of this evidence. What differs is how much it counts: when switched on, the deceivable network raises this node\u2019s likelihood to an adjustable power (a per-node analogue of the confirmation-bias temperature q), sharpening how far this one piece of evidence moves belief relative to everything else observed. Switched off, or viewed rationally, it counts exactly the same as any other evidence.',
      popup: 'Giving a claim extra credence simply because it comes from a perceived authority.',
    },
    'obedience': {
      term: 'Obedience',
      definition: 'Doing what an authority (or apparent consensus) tells you to do, independent of what it does to your beliefs about the world \u2014 distinct from authority bias, which is about crediting a claim, not complying with an instruction.',
      implementation: 'Modeled as a biasDecision node \u2014 it never touches belief/posterior at all. Instead it supplies a penalty(action, observedValue, params) function applied directly to each action\u2019s expected-utility score, after expected utility has already been computed from unaffected belief. Some obedience nodes also take a `stance` param (\u2018endorse\u2019 or \u2018discourage\u2019), since the same mechanism has to cover both an authority recommending an action and an authority warning against one: \u2018endorse\u2019 penalizes deviating from the observed value, \u2018discourage\u2019 penalizes matching it. A node with no `stance` param always behaves as \u2018endorse\u2019 \u2014 appropriate where the scenario only ever needs to model pull toward an observed value, never push away from it.',
      popup: 'Doing what an authority (or apparent consensus) tells you to do.',
    },
    'social-proof': {
      term: 'Social proof',
      definition: 'Taking a cue for the correct action from the observed behaviour of peers or bystanders, treating "what others are doing" as informative even when it isn\u2019t.',
      implementation: 'Modeled the same way as obedience \u2014 a biasDecision node applying a penalty at the decision layer, never touching belief. The two differ only in scenario framing (peers\u2019 calm behaviour vs. an authority\u2019s confident claim), not in how the model processes them.',
      popup: 'Taking a cue for the correct action from the observed behaviour of peers or bystanders.',
    },
    'order-dependent-updating': {
      term: 'Order-dependent updating',
      definition: 'Whether the order in which evidence arrives influences the final belief, rather than every piece of evidence being weighed as if it all arrived at once.',
      implementation: 'This only has a visible effect when confirmation bias (q) is genuinely active (q \u2260 0.5), since a symmetric q = 0.5 update gives the same answer regardless of how evidence is folded. ON processes each frame\u2019s reveal as its own step, so q\u2019s asymmetric step-by-step weighting compounds across the sequence \u2014 later evidence gets judged more through the lens of whatever earlier evidence has already produced. OFF folds every currently-revealed value into a single combined step, applied once, so there is no sequence for that asymmetry to compound across. A repeated observation of the same node/value (e.g. an alarm sounding twice) is still counted the correct number of times either way: folded into one step, its likelihood is simply raised to the power of how many times it occurred, which is mathematically identical to applying that likelihood once per separate step \u2014 so switching this off changes HOW confirmation bias compounds, not how much genuine evidence the network has seen.',
      popup: 'Whether the order in which evidence arrives influences the final belief.',
    },
  };

  global.BayesEngine = { buildNetwork, verifyRationalDeceivableParity, cartesian, BIAS_GLOSSARY };

})(window);
