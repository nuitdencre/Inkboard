/* ================= Firebase init ================= */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let uid = null;
let isSignupMode = false;

let clients = {};   // id -> client data
let rdvs = {};       // id -> rdv data
let charges = {};    // id -> charge data

let calMonth = new Date();
calMonth.setDate(1);
let selectedDate = fmtDate(new Date());

let comptaMonth = new Date();
comptaMonth.setDate(1);

let editingClientId = null;
let editingRdvId = null;
let returnToRdvAfterClientSave = false;
let settingsData = {};
let tattooItems = []; // [{id, description, zone, taille, style, prix}]
let tattooCounter = 0;
let exchangeRateEURtoCHF = 0.95; // fallback, refreshed at runtime

/* ================= Helpers ================= */
function $(id) { return document.getElementById(id); }
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function showError(elId, msg) { $(elId).textContent = msg || ""; }
function currencySymbol(devise) { return devise === "EUR" ? "€" : "CHF"; }
function clientLabel(c) {
  if (!c) return "Cliente inconnue";
  return `${c.prenom || ""} ${c.nom || ""}`.trim() || c.tel || "Sans nom";
}
function toCHF(amount, devise) {
  if (devise === "EUR") return amount * exchangeRateEURtoCHF;
  return amount;
}
function paymentLabel(mode) {
  const map = { especes: "Espèces", paypal: "PayPal", twint: "Twint", virement: "Virement bancaire" };
  return map[mode] || "";
}

/* Détection du pays d'un numéro de téléphone */
const PHONE_PREFIXES = [
  { code: "+41", label: "🇨🇭 Suisse" },
  { code: "+33", label: "🇫🇷 France" },
  { code: "+32", label: "🇧🇪 Belgique" },
  { code: "+49", label: "🇩🇪 Allemagne" },
  { code: "+39", label: "🇮🇹 Italie" },
  { code: "+34", label: "🇪🇸 Espagne" },
  { code: "+44", label: "🇬🇧 Royaume-Uni" },
  { code: "+1", label: "🇺🇸/🇨🇦 Amérique du Nord" },
  { code: "+351", label: "🇵🇹 Portugal" },
];
function detectPhoneCountry(tel) {
  const clean = tel.replace(/[\s.\-()]/g, "");
  if (clean.startsWith("0") && !clean.startsWith("00")) return "🇨🇭 Suisse (numéro local)";
  const normalized = clean.startsWith("00") ? "+" + clean.slice(2) : clean;
  const match = PHONE_PREFIXES.find((p) => normalized.startsWith(p.code));
  return match ? match.label : "";
}

function showScreen(name) {
  document.querySelectorAll("main.screen").forEach((el) => el.classList.add("hidden"));
  const map = {
    agenda: "screen-agenda",
    clients: "screen-clients",
    "client-form": "screen-client-form",
    "new-rdv": "screen-rdv-form",
    settings: "screen-settings",
    compta: "screen-compta",
  };
  $(map[name]).classList.remove("hidden");
  document.querySelectorAll(".bottom-nav button").forEach((b) => b.classList.remove("active"));
  const navBtn = document.querySelector(`.bottom-nav button[data-screen="${name === "client-form" ? "clients" : name}"]`);
  if (navBtn) navBtn.classList.add("active");
  const titles = {
    agenda: "Agenda",
    clients: "Clientes",
    "client-form": editingClientId ? "Fiche cliente" : "Nouvelle cliente",
    "new-rdv": editingRdvId ? "Fiche RDV" : "Nouveau RDV",
    settings: "Réglages",
    compta: "Comptabilité",
  };
  $("top-bar-title").textContent = titles[name] || "";
  if (name === "compta") renderCompta();
}

/* ================= Auth ================= */
$("btn-toggle-pass").addEventListener("click", () => {
  const input = $("login-pass");
  const isPass = input.type === "password";
  input.type = isPass ? "text" : "password";
  $("btn-toggle-pass").textContent = isPass ? "🙈" : "👁";
});

$("btn-toggle-signup").addEventListener("click", () => {
  isSignupMode = !isSignupMode;
  $("btn-login").textContent = isSignupMode ? "Créer mon compte" : "Se connecter";
  $("btn-toggle-signup").textContent = isSignupMode
    ? "J'ai déjà un compte"
    : "Première visite ? Créer mon compte";
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const pass = $("login-pass").value;
  showError("login-error", "");
  if (!email || !pass) { showError("login-error", "Remplis l'email et le mot de passe."); return; }
  try {
    if (isSignupMode) {
      await auth.createUserWithEmailAndPassword(email, pass);
    } else {
      await auth.signInWithEmailAndPassword(email, pass);
    }
  } catch (e2) {
    showError("login-error", translateAuthError(e2));
  }
});

function translateAuthError(e) {
  const map = {
    "auth/invalid-email": "Adresse email invalide.",
    "auth/user-not-found": "Aucun compte avec cet email.",
    "auth/wrong-password": "Mot de passe incorrect.",
    "auth/email-already-in-use": "Un compte existe déjà avec cet email.",
    "auth/weak-password": "Le mot de passe doit faire au moins 6 caractères.",
    "auth/invalid-credential": "Email ou mot de passe incorrect.",
  };
  return map[e.code] || "Une erreur est survenue. Réessaie.";
}

$("btn-logout").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged((user) => {
  if (user) {
    uid = user.uid;
    $("login-screen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("settings-email").textContent = user.email;
    attachListeners();
    fetchExchangeRate();
    showScreen("agenda");
  } else {
    uid = null;
    $("app").classList.add("hidden");
    $("login-screen").classList.remove("hidden");
  }
});

/* ================= Exchange rate EUR -> CHF ================= */
async function fetchExchangeRate() {
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=EUR&to=CHF");
    const data = await res.json();
    if (data && data.rates && data.rates.CHF) {
      exchangeRateEURtoCHF = data.rates.CHF;
    }
  } catch (e) {
    // silencieux, on garde le taux par défaut
  }
}

/* ================= Data listeners ================= */
function attachListeners() {
  db.collection("users").doc(uid).collection("clients")
    .onSnapshot((snap) => {
      clients = {};
      snap.forEach((doc) => (clients[doc.id] = doc.data()));
      renderClients();
      renderClientSelect();
    });

  db.collection("users").doc(uid).collection("rdvs")
    .onSnapshot((snap) => {
      rdvs = {};
      snap.forEach((doc) => (rdvs[doc.id] = doc.data()));
      renderCalendar();
      renderDayList();
      if (!$("screen-compta").classList.contains("hidden")) renderCompta();
    });

  db.collection("users").doc(uid).collection("charges")
    .onSnapshot((snap) => {
      charges = {};
      snap.forEach((doc) => (charges[doc.id] = doc.data()));
      if (!$("screen-compta").classList.contains("hidden")) renderCompta();
    });

  db.collection("users").doc(uid).collection("settings").doc("main")
    .onSnapshot((doc) => {
      settingsData = doc.data() || {};
      $("settings-consent-link").value = settingsData.consentLink || "";
      $("settings-care-pdf").value = settingsData.carePdfUrl || "";
      $("settings-artist-name").value = settingsData.artistName || "";
      $("settings-accent-color").value = settingsData.accentColor || "#c5493a";
      $("settings-commission-pct").value = settingsData.commissionPct != null ? settingsData.commissionPct : 20;
      $("settings-site-url").value = settingsData.siteUrl || "";
      applyPersonalisation();
    });
}

function applyPersonalisation() {
  $("artist-name-display").textContent = settingsData.artistName || "";
  const color = settingsData.accentColor || "#c5493a";
  document.documentElement.style.setProperty("--accent", color);
}

/* ================= Bottom nav ================= */
document.querySelectorAll(".bottom-nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.screen;
    if (target === "new-rdv") openRdvForm(null);
    else if (target === "clients") showScreen("clients");
    else if (target === "compta") showScreen("compta");
    else showScreen("agenda");
  });
});

$("btn-settings").addEventListener("click", () => showScreen("settings"));

/* ================= Calendar ================= */
const DOW = ["L", "M", "M", "J", "V", "S", "D"];
$("cal-dow").innerHTML = DOW.map((d) => `<div class="cal-dow">${d}</div>`).join("");

$("cal-prev").addEventListener("click", () => {
  calMonth.setMonth(calMonth.getMonth() - 1);
  renderCalendar();
});
$("cal-next").addEventListener("click", () => {
  calMonth.setMonth(calMonth.getMonth() + 1);
  renderCalendar();
});

function rdvsForDate(dateStr) {
  return Object.entries(rdvs)
    .filter(([, r]) => r.date === dateStr)
    .sort((a, b) => (a[1].heure || "").localeCompare(b[1].heure || ""));
}

function rdvTotal(r) {
  if (Array.isArray(r.tattoos) && r.tattoos.length) {
    return r.tattoos.reduce((sum, t) => sum + (Number(t.prix) || 0), 0);
  }
  return Number(r.prix) || 0;
}

function renderCalendar() {
  const label = calMonth.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  $("cal-label").textContent = label.charAt(0).toUpperCase() + label.slice(1);

  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = fmtDate(new Date());

  let cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const grid = $("cal-grid");
  grid.innerHTML = "";
  cells.forEach((d) => {
    const cell = document.createElement("div");
    if (d === null) {
      cell.className = "cal-day muted";
      grid.appendChild(cell);
      return;
    }
    const dateStr = fmtDate(new Date(year, month, d));
    cell.className = "cal-day";
    if (dateStr === todayStr) cell.classList.add("today");
    if (dateStr === selectedDate) cell.classList.add("selected");
    const hasRdv = rdvsForDate(dateStr).length > 0;
    cell.innerHTML = `<span>${d}</span>${hasRdv ? '<span class="dot"></span>' : ""}`;
    cell.addEventListener("click", () => {
      selectedDate = dateStr;
      renderCalendar();
      renderDayList();
    });
    grid.appendChild(cell);
  });
}

function tattooSummary(r) {
  if (Array.isArray(r.tattoos) && r.tattoos.length) {
    if (r.tattoos.length === 1) return `${r.tattoos[0].description || "Tatouage"}`;
    return `${r.tattoos.length} tatouages`;
  }
  return r.description || "Tatouage";
}

function renderDayList() {
  const list = $("day-list");
  const dateObj = new Date(selectedDate + "T00:00:00");
  const label = dateObj.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  $("day-list-title").textContent = label.charAt(0).toUpperCase() + label.slice(1);

  const entries = rdvsForDate(selectedDate);
  if (entries.length === 0) {
    list.innerHTML = `<div class="empty-state">Aucun RDV ce jour-là.</div>`;
    return;
  }
  list.innerHTML = "";
  entries.forEach(([id, r]) => {
    const client = clients[r.clientId];
    const div = document.createElement("div");
    div.className = "card tappable";
    div.innerHTML = `
      <div class="card-title">${r.heure || "—"} · ${clientLabel(client)}</div>
      <div class="card-sub">${tattooSummary(r)}</div>
      <span class="card-tag ${r.consentSigned ? "ok" : "warn"}">${r.consentSigned ? "Consentement ✓" : "Consentement en attente"}</span>
      <span class="card-tag ${r.soinEnvoye ? "ok" : ""}">${r.soinEnvoye ? "Soin envoyé ✓" : "Soin à envoyer"}</span>
      <span class="card-tag ${r.soldePaye ? "ok" : "warn"}">${r.soldePaye ? "Payé ✓" : "Reste dû"}</span>
    `;
    div.addEventListener("click", () => openRdvForm(id));
    list.appendChild(div);
  });
}

/* ================= Clients screen ================= */
$("client-search").addEventListener("input", renderClients);

function renderClients() {
  const q = $("client-search").value.trim().toLowerCase();
  const list = $("clients-list");
  const entries = Object.entries(clients)
    .filter(([, c]) => clientLabel(c).toLowerCase().includes(q))
    .sort((a, b) => clientLabel(a[1]).localeCompare(clientLabel(b[1])));

  if (entries.length === 0) {
    list.innerHTML = `<div class="empty-state">Aucune cliente pour l'instant.<br>Touche + pour en ajouter une.</div>`;
    return;
  }
  list.innerHTML = "";
  entries.forEach(([id, c]) => {
    const div = document.createElement("div");
    div.className = "card tappable";
    const country = c.tel ? detectPhoneCountry(c.tel) : "";
    div.innerHTML = `
      <div class="card-title">${clientLabel(c)}</div>
      <div class="card-sub">${c.tel || ""}${c.email ? " · " + c.email : ""}</div>
      ${country ? `<div class="country-tag">${country}</div>` : ""}
    `;
    div.addEventListener("click", () => openClientForm(id));
    list.appendChild(div);
  });
}

const clientsFab = document.createElement("button");
clientsFab.className = "fab";
clientsFab.textContent = "+";
clientsFab.addEventListener("click", () => openClientForm(null));
$("screen-clients").appendChild(clientsFab);

function openClientForm(id) {
  editingClientId = id;
  const c = id ? clients[id] : {};
  $("cf-prenom").value = c.prenom || "";
  $("cf-nom").value = c.nom || "";
  $("cf-tel").value = c.tel || "";
  $("cf-email").value = c.email || "";
  $("cf-adresse").value = c.adresse || "";
  $("cf-naissance").value = c.naissance || "";
  $("cf-notes").value = c.notes || "";
  $("cf-tel-country").textContent = c.tel ? detectPhoneCountry(c.tel) : "";
  showError("client-form-error", "");
  $("btn-delete-client").classList.toggle("hidden", !id);
  showScreen("client-form");
}

$("cf-tel").addEventListener("input", (e) => {
  $("cf-tel-country").textContent = detectPhoneCountry(e.target.value);
});

$("btn-save-client").addEventListener("click", async () => {
  const prenom = $("cf-prenom").value.trim();
  const nom = $("cf-nom").value.trim();
  const tel = $("cf-tel").value.trim();
  if (!prenom && !nom) { showError("client-form-error", "Indique au moins un nom ou prénom."); return; }
  if (!tel) { showError("client-form-error", "Le téléphone est requis."); return; }

  const data = {
    prenom, nom, tel,
    email: $("cf-email").value.trim(),
    adresse: $("cf-adresse").value.trim(),
    naissance: $("cf-naissance").value,
    notes: $("cf-notes").value.trim(),
  };

  const ref = editingClientId
    ? db.collection("users").doc(uid).collection("clients").doc(editingClientId)
    : db.collection("users").doc(uid).collection("clients").doc();

  await ref.set(data, { merge: true });

  if (returnToRdvAfterClientSave) {
    returnToRdvAfterClientSave = false;
    setTimeout(() => {
      $("rf-client").value = ref.id;
      showScreen("new-rdv");
    }, 150);
  } else {
    showScreen("clients");
  }
});

$("btn-delete-client").addEventListener("click", async () => {
  if (!editingClientId) return;
  if (!confirm("Supprimer définitivement cette cliente ? (les RDV liés resteront mais sans fiche cliente)")) return;
  await db.collection("users").doc(uid).collection("clients").doc(editingClientId).delete();
  showScreen("clients");
});

/* ================= RDV form : heure ================= */
function populateHeureSelects() {
  const h = $("rf-heure-h");
  const m = $("rf-heure-m");
  h.innerHTML = "";
  m.innerHTML = "";
  for (let i = 0; i < 24; i++) {
    const opt = document.createElement("option");
    opt.value = String(i).padStart(2, "0");
    opt.textContent = String(i).padStart(2, "0") + "h";
    h.appendChild(opt);
  }
  for (let i = 0; i < 60; i += 5) {
    const opt = document.createElement("option");
    opt.value = String(i).padStart(2, "0");
    opt.textContent = String(i).padStart(2, "0");
    m.appendChild(opt);
  }
}
populateHeureSelects();

/* ================= RDV form : tatouages multiples ================= */
function addTattooItem(data) {
  tattooCounter++;
  const item = {
    uid: "t" + tattooCounter,
    description: (data && data.description) || "",
    zone: (data && data.zone) || "",
    taille: (data && data.taille) || "",
    style: (data && data.style) || "",
    prix: (data && data.prix) || 0,
  };
  tattooItems.push(item);
  renderTattooItems();
}

function renderTattooItems() {
  const container = $("rf-tattoos");
  container.innerHTML = "";
  tattooItems.forEach((item, idx) => {
    const div = document.createElement("div");
    div.className = "tattoo-item";
    div.innerHTML = `
      ${tattooItems.length > 1 ? `<button type="button" class="remove-tattoo" data-idx="${idx}">✕</button>` : ""}
      <label>Description ${tattooItems.length > 1 ? "#" + (idx + 1) : ""}</label>
      <textarea data-field="description" data-idx="${idx}" placeholder="Ex: petite fleur, fine line">${item.description}</textarea>
      <div class="row-2">
        <div>
          <label>Zone</label>
          <input type="text" data-field="zone" data-idx="${idx}" value="${item.zone}" placeholder="Avant-bras…" />
        </div>
        <div>
          <label>Taille</label>
          <input type="text" data-field="taille" data-idx="${idx}" value="${item.taille}" placeholder="10 cm…" />
        </div>
      </div>
      <label>Style</label>
      <input type="text" data-field="style" data-idx="${idx}" value="${item.style}" placeholder="Fine line, traditionnel…" />
      <label>Prix de ce tatouage</label>
      <input type="number" min="0" step="5" data-field="prix" data-idx="${idx}" value="${item.prix}" />
    `;
    container.appendChild(div);
  });

  container.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      tattooItems[idx][field] = field === "prix" ? Number(e.target.value) || 0 : e.target.value;
      updatePriceSummary();
    });
  });
  container.querySelectorAll(".remove-tattoo").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.target.dataset.idx);
      tattooItems.splice(idx, 1);
      renderTattooItems();
      updatePriceSummary();
    });
  });

  updatePriceSummary();
}

$("rf-add-tattoo").addEventListener("click", () => addTattooItem());

function updatePriceSummary() {
  const total = tattooItems.reduce((sum, t) => sum + (Number(t.prix) || 0), 0);
  const devise = $("rf-devise").value;
  const acompte = Number($("rf-acompte").value) || 0;
  const reste = Math.max(0, total - acompte);
  $("rf-total-display").textContent = total.toFixed(2).replace(/\.00$/, "");
  $("rf-total-cur").textContent = currencySymbol(devise);
  $("rf-reste-display").textContent = reste.toFixed(2).replace(/\.00$/, "");
  $("rf-reste-cur").textContent = currencySymbol(devise);
}
$("rf-devise").addEventListener("change", updatePriceSummary);
$("rf-acompte").addEventListener("input", updatePriceSummary);

/* ================= RDV form ================= */
function renderClientSelect() {
  const sel = $("rf-client");
  const current = sel.value;
  const entries = Object.entries(clients).sort((a, b) => clientLabel(a[1]).localeCompare(clientLabel(b[1])));
  sel.innerHTML = entries.map(([id, c]) => `<option value="${id}">${clientLabel(c)}</option>`).join("");
  if (current) sel.value = current;
}

$("rf-new-client").addEventListener("click", () => {
  returnToRdvAfterClientSave = true;
  openClientForm(null);
});

function openRdvForm(id) {
  editingRdvId = id;
  const r = id ? rdvs[id] : {};
  renderClientSelect();
  $("rf-client").value = r.clientId || "";
  $("rf-date").value = r.date || selectedDate;
  $("rf-heure-h").value = (r.heure || "10:00").split(":")[0] || "10";
  $("rf-heure-m").value = (r.heure || "10:00").split(":")[1] || "00";
  $("rf-duree").value = r.duree || "60";

  tattooItems = [];
  tattooCounter = 0;
  if (Array.isArray(r.tattoos) && r.tattoos.length) {
    r.tattoos.forEach((t) => addTattooItem(t));
  } else if (r.description || r.prix) {
    addTattooItem({ description: r.description, zone: r.zone, taille: r.taille, style: r.style, prix: r.prix });
  } else {
    addTattooItem();
  }

  $("rf-devise").value = r.devise || "CHF";
  $("rf-acompte").value = r.acompte || "";
  $("rf-acompte-mode").value = r.acompteMode || "";
  $("rf-solde-mode").value = r.soldeMode || "";
  $("rf-solde-paye").checked = !!r.soldePaye;
  $("rf-commission-payee").checked = !!r.commissionPayee;
  $("rf-consent").checked = !!r.consentSigned;
  $("rf-lot-aiguille").value = r.lotAiguille || "";
  $("rf-lot-encre").value = r.lotEncre || "";
  $("rf-soin").checked = !!r.soinEnvoye;

  updatePriceSummary();
  showError("rdv-form-error", "");
  $("btn-delete-rdv").classList.toggle("hidden", !id);
  renderPendingConsents(id);
  showScreen("new-rdv");
}

$("btn-save-rdv").addEventListener("click", async () => {
  const clientId = $("rf-client").value;
  const date = $("rf-date").value;
  if (!clientId) { showError("rdv-form-error", "Choisis une cliente."); return; }
  if (!date) { showError("rdv-form-error", "Choisis une date."); return; }

  const btn = $("btn-save-rdv");
  btn.disabled = true;
  btn.textContent = "Enregistrement…";

  try {
    const ref = editingRdvId
      ? db.collection("users").doc(uid).collection("rdvs").doc(editingRdvId)
      : db.collection("users").doc(uid).collection("rdvs").doc();

    const total = tattooItems.reduce((sum, t) => sum + (Number(t.prix) || 0), 0);

    const data = {
      clientId,
      date,
      heure: `${$("rf-heure-h").value}:${$("rf-heure-m").value}`,
      duree: Number($("rf-duree").value) || 60,
      tattoos: tattooItems.map((t) => ({
        description: t.description.trim(),
        zone: t.zone.trim(),
        taille: t.taille.trim(),
        style: t.style.trim(),
        prix: Number(t.prix) || 0,
      })),
      prix: total,
      devise: $("rf-devise").value,
      acompte: Number($("rf-acompte").value) || 0,
      acompteMode: $("rf-acompte-mode").value,
      soldeMode: $("rf-solde-mode").value,
      soldePaye: $("rf-solde-paye").checked,
      commissionPayee: $("rf-commission-payee").checked,
      commissionPct: settingsData.commissionPct != null ? settingsData.commissionPct : 20,
      consentSigned: $("rf-consent").checked,
      lotAiguille: $("rf-lot-aiguille").value.trim(),
      lotEncre: $("rf-lot-encre").value.trim(),
      soinEnvoye: $("rf-soin").checked,
    };

    await ref.set(data, { merge: true });
    selectedDate = date;
    showScreen("agenda");
  } catch (e) {
    showError("rdv-form-error", "Erreur lors de l'enregistrement : " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Enregistrer le RDV";
  }
});

$("btn-delete-rdv").addEventListener("click", async () => {
  if (!editingRdvId) return;
  if (!confirm("Supprimer définitivement ce RDV ?")) return;
  await db.collection("users").doc(uid).collection("rdvs").doc(editingRdvId).delete();
  showScreen("agenda");
});

async function copyToClipboard(text, label) {
  if (!text) { alert(`Aucun lien enregistré pour l'instant. Ajoute-le dans Réglages.`); return; }
  try {
    await navigator.clipboard.writeText(text);
    alert(`${label} copié ! Tu peux le coller sur Insta ou WhatsApp.`);
  } catch {
    prompt(`Copie ce lien manuellement :`, text);
  }
}

$("rf-copy-consent").addEventListener("click", () => {
  if (!editingRdvId) {
    alert("Enregistre d'abord le RDV une première fois, puis reviens dessus pour générer son lien de consentement.");
    return;
  }
  const siteUrl = (settingsData.siteUrl || "").trim();
  if (!siteUrl) {
    alert("Ajoute d'abord l'adresse de ton appli dans Réglages (section « Adresse de ton appli »).");
    return;
  }
  const base = siteUrl.endsWith("/") ? siteUrl : siteUrl + "/";
  const clientId = $("rf-client").value;
  const link = `${base}consentement.html?uid=${uid}&rdv=${editingRdvId}&client=${clientId}`;
  copyToClipboard(link, "Lien de consentement");
});

$("rf-copy-soin").addEventListener("click", () => copyToClipboard(settingsData.carePdfUrl, "Lien de la feuille de soin"));

/* ================= Consentements reçus (à importer) ================= */
async function renderPendingConsents(rdvId) {
  const container = $("rf-pending-consents");
  container.innerHTML = "";
  if (!rdvId) return;
  try {
    const snap = await db.collection("users").doc(uid).collection("pendingConsents")
      .where("rdvId", "==", rdvId).get();
    if (snap.empty) return;
    snap.forEach((doc) => {
      const data = doc.data();
      const flagged = data.contraindications
        ? Object.entries(data.contraindications).filter(([, v]) => v === true).map(([k]) => k)
        : [];
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML = `
        <div class="card-title">Consentement reçu de ${data.prenom || ""} ${data.nom || ""}</div>
        <div class="card-sub">${data.email || ""} ${data.tel ? "· " + data.tel : ""}</div>
        ${flagged.length ? `<div class="card-tag warn" style="display:block; margin-top:6px;">⚠ Signalé : ${flagged.join(", ")}</div>` : `<div class="card-tag ok" style="display:block; margin-top:6px;">Aucune contre-indication signalée</div>`}
        <button class="btn small" style="margin-top:8px; width:100%;">Importer dans la fiche cliente</button>
      `;
      div.querySelector("button").addEventListener("click", () => importPendingConsent(doc.id, data, rdvId));
      container.appendChild(div);
    });
  } catch (e) {
    // silencieux
  }
}

async function importPendingConsent(pendingId, data, rdvId) {
  const clientId = $("rf-client").value;
  if (!clientId) { alert("Choisis d'abord une cliente sur ce RDV avant d'importer."); return; }

  const updates = {};
  if (data.prenom) updates.prenom = data.prenom;
  if (data.nom) updates.nom = data.nom;
  if (data.email) updates.email = data.email;
  if (data.tel) updates.tel = data.tel;
  if (data.adresse) updates.adresse = data.adresse;
  if (data.naissance) updates.naissance = data.naissance;

  const flagged = data.contraindications
    ? Object.entries(data.contraindications).filter(([, v]) => v === true).map(([k]) => k)
    : [];
  if (flagged.length) {
    const existingClient = clients[clientId] || {};
    const note = `⚠ Contre-indications signalées (${new Date().toLocaleDateString("fr-FR")}) : ${flagged.join(", ")}`;
    updates.notes = existingClient.notes ? `${existingClient.notes}\n${note}` : note;
  }

  await db.collection("users").doc(uid).collection("clients").doc(clientId).set(updates, { merge: true });
  await db.collection("users").doc(uid).collection("rdvs").doc(rdvId).set({ consentSigned: true }, { merge: true });
  await db.collection("users").doc(uid).collection("pendingConsents").doc(pendingId).delete();

  $("rf-consent").checked = true;
  renderPendingConsents(rdvId);
  alert(flagged.length
    ? "Importé — attention, des contre-indications ont été notées dans la fiche cliente !"
    : "Fiche cliente mise à jour et consentement validé !");
}

/* ================= Comptabilité ================= */
$("compta-prev").addEventListener("click", () => {
  comptaMonth.setMonth(comptaMonth.getMonth() - 1);
  renderCompta();
});
$("compta-next").addEventListener("click", () => {
  comptaMonth.setMonth(comptaMonth.getMonth() + 1);
  renderCompta();
});

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function renderCompta() {
  const label = comptaMonth.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  $("compta-label").textContent = label.charAt(0).toUpperCase() + label.slice(1);
  const key = monthKey(comptaMonth);

  const monthRdvs = Object.entries(rdvs).filter(([, r]) => r.date && r.date.startsWith(key));
  const monthCharges = Object.entries(charges).filter(([, c]) => c.date && c.date.startsWith(key));

  let recettesCHF = 0;
  let commissionDueCHF = 0;
  let commissionPaidCHF = 0;

  monthRdvs.forEach(([, r]) => {
    const totalCHF = toCHF(rdvTotal(r), r.devise);
    recettesCHF += totalCHF;
    const pct = r.commissionPct != null ? r.commissionPct : 20;
    const commission = (totalCHF * pct) / 100;
    commissionDueCHF += commission;
    if (r.commissionPayee) commissionPaidCHF += commission;
  });

  const chargesCHF = monthCharges.reduce((sum, [, c]) => sum + (Number(c.montant) || 0), 0);
  const net = recettesCHF - commissionDueCHF - chargesCHF;

  $("compta-recettes").textContent = recettesCHF.toFixed(2);
  $("compta-commission").textContent = commissionDueCHF.toFixed(2);
  $("compta-commission-status").textContent = commissionDueCHF > 0
    ? `dont ${commissionPaidCHF.toFixed(2)} CHF déjà versés`
    : "";
  $("compta-charges").textContent = chargesCHF.toFixed(2);
  $("compta-net").textContent = net.toFixed(2);

  // Liste des RDV du mois
  const rdvListEl = $("compta-rdv-list");
  if (monthRdvs.length === 0) {
    rdvListEl.innerHTML = `<div class="empty-state">Aucun RDV ce mois-ci.</div>`;
  } else {
    rdvListEl.innerHTML = "";
    monthRdvs
      .sort((a, b) => a[1].date.localeCompare(b[1].date))
      .forEach(([id, r]) => {
        const client = clients[r.clientId];
        const div = document.createElement("div");
        div.className = "card tappable";
        div.innerHTML = `
          <div class="card-title">${r.date} · ${clientLabel(client)}</div>
          <div class="card-sub">${rdvTotal(r)} ${currencySymbol(r.devise)} ${r.soldePaye ? "· payé" : "· en attente"}</div>
        `;
        div.addEventListener("click", () => openRdvForm(id));
        rdvListEl.appendChild(div);
      });
  }

  // Liste des charges
  const chargesListEl = $("charges-list");
  if (monthCharges.length === 0) {
    chargesListEl.innerHTML = `<div class="empty-state">Aucune charge ce mois-ci.</div>`;
  } else {
    chargesListEl.innerHTML = "";
    monthCharges
      .sort((a, b) => (a[1].date || "").localeCompare(b[1].date || ""))
      .forEach(([id, c]) => {
        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = `
          <div class="card-title">${c.description || "Charge"} — ${c.montant} CHF</div>
          <div class="card-sub">${c.date || ""}</div>
          <button class="link-btn" style="margin-top:6px; text-align:left;" data-id="${id}">Supprimer</button>
        `;
        div.querySelector("button").addEventListener("click", async () => {
          if (confirm("Supprimer cette charge ?")) {
            await db.collection("users").doc(uid).collection("charges").doc(id).delete();
          }
        });
        chargesListEl.appendChild(div);
      });
  }
}

$("btn-add-charge").addEventListener("click", async () => {
  const desc = $("charge-desc").value.trim();
  const montant = Number($("charge-montant").value) || 0;
  const date = $("charge-date").value || fmtDate(new Date());
  if (!desc || !montant) { alert("Indique une description et un montant."); return; }
  await db.collection("users").doc(uid).collection("charges").add({ description: desc, montant, date });
  $("charge-desc").value = "";
  $("charge-montant").value = "";
});

/* ================= Settings ================= */
$("btn-save-consent-link").addEventListener("click", async () => {
  const link = $("settings-consent-link").value.trim();
  await db.collection("users").doc(uid).collection("settings").doc("main")
    .set({ consentLink: link }, { merge: true });
  alert("Lien enregistré !");
});

$("btn-save-site-url").addEventListener("click", async () => {
  const url = $("settings-site-url").value.trim();
  await db.collection("users").doc(uid).collection("settings").doc("main")
    .set({ siteUrl: url }, { merge: true });
  alert("Adresse enregistrée !");
});

$("btn-save-care-pdf").addEventListener("click", async () => {
  const link = $("settings-care-pdf").value.trim();
  await db.collection("users").doc(uid).collection("settings").doc("main")
    .set({ carePdfUrl: link }, { merge: true });
  alert("Lien enregistré !");
});

$("btn-save-perso").addEventListener("click", async () => {
  const artistName = $("settings-artist-name").value.trim();
  const accentColor = $("settings-accent-color").value;
  const commissionPct = Number($("settings-commission-pct").value) || 0;
  await db.collection("users").doc(uid).collection("settings").doc("main")
    .set({ artistName, accentColor, commissionPct }, { merge: true });
  alert("Personnalisation enregistrée !");
});

/* ================= PWA install ================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
