/* =============================================================================
   scenarios-manifest.js — the list of scenario scripts the demo can load.
   The first entry is the default shown on page load. To add a scenario,
   add a line here and drop the matching scenario-*.js file alongside the
   others — nothing else needs to change.

   Loaded as a plain <script> tag (not fetch/JSON) deliberately: opening
   this demo directly from disk (file://) blocks fetch() of local files
   under most browsers' CORS rules, but a normal <script src> tag is not
   subject to that restriction, so this keeps the whole demo runnable
   without a local server.
   ============================================================================= */
window.SCENARIO_LIST = [
  { id:'fire',       title:'Incident Console — Building 4, Server Room Wing',        script:'scenario-fire.js' },
  { id:'fortitude',  title:'Incident Console — Oberkommando der Wehrmacht, June 1944', script:'scenario-fortitude.js' },
];
