// ---------- Paramètres du lien ----------
// Exemple : index.html?salle=soiree42&titre=La%20Grande%20Bataille
const params = new URLSearchParams(location.search);
const SALLE = (params.get("salle") || "principale").slice(0, 40);
const TITRE = (params.get("titre") || "Stickman").slice(0, 60);

// ---------- Monde ----------
// Les positions sont en "unités monde" (0 à 1000) pour que tout le monde
// voie la même chose quelle que soit la taille de son écran.
const MONDE_LARGEUR = 1000;
const PLATEFORME_DEBUT = 100;
const PLATEFORME_FIN = 900;
const VITESSE = 280;            // unités par seconde
const VITESSE_ACCROUPI = 120;   // plus lent quand on est baissé
const IMPULSION_SAUT = 560;     // vitesse vers le haut au moment du saut
const GRAVITE = 1600;           // ce qui fait retomber
const ENVOI_MS = 66;            // ~15 envois / s quand on bouge
const BATTEMENT_MS = 2000;      // signe de vie quand on ne bouge pas
const EXPIRATION_MS = 6000;     // joueur retiré s'il ne donne plus de nouvelles
// On affiche les autres joueurs avec un petit retard volontaire : ça laisse le
// temps aux positions d'arriver, et on peut les relier de façon parfaitement régulière.
// Il doit couvrir l'intervalle entre deux envois (66 ms) + les irrégularités du réseau.
const RETARD_AFFICHAGE_MS = 150;
// Si une position arrive quand même en retard, on prolonge le mouvement au plus ce temps-là.
const PROLONGATION_MAX_MS = 60;

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

document.getElementById("form-rejoindre").addEventListener("submit", (e) => {
  e.preventDefault();
  const nom = champNom.value.trim().slice(0, 16);
  if (!nom) return;
  try { localStorage.setItem("stickman-nom", nom); } catch (e) {}
  lancerJeu(nom);
});

// ---------- Interpolation des autres joueurs ----------
// Place le joueur j là où il était il y a RETARD_AFFICHAGE_MS, en reliant
// en ligne droite les deux positions reçues qui encadrent ce moment.
function interpoler(j, maintenant) {
  const histo = j.historique;
  if (!histo.length) return;
  const tAffiche = maintenant - j.ecart - RETARD_AFFICHAGE_MS; // en heure de son horloge

  let a = histo[0], b = histo[0];
  const dernier = histo[histo.length - 1];
  if (tAffiche >= dernier.h) {
    // Pas encore de position plus récente : on prolonge un court instant
    // le dernier mouvement connu, plutôt que de figer le joueur.
    const avant = histo[histo.length - 2];
    const depasse = Math.min(tAffiche - dernier.h, PROLONGATION_MAX_MS);
    j.dir = dernier.dir; j.marche = dernier.marche; j.baisse = dernier.baisse;
    // Seulement s'il était en mouvement (en marche ou en l'air) et qu'il donne
    // encore des nouvelles : jamais à l'arrêt, jamais s'il a décroché.
    const enMouvement = dernier.marche || dernier.y > 0;
    const recent = maintenant - j.vu < 250;
    if (avant && enMouvement && recent && dernier.h > avant.h && dernier.h - avant.h < 200) {
      j.x = dernier.x + (dernier.x - avant.x) / (dernier.h - avant.h) * depasse;
      j.y = Math.max(0, dernier.y + (dernier.y - avant.y) / (dernier.h - avant.h) * depasse);
    } else {
      j.x = dernier.x; j.y = dernier.y;
    }
    return;
  } else {
    for (let i = histo.length - 1; i > 0; i--) {
      if (histo[i - 1].h <= tAffiche) { a = histo[i - 1]; b = histo[i]; break; }
    }
  }
  const k = b.h > a.h ? Math.max(0, Math.min(1, (tAffiche - a.h) / (b.h - a.h))) : 1;
  j.x = a.x + (b.x - a.x) * k;
  j.y = a.y + (b.y - a.y) * k;
  const ref = k < 0.5 ? a : b;
  j.dir = ref.dir; j.marche = ref.marche; j.baisse = ref.baisse;
}

// ---------- Jeu ----------
function lancerJeu(nom) {
  document.getElementById("lobby").hidden = true;
  document.getElementById("jeu").hidden = false;

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const hudJoueurs = document.getElementById("hud-joueurs");

  const moi = {
    id: monId,
    nom,
    x: PLATEFORME_DEBUT + 50 + Math.random() * (PLATEFORME_FIN - PLATEFORME_DEBUT - 100),
    y: 0,          // hauteur au-dessus de la plateforme (0 = au sol)
    vy: 0,         // vitesse verticale
    dir: 1,
    marche: false,
    baisse: false,
    phase: 0,
    h: performance.now(), // heure (de mon horloge) de la dernière mise à jour
  };
  // id -> { nom, x, y, dir, marche, baisse, phase, vu, ecart, historique: [{h, x, y, ...}] }
  const autres = new Map();

  // --- Réseau ---
  const net = creerReseau(SALLE);
  const etat = () => ({
    id: moi.id, nom: moi.nom, h: Math.round(moi.h),
    x: Math.round(moi.x * 10) / 10, y: Math.round(moi.y * 10) / 10,
    dir: moi.dir, marche: moi.marche, baisse: moi.baisse,
  });

  net.onMessage((m) => {
    if (!m || m.id === moi.id) return;
    if (m.t === "bye") { autres.delete(m.id); return; }
    const recu = performance.now();
    let j = autres.get(m.id);
    if (!j) {
      j = { x: m.x, y: m.y || 0, dir: m.dir, phase: 0, historique: [] };
      autres.set(m.id, j);
    }
    j.nom = String(m.nom).slice(0, 16);
    j.vu = recu;

    if (typeof m.h === "number") {
      // Chaque PC a sa propre horloge : on estime l'écart entre la sienne et la nôtre.
      // On garde l'écart le plus petit vu (= le message le plus rapide), qu'on laisse
      // remonter très doucement pour suivre si les horloges dérivent.
      const ecart = recu - m.h;
      j.ecart = j.ecart === undefined ? ecart : Math.min(ecart, j.ecart + 0.5);

      const dernier = j.historique[j.historique.length - 1];
      if (!dernier || m.h > dernier.h) {
        j.historique.push({ h: m.h, x: m.x, y: m.y || 0, dir: m.dir, marche: m.marche, baisse: !!m.baisse });
        // On garde environ 1 seconde d'historique
        while (j.historique.length > 2 && j.historique[1].h < m.h - 1000) j.historique.shift();
      }
    } else {
      // Ancienne version du jeu (sans heure) : on prend la position telle quelle
      j.historique = [{ h: 0, x: m.x, y: m.y || 0, dir: m.dir, marche: m.marche, baisse: !!m.baisse }];
      j.ecart = 0;
    }
    // Un nouveau venu dit bonjour : on lui répond tout de suite avec notre position.
    if (m.t === "salut") net.send({ t: "etat", ...etat() });
  });

  net.ready
    .then(() => net.send({ t: "salut", ...etat() }))
    .catch((err) => { hudJoueurs.textContent = "⚠ " + err.message; });

  window.addEventListener("pagehide", () => net.send({ t: "bye", id: moi.id }));

  // --- Clavier ---
  const touches = new Set();
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "q", "a", "d", "z", "w", "s", " "].includes(k)) {
      touches.add(k);
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => touches.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => { touches.clear(); moi.marche = false; moi.baisse = false; });

  // --- Taille du canvas (net sur les écrans haute densité) ---
  function redimensionner() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }
  window.addEventListener("resize", redimensionner);
  redimensionner();

  // --- Boucle ---
  let avant = performance.now();
  let dernierEnvoi = 0;
  let dernierEtatEnvoye = "";

  // Envoi sur un minuteur (et pas dans l'animation) : ça continue même
  // quand l'onglet est en arrière-plan, donc on ne disparaît pas chez les autres.
  // On envoie seulement si ça a changé, sinon un signe de vie de temps en temps.
  setInterval(() => {
    const maintenant = performance.now();
    const e = etat();
    const cle = e.x + "|" + e.y + "|" + e.dir + "|" + e.marche + "|" + e.baisse;
    if (cle !== dernierEtatEnvoye || maintenant - dernierEnvoi > BATTEMENT_MS) {
      net.send({ t: "etat", ...e });
      dernierEnvoi = maintenant;
      dernierEtatEnvoye = cle;
    }
  }, ENVOI_MS);

  function boucle(maintenant) {
    const dt = Math.min(0.05, (maintenant - avant) / 1000);
    avant = maintenant;

    // Mon déplacement
    let sens = 0;
    if (touches.has("arrowleft") || touches.has("q") || touches.has("a")) sens -= 1;
    if (touches.has("arrowright") || touches.has("d")) sens += 1;
    const auSol = moi.y <= 0;
    const haut = touches.has("arrowup") || touches.has("z") || touches.has("w") || touches.has(" ");
    const bas = touches.has("arrowdown") || touches.has("s");

    // Se baisser : seulement au sol
    moi.baisse = bas && auSol;
    // Sauter : seulement au sol et debout
    if (haut && auSol && !moi.baisse) moi.vy = IMPULSION_SAUT;

    // Gravité
    moi.vy -= GRAVITE * dt;
    moi.y = Math.max(0, moi.y + moi.vy * dt);
    if (moi.y === 0) moi.vy = 0;

    moi.marche = sens !== 0;
    if (sens) moi.dir = sens;
    const vitesse = moi.baisse ? VITESSE_ACCROUPI : VITESSE;
    moi.x = Math.max(PLATEFORME_DEBUT + 15, Math.min(PLATEFORME_FIN - 15, moi.x + sens * vitesse * dt));
    moi.phase = moi.marche && moi.y === 0 ? moi.phase + dt * (moi.baisse ? 6 : 10) : 0;
    moi.h = maintenant;

    // Les autres : on rejoue leur historique avec un léger retard,
    // en reliant les positions reçues en ligne droite (interpolation).
    for (const [id, j] of autres) {
      if (maintenant - j.vu > EXPIRATION_MS) { autres.delete(id); continue; }
      interpoler(j, maintenant);
      const bouge = j.marche && j.y < 1;
      j.phase = bouge ? j.phase + dt * (j.baisse ? 6 : 10) : 0;
    }

    dessiner();
    requestAnimationFrame(boucle);
  }

  // --- Dessin ---
  function dessiner() {
    const W = canvas.width, H = canvas.height;
    const echelle = W / MONDE_LARGEUR;
    const solY = H * 0.65;

    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(0, 0, W, H);

    // La plateforme
    ctx.strokeStyle = "#1b1b1b";
    ctx.lineWidth = Math.max(3, 6 * echelle);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(PLATEFORME_DEBUT * echelle, solY);
    ctx.lineTo(PLATEFORME_FIN * echelle, solY);
    ctx.stroke();

    // Les autres d'abord, moi par-dessus
    for (const j of autres.values()) dessinerStickman(j, "#1b1b1b", echelle, solY);
    dessinerStickman(moi, "#2563eb", echelle, solY);

    hudJoueurs.textContent = (autres.size + 1) + " joueur" + (autres.size ? "s" : "") + " connecté" + (autres.size ? "s" : "");
  }

  function dessinerStickman(j, couleur, echelle, solY) {
    const s = echelle;
    const x = j.x * s;
    const enLair = j.y > 1;
    const pied = solY - j.y * s;                 // niveau des pieds
    const hanche = pied - (j.baisse ? 20 : 34) * s;
    const epaule = pied - (j.baisse ? 44 : 62) * s;
    const teteR = 10 * s;
    // Angle des jambes / bras : ça balance quand il marche, écarté au repos
    const balance = j.phase ? Math.sin(j.phase) * 0.6 : (enLair ? 0.2 : 0.3);

    ctx.strokeStyle = couleur;
    ctx.lineWidth = Math.max(2, 3.5 * s);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    // Tête
    ctx.moveTo(x + teteR, epaule - teteR - 2 * s);
    ctx.arc(x, epaule - teteR - 2 * s, teteR, 0, Math.PI * 2);
    // Corps
    ctx.moveTo(x, epaule);
    ctx.lineTo(x, hanche);
    // Jambes
    if (j.baisse) {
      // Accroupi : genoux pliés vers l'extérieur
      const pas = Math.sin(j.phase) * 6 * s;
      for (const cote of [-1, 1]) {
        ctx.moveTo(x, hanche);
        ctx.lineTo(x + cote * 13 * s, pied - 10 * s);
        ctx.lineTo(x + cote * 8 * s + cote * pas, pied);
      }
    } else {
      const jambe = 36 * s;
      ctx.moveTo(x, hanche);
      ctx.lineTo(x + Math.sin(balance) * jambe, hanche + Math.cos(balance) * jambe);
      ctx.moveTo(x, hanche);
      ctx.lineTo(x - Math.sin(balance) * jambe, hanche + Math.cos(balance) * jambe);
    }
    // Bras
    const bras = 26 * s;
    const brasY = epaule + 4 * s;
    if (enLair) {
      // En plein saut : bras levés
      ctx.moveTo(x, brasY);
      ctx.lineTo(x - 18 * s, brasY - 18 * s);
      ctx.moveTo(x, brasY);
      ctx.lineTo(x + 18 * s, brasY - 18 * s);
    } else {
      ctx.moveTo(x, brasY);
      ctx.lineTo(x - Math.sin(balance) * bras, brasY + Math.cos(balance) * bras);
      ctx.moveTo(x, brasY);
      ctx.lineTo(x + Math.sin(balance) * bras, brasY + Math.cos(balance) * bras);
    }
    ctx.stroke();

    // Nom au-dessus
    ctx.fillStyle = couleur;
    ctx.font = "600 " + Math.max(12, Math.round(15 * s)) + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(j.nom, x, epaule - teteR * 2 - 8 * s);
  }

  requestAnimationFrame(boucle);
}
