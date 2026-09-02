/* ================= Firebase init ================= */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let uid = null;
let isSignupMode = false;

let clients = {};   // id -> client data
let rdvs = {};      // id -> rdv data

let calMonth = new Date();
calMonth.setDate(1);
let selectedDate = fmtDate(new Date());

let editingClientId = null;
let editingRdvId = null;
let returnToRdvAfterClientSave = false;
let settingsData = {};

/* ================= Helpers ================= */
function $(id) { return document.getElementById(id); }
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
function showError(elId, msg) { $(elId).textContent = msg || ""; }
function currencySymbol(devise) { return devise === "EUR" ? "€" : "CHF"; }
function clientLabel(c) {
  if (!c) return "Cliente inconnue";
  return `${c.prenom || ""} ${c.nom || ""}`.trim() || c.tel || "Sans nom";
}

function showScreen(name) {
  document.querySelectorAll("main.screen").forEach((el) => el.classList.add("hidden"));
  const map = {
    agenda: "screen-agenda",
    clients: "screen-clients",
    "client-form": "screen-client-form",
    "new-rdv": "screen-rdv-form",
    settings: "screen-settings",
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
  };
  $("top-bar-title").textContent = titles[name] || "";
}

/* ================= Auth ================= */
$("btn-toggle-signup").addEventListener("click", () => {
  isSignupMode = !isSignupMode;
  $("btn-login").textContent = isSignupMode ? "Créer mon compte" : "Se connecter";
  $("btn-toggle-signup").textContent = isSignupMode
    ? "J'ai déjà un compte"
    : "Première visite ? Créer mon compte";
});

$("btn-login").addEventListener("click", async () => {
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
  } catch (e) {
    showError("login-error", translateAuthError(e));
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
    showScreen("agenda");
  } else {
    uid = null;
    $("app").classList.add("hidden");
    $("login-screen").classList.remove("hidden");
  }
});

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
    });

  db.collection("users").doc(uid).collection("settings").doc("main")
    .onSnapshot((doc) => {
      settingsData = doc.data() || {};
      $("settings-consent-link").value = settingsData.consentLink || "";
      $("settings-care-pdf").value = settingsData.carePdfUrl || "";
    });
}

/* ================= Bottom nav ================= */
document.querySelectorAll(".bottom-nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.screen;
    if (target === "new-rdv") openRdvForm(null);
    else if (target === "clients") showScreen("clients");
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
      <div class="card-sub">${r.description || "Tatouage"} ${r.zone ? "· " + r.zone : ""}</div>
      <span class="card-tag ${r.consentSigned ? "ok" : "warn"}">${r.consentSigned ? "Consentement ✓" : "Consentement en attente"}</span>
      <span class="card-tag ${r.soinEnvoye ? "ok" : ""}">${r.soinEnvoye ? "Soin envoyé ✓" : "Soin à envoyer"}</span>
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
    div.innerHTML = `
      <div class="card-title">${clientLabel(c)}</div>
      <div class="card-sub">${c.tel || ""}${c.email ? " · " + c.email : ""}</div>
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
  showError("client-form-error", "");
  $("btn-delete-client").classList.toggle("hidden", !id);
  showScreen("client-form");
}

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
  $("rf-heure").value = r.heure || "";
  $("rf-description").value = r.description || "";
  $("rf-zone").value = r.zone || "";
  $("rf-taille").value = r.taille || "";
  $("rf-style").value = r.style || "";
  $("rf-prix").value = r.prix || "";
  $("rf-devise").value = r.devise || "CHF";
  $("rf-acompte").value = r.acompte || "";
  $("rf-consent").checked = !!r.consentSigned;
  $("rf-lot-aiguille").value = r.lotAiguille || "";
  $("rf-lot-encre").value = r.lotEncre || "";
  $("rf-soin").checked = !!r.soinEnvoye;

  showError("rdv-form-error", "");
  $("btn-delete-rdv").classList.toggle("hidden", !id);
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

    const data = {
      clientId,
      date,
      heure: $("rf-heure").value,
      description: $("rf-description").value.trim(),
      zone: $("rf-zone").value.trim(),
      taille: $("rf-taille").value.trim(),
      style: $("rf-style").value.trim(),
      prix: Number($("rf-prix").value) || 0,
      devise: $("rf-devise").value,
      acompte: Number($("rf-acompte").value) || 0,
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

$("rf-copy-consent").addEventListener("click", () => copyToClipboard(settingsData.consentLink, "Lien de consentement"));
$("rf-copy-soin").addEventListener("click", () => copyToClipboard(settingsData.carePdfUrl, "Lien de la feuille de soin"));

/* ================= Settings ================= */
$("btn-save-consent-link").addEventListener("click", async () => {
  const link = $("settings-consent-link").value.trim();
  await db.collection("users").doc(uid).collection("settings").doc("main")
    .set({ consentLink: link }, { merge: true });
  alert("Lien enregistré !");
});

$("btn-save-care-pdf").addEventListener("click", async () => {
  const link = $("settings-care-pdf").value.trim();
  await db.collection("users").doc(uid).collection("settings").doc("main")
    .set({ carePdfUrl: link }, { merge: true });
  alert("Lien enregistré !");
});

/* ================= PWA install ================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
