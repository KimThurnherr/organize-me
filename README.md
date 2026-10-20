# Flechte

Kleine Haushalts-PWA für zwei Personen: wiederkehrende Aufgaben mit fester Zuständigkeit, To-dos, Gäste-Rhythmus (jede Woche jemand zu Gast), gemeinsames Wochenziel mit Punkten und Serie sowie Web-Push morgens und abends.

Ohne externe Abhängigkeiten: Node 24 (`node:http`, `node:sqlite`, `node:crypto`). Web-Push (RFC 8291/8292) ist selbst implementiert, VAPID-Schlüssel und Session-Secret werden beim ersten Start erzeugt und im Datenvolume gespeichert.

## Konfiguration

| Variable | Beispiel | Zweck |
|---|---|---|
| `PUBLIC_URL` | `https://app.example.com` | Öffentliche Adresse (für Login-Redirect und Cookies) |
| `ALLOWED_USERS` | `alex:alex@example.com,sam:sam@example.com` | Schlüssel und Google-Adresse der erlaubten Personen. Die Standard-Aufgaben gehen an die erste Person, Entsorgung an die zweite. |
| `USER_NAMES` | `alex:Alex,sam:Sam` | Anzeigenamen |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | | OAuth-Client (Webanwendung), Redirect-URI `<PUBLIC_URL>/auth/callback` |
| `GITHUB_REPO` / `GITHUB_REF` | `owner/repo`, `main` | Woher der Container den Code beim Start holt |
| `BIND_ADDR` / `HOST_PORT` | `127.0.0.1`, `8080` | Wo der Port auf dem Host veröffentlicht wird (hinter einem Reverse Proxy mit TLS betreiben) |
| `TZ` | `Europe/Zurich` | Zeitzone für Fälligkeiten und Push-Zeiten |

## Lokal starten

```sh
ALLOWED_USERS="alex:alex@example.com,sam:sam@example.com" DEV_LOGIN=1 PORT=8080 node server.js
# Anmelden ohne Google: http://localhost:8080/auth/dev?u=alex
```

`DEV_LOGIN` nie produktiv setzen.

## Deployment

`docker-compose.yml` startet `node:24-alpine`, lädt den Code als Tarball aus dem Repo und startet `server.js`. Nach einem Push genügt ein Neustart des Containers.

## iPhone

Push funktioniert nur, wenn die Seite in Safari über «Teilen» → «Zum Home-Bildschirm» installiert und von dort geöffnet wurde (iOS 16.4 oder neuer).
