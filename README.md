# Household

Háztartás PWA: visszatérő háztartási feladatok, emlékeztetők, dokumentumok, költségek, jegyzetek és információk témánként, opcionális Google Drive-mentéssel.

## Futtatás

Statikus fájlok, nincs build-lépés. HTTPS-en vagy `localhost`-on kell futtatni (service worker és Google azonosítás miatt):

```bash
python3 -m http.server 8000
```

Majd nyisd meg: `http://localhost:8000`

## Google Drive-mentés (opcionális)

1. Google Cloud Console → engedélyezd a Google Drive API-t.
2. OAuth consent screen (External), a saját fiókod legyen Test user.
3. OAuth client ID (Web application), az Authorized JavaScript origins-be az app origin-jét add meg.
4. Az appban: ⋯ → Google kliensazonosító beállítása → Csatlakozás.

## Fájlok

- `index.html`, `styles.css`: felület
- `app.js`: adatkezelés, nézetek, űrlapok, értesítések
- `drive.js`: Google Drive mentés/visszaállítás (`drive.appdata` hatókör)
- `sw.js`, `manifest.webmanifest`: offline működés és telepítés