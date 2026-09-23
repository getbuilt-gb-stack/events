import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const password = process.env.REPORT_PASSWORD;
if (!password) {
  throw new Error("REPORT_PASSWORD is required");
}

const sourceRef = process.env.REPORT_SOURCE_REF;
const sourceFile = process.env.REPORT_SOURCE_FILE;
const plaintextOutput = process.env.PLAINTEXT_REPORT_OUTPUT;

function decryptPayload(source) {
  const marker = "window.CUBG_REPORT_PAYLOAD=";
  if (!source.startsWith(marker)) return null;
  const payload = JSON.parse(source.slice(marker.length).trim().replace(/;$/, ""));
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    pbkdf2Sync(password, Buffer.from(payload.salt, "base64"), payload.iterations, 32, "sha256"),
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8");
}

function readFromGit(ref) {
  return execFileSync("git", ["show", ref], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

let existingPayload = "";
try {
  existingPayload = readFileSync("payload.js", "utf8");
} catch {
  // The first build can start from the plaintext report in Git instead.
}
const reportSource = sourceFile
  ? readFileSync(sourceFile, "utf8")
  : sourceRef
    ? readFromGit(sourceRef)
    : decryptPayload(existingPayload) || readFromGit("HEAD:index.html");

const oldMobileCss = "@media(max-width:960px){body{padding:15px 10px}.layout{display:block}.toc{position:static;width:auto;max-height:none;margin-bottom:12px}.toc ul{display:flex;flex-wrap:wrap;gap:3px}.toc a{padding:5px 7px}.news-grid,.profile-grid{grid-template-columns:1fr}.rep-heading{display:block}.rep-stats{justify-content:flex-start;margin-top:12px;text-align:left}.hero{padding:23px 20px}.hero h1{font-size:25px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}";
const newMobileCss = "@media(max-width:960px){body{padding:15px 10px}.layout{display:block}.toc{position:static;width:auto;max-height:none;margin-bottom:14px}.toc ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px}.toc a,.toc-rep-button{min-height:34px;padding:7px 8px;display:flex;align-items:center;overflow-wrap:anywhere}.toc-subheading{grid-column:1/-1}.news-grid,.profile-grid{grid-template-columns:1fr}.rep-heading{display:block}.rep-stats{justify-content:flex-start;margin-top:12px;text-align:left}.hero{padding:23px 20px}.hero h1{font-size:25px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.toc ul{grid-template-columns:1fr}.toc a,.toc-rep-button{min-height:36px}}";

let report = reportSource;
for (const styleId of [
  "responsive-navigation-enhancements",
  "rep-coverage-sticky-enhancements",
  "profile-sticky-enhancements",
  "hero-identity-sticky-enhancements",
  "organization-logo-enhancements",
  "conversation-account-identity-enhancements",
  "toc-conversation-mode-enhancements",
]) {
  report = report.replace(new RegExp(`<style id="${styleId}">[\\s\\S]*?<\\/style>`, "g"), "");
}
report = report.replace(/<script id="responsive-navigation-behavior">[\s\S]*?<\/script>/g, "");
report = report.replace(/<style id="event-interaction-enhancements">[\s\S]*?<\/style>/g, "");
report = report.replace(/<dialog id="interaction-dialog"[\s\S]*?<script id="event-interaction-behavior">[\s\S]*?<\/script>/g, "");
if (report.includes(oldMobileCss)) report = report.replace(oldMobileCss, newMobileCss);
if (!report.includes(newMobileCss)) {
  throw new Error("Could not find the expected mobile menu CSS");
}
report = report.replace(/<li><a href="#roster">(?:Full Roster|Roster Directory)<\/a><\/li>/g, "");
report = report.replace(/<option value="#roster">(?:Full Roster|Roster Directory)<\/option>/g, "");
report = report.replace(/<option value="">On this page\.\.\.<\/option>/g, "");
const rosterWrapperStart = report.indexOf('<div class="roster-directory">');
const rosterHeadingStart = report.indexOf('<h2 class="section" id="roster">');
const rosterBlockStart = rosterWrapperStart >= 0 ? rosterWrapperStart : rosterHeadingStart;
const rosterFooterStart = report.indexOf('<footer class="footer">', rosterBlockStart);
if (rosterBlockStart >= 0 && rosterFooterStart >= 0) report = report.slice(0, rosterBlockStart) + report.slice(rosterFooterStart);
report = report.replace(/<section class="rep-panel[^"]*" id="rep-full-roster">[\s\S]*?<\/section>/g, "");
const tieredTables = [...report.matchAll(/<h4 class="subsection">Tiered roster[\s\S]*?<\/h4>[\s\S]*?<div class="table-wrap">(<table>[\s\S]*?<\/table>)<\/div>/g)]
  .map(([, table]) => table);
const rosterRows = tieredTables
  .map((table) => table.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "")
  .join("");
const rosterRowHtml = [...rosterRows.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map(([row]) => row);
const stripMarkup = (value) => value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rowCells = (row) => [...row.matchAll(/<td\b[\s\S]*?<\/td>/g)].map(([cell]) => stripMarkup(cell));
const rosterData = rosterRowHtml.map(rowCells);
const rosterCount = rosterData.length;
const accountCount = new Set(rosterData.map((cells) => cells[3]).filter(Boolean)).size;
const pipelineAccountCount = new Set(rosterData.filter((cells) => /open deal/.test(cells[5] || "")).map((cells) => cells[3]).filter(Boolean)).size;
const tierOneCount = rosterData.filter((cells) => /class="tier one"/.test(rosterRowHtml[rosterData.indexOf(cells)] || "")).length;
if (!rosterCount) throw new Error("Could not rebuild the full roster panel from tiered roster tables");
const fullRosterPanel = `<section class="rep-panel" id="rep-full-roster"><div class="rep-heading"><div><div class="eyebrow">Account coverage</div><h3>Full Roster</h3></div><div class="rep-stats"><span><b>${rosterCount}</b> attendees</span><span><b>${accountCount}</b> accounts</span><span><b>${pipelineAccountCount}</b> pipeline accounts</span><span><b>${tierOneCount}</b> Tier 1</span></div></div><p class="section-copy">Tier 1 prioritizes active pipeline, C-suite and executive attendance, senior lending or operations roles, account size, and attendee concentration. Tier 2 preserves the remaining relevant attendees.</p><h4 class="subsection">Tiered roster <span class="badge">${rosterCount}</span></h4><div class="table-wrap"><table><thead><tr><th>Tier</th><th>Contact</th><th>Role</th><th>Company</th><th>Account context</th><th>Pipeline</th><th>Location</th></tr></thead><tbody>${rosterRows}</tbody></table></div></section>`;
const currentFooterStart = report.indexOf('<footer class="footer">');
report = report.slice(0, currentFooterStart) + fullRosterPanel + report.slice(currentFooterStart);
report = report.replace(/(id="reps">Rep Coverage <span class="badge">)(?:7 TABS|7 REPS \+ ALL)/, (_, prefix) => `${prefix}7 REPS + ALL`);
const fullRosterTab = '<button class="rep-button roster-filter-button" type="button" data-roster-filter="all" aria-selected="false">Full Roster</button>';
const unassignedRepTab = '<button class="rep-button " type="button" data-target="rep-unassigned" aria-selected="false">Unassigned</button>';
if (!report.includes('class="rep-button roster-filter-button"')) {
  report = report.replace(unassignedRepTab, `${unassignedRepTab}${fullRosterTab}`);
}
const fullRosterNavItem = '<li><button class="toc-rep-button roster-filter-button" type="button" data-roster-filter="all" aria-selected="false">Full Roster</button></li>';
const unassignedNavItem = /(<li><button class="toc-rep-button[^\"]*" type="button" data-target="rep-unassigned"[^>]*>Unassigned<\/button><\/li>)/;
if (!report.includes('class="toc-rep-button roster-filter-button"')) {
  report = report.replace(unassignedNavItem, `$1${fullRosterNavItem}`);
}
const fullRosterMobileOption = '<option value="#reps" data-roster-filter="all">Full Roster</option>';
report = report.replace(/<option value="#(?:reps|roster)" data-roster-filter="all">Full Roster<\/option>/g, fullRosterMobileOption);
if (!report.includes('data-roster-filter="all">Full Roster</option>')) {
  report = report.replace(/(<optgroup label="Rep coverage">[\s\S]*?)(<\/optgroup>)/, `$1${fullRosterMobileOption}$2`);
}
const top5ModeNavItems = '<li class="toc-mode-item"><button class="toc-mode-button active" type="button" data-mode-target="prospect" aria-selected="true">Cold / New</button></li><li class="toc-mode-item"><button class="toc-mode-button" type="button" data-mode-target="pipeline" aria-selected="false">Open Pipeline / Current Customer</button></li>';
report = report.replace(/<li class="toc-mode-item">[\s\S]*?<\/li>/g, "");
if (!report.includes('class="toc-mode-button active"')) {
  report = report.replace('<li><a href="#top5">Top Prospect Conversations</a></li>', `<li><a href="#top5">Top Prospect Conversations</a></li>${top5ModeNavItems}`);
}
report = report.replace(/<li class="toc-subheading">Rep tabs<\/li>/g, "");
const top5ModeMobileOptions = '<optgroup label="Top Prospect Conversations"><option value="#top5" data-mode-target="prospect">Cold / New</option><option value="#top5" data-mode-target="pipeline">Open Pipeline / Current Customer</option></optgroup>';

const extraCss = `<style id="responsive-navigation-enhancements">
.toc-mobile-bar{display:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.toc-select{width:100%;min-height:40px;padding:8px 34px 8px 11px;border:1px solid #c9d8e2;border-radius:5px;background:#fff;color:#294961;font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}.section{position:sticky;top:calc(18px + var(--hero-identity-height, 0px));z-index:18;isolation:isolate;margin-top:25px;padding-top:10px;background:#f4f7f9;scroll-margin-top:74px;box-shadow:0 3px 0 #f4f7f9;border-bottom:1px solid #d8e0e7}.section::before{content:"";position:absolute;z-index:-1;top:-22px;right:0;bottom:0;left:0;background:#f4f7f9}.context-disclosure>summary,.conversation-more>summary,.opportunity-card>summary{list-style:none}.context-disclosure>summary::-webkit-details-marker,.conversation-more>summary::-webkit-details-marker,.opportunity-card>summary::-webkit-details-marker{display:none}.disclosure-heading{display:flex;align-items:center;gap:8px}.disclosure-chevron{display:inline-block;width:8px;height:8px;flex:none;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .16s ease}.context-disclosure[open] .disclosure-chevron{transform:rotate(45deg)}.opportunity-card>summary:before{content:"";display:inline-block;width:8px;height:8px;flex:none;margin:0 3px 0 1px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .16s ease}.opportunity-card[open]>summary:before{transform:rotate(45deg)}.context-disclosure>summary:hover,.conversation-more>summary:hover,.opportunity-card>summary:hover{background:#f1f7f6}.conversation-more{margin-top:12px;border-top:1px solid #d8e1e8}.conversation-more>summary{padding:10px 2px;cursor:pointer;color:#153e5c;font-size:12px;font-weight:800}.conversation-more>summary:before{content:"";display:inline-block;width:8px;height:8px;margin:0 8px 1px 1px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .16s ease}.conversation-more[open]>summary:before{transform:rotate(45deg)}.conversation-more-people{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:2px 0 4px}.conversation-more .conversation-insight{margin-top:10px}
@media(max-width:960px){.toc{position:sticky;top:var(--hero-identity-height, 84px);z-index:50;width:auto;max-height:none;margin:0 -10px 14px;padding:8px 10px;border-top:0;border-radius:0 0 7px 7px;background:rgba(255,255,255,.97);box-shadow:0 3px 10px rgba(15,35,55,.12)}.toc-mobile-bar{display:block}.toc h5,.toc>ul{display:none}.section{top:calc(var(--toc-sticky-height, 61px) + var(--hero-identity-height, 0px));margin-top:22px;padding:11px 8px 9px;font-size:20px}.section::before{top:-22px}.conversation-more-people{grid-template-columns:1fr}.toc-select{appearance:auto}main.wrap.mobile-page-mode>.mobile-page-section{display:none!important}main.wrap.mobile-page-mode>.mobile-page-section.mobile-page-active{display:block!important}main.wrap.mobile-page-mode>.rep-panel.mobile-page-section:not(.active){display:none!important}main.wrap.mobile-page-mode>.rep-panel.mobile-page-section.active{display:block!important}main.wrap.mobile-page-mode>.mobile-page-active.section,main.wrap.mobile-page-mode>.mobile-page-active.hero{cursor:pointer}main.wrap.mobile-page-mode>.mobile-page-active.section:focus-visible,main.wrap.mobile-page-mode>.mobile-page-active.hero:focus-visible{outline:2px solid #0f766e;outline-offset:2px}}
@media(max-width:560px){.section{top:calc(var(--toc-sticky-height, 61px) + var(--hero-identity-height, 0px));font-size:19px}}
main.wrap.mobile-page-mode:not([data-mobile-page-section="reps"])>.rep-panel.mobile-page-section{display:none!important}
@media(max-width:960px){#reps.section,#reps + .section-copy,#reps ~ .rep-tabs{display:none!important}.rep-panel>.rep-heading{position:static!important;top:auto!important;display:block!important;height:auto!important;min-height:0!important;margin:0!important;padding:0 0 10px!important;background:transparent!important;border:0!important;border-radius:0!important;box-shadow:none!important;overflow:visible!important}.rep-panel>.rep-heading>div:first-child{display:none!important;position:static!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important}.rep-panel>.rep-heading .rep-stats{display:grid!important;position:static!important;top:auto!important;height:auto!important;min-height:0!important;margin:0!important;border:1px solid #d8e0e7!important;border-radius:6px!important;box-shadow:none!important}.rep-panel>.rep-heading + .section-copy{display:none!important}.profile-priority-heading{position:static!important;top:auto!important;height:auto!important;min-height:0!important;margin:0 0 8px!important;box-shadow:none!important}.profile{height:auto!important;min-height:0!important;align-items:flex-start!important}.profile-body{height:auto!important;min-height:0!important;flex:1 1 auto!important}.profile-head-sticky{top:calc(var(--toc-sticky-height, 61px) + var(--hero-identity-height, 0px))!important;height:auto!important;min-height:0!important}}
</style>`;

const modeMenuCss = `<style id="toc-conversation-mode-enhancements">
.toc-mode-item{margin-left:12px}.toc-mode-button{appearance:none;display:block;width:100%;margin:1px 0;padding:6px 8px;border:0;border-left:3px solid transparent;border-radius:4px;background:transparent;color:#405567;font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;line-height:1.25;text-align:left;cursor:pointer}.toc-mode-button.active,.toc-mode-button:hover{border-left-color:#0f766e;background:#eef7f5;color:#0f4c5c}.toc-rep-button{width:calc(100% - 12px);margin-left:12px}
</style>`;

const repCoverageCss = `<style id="rep-coverage-sticky-enhancements">
.rep-panel .rep-heading{margin-bottom:12px}
.rep-tabs{position:sticky;top:calc(18px + var(--hero-identity-height, 0px) + var(--rep-section-height, 42px));z-index:40;isolation:isolate;margin-top:0;padding:8px 0 9px;background:#f4f7f9;border-bottom:1px solid #d8e0e7;box-shadow:0 3px 0 #f4f7f9}
.rep-tabs>*{position:relative;z-index:1}
.rep-panel .rep-heading{position:sticky;top:calc(18px + var(--hero-identity-height, 0px) + var(--rep-section-height, 42px) + var(--rep-tabs-height, 52px));z-index:33;isolation:isolate;padding:12px 16px 10px;background:#fff;border:1px solid #d8e0e7;border-radius:7px;box-shadow:0 4px 10px rgba(15,35,55,.08)}
.rep-panel .rep-heading>*{position:relative;z-index:1}
.rep-panel .rep-heading .eyebrow{margin-bottom:6px}
.rep-panel .rep-heading h3{margin:0}
#reps.section{z-index:55;background:#f4f7f9}
.rep-panel.full-roster{display:block}
.rep-panel.roster-view-hidden{display:none}
@media(max-width:960px){.rep-tabs{top:calc(var(--toc-sticky-height, 110px) + var(--hero-identity-height, 0px) + var(--rep-section-height, 42px))}.rep-panel .rep-heading{top:calc(var(--toc-sticky-height, 110px) + var(--hero-identity-height, 0px) + var(--rep-section-height, 42px) + var(--rep-tabs-height, 52px))}}
@media(max-width:640px){.rep-tabs{flex-wrap:nowrap;overflow-x:auto;gap:5px;margin:6px 0 8px;padding:5px 0 6px;scrollbar-width:thin}.rep-button{flex:0 0 auto;min-height:28px;padding:5px 7px;font-size:10px;line-height:1.15;white-space:nowrap}.rep-panel .rep-heading{display:contents;position:static;top:auto;padding:0;background:transparent;border:0;border-radius:0;box-shadow:none}.rep-panel .rep-heading>div:first-child{position:sticky;top:calc(var(--rep-tabs-sticky-bottom, var(--toc-sticky-height, 110px) + var(--hero-identity-height, 0px) + var(--rep-section-height, 42px) + var(--rep-tabs-height, 52px)) + 1px);z-index:35;isolation:isolate;padding:8px 12px 7px;background:#fff;border:1px solid #d8e0e7;border-radius:6px 6px 0 0;box-shadow:0 4px 10px rgba(15,35,55,.08)}.rep-panel .rep-heading .eyebrow{margin-bottom:2px;font-size:9px}.rep-panel .rep-heading h3{font-size:18px;line-height:1.1}.rep-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin:0;padding:6px 12px 7px;background:#fff;border:1px solid #d8e0e7;border-top:0;border-radius:0 0 6px 6px;text-align:left;font-size:8px;line-height:1.1}.rep-stats b{font-size:15px;line-height:1.05}}
</style>`;

const profileCoverageCss = `<style id="profile-sticky-enhancements">
.profile-priority-heading{position:sticky;top:calc(18px + var(--hero-identity-height, 0px) + var(--rep-section-height, 42px) + var(--rep-tabs-height, 52px) + var(--rep-heading-height, 85px));z-index:32;isolation:isolate;margin:0 0 8px;padding:8px 0 7px;background:#f4f7f9;border-bottom:1px solid #d8e0e7;box-shadow:0 3px 0 #f4f7f9}
.profile-priority-heading::before{content:"";position:absolute;z-index:-1;top:-8px;right:0;bottom:0;left:0;background:#f4f7f9}
.profile-head-sticky{position:sticky;top:calc(18px + var(--hero-identity-height, 0px) + var(--rep-section-height, 42px) + var(--rep-tabs-height, 52px) + var(--rep-heading-height, 85px) + var(--profile-priority-height, 0px));z-index:31;isolation:isolate;margin:-12px -12px 10px;padding:10px 12px 8px;background:#fff;border-bottom:1px solid #d8e0e7;box-shadow:0 3px 8px rgba(15,35,55,.09)}
.profile-head-sticky::after{content:"";position:absolute;z-index:0;right:-1px;bottom:-8px;left:-1px;height:8px;background:#fff}
.profile-head-sticky>*{position:relative;z-index:1}
@media(max-width:960px){.profile-priority-heading{top:calc(var(--toc-sticky-height, 110px) + var(--hero-identity-height, 0px) + var(--rep-section-height, 42px) + var(--rep-tabs-height, 52px) + var(--rep-identity-height, var(--rep-heading-height, 85px)))}.profile-head-sticky{top:calc(var(--toc-sticky-height, 110px) + var(--hero-identity-height, 0px) + var(--rep-section-height, 42px) + var(--rep-tabs-height, 52px) + var(--rep-identity-height, var(--rep-heading-height, 85px)) + var(--profile-priority-height, 0px))}}
</style>`;

const heroIdentityCss = `<style id="hero-identity-sticky-enhancements">
.hero-identity-sticky{position:sticky;top:0;z-index:60;isolation:isolate;margin:0;padding:16px 31px 13px;background:#153e5c;color:#fff;border-radius:7px;box-shadow:0 4px 14px rgba(18,59,91,.16)}
.hero-identity-sticky>*{position:relative;z-index:1}
.hero-identity-sticky .eyebrow{margin:0 0 4px;color:#d3e2eb;font-size:11px;text-transform:uppercase}
.hero-identity-sticky h1{margin:0;color:#fff;font-size:29px;line-height:1.2}
.hero-identity-sticky + .hero{margin-top:10px;border-radius:7px}
@media(max-width:960px){.hero-identity-sticky{top:0;margin:0 -10px;padding:12px 20px 11px;border-radius:7px;box-shadow:0 4px 12px rgba(18,59,91,.18)}.hero-identity-sticky .eyebrow{font-size:9px}.hero-identity-sticky h1{font-size:22px;line-height:1.2}.hero-identity-sticky + .hero{border-radius:7px}}
@media(max-width:560px){.hero-identity-sticky{padding:10px 16px 9px}.hero-identity-sticky h1{font-size:19px}}
</style>`;

const logoCss = `<style id="organization-logo-enhancements">
.organization-logo{display:inline-grid;place-items:center;width:28px;height:28px;flex:none;margin-right:8px;border:1px solid #d7e2e8;border-radius:5px;background:#eef4f6;color:#183e59;font-size:10px;font-weight:800;line-height:1;vertical-align:-8px;overflow:hidden}.organization-logo>span{grid-area:1/1}.organization-logo img{display:none;grid-area:1/1;width:100%;height:100%;padding:3px;object-fit:contain;background:#fff}.organization-logo.has-image>span{display:none}.organization-logo.has-image img{display:block}.conversation-heading h3,.opportunity-heading-label{display:flex;align-items:center}.opportunity-card>summary:before{display:none!important}.opportunity-summary-main{display:grid;grid-template-columns:16px 50px minmax(0,1fr);grid-template-rows:auto auto;column-gap:10px;align-items:start}.opportunity-summary-main>.disclosure-heading{display:contents}.opportunity-summary-main>.disclosure-heading .disclosure-chevron{grid-column:1;grid-row:1 / span 2;align-self:center}.opportunity-summary-main .opportunity-heading-label{display:contents}.opportunity-summary-main .opportunity-heading-label .organization-logo{grid-column:2;grid-row:1 / span 2;width:50px;height:50px;margin:0;border-radius:7px;vertical-align:initial}.opportunity-summary-main .opportunity-heading-label .organization-name{grid-column:3;grid-row:1;align-self:start;min-width:0;line-height:1.15}.opportunity-summary-main>small{grid-column:3;grid-row:2;align-self:start;margin:3px 0 0;line-height:1.15}.news-grid>article>div:first-child{display:grid;grid-template-columns:50px minmax(0,1fr);grid-template-rows:auto auto auto;column-gap:10px;align-items:start}.news-grid>article>div:first-child>.tier{grid-column:1 / -1;grid-row:1;justify-self:start}.news-grid>article>div:first-child>h3{display:contents}.news-grid>article>div:first-child>h3 .organization-logo{grid-column:1;grid-row:2 / span 2;width:50px;height:50px;margin:0;border-radius:7px;vertical-align:initial}.news-grid>article>div:first-child>h3 .organization-name{grid-column:2;grid-row:2;align-self:start;min-width:0;line-height:1.15}.news-grid>article>div:first-child>p{grid-column:2;grid-row:3;align-self:start;margin:3px 0 0;line-height:1.15}.conversation-more{margin-top:12px;border-top:1px solid #d8e1e8}.conversation-more-toggle{appearance:none;display:flex;align-items:center;width:100%;padding:10px 2px;border:0;background:transparent;color:#153e5c;font:800 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;text-align:left;cursor:pointer}.conversation-more-toggle:hover{background:#eef7f5}.conversation-more-toggle:focus-visible{outline:2px solid #0f766e;outline-offset:2px}.conversation-more-toggle .disclosure-heading{flex:1}.conversation-more-content{margin-top:0}.conversation-more-content[hidden]{display:none}.conversation-more.is-open .disclosure-chevron{transform:rotate(45deg)}.toc{isolation:isolate}.toc-mobile-bar{background:#fff}.toc-select{background:#fff}@media(max-width:960px){.toc{background:#fff}.toc-mobile-bar{position:relative;background:#fff}.section{background:#f4f7f9}}@media(max-width:640px){.opportunity-summary-main{grid-template-columns:14px 42px minmax(0,1fr);grid-template-rows:auto auto;column-gap:8px}.opportunity-summary-main .opportunity-heading-label .organization-logo{width:42px;height:42px}.opportunity-summary-main>small{font-size:10px;line-height:1.15}.news-grid>article>div:first-child{grid-template-columns:42px minmax(0,1fr);grid-template-rows:auto auto auto;column-gap:8px}.news-grid>article>div:first-child>h3 .organization-logo{width:42px;height:42px}.news-grid>article>div:first-child>p{font-size:10px;line-height:1.15}}
</style>`;
const conversationIdentityCss = `<style id="conversation-account-identity-enhancements">
.conversation-heading>div:first-child{display:grid;grid-template-columns:104px minmax(0,1fr);grid-template-rows:auto auto auto auto;column-gap:14px;align-items:center;min-width:0}.conversation-heading>div:first-child>.tier{grid-column:1/-1;grid-row:1;justify-self:start;margin-bottom:2px}.conversation-heading h3{display:contents}.conversation-heading h3 .organization-logo{grid-column:1;grid-row:2 / span 3;width:104px;height:104px;margin:0;align-self:start;border-radius:7px}.conversation-heading h3 .organization-name{grid-column:2;grid-row:2;min-width:0;color:#153e5c;font-size:20px;font-weight:800;line-height:1.22;overflow-wrap:anywhere}.conversation-heading .asset-meta{grid-column:2;grid-row:3;margin:5px 0 0}.conversation-heading .conversation-attendees{grid-column:2;grid-row:4;margin:5px 0 0}.conversation-heading .pill-row{align-self:start}
@media(max-width:640px){.conversation-heading>div:first-child{grid-template-columns:80px minmax(0,1fr);column-gap:12px}.conversation-heading h3 .organization-logo{width:80px;height:80px}.conversation-heading h3 .organization-name{font-size:18px}.conversation-heading .asset-meta{font-size:9px}.conversation-heading .conversation-attendees{font-size:11px}}
</style>`;
const mobileProfileFlowCss = `<style id="mobile-profile-flow-enhancements">
@media(max-width:960px){.rep-panel>.rep-heading{position:static!important;top:auto!important;display:block!important;height:auto!important;min-height:0!important;margin:0!important;padding:0 0 10px!important;background:transparent!important;border:0!important;border-radius:0!important;box-shadow:none!important;overflow:visible!important}.rep-panel>.rep-heading>div:first-child{display:none!important;position:static!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important}.rep-panel>.rep-heading .rep-stats{display:grid!important;position:static!important;top:auto!important;height:auto!important;min-height:0!important;margin:0!important;border:1px solid #d8e0e7!important;border-radius:6px!important;box-shadow:none!important}.rep-panel>.rep-heading + .section-copy{display:none!important}.profile-priority-heading{position:static!important;top:auto!important;height:auto!important;min-height:0!important;margin:0 0 8px!important;box-shadow:none!important}.profile-priority-heading::before{display:none!important}.profile{height:auto!important;min-height:0!important;align-items:flex-start!important}.profile-body{height:auto!important;min-height:0!important;flex:1 1 auto!important}.profile-head-sticky{top:calc(var(--toc-sticky-height, 61px) + var(--hero-identity-height, 0px))!important;height:auto!important;min-height:0!important}}
</style>`;
const extraCssWithLogos = `${extraCss}${modeMenuCss}${repCoverageCss}${profileCoverageCss}${heroIdentityCss}${logoCss}${conversationIdentityCss}${mobileProfileFlowCss}`;

const newEventInteractionCss = `<style id="event-interaction-enhancements">
.roster-search-panel{display:flex;align-items:end;gap:8px;flex-wrap:wrap}.roster-search-panel .roster-search{flex:1 1 220px;min-width:180px}.new-prospect-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:8px 11px;border:1px solid #b9cbd6;border-radius:5px;background:#fff;color:#153e5c;font:700 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer}.new-prospect-button:hover{background:#eef7f5;border-color:#0f766e}.new-prospect-button svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.interaction-button.icon-button{appearance:none;display:inline-grid;place-items:center;width:28px;height:28px;flex:none;margin:0 0 0 6px;padding:0;border:1px solid #b9cbd6;border-radius:4px;background:#fff;color:#0f766e;vertical-align:middle;cursor:pointer}.interaction-button.icon-button:hover{background:#eef7f5;border-color:#0f766e}.interaction-button.icon-button:focus-visible{outline:2px solid #0f766e;outline-offset:2px}.interaction-button.icon-button .interaction-icon{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.interaction-dialog{width:min(760px,calc(100vw - 28px));max-width:760px;border:0;border-radius:8px;padding:0;color:#17283b;box-shadow:0 22px 70px rgba(17,25,54,.28)}.interaction-dialog::backdrop{background:rgba(15,35,55,.48)}.interaction-dialog header{display:flex;justify-content:space-between;gap:16px;padding:18px 20px 14px;background:#153e5c;color:#fff}.interaction-dialog header h3{margin:0;font-size:19px}.interaction-help{margin:5px 0 0;color:#dce8ee;font-size:12px;line-height:1.4}.interaction-close{width:32px;height:32px;margin:0;padding:0;border:0;border-radius:4px;background:transparent;color:#fff;font-size:25px;line-height:1;cursor:pointer}.interaction-close:hover{background:rgba(255,255,255,.12)}.interaction-dialog form{display:grid;gap:12px;padding:18px 20px 20px}.interaction-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px 14px}.interaction-dialog label{display:block;margin:0;color:#294961;font-size:12px;font-weight:750}.interaction-dialog input,.interaction-dialog select,.interaction-dialog textarea{display:block;width:100%;margin-top:5px;border:1px solid #b9cbd6;border-radius:4px;padding:9px 10px;background:#fff;color:#17283b;font:inherit;font-size:14px}.interaction-dialog input,.interaction-dialog select{min-height:38px}.interaction-dialog textarea{min-height:110px;resize:vertical}.interaction-dialog input[readonly]{background:#f4f7f9}.interaction-dialog .interaction-span{grid-column:1 / -1}.interaction-new-fields[hidden],.interaction-existing-fields[hidden]{display:none}.interaction-status{margin:0;padding:9px 10px;border-radius:4px;background:#eef7f5;color:#0f766e;font-size:12px;line-height:1.4}.interaction-status.error{background:#fff1f0;color:#b42318}.interaction-actions{display:flex;justify-content:flex-end;gap:8px}.interaction-actions button{min-height:38px;padding:8px 13px;border:1px solid #b9cbd6;border-radius:4px;background:#fff;color:#294961;font:750 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer}.interaction-actions button[type="submit"]{border-color:#153e5c;background:#153e5c;color:#fff}.interaction-actions button:hover{filter:brightness(.97)}
@media(max-width:600px){.roster-search-panel{align-items:stretch}.roster-search-panel .roster-search{flex-basis:100%}.new-prospect-button{flex:1 1 100%}.interaction-grid{grid-template-columns:1fr}.interaction-dialog form{padding:15px}.interaction-dialog header{padding:15px}.interaction-dialog .interaction-span{grid-column:auto}.interaction-actions{display:grid;grid-template-columns:1fr 1fr}.interaction-actions button{width:100%}}
</style>`;

const newEventInteractionMarkup = `<dialog id="interaction-dialog" class="interaction-dialog" aria-labelledby="interaction-dialog-title"><header><div><h3 id="interaction-dialog-title">Log event interaction</h3><p class="interaction-help">Submit this interaction to Salesforce through Clay. Event context is prefilled from the CUBG roster.</p></div><button class="interaction-close" type="button" aria-label="Close">&times;</button></header><form id="interaction-form"><input name="recordType" type="hidden" value="existing_contact"><div class="interaction-existing-fields"><div class="interaction-grid"><label>Contact<input name="contact" type="text" readonly></label><label>Company<input name="company" type="text" readonly></label><label>Role<input name="role" type="text" readonly></label><label>Event date<input name="eventDateDisplay" type="text" readonly></label><label class="interaction-span">Account context<input name="accountContext" type="text" readonly></label><label>Pipeline<input name="pipeline" type="text" readonly></label><label>Location<input name="location" type="text" readonly></label></div></div><div class="interaction-new-fields" hidden><div class="interaction-grid"><label>First name<input name="firstName" type="text" autocomplete="given-name"></label><label>Last name<input name="lastName" type="text" autocomplete="family-name"></label><label>Email<input name="newEmail" type="email" autocomplete="email"></label><label>Phone<input name="phone" type="tel" autocomplete="tel"></label><label>Title / role<input name="title" type="text" autocomplete="organization-title"></label><label>Account name<input name="accountName" type="text" autocomplete="organization" required></label><label>Account domain<input name="accountDomain" type="text" placeholder="example.org" required></label><label>City<input name="newCity" type="text" autocomplete="address-level2"></label><label>State<input name="newState" type="text" autocomplete="address-level1"></label></div><p class="interaction-help" style="color:#5f6f80;margin:10px 0 0">Use the organization website domain so Clay can match the existing Salesforce account safely. New Salesforce accounts are not created by this form.</p></div><input name="email" type="hidden"><input name="repName" type="hidden"><input name="eventName" type="hidden"><input name="eventDate" type="hidden"><input name="eventEndDate" type="hidden"><input name="campaignId" type="hidden"><input name="assetSize" type="hidden"><input name="accountOwner" type="hidden"><input name="accountStatus" type="hidden"><input name="crmStatus" type="hidden"><input name="openOpportunity" type="hidden"><input name="opportunityStage" type="hidden"><input name="opportunityOwner" type="hidden"><input name="opportunityCloseDate" type="hidden"><input name="campaignStatus" type="hidden"><input name="city" type="hidden"><input name="state" type="hidden"><input name="website" type="hidden"><input name="linkedin" type="hidden"><div class="interaction-grid"><label>Interaction type<select name="interactionType"><option>Conversation</option><option>Meeting</option><option>Session</option><option>Product Expo</option><option>Reception</option><option>Virtual meeting</option><option>Other</option></select></label><label>Date and time<input name="occurredAt" type="datetime-local"></label><label class="interaction-span">Notes<textarea name="notes" required placeholder="What did they say, ask about, or care about?"></textarea></label><label class="interaction-span">Next step<input name="nextStep" type="text" placeholder="Optional follow-up or owner"></label></div><p id="interaction-status" class="interaction-status" hidden></p><div class="interaction-actions"><button id="interaction-cancel" type="button">Cancel</button><button type="submit">Submit interaction</button></div></form></dialog>`;

const newEventInteractionBehavior = `<script id="event-interaction-behavior">(()=>{const config={"eventName":"CUBG West 2026","eventDate":"2026-09-14","eventEndDate":"2026-09-16","campaignId":"701U100000zW5hSIAS","webhookUrl":"https://api.clay.com/v3/sources/webhook/a0a51d91-77af-4922-a25e-a36d024a62d1"};const dialog=document.getElementById("interaction-dialog");const form=document.getElementById("interaction-form");const status=document.getElementById("interaction-status");if(!dialog||!form)return;const field=name=>form.elements.namedItem(name);const setField=(name,value)=>{const target=field(name);if(target)target.value=value||""};const close=()=>{if(typeof dialog.close==="function")dialog.close();else dialog.removeAttribute("open");status.hidden=true;status.textContent="";status.classList.remove("error")};const companyParts=value=>{const parts=(value||"").trim().split(/\\s+(?=[a-z0-9-]+\\.[a-z]{2,}(?:\\/[^\\s]*)?$)/i);return{name:(parts[0]||value||"").trim(),domain:(parts[1]||"").replace(/^https?:\\/\\//i,"").replace(/^www\\./i,"").replace(/\\/$/,"")}};const rowData=button=>{const row=button.closest("tr");const cells=row?[...row.cells].map(cell=>cell.innerText.replace(/\\s+/g," ").trim()):[];const emailLink=button.closest("td")?.querySelector('a[href^="mailto:"]');const websiteLink=row?.cells?.[3]?.querySelector('a[href^="http"]');const email=emailLink?.getAttribute("href")?.replace(/^mailto:/i,"")||"";const accountContext=cells[4]||"";const ownerMatch=accountContext.match(/Account owner:\\s*([^|]+)/i);const company=companyParts(cells[3]||button.dataset.company||"");return{email,contact:button.dataset.contact||"",company:company.name,domain:company.domain,role:button.dataset.role||cells[2]||"",accountContext,pipeline:cells[5]||"",location:cells[6]||"",accountOwner:(ownerMatch?.[1]||"").trim(),website:websiteLink?.href||"",linkedin:button.closest("td")?.querySelector('a.linkedin')?.href||""}};const setCommon=data=>{setField("eventDateDisplay",config.eventDate+" to "+config.eventEndDate);setField("eventName",config.eventName);setField("eventDate",config.eventDate);setField("eventEndDate",config.eventEndDate);setField("campaignId",config.campaignId);setField("occurredAt",config.eventDate+"T12:00");setField("interactionType","Conversation");setField("notes","");setField("nextStep","");setField("repName",data?.accountOwner||"Unassigned");setField("accountOwner",data?.accountOwner||"");setField("assetSize","");setField("accountStatus",data?.accountContext||"");setField("crmStatus","");setField("openOpportunity",data?.pipeline||"");setField("opportunityStage","");setField("opportunityOwner",data?.accountOwner||"");setField("opportunityCloseDate","");setField("campaignStatus","");setField("city","");setField("state","");setField("website",data?.website||"");setField("linkedin",data?.linkedin||"")};const resetStatus=()=>{status.hidden=true;status.textContent="";status.classList.remove("error")};const openExisting=button=>{const data=rowData(button);setField("recordType","existing_contact");form.querySelector(".interaction-existing-fields").hidden=false;form.querySelector(".interaction-new-fields").hidden=true;document.getElementById("interaction-dialog-title").textContent="Log event interaction";setField("contact",data.contact);setField("company",data.company);setField("role",data.role);setField("accountContext",data.accountContext);setField("pipeline",data.pipeline);setField("location",data.location);setField("email",data.email);setCommon(data);resetStatus();if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","")};const openNew=()=>{setField("recordType","new_prospect");form.querySelector(".interaction-existing-fields").hidden=true;form.querySelector(".interaction-new-fields").hidden=false;document.getElementById("interaction-dialog-title").textContent="Add new prospect interaction";["firstName","lastName","newEmail","phone","title","accountName","accountDomain","newCity","newState"].forEach(name=>setField(name,""));setCommon();setField("contact","");setField("company","");setField("role","");setField("accountContext","New prospect");setField("pipeline","No open pipeline");setField("location","");setField("email","");resetStatus();if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");field("firstName")?.focus()};document.querySelectorAll(".interaction-button").forEach(button=>button.addEventListener("click",()=>openExisting(button)));document.querySelectorAll(".roster-search-panel").forEach(panel=>{if(panel.querySelector(".new-prospect-button"))return;const button=document.createElement("button");button.type="button";button.className="new-prospect-button";button.setAttribute("aria-label","Add new prospect");button.title="Add new prospect";button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg><span>New prospect</span>';button.addEventListener("click",openNew);panel.append(button)});dialog.querySelector(".interaction-close")?.addEventListener("click",close);document.getElementById("interaction-cancel")?.addEventListener("click",close);form.addEventListener("submit",async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(form));const isNew=values.recordType==="new_prospect";if(isNew&&!values.accountDomain){status.hidden=false;status.textContent="Account domain is required so Clay can match the Salesforce account safely.";status.classList.add("error");return}const contactName=isNew?[values.firstName,values.lastName].filter(Boolean).join(" "):values.contact;const company=isNew?values.accountName:values.company;const role=isNew?values.title:values.role;const email=isNew?values.newEmail:values.email;const city=isNew?values.newCity:values.city;const state=isNew?values.newState:values.state;const notes=["Interaction type: "+values.interactionType,"Contact: "+contactName+" | Company: "+company,"Role: "+role,"Account context: "+(values.accountContext||"New prospect"),"Pipeline: "+(values.pipeline||"No open pipeline"),city||state?"Location: "+[city,state].filter(Boolean).join(", "):"","Notes: "+values.notes,values.nextStep?"Next step: "+values.nextStep:""].filter(Boolean);const occurredAt=values.occurredAt?new Date(values.occurredAt).toISOString():new Date(config.eventDate+"T12:00:00").toISOString();const record={recordType:values.recordType,campaignId:config.campaignId,eventName:config.eventName,eventDate:config.eventDate,eventEndDate:config.eventEndDate,email,contactName,firstName:isNew?values.firstName:"",lastName:isNew?values.lastName:"",phone:isNew?values.phone:"",company,accountName:isNew?values.accountName:company,accountDomain:isNew?values.accountDomain:"",role,title:isNew?values.title:"",repName:values.repName,interactionType:values.interactionType,interactionDateTime:occurredAt,conversationNotes:notes.join("\\n"),nextStep:values.nextStep,assetSize:values.assetSize,accountOwner:values.accountOwner,accountStatus:values.accountStatus,crmStatus:values.crmStatus,openOpportunity:values.openOpportunity,opportunityStage:values.opportunityStage,opportunityOwner:values.opportunityOwner,opportunityCloseDate:values.opportunityCloseDate,campaignStatus:values.campaignStatus,city,state,website:values.website,linkedin:values.linkedin};const key="cubg-event-interactions";const prior=JSON.parse(localStorage.getItem(key)||"[]");const saved={...record,savedAt:new Date().toISOString(),syncStatus:"pending"};prior.push(saved);localStorage.setItem(key,JSON.stringify(prior));status.classList.remove("error");status.textContent="Submitting to Salesforce via Clay...";status.hidden=false;try{await fetch(config.webhookUrl,{method:"POST",mode:"no-cors",body:new Blob([new URLSearchParams(Object.entries(record)).toString()],{type:"application/x-www-form-urlencoded"}),keepalive:true});saved.syncStatus="submitted";saved.submittedAt=new Date().toISOString();localStorage.setItem(key,JSON.stringify(prior));status.textContent="Submitted to Salesforce via Clay.";setTimeout(close,1100)}catch(error){saved.syncStatus="pending";localStorage.setItem(key,JSON.stringify(prior));status.textContent="Saved locally; retry when you have a connection.";status.classList.add("error")}})})();</script>`;

const wiredNewProspectBehavior = newEventInteractionBehavior.replace(
  'document.querySelectorAll(".roster-search-panel").forEach(panel=>{if(panel.querySelector(".new-prospect-button"))return;',
  'document.querySelectorAll(".roster-search-panel").forEach(panel=>{const existing=panel.querySelector(".new-prospect-button");if(existing){existing.addEventListener("click",openNew);return};',
);

const officialLogoSources = {
  "amucu.org": ["https://www.amucu.org/wp-content/uploads/2024/05/AU-logo_positive_PMS_3-color.svg"],
  "aplusfcu.org": ["https://aplusfcu.org/wp-content/themes/aplusfcu/images/dist/A+_logo.svg"],
  "atfcu.org": ["https://cdn.prod.website-files.com/685e95cb77b380aafa9d03f1/685e99be5f9b7d334ba156b3_92a2628b14c11e6295a9dad82be7386e_Logo_ATFCU%20Logo%20Blue.svg"],
  "azfcu.org": ["https://www.arizonafinancial.org/hubfs/AZFinancial_CU_RGB%201.svg"],
  "bfcu.org": ["https://www.bfcu.org/home/fiFiles/static/images/logo.png"],
  "cu1.org": ["https://www.cu1.org/hubfs/assets/images/logos/logo-on-dark.svg"],
  "cuone.org": ["https://www.cuone.org/Images/logo.svg?v=GfVk1R_U7-CU_hAlrq5gBxjSu-d8dmyOTJwu0a0bEz0"],
  "cuwest.org": ["https://www.cuwest.org/assets/img/credit-union-west.svg"],
  "desertvalleys.org": ["https://www.desertvalleys.org/images/logo.svg"],
  "elgacu.com": ["https://www.elgacu.com/wp-content/uploads/2025/03/cropped-Favicon-192x192.png"],
  "efirstflight.com": ["https://www.firstflightcu.com/wp-content/uploads/2026/04/cropped-favicon-new-270x270.png"],
  "familyfirstny.com": ["https://home.familyfirstny.com/wp-content/uploads/2021/09/icons_for_svg_logo_familyfirst_color.svg"],
  "fcfcu.com": ["https://www.fcfcu.com/static/fcfcu-logo-a6ae74f0f6b71f305f8cc90b1090e850-cff4b.webp"],
  "finseccu.com": ["https://static1.squarespace.com/static/ta/5bfc192eb98a787cb5138aad/328/assets/fscu-logo.png"],
  "firstus.org": ["https://firstus.org/images/svg/FUSLogFirstUS.svg"],
  "frontiercreditunion.com": ["https://frontiercreditunion.com/wp-content/uploads/2026/01/Frontier-Logo.svg"],
  "gatherfcu.org": ["https://www.gatherfcu.org/assets/img/gatherfcu-logo.svg"],
  "gecu.com": ["https://www.gecu.com/siteassets/media-library/project/gecu/com/logo-svg.svg"],
  "gtfcu.org": ["https://www.gtfcu.org/assets/img/greater-texas-cu-logo.svg"],
  "holyrosarycu.org": ["https://www.holyrosarycu.org/templates/holy_rosary/images/logo.png"],
  "hometowncu.coop": ["https://www.hometowncu.coop/S3Assets/HomeTown/Images/favicon/apple-touch-icon.png"],
  "iccu.com": ["https://cdn.iccu.com/wp-content/uploads/2025/01/cropped-ICCU-logomark-green-192x192.png"],
  "inroadscu.org": ["https://www.inroadscu.org/Images/logo.svg"],
  "kitsapcu.org": ["https://kitsapcu.org/getmedia/36c28bb1-52b3-4a25-bb1c-a51bfd2015c2/kcu-new-colors-logo-black.png?width=534&height=110&ext=.png"],
  "logixbanking.com": ["https://www.logixbanking.com/-/media/images/logos/logix_logo.svg?iar=0&hash=7FF9CEFEE7DDCEEFE832A5AF60471227"],
  "madcofcu.org": ["https://www.madcofcu.org/wp-content/themes/madison_county_2021/img/logo.svg"],
  "marinefederalhb.org": ["https://images.squarespace-cdn.com/content/v1/69cbc7146d4ac36e9b97e42d/521bf046-c6de-4342-b889-832eba4aded8/MarineFCULogo.png?format=1500w"],
  "midoregon.com": ["https://www.midoregon.com/images/logo-dark.png"],
  "mydrcu.com": ["https://www.desertriverscu.com/wp-content/uploads/2019/11/DRCU_Logo_Horiz__notag_300xhoriz_web.png"],
  "myoccu.org": ["https://myoccu.org/themes/custom/themekit/logo.svg"],
  "noblecu.com": ["https://www.noblecu.com/wp-content/themes/ncr-child-theme/images/img-logo-icon.png"],
  "onpointcu.com": ["https://www.onpointcu.com/wp-content/themes/onpointcu-theme/images/OnPoint_logo_header.svg"],
  "ourcu.com": ["https://images.squarespace-cdn.com/content/v1/5f15a29dfe5be07ce0cac3dd/64204cce-64e7-4fb7-9c3f-d16689728736/OURCU+2024_FIN_RGB.png?format=1500w"],
  "palmettocitizens.org": ["https://www.palmettocitizens.org/img/svg/logo.svg"],
  "platinumfcu.org": ["https://www.platinumfcu.org/wp-content/uploads/2025/04/logo.png"],
  "pnwfcu.org": ["https://www.pnwfcu.org/wp-content/themes/ncr-child-theme/images/img-logo.png"],
  "pvcu.org": ["https://www.pvcu.org/S3Assets/PVCU/images/logo-site.svg"],
  "rizecu.com": ["https://rizecu.com/wp-content/uploads/RIZE-logo-4c-h.svg"],
  "salalcu.org": ["https://www.salalcu.org/wp-content/uploads/2023/11/salal-logo-300x91.png"],
  "secunm.org": ["https://www.secunm.org/custom/secunm3/image/logo-2x.png"],
  "selfreliance.com": ["https://www.selfreliance.com/includes/svg/logo.svg?01"],
  "sierrapacificfcu.org": ["https://www.sierrapacificfcu.org/hs-fs/hubfs/021226_Sierra%20Pacific_90_Logo_Horizontal_Color.png?width=1200&height=1200&name=021226_Sierra%20Pacific_90_Logo_Horizontal_Color.png"],
  "soundcu.com": ["https://www.soundcu.com/wp-content/themes/soundcu-theme/images/soundcu-logo.svg"],
  "stcu.org": ["https://stcu.org/images/Logo-STCU-Full-Color.svg"],
  "suncommunityfcu.org": ["https://cdn.prod.website-files.com/63a218ea0df9a527e152eef6/63fd0d9c1b4680435860ae56_sun_logo_0227Asset%201.svg"],
  "telcoe.com": ["https://www.telcoe.com/assets/img/brand/favicon.png", "https://www.telcoe.com/assets/img/brand/logo.png"],
  "tencu.com": ["https://www.tencu.com/custom/ttcu/image/ttcu-logo-icon.png"],
  "texomacu.com": ["https://texomacu.com/wp-content/themes/tccu2025/media/ui/icons/tccu-logo.svg"],
  "unclecu.org": ["https://www.unclecu.org/wp-content/uploads/2024/06/UNCLE_Logo_Website_300x96_Transparent_BG.png"],
  "utahfirst.com": ["https://utahfirst.com/wp-content/uploads/2026/02/logo-with-r.svg"],
  "vantagewest.org": ["https://vantagewest.org/wp-content/uploads/2025/08/VW-Logo_Full-Color.svg"],
  "vcu.com": ["https://www.vcu.com/images/default-source/default-album/vcu-logo.svg?sfvrsn=8f96a8c5_1"],
  "vicfcu.org": ["https://www.vicfcu.org/home/diFiles/skins/default/images/logo.png"],
  "wecu.com": ["https://www.wecu.com/wp-content/uploads/cropped-favicon-180x180.png"],
  "wingsfinancial.com": ["https://www.wingscu.com/assets/dist26/img/wings-simple-logo.svg"],
  "wsecu.org": ["https://wsecu.org/img/WSECU_FooterLogo.svg"],
};

const navStart = report.indexOf('<nav class="toc">');
const navEnd = report.indexOf("</nav>", navStart);
if (navStart < 0 || navEnd < 0) throw new Error("Could not find the report navigation");
const nav = report.slice(navStart, navEnd + 6);
const seenSectionHrefs = new Set();
const sectionOptions = [...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)]
  .filter(([, href]) => !seenSectionHrefs.has(href) && seenSectionHrefs.add(href))
  .map(([, href, label]) => `<option value="${href}">${label}</option>`)
  .join("");
const repOptions = [...nav.matchAll(/<button class="toc-rep-button[^\"]*" type="button" data-target="([^"]+)"[^>]*>([^<]+)<\/button>/g)]
  .map(([, target, label]) => `<option value="#reps" data-rep-target="${target}">${label}</option>`)
  .join("");
const mobileSectionOptions = sectionOptions
  .replace('<option value="#top5">Top Prospect Conversations</option>', top5ModeMobileOptions)
  .replace('<option value="#reps">Rep Coverage</option>', `<optgroup label="Rep Coverage">${repOptions}${fullRosterMobileOption}</optgroup>`);
const mobileMenu = `<div class="toc-mobile-bar"><label class="sr-only" for="toc-select">Jump to a section</label><select id="toc-select" class="toc-select" aria-label="Jump to a section">${mobileSectionOptions}</select></div>`;
const cleanNav = nav.replace(/<div class="toc-mobile-bar">[\s\S]*?<\/div>/, "");
const navWithMobileMenu = cleanNav.replace('<h5>On This Page</h5>', `${mobileMenu}<h5>On This Page</h5>`);
report = report.slice(0, navStart) + navWithMobileMenu + report.slice(navEnd + 6);
if (report.includes('id="responsive-navigation-enhancements"')) {
  report = report.replace(/<style id="responsive-navigation-enhancements">[\s\S]*?<\/style>/, extraCssWithLogos);
} else {
  report = report.replace("</head>", `${extraCssWithLogos}</head>`);
}
report = report.replace("</head>", `${newEventInteractionCss}</head>`);
const newProspectButtonMarkup = '<button class="new-prospect-button" type="button" aria-label="Add new prospect" title="Add new prospect"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg><span>New prospect</span></button>';
report = report.replace(/(<div class="roster-search-panel"[^>]*>[\s\S]*?<p class="roster-search-status[^>]*>[\s\S]*?<\/p>)(<\/div>)/g, `$1${newProspectButtonMarkup}$2`);
report = report.replace("</body>", `${newEventInteractionMarkup}${wiredNewProspectBehavior}</body>`);
report = report.replace("if(isNew&&!values.accountDomain){", "if(isNew&&(!values.lastName||!values.accountName||!values.accountDomain)){" );
report = report.replace("Account domain is required so Clay can match the Salesforce account safely.", "Last name, account name, and account domain are required so Clay can match the Salesforce account safely.");

const behaviorScript = `<script id="responsive-navigation-behavior">
(() => {
  const officialLogoSources = ${JSON.stringify(officialLogoSources)};
  const hero = document.querySelector("header.hero");
  const heroEyebrow = hero?.querySelector(":scope > .eyebrow");
  const heroTitle = hero?.querySelector(":scope > h1");
  if (hero && heroEyebrow && heroTitle && !document.querySelector(".hero-identity-sticky")) {
    const identity = document.createElement("div");
    identity.className = "hero-identity-sticky";
    identity.append(heroEyebrow, heroTitle);
    hero.parentElement.insertBefore(identity, hero);
  }
  const layout = document.querySelector(".layout");
  const main = document.querySelector("main.wrap");
  const tocElement = document.querySelector(".toc");
  const syncMobileNavigationPlacement = () => {
    if (!layout || !main || !tocElement) return;
    const mobile = window.matchMedia("(max-width:960px)").matches;
    if (mobile && tocElement.parentElement !== main) main.insertBefore(tocElement, hero || null);
    if (!mobile && tocElement.parentElement !== layout) layout.insertBefore(tocElement, main);
  };
  syncMobileNavigationPlacement();
  const normalizeAccountName = (value) => value.replace(/\\s+/g, " ").trim().toLowerCase();
  const normalizeHost = (value) => value?.startsWith("www.") ? value.slice(4) : value;
  const companyDomains = new Map();
  document.querySelectorAll(".table-wrap td").forEach((cell) => {
    const account = cell.querySelector("strong");
    const website = [...cell.querySelectorAll('a[href^="http"]')].find((link) => !link.classList.contains("linkedin"));
    if (account && website) {
      try {
        companyDomains.set(normalizeAccountName(account.textContent), new URL(website.href).hostname);
      } catch {}
    }
  });
  const initials = (name) => name.split(/\\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const addOrganizationLogo = (element, accountName) => {
    if (!element || element.querySelector(".organization-logo")) return;
    const host = normalizeHost(companyDomains.get(normalizeAccountName(accountName)));
    if (!host) return;
    const logo = document.createElement("span");
    logo.className = "organization-logo";
    const fallback = document.createElement("span");
    fallback.textContent = initials(accountName);
    logo.setAttribute("aria-label", accountName + " logo");
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "eager";
    image.referrerPolicy = "no-referrer";
    const sources = [...new Set([
      ...(officialLogoSources[host] || []),
      "https://" + host + "/favicon.ico",
      "https://icons.duckduckgo.com/ip3/" + encodeURIComponent(host) + ".ico"
    ])];
    let sourceIndex = 0;
    const tryNextSource = () => {
      if (sourceIndex >= sources.length) return;
      image.src = sources[sourceIndex++];
    };
    image.addEventListener("load", () => logo.classList.add("has-image"), {once:true});
    image.addEventListener("error", tryNextSource);
    logo.append(fallback, image);
    if (element.matches(".conversation-heading h3")) {
      const name = document.createElement("span");
      name.className = "organization-name";
      name.textContent = accountName;
      element.textContent = "";
      element.append(logo, name);
    } else {
      const name = document.createElement("span");
      name.className = "organization-name";
      name.textContent = accountName;
      element.textContent = "";
      element.append(logo, name);
    }
    tryNextSource();
  };
  document.querySelectorAll(".conversation-heading h3,.opportunity-heading-label,.news-grid h3").forEach((element) => addOrganizationLogo(element, element.textContent));
  document.querySelectorAll(".profile-head span strong").forEach((element) => addOrganizationLogo(element, element.textContent));
  document.querySelectorAll(".profile").forEach((profile) => {
    const body = profile.querySelector(".profile-body");
    const head = body?.querySelector(".profile-head");
    if (!body || !head) return;
    const oldStickyHeader = body.querySelector(".profile-sticky-header");
    if (oldStickyHeader) oldStickyHeader.replaceWith(head);
    head.classList.add("profile-head-sticky");
  });
  document.querySelectorAll(".rep-panel").forEach((panel) => {
    const priorityHeading = [...panel.querySelectorAll(":scope > h4.subsection")].find((heading) => heading.textContent.trim() === "Priority profiles");
    if (priorityHeading) priorityHeading.classList.add("profile-priority-heading");
  });
  const repSection = document.querySelector("#reps");
  const repTabs = document.querySelector("#reps ~ .rep-tabs");
  const updateRepHeadingOffsets = () => {
    document.querySelectorAll(".rep-panel").forEach((panel) => {
      const heading = panel.querySelector(":scope > .rep-heading");
      if (heading) {
        panel.style.setProperty("--rep-heading-height", Math.ceil(heading.getBoundingClientRect().height) + "px");
        const identity = heading.querySelector(":scope > div:first-child");
        panel.style.setProperty("--rep-identity-height", Math.ceil(identity?.getBoundingClientRect().height || heading.getBoundingClientRect().height) + "px");
      }
    });
  };
  const updateStickyOffsets = () => {
    const toc = document.querySelector(".toc");
    const identity = document.querySelector(".hero-identity-sticky");
    const isMobile = window.matchMedia("(max-width:960px)").matches;
    document.documentElement.style.setProperty("--toc-sticky-height", isMobile && toc ? Math.ceil(toc.getBoundingClientRect().height) + "px" : "0px");
    document.documentElement.style.setProperty("--hero-identity-height", identity ? Math.ceil(identity.getBoundingClientRect().height) + "px" : "0px");
    document.documentElement.style.setProperty("--rep-section-height", repSection ? Math.ceil(repSection.getBoundingClientRect().height) + "px" : "42px");
    const repTabsHeight = repTabs ? Math.ceil(repTabs.getBoundingClientRect().height) : 52;
    document.documentElement.style.setProperty("--rep-tabs-height", repTabsHeight + "px");
    const repTabsTop = repTabs ? parseFloat(getComputedStyle(repTabs).top) : NaN;
    if (Number.isFinite(repTabsTop)) {
      document.documentElement.style.setProperty("--rep-tabs-sticky-bottom", Math.ceil(repTabsTop + repTabsHeight) + "px");
    }
    const priorityHeading = document.querySelector(".rep-panel.active .profile-priority-heading");
    document.documentElement.style.setProperty("--profile-priority-height", priorityHeading ? Math.ceil(priorityHeading.getBoundingClientRect().height) + "px" : "0px");
    updateRepHeadingOffsets();
  };
  updateStickyOffsets();
  window.addEventListener("resize", () => { syncMobileNavigationPlacement(); updateStickyOffsets(); }, {passive:true});
  if (window.ResizeObserver) {
    const repHeadingObserver = new ResizeObserver(updateStickyOffsets);
    document.querySelectorAll(".rep-heading").forEach((heading) => repHeadingObserver.observe(heading));
    if (repSection) repHeadingObserver.observe(repSection);
    if (repTabs) repHeadingObserver.observe(repTabs);
    document.querySelectorAll(".profile-priority-heading").forEach((heading) => repHeadingObserver.observe(heading));
    const toc = document.querySelector(".toc");
    const identity = document.querySelector(".hero-identity-sticky");
    if (toc) repHeadingObserver.observe(toc);
    if (identity) repHeadingObserver.observe(identity);
  }
  const tocSelect = document.getElementById("toc-select");
  const documentTopFor = (target) => {
    const stickySections = [...document.querySelectorAll(".section")];
    const originalPositions = stickySections.map((section) => section.style.position);
    stickySections.forEach((section) => { section.style.position = "static"; });
    const pageTop = target.getBoundingClientRect().top + window.scrollY;
    stickySections.forEach((section, index) => { section.style.position = originalPositions[index]; });
    return pageTop;
  };
  const tocSectionLinks = [...document.querySelectorAll('.toc a[href^="#"]')];
  const tocSectionTargets = tocSectionLinks.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
  const mobileViewport = window.matchMedia("(max-width:960px)");
  const mobilePageSectionIds = new Set(tocSectionTargets.map((section) => section.id));
  const resetMobilePageScroll = () => {
    if (!mobileViewport.matches) return;
    const root = document.documentElement;
    const previousScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
    window.requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      root.style.scrollBehavior = previousScrollBehavior;
    });
  };
  tocSectionTargets.forEach((section) => {
    section.classList.add("mobile-page-section");
    section.dataset.mobilePageSection = section.id;
    let sibling = section.nextElementSibling;
    while (sibling && !mobilePageSectionIds.has(sibling.id)) {
      sibling.classList.add("mobile-page-section");
      sibling.dataset.mobilePageSection = section.id;
      sibling = sibling.nextElementSibling;
    }
  });
  const setMobileMenuValue = (sectionId) => {
    if (!tocSelect) return;
    const options = [...tocSelect.options];
    const option = options.find((item) => {
      if (sectionId === "top5") return item.dataset.modeTarget === selectedMode;
      if (sectionId === "reps") return item.dataset.repTarget === selectedRepTarget || (item.dataset.rosterFilter === "all" && selectedRepTarget === "rep-full-roster");
      return item.value === "#" + sectionId && !item.dataset.modeTarget && !item.dataset.repTarget && !item.dataset.rosterFilter;
    });
    options.forEach((item) => { item.selected = item === option; });
  };
  const applyMobilePageSection = (sectionId, {historyMode = "none", scroll = true} = {}) => {
    if (!mobileViewport.matches || !main || !mobilePageSectionIds.has(sectionId)) return false;
    main.classList.add("mobile-page-mode");
    main.dataset.mobilePageSection = sectionId;
    main.querySelectorAll(":scope > .mobile-page-section").forEach((item) => {
      item.classList.toggle("mobile-page-active", item.dataset.mobilePageSection === sectionId);
    });
    setMobileMenuValue(sectionId);
    if (historyMode === "push" || historyMode === "replace") {
      history[historyMode + "State"](null, "", "#" + sectionId);
    }
    if (scroll) resetMobilePageScroll();
    if (typeof syncMainMenuState === "function") syncMainMenuState();
    if (typeof syncSubmenuStates === "function") syncSubmenuStates(sectionId);
    return true;
  };
  let pendingMenuSectionId = null;
  let mainMenuSyncFrame = 0;
  const syncMainMenuState = () => {
    mainMenuSyncFrame = 0;
    if (!tocSectionTargets.length) return;
    let currentIndex = 0;
    if (mobileViewport.matches && main?.classList.contains("mobile-page-mode") && main.dataset.mobilePageSection) {
      const mobileIndex = tocSectionTargets.findIndex((section) => section.id === main.dataset.mobilePageSection);
      if (mobileIndex >= 0) currentIndex = mobileIndex;
    } else {
      const stickySections = [...document.querySelectorAll(".section")];
      const originalPositions = stickySections.map((section) => section.style.position);
      stickySections.forEach((section) => { section.style.position = "static"; });
      const pageTops = tocSectionTargets.map((section) => section.getBoundingClientRect().top + window.scrollY);
      stickySections.forEach((section, index) => { section.style.position = originalPositions[index]; });
      const stickyTarget = tocSectionTargets.find((section) => section.classList.contains("section"));
      const stickyTop = stickyTarget ? parseFloat(getComputedStyle(stickyTarget).top) : 0;
      const activationLine = window.scrollY + (Number.isFinite(stickyTop) ? stickyTop : 0) + 1;
      pageTops.forEach((pageTop, index) => { if (pageTop <= activationLine) currentIndex = index; });
    }
    tocSectionLinks.forEach((link, index) => {
      const active = index === currentIndex;
      link.classList.toggle("active", active);
      link.setAttribute("aria-current", active ? "location" : "false");
    });
  };
  const scheduleMainMenuSync = () => {
    if (!mainMenuSyncFrame) mainMenuSyncFrame = window.requestAnimationFrame(syncMainMenuState);
  };
  window.addEventListener("scroll", scheduleMainMenuSync, {passive:true});
  if (window.MutationObserver) {
    const mainMenuObserver = new MutationObserver(scheduleMainMenuSync);
    tocSectionLinks.forEach((link) => mainMenuObserver.observe(link, {attributes:true, attributeFilter:["class"]}));
  }
  scheduleMainMenuSync();
  const scrollToSection = (selector, {historyMode = "push"} = {}) => {
    const target = document.querySelector(selector);
    if (!target) return;
    if (mobileViewport.matches && mobilePageSectionIds.has(target.id) && typeof applyMobilePageSection === "function") {
      pendingMenuSectionId = target.id;
      applyMobilePageSection(target.id, {historyMode, scroll:true});
      if (typeof syncSubmenuStates === "function") {
        syncSubmenuStates(target.id);
        if (typeof schedulePendingMenuSection === "function") schedulePendingMenuSection(target.id);
      }
      return;
    }
    const computedStyle = getComputedStyle(target);
    const stickyTop = target.classList.contains("section") ? parseFloat(computedStyle.top) : NaN;
    const scrollMarginTop = parseFloat(computedStyle.scrollMarginTop);
    const offset = Number.isFinite(stickyTop) ? stickyTop : (Number.isFinite(scrollMarginTop) ? scrollMarginTop : 0);
    pendingMenuSectionId = target.id;
    window.scrollTo({top:Math.max(0, documentTopFor(target) - offset), behavior:"smooth"});
    if (historyMode === "push" || historyMode === "replace") history[historyMode + "State"](null, "", selector);
    if (typeof syncSubmenuStates === "function") {
      syncSubmenuStates(target.id);
      if (typeof schedulePendingMenuSection === "function") schedulePendingMenuSection(target.id);
    }
  };
  document.querySelectorAll('.toc a[href^="#"]').forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    scrollToSection(link.getAttribute("href"));
  }, true));
  const openMobileSectionMenu = () => {
    if (!mobileViewport.matches || !tocSelect) return;
    tocSelect.focus({preventScroll:true});
    tocSelect.click();
  };
  tocSectionTargets.forEach((section) => {
    const label = section.matches(".hero") ? "At a Glance" : section.querySelector(":scope > h2")?.textContent?.trim() || section.textContent.trim();
    section.setAttribute("role", "button");
    section.setAttribute("tabindex", "0");
    section.setAttribute("aria-label", "Open section menu for " + label);
    section.addEventListener("click", (event) => {
      if (!mobileViewport.matches || event.target.closest("a,button,select")) return;
      openMobileSectionMenu();
    });
    section.addEventListener("keydown", (event) => {
      if (!mobileViewport.matches || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      openMobileSectionMenu();
    });
  });
  let selectedMode = document.querySelector(".conversation-view.active")?.dataset.view || "prospect";
  const activateConversationMode = (mode) => {
    selectedMode = mode;
    document.querySelectorAll(".mode,.toc-mode-button").forEach((button) => {
      const active = button.dataset.mode === mode || button.dataset.modeTarget === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".conversation-view").forEach((view) => view.classList.toggle("active", view.dataset.view === mode));
  };
  document.querySelectorAll(".mode").forEach((button) => button.addEventListener("click", () => activateConversationMode(button.dataset.mode)));
  document.querySelectorAll(".toc-mode-button").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    activateConversationMode(button.dataset.modeTarget);
    scrollToSection("#top5");
  }, true));
  let selectedRepTarget = document.querySelector(".rep-panel.active")?.id || "rep-brittany-duncan";
  const showRepPanel = (target) => {
    selectedRepTarget = target;
    document.querySelectorAll(".rep-panel").forEach((panel) => panel.classList.remove("full-roster", "roster-view-hidden"));
    activateRep(target);
  };
  const showFullRoster = () => {
    selectedRepTarget = "rep-full-roster";
    document.querySelectorAll(".rep-panel").forEach((panel) => panel.classList.remove("full-roster", "roster-view-hidden"));
    activateRep("rep-full-roster");
    document.querySelectorAll(".rep-button,.toc-rep-button").forEach((button) => {
      button.classList.remove("active");
      button.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".roster-filter-button").forEach((button) => {
      button.classList.add("active");
      button.setAttribute("aria-selected", "true");
    });
  };
  const syncSubmenuStates = (sectionId) => {
    const activeSectionId = pendingMenuSectionId || sectionId;
    const inTop5 = activeSectionId === "top5";
    document.querySelectorAll(".toc-mode-button").forEach((button) => {
      const active = inTop5 && button.dataset.modeTarget === selectedMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const inReps = activeSectionId === "reps";
    document.querySelectorAll(".toc-rep-button").forEach((button) => {
      const active = inReps && ((button.dataset.rosterFilter === "all" && selectedRepTarget === "rep-full-roster") || button.dataset.target === selectedRepTarget);
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
  };
  let pendingMenuSectionTimer = 0;
  const finishPendingMenuSection = () => {
    if (!pendingMenuSectionId) return;
    const sectionId = pendingMenuSectionId;
    pendingMenuSectionId = null;
    window.clearTimeout(pendingMenuSectionTimer);
    pendingMenuSectionTimer = 0;
    syncSubmenuStates(sectionId);
  };
  const schedulePendingMenuSection = (sectionId) => {
    pendingMenuSectionId = sectionId;
    window.clearTimeout(pendingMenuSectionTimer);
    pendingMenuSectionTimer = window.setTimeout(finishPendingMenuSection, 220);
  };
  window.addEventListener("scroll", () => {
    if (pendingMenuSectionId) schedulePendingMenuSection(pendingMenuSectionId);
  }, {passive:true});
  window.addEventListener("scrollend", finishPendingMenuSection, {passive:true});
  if (window.IntersectionObserver) {
    const menuSections = ["#glance", "#top5", "#opps", "#news", "#reps"].map((selector) => document.querySelector(selector)).filter(Boolean);
    const submenuObserver = new IntersectionObserver((entries) => {
      const current = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (current) syncSubmenuStates(current.target.id);
    }, {rootMargin:"-18% 0px -68% 0px", threshold:[.01,.2,.5]});
    menuSections.forEach((section) => submenuObserver.observe(section));
  }
  const sectionIdFromLocation = () => {
    const hash = location.hash.toLowerCase();
    if (hash === "#roster" || hash === "#roster-table") return "reps";
    const sectionId = hash.slice(1);
    return mobilePageSectionIds.has(sectionId) ? sectionId : "glance";
  };
  const syncMobilePageForLocation = ({scroll = true} = {}) => {
    const isFullRoster = location.hash.toLowerCase() === "#roster" || location.hash.toLowerCase() === "#roster-table";
    if (isFullRoster) showFullRoster();
    const sectionId = sectionIdFromLocation();
    if (mobileViewport.matches) {
      applyMobilePageSection(sectionId, {scroll});
      if (!scroll) {
        resetMobilePageScroll();
        window.setTimeout(resetMobilePageScroll, 0);
      }
    } else if (isFullRoster) {
      scrollToSection("#reps", {historyMode:"replace"});
    }
    syncSubmenuStates(sectionId);
  };
  window.addEventListener("popstate", () => syncMobilePageForLocation({scroll:true}));
  const handleMobileViewportChange = () => {
    if (mobileViewport.matches) {
      syncMobilePageForLocation({scroll:false});
    } else {
      main?.classList.remove("mobile-page-mode");
      main?.querySelectorAll(":scope > .mobile-page-section").forEach((item) => item.classList.remove("mobile-page-active"));
      scheduleMainMenuSync();
    }
  };
  if (mobileViewport.addEventListener) mobileViewport.addEventListener("change", handleMobileViewportChange);
  syncMobilePageForLocation({scroll:false});
  tocSelect?.addEventListener("change", () => {
    const option = tocSelect.selectedOptions[0];
    const repTarget = option?.dataset.repTarget;
    const rosterFilter = option?.dataset.rosterFilter;
    const modeTarget = option?.dataset.modeTarget;
    if (modeTarget) {
      activateConversationMode(modeTarget);
      scrollToSection("#top5");
    } else if (rosterFilter === "all") {
      showFullRoster();
      scrollToSection("#reps");
    } else if (repTarget && typeof activateRep === "function") {
      showRepPanel(repTarget);
      scrollToSection("#reps");
    } else if (tocSelect.value) {
      scrollToSection(tocSelect.value);
    }
  });
  document.querySelectorAll(".rep-button,.toc-rep-button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (button.classList.contains("roster-filter-button")) {
        showFullRoster();
        scrollToSection("#reps");
        return;
      }
      const target = button.dataset.target;
      showRepPanel(target);
      if (button.classList.contains("toc-rep-button")) scrollToSection("#reps");
    }, true);
  });
  document.querySelectorAll('.conversation-view[data-view="prospect"] .conversation-card, .conversation-view[data-view="pipeline"] .conversation-card').forEach((card, cardIndex) => {
    if (card.dataset.progressiveDisclosure === "true") return;
    const people = card.querySelector(".featured-people");
    const insight = card.querySelector(".conversation-insight");
    const peopleItems = people ? [...people.children].filter((item) => item.classList.contains("featured-person")) : [];
    if (!people || !peopleItems.length) return;
    const body = people.parentElement;
    const more = document.createElement("div");
    more.className = "conversation-more";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "conversation-more-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = '<span class="disclosure-heading"><span class="disclosure-chevron" aria-hidden="true"></span><span>Attendees and Account Context</span></span>';
    const content = document.createElement("div");
    content.className = "conversation-more-content";
    content.id = "conversation-context-" + (cardIndex + 1);
    content.hidden = true;
    toggle.setAttribute("aria-controls", content.id);
    body.insertBefore(more, people);
    content.append(people);
    if (insight) content.append(insight);
    more.append(toggle);
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(expanded));
      more.classList.toggle("is-open", expanded);
      content.hidden = !expanded;
    });
    more.after(content);
    card.dataset.progressiveDisclosure = "true";
  });
})();
</script>`;
if (report.includes('id="responsive-navigation-behavior"')) {
  report = report.replace(/<script id="responsive-navigation-behavior">[\s\S]*?<\/script>/, behaviorScript);
} else {
  report = report.replace("</body>", `${behaviorScript}</body>`);
}
if (plaintextOutput) writeFileSync(plaintextOutput, report);
const salt = randomBytes(16);
const iv = randomBytes(12);
const iterations = 250000;
const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ciphertext = Buffer.concat([cipher.update(report, "utf8"), cipher.final(), cipher.getAuthTag()]);

const encode = (value) => value.toString("base64");
const payload = `window.CUBG_REPORT_PAYLOAD=${JSON.stringify({
  algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256",
  iterations,
  salt: encode(salt),
  iv: encode(iv),
  ciphertext: encode(ciphertext),
})};\n`;

const lockPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="googlebot" content="noindex,nofollow,noarchive">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CUBG West Sales Preview</title>
<style>
:root{color-scheme:light;--navy:#111936;--ink:#17283b;--muted:#5f6f80;--line:#d8e0e7;--accent:#ef5a43;--teal:#138b83}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#f4f6f8;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;padding:24px}
.gate-shell{width:min(100%,460px);background:#fff;border:1px solid var(--line);border-top:5px solid var(--accent);box-shadow:0 16px 40px rgba(17,25,54,.12);padding:34px 32px 32px}
.brand{color:var(--navy);font-size:22px;font-weight:800;letter-spacing:.01em;margin-bottom:28px}
.brand-mark{display:inline-block;width:13px;height:18px;background:var(--accent);clip-path:polygon(0 0,100% 25%,100% 100%,0 75%);vertical-align:-2px;margin-right:7px}
.eyebrow{color:var(--teal);font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin:0 0 10px}
h1{font-size:28px;line-height:1.12;margin:0 0 12px;color:var(--navy)}
.intro{color:var(--muted);font-size:15px;line-height:1.55;margin:0 0 26px}
label{display:block;color:var(--navy);font-size:13px;font-weight:700;margin:0 0 7px}
input{width:100%;height:46px;border:1px solid #b9c6d1;border-radius:4px;padding:0 12px;font:inherit;font-size:16px;color:var(--ink);background:#fff}
input:focus{outline:3px solid rgba(19,139,131,.2);border-color:var(--teal)}
button{width:100%;height:46px;border:0;border-radius:4px;background:var(--navy);color:#fff;font:inherit;font-weight:750;font-size:15px;margin-top:14px;cursor:pointer}
button:hover{background:#1b2b54}
button:disabled{opacity:.65;cursor:wait}
.error{color:#b42318;font-size:13px;line-height:1.4;margin:12px 0 0}
@media(max-width:520px){body{padding:14px}.gate-shell{padding:28px 22px 24px}h1{font-size:25px}}
</style>
</head>
<body>
<main class="gate-shell">
  <div class="brand"><span class="brand-mark" aria-hidden="true"></span>built</div>
  <p class="eyebrow">Built Technologies</p>
  <h1>2026 CUBG West Sales Preview</h1>
  <p class="intro">Enter the access password to view the pre-event sales brief.</p>
  <form id="unlock-form">
    <label for="password">Access password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button id="unlock-button" type="submit">Unlock report</button>
    <p id="error" class="error" role="alert" hidden>That password did not unlock the report.</p>
  </form>
</main>
<script src="./payload.js?v=${encode(salt).replace(/[^A-Za-z0-9]/g, "")}"></script>
<script>
(() => {
  const form = document.getElementById("unlock-form");
  const input = document.getElementById("password");
  const button = document.getElementById("unlock-button");
  const error = document.getElementById("error");
  const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

  async function unlock(password) {
    const payload = window.CUBG_REPORT_PAYLOAD;
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: fromBase64(payload.salt),
        iterations: payload.iterations,
        hash: "SHA-256"
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(payload.iv) },
      key,
      fromBase64(payload.ciphertext)
    );
    return new TextDecoder().decode(plaintext);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    button.disabled = true;
    button.textContent = "Unlocking...";
    try {
      const html = await unlock(input.value);
      document.open();
      document.write(html);
      document.close();
    } catch {
      input.value = "";
      error.hidden = false;
      input.focus();
      button.disabled = false;
      button.textContent = "Unlock report";
    }
  });
})();
</script>
</body>
</html>
`;

writeFileSync("payload.js", payload);
writeFileSync("index.html", lockPage);
console.log(`Built encrypted report from ${sourceRef || "the existing encrypted payload"}: ${report.length.toLocaleString()} characters`);
