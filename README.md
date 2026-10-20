# Flechte

Kleine Haushalts-PWA für zwei Personen: wiederkehrende Aufgaben mit fester Zuständigkeit, To-dos, Essensplan (sonntags für die nächste Woche planen), Gäste-Rhythmus (jede Woche jemand zu Gast), gemeinsames Wochenziel mit Punkten und Serie, Web-Push morgens und abends und eine MCP-Schnittstelle, über die sich alles aus einem KI-Assistenten heraus pflegen lässt.

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
| `MCP_TOKENS` | `shared:<token>` oder `alex:<token>,sam:<token>` | Bearer-Tokens für die MCP-Schnittstelle unter `/mcp` (mind. 32 Zeichen): ein gemeinsames Token, bei dem die Person pro Aufruf angegeben wird, oder eines pro Person. Ohne Eintrag ist die Schnittstelle gesperrt. |
| `GUEST_REMIND_DAYS` / `GUEST_REMIND_REPEAT` | `60`, `14` | Erinnerung im Abend-Push, wenn jemand so viele Tage nicht mehr zu Gast war, danach alle n Tage wiederholt |
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

## MCP-Schnittstelle

`POST <PUBLIC_URL>/mcp` (Streamable HTTP, JSON-Antworten, zustandslos) mit `Authorization: Bearer <token>`. Mit einem persönlichen Token handelt der Aufruf im Namen dieser Person, mit dem gemeinsamen Token gibt der Parameter `person` an, wer handelt (erledigte Aufgaben zählen ohne Angabe für die zuständige Person). Werkzeuge: Überblick, Haushaltsaufgaben (anlegen, ändern, löschen, erledigen), To-dos, Essensplan lesen und setzen, Gäste und Besuche, Push-Zeiten und Teamziel. Begrenzt auf 120 Anfragen pro Minute und Token.
