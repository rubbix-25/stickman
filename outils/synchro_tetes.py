"""Envoie les têtes du dossier tetes/ dans Supabase Storage (bucket public "tetes").

- crée le bucket s'il n'existe pas encore ;
- envoie les têtes nouvelles ou modifiées, plus liste.json ;
- supprime de Supabase les têtes qui ne sont plus dans tetes/.

La clé secrète est lue dans .secrets/supabase-secret.txt (jamais envoyée sur GitHub).
Lancement : python outils/synchro_tetes.py
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TETES = os.path.join(RACINE, "tetes")
FICHIER_CLE = os.path.join(RACINE, ".secrets", "supabase-secret.txt")
BUCKET = "tetes"


def lire_config():
    with open(os.path.join(RACINE, "config.js"), encoding="utf-8") as f:
        texte = f.read()
    url = re.search(r'SUPABASE_URL:\s*"([^"]+)"', texte).group(1).rstrip("/")
    try:
        with open(FICHIER_CLE, encoding="utf-8") as f:
            lignes = [l.strip() for l in f if l.strip() and not l.strip().startswith("#")]
    except FileNotFoundError:
        lignes = []
    cle = lignes[0] if lignes else ""
    if not cle or "COLLE" in cle:
        sys.exit(f"Clé secrète manquante : colle-la dans {FICHIER_CLE}")
    return url, cle


def appel(methode, url, cle, corps=None, type_contenu="application/json", entetes=None):
    if isinstance(corps, (dict, list)):
        corps = json.dumps(corps).encode("utf-8")
    req = urllib.request.Request(url, data=corps, method=methode)
    req.add_header("apikey", cle)
    req.add_header("Authorization", "Bearer " + cle)
    if corps is not None:
        req.add_header("Content-Type", type_contenu)
    for k, v in (entetes or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            texte = r.read().decode("utf-8") or "null"
            return r.status, json.loads(texte) if texte.strip().startswith(("{", "[")) else texte
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def main():
    url, cle = lire_config()
    base = url + "/storage/v1"

    # 1) Le bucket (public en lecture : le jeu télécharge les têtes sans clé)
    code, rep = appel("GET", f"{base}/bucket/{BUCKET}", cle)
    if code != 200:
        code, rep = appel("POST", f"{base}/bucket", cle, {
            "id": BUCKET, "name": BUCKET, "public": True,
            "file_size_limit": 2_000_000, "allowed_mime_types": ["image/png", "application/json"],
        })
        if code not in (200, 201):
            sys.exit(f"Impossible de créer le bucket ({code}) : {rep}")
        print("Bucket « tetes » créé.")

    # 2) Ce qu'il y a déjà en ligne
    code, en_ligne = appel("POST", f"{base}/object/list/{BUCKET}", cle, {"prefix": "", "limit": 1000})
    if code != 200:
        sys.exit(f"Impossible de lister les têtes en ligne ({code}) : {en_ligne}")
    noms_en_ligne = {o["name"] for o in en_ligne if o.get("id")}

    # 3) Ce qu'il y a en local
    try:
        with open(os.path.join(TETES, "liste.json"), encoding="utf-8") as f:
            liste = json.load(f)
    except FileNotFoundError:
        sys.exit("Pas de tetes/liste.json : lance d'abord l'extraction (outils/extraire.html).")
    locales = {t["fichier"] for t in liste["tetes"]}

    # 4) Envoi des têtes (on remplace si elles existent : x-upsert)
    for t in liste["tetes"]:
        with open(os.path.join(TETES, t["fichier"]), "rb") as f:
            code, rep = appel("POST", f"{base}/object/{BUCKET}/{t['fichier']}", cle, f.read(), "image/png",
                              {"x-upsert": "true", "cache-control": "max-age=3600"})
        if code not in (200, 201):
            sys.exit(f"Échec de l'envoi de {t['fichier']} ({code}) : {rep}")
        print("Envoyée :", t["fichier"])

    # 5) La liste, avec un cache court pour que les changements arrivent vite
    with open(os.path.join(TETES, "liste.json"), "rb") as f:
        code, rep = appel("POST", f"{base}/object/{BUCKET}/liste.json", cle, f.read(), "application/json",
                          {"x-upsert": "true", "cache-control": "max-age=30"})
    if code not in (200, 201):
        sys.exit(f"Échec de l'envoi de liste.json ({code}) : {rep}")

    # 6) Suppression des têtes qui n'existent plus en local
    a_supprimer = sorted(n for n in noms_en_ligne if n != "liste.json" and n not in locales)
    if a_supprimer:
        code, rep = appel("DELETE", f"{base}/object/{BUCKET}", cle, {"prefixes": a_supprimer})
        if code != 200:
            sys.exit(f"Échec de la suppression ({code}) : {rep}")
        for n in a_supprimer:
            print("Supprimée :", n)

    print(f"Terminé : {len(locales)} tête(s) en ligne.")


if __name__ == "__main__":
    main()
