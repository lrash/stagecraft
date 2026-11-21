// The reminder to save. Everything a run produces lives in one browser at one address;
// a technical owner knows to export, everyone else finds out by losing something.
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");
let n = 0, bad = 0;
const ok = (m, c) => { if (c) n++; else { bad++; console.log("FAIL  " + m); } };

const fn = html.slice(html.indexOf("function renderSaveReminder(){"),
                      html.indexOf("const renderAll ="));
ok("the reminder exists", fn.length > 0);

// --- not a nag ----------------------------------------------------------------
ok("silent until there is real work at risk", /done < 2/.test(fn));
ok("silent when everything is saved", /unsaved < 1/.test(fn));
ok("counts stages since the last download", /S\.exportedStages/.test(fn));
ok("says how many, rather than repeating itself", /more stage/.test(fn));
ok("escalates when the run is finished", /finished/.test(fn) && /done === STAGES\.length/.test(fn));

// --- the copy has to state the actual risk, not a vague one -------------------
ok("names the browser as the only home", /only in this browser/.test(fn));
ok("names the ADDRESS too — storage is per-origin", /at this address/.test(fn));
ok("names clearing site data", /clearing site data/.test(fn));
ok("names private windows", /private window/.test(fn));
ok("offers the action inline", /btn-save-now/.test(fn));

// --- exporting must actually quiet it ------------------------------------------
const exp = html.slice(html.indexOf("function exportMd("), html.indexOf("function demoteHeadings"));
ok("export records how much was saved", /S\.exportedStages = /.test(exp));
ok("export persists that", /save\(\);/.test(exp));
ok("export refreshes the reminder", /renderSaveReminder/.test(exp));

// --- and it must be rendered ---------------------------------------------------
ok("renderAll draws it", /renderAll = \(\) => \{[^}]*renderSaveReminder\(\)/.test(html));
ok("there is somewhere to draw it", /id="save-reminder"/.test(html));
ok("it is announced to screen readers", /id="save-reminder"[^>]*aria-live/.test(html));

console.log((bad ? "FAILED " : "") + n + " assertions passed" + (bad ? ", " + bad + " failed" : ""));
process.exit(bad ? 1 : 0);
