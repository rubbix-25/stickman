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
// Réseau : on envoie tout de suite chaque changement (départ, arrêt, saut...),
// plus une petite correction régulière pendant qu'on bouge.
const ENVOI_MS = 333;           // correction régulière : 3 / s quand on bouge
const BATTEMENT_MS = 2000;      // signe de vie quand on ne bouge pas
const EXPIRATION_MS = 6000;     // joueur retiré s'il ne donne plus de nouvelles
// Chaque message contient la position ET la vitesse : entre deux messages, on calcule
// où est le joueur (vitesse constante, gravité). On garde juste une petite marge
// ("tampon") pour absorber l'irrégularité du réseau, mesurée en continu.
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

document.getElementById("form-rejoindre").addEventListener("submit", (e) => {
  e.preventDefault();
  const nom = champNom.value.trim().slice(0, 16);
  if (!nom) return;
  try { localStorage.setItem("stickman-nom", nom); } catch (e) {}
  lancerJeu(nom);
});

// ---------- Position des autres joueurs ----------
// Où sera un joueur au temps t, d'après un message s (sa position + sa vitesse) ?
// Marche à vitesse constante, et gravité s'il est en l'air.
function predire(s, t) {
  const dt = Math.max(0, Math.min(t - s.h, PREDICTION_MAX_MS)) / 1000;
  return {
    x: Math.max(PLATEFORME_DEBUT + 15, Math.min(PLATEFORME_FIN - 15, s.x + s.vx * dt)),
    y: (s.y > 0 || s.vy > 0) ? Math.max(0, s.y + s.vy * dt - GRAVITE / 2 * dt * dt) : 0,
  };
}

// Place le joueur j là où il était il y a "tampon" millisecondes : on suit la
// trajectoire calculée depuis le dernier message (a). Si le message suivant (b) est
// déjà arrivé, on corrige en douceur le petit écart entre le calcul et la réalité.
function interpoler(j, maintenant) {
  const histo = j.historique;
  if (!histo.length) return;
  // Décalage entre notre horloge et le moment affiché chez lui (écart d'horloge + tampon).
  // Quand l'estimation change, on le fait glisser doucement (au plus 10 % plus vite ou
  // plus lent que le temps réel) : invisible à l'œil, alors qu'un saut ferait un bond.
  const cible = j.ecart + j.tampon;
  if (j.decalage === undefined) j.decalage = cible;
  else {
    const pas = Math.max(0, maintenant - j.tCalcul) * 0.1;
    j.decalage += Math.max(-pas, Math.min(pas, cible - j.decalage));
  }
  j.tCalcul = maintenant;
  const tAffiche = maintenant - j.decalage; // en heure de son horloge

  // a = dernier message à ce moment-là, b = le suivant (s'il est déjà arrivé)
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
    vx: 0,         // vitesse horizontale
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
    // Heure de la dernière mise à jour de la position ; si l'animation est en pause
    // (onglet en arrière-plan), on ne bouge pas, donc l'heure actuelle convient.
    id: moi.id, nom: moi.nom,
    h: Math.round(performance.now() - moi.h < 50 ? moi.h : performance.now()),
    x: Math.round(moi.x * 10) / 10, y: Math.round(moi.y * 10) / 10,
    vx: Math.round(moi.vx), vy: Math.round(moi.vy),
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

      // Gigue : de combien ce message arrive plus tard que le plus rapide.
      // On retient le pire cas récent, qui s'oublie doucement (~3 s).
      const gigue = ecart - j.ecart;
      j.gigue = j.gigue === undefined ? 30 : Math.max(gigue, j.gigue * 0.97);
      // Tampon = gigue + petite marge (appliqué en douceur dans interpoler)
      j.tampon = Math.max(TAMPON_MIN_MS, Math.min(TAMPON_MAX_MS, j.gigue + 10));

      const dernier = j.historique[j.historique.length - 1];
      if (!dernier || m.h > dernier.h) {
        j.historique.push({
          h: m.h, x: m.x, y: m.y || 0, vx: m.vx || 0, vy: m.vy || 0,
          dir: m.dir, marche: m.marche, baisse: !!m.baisse,
        });
        // On garde environ 1 seconde d'historique
        while (j.historique.length > 2 && j.historique[1].h < m.h - 1000) j.historique.shift();
      }
    } else {
      // Ancienne version du jeu (sans heure) : on prend la position telle quelle
      j.historique = [{ h: 0, x: m.x, y: m.y || 0, vx: 0, vy: 0, dir: m.dir, marche: m.marche, baisse: !!m.baisse }];
      j.ecart = 0;
      j.tampon = 0;
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
  window.addEventListener("blur", () => { touches.clear(); moi.marche = false; moi.baisse = false; moi.vx = 0; });

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
  let derniereIntention = "";

  function envoyer() {
    const e = etat();
    net.send({ t: "etat", ...e });
    dernierEnvoi = performance.now();
    dernierEtatEnvoye = e.x + "|" + e.y + "|" + e.dir + "|" + e.marche + "|" + e.baisse;
  }

  // Correction régulière sur un minuteur (et pas dans l'animation) : ça continue
  // même quand l'onglet est en arrière-plan, donc on ne disparaît pas chez les autres.
  // On envoie seulement si ça a changé, sinon un signe de vie de temps en temps.
  setInterval(() => {
    const e = etat();
    const cle = e.x + "|" + e.y + "|" + e.dir + "|" + e.marche + "|" + e.baisse;
    if (cle !== dernierEtatEnvoye || performance.now() - dernierEnvoi > BATTEMENT_MS) envoyer();
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
    moi.vx = sens * vitesse;
    moi.x = Math.max(PLATEFORME_DEBUT + 15, Math.min(PLATEFORME_FIN - 15, moi.x + moi.vx * dt));
    moi.phase = moi.marche && moi.y === 0 ? moi.phase + dt * (moi.baisse ? 6 : 10) : 0;
    moi.h = maintenant;

    // Départ, arrêt, demi-tour, saut, atterrissage, accroupi : on prévient tout de suite.
    const intention = moi.vx + "|" + moi.dir + "|" + moi.baisse + "|" + (moi.y > 0);
    if (intention !== derniereIntention) {
      derniereIntention = intention;
      envoyer();
    }

    // Les autres : on les place d'après leurs messages (voir interpoler)
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
