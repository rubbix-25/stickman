"""Envoie les têtes du dossier tetes/ dans Supabase Storage (bucket public "tetes").

Les têtes sont rangées dans un dossier au nom secret : tetes/<code>/...
Ce code n'est écrit nulle part dans le jeu (le dépôt GitHub est public) : il n'est
que dans le lien envoyé aux amis (&cle=<code>). Sans le lien, impossible de
trouver les photos.

- crée le bucket s'il n'existe pas encore ;
- crée le code secret au premier lancement (.secrets/cle-tetes.txt) ;
- envoie les têtes et liste.json dans tetes/<code>/ ;
- supprime tout le reste du bucket (têtes retirées, anciennes adresses).

La clé Supabase est lue dans .secrets/supabase-secret.txt (jamais envoyée sur GitHub).
Lancement : python outils/synchro_tetes.py
"""
import json
import os
import re
import secrets
import string
import sys
import urllib.error
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TETES = os.path.join(RACINE, "tetes")
FICHIER_CLE = os.path.join(RACINE, ".secrets", "supabase-secret.txt")
FICHIER_CODE = os.path.join(RACINE, ".secrets", "cle-tetes.txt")
BUCKET = "tetes"


def lire_lignes(chemin):
    try:
        with open(chemin, encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip() and not l.strip().startswith("#")]
    except FileNotFoundError:
        return []


def lire_config():
    with open(os.path.join(RACINE, "config.js"), encoding="utf-8") as f:
        texte = f.read()
    url = re.search(r'SUPABASE_URL:\s*"([^"]+)"', texte).group(1).rstrip("/")
    lignes = lire_lignes(FICHIER_CLE)
    cle = lignes[0] if lignes else ""
    if not cle or "COLLE" in cle:
        sys.exit(f"Clé secrète manquante : colle-la dans {FICHIER_CLE}")
    return url, cle


def code_secret():
    """Le code des liens (&cle=...), créé une fois puis réutilisé."""
    lignes = lire_lignes(FICHIER_CODE)
    if lignes and re.fullmatch(r"[a-z0-9]{12,64}", lignes[0]):
        return lignes[0]
    code = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(16))
    os.makedirs(os.path.dirname(FICHIER_CODE), exist_ok=True)
    with open(FICHIER_CODE, "w", encoding="utf-8") as f:
        f.write("# Code secret des têtes : à mettre dans les liens du jeu (&cle=...)\n")
        f.write("# Le changer (puis relancer la synchro) rend les anciens liens sans photos.\n")
        f.write(code + "\n")
    print("Nouveau code secret créé.")
    return code


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


def lister(base, cle, prefixe=""):
    """Tous les fichiers du bucket sous ce préfixe (en descendant dans les dossiers)."""
    code, entrees = appel("POST", f"{base}/object/list/{BUCKET}", cle, {"prefix": prefixe, "limit": 1000})
    if code != 200:
        sys.exit(f"Impossible de lister les têtes en ligne ({code}) : {entrees}")
    fichiers = []
    for e in entrees:
        chemin = (prefixe + "/" if prefixe else "") + e["name"]
        if e.get("id"):
            fichiers.append(chemin)
        else:  # c'est un dossier
            fichiers += lister(base, cle, chemin)
    return fichiers


def main():
    url, cle = lire_config()
    code_dossier = code_secret()
    base = url + "/storage/v1"

    # 1) Le bucket (public en lecture : le jeu télécharge les têtes sans clé,
    #    mais seulement s'il connaît le nom du dossier secret)
    code, rep = appel("GET", f"{base}/bucket/{BUCKET}", cle)
    if code != 200:
        code, rep = appel("POST", f"{base}/bucket", cle, {
            "id": BUCKET, "name": BUCKET, "public": True,
            "file_size_limit": 2_000_000, "allowed_mime_types": ["image/png", "application/json"],
        })
        if code not in (200, 201):
            sys.exit(f"Impossible de créer le bucket ({code}) : {rep}")
        print("Bucket « tetes » créé.")

    # 2) Les têtes locales
    try:
        with open(os.path.join(TETES, "liste.json"), encoding="utf-8") as f:
            liste = json.load(f)
    except FileNotFoundError:
        sys.exit("Pas de tetes/liste.json : lance d'abord l'extraction (outils/extraire.html).")
    a_garder = {f"{code_dossier}/{t['fichier']}" for t in liste["tetes"]} | {f"{code_dossier}/liste.json"}

    # 3) Envoi des têtes dans le dossier secret (on remplace si elles existent)
    for t in liste["tetes"]:
        with open(os.path.join(TETES, t["fichier"]), "rb") as f:
            code, rep = appel("POST", f"{base}/object/{BUCKET}/{code_dossier}/{t['fichier']}", cle, f.read(),
                              "image/png", {"x-upsert": "true", "cache-control": "max-age=3600"})
        if code not in (200, 201):
            sys.exit(f"Échec de l'envoi de {t['fichier']} ({code}) : {rep}")
        print("Envoyée :", t["fichier"])

    # 4) La liste, avec un cache court pour que les changements arrivent vite
    with open(os.path.join(TETES, "liste.json"), "rb") as f:
        code, rep = appel("POST", f"{base}/object/{BUCKET}/{code_dossier}/liste.json", cle, f.read(),
                          "application/json", {"x-upsert": "true", "cache-control": "max-age=30"})
    if code not in (200, 201):
        sys.exit(f"Échec de l'envoi de liste.json ({code}) : {rep}")

    # 5) Tout le reste du bucket est supprimé (têtes retirées, anciennes adresses publiques)
    a_supprimer = sorted(set(lister(base, cle)) - a_garder)
    if a_supprimer:
        code, rep = appel("DELETE", f"{base}/object/{BUCKET}", cle, {"prefixes": a_supprimer})
        if code != 200:
            sys.exit(f"Échec de la suppression ({code}) : {rep}")
        for n in a_supprimer:
            print("Supprimée :", n)

    print(f"Terminé : {len(liste['tetes'])} tête(s) en ligne.")
    print(f"À ajouter à la fin des liens du jeu : &cle={code_dossier}")


if __name__ == "__main__":
    main()
