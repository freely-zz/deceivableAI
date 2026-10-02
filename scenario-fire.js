/* =============================================================================
   scenario.js — Everything specific to THIS scenario (server-room fire).
   To build a new scenario, copy this file, change the content, and leave
   model.js / engine.js / index.html untouched.
   ============================================================================= */

(function(global){

  const ACTIONS = ['ignore', 'investigate', 'evacuate'];
  const IMAGEFOLDER = 'images-fire';

  /* ---------------------------------------------------------------------
     NODE DEFINITIONS
     Rational network  = nodes of type 'hidden' or 'evidence' only.
     Deceivable network = every node below.
     --------------------------------------------------------------------- */
  const NODES = [
    // ---- hidden (unobserved, part of the enumeration) ----
    { id:'F',  type:'hidden', domain:[true,false],
      prior:{ true:0.01, false:0.99 }, label:'Fire' },
    { id:'AS', type:'hidden', domain:['accurate','faulty'],
      prior:{ accurate:0.95, faulty:0.05 }, label:'Alarm Status' },
    { id:'R',  type:'hidden', domain:['trusted','untrusted'],
      prior:{ trusted:0.90, untrusted:0.10 }, label:'Report Trustworthiness' },

    // ---- plain evidence (observed; part of BOTH networks) ----
    { id:'A', type:'evidence', parents:['F','AS'], domain:[true,false],
      cpt:{ 'true,accurate':0.98, 'false,accurate':0.02, 'true,faulty':0.50, 'false,faulty':0.50 },
      label:'Alarm' },
    { id:'S', type:'evidence', parents:['F','R'], domain:[true,false],
      cpt:{ 'true,trusted':0.95, 'false,trusted':0.05, 'true,untrusted':0.50, 'false,untrusted':0.50 },
      label:'Smoke Report' },

    // ---- bias-on-belief (weightBias): an ORDINARY evidence node — the
    // rational network receives this claim exactly like any other evidence
    // (A, S) and updates belief on it. What differs for the deceivable
    // network is how much it counts: when its toggle is on, the deceivable
    // network raises this node's likelihood to an adjustable power (the
    // `weight` param below), sharpening how far this one claim moves belief
    // relative to everything else observed. Toggled off, or viewed
    // rationally, it counts exactly the same as any other evidence — see
    // model.js's `weights` argument to posterior().
    { id:'AB', type:'evidence', weightBias:true, parents:['AS'], domain:['reports fault','reports no fault'],
      cpt:{ accurate:0.15, faulty:0.75 },
      params:{ weight:2 },
      paramSchema:[
        { key:'weight', type:'range', min:1, max:6, step:0.5, label:'Weight (likelihood exponent)' },
      ],
      // Shown as ordinary evidence in the main body of the Console tab (the
      // plain-evidence CPT panels and the Live scenario preview) — calling
      // it a "bias" there is misleading, since nothing shown in those two
      // spots depends on the toggle. `alias`/`aliasLabel` control ONLY that
      // display text; the Deceivable Mode settings panel (and the
      // frame-view Deceivable toggle list) still show it as AB / Authority
      // Bias, since that's where it genuinely is a togglable bias.
      alias:'SR', aliasLabel:'Staff Report',
      label:'Authority Bias', toggleLabel:'Apply authority bias' },

    // ---- bias-on-decision (deceivable network only; never touches belief) ----
    { id:'SP', type:'biasDecision', domain:['ignore','investigate','evacuate'],
      params:{ mode:'binary', weight:15 },
      paramSchema:[
        { key:'mode', type:'select', options:['binary','graded'], label:'Mode' },
        { key:'weight', type:'range', min:0, max:80, step:0.5, label:'Weight' },
      ],
      penalty(action, observedValue, params){
        const ladder = { ignore:0, investigate:1, evacuate:2 };
        if(params.mode === 'binary') return action === observedValue ? 0 : params.weight;
        return params.weight * Math.abs(ladder[action] - ladder[observedValue]);
      },
      label:'Social proof', toggleLabel:'Apply social proof' },

    // An authority's instruction about the DECISION itself (as opposed to
    // AB, which is the authority's claim about AS's reliability) — never
    // touches belief, only the deceivable network's decision layer, same
    // mechanism as SP but with a `stance` so one node can model either an
    // authority endorsing an action (favour it) or discouraging one
    // (penalize it specifically), depending on what a scenario frame reveals.
    { id:'OB', type:'biasDecision', domain:['ignore','investigate','evacuate'],
      params:{ stance:'discourage', mode:'binary', weight:15 },
      paramSchema:[
        { key:'stance', type:'select', options:['endorse','discourage'], label:'Stance' },
        { key:'mode', type:'select', options:['binary','graded'], label:'Mode' },
        { key:'weight', type:'range', min:0, max:80, step:0.5, label:'Weight' },
      ],
      penalty(action, observedValue, params){
        const ladder = { ignore:0, investigate:1, evacuate:2 };
        const maxDist = Math.max(...Object.values(ladder));
        const dist = Math.abs(ladder[action] - ladder[observedValue]);
        if(params.stance === 'discourage'){
          // Penalizes choosing (or, in graded mode, choosing close to) the
          // specific action the authority discouraged — the mirror image
          // of "endorse" below, which favours a specific recommended action.
          return (params.mode === 'binary')
            ? (action === observedValue ? params.weight : 0)
            : params.weight * (maxDist - dist);
        }
        return (params.mode === 'binary')
          ? (action === observedValue ? 0 : params.weight)
          : params.weight * dist;
      },
      label:'Obedience', toggleLabel:'Apply obedience' },
  ];

  /* Utility is kept as DATA (not a function) so the console tab can render
     and edit it generically. utilityDependsOn lists which hidden node(s)
     the payoff depends on; utilityTable is keyed by action, then by the
     comma-joined values of those hidden nodes (single-node case below is
     just the plain value). */
  const UTILITY = {
    utilityDependsOn: ['F'],
    utilityTable: {
      ignore:      { true:-90, false:0 },
      investigate: { true:-20,  false:-5 },
      evacuate:    { true:-10,  false:-15 },
    }
  };

  function utilityFn(action, hAssign){
    const key = UTILITY.utilityDependsOn.map(id => String(hAssign[id])).join(',');
    return UTILITY.utilityTable[action][key];
  }

  /* ---------------------------------------------------------------------
     FRAMES — the story sequence. `reveals` maps node id -> observed value.
     Frames with no reveals are narrative repeats: deliberately no new
     evidence, so the numbers should NOT move on those frames.
     --------------------------------------------------------------------- */
  const FRAMES = [
    { n:1, caption:'You are monitoring a university building.',
      desc:'A quiet hallway camera feed. Nothing unusual.', file:IMAGEFOLDER + '/frame-1.png', reveals:{} },
    { n:2, caption:'A fire alarm sounds briefly, then stops.',
      desc:'Wall-mounted fire alarm unit.', file:IMAGEFOLDER + '/frame-2.png', reveals:{A:true} },
    { n:3, caption:'A senior staff member says: <q>Don\'t panic. The fire alarm\'s playing up.</q>',
      desc:'A senior staff member speaking to camera.', file:IMAGEFOLDER + '/frame-3.png', reveals:{AB:'reports fault'} },
    { n:4, caption:'The fire alarm sounds again, noticeably longer than the first time, then stops.',
      desc:'Wall-mounted fire alarm unit, sounding again.', file:IMAGEFOLDER + '/frame-4.png', reveals:{A:true} },
    { n:5, caption:'Senior staff member: <q>See what I mean?</q>',
      desc:'The same staff member shrugs implying no cause for alarm.', file:IMAGEFOLDER + '/frame-5.png', reveals:{OB:'evacuate'} },
    { n:6, caption:'A student reports smelling smoke outside the server room.',
      desc:'An anxious student reporting what they smelled.', file:IMAGEFOLDER + '/frame-6.png', reveals:{S:true} },
    { n:7, caption:'CCTV shows students behaving perfectly normally. No one has reacted to the fire alarm.',
      desc:'A bank of CCTV monitors showing students chatting, working, relaxing, behaving normally.', file:IMAGEFOLDER + '/frame-7.png', reveals:{SP:'ignore'} },
    { n:8, caption:'The next class is about to enter the building. What are you going to do?',
      desc:'Students streaming towards building and a countdown overlay.', file:IMAGEFOLDER + '/frame-8.png', reveals:{}, isFinal:true, timerSeconds:20, timeoutAction:'ignore' },
  ];

  /* ---------------------------------------------------------------------
     UI LABELS — display-only strings, kept out of engine.js entirely.
     --------------------------------------------------------------------- */
  const UI = {
    title: 'Incident Console — Building 4, Server Room Wing',
    targetHiddenNode: 'F',     // which hidden node's value is "the risk" (fire)
    targetValue: true,          // which value of that node counts as "bad"
    rationalLabel: 'Rational risk of fire',
    deceivableLabel: 'Perceived risk of fire',
    actionLabels: { ignore:'ignore', investigate:'investigate', evacuate:'evacuate' },
    rationalNote: 'Belief only — computed from A, S and AB (all genuine evidence). The decision-layer biases (social proof, obedience) never apply here.',
  };

  global.SCENARIO = { ACTIONS, NODES, UTILITY, utilityFn, FRAMES, UI, css: 'alt-theme.css' };

})(window);
