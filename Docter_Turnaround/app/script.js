/* =====================================================
   CLAIMS TURNAROUND TIME REPORT — doctor login based
   ===================================================== */

// >>> PASTE your existing "data:image/png;base64,..." string between the quotes <<<
const MEDI_ELVES_LOGO_BASE64 = "PASTE_YOUR_EXISTING_BASE64_STRING_HERE";

let ALL_CLAIMS = [];
let FILTERED_DATA = [];
let ALL_HOSPITALS = [];
let DOCTOR_HOSPITAL_MAP = {};
let PATIENT_PAYER_MAP = {};
let PATIENT_INFO_MAP = {};
let TURNAROUND_SORT_DIR = null;

let CURRENT_USER_EMAIL = "";
let CURRENT_DOCTOR_ID = null;
let CURRENT_DOCTOR_NAME = "";

const HAS_LOGO = String(MEDI_ELVES_LOGO_BASE64).startsWith("data:image");

/* ---------------- GENERIC HELPERS ---------------- */

function toLabel(v) {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.map(toLabel).filter(Boolean).join(", ");
  if (typeof v === "object") return v.zc_display_value || v.display_value || v.ID || "";
  return String(v);
}

function parseZohoDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return isNaN(dateStr.getTime()) ? null : dateStr;
  const str = String(dateStr).trim();
  if (!str) return null;

  let m = str.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);       // DD/MM/YYYY
  if (m) {
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    return isNaN(d.getTime()) ? null : d;
  }
  m = str.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);           // YYYY-MM-DD
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d.getTime()) ? null : d;
  }
  const clean = str.replace(/-/g, " ").replace(/\bSept\b/gi, "Sep");  // 24-Aug-2026 / 28 Sept 2026
  const d = new Date(clean);
  if (!isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return null;
}

function fmtDate(d, twoDigitMonth) {
  if (!d) return "-";
  return d.toLocaleDateString("en-AU", {
    day: "2-digit", month: twoDigitMonth ? "2-digit" : "short", year: "numeric"
  });
}

// "MARIA FERRER - 29 Sep 1962" -> "MARIA FERRER"
function stripDob(text) {
  const D = "(?:\\d{1,2}\\s+[A-Za-z]+\\.?,?\\s+\\d{4}|\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})";
  const re = new RegExp("\\s*(?:[-–,]\\s+|\\(\\s*)(?:DOB:?\\s*)?" + D + "\\s*\\)?\\s*$", "i");
  return String(text || "").replace(re, "").trim();
}

/* ---------------- LOADING OVERLAY ---------------- */

function setLoadingProgress(pct, text) {
  const fill = document.getElementById("fxBarFill");
  const pctEl = document.getElementById("fxPct");
  const status = document.getElementById("fxStatus");
  if (fill) fill.style.width = pct + "%";
  if (pctEl) pctEl.textContent = Math.round(pct) + "%";
  if (status && text) status.textContent = text;
}
function hideLoading() {
  const el = document.getElementById("fxLoader");
  if (!el) return;
  setLoadingProgress(100, "Ready");
  setTimeout(() => el.classList.remove("is-active"), 400);
}

/* ---------------- DATA FETCH ---------------- */

async function fetchAllRecords(reportName, extraConfig = {}) {
  let all = [];
  let cursor = null;
  do {
    const config = { report_name: reportName, field_config: "all", max_records: 200, ...extraConfig };
    if (cursor) config.record_cursor = cursor;
    let resp;
    try {
      resp = await ZOHO.CREATOR.DATA.getRecords(config);
    } catch (err) {
      console.warn(`fetchAllRecords(${reportName}) stopped:`, err);
      break;
    }
    all = all.concat(resp.data || []);
    cursor = resp.record_cursor || null;
  } while (cursor);
  console.log(`${reportName}: fetched ${all.length} records`);
  return all;
}

/* ---------------- LOGGED-IN DOCTOR ---------------- */

async function identifyDoctor() {
  const init = await ZOHO.CREATOR.UTIL.getInitParams();
  CURRENT_USER_EMAIL = String(init.loginUser || "").trim().toLowerCase();
  console.log("Login user:", CURRENT_USER_EMAIL);

  // Portal_Doctors1 report: doctor name + doctor email
  const doctors = await fetchAllRecords("Portal_Doctors1");
  console.log("Portal_Doctors1 sample record:", doctors[0]);

  const me = doctors.find(d =>
    toLabel(d.Email || d.Doctor_Email || d.Email_ID).trim().toLowerCase() === CURRENT_USER_EMAIL
  );

  CURRENT_DOCTOR_ID = me ? String(me.ID) : null;

  if (me) {
    const n = me.Name || me.Doctor_Name;
    if (n && typeof n === "object") {
      CURRENT_DOCTOR_NAME = n.zc_display_value ||
        `${n.prefix || ""} ${n.first_name || ""} ${n.last_name || ""}`.replace(/\s+/g, " ").trim();
    } else {
      CURRENT_DOCTOR_NAME = String(n || me.zc_display_value || "").trim();
    }
  } else {
    CURRENT_DOCTOR_NAME = "";
  }

  const el = document.getElementById("f-doctor-display");
  if (el) el.textContent = CURRENT_DOCTOR_NAME || "Not linked to a doctor";
  return !!me;
}

function showNoAccess() {
  document.getElementById("report-body").innerHTML =
    `<tr><td colspan="10">Your login (${CURRENT_USER_EMAIL || "unknown"}) is not linked to a doctor.</td></tr>`;
  updateAvgTurnaroundBar([]);
}

/* ---------------- STARTUP ---------------- */

document.addEventListener("DOMContentLoaded", async function () {
  const logo = document.getElementById("header-logo");
  if (logo && HAS_LOGO) logo.src = MEDI_ELVES_LOGO_BASE64;

  initSearchableSelect("f-location", "All Hospitals");
  initSearchableSelect("f-patient", "All Patients");
  initSearchableSelect("f-payer", "All Payers");

  try {
    if (typeof ZOHO === "undefined") {
      console.error("ZOHO SDK not loaded");
      document.getElementById("report-body").innerHTML =
        `<tr><td colspan="10">Zoho SDK not loaded. Open this report inside Zoho Creator.</td></tr>`;
      return;
    }

    setLoadingProgress(10, "Identifying doctor");
    const found = await identifyDoctor();
    if (!found) { showNoAccess(); return; }

    setLoadingProgress(25, "Loading claims");
    const allClaims = await fetchAllRecords("Add_Claim_Report");
   let claims = allClaims.filter(c => c.Doctor && String(c.Doctor.ID) === String(CURRENT_DOCTOR_ID));

// Fallback: if the Doctor lookup points to a different form, match by doctor name
if (!claims.length && CURRENT_DOCTOR_NAME) {
  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(CURRENT_DOCTOR_NAME);
  claims = allClaims.filter(c => {
    const name = norm(c.Doctor?.zc_display_value || c.Doctor_Name);
    return name && (name === target || name.includes(target) || target.includes(name));
  });
}
ALL_CLAIMS = claims;

    setLoadingProgress(55, "Loading patients & hospitals");
    const [mappings, patients] = await Promise.all([
      fetchAllRecords("All_Doctor_Hospital_Mappings1"),
      fetchAllRecords("Add_Patient_Report")
    ]);

    setLoadingProgress(80, "Building lookup maps");
    buildPatientPayerMap(patients);
    buildPatientInfoMap(patients);
    buildDoctorHospitalMap(mappings);

    ALL_HOSPITALS = DOCTOR_HOSPITAL_MAP[CURRENT_DOCTOR_ID] || [];
    setSearchableOptions("f-location", ALL_HOSPITALS, "All Hospitals");

    const myPatientIds = new Set(claims.map(c => c.Patient && String(c.Patient.ID)).filter(Boolean));
    populatePatients(patients.filter(p => myPatientIds.has(String(p.ID))));
    populatePayers(claims);

    setLoadingProgress(92, "Rendering report");
    FILTERED_DATA = baseFilter(ALL_CLAIMS);
    renderTable(FILTERED_DATA);
  } catch (error) {
    console.error("Error:", error);
    document.getElementById("report-body").innerHTML =
      `<tr><td colspan="10">Error loading data. Please refresh.</td></tr>`;
  } finally {
    hideLoading();
  }
});

// Only Fully Paid claims are shown
function baseFilter(list) {
  return list.filter(c => {
    const s = String(c.Status?.zc_display_value || c.Status || "").trim().toLowerCase();
    return s === "fully paid";
  });
}

/* ---------------- LOOKUP MAPS ---------------- */

function buildPatientPayerMap(patients) {
  PATIENT_PAYER_MAP = {};
  patients.forEach(p => {
    if (!p.ID || !p.Payer) return;
    PATIENT_PAYER_MAP[p.ID] = { value: p.Payer.ID, label: p.Payer.zc_display_value };
  });
}

function buildPatientInfoMap(patients) {
  PATIENT_INFO_MAP = {};
  patients.forEach(p => {
    try {
      if (!p.ID) return;
      const first = p.Patient_Name?.first_name || p.First_Name || p.FirstName || p.Patient_First_Name || "";
      const last = p.Patient_Name?.last_name || p.Last_Name || p.LastName || p.Patient_Last_Name || p.Surname || "";
      let name = [first, last].filter(Boolean).join(" ").trim();
      if (!name && p.Patient_Name?.zc_display_value) name = p.Patient_Name.zc_display_value;
      if (!name) name = p.zc_display_value || "Unnamed Patient";

      const dobRaw = p.date_of_birth || p.DOB || p.dob || p.Birth_Date || p.Date_of_Birth;
      const d = parseZohoDate(dobRaw);
      const dobStr = d ? fmtDate(d) : (dobRaw || "");
      PATIENT_INFO_MAP[p.ID] = { value: p.ID, label: dobStr ? `${name} - ${dobStr}` : name };
    } catch (e) { console.error("Skipping malformed patient:", p, e); }
  });
}

function getLookupId(val) {
  if (!val) return null;
  if (typeof val === "object") return val.ID || val.id || null;
  return String(val);
}
function getLookupLabel(val) {
  if (!val) return "";
  if (typeof val === "object") return val.zc_display_value || val.display_value || val.Hospital_Name || "";
  return String(val);
}

function buildDoctorHospitalMap(mappings) {
  DOCTOR_HOSPITAL_MAP = {};
  function add(docId, hosId, label) {
    if (!docId || !hosId) return;
    const k = String(docId);
    if (!DOCTOR_HOSPITAL_MAP[k]) DOCTOR_HOSPITAL_MAP[k] = [];
    if (!DOCTOR_HOSPITAL_MAP[k].some(h => String(h.value) === String(hosId))) {
      DOCTOR_HOSPITAL_MAP[k].push({ value: String(hosId), label: label || "Hospital" });
    }
  }
  (mappings || []).forEach(m => {
    const docVal = m.Doctor_Name || m.Doctor || m.Doctors || m.Doctor_ID;
    const hosVal = m.Hospital || m.Hospital_Name || m.Hospitals || m.Hospital_ID;
    add(getLookupId(docVal), getLookupId(hosVal), getLookupLabel(hosVal));
  });
  // also include hospitals that appear on this doctor's claims
  (ALL_CLAIMS || []).forEach(c => {
    add(getLookupId(c.Doctor), getLookupId(c.Hospital), getLookupLabel(c.Hospital) || c.Hospital_Name);
  });
  Object.keys(DOCTOR_HOSPITAL_MAP).forEach(k =>
    DOCTOR_HOSPITAL_MAP[k].sort((a, b) => a.label.localeCompare(b.label)));
}

/* ---------------- FILTER DROPDOWN POPULATION ---------------- */

function populatePayers(claims) {
  const seen = new Set(), items = [];
  claims.forEach(c => {
    const p = getClaimPayer(c);
    if (p && p.label && !seen.has(p.value)) { seen.add(p.value); items.push({ value: p.value, label: p.label }); }
  });
  items.sort((a, b) => a.label.localeCompare(b.label));
  setSearchableOptions("f-payer", items, "All Payers");
}

function populatePatients(patients) {
  const items = patients.filter(p => p.ID && PATIENT_INFO_MAP[p.ID]).map(p => PATIENT_INFO_MAP[p.ID]);
  items.sort((a, b) => a.label.localeCompare(b.label));
  setSearchableOptions("f-patient", items, "All Patients");
}

/* ---------------- SEARCHABLE SELECT ---------------- */

function initSearchableSelect(id, allLabel) {
  const wrapper = document.getElementById(id);
  if (!wrapper) return;
  wrapper.classList.add("searchable-select");
  wrapper.dataset.value = "";
  wrapper.dataset.allLabel = allLabel;
  wrapper.innerHTML = `
    <div class="ss-control" tabindex="0">
      <span class="ss-value">${allLabel}</span>
      <span class="ss-arrow">&#9662;</span>
    </div>
    <div class="ss-dropdown">
      <input type="text" class="ss-search" placeholder="Search..." autocomplete="off" />
      <ul class="ss-options"></ul>
    </div>`;
  const control = wrapper.querySelector(".ss-control");
  const search = wrapper.querySelector(".ss-search");

  control.addEventListener("click", e => {
    e.stopPropagation();
    const willOpen = !wrapper.classList.contains("open");
    closeAllSearchableSelects();
    if (willOpen) {
      wrapper.classList.add("open");
      search.value = "";
      filterOptions(wrapper, "");
      setTimeout(() => search.focus(), 0);
    }
  });
  search.addEventListener("click", e => e.stopPropagation());
  search.addEventListener("input", () => filterOptions(wrapper, search.value));
  search.addEventListener("keydown", e => { if (e.key === "Escape") wrapper.classList.remove("open"); });
}

function setSearchableOptions(id, items, allLabel) {
  const wrapper = document.getElementById(id);
  if (!wrapper) return;
  const list = wrapper.querySelector(".ss-options");
  list.innerHTML = "";

  const allLi = document.createElement("li");
  allLi.textContent = allLabel;
  allLi.dataset.value = "";
  allLi.classList.add("ss-option", "ss-option-all");
  list.appendChild(allLi);

  items.forEach(item => {
    const li = document.createElement("li");
    li.textContent = item.label;
    li.dataset.value = item.value;
    li.classList.add("ss-option");
    list.appendChild(li);
  });

  const noRes = document.createElement("li");
  noRes.textContent = "No matches found";
  noRes.classList.add("ss-no-results");
  list.appendChild(noRes);

  list.querySelectorAll(".ss-option").forEach(li => {
    li.addEventListener("click", () => selectOption(wrapper, li.dataset.value, li.textContent));
  });
}

function selectOption(wrapper, value, label) {
  wrapper.dataset.value = value;
  const shown = (wrapper.id === "f-patient" && value) ? stripDob(label) : label;
  wrapper.querySelector(".ss-value").textContent = shown;
  wrapper.classList.remove("open");
}

function filterOptions(wrapper, query) {
  const q = query.trim().toLowerCase();
  let any = false;
  wrapper.querySelectorAll(".ss-option:not(.ss-option-all)").forEach(li => {
    const match = li.textContent.toLowerCase().includes(q);
    li.style.display = match ? "" : "none";
    if (match) any = true;
  });
  const nr = wrapper.querySelector(".ss-no-results");
  if (nr) nr.style.display = (q && !any) ? "" : "none";
}

function closeAllSearchableSelects() {
  document.querySelectorAll(".searchable-select.open").forEach(el => el.classList.remove("open"));
}
function getSearchableValue(id) {
  const w = document.getElementById(id);
  return w ? (w.dataset.value || "") : "";
}
document.addEventListener("click", closeAllSearchableSelects);

/* ---------------- CLAIM FIELD HELPERS ---------------- */

function getClaimLines(c) {
  return Array.isArray(c.Claim_Lines) ? c.Claim_Lines : [];
}

function getLineItemNumber(l) {
  if (l.Item && typeof l.Item === "object") return l.Item.zc_display_value || l.Item.ID || "-";
  return l.Item_Number || l.Item || "-";
}

// keeps same item numbers adjacent (needed for row grouping)
function getGroupedLines(c) {
  const groups = new Map();
  getClaimLines(c).forEach(l => {
    const k = getLineItemNumber(l);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  });
  const out = [];
  groups.forEach(arr => arr.forEach(l => out.push(l)));
  return out;
}

// for each line: span count if it starts a new item group, else null
function computeItemSpans(lines) {
  const spans = new Array(lines.length).fill(null);
  let i = 0;
  while (i < lines.length) {
    const cur = getLineItemNumber(lines[i]);
    let span = 1;
    while (i + span < lines.length && getLineItemNumber(lines[i + span]) === cur) span++;
    spans[i] = span;
    i += span;
  }
  return spans;
}

function getLineDateOfService(l) { return fmtDate(parseZohoDate(l.Date_of_Service)); }
function getLinePaymentDate(l) { return fmtDate(parseZohoDate(l.Payment_Date)); }

function getClaimPayer(c) {
  if (c.Payer && c.Payer.ID) return { value: c.Payer.ID, label: c.Payer.zc_display_value || c.Payer_Name || "-" };
  if (c.Patient?.ID && PATIENT_PAYER_MAP[c.Patient.ID]) return PATIENT_PAYER_MAP[c.Patient.ID];
  if (c.Payer_Name) return { value: c.Payer_Name, label: c.Payer_Name };
  return null;
}

function getClaimPatientName(c) {
  if (c.Patient && c.Patient.ID) {
    const info = PATIENT_INFO_MAP[c.Patient.ID];
    if (info) return stripDob(info.label);
    return c.Patient.zc_display_value || "-";
  }
  return "-";
}

function getClaimDate(c) {
  if (c.Claim_Date) return parseZohoDate(c.Claim_Date);
  const lines = getClaimLines(c);
  if (lines.length && lines[0].Date_of_Service) return parseZohoDate(lines[0].Date_of_Service);
  return parseZohoDate(c.Date_of_Service || c.Lodged_Date);
}

function claimFields(c) {
  const payer = getClaimPayer(c);
  return {
    id: c.Claim_ID || c.ID || "-",
    doctor: c.Doctor?.zc_display_value || c.Doctor_Name || "-",
    hospital: c.Hospital?.zc_display_value || c.Hospital_Name || "-",
    patient: getClaimPatientName(c),
    payer: payer ? payer.label : (c.Payer?.zc_display_value || c.Payer_Name || "-"),
    date: fmtDate(parseZohoDate(c.Claim_Date || c.Lodged_Date), true),
    turnaround: formatTurnaroundDays(calcPaymentTurnaroundDays(c))
  };
}

/* ---------------- TURNAROUND ---------------- */

function calcPaymentTurnaroundDays(c) {
  const lodgement = parseZohoDate(c.Claim_Date || c.Lodged_Date);
  let payRaw = c.Payment_Date || c.payment_date;
  if (!payRaw) {
    const lines = getClaimLines(c);
    if (lines.length && lines[0].Payment_Date) payRaw = lines[0].Payment_Date;
  }
  const pay = parseZohoDate(payRaw);
  if (!lodgement || !pay) return null;
  const diff = Math.round((pay - lodgement) / 86400000);
  return diff < 0 ? null : diff;
}

function formatTurnaroundDays(days) {
  if (days === null || days === undefined) return "-";
  return days === 1 ? "1 Day" : `${days} Days`;
}

function updateAvgTurnaroundBar(data) {
  const bar = document.getElementById("avg-turnaround-bar");
  const val = document.getElementById("avg-turnaround-value");
  if (!bar || !val) return;
  const days = data.map(calcPaymentTurnaroundDays).filter(v => v !== null && !isNaN(v));
  if (!days.length) { bar.style.display = "none"; return; }
  const avg = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
  val.textContent = avg === 1 ? "1 Day" : `${avg} Days`;
  bar.style.display = "";
}

function sortedByTurnaround(data) {
  const arr = [...data];
  if (!TURNAROUND_SORT_DIR) return arr;
  const dir = TURNAROUND_SORT_DIR === "asc" ? 1 : -1;
  arr.sort((a, b) => {
    const da = calcPaymentTurnaroundDays(a), db = calcPaymentTurnaroundDays(b);
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return (da - db) * dir;
  });
  return arr;
}

function toggleTurnaroundSort() {
  TURNAROUND_SORT_DIR = (TURNAROUND_SORT_DIR === null || TURNAROUND_SORT_DIR === "asc") ? "desc" : "asc";
  const icon = document.getElementById("sort-icon-turnaround");
  if (icon) icon.innerHTML = TURNAROUND_SORT_DIR === "desc" ? "&#8595;" : "&#8593;";
  renderTable(FILTERED_DATA);
}

/* ---------------- FILTER / RESET ---------------- */

function runReport() {
  const hospitalId = getSearchableValue("f-location");
  const patientId = getSearchableValue("f-patient");
  const payerId = getSearchableValue("f-payer");
  const fromVal = document.getElementById("f-from").value;
  const toVal = document.getElementById("f-to").value;

  let filtered = baseFilter(ALL_CLAIMS);

  if (hospitalId) filtered = filtered.filter(c => c.Hospital && String(c.Hospital.ID) === String(hospitalId));
  if (patientId) filtered = filtered.filter(c => c.Patient && String(c.Patient.ID) === String(patientId));
  if (payerId) filtered = filtered.filter(c => {
    const p = getClaimPayer(c);
    return p && String(p.value) === String(payerId);
  });
  if (fromVal) {
    const from = parseZohoDate(fromVal);
    if (from) filtered = filtered.filter(c => { const d = getClaimDate(c); return d && d >= from; });
  }
  if (toVal) {
    const to = parseZohoDate(toVal);
    if (to) {
      to.setHours(23, 59, 59, 999);
      filtered = filtered.filter(c => { const d = getClaimDate(c); return d && d <= to; });
    }
  }

  FILTERED_DATA = filtered;
  TURNAROUND_SORT_DIR = null;
  const icon = document.getElementById("sort-icon-turnaround");
  if (icon) icon.innerHTML = "&#8597;";
  renderTable(filtered);
}

function resetFilters() {
  ["f-location", "f-patient", "f-payer"].forEach(id => {
    const w = document.getElementById(id);
    if (!w) return;
    w.dataset.value = "";
    w.querySelector(".ss-value").textContent = w.dataset.allLabel || "All";
  });
  document.getElementById("f-from").value = "";
  document.getElementById("f-to").value = "";

  TURNAROUND_SORT_DIR = null;
  const icon = document.getElementById("sort-icon-turnaround");
  if (icon) icon.innerHTML = "&#8597;";

  FILTERED_DATA = baseFilter(ALL_CLAIMS);
  renderTable(FILTERED_DATA);
}

/* ---------------- TABLE RENDER ---------------- */

function renderTable(data) {
  const tbody = document.getElementById("report-body");
  tbody.classList.remove("fade-in");
  void tbody.offsetWidth;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="10">No data</td></tr>`;
    updateAvgTurnaroundBar([]);
    return;
  }

  let html = "";
  sortedByTurnaround(data).forEach((c, groupIdx) => {
    const f = claimFields(c);
    const lines = getGroupedLines(c);
    const rowCount = Math.max(lines.length, 1);
    const grp = groupIdx % 2 === 0 ? "grp-a" : "grp-b";

    const claimCells = `
      <td rowspan="${rowCount}" class="claim-cell text-center">${f.id}</td>
      <td rowspan="${rowCount}" class="claim-cell">${f.doctor}</td>
      <td rowspan="${rowCount}" class="claim-cell">${f.hospital}</td>
      <td rowspan="${rowCount}" class="claim-cell">${f.patient}</td>
      <td rowspan="${rowCount}" class="claim-cell">${f.payer}</td>
      <td rowspan="${rowCount}" class="claim-cell text-center">${f.date}</td>`;

    if (!lines.length) {
      html += `<tr class="${grp} group-first">${claimCells}
        <td class="no-lines text-center" colspan="3">No line items</td>
        <td class="item-ppdays text-center">${f.turnaround}</td></tr>`;
      return;
    }

    const spans = computeItemSpans(lines);
    lines.forEach((l, idx) => {
      const itemCell = spans[idx]
        ? `<td rowspan="${spans[idx]}" class="item-no text-center">${getLineItemNumber(l)}</td>` : "";
      const turnCell = idx === 0
        ? `<td rowspan="${rowCount}" class="item-ppdays text-center">${f.turnaround}</td>` : "";
      html += `<tr class="${grp} ${idx === 0 ? "group-first" : ""}">
        ${idx === 0 ? claimCells : ""}
        ${itemCell}
        <td class="item-dos text-center">${getLineDateOfService(l)}</td>
        <td class="item-paydate text-center">${getLinePaymentDate(l)}</td>
        ${turnCell}
      </tr>`;
    });
  });

  tbody.innerHTML = html;
  tbody.classList.add("fade-in");
  updateAvgTurnaroundBar(data);

  const sc = document.querySelector(".table-scroll");
  if (sc) sc.scrollLeft = 0;
}

/* ---------------- EXPORT INFO ---------------- */

function getFilterDisplayLabel(id, fallback) {
  const w = document.getElementById(id);
  if (!w) return fallback;
  const span = w.querySelector(".ss-value");
  const text = span ? span.textContent.trim() : "";
  return (text && text !== fallback) ? text : fallback;
}

function getActiveFilterInfo() {
  return {
    doctor: CURRENT_DOCTOR_NAME || "-",
    hospital: getFilterDisplayLabel("f-location", "All Hospitals"),
    patient: getFilterDisplayLabel("f-patient", "All Patients"),
    dateFrom: (document.getElementById("f-from") || {}).value || "",
    dateTo: (document.getElementById("f-to") || {}).value || ""
  };
}

function formatDateRange(from, to) {
  const pretty = v => { const d = parseZohoDate(v); return d ? fmtDate(d) : v; };
  if (from && to) return `${pretty(from)} - ${pretty(to)}`;
  if (from) return `From ${pretty(from)}`;
  if (to) return `Up to ${pretty(to)}`;
  return "All Dates";
}

function generatedOnText() {
  return new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Sydney", day: "2-digit", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  });
}

/* ---------------- EXPORT EXCEL ---------------- */

const XLSX_BRAND = { navy: "1E2D5A", navyText: "2D374F", green: "1F7A5C", white: "FFFFFF", lightGrey: "E5E7EB", rowAlt: "F6F7F9" };

function exportExcel() {
  if (!FILTERED_DATA.length) { alert("No data to export."); return; }
  const info = getActiveFilterInfo();
  const data = sortedByTurnaround(FILTERED_DATA);

  const aoa = [];
  aoa.push(["Claims Turnaround Time Report"]);
  aoa.push([`Doctor: ${info.doctor}`]);
  aoa.push([`Hospital: ${info.hospital}`]);
  aoa.push([`Date Range: ${formatDateRange(info.dateFrom, info.dateTo)}`]);
  aoa.push([`Generated On: ${generatedOnText()}`]);
  aoa.push([]);
  const HEADER_ROW = aoa.length;
  aoa.push(["Claim ID", "Doctor", "Hospital", "Patient", "Payer", "Claim Date",
            "Item No", "Date of Service", "Payment Date", "Payment Turnaround (Days)"]);
  const DATA_START = aoa.length;

  const spans = [];      // claim row ranges for merging
  const starts = [];     // first row of each claim
  data.forEach(c => {
    const f = claimFields(c);
    const lines = getGroupedLines(c);
    const first = aoa.length;
    starts.push(first);
    if (!lines.length) {
      aoa.push([f.id, f.doctor, f.hospital, f.patient, f.payer, f.date, "-", "-", "-", f.turnaround]);
      return;
    }
    const itemSpans = computeItemSpans(lines);
    lines.forEach((l, idx) => {
      aoa.push([
        idx === 0 ? f.id : "", idx === 0 ? f.doctor : "", idx === 0 ? f.hospital : "",
        idx === 0 ? f.patient : "", idx === 0 ? f.payer : "", idx === 0 ? f.date : "",
        itemSpans[idx] ? getLineItemNumber(l) : "",
        getLineDateOfService(l), getLinePaymentDate(l),
        idx === 0 ? f.turnaround : ""
      ]);
    });
    if (lines.length > 1) spans.push({ s: first, e: aoa.length - 1 });
  });
  const DATA_END = aoa.length - 1;

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }];
  spans.forEach(sp => {
    [0, 1, 2, 3, 4, 5, 9].forEach(col =>
      ws["!merges"].push({ s: { r: sp.s, c: col }, e: { r: sp.e, c: col } }));
  });
  ws["!cols"] = [{ wch: 14 }, { wch: 20 }, { wch: 22 }, { wch: 22 }, { wch: 16 },
                 { wch: 14 }, { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 24 }];

  const border = {
    top: { style: "thin", color: { rgb: XLSX_BRAND.lightGrey } },
    bottom: { style: "thin", color: { rgb: XLSX_BRAND.lightGrey } },
    left: { style: "thin", color: { rgb: XLSX_BRAND.lightGrey } },
    right: { style: "thin", color: { rgb: XLSX_BRAND.lightGrey } }
  };
  function setStyle(r, c, style) {
    const ref = XLSX.utils.encode_cell({ r, c });
    if (!ws[ref]) ws[ref] = { t: "s", v: "" };
    ws[ref].s = style;
  }

  setStyle(0, 0, { font: { bold: true, sz: 14, color: { rgb: XLSX_BRAND.navy } }, alignment: { horizontal: "center" } });
  for (let r = 1; r <= 4; r++) setStyle(r, 0, { font: { sz: 9, italic: true, color: { rgb: XLSX_BRAND.navyText } } });

  const headerStyle = {
    font: { bold: true, sz: 10, color: { rgb: XLSX_BRAND.white } },
    fill: { fgColor: { rgb: XLSX_BRAND.green } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border
  };
  for (let c = 0; c <= 9; c++) setStyle(HEADER_ROW, c, headerStyle);

  const centerCols = [0, 5, 6, 7, 8, 9];
  for (let r = DATA_START; r <= DATA_END; r++) {
    const isStart = starts.includes(r);
    for (let c = 0; c <= 9; c++) {
      const st = {
        font: { sz: 9, color: { rgb: XLSX_BRAND.navyText } },
        alignment: { vertical: "center", horizontal: centerCols.includes(c) ? "center" : "left" },
        border: isStart ? { ...border, top: { style: "medium", color: { rgb: XLSX_BRAND.navy } } } : border
      };
      setStyle(r, c, st);
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Claims Report");
  XLSX.writeFile(wb, "Claims Turnaround Time Report.xlsx");
}

/* ---------------- EXPORT PDF ---------------- */

const BRAND = {
  navy: [30, 45, 90], navyText: [45, 55, 80], grey: [110, 118, 130],
  lightGrey: [235, 237, 240], white: [255, 255, 255], green: [31, 122, 92]
};
const ICON_COLOR = [30, 130, 76];

function buildPdfBody() {
  const body = [];
  sortedByTurnaround(FILTERED_DATA).forEach(c => {
    const f = claimFields(c);
    const lines = getGroupedLines(c);
    const n = Math.max(lines.length, 1);
    const sp = (t, extra) => ({ content: t, rowSpan: n, styles: { valign: "top", ...(extra || {}) } });

    if (!lines.length) {
      body.push([sp(f.id), sp(f.doctor), sp(f.hospital), sp(f.patient), sp(f.payer), sp(f.date),
                 "-", "-", "-", sp(f.turnaround, { halign: "center", valign: "middle" })]);
      return;
    }
    const itemSpans = computeItemSpans(lines);
    lines.forEach((l, idx) => {
      const row = idx === 0
        ? [sp(f.id), sp(f.doctor), sp(f.hospital), sp(f.patient), sp(f.payer), sp(f.date)]
        : [];
      if (itemSpans[idx]) row.push({ content: String(getLineItemNumber(l)), rowSpan: itemSpans[idx], styles: { valign: "middle" } });
      row.push(getLineDateOfService(l), getLinePaymentDate(l));
      if (idx === 0) row.push(sp(f.turnaround, { halign: "center", valign: "middle" }));
      body.push(row);
    });
  });
  return body;
}

function exportPDF() {
  if (!FILTERED_DATA.length) { alert("No data to export."); return; }
  if (!window.jspdf) { alert("PDF library not loaded."); return; }

  const info = getActiveFilterInfo();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "l", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  const HEADER_HEIGHT = 168;
  const FOOTER_RESERVED = 110;

  const headerInfo = {
    doctor: info.doctor,
    hospital: info.hospital,
    date: formatDateRange(info.dateFrom, info.dateTo),
    generatedOn: generatedOnText()
  };

  doc.autoTable({
    startY: HEADER_HEIGHT,
    margin: { top: HEADER_HEIGHT, left: margin, right: margin, bottom: FOOTER_RESERVED },
    theme: "grid",
    head: [["Claim ID", "Doctor", "Hospital", "Patient", "Payer", "Claim Date",
            "Item No", "Date of Service", "Payment Date", "Payment Turnaround (Days)"]],
    body: buildPdfBody(),
    styles: { fontSize: 7.5, textColor: [0, 0, 0], fillColor: BRAND.white, lineColor: BRAND.lightGrey,
              lineWidth: 0.5, cellPadding: 4, overflow: "linebreak", valign: "middle" },
    headStyles: { fillColor: BRAND.navy, textColor: BRAND.white, fontStyle: "bold", fontSize: 7,
                  cellPadding: 5, valign: "middle", halign: "center" },
    tableWidth: pageW - margin * 2,
    columnStyles: {
      0: { cellWidth: 50, halign: "center" }, 1: { cellWidth: 78 }, 2: { cellWidth: 92 },
      3: { cellWidth: 85 }, 4: { cellWidth: 75 }, 5: { cellWidth: 62, halign: "center" },
      6: { cellWidth: 42, halign: "center" }, 7: { cellWidth: 68, halign: "center" },
      8: { cellWidth: 68, halign: "center" }, 9: { cellWidth: 72, halign: "center" }
    },
    didDrawPage: () => drawHeader(doc, pageW, margin, headerInfo)
  });

  // footers last, so "Page x of y" is correct
  const total = doc.internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    drawFooter(doc, pageW, margin, p, total);
  }
  doc.save("Claims Turnaround Time Report.pdf");
}

function drawHeader(doc, pageW, margin, info) {
  if (HAS_LOGO) {
    try { doc.addImage(MEDI_ELVES_LOGO_BASE64, "PNG", margin, 24, 150, 55.5); } catch (e) { console.warn("Logo skipped:", e); }
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...BRAND.navy);
  doc.text("Claims Turnaround Time Report", pageW - margin, 52, { align: "right" });

  const sepY = 96;
  doc.setFillColor(...ICON_COLOR);
  doc.circle(margin + 3, sepY, 2.2, "F");
  doc.setDrawColor(...BRAND.lightGrey);
  doc.setLineWidth(1);
  doc.line(margin + 12, sepY, pageW - margin, sepY);

  const items = [
    { icon: "person", label: "DOCTOR", value: info.doctor },
    { icon: "hospital", label: "HOSPITAL", value: info.hospital },
    { icon: "calendar", label: "REPORT PERIOD", value: info.date },
    { icon: "clock", label: "GENERATED ON", value: info.generatedOn }
  ];
  const labelY = sepY + 30, iconSize = 15, textGap = 8, colGap = 14, lineH = 11;
  const colW = (pageW - margin * 2) / items.length;

  items.forEach((item, i) => {
    const textX = margin + colW * i + iconSize + textGap;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(String(item.value), Math.max(colW - iconSize - textGap - colGap, 40)).slice(0, 2);
    const iconCY = labelY - 4 + (lines.length * lineH) / 2 - lineH / 2;
    drawIcon(doc, item.icon, textX - textGap - iconSize / 2, iconCY, ICON_COLOR);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(...BRAND.grey);
    doc.text(item.label, textX, labelY);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...BRAND.navyText);
    lines.forEach((ln, li) => doc.text(ln, textX, labelY + 14 + li * lineH));
  });
}

function drawFooter(doc, pageW, margin, current, total) {
  const pageH = doc.internal.pageSize.getHeight();
  const lineY = pageH - 100;
  doc.setDrawColor(...BRAND.lightGrey);
  doc.setLineWidth(1);
  doc.line(margin, lineY, pageW - margin, lineY);

  const textX = margin + 18, titleY = lineY + 16;
  drawIcon(doc, "lock", margin + 6, titleY - 4, ICON_COLOR);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.navyText);
  doc.text("CONFIDENTIAL - CONTAINS SENSITIVE HEALTH INFORMATION", textX, titleY);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...BRAND.grey);
  doc.text(`Page ${current} of ${total}`, pageW - margin, titleY, { align: "right" });

  doc.setFontSize(7);
  const notice =
    "This document contains confidential patient and claims information and is intended only for the named recipient and authorised " +
    "personnel. Unauthorised access, use, copying, forwarding or disclosure is prohibited. If you received this document in error, please " +
    "notify Medi Elves immediately, delete all electronic copies and securely destroy any printed copies.";
  const noticeLines = doc.splitTextToSize(notice, pageW - margin - textX);
  doc.text(noticeLines, textX, titleY + 12);

  const contactY = titleY + 12 + noticeLines.length * 9 + 14;
  const colW = (pageW - margin * 2) / 3;
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.navyText);

  drawIcon(doc, "phone", margin + 6, contactY, ICON_COLOR);
  doc.text("1800 956 692", margin + 18, contactY + 3);
  drawIcon(doc, "mail", margin + colW + 6, contactY, ICON_COLOR);
  doc.text("admin@medielves.com.au", margin + colW + 18, contactY + 3);
  drawIcon(doc, "globe", margin + colW * 2 + 6, contactY, ICON_COLOR);
  doc.text("www.medielves.com.au", margin + colW * 2 + 18, contactY + 3);
}

function drawIcon(doc, type, cx, cy, color) {
  doc.setDrawColor(...color);
  doc.setFillColor(...color);
  doc.setLineWidth(1);
  switch (type) {
    case "person": doc.circle(cx, cy - 4, 3, "S"); doc.ellipse(cx, cy + 3, 5, 4, "S"); break;
    case "hospital":
      doc.rect(cx - 5, cy - 5, 10, 10, "S");
      doc.line(cx, cy - 3, cx, cy + 3); doc.line(cx - 3, cy, cx + 3, cy); break;
    case "calendar":
      doc.roundedRect(cx - 6, cy - 5, 12, 10, 1.5, 1.5, "S");
      doc.line(cx - 6, cy - 2, cx + 6, cy - 2);
      doc.line(cx - 3, cy - 6.5, cx - 3, cy - 4); doc.line(cx + 3, cy - 6.5, cx + 3, cy - 4); break;
    case "clock": doc.circle(cx, cy, 6, "S"); doc.line(cx, cy, cx, cy - 3.5); doc.line(cx, cy, cx + 3, cy); break;
    case "lock": doc.roundedRect(cx - 5, cy - 2, 10, 8, 1.5, 1.5, "S"); doc.circle(cx, cy - 4, 3.5, "S"); break;
    case "phone": doc.roundedRect(cx - 3, cy - 6, 6, 12, 1.5, 1.5, "S"); break;
    case "mail": doc.rect(cx - 6, cy - 4, 12, 8, "S"); doc.line(cx - 6, cy - 4, cx, cy); doc.line(cx + 6, cy - 4, cx, cy); break;
    case "globe": doc.circle(cx, cy, 6, "S"); doc.ellipse(cx, cy, 3, 6, "S"); doc.line(cx - 6, cy, cx + 6, cy); break;
    default: doc.circle(cx, cy, 4, "S");
  }
}