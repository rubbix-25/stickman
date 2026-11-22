"""Serveur local de développement (uniquement sur ce PC, 127.0.0.1).

- Sert les fichiers du jeu, comme `python -m http.server`.
- GET  /outils/photos          -> liste des photos du dossier pictures/
- POST /outils/tetes/vider     -> vide le dossier tetes/
- POST /outils/tetes/<nom>.png -> enregistre une tête découpée dans tetes/
- POST /outils/tetes/liste.json -> enregistre la liste des têtes

Lancement : python outils/serveur.py 8000
"""
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTOS = os.path.join(RACINE, "pictures")
TETES = os.path.join(RACINE, "tetes")
EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
NOM_VALIDE = re.compile(r"^[a-z0-9_-]{1,60}\.png$|^liste\.json$")


class Gestionnaire(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=RACINE, **kwargs)

    def end_headers(self):
        # Pas de cache en local : on voit toujours la dernière version
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def repondre_json(self, code, donnees):
        corps = json.dumps(donnees).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    def do_GET(self):
        if self.path.split("?")[0] == "/outils/photos":
            os.makedirs(PHOTOS, exist_ok=True)
            fichiers = sorted(f for f in os.listdir(PHOTOS) if f.lower().endswith(EXTENSIONS))
            return self.repondre_json(200, fichiers)
        return super().do_GET()

    def do_POST(self):
        chemin = self.path.split("?")[0]
        if chemin == "/outils/tetes/vider":
            os.makedirs(TETES, exist_ok=True)
            for f in os.listdir(TETES):
                os.remove(os.path.join(TETES, f))
            return self.repondre_json(200, {"ok": True})

        if chemin.startswith("/outils/tetes/"):
            nom = chemin[len("/outils/tetes/"):]
            if not NOM_VALIDE.match(nom):
                return self.repondre_json(400, {"erreur": "nom invalide"})
            taille = int(self.headers.get("Content-Length", 0))
            if taille > 2_000_000:
                return self.repondre_json(413, {"erreur": "trop gros"})
            os.makedirs(TETES, exist_ok=True)
            with open(os.path.join(TETES, nom), "wb") as f:
                f.write(self.rfile.read(taille))
            return self.repondre_json(200, {"ok": True, "fichier": nom})

        return self.repondre_json(404, {"erreur": "inconnu"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serveur local sur http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Gestionnaire).serve_forever()
