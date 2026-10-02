/* =============================================================================
   scenario.js — Everything specific to THIS scenario (Operation Fortitude).
   Provisional draft. Copies the exact shape of the fire-scenario file so it
   drops in against the unmodified model.js / engine.js / index.html.
   ============================================================================= */



(function(global){

  const ACTIONS = ['reserve', 'partial', 'commit'];
  const IMAGEFOLDER = 'images-fortitude';

  /* ---------------------------------------------------------------------
     NODE DEFINITIONS
     Rational network  = nodes of type 'hidden' or 'evidence' — i.e. N, WR,
     PW, FR, MB, PE, RI. It never sees Cramer's testimony (CR) at all — that
     is now an authority-bias node, not evidence — and it is never subject
     to q-tempering, order-dependent updating, or the obedience decision
     bias (PB).
     Deceivable network = every node below, PLUS Cramer's testimony as an
     authority-bias node (CR — coupled to both N and PW, see below), PLUS
     the obedience decision bias (PB), PLUS an adjustable q. With
     q at 0.5 and CR/PB switched off, the deceivable network reduces to
     exactly the rational one on N/WR/PW/FR/MB/PE/RI — though PW's belief
     then simply sits at its prior forever on both sides, since nothing
     else in the network updates it.
     --------------------------------------------------------------------- */
  const NODES = [
    // ---- hidden (unobserved, part of the enumeration) ----
    { id:'N',  type:'hidden', domain:[true,false],
      prior:{ true:0.35, false:0.65 }, label:'Normandy Landing' },   // true = Normandy is the real target
    { id:'WR', type:'hidden', domain:['trusted','untrusted'],
      prior:{ trusted:0.85, untrusted:0.15 }, label:'Witness Reliability' },  // reliability of the Cramer witness channel
    { id:'PW', type:'hidden', domain:[true,false],
      prior:{ true:0.75, false:0.25 }, label:'Patton Leads Invasion' },   // strength of belief that Patton personally leads the invasion — previously baked into RI's CPT constants, now a standalone, editable parameter

    // ---- plain evidence (part of BOTH networks — a fully Bayesian reasoner
    //      sees everything that was actually presented, real or fabricated;
    //      what makes the deceivable network different is HOW it reasons
    //      about this evidence, not WHICH evidence it has access to) ----
    { id:'FR', type:'evidence', parents:['N'], domain:[true,false],
      cpt:{ true:0.85, false:0.10 },
      label:'French Resistance' },   // sabotage reports
    { id:'MB', type:'evidence', parents:['N'], domain:[true,false],
      cpt:{ true:0.93, false:0.05 },
      label:'Military Buildup' },   // real parachute/naval buildup off Normandy
    { id:'PE', type:'evidence', parents:['N'], domain:[true,false],
      cpt:{ true:0.10, false:0.92 },
      label:'Physical Evidence' },   // decoy hardware, phantom docks (fabricated)
    { id:'RI', type:'evidence', parents:['N'], domain:[true,false],
      cpt:{ true:0.08, false:0.90 },
      label:'Radio Intercepts' },      // fake FUSAG/Patton radio traffic (fabricated)

    // ---- bias-on-belief (deceivable network only; same likelihood maths as
    //      evidence, but toggleable and coupled to TWO hidden nodes at once.
    //      This is what makes Cramer's testimony an authority-bias mechanism
    //      rather than plain evidence: believing him pulls belief toward
    //      BOTH "Patton leads" (PW=true) and "Calais is the target" (N=false)
    //      simultaneously, because his account is most consistent with that
    //      joint hypothesis. The rational network never sees this node at
    //      all — CR is entirely absent from its evidence, not merely
    //      downweighted. ----
    { id:'CR', type:'biasBelief', parents:['N','PW','WR'], domain:[true,false],
      cpt:{
        'true,true,trusted':0.30,    'true,false,trusted':0.05,
        'false,true,trusted':0.95,   'false,false,trusted':0.70,
        'true,true,untrusted':0.50,  'true,false,untrusted':0.50,
        'false,true,untrusted':0.50, 'false,false,untrusted':0.50,
      },
      label:'Authority Bias',
      toggleLabel:'Apply authority bias' }, // staged eyewitness (fabricated)

    // ---- bias-on-decision (deceivable network only; never touches belief) ----
    { id:'PB', type:'biasDecision', domain:['reserve','partial','commit'],
      params:{ mode:'binary', weight:15 },
      paramSchema:[
        { key:'mode', type:'select', options:['binary','graded'], label:'Mode' },
        { key:'weight', type:'range', min:0, max:80, step:0.5, label:'Weight' },
      ],
      penalty(action, observedValue, params){
        const ladder = { reserve:0, partial:1, commit:2 };
        if(params.mode === 'binary') return action === observedValue ? 0 : params.weight;
        return params.weight * Math.abs(ladder[action] - ladder[observedValue]);
      },
      label:'Obedience', toggleLabel:'Apply obedience' },
  ];

  /* Utility is kept as DATA (not a function) so the console tab can render
     and edit it generically. */
  const UTILITY = {
    utilityDependsOn: ['N'],
    utilityTable: {
      reserve: { true:-80, false:0 },
      partial: { true:-20,  false:-5 },
      commit:  { true:-10,  false:-15 },
    }
  };

  function utilityFn(action, hAssign){
    const key = UTILITY.utilityDependsOn.map(id => String(hAssign[id])).join(',');
    return UTILITY.utilityTable[action][key];
  }

  /* ---------------------------------------------------------------------
     FRAMES — the story sequence. `reveals` maps node id -> observed value.
     The Verlaine poem is deliberately NOT a node — it carries no evidence
     about F at all, only urgency. Frame 8 reveals nothing new; it exists
     purely to start the countdown, exactly like the alarm-repeat frames
     earlier in the sequence carry no reveals.
     --------------------------------------------------------------------- */
  const FRAMES = [
    { n:1, caption:'German High Command, Berlin. You are trying to figure out where the Allied forces will attack.',
      desc:'German officers work quietly. A large wall map shows the Channel coastline.', file: IMAGEFOLDER + '/frame-1.png', reveals:{} },
    { n:2, caption:'Radio intercepts place the First US Army Group, commanded by General Patton, at Dover, opposite the Pas-de-Calais.',
      desc:'A radio operator logging intercepted traffic.', file:IMAGEFOLDER + '/frame-2.png', reveals:{RI:true} },
    { n:3, caption:'Luftwaffe reconnaissance photographs a vast buildup of armour and landing craft at Dover.',
      desc:'Aerial photograph of tanks and vehicles in southeast England.', file:IMAGEFOLDER + '/frame-3.png', reveals:{PE:true} },
    { n:4, caption:'Reports come in that French Resistance is preparing to sabotage railway and telephone lines across Normandy.',
      desc:'A shadowy figure at the edge of a trainline is cutting a telegraph cable.', file:IMAGEFOLDER + '/frame-4.png', reveals:{FR:true} },
    { n:5, caption:'A separate report: parachute drops and a naval buildup are sighted off the Normandy coast itself.',
      desc:'Ships and transport aircraft over open water.', file:IMAGEFOLDER + '/frame-5.png', reveals:{MB:true} },
    { n:6, caption:'Repatriated General Hans Cramer reports to Rommel: <q>I saw the troop build-up with my own eyes. They\'ll attack at the Pas-de-Calais.</q>',
      desc:'General Cramer urgently points at a map with his gloved hand.', file:IMAGEFOLDER + '/frame-6.png', reveals:{CR:true} },
    { n:7, caption:'There\'s general agreement: <q>If Patton\'s leading the invasion, it will be Calais.</q>',
      desc:'Dossier with Paton\s photograph open on map table with map marker at Dover.', file:IMAGEFOLDER + '/frame-7.png', reveals:{PB:'reserve'} },
    { n:8, caption:'A BBC broadcast carries the end of the Verlaine poem: \"Blessent mon coeur d\'une langueur monotone\". You know the code. Invasion is imminent. You must make your decision.',
      desc:'A radio listened to by anxious German officers and a countdown overlay.', file:IMAGEFOLDER + '/frame-8.png', reveals:{}, isFinal:true, timerSeconds:20, timeoutAction:'reserve' },
  ];

  /* ---------------------------------------------------------------------
     UI LABELS — display-only strings, kept out of engine.js entirely.
     --------------------------------------------------------------------- */
  const UI = {
    title: 'Incident Console — Oberkommando der Wehrmacht, June 1944',
    targetHiddenNode: 'N',     // which hidden node's value is "the risk"
    targetValue: true,          // true = Normandy is the real invasion site
    rationalLabel: 'Rational probability of Normandy landing',
    deceivableLabel: 'Perceived probability of Normandy landing',
    actionLabels: { reserve:'hold troops at Calais', partial:'partially reinforce Normandy', commit:'commit troops to Normandy' },
  };

  global.SCENARIO = { ACTIONS, NODES, UTILITY, utilityFn, FRAMES, UI, css: 'styles.css' };

})(window);
