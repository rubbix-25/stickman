// ---------- Paramètres du lien ----------
// Exemple : index.html?salle=soiree42&titre=La%20Grande%20Bataille
const params = new URLSearchParams(location.search);
const SALLE = (params.get("salle") || "principale").slice(0, 40);
const TITRE = (params.get("titre") || "Stickman").slice(0, 60);

// ---------- Réglages du jeu ----------
// Tout est en "unités monde". L'écran montre toujours une zone de VUE_L x VUE_H
// unités, pour que tout le monde voie la même chose quelle que soit sa fenêtre.
const VUE_L = 1000;
const VUE_H = 600;
const SOL_MARGE = 50;           // hauteur sous le sol, en bas de l'écran
const BORD = 15;                // on ne peut pas sortir de l'écran (marge)
const DEFILEMENT = 30;          // vitesse de l'écran vers la droite (unités / s)
const TRONCON = 600;            // le monde est généré par tronçons de cette largeur

const VITESSE = 280;            // marche
const VITESSE_ACCROUPI = 120;   // plus lent quand on est accroupi
const IMPULSION_SAUT = 900;     // saut (hauteur max ≈ 900² / (2 × 1700) ≈ 238 ;
                                // les plateformes sont espacées de 90 en hauteur)
const GRAVITE = 1700;
const HAUTEUR_DEBOUT = 80;      // taille du joueur pour les collisions
const HAUTEUR_ACCROUPI = 28;

const VIES_MAX = 3;
const INVINCIBLE_MS = 2000;     // après avoir été touché
const CADENCE_TIR_MS = 2000;    // un tir toutes les 2 s
const VITESSE_BALLE = 650;
const DUREE_BALLE_MS = 1500;
const RAYON_DRONE = 18;
const DUREE_CLASSEMENT_MS = 10000;     // classement affiché avant le retour en salle d'attente
const COMPTE_A_REBOURS_MS = 3000;      // tout le monde prêt -> la partie démarre 3 s après (Échap annule)

// Réseau : on envoie tout de suite chaque changement (départ, arrêt, saut...),
// plus une petite correction régulière pendant qu'on bouge.
const ENVOI_MS = 333;           // correction régulière : 3 / s quand on bouge
const BATTEMENT_MS = 2000;      // signe de vie quand on ne bouge pas
const EXPIRATION_MS = 6000;     // joueur retiré s'il ne donne plus de nouvelles
// Chaque message contient la position ET la vitesse : entre deux messages, on calcule
// où est le joueur. On garde juste une petite marge ("tampon") pour absorber
// l'irrégularité du réseau, mesurée en continu.
const TAMPON_MIN_MS = 15;
const TAMPON_MAX_MS = 150;
const PREDICTION_MAX_MS = 400;  // sans nouvelles, on arrête de prédire au-delà

const monId = (crypto.randomUUID && crypto.randomUUID()) ||
  Math.random().toString(36).slice(2) + Date.now().toString(36);

// ---------- Lobby ----------
document.title = TITRE;
document.getElementById("titre").textContent = TITRE;
document.getElementById("hud-titre").textContent = TITRE;
document.getElementById("mode").textContent = modeReseau() === "supabase"
  ? "Salle « " + SALLE + " »"
  : "Mode local : ouvre plusieurs onglets pour tester";

const champNom = document.getElementById("nom");
try { champNom.value = localStorage.getItem("stickman-nom") || ""; } catch (e) {}
champNom.focus();

// Couleur du joueur : au hasard mais jamais rouge (le rouge, c'est les drones),
// et gardée d'une partie à l'autre.
const COULEUR_VALIDE = /^hsl\(\d{1,3}, \d{1,3}%, \d{1,3}%\)$/;
let maCouleur = "";
try { maCouleur = localStorage.getItem("stickman-couleur") || ""; } catch (e) {}
if (!COULEUR_VALIDE.test(maCouleur)) {
  const teinte = 30 + Math.floor(Math.random() * 300); // 30 à 330 : on évite le rouge
  maCouleur = `hsl(${teinte}, 70%, 40%)`;
  try { localStorage.setItem("stickman-couleur", maCouleur); } catch (e) {}
}

// ---------- Têtes (photos) ----------
// En local, on lit le dossier tetes/. En ligne, les photos sont dans Supabase, dans
// un dossier au nom secret qui n'est écrit nulle part dans ce code : il vient du
// lien envoyé aux amis (&cle=...). Sans ce code, pas de photos (tête classique).
const EN_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const CLE_TETES = /^[a-z0-9]{12,64}$/.test(params.get("cle") || "") ? params.get("cle") : "";
const BASE_TETES = EN_LOCAL
  ? "tetes/"
  : CLE_TETES
    ? (window.CONFIG.SUPABASE_URL || "") + "/storage/v1/object/public/tetes/" + CLE_TETES + "/"
    : "";
const tetesDispo = new Map();   // fichier -> { nom, v }
const imagesTetes = new Map();  // fichier -> Image
let maTete = "";
try { maTete = localStorage.getItem("stickman-tete") || ""; } catch (e) {}

// Renvoie l'image d'une tête si elle est connue et chargée, sinon null
function imageTete(fichier) {
  const infos = fichier && tetesDispo.get(fichier);
  if (!infos) return null;
  let img = imagesTetes.get(fichier);
  if (!img) {
    img = new Image();
    img.src = BASE_TETES + encodeURIComponent(fichier) + "?v=" + encodeURIComponent(infos.v);
    imagesTetes.set(fichier, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

async function chargerTetes() {
  if (!BASE_TETES) return; // lien sans code : pas de photos
  try {
    const r = await fetch(BASE_TETES + "liste.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const { tetes } = await r.json();
    for (const t of tetes) {
      if (/^[a-z0-9_-]{1,60}\.png$/.test(t.fichier)) tetesDispo.set(t.fichier, { nom: String(t.nom), v: String(t.v) });
    }
  } catch (e) { return; }
  if (!tetesDispo.has(maTete)) maTete = "";
  afficherChoixTetes();
}

function afficherChoixTetes() {
  if (!tetesDispo.size) return;
  const grille = document.getElementById("grille-tetes");
  grille.textContent = "";
  const ajouter = (fichier, titre, contenu) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(fichier === maTete));
    b.title = titre;
    b.setAttribute("aria-label", titre);
    b.appendChild(contenu);
    b.addEventListener("click", () => {
      maTete = fichier;
      try { localStorage.setItem("stickman-tete", maTete); } catch (e) {}
      for (const autre of grille.children) autre.setAttribute("aria-checked", String(autre === b));
    });
    grille.appendChild(b);
  };
  const rond = document.createElement("span");
  rond.className = "classique";
  ajouter("", "Tête classique", rond);
  for (const [fichier, infos] of tetesDispo) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = BASE_TETES + encodeURIComponent(fichier) + "?v=" + encodeURIComponent(infos.v);
    ajouter(fichier, infos.nom, img);
  }
  document.getElementById("choix-tete").hidden = false;
}
chargerTetes();

document.getElementById("form-rejoindre").addEventListener("submit", (e) => {
  e.preventDefault();
  const nom = champNom.value.trim().slice(0, 16);
  if (!nom) return;
  try { localStorage.setItem("stickman-nom", nom); } catch (e) {}
  lancerJeu(nom, maTete);
});

// ---------- Monde partagé ----------
// Le monde (plateformes, drones, cœurs) est fabriqué à partir d'une "graine" :
// la même graine donne exactement le même monde sur tous les PC. Le réseau n'a
// donc à transmettre que la graine et le temps de jeu, plus quelques événements.
// Déroulement : salle d'attente ("attente") -> partie ("jeu") -> classement -> salle
// d'attente... Chaque étape est un nouveau monde avec un numéro plus grand : tout le
// monde rejoint automatiquement le monde au numéro le plus grand.
const monde = {
  phase: "attente",       // "attente" (salle d'attente) ou "jeu"
  origine: 0,             // pour une partie : la graine de la salle d'attente d'où elle part
  graine: 0,
  partie: 0,              // numéro du monde (augmente à chaque étape)
  decalage: 0,            // temps de jeu = performance.now() + decalage
  troncons: new Map(),
  detruits: new Set(),    // drones abattus
  coeursPris: new Set(),  // cœurs ramassés
  finDepuis: null,        // depuis quand tout le monde est éliminé
  tousPretsDepuis: null,  // salle d'attente : depuis quand tout le monde est prêt
};

function tMonde(maintenant = performance.now()) { return maintenant + monde.decalage; }
function cameraA(T) { return monde.phase === "attente" ? 0 : Math.max(0, T / 1000 * DEFILEMENT); }

// Salle d'attente : une pièce fixe, quelques plateformes pour s'entraîner, pas de drones
const PLATEFORMES_SALLE = [
  { x: 90, y: 110, w: 150 }, { x: 330, y: 200, w: 130 }, { x: 560, y: 110, w: 150 },
  { x: 760, y: 200, w: 150 }, { x: 420, y: 330, w: 170 },
];

// Nombre pseudo-aléatoire reproductible
function hachage(...valeurs) {
  let h = 2166136261;
  for (const v of valeurs) { h ^= v | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; }
  return h >>> 0;
}
function aleatoire(graine) {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function troncon(i) {
  let t = monde.troncons.get(i);
  if (!t) { t = genererTroncon(i); monde.troncons.set(i, t); }
  return t;
}

function genererTroncon(i) {
  if (monde.phase === "attente") {
    return { plateformes: i === 0 ? PLATEFORMES_SALLE : [], drones: [], coeur: null };
  }
  const r = aleatoire(hachage(monde.graine, i, 7));
  const debut = i * TRONCON;

  // Plateformes : 2 à 4 par tronçon, à différentes hauteurs, sans se chevaucher
  const plateformes = [];
  const niveaux = [110, 200, 290, 380];
  const nb = 2 + Math.floor(r() * 3);
  for (let k = 0; k < nb; k++) {
    const w = 90 + r() * 100;
    const x = debut + 20 + r() * (TRONCON - w - 40);
    const y = niveaux[Math.floor(r() * niveaux.length)];
    const gene = plateformes.some(p => Math.abs(p.y - y) < 80 && x < p.x + p.w + 30 && x + w + 30 > p.x);
    if (!gene) plateformes.push({ x, y, w });
  }

  // Drones : à partir du 3e tronçon (on laisse le temps de démarrer)
  const drones = [];
  if (i >= 2) {
    const nd = r() < 0.5 ? 1 : 2;
    for (let k = 0; k < nd; k++) {
      drones.push({
        id: i + "-" + k,
        x: debut + 80 + r() * (TRONCON - 160),
        y: 160 + r() * 300,
        type: Math.floor(r() * 3),   // 0 : sur place, 1 : cercles, 2 : haut-bas
        amp: 40 + r() * 60,
        periode: 3 + r() * 4,
        phase: r() * Math.PI * 2,
      });
    }
  }

  // Un cœur de temps en temps, posé sur une plateforme
  let coeur = null;
  if (i >= 3 && r() < 0.35) {
    const p = plateformes.length ? plateformes[Math.floor(r() * plateformes.length)] : null;
    coeur = { id: "c" + i, x: p ? p.x + p.w / 2 : debut + TRONCON / 2, y: (p ? p.y : 0) + 28 };
  }
  return { plateformes, drones, coeur };
}

function posDrone(d, T) {
  const s = T / 1000, w = 2 * Math.PI / d.periode;
  if (d.type === 0) return { x: d.x, y: d.y + Math.sin(s * 2 + d.phase) * 8 };
  if (d.type === 1) return { x: d.x + Math.cos(s * w + d.phase) * d.amp, y: d.y + Math.sin(s * w + d.phase) * d.amp * 0.8 };
  return { x: d.x, y: d.y + Math.sin(s * w + d.phase) * d.amp };
}

// Tronçons qui touchent la zone [x0, x1]
function* tronconsEntre(x0, x1) {
  for (let i = Math.max(0, Math.floor(x0 / TRONCON)); i <= Math.floor(x1 / TRONCON); i++) yield troncon(i);
}

function trouverDrone(id) {
  const i = parseInt(id, 10);
  if (!(i >= 0)) return null;
  return troncon(i).drones.find(d => d.id === id) || null;
}

// ---------- Position des autres joueurs ----------
// Où sera un joueur au temps t, d'après un message s (sa position + sa vitesse) ?
function predire(s, t) {
  const dt = Math.max(0, Math.min(t - s.h, PREDICTION_MAX_MS)) / 1000;
  return {
    x: s.x + s.vx * dt,
    y: s.sol ? s.y : Math.max(0, s.y + s.vy * dt - GRAVITE / 2 * dt * dt),
  };
}

// Place le joueur j là où il était il y a "tampon" millisecondes : on suit la
// trajectoire calculée depuis le dernier message (a). Si le message suivant (b) est
// déjà arrivé, on corrige en douceur le petit écart entre le calcul et la réalité.
function interpoler(j, maintenant) {
  const histo = j.historique;
  if (!histo.length) return;
  // Décalage entre notre horloge et le moment affiché chez lui (écart d'horloge + tampon),
  // qui glisse doucement quand l'estimation change (au plus 10 % du temps réel).
  const cible = j.ecart + j.tampon;
  if (j.decalage === undefined) j.decalage = cible;
  else {
    const pas = Math.max(0, maintenant - j.tCalcul) * 0.1;
    j.decalage += Math.max(-pas, Math.min(pas, cible - j.decalage));
  }
  j.tCalcul = maintenant;
  const tAffiche = maintenant - j.decalage; // en heure de son horloge

  let i = histo.length - 1;
  while (i > 0 && histo[i].h > tAffiche) i--;
  const a = histo[i], b = histo[i + 1];

  const p = predire(a, tAffiche);
  if (b && tAffiche >= a.h) {
    const k = (tAffiche - a.h) / (b.h - a.h);
    const pb = predire(a, b.h);
    p.x += (b.x - pb.x) * k;
    p.y = Math.max(0, p.y + (b.y - pb.y) * k);
  }
  j.x = p.x; j.y = p.y;
  j.dir = a.dir; j.marche = a.marche; j.baisse = a.baisse;
}

// ---------- Son ----------
let audio = null;
function sonTir(volume) {
  if (!audio) return;
  const t = audio.currentTime;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = "square";
  o.frequency.setValueAtTime(900, t);
  o.frequency.exponentialRampToValueAtTime(160, t + 0.12);
  g.gain.setValueAtTime(0.07 * volume, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + 0.15);
}

// ---------- Jeu ----------
function lancerJeu(nom, tete) {
  document.getElementById("lobby").hidden = true;
  document.getElementById("jeu").hidden = false;
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const hudJoueurs = document.getElementById("hud-joueurs");
  const hudScores = document.getElementById("scores");

  // Seul pour l'instant : on crée un monde. S'il y a déjà une partie dans la
  // salle, on la rejoindra dès qu'on reçoit des nouvelles des autres.
  monde.phase = "attente";
  monde.graine = (Math.random() * 2 ** 31) | 0;
  monde.partie = 0;
  monde.decalage = -performance.now();

  const moi = {
    id: monId, nom, tete, couleur: maCouleur,
    x: 0, y: 0, vx: 0, vy: 0, dir: 1,
    marche: false, baisse: false, sol: true, phase: 0,
    h: performance.now(),
    vies: VIES_MAX, score: 0, elimine: false,
    invincibleJusqua: 0, prochainTir: 0,
    pret: false,          // salle d'attente : prêt à lancer la partie
    spectateur: false,    // arrivé pendant une partie : on regarde seulement
  };
  let classement = null;  // figé quand tout le monde est éliminé
  const autres = new Map();
  let balles = [];      // { proprio, local, x, y, dir, h, couleur, recu }
  let eclats = [];      // petites étincelles quand un drone explose

  function reinitialiserMoi(spectateur) {
    const cam = cameraA(tMonde());
    moi.x = monde.phase === "attente" ? 100 + Math.random() * 800 : cam + 100 + Math.random() * 200;
    moi.y = 0; moi.vy = 0; moi.vx = 0; moi.sol = true; moi.baisse = false;
    moi.vies = VIES_MAX; moi.score = 0;
    moi.spectateur = spectateur;
    moi.elimine = spectateur;   // un spectateur regarde, comme un joueur éliminé
    moi.pret = false;
    moi.invincibleJusqua = monde.phase === "jeu" ? performance.now() + INVINCIBLE_MS : 0;
    moi.prochainTir = 0;
  }
  reinitialiserMoi(false);

  function changerDeMonde(graine, partie, T, phase, origine) {
    // Je participe à une partie seulement si je viens de sa salle d'attente
    const participant = phase !== "jeu" || (monde.phase === "attente" && origine === monde.graine);
    monde.phase = phase;
    monde.origine = origine;
    monde.graine = graine;
    monde.partie = partie;
    monde.decalage = T - performance.now();
    monde.troncons.clear();
    monde.detruits.clear();
    monde.coeursPris.clear();
    monde.finDepuis = null;
    monde.tousPretsDepuis = null;
    classement = null;
    balles = []; eclats = [];
    reinitialiserMoi(!participant);
  }

  // Les joueurs du même monde que moi (moi compris)
  function memePartie() {
    return [...autres.values()].filter(j => j.graine === monde.graine);
  }
  // Le joueur de référence pour l'horloge de jeu : le plus petit identifiant
  function idReference() {
    let ref = moi.id;
    for (const j of memePartie()) if (j.id < ref) ref = j.id;
    return ref;
  }

  // --- Réseau ---
  const net = creerReseau(SALLE);
  const etat = () => {
    const maintenant = performance.now();
    // Heure de la dernière mise à jour de la position ; si l'animation est en pause
    // (onglet en arrière-plan), on ne bouge pas, donc l'heure actuelle convient.
    const h = maintenant - moi.h < 50 ? moi.h : maintenant;
    return {
      id: moi.id, nom: moi.nom, tete: moi.tete, c: moi.couleur,
      h: Math.round(h),
      x: Math.round(moi.x * 10) / 10, y: Math.round(moi.y * 10) / 10,
      vx: Math.round(moi.vx), vy: Math.round(moi.vy),
      dir: moi.dir, marche: moi.marche, baisse: moi.baisse, sol: moi.sol,
      vies: moi.vies, score: moi.score, elim: moi.elimine,
      inv: maintenant < moi.invincibleJusqua,
      pret: moi.pret, spect: moi.spectateur,
      s: monde.graine, n: monde.partie, T: Math.round(h + monde.decalage),
      ph: monde.phase, o: monde.origine,
    };
  };

  // Un autre joueur nous donne son monde et son temps de jeu
  function synchroniserMonde(m, recu) {
    if (typeof m.s !== "number" || typeof m.T !== "number") return;
    const tLui = m.T + (performance.now() - recu);   // son temps de jeu, maintenant
    const tMoi = tMonde();
    if (m.s !== monde.graine) {
      // Mondes différents : on rejoint la partie la plus récente (numéro plus grand),
      // sinon la plus ancienne (celle qui tourne déjà).
      const n = m.n | 0;
      const rejoindre = n > monde.partie ||
        (n === monde.partie && (tLui > tMoi + 500 || (Math.abs(tLui - tMoi) <= 500 && m.s < monde.graine)));
      if (rejoindre) {
        changerDeMonde(m.s, n, tLui, m.ph === "jeu" ? "jeu" : "attente", m.o | 0);
        envoyer();
        net.send({ t: "salut", ...etat() }); // pour connaître les drones déjà abattus
      }
      return;
    }
    // Même monde : on cale notre horloge de jeu sur celle du joueur de référence
    if (m.id === idReference()) {
      const ecart = tLui - tMoi;
      monde.decalage += Math.abs(ecart) > 1500 ? ecart : ecart * 0.05;
    }
  }

  net.onMessage((m) => {
    if (!m || m.id === moi.id) return;
    const recu = performance.now();

    if (m.t === "bye") { autres.delete(m.id); return; }

    if (m.t === "monde") {
      if (m.s !== monde.graine) return;
      for (const id of m.detruits || []) monde.detruits.add(String(id));
      for (const id of m.coeurs || []) monde.coeursPris.add(String(id));
      return;
    }

    if (m.t === "drone") {
      if (m.s !== monde.graine) return;
      const id = String(m.drone);
      if (!monde.detruits.has(id)) {
        monde.detruits.add(id);
        const d = trouverDrone(id);
        if (d) exploser(posDrone(d, tMonde()));
      }
      // la balle de ce joueur a touché : on l'enlève
      const k = balles.findIndex(b => b.proprio === m.id);
      if (k >= 0) balles.splice(k, 1);
      return;
    }

    if (m.t === "coeur") {
      if (m.s === monde.graine) monde.coeursPris.add(String(m.coeur));
      return;
    }

    if (m.t === "tir") {
      if (m.s !== monde.graine || typeof m.h !== "number") return;
      const j = autres.get(m.id);
      balles.push({ proprio: m.id, local: false, x: +m.x, y: +m.y, dir: m.dir < 0 ? -1 : 1, h: m.h, couleur: j ? j.couleur : "#1b1b1b", recu });
      sonTir(0.5);
      return;
    }

    // État d'un joueur ("etat" ou "salut")
    if (typeof m.h !== "number") return;
    let j = autres.get(m.id);
    if (!j) {
      j = { id: m.id, x: m.x, y: m.y || 0, dir: m.dir, phase: 0, historique: [] };
      autres.set(m.id, j);
    }
    j.nom = String(m.nom).slice(0, 16);
    j.tete = typeof m.tete === "string" && tetesDispo.has(m.tete) ? m.tete : "";
    j.couleur = COULEUR_VALIDE.test(m.c) ? m.c : "#1b1b1b";
    j.vies = Math.max(0, Math.min(VIES_MAX, m.vies | 0));
    j.score = Math.max(0, m.score | 0);
    j.elimine = !!m.elim;
    j.inv = !!m.inv;
    j.graine = m.s;
    j.pret = !!m.pret;
    j.spectateur = !!m.spect;
    j.vu = recu;

    // Écart d'horloge (on garde le plus petit vu) et irrégularité du réseau
    const ecart = recu - m.h;
    j.ecart = j.ecart === undefined ? ecart : Math.min(ecart, j.ecart + 0.5);
    const gigue = ecart - j.ecart;
    j.gigue = j.gigue === undefined ? 30 : Math.max(gigue, j.gigue * 0.97);
    j.tampon = Math.max(TAMPON_MIN_MS, Math.min(TAMPON_MAX_MS, j.gigue + 10));

    const dernier = j.historique[j.historique.length - 1];
    if (!dernier || m.h > dernier.h) {
      j.historique.push({
        h: m.h, x: m.x, y: m.y || 0, vx: m.vx || 0, vy: m.vy || 0, sol: !!m.sol,
        dir: m.dir, marche: m.marche, baisse: !!m.baisse,
      });
      while (j.historique.length > 2 && j.historique[1].h < m.h - 1000) j.historique.shift();
    }

    synchroniserMonde(m, recu);

    // Un nouveau venu dit bonjour : on lui répond avec notre état et ce qu'on sait du monde
    if (m.t === "salut") {
      net.send({ t: "etat", ...etat() });
      const premier = Math.floor(cameraA(tMonde()) / TRONCON) - 1;
      const recent = (id) => parseInt(String(id).replace(/^c/, ""), 10) >= premier;
      net.send({
        t: "monde", id: moi.id, s: monde.graine,
        detruits: [...monde.detruits].filter(recent),
        coeurs: [...monde.coeursPris].filter(recent),
      });
    }
  });

  net.ready
    .then(() => net.send({ t: "salut", ...etat() }))
    .catch((err) => { hudJoueurs.textContent = "⚠ " + err.message; });

  window.addEventListener("pagehide", () => net.send({ t: "bye", id: moi.id }));

  // --- Clavier ---
  const touches = new Set();
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === " ") {
      e.preventDefault();
      if (!e.repeat) tirer();
      return;
    }
    // Salle d'attente : Entrée = prêt, Échap = annuler
    if (monde.phase === "attente" && !moi.spectateur && (k === "enter" || k === "escape")) {
      e.preventDefault();
      moi.pret = k === "enter";
      return;
    }
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "q", "a", "d", "z", "w", "s"].includes(k)) {
      touches.add(k);
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => touches.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => { touches.clear(); moi.marche = false; moi.baisse = false; moi.vx = 0; });

  // --- Tir ---
  function tirer() {
    const maintenant = performance.now();
    if (moi.elimine || maintenant < moi.prochainTir) return;
    moi.prochainTir = maintenant + CADENCE_TIR_MS;
    const b = {
      proprio: moi.id, local: true, dir: moi.dir, h: maintenant, couleur: moi.couleur,
      x: moi.x + moi.dir * 32, y: moi.y + (moi.baisse ? 8 : 52),
    };
    balles.push(b);
    net.send({ t: "tir", id: moi.id, s: monde.graine, x: Math.round(b.x), y: Math.round(b.y), dir: b.dir, h: Math.round(maintenant) });
    sonTir(1);
  }

  function exploser(p) {
    for (let k = 0; k < 14; k++) {
      const a = Math.random() * Math.PI * 2, v = 80 + Math.random() * 160;
      eclats.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vie: 0.5 + Math.random() * 0.3 });
    }
  }

  // --- Taille du canvas (net sur les écrans haute densité) ---
  function redimensionner() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }
  window.addEventListener("resize", redimensionner);
  redimensionner();

  // --- Envoi ---
  let dernierEnvoi = 0;
  let dernierEtatEnvoye = "";
  let derniereIntention = "";

  function envoyer() {
    const e = etat();
    net.send({ t: "etat", ...e });
    dernierEnvoi = performance.now();
    dernierEtatEnvoye = e.x + "|" + e.y + "|" + e.dir + "|" + e.marche + "|" + e.baisse;
  }

  // Correction régulière sur un minuteur (continue même onglet en arrière-plan)
  setInterval(() => {
    const e = etat();
    const cle = e.x + "|" + e.y + "|" + e.dir + "|" + e.marche + "|" + e.baisse;
    if (cle !== dernierEtatEnvoye || performance.now() - dernierEnvoi > BATTEMENT_MS) envoyer();
  }, ENVOI_MS);

  // --- Collisions ---
  function plateformeSous(x, yAvant, yApres) {
    for (const t of tronconsEntre(x - 200, x + 200)) {
      for (const p of t.plateformes) {
        if (x >= p.x - 4 && x <= p.x + p.w + 4 && yAvant >= p.y - 0.5 && yApres <= p.y) return p;
      }
    }
    return null;
  }

  function toucheJoueur(cx, cy, r) {
    const haut = moi.baisse ? HAUTEUR_ACCROUPI : HAUTEUR_DEBOUT;
    const px = Math.max(moi.x - 12, Math.min(cx, moi.x + 12));
    const py = Math.max(moi.y, Math.min(cy, moi.y + haut));
    return (cx - px) ** 2 + (cy - py) ** 2 < r * r;
  }

  // --- Boucle ---
  let avant = performance.now();

  function boucle(maintenant) {
    const dt = Math.min(0.05, (maintenant - avant) / 1000);
    avant = maintenant;
    const T = tMonde(maintenant);
    const cam = cameraA(T);

    if (!moi.elimine) {
      // Commandes
      let sens = 0;
      if (touches.has("arrowleft") || touches.has("q") || touches.has("a")) sens -= 1;
      if (touches.has("arrowright") || touches.has("d")) sens += 1;
      const haut = touches.has("arrowup") || touches.has("z") || touches.has("w");
      const bas = touches.has("arrowdown") || touches.has("s");

      // S'accroupir (au sol ou sur une plateforme : on ne passe pas au travers)
      moi.baisse = bas && moi.sol;
      // Sauter : seulement si on a les pieds posés et qu'on est debout
      if (haut && moi.sol && !moi.baisse) { moi.vy = IMPULSION_SAUT; moi.sol = false; }

      // Gravité et atterrissage (sol ou plateforme, seulement en descendant :
      // en montant, on traverse les plateformes par le dessous)
      const yAvant = moi.y;
      moi.vy -= GRAVITE * dt;
      moi.y += moi.vy * dt;
      moi.sol = false;
      if (moi.vy <= 0) {
        if (moi.y <= 0) { moi.y = 0; moi.vy = 0; moi.sol = true; }
        else {
          const p = plateformeSous(moi.x, yAvant, moi.y);
          if (p) { moi.y = p.y; moi.vy = 0; moi.sol = true; }
        }
      }

      // Déplacement, sans sortir de l'écran (le bord gauche pousse les retardataires)
      moi.marche = sens !== 0;
      if (sens) moi.dir = sens;
      moi.vx = sens * (moi.baisse ? VITESSE_ACCROUPI : VITESSE);
      moi.x = Math.max(cam + BORD, Math.min(cam + VUE_L - BORD, moi.x + moi.vx * dt));
      moi.phase = moi.marche && moi.sol ? moi.phase + dt * (moi.baisse ? 6 : 10) : 0;

      // Touché par un drone ?
      if (maintenant >= moi.invincibleJusqua) {
        for (const t of tronconsEntre(moi.x - 300, moi.x + 300)) {
          const d = t.drones.find(d => !monde.detruits.has(d.id) && (() => {
            const p = posDrone(d, T);
            return toucheJoueur(p.x, p.y, RAYON_DRONE);
          })());
          if (d) {
            moi.vies -= 1;
            moi.invincibleJusqua = maintenant + INVINCIBLE_MS;
            if (moi.vies <= 0) { moi.vies = 0; moi.elimine = true; }
            break;
          }
        }
      }

      // Un cœur à ramasser ?
      if (moi.vies < VIES_MAX) {
        for (const t of tronconsEntre(moi.x - 100, moi.x + 100)) {
          const c = t.coeur;
          if (c && !monde.coeursPris.has(c.id) && toucheJoueur(c.x, c.y, 16)) {
            monde.coeursPris.add(c.id);
            moi.vies += 1;
            net.send({ t: "coeur", id: moi.id, s: monde.graine, coeur: c.id });
          }
        }
      }
    }
    moi.h = maintenant;

    // Départ, arrêt, saut, atterrissage, vie perdue... : on prévient tout de suite
    const intention = [moi.vx, moi.dir, moi.baisse, moi.sol, moi.vies, moi.elimine, moi.score, moi.pret].join("|");
    if (intention !== derniereIntention) {
      derniereIntention = intention;
      envoyer();
    }

    // Les autres joueurs
    for (const [id, j] of autres) {
      if (maintenant - j.vu > EXPIRATION_MS) { autres.delete(id); continue; }
      interpoler(j, maintenant);
      const bouge = j.marche && j.historique.length && j.historique[j.historique.length - 1].sol;
      j.phase = bouge ? j.phase + dt * (j.baisse ? 6 : 10) : 0;
    }

    // Les balles
    balles = balles.filter((b) => {
      let age;
      if (b.local) age = maintenant - b.h;
      else {
        const j = autres.get(b.proprio);
        age = j && j.decalage !== undefined ? (maintenant - j.decalage) - b.h : maintenant - b.recu;
      }
      if (age > DUREE_BALLE_MS) return false;
      b.age = age;
      b.px = b.x + b.dir * VITESSE_BALLE * Math.max(0, age) / 1000;
      if (b.local) {
        // Ce sont mes balles : c'est moi qui décide si elles touchent un drone
        for (const t of tronconsEntre(b.px - 100, b.px + 100)) {
          for (const d of t.drones) {
            if (monde.detruits.has(d.id)) continue;
            const p = posDrone(d, T);
            if ((p.x - b.px) ** 2 + (p.y - b.y) ** 2 < (RAYON_DRONE + 4) ** 2) {
              monde.detruits.add(d.id);
              moi.score += 1;
              exploser(p);
              net.send({ t: "drone", id: moi.id, s: monde.graine, drone: d.id });
              return false;
            }
          }
        }
      }
      return true;
    });

    // Les étincelles
    eclats = eclats.filter((e) => {
      e.vie -= dt; e.x += e.vx * dt; e.y += e.vy * dt; e.vy -= 300 * dt;
      return e.vie > 0;
    });

    // Passage à l'étape suivante. C'est le joueur de référence qui crée le nouveau
    // monde ; les autres le rejoignent automatiquement (son numéro est plus grand).
    const tous = [moi, ...memePartie()];
    const nouvelleGraine = () => (Math.random() * 2 ** 31) | 0;
    if (monde.phase === "attente") {
      // Salle d'attente : quand tout le monde est prêt, compte à rebours puis la
      // partie démarre (si quelqu'un annule avec Échap, le compte à rebours repart)
      if (tous.every(j => j.pret)) {
        if (monde.tousPretsDepuis === null) monde.tousPretsDepuis = maintenant;
        else if (maintenant - monde.tousPretsDepuis > COMPTE_A_REBOURS_MS && idReference() === moi.id) {
          changerDeMonde(nouvelleGraine(), monde.partie + 1, 0, "jeu", monde.graine);
          envoyer();
        }
      } else monde.tousPretsDepuis = null;
    } else {
      // Partie : quand tous les participants sont éliminés -> classement,
      // puis retour en salle d'attente
      const participants = tous.filter(j => !j.spectateur);
      if (participants.every(j => j.elimine)) {
        if (monde.finDepuis === null) monde.finDepuis = maintenant;
        classement = participants
          .map(j => ({ nom: j.nom, couleur: j.couleur, score: j.score, moi: j === moi }))
          .sort((a, b) => b.score - a.score);
        if (maintenant - monde.finDepuis > DUREE_CLASSEMENT_MS && idReference() === moi.id) {
          changerDeMonde(nouvelleGraine(), monde.partie + 1, 0, "attente", 0);
          envoyer();
        }
      } else { monde.finDepuis = null; classement = null; }
    }

    dessiner(maintenant, T, cam);
    requestAnimationFrame(boucle);
  }

  // --- Tableau des scores (en haut) ---
  function majScores() {
    const tous = [moi, ...memePartie()];
    const nbSpect = tous.filter(j => j.spectateur).length;
    hudJoueurs.textContent = (monde.phase === "attente" ? "Salle d'attente · " : "") +
      (tous.length - nbSpect) + " joueur" + (tous.length - nbSpect > 1 ? "s" : "") +
      (nbSpect ? " · " + nbSpect + " spectateur" + (nbSpect > 1 ? "s" : "") : "");
    hudScores.textContent = "";
    const pts = (n) => n + " pt" + (n > 1 ? "s" : "");
    for (const j of tous) {
      if (j.spectateur) continue;
      const el = document.createElement("span");
      const nomEl = document.createElement("b");
      nomEl.style.color = j.couleur;
      nomEl.textContent = j.nom + (j === moi ? " (toi)" : "");
      const info = document.createElement("span");
      if (monde.phase === "attente") {
        el.className = "score" + (j.pret ? " pret" : "");
        info.textContent = j.pret ? "✓ prêt" : "pas prêt";
        el.append(nomEl, info);
      } else {
        el.className = "score" + (j.elimine ? " elimine" : "");
        const vies = document.createElement("span");
        vies.className = "vies";
        vies.textContent = "♥".repeat(j.vies) + "♡".repeat(VIES_MAX - j.vies);
        info.textContent = j.elimine ? "éliminé · " + pts(j.score) : pts(j.score);
        el.append(nomEl, vies, info);
      }
      hudScores.appendChild(el);
    }
  }
  setInterval(majScores, 250);

  // --- Dessin ---
  function dessiner(maintenant, T, cam) {
    const W = canvas.width, H = canvas.height;
    const e = Math.min(W / VUE_L, H / VUE_H);
    const ox = (W - VUE_L * e) / 2, oy = (H - VUE_H * e) / 2;
    const sx = (x) => ox + (x - cam) * e;
    const sy = (y) => oy + (VUE_H - SOL_MARGE - y) * e;

    ctx.fillStyle = "#e6e1d6";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(ox, oy, VUE_L * e, VUE_H * e);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, VUE_L * e, VUE_H * e);
    ctx.clip();

    ctx.lineCap = "round";
    ctx.strokeStyle = "#1b1b1b";

    // Sol
    ctx.lineWidth = Math.max(3, 6 * e);
    ctx.beginPath();
    ctx.moveTo(ox, sy(0));
    ctx.lineTo(ox + VUE_L * e, sy(0));
    ctx.stroke();

    const visibles = [...tronconsEntre(cam - 100, cam + VUE_L + 100)];

    // Plateformes
    ctx.lineWidth = Math.max(3, 5 * e);
    ctx.beginPath();
    for (const t of visibles) for (const p of t.plateformes) {
      ctx.moveTo(sx(p.x), sy(p.y));
      ctx.lineTo(sx(p.x + p.w), sy(p.y));
    }
    ctx.stroke();

    // Cœurs
    for (const t of visibles) {
      const c = t.coeur;
      if (c && !monde.coeursPris.has(c.id)) {
        dessinerCoeur(sx(c.x), sy(c.y + Math.sin(maintenant / 300) * 4), 12 * e, "#e11d48");
      }
    }

    // Drones
    for (const t of visibles) for (const d of t.drones) {
      if (monde.detruits.has(d.id)) continue;
      const p = posDrone(d, T);
      dessinerDrone(sx(p.x), sy(p.y), e, maintenant);
    }

    // Balles
    for (const b of balles) {
      if (b.age < 0) continue;
      ctx.fillStyle = b.couleur;
      ctx.beginPath();
      ctx.arc(sx(b.px), sy(b.y), Math.max(2.5, 5 * e), 0, Math.PI * 2);
      ctx.fill();
    }

    // Joueurs : les autres d'abord, moi par-dessus
    for (const j of autres.values()) {
      if (j.graine === monde.graine && !j.elimine) dessinerStickman(j, false, e, sx, sy, maintenant);
    }
    if (!moi.elimine) dessinerStickman(moi, true, e, sx, sy, maintenant);

    // Étincelles
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = Math.max(1.5, 3 * e);
    ctx.beginPath();
    for (const p of eclats) {
      ctx.moveTo(sx(p.x), sy(p.y));
      ctx.lineTo(sx(p.x - p.vx * 0.04), sy(p.y - p.vy * 0.04));
    }
    ctx.stroke();

    ctx.restore();

    // Messages au centre
    const texte = (t, y, taille, poids = 700, couleur = "#1b1b1b") => {
      ctx.fillStyle = couleur;
      ctx.font = poids + " " + Math.round(Math.max(taille * 0.6, taille * e)) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t, W / 2, oy + y * e);
    };
    if (monde.phase === "attente") {
      const tous = [moi, ...memePartie()];
      const prets = tous.filter(j => j.pret).length;
      if (monde.tousPretsDepuis !== null) {
        const reste = Math.max(1, Math.ceil((COMPTE_A_REBOURS_MS - (maintenant - monde.tousPretsDepuis)) / 1000));
        texte("La partie commence dans " + reste + "…", 130, 40);
        texte("Échap pour annuler", 175, 18, 600, "#555");
      } else {
        texte("Salle d'attente", 120, 34);
        texte(moi.pret ? "Tu es prêt ! On attend les autres… (Échap pour annuler)"
                       : "Appuie sur Entrée quand tu es prêt · Échap pour annuler", 160, 20, 600);
        texte(prets + " / " + tous.length + " prêt" + (tous.length > 1 ? "s" : ""), 192, 18, 600, "#555");
      }
    } else if (classement) {
      dessinerClassement(maintenant, e, ox, oy);
    } else if (moi.spectateur) {
      texte("Partie en cours : tu regardes. Tu joueras à la prochaine !", 150, 22);
    } else if (moi.elimine) {
      texte("Éliminé ! Tu peux regarder la fin de la partie", 150, 24);
    }
  }

  function dessinerClassement(maintenant, e, ox, oy) {
    const l = 440 * e, lignes = classement.length;
    const h = (110 + lignes * 40) * e;
    const x = ox + (VUE_L * e - l) / 2, y = oy + 90 * e;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#1b1b1b";
    ctx.lineWidth = Math.max(2, 3 * e);
    ctx.beginPath();
    ctx.roundRect(x, y, l, h, 14 * e);
    ctx.fill();
    ctx.stroke();

    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = "#1b1b1b";
    ctx.font = "800 " + Math.round(Math.max(18, 30 * e)) + "px system-ui, sans-serif";
    ctx.fillText("Classement", x + l / 2, y + 36 * e);

    const medailles = ["🥇", "🥈", "🥉"];
    classement.forEach((c, i) => {
      const ly = y + (80 + i * 40) * e;
      ctx.font = (c.moi ? "800 " : "600 ") + Math.round(Math.max(13, 21 * e)) + "px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillStyle = "#1b1b1b";
      ctx.fillText((medailles[i] || (i + 1) + "."), x + 28 * e, ly);
      ctx.fillStyle = c.couleur;
      ctx.fillText(c.nom + (c.moi ? " (toi)" : ""), x + 72 * e, ly);
      ctx.textAlign = "right";
      ctx.fillStyle = "#1b1b1b";
      ctx.fillText(c.score + " pt" + (c.score > 1 ? "s" : ""), x + l - 28 * e, ly);
    });

    const reste = Math.max(1, Math.ceil((DUREE_CLASSEMENT_MS - (maintenant - monde.finDepuis)) / 1000));
    ctx.textAlign = "center";
    ctx.fillStyle = "#555";
    ctx.font = "600 " + Math.round(Math.max(12, 16 * e)) + "px system-ui, sans-serif";
    ctx.fillText("Retour en salle d'attente dans " + reste + " s", x + l / 2, y + h - 22 * e);
  }

  function dessinerCoeur(x, y, taille, couleur) {
    const t = taille;
    ctx.fillStyle = couleur;
    ctx.beginPath();
    ctx.moveTo(x, y + t * 0.35);
    ctx.bezierCurveTo(x - t * 1.1, y - t * 0.35, x - t * 0.5, y - t * 1.05, x, y - t * 0.45);
    ctx.bezierCurveTo(x + t * 0.5, y - t * 1.05, x + t * 1.1, y - t * 0.35, x, y + t * 0.35);
    ctx.fill();
  }

  function dessinerDrone(x, y, s, maintenant) {
    const helice = (4 + Math.abs(Math.sin(maintenant / 25)) * 9) * s;
    ctx.strokeStyle = "#dc2626";
    ctx.fillStyle = "#dc2626";
    ctx.lineWidth = Math.max(1.5, 3 * s);
    ctx.lineCap = "round";
    ctx.beginPath();
    // bras
    ctx.moveTo(x - 18 * s, y); ctx.lineTo(x + 18 * s, y);
    // mâts et hélices
    for (const c of [-1, 1]) {
      ctx.moveTo(x + c * 18 * s, y); ctx.lineTo(x + c * 18 * s, y - 6 * s);
      ctx.moveTo(x + c * 18 * s - helice, y - 6 * s); ctx.lineTo(x + c * 18 * s + helice, y - 6 * s);
    }
    // pattes
    ctx.moveTo(x - 5 * s, y); ctx.lineTo(x - 9 * s, y + 9 * s);
    ctx.moveTo(x + 5 * s, y); ctx.lineTo(x + 9 * s, y + 9 * s);
    ctx.stroke();
    // corps
    ctx.beginPath();
    ctx.arc(x, y, 6 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  function dessinerStickman(j, estMoi, e, sx, sy, maintenant) {
    const invincible = estMoi ? maintenant < moi.invincibleJusqua : j.inv;
    ctx.save();
    if (invincible && Math.floor(maintenant / 120) % 2) ctx.globalAlpha = 0.3;

    const s = e;
    const x = sx(j.x);
    const pied = sy(j.y);
    const enLair = j.y > 0.5 && !(j.historique ? j.historique[j.historique.length - 1]?.sol : j.sol);
    const d = j.dir < 0 ? -1 : 1;
    const teteR = 10 * s;
    const balance = j.phase ? Math.sin(j.phase) * 0.6 : (enLair ? 0.2 : 0.3);

    ctx.strokeStyle = j.couleur;
    ctx.lineWidth = Math.max(2, 3.5 * s);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();

    let teteX, teteY, main;
    if (j.baisse) {
      // Accroupi très bas : plié en deux, la tête presque au niveau des pieds
      const hanche = { x: x - d * 6 * s, y: pied - 16 * s };
      const epaule = { x: x + d * 8 * s, y: pied - 24 * s };
      teteX = x + d * 20 * s; teteY = pied - 14 * s;
      const pas = Math.sin(j.phase) * 4 * s;
      ctx.moveTo(hanche.x, hanche.y); ctx.lineTo(x + d * 4 * s, pied - 8 * s); ctx.lineTo(x + d * (2 * s) + pas, pied);
      ctx.moveTo(hanche.x, hanche.y); ctx.lineTo(x - d * 12 * s, pied - 7 * s); ctx.lineTo(x - d * 10 * s - pas, pied);
      ctx.moveTo(hanche.x, hanche.y); ctx.lineTo(epaule.x, epaule.y);
      main = { x: x + d * 24 * s, y: pied - 6 * s };
      ctx.moveTo(epaule.x, epaule.y); ctx.lineTo(main.x, main.y);
    } else {
      const hanche = pied - 34 * s;
      const epaule = pied - 62 * s;
      teteX = x; teteY = epaule - teteR - 2 * s;
      ctx.moveTo(x, epaule); ctx.lineTo(x, hanche);
      const jambe = 36 * s;
      ctx.moveTo(x, hanche);
      ctx.lineTo(x + Math.sin(balance) * jambe, hanche + Math.cos(balance) * jambe);
      ctx.moveTo(x, hanche);
      ctx.lineTo(x - Math.sin(balance) * jambe, hanche + Math.cos(balance) * jambe);
      // bras arrière qui balance, bras avant tendu avec le pistolet
      const brasY = epaule + 4 * s;
      ctx.moveTo(x, brasY);
      ctx.lineTo(x - d * Math.abs(Math.sin(balance)) * 22 * s, brasY + 22 * s);
      main = { x: x + d * 20 * s, y: pied - 52 * s };
      ctx.moveTo(x, brasY); ctx.lineTo(main.x, main.y);
    }
    ctx.stroke();

    // Pistolet
    ctx.lineWidth = Math.max(2.5, 5 * s);
    ctx.strokeStyle = "#1b1b1b";
    ctx.beginPath();
    ctx.moveTo(main.x, main.y);
    ctx.lineTo(main.x + d * 11 * s, main.y);
    ctx.moveTo(main.x + d * 1 * s, main.y);
    ctx.lineTo(main.x + d * 1 * s, main.y + 5 * s);
    ctx.stroke();

    // Tête : la photo choisie si elle est chargée, sinon un rond
    const photo = imageTete(j.tete);
    let hautTete = teteY - teteR;
    if (photo) {
      const taille = teteR * 3.4;
      ctx.save();
      ctx.translate(teteX, teteY - taille * 0.12);
      if (d < 0) ctx.scale(-1, 1);
      ctx.drawImage(photo, -taille / 2, -taille / 2, taille, taille);
      ctx.restore();
      hautTete = teteY - taille * 0.12 - taille / 2;
    } else {
      ctx.strokeStyle = j.couleur;
      ctx.lineWidth = Math.max(2, 3.5 * s);
      ctx.beginPath();
      ctx.arc(teteX, teteY, teteR, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Nom au-dessus (et pour moi, la recharge du pistolet)
    ctx.fillStyle = j.couleur;
    ctx.font = (estMoi ? "700 " : "600 ") + Math.max(12, Math.round(15 * s)) + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(j.nom + (monde.phase === "attente" && j.pret ? " ✓" : ""), teteX, hautTete - 8 * s);
    if (estMoi) {
      const reste = Math.max(0, moi.prochainTir - maintenant) / CADENCE_TIR_MS;
      if (reste > 0) {
        const l = 30 * s, yb = hautTete - 5 * s;
        ctx.fillStyle = "#0000001f";
        ctx.fillRect(teteX - l / 2, yb, l, 3 * s);
        ctx.fillStyle = j.couleur;
        ctx.fillRect(teteX - l / 2, yb, l * (1 - reste), 3 * s);
      }
    }
    ctx.restore();
  }

  requestAnimationFrame(boucle);
}
