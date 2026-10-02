/* =============================================================================
   engine.js — Generic UI/interaction engine. Contains NO scenario-specific
   strings or node names — everything content-related is read from
   window.SCENARIO (see scenario.js). To reuse this for a new scenario,
   only scenario.js should need to change.
   ============================================================================= */

(function(){
  console.log('engine.js build: eager-preload scenario switching, defensive FRAMES guard (2026-08)');

  // Scenario-dependent state — rebuilt fresh every time initIncidentConsole()
  // runs, so the demo can switch between scenario scripts without a page
  // reload. Declared here (not const) purely so init() can reassign them;
  // every function below reads them via closure, so re-running init() is
  // all a scenario switch needs — no other function needs to change.
  let S, ACTIONS, FRAMES, rationalNet, deceivableNet, biasNodes, toggles;

  // FRAMES (above) is always the DERIVED sequence actually used for
  // playback — computed from frameOrder/frameIncluded plus S.FRAMES (the
  // untouched scenario-file order). frameWorkingSets keeps one
  // {frameOrder, frameIncluded} entry PER SCENARIO ID, so switching
  // scenarios and back restores that scenario's own current ordering
  // rather than resetting it. Only a fresh page load (or the Frames tab's
  // own "Reset to scenario order" button) resets a scenario's entry back
  // to the order given in its scenario file — switching scenarios never
  // does, and the ordering can be changed as many times as you like within
  // a session.
  let frameWorkingSets = {}; // scenarioId -> { frameOrder, frameIncluded }
  let frameOrder = [];
  let frameIncluded = {};

  /* ---------------- shared state ---------------- */
  let mode = 'story';          // story | rational | deceivable | console | frames
  let frameIdx = 0;
  let finalized = false;
  let lastChoice = null;
  let lastTimedOut = false;
  let timerHandle = null;
  let timerRemaining = 20;
  // Whether the Deceivable Mode "perceived risk" panel has been revealed
  // yet this run through the sequence. It only pops into view once its
  // figure actually diverges from the rational-risk panel's figure — a
  // discrepancy is itself the alert — and then stays visible for the rest
  // of the sequence even if a later toggle/frame brings the two figures
  // back into agreement. Reset wherever a fresh run through the frames
  // begins (restartSequence, a Frames-tab reorder, or a scenario switch);
  // stepping back and forth within the same run never resets it.
  let perceivedRiskRevealed = false;

  // Deceivable-mode end-of-sequence quiz state — see paintResult()'s
  // deceivable branch / renderDeceivableOutcome() below. Reset wherever
  // finalized/lastChoice are reset (a fresh run, stepping off the final
  // frame, a Frames-tab reorder, or a scenario switch), via resetQuiz().
  let quiz1Answer = null;          // the bias id the person picked for Q1, or null if unanswered
  let quiz2Answer = null;          // a bias id, 'none', or 'other', or null if unanswered
  let quiz2OtherText = '';         // free text once Q2's 'Other' has been submitted
  let quiz2ShowOtherInput = false; // true once 'Other' is picked but not yet submitted
  function resetQuiz(){
    quiz1Answer = null; quiz2Answer = null; quiz2OtherText = ''; quiz2ShowOtherInput = false;
  }

  // ---- Silent spreadsheet logging (Google Apps Script Web App) ----------
  // Paste your deployed Apps Script Web App URL here — see the companion
  // apps-script-code.gs file for the backend code and deployment steps.
  // Left blank, logging is a harmless no-op (a console warning, nothing
  // thrown) so the demo works fully before you've set this up.
  const SHEET_LOG_URL = 'https://script.google.com/macros/s/AKfycbzOPNxMx_alg6HuDPiHWua9ov4ops1-6jAXNKz-u1_q3AgXk1MtTbo1WZ1iVHGtchXhaQ/exec';

  // Records one finalized decision. For story/rational mode this fires
  // immediately (chooseAction() below); for deceivable mode it's held as
  // `pendingDecisionRecord` until the end-of-sequence quiz is complete, so
  // one row ends up with the decision AND both quiz answers together
  // rather than three separate partial rows.
  function logDecision(record){
    if(!SHEET_LOG_URL){
      console.warn('Sheet logging not configured — paste your Apps Script Web App URL into SHEET_LOG_URL near the top of engine.js.');
      return;
    }
    fetch(SHEET_LOG_URL, {
      method: 'POST',
      // Deliberately text/plain, not application/json: that keeps this a
      // CORS "simple request" so the browser skips a preflight OPTIONS
      // call, which Apps Script Web Apps don't handle. The Apps Script
      // side parses the body as JSON regardless of the declared type.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(record)
    }).then(res => res.json()).then(data => {
      if(!data || data.result !== 'success') console.warn('Sheet logging responded with an error:', data);
    }).catch(err => {
      console.warn('Sheet logging request failed (is the Web App deployed and the URL correct?):', err);
    });
  }
  let pendingDecisionRecord = null; // set at chooseAction() in deceivable mode; consumed once the quiz completes

  // "Fanaticism" / confirmation-bias temperature for the deceivable network only.
  // The rational network never receives this — it always runs at the implicit
  // default of 0.5 (standard Bayes), by simply never passing a third argument.
  // Ships ON by default at a mild value, and can be switched off (back to an
  // effective 0.5) from the Deceivable panel, the same way any other bias is.
  let qEnabled = true;
  let qMagnitude = 0.55;
  function effectiveQ(){ return qEnabled ? qMagnitude : 0.5; }
  // Per-node evidence-weight exponents for the deceivable network's
  // posterior() calls (see model.js's `weights` argument). A weightBias
  // node (e.g. AB) is plain evidence structurally — both networks already
  // see it — so this is the ONLY thing that makes the deceivable network
  // treat it any differently: exponent = its configured weight when the
  // node's toggle is on, or 1 (no extra weight, same as rational) when off
  // or absent. The rational network never calls this — its posterior()
  // calls simply never receive a weights argument, so it always computes
  // every node's likelihood at exponent 1 regardless of these settings.
  function currentWeights(overrideToggles){
    const t = overrideToggles || toggles;
    const w = {};
    deceivableNet.weightBiasNodes.forEach(n => {
      w[n.id] = (t[n.id] !== false) ? (n.params.weight) : 1;
    });
    return w;
  }
  // Whether evidence is folded in frame-by-frame (order can matter, when q != 0.5)
  // or all at once as a single batch (mathematically order-independent regardless
  // of q, PROVIDED repeated observations of the same node/value are counted —
  // see evidenceRepeatCountsUpTo() below for why that matters and how).
  let orderSensitive = true;
  // q and order-sensitivity each have two separate UI homes (the Deceivable
  // panel toggle row, and their own Console controls) sharing the same state.
  // Each is only built once, so whichever one changes must push its new
  // value into the other manually — this is that push.
  function syncQControls(){
    const t1 = el('qToggle'); if(t1) t1.checked = qEnabled;
    const t2 = el('qToggleConsole'); if(t2) t2.checked = qEnabled;
    const s2 = el('qMagnitudeSliderConsole'); if(s2) s2.value = qMagnitude;
    const l2 = el('qMagnitudeLabelConsole'); if(l2) l2.textContent = qMagnitude.toFixed(2);
    const o1 = el('orderToggle'); if(o1) o1.checked = orderSensitive;
    const o2 = el('orderToggleConsole'); if(o2) o2.checked = orderSensitive;
  }
  // Every bias node's toggle has two homes — the frame-view panel and the
  // Console panel — sharing the same `toggles[id]` state. Whichever one the
  // person flips, push the new value into the other so they never drift.
  function syncBiasToggle(id){
    document.querySelectorAll(`[data-toggle="${id}"]`).forEach(cb => cb.checked = toggles[id]);
    document.querySelectorAll(`[data-toggleconsole="${id}"]`).forEach(cb => cb.checked = toggles[id]);
  }

  function evidenceUpTo(idx){
    const ev = {};
    for(let i=0;i<=idx;i++) Object.assign(ev, FRAMES[i].reveals);
    return ev;
  }
  function evidenceStepsUpTo(idx){
    return FRAMES.slice(0, idx+1).map(f => f.reveals);
  }
  // Batch mode ("order-dependent updating" off) folds every frame's reveals
  // into ONE flat object via evidenceUpTo()/Object.assign — which, for a
  // node revealed the SAME way more than once (e.g. the alarm sounding a
  // second time), silently keeps only the last occurrence: the merge just
  // overwrites the key, so the second observation vanishes instead of
  // compounding belief the way the frame-by-frame (evSteps) path does.
  // That made batch mode NOT actually equivalent to sequential mode at
  // q=0.5 whenever a node repeats — the two would quietly disagree even
  // with every bias switched off. This counts, per node, how many times in
  // a row its value was repeated (a genuine value CHANGE resets the count,
  // since a flat merged object can only represent one current value per
  // node — an earlier, superseded observation can't be folded into a
  // single step; this is a structural limit of batching multiple frames
  // into one, not something this fix can lift).
  function evidenceRepeatCountsUpTo(idx){
    const counts = {};
    for(let i=0;i<=idx;i++){
      const reveals = FRAMES[i].reveals;
      Object.keys(reveals).forEach(id=>{
        const v = reveals[id];
        if(v===undefined || v===null) return;
        if(counts[id] && counts[id].value === v){
          counts[id].count++;
        } else {
          counts[id] = { value: v, count: 1 };
        }
      });
    }
    const out = {};
    Object.keys(counts).forEach(id => { out[id] = counts[id].count; });
    return out;
  }
  // The weights to use for a BATCH-mode deceivable posterior() call: the
  // usual per-node weightBias exponents (currentWeights()), each further
  // multiplied by that node's repeat count above. Multiplying a
  // likelihood's exponent is exactly what applying the SAME likelihood
  // factor that many times over separate sequential steps would do, so
  // this restores the repeat-compounding that the flat merge otherwise
  // throws away — without needing any change to model.js at all, since
  // `weights` already applies to any node id, not only ones flagged
  // weightBias.
  function batchWeights(idx, overrideToggles){
    const w = Object.assign({}, currentWeights(overrideToggles));
    const counts = evidenceRepeatCountsUpTo(idx);
    Object.keys(counts).forEach(id => {
      if(counts[id] > 1) w[id] = (w[id] || 1) * counts[id];
    });
    return w;
  }

  function fmtPct(p){ return (p*100).toFixed(1) + '%'; }
  function pFireTier(p){ if(p<0.15) return 'calm'; if(p<0.45) return 'warn'; return 'danger'; }
  function el(id){ return document.getElementById(id); }
  function stripHtml(html){ const d = document.createElement('div'); d.innerHTML = html; return d.textContent || d.innerText || ''; }
  // Builds a small "key" line for the bottom of a Console panel, mapping
  // each short id actually used in that panel's header/rows to its full
  // name — e.g. "F = Fire  ·  AS = Alarm Status". Headers and body
  // rows themselves keep using the bare ids exactly as the scenario file
  // wrote them; this is the one place those ids get spelled out. Ids
  // de-duplicated and shown in the order first given.
  function nodeKeyHtml(net, ids, useAlias){
    const seen = [];
    ids.forEach(id => { if(id && seen.indexOf(id) === -1) seen.push(id); });
    const parts = seen.map(id => {
      const n = net.byId[id];
      const dispId = (useAlias && n && n.alias) ? n.alias : id;
      const name = (useAlias && n && n.alias && n.aliasLabel) ? n.aliasLabel : ((n && n.label) ? n.label : dispId);
      return `<b>${dispId}</b> = ${name}`;
    });
    return parts.length ? `<div class="node-key">${parts.join(' &nbsp;&middot;&nbsp; ')}</div>` : '';
  }

  // A weightBias node (e.g. AB) is ordinary evidence structurally, so it's
  // displayed as such in the main body of the Console tab (the plain
  // evidence CPT panels and the Live scenario preview) — calling it a
  // "bias" there would be misleading, since nothing shown in those two
  // spots depends on any toggle. A scenario file can set `alias` /
  // `aliasLabel` on such a node to control ONLY that display text; the
  // node's real `id` keeps being used for every data-* attribute and every
  // lookup, and the Deceivable Mode settings panel (and the frame-view
  // Deceivable toggle list) always show the node's real id/label regardless
  // of alias, since that's the panel where it genuinely is a togglable
  // bias. Nodes without an alias display exactly as before.
  function evidenceDisplayId(n){ return (n && n.alias) ? n.alias : (n ? n.id : ''); }
  function evidenceDisplayLabel(n){ return (n && n.alias && n.aliasLabel) ? n.aliasLabel : (n ? n.label : ''); }

  // Normalizes a bias node's `label` (e.g. "Authority Bias") into the slug
  // its BIAS_GLOSSARY entry is keyed by ("authority-bias"). Scenario files
  // don't need to know the glossary exists — this is the only coupling.
  function biasSlug(label){
    return (label || '').toLowerCase().trim().replace(/\s+/g, '-');
  }
  // Wraps a bias term in a link to its glossary entry, IF that term has one.
  // Returns the plain text unchanged if there's no matching glossary entry,
  // so callers can use this unconditionally and fall back gracefully for
  // unrecognized labels. Gives the link itself a stable id (ref-<slug>) so
  // the matching glossary entry's "Back" link has somewhere to return to —
  // each term is only ever referenced from one place in the Console tab, so
  // a single static id per slug is enough.
  function biasTermLink(label){
    const slug = biasSlug(label);
    const g = BayesEngine.BIAS_GLOSSARY && BayesEngine.BIAS_GLOSSARY[slug];
    if(!label) return '';
    if(!g) return label;
    return `<a href="#glossary-${slug}" id="ref-${slug}" class="glossary-link">${label}</a>`;
  }

  // Small "?" popover next to a toggle label in the frame-view perceived-
  // risk panel, showing that term's BIAS_GLOSSARY `popup` text (a short,
  // independently-written first clause of the full definition — not a
  // truncation of it, so it can read cleanly on its own). Pure CSS
  // hover/focus reveal (see .bias-info-btn/.bias-popup in the stylesheets)
  // rather than a native `title` attribute or any JS show/hide: a real
  // <button> means it's reachable and shows on keyboard focus (Tab), not
  // only mouse hover, and a tap on it triggers :focus on touch devices too.
  // Returns '' for any label with no matching glossary entry, so callers
  // can use it unconditionally.
  function popupHtml(label){
    const slug = biasSlug(label);
    const g = BayesEngine.BIAS_GLOSSARY && BayesEngine.BIAS_GLOSSARY[slug];
    if(!g || !g.popup) return '';
    return `<span class="bias-info-wrap"><button type="button" class="bias-info-btn" aria-describedby="popup-${slug}">?<span class="sr-only"> What is ${g.term}?</span></button>` +
      `<span class="bias-popup" role="tooltip" id="popup-${slug}">${g.popup}</span></span>`;
  }

  /* =========================================================================
     FRAME WORKING SET — lets the Frames tab reorder and/or deselect frames
     for the next run, independent of the fixed order given in the scenario
     file. S.FRAMES itself is never mutated.
     ========================================================================= */
  function currentScenarioId(){ return (S && S.__scenarioId) || 'default'; }

  // Resets THIS scenario's working set back to the scenario file's own
  // order/full-inclusion, and makes it current. Used on first load of a
  // scenario that's never been touched this session, and by the Frames
  // tab's "Reset to scenario order" button. The scenario file's first and
  // last frames are always placed at position 0 and the final position and
  // always included — see the "fixed frame" note on computeFrames() below
  // for why those two positions are never allowed to move after this.
  function resetFrameWorkingSet(){
    const n = S.FRAMES.length;
    const middle = [];
    for(let i=1;i<n-1;i++) middle.push(i);
    const order = (n <= 1) ? [0] : [0].concat(middle).concat([n-1]);
    const included = {};
    order.forEach(i => { included[i] = true; });
    frameWorkingSets[currentScenarioId()] = { frameOrder: order, frameIncluded: included };
    frameOrder = order;
    frameIncluded = included;
  }

  // Restores this scenario's own working set if one already exists from
  // earlier in the session (i.e. we've switched away and back), otherwise
  // starts a fresh one from the scenario file's order. Every edit made via
  // the Frames tab mutates frameOrder/frameIncluded in place, so once
  // loaded here they stay in sync with frameWorkingSets automatically —
  // no separate "save" step is needed when switching away again.
  function loadFrameWorkingSet(){
    const id = currentScenarioId();
    const existing = frameWorkingSets[id];
    if(existing){
      frameOrder = existing.frameOrder;
      frameIncluded = existing.frameIncluded;
    } else {
      resetFrameWorkingSet();
    }
  }

  // Builds the actual playback sequence from frameOrder/frameIncluded.
  // frameOrder[0] and frameOrder[frameOrder.length-1] are always the
  // scenario file's own first and last frame (see resetFrameWorkingSet
  // and the Frames tab UI, which refuse to move or exclude those two
  // positions), so the sequence's opening and decision frames are
  // guaranteed fixed. Whichever frame ends up last in the working
  // sequence ALWAYS becomes the isFinal decision frame — borrowing
  // timer/timeout settings from that frame's own values, or the
  // scenario's original final frame as a fallback. Any other frame that
  // happens to carry isFinal has it stripped, so exactly one frame is
  // ever final.
  function computeFrames(){
    const originals = S.FRAMES;
    let seq = frameOrder.filter(idx => frameIncluded[idx]).map(idx => originals[idx]);
    if(seq.length === 0) seq = [originals[0]]; // safety net; the Frames tab UI prevents this

    const templateFinal = originals.find(f => f.isFinal) || originals[originals.length-1];
    return seq.map((f, i) => {
      const isLast = (i === seq.length - 1);
      if(isLast){
        return Object.assign({}, f, {
          isFinal: true,
          timerSeconds: f.timerSeconds || templateFinal.timerSeconds || 20,
          timeoutAction: f.timeoutAction || templateFinal.timeoutAction || ACTIONS[0],
        });
      }
      return f.isFinal ? Object.assign({}, f, { isFinal: false }) : f;
    });
  }

  // Called whenever the Frames tab changes the order/selection. Recomputes
  // FRAMES and restarts playback (old frame indices are meaningless against
  // the new sequence) without leaving the Frames tab.
  function applyFrameWorkingSetChange(){
    FRAMES = computeFrames();
    stopTimer();
    frameIdx = 0; finalized = false; lastChoice = null; lastTimedOut = false; timerRemaining = 20;
    perceivedRiskRevealed = false;
    resetQuiz(); pendingDecisionRecord = null;
    renderFramesTab();
  }

  /* =========================================================================
     CHROME BUILD — tabs, frame counter length, action buttons, panel
     skeletons. Everything here is derived from SCENARIO, not hardcoded.
     Rebuilt fresh by initIncidentConsole() every time the scenario changes.
     ========================================================================= */
  function buildActionButtons(){
    const row = el('actionRow');
    row.innerHTML = ACTIONS.map(a =>
      `<button class="actbtn ${a}" data-action="${a}">${S.UI.actionLabels[a] || a}</button>`
    ).join('');
  }

  function euRowHtml(valuesByAction, bestAction, highlightedActions){
    highlightedActions = highlightedActions || [];
    return ACTIONS.map(a => {
      const chosen = (a === bestAction) ? ' chosen' : '';
      const shifted = highlightedActions.indexOf(a) !== -1;
      const shiftedClass = shifted ? ' toggle-shifted' : '';
      const title = shifted ? ' title="Toggling a bias just changed this value, even though it didn\u2019t change the recommended action or the risk shown above."' : '';
      return `<div class="eu-stat ${a}${chosen}${shiftedClass}"${title}><div class="lbl">${S.UI.actionLabels[a]||a}</div><div class="val">${valuesByAction[a].toFixed(1)}</div></div>`;
    }).join('');
  }

  // Captured right before a toggle in the Deceivable panel (a bias switch,
  // the q switch, or the order-dependent-updating switch) mutates state, so
  // the render that follows can tell which action's score moved AS A DIRECT
  // RESULT of that one flip — as opposed to comparing against the Rational
  // network in general, which can't say "did THIS click change anything."
  // Consumed (reset to null) by the very next paint regardless of what
  // triggered it, so navigating frames or switching modes afterward never
  // carries a stale highlight forward — it only ever reflects the most
  // recent toggle flip, and only for the one render right after it.
  let toggleBeforeSnapshot = null;
  function snapshotDeceivableNow(){
    if(mode !== 'deceivable') return null; // panel not visible — nothing to compare against
    const ev = evidenceUpTo(frameIdx);
    const evSteps = evidenceStepsUpTo(frameIdx);
    const dPost = deceivableNet.posterior(orderSensitive ? evSteps : [ev], toggles, effectiveQ(), orderSensitive ? currentWeights() : batchWeights(frameIdx));
    const dResult = deceivableNet.decide(dPost.combos, S.utilityFn, ACTIONS, ev, toggles);
    return {
      pRisk: dPost.marginals[S.UI.targetHiddenNode][S.UI.targetValue],
      best: dResult.best,
      scores: dResult.scores,
    };
  }
  // Compares the just-painted deceivable result against a snapshot taken
  // right before the triggering toggle flip. Only flags an action when
  // NOTHING else about it is already visible: the risk % (displayed
  // precision) and the recommended action both have to be unchanged, or
  // the change is already obvious elsewhere and doesn't need a highlight.
  function actionsShiftedSinceSnapshot(newMarginals, newResult, snapshot){
    if(!snapshot) return [];
    const newRisk = newMarginals[S.UI.targetHiddenNode][S.UI.targetValue];
    if(fmtPct(newRisk) !== fmtPct(snapshot.pRisk)) return [];
    if(newResult.best !== snapshot.best) return [];
    return ACTIONS.filter(a => newResult.scores[a].toFixed(1) !== snapshot.scores[a].toFixed(1));
  }

  function buildPanelSkeletons(){
    const slot = el('infoSlot');

    let html = `
      <div class="hud story-hud hidden" id="storyPanel">
        <div class="hud-top"></div>
        <div class="hud-body" style="display:block;">
          <div class="hud-label">How to use Story Mode</div>
          <p class="story-instructions">Step through the frames and consider whether you should ${ACTIONS.map(a => S.UI.actionLabels[a] || a).reduce((s, a, i, arr) => s + (i === 0 ? '' : i === arr.length - 1 ? ' or ' : ', ') + a, '')}. <br>At the end of the sequence, you'll make a decision.</p>
          <!--<p class="story-instructions">You'll make that call for real at the final frame. Switch to Rational Mode or Deceivable Mode afterwards to see how a purely rational reasoner, and a reasoner susceptible to bias, would each score the same decision at every point along the way.</p>-->
        </div>
      </div>

      <div class="hud hidden" id="rationalHud">
        <div class="hud-top"></div>
        <div class="hud-body">
          <div class="hud-metric">
            <div class="hud-label">${S.UI.rationalLabel}</div>
            <div class="hud-value" id="rationalPFire">0%</div>
          </div>
        </div>
        <div class="eu-row-label">Recommended action based on estimated reward/penalty:</div>
        <div class="eu-row" id="rationalEURow"></div>
      </div>

      <div class="hud hidden" id="deceivableHud">
        <div class="hud-top"></div>
        <div class="hud-body">
          <div class="hud-metric">
            <div class="hud-label">${S.UI.deceivableLabel}</div>
            <div class="hud-value" id="deceivablePFire">0%</div>
          </div>
        </div>
        <div class="eu-row-label">Recommended action based on biased estimates of reward/penalty:</div>
        <div class="eu-row" id="deceivableEURow"></div>
        <div class="toggles" id="toggleRow"></div>
      </div>`;
    slot.innerHTML = html;

    // one on/off toggle per bias node — generic, any count. The settings
    // themselves (mode, weight, magnitude, etc.) are NOT shown here; this
    // panel only ever offers the switch to turn a triggered bias off or
    // back on. Settings live exclusively in the Console tab.
    const toggleRow = el('toggleRow');
    toggleRow.innerHTML = biasNodes.map(n => {
      return `<div class="toggle-item" data-bias-wrap="${n.id}">
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" data-toggle="${n.id}" ${toggles[n.id]?'checked':''}><span class="slider"></span></label>
          <label>${n.toggleLabel || ('Apply ' + n.id)}</label>${popupHtml(n.label)}
        </div>
      </div>`;
    }).join('') + `
      <div class="toggle-item" data-control-wrap="q">
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" id="qToggle" ${qEnabled?'checked':''}><span class="slider"></span></label>
          <label>Apply confirmation bias (q)</label>${popupHtml('Confirmation bias')}
        </div>
      </div>
      <div class="toggle-item" data-control-wrap="order">
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" id="orderToggle" ${orderSensitive?'checked':''}><span class="slider"></span></label>
          <label>Apply order-dependent updating</label>${popupHtml('Order-dependent updating')}
        </div>
      </div>`;

    toggleRow.querySelectorAll('[data-toggle]').forEach(cb=>{
      cb.addEventListener('change', e=>{
        const id = e.target.dataset.toggle;
        toggleBeforeSnapshot = snapshotDeceivableNow();
        toggles[id] = e.target.checked;
        syncBiasToggle(id);
        render();
      });
    });

    el('qToggle').addEventListener('change', e=>{ toggleBeforeSnapshot = snapshotDeceivableNow(); qEnabled = e.target.checked; syncQControls(); render(); });
    el('orderToggle').addEventListener('change', e=>{ toggleBeforeSnapshot = snapshotDeceivableNow(); orderSensitive = e.target.checked; syncQControls(); render(); });
  }

  /* =========================================================================
     RENDER
     ========================================================================= */
  function render(){
    if(!FRAMES){
      console.error('render() called before initIncidentConsole() had finished — window.SCENARIO was not ready yet.');
      return;
    }
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===mode));
    el('viewer').classList.toggle('hidden', mode==='console' || mode==='frames');
    el('consoleTab').classList.toggle('hidden', mode!=='console');
    el('framesTab').classList.toggle('hidden', mode!=='frames');
    if(mode==='console'){ renderConsole(); return; }
    if(mode==='frames'){ renderFramesTab(); return; }

    const f = FRAMES[frameIdx];
    el('frameNum').textContent = frameIdx + 1;
    el('frameTotal').textContent = FRAMES.length;

    const dotsEl = el('frameDots');
    dotsEl.innerHTML = '';
    FRAMES.forEach((fr,i)=>{
      const d = document.createElement('div');
      d.className = 'dot' + (i<frameIdx?' done':'') + (i===frameIdx?' current':'');
      dotsEl.appendChild(d);
    });

    const img = el('shotImg');
    const placeholder = el('shotPlaceholder');
    // Owned entirely here rather than via inline onload/onerror HTML
    // attributes, so there's exactly one source of truth for how the
    // image/placeholder toggle behaves, and it's safe to re-run every call.
    img.onload = function(){ img.style.display = 'block'; placeholder.style.display = 'none'; };
    img.onerror = function(){ img.style.display = 'none'; placeholder.style.display = 'flex'; };
    if(img.getAttribute('src') !== f.file){
      img.style.display = 'none';
      placeholder.style.display = 'flex';
      img.src = f.file;
      // For a cached/local-file image the browser can finish loading (or
      // fail) synchronously within this same assignment, in which case the
      // 'load'/'error' event may already have been missed by the handlers
      // just attached above — img.complete tells us definitively.
      if(img.complete){
        if(img.naturalWidth > 0){ img.style.display = 'block'; placeholder.style.display = 'none'; }
        else { img.style.display = 'none'; placeholder.style.display = 'flex'; }
      }
    } else if(img.complete){
      if(img.naturalWidth > 0){ img.style.display = 'block'; placeholder.style.display = 'none'; }
      else { img.style.display = 'none'; placeholder.style.display = 'flex'; }
    }
    el('shotDesc').textContent = f.desc;
    el('shotFile').textContent = '512×512 — ' + f.file;
    el('caption').innerHTML = f.caption;

    const ev = evidenceUpTo(frameIdx);
    const evSteps = evidenceStepsUpTo(frameIdx);
    const rationalHud = el('rationalHud');
    const deceivableHud = el('deceivableHud');

    if(mode==='story'){
      el('storyPanel').classList.toggle('hidden', frameIdx !== 0);
      rationalHud.classList.add('hidden');
      deceivableHud.classList.add('hidden');
    } else {
      el('storyPanel').classList.add('hidden');
      rationalHud.classList.remove('hidden');
      // The rational network ALWAYS folds evidence frame-by-frame,
      // regardless of the order-dependent-updating toggle — it never
      // receives a q (always the q=0.5 default), and at q=0.5 sequential
      // per-step folding is provably order-independent and correctly
      // compounds a repeated observation (e.g. the alarm sounding twice)
      // by design, so there is nothing for the toggle to meaningfully
      // change here. The toggle exists to control how the DECEIVABLE
      // network folds evidence when q genuinely makes order matter — see
      // batchWeights() above for how batch mode stays mathematically
      // equivalent to sequential mode despite folding into one flat step.
      const rPost = rationalNet.posterior(evSteps, {});
      const rResult = rationalNet.decide(rPost.combos, S.utilityFn, ACTIONS, ev, {});
      paintPanel('rational', rPost.marginals, rResult);

      if(mode==='rational'){
        deceivableHud.classList.add('hidden');
      } else {
        const dPost = deceivableNet.posterior(orderSensitive ? evSteps : [ev], toggles, effectiveQ(), orderSensitive ? currentWeights() : batchWeights(frameIdx));
        const dResult = deceivableNet.decide(dPost.combos, S.utilityFn, ACTIONS, ev, toggles);
        const toggleShifted = actionsShiftedSinceSnapshot(dPost.marginals, dResult, toggleBeforeSnapshot);
        toggleBeforeSnapshot = null; // consumed — only ever reflects the render right after a toggle flip
        paintPanel('deceivable', dPost.marginals, dResult, toggleShifted);

        // The perceived-risk panel only pops into view once its figure
        // actually diverges from the rational panel's figure (compared at
        // displayed precision, since a discrepancy invisible to the user
        // isn't an alert) — and once revealed, it stays visible for the
        // rest of this run through the sequence, even if a later toggle
        // brings the two figures back into agreement.
        const rPRisk = rPost.marginals[S.UI.targetHiddenNode][S.UI.targetValue];
        const dPRisk = dPost.marginals[S.UI.targetHiddenNode][S.UI.targetValue];
        if(fmtPct(rPRisk) !== fmtPct(dPRisk)) perceivedRiskRevealed = true;
        deceivableHud.classList.toggle('hidden', !perceivedRiskRevealed);

        // Each control becomes visible once the evidence that could trigger
        // it has actually appeared in the story — a structural check, not a
        // "does it currently move the numbers" check. That matters: a
        // control can genuinely have zero effect right now because some
        // OTHER active bias already accounts for it, and a check based on
        // current numeric impact would hide it — including hiding it right
        // after you switch it off yourself, with no way to switch it back
        // on. Structural visibility never depends on toggle state, so it
        // can't be caused or fixed by toggling.
        biasNodes.forEach(n => {
          const revealed = ev[n.id] !== undefined && ev[n.id] !== null;
          const wrap = el('toggleRow').querySelector(`[data-bias-wrap="${n.id}"]`);
          if(wrap) wrap.classList.toggle('hidden', !revealed);
        });

        const hasAnyEvidence = deceivableNet.evidenceLikeNodes.some(n => ev[n.id]!==undefined && ev[n.id]!==null);
        const qWrap = el('toggleRow').querySelector('[data-control-wrap="q"]');
        if(qWrap) qWrap.classList.toggle('hidden', !hasAnyEvidence);

        const evidenceBearingSteps = evSteps.filter(step => deceivableNet.evidenceLikeNodes.some(n => step[n.id]!==undefined && step[n.id]!==null)).length;
        const orderWrap = el('toggleRow').querySelector('[data-control-wrap="order"]');
        if(orderWrap) orderWrap.classList.toggle('hidden', evidenceBearingSteps < 2);
      }
    }

    const timerWrap = el('timerWrap');
    const actionRow = el('actionRow');
    const infoSlot = el('infoSlot');
    const denouementPanel = el('denouementPanel');

    el('timerValue').textContent = Math.max(timerRemaining,0);

    if(finalized){
      infoSlot.classList.add('hidden');
      timerWrap.classList.add('invisible');
      actionRow.classList.add('hidden');
      denouementPanel.classList.remove('hidden');
      el('caption').classList.add('hidden');
      paintResult();
    } else {
      infoSlot.classList.remove('hidden');
      denouementPanel.classList.add('hidden');
      actionRow.classList.toggle('hidden', !f.isFinal);
      actionRow.querySelectorAll('button').forEach(b=>b.disabled=false);
      timerWrap.classList.toggle('invisible', !f.isFinal);
      el('caption').classList.remove('hidden');
    }

    el('prevBtn').disabled = (frameIdx===0);
    el('firstBtn').disabled = (frameIdx===0);
    el('nextBtn').disabled = (frameIdx===FRAMES.length-1) || (f.isFinal && !finalized);
    el('lastBtn').disabled = (frameIdx===FRAMES.length-1);
  }

  function paintPanel(which, marginals, result, highlightedActions){
    const pRisk = marginals[S.UI.targetHiddenNode][S.UI.targetValue];
    const tier = pFireTier(pRisk);
    const valEl = el(which+'PFire');
    valEl.textContent = fmtPct(pRisk);
    valEl.className = 'hud-value ' + tier;

    el(which+'EURow').innerHTML = euRowHtml(which==='deceivable' ? result.scores : result.eu, result.best, highlightedActions);
  }

  /* ---------------- timer / navigation ---------------- */
  function startTimer(){
    timerHandle = setInterval(()=>{
      timerRemaining--;
      el('timerValue').textContent = Math.max(timerRemaining,0);
      if(timerRemaining<=0){
        stopTimer();
        chooseAction(FRAMES[frameIdx].timeoutAction || ACTIONS[0], true);
      }
    },1000);
  }
  function stopTimer(){ if(timerHandle){ clearInterval(timerHandle); timerHandle=null; } }

  function goToFrame(newIdx){
    newIdx = Math.max(0, Math.min(newIdx, FRAMES.length-1));
    if(FRAMES[frameIdx].isFinal) stopTimer();
    frameIdx = newIdx;
    finalized = false; lastChoice = null; lastTimedOut = false;
    resetQuiz(); pendingDecisionRecord = null;
    if(FRAMES[frameIdx].isFinal){
      timerRemaining = FRAMES[frameIdx].timerSeconds || 20;
      startTimer();
    }
    render();
  }

  function restartSequence(){
    stopTimer();
    frameIdx = 0; finalized = false; lastChoice = null; lastTimedOut = false; timerRemaining = 20;
    perceivedRiskRevealed = false;
    resetQuiz(); pendingDecisionRecord = null;
    render();
  }

  function chooseAction(action, timedOut){
    const f = FRAMES[frameIdx];
    if(f.isFinal){
      stopTimer();
      lastChoice = action; lastTimedOut = !!timedOut; finalized = true;
      resetQuiz();
      const record = {
        scenario: (S.__scenarioId || S.UI.title || ''),
        mode: mode,
        decision: timedOut ? 'default' : (S.UI.actionLabels[action] || action),
      };
      if(mode === 'deceivable'){
        // Held until the quiz completes — see finishQuizAndSubmit() — so
        // this run's row carries the decision and both quiz answers
        // together, rather than three separate partial submissions.
        pendingDecisionRecord = record;
      } else {
        pendingDecisionRecord = null;
        logDecision(record);
      }
      render();
    } else {
      goToFrame(frameIdx+1);
    }
  }

  // The outcome panel and its quiz compare Rational against "fully
  // deceived" for the CURRENT Control Panel settings (weight/mode/stance/q
  // magnitude) — not against whatever the live toggles happen to be left
  // at. The live toggles in the Deceivable HUD are for mid-story
  // experimentation ("what does switching this off do right now"); the
  // outcome comparison at the decision point always means every triggered
  // bias switched ON, regardless of what was being experimented with along
  // the way. This is the one map every outcome/quiz computation below uses
  // instead of the live `toggles` object.
  function allOnToggles(){
    const t = {};
    biasNodes.forEach(n => { t[n.id] = true; });
    return t;
  }

  // Every candidate the end-of-sequence quiz can ask about: every bias node
  // that actually had a value revealed by the given frame (accounting for
  // whatever the Frames tab may have reordered or excluded, not just
  // "defined in this scenario"), PLUS confirmation bias
  // and order-dependent updating themselves when they're genuinely doing
  // something at the CURRENT Control Panel settings. Unlike a scenario's
  // bias nodes, these two are global processing-mode settings rather than
  // something a specific frame reveals, so "applies to this run" means
  // "currently active", not "was revealed" — and each is only listed when
  // switching it off could actually change anything: confirmation bias only
  // if it's enabled AND not already sitting at its own neutral value
  // (q=0.5 is plain, unweighted Bayes — indistinguishable from "off"), and
  // order-dependent updating only under those same q conditions, since (as
  // its own glossary entry says) it has no effect at all when q=0.5 either
  // way. Every candidate shares one shape — {id, label, offConfig} — so
  // node-level and global candidates can be tested identically below.
  // offConfig is the fully-deceived baseline with just that one candidate
  // switched off; baseConfig is the baseline itself.
  function quizCandidatesAt(idx){
    const ev = evidenceUpTo(idx);
    const baseToggles = allOnToggles();
    const baseConfig = { toggles: baseToggles, q: effectiveQ(), order: orderSensitive };

    const candidates = biasNodes
      .filter(n => ev[n.id] !== undefined && ev[n.id] !== null)
      .map(n => ({
        id: n.id, label: n.label,
        offConfig: { toggles: Object.assign({}, baseToggles, { [n.id]: false }), q: baseConfig.q, order: baseConfig.order }
      }));

    const qActive = qEnabled && qMagnitude !== 0.5;
    if(qActive){
      candidates.push({
        id: '__q', label: 'Confirmation bias',
        offConfig: { toggles: baseToggles, q: 0.5, order: baseConfig.order }
      });
    }
    if(orderSensitive && qActive){
      candidates.push({
        id: '__order', label: 'Order-dependent updating',
        offConfig: { toggles: baseToggles, q: baseConfig.q, order: false }
      });
    }

    return { baseConfig, candidates };
  }

  // Runs the deceivable network for one {toggles, q, order} configuration —
  // the one computation every quiz candidate test below is built from.
  function computeDeceivedResult(idx, config){
    const ev = evidenceUpTo(idx);
    const evSteps = evidenceStepsUpTo(idx);
    const post = deceivableNet.posterior(
      config.order ? evSteps : [ev], config.toggles, config.q,
      config.order ? currentWeights(config.toggles) : batchWeights(idx, config.toggles)
    );
    const result = deceivableNet.decide(post.combos, S.utilityFn, ACTIONS, ev, config.toggles);
    return { post, result };
  }

  // Which single candidate moved PERCEIVED RISK the most, measured by
  // switching just that one off (everything else at the fully-deceived
  // baseline — see quizCandidatesAt) and comparing the resulting risk to
  // the baseline. biasDecision nodes (SP, OB, ...) never touch belief at
  // all, so their delta always computes to 0 here — that's not a bug, it's
  // the honest answer to THIS specific question: a decision-layer bias can
  // shift which action looks best without ever moving the risk percentage
  // itself (see computeBiasDecisionWinner for the complementary question).
  // If every candidate's delta is negligible, there is no meaningful
  // "biggest contributor to risk" to report.
  function computeBiasRiskWinner(idx, quizCands){
    const { baseConfig, candidates } = quizCands;
    const baseline = computeDeceivedResult(idx, baseConfig);
    const currentRisk = baseline.post.marginals[S.UI.targetHiddenNode][S.UI.targetValue];
    let best = null;
    candidates.forEach(c=>{
      const test = computeDeceivedResult(idx, c.offConfig);
      const testRisk = test.post.marginals[S.UI.targetHiddenNode][S.UI.targetValue];
      const delta = Math.abs(currentRisk - testRisk);
      if(!best || delta > best.delta) best = { id: c.id, label: c.label, delta };
    });
    const meaningful = !!best && best.delta >= 0.0005; // below ~0.05 displayed points — nothing visibly moved
    return meaningful ? best : null;
  }

  // Which single candidate moved the DECISION the most — the complementary
  // question to computeBiasRiskWinner, and the one a decision-layer bias
  // (Social proof, Obedience...) can actually win. "Moved the decision" is
  // measured as REGRET recovered: regret of an action is how much worse its
  // rational (unbiased) expected utility is than the rational network's own
  // best action — i.e. how much worse off you are, by the rational agent's
  // own yardstick, for ending up with that pick instead. Switching one
  // candidate off (everything else at the fully-deceived baseline) and
  // seeing how much regret that removes credits every mechanism fairly: a
  // belief-layer bias contributes by changing which action even looks
  // good; a decision-layer bias contributes by penalizing an action
  // regardless of how good it looks; confirmation bias and order-dependent
  // updating contribute by however they've distorted either of those. If no
  // single candidate's removal reduces regret at all — either because none
  // of them individually flip the pick, or because the fully-deceived pick
  // already matches the rational one — there is no meaningful "biggest
  // contributor to the decision".
  function computeBiasDecisionWinner(idx, quizCands){
    const { baseConfig, candidates } = quizCands;
    const ev = evidenceUpTo(idx);
    const evSteps = evidenceStepsUpTo(idx);
    const rPost = rationalNet.posterior(evSteps, {});
    const rResult = rationalNet.decide(rPost.combos, S.utilityFn, ACTIONS, ev, {});
    const rationalEU = rResult.eu; // per-action EU under rational belief — the fixed, bias-free yardstick

    const baseline = computeDeceivedResult(idx, baseConfig);
    const baselineRegret = rationalEU[rResult.best] - rationalEU[baseline.result.best]; // >= 0 always, since rResult.best maximizes rationalEU by construction

    let best = null;
    candidates.forEach(c=>{
      const test = computeDeceivedResult(idx, c.offConfig);
      const testRegret = rationalEU[rResult.best] - rationalEU[test.result.best];
      const delta = baselineRegret - testRegret; // regret RECOVERED by removing just this candidate — can be ~0 (no help) or, rarely, negative (an interaction effect made things worse without it)
      if(!best || delta > best.delta) best = { id: c.id, label: c.label, delta };
    });
    const meaningful = !!best && best.delta > 1e-9; // any genuine positive recovery — this is a utility-scale quantity, not a percentage, so no displayed-precision threshold applies
    return meaningful ? best : null;
  }

  // Combines the risk-winner and decision-winner into the single Q1
  // feedback line, per the four cases that are actually possible: both
  // point to the same candidate, they point to different candidates, only
  // one question has a meaningful winner, or neither does. Returns
  // { tone, html } — tone drives the CSS class (see .quiz-feedback.*).
  function buildQ1Feedback(answerId, riskWinner, decisionWinner){
    if(!riskWinner && !decisionWinner){
      return { tone:'neutral', html:`Unusually, biases impacted neither the risk nor the decision.` };
    }
    if(riskWinner && !decisionWinner){
      const correct = answerId === riskWinner.id;
      return { tone: correct?'correct':'incorrect',
        html: (correct?'Correct! ':'Actually, ') + `<b>${riskWinner.label}</b> had the biggest impact on the perceived risk.` };
    }
    if(!riskWinner && decisionWinner){
      const correct = answerId === decisionWinner.id;
      return { tone: correct?'correct':'incorrect',
        html: (correct?'Correct! ':'Actually, ') + `<b>${decisionWinner.label}</b> had the biggest impact on the decision.` };
    }
    // both exist
    if(riskWinner.id === decisionWinner.id){
      const correct = answerId === riskWinner.id;
      return { tone: correct?'correct':'incorrect',
        html: (correct?'Correct! ':'Actually, ') + `<b>${riskWinner.label}</b> had the biggest impact on both the perceived risk and the decision.` };
    }
    if(answerId === riskWinner.id){
      return { tone:'partial', html: `You're right that <b>${riskWinner.label}</b> had the biggest impact on the perceived risk \u2014 but it was <b>${decisionWinner.label}</b> that had the greatest impact on the decision.` };
    }
    if(answerId === decisionWinner.id){
      return { tone:'partial', html: `You're right that <b>${decisionWinner.label}</b> had the greatest impact on the decision \u2014 but it was <b>${riskWinner.label}</b> that had the biggest impact on the perceived risk.` };
    }
    return { tone:'incorrect', html: `Actually, <b>${riskWinner.label}</b> had the biggest impact on the perceived risk, while <b>${decisionWinner.label}</b> had the greatest impact on the decision.` };
  }

  function paintResult(){
    const ev = evidenceUpTo(frameIdx);
    const evSteps = evidenceStepsUpTo(frameIdx);
    const actionLabel = (S.UI.actionLabels[lastChoice]||lastChoice).toUpperCase();
    let line;
    if(mode==='story'){
      line = `You chose to <b>${actionLabel}</b>${lastTimedOut?' (time ran out — default action taken)':''}.`;
    } else {
      let pRisk, result, label;
      if(mode==='rational'){
        const post = rationalNet.posterior(evSteps, {});
        result = rationalNet.decide(post.combos, S.utilityFn, ACTIONS, ev, {});
        pRisk = post.marginals[S.UI.targetHiddenNode][S.UI.targetValue];
        label = S.UI.rationalLabel.toLowerCase();
        line = `You chose <b>${actionLabel}</b>${lastTimedOut?' (time ran out — default action taken)':''}. `
          + `At this point the ${label} was <b>${fmtPct(pRisk)}</b> and the recommended action was <b>${S.UI.actionLabels[result.best]||result.best}</b>.`;
      } else {
        // "You chose..." always compares against the fully-deceived agent
        // (every triggered bias ON, at the current Control Panel
        // weight/mode/stance/q settings) — never the live toggle state,
        // which reflects whatever mid-story experimenting was going on.
        // See allOnToggles() for why.
        const outcomeToggles = allOnToggles();
        const post = deceivableNet.posterior(orderSensitive ? evSteps : [ev], outcomeToggles, effectiveQ(), orderSensitive ? currentWeights(outcomeToggles) : batchWeights(frameIdx, outcomeToggles));
        result = deceivableNet.decide(post.combos, S.utilityFn, ACTIONS, ev, outcomeToggles);
        pRisk = post.marginals[S.UI.targetHiddenNode][S.UI.targetValue];
        label = S.UI.deceivableLabel.toLowerCase();
        line = `You chose <b>${actionLabel}</b>${lastTimedOut?' (time ran out — default action taken)':''}. `
          + `At this point the ${label} was <b>${fmtPct(pRisk)}</b> and, according to the model, most people would choose <b>${S.UI.actionLabels[result.best]||result.best}</b>.`;
      }
    }
    const modeLabelMap = { story:'Story Mode', rational:'Rational Mode', deceivable:'Deceivable Mode' };
    const nextModeMap = { story:'rational', rational:'deceivable', deceivable:'story' };
    const nextMode = nextModeMap[mode];
    const nextLabel = modeLabelMap[nextMode];
    const secondSentenceMap = {
      story: `Switch to <b>${nextLabel}</b> and see if that's still what you think.`,
      rational: `Switch to <b>${nextLabel}</b> to see what factors may have influenced your previous decision.`,
      deceivable: `Switch back to <b>${nextLabel}</b> and see if you can now recognise the biases that were at work.`
    };
    const secondSentence = `That's the end of the sequence in <b>${modeLabelMap[mode]}</b>. ${secondSentenceMap[mode]}`;

    if(mode === 'deceivable'){
      renderDeceivableOutcome(line, modeLabelMap[mode], secondSentence, nextLabel);
      return;
    }

    el('denouementPanel').innerHTML = `
      <div class="hud-top"></div>
      <div class="hud-body" style="display:block;">
        <div class="hud-label">Outcome \u2014 ${modeLabelMap[mode]}</div>
        <p class="story-instructions">${line}</p>
        <p class="story-instructions">${secondSentence}</p>
        <button id="inviteBtn" class="denouement-btn">Switch to ${nextLabel}</button>
      </div>`;
    el('inviteBtn').onclick = ()=>{ mode = nextMode; restartSequence(); };
  }

  // Deceivable-mode-only outcome panel: the same opening paragraph, THEN a
  // two-question quiz before the usual closing sentence/button appear —
  // "Which bias made the biggest difference" (with a live-computed correct
  // answer, see computeBiasRiskWinner) and "Which bias has the biggest
  // influence on you" (self-report, no right answer). Rebuilds its own
  // innerHTML and rewires its own listeners on every call, the same
  // rebuild-the-whole-blob pattern used everywhere else in this file —
  // each answer just mutates the quiz state vars and calls this again.
  function renderDeceivableOutcome(line, modeLabel, secondSentence, nextLabel){
    const quizCands = quizCandidatesAt(frameIdx);
    const candidates = quizCands.candidates;

    let html = `<div class="hud-top"></div><div class="hud-body" style="display:block;">` +
      `<div class="hud-label">Outcome \u2014 ${modeLabel}</div>` +
      `<p class="story-instructions">${line}</p>`;

    // Nothing to quiz on this run — no bias node was revealed (e.g. every
    // relevant frame was excluded via the Frames tab), AND confirmation
    // bias / order-dependent updating aren't genuinely active either — so
    // skip straight to the closing sentence exactly as story/rational do.
    if(candidates.length === 0){
      html += `<p class="story-instructions">${secondSentence}</p>` +
        `<button id="inviteBtn" class="denouement-btn">Switch to ${nextLabel}</button></div>`;
      el('denouementPanel').innerHTML = html;
      el('inviteBtn').onclick = ()=>{ mode = 'story'; restartSequence(); };
      return;
    }

    // ---- Q1: which bias made the biggest difference (has a correct answer) ----
    html += `<div class="quiz-block">` +
      `<p class="quiz-question">Which bias do you think made the biggest difference to the \u2018deceived\u2019 outcome?</p>` +
      `<div class="quiz-options">` + candidates.map(c =>
        `<button type="button" class="quiz-option${quiz1Answer===c.id?' selected':''}" data-quiz1="${c.id}" ${quiz1Answer?'disabled':''}>${c.label}</button>`
      ).join('') + `</div>`;

    const riskWinner = quiz1Answer ? computeBiasRiskWinner(frameIdx, quizCands) : null;
    const decisionWinner = quiz1Answer ? computeBiasDecisionWinner(frameIdx, quizCands) : null;
    if(quiz1Answer){
      const feedback = buildQ1Feedback(quiz1Answer, riskWinner, decisionWinner);
      html += `<p class="quiz-feedback ${feedback.tone}">${feedback.html}</p>`;
    }
    html += `</div>`;

    // ---- Q2: which bias has the biggest influence on the PERSON (self-report, no right answer) ----
    if(quiz1Answer){
      html += `<div class="quiz-block">` +
        `<p class="quiz-question">Which bias do you think has the biggest influence on <i>you</i>?</p>`;
      if(quiz2Answer === null){
        const opts = candidates.map(c => ({ id:c.id, label:c.label })).concat([{ id:'none', label:'None' }, { id:'other', label:'Other' }]);
        html += `<div class="quiz-options">` + opts.map(o =>
          `<button type="button" class="quiz-option${quiz2ShowOtherInput && o.id==='other' ? ' selected' : ''}" data-quiz2="${o.id}">${o.label}</button>`
        ).join('') + `</div>`;
        if(quiz2ShowOtherInput){
          html += `<div class="quiz-other-input">` +
            `<input type="text" id="quiz2OtherInput" maxlength="25" placeholder="Say a bit more (25 chars)">` +
            `<button type="button" id="quiz2OtherSubmit">OK</button></div>`;
        }
      } else {
        html += `<p class="quiz-feedback">Interesting - thank you!</p>`;
      }
      html += `</div>`;
    }

    // ---- Closing sentence — only once Q2 is answered ----
    if(quiz2Answer !== null){
      html += `<p class="story-instructions">${secondSentence}</p>` +
        `<button id="inviteBtn" class="denouement-btn">Switch to ${nextLabel}</button>`;
    }

    html += `</div>`;
    const panel = el('denouementPanel');
    panel.innerHTML = html;

    if(!quiz1Answer){
      panel.querySelectorAll('[data-quiz1]').forEach(btn => {
        btn.addEventListener('click', e => {
          quiz1Answer = e.currentTarget.dataset.quiz1;
          renderDeceivableOutcome(line, modeLabel, secondSentence, nextLabel);
        });
      });
    }

    if(quiz1Answer && quiz2Answer === null){
      panel.querySelectorAll('[data-quiz2]').forEach(btn => {
        btn.addEventListener('click', e => {
          const val = e.currentTarget.dataset.quiz2;
          if(val === 'other'){
            quiz2ShowOtherInput = true;
            renderDeceivableOutcome(line, modeLabel, secondSentence, nextLabel);
          } else {
            quiz2Answer = val;
            finishQuizAndSubmit(quizCands);
            renderDeceivableOutcome(line, modeLabel, secondSentence, nextLabel);
          }
        });
      });
      if(quiz2ShowOtherInput){
        const input = el('quiz2OtherInput');
        const submitBtn = el('quiz2OtherSubmit');
        const submitOther = ()=>{
          const text = (input.value || '').trim().slice(0, 25);
          if(!text) return;
          quiz2Answer = 'other';
          quiz2OtherText = text;
          finishQuizAndSubmit(quizCands);
          renderDeceivableOutcome(line, modeLabel, secondSentence, nextLabel);
        };
        if(submitBtn) submitBtn.addEventListener('click', submitOther);
        if(input){
          input.addEventListener('keydown', e => { if(e.key === 'Enter') submitOther(); });
          input.focus();
        }
      }
    }

    const inviteBtn = el('inviteBtn');
    if(inviteBtn) inviteBtn.onclick = ()=>{ mode = 'story'; restartSequence(); };
  }

  // Combines the decision held since chooseAction() with both quiz answers
  // into one row and sends it off — see logDecision() near the top of the
  // file for the actual submission mechanics.
  function finishQuizAndSubmit(quizCands){
    if(!pendingDecisionRecord) return;
    const riskWinner = computeBiasRiskWinner(frameIdx, quizCands);
    const decisionWinner = computeBiasDecisionWinner(frameIdx, quizCands);
    const labelFor = id => (quizCands.candidates.find(c => c.id === id) || {}).label || id;
    const q2Label = quiz2Answer === 'none' ? 'None' : quiz2Answer === 'other' ? 'Other' : labelFor(quiz2Answer);
    const record = Object.assign({}, pendingDecisionRecord, {
      q1Answer: labelFor(quiz1Answer),
      q1RiskAnswer: riskWinner ? riskWinner.label : '',
      q1DecisionAnswer: decisionWinner ? decisionWinner.label : '',
      q2Answer: q2Label,
      q2OtherText: quiz2Answer === 'other' ? quiz2OtherText : '',
    });
    logDecision(record);
    pendingDecisionRecord = null;
  }

  /* =========================================================================
     CONSOLE TAB — fully generated from the node list. Assumes binary domains
     for the auto-generated prior/CPT editors (true for every node in the
     current scenario); a future scenario with a 3+-value hidden or evidence
     node would need its own editor block here, but the panels themselves
     (hud, EU rows, toggles) are already fully generic.
     ========================================================================= */
  function buildConsoleSkeleton(){
    const wrap = el('consoleTab');
    let html = '<div class="console-grid">';

    // priors
    html += '<div class="panel"><h3>Priors</h3>';
    rationalNet.hiddenNodes.forEach(n=>{
      html += `<div class="field-row"><label>P(${n.id} = ${n.domain[0]})</label>` +
        `<input type="number" step="0.01" min="0" max="1" data-prior="${n.id}" value="${n.prior[n.domain[0]]}"></div>`;
    });
    html += nodeKeyHtml(rationalNet, rationalNet.hiddenNodes.map(n=>n.id));
    html += '</div>';

    // Every control that only ever affects the deceivable network — the two
    // engine-level parameters (q, order-dependent updating) AND every bias
    // node's own params (mode/weight, etc.) — lives in this single panel,
    // with one shared Apply/Reset action row. This is the only place any of
    // these settings are editable; the Deceivable-mode panel on the frame
    // view only ever shows the on/off switches.
    html += '<div class="panel"><h3>Deceivable Mode settings</h3>' +
      '<div class="toggle-row" style="margin-bottom:8px;">' +
      `<label class="switch"><input type="checkbox" id="qToggleConsole" ${qEnabled?'checked':''}><span class="slider"></span></label>` +
      `<label>Apply ${biasTermLink('Confirmation bias')} (q)</label></div>` +
      '<div class="field-row" style="margin-bottom:14px;"><input class="mini-range" type="range" id="qMagnitudeSliderConsole" min="0" max="1" step="0.01" value="' + qMagnitude + '" style="flex:1;">' +
      '<span id="qMagnitudeLabelConsole" style="min-width:36px;text-align:right;">' + qMagnitude.toFixed(2) + '</span></div>' +
      '<div class="toggle-row" style="margin-bottom:14px;">' +
      `<label class="switch"><input type="checkbox" id="orderToggleConsole" ${orderSensitive?'checked':''}><span class="slider"></span></label>` +
      `<label>Apply ${biasTermLink('Order-dependent updating')}</label></div>`;

    const deceivableBlockIds = [];
    biasNodes.forEach(n=>{
      deceivableBlockIds.push(n.id);
      html += '<div class="toggle-row" style="margin-bottom:8px;">' +
        `<label class="switch"><input type="checkbox" data-toggleconsole="${n.id}" ${toggles[n.id]?'checked':''}><span class="slider"></span></label>` +
        `<label>${n.id} \u2014 ${biasTermLink(n.label) || n.toggleLabel || n.id}</label></div>`;
      if(n.paramSchema){
        n.paramSchema.forEach(p=>{
          if(p.type==='select'){
            html += `<div class="field-row" style="margin:0 0 8px 42px;"><label>${p.label}</label>` +
              `<select data-bparam="${n.id}:${p.key}">` + p.options.map(o=>`<option value="${o}" ${o===n.params[p.key]?'selected':''}>${o}</option>`).join('') + `</select></div>`;
          } else {
            html += `<div class="field-row" style="margin:0 0 8px 42px;"><label>${p.label}</label>` +
              `<input type="number" step="${p.step||1}" data-bparam="${n.id}:${p.key}" value="${n.params[p.key]}"></div>`;
          }
        });
      }
      // A biasBelief node's own CPT lives here too, not in the shared CPT
      // panels below — it only ever affects the deceivable network's
      // belief update, unlike a plain evidence node's CPT which is shared
      // by both networks, so it belongs with the rest of this mechanism's
      // controls rather than looking like ordinary evidence.
      if(n.type === 'biasBelief'){
        deceivableBlockIds.push(...n.parents);
        html += `<div class="bias-cpt-heading">P(${n.id} = ${n.domain[0]} | ${n.parents.join(', ')})</div>`;
        const parentDomains = {};
        n.parents.forEach(pid => parentDomains[pid] = deceivableNet.byId[pid].domain);
        BayesEngine.cartesian(parentDomains).forEach(combo=>{
          const key = n.parents.map(pid=>String(combo[pid])).join(',');
          const labelText = n.parents.map(pid=>`${pid}=${combo[pid]}`).join(', ');
          html += `<div class="field-row" style="margin:0 0 8px 42px;"><label>${labelText}</label>` +
            `<input type="number" step="0.01" min="0" max="1" data-cpt="${n.id}:${key}" value="${n.cpt[key]}"></div>`;
        });
      }
    });
    // One consolidated key for every id used anywhere in this block — every
    // bias node's own id plus every parent referenced by a biasBelief
    // node's CPT — at the bottom of the panel, same as every other block,
    // rather than a separate key nested under each node's own CPT rows.
    html += nodeKeyHtml(deceivableNet, deceivableBlockIds);

    html += '<div class="console-actions"><button id="applyBtn">Apply &amp; recompute</button><button id="resetBtn">Reset to defaults</button></div></div>';

    // plain evidence CPTs only — shared by both networks. Each biasBelief
    // node's CPT is rendered inside the Deceivable Mode settings panel
    // above instead, since it only ever affects the deceivable network.
    deceivableNet.evidenceLikeNodes.filter(n => n.type === 'evidence').forEach(n=>{
      html += `<div class="panel"><h3>P(${evidenceDisplayId(n)} = ${n.domain[0]} | ${n.parents.join(', ')})</h3>`;
      const parentDomains = {};
      n.parents.forEach(pid => parentDomains[pid] = deceivableNet.byId[pid].domain);
      BayesEngine.cartesian(parentDomains).forEach(combo=>{
        const key = n.parents.map(pid=>String(combo[pid])).join(',');
        const labelText = n.parents.map(pid=>`${pid}=${combo[pid]}`).join(', ');
        html += `<div class="field-row"><label>${labelText}</label>` +
          `<input type="number" step="0.01" min="0" max="1" data-cpt="${n.id}:${key}" value="${n.cpt[key]}"></div>`;
      });
      html += nodeKeyHtml(deceivableNet, [n.id].concat(n.parents), true);
      html += '</div>';
    });

    // utility table
    html += '<div class="panel"><h3>Utility(action, ' + S.UTILITY.utilityDependsOn.join(', ') + ')</h3>';
    const utilDomains = {};
    S.UTILITY.utilityDependsOn.forEach(id => utilDomains[id] = deceivableNet.byId[id].domain);
    ACTIONS.forEach(a=>{
      BayesEngine.cartesian(utilDomains).forEach(combo=>{
        const key = S.UTILITY.utilityDependsOn.map(id=>String(combo[id])).join(',');
        const labelText = (S.UI.actionLabels[a]||a) + ', ' + S.UTILITY.utilityDependsOn.map(id=>`${id}=${combo[id]}`).join(',');
        html += `<div class="field-row"><label>${labelText}</label>` +
          `<input type="number" step="1" data-utility="${a}:${key}" value="${S.UTILITY.utilityTable[a][key]}"></div>`;
      });
    });
    html += nodeKeyHtml(deceivableNet, S.UTILITY.utilityDependsOn);
    html += '</div>';

    // live scenario preview
    html += '<div class="panel preview"><h3>Live scenario preview</h3><div class="preview-grid">';
    deceivableNet.evidenceLikeNodes.forEach(n=>{
      const dispId = evidenceDisplayId(n), dispLabel = evidenceDisplayLabel(n);
      html += `<div><label>${dispId}${dispLabel?' \u2014 '+dispLabel:''}</label><select data-prev="${n.id}">` +
        `<option value="__null__">not observed</option>` +
        n.domain.map(v=>`<option value="${v}">${v}</option>`).join('') + `</select></div>`;
    });
    deceivableNet.biasDecisionNodes.forEach(n=>{
      html += `<div><label>${n.id}${n.label?' \u2014 '+n.label:''}</label><select data-prev="${n.id}">` +
        `<option value="__null__">not observed</option>` +
        n.domain.map(v=>`<option value="${v}">${v}</option>`).join('') + `</select></div>`;
    });
    html += '</div><div class="hud" style="margin:0;"><div class="hud-top"></div><div class="hud-body">' +
      `<div class="hud-metric"><div class="hud-label">${S.UI.deceivableLabel}</div><div class="hud-value" id="prevPFire">1%</div></div>` +
      `<div class="hud-metric"><div class="hud-label">Recommended action</div><div><span class="hud-action" id="prevAction">—</span></div></div>` +
      `<div class="hud-note" id="prevNote"></div></div></div>` +
      `<div class="eu-row" id="prevEURow" style="padding-top:14px;"></div></div>`;

    // Glossary — plain-English + "how it's modeled" for every bias term this
    // scenario actually uses (always includes confirmation bias, since q is
    // an engine-level control present in every scenario). Pulled from
    // BayesEngine.BIAS_GLOSSARY (model.js) rather than duplicated here, so
    // the wording stays identical across scenarios. Always visible, at the
    // foot of the tab; a highlighted term anywhere above jumps straight to
    // its entry here, and each entry's Back link jumps straight back to
    // where that term was clicked from.
    (function(){
      const slugs = ['confirmation-bias', 'order-dependent-updating'];
      biasNodes.forEach(n => { const s = biasSlug(n.label); if(s && slugs.indexOf(s)===-1) slugs.push(s); });
      const glossary = BayesEngine.BIAS_GLOSSARY || {};
      const entries = slugs.map(s => glossary[s]).filter(Boolean);
      if(entries.length){
        html += '<div class="panel definitions-panel"><h3>Bias &amp; decision definitions</h3>';
        entries.forEach(g => {
          const slug = biasSlug(g.term);
          html += `<div class="glossary-entry" id="glossary-${slug}">` +
            `<div class="glossary-term">${g.term} <a href="#ref-${slug}" class="glossary-back">\u2190 Back</a></div>` +
            `<div class="glossary-def">${g.definition}</div>` +
            `<div class="glossary-impl"><b>How it\u2019s modeled:</b> ${g.implementation}</div>` +
          `</div>`;
        });
        html += '</div>';
      }
    })();

    html += '</div>'; // .console-grid
    wrap.innerHTML = html;

    // wire prior/cpt/utility/param inputs — recompute preview live
    wrap.querySelectorAll('[data-prior]').forEach(i=>i.addEventListener('input', onConsoleEdit));
    wrap.querySelectorAll('[data-cpt]').forEach(i=>i.addEventListener('input', onConsoleEdit));
    wrap.querySelectorAll('[data-utility]').forEach(i=>i.addEventListener('input', onConsoleEdit));
    wrap.querySelectorAll('[data-bparam]').forEach(i=>i.addEventListener('input', onConsoleEdit));
    wrap.querySelectorAll('[data-toggleconsole]').forEach(cb=>{
      cb.addEventListener('change', e=>{
        const id = e.target.dataset.toggleconsole;
        toggles[id] = e.target.checked;
        syncBiasToggle(id);
        renderConsolePreview();
      });
    });
    const applyBtn = el('applyBtn'); if(applyBtn) applyBtn.addEventListener('click', ()=>{ readAllConsoleInputs(); renderConsolePreview(); });
    const resetBtn = el('resetBtn'); if(resetBtn) resetBtn.addEventListener('click', resetToDefaults);
    el('qToggleConsole').addEventListener('change', e=>{ qEnabled = e.target.checked; syncQControls(); renderConsolePreview(); });
    el('qMagnitudeSliderConsole').addEventListener('input', e=>{
      qMagnitude = parseFloat(e.target.value);
      syncQControls();
      renderConsolePreview();
    });
    el('orderToggleConsole').addEventListener('change', e=>{ orderSensitive = e.target.checked; syncQControls(); renderConsolePreview(); });
    wrap.querySelectorAll('[data-prev]').forEach(i=>i.addEventListener('change', renderConsolePreview));
  }

  function onConsoleEdit(){ readAllConsoleInputs(); renderConsolePreview(); }

  function readAllConsoleInputs(){
    const wrap = el('consoleTab');
    wrap.querySelectorAll('[data-prior]').forEach(i=>{
      const n = deceivableNet.byId[i.dataset.prior];
      const v = parseFloat(i.value);
      n.prior[n.domain[0]] = v; n.prior[n.domain[1]] = 1-v;
      const rn = rationalNet.byId[i.dataset.prior]; if(rn){ rn.prior[rn.domain[0]]=v; rn.prior[rn.domain[1]]=1-v; }
    });
    wrap.querySelectorAll('[data-cpt]').forEach(i=>{
      const [nodeId, key] = i.dataset.cpt.split(':');
      deceivableNet.byId[nodeId].cpt[key] = parseFloat(i.value);
      const rn = rationalNet.byId[nodeId]; if(rn) rn.cpt[key] = parseFloat(i.value);
    });
    wrap.querySelectorAll('[data-utility]').forEach(i=>{
      const [action, key] = i.dataset.utility.split(':');
      S.UTILITY.utilityTable[action][key] = parseFloat(i.value);
    });
    wrap.querySelectorAll('[data-bparam]').forEach(i=>{
      const [nodeId, key] = i.dataset.bparam.split(':');
      const node = deceivableNet.byId[nodeId];
      node.params[key] = (i.tagName==='SELECT') ? i.value : parseFloat(i.value);
    });
  }

  function resetToDefaults(){
    // simplest robust reset: reload scenario.js's original values by
    // re-fetching a fresh copy is overkill for a static file; instead we
    // keep a deep-cloned snapshot taken at load time.
    S.NODES.forEach((n,i)=>{
      const orig = window.__SCENARIO_DEFAULTS__.NODES[i];
      if(n.prior) Object.assign(n.prior, orig.prior);
      if(n.cpt) Object.assign(n.cpt, orig.cpt);
      if(n.params) Object.assign(n.params, orig.params);
    });
    Object.assign(S.UTILITY.utilityTable, JSON.parse(JSON.stringify(window.__SCENARIO_DEFAULTS__.UTILITY.utilityTable)));
    qEnabled = true; qMagnitude = 0.55; orderSensitive = true;
    biasNodes.forEach(n=>{ toggles[n.id] = true; syncBiasToggle(n.id); });
    syncQControls();
    buildConsoleSkeleton();
    renderConsolePreview();
  }

  function renderConsolePreview(){
    const wrap = el('consoleTab');
    const ev = {};
    wrap.querySelectorAll('[data-prev]').forEach(sel=>{
      const v = sel.value;
      ev[sel.dataset.prev] = (v==='__null__') ? null : (v==='true' ? true : (v==='false' ? false : v));
    });
    const post = deceivableNet.posterior([ev], toggles, effectiveQ(), currentWeights());
    const result = deceivableNet.decide(post.combos, S.utilityFn, ACTIONS, ev, toggles);
    const pRisk = post.marginals[S.UI.targetHiddenNode][S.UI.targetValue];

    const valEl = el('prevPFire'); valEl.textContent = fmtPct(pRisk); valEl.className = 'hud-value ' + pFireTier(pRisk);
    const actEl = el('prevAction'); actEl.textContent = S.UI.actionLabels[result.best]||result.best; actEl.className = 'hud-action ' + result.best;
    el('prevNote').textContent = 'EU (belief only): ' + ACTIONS.map(a=>a+'='+result.eu[a].toFixed(1)).join(', ');
    el('prevEURow').innerHTML = euRowHtml(result.scores, result.best);
  }

  function renderConsole(){ renderConsolePreview(); }

  /* =========================================================================
     FRAMES TAB — reorder and/or deselect frames for the next run. Always
     lists every frame from S.FRAMES (the scenario file), in the current
     working order; never shows frames not present in the scenario file.
     Sticky for the session: persists across tab switches and frame
     navigation, resets on scenario switch or page reload.
     ========================================================================= */
  function renderFramesTab(){
    const wrap = el('framesTab');
    let html = '<div class="panel frames-panel" style="cursor:default;">' +
      '<h3>Frame order &amp; selection</h3>' +
      '<div class="frames-note">Use the arrows to reorder frames, or untick a frame to leave it out of the next run. ' +
      'The opening frame and the decision frame are fixed by the scenario file and can\u2019t be moved or excluded; everything between them is fair game. ' +
      'This changes the sequence for Story, Rational and Deceivable mode for the rest of this session. It resets to the scenario file\u2019s own order if you switch scenarios or reload the page.</div>' +
      '<div class="frames-list" id="framesList" style="cursor:default;">';

    const lastPos = frameOrder.length - 1;
    frameOrder.forEach((origIdx, pos) => {
      const f = S.FRAMES[origIdx];
      const included = frameIncluded[origIdx];
      const isFixed = (pos === 0 || pos === lastPos);

      let tag = '';
      if(isFixed && pos === 0) tag = ' &middot; fixed opening frame';
      else if(isFixed) tag = ' &middot; fixed decision frame';

      // No draggable elements remain in this tab (see the removal above),
      // but a leftover CSS rule in the scenario's stylesheet (alt-theme.css
      // / styles.css — not owned by engine.js) still paints a grab cursor
      // over this area. Rather than guess at that external rule, every
      // element here gets an explicit inline `cursor`, which wins over the
      // stylesheet regardless of what it says: `pointer` on anything
      // actually clickable, `not-allowed` on a disabled control, and
      // `default` (the plain arrow) on everything else, including the row
      // itself, the caption text, and the frame number/lock.
      const checkboxHtml = isFixed
        ? `<label class="switch disabled" style="cursor:not-allowed;" title="Fixed by the scenario file"><input type="checkbox" checked disabled style="cursor:not-allowed;"><span class="slider" style="cursor:not-allowed;"></span></label>`
        : `<label class="switch" style="cursor:pointer;"><input type="checkbox" data-frame-include="${origIdx}" ${included ? 'checked' : ''} style="cursor:pointer;"><span class="slider" style="cursor:pointer;"></span></label>`;

      const controlsHtml = isFixed
        ? `<span class="frame-row-controls" style="cursor:default;"><span class="frame-lock" style="cursor:default;" title="Fixed by the scenario file">&#128274;</span></span>`
        : `<span class="frame-row-controls" style="cursor:default;">` +
            `<button class="framebtn" data-move="up" data-pos="${pos}" ${pos<=1 ? 'disabled' : ''} style="cursor:${pos<=1 ? 'not-allowed' : 'pointer'};" title="Move up">&uarr;</button>` +
            `<button class="framebtn" data-move="down" data-pos="${pos}" ${pos>=lastPos-1 ? 'disabled' : ''} style="cursor:${pos>=lastPos-1 ? 'not-allowed' : 'pointer'};" title="Move down">&darr;</button>` +
          `</span>`;

      html += `<div class="frame-row${included ? '' : ' excluded'}${isFixed ? ' fixed' : ''}" data-origidx="${origIdx}" data-pos="${pos}" style="cursor:default;">` +
        checkboxHtml +
        `<span class="frame-orig-num" style="cursor:default;">#${f.n}${tag}</span>` +
        `<span class="frame-caption-preview" style="cursor:default;">${stripHtml(f.caption)}</span>` +
        controlsHtml +
      `</div>`;
    });

    html += '</div>' +
      '<div class="console-actions" style="margin-top:16px;"><button id="framesResetBtn">Reset to scenario order</button></div>' +
    '</div>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('[data-frame-include]').forEach(cb => {
      cb.addEventListener('change', e => {
        const idx = parseInt(e.target.dataset.frameInclude, 10);
        frameIncluded[idx] = e.target.checked;
        applyFrameWorkingSetChange();
      });
    });

    wrap.querySelectorAll('[data-move]').forEach(btn => {
      btn.addEventListener('click', e => {
        const pos = parseInt(e.currentTarget.dataset.pos, 10);
        const newPos = pos + (e.currentTarget.dataset.move === 'up' ? -1 : 1);
        // never allowed to swap into the fixed first/last slots
        if(newPos <= 0 || newPos >= frameOrder.length - 1) return;
        const tmp = frameOrder[pos]; frameOrder[pos] = frameOrder[newPos]; frameOrder[newPos] = tmp;
        applyFrameWorkingSetChange();
      });
    });

    el('framesResetBtn').addEventListener('click', () => {
      resetFrameWorkingSet();
      applyFrameWorkingSetChange();
    });
  }

  /* =========================================================================
     WIRING — static DOM elements that exist for the life of the page, so
     these listeners are attached exactly once, regardless of how many times
     initIncidentConsole() reruns. They call functions that close over the
     `let`-declared scenario state above, so they automatically pick up
     whichever scenario is currently loaded.
     ========================================================================= */
  document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{ mode = tab.dataset.tab; render(); });
  });
  el('prevBtn').addEventListener('click', ()=>{ if(frameIdx>0) goToFrame(frameIdx-1); });
  el('nextBtn').addEventListener('click', ()=>{ if(frameIdx<FRAMES.length-1) goToFrame(frameIdx+1); });
  el('firstBtn').addEventListener('click', ()=>{ if(frameIdx>0) goToFrame(0); });
  el('lastBtn').addEventListener('click', ()=>{ if(frameIdx<FRAMES.length-1) goToFrame(FRAMES.length-1); });
  // Arrow-key frame navigation: Down/Right = forward, Up/Left = back —
  // mirrors the Prev/Next buttons exactly (same click, same disabled-state
  // gating) rather than duplicating the frameIdx bounds/isFinal logic, so
  // the two can never drift apart. Two guards keep this from misfiring:
  // skipped entirely while the Console or Frames tab is showing (the story
  // viewer, and its buttons, aren't even on screen then), and skipped
  // while focus is in a text input/select/textarea, so arrow keys keep
  // their native meaning there (moving a text cursor, changing a select's
  // value, nudging a range slider) instead of jumping frames underneath.
  document.addEventListener('keydown', e => {
    if(el('viewer').classList.contains('hidden')) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if(tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if(e.key === 'ArrowDown' || e.key === 'ArrowRight'){
      const btn = el('nextBtn');
      if(btn && !btn.disabled){ e.preventDefault(); btn.click(); }
    } else if(e.key === 'ArrowUp' || e.key === 'ArrowLeft'){
      const btn = el('prevBtn');
      if(btn && !btn.disabled){ e.preventDefault(); btn.click(); }
    }
  });
  el('actionRow').addEventListener('click', e=>{
    const btn = e.target.closest('.actbtn'); if(!btn) return;
    chooseAction(btn.dataset.action, false);
  });

  /* =========================================================================
     INIT — (re)builds everything from whatever window.SCENARIO currently
     points to. Called once for the page's default scenario, and again by
     index.html's scenario switcher every time a different scenario script
     finishes loading, so this is the only place scenario-dependent state
     gets (re)assigned.
     ========================================================================= */
  function initIncidentConsole(){
    S = window.SCENARIO;
    ACTIONS = S.ACTIONS;
    loadFrameWorkingSet();
    FRAMES = computeFrames();

    const rationalNodeDefs = S.NODES.filter(n => n.type === 'hidden' || n.type === 'evidence');
    const deceivableNodeDefs = S.NODES; // everything
    rationalNet = BayesEngine.buildNetwork(rationalNodeDefs);
    deceivableNet = BayesEngine.buildNetwork(deceivableNodeDefs);
    // weightBias nodes (e.g. AB) are ordinary evidence structurally — both
    // networks already include them via rationalNodeDefs/deceivableNodeDefs
    // above — but they still need a toggle in the Deceivable panel/Console,
    // same as a biasBelief or biasDecision node, so they belong in this list.
    biasNodes = deceivableNet.biasBeliefNodes.concat(deceivableNet.weightBiasNodes).concat(deceivableNet.biasDecisionNodes);

    // regression guard: all-off deceivable must equal rational, for ANY frame's evidence
    (function selfCheck(){
      let allPassed = true;
      FRAMES.forEach((f,i) => {
        const ev = evidenceUpTo(i);
        const ok = BayesEngine.verifyRationalDeceivableParity(rationalNet, deceivableNet, S.utilityFn, ACTIONS, ev);
        if(!ok) allPassed = false;
      });
      if(allPassed) console.log('Startup parity check: all ' + FRAMES.length + ' frames OK.');
    })();

    stopTimer();
    mode = 'story'; frameIdx = 0; finalized = false; lastChoice = null; lastTimedOut = false; timerRemaining = 20;
    perceivedRiskRevealed = false;
    resetQuiz(); pendingDecisionRecord = null;
    toggles = {};
    biasNodes.forEach(n => toggles[n.id] = true);
    qEnabled = true; qMagnitude = 0.55; orderSensitive = true;

    window.__SCENARIO_DEFAULTS__ = JSON.parse(JSON.stringify({ NODES: S.NODES, UTILITY: S.UTILITY }));

    buildActionButtons();
    buildPanelSkeletons();
    buildConsoleSkeleton();
    render();
  }

  window.initIncidentConsole = initIncidentConsole;
  initIncidentConsole();

})();
