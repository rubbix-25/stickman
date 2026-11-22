// Couche réseau : la même interface pour deux modes.
//  - "supabase" : les joueurs de partout se voient (via Supabase Realtime)
//  - "local"    : seulement les onglets du même navigateur (pour tester)
//
// net.send(message)      -> envoie un message à tous les autres joueurs de la salle
// net.onMessage(fn)      -> fn(message) est appelée à chaque message reçu
// net.ready              -> Promise résolue quand la connexion est prête

function modeReseau() {
  const c = window.CONFIG || {};
  if (c.SUPABASE_URL && c.SUPABASE_KEY && window.supabase) return "supabase";
  return "local";
}

function creerReseau(salle) {
  const ecouteurs = [];
  const recevoir = (msg) => ecouteurs.forEach((fn) => fn(msg));
  const net = {
    mode: modeReseau(),
    onMessage(fn) { ecouteurs.push(fn); },
  };

  if (net.mode === "supabase") {
    const client = window.supabase.createClient(
      window.CONFIG.SUPABASE_URL,
      window.CONFIG.SUPABASE_KEY,
      { realtime: { params: { eventsPerSecond: 20 } } }
    );
    const canal = client.channel("stickman:" + salle, {
      config: { broadcast: { self: false } },
    });
    canal.on("broadcast", { event: "m" }, ({ payload }) => recevoir(payload));

    net.ready = new Promise((resolve, reject) => {
      canal.subscribe((statut) => {
        if (statut === "SUBSCRIBED") resolve();
        else if (statut === "CHANNEL_ERROR" || statut === "TIMED_OUT") {
          reject(new Error("Connexion Supabase impossible (" + statut + ")"));
        }
      });
    });
    net.send = (msg) => canal.send({ type: "broadcast", event: "m", payload: msg });
  } else {
    const canal = new BroadcastChannel("stickman:" + salle);
    canal.onmessage = (e) => recevoir(e.data);
    net.ready = Promise.resolve();
    net.send = (msg) => canal.postMessage(msg);
  }

  return net;
}
